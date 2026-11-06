import assert from "node:assert/strict";
import test from "node:test";
import { assessFileChecksumClaims as assess, nativeFileChecksumReceipts as receipts } from "../src/completion-file-checksums.js";

const sha256 = "714bde9fb388ac328c160ada4e40b3e19480071e2aa8aa818d1b6de3b6cf162d";
const wrong = "0".repeat(64), proof = [{ path: "note.txt", sha256 }];
const check = text => assess({ text, receipts: proof });

for (const text of [
  `The SHA-256 of note.txt is ${sha256}.`,
  `note.txt SHA256: ${sha256.toUpperCase()}`,
  "- `note.txt` (unchanged): sha256 `714bde9f…cf162d`, 39 bytes.",
  "note.txt: SHA-256 714bde9f...cf162d",
  `文件 note.txt 的 SHA-256 是 ${sha256}。`,
  `note.txt の SHA-256 は ${sha256}。`,
]) test("correct native file checksum: " + text.slice(0, 45), () => {
  assert.equal(check(text).checked, true); assert.equal(check(text).ok, true);
});

for (const text of [
  `The SHA-256 of note.txt is ${wrong}.`,
  "- `note.txt` (unchanged): sha256 `714bde9f…b162d`, 39 bytes.",
  `文件 note.txt 的 SHA-256 为 ${wrong}。`,
  `note.txt の SHA-256 は ${wrong}。`,
  `Example: expected checksum ${wrong}; note.txt SHA256: ${wrong}`,
  `Previous checksum is unknown; note.txt SHA256: ${wrong}`,
  `Unverified note. The SHA-256 of note.txt is ${wrong}.`,
  `note.txt SHA256: ${wrong}; note.txt SHA256: ${sha256}`,
]) test("contradicted native checksum: " + text.slice(0, 45), () => {
  assert.equal(check(text).checked, true); assert.equal(check(text).ok, false);
  assert.equal(check(text).issues[0].reason, "native-file-checksum-mismatch");
});

for (const text of [
  `An unrelated publication identifier is ${wrong}.`,
  `The SHA-256 of other.txt is ${wrong}.`,
  `The SHA-256 of sub/note.txt is ${wrong}.`,
  `The SHA-256 of C:note.txt is ${wrong}.`,
  `The SHA-512 of note.txt is ${wrong}.`,
  `The expected SHA-256 of note.txt is ${wrong}.`,
  `Example: note.txt SHA256: ${wrong}`,
  `note.txt SHA256 is not ${wrong}.`,
  `note.txt の SHA-256 は ${wrong} ではない。`,
  `"The SHA-256 of note.txt is ${wrong}"`,
  `> The SHA-256 of note.txt is ${wrong}`,
  "```text\nnote.txt SHA256: " + wrong + "\n```",
  `引用例: note.txt SHA256: ${wrong}`,
  `Previous SHA-256 of note.txt is ${wrong}`,
  `Quote: note.txt SHA256: ${wrong}`,
  `修改前 note.txt 的 SHA-256 为 ${wrong}`,
  `以前の note.txt の SHA-256 は ${wrong}`,
]) test("nonassertion or unrelated value: " + text.slice(0, 48), () => {
  assert.equal(check(text).ok, true);
});

test("no native receipt is no checksum verification claim", () => {
  const result = assess({ text: `note.txt SHA256: ${wrong}`, receipts: [] });
  assert.equal(result.checked, false); assert.equal(result.ok, true);
});

const event = data => ({ type: "tool.completed", data });
const read = (hash = sha256) => event({ toolName: "read_file", path: "note.txt", ok: true, sha256: hash });
test("receipt authority uses only successful native reads and the latest hash", () => {
  assert.deepEqual(receipts([read(), read(wrong)]), [{ path: "note.txt", sha256: wrong }]);
  for (const extra of [{ ok: false }, { blocked: true }, { skipped: true }, { sha256: "short" }, { path: "../note.txt" }, { path: "/outside/note.txt" }]) {
    assert.deepEqual(receipts([event({ ...read().data, ...extra })]), []);
  }
  assert.deepEqual(receipts([{ type: "assistant.response", data: read().data }]), []);
  assert.deepEqual(receipts([read(), event({ ...read().data, ok: false })]), []);
  const started = { type: "tool.started", data: { toolName: "read_file", args: { path: "note.txt" } } };
  const failed = { type: "tool.failed", data: { toolName: "read_file", args: { path: "note.txt" }, ok: false, error: "Synthetic ENOENT" } };
  assert.deepEqual(receipts([read(), started, failed]), []);
  assert.deepEqual(receipts([read(), failed]), [], "actual native failure has args.path rather than path");
  assert.deepEqual(receipts([read(), { ...failed, data: { ...failed.data, args: { path: "other.txt" } } }]), proof);
  assert.deepEqual(receipts([read(), { ...started, data: { toolName: "read_file", args: {} } }]), []);
});
for (const toolName of ["write_file", "apply_patch", "run_command", "deep_research", "writing_specialist"]) {
  test(`a later ${toolName} invalidates earlier read snapshots, including failed execution`, () => {
    assert.deepEqual(receipts([read(), event({ toolName, ok: false })]), []);
    assert.deepEqual(receipts([read(), event({ toolName, ok: true }), read(wrong)]), [{ path: "note.txt", sha256: wrong }]);
  });
}
test("an unfinished or unknown side effect invalidates the earlier receipt", () => {
  for (const toolName of ["run_command", "run_codex", "tmux_send_keys", "unknown_tool"]) {
    assert.deepEqual(receipts([read(), { type: "tool.started", data: { toolName } }]), []);
  }
});
test("assessment is bounded and never reads workspace bytes", () => {
  assert.equal(check("a".repeat(140000) + `note.txt SHA256: ${wrong}`).ok, false);
  assert.equal(check("a".repeat(140000)).checked, false);
});
test("large unrelated checksum prose does not repeatedly scan native file paths", () => {
  assert.equal(check(("SHA256: " + wrong + " ").repeat(1500)).checked, false);
});
test("excessive bound checksum labels fail closed with a finite scan budget", () => {
  const result = check(("note.txt SHA256: " + sha256 + "\n").repeat(1500));
  assert.equal(result.ok, false); assert.equal(result.issues[0].reason, "checksum-assessment-limit");
});
test("the exact supported label bound is accepted", () => {
  const result = check(("note.txt SHA256: " + sha256 + "\n").repeat(256));
  assert.equal(result.checked, true); assert.equal(result.ok, true);
});
test("several real metadata fields in one paragraph each bind their own value", () => {
  const result = check(("note.txt SHA256: " + sha256 + ", ").repeat(32));
  assert.equal(result.checked, true); assert.equal(result.ok, true);
});
test("repeated path bindings have a separate finite scan budget", () => {
  const result = check("note.txt ".repeat(1025) + "SHA256: " + sha256);
  assert.equal(result.ok, false); assert.equal(result.issues[0].reason, "checksum-assessment-limit");
});
