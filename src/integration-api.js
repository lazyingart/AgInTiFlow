import express from "express";
import { TextDecoder } from "node:util";
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
  INTEGRATION_API_PREFIX,
  INTEGRATION_ARTIFACT_KINDS,
  INTEGRATION_RPC_PATHS,
  INTEGRATION_RPC_PATH_LIST,
  INTEGRATION_RUN_STATUSES,
  INTEGRATION_THREAD_STATUSES,
  IntegrationValidationError,
  assertFixedIntegrationPolicy,
  buildFixedIntegrationPolicy,
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
import { buildIntegrationArtifacts, findIntegrationArtifact, sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import {
  assertPublicIntegrationEventLedger,
  assertPublicIntegrationRunCursorMatchesLedger,
  validatePublicIntegrationEvent,
  writeIntegrationEventStream,
} from "./integration-events.js";
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
});

const ZERO_DIGEST = "0".repeat(64);
export const INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION = "aginti-transactional-idempotency-v1";
const INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM = "canonical-json-v1";
const INTEGRATION_IDEMPOTENCY_RESPONSE_ENVELOPE = "aginti-agent-rpc-v1";
export const INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
export const INTEGRATION_PUBLIC_JSON_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s("'`])(?:\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/[^\s"'`<>)\]]*)?|[A-Za-z]:\\[^\s"'`<>)\]]*)/giu;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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
    const prefix = /^[\s("'`]/u.test(match) ? match[0] : "";
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

