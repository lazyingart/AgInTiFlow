import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  deriveDocumentWorkerScopeDigests,
  deriveDocumentWorkerThreadDigests,
  documentWorkerFail,
  validateDocumentWorkerCompileScope,
  validateDocumentWorkerThreadScope,
} from "./integration-document-worker-contract.js";
import { canonicalJson, contractDigest, validateIntegrationRunId } from "./integration-policy.js";

export const FILE_WORKER_ROUTES = Object.freeze({
  readiness: "/artifact/v1/files/readiness",
  issue: "/artifact/v1/files/issue",
  publish: "/artifact/v1/files/publish",
  commit: "/artifact/v1/files/commit",
  content: "/artifact/v1/files/content",
  delete: "/artifact/v1/files/delete",
});
export const FILE_WORKER_ROUTE_LIST = Object.freeze(Object.values(FILE_WORKER_ROUTES));

export const FILE_WORKER_SCHEMA_VERSIONS = Object.freeze({
  readinessRequest: "aginti-file-worker-readiness-request-v1",
  readinessResponse: "aginti-file-worker-readiness-response-v1",
  issueRequest: "aginti-file-worker-issue-request-v1",
  issueResponse: "aginti-file-worker-issue-response-v1",
  publishRequest: "aginti-file-worker-publish-request-v1",
  publishResponse: "aginti-file-worker-publish-response-v1",
  receipt: "aginti-file-worker-receipt-v1",
  artifacts: "aginti-file-worker-artifacts-v1",
  manifest: "aginti-file-worker-manifest-v1",
  commitRequest: "aginti-file-worker-commit-request-v1",
  commitResponse: "aginti-file-worker-commit-response-v1",
  contentRequest: "aginti-file-worker-content-request-v1",
  deleteRequest: "aginti-file-worker-delete-request-v1",
  deleteResponse: "aginti-file-worker-delete-response-v1",
});

export const FILE_WORKER_LIMITS = Object.freeze({
  maximumFiles: 8,
  maximumFileBytes: 512 * 1024,
  maximumBundleBytes: 768 * 1024,
  maximumStoredBytes: 8 * 1024 * 1024 * 1024,
  maximumDeleteObjects: 1024,
});

export const FILE_WORKER_PATTERNS = Object.freeze({
  digest: /^[a-f0-9]{64}$/u,
  issuanceId: /^fiss_[a-f0-9]{16}_[a-f0-9]{64}$/u,
  requestId: /^fpub_[a-f0-9]{64}$/u,
  authorityToken: /^wpa_[A-Za-z0-9_-]{43}$/u,
  receiptId: /^frcp_[A-Za-z0-9_-]{32}$/u,
  groupId: /^fgrp_[A-Za-z0-9_-]{43}$/u,
  objectRef: /^fobj_[A-Za-z0-9_-]{43}$/u,
  commitRequestId: /^fcmt_[a-f0-9]{64}$/u,
  deletionId: /^fdel_[a-f0-9]{64}$/u,
});

const MIME_EXTENSIONS = new Map([
  ["text/plain", new Set(["txt", "log"])],
  ["application/x-tex", new Set(["tex"])],
  ["text/x-tex", new Set(["tex"])],
  ["text/markdown", new Set(["md", "markdown"])],
  ["text/csv", new Set(["csv"])],
  ["application/json", new Set(["json"])],
  ["application/xml", new Set(["xml"])],
  ["text/html", new Set(["html", "htm"])],
  ["text/css", new Set(["css"])],
  ["text/javascript", new Set(["js", "mjs", "cjs"])],
  ["application/typescript", new Set(["ts", "tsx"])],
  ["text/x-python", new Set(["py"])],
  ["application/x-sh", new Set(["sh"])],
  ["image/svg+xml", new Set(["svg"])],
  ["image/png", new Set(["png"])],
  ["image/jpeg", new Set(["jpg", "jpeg"])],
  ["image/webp", new Set(["webp"])],
  ["image/gif", new Set(["gif"])],
  ["application/pdf", new Set(["pdf"])],
  ["application/zip", new Set(["zip"])],
  ["application/gzip", new Set(["gz"])],
  ["application/octet-stream", new Set(["bin", "dat"])],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Set(["docx"])],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", new Set(["xlsx"])],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", new Set(["pptx"])],
]);
const NORMALIZED_PUBLISH_REQUESTS = new WeakSet();

