import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeWorkspaceTool } from "../src/workspace-tools.js";
import { recordProjectVerificationOutcome, repairModelMessageHistory, sanitizeToolResult, toolResultForModel } from "../src/agent-runner.js";

const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const add = (name, text) => "*** Add File: " + name + "\n" + text.split("\n").map(line => "+" + line).join("\n");
const patch = (...operations) => "*** Begin Patch\n" + operations.join("\n") + "\n*** End Patch";
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-partial-patch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, config: { commandCwd: root, allowFileTools: true, sandboxMode: "host" } };
}
function wrap(t, object, method, decorate) {
  const d = Object.getOwnPropertyDescriptor(object, method);
  Object.defineProperty(object, method, { ...d, value: decorate(d.value) });
  t.after(() => Object.defineProperty(object, method, d));
}
async function failWrite(t, root, text) {
  const handle = await fs.open(root + "/sentinel", "wx"), prototype = Object.getPrototypeOf(handle);
  await handle.close(); await fs.unlink(root + "/sentinel"); let injected = false;
  wrap(t, prototype, "writeFile", original => async function (data, ...args) {
    if (!injected && Buffer.isBuffer(data) && data.equals(Buffer.from(text))) {
      injected = true; throw Object.assign(new Error("Synthetic later-file EIO"), { code: "EIO" });
    }
    return Reflect.apply(original, this, [data, ...args]);
  });
  return () => assert.equal(injected, true);
}
const frame = payload => [{ role: "assistant", content: "", tool_calls: [{ id: "partial", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ patch: "RAW_PATCH_BODY_MUST_NOT_BE_RETAINED" }) } }] },
  { role: "tool", tool_call_id: "partial", content: JSON.stringify(payload) }];
function retained(state) { return state.messages.filter(m => m.role === "user" && m.content.startsWith("Retained runtime tool evidence.")); }