function publicMessage(value = {}, index) {
  const message = integrationExactKeys(value, ["id", "role", "content", "runId", "createdAt", "digest"], `thread message[${index}]`, [
    "id",
    "role",
    "content",
    "runId",
    "createdAt",
    "digest",
  ]);
  if (typeof message.id !== "string" || !/^msg_[A-Za-z0-9_-]{16,96}$/u.test(message.id)) integrationInvalid(`thread message[${index}].id is invalid`);
  if (!new Set(["user", "assistant"]).has(message.role)) integrationInvalid(`thread message[${index}].role is invalid`);
  return Object.freeze({
    id: message.id,
    role: message.role,
    content: integrationBoundedText(redactPublicText(message.content), `thread message[${index}].content`, 32_000),
    runId: validateIntegrationRunId(message.runId),
    createdAt: safeTimestamp(message.createdAt, `thread message[${index}].createdAt`),
    digest: safeDigest(message.digest, `thread message[${index}].digest`),
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
  return Object.freeze({
    id: validateIntegrationThreadId(value.id),
    title: publicLabel(value.title, "title", 120),
    status: safeThreadStatus(value.status),
    revision: integrationBoundedInteger(value.revision, "thread revision", { minimum: 1 }),
    createdAt: safeTimestamp(value.createdAt, "thread createdAt"),
    updatedAt: safeTimestamp(value.updatedAt, "thread updatedAt"),
    lastRunId: value.lastRunId === null || value.lastRunId === "" || value.lastRunId === undefined ? null : validateIntegrationRunId(value.lastRunId),
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

function publicResponseForPath(pathname, result = {}, payload = {}, context = {}) {
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

function serviceContext(req, pathname, payload, policy, idempotencyKey) {
  return Object.freeze({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    pathname,
    principal: req.integrationPrincipal,
    principalId: req.integrationPrincipal.id,
    browserSession: req.integrationBrowserSession,
    browserSessionId: req.integrationBrowserSession.id,
    client: req.integrationClient,
    idempotencyKey,
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

async function callSessionService(sessionService, pathname, payload, context) {
  const method = methodForPath(pathname);
  if (!method || typeof sessionService?.[method] !== "function") {
    throw new IntegrationApiError("AGENT_UNAVAILABLE", "AgInTi Agent service method is unavailable.", { status: 503 });
  }
  return sessionService[method](payload, context);
}

async function handleRpc({ req, res, pathname, sessionService, idempotencyStore, policy }) {
  if (!integrationClientCanUsePath(req.integrationClient, pathname)) {
    throw new IntegrationApiError("FORBIDDEN", "Integration client is not authorized for this path.", { status: 403 });
  }
  const payload = sanitizeIntegrationRequest(pathname, req.body || {});
  const idempotencyKey = idempotencyContext(req, pathname);
  const context = serviceContext(req, pathname, payload, policy, idempotencyKey);

  if (pathname === INTEGRATION_RPC_PATHS.capabilities) {
    sendJson(res, 200, await capabilitiesForService({ sessionService, idempotencyStore, policy }));
    return;
  }

  await requireEnabled({ sessionService, idempotencyStore, policy });

  if (integrationRpcPathIsMutation(pathname)) {
    const transactionalIdempotencyStore = assertIntegrationTransactionalIdempotencyStore(idempotencyStore);
    const hash = requestHash(pathname, context.principalId, context.browserSessionId, payload);
    const response = await transactionalIdempotencyStore.runMutation(
      {
        principalId: context.principalId,
        browserSessionId: context.browserSessionId,
        pathname,
        idempotencyKey,
        requestHash: hash,
        requestHashAlgorithm: INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
        responseEnvelope: INTEGRATION_IDEMPOTENCY_RESPONSE_ENVELOPE,
        idempotencyWindowMs: INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS,
        payload,
      },
      async () => publicResponseForPath(pathname, await callSessionService(sessionService, pathname, payload, context), payload, context)
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

  const result = await callSessionService(sessionService, pathname, payload, context);
  sendJson(res, 200, publicResponseForPath(pathname, result, payload, context));
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

function verifyFatalUtf8Json(_req, _res, buffer) {
  try {
    FATAL_UTF8_DECODER.decode(buffer);
  } catch {
    const error = new Error("Request body is not valid UTF-8.");
    error.status = 400;
    error.statusCode = 400;
    error.type = "entity.invalid.utf8";
    throw error;
  }
}

export function createIntegrationRouter(options = {}) {
  const sessionService = options.sessionService;
  const idempotencyStore = options.idempotencyStore;
  const policy = options.policy || buildFixedIntegrationPolicy(options.policyOptions || {});
  assertFixedIntegrationPolicy(policy);

  const router = express.Router({ strict: true });
  const prefix = options.prefix || INTEGRATION_API_PREFIX;
  const authMiddleware = createIntegrationAuthMiddleware(options.auth || {});
  const maxBodyBytes = Number(options.maxBodyBytes || 128 * 1024);

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
    const contentLength = req.headers["content-length"];
    if (contentLength !== undefined) {
      const text = Array.isArray(contentLength) ? "" : String(contentLength).trim();
      const length = Number(text);
      if (!/^[0-9]+$/u.test(text) || !Number.isSafeInteger(length) || length > maxBodyBytes) {
        writeIntegrationErrorJson(res, length > maxBodyBytes ? 413 : 400, length > maxBodyBytes ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST");
        return;
      }
    }
    next();
  });
  router.use(prefix, express.json({ limit: maxBodyBytes, strict: true, type: "application/json", verify: verifyFatalUtf8Json }));
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

function assertPublicCapabilityResponse(value = {}) {
  const response = integrationExactKeys(value, ["schemaVersion", "enabled", "agent", "model", "actions", "attachments", "artifacts"], "agent capabilities", [
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
  const attachments = integrationExactKeys(response.attachments, ["enabled"], "agent capabilities attachments", ["enabled"]);
  const artifacts = integrationExactKeys(response.artifacts, ["kinds", "schemaVersion"], "agent capabilities artifacts", ["kinds", "schemaVersion"]);
  if (agent.kind !== "aginti" || agent.label !== "AgInTi Agent") integrationInvalid("agent authority must be AgInTi");
  if (model.label !== "LocalLLM") integrationInvalid("agent inference label must be LocalLLM");
  if (![actions.cancel, actions.resume, actions.retry, attachments.enabled].every((flag) => typeof flag === "boolean")) {
    integrationInvalid("agent capability flags must be booleans");
  }
  if (actions.retry !== false || attachments.enabled !== false) integrationInvalid("retry and attachments are not enabled in protocol v1");
  if (
    artifacts.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION ||
    !Array.isArray(artifacts.kinds) ||
    artifacts.kinds.length !== INTEGRATION_ARTIFACT_KINDS.length ||
    artifacts.kinds.some((kind, index) => kind !== INTEGRATION_ARTIFACT_KINDS[index])
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
    attachments: Object.freeze({ enabled: false }),
    artifacts: Object.freeze({
      kinds: Object.freeze([...INTEGRATION_ARTIFACT_KINDS]),
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    }),
  });
}

function assertPublicThreadContract(value = {}) {
  const thread = integrationExactKeys(
    value,
    ["id", "title", "status", "revision", "createdAt", "updatedAt", "lastRunId", "authority", "replay", "messages"],
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
      integrationExactKeys(message, ["id", "role", "content", "runId", "createdAt", "digest"], `thread message[${index}]`, [
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
