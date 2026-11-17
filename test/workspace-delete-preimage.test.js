import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { executeWorkspaceTool } from "../src/workspace-tools.js";

const sha = text => createHash("sha256").update(text).digest("hex");
const old = "# Prior generated note\n", correction = "# Concurrent correction\n";
const patch = (...ops) => "*** Begin Patch\n" + ops.join("\n") + "\n*** End Patch";
const update = "*** Update File: status.md\n@@\n-# Current note\n+# Updated current note";
const remove = "*** Delete File: obsolete.md";
const add = "*** Add File: later.md\n+Do not publish after a conflict.";
async function fixture(t, before = old) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-delete-preimage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "status.md"), "# Current note\n");
  await fs.writeFile(path.join(root, "obsolete.md"), before);
  return { root, first: path.join(root, "status.md"), target: path.join(root, "obsolete.md"),
    config: { commandCwd: root, allowFileTools: true, sandboxMode: "host" } };
}
function wrap(t, object, name, decorate) {
  const d = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { ...d, value: decorate(d.value) });
  t.after(() => Object.defineProperty(object, name, d));
}
function afterFirstPublication(t, f, effect) {
  let injected = false;
  wrap(t, fs, "rename", original => async function (...args) {
    const result = await Reflect.apply(original, this, args);
    if (args[1] === f.first && !injected) { injected = true; await effect(); }
    return result;
  });
  return () => assert.equal(injected, true);
}
async function assertConflict(f, result, expected = correction) {
  assert.equal(result.ok, false); assert.equal(result.partial, true);
  assert.deepEqual(result.changes.map(c => c.path), ["status.md"]);
  assert.equal(result.changes[0].deleted, undefined);
  assert.deepEqual(result.partialPatch, { schemaVersion: 1, totalOperations: 3, completedOperations: 1,
    failedOperationIndex: 1, failedOperation: { type: "delete", path: "obsolete.md" }, unattemptedOperations: 1 });
  assert.match(result.error, /changed|conflict/i);
  assert.equal(await fs.readFile(f.first, "utf8"), "# Updated current note\n");
  assert.equal(await fs.readFile(f.target, "utf8"), expected);
  await assert.rejects(fs.stat(path.join(f.root, "later.md")), { code: "ENOENT" });
}

for (const mode of ["in-place", "atomic", "same-size", "empty-source"]) test("later planned deletion refuses a correction: " + mode, async t => {
  const before = mode === "empty-source" ? "" : old;
  const f = await fixture(t, before), next = mode === "same-size" ? old.replace("Prior", "Fresh") : correction;
  const injected = afterFirstPublication(t, f, async () => {
    if (mode === "atomic") { const p = path.join(f.root, "correction.tmp"); await fs.writeFile(p, next); await fs.rename(p, f.target); }
    else await fs.writeFile(f.target, next);
  });
  const result = await executeWorkspaceTool("apply_patch", { patch: patch(update, remove, add) }, f.config);
  injected(); await assertConflict(f, result, next);
});

test("first deletion conflict is thrown before any deletion or other effect", async t => {
  const f = await fixture(t); let reads = 0, injected = false;
  wrap(t, fs, "open", original => async function (name, ...args) {
    const handle = await Reflect.apply(original, this, [name, ...args]);
    if (name === f.target && ++reads === 1) {
      const close = handle.close;
      handle.close = async function (...rest) {
        const result = await Reflect.apply(close, this, rest);
        injected = true; await fs.writeFile(f.target, correction); return result;
      };
    }
    return handle;
  });
  await assert.rejects(executeWorkspaceTool("apply_patch", { patch: patch(remove, add) }, f.config), { code: "WORKSPACE_WRITE_CONFLICT" });
  assert.equal(injected, true); assert.equal(await fs.readFile(f.target, "utf8"), correction);
  assert.equal(await fs.readFile(f.first, "utf8"), "# Current note\n");
  await assert.rejects(fs.stat(path.join(f.root, "later.md")), { code: "ENOENT" });
});

for (const before of [old, ""]) test("unchanged planned deletion retains the exact receipt, empty=" + (before === ""), async t => {
  const f = await fixture(t, before);
  const result = await executeWorkspaceTool("apply_patch", { patch: patch(remove) }, f.config);
  assert.equal(result.ok, true); assert.equal(result.change.deleted, true);
  assert.equal(result.change.beforeHash, sha(before)); assert.equal(result.change.afterHash, null);
  assert.equal(result.change.beforeBytes, Buffer.byteLength(before));
  await assert.rejects(fs.stat(f.target), { code: "ENOENT" });
});

test("an unrelated correction does not block the intended unchanged deletion", async t => {
  const f = await fixture(t), other = path.join(f.root, "owner.md"); await fs.writeFile(other, old);
  const injected = afterFirstPublication(t, f, () => fs.writeFile(other, correction));
  const result = await executeWorkspaceTool("apply_patch", { patch: patch(update, remove) }, f.config);
  injected(); assert.equal(result.ok, true); assert.equal(result.changes[1].deleted, true);
  assert.equal(result.changes[1].beforeHash, sha(old)); assert.equal(await fs.readFile(other, "utf8"), correction);
});

test("a new explicit patch can plan against the current corrected preimage", async t => {
  const f = await fixture(t), injected = afterFirstPublication(t, f, () => fs.writeFile(f.target, correction));
  const failed = await executeWorkspaceTool("apply_patch", { patch: patch(update, remove, add) }, f.config);
  injected(); await assertConflict(f, failed);
  const fresh = await executeWorkspaceTool("apply_patch", { patch: patch(remove) }, f.config);
  assert.equal(fresh.ok, true); assert.equal(fresh.change.beforeHash, sha(correction));
  await assert.rejects(fs.stat(f.target), { code: "ENOENT" });
});
