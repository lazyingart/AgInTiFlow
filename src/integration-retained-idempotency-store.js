import crypto from "node:crypto";
import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
  INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS,
  INTEGRATION_PUBLIC_JSON_RESPONSE_MAX_BYTES,
} from "./integration-api.js";
import {
  INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
  assertRetainedProtectedFilePrimitives,
  assertRetainedRegularFileLock,
  authorityFail,
  currentProcessOwner,
  normalizeProcessIdentity,
  parseIsoMs,
  processOwnerLiveness,
  retainedRegularFileLockObjectIdentityDigest,
} from "./integration-durable-common.js";
import {
  INTEGRATION_RPC_PATHS,
  canonicalJson,
  contractDigest,
  integrationRpcPathIsMutation,
  validateIntegrationIdempotencyKey,
} from "./integration-policy.js";

export const INTEGRATION_RETAINED_IDEMPOTENCY_STORE_VERSION =
  "aginti-retained-integration-idempotency-store-v1";
export const INTEGRATION_RETAINED_IDEMPOTENCY_STORE_ATTESTATION_VERSION =
  "aginti-retained-integration-idempotency-store-attestation-v1";
export const INTEGRATION_RETAINED_IDEMPOTENCY_TRANSACTIONAL_STORE_ATTESTATION_VERSION =
  "aginti-retained-integration-transactional-idempotency-store-attestation-v1";
export const INTEGRATION_RETAINED_IDEMPOTENCY_TRANSACTIONAL_STORE_VERSION =
  "aginti-retained-integration-transactional-idempotency-store-v1";
export const INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_VERSION =
  "aginti-retained-integration-idempotency-snapshot-v1";
export const INTEGRATION_RETAINED_IDEMPOTENCY_RECORD_VERSION =
  "aginti-retained-integration-idempotency-record-v1";
export const INTEGRATION_RETAINED_IDEMPOTENCY_RECOVERY_BINDING_VERSION =
  "aginti-retained-integration-idempotency-recovery-binding-v1";
export const INTEGRATION_RETAINED_IDEMPOTENCY_LOCK_FILE =
  ".aginti-flock-v1-idempotency-store";
export const INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE =
  "idempotency.snapshot.json";
export const INTEGRATION_RETAINED_IDEMPOTENCY_REQUEST_HASH_ALGORITHM =
  "canonical-json-v1";
export const INTEGRATION_RETAINED_IDEMPOTENCY_RESPONSE_ENVELOPE =
  "aginti-agent-rpc-v1";

export const INTEGRATION_RETAINED_IDEMPOTENCY_STORE_LIMITATIONS = Object.freeze(
  Object.assign(Object.create(null), {
    preEnableStorageKernel: true,
    runtimeCapabilityEnabled: false,
    runtimeWiringIncluded: false,
    recoveryAuthorityBoundAtFactory: false,
    recoveryAuthorityMustBeBoundSeparately: true,
    integrationApiCompatibilityProven: false,
    integrationApiCompatibleOnlyAfterTrustedRecoveryReceiptAuthority: true,
    plainCallbackRecoveryBindingTestOnly: true,
    trustedRecoveryReceiptAuthorityIncluded: false,
    recoveredReceiptOwnershipValidationIncluded: false,
    onePreprovisionedRetainedDirectoryRequired: true,
    onePreprovisionedFixedLockFileRequired: true,
    oneFixedSnapshotFile: true,
    dynamicDirectoryCreation: false,
    dynamicSharding: false,
    listMethodsRequired: false,
    deleteMethodsRequired: false,
    physicalDelete: false,
    logicalPruneBySnapshotReplacement: true,
    wholeSnapshotRewrite: true,
    boundedRecords: true,
    boundedResponses: true,
    boundedSnapshotBytes: true,
    boundedSnapshotJsonNodes: true,
    perResponseJsonNodeCapDerivedFromRecordCap: true,
    publicMutationResponseByteEnvelopeCanBeCoveredByBoundedConfiguration: true,
    oneGlobalContentionDomain: true,
    boundedInProcessFifo: true,
    postWriteReloadVerification: true,
    crashRecoveryBeforeDispatchRequiresBoundAuthority: true,
    crashRecoveryAfterDispatchRequiresBoundAuthority: true,
    crashRecoveryAfterPersistedResultIsLocal: true,
    blindRedispatch: false,
    sameKernelHostRequired: true,
    crossHostExclusion: false,
    localFilesystemRequired: true,
    localFilesystemVerified: false,
    cooperativeParticipantsOnly: true,
    sameUidNonparticipantSafety: false,
    namedBindingRaceFree: false,
    advisoryLock: true,
    fencingTokens: false,
    unkeyedIntegrityDigestOnly: true,
    sameUidForgeryOutOfScope: true,
    sameProcessInactiveOwnerRecovery: true,
    otherProcessCannotDistinguishInactiveOwnerFromLiveProcess: true,
    poisonedOwnerMayRequireOwningProcessRestartForCrossProcessRecovery: true,
    nativePromiseRejectionsObservedForTraversedInputs: true,
    unsafePromiseSpeciesNotInvoked: true,
    rejectedPromiseSubclassMayRemainCallerOwned: true,
    storageLifecycleOwned: false,
    callerMustCloseOwningAuthority: true,
    crashMayLeaveReservedTemp: true,
    automaticTempRecovery: false,
    commitMayBeAmbiguousAfterRename: true,
    commitAmbiguityPoisonsSurface: true,
    lockReleaseAmbiguityPoisonsSurface: true,
    freshFactoryRollbackDetection: false,
    forwardRevisionGapLineageVerification: false,
    hardwareDurabilityGuarantee: false,
  })
);

const EXPECTED_KEYS = Object.freeze([
  "role",
  "canonicalPath",
  "rootIdentityDigest",
  "relativeSegments",
  "directoryIdentityDigest",
  "lockFileIdentityDigest",
  "helperSha256",
  "helperIdentityDigest",
  "maxSnapshotBytes",
  "maxRecords",
  "maxResponseBytes",
  "pendingLeaseMs",
  "retentionMs",
  "lockWaitMs",
]);
const CONTEXT_KEYS = Object.freeze([
  "principalId",
  "browserSessionId",
  "pathname",
  "idempotencyKey",
  "requestHash",
  "requestHashAlgorithm",
  "responseEnvelope",
  "idempotencyWindowMs",
  "payload",
]);
const RECOVERY_KEYS = Object.freeze([
  "owner",
  "explicit",
  "testOnly",
  "blindRedispatch",
  "beforeDispatchRecovery",
  "afterDispatchBeforeResultRecovery",
  "afterResultBeforePublicResponseRecovery",
  "recoverPending",
]);
const STORE_SURFACE_KEYS = Object.freeze([
  "schemaVersion",
  "attestation",
  "health",
  "inspectRecord",
  "isClosed",
]);
const TRANSACTIONAL_SURFACE_KEYS = Object.freeze([
  "schemaVersion",
  "attestation",
  "owner",
  "contractVersion",
  "durable",
  "crossProcessSafe",
  "atomicLookupAndDispatch",
  "atomicClaim",
  "atomicComplete",
  "failOrRecoverOnHandlerError",
  "noStrandedPendingOnHandlerError",
  "requestHashBound",
  "principalBound",
  "browserSessionBound",
  "sameKeySameRequestReplays",
  "sameKeyDifferentRequestStatus",
  "idempotencyWindowMs",
  "testOnly",
  "requestHashAlgorithm",
  "responseEnvelope",
  "recoveryAuthority",
  "runMutation",
  "recoverExpiredPending",
  "inspectRecord",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "logicalNamespaceDigest",
  "namespaceSealBindingDigest",
  "revision",
  "previousIntegrityDigest",
  "updatedAt",
  "records",
  "integrityDigest",
]);
const RECORD_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "contractVersion",
  "index",
  "principalId",
  "browserSessionId",
  "pathname",
  "keyDigest",
  "requestHash",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "state",
  "pendingOwner",
  "leaseExpiresAt",
  "recoveryStage",
  "response",
  "responseDigest",
  "responseBytes",
  "failure",
]);
const PENDING_OWNER_KEYS = Object.freeze([
  "schemaVersion",
  "pid",
  "token",
  "processIdentity",
  "acquiredAt",
  "heartbeatAt",
]);
const PROCESS_IDENTITY_KEYS = Object.freeze([
  "schemaVersion",
  "bootId",
  "startTimeTicks",
]);
const FAILURE_KEYS = Object.freeze(["code", "status", "messageDigest"]);
const MAX_PENDING_OPERATIONS = 256;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_SNAPSHOT_JSON_NODES = 90_000;
const SNAPSHOT_RESERVED_JSON_NODES = 4096;
const MIN_SNAPSHOT_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MIN_RESPONSE_BYTES = 1024;
export const INTEGRATION_RETAINED_IDEMPOTENCY_MAX_RESPONSE_BYTES =
  INTEGRATION_PUBLIC_JSON_RESPONSE_MAX_BYTES - 1;
