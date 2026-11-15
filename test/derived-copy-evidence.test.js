import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { deriveScsTaskContract, evaluateScsSemanticContract } from "../src/scs-evidence.js";
import { executeWorkspaceTool } from "../src/workspace-tools.js";

const goal = "Copy template.txt to draft.txt, then change the title in draft.txt from Blue Project to Green Project. Keep template.txt unchanged; no commands or installs.";
const phaseGoal = "Copy template.txt to draft.txt. Then edit draft.txt. Keep template.txt unchanged; no commands or installs.";
const original = "Title: Blue Project\nStatus: Draft for independent review\n";
const customized = original.replace("Blue Project", "Green Project");
const hash = text => createHash("sha256").update(text).digest("hex");

for (const request of [goal, "Copy template.txt to draft.txt. Then edit draft.txt.",
  "请复制 template.txt 到 draft.txt；然后修改 draft.txt 的标题。",
  "template.txt を draft.txt にコピーしてください。draft.txt を更新してください。",
]) test("a direct later destination edit has a distinct copy phase: " + request, () => {
  const contract = deriveScsTaskContract({ goal: request });
  assert.equal(contract.exactCopyRequirements[0].destinationMayChange, true);
  assert.equal(contract.exactCopyRequirements[0].sourceMayChange, undefined);
  assert.ok(contract.preservedInputPaths.includes("template.txt"));
});
for (const request of ["Copy template.txt to draft.txt.",
  "Edit draft.txt. Then copy template.txt to draft.txt.",
  "Copy template.txt to draft.txt. Explain how to edit draft.txt.",
  'Copy template.txt to draft.txt. Quote "edit draft.txt" in brief.txt.',
  "Copy template.txt to draft.txt. Do not edit draft.txt.",
  "Copy template.txt to draft.txt. Then write brief.txt about draft.txt.",
]) test("an indirect, forbidden or earlier destination edit cannot relax final bytes: " + request, () => {
  const pair = deriveScsTaskContract({ goal: request }).exactCopyRequirements[0];
  assert.equal(pair.destinationMayChange, undefined);
});

async function fixture(t, request = goal) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-derived-copy-proof-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "template.txt"), original);
  const state = { goal: request, meta: { goalContract: { revision: 1, taskGoal: request, history: [{ revision: 1, kind: "initial", hash: hash(request) }] }, projectVerification: { mutationHistory: [] } } };
  const events = [], config = { baseDir: root, commandCwd: root, allowFileTools: true, sandboxMode: "host" };
  const contract = deriveScsTaskContract({ goal: request });
  let mutationRevision = 0;
  async function tool(name, args) {
    events.push({ type: "tool.started", data: { toolName: name, args } });
    const data = await executeWorkspaceTool(name, args, config);
    const revision = state.meta.goalContract.revision;
    const native = { ...data, args, goalRevision: revision };
    if (data.change?.ok) {
      native.projectMutationRevision = ++mutationRevision;
      state.meta.projectVerification.mutationHistory.push({ revision: mutationRevision, goalRevision: revision, taskHash: hash(request), paths: [data.path] });
    }
    events.push({ type: "tool.completed", data: native });return native;
  }
  const read = () => tool("read_file", { path: "template.txt" });
  const copy = () => tool("write_file", { path: "draft.txt", copyFromPath: "template.txt", copyFromSha256: hash(original) });
  const edit = () => tool("apply_patch", { path: "draft.txt", search: "Blue Project", replace: "Green Project" });
  const evaluate = () => evaluateScsSemanticContract(contract, { commandCwd: root, events, state });
  return { root, state, events, contract, tool, read, copy, edit, evaluate };
}