export const FILE_WORKER_ACTIVE_MIME_TYPES = Object.freeze(new Set([
  "application/xml",
  "text/html",
  "text/css",
  "text/javascript",
  "application/typescript",
  "image/svg+xml",
]));

function plain(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    documentWorkerFail("INVALID_REQUEST", `${label} must be a plain JSON object.`, { status: 400 });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    documentWorkerFail("INVALID_REQUEST", `${label} must be a plain JSON object.`, { status: 400 });
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      documentWorkerFail("INVALID_REQUEST", `${label} must contain only JSON data fields.`, { status: 400 });
    }
  }
  return value;
}

function exact(value, allowedKeys, requiredKeys, label) {
  const object = plain(value, label);
  const allowed = new Set(allowedKeys);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    documentWorkerFail("INVALID_REQUEST", `${label} contains an unsupported field.`, { status: 400 });
  }
  if (requiredKeys.some((key) => !Object.hasOwn(object, key))) {
    documentWorkerFail("INVALID_REQUEST", `${label} is incomplete.`, { status: 400 });
  }
  return object;
}

function array(value, minimum, maximum, label) {
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
  if (Reflect.ownKeys(value).some((key) => key !== "length" && (
    typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length
  ))) {
    documentWorkerFail("INVALID_REQUEST", `${label} contains an unsupported field.`, { status: 400 });
  }
  return value;
}

function schema(value, expected, label) {
  if (value !== expected) {
    documentWorkerFail("INVALID_REQUEST", `${label} schemaVersion is unsupported.`, { status: 400 });
  }
}

function digest(value, label) {
  if (typeof value !== "string" || !FILE_WORKER_PATTERNS.digest.test(value)) {
    documentWorkerFail("INVALID_REQUEST", `${label} is invalid.`, { status: 400 });
  }
  return value;
}

function pattern(value, expected, label) {
  if (typeof value !== "string" || !expected.test(value)) {
    documentWorkerFail("INVALID_REQUEST", `${label} is invalid.`, { status: 400 });
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    documentWorkerFail("INVALID_REQUEST", `${label} is outside its bound.`, { status: 400 });
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    documentWorkerFail("INVALID_REQUEST", `${label} is invalid.`, { status: 400 });
  }
  return value;
}

export function normalizeFileWorkerFilename(value) {
  if (typeof value !== "string" || !value.isWellFormed()) {
    documentWorkerFail("INVALID_REQUEST", "file filename is invalid.", { status: 400 });
  }
  const filename = value.normalize("NFC");
  if (
    filename !== value ||
    filename.length < 3 ||
    filename.length > 180 ||
    Buffer.byteLength(filename, "utf8") > 240 ||
    filename.trim() !== filename ||
    filename === "." ||
    filename === ".." ||
    filename.startsWith(".") ||
    filename.endsWith(".") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(filename)
  ) {
    documentWorkerFail("INVALID_REQUEST", "file filename is invalid.", { status: 400 });
  }
  return filename;
}

export function validateFileWorkerMimeAndFilename(mimeValue, filenameValue) {
  const filename = normalizeFileWorkerFilename(filenameValue);
  if (typeof mimeValue !== "string" || mimeValue !== mimeValue.toLowerCase()) {
    documentWorkerFail("INVALID_REQUEST", "file MIME type is invalid.", { status: 400 });
  }
  const mime = mimeValue;
  const extensions = MIME_EXTENSIONS.get(mime);
  const dot = filename.lastIndexOf(".");
  const extension = dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
  if (!extensions || !extensions.has(extension)) {
    documentWorkerFail("INVALID_REQUEST", "file MIME type and extension are inconsistent or unsupported.", {
      status: 400,
    });
  }
  return Object.freeze({ filename, mime });
}

