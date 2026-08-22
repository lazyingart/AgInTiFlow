import crypto from "node:crypto";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { contractDigest } from "./integration-policy.js";
import {
  INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
  assertRetainedProtectedFilePrimitives,
  assertRetainedRegularFileLock,
  retainedRegularFileLockObjectIdentityDigest,
  authorityFail,
} from "./integration-durable-common.js";

export const INTEGRATION_RETAINED_REPOSITORY_KERNEL_VERSION =
  "aginti-retained-integration-repository-kernel-v1";
export const INTEGRATION_RETAINED_REPOSITORY_KERNEL_ATTESTATION_VERSION =
  "aginti-retained-integration-repository-kernel-attestation-v2";
export const INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_VERSION =
  "aginti-retained-integration-repository-snapshot-v1";
export const INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_VERSION =
  "aginti-retained-integration-repository-last-commit-v1";
export const INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_INTEGRITY_DOMAIN =
  "aginti-retained-integration-repository-snapshot";
export const INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_INTEGRITY_DOMAIN =
  "aginti-retained-integration-repository-last-commit";
export const INTEGRATION_RETAINED_REPOSITORY_PAYLOAD_DIGEST_DOMAIN =
  "aginti-retained-integration-repository-payload-v1";

export const INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE = "repository.snapshot.json";
export const INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE = ".aginti-flock-v1-repository-kernel";
export const INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH = 64;
export const INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES = 100_000;
export const INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_OPERATIONS = 1024;
export const INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_NODES =
  2 * INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES;

const ZERO_DIGEST = "0".repeat(64);
const MIN_SNAPSHOT_BYTES = 4096;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_LOCK_WAIT_MS = 60_000;
const POINTER_DOMAIN = "aginti-retained-integration-repository-pointer-v1";
const SNAPSHOT_ENVELOPE_JSON_NODES = 18;

export const INTEGRATION_RETAINED_REPOSITORY_KERNEL_LIMITATIONS = Object.freeze(Object.assign(Object.create(null), {
  preEnableStorageKernel: true,
  runtimeCapabilityEnabled: false,
  runtimeWiringIncluded: false,
  runtimeRepositorySurface: false,
  repositoryDomainValidation: false,
  repositoryTransitionsIncluded: false,
  artifactSemanticsIncluded: false,
  recoverySemanticsIncluded: false,
  onePreprovisionedRetainedDirectoryRequired: true,
  dedicatedRetainedDirectoryRequired: true,
  dedicatedDirectoryExclusivityVerified: false,
  cooperativeExclusiveSnapshotMutationRequired: true,
  onePreprovisionedFixedLockFileRequired: true,
  oneFixedSnapshotFile: true,
  wholeSnapshotRewrite: true,
  multiFileTransactions: false,
  nativeSessionStoreIntegration: false,
  nativeSessionStoreAtomicity: false,
  eventLedgerIntegration: false,
  eventLedgerAtomicity: false,
  idempotencyStoreIntegration: false,
  crossStoreIdempotency: false,
  sameKernelHostRequired: true,
  crossHostExclusion: false,
  localFilesystemRequired: true,
  localFilesystemVerified: false,
  networkFilesystemSafety: false,
  cooperativeParticipantsOnly: true,
  sameUidNonparticipantSafety: false,
  advisoryLock: true,
  fencingTokens: false,
  oneGlobalContentionDomain: true,
  boundedInProcessFifo: true,
  queueBoundsPerKernelSurface: true,
  aggregateQueueBoundAcrossKernelSurfaces: false,
  consistentMaxSnapshotBytesAcrossKernelSurfacesRequired: true,
  maxPendingOperations: INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_OPERATIONS,
  maxPendingPayloadBytes: INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_BYTES,
  maxPendingPayloadNodes: INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_NODES,
  pendingPayloadByteCapIncludesActiveOperation: true,
  pendingPayloadNodeCapIncludesActiveOperation: true,
  oneSynchronousPayloadNormalizationMayBeAdditional: true,
  maximumAdditionalSynchronousNormalizationBytes: MAX_SNAPSHOT_BYTES,
  maximumAdditionalSynchronousNormalizationNodes: INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES,
  oneActiveCanonicalSnapshotSerializationMayBeAdditional: true,
  storagePrimitiveTransientMemoryIncludedInQueueWeightCaps: false,
  maxJsonDepth: INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH,
  maxJsonNodes: INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES,
  enumeration: false,
  prune: false,
  migration: false,
  lastCommitReplayOnly: true,
  olderTransactionIdReuseDetection: false,
  callerDomainOwnsLongLivedIdempotency: true,
  longLivedDomainReceiptsIncluded: false,
  pointerDigestStableAcrossReopen: true,
  admissionBindingDigestStableAcrossReopen: false,
  namespaceSealBindingDigestStableAcrossReopen: true,
  namespaceSealBindingIncludesStableLockObjectIdentity: true,
  namespaceSealBindingExcludesMutableDirectoryIdentity: true,
  sameSurfaceObservedRollbackDetection: true,
  freshFactoryValidRollbackDetection: false,
  atomicSameDirectoryReplace: true,
  crashMayLeaveReservedTemp: true,
  crashBeforeRenamePreservesPreviousSnapshot: true,
  crashAfterRenameRequiresReconciliation: true,
  lockCrashSemanticsInheritedFromRetainedFlock: true,
  helperInFlightMayDelayCrashRelease: true,
  automaticTempRecovery: false,
  postWriteReloadVerification: true,
  corruptionPoisonsSurface: true,
  commitAmbiguityPoisonsSurface: true,
  lockReleaseAmbiguityPoisonsSurface: true,
  ambiguousLockReleaseRequiresProcessRestart: true,
  freshFactoryRequiredForCommitReconciliation: true,
  storageLifecycleOwned: false,
  callerMustCloseOwningAuthority: true,
  diskExhaustionFailsClosed: true,
  hardwareDurabilityGuarantee: false,
}));

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
  "lockWaitMs",
]);
const CAS_KEYS = Object.freeze([
  "transactionId",
  "requestDigest",
  "expectedSnapshotRevision",
  "expectedIntegrityDigest",
  "payload",
]);
const SURFACE_KEYS = Object.freeze([
  "schemaVersion",
  "attestation",
  "loadSnapshot",
  "compareAndSwapSnapshot",
  "isClosed",
]);
const ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "preEnableStorageKernel",
  "runtimeCapabilityEnabled",
  "runtimeWiringIncluded",
  "runtimeRepositorySurface",
  "repositoryDomainValidation",
  "repositoryTransitionsIncluded",
  "artifactSemanticsIncluded",
  "recoverySemanticsIncluded",
  "singleCanonicalSnapshot",
  "boundedSnapshot",
  "compareAndSwap",
  "revisionExactlyOne",
  "globalStoreLock",
  "postWriteReloadVerification",
  "storageLifecycleOwned",
  "snapshotFileName",
  "lockFileNameDigest",
  "pointerDigest",
  "admissionBindingDigest",
  "namespaceSealBindingDigest",
  "maxSnapshotBytes",
  "maxJsonDepth",
  "maxJsonNodes",
  "maxPendingOperations",
  "maxPendingPayloadBytes",
  "maxPendingPayloadNodes",
  "maxTransientNormalizationBytes",
  "maxTransientNormalizationNodes",
  "lockWaitMs",
  "limitations",
  "digest",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "pointerDigest",
  "snapshotRevision",
  "previousIntegrityDigest",
  "payload",
  "payloadDigest",
  "lastCommit",
  "integrityDigest",
]);
const LAST_COMMIT_KEYS = Object.freeze([
  "schemaVersion",
  "transactionId",
  "requestDigest",
  "baseSnapshotRevision",
  "baseIntegrityDigest",
  "resultSnapshotRevision",
  "payloadDigest",
  "commitDigest",
]);
const CAS_RESULT_KEYS = Object.freeze(["outcome", "snapshot"]);
const SAFE_STORAGE_PHASES = Object.freeze([
  "acquire",
  "post-acquire-pre-operation",
  "operation",
  "post-operation-validation",
  "lock-handle-close",
  "helper-handle-close",
]);

