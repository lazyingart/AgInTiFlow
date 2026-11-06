import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nextStepRuntimeConfig, preservedInputMutationBlock, runAgent } from "../src/agent-runner.js";
import { deriveScsTaskContract } from "../src/scs-evidence.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { closeSessionIndexConnections } from "../src/session-index.js";

test("a preserved manifest is not a repair target when no output filename is supplied", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-preserved-target-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "package.json"), '{"private":true}\n');
  const goal = "The amount parser lets junk through. Fix the implementation and verify it. Keep the tests and package.json unchanged.";
  const state = { goal, commandCwd: root, messages: [], meta: {
    goalContract: { revision: 1, currentRequest: goal, activeGoal: goal },
    activeExecutionContract: { revision: 1, requiresFileMutation: true, requiresSourceGrounding: true, startedMutationRevision: 0 },
    projectVerification: { mutationRevision: 0, mutationHistory: [] },
    toolLoop: { recent: [{ toolName: "read_file", args: { path: "package.json" }, ok: true }] },
  } };
  const runtime = nextStepRuntimeConfig({ goal, commandCwd: root }, state);
  assert.ok(!runtime.completionFreshMutationPaths?.includes("package.json"), "explicitly preserved input became a mandatory patch target");
  const editGoal = "Read package.json and update its description.";
  const editState = structuredClone(state);
  editState.goal = editGoal;
  editState.meta.goalContract = { revision: 1, currentRequest: editGoal, activeGoal: editGoal };
  assert.ok(nextStepRuntimeConfig({ goal: editGoal, commandCwd: root }, editState).completionFreshMutationPaths.includes("package.json"), "an explicitly requested manifest edit must stay possible");
});

for (const goal of [
  "Fix the calculation. Keep package.json unchanged.",
  "Fix the calculation; leave package.json untouched.",
  "Fix the calculation. package.json must remain read-only.",
  "修复计算错误。保持 package.json 不变。",
  "修復計算錯誤。保留 package.json 原樣。",
]) test(`explicit preservation is independent of output naming: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  assert.deepEqual(contract.preservedInputPaths, ["package.json"]);
  for (const [tool, args] of [
    ["write_file", { path: "./package.json", content: "changed" }],
    ["apply_patch", { patch: "*** Begin Patch\n*** Update File: package.json\n@@\n-old\n+new\n*** End Patch" }],
    ["apply_patch", { patch: "*** Begin Patch\n*** Update File: other.json\n*** Move to: package.json\n@@\n-old\n+new\n*** End Patch" }],
    ["run_command", { command: "printf changed > package.json" }],
    ["run_command", { command: "mv package.json renamed.json" }],
    ["run_command", { command: 'sh -c "printf changed > package.json"' }],
  ]) assert.equal(preservedInputMutationBlock({ goal }, tool, args, { goal })?.category, "preserved-input-mutation", tool);
  assert.equal(preservedInputMutationBlock({ goal }, "read_file", { path: "package.json" }, { goal }), null);
  assert.equal(preservedInputMutationBlock({ goal }, "run_command", { command: "cp package.json snapshot.json" }, { goal }), null);
  assert.equal(preservedInputMutationBlock({ goal }, "apply_patch", { path: "src/calculate.js" }, { goal }), null);
});

for (const goal of [
  "Read package.json and update its description.",
  "Read source.js and fix its arithmetic.",
  "Create report.md, then keep report.md unchanged.",
]) test(`read inputs and newly requested outputs remain writable: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  assert.deepEqual(contract.preservedInputPaths, []);
  for (const target of ["package.json", "source.js", "report.md"])
    assert.equal(preservedInputMutationBlock({ goal }, "write_file", { path: target }, { goal }), null);
});

