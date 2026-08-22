import path from "node:path";
import { types as utilTypes } from "node:util";
import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import { authorityFail } from "./integration-authority-error.js";
import { createPublicIntegrationEvent } from "./integration-events.js";
import {
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_ARTIFACT_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_DOMAIN_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_ARTIFACTS,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MUTATION_RECEIPTS,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_OUTBOX_EVENTS,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RUNS,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_THREADS,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MUTATION_RECEIPT_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RUN_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_THREAD_VERSION,
  assertRetainedIntegrationNativeSessionRepositoryState,
} from "./integration-retained-native-session-repository-state.js";
import { validateNativeRuntimeRootsAttestation } from "./integration-native-runtime-roots.js";
import { redactSensitiveText } from "./redaction.js";
import {
  contractDigest,
} from "./integration-policy.js";
import {
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS,
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY,
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION,
  INTEGRATION_RUNTIME_REPOSITORY_METHODS,
  INTEGRATION_RUNTIME_REPOSITORY_SURFACE_KEYS,
  assertIntegrationRuntimeRepositorySurface,
} from "./integration-runtime-repository-contract.js";

const ArrayIsArray = Array.isArray;
const ArrayPrototype = Array.prototype;
const ArrayPrototypeFind = ArrayPrototype.find;
const ArrayPrototypePush = ArrayPrototype.push;
const ArrayPrototypeSome = ArrayPrototype.some;
const ArrayPrototypeSort = ArrayPrototype.sort;
const DateParse = Date.parse;
const DatePrototypeToISOString = Date.prototype.toISOString;
const FunctionPrototypeCall = Function.prototype.call;
const NativeArray = Array;
const NativeBoolean = Boolean;
const NativeDate = Date;
const NativeMap = Map;
const NativePromise = Promise;
const NativeSet = Set;
const NativeWeakMap = WeakMap;
const NativeWeakSet = WeakSet;
const NumberMaxSafeInteger = Number.MAX_SAFE_INTEGER;
const NumberNaN = Number.NaN;
const NumberIsFinite = Number.isFinite;
const NumberIsSafeInteger = Number.isSafeInteger;
const ObjectAssign = Object.assign;
const ObjectCreate = Object.create;
const ObjectDefineProperty = Object.defineProperty;
const ObjectFreeze = Object.freeze;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectIs = Object.is;
const ObjectPrototype = Object.prototype;
const ObjectPrototypeHasOwnProperty = ObjectPrototype.hasOwnProperty;
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const RegExpPrototypeTest = RegExp.prototype.test;
const MapPrototypeGet = Map.prototype.get;
const MapPrototypeSet = Map.prototype.set;
const PathResolve = path.resolve;
const PromisePrototypeThen = Promise.prototype.then;
const SetPrototypeAdd = Set.prototype.add;
const SetPrototypeHas = Set.prototype.has;
const StringConstructor = String;
const StringPrototypeIncludes = String.prototype.includes;
const StringPrototypeSlice = String.prototype.slice;
const StringPrototypeTrim = String.prototype.trim;
const WeakMapPrototypeGet = WeakMap.prototype.get;
const WeakMapPrototypeHas = WeakMap.prototype.has;
const WeakMapPrototypeSet = WeakMap.prototype.set;
const WeakSetPrototypeAdd = WeakSet.prototype.add;
const WeakSetPrototypeDelete = WeakSet.prototype.delete;
const WeakSetPrototypeHas = WeakSet.prototype.has;
const SymbolSpecies = Symbol.species;
const NativePromiseSpeciesDescriptor = ObjectGetOwnPropertyDescriptor(NativePromise, SymbolSpecies);
const NativePromiseSpeciesGetter = NativePromiseSpeciesDescriptor?.get;
const NativePromiseSpeciesSetter = NativePromiseSpeciesDescriptor?.set;

function arrayConcat(left, right) {
  const result = new NativeArray(left.length + right.length);
  for (let index = 0; index < left.length; index += 1) result[index] = left[index];
  for (let index = 0; index < right.length; index += 1) result[left.length + index] = right[index];
  return result;
}

function arrayFilter(value, callback) {
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (callback(value[index], index, value)) arrayPush(result, value[index]);
  }
  return result;
}

function arrayFind(value, callback) {
  return ReflectApply(ArrayPrototypeFind, value, [callback]);
}

function arrayMap(value, callback) {
  const result = new NativeArray(value.length);
  for (let index = 0; index < value.length; index += 1) {
    result[index] = callback(value[index], index, value);
  }
  return result;
}

function arrayPush(value, item) {
  return ReflectApply(ArrayPrototypePush, value, [item]);
}

function arraySlice(value, start, end) {
  const from = start === undefined ? 0 : start;
  const until = end === undefined || end > value.length ? value.length : end;
  const size = until > from ? until - from : 0;
  const result = new NativeArray(size);
  for (let index = 0; index < size; index += 1) result[index] = value[from + index];
  return result;
}

function arraySome(value, callback) {
  return ReflectApply(ArrayPrototypeSome, value, [callback]);
}

function arraySort(value, callback) {
  return ReflectApply(ArrayPrototypeSort, value, [callback]);
}

function regexTest(pattern, value) {
  return ReflectApply(RegExpPrototypeTest, pattern, [value]);
}

function mapGet(map, key) {
  return ReflectApply(MapPrototypeGet, map, [key]);
}

function mapSet(map, key, value) {
  ReflectApply(MapPrototypeSet, map, [key, value]);
}

function mapFromRecords(records, keyForRecord) {
  const result = new NativeMap();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    mapSet(result, keyForRecord(record), record);
  }
  return result;
}

function setAdd(set, value) {
  ReflectApply(SetPrototypeAdd, set, [value]);
}

function setFromArray(values) {
  const result = new NativeSet();
  for (let index = 0; index < values.length; index += 1) setAdd(result, values[index]);
  return result;
}

function setHas(set, value) {
  return ReflectApply(SetPrototypeHas, set, [value]);
}

function weakMapGet(map, key) {
  return ReflectApply(WeakMapPrototypeGet, map, [key]);
}

function weakMapHas(map, key) {
  return ReflectApply(WeakMapPrototypeHas, map, [key]);
}

function weakMapSet(map, key, value) {
  ReflectApply(WeakMapPrototypeSet, map, [key, value]);
}

function weakSetAdd(set, value) {
  ReflectApply(WeakSetPrototypeAdd, set, [value]);
}

function weakSetDelete(set, value) {
  ReflectApply(WeakSetPrototypeDelete, set, [value]);
}

function weakSetHas(set, value) {
  return ReflectApply(WeakSetPrototypeHas, set, [value]);
}

export const INTEGRATION_RETAINED_RUNTIME_REPOSITORY_SURFACE_VERSION =
  "aginti-retained-runtime-repository-surface-v1";
export const INTEGRATION_RETAINED_RUNTIME_REPOSITORY_MUTATION_VERSION =
  "aginti-retained-runtime-repository-mutation-v1";
export const INTEGRATION_RETAINED_RUNTIME_REPOSITORY_RECONCILIATION_VERSION =
  "aginti-dispatch-reconciliation-v1";
export const INTEGRATION_RETAINED_RUNTIME_REPOSITORY_ARTIFACT_IDENTITY_VERSION =
  "aginti-owned-artifact-identity-v1";

export const INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS = ObjectFreeze(
  ObjectAssign(ObjectCreate(null), {
    runtimeCapabilityEnabled: false,
    serverWiringIncluded: false,
    storageLifecycleOwned: false,
    callerMustCloseOwningAuthorities: true,
    retainedDescriptorStorageAuthority: true,
    runtimeRootsSessionsDirCrossBound: true,
    runtimeRootsDescriptorProvenByRepository: false,
    nativeExecutorRetainedSessionStoreWiring: false,
    runtimeRepositorySurface: true,
    runtimeRepositoryMethodSurface: true,
    exactPayloadSchemas: true,
    exactResultSchemas: true,
    repositoryTransitionsIncluded: true,
    durableThreadSessionMapping: true,
    optimisticCas: true,
    longLivedMutationReplayWithinRetainedCapacity: true,
    unboundedMutationReplay: false,
    mutationReceiptPruning: false,
    tombstonePruning: false,
    outboxPruning: false,
    artifactPruning: false,
    snapshotByteCapInherited: true,
    capacityExhaustionFailsClosed: true,
    nativeStartReplayPreventsRedispatch: true,
    preAuthorizationStartupAbort: true,
    authorizedStartupRecoveryHold: true,
    startRecoveryHoldTerminalizationThroughRepositoryMethod: false,
    resumeRecoveryHoldTerminalizationThroughRepositoryMethod: false,
    recoveryHoldResolutionCallerWiring: false,
    reconciliationWallClockAdmissionCut: true,
    reconciliationSnapshotFence: false,
    noChangeReconciliationReadOnly: true,
    noChangeReconciliationDurableReplay: false,
    terminalOutboxAtomicWithRun: true,
    artifactStagingCasAtomic: true,
    artifactPublicationCasAtomic: true,
    artifactCompletionAtomic: false,
    artifactRuntimeProducerWiring: false,
    artifactCallerIdCanonicalizedToOwnedIdentity: true,
    artifactProducerMustUseStagedResultId: true,
    artifactOwnerTombstoneVisibilityFiltering: true,
    eventLedgerCrossStoreAtomicity: false,
    apiIdempotencyCrossStoreAtomicity: false,
    sameKernelHostRequired: true,
    singleRuntimeProcessRequired: true,
    rollingRestartOverlapSafe: false,
    sharedProcessLeaseOrFence: false,
    sameProcessPrototypeIntegrityRequired: true,
    endToEndPrototypePoisoningIsolation: false,
    trustedDependencyIntrinsicsRequired: true,
    dependencyWidePrototypePoisonResistance: false,
    crossHostExclusion: false,
    localFilesystemRequired: true,
    networkFilesystemSafety: false,
    fencingTokens: false,
  })
);