test("an actual byte-copy followed by an owned native edit verifies the current derived file", async t => {
  const f = await fixture(t);await f.read();await f.copy();await f.edit();
  assert.equal(await fs.readFile(path.join(f.root, "template.txt"), "utf8"), original);
  assert.equal(await fs.readFile(path.join(f.root, "draft.txt"), "utf8"), customized);
  assert.equal(f.evaluate().exactCopies.ok, true);
});
for (const mode of ["copy-only", "copy-then-undo", "no-copy", "wrong-copy", "wrong-before-hash", "missing-mutation", "wrong-task", "reordered", "duplicate-revision", "string-revision", "change-not-ok", "wrong-change-path", "wrong-content-hash", "unsettled-write", "unknown-mutator", "destination-drift", "source-drift"]) {
  test("derived copy provenance fails closed: " + mode, async t => {
    const f = await fixture(t, phaseGoal);await f.read();
    if (mode === "copy-only") await f.copy();
    else if (mode === "no-copy") await f.tool("write_file", { path: "draft.txt", content: customized });
    else if (mode === "wrong-copy") {
      await f.tool("write_file", { path: "draft.txt", content: "Wrong initial text.\n" });
      await f.tool("apply_patch", { path: "draft.txt", search: "Wrong initial text.\n", replace: customized });
    } else { await f.copy();await f.edit(); }
    const last = f.events.at(-1).data;
    if (mode === "wrong-before-hash") last.change.beforeHash = hash("Not the copied snapshot");
    if (mode === "missing-mutation") f.state.meta.projectVerification.mutationHistory.pop();
    if (mode === "wrong-task") f.state.meta.projectVerification.mutationHistory[0].taskHash = hash("Another task");
    if (mode === "reordered") [f.events[3], f.events[5]] = [f.events[5], f.events[3]];
    if (mode === "duplicate-revision") last.projectMutationRevision = 1;
    if (mode === "string-revision") { last.projectMutationRevision = "2";f.state.meta.projectVerification.mutationHistory.at(-1).revision = "2"; }
    if (mode === "change-not-ok") last.change.ok = false;
    if (mode === "wrong-change-path") last.change.path = "other.txt";
    if (mode === "wrong-content-hash") last.change.contentSha256 = hash("Unproven content");
    if (mode === "unsettled-write") f.events.push({ type: "tool.started", data: { toolName: "apply_patch", args: { path: "draft.txt" } } });
    if (mode === "unknown-mutator") f.events.push({ type: "tool.started", data: { toolName: "run_command", args: {} } });
    if (mode === "destination-drift") await fs.writeFile(path.join(f.root, "draft.txt"), customized + "Unrecorded change.\n");
    if (mode === "source-drift") await fs.writeFile(path.join(f.root, "template.txt"), customized);
    if (mode === "copy-then-undo") await f.tool("apply_patch", { path: "draft.txt", search: "Green Project", replace: "Blue Project" });
    assert.equal(f.evaluate().exactCopies.ok, false);
  });
}
test("a genuine repaired copy can precede the separately authorized edit", async t => {
  const f = await fixture(t);await f.read();await f.tool("write_file", { path: "draft.txt", content: "Wrong.\n" });
  await f.tool("apply_patch", { path: "draft.txt", search: "Wrong.\n", replace: original });await f.edit();
  assert.equal(f.evaluate().exactCopies.ok, true);
});
test("two ordered destination edits retain the entire native hash chain", async t => {
  const f = await fixture(t, phaseGoal);await f.read();await f.copy();await f.edit();
  await f.tool("apply_patch", { path: "draft.txt", search: "Green Project", replace: "Final Project" });
  assert.equal(f.evaluate().exactCopies.ok, true);
});
for (const missingHash of [false, true]) test("only proven same-task continuation can retain a prior copy and edit: " + missingHash, async t => {
  const f = await fixture(t);await f.read();await f.copy();
  f.state.meta.goalContract.revision = 2;f.state.meta.goalContract.history.push({ revision: 2, relation: "same-task", ...(missingHash ? {} : { taskHash: hash(goal) }) });
  f.events.push({ type: "conversation.continued", data: { preservesTaskBoundary: true } });await f.edit();
  assert.equal(f.evaluate().exactCopies.ok, !missingHash);
});
test("a new task boundary cannot inherit an earlier copy receipt", async t => {
  const f = await fixture(t);await f.read();await f.copy();
  f.state.meta.goalContract.revision = 2;f.state.meta.goalContract.history.push({ revision: 2, relation: "new-request", taskHash: hash("Different request") });
  f.events.push({ type: "conversation.continued", data: { preservesTaskBoundary: false } });await f.edit();
  assert.equal(f.evaluate().exactCopies.ok, false);
});
test("derived-copy permission does not bypass independent requested text evidence", async t => {
  const request = goal + " Include `approval pending` in draft.txt.";
  const f = await fixture(t, request);await f.read();await f.copy();await f.edit();
  assert.equal(f.evaluate().exactCopies.ok, true);assert.equal(f.evaluate().ok, false);
});

