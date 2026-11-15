import assert from "node:assert/strict";
import fs from "node:fs/promises";
import sync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { createWorkspaceReadBoundary, createWorkspaceReadBoundarySync, readWorkspaceFileSnapshot,
  readWorkspaceFileSnapshotSync, isWorkspaceReadScopeDenial } from "../src/workspace-read-boundary.js";
import { resolveWorkspaceReadTargetSync } from "../src/workspace-tools.js";

const text = "Authorized source: 状態😀\r\n";
async function fixture(t, content = text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-sync-read-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  const workspace = root + "/workspace", outside = root + "/outside", file = workspace + "/source.txt";
  await fs.mkdir(workspace); await fs.mkdir(outside); await fs.writeFile(file, content);
  return { root, workspace, outside, file };
}
for (const [name, make, read] of [
  ["async", createWorkspaceReadBoundary, readWorkspaceFileSnapshot],
  ["sync", createWorkspaceReadBoundarySync, readWorkspaceFileSnapshotSync],
]) {
  for (const value of [text, "\ufeffBOM stays present\n", "", "real replacement character: \ufffd\n"]) test(`${name} complete text snapshot preserves ${JSON.stringify(value)}`, async t => {
    const f = await fixture(t, value), b = await make({ root: f.workspace });
    const r = await read(f.file, b, { maxBytes: 100, text: true });
    assert.equal(r.content, value); assert.deepEqual(r.buffer, Buffer.from(value)); assert.equal(r.stat.size, Buffer.byteLength(value));
  });
  for (const alias of ["file", "directory", "root"]) test(`${name} preserves an authorized ${alias} alias`, async t => {
    const f = await fixture(t); let root = f.workspace, file = f.file;
    if (alias === "file") { file = f.workspace + "/alias.txt"; await fs.symlink("source.txt", file); }
    if (alias === "directory") { await fs.mkdir(f.workspace + "/actual"); await fs.rename(f.file, f.workspace + "/actual/source.txt"); await fs.symlink("actual", f.workspace + "/alias"); file = f.workspace + "/alias/source.txt"; }
    if (alias === "root") { await fs.symlink(f.workspace, f.root + "/selected"); root = f.root + "/selected"; file = root + "/source.txt"; }
    assert.equal((await read(file, await make({ root }), { maxBytes: 100, text: true })).content, text);
  });
  for (const target of ["outside", ".env", ".git/config", "credentials.json"]) test(`${name} rejects an alias into ${target}`, async t => {
    const f = await fixture(t), file = target === "outside" ? f.outside + "/record.txt" : f.workspace + "/" + target;
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
    await fs.symlink(file, f.workspace + "/alias.txt"); const b = await make({ root: f.workspace });
    await assert.rejects(async () => read(f.workspace + "/alias.txt", b, { maxBytes: 100 }), e => e.code === "WORKSPACE_READ_SCOPE" && isWorkspaceReadScopeDenial(e));
  });
  test(`${name} selected external file does not admit its sibling`, async t => {
    const f = await fixture(t); await fs.writeFile(f.outside + "/selected.txt", text); await fs.writeFile(f.outside + "/sibling.txt", text);
    const b = await make({ root: f.workspace, readOnlyRoots: [f.outside + "/selected.txt"] });
    assert.equal((await read(f.outside + "/selected.txt", b, { maxBytes: 100, text: true })).content, text);
    await assert.rejects(async () => read(f.outside + "/sibling.txt", b, { maxBytes: 100 }), { code: "WORKSPACE_READ_SCOPE" });
  });
  test(`${name} empty or missing optional roots add no ambient authority`, async t => {
    const f = await fixture(t); await fs.writeFile(f.outside + "/record.txt", text);
    const b = await make({ root: f.workspace, readOnlyRoots: ["", null, f.root + "/missing"] });
    assert.equal((await read(f.file, b, { maxBytes: 100, text: true })).content, text);
    await assert.rejects(async () => read(f.outside + "/record.txt", b, { maxBytes: 100 }), { code: "WORKSPACE_READ_SCOPE" });
  });
  test(`${name} explicit root name is separate from protected descendants`, async t => {
    const f = await fixture(t), root = f.root + "/secrets"; await fs.rename(f.workspace, root);
    assert.equal((await read(root + "/source.txt", await make({ root }), { maxBytes: 100, text: true })).content, text);
  });
  test(`${name} active scope cannot expand through an optional root or alias`, async t => {
    const f = await fixture(t); await fs.mkdir(f.workspace + "/scope"); await fs.symlink("../source.txt", f.workspace + "/scope/alias.txt");
    const b = await make({ root: f.workspace, scopeRoots: [f.workspace + "/scope"], readOnlyRoots: [f.outside], allowOutside: true });
    await assert.rejects(async () => read(f.workspace + "/scope/alias.txt", b, { maxBytes: 100 }), { code: "WORKSPACE_READ_SCOPE" });
  });
  test(`${name} write-access reads never follow even an internal source alias`, async t => {
    const f = await fixture(t); await fs.symlink("source.txt", f.workspace + "/alias.txt");
    await assert.rejects(async () => read(f.workspace + "/alias.txt", await make({ root: f.workspace, writeAccess: true }), { maxBytes: 100 }), { code: "WORKSPACE_READ_SCOPE" });
  });
  for (const bytes of [Buffer.from([0xff]), Buffer.from("text\0binary")]) test(`${name} strict text rejects ${bytes.toString("hex")}`, async t => {
    const f = await fixture(t, bytes), b = await make({ root: f.workspace });
    await assert.rejects(async () => read(f.file, b, { maxBytes: 100, text: true }), /UTF-8|Binary/);
  });
  for (const size of [16, 17]) test(`${name} exact byte limit: ${size}`, async t => {
    const f = await fixture(t, "a".repeat(size)), b = await make({ root: f.workspace });
    if (size === 16) assert.equal((await read(f.file, b, { maxBytes: 16, text: true })).content.length, 16);
    else await assert.rejects(async () => read(f.file, b, { maxBytes: 16 }), { code: "WORKSPACE_READ_TOO_LARGE" });
  });
  test(`${name} limits reject coercion and unbounded values`, async t => {
    const f = await fixture(t), b = await make({ root: f.workspace });
    for (const maxBytes of [-1, 0.5, Infinity, "16", 64 * 1024 * 1024 + 1]) await assert.rejects(async () => read(f.file, b, { maxBytes }), /Invalid bounded/);
  });
}

