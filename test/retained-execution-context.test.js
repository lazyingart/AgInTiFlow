import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { nextStepRuntimeConfig, runAgent } from "../src/agent-runner.js";
import { selectProgressiveTools } from "../src/progressive-tool-selection.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { closeSessionIndexConnections } from "../src/session-index.js";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const goal = "Inspect the project source, fix the wrong calculation and verify it. Keep package.json unchanged.";
const workspace = path.join(os.tmpdir(), "synthetic-retained-execution");
const tools = ["inspect_project", "read_file", "search_files", "apply_patch", "run_command", "finish"].map(name => ({
  type: "function", function: { name, parameters: { type: "object", properties: {
    path: { type: "string" }, command: { type: "string" },
  }, additionalProperties: false } },
}));
function stateFixture() {
  return { goal, commandCwd: workspace, messages: [], meta: {
    goalContract: { version: 3, revision: 3, taskGoal: goal, activeGoal: goal, activeGoalRevision: 1, taskRelation: "same-task",
      currentRequest: "Continue the same task.", history: [2, 3].map(revision => ({ revision,
        kind: "same-task-continuation", relation: "same-task", refreshExecutionContract: false,
        taskHash: hash(goal), activeHash: hash(goal),
      })) },
    activeExecutionContract: { revision: 1, requiresFileMutation: true, requiresSourceGrounding: true,
      startedMutationRevision: 0, materialMutationRevision: 1, materialMutationPaths: ["src/compute.js"] },
    projectVerification: { mutationRevision: 1, discoveredTests: ["test/compute.test.js"], testRuns: [], commandRuns: [],
      mutationHistory: [{ revision: 1, goalRevision: 1, taskHash: hash(goal), toolName: "apply_patch", paths: ["src/compute.js"] }] },
  } };
}
function runtime(state, commandCwd = workspace) {
  return nextStepRuntimeConfig({ provider: "deepseek", taskProfile: "code", goal, commandCwd,
    allowFileTools: true, allowShellTool: true }, state);
}
test("a same-active-task continuation retains its completed source-grounding phase", () => {
  const state = stateFixture(), config = runtime(state);
  assert.notEqual(config.repositoryGroundingRequired, true, "completed work was lost when the chat revision advanced");
  const offered = selectProgressiveTools(tools, { config, goal, profile: "code", messages: [] }).map(tool => tool.function.name);
  assert.ok(offered.includes("run_command"), "the retained test step cannot run without redundant discovery");
});

for (const [name, alter] of [
  ["new active requirement", state => { state.meta.goalContract.activeGoalRevision = 3; }],
  ["new task", state => { state.meta.goalContract.taskRelation = "new-request"; }],
  ["refreshed execution", state => { state.meta.goalContract.history[0].refreshExecutionContract = true; }],
  ["missing task hash", state => { delete state.meta.goalContract.history[0].taskHash; }],
  ["changed active intent", state => { state.meta.goalContract.history[1].activeHash = hash("A different requirement"); }],
  ["missing continuation", state => { state.meta.goalContract.history.shift(); }],
  ["no source progress", state => { state.meta.activeExecutionContract.materialMutationRevision = 0; }],
  ["missing owned mutation hash", state => { delete state.meta.projectVerification.mutationHistory[0].taskHash; }],
  ["foreign mutation", state => { state.meta.projectVerification.mutationHistory[0].taskHash = hash("Another task"); }],
  ["future mutation", state => { state.meta.activeExecutionContract.materialMutationRevision = 2; }],
  ["future active revision", state => { state.meta.goalContract.activeGoalRevision = 4; }],
  ["read-only observation", state => { state.meta.projectVerification.mutationHistory[0].toolName = "read_file"; }],
  ["unbound mutation path", state => { state.meta.projectVerification.mutationHistory[0].paths = ["other.js"]; }],
  ["duplicate continuation", state => { state.meta.goalContract.history.push({ ...state.meta.goalContract.history[0] }); }],
]) test(`${name} cannot borrow completed grounding from an older task phase`, () => {
  const state = stateFixture(); alter(state);
  assert.equal(runtime(state).repositoryGroundingRequired, true);
});
test("another workspace cannot borrow the retained execution progress", () => {
  assert.equal(runtime(stateFixture(), workspace + "-other").repositoryGroundingRequired, true);
});

