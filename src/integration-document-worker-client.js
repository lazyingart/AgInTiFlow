import crypto from "node:crypto";
import { TextDecoder, types as utilTypes } from "node:util";

import {
  MAX_INTEGRATION_FILE_ARTIFACT_BYTES,
  sanitizeIntegrationArtifact,
  validateIntegrationFileSpec,
} from "./integration-artifacts.js";
import {
  validateAgintiBrowserSession,
  validateAgintiPrincipalId,
  validateIntegrationBearerToken,
} from "./integration-auth.js";
import {
  AGENT_WORKER_SCHEMA_VERSION,
  canonicalJson,
  contractDigest,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";

export const INTEGRATION_DOCUMENT_WORKER_SCHEMA_VERSION = "aginti-document-worker-client-v1";
export const INTEGRATION_DOCUMENT_WORKER_ACTIVATION_SCHEMA_VERSION =
  "aginti-document-worker-client-activation-v1";
export const INTEGRATION_DOCUMENT_WORKER_CAPABILITIES_SCHEMA_VERSION =
  "aginti-document-worker-readiness-response-v1";
export const INTEGRATION_DOCUMENT_WORKER_COMPILE_REQUEST_SCHEMA_VERSION =
  "aginti-document-worker-compile-request-v1";
export const INTEGRATION_DOCUMENT_WORKER_COMPILE_RESPONSE_SCHEMA_VERSION =
  "aginti-document-worker-compile-response-v1";
export const INTEGRATION_DOCUMENT_WORKER_READINESS_REQUEST_SCHEMA_VERSION =
  "aginti-document-worker-readiness-request-v1";
export const INTEGRATION_DOCUMENT_WORKER_COMMIT_REQUEST_SCHEMA_VERSION =
  "aginti-document-worker-commit-request-v1";
export const INTEGRATION_DOCUMENT_WORKER_COMMIT_RESPONSE_SCHEMA_VERSION =
  "aginti-document-worker-commit-response-v1";
export const INTEGRATION_DOCUMENT_COMPILE_REQUIREMENTS_SCHEMA_VERSION =
  "aginti-document-compile-requirements-v1";
export const INTEGRATION_DOCUMENT_WORKER_CONTENT_REQUEST_SCHEMA_VERSION =
  "aginti-document-worker-content-request-v1";
export const INTEGRATION_DOCUMENT_WORKER_DELETE_REQUEST_SCHEMA_VERSION =
  "aginti-document-worker-delete-request-v1";
export const INTEGRATION_DOCUMENT_WORKER_DELETE_RESPONSE_SCHEMA_VERSION =
  "aginti-document-worker-delete-response-v1";
export const INTEGRATION_DOCUMENT_WORKER_RECEIPT_SCHEMA_VERSION =
  "aginti-document-worker-receipt-v1";
export const INTEGRATION_DOCUMENT_WORKER_SCOPE_SCHEMA_VERSION =
  "aginti-document-worker-scope-v1";
export const INTEGRATION_DOCUMENT_WORKER_ENDPOINT = "http://127.0.0.1:18120";
export const INTEGRATION_DOCUMENT_WORKER_TOOL_NAME = "compile_tex_document";
export const INTEGRATION_DOCUMENT_WORKER_TIMEOUT_MS = 120_000;
export const INTEGRATION_DOCUMENT_WORKER_LIMITS = Object.freeze({
  maximumSourceBytes: 512 * 1024,
  maximumPdfBytes: MAX_INTEGRATION_FILE_ARTIFACT_BYTES,
  maximumLogBytes: 512 * 1024,
  maximumWallTimeMs: 30_000,
  maximumConcurrentCompiles: 2,
});
export const INTEGRATION_DOCUMENT_WORKER_ROUTES = Object.freeze({
  readiness: "/artifact/v1/readiness",
  compile: "/artifact/v1/compile",
  commit: "/artifact/v1/commit",
  content: "/artifact/v1/content",
  delete: "/artifact/v1/delete",
});

const CLIENT_BRAND = new WeakSet();
const CLIENT_METADATA = new WeakMap();
const ACTIVATION_METADATA = new WeakMap();
const WORKER_FILE_ARTIFACTS = new WeakMap();
const WORKER_COMMITTED_FILE_ARTIFACTS = new WeakMap();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DIGEST = /^[a-f0-9]{64}$/u;
const RECEIPT_ID = /^wrcp_[A-Za-z0-9_-]{32}$/u;
const GROUP_ID = /^wgrp_[A-Za-z0-9_-]{43}$/u;
const WORKER_REF = /^wobj_[A-Za-z0-9_-]{43}$/u;
const COMPILE_ID = /^cmp_[a-f0-9]{64}$/u;
const COMMIT_ID = /^cmt_[a-f0-9]{64}$/u;
const DELETION_ID = /^del_[a-f0-9]{64}$/u;
const MAX_JSON_RESPONSE_BYTES = 128 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const ERROR_STATUS = Object.freeze({
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
  INTERNAL_ERROR: 500,
  ARTIFACT_DELETE_PENDING: 503,
  WORKER_CREATION_DISABLED: 503,
  WORKER_UNAVAILABLE: 503,
  WORKER_STATE_UNAVAILABLE: 503,
});

export function compareIntegrationDocumentWorkerCodeUnits(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    throw new TypeError("document worker canonical ordering requires strings");
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export class IntegrationDocumentWorkerError extends Error {
  constructor(code, message, { status = 503, cause, workerCode = "" } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationDocumentWorkerError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
    this.workerCode = workerCode;
    this.retryable = status === 503 || status === 504;
  }
}

function fail(code, message, options) {
  throw new IntegrationDocumentWorkerError(code, message, options);
}

function plainDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowed, required, label, { code = "DOCUMENT_WORKER_PROTOCOL_INVALID", status = 502 } = {}) {
  if (!plainDataObject(value)) fail(code, `${label} must be a plain data object.`, { status });
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowedSet.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(code, `${label} contains an unsupported field.`, { status });
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(code, `${label}.${key} is required.`, { status });
    }
  }
  return value;
}

function exactArray(value, length, label) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== length
  ) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", `${label} has an invalid length.`, { status: 502 });
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      fail("DOCUMENT_WORKER_PROTOCOL_INVALID", `${label} must be a dense data array.`, { status: 502 });
    }
  }
  if (Reflect.ownKeys(descriptors).some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(String(key)))) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", `${label} contains an unsupported property.`, { status: 502 });
  }
  return value;
}