for (const fault of ["growth", "truncate", "replace", "mode", "read-error"]) test(`sync live ${fault} discards the snapshot and closes exactly once`, async t => {
  const f = await fixture(t), b = createWorkspaceReadBoundarySync({ root: f.workspace }), open = sync.openSync, read = sync.readSync, close = sync.closeSync;
  let fd, injected = false, closed = 0, consumed = 0;
  t.mock.method(sync, "openSync", (...args) => { const result = Reflect.apply(open, sync, args); if (args[0] === f.file) fd = result; return result; });
  t.mock.method(sync, "readSync", (...args) => {
    const count = Reflect.apply(read, sync, args); if (args[0] === fd) { consumed += count;
      if (!injected) { injected = true;
        if (fault === "growth") sync.appendFileSync(f.file, "x".repeat(10000));
        else if (fault === "truncate") sync.truncateSync(f.file, 0);
        else if (fault === "replace") { sync.renameSync(f.file, f.file + ".old"); sync.writeFileSync(f.file, "replacement\n"); }
        else if (fault === "mode") sync.chmodSync(f.file, (sync.statSync(f.file).mode & 0o777) ^ 0o100);
        else throw Object.assign(Error("synthetic read failure"), { code: "EIO" });
      }
    } return count;
  });
  t.mock.method(sync, "closeSync", candidate => { if (candidate === fd) closed++; return Reflect.apply(close, sync, [candidate]); });
  try { assert.throws(() => readWorkspaceFileSnapshotSync(f.file, b, { maxBytes: 100, text: true })); assert.equal(closed, 1); assert.ok(consumed <= Buffer.byteLength(text) + 1); }
  finally { t.mock.restoreAll(); }
});
test("sync close failure is surfaced without a second close attempt", async t => {
  const f = await fixture(t), b = createWorkspaceReadBoundarySync({ root: f.workspace }), close = sync.closeSync; let count = 0;
  t.mock.method(sync, "closeSync", fd => { count++; Reflect.apply(close, sync, [fd]); throw Object.assign(Error("synthetic close error"), { code: "EIO" }); });
  try { assert.throws(() => readWorkspaceFileSnapshotSync(f.file, b, { maxBytes: 100 }), { code: "EIO" }); assert.equal(count, 1); }
  finally { t.mock.restoreAll(); }
});
test("sync target revalidation rejects a retargeted internal alias", async t => {
  const f = await fixture(t); await fs.writeFile(f.workspace + "/other.txt", "other\n"); await fs.symlink("source.txt", f.workspace + "/alias.txt");
  const target = resolveWorkspaceReadTargetSync({ commandCwd: f.workspace }, "alias.txt");
  await fs.unlink(f.workspace + "/alias.txt"); await fs.symlink("other.txt", f.workspace + "/alias.txt");
  assert.throws(() => target.readBytes(100), { code: "WORKSPACE_READ_CHANGED" });
});
test("sync root replacement is detected before an admitted read", async t => {
  const f = await fixture(t), target = resolveWorkspaceReadTargetSync({ commandCwd: f.workspace }, "source.txt");
  await fs.rename(f.workspace, f.root + "/old"); await fs.mkdir(f.workspace); await fs.writeFile(f.file, text);
  assert.throws(() => target.readBytes(100), { code: "WORKSPACE_READ_CHANGED" });
});
test("sync an unused optional root replacement does not poison a workspace read", async t => {
  const f = await fixture(t), b = createWorkspaceReadBoundarySync({ root: f.workspace, readOnlyRoots: [f.outside] });
  await fs.rename(f.outside, f.root + "/old-outside"); await fs.mkdir(f.outside);
  assert.equal(readWorkspaceFileSnapshotSync(f.file, b, { maxBytes: 100, text: true }).content, text);
});
test("sync real FIFO read rejects and closes without waiting for a writer", { timeout: 12000 }, async t => {
  if (process.platform === "win32") return t.skip("POSIX FIFO only");
  const f = await fixture(t); await fs.unlink(f.file); assert.equal(spawnSync("mkfifo", [f.file], { timeout: 2000 }).status, 0);
  const code = 'import {createWorkspaceReadBoundarySync as make,readWorkspaceFileSnapshotSync as read} from ' + JSON.stringify(new URL("../src/workspace-read-boundary.js", import.meta.url).href) +
    ';try{read(process.argv[1]+"/source.txt",make({root:process.argv[1]}),{maxBytes:100});process.exitCode=2;}catch(e){if(!/regular file/.test(e.message))throw e;console.log("FIFO_REJECTED");}';
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.workspace], { env: { PATH: process.env.PATH, HOME: f.root }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = "", timedOut = false; child.stdout.on("data", b => output += b); child.stderr.on("data", b => error += b);
  const exit = await new Promise((resolve, reject) => { const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5000);
    child.once("error", e => { clearTimeout(timer); reject(e); }); child.once("close", c => { clearTimeout(timer); resolve(c); }); });
  assert.equal(timedOut, false); assert.equal(exit, 0, error); assert.match(output, /FIFO_REJECTED/);
});