for (const scsActive of [false, true]) test(`persisted repair resumes directly at strict verification (SCS ${scsActive})`, { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-execution-"));
  const oldHome = process.env.AGINTIFLOW_HOME; process.env.AGINTIFLOW_HOME = path.join(root, "home");
  const oldDeepSeekKey = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = "synthetic-offline-handoff";
  t.mock.method(globalThis, "fetch", async () => { throw Error("Offline continuation test must not access the network"); });
  t.after(async () => {
    closeSessionIndexConnections();
    if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome;
    if (oldDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldDeepSeekKey;
    await fs.rm(root, { recursive: true, force: true });
  });
  const work = path.join(root, "work"); await fs.mkdir(path.join(work, "src"), { recursive: true }); await fs.mkdir(path.join(work, "test"));
  const manifest = '{"private":true,"type":"module","scripts":{"test":"node --test"}}\n';
  const checks = 'import assert from "node:assert/strict";import { total } from "../src/compute.js";assert.equal(total,2);\n';
  await fs.writeFile(path.join(work, "package.json"), manifest); await fs.writeFile(path.join(work, "test/compute.test.js"), checks);
  await fs.writeFile(path.join(work, "src/compute.js"), "export const total = 1;\n");
  let step = 0, resumed = false, resumeStep = 0; const events = [];
  const turn = (name, args) => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id: "retained_" + ++step, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  const clientFactory = async () => ({ chat: { completions: { create: async request => {
    if (!request.tools) return { choices: [{ message: { role: "assistant", content: "Use the retained work and run its established test command before reporting completion." } }] };
    if (resumed) {
      resumeStep++;
      if (resumeStep === 1) return turn("finish", { result: "The implementation is fixed and all tests pass." });
      if (resumeStep === 2) {
        assert.ok(request.tools.some(tool => tool.function.name === "run_command"), "same-task resume restarted discovery instead of offering verification");
        return turn("run_command", { command: "npm test" });
      }
      assert.equal(resumeStep, 3, "unnecessary continuation loop");
      return turn("finish", { result: "The retained source repair is unchanged. npm test passes; the manifest and test file are unchanged." });
    }
    if (step === 0) return turn("inspect_project", {});
    if (step === 1) return turn("read_file", { path: "package.json" });
    if (step === 2) return turn("read_file", { path: "test/compute.test.js" });
    if (step === 3) return turn("read_file", { path: "src/compute.js" });
    if (step === 4) return turn("apply_patch", { path: "src/compute.js", search: "export const total = 1;", replace: "export const total = 2;" });
    if (step === 5) return turn("run_command", { command: "node --test 2>&1 | tail -n 20" });
    const error = Error("Synthetic interruption after non-authoritative filtered test output"); error.code = "OFFLINE_CRASH_POINT"; throw error;
  } } } });
  clientFactory.agintiDeterministicTest = true;
  const task = "Inspect the project source, fix the wrong calculation and verify it. Keep package.json and test/compute.test.js unchanged. No installs or extra files.";
  const config = resolveRuntimeConfig({ provider: "openai", model: "scripted-retained", routingMode: "manual", taskProfile: "code", goal: task, enableScs: scsActive ? "on" : "off" }, {
    baseDir: work, commandCwd: work, packageDir: path.resolve(import.meta.dirname, ".."), sessionId: "retained-execution", clientFactory,
    sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: true,
    allowWrapperTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false,
  });
  Object.assign(config, { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
    maxSteps: 10, dynamicSteps: "off", allowProviderHandoff: false, scsActive, scsValidationMode: "deterministic",
    executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline native continuation regression" },
    onConsole: () => {}, onLog: () => {}, onEvent(type, data) { events.push({ type, data }); } });
  await assert.rejects(runAgent(config), { code: "OFFLINE_CRASH_POINT" });
  const statePath = path.join(root, "sessions/retained-execution/state.json");
  const before = JSON.parse(await fs.readFile(statePath));
  assert.equal(before.meta.projectVerification.mutationRevision, 1);
  assert.equal(before.meta.projectVerification.testRuns.length, 0, "filtered output was accepted as authoritative test success");
  resumed = true; events.length = 0;
  const result = await runAgent({ ...config, resume: "retained-execution", goal: "Continue the same task. You may run the existing tests. No more edits.",
    ...(scsActive ? {} : { runtimePatch: { provider: "deepseek", model: "deepseek-flash", baseURL: "https://api.deepseek.com/v1" }, expectedRuntimeRevision: 1 }) });
  assert.notEqual(result.stopped, true, JSON.stringify(result)); assert.equal(resumeStep, 3);
  assert.deepEqual(events.filter(event => event.type === "tool.started").map(event => event.data.toolName), ["finish", "run_command", "finish"]);
  assert.equal(events.filter(event => event.type === "completion.evidence_rejected").length, 1, "stale piped test must still reject completion");
  const after = JSON.parse(await fs.readFile(statePath));
  assert.equal(after.meta.goalContract.status, "completed"); assert.equal(after.meta.projectVerification.mutationRevision, 1);
  assert.equal(after.meta.projectVerification.testRuns.at(-1).passed, true);
  if (!scsActive) { assert.equal(after.meta.runtimeConfig.provider, "deepseek"); assert.equal(after.meta.runtimeConfig.revision, 2); }
  assert.equal(await fs.readFile(path.join(work, "src/compute.js"), "utf8"), "export const total = 2;\n");
  assert.equal(await fs.readFile(path.join(work, "package.json"), "utf8"), manifest);
  assert.equal(await fs.readFile(path.join(work, "test/compute.test.js"), "utf8"), checks);
});
