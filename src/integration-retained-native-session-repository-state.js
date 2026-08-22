import { types as utilTypes } from "node:util";
import {
  INTEGRATION_EVENT_TYPES,
  createPublicIntegrationEvent,
  validateIntegrationEventPayload,
} from "./integration-events.js";
import {
  MAX_INTEGRATION_PUBLIC_ARTIFACT_BYTES,
  sanitizeIntegrationArtifact,
} from "./integration-artifacts.js";
import {
  INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH,
  INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES,
  INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_VERSION,
  INTEGRATION_RETAINED_REPOSITORY_PAYLOAD_DIGEST_DOMAIN,
  INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_VERSION,
  assertRetainedIntegrationRuntimeRepositoryKernel,
} from "./integration-runtime-repository.js";
import {
  assertRetainedIntegrationSessionStateStore,
} from "./integration-retained-session-state-store.js";
import {
  INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
  authorityFail,
} from "./integration-durable-common.js";
import {
  INTEGRATION_RUN_STATUSES,
  INTEGRATION_THREAD_STATUSES,
  contractDigest,
  validateIntegrationArtifactId,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";
import { redactSensitiveText } from "./redaction.js";

export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_VERSION =
  "aginti-retained-native-session-repository-state-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_ATTESTATION_VERSION =
  "aginti-retained-native-session-repository-state-attestation-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_DOMAIN_VERSION =
  "aginti-retained-native-session-repository-domain-v2";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_SNAPSHOT_VERSION =
  "aginti-retained-native-session-repository-snapshot-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_LAST_MUTATION_VERSION =
  "aginti-retained-native-session-repository-last-mutation-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_THREAD_VERSION =
  "aginti-retained-native-session-repository-thread-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RUN_VERSION =
  "aginti-retained-native-session-repository-run-v2";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_ARTIFACT_VERSION =
  "aginti-retained-native-session-repository-artifact-v2";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MUTATION_RECEIPT_VERSION =
  "aginti-retained-native-session-repository-mutation-receipt-v2";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RETENTION_VERSION =
  "aginti-retained-native-session-repository-retention-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RECONCILIATION_FENCE_VERSION =
  "aginti-retained-native-session-repository-reconciliation-fence-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RETIRED_OWNER_VERSION =
  "aginti-retained-native-session-repository-retired-owner-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_DELIVERY_CHECKPOINT_VERSION =
  "aginti-retained-native-session-repository-delivery-checkpoint-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_DIGEST_DOMAIN =
  "aginti-retained-native-session-repository-state-payload-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_REQUEST_DIGEST_DOMAIN =
  "aginti-retained-native-session-repository-state-request-v1";
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_LAST_MUTATION_DIGEST_DOMAIN =
  "aginti-retained-native-session-repository-state-last-mutation-v1";

export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_THREADS = 10_000;
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RUNS = 50_000;
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_OUTBOX_EVENTS = 100_000;
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_ARTIFACTS = 50_000;
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MUTATION_RECEIPTS = 100_000;
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RETIRED_FENCE_OWNERS = 64;
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MIN_REPLAY_RECEIPTS = 8;
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_TARGET_REPLAY_RECEIPTS = 16;
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_REPLAY_RECEIPTS = 24;
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MESSAGES_PER_THREAD = 256;
export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_PUBLIC_ARTIFACT_BYTES =
  MAX_INTEGRATION_PUBLIC_ARTIFACT_BYTES;

const ZERO_DIGEST = "0".repeat(64);
const MAX_SEQUENCE = 10_000_000_000;
const MAX_PUBLIC_TEXT = 32_000;
const MAX_PUBLIC_MESSAGE_TEXT_TOTAL = 256_000;
const EVENT_TYPE_SET = new Set(INTEGRATION_EVENT_TYPES);
const OUTBOX_EVENT_TYPE_SET = new Set([
  "output.delta",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);
const THREAD_STATUS_SET = new Set(INTEGRATION_THREAD_STATUSES);
const RUN_STATUS_SET = new Set([...INTEGRATION_RUN_STATUSES, "aborted_before_launch"]);
const ACTIVE_RUN_STATUS_SET = new Set(["starting", "running"]);
const TERMINAL_RUN_STATUS_SET = new Set(["completed", "failed", "cancelled"]);
const PUBLIC_ERROR_CODE_SET = new Set([
  "AGINTI_RUNTIME_ERROR",
  "CANCELLED",
  "PROVIDER_PREFLIGHT_FAILED",
  "MODEL_TIMEOUT",
  "MAX_STEPS",
  "SESSION_RUNTIME_TAKEOVER_BLOCKED",
]);
const NATIVE_START_AUTHORIZATION_VERSION = "aginti-native-start-authorization-v1";
const NATIVE_START_RECOVERY_STATE_VERSION = "aginti-native-start-recovery-v1";
const COMPLETION_OUTBOX_METADATA_VERSION = "aginti-completion-outbox-bundle-v2";

export const INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_LIMITATIONS = Object.freeze(
  Object.assign(Object.create(null), {
    preEnableDomainState: true,
    runtimeCapabilityEnabled: false,
    runtimeWiringIncluded: false,
    runtimeRepositorySurface: false,
    runtimeRepositoryAttestation: false,
    runtimeRepositoryMethodSurface: false,
    runtimeRepositoryMethodPayloadSchemasIncluded: false,
    runtimeRepositoryMethodResultSchemasIncluded: false,
    repositoryTransitionsIncluded: false,
    artifactSemanticsIncluded: false,
    artifactStagePublish: false,
    recoverySemanticsIncluded: false,
    eventLedgerIntegration: false,
    eventLedgerAtomicity: false,
    eventDeliveryIncluded: false,
    sessionStateStoreIntegration: false,
    sessionStateReadIntegration: false,
    sessionStateStoreMutation: false,
    sessionStateStoreAtomicity: false,
    sessionStateRecoveryIntegration: false,
    idempotencyStoreIntegration: false,
    legacyFileIdempotencyStoreIntegration: false,
    apiIdempotencyStoreIntegration: false,
    idempotencySemanticsIncluded: false,
    crossStoreAtomicity: false,
    sameKernelHostRequired: true,
    crossHostExclusion: false,
    localFilesystemRequired: true,
    localFilesystemVerified: false,
    networkFilesystemSafety: false,
    fencingTokens: false,
    fullSessionStoreSchemaValidation: false,
    artifactBinaryStorage: false,
    artifactPathStorage: false,
    publicArtifactSchemaValidationOnly: true,
    exactDomainStateSchema: true,
    exactThreadRecordSchema: true,
    exactRunRecordSchema: true,
    exactOutboxRecordSchema: true,
    exactPublicArtifactRecordSchema: true,
    exactMutationReceiptSchema: true,
    exactRetentionCheckpointSchema: true,
    exactReconciliationFenceSchema: true,
    compactedDeliveryCheckpointSchema: true,
    snapshotLocalValidationOnly: true,
    historicalTransitionValidation: false,
    immutableMappingHistoryValidation: false,
    receiptHistoryValidation: false,
    longLivedMutationReplay: false,
    longLivedReceiptRetention: false,
    lastCommitReplayOnly: true,
    mutationReceiptSchemaIncluded: true,
    mutationReceiptReplay: false,
    stableRepositoryPointerBinding: true,
    stableSessionStateNamespaceBinding: true,
    sameRetainedRootRequired: true,
    distinctRetainedDirectoriesRequired: true,
    oneRepositoryKernelSnapshot: true,
    generationMatchesKernelRevision: true,
    generationAdvancesExactlyOnePerCas: true,
    oneWrapperSynchronousDomainNormalizationMayBeAdditional: true,
    wrapperNormalizationByteBoundIsAttestedMaxSnapshotBytes: true,
    inputOwnKeyEnumerationTransientMemoryBounded: false,
    persistedDomainSemanticCorruptionPoisonsWrapper: true,
    poisoningAggregatedAcrossWrappers: false,
    freshWrapperDomainHistoryDetection: false,
    wrapperOperationQueue: false,
    underlyingKernelQueueInherited: true,
    wrapperErrorNamespace: false,
    underlyingKernelErrorNamespaceInherited: true,
    exclusiveKernelOwnership: false,
    underlyingKernelBypassPrevented: false,
    multipleWrappersPerKernelPossible: true,
    storageLifecycleOwned: false,
    callerMustCloseOwningAuthorities: true,
    deleteMethods: false,
    prune: false,
    migration: false,
    listPagination: false,
    runtimeRootsIncluded: false,
    maxJsonDepth: INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH,
    maxJsonNodes: INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES,
    maxThreads: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_THREADS,
    maxRuns: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RUNS,
    maxOutboxEvents: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_OUTBOX_EVENTS,
    maxArtifacts: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_ARTIFACTS,
    maxMutationReceipts: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MUTATION_RECEIPTS,
    maxMessagesPerThread: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MESSAGES_PER_THREAD,
    maxPublicArtifactBytes:
      INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_PUBLIC_ARTIFACT_BYTES,
  })
);

const EXPECTED_KEYS = Object.freeze(["repositoryKernel", "sessionStateStore"]);
const REPOSITORY_EXPECTED_KEYS = Object.freeze([
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
const SESSION_EXPECTED_KEYS = Object.freeze([
  "role",
  "canonicalPath",
  "rootIdentityDigest",
  "relativeSegments",
  "directoryIdentityDigest",
  "lockFileIdentityDigest",
  "helperSha256",
  "helperIdentityDigest",
  "maxStateBytes",
  "lockWaitMs",
]);
const SURFACE_KEYS = Object.freeze([
  "schemaVersion",
  "attestation",
  "loadDomainSnapshot",
  "compareAndSwapDomainSnapshot",
  "isClosed",
]);
const CAS_INPUT_KEYS = Object.freeze([
  "mutationId",
  "expectedSnapshotRevision",
  "expectedIntegrityDigest",
  "state",
]);
const DOMAIN_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "repositoryPointerDigest",
  "sessionStateNamespaceDigest",
  "generation",
  "threads",
  "runs",
  "outboxEvents",
  "artifacts",
  "mutationReceipts",
  "retention",
  "reconciliationFence",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "snapshotRevision",
  "previousIntegrityDigest",
  "state",
  "stateDigest",
  "lastMutation",
  "integrityDigest",
]);
const LAST_MUTATION_KEYS = Object.freeze([
  "schemaVersion",
  "mutationId",
  "requestDigest",
  "baseSnapshotRevision",
  "baseIntegrityDigest",
  "resultSnapshotRevision",
  "stateDigest",
  "mutationDigest",
]);
const KERNEL_SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion", "owner", "authority", "pointerDigest", "snapshotRevision",
  "previousIntegrityDigest", "payload", "payloadDigest", "lastCommit", "integrityDigest",
]);
const KERNEL_LAST_COMMIT_KEYS = Object.freeze([
  "schemaVersion", "transactionId", "requestDigest", "baseSnapshotRevision",
  "baseIntegrityDigest", "resultSnapshotRevision", "payloadDigest", "commitDigest",
]);
const KERNEL_CAS_RESULT_KEYS = Object.freeze(["outcome", "snapshot"]);
const THREAD_KEYS = Object.freeze([
  "schemaVersion", "id", "nativeSessionId", "principalId", "browserSessionId",
  "browserSessionPolicy", "title", "status", "revision", "createdAt", "updatedAt",
  "deletedAt", "tombstone", "lastRunId", "authority", "replay", "messages",
]);
const THREAD_AUTHORITY_KEYS = Object.freeze([
  "kind", "mapped", "runtimeRevision", "contextDigest", "lastCompaction",
]);
const THREAD_REPLAY_KEYS = Object.freeze(["prunedMessageCount", "anchorDigest"]);
const THREAD_MESSAGE_KEYS = Object.freeze(["id", "role", "content", "runId", "createdAt", "digest"]);
const LAST_COMPACTION_KEYS = Object.freeze(["compactedMessages", "tokensBefore", "tokensAfter", "digest"]);
const RUN_KEYS = Object.freeze([
  "schemaVersion", "id", "threadId", "nativeSessionId", "principalId", "browserSessionId",
  "browserSessionPolicy", "previousRunId", "status", "revision", "createdAt", "startedAt",
  "completedAt", "cancelRequestedAt", "dispatchLeaseId", "dispatchOutbox", "dispatchedAt",
  "processOwner", "hidden", "tombstone", "abortAttemptDigest", "abortAt",
  "tombstoneSnapshotRevision",
  "nativeStartReceipt", "recoveryState", "inputDigest", "output", "error", "authority",
]);
const RUN_AUTHORITY_KEYS = Object.freeze([
  "kind", "snapshotHash", "runtimeRevision", "contextDigest", "completionOutbox",
]);
const PROCESS_OWNER_KEYS = Object.freeze([
  "schemaVersion", "pid", "token", "processIdentity", "acquiredAt", "heartbeatAt",
]);
const PROCESS_IDENTITY_KEYS = Object.freeze(["schemaVersion", "bootId", "startTimeTicks"]);
const RUN_ERROR_KEYS = Object.freeze(["code", "message"]);
const NATIVE_START_RECEIPT_KEYS = Object.freeze([
  "schemaVersion", "mode", "principalId", "browserSessionId", "browserSessionPolicy",
  "threadId", "runId", "nativeSessionId", "previousRunId", "previousRunRevision",
  "previousRunRuntimeRevision", "threadRevision", "threadPreservationDigest", "createdAt",
  "startedAt", "expectedNativeRuntimeRevision", "targetNativeRuntimeRevision",
  "expectedRunRevision", "targetRunRevision", "dispatchLeaseId", "dispatchOutbox",
  "dispatchedAt", "processOwner", "authorizedAt", "authorizationId", "authorizationDigest",
]);
const RECOVERY_STATE_KEYS = Object.freeze([
  "schemaVersion", "status", "reason", "authorizationId", "authorizationDigest",
  "sourceRunRevision", "appliedRunRevision", "heldAt", "observedByProcessOwner", "digest",
]);
const COMPLETION_OUTBOX_KEYS = Object.freeze([
  "schemaVersion", "principalId", "browserSessionId", "browserSessionPolicy", "threadId",
  "runId", "status", "completedAt", "runtimeRevision", "completionRevision",
  "threadRevision", "originalCursor", "outboxIds", "eventTypes", "eventHashes",
  "orderedBundleDigest", "deliveryCheckpoint",
]);
const COMPLETION_CURSOR_KEYS = Object.freeze(["firstSeq", "lastSeq", "lastHash", "prunedThroughSeq"]);
const OUTBOX_KEYS = Object.freeze([
  "outboxId", "principalId", "browserSessionId", "browserSessionPolicy", "threadId", "runId",
  "type", "payload", "createdAt", "expectedPreviousSeq", "expectedPreviousHash",
  "expectedEventHash", "delivered", "deliveredEventSeq", "deliveredEventHash",
  "deliveredEventDigest", "deliveredAt",
]);
const ARTIFACT_KEYS = Object.freeze([
  "schemaVersion", "id", "principalId", "browserSessionId", "browserSessionPolicy",
  "threadId", "runId", "title", "kind", "spec", "revision", "stagedAt",
  "retainedAtSnapshotRevision", "published", "publishedAt",
]);
const MUTATION_RECEIPT_KEYS = Object.freeze([
  "schemaVersion", "mutationId", "operation", "principalId", "browserSessionId",
  "browserSessionPolicy", "requestDigest", "baseSnapshotRevision", "baseIntegrityDigest",
  "resultSnapshotRevision", "resultDigest", "result", "mutationTimestamp", "committedAt",
]);
const RETENTION_KEYS = Object.freeze([
  "schemaVersion", "policyVersion", "minimumReplayReceipts", "targetReplayReceipts",
  "maximumReplayReceipts", "exactReplayFloorSnapshotRevision", "replayCutoffAt",
  "compactionGeneration", "lastCompactedAt", "lastCompactedSnapshotRevision",
  "prunedMutationReceiptCount", "prunedMutationReceiptDigest",
  "compactedOutboxEventCount", "compactedOutboxEventDigest",
  "prunedRunTombstoneCount", "prunedRunTombstoneDigest",
  "prunedArtifactCount", "prunedArtifactDigest",
]);
const RECONCILIATION_FENCE_KEYS = Object.freeze([
  "schemaVersion", "generation", "owner", "ownerDigest", "ownerIdentityDigest", "issuedAt",
  "previousFenceDigest", "retiredOwners", "digest",
]);
const RETIRED_FENCE_OWNER_KEYS = Object.freeze([
  "schemaVersion", "owner", "ownerDigest", "processIdentityDigest", "retiredAtGeneration",
  "retiredAt", "reason",
]);
const DELIVERY_CHECKPOINT_KEYS = Object.freeze([
  "schemaVersion", "compactedAt", "compactedAtSnapshotRevision", "deliveries", "digest",
]);
const DELIVERY_CHECKPOINT_ENTRY_KEYS = Object.freeze([
  "outboxId", "type", "payloadDigest", "createdAt", "expectedPreviousSeq",
  "expectedPreviousHash", "expectedEventHash", "eventSeq", "eventHash", "eventDigest", "deliveredAt",
]);
const ATTESTATION_KEYS = Object.freeze([
  "schemaVersion", "owner", "authority", "preEnableDomainState", "runtimeCapabilityEnabled",
  "runtimeWiringIncluded", "runtimeRepositorySurface", "runtimeRepositoryAttestation",
  "runtimeRepositoryMethodSurface", "runtimeRepositoryMethodPayloadSchemasIncluded",
  "runtimeRepositoryMethodResultSchemasIncluded", "repositoryTransitionsIncluded",
  "artifactSemanticsIncluded", "artifactStagePublish", "recoverySemanticsIncluded",
  "eventLedgerIntegration",
  "eventLedgerAtomicity", "eventDeliveryIncluded", "sessionStateStoreIntegration",
  "sessionStateReadIntegration", "sessionStateStoreMutation", "sessionStateStoreAtomicity",
  "sessionStateRecoveryIntegration", "idempotencyStoreIntegration",
  "legacyFileIdempotencyStoreIntegration", "apiIdempotencyStoreIntegration",
  "idempotencySemanticsIncluded", "crossStoreAtomicity", "sameKernelHostRequired",
  "crossHostExclusion", "localFilesystemRequired", "localFilesystemVerified",
  "networkFilesystemSafety", "fencingTokens", "canonicalDomainValidation",
  "exactDomainStateSchema", "exactThreadRecordSchema", "exactRunRecordSchema", "exactOutboxRecordSchema",
  "exactPublicArtifactRecordSchema", "exactMutationReceiptSchema", "snapshotLocalValidationOnly",
  "stableRepositoryPointerBinding", "stableSessionStateNamespaceBinding", "sameRetainedRootRequired",
  "distinctRetainedDirectoriesRequired", "compareAndSwap", "generationExactlyOne",
  "postWriteKernelValidation", "lastCommitReplayOnly", "mutationReceiptSchemaIncluded",
  "mutationReceiptReplay", "wrapperOperationQueue", "underlyingKernelQueueInherited",
  "wrapperErrorNamespace", "underlyingKernelErrorNamespaceInherited", "runtimeRootsIncluded",
  "exclusiveKernelOwnership", "underlyingKernelBypassPrevented", "storageLifecycleOwned",
  "repositoryPointerDigest",
  "sessionStateNamespaceDigest", "admissionBindingDigest", "maxSnapshotBytes", "maxJsonDepth",
  "maxJsonNodes", "maxThreads", "maxRuns", "maxOutboxEvents", "maxArtifacts",
  "maxMutationReceipts", "maxMessagesPerThread", "maxPublicArtifactBytes", "limitations", "digest",
]);

