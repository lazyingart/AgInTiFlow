import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { completionTaskContract } from "../src/agent-runner.js";
import { evaluateScsSemanticContract } from "../src/scs-evidence.js";
import { savedTextEditReadback, hasSavedEditReadbackEvents } from "../src/saved-text-edit.js";

const hash = text => createHash("sha256").update(text).digest("hex");
const original = "Please fix “old brigde” to “old bridge” in cut.srt. Keep the subtitles and timings otherwise unchanged.";
const followup = "Continue. Verify the saved correction and tell me what changed.";
const before = "At the old brigde.\r\n再见\r\n";
const after = before.replace("brigde", "bridge");

function session(goal = original, request = followup, file = "cut.srt") {
  const taskHash = hash(goal);
  const mutation = { revision: 1, goalRevision: 1, taskHash, paths: [file], toolName: "apply_patch",
    patch: { path: file, beforeContentSha256: hash(before), afterContentSha256: hash(after),
      searchHash: hash("old brigde"), replaceHash: hash("old bridge") } };
  return { goal, meta: { goalContract: { taskGoal: goal, revision: 2, currentRequest: request,
    activeGoal: request, activeGoalRevision: 2, taskRelation: "same-task", taskBoundaryRevision: 1,
    history: [ { kind: "initial", revision: 1, hash: taskHash, taskHash, preview: goal },
      { kind: "same-task-continuation", relation: "same-task", revision: 2, hash: hash(request), taskHash, preview: request } ] },
    projectVerification: { lastMutation: mutation, mutationHistory: [structuredClone(mutation)], mutationRevision: 1 } } };
}

test("a saved literal edit supports readback across text formats and languages", () => {
  for (const [goal, request, file] of [
    [original, followup, "cut.srt"],
    ['In chapter.md, replace "old brigde" with "old bridge".', "Check the saved edit.", "chapter.md"],
    ["请把歌词.lrc中的「old brigde」改为「old bridge」，其余内容保持不变。", "请核对刚才的修改。", "歌词.lrc"],
    [original, "继续，核对刚才保存的修改，再告诉我改了什么。", "cut.srt"],
    ["notes.txtの「old brigde」を「old bridge」に修正してください。", "保存した修正内容を確認してください。", "notes.txt"],
  ]) assert.equal(savedTextEditReadback(session(goal, request, file), request)?.path, file);
});

test("unproven edits, other goals, different operands, extra actions and explicit checks retain their requirements", () => {
  for (const goal of [original + " Run the tests.",
    original.replace("cut.srt", "elsewhere.srt"), original.replace("unchanged", "synchronized against the rendered video")]) {
    assert.equal(savedTextEditReadback(session(goal), followup), null);
  }
  for (const request of ["Verify the saved correction and run the tests.", "Check the rendering.", "Compile the saved change.",
    "核对刚才保存的修改，然后运行测试。", "核对上次保存的改动，再告诉我视频是否同步。"]) {
    const state = session(original, request);
    assert.equal(completionTaskContract({}, state).savedTextEditReadback, undefined);
  }
  for (const edit of [
    s => { delete s.meta.projectVerification.lastMutation.taskHash; },
    s => { s.meta.goalContract.history[1].taskHash = hash("another task"); },
    s => { s.meta.goalContract.history[1].hash = hash("run tests"); },
    s => { s.meta.projectVerification.mutationRevision++; },
    s => { s.meta.projectVerification.mutationHistory.unshift({ revision: 0, goalRevision: 1, paths: ["other"] }); },
    s => { s.meta.goalContract.taskRelation = "new-task"; },
  ]) {
    const state = session();
    edit(state);
    assert.equal(savedTextEditReadback(state, followup), null);
  }
  for (const file of ["../outside.md", "/abs.txt", ".env", "script.js"]) {
    assert.equal(savedTextEditReadback(session(original.replace("cut.srt", file), followup, file), followup), null);
  }
  const state = session();
  state.meta.projectVerification.requiredCommands = ["npm test"];
  assert.equal(completionTaskContract({}, state).savedTextEditReadback, undefined);
});

