import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
const runtime = process.env.AGINTI_TEST_MOVE_RUNTIME || new URL("../", import.meta.url).pathname;
const { buildScsEvidenceLedger, evaluateScsEvidence, deriveScsTaskContract, evaluateScsSemanticContract } = await import(pathToFileURL(path.join(runtime, "src/scs-evidence.js")));
const { executeWorkspaceTool } = await import(pathToFileURL(path.join(runtime, "src/workspace-tools.js")));
const content = "# Private note\nKeep this text unchanged.\n";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-patch-artifact-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "note.md"), content, { mode: 0o600 });
  const payload = await executeWorkspaceTool("apply_patch", { patch: "*** Begin Patch\n*** Update File: note.md\n*** Move to: archive/note.md\n*** End Patch" }, { commandCwd: root, allowFileTools: true, sandboxMode: "host" });
  payload.path = ""; payload.goalRevision = 1;
  const contract = deriveScsTaskContract({ goal: "Please put both notes under archive/ and leave other files alone.", taskProfile: "code" });
  return { root, payload, contract };
}
const ledger = (f, payload = f.payload, mirror = false) => buildScsEvidenceLedger({ state: { commandCwd: f.root, messages: mirror ? [{ role: "tool", content: JSON.stringify(payload) }] : [] },
  contract: f.contract, context: { commandCwd: f.root, events: mirror ? [] : [{ type: "tool.completed", data: payload }] } });
