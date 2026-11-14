import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const runtimeRoot = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { deriveScsTaskContract, evaluateScsSemanticContract } = await import(pathToFileURL(path.join(runtimeRoot, "src/scs-evidence.js")));
const { executeWorkspaceTool } = await import(pathToFileURL(path.join(runtimeRoot, "src/workspace-tools.js")));
const { createToolContract, resolveDispatchableToolCallBatch } = await import(pathToFileURL(path.join(runtimeRoot, "src/tool-contract.js")));
const { requestNextStep } = await import(pathToFileURL(path.join(runtimeRoot, "src/model-client.js")));
const goal = "Please make a copy of notes.txt as notes-backup.txt. Leave the original alone; no commands or installs.";
const raw = "\uFEFF# Draft notes\r\n\r\nStatus: needs review\r\nCode: AB-007\r\n";
const hash = text => createHash("sha256").update(text).digest("hex");
const readEvent = (file = "notes.txt") => ({ type: "tool.completed", data: { ok: true, toolName: "read_file", path: file, sha256: hash(raw), goalRevision: 1 } });

for (const request of [goal, "Copy notes.txt to notes-backup.txt without changing the original.",
  "Duplicate notes.txt into notes-backup.txt.", "Back up notes.txt as notes-backup.txt.",
  "Create notes-backup.txt with the exact contents of notes.txt.",
  "请复制 notes.txt 到 notes-backup.txt。", "把 notes.txt 原样复制为 notes-backup.txt。",
  "notes.txt を notes-backup.txt にコピーしてください。",
]) test("copy operands retain distinct roles: " + request, () => {
  const contract = deriveScsTaskContract({ goal: request });
  assert.deepEqual(contract.exactOutputPaths, ["notes-backup.txt"]);
  assert.deepEqual(contract.exactInputPaths, ["notes.txt"]);
  assert.deepEqual(contract.preservedInputPaths, ["notes.txt"]);
  assert.deepEqual(contract.exactCopyRequirements, [{ sourcePath: "notes.txt", destinationPath: "notes-backup.txt" }]);
});
for (const request of [
  "Explain how to copy notes.txt to notes-backup.txt.", "Do not copy notes.txt to notes-backup.txt.",
  'Say "copy notes.txt to notes-backup.txt".', "If we copy notes.txt to notes-backup.txt, what could go wrong?",
  "Run cp notes.txt notes-backup.txt.", "Write marketing copy about notes.txt in notes-backup.txt.",
  "I already copied notes.txt to notes-backup.txt. Explain it.",
  "Explain how to read notes.txt and copy notes.txt to notes-backup.txt.",
  "请不要复制 notes.txt 到 notes-backup.txt。", "不要然后复制 notes.txt 到 notes-backup.txt。",
]) test("prose or commands do not mint copy authority: " + request, () => {
  const contract = deriveScsTaskContract({ goal: request }); assert.deepEqual(contract.exactCopyRequirements, []);
});
for (const content of [raw, raw.replaceAll("\r\n", "\n"), raw.replace("\uFEFF", ""), raw.trim(), "Wrong copy.\n", null]) {
  test("byte verification distinguishes source, BOM, newlines, missing output: " + JSON.stringify(content), async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-proof-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "notes.txt"), raw);
    if (content !== null) await fs.writeFile(path.join(root, "notes-backup.txt"), content);
    const read = await executeWorkspaceTool("read_file", { path: "notes.txt" }, { baseDir: root, commandCwd: root, allowFileTools: true, sandboxMode: "host" });
    const result = evaluateScsSemanticContract(deriveScsTaskContract({ goal }), { commandCwd: root, events: [{ type: "tool.completed", data: read }] });
    assert.equal(result.ok, content === raw, JSON.stringify(result));
    assert.equal(result.exactCopies.ok, content === raw);
  });
}
test("fidelity view is explicit and default source-inspection display stays unchanged", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-read-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "notes.txt"), raw);const config = { baseDir: root, commandCwd: root, allowFileTools: true, sandboxMode: "host" };
  const normal = await executeWorkspaceTool("read_file", { path: "notes.txt" }, config);
  const exact = await executeWorkspaceTool("read_file", { path: "notes.txt", preserveLineEndings: true }, config);
  assert.equal(normal.content, raw.replaceAll("\r\n", "\n")); assert.equal(normal.lineEndingsPreserved, undefined);
  assert.equal(exact.content, raw); assert.equal(exact.lineEndingsPreserved, true); assert.equal(exact.sha256, normal.sha256);
  assert.deepEqual(exact.lineEndingCounts, { crlf: 4, lf: 0, cr: 0 });assert.equal(exact.hasUtf8Bom, true);assert.equal(exact.endsWithLineEnding, true);
  assert.equal(normal.lineEndingCounts, undefined);assert.equal(normal.hasUtf8Bom, undefined);
  for (const args of [{ startLine: 1 }, { lineLimit: 1 }, { limit: 1 }, { preserveLineEndings: "true" }]) {
    await assert.rejects(executeWorkspaceTool("read_file", { path: "notes.txt", preserveLineEndings: true, ...args }, config));
  }
});
test("copying an empty Markdown source is not a request to author a report", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-empty-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "a.md"), ""); await fs.writeFile(path.join(root, "b.md"), "");
  const contract = deriveScsTaskContract({ goal: "Please copy a.md to b.md." });
  const read = await executeWorkspaceTool("read_file", { path: "a.md" }, { baseDir: root, commandCwd: root, allowFileTools: true, sandboxMode: "host" });
  assert.deepEqual(contract.requiredArtifactKinds, []); assert.equal(evaluateScsSemanticContract(contract, { commandCwd: root, events: [{ type: "tool.completed", data: read }] }).ok, true);
  const separate = deriveScsTaskContract({ goal: "Copy a.md to b.md and write report.md about the supplied data." });
  assert.ok(separate.requiredArtifactKinds.some(item => item.extension === ".md"));
  assert.equal(evaluateScsSemanticContract(separate, { commandCwd: root }).ok, false);
});
test("source/destination aliases, final symlinks and shared destination links fail closed", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-alias-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "a.txt"), raw); await fs.link(path.join(root, "a.txt"), path.join(root, "hard.txt")); await fs.symlink("a.txt", path.join(root, "sym.txt"));
  for (const destination of ["a.txt", "./a.txt", "sub/../a.txt", "hard.txt", "sym.txt"]) {
    const contract = deriveScsTaskContract({ goal: `Copy a.txt to ${destination}.` });
    assert.ok(contract.preservedInputPaths.includes("a.txt"));
    assert.equal(evaluateScsSemanticContract(contract, { commandCwd: root }).ok, false, destination);
  }
});

