import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const runtime = process.env.AGINTI_TEST_STALE_RUNTIME || new URL("../", import.meta.url).pathname;
const core = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { executeWorkspaceTool } = await import(pathToFileURL(path.join(runtime, "src/workspace-tools.js")));
const { goalRevisionCoversActiveTask } = await import(pathToFileURL(path.join(runtime, "src/permission-advice.js")));
const state = () => ({ goal: "Update draft.md and preserve all notes.", commandCwd: process.cwd(), messages: [],
  meta: { goalContract: { revision: 1 }, projectVerification: { mutationRevision: 0 }, toolLoop: { recent: [] } } });
const failure = extra => ({ toolName: "apply_patch", ok: false, args: { path: "draft.md", search: "old", replace: "new" }, ...extra });

for (const detail of [
  { code: "WORKSPACE_WRITE_CONFLICT", error: "Workspace target changed before publication: draft.md" },
  { error: "Base hash mismatch for draft.md; read the file again before patching." },
]) test(`first snapshot conflict opens exact existing refresh: ${detail.code || "legacy"}`, () => {
  const s = state(), marker = core.patchContextRefreshDecision(s, failure(detail));
  assert.equal(marker?.triggerCategory, "stale-file-snapshot"); assert.equal(marker.path, "draft.md");
  assert.equal(marker.stalePatchFailureCount, 1); assert.equal(marker.goalRevision, 1); assert.equal(marker.mutationRevision, 0);
  s.meta.toolLoop.patchContextRequired = marker;
  assert.equal(core.activePatchContextRefresh(s).path, "draft.md");
});
for (const detail of [
  { ok: true, code: "WORKSPACE_WRITE_CONFLICT" },
  { toolName: "read_file", code: "WORKSPACE_WRITE_CONFLICT" },
  { error: "Permission denied", category: "workspace-path" },
  { error: "Arbitrary prose mentioning base hash" },
  { error: "Filesystem failure", code: "EIO" },
]) test(`unrelated outcome cannot open stale-snapshot refresh: ${JSON.stringify(detail)}`, () => {
  assert.equal(core.patchContextRefreshDecision(state(), failure(detail)), null);
});
test("native hash mismatch retains a typed conflict and leaves exact bytes unchanged", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-stale-source-unit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.writeFile(root + "/draft.md", "Owner version\n");
  await assert.rejects(executeWorkspaceTool("apply_patch", { path: "draft.md", search: "Owner", replace: "Other", baseHash: "0".repeat(64) },
    { commandCwd: root, allowFileTools: true, sandboxMode: "host" }), { code: "WORKSPACE_WRITE_CONFLICT" });
  assert.equal(await fs.readFile(root + "/draft.md", "utf8"), "Owner version\n");
  assert.deepEqual(await fs.readdir(root), ["draft.md"]);
});
test("successful fresh exact read consumes the marker; another path does not", () => {
  const s = state(); s.meta.toolLoop.patchContextRequired = core.patchContextRefreshDecision(s, failure({ code: "WORKSPACE_WRITE_CONFLICT" }));
  assert.equal(core.consumePatchContextRefreshRead(s, { toolName: "read_file", ok: true, path: "other.md", content: "old\n" }), null);
  const consumed = core.consumePatchContextRefreshRead(s, { toolName: "read_file", ok: true, path: "draft.md", content: "old\nOwner note\n" });
  assert.equal(consumed.path, "draft.md"); assert.equal(core.activePatchContextRefresh(s), null);
  assert.ok(core.activePatchContextRepair(s));
});

function lineage() {
  const hash = "a".repeat(64);
  return { meta: { goalContract: { revision: 3, history: [
    { revision: 1, kind: "initial", hash },
    ...[2, 3].map(revision => ({ revision, kind: "same-task-continuation", relation: "same-task", taskHash: hash, refreshExecutionContract: false })),
  ] } } };
}
test("legacy exact initial hash binds a complete same-task continuation chain", () => {
  assert.equal(goalRevisionCoversActiveTask(lineage(), 1), true);
});
for (const value of ["", null, false, 0]) test(`present malformed initial taskHash is not a legacy absence: ${JSON.stringify(value)}`, () => {
  const s = lineage(); s.meta.goalContract.history[0].taskHash = value;
  assert.equal(goalRevisionCoversActiveTask(s, 1), false);
});
for (const [label, mutate] of [
  ["missing initial identity", h => { delete h[0].hash; }],
  ["different initial identity", h => { h[0].hash = "b".repeat(64); }],
  ["missing intervening hash", h => { delete h[1].taskHash; }],
  ["changed task", h => { h[1].taskHash = "b".repeat(64); }],
  ["new request", h => { h[1].relation = "new-request"; }],
  ["refreshed contract", h => { h[1].refreshExecutionContract = true; }],
  ["gap", h => { h.splice(1, 1); }],
  ["duplicate revision", h => { h.push({ ...h[1] }); }],
]) test(`cross-revision evidence rejects ${label}`, () => {
  const s = lineage(); mutate(s.meta.goalContract.history); assert.equal(goalRevisionCoversActiveTask(s, 1), false);
});
test("future revisions cannot cover the current task", () => {
  assert.equal(goalRevisionCoversActiveTask(lineage(), 4), false);
});
