import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  canonicalJson,
  contractDigest,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";

export const DOCUMENT_WORKER_API_PREFIX = "/artifact/v1";
export const DOCUMENT_WORKER_ROUTES = Object.freeze({
  readiness: `${DOCUMENT_WORKER_API_PREFIX}/readiness`,
  compile: `${DOCUMENT_WORKER_API_PREFIX}/compile`,
  commit: `${DOCUMENT_WORKER_API_PREFIX}/commit`,
  content: `${DOCUMENT_WORKER_API_PREFIX}/content`,
  delete: `${DOCUMENT_WORKER_API_PREFIX}/delete`,
});
export const DOCUMENT_WORKER_ROUTE_LIST = Object.freeze(Object.values(DOCUMENT_WORKER_ROUTES));

export const DOCUMENT_WORKER_SCHEMA_VERSIONS = Object.freeze({
  readinessRequest: "aginti-document-worker-readiness-request-v1",
  readinessResponse: "aginti-document-worker-readiness-response-v1",
  compileRequirements: "aginti-document-compile-requirements-v1",
  compileRequest: "aginti-document-worker-compile-request-v1",
  compileResponse: "aginti-document-worker-compile-response-v1",
  receipt: "aginti-document-worker-receipt-v1",
  commitRequest: "aginti-document-worker-commit-request-v1",
  commitResponse: "aginti-document-worker-commit-response-v1",
  contentRequest: "aginti-document-worker-content-request-v1",
  deleteRequest: "aginti-document-worker-delete-request-v1",
  deleteResponse: "aginti-document-worker-delete-response-v1",
  scope: "aginti-document-worker-scope-v1",
  owner: "aginti-document-worker-owner-v1",
  thread: "aginti-document-worker-thread-v1",
  run: "aginti-document-worker-run-v1",
  compileArtifacts: "aginti-document-worker-compile-artifacts-v1",
  artifactManifest: "aginti-document-worker-artifact-manifest-v1",
});

export const DOCUMENT_WORKER_LIMITS = Object.freeze({
  maximumRequestBytes: 1024 * 1024,
  maximumSourceBytes: 512 * 1024,
  maximumPdfBytes: 16 * 1024 * 1024,
  maximumLogBytes: 512 * 1024,
  maximumWallTimeMs: 30_000,
  maximumConcurrentCompiles: 2,
  maximumDeleteObjects: 1024,
  maximumFigureCount: 32,
  maximumStoredBytes: 8 * 1024 * 1024 * 1024,
});

export const DOCUMENT_WORKER_PATTERNS = Object.freeze({
  digest: /^[a-f0-9]{64}$/u,
  principalId: /^[A-Za-z0-9._~-]{16,128}$/u,
  browserSessionId: /^[a-f0-9]{64}$/u,
  compileRequestId: /^cmp_[a-f0-9]{64}$/u,
  commitRequestId: /^cmt_[a-f0-9]{64}$/u,
  deletionId: /^del_[a-f0-9]{64}$/u,
  receiptId: /^wrcp_[A-Za-z0-9_-]{32}$/u,
  groupId: /^wgrp_[A-Za-z0-9_-]{43}$/u,
  objectRef: /^wobj_[A-Za-z0-9_-]{43}$/u,
});

export const DOCUMENT_WORKER_ERROR_STATUS = Object.freeze({
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  ARTIFACT_CONTENT_GONE: 410,
  BODY_TOO_LARGE: 413,
  RANGE_NOT_SATISFIABLE: 416,
  TEX_COMPILE_FAILED: 422,
  TEX_LIMIT_EXCEEDED: 422,
  TEX_EXTERNAL_ASSET_FORBIDDEN: 422,
  TEX_REQUIREMENTS_UNSATISFIED: 422,
  WORKER_CREATION_DISABLED: 503,
  ARTIFACT_DELETE_PENDING: 503,
  WORKER_UNAVAILABLE: 503,
  WORKER_STATE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
});

const COMPILE_SCOPE_KEYS = Object.freeze(["principalId", "browserSessionId", "threadId", "runId"]);
const THREAD_SCOPE_KEYS = Object.freeze(["principalId", "browserSessionId", "threadId"]);
const DIGEST = DOCUMENT_WORKER_PATTERNS.digest;

