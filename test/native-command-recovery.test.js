import assert from "node:assert/strict";
import test from "node:test";
import { emptyNativeCommandJournal, readNativeCommandJournal, beginNativeCommand, validateNativeCommandDispatch, prepareNativeCommandResult, retireNativeCommand, restoreNativeCommandFrame, legacyUnconfirmedCommands, nativeCommandDigest, legacyNativeCommandHold, readLegacyNativeCommandHold } from "../src/native-command-recovery.js";
import { boundedNativeCommandCheckpointResult, nativeCommandVerificationDigest } from "../src/scs-evidence.js";

const expected = { sessionId: "command-recovery-unit", commandCwd: "/owned-workspace", goalRevision: 1, runtimeRevision: 1 };
const command = "node tools/check.mjs", taskHash = nativeCommandDigest("Run the checker once."), at = "2026-11-18T00:00:00.000Z";
const call = () => ({ id: "check_once", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command }) } });
function fixture() {
  const state = { stepsCompleted: 0, messages: [{ role: "assistant", content: null, tool_calls: [call()] }],
    meta: { goalContract: { history: [{ revision: 1, taskHash }] }, projectVerification: { commandRuns: [] } } };
  const journal = beginNativeCommand(emptyNativeCommandJournal(expected), expected, { call: call(), command, step: 1, taskHash, startedAt: at });
  const run = { command, ok: true, at, goalRevision: 1, mutationRevision: 0, commandSequence: 1, explicitExitStatus: 0 };
  const resultJson = JSON.stringify(boundedNativeCommandCheckpointResult({ toolName: "run_command", ok: true, exitCode: 0, stdout: "Observed check number 1", stderr: "", goalRevision: 1, projectMutationRevision: 0, commandSequence: 1 }));
  const checkpoint = { schemaVersion: 2, toolCallId: "check_once", taskHash, runSha256: nativeCommandVerificationDigest(run), resultSha256: nativeCommandDigest(resultJson), resultJson };
  run.nativeResultCheckpoint = checkpoint; state.meta.projectVerification.commandRuns.push(run);
  return { state, journal, run, checkpoint };
}
const invalid = { code: "NATIVE_COMMAND_JOURNAL_INVALID" };

test("journal enrollment retains native session identity bounds", () => {
  for (const id of ["native:session-" + "x".repeat(120), "x".repeat(255)]) {
    const context = { ...expected, sessionId: id };
    assert.equal(readNativeCommandJournal(emptyNativeCommandJournal(context), context).sessionId, id);
  }
  for (const id of [".", "x".repeat(256), "../other", "native/session", "native session"]) {
    assert.throws(() => emptyNativeCommandJournal({ ...expected, sessionId: id }), invalid);
  }
});

test("empty sessions may enroll at goal zero but cannot authorize a command", () => {
  const context = { ...expected, goalRevision: 0 }, journal = emptyNativeCommandJournal(context);
  assert.equal(journal.pending, null);
  assert.throws(() => beginNativeCommand(journal, context, { call: call(), command, taskHash, step: 1 }), invalid);
});
for (const semantic of ["no-match", "inner-failure"]) test(`recovery preserves ${semantic} without promoting it to a passing test`, () => {
  const f = fixture(), result = JSON.parse(f.checkpoint.resultJson);
  f.run.ok = false;
  if (semantic === "no-match") Object.assign(result, { exitCode: 1, noMatch: true, semanticOutcome: "no-match", noMatchExitIsSuccess: true, stdout: "", stderr: "" });
  else f.run.explicitExitStatus = 7;
  f.checkpoint.runSha256 = nativeCommandVerificationDigest(f.run);
  f.checkpoint.resultJson = JSON.stringify(boundedNativeCommandCheckpointResult({ ...result, commandPolicy: { noMatchExitIsSuccess: result.noMatchExitIsSuccess } }));
  f.checkpoint.resultSha256 = nativeCommandDigest(f.checkpoint.resultJson);
  const ready = prepareNativeCommandResult(f.journal, expected, f.state, f.checkpoint);
  restoreNativeCommandFrame(ready, expected, f.state);
  assert.equal(JSON.parse(f.state.messages.at(-1).content).ok, true);
  assert.equal(f.run.ok, false);
});

