import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createHash } from "node:crypto";
import { recordProjectVerificationOutcome, projectTestVerificationFinishBlock, toolResultForModel, reconcileLegacyCommandMutationEvidence, buildKnownReadOnlyAnswerPhasePlan } from "../src/agent-runner.js";
import { buildScsEvidenceLedger, deriveScsTaskContract, nativeCommandVerificationDigest, boundedNativeCommandCheckpointResult, isHistoricalDiagnosticQuestion } from "../src/scs-evidence.js";
import { createCommandMutationEvidence, readCommandMutationEvidence, commandMutationEvidenceForPresentation, testCommandSequenceIsCurrent, commandVerificationSequenceState } from "../src/command-mutation-evidence.js";
import { nativeCapabilityPolicyContext } from "../src/native-tool-context.js";

for (const goal of [
  "From the saved results, what is verified and what is not established about file changes? Please do not rerun anything or change files.",
  "Using the recorded output, summarize the outcomes and limitations. Do not rerun anything.",
  "Based on the previous results, explain what we know and what remains unknown. Do not change files.",
  "From retained evidence, what was observed and what was not confirmed? Answer here only.",
  "根据已保存的结果，哪些已验证，哪些尚未确定？不要重新运行或修改文件。",
  "根据记录的输出，总结结果与局限。只读回答。",
  "保存済みの結果から、何が検証され、何が不明ですか？再実行せず、読み取り専用で答えてください。",
  "記録済みの出力に基づいて、結果と限界を要約してください。",
]) test(`saved-result questions require an answer, not fresh proof: ${goal}`, () => {
  assert.equal(isHistoricalDiagnosticQuestion(goal), true);
  const contract = deriveScsTaskContract({ goal });
  assert.equal(contract.readOnlyDiagnostic, true);
  assert.equal(contract.requiresExternalEvidence, false);
  assert.deepEqual(contract.requiredEvidence, []);
  assert.deepEqual(contract.requiredProjectCommands, []);
  assert.equal(contract.requiresWorkspaceMutation, false);
  assert.equal(contract.requiresFileMutation, false);
  assert.ok(buildKnownReadOnlyAnswerPhasePlan({ goal, taskProfile: "auto" }, { goal, meta: {} }));
  assert.equal(buildScsEvidenceLedger({ state: { goal, meta: {} }, contract, context: { events: [] } }).items.length, 0,
    "historical question classification must never manufacture current evidence");
});

for (const goal of [
  "From the saved results, summarize the outcomes and run `node --test test/cache.test.mjs` now.",
  "From the saved results, what is verified? Then read cache/state.json.",
  "From the saved results, summarize the outcomes. Also inspect the current worktree.",
  "From the saved results, summarize the outcomes; search for new sources.",
  "From the saved results, summarize the outcomes and create report.pdf.",
  "From the saved results, summarize the outcomes, but verify the current state first.",
  "From the saved results, summarize the outcomes. Ensure all tests pass.",
  "From the saved results, write the outcomes to report.md.",
  "From the saved results, what is verified and install any needed packages?",
  "The note says 'From the saved results, what is verified?' Run `node --test test/cache.test.mjs`.",
  'Explain the quote "From the saved results, summarize the outcomes" and inspect cache/state.json.',
  "From the saved results, what is verified? Do not change files; run `node --test test/cache.test.mjs`.",
  "From the saved results, what is verified? Do not rerun anything, but read cache/state.json.",
  "From the saved results, summarize the outcomes. Do not change files and run `node --test test/cache.test.mjs`.",
  "根据已保存的结果，总结结果。不要修改文件，但读取当前文件。",
  "保存済みの結果から、何が不明ですか？再実行せず、現在のファイルを確認してください。",
  "根据已保存的结果，总结结果。然后运行测试。",
  "根据记录的输出，总结结果与局限，并读取当前文件。",
  "保存済みの結果から、何が不明ですか？現在のファイルを確認してください。",
  "記録済みの出力に基づいて、結果と限界を要約して新しい資料を検索してください。",
]) test(`mixed or quoted saved-result wording preserves ordinary gates: ${goal}`, () => {
  assert.equal(isHistoricalDiagnosticQuestion(goal), false);
  assert.equal(buildKnownReadOnlyAnswerPhasePlan({ goal, taskProfile: "auto" }, { goal, meta: {} }), null);
  const contract = deriveScsTaskContract({ goal });
  // Ordinary inference does not yet require tools for every natural-language
  // inspection/search phrase. This repair must not select the historical-only
  // workflow for any of them; recognized commands/artifacts keep their gates.
  if (!goal.includes("Do not change files and run") && /node --test|report\.(?:pdf|md)|install|Ensure all tests|读取当前|現在のファイル/iu.test(goal)) {
    assert.ok(contract.requiresExternalEvidence || contract.requiresWorkspaceMutation || contract.requiresSourceGrounding);
  }
});