test("one source may have two explicit copies without inventing a second input", () => {
  const contract = deriveScsTaskContract({ goal: "Please copy notes.txt to first.txt and second.txt." });
  assert.deepEqual(contract.exactOutputPaths, ["first.txt", "second.txt"]);
  assert.deepEqual(contract.exactInputPaths, ["notes.txt"]);
  assert.deepEqual(contract.preservedInputPaths, ["notes.txt"]);
  assert.equal(contract.exactCopyRequirements.length, 2);
});
test("a preserved earlier backup is not a second data input", () => {
  const contract = deriveScsTaskContract({ goal: "Please copy notes.txt to second-backup.txt. Leave notes.txt and notes-backup.txt unchanged; no commands or installs." });
  assert.deepEqual(contract.exactInputPaths, ["notes.txt"]);
  assert.deepEqual(contract.explicitInputReadPaths, ["notes.txt"]);
  assert.deepEqual(contract.preservedInputPaths, ["notes.txt", "notes-backup.txt"]);
});
for (const request of [
  "Copy notes.txt to backup.txt. Then write brief.txt about notes.txt.",
  "Copy notes.txt to backup.txt. Leave the original alone; also write brief.txt about notes.txt.",
  "Copy notes.txt to backup.txt. Then explain how to update notes.txt.",
  "Copy notes.txt to backup.txt. Then write brief.txt discussing how to edit notes.txt.",
  'Copy notes.txt to backup.txt. Quote "update notes.txt" in brief.txt.',
]) test("a copy source mention is not edit permission: " + request, () => {
  const contract = deriveScsTaskContract({ goal: request });
  assert.equal(contract.exactCopyRequirements[0].sourceMayChange, undefined);
  assert.ok(contract.preservedInputPaths.includes("notes.txt"));
  assert.ok(contract.exactInputPaths.includes("notes.txt"));
  assert.ok(!contract.exactOutputPaths.includes("notes.txt"));
});
for (const request of [
  "请复制 notes.txt 到 backup.txt；然后写 brief.txt 来介绍 notes.txt。",
  "notes.txt を backup.txt にコピーしてください。notes.txt について brief.txt を作成してください。",
  "Copy Notes.txt to backup.txt. Then update notes.txt to use a new value.",
]) test("indirect or differently named sources remain read-only: " + request, () => {
  const contract = deriveScsTaskContract({ goal: request });const source = request.includes("Notes.txt") ? "Notes.txt" : "notes.txt";
  assert.equal(contract.exactCopyRequirements[0].sourceMayChange, undefined);
  assert.ok(contract.preservedInputPaths.includes(source));assert.ok(!contract.exactOutputPaths.includes(source));
});
for (const request of [
  "请复制 notes.txt 到 backup.txt；然后修改 notes.txt。",
  "先修改 notes.txt。然后复制 notes.txt 到 backup.txt。",
  "notes.txt を backup.txt にコピーしてください。notes.txt を更新してください。",
  "notes.txt を更新してください。notes.txt を backup.txt にコピーしてください。",
]) test("explicit multilingual source edits retain their distinct role: " + request, () => {
  const contract = deriveScsTaskContract({ goal: request });assert.equal(contract.exactCopyRequirements[0].sourceMayChange, true);
  assert.ok(!contract.preservedInputPaths.includes("notes.txt"));
});
test("source display can be copied faithfully without normalizing mixed line endings", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-mixed-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const contents = "first\r\nsecond\nthird\rfourth"; await fs.writeFile(path.join(root, "mixed.txt"), contents);
  const value = await executeWorkspaceTool("read_file", { path: "mixed.txt", preserveLineEndings: true }, { baseDir: root, commandCwd: root, allowFileTools: true, sandboxMode: "host" });
  assert.equal(value.content, contents); assert.equal(value.sha256, hash(contents));
  assert.deepEqual(value.lineEndingCounts, { crlf: 1, lf: 1, cr: 1 });assert.equal(value.hasUtf8Bom, false);assert.equal(value.endsWithLineEnding, false);
});
test("approved read-only input roots are required independently of a task path", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-roots-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work"), outside = path.join(root, "outside");await fs.mkdir(work);await fs.mkdir(outside);
  const input = path.join(outside, "notes.txt");await fs.writeFile(input, raw);await fs.writeFile(path.join(work, "backup.txt"), raw);
  const contract = deriveScsTaskContract({ goal: `Copy ${input} to backup.txt.` });
  const options = { commandCwd: work, events: [readEvent(input)] };
  assert.equal(evaluateScsSemanticContract(contract, options).ok, false);
  assert.equal(evaluateScsSemanticContract(contract, { ...options, readOnlyRoots: [outside] }).ok, true);
  assert.equal(evaluateScsSemanticContract(contract, { ...options, readOnlyRoots: [input] }).ok, true, "An approved exact-file root is not a directory grant");
  const sibling = path.join(outside, "other.txt");await fs.writeFile(sibling, raw);
  assert.equal(evaluateScsSemanticContract(deriveScsTaskContract({ goal: `Copy ${sibling} to backup.txt.` }), { ...options, events: [readEvent(sibling)], readOnlyRoots: [input] }).ok, false);
});
test("unrelated missing and skill-file roots do not invalidate a workspace copy", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-unused-roots-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "notes.txt"), raw);await fs.writeFile(path.join(root, "notes-backup.txt"), raw);await fs.writeFile(path.join(root, "skill.md"), "Read only.");
  const result = evaluateScsSemanticContract(deriveScsTaskContract({ goal }), { commandCwd: root, events: [readEvent()], readOnlyRoots: [path.join(root, "missing"), path.join(root, "skill.md")] });
  assert.equal(result.ok, true);
});
test("secret and outside targets cannot become verified copies", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-secret-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work");await fs.mkdir(work);await fs.writeFile(path.join(work, "notes.txt"), raw);
  for (const destination of [".env", "../outside.txt"]) {
    await fs.writeFile(path.resolve(work, destination), raw);
    const contract = deriveScsTaskContract({ goal: `Copy notes.txt to ${destination}.` });
    assert.equal(evaluateScsSemanticContract(contract, { commandCwd: work, events: [readEvent()] }).ok, false, destination);
  }
});
test("oversized copy proof is bounded before opening the source", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-bound-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "notes.txt"), "");await fs.truncate(path.join(root, "notes.txt"), 64 * 1024 * 1024 + 1);
  await fs.writeFile(path.join(root, "notes-backup.txt"), "");
  const result = evaluateScsSemanticContract(deriveScsTaskContract({ goal }), { commandCwd: root, events: [readEvent()] });
  assert.equal(result.ok, false);assert.equal(result.exactCopies.issues[0].reason, "copy-bytes-unverified");
});
test("a separately requested later source edit retains the copied native snapshot", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-snapshot-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const next = raw.replace("AB-007", "AB-008");await fs.writeFile(path.join(root, "notes.txt"), next);await fs.writeFile(path.join(root, "backup.txt"), raw);
  const request = "Copy notes.txt to backup.txt. Then update notes.txt to use AB-008.";
  const contract = deriveScsTaskContract({ goal: request });
  assert.deepEqual(contract.preservedInputPaths, []);assert.equal(contract.exactCopyRequirements[0].sourceMayChange, true);
  const events = [readEvent(), { type: "tool.completed", data: { ok: true, toolName: "write_file", path: "backup.txt", change: { afterHash: hash(raw) }, goalRevision: 1, projectMutationRevision: 1 } },
    { type: "tool.completed", data: { ok: true, toolName: "apply_patch", path: "notes.txt", change: { afterHash: hash(next) }, goalRevision: 1 } }];
  const state = { goal: request, meta: { goalContract: { revision: 1, taskGoal: request, history: [{ revision: 1, kind: "initial", hash: hash(request), taskHash: hash(request) }] }, projectVerification: { mutationHistory: [{ revision: 1, goalRevision: 1, taskHash: hash(request), paths: ["backup.txt"] }] } } };
  const options = { commandCwd: root, events, state };
  assert.equal(evaluateScsSemanticContract(contract, options).exactCopies.ok, true);
  assert.equal(evaluateScsSemanticContract(contract, { ...options, events: [] }).ok, false);
  assert.equal(evaluateScsSemanticContract(contract, { ...options, state: { meta: { goalContract: { revision: 2 } } } }).ok, false);
  const continued = structuredClone(state);continued.meta.goalContract.revision = 2;continued.meta.goalContract.history.push({ revision: 2, relation: "same-task", taskHash: hash(request) });
  assert.equal(evaluateScsSemanticContract(contract, { ...options, state: continued }).exactCopies.ok, true, "An owned publication survives a proven same-task continuation");
  for (const invalidEvents of [
    [{ type: "tool.started", data: { toolName: "apply_patch", args: { path: "notes.txt" } } }, readEvent(), events[1]],
    [{ type: "tool.failed", data: { toolName: "run_command" } }, readEvent(), events[1]],
    [...events, { type: "tool.started", data: { toolName: "write_file", args: { path: "backup.txt" } } }],
  ]) assert.equal(evaluateScsSemanticContract(contract, { ...options, events: invalidEvents }).exactCopies.ok, false, "Ambiguous native operations cannot retain an earlier snapshot");
  for (const alter of [
    value => { delete value.meta.projectVerification.mutationHistory[0].taskHash; },
    value => { delete value.meta.goalContract.history[1].taskHash; },
    value => { value.meta.goalContract.history[1].relation = "new-request"; },
    value => { value.meta.projectVerification.mutationHistory[0].taskHash = hash("Different task"); },
    value => { value.meta.projectVerification.mutationHistory[0].revision = 2; },
  ]) {
    const invalid = structuredClone(continued);alter(invalid);
    assert.equal(evaluateScsSemanticContract(contract, { ...options, state: invalid }).exactCopies.ok, false);
  }
  await fs.writeFile(path.join(root, "backup.txt"), next);
  assert.equal(evaluateScsSemanticContract(contract, options).ok, false, "Later output drift cannot replace the durable copied snapshot");
});

