import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { continuationAddsConcreteRequirement, isCompletedContinuationNoop, applyContinuationContractTransition, retainedArtifactEditPaths, nextStepRuntimeConfig } from "../src/agent-runner.js";

const original = "Read brief.md and create checklist.md, preserving the source.";
const hash = value => createHash("sha256").update(value).digest("hex");
const edits = [
  "Continue the same task: make the checklist bilingual, English and Chinese on each item. Keep all three actions and do not change the source or other files.",
  "Continue the same task and make it shorter.",
  "Continue the current work: translate it into French.",
  "Continue the saved session. Add a short introduction.",
  "Resume the existing task. Remove the final paragraph.",
  "Continue the same task. Rewrite the conclusion.",
  "Continue the current project: rename the heading.",
  "Continue the same task; sort the rows.",
  "Continue the same task and make the checklist bilingual and do not change the source or other files.",
  "继续这个任务，把每一项改成英文和中文。",
  "继续当前任务。请翻译成法语。",
  "继续这个任务，缩短结论。",
  "继续之前的工作，添加一段介绍。",
  "继续这个任务，把清单改成英文和中文，不要修改源文件。",
  "同じ作業を続けてください。各項目を英語と中国語に翻訳してください。",
  "同じ作業を続けて、最後の段落を削除してください。",
  "同じ作業を続けて、checklist を翻訳して、他のファイルは変更しないでください。",
];
for (const request of edits) test("a short explicit edit remains active work after completion: " + request, () => {
  assert.equal(continuationAddsConcreteRequirement(request), true);
  assert.equal(isCompletedContinuationNoop({ preserveTaskBoundary: true, previousStatus: "completed" }, request, {}), false);
  const state = { goal: original, plan: "Old completed plan", meta: { goalContract: { version: 3, revision: 1, status: "completed",
    taskGoal: original, activeGoal: original, activeGoalRevision: 1, taskBoundaryRevision: 1,
    history: [{ revision: 1, kind: "initial", hash: hash(original), preview: original }], lifecycle: [] } } };
  const update = applyContinuationContractTransition(state, request);
  assert.equal(update.preserveTaskBoundary, true); assert.equal(state.meta.goalContract.taskGoal, original);
  assert.equal(update.refreshExecutionContract, true);
  assert.equal(state.meta.goalContract.activeGoal, request); assert.equal(state.plan, "");
  assert.equal(state.meta.goalContract.activeGoalRevision, 2);
});

for (const request of [
  "Continue the same task.", "Resume the saved session.",
  "Continue the same task. The report is already complete.",
  "Continue the same task. Do not inspect anything else.",
  "Continue the same task. Do not rewrite or translate anything.",
  "Continue the same task. Do not rewrite and translate anything.",
  "Please continue and finish the same task from the retained state. Repair the canonical project in place, follow every documented requirement, verify every deliverable, and leave the folder tidy.",
]) test("bare, passive and prohibited edits do not repeat completed side effects: " + request, () => {
  assert.equal(continuationAddsConcreteRequirement(request), false);
  assert.equal(isCompletedContinuationNoop({ preserveTaskBoundary: true, previousStatus: "completed" }, request, {}), true);
});