const repositoryKernelBrand = new WeakMap();
const claimedRepositoryKernelLocks = new WeakSet();
const NativePromise = Promise;
const PromiseThen = Promise.prototype.then;
const ReflectApply = Reflect.apply;
const ReflectDefineProperty = Reflect.defineProperty;
const ArrayPush = Array.prototype.push;
const ArrayShift = Array.prototype.shift;
const ArrayJoin = Array.prototype.join;
const ArraySort = Array.prototype.sort;
const ArrayFilter = Array.prototype.filter;
const ArraySome = Array.prototype.some;
const ArrayIncludes = Array.prototype.includes;
const JsonStringify = JSON.stringify;
const StringIncludes = String.prototype.includes;
const StringStartsWith = String.prototype.startsWith;
const StringEndsWith = String.prototype.endsWith;
const SafePromiseConstructor = Object.create(null);
Object.defineProperty(SafePromiseConstructor, Symbol.species, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: NativePromise,
});
Object.freeze(SafePromiseConstructor);

function kernelFail(code, message, { status = 503, details = Object.freeze(Object.create(null)) } = {}) {
  authorityFail(code, message, { status, details });
}

function exactDataObject(value, allowedKeys, requiredKeys, label, code = "INTEGRATION_REPOSITORY_KERNEL_INVALID") {
  if (value && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value)) {
    kernelFail(code, `${label} must not be a Proxy.`, { status: statusForCode(code) });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    kernelFail(code, `${label} must be a plain data object.`, { status: statusForCode(code) });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    kernelFail(code, `${label} prototype is invalid.`, { status: statusForCode(code) });
  }
  const allowed = new Set(allowedKeys);
  const clone = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      kernelFail(code, `${label} contains an unsupported field.`, { status: statusForCode(code) });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      kernelFail(code, `${label} fields must be enumerable data.`, { status: statusForCode(code) });
    }
    Object.defineProperty(clone, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value,
    });
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(clone, key)) {
      kernelFail(code, `${label} is missing a required field.`, { status: statusForCode(code) });
    }
  }
  return Object.freeze(clone);
}

function structuralFailure(code, label) {
  kernelFail(code, `${label} exceeds repository kernel structural bounds.`, {
    status: code === "INTEGRATION_REPOSITORY_KERNEL_FULL" ? 409 : code === "INTEGRATION_REPOSITORY_KERNEL_INVALID" ? 400 : 503,
  });
}

function statusForCode(code) {
  if (code === "INTEGRATION_REPOSITORY_KERNEL_INVALID") return 400;
  if (code === "INTEGRATION_REPOSITORY_KERNEL_FULL") return 409;
  return 503;
}

function addCanonicalBytes(state, amount, label) {
  if (!state.byteLimit) return;
  state.bytes = (state.bytes || 0) + amount;
  if (state.bytes > state.byteLimit) {
    structuralFailure("INTEGRATION_REPOSITORY_KERNEL_FULL", label);
  }
}

function addCanonicalStringBytes(state, value, label) {
  if (!state.byteLimit) return;
  addCanonicalBytes(state, 2, label);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      addCanonicalBytes(state, 2, label);
    } else if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff && !(
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ))) {
      addCanonicalBytes(state, 6, label);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      addCanonicalBytes(state, 4, label);
      index += 1;
    } else if (code <= 0x7f) {
      addCanonicalBytes(state, 1, label);
    } else if (code <= 0x7ff) {
      addCanonicalBytes(state, 2, label);
    } else {
      addCanonicalBytes(state, 3, label);
    }
  }
}

function cloneCanonicalJson(value, label, state = {}, depth = 0) {
  state.nodes = (state.nodes || 0) + 1;
  state.maximumDepth = Math.max(state.maximumDepth || 0, depth);
  const overflowCode = state.overflowCode || "INTEGRATION_REPOSITORY_KERNEL_INVALID";
  const shapeCode = state.shapeCode || "INTEGRATION_REPOSITORY_KERNEL_INVALID";
  if (
    state.nodes > INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES ||
    depth > INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH
  ) {
    structuralFailure(overflowCode, label);
  }
  if (value === null) {
    addCanonicalBytes(state, 4, label);
    return value;
  }
  if (typeof value === "string") {
    addCanonicalStringBytes(state, value, label);
    return value;
  }
  if (typeof value === "boolean") {
    addCanonicalBytes(state, value ? 4 : 5, label);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      kernelFail(shapeCode, `${label} contains a non-canonical number.`, {
        status: statusForCode(shapeCode),
      });
    }
    addCanonicalBytes(state, Buffer.byteLength(ReflectApply(JsonStringify, JSON, [value]), "utf8"), label);
    return value;
  }
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) {
    kernelFail(shapeCode, `${label} must contain only trap-safe JSON data.`, {
      status: statusForCode(shapeCode),
    });
  }
  state.active ||= new WeakSet();
  if (state.active.has(value)) {
    kernelFail(shapeCode, `${label} must not contain cycles.`, {
      status: statusForCode(shapeCode),
    });
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(value.length)) {
        kernelFail(shapeCode, `${label} array shape is invalid.`, {
          status: statusForCode(shapeCode),
        });
      }
      if (value.length > INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES - state.nodes) {
        structuralFailure(overflowCode, label);
      }
      addCanonicalBytes(state, 2 + Math.max(0, value.length - 1), label);
      const keys = Reflect.ownKeys(value);
      const indexKeys = ReflectApply(ArrayFilter, keys, [(key) => key !== "length"]);
      if (
        indexKeys.length !== value.length ||
        ReflectApply(ArraySome, indexKeys, [(key) => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)])
      ) {
        kernelFail(shapeCode, `${label} array must be dense data.`, {
          status: statusForCode(shapeCode),
        });
      }
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          kernelFail(shapeCode, `${label} array entries must be enumerable data.`, {
            status: statusForCode(shapeCode),
          });
        }
        clone[index] = cloneCanonicalJson(descriptor.value, `${label} item`, state, depth + 1);
      }
      return Object.freeze(clone);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      kernelFail(shapeCode, `${label} object prototype is invalid.`, {
        status: statusForCode(shapeCode),
      });
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES - state.nodes) {
      structuralFailure(overflowCode, label);
    }
    if (ReflectApply(ArraySome, keys, [(key) => typeof key !== "string"])) {
      kernelFail(shapeCode, `${label} must not contain symbols.`, {
        status: statusForCode(shapeCode),
      });
    }
    const clone = Object.create(null);
    addCanonicalBytes(state, 2 + Math.max(0, keys.length - 1), label);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        kernelFail(shapeCode, `${label} fields must be enumerable data.`, {
          status: statusForCode(shapeCode),
        });
      }
      addCanonicalStringBytes(state, key, label);
      addCanonicalBytes(state, 1, label);
      Object.defineProperty(clone, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: cloneCanonicalJson(descriptor.value, `${label} field`, state, depth + 1),
      });
    }
    return Object.freeze(clone);
  } finally {
    state.active.delete(value);
  }
}

