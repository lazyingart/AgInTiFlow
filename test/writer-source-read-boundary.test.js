import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { groundWritingSpecialistArgsFromReadEvidence } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { executeWorkspaceTool } = await import(pathToFileURL(path.join(runtime, "src/workspace-tools.js")));
const original = "Authorized source: the orchard trial used eight samples.\n";
const excluded = "Synthetic excluded context: VIOLET_LIGHTHOUSE.\n";
const args = { writingBrief: "Write a short report based on notes.md.", canon: "notes.md is the sole source of truth." };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-writer-source-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  const workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
  await fs.mkdir(workspace); await fs.mkdir(outside);
  await fs.writeFile(path.join(workspace, "notes.md"), original);
  const config = { commandCwd: workspace, baseDir: workspace, sandboxMode: "host", allowFileTools: true,
    allowDestructive: false, readOnlyRoots: [] };
  return { root, workspace, outside, config };
}
async function stateFor(config, names = ["notes.md"], readArgs = {}) {
  const messages = [];
  for (const [index, name] of names.entries()) {
    const call = { path: name, ...readArgs }, result = await executeWorkspaceTool("read_file", call, config), id = `read_${index}`;
    messages.push({ role: "assistant", tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify(call) } }] },
      { role: "tool", tool_call_id: id, content: JSON.stringify(result) });
  }
  return { messages, meta: {} };
}
function empty(result) {
  assert.deepEqual(result.groundedPaths, []); assert.equal(result.groundedBytes, 0);
  assert.equal(result.args, args); assert.ok(!result.args.writingBrief.includes("VIOLET_LIGHTHOUSE"));
}