export class IntegrationDocumentWorkerError extends Error {
  constructor(code, message, { status = 500, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationDocumentWorkerError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

export function documentWorkerFail(code, message, options) {
  throw new IntegrationDocumentWorkerError(code, message, options);
}

function plainDataObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    documentWorkerFail("INVALID_REQUEST", `${label} must be a plain JSON object.`, { status: 400 });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    documentWorkerFail("INVALID_REQUEST", `${label} must be a plain JSON object.`, { status: 400 });
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    documentWorkerFail("INVALID_REQUEST", `${label} contains an unsupported field.`, { status: 400 });
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      documentWorkerFail("INVALID_REQUEST", `${label} must contain only JSON data fields.`, { status: 400 });
    }
  }
  return value;
}

export function exactDocumentWorkerObject(value, allowedKeys, requiredKeys, label) {
  const object = plainDataObject(value, label);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      documentWorkerFail("INVALID_REQUEST", `${label} contains an unsupported field.`, { status: 400 });
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(object, key)) {
      documentWorkerFail("INVALID_REQUEST", `${label}.${key} is required.`, { status: 400 });
    }
  }
  return object;
}

function exactArray(value, { minimum, maximum, label }) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    documentWorkerFail("INVALID_REQUEST", `${label} must be an array.`, { status: 400 });
  }
  if (!Number.isSafeInteger(value.length) || value.length < minimum || value.length > maximum) {
    documentWorkerFail("INVALID_REQUEST", `${label} is outside its bound.`, { status: 400 });
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      documentWorkerFail("INVALID_REQUEST", `${label} must not be sparse.`, { status: 400 });
    }
  }
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      documentWorkerFail("INVALID_REQUEST", `${label} contains an unsupported field.`, { status: 400 });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      documentWorkerFail("INVALID_REQUEST", `${label} must contain only JSON data fields.`, { status: 400 });
    }
  }
  return value;
}

function exactSchema(value, expected, label) {
  if (value !== expected) {
    documentWorkerFail("INVALID_REQUEST", `${label} schemaVersion is unsupported.`, { status: 400 });
  }
  return expected;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    documentWorkerFail("INVALID_REQUEST", `${label} is outside its bound.`, { status: 400 });
  }
  return value;
}

function exactDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    documentWorkerFail("INVALID_REQUEST", `${label} is invalid.`, { status: 400 });
  }
  return value;
}

function exactPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    documentWorkerFail("INVALID_REQUEST", `${label} is invalid.`, { status: 400 });
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    documentWorkerFail("INVALID_REQUEST", `${label} is invalid.`, { status: 400 });
  }
  return value;
}

function normalizedFilename(value) {
  if (typeof value !== "string" || !value.isWellFormed()) {
    documentWorkerFail("INVALID_REQUEST", "filename is invalid.", { status: 400 });
  }
  const filename = value.normalize("NFC");
  const stem = filename.slice(0, -4);
  if (
    !filename ||
    filename !== value ||
    !stem ||
    stem === "." ||
    stem === ".." ||
    !/\.tex$/iu.test(filename) ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.length > 240 ||
    Buffer.byteLength(filename, "utf8") > 240 ||
    /[\u0000-\u001f\u007f]/u.test(filename)
  ) {
    documentWorkerFail("INVALID_REQUEST", "filename is invalid.", { status: 400 });
  }
  return filename;
}

export function validateDocumentWorkerCompileScope(value) {
  const scope = exactDocumentWorkerObject(value, COMPILE_SCOPE_KEYS, COMPILE_SCOPE_KEYS, "scope");
  if (typeof scope.principalId !== "string" || !DOCUMENT_WORKER_PATTERNS.principalId.test(scope.principalId)) {
    documentWorkerFail("INVALID_REQUEST", "scope.principalId is invalid.", { status: 400 });
  }
  if (
    typeof scope.browserSessionId !== "string" ||
    !DOCUMENT_WORKER_PATTERNS.browserSessionId.test(scope.browserSessionId)
  ) {
    documentWorkerFail("INVALID_REQUEST", "scope.browserSessionId is invalid.", { status: 400 });
  }
  try {
    validateIntegrationThreadId(scope.threadId);
    validateIntegrationRunId(scope.runId);
  } catch {
    documentWorkerFail("INVALID_REQUEST", "scope identifiers are invalid.", { status: 400 });
  }
  return Object.freeze({
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    threadId: scope.threadId,
    runId: scope.runId,
  });
}