const NativePromise = Promise;
const PromiseThen = Promise.prototype.then;
const FunctionPrototypeCall = Function.prototype.call;
const ObjectPrototypeHasOwn = Object.prototype.hasOwnProperty;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectIsFrozen = Object.isFrozen;
const ReflectApply = Reflect.apply;
const ReflectDefineProperty = Reflect.defineProperty;
const ArrayFilter = Array.prototype.filter;
const ArrayMap = Array.prototype.map;
const ArrayIncludes = Array.prototype.includes;
const ArraySome = Array.prototype.some;
const JsonStringify = JSON.stringify;
const StringIncludes = String.prototype.includes;
const StringSlice = String.prototype.slice;
const StringTrim = String.prototype.trim;
const SymbolSpecies = Symbol.species;
const NativePromiseSpeciesDescriptor = ObjectGetOwnPropertyDescriptor(NativePromise, SymbolSpecies);
const NativePromiseSpeciesGetter = NativePromiseSpeciesDescriptor?.get;
const NativePromiseSpeciesSetter = NativePromiseSpeciesDescriptor?.set;
const SafePromiseConstructor = Object.create(null);
Object.defineProperty(SafePromiseConstructor, SymbolSpecies, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: NativePromise,
});
Object.freeze(SafePromiseConstructor);

const repositoryStateBrand = new WeakMap();

function stateFail(code, message, { status = 503 } = {}) {
  authorityFail(code, message, { status, details: Object.freeze(Object.create(null)) });
}

function statusForCode(code) {
  if (code === "INTEGRATION_REPOSITORY_KERNEL_INVALID") return 400;
  if (code === "INTEGRATION_REPOSITORY_KERNEL_FULL" || code === "INTEGRATION_REPOSITORY_KERNEL_CONFLICT") return 409;
  if (code === "INTEGRATION_REPOSITORY_KERNEL_BUSY") return 429;
  return 503;
}

function hasOwn(value, key) {
  return ReflectApply(FunctionPrototypeCall, ObjectPrototypeHasOwn, [value, key]);
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

function rejectPromiseValue(value, label, code = "INTEGRATION_REPOSITORY_KERNEL_INVALID") {
  if (!isPromiseValue(value)) return false;
  if (promiseCanBeSafelyObserved(value)) {
    ReflectApply(PromiseThen, value, [undefined, () => undefined]);
  }
  stateFail(code, `${label} must be synchronous plain data.`, { status: statusForCode(code) });
}

function exactDataObject(value, keys, label, code = "INTEGRATION_REPOSITORY_KERNEL_INVALID") {
  if (value && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value)) {
    stateFail(code, `${label} must not be a Proxy.`, { status: statusForCode(code) });
  }
  rejectPromiseValue(value, label, code);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    stateFail(code, `${label} must be a plain data object.`, { status: statusForCode(code) });
  }
  const prototype = ObjectGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    stateFail(code, `${label} prototype is invalid.`, { status: statusForCode(code) });
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ReflectApply(ArraySome, ownKeys, [(key) => typeof key !== "string" || !ReflectApply(ArrayIncludes, keys, [key])])
  ) {
    stateFail(code, `${label} must contain exact fields.`, { status: statusForCode(code) });
  }
  const clone = Object.create(null);
  for (const key of keys) {
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, "value")) {
      stateFail(code, `${label}.${key} must be an enumerable data field.`, { status: statusForCode(code) });
    }
    Object.defineProperty(clone, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value,
    });
  }
  return Object.freeze(clone);
}

function exactFrozenNullPrototypeObject(
  value,
  keys,
  label,
  code = "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE"
) {
  if (
    !value || typeof value !== "object" || utilTypes.isProxy(value) ||
    !ReflectApply(ObjectIsFrozen, Object, [value]) || ObjectGetPrototypeOf(value) !== null
  ) {
    stateFail(code, `${label} must be an exact frozen lexical object.`, {
      status: statusForCode(code),
    });
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ReflectApply(ArraySome, ownKeys, [
      (key) => typeof key !== "string" || !ReflectApply(ArrayIncludes, keys, [key]),
    ])
  ) {
    stateFail(code, `${label} fields are invalid.`, { status: statusForCode(code) });
  }
  for (const key of ownKeys) {
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (
      !descriptor || !descriptor.enumerable || descriptor.configurable || descriptor.writable ||
      !hasOwn(descriptor, "value")
    ) {
      stateFail(code, `${label} fields must be immutable data.`, { status: statusForCode(code) });
    }
  }
  return value;
}

function structuralFailure(code, label) {
  stateFail(code, `${label} exceeds retained repository-state structural bounds.`, {
    status: statusForCode(code),
  });
}

function addCanonicalBytes(state, amount, label) {
  if (!state.byteLimit) return;
  state.bytes = (state.bytes || 0) + amount;
  if (state.bytes > state.byteLimit) structuralFailure(state.overflowCode, label);
}

function addCanonicalStringBytes(state, value, label) {
  if (!state.byteLimit) return;
  addCanonicalBytes(state, 2, label);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 ||
      code === 0x0a || code === 0x0c || code === 0x0d
    ) {
      addCanonicalBytes(state, 2, label);
    } else if (
      code <= 0x1f ||
      (code >= 0xd800 && code <= 0xdfff && !(
        code <= 0xdbff && index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff
      ))
    ) {
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
  state.overflowCode ||= "INTEGRATION_REPOSITORY_KERNEL_FULL";
  state.shapeCode ||= "INTEGRATION_REPOSITORY_KERNEL_INVALID";
  if (
    state.nodes > INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES ||
    depth > INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH
  ) structuralFailure(state.overflowCode, label);
  if (value === null) {
    addCanonicalBytes(state, 4, label);
    return null;
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
      stateFail(state.shapeCode, `${label} contains a non-canonical number.`, {
        status: statusForCode(state.shapeCode),
      });
    }
    addCanonicalBytes(state, Buffer.byteLength(ReflectApply(JsonStringify, JSON, [value]), "utf8"), label);
    return value;
  }
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) {
    stateFail(state.shapeCode, `${label} must contain only trap-safe JSON data.`, {
      status: statusForCode(state.shapeCode),
    });
  }
  rejectPromiseValue(value, label, state.shapeCode);
  state.active ||= new WeakSet();
  if (state.active.has(value)) {
    stateFail(state.shapeCode, `${label} must not contain cycles.`, { status: statusForCode(state.shapeCode) });
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (ObjectGetPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(value.length)) {
        stateFail(state.shapeCode, `${label} array shape is invalid.`, { status: statusForCode(state.shapeCode) });
      }
      if (value.length > INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES - state.nodes) {
        structuralFailure(state.overflowCode, label);
      }
      addCanonicalBytes(state, 2 + Math.max(0, value.length - 1), label);
      const keys = Reflect.ownKeys(value);
      const indexKeys = ReflectApply(ArrayFilter, keys, [(key) => key !== "length"]);
      if (
        indexKeys.length !== value.length ||
        ReflectApply(ArraySome, indexKeys, [(key) => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)])
      ) {
        stateFail(state.shapeCode, `${label} array must be dense data.`, { status: statusForCode(state.shapeCode) });
      }
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = ObjectGetOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, "value")) {
          stateFail(state.shapeCode, `${label} entries must be enumerable data.`, {
            status: statusForCode(state.shapeCode),
          });
        }
        clone[index] = cloneCanonicalJson(descriptor.value, `${label}[${index}]`, state, depth + 1);
      }
      return Object.freeze(clone);
    }
    const prototype = ObjectGetPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      stateFail(state.shapeCode, `${label} object prototype is invalid.`, { status: statusForCode(state.shapeCode) });
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES - state.nodes) {
      structuralFailure(state.overflowCode, label);
    }
    if (ReflectApply(ArraySome, keys, [(key) => typeof key !== "string"])) {
      stateFail(state.shapeCode, `${label} must not contain symbols.`, { status: statusForCode(state.shapeCode) });
    }
    const clone = Object.create(null);
    addCanonicalBytes(state, 2 + Math.max(0, keys.length - 1), label);
    for (const key of keys) {
      const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, "value")) {
        stateFail(state.shapeCode, `${label}.${key} must be enumerable data.`, {
          status: statusForCode(state.shapeCode),
        });
      }
      addCanonicalStringBytes(state, key, label);
      addCanonicalBytes(state, 1, label);
      Object.defineProperty(clone, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: cloneCanonicalJson(descriptor.value, `${label}.${key}`, state, depth + 1),
      });
    }
    return Object.freeze(clone);
  } finally {
    state.active.delete(value);
  }
}

function frozenRecord(value) {
  return Object.freeze(Object.assign(Object.create(null), value));
}

function assertDigest(value, label, code = "INTEGRATION_REPOSITORY_KERNEL_INVALID", { allowZero = true } = {}) {
  rejectPromiseValue(value, label, code);
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value) ||
    (!allowZero && value === ZERO_DIGEST)
  ) {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
  return value;
}

function assertInteger(value, label, {
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
  code = "INTEGRATION_REPOSITORY_KERNEL_INVALID",
} = {}) {
  rejectPromiseValue(value, label, code);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
  return value;
}

function assertCanonicalIso(value, label, code = "INTEGRATION_REPOSITORY_KERNEL_INVALID") {
  rejectPromiseValue(value, label, code);
  let canonical = "";
  if (typeof value === "string" && value.length >= 20 && value.length <= 40) {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) canonical = new Date(milliseconds).toISOString();
  }
  if (canonical !== value) {
    stateFail(code, `${label} must be a canonical UTC timestamp.`, { status: statusForCode(code) });
  }
  return value;
}

function assertOptionalIso(value, label, code) {
  return value === null ? null : assertCanonicalIso(value, label, code);
}

function assertPrincipalId(value, label, code) {
  rejectPromiseValue(value, label, code);
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/u.test(value)) {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
  return value;
}

function assertBrowserSessionId(value, label, code) {
  rejectPromiseValue(value, label, code);
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
  return value;
}

function assertBrowserPolicy(value, label, code) {
  if (value !== "same-browser-session") {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
  return value;
}

function assertNativeSessionId(value, label, code) {
  rejectPromiseValue(value, label, code);
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value) ||
    ReflectApply(StringIncludes, value, [".."])
  ) {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
  return value;
}

