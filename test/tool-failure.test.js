import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import * as restricted from "../src/restricted-application.js";

const readFailureObject = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const readFailureSchema = readFailureObject({ reply: { type: "string", minLength: 1, maxLength: 2000 } });
const readFailureInput = { input: [{ type: "text", text: "Find the current public references, please; don't guess or save anything." }] };
const readFailureCall = { type: "tool_calls", calls: [{ id: "read_1", name: "scoped_read", arguments: {} }] };
const readFailureTool = execute => ({ name: "scoped_read", description: "Read only host-authorized evidence.", readOnly: true,
  inputSchema: readFailureObject({}), outputSchema: readFailureSchema, execute });
const readFailureRunner = (execute, extra = {}) => restricted.createRestrictedApplicationRunner({
  provider: { supportsImages: false, complete: async () => readFailureCall }, tools: [readFailureTool(execute)],
  instructions: "Propose only; the host owns routing, evidence validation and writes.", outputSchema: readFailureSchema, ...extra,
});
function declareReadFailure(options) {
  assert.equal(typeof restricted.createRestrictedToolFailure, "function", "safe host-issued tool failure metadata is unavailable");
  return restricted.createRestrictedToolFailure(options);
}
function checkReadFailure(error, category, retryAfterMs = null) {
  assert.equal(error.code, "TOOL_FAILED");
  assert.deepEqual(JSON.parse(JSON.stringify(error.toolFailure)), { schemaVersion: "aginti-tool-failure-v1", category, retryAfterMs });
  assert.ok(Object.isFrozen(error.toolFailure)); assert.ok(Object.isFrozen(error));
  assert.equal(Object.hasOwn(error, "providerFailure"), false); assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error) + JSON.stringify(error) + error.stack, /TOOL_PRIVATE_DETAIL/);
  return true;
}

test("host-issued tool failure categories are closed, detached and bounded without hooks", async () => {
  for (const category of ["authentication", "permission", "quota", "not_found", "conflict", "rate_limit", "unavailable", "timeout", "protocol"]) {
    const options = { category }, declared = declareReadFailure(options); options.category = "changed";
    let calls = 0;
    await assert.rejects(readFailureRunner(() => { calls++; throw declared; }).run(readFailureInput), error => {
      assert.notEqual(error, declared); return checkReadFailure(error, category);
    });
    assert.equal(calls, 1);
  }
  for (const category of ["rate_limit", "unavailable"]) for (const retryAfterMs of [0, 500, 86_400_000])
    await assert.rejects(readFailureRunner(() => { throw declareReadFailure({ category, retryAfterMs }); }).run(readFailureInput), error => checkReadFailure(error, category, retryAfterMs));
  let hooks = 0;
  for (const options of [
    { category: "RATE_LIMIT" }, { category: " unavailable" }, { category: "unknown" }, {}, { category: "rate_limit", extra: true },
    { category: "permission", retryAfterMs: 1 }, ...[-1, 86_400_001, 1.5, "1", false, undefined, Infinity, NaN].map(retryAfterMs => ({ category: "rate_limit", retryAfterMs })),
    new Proxy({}, { get() { hooks++; }, ownKeys() { hooks++; return []; }, getPrototypeOf() { hooks++; return null; } }),
    { get category() { hooks++; return "rate_limit"; } }, Object.assign(Object.create({ category: "rate_limit" }), {}),
    Object.defineProperty({ category: "rate_limit" }, "hidden", { value: true }), { category: "rate_limit", [Symbol()]: true },
    { category: "rate_limit", then() { hooks++; } },
  ]) assert.throws(() => declareReadFailure(options));
  assert.equal(hooks, 0);
});

test("tool failure authority cannot cross provider, JSON, Proxy or package-copy boundaries", async () => {
  const declared = declareReadFailure({ category: "rate_limit" });
  const other = await import("../src/restricted-application.js?independent-tool-failure-brand");
  const metadata = { schemaVersion: "aginti-tool-failure-v1", category: "rate_limit", retryAfterMs: null };
  let hooks = 0;
  for (const thrown of [
    JSON.parse(JSON.stringify(declared)), other.createRestrictedToolFailure({ category: "rate_limit" }),
    { code: "TOOL_FAILED", toolFailure: metadata }, Object.assign(new Error("TOOL_PRIVATE_DETAIL"), { status: 429, toolFailure: metadata }),
    restricted.createRestrictedProviderFailure({ category: "rate_limit" }),
    { get toolFailure() { hooks++; }, get message() { hooks++; }, get code() { hooks++; }, get cause() { hooks++; } },
    new Proxy(declared, { get() { hooks++; }, ownKeys() { hooks++; return []; } }), null, undefined, "TOOL_PRIVATE_DETAIL",
  ]) await assert.rejects(readFailureRunner(() => { throw thrown; }).run(readFailureInput), error => {
    assert.equal(error.code, "TOOL_FAILED"); assert.equal(Object.hasOwn(error, "toolFailure"), false);
    assert.equal(Object.hasOwn(error, "providerFailure"), false); assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error) + JSON.stringify(error), /TOOL_PRIVATE_DETAIL/); return true;
  });
  await assert.rejects(readFailureRunner(() => ({ reply: "unused" }), {
    provider: { supportsImages: false, complete() { throw declared; } },
  }).run(readFailureInput), error => error.code === "PROVIDER_FAILED" && !Object.hasOwn(error, "toolFailure"));
  await assert.rejects(readFailureRunner(() => ({ reply: "unused" }), {
    provider: { supportsImages: false, complete: async () => ({ type: "final", value: { reply: "proposal" }, toolFailure: metadata }) },
  }).run(readFailureInput), { code: "INVALID_CONTRACT" });
  assert.equal(hooks, 0);
});

