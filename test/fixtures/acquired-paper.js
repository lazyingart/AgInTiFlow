import crypto from "node:crypto";
import { ACQUIRED_PAPER_SCHEMA_VERSIONS as PAPER } from "../../src/integration-acquired-paper-contract.js";
import { FILE_WORKER_SCHEMA_VERSIONS as FILE, createFileWorkerIssuanceId } from "../../src/integration-file-worker-contract.js";

export const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export const scope = Object.freeze({
  principalId: "principal.paper-transport-test",
  browserSessionId: "a".repeat(64),
  threadId: "thr_00000000-0000-4000-8000-000000000201",
  runId: "run_00000000-0000-4000-8000-000000000202",
});
export const source = Object.freeze({
  sourceId: "synthetic-transport-fixture", sourceUrl: "https://papers.example.org/paper.pdf",
  finalUrl: "https://papers.example.org/paper.pdf", doi: null, version: null,
  acquiredAt: "2026-09-11T08:00:00.000Z",
});
export function pdf(length = 775166) {
  const bytes = Buffer.alloc(length, 32);
  bytes.write("%PDF-1.7\nsynthetic transport fixture\n");
  bytes.write("\n%%EOF\n", length - 7);
  return bytes;
}
export function issueRequest(bytes) {
  return {
    schemaVersion: PAPER.issueRequest, issuanceId: createFileWorkerIssuanceId(1), authorityEpoch: 1, scope, source,
    files: [{ index: 0, filename: "paper.pdf", mime: "application/pdf", bytes: bytes.length, sha256: sha256(bytes) }],
  };
}
export function importRequest(issue, authority = {}) {
  return {
    ...issue, schemaVersion: PAPER.importRequest,
    requestId: authority.requestId ?? `fpub_${"b".repeat(64)}`,
    authorityToken: authority.authorityToken ?? `wpa_${"c".repeat(43)}`,
  };
}
export function commitRequest(imported, selectedScope = scope) {
  return {
    schemaVersion: FILE.commitRequest, requestId: `fcmt_${sha256(imported.receipt.digest)}`, scope: selectedScope,
    receiptDigest: imported.receipt.digest,
    objects: imported.artifacts.map(({ ref, index, sha256: hash }) => ({ ref, index, sha256: hash })),
  };
}
export function contentRequest(imported, changes = {}) {
  return {
    schemaVersion: FILE.contentRequest, scope, ref: imported.artifacts[0].ref,
    receiptDigest: imported.receipt.digest, metadataOnly: false, ...changes,
  };
}
