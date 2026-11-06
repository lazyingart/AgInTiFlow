import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";
import { publishWorkspaceTextFile } from "../src/workspace-file-publication.js";
import { executeWorkspaceTool } from "../src/workspace-tools.js";

const oldText = "# Projecct Handoff\nOwner: Demo Team\nState: draft\n";
const nextText = oldText.replace("Projecct", "Project");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const run = promisify(execFile);
async function workspace(t, content = oldText) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-file-publication-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "note.txt");
  if (content !== null) await fs.writeFile(file, content);
  const target = { root, absolutePath: file, relativePath: "note.txt" };
  const config = { commandCwd: root, sandboxMode: "host", allowFileTools: true };
  return { root, file, target, config };
}
async function noStage(root) { assert.deepEqual((await fs.readdir(root)).filter(n => n.includes(".aginti-")), []); }
async function handlePrototype(root) {
  const file = path.join(root, "sentinel"); const handle = await fs.open(file, "wx");
  const prototype = Object.getPrototypeOf(handle); await handle.close(); await fs.unlink(file); return prototype;
}
function replace(t, object, name, wrap) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { ...descriptor, value: wrap(descriptor.value) });
  t.after(() => Object.defineProperty(object, name, descriptor));
}

test("ordinary replacement preserves exact bytes, mode and native hash receipt", async t => {
  const { root, file, config } = await workspace(t); await fs.chmod(file, 0o600);
  const result = await executeWorkspaceTool("apply_patch", { path: "note.txt", search: "Projecct", replace: "Project" }, config);
  assert.equal(result.ok, true); assert.equal(await fs.readFile(file, "utf8"), nextText);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(result.change.beforeHash, sha(oldText)); assert.equal(result.change.afterHash, sha(nextText));
  assert.equal(result.change.publication.method, "rename"); await noStage(root);
});
test("new Unicode file is published without clobber and has exact UTF-8 receipt", async t => {
  const { root, file, config } = await workspace(t, null); const text = "你好 🌱\n";
  const result = await executeWorkspaceTool("write_file", { path: "note.txt", content: text, mode: "create" }, config);
  assert.equal(result.change.created, true); assert.equal(result.change.beforeHash, null);
  assert.equal(result.change.afterBytes, Buffer.byteLength(text)); assert.equal(result.change.afterHash, sha(text));
  assert.equal(result.change.publication.method, "exclusive-link"); assert.equal(await fs.readFile(file, "utf8"), text); await noStage(root);
});
for (const code of ["EIO", "ENOSPC"]) test(`partial staged write ${code} preserves original, then retry succeeds`, async t => {
  const { root, file, target } = await workspace(t); const prototype = await handlePrototype(root); let injected = false;
  replace(t, prototype, "writeFile", original => async function (data, ...args) {
    if (!injected && Buffer.from(data).equals(Buffer.from(nextText))) {
      injected = true; await Reflect.apply(original, this, [Buffer.from(data).subarray(0, 12), ...args]);
      throw Object.assign(new Error("Synthetic partial staged write"), { code });
    }
    return Reflect.apply(original, this, [data, ...args]);
  });
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.from(nextText)), { code }); assert.equal(injected, true);
  assert.equal(await fs.readFile(file, "utf8"), oldText); await noStage(root);
  await publishWorkspaceTextFile(target, Buffer.from(nextText)); assert.equal(await fs.readFile(file, "utf8"), nextText); await noStage(root);
});
for (const method of ["sync", "chmod", "stat"]) test(`staging ${method} failure preserves original and releases queue`, async t => {
  const { root, file, target } = await workspace(t); const prototype = await handlePrototype(root); let injected = false;
  replace(t, prototype, method, original => async function (...args) {
    // sync/chmod are staging-only. For stat/close, identify the actual temp inode.
    const name = await fs.readlink(`/proc/self/fd/${this.fd}`).catch(() => "");
    if (!injected && name.includes(".aginti-")) {
      injected = true;
      throw Object.assign(new Error(`Synthetic staging ${method}`), { code: "EIO" });
    }
    return Reflect.apply(original, this, args);
  });
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.from(nextText)), { code: "EIO" }); assert.equal(injected, true);
  assert.equal(await fs.readFile(file, "utf8"), oldText); await noStage(root);
  await publishWorkspaceTextFile(target, Buffer.from(nextText)); assert.equal(await fs.readFile(file, "utf8"), nextText); await noStage(root);
});
test("staging close failure preserves original without retrying its descriptor", async t => {
  const { root, file, target } = await workspace(t); let calls = 0;
  replace(t, fs, "open", original => async function (name, ...args) {
    const handle = await Reflect.apply(original, this, [name, ...args]);
    if (String(name).includes(".aginti-")) {
      const close = handle.close;
      handle.close = async function () {
        calls++; await Reflect.apply(close, this, []);
        if (calls === 1) throw Object.assign(new Error("Synthetic close EIO after closing"), { code: "EIO" });
      };
    }
    return handle;
  });
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.from(nextText)), { code: "EIO" });
  assert.equal(calls, 1); assert.equal(await fs.readFile(file, "utf8"), oldText); await noStage(root);
  await publishWorkspaceTextFile(target, Buffer.from(nextText)); assert.equal(calls, 2);
});
test("rename error preserves original and cleanup is attempted", async t => {
  const { root, file, target } = await workspace(t); let injected = false;
  replace(t, fs, "rename", original => async function (from, to) {
    if (to === file && !injected) { injected = true; throw Object.assign(new Error("rename EIO"), { code: "EIO" }); }
    return Reflect.apply(original, this, [from, to]);
  });
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.from(nextText)), { code: "EIO" });
  assert.equal(injected, true); assert.equal(await fs.readFile(file, "utf8"), oldText); await noStage(root);
  await publishWorkspaceTextFile(target, Buffer.from(nextText));
});
test("create-only late writer is protected by kernel no-clobber", async t => {
  const { root, file, target } = await workspace(t, null); let injected = false;
  replace(t, fs, "link", original => async function (from, to) {
    if (to === file) { injected = true; await fs.writeFile(file, "Other writer\n", { flag: "wx" }); }
    return Reflect.apply(original, this, [from, to]);
  });
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.from(nextText), { createOnly: true }), { code: "EEXIST" });
  assert.equal(injected, true); assert.equal(await fs.readFile(file, "utf8"), "Other writer\n"); await noStage(root);
});
test("two processes racing create have one winner and no overwritten receipt", async t => {
  const { root, file, target } = await workspace(t, null); const url = new URL("../src/workspace-file-publication.js", import.meta.url).href;
  const program = `import {publishWorkspaceTextFile} from ${JSON.stringify(url)}; try { await publishWorkspaceTextFile(JSON.parse(process.argv[1]),Buffer.from(process.argv[2]),{createOnly:true});console.log('created'); } catch(e){console.log(e.code);}`;
  const results = await Promise.all(["one", "two"].map(value => run(process.execPath, ["--input-type=module", "-e", program, JSON.stringify(target), value])));
  assert.equal(results.filter(r => r.stdout.trim() === "created").length, 1);
  assert.ok(results.some(r => /EEXIST|WORKSPACE_WRITE_CONFLICT/.test(r.stdout)));
  assert.ok(["one", "two"].includes(await fs.readFile(file, "utf8"))); await noStage(root);
});
test("two same-process stale patches serialize, only one succeeds", async t => {
  const { root, file, target } = await workspace(t);
  const results = await Promise.allSettled(["one", "two"].map(value => publishWorkspaceTextFile(target, Buffer.from(value), { expectedBeforeHash: sha(oldText) })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "WORKSPACE_WRITE_CONFLICT");
  assert.ok(["one", "two"].includes(await fs.readFile(file, "utf8"))); await noStage(root);
});
test("external content change during staging fails stale patch without clobber", async t => {
  const { root, file, target } = await workspace(t); const prototype = await handlePrototype(root); let injected = false;
  replace(t, prototype, "sync", original => async function (...args) {
    if (!injected) { injected = true; await fs.writeFile(file, "Other writer\n"); }
    return Reflect.apply(original, this, args);
  });
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.from(nextText), { expectedBeforeHash: sha(oldText) }), { code: "WORKSPACE_WRITE_CONFLICT" });
  assert.equal(await fs.readFile(file, "utf8"), "Other writer\n"); await noStage(root);
});
for (const kind of ["symlink", "hardlink", "directory", "special-mode", "binary", "invalid-utf8", "oversize"]) test(`reject unsafe existing target: ${kind}`, async t => {
  const { root, file, target } = await workspace(t, null); const foreign = path.join(root, "other.txt");
  await fs.writeFile(foreign, "Protected\n");
  if (kind === "symlink") await fs.symlink(foreign, file);
  if (kind === "hardlink") await fs.link(foreign, file);
  if (kind === "directory") await fs.mkdir(file);
  if (kind === "special-mode") { await fs.writeFile(file, oldText); await fs.chmod(file, 0o4600); }
  if (kind === "binary") await fs.writeFile(file, Buffer.from([65, 0, 66]));
  if (kind === "invalid-utf8") await fs.writeFile(file, Buffer.from([0xff, 0xfe]));
  if (kind === "oversize") await fs.writeFile(file, "x".repeat(220001));
  const before = await fs.lstat(file); const bytes = before.isFile() ? await fs.readFile(file) : null;
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.from(nextText)));
  assert.equal((await fs.lstat(file)).ino, before.ino);
  if (bytes) assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal(await fs.readFile(foreign, "utf8"), "Protected\n"); await noStage(root);
});
test("directory symlink rejected before creating descendants outside workspace", async t => {
  const { root, target } = await workspace(t); const external = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-file-external-"));
  t.after(() => fs.rm(external, { recursive: true, force: true })); await fs.symlink(external, path.join(root, "linked"));
  await assert.rejects(publishWorkspaceTextFile({ ...target, absolutePath: path.join(root, "linked/new/note.txt"), relativePath: "linked/new/note.txt" }, Buffer.from(nextText)), /symlink/);
  assert.deepEqual(await fs.readdir(external), []);
});
test("nested missing parents and workspace-root alias are supported", async t => {
  const { root, target } = await workspace(t); const alias = root + "-alias";
  await fs.symlink(root, alias); t.after(() => fs.unlink(alias));
  await publishWorkspaceTextFile({ ...target, root: alias, absolutePath: path.join(alias, "nested/deep/note.txt"), relativePath: "nested/deep/note.txt" }, Buffer.from(nextText));
  assert.equal(await fs.readFile(path.join(root, "nested/deep/note.txt"), "utf8"), nextText);
});
test("post-publication alias cleanup failure reports committed bytes, never rollback", async t => {
  const { root, file, target } = await workspace(t, null); let stage;
  replace(t, fs, "unlink", original => async function (name) {
    if (String(name).includes(".aginti-")) { stage = name; throw Object.assign(new Error("cleanup EIO"), { code: "EIO" }); }
    return Reflect.apply(original, this, [name]);
  });
  const result = await publishWorkspaceTextFile(target, Buffer.from(nextText));
  assert.equal(result.created, true); assert.equal(result.publication.stagingCleanupPending, true);
  assert.equal(path.isAbsolute(result.publication.stagingPath), false);
  assert.equal(await fs.readFile(file, "utf8"), nextText); assert.equal((await fs.stat(stage)).ino, (await fs.stat(file)).ino);
});
test("native secret and path guards remain in front of publication", async t => {
  const { root, config } = await workspace(t);
  for (const name of ["../escape.txt", ".env", ".git/config"]) {
    const result = await executeWorkspaceTool("write_file", { path: name, content: "bad", mode: "create" }, config);
    assert.equal(result.ok, false); assert.equal(result.blocked, true);
  }
  await noStage(root);
});
test("a silently short staged write is rejected before replacing the original", async t => {
  const { root, file, target } = await workspace(t); const prototype = await handlePrototype(root); let injected = false;
  replace(t, prototype, "writeFile", original => async function (data, ...args) {
    injected = true; return Reflect.apply(original, this, [Buffer.from(data).subarray(0, 12), ...args]);
  });
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.from(nextText)), /verification/);
  assert.equal(injected, true); assert.equal(await fs.readFile(file, "utf8"), oldText); await noStage(root);
});
test("failed new-file staging leaves the requested path absent", async t => {
  const { root, file, target } = await workspace(t, null); const prototype = await handlePrototype(root);
  replace(t, prototype, "sync", () => async function () { throw Object.assign(new Error("sync ENOSPC"), { code: "ENOSPC" }); });
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.from(nextText), { createOnly: true }), { code: "ENOSPC" });
  await assert.rejects(fs.stat(file), { code: "ENOENT" }); await noStage(root);
});
test("create-only existing target is rejected without publication", async t => {
  const { root, file, target } = await workspace(t);
  // Exact publication window: a successful creator still has its staging link.
  await fs.link(file, path.join(root, "winner-alias"));
  assert.equal((await fs.stat(file)).nlink, 2);
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.from(nextText), { createOnly: true }), { code: "EEXIST" });
  assert.equal(await fs.readFile(file, "utf8"), oldText); await noStage(root);
});
test("multi-file add inherits create-only protection for a late writer", async t => {
  const { root, file, config } = await workspace(t, null); let injected = false;
  replace(t, fs, "link", original => async function (from, to) {
    if (to === file) { injected = true; await fs.writeFile(file, "Other writer\n", { flag: "wx" }); }
    return Reflect.apply(original, this, [from, to]);
  });
  await assert.rejects(executeWorkspaceTool("apply_patch", { patch: "*** Begin Patch\n*** Add File: note.txt\n+New note\n*** End Patch" }, config), { code: "EEXIST" });
  assert.equal(injected, true); assert.equal(await fs.readFile(file, "utf8"), "Other writer\n"); await noStage(root);
});
test("oversized content rejects before staging", async t => {
  const { root, file, target } = await workspace(t);
  await assert.rejects(publishWorkspaceTextFile(target, Buffer.alloc(220001)), /limit/);
  assert.equal(await fs.readFile(file, "utf8"), oldText); await noStage(root);
});
test("valid long target filenames do not inflate the sibling staging filename", async t => {
  const { root, target } = await workspace(t); const name = "a".repeat(246) + ".txt";
  const file = path.join(root, name); await fs.writeFile(file, oldText);
  await publishWorkspaceTextFile({ ...target, absolutePath: file, relativePath: name }, Buffer.from(nextText));
  assert.equal(await fs.readFile(file, "utf8"), nextText); await noStage(root);
});