test("an old revision counter cannot be presented as a file write or unchanged-workspace proof", () => {
  const input = { toolName: "run_command", ok: true, projectMutationRevision: 7, mutationObservationComplete: true };
  const view = toolResultForModel(input);
  assert.equal(view.mutationObservationComplete, false);
  assert.equal(view.commandMutationEvidence?.scope, "legacy-unspecified");
  assert.equal(view.commandMutationEvidence?.workspaceUnchanged, "not-proven");
  assert.equal(view.commandMutationEvidence?.revisionMeaning, "verification-invalidation-only");
  assert.equal(input.mutationObservationComplete, true, "presentation must not rewrite historical authority");
});

for (const outcome of ["failed", "timed-out", "unproven-termination", "partial-claimed-complete"]) for (const frozenClock of [false, true]) {
  test(`a later unobserved ${outcome} command invalidates a prior pass without inventing source progress: clock=${frozenClock}`, async t => {
    if (frozenClock) t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-observation-unit-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "test")); await fs.mkdir(path.join(root, "tools"));
    await fs.writeFile(path.join(root, "test/cache.test.mjs"), "// isolated verification fixture\n");
    await fs.writeFile(path.join(root, "tools/refresh-cache.mjs"), "// isolated mutation-capable fixture\n");
    const goal = "Repair the cached calculation and verify correctness with `node --test test/cache.test.mjs`.";
    const state = { goal, commandCwd: root, messages: [], meta: { taskProfile: "code", goalContract: { revision: 1, taskBoundaryRevision: 1, activeGoalRevision: 1, activeGoal: goal, taskGoal: goal },
      activeExecutionContract: { revision: 1, startedMutationRevision: 0, requiresWorkspaceMutation: true, requiresFileMutation: true } } };
    const config = { goal, taskProfile: "code", commandCwd: root, baseDir: root, sandboxMode: "host", allowShellTool: true };
    const pass = () => ({ toolName: "run_command", ok: true, exitCode: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n", stderr: "", args: { command: "node --test test/cache.test.mjs" } });
    const first = pass(); recordProjectVerificationOutcome(state, first, config);
    const checkpoint = result => {
      const run = state.meta.projectVerification.commandRuns.find(r => r.commandSequence === result.commandSequence);
      const hash = text => createHash("sha256").update(text).digest("hex");
      const resultJson = JSON.stringify(boundedNativeCommandCheckpointResult(result));
      run.nativeResultCheckpoint = { schemaVersion: 2, toolCallId: "unit_" + result.commandSequence, taskHash: hash(goal), runSha256: nativeCommandVerificationDigest(run), resultSha256: hash(resultJson), resultJson };
    };
    checkpoint(first);
    assert.equal(first.projectTest?.passed, true); assert.equal(projectTestVerificationFinishBlock(state, "The tests pass."), null);
    const before = state.meta.projectVerification.mutationRevision;
    const uncertain = { toolName: "run_command", ok: false, exitCode: ["failed", "partial-claimed-complete"].includes(outcome) ? 2 : null, stdout: "", stderr: "worker interrupted", args: { command: "node tools/refresh-cache.mjs" },
      mutationObservationScope: "git-status", mutationObservationComplete: outcome === "partial-claimed-complete",
      ...(outcome === "timed-out" ? { timedOut: true } : outcome === "unproven-termination" ? { terminationUnproven: true } : {}) };
    recordProjectVerificationOutcome(state, uncertain, config);
    assert.equal(state.meta.projectVerification.mutationRevision, before, "uncertain failure is not source-edit proof");
    assert.ok(projectTestVerificationFinishBlock(state, "The tests pass."), "a later possible write must invalidate the old pass");
    assert.ok(state.meta.projectVerification.latestPotentialCommandMutationSequence > first.projectTest.commandSequence);
    const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
    const ledger = buildScsEvidenceLedger({ state, contract, context: { events: [{ type: "tool.completed", data: first }] } });
    assert.equal(ledger.items.some(i => i.category === "test" && i.verified !== false), false, "SCS must share the freshness decision");
    const fresh = pass(); recordProjectVerificationOutcome(state, fresh, config);
    checkpoint(fresh);
    assert.equal(projectTestVerificationFinishBlock(state, "The tests pass."), null, "new genuine verification restores freshness");
    assert.ok(fresh.projectTest.commandSequence > uncertain.commandSequence);
    if (frozenClock) assert.equal(first.projectTest.at, fresh.projectTest.at, "sequence, not wall clock, governs freshness");
    const reloaded = JSON.parse(JSON.stringify(state));
    const replay = buildScsEvidenceLedger({ state: reloaded, contract, context: { events: [] } });
    assert.ok(replay.items.some(i => i.category === "test" && i.verified !== false && i.commandSequence === fresh.commandSequence), "restart replay must retain the new pass, not deduplicate it with the stale one");
  });
}