function canonicalJson(value, active = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return ReflectApply(JsonStringify, JSON, [value]);
  }
  if (typeof value === "number" && Number.isFinite(value)) return ReflectApply(JsonStringify, JSON, [value]);
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || active.has(value)) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_CORRUPT", "Repository snapshot is not canonical JSON data.");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const parts = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          kernelFail("INTEGRATION_REPOSITORY_KERNEL_CORRUPT", "Repository snapshot array fields are invalid.");
        }
        parts[index] = canonicalJson(descriptor.value, active);
      }
      return `[${ReflectApply(ArrayJoin, parts, [","])}]`;
    }
    const keys = Reflect.ownKeys(value);
    if (ReflectApply(ArraySome, keys, [(key) => typeof key !== "string"])) {
      kernelFail("INTEGRATION_REPOSITORY_KERNEL_CORRUPT", "Repository snapshot contains unsupported fields.");
    }
    ReflectApply(ArraySort, keys, []);
    const fields = new Array(keys.length);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        kernelFail("INTEGRATION_REPOSITORY_KERNEL_CORRUPT", "Repository snapshot object fields are invalid.");
      }
      fields[index] = `${ReflectApply(JsonStringify, JSON, [key])}:${canonicalJson(descriptor.value, active)}`;
    }
    return `{${ReflectApply(ArrayJoin, fields, [","])}}`;
  } finally {
    active.delete(value);
  }
}

function assertDigest(value, label, code = "INTEGRATION_REPOSITORY_KERNEL_INVALID") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    kernelFail(code, `${label} is invalid.`, { status: code === "INTEGRATION_REPOSITORY_KERNEL_INVALID" ? 400 : 503 });
  }
  return value;
}

function assertTransactionId(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 160 ||
    !/^[A-Za-z0-9._~-]+$/u.test(value) ||
    ReflectApply(StringIncludes, value, [".."])
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository transaction id is invalid.", { status: 400 });
  }
  return value;
}

function normalizeExpected(input) {
  const raw = exactDataObject(input, EXPECTED_KEYS, EXPECTED_KEYS, "repository kernel expected binding");
  if (typeof raw.role !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/u.test(raw.role)) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository kernel logical binding is invalid.", { status: 400 });
  }
  if (
    typeof raw.canonicalPath !== "string" ||
    ReflectApply(StringIncludes, raw.canonicalPath, ["\0"]) ||
    !path.isAbsolute(raw.canonicalPath) ||
    path.normalize(raw.canonicalPath) !== raw.canonicalPath ||
    raw.canonicalPath === path.parse(raw.canonicalPath).root ||
    ReflectApply(StringEndsWith, raw.canonicalPath, [path.sep])
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository kernel canonical path is invalid.", { status: 400 });
  }
  for (const field of [
    "rootIdentityDigest",
    "directoryIdentityDigest",
    "lockFileIdentityDigest",
    "helperSha256",
    "helperIdentityDigest",
  ]) {
    assertDigest(raw[field], `repository kernel ${field}`);
  }
  const relativeSegments = cloneCanonicalJson(raw.relativeSegments, "repository kernel relative segments");
  if (!Array.isArray(relativeSegments) || relativeSegments.length < 1 || relativeSegments.length > 64) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository kernel requires a dedicated retained directory.", {
      status: 400,
    });
  }
  for (const segment of relativeSegments) {
    if (
      typeof segment !== "string" ||
      Buffer.byteLength(segment, "utf8") > 160 ||
      !/^[A-Za-z0-9._:-]+$/u.test(segment) ||
      ReflectApply(StringIncludes, segment, ["/"]) ||
      ReflectApply(StringIncludes, segment, ["\\"]) ||
      ReflectApply(StringIncludes, segment, ["\0"]) ||
      segment === "." ||
      segment === ".." ||
      ReflectApply(StringStartsWith, segment, [".aginti-atomic-v1-"]) ||
      ReflectApply(StringStartsWith, segment, [".aginti-flock-v1-"])
    ) {
      kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository kernel retained directory segment is invalid.", {
        status: 400,
      });
    }
  }
  if (
    !Number.isSafeInteger(raw.maxSnapshotBytes) ||
    raw.maxSnapshotBytes < MIN_SNAPSHOT_BYTES ||
    raw.maxSnapshotBytes > MAX_SNAPSHOT_BYTES
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository kernel snapshot byte cap is invalid.", { status: 400 });
  }
  if (!Number.isSafeInteger(raw.lockWaitMs) || raw.lockWaitMs < 0 || raw.lockWaitMs > MAX_LOCK_WAIT_MS) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository kernel lock wait is invalid.", { status: 400 });
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
    lockFileName: INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
    helperSha256: expected.helperSha256,
    lockFileIdentityDigest: expected.lockFileIdentityDigest,
    helperIdentityDigest: expected.helperIdentityDigest,
  });
}

function logicalPointerDigest(expected) {
  return contractDigest({
    domain: POINTER_DOMAIN,
    schemaVersion: INTEGRATION_RETAINED_REPOSITORY_KERNEL_VERSION,
    role: expected.role,
    canonicalPath: expected.canonicalPath,
    relativeSegments: expected.relativeSegments,
    snapshotFileName: INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE,
  });
}

function admissionBindingDigest(expected) {
  return contractDigest({
    schemaVersion: "aginti-retained-integration-repository-binding-v1",
    directory: directoryExpected(expected),
    lock: lockExpected(expected),
    maxSnapshotBytes: expected.maxSnapshotBytes,
    lockWaitMs: expected.lockWaitMs,
  });
}