test("successful multi-file native receipts supply real current artifact evidence", async t => {
  const f = await fixture(t), result = ledger(f);
  assert.equal(evaluateScsEvidence(f.contract, result).ok, true);
  assert.ok(result.items.some(item => item.category === "artifact" && item.target === "archive/note.md" && item.verified));
});
test("strict durable tool-message replay revalidates the same destination receipt", async t => {
  const f = await fixture(t); assert.equal(evaluateScsEvidence(f.contract, ledger(f, f.payload, true)).ok, true);
});
for (const change of ["bytes", "mode", "missing", "symlink"]) test(`destination ${change} drift invalidates the native artifact receipt`, async t => {
  const f = await fixture(t), destination = path.join(f.root, "archive/note.md");
  if (change === "bytes") await fs.writeFile(destination, content.replace("Private", "Changed"));
  if (change === "mode") await fs.chmod(destination, 0o644);
  if (change === "missing") await fs.unlink(destination);
  if (change === "symlink") { await fs.rename(destination, destination + ".owned"); await fs.symlink(destination + ".owned", destination); }
  assert.equal(evaluateScsEvidence(f.contract, ledger(f)).ok, false);
});
for (const type of ["pending", "deleted", "failed", "hash", "bytes", "escape", "source-escape", "metadata-extra", "publication-proxy", "metadata-accessor"]) {
  test(`unproven ${type} change cannot supply artifact completion`, async t => {
    const f = await fixture(t), c = f.payload.changes[0]; let traps = 0;
    if (type === "pending") c.movePending = true;
    if (type === "deleted") { c.deleted = true; c.action = "apply_patch_delete"; }
    if (type === "failed") f.payload.ok = false;
    if (type === "hash") c.afterHash = "0".repeat(64);
    if (type === "bytes") c.afterBytes++;
    if (type === "escape") c.path = "../outside.md";
    if (type === "source-escape") c.fromPath = "../outside.md";
    if (type === "metadata-extra") c.publication.sourceMetadata = { ...c.publication.sourceMetadata, extra: true };
    if (type === "publication-proxy") c.publication = new Proxy(c.publication, { get() { traps++; throw new Error("untrusted publication trap"); }, getPrototypeOf() { traps++; throw new Error("prototype trap"); } });
    if (type === "metadata-accessor") c.publication.sourceMetadata = Object.defineProperty({}, "mode", { enumerable: true, get() { traps++; throw new Error("metadata trap"); } });
    assert.equal(evaluateScsEvidence(f.contract, ledger(f)).ok, false); assert.equal(traps, 0);
  });
}
test("output hashes are the real byte hashes rather than model summary text", async t => {
  const f = await fixture(t); f.payload.summary = "Everything is private and verified.";
  const record = ledger(f).items.find(item => item.nativeFileChange);
  assert.ok(record?.nativeFileChange);
  assert.equal(record.nativeFileChange.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  assert.equal(record.nativeFileChange.metadata.mode, 0o600);
});
for (const type of ["sparse", "accessor", "iterator", "proxy", "duplicate", "late-malformed"]) test(`whole native change batch rejects ${type} without hooks or partial evidence`, async t => {
  const f = await fixture(t), changes = f.payload.changes; let traps = 0;
  if (type === "sparse") changes.length = 2;
  if (type === "accessor") Object.defineProperty(changes, "1", { enumerable: true, get() { traps++; throw new Error("array getter"); } });
  if (type === "iterator") Object.defineProperty(changes, Symbol.iterator, { value() { traps++; throw new Error("array iterator"); } });
  if (type === "proxy") f.payload.changes = new Proxy(changes, { get() { traps++; throw new Error("array proxy"); } });
  if (type === "duplicate") changes.push({ ...changes[0] });
  if (type === "late-malformed") changes.push({ ok: true, action: "unexpected", path: "other.md" });
  assert.equal(evaluateScsEvidence(f.contract, ledger(f)).ok, false); assert.equal(traps, 0);
});
test("a real mixed delete/add patch counts its published output without turning deletion into an artifact", async t => {
  const f = await fixture(t);
  const payload = await executeWorkspaceTool("apply_patch", { patch: "*** Begin Patch\n*** Delete File: archive/note.md\n*** Add File: final.md\n+# Final owned note\n*** End Patch" }, { commandCwd: f.root, allowFileTools: true, sandboxMode: "host" });
  assert.equal(payload.ok, true); const result = ledger(f, payload);
  assert.equal(evaluateScsEvidence(f.contract, result).ok, true);
  assert.deepEqual(result.items.filter(item => item.nativeFileChange).map(item => item.target), ["final.md"]);
});
test("a malformed deletion digest is not coerced while validating the entire batch", async t => {
  const f = await fixture(t); let traps = 0;
  f.payload.changes.push({ ok: true, action: "apply_patch_delete", path: "old.md", deleted: true, afterHash: null, afterBytes: 0,
    beforeHash: { toString() { traps++; throw new Error("digest coercion"); } } });
  assert.equal(evaluateScsEvidence(f.contract, ledger(f)).ok, false); assert.equal(traps, 0);
});
test("a fabricated byte hash cannot turn invalid UTF-8 into a native text publication", async t => {
  const f = await fixture(t), bytes = Buffer.from([0xff, 0xfe]);
  await fs.writeFile(path.join(f.root, "archive/note.md"), bytes);
  f.payload.changes[0].afterHash = crypto.createHash("sha256").update(bytes).digest("hex");
  f.payload.changes[0].afterBytes = bytes.length;
  assert.equal(evaluateScsEvidence(f.contract, ledger(f)).ok, false);
});
test("durable output never erases required source reads or their native repair diagnostics", async t => {
  const f = await fixture(t), contract = deriveScsTaskContract({ goal: "Read context.txt and constraints.txt, then produce archive/note.md." });
  const result = evaluateScsSemanticContract(contract, { commandCwd: f.root, events: [{ type: "tool.completed", data: f.payload }], state: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingSourceReads, ["context.txt", "constraints.txt"]);
  assert.deepEqual(result.inputReads.missingInputReads, result.missingSourceReads);
  const partial = evaluateScsSemanticContract(contract, { commandCwd: f.root, state: {}, events: [
    { type: "tool.completed", data: f.payload },
    { type: "tool.completed", data: { ok: true, toolName: "read_file", path: "context.txt", content: "Authorized context",
      sha256: crypto.createHash("sha256").update("Authorized context").digest("hex"), bytes: Buffer.byteLength("Authorized context") } },
  ] });
  assert.equal(partial.ok, false); assert.deepEqual(partial.missingSourceReads, ["constraints.txt"]);
});