for (const key of ["blocked", "skipped"]) test(`${key} commands cannot invalidate an existing receipt`, () => {
  const verification = { mutationRevision: 4, commandSequence: 3, latestPotentialCommandMutationSequence: 2 };
  const state = { meta: { projectVerification: structuredClone(verification) } };
  recordProjectVerificationOutcome(state, { toolName: "run_command", [key]: true, ok: false, args: { command: "node tools/refresh-cache.mjs" } });
  assert.deepEqual(state.meta.projectVerification, verification);
});

for (const [name, change] of [
  ["null", v => { v.commandSequence = null; }], ["undefined", v => { v.commandSequence = undefined; }],
  ["coerced", v => { v.commandSequence = "2"; }], ["negative", v => { v.commandSequence = -1; }],
  ["overflow", v => { v.commandSequence = Number.MAX_SAFE_INTEGER; }], ["future-fence", v => { v.latestPotentialCommandMutationSequence = 3; }],
  ["null-fence", v => { v.latestPotentialCommandMutationSequence = null; }], ["missing-counter", v => { delete v.commandSequence; }],
  ["future-run", v => { v.commandRuns[0].commandSequence = 3; }], ["sparse-runs", v => { v.commandRuns.length = 2; }],
]) test(`corrupt ${name} sequence state fails closed before execution`, () => {
  const v = { commandSequence: 2, latestPotentialCommandMutationSequence: 1, commandRuns: [{ commandSequence: 1 }], testRuns: [{ commandSequence: 1 }] };
  change(v); assert.throws(() => commandVerificationSequenceState(v), { code: "COMMAND_VERIFICATION_SEQUENCE_INVALID" });
});

test("sequence preflight rejects proxies and descriptors without traps", () => {
  let calls = 0;
  const proxy = new Proxy({}, { get() { calls++; throw Error("get"); }, getPrototypeOf() { calls++; throw Error("prototype"); }, getOwnPropertyDescriptor() { calls++; throw Error("descriptor"); } });
  for (const v of [proxy, { commandSequence: 2, commandRuns: [proxy] }, Object.defineProperty({}, "commandSequence", { enumerable: true, get() { calls++; return 0; } })]) {
    assert.throws(() => commandVerificationSequenceState(v), { code: "COMMAND_VERIFICATION_SEQUENCE_INVALID" });
  }
  assert.equal(calls, 0);
});