function normalizeEndpoint(value) {
  if (value !== INTEGRATION_DOCUMENT_WORKER_ENDPOINT) {
    fail("DOCUMENT_WORKER_CONFIGURATION_INVALID", "Document artifacts require the fixed private loopback route.", {
      status: 500,
    });
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    fail("DOCUMENT_WORKER_CONFIGURATION_INVALID", "Document worker endpoint is invalid.", {
      status: 500,
      cause: error,
    });
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "18120" ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail("DOCUMENT_WORKER_CONFIGURATION_INVALID", "Document worker endpoint is not the exact private route.", {
      status: 500,
    });
  }
  return value;
}

function normalizeCredential(value) {
  try {
    return validateIntegrationBearerToken(value, { field: "document artifact edge credential" });
  } catch (error) {
    fail("DOCUMENT_WORKER_CONFIGURATION_INVALID", "Document artifact edge credential is invalid.", {
      status: 500,
      cause: error,
    });
  }
}

function normalizeTimeout(value) {
  const timeoutMs = value ?? INTEGRATION_DOCUMENT_WORKER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    fail("DOCUMENT_WORKER_CONFIGURATION_INVALID", "Document worker timeout is invalid.", { status: 500 });
  }
  return timeoutMs;
}

function normalizeSignal(value) {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) {
    fail("DOCUMENT_WORKER_INVALID", "Document worker signal is invalid.", { status: 400 });
  }
  return value;
}

function normalizeScope(value, { includeRun = true } = {}) {
  const required = includeRun
    ? ["principalId", "browserSessionId", "threadId", "runId"]
    : ["principalId", "browserSessionId", "threadId"];
  const scope = exactObject(value, required, required, "document worker scope", {
    code: "DOCUMENT_WORKER_INVALID",
    status: 400,
  });
  try {
    return Object.freeze({
      principalId: validateAgintiPrincipalId(scope.principalId),
      browserSessionId: validateAgintiBrowserSession(scope.browserSessionId),
      threadId: validateIntegrationThreadId(scope.threadId),
      ...(includeRun ? { runId: validateIntegrationRunId(scope.runId) } : {}),
    });
  } catch (error) {
    fail("DOCUMENT_WORKER_INVALID", "Document worker scope is invalid.", { status: 400, cause: error });
  }
}

function workerScopeDigest(scope) {
  return contractDigest({ schemaVersion: INTEGRATION_DOCUMENT_WORKER_SCOPE_SCHEMA_VERSION, ...scope });
}

function workerIdentityDigests(scope) {
  const ownerDigest = contractDigest({
    schemaVersion: "aginti-document-worker-owner-v1",
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
  });
  const threadDigest = contractDigest({
    schemaVersion: "aginti-document-worker-thread-v1",
    ownerDigest,
    threadId: scope.threadId,
  });
  const runDigest = contractDigest({
    schemaVersion: "aginti-document-worker-run-v1",
    threadDigest,
    runId: scope.runId,
  });
  return Object.freeze({ ownerDigest, threadDigest, runDigest });
}

function safeFilename(value) {
  if (typeof value !== "string" || !value.isWellFormed()) {
    fail("ANALYSIS_TEX_SOURCE_INVALID", "The TeX filename is invalid.", { status: 400 });
  }
  const filename = value.normalize("NFC");
  if (
    filename.trim() !== filename ||
    !filename.slice(0, -4) ||
    filename.includes("/") ||
    filename.includes("\\") ||
    !/\.tex$/iu.test(filename) ||
    Buffer.byteLength(filename, "utf8") > 200 ||
    /[\u0000-\u001f\u007f]/u.test(filename)
  ) {
    fail("ANALYSIS_TEX_SOURCE_INVALID", "The TeX filename is invalid.", { status: 400 });
  }
  return filename;
}

function safeSource(value) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > INTEGRATION_DOCUMENT_WORKER_LIMITS.maximumSourceBytes ||
    /\u0000/u.test(value) ||
    !/\\documentclass(?:\[[^\]]*\])?\s*\{/u.test(value) ||
    !/\\begin\s*\{document\}/u.test(value) ||
    !/\\end\s*\{document\}/u.test(value)
  ) {
    fail("ANALYSIS_TEX_SOURCE_INVALID", "The TeX source is incomplete or outside its bound.", { status: 400 });
  }
  return value;
}

function normalizeWorkerRef(value) {
  if (typeof value !== "string" || !WORKER_REF.test(value)) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker object reference is invalid.", { status: 502 });
  }
  return value;
}

export function validateIntegrationDocumentWorkerRef(value) {
  return normalizeWorkerRef(value);
}

function requestAbort(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason || new Error("cancelled"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("document worker timeout"));
  }, timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  });
}

function discardBody(response, reason) {
  try {
    Promise.resolve(response?.body?.cancel?.(reason)).catch(() => {});
  } catch {
    // The response is already detached or the injected transport is adversarial.
  }
}

function exactSecurityHeaders(response, { privateContent = false } = {}) {
  const expectedCache = privateContent ? "no-store, private" : "no-store";
  if (
    response?.headers?.get?.("cache-control") !== expectedCache ||
    response?.headers?.get?.("referrer-policy") !== "no-referrer" ||
    response?.headers?.get?.("x-content-type-options") !== "nosniff" ||
    response?.headers?.get?.("set-cookie") !== null ||
    response?.headers?.get?.("content-encoding") !== null
  ) {
    discardBody(response, new Error("unguarded document worker response"));
    fail("DOCUMENT_WORKER_ROUTE_UNGUARDED", "Document worker response security headers are invalid.", {
      status: 503,
    });
  }
}

async function readBoundedBytes(response, maximumBytes, signal) {
  const declared = response.headers?.get?.("content-length");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(String(declared ?? "")) || Number(declared) > maximumBytes) {
    discardBody(response, new Error("document worker response length invalid"));
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker response length is invalid.", { status: 502 });
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker response body is unavailable.", { status: 502 });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason || new Error("document worker request aborted");
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker returned an invalid stream chunk.", { status: 502 });
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker response exceeded its bound.", { status: 502 });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (!complete) await reader.cancel(signal.reason).catch(() => {});
    reader.releaseLock?.();
  }
  if (total !== Number(declared)) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker response was truncated.", { status: 502 });
  }
  return Buffer.concat(chunks, total);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (error) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", `${label} was not valid UTF-8 JSON.`, { status: 502, cause: error });
  }
}

async function readJsonResponse(response, signal, maximumBytes = MAX_JSON_RESPONSE_BYTES) {
  exactSecurityHeaders(response);
  if (response.headers.get("content-type") !== "application/json; charset=utf-8") {
    discardBody(response, new Error("document worker JSON content type invalid"));
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker JSON content type is invalid.", { status: 502 });
  }
  return parseJson(await readBoundedBytes(response, maximumBytes, signal), "Document worker response");
}

