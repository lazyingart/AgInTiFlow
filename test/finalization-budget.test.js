import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import * as restricted from "../src/restricted-application.js";


// Shared final-turn catalog regressions (also exercised by text-only Lite).
const closingObject = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const closingText = { type: "string", minLength: 1, maxLength: 5000 };
const closingSchema = closingObject({ reply: closingText });
const closingInput = { input: [{ type: "text", text: "Read my current draft, keep the notes, propose the correction. Don't save." }],
  history: [{ role: "assistant", text: "Historical revision 2 is stale; read the current record." }] };
const closingCall = id => ({ type: "tool_calls", calls: [{ id, name: "draft_read", arguments: { query: "draft" } }] });
const closingFinal = reply => ({ type: "final", value: { reply } });
const closingTool = execute => ({ name: "draft_read", description: "Read the caller-bound current draft only.", readOnly: true,
  inputSchema: closingObject({ query: closingText }), outputSchema: closingObject({ reply: closingText }), execute });
const closingRunner = (complete, extra = {}) => restricted.createRestrictedApplicationRunner({
  provider: { supportsImages: false, complete }, instructions: "Read current data before drafting; never save. Keep the complete notes.",
  tools: [], outputSchema: closingSchema, ...extra,
});
const closingRejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test("last-turn and exhausted-read catalogs withdraw unavailable tools without changing evidence or budgets", async () => {
  for (const limits of [{ maxSteps: 2 }, { maxSteps: 4, maxToolCalls: 1 }]) {
    const requests = []; let reads = 0;
    const row = Object.freeze({ reply: "Current revision 3; keep notes 原文." });
    const run = closingRunner(async request => {
      requests.push(request);
      if (request.tools.length) return closingCall("read_" + requests.length);
      return closingFinal(request.messages.at(-1).value.reply);
    }, { tools: [closingTool(async () => { reads++; return row; })], limits });
    const result = await run.run(closingInput);
    assert.equal(result.proposal.reply, row.reply);
    assert.deepEqual(JSON.parse(JSON.stringify(result.usage)), { steps: 2, toolCalls: 1 });
    assert.equal(reads, 1); assert.equal(requests.length, 2);
    assert.equal(requests[0].tools.length, 1); assert.deepEqual(requests[1].tools, []);
    assert.match(requests[1].messages[0].content, /No further read-only tool calls/);
    assert.match(requests[1].messages[0].content, /missing evidence/);
    assert.ok(requests[1].messages[0].content.startsWith(requests[0].messages[0].content));
    assert.deepEqual(requests[1].messages.slice(1, -2), requests[0].messages.slice(1));
    assert.deepEqual(JSON.parse(JSON.stringify(requests[1].messages.at(-2))), { role: "assistant", calls: closingCall("read_1").calls });
    assert.deepEqual(JSON.parse(JSON.stringify(requests[1].messages.at(-1))), { role: "tool", callId: "read_1", name: "draft_read", value: row });
    assert.deepEqual(requests[1].outputSchema, requests[0].outputSchema);
    assert.equal(requests[1].maxOutputTokens, requests[0].maxOutputTokens);
    assert.ok(Object.isFrozen(requests[1]) && Object.isFrozen(requests[1].messages));
    assert.equal(row.reply, "Current revision 3; keep notes 原文.");
  }
});

test("native OpenAI and explicit Flash/Pro omit final tools while retaining full tool history/schema/output budget", async () => {
  for (const model of ["generic-explicit", "deepseek-flash", "deepseek-v4-pro"]) {
    const bodies = [];
    const factory = model === "generic-explicit" ? restricted.createRestrictedOpenAIProvider : restricted.createRestrictedDeepSeekProvider;
    const provider = factory({ model, ...(model === "generic-explicit" ? { supportsImages: false } : {}),
      async complete(body) {
        bodies.push(body);
        const first = bodies.length === 1;
        return { choices: [{ finish_reason: first ? "tool_calls" : "stop", message: first
          ? { role: "assistant", content: null, tool_calls: [{ id: "opaque_read_1", type: "function", function: { name: "draft_read", arguments: '{"query":"draft"}' } }] }
          : { role: "assistant", content: '{"reply":"当前版本3；notes unchanged. Proposal only."}' } }] };
      } });
    let reads = 0;
    const result = await closingRunner(undefined, { provider, tools: [closingTool(async () => { reads++; return { reply: "当前版本3；notes unchanged." }; })],
      limits: { maxSteps: 2, maxOutputTokens: 1337 } }).run(closingInput);
    assert.equal(reads, 1); assert.equal(bodies.length, 2);
    assert.equal(result.proposal.reply, "当前版本3；notes unchanged. Proposal only.");
    assert.equal(bodies[0].tools.length, 1); assert.equal(Object.hasOwn(bodies[1], "tools"), false);
    assert.equal(bodies[1].max_completion_tokens, bodies[0].max_completion_tokens);
    assert.equal(bodies[1].max_tokens, bodies[0].max_tokens);
    assert.ok(bodies[1].max_completion_tokens === 1337 || bodies[1].max_tokens === 1337);
    assert.deepEqual(bodies[1].response_format, bodies[0].response_format);
    assert.equal(bodies[1].model, model);
    assert.equal(bodies[1].messages.at(-1).tool_call_id, "opaque_read_1");
    assert.equal(bodies[1].messages.at(-1).content, '{"reply":"当前版本3；notes unchanged."}');
    assert.match(bodies[1].messages[0].content, /No further read-only tool calls/);
  }
});

