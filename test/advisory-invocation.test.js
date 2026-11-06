import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveAdvisoryInvocationContract as derive, createAdvisoryInvocationCheckpoint,
  advisoryInvocationState as inspect, advisoryInvocationRequestHash as requestHash,
  reserveAdvisoryInvocation as reserve, settleAdvisoryInvocation as settle,
  reconcileAdvisoryToolReplies,
} from "../src/advisory-invocation.js";
import { deriveScsTaskContract } from "../src/scs-evidence.js";

const goal = "Ask Codex for one read-only second opinion before editing, then fix the implementation.";
const request = { wrapper: "codex", prompt: "Review this supplied calculation without using tools." };
const result = { ok: true, wrapper: "codex", stdout: "The calculation omits quantity.", stderr: "" };
function fresh() {
  return { sessionId: "advisory-scope", meta: {
    goalContract: { revision: 1, activeGoalRevision: 1, taskBoundaryRevision: 1, taskRelation: "initial", taskGoal: goal, currentRequest: goal },
    advisoryInvocation: createAdvisoryInvocationCheckpoint(),
  } };
}
function claimed() { const state = fresh(); reserve(state, inspect(state, goal), requestHash(request), "original_advice", "2026-11-06T00:00:00.000Z"); return state; }

for (const wrapper of ["codex", "claude", "gemini", "copilot", "qwen"]) test(`explicit once-only review is generic to the selected ${wrapper} adviser`, () => {
  const instruction = `Please ask ${wrapper} only once before making changes.`;
  assert.deepEqual(derive(instruction), { version: 1, wrapper, maximumAttempts: 1, required: true, beforeMutation: true });
  assert.ok(deriveScsTaskContract({ goal: instruction }).requiredToolCalls.includes("delegate_agent"));
  assert.deepEqual(derive(`Ask ${wrapper} once if useful.`), { version: 1, wrapper, maximumAttempts: 1, required: false, beforeMutation: false });
});

for (const text of [
  "修改之前，请 Codex 咨询一次。", "編輯之前，請 Codex 諮詢一次。",
  "Before editing, ask Codex only once.", "Please ask Codex for one independent read-only second opinion\nbefore editing.",
]) test(`bounded review order survives normal wording: ${text}`, () => assert.equal(derive(text)?.beforeMutation, true));

for (const text of [
  "Ask Codex for advice. Run checks once.", "Don't ask Codex once. Explain the calculation.",
  "Explain how to ask Codex only once.", "Consult Codex twice and compare the two reviews.",
  "Use codex_once_parser to parse this dataset.", "Describe a workflow where you ask Codex once.",
  'Explain this quoted instruction: "Ask Codex once before editing."',
  "Explain this code: ```const instruction = 'Ask Codex once';```",
  "Read `Ask Codex once` as data, not as an instruction.",
  'Explain the unfinished quote: "Ask Codex once',
  "Read this unfinished code sample: ```Ask Codex once",
  "Explain this literal: 'Don\\'t ask Codex once.'",
  "Ask Codex twice, then run the checks once.",
  "Ask Codex for advice and run the checks once.",
]) test(`descriptions and unrelated counts do not invent a once-only task: ${text}`, () => assert.equal(derive(text), null));

test("quoting the wrapper name itself does not erase a real owner instruction", () => {
  assert.equal(derive("Ask `Codex` only once before editing.")?.beforeMutation, true);
  assert.equal(derive("Use Codex once before editing.")?.beforeMutation, true);
});

test("optional and explicit failure fallback do not demand a successful review", () => {
  for (const text of ["If useful, ask Codex once before editing.", "You may ask Codex once before editing.",
    "Ask Codex once. If it fails, continue without it.", "Ask Codex once if it helps."])
    assert.equal(derive(text)?.required, false, text);
});

test("reservation, settlement and detached restart preserve exact result and request binding", () => {
  const state = claimed(); assert.equal(inspect(state, goal).kind, "uncertain");
  settle(state, goal, result);
  const restarted = JSON.parse(JSON.stringify(state));
  const observed = inspect(restarted, goal);
  assert.equal(observed.kind, "succeeded"); assert.equal(observed.attempt.result.stdout, result.stdout);
  assert.equal(observed.attempt.requestHash, requestHash(request));
  assert.notEqual(requestHash({ ...request, prompt: request.prompt + " Another question." }), observed.attempt.requestHash);
  assert.notEqual(requestHash(request, { wrapperModel: "different-explicit-model" }), observed.attempt.requestHash);
  assert.notEqual(requestHash(request, { commandCwd: "/different-owned-workspace" }), observed.attempt.requestHash);
  assert.ok(!JSON.stringify(state.meta.advisoryInvocation).includes(request.prompt));
});

test("generic and concrete same-task continuations and provider changes do not grant another attempt", () => {
  const state = claimed(); settle(state, goal, { ...result, ok: false, stdout: "", error: "Adviser unavailable." });
  Object.assign(state.meta.goalContract, { revision: 2, activeGoalRevision: 2, currentRequest: "Continue the same task and add a verification check.", taskRelation: "same-task" });
  state.provider = "another-explicit-provider";
  assert.equal(inspect(state, goal).kind, "failed");
  assert.equal(inspect(state, goal).scope.revision, 1);
  state.meta.goalContract.currentRequest = "Continue the same task with a new output. Ask Codex once before editing.";
  assert.equal(inspect(state, goal).kind, "failed", "new output was misread as a new review grant");
});