test("later add failure preserves confirmed receipt and leaves later operations unattempted", async t => {
  const { root, config } = await workspace(t), injected = await failWrite(t, root, "two\n");
  const result = await executeWorkspaceTool("apply_patch", { patch: patch(add("one.md", "one\n"), add("two.md", "two\n"), add("three.md", "three\n")) }, config);
  injected(); assert.equal(result.ok, false); assert.equal(result.partial, true);
  assert.deepEqual(result.partialPatch, { schemaVersion: 1, totalOperations: 3, completedOperations: 1, failedOperationIndex: 1, failedOperation: { type: "add", path: "two.md" }, unattemptedOperations: 1 });
  assert.equal(result.changes.length, 1); assert.equal(result.change.afterHash, sha("one\n"));
  assert.equal(await fs.readFile(root + "/one.md", "utf8"), "one\n"); await assert.rejects(fs.stat(root + "/two.md"), { code: "ENOENT" }); await assert.rejects(fs.stat(root + "/three.md"), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(root)).sort(), ["one.md"]); assert.match(result.permissionAdvice.instruction, /Do not replay the entire patch/);
});
test("failure before any effect remains an ordinary thrown failure", async t => {
  const { root, config } = await workspace(t), injected = await failWrite(t, root, "one\n");
  await assert.rejects(executeWorkspaceTool("apply_patch", { patch: patch(add("one.md", "one\n"), add("two.md", "two\n")) }, config), { code: "EIO" });
  injected(); assert.deepEqual(await fs.readdir(root), []);
});
test("preflight failure never claims partial changes or touches earlier files", async t => {
  const { root, config } = await workspace(t); await fs.writeFile(root + "/two.md", "Existing");
  await assert.rejects(executeWorkspaceTool("apply_patch", { patch: patch(add("one.md", "one\n"), add("two.md", "two\n")) }, config), /existing/);
  assert.deepEqual(await fs.readdir(root), ["two.md"]); assert.equal(await fs.readFile(root + "/two.md", "utf8"), "Existing");
});
test("completed deletion is retained when a later write fails", async t => {
  const { root, config } = await workspace(t); await fs.writeFile(root + "/old.md", "Old\n"); const injected = await failWrite(t, root, "two\n");
  const result = await executeWorkspaceTool("apply_patch", { patch: patch("*** Delete File: old.md", add("two.md", "two\n")) }, config);
  injected(); assert.equal(result.ok, false); assert.equal(result.change.deleted, true); assert.equal(result.change.beforeHash, sha("Old\n")); assert.equal(result.change.afterHash, null);
  await assert.rejects(fs.stat(root + "/old.md"), { code: "ENOENT" }); assert.deepEqual(await fs.readdir(root), []);
});
test("a failed move removal records a destination copy, never a completed source removal", async t => {
  const { root, config } = await workspace(t); await fs.writeFile(root + "/source.txt", "Old\n"); let injected = false;
  wrap(t, fs, "unlink", original => async function (name) {
    if (name === root + "/source.txt") { injected = true; throw Object.assign(new Error("source removal refused"), { code: "EACCES" }); }
    return Reflect.apply(original, this, [name]);
  });
  const result = await executeWorkspaceTool("apply_patch", { patch: patch("*** Update File: source.txt\n*** Move to: target.txt\n@@\n-Old\n+New") }, config);
  assert.equal(injected, true); assert.equal(result.ok, false); assert.equal(result.partialPatch.completedOperations, 0);
  assert.equal(result.change.action, "apply_patch_move_destination"); assert.equal(result.change.movePending, true); assert.equal(result.change.sourcePath, "source.txt"); assert.equal(result.change.fromPath, undefined);
  assert.equal(await fs.readFile(root + "/source.txt", "utf8"), "Old\n"); assert.equal(await fs.readFile(root + "/target.txt", "utf8"), "New\n");
});
test("normal move still returns a completed move receipt", async t => {
  const { root, config } = await workspace(t); await fs.writeFile(root + "/source.txt", "Old\n");
  const result = await executeWorkspaceTool("apply_patch", { patch: patch("*** Update File: source.txt\n*** Move to: target.txt\n@@\n-Old\n+New") }, config);
  assert.equal(result.ok, true); assert.equal(result.change.action, "apply_patch_move"); assert.equal(result.change.fromPath, "source.txt"); assert.equal(result.change.movePending, undefined); assert.equal(result.change.sourcePath, undefined);
  await assert.rejects(fs.stat(root + "/source.txt"), { code: "ENOENT" });
});
test("native mutation revision and failed status both survive partial result projection", async t => {
  const { root, config } = await workspace(t), injected = await failWrite(t, root, "two\n");
  const result = await executeWorkspaceTool("apply_patch", { patch: patch(add("one.md", "one\n"), add("two.md", "two\n")) }, config); injected();
  const state = { meta: { goalContract: { revision: 1 }, verifiedCompletionCandidate: { result: "old" } } };
  recordProjectVerificationOutcome(state, result, config);
  assert.equal(state.meta.projectVerification.mutationRevision, 1); assert.deepEqual(state.meta.projectVerification.mutationHistory.at(-1).paths, ["one.md"]); assert.equal(state.meta.verifiedCompletionCandidate, undefined);
  for (const projected of [sanitizeToolResult(result), toolResultForModel(result)]) { assert.equal(projected.ok, false); assert.equal(projected.partial, true); assert.equal(projected.changes[0].afterHash, sha("one\n")); }
});
test("fresh-provider repair retains only bounded confirmed facts with explicit incomplete status", async t => {
  const { root, config } = await workspace(t), injected = await failWrite(t, root, "two\n");
  const result = await executeWorkspaceTool("apply_patch", { patch: patch(add("one.md", "one\n"), add("two.md", "two\n")) }, config); injected();
  result.changes[0].rawOutput = "RAW_OUTPUT_MUST_NOT_BE_RETAINED";
  const state = { messages: [...frame(result), { role: "user", content: "Continue the same task." }] };
  repairModelMessageHistory(state, { provider: "deepseek" }); const messages = retained(state); assert.equal(messages.length, 1);
  assert.match(messages[0].content, /patch is incomplete/); assert.match(messages[0].content, /"ok":false/); assert.match(messages[0].content, new RegExp(sha("one\n")));
  assert.doesNotMatch(JSON.stringify(state.messages), /RAW_PATCH_BODY|RAW_OUTPUT/); const before = JSON.stringify(state.messages);
  assert.match(messages[0].content, /whole-file publications, not stubs/); assert.match(messages[0].content, /Do not restyle completed output/);
  repairModelMessageHistory(state, { provider: "deepseek" }); assert.equal(JSON.stringify(state.messages), before);
});
test("ordinary failed, blocked, skipped and malformed partial results never become retained success", () => {
  for (const result of [{ ok: false }, { ok: false, partial: true, changes: [{}] }, { ok: true, blocked: true }, { ok: true, skipped: true }]) {
    const state = { messages: frame(result) }; repairModelMessageHistory(state, { provider: "deepseek" }); assert.deepEqual(retained(state), []);
  }
});
test("repeated context repair preserves truncation and incomplete status", async t => {
  const { root, config } = await workspace(t), injected = await failWrite(t, root, "last\n");
  const result = await executeWorkspaceTool("apply_patch", { patch: patch(...Array.from({ length: 30 }, (_, i) => add(`note-${i}.md`, "done\n")), add("last.md", "last\n")) }, config); injected();
  const state = { messages: frame(result) }; repairModelMessageHistory(state, { provider: "deepseek" });
  let message = retained(state)[0]; let data = JSON.parse(message.content.split("Verified result: ")[1]);
  assert.equal(data.ok, false); assert.equal(data.partial, true); assert.equal(data.changes.length, 24); assert.equal(data.confirmedChangeCount, 30); assert.equal(data.changesTruncated, true);
  assert.match(message.content, /listed receipts may be truncated/);
  for (let i = 0; i < 3; i++) { repairModelMessageHistory(state, { provider: "deepseek" }); message = retained(state)[0]; data = JSON.parse(message.content.split("Verified result: ")[1]); assert.equal(data.confirmedChangeCount, 30); assert.equal(data.partialPatch.completedOperations, 30); }
});
test("all confirmed changed paths retire older retained reads, while an unchanged read survives", async t => {
  const { root, config } = await workspace(t), injected = await failWrite(t, root, "last\n");
  const result = await executeWorkspaceTool("apply_patch", { patch: patch(...Array.from({ length: 30 }, (_, i) => add(`note-${i}.md`, "done\n")), add("last.md", "last\n")) }, config); injected();
  const reads = ["note-0.md", "note-29.md", "other.md"].flatMap((name, i) => [
    { role: "assistant", content: "", tool_calls: [{ id: "read-" + i, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: name }) } }] },
    { role: "tool", tool_call_id: "read-" + i, content: JSON.stringify({ ok: true, toolName: "read_file", path: name, content: "Old " + name }) },
  ]);
  const state = { messages: [...reads, ...frame(result)] }; repairModelMessageHistory(state, { provider: "deepseek" });
  const text = JSON.stringify(state.messages); assert.doesNotMatch(text, /Old note-0.md|Old note-29.md/); assert.match(text, /Old other.md/);
  assert.ok(retained(state).some(message => JSON.parse(message.content.split("Verified result: ")[1]).partial === true));
  repairModelMessageHistory(state, { provider: "deepseek" });
  assert.doesNotMatch(JSON.stringify(state.messages), /Old other.md/); // A truncated-only view cannot prove the other path was untouched.
});
test("malformed partial progress cannot masquerade as native completed work", () => {
  const base = { ok: false, partial: true, toolName: "apply_patch", partialPatch: { schemaVersion: 1, totalOperations: 2, completedOperations: 1, failedOperationIndex: 1, failedOperation: { type: "add", path: "two.md" }, unattemptedOperations: 0 }, changes: [{ ok: true, action: "apply_patch_add", path: "one.md", beforeHash: null, afterHash: sha("one"), beforeBytes: 0, afterBytes: 3 }] };
  for (const alter of [p => p.partialPatch.completedOperations = 2, p => p.partialPatch.failedOperationIndex = 0, p => p.partialPatch.unattemptedOperations = 1, p => p.partialPatch.failedOperation.type = "shell", p => p.changes[0].afterHash = "bad", p => p.changes[0].beforeBytes = -1]) {
    const payload = structuredClone(base); alter(payload); const state = { messages: frame(payload) }; repairModelMessageHistory(state, { provider: "deepseek" }); assert.deepEqual(retained(state), []);
  }
});
