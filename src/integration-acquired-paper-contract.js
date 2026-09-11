// Binary import contract for already acquired source PDFs. The storage worker
// never fetches these URLs, executes a PDF, or asserts publication rights.
import crypto from "node:crypto";
import { isIP } from "node:net";
import { types as utilTypes } from "node:util";
import {
  documentWorkerFail, exactDocumentWorkerObject, validateDocumentWorkerCompileScope,
} from "./integration-document-worker-contract.js";
import {
  FILE_WORKER_PATTERNS, fileWorkerIssuanceEpoch, validateFileWorkerMimeAndFilename,
} from "./integration-file-worker-contract.js";
import { MAX_INTEGRATION_FILE_ARTIFACT_BYTES } from "./integration-artifacts.js";
import { contractDigest } from "./integration-policy.js";
import { hasCompletePublicPdfEnvelope } from "./public-pdf-download.js";

export const ACQUIRED_PAPER_MAXIMUM_BYTES = MAX_INTEGRATION_FILE_ARTIFACT_BYTES;
export const ACQUIRED_PAPER_SCHEMA_VERSIONS = Object.freeze({
  issueRequest: "aginti-acquired-paper-issue-request-v1",
  issueResponse: "aginti-acquired-paper-issue-response-v1",
  importRequest: "aginti-acquired-paper-import-request-v1",
  importResponse: "aginti-acquired-paper-import-response-v1",
  receipt: "aginti-acquired-paper-receipt-v1",
  artifacts: "aginti-acquired-paper-artifacts-v1",
});
const NORMALIZED_IMPORTS = new WeakSet();

function invalid(label) {
  documentWorkerFail("INVALID_REQUEST", `Acquired paper ${label} is invalid.`, { status: 400 });
}

function exact(value, keys, label) {
  return exactDocumentWorkerObject(value, keys, keys, `acquired paper ${label}`);
}

function pattern(value, expected, label) {
  if (typeof value !== "string" || !expected.test(value)) invalid(label);
  return value;
}

function text(value, maximum, label) {
  if (typeof value !== "string" || !value.isWellFormed() || !value || value.length > maximum ||
      value.trim() !== value || /\p{C}/u.test(value)) invalid(label);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) invalid(label);
  return value;
}

function sourceUrl(value) {
  text(value, 2048, "source URL");
  let url;
  try { url = new URL(value); } catch { invalid("source URL"); }
  if (url.href !== value || url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.port || /[\s\\]/u.test(value) || !url.hostname.includes(".") ||
      isIP(url.hostname.replace(/^\[|\]$/gu, "")) ||
      /(?:^|\.)(?:localhost|local|internal|intranet|lan)$/iu.test(url.hostname)) invalid("source URL");
  return value;
}

export function validateAcquiredPaperSource(value) {
  const source = exact(value, ["sourceId", "sourceUrl", "finalUrl", "doi", "version", "acquiredAt"], "source");
  return Object.freeze({
    sourceId: text(source.sourceId, 256, "source identity"),
    sourceUrl: sourceUrl(source.sourceUrl),
    finalUrl: sourceUrl(source.finalUrl),
    doi: source.doi === null ? null : pattern(source.doi, /^10\.[0-9]{4,9}\/[^\s\p{C}]{1,240}$/u, "DOI"),
    version: source.version === null ? null : text(source.version, 80, "source version"),
    acquiredAt: timestamp(source.acquiredAt, "acquisition time"),
  });
}

export function validateAcquiredPaperCandidate(value) {
  const file = exact(value, ["index", "filename", "mime", "bytes", "sha256"], "file");
  if (file.index !== 0 || file.mime !== "application/pdf" ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 14 || file.bytes > ACQUIRED_PAPER_MAXIMUM_BYTES) invalid("file");
  return Object.freeze({
    index: 0,
    ...validateFileWorkerMimeAndFilename(file.mime, file.filename),
    bytes: file.bytes,
    sha256: pattern(file.sha256, FILE_WORKER_PATTERNS.digest, "file hash"),
  });
}

function single(value, label) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length !== 1 || Reflect.ownKeys(value).length !== 2 ||
      !Object.getOwnPropertyDescriptor(value, "0")?.enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, "0") || {}, "value")) invalid(label);
  return value[0];
}

