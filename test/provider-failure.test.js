import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import * as restricted from "../src/restricted-application.js";

// Shared provider-failure contract regressions (also exercised by Lite).
const failureSchema = { type: "object", properties: { reply: { type: "string", minLength: 1, maxLength: 500 } }, required: ["reply"], additionalProperties: false };
const failureInput = { input: [{ type: "text", text: "Check my current draft first, please; don't save anything." }] };
const failureRunner = (complete, extra = {}) => restricted.createRestrictedApplicationRunner({
  provider: { supportsImages: false, complete }, tools: [], instructions: "Propose only; the host owns state and routing.", outputSchema: failureSchema, ...extra,
});
function declaredFailure(options) {
  assert.equal(typeof restricted.createRestrictedProviderFailure, "function", "a closed host-declared provider failure channel is missing");
  return restricted.createRestrictedProviderFailure(options);
}
function checkDeclaredFailure(error, category, delay = null) {
  assert.equal(error.code, "PROVIDER_FAILED");
  assert.deepEqual(JSON.parse(JSON.stringify(error.providerFailure)), { schemaVersion: "aginti-provider-failure-v1", category, retryAfterMs: delay });
  assert.ok(Object.isFrozen(error.providerFailure));
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error) + JSON.stringify(error) + error.stack, /PRIVATE_TRANSPORT_DETAIL/);
  return true;
}

test("host-declared provider failures preserve only a closed detached category and bounded cooldown", async () => {
  for (const category of ["authentication", "permission", "quota", "rate_limit", "unavailable", "timeout", "protocol"]) {
    const options = { category }, declared = declaredFailure(options);
    options.category = "changed";
    let calls = 0;
    await assert.rejects(failureRunner(() => { calls++; throw declared; }).run(failureInput), error => {
      assert.notEqual(error, declared, "do not return the callback's stack or object");
      return checkDeclaredFailure(error, category);
    });
    assert.equal(calls, 1);
  }
  for (const category of ["rate_limit", "unavailable"]) for (const retryAfterMs of [0, 1200, 86_400_000]) {
    await assert.rejects(failureRunner(() => { throw declaredFailure({ category, retryAfterMs }); }).run(failureInput), error => checkDeclaredFailure(error, category, retryAfterMs));
  }
  let traps = 0;
  for (const options of [
    { category: "QUOTA" }, { category: " quota" }, { category: "quota", extra: true },
    { category: "quota", retryAfterMs: 1 }, ...[-1, 86_400_001, 1.5, "1", undefined, Infinity, NaN].map(retryAfterMs => ({ category: "rate_limit", retryAfterMs })),
    new Proxy({}, { get() { traps++; }, ownKeys() { traps++; return []; } }),
    { get category() { traps++; return "quota"; } },
    Object.assign(Object.create({ inherited: true }), { category: "quota" }),
    Object.defineProperty({ category: "quota" }, "extra", { value: true }),
    { category: "quota", [Symbol("extra")]: true },
    { category: "quota", then() { traps++; } },
  ]) assert.throws(() => declaredFailure(options));
  assert.equal(traps, 0);
});

test("forged or serialized failure metadata stays opaque and a tool cannot masquerade as a provider", async () => {
  let traps = 0;
  const metadata = { schemaVersion: "aginti-provider-failure-v1", category: "quota", retryAfterMs: null };
  const declared = declaredFailure({ category: "quota" });
  const independent = await import("../src/restricted-application.js?independent-provider-failure-brand");
  const forged = [
    { code: "PROVIDER_FAILED", providerFailure: metadata }, JSON.parse(JSON.stringify(declared)),
    independent.createRestrictedProviderFailure({ category: "quota" }),
    Object.assign(new restricted.RestrictedApplicationError("PROVIDER_FAILED"), { providerFailure: metadata }),
    Object.assign(new Error("PRIVATE_TRANSPORT_DETAIL"), { status: 402, code: "quota", providerFailure: metadata }),
    { get providerFailure() { traps++; return metadata; }, get message() { traps++; return "PRIVATE_TRANSPORT_DETAIL"; }, get status() { traps++; }, get stack() { traps++; }, get cause() { traps++; } },
    new Proxy(declared, { get() { traps++; }, ownKeys() { traps++; return []; } }),
    null, undefined, false, "PRIVATE_TRANSPORT_DETAIL",
  ];
  for (const value of forged) await assert.rejects(failureRunner(() => { throw value; }).run(failureInput), error => {
    assert.equal(error.code, "PROVIDER_FAILED"); assert.equal(Object.hasOwn(error, "providerFailure"), false);
    assert.equal(error.cause, undefined); assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE_TRANSPORT_DETAIL/); return true;
  });
  assert.equal(traps, 0);
  let reads = 0, turns = 0;
  const app = failureRunner(async () => { turns++; return { type: "tool_calls", calls: [{ id: "c1", name: "record_read", arguments: {} }] }; }, {
    tools: [{ name: "record_read", description: "Read only this account.", readOnly: true,
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, outputSchema: failureSchema,
      execute() { reads++; throw declared; } }],
  });
  await assert.rejects(app.run(failureInput), error => error.code === "TOOL_FAILED" && !Object.hasOwn(error, "providerFailure"));
  assert.equal(reads, 1); assert.equal(turns, 1);
  await assert.rejects(failureRunner(async () => ({ type: "final", value: { reply: "proposal" }, providerFailure: metadata })).run(failureInput), { code: "INVALID_CONTRACT" });
});

