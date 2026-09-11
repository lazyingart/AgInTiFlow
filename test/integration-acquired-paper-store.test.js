import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACQUIRED_PAPER_MAXIMUM_BYTES, ACQUIRED_PAPER_SCHEMA_VERSIONS as PAPER,
  validateAcquiredPaperCandidate, validateAcquiredPaperIssueRequest, validateAcquiredPaperReceipt,
} from "../src/integration-acquired-paper-contract.js";
import {
  FILE_WORKER_LIMITS, FILE_WORKER_SCHEMA_VERSIONS as FILE, createFileWorkerIssuanceId,
  validateFileWorkerCandidates, validateFileWorkerReceipt,
} from "../src/integration-file-worker-contract.js";
import { openIntegrationFileWorkerStore } from "../src/integration-file-worker-store.js";
import { contractDigest } from "../src/integration-policy.js";

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const scope = Object.freeze({
  principalId: "principal.paper-store-test",
  browserSessionId: "a".repeat(64),
  threadId: "thr_00000000-0000-4000-8000-000000000101",
  runId: "run_00000000-0000-4000-8000-000000000102",
});
const source = Object.freeze({
  sourceId: "arxiv:1810.04805v2",
  sourceUrl: "https://arxiv.org/pdf/1810.04805v2",
  finalUrl: "https://arxiv.org/pdf/1810.04805v2",
  doi: "10.48550/arxiv.1810.04805",
  version: "v2",
  acquiredAt: "2026-09-11T07:33:48.560Z",
});
// Synthetic, deliberately not a structurally parsed PDF or a scientific paper.
function pdf(length = 775166) {
  const bytes = Buffer.alloc(length, 32);
  bytes.write("%PDF-1.7\nsynthetic import fixture\n");
  bytes.write("\n%%EOF\n", length - 7);
  return bytes;
}
function candidate(bytes) {
  return { index: 0, filename: "paper.pdf", mime: "application/pdf", bytes: bytes.length, sha256: hash(bytes) };
}
function issueRequest(bytes = pdf(), changes = {}) {
  return {
    schemaVersion: PAPER.issueRequest, issuanceId: createFileWorkerIssuanceId(1), authorityEpoch: 1,
    scope, files: [candidate(bytes)], source, ...changes,
  };
}
async function fixture(t, options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-acquired-paper-test-"));
  const stateRoot = path.join(parent, "state");
  let store = await openIntegrationFileWorkerStore({ stateRoot, ...options });
  t.after(async () => { await store.close().catch(() => {}); await fs.rm(parent, { recursive: true, force: true }); });
  return {
    get store() { return store; }, stateRoot,
    async reopen() { await store.close().catch(() => {}); store = await openIntegrationFileWorkerStore({ stateRoot }); },
  };
}
async function issued(store, bytes = pdf()) {
  const issue = issueRequest(bytes);
  const authority = await store.issueAcquiredPaper(issue);
  const request = {
    ...issue, schemaVersion: PAPER.importRequest,
    requestId: authority.requestId, authorityToken: authority.authorityToken,
  };
  return { issue, request, authority, bytes };
}
function commitRequest(imported, change = {}) {
  return {
    schemaVersion: FILE.commitRequest, requestId: `fcmt_${hash(imported.receipt.digest)}`, scope,
    receiptDigest: imported.receipt.digest,
    objects: imported.artifacts.map(({ ref, index, sha256 }) => ({ ref, index, sha256 })), ...change,
  };
}
function contentRequest(imported, change = {}) {
  return {
    schemaVersion: FILE.contentRequest, scope, receiptDigest: imported.receipt.digest,
    ref: imported.artifacts[0].ref, metadataOnly: false, ...change,
  };
}
async function read(content) {
  try { const chunks = []; for await (const chunk of content.stream) chunks.push(chunk); return Buffer.concat(chunks); }
  finally { await content.release(); }
}
const fails = (operation, code) => assert.rejects(operation, error => error.code === code);