test("a source replacement while hashing the destination invalidates the whole observation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-drift-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "notes.txt"), raw);await fs.writeFile(path.join(root, "notes-backup.txt"), raw);
  const open = fsSync.openSync, read = fsSync.readSync;let destinationFd, replaced = false;
  t.mock.method(fsSync, "openSync", function (file, ...args) { const fd = Reflect.apply(open, fsSync, [file, ...args]);if (file === path.join(root, "notes-backup.txt")) destinationFd = fd;return fd; });
  t.mock.method(fsSync, "readSync", function (fd, ...args) {
    if (fd === destinationFd && !replaced) { replaced = true;fsSync.renameSync(path.join(root, "notes.txt"), path.join(root, "old.txt"));fsSync.writeFileSync(path.join(root, "notes.txt"), raw); }
    return Reflect.apply(read, fsSync, [fd, ...args]);
  });
  const result = evaluateScsSemanticContract(deriveScsTaskContract({ goal }), { commandCwd: root, events: [readEvent()] });
  assert.equal(replaced, true);assert.equal(result.exactCopies.ok, false);assert.equal(result.exactCopies.issues[0].reason, "copy-observation-changed");
  assert.deepEqual(result.exactCopies.receipts, []);
});

test("a later source mutation cannot replace the original backup snapshot", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-order-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = "Copy notes.txt to backup.txt. Then update notes.txt to use AB-008.", next = raw.replace("AB-007", "AB-008");
  await fs.writeFile(path.join(root, "notes.txt"), next);await fs.writeFile(path.join(root, "backup.txt"), next);
  const state = { goal: request, meta: { goalContract: { revision: 1, taskGoal: request }, projectVerification: { mutationHistory: [{ revision: 2, goalRevision: 1, taskHash: hash(request), paths: ["backup.txt"] }] } } };
  const edited = { type: "tool.completed", data: { ok: true, toolName: "apply_patch", path: "notes.txt", change: { afterHash: hash(next) }, goalRevision: 1 } };
  const copied = { type: "tool.completed", data: { ok: true, toolName: "write_file", path: "backup.txt", change: { afterHash: hash(next) }, goalRevision: 1, projectMutationRevision: 2 } };
  const options = { commandCwd: root, state };
  for (const events of [[readEvent(), edited, copied], [edited, copied], [readEvent(), edited, { ...copied, data: { ...copied.data, copiedFrom: { path: "notes.txt", sha256: hash(next) } } }]]) {
    assert.equal(evaluateScsSemanticContract(deriveScsTaskContract({ goal: request }), { ...options, events }).exactCopies.ok, false, "A backup of the original cannot silently become a copy of the edited source");
  }
  await fs.writeFile(path.join(root, "backup.txt"), raw);
  const originalPublication = { ...copied, data: { ...copied.data, change: { afterHash: hash(raw) } } };
  assert.equal(evaluateScsSemanticContract(deriveScsTaskContract({ goal: request }), { ...options, events: [readEvent(), edited, originalPublication] }).exactCopies.ok, true, "Publication may be late if it retains the actual pre-edit read bytes");
});