function validateCandidate(value, index) {
  const item = exact(value, ["index", "filename", "mime", "bytes", "sha256"], [
    "index", "filename", "mime", "bytes", "sha256",
  ], `file candidate ${index}`);
  if (item.index !== index) {
    documentWorkerFail("INVALID_REQUEST", "file candidate order is invalid.", { status: 400 });
  }
  const presentation = validateFileWorkerMimeAndFilename(item.mime, item.filename);
  return Object.freeze({
    index,
    ...presentation,
    bytes: integer(item.bytes, 1, FILE_WORKER_LIMITS.maximumFileBytes, `file candidate ${index}.bytes`),
    sha256: digest(item.sha256, `file candidate ${index}.sha256`),
  });
}

export function validateFileWorkerCandidates(value) {
  const files = array(value, 1, FILE_WORKER_LIMITS.maximumFiles, "file candidates").map(validateCandidate);
  const names = new Set(files.map(({ filename }) => filename.toLowerCase()));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (names.size !== files.length || totalBytes > FILE_WORKER_LIMITS.maximumBundleBytes) {
    documentWorkerFail("INVALID_REQUEST", "file bundle names or total bytes are invalid.", { status: 400 });
  }
  return Object.freeze(files);
}

function decodeContent(value, encoding, expectedBytes, expectedSha256, label) {
  let bytes;
  if (encoding === "utf8") {
    if (typeof value !== "string" || !value.isWellFormed() || value.includes("\u0000")) {
      documentWorkerFail("INVALID_REQUEST", `${label} UTF-8 content is invalid.`, { status: 400 });
    }
    bytes = Buffer.from(value, "utf8");
  } else if (encoding === "base64") {
    if (typeof value !== "string" || value.length < 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
      documentWorkerFail("INVALID_REQUEST", `${label} base64 content is invalid.`, { status: 400 });
    }
    bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) {
      documentWorkerFail("INVALID_REQUEST", `${label} base64 content is not canonical.`, { status: 400 });
    }
  } else {
    documentWorkerFail("INVALID_REQUEST", `${label} encoding is unsupported.`, { status: 400 });
  }
  if (
    bytes.byteLength !== expectedBytes ||
    crypto.createHash("sha256").update(bytes).digest("hex") !== expectedSha256
  ) {
    bytes.fill(0);
    documentWorkerFail("INVALID_REQUEST", `${label} content integrity is invalid.`, { status: 400 });
  }
  return bytes;
}

function validatePublishFile(value, index) {
  const item = exact(value, ["index", "filename", "mime", "bytes", "sha256", "encoding", "content"], [
    "index", "filename", "mime", "bytes", "sha256", "encoding", "content",
  ], `publish file ${index}`);
  const candidate = validateCandidate({
    index: item.index,
    filename: item.filename,
    mime: item.mime,
    bytes: item.bytes,
    sha256: item.sha256,
  }, index);
  return Object.freeze({
    ...candidate,
    encoding: item.encoding,
    content: item.content,
    bytesValue: decodeContent(item.content, item.encoding, candidate.bytes, candidate.sha256, `publish file ${index}`),
  });
}

export function fileWorkerIssuanceEpoch(value) {
  const issuanceId = pattern(value, FILE_WORKER_PATTERNS.issuanceId, "file issuance id");
  const epoch = Number.parseInt(issuanceId.slice(5, 21), 16);
  return integer(epoch, 1, Number.MAX_SAFE_INTEGER, "file issuance epoch");
}

export function createFileWorkerIssuanceId(epochValue) {
  const epoch = integer(epochValue, 1, Number.MAX_SAFE_INTEGER, "file issuance epoch");
  return `fiss_${epoch.toString(16).padStart(16, "0")}_${crypto.randomBytes(32).toString("hex")}`;
}

export function validateFileWorkerIssueRequest(value) {
  const keys = ["schemaVersion", "issuanceId", "authorityEpoch", "scope", "files"];
  const request = exact(value, keys, keys, "file issue request");
  schema(request.schemaVersion, FILE_WORKER_SCHEMA_VERSIONS.issueRequest, "file issue request");
  const issuanceId = pattern(request.issuanceId, FILE_WORKER_PATTERNS.issuanceId, "file issue request.issuanceId");
  const authorityEpoch = integer(request.authorityEpoch, 1, Number.MAX_SAFE_INTEGER, "file issue request.authorityEpoch");
  if (fileWorkerIssuanceEpoch(issuanceId) !== authorityEpoch) {
    documentWorkerFail("INVALID_REQUEST", "file issuance epoch is inconsistent.", { status: 400 });
  }
  return Object.freeze({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.issueRequest,
    issuanceId,
    authorityEpoch,
    scope: validateDocumentWorkerCompileScope(request.scope),
    files: validateFileWorkerCandidates(request.files),
  });
}