test("an explicit new review grant is stable through later continuation", () => {
  const state = claimed(); settle(state, goal, result);
  Object.assign(state.meta.goalContract, { revision: 2, currentRequest: "Please ask Codex once again for a second opinion." });
  let info = inspect(state, goal); assert.equal(info.kind, "unused"); assert.equal(info.scope.revision, 2);
  reserve(state, info, requestHash(request), "new_advice"); settle(state, goal, result);
  Object.assign(state.meta.goalContract, { revision: 3, currentRequest: "Continue the same task." });
  info = inspect(state, goal); assert.equal(info.kind, "succeeded"); assert.equal(info.scope.revision, 2);
});

test("legacy or corrupt receipt history cannot be presumed unissued", () => {
  for (const value of [undefined, null, false, 0, "", { version: 1 }, { version: 2, scope: null, attempt: null }]) {
    const state = fresh(); state.meta.advisoryInvocation = value;
    assert.equal(inspect(state, goal).kind, "invalid");
  }
  const state = fresh(); delete state.meta.advisoryInvocation;
  Object.assign(state.meta.goalContract, { revision: 2, taskBoundaryRevision: 2, taskRelation: "new-request" });
  assert.equal(inspect(state, goal).kind, "unused");
});

test("an explicit new grant can advance a legacy task without silently resetting on generic resume", () => {
  const state = fresh(); delete state.meta.advisoryInvocation; delete state.meta.goalContract.taskBoundaryRevision;
  Object.assign(state.meta.goalContract, { revision: 2, taskRelation: "same-task", currentRequest: "Please ask Codex once again." });
  const info = inspect(state, goal); assert.equal(info.kind, "unused");
  reserve(state, info, requestHash(request), "legacy_grant"); settle(state, goal, result);
  Object.assign(state.meta.goalContract, { revision: 3, currentRequest: "Continue the same task." });
  assert.equal(inspect(state, goal).kind, "succeeded"); assert.equal(inspect(state, goal).scope.revision, 2);
});

test("receipt Proxy/accessor/hidden/symbol/prototype attacks trigger no hooks", () => {
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw Error("get"); }, ownKeys() { traps++; throw Error("keys"); }, getPrototypeOf() { traps++; throw Error("prototype"); } });
  const accessor = { version: 1, scope: null }; Object.defineProperty(accessor, "attempt", { enumerable: true, get() { traps++; throw Error("getter"); } });
  const hidden = { version: 1, scope: null }; Object.defineProperty(hidden, "attempt", { value: null });
  for (const value of [proxy, accessor, hidden, { ...createAdvisoryInvocationCheckpoint(), [Symbol("extra")]: 1 }, Object.create(createAdvisoryInvocationCheckpoint())]) {
    const state = fresh(); state.meta.advisoryInvocation = value; assert.equal(inspect(state, goal).kind, "invalid");
  }
  const nested = claimed(); nested.meta.advisoryInvocation.scope = proxy;
  assert.equal(inspect(nested, goal).kind, "invalid"); assert.equal(traps, 0);
  const nestedValue = claimed(); nestedValue.meta.advisoryInvocation.attempt.toolCallId = proxy;
  assert.equal(inspect(nestedValue, goal).kind, "invalid"); assert.equal(traps, 0);
  assert.equal(requestHash(proxy), null); assert.equal(traps, 0);
});

test("future/cross-session/corrupt scope and result hashes fail closed", () => {
  const state = claimed(); settle(state, goal, result);
  for (const mutate of [s => s.sessionId = "foreign", s => s.meta.advisoryInvocation.scope.revision = 10,
    s => s.meta.advisoryInvocation.attempt.result.stdout += " forged", s => s.meta.advisoryInvocation.scope.id = "0".repeat(64)]) {
    const copy = structuredClone(state); mutate(copy); assert.equal(inspect(copy, goal).kind, "invalid");
  }
});

test("empty output, false success attribution and automatic spare substitution cannot satisfy review", () => {
  for (const changes of [{ stdout: " " }, { wrapper: "claude" }, { fallback: true }]) {
    const state = claimed(); settle(state, goal, { ...result, ...changes }); assert.equal(inspect(state, goal).kind, "failed");
  }
});

test("invalid reservation preparation leaves native checkpoint unchanged", () => {
  const state = fresh(), before = JSON.stringify(state);
  assert.throws(() => reserve(state, inspect(state, goal), requestHash(request), "advice", "not-a-date"));
  assert.equal(JSON.stringify(state), before);
});

test("unfinished transport pairs are closed as unknown without inventing a completed tool action", () => {
  const state = claimed();
  state.messages = [{ role: "assistant", tool_calls: [{ id: "original_advice", function: { name: "delegate_agent" } }] },
    { role: "user", content: "Continue" }];
  assert.equal(reconcileAdvisoryToolReplies(state), 1);
  assert.equal(state.messages[1].tool_call_id, "original_advice");
  assert.deepEqual(JSON.parse(state.messages[1].content), { ok: false, outcome: "unavailable", replayed: false,
    error: "The previous advisory reply was not durably recorded. No external call is being repeated by this recovery." });
  assert.equal(state.messages[2].role, "user"); assert.equal(reconcileAdvisoryToolReplies(state), 0);
});

test("reply recovery never imports another session's receipt", () => {
  const state = claimed(); state.sessionId = "foreign";
  state.messages = [{ role: "assistant", tool_calls: [{ id: "original_advice", function: { name: "delegate_agent" } }] }];
  const before = JSON.stringify(state); assert.equal(reconcileAdvisoryToolReplies(state), 0); assert.equal(JSON.stringify(state), before);
});