test("native tool-batch failure keeps earlier evidence uncommitted and stops every later read and provider turn", async () => {
  for (const make of [
    complete => restricted.createRestrictedOpenAIProvider({ model: "explicit", supportsImages: false, complete }),
    complete => restricted.createRestrictedDeepSeekProvider({ model: "deepseek-flash", complete }),
    complete => restricted.createRestrictedDeepSeekProvider({ model: "deepseek-v4-pro", complete }),
  ]) {
    let turns = 0, reads = 0; const stored = { revision: 7, text: "unchanged" };
    const provider = make(async () => { turns++; return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [1, 2, 3].map(index => ({ id: "read_" + index, type: "function", function: { name: "scoped_read", arguments: "{}" } })) } }] }; });
    const app = readFailureRunner(async () => {
      if (++reads % 2 === 0) throw declareReadFailure({ category: "unavailable", retryAfterMs: 500 });
      return { reply: stored.text };
    }, { provider, limits: { maxCallsPerStep: 3, maxConcurrency: 1 } });
    await assert.rejects(app.run(readFailureInput), error => checkReadFailure(error, "unavailable", 500));
    assert.equal(turns, 1); assert.equal(reads, 2); assert.deepEqual(stored, { revision: 7, text: "unchanged" });
    // A settled failure does not strand admission, retry a source, or persist a partial proposal.
    await assert.rejects(app.run(readFailureInput), error => checkReadFailure(error, "unavailable", 500));
    assert.equal(turns, 2); assert.equal(reads, 4); // A separate host invocation owns a fresh call-ID set.
  }
});

test("cancellation, timeout and synchronous overrun defeat tool categories while late work stays charged", { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 1000; t.mock.method(performance, "now", () => clock);
  const unhandled = []; const listener = error => unhandled.push(error);
  process.on("unhandledRejection", listener); t.after(() => process.off("unhandledRejection", listener));
  for (const mode of ["cancel", "timeout"]) {
    let enter, rejectWork, reads = 0;
    const entered = new Promise(resolve => { enter = resolve; }); const work = new Promise((_, reject) => { rejectWork = reject; });
    const abort = new AbortController();
    const app = readFailureRunner(() => { reads++; enter(); return work; }, { limits: { timeoutMs: 20, maxConcurrency: 1 } });
    const pending = app.run(readFailureInput, { signal: abort.signal }); pending.catch(() => {}); await entered;
    if (mode === "cancel") abort.abort(); else t.mock.timers.tick(20);
    await assert.rejects(pending, error => error.code === (mode === "cancel" ? "CANCELLED" : "TIMEOUT") && !Object.hasOwn(error, "toolFailure"));
    await assert.rejects(app.run(readFailureInput), { code: "BUSY" });
    rejectWork(declareReadFailure({ category: "rate_limit" })); await new Promise(setImmediate);
    assert.equal(reads, 1); assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  }
  for (const declared of [false, true]) await assert.rejects(readFailureRunner(() => {
    clock += 2; throw declared ? declareReadFailure({ category: "permission" }) : new Error("TOOL_PRIVATE_DETAIL");
  }, { limits: { timeoutMs: 1 } }).run(readFailureInput), error => error.code === "TIMEOUT" && !Object.hasOwn(error, "toolFailure"));
  assert.deepEqual(unhandled, []);
});

test("a host may classify exact loopback read statuses without leaking bodies, retrying or advancing the model", { timeout: 10000 }, async t => {
  const categories = new Map([[401, "authentication"], [403, "permission"], [404, "not_found"], [409, "conflict"], [429, "rate_limit"], [503, "unavailable"], [504, "timeout"]]);
  let status = 429, requests = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/scoped-evidence"); assert.equal(request.method, "GET"); requests++;
    response.writeHead(status, { "Content-Type": "application/json", "Retry-After": "1" });
    response.end('{"detail":"TOOL_PRIVATE_DETAIL"}');
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const endpoint = "http://127.0.0.1:" + server.address().port + "/scoped-evidence";
  for (const [httpStatus, category] of categories) {
    status = httpStatus; let turns = 0; const before = requests;
    const app = readFailureRunner(async (_, { signal }) => {
      const response = await fetch(endpoint, { signal, redirect: "error" }); await response.arrayBuffer();
      const options = { category: categories.get(response.status) };
      if (["rate_limit", "unavailable"].includes(options.category)) options.retryAfterMs = Number(response.headers.get("retry-after")) * 1000;
      throw declareReadFailure(options);
    }, { provider: { supportsImages: false, complete: async () => { turns++; return readFailureCall; } } });
    await assert.rejects(app.run(readFailureInput), error => checkReadFailure(error, category, ["rate_limit", "unavailable"].includes(category) ? 1000 : null));
    assert.equal(requests, before + 1); assert.equal(turns, 1);
  }
});