async function workerError(response, signal) {
  exactSecurityHeaders(response);
  if (response.headers.get("content-type") !== "application/json; charset=utf-8") {
    discardBody(response, new Error("document worker error content type invalid"));
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker error content type is invalid.", { status: 502 });
  }
  const bytes = await readBoundedBytes(response, 512, signal);
  const value = parseJson(bytes, "Document worker error");
  const envelope = exactObject(value, ["error"], ["error"], "document worker error");
  const error = exactObject(envelope.error, ["code"], ["code"], "document worker error body");
  const code = String(error.code || "");
  const expectedBytes = Buffer.from(`${JSON.stringify({ error: { code } })}\n`, "utf8");
  if (ERROR_STATUS[code] !== response.status || !bytes.equals(expectedBytes)) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker error status is invalid.", { status: 502 });
  }
  return code;
}

function translateWorkerCode(code, status) {
  if (status === 404) return new IntegrationDocumentWorkerError("NOT_FOUND", "Document artifact was not found.", {
    status: 404,
    workerCode: code,
  });
  if (status === 410) return new IntegrationDocumentWorkerError(
    "ARTIFACT_CONTENT_GONE",
    "Document artifact content is no longer available.",
    { status: 410, workerCode: code }
  );
  if (status === 416) return new IntegrationDocumentWorkerError(
    "RANGE_NOT_SATISFIABLE",
    "Document artifact byte range is not satisfiable.",
    { status: 416, workerCode: code }
  );
  if (status === 422) return new IntegrationDocumentWorkerError(
    "ANALYSIS_TEX_COMPILE_FAILED",
    "The bounded workstation TeX compiler rejected the source.",
    { status: 422, workerCode: code }
  );
  if (status === 503 || status === 500 || status === 401) return new IntegrationDocumentWorkerError(
    "ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE",
    "The private workstation document worker is unavailable.",
    { status: 503, workerCode: code }
  );
  return new IntegrationDocumentWorkerError(
    "DOCUMENT_WORKER_PROTOCOL_INVALID",
    "The private workstation document worker rejected the request.",
    { status: status === 409 ? 409 : 502, workerCode: code }
  );
}

function validateCapabilities(value) {
  const capability = exactObject(
    value,
    ["schemaVersion", "ready", "creationEnabled", "protocols", "compiler", "storage", "digest"],
    ["schemaVersion", "ready", "creationEnabled", "protocols", "compiler", "storage", "digest"],
    "document worker capabilities"
  );
  const protocols = exactObject(
    capability.protocols,
    ["compile", "commit", "content", "delete"],
    ["compile", "commit", "content", "delete"],
    "document worker protocols"
  );
  if (typeof capability.creationEnabled !== "boolean") {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker creation readiness is invalid.", { status: 502 });
  }
  const compiler = capability.creationEnabled
    ? exactObject(
        capability.compiler,
        ["compilerDigest", "activationProbeDigest", "networkNone", "shellEscape", "limits"],
        ["compilerDigest", "activationProbeDigest", "networkNone", "shellEscape", "limits"],
        "document worker compiler"
      )
    : capability.compiler;
  if (!capability.creationEnabled && compiler !== null) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Disabled document creation must omit compiler authority.", { status: 502 });
  }
  const limits = compiler?.limits;
  if (compiler) {
    exactObject(
      limits,
      ["maximumSourceBytes", "maximumPdfBytes", "maximumLogBytes", "maximumWallTimeMs", "maximumConcurrentCompiles"],
      ["maximumSourceBytes", "maximumPdfBytes", "maximumLogBytes", "maximumWallTimeMs", "maximumConcurrentCompiles"],
      "document worker limits"
    );
  }
  const storage = exactObject(
    capability.storage,
    ["durable", "restartStableRefs", "rangeReads", "twoPhaseDelete"],
    ["durable", "restartStableRefs", "rangeReads", "twoPhaseDelete"],
    "document worker storage"
  );
  const { digest, ...unsigned } = capability;
  if (
    capability.schemaVersion !== INTEGRATION_DOCUMENT_WORKER_CAPABILITIES_SCHEMA_VERSION ||
    capability.ready !== true ||
    protocols.compile !== INTEGRATION_DOCUMENT_WORKER_COMPILE_REQUEST_SCHEMA_VERSION ||
    protocols.commit !== INTEGRATION_DOCUMENT_WORKER_COMMIT_REQUEST_SCHEMA_VERSION ||
    protocols.content !== INTEGRATION_DOCUMENT_WORKER_CONTENT_REQUEST_SCHEMA_VERSION ||
    protocols.delete !== INTEGRATION_DOCUMENT_WORKER_DELETE_REQUEST_SCHEMA_VERSION ||
    (compiler !== null && (
      !DIGEST.test(compiler.compilerDigest) ||
      !DIGEST.test(compiler.activationProbeDigest) ||
      compiler.networkNone !== true ||
      compiler.shellEscape !== false ||
      canonicalJson(limits) !== canonicalJson(INTEGRATION_DOCUMENT_WORKER_LIMITS)
    )) ||
    storage.durable !== true ||
    storage.restartStableRefs !== true ||
    storage.rangeReads !== true ||
    storage.twoPhaseDelete !== true ||
    !DIGEST.test(digest) ||
    digest !== contractDigest(unsigned)
  ) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker capabilities are invalid.", { status: 502 });
  }
  return Object.freeze({ ...unsigned, digest });
}

export function validateIntegrationDocumentWorkerReceipt(value) {
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
  const receipt = exactObject(value, keys, keys, "document worker receipt");
  const { digest, ...unsigned } = receipt;
  if (
    receipt.schemaVersion !== INTEGRATION_DOCUMENT_WORKER_RECEIPT_SCHEMA_VERSION ||
    !RECEIPT_ID.test(receipt.receiptId) ||
    !GROUP_ID.test(receipt.groupId) ||
    !DIGEST.test(receipt.ownerDigest) ||
    !DIGEST.test(receipt.threadDigest) ||
    !DIGEST.test(receipt.runDigest) ||
    !DIGEST.test(receipt.scopeDigest) ||
    !COMPILE_ID.test(receipt.requestId) ||
    !DIGEST.test(receipt.requestDigest) ||
    !DIGEST.test(receipt.requirementsDigest) ||
    !Number.isSafeInteger(receipt.verifiedFigureCount) ||
    receipt.verifiedFigureCount < 0 ||
    receipt.verifiedFigureCount > 32 ||
    !DIGEST.test(receipt.artifactsDigest) ||
    !DIGEST.test(receipt.compilerDigest) ||
    !DIGEST.test(receipt.compileLogSha256) ||
    !DIGEST.test(receipt.sourceSha256) ||
    !DIGEST.test(receipt.pdfSha256) ||
    !Number.isSafeInteger(receipt.sourceBytes) ||
    receipt.sourceBytes < 1 ||
    receipt.sourceBytes > INTEGRATION_DOCUMENT_WORKER_LIMITS.maximumSourceBytes ||
    !Number.isSafeInteger(receipt.pdfBytes) ||
    receipt.pdfBytes < 1 ||
    receipt.pdfBytes > INTEGRATION_DOCUMENT_WORKER_LIMITS.maximumPdfBytes ||
    receipt.networkNone !== true ||
    receipt.shellEscape !== false ||
    typeof receipt.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.issuedAt)) ||
    new Date(receipt.issuedAt).toISOString() !== receipt.issuedAt ||
    !DIGEST.test(digest) ||
    digest !== contractDigest(unsigned)
  ) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker receipt is invalid.", { status: 502 });
  }
  return Object.freeze({ ...unsigned, digest });
}