test("an explicitly earlier source edit binds the later copy to the edited snapshot", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-after-edit-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = "Update notes.txt to use AB-008. Then copy notes.txt to backup.txt.", next = raw.replace("AB-007", "AB-008");
  await fs.writeFile(path.join(root, "notes.txt"), next);await fs.writeFile(path.join(root, "backup.txt"), next);
  const contract = deriveScsTaskContract({ goal: request });assert.equal(contract.exactCopyRequirements[0].sourceEditBeforeCopy, true);
  const state = { goal: request, meta: { goalContract: { revision: 1, taskGoal: request }, projectVerification: { mutationHistory: [{ revision: 2, goalRevision: 1, taskHash: hash(request), paths: ["backup.txt"] }] } } };
  const events = [readEvent(), { type: "tool.completed", data: { ok: true, toolName: "apply_patch", path: "notes.txt", change: { afterHash: hash(next) }, goalRevision: 1 } },
    { type: "tool.completed", data: { ok: true, toolName: "write_file", path: "backup.txt", copiedFrom: { path: "notes.txt", sha256: hash(next) }, change: { afterHash: hash(next) }, goalRevision: 1, projectMutationRevision: 2 } }];
  assert.equal(evaluateScsSemanticContract(contract, { commandCwd: root, state, events }).exactCopies.ok, true);
});