export function validateDocumentWorkerThreadScope(value) {
  const scope = exactDocumentWorkerObject(value, THREAD_SCOPE_KEYS, THREAD_SCOPE_KEYS, "scope");
  if (typeof scope.principalId !== "string" || !DOCUMENT_WORKER_PATTERNS.principalId.test(scope.principalId)) {
    documentWorkerFail("INVALID_REQUEST", "scope.principalId is invalid.", { status: 400 });
  }
  if (
    typeof scope.browserSessionId !== "string" ||
    !DOCUMENT_WORKER_PATTERNS.browserSessionId.test(scope.browserSessionId)
  ) {
    documentWorkerFail("INVALID_REQUEST", "scope.browserSessionId is invalid.", { status: 400 });
  }
  try {
    validateIntegrationThreadId(scope.threadId);
  } catch {
    documentWorkerFail("INVALID_REQUEST", "scope.threadId is invalid.", { status: 400 });
  }
  return Object.freeze({
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    threadId: scope.threadId,
  });
}

export function deriveDocumentWorkerScopeDigests(scopeInput) {
  const scope = validateDocumentWorkerCompileScope(scopeInput);
  const ownerDigest = contractDigest({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.owner,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
  });
  const threadDigest = contractDigest({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.thread,
    ownerDigest,
    threadId: scope.threadId,
  });
  const runDigest = contractDigest({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.run,
    threadDigest,
    runId: scope.runId,
  });
  const scopeDigest = contractDigest({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.scope,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    threadId: scope.threadId,
    runId: scope.runId,
  });
  return Object.freeze({ ownerDigest, threadDigest, runDigest, scopeDigest });
}

export function deriveDocumentWorkerThreadDigests(scopeInput) {
  const scope = validateDocumentWorkerThreadScope(scopeInput);
  const ownerDigest = contractDigest({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.owner,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
  });
  const threadDigest = contractDigest({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.thread,
    ownerDigest,
    threadId: scope.threadId,
  });
  return Object.freeze({ ownerDigest, threadDigest });
}

export function validateDocumentCompileRequirements(value) {
  const requirements = exactDocumentWorkerObject(
    value,
    ["schemaVersion", "profile", "minimumFigureCount"],
    ["schemaVersion", "profile", "minimumFigureCount"],
    "requirements"
  );
  exactSchema(
    requirements.schemaVersion,
    DOCUMENT_WORKER_SCHEMA_VERSIONS.compileRequirements,
    "requirements"
  );
  if (requirements.profile !== "self-contained-tex-v1") {
    documentWorkerFail("INVALID_REQUEST", "requirements.profile is unsupported.", { status: 400 });
  }
  const minimumFigureCount = boundedInteger(
    requirements.minimumFigureCount,
    "requirements.minimumFigureCount",
    0,
    DOCUMENT_WORKER_LIMITS.maximumFigureCount
  );
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.compileRequirements,
    profile: "self-contained-tex-v1",
    minimumFigureCount,
  });
}

export function validateDocumentWorkerReadinessRequest(value) {
  const request = exactDocumentWorkerObject(value, ["schemaVersion"], ["schemaVersion"], "readiness request");
  exactSchema(
    request.schemaVersion,
    DOCUMENT_WORKER_SCHEMA_VERSIONS.readinessRequest,
    "readiness request"
  );
  return Object.freeze({ schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.readinessRequest });
}

