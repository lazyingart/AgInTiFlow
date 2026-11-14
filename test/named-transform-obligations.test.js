import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtimeRoot = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { runAgent, preservedInputMutationBlock } = await import(pathToFileURL(path.join(runtimeRoot, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtimeRoot, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtimeRoot, "src/session-index.js")));
const { deriveScsTaskContract } = await import(pathToFileURL(path.join(runtimeRoot, "src/scs-evidence.js")));

for (const verb of ["turn", "convert", "transform", "tidy", "clean"]) {
  for (const destination of ["readings.csv", "./readings.csv", "sub/../readings.csv"]) test(`a ${verb} source is not new-file authority: ${destination}`, () => {
    const goal = `Please ${verb} readings.csv into ${destination}. Leave readings.csv alone.`;
    const contract = deriveScsTaskContract({ goal });
    assert.deepEqual(contract.preservedInputPaths, ["readings.csv"]);
    for (const target of ["readings.csv", destination]) assert.equal(preservedInputMutationBlock({ goal }, "apply_patch", { path: target, search: "old", replace: "bad" }, { goal })?.category, "preserved-input-mutation");
    const reverse = `Please ${verb} ${destination} into readings.csv. Leave ${destination} alone.`;
    assert.deepEqual(deriveScsTaskContract({ goal: reverse }).preservedInputPaths.map(value => path.posix.normalize(value)), ["readings.csv"]);
    assert.equal(preservedInputMutationBlock({ goal: reverse }, "apply_patch", { path: "readings.csv", search: "old", replace: "bad" }, { goal: reverse })?.category, "preserved-input-mutation");
  });
  test(`a genuine new ${verb} destination may be created and then preserved`, () => {
    const contract = deriveScsTaskContract({ goal: `Please ${verb} readings.csv into a new brief.md. Leave brief.md alone.` });
    assert.deepEqual(contract.exactOutputPaths, ["brief.md"]);
    assert.deepEqual(contract.preservedInputPaths, []);
    assert.deepEqual(contract.exactInputPaths, ["readings.csv"]);
    for (const goal of [
      `Create brief.md. Explain "${verb} brief.md into report.md". Leave brief.md alone.`,
      `Please ${verb} readings.csv into Readings.csv. Leave Readings.csv alone.`,
      `Please ${verb} source/readings.csv into output/readings.csv. Leave output/readings.csv alone.`,
    ]) assert.deepEqual(deriveScsTaskContract({ goal }).preservedInputPaths, [], goal);
  });
}

test("every bounded transformation operand retains preservation authority", () => {
  const goal = 'Please tidy "source readings.csv" and other.csv into "source readings.csv". Leave "source readings.csv" and other.csv alone.';
  assert.deepEqual(deriveScsTaskContract({ goal }).preservedInputPaths, ["source readings.csv", "other.csv"]);
  for (const target of ["source readings.csv", "other.csv"]) assert.equal(preservedInputMutationBlock({ goal }, "write_file", { path: target, content: "bad" }, { goal })?.category, "preserved-input-mutation");
});

