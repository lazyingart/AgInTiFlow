import crypto from "node:crypto";

import {
  DOCUMENT_WORKER_SCHEMA_VERSIONS,
  digestDocumentWorkerRequirements,
  documentWorkerCommitManifest,
} from "../../src/integration-document-worker-contract.js";
import {
  DOCUMENT_WORKER_LISTEN_HOST,
  DOCUMENT_WORKER_LISTEN_PORT,
  DOCUMENT_WORKER_SERVICE_CONFIG_SCHEMA_VERSION,
  DOCUMENT_WORKER_STATE_ROOT,
} from "../../src/integration-document-worker-config.js";

export const TEST_BEARER_TOKEN = "document-worker-test-token-0123456789abcdef";
export const TEST_SCOPE = Object.freeze({
  principalId: "principal.document-worker-smoke",
  browserSessionId: "a".repeat(64),
  threadId: "thr_00000000-0000-4000-8000-000000000001",
  runId: "run_00000000-0000-4000-8000-000000000002",
});
export const TEST_THREAD_SCOPE = Object.freeze({
  principalId: TEST_SCOPE.principalId,
  browserSessionId: TEST_SCOPE.browserSessionId,
  threadId: TEST_SCOPE.threadId,
});
export const TEST_SOURCE = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Document worker smoke test.",
  "\\end{document}",
  "",
].join("\n");

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function fixedRequestId(prefix, label) {
  return `${prefix}${sha256(Buffer.from(label, "utf8"))}`;
}

export function testDocumentWorkerConfig(creationEnabled) {
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SERVICE_CONFIG_SCHEMA_VERSION,
    listen: Object.freeze({ host: DOCUMENT_WORKER_LISTEN_HOST, port: DOCUMENT_WORKER_LISTEN_PORT }),
    stateRoot: DOCUMENT_WORKER_STATE_ROOT,
    creation: Object.freeze({ enabled: creationEnabled, maximumConcurrentCompiles: 1 }),
  });
}

export function testRequirements(minimumFigureCount = 0) {
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.compileRequirements,
    profile: "self-contained-tex-v1",
    minimumFigureCount,
  });
}

export function testCompileRequest(label = "default", overrides = {}) {
  const source = overrides.source ?? TEST_SOURCE;
  const compileAuthorityEpoch = overrides.compileAuthorityEpoch ?? 1;
  const issuanceId = overrides.issuanceId ??
    `iss_${compileAuthorityEpoch.toString(16).padStart(16, "0")}_${sha256(Buffer.from(`issue:${label}`, "utf8"))}`;
  const compileAuthorityToken = overrides.compileAuthorityToken ??
    `wca_${crypto.createHash("sha256").update(`token:${label}`, "utf8").digest("base64url")}`;
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.compileRequest,
    issuanceId,
    requestId: overrides.requestId ?? fixedRequestId("cmp_", label),
    compileAuthorityEpoch,
    compileAuthorityToken,
    scope: overrides.scope ?? TEST_SCOPE,
    filename: overrides.filename ?? `${label.replace(/[^A-Za-z0-9_-]/gu, "-") || "document"}.tex`,
    source,
    sourceSha256: overrides.sourceSha256 ?? sha256(Buffer.from(source, "utf8")),
    requirements: overrides.requirements ?? testRequirements(0),
  });
}

export function testCompileIssueRequest(label = "default", overrides = {}) {
  const source = overrides.source ?? TEST_SOURCE;
  const compileAuthorityEpoch = overrides.compileAuthorityEpoch ?? 1;
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.compileIssueRequest,
    issuanceId: overrides.issuanceId ??
      `iss_${compileAuthorityEpoch.toString(16).padStart(16, "0")}_${sha256(Buffer.from(`issue:${label}`, "utf8"))}`,
    compileAuthorityEpoch,
    scope: overrides.scope ?? TEST_SCOPE,
    filename: overrides.filename ?? `${label.replace(/[^A-Za-z0-9_-]/gu, "-") || "document"}.tex`,
    sourceSha256: overrides.sourceSha256 ?? sha256(Buffer.from(source, "utf8")),
    requirements: overrides.requirements ?? testRequirements(0),
  });
}

export async function issueTestCompileRequest(store, label = "default", overrides = {}) {
  const issue = testCompileIssueRequest(label, overrides);
  const authority = await store.issueCompile(issue);
  return testCompileRequest(label, {
    ...overrides,
    issuanceId: authority.issuanceId,
    requestId: authority.requestId,
    compileAuthorityEpoch: authority.compileAuthorityEpoch,
    compileAuthorityToken: authority.compileAuthorityToken,
  });
}

export function fakeCompiledPayload(request, label = "default") {
  const sourceBytes = Buffer.from(request.source, "utf8");
  const pdfBytes = Buffer.from(`%PDF-1.7\n% AgInTi isolated test payload ${label}\n%%EOF\n`, "utf8");
  const sourceSha256 = sha256(sourceBytes);
  const pdfSha256 = sha256(pdfBytes);
  return Object.freeze({
    schemaVersion: "aginti-tex-compiler-v1",
    compilerReceipt: Object.freeze({
      compilerDigest: sha256(Buffer.from("test-compiler", "utf8")),
      compileLogSha256: sha256(Buffer.from(`test-log:${label}`, "utf8")),
      sourceSha256,
      sourceBytes: sourceBytes.byteLength,
      pdfSha256,
      pdfBytes: pdfBytes.byteLength,
      issuedAt: "2026-08-26T00:00:00.000Z",
    }),
    source: Object.freeze({
      filename: request.filename,
      mime: "application/x-tex",
      bytes: sourceBytes,
      sha256: sourceSha256,
    }),
    pdf: Object.freeze({
      filename: `${request.filename.slice(0, -4)}.pdf`,
      mime: "application/pdf",
      bytes: pdfBytes,
      sha256: pdfSha256,
    }),
  });
}

export function testEvidence(request, verifiedFigureCount = 0) {
  return Object.freeze({
    requirementsDigest: digestDocumentWorkerRequirements(request.requirements),
    verifiedFigureCount,
  });
}

export function testCommitRequest(compileResponse, scope = TEST_SCOPE, label = "default") {
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.commitRequest,
    requestId: fixedRequestId("cmt_", label),
    scope,
    receiptDigest: compileResponse.receipt.digest,
    objects: documentWorkerCommitManifest(compileResponse.artifacts),
  });
}

export function testContentRequest(compileResponse, role = "pdf", overrides = {}) {
  const artifact = compileResponse.artifacts.find((candidate) => candidate.role === role);
  if (!artifact) throw new Error(`Missing ${role} artifact in smoke fixture.`);
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.contentRequest,
    scope: overrides.scope ?? TEST_SCOPE,
    ref: artifact.ref,
    receiptDigest: overrides.receiptDigest ?? compileResponse.receipt.digest,
    metadataOnly: overrides.metadataOnly ?? false,
    ...(overrides.range === undefined ? {} : { range: overrides.range }),
  });
}

export function testDeleteRequest(compileResponse, phase, label = "default") {
  const objects = compileResponse.artifacts
    .map((artifact) => Object.freeze({
      ref: artifact.ref,
      runId: TEST_SCOPE.runId,
      receiptDigest: compileResponse.receipt.digest,
    }))
    .sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.deleteRequest,
    deletionId: fixedRequestId("del_", label),
    phase,
    scope: TEST_THREAD_SCOPE,
    objects: Object.freeze(objects),
  });
}

export async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