function namespaceSealBindingDigest(expected, lockObjectIdentityDigest) {
  return contractDigest({
    schemaVersion: "aginti-retained-integration-repository-seal-binding-v1",
    role: expected.role,
    canonicalPath: expected.canonicalPath,
    relativeSegments: expected.relativeSegments,
    lockFileName: INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
    lockFileObjectIdentityDigest: lockObjectIdentityDigest,
    helperSha256: expected.helperSha256,
    maxSnapshotBytes: expected.maxSnapshotBytes,
  });
}

function normalizeCasInput(input, maxSnapshotBytes) {
  const raw = exactDataObject(input, CAS_KEYS, CAS_KEYS, "repository kernel compare-and-swap input");
  const transactionId = assertTransactionId(raw.transactionId);
  const requestDigest = assertDigest(raw.requestDigest, "repository kernel request digest");
  if (!Number.isSafeInteger(raw.expectedSnapshotRevision) || raw.expectedSnapshotRevision < 0) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository kernel expected revision is invalid.", { status: 400 });
  }
  const expectedIntegrityDigest = assertDigest(raw.expectedIntegrityDigest, "repository kernel expected integrity digest");
  if (
    (raw.expectedSnapshotRevision === 0 && expectedIntegrityDigest !== ZERO_DIGEST) ||
    (raw.expectedSnapshotRevision > 0 && expectedIntegrityDigest === ZERO_DIGEST)
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository kernel expected revision and digest disagree.", {
      status: 400,
    });
  }
  if (!raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload) || utilTypes.isProxy(raw.payload)) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository kernel payload must be a trap-safe plain object.", {
      status: 400,
    });
  }
  const normalizationState = {
    nodes: 0,
    active: new WeakSet(),
    overflowCode: "INTEGRATION_REPOSITORY_KERNEL_FULL",
    shapeCode: "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    byteLimit: maxSnapshotBytes,
    bytes: 0,
  };
  const payload = cloneCanonicalJson(raw.payload, "repository kernel payload", normalizationState);
  return Object.freeze({
    transactionId,
    requestDigest,
    expectedSnapshotRevision: raw.expectedSnapshotRevision,
    expectedIntegrityDigest,
    payload,
    payloadCanonicalBytes: normalizationState.bytes,
    payloadCanonicalNodes: normalizationState.nodes,
    payloadCanonicalDepth: normalizationState.maximumDepth,
    payloadDigest: contractDigest({
      domain: INTEGRATION_RETAINED_REPOSITORY_PAYLOAD_DIGEST_DOMAIN,
      payload,
    }),
  });
}

function frozenRecord(value) {
  return Object.freeze(Object.assign(Object.create(null), value));
}

function payloadDigest(payload) {
  return contractDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_PAYLOAD_DIGEST_DOMAIN,
    payload,
  });
}

function lastCommitDigest(receipt) {
  const unsigned = Object.create(null);
  for (const key of LAST_COMMIT_KEYS) {
    if (key !== "commitDigest") unsigned[key] = receipt[key];
  }
  return contractDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: unsigned,
  });
}

function snapshotIntegrityDigest(snapshot) {
  const unsigned = Object.create(null);
  for (const key of SNAPSHOT_KEYS) {
    if (key !== "integrityDigest") unsigned[key] = snapshot[key];
  }
  return contractDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: unsigned,
  });
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function makeVirtualSnapshot(state) {
  return frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_VERSION,
    owner: "aginti",
    authority: "aginti",
    pointerDigest: state.pointerDigest,
    snapshotRevision: 0,
    previousIntegrityDigest: ZERO_DIGEST,
    payload: null,
    payloadDigest: payloadDigest(null),
    lastCommit: null,
    integrityDigest: ZERO_DIGEST,
  });
}

function makeLastCommit(input, current, resultRevision) {
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_VERSION,
    transactionId: input.transactionId,
    requestDigest: input.requestDigest,
    baseSnapshotRevision: current.snapshotRevision,
    baseIntegrityDigest: current.integrityDigest,
    resultSnapshotRevision: resultRevision,
    payloadDigest: input.payloadDigest,
  });
  return frozenRecord({ ...unsigned, commitDigest: lastCommitDigest(unsigned) });
}

