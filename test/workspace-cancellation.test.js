import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getEventListeners } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishWorkspaceTextFile } from "../src/workspace-file-publication.js";
import { executeWorkspaceTool } from "../src/workspace-tools.js";

const old = "# Example\nState: drafft\n", fixed = old.replace("drafft", "draft");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const cancelled = error => error.name === "AbortError" && error.code === "ABORT_ERR";
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Test gate timed out")), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate) {
  const start = Date.now();
  while (!predicate()) { assert.ok(Date.now() - start < 2000, "Admission not observed"); await new Promise(resolve => setImmediate(resolve)); }
}
function replace(t, object, name, wrap) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { ...descriptor, value: wrap(descriptor.value) });
  t.after(() => Object.defineProperty(object, name, descriptor));
}
async function fixture(t, existing = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-workspace-cancellation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "note.md"), target = { root, absolutePath: file, relativePath: "note.md" };
  if (existing) await fs.writeFile(file, old);
  const sentinel = await fs.open(path.join(root, "sentinel"), "wx"), prototype = Object.getPrototypeOf(sentinel);
  await sentinel.close(); await fs.unlink(path.join(root, "sentinel"));
  const controller = new AbortController(), config = { commandCwd: root, sandboxMode: "host", allowFileTools: true, abortSignal: controller.signal };
  return { root, file, target, prototype, controller, config };
}
async function noStage(root) { assert.deepEqual((await fs.readdir(root)).filter(n => n.startsWith(".aginti-write-")), []); }
const stageHandles = new WeakMap();
function trackStages(t, root) {
  replace(t, fs, "open", original => async function (name, ...args) {
    const handle = await Reflect.apply(original, this, [name, ...args]);
    if (path.dirname(String(name)) === root && path.basename(String(name)).startsWith(".aginti-write-")) stageHandles.set(handle, root);
    return handle;
  });
}
const isStage = (handle, root) => stageHandles.get(handle) === root;

for (const tool of ["write_file", "apply_patch", "read_file", "list_files", "search_files", "inspect_project"]) {
  test("pre-cancelled " + tool + " performs no filesystem operation", async t => {
    const f = await fixture(t); f.controller.abort(); let calls = 0;
    const originals = [];
    try {
      for (const name of ["open", "stat", "lstat", "readFile", "readdir", "mkdir", "rename", "link", "unlink", "realpath"]) {
        const descriptor = Object.getOwnPropertyDescriptor(fs, name); originals.push([name, descriptor]);
        Object.defineProperty(fs, name, { ...descriptor, value() { calls++; throw new Error("Cancelled call reached filesystem"); } });
      }
      await assert.rejects(executeWorkspaceTool(tool, { path: "note.md", content: fixed, query: "draft" }, f.config), cancelled);
      assert.equal(calls, 0);
    } finally { for (const [name, descriptor] of originals) Object.defineProperty(fs, name, descriptor); }
    assert.equal(await fs.readFile(f.file, "utf8"), old); await noStage(f.root);
  });
}

for (const existing of [true, false]) for (const point of ["sync", "close", "last-stat"]) {
  test(`cancel during ${point} never publishes ${existing ? "replacement" : "creation"}`, async t => {
    const f = await fixture(t, existing); let fired = false;
    if (point === "last-stat") {
      let calls = 0;
      replace(t, fs, "lstat", original => async function (name, ...args) {
        const result = await Reflect.apply(original, this, [name, ...args]);
        if (path.dirname(String(name)) === f.root && path.basename(String(name)).startsWith(".aginti-write-") && ++calls === 2) { fired = true; f.controller.abort(); }
        return result;
      });
    } else if (point === "close") {
      replace(t, fs, "open", original => async function (name, ...args) {
        const handle = await Reflect.apply(original, this, [name, ...args]);
        if (path.dirname(String(name)) === f.root && path.basename(String(name)).startsWith(".aginti-write-")) {
          const close = handle.close;
          handle.close = async function (...closeArgs) {
            const result = await Reflect.apply(close, this, closeArgs);
            if (!fired) { fired = true; f.controller.abort(); }
            return result;
          };
        }
        return handle;
      });
    } else {
      trackStages(t, f.root);
      replace(t, f.prototype, point, original => async function (...args) {
        const stage = await isStage(this, f.root);
        const result = await Reflect.apply(original, this, args);
        if (stage && !fired) { fired = true; f.controller.abort(); }
        return result;
      });
    }
    await assert.rejects(publishWorkspaceTextFile(f.target, Buffer.from(fixed), { createOnly: !existing, signal: f.controller.signal }), cancelled);
    assert.equal(fired, true);
    if (existing) assert.equal(await fs.readFile(f.file, "utf8"), old);
    else await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
    await noStage(f.root); assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  });
}

