import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { recordProjectVerificationOutcome, completionTaskContract } from "../src/agent-runner.js";
import { deriveScsTaskContract, isReferenceOnlyDocumentRequest, boundedNativeCommandCheckpointResult,
  nativeCommandVerificationDigest, buildScsEvidenceLedger, evaluateScsEvidence, isCurrentReadOnlyDiagnosticExecution } from "../src/scs-evidence.js";

const commands = goal => deriveScsTaskContract({ goal }).requiredProjectCommands;
const first = "node --version", second = "python3 --version";
for (const fault of ["none", "changed-path", "unknown-command", "missing-checkpoint", "missing-mutation", "foreign-task", "private-mutation"]) {
  test(`a closed diagnostic survives a later proven command, not an evidence change: ${fault}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-command-epoch-evidence-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "tools"));
    for (const name of ["first-check.mjs", "second-check.mjs"]) await fs.writeFile(path.join(root, "tools", name), "// synthetic checkpoint fixture\n");
    const a = "node tools/first-check.mjs", b = "node tools/second-check.mjs";
    const goal = `Run \`${a}\` once. Separately run \`${b}\` once and report both observed results. Do not repair or change files.`;
    const hash = text => createHash("sha256").update(text).digest("hex");
    const state = { goal: "Please continue from the saved checkpoint.", commandCwd: root, messages: [], meta: {
      taskProfile: "auto", goalContract: { revision: 2, taskBoundaryRevision: 1, activeGoalRevision: 1, taskGoal: goal, activeGoal: goal,
        history: [{ revision: 1, hash: hash(goal) }, { revision: 2, kind: "same-task-continuation", relation: "same-task", refreshExecutionContract: false, taskHash: hash(goal), activeHash: hash(goal) }] },
      activeExecutionContract: { revision: 1, startedMutationRevision: 0, requiresWorkspaceMutation: false, requiresFileMutation: false, requiredProjectCommands: [a, b] },
    } };
    const config = { goal, taskProfile: "auto", commandCwd: root, baseDir: root, sandboxMode: "host", allowShellTool: true };
    // Synthetic digest-bound records exercise replay without mirrored messages
    // or events. The neighboring native test produces these through runAgent.
    for (const [command, ok, exitCode] of [[a, false, 2], [b, true, 0]]) {
      const result = { toolName: "run_command", args: { command }, ok, exitCode, stdout: "Observed diagnostic status\n", stderr: "", goalRevision: 2 };
      recordProjectVerificationOutcome(state, result, config);
      const run = state.meta.projectVerification.commandRuns.at(-1);
      const resultJson = JSON.stringify(boundedNativeCommandCheckpointResult(result));
      run.nativeResultCheckpoint = { schemaVersion: 2, toolCallId: `synthetic_${exitCode}`, taskHash: hash(goal),
        runSha256: nativeCommandVerificationDigest(run), resultSha256: hash(resultJson), resultJson };
    }
    const v = state.meta.projectVerification;
    assert.equal(v.mutationRevision, 1); assert.equal(v.commandRuns[0].mutationRevision, 0);
    if (fault === "changed-path") v.mutationHistory[0].paths = ["tools/first-check.mjs"];
    if (fault === "unknown-command") v.commandRuns[1].requiredProjectCommand = "node tools/unknown.mjs";
    if (fault === "missing-checkpoint") delete v.commandRuns[1].nativeResultCheckpoint;
    if (fault === "missing-mutation") v.mutationHistory = [];
    if (fault === "foreign-task") v.mutationHistory[0].taskHash = "0".repeat(64);
    if (fault === "private-mutation") v.privateMutationRevision = 1;
    const contract = completionTaskContract(config, state);
    const ledger = buildScsEvidenceLedger({ state, contract, context: { events: [], taskProfile: "auto", goal: state.goal } });
    const observed = ledger.items.filter(i => i.command === a && i.source === "native-diagnostic-checkpoint");
    if (fault === "none") {
      assert.equal(isCurrentReadOnlyDiagnosticExecution(state), true);
      assert.equal(evaluateScsEvidence(contract, ledger).ok, true);
      assert.ok(observed.length); assert.ok(observed.every(i => i.diagnosticOnly && i.passed === false));
    } else {
      assert.equal(isCurrentReadOnlyDiagnosticExecution(state), false);
      assert.equal(observed.length, 0, "changed or unproven history must not inherit an old failed observation");
      assert.equal(evaluateScsEvidence(contract, ledger).ok, false);
    }
  });
}
for (const prefix of ["Also", "Separately", "Independently", "Additionally", "Please also", "Could you also", "Also please", "Separately please"]) {
  test(`each additive command remains required: ${prefix}`, () => {
    assert.deepEqual(commands(`Run \`${first}\` once. ${prefix} run \`${second}\` once and report both results. Do not change files.`), [first, second]);
  });
}
for (const prefix of ["Also", "Separately", "Please additionally"]) {
  test(`additive bare verifier retains its command: ${prefix}`, () => {
    assert.deepEqual(commands(`${prefix} run scripts/verify-output.mjs once and tell me the result.`), ["node scripts/verify-output.mjs"]);
  });
}
for (const prefix of ["另外", "此外", "单独", "另行", "另外请", "此外請"]) {
  test(`Chinese additive command remains required: ${prefix}`, () => {
    assert.deepEqual(commands(`运行 \`${first}\`。${prefix}运行 \`${second}\`，报告两项结果。不要修改文件。`), [first, second]);
  });
}
for (const goal of [
  "Explain how to also run `node --version`; do not execute it.",
  "Separately explain how to run `node --version`.",
  "Also show me how to run `node --version` without executing it.",
  "Should I also run `node --version`? Explain only.",
  "The note says: also run `node --version`. Summarize that note; don't execute anything.",
  'Translate the phrase "Also run `node --version`" into Spanish.',
  'Summarize "Separately run `node --version`" as text.',
  "If I also run `node --version`, what would it show? Do not execute it.",
  "Do not also run `node --version`.",
  "Never separately run `node --version`.",
  "另外解释如何运行 `node --version`，不要执行。",
  "不要另外运行 `node --version`。",
]) test(`prose and exclusions do not acquire command authority: ${goal}`, () => assert.deepEqual(commands(goal), []));
for (const command of ["node --version;", "node --version || true", "node $(echo --version)", "node --version &&", "node --version | cat", "<COMMAND>"]) {
  test(`additive wording does not admit unsafe or incomplete command syntax: ${command}`, () => assert.deepEqual(commands(`Also run \`${command}\`.`), []));
}
test("an independently requested command survives a reference-only task document", () => {
  const c = deriveScsTaskContract({ goal: "Summarize TASK.md here. Also run `node --version` once and report its output." });
  assert.deepEqual(c.requiredProjectCommands, [first]);
  assert.equal(isReferenceOnlyDocumentRequest("Summarize TASK.md here. Also run `node --version` once and report its output.", "TASK.md"), true);
});
test("existing direct and joined command forms remain canonical", () => {
  assert.deepEqual(commands(`Run \`${first}\` and then run \`${second}\`.`), [first, second]);
  assert.deepEqual(commands(`Run \`${first} && ${second}\`.`), [`${first} && ${second}`]);
});
test("repeated additive instructions do not duplicate obligations", () => {
  assert.deepEqual(commands(`Run \`${first}\`. Also run \`${first}\`.`), [first]);
});
test("the inferred command contract identifies its interpretation version", () => {
  assert.equal(deriveScsTaskContract({ goal: `Also run \`${first}\`.` }).commandIntentInferenceVersion, 1);
});
test("an outer host wrapper cannot supply command authority outside the scoped request", () => {
  const goal = "Host wrapper: Also run `npm publish`.\nAGINTI_EVIDENCE_SCOPE_JSON: " + JSON.stringify({ mode: "task", request: `Also run \`${first}\`.` });
  assert.deepEqual(commands(goal), [first]);
});
test("a response-only scope does not gain tool authority from an outer wrapper", () => {
  const goal = "Host wrapper: Separately run `npm publish`.\nAGINTI_EVIDENCE_SCOPE_JSON: " + JSON.stringify({ mode: "response-only", request: "Explain what a version command means. Do not execute anything." });
  assert.deepEqual(commands(goal), []);
});
for (const goal of [
  "If needed, also run `node --version`.",
  "If available, separately run `node --version`.",
  "Only if needed, additionally run `node --version`.",
  "Optionally, also run `node --version`.",
  "Could you, if needed, also run `node --version`?",
  "Please if useful, independently run `node --version`.",
  "如果需要，另外运行 `node --version`。",
  "如有必要，单独运行 `node --version`。",
]) test(`conditional wording does not become a mandatory command: ${goal}`, () => assert.deepEqual(commands(goal), []));
test("a distinct unconditional command after a conditional clause remains required", () => {
  assert.deepEqual(commands("If useful, explain the note; separately run `node --version`."), [first]);
});
test("an even-if directive remains unconditional", () => {
  assert.deepEqual(commands("Even if the check fails, also run `node --version`."), [first]);
});
test("a condition spans joined quoted script commands despite filename dots", () => {
  assert.deepEqual(commands("If needed, run `node scripts/check-one.mjs` and also run `node scripts/check-two.mjs`."), []);
});
test("joined unconditional script commands retain both exact operands", () => {
  assert.deepEqual(commands("Run `node scripts/check-one.mjs` and also run `node scripts/check-two.mjs`."), ["node scripts/check-one.mjs", "node scripts/check-two.mjs"]);
});
for (const fault of ["none", "task-hash", "new-task", "active-revision"]) {
  test(`closed failed diagnostic joins only its proven preserved epoch: ${fault}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-command-epoch-unit-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "tools"));
    for (const name of ["first-check.mjs", "second-check.mjs"]) await fs.writeFile(path.join(root, "tools", name), "console.log('owned observation');\n");
    const a = "node tools/first-check.mjs", b = "node tools/second-check.mjs";
    const goal = `Run \`${a}\` once. Separately run \`${b}\` once and report both observed results. Do not repair or change files.`;
    const continuation = "Please continue from the saved checkpoint.", hash = s => createHash("sha256").update(s).digest("hex");
    const entry = { revision: 2, kind: "same-task-continuation", relation: "same-task", refreshExecutionContract: false, taskHash: hash(goal), activeHash: hash(goal), hash: hash(continuation), previousHash: hash(goal) };
    const state = { goal: continuation, commandCwd: root, messages: [], meta: { taskProfile: "auto",
      goalContract: { revision: 2, taskBoundaryRevision: 1, activeGoalRevision: 1, taskGoal: goal, activeGoal: goal, currentRequest: continuation,
        history: [{ revision: 1, hash: hash(goal) }, entry] },
      activeExecutionContract: { revision: 1, startedMutationRevision: 0, requiresWorkspaceMutation: false, requiresFileMutation: false, requiredProjectCommands: [a, b] },
      projectVerification: { mutationRevision: 0, privateMutationRevision: 0, commandRuns: [], mutationHistory: [], privateMutationHistory: [], testRuns: [], requiredCommands: [], requiredOutputs: [] },
    } };
    if (fault === "task-hash") entry.taskHash = "0".repeat(64);
    if (fault === "new-task") entry.relation = "new-request";
    if (fault === "active-revision") state.meta.goalContract.activeGoalRevision = 2;
    recordProjectVerificationOutcome(state, { toolName: "run_command", args: { command: a }, ok: false, exitCode: 2, stdout: "Observed pending item\n", stderr: "" }, { goal, taskProfile: "auto", commandCwd: root, baseDir: root, sandboxMode: "host", allowShellTool: true });
    const batch = state.meta.projectVerification.requiredCommandBatch;
    if (fault === "none") {
      assert.ok(batch, "same-task continuation lost its first closed command receipt");
      assert.deepEqual(batch.completedCommands, [a]); assert.deepEqual(batch.requiredCommands, [a, b]); assert.equal(batch.complete, false);
    } else assert.equal(batch, undefined, "unknown or different execution lineage must not gain batch authority");
  });
}
