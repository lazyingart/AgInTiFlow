import assert from "node:assert/strict";
import test from "node:test";
import { budgetStopWithDeferredReceipts, currentDeferredJobReceipts, deferredJobLaunchSummary, isLaunchOnlyHandoffGoal, launchOnlyHandoffReceipt, recordDeferredJobReceipt } from "../src/deferred-job-handoff.js";

const ordinary = "Can you put the supplied export in the background and tell me where to check it? Keep the input and script as they are.";
for (const goal of [ordinary, "Please start the build as a background job and give me its receipt.", "Run this script in the background and return its job id and status path.", "Launch the download in the background."]) {
  test(`closed launch-only intent: ${goal}`, () => assert.equal(isLaunchOnlyHandoffGoal(goal), true));
}
for (const goal of [
  "Start the export in the background and then fix server.js and run npm test.",
  "Start the build in the background, wait until it finishes and verify result.json.",
  "Start the export in the background and email the results.",
  "Start two jobs in the background.", "Start all tests in the background.",
  "Start the export in the background and tell me its status. Also publish it.",
  "Start the export and email results in the background.",
  "Start the export in the background and report its final result.",
  "Start the export in the background. Keep the input and delete the script as they are.",
  "The phrase start the job in the background is documentation, not my request.",
  "Read the existing background job's status and report completion.",
  "启动后台任务，然后发布结果。", // Unknown phrasing is not proof of a launch-only goal.
]) test(`compound/unknown goal keeps ordinary loop: ${goal}`, () => assert.equal(isLaunchOnlyHandoffGoal(goal), false));

const state = () => ({ meta: { goalContract: { revision: 1, currentHash: "a".repeat(64), activeGoal: ordinary } } });
const receipt = (jobId = "export-12345678") => ({ ok: true, toolName: "start_long_job", background: true, deferredVerification: true, jobId,
  statusPath: `.aginti/long-jobs/${jobId}/status.json`, statusMarkdownPath: `.aginti/long-jobs/${jobId}/status.md`,
  stdoutPath: `.aginti/long-jobs/${jobId}/stdout.log`, stderrPath: `.aginti/long-jobs/${jobId}/stderr.log` });
test("only native acknowledged launch, exact current revision/hash and safe receipt paths qualify", () => {
  const s = state();
  assert.equal(launchOnlyHandoffReceipt(s), null);
  for (const changes of [{ ok: false }, { toolName: "read_file" }, { background: false }, { deferredVerification: false }, { statusPath: "../../private" }]) {
    recordDeferredJobReceipt(s, { ...receipt(), ...changes }); assert.equal(launchOnlyHandoffReceipt(s), null);
  }
  recordDeferredJobReceipt(s, receipt()); const saved = launchOnlyHandoffReceipt(s); assert.ok(saved);
  assert.equal(Object.isFrozen(saved), true); assert.match(deferredJobLaunchSummary(saved), /Current job state has not been checked/);
  assert.doesNotMatch(deferredJobLaunchSummary(saved), /finished successfully|source.*unchanged/);
  s.meta.goalContract.revision++; assert.deepEqual(currentDeferredJobReceipts(s), []);
  s.meta.goalContract.revision--; s.meta.goalContract.currentHash = "b".repeat(64); assert.equal(launchOnlyHandoffReceipt(s), null);
});
test("later mutation, compound work or multiple launches never auto-finish", () => {
  const s = state(); recordDeferredJobReceipt(s, receipt());
  s.meta.projectVerification = { mutationRevision: 1 }; assert.equal(launchOnlyHandoffReceipt(s), null);
  delete s.meta.projectVerification;
  s.meta.goalContract.activeGoal += " Also email results."; assert.equal(launchOnlyHandoffReceipt(s), null);
  s.meta.goalContract.activeGoal = ordinary; recordDeferredJobReceipt(s, receipt("second-12345678")); assert.equal(launchOnlyHandoffReceipt(s), null);
  assert.equal(currentDeferredJobReceipts(s).length, 2);
});
test("budget stop keeps grounded receipt but explicitly leaves the request unconfirmed", () => {
  const s = state(); assert.equal(budgetStopWithDeferredReceipts(s), ""); recordDeferredJobReceipt(s, receipt());
  const text = budgetStopWithDeferredReceipts(s); assert.match(text, /before confirming the entire request/);
  assert.match(text, /export-12345678/); assert.match(text, /do not launch these jobs again/);
  s.meta.goalContract.revision++; assert.equal(budgetStopWithDeferredReceipts(s), "");
});
test("malformed or mixed corrupt receipt state does not become completion authority", () => {
  const s = state(); recordDeferredJobReceipt(s, receipt());
  const valid = s.meta.deferredJobReceipts[0];
  for (const bad of [{ ...valid, goalRevision: "1" }, { ...valid, extra: true }, { ...valid, jobId: "../escape" }, { ...valid, stdoutPath: "/tmp/private" }]) {
    s.meta.deferredJobReceipts = [valid, bad]; assert.equal(launchOnlyHandoffReceipt(s), null); assert.equal(budgetStopWithDeferredReceipts(s), "");
  }
});
test("receipt collection rejects sparse/custom/accessor/proxied arrays before hooks", () => {
  const s = state(); recordDeferredJobReceipt(s, receipt()); const valid = s.meta.deferredJobReceipts[0];
  let reads = 0;
  const sparse = [valid]; sparse.length = 2;
  const accessor = []; Object.defineProperty(accessor, "0", { enumerable: true, get() { reads++; return valid; } });
  const extended = [valid]; extended.extra = true;
  const proxy = new Proxy([valid], { get() { reads++; throw Error("must not execute"); }, ownKeys() { reads++; throw Error("must not execute"); } });
  for (const entries of [sparse, accessor, extended, proxy]) { s.meta.deferredJobReceipts = entries; assert.deepEqual(currentDeferredJobReceipts(s), []); }
  assert.equal(reads, 0);
});