test("realistic-sized paper uses distinct receipt, durable commit, range reads and restart replay", async t => {
  const f = await fixture(t);
  const { issue, request, authority, bytes } = await issued(f.store);
  assert(bytes.length > FILE_WORKER_LIMITS.maximumFileBytes);
  assert.equal(authority.schemaVersion, PAPER.issueResponse);
  const imported = await f.store.importAcquiredPaper(request, bytes);
  assert.equal(imported.schemaVersion, PAPER.importResponse);
  assert.equal(imported.receipt.schemaVersion, PAPER.receipt);
  assert.deepEqual(validateAcquiredPaperReceipt(imported.receipt), imported.receipt);
  assert.deepEqual(imported.receipt.source, source);
  assert.throws(() => validateFileWorkerReceipt(imported.receipt));
  assert.equal(imported.artifacts[0].sha256, hash(bytes));
  await fails(f.store.openContent(contentRequest(imported)), "NOT_FOUND");
  assert.equal((await f.store.commit(commitRequest(imported))).status, "committed");
  assert.deepEqual(await read(await f.store.openContent(contentRequest(imported))), bytes);
  assert.deepEqual(await read(await f.store.openContent(contentRequest(imported, { range: { start: 33, end: 100003 } }))), bytes.subarray(33, 100004));
  const metadata = await f.store.openContent(contentRequest(imported, { metadataOnly: true }));
  assert.equal(metadata.stream, null);
  assert.equal(metadata.metadata.totalBytes, bytes.length);
  await f.reopen();
  assert.deepEqual(await f.store.issueAcquiredPaper(issue), authority);
  const replay = await f.store.importAcquiredPaper(request, bytes);
  assert.deepEqual(replay, imported);
  assert(Object.isFrozen(replay.receipt.source));
  assert.throws(() => { replay.receipt.source.version = "v7"; }, TypeError);
  assert.equal((await f.store.commit(commitRequest(imported))).status, "committed");
  assert.deepEqual(await read(await f.store.openContent(contentRequest(imported))), bytes);
  assert.equal((await f.store.inspect()).groups, 1);
});

test("maximum-size paper is supported without widening generated files", async t => {
  const f = await fixture(t);
  const { request, bytes } = await issued(f.store, pdf(ACQUIRED_PAPER_MAXIMUM_BYTES));
  assert.throws(() => validateFileWorkerCandidates(request.files));
  assert.throws(() => validateAcquiredPaperCandidate({ ...request.files[0], bytes: ACQUIRED_PAPER_MAXIMUM_BYTES + 1 }));
  const imported = await f.store.importAcquiredPaper(request, bytes);
  await f.store.commit(commitRequest(imported));
  assert.equal(hash(await read(await f.store.openContent(contentRequest(imported)))), hash(bytes));
  assert.equal(FILE_WORKER_LIMITS.maximumFileBytes, 512 * 1024);
  assert.equal(FILE_WORKER_LIMITS.maximumBundleBytes, 768 * 1024);
});

for (const [label, changes] of [
  ["owner", { principalId: "principal.other-owner" }],
  ["session", { browserSessionId: "b".repeat(64) }],
  ["thread", { threadId: "thr_00000000-0000-4000-8000-000000000103" }],
  ["run", { runId: "run_00000000-0000-4000-8000-000000000104" }],
]) test(`paper import, commit, and content stay bound to ${label}`, async t => {
  const f = await fixture(t);
  const { request, bytes } = await issued(f.store);
  const wrongScope = { ...scope, ...changes };
  await fails(f.store.importAcquiredPaper({ ...request, scope: wrongScope }, bytes), "ARTIFACT_CONTENT_GONE");
  const imported = await f.store.importAcquiredPaper(request, bytes);
  await fails(f.store.commit(commitRequest(imported, { scope: wrongScope })), "NOT_FOUND");
  await f.store.commit(commitRequest(imported));
  await fails(f.store.openContent(contentRequest(imported, { scope: wrongScope })), "NOT_FOUND");
});

test("source, metadata, and issuance authority are immutable and distinct from generated files", async t => {
  const f = await fixture(t);
  const { issue, request, bytes } = await issued(f.store);
  const changedSource = { ...source, version: "v3" };
  await fails(f.store.issueAcquiredPaper({ ...issue, source: changedSource }), "IDEMPOTENCY_CONFLICT");
  await fails(f.store.importAcquiredPaper({ ...request, source: changedSource }, bytes), "ARTIFACT_CONTENT_GONE");
  await fails(f.store.importAcquiredPaper({ ...request, authorityToken: "wpa_" + "x".repeat(43) }, bytes), "ARTIFACT_CONTENT_GONE");
  await fails(f.store.issue(issue), "INVALID_REQUEST");
  await fails(f.store.publish(request), "INVALID_REQUEST");
  const imported = await f.store.importAcquiredPaper(request, bytes);
  await fails(f.store.importAcquiredPaper({ ...request, source: changedSource }, bytes), "IDEMPOTENCY_CONFLICT");
  const renamed = { ...request, files: [{ ...request.files[0], filename: "different.pdf" }] };
  await fails(f.store.importAcquiredPaper(renamed, bytes), "IDEMPOTENCY_CONFLICT");
  assert.equal((await f.store.inspect()).groups, 1);
  assert.equal(imported.receipt.source.version, "v2");
});