const MAX_RESPONSE_BYTES = INTEGRATION_RETAINED_IDEMPOTENCY_MAX_RESPONSE_BYTES;
const MIN_PENDING_LEASE_MS = 100;
const MAX_PENDING_LEASE_MS = 60_000;
const MAX_LOCK_WAIT_MS = 60_000;
const RECORD_OVERHEAD_BYTES = 8192;
const SNAPSHOT_OVERHEAD_BYTES = 8192;
const ZERO_DIGEST = "0".repeat(64);
const OWNER_TOKEN_PATTERN = /^[a-f0-9]{32,128}$/u;
const RECOVERY_STAGES = new Set([
  "before-dispatch",
  "after-dispatch-before-result",
  "after-result-before-public-response",
]);
const PRIVATE_RUNTIME_PATH_PATTERN =
  /(?:^|[\s("'`])(?:\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/[^\s"'`<>)\]]*)?|[A-Za-z]:\\[^\s"'`<>)\]]*)/iu;
const PRIVATE_RUNTIME_SECRET_PATTERN =
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*(?!\[REDACTED\](?=$|[\s"',}\]]))[^"',}\s]+/iu;

const storeBrand = new WeakMap();
const transactionalBrand = new WeakMap();
const claimedStoreLocks = new WeakSet();
const activePendingOwnerTokens = new Set();
const NativePromise = Promise;
const PromiseThen = NativePromise.prototype.then;
const FunctionPrototypeCall = Function.prototype.call;
const ObjectPrototypeHasOwn = Object.prototype.hasOwnProperty;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ReflectApply = Reflect.apply;
const ReflectDefineProperty = Reflect.defineProperty;
const SymbolSpecies = Symbol.species;
const NativePromiseSpeciesDescriptor = ObjectGetOwnPropertyDescriptor(NativePromise, SymbolSpecies);
const NativePromiseSpeciesGetter = NativePromiseSpeciesDescriptor?.get;
const NativePromiseSpeciesSetter = NativePromiseSpeciesDescriptor?.set;
const SafePromiseConstructor = Object.create(null);
Object.defineProperty(SafePromiseConstructor, Symbol.species, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: NativePromise,
});
Object.freeze(SafePromiseConstructor);

function storeFail(code, message, { status = 503, details = Object.freeze(Object.create(null)) } = {}) {
  authorityFail(code, message, { status, details });
}

function frozenRecord(value) {
  return Object.freeze(Object.assign(Object.create(null), value));
}

function hasOwn(value, key) {
  return ReflectApply(FunctionPrototypeCall, ObjectPrototypeHasOwn, [value, key]);
}

function isPromiseValue(value) {
  return Boolean(value) && typeof value === "object" && !utilTypes.isProxy(value) && utilTypes.isPromise(value);
}

function promiseCanBeSafelyObserved(value) {
  const ownConstructor = ObjectGetOwnPropertyDescriptor(value, "constructor");
  let constructorDescriptor = ownConstructor;
  if (!constructorDescriptor) {
    const prototype = ObjectGetPrototypeOf(value);
    if (!prototype || utilTypes.isProxy(prototype)) return false;
    constructorDescriptor = ObjectGetOwnPropertyDescriptor(prototype, "constructor");
  }
  if (!constructorDescriptor || !hasOwn(constructorDescriptor, "value")) return false;
  const constructor = constructorDescriptor.value;
  if (constructor === undefined) return true;
  if (constructor !== NativePromise) return false;
  const speciesDescriptor = ObjectGetOwnPropertyDescriptor(NativePromise, SymbolSpecies);
  if (!speciesDescriptor) return false;
  if (hasOwn(speciesDescriptor, "value")) {
    return speciesDescriptor.value === undefined || speciesDescriptor.value === null || speciesDescriptor.value === NativePromise;
  }
  return NativePromiseSpeciesGetter !== undefined &&
    speciesDescriptor.get === NativePromiseSpeciesGetter &&
    speciesDescriptor.set === NativePromiseSpeciesSetter;
}

function rejectPromiseValue(value, label, code = "IDEMPOTENCY_STORE_INVALID") {
  if (!isPromiseValue(value)) return false;
  if (promiseCanBeSafelyObserved(value)) {
    ReflectApply(PromiseThen, value, [undefined, () => undefined]);
  }
  storeFail(code, `${label} must be synchronous plain data.`, { status: 400 });
}

function observeRejectedArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (isPromiseValue(value) && promiseCanBeSafelyObserved(value)) {
      ReflectApply(PromiseThen, value, [undefined, () => undefined]);
      continue;
    }
    if (
      !value ||
      (typeof value !== "object" && typeof value !== "function") ||
      utilTypes.isProxy(value)
    ) continue;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !hasOwn(descriptor, "value")) continue;
      const fieldValue = descriptor.value;
      if (isPromiseValue(fieldValue) && promiseCanBeSafelyObserved(fieldValue)) {
        ReflectApply(PromiseThen, fieldValue, [undefined, () => undefined]);
      }
    }
  }
}

function exactDataObject(value, allowedKeys, requiredKeys, label, code = "IDEMPOTENCY_STORE_INVALID") {
  if (value && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value)) {
    storeFail(code, `${label} must not be a Proxy.`, { status: 400 });
  }
  rejectPromiseValue(value, label, code);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    storeFail(code, `${label} must be a plain data object.`, { status: 400 });
  }
  const prototype = ObjectGetPrototypeOf(value);
  const clone = Object.create(null);
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (descriptor && hasOwn(descriptor, "value")) {
      const fieldValue = descriptor.value;
      if (isPromiseValue(fieldValue) && promiseCanBeSafelyObserved(fieldValue)) {
        ReflectApply(PromiseThen, fieldValue, [undefined, () => undefined]);
      }
    }
  }
  if (prototype !== Object.prototype && prototype !== null) {
    storeFail(code, `${label} prototype is invalid.`, { status: 400 });
  }
  for (const key of ownKeys) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      storeFail(code, `${label} contains an unsupported field.`, { status: 400 });
    }
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !hasOwn(descriptor, "value")) {
      storeFail(code, `${label} fields must be enumerable data.`, { status: 400 });
    }
    const fieldValue = descriptor.value;
    rejectPromiseValue(fieldValue, `${label}.${key}`, code);
    Object.defineProperty(clone, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: fieldValue,
    });
  }
  for (const key of requiredKeys) {
    if (!hasOwn(clone, key)) storeFail(code, `${label}.${key} is required.`, { status: 400 });
  }
  return Object.freeze(clone);
}

function assertDigest(value, label, code = "IDEMPOTENCY_STORE_INVALID") {
  rejectPromiseValue(value, label, code);
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    storeFail(code, `${label} is invalid.`, { status: code.endsWith("INVALID") ? 400 : 503 });
  }
  return value;
}

function assertIso(value, label, code = "IDEMPOTENCY_STORE_CORRUPT") {
  try {
    return parseIsoMs(value, label);
  } catch {
    storeFail(code, `${label} is invalid.`);
  }
}

function cloneTrapSafeJson(value, label, state = {}, depth = 0) {
  const status = state.code === "IDEMPOTENCY_STORE_FULL"
    ? 409
    : state.code === "IDEMPOTENCY_STORE_INVALID" || state.code === "IDEMPOTENCY_SCOPE_INVALID"
      ? 400
      : 503;
  state.nodes = (state.nodes || 0) + 1;
  if (state.nodes > (state.maxNodes || MAX_JSON_NODES) || depth > MAX_JSON_DEPTH) {
    storeFail(state.code || "IDEMPOTENCY_STORE_INVALID", `${label} exceeds structural bounds.`, { status });
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      storeFail(state.code || "IDEMPOTENCY_STORE_INVALID", `${label} contains a non-canonical number.`, { status });
    }
    return value;
  }
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) {
    rejectPromiseValue(value, label, state.code || "IDEMPOTENCY_STORE_INVALID");
    storeFail(state.code || "IDEMPOTENCY_STORE_INVALID", `${label} must contain only trap-safe JSON data.`, {
      status,
    });
  }
  rejectPromiseValue(value, label, state.code || "IDEMPOTENCY_STORE_INVALID");
  state.active ||= new WeakSet();
  if (state.active.has(value)) {
    storeFail(state.code || "IDEMPOTENCY_STORE_INVALID", `${label} must not contain cycles.`, { status });
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (ObjectGetPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(value.length)) {
        storeFail(state.code || "IDEMPOTENCY_STORE_INVALID", `${label} array shape is invalid.`, { status });
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        keys[keys.length - 1] !== "length" ||
        keys.slice(0, -1).some((key, index) => key !== String(index))
      ) {
        storeFail(state.code || "IDEMPOTENCY_STORE_INVALID", `${label} array must be dense data.`, { status });
      }
      const result = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = ObjectGetOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !hasOwn(descriptor, "value")) {
          storeFail(state.code || "IDEMPOTENCY_STORE_INVALID", `${label} array entries must be data.`, { status });
        }
        result[index] = cloneTrapSafeJson(descriptor.value, label, state, depth + 1);
      }
      return Object.freeze(result);
    }
    const prototype = ObjectGetPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      storeFail(state.code || "IDEMPOTENCY_STORE_INVALID", `${label} object prototype is invalid.`, { status });
    }
    const result = {};
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      storeFail(state.code || "IDEMPOTENCY_STORE_INVALID", `${label} must not contain symbols.`, { status });
    }
    for (const key of keys) {
      const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !hasOwn(descriptor, "value")) {
        storeFail(state.code || "IDEMPOTENCY_STORE_INVALID", `${label} fields must be data.`, { status });
      }
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: cloneTrapSafeJson(descriptor.value, label, state, depth + 1),
      });
    }
    return Object.freeze(result);
  } finally {
    state.active.delete(value);
  }
}

function normalizeSegments(value) {
  const segments = cloneTrapSafeJson(value, "retained idempotency relativeSegments");
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 64) {
    storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency store requires one dedicated directory.", {
      status: 400,
    });
  }
  for (const segment of segments) {
    if (
      typeof segment !== "string" ||
      Buffer.byteLength(segment, "utf8") > 160 ||
      !/^[A-Za-z0-9._:-]+$/u.test(segment) ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".aginti-atomic-v1-") ||
      segment.startsWith(".aginti-flock-v1-")
    ) {
      storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency directory segment is invalid.", { status: 400 });
    }
  }
  return segments;
}

function normalizeExpected(input) {
  const raw = exactDataObject(input, EXPECTED_KEYS, EXPECTED_KEYS, "retained idempotency expected binding");
  rejectPromiseValue(raw.role, "retained idempotency role");
  if (typeof raw.role !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/u.test(raw.role)) {
    storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency role is invalid.", { status: 400 });
  }
  rejectPromiseValue(raw.canonicalPath, "retained idempotency canonicalPath");
  if (
    typeof raw.canonicalPath !== "string" ||
    raw.canonicalPath.includes("\0") ||
    !path.isAbsolute(raw.canonicalPath) ||
    path.normalize(raw.canonicalPath) !== raw.canonicalPath ||
    raw.canonicalPath === path.parse(raw.canonicalPath).root ||
    raw.canonicalPath.endsWith(path.sep)
  ) {
    storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency canonicalPath is invalid.", { status: 400 });
  }
  for (const field of [
    "rootIdentityDigest",
    "directoryIdentityDigest",
    "lockFileIdentityDigest",
    "helperSha256",
    "helperIdentityDigest",
  ]) assertDigest(raw[field], `retained idempotency ${field}`);
  const relativeSegments = normalizeSegments(raw.relativeSegments);
  for (const field of [
    "maxSnapshotBytes",
    "maxRecords",
    "maxResponseBytes",
    "pendingLeaseMs",
    "retentionMs",
    "lockWaitMs",
  ]) rejectPromiseValue(raw[field], `retained idempotency ${field}`);
  if (
    !Number.isSafeInteger(raw.maxSnapshotBytes) ||
    raw.maxSnapshotBytes < MIN_SNAPSHOT_BYTES ||
    raw.maxSnapshotBytes > MAX_SNAPSHOT_BYTES
  ) storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency snapshot byte cap is invalid.", { status: 400 });
  if (!Number.isSafeInteger(raw.maxRecords) || raw.maxRecords < 1 || raw.maxRecords > 64) {
    storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency record cap is invalid.", { status: 400 });
  }
  if (
    !Number.isSafeInteger(raw.maxResponseBytes) ||
    raw.maxResponseBytes < MIN_RESPONSE_BYTES ||
    raw.maxResponseBytes > MAX_RESPONSE_BYTES
  ) storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency response byte cap is invalid.", { status: 400 });
  if (raw.maxSnapshotBytes < SNAPSHOT_OVERHEAD_BYTES + raw.maxRecords * (raw.maxResponseBytes + RECORD_OVERHEAD_BYTES)) {
    storeFail(
      "IDEMPOTENCY_STORE_INVALID",
      "Retained idempotency snapshot cannot hold its configured maximum records and responses.",
      { status: 400 }
    );
  }
  if (
    !Number.isSafeInteger(raw.pendingLeaseMs) ||
    raw.pendingLeaseMs < MIN_PENDING_LEASE_MS ||
    raw.pendingLeaseMs > MAX_PENDING_LEASE_MS
  ) storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency pending lease is invalid.", { status: 400 });
  if (
    !Number.isSafeInteger(raw.retentionMs) ||
    raw.retentionMs < 1000 ||
    raw.retentionMs > INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS ||
    raw.pendingLeaseMs > raw.retentionMs
  ) storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency retention is invalid.", { status: 400 });
  if (!Number.isSafeInteger(raw.lockWaitMs) || raw.lockWaitMs < 0 || raw.lockWaitMs > MAX_LOCK_WAIT_MS) {
    storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency lock wait is invalid.", { status: 400 });
  }
  return Object.freeze({
    role: raw.role,
    canonicalPath: raw.canonicalPath,
    rootIdentityDigest: raw.rootIdentityDigest,
    relativeSegments,
    directoryIdentityDigest: raw.directoryIdentityDigest,
    lockFileIdentityDigest: raw.lockFileIdentityDigest,
    helperSha256: raw.helperSha256,
    helperIdentityDigest: raw.helperIdentityDigest,
    maxSnapshotBytes: raw.maxSnapshotBytes,
    maxRecords: raw.maxRecords,
    maxResponseBytes: raw.maxResponseBytes,
    maxResponseNodes: Math.floor(
      (MAX_SNAPSHOT_JSON_NODES - SNAPSHOT_RESERVED_JSON_NODES) / raw.maxRecords
    ),
    pendingLeaseMs: raw.pendingLeaseMs,
    retentionMs: raw.retentionMs,
    lockWaitMs: raw.lockWaitMs,
  });
}

function directoryExpected(expected) {
  return Object.freeze({
    role: expected.role,
    canonicalPath: expected.canonicalPath,
    rootIdentityDigest: expected.rootIdentityDigest,
    relativeSegments: expected.relativeSegments,
    directoryIdentityDigest: expected.directoryIdentityDigest,
  });
}

function lockExpected(expected) {
  return Object.freeze({
    ...directoryExpected(expected),
    lockFileName: INTEGRATION_RETAINED_IDEMPOTENCY_LOCK_FILE,
    helperSha256: expected.helperSha256,
    lockFileIdentityDigest: expected.lockFileIdentityDigest,
    helperIdentityDigest: expected.helperIdentityDigest,
  });
}

function logicalNamespaceDigest(expected) {
  return contractDigest({
    domain: "aginti-retained-integration-idempotency-namespace-v1",
    schemaVersion: INTEGRATION_RETAINED_IDEMPOTENCY_STORE_VERSION,
    role: expected.role,
    canonicalPath: expected.canonicalPath,
    relativeSegments: expected.relativeSegments,
    snapshotFile: INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE,
  });
}

function admissionBindingDigest(expected) {
  return contractDigest({
    schemaVersion: "aginti-retained-integration-idempotency-admission-v1",
    directory: directoryExpected(expected),
    lock: lockExpected(expected),
    maxSnapshotBytes: expected.maxSnapshotBytes,
    maxRecords: expected.maxRecords,
    maxResponseBytes: expected.maxResponseBytes,
    pendingLeaseMs: expected.pendingLeaseMs,
    retentionMs: expected.retentionMs,
    lockWaitMs: expected.lockWaitMs,
  });
}

function namespaceSealBindingDigest(expected, lockObjectIdentityDigest) {
  return contractDigest({
    schemaVersion: "aginti-retained-integration-idempotency-seal-binding-v2",
    role: expected.role,
    canonicalPath: expected.canonicalPath,
    relativeSegments: expected.relativeSegments,
    snapshotFile: INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE,
    lockFile: INTEGRATION_RETAINED_IDEMPOTENCY_LOCK_FILE,
    lockFileObjectIdentityDigest: lockObjectIdentityDigest,
    helperSha256: expected.helperSha256,
    maxSnapshotBytes: expected.maxSnapshotBytes,
    maxRecords: expected.maxRecords,
    maxResponseBytes: expected.maxResponseBytes,
    pendingLeaseMs: expected.pendingLeaseMs,
    retentionMs: expected.retentionMs,
    lockWaitMs: expected.lockWaitMs,
  });
}

function normalizeContext(input, expectedRetentionMs) {
  const required = CONTEXT_KEYS.filter((key) => key !== "payload");
  const raw = exactDataObject(input, CONTEXT_KEYS, required, "retained idempotency mutation context");
  rejectPromiseValue(raw.principalId, "idempotency principalId");
  if (typeof raw.principalId !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/u.test(raw.principalId)) {
    storeFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency principal scope is invalid.", { status: 400 });
  }
  rejectPromiseValue(raw.browserSessionId, "idempotency browserSessionId");
  if (typeof raw.browserSessionId !== "string" || !/^[a-f0-9]{64}$/u.test(raw.browserSessionId)) {
    storeFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency browser session scope is invalid.", { status: 400 });
  }
  rejectPromiseValue(raw.pathname, "idempotency pathname");
  if (
    typeof raw.pathname !== "string" ||
    !Object.values(INTEGRATION_RPC_PATHS).includes(raw.pathname) ||
    !integrationRpcPathIsMutation(raw.pathname)
  ) storeFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency path is not a supported mutation.", { status: 400 });
  let idempotencyKey;
  try {
    idempotencyKey = validateIntegrationIdempotencyKey(raw.idempotencyKey);
  } catch {
    storeFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency key is invalid.", { status: 400 });
  }
  const requestHash = assertDigest(raw.requestHash, "idempotency requestHash", "IDEMPOTENCY_SCOPE_INVALID");
  if (raw.requestHashAlgorithm !== INTEGRATION_RETAINED_IDEMPOTENCY_REQUEST_HASH_ALGORITHM) {
    storeFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency request hash algorithm is unsupported.", { status: 400 });
  }
  if (raw.responseEnvelope !== INTEGRATION_RETAINED_IDEMPOTENCY_RESPONSE_ENVELOPE) {
    storeFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency response envelope is unsupported.", { status: 400 });
  }
  if (
    !Number.isSafeInteger(raw.idempotencyWindowMs) ||
    raw.idempotencyWindowMs < 1 ||
    raw.idempotencyWindowMs > INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS ||
    raw.idempotencyWindowMs !== expectedRetentionMs
  ) storeFail("IDEMPOTENCY_SCOPE_INVALID", "Idempotency window is invalid.", { status: 400 });
  if (raw.payload !== undefined) {
    cloneTrapSafeJson(raw.payload, "idempotency request payload", {
      code: "IDEMPOTENCY_SCOPE_INVALID",
      maxNodes: MAX_JSON_NODES,
    });
  }
  return Object.freeze({
    principalId: raw.principalId,
    browserSessionId: raw.browserSessionId,
    pathname: raw.pathname,
    idempotencyKey,
    requestHash,
  });
}

function requestIndex(scope) {
  const keyDigest = crypto.createHash("sha256").update(scope.idempotencyKey, "utf8").digest("hex");
  return contractDigest({
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    pathname: scope.pathname,
    idempotencyKeyDigest: keyDigest,
  });
}

function recordIndex(record) {
  return contractDigest({
    principalId: record.principalId,
    browserSessionId: record.browserSessionId,
    pathname: record.pathname,
    idempotencyKeyDigest: record.keyDigest,
  });
}

function safeIsoPlus(now, deltaMs) {
  return new Date(now.getTime() + deltaMs).toISOString();
}

function normalizeResponse(response, expected, code) {
  const cloned = cloneTrapSafeJson(response, "idempotency public response", {
    code,
    maxNodes: expected.maxResponseNodes,
  });
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned) || cloned.schemaVersion !== "1") {
    storeFail(code, "Mutation response is not a public schemaVersion 1 envelope.");
  }
  const serialized = canonicalJson(cloned);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes < 1 || bytes > expected.maxResponseBytes) {
    storeFail(
      code === "IDEMPOTENCY_STORE_CORRUPT" ? code : "IDEMPOTENCY_RESULT_TOO_LARGE",
      "Mutation response exceeds its retained byte bound."
    );
  }
  if (
    PRIVATE_RUNTIME_PATH_PATTERN.test(serialized) ||
    PRIVATE_RUNTIME_SECRET_PATTERN.test(serialized)
  ) {
    storeFail(code, "Mutation response contains private runtime content.");
  }
  return Object.freeze({
    response: cloned,
    responseDigest: contractDigest(cloned),
    responseBytes: bytes,
  });
}

function cloneResponse(response, expected) {
  return normalizeResponse(response, expected, "IDEMPOTENCY_UNSAFE_RESULT");
}

function validateStoredResponse(response, expected) {
  return normalizeResponse(response, expected, "IDEMPOTENCY_STORE_CORRUPT");
}

function validateExactObject(value, keys, label, code = "IDEMPOTENCY_STORE_CORRUPT") {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    storeFail(code, `${label} shape is invalid.`);
  }
  const prototype = ObjectGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) storeFail(code, `${label} prototype is invalid.`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    storeFail(code, `${label} fields are invalid.`);
  }
  for (const key of ownKeys) {
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !hasOwn(descriptor, "value")) storeFail(code, `${label} fields are invalid.`);
  }
  return value;
}

function validatePendingOwner(value) {
  validateExactObject(value, PENDING_OWNER_KEYS, "idempotency pending owner");
  if (
    value.schemaVersion !== "aginti-process-owner-v1" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.token !== "string" ||
    !OWNER_TOKEN_PATTERN.test(value.token)
  ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending owner is invalid.");
  validateExactObject(value.processIdentity, PROCESS_IDENTITY_KEYS, "idempotency process identity");
  if (!normalizeProcessIdentity(value.processIdentity)) {
    storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending process identity is invalid.");
  }
  assertIso(value.acquiredAt, "idempotency pending acquiredAt");
  assertIso(value.heartbeatAt, "idempotency pending heartbeatAt");
  return value;
}

function validateFailure(value) {
  validateExactObject(value, FAILURE_KEYS, "idempotency failure");
  if (
    typeof value.code !== "string" ||
    !/^[A-Z0-9_]{1,80}$/u.test(value.code) ||
    !Number.isSafeInteger(value.status) ||
    value.status < 400 ||
    value.status > 599
  ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency failure receipt is invalid.");
  assertDigest(value.messageDigest, "idempotency failure messageDigest", "IDEMPOTENCY_STORE_CORRUPT");
  return value;
}

function validateRecord(store, record) {
  validateExactObject(record, RECORD_KEYS, "idempotency record");
  if (
    record.schemaVersion !== INTEGRATION_RETAINED_IDEMPOTENCY_RECORD_VERSION ||
    record.owner !== "aginti" ||
    record.contractVersion !== INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION ||
    typeof record.principalId !== "string" ||
    !/^[A-Za-z0-9._~-]{16,128}$/u.test(record.principalId) ||
    typeof record.browserSessionId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.browserSessionId) ||
    typeof record.pathname !== "string" ||
    !Object.values(INTEGRATION_RPC_PATHS).includes(record.pathname) ||
    !integrationRpcPathIsMutation(record.pathname) ||
    !["pending", "completed", "failed"].includes(record.state)
  ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency record authority fields are invalid.");
  assertDigest(record.index, "idempotency record index", "IDEMPOTENCY_STORE_CORRUPT");
  assertDigest(record.keyDigest, "idempotency key digest", "IDEMPOTENCY_STORE_CORRUPT");
  assertDigest(record.requestHash, "idempotency request hash", "IDEMPOTENCY_STORE_CORRUPT");
  if (record.index !== recordIndex(record)) {
    storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency record index does not match its retained scope.");
  }
  const createdMs = assertIso(record.createdAt, "idempotency record createdAt");
  const updatedMs = assertIso(record.updatedAt, "idempotency record updatedAt");
  const expiresMs = assertIso(record.expiresAt, "idempotency record expiresAt");
  if (updatedMs < createdMs || expiresMs < updatedMs) {
    storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency record timestamp order is invalid.");
  }
  if (record.state === "pending") {
    validatePendingOwner(record.pendingOwner);
    assertIso(record.leaseExpiresAt, "idempotency record leaseExpiresAt");
    if (!RECOVERY_STAGES.has(record.recoveryStage)) {
      storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending recovery stage is invalid.");
    }
    if (record.recoveryStage === "after-result-before-public-response") {
      const response = validateStoredResponse(record.response, store.expected);
      if (response.responseDigest !== record.responseDigest || response.responseBytes !== record.responseBytes) {
        storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending response receipt is invalid.");
      }
    } else if (record.response !== null || record.responseDigest !== ZERO_DIGEST || record.responseBytes !== 0) {
      storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending record has an unexpected response.");
    }
    if (record.failure !== null) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending record has a failure.");
  } else if (record.state === "completed") {
    if (record.pendingOwner !== null || record.leaseExpiresAt !== "" || record.recoveryStage !== "" || record.failure !== null) {
      storeFail("IDEMPOTENCY_STORE_CORRUPT", "Completed idempotency record contains pending fields.");
    }
    const response = validateStoredResponse(record.response, store.expected);
    if (response.responseDigest !== record.responseDigest || response.responseBytes !== record.responseBytes) {
      storeFail("IDEMPOTENCY_STORE_CORRUPT", "Completed idempotency response receipt is invalid.");
    }
  } else {
    if (
      record.pendingOwner !== null ||
      record.leaseExpiresAt !== "" ||
      record.recoveryStage !== "" ||
      record.response !== null ||
      record.responseDigest !== ZERO_DIGEST ||
      record.responseBytes !== 0
    ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Failed idempotency record contains response or pending fields.");
    validateFailure(record.failure);
  }
  return record;
}

function snapshotIntegrityDigest(snapshot) {
  const { integrityDigest: _integrityDigest, ...unsigned } = snapshot;
  return contractDigest({
    domain: "aginti-retained-integration-idempotency-snapshot-integrity-v1",
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: unsigned,
  });
}

function validateSnapshot(store, snapshot, { persisted }) {
  validateExactObject(snapshot, SNAPSHOT_KEYS, "idempotency snapshot");
  if (
    snapshot.schemaVersion !== INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_VERSION ||
    snapshot.owner !== "aginti" ||
    snapshot.authority !== "aginti" ||
    snapshot.logicalNamespaceDigest !== store.logicalNamespaceDigest ||
    snapshot.namespaceSealBindingDigest !== store.namespaceSealBindingDigest ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < (persisted ? 1 : 0) ||
    snapshot.revision > Number.MAX_SAFE_INTEGER
  ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot authority fields are invalid.");
  assertDigest(snapshot.previousIntegrityDigest, "idempotency previous integrity digest", "IDEMPOTENCY_STORE_CORRUPT");
  if (
    (snapshot.revision === 1 && snapshot.previousIntegrityDigest !== ZERO_DIGEST) ||
    (snapshot.revision > 1 && snapshot.previousIntegrityDigest === ZERO_DIGEST)
  ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot previous integrity digest is invalid.");
  assertIso(snapshot.updatedAt, "idempotency snapshot updatedAt");
  if (!Array.isArray(snapshot.records) || ObjectGetPrototypeOf(snapshot.records) !== Array.prototype) {
    storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot records are invalid.");
  }
  const recordKeys = Reflect.ownKeys(snapshot.records);
  if (
    snapshot.records.length > store.expected.maxRecords ||
    recordKeys.length !== snapshot.records.length + 1 ||
    recordKeys[recordKeys.length - 1] !== "length" ||
    recordKeys.slice(0, -1).some((key, index) => key !== String(index))
  ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot record array is invalid.");
  let previousIndex = "";
  for (const record of snapshot.records) {
    validateRecord(store, record);
    if (previousIndex && record.index <= previousIndex) {
      storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot records are not uniquely sorted.");
    }
    previousIndex = record.index;
  }
  assertDigest(snapshot.integrityDigest, "idempotency snapshot integrity digest", "IDEMPOTENCY_STORE_CORRUPT");
  if (persisted && snapshot.integrityDigest !== snapshotIntegrityDigest(snapshot)) {
    storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot integrity digest is invalid.");
  }
  return snapshot;
}

function virtualSnapshot(store) {
  return Object.freeze({
    schemaVersion: INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_VERSION,
    owner: "aginti",
    authority: "aginti",
    logicalNamespaceDigest: store.logicalNamespaceDigest,
    namespaceSealBindingDigest: store.namespaceSealBindingDigest,
    revision: 0,
    previousIntegrityDigest: ZERO_DIGEST,
    updatedAt: "1970-01-01T00:00:00.000Z",
    records: Object.freeze([]),
    integrityDigest: ZERO_DIGEST,
  });
}

function observeSnapshot(store, snapshot) {
  const previous = store.observedSnapshot;
  if (previous) {
    if (snapshot.revision < previous.revision) {
      storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot rollback was observed.");
    }
    if (snapshot.revision === previous.revision && snapshot.integrityDigest !== previous.integrityDigest) {
      storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot revision diverged.");
    }
    if (
      snapshot.revision === previous.revision + 1 &&
      snapshot.previousIntegrityDigest !== previous.integrityDigest
    ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot adjacent lineage is invalid.");
  }
  store.observedSnapshot = Object.freeze({
    revision: snapshot.revision,
    integrityDigest: snapshot.integrityDigest,
  });
}

async function readSnapshot(store) {
  const raw = await store.filePrimitives.readProtectedUtf8File(
    INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE,
    { optional: true, maxBytes: store.expected.maxSnapshotBytes }
  );
  if (raw === null) {
    const snapshot = virtualSnapshot(store);
    observeSnapshot(store, snapshot);
    return snapshot;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot contains invalid JSON.");
  }
  const snapshot = validateSnapshot(store, parsed, { persisted: true });
  if (raw !== `${canonicalJson(snapshot)}\n`) {
    storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot is not canonical JSON.");
  }
  observeSnapshot(store, snapshot);
  return snapshot;
}

function makeSnapshot(store, current, records, updatedAt = new Date()) {
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    storeFail("IDEMPOTENCY_STORE_FULL", "Idempotency snapshot revision space is exhausted.", { status: 409 });
  }
  const sorted = [...records].sort((left, right) => left.index.localeCompare(right.index));
  const unsigned = {
    schemaVersion: INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_VERSION,
    owner: "aginti",
    authority: "aginti",
    logicalNamespaceDigest: store.logicalNamespaceDigest,
    namespaceSealBindingDigest: store.namespaceSealBindingDigest,
    revision: current.revision + 1,
    previousIntegrityDigest: current.integrityDigest,
    updatedAt: updatedAt.toISOString(),
    records: sorted,
  };
  const snapshot = Object.freeze({ ...unsigned, integrityDigest: snapshotIntegrityDigest(unsigned) });
  validateSnapshot(store, snapshot, { persisted: true });
  cloneTrapSafeJson(snapshot, "idempotency snapshot", {
    code: "IDEMPOTENCY_STORE_FULL",
    maxNodes: MAX_SNAPSHOT_JSON_NODES,
  });
  const bytes = Buffer.byteLength(`${canonicalJson(snapshot)}\n`, "utf8");
  if (bytes > store.expected.maxSnapshotBytes) {
    storeFail("IDEMPOTENCY_STORE_FULL", "Idempotency snapshot exceeds its byte bound.", { status: 409 });
  }
  return Object.freeze({ snapshot, bytes });
}

async function writeAndReloadSnapshot(store, current, records) {
  const candidate = makeSnapshot(store, current, records);
  const serialized = `${canonicalJson(candidate.snapshot)}\n`;
  const digest = crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
  const receipt = await store.filePrimitives.atomicWriteProtectedJson(
    INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE,
    candidate.snapshot,
    { maxBytes: store.expected.maxSnapshotBytes }
  );
  if (
    receipt?.committed !== true ||
    receipt?.directorySynced !== true ||
    receipt?.bytes !== candidate.bytes ||
    receipt?.digest !== digest
  ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot write receipt is invalid.");
  const reloaded = await readSnapshot(store);
  if (
    reloaded.revision !== candidate.snapshot.revision ||
    reloaded.integrityDigest !== candidate.snapshot.integrityDigest
  ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency snapshot post-write verification failed.");
  return reloaded;
}

function poisonStore(store, reason) {
  store.poisoned = true;
  store.poisonReason = reason;
}

function assertStoreOpen(store) {
  if (store.poisoned) storeFail("IDEMPOTENCY_STORE_POISONED", store.poisonReason || "Idempotency store is poisoned.");
  if (store.filePrimitives.isClosed() || store.lock.isClosed()) {
    storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Idempotency storage binding is closed.");
  }
}

function safeErrorCode(error) {
  if (!error || typeof error !== "object" || utilTypes.isProxy(error)) return "";
  for (const key of ["publicCode", "code"]) {
    const descriptor = ObjectGetOwnPropertyDescriptor(error, key);
    if (descriptor && hasOwn(descriptor, "value") && typeof descriptor.value === "string") return descriptor.value;
  }
  return "";
}

function safeErrorStatus(error) {
  if (!error || typeof error !== "object" || utilTypes.isProxy(error)) return 500;
  for (const key of ["statusCode", "status"]) {
    const descriptor = ObjectGetOwnPropertyDescriptor(error, key);
    if (
      descriptor &&
      hasOwn(descriptor, "value") &&
      Number.isSafeInteger(descriptor.value) &&
      descriptor.value >= 400 &&
      descriptor.value <= 599
    ) return descriptor.value;
  }
  return 500;
}

function safeErrorMessage(error) {
  if (!error || typeof error !== "object" || utilTypes.isProxy(error)) return "INTERNAL_ERROR";
  const descriptor = ObjectGetOwnPropertyDescriptor(error, "message");
  return descriptor && hasOwn(descriptor, "value") && typeof descriptor.value === "string"
    ? descriptor.value
    : "INTERNAL_ERROR";
}

function normalizeOperationError(store, error) {
  const code = safeErrorCode(error);
  if (
    code === "IDEMPOTENCY_SCOPE_INVALID" ||
    code === "IDEMPOTENCY_CONFLICT" ||
    code === "IDEMPOTENCY_PENDING" ||
    code === "IDEMPOTENCY_RECOVERY_REQUIRED" ||
    code === "IDEMPOTENCY_STORE_FULL" ||
    code === "IDEMPOTENCY_STORE_BUSY" ||
    code === "IDEMPOTENCY_UNSAFE_RESULT" ||
    code === "IDEMPOTENCY_RESULT_TOO_LARGE" ||
    code === "IDEMPOTENCY_STORE_POISONED"
  ) throw error;
  if (code === "IDEMPOTENCY_STORE_CORRUPT" || code === "INTEGRATION_STORAGE_FILE_CORRUPT" || code === "INTEGRATION_STORAGE_LOCK_CORRUPT" || code === "INTEGRATION_STORAGE_CORRUPT") {
    poisonStore(store, "Idempotency storage validation failed.");
    storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency storage binding is corrupt.");
  }
  if (code === "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS") {
    poisonStore(store, "Idempotency snapshot commit requires fresh-process reconciliation.");
    storeFail("IDEMPOTENCY_STORE_COMMIT_AMBIGUOUS", "Idempotency snapshot commit outcome is ambiguous.");
  }
  if (code === "INTEGRATION_STORAGE_LOCK_BUSY") {
    storeFail("IDEMPOTENCY_STORE_BUSY", "Idempotency global lock is busy.", { status: 429 });
  }
  if (code.startsWith("INTEGRATION_STORAGE_")) {
    if (
      code === "INTEGRATION_STORAGE_LOCK_RELEASE_AMBIGUOUS" ||
      code === "INTEGRATION_STORAGE_LOCK_POISONED" ||
      code === "INTEGRATION_STORAGE_POISONED" ||
      code === "INTEGRATION_STORAGE_CLEANUP_FAILED" ||
      code === "INTEGRATION_STORAGE_LOCK_CLEANUP_FAILED"
    ) poisonStore(store, "Idempotency retained storage binding is unavailable.");
    storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Idempotency retained storage operation failed safely.");
  }
  throw error;
}

function enqueueOperation(store, operation) {
  if (store.pendingOperations >= MAX_PENDING_OPERATIONS) {
    storeFail("IDEMPOTENCY_STORE_BUSY", "Idempotency operation queue is full.", { status: 429 });
  }
  store.pendingOperations += 1;
  let resolveCaller;
  let rejectCaller;
  const caller = new NativePromise((resolve, reject) => {
    resolveCaller = resolve;
    rejectCaller = reject;
  });
  if (!ReflectDefineProperty(caller, "constructor", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: SafePromiseConstructor,
  })) {
    store.pendingOperations -= 1;
    storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Idempotency operation promise could not be hardened.");
  }
  void ReflectApply(PromiseThen, caller, [undefined, () => undefined]);
  store.queue.push(Object.freeze({ operation, resolve: resolveCaller, reject: rejectCaller }));
  if (!store.queueDraining) {
    store.queueDraining = true;
    void drainQueue(store);
  }
  return caller;
}

async function drainQueue(store) {
  while (store.queue.length > 0) {
    const job = store.queue.shift();
    try {
      job.resolve(await job.operation());
    } catch (error) {
      job.reject(error);
    } finally {
      store.pendingOperations -= 1;
    }
  }
  store.queueDraining = false;
}

function runLocked(store, operation) {
  assertStoreOpen(store);
  return enqueueOperation(store, async () => {
    assertStoreOpen(store);
    try {
      return await store.lock.runExclusive(async () => {
        assertStoreOpen(store);
        return operation();
      }, { waitMs: store.expected.lockWaitMs });
    } catch (error) {
      normalizeOperationError(store, error);
    }
  });
}

function recordBase(store, scope, index, owner, now) {
  return {
    schemaVersion: INTEGRATION_RETAINED_IDEMPOTENCY_RECORD_VERSION,
    owner: "aginti",
    contractVersion: INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
    index,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    pathname: scope.pathname,
    keyDigest: crypto.createHash("sha256").update(scope.idempotencyKey, "utf8").digest("hex"),
    requestHash: scope.requestHash,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: safeIsoPlus(now, store.expected.retentionMs),
    state: "pending",
    pendingOwner: owner,
    leaseExpiresAt: safeIsoPlus(now, store.expected.pendingLeaseMs),
    recoveryStage: "before-dispatch",
    response: null,
    responseDigest: ZERO_DIGEST,
    responseBytes: 0,
    failure: null,
  };
}

function samePendingOwner(left, right) {
  return Boolean(left?.token && right?.token && left.token === right.token);
}

function markPendingOwnerActive(owner) {
  if (owner?.pid === process.pid && typeof owner.token === "string") {
    activePendingOwnerTokens.add(owner.token);
  }
}

function markPendingOwnerInactive(owner) {
  if (owner?.pid === process.pid && typeof owner.token === "string") {
    activePendingOwnerTokens.delete(owner.token);
  }
}

function pendingOwnerIsLocallyInactive(owner) {
  return owner?.pid === process.pid &&
    typeof owner.token === "string" &&
    !activePendingOwnerTokens.has(owner.token);
}

function sameScope(record, scope) {
  return record.principalId === scope.principalId &&
    record.browserSessionId === scope.browserSessionId &&
    record.pathname === scope.pathname;
}

function terminalResponse(record) {
  return cloneTrapSafeJson(record.response, "idempotency replay response", {
    code: "IDEMPOTENCY_STORE_CORRUPT",
  });
}

function conflict() {
  storeFail("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to a different request.", { status: 409 });
}

function pending() {
  storeFail("IDEMPOTENCY_PENDING", "Idempotent mutation is already pending.", { status: 409 });
}

function recoveryRequired() {
  storeFail("IDEMPOTENCY_RECOVERY_REQUIRED", "Pending idempotent mutation requires authoritative recovery.");
}

function previousFailure(failure) {
  storeFail(failure.code, "Idempotent mutation previously failed.", { status: failure.status });
}

function replaceRecord(records, replacement) {
  return records.map((record) => record.index === replacement.index ? replacement : record);
}

function completedRecord(store, record, responseReceipt, now = new Date()) {
  return {
    ...record,
    updatedAt: now.toISOString(),
    expiresAt: safeIsoPlus(now, store.expected.retentionMs),
    state: "completed",
    pendingOwner: null,
    leaseExpiresAt: "",
    recoveryStage: "",
    response: responseReceipt.response,
    responseDigest: responseReceipt.responseDigest,
    responseBytes: responseReceipt.responseBytes,
    failure: null,
  };
}

async function claimOrReplay(store, scope) {
  return runLocked(store, async () => {
    let snapshot = await readSnapshot(store);
    const index = requestIndex(scope);
    let records = [...snapshot.records];
    let existing = records.find((record) => record.index === index) || null;
    const now = new Date();
    const nowMs = now.getTime();
    if (existing) {
      if (existing.state !== "pending" && assertIso(existing.expiresAt, "idempotency record expiresAt") <= nowMs) {
        records = records.filter((record) => record.index !== index);
        snapshot = await writeAndReloadSnapshot(store, snapshot, records);
        existing = null;
      }
      if (existing && (!sameScope(existing, scope) || existing.requestHash !== scope.requestHash)) conflict();
    }
    if (existing?.state === "completed") return Object.freeze({ outcome: "replay", response: terminalResponse(existing) });
    if (existing?.state === "failed") {
      return Object.freeze({
        outcome: "failed",
        failure: frozenRecord({ ...existing.failure }),
      });
    }
    if (existing?.state === "pending") {
      if (existing.recoveryStage === "after-result-before-public-response") {
        const receipt = validateStoredResponse(existing.response, store.expected);
        const completed = completedRecord(store, existing, receipt, now);
        await writeAndReloadSnapshot(store, snapshot, replaceRecord(records, completed));
        return Object.freeze({ outcome: "replay", response: receipt.response });
      }
      if (assertIso(existing.leaseExpiresAt, "idempotency record leaseExpiresAt") > nowMs) {
        return Object.freeze({ outcome: "wait" });
      }
      const liveness = await processOwnerLiveness(existing.pendingOwner);
      const locallyInactive = liveness === "alive" && pendingOwnerIsLocallyInactive(existing.pendingOwner);
      if (liveness === "alive" && !locallyInactive) {
        return Object.freeze({ outcome: "wait" });
      }
      if (liveness !== "dead" && !locallyInactive) recoveryRequired();
      const recoveryOwner = await currentProcessOwner();
      const claimed = {
        ...existing,
        updatedAt: now.toISOString(),
        expiresAt: safeIsoPlus(now, store.expected.retentionMs),
        pendingOwner: recoveryOwner,
        leaseExpiresAt: safeIsoPlus(now, store.expected.pendingLeaseMs),
      };
      await writeAndReloadSnapshot(store, snapshot, replaceRecord(records, claimed));
      markPendingOwnerActive(recoveryOwner);
      return Object.freeze({ outcome: "recover", record: claimed, previousRecord: existing });
    }
    records = records.filter((record) => {
      return record.state === "pending" || assertIso(record.expiresAt, "idempotency record expiresAt") > nowMs;
    });
    if (records.length >= store.expected.maxRecords) {
      storeFail("IDEMPOTENCY_STORE_FULL", "Idempotency record cap is exhausted.", { status: 409 });
    }
    const owner = await currentProcessOwner();
    const beforeDispatch = recordBase(store, scope, index, owner, now);
    snapshot = await writeAndReloadSnapshot(store, snapshot, [...records, beforeDispatch]);
    const afterDispatch = { ...beforeDispatch, recoveryStage: "after-dispatch-before-result" };
    await writeAndReloadSnapshot(store, snapshot, replaceRecord(snapshot.records, afterDispatch));
    markPendingOwnerActive(owner);
    return Object.freeze({ outcome: "dispatch", record: afterDispatch });
  });
}

async function heartbeatRecord(store, scope, ownedRecord) {
  return runLocked(store, async () => {
    const snapshot = await readSnapshot(store);
    const latest = snapshot.records.find((record) => record.index === ownedRecord.index);
    if (
      !latest ||
      !sameScope(latest, scope) ||
      latest.requestHash !== scope.requestHash ||
      latest.state !== "pending" ||
      latest.recoveryStage === "after-result-before-public-response" ||
      !samePendingOwner(latest.pendingOwner, ownedRecord.pendingOwner)
    ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending ownership changed during execution.");
    const now = new Date();
    const next = {
      ...latest,
      updatedAt: now.toISOString(),
      expiresAt: safeIsoPlus(now, store.expected.retentionMs),
      leaseExpiresAt: safeIsoPlus(now, store.expected.pendingLeaseMs),
      pendingOwner: {
        ...latest.pendingOwner,
        heartbeatAt: now.toISOString(),
      },
    };
    await writeAndReloadSnapshot(store, snapshot, replaceRecord(snapshot.records, next));
    return next;
  });
}

function delay(ms) {
  return new NativePromise((resolve) => setTimeout(resolve, ms));
}

function wakeableDelay(ms) {
  let settled = false;
  let resolveDelay;
  const promise = new NativePromise((resolve) => {
    resolveDelay = resolve;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolveDelay();
  }, ms);
  return Object.freeze({
    promise,
    wake() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDelay();
    },
  });
}

async function runWithHeartbeat(store, scope, ownedRecord, operation) {
  let stopped = false;
  let heartbeatFailure = null;
  let wakeSleep = null;
  const intervalMs = Math.max(50, Math.min(5000, Math.floor(store.expected.pendingLeaseMs / 3)));
  const loop = (async () => {
    while (!stopped) {
      const sleeper = wakeableDelay(intervalMs);
      wakeSleep = sleeper.wake;
      await sleeper.promise;
      wakeSleep = null;
      if (stopped) break;
      try {
        await heartbeatRecord(store, scope, ownedRecord);
      } catch (error) {
        heartbeatFailure = error;
        stopped = true;
      }
    }
  })();
  let result;
  let operationError = null;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  } finally {
    stopped = true;
    wakeSleep?.();
    await loop.catch(() => {});
  }
  if (heartbeatFailure) throw heartbeatFailure;
  return Object.freeze({ result, operationError });
}

async function failOwnedRecord(store, scope, ownedRecord, error) {
  return runLocked(store, async () => {
    const snapshot = await readSnapshot(store);
    const latest = snapshot.records.find((record) => record.index === ownedRecord.index);
    if (
      !latest ||
      !sameScope(latest, scope) ||
      latest.requestHash !== scope.requestHash ||
      latest.state !== "pending" ||
      latest.recoveryStage === "after-result-before-public-response" ||
      !samePendingOwner(latest.pendingOwner, ownedRecord.pendingOwner)
    ) return false;
    const now = new Date();
    const codeCandidate = safeErrorCode(error);
    const failed = {
      ...latest,
      updatedAt: now.toISOString(),
      expiresAt: safeIsoPlus(now, store.expected.retentionMs),
      state: "failed",
      pendingOwner: null,
      leaseExpiresAt: "",
      recoveryStage: "",
      response: null,
      responseDigest: ZERO_DIGEST,
      responseBytes: 0,
      failure: {
        code: /^[A-Z0-9_]{1,80}$/u.test(codeCandidate) ? codeCandidate : "INTERNAL_ERROR",
        status: safeErrorStatus(error),
        messageDigest: crypto.createHash("sha256").update(safeErrorMessage(error), "utf8").digest("hex"),
      },
    };
    await writeAndReloadSnapshot(store, snapshot, replaceRecord(snapshot.records, failed));
    return true;
  });
}

async function finalizeOwnedResponse(store, scope, ownedRecord, responseReceipt) {
  return runLocked(store, async () => {
    let snapshot = await readSnapshot(store);
    const latest = snapshot.records.find((record) => record.index === ownedRecord.index);
    if (
      !latest ||
      !sameScope(latest, scope) ||
      latest.requestHash !== scope.requestHash ||
      latest.state !== "pending" ||
      !samePendingOwner(latest.pendingOwner, ownedRecord.pendingOwner)
    ) storeFail("IDEMPOTENCY_STORE_CORRUPT", "Idempotency pending ownership changed before completion.");
    const now = new Date();
    const afterResult = {
      ...latest,
      updatedAt: now.toISOString(),
      expiresAt: safeIsoPlus(now, store.expected.retentionMs),
      recoveryStage: "after-result-before-public-response",
      response: responseReceipt.response,
      responseDigest: responseReceipt.responseDigest,
      responseBytes: responseReceipt.responseBytes,
    };
    snapshot = await writeAndReloadSnapshot(store, snapshot, replaceRecord(snapshot.records, afterResult));
    const completed = completedRecord(store, afterResult, responseReceipt, new Date());
    await writeAndReloadSnapshot(store, snapshot, replaceRecord(snapshot.records, completed));
    return responseReceipt.response;
  });
}

function recoveryContext(record) {
  return Object.freeze({
    principalId: record.principalId,
    browserSessionId: record.browserSessionId,
    pathname: record.pathname,
    requestHash: record.requestHash,
    idempotencyKeyDigest: record.keyDigest,
    createdAt: record.createdAt,
    recoveryStage: record.recoveryStage,
    responseReceipt: null,
  });
}

async function restoreRecoveryClaim(store, record, previousRecord) {
  return runLocked(store, async () => {
    const snapshot = await readSnapshot(store);
    const latest = snapshot.records.find((candidate) => candidate.index === record.index);
    if (!latest || latest.state !== "pending" || !samePendingOwner(latest.pendingOwner, record.pendingOwner)) return false;
    await writeAndReloadSnapshot(store, snapshot, replaceRecord(snapshot.records, previousRecord));
    return true;
  });
}

async function recoverClaimedRecord(store, scope, record, previousRecord) {
  try {
    const operation = await runWithHeartbeat(
      store,
      scope,
      record,
      () => store.recovery.recoverPending(recoveryContext(record))
    );
    if (operation.operationError) {
      await restoreRecoveryClaim(store, record, previousRecord);
      recoveryRequired();
    }
    const recovered = operation.result;
    if (recovered === null || recovered === undefined) {
      await restoreRecoveryClaim(store, record, previousRecord);
      recoveryRequired();
    }
    const receipt = cloneResponse(recovered, store.expected);
    return await finalizeOwnedResponse(store, scope, record, receipt);
  } finally {
    markPendingOwnerInactive(record.pendingOwner);
  }
}

async function runMutation(store, contextInput, handler) {
  if (typeof handler !== "function" || utilTypes.isProxy(handler)) {
    storeFail("IDEMPOTENCY_STORE_INVALID", "Idempotency mutation handler must be a non-Proxy function.", { status: 400 });
  }
  const scope = normalizeContext(contextInput, store.expected.retentionMs);
  const started = Date.now();
  for (;;) {
    const claim = await claimOrReplay(store, scope);
    if (claim.outcome === "replay") return claim.response;
    if (claim.outcome === "failed") previousFailure(claim.failure);
    if (claim.outcome === "recover") {
      return recoverClaimedRecord(store, scope, claim.record, claim.previousRecord);
    }
    if (claim.outcome === "wait") {
      if (Date.now() - started >= store.expected.lockWaitMs) pending();
      await delay(15);
      continue;
    }
    try {
      const operation = await runWithHeartbeat(store, scope, claim.record, handler);
      if (operation.operationError) {
        await failOwnedRecord(store, scope, claim.record, operation.operationError);
        throw operation.operationError;
      }
      const response = operation.result;
      let receipt;
      try {
        receipt = cloneResponse(response, store.expected);
      } catch (error) {
        await failOwnedRecord(store, scope, claim.record, error);
        throw error;
      }
      return await finalizeOwnedResponse(store, scope, claim.record, receipt);
    } finally {
      markPendingOwnerInactive(claim.record.pendingOwner);
    }
  }
}

async function inspectRecord(store, contextInput) {
  const scope = normalizeContext(contextInput, store.expected.retentionMs);
  return runLocked(store, async () => {
    const snapshot = await readSnapshot(store);
    const record = snapshot.records.find((candidate) => candidate.index === requestIndex(scope));
    return record ? cloneTrapSafeJson(record, "idempotency inspected record", { code: "IDEMPOTENCY_STORE_CORRUPT" }) : null;
  });
}

async function recoverExpiredPending(store) {
  const recovered = new Set();
  const pendingIndexes = new Set();
  const attemptedIndexes = new Set();
  for (;;) {
    const claim = await runLocked(store, async () => {
      let snapshot = await readSnapshot(store);
      const nowMs = Date.now();
      for (const record of snapshot.records) {
        if (record.state !== "pending") continue;
        if (attemptedIndexes.has(record.index)) continue;
        if (record.recoveryStage === "after-result-before-public-response") {
          const receipt = validateStoredResponse(record.response, store.expected);
          const completed = completedRecord(store, record, receipt, new Date());
          await writeAndReloadSnapshot(store, snapshot, replaceRecord(snapshot.records, completed));
          return Object.freeze({ outcome: "completed-local", index: record.index });
        }
        if (assertIso(record.leaseExpiresAt, "idempotency record leaseExpiresAt") > nowMs) continue;
        const liveness = await processOwnerLiveness(record.pendingOwner);
        const locallyInactive = liveness === "alive" && pendingOwnerIsLocallyInactive(record.pendingOwner);
        if (liveness !== "dead" && !locallyInactive) {
          pendingIndexes.add(record.index);
          attemptedIndexes.add(record.index);
          continue;
        }
        const owner = await currentProcessOwner();
        const now = new Date();
        const claimed = {
          ...record,
          updatedAt: now.toISOString(),
          expiresAt: safeIsoPlus(now, store.expected.retentionMs),
          pendingOwner: owner,
          leaseExpiresAt: safeIsoPlus(now, store.expected.pendingLeaseMs),
        };
        await writeAndReloadSnapshot(store, snapshot, replaceRecord(snapshot.records, claimed));
        markPendingOwnerActive(owner);
        return Object.freeze({ outcome: "recover", record: claimed, previousRecord: record });
      }
      return Object.freeze({ outcome: "done" });
    });
    if (claim.outcome === "done") break;
    if (claim.outcome === "completed-local") {
      recovered.add(claim.index);
      continue;
    }
    const scope = Object.freeze({
      principalId: claim.record.principalId,
      browserSessionId: claim.record.browserSessionId,
      pathname: claim.record.pathname,
      requestHash: claim.record.requestHash,
    });
    try {
      await recoverClaimedRecord(store, scope, claim.record, claim.previousRecord);
      recovered.add(claim.record.index);
    } catch (error) {
      if (safeErrorCode(error) !== "IDEMPOTENCY_RECOVERY_REQUIRED") throw error;
      pendingIndexes.add(claim.record.index);
      attemptedIndexes.add(claim.record.index);
    }
  }
  return Object.freeze({
    recovered: Object.freeze([...recovered]),
    pending: Object.freeze([...pendingIndexes]),
  });
}

function validateNullPrototypeSurface(value, keys, label) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || !Object.isFrozen(value)) {
    storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", `${label} must be a frozen lexical object.`);
  }
  if (ObjectGetPrototypeOf(value) !== null) storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", `${label} prototype is invalid.`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", `${label} fields are invalid.`);
  }
  for (const key of ownKeys) {
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.configurable || descriptor.writable || !hasOwn(descriptor, "value")) {
      storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", `${label} fields must be immutable data.`);
    }
  }
  return value;
}

function buildAttestation(store) {
  const publicMutationResponseByteEnvelopeCovered =
    store.expected.maxResponseBytes >= INTEGRATION_RETAINED_IDEMPOTENCY_MAX_RESPONSE_BYTES;
  const integrationApiWindowCovered =
    store.expected.retentionMs === INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS;
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_IDEMPOTENCY_STORE_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    preEnableStorageKernel: true,
    runtimeCapabilityEnabled: false,
    runtimeWiringIncluded: false,
    descriptorBound: true,
    recoveryAuthorityBound: false,
    trustedRecoveryReceiptAuthorityBound: false,
    integrationApiContractShapeCompatible: true,
    integrationApiWindowCovered,
    publicMutationResponseByteEnvelopeCovered,
    integrationApiCompatibleWhenRecoveryBound: false,
    globalStoreLock: true,
    oneFixedSnapshotFile: true,
    boundedInProcessFifo: true,
    atomicLookupAndDispatch: true,
    atomicComplete: true,
    postWriteReloadVerification: true,
    logicalNamespaceDigest: store.logicalNamespaceDigest,
    admissionBindingDigest: store.admissionBindingDigest,
    namespaceSealBindingDigest: store.namespaceSealBindingDigest,
    snapshotFileName: INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE,
    lockFileName: INTEGRATION_RETAINED_IDEMPOTENCY_LOCK_FILE,
    maxSnapshotBytes: store.expected.maxSnapshotBytes,
    maxRecords: store.expected.maxRecords,
    maxResponseBytes: store.expected.maxResponseBytes,
    maxResponseNodes: store.expected.maxResponseNodes,
    maxSnapshotJsonNodes: MAX_SNAPSHOT_JSON_NODES,
    pendingLeaseMs: store.expected.pendingLeaseMs,
    retentionMs: store.expected.retentionMs,
    lockWaitMs: store.expected.lockWaitMs,
    limitations: INTEGRATION_RETAINED_IDEMPOTENCY_STORE_LIMITATIONS,
  });
  return frozenRecord({ ...unsigned, digest: contractDigest(unsigned) });
}

function buildTransactionalAttestation(store) {
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_IDEMPOTENCY_TRANSACTIONAL_STORE_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    preEnableStorageKernel: true,
    testOnly: true,
    descriptorBound: true,
    recoveryCallbackBound: true,
    trustedRecoveryReceiptAuthorityBound: false,
    recoveredReceiptOwnershipValidationIncluded: false,
    integrationApiCompatible: false,
    storeProofDigest: store.attestation.digest,
    recoveryBindingDigest: store.recovery.publicProof.digest,
    logicalNamespaceDigest: store.logicalNamespaceDigest,
    admissionBindingDigest: store.admissionBindingDigest,
    namespaceSealBindingDigest: store.namespaceSealBindingDigest,
    maxSnapshotBytes: store.expected.maxSnapshotBytes,
    maxRecords: store.expected.maxRecords,
    maxResponseBytes: store.expected.maxResponseBytes,
    maxResponseNodes: store.expected.maxResponseNodes,
    pendingLeaseMs: store.expected.pendingLeaseMs,
    retentionMs: store.expected.retentionMs,
    limitations: INTEGRATION_RETAINED_IDEMPOTENCY_STORE_LIMITATIONS,
  });
  return frozenRecord({ ...unsigned, digest: contractDigest(unsigned) });
}

function validateStoreSurface(surface, store) {
  validateNullPrototypeSurface(surface, STORE_SURFACE_KEYS, "retained idempotency store surface");
  if (
    surface.schemaVersion !== INTEGRATION_RETAINED_IDEMPOTENCY_STORE_VERSION ||
    surface.attestation !== store.attestation ||
    typeof surface.health !== "function" ||
    typeof surface.inspectRecord !== "function" ||
    typeof surface.isClosed !== "function"
  ) storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Retained idempotency store surface is unavailable.");
  return surface;
}

function validateTransactionalSurface(surface, store) {
  validateNullPrototypeSurface(surface, TRANSACTIONAL_SURFACE_KEYS, "transactional retained idempotency surface");
  if (
    surface.schemaVersion !== INTEGRATION_RETAINED_IDEMPOTENCY_TRANSACTIONAL_STORE_VERSION ||
    surface.attestation !== store.transactionalAttestation ||
    surface.owner !== "aginti" ||
    surface.contractVersion !== INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION ||
    surface.durable !== true ||
    surface.crossProcessSafe !== true ||
    surface.atomicLookupAndDispatch !== true ||
    surface.atomicClaim !== true ||
    surface.atomicComplete !== true ||
    surface.failOrRecoverOnHandlerError !== true ||
    surface.noStrandedPendingOnHandlerError !== true ||
    surface.requestHashBound !== true ||
    surface.principalBound !== true ||
    surface.browserSessionBound !== true ||
    surface.sameKeySameRequestReplays !== true ||
    surface.sameKeyDifferentRequestStatus !== 409 ||
    surface.idempotencyWindowMs !== store.expected.retentionMs ||
    surface.testOnly !== true ||
    surface.requestHashAlgorithm !== INTEGRATION_RETAINED_IDEMPOTENCY_REQUEST_HASH_ALGORITHM ||
    surface.responseEnvelope !== INTEGRATION_RETAINED_IDEMPOTENCY_RESPONSE_ENVELOPE ||
    surface.recoveryAuthority !== store.recovery.publicProof ||
    typeof surface.runMutation !== "function" ||
    typeof surface.recoverExpiredPending !== "function" ||
    typeof surface.inspectRecord !== "function"
  ) storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Transactional retained idempotency surface is unavailable.");
  return surface;
}

function createStoreState(filePrimitives, lock, expectedInput) {
  rejectPromiseValue(filePrimitives, "retained idempotency file primitives", "IDEMPOTENCY_STORE_UNAVAILABLE");
  rejectPromiseValue(lock, "retained idempotency lock", "IDEMPOTENCY_STORE_UNAVAILABLE");
  const expected = normalizeExpected(expectedInput);
  try {
    assertRetainedProtectedFilePrimitives(filePrimitives, directoryExpected(expected));
    assertRetainedRegularFileLock(lock, lockExpected(expected));
  } catch {
    storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Retained idempotency storage brands do not match their binding.");
  }
  if (claimedStoreLocks.has(lock)) {
    storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Retained idempotency lock surface is already claimed.");
  }
  if (filePrimitives.isClosed() || lock.isClosed()) {
    storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Retained idempotency storage binding is closed.");
  }
  return {
    filePrimitives,
    lock,
    expected,
    logicalNamespaceDigest: logicalNamespaceDigest(expected),
    admissionBindingDigest: admissionBindingDigest(expected),
    namespaceSealBindingDigest: namespaceSealBindingDigest(
      expected,
      retainedRegularFileLockObjectIdentityDigest(lock, lockExpected(expected))
    ),
    queue: [],
    queueDraining: false,
    pendingOperations: 0,
    observedSnapshot: null,
    recovery: null,
    poisoned: false,
    poisonReason: "",
    attestation: null,
    transactionalAttestation: null,
    surface: null,
    transactionalSurface: null,
  };
}

export function createRetainedIntegrationIdempotencyStore(filePrimitives, lock, expectedInput) {
  observeRejectedArguments(arguments);
  if (arguments.length !== 3) {
    storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency store factory requires three arguments.", { status: 400 });
  }
  const store = createStoreState(filePrimitives, lock, expectedInput);
  store.attestation = buildAttestation(store);
  store.surface = validateStoreSurface(Object.freeze(Object.assign(Object.create(null), {
    schemaVersion: INTEGRATION_RETAINED_IDEMPOTENCY_STORE_VERSION,
    attestation: store.attestation,
    health() {
      observeRejectedArguments(arguments);
      if (arguments.length !== 0) {
        storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency health takes no arguments.", { status: 400 });
      }
      return runLocked(store, async () => {
        const snapshot = await readSnapshot(store);
        return Object.freeze({
          healthy: true,
          recoveryAuthorityBound: store.recovery !== null,
          revision: snapshot.revision,
          records: snapshot.records.length,
          proofDigest: store.attestation.digest,
        });
      });
    },
    inspectRecord(context) {
      observeRejectedArguments(arguments);
      if (arguments.length !== 1) {
        storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency inspectRecord requires one context.", { status: 400 });
      }
      return inspectRecord(store, context);
    },
    isClosed() {
      observeRejectedArguments(arguments);
      if (arguments.length !== 0) {
        storeFail("IDEMPOTENCY_STORE_INVALID", "Retained idempotency isClosed takes no arguments.", { status: 400 });
      }
      return store.filePrimitives.isClosed() || store.lock.isClosed();
    },
  })), store);
  storeBrand.set(store.surface, store);
  claimedStoreLocks.add(lock);
  return store.surface;
}

export function assertRetainedIntegrationIdempotencyStore(value, expectedInput) {
  observeRejectedArguments(arguments);
  rejectPromiseValue(value, "retained idempotency store", "IDEMPOTENCY_STORE_UNAVAILABLE");
  const expected = normalizeExpected(expectedInput);
  const store = value && typeof value === "object" && !utilTypes.isProxy(value) ? storeBrand.get(value) : null;
  if (!store || value !== store.surface) {
    storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Retained idempotency store lexical brand is invalid.");
  }
  validateStoreSurface(value, store);
  if (
    store.logicalNamespaceDigest !== logicalNamespaceDigest(expected) ||
    store.admissionBindingDigest !== admissionBindingDigest(expected)
  ) storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Retained idempotency expected binding is invalid.");
  return value;
}

function normalizeRecoveryBinding(input) {
  const raw = exactDataObject(input, RECOVERY_KEYS, RECOVERY_KEYS, "retained idempotency recovery binding");
  if (
    raw.owner !== "aginti" ||
    raw.explicit !== true ||
    raw.testOnly !== true ||
    raw.blindRedispatch !== false ||
    raw.beforeDispatchRecovery !== true ||
    raw.afterDispatchBeforeResultRecovery !== true ||
    raw.afterResultBeforePublicResponseRecovery !== true ||
    typeof raw.recoverPending !== "function" ||
    utilTypes.isProxy(raw.recoverPending)
  ) storeFail("IDEMPOTENCY_RECOVERY_AUTHORITY_INVALID", "Retained idempotency recovery authority is invalid.");
  const publicProof = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_IDEMPOTENCY_RECOVERY_BINDING_VERSION,
    owner: "aginti",
    explicit: true,
    testOnly: true,
    blindRedispatch: false,
    beforeDispatchRecovery: true,
    afterDispatchBeforeResultRecovery: true,
    afterResultBeforePublicResponseRecovery: true,
  });
  return Object.freeze({
    recoverPending: raw.recoverPending,
    publicProof: Object.freeze({ ...publicProof, digest: contractDigest(publicProof) }),
  });
}

function buildTransactionalSurface(store) {
  const surface = Object.freeze(Object.assign(Object.create(null), {
    schemaVersion: INTEGRATION_RETAINED_IDEMPOTENCY_TRANSACTIONAL_STORE_VERSION,
    attestation: store.transactionalAttestation,
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
    idempotencyWindowMs: store.expected.retentionMs,
    testOnly: true,
    requestHashAlgorithm: INTEGRATION_RETAINED_IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
    responseEnvelope: INTEGRATION_RETAINED_IDEMPOTENCY_RESPONSE_ENVELOPE,
    recoveryAuthority: store.recovery.publicProof,
    runMutation(context, handler) {
      observeRejectedArguments(arguments);
      if (arguments.length !== 2) {
        storeFail("IDEMPOTENCY_STORE_INVALID", "Transactional idempotency runMutation requires two arguments.", {
          status: 400,
        });
      }
      assertStoreOpen(store);
      return runMutation(store, context, handler);
    },
    recoverExpiredPending() {
      observeRejectedArguments(arguments);
      if (arguments.length !== 0) {
        storeFail("IDEMPOTENCY_STORE_INVALID", "Transactional idempotency recovery takes no arguments.", { status: 400 });
      }
      assertStoreOpen(store);
      return recoverExpiredPending(store);
    },
    inspectRecord(context) {
      observeRejectedArguments(arguments);
      if (arguments.length !== 1) {
        storeFail("IDEMPOTENCY_STORE_INVALID", "Transactional idempotency inspectRecord requires one context.", { status: 400 });
      }
      return inspectRecord(store, context);
    },
  }));
  validateTransactionalSurface(surface, store);
  transactionalBrand.set(surface, store);
  return surface;
}

export function bindRetainedIntegrationIdempotencyRecoveryAuthority(value, expectedInput, recoveryInput) {
  observeRejectedArguments(arguments);
  if (arguments.length !== 3) {
    storeFail("IDEMPOTENCY_RECOVERY_AUTHORITY_INVALID", "Recovery binding requires three arguments.", { status: 400 });
  }
  assertRetainedIntegrationIdempotencyStore(value, expectedInput);
  const store = storeBrand.get(value);
  const recovery = normalizeRecoveryBinding(recoveryInput);
  if (store.pendingOperations !== 0 || store.queueDraining) {
    storeFail("IDEMPOTENCY_STORE_BUSY", "Recovery binding requires an idle retained idempotency store.", { status: 429 });
  }
  if (store.recovery) {
    if (store.recovery.recoverPending !== recovery.recoverPending) {
      storeFail("IDEMPOTENCY_RECOVERY_AUTHORITY_INVALID", "Retained idempotency store is bound to another recovery authority.");
    }
    return store.transactionalSurface;
  }
  store.recovery = recovery;
  store.transactionalAttestation = buildTransactionalAttestation(store);
  store.transactionalSurface = buildTransactionalSurface(store);
  return store.transactionalSurface;
}

export function assertRetainedIntegrationTransactionalIdempotencyStore(value, expectedInput) {
  observeRejectedArguments(arguments);
  rejectPromiseValue(value, "transactional retained idempotency store", "IDEMPOTENCY_STORE_UNAVAILABLE");
  const expected = normalizeExpected(expectedInput);
  const store = value && typeof value === "object" && !utilTypes.isProxy(value)
    ? transactionalBrand.get(value)
    : null;
  if (!store || value !== store.transactionalSurface || !store.recovery) {
    storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Transactional retained idempotency lexical brand is invalid.");
  }
  validateTransactionalSurface(value, store);
  if (
    store.logicalNamespaceDigest !== logicalNamespaceDigest(expected) ||
    store.admissionBindingDigest !== admissionBindingDigest(expected)
  ) storeFail("IDEMPOTENCY_STORE_UNAVAILABLE", "Transactional retained idempotency binding is invalid.");
  return value;
}
