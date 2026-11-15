import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { recordProjectVerificationOutcome, nextStepRuntimeConfig, completionTaskContract, applyContinuationContractTransition } from "../src/agent-runner.js";
import { hasReadOnlyDiagnosticIntent, isReadOnlyDiagnosticGoal, isCurrentReadOnlyDiagnosticExecution, buildScsEvidenceLedger, evaluateScsEvidence, boundedNativeCommandCheckpointResult, nativeCommandVerificationDigest } from "../src/scs-evidence.js";
import { selectProgressiveTools } from "../src/progressive-tool-selection.js";

const command = "node --test check.mjs";
const goal = `Run \`${command}\` once and tell me the result. Do not repair anything or create or modify any file.`;
const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, request = goal) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-diagnostic-unit-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  await fs.writeFile(path.join(root, "check.mjs"), "// Immutable unit fixture; native execution is covered separately.\n");
  const startedAt = "2026-01-01T00:00:00.000Z";
  const state = { goal: request, commandCwd: root, messages: [], meta: { taskProfile: "code",
    goalContract: { version: 3, revision: 1, taskBoundaryRevision: 1, activeGoalRevision: 1, taskGoal: request, activeGoal: request, currentRequest: request,
      history: [{ revision: 1, kind: "initial", hash: hash(request), preview: request }], lifecycle: [] },
    activeExecutionContract: { revision: 1, refreshedAt: startedAt, startedMutationRevision: 0, requiresWorkspaceMutation: false, requiresFileMutation: false, requiredProjectCommands: [command] },
  } };
  const config = { goal: request, commandCwd: root, baseDir: root, taskProfile: "code", allowFileTools: true, allowShellTool: true };
  return { root, state, config, events: [] };
}
function observe(f, extra = {}) {
  const result = { toolName: "run_command", ok: false, args: { command }, exitCode: 1,
    stdout: "TAP version 13\nnot ok 1 - owned assertion\n# tests 1\n# pass 0\n# fail 1\n", stderr: "", ...extra };
  recordProjectVerificationOutcome(f.state, result, f.config);
  if (result.blocked || result.skipped) return result;
  const run = f.state.meta.projectVerification.commandRuns.at(-1);
  if (run && Number.isSafeInteger(result.exitCode)) {
    const resultJson = JSON.stringify(boundedNativeCommandCheckpointResult(result));
    const runSha256 = nativeCommandVerificationDigest(run);
    run.nativeResultCheckpoint = { schemaVersion: 2, toolCallId: "unit_diagnostic", taskHash: hash(f.state.meta.goalContract.taskGoal), runSha256, resultSha256: hash(resultJson), resultJson };
  }
  f.events.push({ type: "tool.completed", timestamp: new Date().toISOString(), data: result });
  return result;
}
function assess(f, events = f.events) {
  const contract = completionTaskContract(f.config, f.state);
  const ledger = buildScsEvidenceLedger({ state: f.state, contract, context: { events, taskProfile: "code", goal: f.state.goal, readOnlyDiagnostic: isCurrentReadOnlyDiagnosticExecution(f.state) } });
  return { contract, ledger, result: evaluateScsEvidence(contract, ledger), runtime: nextStepRuntimeConfig(f.config, f.state) };
}
test("closed failed diagnostic satisfies execution without becoming a passing test", async t => {
  const f = await fixture(t), result = observe(f), run = f.state.meta.projectVerification.commandRuns.at(-1);
  assert.equal(result.ok, false); assert.equal(run.ok, false); assert.equal(result.diagnosticExitCode, 1);
  assert.equal(run.diagnosticCommandObserved, true); assert.equal(f.state.meta.projectVerification.testRuns.at(-1).passed, false);
  const view = assess(f); assert.equal(view.result.ok, true, view.result.reason);
  assert.notEqual(view.runtime.requiredProjectCommandPending, true); assert.notEqual(view.runtime.testFailureRepairActive, true);
  assert.ok(view.ledger.items.some(i => i.category === "test" && i.diagnosticOnly === true && i.passed === false));
});
test("native checkpoint preserves failed observation when event presentation is absent", async t => {
  const f = await fixture(t); observe(f); const view = assess(f, []);
  assert.equal(view.result.ok, true, view.result.reason);
  assert.ok(view.ledger.items.some(i => i.source === "native-diagnostic-checkpoint" && i.diagnosticOnly));
  assert.equal(f.state.meta.projectVerification.testRuns.at(-1).passed, false);
});
test("ordinary passing evidence remains passing evidence", async t => {
  const f = await fixture(t); observe(f, { ok: true, exitCode: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n" });
  assert.equal(f.state.meta.projectVerification.testRuns.at(-1).passed, true);
  assert.equal(assess(f).result.ok, true);
});
for (const flag of ["blocked", "skipped", "timedOut", "cancelled", "aborted", "terminationUnproven"]) test(`${flag} is not a closed diagnostic outcome`, async t => {
  const f = await fixture(t), result = observe(f, { [flag]: true });
  assert.notEqual(result.diagnosticCommandObserved, true); assert.notEqual(assess(f).result.ok, true);
});
for (const value of [undefined, null, "1", -1, 256, NaN]) test(`invalid exit ${String(value)} cannot authorize a diagnostic result`, async t => {
  const f = await fixture(t); const result = observe(f, { exitCode: value }); assert.notEqual(result.diagnosticCommandObserved, true);
  assert.notEqual(assess(f).result.ok, true);
});
for (const signal of ["SIGTERM", 0, false]) test(`signal ${String(signal)} cannot authorize a diagnostic result`, async t => {
  const f = await fixture(t); assert.notEqual(observe(f, { signal }).diagnosticCommandObserved, true);
  assert.notEqual(assess(f).result.ok, true);
});
test("invalid test invocation is not observed test completion", async t => {
  const f = await fixture(t); const result = observe(f, { exitCode: 127, stdout: "", stderr: "node: command not found" });
  assert.notEqual(result.diagnosticCommandObserved, true); assert.notEqual(assess(f).result.ok, true);
});
for (const request of [
  `Read-only: run \`${command}\`. All tests must pass.`,
  `Read-only: run \`${command}\`; ensure the checks are green.`,
  `只读运行 \`${command}\`，必须保证检查全部通过。`,
  `只讀執行 \`${command}\`，確保檢查成功。`,
  `Read-onlyで \`${command}\` を実行し、チェックを必ず成功させてください。`,
  `読み取り専用で \`${command}\` を実行し、テストの合格が必要です。`,
]) test(`success requirement retains pass gate: ${request}`, async t => {
  assert.equal(isReadOnlyDiagnosticGoal(request, "code"), false);
  const f = await fixture(t, request); assert.notEqual(observe(f).diagnosticCommandObserved, true);
  assert.notEqual(assess(f).result.ok, true);
});
for (const request of [goal, "Read-only: inspect the failing tests. Should they pass? Do not change any files.", `只读运行 \`${command}\` 一次并报告实际结果，不要修改文件。`, `読み取り専用で \`${command}\` を実行し、観測した結果を報告してください。`]) test(`report-only classification: ${request}`, () => {
  assert.equal(isReadOnlyDiagnosticGoal(request, "code"), true);
});
test("same-task checkpoint retains the diagnostic execution epoch", async t => {
  const f = await fixture(t); observe(f); const change = applyContinuationContractTransition(f.state, "Please continue from where you stopped.");
  assert.equal(change.refreshExecutionContract, false); assert.equal(f.state.meta.goalContract.revision, 2);
  assert.equal(isCurrentReadOnlyDiagnosticExecution(f.state), true); const view = assess(f);
  assert.equal(view.result.ok, true, view.result.reason); assert.notEqual(view.runtime.requiredProjectCommandPending, true);
  assert.equal(assess(f, []).result.ok, true);
});
for (const change of ["missing-history", "duplicate", "task-hash", "active-hash", "refresh", "new-task-boundary"]) test(`unproven ${change} cannot inherit a diagnostic observation`, async t => {
  const f = await fixture(t); observe(f); applyContinuationContractTransition(f.state, "Please continue from where you stopped.");
  const goal = f.state.meta.goalContract, entry = goal.history.at(-1);
  if (change === "missing-history") goal.history.pop(); else if (change === "duplicate") goal.history.push({ ...entry });
  else if (change === "task-hash") entry.taskHash = "0".repeat(64); else if (change === "active-hash") entry.activeHash = "0".repeat(64);
  else if (change === "refresh") entry.refreshExecutionContract = true; else goal.taskBoundaryRevision = 2;
  assert.equal(isCurrentReadOnlyDiagnosticExecution(f.state), false); assert.notEqual(assess(f, []).result.ok, true);
});
test("explicit rerun requires new current evidence", async t => {
  const f = await fixture(t); observe(f);
  const change = applyContinuationContractTransition(f.state, `Continue the same task. Run \`${command}\` again and report the current result. Do not modify any files.`);
  assert.equal(change.refreshExecutionContract, true); assert.equal(f.state.meta.activeExecutionContract.revision, 2);
  assert.notEqual(assess(f).result.ok, true); assert.equal(assess(f).runtime.requiredProjectCommandPending, true);
  observe(f); assert.equal(assess(f).result.ok, true);
});
test("a later repair request cannot use a failed observation as passing evidence", async t => {
  const f = await fixture(t); observe(f);
  applyContinuationContractTransition(f.state, `Continue the same task. Fix check.mjs and run \`${command}\`; tests must pass.`);
  assert.equal(isCurrentReadOnlyDiagnosticExecution(f.state), false); assert.notEqual(assess(f).result.ok, true);
  assert.notEqual(assess(f, []).result.ok, true);
});
test("later material mutation invalidates a diagnostic-only outcome", async t => {
  const f = await fixture(t); observe(f); await fs.writeFile(f.root + "/check.mjs", "// Changed externally to the recorded test.\n");
  recordProjectVerificationOutcome(f.state, { toolName: "apply_patch", ok: true, path: "check.mjs", changes: [{ path: "check.mjs", beforeHash: hash("old"), afterHash: hash("new") }] }, f.config);
  assert.equal(isCurrentReadOnlyDiagnosticExecution(f.state), false); assert.notEqual(assess(f, []).result.ok, true);
});
for (const field of ["runSha256", "resultSha256", "taskHash", "resultJson"]) test(`checkpoint ${field} tamper cannot manufacture observation`, async t => {
  const f = await fixture(t); observe(f); const checkpoint = f.state.meta.projectVerification.commandRuns.at(-1).nativeResultCheckpoint;
  checkpoint[field] = field === "resultJson" ? "{}" : "0".repeat(64); assert.notEqual(assess(f, []).result.ok, true);
});

async function compound(t) {
  const second = "node --test other-check.mjs";
  const f = await fixture(t, `Run \`${command}\` once, then run \`${second}\` once and report both observed results. Do not repair anything or create or modify any file.`);
  f.state.meta.activeExecutionContract.requiredProjectCommands = [command, second];
  await fs.writeFile(f.root + "/other-check.mjs", "// Second diagnostic fixture.\n");
  observe(f, { ok: true, exitCode: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n" });
  observe(f, { args: { command: second } });
  return f;
}
test("mixed requested diagnostic outcomes preserve exact command continuity", async t => {
  const f = await compound(t), verification = f.state.meta.projectVerification;
  assert.equal(verification.mutationRevision, 1); assert.equal(isCurrentReadOnlyDiagnosticExecution(f.state), true);
  assert.equal(verification.commandRuns.at(-1).diagnosticCommandObserved, true);
  assert.equal(assess(f).result.ok, true); assert.equal(assess(f, []).result.ok, true);
  assert.equal(verification.testRuns.at(-1).passed, false);
});
for (const fault of ["paths", "unknown-tool", "missing-row", "duplicate-row", "task-hash", "missing-checkpoint", "run-digest", "result-digest"]) test(`compound diagnostic history rejects ${fault}`, async t => {
  const f = await compound(t), v = f.state.meta.projectVerification, row = v.mutationHistory[0], run = v.commandRuns[0];
  if (fault === "paths") row.paths = ["check.mjs"]; else if (fault === "unknown-tool") row.toolName = "apply_patch";
  else if (fault === "missing-row") v.mutationHistory = []; else if (fault === "duplicate-row") v.mutationHistory.push({ ...row });
  else if (fault === "task-hash") row.taskHash = "0".repeat(64); else if (fault === "missing-checkpoint") delete run.nativeResultCheckpoint;
  else if (fault === "run-digest") run.nativeResultCheckpoint.runSha256 = "0".repeat(64); else run.nativeResultCheckpoint.resultSha256 = "0".repeat(64);
  assert.equal(isCurrentReadOnlyDiagnosticExecution(f.state), false); assert.notEqual(assess(f, []).result.ok, true);
});
test("read-only diagnostic tool contract omits direct file writers", async t => {
  const f = await fixture(t); observe(f);
  const config = nextStepRuntimeConfig(f.config, f.state); assert.equal(config.readOnlyDiagnosticIntent, true);
  const tools = ["write_file", "apply_patch", "read_file", "finish"].map(name => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }));
  const selected = selectProgressiveTools(tools, { config, goal, profile: "code", messages: [] }).map(t => t.function.name);
  assert.ok(selected.includes("finish")); assert.ok(!selected.includes("write_file") && !selected.includes("apply_patch"));
});
test("new repair request clears stale diagnostic tool narrowing", async t => {
  const f = await fixture(t); observe(f);
  applyContinuationContractTransition(f.state, "Continue the same task. Fix check.mjs and verify the repair.");
  assert.equal(nextStepRuntimeConfig({ ...f.config, readOnlyDiagnosticIntent: true }, f.state).readOnlyDiagnosticIntent, false);
});
test("a required pass does not grant permission to write in a read-only task", () => {
  const request = `Read-only: run \`${command}\`; all tests must pass.`;
  assert.equal(hasReadOnlyDiagnosticIntent(request, "code"), true);
  assert.equal(isReadOnlyDiagnosticGoal(request, "code"), false);
});

function assessImplicit(f, events = f.events, context = {}, contract = completionTaskContract(f.config, f.state)) {
  const ledger = buildScsEvidenceLedger({ state: f.state, contract, context: { events, ...context } });
  return { ledger, result: evaluateScsEvidence(contract, ledger) };
}
for (const presentation of ["events", "checkpoint"]) test(`shared SCS ledger derives proven diagnostic scope from ${presentation}`, async t => {
  const f = await fixture(t); observe(f);
  const context = Object.freeze({ events: presentation === "events" ? f.events : [] });
  const contract = completionTaskContract(f.config, f.state);
  const ledger = buildScsEvidenceLedger({ state: f.state, contract, context });
  assert.equal(evaluateScsEvidence(contract, ledger).ok, true);
  assert.equal(Object.hasOwn(context, "readOnlyDiagnostic"), false);
  assert.ok(ledger.items.some(item => item.diagnosticOnly && item.passed === false));
  assert.equal(f.state.meta.projectVerification.testRuns.at(-1).passed, false);
});
test("an explicit diagnostic disable is preserved by the shared SCS ledger", async t => {
  const f = await fixture(t); observe(f); assert.equal(assessImplicit(f, f.events, { readOnlyDiagnostic: false }).result.ok, false);
});
test("implicit diagnostic scope needs the exact current runtime authority", async t => {
  const f = await fixture(t); observe(f); delete f.state.meta.activeExecutionContract;
  assert.equal(assessImplicit(f).result.ok, false);
});
test("implicit diagnostic scope cannot override a non-diagnostic contract", async t => {
  const f = await fixture(t); observe(f);
  const contract = { ...completionTaskContract(f.config, f.state), readOnlyDiagnostic: false };
  assert.equal(assessImplicit(f, f.events, {}, contract).result.ok, false);
});
test("implicit diagnostic scope rejects intervening edits", async t => {
  const f = await fixture(t); observe(f);
  recordProjectVerificationOutcome(f.state, { toolName: "apply_patch", ok: true, path: "check.mjs", changes: [{ path: "check.mjs", beforeHash: hash("old"), afterHash: hash("new") }] }, f.config);
  assert.equal(assessImplicit(f).result.ok, false);
});
test("implicit diagnostic scope preserves an explicit pass requirement", async t => {
  const f = await fixture(t, `Read-only: run \`${command}\`; all tests must pass.`); observe(f);
  assert.equal(assessImplicit(f).result.ok, false);
});
test("implicit diagnostic scope requires complete saved continuation lineage", async t => {
  const f = await fixture(t); observe(f); applyContinuationContractTransition(f.state, "Please continue from where you stopped.");
  assert.equal(assessImplicit(f, []).result.ok, true);
  delete f.state.meta.goalContract.history.at(-1).taskHash;
  assert.equal(assessImplicit(f, []).result.ok, false);
});

for (const request of [
  "Why did the last check fail? Did you change any file? Do not rerun it or modify any file.",
  "Why did the last check fail? Did you modify any file? Do not rerun it or modify any file.",
  "刚才为什么失败？有没有改动检查文件？不要重跑，也不要修改文件。",
  "先ほどのチェックはなぜ失敗しましたか？ファイルを変更しましたか？再実行せず、読み取り専用で答えてください。",
]) test(`historical diagnostic explanation does not invent fresh work: ${request}`, async t => {
  const f = await fixture(t, request), contract = completionTaskContract(f.config, f.state);
  assert.equal(contract.requiresExternalEvidence, false); assert.equal(contract.requiresWorkspaceMutation, false);
  assert.equal(contract.requiresFileMutation, false); assert.equal(contract.readOnlyDiagnostic, true);
  assert.deepEqual(contract.requiredProjectCommands, []); assert.deepEqual(contract.exactOutputPaths, []);
  assert.equal(contract.outcome, "Active task: " + request); assert.equal(nextStepRuntimeConfig(f.config, f.state).readOnlyDiagnosticIntent, true);
});
for (const request of [
  `Why did the last check fail? Run \`${command}\` again. Do not modify any file.`,
  "Why did the last check fail? Inspect check.mjs and identify the current bug. Do not modify any file.",
  "Why did the last check fail? Create diagnosis.md. Do not modify check.mjs.",
  "Why did the last check fail? Research the latest upstream fix. Read-only.",
  `刚才为什么失败？现在重新运行 \`${command}\`。不要修改文件。`,
  "刚才为什么失败？请查看 check.mjs 的当前内容。不要修改文件。",
  "先ほどのチェックはなぜ失敗しましたか？今チェックを実行してください。読み取り専用で答えてください。",
  "What is the current status of check.mjs? Do not modify any file.",
  `Why did the last check fail, run \`${command}\` again? Do not modify any file.`,
  "Why did the last check fail fix check.mjs until tests pass? Do not modify unrelated files.",
  "What happened to the last check, push the branch? Do not modify any file.",
  "What happened with the last check save summary.md? Do not modify any file.",
]) test(`historical wording cannot erase a current action: ${request}`, async t => {
  const f = await fixture(t, request), contract = completionTaskContract(f.config, f.state);
  assert.equal(contract.requiresExternalEvidence, true);
});
test("a historical question cannot erase retained unfinished task requirements", async t => {
  const f = await fixture(t, "Why did the last check fail? Do not rerun it or modify any file.");
  f.state.meta.goalContract.taskGoal = "Create report.md with the observed results.";
  const contract = completionTaskContract(f.config, f.state);
  assert.equal(contract.requiresExternalEvidence, true); assert.ok(contract.exactOutputPaths.includes("report.md"));
});

for (const request of [
  "Why did the last check fail and ensure tests pass? Do not modify any file.",
  "Why did the last check fail and guarantee tests pass? Do not modify any file.",
  "Why did the last check fail and get the tests to pass? Do not modify any file.",
  "Why did the last check fail and tests must pass? Do not modify any file.",
  "Why did the last check fail? Did you modify any file and ensure tests pass? Do not modify any file.",
  "Why did the last check fail? Did you change any file, then check the current tests? Do not modify any file.",
  "刚才为什么失败？必须保证检查全部通过。不要修改文件。",
  "先ほどのチェックはなぜ失敗しましたか？テストは必ず合格してください。読み取り専用で答えてください。",
]) test(`mixed historical question preserves fresh evidence obligations: ${request}`, async t => {
  const f = await fixture(t, request), contract = completionTaskContract(f.config, f.state);
  assert.equal(contract.requiresExternalEvidence, true);
  if (!request.includes("then check the current tests")) {
    assert.equal(contract.readOnlyDiagnostic, false);
    assert.ok(contract.requiredEvidence.some(item => item.category === "test"));
  }
});
