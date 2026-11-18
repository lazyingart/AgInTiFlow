import assert from "node:assert/strict";
import test from "node:test";
import { pipe, sdk, peerVersion, base, input, final, call, tool, frame, gate, until, bounded } from "./harness.js";

function channel(complete, options = {}) {
  const events = [];
  const value = pipe.createRestrictedApplicationChannel(base(complete, { emit: event => { events.push(event); }, ...options }));
  return { value, events };
}
const run = (c, id = "request_alpha_0001", request = input) => c.accept(frame(c, "run", id, { request }));
const terminal = events => events.find(event => ["result", "error"].includes(event.type));

const openAIModels = peerVersion === "0.1.0-preview.22" ? ["gpt-4.1-mini", "gpt-5.4-mini"] : ["gpt-4.1-mini"];
for (const model of openAIModels) test(`installed SDK ${peerVersion} preserves the 128-token limit for ${model} over the pipe`, async () => {
  let calls = 0;
  const provider = sdk.createRestrictedOpenAIProvider({ model, supportsImages: false, complete(body) {
    calls++;
    assert.equal(body.model, model);
    const budget = model === "gpt-5.4-mini" ? "max_completion_tokens" : "max_tokens";
    assert.deepEqual(Object.keys(body).filter(key => key === "max_tokens" || key === "max_completion_tokens"), [budget]);
    assert.equal(body[budget], 128);
    assert.equal(body.tools?.length ?? 0, 0);
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"reply":"Friday"}' } }] };
  } });
  const { value: c, events } = channel(undefined, { provider, limits: { maxOutputTokens: 128, maxSteps: 1 } });
  try {
    await run(c);
    await until(() => terminal(events));
    assert.equal(terminal(events).result?.proposal?.reply, "Friday");
    assert.deepEqual({ ...terminal(events).result.usage }, { steps: 1, toolCalls: 0 });
    assert.equal(calls, 1);
  } finally { await c.close(); }
});

test("actual SDK loop delegates one scoped read and returns an uncommitted proposal", async () => {
  let steps = 0;
  const { value: c, events } = channel(async request => {
    steps++; assert.ok(Object.isFrozen(request));
    return request.messages.at(-1).role === "tool" ? final(request.messages.at(-1).value.text) : call("secret_raw_call_77");
  }, { tools: [tool] });
  try {
    assert.equal(c.ready.providerAvailability, "not-probed");assert.ok(Object.isFrozen(c.ready));
    await run(c);await until(() => events.some(e => e.type === "read"));
    const read = events.find(e => e.type === "read");
    assert.equal(read.name, "draft_read");assert.deepEqual({ ...read.arguments }, { query: "draft" });
    assert.ok(!JSON.stringify(read).includes("secret_raw_call_77"));
    await c.accept(frame(c, "read_result", read.requestId, { readId: read.readId, value: { text: "Corrected wording, proposed only.", revision: 4 } }));
    await until(() => terminal(events));
    assert.equal(terminal(events).result.proposal.reply, "Corrected wording, proposed only.");
    assert.deepEqual({ ...terminal(events).result.usage }, { steps: 2, toolCalls: 1 });assert.equal(steps, 2);
    await c.accept(frame(c, "read_result", read.requestId, { readId: read.readId, value: {} }));
    assert.equal(events.at(-1).code, "READ_NOT_PENDING");
  } finally { await c.close(); }
});

test("parent-supplied history is explicit, detached and never retained between invocations", async () => {
  const observed = [];
  const { value: c, events } = channel(async request => { observed.push(request);return final(); });
  try {
    const history = [{ role: "assistant", text: "authorized_previous_turn_123" }];
    const pending = run(c, "request_history_0001", { ...input, history });history[0].text = "mutated_alias";
    await pending;await until(() => events.some(e => e.type === "result"));
    await until(() => c.inspect().activeRuns === 0);
    await run(c, "request_history_0002");await until(() => events.filter(e => e.type === "result").length === 2);
    assert.match(JSON.stringify(observed[0]), /authorized_previous_turn_123/);assert.doesNotMatch(JSON.stringify(observed), /mutated_alias/);
    assert.doesNotMatch(JSON.stringify(observed[1]), /authorized_previous_turn_123/);
  } finally { await c.close(); }
});

