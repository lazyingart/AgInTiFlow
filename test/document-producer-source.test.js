import assert from "node:assert/strict";
import fs from "node:fs/promises";
import sync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { documentQualityCommitAssessment } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const source = "\\documentclass{article}\n\\begin{document}Status note.\\end{document}\n";
async function fixture(t, content = source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-producer-source-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  const workspace = root + "/workspace", outside = root + "/outside", file = workspace + "/status-note.tex";
  await fs.mkdir(workspace); await fs.mkdir(outside); await fs.writeFile(file, content);
  const goal = "Create status-note.tex and status-note.pdf, compile them and commit only those outputs.";
  const state = { goal, commandCwd: workspace, meta: { goalContract: { revision: 1, activeGoal: goal, currentRequest: goal },
    projectVerification: { mutationRevision: 1, mutationHistory: [{ revision: 1, goalRevision: 1, toolName: "write_file", paths: ["status-note.tex"] }] } } };
  const config = { commandCwd: workspace, baseDir: workspace, taskProfile: "writing", allowFileTools: true, allowShellTool: true, sandboxMode: "host",
    documentArtifactValidator: async () => ({ ok: false, checked: true, artifacts: [], defects: [{ code: "missing-document-artifact" }], reason: "No verified PDF exists yet." }) };
  return { root, workspace, outside, file, state, config };
}
async function command(f) {
  const result = await documentQualityCommitAssessment(f.state, "run_command", { command: "git add -- status-note.tex status-note.pdf && git commit -m note" }, f.config);
  assert.equal(result?.ok, false); return f.state.meta.completionEvidenceRepair?.documentArtifactProducerCommand || "";
}
test("a complete ordinary source still selects the existing PDF engine", async t => {
  const f = await fixture(t); assert.match(await command(f), /^pdflatex .*status-note\.tex/); assert.equal(await fs.readFile(f.file, "utf8"), source);
});
for (const packageText of ["\\usepackage{fontspec}", "\\setmainfont{Owned Test Font}", "\\setCJKmainfont{Owned Test Font}"]) test(`XeLaTeX selection keeps ${packageText}`, async t => {
  const f = await fixture(t, "\ufeff% 状態😀\r\n" + packageText + "\r\n" + source);
  assert.match(await command(f), /^xelatex .*status-note\.tex/);
});
for (const kind of ["missing", "directory", "empty", "whitespace", "oversized", "invalid-utf8", "nul"]) test(`a ${kind} source supplies no inferred command or default-engine guess`, async t => {
  const f = await fixture(t); await fs.unlink(f.file);
  if (kind === "directory") await fs.mkdir(f.file);
  else if (kind !== "missing") await fs.writeFile(f.file, kind === "empty" ? "" : kind === "whitespace" ? " \r\n" : kind === "oversized" ? "%" + "a".repeat(220000)
    : kind === "invalid-utf8" ? Buffer.from([0xff]) : source + "\0");
  assert.equal(await command(f), "");
});
for (const target of ["outside", ".env", ".git/config"]) test(`a ${target} alias never authorizes an inferred compiler`, async t => {
  const f = await fixture(t), file = target === "outside" ? f.outside + "/record.tex" : f.workspace + "/" + target;
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "\\usepackage{fontspec}\n" + source); await fs.unlink(f.file); await fs.symlink(file, f.file);
  assert.equal(await command(f), "");
});
test("an optional external read root cannot authorize automatic compilation of a replaced output", async t => {
  const f = await fixture(t); await fs.writeFile(f.outside + "/record.tex", source); await fs.unlink(f.file); await fs.symlink(f.outside + "/record.tex", f.file);
  f.config.readOnlyRoots = [f.outside]; f.config.skillReadOnlyRoots = [f.outside]; f.config.allowOutsideWorkspaceFileTools = true; f.config.allowDestructive = true;
  const before = { ...f.config }; assert.equal(await command(f), ""); assert.deepEqual(f.config, before);
});
test("active source scope is preserved during command inference", async t => {
  const f = await fixture(t); await fs.mkdir(f.workspace + "/selected"); f.config.workspacePathScopeRoots = ["selected"];
  assert.equal(await command(f), "");
});
for (const permission of ["allowFileTools", "allowShellTool"]) test(`explicit ${permission}=false performs no source I/O`, async t => {
  const f = await fixture(t); f.config[permission] = false; let calls = 0;
  for (const name of ["readFileSync", "openSync", "statSync", "realpathSync", "lstatSync"]) t.mock.method(sync, name, () => { calls++; throw Error("Disabled source I/O"); });
  try { assert.equal(await command(f), ""); assert.equal(calls, 0); } finally { t.mock.restoreAll(); }
});
test("an authorized internal source alias remains readable", async t => {
  const f = await fixture(t); await fs.rename(f.file, f.workspace + "/canonical.tex"); await fs.symlink("canonical.tex", f.file);
  assert.match(await command(f), /^pdflatex /);
});
test("an explicit workspace root alias retains its source authority", async t => {
  const f = await fixture(t); await fs.symlink(f.workspace, f.root + "/selected"); f.config.commandCwd = f.root + "/selected"; f.config.baseDir = f.root + "/selected";
  assert.match(await command(f), /^pdflatex /);
});
test("a live binding swap cannot produce a compiler command from the snapshot", async t => {
  const f = await fixture(t), read = sync.readSync; let swapped = false;
  t.mock.method(sync, "readSync", (...args) => { const n = Reflect.apply(read, sync, args); if (!swapped) { swapped = true;
    sync.renameSync(f.file, f.file + ".old"); sync.writeFileSync(f.file, "\\usepackage{fontspec}\n" + source); } return n; });
  try { assert.equal(await command(f), ""); assert.equal(swapped, true); } finally { t.mock.restoreAll(); }
});