test("binary bytes are copied before queueing and callers retain their own buffer", async t => {
  const f = await fixture(t);
  const { request, bytes } = await issued(f.store);
  const original = Buffer.from(bytes);
  const pending = f.store.importAcquiredPaper(request, bytes);
  bytes.fill(0);
  const imported = await pending;
  await f.store.commit(commitRequest(imported));
  assert.deepEqual(await read(await f.store.openContent(contentRequest(imported))), original);
  const replay = Buffer.from(original);
  await f.store.importAcquiredPaper(request, replay);
  assert.deepEqual(replay, original);
});

test("truncation, corrupt hash, fake PDF and shared bytes create no stage", async t => {
  const f = await fixture(t);
  const { request, bytes } = await issued(f.store);
  await fails(f.store.importAcquiredPaper(request, bytes.subarray(1)), "INVALID_REQUEST");
  const corrupt = Buffer.from(bytes); corrupt[77] = 1;
  await fails(f.store.importAcquiredPaper(request, corrupt), "INVALID_REQUEST");
  const fake = Buffer.alloc(bytes.length, 32);
  await fails(f.store.importAcquiredPaper({ ...request, files: [candidate(fake)] }, fake), "INVALID_REQUEST");
  await fails(f.store.importAcquiredPaper(request, Buffer.from(new SharedArrayBuffer(bytes.length))), "INVALID_REQUEST");
  assert.deepEqual(await fs.readdir(path.join(f.stateRoot, "stages")), []);
  assert.equal((await f.store.inspect()).groups, 0);
});