function makeSnapshotCandidate(state, current, input) {
  const snapshotRevision = current.snapshotRevision + 1;
  const lastCommit = makeLastCommit(input, current, snapshotRevision);
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_VERSION,
    owner: "aginti",
    authority: "aginti",
    pointerDigest: state.pointerDigest,
    snapshotRevision,
    previousIntegrityDigest: current.integrityDigest,
    payload: input.payload,
    payloadDigest: input.payloadDigest,
    lastCommit,
  });
  const snapshot = frozenRecord({ ...unsigned, integrityDigest: snapshotIntegrityDigest(unsigned) });
  if (
    input.payloadCanonicalNodes > INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES - SNAPSHOT_ENVELOPE_JSON_NODES ||
    input.payloadCanonicalDepth + 1 > INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH
  ) {
    structuralFailure("INTEGRATION_REPOSITORY_KERNEL_FULL", "repository snapshot candidate");
  }
  const text = `${canonicalJson(snapshot)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > state.expected.maxSnapshotBytes) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_FULL", "Repository snapshot byte cap is exhausted.", { status: 409 });
  }
  return frozenRecord({ snapshot, text, bytes, fileDigest: sha256Text(text) });
}

function poisonKernel(state, reason = "Repository kernel state requires reconciliation.") {
  if (!state.poisoned) {
    state.poisoned = true;
    state.poisonReason = reason;
  }
}

function corruptKernel(state, message = "Repository snapshot is corrupt.") {
  poisonKernel(state, "Repository snapshot validation failed.");
  kernelFail("INTEGRATION_REPOSITORY_KERNEL_CORRUPT", message);
}

function assertKernelOpen(state) {
  if (state.poisoned) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_POISONED", "Repository kernel is poisoned and requires reconciliation.");
  }
  if (state.filePrimitives.isClosed() || state.lock.isClosed()) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository kernel storage binding is closed.");
  }
}

function validateLastCommit(state, receipt, snapshot) {
  const commit = exactDataObject(
    receipt,
    LAST_COMMIT_KEYS,
    LAST_COMMIT_KEYS,
    "repository last commit receipt",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  if (
    commit.schemaVersion !== INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_VERSION ||
    typeof commit.transactionId !== "string" ||
    commit.transactionId.length < 16 ||
    commit.transactionId.length > 160 ||
    !/^[A-Za-z0-9._~-]+$/u.test(commit.transactionId) ||
    ReflectApply(StringIncludes, commit.transactionId, [".."]) ||
    !Number.isSafeInteger(commit.baseSnapshotRevision) ||
    commit.baseSnapshotRevision !== snapshot.snapshotRevision - 1 ||
    !Number.isSafeInteger(commit.resultSnapshotRevision) ||
    commit.resultSnapshotRevision !== snapshot.snapshotRevision ||
    commit.baseIntegrityDigest !== snapshot.previousIntegrityDigest ||
    commit.payloadDigest !== snapshot.payloadDigest
  ) {
    corruptKernel(state, "Repository last commit receipt is invalid.");
  }
  assertDigest(commit.requestDigest, "repository last commit request digest", "INTEGRATION_REPOSITORY_KERNEL_CORRUPT");
  assertDigest(commit.baseIntegrityDigest, "repository last commit base integrity digest", "INTEGRATION_REPOSITORY_KERNEL_CORRUPT");
  assertDigest(commit.payloadDigest, "repository last commit payload digest", "INTEGRATION_REPOSITORY_KERNEL_CORRUPT");
  assertDigest(commit.commitDigest, "repository last commit digest", "INTEGRATION_REPOSITORY_KERNEL_CORRUPT");
  if (
    (commit.baseSnapshotRevision === 0 && commit.baseIntegrityDigest !== ZERO_DIGEST) ||
    (commit.baseSnapshotRevision > 0 && commit.baseIntegrityDigest === ZERO_DIGEST) ||
    commit.commitDigest !== lastCommitDigest(commit)
  ) {
    corruptKernel(state, "Repository last commit receipt integrity is invalid.");
  }
  return commit;
}

function validatePersistedSnapshot(state, parsed, raw) {
  const detached = cloneCanonicalJson(parsed, "repository snapshot", {
    nodes: 0,
    active: new WeakSet(),
    overflowCode: "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
    shapeCode: "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
  });
  const snapshot = exactDataObject(
    detached,
    SNAPSHOT_KEYS,
    SNAPSHOT_KEYS,
    "repository snapshot",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  if (
    snapshot.schemaVersion !== INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_VERSION ||
    snapshot.owner !== "aginti" ||
    snapshot.authority !== "aginti" ||
    snapshot.pointerDigest !== state.pointerDigest ||
    !Number.isSafeInteger(snapshot.snapshotRevision) ||
    snapshot.snapshotRevision < 1 ||
    !snapshot.payload ||
    typeof snapshot.payload !== "object" ||
    Array.isArray(snapshot.payload)
  ) {
    corruptKernel(state, "Repository snapshot binding is invalid.");
  }
  for (const [value, label] of [
    [snapshot.previousIntegrityDigest, "repository previous integrity digest"],
    [snapshot.payloadDigest, "repository payload digest"],
    [snapshot.integrityDigest, "repository snapshot integrity digest"],
  ]) {
    assertDigest(value, label, "INTEGRATION_REPOSITORY_KERNEL_CORRUPT");
  }
  if (
    (snapshot.snapshotRevision === 1 && snapshot.previousIntegrityDigest !== ZERO_DIGEST) ||
    (snapshot.snapshotRevision > 1 && snapshot.previousIntegrityDigest === ZERO_DIGEST) ||
    snapshot.payloadDigest !== payloadDigest(snapshot.payload)
  ) {
    corruptKernel(state, "Repository snapshot revision or payload binding is invalid.");
  }
  validateLastCommit(state, snapshot.lastCommit, snapshot);
  if (snapshot.integrityDigest !== snapshotIntegrityDigest(snapshot)) {
    corruptKernel(state, "Repository snapshot integrity digest is invalid.");
  }
  const canonical = `${canonicalJson(snapshot)}\n`;
  if (raw !== canonical || Buffer.byteLength(raw, "utf8") > state.expected.maxSnapshotBytes) {
    corruptKernel(state, "Repository snapshot bytes are not canonical or bounded.");
  }
  return snapshot;
}

function observeSnapshot(state, snapshot) {
  if (state.observedRevision !== null) {
    if (
      snapshot.snapshotRevision < state.observedRevision ||
      (snapshot.snapshotRevision === state.observedRevision && snapshot.integrityDigest !== state.observedDigest) ||
      (
        snapshot.snapshotRevision === state.observedRevision + 1 &&
        snapshot.previousIntegrityDigest !== state.observedDigest
      )
    ) {
      corruptKernel(state, "Repository snapshot rolled back or diverged from the observed state.");
    }
  }
  if (state.observedRevision === null || snapshot.snapshotRevision > state.observedRevision) {
    state.observedRevision = snapshot.snapshotRevision;
    state.observedDigest = snapshot.integrityDigest;
  }
  return snapshot;
}

async function readSnapshotRecord(state) {
  const raw = await state.filePrimitives.readProtectedUtf8File(INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE, {
    optional: true,
    maxBytes: state.expected.maxSnapshotBytes,
  });
  if (raw === null) {
    if (state.observedRevision !== null && state.observedRevision > 0) {
      corruptKernel(state, "Repository snapshot disappeared after it was observed.");
    }
    const snapshot = makeVirtualSnapshot(state);
    observeSnapshot(state, snapshot);
    return frozenRecord({ snapshot, bytes: 0, fileDigest: ZERO_DIGEST, persisted: false });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    corruptKernel(state, "Repository snapshot contains invalid JSON.");
  }
  let snapshot;
  try {
    snapshot = validatePersistedSnapshot(state, parsed, raw);
  } catch (error) {
    if (error?.publicCode === "INTEGRATION_REPOSITORY_KERNEL_CORRUPT") {
      poisonKernel(state, "Repository snapshot validation failed.");
      throw error;
    }
    corruptKernel(state);
  }
  observeSnapshot(state, snapshot);
  return frozenRecord({
    snapshot,
    bytes: Buffer.byteLength(raw, "utf8"),
    fileDigest: sha256Text(raw),
    persisted: true,
  });
}

function exactReplay(current, input) {
  const commit = current.lastCommit;
  if (!commit || commit.transactionId !== input.transactionId) return false;
  if (
    commit.requestDigest !== input.requestDigest ||
    commit.baseSnapshotRevision !== input.expectedSnapshotRevision ||
    commit.baseIntegrityDigest !== input.expectedIntegrityDigest ||
    commit.resultSnapshotRevision !== current.snapshotRevision ||
    commit.payloadDigest !== input.payloadDigest ||
    current.payloadDigest !== input.payloadDigest ||
    canonicalJson(current.payload) !== canonicalJson(input.payload)
  ) {
    kernelFail(
      "INTEGRATION_REPOSITORY_KERNEL_TRANSACTION_CONFLICT",
      "Repository transaction id is already bound to a different request.",
      { status: 409 }
    );
  }
  return true;
}

function casResult(outcome, snapshot) {
  const result = frozenRecord({ outcome, snapshot });
  if (Reflect.ownKeys(result).length !== CAS_RESULT_KEYS.length) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository compare-and-swap result is invalid.");
  }
  return result;
}

function enqueueKernelOperation(state, operation, payloadBytes = 0, payloadNodes = 0) {
  if (state.pendingOperations >= INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_OPERATIONS) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_BUSY", "Repository kernel operation queue is full.", { status: 429 });
  }
  if (
    !Number.isSafeInteger(payloadBytes) ||
    payloadBytes < 0 ||
    payloadBytes > INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_BYTES - state.pendingPayloadBytes
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_BUSY", "Repository kernel pending payload byte cap is full.", {
      status: 429,
    });
  }
  if (
    !Number.isSafeInteger(payloadNodes) ||
    payloadNodes < 0 ||
    payloadNodes > INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_NODES - state.pendingPayloadNodes
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_BUSY", "Repository kernel pending payload node cap is full.", {
      status: 429,
    });
  }
  state.pendingOperations += 1;
  state.pendingPayloadBytes += payloadBytes;
  state.pendingPayloadNodes += payloadNodes;
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
    state.pendingOperations -= 1;
    state.pendingPayloadBytes -= payloadBytes;
    state.pendingPayloadNodes -= payloadNodes;
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository kernel operation promise could not be hardened.");
  }
  void ReflectApply(PromiseThen, caller, [undefined, () => undefined]);
  ReflectApply(ArrayPush, state.operationQueue, [frozenRecord({
    operation,
    resolve: resolveCaller,
    reject: rejectCaller,
    payloadBytes,
    payloadNodes,
  })]);
  if (!state.queueDraining) {
    state.queueDraining = true;
    void drainKernelOperations(state);
  }
  return caller;
}

async function drainKernelOperations(state) {
  while (state.operationQueue.length > 0) {
    const job = ReflectApply(ArrayShift, state.operationQueue, []);
    try {
      job.resolve(await job.operation());
    } catch (error) {
      job.reject(error);
    } finally {
      state.pendingOperations -= 1;
      state.pendingPayloadBytes -= job.payloadBytes;
      state.pendingPayloadNodes -= job.payloadNodes;
    }
  }
  state.queueDraining = false;
}

function sanitizedStorageFacts(error) {
  if (!error || typeof error !== "object" || utilTypes.isProxy(error)) return Object.create(null);
  const errorDetailsDescriptor = Object.getOwnPropertyDescriptor(error, "details");
  if (
    !errorDetailsDescriptor ||
    !Object.prototype.hasOwnProperty.call(errorDetailsDescriptor, "value") ||
    !errorDetailsDescriptor.value ||
    typeof errorDetailsDescriptor.value !== "object" ||
    utilTypes.isProxy(errorDetailsDescriptor.value)
  ) {
    return Object.create(null);
  }
  const safe = Object.create(null);
  for (const key of ["renamed", "directorySynced", "postRenameSyncFailed"]) {
    const descriptor = Object.getOwnPropertyDescriptor(errorDetailsDescriptor.value, key);
    if (
      descriptor &&
      Object.prototype.hasOwnProperty.call(descriptor, "value") &&
      typeof descriptor.value === "boolean"
    ) {
      Object.defineProperty(safe, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: descriptor.value,
      });
    }
  }
  const phaseDescriptor = Object.getOwnPropertyDescriptor(errorDetailsDescriptor.value, "phase");
  if (
    phaseDescriptor &&
    Object.prototype.hasOwnProperty.call(phaseDescriptor, "value") &&
    typeof phaseDescriptor.value === "string" &&
    ReflectApply(ArrayIncludes, SAFE_STORAGE_PHASES, [phaseDescriptor.value])
  ) {
    Object.defineProperty(safe, "storagePhase", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: phaseDescriptor.value,
    });
  }
  return Object.freeze(safe);
}

function safeOperationFacts(phase, facts, error) {
  return frozenRecord({
    phase,
    writeAttempted: facts.writeAttempted === true,
    writeConfirmed: facts.writeConfirmed === true,
    postWriteVerified: facts.postWriteVerified === true,
    operationStarted: facts.workStarted === true,
    operationSettled: facts.workSettled === true,
    operationFailed: facts.workFailed === true,
    commitMayHaveOccurred: facts.commitMayHaveOccurred === true,
    ...(facts.candidateRevision === null ? {} : {
      candidateRevision: facts.candidateRevision,
      candidateIntegrityDigest: facts.candidateIntegrityDigest,
    }),
    ...facts.originalStorageFacts,
    ...sanitizedStorageFacts(error),
  });
}

function safePublicErrorCode(error) {
  if (!error || typeof error !== "object" || utilTypes.isProxy(error)) return "";
  const descriptor = Object.getOwnPropertyDescriptor(error, "publicCode");
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") && typeof descriptor.value === "string"
    ? descriptor.value
    : "";
}

function throwNormalizedKernelError(state, error, phase, facts, operationKind) {
  const code = safePublicErrorCode(error);
  const details = safeOperationFacts(phase, facts, error);
  if (
    (operationKind === "compare-and-swap" && (
      facts.writeConfirmed ||
      facts.commitMayHaveOccurred
    )) ||
    code === "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS"
  ) {
    poisonKernel(state, "Repository commit outcome requires reconciliation.");
    kernelFail(
      "INTEGRATION_REPOSITORY_KERNEL_COMMIT_AMBIGUOUS",
      "Repository compare-and-swap outcome is ambiguous after a write may have crossed its commit boundary.",
      { details }
    );
  }
  if (code === "INTEGRATION_REPOSITORY_KERNEL_CORRUPT") {
    poisonKernel(state, "Repository snapshot validation failed.");
    throw error;
  }
  if (
    code === "INTEGRATION_REPOSITORY_KERNEL_POISONED" ||
    code === "INTEGRATION_REPOSITORY_KERNEL_INVALID" ||
    code === "INTEGRATION_REPOSITORY_KERNEL_FULL" ||
    code === "INTEGRATION_REPOSITORY_KERNEL_CONFLICT" ||
    code === "INTEGRATION_REPOSITORY_KERNEL_TRANSACTION_CONFLICT"
  ) {
    throw error;
  }
  if (code === "INTEGRATION_STORAGE_LOCK_BUSY") {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_BUSY", "Repository kernel global lock is busy.", {
      status: 409,
      details,
    });
  }
  if (
    code === "INTEGRATION_STORAGE_FILE_CORRUPT" ||
    code === "INTEGRATION_STORAGE_LOCK_CORRUPT" ||
    code === "INTEGRATION_STORAGE_CORRUPT"
  ) {
    poisonKernel(state, "Repository storage binding is corrupt.");
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_CORRUPT", "Repository storage binding is corrupt.", { details });
  }
  if (
    code === "INTEGRATION_STORAGE_LOCK_RELEASE_AMBIGUOUS" ||
    code === "INTEGRATION_STORAGE_LOCK_POISONED" ||
    code === "INTEGRATION_STORAGE_POISONED" ||
    code === "INTEGRATION_STORAGE_CLEANUP_FAILED" ||
    code === "INTEGRATION_STORAGE_LOCK_CLEANUP_FAILED"
  ) {
    poisonKernel(state, "Repository storage or lock binding is unavailable.");
  }
  kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository kernel operation failed safely.", { details });
}

function runKernelOperation(state, operationKind, phase, work, payloadBytes = 0, payloadNodes = 0) {
  assertKernelOpen(state);
  const facts = {
    candidateRevision: null,
    candidateIntegrityDigest: "",
    writeAttempted: false,
    writeConfirmed: false,
    postWriteVerified: false,
    workStarted: false,
    workSettled: false,
    workFailed: false,
    commitMayHaveOccurred: false,
    originalStorageFacts: Object.freeze(Object.create(null)),
  };
  return enqueueKernelOperation(state, async () => {
    assertKernelOpen(state);
    try {
      return await state.lock.runExclusive(async () => {
        assertKernelOpen(state);
        facts.workStarted = true;
        try {
          const result = await work(facts);
          facts.workSettled = true;
          return result;
        } catch (error) {
          facts.workSettled = true;
          facts.workFailed = true;
          facts.originalStorageFacts = sanitizedStorageFacts(error);
          facts.commitMayHaveOccurred =
            facts.writeConfirmed ||
            safePublicErrorCode(error) === "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS";
          throw error;
        }
      }, { waitMs: state.expected.lockWaitMs });
    } catch (error) {
      throwNormalizedKernelError(state, error, phase, facts, operationKind);
    }
  }, payloadBytes, payloadNodes);
}

async function writeAndReloadSnapshot(state, candidate, facts) {
  facts.candidateRevision = candidate.snapshot.snapshotRevision;
  facts.candidateIntegrityDigest = candidate.snapshot.integrityDigest;
  facts.writeAttempted = true;
  const receipt = await state.filePrimitives.atomicWriteProtectedJson(
    INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE,
    candidate.snapshot,
    { maxBytes: state.expected.maxSnapshotBytes }
  );
  facts.writeConfirmed = true;
  if (
    receipt?.committed !== true ||
    receipt?.directorySynced !== true ||
    receipt?.bytes !== candidate.bytes ||
    receipt?.digest !== candidate.fileDigest
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_CORRUPT", "Repository atomic write receipt is invalid.");
  }
  const reloaded = await readSnapshotRecord(state);
  if (
    reloaded.persisted !== true ||
    reloaded.bytes !== candidate.bytes ||
    reloaded.fileDigest !== candidate.fileDigest ||
    reloaded.snapshot.snapshotRevision !== candidate.snapshot.snapshotRevision ||
    reloaded.snapshot.integrityDigest !== candidate.snapshot.integrityDigest ||
    canonicalJson(reloaded.snapshot) !== canonicalJson(candidate.snapshot)
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_CORRUPT", "Repository post-write verification failed.");
  }
  facts.postWriteVerified = true;
  return reloaded.snapshot;
}

function loadKernelSnapshot(state) {
  return runKernelOperation(state, "load", "load-snapshot", async () => {
    const record = await readSnapshotRecord(state);
    return record.snapshot;
  });
}

function compareAndSwapKernelSnapshot(state, input) {
  return runKernelOperation(state, "compare-and-swap", "compare-and-swap-snapshot", async (facts) => {
    const current = (await readSnapshotRecord(state)).snapshot;
    if (exactReplay(current, input)) return casResult("replayed", current);
    if (
      current.snapshotRevision !== input.expectedSnapshotRevision ||
      current.integrityDigest !== input.expectedIntegrityDigest
    ) {
      kernelFail(
        "INTEGRATION_REPOSITORY_KERNEL_CONFLICT",
        "Repository snapshot revision or integrity digest no longer matches.",
        { status: 409 }
      );
    }
    if (current.snapshotRevision === Number.MAX_SAFE_INTEGER) {
      kernelFail("INTEGRATION_REPOSITORY_KERNEL_FULL", "Repository snapshot revision space is exhausted.", {
        status: 409,
      });
    }
    const candidate = makeSnapshotCandidate(state, current, input);
    return casResult("committed", await writeAndReloadSnapshot(state, candidate, facts));
  }, input.payloadCanonicalBytes, input.payloadCanonicalNodes);
}

function validateExactNullPrototypeSurface(value, keys, label) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || !Object.isFrozen(value)) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", `${label} must be a frozen lexical object.`);
  }
  if (Object.getPrototypeOf(value) !== null) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", `${label} prototype is invalid.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ReflectApply(ArraySome, ownKeys, [
      (key) => typeof key !== "string" || !ReflectApply(ArrayIncludes, keys, [key]),
    ])
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", `${label} fields are invalid.`);
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      descriptor.writable ||
      descriptor.configurable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", `${label} must contain exact immutable data fields.`);
    }
  }
  return value;
}