function createWorkerFileArtifact(raw, receipt, scope) {
  const item = exactObject(
    raw,
    ["ref", "role", "filename", "mime", "bytes", "sha256"],
    ["ref", "role", "filename", "mime", "bytes", "sha256"],
    "document worker artifact"
  );
  const ref = normalizeWorkerRef(item.ref);
  if (item.role !== "source" && item.role !== "pdf") {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker artifact role is invalid.", { status: 502 });
  }
  const spec = validateIntegrationFileSpec({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    filename: item.filename,
    mime: item.mime,
    bytes: item.bytes,
    sha256: item.sha256,
  });
  const expectedSha256 = item.role === "source" ? receipt.sourceSha256 : receipt.pdfSha256;
  const expectedBytes = item.role === "source" ? receipt.sourceBytes : receipt.pdfBytes;
  if (
    spec.sha256 !== expectedSha256 ||
    spec.bytes !== expectedBytes ||
    (item.role === "source" && spec.mime === "application/pdf") ||
    (item.role === "pdf" && spec.mime !== "application/pdf")
  ) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker artifact disagrees with its receipt.", { status: 502 });
  }
  const artifact = sanitizeIntegrationArtifact({
    id: `art_${contractDigest({ receiptDigest: receipt.digest, role: item.role, sha256: spec.sha256 })}`,
    title: item.role === "source" ? "TeX source" : "Compiled PDF",
    kind: "file",
    spec,
  });
  WORKER_FILE_ARTIFACTS.set(artifact, Object.freeze({
    workerRef: ref,
    receipt,
    role: item.role,
    scope,
  }));
  return artifact;
}

export function inspectIntegrationDocumentWorkerFileArtifact(value) {
  return WORKER_FILE_ARTIFACTS.get(value) || null;
}

export function inspectIntegrationDocumentWorkerCommittedFileArtifact(value) {
  return WORKER_COMMITTED_FILE_ARTIFACTS.get(value) || null;
}

export function normalizeIntegrationDocumentCompileRequirements(value = {}) {
  const requirements = exactObject(
    value,
    ["schemaVersion", "profile", "minimumFigureCount"],
    ["schemaVersion", "profile", "minimumFigureCount"],
    "document compile requirements",
    { code: "ANALYSIS_TEX_SOURCE_INVALID", status: 400 }
  );
  if (
    requirements.schemaVersion !== INTEGRATION_DOCUMENT_COMPILE_REQUIREMENTS_SCHEMA_VERSION ||
    requirements.profile !== "self-contained-tex-v1" ||
    !Number.isSafeInteger(requirements.minimumFigureCount) ||
    requirements.minimumFigureCount < 0 ||
    requirements.minimumFigureCount > 32
  ) {
    fail("ANALYSIS_TEX_SOURCE_INVALID", "Document compile requirements are invalid.", { status: 400 });
  }
  return Object.freeze({
    schemaVersion: INTEGRATION_DOCUMENT_COMPILE_REQUIREMENTS_SCHEMA_VERSION,
    profile: "self-contained-tex-v1",
    minimumFigureCount: requirements.minimumFigureCount,
  });
}

function artifactManifest(artifacts) {
  return artifacts.map((artifact) => Object.freeze({
    ref: artifact.ref,
    role: artifact.role,
    filename: artifact.filename,
    mime: artifact.mime,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  }));
}

function parseCompileResponse(value, request, scope) {
  const response = exactObject(
    value,
    ["schemaVersion", "requestId", "receipt", "artifacts"],
    ["schemaVersion", "requestId", "receipt", "artifacts"],
    "document worker compile response"
  );
  const receipt = validateIntegrationDocumentWorkerReceipt(response.receipt);
  const requestDigest = contractDigest(request);
  const sourceBytes = Buffer.byteLength(request.source, "utf8");
  if (
    response.schemaVersion !== INTEGRATION_DOCUMENT_WORKER_COMPILE_RESPONSE_SCHEMA_VERSION ||
    response.requestId !== request.requestId ||
    receipt.scopeDigest !== workerScopeDigest(scope) ||
    receipt.requestId !== request.requestId ||
    receipt.requestDigest !== requestDigest ||
    receipt.requirementsDigest !== contractDigest(request.requirements) ||
    receipt.verifiedFigureCount < request.requirements.minimumFigureCount ||
    receipt.sourceSha256 !== request.sourceSha256 ||
    receipt.sourceBytes !== sourceBytes
  ) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker compile binding is invalid.", { status: 502 });
  }
  const rawArtifacts = exactArray(response.artifacts, 2, "document worker artifacts");
  if (
    rawArtifacts[0]?.role !== "source" ||
    rawArtifacts[1]?.role !== "pdf" ||
    receipt.artifactsDigest !== contractDigest({
      schemaVersion: "aginti-document-worker-compile-artifacts-v1",
      artifacts: artifactManifest(rawArtifacts),
    })
  ) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker artifact manifest binding is invalid.", { status: 502 });
  }
  const artifacts = rawArtifacts.map((artifact) => createWorkerFileArtifact(artifact, receipt, scope));
  const identityDigests = workerIdentityDigests(scope);
  if (
    receipt.ownerDigest !== identityDigests.ownerDigest ||
    receipt.threadDigest !== identityDigests.threadDigest ||
    receipt.runDigest !== identityDigests.runDigest
  ) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker owner binding is invalid.", { status: 502 });
  }
  if (new Set(artifacts.map((artifact) => inspectIntegrationDocumentWorkerFileArtifact(artifact).role)).size !== 2) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker did not return one source and one PDF.", { status: 502 });
  }
  return Object.freeze({
    schemaVersion: INTEGRATION_DOCUMENT_WORKER_COMPILE_RESPONSE_SCHEMA_VERSION,
    requestId: request.requestId,
    requestDigest,
    receipt,
    artifacts: Object.freeze(artifacts),
  });
}

