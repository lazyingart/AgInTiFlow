import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const source = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { executeWorkspaceTool } = await import(pathToFileURL(path.join(source, "src/workspace-tools.js")));
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const oldBlock = "Status: draft\nReview: pending", newBlock = "Status: ready\nReview: requested";
const patch = format => format === "codex"
  ? `*** Begin Patch\n*** Update File: handoff.md\n@@\n-Status: draft\n-Review: pending\n+Status: ready\n+Review: requested\n*** End Patch`
  : `--- a/handoff.md\n+++ b/handoff.md\n@@ -2,2 +2,2 @@\n-Status: draft\n-Review: pending\n+Status: ready\n+Review: requested`;
async function workspace(t, original) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-patch-eol-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true });await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  const file = path.join(root, "handoff.md");await fs.writeFile(file, original, { mode: 0o600 });
  return { root, file, config: { commandCwd: root, sandboxMode: "host", allowFileTools: true } };
}
for (const ending of ["\n", "\r\n"]) for (const bom of ["", "\uFEFF"]) for (const format of ["codex", "unified", "exact"]) {
  test(`${format} multiline edit preserves ${JSON.stringify(ending)} and BOM=${Boolean(bom)}`, async t => {
    const original = bom + ["# Handoff", "Status: draft", "Review: pending", "Keep: 日本語 🌱", ""].join(ending);
    const { root, file, config } = await workspace(t, original);
    const read = await executeWorkspaceTool("read_file", { path: "handoff.md" }, config);
    assert.ok(read.content.includes(oldBlock), "Use exactly the tool's displayed text");
    const args = format === "exact" ? { path: "handoff.md", search: oldBlock, replace: newBlock, expectedReplacements: 1, baseHash: read.sha256 } : { patch: patch(format) };
    const result = await executeWorkspaceTool("apply_patch", args, config);
    const expected = original.replace(oldBlock.replaceAll("\n", ending), newBlock.replaceAll("\n", ending));
    assert.equal(result.ok, true);assert.equal(await fs.readFile(file, "utf8"), expected);
    const change = result.change || result.changes[0];
    assert.equal(change.beforeHash, sha(original));assert.equal(change.afterHash, sha(expected));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual((await fs.readdir(root)).filter(name => name.includes(".aginti-")), []);
  });
}
for (const inputEnding of ["\n", "\r\n"]) test(`replacement adds CRLF lines once from ${JSON.stringify(inputEnding)}`, async t => {
  const original = "One\r\nTwo\r\nThree";
  const { file, config } = await workspace(t, original);
  await executeWorkspaceTool("apply_patch", { path: "handoff.md", search: "Two", replace: ["Two", "Extra"].join(inputEnding), expectedReplacements: 1 }, config);
  assert.equal(await fs.readFile(file, "utf8"), "One\r\nTwo\r\nExtra\r\nThree");
});
test("exact CRLF arguments remain accepted without double carriage returns", async t => {
  const { file, config } = await workspace(t, "A\r\nB\r\nC\r\n");
  await executeWorkspaceTool("apply_patch", { path: "handoff.md", search: "A\r\nB", replace: "A\r\nD" }, config);
  assert.equal(await fs.readFile(file, "utf8"), "A\r\nD\r\nC\r\n");
});
for (const kind of ["duplicate", "stale-hash", "whitespace", "case", "mixed", "bare-cr"]) test(`no fuzzy or stale replacement: ${kind}`, async t => {
  let original = "Status: draft\r\nReview: pending\r\nKeep\r\n";
  if (kind === "duplicate") original += original;
  if (kind === "mixed") original += "LF only\n";
  if (kind === "bare-cr") original += "Bare\rCR";
  const { file, config } = await workspace(t, original);
  const args = { path: "handoff.md", search: oldBlock, replace: newBlock, expectedReplacements: 1 };
  if (kind === "stale-hash") args.baseHash = "0".repeat(64);
  if (kind === "whitespace") args.search = oldBlock.replace("draft", "draft ");
  if (kind === "case") args.search = oldBlock.toLowerCase();
  await assert.rejects(executeWorkspaceTool("apply_patch", args, config));
  assert.equal(await fs.readFile(file, "utf8"), original);
});
test("mixed source still permits exact byte matching without global normalization", async t => {
  const original = "A\r\nB\nC\r\n";const { file, config } = await workspace(t, original);
  await executeWorkspaceTool("apply_patch", { path: "handoff.md", search: "B\nC", replace: "D\nC", expectedReplacements: 1 }, config);
  assert.equal(await fs.readFile(file, "utf8"), "A\r\nD\nC\r\n");
});
test("source with no newline keeps ordinary replacement semantics", async t => {
  const { file, config } = await workspace(t, "Alpha");
  await executeWorkspaceTool("apply_patch", { path: "handoff.md", search: "Alpha", replace: "Beta\nGamma" }, config);
  assert.equal(await fs.readFile(file, "utf8"), "Beta\nGamma");
});
test("later invalid document hunk rejects the complete plan without modifying CRLF file", async t => {
  const original = "Status: draft\r\nReview: pending\r\n";const { file, config } = await workspace(t, original);
  const document = patch("codex").replace("*** End Patch", "@@\n-Missing\n+Changed\n*** End Patch");
  await assert.rejects(executeWorkspaceTool("apply_patch", { patch: document }, config));
  assert.equal(await fs.readFile(file, "utf8"), original);
});
