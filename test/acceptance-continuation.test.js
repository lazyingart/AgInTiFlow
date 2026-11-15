import assert from "node:assert/strict";
import fs from "node:fs/promises";
import sync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { recordProjectVerificationOutcome, applyContinuationContractTransition, completionTaskContract, nextStepRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { executeWorkspaceTool } = await import(pathToFileURL(path.join(runtime, "src/workspace-tools.js")));
const { selectProgressiveTools } = await import(pathToFileURL(path.join(runtime, "src/progressive-tool-selection.js")));
const { createToolContract, validateToolCallBatch } = await import(pathToFileURL(path.join(runtime, "src/tool-contract.js")));
const hash = s => createHash("sha256").update(s).digest("hex");
const original = "Read TASK.md and complete the project it describes. Leave unrelated files alone.";
const followup = "Continue the same task. Save notes.md with the observed status and finish.";
const brief = "# Task\n\nRequired outputs:\n- `report.md`\n\nThe validation commands must run before completion:\n\n```bash\nnode check.mjs\n```\n";
const selected = verification => Object.fromEntries(["requiredOutputs", "requiredCommands", "acceptanceBySource", "acceptanceSource", "acceptanceReadAt", "acceptanceRefreshedAt"].filter(k => Object.hasOwn(verification, k)).map(k => [k, structuredClone(verification[k])]));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-acceptance-refresh-")), workspace = root + "/workspace";
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  await fs.mkdir(workspace); await fs.writeFile(workspace + "/TASK.md", brief);
  const state = { goal: original, commandCwd: workspace, messages: [], meta: { taskProfile: "code", goalContract: { version: 3, revision: 1, status: "failed", taskGoal: original, activeGoal: original, activeGoalRevision: 1, taskBoundaryRevision: 1, history: [{ revision: 1, kind: "initial", hash: hash(original), taskHash: hash(original), preview: original }], lifecycle: [] } } };
  const config = { commandCwd: workspace, baseDir: workspace, taskProfile: "code", allowFileTools: true, allowShellTool: true };
  const read = await executeWorkspaceTool("read_file", { path: "TASK.md" }, config); assert.equal(read.ok, true);
  recordProjectVerificationOutcome(state, read, config);
  return { root, workspace, file: workspace + "/TASK.md", state, config };
}
function resume(f) {
  const update = applyContinuationContractTransition(f.state, followup);
  assert.equal(update.preserveTaskBoundary, true); assert.equal(update.refreshExecutionContract, true);
  return completionTaskContract(f.config, f.state);
}
for (const mode of ["missing", "directory", "empty", "whitespace", "oversized", "invalid-utf8", "nul", "outside-alias", "secret-alias"]) test(`unavailable ${mode} acceptance cannot erase retained requirements`, async t => {
  const f = await fixture(t), before = selected(f.state.meta.projectVerification);
  await fs.unlink(f.file);
  if (mode === "directory") await fs.mkdir(f.file);
  else if (mode === "outside-alias" || mode === "secret-alias") {
    const target = mode === "outside-alias" ? f.root + "/outside.md" : f.workspace + "/.env";
    await fs.writeFile(target, "# Updated task\n\nNo requirements.\n"); await fs.symlink(target, f.file);
  } else if (mode !== "missing") await fs.writeFile(f.file, mode === "empty" ? "" : mode === "whitespace" ? " \r\n" : mode === "oversized" ? "x".repeat(220001) : mode === "invalid-utf8" ? Buffer.from([0xff]) : brief + "\0");
  const contract = resume(f); assert.deepEqual(selected(f.state.meta.projectVerification), before);
  assert.ok(contract.requiredProjectCommands.includes("node check.mjs")); assert.ok(contract.exactOutputPaths.includes("report.md")); assert.ok(contract.exactOutputPaths.includes("notes.md"));
});
test("plain checkpoint remains a safe no-refresh continuation when the source is missing", async t => {
  const f = await fixture(t), before = selected(f.state.meta.projectVerification); await fs.unlink(f.file);
  const result = applyContinuationContractTransition(f.state, "Please continue from where you stopped.");
  assert.equal(result.refreshExecutionContract, false); assert.deepEqual(selected(f.state.meta.projectVerification), before);
});
test("current complete source refresh still replaces its obsolete acceptance", async t => {
  const f = await fixture(t); await fs.writeFile(f.file, "# Task\n\nRequired outputs:\n- `current.md`\n\nValidation commands must run before completion:\n\n```sh\nnode current-check.mjs\n```\n");
  const contract = resume(f); assert.deepEqual(f.state.meta.projectVerification.requiredOutputs, ["current.md"]);
  assert.deepEqual(f.state.meta.projectVerification.requiredCommands, ["node current-check.mjs"]);
  assert.ok(!contract.requiredProjectCommands.includes("node check.mjs"));
});
test("a complete nonempty guide with no requirements can retire obsolete parser requirements", async t => {
  const f = await fixture(t); await fs.writeFile(f.file, "# Guide\n\nThis page describes the project. There are no mandatory output files or checks.\n");
  resume(f); assert.deepEqual(f.state.meta.projectVerification.requiredOutputs, []); assert.deepEqual(f.state.meta.projectVerification.requiredCommands, []);
});
test("one unreadable source survives another source's successful refresh", async t => {
  const f = await fixture(t); await fs.writeFile(f.workspace + "/README.md", "# Guide\n\nValidation command must run before completion:\n\n```sh\nnode other-check.mjs\n```\n");
  recordProjectVerificationOutcome(f.state, await executeWorkspaceTool("read_file", { path: "README.md" }, f.config), f.config);
  const priorTask = structuredClone(f.state.meta.projectVerification.acceptanceBySource["TASK.md"]); await fs.unlink(f.file);
  resume(f); assert.deepEqual(f.state.meta.projectVerification.acceptanceBySource["TASK.md"], priorTask);
  assert.deepEqual(f.state.meta.projectVerification.requiredOutputs, ["report.md"]);
  assert.deepEqual(f.state.meta.projectVerification.requiredCommands, ["node check.mjs", "node other-check.mjs"]);
});
test("a failing source does not prevent a different source from dropping obsolete requirements", async t => {
  const f = await fixture(t); const readme = f.workspace + "/README.md"; await fs.writeFile(readme, brief.replaceAll("report.md", "old.md").replaceAll("node check.mjs", "node old-check.mjs"));
  recordProjectVerificationOutcome(f.state, await executeWorkspaceTool("read_file", { path: "README.md" }, f.config), f.config);
  await fs.unlink(f.file); await fs.writeFile(readme, "# Guide\n\nOrdinary non-mandatory examples.\n");
  resume(f); assert.deepEqual(f.state.meta.projectVerification.requiredOutputs, ["report.md"]); assert.deepEqual(f.state.meta.projectVerification.requiredCommands, ["node check.mjs"]);
});
for (const mode of ["missing", "directory", "invalid-utf8"]) test(`legacy single-source ${mode} acceptance is retained`, async t => {
  const f = await fixture(t); delete f.state.meta.projectVerification.acceptanceBySource;
  const before = selected(f.state.meta.projectVerification); await fs.unlink(f.file);
  if (mode === "directory") await fs.mkdir(f.file); else if (mode === "invalid-utf8") await fs.writeFile(f.file, Buffer.from([0xff]));
  resume(f); assert.deepEqual(selected(f.state.meta.projectVerification), before);
});
test("legacy single-source current source still adopts the current parser", async t => {
  const f = await fixture(t); delete f.state.meta.projectVerification.acceptanceBySource;
  f.state.meta.projectVerification.requiredCommands = ["obsolete-tool start"];
  resume(f); assert.deepEqual(f.state.meta.projectVerification.requiredCommands, ["node check.mjs"]);
});
test("restoring a missing source on a later continuation refreshes its acceptance", async t => {
  const f = await fixture(t); await fs.unlink(f.file); resume(f);
  await fs.writeFile(f.file, brief.replaceAll("report.md", "restored.md")); resume(f);
  assert.deepEqual(f.state.meta.projectVerification.requiredOutputs, ["restored.md"]); assert.deepEqual(f.state.meta.projectVerification.requiredCommands, ["node check.mjs"]);
});
test("a new task does not inherit a previous task's retained acceptance", async t => {
  const f = await fixture(t); await fs.unlink(f.file);
  const result = applyContinuationContractTransition(f.state, "Start a different task. Create fresh.md with a short note.");
  assert.equal(result.preserveTaskBoundary, false); assert.equal(f.state.meta.projectVerification, undefined);
  const contract = completionTaskContract(f.config, f.state); assert.ok(!contract.exactOutputPaths.includes("report.md")); assert.ok(!contract.requiredProjectCommands.includes("node check.mjs"));
});
for (const kind of ["internal-file", "workspace-root"]) test(`selected ${kind} alias retains current acceptance identity`, async t => {
  const f = await fixture(t);
  if (kind === "internal-file") { await fs.rename(f.file, f.workspace + "/actual.md"); await fs.symlink("actual.md", f.file); }
  else { await fs.symlink(f.workspace, f.root + "/selected"); f.state.commandCwd = f.root + "/selected"; f.config.commandCwd = f.root + "/selected"; }
  resume(f); assert.deepEqual(f.state.meta.projectVerification.requiredOutputs, ["report.md"]);
});
for (const fault of ["growth", "replace", "truncate", "mode", "read-error"]) test(`live ${fault} discards acceptance refresh without dropping the previous contract`, async t => {
  const f = await fixture(t), before = selected(f.state.meta.projectVerification), read = sync.readSync; let injected = false;
  t.mock.method(sync, "readSync", (...args) => {
    const n = Reflect.apply(read, sync, args);
    if (!injected) { injected = true;
      if (fault === "growth") sync.appendFileSync(f.file, "x".repeat(300000));
      else if (fault === "replace") { sync.renameSync(f.file, f.file + ".old"); sync.writeFileSync(f.file, "# Replacement\n"); }
      else if (fault === "truncate") sync.truncateSync(f.file, 0);
      else if (fault === "mode") sync.chmodSync(f.file, (sync.statSync(f.file).mode & 0o777) ^ 0o100);
      else throw Object.assign(Error("Synthetic acceptance read error"), { code: "EIO" });
    } return n;
  });
  try { resume(f); assert.equal(injected, true); assert.deepEqual(selected(f.state.meta.projectVerification), before); } finally { t.mock.restoreAll(); }
});
test("real FIFO refresh preserves prior acceptance without waiting for a writer", { timeout: 12000 }, async t => {
  if (process.platform === "win32") return t.skip("POSIX FIFO only");
  const f = await fixture(t); await fs.unlink(f.file); assert.equal(spawnSync("mkfifo", [f.file], { timeout: 2000 }).status, 0);
  const state = JSON.stringify(f.state), code = `import {resetSameTaskExecutionContract as reset} from ${JSON.stringify(pathToFileURL(path.join(runtime, "src/agent-runner.js")).href)};const state=JSON.parse(process.argv[1]);reset(state,2);if(state.meta.projectVerification.requiredCommands[0]!=="node check.mjs")throw Error("Lost acceptance");console.log("FIFO_ACCEPTANCE_RETAINED");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, state], { env: { PATH: process.env.PATH, HOME: f.root }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", expired = false; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
  const exit = await new Promise((resolve, reject) => { const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 6000);
    child.once("error", e => { clearTimeout(timer); reject(e); }); child.once("close", c => { clearTimeout(timer); resolve(c); }); });
  assert.equal(expired, false); assert.equal(exit, 0, err); assert.match(out, /FIFO_ACCEPTANCE_RETAINED/);
});

const descriptor = (name, properties, required) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties, required, additionalProperties: false } } });
const tools = [descriptor("write_file", { path: { type: "string" }, content: { type: "string" }, mode: { type: "string", enum: ["create", "overwrite"] } }, ["path"]),
  descriptor("run_command", { command: { type: "string" } }, ["command"]), descriptor("finish", { result: { type: "string" } }, ["result"])];
function offered(f) {
  const config = nextStepRuntimeConfig(f.config, f.state);
  return { config, tools: selectProgressiveTools(tools, { config, goal: f.state.goal, profile: "code", messages: f.state.messages }) };
}
for (const mode of ["prefix", "suffix", "byte-preview"]) test(`partial ${mode} read cannot authorize creation before its verifier`, async t => {
  const f = await fixture(t);
  const beforeEdits = "First run the check before making any changes.\n";
  await fs.writeFile(f.file, mode === "suffix" ? beforeEdits + brief : brief + beforeEdits);
  const read = await executeWorkspaceTool("read_file", { path: "TASK.md", ...(mode === "prefix" ? { lineLimit: brief.split("\n").length - 1 } : mode === "suffix" ? { startLine: 2, lineLimit: 1000 } : {}) }, f.config);
  if (mode === "byte-preview") { read.content = brief; read.contentTruncated = true; }
  recordProjectVerificationOutcome(f.state, read, f.config);
  assert.equal(f.state.meta.projectVerification.acceptanceBySource["TASK.md"].commandsAreFinalVerification, false);
  assert.deepEqual(offered(f).config.requiredProjectCommandCreationPaths || [], []);
});
for (const field of ["startLine", "contentTruncatedByLines", "lineCount", "bytes", "sha256"]) test(`missing ${field} read evidence cannot authorize completion-time ordering`, async t => {
  const f = await fixture(t), read = await executeWorkspaceTool("read_file", { path: "TASK.md" }, f.config);
  delete read[field]; recordProjectVerificationOutcome(f.state, read, f.config);
  assert.equal(f.state.meta.projectVerification.acceptanceBySource["TASK.md"].commandsAreFinalVerification, false);
  assert.deepEqual(offered(f).config.requiredProjectCommandCreationPaths || [], []);
});
test("a read receipt cannot authorize ordering after its source has changed", async t => {
  const f = await fixture(t), read = await executeWorkspaceTool("read_file", { path: "TASK.md" }, f.config);
  await fs.appendFile(f.file, "First run the check before making any changes.\n");
  recordProjectVerificationOutcome(f.state, read, f.config);
  assert.equal(f.state.meta.projectVerification.acceptanceBySource["TASK.md"].commandsAreFinalVerification, false);
  assert.deepEqual(offered(f).config.requiredProjectCommandCreationPaths || [], []);
});
test("a partial reread cannot erase previously complete output or command obligations", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, "# Current status\n\n" + brief);
  recordProjectVerificationOutcome(f.state, await executeWorkspaceTool("read_file", { path: "TASK.md", lineLimit: 1 }, f.config), f.config);
  assert.deepEqual(f.state.meta.projectVerification.requiredOutputs, ["report.md"]);
  assert.deepEqual(f.state.meta.projectVerification.requiredCommands, ["node check.mjs"]);
  assert.equal(f.state.meta.projectVerification.acceptanceBySource["TASK.md"].commandsAreFinalVerification, false);
});
for (const mode of ["complete-range", "crlf", "unicode"]) test(`complete ${mode} read still proves final-verification ordering`, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, mode === "crlf" ? brief.replaceAll("\n", "\r\n") : mode === "unicode" ? "# 项目 — 検証\n" + brief : brief);
  const read = await executeWorkspaceTool("read_file", { path: "TASK.md", ...(mode === "complete-range" ? { startLine: 1, lineLimit: 1000 } : {}) }, f.config);
  recordProjectVerificationOutcome(f.state, read, f.config);
  assert.equal(f.state.meta.projectVerification.acceptanceBySource["TASK.md"].commandsAreFinalVerification, true);
});
test("required verification coexists with create-only exact missing outputs", async t => {
  const f = await fixture(t); resume(f); const view = offered(f);
  assert.equal(view.config.requiredProjectCommandPending, true);
  assert.deepEqual(new Set(view.config.requiredProjectCommandCreationPaths), new Set(["report.md", "notes.md"]));
  assert.deepEqual(view.tools.map(t => t.function.name), ["write_file", "run_command", "finish"]);
  const contract = createToolContract(view.tools);
  const accept = args => validateToolCallBatch([{ id: "owned_create", type: "function", function: { name: "write_file", arguments: JSON.stringify(args) } }], contract).ok;
  assert.equal(accept({ path: "report.md", mode: "create", content: "# Report\n" }), true);
  for (const args of [{ path: "report.md", mode: "overwrite", content: "x" }, { path: "other.md", mode: "create", content: "x" }, { path: "../outside.md", mode: "create", content: "x" }, { path: "report.md", content: "x" }]) assert.equal(accept(args), false);
});
test("existing outputs cannot be overwritten through the verification creation option", async t => {
  const f = await fixture(t); resume(f); await fs.writeFile(f.workspace + "/report.md", "Existing output\n");
  const view = offered(f); assert.deepEqual(view.config.requiredProjectCommandCreationPaths, ["notes.md"]);
  assert.deepEqual(view.tools.find(t => t.function.name === "write_file").function.parameters.properties.path.enum, ["notes.md"]);
});
test("after outputs exist only the exact required command and finish remain", async t => {
  const f = await fixture(t); resume(f); await fs.writeFile(f.workspace + "/report.md", "Report\n"); await fs.writeFile(f.workspace + "/notes.md", "Note\n");
  const view = offered(f); assert.deepEqual(view.tools.map(t => t.function.name), ["run_command", "finish"]);
  assert.deepEqual(view.tools[0].function.parameters.properties.command.enum, ["node check.mjs"]);
});
for (const permission of ["disabled", "safe-approval"]) test(`verification creation respects ${permission} file permissions`, async t => {
  const f = await fixture(t); resume(f);
  if (permission === "disabled") f.config.allowFileTools = false; else f.config.workspaceWritePolicy = "prompt";
  const view = offered(f); assert.deepEqual(view.config.requiredProjectCommandCreationPaths || [], []);
  assert.equal(view.tools.some(t => t.function.name === "write_file"), false);
});
test("opaque, secret and outside paths never enter the creation option", async t => {
  const f = await fixture(t); resume(f);
  f.state.meta.projectVerification.requiredOutputs.push("result.pdf", ".env", "../outside.md", f.root + "/outside.md");
  const view = offered(f); assert.deepEqual(new Set(view.config.requiredProjectCommandCreationPaths), new Set(["notes.md", "report.md"]));
});
test("a status-only continuation does not gain output creation from old acceptance", async t => {
  const f = await fixture(t); applyContinuationContractTransition(f.state, "Continue the same task. Show me the current status; do not create or modify files.");
  const view = offered(f); assert.deepEqual(view.config.requiredProjectCommandCreationPaths || [], []);
});
test("an observed failing verifier retains repair instead of the creation option", async t => {
  const f = await fixture(t); resume(f);
  recordProjectVerificationOutcome(f.state, { toolName: "run_command", ok: false, args: { command: "node check.mjs" }, exitCode: 1, stdout: "", stderr: "AssertionError: output is not valid" }, f.config);
  const view = offered(f); assert.equal(view.config.testFailureRepairActive, true);
  assert.deepEqual(view.config.requiredProjectCommandCreationPaths || [], []); assert.equal(view.tools.some(t => t.function.name === "write_file"), false);
});
test("stale configured creation paths are rebuilt from current owned requirements", async t => {
  const f = await fixture(t); resume(f); f.config.requiredProjectCommandCreationPaths = ["../outside.md"];
  const view = offered(f); assert.deepEqual(new Set(view.config.requiredProjectCommandCreationPaths), new Set(["notes.md", "report.md"]));
});
for (const instruction of ["", "First run the check before making any changes.\n", "在创建任何文件之前先运行检查。\n", "変更前に最初に検証を実行してください。\n"]) test(`unknown or prior-mutation source timing keeps command-first: ${instruction || "unknown"}`, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, instruction ? instruction + brief : brief.replace("must run before completion", "must run for this project"));
  resume(f); const view = offered(f);
  assert.deepEqual(view.config.requiredProjectCommandCreationPaths || [], []);
  assert.deepEqual(view.tools.map(t => t.function.name), ["run_command", "finish"]);
});
test("an explicit current first-check instruction cannot gain the creation option", async t => {
  const f = await fixture(t);
  applyContinuationContractTransition(f.state, "Continue the same task. First run `node check.mjs` before creating notes.md.");
  assert.deepEqual(offered(f).config.requiredProjectCommandCreationPaths || [], []);
});
test("legacy ordering can be observed without changing its exact retained obligations", async t => {
  const f = await fixture(t); resume(f); delete f.state.meta.projectVerification.acceptanceBySource["TASK.md"].commandsAreFinalVerification;
  const before = selected(f.state.meta.projectVerification); const view = offered(f);
  assert.deepEqual(new Set(view.config.requiredProjectCommandCreationPaths), new Set(["notes.md", "report.md"]));
  assert.deepEqual(selected(f.state.meta.projectVerification), before);
});
test("legacy timing observation cannot adopt changed outputs or commands", async t => {
  const f = await fixture(t); resume(f); delete f.state.meta.projectVerification.acceptanceBySource["TASK.md"].commandsAreFinalVerification;
  const before = selected(f.state.meta.projectVerification); await fs.writeFile(f.file, brief.replace("report.md", "other.md"));
  assert.deepEqual(offered(f).config.requiredProjectCommandCreationPaths || [], []);
  assert.deepEqual(selected(f.state.meta.projectVerification), before);
});
test("a different configured workspace cannot reuse source ordering authority", async t => {
  const f = await fixture(t); resume(f); await fs.mkdir(f.root + "/other");
  f.config.commandCwd = f.root + "/other";
  assert.deepEqual(offered(f).config.requiredProjectCommandCreationPaths || [], []);
});
