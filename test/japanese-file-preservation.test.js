import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveScsTaskContract } from "../src/scs-evidence.js";
import { preservedInputMutationBlock, runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { closeSessionIndexConnections } from "../src/session-index.js";

const positives = [
  ["negative change", "input.csv は変更しないでください。report.md を作成してください。", ["input.csv"], ["report.md"]],
  ["quoted name and comma", "`input.csv` は変更しないで、`report.md` を作成してください。", ["input.csv"], ["report.md"]],
  ["no overwrite", "元の input.csv を上書きせず、report.md に要約してください。", ["input.csv"], ["report.md"]],
  ["leave intact", "input.csv はそのまま残して report.md だけ更新してください。", ["input.csv"], ["report.md"]],
  ["do not delete", "input.csv を削除しないでください。report.md を生成してください。", ["input.csv"], ["report.md"]],
  ["must not edit", "input.csv を編集してはいけない。report.md を保存してください。", ["input.csv"], ["report.md"]],
  ["coordinated list", "a.csv と b.csv は変更しないでください。report.md を作成してください。", ["a.csv", "b.csv"], ["report.md"]],
  ["quoted Unicode name", '"メモ.md" は変更しないでください。report.md を作成してください。', ["メモ.md"], ["report.md"]],
  ["arbitrary source suffix", "src/amount.rs を変更せず、report.md を作成してください。", ["src/amount.rs"], ["report.md"]],
  ["extensionless source", '"notes" はそのまま残してください。report.md を作成してください。', ["notes"], ["report.md"]],
];
for (const [label, goal, preserved, outputs] of positives) test("Japanese literal file roles: " + label, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  assert.deepEqual(contract.preservedInputPaths, preserved);
  assert.deepEqual(contract.exactOutputPaths, outputs);
  for (const path of preserved) {
    for (const [tool, args] of [
      ["write_file", { path, content: "bad", mode: "overwrite" }],
      ["apply_patch", { path, search: "old", replace: "bad" }],
      ["run_command", { command: "printf bad > " + JSON.stringify(path) }],
      ["run_command", { command: "mv " + JSON.stringify(path) + " moved.txt" }],
    ]) assert.equal(preservedInputMutationBlock({ goal }, tool, args, { goal })?.category, "preserved-input-mutation");
    assert.equal(preservedInputMutationBlock({ goal }, "read_file", { path }, { goal }), null);
  }
  assert.equal(preservedInputMutationBlock({ goal }, "write_file", { path: "report.md", content: "output" }, { goal }), null);
});

for (const goal of [
  '次の文を説明してください：「input.csv は変更しないでください。」',
  'Explain "First. input.csv は変更しないでください。"',
  "input.csv の書式は変更しないでください。",
  "input.csv の列名は変更しないでください。",
  "input.csv を変更しない場合は report.md を作成してください。",
  "input.csv を変更しないとは言っていません。",
  "入力はそのまま残してください。",
  "それは変更しないでください。",
  "input.csv を変更してください。",
  "input.csv を上書きしてください。",
]) test("Japanese partial/quoted/conditional prose is not whole-file authority: " + goal, () => {
  assert.deepEqual(deriveScsTaskContract({ goal, taskProfile: "code" }).preservedInputPaths, []);
});

for (const goal of [
  "report.md を作成してください。その後 report.md は変更しないでください。",
  "report.md を生成してください。report.md はそのまま残してください。",
  "report.mdを作成してください。report.mdを変更しないでください。",
  "report.mdを作成してください。その後report.mdを変更しないでください。",
  "report.mdを作成してください。report.mdはそのまま残してください。",
  "Create report.md. report.mdを変更しないでください。",
  "创建 report.md。report.mdを変更しないでください。",
]) test("Japanese newly created output is not mistaken for an existing protected input: " + goal, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  assert.deepEqual(contract.preservedInputPaths, []);
  assert.deepEqual(contract.exactOutputPaths, ["report.md"]);
  assert.deepEqual(contract.excludedOutputPaths, []);
  assert.equal(preservedInputMutationBlock({ goal }, "write_file", { path: "report.md", content: "new" }, { goal }), null);
});

for (const goal of [
  "input.csvを読み取り、report.mdを作成してください。input.csvは変更しないでください。",
  "input.csvを読み取り、report.mdを作成してください。input.csvを変更しないでください。",
]) test("unspaced Japanese read/output/prohibition clauses retain their own scopes: " + goal, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  assert.deepEqual(contract.preservedInputPaths, ["input.csv"]);
  assert.deepEqual(contract.exactInputPaths, ["input.csv"]);
  assert.deepEqual(contract.exactOutputPaths, ["report.md"]);
  assert.deepEqual(contract.excludedOutputPaths, ["input.csv"]);
});

test("Japanese protecting an existing update target removes the conflicting output requirement", () => {
  const goal = "input.csvを更新してください。input.csvを変更しないでください。";
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  assert.deepEqual(contract.preservedInputPaths, ["input.csv"]);
  assert.deepEqual(contract.exactOutputPaths, []);
  assert.deepEqual(contract.excludedOutputPaths, ["input.csv"]);
  assert.equal(preservedInputMutationBlock({ goal }, "write_file", { path: "input.csv", content: "bad" }, { goal })?.category, "preserved-input-mutation");
});

test("Japanese output and input roles retain request order across different actions", () => {
  const contract = deriveScsTaskContract({ goal: "input-b.csvを読み取り、input-a.csvを読み取ってください。input-a.csvは変更しないでください。report.mdを更新してください。checklist.mdを作成してください。", taskProfile: "code" });
  assert.deepEqual(contract.exactInputPaths, ["input-b.csv", "input-a.csv"]);
  assert.deepEqual(contract.exactOutputPaths, ["report.md", "checklist.md"]);
});