function request(value, importing) {
  const keys = ["schemaVersion", "issuanceId", "authorityEpoch", "scope", "files", "source"];
  if (importing) keys.push("requestId", "authorityToken");
  const input = exact(value, keys, importing ? "import request" : "issue request");
  const schemaVersion = importing ? ACQUIRED_PAPER_SCHEMA_VERSIONS.importRequest : ACQUIRED_PAPER_SCHEMA_VERSIONS.issueRequest;
  if (input.schemaVersion !== schemaVersion || !Number.isSafeInteger(input.authorityEpoch) ||
      input.authorityEpoch < 1 || fileWorkerIssuanceEpoch(input.issuanceId) !== input.authorityEpoch) invalid("request authority");
  return Object.freeze({
    schemaVersion,
    issuanceId: input.issuanceId,
    authorityEpoch: input.authorityEpoch,
    scope: validateDocumentWorkerCompileScope(input.scope),
    files: Object.freeze([validateAcquiredPaperCandidate(single(input.files, "file count"))]),
    source: validateAcquiredPaperSource(input.source),
    ...(importing ? {
      requestId: pattern(input.requestId, FILE_WORKER_PATTERNS.requestId, "request id"),
      authorityToken: pattern(input.authorityToken, FILE_WORKER_PATTERNS.authorityToken, "authority token"),
    } : {}),
  });
}

export function validateAcquiredPaperIssueRequest(value) { return request(value, false); }
export function validateAcquiredPaperImportRequest(value) { return request(value, true); }

export function digestAcquiredPaperContent(value) {
  return contractDigest({
    schemaVersion: "aginti-acquired-paper-content-v1",
    scope: validateDocumentWorkerCompileScope(value.scope),
    files: [validateAcquiredPaperCandidate(single(value.files, "file count"))],
    source: validateAcquiredPaperSource(value.source),
  });
}

export function normalizeAcquiredPaperImport(value, bytes) {
  const metadata = validateAcquiredPaperImportRequest(value);
  const file = metadata.files[0];
  if (!Buffer.isBuffer(bytes) || bytes.length !== file.bytes || utilTypes.isSharedArrayBuffer(bytes.buffer)) invalid("binary length");
  // Own a copy before queuing/awaiting, so callers cannot mutate staged bytes.
  const owned = Buffer.from(bytes);
  if (!hasCompletePublicPdfEnvelope(owned) || crypto.createHash("sha256").update(owned).digest("hex") !== file.sha256) {
    owned.fill(0);
    invalid("binary integrity or PDF envelope");
  }
  const normalized = Object.freeze({
    ...metadata, files: Object.freeze([Object.freeze({ ...file, bytesValue: owned })]),
  });
  NORMALIZED_IMPORTS.add(normalized);
  return normalized;
}

export function digestAcquiredPaperImportOperation(value) {
  if (!NORMALIZED_IMPORTS.has(value)) invalid("normalized import");
  const metadata = validateAcquiredPaperImportRequest({
    ...value, files: value.files.map(({ bytesValue: _bytes, ...file }) => file),
  });
  return contractDigest({ schemaVersion: "aginti-acquired-paper-import-operation-v1", request: metadata });
}

export function validateAcquiredPaperArtifacts(value) {
  const file = exact(single(value, "artifact count"), ["ref", "index", "filename", "mime", "bytes", "sha256"], "artifact");
  const { ref, ...candidate } = file;
  return Object.freeze([Object.freeze({
    ref: pattern(ref, FILE_WORKER_PATTERNS.objectRef, "object ref"),
    ...validateAcquiredPaperCandidate(candidate),
  })]);
}

export function acquiredPaperArtifactsDigest(value) {
  return contractDigest({ schemaVersion: ACQUIRED_PAPER_SCHEMA_VERSIONS.artifacts, artifacts: validateAcquiredPaperArtifacts(value) });
}

export function validateAcquiredPaperReceipt(value) {
  const keys = [
    "schemaVersion", "receiptId", "groupId", "ownerDigest", "threadDigest", "runDigest", "scopeDigest",
    "requestId", "requestDigest", "artifactsDigest", "fileCount", "totalBytes", "networkNone", "issuedAt", "digest", "source",
  ];
  const receipt = exact(value, keys, "receipt");
  if (receipt.schemaVersion !== ACQUIRED_PAPER_SCHEMA_VERSIONS.receipt || receipt.fileCount !== 1 ||
      !Number.isSafeInteger(receipt.totalBytes) || receipt.totalBytes < 14 ||
      receipt.totalBytes > ACQUIRED_PAPER_MAXIMUM_BYTES || receipt.networkNone !== true) invalid("receipt");
  for (const key of ["ownerDigest", "threadDigest", "runDigest", "scopeDigest", "requestDigest", "artifactsDigest", "digest"]) {
    pattern(receipt[key], FILE_WORKER_PATTERNS.digest, `receipt ${key}`);
  }
  for (const key of ["receiptId", "groupId", "requestId"]) pattern(receipt[key], FILE_WORKER_PATTERNS[key], `receipt ${key}`);
  timestamp(receipt.issuedAt, "receipt time");
  const source = validateAcquiredPaperSource(receipt.source);
  const { digest, ...unsigned } = receipt;
  if (contractDigest(unsigned) !== digest) invalid("receipt digest");
  return Object.freeze({ ...unsigned, source, digest });
}