function assertMutationId(value, label, code = "INTEGRATION_REPOSITORY_KERNEL_INVALID") {
  rejectPromiseValue(value, label, code);
  if (
    typeof value !== "string" || value.length < 16 || value.length > 160 ||
    !/^[A-Za-z0-9._~-]+$/u.test(value) || ReflectApply(StringIncludes, value, [".."])
  ) {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
  return value;
}

function assertSafeIdentifier(value, label, code, { minimum = 1, maximum = 128 } = {}) {
  rejectPromiseValue(value, label, code);
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum ||
    !/^[A-Za-z0-9._:-]+$/u.test(value) || ReflectApply(StringIncludes, value, [".."])
  ) {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
  return value;
}

const PRIVATE_RUNTIME_PATTERN =
  /(?:^|[\s("'`])(?:\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/|\b)|[A-Za-z]:\\)|(?:api[_-]?key|token|secret|password)\s*[:=]/iu;

function assertPublicText(value, label, maximum, code, {
  minimum = 0,
  trim = false,
  presentational = false,
} = {}) {
  rejectPromiseValue(value, label, code);
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum ||
    /\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    redactSensitiveText(value) !== value || PRIVATE_RUNTIME_PATTERN.test(value) ||
    (presentational && (
      /[<>]/u.test(value) || /(?:javascript\s*:|(?:https?|data|file)\s*:\/\/)/iu.test(value)
    )) ||
    (trim && ReflectApply(StringTrim, value, []) !== value)
  ) {
    stateFail(code, `${label} is not bounded public text.`, { status: statusForCode(code) });
  }
  return value;
}

function validateThreadId(value, label, code) {
  try {
    return validateIntegrationThreadId(value);
  } catch {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
}

function validateRunId(value, label, code) {
  try {
    return validateIntegrationRunId(value);
  } catch {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
}

function validateArtifactId(value, label, code) {
  try {
    return validateIntegrationArtifactId(value);
  } catch {
    stateFail(code, `${label} is invalid.`, { status: statusForCode(code) });
  }
}

function assertBoolean(value, label, code) {
  if (typeof value !== "boolean") {
    stateFail(code, `${label} must be boolean.`, { status: statusForCode(code) });
  }
  return value;
}

function sameScope(left, right) {
  return left.principalId === right.principalId &&
    left.browserSessionId === right.browserSessionId &&
    left.browserSessionPolicy === right.browserSessionPolicy;
}

function compareTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function assertSortedUnique(records, keyFor, label, code) {
  let previous = null;
  for (let index = 0; index < records.length; index += 1) {
    const key = keyFor(records[index]);
    if (!Array.isArray(key) || ReflectApply(ArraySome, key, [(part) => typeof part !== "string"])) {
      stateFail(code, `${label} sort key is invalid.`, { status: statusForCode(code) });
    }
    if (previous !== null && compareTuple(previous, key) >= 0) {
      stateFail(code, `${label} must be strictly sorted and unique.`, { status: statusForCode(code) });
    }
    previous = key;
  }
  return records;
}

function validateProcessOwner(value, label, code) {
  const owner = exactDataObject(value, PROCESS_OWNER_KEYS, `${label} process owner`, code);
  if (owner.schemaVersion !== "aginti-process-owner-v1") {
    stateFail(code, `${label} process owner schema is invalid.`, { status: statusForCode(code) });
  }
  assertInteger(owner.pid, `${label} process owner pid`, { minimum: 1, code });
  if (typeof owner.token !== "string" || !/^[a-f0-9]{32}$/u.test(owner.token)) {
    stateFail(code, `${label} process owner token is invalid.`, { status: statusForCode(code) });
  }
  const identity = exactDataObject(
    owner.processIdentity,
    PROCESS_IDENTITY_KEYS,
    `${label} process identity`,
    code
  );
  if (
    identity.schemaVersion !== "aginti-process-identity-v1" ||
    typeof identity.bootId !== "string" || !/^[a-f0-9-]{16,80}$/u.test(identity.bootId) ||
    typeof identity.startTimeTicks !== "string" || !/^[0-9]{1,32}$/u.test(identity.startTimeTicks)
  ) {
    stateFail(code, `${label} process identity is invalid.`, { status: statusForCode(code) });
  }
  assertCanonicalIso(owner.acquiredAt, `${label} process owner acquiredAt`, code);
  assertCanonicalIso(owner.heartbeatAt, `${label} process owner heartbeatAt`, code);
  if (owner.heartbeatAt < owner.acquiredAt) {
    stateFail(code, `${label} process owner timestamps are inconsistent.`, { status: statusForCode(code) });
  }
  return owner;
}

function digestWithoutKeys(value, omittedKeys) {
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (!omittedKeys.has(key)) result[key] = value[key];
  }
  return result;
}

function validateNativeStartReceipt(value, label, code) {
  const receipt = exactDataObject(value, NATIVE_START_RECEIPT_KEYS, label, code);
  if (receipt.schemaVersion !== NATIVE_START_AUTHORIZATION_VERSION) {
    stateFail(code, `${label} schema is invalid.`, { status: statusForCode(code) });
  }
  if (receipt.mode !== "start" && receipt.mode !== "resume") {
    stateFail(code, `${label} mode is invalid.`, { status: statusForCode(code) });
  }
  assertPrincipalId(receipt.principalId, `${label} principalId`, code);
  assertBrowserSessionId(receipt.browserSessionId, `${label} browserSessionId`, code);
  assertBrowserPolicy(receipt.browserSessionPolicy, `${label} browserSessionPolicy`, code);
  validateThreadId(receipt.threadId, `${label} threadId`, code);
  validateRunId(receipt.runId, `${label} runId`, code);
  assertNativeSessionId(receipt.nativeSessionId, `${label} nativeSessionId`, code);
  if (receipt.mode === "start") {
    if (
      receipt.previousRunId !== null || receipt.previousRunRevision !== null ||
      receipt.previousRunRuntimeRevision !== null
    ) {
      stateFail(code, `${label} start lineage is invalid.`, { status: statusForCode(code) });
    }
  } else {
    validateRunId(receipt.previousRunId, `${label} previousRunId`, code);
    assertInteger(receipt.previousRunRevision, `${label} previousRunRevision`, { minimum: 1, code });
    assertInteger(receipt.previousRunRuntimeRevision, `${label} previousRunRuntimeRevision`, {
      minimum: 1,
      code,
    });
  }
  assertInteger(receipt.threadRevision, `${label} threadRevision`, { minimum: 1, code });
  assertDigest(receipt.threadPreservationDigest, `${label} threadPreservationDigest`, code, { allowZero: false });
  assertCanonicalIso(receipt.createdAt, `${label} createdAt`, code);
  assertCanonicalIso(receipt.startedAt, `${label} startedAt`, code);
  if (receipt.startedAt !== receipt.createdAt) {
    stateFail(code, `${label} start timestamps are inconsistent.`, { status: statusForCode(code) });
  }
  const expectedRuntime = assertInteger(
    receipt.expectedNativeRuntimeRevision,
    `${label} expectedNativeRuntimeRevision`,
    { minimum: 1, code }
  );
  const targetRuntime = assertInteger(
    receipt.targetNativeRuntimeRevision,
    `${label} targetNativeRuntimeRevision`,
    { minimum: 1, code }
  );
  if (
    (receipt.mode === "start" && targetRuntime !== expectedRuntime) ||
    (receipt.mode === "resume" && (
      targetRuntime !== expectedRuntime + 1 || receipt.previousRunRuntimeRevision !== expectedRuntime
    ))
  ) {
    stateFail(code, `${label} runtime revision binding is invalid.`, { status: statusForCode(code) });
  }
  if (
    assertInteger(receipt.expectedRunRevision, `${label} expectedRunRevision`, { minimum: 1, code }) !== 2 ||
    assertInteger(receipt.targetRunRevision, `${label} targetRunRevision`, { minimum: 1, code }) !== 3
  ) {
    stateFail(code, `${label} run revision binding is invalid.`, { status: statusForCode(code) });
  }
  assertDigest(receipt.dispatchLeaseId, `${label} dispatchLeaseId`, code, { allowZero: false });
  if (receipt.dispatchOutbox !== true) {
    stateFail(code, `${label} dispatchOutbox is invalid.`, { status: statusForCode(code) });
  }
  assertCanonicalIso(receipt.dispatchedAt, `${label} dispatchedAt`, code);
  validateProcessOwner(receipt.processOwner, label, code);
  assertCanonicalIso(receipt.authorizedAt, `${label} authorizedAt`, code);
  if (receipt.authorizedAt !== receipt.dispatchedAt) {
    stateFail(code, `${label} authorization timestamp is invalid.`, { status: statusForCode(code) });
  }
  assertDigest(receipt.authorizationDigest, `${label} authorizationDigest`, code, { allowZero: false });
  const digest = contractDigest(digestWithoutKeys(receipt, new Set(["authorizationId", "authorizationDigest"])));
  if (
    receipt.authorizationDigest !== digest ||
    receipt.authorizationId !== `nstart_${ReflectApply(StringSlice, digest, [0, 48])}`
  ) {
    stateFail(code, `${label} integrity binding is invalid.`, { status: statusForCode(code) });
  }
  return receipt;
}

function validateRecoveryState(value, label, code) {
  const recovery = exactDataObject(value, RECOVERY_STATE_KEYS, label, code);
  if (
    recovery.schemaVersion !== NATIVE_START_RECOVERY_STATE_VERSION ||
    recovery.status !== "recovery_hold" ||
    recovery.reason !== "retained_descriptor_unavailable" ||
    typeof recovery.authorizationId !== "string" ||
    !/^nstart_[a-f0-9]{48}$/u.test(recovery.authorizationId)
  ) {
    stateFail(code, `${label} authority fields are invalid.`, { status: statusForCode(code) });
  }
  assertDigest(recovery.authorizationDigest, `${label} authorizationDigest`, code, { allowZero: false });
  const sourceRevision = assertInteger(recovery.sourceRunRevision, `${label} sourceRunRevision`, {
    minimum: 1,
    code,
  });
  if (
    assertInteger(recovery.appliedRunRevision, `${label} appliedRunRevision`, { minimum: 1, code }) !==
    sourceRevision + 1
  ) {
    stateFail(code, `${label} revision binding is invalid.`, { status: statusForCode(code) });
  }
  assertCanonicalIso(recovery.heldAt, `${label} heldAt`, code);
  validateProcessOwner(recovery.observedByProcessOwner, label, code);
  assertDigest(recovery.digest, `${label} digest`, code, { allowZero: false });
  if (recovery.digest !== contractDigest(digestWithoutKeys(recovery, new Set(["digest"])))) {
    stateFail(code, `${label} digest is invalid.`, { status: statusForCode(code) });
  }
  return recovery;
}

function validateCompletionCursor(value, label, code) {
  const cursor = exactDataObject(value, COMPLETION_CURSOR_KEYS, label, code);
  if (
    cursor.firstSeq !== 1 || cursor.prunedThroughSeq !== 0 ||
    !Number.isSafeInteger(cursor.lastSeq) || cursor.lastSeq < 0 || cursor.lastSeq > MAX_SEQUENCE
  ) {
    stateFail(code, `${label} sequence is invalid.`, { status: statusForCode(code) });
  }
  assertDigest(cursor.lastHash, `${label} lastHash`, code);
  if ((cursor.lastSeq === 0) !== (cursor.lastHash === ZERO_DIGEST)) {
    stateFail(code, `${label} zero-hash invariant is invalid.`, { status: statusForCode(code) });
  }
  return cursor;
}

function validateDeliveryCheckpoint(value, completion, generation, label, code) {
  if (value === null) return null;
  const checkpoint = exactDataObject(value, DELIVERY_CHECKPOINT_KEYS, `${label} deliveryCheckpoint`, code);
  if (checkpoint.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_DELIVERY_CHECKPOINT_VERSION) {
    stateFail(code, `${label} delivery checkpoint schema is invalid.`, { status: statusForCode(code) });
  }
  assertCanonicalIso(checkpoint.compactedAt, `${label} delivery checkpoint compactedAt`, code);
  assertInteger(
    checkpoint.compactedAtSnapshotRevision,
    `${label} delivery checkpoint compactedAtSnapshotRevision`,
    { minimum: 1, maximum: generation, code }
  );
  if (!Array.isArray(checkpoint.deliveries) || checkpoint.deliveries.length !== completion.outboxIds.length) {
    stateFail(code, `${label} delivery checkpoint length is invalid.`, { status: statusForCode(code) });
  }
  const deliveries = ReflectApply(ArrayMap, checkpoint.deliveries, [(valueEntry, index) => {
    const entryLabel = `${label} delivery checkpoint[${index}]`;
    const entry = exactDataObject(valueEntry, DELIVERY_CHECKPOINT_ENTRY_KEYS, entryLabel, code);
    assertSafeIdentifier(entry.outboxId, `${entryLabel} outboxId`, code, { minimum: 4, maximum: 128 });
    if (!OUTBOX_EVENT_TYPE_SET.has(entry.type)) {
      stateFail(code, `${entryLabel} type is invalid.`, { status: statusForCode(code) });
    }
    assertDigest(entry.payloadDigest, `${entryLabel} payloadDigest`, code, { allowZero: false });
    assertCanonicalIso(entry.createdAt, `${entryLabel} createdAt`, code);
    assertInteger(entry.expectedPreviousSeq, `${entryLabel} expectedPreviousSeq`, {
      maximum: MAX_SEQUENCE,
      code,
    });
    assertDigest(entry.expectedPreviousHash, `${entryLabel} expectedPreviousHash`, code);
    assertDigest(entry.expectedEventHash, `${entryLabel} expectedEventHash`, code, { allowZero: false });
    assertInteger(entry.eventSeq, `${entryLabel} eventSeq`, { minimum: 1, maximum: MAX_SEQUENCE + 1, code });
    assertDigest(entry.eventHash, `${entryLabel} eventHash`, code, { allowZero: false });
    assertDigest(entry.eventDigest, `${entryLabel} eventDigest`, code, { allowZero: false });
    assertCanonicalIso(entry.deliveredAt, `${entryLabel} deliveredAt`, code);
    if (
      entry.outboxId !== completion.outboxIds[index] ||
      entry.type !== completion.eventTypes[index] ||
      entry.eventSeq !== completion.originalCursor.lastSeq + index + 1 ||
      entry.expectedPreviousSeq !== entry.eventSeq - 1 ||
      entry.expectedEventHash !== completion.eventHashes[index] ||
      entry.eventHash !== entry.expectedEventHash ||
      entry.deliveredAt < completion.completedAt ||
      entry.deliveredAt > checkpoint.compactedAt
    ) {
      stateFail(code, `${entryLabel} binding is invalid.`, { status: statusForCode(code) });
    }
    return entry;
  }]);
  assertDigest(checkpoint.digest, `${label} delivery checkpoint digest`, code, { allowZero: false });
  const { digest: _digest, ...unsigned } = checkpoint;
  if (checkpoint.digest !== contractDigest(unsigned) || deliveries.length !== completion.outboxIds.length) {
    stateFail(code, `${label} delivery checkpoint digest is invalid.`, { status: statusForCode(code) });
  }
  return checkpoint;
}

function validateCompletionOutbox(value, generation, label, code) {
  const completion = exactDataObject(value, COMPLETION_OUTBOX_KEYS, label, code);
  if (completion.schemaVersion !== COMPLETION_OUTBOX_METADATA_VERSION) {
    stateFail(code, `${label} schema is invalid.`, { status: statusForCode(code) });
  }
  assertPrincipalId(completion.principalId, `${label} principalId`, code);
  assertBrowserSessionId(completion.browserSessionId, `${label} browserSessionId`, code);
  assertBrowserPolicy(completion.browserSessionPolicy, `${label} browserSessionPolicy`, code);
  validateThreadId(completion.threadId, `${label} threadId`, code);
  validateRunId(completion.runId, `${label} runId`, code);
  if (!TERMINAL_RUN_STATUS_SET.has(completion.status)) {
    stateFail(code, `${label} status is invalid.`, { status: statusForCode(code) });
  }
  assertCanonicalIso(completion.completedAt, `${label} completedAt`, code);
  for (const field of ["runtimeRevision", "completionRevision", "threadRevision"]) {
    assertInteger(completion[field], `${label} ${field}`, { minimum: 1, code });
  }
  validateCompletionCursor(completion.originalCursor, `${label} originalCursor`, code);
  for (const [field, maximum] of [
    ["outboxIds", 128],
    ["eventTypes", 128],
    ["eventHashes", 128],
  ]) {
    if (!Array.isArray(completion[field]) || completion[field].length < 1 || completion[field].length > maximum) {
      stateFail(code, `${label} ${field} is invalid.`, { status: statusForCode(code) });
    }
  }
  if (
    completion.outboxIds.length !== completion.eventTypes.length ||
    completion.outboxIds.length !== completion.eventHashes.length
  ) {
    stateFail(code, `${label} ordered bundle lengths disagree.`, { status: statusForCode(code) });
  }
  const seenIds = new Set();
  for (let index = 0; index < completion.outboxIds.length; index += 1) {
    const outboxId = assertSafeIdentifier(completion.outboxIds[index], `${label} outboxIds[${index}]`, code, {
      minimum: 4,
      maximum: 128,
    });
    if (seenIds.has(outboxId) || !EVENT_TYPE_SET.has(completion.eventTypes[index])) {
      stateFail(code, `${label} ordered bundle entry is invalid.`, { status: statusForCode(code) });
    }
    seenIds.add(outboxId);
    assertDigest(completion.eventHashes[index], `${label} eventHashes[${index}]`, code, { allowZero: false });
  }
  assertDigest(completion.orderedBundleDigest, `${label} orderedBundleDigest`, code, { allowZero: false });
  validateDeliveryCheckpoint(completion.deliveryCheckpoint, completion, generation, label, code);
  return completion;
}

function validateLastCompaction(value, label, code) {
  if (value === null) return null;
  const compaction = exactDataObject(value, LAST_COMPACTION_KEYS, label, code);
  const compactedMessages = assertInteger(compaction.compactedMessages, `${label} compactedMessages`, {
    minimum: 1,
    maximum: 1_000_000,
    code,
  });
  const tokensBefore = assertInteger(compaction.tokensBefore, `${label} tokensBefore`, {
    maximum: 10_000_000,
    code,
  });
  const tokensAfter = assertInteger(compaction.tokensAfter, `${label} tokensAfter`, {
    maximum: 10_000_000,
    code,
  });
  if (tokensAfter > tokensBefore || compactedMessages < 1) {
    stateFail(code, `${label} counters are inconsistent.`, { status: statusForCode(code) });
  }
  assertDigest(compaction.digest, `${label} digest`, code, { allowZero: false });
  return compaction;
}

function validateThreadMessage(value, index, code) {
  const label = `repository thread message[${index}]`;
  const message = exactDataObject(value, THREAD_MESSAGE_KEYS, label, code);
  if (typeof message.id !== "string" || !/^msg_[A-Za-z0-9_-]{16,96}$/u.test(message.id)) {
    stateFail(code, `${label} id is invalid.`, { status: statusForCode(code) });
  }
  if (message.role !== "user" && message.role !== "assistant") {
    stateFail(code, `${label} role is invalid.`, { status: statusForCode(code) });
  }
  assertPublicText(message.content, `${label} content`, MAX_PUBLIC_TEXT, code);
  validateRunId(message.runId, `${label} runId`, code);
  assertCanonicalIso(message.createdAt, `${label} createdAt`, code);
  assertDigest(message.digest, `${label} digest`, code, { allowZero: false });
  return message;
}

function validateThreadRecord(value, index, code) {
  const label = `repository thread[${index}]`;
  const thread = exactDataObject(value, THREAD_KEYS, label, code);
  if (thread.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_THREAD_VERSION) {
    stateFail(code, `${label} schema is invalid.`, { status: statusForCode(code) });
  }
  validateThreadId(thread.id, `${label} id`, code);
  assertNativeSessionId(thread.nativeSessionId, `${label} nativeSessionId`, code);
  assertPrincipalId(thread.principalId, `${label} principalId`, code);
  assertBrowserSessionId(thread.browserSessionId, `${label} browserSessionId`, code);
  assertBrowserPolicy(thread.browserSessionPolicy, `${label} browserSessionPolicy`, code);
  assertPublicText(thread.title, `${label} title`, 120, code, {
    minimum: 1,
    trim: true,
    presentational: true,
  });
  if (!THREAD_STATUS_SET.has(thread.status)) {
    stateFail(code, `${label} status is invalid.`, { status: statusForCode(code) });
  }
  assertInteger(thread.revision, `${label} revision`, { minimum: 1, code });
  assertCanonicalIso(thread.createdAt, `${label} createdAt`, code);
  assertCanonicalIso(thread.updatedAt, `${label} updatedAt`, code);
  assertOptionalIso(thread.deletedAt, `${label} deletedAt`, code);
  if (
    thread.updatedAt < thread.createdAt ||
    (thread.deletedAt !== null && thread.deletedAt < thread.updatedAt)
  ) {
    stateFail(code, `${label} timestamps are inconsistent.`, { status: statusForCode(code) });
  }
  assertBoolean(thread.tombstone, `${label} tombstone`, code);
  if (
    thread.tombstone !== (thread.deletedAt !== null) ||
    (thread.tombstone && thread.status !== "deleting")
  ) {
    stateFail(code, `${label} tombstone state is inconsistent.`, { status: statusForCode(code) });
  }
  if (thread.lastRunId !== null) validateRunId(thread.lastRunId, `${label} lastRunId`, code);
  const authority = exactDataObject(thread.authority, THREAD_AUTHORITY_KEYS, `${label} authority`, code);
  if (authority.kind !== "aginti" || authority.mapped !== true) {
    stateFail(code, `${label} authority is invalid.`, { status: statusForCode(code) });
  }
  assertInteger(authority.runtimeRevision, `${label} authority runtimeRevision`, { minimum: 1, code });
  assertDigest(authority.contextDigest, `${label} authority contextDigest`, code, { allowZero: false });
  validateLastCompaction(authority.lastCompaction, `${label} authority lastCompaction`, code);
  const replay = exactDataObject(thread.replay, THREAD_REPLAY_KEYS, `${label} replay`, code);
  const prunedMessageCount = assertInteger(replay.prunedMessageCount, `${label} replay prunedMessageCount`, {
    maximum: 10_000_000,
    code,
  });
  assertDigest(replay.anchorDigest, `${label} replay anchorDigest`, code);
  if ((prunedMessageCount === 0) !== (replay.anchorDigest === ZERO_DIGEST)) {
    stateFail(code, `${label} replay anchor is inconsistent.`, { status: statusForCode(code) });
  }
  if (
    !Array.isArray(thread.messages) ||
    thread.messages.length > INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MESSAGES_PER_THREAD
  ) {
    stateFail(code, `${label} messages are not bounded.`, { status: statusForCode(code) });
  }
  let totalContent = 0;
  const messages = ReflectApply(ArrayMap, thread.messages, [(message, messageIndex) => {
    const validated = validateThreadMessage(message, messageIndex, code);
    totalContent += validated.content.length;
    return validated;
  }]);
  if (totalContent > MAX_PUBLIC_MESSAGE_TEXT_TOTAL) {
    stateFail(code, `${label} message content is not bounded.`, { status: statusForCode(code) });
  }
  assertSortedUnique(messages, (message) => [message.createdAt, message.id], `${label} messages`, code);
  return thread;
}

function validateRunError(value, label, code) {
  if (value === null) return null;
  const error = exactDataObject(value, RUN_ERROR_KEYS, label, code);
  if (!PUBLIC_ERROR_CODE_SET.has(error.code)) {
    stateFail(code, `${label} code is invalid.`, { status: statusForCode(code) });
  }
  assertPublicText(error.message, `${label} message`, 600, code, { minimum: 1, trim: true });
  return error;
}

function validateRunRecord(value, index, generation, code) {
  const label = `repository run[${index}]`;
  const run = exactDataObject(value, RUN_KEYS, label, code);
  if (run.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RUN_VERSION) {
    stateFail(code, `${label} schema is invalid.`, { status: statusForCode(code) });
  }
  validateRunId(run.id, `${label} id`, code);
  validateThreadId(run.threadId, `${label} threadId`, code);
  assertNativeSessionId(run.nativeSessionId, `${label} nativeSessionId`, code);
  assertPrincipalId(run.principalId, `${label} principalId`, code);
  assertBrowserSessionId(run.browserSessionId, `${label} browserSessionId`, code);
  assertBrowserPolicy(run.browserSessionPolicy, `${label} browserSessionPolicy`, code);
  if (run.previousRunId !== null) validateRunId(run.previousRunId, `${label} previousRunId`, code);
  if (!RUN_STATUS_SET.has(run.status)) {
    stateFail(code, `${label} status is invalid.`, { status: statusForCode(code) });
  }
  assertInteger(run.revision, `${label} revision`, { minimum: 1, code });
  assertCanonicalIso(run.createdAt, `${label} createdAt`, code);
  assertCanonicalIso(run.startedAt, `${label} startedAt`, code);
  for (const field of ["completedAt", "cancelRequestedAt", "dispatchedAt", "abortAt"]) {
    assertOptionalIso(run[field], `${label} ${field}`, code);
  }
  if (
    run.startedAt < run.createdAt ||
    (run.dispatchedAt !== null && run.dispatchedAt < run.startedAt) ||
    (run.completedAt !== null && run.completedAt < run.startedAt) ||
    (run.cancelRequestedAt !== null && run.cancelRequestedAt < run.startedAt) ||
    (run.abortAt !== null && run.abortAt < run.createdAt)
  ) {
    stateFail(code, `${label} timestamps are inconsistent.`, { status: statusForCode(code) });
  }
  if (run.dispatchLeaseId !== null) {
    assertDigest(run.dispatchLeaseId, `${label} dispatchLeaseId`, code, { allowZero: false });
  }
  assertBoolean(run.dispatchOutbox, `${label} dispatchOutbox`, code);
  const hasDispatch = run.dispatchLeaseId !== null;
  if (
    hasDispatch !== (run.dispatchedAt !== null) ||
    hasDispatch !== run.dispatchOutbox
  ) {
    stateFail(code, `${label} dispatch state is inconsistent.`, { status: statusForCode(code) });
  }
  const requiresProcessOwner = hasDispatch || run.cancelRequestedAt !== null;
  if (requiresProcessOwner !== (run.processOwner !== null)) {
    stateFail(code, `${label} process owner state is inconsistent.`, { status: statusForCode(code) });
  }
  if (run.processOwner !== null) validateProcessOwner(run.processOwner, label, code);
  assertBoolean(run.hidden, `${label} hidden`, code);
  assertBoolean(run.tombstone, `${label} tombstone`, code);
  const tombstoneSnapshotRevision = run.tombstoneSnapshotRevision === null
    ? null
    : assertInteger(run.tombstoneSnapshotRevision, `${label} tombstoneSnapshotRevision`, {
        minimum: 1,
        maximum: generation,
        code,
      });
  if (run.abortAttemptDigest !== null) {
    assertDigest(run.abortAttemptDigest, `${label} abortAttemptDigest`, code, { allowZero: false });
  }
  if ((run.abortAttemptDigest !== null) !== (run.abortAt !== null)) {
    stateFail(code, `${label} abort state is inconsistent.`, { status: statusForCode(code) });
  }
  const receipt = run.nativeStartReceipt === null
    ? null
    : validateNativeStartReceipt(run.nativeStartReceipt, `${label} nativeStartReceipt`, code);
  const recovery = run.recoveryState === null
    ? null
    : validateRecoveryState(run.recoveryState, `${label} recoveryState`, code);
  assertDigest(run.inputDigest, `${label} inputDigest`, code, { allowZero: false });
  assertPublicText(run.output, `${label} output`, MAX_PUBLIC_TEXT, code);
  const error = validateRunError(run.error, `${label} error`, code);
  const authority = exactDataObject(run.authority, RUN_AUTHORITY_KEYS, `${label} authority`, code);
  if (authority.kind !== "aginti") {
    stateFail(code, `${label} authority is invalid.`, { status: statusForCode(code) });
  }
  assertDigest(authority.snapshotHash, `${label} authority snapshotHash`, code, { allowZero: false });
  assertInteger(authority.runtimeRevision, `${label} authority runtimeRevision`, { minimum: 1, code });
  assertDigest(authority.contextDigest, `${label} authority contextDigest`, code, { allowZero: false });
  const completion = authority.completionOutbox === null
    ? null
    : validateCompletionOutbox(
        authority.completionOutbox,
        generation,
        `${label} authority completionOutbox`,
        code
      );

  if (receipt && (
    receipt.runId !== run.id || receipt.threadId !== run.threadId ||
    receipt.nativeSessionId !== run.nativeSessionId || !sameScope(receipt, run) ||
    receipt.createdAt !== run.createdAt || receipt.startedAt !== run.startedAt ||
    receipt.dispatchLeaseId !== run.dispatchLeaseId || receipt.dispatchedAt !== run.dispatchedAt ||
    (
      TERMINAL_RUN_STATUS_SET.has(run.status)
        ? receipt.targetNativeRuntimeRevision !== authority.runtimeRevision
        : receipt.expectedNativeRuntimeRevision !== authority.runtimeRevision
    )
  )) {
    stateFail(code, `${label} native-start receipt does not match the run.`, { status: statusForCode(code) });
  }
  if (recovery && (
    !receipt || recovery.authorizationId !== receipt.authorizationId ||
    recovery.authorizationDigest !== receipt.authorizationDigest || recovery.appliedRunRevision !== run.revision
  )) {
    stateFail(code, `${label} recovery state does not match the run.`, { status: statusForCode(code) });
  }
  if (completion && (
    completion.runId !== run.id || completion.threadId !== run.threadId || !sameScope(completion, run) ||
    completion.status !== run.status || completion.completedAt !== run.completedAt ||
    completion.runtimeRevision !== authority.runtimeRevision || completion.completionRevision !== run.revision
  )) {
    stateFail(code, `${label} completion outbox does not match the run.`, { status: statusForCode(code) });
  }

  if (run.status === "starting") {
    if (
      hasDispatch || receipt || recovery || completion || run.completedAt !== null ||
      run.output !== "" || error !== null ||
      run.hidden || run.tombstone || run.abortAt !== null
    ) {
      stateFail(code, `${label} starting state is inconsistent.`, { status: statusForCode(code) });
    }
  } else if (run.status === "running") {
    if (
      !hasDispatch || completion || run.completedAt !== null || run.output !== "" || error !== null ||
      run.hidden || run.tombstone || run.abortAt !== null
    ) {
      stateFail(code, `${label} running state is inconsistent.`, { status: statusForCode(code) });
    }
  } else if (TERMINAL_RUN_STATUS_SET.has(run.status)) {
    if (
      !hasDispatch || !receipt || recovery || !completion || run.completedAt === null ||
      run.hidden || run.tombstone || run.abortAt !== null ||
      (run.status === "completed" && error !== null) ||
      (run.status !== "completed" && (run.output !== "" || error === null))
    ) {
      stateFail(code, `${label} terminal state is inconsistent.`, { status: statusForCode(code) });
    }
  } else if (
    run.status === "aborted_before_launch" && (
      receipt || recovery || completion || run.completedAt !== null || run.output !== "" || error !== null ||
      !run.hidden || !run.tombstone || run.abortAt === null || tombstoneSnapshotRevision === null ||
      (run.cancelRequestedAt !== null && !hasDispatch)
    )
  ) {
    stateFail(code, `${label} pre-launch abort state is inconsistent.`, { status: statusForCode(code) });
  }
  if ((run.status === "aborted_before_launch") !== (tombstoneSnapshotRevision !== null)) {
    stateFail(code, `${label} tombstone snapshot anchor is inconsistent.`, { status: statusForCode(code) });
  }
  return run;
}

function publicEventForOutbox(outbox, label, code) {
  let payload;
  try {
    payload = validateIntegrationEventPayload(outbox.type, outbox.payload);
  } catch {
    stateFail(code, `${label} event payload is invalid.`, { status: statusForCode(code) });
  }
  if (contractDigest(payload) !== contractDigest(outbox.payload)) {
    stateFail(code, `${label} event payload is not canonical.`, { status: statusForCode(code) });
  }
  let event;
  try {
    event = createPublicIntegrationEvent({
      threadId: outbox.threadId,
      runId: outbox.runId,
      seq: outbox.expectedPreviousSeq + 1,
      type: outbox.type,
      payload,
      createdAt: outbox.createdAt,
      previousHash: outbox.expectedPreviousHash,
    });
  } catch {
    stateFail(code, `${label} does not form a valid public event.`, { status: statusForCode(code) });
  }
  return event;
}

function validateOutboxRecord(value, index, code) {
  const label = `repository outbox event[${index}]`;
  const outbox = exactDataObject(value, OUTBOX_KEYS, label, code);
  assertSafeIdentifier(outbox.outboxId, `${label} outboxId`, code, { minimum: 4, maximum: 128 });
  assertPrincipalId(outbox.principalId, `${label} principalId`, code);
  assertBrowserSessionId(outbox.browserSessionId, `${label} browserSessionId`, code);
  assertBrowserPolicy(outbox.browserSessionPolicy, `${label} browserSessionPolicy`, code);
  validateThreadId(outbox.threadId, `${label} threadId`, code);
  validateRunId(outbox.runId, `${label} runId`, code);
  if (!OUTBOX_EVENT_TYPE_SET.has(outbox.type)) {
    stateFail(code, `${label} type is invalid.`, { status: statusForCode(code) });
  }
  assertCanonicalIso(outbox.createdAt, `${label} createdAt`, code);
  assertInteger(outbox.expectedPreviousSeq, `${label} expectedPreviousSeq`, { maximum: MAX_SEQUENCE, code });
  assertDigest(outbox.expectedPreviousHash, `${label} expectedPreviousHash`, code);
  assertDigest(outbox.expectedEventHash, `${label} expectedEventHash`, code, { allowZero: false });
  if ((outbox.expectedPreviousSeq === 0) !== (outbox.expectedPreviousHash === ZERO_DIGEST)) {
    stateFail(code, `${label} predecessor cursor is invalid.`, { status: statusForCode(code) });
  }
  const event = publicEventForOutbox(outbox, label, code);
  if (event.hash !== outbox.expectedEventHash) {
    stateFail(code, `${label} event hash is invalid.`, { status: statusForCode(code) });
  }
  assertBoolean(outbox.delivered, `${label} delivered`, code);
  if (outbox.delivered) {
    if (
      outbox.deliveredEventSeq !== event.seq ||
      outbox.deliveredEventHash !== event.hash ||
      outbox.deliveredEventDigest !== contractDigest(event)
    ) {
      stateFail(code, `${label} delivery receipt is invalid.`, { status: statusForCode(code) });
    }
    assertCanonicalIso(outbox.deliveredAt, `${label} deliveredAt`, code);
    if (outbox.deliveredAt < outbox.createdAt) {
      stateFail(code, `${label} delivery timestamp is invalid.`, { status: statusForCode(code) });
    }
  } else if (
    outbox.deliveredEventSeq !== null ||
    outbox.deliveredEventHash !== null ||
    outbox.deliveredEventDigest !== null ||
    outbox.deliveredAt !== null
  ) {
    stateFail(code, `${label} undelivered receipt must be null.`, { status: statusForCode(code) });
  }
  return outbox;
}

function validateArtifactRecord(value, index, generation, code) {
  const label = `repository artifact[${index}]`;
  const artifact = exactDataObject(value, ARTIFACT_KEYS, label, code);
  if (artifact.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_ARTIFACT_VERSION) {
    stateFail(code, `${label} schema is invalid.`, { status: statusForCode(code) });
  }
  validateArtifactId(artifact.id, `${label} id`, code);
  assertPrincipalId(artifact.principalId, `${label} principalId`, code);
  assertBrowserSessionId(artifact.browserSessionId, `${label} browserSessionId`, code);
  assertBrowserPolicy(artifact.browserSessionPolicy, `${label} browserSessionPolicy`, code);
  validateThreadId(artifact.threadId, `${label} threadId`, code);
  validateRunId(artifact.runId, `${label} runId`, code);
  let sanitized;
  try {
    sanitized = sanitizeIntegrationArtifact({
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      spec: artifact.spec,
    });
  } catch {
    stateFail(code, `${label} public projection is invalid.`, { status: statusForCode(code) });
  }
  if (contractDigest(sanitized) !== contractDigest({
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    spec: artifact.spec,
  })) {
    stateFail(code, `${label} public projection is not canonical.`, { status: statusForCode(code) });
  }
  assertInteger(artifact.revision, `${label} revision`, { minimum: 1, code });
  assertCanonicalIso(artifact.stagedAt, `${label} stagedAt`, code);
  assertInteger(artifact.retainedAtSnapshotRevision, `${label} retainedAtSnapshotRevision`, {
    minimum: 1,
    maximum: generation,
    code,
  });
  assertBoolean(artifact.published, `${label} published`, code);
  assertOptionalIso(artifact.publishedAt, `${label} publishedAt`, code);
  if (
    artifact.published !== (artifact.publishedAt !== null) ||
    (artifact.publishedAt !== null && artifact.publishedAt < artifact.stagedAt)
  ) {
    stateFail(code, `${label} publication state is inconsistent.`, { status: statusForCode(code) });
  }
  return artifact;
}

function validateMutationReceipt(value, index, generation, code) {
  const label = `repository mutation receipt[${index}]`;
  const receipt = exactDataObject(value, MUTATION_RECEIPT_KEYS, label, code);
  if (receipt.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MUTATION_RECEIPT_VERSION) {
    stateFail(code, `${label} schema is invalid.`, { status: statusForCode(code) });
  }
  assertMutationId(receipt.mutationId, `${label} mutationId`, code);
  assertSafeIdentifier(receipt.operation, `${label} operation`, code, { maximum: 80 });
  assertPrincipalId(receipt.principalId, `${label} principalId`, code);
  assertBrowserSessionId(receipt.browserSessionId, `${label} browserSessionId`, code);
  assertBrowserPolicy(receipt.browserSessionPolicy, `${label} browserSessionPolicy`, code);
  assertDigest(receipt.requestDigest, `${label} requestDigest`, code, { allowZero: false });
  const baseRevision = assertInteger(receipt.baseSnapshotRevision, `${label} baseSnapshotRevision`, { code });
  const resultRevision = assertInteger(receipt.resultSnapshotRevision, `${label} resultSnapshotRevision`, {
    minimum: 1,
    maximum: generation,
    code,
  });
  assertDigest(receipt.baseIntegrityDigest, `${label} baseIntegrityDigest`, code);
  if (
    (baseRevision === 0) !== (receipt.baseIntegrityDigest === ZERO_DIGEST) ||
    resultRevision !== baseRevision + 1
  ) {
    stateFail(code, `${label} revision binding is invalid.`, { status: statusForCode(code) });
  }
  assertDigest(receipt.resultDigest, `${label} resultDigest`, code, { allowZero: false });
  if (receipt.resultDigest !== contractDigest(receipt.result)) {
    stateFail(code, `${label} result digest is invalid.`, { status: statusForCode(code) });
  }
  assertCanonicalIso(receipt.mutationTimestamp, `${label} mutationTimestamp`, code);
  assertCanonicalIso(receipt.committedAt, `${label} committedAt`, code);
  if (receipt.mutationTimestamp > receipt.committedAt) {
    stateFail(code, `${label} mutation timestamp is in the future.`, { status: statusForCode(code) });
  }
  return receipt;
}

function validateRetentionCheckpoint(value, generation, receipts, code) {
  const label = "repository retention checkpoint";
  const retention = exactDataObject(value, RETENTION_KEYS, label, code);
  if (
    retention.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RETENTION_VERSION ||
    retention.policyVersion !== "bounded-replay-horizon-v1" ||
    retention.minimumReplayReceipts !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MIN_REPLAY_RECEIPTS ||
    retention.targetReplayReceipts !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_TARGET_REPLAY_RECEIPTS ||
    retention.maximumReplayReceipts !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_REPLAY_RECEIPTS
  ) {
    stateFail(code, `${label} policy is invalid.`, { status: statusForCode(code) });
  }
  const floor = assertInteger(
    retention.exactReplayFloorSnapshotRevision,
    `${label} exactReplayFloorSnapshotRevision`,
    { maximum: generation + 1, code }
  );
  assertOptionalIso(retention.replayCutoffAt, `${label} replayCutoffAt`, code);
  const compactionGeneration = assertInteger(
    retention.compactionGeneration,
    `${label} compactionGeneration`,
    { maximum: generation, code }
  );
  assertOptionalIso(retention.lastCompactedAt, `${label} lastCompactedAt`, code);
  const lastCompactedSnapshotRevision = assertInteger(
    retention.lastCompactedSnapshotRevision,
    `${label} lastCompactedSnapshotRevision`,
    { maximum: generation, code }
  );
  if (
    (compactionGeneration === 0) !== (retention.lastCompactedAt === null) ||
    (compactionGeneration === 0) !== (lastCompactedSnapshotRevision === 0) ||
    (floor === 0) !== (retention.replayCutoffAt === null) ||
    floor > lastCompactedSnapshotRevision ||
    (retention.replayCutoffAt !== null && retention.replayCutoffAt > retention.lastCompactedAt)
  ) {
    stateFail(code, `${label} lifecycle is inconsistent.`, { status: statusForCode(code) });
  }
  for (const [countField, digestField] of [
    ["prunedMutationReceiptCount", "prunedMutationReceiptDigest"],
    ["compactedOutboxEventCount", "compactedOutboxEventDigest"],
    ["prunedRunTombstoneCount", "prunedRunTombstoneDigest"],
    ["prunedArtifactCount", "prunedArtifactDigest"],
  ]) {
    const count = assertInteger(retention[countField], `${label} ${countField}`, { code });
    assertDigest(retention[digestField], `${label} ${digestField}`, code);
    if ((count === 0) !== (retention[digestField] === ZERO_DIGEST)) {
      stateFail(code, `${label} ${countField} chain is inconsistent.`, { status: statusForCode(code) });
    }
  }
  if (receipts.length > retention.maximumReplayReceipts) {
    stateFail(code, `${label} receipt window is not bounded.`, { status: statusForCode(code) });
  }
  for (const receipt of receipts) {
    if (floor > 0 && receipt.resultSnapshotRevision < floor) {
      stateFail(code, `${label} does not bound its retained receipts.`, { status: statusForCode(code) });
    }
  }
  return retention;
}

function validateReconciliationFence(value, generation, code) {
  if (value === null) return null;
  const label = "repository reconciliation fence";
  const fence = exactDataObject(value, RECONCILIATION_FENCE_KEYS, label, code);
  if (fence.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RECONCILIATION_FENCE_VERSION) {
    stateFail(code, `${label} schema is invalid.`, { status: statusForCode(code) });
  }
  const fenceGeneration = assertInteger(fence.generation, `${label} generation`, {
    minimum: 1,
    maximum: generation,
    code,
  });
  const owner = validateProcessOwner(fence.owner, label, code);
  assertDigest(fence.ownerDigest, `${label} ownerDigest`, code, { allowZero: false });
  assertDigest(fence.ownerIdentityDigest, `${label} ownerIdentityDigest`, code, { allowZero: false });
  assertCanonicalIso(fence.issuedAt, `${label} issuedAt`, code);
  assertDigest(fence.previousFenceDigest, `${label} previousFenceDigest`, code);
  if (
    fence.ownerDigest !== contractDigest(owner) ||
    fence.ownerIdentityDigest !== contractDigest(owner.processIdentity) ||
    (fenceGeneration === 1) !== (fence.previousFenceDigest === ZERO_DIGEST) ||
    !Array.isArray(fence.retiredOwners) ||
    fence.retiredOwners.length > INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RETIRED_FENCE_OWNERS
  ) {
    stateFail(code, `${label} authority is invalid.`, { status: statusForCode(code) });
  }
  const retired = ReflectApply(ArrayMap, fence.retiredOwners, [(entry, index) => {
    const itemLabel = `${label} retired owner[${index}]`;
    const item = exactDataObject(entry, RETIRED_FENCE_OWNER_KEYS, itemLabel, code);
    if (item.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RETIRED_OWNER_VERSION) {
      stateFail(code, `${itemLabel} schema is invalid.`, { status: statusForCode(code) });
    }
    const retiredOwner = validateProcessOwner(item.owner, itemLabel, code);
    assertDigest(item.ownerDigest, `${itemLabel} ownerDigest`, code, { allowZero: false });
    assertDigest(item.processIdentityDigest, `${itemLabel} processIdentityDigest`, code, { allowZero: false });
    assertInteger(item.retiredAtGeneration, `${itemLabel} retiredAtGeneration`, {
      minimum: 1,
      maximum: fenceGeneration - 1,
      code,
    });
    assertCanonicalIso(item.retiredAt, `${itemLabel} retiredAt`, code);
    if (
      item.ownerDigest !== contractDigest(retiredOwner) ||
      item.processIdentityDigest !== contractDigest(retiredOwner.processIdentity) ||
      item.processIdentityDigest === fence.ownerIdentityDigest ||
      (item.reason !== "handoff" && item.reason !== "dead-owner-takeover")
    ) {
      stateFail(code, `${itemLabel} binding is invalid.`, { status: statusForCode(code) });
    }
    return item;
  }]);
  assertSortedUnique(retired, (item) => [item.processIdentityDigest], `${label} retired owners`, code);
  assertDigest(fence.digest, `${label} digest`, code, { allowZero: false });
  const { digest: _digest, ...unsigned } = fence;
  if (fence.digest !== contractDigest(unsigned)) {
    stateFail(code, `${label} digest is invalid.`, { status: statusForCode(code) });
  }
  return fence;
}

function completionOutboxDigestView(record) {
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

function validateRunPredecessors(runs, runsById, code) {
  for (const run of runs) {
    if (run.previousRunId === null) continue;
    const previous = runsById.get(run.previousRunId);
    if (
      !previous || previous.id === run.id || previous.threadId !== run.threadId ||
      previous.nativeSessionId !== run.nativeSessionId || !sameScope(previous, run) ||
      previous.createdAt > run.createdAt
    ) {
      stateFail(code, `repository run ${run.id} predecessor is invalid.`, { status: statusForCode(code) });
    }
    if (run.nativeStartReceipt && run.nativeStartReceipt.previousRunId !== run.previousRunId) {
      stateFail(code, `repository run ${run.id} receipt predecessor is invalid.`, { status: statusForCode(code) });
    }
  }
  const completed = new Set();
  for (const origin of runs) {
    if (completed.has(origin.id)) continue;
    const path = new Set();
    let cursor = origin;
    while (cursor !== null && !completed.has(cursor.id)) {
      if (path.has(cursor.id)) {
        stateFail(code, "repository run predecessor graph contains a cycle.", { status: statusForCode(code) });
      }
      path.add(cursor.id);
      cursor = cursor.previousRunId === null ? null : runsById.get(cursor.previousRunId);
    }
    for (const runId of path) completed.add(runId);
  }
}

function validateCompletionCrossReferences(run, thread, outboxById, outboxOwnerCount, generation, code) {
  const completion = run.authority.completionOutbox;
  if (completion === null) return;
  if (completion.threadRevision > thread.revision) {
    stateFail(code, `repository run ${run.id} completion thread revision is invalid.`, {
      status: statusForCode(code),
    });
  }
  let records = ReflectApply(ArrayMap, completion.outboxIds, [(outboxId) => {
    const count = (outboxOwnerCount.get(outboxId) || 0) + 1;
    outboxOwnerCount.set(outboxId, count);
    if (count !== 1) {
      stateFail(code, `repository outbox ${outboxId} has multiple completion owners.`, {
        status: statusForCode(code),
      });
    }
    return outboxById.get(outboxId);
  }]);
  if (completion.deliveryCheckpoint !== null) {
    if (
      completion.deliveryCheckpoint.compactedAtSnapshotRevision > generation ||
      ReflectApply(ArraySome, records, [(record) => record !== undefined])
    ) {
      stateFail(code, `repository run ${run.id} compacted completion checkpoint is invalid.`, {
        status: statusForCode(code),
      });
    }
    records = ReflectApply(ArrayMap, completion.deliveryCheckpoint.deliveries, [(entry, index) => {
      const payload = entry.type === "output.delta"
        ? frozenRecord({ text: ReflectApply(StringSlice, run.output, [0, 4_000]) })
        : frozenRecord({});
      if (entry.payloadDigest !== contractDigest(payload)) {
        stateFail(code, `repository run ${run.id} compacted completion payload is invalid.`, {
          status: statusForCode(code),
        });
      }
      const event = createPublicIntegrationEvent({
        threadId: run.threadId,
        runId: run.id,
        seq: entry.eventSeq,
        type: entry.type,
        payload,
        createdAt: entry.createdAt,
        previousHash: entry.expectedPreviousHash,
      });
      if (
        event.seq !== entry.expectedPreviousSeq + 1 ||
        event.hash !== entry.expectedEventHash ||
        contractDigest(event) !== entry.eventDigest ||
        (index === 0
          ? entry.expectedPreviousSeq !== completion.originalCursor.lastSeq ||
            entry.expectedPreviousHash !== completion.originalCursor.lastHash
          : entry.expectedPreviousSeq !== completion.deliveryCheckpoint.deliveries[index - 1].eventSeq ||
            entry.expectedPreviousHash !== completion.deliveryCheckpoint.deliveries[index - 1].eventHash)
      ) {
        stateFail(code, `repository run ${run.id} compacted completion chain is invalid.`, {
          status: statusForCode(code),
        });
      }
      return frozenRecord({
        outboxId: entry.outboxId,
        principalId: completion.principalId,
        browserSessionId: completion.browserSessionId,
        browserSessionPolicy: completion.browserSessionPolicy,
        threadId: completion.threadId,
        runId: completion.runId,
        type: entry.type,
        payload,
        createdAt: entry.createdAt,
        expectedPreviousSeq: entry.expectedPreviousSeq,
        expectedPreviousHash: entry.expectedPreviousHash,
        expectedEventHash: entry.expectedEventHash,
      });
    }]);
  }
  if (ReflectApply(ArraySome, records, [(record) => !record])) {
    stateFail(code, `repository run ${run.id} completion outbox reference is missing.`, {
      status: statusForCode(code),
    });
  }
  let expectedSeq = completion.originalCursor.lastSeq;
  let expectedHash = completion.originalCursor.lastHash;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (
      record.runId !== run.id || record.threadId !== run.threadId || !sameScope(record, run) ||
      record.type !== completion.eventTypes[index] ||
      record.expectedEventHash !== completion.eventHashes[index] ||
      record.expectedPreviousSeq !== expectedSeq || record.expectedPreviousHash !== expectedHash
    ) {
      stateFail(code, `repository run ${run.id} completion outbox chain is invalid.`, {
        status: statusForCode(code),
      });
    }
    expectedSeq += 1;
    expectedHash = record.expectedEventHash;
  }
  const terminalType = `run.${run.status}`;
  const hasPublicOutput = run.status === "completed" &&
    ReflectApply(StringTrim, run.output, []).length > 0;
  const outputPayload = hasPublicOutput
    ? frozenRecord({ text: ReflectApply(StringSlice, run.output, [0, 4_000]) })
    : null;
  if (
    records.length < 1 || records.length > 2 ||
    records[records.length - 1].type !== terminalType ||
    records[records.length - 1].createdAt !== run.completedAt ||
    contractDigest(records[records.length - 1].payload) !== contractDigest({}) ||
    (records.length === 2 && records[0].type !== "output.delta") ||
    (records.length === 2 && records[0].createdAt !== run.completedAt) ||
    (hasPublicOutput && records.length !== 2) ||
    (!hasPublicOutput && records.length !== 1) ||
    (hasPublicOutput && contractDigest(records[0].payload) !== contractDigest(outputPayload))
  ) {
    stateFail(code, `repository run ${run.id} completion event set is invalid.`, {
      status: statusForCode(code),
    });
  }
  if (
    completion.orderedBundleDigest !==
    contractDigest(ReflectApply(ArrayMap, records, [completionOutboxDigestView]))
  ) {
    stateFail(code, `repository run ${run.id} completion bundle digest is invalid.`, {
      status: statusForCode(code),
    });
  }
}

function validateDomainCrossReferences(domain, code) {
  const threadsById = new Map(ReflectApply(ArrayMap, domain.threads, [(thread) => [thread.id, thread]]));
  const runsById = new Map(ReflectApply(ArrayMap, domain.runs, [(run) => [run.id, run]]));
  const outboxById = new Map(
    ReflectApply(ArrayMap, domain.outboxEvents, [(record) => [record.outboxId, record]])
  );
  const nativeSessionIds = new Set();
  for (const thread of domain.threads) {
    if (nativeSessionIds.has(thread.nativeSessionId)) {
      stateFail(code, "repository native-session mapping is not one-to-one.", { status: statusForCode(code) });
    }
    nativeSessionIds.add(thread.nativeSessionId);
  }
  const activeByThread = new Map();
  const visibleRunCount = new Map();
  const visibleSuccessorCount = new Map();
  for (const run of domain.runs) {
    const thread = threadsById.get(run.threadId);
    if (
      !thread || thread.nativeSessionId !== run.nativeSessionId || !sameScope(thread, run)
    ) {
      stateFail(code, `repository run ${run.id} thread binding is invalid.`, { status: statusForCode(code) });
    }
    const visible = !run.hidden && !run.tombstone;
    if (visible && ACTIVE_RUN_STATUS_SET.has(run.status)) {
      activeByThread.set(run.threadId, (activeByThread.get(run.threadId) || 0) + 1);
    }
    if (visible) {
      visibleRunCount.set(run.threadId, (visibleRunCount.get(run.threadId) || 0) + 1);
      if (run.previousRunId !== null) {
        const previous = runsById.get(run.previousRunId);
        if (!previous || previous.hidden || previous.tombstone) {
          stateFail(code, `repository visible run ${run.id} predecessor is not visible.`, {
            status: statusForCode(code),
          });
        }
        const successors = (visibleSuccessorCount.get(run.previousRunId) || 0) + 1;
        visibleSuccessorCount.set(run.previousRunId, successors);
        if (successors > 1) {
          stateFail(code, `repository visible run ${run.previousRunId} has multiple successors.`, {
            status: statusForCode(code),
          });
        }
      }
    }
    if (run.nativeStartReceipt) {
      const receipt = run.nativeStartReceipt;
      if (
        run.revision < receipt.targetRunRevision ||
        receipt.threadRevision > thread.revision
      ) {
        stateFail(code, `repository run ${run.id} native-start receipt revision is invalid.`, {
          status: statusForCode(code),
        });
      }
      if (receipt.mode === "resume") {
        const previous = runsById.get(receipt.previousRunId);
        if (
          !previous || previous.revision !== receipt.previousRunRevision ||
          previous.authority.runtimeRevision !== receipt.previousRunRuntimeRevision
        ) {
          stateFail(code, `repository run ${run.id} resume receipt is invalid.`, {
            status: statusForCode(code),
          });
        }
      }
    }
  }
  validateRunPredecessors(domain.runs, runsById, code);
  for (const thread of domain.threads) {
    const activeCount = activeByThread.get(thread.id) || 0;
    const visibleCount = visibleRunCount.get(thread.id) || 0;
    if (activeCount > 1) {
      stateFail(code, `repository thread ${thread.id} has more than one active run.`, {
        status: statusForCode(code),
      });
    }
    if (
      (thread.status === "running" && activeCount !== 1) ||
      (thread.status !== "running" && activeCount !== 0)
    ) {
      stateFail(code, `repository thread ${thread.id} status does not match its active run.`, {
        status: statusForCode(code),
      });
    }
    if ((visibleCount === 0) !== (thread.lastRunId === null)) {
      stateFail(code, `repository thread ${thread.id} visible run head is missing or unexpected.`, {
        status: statusForCode(code),
      });
    }
    if (thread.lastRunId !== null) {
      const lastRun = runsById.get(thread.lastRunId);
      if (
        !lastRun || lastRun.threadId !== thread.id || lastRun.hidden || lastRun.tombstone ||
        (visibleSuccessorCount.get(lastRun.id) || 0) !== 0
      ) {
        stateFail(code, `repository thread ${thread.id} lastRunId is invalid.`, {
          status: statusForCode(code),
        });
      }
      if (
        thread.authority.runtimeRevision !== lastRun.authority.runtimeRevision ||
        (activeCount === 1) !== ACTIVE_RUN_STATUS_SET.has(lastRun.status)
      ) {
        stateFail(code, `repository thread ${thread.id} head authority or status is invalid.`, {
          status: statusForCode(code),
        });
      }
      const reachable = new Set();
      let cursor = lastRun;
      while (cursor !== null) {
        if (
          reachable.has(cursor.id) || cursor.threadId !== thread.id ||
          cursor.hidden || cursor.tombstone
        ) {
          stateFail(code, `repository thread ${thread.id} visible run lineage is invalid.`, {
            status: statusForCode(code),
          });
        }
        reachable.add(cursor.id);
        cursor = cursor.previousRunId === null ? null : runsById.get(cursor.previousRunId);
        if (cursor === undefined) {
          stateFail(code, `repository thread ${thread.id} visible run lineage is incomplete.`, {
            status: statusForCode(code),
          });
        }
      }
      if (reachable.size !== visibleCount) {
        stateFail(code, `repository thread ${thread.id} has disconnected visible runs.`, {
          status: statusForCode(code),
        });
      }
    }
    for (const message of thread.messages) {
      const run = runsById.get(message.runId);
      if (!run || run.threadId !== thread.id || run.hidden || !sameScope(run, thread)) {
        stateFail(code, `repository thread ${thread.id} message run binding is invalid.`, {
          status: statusForCode(code),
        });
      }
    }
  }
  for (const outbox of domain.outboxEvents) {
    const run = runsById.get(outbox.runId);
    if (
      !run || run.hidden || run.threadId !== outbox.threadId || !sameScope(run, outbox)
    ) {
      stateFail(code, `repository outbox ${outbox.outboxId} scope is invalid.`, {
        status: statusForCode(code),
      });
    }
  }
  const outboxOwnerCount = new Map();
  for (const run of domain.runs) {
    validateCompletionCrossReferences(
      run,
      threadsById.get(run.threadId),
      outboxById,
      outboxOwnerCount,
      domain.generation,
      code
    );
  }
  for (const outbox of domain.outboxEvents) {
    if (outboxOwnerCount.get(outbox.outboxId) !== 1) {
      stateFail(code, `repository outbox ${outbox.outboxId} has no completion owner.`, {
        status: statusForCode(code),
      });
    }
  }
  for (const artifact of domain.artifacts) {
    const thread = threadsById.get(artifact.threadId);
    const run = runsById.get(artifact.runId);
    if (
      !thread || !run || run.hidden || run.threadId !== thread.id ||
      !sameScope(thread, artifact) || !sameScope(run, artifact)
    ) {
      stateFail(code, `repository artifact ${artifact.id} scope is invalid.`, {
        status: statusForCode(code),
      });
    }
  }
}

function validateDomainState(value, binding, generation, code, maxSnapshotBytes) {
  const normalization = {
    nodes: 0,
    active: new WeakSet(),
    overflowCode: code === "INTEGRATION_REPOSITORY_KERNEL_INVALID"
      ? "INTEGRATION_REPOSITORY_KERNEL_FULL"
      : code,
    shapeCode: code,
    byteLimit: maxSnapshotBytes,
    bytes: 0,
  };
  const detached = cloneCanonicalJson(value, "native-session repository domain state", normalization);
  const domain = exactDataObject(detached, DOMAIN_KEYS, "native-session repository domain state", code);
  if (
    domain.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_DOMAIN_VERSION ||
    domain.owner !== "aginti" || domain.authority !== "aginti" ||
    domain.repositoryPointerDigest !== binding.repositoryPointerDigest ||
    domain.sessionStateNamespaceDigest !== binding.sessionStateNamespaceDigest ||
    domain.generation !== generation
  ) {
    stateFail(code, "Native-session repository domain binding is invalid.", { status: statusForCode(code) });
  }
  assertInteger(domain.generation, "native-session repository generation", { code });
  for (const [field, maximum] of [
    ["threads", INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_THREADS],
    ["runs", INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RUNS],
    ["outboxEvents", INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_OUTBOX_EVENTS],
    ["artifacts", INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_ARTIFACTS],
    ["mutationReceipts", INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MUTATION_RECEIPTS],
  ]) {
    if (!Array.isArray(domain[field]) || domain[field].length > maximum) {
      stateFail(code, `Native-session repository ${field} is not bounded.`, { status: statusForCode(code) });
    }
  }
  const threads = ReflectApply(ArrayMap, domain.threads, [
    (thread, index) => validateThreadRecord(thread, index, code),
  ]);
  const runs = ReflectApply(ArrayMap, domain.runs, [
    (run, index) => validateRunRecord(run, index, domain.generation, code),
  ]);
  const outboxEvents = ReflectApply(ArrayMap, domain.outboxEvents, [
    (outbox, index) => validateOutboxRecord(outbox, index, code),
  ]);
  const artifacts = ReflectApply(ArrayMap, domain.artifacts, [
    (artifact, index) => validateArtifactRecord(artifact, index, domain.generation, code),
  ]);
  const mutationReceipts = ReflectApply(ArrayMap, domain.mutationReceipts, [
    (receipt, index) => validateMutationReceipt(receipt, index, domain.generation, code),
  ]);
  validateRetentionCheckpoint(domain.retention, domain.generation, mutationReceipts, code);
  validateReconciliationFence(domain.reconciliationFence, domain.generation, code);
  assertSortedUnique(threads, (thread) => [thread.id], "repository threads", code);
  assertSortedUnique(runs, (run) => [run.id], "repository runs", code);
  assertSortedUnique(outboxEvents, (outbox) => [outbox.outboxId], "repository outbox events", code);
  assertSortedUnique(artifacts, (artifact) => [artifact.id], "repository artifacts", code);
  assertSortedUnique(
    mutationReceipts,
    (receipt) => [receipt.mutationId],
    "repository mutation receipts",
    code
  );
  validateDomainCrossReferences(domain, code);
  return frozenRecord({
    state: domain,
    canonicalBytes: normalization.bytes,
    canonicalNodes: normalization.nodes,
    canonicalDepth: normalization.maximumDepth,
  });
}

function emptyDomainState(binding) {
  return frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_DOMAIN_VERSION,
    owner: "aginti",
    authority: "aginti",
    repositoryPointerDigest: binding.repositoryPointerDigest,
    sessionStateNamespaceDigest: binding.sessionStateNamespaceDigest,
    generation: 0,
    threads: Object.freeze([]),
    runs: Object.freeze([]),
    outboxEvents: Object.freeze([]),
    artifacts: Object.freeze([]),
    mutationReceipts: Object.freeze([]),
    retention: frozenRecord({
      schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RETENTION_VERSION,
      policyVersion: "bounded-replay-horizon-v1",
      minimumReplayReceipts: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MIN_REPLAY_RECEIPTS,
      targetReplayReceipts: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_TARGET_REPLAY_RECEIPTS,
      maximumReplayReceipts: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_REPLAY_RECEIPTS,
      exactReplayFloorSnapshotRevision: 0,
      replayCutoffAt: null,
      compactionGeneration: 0,
      lastCompactedAt: null,
      lastCompactedSnapshotRevision: 0,
      prunedMutationReceiptCount: 0,
      prunedMutationReceiptDigest: ZERO_DIGEST,
      compactedOutboxEventCount: 0,
      compactedOutboxEventDigest: ZERO_DIGEST,
      prunedRunTombstoneCount: 0,
      prunedRunTombstoneDigest: ZERO_DIGEST,
      prunedArtifactCount: 0,
      prunedArtifactDigest: ZERO_DIGEST,
    }),
    reconciliationFence: null,
  });
}

function domainStateDigest(state) {
  return contractDigest({
    domain: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_DIGEST_DOMAIN,
    state,
  });
}

function repositoryPayloadDigest(state) {
  return contractDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_PAYLOAD_DIGEST_DOMAIN,
    payload: state,
  });
}

