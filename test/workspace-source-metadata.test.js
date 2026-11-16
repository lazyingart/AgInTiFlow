import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const runtime = process.env.AGINTI_TEST_MOVE_RUNTIME || new URL("../", import.meta.url).pathname;
const { executeWorkspaceTool } = await import(pathToFileURL(path.join(runtime, "src/workspace-tools.js")));
const { publishWorkspaceTextFile } = await import(pathToFileURL(path.join(runtime, "src/workspace-file-publication.js")));
const content = "# Planning note\nKeep every line.\n", sha = value => crypto.createHash("sha256").update(value).digest("hex");
async function fixture(t, mode = 0o600) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-source-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "note.md"), destination = path.join(root, "archive/note.md");
  await fs.writeFile(source, content); await fs.chmod(source, mode);
  return { root, source, destination, config: { commandCwd: root, allowFileTools: true, sandboxMode: "host" } };
}
function replace(t, object, name, wrap) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { ...descriptor, value: wrap(descriptor.value) });
  t.after(() => Object.defineProperty(object, name, descriptor));
}
const move = "*** Begin Patch\n*** Update File: note.md\n*** Move to: archive/note.md\n*** End Patch";
for (const operation of ["copy", "move"]) for (const mode of [0o600, 0o640, 0o750, 0o440]) {
  test(`${operation} preserves source mode ${mode.toString(8)}, owner, bytes and a real receipt`, async t => {
    const f = await fixture(t, mode), before = await fs.stat(f.source);
    const result = await executeWorkspaceTool(operation === "move" ? "apply_patch" : "write_file", operation === "move"
      ? { patch: move } : { path: "archive/note.md", copyFromPath: "note.md", copyFromSha256: sha(content), mode: "create" }, f.config);
    assert.equal(result.ok, true);
    const after = await fs.stat(f.destination);
    const expectedMode = operation === "move" ? mode : mode & ~process.umask();
    assert.deepEqual([after.mode & 0o7777, after.uid, after.gid], [expectedMode, before.uid, before.gid]);
    assert.equal(await fs.readFile(f.destination, "utf8"), content);
    assert.deepEqual(result.change.publication.sourceMetadata, { mode: expectedMode, uid: before.uid, gid: before.gid });
    assert.equal(result.change.afterHash, sha(content));
    if (operation === "move") await assert.rejects(fs.stat(f.source), { code: "ENOENT" });
    else assert.equal(await fs.readFile(f.source, "utf8"), content);
  });
}
test("normal newly authored files still follow the caller umask", async t => {
  const f = await fixture(t);
  const result = await executeWorkspaceTool("write_file", { path: "authored.md", content, mode: "create" }, f.config);
  assert.equal((await fs.stat(path.join(f.root, "authored.md"))).mode & 0o777, 0o666 & ~process.umask());
  assert.equal(result.change.publication.sourceMetadata, undefined);
});
for (const operation of ["copy", "move"]) test(`${operation} honors its own semantics under a restrictive caller umask`, async t => {
  const f = await fixture(t, 0o644), prior = process.umask(0o077);
  try {
    const result = await executeWorkspaceTool(operation === "move" ? "apply_patch" : "write_file", operation === "move"
      ? { patch: move } : { path: "archive/note.md", copyFromPath: "note.md", copyFromSha256: sha(content) }, f.config);
    assert.equal(result.ok, true); assert.equal((await fs.stat(f.destination)).mode & 0o777, operation === "move" ? 0o644 : 0o600);
  } finally { process.umask(prior); }
});
test("model-supplied permission fields cannot widen a source-derived copy", async t => {
  const f = await fixture(t);
  await executeWorkspaceTool("write_file", { path: "archive/note.md", copyFromPath: "note.md", copyFromSha256: sha(content), mode: 0o777, uid: 0, gid: 0 }, f.config);
  assert.equal((await fs.stat(f.destination)).mode & 0o777, 0o600);
});
test("a configured read-only source keeps its mode without broadening the read scope", async t => {
  const f = await fixture(t), allowed = path.join(f.root, "allowed"), workspace = path.join(f.root, "project");
  await fs.mkdir(allowed); await fs.mkdir(workspace); await fs.rename(f.source, path.join(allowed, "note.md"));
  const other = path.join(f.root, "other.md"); await fs.writeFile(other, "Unapproved input\n");
  const config = { ...f.config, commandCwd: workspace, readOnlyRoots: [allowed] };
  await executeWorkspaceTool("write_file", { path: "copy.md", copyFromPath: path.join(allowed, "note.md"), copyFromSha256: sha(content) }, config);
  assert.equal((await fs.stat(path.join(workspace, "copy.md"))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(allowed, "note.md"), "utf8"), content);
  await assert.rejects(executeWorkspaceTool("write_file", { path: "forbidden.md", copyFromPath: other, copyFromSha256: sha("Unapproved input\n") }, config));
  await assert.rejects(fs.stat(path.join(workspace, "forbidden.md")), { code: "ENOENT" });
});
for (const kind of ["symlink", "hardlink"]) test(`a permitted ${kind} copy remains independent and never widens source mode`, async t => {
  const f = await fixture(t), alias = path.join(f.root, "alias.md");
  if (kind === "symlink") await fs.symlink(f.source, alias); else await fs.link(f.source, alias);
  const result = await executeWorkspaceTool("write_file", { path: "archive/note.md", copyFromPath: "alias.md", copyFromSha256: sha(content) }, f.config);
  assert.equal(result.ok, true); assert.equal((await fs.stat(f.destination)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.destination)).nlink, 1);
  await fs.writeFile(f.destination, "Changed copy\n"); assert.equal(await fs.readFile(f.source, "utf8"), content);
});
test("copying readable special-mode text strips special bits rather than inheriting them", async t => {
  const f = await fixture(t); await fs.chmod(f.source, 0o4600);
  const result = await executeWorkspaceTool("write_file", { path: "archive/note.md", copyFromPath: "note.md", copyFromSha256: sha(content) }, f.config);
  assert.equal(result.ok, true); assert.equal((await fs.stat(f.destination)).mode & 0o7777, 0o600);
  assert.equal((await fs.stat(f.source)).mode & 0o7777, 0o4600);
});
test("readable foreign-uid copy metadata does not request source ownership", async t => {
  const f = await fixture(t), fakeOwner = stat => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
    { uid: typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1 });
  replace(t, fs, "lstat", original => async function (file, ...args) {
    const stat = await Reflect.apply(original, this, [file, ...args]); return file === f.source ? fakeOwner(stat) : stat;
  });
  replace(t, fs, "open", original => async function (file, ...args) {
    const handle = await Reflect.apply(original, this, [file, ...args]);
    if (file === f.source) { const stat = handle.stat; handle.stat = async function (...options) { return fakeOwner(await Reflect.apply(stat, this, options)); }; }
    return handle;
  });
  const result = await executeWorkspaceTool("write_file", { path: "archive/note.md", copyFromPath: "note.md", copyFromSha256: sha(content) }, f.config);
  const actual = await fs.stat(f.destination);
  assert.equal(result.ok, true); assert.equal(actual.uid, process.getuid()); assert.equal(actual.mode & 0o777, 0o600);
  assert.equal(result.change.publication.sourceMetadata.uid, actual.uid);
});
test("hunked moves retain source metadata while applying only the requested text edit", async t => {
  const f = await fixture(t, 0o640);
  const result = await executeWorkspaceTool("apply_patch", { patch: move.replace("*** End Patch", "@@\n-# Planning note\n+# Review note\n*** End Patch") }, f.config);
  assert.equal(result.ok, true); assert.equal((await fs.stat(f.destination)).mode & 0o777, 0o640);
  assert.equal(await fs.readFile(f.destination, "utf8"), content.replace("Planning", "Review"));
});
test("a stale metadata source hash is rejected before the destination appears", async t => {
  const f = await fixture(t), source = { root: f.root, absolutePath: f.source, relativePath: "note.md" };
  await assert.rejects(publishWorkspaceTextFile({ root: f.root, absolutePath: f.destination, relativePath: "archive/note.md" }, Buffer.from(content), {
    createOnly: true, metadataSource: source, expectedSourceHash: "0".repeat(64),
  }), { code: "WORKSPACE_WRITE_CONFLICT" });
  await assert.rejects(fs.stat(f.destination), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.source, "utf8"), content);
});
for (const change of ["bytes", "mode"]) test(`a source ${change} change while staging never publishes or deletes it`, async t => {
  const f = await fixture(t, 0o640), h = await fs.open(path.join(f.root, "sentinel"), "wx"), prototype = Object.getPrototypeOf(h);
  await h.close(); await fs.unlink(path.join(f.root, "sentinel")); let fired = false;
  replace(t, prototype, "sync", original => async function (...args) {
    const result = await Reflect.apply(original, this, args);
    if (!fired && (await fs.readlink(`/proc/self/fd/${this.fd}`)).includes(".aginti-write-")) {
      fired = true; if (change === "bytes") await fs.appendFile(f.source, "Owner addition\n"); else await fs.chmod(f.source, 0o600);
    }
    return result;
  });
  await assert.rejects(executeWorkspaceTool("apply_patch", { patch: move }, f.config), { code: "WORKSPACE_WRITE_CONFLICT" });
  assert.equal(fired, true); await assert.rejects(fs.stat(f.destination), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.source, "utf8"), content + (change === "bytes" ? "Owner addition\n" : ""));
  assert.deepEqual((await fs.readdir(path.dirname(f.destination))).filter(n => n.includes(".aginti-write-")), []);
  const retried = await executeWorkspaceTool("apply_patch", { patch: move }, f.config);
  assert.equal(retried.ok, true);
  assert.equal(await fs.readFile(f.destination, "utf8"), content + (change === "bytes" ? "Owner addition\n" : ""));
  assert.equal((await fs.stat(f.destination)).mode & 0o777, change === "mode" ? 0o600 : 0o640);
});
test("a successful chmod call that did not preserve metadata is still rejected", async t => {
  const f = await fixture(t, 0o750), h = await fs.open(path.join(f.root, "sentinel"), "wx"), prototype = Object.getPrototypeOf(h);
  await h.close(); await fs.unlink(path.join(f.root, "sentinel")); let fired = false;
  replace(t, prototype, "chmod", original => async function (...args) {
    if ((await fs.readlink(`/proc/self/fd/${this.fd}`)).includes(".aginti-write-")) { fired = true; return; }
    return Reflect.apply(original, this, args);
  });
  await assert.rejects(executeWorkspaceTool("apply_patch", { patch: move }, f.config), { code: "WORKSPACE_WRITE_CONFLICT" });
  assert.equal(fired, true); await assert.rejects(fs.stat(f.destination), { code: "ENOENT" });
  assert.equal((await fs.stat(f.source)).mode & 0o777, 0o750);
});
for (const kind of ["symlink", "hardlink", "special-bits"]) test(`unsupported metadata source ${kind} is not silently downgraded`, async t => {
  const f = await fixture(t);
  if (kind === "symlink") { await fs.rename(f.source, f.source + ".original"); await fs.symlink(f.source + ".original", f.source); }
  if (kind === "hardlink") await fs.link(f.source, f.source + ".alias");
  if (kind === "special-bits") await fs.chmod(f.source, 0o4600);
  await assert.rejects(executeWorkspaceTool("apply_patch", { patch: move }, f.config));
  await assert.rejects(fs.stat(f.destination), { code: "ENOENT" }); assert.equal(await fs.readFile(f.source, "utf8"), content);
});