test("an earlier task read cannot poison a new backup snapshot in the raw SCS event history", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-task-snapshot-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = "Copy notes.txt to backup.txt. Then update notes.txt to use AB-008.", next = raw.replace("AB-007", "AB-008");
  await fs.writeFile(path.join(root, "notes.txt"), next);await fs.writeFile(path.join(root, "backup.txt"), raw);
  const state = { goal: request, meta: { goalContract: { revision: 2, taskBoundaryRevision: 2, taskGoal: request }, projectVerification: { mutationHistory: [{ revision: 2, goalRevision: 2, taskHash: hash(request), paths: ["backup.txt"] }] } } };
  const events = [ { type: "tool.completed", data: { ...readEvent().data, sha256: hash("Earlier unrelated note") } },
    { type: "conversation.continued", data: { preservesTaskBoundary: false } },
    { type: "tool.completed", data: { ...readEvent().data, goalRevision: 2 } },
    { type: "tool.completed", data: { ok: true, toolName: "write_file", path: "backup.txt", change: { afterHash: hash(raw) }, goalRevision: 2, projectMutationRevision: 2 } },
    { type: "tool.completed", data: { ok: true, toolName: "apply_patch", path: "notes.txt", change: { afterHash: hash(next) }, goalRevision: 2 } } ];
  assert.equal(evaluateScsSemanticContract(deriveScsTaskContract({ goal: request }), { commandCwd: root, state, events }).exactCopies.ok, true);
});