function domainRequestDigest(input, stateDigest) {
  return contractDigest({
    domain: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_REQUEST_DIGEST_DOMAIN,
    mutationId: input.mutationId,
    expectedSnapshotRevision: input.expectedSnapshotRevision,
    expectedIntegrityDigest: input.expectedIntegrityDigest,
    resultGeneration: input.state.generation,
    stateDigest,
  });
}

function lastMutationDigest(value) {
  return contractDigest({
    domain: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_LAST_MUTATION_DIGEST_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    mutation: digestWithoutKeys(value, new Set(["mutationDigest"])),
  });
}

function inspectDependency(value) {
  if (value && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value)) {
    return "proxy";
  }
  if (isPromiseValue(value)) {
    if (promiseCanBeSafelyObserved(value)) {
      ReflectApply(PromiseThen, value, [undefined, () => undefined]);
    }
    return "promise";
  }
  if (!value || typeof value !== "object") return "shape";
  return "";
}

function observeExpectedPromiseInputs(input) {
  try {
    const inputIssue = inspectDependency(input);
    if (inputIssue || !input || typeof input !== "object" || utilTypes.isProxy(input)) return;
    for (const [bindingKey, bindingKeys] of [
      ["repositoryKernel", REPOSITORY_EXPECTED_KEYS],
      ["sessionStateStore", SESSION_EXPECTED_KEYS],
    ]) {
      const bindingDescriptor = ObjectGetOwnPropertyDescriptor(input, bindingKey);
      if (!bindingDescriptor || !hasOwn(bindingDescriptor, "value")) continue;
      const binding = bindingDescriptor.value;
      const bindingIssue = inspectDependency(binding);
      if (bindingIssue || !binding || typeof binding !== "object" || utilTypes.isProxy(binding)) continue;
      for (const key of bindingKeys) {
        const descriptor = ObjectGetOwnPropertyDescriptor(binding, key);
        if (!descriptor || !hasOwn(descriptor, "value")) continue;
        const field = descriptor.value;
        const fieldIssue = inspectDependency(field);
        if (!fieldIssue && key === "relativeSegments" && Array.isArray(field)) {
          const length = Math.min(field.length, 64);
          for (let index = 0; index < length; index += 1) {
            const segment = ObjectGetOwnPropertyDescriptor(field, String(index));
            if (segment && hasOwn(segment, "value")) inspectDependency(segment.value);
          }
        }
      }
    }
  } catch {
    // Promise observation is best-effort and must not make malformed input observable.
  }
}