const ZERO_DIGEST = "0".repeat(64);
const COMPLETION_OUTBOX_METADATA_VERSION = "aginti-completion-outbox-bundle-v1";
const NATIVE_START_AUTHORIZATION_VERSION = "aginti-native-start-authorization-v1";
const PRE_LAUNCH_ABORT_ATTEMPT_VERSION = "aginti-pre-launch-abort-attempt-v3";
const PRE_LAUNCH_ABORT_RESPONSE_VERSION = "aginti-pre-launch-abort-response-v1";
const NATIVE_START_RECOVERY_STATE_VERSION = "aginti-native-start-recovery-v1";
const RECONCILIATION_RESPONSE_VERSION = "aginti-dispatch-reconciliation-v1";
const REPOSITORY_INPUT_DIGEST_VERSION = "aginti-retained-runtime-repository-input-v1";
const REPOSITORY_SNAPSHOT_HASH_VERSION = "aginti-retained-runtime-repository-run-snapshot-v1";
const STARTUP_ABORT_VERSION = "aginti-retained-runtime-repository-startup-abort-v1";
const TERMINAL_STATUSES = new NativeSet(["completed", "failed", "cancelled"]);
const ACTIVE_STATUSES = new NativeSet(["starting", "running"]);
const PUBLIC_ERROR_CODES = new NativeSet([
  "AGINTI_RUNTIME_ERROR",
  "CANCELLED",
  "PROVIDER_PREFLIGHT_FAILED",
  "MODEL_TIMEOUT",
  "MAX_STEPS",
  "SESSION_RUNTIME_TAKEOVER_BLOCKED",
]);
const CAS_RETRY_CODES = new NativeSet([
  "INTEGRATION_REPOSITORY_KERNEL_CONFLICT",
  "INTEGRATION_REPOSITORY_KERNEL_TRANSACTION_CONFLICT",
]);
const MAX_CANONICAL_NODES = 250_000;
const MAX_CANONICAL_DEPTH = 64;
const DEFAULT_MAX_CAS_RETRIES = 32;
const PRIVATE_RUNTIME_PATTERN =
  /(?:^|[\s("'`])(?:\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/|\b)|[A-Za-z]:\\)|(?:api[_-]?key|token|secret|password)\s*[:=]/iu;
const PRESENTATIONAL_UNSAFE_PATTERN = /[<>]|(?:javascript\s*:|(?:https?|data|file)\s*:\/\/)/iu;

const FACTORY_KEYS = ObjectFreeze([
  "repositoryState",
  "repositoryStateExpected",
  "runtimeRoots",
  "now",
  "maxCasRetries",
]);
const CREATE_THREAD_KEYS = ObjectFreeze([
  "threadId", "nativeSessionId", "principalId", "browserSessionId", "browserSessionPolicy",
  "title", "createdAt", "policyFingerprint",
]);
const THREAD_LOOKUP_KEYS = ObjectFreeze(["threadId", "principalId", "browserSessionId"]);
const LIST_THREADS_KEYS = ObjectFreeze(["principalId", "browserSessionId", "limit", "before"]);
const UPDATE_THREAD_KEYS = ObjectFreeze([
  "threadId", "principalId", "browserSessionId", "expectedRevision", "title", "updatedAt",
]);
const DELETE_THREAD_KEYS = ObjectFreeze([
  "threadId", "principalId", "browserSessionId", "expectedRevision",
]);
const CREATE_RUN_KEYS = ObjectFreeze([
  "runId", "threadId", "nativeSessionId", "previousRunId", "principalId", "browserSessionId",
  "browserSessionPolicy", "expectedThreadRevision", "expectedNativeRuntimeRevision", "input",
  "createdAt", "status",
]);
const DISPATCH_RUN_KEYS = ObjectFreeze([
  "runId", "threadId", "principalId", "browserSessionId", "expectedRevision",
  "expectedNativeRuntimeRevision", "dispatchLeaseId", "dispatchOutbox", "processOwner", "dispatchedAt",
]);
const RUN_LOOKUP_KEYS = ObjectFreeze(["runId", "principalId", "browserSessionId"]);
const CANCEL_RUN_KEYS = ObjectFreeze([
  "runId", "threadId", "principalId", "browserSessionId", "expectedRevision", "processOwner",
  "cancelRequestedAt",
]);
const FINISH_RUN_KEYS = ObjectFreeze([
  "runId", "threadId", "nativeSessionId", "principalId", "browserSessionId", "expectedRevision",
  "expectedNativeRuntimeRevision", "completedNativeRuntimeRevision", "status", "output", "error",
  "completedAt", "processOwner", "expectedCursor", "outputEvent", "terminalEvent", "resultDigest",
]);
const COMPLETION_BUNDLE_KEYS = ObjectFreeze([
  "principalId", "browserSessionId", "threadId", "runId",
]);
const OUTBOX_SCOPE_KEYS = ObjectFreeze(["principalId", "browserSessionId"]);
const OUTBOX_DELIVERY_KEYS = ObjectFreeze([
  "outboxId", "principalId", "browserSessionId", "threadId", "runId", "eventSeq", "eventHash",
  "eventDigest",
]);
const LIST_ARTIFACT_KEYS = ObjectFreeze([
  "principalId", "browserSessionId", "threadId", "runId", "publishedOnly",
]);
const GET_ARTIFACT_KEYS = ObjectFreeze([
  "principalId", "browserSessionId", "artifactId", "publishedOnly",
]);
const STAGE_ARTIFACT_REQUIRED_KEYS = ObjectFreeze([
  "principalId", "browserSessionId", "threadId", "runId", "artifact",
]);
const STAGE_ARTIFACT_OPTIONAL_KEYS = ObjectFreeze(["stagedAt"]);
const PUBLISH_ARTIFACT_KEYS = ObjectFreeze([
  "principalId", "browserSessionId", "threadId", "runId", "artifactId", "expectedRevision",
  "publishedAt",
]);
const AUTHORIZATION_WRAPPER_KEYS = ObjectFreeze(["authorization"]);
const ABORT_WRAPPER_KEYS = ObjectFreeze(["attempt"]);
const RECONCILIATION_KEYS = ObjectFreeze([
  "schemaVersion", "principalId", "browserSessionId", "browserSessionPolicy", "processOwner",
  "liveRunClaims", "reconciledAt", "requestDigest",
]);

const repositoryBrand = new NativeWeakMap();

function repositoryFail(code, message, status = 503) {
  authorityFail(code, message, { status, details: ObjectFreeze(ObjectCreate(null)) });
}

function conflict(code, message) {
  repositoryFail(code, message, 409);
}

function hasOwn(value, key) {
  return ReflectApply(FunctionPrototypeCall, ObjectPrototypeHasOwnProperty, [value, key]);
}

function frozenRecord(value) {
  return ObjectFreeze(ObjectAssign(ObjectCreate(null), value));
}

function isPromiseValue(value) {
  return !!value && typeof value === "object" && !utilTypes.isProxy(value) && utilTypes.isPromise(value);
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
    return speciesDescriptor.value === undefined || speciesDescriptor.value === null ||
      speciesDescriptor.value === NativePromise;
  }
  return NativePromiseSpeciesGetter !== undefined &&
    speciesDescriptor.get === NativePromiseSpeciesGetter &&
    speciesDescriptor.set === NativePromiseSpeciesSetter;
}

function observePromiseRejectionIfSafe(value) {
  if (!isPromiseValue(value)) return false;
  if (promiseCanBeSafelyObserved(value)) {
    ReflectApply(PromisePrototypeThen, value, [undefined, () => undefined]);
  }
  return true;
}

function cloneCanonical(value, label, state = { nodes: 0, active: new NativeWeakSet() }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} exceeds structural bounds.`, 400);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!NumberIsFinite(value) || ObjectIs(value, -0)) {
      repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} contains a non-canonical number.`, 400);
    }
    return value;
  }
  if (value && typeof value === "object" && utilTypes.isProxy(value)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} must contain only trap-safe JSON data.`, 400);
  }
  if (observePromiseRejectionIfSafe(value)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} must contain only synchronous JSON data.`, 400);
  }
  if (!value || typeof value !== "object") {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} must contain only synchronous JSON data.`, 400);
  }
  if (weakSetHas(state.active, value)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} must not contain cycles.`, 400);
  }
  weakSetAdd(state.active, value);
  try {
    if (ArrayIsArray(value)) {
      if (ObjectGetPrototypeOf(value) !== ArrayPrototype) {
        repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} array prototype is invalid.`, 400);
      }
      const keys = arrayFilter(ReflectOwnKeys(value), (key) => key !== "length");
      if (keys.length !== value.length) {
        repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} array must be dense data.`, 400);
      }
      const result = new NativeArray(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = ObjectGetOwnPropertyDescriptor(value, StringConstructor(index));
        if (!descriptor?.enumerable || !hasOwn(descriptor, "value")) {
          repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} array entries must be data.`, 400);
        }
        result[index] = cloneCanonical(descriptor.value, `${label}[${index}]`, state, depth + 1);
      }
      return ObjectFreeze(result);
    }
    const prototype = ObjectGetPrototypeOf(value);
    if (prototype !== ObjectPrototype && prototype !== null) {
      repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} object prototype is invalid.`, 400);
    }
    const result = ObjectCreate(null);
    const ownKeys = ReflectOwnKeys(value);
    for (let keyIndex = 0; keyIndex < ownKeys.length; keyIndex += 1) {
      const key = ownKeys[keyIndex];
      if (typeof key !== "string") {
        repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} must not contain symbols.`, 400);
      }
      const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !hasOwn(descriptor, "value")) {
        repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label}.${key} must be a data field.`, 400);
      }
      ObjectDefineProperty(result, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: cloneCanonical(descriptor.value, `${label}.${key}`, state, depth + 1),
      });
    }
    return ObjectFreeze(result);
  } finally {
    weakSetDelete(state.active, value);
  }
}

function exactPayload(value, requiredKeys, optionalKeys = [], label = "repository payload") {
  const clone = cloneCanonical(value, label);
  if (!clone || typeof clone !== "object" || ArrayIsArray(clone)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} must be an exact object.`, 400);
  }
  const allowed = setFromArray(arrayConcat(requiredKeys, optionalKeys));
  const keys = ReflectOwnKeys(clone);
  if (arraySome(keys, (key) => typeof key !== "string" || !setHas(allowed, key))) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} contains unsupported fields.`, 400);
  }
  for (let keyIndex = 0; keyIndex < requiredKeys.length; keyIndex += 1) {
    const key = requiredKeys[keyIndex];
    if (!hasOwn(clone, key)) repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label}.${key} is required.`, 400);
  }
  return clone;
}

function assertDigest(value, label, { allowZero = true } = {}) {
  if (typeof value !== "string" || !regexTest(/^[a-f0-9]{64}$/u, value) || (!allowZero && value === ZERO_DIGEST)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function assertCanonicalIso(value, label) {
  const milliseconds = typeof value === "string" ? ReflectApply(DateParse, NativeDate, [value]) : NumberNaN;
  if (
    !NumberIsFinite(milliseconds) ||
    ReflectApply(DatePrototypeToISOString, new NativeDate(milliseconds), []) !== value
  ) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} must be a canonical UTC timestamp.`, 400);
  }
  return value;
}

function assertInteger(value, label, minimum = 0, maximum = NumberMaxSafeInteger) {
  if (!NumberIsSafeInteger(value) || value < minimum || value > maximum) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function assertSafeIdentifier(value, label, { minimum = 1, maximum = 128 } = {}) {
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum ||
    !regexTest(/^[A-Za-z0-9._:-]+$/u, value) || ReflectApply(StringPrototypeIncludes, value, [".."])
  ) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function validateIntegrationThreadId(value) {
  if (typeof value !== "string" || !regexTest(/^thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, value)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "threadId is invalid.", 400);
  }
  return value;
}

function validateIntegrationRunId(value) {
  if (typeof value !== "string" || !regexTest(/^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, value)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "runId is invalid.", 400);
  }
  return value;
}

function validateIntegrationArtifactId(value) {
  if (typeof value !== "string" || !regexTest(/^art_[A-Za-z0-9_-]{32,86}$/u, value)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "artifactId is invalid.", 400);
  }
  return value;
}

function assertPublicText(value, label, maximum, {
  minimum = 0,
  trim = false,
  presentational = false,
} = {}) {
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum ||
    regexTest(/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u, value) ||
    redactSensitiveText(value) !== value || regexTest(PRIVATE_RUNTIME_PATTERN, value) ||
    (presentational && regexTest(PRESENTATIONAL_UNSAFE_PATTERN, value)) ||
    (trim && ReflectApply(StringPrototypeTrim, value, []) !== value)
  ) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} is not bounded public text.`, 400);
  }
  return value;
}

function assertInputText(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 32_000 ||
    !ReflectApply(StringPrototypeTrim, value, []) ||
    regexTest(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u, value)
  ) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Run input text is invalid.", 400);
  }
  return value;
}

function assertNativeSessionId(value) {
  if (
    typeof value !== "string" ||
    !regexTest(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u, value) ||
    ReflectApply(StringPrototypeIncludes, value, [".."])
  ) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "nativeSessionId is invalid.", 400);
  }
  return value;
}

function assertProcessOwner(value, label = "process owner") {
  const owner = exactPayload(
    value,
    ["schemaVersion", "pid", "token", "processIdentity", "acquiredAt", "heartbeatAt"],
    [],
    label
  );
  const identity = exactPayload(
    owner.processIdentity,
    ["schemaVersion", "bootId", "startTimeTicks"],
    [],
    `${label} identity`
  );
  if (
    owner.schemaVersion !== "aginti-process-owner-v1" ||
    !NumberIsSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    typeof owner.token !== "string" ||
    !regexTest(/^[a-f0-9]{32}$/u, owner.token) ||
    identity.schemaVersion !== "aginti-process-identity-v1" ||
    typeof identity.bootId !== "string" ||
    !regexTest(/^[a-f0-9-]{16,80}$/u, identity.bootId) ||
    typeof identity.startTimeTicks !== "string" ||
    !regexTest(/^[0-9]{1,32}$/u, identity.startTimeTicks)
  ) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} is invalid.`, 400);
  }
  assertCanonicalIso(owner.acquiredAt, `${label} acquiredAt`);
  assertCanonicalIso(owner.heartbeatAt, `${label} heartbeatAt`);
  if (owner.heartbeatAt < owner.acquiredAt) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", `${label} timestamps are invalid.`, 400);
  }
  return owner;
}