export function validateFileWorkerReadinessRequest(value) {
  const request = exact(value, ["schemaVersion"], ["schemaVersion"], "file readiness request");
  schema(request.schemaVersion, FILE_WORKER_SCHEMA_VERSIONS.readinessRequest, "file readiness request");
  return Object.freeze({ schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.readinessRequest });
}

export function digestFileWorkerContent(value) {
  return contractDigest({
    schemaVersion: "aginti-file-worker-content-v1",
    scope: validateDocumentWorkerCompileScope(value.scope),
    files: validateFileWorkerCandidates(value.files),
  });
}

export function validateFileWorkerPublishRequest(value) {
  const keys = [
    "schemaVersion", "issuanceId", "requestId", "authorityEpoch", "authorityToken", "scope", "files",
  ];
  const request = exact(value, keys, keys, "file publish request");
  schema(request.schemaVersion, FILE_WORKER_SCHEMA_VERSIONS.publishRequest, "file publish request");
  const issuanceId = pattern(request.issuanceId, FILE_WORKER_PATTERNS.issuanceId, "file publish request.issuanceId");
  const authorityEpoch = integer(request.authorityEpoch, 1, Number.MAX_SAFE_INTEGER, "file publish request.authorityEpoch");
  if (fileWorkerIssuanceEpoch(issuanceId) !== authorityEpoch) {
    documentWorkerFail("INVALID_REQUEST", "file publish epoch is inconsistent.", { status: 400 });
  }
  const files = array(request.files, 1, FILE_WORKER_LIMITS.maximumFiles, "publish files").map(validatePublishFile);
  validateFileWorkerCandidates(files.map(({ bytesValue: _bytesValue, encoding: _encoding, content: _content, ...file }) => file));
  const normalized = Object.freeze({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.publishRequest,
    issuanceId,
    requestId: pattern(request.requestId, FILE_WORKER_PATTERNS.requestId, "file publish request.requestId"),
    authorityEpoch,
    authorityToken: pattern(request.authorityToken, FILE_WORKER_PATTERNS.authorityToken, "file publish request.authorityToken"),
    scope: validateDocumentWorkerCompileScope(request.scope),
    files: Object.freeze(files),
  });
  NORMALIZED_PUBLISH_REQUESTS.add(normalized);
  return normalized;
}

export function publicFileWorkerPublishRequest(requestInput) {
  const normalizedInput = NORMALIZED_PUBLISH_REQUESTS.has(requestInput);
  const request = normalizedInput ? requestInput : validateFileWorkerPublishRequest(requestInput);
  const publicRequest = Object.freeze({
    ...request,
    files: Object.freeze(request.files.map(({ bytesValue: _bytesValue, ...file }) => Object.freeze({ ...file }))),
  });
  if (!normalizedInput) for (const file of request.files) file.bytesValue.fill(0);
  return publicRequest;
}

export function isNormalizedFileWorkerPublishRequest(value) {
  return NORMALIZED_PUBLISH_REQUESTS.has(value);
}

export function digestFileWorkerPublishOperation(requestInput) {
  const request = publicFileWorkerPublishRequest(requestInput);
  return contractDigest({ schemaVersion: "aginti-file-worker-publish-operation-v1", request });
}

function validateArtifact(value, index, { presentation }) {
  const keys = presentation
    ? ["ref", "index", "filename", "mime", "bytes", "sha256"]
    : ["ref", "index", "sha256"];
  const item = exact(value, keys, keys, `file artifact ${index}`);
  if (item.index !== index) {
    documentWorkerFail("INVALID_REQUEST", "file artifact order is invalid.", { status: 400 });
  }
  const base = Object.freeze({
    ref: pattern(item.ref, FILE_WORKER_PATTERNS.objectRef, `file artifact ${index}.ref`),
    index,
    sha256: digest(item.sha256, `file artifact ${index}.sha256`),
  });
  if (!presentation) return base;
  const candidate = validateCandidate({
    index,
    filename: item.filename,
    mime: item.mime,
    bytes: item.bytes,
    sha256: item.sha256,
  }, index);
  return Object.freeze({ ref: base.ref, ...candidate });
}