test("ignoring a withdrawn catalog or returning invalid final data never buys another read/turn or synthesized completion", async () => {
  let providers = 0, reads = 0;
  await closingRejects(closingRunner(async () => closingCall("c" + ++providers), {
    tools: [closingTool(async () => { reads++; return { reply: "scoped" }; })], limits: { maxSteps: 2 },
  }).run(closingInput), "STEP_LIMIT");
  assert.equal(providers, 2); assert.equal(reads, 1);
  for (const bad of [null, { type: "final", value: { wrong: "shape" } }, { type: "final", value: { reply: "" } },
    { type: "final", value: { reply: "x", extra: true } }, { type: "refused" }]) {
    let calls = 0, seenReads = 0, error;
    try { await closingRunner(async () => ++calls === 1 ? closingCall("first") : bad, {
      tools: [closingTool(async () => { seenReads++; return { reply: "scoped" }; })], limits: { maxSteps: 2 },
    }).run(closingInput); } catch (value) { error = value; }
    assert.ok(error instanceof restricted.RestrictedApplicationError);
    assert.equal(calls, 2); assert.equal(seenReads, 1);
  }
});

test("no-tools requests stay byte-identical across step budgets and one-turn configured tools cannot execute", async () => {
  const requests = [];
  for (const maxSteps of [1, 8]) {
    await closingRunner(async request => { requests.push(JSON.stringify(request)); return closingFinal("proposal"); },
      { limits: { maxSteps } }).run(closingInput);
  }
  assert.equal(requests[0], requests[1]);
  assert.doesNotMatch(requests[0], /No further read-only tool calls/);
  let reads = 0;
  await closingRejects(closingRunner(async request => {
    assert.deepEqual(request.tools, []);
    assert.match(request.messages[0].content, /No further read-only tool calls/);
    return closingCall("impossible");
  }, { tools: [closingTool(async () => { reads++; return { reply: "not reached" }; })], limits: { maxSteps: 1 } }).run(closingInput), "STEP_LIMIT");
  assert.equal(reads, 0);
  let rounds = 0;
  await closingRunner(async request => {
    assert.equal(request.tools.length, 1);
    assert.doesNotMatch(request.messages[0].content, /No further read-only tool calls/);
    return ++rounds === 1 ? closingCall("allowed") : closingFinal("done");
  }, { tools: [closingTool(async () => ({ reply: "scoped" }))], limits: { maxSteps: 3, maxToolCalls: 2 } }).run(closingInput);
  assert.equal(rounds, 2);
});

test("finalization retains deadline/cancellation/context and invalid-read gates without leaking listeners or late results", { timeout: 10000 }, async () => {
  for (const invalid of [async () => { throw Error("PRIVATE_READ"); }, async () => ({ reply: 3 }), async () => ({ reply: "Authorization: Bearer synthetic-private" })]) {
    let turns = 0;
    await assert.rejects(closingRunner(async () => { turns++; return closingCall("read"); },
      { tools: [closingTool(invalid)], limits: { maxSteps: 2 } }).run(closingInput));
    assert.equal(turns, 1);
  }
  const requests = [];
  const measure = complete => closingRunner(complete, { tools: [closingTool(async () => ({ reply: "x".repeat(4000) }))], limits: { maxSteps: 2 } });
  await measure(async request => { requests.push(request); return requests.length === 1 ? closingCall("measure") : closingFinal("done"); }).run(closingInput);
  const sizes = requests.map(request => Buffer.byteLength(JSON.stringify(request)));
  assert.ok(sizes[1] > sizes[0]);
  let turns = 0;
  await closingRejects(closingRunner(async () => { turns++; return closingCall("bounded"); },
    { tools: [closingTool(async () => ({ reply: "x".repeat(4000) }))], limits: { maxSteps: 2, maxContextBytes: sizes[1] - 1 } }).run(closingInput), "CONTEXT_LIMIT");
  assert.equal(turns, 1);
  for (const mode of ["cancel", "timeout"]) {
    const parent = new AbortController(); let rounds = 0, settle, entered;
    const gate = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { settle = resolve; });
    const app = closingRunner(async (request, { signal }) => {
      if (++rounds === 1) return closingCall("first");
      entered(); assert.equal(request.tools.length, 0);
      return pending.then(() => { assert.equal(signal.aborted, true); return closingFinal("must not escape"); });
    }, { tools: [closingTool(async () => ({ reply: "scoped" }))], limits: { maxSteps: 2, timeoutMs: mode === "timeout" ? 35 : 1000 } });
    const observed = app.run(closingInput, { signal: parent.signal });
    const expected = closingRejects(observed, mode === "cancel" ? "CANCELLED" : "TIMEOUT");
    expected.catch(() => {}); // Observe failure even while waiting for entry.
    await gate; if (mode === "cancel") parent.abort();
    await expected; settle(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(rounds, 2); assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  }
});
