import assert from "node:assert/strict";
import test from "node:test";
import { createRestrictedApplicationRunner, createRestrictedOpenAIProvider, createRestrictedDeepSeekProvider } from "../src/restricted-application.js";

const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: "string", minLength: 1, maxLength: 2000 };
const schema = object({ reply: string });
const input = { input: [{ type: "text", text: "Compare the two current records; say what is checked and what remains blocked. Leave them unchanged." }] };
const call = (id, key = "alpha") => ({ id, type: "function", function: { name: "record_read", arguments: JSON.stringify({ key }) } });
const native = calls => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls } }] });
const final = reply => ({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ reply }) } }] });
const adapter = (kind, complete) => kind === "deepseek"
  ? createRestrictedDeepSeekProvider({ model: "deepseek-flash", complete })
  : createRestrictedOpenAIProvider({ model: "offline-fixture", supportsImages: false, complete });
const tool = execute => ({ name: "record_read", description: "Read one current caller-bound record. No account selector or writes.", readOnly: true,
  inputSchema: object({ key: { type: "string", enum: ["alpha", "beta", "gamma"], maxLength: 8 } }), outputSchema: object({ key: string, value: string }), execute });
const runner = (provider, execute, limits = {}) => createRestrictedApplicationRunner({ provider, tools: [tool(execute)], outputSchema: schema,
  instructions: "Read the authorized records and return an uncommitted proposal. The host alone owns authorization and saves.",
  limits: { maxSteps: 5, maxToolCalls: 5, maxCallsPerStep: 2, ...limits } });

function fixture(kind, frames, limits = {}) {
  const bodies = [], reads = [];
  const provider = adapter(kind, async body => {
    bodies.push(body);
    return bodies.length <= frames.length ? native(frames[bodies.length - 1]) : final("Alpha checked; beta still blocked. Proposal only.");
  });
  const app = runner(provider, async (args, metadata) => {
    reads.push({ key: args.key, callId: metadata.callId }); return { key: args.key, value: args.key === "alpha" ? "checked" : "blocked" };
  }, limits);
  return { app, bodies, reads };
}
function ids(body) { return body.messages.filter(m => m.role === "tool").map(m => m.tool_call_id); }
function assertWireCorrelation(body) {
  const calls = body.messages.flatMap(m => m.tool_calls || []);
  const results = body.messages.filter(m => m.role === "tool");
  assert.deepEqual(calls.map(c => c.id), results.map(r => r.tool_call_id));
  assert.equal(new Set(calls.map(c => c.id)).size, calls.length);
}