for (const scsActive of [false, true]) for (const mode of ["wrong-copy", "source-mutation", "unrelated-output", "line-ending-repair", "source-copy", "report-source", "report-source-alias"]) {
  test(`native copy contract and continuation (SCS ${scsActive}, ${mode})`, { timeout: 20000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-native-"));const previousHome = process.env.AGINTIFLOW_HOME;
    let closeIndex = () => {};t.after(async () => { closeIndex();if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME;else process.env.AGINTIFLOW_HOME = previousHome;await fs.rm(root, { recursive: true, force: true }); });
    process.env.AGINTIFLOW_HOME = path.join(root, "agent");t.mock.method(globalThis, "fetch", async () => { throw Error("Offline native copy must not access the network"); });
    const { runAgent, completionTaskContract } = await import(pathToFileURL(path.join(runtimeRoot, "src/agent-runner.js")));
    const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtimeRoot, "src/config.js")));
    closeIndex = (await import(pathToFileURL(path.join(runtimeRoot, "src/session-index.js")))).closeSessionIndexConnections;
    const work = path.join(root, "work");await fs.mkdir(work);await fs.writeFile(path.join(work, "notes.txt"), raw);
    const reportTask = mode.startsWith("report-source");
    const request = reportTask ? `Copy notes.txt to notes-backup.txt. Then write brief.txt about notes.txt.${mode.endsWith("alias") ? " Leave the original alone." : ""} No commands or installs.` : goal;
    const actions = [["read_file", { path: "notes.txt" }]];
    if (mode === "source-mutation" || reportTask) actions.push(["apply_patch", { path: "notes.txt", search: "needs review", replace: "approved" }]);
    if (reportTask) actions.push(["write_file", { path: "notes-backup.txt", content: raw }], ["write_file", { path: "brief.txt", content: "The supplied note is a draft. Its status still needs review, and its reference code is AB-007. This brief records the supplied information without changing the original note.\n" }]);
    else if (mode === "source-copy") actions.push(["write_file", { path: "notes-backup.txt", copyFromPath: "notes.txt", copyFromSha256: hash(raw), mode: "create" }]);
    else if (mode === "line-ending-repair") actions.push(["write_file", { path: "notes-backup.txt", content: raw.replaceAll("\r\n", "\n") }],
      ["apply_patch", { path: "notes-backup.txt", search: "An absent source anchor.", replace: raw }], ["read_file", { path: "notes-backup.txt" }],
      ["apply_patch", { path: "notes-backup.txt", search: raw.replaceAll("\r\n", "\n"), replace: raw.replaceAll("\r\n", "\n") + " " }],
      ["apply_patch", { path: "notes-backup.txt", search: raw.replaceAll("\r\n", "\n"), replace: raw }]);
    else if (mode === "wrong-copy") actions.push(["write_file", { path: "notes-backup.txt", content: "Wrong copied text.\n" }], ["finish", { result: "Copied notes.txt to notes-backup.txt." }],
      ["read_file", { path: "notes-backup.txt" }], ["apply_patch", { path: "notes-backup.txt", search: "Wrong copied text.\n", replace: raw }]);
    else if (mode === "unrelated-output") actions.push(["write_file", { path: "unrelated.txt", content: "Not the requested backup.\n" }], ["finish", { result: "Copied notes.txt to notes-backup.txt." }], ["write_file", { path: "notes-backup.txt", content: raw }]);
    else actions.push(["write_file", { path: "notes-backup.txt", content: raw }]);
    actions.push(["finish", { result: reportTask ? "Created notes-backup.txt and brief.txt; notes.txt is unchanged." : "Created the exact notes-backup.txt copy; notes.txt is unchanged." }]);
    let step = 0, preparatoryInspections = 0;const offered = [];
    const clientFactory = async () => ({ chat: { completions: { create: async request => {
      if (!request.tools) return { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "1. Read the current named source.\n2. Create the requested copy.\n3. Verify the files and finish." } }] };
      if (reportTask && actions[step]?.[0] === "read_file" && !request.tools.some(tool => tool.function.name === "read_file") && request.tools.some(tool => tool.function.name === "inspect_project")) {
        assert.equal(preparatoryInspections++, 0, "Bounded baseline setup cannot become an inspection loop");
        return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "copy_prepare", type: "function", function: { name: "inspect_project", arguments: "{}" } }] } }] };
      }
      const action = actions[step++];
      assert.ok(action, JSON.stringify({ reason: "No producer loop after an exact copy", step, offered, rejections: request.messages.filter(message => message.role === "user" && String(message.content).startsWith("The proposed completion")).slice(-2).map(message => String(message.content).slice(0, 1200)) }));
      offered.push({ action: action[0], tools: request.tools.map(tool => tool.function.name) });
      return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `copy_${step}`, type: "function", function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } }] };
    } } } });clientFactory.agintiDeterministicTest = true;
    const makeConfig = (request, resume) => {
      const config = resolveRuntimeConfig({ provider: "openai", model: "offline-copy", routingMode: "manual", taskProfile: "code", goal: request, resume, enableScs: scsActive ? "on" : "off" },
        { baseDir: work, commandCwd: work, packageDir: runtimeRoot, sessionId: "copy-proof", clientFactory, sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowMcpTools: false, allowWebSearch: false, allowParallelScouts: false });
      return Object.assign(config, { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), maxSteps: 12, dynamicSteps: "off", allowProviderHandoff: false, scsActive, scsValidationMode: "deterministic", executionPolicy: { tier: "focused", requiresPlan: false }, onConsole() {}, onLog() {} });
    };
    const result = await runAgent(makeConfig(request));assert.notEqual(result.stopped, true, JSON.stringify({ result, step, offered }));assert.equal(step, actions.length);
    assert.equal(await fs.readFile(path.join(work, "notes.txt"), "utf8"), raw, reportTask ? JSON.stringify({ goalStatus: result.goalStatus, stopped: result.stopped || false, originalMustRemainUnchanged: true }) : undefined);assert.equal(await fs.readFile(path.join(work, "notes-backup.txt"), "utf8"), raw);
    if (reportTask) assert.equal(preparatoryInspections, 0, "A known data source must not require unrelated repository inspection");
    const session = path.join(root, "sessions/copy-proof"), events = (await fs.readFile(path.join(session, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const sourceRead = events.find(e => e.type === "tool.completed" && e.data.toolName === "read_file" && e.data.path === "notes.txt");
    assert.equal(sourceRead.data.lineEndingsPreserved, true, "The native copy contract selects fidelity presentation without rewriting provider arguments");
    assert.equal(sourceRead.data.args.preserveLineEndings, undefined);
    if (mode === "source-mutation" || reportTask) assert.ok(events.some(e => e.type === "tool.blocked" && e.data.category === "preserved-input-mutation"));
    else if (mode === "line-ending-repair") assert.ok(events.some(e => e.type === "tool.failed" && e.data.category === "patch-context-noop"), "Arbitrary whitespace remains a no-op; only the exact proven copy bytes qualify");
    else if (mode === "source-copy") assert.ok(events.some(e => e.type === "tool.completed" && e.data.copiedFrom?.sha256 === hash(raw)), "The native publisher, not model text, attests the copied source");
    else assert.ok(events.some(e => ["completion.evidence_rejected", "scs.student.finish_rejected"].includes(e.type)), "A false first completion must be rejected");
    const before = step;await runAgent({ ...makeConfig("Continue the same task.", "copy-proof"), expectedRuntimeRevision: 1 });assert.equal(step, before);
    actions.push(["read_file", { path: "notes.txt" }], ["apply_patch", { path: "notes.txt", search: "AB-007", replace: "AB-008" }], ["finish", { result: "Updated notes.txt to AB-008." }]);
    const nextConfig = makeConfig("Update notes.txt to use AB-008. Leave notes-backup.txt alone.", "copy-proof");
    const updated = await runAgent({ ...nextConfig, expectedRuntimeRevision: 1 });assert.notEqual(updated.stopped, true, JSON.stringify({ updated, offered, step }));
    const state = JSON.parse(await fs.readFile(path.join(session, "state.json"), "utf8"));assert.deepEqual(completionTaskContract(nextConfig, state).exactCopyRequirements, []);
    const laterEvents = (await fs.readFile(path.join(session, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).slice(events.length);
    const laterRead = laterEvents.find(e => e.type === "tool.completed" && e.data.toolName === "read_file" && e.data.path === "notes.txt");
    assert.equal(laterRead.data.lineEndingsPreserved, undefined, "A later non-copy goal retains the ordinary source display");
    assert.equal(await fs.readFile(path.join(work, "notes.txt"), "utf8"), raw.replace("AB-007", "AB-008"));assert.equal(await fs.readFile(path.join(work, "notes-backup.txt"), "utf8"), raw);
    if (mode === "source-copy") {
      const next = raw.replace("AB-007", "AB-008");
      actions.push(["read_file", { path: "notes.txt" }], ["write_file", { path: "second-backup.txt", copyFromPath: "notes.txt", copyFromSha256: hash(next) }], ["finish", { result: "Created second-backup.txt; both existing files are unchanged." }]);
      const copiedAgain = await runAgent({ ...makeConfig("Please copy notes.txt to second-backup.txt. Leave notes.txt and notes-backup.txt unchanged; no commands or installs.", "copy-proof"), expectedRuntimeRevision: 1 });
      assert.notEqual(copiedAgain.stopped, true, JSON.stringify(copiedAgain));assert.equal(step, actions.length);
      assert.equal(await fs.readFile(path.join(work, "second-backup.txt"), "utf8"), next);assert.equal(await fs.readFile(path.join(work, "notes-backup.txt"), "utf8"), raw);
    }
  });
}

for (const scsActive of [false, true]) for (const order of ["paused", "edit-first", "wrong-snapshot-repair"]) test(`native backup/edit snapshot order (SCS ${scsActive}, ${order})`, { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-resume-")), previousHome = process.env.AGINTIFLOW_HOME;
  let closeIndex = () => {};t.after(async () => { closeIndex();if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME;else process.env.AGINTIFLOW_HOME = previousHome;await fs.rm(root, { recursive: true, force: true }); });
  process.env.AGINTIFLOW_HOME = path.join(root, "agent");t.mock.method(globalThis, "fetch", async () => { throw Error("Offline copy continuation must not access the network"); });
  const { runAgent } = await import(pathToFileURL(path.join(runtimeRoot, "src/agent-runner.js")));
  const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtimeRoot, "src/config.js")));
  closeIndex = (await import(pathToFileURL(path.join(runtimeRoot, "src/session-index.js")))).closeSessionIndexConnections;
  const work = path.join(root, "work");await fs.mkdir(work);await fs.writeFile(path.join(work, "notes.txt"), raw);
  const next = raw.replace("AB-007", "AB-008");
  const request = order === "edit-first" ? "Update notes.txt and include `AB-008`. Then copy notes.txt to backup.txt." : "Copy notes.txt to backup.txt. Then update notes.txt and include `AB-008`.";
  let actions = [["read_file", { path: "notes.txt" }], ["write_file", { path: "backup.txt", content: raw }],
    ["read_file", { path: "notes.txt" }], ["apply_patch", { path: "notes.txt", search: "AB-007", replace: "AB-008" }], ["finish", { result: "Created backup.txt and updated notes.txt to AB-008." }]];
  if (order !== "paused") {
    actions = [["read_file", { path: "notes.txt" }], ["apply_patch", { path: "notes.txt", search: "AB-007", replace: "AB-008" }],
      ["write_file", { path: "backup.txt", copyFromPath: "notes.txt", copyFromSha256: hash(next) }], ["finish", { result: "Created backup.txt and updated notes.txt to AB-008." }]];
    if (order === "wrong-snapshot-repair") actions.push(["read_file", { path: "backup.txt" }], ["apply_patch", { path: "backup.txt", search: next, replace: raw }], ["finish", { result: "The backup preserves the original note; notes.txt contains AB-008." }]);
  }
  let step = 0;const offered = [];
  const clientFactory = async () => ({ chat: { completions: { create: async request => {
    if (!request.tools) return { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "1. Keep the existing backup.\n2. Apply the requested source edit.\n3. Verify both files and finish." } }] };
    const action = actions[step++];assert.ok(action, JSON.stringify({ reason: "The native continuation must not require another backup producer", offered, repair: request.messages.filter(message => message.role === "user").slice(-2).map(message => String(message.content).slice(0, 2500)) }));
    offered.push({ action: action[0], tools: request.tools.map(tool => ({ name: tool.function.name, paths: tool.function.parameters.properties.path?.enum })) });
    return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `resumed_${step}`, type: "function", function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } }] };
  } } } });clientFactory.agintiDeterministicTest = true;
  const config = (goal, resume, maxSteps) => Object.assign(resolveRuntimeConfig({ provider: "openai", model: "offline-copy", routingMode: "manual", taskProfile: "code", goal, resume, enableScs: scsActive ? "on" : "off" },
    { baseDir: work, commandCwd: work, packageDir: runtimeRoot, sessionId: "copy-resume", clientFactory, sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowMcpTools: false, allowWebSearch: false, allowParallelScouts: false }),
    { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), maxSteps, dynamicSteps: "off", allowProviderHandoff: false, scsActive, scsValidationMode: "deterministic", executionPolicy: { tier: "focused", requiresPlan: false }, onConsole() {}, onLog() {} });
  let completed;
  if (order === "paused") {
    const paused = await runAgent(config(request, undefined, 2));assert.equal(paused.stopped, true);assert.equal(step, 2);
    completed = await runAgent({ ...config("Continue the same task.", "copy-resume", 9), expectedRuntimeRevision: 1, runtimePatch: { maxSteps: 9 } });
  } else completed = await runAgent(config(request, undefined, 12));
  assert.notEqual(completed.stopped, true, JSON.stringify({ completed, offered }));assert.equal(step, actions.length);
  const diagnosticEvents = (await fs.readFile(path.join(root, "sessions/copy-resume/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(diagnosticEvents.some(e => e.type === "tool.completed" && e.data.toolName === "apply_patch" && e.data.ok === true), JSON.stringify(diagnosticEvents.filter(e => e.type.startsWith("tool.") && e.data.toolName === "apply_patch")));
  assert.equal(await fs.readFile(path.join(work, "backup.txt"), "utf8"), order === "edit-first" ? next : raw);assert.equal(await fs.readFile(path.join(work, "notes.txt"), "utf8"), next);
  const session = path.join(root, "sessions/copy-resume"), state = JSON.parse(await fs.readFile(path.join(session, "state.json"), "utf8"));
  assert.equal(state.meta.runtimeConfig.revision, order === "paused" ? 2 : 1);assert.equal(state.meta.goalContract.revision, order === "paused" ? 2 : 1);
  const events = (await fs.readFile(path.join(session, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.type === "tool.completed" && e.data.toolName === "write_file" && e.data.path === "backup.txt").length, 1);
  assert.equal(events.filter(e => ["completion.evidence_rejected", "scs.student.finish_rejected"].includes(e.type)).length, order === "wrong-snapshot-repair" ? 1 : 0);
});

for (const contents of [raw, "", "one\r\ntwo\nthree\rfour"]) test("hash-bound create preserves exact permitted UTF-8: " + JSON.stringify(contents), async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-create-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "source.txt"), contents);
  const config = { baseDir: root, commandCwd: root, allowFileTools: true, sandboxMode: "host" };
  const copied = await executeWorkspaceTool("write_file", { path: "target.txt", copyFromPath: "source.txt", copyFromSha256: hash(contents) }, config);
  assert.equal(copied.ok, true);assert.equal(copied.change.afterHash, hash(contents));assert.equal(copied.copiedFrom.sha256, hash(contents));
  assert.deepEqual(await fs.readFile(path.join(root, "target.txt")), Buffer.from(contents));
  await assert.rejects(executeWorkspaceTool("write_file", { path: "target.txt", copyFromPath: "source.txt", copyFromSha256: hash(contents) }, config));
  assert.deepEqual(await fs.readFile(path.join(root, "target.txt")), Buffer.from(contents));
});