function normalizeExpected(input) {
  if (input && typeof input === "object" && !utilTypes.isProxy(input) && !isPromiseValue(input)) {
    for (const key of EXPECTED_KEYS) {
      const descriptor = ObjectGetOwnPropertyDescriptor(input, key);
      if (descriptor && hasOwn(descriptor, "value") && isPromiseValue(descriptor.value) &&
        promiseCanBeSafelyObserved(descriptor.value)) {
        ReflectApply(PromiseThen, descriptor.value, [undefined, () => undefined]);
      }
    }
  }
  const detached = cloneCanonicalJson(input, "native-session repository-state expected binding", {
    nodes: 0,
    active: new WeakSet(),
    overflowCode: "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    shapeCode: "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    byteLimit: 64 * 1024,
    bytes: 0,
  });
  const expected = exactDataObject(
    detached,
    EXPECTED_KEYS,
    "native-session repository-state expected binding"
  );
  const repositoryKernel = exactDataObject(
    expected.repositoryKernel,
    REPOSITORY_EXPECTED_KEYS,
    "native-session repository kernel expected binding"
  );
  const sessionStateStore = exactDataObject(
    expected.sessionStateStore,
    SESSION_EXPECTED_KEYS,
    "native-session state-store expected binding"
  );
  if (
    repositoryKernel.role !== sessionStateStore.role ||
    repositoryKernel.canonicalPath !== sessionStateStore.canonicalPath ||
    repositoryKernel.rootIdentityDigest !== sessionStateStore.rootIdentityDigest ||
    repositoryKernel.helperSha256 !== sessionStateStore.helperSha256 ||
    repositoryKernel.helperIdentityDigest !== sessionStateStore.helperIdentityDigest
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Repository and native-session state bindings do not share one retained root authority."
    );
  }
  if (
    contractDigest(repositoryKernel.relativeSegments) === contractDigest(sessionStateStore.relativeSegments) ||
    repositoryKernel.directoryIdentityDigest === sessionStateStore.directoryIdentityDigest ||
    repositoryKernel.lockFileIdentityDigest === sessionStateStore.lockFileIdentityDigest
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Repository and native-session state bindings require distinct retained directories and locks."
    );
  }
  return frozenRecord({ repositoryKernel, sessionStateStore });
}