test("empty journal is detached, deeply frozen and canonical through JSON restart", () => {
  const value = emptyNativeCommandJournal(expected);
  assert.ok(Object.isFrozen(value)); assert.equal(value.pending, null);
  assert.deepEqual(readNativeCommandJournal(JSON.parse(JSON.stringify(value)), expected), value);
  assert.equal(emptyNativeCommandJournal(expected).digest, value.digest);
});
test("one prepared command cannot be overwritten by another dispatch", () => {
  const f = fixture(), before = JSON.stringify(f.journal);
  assert.equal(f.journal.pending.status, "dispatching"); assert.ok(Object.isFrozen(f.journal.pending));
  assert.throws(() => beginNativeCommand(f.journal, expected, { call: call(), command, step: 2, taskHash }), invalid);
  assert.equal(JSON.stringify(f.journal), before);
});
test("dispatch validates its frame and provenance before any durable authorization", () => {
  const f = fixture(); assert.deepEqual(validateNativeCommandDispatch(f.journal, expected, f.state), f.journal);
  for (const attack of ["history", "call", "steps"]) {
    const state = structuredClone(f.state);
    if (attack === "history") delete state.meta.goalContract.history[0].taskHash;
    if (attack === "call") state.messages[0].tool_calls[0].id = "foreign";
    if (attack === "steps") state.stepsCompleted = null;
    const before = JSON.stringify(state);
    assert.throws(() => validateNativeCommandDispatch(f.journal, expected, state), invalid);
    assert.equal(JSON.stringify(state), before);
  }
});
test("durable result can close its exact native frame after revision/provider continuation", () => {
  const f = fixture(), ready = prepareNativeCommandResult(f.journal, expected, f.state, f.checkpoint);
  assert.ok(Object.isFrozen(ready.pending.checkpoint));
  const copy = JSON.parse(JSON.stringify(ready)), context = { ...expected, goalRevision: 2, runtimeRevision: 2 };
  f.state.meta.goalContract.history.push({ revision: 2, taskHash });
  const recovered = restoreNativeCommandFrame(copy, context, f.state);
  assert.equal(recovered.journal.pending, null); assert.equal(f.state.messages.at(-1).tool_call_id, "check_once");
  assert.equal(JSON.parse(f.state.messages.at(-1).content).stdout, "Observed check number 1");
  assert.equal(f.state.stepsCompleted, 1);
  assert.throws(() => restoreNativeCommandFrame(copy, context, f.state), invalid);
});
test("a pending outcome is never guessed or converted into a completed frame", () => {
  const f = fixture(), before = JSON.stringify(f.state);
  assert.throws(() => restoreNativeCommandFrame(f.journal, expected, f.state), invalid);
  assert.equal(JSON.stringify(f.state), before);
});
for (const [field, value] of [["sessionId", "other"], ["commandCwd", "/other-workspace"], ["goalRevision", 0], ["runtimeRevision", 0]]) test(`journal rejects scope/revision substitution: ${field}`, () => {
  const f = fixture(); assert.throws(() => readNativeCommandJournal(f.journal, { ...expected, [field]: value }), invalid);
});
for (const attack of ["proxy", "accessor", "non-enumerable", "symbol", "extra", "custom-prototype", "false", "null", "future-schema", "wrong-digest"]) test(`closed journal data rejects ${attack}`, () => {
  let hooks = 0, value = JSON.parse(JSON.stringify(fixture().journal));
  if (attack === "proxy") value = new Proxy(value, { get() { hooks++; throw Error("hook"); }, ownKeys() { hooks++; throw Error("hook"); } });
  if (attack === "accessor") Object.defineProperty(value, "pending", { enumerable: true, get() { hooks++; throw Error("hook"); } });
  if (attack === "non-enumerable") Object.defineProperty(value, "digest", { enumerable: false });
  if (attack === "symbol") value[Symbol("extra")] = 1;
  if (attack === "extra") value.extra = true;
  if (attack === "custom-prototype") Object.setPrototypeOf(value, { get then() { hooks++; throw Error("hook"); } });
  if (attack === "false") value = false;
  if (attack === "null") value = null;
  if (attack === "future-schema") value.schemaVersion = 2;
  if (attack === "wrong-digest") value.digest = "0".repeat(64);
  assert.throws(() => readNativeCommandJournal(value, expected), invalid); assert.equal(hooks, 0);
});
for (const attack of ["command", "tool-id", "task-lineage", "run", "checkpoint", "reply-already-present", "multi-call", "duplicate-run", "bad-step"]) test(`result recovery rejects ${attack} without changing state`, () => {
  const f = fixture(), ready = prepareNativeCommandResult(f.journal, expected, f.state, f.checkpoint);
  if (attack === "command") f.state.messages[0].tool_calls[0].function.arguments = JSON.stringify({ command: "node tools/other.mjs" });
  if (attack === "tool-id") f.state.messages[0].tool_calls[0].id = "different";
  if (attack === "task-lineage") f.state.meta.goalContract.history[0].taskHash = "0".repeat(64);
  if (attack === "run") f.run.ok = false;
  if (attack === "checkpoint") f.checkpoint.resultSha256 = "0".repeat(64);
  if (attack === "reply-already-present") f.state.messages.push({ role: "tool", tool_call_id: "check_once", content: "{}" });
  if (attack === "multi-call") f.state.messages[0].tool_calls.push({ ...call(), id: "different" });
  if (attack === "duplicate-run") f.state.meta.projectVerification.commandRuns.push(structuredClone(f.run));
  if (attack === "bad-step") f.state.stepsCompleted = "0";
  const before = JSON.stringify(f.state); assert.throws(() => restoreNativeCommandFrame(ready, expected, f.state), invalid);
  assert.equal(JSON.stringify(f.state), before);
});
test("checkpoint accessors are rejected before invocation", () => {
  const f = fixture(); let hooks = 0;
  Object.defineProperty(f.checkpoint, "runSha256", { enumerable: true, get() { hooks++; throw Error("hook"); } });
  assert.throws(() => prepareNativeCommandResult(f.journal, expected, f.state, f.checkpoint), invalid); assert.equal(hooks, 0);
});
const event = (type, command = "node tools/check.mjs") => ({ timestamp: at, type, data: { toolName: "run_command", args: { command } } });
test("legacy unmatched starts remain unknown; one later result closes only its own latest attempt", () => {
  const unknown = legacyUnconfirmedCommands([event("tool.started"), event("tool.started"), event("tool.completed")]);
  assert.equal(unknown.length, 1); assert.equal(unknown[0].eventIndex, 0);
  assert.deepEqual(legacyUnconfirmedCommands([event("tool.started"), event("tool.completed")]), []);
});
test("a legacy generic post-dispatch failure is not an outcome receipt", () => {
  assert.equal(legacyUnconfirmedCommands([event("tool.started"), event("tool.failed")]).length, 1);
  const f = fixture();
  assert.deepEqual(legacyUnconfirmedCommands([disclose("check_once"), event("tool.started"), event("tool.failed")], f.state), []);
});
test("controlled interruption cannot erase an older orphan from another invocation/tool", () => {
  const stop = { timestamp: at, type: "session.stopped", data: { reason: "user_interrupt" } };
  const resume = { timestamp: at, type: "session.resumed", data: { sessionId: expected.sessionId } };
  assert.deepEqual(legacyUnconfirmedCommands([event("tool.started"), stop]), []);
  assert.equal(legacyUnconfirmedCommands([event("tool.started"), resume, stop]).length, 1);
  assert.equal(legacyUnconfirmedCommands([event("tool.started"), { timestamp: at, type: "tool.started", data: { toolName: "read_file", args: { path: "note.txt" } } }, stop]).length, 1);
});
test("sparse, proxy and extended legacy arrays fail closed with no iterator hooks", () => {
  let hooks = 0;
  for (const value of [Array(1), Object.assign([], { extra: true }), new Proxy([], { get() { hooks++; throw Error("hook"); } })]) assert.throws(() => legacyUnconfirmedCommands(value), invalid);
  assert.equal(hooks, 0);
});
test("retirement creates a new empty journal without mutating the issued entry", () => {
  const f = fixture(), before = JSON.stringify(f.journal), closed = retireNativeCommand(f.journal, expected);
  assert.equal(closed.pending, null); assert.equal(JSON.stringify(f.journal), before);
});
test("a closed earlier frame may reuse the current call ID without lending its result", () => {
  const f = fixture();
  f.state.messages.unshift({ role: "assistant", content: null, tool_calls: [{ ...call(), function: { name: "read_file", arguments: '{"path":"old.txt"}' } }] },
    { role: "tool", tool_call_id: "check_once", content: '{"ok":true,"content":"old unrelated output"}' });
  const ready = prepareNativeCommandResult(f.journal, expected, f.state, f.checkpoint);
  restoreNativeCommandFrame(ready, expected, f.state);
  assert.match(f.state.messages.at(-1).content, /Observed check number 1/);
});
test("two unanswered frames cannot reuse an ID to select a result", () => {
  const f = fixture(); f.state.messages.unshift(structuredClone(f.state.messages[0]));
  const before = JSON.stringify(f.state);
  assert.throws(() => prepareNativeCommandResult(f.journal, expected, f.state, f.checkpoint), invalid);
  assert.equal(JSON.stringify(f.state), before);
});
test("server-built commit commands bind the original native call and effective command", () => {
  const f = fixture(), commit = { id: "check_once", type: "function", function: { name: "commit_project_changes", arguments: '{"message":"Record verified change"}' } };
  const effective = "git add -- 'note.txt' && git commit -m 'Record verified change'";
  f.state.messages[0].tool_calls = [commit]; f.run.command = effective;
  f.checkpoint.runSha256 = nativeCommandVerificationDigest(f.run);
  const journal = beginNativeCommand(emptyNativeCommandJournal(expected), expected, { call: commit, command: effective, taskHash, step: 1 });
  const ready = prepareNativeCommandResult(journal, expected, f.state, f.checkpoint);
  commit.function.arguments = '{"message":"Different change"}';
  assert.throws(() => restoreNativeCommandFrame(ready, expected, f.state), invalid);
  commit.function.arguments = '{"message":"Record verified change"}';
  restoreNativeCommandFrame(ready, expected, f.state); assert.equal(f.state.messages.at(-1).tool_call_id, commit.id);
  assert.equal(f.state.meta.durableGitEvidence, undefined, "Recovery must not manufacture ordered Git authority");
});
test("unknown native aliases cannot reserve command execution", () => {
  const renamed = call(); renamed.function.name = "arbitrary_command_alias";
  assert.throws(() => beginNativeCommand(emptyNativeCommandJournal(expected), expected, { call: renamed, command, taskHash, step: 1 }), invalid);
});
test("real provider ordinal metadata is accepted and bound to its exact native frame", () => {
  for (const index of [0, 7]) {
    const f = fixture(); f.state.messages[0].tool_calls[0].index = index;
    const journal = beginNativeCommand(emptyNativeCommandJournal(expected), expected, { call: f.state.messages[0].tool_calls[0], command, taskHash, step: 1 });
    validateNativeCommandDispatch(journal, expected, f.state);
    const ready = prepareNativeCommandResult(journal, expected, f.state, f.checkpoint);
    f.state.messages[0].tool_calls[0].index = index + 1;
    assert.throws(() => restoreNativeCommandFrame(ready, expected, f.state), invalid);
    f.state.messages[0].tool_calls[0].index = index;
    restoreNativeCommandFrame(ready, expected, f.state);
  }
});
test("provider ordinal is a nonnegative integer data field, never arbitrary metadata", () => {
  let hooks = 0;
  for (const value of [-1, 0.5, "0", null, undefined, NaN]) {
    const c = { ...call(), index: value };
    assert.throws(() => beginNativeCommand(emptyNativeCommandJournal(expected), expected, { call: c, command, taskHash, step: 1 }), invalid);
  }
  const accessor = call(); Object.defineProperty(accessor, "index", { enumerable: true, get() { hooks++; return 0; } });
  for (const c of [accessor, { ...call(), index: 0, extra: true }]) {
    assert.throws(() => beginNativeCommand(emptyNativeCommandJournal(expected), expected, { call: c, command, taskHash, step: 1 }), invalid);
  }
  assert.equal(hooks, 0);
});

