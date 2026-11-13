import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { isBareTaskContinuationText, continuationAddsConcreteRequirement, applyContinuationContractTransition, isCompletedContinuationNoop } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { deriveScsTaskContract } = await import(pathToFileURL(path.join(runtime, "src/scs-evidence.js")));
const original = "Can you turn measurement.txt into a short brief.md and a checklist.md of what is still to do? Leave the source as it is.";
const hash = text => createHash("sha256").update(text).digest("hex");
function stateFor(status = "failed", goal = original) {
  return { goal, plan: "Read the source; save brief.md and checklist.md.", meta: {
    taskProfile: "code", projectVerification: { mutationRevision: 1, mutationHistory: [{ revision: 1, goalRevision: 1, taskHash: hash(goal), paths: ["brief.md"] }], commandRuns: [], requiredCommands: [] },
    goalContract: { version: 3, revision: 1, status, taskGoal: goal, activeGoal: goal, activeGoalRevision: 1, taskBoundaryRevision: 1,
      history: [{ revision: 1, kind: "initial", hash: hash(goal), preview: goal }], lifecycle: [] },
  } };
}
const continuations = [
  "Please continue from where you stopped.", "Continue where we left off.",
  "Kindly resume from where I paused.", "Pick up where we left off.",
  "Please pick up from where you stopped.", "Carry on from where we stopped.",
  "Resume from the last checkpoint.", "Continue from your saved checkpoint.",
  "请从上次停下的地方继续。", "从刚才中断的位置接着。",
  "前回止まったところから続けてください。", "中断したところから再開してください。",
];
for (const prompt of continuations) test(`bounded checkpoint continuation preserves actual goal: ${prompt}`, () => {
  assert.equal(isBareTaskContinuationText(prompt), true); assert.equal(continuationAddsConcreteRequirement(prompt), false);
  for (const status of ["failed", "completed"]) {
    const state = stateFor(status), before = structuredClone(state.meta.projectVerification);
    const update = applyContinuationContractTransition(state, prompt);
    assert.equal(update.preserveTaskBoundary, true); assert.equal(update.refreshExecutionContract, false);
    assert.equal(state.goal, original); assert.equal(state.meta.goalContract.taskGoal, original); assert.equal(state.meta.goalContract.activeGoal, original);
    assert.equal(state.meta.goalContract.taskBoundaryRevision, 1); assert.deepEqual(state.meta.projectVerification, before);
    assert.equal(isCompletedContinuationNoop(update, prompt, state), status === "completed");
  }
});

for (const prompt of [
  "Please continue from where you stopped and save notes.md.",
  "Resume from the last checkpoint but delete legacy.txt.",
  "Pick up where we left off. Show me the current status.",
  "Continue from the last checkpoint.py", "Could you tell me where you stopped?",
  "请从上次停下的地方继续，并删除草稿。", "中断したところから再開して、結果を教えてください。",
  "Resume another project from the last checkpoint.",
]) test(`new requirements are not swallowed as a checkpoint no-op: ${prompt}`, () => {
  assert.equal(isBareTaskContinuationText(prompt), false); assert.equal(continuationAddsConcreteRequirement(prompt), true);
  const state = stateFor("completed"), update = applyContinuationContractTransition(state, prompt);
  assert.equal(isCompletedContinuationNoop(update, prompt, state), false);
});

test("retained history repairs a generic legacy active goal without rewriting provenance", () => {
  const state = stateFor(); const bare = continuations[0];
  Object.assign(state.meta.goalContract, { revision: 2, taskGoal: bare, activeGoal: bare, activeGoalRevision: 2, taskBoundaryRevision: 2 });
  state.goal = bare;state.plan = "Run a command for the generic task inferred by the old runtime.";
  const historical = { revision: 2, kind: "continuation", relation: "new-request", hash: hash(bare), preview: bare, taskHash: hash(bare) };
  state.meta.goalContract.history.push(historical);
  const update = applyContinuationContractTransition(state, bare);
  assert.equal(update.preserveTaskBoundary, true); assert.equal(state.goal, original); assert.equal(state.meta.goalContract.taskGoal, original);
  assert.equal(state.meta.goalContract.activeGoal, original); assert.equal(state.meta.goalContract.activeGoalRevision, 3);
  assert.equal(state.plan, "", "a plan inferred for the discarded generic goal is not retained");
  assert.equal(state.meta.goalContract.taskBoundaryRevision, 2, "do not retroactively grant older mutation provenance");
  assert.deepEqual(state.meta.goalContract.history[1], historical);
});

test("checkpoint wording never removes an earlier concrete active correction", () => {
  const state = stateFor();const active = "Continue the same task. Add notes.md containing the verified result.";
  state.meta.goalContract.activeGoal = active;state.meta.goalContract.activeGoalRevision = 2;state.meta.goalContract.revision = 2;
  state.meta.goalContract.history.push({ revision: 2, kind: "same-task-continuation", relation: "same-task", hash: hash(active), preview: active, taskHash: hash(original), activeHash: hash(active), refreshExecutionContract: true });
  applyContinuationContractTransition(state, continuations[0]);
  assert.equal(state.goal, active);assert.equal(state.meta.goalContract.activeGoalRevision, 2);
});

test("missing material history cannot invent an earlier task during recovery", () => {
  const state = stateFor();const bare = continuations[0];state.goal = bare;
  Object.assign(state.meta.goalContract, { taskGoal: bare, activeGoal: bare, history: [] });
  applyContinuationContractTransition(state, bare);assert.notEqual(state.goal, original);assert.equal(state.meta.goalContract.taskGoal, bare);
});