function admissionBindingDigest(
  expected,
  repositoryPointerDigest,
  sessionStateNamespaceDigest
) {
  return contractDigest({
    schemaVersion: "aginti-retained-native-session-repository-state-admission-v1",
    repositoryKernel: expected.repositoryKernel,
    sessionStateStore: expected.sessionStateStore,
    repositoryPointerDigest,
    sessionStateNamespaceDigest,
  });
}

function dependencyBinding(repositoryKernel, sessionStateStore, expected) {
  assertRetainedIntegrationRuntimeRepositoryKernel(repositoryKernel, expected.repositoryKernel);
  if (repositoryKernel.isClosed()) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository kernel binding is closed."
    );
  }
  const repositoryPointerDigest = assertDigest(
    repositoryKernel.attestation.pointerDigest,
    "repository kernel pointer digest",
    "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
    { allowZero: false }
  );
  let sessionStateNamespaceDigest;
  try {
    assertRetainedIntegrationSessionStateStore(sessionStateStore, expected.sessionStateStore);
    if (sessionStateStore.isClosed()) throw new TypeError("closed");
    sessionStateNamespaceDigest = assertDigest(
      sessionStateStore.attestation.logicalNamespaceDigest,
      "native-session state logical namespace digest",
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      { allowZero: false }
    );
  } catch {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session state retained binding is unavailable."
    );
  }
  const bindingDigest = admissionBindingDigest(
    expected,
    repositoryPointerDigest,
    sessionStateNamespaceDigest
  );
  return frozenRecord({
    repositoryPointerDigest,
    sessionStateNamespaceDigest,
    admissionBindingDigest: bindingDigest,
  });
}