test("restored reply precedes a later genuine continuation and remains a closed frame", () => {
  const f = fixture(), ready = prepareNativeCommandResult(f.journal, expected, f.state, f.checkpoint);
  f.state.messages.push({ role: "user", content: "Please continue." });
  restoreNativeCommandFrame(ready, expected, f.state);
  assert.deepEqual(f.state.messages.map(m => m.role), ["assistant", "tool", "user"]);
});
for (const attack of ["ok", "mutation", "sequence", "command", "test-without-proof"]) test(`outcome semantics must match native verification: ${attack}`, () => {
  const f = fixture(), data = JSON.parse(f.checkpoint.resultJson);
  if (attack === "ok") data.ok = false;
  if (attack === "mutation") data.projectMutationRevision++;
  if (attack === "sequence") data.commandSequence++;
  if (attack === "command") { f.run.command = "node tools/other.mjs"; f.checkpoint.runSha256 = nativeCommandVerificationDigest(f.run); }
  if (attack === "test-without-proof") data.projectTest = { passed: true, mutationRevision: 0, commandSequence: 1 };
  f.checkpoint.resultJson = JSON.stringify(boundedNativeCommandCheckpointResult(data)); f.checkpoint.resultSha256 = nativeCommandDigest(f.checkpoint.resultJson);
  assert.throws(() => prepareNativeCommandResult(f.journal, expected, f.state, f.checkpoint), invalid);
});
const disclose = (id, command = "node tools/check.mjs") => ({ timestamp: at, type: "model.responded", data: { step: 1, content: "", toolCalls: [{ id, name: "run_command", arguments: JSON.stringify({ command }) }] } });
test("exact old native checkpoint retires only its own disclosed call ID", () => {
  const f = fixture();
  assert.deepEqual(legacyUnconfirmedCommands([disclose("check_once"), event("tool.started")], f.state), []);
  const unresolved = legacyUnconfirmedCommands([disclose("earlier_unknown"), event("tool.started"), disclose("check_once"), event("tool.started")], f.state);
  assert.equal(unresolved.length, 1); assert.equal(unresolved[0].toolCallId, "earlier_unknown");
});
test("a published receipt cannot be reused to clear another identical unknown", () => {
  const f = fixture();
  const events = [disclose("earlier_unknown"), event("tool.started"), disclose("check_once"), event("tool.started"), event("tool.completed")];
  const pending = legacyUnconfirmedCommands(events, f.state);
  assert.equal(pending.length, 1); assert.equal(pending[0].toolCallId, "earlier_unknown");
});
test("missing, duplicate and foreign legacy IDs never consume a checkpoint", () => {
  const f = fixture();
  for (const events of [[event("tool.started")], [disclose("foreign"), event("tool.started")], [disclose("check_once"), event("tool.started"), disclose("check_once"), event("tool.started")]]) {
    assert.equal(legacyUnconfirmedCommands(events, f.state).length, events.filter(e => e.type === "tool.started").length);
  }
});
test("legacy hold is durable and scope-bound without raw command/result text", () => {
  const value = legacyNativeCommandHold(legacyUnconfirmedCommands([event("tool.started")]), expected);
  assert.ok(Object.isFrozen(value)); assert.equal(value.unknownCount, 1); assert.ok(!JSON.stringify(value).includes(command));
  assert.deepEqual(readLegacyNativeCommandHold(JSON.parse(JSON.stringify(value)), expected), value);
  assert.throws(() => readLegacyNativeCommandHold(value, { ...expected, sessionId: "other" }), invalid);
  for (const corrupt of [false, null, { ...value, digest: "0".repeat(64) }, { ...value, unknownCount: 0 }]) assert.throws(() => readLegacyNativeCommandHold(corrupt, expected), invalid);
});