function ownedArtifactState(request = edits[0], paths = ["checklist.md"]) {
  const task = "Read brief.md and turn it into " + paths.join(" and ") + ". Preserve the source.";
  const state = { goal: task, plan: "Completed", meta: { taskProfile: "auto", projectVerification: { mutationRevision: 1, mutationHistory: [
    { revision: 1, goalRevision: 1, taskHash: hash(task), toolName: "write_file", paths },
  ] }, goalContract: { version: 3, revision: 1, status: "completed", taskGoal: task, activeGoal: task,
    activeGoalRevision: 1, taskBoundaryRevision: 1, history: [{ revision: 1, kind: "initial", hash: hash(task), taskHash: hash(task), preview: task }], lifecycle: [] } } };
  applyContinuationContractTransition(state, request); return state;
}
test("the retained named artifact supplies concrete write intent without widening host authority", () => {
  const state = ownedArtifactState(); assert.deepEqual(retainedArtifactEditPaths(state, edits[0]), ["checklist.md"]);
  assert.equal(state.meta.activeExecutionContract.requiresFileMutation, true);
  const runtime = nextStepRuntimeConfig({ provider: "deepseek", taskProfile: "auto", allowFileTools: false, workspaceWritePolicy: "block" }, state);
  assert.equal(runtime.readOnlyDiagnosticIntent, false); assert.equal(runtime.allowFileTools, false); assert.equal(runtime.workspaceWritePolicy, "block");
  const restricted = { provider: "deepseek", taskProfile: "auto", commandCwd: "/tmp/owned-artifact-test", allowFileTools: true, workspaceWritePolicy: "allow", workspacePathScopeRoots: [], workspaceWritePathScopeRoots: ["elsewhere"] };
  const before = structuredClone(restricted), denied = nextStepRuntimeConfig(restricted, state);
  assert.equal(denied.workspaceWritePolicy, "block"); assert.deepEqual(restricted, before);
});
for (const [name, mutate] of [
  ["missing mutation hash", s => { delete s.meta.projectVerification.mutationHistory[0].taskHash; }],
  ["foreign task hash", s => { s.meta.projectVerification.mutationHistory[0].taskHash = hash("Different task"); }],
  ["future mutation", s => { s.meta.projectVerification.mutationHistory[0].revision = 2; }],
  ["unrelated path", s => { s.meta.projectVerification.mutationHistory[0].paths = ["other.md"]; }],
  ["outside path", s => { s.meta.projectVerification.mutationHistory[0].paths = ["../checklist.md"]; }],
  ["read instead of producer", s => { s.meta.projectVerification.mutationHistory[0].toolName = "read_file"; }],
  ["missing history", s => { s.meta.goalContract.history.shift(); }],
  ["duplicate history", s => { s.meta.goalContract.history.push({ ...s.meta.goalContract.history.at(-1) }); }],
  ["foreign continuation", s => { s.meta.goalContract.history.at(-1).taskHash = hash("Different task"); }],
  ["missing continuation hash", s => { delete s.meta.goalContract.history.at(-1).taskHash; }],
]) test("an artifact edit cannot borrow " + name, () => {
  const state = ownedArtifactState(); mutate(state); assert.deepEqual(retainedArtifactEditPaths(state, edits[0]), []);
});
for (const request of [
  "Continue the same task: make the checklist bilingual. Reply here only; no file changes.",
  "Continue the same task: translate it inline. No file changes.",
  "Continue the same task. Explain how to make the checklist bilingual; do not change any files.",
  "Continue the same task. Do not rewrite or translate anything.",
]) test("response-only and negative follow-ups never inherit a file edit: " + request, () => {
  const state = ownedArtifactState(request); assert.deepEqual(retainedArtifactEditPaths(state, request), []);
});
test("a bare restart retains the unfinished concrete edit and its mutation baseline", () => {
  const state = ownedArtifactState(); state.meta.goalContract.status = "paused";
  const baseline = state.meta.activeExecutionContract.startedMutationRevision;
  applyContinuationContractTransition(state, "Continue from the last checkpoint.");
  assert.deepEqual(retainedArtifactEditPaths(state, state.meta.goalContract.currentRequest), ["checklist.md"]);
  assert.equal(state.meta.activeExecutionContract.startedMutationRevision, baseline);
});
test("equal artifact stems stay ambiguous until the request identifies one exact path", () => {
  const ambiguous = "Continue the same task: make the checklist bilingual.";
  let state = ownedArtifactState(ambiguous, ["first/checklist.md", "second/checklist.md"]);
  assert.deepEqual(retainedArtifactEditPaths(state, ambiguous), []);
  const exact = "Continue the same task: make first/checklist.md bilingual.";
  state = ownedArtifactState(exact, ["first/checklist.md", "second/checklist.md"]);
  assert.deepEqual(retainedArtifactEditPaths(state, exact), ["first/checklist.md"]);
  state = ownedArtifactState(exact, ["checklist.md", "first/checklist.md"]);
  assert.deepEqual(retainedArtifactEditPaths(state, exact), ["first/checklist.md"]);
  const suffix = "Continue the same task: make checklist.md.backup bilingual.";
  state = ownedArtifactState(suffix); assert.deepEqual(retainedArtifactEditPaths(state, suffix), []);
});