function digestWithoutField(value, field) {
  const unsigned = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (key !== field) unsigned[key] = value[key];
  }
  return contractDigest(unsigned);
}

function validateKernelAttestation(proof) {
  validateExactNullPrototypeSurface(proof, ATTESTATION_KEYS, "repository kernel attestation");
  if (
    proof.schemaVersion !== INTEGRATION_RETAINED_REPOSITORY_KERNEL_ATTESTATION_VERSION ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.preEnableStorageKernel !== true ||
    proof.runtimeCapabilityEnabled !== false ||
    proof.runtimeWiringIncluded !== false ||
    proof.runtimeRepositorySurface !== false ||
    proof.repositoryDomainValidation !== false ||
    proof.repositoryTransitionsIncluded !== false ||
    proof.artifactSemanticsIncluded !== false ||
    proof.recoverySemanticsIncluded !== false ||
    proof.singleCanonicalSnapshot !== true ||
    proof.boundedSnapshot !== true ||
    proof.compareAndSwap !== true ||
    proof.revisionExactlyOne !== true ||
    proof.globalStoreLock !== true ||
    proof.postWriteReloadVerification !== true ||
    proof.storageLifecycleOwned !== false ||
    proof.snapshotFileName !== INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE ||
    proof.limitations !== INTEGRATION_RETAINED_REPOSITORY_KERNEL_LIMITATIONS ||
    proof.maxJsonDepth !== INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH ||
    proof.maxJsonNodes !== INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES ||
    proof.maxPendingOperations !== INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_OPERATIONS ||
    proof.maxPendingPayloadBytes !== INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_BYTES ||
    proof.maxPendingPayloadNodes !== INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_NODES ||
    !Number.isSafeInteger(proof.maxTransientNormalizationBytes) ||
    proof.maxTransientNormalizationBytes !== proof.maxSnapshotBytes ||
    proof.maxTransientNormalizationNodes !== INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES ||
    !Number.isSafeInteger(proof.maxSnapshotBytes) ||
    proof.maxSnapshotBytes < MIN_SNAPSHOT_BYTES ||
    proof.maxSnapshotBytes > MAX_SNAPSHOT_BYTES ||
    !Number.isSafeInteger(proof.lockWaitMs) ||
    proof.lockWaitMs < 0 ||
    proof.lockWaitMs > MAX_LOCK_WAIT_MS
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository kernel attestation is unavailable.");
  }
  for (const [value, label] of [
    [proof.lockFileNameDigest, "repository kernel lock file name digest"],
    [proof.pointerDigest, "repository kernel pointer digest"],
    [proof.admissionBindingDigest, "repository kernel admission binding digest"],
    [proof.namespaceSealBindingDigest, "repository kernel namespace seal binding digest"],
    [proof.digest, "repository kernel attestation digest"],
  ]) {
    assertDigest(value, label, "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE");
  }
  if (proof.digest !== digestWithoutField(proof, "digest")) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository kernel attestation digest is invalid.");
  }
  return proof;
}