export function validateFileWorkerArtifacts(value) {
  const artifacts = array(value, 1, FILE_WORKER_LIMITS.maximumFiles, "file artifacts");
  return Object.freeze(artifacts.map((artifact, index) => validateArtifact(artifact, index, { presentation: true })));
}

export function fileWorkerCommitManifest(value) {
  return Object.freeze(validateFileWorkerArtifacts(value).map(({ ref, index, sha256 }) => Object.freeze({
    ref, index, sha256,
  })));
}

export function fileWorkerArtifactsDigest(value) {
  return contractDigest({ schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.artifacts, artifacts: validateFileWorkerArtifacts(value) });
}

export function fileWorkerManifestDigest(value) {
  const objects = array(value, 1, FILE_WORKER_LIMITS.maximumFiles, "file manifest");
  const normalized = Object.freeze(objects.map((object, index) => validateArtifact(object, index, { presentation: false })));
  return contractDigest({ schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.manifest, objects: normalized });
}

export function validateFileWorkerReceipt(value) {
  const keys = [
    "schemaVersion", "receiptId", "groupId", "ownerDigest", "threadDigest", "runDigest", "scopeDigest",
    "requestId", "requestDigest", "artifactsDigest", "fileCount", "totalBytes", "networkNone", "issuedAt", "digest",
  ];
  const receipt = exact(value, keys, keys, "file receipt");
  schema(receipt.schemaVersion, FILE_WORKER_SCHEMA_VERSIONS.receipt, "file receipt");
  pattern(receipt.receiptId, FILE_WORKER_PATTERNS.receiptId, "file receipt.receiptId");
  pattern(receipt.groupId, FILE_WORKER_PATTERNS.groupId, "file receipt.groupId");
  pattern(receipt.requestId, FILE_WORKER_PATTERNS.requestId, "file receipt.requestId");
  for (const key of ["ownerDigest", "threadDigest", "runDigest", "scopeDigest", "requestDigest", "artifactsDigest", "digest"]) {
    digest(receipt[key], `file receipt.${key}`);
  }
  integer(receipt.fileCount, 1, FILE_WORKER_LIMITS.maximumFiles, "file receipt.fileCount");
  integer(receipt.totalBytes, 1, FILE_WORKER_LIMITS.maximumBundleBytes, "file receipt.totalBytes");
  if (receipt.networkNone !== true) {
    documentWorkerFail("INVALID_REQUEST", "file receipt isolation is invalid.", { status: 400 });
  }
  timestamp(receipt.issuedAt, "file receipt.issuedAt");
  const { digest: supplied, ...unsigned } = receipt;
  if (contractDigest(unsigned) !== supplied) {
    documentWorkerFail("INVALID_REQUEST", "file receipt digest is invalid.", { status: 400 });
  }
  return Object.freeze({ ...unsigned, digest: supplied });
}

export function validateFileWorkerCommitRequest(value) {
  const keys = ["schemaVersion", "requestId", "scope", "receiptDigest", "objects"];
  const request = exact(value, keys, keys, "file commit request");
  schema(request.schemaVersion, FILE_WORKER_SCHEMA_VERSIONS.commitRequest, "file commit request");
  const objects = array(request.objects, 1, FILE_WORKER_LIMITS.maximumFiles, "file commit objects");
  return Object.freeze({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.commitRequest,
    requestId: pattern(request.requestId, FILE_WORKER_PATTERNS.commitRequestId, "file commit request.requestId"),
    scope: validateDocumentWorkerCompileScope(request.scope),
    receiptDigest: digest(request.receiptDigest, "file commit request.receiptDigest"),
    objects: Object.freeze(objects.map((object, index) => validateArtifact(object, index, { presentation: false }))),
  });
}