test("completion needs the exact publication followed by a complete current read and matching on-disk bytes", t => {
  const state = session();
  const contract = completionTaskContract({}, state);
  const proof = contract.savedTextEditReadback;
  assert.equal(proof?.path, "cut.srt");
  const file = proof.path;
  const patch = { type: "tool.completed", data: { ok: true, path: file, toolName: "apply_patch", goalRevision: 1,
    projectMutationRevision: 1, args: { path: file, searchHash: proof.searchHash, replaceHash: proof.replaceHash },
    change: { ok: true, created: false, path: file, beforeHash: proof.before, afterHash: proof.after, replacements: 1 } } };
  const read = { type: "tool.completed", data: { toolName: "read_file", ok: true, goalRevision: 2, path: file,
    args: { path: file }, startLine: 1, sha256: proof.after, content: after.replaceAll("\r\n", "\n"),
    contentTruncated: false, contentTruncatedByLines: false } };
  for (const events of [[read], [read, patch], [patch], [{ ...patch, type: "message.created" }, read],
    [patch, { ...read, data: { ...read.data, goalRevision: 1 } }], [patch, { ...read, data: { ...read.data, sha256: proof.before } }],
    [patch, { ...read, data: { ...read.data, contentTruncatedByLines: true } }],
    [{ ...patch, data: { ...patch.data, args: { ...patch.data.args, searchHash: proof.replaceHash } } }, read]]) {
    assert.equal(hasSavedEditReadbackEvents(proof, events, state), false);
  }
  // A receipt for an edit with different user-specified operands is insufficient.
  const otherTask = session(original.replace("old brigde", "different text"));
  assert.equal(hasSavedEditReadbackEvents(completionTaskContract({}, otherTask).savedTextEditReadback,
    [patch, read], otherTask), false);
  for (const [search, replace, expected] of [
    ["At the old brigde.", "At the old bridge.", true],
    ["At the old brigde.", "Over the old bridge.", false],
    ["old brigde / old brigde", "old bridge / old brigde", false],
  ]) {
    const args = { path: file, search, replace, searchHash: hash(search), replaceHash: hash(replace) };
    const contextualProof = { ...proof, searchHash: args.searchHash, replaceHash: args.replaceHash };
    const contextualPatch = { ...patch, data: { ...patch.data, args } };
    assert.equal(hasSavedEditReadbackEvents(contextualProof, [contextualPatch, read], state), expected);
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-saved-edit-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = path.join(cwd, file);
  const check = () => evaluateScsSemanticContract(contract, { state, commandCwd: cwd, events: [patch, read] });
  fs.writeFileSync(target, after);
  assert.equal(check().ok, true);
  fs.writeFileSync(target, after.replaceAll("\r\n", "\n"));
  assert.equal(check().ok, false);
  fs.rmSync(target);
  assert.equal(check().ok, false);
  const other = path.join(cwd, "other");
  fs.writeFileSync(other, after);
  fs.symlinkSync(other, target);
  assert.equal(check().ok, false);
  fs.rmSync(target);
  fs.linkSync(other, target);
  assert.equal(check().ok, false);
});

function verifyNativeResume(t, task, request, check, laterRequest) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-restart-edit-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, "work"), trace = path.join(home, "trace");
  fs.mkdirSync(cwd);
  const file = path.join(cwd, "cut.srt"), bytes = "1\r\n00:00:03,500 --> 00:00:05,200\r\n" + before + randomUUID();
  fs.writeFileSync(file, bytes);
  const cli = fileURLToPath(new URL("../bin/aginti-cli.js", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/saved-text-edit-provider.js", import.meta.url));
  const run = (interrupt, args, mode = check) => spawnSync(process.execPath, ["--import", fixture, cli, ...args], {
    cwd, encoding: "utf8", timeout: 25000, env: { HOME: home, PATH: process.env.PATH,
      AGINTIFLOW_HOME: path.join(home, "agent"), XDG_CONFIG_HOME: path.join(home, "config"),
      OPENAI_API_KEY: "offline-fixture", TEST_EDIT_TRACE: trace, TEST_INTERRUPT_AFTER_PATCH: interrupt ? "1" : "0",
      TEST_EDIT_VERIFY: interrupt ? "read" : mode,
      TEST_PATCH_CONTEXT: task.startsWith("请") ? "1" : "0",
      AGINTIFLOW_HOUSEKEEPING: "0", AGINTI_PROVIDER_HANDOFF: "0", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTO_UPDATE: "1" } });
  const first = run(true, ["run", "--json", "--session-id", "edit", "--provider", "openai", "--model", "gpt-6.1-sol",
    "--routing", "manual", "--max-steps", "5", "--dynamic-steps", "off", "--sandbox-mode", "host", "--allow-file-tools",
    "--no-shell", "--no-web-search", "--no-mcp", "--no-wrappers", "--no-auxiliary-tools", "--no-parallel-scouts", task]);
  assert.equal(first.signal, "SIGKILL", first.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), bytes.replace("brigde", "bridge"));
  const stat = () => { const s = fs.statSync(file, { bigint: true }); return [s.ino, s.mtimeNs, s.ctimeNs]; };
  const preResume = stat();
  const next = run(false, ["resume", "edit", "--json", request]);
  const state = JSON.parse(fs.readFileSync(path.join(home, "agent/sessions/edit/state.json")));
  assert.equal(state.meta.goalContract.taskRelation, "same-task");
  const calls = fs.readFileSync(trace, "utf8").trim().split("\n");
  assert.equal(calls.filter(id => id === "exact_edit").length, 1);
  if (check !== "read") {
    assert.equal(next.status, 1);
    assert.equal(JSON.parse(next.stdout).ok, false);
    assert.equal(calls.includes("verify_edit"), check === "tamper");
    const current = fs.readFileSync(file, "utf8");
    assert.equal(current, (check === "tamper" ? bytes.replaceAll("\r\n", "\n") : bytes).replace("brigde", "bridge"));
    return;
  }
  assert.equal(next.status, 0, next.stderr + next.stdout);
  assert.equal(JSON.parse(next.stdout).ok, true);
  assert.match(JSON.parse(next.stdout).result, /old bridge/);
  assert.deepEqual(calls, ["initial_read", "exact_edit", "checkpoint", "verify_edit", "finish_edit"]);
  assert.deepEqual(stat(), preResume);
  assert.equal(fs.readFileSync(file, "utf8"), bytes.replace("brigde", "bridge"));
  if (laterRequest) {
    const external = bytes.replace("brigde", "bridge").replaceAll("\r\n", "\n");
    fs.writeFileSync(file, external);
    const retry = run(false, ["resume", "edit", "--json", laterRequest], "skip");
    assert.equal(retry.status, 1, retry.stdout + retry.stderr);
    assert.equal(JSON.parse(retry.stdout).ok, false);
    const session = path.join(home, "agent/sessions/edit");
    assert.equal(JSON.parse(fs.readFileSync(path.join(session, "state.json"))).meta.goalContract.revision, 3);
    const events = fs.readFileSync(path.join(session, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.some(e => e.type === "tool.completed" && e.data.toolName === "read_file" && e.data.goalRevision === 2));
    assert.ok(!events.some(e => e.type === "tool.completed" && e.data.toolName === "read_file" && e.data.goalRevision === 3));
    assert.equal(fs.readFileSync(file, "utf8"), external);
  }
}

test("a second same-task check cannot reuse the preceding turn's verified bytes after an outside edit", t =>
  verifyNativeResume(t, "请把cut.srt中的「old brigde」改为「old bridge」，其余内容保持不变。",
    "继续，核对刚才的修改，并告诉我改了什么。", "read", "继续，核对刚才保存的修改，再告诉我改了什么。"));

for (const [language, task, request] of [
  ["en", original, followup],
  ["zh", "请把cut.srt中的「old brigde」改为「old bridge」，其余内容保持不变。", "继续，核对刚才的修改，并告诉我改了什么。"],
  ["ja", "cut.srtの「old brigde」を「old bridge」に修正してください。", "保存した修正内容を確認してください。"],
]) {
  for (const check of ["read", "skip", "tamper"]) {
    test(`native CLI resumes a committed subtitle correction after SIGKILL (${language}, ${check})`,
      t => verifyNativeResume(t, task, request, check));
  }
}