for (const mode of ["stale", "missing-path", "missing-hash", "both", "overwrite", "secret-path", "outside", "secret-content", "binary", "oversized", "invalid-utf8", "binary-output", "outside-symlink", "write-prompt"]) test("hash-bound create keeps existing authority boundaries: " + mode, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-copy-create-denial-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work");await fs.mkdir(work);
  let bytes = Buffer.from(raw), source = "source.txt", destination = "target.txt";
  const config = { baseDir: work, commandCwd: work, allowFileTools: true, sandboxMode: "host" };
  if (mode === "secret-path") source = ".env";
  if (mode === "outside") source = "../outside.txt";
  if (mode === "secret-content") bytes = Buffer.from('OPENAI_API_KEY="sk-' + "x".repeat(60) + '"\n');
  if (mode === "binary") bytes = Buffer.from([65, 0, 66]);
  if (mode === "oversized") bytes = Buffer.alloc(220001, 65);
  if (mode === "invalid-utf8") bytes = Buffer.from([0xc3, 0x28]);
  if (mode === "binary-output") destination = "target.pdf";
  if (mode === "write-prompt") config.workspaceWritePolicy = "prompt";
  await fs.writeFile(path.resolve(work, source), bytes);
  if (mode === "outside-symlink") { await fs.writeFile(path.join(root, "outside.txt"), bytes);await fs.unlink(path.join(work, source));await fs.symlink("../outside.txt", path.join(work, source)); }
  const args = { path: destination, copyFromPath: source, copyFromSha256: hash(bytes) };
  if (mode === "stale") args.copyFromSha256 = "0".repeat(64);
  if (mode === "missing-path") delete args.copyFromPath;
  if (mode === "missing-hash") delete args.copyFromSha256;
  if (mode === "both") args.content = raw;
  if (mode === "overwrite") args.mode = "overwrite";
  let denied = false;
  try { const result = await executeWorkspaceTool("write_file", args, config);denied = result.ok === false; } catch { denied = true; }
  assert.equal(denied, true);await assert.rejects(fs.stat(path.join(work, destination)), { code: "ENOENT" });
});