test("same-task checkpoint continuation preserves real required commands", () => {
  const commandGoal = "Run `node check.mjs` and report the observed result.";const state = stateFor("failed", commandGoal);
  applyContinuationContractTransition(state, continuations[0]);
  assert.equal(state.goal, commandGoal);
  assert.ok(deriveScsTaskContract({ goal: state.goal, taskProfile: "code" }).requiredProjectCommands.includes("node check.mjs"));
});

test("official CLI resumes a quota-interrupted file task and completed checkpoint is a no-op", { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-checkpoint-continuation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));await fs.mkdir(root + "/workspace");
  await fs.writeFile(root + "/workspace/measurement.txt", "Latency fell from 120 ms to 90 ms across 12 samples. Independent review is pending.\n");
  const brief = "# Brief\n\nLatency fell from 120 ms to 90 ms in the supplied test (12 samples). Independent review is pending.\n";
  const checklist = "# Checklist\n\n- [ ] Obtain independent review.\n";
  const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  let phase = "start", turns = 0, requests = 0;const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      requests++;const chunks = [];for await (const b of req) chunks.push(b);const body = JSON.parse(Buffer.concat(chunks));let message;
      if (!body.tools) message = { content: "1. Read the source.\n2. Write the brief.\n3. Write the remaining checklist." };
      else if (phase === "start" && turns++ === 0) message = { tool_calls: [call("read_file", { path: "measurement.txt" }, "read_source")] };
      else if (phase === "start" && turns === 2) message = { tool_calls: [call("write_file", { path: "brief.md", content: brief }, "write_brief")] };
      else if (phase === "start") { res.writeHead(402, { "content-type": "application/json" });res.end('{"error":{"code":"insufficient_balance","message":"Synthetic exhausted balance"}}');return; }
      else if (turns++ === 0) message = { tool_calls: [call("write_file", { path: "checklist.md", content: checklist }, "write_checklist")] };
      else if (turns === 2) message = { tool_calls: [call("read_file", { path: "brief.md" }, "verify_brief_as_data")] };
      else if (turns === 3) message = { tool_calls: [call("read_file", { path: "checklist.md" }, "verify_checklist_as_data")] };
      else message = { tool_calls: [call("finish", { result: "The brief.md and checklist.md are ready. The source is unchanged and independent review remains pending." }, "finish_task")] };
      res.writeHead(200, { "content-type": "application/json" });res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, reasoning_content: "Preserve confirmed work and finish only the missing file.", ...message } }] }));
    } catch (e) { errors.push(e.message);res.writeHead(400);res.end('{"error":{"message":"Fixture request rejected"}}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { PATH: process.env.PATH, HOME: root, AGINTIFLOW_HOME: root + "/home", LANG: "C.UTF-8", AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", AGINTI_PROVIDER_HANDOFF: "0", DEEPSEEK_API_KEY: "synthetic-continuation-key", ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) };
  async function run(args, extra = {}, input = "") {
    const child = spawn(process.execPath, args, { cwd: root + "/workspace", env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });let stdout = "", stderr = "", expired = false;
    child.stdout.on("data", b => stdout += b);child.stderr.on("data", b => stderr += b);child.stdin.on("error", () => {});child.stdin.end(input);
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { expired = true;child.kill("SIGKILL"); }, 12000);
      child.once("error", e => { clearTimeout(timer);reject(e); });child.once("close", c => { clearTimeout(timer);resolve(c); });
    });assert.equal(expired, false);return { code, stdout, stderr, data: JSON.parse(stdout) };
  }
  const seed = await run([fileURLToPath(new URL("./fixtures/native-terminal-quota.js", import.meta.url)), root, origin + "/v1", "start"]);
  assert.equal(seed.code, 0, seed.stderr);assert.equal(seed.data.resolved, false);phase = "resume";turns = 0;
  const args = [path.join(runtime, "bin/aginti-cli.js"), "run", "--resume", "terminal-quota", "--stdin", "--json", "--no-auto-update", "--provider", "deepseek", "--model", "deepseek-flash", "--routing", "manual", "--route-model", "deepseek-flash", "--main-model", "deepseek-flash", "--spare-model", "deepseek-flash"];
  const extra = { NODE_OPTIONS: "--import=" + fileURLToPath(new URL("./fixtures/native-terminal-quota-cli.js", import.meta.url)), AGINTI_TEST_QUOTA_ORIGIN: origin };
  const finished = await run(args, extra, continuations[0]);assert.equal(finished.code, 0, JSON.stringify(finished));assert.equal(finished.data.ok, true);
  const state = JSON.parse(await fs.readFile(root + "/home/sessions/terminal-quota/state.json"));
  assert.equal(state.meta.goalContract.taskGoal, original);assert.equal(state.meta.goalContract.activeGoal, original);
  assert.equal(state.meta.goalContract.taskRelation, "same-task");assert.equal(state.meta.goalContract.status, "completed");
  assert.equal(await fs.readFile(root + "/workspace/brief.md", "utf8"), brief);assert.equal(await fs.readFile(root + "/workspace/checklist.md", "utf8"), checklist);
  const count = requests;const noOp = await run(args, extra, continuations[0]);assert.equal(noOp.code, 0, noOp.stderr);assert.equal(noOp.data.ok, true);assert.equal(requests, count, "completed continuation must not invoke a provider or repeat tools");assert.deepEqual(errors, []);
});