for (const behavior of ["edit", "premature-finish", "unrelated-write", "unchanged-write"]) test("native retained edit and fresh completion evidence: " + behavior, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-edit-continuation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true })); const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  const source = "# Review\n- Check the supplied changelog.\n- Record any unresolved issues.\n- Ask for review before a release.\n";
  const first = "# Checklist\n\n- [ ] Check the supplied changelog.\n- [ ] Record any unresolved issues.\n- [ ] Ask for review before a release.\n";
  const second = "# Checklist\n\n- [ ] Check the supplied changelog. / 检查提供的变更日志。\n- [ ] Record any unresolved issues. / 记录尚未解决的问题。\n- [ ] Ask for review before a release. / 发布前请求审核。\n";
  await fs.writeFile(path.join(workspace, "brief.md"), source); await fs.writeFile(path.join(workspace, "owner.txt"), "Do not change this input.\n");
  const requests = [], errors = []; let phase = "start", turn = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const b of req) chunks.push(b); const body = JSON.parse(Buffer.concat(chunks)); requests.push({ phase, model: body.model });
      assert.ok(requests.length < 14); let message;
      if (!body.tools) message = { role: "assistant", content: "Read the current source, produce the requested checklist, and finish only after the work is done." };
      else {
        const current = turn++, premature = phase === "resume" && behavior === "premature-finish";
        const name = premature ? "finish" : current === 0 || current === 2 ? "read_file" : current === 1 ? "write_file" : "finish";
        const args = premature ? { result: "The checklist.md now has English and Chinese on all three items." }
          : current === 0 ? { path: phase === "start" ? "brief.md" : "checklist.md" }
          : current === 1 ? { path: phase === "resume" && behavior === "unrelated-write" ? "unrelated.md" : "checklist.md",
              content: phase === "start" || behavior === "unchanged-write" ? first : second,
              mode: phase === "start" || phase === "resume" && behavior === "unrelated-write" ? "create" : "overwrite" }
            : current === 2 ? { path: "checklist.md" }
              : { result: phase === "start" ? "The requested checklist.md is ready." : "The checklist.md now has English and Chinese on all three items." };
        message = { role: "assistant", content: null, tool_calls: [{ id: "edit_" + phase + "_" + current, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(String(error)); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const exec = promisify(execFile), child = new URL("./fixtures/native-project-instructions.js", import.meta.url).pathname;
  const env = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0",
    ...(process.env.AGINTI_TEST_INSTRUCTION_RUNTIME ? { AGINTI_TEST_INSTRUCTION_RUNTIME: process.env.AGINTI_TEST_INSTRUCTION_RUNTIME } : {}) };
  for (const next of ["start", "resume"]) {
    phase = next; turn = 0;
    const r = await exec(process.execPath, [child, root, "http://127.0.0.1:" + server.address().port + "/v1", phase, "edit"], { cwd: workspace, env, timeout: 12000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(r.stdout.trim().split("\n").at(-1));
    if (phase === "resume" && behavior !== "edit") {
      assert.notEqual(result.result.goalStatus, "completed", JSON.stringify(result));
      assert.equal(await fs.readFile(path.join(workspace, "checklist.md"), "utf8"), first);
      assert.equal(await fs.readFile(path.join(workspace, "brief.md"), "utf8"), source);
      assert.equal(await fs.readFile(path.join(workspace, "owner.txt"), "utf8"), "Do not change this input.\n");
      await assert.rejects(fs.stat(path.join(workspace, "unrelated.md")), { code: "ENOENT" });
      const events = (await fs.readFile(path.join(root, "sessions/native-project-instructions/events.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
      assert.ok(events.some(e => /completion\.evidence_rejected|tool\.blocked|tool\.failed/.test(e.type)));
      continue;
    }
    assert.equal(result.result.goalStatus, "completed", JSON.stringify({ phase, result, events: (await fs.readFile(path.join(root, "sessions/native-project-instructions/events.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse).filter(e => /completion|tool\.failed|tool\.blocked/.test(e.type)).slice(-8) }));
    assert.equal(await fs.readFile(path.join(workspace, "checklist.md"), "utf8"), phase === "start" ? first : second,
      JSON.stringify({ phase, result, requests, events: (await fs.readFile(path.join(root, "sessions/native-project-instructions/events.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse).filter(e => /tool\.failed|tool\.blocked|completion|goal\.updated|model\.requested/.test(e.type)).slice(-14) }));
    assert.equal(await fs.readFile(path.join(workspace, "brief.md"), "utf8"), source); assert.equal(await fs.readFile(path.join(workspace, "owner.txt"), "utf8"), "Do not change this input.\n");
    assert.ok(requests.some(row => row.phase === phase && row.model === (phase === "start" ? "deepseek-v4-flash" : "deepseek-v4-pro")));
    const state = JSON.parse(await fs.readFile(path.join(root, "sessions/native-project-instructions/state.json")));
    assert.equal(state.meta.runtimeConfig.revision, phase === "start" ? 1 : 2);
    if (phase === "resume") assert.equal(state.meta.goalContract.activeGoal, edits[0]);
  }
  assert.deepEqual(errors, []);
});