for (const kind of ["openai", "deepseek"]) {
  test(`${kind}: a native ID reused by a later response gets a new invocation-local identity`, async () => {
    const f = fixture(kind, [[call("call_0", "alpha")], [call("call_0", "beta")]]);
    const r = await f.app.run(input);
    assert.equal(r.status, "completed"); assert.deepEqual({ ...r.usage }, { steps: 3, toolCalls: 2 });
    assert.deepEqual(f.reads, [{ key: "alpha", callId: "call_0" }, { key: "beta", callId: "aginti_native_1" }]);
    assert.deepEqual(ids(f.bodies[1]), ["call_0"]);
    assert.deepEqual(ids(f.bodies[2]), ["call_0", "aginti_native_1"]);
    f.bodies.forEach(assertWireCorrelation);
  });
  test(`${kind}: noncolliding native IDs and ordinary request history remain unchanged`, async () => {
    const f = fixture(kind, [[call("first", "alpha")], [call("second", "beta")]]);
    await f.app.run(input);
    assert.deepEqual(f.reads.map(r => r.callId), ["first", "second"]);
    assert.deepEqual(ids(f.bodies[2]), ["first", "second"]); f.bodies.forEach(assertWireCorrelation);
  });
  test(`${kind}: replacements cannot collide with another raw ID in the same batch`, async () => {
    const f = fixture(kind, [[call("call_0")], [call("call_0", "beta"), call("aginti_native_1", "gamma")]]);
    await f.app.run(input);
    assert.deepEqual(f.reads.map(r => r.callId), ["call_0", "aginti_native_2", "aginti_native_1"]);
    f.bodies.forEach(assertWireCorrelation);
  });
  test(`${kind}: repeated collisions and a provider-chosen replacement prefix remain distinct`, async () => {
    const f = fixture(kind, [[call("aginti_native_1")], [call("aginti_native_1", "beta")], [call("aginti_native_1", "gamma")]]);
    const r = await f.app.run(input);
    assert.equal(r.usage.toolCalls, 3);
    assert.deepEqual(f.reads.map(r => r.callId), ["aginti_native_1", "aginti_native_2", "aginti_native_3"]);
    f.bodies.forEach(assertWireCorrelation);
  });
  test(`${kind}: duplicate IDs inside the first batch still dispatch zero reads`, async () => {
    const f = fixture(kind, [[call("call_0"), call("call_0", "beta")]]);
    await assert.rejects(f.app.run(input), { code: "TOOL_CALL_INVALID" });
    assert.equal(f.bodies.length, 1); assert.deepEqual(f.reads, []);
  });
  test(`${kind}: a later invalid duplicate batch is never repaired into new work`, async () => {
    const f = fixture(kind, [[call("call_0")], [call("call_0", "beta"), call("call_0", "gamma")]]);
    await assert.rejects(f.app.run(input), { code: "TOOL_CALL_INVALID" });
    assert.equal(f.bodies.length, 2); assert.equal(f.reads.length, 1);
  });
  test(`${kind}: malformed native IDs cannot become fresh valid identities`, async () => {
    for (const bad of ["call_0\n", "call_0/foreign", "x".repeat(81), "", false, 0, null]) {
      const f = fixture(kind, [[call("call_0")], [call("call_0", "beta"), call(bad, "gamma")]]);
      await assert.rejects(f.app.run(input));
      assert.equal(f.bodies.length, 2); assert.equal(f.reads.length, 1);
    }
  });
  test(`${kind}: ID scoping does not bypass step or read budgets`, async () => {
    for (const limits of [{ maxSteps: 2 }, { maxToolCalls: 1 }]) {
      const f = fixture(kind, [[call("call_0")], [call("call_0", "beta")]], limits);
      await assert.rejects(f.app.run(input), { code: "STEP_LIMIT" });
      assert.equal(f.bodies.length, 2); assert.equal(f.reads.length, 1);
      assert.equal(Object.hasOwn(f.bodies[1], "tools"), false);
    }
  });
  test(`${kind}: a reused ID cannot hide an explicit upstream error`, async () => {
    let requests = 0, reads = 0, traps = 0;
    const provider = adapter(kind, async () => {
      const r = native([call("call_0")]);
      if (++requests === 2) Object.defineProperty(r, "error", { enumerable: true, get() { traps++; throw Error("PRIVATE_DIAGNOSTIC"); } });
      return r;
    });
    await assert.rejects(runner(provider, async args => { reads++; return { key: args.key, value: "scoped" }; }).run(input), { code: "PROVIDER_FAILED" });
    assert.equal(requests, 2); assert.equal(reads, 1); assert.equal(traps, 0);
  });
}

test("custom normalized providers retain the invocation-wide duplicate-ID guard", async () => {
  let requests = 0, reads = 0;
  const provider = { supportsImages: false, complete: async () => { requests++; return { type: "tool_calls", calls: [{ id: "custom", name: "record_read", arguments: { key: "alpha" } }] }; } };
  await assert.rejects(runner(provider, async args => { reads++; return { key: args.key, value: "scoped" }; }).run(input), { code: "TOOL_CALL_INVALID" });
  assert.equal(requests, 2); assert.equal(reads, 1);
});
test("one native adapter interleaves callers without a shared call-ID counter or source scope", async () => {
  const turns = new Map(), idsByOwner = { alpha: [], beta: [] };
  let release; const bothStarted = new Promise(resolve => { release = resolve; });
  const provider = adapter("deepseek", async (body, { signal }) => {
    const turn = (turns.get(signal) || 0) + 1; turns.set(signal, turn);
    if (turn === 1) { if (turns.size === 2) release(); await bothStarted; }
    if (turn < 3) return native([call("call_0", turn === 1 ? "alpha" : "beta")]);
    return final(body.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content).value).join("/"));
  });
  const apps = ["alpha", "beta"].map(owner => runner(provider, async (args, metadata) => {
    idsByOwner[owner].push(metadata.callId); await new Promise(resolve => setImmediate(resolve)); return { key: args.key, value: owner };
  }));
  const results = await Promise.all(apps.map(app => app.run(input)));
  assert.deepEqual(results.map(r => r.proposal.reply), ["alpha/alpha", "beta/beta"]);
  assert.deepEqual(idsByOwner, { alpha: ["call_0", "aginti_native_1"], beta: ["call_0", "aginti_native_1"] });
});
test("cancellation after one read does not start a later native turn", async () => {
  const abort = new AbortController(); let requests = 0, reads = 0;
  const provider = adapter("deepseek", async () => { requests++; return native([call("call_0")]); });
  await assert.rejects(runner(provider, async args => {
    reads++; abort.abort(); return { key: args.key, value: "scoped" };
  }).run(input, { signal: abort.signal }), { code: "CANCELLED" });
  assert.equal(requests, 1); assert.equal(reads, 1);
});