test("offered native write schema admits exactly one content source before dispatch", async () => {
  let offered;
  await requestNextStep({ chat: { completions: { create: async request => {
    offered = request.tools;
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "schema_probe", type: "function", function: { name: "finish", arguments: JSON.stringify({ result: "Synthetic schema observation." }) } }] } }] };
  } } } }, { provider: "openai", model: "offline-copy", allowFileTools: true, taskProfile: "code" }, []);
  const tool = offered.find(tool => tool.function.name === "write_file");
  const contract = createToolContract([tool]);
  for (const args of [
    { path: "target.txt", content: "" }, { path: "target.txt", content: raw },
    { path: "target.txt", copyFromPath: "source.txt", copyFromSha256: hash(raw) },
    { path: "target.txt" }, { path: "target.txt", copyFromPath: "source.txt" },
    { path: "target.txt", copyFromSha256: hash(raw) },
    { path: "target.txt", copyFromPath: "source.txt", copyFromSha256: hash(raw), content: "" },
    { path: "target.txt", copyFromPath: "source.txt", copyFromSha256: hash(raw), mode: "overwrite" },
  ]) {
    const expected = Object.hasOwn(args, "content") ? !Object.hasOwn(args, "copyFromPath") && !Object.hasOwn(args, "copyFromSha256") : Boolean(args.copyFromPath && args.copyFromSha256 && args.mode !== "overwrite");
    const result = resolveDispatchableToolCallBatch([{ id: "copy_arguments", type: "function", function: { name: "write_file", arguments: JSON.stringify(args) } }], contract);
    assert.equal(result.ok, expected, JSON.stringify(result));
  }
});