test("cancellation before staging and after writing discards only the uncommitted bytes", async t => {
  const controller = new AbortController();
  const f = await fixture(t, { checkpoint(name) {
    if (name === "file-after-stage-before-ledger") controller.abort();
  } });
  const { request, bytes } = await issued(f.store);
  await assert.rejects(f.store.importAcquiredPaper(request, bytes, { signal: AbortSignal.abort() }), { name: "AbortError" });
  await assert.rejects(f.store.importAcquiredPaper(request, bytes, { signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(await fs.readdir(path.join(f.stateRoot, "stages")), []);
  assert.equal((await f.store.inspect()).groups, 0);
  await f.reopen();
  const imported = await f.store.importAcquiredPaper(request, bytes);
  assert.equal(imported.artifacts.length, 1);
});

test("cancellation while queued leaves no staged object and retry uses the issuance", async t => {
  let unblock;
  let reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  let pause = false;
  const f = await fixture(t, { async checkpoint(name) {
    if (pause && name === "file-before-ledger-rename") { pause = false; reached(); await blocked; }
  } });
  const { request, bytes } = await issued(f.store);
  pause = true;
  const occupying = f.store.issueAcquiredPaper(issueRequest(bytes));
  await waiting;
  const controller = new AbortController();
  const pending = f.store.importAcquiredPaper(request, bytes, { signal: controller.signal });
  controller.abort();
  unblock();
  await occupying;
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(await fs.readdir(path.join(f.stateRoot, "stages")), []);
  assert.equal((await f.store.inspect()).groups, 0);
  assert.equal((await f.store.importAcquiredPaper(request, bytes)).artifacts.length, 1);
});

test("a staged paper stays hidden after restart until its original commit", async t => {
  const f = await fixture(t);
  const { request, bytes } = await issued(f.store);
  const imported = await f.store.importAcquiredPaper(request, bytes);
  await f.reopen();
  await fails(f.store.openContent(contentRequest(imported)), "NOT_FOUND");
  assert.deepEqual(await f.store.importAcquiredPaper(request, bytes), imported);
  await f.store.commit(commitRequest(imported));
  assert.deepEqual(await read(await f.store.openContent(contentRequest(imported))), bytes);
});

test("generated files and acquired papers share lifecycle without sharing input limits", async t => {
  const f = await fixture(t);
  const bytes = pdf();
  const { request } = await issued(f.store, bytes);
  const paper = await f.store.importAcquiredPaper(request, bytes);
  const text = Buffer.from("# Generated report\n");
  const file = { index: 0, filename: "report.md", mime: "text/markdown", bytes: text.length, sha256: hash(text) };
  const issue = { schemaVersion: FILE.issueRequest, issuanceId: createFileWorkerIssuanceId(1), authorityEpoch: 1, scope, files: [file] };
  const authority = await f.store.issue(issue);
  const generated = await f.store.publish({
    ...issue, schemaVersion: FILE.publishRequest, requestId: authority.requestId, authorityToken: authority.authorityToken,
    files: [{ ...file, encoding: "utf8", content: text.toString("utf8") }],
  });
  assert.equal(generated.receipt.schemaVersion, FILE.receipt);
  await f.store.commit(commitRequest(paper));
  await f.store.commit(commitRequest(generated));
  await f.reopen();
  assert.deepEqual(await read(await f.store.openContent(contentRequest(paper))), bytes);
  assert.deepEqual(await read(await f.store.openContent(contentRequest(generated))), text);
  assert.equal((await f.store.inspect()).groups, 2);
});

test("crash after commit intent recovers the same paper without re-import", async t => {
  const f = await fixture(t, { checkpoint(name) {
    if (name === "file-after-commit-ledger-before-objects") throw new Error("controlled crash");
  } });
  const { request, bytes } = await issued(f.store);
  const imported = await f.store.importAcquiredPaper(request, bytes);
  await assert.rejects(f.store.commit(commitRequest(imported)), /controlled crash/u);
  await f.reopen();
  assert.equal((await f.store.commit(commitRequest(imported))).status, "committed");
  assert.deepEqual(await read(await f.store.openContent(contentRequest(imported))), bytes);
});

test("two-phase deletion survives restart and refuses resurrection", async t => {
  const f = await fixture(t);
  const { request, bytes } = await issued(f.store);
  const imported = await f.store.importAcquiredPaper(request, bytes);
  await f.store.commit(commitRequest(imported));
  const { runId, ...threadScope } = scope;
  const deletion = {
    schemaVersion: FILE.deleteRequest, deletionId: `fdel_${hash("delete-paper")}`, phase: "prepare", scope: threadScope,
    objects: [{ ref: imported.artifacts[0].ref, runId, receiptDigest: imported.receipt.digest }],
  };
  await f.store.delete(deletion);
  await fails(f.store.openContent(contentRequest(imported)), "ARTIFACT_DELETE_PENDING");
  await f.reopen();
  assert.equal((await f.store.delete({ ...deletion, phase: "commit" })).status, "committed");
  await fails(f.store.openContent(contentRequest(imported)), "ARTIFACT_CONTENT_GONE");
  await fails(f.store.importAcquiredPaper(request, bytes), "ARTIFACT_CONTENT_GONE");
  assert.deepEqual(await fs.readdir(path.join(f.stateRoot, "objects")), []);
  await f.reopen();
  assert.equal((await f.store.delete({ ...deletion, phase: "status" })).status, "committed");
});

test("source metadata rejects credentials, private URLs and extra network policy", () => {
  const request = issueRequest();
  for (const url of ["http://arxiv.org/p.pdf", "https://user:secret@arxiv.org/p.pdf", "https://127.0.0.1/p.pdf",
    "https://2130706433/p.pdf", "https://[::1]/p.pdf", "https://papers.local/p.pdf", "https://arxiv.org/p.pdf#fragment"]) {
    assert.throws(() => validateAcquiredPaperIssueRequest({ ...request, source: { ...source, finalUrl: url } }));
  }
  assert.throws(() => validateAcquiredPaperIssueRequest({ ...request, allowedOrigins: ["https://evil.test"] }));
  assert.throws(() => validateAcquiredPaperIssueRequest({ ...request, files: [...request.files, ...request.files] }));
  assert.throws(() => validateAcquiredPaperIssueRequest({ ...request, source: { ...source, acquiredAt: "yesterday" } }));
});

test("receipt source tampering fails persisted binding validation", async t => {
  const f = await fixture(t);
  const { request, bytes } = await issued(f.store);
  const imported = await f.store.importAcquiredPaper(request, bytes);
  const changed = { ...imported.receipt, source: { ...source, version: "v7" } };
  assert.throws(() => validateAcquiredPaperReceipt(changed));
  const { digest: _digest, ...unsigned } = imported.receipt;
  assert.equal(contractDigest(unsigned), imported.receipt.digest);
});
