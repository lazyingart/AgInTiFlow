import assert from "node:assert/strict";
import test from "node:test";
import { retainedLongJobResult, launchOnlyHandoffReceipt } from "../src/deferred-job-handoff.js";
import { buildConstrainedRecoveryRequest, continuationAddsConcreteRequirement, isCompletedContinuationNoop, repairModelMessageHistory } from "../src/agent-runner.js";

const launch = (jobId = "export-12345678") => ({ ok: true, toolName: "start_long_job", jobId, background: true, deferredVerification: true,
  statusPath: `.aginti/long-jobs/${jobId}/status.json`, statusMarkdownPath: `.aginti/long-jobs/${jobId}/status.md`, stdoutPath: `.aginti/long-jobs/${jobId}/stdout.log`, stderrPath: `.aginti/long-jobs/${jobId}/stderr.log`,
  cwd: "/private/RAW_CWD", command: "RAW_COMMAND", stdout: "RAW_STDOUT", provider: "RAW_PROVIDER", result: "RAW_RESULT", path: "/private/RAW_PATH" });
const status = (jobId = "export-12345678") => ({ ...launch(jobId), toolName: "long_job_status", state: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z", attempt: 1, outputBytes: 0, outputExists: false, exitCode: null, verifyExitCode: null, sessionAlive: null, pid: 12345, reason: "RAW_REASON" });
const frame = (payload, id = payload.jobId, reasoning) => [
  { role: "assistant", content: null, ...(reasoning ? { reasoning_content: reasoning } : {}), tool_calls: [{ id, type: "function", function: { name: payload.toolName, arguments: JSON.stringify({ command: "RAW_ARGUMENT_COMMAND", cwd: "/private/RAW_ARGUMENT_CWD" }) } }] },
  { role: "tool", tool_call_id: id, content: JSON.stringify(payload) },
];
const repair = messages => { const state = { messages }; repairModelMessageHistory(state, { provider: "deepseek" }); return state; };
const proofs = state => state.messages.filter(m => m.role === "user" && m.content.startsWith("Retained runtime tool evidence.")).map(m => JSON.parse(m.content.split("Verified result: ")[1]));

test("launch projection is closed, bounded and does not copy raw execution/configuration data", () => {
  const view = retainedLongJobResult(launch()); assert.ok(view); assert.equal(Object.isFrozen(view), true);
  assert.deepEqual(Object.keys(view).sort(), ["ok", "toolName", "jobId", "statusPath", "statusMarkdownPath", "stdoutPath", "stderrPath", "background", "deferredVerification", "instruction"].sort());
  assert.doesNotMatch(JSON.stringify(view), /RAW_/); assert.match(view.instruction, /launch only, not a current status check/);
});
test("status projection preserves observation time and unknown liveness without raw PID/reason", () => {
  const view = retainedLongJobResult(status()); assert.equal(view.state, "running"); assert.equal(view.sessionAlive, null);
  assert.equal(view.updatedAt, "2026-01-01T00:00:01.000Z"); assert.match(view.instruction, /Previously observed status/);
  assert.doesNotMatch(JSON.stringify(view), /RAW_|"pid":/); assert.equal(Object.hasOwn(view, "pid"), false);
});
test("malformed launch identities, paths, booleans and revisions are not retained", () => {
  for (const change of [{ ok: false }, { jobId: "../escape" }, { toolName: "run_command" }, { background: 1 }, { deferredVerification: false }, { statusPath: "/private/secret" }, { stdoutPath: ".aginti/long-jobs/other-12345678/stdout.log" }, { goalRevision: "1" }, { projectMutationRevision: -1 }]) assert.equal(retainedLongJobResult({ ...launch(), ...change }), null);
});
test("status rejects noncanonical times, impossible exits, nonfinite bytes and coercible values", () => {
  for (const change of [{ state: "recovery_hold" }, { updatedAt: "2025-12-31T00:00:00.000Z" }, { createdAt: "2026-01-01" }, { attempt: "1" }, { sessionAlive: "false" }, { outputBytes: Infinity }, { outputBytes: -1 }, { outputExists: 1 }, { state: "completed", exitCode: 9 }, { verifyExitCode: 256 }]) assert.equal(retainedLongJobResult({ ...status(), ...change }), null);
});
test("proxy/accessor/thenable data is rejected without invoking hooks", () => {
  let reads = 0;
  const proxy = new Proxy(launch(), { get() { reads++; throw Error("trap"); }, ownKeys() { reads++; throw Error("trap"); } });
  const getter = Object.defineProperty(launch(), "extra", { enumerable: true, get() { reads++; throw Error("getter"); } });
  const thenable = Object.assign(launch(), { then() { reads++; } });
  for (const p of [proxy, getter, thenable]) assert.equal(retainedLongJobResult(p), null);
  assert.equal(reads, 0);
});
test("thinking-history repair retains a launch with missing reasoning as sanitized context", () => {
  const state = repair(frame(launch())); const [view] = proofs(state); assert.equal(view.jobId, "export-12345678");
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].role, "user"); assert.doesNotMatch(JSON.stringify(state), /RAW_/);
  assert.match(state.messages[0].content, /Arguments: \{\}/); assert.ok(JSON.stringify(state).length < 2000);
});
test("thinking-history repair retains observed status rather than inventing worker completion", () => {
  const [view] = proofs(repair(frame(status()))); assert.equal(view.state, "running"); assert.equal(view.exitCode, null); assert.equal(view.sessionAlive, null);
});
test("distinct job IDs and chronologically distinct status observations remain distinguishable", () => {
  const s1 = status(), s2 = { ...status(), state: "completed", exitCode: 0, outputExists: true, outputBytes: 6, updatedAt: "2026-01-01T00:00:02.000Z" };
  const state = repair([...frame(launch(), "a"), ...frame(launch("export-87654321"), "b"), ...frame(s1, "c"), ...frame(s2, "d")]);
  const views = proofs(state); assert.equal(views.length, 4); assert.equal(views.filter(v => v.toolName === "start_long_job").length, 2);
  assert.deepEqual(views.filter(v => v.toolName === "long_job_status").map(v => [v.state, v.updatedAt]), [["running", s1.updatedAt], ["completed", s2.updatedAt]]);
  const config = { provider: "deepseek", model: "deepseek-flash", goal: "Report the existing job receipts.", commandCwd: "/workspace", taskProfile: "code" };
  const narrowed = buildConstrainedRecoveryRequest({ ...state, goal: config.goal, meta: {} }, config, {}, 5, { ...config, verifiedCompletionPending: true });
  const compacted = proofs({ messages: narrowed.messages }); assert.equal(compacted.length, 3);
  assert.equal(compacted.filter(v => v.toolName === "start_long_job").length, 2); assert.equal(compacted.find(v => v.toolName === "long_job_status").state, "completed");
});
test("sanitized receipt retention is idempotent across repeated repairs", () => {
  const state = repair(frame(launch())); const first = JSON.stringify(state.messages);
  repairModelMessageHistory(state, { provider: "deepseek" }); assert.equal(JSON.stringify(state.messages), first);
});
test("unpaired, unsuccessful or malformed native replies never become confirmed history", () => {
  const pair = frame(launch());
  const mismatch = frame(status()); mismatch[0].tool_calls[0].function.name = "start_long_job";
  for (const messages of [[pair[0]], [pair[1]], mismatch, frame({ ...launch(), ok: false }), frame({ ...launch(), statusPath: "../foreign" })]) assert.equal(proofs(repair(messages)).length, 0);
});
test("retained presentation does not create current-goal dispatch authority", () => {
  const s = repair(frame(launch())); s.meta = { goalContract: { revision: 2, currentHash: "b".repeat(64), activeGoal: "Start the export in the background." } };
  assert.equal(launchOnlyHandoffReceipt(s), null); assert.equal(Object.hasOwn(s.meta, "deferredJobReceipts"), false);
});
test("complete native frames remain unchanged for OpenAI, LocalLLM and valid DeepSeek reasoning", () => {
  for (const provider of ["openai", "localllm", "deepseek"]) {
    const messages = frame(launch(), "native", provider === "deepseek" ? "Original reasoning." : undefined); const s = { messages: [...messages] };
    assert.equal(repairModelMessageHistory(s, { provider }).changed, false); assert.equal(s.messages[0], messages[0]); assert.equal(s.messages[1], messages[1]);
  }
});
test("short explicit information follow-ups are concrete despite a leading continuation", () => {
  for (const request of ["Continue the same task and show me the latest status.", "Continue the same task. Do not start another export; report the existing job receipt and its observed status.", "Continue the same task. Check all the latest results.", "Continue the same task. Verify every deliverable against the revised acceptance criteria.", "Continue the same task. Where can I check the result?", "继续这个任务。请告诉我现在的进度。", "继续这个任务。现在进展如何？", "同じ作業を続けてください。現在の状態を報告してください。"] ) {
    assert.equal(continuationAddsConcreteRequirement(request), true, request);
    assert.equal(isCompletedContinuationNoop({ preserveTaskBoundary: true, previousStatus: "completed" }, request, {}), false, request);
  }
});
test("bare continuation and passive/negative clauses still do not repeat completed work", () => {
  for (const request of ["Continue.", "Continue the same task.", "Resume the saved session.", "继续。", "同じ作業を続けてください。", "Continue the same task. The report is already complete.", "Continue the same task. Do not inspect anything else.", "Please continue and finish the same task from the retained state. Repair the canonical project in place, follow every documented requirement, verify every deliverable, and leave the folder tidy."]) {
    assert.equal(continuationAddsConcreteRequirement(request), false, request);
    assert.equal(isCompletedContinuationNoop({ preserveTaskBoundary: true, previousStatus: "completed" }, request, {}), true, request);
  }
});