function buildKernelAttestation(state) {
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_REPOSITORY_KERNEL_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    preEnableStorageKernel: true,
    runtimeCapabilityEnabled: false,
    runtimeWiringIncluded: false,
    runtimeRepositorySurface: false,
    repositoryDomainValidation: false,
    repositoryTransitionsIncluded: false,
    artifactSemanticsIncluded: false,
    recoverySemanticsIncluded: false,
    singleCanonicalSnapshot: true,
    boundedSnapshot: true,
    compareAndSwap: true,
    revisionExactlyOne: true,
    globalStoreLock: true,
    postWriteReloadVerification: true,
    storageLifecycleOwned: false,
    snapshotFileName: INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE,
    lockFileNameDigest: contractDigest({
      domain: "aginti-retained-integration-repository-lock-name-v1",
      lockFileName: INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
    }),
    pointerDigest: state.pointerDigest,
    admissionBindingDigest: state.admissionBindingDigest,
    namespaceSealBindingDigest: state.namespaceSealBindingDigest,
    maxSnapshotBytes: state.expected.maxSnapshotBytes,
    maxJsonDepth: INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH,
    maxJsonNodes: INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES,
    maxPendingOperations: INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_OPERATIONS,
    maxPendingPayloadBytes: INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_BYTES,
    maxPendingPayloadNodes: INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_NODES,
    maxTransientNormalizationBytes: state.expected.maxSnapshotBytes,
    maxTransientNormalizationNodes: INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES,
    lockWaitMs: state.expected.lockWaitMs,
    limitations: INTEGRATION_RETAINED_REPOSITORY_KERNEL_LIMITATIONS,
  });
  return validateKernelAttestation(frozenRecord({ ...unsigned, digest: contractDigest(unsigned) }));
}