for (const scsActive of [false, true]) test(`native source cannot be overwritten by synthetic create authority (SCS ${scsActive})`, { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-transform-preserve-"));
  const previousHome = process.env.AGINTIFLOW_HOME; process.env.AGINTIFLOW_HOME = path.join(root, "home");
  t.mock.method(globalThis, "fetch", async () => { throw Error("Offline source preservation must not access the network"); });
  t.after(async () => {
    closeSessionIndexConnections();
    if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const work = path.join(root, "work"); await fs.mkdir(work);
  const csv = "id,value\na,02.50\n"; await fs.writeFile(path.join(work, "readings.csv"), csv);
  let step = 0;
  const clientFactory = async () => ({ chat: { completions: { create: async request => {
    if (!request.tools) return { choices: [{ message: { role: "assistant", content: "Inspect the source and preserve its original bytes." } }] };
    const actions = [["read_file", { path: "readings.csv" }], ["apply_patch", { path: "readings.csv", search: "02.50", replace: "2.5" }]];
    const action = actions[step++]; assert.ok(action, "unexpected source-preservation model turn");
    return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: `source_${step}`, type: "function", function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } }] };
  } } } });
  clientFactory.agintiDeterministicTest = true;
  const config = resolveRuntimeConfig({ provider: "openai", model: "offline-source-preservation", routingMode: "manual", taskProfile: "code",
    enableScs: scsActive ? "on" : "off", goal: "Please tidy readings.csv into readings.csv. Leave readings.csv alone; no installs." }, {
    baseDir: work, commandCwd: work, packageDir: runtimeRoot, sessionId: "source-preservation", clientFactory,
    sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: false,
    allowWrapperTools: false, allowAuxiliaryTools: false, allowMcpTools: false, allowWebSearch: false, allowParallelScouts: false,
  });
  Object.assign(config, { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
    maxSteps: 2, dynamicSteps: "off", allowProviderHandoff: false, scsActive, scsValidationMode: "deterministic",
    executionPolicy: { tier: "focused", requiresPlan: false }, onConsole() {}, onLog() {} });
  const result = await runAgent(config);
  assert.equal(step, 2);
  assert.equal(await fs.readFile(path.join(work, "readings.csv"), "utf8"), csv, "synthetic output creation must not authorize source overwrite");
  assert.equal(result.stopped, true);
  const state = JSON.parse(await fs.readFile(path.join(root, "sessions/source-preservation/state.json"), "utf8"));
  assert.notEqual(state.meta.goalContract.status, "completed");
  assert.equal(state.meta.projectVerification.mutationRevision, 0);
  const events = (await fs.readFile(path.join(root, "sessions/source-preservation/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(events.some(event => event.type === "tool.blocked" && event.data.category === "preserved-input-mutation"));
});

for (const goal of [
  "Please tidy readings.csv into brief.md and brief.json. Leave readings.csv alone; no installs.",
  "Could you clean readings.csv into a JSON list brief.json and brief.md? Leave the source alone.",
  "Tidy `inputs/current readings.csv` into brief.md and brief.json. Leave `inputs/current readings.csv` alone.",
  "Read readings.csv and write brief.md and brief.json. Leave readings.csv alone.",
]) test(`named operands retain their roles: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
  const input = goal.includes("inputs/") ? "inputs/current readings.csv" : "readings.csv";
  assert.deepEqual(contract.exactInputPaths, [input]);
  assert.deepEqual([...contract.exactOutputPaths].sort(), ["brief.json", "brief.md"]);
  assert.deepEqual(contract.preservedInputPaths, [input]);
  assert.equal(contract.requiresWorkspaceMutation, true);
  assert.equal(contract.requiresFileMutation, true);
  assert.ok(contract.requiredEvidence.some(item => item.category === "file"));
});

for (const goal of [
  "Explain how to tidy readings.csv into brief.md; no tools or files.",
  "Do not tidy readings.csv into brief.md. Answer in chat only.",
  "Please say 'tidy readings.csv into brief.md' in your reply.",
  'Print "clean readings.csv into brief.md" only.',
  "The example is: `tidy readings.csv into brief.md`.",
  "If we tidy readings.csv into brief.md, what could go wrong?",
  "I already cleaned readings.csv into brief.md. Explain the format.",
  "Please tidy the wording into a clearer reply.",
  "Tidy readings.csv into a paragraph in this reply; no files.",
]) test(`non-executable wording grants no transform authority: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal });
  assert.equal(contract.requiresFileMutation, false);
  assert.equal(contract.requiresWorkspaceMutation, false);
  assert.deepEqual(contract.exactOutputPaths, []);
});

test("quoted preservation text is not a second input instruction", () => {
  const contract = deriveScsTaskContract({ goal: 'Tidy readings.csv into brief.md. Say "leave unrelated.csv alone" in the answer.' });
  assert.deepEqual(contract.preservedInputPaths, []);
  assert.deepEqual(contract.exactInputPaths, ["readings.csv"]);
  assert.deepEqual(contract.exactOutputPaths, ["brief.md"]);
});