test("native OpenAI and DeepSeek transports preserve explicit failure signals without a read or retry", async () => {
  for (const make of [
    complete => restricted.createRestrictedOpenAIProvider({ model: "explicit", supportsImages: false, complete }),
    complete => restricted.createRestrictedDeepSeekProvider({ model: "deepseek-flash", complete }),
    complete => restricted.createRestrictedDeepSeekProvider({ model: "deepseek-v4-pro", complete }),
  ]) {
    let attempts = 0, reads = 0;
    const provider = make(async () => { attempts++; throw declaredFailure({ category: "unavailable", retryAfterMs: 1500 }); });
    await assert.rejects(failureRunner(undefined, { provider, tools: [{ name: "record_read", description: "Read only this account.", readOnly: true,
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, outputSchema: failureSchema,
      execute() { reads++; return { reply: "scoped" }; } }] }).run(failureInput), error => checkDeclaredFailure(error, "unavailable", 1500));
    assert.equal(attempts, 1); assert.equal(reads, 0);
  }
});

test("cancellation and deadline beat declared provider failures and retain uncooperative capacity", { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 1000;
  t.mock.method(performance, "now", () => clock);
  const unhandled = [], onUnhandled = error => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled); t.after(() => process.off("unhandledRejection", onUnhandled));
  for (const stop of ["cancel", "timeout"]) {
    let rejectWork, enter;
    const work = new Promise((_, reject) => { rejectWork = reject; });
    const entered = new Promise(resolve => { enter = resolve; });
    const abort = new AbortController(); let attempts = 0;
    const app = failureRunner(() => { attempts++; enter(); return work; }, { limits: { timeoutMs: 20, maxConcurrency: 1 } });
    const running = app.run(failureInput, { signal: abort.signal }); running.catch(() => {}); await entered;
    if (stop === "cancel") abort.abort(); else t.mock.timers.tick(20);
    await assert.rejects(running, error => error.code === (stop === "cancel" ? "CANCELLED" : "TIMEOUT") && !Object.hasOwn(error, "providerFailure"));
    await assert.rejects(app.run(failureInput), { code: "BUSY" });
    rejectWork(declaredFailure({ category: "rate_limit", retryAfterMs: 1000 }));
    await new Promise(setImmediate);
    assert.equal(attempts, 1); assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  }
  // The clock can expire inside synchronous trusted code before the timer gets
  // an event-loop turn. Its later exception must not hide the overall deadline.
  let synchronousCalls = 0;
  for (const raw of [false, true]) {
    await assert.rejects(failureRunner(() => {
      synchronousCalls++; clock += 2;
      throw raw ? new Error("PRIVATE_TRANSPORT_DETAIL") : declaredFailure({ category: "quota" });
    }, { limits: { timeoutMs: 1 } }).run(failureInput), error => error.code === "TIMEOUT" && !Object.hasOwn(error, "providerFailure"));
  }
  assert.equal(synchronousCalls, 2);
  assert.equal(unhandled.length, 0);
});

test("actual loopback HTTP failures reach the host category with one dispatch and no inference", { timeout: 10000 }, async t => {
  const categories = new Map([[401, "authentication"], [402, "quota"], [403, "permission"], [429, "rate_limit"], [503, "unavailable"], [504, "timeout"], [422, "protocol"]]);
  let status = 401, requests = 0;
  const server = createServer(async (request, response) => {
    requests++; assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/chat/completions");
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.model, "deepseek-flash");
    response.writeHead(status, { "Content-Type": "application/json", "Retry-After": "1" });
    response.end(JSON.stringify({ error: { message: "PRIVATE_TRANSPORT_DETAIL" } }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const endpoint = "http://127.0.0.1:" + server.address().port + "/v1/chat/completions";
  for (const [httpStatus, category] of categories) {
    status = httpStatus;
    const provider = restricted.createRestrictedDeepSeekProvider({ model: "deepseek-flash", async complete(body, { signal }) {
      const response = await fetch(endpoint, { method: "POST", body: JSON.stringify(body), signal, redirect: "error", headers: { "Content-Type": "application/json" } });
      await response.arrayBuffer(); // Discard the private upstream body, never pass it to the runner.
      const retryAfterMs = ["rate_limit", "unavailable"].includes(category) ? Number(response.headers.get("retry-after")) * 1000 : null;
      throw declaredFailure({ category: categories.get(response.status), retryAfterMs });
    } });
    const before = requests;
    await assert.rejects(failureRunner(undefined, { provider }).run(failureInput), error => checkDeclaredFailure(error, category, ["rate_limit", "unavailable"].includes(category) ? 1000 : null));
    assert.equal(requests, before + 1);
  }
  assert.equal(requests, categories.size);
});