test("one combined native publication can prove an exact requested unique replacement", async t => {
  const f = await fixture(t);assert.deepEqual(f.contract.exactCopyRequirements[0].destinationReplacement, { search: "Blue Project", replace: "Green Project" });
  await f.read();await f.tool("write_file", { path: "draft.txt", content: customized });
  const result = f.evaluate().exactCopies;assert.equal(result.ok, true);assert.equal(result.receipts[0].derivation, "literal-replacement");
  assert.equal(result.receipts[0].copiedSha256, undefined);assert.equal(result.receipts[0].derivedFromSha256, hash(original));
});
for (const mode of ["wrong-title", "unrequested-status", "missing-read", "unowned-write", "preexisting-derived-file"]) test("deterministic derivation rejects unsupported evidence: " + mode, async t => {
  const f = await fixture(t);if (mode !== "missing-read") await f.read();
  const content = mode === "wrong-title" ? original.replace("Blue Project", "Red Project") : mode === "unrequested-status" ? customized.replace("Draft for independent review", "Approved") : customized;
  if (mode === "preexisting-derived-file") await fs.writeFile(path.join(f.root, "draft.txt"), content);
  else await f.tool("write_file", { path: "draft.txt", content });
  if (mode === "unowned-write") f.state.meta.projectVerification.mutationHistory.length = 0;
  assert.equal(f.evaluate().exactCopies.ok, false);
});
for (const suffix of [" Then add a paragraph in draft.txt.", " Then write another.txt.", " Then update draft.txt again."]) test("an additional mutation is not silently collapsed into one replacement: " + suffix, () => {
  assert.equal(deriveScsTaskContract({ goal: goal + suffix }).exactCopyRequirements[0].destinationReplacement, undefined);
});
for (const suffix of [" Do not write any other file.", " Do not create another file.", " Don't modify any other file.", " Never append anything else."]) test("a prohibition is not an additional mutation: " + suffix, () => {
  assert.deepEqual(deriveScsTaskContract({ goal: goal + suffix }).exactCopyRequirements[0].destinationReplacement, { search: "Blue Project", replace: "Green Project" });
});
for (const suffix of [" Do not create another file; then add a paragraph in draft.txt.", " Do not write elsewhere. Then modify draft.txt again."]) test("a prohibition cannot erase a later positive edit: " + suffix, () => {
  assert.equal(deriveScsTaskContract({ goal: goal + suffix }).exactCopyRequirements[0].destinationReplacement, undefined);
});
for (const malformed of ["from Blue Project to Green Project and add more text", "from Blue Project to Green Project then remove the status", "from Blue Project to Blue Project", "from Blue Project to Green\tProject"]) test("ambiguous or unsupported literal replacement is not inferred: " + malformed, () => {
  const request = "Copy template.txt to draft.txt. Then change the title in draft.txt " + malformed + ". Keep template.txt unchanged.";
  assert.equal(deriveScsTaskContract({ goal: request }).exactCopyRequirements[0].destinationReplacement, undefined);
});
test("a rejected undispatched tool batch cannot poison a later authorized source read", async t => {
  const f = await fixture(t);f.events.push({ type: "tool.failed", data: { toolName: "tool_call_batch", blocked: true, category: "tool-contract-violation" } });
  await f.read();await f.tool("write_file", { path: "draft.txt", content: customized });assert.equal(f.evaluate().exactCopies.ok, true);
});
for (const alter of [data => { data.blocked = false; }, data => { data.category = "execution-failed"; }, data => { data.toolName = "run_command"; }]) test("other unknown failures still revoke unproven source history", async t => {
  const f = await fixture(t);const data = { toolName: "tool_call_batch", blocked: true, category: "tool-contract-violation" };alter(data);f.events.push({ type: "tool.failed", data });
  await f.read();await f.tool("write_file", { path: "draft.txt", content: customized });assert.equal(f.evaluate().exactCopies.ok, false);
});
test("ambiguous repeated source text cannot prove a combined replacement write", async t => {
  const f = await fixture(t), repeated = original + "Reference: Blue Project\n";await fs.writeFile(path.join(f.root, "template.txt"), repeated);
  await f.read();await f.tool("write_file", { path: "draft.txt", content: repeated.replace("Blue Project", "Green Project") });assert.equal(f.evaluate().exactCopies.ok, false);
});
for (const replacement of ['" Green Project "', '"Road to Knowledge"']) test("quoted replacement bytes stay exact: " + replacement, async t => {
  const request = `Copy template.txt to draft.txt. Then change the title in draft.txt from "Blue Project" to ${replacement}. Keep template.txt unchanged.`;
  const f = await fixture(t, request), value = replacement.slice(1, -1);await f.read();await f.tool("write_file", { path: "draft.txt", content: original.replace("Blue Project", value) });
  assert.equal(f.contract.exactCopyRequirements[0].destinationReplacement.replace, value);assert.equal(f.evaluate().exactCopies.ok, true);
});
test("a unique multilingual replacement preserves BOM, CRLF and every unrelated byte", async t => {
  const request = 'Copy template.txt to draft.txt. Then change the title in draft.txt from "蓝色项目" to "绿色项目". Keep template.txt unchanged.';
  const f = await fixture(t, request), input = "\uFEFFTitle: 蓝色项目\r\nStatus: Draft for independent review\r\n", output = input.replace("蓝色项目", "绿色项目");
  await fs.writeFile(path.join(f.root, "template.txt"), input);await f.read();await f.tool("write_file", { path: "draft.txt", content: output });
  assert.equal(f.evaluate().exactCopies.ok, true);assert.equal(await fs.readFile(path.join(f.root, "draft.txt"), "utf8"), output);
});
test("a source replacement during final destination hashing invalidates cached derivation", async t => {
  const f = await fixture(t);await f.read();await f.tool("write_file", { path: "draft.txt", content: customized });
  const open = fsSync.openSync, read = fsSync.readSync;let destinationFd, changed = false;
  t.mock.method(fsSync, "openSync", function (file, ...args) { const fd = Reflect.apply(open, fsSync, [file, ...args]);if (file === path.join(f.root, "draft.txt")) destinationFd = fd;return fd; });
  t.mock.method(fsSync, "readSync", function (fd, ...args) { if (fd === destinationFd && !changed) { changed = true;fsSync.renameSync(path.join(f.root, "template.txt"), path.join(f.root, "old.txt"));fsSync.writeFileSync(path.join(f.root, "template.txt"), original); }return Reflect.apply(read, fsSync, [fd, ...args]); });
  assert.equal(f.evaluate().exactCopies.ok, false);assert.equal(changed, true);
});