for (const method of ["rename", "link"]) test("already admitted " + method + " keeps its committed receipt", async t => {
  const f = await fixture(t, method === "rename");
  replace(t, fs, method, original => async function (from, to) {
    const result = await Reflect.apply(original, this, [from, to]);
    if (to === f.file) f.controller.abort();
    return result;
  });
  const receipt = await publishWorkspaceTextFile(f.target, Buffer.from(fixed), { signal: f.controller.signal });
  assert.equal(f.controller.signal.aborted, true); assert.equal(await fs.readFile(f.file, "utf8"), fixed);
  assert.equal(receipt.publication.method, method === "rename" ? "rename" : "exclusive-link");
  assert.equal(receipt.beforeBytes.toString(), method === "rename" ? old : ""); await noStage(f.root);
});

for (const firstFails of [false, true]) test("cancelled queue slot never releases a successor early; predecessor failure=" + firstFails, { timeout: 8000 }, async t => {
  const f = await fixture(t), entered = gate(), proceed = gate(); let stageWrites = 0, blocked = false;
  trackStages(t, f.root);
  replace(t, f.prototype, "sync", original => async function (...args) {
    const result = await Reflect.apply(original, this, args);
    if (!blocked && await isStage(this, f.root)) {
      blocked = true; entered.resolve(); await proceed.promise;
      if (firstFails) throw Object.assign(new Error("Synthetic staging EIO"), { code: "EIO" });
    }
    return result;
  });
  replace(t, f.prototype, "writeFile", original => async function (...args) {
    if (await isStage(this, f.root)) stageWrites++;
    return Reflect.apply(original, this, args);
  });
  const queued = new AbortController(), third = new AbortController();
  const first = publishWorkspaceTextFile(f.target, Buffer.from("first\n")); first.catch(() => {});
  let second, last;
  try {
    await bounded(entered.promise);
    second = publishWorkspaceTextFile(f.target, Buffer.from("cancelled writer\n"), { signal: queued.signal }); second.catch(() => {});
    await until(() => getEventListeners(queued.signal, "abort").length === 1);
    last = publishWorkspaceTextFile(f.target, Buffer.from("third\n"), { signal: third.signal }); last.catch(() => {});
    await until(() => getEventListeners(third.signal, "abort").length === 1);
    queued.abort(); await bounded(assert.rejects(second, cancelled));
    assert.equal(stageWrites, 1); assert.equal(await fs.readFile(f.file, "utf8"), old);
    assert.equal(getEventListeners(queued.signal, "abort").length, 0);
  } finally { proceed.resolve(); }
  if (firstFails) await assert.rejects(first, { code: "EIO" }); else await first;
  const receipt = await bounded(last); assert.equal(receipt.beforeBytes.toString(), firstFails ? old : "first\n");
  assert.equal(await fs.readFile(f.file, "utf8"), "third\n"); assert.equal(stageWrites, 2);
  assert.equal(getEventListeners(third.signal, "abort").length, 0); await noStage(f.root);
  await publishWorkspaceTextFile(f.target, Buffer.from(fixed), { expectedBeforeHash: sha("third\n") });
  assert.equal(await fs.readFile(f.file, "utf8"), fixed);
});