test("wrong scope or boot nonce cannot dispatch, cancel or reply to another account", async () => {
  const wait = gate();let calls = 0;
  const { value: a, events } = channel(async () => { calls++;return wait.promise; });
  const { value: b } = channel();
  try {
    for (const extra of [{ scopeId: "account_beta_0002" }, { nonce: b.ready.nonce }]) {
      await a.accept({ ...frame(a, "run", undefined, { request: input }), ...extra });assert.equal(events.at(-1).code, "SCOPE_MISMATCH");
    }
    assert.equal(calls, 0);await run(a);await until(() => calls === 1);
    await a.accept({ ...frame(a, "cancel"), scopeId: "account_beta_0002" });assert.equal(a.inspect().providerCallbacks, 1);
    wait.resolve(final());await until(() => events.some(e => e.type === "result"));
  } finally { wait.resolve(final());await a.close();await b.close(); }
});

test("exact closed request schemas reject runtime overrides and hostile data with zero traps", async () => {
  let traps = 0, calls = 0;const { value: c } = channel(async () => { calls++;return final(); });
  try {
    const hostile = new Proxy({}, { get() { traps++; }, ownKeys() { traps++; } });
    const accessor = { ...frame(c, "run", undefined, { request: input }) };Object.defineProperty(accessor, "model", { enumerable: true, get() { traps++;return "bad"; } });
    const sparse = [];sparse.length = 1;
    for (const raw of [hostile, accessor, { ...frame(c, "run", undefined, { request: { ...input, provider: "bad" } }) },
      { ...frame(c, "run", undefined, { request: { input: sparse } }) }, { ...frame(c, "run", undefined, { request: input }), tools: [] },
      { ...frame(c, "run", undefined, { request: input }), type: "__proto__" }]) await assert.rejects(c.accept(raw));
    assert.equal(traps, 0);assert.equal(calls, 0);
    const config = new Proxy({}, { get() { traps++; }, ownKeys() { traps++; } });
    assert.throws(() => pipe.createRestrictedApplicationChannel(config));assert.equal(traps, 0);
  } finally { await c.close(); }
});

test("one-use IDs and the 64-request worker bound forbid replay and resurrection", async () => {
  let calls = 0;const { value: c, events } = channel(async () => { calls++;return final(); });
  try {
    for (let i = 0; i < 64; i++) {
      await run(c, `request_bound_${String(i).padStart(4, "0")}`);await until(() => c.inspect().activeRuns === 0);
    }
    await run(c, "request_bound_0000");assert.equal(events.at(-1).code, "REQUEST_ID_REUSED");
    await run(c, "request_bound_9999");assert.equal(events.at(-1).code, "WORKER_EXHAUSTED");assert.equal(calls, 64);
  } finally { await c.close(); }
});

test("cancelled provider remains charged until actual settlement; no later tools or fallback", async () => {
  const wait = gate();let calls = 0;
  const { value: c, events } = channel(() => ++calls === 1 ? wait.promise : final(), { tools: [tool] });
  try {
    await run(c);await until(() => calls === 1);await c.accept(frame(c, "cancel"));
    await until(() => events.some(e => e.type === "error" && e.code === "CANCELLED"));
    await run(c, "request_second_0002");assert.equal(events.at(-1).code, "BUSY");assert.equal(calls, 1);
    wait.resolve(call());await until(() => c.inspect().providerCallbacks === 0);await new Promise(setImmediate);
    assert.ok(!events.some(e => e.type === "read"));
    await run(c, "request_second_0002");await until(() => c.inspect().activeRuns === 0);
    assert.equal(calls, 2); // BUSY was genuinely unissued; the new run is independent.
  } finally { wait.resolve(final());await c.close(); }
});