function assertPrincipalId(value) {
  if (typeof value !== "string" || !regexTest(/^[A-Za-z0-9._~-]{16,128}$/u, value)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "principalId is invalid.", 400);
  }
  return value;
}

function assertBrowserSessionId(value) {
  if (typeof value !== "string" || !regexTest(/^[a-f0-9]{64}$/u, value)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "browserSessionId is invalid.", 400);
  }
  return value;
}

function assertBrowserPolicy(value) {
  if (value !== "same-browser-session") {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "browserSessionPolicy is invalid.", 400);
  }
  return value;
}

function scopeFor(payload) {
  return frozenRecord({
    principalId: assertPrincipalId(payload.principalId),
    browserSessionId: assertBrowserSessionId(payload.browserSessionId),
    browserSessionPolicy: hasOwn(payload, "browserSessionPolicy")
      ? assertBrowserPolicy(payload.browserSessionPolicy)
      : "same-browser-session",
  });
}

function sameScope(record, scope) {
  return record.principalId === scope.principalId &&
    record.browserSessionId === scope.browserSessionId &&
    record.browserSessionPolicy === scope.browserSessionPolicy;
}

function cloneRecord(record) {
  return record === null ? null : cloneCanonical(record, "repository record");
}

function compareText(leftInput, rightInput) {
  const left = StringConstructor(leftInput);
  const right = StringConstructor(rightInput);
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedById(records, key = "id") {
  return ObjectFreeze(arraySort(arraySlice(records, 0), (left, right) => compareText(left[key], right[key])));
}

function findThread(state, threadId, scope, { includeTombstone = false } = {}) {
  const thread = arrayFind(state.threads, (item) => item.id === threadId);
  if (!thread || !sameScope(thread, scope) || (!includeTombstone && thread.tombstone)) return null;
  return thread;
}

function findRun(state, runId, scope, { includeHidden = false } = {}) {
  const run = arrayFind(state.runs, (item) => item.id === runId);
  if (!run || !sameScope(run, scope) || (!includeHidden && (run.hidden || run.tombstone))) return null;
  return run;
}

function replaceById(records, replacement, key = "id") {
  return sortedById(arrayMap(records, (record) => record[key] === replacement[key] ? replacement : record), key);
}

function domainWith(state, generation, changes = {}) {
  return frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_DOMAIN_VERSION,
    owner: "aginti",
    authority: "aginti",
    repositoryPointerDigest: state.repositoryPointerDigest,
    sessionStateNamespaceDigest: state.sessionStateNamespaceDigest,
    generation,
    threads: changes.threads || state.threads,
    runs: changes.runs || state.runs,
    outboxEvents: changes.outboxEvents || state.outboxEvents,
    artifacts: changes.artifacts || state.artifacts,
    mutationReceipts: changes.mutationReceipts || state.mutationReceipts,
  });
}

function requestDigest(operation, payload) {
  return contractDigest({
    schemaVersion: INTEGRATION_RETAINED_RUNTIME_REPOSITORY_MUTATION_VERSION,
    operation,
    payload,
  });
}

function mutationIdFor(operation, digest) {
  return `repository.${operation}.${digest}`;
}

function receiptFor({ mutationId, operation, scope, digest, snapshot, result, committedAt }) {
  return frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MUTATION_RECEIPT_VERSION,
    mutationId,
    operation,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: scope.browserSessionPolicy,
    requestDigest: digest,
    baseSnapshotRevision: snapshot.snapshotRevision,
    baseIntegrityDigest: snapshot.integrityDigest,
    resultSnapshotRevision: snapshot.snapshotRevision + 1,
    resultDigest: contractDigest(result),
    result,
    committedAt,
  });
}

function existingReceipt(state, mutationId, operation, digest, scope) {
  const receipt = arrayFind(state.mutationReceipts, (item) => item.mutationId === mutationId);
  if (!receipt) return null;
  if (receipt.operation !== operation || receipt.requestDigest !== digest || !sameScope(receipt, scope)) {
    conflict("INTEGRATION_REPOSITORY_MUTATION_CONFLICT", "Repository mutation id is bound to another request.");
  }
  return receipt;
}

function errorCode(error) {
  return error?.publicCode || error?.code || "";
}

function nowFrom(factoryNow) {
  const date = factoryNow();
  const value = date instanceof NativeDate
    ? ReflectApply(DatePrototypeToISOString, date, [])
    : StringConstructor(date || "");
  return assertCanonicalIso(value, "repository clock");
}

function threadPreservationDigest(thread) {
  return contractDigest({
    id: thread.id,
    nativeSessionId: thread.nativeSessionId,
    principalId: thread.principalId,
    browserSessionId: thread.browserSessionId,
    browserSessionPolicy: thread.browserSessionPolicy,
    title: thread.title,
    createdAt: thread.createdAt,
    authority: thread.authority,
    replay: thread.replay,
    messages: thread.messages || [],
  });
}

function sameProcessOwner(left, right) {
  return contractDigest(left) === contractDigest(right);
}

function ownedArtifactId(artifact, scope, threadId, runId) {
  return `art_${contractDigest({
    schemaVersion: INTEGRATION_RETAINED_RUNTIME_REPOSITORY_ARTIFACT_IDENTITY_VERSION,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: scope.browserSessionPolicy,
    threadId,
    runId,
    artifact,
  })}`;
}

function outboxDigestView(record) {
  return frozenRecord({
    outboxId: record.outboxId,
    principalId: record.principalId,
    browserSessionId: record.browserSessionId,
    browserSessionPolicy: record.browserSessionPolicy,
    threadId: record.threadId,
    runId: record.runId,
    type: record.type,
    payload: record.payload,
    createdAt: record.createdAt,
    expectedPreviousSeq: record.expectedPreviousSeq,
    expectedPreviousHash: record.expectedPreviousHash,
    expectedEventHash: record.expectedEventHash,
  });
}

function makeOutboxRecords(run, expectedCursor, outputEvent, terminalEvent) {
  let sequence = expectedCursor.lastSeq;
  let previousHash = expectedCursor.lastHash;
  const records = [];
  const completionEvents = arrayFilter([outputEvent, terminalEvent], Boolean);
  for (let inputIndex = 0; inputIndex < completionEvents.length; inputIndex += 1) {
    const input = completionEvents[inputIndex];
    const event = createPublicIntegrationEvent({
      threadId: run.threadId,
      runId: run.id,
      seq: sequence + 1,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt,
      previousHash,
    });
    const record = frozenRecord({
      outboxId: `out_${ReflectApply(StringPrototypeSlice, contractDigest({ runId: run.id, seq: event.seq, hash: event.hash }), [0, 48])}`,
      principalId: run.principalId,
      browserSessionId: run.browserSessionId,
      browserSessionPolicy: run.browserSessionPolicy,
      threadId: run.threadId,
      runId: run.id,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
      expectedPreviousSeq: sequence,
      expectedPreviousHash: previousHash,
      expectedEventHash: event.hash,
      delivered: false,
      deliveredEventSeq: null,
      deliveredEventHash: null,
      deliveredEventDigest: null,
    });
    arrayPush(records, record);
    sequence = event.seq;
    previousHash = event.hash;
  }
  return ObjectFreeze(records);
}

function completionMetadata(run, thread, cursor, records) {
  return frozenRecord({
    schemaVersion: COMPLETION_OUTBOX_METADATA_VERSION,
    principalId: run.principalId,
    browserSessionId: run.browserSessionId,
    browserSessionPolicy: run.browserSessionPolicy,
    threadId: run.threadId,
    runId: run.id,
    status: run.status,
    completedAt: run.completedAt,
    runtimeRevision: run.authority.runtimeRevision,
    completionRevision: run.revision,
    threadRevision: thread.revision,
    originalCursor: frozenRecord({
      firstSeq: cursor.firstSeq,
      lastSeq: cursor.lastSeq,
      lastHash: cursor.lastHash,
      prunedThroughSeq: cursor.prunedThroughSeq,
    }),
    outboxIds: ObjectFreeze(arrayMap(records, (record) => record.outboxId)),
    eventTypes: ObjectFreeze(arrayMap(records, (record) => record.type)),
    eventHashes: ObjectFreeze(arrayMap(records, (record) => record.expectedEventHash)),
    orderedBundleDigest: contractDigest(arrayMap(records, outboxDigestView)),
  });
}

function authorizationResponse(outcome, authorization, run, thread) {
  return frozenRecord({
    schemaVersion: NATIVE_START_AUTHORIZATION_VERSION,
    outcome,
    authorized: true,
    idempotent: outcome === "already-authorized",
    authorizationId: authorization.authorizationId,
    authorizationDigest: authorization.authorizationDigest,
    receipt: cloneRecord(run.nativeStartReceipt),
    run: cloneRecord(run),
    thread: cloneRecord(thread),
  });
}

function abortResponse(action, attempt, run, thread) {
  return frozenRecord({
    schemaVersion: PRE_LAUNCH_ABORT_RESPONSE_VERSION,
    action,
    aborted: action !== "not-created",
    idempotent: action === "already-aborted",
    attemptDigest: attempt.attemptDigest,
    run: cloneRecord(run),
    thread: cloneRecord(thread),
  });
}

function reconciliationDigest(response) {
  const { responseDigest: _responseDigest, ...unsigned } = response;
  return contractDigest(unsigned);
}

function validateReconciliationRequest(request) {
  if (request.schemaVersion !== INTEGRATION_RETAINED_RUNTIME_REPOSITORY_RECONCILIATION_VERSION) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Reconciliation schema is invalid.", 400);
  }
  scopeFor(request);
  assertProcessOwner(request.processOwner, "reconciliation process owner");
  assertCanonicalIso(request.reconciledAt, "reconciliation timestamp");
  assertDigest(request.requestDigest, "reconciliation request digest", { allowZero: false });
  const { requestDigest: _requestDigest, ...unsigned } = request;
  if (request.requestDigest !== contractDigest(unsigned)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Reconciliation request digest is invalid.", 400);
  }
  if (!ArrayIsArray(request.liveRunClaims)) {
    repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Reconciliation live claims are invalid.", 400);
  }
  let previous = "";
  for (let claimIndex = 0; claimIndex < request.liveRunClaims.length; claimIndex += 1) {
    const claim = request.liveRunClaims[claimIndex];
    const checked = exactPayload(claim, ["runId", "threadId", "nativeSessionId", "claimedAt"], [], "live run claim");
    validateIntegrationRunId(checked.runId);
    validateIntegrationThreadId(checked.threadId);
    assertNativeSessionId(checked.nativeSessionId);
    assertCanonicalIso(checked.claimedAt, "live run claim timestamp");
    if (checked.runId <= previous) repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Live claims must be sorted and unique.", 400);
    previous = checked.runId;
  }
  return request;
}