function validateKernelSurface(surface, state) {
  validateExactNullPrototypeSurface(surface, SURFACE_KEYS, "repository kernel surface");
  if (
    surface.schemaVersion !== INTEGRATION_RETAINED_REPOSITORY_KERNEL_VERSION ||
    surface.attestation !== state.attestation ||
    typeof surface.loadSnapshot !== "function" ||
    typeof surface.compareAndSwapSnapshot !== "function" ||
    typeof surface.isClosed !== "function"
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository kernel surface is unavailable.");
  }
  validateKernelAttestation(surface.attestation);
  return surface;
}

function createKernelState(filePrimitives, lock, expectedInput) {
  const expected = normalizeExpected(expectedInput);
  try {
    assertRetainedProtectedFilePrimitives(filePrimitives, directoryExpected(expected));
    assertRetainedRegularFileLock(lock, lockExpected(expected));
  } catch {
    kernelFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Repository kernel retained storage brands do not match their expected binding."
    );
  }
  if (claimedRepositoryKernelLocks.has(lock)) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository kernel lock surface is already claimed.");
  }
  if (filePrimitives.isClosed() || lock.isClosed()) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository kernel retained storage binding is closed.");
  }
  return {
    filePrimitives,
    lock,
    expected,
    pointerDigest: logicalPointerDigest(expected),
    admissionBindingDigest: admissionBindingDigest(expected),
    namespaceSealBindingDigest: namespaceSealBindingDigest(
      expected,
      retainedRegularFileLockObjectIdentityDigest(lock, lockExpected(expected))
    ),
    operationQueue: [],
    queueDraining: false,
    pendingOperations: 0,
    pendingPayloadBytes: 0,
    pendingPayloadNodes: 0,
    observedRevision: null,
    observedDigest: "",
    poisoned: false,
    poisonReason: "",
    attestation: null,
    surface: null,
  };
}

export function createRetainedIntegrationRuntimeRepositoryKernel(filePrimitives, lock, expectedInput) {
  const state = createKernelState(filePrimitives, lock, expectedInput);
  state.attestation = buildKernelAttestation(state);
  state.surface = validateKernelSurface(Object.freeze(Object.assign(Object.create(null), {
    schemaVersion: INTEGRATION_RETAINED_REPOSITORY_KERNEL_VERSION,
    attestation: state.attestation,
    loadSnapshot() {
      assertKernelOpen(state);
      if (arguments.length !== 0) {
        kernelFail("INTEGRATION_REPOSITORY_KERNEL_INVALID", "Repository kernel loadSnapshot takes no arguments.", {
          status: 400,
        });
      }
      return loadKernelSnapshot(state);
    },
    compareAndSwapSnapshot(input) {
      assertKernelOpen(state);
      if (arguments.length !== 1) {
        kernelFail(
          "INTEGRATION_REPOSITORY_KERNEL_INVALID",
          "Repository kernel compareAndSwapSnapshot requires one exact input.",
          { status: 400 }
        );
      }
      if (state.pendingOperations >= INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_OPERATIONS) {
        kernelFail("INTEGRATION_REPOSITORY_KERNEL_BUSY", "Repository kernel operation queue is full.", { status: 429 });
      }
      return compareAndSwapKernelSnapshot(state, normalizeCasInput(input, state.expected.maxSnapshotBytes));
    },
    isClosed() {
      return state.filePrimitives.isClosed() || state.lock.isClosed();
    },
  })), state);
  repositoryKernelBrand.set(state.surface, state);
  claimedRepositoryKernelLocks.add(state.lock);
  return state.surface;
}

export function assertRetainedIntegrationRuntimeRepositoryKernel(value, expectedInput) {
  const expected = normalizeExpected(expectedInput);
  const state = value && typeof value === "object" && !utilTypes.isProxy(value)
    ? repositoryKernelBrand.get(value)
    : null;
  if (!state || value !== state.surface) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository kernel lexical brand is invalid.");
  }
  validateKernelSurface(value, state);
  if (
    logicalPointerDigest(expected) !== state.pointerDigest ||
    admissionBindingDigest(expected) !== state.admissionBindingDigest
  ) {
    kernelFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Repository kernel expected binding is invalid.");
  }
  return value;
}

export function retainedIntegrationRuntimeRepositoryKernelSealBindingProof(value, expectedInput) {
  assertRetainedIntegrationRuntimeRepositoryKernel(value, expectedInput);
  const state = repositoryKernelBrand.get(value);
  return frozenRecord({
    pointerDigest: state.pointerDigest,
    namespaceSealBindingDigest: state.namespaceSealBindingDigest,
  });
}
