import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const root = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { resetSameTaskExecutionContract, nextStepRuntimeConfig, buildFailedTestRecoveryPacket } = await import(pathToFileURL(path.join(root, "src/agent-runner.js")));

async function fixture(t, name = "module.py", extra = "") {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-pending-creation-"));
  t.after(async () => { await fs.rm(workspace, { recursive: true, force: true }); await assert.rejects(fs.stat(workspace), { code: "ENOENT" }); });
  await fs.writeFile(path.join(workspace, "test_compute.py"), "assert True\n");
  const goal = `Create ${name}, run python3 test_compute.py and fix any failures. ${extra} Leave unrelated files alone.`;
  const config = { goal, commandCwd: workspace, baseDir: workspace, provider: "deepseek", model: "deepseek-flash", taskProfile: "code",
    allowFileTools: true, allowDestructive: false, readOnlyRoots: [] };
  const state = { goal, commandCwd: workspace, meta: { taskProfile: "code", goalContract: {
    revision: 1, currentRequest: goal, taskGoal: goal, activeGoal: goal, activeGoalRevision: 1,
    history: [{ revision: 1, kind: "initial" }] }, projectVerification: { mutationRevision: 0, testRuns: [] } } };
  resetSameTaskExecutionContract(state, 1);
  return { workspace, config, state, name };
}
for (const name of ["module.py", "summary.md", "data.json"]) test(`missing named ${name} can be created before a possible future repair`, async t => {
  const f = await fixture(t, name), runtime = nextStepRuntimeConfig(f.config, f.state);
  assert.notEqual(runtime.completionFreshMutationRequired, true, "Do not force a patch of the existing checker to create a missing deliverable");
  assert.notEqual(runtime.repositoryGroundingRequired, true);
  assert.equal(runtime.allowDestructive, false); assert.deepEqual(runtime.readOnlyRoots, []);
});
for (const name of ["module.py", "summary.md", "data.json"]) test(`existing ${name} still requires a grounded current edit`, async t => {
  const f = await fixture(t, name); await fs.writeFile(path.join(f.workspace, name), "existing content\n");
  const runtime = nextStepRuntimeConfig(f.config, f.state);
  assert.equal(runtime.completionFreshMutationRequired, true); assert.equal(runtime.completionFreshMutationNeedsSourceRead, true);
});
for (const action of ["fix its wording", "repair its wording", "update its wording", "fix notes.txt"]) test(`a missing review does not exempt an existing input correction: ${action}`, async t => {
  const f = await fixture(t, "review.md");
  await fs.writeFile(path.join(f.workspace, "notes.txt"), "Existing input needs correction.\n");
  const goal = `Read notes.txt and ${action}, then write review.md.`;
  f.config.goal = goal; f.state.goal = goal;
  Object.assign(f.state.meta.goalContract, { currentRequest: goal, taskGoal: goal, activeGoal: goal });
  resetSameTaskExecutionContract(f.state, 1);
  const runtime = nextStepRuntimeConfig(f.config, f.state);
  assert.equal(runtime.completionFreshMutationRequired, true);
  assert.ok(runtime.completionFreshMutationPaths.includes("notes.txt"));
});
test("observed source-quality rejection is not bypassed by another missing output", async t => {
  const f = await fixture(t, "module.py", "Repair broken.py as well."); await fs.writeFile(path.join(f.workspace, "broken.py"), "def broken(:\n");
  f.state.meta.sourceCodeQuality = { checked: true, ok: false, mutationRevision: 0, paths: ["broken.py"], defects: [{ path: "broken.py", code: "syntax" }] };
  const runtime = nextStepRuntimeConfig(f.config, f.state);
  assert.equal(runtime.completionFreshMutationRequired, true); assert.ok(runtime.completionFreshMutationPaths.includes("broken.py"));
});
test("a real failed verification still requires a repair mutation", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.workspace, f.name), "def compute(value):\n    return value + 1\n");
  const verification = f.state.meta.projectVerification;
  verification.mutationRevision = 1; verification.lastMutation = { revision: 1, paths: [f.name] };
  verification.testRuns = [{ command: "python3 test_compute.py", mutationRevision: 1, passed: false,
    failureEvidenceVersion: 2, failureSignature: "observed-failure", failureSummary: "AssertionError: expected 3" }];
  f.state.meta.activeExecutionContract.materialMutationRevision = 1;
  const evidence = await buildFailedTestRecoveryPacket(f.config, f.state);
  const packetVersion = Number(evidence.content.match(/^Bounded failed-test evidence packet v(\d+)\./)?.[1]);
  assert.ok(packetVersion > 0);
  f.state.meta.failedTestRecoveryPacket = { ...evidence, packetVersion, mutationRevision: 1, failureSignature: "observed-failure" };
  const runtime = nextStepRuntimeConfig(f.config, f.state);
  assert.equal(runtime.testFailureRepairMutationRequired, true);
});