export function validateDocumentWorkerCompileRequest(value) {
  const keys = ["schemaVersion", "requestId", "scope", "filename", "source", "sourceSha256", "requirements"];
  const request = exactDocumentWorkerObject(value, keys, keys, "compile request");
  exactSchema(request.schemaVersion, DOCUMENT_WORKER_SCHEMA_VERSIONS.compileRequest, "compile request");
  const requestId = exactPattern(
    request.requestId,
    DOCUMENT_WORKER_PATTERNS.compileRequestId,
    "compile request.requestId"
  );
  const scope = validateDocumentWorkerCompileScope(request.scope);
  const filename = normalizedFilename(request.filename);
  if (
    typeof request.source !== "string" ||
    !request.source.isWellFormed() ||
    Buffer.byteLength(request.source, "utf8") < 1 ||
    Buffer.byteLength(request.source, "utf8") > DOCUMENT_WORKER_LIMITS.maximumSourceBytes ||
    request.source.includes("\u0000")
  ) {
    documentWorkerFail("INVALID_REQUEST", "compile request.source is invalid.", { status: 400 });
  }
  const sourceSha256 = exactDigest(request.sourceSha256, "compile request.sourceSha256");
  const computed = crypto.createHash("sha256").update(request.source, "utf8").digest("hex");
  if (computed !== sourceSha256) {
    documentWorkerFail("INVALID_REQUEST", "compile request source digest does not match.", { status: 400 });
  }
  const requirements = validateDocumentCompileRequirements(request.requirements);
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.compileRequest,
    requestId,
    scope,
    filename,
    source: request.source,
    sourceSha256,
    requirements,
  });
}

function validateManifestObject(value, expectedRole, { includePresentation }) {
  const keys = includePresentation
    ? ["ref", "role", "filename", "mime", "bytes", "sha256"]
    : ["ref", "role", "sha256"];
  const object = exactDocumentWorkerObject(value, keys, keys, `${expectedRole} artifact`);
  const ref = exactPattern(object.ref, DOCUMENT_WORKER_PATTERNS.objectRef, `${expectedRole} artifact.ref`);
  if (object.role !== expectedRole) {
    documentWorkerFail("INVALID_REQUEST", `${expectedRole} artifact role is invalid.`, { status: 400 });
  }
  const sha256 = exactDigest(object.sha256, `${expectedRole} artifact.sha256`);
  if (!includePresentation) return Object.freeze({ ref, role: expectedRole, sha256 });
  const expectedMime = expectedRole === "source" ? "application/x-tex" : "application/pdf";
  if (object.mime !== expectedMime) {
    documentWorkerFail("INVALID_REQUEST", `${expectedRole} artifact MIME type is invalid.`, { status: 400 });
  }
  if (
    typeof object.filename !== "string" ||
    !object.filename.isWellFormed() ||
    object.filename !== object.filename.normalize("NFC") ||
    object.filename.includes("/") ||
    object.filename.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(object.filename) ||
    object.filename.length > 240 ||
    Buffer.byteLength(object.filename, "utf8") > 240 ||
    !(expectedRole === "source" ? /\.tex$/iu : /\.pdf$/iu).test(object.filename)
  ) {
    documentWorkerFail("INVALID_REQUEST", `${expectedRole} artifact filename is invalid.`, { status: 400 });
  }
  const maximum = expectedRole === "source"
    ? DOCUMENT_WORKER_LIMITS.maximumSourceBytes
    : DOCUMENT_WORKER_LIMITS.maximumPdfBytes;
  const bytes = boundedInteger(object.bytes, `${expectedRole} artifact.bytes`, 1, maximum);
  return Object.freeze({
    ref,
    role: expectedRole,
    filename: object.filename,
    mime: expectedMime,
    bytes,
    sha256,
  });
}

export function validateDocumentWorkerCompileArtifacts(value) {
  const artifacts = exactArray(value, { minimum: 2, maximum: 2, label: "compile artifacts" });
  return Object.freeze([
    validateManifestObject(artifacts[0], "source", { includePresentation: true }),
    validateManifestObject(artifacts[1], "pdf", { includePresentation: true }),
  ]);
}

export function documentWorkerCommitManifest(artifactsInput) {
  const artifacts = validateDocumentWorkerCompileArtifacts(artifactsInput);
  return Object.freeze(artifacts.map(({ ref, role, sha256 }) => Object.freeze({ ref, role, sha256 })));
}

export function documentWorkerArtifactsDigest(artifactsInput) {
  const artifacts = validateDocumentWorkerCompileArtifacts(artifactsInput);
  return contractDigest({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.compileArtifacts,
    artifacts,
  });
}

export function documentWorkerManifestDigest(objectsInput) {
  const objects = exactArray(objectsInput, { minimum: 2, maximum: 2, label: "artifact manifest objects" });
  const normalized = Object.freeze([
    validateManifestObject(objects[0], "source", { includePresentation: false }),
    validateManifestObject(objects[1], "pdf", { includePresentation: false }),
  ]);
  return contractDigest({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.artifactManifest,
    objects: normalized,
  });
}