for (const scsActive of [false, true]) for (const { pause, combined } of [{ pause: false, combined: false }, { pause: true, combined: false }, { pause: false, combined: true }]) test(`native copy/customize persists ordered proof (SCS ${scsActive}, pause ${pause}, combined ${combined})`, { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-derived-copy-native-")), previousHome = process.env.AGINTIFLOW_HOME;
  process.env.AGINTIFLOW_HOME = path.join(root, "agent");
  let closeIndex = () => {};t.after(async () => { closeIndex();if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME;else process.env.AGINTIFLOW_HOME = previousHome;await fs.rm(root, { recursive: true, force: true }); });
  t.mock.method(globalThis, "fetch", async () => { throw Error("Native derived-copy regression must stay offline"); });
  const { runAgent } = await import("../src/agent-runner.js"), { resolveRuntimeConfig } = await import("../src/config.js");
  closeIndex = (await import("../src/session-index.js")).closeSessionIndexConnections;
  const work = path.join(root, "work");await fs.mkdir(work);await fs.writeFile(path.join(work, "template.txt"), original);
  let step = 0, inspections = 0;
  const actions = combined ? [["read_file", { path: "template.txt" }], ["write_file", { path: "draft.txt", content: customized }], ["finish", { result: "Created draft.txt with the Green Project title; template.txt is unchanged." }]] : [["read_file", { path: "template.txt" }], ["write_file", { path: "draft.txt", copyFromPath: "template.txt", copyFromSha256: hash(original) }],
    ["read_file", { path: "draft.txt" }], ["apply_patch", { path: "draft.txt", search: "Blue Project", replace: "Green Project" }],
    ["finish", { result: "Created draft.txt with the Green Project title; template.txt is unchanged." }]];
  const clientFactory = async () => ({ chat: { completions: { create: async request => {
    if (!request.tools) return { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "1. Read the template.\n2. Copy it.\n3. Change the draft title, verify both files and finish." } }] };
    const setup = actions[step]?.[0] === "read_file" && !request.tools.some(tool => tool.function.name === "read_file") && request.tools.some(tool => tool.function.name === "inspect_project");
    if (setup) assert.equal(inspections++, 0);
    const action = setup ? ["inspect_project", {}] : actions[step++];assert.ok(action, "No copy regeneration or model turn after verified customization");
    return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `derived_${inspections}_${step}`, type: "function", function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } }] };
  } } } });clientFactory.agintiDeterministicTest = true;
  const config = (request, resume, maxSteps) => Object.assign(resolveRuntimeConfig({ provider: "openai", model: "offline-derived-copy", routingMode: "manual", taskProfile: "code", goal: request, resume, enableScs: scsActive ? "on" : "off" },
    { baseDir: work, commandCwd: work, packageDir: path.resolve(import.meta.dirname, ".."), sessionId: "derived-copy", clientFactory, sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowMcpTools: false, allowWebSearch: false, allowParallelScouts: false }),
  { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), maxSteps, dynamicSteps: "off", allowProviderHandoff: false, scsActive, scsValidationMode: "deterministic", executionPolicy: { tier: "focused", requiresPlan: false }, onConsole() {}, onLog() {} });
  let result = await runAgent(config(goal, undefined, pause ? 3 : 8));
  if (pause) {
    assert.equal(result.stopped, true);assert.equal(await fs.readFile(path.join(work, "draft.txt"), "utf8"), original);
    result = await runAgent({ ...config("Continue the same task.", "derived-copy", 8), expectedRuntimeRevision: 1 });
  }
  assert.notEqual(result.stopped, true, JSON.stringify(result));assert.equal(step, actions.length);
  assert.equal(await fs.readFile(path.join(work, "draft.txt"), "utf8"), customized);assert.equal(await fs.readFile(path.join(work, "template.txt"), "utf8"), original);
  const events = (await fs.readFile(path.join(root, "sessions/derived-copy/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.type === "tool.completed" && e.data.toolName === "write_file").length, 1);
  assert.equal(events.filter(e => e.type === "tool.completed" && e.data.toolName === "apply_patch").length, combined ? 0 : 1);
  const before = step;const replay = await runAgent({ ...config("Continue the same task.", "derived-copy", 8), expectedRuntimeRevision: 1 });
  assert.notEqual(replay.stopped, true);assert.equal(step, before);
});