for (const scsActive of [false, true]) test(`persisted repair preserves inputs and resumes (SCS ${scsActive})`, { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-preserved-runtime-"));
  const oldHome = process.env.AGINTIFLOW_HOME;
  process.env.AGINTIFLOW_HOME = path.join(root, "home");
  t.after(async () => {
    closeSessionIndexConnections();
    if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  const manifest = '{"type":"module","private":true}\n';
  await fs.writeFile(path.join(workspace, "package.json"), manifest);
  await fs.writeFile(path.join(workspace, "src/calculate.js"), "export const total = 1;\n");
  const checks = 'import assert from "node:assert/strict"; import { total } from "./src/calculate.js"; assert.equal(total, 2);\n';
  await fs.writeFile(path.join(workspace, "check.test.js"), checks);
  let step = 0, resumed = false, resumeStep = 0;
  const requests = [];
  const call = (name, args) => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id: `preserve_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  const client = { chat: { completions: { create: async request => {
    requests.push(request);
    if (!request.tools) return { choices: [{ index: 0, finish_reason: "stop", message: {
      role: "assistant", content: "Read the retained implementation, report its value, and preserve every file.",
    } }] };
    step++;
    if (resumed) return ++resumeStep === 1 ? call("read_file", { path: "src/calculate.js" }) : call("finish", { result: "The calculation is 2. The retained repair remains in place; package.json was not modified." });
    if (step === 1) return call("inspect_project", {});
    if (step === 2) return call("read_file", { path: "check.test.js" });
    if (step === 3) return call("read_file", { path: "package.json" });
    if (step === 4) return call("read_file", { path: "src/calculate.js" });
    if (step === 5) return call("apply_patch", { path: "src/calculate.js", search: "export const total = 1;", replace: "export const total = 2;" });
    if (step === 6) return call("run_command", { command: "node --test check.test.js" });
    assert.equal(step, 7, "unnecessary repair loop");
    return call("finish", { result: "Fixed the calculation to return 2 and verified it with node --test check.test.js. package.json is unchanged." });
  } } } };
  const clientFactory = async () => client;
  clientFactory.agintiDeterministicTest = true;
  const goal = "The calculation gives the wrong result. Fix the implementation and verify it. Keep package.json and check.test.js unchanged. Do not install anything or create extra deliverables.";
  const config = resolveRuntimeConfig({ goal, provider: "openai", model: "scripted-preservation", routingMode: "manual", taskProfile: "code", enableScs: scsActive ? "on" : "off" }, {
    baseDir: workspace, commandCwd: workspace, packageDir: path.resolve(import.meta.dirname, ".."), sessionId: "preserved-repair", clientFactory,
    sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: true,
    allowWrapperTools: false, allowAuxiliaryTools: false, allowMcpTools: false, allowWebSearch: false, allowParallelScouts: false,
  });
  Object.assign(config, { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
    scsActive, scsValidationMode: "deterministic", useDockerSandbox: false, quiet: true, maxSteps: 8, dynamicSteps: "off",
    executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline preservation regression." } });
  const result = await runAgent(config);
  assert.notEqual(result.stopped, true, JSON.stringify(result));
  assert.notEqual(result.failed, true, JSON.stringify(result));
  assert.equal(step, 7);
  assert.equal(await fs.readFile(path.join(workspace, "package.json"), "utf8"), manifest);
  assert.equal(await fs.readFile(path.join(workspace, "check.test.js"), "utf8"), checks);
  assert.equal(await fs.readFile(path.join(workspace, "src/calculate.js"), "utf8"), "export const total = 2;\n");
  const events = (await fs.readFile(path.join(root, "sessions/preserved-repair/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(!events.some(e => e.type === "file.changed" && JSON.stringify(e.data).includes("package.json")), "touch/revert is a violation even if final bytes match");
  assert.ok(!requests.some(r => r.tools?.length === 1 && r.tools[0]?.function?.name === "apply_patch" && JSON.stringify(r.tools).includes("package.json")));
  const stateBeforeResume = JSON.parse(await fs.readFile(path.join(root, "sessions/preserved-repair/state.json"), "utf8"));
  assert.equal(stateBeforeResume.meta.projectVerification.mutationRevision, 1, "preserved path must not count as a repair");
  resumed = true;
  const followup = await runAgent({ ...config, resume: "preserved-repair", goal: "Continue this calculation task. Read src/calculate.js and report the retained value. Keep package.json unchanged. Do not change any files." });
  assert.notEqual(followup.stopped, true, JSON.stringify(followup));
  assert.equal(await fs.readFile(path.join(workspace, "package.json"), "utf8"), manifest);
  assert.equal(await fs.readFile(path.join(workspace, "check.test.js"), "utf8"), checks);
  assert.equal(await fs.readFile(path.join(workspace, "src/calculate.js"), "utf8"), "export const total = 2;\n");
});