export function validateDocumentWorkerReceipt(value) {
  const keys = [
    "schemaVersion",
    "receiptId",
    "groupId",
    "ownerDigest",
    "threadDigest",
    "runDigest",
    "scopeDigest",
    "requestId",
    "requestDigest",
    "requirementsDigest",
    "verifiedFigureCount",
    "artifactsDigest",
    "compilerDigest",
    "compileLogSha256",
    "sourceSha256",
    "sourceBytes",
    "pdfSha256",
    "pdfBytes",
    "networkNone",
    "shellEscape",
    "issuedAt",
    "digest",
  ];
  const receipt = exactDocumentWorkerObject(value, keys, keys, "worker receipt");
  exactSchema(receipt.schemaVersion, DOCUMENT_WORKER_SCHEMA_VERSIONS.receipt, "worker receipt");
  exactPattern(receipt.receiptId, DOCUMENT_WORKER_PATTERNS.receiptId, "worker receipt.receiptId");
  exactPattern(receipt.groupId, DOCUMENT_WORKER_PATTERNS.groupId, "worker receipt.groupId");
  for (const key of [
    "ownerDigest",
    "threadDigest",
    "runDigest",
    "scopeDigest",
    "requestDigest",
    "requirementsDigest",
    "artifactsDigest",
    "compilerDigest",
    "compileLogSha256",
    "sourceSha256",
    "pdfSha256",
    "digest",
  ]) exactDigest(receipt[key], `worker receipt.${key}`);
  exactPattern(receipt.requestId, DOCUMENT_WORKER_PATTERNS.compileRequestId, "worker receipt.requestId");
  boundedInteger(
    receipt.verifiedFigureCount,
    "worker receipt.verifiedFigureCount",
    0,
    DOCUMENT_WORKER_LIMITS.maximumFigureCount
  );
  boundedInteger(receipt.sourceBytes, "worker receipt.sourceBytes", 1, DOCUMENT_WORKER_LIMITS.maximumSourceBytes);
  boundedInteger(receipt.pdfBytes, "worker receipt.pdfBytes", 1, DOCUMENT_WORKER_LIMITS.maximumPdfBytes);
  if (receipt.networkNone !== true || receipt.shellEscape !== false) {
    documentWorkerFail("INVALID_REQUEST", "worker receipt isolation fields are invalid.", { status: 400 });
  }
  canonicalTimestamp(receipt.issuedAt, "worker receipt.issuedAt");
  const { digest, ...unsigned } = receipt;
  if (contractDigest(unsigned) !== digest) {
    documentWorkerFail("INVALID_REQUEST", "worker receipt digest is invalid.", { status: 400 });
  }
  return Object.freeze({ ...unsigned, digest });
}

export function validateDocumentWorkerCommitRequest(value) {
  const keys = ["schemaVersion", "requestId", "scope", "receiptDigest", "objects"];
  const request = exactDocumentWorkerObject(value, keys, keys, "commit request");
  exactSchema(request.schemaVersion, DOCUMENT_WORKER_SCHEMA_VERSIONS.commitRequest, "commit request");
  const requestId = exactPattern(
    request.requestId,
    DOCUMENT_WORKER_PATTERNS.commitRequestId,
    "commit request.requestId"
  );
  const scope = validateDocumentWorkerCompileScope(request.scope);
  const receiptDigest = exactDigest(request.receiptDigest, "commit request.receiptDigest");
  const objects = exactArray(request.objects, { minimum: 2, maximum: 2, label: "commit request.objects" });
  const normalizedObjects = Object.freeze([
    validateManifestObject(objects[0], "source", { includePresentation: false }),
    validateManifestObject(objects[1], "pdf", { includePresentation: false }),
  ]);
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.commitRequest,
    requestId,
    scope,
    receiptDigest,
    objects: normalizedObjects,
  });
}

