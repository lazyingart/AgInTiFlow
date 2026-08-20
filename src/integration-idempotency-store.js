import fs from "node:fs/promises";
import path from "node:path";
import {
  INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
  INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS,
} from "./integration-api.js";
import {
  INTEGRATION_RPC_PATHS,
  contractDigest,
  integrationRpcPathIsMutation,
  validateIntegrationIdempotencyKey,
} from "./integration-policy.js";
import {
  assertDigest,
  assertSafeSegment,
  assertSealedObject,
  atomicWriteProtectedJson,
  authorityFail,
  currentProcessOwner,
  ensureOwnerOnlyDirectory,
  ensureStoreLayout,
  listFilesRecursive,
  normalizeProcessIdentity,
  nowIso,
  parseIsoMs,
  processOwnerLiveness,
  readProtectedJsonFile,
  relativePointer,
  sealObject,
  sha256Text,
  withDirectoryLock,
} from "./integration-durable-common.js";

export const IDEMPOTENCY_STORE_SCHEMA_VERSION = "aginti-integration-idempotency-store-v1";
export const IDEMPOTENCY_RECORD_SCHEMA_VERSION = "aginti-integration-idempotency-record-v1";
export const IDEMPOTENCY_RESPONSE_SCHEMA_VERSION = "aginti-integration-idempotency-response-v1";
export const IDEMPOTENCY_RECORD_INTEGRITY_DOMAIN = "aginti-integration-idempotency-record";
export const IDEMPOTENCY_RESPONSE_INTEGRITY_DOMAIN = "aginti-integration-idempotency-response";
export const IDEMPOTENCY_REQUEST_HASH_ALGORITHM = "canonical-json-v1";
export const IDEMPOTENCY_RESPONSE_ENVELOPE = "aginti-agent-rpc-v1";
export const IDEMPOTENCY_RECOVERY_AUTHORITY_VERSION = "aginti-integration-idempotency-recovery-authority-v1";

