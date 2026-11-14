import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const runtimeRoot = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { deriveScsTaskContract, buildScsEvidenceLedger, evaluateScsEvidence, evaluateScsSemanticContract } = await import(pathToFileURL(path.join(runtimeRoot, "src/scs-evidence.js")));
const { executeWorkspaceTool } = await import(pathToFileURL(path.join(runtimeRoot, "src/workspace-tools.js")));
const { createToolContract, validateToolCallBatch } = await import(pathToFileURL(path.join(runtimeRoot, "src/tool-contract.js")));
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
for (const [goal, expected] of [
  ["Read notes.txt and replace placeholder.md. Leave notes.txt unchanged.", ["notes.txt"]],
  ["Replace placeholder.md. Leave notes.txt unchanged.", []],
  ["Write report.md from source.txt. Leave private.txt unchanged.", ["source.txt"]],
]) test("data reads are distinct from preservation-only paths: " + goal, () => {
  assert.deepEqual(deriveScsTaskContract({ goal }).explicitInputReadPaths, expected);
});
for (const [name, before, patch, valid, writable] of [
  ["exact empty insertion", "", { baseHash: emptyHash }, true, true],
  ["one explicit insertion", "", { baseHash: emptyHash, expectedReplacements: 1 }, true, true],
  ["missing hash", "", {}, false, false],
  ["wrong hash", "", { baseHash: "0".repeat(64) }, false, false],
  ["nonempty source", "Keep existing bytes.\n", { baseHash: emptyHash }, true, false],
  ["BOM is not empty", "\uFEFF", { baseHash: emptyHash }, true, false],
  ["nonempty expected hash", "Keep existing bytes.\n", { baseHash: "a".repeat(64) }, false, false],
  ["empty replacement", "", { baseHash: emptyHash, replace: "" }, false, false],
  ["wrong replacement count", "", { baseHash: emptyHash, expectedReplacements: 2 }, false, false],
]) test("empty insertion requires the current empty hash: " + name, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-empty-insert-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "marker.txt"), before);
  const args = { path: "marker.txt", search: "", replace: "Ready.\n", ...patch };
  const properties = { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" }, patch: { type: "string" }, baseHash: { type: "string" }, expectedReplacements: { type: "integer" } };
  const contract = createToolContract([{ type: "function", function: { name: "apply_patch", parameters: { type: "object", properties, additionalProperties: false } } }]);
  const call = { id: "empty_insert", type: "function", function: { name: "apply_patch", arguments: JSON.stringify(args) } };
  assert.equal(validateToolCallBatch([call], contract).ok, valid);
  const config = { baseDir: root, commandCwd: root, sandboxMode: "host", allowFileTools: true };
  if (writable) {
    const result = await executeWorkspaceTool("apply_patch", args, config); assert.equal(result.ok, true);
    assert.equal(result.change.beforeHash, emptyHash); assert.equal(result.change.beforeBytes, 0); assert.equal(result.change.replacements, 1);
  } else await assert.rejects(executeWorkspaceTool("apply_patch", args, config));
  assert.equal(await fs.readFile(path.join(root, "marker.txt"), "utf8"), writable ? "Ready.\n" : before);
});
const positives = [
  ["Please add an empty placeholder.md for later.", ["placeholder.md"]],
  ["Create a blank placeholder.md.", ["placeholder.md"]],
  ["Create a zero-byte placeholder.md.", ["placeholder.md"]],
  ["Create an empty Markdown file called placeholder.md.", ["placeholder.md"]],
  ["Create placeholder.md and leave it empty.", ["placeholder.md"]],
  ["Create `blank placeholder.md` with no content.", ["blank placeholder.md"]],
  ["Create empty first.md and second.md.", ["first.md", "second.md"]],
  ["Create an empty marker.txt.", ["marker.txt"]],
  ["Create an empty __init__.py.", ["__init__.py"]],
  ["创建一个空的 placeholder.md。", ["placeholder.md"]],
  ["创建空白文本文件 placeholder.md。", ["placeholder.md"]],
  ["空の placeholder.md を作成してください。", ["placeholder.md"]],
  ["Create an empty `草稿.md`.", ["草稿.md"]],
  ["Create an empty ./placeholder.md.", ["./placeholder.md"]],
  ["Read notes.txt and add an empty placeholder.md.", ["placeholder.md"]],
];
for (const [goal, expected] of positives) test("explicit empty file scope: " + goal, () => {
  const c = deriveScsTaskContract({ goal });
  assert.deepEqual(c.exactEmptyOutputPaths, expected);
  assert.ok(expected.every(name => c.exactOutputPaths.includes(name)));
  assert.equal(c.requiredArtifactKinds.some(r => r.extension === ".md"), false);
});
for (const goal of [
  "Create report.md from this empty table.",
  "Create report.md about empty files.",
  "Create blank-template.md with a heading.",
  "Explain how to create an empty placeholder.md; do not create files.",
  "Do not create an empty placeholder.md. Just explain it.",
  'Create report.md. Include the sentence "Create an empty placeholder.md".',
  "Create report.md with no content removed.",
  "Create report.md and do not leave it empty.",
  "不要创建空白 placeholder.md。只需解释。",
  "空の placeholder.md を作成しないでください。",
  "Run git add empty.md.",
  "git add an empty placeholder.md",
  "Add report.md to Git.",
  "Explain how to add an empty placeholder.md.",
  "如果创建空的 placeholder.md，会有什么问题？",
  "空の placeholder.md を作成したらどうなりますか。",
  "Explain how to read notes.txt and add an empty placeholder.md.",
]) test("empty-file authority is not inferred from prose or negation: " + goal, () => {
  assert.deepEqual(deriveScsTaskContract({ goal }).exactEmptyOutputPaths, []);
});
test("an empty placeholder does not remove an independent Markdown deliverable", () => {
  const c = deriveScsTaskContract({ goal: "Create an empty placeholder.md and write report.md with the supplied notes." });
  assert.deepEqual(c.exactEmptyOutputPaths, ["placeholder.md"]);
  assert.ok(c.requiredArtifactKinds.some(r => r.extension === ".md"));
});
test("current empty-file contract overrides a cached nonempty SCS document requirement", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-empty-scs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { buildSupervisorInstruction, reviewScsFinish } = await import(pathToFileURL(path.join(runtimeRoot, "src/scs-controller.js")));
  const goal = "Create an empty placeholder.md artifact.", contract = deriveScsTaskContract({ goal });
  const args = { path: "placeholder.md", content: "" };
  const result = await executeWorkspaceTool("write_file", args, { baseDir: root, commandCwd: root, sandboxMode: "host", allowFileTools: true });
  const legacy = JSON.parse(JSON.stringify(contract)); delete legacy.exactEmptyOutputPaths;
  legacy.requiredArtifactKinds = [{ id: "format:.md", kind: "format", extension: ".md", description: "Markdown document" }];
  const state = { goal, commandCwd: root, messages: [], meta: { scs: { taskContract: legacy, enabled: true } } };
  const context = { commandCwd: root, taskContract: contract, events: [{ type: "tool.completed", data: { ...result, args } }] };
  const instruction = buildSupervisorInstruction({ taskContract: contract });
  assert.match(instruction, /Exact zero-byte text output\(s\): placeholder\.md/);
  assert.doesNotMatch(instruction, /Required artifact deliverable\(s\): Markdown/);
  const decision = await reviewScsFinish(null, { commandCwd: root, scsValidationMode: "deterministic" }, state, "The empty placeholder.md exists.", context);
  assert.equal(decision.decision, "finish_allowed");
  assert.equal(state.meta.scs.taskContract, legacy, "A review does not rewrite historical state");
});
for (const extension of ["pdf", "docx", "png", "svg"]) test("empty wording does not bypass structured format: " + extension, () => {
  const c = deriveScsTaskContract({ goal: `Create an empty report.${extension}.` });
  assert.deepEqual(c.exactEmptyOutputPaths, []);
  assert.ok(c.requiredArtifactKinds.length, "Real format requirements remain");
});
for (const content of ["", "# Report\n\nVerified notes.\n"]) test("independent report needs nonempty evidence: " + JSON.stringify(content), async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-empty-independent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "placeholder.md"), ""); await fs.writeFile(path.join(root, "report.md"), content);
  const c = deriveScsTaskContract({ goal: "Create an empty placeholder.md and write report.md with the supplied notes." });
  assert.equal(evaluateScsSemanticContract(c, { commandCwd: root }).ok, content !== "");
});
test("an ordinary Markdown deliverable cannot be satisfied by zero bytes", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-empty-ordinary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "report.md"), "");
  assert.equal(evaluateScsSemanticContract(deriveScsTaskContract({ goal: "Create report.md with a short summary." }), { commandCwd: root }).ok, false);
});
test("outside targets, symlink parents and shared hardlinks cannot satisfy empty output", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-empty-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work"), outside = path.join(root, "outside"); await fs.mkdir(work); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "marker.md"), ""); await fs.symlink(outside, path.join(work, "alias"));
  await fs.writeFile(path.join(outside, "shared-source.md"), "");
  await fs.link(path.join(outside, "shared-source.md"), path.join(work, "shared.md"));
  for (const target of ["../outside/marker.md", "alias/marker.md", "shared.md"]) {
    const c = deriveScsTaskContract({ goal: `Create an empty ${target}.` });
    assert.equal(evaluateScsSemanticContract(c, { commandCwd: work }).ok, false, target);
  }
});
for (const content of ["", "\n", " ", "\uFEFF", "# Placeholder\n"]) test("content must be exactly zero bytes: " + JSON.stringify(content), async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-empty-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const goal = "Create an empty placeholder.md.", contract = deriveScsTaskContract({ goal });
  const args = { path: "placeholder.md", content, mode: "create" };
  const result = await executeWorkspaceTool("write_file", args, { baseDir: root, commandCwd: root, sandboxMode: "host", allowFileTools: true });
  assert.equal(result.ok, true);
  const state = { goal, commandCwd: root, messages: [], meta: {} };
  const events = [{ type: "tool.completed", data: { ...result, args } }];
  const semantic = evaluateScsSemanticContract(contract, { commandCwd: root, events, state });
  assert.equal(semantic.ok, content === "", JSON.stringify(semantic));
  if (content !== "") assert.deepEqual(semantic.nonemptyFiles, ["placeholder.md"]);
});
test("empty artifacts need the exact explicit contract and a real regular file", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-empty-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const goal = "Create an empty placeholder.md artifact.", contract = deriveScsTaskContract({ goal });
  const args = { path: "placeholder.md", content: "", mode: "create" };
  const result = await executeWorkspaceTool("write_file", args, { baseDir: root, commandCwd: root, sandboxMode: "host", allowFileTools: true });
  const state = { goal, commandCwd: root, messages: [], meta: {} };
  const context = { commandCwd: root, events: [{ type: "tool.completed", data: { ...result, args } }] };
  const artifact = c => buildScsEvidenceLedger({ state, context, contract: c }).items.find(r => r.category === "artifact");
  assert.equal(artifact({}).verified, false);
  assert.equal(artifact(deriveScsTaskContract({ goal: "Create other.md." })).verified, false);
  assert.equal(artifact(contract).verified, true);
  assert.equal(evaluateScsEvidence(contract, buildScsEvidenceLedger({ state, context, contract })).ok, true);
  await fs.unlink(path.join(root, "placeholder.md"));
  assert.equal(artifact(contract).verified, false);
  assert.equal(evaluateScsSemanticContract(contract, { commandCwd: root }).ok, false);
  await fs.mkdir(path.join(root, "placeholder.md"));
  assert.equal(artifact(contract).verified, false);
  await fs.rmdir(path.join(root, "placeholder.md"));
  await fs.writeFile(path.join(root, "other.md"), "");
  await fs.symlink(path.join(root, "other.md"), path.join(root, "placeholder.md"));
  assert.equal(artifact(contract).verified, false);
  assert.equal(evaluateScsSemanticContract(contract, { commandCwd: root }).ok, false);
});
for (const scsActive of [false, true]) for (const repair of [false, true]) test(`native empty-file completion and explicit saved-task continuation (SCS ${scsActive}, repair ${repair})`, { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-empty-native-"));
  const oldHome = process.env.AGINTIFLOW_HOME; process.env.AGINTIFLOW_HOME = path.join(root, "home");
  let closeIndex = () => {};
  t.after(async () => { try { closeIndex(); } finally { if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome; await fs.rm(root, { recursive: true, force: true }); } });
  const { runAgent } = await import(pathToFileURL(path.join(runtimeRoot, "src/agent-runner.js")));
  const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtimeRoot, "src/config.js")));
  const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtimeRoot, "src/session-index.js")));
  closeIndex = closeSessionIndexConnections;
  t.mock.method(globalThis, "fetch", async () => { throw Error("Offline empty-file test must not access a provider"); });
  const work = path.join(root, "work"); await fs.mkdir(work); await fs.writeFile(path.join(work, "notes.txt"), "Keep this note unchanged.\n");
  let step = 0; const offered = [];
  const actions = [["read_file", { path: "notes.txt" }], ["write_file", { path: "placeholder.md", content: repair ? "# Not empty\n" : "" }],
    ...(repair ? [["finish", { result: "Created an empty placeholder.md." }],
      ["write_file", { path: "placeholder.md", mode: "overwrite", content: "" }],
      ["read_file", { path: "placeholder.md" }],
      ["apply_patch", { path: "placeholder.md", search: "# Not empty\n", replace: "" }]] : []),
    ["finish", { result: "Created the empty placeholder.md; notes.txt is unchanged." }]];
  const clientFactory = async () => ({ chat: { completions: { create: async request => {
    assert.ok(request.tools, "No separate planning or semantic model is needed");
    const action = actions[step++]; assert.ok(action, "No producer loop after a valid empty file");
    if (action[1].search === "") assert.match(request.tools.find(tool => tool.function.name === "apply_patch").function.description, /zero-byte/);
    offered.push({ action: action[0], tools: request.tools.map(tool => tool.function.name), readPaths: request.tools.find(tool => tool.function.name === "read_file")?.function.parameters.properties.path.enum || null });
    return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `empty_${step}`, type: "function", function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } }] };
  } } } });
  clientFactory.agintiDeterministicTest = true;
  const goal = "Please add an empty placeholder.md for later. Leave notes.txt alone; no commands or installs.";
  const makeConfig = (goal, resume) => {
    const config = resolveRuntimeConfig({ provider: "openai", model: "offline-empty-file", routingMode: "manual", taskProfile: "code", goal, resume, enableScs: scsActive ? "on" : "off" },
    { baseDir: work, commandCwd: work, packageDir: runtimeRoot, sessionId: "empty-file", clientFactory, sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowMcpTools: false, allowWebSearch: false, allowParallelScouts: false });
    return Object.assign(config, { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), maxSteps: 8, dynamicSteps: "off", allowProviderHandoff: false, scsActive, scsValidationMode: "deterministic", executionPolicy: { tier: "focused", requiresPlan: false }, onConsole() {}, onLog() {} });
  };
  const config = makeConfig(goal);
  const result = await runAgent(config); assert.notEqual(result.stopped, true); assert.equal(step, actions.length);
  assert.equal((await fs.stat(path.join(work, "placeholder.md"))).size, 0); assert.equal(await fs.readFile(path.join(work, "notes.txt"), "utf8"), "Keep this note unchanged.\n");
  const session = path.join(root, "sessions/empty-file"), state = JSON.parse(await fs.readFile(path.join(session, "state.json"), "utf8"));
  assert.equal(state.meta.goalContract.status, "completed");
  const events = (await fs.readFile(path.join(session, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.type === "tool.started" && e.data.toolName === "finish").length, repair ? 2 : 1);
  if (repair) assert.ok(events.some(e => e.type === "tool.blocked" && e.data.category === "workspace-overwrite"));
  const mutationCount = events.filter(e => e.type === "file.changed").length;
  const again = await runAgent({ ...makeConfig("Continue the same task.", "empty-file"), expectedRuntimeRevision: 1 });
  assert.notEqual(again.stopped, true); assert.equal(step, actions.length, "Completed replay never redispatches provider or producer");
  const replayEvents = (await fs.readFile(path.join(session, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(replayEvents.filter(e => e.type === "file.changed").length, mutationCount);
  const replayState = JSON.parse(await fs.readFile(path.join(session, "state.json"), "utf8"));
  assert.equal(replayState.meta.runtimeConfig.revision, 1, "No runtime patch means no configuration revision advance");
  const completedSteps = step;
  actions.push(["read_file", { path: "notes.txt" }], ["read_file", { path: "placeholder.md" }], ["apply_patch", { path: "placeholder.md", search: "", replace: "# Ready\n", baseHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }],
    ["finish", { result: "Replaced placeholder.md with the requested heading; notes.txt is unchanged." }]);
  const next = makeConfig("Read notes.txt and replace placeholder.md with a single heading, # Ready. Leave notes.txt unchanged.", "empty-file");
  const updated = await runAgent({ ...next, expectedRuntimeRevision: 1 });
  assert.notEqual(updated.stopped, true, JSON.stringify({ updated, step, expected: completedSteps + 4, offered })); assert.equal(step, completedSteps + 4);
  assert.deepEqual(offered[completedSteps].readPaths, ["notes.txt"], "A prior-goal note read cannot skip current input authority");
  assert.deepEqual(offered[completedSteps + 1].readPaths, ["placeholder.md"], "Input data does not replace the canonical-target read");
  assert.equal(await fs.readFile(path.join(work, "placeholder.md"), "utf8"), "# Ready\n");
  const after = JSON.parse(await fs.readFile(path.join(session, "state.json"), "utf8"));
  assert.equal(after.meta.goalContract.status, "completed");
  const { completionTaskContract } = await import(pathToFileURL(path.join(runtimeRoot, "src/agent-runner.js")));
  assert.deepEqual(completionTaskContract(next, after).exactEmptyOutputPaths, [], "Prior emptiness cannot leak into a new content request");
});