for (const legacy of [false, true]) test(`a freshness fence invalidates a pass without hiding failure diagnostics: legacy=${legacy}`, () => {
  const command = "node --test test/cache.test.mjs";
  const failed = { command, at: "2026-01-01T00:00:00.000Z", ok: false, passed: false, mutationRevision: 4, privateMutationRevision: 0,
    failureSignature: "retained-failure", failureSummary: "The generated content is missing a required result", ...(!legacy ? { commandSequence: 1 } : {}) };
  const state = { goal: "Repair the generated report and verify it.", meta: { goalContract: { revision: 1 },
    projectVerification: { mutationRevision: 4, privateMutationRevision: 0, commandSequence: 3, latestPotentialCommandMutationSequence: 3, testRuns: [failed] } } };
  const block = projectTestVerificationFinishBlock(state, "The tests pass.");
  assert.equal(block.category, "project-test-current-failure", "a negative observation must remain available to repair, not be downgraded to missing/stale evidence");
  assert.equal(block.failureSignature, "retained-failure");
  state.meta.projectVerification.testRuns.push({ ...failed, commandSequence: 3, ok: true, passed: true });
  assert.equal(projectTestVerificationFinishBlock(state, "The tests pass."), null, "only new genuine verification can replace that failure");
});

for (const scope of ["git-status", "declared-outputs", "git-status-and-declared-outputs", "unavailable", "not-requested"]) {
  test(`closed mutation metadata retains truthful coverage: ${scope}`, () => {
    for (const [revisionAdvanced, observedPathCount, verificationInvalidated] of [[true, 0, true], [false, 0, true], [false, 0, false], [true, 2, true], [false, 2, false]]) {
      const evidence = createCommandMutationEvidence({ scope, revisionAdvanced, observedPathCount, verificationInvalidated });
      const clone = readCommandMutationEvidence(JSON.parse(JSON.stringify(evidence)));
      assert.deepEqual(clone, evidence); assert.notEqual(clone, evidence); assert.ok(Object.isFrozen(clone));
      assert.equal(clone.workspaceUnchanged, "not-proven");
    }
  });
}

for (const attack of ["proxy", "accessor", "hidden", "symbol", "extra", "prototype", "thenable", "coercible"]) test(`mutation metadata rejects ${attack} without invoking user code`, () => {
  let traps = 0;
  const input = { scope: "git-status", revisionAdvanced: false, observedPathCount: 0, verificationInvalidated: false };
  let candidate = input;
  if (attack === "proxy") candidate = new Proxy(input, { get() { traps++; throw Error("get"); }, ownKeys() { traps++; throw Error("keys"); }, getPrototypeOf() { traps++; throw Error("proto"); } });
  if (attack === "accessor") Object.defineProperty(input, "scope", { enumerable: true, get() { traps++; return "git-status"; } });
  if (attack === "hidden") Object.defineProperty(input, "scope", { value: "git-status", enumerable: false });
  if (attack === "symbol") input[Symbol("hidden")] = true;
  if (attack === "extra") input.extra = true;
  if (attack === "prototype") Object.setPrototypeOf(input, { get then() { traps++; throw Error("then"); } });
  if (attack === "thenable") Object.defineProperty(input, "then", { enumerable: true, get() { traps++; throw Error("then"); } });
  if (attack === "coercible") input.observedPathCount = { valueOf() { traps++; return 0; } };
  assert.throws(() => createCommandMutationEvidence(candidate), { code: "COMMAND_MUTATION_EVIDENCE_INVALID" }); assert.equal(traps, 0);
  assert.equal(readCommandMutationEvidence(candidate), null); assert.equal(traps, 0);
});