export function validateFileWorkerContentRequest(value) {
  const keys = ["schemaVersion", "scope", "ref", "receiptDigest", "metadataOnly", "range"];
  const request = exact(value, keys, ["schemaVersion", "scope", "ref", "receiptDigest", "metadataOnly"], "file content request");
  schema(request.schemaVersion, FILE_WORKER_SCHEMA_VERSIONS.contentRequest, "file content request");
  if (typeof request.metadataOnly !== "boolean") {
    documentWorkerFail("INVALID_REQUEST", "file content metadataOnly is invalid.", { status: 400 });
  }
  let range;
  if (request.range !== undefined) {
    const raw = exact(request.range, ["start", "end"], ["start"], "file content range");
    const start = integer(raw.start, 0, Number.MAX_SAFE_INTEGER, "file content range.start");
    const end = raw.end === undefined ? undefined : integer(raw.end, start, Number.MAX_SAFE_INTEGER, "file content range.end");
    range = Object.freeze({ start, ...(end === undefined ? {} : { end }) });
  }
  return Object.freeze({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.contentRequest,
    scope: validateDocumentWorkerCompileScope(request.scope),
    ref: pattern(request.ref, FILE_WORKER_PATTERNS.objectRef, "file content ref"),
    receiptDigest: digest(request.receiptDigest, "file content receiptDigest"),
    metadataOnly: request.metadataOnly,
    ...(range === undefined ? {} : { range }),
  });
}

function validateDeleteObject(value) {
  const item = exact(value, ["ref", "runId", "receiptDigest"], ["ref", "runId", "receiptDigest"], "file delete object");
  try {
    validateIntegrationRunId(item.runId);
  } catch {
    documentWorkerFail("INVALID_REQUEST", "file delete object.runId is invalid.", { status: 400 });
  }
  return Object.freeze({
    ref: pattern(item.ref, FILE_WORKER_PATTERNS.objectRef, "file delete object.ref"),
    runId: item.runId,
    receiptDigest: digest(item.receiptDigest, "file delete object.receiptDigest"),
  });
}

export function validateFileWorkerDeleteRequest(value) {
  const keys = ["schemaVersion", "deletionId", "phase", "scope", "objects"];
  const request = exact(value, keys, keys, "file delete request");
  schema(request.schemaVersion, FILE_WORKER_SCHEMA_VERSIONS.deleteRequest, "file delete request");
  if (!new Set(["prepare", "commit", "status"]).has(request.phase)) {
    documentWorkerFail("INVALID_REQUEST", "file delete phase is invalid.", { status: 400 });
  }
  const objects = array(request.objects, 1, FILE_WORKER_LIMITS.maximumDeleteObjects, "file delete objects").map(validateDeleteObject);
  for (let index = 1; index < objects.length; index += 1) {
    if (objects[index - 1].ref >= objects[index].ref) {
      documentWorkerFail("INVALID_REQUEST", "file delete objects must be uniquely sorted by ref.", { status: 400 });
    }
  }
  return Object.freeze({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.deleteRequest,
    deletionId: pattern(request.deletionId, FILE_WORKER_PATTERNS.deletionId, "file delete request.deletionId"),
    phase: request.phase,
    scope: validateDocumentWorkerThreadScope(request.scope),
    objects: Object.freeze(objects),
  });
}

export function fileWorkerDeletionManifestDigest(value) {
  const request = validateFileWorkerDeleteRequest({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.deleteRequest,
    deletionId: value.deletionId,
    phase: "status",
    scope: value.scope,
    objects: value.objects,
  });
  return contractDigest({
    schemaVersion: "aginti-file-worker-delete-manifest-v1",
    deletionId: request.deletionId,
    scope: request.scope,
    objects: request.objects,
  });
}

export function fileWorkerScopeDigests(value) {
  return deriveDocumentWorkerScopeDigests(value);
}

export function fileWorkerThreadDigests(value) {
  return deriveDocumentWorkerThreadDigests(value);
}

export function randomFileWorkerId(prefix, bytes) {
  return `${prefix}${crypto.randomBytes(bytes).toString("base64url")}`;
}

export function canonicalFileWorkerJson(value) {
  return `${canonicalJson(value)}\n`;
}