function normalizeRange(value) {
  if (value === undefined) return undefined;
  const range = exactObject(value, ["start", "end"], ["start"], "document worker range", {
    code: "DOCUMENT_WORKER_INVALID",
    status: 400,
  });
  if (
    !Number.isSafeInteger(range.start) ||
    range.start < 0 ||
    (range.end !== undefined && (!Number.isSafeInteger(range.end) || range.end < range.start))
  ) {
    fail("DOCUMENT_WORKER_INVALID", "Document worker range is invalid.", { status: 400 });
  }
  return Object.freeze({ start: range.start, ...(range.end === undefined ? {} : { end: range.end }) });
}

function exactDecimalHeader(response, name, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = response.headers.get(name);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(String(raw ?? ""))) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", `Document worker ${name} header is invalid.`, { status: 502 });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", `Document worker ${name} header is invalid.`, { status: 502 });
  }
  return value;
}

function parseContentDisposition(response, filename) {
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (character) =>
    `%${character.codePointAt(0).toString(16).toUpperCase()}`
  );
  const fallback = filename
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 120) || "artifact";
  const expected = `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  if (response.headers.get("content-disposition") !== expected) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker content disposition is invalid.", { status: 502 });
  }
  return expected;
}

function parseContentHeaders(response, request, expected) {
  exactSecurityHeaders(response, { privateContent: true });
  if (response.headers.get("accept-ranges") !== "bytes") {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker range header is invalid.", { status: 502 });
  }
  const contentLength = exactDecimalHeader(response, "content-length", {
    maximum: INTEGRATION_DOCUMENT_WORKER_LIMITS.maximumPdfBytes,
  });
  const selectedBytes = request.metadataOnly
    ? exactDecimalHeader(response, "x-artifact-content-length", {
        maximum: INTEGRATION_DOCUMENT_WORKER_LIMITS.maximumPdfBytes,
      })
    : contentLength;
  if (
    (request.metadataOnly && contentLength !== 0) ||
    (!request.metadataOnly && response.headers.get("x-artifact-content-length") !== null) ||
    selectedBytes < 1 ||
    response.headers.get("content-type") !== expected.mime ||
    response.headers.get("etag") !== `"${expected.sha256}"`
  ) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker content metadata is invalid.", { status: 502 });
  }
  parseContentDisposition(response, expected.filename);
  let start = 0;
  let end = expected.bytes - 1;
  if (request.range === undefined) {
    if (response.status !== 200 || response.headers.get("content-range") !== null || selectedBytes !== expected.bytes) {
      fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker returned an unsolicited range.", { status: 502 });
    }
  } else {
    const match = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/u.exec(
      response.headers.get("content-range") || ""
    );
    start = Number(match?.[1]);
    end = Number(match?.[2]);
    const total = Number(match?.[3]);
    if (
      response.status !== 206 ||
      ![start, end, total].every(Number.isSafeInteger) ||
      start !== request.range.start ||
      end < start ||
      end >= total ||
      total !== expected.bytes ||
      selectedBytes !== end - start + 1 ||
      (request.range.end !== undefined && end > request.range.end)
    ) {
      fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker returned an invalid range.", { status: 502 });
    }
  }
  return Object.freeze({ start, end, selectedBytes });
}

function commitManifestDigest(objects) {
  return contractDigest({
    schemaVersion: "aginti-document-worker-artifact-manifest-v1",
    objects,
  });
}

function validateCommitResponse(value, request) {
  const response = exactObject(
    value,
    ["schemaVersion", "requestId", "receiptDigest", "status", "manifestDigest", "committedAt", "digest"],
    ["schemaVersion", "requestId", "receiptDigest", "status", "manifestDigest", "committedAt", "digest"],
    "document worker commit response"
  );
  const { digest, ...unsigned } = response;
  if (
    response.schemaVersion !== INTEGRATION_DOCUMENT_WORKER_COMMIT_RESPONSE_SCHEMA_VERSION ||
    response.requestId !== request.requestId ||
    response.receiptDigest !== request.receiptDigest ||
    response.status !== "committed" ||
    response.manifestDigest !== commitManifestDigest(request.objects) ||
    typeof response.committedAt !== "string" ||
    !Number.isFinite(Date.parse(response.committedAt)) ||
    new Date(response.committedAt).toISOString() !== response.committedAt ||
    !DIGEST.test(digest) ||
    digest !== contractDigest(unsigned)
  ) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker commit response is invalid.", { status: 502 });
  }
  return Object.freeze({ ...unsigned, digest });
}

function normalizeDeleteObjects(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1024) {
    fail("DOCUMENT_WORKER_INVALID", "Document worker deletion object list is invalid.", { status: 400 });
  }
  const objects = value.map((raw) => {
    const item = exactObject(raw, ["ref", "runId", "receiptDigest"], ["ref", "runId", "receiptDigest"], "deletion object", {
      code: "DOCUMENT_WORKER_INVALID",
      status: 400,
    });
    if (!DIGEST.test(item.receiptDigest)) {
      fail("DOCUMENT_WORKER_INVALID", "Deletion receipt digest is invalid.", { status: 400 });
    }
    return Object.freeze({
      ref: normalizeWorkerRef(item.ref),
      runId: validateIntegrationRunId(item.runId),
      receiptDigest: item.receiptDigest,
    });
  });
  const sorted = [...objects].sort((left, right) =>
    compareIntegrationDocumentWorkerCodeUnits(left.ref, right.ref) ||
      compareIntegrationDocumentWorkerCodeUnits(left.runId, right.runId)
  );
  if (new Set(sorted.map(({ ref }) => ref)).size !== sorted.length || canonicalJson(objects) !== canonicalJson(sorted)) {
    fail("DOCUMENT_WORKER_INVALID", "Deletion objects must be unique and canonically sorted.", { status: 400 });
  }
  return Object.freeze(objects);
}

export function integrationDocumentWorkerDeletionManifestDigest({ deletionId, scope, objects }) {
  return contractDigest({
    schemaVersion: "aginti-document-worker-delete-manifest-v1",
    deletionId,
    scope,
    objects,
  });
}

function validateDeleteResponse(value, request) {
  const response = exactObject(
    value,
    ["schemaVersion", "deletionId", "phase", "status", "manifestDigest", "tombstoneDigest", "completedAt", "digest"],
    ["schemaVersion", "deletionId", "phase", "status", "manifestDigest", "tombstoneDigest", "completedAt", "digest"],
    "document worker delete response"
  );
  const { digest, ...unsigned } = response;
  const expectedManifest = integrationDocumentWorkerDeletionManifestDigest(request);
  const prepared = response.status === "prepared";
  const committed = response.status === "committed";
  if (
    response.schemaVersion !== INTEGRATION_DOCUMENT_WORKER_DELETE_RESPONSE_SCHEMA_VERSION ||
    response.deletionId !== request.deletionId ||
    response.phase !== request.phase ||
    (!prepared && !committed) ||
    response.manifestDigest !== expectedManifest ||
    (prepared && (response.tombstoneDigest !== null || response.completedAt !== null)) ||
    (committed && (
      !DIGEST.test(response.tombstoneDigest) ||
      typeof response.completedAt !== "string" ||
      !Number.isFinite(Date.parse(response.completedAt)) ||
      new Date(response.completedAt).toISOString() !== response.completedAt
    )) ||
    !DIGEST.test(digest) ||
    digest !== contractDigest(unsigned)
  ) {
    fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker delete response is invalid.", { status: 502 });
  }
  return Object.freeze({ ...unsigned, digest });
}

function createClient(optionsValue, { testOnly }) {
  const allowed = testOnly
    ? ["endpoint", "credential", "timeoutMs", "fetchImpl"]
    : ["endpoint", "credential", "timeoutMs"];
  const options = exactObject(
    optionsValue,
    allowed,
    testOnly ? ["endpoint", "credential", "fetchImpl"] : ["endpoint", "credential"],
    "document worker client configuration",
    { code: "DOCUMENT_WORKER_CONFIGURATION_INVALID", status: 500 }
  );
  const endpoint = normalizeEndpoint(options.endpoint);
  const credential = normalizeCredential(options.credential);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const fetchImpl = testOnly ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    fail("DOCUMENT_WORKER_CONFIGURATION_INVALID", "Document worker fetch transport is unavailable.", { status: 500 });
  }
  let activation = null;
  let activationPromise = null;

  function requestHeaders(accept = "application/json", contentType = true) {
    return Object.freeze({
      Accept: accept,
      Authorization: `Bearer ${credential}`,
      "Cache-Control": "no-store",
      ...(contentType ? { "Content-Type": "application/json" } : {}),
    });
  }

  function requestBody(value) {
    const body = canonicalJson(value);
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      fail("DOCUMENT_WORKER_INVALID", "Document worker request exceeds its private route bound.", { status: 413 });
    }
    return body;
  }

  async function fetchWorker(pathname, init, signal, { keepAbort = false } = {}) {
    const abort = requestAbort(signal, timeoutMs);
    try {
      if (abort.signal.aborted) throw abort.signal.reason || new Error("document worker aborted");
      const response = await fetchImpl(`${endpoint}${pathname}`, Object.freeze({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        ...init,
        signal: abort.signal,
      }));
      if (!response || !Number.isInteger(response.status) || !response.headers) {
        fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker returned no HTTP response.", { status: 502 });
      }
      if (keepAbort) return Object.freeze({ response, abort });
      return response;
    } catch (error) {
      abort.cleanup();
      if (error instanceof IntegrationDocumentWorkerError) throw error;
      if (signal?.aborted) {
        fail("ANALYSIS_CANCELLED", "Document worker request was cancelled.", {
          status: 499,
          cause: signal.reason || error,
        });
      }
      if (abort.timedOut()) {
        fail("ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE", "The private workstation document worker timed out.", {
          status: 503,
          cause: error,
        });
      }
      fail("ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE", "The private workstation document worker is unavailable.", {
        status: 503,
        cause: error,
      });
    }
  }

  async function activate(optionsValue = {}) {
    const options = exactObject(optionsValue, ["signal"], [], "document worker activation options", {
      code: "DOCUMENT_WORKER_CONFIGURATION_INVALID",
      status: 500,
    });
    const signal = normalizeSignal(options.signal);
    if (activation) return activation;
    if (activationPromise) return activationPromise;
    activationPromise = (async () => {
      const abort = requestAbort(signal, timeoutMs);
      try {
        const readinessRequest = Object.freeze({
          schemaVersion: INTEGRATION_DOCUMENT_WORKER_READINESS_REQUEST_SCHEMA_VERSION,
        });
        const response = await fetchImpl(`${endpoint}${INTEGRATION_DOCUMENT_WORKER_ROUTES.readiness}`, {
          method: "POST",
          headers: requestHeaders(),
          body: requestBody(readinessRequest),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: abort.signal,
        });
        if (response.status !== 200) {
          const code = await workerError(response, abort.signal);
          throw translateWorkerCode(code, response.status);
        }
        const capabilities = validateCapabilities(await readJsonResponse(response, abort.signal, 16 * 1024));
        const unsigned = Object.freeze({
          schemaVersion: INTEGRATION_DOCUMENT_WORKER_ACTIVATION_SCHEMA_VERSION,
          owner: "aginti",
          authority: "workstation-document-worker",
          ready: true,
          creationEnabled: capabilities.creationEnabled,
          additive: true,
          privateLoopback: true,
          credentialRequired: true,
          callerSelectableEndpoint: false,
          endpointDigest: contractDigest({ endpoint }),
          capabilitiesDigest: capabilities.digest,
          ...(capabilities.compiler === null
            ? {}
            : {
                compilerDigest: capabilities.compiler.compilerDigest,
                activationProbeDigest: capabilities.compiler.activationProbeDigest,
              }),
        });
        activation = Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
        ACTIVATION_METADATA.set(activation, Object.freeze({ client, testOnly }));
        return activation;
      } catch (error) {
        if (error instanceof IntegrationDocumentWorkerError) throw error;
        if (signal?.aborted) {
          fail("ANALYSIS_CANCELLED", "Document worker readiness was cancelled.", { status: 499, cause: error });
        }
        fail("ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE", "The private workstation document worker is unavailable.", {
          status: 503,
          cause: error,
        });
      } finally {
        abort.cleanup();
      }
    })().finally(() => {
      activationPromise = null;
    });
    return activationPromise;
  }

  async function compile(scopeValue, inputValue, optionsValue = {}) {
    const currentActivation = await activate(optionsValue.signal === undefined ? {} : { signal: optionsValue.signal });
    if (currentActivation.creationEnabled !== true) {
      fail("ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE", "Workstation document creation is not enabled.", {
        status: 503,
      });
    }
    const scope = normalizeScope(scopeValue);
    const input = exactObject(inputValue, ["filename", "source", "requirements"], ["filename", "source", "requirements"], "document compile input", {
      code: "ANALYSIS_TEX_SOURCE_INVALID",
      status: 400,
    });
    const filename = safeFilename(input.filename);
    const source = safeSource(input.source);
    const requirements = normalizeIntegrationDocumentCompileRequirements(input.requirements);
    const sourceSha256 = crypto.createHash("sha256").update(source, "utf8").digest("hex");
    const requestId = `cmp_${contractDigest({
      schemaVersion: "aginti-document-worker-compile-id-v1",
      scope,
      filename,
      sourceSha256,
      requirementsDigest: contractDigest(requirements),
    })}`;
    const request = Object.freeze({
      schemaVersion: INTEGRATION_DOCUMENT_WORKER_COMPILE_REQUEST_SCHEMA_VERSION,
      requestId,
      scope,
      filename,
      source,
      sourceSha256,
      requirements,
    });
    const abort = requestAbort(normalizeSignal(optionsValue.signal), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}${INTEGRATION_DOCUMENT_WORKER_ROUTES.compile}`, {
        method: "POST",
        headers: requestHeaders(),
        body: requestBody(request),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      });
      if (response.status !== 200) {
        const code = await workerError(response, abort.signal);
        throw translateWorkerCode(code, response.status);
      }
      return parseCompileResponse(await readJsonResponse(response, abort.signal), request, scope);
    } catch (error) {
      if (error instanceof IntegrationDocumentWorkerError) throw error;
      if (optionsValue.signal?.aborted) {
        fail("ANALYSIS_CANCELLED", "Document compilation was cancelled.", {
          status: 499,
          cause: optionsValue.signal.reason || error,
        });
      }
      fail("ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE", "The private workstation document worker is unavailable.", {
        status: 503,
        cause: error,
      });
    } finally {
      abort.cleanup();
    }
  }

  async function commitArtifacts(scopeValue, value, optionsValue = {}) {
    const scope = normalizeScope(scopeValue);
    const input = exactObject(
      value,
      ["receiptDigest", "artifacts", "objects"],
      ["receiptDigest"],
      "document artifact commit input",
      { code: "DOCUMENT_WORKER_INVALID", status: 400 }
    );
    if (!DIGEST.test(input.receiptDigest)) {
      fail("DOCUMENT_WORKER_INVALID", "Document artifact commit receipt is invalid.", { status: 400 });
    }
    if ((input.artifacts === undefined) === (input.objects === undefined)) {
      fail("DOCUMENT_WORKER_INVALID", "Document artifact commit requires one object source.", { status: 400 });
    }
    let objects;
    if (input.artifacts !== undefined) {
      const artifacts = exactArray(input.artifacts, 2, "document artifact commit artifacts");
      const privateFiles = artifacts.map((artifact) => inspectIntegrationDocumentWorkerFileArtifact(artifact));
      if (
        privateFiles.some((item) => !item) ||
        privateFiles[0].role !== "source" ||
        privateFiles[1].role !== "pdf" ||
        privateFiles.some((item) => canonicalJson(item.scope) !== canonicalJson(scope)) ||
        privateFiles.some((item) => item.receipt.digest !== input.receiptDigest)
      ) {
        fail("DOCUMENT_WORKER_INVALID", "Document artifact commit authority is invalid.", { status: 400 });
      }
      objects = Object.freeze(artifacts.map((artifact, index) => Object.freeze({
        ref: privateFiles[index].workerRef,
        role: privateFiles[index].role,
        sha256: artifact.spec.sha256,
      })));
    } else {
      const candidates = exactArray(input.objects, 2, "stored document artifact commit objects");
      objects = Object.freeze(candidates.map((raw, index) => {
        const item = exactObject(raw, ["ref", "role", "sha256"], ["ref", "role", "sha256"], "commit object", {
          code: "DOCUMENT_WORKER_INVALID",
          status: 400,
        });
        if (item.role !== (index === 0 ? "source" : "pdf") || !DIGEST.test(item.sha256)) {
          fail("DOCUMENT_WORKER_INVALID", "Stored document artifact commit manifest is invalid.", { status: 400 });
        }
        return Object.freeze({ ref: normalizeWorkerRef(item.ref), role: item.role, sha256: item.sha256 });
      }));
    }
    const requestId = `cmt_${contractDigest({
      schemaVersion: "aginti-document-worker-commit-id-v1",
      scope,
      receiptDigest: input.receiptDigest,
      manifestDigest: commitManifestDigest(objects),
    })}`;
    const request = Object.freeze({
      schemaVersion: INTEGRATION_DOCUMENT_WORKER_COMMIT_REQUEST_SCHEMA_VERSION,
      requestId,
      scope,
      receiptDigest: input.receiptDigest,
      objects,
    });
    const abort = requestAbort(normalizeSignal(optionsValue.signal), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}${INTEGRATION_DOCUMENT_WORKER_ROUTES.commit}`, {
        method: "POST",
        headers: requestHeaders(),
        body: requestBody(request),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      });
      if (response.status !== 200) {
        const code = await workerError(response, abort.signal);
        throw translateWorkerCode(code, response.status);
      }
      const commit = validateCommitResponse(await readJsonResponse(response, abort.signal), request);
      if (input.artifacts !== undefined) {
        for (const artifact of input.artifacts) WORKER_COMMITTED_FILE_ARTIFACTS.set(artifact, commit);
      }
      return commit;
    } catch (error) {
      if (error instanceof IntegrationDocumentWorkerError) throw error;
      if (optionsValue.signal?.aborted) {
        fail("ANALYSIS_CANCELLED", "Document artifact commit was cancelled.", { status: 499, cause: error });
      }
      fail("ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE", "The private workstation document worker is unavailable.", {
        status: 503,
        cause: error,
      });
    } finally {
      abort.cleanup();
    }
  }

  async function content(scopeValue, inputValue, optionsValue = {}) {
    const scope = normalizeScope(scopeValue);
    const input = exactObject(
      inputValue,
      ["ref", "receiptDigest", "filename", "mime", "bytes", "sha256", "metadataOnly", "range"],
      ["ref", "receiptDigest", "filename", "mime", "bytes", "sha256", "metadataOnly"],
      "document content input",
      { code: "DOCUMENT_WORKER_INVALID", status: 400 }
    );
    if (typeof input.metadataOnly !== "boolean" || !DIGEST.test(input.receiptDigest)) {
      fail("DOCUMENT_WORKER_INVALID", "Document content metadata is invalid.", { status: 400 });
    }
    const spec = validateIntegrationFileSpec({
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
      filename: input.filename,
      mime: input.mime,
      bytes: input.bytes,
      sha256: input.sha256,
    });
    const request = Object.freeze({
      schemaVersion: INTEGRATION_DOCUMENT_WORKER_CONTENT_REQUEST_SCHEMA_VERSION,
      scope,
      ref: normalizeWorkerRef(input.ref),
      receiptDigest: input.receiptDigest,
      metadataOnly: input.metadataOnly,
      ...(input.range === undefined ? {} : { range: normalizeRange(input.range) }),
    });
    const abort = requestAbort(normalizeSignal(optionsValue.signal), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}${INTEGRATION_DOCUMENT_WORKER_ROUTES.content}`, {
        method: "POST",
        headers: requestHeaders("application/pdf, application/x-tex, text/x-tex, application/json"),
        body: requestBody(request),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      });
      if ([404, 410, 416].includes(response.status)) {
        const code = await workerError(response, abort.signal);
        abort.cleanup();
        return Object.freeze({ status: response.status, workerCode: code });
      }
      if (response.status !== (request.range === undefined ? 200 : 206)) {
        if (Object.values(ERROR_STATUS).includes(response.status)) {
          const code = await workerError(response, abort.signal);
          throw translateWorkerCode(code, response.status);
        }
        discardBody(response, new Error("unexpected document worker content status"));
        fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker content status is invalid.", { status: 502 });
      }
      const selected = parseContentHeaders(response, request, spec);
      if (request.metadataOnly) {
        discardBody(response, new Error("metadata-only response complete"));
        abort.cleanup();
        return Object.freeze({
          status: response.status,
          ...selected,
          totalBytes: spec.bytes,
          filename: spec.filename,
          mime: spec.mime,
          sha256: spec.sha256,
          metadataOnly: true,
          body: null,
          cleanup() {},
        });
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        fail("DOCUMENT_WORKER_PROTOCOL_INVALID", "Document worker content stream is unavailable.", { status: 502 });
      }
      return Object.freeze({
        status: response.status,
        ...selected,
        totalBytes: spec.bytes,
        filename: spec.filename,
        mime: spec.mime,
        sha256: spec.sha256,
        metadataOnly: false,
        body: response.body,
        cleanup: abort.cleanup,
      });
    } catch (error) {
      abort.cleanup();
      if (error instanceof IntegrationDocumentWorkerError) throw error;
      if (optionsValue.signal?.aborted) {
        fail("ANALYSIS_CANCELLED", "Document content request was cancelled.", { status: 499, cause: error });
      }
      fail("ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE", "The private workstation document worker is unavailable.", {
        status: 503,
        cause: error,
      });
    }
  }

  async function deleteObjects(scopeValue, inputValue, optionsValue = {}) {
    const scope = normalizeScope(scopeValue, { includeRun: false });
    const input = exactObject(
      inputValue,
      ["deletionId", "phase", "objects"],
      ["deletionId", "phase", "objects"],
      "document deletion input",
      { code: "DOCUMENT_WORKER_INVALID", status: 400 }
    );
    if (!DELETION_ID.test(input.deletionId) || !new Set(["prepare", "commit", "status"]).has(input.phase)) {
      fail("DOCUMENT_WORKER_INVALID", "Document deletion identity is invalid.", { status: 400 });
    }
    const request = Object.freeze({
      schemaVersion: INTEGRATION_DOCUMENT_WORKER_DELETE_REQUEST_SCHEMA_VERSION,
      deletionId: input.deletionId,
      phase: input.phase,
      scope,
      objects: normalizeDeleteObjects(input.objects),
    });
    const abort = requestAbort(normalizeSignal(optionsValue.signal), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}${INTEGRATION_DOCUMENT_WORKER_ROUTES.delete}`, {
        method: "POST",
        headers: requestHeaders(),
        body: requestBody(request),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      });
      if (response.status !== 200) {
        const code = await workerError(response, abort.signal);
        throw translateWorkerCode(code, response.status);
      }
      return validateDeleteResponse(await readJsonResponse(response, abort.signal), request);
    } catch (error) {
      if (error instanceof IntegrationDocumentWorkerError) throw error;
      if (optionsValue.signal?.aborted) {
        fail("ANALYSIS_CANCELLED", "Document deletion was cancelled.", { status: 499, cause: error });
      }
      fail("ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE", "The private workstation document worker is unavailable.", {
        status: 503,
        cause: error,
      });
    } finally {
      abort.cleanup();
    }
  }

  const attestationUnsigned = Object.freeze({
    schemaVersion: INTEGRATION_DOCUMENT_WORKER_SCHEMA_VERSION,
    owner: "aginti",
    authority: "cloud-document-broker",
    transport: testOnly ? "test-only-injected-fetch" : "fixed-private-loopback-fetch",
    testOnly,
    endpointDigest: contractDigest({ endpoint }),
    credentialRequired: true,
    callerSelectableEndpoint: false,
    compileResponseMetadataOnly: true,
    contentStreamsWithoutBuffering: true,
    twoPhaseDelete: true,
    timeoutMs,
  });
  const attestation = Object.freeze({ ...attestationUnsigned, digest: contractDigest(attestationUnsigned) });
  const client = Object.freeze({
    attestation,
    activate,
    compile,
    commitArtifacts,
    content,
    deleteObjects,
    get ready() {
      return activation !== null;
    },
  });
  CLIENT_BRAND.add(client);
  CLIENT_METADATA.set(client, Object.freeze({ testOnly }));
  return client;
}

export function assertIntegrationDocumentWorkerClient(value, { allowTestOnly = false } = {}) {
  if (!value || !CLIENT_BRAND.has(value)) throw new TypeError("document worker client is not AgInTi-owned");
  if (!allowTestOnly && CLIENT_METADATA.get(value)?.testOnly) {
    throw new TypeError("test-only document worker client is not production-capable");
  }
  return value;
}

export function assertIntegrationDocumentWorkerActivation(value, { client, allowTestOnly = false } = {}) {
  const metadata = value && ACTIVATION_METADATA.get(value);
  if (!metadata || !Object.isFrozen(value)) throw new TypeError("document worker activation is not AgInTi-owned");
  if (!allowTestOnly && metadata.testOnly) throw new TypeError("document worker activation is test-only");
  if (client !== undefined && metadata.client !== assertIntegrationDocumentWorkerClient(client, { allowTestOnly })) {
    throw new TypeError("document worker activation belongs to another client");
  }
  const { digest, ...unsigned } = value;
  if (
    value.schemaVersion !== INTEGRATION_DOCUMENT_WORKER_ACTIVATION_SCHEMA_VERSION ||
    value.owner !== "aginti" ||
    value.authority !== "workstation-document-worker" ||
    value.ready !== true ||
    typeof value.creationEnabled !== "boolean" ||
    value.additive !== true ||
    (value.creationEnabled
      ? (!DIGEST.test(value.compilerDigest) || !DIGEST.test(value.activationProbeDigest))
      : (value.compilerDigest !== undefined || value.activationProbeDigest !== undefined)) ||
    digest !== contractDigest(unsigned)
  ) {
    throw new TypeError("document worker activation identity is invalid");
  }
  return value;
}

export function createIntegrationDocumentWorkerClient(value = {}) {
  return createClient(value, { testOnly: false });
}

export function createTestOnlyIntegrationDocumentWorkerClient(value = {}) {
  return createClient(value, { testOnly: true });
}