test("source-backed writing keeps a detached current native read without changing caller arguments", async t => {
  const { config } = await fixture(t), state = await stateFor(config), before = JSON.stringify(args);
  const result = await groundWritingSpecialistArgsFromReadEvidence(args, state, config);
  assert.deepEqual(result.groundedPaths, ["notes.md"]); assert.equal(result.groundedBytes, Buffer.byteLength(original));
  assert.ok(result.args.writingBrief.includes(original)); assert.equal(JSON.stringify(args), before);
});
test("a partial retained excerpt can ground the complete bounded authorized source", async t => {
  const { config, workspace } = await fixture(t); const text = "First line.\nSecond source fact.\n";
  await fs.writeFile(path.join(workspace, "notes.md"), text);
  const state = await stateFor(config, ["notes.md"], { lineLimit: 1 });
  const result = await groundWritingSpecialistArgsFromReadEvidence(args, state, config);
  assert.ok(result.args.writingBrief.includes(text)); assert.equal(result.groundedBytes, Buffer.byteLength(text));
});
test("a current authorized edit is reread rather than treating the old snapshot as current bytes", async t => {
  const { config, workspace } = await fixture(t), state = await stateFor(config), current = "Current source: review is still pending.\n";
  await fs.writeFile(path.join(workspace, "notes.md"), current);
  const result = await groundWritingSpecialistArgsFromReadEvidence(args, state, config);
  assert.ok(result.args.writingBrief.includes(current)); assert.ok(!result.args.writingBrief.includes(original));
});
for (const kind of ["outside", "env", "git"]) test(`a prior read cannot authorize a later ${kind} alias`, async t => {
  const { config, workspace, outside } = await fixture(t), state = await stateFor(config);
  const target = kind === "outside" ? path.join(outside, "record.txt") : kind === "env" ? path.join(workspace, ".env") : path.join(workspace, ".git/config");
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, excluded);
  await fs.unlink(path.join(workspace, "notes.md")); await fs.symlink(target, path.join(workspace, "notes.md"));
  await assert.rejects(executeWorkspaceTool("read_file", { path: "notes.md" }, config), { code: "WORKSPACE_READ_SCOPE" });
  empty(await groundWritingSpecialistArgsFromReadEvidence(args, state, config));
});
test("inside-workspace aliases remain readable", async t => {
  const { config, workspace } = await fixture(t), state = await stateFor(config);
  await fs.rename(path.join(workspace, "notes.md"), path.join(workspace, "current.md"));
  await fs.symlink("current.md", path.join(workspace, "notes.md"));
  const result = await groundWritingSpecialistArgsFromReadEvidence(args, state, config);
  assert.deepEqual(result.groundedPaths, ["notes.md"]); assert.ok(result.args.writingBrief.includes(original));
});
for (const field of ["readOnlyRoots", "skillReadOnlyRoots"]) test(`explicit ${field} still authorizes its selected external source`, async t => {
  const { config, workspace, outside } = await fixture(t), state = await stateFor(config);
  await fs.writeFile(path.join(outside, "record.txt"), excluded); config[field] = [outside];
  await fs.unlink(path.join(workspace, "notes.md")); await fs.symlink(path.join(outside, "record.txt"), path.join(workspace, "notes.md"));
  const result = await groundWritingSpecialistArgsFromReadEvidence(args, state, config);
  assert.deepEqual(result.groundedPaths, ["notes.md"]); assert.ok(result.args.writingBrief.includes(excluded));
});
test("removing a selected read root revokes a retained direct external path", async t => {
  const { config, outside } = await fixture(t); await fs.writeFile(path.join(outside, "notes.md"), original); config.readOnlyRoots = [outside];
  const state = await stateFor(config, [path.join(outside, "notes.md")]); config.readOnlyRoots = [];
  empty(await groundWritingSpecialistArgsFromReadEvidence(args, state, config));
});
test("canonical scope rejects an alias into a different workspace subtree", async t => {
  const { config, workspace } = await fixture(t); await fs.mkdir(path.join(workspace, "section")); await fs.mkdir(path.join(workspace, "other"));
  await fs.writeFile(path.join(workspace, "section/notes.md"), original); await fs.writeFile(path.join(workspace, "other/record.txt"), excluded);
  config.workspacePathScopeRoots = ["section"]; const state = await stateFor(config, ["section/notes.md"]);
  await fs.unlink(path.join(workspace, "section/notes.md")); await fs.symlink("../other/record.txt", path.join(workspace, "section/notes.md"));
  empty(await groundWritingSpecialistArgsFromReadEvidence(args, state, config));
});
test("an explicitly selected workspace root alias keeps its canonical authority", async t => {
  const { config, workspace, root } = await fixture(t); const alias = path.join(root, "selected"); await fs.symlink(workspace, alias);
  config.commandCwd = alias; config.baseDir = alias; const state = await stateFor(config);
  assert.ok((await groundWritingSpecialistArgsFromReadEvidence(args, state, config)).args.writingBrief.includes(original));
});
for (const bytes of [Buffer.from([0xff, 0x61]), Buffer.from("text\0not text")]) test(`invalid text is not silently repaired: ${bytes.toString("hex")}`, async t => {
  const { config, workspace } = await fixture(t), state = await stateFor(config);
  await fs.writeFile(path.join(workspace, "notes.md"), bytes);
  empty(await groundWritingSpecialistArgsFromReadEvidence(args, state, config));
});
test("valid BOM, multibyte text and source line endings are preserved", async t => {
  const { config, workspace } = await fixture(t), text = "\ufeff来源：审查尚未完成。\r\nSecond line.\r\n";
  await fs.writeFile(path.join(workspace, "notes.md"), text); const state = await stateFor(config);
  assert.ok((await groundWritingSpecialistArgsFromReadEvidence(args, state, config)).args.writingBrief.includes(text));
});
for (const bytes of [24 * 1024, 24 * 1024 + 1]) test(`per-source byte bound ${bytes}`, async t => {
  const { config, workspace } = await fixture(t); const text = "source line.\n".repeat(Math.ceil(bytes / 13)).slice(0, bytes);
  await fs.writeFile(path.join(workspace, "notes.md"), text); const state = await stateFor(config);
  const result = await groundWritingSpecialistArgsFromReadEvidence(args, state, config);
  assert.equal(result.groundedBytes, bytes <= 24 * 1024 ? bytes : 0);
});
test("aggregate source text stays within 32 KiB without truncating the next input", async t => {
  const { config, workspace } = await fixture(t); const sizes = [24576, 8192, 1], names = ["alpha.md", "beta.md", "gamma.md"];
  for (let i = 0; i < names.length; i++) await fs.writeFile(path.join(workspace, names[i]), "source line.\n".repeat(sizes[i]).slice(0, sizes[i]));
  const state = await stateFor(config, names), request = { writingBrief: "Write a report based on alpha.md, beta.md and gamma.md." };
  const result = await groundWritingSpecialistArgsFromReadEvidence(request, state, config);
  assert.equal(result.groundedBytes, 32768); assert.deepEqual(result.groundedPaths, ["alpha.md", "beta.md"]);
});
test("growth after metadata observation cannot create an unbounded writer context", async t => {
  const { config, workspace } = await fixture(t), state = await stateFor(config), file = path.join(workspace, "notes.md");
  const stat = fs.stat, open = fs.open; let grown = false;
  const grow = async () => { if (!grown) { grown = true; await fs.writeFile(file, "late source growth. ".repeat(5000)); } };
  t.mock.method(fs, "stat", async (...a) => { const result = await Reflect.apply(stat, fs, a); if (a[0] === file) await grow(); return result; });
  t.mock.method(fs, "open", async (...a) => { if (a[0] === file) await grow(); return Reflect.apply(open, fs, a); });
  empty(await groundWritingSpecialistArgsFromReadEvidence(args, state, config)); assert.equal(grown, true);
});
test("a changed named file during live-handle reading is discarded and the handle closes once", async t => {
  const { config, workspace, outside } = await fixture(t), state = await stateFor(config), file = path.join(workspace, "notes.md");
  await fs.writeFile(path.join(outside, "record.txt"), excluded); const open = fs.open; let changed = false, closes = 0;
  t.mock.method(fs, "open", async (...a) => {
    const handle = await Reflect.apply(open, fs, a); if (a[0] !== file) return handle;
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = async (...args) => { const result = await read(...args); if (!changed) { changed = true; await fs.unlink(file); await fs.symlink(path.join(outside, "record.txt"), file); } return result; };
    handle.close = async () => { closes++; return close(); }; return handle;
  });
  empty(await groundWritingSpecialistArgsFromReadEvidence(args, state, config)); assert.equal(changed, true); assert.equal(closes, 1);
});
for (const mode of ["missing", "directory"]) test(`a ${mode} source is not authoritative context`, async t => {
  const { config, workspace } = await fixture(t), state = await stateFor(config); await fs.unlink(path.join(workspace, "notes.md"));
  if (mode === "directory") await fs.mkdir(path.join(workspace, "notes.md"));
  empty(await groundWritingSpecialistArgsFromReadEvidence(args, state, config));
});
test("explicit file-tool revocation prevents secondary opens", async t => {
  const { config } = await fixture(t), state = await stateFor(config); config.allowFileTools = false; let opens = 0;
  t.mock.method(fs, "open", () => { opens++; throw Error("Source open must not occur"); });
  empty(await groundWritingSpecialistArgsFromReadEvidence(args, state, config)); assert.equal(opens, 0);
});
test("creative writing does not inherit an unrelated source or perform an implicit read", async t => {
  const { config } = await fixture(t), state = await stateFor(config), request = { writingBrief: "Write a quiet harbor scene at dusk." }; let opens = 0;
  t.mock.method(fs, "open", () => { opens++; throw Error("Creative writing must not open sources"); });
  const result = await groundWritingSpecialistArgsFromReadEvidence(request, state, config);
  assert.equal(result.args, request); assert.deepEqual(result.groundedPaths, []); assert.equal(opens, 0);
});