for (const suffix of ["Do not leave readings.csv alone.", "Explain how to leave readings.csv alone.", 'Say "leave readings.csv alone".']) test(`preservation requires a real affirmative instruction: ${suffix}`, () => {
  const contract = deriveScsTaskContract({ goal: `Update readings.csv. ${suffix}` });
  assert.deepEqual(contract.preservedInputPaths, []);
  assert.deepEqual(contract.exactOutputPaths, ["readings.csv"]);
});

for (const staleOutputs of [false, true]) for (const scsActive of [false, true]) test(`persisted named transformation enforces fresh outputs (SCS ${scsActive}, stale ${staleOutputs})`, { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-named-transform-"));
  const previousHome = process.env.AGINTIFLOW_HOME;
  process.env.AGINTIFLOW_HOME = path.join(root, "home");
  t.mock.method(globalThis, "fetch", async () => { throw Error("Offline regression must not access the network"); });
  t.after(async () => {
    closeSessionIndexConnections();
    if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME;
    else process.env.AGINTIFLOW_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const work = path.join(root, "work");
  await fs.mkdir(work);
  const csv = "id,value\na,2\nb,3\n";
  const markdown = "# Readings\n\n| id | value |\n| --- | --- |\n| a | 2 |\n| b | 3 |\n";
  const json = JSON.stringify([{ id: "a", value: 2 }, { id: "b", value: 3 }], null, 2) + "\n";
  await fs.writeFile(path.join(work, "readings.csv"), csv);
  if (staleOutputs) {
    await fs.writeFile(path.join(work, "brief.md"), "# Old readings\n\nStale, unrelated content.\n");
    await fs.writeFile(path.join(work, "brief.json"), '[{"id":"stale","value":999}]\n');
  }
  const actions = [
    ["read_file", { path: "readings.csv" }],
    ...(staleOutputs ? [["read_file", { path: "brief.md" }], ["read_file", { path: "brief.json" }]] : []),
    ["finish", { result: "Done." }],
    ["apply_patch", { path: "readings.csv", search: "a,2", replace: "a,999" }],
    staleOutputs ? ["apply_patch", { path: "brief.md", search: "# Old readings\n\nStale, unrelated content.\n", replace: markdown }]
      : ["write_file", { path: "brief.md", content: markdown }],
    ["finish", { result: "Done." }],
    staleOutputs ? ["apply_patch", { path: "brief.json", search: '[{"id":"stale","value":999}]\n', replace: json }]
      : ["write_file", { path: "brief.json", content: json }],
    ["finish", { result: "Created brief.md and brief.json from readings.csv. The source CSV is unchanged." }],
  ];
  let requests = 0;
  const events = [];
  const clientFactory = async () => ({ chat: { completions: { create: async request => {
    if (!request.tools) return { choices: [{ message: { role: "assistant", content: "Read the source, create both outputs, and finish only after checking them." } }] };
    const action = actions[requests++];
    assert.ok(action, "unexpected extra model request");
    assert.ok(request.tools.some(tool => tool.function.name === action[0]), JSON.stringify({ action, offered: request.tools.map(tool => tool.function.name), feedback: request.messages.at(-1) }));
    return { choices: [{ index: 0, finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: `transform_${requests}`, type: "function",
        function: { name: action[0], arguments: JSON.stringify(action[1]) } }],
    } }] };
  } } } });
  clientFactory.agintiDeterministicTest = true;
  const config = resolveRuntimeConfig({ provider: "openai", model: "offline-transform", routingMode: "manual",
    goal: "Please tidy readings.csv into brief.md and brief.json. Leave readings.csv alone; no installs.",
    taskProfile: "code", enableScs: scsActive ? "on" : "off" }, {
    baseDir: work, commandCwd: work, packageDir: runtimeRoot, sessionId: "named-transform", clientFactory,
    sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: false,
    allowWrapperTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false,
  });
  Object.assign(config, { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"),
    projectSessionsDir: path.join(root, "pointers"), maxSteps: staleOutputs ? 4 : 12, dynamicSteps: "off", allowProviderHandoff: false,
    scsActive, scsValidationMode: "deterministic", executionPolicy: { tier: "focused", requiresPlan: false },
    onConsole() {}, onLog() {}, onEvent(type, data) { events.push({ type, data }); } });
  const result = await runAgent(config);
  if (staleOutputs) {
    assert.equal(requests, 4);
    assert.equal(result.stopped, true, "pre-existing files must not satisfy a new transformation");
    const state = JSON.parse(await fs.readFile(path.join(root, "sessions/named-transform/state.json"), "utf8"));
    assert.notEqual(state.meta.goalContract.status, "completed");
    assert.equal(state.meta.projectVerification.mutationRevision, 0);
    assert.equal(await fs.readFile(path.join(work, "readings.csv"), "utf8"), csv);
    assert.equal(await fs.readFile(path.join(work, "brief.md"), "utf8"), "# Old readings\n\nStale, unrelated content.\n");
    assert.equal(await fs.readFile(path.join(work, "brief.json"), "utf8"), '[{"id":"stale","value":999}]\n');
    return;
  }
  assert.notEqual(result.stopped, true, JSON.stringify({ result, violations: events.filter(event => /contract|blocked/.test(event.type)) }));
  const initialRequests = staleOutputs ? 9 : 7;
  assert.equal(requests, initialRequests, "a generic finish escaped the missing-output gate");
  assert.equal(await fs.readFile(path.join(work, "brief.md"), "utf8"), markdown);
  assert.equal(await fs.readFile(path.join(work, "brief.json"), "utf8"), json);
  assert.equal(await fs.readFile(path.join(work, "readings.csv"), "utf8"), csv);
  const state = JSON.parse(await fs.readFile(path.join(root, "sessions/named-transform/state.json"), "utf8"));
  assert.equal(state.meta.activeExecutionContract.requiresFileMutation, true);
  const persistedContract = deriveScsTaskContract({ goal: state.meta.goalContract.taskGoal });
  assert.deepEqual(persistedContract.exactInputPaths, ["readings.csv"]);
  assert.deepEqual(persistedContract.exactOutputPaths, ["brief.md", "brief.json"]);
  assert.equal(state.meta.goalContract.status, "completed");
  assert.equal(events.filter(event => event.type === "completion.evidence_rejected").length, 2, "both premature finishes must be rejected");
  assert.equal(events.filter(event => event.type === "tool.blocked" && event.data.category === "preserved-input-mutation").length, 1);
  assert.equal((await runAgent({ ...config, resume: "named-transform", goal: "Continue the same task." })).goalStatus, "completed");
  assert.equal(requests, initialRequests, "completed-task replay must not repeat model calls or writes");
  actions.push(
    ["read_file", { path: "readings.csv" }],
    ["read_file", { path: "brief.md" }],
    ["read_file", { path: "brief.json" }],
    ["finish", { result: "Done." }],
    ["write_file", { path: "followup.md", content: markdown }],
    ["write_file", { path: "followup.json", content: json }],
    ["finish", { result: "Created followup.md and followup.json. The CSV and earlier files are unchanged." }],
  );
  const followup = await runAgent({ ...config, resume: "named-transform",
    goal: "Also clean readings.csv into followup.md and followup.json. Leave the source and earlier outputs unchanged." });
  assert.equal(followup.goalStatus, "completed", JSON.stringify(followup));
  assert.equal(requests, initialRequests + 7, "follow-up must enforce fresh outputs rather than borrow the old completion");
  for (const file of ["brief.md", "followup.md"]) assert.equal(await fs.readFile(path.join(work, file), "utf8"), markdown);
  for (const file of ["brief.json", "followup.json"]) assert.equal(await fs.readFile(path.join(work, file), "utf8"), json);
  assert.equal(await fs.readFile(path.join(work, "readings.csv"), "utf8"), csv);
});