for (const field of ["schemaVersion", "scope", "coverage", "revisionMeaning", "revisionAdvanced", "revisionBasis", "observedPathCount", "workspaceUnchanged"]) test(`malformed persisted ${field} cannot gain observation authority`, () => {
  const evidence = createCommandMutationEvidence({ scope: "git-status", revisionAdvanced: true, observedPathCount: 0, verificationInvalidated: true });
  const bad = { ...evidence, [field]: "invalid" };
  assert.equal(readCommandMutationEvidence(bad), null);
  assert.equal(commandMutationEvidenceForPresentation(bad).scope, "legacy-unspecified");
});

test("legacy receipts stay conservative and do not invent command order", () => {
  assert.equal(testCommandSequenceIsCurrent({}, {}), true);
  assert.equal(testCommandSequenceIsCurrent({}, { commandSequence: 4, latestPotentialCommandMutationSequence: 3 }), false);
  assert.equal(testCommandSequenceIsCurrent({ commandSequence: 2 }, { commandSequence: 4, latestPotentialCommandMutationSequence: 3 }), false);
  assert.equal(testCommandSequenceIsCurrent({ commandSequence: 5 }, { commandSequence: 4, latestPotentialCommandMutationSequence: 3 }), false);
  assert.equal(testCommandSequenceIsCurrent({ commandSequence: 4 }, { commandSequence: 4, latestPotentialCommandMutationSequence: 3 }), true);
});

test("current native tool context explains counters on resume without granting shell", () => {
  assert.match(nativeCapabilityPolicyContext({ allowShellTool: true }), /verification-invalidation counters, not evidence that a file was written/);
  assert.doesNotMatch(nativeCapabilityPolicyContext({ allowShellTool: false }), /verification-invalidation counters/);
});

for (const mode of ["after", "before", "readonly-after", "missing-history", "modern"]) test(`legacy observation upgrade preserves receipts and avoids blind replay: ${mode}`, () => {
  const goal = "Repair the cached calculation and verify it.";
  // Explicitly simulated old metadata, not an observed historical session.
  const passed = { command: "node --test test/cache.test.mjs", at: "2026-01-01T00:00:00.000Z", ok: true, passed: true, mutationRevision: 0, privateMutationRevision: 0 };
  const opaque = { command: mode === "readonly-after" ? "node --version" : "node tools/refresh-cache.mjs", at: passed.at, ok: true, mutationRevision: 0, privateMutationRevision: 0 };
  const testRun = { ...passed }; delete testRun.passed;
  const runs = mode === "before" ? [opaque, testRun] : mode === "missing-history" ? [] : [testRun, opaque];
  const state = { goal, meta: { goalContract: { revision: 1, taskGoal: goal, currentRequest: "Please continue from the saved checkpoint." }, projectVerification: { mutationRevision: 0, privateMutationRevision: 0, testRuns: [passed], commandRuns: runs } } };
  if (mode === "modern") { state.meta.projectVerification.commandSequence = 2; state.meta.projectVerification.latestPotentialCommandMutationSequence = 2; passed.commandSequence = 1; testRun.commandSequence = 1; opaque.commandSequence = 2; }
  const beforeRuns = JSON.stringify(runs), review = reconcileLegacyCommandMutationEvidence(state, {});
  assert.equal(JSON.stringify(runs), beforeRuns, "upgrade must never fabricate or rewrite old command receipts");
  if (["after", "missing-history"].includes(mode)) {
    assert.equal(review.reason, "legacy-command-mutation-coverage");
    assert.equal(state.meta.projectVerification.mutationRevision, 0);
    assert.ok(state.meta.projectVerification.latestPotentialCommandMutationSequence > 0);
    const snapshot = JSON.stringify(state);
    assert.deepEqual(reconcileLegacyCommandMutationEvidence(state, {}), review); assert.equal(JSON.stringify(state), snapshot, "repeated review is idempotent");
    assert.ok(projectTestVerificationFinishBlock(state, "The tests pass."));
  } else assert.equal(review, null);
});
