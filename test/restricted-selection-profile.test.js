import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initialize, load, runPhase, acceptDiscovery, authorizeSelection, commit, scripted, nativeFinal, nativeCall, replacement } from "./fixtures/restricted-selection-profile.js";

const worker = fileURLToPath(new URL("./fixtures/restricted-selection-profile.js", import.meta.url));
async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-selection-profile-")), directory = path.join(temporary, "host");
  try { await initialize(directory); await run(directory); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); await assert.rejects(fs.stat(temporary), { code: "ENOENT" }); }
}
const bytes = directory => fs.readFile(path.join(directory, "host.json"));
async function selected(directory) {
  const discovery = await runPhase(directory, "discover", scripted("discover"));
  await acceptDiscovery(directory, discovery.result, discovery.events);
  await authorizeSelection(directory, discovery.result.proposal.candidates[1].id);
}
function child(phase, directory) {
  const r = spawnSync(process.execPath, [worker, "--offline", phase, directory], { cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, LANG: "C.UTF-8" }, encoding: "utf8", timeout: 15000 });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}

test("discovery, selected edit and response-loss replay survive three fresh processes", async () => fixture(async directory => {
  const original = await load(directory), foreign = await fs.readFile(path.join(directory, "foreign.json"));
  const discovery = child("discover", directory);
  assert.equal(discovery.result.proposal.action, "clarify");
  assert.deepEqual(discovery.result.usage, { steps: 2, toolCalls: 1 });
  await authorizeSelection(directory, discovery.result.proposal.candidates[1].id);
  const before = await load(directory);
  assert.equal(before.records[0].id, "draft_beta", "current ordering has reversed");
  assert.equal(before.displayedCandidates[1].id, "draft_beta", "displayed user choice is durable");
  const edit = child("followup", directory), committed = await bytes(directory), replay = child("replay", directory);
  assert.notEqual(discovery.pid, edit.pid); assert.notEqual(edit.pid, replay.pid); assert.notEqual(discovery.pid, replay.pid);
  assert.equal(replay.replayed, true); assert.equal(replay.providerRequests, 0); assert.deepEqual(await bytes(directory), committed);
  const after = await load(directory), target = after.records.find(record => record.id === "draft_beta");
  assert.equal(target.revision, 10); assert.equal(target.intro, replacement);
  assert.equal(target.body, before.records.find(record => record.id === target.id).body);
  assert.deepEqual(after.records.find(record => record.id === "draft_alpha"), original.records[0]);
  assert.equal(after.records.length, 2); assert.deepEqual(await fs.readFile(path.join(directory, "foreign.json")), foreign);
}));

test("an undisclosed detail tool fails before any discovery callback or host change", async () => fixture(async directory => {
  const before = await bytes(directory); let turns = 0;
  await assert.rejects(runPhase(directory, "discover", () => { turns++; return nativeCall("read_draft", { id: "draft_beta" }); }), error => error.code === "TOOL_CALL_INVALID");
  assert.equal(turns, 1); assert.deepEqual(await bytes(directory), before);
}));

test("a schema-valid guessed edit is not a target authorization or save", async () => fixture(async directory => {
  const before = await bytes(directory);
  const guessed = await runPhase(directory, "discover", () => nativeFinal({ action: "edit", id: "draft_alpha", expectedRevision: 3, intro: replacement, reply: "Proposal only." }));
  assert.equal(guessed.result.status, "completed");
  await assert.rejects(acceptDiscovery(directory, guessed.result, guessed.events), error => error.code === "CLARIFICATION_REQUIRED");
  assert.deepEqual(await bytes(directory), before);
}));

test("foreign selection is rejected without granting a read or changing stored history", async () => fixture(async directory => {
  const outcome = await runPhase(directory, "discover", scripted("discover")); await acceptDiscovery(directory, outcome.result, outcome.events);
  const before = await bytes(directory);
  await assert.rejects(authorizeSelection(directory, "other-account-id"), error => error.code === "SELECTION_INVALID");
  assert.deepEqual(await bytes(directory), before);
}));

test("the original unselected candidate and extra owner arguments are both blocked", async () => fixture(async directory => {
  await selected(directory); const before = await bytes(directory);
  for (const args of [{ id: "draft_alpha" }, { id: "draft_beta", principal: "other-owner" }]) {
    await assert.rejects(runPhase(directory, "followup", () => nativeCall("read_draft", args)), error => error.code === "TOOL_CALL_INVALID");
    assert.deepEqual(await bytes(directory), before);
  }
}));

test("stale, substituted, unsupported or unobserved edit proposals cannot commit", async () => fixture(async directory => {
  await selected(directory); const outcome = await runPhase(directory, "followup", scripted("followup")), proposal = outcome.result.proposal;
  const before = await bytes(directory);
  for (const [value, events, code] of [[{ ...proposal, expectedRevision: 8 }, outcome.events, "REVISION_CONFLICT"],
    [{ ...proposal, id: "draft_alpha" }, outcome.events, "PROPOSAL_MISMATCH"],
    [{ ...proposal, intro: "unrequested replacement" }, outcome.events, "PROPOSAL_MISMATCH"], [proposal, [], "EVIDENCE_REQUIRED"]]) {
    await assert.rejects(commit(directory, "accepted-intro-edit", value, events), error => error.code === code);
    assert.deepEqual(await bytes(directory), before);
  }
}));

test("a reused key with a different proposal conflicts instead of applying twice", async () => fixture(async directory => {
  await selected(directory); const outcome = await runPhase(directory, "followup", scripted("followup"));
  await commit(directory, "accepted-intro-edit", outcome.result.proposal, outcome.events); const before = await bytes(directory);
  await assert.rejects(commit(directory, "accepted-intro-edit", { ...outcome.result.proposal, intro: "different request" }, []), error => error.code === "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(await bytes(directory), before);
}));