test("cancelled parent read keeps capacity until exact late reply; foreign reply cannot free it", async () => {
  const { value: c, events } = channel(async () => call(), { tools: [tool] });
  try {
    await run(c);await until(() => events.some(e => e.type === "read"));const read = events.find(e => e.type === "read");
    await c.accept(frame(c, "cancel"));await until(() => events.some(e => e.type === "read_cancel"));
    await until(() => c.inspect().activeRuns === 0);
    await c.accept(frame(c, "read_result", "request_wrong_0002", { readId: read.readId, value: {} }));assert.equal(events.at(-1).code, "READ_NOT_PENDING");
    await run(c, "request_new_00002");assert.equal(events.at(-1).code, "BUSY");
    await c.accept(frame(c, "read_result", read.requestId, { readId: read.readId, value: { text: "late", revision: 1 } }));
    assert.equal(c.inspect().pendingReads, 0);await new Promise(setImmediate);assert.equal(c.inspect().activeRuns, 0);
  } finally { await c.close(); }
});

test("typed read/provider failures preserve only SDK-issued metadata and never raw secrets", async () => {
  const { value: c, events } = channel(async () => call(), { tools: [tool] });
  try {
    await run(c);await until(() => events.some(e => e.type === "read"));const read = events.find(e => e.type === "read");
    await assert.rejects(c.accept(frame(c, "read_error", undefined, { readId: read.readId, failure: { category: "not_a_category" } })));
    assert.equal(c.inspect().pendingReads, 1);
    await c.accept(frame(c, "read_error", undefined, { readId: read.readId, failure: { category: "unavailable", retryAfterMs: 250 } }));
    await until(() => terminal(events));assert.deepEqual({ ...terminal(events).toolFailure }, { schemaVersion: "aginti-tool-failure-v1", category: "unavailable", retryAfterMs: 250 });
  } finally { await c.close(); }
  const cases = [sdk.createRestrictedProviderFailure({ category: "quota" }), new Error("raw_private_error_marker")];
  for (const error of cases) {
    const { value, events: output } = channel(async () => { throw error; });
    try { await run(value);await until(() => terminal(output));assert.equal(terminal(output).code, "PROVIDER_FAILED");assert.doesNotMatch(JSON.stringify(output), /raw_private_error_marker|stack|cause/); }
    finally { await value.close(); }
  }
});

test("failed accepted-frame delivery never dispatches a provider; poisoned output aborts reads", async () => {
  let calls = 0, traps = 0;
  const value = pipe.createRestrictedApplicationChannel(base(async () => { calls++;return final(); }, { emit: () => new Proxy({}, { get() { traps++; } }) }));
  await run(value);await until(() => value.inspect().activeRuns === 0);
  assert.equal(calls, 0);assert.equal(traps, 0);assert.equal(value.inspect().poisoned, true);await value.close();
  const c = pipe.createRestrictedApplicationChannel(base(async () => call(), { tools: [tool], emit: event => { if (event.type === "read") throw new Error("private"); } }));
  await run(c);await until(() => c.inspect().activeRuns === 0);assert.equal(c.inspect().pendingReads, 0);await c.close();
});

test("close is bounded/sticky and never claims remote termination for uncooperative work", async () => {
  const wait = gate();const { value: c } = channel(() => wait.promise, { closeGraceMs: 20 });
  await run(c);await until(() => c.inspect().providerCallbacks === 1);
  const close = c.close();assert.equal(close, c.close());
  await assert.rejects(close, error => error.code === "CLOSE_UNPROVEN");
  await assert.rejects(run(c), error => error.code === "CLOSED");assert.equal(c.inspect().providerCallbacks, 1);
  wait.reject(new Error("late_private_error"));await until(() => c.inspect().providerCallbacks === 0);
});

test("close waits admitted cooperative work and never leaks a rejected promise", async () => {
  const unhandled = [];const listener = e => unhandled.push(e);process.on("unhandledRejection", listener);
  const wait = gate(), delivered = gate();
  const c = pipe.createRestrictedApplicationChannel(base(() => wait.promise, { emit: event => { if (event.type === "accepted") return delivered.promise; } }));
  try {
    run(c);const close = c.close();delivered.resolve();
    assert.deepEqual(await bounded(close), { localCallbacksDrained: true, remoteTerminationProven: false });
    c.accept({});await new Promise(setImmediate);assert.equal(unhandled.length, 0);assert.equal(c.inspect().providerCallbacks, 0);
  } finally { wait.resolve(final());delivered.resolve();process.off("unhandledRejection", listener); }
});