function buildAttestation(runtimeRoots) {
  const unsigned = ObjectCreate(null);
  const values = {
    schemaVersion: INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    descriptorBound: true,
    nativeSessionMapping: "repository",
    onePublicThreadToOneNativeSession: true,
    principalBound: true,
    browserSessionBound: true,
    optimisticRevisions: true,
    casRevisions: true,
    immutableNativeSessionId: true,
    durableThreadSessionMapping: true,
    dispatchLeases: true,
    dispatchOutbox: true,
    nativeStartAuthorization: true,
    receiptRecoveryHold: true,
    exactReconciliationResults: true,
    preLaunchAbort: true,
    terminalOutbox: true,
    completionOutboxBundles: true,
    outboxDelivery: true,
    startupReconciliation: true,
    processIdentity: true,
    artifactTransactionalOutbox: true,
    publishedArtifactsOnly: true,
    exactOwnership: true,
    noPathThreadMapStore: true,
    durable: true,
    retainedDescriptorStorageAuthority: true,
    runtimeRoots,
  };
  for (let keyIndex = 0; keyIndex < INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS.length; keyIndex += 1) {
    const key = INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS[keyIndex];
    if (key !== "digest") unsigned[key] = values[key];
  }
  return frozenRecord({ ...unsigned, digest: contractDigest(unsigned) });
}

function factoryOptions(input) {
  if (!input || typeof input !== "object" || ArrayIsArray(input) || utilTypes.isProxy(input)) {
    repositoryFail("INTEGRATION_REPOSITORY_UNAVAILABLE", "Repository factory options are invalid.");
  }
  if (observePromiseRejectionIfSafe(input)) {
    repositoryFail("INTEGRATION_REPOSITORY_UNAVAILABLE", "Repository factory options must be synchronous data.");
  }
  const keys = ReflectOwnKeys(input);
  if (arraySome(keys, (key) => typeof key !== "string" || !arraySome(FACTORY_KEYS, (allowed) => allowed === key))) {
    repositoryFail("INTEGRATION_REPOSITORY_UNAVAILABLE", "Repository factory options contain unsupported fields.");
  }
  const values = ObjectCreate(null);
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    const descriptor = ObjectGetOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !hasOwn(descriptor, "value")) {
      repositoryFail("INTEGRATION_REPOSITORY_UNAVAILABLE", `Repository factory ${key} must be a data field.`);
    }
    values[key] = descriptor.value;
  }
  const requiredFactoryKeys = ["repositoryState", "repositoryStateExpected", "runtimeRoots"];
  for (let keyIndex = 0; keyIndex < requiredFactoryKeys.length; keyIndex += 1) {
    const required = requiredFactoryKeys[keyIndex];
    if (!hasOwn(values, required)) repositoryFail("INTEGRATION_REPOSITORY_UNAVAILABLE", `Repository factory ${required} is required.`);
  }
  const maxCasRetries = values.maxCasRetries === undefined
    ? DEFAULT_MAX_CAS_RETRIES
    : assertInteger(values.maxCasRetries, "maxCasRetries", 1, 256);
  const now = values.now === undefined ? () => new NativeDate() : values.now;
  if (typeof now !== "function") repositoryFail("INTEGRATION_REPOSITORY_UNAVAILABLE", "Repository clock is unavailable.");
  return {
    repositoryState: values.repositoryState,
    repositoryStateExpected: values.repositoryStateExpected,
    runtimeRoots: values.runtimeRoots,
    maxCasRetries,
    now,
  };
}