for (const first of ["update", "add", "delete"]) test("cancel after a committed " + first + " preserves only that receipt and stops next operation", async t => {
  const f = await fixture(t, first !== "add"); let fired = false;
  const method = first === "delete" ? "unlink" : first === "add" ? "link" : "rename";
  replace(t, fs, method, original => async function (...args) {
    const result = await Reflect.apply(original, this, args), name = args[method === "unlink" ? 0 : 1];
    if (name === f.file && !fired) { fired = true; f.controller.abort(); }
    return result;
  });
  const operation = first === "update" ? "*** Update File: note.md\n@@\n-State: drafft\n+State: draft\n"
    : first === "delete" ? "*** Delete File: note.md\n" : "*** Add File: note.md\n+Created note\n";
  const patch = "*** Begin Patch\n" + operation + "*** Add File: later/deep/checklist.md\n+Not yet\n*** End Patch";
  const result = await executeWorkspaceTool("apply_patch", { patch }, f.config);
  assert.equal(fired, true); assert.equal(result.ok, false); assert.equal(result.partial, true);
  assert.equal(result.changes.length, 1); assert.equal(result.changes[0].path, "note.md");
  assert.equal(result.partialPatch.completedOperations, 1); assert.equal(result.partialPatch.failedOperationIndex, 1);
  await assert.rejects(fs.stat(path.join(f.root, "later")), { code: "ENOENT" });
  if (first === "delete") { assert.equal(result.changes[0].deleted, true); await assert.rejects(fs.stat(f.file), { code: "ENOENT" }); }
  else assert.equal(await fs.readFile(f.file, "utf8"), first === "update" ? fixed : "Created note");
  await noStage(f.root);
});

test("move destination committed at cancellation remains an exact pending copy; source is not removed", async t => {
  const f = await fixture(t), destination = path.join(f.root, "renamed.md");
  replace(t, fs, "link", original => async function (from, to) {
    const result = await Reflect.apply(original, this, [from, to]); if (to === destination) f.controller.abort(); return result;
  });
  const result = await executeWorkspaceTool("apply_patch", { patch: "*** Begin Patch\n*** Update File: note.md\n*** Move to: renamed.md\n*** End Patch" }, f.config);
  assert.equal(result.ok, false); assert.equal(result.partial, true); assert.equal(result.changes.length, 1);
  assert.equal(result.change.movePending, true); assert.equal(result.change.sourcePath, "note.md"); assert.equal(result.change.fromPath, undefined);
  assert.equal(await fs.readFile(f.file, "utf8"), old); assert.equal(await fs.readFile(destination, "utf8"), old); await noStage(f.root);
});

test("cancellation during a delete's final read preserves the source", async t => {
  const f = await fixture(t); let reads = 0;
  replace(t, fs, "open", original => async function (name, ...args) {
    const handle = await Reflect.apply(original, this, [name, ...args]);
    if (name === f.file) {
      const close = handle.close;
      handle.close = async function (...closeArgs) {
        const result = await Reflect.apply(close, this, closeArgs);
        if (++reads === 2) f.controller.abort(); return result;
      };
    }
    return handle;
  });
  await assert.rejects(executeWorkspaceTool("apply_patch", { patch: "*** Begin Patch\n*** Delete File: note.md\n*** End Patch" }, f.config), cancelled);
  assert.equal(f.controller.signal.aborted, true); assert.equal(await fs.readFile(f.file, "utf8"), old); await noStage(f.root);
});

test("frozen DOMException reason is neither mutated nor echoed", async t => {
  const f = await fixture(t), reason = Object.freeze(new DOMException("private caller reason", "AbortError")); f.controller.abort(reason);
  await assert.rejects(publishWorkspaceTextFile(f.target, Buffer.from(fixed), { signal: f.controller.signal }), error => {
    assert.ok(cancelled(error)); assert.notEqual(error, reason); assert.equal(error.message.includes(reason.message), false); return true;
  });
  assert.equal(reason.name, "AbortError"); assert.equal(await fs.readFile(f.file, "utf8"), old); await noStage(f.root);
});