export function validateDocumentWorkerContentRequest(value) {
  const keys = ["schemaVersion", "scope", "ref", "receiptDigest", "metadataOnly", "range"];
  const request = exactDocumentWorkerObject(
    value,
    keys,
    ["schemaVersion", "scope", "ref", "receiptDigest", "metadataOnly"],
    "content request"
  );
  exactSchema(request.schemaVersion, DOCUMENT_WORKER_SCHEMA_VERSIONS.contentRequest, "content request");
  const scope = validateDocumentWorkerCompileScope(request.scope);
  const ref = exactPattern(request.ref, DOCUMENT_WORKER_PATTERNS.objectRef, "content request.ref");
  const receiptDigest = exactDigest(request.receiptDigest, "content request.receiptDigest");
  if (typeof request.metadataOnly !== "boolean") {
    documentWorkerFail("INVALID_REQUEST", "content request.metadataOnly must be a boolean.", { status: 400 });
  }
  let range;
  if (request.range !== undefined) {
    const input = exactDocumentWorkerObject(request.range, ["start", "end"], ["start"], "content request.range");
    const start = boundedInteger(input.start, "content request.range.start", 0, Number.MAX_SAFE_INTEGER);
    const end = input.end === undefined
      ? undefined
      : boundedInteger(input.end, "content request.range.end", start, Number.MAX_SAFE_INTEGER);
    range = Object.freeze({ start, ...(end === undefined ? {} : { end }) });
  }
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.contentRequest,
    scope,
    ref,
    receiptDigest,
    metadataOnly: request.metadataOnly,
    ...(range === undefined ? {} : { range }),
  });
}

function validateDeleteObject(value) {
  const object = exactDocumentWorkerObject(
    value,
    ["ref", "runId", "receiptDigest"],
    ["ref", "runId", "receiptDigest"],
    "delete object"
  );
  const ref = exactPattern(object.ref, DOCUMENT_WORKER_PATTERNS.objectRef, "delete object.ref");
  try {
    validateIntegrationRunId(object.runId);
  } catch {
    documentWorkerFail("INVALID_REQUEST", "delete object.runId is invalid.", { status: 400 });
  }
  return Object.freeze({
    ref,
    runId: object.runId,
    receiptDigest: exactDigest(object.receiptDigest, "delete object.receiptDigest"),
  });
}

export function validateDocumentWorkerDeleteRequest(value) {
  const keys = ["schemaVersion", "deletionId", "phase", "scope", "objects"];
  const request = exactDocumentWorkerObject(value, keys, keys, "delete request");
  exactSchema(request.schemaVersion, DOCUMENT_WORKER_SCHEMA_VERSIONS.deleteRequest, "delete request");
  const deletionId = exactPattern(request.deletionId, DOCUMENT_WORKER_PATTERNS.deletionId, "delete request.deletionId");
  if (!new Set(["prepare", "commit", "status"]).has(request.phase)) {
    documentWorkerFail("INVALID_REQUEST", "delete request.phase is invalid.", { status: 400 });
  }
  const scope = validateDocumentWorkerThreadScope(request.scope);
  const inputObjects = exactArray(request.objects, {
    minimum: 1,
    maximum: DOCUMENT_WORKER_LIMITS.maximumDeleteObjects,
    label: "delete request.objects",
  });
  const objects = inputObjects.map(validateDeleteObject);
  for (let index = 1; index < objects.length; index += 1) {
    if (objects[index - 1].ref >= objects[index].ref) {
      documentWorkerFail("INVALID_REQUEST", "delete request.objects must be uniquely sorted by ref.", { status: 400 });
    }
  }
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.deleteRequest,
    deletionId,
    phase: request.phase,
    scope,
    objects: Object.freeze(objects),
  });
}

export function digestNormalizedDocumentWorkerRequest(value) {
  return contractDigest(value);
}

export function digestDocumentWorkerRequirements(value) {
  return contractDigest(validateDocumentCompileRequirements(value));
}

export function randomDocumentWorkerId(prefix, bytes) {
  return `${prefix}${crypto.randomBytes(bytes).toString("base64url")}`;
}

export function canonicalDocumentWorkerJson(value) {
  return `${canonicalJson(value)}\n`;
}

export function publicDocumentWorkerErrorCode(error) {
  const value = String(error?.publicCode || error?.code || "");
  return Object.hasOwn(DOCUMENT_WORKER_ERROR_STATUS, value) ? value : "INTERNAL_ERROR";
}

export function documentWorkerErrorStatus(error) {
  return DOCUMENT_WORKER_ERROR_STATUS[publicDocumentWorkerErrorCode(error)];
}
