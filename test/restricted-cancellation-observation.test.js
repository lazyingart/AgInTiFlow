import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createRestrictedApplicationRunner } from "../src/restricted-application.js";

const schema = { type: "object", properties: { answer: { type: "string", maxLength: 80 } }, required: ["answer"], additionalProperties: false };
const input = { input: [{ type: "text", text: "just check the supplied status, don't change anything" }] };
const final = answer => ({ type: "final", value: { answer } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const blocked = () => {
  const controller = new AbortController(), blocker = event => event.stopImmediatePropagation();
  controller.signal.addEventListener("abort", blocker);
  return { controller, dispose: () => controller.signal.removeEventListener("abort", blocker) };
};
const make = (complete, tools = []) => createRestrictedApplicationRunner({ provider: { supportsImages: false, complete }, tools,
  instructions: "Use only authorized supplied evidence. Return an uncommitted JSON proposal.", outputSchema: schema,
  limits: { timeoutMs: 3000, maxSteps: 3, maxConcurrency: 1 } });

test("an earlier propagation-stopping listener cannot turn cancellation into a late completed proposal", async () => {
  const { controller, dispose } = blocked(), entered = deferred(), reply = deferred(); let child;
  const app = make((_request, { signal }) => { child = signal; entered.resolve(); return reply.promise; });
  const result = observed(app.run(input, { signal: controller.signal }));
  try {
    await entered.promise; controller.abort(); const childAbortedAtCancel = child.aborted;
    reply.resolve(final("late reply")); const outcome = await result;
    assert.equal(outcome.error?.code, "CANCELLED"); assert.equal(childAbortedAtCancel, true);
    assert.equal(outcome.value, undefined); assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  } finally { reply.resolve(final("late reply")); await result; dispose(); }
});

for (const rejectLate of [false, true]) test(`suppressed propagation still cancels a quiet callback and charges its late ${rejectLate ? "rejection" : "fulfillment"}`, async () => {
  const { controller, dispose } = blocked(), entered = deferred(), reply = deferred(), unhandled = [];
  let calls = 0, outcome;
  const receive = error => unhandled.push(error); process.on("unhandledRejection", receive);
  const app = make(() => { if (++calls === 1) { entered.resolve(); return reply.promise; } return final("new invocation"); });
  const result = observed(app.run(input, { signal: controller.signal })).then(value => { outcome = value; return value; });
  try {
    await entered.promise; controller.abort(); await new Promise(setImmediate);
    assert.equal(outcome?.error?.code, "CANCELLED", "cancellation cannot depend on a callback producing more data");
    await assert.rejects(app.run(input), { code: "BUSY" }); assert.equal(calls, 1);
    if (rejectLate) reply.reject(Error("private callback diagnostic")); else reply.resolve(final("late"));
    await new Promise(setImmediate); assert.equal((await app.run(input)).proposal.answer, "new invocation");
    assert.deepEqual(unhandled, []); assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  } finally { reply.resolve(final("cleanup")); await result; dispose(); process.removeListener("unhandledRejection", receive); }
});

test("cancelled read tools cannot resume the provider and retain their capacity until actual settlement", async () => {
  const { controller, dispose } = blocked(), entered = deferred(), read = deferred(); let providers = 0, reads = 0, child, outcome;
  const app = make(() => ++providers === 1 ? { type: "tool_calls", calls: [{ id: "read_1", name: "read_status", arguments: {} }] } : final("fresh status"),
    [{ name: "read_status", description: "Read this caller-authorized status only.", readOnly: true,
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, outputSchema: schema,
      execute(_args, { signal }) { reads++; child = signal; entered.resolve(); return read.promise; } }]);
  const result = observed(app.run(input, { signal: controller.signal })).then(value => { outcome = value; return value; });
  try {
    await entered.promise; controller.abort(); await new Promise(setImmediate);
    assert.equal(outcome?.error?.code, "CANCELLED"); assert.equal(child.aborted, true);
    await assert.rejects(app.run(input), { code: "BUSY" }); assert.equal(providers, 1); assert.equal(reads, 1);
    read.resolve({ answer: "late status" }); await new Promise(setImmediate);
    assert.equal(providers, 1, "late read data cannot create a continuation after cancellation");
    assert.equal((await app.run(input)).proposal.answer, "fresh status"); assert.equal(providers, 2);
  } finally { read.resolve({ answer: "cleanup" }); await result; dispose(); }
});

test("pre-aborted native signals execute no provider or tool even with a blocker", async () => {
  const { controller, dispose } = blocked(); let calls = 0;
  const app = make(() => { calls++; return final("unexpected"); }); controller.abort();
  try { await assert.rejects(app.run(input, { signal: controller.signal }), { code: "CANCELLED" }); assert.equal(calls, 0);
    assert.equal((await app.run(input)).status, "completed"); assert.equal(calls, 1);
  } finally { dispose(); }
});

test("normal completion disposes only the SDK subscription across repeated native scopes", async () => {
  const app = make(() => final("observed"));
  for (let index = 0; index < 20; index++) {
    const { controller, dispose } = blocked();
    try { assert.equal((await app.run(input, { signal: controller.signal })).proposal.answer, "observed");
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    } finally { dispose(); }
  }
});

test("synchronous cancellation inside a provider cannot be ignored at the next checkpoint", async () => {
  const { controller, dispose } = blocked();
  const app = make(() => { controller.abort(); return final("must not complete"); });
  try { await assert.rejects(app.run(input, { signal: controller.signal }), { code: "CANCELLED" }); }
  finally { dispose(); }
});

test("untrusted abort reasons are never inspected or exposed", async () => {
  const { controller, dispose } = blocked(), entered = deferred(), reply = deferred(); let hooks = 0;
  const reason = new Proxy({}, { get() { hooks++; throw Error("private reason"); }, ownKeys() { hooks++; throw Error("private reason"); } });
  const app = make(() => { entered.resolve(); return reply.promise; }); const result = observed(app.run(input, { signal: controller.signal }));
  try { await entered.promise; controller.abort(reason); reply.resolve(final("late"));
    const outcome = await result; assert.equal(outcome.error?.code, "CANCELLED");
    assert.equal(JSON.stringify(outcome.error).includes("private"), false); assert.equal(hooks, 0);
  } finally { reply.resolve(final("cleanup")); await result; dispose(); }
});