function attestationDigest(value) {
  return contractDigest(digestWithoutKeys(value, new Set(["digest"])));
}

function validateAttestation(value) {
  const proof = exactDataObject(
    value,
    ATTESTATION_KEYS,
    "native-session repository-state attestation",
    "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE"
  );
  if (
    proof.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_ATTESTATION_VERSION ||
    proof.owner !== "aginti" || proof.authority !== "aginti" ||
    proof.preEnableDomainState !== true || proof.runtimeCapabilityEnabled !== false ||
    proof.runtimeWiringIncluded !== false || proof.runtimeRepositorySurface !== false ||
    proof.runtimeRepositoryAttestation !== false || proof.runtimeRepositoryMethodSurface !== false ||
    proof.runtimeRepositoryMethodPayloadSchemasIncluded !== false ||
    proof.runtimeRepositoryMethodResultSchemasIncluded !== false ||
    proof.repositoryTransitionsIncluded !== false || proof.artifactSemanticsIncluded !== false ||
    proof.artifactStagePublish !== false ||
    proof.recoverySemanticsIncluded !== false || proof.eventLedgerIntegration !== false ||
    proof.eventLedgerAtomicity !== false || proof.eventDeliveryIncluded !== false ||
    proof.sessionStateStoreIntegration !== false || proof.sessionStateReadIntegration !== false ||
    proof.sessionStateStoreMutation !== false || proof.sessionStateStoreAtomicity !== false ||
    proof.sessionStateRecoveryIntegration !== false || proof.idempotencyStoreIntegration !== false ||
    proof.legacyFileIdempotencyStoreIntegration !== false ||
    proof.apiIdempotencyStoreIntegration !== false || proof.idempotencySemanticsIncluded !== false ||
    proof.crossStoreAtomicity !== false || proof.sameKernelHostRequired !== true ||
    proof.crossHostExclusion !== false || proof.localFilesystemRequired !== true ||
    proof.localFilesystemVerified !== false || proof.networkFilesystemSafety !== false ||
    proof.fencingTokens !== false ||
    proof.canonicalDomainValidation !== true || proof.exactDomainStateSchema !== true ||
    proof.exactThreadRecordSchema !== true || proof.exactRunRecordSchema !== true ||
    proof.exactOutboxRecordSchema !== true || proof.exactPublicArtifactRecordSchema !== true ||
    proof.exactMutationReceiptSchema !== true || proof.snapshotLocalValidationOnly !== true ||
    proof.stableRepositoryPointerBinding !== true || proof.stableSessionStateNamespaceBinding !== true ||
    proof.sameRetainedRootRequired !== true || proof.distinctRetainedDirectoriesRequired !== true ||
    proof.compareAndSwap !== true || proof.generationExactlyOne !== true ||
    proof.postWriteKernelValidation !== true || proof.lastCommitReplayOnly !== true ||
    proof.mutationReceiptSchemaIncluded !== true || proof.mutationReceiptReplay !== false ||
    proof.wrapperOperationQueue !== false || proof.underlyingKernelQueueInherited !== true ||
    proof.wrapperErrorNamespace !== false || proof.underlyingKernelErrorNamespaceInherited !== true ||
    proof.runtimeRootsIncluded !== false || proof.exclusiveKernelOwnership !== false ||
    proof.underlyingKernelBypassPrevented !== false || proof.storageLifecycleOwned !== false ||
    proof.limitations !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_LIMITATIONS ||
    proof.maxJsonDepth !== INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH ||
    proof.maxJsonNodes !== INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES ||
    proof.maxThreads !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_THREADS ||
    proof.maxRuns !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RUNS ||
    proof.maxOutboxEvents !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_OUTBOX_EVENTS ||
    proof.maxArtifacts !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_ARTIFACTS ||
    proof.maxMutationReceipts !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MUTATION_RECEIPTS ||
    proof.maxMessagesPerThread !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MESSAGES_PER_THREAD ||
    proof.maxPublicArtifactBytes !==
      INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_PUBLIC_ARTIFACT_BYTES ||
    !Number.isSafeInteger(proof.maxSnapshotBytes) || proof.maxSnapshotBytes < 4096 ||
    proof.maxSnapshotBytes > 16 * 1024 * 1024
  ) {
    stateFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Native-session repository-state attestation is unavailable.");
  }
  for (const [digest, label] of [
    [proof.repositoryPointerDigest, "repository pointer digest"],
    [proof.sessionStateNamespaceDigest, "session-state namespace digest"],
    [proof.admissionBindingDigest, "repository-state admission binding digest"],
    [proof.digest, "repository-state attestation digest"],
  ]) assertDigest(digest, label, "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", { allowZero: false });
  if (proof.digest !== attestationDigest(proof)) {
    stateFail("INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", "Native-session repository-state attestation digest is invalid.");
  }
  return proof;
}

function buildAttestation(state) {
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    preEnableDomainState: true,
    runtimeCapabilityEnabled: false,
    runtimeWiringIncluded: false,
    runtimeRepositorySurface: false,
    runtimeRepositoryAttestation: false,
    runtimeRepositoryMethodSurface: false,
    runtimeRepositoryMethodPayloadSchemasIncluded: false,
    runtimeRepositoryMethodResultSchemasIncluded: false,
    repositoryTransitionsIncluded: false,
    artifactSemanticsIncluded: false,
    artifactStagePublish: false,
    recoverySemanticsIncluded: false,
    eventLedgerIntegration: false,
    eventLedgerAtomicity: false,
    eventDeliveryIncluded: false,
    sessionStateStoreIntegration: false,
    sessionStateReadIntegration: false,
    sessionStateStoreMutation: false,
    sessionStateStoreAtomicity: false,
    sessionStateRecoveryIntegration: false,
    idempotencyStoreIntegration: false,
    legacyFileIdempotencyStoreIntegration: false,
    apiIdempotencyStoreIntegration: false,
    idempotencySemanticsIncluded: false,
    crossStoreAtomicity: false,
    sameKernelHostRequired: true,
    crossHostExclusion: false,
    localFilesystemRequired: true,
    localFilesystemVerified: false,
    networkFilesystemSafety: false,
    fencingTokens: false,
    canonicalDomainValidation: true,
    exactDomainStateSchema: true,
    exactThreadRecordSchema: true,
    exactRunRecordSchema: true,
    exactOutboxRecordSchema: true,
    exactPublicArtifactRecordSchema: true,
    exactMutationReceiptSchema: true,
    snapshotLocalValidationOnly: true,
    stableRepositoryPointerBinding: true,
    stableSessionStateNamespaceBinding: true,
    sameRetainedRootRequired: true,
    distinctRetainedDirectoriesRequired: true,
    compareAndSwap: true,
    generationExactlyOne: true,
    postWriteKernelValidation: true,
    lastCommitReplayOnly: true,
    mutationReceiptSchemaIncluded: true,
    mutationReceiptReplay: false,
    wrapperOperationQueue: false,
    underlyingKernelQueueInherited: true,
    wrapperErrorNamespace: false,
    underlyingKernelErrorNamespaceInherited: true,
    runtimeRootsIncluded: false,
    exclusiveKernelOwnership: false,
    underlyingKernelBypassPrevented: false,
    storageLifecycleOwned: false,
    repositoryPointerDigest: state.binding.repositoryPointerDigest,
    sessionStateNamespaceDigest: state.binding.sessionStateNamespaceDigest,
    admissionBindingDigest: state.binding.admissionBindingDigest,
    maxSnapshotBytes: state.expected.repositoryKernel.maxSnapshotBytes,
    maxJsonDepth: INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH,
    maxJsonNodes: INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES,
    maxThreads: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_THREADS,
    maxRuns: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RUNS,
    maxOutboxEvents: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_OUTBOX_EVENTS,
    maxArtifacts: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_ARTIFACTS,
    maxMutationReceipts: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MUTATION_RECEIPTS,
    maxMessagesPerThread: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MESSAGES_PER_THREAD,
    maxPublicArtifactBytes:
      INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_PUBLIC_ARTIFACT_BYTES,
    limitations: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_LIMITATIONS,
  });
  return validateAttestation(frozenRecord({ ...unsigned, digest: contractDigest(unsigned) }));
}