for (const goal of [
  "report.md を作成しないでください。",
  "report.md は作成しないでください。",
  "report.md を作成しない場合は確認してください。",
  'Explain "First. report.md を作成してください。"',
  "report.md を作成した。",
  "report.md を保存した。",
]) test("Japanese negation and quoted requests do not authorize a new output: " + goal, () => {
  assert.deepEqual(deriveScsTaskContract({ goal, taskProfile: "code" }).exactOutputPaths, []);
});

for (const scsActive of [false, true]) test("Japanese preservation survives native persistence and continuation (SCS " + scsActive + ")", { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-japanese-preserve-"));
  const oldHome = process.env.AGINTIFLOW_HOME;
  process.env.AGINTIFLOW_HOME = path.join(root, "home");
  t.after(async () => {
    closeSessionIndexConnections();
    if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const input = "label,value\nA,1\n";
  await fs.writeFile(path.join(workspace, "input.csv"), input);
  let phase = "start", step = 0, requests = 0;
  const text = { start: "# Summary\nA: 1\n", followup: "# Checklist\n- [x] A: 1\n" };
  const client = { chat: { completions: { create: async request => {
    requests++;
    if (!request.tools) return { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Read the source, write a separate artifact, verify and finish." } }] };
    const call = (name, args) => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "japanese_" + phase + "_" + requests, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    if (!request.tools.some(tool => tool.function.name === "read_file") && request.tools.some(tool => tool.function.name === "inspect_project")) return call("inspect_project", {});
    step++;
    const output = phase === "start" ? "summary.md" : "checklist.md";
    if (step === 1) return call("read_file", { path: "input.csv" });
    if (step === 2) return call("apply_patch", { path: "input.csv", search: "A,1", replace: "A,999" });
    if (step === 3) return request.tools.some(tool => tool.function.name === "write_file")
      ? call("write_file", { path: output, content: text[phase], mode: "create" })
      : call("apply_patch", { patch: "*** Begin Patch\n*** Add File: " + output + "\n" + text[phase].trimEnd().split("\n").map(line => "+" + line).join("\n") + "\n*** End Patch" });
    if (step === 4) return call("read_file", { path: output });
    assert.equal(step, 5, "source mutation or producer loop must not replace legitimate output");
    return call("finish", { result: output + " を作成しました。A の値は 1 です。input.csv は変更していません。" });
  } } } };
  const clientFactory = async () => client;
  clientFactory.agintiDeterministicTest = true;
  const goal = "input.csv を読み取り、summary.md を作成してください。input.csv は変更しないでください。";
  const config = resolveRuntimeConfig({ goal, provider: "openai", model: "scripted-japanese-preservation", routingMode: "manual", taskProfile: "code", enableScs: scsActive ? "on" : "off" }, {
    baseDir: workspace, commandCwd: workspace, packageDir: path.resolve(import.meta.dirname, ".."), sessionId: "japanese-preserve", clientFactory,
    sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: false,
    allowWrapperTools: false, allowAuxiliaryTools: false, allowMcpTools: false, allowWebSearch: false, allowParallelScouts: false,
  });
  Object.assign(config, { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
    scsActive, scsValidationMode: "deterministic", useDockerSandbox: false, quiet: true, maxSteps: 6, dynamicSteps: "off",
    executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline Japanese preservation regression." } });
  assert.equal((await runAgent(config)).goalStatus, "completed");
  assert.equal(step, 5);
  assert.equal(await fs.readFile(path.join(workspace, "input.csv"), "utf8"), input);
  assert.equal(await fs.readFile(path.join(workspace, "summary.md"), "utf8"), text.start);
  const before = requests;
  assert.equal((await runAgent({ ...config, resume: "japanese-preserve", goal: "Continue the same task." })).goalStatus, "completed");
  assert.equal(requests, before);
  phase = "followup"; step = 0;
  assert.equal((await runAgent({ ...config, resume: "japanese-preserve", goal: "input.csv を読み取り、checklist.md だけ作成してください。input.csv はそのまま残してください。" })).goalStatus, "completed");
  assert.equal(step, 5);
  assert.equal(await fs.readFile(path.join(workspace, "input.csv"), "utf8"), input);
  assert.equal(await fs.readFile(path.join(workspace, "summary.md"), "utf8"), text.start);
  assert.equal(await fs.readFile(path.join(workspace, "checklist.md"), "utf8"), text.followup);
  const events = (await fs.readFile(path.join(root, "sessions/japanese-preserve/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.filter(event => event.type === "file.changed").map(event => event.data.path), ["summary.md", "checklist.md"]);
  assert.equal(events.filter(event => event.type === "tool.blocked" && event.data.category === "preserved-input-mutation").length, 2);
  const state = JSON.parse(await fs.readFile(path.join(root, "sessions/japanese-preserve/state.json")));
  assert.equal(state.meta.goalContract.status, "completed");
  assert.deepEqual(state.meta.projectVerification.mutationHistory.flatMap(item => item.paths), ["checklist.md"]);
  if (scsActive) {
    assert.deepEqual(state.meta.scs.taskContract.exactInputPaths, ["input.csv"]);
    assert.deepEqual(state.meta.scs.taskContract.exactOutputPaths, ["checklist.md"]);
  }
  await assert.rejects(fs.stat(path.join(root, "sessions/japanese-preserve/.agent-run.lock")), { code: "ENOENT" });
});