export function createRetainedIntegrationRuntimeRepositorySurface(input = {}) {
  const options = factoryOptions(input);
  const repositoryState = assertRetainedIntegrationNativeSessionRepositoryState(
    options.repositoryState,
    options.repositoryStateExpected
  );
  const validatedRuntimeRoots = validateNativeRuntimeRootsAttestation(options.runtimeRoots);
  const expectedBinding = cloneCanonical(
    options.repositoryStateExpected,
    "repository retained binding"
  );
  const expectedSessionsDir = ReflectApply(
    PathResolve,
    path,
    arrayConcat(
      [expectedBinding.sessionStateStore.canonicalPath],
      expectedBinding.sessionStateStore.relativeSegments
    )
  );
  if (validatedRuntimeRoots.sessionsDir !== expectedSessionsDir) {
    repositoryFail(
      "INTEGRATION_REPOSITORY_UNAVAILABLE",
      "Native runtime session root is not bound to the retained session-state descriptor."
    );
  }
  const runtimeRoots = options.runtimeRoots;
  const attestation = buildAttestation(runtimeRoots);

  async function loadSnapshot() {
    if (repositoryState.isClosed()) repositoryFail("INTEGRATION_REPOSITORY_UNAVAILABLE", "Repository storage is closed.");
    return repositoryState.loadDomainSnapshot();
  }

  async function mutate(operation, payload, scope, transition, { explicitMutationId = "" } = {}) {
    const normalizedPayload = cloneCanonical(payload, `${operation} request`);
    const digest = requestDigest(operation, normalizedPayload);
    const mutationId = explicitMutationId || mutationIdFor(operation, digest);
    let committedAt = "";
    for (let attempt = 0; attempt < options.maxCasRetries; attempt += 1) {
      const snapshot = await loadSnapshot();
      const replay = existingReceipt(snapshot.state, mutationId, operation, digest, scope);
      if (replay) return frozenRecord({ outcome: "replayed", result: cloneRecord(replay.result), snapshot });
      if (snapshot.state.mutationReceipts.length >= INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MUTATION_RECEIPTS) {
        conflict("INTEGRATION_REPOSITORY_FULL", "Repository mutation receipt capacity is exhausted.");
      }
      if (!committedAt) committedAt = nowFrom(options.now);
      const transitioned = transition(snapshot.state, snapshot);
      const result = cloneCanonical(transitioned.result, `${operation} result`);
      const receipt = receiptFor({ mutationId, operation, scope, digest, snapshot, result, committedAt });
      const next = domainWith(snapshot.state, snapshot.snapshotRevision + 1, {
        ...transitioned.changes,
        mutationReceipts: sortedById(arrayConcat(snapshot.state.mutationReceipts, [receipt]), "mutationId"),
      });
      try {
        const committed = await repositoryState.compareAndSwapDomainSnapshot({
          mutationId,
          expectedSnapshotRevision: snapshot.snapshotRevision,
          expectedIntegrityDigest: snapshot.integrityDigest,
          state: next,
        });
        const durableReceipt = existingReceipt(committed.snapshot.state, mutationId, operation, digest, scope);
        if (!durableReceipt) repositoryFail("INTEGRATION_REPOSITORY_CORRUPT", "Committed mutation receipt is missing.");
        return frozenRecord({ outcome: committed.outcome, result: cloneRecord(durableReceipt.result), snapshot: committed.snapshot });
      } catch (error) {
        if (setHas(CAS_RETRY_CODES, errorCode(error))) continue;
        throw error;
      }
    }
    repositoryFail("INTEGRATION_REPOSITORY_BUSY", "Repository compare-and-swap retry budget was exhausted.", 429);
  }

  const methods = {
    async listIntegrationThreads(inputPayload) {
      const payload = exactPayload(inputPayload, LIST_THREADS_KEYS, [], "list threads payload");
      const scope = scopeFor(payload);
      assertInteger(payload.limit, "thread list limit", 1, 100);
      if (typeof payload.before !== "string" || payload.before.length > 128) {
        repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Thread list cursor is invalid.", 400);
      }
      if (payload.before) validateIntegrationThreadId(payload.before);
      const snapshot = await loadSnapshot();
      const visible = arraySort(
        arrayFilter(snapshot.state.threads, (thread) => sameScope(thread, scope) && !thread.tombstone),
        (left, right) => compareText(right.createdAt, left.createdAt) || compareText(right.id, left.id)
      );
      let candidates = visible;
      if (payload.before) {
        const anchor = arrayFind(snapshot.state.threads, (thread) => thread.id === payload.before && sameScope(thread, scope));
        if (!anchor) repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Thread list cursor is unknown.", 400);
        candidates = arrayFilter(visible, (thread) =>
          thread.createdAt < anchor.createdAt || (thread.createdAt === anchor.createdAt && thread.id < anchor.id)
        );
      }
      const page = arraySlice(candidates, 0, payload.limit);
      const nextBefore = page.length < candidates.length && page.length ? page[page.length - 1].id : null;
      return frozenRecord({ threads: ObjectFreeze(arrayMap(page, cloneRecord)), nextBefore });
    },

    async createIntegrationThread(inputPayload) {
      const payload = exactPayload(inputPayload, CREATE_THREAD_KEYS, [], "create thread payload");
      const scope = scopeFor(payload);
      validateIntegrationThreadId(payload.threadId);
      assertNativeSessionId(payload.nativeSessionId);
      assertCanonicalIso(payload.createdAt, "thread createdAt");
      assertDigest(payload.policyFingerprint, "thread policy fingerprint", { allowZero: false });
      assertPublicText(payload.title, "thread title", 120, { minimum: 1, trim: true, presentational: true });
      const committed = await mutate("createIntegrationThread", payload, scope, (state) => {
        if (arraySome(state.threads, (thread) => thread.id === payload.threadId || thread.nativeSessionId === payload.nativeSessionId)) {
          conflict("THREAD_CONFLICT", "Thread or native-session mapping already exists.");
        }
        if (state.threads.length >= INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_THREADS) {
          conflict("INTEGRATION_REPOSITORY_FULL", "Repository thread capacity is exhausted.");
        }
        const thread = frozenRecord({
          schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_THREAD_VERSION,
          id: payload.threadId,
          nativeSessionId: payload.nativeSessionId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          browserSessionPolicy: scope.browserSessionPolicy,
          title: payload.title,
          status: "idle",
          revision: 1,
          createdAt: payload.createdAt,
          updatedAt: payload.createdAt,
          deletedAt: null,
          tombstone: false,
          lastRunId: null,
          authority: frozenRecord({
            kind: "aginti",
            mapped: true,
            runtimeRevision: 1,
            contextDigest: payload.policyFingerprint,
            lastCompaction: null,
          }),
          replay: frozenRecord({ prunedMessageCount: 0, anchorDigest: ZERO_DIGEST }),
          messages: ObjectFreeze([]),
        });
        return { changes: { threads: sortedById(arrayConcat(state.threads, [thread])) }, result: frozenRecord({ thread }) };
      });
      return committed.result;
    },

    async getIntegrationThread(inputPayload) {
      const payload = exactPayload(inputPayload, THREAD_LOOKUP_KEYS, [], "get thread payload");
      const scope = scopeFor(payload);
      const threadId = validateIntegrationThreadId(payload.threadId);
      const snapshot = await loadSnapshot();
      return frozenRecord({ thread: cloneRecord(findThread(snapshot.state, threadId, scope)) });
    },

    async updateIntegrationThread(inputPayload) {
      const payload = exactPayload(inputPayload, UPDATE_THREAD_KEYS, [], "update thread payload");
      const scope = scopeFor(payload);
      validateIntegrationThreadId(payload.threadId);
      assertInteger(payload.expectedRevision, "thread expected revision", 1);
      assertCanonicalIso(payload.updatedAt, "thread updatedAt");
      assertPublicText(payload.title, "thread title", 120, { minimum: 1, trim: true, presentational: true });
      const committed = await mutate("updateIntegrationThread", payload, scope, (state) => {
        const current = findThread(state, payload.threadId, scope);
        if (!current || current.revision !== payload.expectedRevision || current.status !== "idle") {
          conflict("REVISION_CONFLICT", "Thread revision or state changed.");
        }
        const thread = frozenRecord({ ...current, title: payload.title, updatedAt: payload.updatedAt, revision: current.revision + 1 });
        return { changes: { threads: replaceById(state.threads, thread) }, result: frozenRecord({ thread }) };
      });
      return committed.result;
    },

    async deleteIntegrationThread(inputPayload) {
      const payload = exactPayload(inputPayload, DELETE_THREAD_KEYS, [], "delete thread payload");
      const scope = scopeFor(payload);
      validateIntegrationThreadId(payload.threadId);
      assertInteger(payload.expectedRevision, "thread expected revision", 1);
      let deletedAt = "";
      const committed = await mutate("deleteIntegrationThread", payload, scope, (state) => {
        if (!deletedAt) deletedAt = nowFrom(options.now);
        const current = findThread(state, payload.threadId, scope);
        if (!current || current.revision !== payload.expectedRevision || current.status !== "idle") {
          conflict("REVISION_CONFLICT", "Thread revision or state changed.");
        }
        const thread = frozenRecord({
          ...current,
          status: "deleting",
          revision: current.revision + 1,
          updatedAt: deletedAt,
          deletedAt,
          tombstone: true,
        });
        return { changes: { threads: replaceById(state.threads, thread) }, result: frozenRecord({ deleted: true, thread }) };
      });
      return committed.result;
    },

    async getActiveIntegrationRunForThread(inputPayload) {
      const payload = exactPayload(inputPayload, THREAD_LOOKUP_KEYS, [], "active run payload");
      const scope = scopeFor(payload);
      validateIntegrationThreadId(payload.threadId);
      const snapshot = await loadSnapshot();
      const run = arrayFind(snapshot.state.runs, (item) =>
        item.threadId === payload.threadId && sameScope(item, scope) && !item.hidden && !item.tombstone && setHas(ACTIVE_STATUSES, item.status)
      ) || null;
      return frozenRecord({ run: cloneRecord(run) });
    },

    async createIntegrationRun(inputPayload) {
      const payload = exactPayload(inputPayload, CREATE_RUN_KEYS, [], "create run payload");
      const scope = scopeFor(payload);
      validateIntegrationRunId(payload.runId);
      validateIntegrationThreadId(payload.threadId);
      assertNativeSessionId(payload.nativeSessionId);
      if (payload.previousRunId !== null) validateIntegrationRunId(payload.previousRunId);
      assertInteger(payload.expectedThreadRevision, "thread expected revision", 1);
      assertInteger(payload.expectedNativeRuntimeRevision, "native runtime revision", 1);
      assertCanonicalIso(payload.createdAt, "run createdAt");
      if (payload.status !== "starting") repositoryFail("INTEGRATION_REPOSITORY_INVALID", "New run status must be starting.", 400);
      const runInput = exactPayload(payload.input, ["text"], [], "create run input");
      assertInputText(runInput.text);
      const inputDigest = contractDigest({ schemaVersion: REPOSITORY_INPUT_DIGEST_VERSION, input: runInput });
      const committed = await mutate("createIntegrationRun", payload, scope, (state) => {
        const thread = findThread(state, payload.threadId, scope);
        if (
          !thread || thread.status !== "idle" || thread.revision !== payload.expectedThreadRevision ||
          thread.nativeSessionId !== payload.nativeSessionId ||
          thread.authority.runtimeRevision !== payload.expectedNativeRuntimeRevision
        ) conflict("REVISION_CONFLICT", "Thread revision or native-session mapping changed.");
        if (arraySome(state.runs, (run) => run.id === payload.runId)) conflict("RUN_CONFLICT", "Run already exists.");
        if (state.runs.length >= INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RUNS) {
          conflict("INTEGRATION_REPOSITORY_FULL", "Repository run capacity is exhausted.");
        }
        const active = arraySome(state.runs, (run) =>
          run.threadId === thread.id && !run.hidden && !run.tombstone && setHas(ACTIVE_STATUSES, run.status)
        );
        if (active) conflict("RUN_CONFLICT", "Thread already has an active run.");
        const previous = payload.previousRunId === null ? null : findRun(state, payload.previousRunId, scope);
        if (
          (previous === null) !== (thread.lastRunId === null) ||
          (previous && (
            previous.id !== thread.lastRunId || previous.threadId !== thread.id ||
            previous.nativeSessionId !== thread.nativeSessionId || !setHas(TERMINAL_STATUSES, previous.status) ||
            previous.authority.runtimeRevision !== payload.expectedNativeRuntimeRevision
          ))
        ) conflict("RUN_CONFLICT", "Run predecessor is not the terminal thread head.");
        const run = frozenRecord({
          schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RUN_VERSION,
          id: payload.runId,
          threadId: thread.id,
          nativeSessionId: thread.nativeSessionId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          browserSessionPolicy: scope.browserSessionPolicy,
          previousRunId: payload.previousRunId,
          status: "starting",
          revision: 1,
          createdAt: payload.createdAt,
          startedAt: payload.createdAt,
          completedAt: null,
          cancelRequestedAt: null,
          dispatchLeaseId: null,
          dispatchOutbox: false,
          dispatchedAt: null,
          processOwner: null,
          hidden: false,
          tombstone: false,
          abortAttemptDigest: null,
          abortAt: null,
          nativeStartReceipt: null,
          recoveryState: null,
          inputDigest,
          output: "",
          error: null,
          authority: frozenRecord({
            kind: "aginti",
            snapshotHash: contractDigest({
              schemaVersion: REPOSITORY_SNAPSHOT_HASH_VERSION,
              runId: payload.runId,
              threadId: thread.id,
              nativeSessionId: thread.nativeSessionId,
              inputDigest,
              runtimeRevision: payload.expectedNativeRuntimeRevision,
            }),
            runtimeRevision: payload.expectedNativeRuntimeRevision,
            contextDigest: thread.authority.contextDigest,
            completionOutbox: null,
          }),
        });
        const updatedThread = frozenRecord({
          ...thread,
          status: "running",
          revision: thread.revision + 1,
          updatedAt: payload.createdAt,
          lastRunId: run.id,
        });
        return {
          changes: { threads: replaceById(state.threads, updatedThread), runs: sortedById(arrayConcat(state.runs, [run])) },
          result: frozenRecord({ run, thread: updatedThread }),
        };
      });
      return committed.result;
    },

    async markIntegrationRunDispatching(inputPayload) {
      const payload = exactPayload(inputPayload, DISPATCH_RUN_KEYS, [], "dispatch run payload");
      const scope = scopeFor(payload);
      validateIntegrationRunId(payload.runId);
      validateIntegrationThreadId(payload.threadId);
      assertInteger(payload.expectedRevision, "run expected revision", 1);
      assertInteger(payload.expectedNativeRuntimeRevision, "native runtime revision", 1);
      assertDigest(payload.dispatchLeaseId, "dispatch lease", { allowZero: false });
      if (payload.dispatchOutbox !== true) repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Dispatch outbox must be enabled.", 400);
      assertCanonicalIso(payload.dispatchedAt, "run dispatchedAt");
      assertProcessOwner(payload.processOwner, "dispatch process owner");
      const committed = await mutate("markIntegrationRunDispatching", payload, scope, (state) => {
        const run = findRun(state, payload.runId, scope);
        if (
          !run || run.threadId !== payload.threadId || run.status !== "starting" ||
          run.revision !== payload.expectedRevision || run.authority.runtimeRevision !== payload.expectedNativeRuntimeRevision ||
          run.nativeStartReceipt !== null
        ) conflict("REVISION_CONFLICT", "Run cannot enter dispatching state.");
        const updated = frozenRecord({
          ...run,
          status: "running",
          revision: run.revision + 1,
          dispatchLeaseId: payload.dispatchLeaseId,
          dispatchOutbox: true,
          processOwner: payload.processOwner,
          dispatchedAt: payload.dispatchedAt,
        });
        return { changes: { runs: replaceById(state.runs, updated) }, result: frozenRecord({ run: updated }) };
      });
      return committed.result;
    },

    async authorizeIntegrationRunNativeStart(inputPayload) {
      const wrapper = exactPayload(inputPayload, AUTHORIZATION_WRAPPER_KEYS, [], "native start wrapper");
      const authorization = exactPayload(wrapper.authorization, [
        "schemaVersion", "mode", "principalId", "browserSessionId", "browserSessionPolicy", "threadId", "runId",
        "nativeSessionId", "previousRunId", "previousRunRevision", "previousRunRuntimeRevision", "threadRevision",
        "threadPreservationDigest", "createdAt", "startedAt", "expectedNativeRuntimeRevision",
        "targetNativeRuntimeRevision", "expectedRunRevision", "targetRunRevision", "dispatchLeaseId",
        "dispatchOutbox", "dispatchedAt", "processOwner", "authorizedAt", "authorizationId", "authorizationDigest",
      ], [], "native start authorization");
      const scope = scopeFor(authorization);
      if (authorization.schemaVersion !== NATIVE_START_AUTHORIZATION_VERSION) {
        repositoryFail("NATIVE_START_AUTHORIZATION_REFUSED", "Native start schema is invalid.", 409);
      }
      if (authorization.mode !== "start" && authorization.mode !== "resume") {
        repositoryFail("NATIVE_START_AUTHORIZATION_REFUSED", "Native start mode is invalid.", 409);
      }
      validateIntegrationThreadId(authorization.threadId);
      validateIntegrationRunId(authorization.runId);
      assertNativeSessionId(authorization.nativeSessionId);
      const revisionFields = [
        [authorization.threadRevision, "authorization thread revision"],
        [authorization.expectedNativeRuntimeRevision, "authorization expected native runtime revision"],
        [authorization.targetNativeRuntimeRevision, "authorization target native runtime revision"],
        [authorization.expectedRunRevision, "authorization expected run revision"],
        [authorization.targetRunRevision, "authorization target run revision"],
      ];
      for (let fieldIndex = 0; fieldIndex < revisionFields.length; fieldIndex += 1) {
        assertInteger(revisionFields[fieldIndex][0], revisionFields[fieldIndex][1], 1);
      }
      const timestampFields = [
        [authorization.createdAt, "authorization createdAt"],
        [authorization.startedAt, "authorization startedAt"],
        [authorization.dispatchedAt, "authorization dispatchedAt"],
        [authorization.authorizedAt, "authorization authorizedAt"],
      ];
      for (let fieldIndex = 0; fieldIndex < timestampFields.length; fieldIndex += 1) {
        assertCanonicalIso(timestampFields[fieldIndex][0], timestampFields[fieldIndex][1]);
      }
      assertDigest(authorization.threadPreservationDigest, "authorization thread preservation digest", { allowZero: false });
      assertDigest(authorization.dispatchLeaseId, "authorization dispatch lease", { allowZero: false });
      assertProcessOwner(authorization.processOwner, "authorization process owner");
      if (
        authorization.dispatchOutbox !== true ||
        authorization.createdAt !== authorization.startedAt ||
        authorization.authorizedAt !== authorization.dispatchedAt ||
        authorization.expectedRunRevision !== 2 ||
        authorization.targetRunRevision !== 3 ||
        (authorization.mode === "start" && (
          authorization.previousRunId !== null ||
          authorization.previousRunRevision !== null ||
          authorization.previousRunRuntimeRevision !== null ||
          authorization.targetNativeRuntimeRevision !== authorization.expectedNativeRuntimeRevision
        )) ||
        (authorization.mode === "resume" && (
          !authorization.previousRunId ||
          authorization.targetNativeRuntimeRevision !== authorization.expectedNativeRuntimeRevision + 1
        ))
      ) {
        repositoryFail("NATIVE_START_AUTHORIZATION_REFUSED", "Native start transition is invalid.", 409);
      }
      if (authorization.mode === "resume") {
        validateIntegrationRunId(authorization.previousRunId);
        assertInteger(authorization.previousRunRevision, "authorization previous run revision", 1);
        assertInteger(authorization.previousRunRuntimeRevision, "authorization previous runtime revision", 1);
      }
      const { authorizationId: _authorizationId, authorizationDigest: _authorizationDigest, ...unsigned } = authorization;
      const digest = contractDigest(unsigned);
      if (
        authorization.authorizationDigest !== digest ||
        authorization.authorizationId !== `nstart_${ReflectApply(StringPrototypeSlice, digest, [0, 48])}`
      ) {
        repositoryFail("NATIVE_START_AUTHORIZATION_REFUSED", "Native start digest is invalid.", 409);
      }
      const committed = await mutate(
        "authorizeIntegrationRunNativeStart",
        wrapper,
        scope,
        (state) => {
          const run = findRun(state, authorization.runId, scope);
          const thread = findThread(state, authorization.threadId, scope);
          const previous = authorization.previousRunId === null ? null : findRun(state, authorization.previousRunId, scope);
          if (run?.nativeStartReceipt) {
            repositoryFail(
              "INTEGRATION_REPOSITORY_CORRUPT",
              "Native start receipt exists without its durable mutation receipt."
            );
          }
          if (
            !run || !thread || run.status !== "running" || run.revision !== authorization.expectedRunRevision ||
            run.threadId !== authorization.threadId || run.nativeSessionId !== authorization.nativeSessionId ||
            run.previousRunId !== authorization.previousRunId || run.createdAt !== authorization.createdAt ||
            run.startedAt !== authorization.startedAt || run.dispatchLeaseId !== authorization.dispatchLeaseId ||
            run.dispatchOutbox !== true || run.dispatchedAt !== authorization.dispatchedAt ||
            run.authority.runtimeRevision !== authorization.expectedNativeRuntimeRevision ||
            !sameProcessOwner(run.processOwner, authorization.processOwner) ||
            thread.status !== "running" || thread.lastRunId !== run.id || thread.revision !== authorization.threadRevision ||
            thread.updatedAt !== authorization.createdAt || thread.nativeSessionId !== authorization.nativeSessionId ||
            thread.authority.runtimeRevision !== authorization.expectedNativeRuntimeRevision ||
            threadPreservationDigest(thread) !== authorization.threadPreservationDigest ||
            authorization.targetRunRevision !== authorization.expectedRunRevision + 1 ||
            authorization.authorizedAt !== authorization.dispatchedAt ||
            (authorization.mode === "start" && (authorization.previousRunId !== null || authorization.targetNativeRuntimeRevision !== authorization.expectedNativeRuntimeRevision)) ||
            (authorization.mode === "resume" && (
              !previous || !setHas(TERMINAL_STATUSES, previous.status) || previous.revision !== authorization.previousRunRevision ||
              previous.authority.runtimeRevision !== authorization.previousRunRuntimeRevision ||
              authorization.targetNativeRuntimeRevision !== authorization.expectedNativeRuntimeRevision + 1
            ))
          ) repositoryFail("NATIVE_START_AUTHORIZATION_REFUSED", "Native start state changed.", 409);
          const updated = frozenRecord({ ...run, nativeStartReceipt: authorization, revision: authorization.targetRunRevision });
          return {
            changes: { runs: replaceById(state.runs, updated) },
            result: authorizationResponse("authorized", authorization, updated, thread),
          };
        },
        { explicitMutationId: `repository.native-start.${authorization.authorizationDigest}` }
      );
      if (committed.outcome !== "committed") {
        return authorizationResponse("already-authorized", authorization, committed.result.run, committed.result.thread);
      }
      return committed.result;
    },

    async abortIntegrationRunBeforeLaunch(inputPayload) {
      const wrapper = exactPayload(inputPayload, ABORT_WRAPPER_KEYS, [], "pre-launch abort wrapper");
      const attempt = exactPayload(wrapper.attempt, [
        "schemaVersion", "mode", "principalId", "browserSessionId", "browserSessionPolicy", "threadId", "runId",
        "nativeSessionId", "previousRunId", "previousThreadRevision", "expectedNativeRuntimeRevision",
        "threadPreservationDigest", "nativeStartReceiptMustBeAbsent", "createdAt", "dispatchAttempted",
        "dispatchLeaseId", "dispatchOutbox", "dispatchedAt", "processOwner", "abortAt", "attemptDigest",
      ], [], "pre-launch abort attempt");
      const scope = scopeFor(attempt);
      if (attempt.mode !== "start" && attempt.mode !== "resume") {
        repositoryFail("PRE_LAUNCH_ABORT_REFUSED", "Pre-launch abort mode is invalid.", 409);
      }
      validateIntegrationThreadId(attempt.threadId);
      validateIntegrationRunId(attempt.runId);
      assertNativeSessionId(attempt.nativeSessionId);
      assertInteger(attempt.previousThreadRevision, "pre-launch abort previous thread revision", 1);
      assertInteger(attempt.expectedNativeRuntimeRevision, "pre-launch abort native runtime revision", 1);
      assertDigest(attempt.threadPreservationDigest, "pre-launch abort thread preservation digest", { allowZero: false });
      assertCanonicalIso(attempt.createdAt, "pre-launch abort createdAt");
      assertCanonicalIso(attempt.abortAt, "pre-launch abort abortAt");
      if (
        attempt.abortAt < attempt.createdAt ||
        (attempt.mode === "start" && attempt.previousRunId !== null) ||
        (attempt.mode === "resume" && !attempt.previousRunId) ||
        typeof attempt.dispatchAttempted !== "boolean"
      ) repositoryFail("PRE_LAUNCH_ABORT_REFUSED", "Pre-launch abort transition is invalid.", 409);
      if (attempt.mode === "resume") validateIntegrationRunId(attempt.previousRunId);
      if (attempt.dispatchAttempted) {
        assertDigest(attempt.dispatchLeaseId, "pre-launch abort dispatch lease", { allowZero: false });
        assertCanonicalIso(attempt.dispatchedAt, "pre-launch abort dispatchedAt");
        assertProcessOwner(attempt.processOwner, "pre-launch abort process owner");
        if (attempt.dispatchOutbox !== true) {
          repositoryFail("PRE_LAUNCH_ABORT_REFUSED", "Pre-launch abort dispatch outbox is invalid.", 409);
        }
      } else if (
        attempt.dispatchLeaseId !== null ||
        attempt.dispatchOutbox !== false ||
        attempt.dispatchedAt !== null ||
        attempt.processOwner !== null
      ) {
        repositoryFail("PRE_LAUNCH_ABORT_REFUSED", "Pre-launch abort dispatch state is invalid.", 409);
      }
      const { attemptDigest: _attemptDigest, ...unsigned } = attempt;
      if (
        attempt.schemaVersion !== PRE_LAUNCH_ABORT_ATTEMPT_VERSION ||
        attempt.nativeStartReceiptMustBeAbsent !== true ||
        attempt.attemptDigest !== contractDigest(unsigned)
      ) repositoryFail("PRE_LAUNCH_ABORT_REFUSED", "Pre-launch abort attempt is invalid.", 409);
      const committed = await mutate(
        "abortIntegrationRunBeforeLaunch",
        wrapper,
        scope,
        (state) => {
          const run = findRun(state, attempt.runId, scope, { includeHidden: true });
          const thread = findThread(state, attempt.threadId, scope, { includeTombstone: true });
          if (!run) {
            return { changes: {}, result: abortResponse("not-created", attempt, null, null) };
          }
          if (run?.status === "aborted_before_launch") {
            repositoryFail(
              "INTEGRATION_REPOSITORY_CORRUPT",
              "Pre-launch abort state exists without its durable mutation receipt."
            );
          }
          if (
            !run || !thread || run.nativeStartReceipt !== null || run.threadId !== attempt.threadId ||
            run.nativeSessionId !== attempt.nativeSessionId || run.previousRunId !== attempt.previousRunId ||
            run.authority.runtimeRevision !== attempt.expectedNativeRuntimeRevision ||
            thread.lastRunId !== attempt.runId || thread.revision !== attempt.previousThreadRevision + 1 ||
            threadPreservationDigest(thread) !== attempt.threadPreservationDigest
          ) repositoryFail("PRE_LAUNCH_ABORT_REFUSED", "Pre-launch abort target changed.", 409);
          if (run.status === "running") {
            if (
              attempt.dispatchAttempted !== true || run.revision !== 2 || run.dispatchLeaseId !== attempt.dispatchLeaseId ||
              run.dispatchOutbox !== true || run.dispatchedAt !== attempt.dispatchedAt ||
              !sameProcessOwner(run.processOwner, attempt.processOwner)
            ) repositoryFail("PRE_LAUNCH_ABORT_REFUSED", "Pre-launch dispatch receipt changed.", 409);
          } else if (run.status !== "starting" || run.revision !== 1) {
            repositoryFail("PRE_LAUNCH_ABORT_REFUSED", "Run cannot be aborted before launch.", 409);
          }
          const aborted = frozenRecord({
            ...run,
            status: "aborted_before_launch",
            revision: run.revision + 1,
            hidden: true,
            tombstone: true,
            abortAttemptDigest: attempt.attemptDigest,
            abortAt: attempt.abortAt,
          });
          const restoredThread = frozenRecord({
            ...thread,
            status: "idle",
            revision: thread.revision + 1,
            updatedAt: attempt.abortAt,
            lastRunId: attempt.previousRunId,
          });
          return {
            changes: { threads: replaceById(state.threads, restoredThread), runs: replaceById(state.runs, aborted) },
            result: abortResponse("aborted", attempt, aborted, restoredThread),
          };
        },
        { explicitMutationId: `repository.prelaunch-abort.${attempt.attemptDigest}` }
      );
      if (committed.outcome !== "committed") {
        if (committed.result.action === "not-created") return committed.result;
        return abortResponse("already-aborted", attempt, committed.result.run, committed.result.thread);
      }
      return committed.result;
    },

    async getIntegrationRun(inputPayload) {
      const payload = exactPayload(inputPayload, RUN_LOOKUP_KEYS, [], "get run payload");
      const scope = scopeFor(payload);
      const runId = validateIntegrationRunId(payload.runId);
      const snapshot = await loadSnapshot();
      return frozenRecord({ run: cloneRecord(findRun(snapshot.state, runId, scope)) });
    },

    async markIntegrationRunCancelling(inputPayload) {
      const payload = exactPayload(inputPayload, CANCEL_RUN_KEYS, [], "cancel run payload");
      const scope = scopeFor(payload);
      validateIntegrationRunId(payload.runId);
      validateIntegrationThreadId(payload.threadId);
      assertInteger(payload.expectedRevision, "run expected revision", 1);
      assertCanonicalIso(payload.cancelRequestedAt, "cancelRequestedAt");
      assertProcessOwner(payload.processOwner, "cancellation process owner");
      const committed = await mutate("markIntegrationRunCancelling", payload, scope, (state) => {
        const run = findRun(state, payload.runId, scope);
        if (
          !run || run.threadId !== payload.threadId || !setHas(ACTIVE_STATUSES, run.status) ||
          run.revision !== payload.expectedRevision || run.recoveryState !== null ||
          !sameProcessOwner(run.processOwner, payload.processOwner)
        ) conflict("REVISION_CONFLICT", "Run revision or cancellation state changed.");
        const updated = frozenRecord({
          ...run,
          revision: run.revision + 1,
          cancelRequestedAt: payload.cancelRequestedAt,
          processOwner: payload.processOwner,
        });
        return { changes: { runs: replaceById(state.runs, updated) }, result: frozenRecord({ run: updated }) };
      });
      return committed.result;
    },

    async finishIntegrationRunWithOutbox(inputPayload) {
      const payload = exactPayload(inputPayload, FINISH_RUN_KEYS, [], "finish run payload");
      const scope = scopeFor(payload);
      validateIntegrationRunId(payload.runId);
      validateIntegrationThreadId(payload.threadId);
      assertInteger(payload.expectedRevision, "run expected revision", 1);
      assertInteger(payload.expectedNativeRuntimeRevision, "expected native runtime revision", 1);
      assertInteger(payload.completedNativeRuntimeRevision, "completed native runtime revision", 1);
      assertCanonicalIso(payload.completedAt, "run completedAt");
      assertDigest(payload.resultDigest, "run result digest", { allowZero: false });
      assertNativeSessionId(payload.nativeSessionId);
      assertProcessOwner(payload.processOwner, "completion process owner");
      if (!setHas(TERMINAL_STATUSES, payload.status)) repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Terminal run status is invalid.", 400);
      assertPublicText(payload.output, "run output", 32_000);
      const terminalError = payload.error === null
        ? null
        : exactPayload(payload.error, ["code", "message"], [], "run error");
      if (terminalError !== null) {
        if (!setHas(PUBLIC_ERROR_CODES, terminalError.code)) {
          repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Run error code is not public.", 400);
        }
        assertPublicText(terminalError.message, "run error message", 600, { minimum: 1, trim: true });
      }
      if (
        (payload.status === "completed" && terminalError !== null) ||
        (payload.status !== "completed" && (payload.output !== "" || terminalError === null))
      ) repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Terminal output and error fields do not match the status.", 400);
      if (
        payload.status !== "completed" &&
        ((payload.status === "cancelled") !== (terminalError.code === "CANCELLED"))
      ) {
        repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Terminal status and public error code do not match.", 400);
      }
      const committed = await mutate("finishIntegrationRunWithOutbox", payload, scope, (state) => {
        const run = findRun(state, payload.runId, scope);
        const thread = findThread(state, payload.threadId, scope);
        if (
          !run || !thread || run.threadId !== payload.threadId || run.nativeSessionId !== payload.nativeSessionId ||
          run.status !== "running" || run.revision !== payload.expectedRevision || run.nativeStartReceipt === null ||
          run.authority.runtimeRevision !== payload.expectedNativeRuntimeRevision ||
          run.nativeStartReceipt.targetNativeRuntimeRevision !== payload.completedNativeRuntimeRevision ||
          thread.lastRunId !== run.id || thread.status !== "running"
        ) conflict("REVISION_CONFLICT", "Run cannot enter terminal state.");
        if (
          run.recoveryState === null &&
          !sameProcessOwner(run.processOwner, payload.processOwner)
        ) {
          conflict("REVISION_CONFLICT", "Completion process owner changed.");
        }
        if (run.recoveryState !== null) {
          conflict(
            "RECOVERY_HOLD",
            "Recovery-held transition requires retained native-session evidence outside this repository slice."
          );
        }
        if (
          run.cancelRequestedAt !== null &&
          (payload.status !== "cancelled" || payload.error?.code !== "CANCELLED")
        ) {
          conflict("REVISION_CONFLICT", "A durably cancelled run must finish as cancelled.");
        }
        const cursor = exactPayload(
          payload.expectedCursor,
          ["firstSeq", "lastSeq", "lastHash", "prunedThroughSeq"],
          [],
          "completion cursor"
        );
        if (cursor.firstSeq !== 1 || cursor.prunedThroughSeq !== 0) {
          repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Completion cursor is unsupported.", 400);
        }
        assertInteger(cursor.lastSeq, "completion cursor sequence", 0, 10_000_000_000);
        assertDigest(cursor.lastHash, "completion cursor hash");
        if ((cursor.lastSeq === 0) !== (cursor.lastHash === ZERO_DIGEST)) {
          repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Completion cursor hash does not match its sequence.", 400);
        }
        const terminalEvent = exactPayload(payload.terminalEvent, ["type", "payload", "createdAt"], [], "terminal event");
        exactPayload(terminalEvent.payload, [], [], "terminal event payload");
        if (terminalEvent.type !== `run.${payload.status}` || terminalEvent.createdAt !== payload.completedAt) {
          repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Terminal event does not match the run.", 400);
        }
        const outputEvent = payload.outputEvent === null
          ? null
          : exactPayload(payload.outputEvent, ["type", "payload", "createdAt"], [], "output event");
        const outputEventPayload = outputEvent === null
          ? null
          : exactPayload(outputEvent.payload, ["text"], [], "output event payload");
        if (
          (payload.status === "completed" && ReflectApply(StringPrototypeTrim, payload.output, []).length > 0) !== (outputEvent !== null) ||
          (outputEvent && (
            outputEvent.type !== "output.delta" ||
            outputEvent.createdAt !== payload.completedAt ||
            outputEventPayload.text !== ReflectApply(StringPrototypeSlice, payload.output, [0, 4_000])
          ))
        ) repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Output event does not match the run output.", 400);
        const runRevision = run.revision + 1;
        const threadRevision = thread.revision + 1;
        const terminalBase = frozenRecord({
          ...run,
          status: payload.status,
          revision: runRevision,
          completedAt: payload.completedAt,
          processOwner: payload.processOwner,
          recoveryState: null,
          output: payload.status === "completed" ? payload.output : "",
          error: payload.status === "completed" ? null : terminalError,
          authority: frozenRecord({
            ...run.authority,
            runtimeRevision: payload.completedNativeRuntimeRevision,
            completionOutbox: null,
          }),
        });
        const updatedThread = frozenRecord({
          ...thread,
          status: "idle",
          revision: threadRevision,
          updatedAt: payload.completedAt,
          authority: frozenRecord({ ...thread.authority, runtimeRevision: payload.completedNativeRuntimeRevision }),
        });
        const outboxEvents = makeOutboxRecords(terminalBase, cursor, outputEvent, terminalEvent);
        if (state.outboxEvents.length + outboxEvents.length > INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_OUTBOX_EVENTS) {
          conflict("INTEGRATION_REPOSITORY_FULL", "Repository outbox capacity is exhausted.");
        }
        if (arraySome(outboxEvents, (record) =>
          arraySome(state.outboxEvents, (existing) => existing.outboxId === record.outboxId)
        )) {
          conflict("OUTBOX_CONFLICT", "Completion outbox id already exists.");
        }
        const terminalRun = frozenRecord({
          ...terminalBase,
          authority: frozenRecord({
            ...terminalBase.authority,
            completionOutbox: completionMetadata(terminalBase, updatedThread, cursor, outboxEvents),
          }),
        });
        return {
          changes: {
            threads: replaceById(state.threads, updatedThread),
            runs: replaceById(state.runs, terminalRun),
            outboxEvents: sortedById(arrayConcat(state.outboxEvents, outboxEvents), "outboxId"),
          },
          result: frozenRecord({
            run: terminalRun,
            thread: updatedThread,
            outboxEvents,
            resultDigest: payload.resultDigest,
          }),
        };
      });
      return committed.result;
    },

    async getIntegrationCompletionOutboxBundle(inputPayload) {
      const payload = exactPayload(inputPayload, COMPLETION_BUNDLE_KEYS, [], "completion bundle payload");
      const scope = scopeFor(payload);
      validateIntegrationThreadId(payload.threadId);
      validateIntegrationRunId(payload.runId);
      const snapshot = await loadSnapshot();
      const run = findRun(snapshot.state, payload.runId, scope);
      if (!run || run.threadId !== payload.threadId || !run.authority.completionOutbox) {
        return frozenRecord({ outboxEvents: ObjectFreeze([]) });
      }
      const byId = mapFromRecords(snapshot.state.outboxEvents, (record) => record.outboxId);
      return frozenRecord({
        outboxEvents: ObjectFreeze(arrayMap(
          run.authority.completionOutbox.outboxIds,
          (outboxId) => cloneRecord(mapGet(byId, outboxId))
        )),
      });
    },

    async reconcileIntegrationDispatches(inputPayload) {
      const request = validateReconciliationRequest(
        exactPayload(inputPayload, RECONCILIATION_KEYS, [], "dispatch reconciliation request")
      );
      const scope = scopeFor(request);
      const mutationPayload = request;
      const transition = (state) => {
        const claims = mapFromRecords(request.liveRunClaims, (claim) => claim.runId);
        let threads = state.threads;
        let runs = state.runs;
        let changed = false;
        const results = [];
        const reconciledAtMs = ReflectApply(DateParse, NativeDate, [request.reconciledAt]);
        for (let runIndex = 0; runIndex < state.runs.length; runIndex += 1) {
          const original = state.runs[runIndex];
          if (!sameScope(original, scope) || original.hidden || !setHas(ACTIVE_STATUSES, original.status)) continue;
          let run = original;
          const admittedAtMs = ReflectApply(DateParse, NativeDate, [run.dispatchedAt || run.createdAt]);
          if (!NumberIsFinite(admittedAtMs) || admittedAtMs > reconciledAtMs) continue;
          const thread = findThread({ ...state, threads }, run.threadId, scope);
          if (!run.nativeStartReceipt) {
            const abortAt = request.reconciledAt;
            const abortAttemptDigest = contractDigest({
              schemaVersion: STARTUP_ABORT_VERSION,
              requestDigest: request.requestDigest,
              runId: run.id,
              revision: run.revision,
            });
            run = frozenRecord({
              ...run,
              status: "aborted_before_launch",
              revision: run.revision + 1,
              hidden: true,
              tombstone: true,
              abortAttemptDigest,
              abortAt,
            });
            const restoredThread = frozenRecord({
              ...thread,
              status: "idle",
              revision: thread.revision + 1,
              updatedAt: abortAt,
              lastRunId: run.previousRunId,
            });
            runs = replaceById(runs, run);
            threads = replaceById(threads, restoredThread);
            changed = true;
            continue;
          }
          if (run.recoveryState) {
            arrayPush(results, frozenRecord({ action: "already-held", run, thread }));
            continue;
          }
          const claim = mapGet(claims, run.id);
          const claimedAt = claim ? ReflectApply(DateParse, NativeDate, [claim.claimedAt]) : NumberNaN;
          const exactLive = NativeBoolean(
            claim && claim.threadId === run.threadId && claim.nativeSessionId === run.nativeSessionId &&
            NumberIsFinite(claimedAt) &&
            claimedAt >= ReflectApply(DateParse, NativeDate, [run.dispatchedAt]) &&
            claimedAt <= reconciledAtMs &&
            sameProcessOwner(run.processOwner, request.processOwner)
          );
          if (exactLive) {
            arrayPush(results, frozenRecord({ action: "live", run, thread }));
            continue;
          }
          const legalRevision = run.nativeStartReceipt.targetRunRevision + (run.cancelRequestedAt ? 1 : 0);
          if (run.revision !== legalRevision) repositoryFail("INTEGRATION_REPOSITORY_CORRUPT", "Active run revision cannot be reconciled.");
          const recoveryUnsigned = frozenRecord({
            schemaVersion: NATIVE_START_RECOVERY_STATE_VERSION,
            status: "recovery_hold",
            reason: "retained_descriptor_unavailable",
            authorizationId: run.nativeStartReceipt.authorizationId,
            authorizationDigest: run.nativeStartReceipt.authorizationDigest,
            sourceRunRevision: run.revision,
            appliedRunRevision: run.revision + 1,
            heldAt: request.reconciledAt,
            observedByProcessOwner: request.processOwner,
          });
          const recoveryState = frozenRecord({ ...recoveryUnsigned, digest: contractDigest(recoveryUnsigned) });
          run = frozenRecord({ ...run, recoveryState, revision: recoveryState.appliedRunRevision });
          runs = replaceById(runs, run);
          arrayPush(results, frozenRecord({ action: "held", run, thread }));
          changed = true;
        }
        const pendingOutboxEvents = ObjectFreeze(arrayMap(
          arrayFilter(state.outboxEvents, (record) => sameScope(record, scope) && !record.delivered),
          cloneRecord
        ));
        const unsignedResponse = frozenRecord({
          schemaVersion: RECONCILIATION_RESPONSE_VERSION,
          requestDigest: request.requestDigest,
          reconciled: true,
          receiptRunResults: ObjectFreeze(arraySort(results, (left, right) => compareText(left.run.id, right.run.id))),
          pendingOutboxEvents,
        });
        const response = frozenRecord({ ...unsignedResponse, responseDigest: reconciliationDigest(unsignedResponse) });
        return { changed, changes: { threads, runs }, result: response };
      };
      const reconcileMutationId = `repository.reconcile.${request.requestDigest}`;
      const snapshot = await loadSnapshot();
      const reconcileDigest = requestDigest("reconcileIntegrationDispatches", mutationPayload);
      const replay = existingReceipt(
        snapshot.state,
        reconcileMutationId,
        "reconcileIntegrationDispatches",
        reconcileDigest,
        scope
      );
      if (replay) return cloneRecord(replay.result);
      const preview = transition(snapshot.state);
      if (!preview.changed) return preview.result;
      const committed = await mutate(
        "reconcileIntegrationDispatches",
        mutationPayload,
        scope,
        (state) => {
          const applied = transition(state);
          return { changes: applied.changes, result: applied.result };
        },
        { explicitMutationId: reconcileMutationId }
      );
      return committed.result;
    },

    async listPendingIntegrationOutboxEvents(inputPayload) {
      const payload = exactPayload(inputPayload, OUTBOX_SCOPE_KEYS, [], "pending outbox payload");
      const scope = scopeFor(payload);
      const snapshot = await loadSnapshot();
      return frozenRecord({
        outboxEvents: ObjectFreeze(arrayMap(
          arrayFilter(snapshot.state.outboxEvents, (record) => sameScope(record, scope) && !record.delivered),
          cloneRecord
        )),
      });
    },

    async markIntegrationOutboxDelivered(inputPayload) {
      const payload = exactPayload(inputPayload, OUTBOX_DELIVERY_KEYS, [], "outbox delivery payload");
      const scope = scopeFor(payload);
      validateIntegrationThreadId(payload.threadId);
      validateIntegrationRunId(payload.runId);
      assertInteger(payload.eventSeq, "delivered event sequence", 1, 10_000_000_001);
      assertSafeIdentifier(payload.outboxId, "outbox id", { minimum: 4, maximum: 128 });
      assertDigest(payload.eventHash, "delivered event hash", { allowZero: false });
      assertDigest(payload.eventDigest, "delivered event digest", { allowZero: false });
      const initial = await loadSnapshot();
      const existing = arrayFind(initial.state.outboxEvents, (record) => record.outboxId === payload.outboxId);
      if (existing?.delivered) {
        if (
          !sameScope(existing, scope) || existing.threadId !== payload.threadId || existing.runId !== payload.runId ||
          existing.deliveredEventSeq !== payload.eventSeq || existing.deliveredEventHash !== payload.eventHash ||
          existing.deliveredEventDigest !== payload.eventDigest
        ) conflict("OUTBOX_CONFLICT", "Outbox delivery receipt changed.");
        return frozenRecord({ delivered: true, outboxId: payload.outboxId });
      }
      const committed = await mutate("markIntegrationOutboxDelivered", payload, scope, (state) => {
        const record = arrayFind(state.outboxEvents, (item) => item.outboxId === payload.outboxId);
        if (
          !record || !sameScope(record, scope) || record.threadId !== payload.threadId || record.runId !== payload.runId ||
          record.expectedEventHash !== payload.eventHash || record.expectedPreviousSeq + 1 !== payload.eventSeq
        ) conflict("OUTBOX_CONFLICT", "Outbox delivery does not match the durable record.");
        const event = createPublicIntegrationEvent({
          threadId: record.threadId,
          runId: record.runId,
          seq: payload.eventSeq,
          type: record.type,
          payload: record.payload,
          createdAt: record.createdAt,
          previousHash: record.expectedPreviousHash,
        });
        if (contractDigest(event) !== payload.eventDigest) conflict("OUTBOX_CONFLICT", "Outbox delivery digest changed.");
        const delivered = frozenRecord({
          ...record,
          delivered: true,
          deliveredEventSeq: payload.eventSeq,
          deliveredEventHash: payload.eventHash,
          deliveredEventDigest: payload.eventDigest,
        });
        return {
          changes: { outboxEvents: replaceById(state.outboxEvents, delivered, "outboxId") },
          result: frozenRecord({ delivered: true, outboxId: payload.outboxId }),
        };
      });
      return committed.result;
    },

    async listIntegrationArtifacts(inputPayload) {
      const payload = exactPayload(inputPayload, LIST_ARTIFACT_KEYS, [], "list artifacts payload");
      const scope = scopeFor(payload);
      if (payload.publishedOnly !== true || NativeBoolean(payload.threadId) === NativeBoolean(payload.runId)) {
        repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Artifact list must select one owner and published records only.", 400);
      }
      if (payload.threadId) validateIntegrationThreadId(payload.threadId);
      if (payload.runId) validateIntegrationRunId(payload.runId);
      const snapshot = await loadSnapshot();
      return frozenRecord({
        artifacts: ObjectFreeze(arrayMap(
          arrayFilter(snapshot.state.artifacts, (artifact) =>
            artifact.published && sameScope(artifact, scope) &&
            findThread(snapshot.state, artifact.threadId, scope) !== null &&
            findRun(snapshot.state, artifact.runId, scope) !== null &&
            (!payload.threadId || artifact.threadId === payload.threadId) &&
            (!payload.runId || artifact.runId === payload.runId)
          ),
          cloneRecord
        )),
      });
    },

    async getIntegrationArtifact(inputPayload) {
      const payload = exactPayload(inputPayload, GET_ARTIFACT_KEYS, [], "get artifact payload");
      const scope = scopeFor(payload);
      const artifactId = validateIntegrationArtifactId(payload.artifactId);
      if (payload.publishedOnly !== true) repositoryFail("INTEGRATION_REPOSITORY_INVALID", "Only published artifacts may be loaded.", 400);
      const snapshot = await loadSnapshot();
      const candidate = arrayFind(
        snapshot.state.artifacts,
        (item) => item.id === artifactId && item.published && sameScope(item, scope)
      ) || null;
      const artifact = candidate &&
        findThread(snapshot.state, candidate.threadId, scope) !== null &&
        findRun(snapshot.state, candidate.runId, scope) !== null
        ? candidate
        : null;
      return frozenRecord({ artifact: cloneRecord(artifact) });
    },

    async stageIntegrationArtifactOutbox(inputPayload) {
      const payload = exactPayload(
        inputPayload,
        STAGE_ARTIFACT_REQUIRED_KEYS,
        STAGE_ARTIFACT_OPTIONAL_KEYS,
        "stage artifact payload"
      );
      const scope = scopeFor(payload);
      validateIntegrationThreadId(payload.threadId);
      validateIntegrationRunId(payload.runId);
      const artifactInput = sanitizeIntegrationArtifact(payload.artifact);
      const artifact = sanitizeIntegrationArtifact({
        ...artifactInput,
        id: ownedArtifactId(artifactInput, scope, payload.threadId, payload.runId),
      });
      let stagedAt = payload.stagedAt === undefined ? "" : assertCanonicalIso(payload.stagedAt, "artifact stagedAt");
      const committed = await mutate("stageIntegrationArtifactOutbox", payload, scope, (state) => {
        if (!stagedAt) stagedAt = nowFrom(options.now);
        const thread = findThread(state, payload.threadId, scope);
        const run = findRun(state, payload.runId, scope);
        if (!thread || !run || run.threadId !== thread.id || !setHas(TERMINAL_STATUSES, run.status)) {
          conflict("ARTIFACT_CONFLICT", "Artifact owner is not a visible terminal run.");
        }
        const existing = arrayFind(state.artifacts, (item) => item.id === artifact.id);
        if (existing) conflict("ARTIFACT_CONFLICT", "Artifact id already exists.");
        if (state.artifacts.length >= INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_ARTIFACTS) {
          conflict("INTEGRATION_REPOSITORY_FULL", "Repository artifact capacity is exhausted.");
        }
        const record = frozenRecord({
          schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_ARTIFACT_VERSION,
          id: artifact.id,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          browserSessionPolicy: scope.browserSessionPolicy,
          threadId: thread.id,
          runId: run.id,
          title: artifact.title,
          kind: artifact.kind,
          spec: artifact.spec,
          revision: 1,
          stagedAt,
          published: false,
          publishedAt: null,
        });
        return {
          changes: { artifacts: sortedById(arrayConcat(state.artifacts, [record])) },
          result: frozenRecord({ artifact: record }),
        };
      });
      return committed.result;
    },

    async publishIntegrationArtifactOutbox(inputPayload) {
      const payload = exactPayload(inputPayload, PUBLISH_ARTIFACT_KEYS, [], "publish artifact payload");
      const scope = scopeFor(payload);
      validateIntegrationThreadId(payload.threadId);
      validateIntegrationRunId(payload.runId);
      validateIntegrationArtifactId(payload.artifactId);
      assertInteger(payload.expectedRevision, "artifact expected revision", 1);
      assertCanonicalIso(payload.publishedAt, "artifact publishedAt");
      const initial = await loadSnapshot();
      const existing = arrayFind(
        initial.state.artifacts,
        (item) => item.id === payload.artifactId && sameScope(item, scope)
      );
      if (existing?.published) {
        if (
          existing.threadId !== payload.threadId || existing.runId !== payload.runId ||
          existing.revision !== payload.expectedRevision + 1 || existing.publishedAt !== payload.publishedAt
        ) conflict("ARTIFACT_CONFLICT", "Artifact publication receipt changed.");
        return frozenRecord({ artifact: cloneRecord(existing) });
      }
      const committed = await mutate("publishIntegrationArtifactOutbox", payload, scope, (state) => {
        const thread = findThread(state, payload.threadId, scope);
        const run = findRun(state, payload.runId, scope);
        const record = arrayFind(
          state.artifacts,
          (item) => item.id === payload.artifactId && sameScope(item, scope)
        );
        if (
          !thread || !run || run.threadId !== thread.id || !setHas(TERMINAL_STATUSES, run.status) ||
          !record || record.threadId !== payload.threadId || record.runId !== payload.runId ||
          record.published || record.revision !== payload.expectedRevision
        ) conflict("ARTIFACT_CONFLICT", "Artifact publication state changed.");
        const published = frozenRecord({
          ...record,
          revision: record.revision + 1,
          published: true,
          publishedAt: payload.publishedAt,
        });
        return {
          changes: { artifacts: replaceById(state.artifacts, published) },
          result: frozenRecord({ artifact: published }),
        };
      });
      return committed.result;
    },
  };

  const surface = ObjectCreate(null);
  ObjectDefineProperty(surface, INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY, {
    configurable: false,
    enumerable: true,
    writable: false,
    value: attestation,
  });
  for (let methodIndex = 0; methodIndex < INTEGRATION_RUNTIME_REPOSITORY_METHODS.length; methodIndex += 1) {
    const methodName = INTEGRATION_RUNTIME_REPOSITORY_METHODS[methodIndex];
    ObjectDefineProperty(surface, methodName, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: methods[methodName],
    });
  }
  ObjectFreeze(surface);
  if (ReflectOwnKeys(surface).length !== INTEGRATION_RUNTIME_REPOSITORY_SURFACE_KEYS.length) {
    repositoryFail("INTEGRATION_REPOSITORY_UNAVAILABLE", "Repository surface inventory is invalid.");
  }
  assertIntegrationRuntimeRepositorySurface(surface, { requireRetainedDescriptorStorage: true });
  weakMapSet(repositoryBrand, surface, { repositoryState, options });
  return surface;
}

export function assertRetainedIntegrationRuntimeRepositorySurface(value) {
  if (!weakMapHas(repositoryBrand, value)) {
    repositoryFail("INTEGRATION_REPOSITORY_UNAVAILABLE", "Repository surface lexical brand is invalid.");
  }
  assertIntegrationRuntimeRepositorySurface(value, { requireRetainedDescriptorStorage: true });
  return value;
}
