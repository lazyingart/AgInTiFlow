import express from "express";
import crypto from "node:crypto";
import { isUtf8 } from "node:buffer";
import { types as utilTypes } from "node:util";
import {
  INTEGRATION_IDEMPOTENCY_HEADER,
  createIntegrationAuthMiddleware,
  integrationClientCanUsePath,
  requestHasIntegrationHeader,
  requestSingleIntegrationHeader,
  writeIntegrationErrorJson,
} from "./integration-auth.js";
import {
  AGENT_WORKER_SCHEMA_VERSION,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_BYTES_LIMIT,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_RECEIVE_TIMEOUT_MS,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BYTES_LIMIT,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_COUNT_LIMIT,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_MEDIA_TYPES,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT,
  INTEGRATION_ANALYSIS_ORDINARY_BODY_RECEIVE_TIMEOUT_MS,
  INTEGRATION_API_PREFIX,
  INTEGRATION_ARTIFACT_KINDS,
  INTEGRATION_MAXIMUM_SEARCH_SOURCES,
  INTEGRATION_RPC_PATHS,
  INTEGRATION_SEARCH_ARTIFACT_KIND,
  INTEGRATION_SEARCH_MODES,
  INTEGRATION_RPC_PATH_LIST,
  INTEGRATION_RUN_STATUSES,
  INTEGRATION_THREAD_STATUSES,
  IntegrationValidationError,
  assertFixedIntegrationPolicy,
  buildFixedIntegrationPolicy,
  canonicalJson,
  contractDigest,
  integrationBoundedInteger,
  integrationBoundedText,
  integrationCapabilitiesResponse,
  integrationExactKeys,
  integrationInvalid,
  integrationRpcPathIsMutation,
  sanitizeIntegrationRequest,
  validateIntegrationBrowserSessionBinding,
  validateIntegrationArtifactId,
  validateIntegrationIdempotencyKey,
  validateIntegrationIsolationAttestation,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";
import {
  buildIntegrationArtifacts,
  findIntegrationArtifact,
  sanitizeIntegrationArtifact,
  validateIntegrationFileSpec,
} from "./integration-artifacts.js";
import {
  assertPublicIntegrationEventLedger,
  assertPublicIntegrationRunCursorMatchesLedger,
  validatePublicIntegrationEvent,
  writeIntegrationEventStream,
} from "./integration-events.js";
import {
  INTEGRATION_ANALYSIS_ATTACHMENT_AUTHORITY_SCHEMA_VERSION,
  INTEGRATION_ANALYSIS_STARTUP_RECOVERY_SCHEMA_VERSION,
  assertIntegrationAnalysisSessionService,
} from "./integration-analysis-session-service.js";
import {
  INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_KEYS,
  INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION,
  integrationAnalysisPriorArtifactAuthorityMatches,
} from "./integration-analysis-session-contract.js";
import {
  INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES,
  INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
  INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
} from "./integration-analysis-state-persistence.js";
import {
  IDEMPOTENCY_STARTUP_RECOVERY_SCHEMA_VERSION,
  assertFileIntegrationIdempotencyStore,
} from "./integration-idempotency-store.js";
import { redactSensitiveText } from "./redaction.js";

export const INTEGRATION_SERVICE_METHODS = Object.freeze({
  [INTEGRATION_RPC_PATHS.threadsList]: "listThreads",
  [INTEGRATION_RPC_PATHS.threadsCreate]: "createThread",
  [INTEGRATION_RPC_PATHS.threadsGet]: "getThread",
  [INTEGRATION_RPC_PATHS.threadsUpdate]: "updateThread",
  [INTEGRATION_RPC_PATHS.threadsDelete]: "deleteThread",
  [INTEGRATION_RPC_PATHS.runsStart]: "startRun",
  [INTEGRATION_RPC_PATHS.runsStatus]: "getRunStatus",
  [INTEGRATION_RPC_PATHS.runsEvents]: "loadRunEvents",
  [INTEGRATION_RPC_PATHS.runsCancel]: "cancelRun",
  [INTEGRATION_RPC_PATHS.runsResume]: "resumeRun",
  [INTEGRATION_RPC_PATHS.artifactsList]: "listArtifacts",
  [INTEGRATION_RPC_PATHS.artifactsGet]: "getArtifact",
  [INTEGRATION_RPC_PATHS.artifactsContent]: "getArtifactContent",
});

const ZERO_DIGEST = "0".repeat(64);
export const INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION = "aginti-transactional-idempotency-v1";
export const INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM = "canonical-json-v1";
const INTEGRATION_IDEMPOTENCY_RESPONSE_ENVELOPE = "aginti-agent-rpc-v1";
export const INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
export const INTEGRATION_PUBLIC_JSON_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const INTEGRATION_ANALYSIS_MAX_CONCURRENT_ATTACHMENT_REQUESTS = 1;
export const INTEGRATION_ANALYSIS_ROUTER_ACTIVATION_SCHEMA_VERSION =
  "aginti-integration-analysis-router-activation-v4";
export const INTEGRATION_ANALYSIS_MUTATION_RECOVERY_SCHEMA_VERSION =
  "aginti-analysis-mutation-recovery-v1";
export const INTEGRATION_ANALYSIS_PRELISTEN_RECOVERY_SCHEMA_VERSION =
  "aginti-integration-analysis-prelisten-recovery-v1";
const INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION = "aginti-integration-analysis-coordinator-v1";
const ANALYSIS_ROUTER_ACTIVATIONS = new WeakMap();
const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s("'`<>\[{=])(?:file:\/\/\/[^\s"'`<>)\]}]+|\/(?!\/)[^\s"'`<>)\]}]+|[A-Za-z]:[\\/][^\s"'`<>)\]}]+|\\\\[^\\/\s"'`<>)\]}]+\\[^\s"'`<>)\]}]+)/giu;

class IntegrationApiError extends Error {
  constructor(code, message, { status = 500, details = {} } = {}) {
    super(message);
    this.name = "IntegrationApiError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

function redactPublicText(value) {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, (match) => {
    const prefix = /^[\s("'`<>\[{=]/u.test(match) ? match[0] : "";
    return `${prefix}[REDACTED_PATH]`;
  });
}

function errorStatus(error) {
  return Number(error?.statusCode || error?.status) || 500;
}

function errorCode(error) {
  const raw = String(error?.publicCode || error?.code || "");
  if (/^[A-Z0-9_]{1,80}$/u.test(raw)) return raw;
  return errorStatus(error) >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST";
}

function sendJson(res, status, value) {
  if (res.headersSent || res.writableEnded) return;
  if (status >= 200 && status < 300) assertPublicJsonResponseBytes(value, "Agent RPC response");
  res.status(status);
  res.set({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.json(value);
}

function sendError(res, error) {
  writeIntegrationErrorJson(res, errorStatus(error), errorCode(error));
}

function contentDisposition(filename) {
  const fallback = String(filename || "artifact")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 120) || "artifact";
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (character) =>
    `%${character.codePointAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function writeIntegrationArtifactContentResponse(res, result, { rangeRequested = false } = {}) {
  const body = result?.body;
  let spec;
  try {
    spec = validateIntegrationFileSpec({
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
      filename: result.filename,
      mime: result.mime,
      bytes: result.totalBytes,
      sha256: result.sha256,
    });
    validateIntegrationArtifactId(result.artifactId);
  } catch {
    throw new IntegrationApiError("INTERNAL_ERROR", "Artifact content response is invalid.", { status: 500 });
  }
  if (
    result.schemaVersion !== "aginti-artifact-content-v1" ||
    typeof rangeRequested !== "boolean" ||
    typeof result.metadataOnly !== "boolean" ||
    typeof result.partial !== "boolean" ||
    (result.metadataOnly && body !== null) ||
    (!result.metadataOnly && (!body || typeof body.getReader !== "function")) ||
    typeof result.cleanup !== "function"
  ) {
    throw new IntegrationApiError("INTERNAL_ERROR", "Artifact content response is invalid.", { status: 500 });
  }
  const selectedBytes = result.end - result.start + 1;
  if (
    !Number.isSafeInteger(result.start) ||
    !Number.isSafeInteger(result.end) ||
    result.start < 0 ||
    result.end < result.start ||
    !Number.isSafeInteger(selectedBytes) ||
    selectedBytes < 1 ||
    selectedBytes > spec.bytes ||
    result.end >= spec.bytes ||
    result.partial !== (result.start !== 0 || result.end !== spec.bytes - 1) ||
    (!rangeRequested && result.partial)
  ) {
    throw new IntegrationApiError("INTERNAL_ERROR", "Artifact content range is invalid.", { status: 500 });
  }
  res.status(rangeRequested ? 206 : 200);
  res.set({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store, private",
    "Content-Disposition": contentDisposition(result.filename),
    "Content-Length": result.metadataOnly ? "0" : String(selectedBytes),
    "Content-Type": result.mime,
    ETag: `"${result.sha256}"`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...(result.metadataOnly ? { "X-Artifact-Content-Length": String(selectedBytes) } : {}),
    ...(rangeRequested
      ? { "Content-Range": `bytes ${result.start}-${result.end}/${result.totalBytes}` }
      : {}),
  });
  if (result.metadataOnly) {
    try {
      res.end();
    } finally {
      result.cleanup();
    }
    return;
  }
  const reader = body.getReader();
  let sent = 0;
  let complete = false;
  const hash = rangeRequested ? null : crypto.createHash("sha256");
  const cancel = () => {
    if (!complete) Promise.resolve(reader.cancel(new Error("artifact response closed"))).catch(() => {});
  };
  res.once("close", cancel);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength < 1) {
        throw new IntegrationApiError("INTERNAL_ERROR", "Artifact content stream is invalid.", { status: 500 });
      }
      sent += chunk.value.byteLength;
      if (sent > selectedBytes) {
        throw new IntegrationApiError("INTERNAL_ERROR", "Artifact content stream exceeded its bound.", { status: 500 });
      }
      const bytes = Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
      hash?.update(bytes);
      if (!res.write(bytes)) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            res.off("drain", onDrain);
            res.off("close", onClose);
            res.off("error", onError);
          };
          const onDrain = () => { cleanup(); resolve(); };
          const onClose = () => { cleanup(); reject(new Error("artifact response closed")); };
          const onError = (error) => { cleanup(); reject(error); };
          res.once("drain", onDrain);
          res.once("close", onClose);
          res.once("error", onError);
        });
      }
    }
    if (sent !== selectedBytes || (hash && hash.digest("hex") !== spec.sha256)) {
      throw new IntegrationApiError("INTERNAL_ERROR", "Artifact content stream failed integrity validation.", {
        status: 500,
      });
    }
    complete = true;
    res.end();
  } catch (error) {
    res.destroy?.(error);
    throw error;
  } finally {
    res.off("close", cancel);
    if (!complete) await reader.cancel(new Error("artifact stream incomplete")).catch(() => {});
    reader.releaseLock?.();
    result.cleanup();
  }
}

function methodForPath(pathname) {
  return INTEGRATION_SERVICE_METHODS[pathname] || "";
}

function missingServiceMethods(sessionService = {}) {
  return Object.entries(INTEGRATION_SERVICE_METHODS)
    .filter(([, method]) => typeof sessionService?.[method] !== "function")
    .map(([pathname, method]) => ({ pathname, method }));
}

function safeTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const timestamp = integrationBoundedText(value, label, 40, { minimum: 20 });
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    integrationInvalid(`${label} must be a canonical UTC ISO timestamp`);
  }
  return timestamp;
}

function safeDigest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) integrationInvalid(`${label} is invalid`);
  return value;
}

function safeRunStatus(value) {
  const status = String(value || "");
  if (!INTEGRATION_RUN_STATUSES.includes(status)) integrationInvalid("run status is invalid");
  return status;
}

function safeThreadStatus(value) {
  const status = String(value || "");
  if (!INTEGRATION_THREAD_STATUSES.includes(status)) integrationInvalid("thread status is invalid");
  return status;
}

function assertOwned(value = {}, principalId = "", label = "Object", browserSessionId = "") {
  const owner = String(value?.principalId ?? value?.ownerPrincipalId ?? "");
  if (!owner || owner !== principalId) {
    throw new IntegrationApiError("NOT_FOUND", `${label} was not found.`, { status: 404 });
  }
  validateIntegrationBrowserSessionBinding(value, { browserSessionId }, { label, requireBound: true });
}

function assertMatchingResourceId(actual, expected, label) {
  if (expected && actual !== expected) {
    throw new IntegrationApiError("NOT_FOUND", `${label} was not found.`, { status: 404 });
  }
}

function isOwned(value = {}, principalId = "", browserSessionId = "") {
  try {
    assertOwned(value, principalId, "Object", browserSessionId);
    return true;
  } catch {
    return false;
  }
}

function publicJsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertPublicJsonResponseBytes(value, label = "Agent RPC response") {
  const bytes = publicJsonByteLength(value);
  if (bytes >= INTEGRATION_PUBLIC_JSON_RESPONSE_MAX_BYTES) {
    throw new IntegrationApiError("PUBLIC_RESPONSE_TOO_LARGE", `${label} exceeds the public response byte limit.`, {
      status: 503,
      details: { bytes, maxBytesExclusive: INTEGRATION_PUBLIC_JSON_RESPONSE_MAX_BYTES },
    });
  }
  return value;
}

function publicLabel(value, label, maximum, { redact = true } = {}) {
  const text = integrationBoundedText(redact ? redactPublicText(value) : value, label, maximum, {
    minimum: 1,
    presentational: true,
  }).trim();
  if (!text) integrationInvalid(`${label} must contain a non-whitespace character`);
  return text;
}

function publicMessageAttachments(value, messageIndex, role) {
  if (value === undefined) return undefined;
  if (
    role !== "user" || !Array.isArray(value) || value.length < 1 ||
    value.length > INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_COUNT_LIMIT ||
    Object.keys(value).length !== value.length
  ) {
    integrationInvalid(`thread message[${messageIndex}].attachments is invalid`);
  }
  const identifiers = new Set();
  let totalBytes = 0;
  const attachments = value.map((candidate, attachmentIndex) => {
    const label = `thread message[${messageIndex}].attachments[${attachmentIndex}]`;
    const attachment = integrationExactKeys(
      candidate,
      ["attachmentId", "mediaType", "byteLength", "width", "height", "sha256"],
      label,
      ["attachmentId", "mediaType", "byteLength", "width", "height", "sha256"]
    );
    if (
      typeof attachment.attachmentId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(attachment.attachmentId) ||
      identifiers.has(attachment.attachmentId) ||
      !INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_MEDIA_TYPES.includes(attachment.mediaType)
    ) {
      integrationInvalid(`${label} identity or media type is invalid`);
    }
    const byteLength = integrationBoundedInteger(attachment.byteLength, `${label}.byteLength`, {
      minimum: 16,
      maximum: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BYTES_LIMIT,
    });
    const width = integrationBoundedInteger(attachment.width, `${label}.width`, { minimum: 1, maximum: 8192 });
    const height = integrationBoundedInteger(attachment.height, `${label}.height`, { minimum: 1, maximum: 8192 });
    if (width * height > 20_000_000) integrationInvalid(`${label} pixel count is invalid`);
    const sha256 = safeDigest(attachment.sha256, `${label}.sha256`);
    identifiers.add(attachment.attachmentId);
    totalBytes += byteLength;
    if (totalBytes > INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT) {
      integrationInvalid(`thread message[${messageIndex}].attachments exceed their total byte bound`);
    }
    return Object.freeze({
      attachmentId: attachment.attachmentId,
      mediaType: attachment.mediaType,
      byteLength,
      width,
      height,
      sha256,
    });
  });
  return Object.freeze(attachments);
}

function publicMessage(value = {}, index) {
  const message = integrationExactKeys(value, ["id", "role", "content", "runId", "createdAt", "digest", "attachments"], `thread message[${index}]`, [
    "id",
    "role",
    "content",
    "runId",
    "createdAt",
    "digest",
  ]);
  if (typeof message.id !== "string" || !/^msg_[A-Za-z0-9_-]{16,96}$/u.test(message.id)) integrationInvalid(`thread message[${index}].id is invalid`);
  if (!new Set(["user", "assistant"]).has(message.role)) integrationInvalid(`thread message[${index}].role is invalid`);
  const attachments = publicMessageAttachments(message.attachments, index, message.role);
  return Object.freeze({
    id: message.id,
    role: message.role,
    content: integrationBoundedText(redactPublicText(message.content), `thread message[${index}].content`, 32_000),
    runId: validateIntegrationRunId(message.runId),
    createdAt: safeTimestamp(message.createdAt, `thread message[${index}].createdAt`),
    digest: safeDigest(message.digest, `thread message[${index}].digest`),
    ...(attachments === undefined ? {} : { attachments }),
  });
}

export function sanitizePublicIntegrationThread(value = {}, options = {}) {
  if (options.publicContract !== true) assertOwned(value, options.principalId, "Thread", options.browserSessionId);
  const authority = value.authority || {};
  const replay = value.replay || {};
  const messages = value.messages ?? [];
  if (!Array.isArray(messages) || messages.length > 256) integrationInvalid("thread messages replay exceeds 256 entries");
  const checkedMessages = messages.map(publicMessage);
  if (checkedMessages.reduce((total, message) => total + message.content.length, 0) > 256_000) {
    integrationInvalid("thread messages replay exceeds its 256000-character bound");
  }

  let lastCompaction = null;
  if (authority.lastCompaction !== null && authority.lastCompaction !== undefined) {
    const item = integrationExactKeys(
      authority.lastCompaction,
      ["compactedMessages", "tokensBefore", "tokensAfter", "digest"],
      "thread authority lastCompaction",
      ["compactedMessages", "tokensBefore", "tokensAfter", "digest"]
    );
    lastCompaction = Object.freeze({
      compactedMessages: integrationBoundedInteger(item.compactedMessages, "lastCompaction compactedMessages", { maximum: 1_000_000 }),
      tokensBefore: integrationBoundedInteger(item.tokensBefore, "lastCompaction tokensBefore", { maximum: 10_000_000 }),
      tokensAfter: integrationBoundedInteger(item.tokensAfter, "lastCompaction tokensAfter", { maximum: 10_000_000 }),
      digest: safeDigest(item.digest, "lastCompaction digest"),
    });
  }

  if (authority.kind !== "aginti") integrationInvalid("thread authority is invalid");
  if (value.activeImageContext !== undefined && typeof value.activeImageContext !== "boolean") {
    integrationInvalid("thread activeImageContext must be a boolean");
  }
  const activeImageContext = value.activeImageContext === true;
  if (activeImageContext && (value.lastRunId === null || value.lastRunId === "" || value.lastRunId === undefined)) {
    integrationInvalid("thread activeImageContext requires lastRunId");
  }
  return Object.freeze({
    id: validateIntegrationThreadId(value.id),
    title: publicLabel(value.title, "title", 120),
    status: safeThreadStatus(value.status),
    revision: integrationBoundedInteger(value.revision, "thread revision", { minimum: 1 }),
    createdAt: safeTimestamp(value.createdAt, "thread createdAt"),
    updatedAt: safeTimestamp(value.updatedAt, "thread updatedAt"),
    lastRunId: value.lastRunId === null || value.lastRunId === "" || value.lastRunId === undefined ? null : validateIntegrationRunId(value.lastRunId),
    ...(activeImageContext ? { activeImageContext: true } : {}),
    authority: Object.freeze({
      kind: "aginti",
      mapped: Boolean(authority.mapped),
      runtimeRevision:
        authority.runtimeRevision === null || authority.runtimeRevision === undefined
          ? null
          : integrationBoundedInteger(authority.runtimeRevision, "thread authority runtimeRevision", { minimum: 1 }),
      contextDigest:
        authority.contextDigest === null || authority.contextDigest === undefined
          ? null
          : safeDigest(authority.contextDigest, "thread authority contextDigest"),
      lastCompaction,
    }),
    replay: Object.freeze({
      prunedMessageCount: integrationBoundedInteger(replay.prunedMessageCount || 0, "thread replay prunedMessageCount", {
        maximum: 10_000_000,
      }),
      anchorDigest: safeDigest(replay.anchorDigest || ZERO_DIGEST, "thread replay anchorDigest"),
    }),
    messages: Object.freeze(checkedMessages),
  });
}

export function sanitizePublicIntegrationRun(value = {}, options = {}) {
  if (options.publicContract !== true) assertOwned(value, options.principalId, "Run", options.browserSessionId);
  const authority = value.authority || {};
  const cursor = value.eventCursor || {};
  if (authority.kind !== "aginti") integrationInvalid("run authority must be AgInTi");
  const firstSeq = integrationBoundedInteger(cursor.firstSeq ?? Number(cursor.lastSeq || 0) + 1, "run eventCursor firstSeq", {
    minimum: 1,
    maximum: 10_000_000_001,
  });
  const lastSeq = integrationBoundedInteger(cursor.lastSeq || 0, "run eventCursor lastSeq", { maximum: 10_000_000_000 });
  const prunedThroughSeq = integrationBoundedInteger(cursor.prunedThroughSeq || 0, "run eventCursor prunedThroughSeq", {
    maximum: 10_000_000_000,
  });
  const lastHash = safeDigest(cursor.lastHash || ZERO_DIGEST, "run eventCursor lastHash");
  if (firstSeq > lastSeq + 1 || prunedThroughSeq >= firstSeq) integrationInvalid("run event cursor is inconsistent");
  if (firstSeq !== 1 || prunedThroughSeq !== 0) integrationInvalid("run event cursor v1 does not support pruned ledgers");
  return Object.freeze({
    id: validateIntegrationRunId(value.id),
    threadId: validateIntegrationThreadId(value.threadId),
    previousRunId: value.previousRunId === null || value.previousRunId === "" || value.previousRunId === undefined ? null : validateIntegrationRunId(value.previousRunId),
    status: safeRunStatus(value.status),
    createdAt: safeTimestamp(value.createdAt, "run createdAt"),
    startedAt: safeTimestamp(value.startedAt, "run startedAt", { nullable: true }),
    completedAt: safeTimestamp(value.completedAt, "run completedAt", { nullable: true }),
    cancelRequestedAt: safeTimestamp(value.cancelRequestedAt, "run cancelRequestedAt", { nullable: true }),
    output: integrationBoundedText(redactPublicText(value.output || ""), "run output", 32_000),
    error: value.error
      ? Object.freeze({
          code: publicLabel(value.error.code, "run error code", 96, { redact: false }),
          message: publicLabel(value.error.message, "run error message", 600),
        })
      : null,
    authority: Object.freeze({
      kind: "aginti",
      snapshotHash:
        authority.snapshotHash === null || authority.snapshotHash === undefined
          ? null
          : safeDigest(authority.snapshotHash, "run authority snapshotHash"),
      runtimeRevision:
        authority.runtimeRevision === null || authority.runtimeRevision === undefined
          ? null
          : integrationBoundedInteger(authority.runtimeRevision, "run authority runtimeRevision", { minimum: 1 }),
      contextDigest:
        authority.contextDigest === null || authority.contextDigest === undefined
          ? null
          : safeDigest(authority.contextDigest, "run authority contextDigest"),
    }),
    eventCursor: Object.freeze({
      firstSeq,
      lastSeq,
      lastHash,
      prunedThroughSeq,
    }),
  });
}

function threadResponse(thread, principalId, browserSessionId, expectedThreadId = "") {
  const publicThread = sanitizePublicIntegrationThread(thread, { principalId, browserSessionId });
  assertMatchingResourceId(publicThread.id, expectedThreadId, "Thread");
  return Object.freeze({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    thread: publicThread,
  });
}

function runResponse(run, principalId, browserSessionId, expectedRunId = "") {
  const publicRun = sanitizePublicIntegrationRun(run, { principalId, browserSessionId });
  assertMatchingResourceId(publicRun.id, expectedRunId, "Run");
  return Object.freeze({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    run: publicRun,
  });
}

function publicArtifactInput(artifact = {}) {
  return {
    ...(artifact.id === undefined ? {} : { id: artifact.id }),
    ...(artifact.title === undefined ? {} : { title: artifact.title }),
    ...(artifact.kind === undefined ? {} : { kind: artifact.kind }),
    ...(artifact.type === undefined ? {} : { type: artifact.type }),
    ...(artifact.spec === undefined ? {} : { spec: artifact.spec }),
    ...(artifact.markdown === undefined ? {} : { markdown: artifact.markdown }),
    ...(artifact.content === undefined ? {} : { content: artifact.content }),
    ...(artifact.columns === undefined ? {} : { columns: artifact.columns }),
    ...(artifact.rows === undefined ? {} : { rows: artifact.rows }),
    ...(artifact.table === undefined ? {} : { table: artifact.table }),
    ...(artifact.plot === undefined ? {} : { plot: artifact.plot }),
  };
}

function artifactBelongsToRequest(artifact = {}, payload = {}) {
  if (payload.threadId) {
    return String(artifact.threadId || artifact.ownerThreadId || "") === payload.threadId;
  }
  if (payload.runId) {
    return String(artifact.runId || artifact.ownerRunId || "") === payload.runId;
  }
  return false;
}

export function projectPublicIntegrationResponse(pathname, result = {}, payload = {}, context = {}) {
  const principalId = context.principal.id;
  const browserSessionId = context.browserSession.id;
  switch (pathname) {
    case INTEGRATION_RPC_PATHS.threadsList: {
      const ownedThreads = (result.threads || [])
        .filter((thread) => isOwned(thread, principalId, browserSessionId))
        .slice(0, payload.limit || 50)
        .map((thread) => sanitizePublicIntegrationThread(thread, { principalId, browserSessionId }));
      const ownedThreadIds = new Set(ownedThreads.map((thread) => thread.id));
      return assertPublicJsonResponseBytes(Object.freeze({
        schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
        threads: Object.freeze(ownedThreads),
        nextBefore:
          result.nextBefore === null || result.nextBefore === undefined || result.nextBefore === ""
            ? null
            : ownedThreadIds.has(result.nextBefore)
              ? validateIntegrationThreadId(result.nextBefore)
              : null,
      }), "thread list response");
    }
    case INTEGRATION_RPC_PATHS.threadsCreate:
      return threadResponse(result.thread, principalId, browserSessionId);
    case INTEGRATION_RPC_PATHS.threadsGet:
    case INTEGRATION_RPC_PATHS.threadsUpdate:
      return threadResponse(result.thread, principalId, browserSessionId, payload.threadId);
    case INTEGRATION_RPC_PATHS.threadsDelete:
      assertOwned(result.thread || result, principalId, "Thread", browserSessionId);
      assertMatchingResourceId(result.thread?.id || result.threadId, payload.threadId, "Thread");
      return Object.freeze({
        schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
        deleted: true,
        threadId: validateIntegrationThreadId(payload.threadId),
      });
    case INTEGRATION_RPC_PATHS.runsStart:
      {
        const response = runResponse(result.run, principalId, browserSessionId);
        assertMatchingResourceId(response.run.threadId, payload.threadId, "Run");
        return response;
      }
    case INTEGRATION_RPC_PATHS.runsStatus:
    case INTEGRATION_RPC_PATHS.runsCancel:
      return runResponse(result.run, principalId, browserSessionId, payload.runId);
    case INTEGRATION_RPC_PATHS.runsResume:
      {
        const response = runResponse(result.run, principalId, browserSessionId);
        assertMatchingResourceId(response.run.previousRunId, payload.runId, "Run");
        return response;
      }
    case INTEGRATION_RPC_PATHS.artifactsList:
      return buildIntegrationArtifacts({
        artifacts: (result.artifacts || [])
          .filter((artifact) => isOwned(artifact, principalId, browserSessionId))
          .filter((artifact) => artifactBelongsToRequest(artifact, payload))
          .map(publicArtifactInput),
      });
    case INTEGRATION_RPC_PATHS.artifactsGet: {
      let candidate;
      if (result.artifact) {
        assertOwned(result.artifact, principalId, "Artifact", browserSessionId);
        candidate = publicArtifactInput(result.artifact);
      } else {
        const ownedArtifacts = (result.artifacts || [])
          .filter((artifact) => isOwned(artifact, principalId, browserSessionId))
          .map(publicArtifactInput);
        candidate = findIntegrationArtifact(ownedArtifacts, payload.artifactId);
      }
      assertMatchingResourceId(sanitizeIntegrationArtifact(candidate).id, payload.artifactId, "Artifact");
      return Object.freeze({
        schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
        artifact: sanitizeIntegrationArtifact(candidate),
      });
    }
    default:
      throw new IntegrationApiError("NOT_FOUND", "Agent RPC not found.", { status: 404 });
  }
}

function requestHash(pathname, principalId, browserSessionId, payload) {
  return contractDigest({
    algorithm: INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
    principalId,
    browserSessionId,
    operation: pathname,
    request: payload,
  });
}

function idempotencyKeyDigest(idempotencyKey) {
  return crypto.createHash("sha256").update(String(idempotencyKey), "utf8").digest("hex");
}

export function assertIntegrationTransactionalIdempotencyStore(store = {}) {
  const windowMs = Number(store?.idempotencyWindowMs ?? 0);
  const recovery = store?.recoveryAuthority || {};
  const expectedRecoveryDigest = contractDigest({
    schemaVersion: recovery.schemaVersion,
    owner: recovery.owner,
    explicit: recovery.explicit,
    blindRedispatch: recovery.blindRedispatch,
    beforeDispatchRecovery: recovery.beforeDispatchRecovery,
    afterDispatchBeforeResultRecovery: recovery.afterDispatchBeforeResultRecovery,
    afterResultBeforePublicResponseRecovery: recovery.afterResultBeforePublicResponseRecovery,
  });
  if (
    !store ||
    typeof store !== "object" ||
    store.owner !== "aginti" ||
    store.contractVersion !== INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION ||
    store.durable !== true ||
    store.crossProcessSafe !== true ||
    store.atomicLookupAndDispatch !== true ||
    store.atomicClaim !== true ||
    store.atomicComplete !== true ||
    store.failOrRecoverOnHandlerError !== true ||
    store.noStrandedPendingOnHandlerError !== true ||
    store.requestHashBound !== true ||
    store.principalBound !== true ||
    store.browserSessionBound !== true ||
    store.sameKeySameRequestReplays !== true ||
    store.sameKeyDifferentRequestStatus !== 409 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1 ||
    windowMs > INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS ||
    store.testOnly === true ||
    store.requestHashAlgorithm !== INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM ||
    store.responseEnvelope !== INTEGRATION_IDEMPOTENCY_RESPONSE_ENVELOPE ||
    recovery.schemaVersion !== "aginti-integration-idempotency-recovery-authority-v1" ||
    recovery.owner !== "aginti" ||
    recovery.explicit !== true ||
    recovery.blindRedispatch !== false ||
    recovery.beforeDispatchRecovery !== true ||
    recovery.afterDispatchBeforeResultRecovery !== true ||
    recovery.afterResultBeforePublicResponseRecovery !== true ||
    recovery.digest !== expectedRecoveryDigest ||
    typeof store.runMutation !== "function"
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Transactional AgInTi idempotency is unavailable.", {
      status: 503,
    });
  }
  return store;
}

function idempotencyReady(store = {}) {
  try {
    assertIntegrationTransactionalIdempotencyStore(store);
    return true;
  } catch {
    return false;
  }
}

function plainDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataObject(value, allowedKeys, requiredKeys, label, { frozen = false } = {}) {
  if (!plainDataObject(value) || (frozen && !Object.isFrozen(value))) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", `${label} is unavailable.`, { status: 503 });
  }
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      throw new IntegrationApiError("AGENT_UNAVAILABLE", `${label} is unavailable.`, { status: 503 });
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new IntegrationApiError("AGENT_UNAVAILABLE", `${label} is unavailable.`, { status: 503 });
    }
  }
  return value;
}

function digestField(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", `${label} is unavailable.`, { status: 503 });
  }
  return value;
}

function assertCanonicalProofDigest(proof, label) {
  const unsigned = {};
  for (const key of Object.keys(proof)) {
    if (key !== "digest") unsigned[key] = proof[key];
  }
  if (digestField(proof.digest, `${label} digest`) !== contractDigest(unsigned)) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", `${label} is unavailable.`, { status: 503 });
  }
  return proof;
}

function assertAnalysisStartupProof(value) {
  const keys = [
    "schemaVersion",
    "ready",
    "publicActivationReady",
    "workerCapabilityDigest",
    "workerHealthDigest",
    "coordinatorProtocolDigest",
    "coordinatorHealthDigest",
    "runtimeProfile",
    "runtimeBundleRootDigest",
    "seccompPolicyDigest",
    "cgroupPolicyDigest",
    "digest",
  ];
  const proof = exactDataObject(value, keys, keys, "analysis startup proof", { frozen: true });
  if (
    proof.schemaVersion !== INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION ||
    proof.ready !== true ||
    proof.publicActivationReady !== true ||
    typeof proof.runtimeProfile !== "string" ||
    !/^[A-Za-z0-9._+~-]{1,192}$/u.test(proof.runtimeProfile)
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis startup proof is unavailable.", { status: 503 });
  }
  for (const key of [
    "workerCapabilityDigest",
    "workerHealthDigest",
    "coordinatorProtocolDigest",
    "coordinatorHealthDigest",
    "runtimeBundleRootDigest",
    "seccompPolicyDigest",
    "cgroupPolicyDigest",
  ]) {
    digestField(proof[key], `analysis startup proof ${key}`);
  }
  return assertCanonicalProofDigest(proof, "analysis startup proof");
}

function assertAnalysisMutationRecoveryAuthority(value) {
  const keys = [
    "schemaVersion",
    "owner",
    "durable",
    "atomicWithMutation",
    "principalBound",
    "browserSessionBound",
    "pathnameBound",
    "requestHashBound",
    "idempotencyKeyDigestBound",
    "blindRedispatch",
    "exactPublicResponse",
    "digest",
  ];
  const proof = exactDataObject(value, keys, keys, "analysis mutation recovery authority", { frozen: true });
  if (
    proof.schemaVersion !== INTEGRATION_ANALYSIS_MUTATION_RECOVERY_SCHEMA_VERSION ||
    proof.owner !== "aginti" ||
    proof.durable !== true ||
    proof.atomicWithMutation !== true ||
    proof.principalBound !== true ||
    proof.browserSessionBound !== true ||
    proof.pathnameBound !== true ||
    proof.requestHashBound !== true ||
    proof.idempotencyKeyDigestBound !== true ||
    proof.blindRedispatch !== false ||
    proof.exactPublicResponse !== true
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis mutation recovery authority is unavailable.", {
      status: 503,
    });
  }
  return assertCanonicalProofDigest(proof, "analysis mutation recovery authority");
}

function assertAnalysisPrelistenRecoveryProof(value, sessionService, idempotencyStore) {
  let stateRecovery;
  let idempotencyRecovery;
  try {
    stateRecovery = sessionService.getStartupRecoveryProof();
    idempotencyRecovery = idempotencyStore.getStartupRecoveryProof();
  } catch (error) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Startup recovery proof is unavailable.", {
      status: 503,
      cause: error,
    });
  }
  const keys = [
    "schemaVersion", "owner", "beforeListen", "listenerCreatedBeforeRecovery",
    "statePersistenceMode", "stateRecovery", "idempotencyRecovery", "bounded", "timeoutMs", "digest",
  ];
  const proof = exactDataObject(value, keys, keys, "analysis pre-listen recovery proof", { frozen: true });
  const stateKeys = [
    "schemaVersion", "owner", "beforeListen", "performed", "statePersistenceMode", "scopeCount",
    "nonterminalRunsObserved", "nonterminalRunsRecovered", "nonterminalRunsRemaining",
    "deferredOptionalDocumentRuns", "pendingDocumentIntentsObserved", "recoveryScopeDigests", "bounded", "timeoutMs", "digest",
  ];
  const state = exactDataObject(
    proof.stateRecovery,
    stateKeys,
    stateKeys,
    "analysis state startup recovery proof",
    { frozen: true }
  );
  const idempotencyKeys = [
    "schemaVersion", "owner", "beforeListen", "pendingObserved", "pendingRecovered",
    "pendingRemaining", "stagesObserved", "recoveredIndexesDigest", "bounded", "timeoutMs", "digest",
  ];
  const idempotency = exactDataObject(
    proof.idempotencyRecovery,
    idempotencyKeys,
    idempotencyKeys,
    "analysis idempotency startup recovery proof",
    { frozen: true }
  );
  const native = proof.statePersistenceMode === INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3;
  const compatible =
    proof.statePersistenceMode === INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2;
  if (
    proof.schemaVersion !== INTEGRATION_ANALYSIS_PRELISTEN_RECOVERY_SCHEMA_VERSION ||
    proof.owner !== "aginti" || proof.beforeListen !== true ||
    proof.listenerCreatedBeforeRecovery !== false || (!native && !compatible) || proof.bounded !== true ||
    !Number.isSafeInteger(proof.timeoutMs) || proof.timeoutMs < 100 || proof.timeoutMs > 300_000 ||
    state !== stateRecovery || idempotency !== idempotencyRecovery ||
    state.schemaVersion !== INTEGRATION_ANALYSIS_STARTUP_RECOVERY_SCHEMA_VERSION ||
    state.owner !== "aginti" || state.beforeListen !== true || state.bounded !== true ||
    state.statePersistenceMode !== proof.statePersistenceMode ||
    state.performed !== native ||
    (native
      ? (!Number.isSafeInteger(state.scopeCount) || state.scopeCount < 0 ||
        !Number.isSafeInteger(state.nonterminalRunsObserved) || state.nonterminalRunsObserved < 0 ||
        !Number.isSafeInteger(state.nonterminalRunsRecovered) || state.nonterminalRunsRecovered < 0 ||
        !Number.isSafeInteger(state.deferredOptionalDocumentRuns) ||
        state.deferredOptionalDocumentRuns < 0 ||
        state.nonterminalRunsRecovered + state.deferredOptionalDocumentRuns !== state.nonterminalRunsObserved ||
        state.nonterminalRunsRemaining !== state.deferredOptionalDocumentRuns ||
        !Number.isSafeInteger(state.pendingDocumentIntentsObserved) ||
        state.pendingDocumentIntentsObserved < 0)
      : (state.scopeCount !== null || state.nonterminalRunsObserved !== null ||
        state.nonterminalRunsRecovered !== 0 || state.nonterminalRunsRemaining !== null ||
        state.deferredOptionalDocumentRuns !== null ||
        state.pendingDocumentIntentsObserved !== null)) ||
    !Array.isArray(state.recoveryScopeDigests) || !Object.isFrozen(state.recoveryScopeDigests) ||
    state.recoveryScopeDigests.some((digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) ||
    new Set(state.recoveryScopeDigests).size !== state.recoveryScopeDigests.length ||
    [...state.recoveryScopeDigests].sort().some((digest, index) => digest !== state.recoveryScopeDigests[index]) ||
    !Number.isSafeInteger(state.timeoutMs) || state.timeoutMs < 100 || state.timeoutMs > 300_000 ||
    state.digest !== contractDigest(Object.fromEntries(Object.entries(state).filter(([key]) => key !== "digest"))) ||
    idempotency.schemaVersion !== IDEMPOTENCY_STARTUP_RECOVERY_SCHEMA_VERSION ||
    idempotency.owner !== "aginti" || idempotency.beforeListen !== true || idempotency.bounded !== true ||
    !Number.isSafeInteger(idempotency.pendingObserved) || idempotency.pendingObserved < 0 ||
    !Number.isSafeInteger(idempotency.pendingRecovered) || idempotency.pendingRecovered < 0 ||
    idempotency.pendingRecovered !== idempotency.pendingObserved || idempotency.pendingRemaining !== 0 ||
    !Number.isSafeInteger(idempotency.timeoutMs) || idempotency.timeoutMs < 100 ||
    idempotency.timeoutMs > 300_000 ||
    typeof idempotency.recoveredIndexesDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(idempotency.recoveredIndexesDigest) ||
    idempotency.digest !== contractDigest(
      Object.fromEntries(Object.entries(idempotency).filter(([key]) => key !== "digest"))
    ) ||
    proof.digest !== contractDigest(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "digest")))
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Startup recovery proof is invalid.", { status: 503 });
  }
  const stageKeys = [
    "after-dispatch-before-result", "after-result-before-public-response", "before-dispatch",
  ];
  const stages = exactDataObject(
    idempotency.stagesObserved,
    stageKeys,
    stageKeys,
    "idempotency startup recovery stages",
    { frozen: true }
  );
  if (
    stageKeys.some((key) => !Number.isSafeInteger(stages[key]) || stages[key] < 0) ||
    stageKeys.reduce((total, key) => total + stages[key], 0) !== idempotency.pendingObserved
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Startup idempotency recovery proof is invalid.", {
      status: 503,
    });
  }
  return proof;
}

function assertAnalysisAttachmentAuthority(value) {
  const keys = [
    "schemaVersion", "owner", "ready", "transport", "acceptedMediaTypes", "maximumCount",
    "maximumBytesEach", "maximumBytesTotal", "maximumRetainedBlobsGlobal",
    "maximumRetainedBytesGlobal", "minimumFreeBytesAfterWrite", "requestTimeoutMs",
    "maximumConcurrentVisionRuns", "model",
    "persistence", "stateRootDigest",
    "visionActivationSchemaVersion", "visionActivationDigest", "requestHashBound",
    "idempotencyReplayBound", "principalBound", "browserSessionBound", "threadBound", "runBound",
    "orderedReferences", "privateBinaryBlobs", "publicDescriptorsContainBytes",
    "publicDescriptorsContainPaths", "atomicBlobFsyncRename", "directoryFsync",
    "exactBlobIntegrityRevalidatedBeforeInference", "exclusiveServiceLifetimeLock", "crossProcessSafe",
    "globalCapacitySerialized", "filesystemFreeSpaceCheckedBeforeAndAfterWrite",
    "orphanCleanupUnderExclusiveLock", "deletionReclaimsUnreferencedBlobs", "hostedFallback", "digest",
  ];
  const proof = exactDataObject(value, keys, keys, "analysis attachment authority", { frozen: true });
  if (
    proof.schemaVersion !== INTEGRATION_ANALYSIS_ATTACHMENT_AUTHORITY_SCHEMA_VERSION ||
    proof.owner !== "aginti" || proof.ready !== true ||
    proof.transport !== "inline-base64" ||
    canonicalJson(proof.acceptedMediaTypes) !== canonicalJson(INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_MEDIA_TYPES) ||
    proof.maximumCount !== INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_COUNT_LIMIT ||
    proof.maximumBytesEach !== INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BYTES_LIMIT ||
    proof.maximumBytesTotal !== INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT ||
    proof.maximumRetainedBlobsGlobal !== 2048 ||
    proof.maximumRetainedBytesGlobal !== 512 * 1024 * 1024 ||
    proof.minimumFreeBytesAfterWrite !== 512 * 1024 * 1024 ||
    proof.requestTimeoutMs !== INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS ||
    proof.maximumConcurrentVisionRuns !== 1 ||
    proof.model !== "localllm-vision" || proof.persistence !== "retained-reference-v1" ||
    proof.visionActivationSchemaVersion !== "aginti-integration-analysis-vision-activation-v1" ||
    proof.requestHashBound !== true || proof.idempotencyReplayBound !== true ||
    proof.principalBound !== true || proof.browserSessionBound !== true ||
    proof.threadBound !== true || proof.runBound !== true || proof.orderedReferences !== true ||
    proof.privateBinaryBlobs !== true || proof.publicDescriptorsContainBytes !== false ||
    proof.publicDescriptorsContainPaths !== false || proof.atomicBlobFsyncRename !== true ||
    proof.directoryFsync !== true || proof.exactBlobIntegrityRevalidatedBeforeInference !== true ||
    proof.exclusiveServiceLifetimeLock !== true || proof.crossProcessSafe !== true ||
    proof.globalCapacitySerialized !== true ||
    proof.filesystemFreeSpaceCheckedBeforeAndAfterWrite !== true ||
    proof.orphanCleanupUnderExclusiveLock !== true || proof.deletionReclaimsUnreferencedBlobs !== true ||
    proof.hostedFallback !== false
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis attachment authority is unavailable.", {
      status: 503,
    });
  }
  digestField(proof.stateRootDigest, "analysis attachment state root digest");
  digestField(proof.visionActivationDigest, "analysis attachment vision activation digest");
  return assertCanonicalProofDigest(proof, "analysis attachment authority");
}

export function assertIntegrationAnalysisSessionAuthority(
  value,
  startupProof,
  mutationRecoveryAuthority,
  { searchExpected = false, attachmentsExpected = false } = {}
) {
  const baseKeys = [
    "schemaVersion",
    "owner",
    "authority",
    "ready",
    "testOnly",
    "runnerAuthority",
    "runnerDigest",
    "fixedCoordinatorDigest",
    "plannerActivationSchemaVersion",
    "plannerActivationDigest",
    "plannerActivationBrandRequired",
    "plannerCoordinatorDigestBound",
    "activationProofRequired",
    "activationProofDigest",
    "activationProof",
    "activationProofPinnedAtStartup",
    "activationProofMatchesBoundCoordinator",
    "activationReadinessProbedAtStartup",
    "activationReadinessReprobedPerRpc",
    "stateRootDigest",
    "statePersistenceMode",
    "stateStorageVersion",
    "r67RollbackCompatible",
    "oneFixedStateRoot",
    "principalBound",
    "browserSessionBound",
    "sameBrowserSessionOnly",
    "requestDerivedPaths",
    "symlinksRejected",
    "hardlinksRejected",
    "privateOwnershipAndModes",
    "canonicalStateEncoding",
    "stateEnvelopeDigest",
    "atomicTempFsyncRename",
    "directoryFsync",
    "serializedMutations",
    "exclusiveServiceLifetimeLock",
    "ownershipLockHeldAtAttestation",
    "ownershipReleasedOnlyAfterDrain",
    "crossProcessSafe",
    "maximumConcurrentPlannerRuns",
    "maximumQueuedPlannerRuns",
    "maximumQueuedPlannerRunsPerScope",
    ...INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_KEYS,
    "queuedRunsPersisted",
    "boundedDrain",
    "durablePublicReplay",
    "publicEventHashChain",
    "artifactBeforeTerminal",
    "exactCancellation",
    "interruptedRunRecovery",
    "durableMutationReceipts",
    "mutationRecoveryAuthorityDigest",
    "rawExecutionSourcePersisted",
    "rawExecutionStdoutPersisted",
    "privateRuntimePathsPersisted",
    "documentBytesPersistedByCloud",
    "documentSourcePersistedByCloud",
    "documentWorkerOpaqueRefs",
    "documentWorkerReceiptBindings",
    "documentWorkerPairedCommitIntents",
    "documentWorkerTwoPhaseDelete",
    "documentWorkerDeleteIntentBeforeBytes",
    "documentContentPrincipalAndBrowserSessionBound",
    "documentContentStreamedWithoutCloudBuffering",
    "publicActivationLocksChanged",
    "limitsDigest",
    "digest",
  ];
  const searchKeys = [
    "groundedSearchReady",
    "groundedSearchActivationDigest",
    "groundedSearchIntentPersistedBeforeLaunch",
    "groundedSearchReplayIsReadOnly",
  ];
  const attachmentKeys = [
    "attachmentsReady",
    "attachmentAuthorityDigest",
    "visionActivationDigest",
    "attachmentBytesPersistedOutsideStateEnvelope",
    "attachmentDescriptorsDurableInMessageReplay",
    "attachmentContinuationUsesIndexBoundSource",
    "attachmentTextFollowupsDoNotDuplicateBlobs",
    "attachmentEmptyRetryRequiresHeadMarker",
    "attachmentBlobsRevalidatedBeforeInference",
    "attachmentTextTreatedAsUntrustedData",
  ];
  const keys = [
    ...baseKeys,
    ...(searchExpected ? searchKeys : []),
    ...(attachmentsExpected ? attachmentKeys : []),
  ];
  const proof = exactDataObject(value, keys, keys, "analysis session authority", { frozen: true });
  const r67CompatiblePersistence =
    proof.statePersistenceMode === INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2 &&
    proof.stateStorageVersion === INTEGRATION_ANALYSIS_STATE_STORAGE_V2 &&
    proof.r67RollbackCompatible === true;
  const nativeV3Persistence =
    proof.statePersistenceMode === INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3 &&
    proof.stateStorageVersion === INTEGRATION_ANALYSIS_STATE_STORAGE_V3 &&
    proof.r67RollbackCompatible === false;
  if (
    proof.schemaVersion !== INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.ready !== true ||
    proof.testOnly !== false ||
    proof.runnerAuthority !== "aginti-analysis-planner" ||
    proof.plannerActivationSchemaVersion !== "aginti-integration-analysis-planner-activation-v1" ||
    proof.plannerActivationBrandRequired !== true ||
    proof.plannerCoordinatorDigestBound !== true ||
    proof.activationProofRequired !== true ||
    proof.activationProofDigest !== startupProof.digest ||
    proof.activationProofPinnedAtStartup !== true ||
    proof.activationProofMatchesBoundCoordinator !== true ||
    proof.activationReadinessProbedAtStartup !== true ||
    proof.activationReadinessReprobedPerRpc !== false ||
    (!r67CompatiblePersistence && !nativeV3Persistence) ||
    (searchExpected && r67CompatiblePersistence) ||
    (attachmentsExpected && r67CompatiblePersistence) ||
    proof.oneFixedStateRoot !== true ||
    proof.principalBound !== true ||
    proof.browserSessionBound !== true ||
    proof.sameBrowserSessionOnly !== true ||
    proof.requestDerivedPaths !== false ||
    proof.symlinksRejected !== true ||
    proof.hardlinksRejected !== true ||
    proof.privateOwnershipAndModes !== true ||
    proof.canonicalStateEncoding !== true ||
    proof.stateEnvelopeDigest !== true ||
    proof.atomicTempFsyncRename !== true ||
    proof.directoryFsync !== true ||
    proof.serializedMutations !== true ||
    proof.exclusiveServiceLifetimeLock !== true ||
    proof.ownershipLockHeldAtAttestation !== true ||
    proof.ownershipReleasedOnlyAfterDrain !== true ||
    proof.crossProcessSafe !== true ||
    proof.maximumConcurrentPlannerRuns !== 2 ||
    proof.maximumQueuedPlannerRuns !== 16 ||
    proof.maximumQueuedPlannerRunsPerScope !== 4 ||
    !integrationAnalysisPriorArtifactAuthorityMatches(proof) ||
    proof.queuedRunsPersisted !== true ||
    proof.boundedDrain !== true ||
    proof.durablePublicReplay !== true ||
    proof.publicEventHashChain !== true ||
    proof.artifactBeforeTerminal !== true ||
    proof.exactCancellation !== true ||
    proof.interruptedRunRecovery !== true ||
    (attachmentsExpected && (
      proof.attachmentsReady !== true ||
      proof.attachmentBytesPersistedOutsideStateEnvelope !== true ||
      proof.attachmentDescriptorsDurableInMessageReplay !== true ||
      proof.attachmentContinuationUsesIndexBoundSource !== true ||
      proof.attachmentTextFollowupsDoNotDuplicateBlobs !== true ||
      proof.attachmentEmptyRetryRequiresHeadMarker !== true ||
      proof.attachmentBlobsRevalidatedBeforeInference !== true ||
      proof.attachmentTextTreatedAsUntrustedData !== true
    )) ||
    (searchExpected && (
      proof.groundedSearchReady !== true ||
      proof.groundedSearchActivationDigest === ZERO_DIGEST ||
      proof.groundedSearchIntentPersistedBeforeLaunch !== true ||
      proof.groundedSearchReplayIsReadOnly !== true
    )) ||
    proof.durableMutationReceipts !== true ||
    proof.mutationRecoveryAuthorityDigest !== mutationRecoveryAuthority.digest ||
    proof.rawExecutionSourcePersisted !== false ||
    proof.rawExecutionStdoutPersisted !== false ||
    proof.privateRuntimePathsPersisted !== false ||
    proof.documentBytesPersistedByCloud !== false ||
    proof.documentSourcePersistedByCloud !== false ||
    proof.documentWorkerOpaqueRefs !== true ||
    proof.documentWorkerReceiptBindings !== true ||
    proof.documentWorkerPairedCommitIntents !== true ||
    proof.documentWorkerTwoPhaseDelete !== true ||
    proof.documentWorkerDeleteIntentBeforeBytes !== true ||
    proof.documentContentPrincipalAndBrowserSessionBound !== true ||
    proof.documentContentStreamedWithoutCloudBuffering !== true ||
    proof.publicActivationLocksChanged !== false
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis session authority is unavailable.", { status: 503 });
  }
  for (const key of [
    "runnerDigest",
    "fixedCoordinatorDigest",
    "plannerActivationDigest",
    "stateRootDigest",
    "limitsDigest",
    "mutationRecoveryAuthorityDigest",
    ...(searchExpected ? ["groundedSearchActivationDigest"] : []),
    ...(attachmentsExpected ? ["attachmentAuthorityDigest", "visionActivationDigest"] : []),
  ]) {
    digestField(proof[key], `analysis session authority ${key}`);
  }
  assertAnalysisStartupProof(proof.activationProof);
  if (proof.activationProof.digest !== startupProof.digest) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis startup proof binding is unavailable.", { status: 503 });
  }
  return assertCanonicalProofDigest(proof, "analysis session authority");
}

function analysisActivationMetadata(value) {
  if (!value || typeof value !== "object" || !ANALYSIS_ROUTER_ACTIVATIONS.has(value)) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis router activation is unavailable.", { status: 503 });
  }
  return ANALYSIS_ROUTER_ACTIVATIONS.get(value);
}

function fixedStorageRootDigest(value, field, label) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 4096 ||
    !value.startsWith("/") ||
    value.includes("\u0000")
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", `${label} is unavailable.`, { status: 503 });
  }
  return contractDigest({ [field]: value });
}

export function assertIntegrationAnalysisActivationStorage(activation, value = {}) {
  const roots = exactDataObject(
    value,
    ["stateRoot", "idempotencyRoot", "statePersistenceMode"],
    ["stateRoot", "idempotencyRoot", "statePersistenceMode"],
    "analysis activation storage roots"
  );
  const metadata = analysisActivationMetadata(activation);
  if (
    metadata.proof.storageRootsBound !== true ||
    metadata.proof.stateRootDigest !== fixedStorageRootDigest(roots.stateRoot, "stateRoot", "analysis state root") ||
    metadata.proof.statePersistenceMode !== roots.statePersistenceMode ||
    metadata.proof.idempotencyRootDigest !==
      fixedStorageRootDigest(roots.idempotencyRoot, "rootDir", "analysis idempotency root")
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis activation storage binding is unavailable.", {
      status: 503,
    });
  }
  return activation;
}

export async function createIntegrationAnalysisRouterActivation(options = {}) {
  exactDataObject(
    options,
    [
      "sessionService", "idempotencyStore", "startupProof", "startupRecoveryProof", "policy",
      "stateRoot", "idempotencyRoot", "statePersistenceMode",
    ],
    ["sessionService", "idempotencyStore", "startupProof", "stateRoot", "idempotencyRoot", "statePersistenceMode"],
    "analysis router activation options"
  );
  const policy = options.policy || buildFixedIntegrationPolicy();
  assertFixedIntegrationPolicy(policy);
  if (!Object.isFrozen(policy)) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis policy is unavailable.", { status: 503 });
  }
  let sessionService;
  let idempotencyStore;
  try {
    sessionService = assertIntegrationAnalysisSessionService(options.sessionService);
    idempotencyStore = assertFileIntegrationIdempotencyStore(options.idempotencyStore);
  } catch (error) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Exact analysis dependency identity is unavailable.", {
      status: 503,
      cause: error,
    });
  }
  assertIntegrationTransactionalIdempotencyStore(idempotencyStore);
  const startupRecoveryProof = assertAnalysisPrelistenRecoveryProof(
    options.startupRecoveryProof,
    sessionService,
    idempotencyStore
  );
  const startupProof = assertAnalysisStartupProof(options.startupProof);
  if (
    !sessionService ||
    typeof sessionService !== "object" ||
    !Object.isFrozen(sessionService) ||
    missingServiceMethods(sessionService).length !== 0 ||
    typeof sessionService.getIntegrationCapabilities !== "function" ||
    typeof sessionService.recoverMutation !== "function" ||
    !Object.isFrozen(idempotencyStore)
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Durable analysis session recovery is unavailable.", {
      status: 503,
    });
  }
  const serviceCapabilities = await sessionService.getIntegrationCapabilities({ policy });
  exactDataObject(
    serviceCapabilities,
    [
      "analysisSessionAuthority", "mutationRecoveryAuthority", "cancel", "resume", "search", "files",
      "attachments", "attachmentAuthority", "roles",
    ],
    ["analysisSessionAuthority", "mutationRecoveryAuthority", "cancel", "resume"],
    "analysis service capabilities",
    { frozen: true }
  );
  if (serviceCapabilities.cancel !== true || serviceCapabilities.resume !== true) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis actions are unavailable.", { status: 503 });
  }
  if (serviceCapabilities.search !== undefined && serviceCapabilities.search !== true) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis search capability is invalid.", { status: 503 });
  }
  if (serviceCapabilities.files !== undefined && serviceCapabilities.files !== true) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis file capability is invalid.", { status: 503 });
  }
  if (
    (serviceCapabilities.attachments === undefined) !==
      (serviceCapabilities.attachmentAuthority === undefined) ||
    (serviceCapabilities.attachments !== undefined && serviceCapabilities.attachments !== true)
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis attachment capability is invalid.", {
      status: 503,
    });
  }
  const attachmentAuthority = serviceCapabilities.attachments === true
    ? assertAnalysisAttachmentAuthority(serviceCapabilities.attachmentAuthority)
    : null;
  const mutationRecoveryAuthority = assertAnalysisMutationRecoveryAuthority(
    serviceCapabilities.mutationRecoveryAuthority
  );
  const sessionAuthority = assertIntegrationAnalysisSessionAuthority(
    serviceCapabilities.analysisSessionAuthority,
    startupProof,
    mutationRecoveryAuthority,
    {
      searchExpected: serviceCapabilities.search === true,
      attachmentsExpected: serviceCapabilities.attachments === true,
    }
  );
  const stateRootDigest = fixedStorageRootDigest(options.stateRoot, "stateRoot", "analysis state root");
  const idempotencyRootDigest = fixedStorageRootDigest(
    options.idempotencyRoot,
    "rootDir",
    "analysis idempotency root"
  );
  if (
    sessionAuthority.stateRootDigest !== stateRootDigest ||
    sessionAuthority.statePersistenceMode !== options.statePersistenceMode ||
    idempotencyStore.rootDirDigest !== idempotencyRootDigest ||
    (attachmentAuthority !== null && (
      attachmentAuthority.stateRootDigest !== stateRootDigest ||
      sessionAuthority.attachmentAuthorityDigest !== attachmentAuthority.digest ||
      sessionAuthority.visionActivationDigest !== attachmentAuthority.visionActivationDigest
    ))
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis dependency storage binding is unavailable.", {
      status: 503,
    });
  }
  const recoveryAuthority = idempotencyStore.recoveryAuthority;
  assertIntegrationTransactionalIdempotencyStore(idempotencyStore);
  const attachmentTransportAware =
    sessionAuthority.statePersistenceMode === INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3 &&
    sessionAuthority.stateStorageVersion === INTEGRATION_ANALYSIS_STATE_STORAGE_V3;
  const unsigned = Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_ROUTER_ACTIVATION_SCHEMA_VERSION,
    owner: "aginti",
    ready: true,
    startupProofDigest: startupProof.digest,
    sessionAuthorityDigest: sessionAuthority.digest,
    mutationRecoveryAuthorityDigest: mutationRecoveryAuthority.digest,
    idempotencyRecoveryAuthorityDigest: digestField(
      recoveryAuthority?.digest,
      "idempotency recovery authority digest"
    ),
    startupRecoveryDigest: startupRecoveryProof.digest,
    startupRecoveryBeforeListen: true,
    policyDigest: contractDigest(policy),
    exclusiveSessionAuthority: true,
    exactDependencyIdentity: true,
    startupProofPinned: true,
    storageRootsBound: true,
    stateRootDigest,
    idempotencyRootDigest,
    statePersistenceMode: sessionAuthority.statePersistenceMode,
    stateStorageVersion: sessionAuthority.stateStorageVersion,
    r67RollbackCompatible: sessionAuthority.r67RollbackCompatible,
    attachmentTransportAware,
    ...(attachmentAuthority === null
      ? {}
      : {
          attachmentAuthorityDigest: attachmentAuthority.digest,
          visionActivationDigest: attachmentAuthority.visionActivationDigest,
        }),
  });
  const proof = Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
  const activation = Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_ROUTER_ACTIVATION_SCHEMA_VERSION,
    digest: proof.digest,
    startupRecoveryDigest: startupRecoveryProof.digest,
  });
  ANALYSIS_ROUTER_ACTIVATIONS.set(
    activation,
    Object.freeze({
      sessionService,
      idempotencyStore,
      startupProof,
      startupRecoveryProof,
      policy,
      serviceCapabilities,
      proof,
    })
  );
  return activation;
}

function idempotencyContext(req, pathname) {
  const value = requestSingleIntegrationHeader(req, INTEGRATION_IDEMPOTENCY_HEADER, {
    code: "INVALID_IDEMPOTENCY_KEY",
    status: 400,
  });
  const hasKey = requestHasIntegrationHeader(req, INTEGRATION_IDEMPOTENCY_HEADER);
  if (integrationRpcPathIsMutation(pathname)) {
    return validateIntegrationIdempotencyKey(value);
  }
  if (hasKey) {
    throw new IntegrationApiError("INVALID_IDEMPOTENCY_KEY", "Read-only Agent RPCs must not include an idempotency key.", {
      status: 400,
    });
  }
  return "";
}

function serviceContext(req, pathname, payload, policy, idempotencyKey, mutationIdentity = null) {
  return Object.freeze({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    pathname,
    principal: req.integrationPrincipal,
    principalId: req.integrationPrincipal.id,
    browserSession: req.integrationBrowserSession,
    browserSessionId: req.integrationBrowserSession.id,
    client: req.integrationClient,
    idempotencyKey,
    ...(mutationIdentity
      ? {
          requestHash: mutationIdentity.requestHash,
          idempotencyKeyDigest: mutationIdentity.idempotencyKeyDigest,
        }
      : {}),
    payload,
    policy,
    abortSignal: req.integrationAbortSignal,
  });
}

function capabilityGate({ sessionService, idempotencyStore, policy, serviceCapabilities = {} }) {
  assertFixedIntegrationPolicy(policy);
  const missingMethods = missingServiceMethods(sessionService);
  let isolation = { ok: false, missing: ["isolationAttestation"], profileVersion: "", profileDigest: "" };
  try {
    const authority =
      serviceCapabilities.isolationAttestationAuthority ||
      serviceCapabilities.dockerIsolationAuthority ||
      serviceCapabilities.isolationAuthority;
    if (authority !== "aginti") {
      throw new IntegrationApiError("AGENT_UNAVAILABLE", "AgInTi isolation attestation is unavailable.", { status: 503 });
    }
    isolation = validateIntegrationIsolationAttestation(
      serviceCapabilities.isolationAttestation || serviceCapabilities.dockerIsolationAttestation || {}
    );
  } catch {
    isolation = { ok: false, missing: ["isolationAttestation"], profileVersion: "", profileDigest: "" };
  }
  return { missingMethods, isolation, idempotencyReady: idempotencyReady(idempotencyStore) };
}

function nativeAuthorityReady(service = {}, idempotencyStore = {}) {
  const proof = service.nativeIntegrationAuthority || service.integrationAuthorityProof || {};
  const sandbox = proof.sandboxPrerequisites || {};
  return (
    proof.owner === "aginti" &&
    proof.apiPrefix === INTEGRATION_API_PREFIX &&
    proof.sessions === "aginti" &&
    proof.planning === "aginti" &&
    proof.contextCompaction === "aginti" &&
    proof.tools === "aginti" &&
    proof.dockerExecution === "aginti" &&
    proof.cancellation === "aginti" &&
    proof.idempotency === "aginti" &&
    proof.idempotencyContractVersion === INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION &&
    proof.eventLedger === "aginti" &&
    proof.eventLedgerPersisted === true &&
    proof.artifacts === "aginti" &&
    proof.adaptersAreTransportOnly === true &&
    proof.noHostedProviders === true &&
    proof.noWrappers === true &&
    proof.noMcp === true &&
    proof.noWeb === true &&
    sandbox.owner === "aginti" &&
    sandbox.valid === true &&
    sandbox.enabled === true &&
    idempotencyStore?.owner === "aginti" &&
    idempotencyStore?.contractVersion === INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION
  );
}

async function capabilitiesForService({ sessionService, idempotencyStore, policy }) {
  const readiness = await readinessForService({ sessionService, idempotencyStore, policy }).catch((error) => ({
    enabled: false,
    implementationReady: false,
    digest: contractDigest({ error: error?.code || error?.publicCode || "AGENT_UNAVAILABLE" }),
  }));
  return integrationCapabilitiesResponse({
    enabled: readiness.enabled,
    cancel: false,
    resume: false,
    files: false,
  });
}

function assertActivatedReadiness({ sessionService, idempotencyStore, policy }, activationMetadata) {
  if (
    !activationMetadata ||
    activationMetadata.sessionService !== sessionService ||
    activationMetadata.idempotencyStore !== idempotencyStore ||
    activationMetadata.policy !== policy ||
    activationMetadata.proof?.ready !== true
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Analysis router activation is unavailable.", { status: 503 });
  }
  return activationMetadata;
}

function activatedCapabilitiesForService(options, activationMetadata) {
  const metadata = assertActivatedReadiness(options, activationMetadata);
  return integrationCapabilitiesResponse({
    enabled: true,
    cancel: metadata.serviceCapabilities.cancel,
    resume: metadata.serviceCapabilities.resume,
    search: metadata.serviceCapabilities.search === true,
    files: metadata.serviceCapabilities.files === true,
    attachments: metadata.serviceCapabilities.attachments === true,
    ...(metadata.serviceCapabilities.roles === undefined ? {} : { roles: metadata.serviceCapabilities.roles }),
  });
}

async function readinessForService({ sessionService, idempotencyStore, policy }) {
  const service =
    typeof sessionService?.getIntegrationCapabilities === "function"
      ? await sessionService.getIntegrationCapabilities({ policy })
      : {};
  const gate = capabilityGate({ sessionService, idempotencyStore, policy, serviceCapabilities: service });
  const ready =
    gate.missingMethods.length === 0 &&
    gate.idempotencyReady &&
    gate.isolation.ok &&
    nativeAuthorityReady(service, idempotencyStore);
  const decision = Object.freeze({
    enabled: false,
    implementationReady: ready,
    reason: "PUBLIC_INTEGRATION_CAPABILITY_DISABLED",
    digest: contractDigest({
      enabled: false,
      implementationReady: ready,
      missingMethods: gate.missingMethods,
      isolation: gate.isolation,
      idempotencyReady: gate.idempotencyReady,
      nativeAuthorityReady: nativeAuthorityReady(service, idempotencyStore),
    }),
  });
  return { ...decision, service, gate };
}

async function requireEnabled(options) {
  const readiness = await readinessForService(options);
  if (!readiness.enabled) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "AgInTi Agent capability is unavailable.", { status: 503 });
  }
}

function requireActivated(options, activationMetadata) {
  assertActivatedReadiness(options, activationMetadata);
}

async function callSessionService(sessionService, pathname, payload, context) {
  const method = methodForPath(pathname);
  if (!method || typeof sessionService?.[method] !== "function") {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "AgInTi Agent service method is unavailable.", { status: 503 });
  }
  return sessionService[method](payload, context);
}

async function handleRpc({ req, res, pathname, sessionService, idempotencyStore, policy, activationMetadata = null }) {
  if (!integrationClientCanUsePath(req.integrationClient, pathname)) {
    throw new IntegrationApiError("FORBIDDEN", "Integration client is not authorized for this path.", { status: 403 });
  }
  const payload = sanitizeIntegrationRequest(pathname, req.body || {});
  const idempotencyKey = idempotencyContext(req, pathname);
  const mutationIdentity = integrationRpcPathIsMutation(pathname)
    ? Object.freeze({
        requestHash: requestHash(pathname, req.integrationPrincipal.id, req.integrationBrowserSession.id, payload),
        idempotencyKeyDigest: idempotencyKeyDigest(idempotencyKey),
      })
    : null;
  const context = serviceContext(req, pathname, payload, policy, idempotencyKey, mutationIdentity);

  if (pathname === INTEGRATION_RPC_PATHS.capabilities) {
    const options = { sessionService, idempotencyStore, policy };
    sendJson(
      res,
      200,
      activationMetadata
        ? activatedCapabilitiesForService(options, activationMetadata)
        : await capabilitiesForService(options)
    );
    return;
  }

  if (activationMetadata) {
    requireActivated({ sessionService, idempotencyStore, policy }, activationMetadata);
  } else {
    await requireEnabled({ sessionService, idempotencyStore, policy });
  }

  const gateOffAttachmentMutation =
    activationMetadata?.proof?.attachmentTransportAware === true &&
    activationMetadata?.serviceCapabilities?.attachments !== true &&
    integrationRpcPathIsMutation(pathname) &&
    (pathname === INTEGRATION_RPC_PATHS.runsStart || pathname === INTEGRATION_RPC_PATHS.runsResume) &&
    requestBodyClaimsAttachmentWork(payload);

  if (integrationRpcPathIsMutation(pathname)) {
    const transactionalIdempotencyStore = assertIntegrationTransactionalIdempotencyStore(idempotencyStore);
    const response = await transactionalIdempotencyStore.runMutation(
      {
        principalId: context.principalId,
        browserSessionId: context.browserSessionId,
        pathname,
        idempotencyKey,
        requestHash: mutationIdentity.requestHash,
        requestHashAlgorithm: INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
        responseEnvelope: INTEGRATION_IDEMPOTENCY_RESPONSE_ENVELOPE,
        idempotencyWindowMs: INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS,
        payload,
      },
      async () => {
        if (gateOffAttachmentMutation) {
          throw new IntegrationApiError(
            "ANALYSIS_VISION_NOT_READY",
            "The downloaded local vision model is not enabled for new Agent image mutations.",
            { status: 409 }
          );
        }
        return projectPublicIntegrationResponse(
          pathname,
          await callSessionService(sessionService, pathname, payload, context),
          payload,
          context
        );
      }
    );
    sendJson(res, 200, response);
    return;
  }

  if (pathname === INTEGRATION_RPC_PATHS.runsEvents) {
    const result = await callSessionService(sessionService, pathname, payload, context);
    const run = sanitizePublicIntegrationRun(result.run, {
      principalId: context.principalId,
      browserSessionId: context.browserSessionId,
    });
    assertMatchingResourceId(run.id, payload.runId, "Run");
    const threadId = validateIntegrationThreadId(run.threadId);
    let afterSeq = payload.afterSeq;
    const lastEventId = req.headers["last-event-id"];
    if (typeof lastEventId === "string" && lastEventId) {
      const match = new RegExp(`^${payload.runId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.(\\d+)$`, "u").exec(lastEventId);
      if (!match) throw new IntegrationApiError("INVALID_EVENT_CURSOR", "Last-Event-ID is invalid.", { status: 400 });
      const headerSeq = Number(match[1]);
      if (afterSeq && afterSeq !== headerSeq) throw new IntegrationApiError("INVALID_EVENT_CURSOR", "Event cursors disagree.", { status: 400 });
      afterSeq = headerSeq;
    }
    const publicLedger = assertPublicIntegrationEventLedger(result.publicEventLedger || result.eventLedger || result.eventSource, {
      principalId: context.principalId,
      browserSessionId: context.browserSessionId,
      threadId,
      runId: payload.runId,
    });
    await assertPublicIntegrationRunCursorMatchesLedger(run, publicLedger);
    await writeIntegrationEventStream(res, {
      threadId,
      runId: payload.runId,
      principalId: context.principalId,
      browserSessionId: context.browserSessionId,
      eventSource: publicLedger,
      afterSeq,
      afterHash: payload.afterHash,
      signal: req.integrationAbortSignal,
      streamMs: result.streamMs,
      pollMs: result.pollMs,
      once: result.once,
    });
    return;
  }

  if (pathname === INTEGRATION_RPC_PATHS.artifactsContent) {
    const result = await callSessionService(sessionService, pathname, payload, context);
    await writeIntegrationArtifactContentResponse(res, result, { rangeRequested: payload.range !== undefined });
    return;
  }

  const result = await callSessionService(sessionService, pathname, payload, context);
  sendJson(res, 200, projectPublicIntegrationResponse(pathname, result, payload, context));
}

function hasHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== "";
}

function contentTypeIsExactJson(value = "") {
  const parts = String(value)
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts[0] !== "application/json") return false;
  if (parts.length === 1) return true;
  return parts.length === 2 && parts[1] === "charset=utf-8";
}

function originalPathIsAmbiguous(value = "") {
  const originalUrl = String(value || "");
  return (
    !originalUrl.startsWith(INTEGRATION_API_PREFIX) ||
    originalUrl.includes("?") ||
    originalUrl.includes("\\") ||
    originalUrl.includes("//") ||
    originalUrl.endsWith("/") ||
    /\.\.|%(?:2e|2f|5c)/iu.test(originalUrl)
  );
}

function verifyFatalUtf8Json(req, _res, buffer) {
  if (
    Number.isSafeInteger(req.integrationBodyByteLimit) &&
    buffer.length > req.integrationBodyByteLimit
  ) {
    const error = new Error("Request body exceeds its route-specific limit.");
    error.status = 413;
    error.statusCode = 413;
    error.type = "entity.too.large";
    throw error;
  }
  if (!isUtf8(buffer)) {
    const error = new Error("Request body is not valid UTF-8.");
    error.status = 400;
    error.statusCode = 400;
    error.type = "entity.invalid.utf8";
    throw error;
  }
}

export function integrationAnalysisBodyReceiveTimeoutMs(
  pathname,
  { attachmentsEnabled = false, declaredBodyBytes = null } = {}
) {
  if (
    typeof pathname !== "string" || typeof attachmentsEnabled !== "boolean" ||
    (declaredBodyBytes !== null && (!Number.isSafeInteger(declaredBodyBytes) || declaredBodyBytes < 0))
  ) {
    throw new TypeError("analysis body receive timeout input is invalid");
  }
  return attachmentsEnabled &&
    (pathname === INTEGRATION_RPC_PATHS.runsStart || pathname === INTEGRATION_RPC_PATHS.runsResume) &&
    (declaredBodyBytes === null || declaredBodyBytes > 128 * 1024)
    ? INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_RECEIVE_TIMEOUT_MS
    : INTEGRATION_ANALYSIS_ORDINARY_BODY_RECEIVE_TIMEOUT_MS;
}

function armBodyReceiveDeadline(req, milliseconds) {
  let timer = setTimeout(() => {
    timer = null;
    if (!req.complete && !req.destroyed) {
      req.destroy(new Error("Agent request body receive deadline exceeded."));
    }
  }, milliseconds);
  timer.unref?.();
  const cleanup = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  req.once("end", cleanup);
  req.once("aborted", cleanup);
  req.once("close", cleanup);
}

function declaredContentLength(req) {
  const contentLength = req.headers["content-length"];
  if (contentLength === undefined || Array.isArray(contentLength)) return null;
  const text = String(contentLength).trim();
  if (!/^[0-9]+$/u.test(text)) return null;
  const length = Number(text);
  return Number.isSafeInteger(length) ? length : null;
}

function hasDeclaredOrdinaryBody(req, ordinaryBodyBytes) {
  const length = declaredContentLength(req);
  return length !== null && length <= ordinaryBodyBytes;
}

function requestBodyClaimsAttachmentWork(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const input = body.input;
  return (
    Object.prototype.hasOwnProperty.call(body, "reuseAttachments") ||
    (input && typeof input === "object" && !Array.isArray(input) &&
      Object.prototype.hasOwnProperty.call(input, "attachments"))
  );
}

function createAttachmentAdmissionMiddlewares(
  attachmentsEnabled,
  attachmentMutationPaths,
  ordinaryBodyBytes,
  observeRequestsInFlight = () => {}
) {
  let requestsInFlight = 0;
  const releases = new WeakMap();
  const acquire = (req, res) => {
    if (releases.has(req)) return true;
    if (requestsInFlight >= INTEGRATION_ANALYSIS_MAX_CONCURRENT_ATTACHMENT_REQUESTS) {
      req.resume();
      res.set("Connection", "close");
      writeIntegrationErrorJson(res, 429, "ANALYSIS_ATTACHMENT_ADMISSION_BUSY");
      return false;
    }
    requestsInFlight += 1;
    observeRequestsInFlight(requestsInFlight);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releases.delete(req);
      requestsInFlight -= 1;
      observeRequestsInFlight(requestsInFlight);
      req.off?.("aborted", release);
      res.off?.("finish", release);
      res.off?.("close", release);
      res.off?.("error", release);
    };
    releases.set(req, release);
    req.once("aborted", release);
    res.once("finish", release);
    res.once("close", release);
    res.once("error", release);
    return true;
  };
  const applies = (req) => attachmentsEnabled && attachmentMutationPaths.has(
    String(req.originalUrl || req.url || "")
  );
  const beforeBody = (req, res, next) => {
    if (!applies(req) || hasDeclaredOrdinaryBody(req, ordinaryBodyBytes)) {
      next();
      return;
    }
    if (acquire(req, res)) next();
  };
  const afterBody = (req, res, next) => {
    if (!applies(req)) {
      next();
      return;
    }
    if (!requestBodyClaimsAttachmentWork(req.body)) {
      releases.get(req)?.();
      next();
      return;
    }
    if (acquire(req, res)) next();
  };
  return Object.freeze({ beforeBody, afterBody });
}

function createRouteJsonParserMiddleware({ attachmentsEnabled, attachmentMutationPaths, maxBodyBytes, ordinaryBodyBytes }) {
  const ordinaryJsonParser = express.json({
    limit: ordinaryBodyBytes,
    strict: true,
    type: "application/json",
    verify: verifyFatalUtf8Json,
  });
  const attachmentJsonParser = express.json({
    limit: maxBodyBytes,
    strict: true,
    type: "application/json",
    verify: verifyFatalUtf8Json,
  });
  return (req, res, next) => {
    const pathname = String(req.originalUrl || req.url || "");
    const parser = attachmentsEnabled && attachmentMutationPaths.has(pathname) &&
      req.integrationBodyByteLimit > ordinaryBodyBytes
      ? attachmentJsonParser
      : ordinaryJsonParser;
    parser(req, res, next);
  };
}

export function createTestOnlyIntegrationAnalysisBodyMiddlewares() {
  const attachmentMutationPaths = new Set([
    INTEGRATION_RPC_PATHS.runsStart,
    INTEGRATION_RPC_PATHS.runsResume,
  ]);
  let requestsInFlight = 0;
  const admission = createAttachmentAdmissionMiddlewares(
    true,
    attachmentMutationPaths,
    128 * 1024,
    (value) => { requestsInFlight = value; }
  );
  return Object.freeze({
    beforeBody: admission.beforeBody,
    parse: createRouteJsonParserMiddleware({
      attachmentsEnabled: true,
      attachmentMutationPaths,
      maxBodyBytes: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_BYTES_LIMIT,
      ordinaryBodyBytes: 128 * 1024,
    }),
    afterBody: admission.afterBody,
    requestsInFlight: () => requestsInFlight,
  });
}

function createIntegrationRouterWithAuthority(options = {}, activationMetadata = null) {
  const sessionService = options.sessionService;
  const idempotencyStore = options.idempotencyStore;
  const policy = options.policy || buildFixedIntegrationPolicy(options.policyOptions || {});
  assertFixedIntegrationPolicy(policy);

  const router = express.Router({ strict: true });
  const prefix = options.prefix || INTEGRATION_API_PREFIX;
  const authMiddleware = createIntegrationAuthMiddleware(options.auth || {});
  const attachmentTransportAware = activationMetadata?.proof?.attachmentTransportAware === true;
  const maxBodyBytes = Number(
    options.maxBodyBytes ??
      (attachmentTransportAware ? INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_BYTES_LIMIT : 128 * 1024)
  );
  if (
    !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 ||
    maxBodyBytes > INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_BYTES_LIMIT ||
    (attachmentTransportAware && maxBodyBytes < INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_BYTES_LIMIT)
  ) {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "Agent request body limits are invalid.", { status: 503 });
  }
  const ordinaryBodyBytes = Math.min(maxBodyBytes, 128 * 1024);
  const attachmentMutationPaths = new Set([
    INTEGRATION_RPC_PATHS.runsStart,
    INTEGRATION_RPC_PATHS.runsResume,
  ]);
  const bodyLimitForRequest = (pathname, req) =>
    attachmentTransportAware && attachmentMutationPaths.has(pathname) &&
      !hasDeclaredOrdinaryBody(req, ordinaryBodyBytes)
      ? maxBodyBytes
      : ordinaryBodyBytes;
  const attachmentAdmission = createAttachmentAdmissionMiddlewares(
    attachmentTransportAware,
    attachmentMutationPaths,
    ordinaryBodyBytes
  );

  router.use(prefix, authMiddleware);
  router.use(prefix, (req, res, next) => {
    const originalUrl = String(req.originalUrl || req.url || "");
    if (originalPathIsAmbiguous(originalUrl)) {
      writeIntegrationErrorJson(res, 404, "NOT_FOUND");
      return;
    }
    if (req.method !== "POST") {
      writeIntegrationErrorJson(res, 405, "METHOD_NOT_ALLOWED");
      return;
    }
    if (hasHeader(req, "content-encoding")) {
      writeIntegrationErrorJson(res, 415, "UNSUPPORTED_CONTENT_ENCODING");
      return;
    }
    if (!contentTypeIsExactJson(req.headers["content-type"])) {
      writeIntegrationErrorJson(res, 415, "INVALID_CONTENT_TYPE");
      return;
    }
    const bodyByteLimit = bodyLimitForRequest(originalUrl, req);
    const bodyReceiveTimeoutMs = integrationAnalysisBodyReceiveTimeoutMs(originalUrl, {
      attachmentsEnabled: attachmentTransportAware,
      declaredBodyBytes: declaredContentLength(req),
    });
    armBodyReceiveDeadline(req, bodyReceiveTimeoutMs);
    Object.defineProperty(req, "integrationBodyByteLimit", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: bodyByteLimit,
    });
    const contentLength = req.headers["content-length"];
    if (contentLength !== undefined) {
      const text = Array.isArray(contentLength) ? "" : String(contentLength).trim();
      const length = Number(text);
      if (!/^[0-9]+$/u.test(text) || !Number.isSafeInteger(length) || length > bodyByteLimit) {
        writeIntegrationErrorJson(res, length > bodyByteLimit ? 413 : 400, length > bodyByteLimit ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST");
        return;
      }
    }
    next();
  });
  router.use(prefix, attachmentAdmission.beforeBody);
  router.use(prefix, createRouteJsonParserMiddleware({
    attachmentsEnabled: attachmentTransportAware,
    attachmentMutationPaths,
    maxBodyBytes,
    ordinaryBodyBytes,
  }));
  router.use(prefix, attachmentAdmission.afterBody);
  router.use(prefix, (req, res, next) => {
    const controller = new AbortController();
    req.integrationAbortSignal = controller.signal;
    const abort = () => controller.abort(new Error("Client disconnected."));
    const cleanup = () => {
      req.off?.("aborted", abort);
      res.off?.("close", abort);
      res.off?.("finish", cleanup);
      res.off?.("error", cleanup);
    };
    req.once("aborted", abort);
    res.once("close", abort);
    res.once("finish", cleanup);
    res.once("error", cleanup);
    next();
  });

  for (const pathname of INTEGRATION_RPC_PATH_LIST) {
    router.post(pathname, async (req, res) => {
      try {
        if (String(req.originalUrl || "") !== pathname) {
          throw new IntegrationApiError("NOT_FOUND", "Agent RPC not found.", { status: 404 });
        }
        await handleRpc({
          req,
          res,
          pathname,
          sessionService,
          idempotencyStore,
          policy,
          activationMetadata,
        });
      } catch (error) {
        sendError(res, error);
      }
    });
  }

  router.use(prefix, (_req, res) => {
    writeIntegrationErrorJson(res, 404, "NOT_FOUND");
  });

  router.use(prefix, (error, _req, res, _next) => {
    if (error?.type === "entity.too.large") {
      writeIntegrationErrorJson(res, 413, "REQUEST_TOO_LARGE");
      return;
    }
    writeIntegrationErrorJson(res, 400, "INVALID_JSON");
  });

  return router;
}

export function createIntegrationRouter(options = {}) {
  return createIntegrationRouterWithAuthority(options, null);
}

export function createActivatedIntegrationAnalysisRouter(options = {}) {
  exactDataObject(
    options,
    ["activation", "auth", "prefix", "maxBodyBytes"],
    ["activation"],
    "activated analysis router options"
  );
  const metadata = analysisActivationMetadata(options.activation);
  return createIntegrationRouterWithAuthority(
    {
      sessionService: metadata.sessionService,
      idempotencyStore: metadata.idempotencyStore,
      policy: metadata.policy,
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    },
    metadata
  );
}

function assertPublicCapabilityResponse(value = {}) {
  const response = integrationExactKeys(value, ["schemaVersion", "enabled", "agent", "model", "actions", "attachments", "search", "roles", "artifacts"], "agent capabilities", [
    "schemaVersion",
    "enabled",
    "agent",
    "model",
    "actions",
    "attachments",
    "artifacts",
  ]);
  if (response.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION || typeof response.enabled !== "boolean") {
    integrationInvalid("agent capabilities schemaVersion or enabled flag is invalid");
  }
  const agent = integrationExactKeys(response.agent, ["kind", "label"], "agent capabilities agent", ["kind", "label"]);
  const model = integrationExactKeys(response.model, ["label"], "agent capabilities model", ["label"]);
  const actions = integrationExactKeys(response.actions, ["cancel", "resume", "retry"], "agent capabilities actions", ["cancel", "resume", "retry"]);
  const attachmentFields = [
    "enabled", "transport", "acceptedMediaTypes", "maximumCount", "maximumBytesEach",
    "maximumBytesTotal", "requestTimeoutMs", "model", "persistence",
  ];
  const attachments = integrationExactKeys(
    response.attachments,
    attachmentFields,
    "agent capabilities attachments",
    ["enabled"]
  );
  const search = response.search === undefined
    ? { enabled: false, modes: [], maximumSources: 0 }
    : integrationExactKeys(
        response.search,
        ["enabled", "modes", "maximumSources"],
        "agent capabilities search",
        ["enabled", "modes", "maximumSources"]
      );
  const artifacts = integrationExactKeys(response.artifacts, ["kinds", "schemaVersion"], "agent capabilities artifacts", ["kinds", "schemaVersion"]);
  let roles;
  if (response.roles !== undefined) {
    const roleEnvelope = integrationExactKeys(
      response.roles,
      ["executionWorker", "documentWorker", "groundedSearch"],
      "agent capabilities roles",
      ["executionWorker", "documentWorker", "groundedSearch"]
    );
    const roleSnapshots = {};
    for (const roleName of ["executionWorker", "documentWorker", "groundedSearch"]) {
      const role = integrationExactKeys(
        roleEnvelope[roleName],
        ["schemaVersion", "role", "configured", "status", "ready", "observedAt", "reason", "actionable"],
        `agent capabilities ${roleName} role`,
        ["schemaVersion", "role", "configured", "status", "ready", "observedAt", "reason", "actionable"]
      );
      if (
        role.schemaVersion !== "aginti-analysis-role-state-v1" ||
        role.role !== roleName ||
        typeof role.configured !== "boolean" ||
        !new Set(["disabled", "configured", "degraded", "ready"]).has(role.status) ||
        role.ready !== (role.status === "ready") ||
        Date.parse(role.observedAt) !== Date.parse(role.observedAt) ||
        new Date(Date.parse(role.observedAt)).toISOString() !== role.observedAt
      ) {
        integrationInvalid("agent role capabilities are invalid");
      }
      if (role.status === "ready") {
        if (role.configured !== true || role.reason !== null || role.actionable !== null) {
          integrationInvalid("agent ready role capability is invalid");
        }
      } else if (
        typeof role.reason !== "string" ||
        role.reason.length < 3 ||
        role.reason.length > 96 ||
        typeof role.actionable !== "string" ||
        role.actionable.length < 3 ||
        role.actionable.length > 240
      ) {
        integrationInvalid("agent degraded role capability is invalid");
      }
      roleSnapshots[roleName] = Object.freeze({
        schemaVersion: role.schemaVersion,
        role: role.role,
        configured: role.configured,
        status: role.status,
        ready: role.ready,
        observedAt: role.observedAt,
        reason: role.reason,
        actionable: role.actionable,
      });
    }
    roles = Object.freeze(roleSnapshots);
  }
  if (agent.kind !== "aginti" || agent.label !== "AgInTi Agent") integrationInvalid("agent authority must be AgInTi");
  if (model.label !== "LocalLLM") integrationInvalid("agent inference label must be LocalLLM");
  if (![actions.cancel, actions.resume, actions.retry, attachments.enabled, search.enabled].every((flag) => typeof flag === "boolean")) {
    integrationInvalid("agent capability flags must be booleans");
  }
  if (actions.retry !== false) integrationInvalid("retry is not enabled in protocol v1");
  let attachmentCapability = Object.freeze({ enabled: false });
  if (attachments.enabled) {
    integrationExactKeys(
      attachments,
      attachmentFields,
      "agent capabilities attachments",
      attachmentFields
    );
    if (
      !response.enabled ||
      attachments.transport !== "inline-base64" ||
      canonicalJson(attachments.acceptedMediaTypes) !==
        canonicalJson(INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_MEDIA_TYPES) ||
      attachments.maximumCount !== INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_COUNT_LIMIT ||
      attachments.maximumBytesEach !== INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BYTES_LIMIT ||
      attachments.maximumBytesTotal !== INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT ||
      attachments.requestTimeoutMs !== INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS ||
      attachments.model !== "localllm-vision" ||
      attachments.persistence !== "retained-reference-v1"
    ) {
      integrationInvalid("agent attachment capabilities are invalid");
    }
    attachmentCapability = Object.freeze({
      enabled: true,
      transport: "inline-base64",
      acceptedMediaTypes: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_MEDIA_TYPES,
      maximumCount: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_COUNT_LIMIT,
      maximumBytesEach: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BYTES_LIMIT,
      maximumBytesTotal: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT,
      requestTimeoutMs: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS,
      model: "localllm-vision",
      persistence: "retained-reference-v1",
    });
  } else {
    integrationExactKeys(attachments, ["enabled"], "agent capabilities attachments", ["enabled"]);
  }
  const searchModes = search.enabled ? [...INTEGRATION_SEARCH_MODES] : [];
  if (
    !Array.isArray(search.modes) ||
    canonicalJson(search.modes) !== canonicalJson(searchModes) ||
    (search.enabled
      ? search.maximumSources !== INTEGRATION_MAXIMUM_SEARCH_SOURCES
      : search.maximumSources !== 0) ||
    (search.enabled && !response.enabled)
  ) {
    integrationInvalid("agent search capabilities are invalid");
  }
  const fileEnabled = artifacts.kinds?.includes?.("file") === true;
  if (fileEnabled && !response.enabled) integrationInvalid("disabled capabilities may not advertise file artifacts");
  const artifactKinds = [
    ...INTEGRATION_ARTIFACT_KINDS.filter((kind) => kind !== "file"),
    ...(search.enabled ? [INTEGRATION_SEARCH_ARTIFACT_KIND] : []),
    ...(fileEnabled ? ["file"] : []),
  ];
  if (
    artifacts.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION ||
    !Array.isArray(artifacts.kinds) ||
    canonicalJson(artifacts.kinds) !== canonicalJson(artifactKinds)
  ) {
    integrationInvalid("agent artifact capabilities are invalid");
  }
  if (!response.enabled && (actions.cancel || actions.resume)) integrationInvalid("disabled capabilities may not advertise actions");
  return Object.freeze({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    enabled: response.enabled,
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({ cancel: actions.cancel, resume: actions.resume, retry: false }),
    attachments: attachmentCapability,
    ...(search.enabled
      ? {
          search: Object.freeze({
            enabled: true,
            modes: Object.freeze(searchModes),
            maximumSources: INTEGRATION_MAXIMUM_SEARCH_SOURCES,
          }),
        }
      : {}),
    ...(roles === undefined ? {} : { roles }),
    artifacts: Object.freeze({
      kinds: Object.freeze(artifactKinds),
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    }),
  });
}

function assertPublicThreadContract(value = {}) {
  const thread = integrationExactKeys(
    value,
    ["id", "title", "status", "revision", "createdAt", "updatedAt", "lastRunId", "activeImageContext", "authority", "replay", "messages"],
    "thread",
    ["id", "title", "status", "revision", "createdAt", "updatedAt", "lastRunId", "authority", "replay"]
  );
  const authority = integrationExactKeys(
    thread.authority,
    ["kind", "mapped", "runtimeRevision", "contextDigest", "lastCompaction"],
    "thread authority",
    ["kind", "mapped", "runtimeRevision", "contextDigest", "lastCompaction"]
  );
  if (authority.lastCompaction !== null) {
    integrationExactKeys(
      authority.lastCompaction,
      ["compactedMessages", "tokensBefore", "tokensAfter", "digest"],
      "thread lastCompaction",
      ["compactedMessages", "tokensBefore", "tokensAfter", "digest"]
    );
  }
  integrationExactKeys(thread.replay, ["prunedMessageCount", "anchorDigest"], "thread replay", ["prunedMessageCount", "anchorDigest"]);
  if (thread.messages !== undefined) {
    if (!Array.isArray(thread.messages)) integrationInvalid("thread replay exceeds 256 messages");
    thread.messages.forEach((message, index) => {
      integrationExactKeys(message, ["id", "role", "content", "runId", "createdAt", "digest", "attachments"], `thread message[${index}]`, [
        "id",
        "role",
        "content",
        "runId",
        "createdAt",
        "digest",
      ]);
    });
  }
  return sanitizePublicIntegrationThread(thread, { publicContract: true });
}

function assertPublicRunContract(value = {}) {
  const run = integrationExactKeys(
    value,
    ["id", "threadId", "previousRunId", "status", "createdAt", "startedAt", "completedAt", "cancelRequestedAt", "output", "error", "authority", "eventCursor"],
    "run",
    ["id", "threadId", "previousRunId", "status", "createdAt", "startedAt", "completedAt", "cancelRequestedAt", "output", "error", "authority", "eventCursor"]
  );
  integrationExactKeys(run.authority, ["kind", "snapshotHash", "runtimeRevision", "contextDigest"], "run authority", [
    "kind",
    "snapshotHash",
    "runtimeRevision",
    "contextDigest",
  ]);
  integrationExactKeys(run.eventCursor, ["firstSeq", "lastSeq", "lastHash", "prunedThroughSeq"], "run eventCursor", [
    "firstSeq",
    "lastSeq",
    "lastHash",
    "prunedThroughSeq",
  ]);
  if (run.error !== null) integrationExactKeys(run.error, ["code", "message"], "run error", ["code", "message"]);
  return sanitizePublicIntegrationRun(run, { publicContract: true });
}

function assertPublicArtifactContract(value = {}) {
  const artifact = integrationExactKeys(value, ["id", "title", "kind", "spec"], "artifact", ["id", "title", "kind", "spec"]);
  validateIntegrationArtifactId(artifact.id);
  const sanitized = sanitizeIntegrationArtifact(artifact);
  if (contractDigest(artifact) !== contractDigest(sanitized)) {
    integrationInvalid("artifact is not an exact public artifact envelope", { code: "UNSAFE_PRESENTATION" });
  }
  return sanitized;
}

export function assertPublicIntegrationResponse(pathname, value) {
  const path = String(pathname || "");
  if (path === INTEGRATION_RPC_PATHS.capabilities) {
    return assertPublicCapabilityResponse(value);
  }
  if (path === INTEGRATION_RPC_PATHS.runsEvents) return validatePublicIntegrationEvent(value);
  if (path === INTEGRATION_RPC_PATHS.threadsList) {
    const response = integrationExactKeys(value, ["schemaVersion", "threads", "nextBefore"], "thread list response", [
      "schemaVersion",
      "threads",
      "nextBefore",
    ]);
    if (response.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION || !Array.isArray(response.threads) || response.threads.length > 100) {
      integrationInvalid("thread list response is invalid");
    }
    if (response.nextBefore !== null) validateIntegrationThreadId(response.nextBefore);
    return assertPublicJsonResponseBytes(Object.freeze({
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
      threads: Object.freeze(response.threads.map(assertPublicThreadContract)),
      nextBefore: response.nextBefore,
    }), "thread list response");
  }
  if ([INTEGRATION_RPC_PATHS.threadsCreate, INTEGRATION_RPC_PATHS.threadsGet, INTEGRATION_RPC_PATHS.threadsUpdate].includes(path)) {
    const response = integrationExactKeys(value, ["schemaVersion", "thread"], "thread response", ["schemaVersion", "thread"]);
    if (response.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION) integrationInvalid("thread response schemaVersion must be 1");
    return Object.freeze({ schemaVersion: AGENT_WORKER_SCHEMA_VERSION, thread: assertPublicThreadContract(response.thread) });
  }
  if (path === INTEGRATION_RPC_PATHS.threadsDelete) {
    const response = integrationExactKeys(value, ["schemaVersion", "deleted", "threadId"], "thread delete response", [
      "schemaVersion",
      "deleted",
      "threadId",
    ]);
    if (response.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION || response.deleted !== true) integrationInvalid("thread delete response is invalid");
    return Object.freeze({ schemaVersion: AGENT_WORKER_SCHEMA_VERSION, deleted: true, threadId: validateIntegrationThreadId(response.threadId) });
  }
  if ([INTEGRATION_RPC_PATHS.runsStart, INTEGRATION_RPC_PATHS.runsStatus, INTEGRATION_RPC_PATHS.runsCancel, INTEGRATION_RPC_PATHS.runsResume].includes(path)) {
    const response = integrationExactKeys(value, ["schemaVersion", "run"], "run response", ["schemaVersion", "run"]);
    if (response.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION) integrationInvalid("run response schemaVersion must be 1");
    return Object.freeze({ schemaVersion: AGENT_WORKER_SCHEMA_VERSION, run: assertPublicRunContract(response.run) });
  }
  if (path === INTEGRATION_RPC_PATHS.artifactsList) {
    const response = integrationExactKeys(value, ["schemaVersion", "artifacts"], "artifact list response", ["schemaVersion", "artifacts"]);
    if (response.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION || !Array.isArray(response.artifacts) || response.artifacts.length > 32) {
      integrationInvalid("artifact list response is invalid");
    }
    return Object.freeze({
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
      artifacts: Object.freeze(response.artifacts.map(assertPublicArtifactContract)),
    });
  }
  if (path === INTEGRATION_RPC_PATHS.artifactsGet) {
    const response = integrationExactKeys(value, ["schemaVersion", "artifact"], "artifact response", ["schemaVersion", "artifact"]);
    if (response.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION) integrationInvalid("artifact response schemaVersion must be 1");
    return Object.freeze({ schemaVersion: AGENT_WORKER_SCHEMA_VERSION, artifact: assertPublicArtifactContract(response.artifact) });
  }
  throw new IntegrationApiError("NOT_FOUND", "Agent RPC not found.", { status: 404 });
}