function validateKernelLastCommit(commitValue, snapshot) {
  const commit = exactFrozenNullPrototypeObject(
    commitValue,
    KERNEL_LAST_COMMIT_KEYS,
    "native-session repository kernel last commit",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  if (
    commit.schemaVersion !== INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_VERSION ||
    commit.baseSnapshotRevision !== snapshot.snapshotRevision - 1 ||
    commit.resultSnapshotRevision !== snapshot.snapshotRevision ||
    commit.baseIntegrityDigest !== snapshot.previousIntegrityDigest ||
    commit.payloadDigest !== snapshot.payloadDigest
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      "Native-session repository kernel last commit binding is invalid."
    );
  }
  assertMutationId(
    commit.transactionId,
    "native-session repository kernel transaction id",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  assertDigest(
    commit.requestDigest,
    "native-session repository kernel request digest",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
    { allowZero: false }
  );
  assertDigest(
    commit.baseIntegrityDigest,
    "native-session repository kernel base integrity digest",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  assertDigest(
    commit.payloadDigest,
    "native-session repository kernel payload digest",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
    { allowZero: false }
  );
  assertDigest(
    commit.commitDigest,
    "native-session repository kernel commit digest",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
    { allowZero: false }
  );
  if (
    (commit.baseSnapshotRevision === 0) !== (commit.baseIntegrityDigest === ZERO_DIGEST)
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      "Native-session repository kernel commit predecessor is invalid."
    );
  }
  return commit;
}

function validateKernelSnapshot(state, value) {
  const snapshot = exactFrozenNullPrototypeObject(
    value,
    KERNEL_SNAPSHOT_KEYS,
    "native-session repository kernel snapshot",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  if (
    snapshot.schemaVersion !== INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_VERSION ||
    snapshot.owner !== "aginti" || snapshot.authority !== "aginti" ||
    snapshot.pointerDigest !== state.binding.repositoryPointerDigest
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      "Native-session repository kernel snapshot binding is invalid."
    );
  }
  const revision = assertInteger(
    snapshot.snapshotRevision,
    "native-session repository kernel snapshot revision",
    { code: "INTEGRATION_REPOSITORY_KERNEL_CORRUPT" }
  );
  assertDigest(
    snapshot.previousIntegrityDigest,
    "native-session repository kernel predecessor digest",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  assertDigest(
    snapshot.payloadDigest,
    "native-session repository kernel payload digest",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
    { allowZero: false }
  );
  assertDigest(
    snapshot.integrityDigest,
    "native-session repository kernel integrity digest",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  if (revision === 0) {
    if (
      snapshot.previousIntegrityDigest !== ZERO_DIGEST || snapshot.payload !== null ||
      snapshot.payloadDigest !== repositoryPayloadDigest(null) || snapshot.lastCommit !== null ||
      snapshot.integrityDigest !== ZERO_DIGEST
    ) {
      stateFail(
        "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
        "Native-session repository empty kernel snapshot is invalid."
      );
    }
    return frozenRecord({ snapshot, commit: null });
  }
  if (
    !snapshot.payload || typeof snapshot.payload !== "object" || Array.isArray(snapshot.payload) ||
    snapshot.payloadDigest !== repositoryPayloadDigest(snapshot.payload) ||
    snapshot.integrityDigest === ZERO_DIGEST ||
    (revision === 1) !== (snapshot.previousIntegrityDigest === ZERO_DIGEST)
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      "Native-session repository persisted kernel snapshot is invalid."
    );
  }
  return frozenRecord({ snapshot, commit: validateKernelLastCommit(snapshot.lastCommit, snapshot) });
}

function domainLastMutation(commit, stateDigest) {
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_LAST_MUTATION_VERSION,
    mutationId: commit.transactionId,
    requestDigest: commit.requestDigest,
    baseSnapshotRevision: commit.baseSnapshotRevision,
    baseIntegrityDigest: commit.baseIntegrityDigest,
    resultSnapshotRevision: commit.resultSnapshotRevision,
    stateDigest,
  });
  return frozenRecord({ ...unsigned, mutationDigest: lastMutationDigest(unsigned) });
}

function validateMappedDomainSnapshot(value) {
  const snapshot = exactFrozenNullPrototypeObject(
    value,
    SNAPSHOT_KEYS,
    "native-session repository domain snapshot",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  if (snapshot.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_SNAPSHOT_VERSION) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      "Native-session repository domain snapshot schema is invalid."
    );
  }
  const revision = assertInteger(
    snapshot.snapshotRevision,
    "native-session repository domain snapshot revision",
    { code: "INTEGRATION_REPOSITORY_KERNEL_CORRUPT" }
  );
  assertDigest(
    snapshot.previousIntegrityDigest,
    "native-session repository domain predecessor digest",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  assertDigest(
    snapshot.stateDigest,
    "native-session repository domain state digest",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
    { allowZero: false }
  );
  assertDigest(
    snapshot.integrityDigest,
    "native-session repository domain integrity digest",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  if (
    snapshot.state.generation !== revision ||
    snapshot.stateDigest !== domainStateDigest(snapshot.state)
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      "Native-session repository domain snapshot state binding is invalid."
    );
  }
  if (revision === 0) {
    if (
      snapshot.previousIntegrityDigest !== ZERO_DIGEST || snapshot.lastMutation !== null ||
      snapshot.integrityDigest !== ZERO_DIGEST
    ) {
      stateFail(
        "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
        "Native-session repository empty domain snapshot is invalid."
      );
    }
    return snapshot;
  }
  const mutation = exactFrozenNullPrototypeObject(
    snapshot.lastMutation,
    LAST_MUTATION_KEYS,
    "native-session repository domain last mutation",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  if (
    mutation.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_LAST_MUTATION_VERSION ||
    mutation.resultSnapshotRevision !== revision ||
    mutation.baseSnapshotRevision !== revision - 1 ||
    mutation.baseIntegrityDigest !== snapshot.previousIntegrityDigest ||
    mutation.stateDigest !== snapshot.stateDigest ||
    mutation.mutationDigest !== lastMutationDigest(mutation) ||
    mutation.requestDigest !== domainRequestDigest(frozenRecord({
      mutationId: mutation.mutationId,
      expectedSnapshotRevision: mutation.baseSnapshotRevision,
      expectedIntegrityDigest: mutation.baseIntegrityDigest,
      state: snapshot.state,
    }), snapshot.stateDigest) ||
    snapshot.integrityDigest === ZERO_DIGEST ||
    (revision === 1) !== (snapshot.previousIntegrityDigest === ZERO_DIGEST)
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      "Native-session repository domain last mutation is invalid."
    );
  }
  assertMutationId(
    mutation.mutationId,
    "native-session repository domain mutation id",
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
  );
  for (const [digest, label, allowZero] of [
    [mutation.requestDigest, "native-session repository domain request digest", false],
    [mutation.baseIntegrityDigest, "native-session repository domain mutation predecessor", true],
    [mutation.stateDigest, "native-session repository domain mutation state digest", false],
    [mutation.mutationDigest, "native-session repository domain mutation digest", false],
  ]) {
    assertDigest(digest, label, "INTEGRATION_REPOSITORY_KERNEL_CORRUPT", { allowZero });
  }
  return snapshot;
}

function mapKernelSnapshotUnchecked(state, value) {
  const validatedKernel = validateKernelSnapshot(state, value);
  const kernelSnapshot = validatedKernel.snapshot;
  if (kernelSnapshot.snapshotRevision === 0) {
    const domain = emptyDomainState(state.binding);
    return validateMappedDomainSnapshot(frozenRecord({
      schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_SNAPSHOT_VERSION,
      snapshotRevision: 0,
      previousIntegrityDigest: ZERO_DIGEST,
      state: domain,
      stateDigest: domainStateDigest(domain),
      lastMutation: null,
      integrityDigest: ZERO_DIGEST,
    }));
  }
  const validatedDomain = validateDomainState(
    kernelSnapshot.payload,
    state.binding,
    kernelSnapshot.snapshotRevision,
    "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
    state.expected.repositoryKernel.maxSnapshotBytes
  );
  const stateDigest = domainStateDigest(validatedDomain.state);
  const expectedRequestDigest = domainRequestDigest(frozenRecord({
    mutationId: validatedKernel.commit.transactionId,
    expectedSnapshotRevision: validatedKernel.commit.baseSnapshotRevision,
    expectedIntegrityDigest: validatedKernel.commit.baseIntegrityDigest,
    state: validatedDomain.state,
  }), stateDigest);
  if (validatedKernel.commit.requestDigest !== expectedRequestDigest) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      "Native-session repository domain request binding is invalid."
    );
  }
  return validateMappedDomainSnapshot(frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_SNAPSHOT_VERSION,
    snapshotRevision: kernelSnapshot.snapshotRevision,
    previousIntegrityDigest: kernelSnapshot.previousIntegrityDigest,
    state: validatedDomain.state,
    stateDigest,
    lastMutation: domainLastMutation(validatedKernel.commit, stateDigest),
    integrityDigest: kernelSnapshot.integrityDigest,
  }));
}

function mapKernelSnapshot(state, value) {
  try {
    return mapKernelSnapshotUnchecked(state, value);
  } catch {
    state.poisoned = true;
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      "Native-session repository persisted domain state is corrupt."
    );
  }
}

function normalizeDomainCasInput(input, state) {
  const raw = exactDataObject(
    input,
    CAS_INPUT_KEYS,
    "native-session repository compare-and-swap input"
  );
  const mutationId = assertMutationId(raw.mutationId, "native-session repository mutation id");
  const expectedSnapshotRevision = assertInteger(
    raw.expectedSnapshotRevision,
    "native-session repository expected snapshot revision"
  );
  if (expectedSnapshotRevision === Number.MAX_SAFE_INTEGER) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_FULL",
      "Native-session repository snapshot revision space is exhausted.",
      { status: 409 }
    );
  }
  const expectedIntegrityDigest = assertDigest(
    raw.expectedIntegrityDigest,
    "native-session repository expected integrity digest"
  );
  if (
    (expectedSnapshotRevision === 0) !== (expectedIntegrityDigest === ZERO_DIGEST)
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_INVALID",
      "Native-session repository expected predecessor is invalid.",
      { status: 400 }
    );
  }
  const validatedState = validateDomainState(
    raw.state,
    state.binding,
    expectedSnapshotRevision + 1,
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    state.expected.repositoryKernel.maxSnapshotBytes
  );
  const stateDigest = domainStateDigest(validatedState.state);
  const normalized = frozenRecord({
    mutationId,
    expectedSnapshotRevision,
    expectedIntegrityDigest,
    state: validatedState.state,
  });
  return frozenRecord({
    ...normalized,
    stateDigest,
    requestDigest: domainRequestDigest(normalized, stateDigest),
  });
}

function validateExpectedCasSnapshot(state, snapshot, input) {
  if (
    snapshot.snapshotRevision !== input.expectedSnapshotRevision + 1 ||
    snapshot.previousIntegrityDigest !== input.expectedIntegrityDigest ||
    snapshot.stateDigest !== input.stateDigest ||
    !snapshot.lastMutation ||
    snapshot.lastMutation.mutationId !== input.mutationId ||
    snapshot.lastMutation.requestDigest !== input.requestDigest ||
    snapshot.lastMutation.baseSnapshotRevision !== input.expectedSnapshotRevision ||
    snapshot.lastMutation.baseIntegrityDigest !== input.expectedIntegrityDigest ||
    contractDigest(snapshot.state) !== contractDigest(input.state)
  ) {
    state.poisoned = true;
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      "Native-session repository post-write domain verification failed."
    );
  }
  return snapshot;
}

function hardenDerivedPromise(value) {
  if (!isPromiseValue(value) || !ReflectDefineProperty(value, "constructor", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: SafePromiseConstructor,
  })) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository kernel did not return a safe promise."
    );
  }
  void ReflectApply(PromiseThen, value, [undefined, () => undefined]);
  return value;
}

function mapKernelPromise(value, mapper) {
  if (!isPromiseValue(value)) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository kernel did not return a native promise."
    );
  }
  let derived;
  try {
    derived = ReflectApply(PromiseThen, value, [mapper]);
  } catch {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository kernel promise could not be observed safely."
    );
  }
  return hardenDerivedPromise(derived);
}

function dependenciesClosed(state) {
  try {
    return state.repositoryKernel.isClosed() || state.sessionStateStore.isClosed();
  } catch {
    return true;
  }
}

function assertRepositoryStateOpen(state) {
  if (state.poisoned) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_POISONED",
      "Native-session repository domain state is poisoned and requires reconciliation."
    );
  }
  if (dependenciesClosed(state)) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository retained binding is closed."
    );
  }
}

function loadDomainSnapshot(state) {
  const pending = state.repositoryKernel.loadSnapshot();
  return mapKernelPromise(pending, (snapshot) => mapKernelSnapshot(state, snapshot));
}

function compareAndSwapDomainSnapshot(state, input) {
  const pending = state.repositoryKernel.compareAndSwapSnapshot(frozenRecord({
    transactionId: input.mutationId,
    requestDigest: input.requestDigest,
    expectedSnapshotRevision: input.expectedSnapshotRevision,
    expectedIntegrityDigest: input.expectedIntegrityDigest,
    payload: input.state,
  }));
  return mapKernelPromise(pending, (value) => {
    let result;
    try {
      result = exactFrozenNullPrototypeObject(
        value,
        KERNEL_CAS_RESULT_KEYS,
        "native-session repository kernel compare-and-swap result",
        "INTEGRATION_REPOSITORY_KERNEL_CORRUPT"
      );
      if (result.outcome !== "committed" && result.outcome !== "replayed") {
        stateFail(
          "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
          "Native-session repository kernel compare-and-swap outcome is invalid."
        );
      }
      const snapshot = validateExpectedCasSnapshot(
        state,
        mapKernelSnapshotUnchecked(state, result.snapshot),
        input
      );
      return frozenRecord({ outcome: result.outcome, snapshot });
    } catch {
      state.poisoned = true;
      stateFail(
        "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
        "Native-session repository compare-and-swap result is corrupt."
      );
    }
  });
}

function validateRepositoryStateSurface(surface, state) {
  exactFrozenNullPrototypeObject(
    surface,
    SURFACE_KEYS,
    "native-session repository-state surface"
  );
  if (
    surface.schemaVersion !== INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_VERSION ||
    surface.attestation !== state.attestation ||
    typeof surface.loadDomainSnapshot !== "function" ||
    typeof surface.compareAndSwapDomainSnapshot !== "function" ||
    typeof surface.isClosed !== "function"
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository-state surface is unavailable."
    );
  }
  validateAttestation(surface.attestation);
  return surface;
}

function assertFactoryDependencies(repositoryKernel, sessionStateStore) {
  const repositoryIssue = inspectDependency(repositoryKernel);
  const sessionIssue = inspectDependency(sessionStateStore);
  if (repositoryIssue || sessionIssue) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository-state dependencies are unavailable."
    );
  }
}

export function createRetainedIntegrationNativeSessionRepositoryState(
  repositoryKernel,
  sessionStateStore,
  expectedInput
) {
  observeExpectedPromiseInputs(expectedInput);
  assertFactoryDependencies(repositoryKernel, sessionStateStore);
  const expected = normalizeExpected(expectedInput);
  const binding = dependencyBinding(repositoryKernel, sessionStateStore, expected);
  const state = {
    repositoryKernel,
    sessionStateStore,
    expected,
    binding,
    poisoned: false,
    attestation: null,
    surface: null,
  };
  state.attestation = buildAttestation(state);
  state.surface = validateRepositoryStateSurface(frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_VERSION,
    attestation: state.attestation,
    loadDomainSnapshot() {
      assertRepositoryStateOpen(state);
      if (arguments.length !== 0) {
        stateFail(
          "INTEGRATION_REPOSITORY_KERNEL_INVALID",
          "Native-session repository loadDomainSnapshot takes no arguments.",
          { status: 400 }
        );
      }
      return loadDomainSnapshot(state);
    },
    compareAndSwapDomainSnapshot(input) {
      assertRepositoryStateOpen(state);
      if (arguments.length !== 1) {
        stateFail(
          "INTEGRATION_REPOSITORY_KERNEL_INVALID",
          "Native-session repository compareAndSwapDomainSnapshot requires one exact input.",
          { status: 400 }
        );
      }
      return compareAndSwapDomainSnapshot(state, normalizeDomainCasInput(input, state));
    },
    isClosed() {
      return dependenciesClosed(state);
    },
  }), state);
  repositoryStateBrand.set(state.surface, state);
  return state.surface;
}

export function assertRetainedIntegrationNativeSessionRepositoryState(value, expectedInput) {
  const valueIssue = inspectDependency(value);
  observeExpectedPromiseInputs(expectedInput);
  if (valueIssue) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository-state lexical brand is invalid."
    );
  }
  const expected = normalizeExpected(expectedInput);
  const state = repositoryStateBrand.get(value);
  if (!state || value !== state.surface) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository-state lexical brand is invalid."
    );
  }
  validateRepositoryStateSurface(value, state);
  assertRetainedIntegrationRuntimeRepositoryKernel(
    state.repositoryKernel,
    expected.repositoryKernel
  );
  try {
    assertRetainedIntegrationSessionStateStore(
      state.sessionStateStore,
      expected.sessionStateStore
    );
  } catch {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository-state retained binding is unavailable."
    );
  }
  if (
    admissionBindingDigest(
      expected,
      state.binding.repositoryPointerDigest,
      state.binding.sessionStateNamespaceDigest
    ) !== state.binding.admissionBindingDigest
  ) {
    stateFail(
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      "Native-session repository-state expected binding is invalid."
    );
  }
  return value;
}