const DEFAULT_PENDING_LEASE_MS = 30_000;
const DEFAULT_LOCK_WAIT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const DEFAULT_RECORD_CAP = 10_000;
const RESPONSE_MAX_BYTES = 256 * 1024;
const ZERO_DIGEST = "0".repeat(64);
const OWNER_TOKEN_PATTERN = /^[a-f0-9]{32,128}$/u;
const RECOVERY_STAGES = new Set([
  "before-dispatch",
  "after-dispatch-before-result",
  "after-result-before-public-response",
]);
const PRIVATE_RUNTIME_PATTERN =
  /(?:^|[\s("'`])(?:\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/[^\s"'`<>)\]]*)?|[A-Za-z]:\\[^\s"'`<>)\]]*|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^"',}\s]+)/iu;

function safeIsoPlus(now, deltaMs) {
  return new Date(now.getTime() + deltaMs).toISOString();
}

function assertPrincipalId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/u.test(value)) {
    authorityFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency principal scope is invalid.", { status: 400 });
  }
  return value;
}

function assertBrowserSessionId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    authorityFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency browser session scope is invalid.", { status: 400 });
  }
  return value;
}

function assertMutationPath(pathname) {
  const pathText = String(pathname || "");
  if (!Object.values(INTEGRATION_RPC_PATHS).includes(pathText) || !integrationRpcPathIsMutation(pathText)) {
    authorityFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency path is not a supported mutation.", { status: 400 });
  }
  return pathText;
}

function publicErrorCode(error) {
  const text = String(error?.publicCode || error?.code || "");
  return /^[A-Z0-9_]{1,80}$/u.test(text) ? text : "INTERNAL_ERROR";
}

function publicErrorStatus(error) {
  const status = Number(error?.statusCode || error?.status);
  if (Number.isSafeInteger(status) && status >= 400 && status <= 599) return status;
  return 500;
}

function assertNoPrivateReceiptText(value, label) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES) authorityFail("IDEMPOTENCY_RESULT_TOO_LARGE", `${label} is too large.`);
  if (PRIVATE_RUNTIME_PATTERN.test(text)) {
    authorityFail("IDEMPOTENCY_UNSAFE_RESULT", `${label} contains private runtime content.`, { status: 500 });
  }
}

function assertPublicResponseEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== "1") {
    authorityFail("IDEMPOTENCY_UNSAFE_RESULT", "Mutation response is not a public schemaVersion 1 envelope.", {
      status: 500,
    });
  }
  assertNoPrivateReceiptText(value, "Mutation response");
  return value;
}

function responseActionDigest(pathname) {
  return contractDigest({ responseEnvelope: IDEMPOTENCY_RESPONSE_ENVELOPE, pathname });
}

function responsePointerFor(pathname, digest) {
  return relativePointer("responses", responseActionDigest(pathname), `${assertDigest(digest, "response digest")}.json`);
}

function responseReceiptFor(pathname, response, responseBytes) {
  const digest = contractDigest(response);
  return Object.freeze({
    kind: "public-rpc-response",
    pointer: responsePointerFor(pathname, digest),
    digest,
    bytes: responseBytes,
    schemaVersion: "1",
  });
}

function completedRecord(record, updatedAt, result) {
  const {
    failure: _failure,
    leaseExpiresAt: _leaseExpiresAt,
    pendingOwner: _pendingOwner,
    recoveryStage: _recoveryStage,
    result: _result,
    ...base
  } = record;
  return {
    ...base,
    state: "completed",
    updatedAt,
    result,
  };
}

function failedRecord(record, updatedAt, failure) {
  const {
    failure: _failure,
    leaseExpiresAt: _leaseExpiresAt,
    pendingOwner: _pendingOwner,
    recoveryStage: _recoveryStage,
    result: _result,
    ...base
  } = record;
  return {
    ...base,
    state: "failed",
    updatedAt,
    failure,
  };
}

function normalizeContext(context = {}) {
  const principalId = assertPrincipalId(context.principalId);
  const browserSessionId = assertBrowserSessionId(context.browserSessionId);
  const pathname = assertMutationPath(context.pathname);
  const idempotencyKey = validateIntegrationIdempotencyKey(context.idempotencyKey);
  const requestHash = assertDigest(context.requestHash, "requestHash");
  if (context.requestHashAlgorithm !== IDEMPOTENCY_REQUEST_HASH_ALGORITHM) {
    authorityFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency request hash algorithm is unsupported.", { status: 400 });
  }
  if (context.responseEnvelope !== IDEMPOTENCY_RESPONSE_ENVELOPE) {
    authorityFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency response envelope is unsupported.", { status: 400 });
  }
  return Object.freeze({
    principalId,
    browserSessionId,
    pathname,
    idempotencyKey,
    requestHash,
    requestHashAlgorithm: IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
    responseEnvelope: IDEMPOTENCY_RESPONSE_ENVELOPE,
  });
}

function requestIndex(scope) {
  return contractDigest({
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    pathname: scope.pathname,
    idempotencyKey: scope.idempotencyKey,
  });
}

function validatePendingOwner(owner = {}) {
  if (
    !owner ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    owner.schemaVersion !== "aginti-process-owner-v1" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    typeof owner.token !== "string" ||
    !OWNER_TOKEN_PATTERN.test(owner.token)
  ) {
    authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending owner is invalid.");
  }
  if (!normalizeProcessIdentity(owner.processIdentity)) {
    authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending owner process identity is invalid.");
  }
  parseIsoMs(owner.acquiredAt, "pending owner acquiredAt");
  parseIsoMs(owner.heartbeatAt, "pending owner heartbeatAt");
  return owner;
}

function samePendingOwner(left = {}, right = {}) {
  return Boolean(left?.token && right?.token && left.token === right.token);
}

function validateRecord(record, index) {
  assertSealedObject(record, IDEMPOTENCY_RECORD_INTEGRITY_DOMAIN, "idempotency record");
  if (record.schemaVersion !== IDEMPOTENCY_RECORD_SCHEMA_VERSION) {
    authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency record schema is unsupported.");
  }
  if (
    record.owner !== "aginti" ||
    record.contractVersion !== INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION ||
    record.index !== index ||
    !["pending", "completed", "failed"].includes(record.state)
  ) {
    authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency record authority fields are invalid.");
  }
  assertPrincipalId(record.principalId);
  assertBrowserSessionId(record.browserSessionId);
  assertMutationPath(record.pathname);
  assertDigest(record.requestHash, "record requestHash");
  assertDigest(record.keyDigest, "record keyDigest");
  parseIsoMs(record.createdAt, "record createdAt");
  parseIsoMs(record.updatedAt, "record updatedAt");
  parseIsoMs(record.expiresAt, "record expiresAt");
  if (record.state === "pending") {
    parseIsoMs(record.leaseExpiresAt, "record leaseExpiresAt");
    validatePendingOwner(record.pendingOwner);
    if (!RECOVERY_STAGES.has(record.recoveryStage)) {
      authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending recovery stage is invalid.");
    }
  }
  if (record.state === "pending" && record.recoveryStage !== "after-result-before-public-response" && record.result) {
    authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending record has an unexpected result receipt.");
  }
  if (record.state === "completed" || (record.state === "pending" && record.recoveryStage === "after-result-before-public-response")) {
    validateResponseReceipt(record.result || {}, record.pathname);
  }
  if (record.state === "failed") {
    const failure = record.failure || {};
    if (
      typeof failure.code !== "string" ||
      !/^[A-Z0-9_]{1,80}$/u.test(failure.code) ||
      !Number.isSafeInteger(failure.status) ||
      failure.status < 400 ||
      failure.status > 599 ||
      failure.messageDigest !== assertDigest(failure.messageDigest || ZERO_DIGEST, "failure messageDigest")
    ) {
      authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency failure receipt is invalid.");
    }
  }
  return record;
}

function validateResponseReceipt(receipt = {}, pathname = "") {
  const digest = assertDigest(receipt.digest, "result digest");
  const expectedPointer = responsePointerFor(assertMutationPath(pathname), digest);
  if (
    receipt.kind !== "public-rpc-response" ||
    typeof receipt.pointer !== "string" ||
    !/^responses\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/u.test(receipt.pointer) ||
    receipt.pointer !== expectedPointer ||
    receipt.digest !== digest ||
    receipt.schemaVersion !== "1" ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes < 1 ||
    receipt.bytes > RESPONSE_MAX_BYTES
  ) {
    authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency result receipt is invalid.");
  }
  return receipt;
}

function sameScope(record, scope) {
  return (
    record.principalId === scope.principalId &&
    record.browserSessionId === scope.browserSessionId &&
    record.pathname === scope.pathname
  );
}

function conflictError() {
  const error = new Error("Idempotency key conflict.");
  error.code = "IDEMPOTENCY_CONFLICT";
  error.publicCode = "IDEMPOTENCY_CONFLICT";
  error.status = 409;
  return error;
}

function previousFailureError(record) {
  const error = new Error("Idempotent mutation previously failed.");
  error.code = record.failure.code;
  error.publicCode = record.failure.code;
  error.status = record.failure.status;
  return error;
}

function pendingError() {
  const error = new Error("Idempotent mutation is already pending.");
  error.code = "IDEMPOTENCY_PENDING";
  error.publicCode = "IDEMPOTENCY_PENDING";
  error.status = 409;
  return error;
}

function recoveryRequiredError() {
  const error = new Error("Expired pending idempotency record requires runtime recovery.");
  error.code = "IDEMPOTENCY_RECOVERY_REQUIRED";
  error.publicCode = "IDEMPOTENCY_RECOVERY_REQUIRED";
  error.status = 503;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRecordBase(scope, index, now, retentionMs) {
  return {
    schemaVersion: IDEMPOTENCY_RECORD_SCHEMA_VERSION,
    owner: "aginti",
    contractVersion: INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
    index,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    pathname: scope.pathname,
    keyDigest: sha256Text(scope.idempotencyKey),
    requestHash: scope.requestHash,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: safeIsoPlus(now, retentionMs),
  };
}

export function createSealedIntegrationIdempotencyRecord(input = {}) {
  return sealObject(input, IDEMPOTENCY_RECORD_INTEGRITY_DOMAIN);
}

function recoveryAuthoritySnapshot(recoveryAuthority = {}, hasRecoverPending = false) {
  const proof = {
    schemaVersion: IDEMPOTENCY_RECOVERY_AUTHORITY_VERSION,
    owner: recoveryAuthority.owner === "aginti" ? "aginti" : "",
    explicit: recoveryAuthority.explicit === true && hasRecoverPending,
    blindRedispatch: false,
    beforeDispatchRecovery: recoveryAuthority.beforeDispatchRecovery === true,
    afterDispatchBeforeResultRecovery: recoveryAuthority.afterDispatchBeforeResultRecovery === true,
    afterResultBeforePublicResponseRecovery: recoveryAuthority.afterResultBeforePublicResponseRecovery === true,
  };
  return Object.freeze({ ...proof, digest: contractDigest(proof) });
}

function recoveryAuthorityIsReady(proof = {}) {
  const expectedDigest = contractDigest({
    schemaVersion: proof.schemaVersion,
    owner: proof.owner,
    explicit: proof.explicit,
    blindRedispatch: proof.blindRedispatch,
    beforeDispatchRecovery: proof.beforeDispatchRecovery,
    afterDispatchBeforeResultRecovery: proof.afterDispatchBeforeResultRecovery,
    afterResultBeforePublicResponseRecovery: proof.afterResultBeforePublicResponseRecovery,
  });
  return (
    proof.schemaVersion === IDEMPOTENCY_RECOVERY_AUTHORITY_VERSION &&
    proof.owner === "aginti" &&
    proof.explicit === true &&
    proof.blindRedispatch === false &&
    proof.beforeDispatchRecovery === true &&
    proof.afterDispatchBeforeResultRecovery === true &&
    proof.afterResultBeforePublicResponseRecovery === true &&
    proof.digest === expectedDigest
  );
}

export function integrationIdempotencyPaths(rootDir, context = {}) {
  const scope = normalizeContext({
    ...context,
    requestHashAlgorithm: context.requestHashAlgorithm || IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
    responseEnvelope: context.responseEnvelope || IDEMPOTENCY_RESPONSE_ENVELOPE,
  });
  const index = requestIndex(scope);
  return Object.freeze({
    index,
    record: path.join(path.resolve(rootDir), "records", index.slice(0, 2), `${index}.json`),
    lock: path.join(path.resolve(rootDir), "locks", `${index}.lock`),
  });
}

export function createFileIntegrationIdempotencyStore(options = {}) {
  if (!options.rootDir) authorityFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Idempotency rootDir is required.");
  const rootDir = path.resolve(String(options.rootDir || ""));
  const retentionMs = Math.min(Number(options.retentionMs || INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS), INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS);
  const pendingLeaseMs = Number(options.pendingLeaseMs || DEFAULT_PENDING_LEASE_MS);
  const recordCap = Number(options.recordCap || DEFAULT_RECORD_CAP);
  const lockWaitMs = Number(options.lockWaitMs || DEFAULT_LOCK_WAIT_MS);
  const staleLockMs = Number(options.staleLockMs || DEFAULT_STALE_LOCK_MS);
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const recoverPending = typeof options.recoverPending === "function" ? options.recoverPending : null;
  const recoveryAuthority = options.recoveryAuthority || {};
  const recoveryProof = recoveryAuthoritySnapshot(recoveryAuthority, recoverPending !== null);
  const faultInjector = typeof options.faultInjector === "function" ? options.faultInjector : null;
  const processOwnerTestHooks = options.processOwnerTestHooks && typeof options.processOwnerTestHooks === "object" ? options.processOwnerTestHooks : {};

  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1000 || retentionMs > INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS) {
    authorityFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Idempotency retention must be within 1s-24h.");
  }
  if (!Number.isSafeInteger(pendingLeaseMs) || pendingLeaseMs < 100 || pendingLeaseMs > retentionMs) {
    authorityFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Idempotency pending lease is invalid.");
  }
  if (!Number.isSafeInteger(recordCap) || recordCap < 1 || recordCap > 1_000_000) {
    authorityFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Idempotency record cap is invalid.");
  }

  let layoutPromise = null;
  async function layout() {
    layoutPromise ||= ensureStoreLayout(rootDir, ["records", "responses", "locks"]).then(async (dirs) => {
      const metaPath = path.join(dirs.root, "store.json");
      const meta = {
        schemaVersion: IDEMPOTENCY_STORE_SCHEMA_VERSION,
        owner: "aginti",
        contractVersion: INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
        requestHashAlgorithm: IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
        responseEnvelope: IDEMPOTENCY_RESPONSE_ENVELOPE,
        createdAt: nowIso(now),
      };
      const existing = await readProtectedJsonFile(metaPath, { optional: true, maxBytes: 4096 });
      if (existing) {
        if (
          existing.schemaVersion !== IDEMPOTENCY_STORE_SCHEMA_VERSION ||
          existing.owner !== "aginti" ||
          existing.contractVersion !== INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION ||
          existing.requestHashAlgorithm !== IDEMPOTENCY_REQUEST_HASH_ALGORITHM ||
          existing.responseEnvelope !== IDEMPOTENCY_RESPONSE_ENVELOPE
        ) {
          authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency store metadata is unsupported.");
        }
      } else {
        await atomicWriteProtectedJson(metaPath, meta);
      }
      return dirs;
    });
    return layoutPromise;
  }

  function pathsForIndex(dirs, index) {
    assertSafeSegment(index, "idempotency index");
    return {
      recordDir: path.join(dirs.records, index.slice(0, 2)),
      record: path.join(dirs.records, index.slice(0, 2), `${index}.json`),
      responseForDigest: (pathname, digest) => path.join(dirs.root, responsePointerFor(pathname, digest)),
      responsePointerForDigest: (pathname, digest) => responsePointerFor(pathname, digest),
      lock: path.join(dirs.locks, `${index}.lock`),
      responseLock: path.join(dirs.locks, "responses.lock"),
      transactionLock: path.join(dirs.locks, "transactions.lock"),
    };
  }

  async function readRecord(filePath, index) {
    const record = await readProtectedJsonFile(filePath, { optional: true, maxBytes: 64 * 1024 });
    return record ? validateRecord(record, index) : null;
  }

  async function writeRecord(filePath, record, phase = "record") {
    if (faultInjector) await faultInjector({ phase, filePath, record: JSON.parse(JSON.stringify(record)) });
    await atomicWriteProtectedJson(filePath, createSealedIntegrationIdempotencyRecord(record));
  }

  async function deleteRecord(filePath) {
    await fs.rm(filePath, { force: true }).catch(() => {});
  }

  async function collectLiveResponsePointers(dirs, nowMs) {
    const pointers = new Set();
    const files = await listFilesRecursive(dirs.records, { suffix: ".json" });
    for (const file of files) {
      const index = path.basename(file, ".json");
      const record = await readRecord(file, index);
      const rootsCompletedResponse = record?.state === "completed" && parseIsoMs(record.expiresAt, "record expiresAt") > nowMs;
      const rootsPendingReceipt =
        record?.state === "pending" && record.recoveryStage === "after-result-before-public-response";
      if ((rootsCompletedResponse || rootsPendingReceipt) && record.result?.digest) {
        pointers.add(validateResponseReceipt(record.result, record.pathname).pointer);
      }
    }
    return pointers;
  }

  function responsePointerFromFile(dirs, file) {
    const relative = path.relative(dirs.root, file).split(path.sep).join("/");
    if (!/^responses\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/u.test(relative)) {
      authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency response sidecar path is invalid.");
    }
    return relative;
  }

  async function pruneOrphanResponses(dirs, livePointers) {
    const files = await listFilesRecursive(dirs.responses, { suffix: ".json" });
    for (const file of files) {
      const pointer = responsePointerFromFile(dirs, file);
      if (!livePointers.has(pointer)) await fs.rm(file, { force: true }).catch(() => {});
    }
  }

  async function livePendingRetentionAction(record, nowMs) {
    if (record.state !== "pending") return "expire";
    const liveness = await processOwnerLiveness(record.pendingOwner, { testHooks: processOwnerTestHooks });
    if (liveness === "alive") return "extend";
    if (liveness === "unknown") return "preserve";
    if (parseIsoMs(record.leaseExpiresAt, "record leaseExpiresAt") > nowMs) return "preserve";
    if (record.recoveryStage === "after-result-before-public-response") return "recover-persisted";
    return "recover-authority";
  }

  async function extendLivePendingRetention(filePath, record) {
    const extendedAt = now();
    const extended = {
      ...record,
      updatedAt: extendedAt.toISOString(),
      expiresAt: safeIsoPlus(extendedAt, retentionMs),
    };
    await writeRecord(filePath, extended, "pending-retention-extended");
    return extended;
  }

  async function handleExpiredRecordWithHeldLock(filePath, record, nowMs) {
    const action = await livePendingRetentionAction(record, nowMs);
    if (action === "extend") return { live: true, record: await extendLivePendingRetention(filePath, record) };
    if (action === "preserve") return { live: true, record };
    if (action === "recover-persisted" || action === "recover-authority") return { live: true, record, recoveryAction: action };
    await deleteRecord(filePath);
    return { live: false, record: null };
  }

  async function recoverExpiredRecordWithAuthority(dirs, paths, record) {
    if (record.recoveryStage === "after-result-before-public-response") {
      return withDirectoryLock(
        paths.responseLock,
        () => completePersistedRecoveredRecord(dirs, paths, record),
        { waitMs: lockWaitMs, staleMs: staleLockMs }
      );
    }
    if (!recoveryAuthorityIsReady(recoveryProof)) throw recoveryRequiredError();
    const recovered = await recoverPendingWithAuthority(record);
    if (!recovered) throw recoveryRequiredError();
    return withDirectoryLock(
      paths.responseLock,
      () => completeRecoveredRecord(dirs, paths, record, recovered),
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function pruneExpiredRecord(dirs, file, index, nowMs) {
    const paths = pathsForIndex(dirs, index);
    return withDirectoryLock(
      paths.lock,
      async () => {
        const record = await readRecord(file, index);
        if (!record) return false;
        if (parseIsoMs(record.expiresAt, "record expiresAt") > nowMs) return true;
        if (faultInjector) await faultInjector({ phase: "prune-expired-record-read", filePath: file, record: JSON.parse(JSON.stringify(record)) });
        const retained = await handleExpiredRecordWithHeldLock(file, record, nowMs);
        if (!retained.recoveryAction) return retained.live;
        try {
          await recoverExpiredRecordWithAuthority(dirs, paths, retained.record);
        } catch (error) {
          if (error?.code !== "IDEMPOTENCY_RECOVERY_REQUIRED") throw error;
        }
        return true;
      },
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function pruneExpired(dirs, responseLock, nowMs = Date.parse(nowIso(now))) {
    const files = await listFilesRecursive(dirs.records, { suffix: ".json" });
    let live = 0;
    for (const file of files) {
      const index = path.basename(file, ".json");
      if (await pruneExpiredRecord(dirs, file, index, nowMs)) live += 1;
    }
    await withDirectoryLock(
      responseLock,
      async () => {
        await pruneOrphanResponses(dirs, await collectLiveResponsePointers(dirs, nowMs));
      },
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
    return live;
  }

  async function assertCapacityAndPrune(paths, dirs) {
    if ((await pruneExpired(dirs, paths.responseLock)) >= recordCap) {
      authorityFail("IDEMPOTENCY_STORE_FULL", "Idempotency record cap is exhausted.");
    }
  }

  async function loadResponse(dirs, record) {
    validateResponseReceipt(record.result, record.pathname);
    const responsePath = path.join(dirs.root, record.result.pointer);
    if (path.dirname(responsePath) !== dirs.responses) {
      if (path.dirname(path.dirname(responsePath)) !== dirs.responses) {
        authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency response pointer is outside the response directory.");
      }
    }
    if (!responsePath.startsWith(`${dirs.responses}${path.sep}`)) {
      authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency response pointer is outside the response directory.");
    }
    if (faultInjector) {
      await faultInjector({
        phase: "response-load-before-read",
        filePath: responsePath,
        record: JSON.parse(JSON.stringify(record)),
      });
    }
    const envelope = await readProtectedJsonFile(responsePath, { maxBytes: RESPONSE_MAX_BYTES + 4096 });
    assertSealedObject(envelope, IDEMPOTENCY_RESPONSE_INTEGRITY_DOMAIN, "idempotency response");
    if (
      envelope.schemaVersion !== IDEMPOTENCY_RESPONSE_SCHEMA_VERSION ||
      envelope.owner !== "aginti" ||
      envelope.pathname !== record.pathname ||
      envelope.digest !== record.result.digest ||
      envelope.responseDigest !== contractDigest(envelope.response)
    ) {
      authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency response sidecar is invalid.");
    }
    assertPublicResponseEnvelope(envelope.response);
    const responseBytes = Buffer.byteLength(JSON.stringify(envelope.response), "utf8");
    if (contractDigest(envelope.response) !== record.result.digest || responseBytes !== record.result.bytes) {
      authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency response digest mismatch.");
    }
    return JSON.parse(JSON.stringify(envelope.response));
  }

  async function writeResponse(dirs, pathname, response) {
    const publicResponse = assertPublicResponseEnvelope(response);
    const digest = contractDigest(publicResponse);
    const actionDigest = responseActionDigest(pathname);
    const responsePath = path.join(dirs.responses, actionDigest, `${digest}.json`);
    const responseBytes = Buffer.byteLength(JSON.stringify(publicResponse), "utf8");
    const envelope = sealObject(
      {
        schemaVersion: IDEMPOTENCY_RESPONSE_SCHEMA_VERSION,
        owner: "aginti",
        pathname,
        digest,
        responseDigest: digest,
        response: publicResponse,
      },
      IDEMPOTENCY_RESPONSE_INTEGRITY_DOMAIN
    );
    const existing = await readProtectedJsonFile(responsePath, { optional: true, maxBytes: RESPONSE_MAX_BYTES + 4096 });
    if (existing) {
      assertSealedObject(existing, IDEMPOTENCY_RESPONSE_INTEGRITY_DOMAIN, "idempotency response");
      if (
        existing.schemaVersion !== IDEMPOTENCY_RESPONSE_SCHEMA_VERSION ||
        existing.owner !== "aginti" ||
        existing.pathname !== pathname ||
        existing.digest !== digest ||
        existing.responseDigest !== digest ||
        contractDigest(existing.response) !== digest
      ) {
        authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency response sidecar collision is invalid.");
      }
      assertPublicResponseEnvelope(existing.response);
      return responseReceiptFor(pathname, publicResponse, responseBytes);
    }
    await atomicWriteProtectedJson(responsePath, envelope);
    if (faultInjector) {
      await faultInjector({
        phase: "response-sidecar-written",
        filePath: responsePath,
        record: {
          pathname,
          digest,
          pointer: responsePointerFor(pathname, digest),
          bytes: responseBytes,
        },
      });
    }
    return responseReceiptFor(pathname, publicResponse, responseBytes);
  }

  async function completeRecoveredRecord(dirs, paths, record, response) {
    const updatedAt = now();
    const result = await writeResponse(dirs, record.pathname, response);
    await writeRecord(
      paths.record,
      completedRecord({ ...record, expiresAt: safeIsoPlus(updatedAt, retentionMs) }, updatedAt.toISOString(), result),
      "recovered-completed"
    );
    return response;
  }

  async function completePersistedRecoveredRecord(dirs, paths, record) {
    const updatedAt = now();
    const response = await loadResponse(dirs, record);
    await writeRecord(
      paths.record,
      completedRecord({ ...record, expiresAt: safeIsoPlus(updatedAt, retentionMs) }, updatedAt.toISOString(), record.result),
      "persisted-recovered-completed"
    );
    return response;
  }

  async function recoverPendingWithAuthority(record) {
    if (!recoverPending || !recoveryAuthorityIsReady(recoveryProof)) throw recoveryRequiredError();
    return recoverPending({
      principalId: record.principalId,
      browserSessionId: record.browserSessionId,
      pathname: record.pathname,
      requestHash: record.requestHash,
      idempotencyKeyDigest: record.keyDigest,
      createdAt: record.createdAt,
      recoveryStage: record.recoveryStage,
      responseReceipt: record.result || null,
    });
  }

  async function pendingOwnerIsRecoverable(record) {
    const liveness = await processOwnerLiveness(record.pendingOwner, { testHooks: processOwnerTestHooks });
    if (liveness === "alive") return false;
    if (liveness !== "dead") throw recoveryRequiredError();
    return true;
  }

  async function handleExisting(dirs, paths, record, scope) {
    if (!sameScope(record, scope) || record.requestHash !== scope.requestHash) throw conflictError();
    const nowMs = Date.parse(nowIso(now));
    if (record.state === "pending" && parseIsoMs(record.expiresAt, "record expiresAt") <= nowMs) {
      const refreshed = await handleExpiredRecordWithHeldLock(paths.record, record, nowMs);
      record = refreshed.record;
    }
    if (record.state !== "pending" && parseIsoMs(record.expiresAt, "record expiresAt") <= nowMs) {
      await deleteRecord(paths.record);
      return null;
    }
    if (record.state === "completed") return loadResponse(dirs, record);
    if (record.state === "failed") throw previousFailureError(record);
    if (record.recoveryStage === "after-result-before-public-response") {
      return withDirectoryLock(
        paths.responseLock,
        () => completePersistedRecoveredRecord(dirs, paths, record),
        { waitMs: lockWaitMs, staleMs: staleLockMs }
      );
    }
    if (parseIsoMs(record.leaseExpiresAt, "record leaseExpiresAt") > nowMs) throw pendingError();
    if (!(await pendingOwnerIsRecoverable(record))) throw pendingError();
    const recovered = await recoverPendingWithAuthority(record);
    if (!recovered) throw recoveryRequiredError();
    return withDirectoryLock(
      paths.responseLock,
      () => completeRecoveredRecord(dirs, paths, record, recovered),
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function ensureCapacity(paths, dirs) {
    await withDirectoryLock(
      paths.transactionLock,
      () => assertCapacityAndPrune(paths, dirs),
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function claimNewWithCapacity(dirs, paths, index, scope) {
    return withDirectoryLock(
      paths.transactionLock,
      async () => {
        await assertCapacityAndPrune(paths, dirs);
        return withDirectoryLock(
          paths.lock,
          async () => {
            const existing = await readRecord(paths.record, index);
            if (existing) return Object.freeze({ retryExisting: true });
            const claimedAt = now();
            const pendingOwner = await currentProcessOwner({ now });
            const pending = buildRecordBase(scope, index, claimedAt, retentionMs);
            await writeRecord(paths.record, {
              ...pending,
              state: "pending",
              pendingOwner,
              recoveryStage: "before-dispatch",
              leaseExpiresAt: safeIsoPlus(claimedAt, pendingLeaseMs),
            }, "pending-before-dispatch");

            await writeRecord(paths.record, {
              ...pending,
              state: "pending",
              pendingOwner,
              recoveryStage: "after-dispatch-before-result",
              leaseExpiresAt: safeIsoPlus(claimedAt, pendingLeaseMs),
            }, "pending-after-dispatch");
            return Object.freeze({ dispatch: true, pending: { ...pending, pendingOwner } });
          },
          { waitMs: lockWaitMs, staleMs: staleLockMs }
        );
      },
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function markFailedIfStillPending(paths, index, scope, pending, error) {
    await withDirectoryLock(
      paths.lock,
      async () => {
        const latest = await readRecord(paths.record, index);
        if (
          !latest ||
          !sameScope(latest, scope) ||
          latest.requestHash !== scope.requestHash ||
          latest.state !== "pending" ||
          latest.recoveryStage === "after-result-before-public-response" ||
          !samePendingOwner(latest.pendingOwner, pending.pendingOwner)
        ) {
          return;
        }
        const failedAt = now();
        await writeRecord(
          paths.record,
          failedRecord(pending, failedAt.toISOString(), {
            code: publicErrorCode(error),
            status: publicErrorStatus(error),
            messageDigest: sha256Text(error?.message || publicErrorCode(error)),
          }),
          "failed"
        );
      },
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function heartbeatPending(paths, index, scope, pending) {
    await withDirectoryLock(
      paths.lock,
      async () => {
        const latest = await readRecord(paths.record, index);
        if (
          !latest ||
          !sameScope(latest, scope) ||
          latest.requestHash !== scope.requestHash ||
          latest.state !== "pending" ||
          latest.recoveryStage !== "after-dispatch-before-result" ||
          !samePendingOwner(latest.pendingOwner, pending.pendingOwner)
        ) {
          return;
        }
        const heartbeatAt = now();
        await writeRecord(paths.record, {
          ...latest,
          updatedAt: heartbeatAt.toISOString(),
          leaseExpiresAt: safeIsoPlus(heartbeatAt, pendingLeaseMs),
          pendingOwner: {
            ...latest.pendingOwner,
            heartbeatAt: heartbeatAt.toISOString(),
          },
        }, "pending-heartbeat");
      },
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function runWithPendingHeartbeat(paths, index, scope, pending, handler) {
    let stopped = false;
    let heartbeatFailure = null;
    const intervalMs = Math.max(25, Math.min(250, Math.floor(pendingLeaseMs / 3)));
    const heartbeatLoop = (async () => {
      while (!stopped) {
        await delay(intervalMs);
        if (stopped) break;
        try {
          await heartbeatPending(paths, index, scope, pending);
        } catch (error) {
          heartbeatFailure = error;
          stopped = true;
        }
      }
    })();
    try {
      const response = await handler();
      if (heartbeatFailure) throw heartbeatFailure;
      return response;
    } finally {
      stopped = true;
      await heartbeatLoop.catch(() => {});
    }
  }

  async function finalizeCompleted(paths, index, scope, pending, result) {
    await withDirectoryLock(
      paths.lock,
      async () => {
        const latest = await readRecord(paths.record, index);
        if (
          !latest ||
          !sameScope(latest, scope) ||
          latest.requestHash !== scope.requestHash ||
          latest.state !== "pending" ||
          !samePendingOwner(latest.pendingOwner, pending.pendingOwner)
        ) {
          authorityFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending record changed before completion.");
        }
        const completedAt = now();
        const afterResult = {
          ...latest,
          state: "pending",
          recoveryStage: "after-result-before-public-response",
          leaseExpiresAt: latest.leaseExpiresAt,
          result,
        };
        await writeRecord(paths.record, afterResult, "after-result-receipt");
        await writeRecord(paths.record, completedRecord(afterResult, completedAt.toISOString(), result), "final-completed");
      },
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function publishResponseAndFinalize(dirs, paths, index, scope, pending, response) {
    return withDirectoryLock(
      paths.responseLock,
      async () => {
        const result = await writeResponse(dirs, scope.pathname, response);
        await finalizeCompleted(paths, index, scope, pending, result);
        return result;
      },
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function runMutation(context, handler) {
    const scope = normalizeContext(context);
    const dirs = await layout();
    const index = requestIndex(scope);
    const paths = pathsForIndex(dirs, index);
    await ensureOwnerOnlyDirectory(paths.recordDir, { label: "idempotency record shard" });
    const started = Date.now();
    let claim;
    for (;;) {
      claim = await withDirectoryLock(
        paths.lock,
        async () => {
          const existing = await readRecord(paths.record, index);
          if (existing) {
            try {
              const response = await handleExisting(dirs, paths, existing, scope);
              if (response) return Object.freeze({ dispatch: false, response });
            } catch (error) {
              if (error?.code === "IDEMPOTENCY_PENDING") return Object.freeze({ dispatch: false, waitPending: true });
              throw error;
            }
          }

          return Object.freeze({ needsCapacityClaim: true });
        },
        { waitMs: lockWaitMs, staleMs: staleLockMs }
      );
      if (claim.needsCapacityClaim) claim = await claimNewWithCapacity(dirs, paths, index, scope);
      if (claim.retryExisting) continue;
      if (!claim.waitPending) break;
      if (Date.now() - started > lockWaitMs) throw pendingError();
      await delay(15);
    }
    if (!claim.dispatch) return claim.response;

    let response;
    let result;
    try {
      response = await runWithPendingHeartbeat(paths, index, scope, claim.pending, handler);
    } catch (error) {
      await markFailedIfStillPending(paths, index, scope, claim.pending, error);
      throw error;
    }
    try {
      await publishResponseAndFinalize(dirs, paths, index, scope, claim.pending, response);
    } catch (error) {
      await markFailedIfStillPending(paths, index, scope, claim.pending, error);
      throw error;
    }
    return response;
  }

  async function recoverExpiredPending() {
    const dirs = await layout();
    const recovered = [];
    const files = await withDirectoryLock(
      path.join(dirs.locks, "transactions.lock"),
      () => listFilesRecursive(dirs.records, { suffix: ".json" }),
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
    for (const file of files) {
      const index = path.basename(file, ".json");
      const paths = pathsForIndex(dirs, index);
      await withDirectoryLock(
        paths.lock,
        async () => {
          const record = await readRecord(paths.record, index);
          if (!record || record.state !== "pending") return;
          if (parseIsoMs(record.leaseExpiresAt, "record leaseExpiresAt") > Date.parse(nowIso(now))) return;
          if (record.recoveryStage === "after-result-before-public-response") {
            await withDirectoryLock(
              paths.responseLock,
              () => completePersistedRecoveredRecord(dirs, paths, record),
              { waitMs: lockWaitMs, staleMs: staleLockMs }
            );
            recovered.push(index);
            return;
          }
          if (!(await pendingOwnerIsRecoverable(record))) return;
          if (!recoveryAuthorityIsReady(recoveryProof)) return;
          const response = await recoverPendingWithAuthority(record);
          if (!response) return;
          await withDirectoryLock(
            paths.responseLock,
            () => completeRecoveredRecord(dirs, paths, record, response),
            { waitMs: lockWaitMs, staleMs: staleLockMs }
          );
          recovered.push(index);
        },
        { waitMs: lockWaitMs, staleMs: staleLockMs }
      );
    }
    return Object.freeze({ recovered: Object.freeze(recovered) });
  }

  return Object.freeze({
    owner: "aginti",
    contractVersion: INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
    durable: true,
    crossProcessSafe: true,
    atomicLookupAndDispatch: true,
    atomicClaim: true,
    atomicComplete: true,
    failOrRecoverOnHandlerError: true,
    noStrandedPendingOnHandlerError: true,
    requestHashBound: true,
    principalBound: true,
    browserSessionBound: true,
    sameKeySameRequestReplays: true,
    sameKeyDifferentRequestStatus: 409,
    idempotencyWindowMs: retentionMs,
    testOnly: false,
    requestHashAlgorithm: IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
    responseEnvelope: IDEMPOTENCY_RESPONSE_ENVELOPE,
    recoveryAuthority: recoveryProof,
    runMutation,
    recoverExpiredPending,
    pathsForRequest: (context) => integrationIdempotencyPaths(rootDir, context),
    inspectRecord: async (context) => {
      const dirs = await layout();
      const scope = normalizeContext({
        ...context,
        requestHashAlgorithm: context.requestHashAlgorithm || IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
        responseEnvelope: context.responseEnvelope || IDEMPOTENCY_RESPONSE_ENVELOPE,
      });
      const index = requestIndex(scope);
      return readRecord(pathsForIndex(dirs, index).record, index);
    },
  });
}
