import crypto from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  assertFixedIntegrationPolicy,
  contractDigest,
  validateIntegrationBrowserSessionBinding,
  validateIntegrationIsolationAttestation,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";
import {
  sanitizePublicIntegrationRun,
  sanitizePublicIntegrationThread,
} from "./integration-api.js";
import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import { createPublicIntegrationEvent } from "./integration-events.js";
import { authorityFail, currentProcessOwner, nowIso } from "./integration-durable-common.js";
import { createIntegrationCoreEventProjector, assertNoUnsafeCoreEventFields } from "./integration-core-event-projector.js";
import { createIntegrationRunRegistry } from "./integration-run-registry.js";
import { NATIVE_INTEGRATION_RUNTIME_PROOF_VERSION } from "./integration-session-service.js";
import {
  NATIVE_INTEGRATION_EXECUTOR_PROOF,
  bindRetainedNativeExecution,
  buildFixedNativeRunAgentConfig,
  classifyRunAgentError,
  classifyRunAgentResult,
  executeNativeAgintiRun,
  outputEventForRunResult,
  preflightNativeSessionRuntime,
  recordRetainedNativeTerminalEvidence,
  validateNativeRuntimeRootsAttestation,
} from "./integration-native-executor.js";
import {
  assertRetainedIntegrationNativeExecutionEvidence,
} from "./integration-retained-native-execution-evidence.js";
import {
  assertRetainedIntegrationRuntimeRecoveryCoordinator,
} from "./integration-retained-runtime-repository-surface.js";
import {
  assertIntegrationRuntimeRepositoryAttestation as validateRepositoryAttestation,
  assertIntegrationRuntimeRepositorySurface as validateRepository,
} from "./integration-runtime-repository-contract.js";
export {
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY,
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION,
} from "./integration-runtime-repository-contract.js";

export const INTEGRATION_EVENT_APPEND_ATTESTATION_VERSION = "aginti-public-event-append-attestation-v1";
export const INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY = "integrationEventAppendAttestation";
export const INTEGRATION_RUNTIME_CANCELLATION_ATTESTATION_VERSION =
  "aginti-runtime-cancellation-attestation-v1";
export const INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION =
  "aginti-hardened-sandbox-runtime-attestation-v1";

const ZERO_DIGEST = "0".repeat(64);
const NativePromise = Promise;
const PromisePrototype = NativePromise.prototype;
const PromisePrototypeThen = PromisePrototype.then;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const ACTIVE_RUN_STATUSES = new Set(["starting", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_EVENT_TYPES = Object.freeze({
  completed: "run.completed",
  failed: "run.failed",
  cancelled: "run.cancelled",
});
const REMOVED_INJECTED_OPTIONS = Object.freeze([
  "runAgentExecutor",
  "fixedRuntimeConfigBuilder",
  "runRegistry",
  "now",
  "testOnly",
]);
const FORBIDDEN_ADAPTER_METHODS = Object.freeze([
  "plan",
  "createPlan",
  "summarize",
  "compactContext",
  "callModel",
  "completeWithModel",
  "runTool",
  "executeTool",
  "executeDocker",
]);
const EVENT_APPEND_ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "appendPublicEvent",
  "appendByOutboxId",
  "lookupByOutboxId",
  "terminalFinality",
  "durable",
  "persisted",
  "monotonic",
  "digest",
]);
const CANCELLATION_ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "abortControllerBound",
  "exactRunOnly",
  "browserSessionBound",
  "cancellation",
  "digest",
]);
const SANDBOX_ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "valid",
  "enabled",
  "digest",
  "isolationAttestation",
]);
const EVENT_LEDGER_STORE_REQUIRED_KEYS = Object.freeze([
  "owner",
  "authority",
  "mappingVersion",
  "durable",
  "persisted",
  "contiguous",
  "monotonic",
  "bridgeOwned",
  "appendPublicEvent",
  "appendByOutboxId",
  "lookupByOutboxId",
  "ledgerForRun",
]);
const EVENT_LEDGER_STORE_OPTIONAL_KEYS = Object.freeze([
  "eventsForRun",
  INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY,
]);
const PROCESS_OWNER_KEYS = Object.freeze([
  "schemaVersion",
  "pid",
  "token",
  "processIdentity",
  "acquiredAt",
  "heartbeatAt",
]);
const PROCESS_IDENTITY_KEYS = Object.freeze(["schemaVersion", "bootId", "startTimeTicks"]);
const PROCESS_BOOT_ID_PATTERN = /^[a-f0-9-]{16,80}$/u;
const PROCESS_START_TICKS_PATTERN = /^[0-9]{1,32}$/u;
const PUBLIC_EVENT_KEYS = Object.freeze([
  "schemaVersion",
  "id",
  "seq",
  "type",
  "threadId",
  "runId",
  "createdAt",
  "payload",
  "previousHash",
  "hash",
]);
const COMPLETION_OUTBOX_METADATA_VERSION = "aginti-completion-outbox-bundle-v1";
const OUTBOX_RECORD_REQUIRED_KEYS = Object.freeze([
  "outboxId",
  "principalId",
  "browserSessionId",
  "browserSessionPolicy",
  "threadId",
  "runId",
  "type",
  "payload",
  "createdAt",
  "expectedPreviousSeq",
  "expectedPreviousHash",
  "expectedEventHash",
  "delivered",
]);
const OUTBOX_RECORD_OPTIONAL_KEYS = Object.freeze([
  "deliveredEventSeq",
  "deliveredEventHash",
  "deliveredEventDigest",
]);
const COMPLETION_OUTBOX_METADATA_KEYS = Object.freeze([
  "schemaVersion",
  "principalId",
  "browserSessionId",
  "browserSessionPolicy",
  "threadId",
  "runId",
  "status",
  "completedAt",
  "runtimeRevision",
  "completionRevision",
  "threadRevision",
  "originalCursor",
  "outboxIds",
  "eventTypes",
  "eventHashes",
  "orderedBundleDigest",
]);
const COMPLETION_OUTBOX_CURSOR_KEYS = Object.freeze(["firstSeq", "lastSeq", "lastHash", "prunedThroughSeq"]);
const PRE_LAUNCH_ABORT_ATTEMPT_VERSION = "aginti-pre-launch-abort-attempt-v3";
const PRE_LAUNCH_ABORT_RESPONSE_VERSION = "aginti-pre-launch-abort-response-v1";
const PRE_LAUNCH_ABORT_ATTEMPT_KEYS = Object.freeze([
  "schemaVersion",
  "mode",
  "principalId",
  "browserSessionId",
  "browserSessionPolicy",
  "threadId",
  "runId",
  "nativeSessionId",
  "previousRunId",
  "previousThreadRevision",
  "expectedNativeRuntimeRevision",
  "threadPreservationDigest",
  "nativeStartReceiptMustBeAbsent",
  "createdAt",
  "dispatchAttempted",
  "dispatchLeaseId",
  "dispatchOutbox",
  "dispatchedAt",
  "processOwner",
  "abortAt",
  "attemptDigest",
]);
const PRE_LAUNCH_ABORT_RESPONSE_KEYS = Object.freeze([
  "schemaVersion",
  "action",
  "aborted",
  "idempotent",
  "attemptDigest",
  "run",
  "thread",
]);
const NATIVE_START_AUTHORIZATION_VERSION = "aginti-native-start-authorization-v1";
const NATIVE_START_AUTHORIZATION_KEYS = Object.freeze([
  "schemaVersion",
  "mode",
  "principalId",
  "browserSessionId",
  "browserSessionPolicy",
  "threadId",
  "runId",
  "nativeSessionId",
  "previousRunId",
  "previousRunRevision",
  "previousRunRuntimeRevision",
  "threadRevision",
  "threadPreservationDigest",
  "createdAt",
  "startedAt",
  "expectedNativeRuntimeRevision",
  "targetNativeRuntimeRevision",
  "expectedRunRevision",
  "targetRunRevision",
  "dispatchLeaseId",
  "dispatchOutbox",
  "dispatchedAt",
  "processOwner",
  "authorizedAt",
  "authorizationId",
  "authorizationDigest",
]);
const NATIVE_START_AUTHORIZATION_RESPONSE_KEYS = Object.freeze([
  "schemaVersion",
  "outcome",
  "authorized",
  "idempotent",
  "authorizationId",
  "authorizationDigest",
  "receipt",
  "run",
  "thread",
]);
const NATIVE_START_RECOVERY_STATE_VERSION = "aginti-native-start-recovery-v1";
const NATIVE_START_RECOVERY_STATE_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "reason",
  "authorizationId",
  "authorizationDigest",
  "sourceRunRevision",
  "appliedRunRevision",
  "heldAt",
  "observedByProcessOwner",
  "digest",
]);
const DISPATCH_RECONCILIATION_VERSION = "aginti-dispatch-reconciliation-v1";
const DISPATCH_RECONCILIATION_REQUEST_KEYS = Object.freeze([
  "schemaVersion",
  "principalId",
  "browserSessionId",
  "browserSessionPolicy",
  "processOwner",
  "liveRunClaims",
  "reconciledAt",
  "requestDigest",
]);
const DISPATCH_RECONCILIATION_LIVE_CLAIM_KEYS = Object.freeze([
  "runId",
  "threadId",
  "nativeSessionId",
  "claimedAt",
]);
const DISPATCH_RECONCILIATION_RESPONSE_KEYS = Object.freeze([
  "schemaVersion",
  "requestDigest",
  "reconciled",
  "receiptRunResults",
  "pendingOutboxEvents",
  "responseDigest",
]);
const DISPATCH_RECONCILIATION_RESULT_KEYS = Object.freeze([
  "action",
  "run",
  "thread",
]);
const PUBLIC_ERROR_CODES = new Set([
  "AGINTI_RUNTIME_ERROR",
  "CANCELLED",
  "PROVIDER_PREFLIGHT_FAILED",
  "MODEL_TIMEOUT",
  "MAX_STEPS",
  "SESSION_RUNTIME_TAKEOVER_BLOCKED",
]);

function failUnavailable(message) {
  authorityFail("AGENT_UNAVAILABLE", message);
}

function notFound(label) {
  authorityFail("NOT_FOUND", `${label} was not found.`, { status: 404 });
}

function conflict(code, message) {
  authorityFail(code, message, { status: 409 });
}

function assertPrincipalId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/u.test(value)) {
    authorityFail("INVALID_PRINCIPAL", "Integration principal scope is invalid.", { status: 401 });
  }
  return value;
}

function assertBrowserSessionId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    authorityFail("INVALID_BROWSER_SESSION", "Integration browser session scope is invalid.", { status: 400 });
  }
  return value;
}

function assertNativeSessionId(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value) ||
    value.includes("..") ||
    value.startsWith("aginti-evidence-v1:")
  ) {
    failUnavailable("Native AgInTi session id is invalid.");
  }
  return value;
}

function runtimeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nativeSessionIdForThread() {
  return `aginti:${crypto.randomUUID()}`;
}

function ownDataDescriptor(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    failUnavailable(`${label}.${key} must be an own data property.`);
  }
  return descriptor;
}

function rejectThenableDependency(value, label) {
  if (value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") {
    if (typeof value.catch === "function") value.catch(() => {});
    failUnavailable(`${label} must not be a thenable.`);
  }
}

function assertNoSemanticMethods(value, label) {
  for (const method of FORBIDDEN_ADAPTER_METHODS) {
    if (method in Object(value)) failUnavailable(`${label} exposes semantic agent method ${method}.`);
  }
}

function assertFrozenPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value) || !Object.isFrozen(value)) {
    failUnavailable(`${label} must be a frozen object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) failUnavailable(`${label} prototype is invalid.`);
  return value;
}

function assertExactFrozenShape(value, { label, requiredKeys = [], optionalKeys = [] }) {
  assertFrozenPlainObject(value, label);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      failUnavailable(`${label} contains unsupported top-level field.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      failUnavailable(`${label}.${String(key)} must be an enumerable immutable data field.`);
    }
    if (descriptor.writable !== false || descriptor.configurable !== false) {
      failUnavailable(`${label}.${key} must be immutable.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      failUnavailable(`${label}.${key} is unavailable.`);
    }
  }
  return value;
}

function assertExactFrozenPlainObject(value, keys, label) {
  assertFrozenPlainObject(value, label);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value");
    })
  ) {
    failUnavailable(`${label} must contain exact frozen data fields.`);
  }
  return value;
}

function digestWithoutDigest(value = {}) {
  const { digest: _digest, ...unsigned } = value;
  return contractDigest(unsigned);
}

function canonicalPlainJsonClone(value, label, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) failUnavailable(`${label} must contain only finite JSON numbers.`);
    return value;
  }
  if (typeof value !== "object") failUnavailable(`${label} must contain only JSON data.`);
  if (utilTypes.isProxy(value)) failUnavailable(`${label} must not be a Proxy.`);
  if (seen.has(value)) failUnavailable(`${label} must not contain cycles.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) failUnavailable(`${label} array prototype is invalid.`);
      const keys = Reflect.ownKeys(value);
      const indexKeys = keys.filter((key) => key !== "length");
      if (indexKeys.some((key) => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
        failUnavailable(`${label} array must not contain symbols or named fields.`);
      }
      if (indexKeys.length !== value.length) failUnavailable(`${label} array must be dense.`);
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          failUnavailable(`${label} array must contain exact data fields.`);
        }
        clone[index] = canonicalPlainJsonClone(descriptor.value, `${label}[${index}]`, seen);
      }
      return Object.freeze(clone);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) failUnavailable(`${label} prototype is invalid.`);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) failUnavailable(`${label} must not contain symbols.`);
    const clone = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        failUnavailable(`${label}.${String(key)} must be an enumerable data field.`);
      }
      clone[key] = canonicalPlainJsonClone(descriptor.value, `${label}.${key}`, seen);
    }
    return Object.freeze(clone);
  } finally {
    seen.delete(value);
  }
}

function assertFrozenAttestation(value, label, keys) {
  if (value && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value)) {
    failUnavailable(`${label} must not be a Proxy.`);
  }
  rejectThenableDependency(value, label);
  const proof = keys ? assertExactFrozenPlainObject(value, keys, label) : assertFrozenPlainObject(value, label);
  rejectThenableDependency(proof, label);
  if (typeof proof.digest !== "string" || proof.digest !== digestWithoutDigest(proof)) {
    failUnavailable(`${label} digest is invalid.`);
  }
  return proof;
}

function validateEventAppendProof(eventLedgerStore) {
  const proof = assertFrozenAttestation(
    ownDataDescriptor(eventLedgerStore, INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY, "event ledger store").value,
    "event append attestation",
    EVENT_APPEND_ATTESTATION_KEYS
  );
  const appendDescriptor = Object.getOwnPropertyDescriptor(eventLedgerStore, "appendByOutboxId");
  const lookupDescriptor = Object.getOwnPropertyDescriptor(eventLedgerStore, "lookupByOutboxId");
  const appendMethod =
    appendDescriptor &&
    appendDescriptor.enumerable === true &&
    appendDescriptor.writable === false &&
    appendDescriptor.configurable === false &&
    typeof appendDescriptor.value === "function";
  const lookupMethod =
    lookupDescriptor &&
    lookupDescriptor.enumerable === true &&
    lookupDescriptor.writable === false &&
    lookupDescriptor.configurable === false &&
    typeof lookupDescriptor.value === "function";
  if (
    proof.schemaVersion !== INTEGRATION_EVENT_APPEND_ATTESTATION_VERSION ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.appendPublicEvent !== true ||
    proof.appendByOutboxId !== true ||
    proof.appendByOutboxId !== Boolean(appendMethod) ||
    proof.lookupByOutboxId !== true ||
    proof.lookupByOutboxId !== Boolean(lookupMethod) ||
    proof.terminalFinality !== true ||
    proof.durable !== true ||
    proof.persisted !== true ||
    proof.monotonic !== true
  ) {
    failUnavailable("public event append proof is unavailable.");
  }
  return proof;
}

function validateCancellationProof(value) {
  const proof = assertFrozenAttestation(value, "cancellation attestation", CANCELLATION_ATTESTATION_KEYS);
  if (
    proof.schemaVersion !== INTEGRATION_RUNTIME_CANCELLATION_ATTESTATION_VERSION ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.abortControllerBound !== true ||
    proof.exactRunOnly !== true ||
    proof.browserSessionBound !== true ||
    proof.cancellation !== true
  ) {
    failUnavailable("runtime cancellation proof is unavailable.");
  }
  return proof;
}

function validateSandboxProof(value) {
  const proof = assertFrozenAttestation(value, "hardened sandbox attestation", SANDBOX_ATTESTATION_KEYS);
  if (
    proof.schemaVersion !== INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.valid !== true ||
    proof.enabled !== true ||
    typeof proof.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proof.digest)
  ) {
    failUnavailable("hardened sandbox proof is unavailable.");
  }
  rejectThenableDependency(proof.isolationAttestation, "hardened sandbox isolation attestation");
  const isolation = validateIntegrationIsolationAttestation(proof.isolationAttestation);
  if (isolation.ok !== true) failUnavailable("hardened sandbox isolation assertions are incomplete.");
  return proof;
}

function validateEventLedgerStore(eventLedgerStore) {
  if (eventLedgerStore && (typeof eventLedgerStore === "object" || typeof eventLedgerStore === "function") && utilTypes.isProxy(eventLedgerStore)) {
    failUnavailable("event ledger store must not be a Proxy.");
  }
  rejectThenableDependency(eventLedgerStore, "event ledger store");
  assertExactFrozenShape(eventLedgerStore, {
    label: "event ledger store",
    requiredKeys: EVENT_LEDGER_STORE_REQUIRED_KEYS,
    optionalKeys: EVENT_LEDGER_STORE_OPTIONAL_KEYS,
  });
  if (
    !eventLedgerStore ||
    eventLedgerStore.owner !== "aginti" ||
    eventLedgerStore.authority !== "aginti" ||
    eventLedgerStore.durable !== true ||
    eventLedgerStore.persisted !== true ||
    eventLedgerStore.contiguous !== true ||
    eventLedgerStore.monotonic !== true ||
    eventLedgerStore.bridgeOwned !== false ||
    typeof eventLedgerStore.appendPublicEvent !== "function" ||
    typeof eventLedgerStore.ledgerForRun !== "function"
  ) {
    failUnavailable("AgInTi public event ledger append interface is unavailable.");
  }
  for (const method of ["appendPublicEvent", "appendByOutboxId", "lookupByOutboxId", "ledgerForRun"]) {
    const descriptor = ownDataDescriptor(eventLedgerStore, method, "event ledger store");
    if (descriptor.writable !== false || descriptor.configurable !== false || typeof descriptor.value !== "function") {
      failUnavailable(`event ledger store.${method} must be an immutable own method.`);
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(eventLedgerStore, "eventsForRun") &&
    typeof eventLedgerStore.eventsForRun !== "function"
  ) {
    failUnavailable("event ledger store.eventsForRun must be an immutable own method.");
  }
  if (Object.prototype.hasOwnProperty.call(eventLedgerStore, INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY)) {
    validateEventAppendProof(eventLedgerStore);
  }
  return eventLedgerStore;
}

function normalizeContext(context = {}) {
  const principalId = assertPrincipalId(context.principalId);
  const browserSessionId = assertBrowserSessionId(context.browserSessionId);
  const policy = assertFixedIntegrationPolicy(context.policy);
  return Object.freeze({
    principalId,
    browserSessionId,
    browserSessionPolicy: "same-browser-session",
    policy,
    abortSignal: context.abortSignal || null,
  });
}

function assertOwnedBinding(record, scope, label) {
  if (!record || record.principalId !== scope.principalId) notFound(label);
  const binding = validateIntegrationBrowserSessionBinding(record, scope, { label, requireBound: true });
  if (binding.policy !== "same-browser-session" || binding.browserSessionId !== scope.browserSessionId) notFound(label);
  return binding;
}

function assertRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) failUnavailable(`${label} revision is invalid.`);
  return value;
}

function assertRuntimeRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) failUnavailable(`${label} runtime revision is invalid.`);
  return value;
}

function threadRuntimeRevision(record, label = "thread") {
  if (!record?.authority || record.authority.kind !== "aginti") failUnavailable(`${label} authority is invalid.`);
  return assertRuntimeRevision(record.authority.runtimeRevision, `${label} authority`);
}

function assertRevisionAdvanced(previous, next, label) {
  if (assertRevision(next, label) !== assertRevision(previous, label) + 1) {
    conflict("REVISION_CONFLICT", `${label} revision did not advance by exactly one.`);
  }
}

function assertCanonicalIso(value, label) {
  if (typeof value !== "string") failUnavailable(`${label} must be a canonical timestamp.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    failUnavailable(`${label} must be a canonical timestamp.`);
  }
  return value;
}

function validateOptionalRunCancelRequestedAt(value, label = "run cancellation timestamp") {
  if (value === null) return null;
  return assertCanonicalIso(value, label);
}

function validateRunCancelRequestedAtField(record, label = "run") {
  const descriptor = Object.getOwnPropertyDescriptor(record || {}, "cancelRequestedAt");
  if (
    !descriptor ||
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, "value")
  ) {
    failUnavailable(`${label} cancellation marker is unavailable.`);
  }
  return validateOptionalRunCancelRequestedAt(descriptor.value, `${label} cancelRequestedAt`);
}

function cloneExactDescriptorRecord(value, keys, label) {
  if (value && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value)) {
    failUnavailable(`${label} must not be a Proxy.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failUnavailable(`${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) failUnavailable(`${label} prototype is invalid.`);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    failUnavailable(`${label} must contain exact data fields.`);
  }
  const clone = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      failUnavailable(`${label}.${key} must be an enumerable data field.`);
    }
    clone[key] = descriptor.value;
  }
  return Object.freeze(clone);
}

function cloneProcessIdentity(identity, label) {
  const clone = cloneExactDescriptorRecord(identity, PROCESS_IDENTITY_KEYS, `${label} process identity`);
  if (clone.schemaVersion !== "aginti-process-identity-v1") failUnavailable(`${label} process identity schema is invalid.`);
  if (typeof clone.bootId !== "string" || !PROCESS_BOOT_ID_PATTERN.test(clone.bootId)) {
    failUnavailable(`${label} process identity boot id is invalid.`);
  }
  if (typeof clone.startTimeTicks !== "string" || !PROCESS_START_TICKS_PATTERN.test(clone.startTimeTicks)) {
    failUnavailable(`${label} process identity start time is invalid.`);
  }
  return clone;
}

function assertProcessOwnerEnvelope(owner, label) {
  const clone = cloneExactDescriptorRecord(owner, PROCESS_OWNER_KEYS, `${label} process owner`);
  if (clone.schemaVersion !== "aginti-process-owner-v1") failUnavailable(`${label} process owner schema is invalid.`);
  if (!Number.isSafeInteger(clone.pid) || clone.pid < 1) failUnavailable(`${label} process owner pid is invalid.`);
  if (typeof clone.token !== "string" || !/^[a-f0-9]{32}$/u.test(clone.token)) {
    failUnavailable(`${label} process owner token is invalid.`);
  }
  const identity = cloneProcessIdentity(clone.processIdentity, label);
  assertCanonicalIso(clone.acquiredAt, `${label} process owner acquiredAt`);
  assertCanonicalIso(clone.heartbeatAt, `${label} process owner heartbeatAt`);
  return Object.freeze({
    schemaVersion: clone.schemaVersion,
    pid: clone.pid,
    token: clone.token,
    processIdentity: identity,
    acquiredAt: clone.acquiredAt,
    heartbeatAt: clone.heartbeatAt,
  });
}

function sameProcessOwner(left, right) {
  return Boolean(
    left.schemaVersion === "aginti-process-owner-v1" &&
      right.schemaVersion === "aginti-process-owner-v1" &&
      left.pid === right.pid &&
      left.token === right.token &&
      left.processIdentity.schemaVersion === right.processIdentity.schemaVersion &&
      left.processIdentity.bootId === right.processIdentity.bootId &&
      left.processIdentity.startTimeTicks === right.processIdentity.startTimeTicks &&
      left.acquiredAt === right.acquiredAt &&
      left.heartbeatAt === right.heartbeatAt
  );
}

function assertProcessOwner(record, owner, label) {
  if (record.processOwner === undefined || record.processOwner === null) {
    failUnavailable(`${label} process owner is unavailable.`);
  }
  const recordOwner = assertProcessOwnerEnvelope(record.processOwner, label);
  const expectedOwner = assertProcessOwnerEnvelope(owner, "expected");
  if (!sameProcessOwner(recordOwner, expectedOwner)) {
    failUnavailable(`${label} process owner did not match the dispatch owner.`);
  }
}

function threadPublicRecord(record, scope, expectedThreadId = "") {
  if (expectedThreadId && record?.id !== expectedThreadId) notFound("Thread");
  assertOwnedBinding(record, scope, "Thread");
  assertNativeSessionId(record.nativeSessionId);
  threadRuntimeRevision(record);
  const publicRecord = {
    id: validateIntegrationThreadId(record.id),
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    title: record.title,
    status: record.status,
    revision: assertRevision(record.revision, "thread"),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastRunId: record.lastRunId ?? null,
    authority: record.authority,
    replay: record.replay,
    messages: record.messages || [],
  };
  const sanitized = sanitizePublicIntegrationThread(publicRecord, {
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
  });
  return Object.freeze({
    ...sanitized,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: "same-browser-session",
  });
}

async function eventCursorFor(eventLedgerStore, record, scope) {
  const ledger = eventLedgerStore.ledgerForRun({
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    threadId: record.threadId,
    runId: record.id,
  });
  if (!ledger || typeof ledger.loadHead !== "function") failUnavailable("Public event ledger head is unavailable.");
  const head = await ledger.loadHead();
  const seq = Number(head?.seq || 0);
  const hash = String(head?.hash || ZERO_DIGEST);
  if (!Number.isSafeInteger(seq) || seq < 0 || !/^[a-f0-9]{64}$/u.test(hash)) {
    failUnavailable("Public event ledger head is invalid.");
  }
  if ((seq === 0) !== (hash === ZERO_DIGEST)) {
    failUnavailable("Public event ledger cursor violates the zero-hash invariant.");
  }
  return Object.freeze({ firstSeq: 1, lastSeq: seq, lastHash: hash, prunedThroughSeq: 0 });
}

async function runPublicRecord(record, scope, eventLedgerStore, expectedRunId = "") {
  if (expectedRunId && record?.id !== expectedRunId) notFound("Run");
  assertOwnedBinding(record, scope, "Run");
  assertRuntimeRevision(record?.authority?.runtimeRevision, "run authority");
  const cancelRequestedAt = validateRunCancelRequestedAtField(record, "run");
  if (record.output) assertNoUnsafeCoreEventFields({ output: record.output }, "run output");
  if (record.error) {
    if (!record.error || typeof record.error !== "object" || Array.isArray(record.error)) {
      failUnavailable("Run error envelope is invalid.");
    }
    if (!PUBLIC_ERROR_CODES.has(record.error.code)) failUnavailable("Run error code is not public.");
    assertNoUnsafeCoreEventFields({ message: record.error.message || "" }, "run error");
  }
  const publicRecord = {
    id: validateIntegrationRunId(record.id),
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    threadId: validateIntegrationThreadId(record.threadId),
    previousRunId: record.previousRunId ?? null,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    cancelRequestedAt,
    output: record.output || "",
    error: record.error || null,
    authority: record.authority,
    eventCursor: await eventCursorFor(eventLedgerStore, record, scope),
  };
  const sanitized = sanitizePublicIntegrationRun(publicRecord, {
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
  });
  return Object.freeze({
    ...sanitized,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: "same-browser-session",
  });
}

function artifactPublicRecord(record, scope, expected = {}) {
  if (!record || record.principalId !== scope.principalId) notFound("Artifact");
  assertOwnedBinding(record, scope, "Artifact");
  if (expected.threadId && record.threadId !== expected.threadId) notFound("Artifact");
  if (expected.runId && record.runId !== expected.runId) notFound("Artifact");
  assertNoUnsafeCoreEventFields(record, "artifact");
  const artifact = sanitizeIntegrationArtifact({
    id: record.id,
    title: record.title,
    kind: record.kind,
    spec: record.spec,
  });
  return Object.freeze({
    ...artifact,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    threadId: record.threadId || "",
    runId: record.runId || "",
  });
}

function unwrap(value, key) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  return value;
}

function snapshotRepositoryEnvelope(value, label) {
  return canonicalPlainJsonClone(value, label);
}

function snapshotThreadRecord(record, label = "thread record") {
  return snapshotRepositoryEnvelope(record, label);
}

function snapshotRunRecord(record, label = "run record") {
  return snapshotRepositoryEnvelope(record, label);
}

function threadPreservationDigestFor(thread, label = "thread preservation") {
  const snapshot = snapshotThreadRecord(thread, label);
  if (!snapshot) failUnavailable(`${label} thread is unavailable.`);
  validateIntegrationThreadId(snapshot.id);
  assertPrincipalId(snapshot.principalId);
  assertBrowserSessionId(snapshot.browserSessionId);
  if (snapshot.browserSessionPolicy !== "same-browser-session") failUnavailable(`${label} browser policy is invalid.`);
  assertNativeSessionId(snapshot.nativeSessionId);
  threadRuntimeRevision(snapshot, label);
  return contractDigest({
    id: snapshot.id,
    nativeSessionId: snapshot.nativeSessionId,
    principalId: snapshot.principalId,
    browserSessionId: snapshot.browserSessionId,
    browserSessionPolicy: snapshot.browserSessionPolicy,
    title: snapshot.title,
    createdAt: snapshot.createdAt,
    authority: snapshot.authority,
    replay: snapshot.replay,
    messages: snapshot.messages || [],
  });
}

function safePublicError(error, { cancelled = false } = {}) {
  if (cancelled) return Object.freeze({ code: "CANCELLED", message: "Run cancelled." });
  const candidate = String(error?.code || error?.publicCode || "AGINTI_RUNTIME_ERROR").trim().toUpperCase();
  return Object.freeze({
    code: PUBLIC_ERROR_CODES.has(candidate) ? candidate : "AGINTI_RUNTIME_ERROR",
    message: "AgInTi runtime execution failed.",
  });
}

function createChildAbortController(parentSignal) {
  const controller = new AbortController();
  let cleanup = () => {};
  if (parentSignal) {
    const abort = () => controller.abort(parentSignal.reason || new Error("Integration request aborted."));
    if (parentSignal.aborted) abort();
    else {
      parentSignal.addEventListener?.("abort", abort, { once: true });
      cleanup = () => parentSignal.removeEventListener?.("abort", abort);
    }
  }
  return Object.freeze({ controller, cleanup });
}

function rejectRemovedDependencyOptions(options = {}) {
  for (const key of REMOVED_INJECTED_OPTIONS) {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      failUnavailable(`Integration runtime no longer accepts injected ${key}.`);
    }
  }
}

function verifyOutboxEvent(record = {}, event = {}, scope = {}) {
  assertExactPublicEventEnvelope(event, "outbox public event");
  if (
    !event ||
    event.threadId !== scope.threadId ||
    event.runId !== scope.runId ||
    event.seq !== record.expectedPreviousSeq + 1 ||
    event.previousHash !== record.expectedPreviousHash ||
    event.hash !== record.expectedEventHash ||
    event.type !== record.type ||
    event.createdAt !== record.createdAt ||
    contractDigest(event.payload) !== contractDigest(record.payload || {})
  ) {
    authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger outbox record does not match the durable outbox.", {
      status: 503,
    });
  }
  return event;
}

function assertExactPublicEventEnvelope(event = {}, label = "public event") {
  if (!event || typeof event !== "object" || Array.isArray(event) || utilTypes.isProxy(event)) {
    failUnavailable(`${label} envelope is invalid.`);
  }
  const keys = Reflect.ownKeys(event);
  if (
    keys.length !== PUBLIC_EVENT_KEYS.length ||
    keys.some((key) => typeof key !== "string" || !PUBLIC_EVENT_KEYS.includes(key)) ||
    PUBLIC_EVENT_KEYS.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(event, key);
      return !descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value");
    })
  ) {
    failUnavailable(`${label} must contain exact public event fields.`);
  }
  const checked = createPublicIntegrationEvent({
    threadId: event.threadId,
    runId: event.runId,
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
    previousHash: event.previousHash,
  });
  if (contractDigest(checked) !== contractDigest(event)) {
    authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", `${label} hash chain is invalid.`, { status: 503 });
  }
  return event;
}

function expectedCompletionEvents({ classification = {}, status, completedAt, cursor, threadId, runId }) {
  const events = [];
  if (status === "completed") {
    const outputEvent = outputEventForRunResult(classification, { createdAt: completedAt });
    if (outputEvent) events.push(outputEvent);
  } else if (outputEventForRunResult(classification, { createdAt: completedAt })) {
    failUnavailable("Only completed runs may publish output events.");
  }
  events.push(Object.freeze({ type: TERMINAL_EVENT_TYPES[status], payload: {}, createdAt: completedAt }));
  let seq = cursor.lastSeq;
  let previousHash = cursor.lastHash;
  return Object.freeze(events.map((event) => {
    const publicEvent = createPublicIntegrationEvent({
      threadId,
      runId,
      seq: seq + 1,
      type: event.type,
      payload: event.payload || {},
      createdAt: event.createdAt,
      previousHash,
    });
    const expected = Object.freeze({
      type: event.type,
      payload: event.payload || {},
      createdAt: event.createdAt,
      expectedPreviousSeq: seq,
      expectedPreviousHash: previousHash,
      expectedEventHash: publicEvent.hash,
    });
    seq = publicEvent.seq;
    previousHash = publicEvent.hash;
    return expected;
  }));
}

function assertExactDataKeys(value, requiredKeys, optionalKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    failUnavailable(`${label} must be a plain object.`);
  }
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) failUnavailable(`${label} contains unsupported field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      failUnavailable(`${label}.${String(key)} must be an enumerable data field.`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) failUnavailable(`${label}.${key} is unavailable.`);
  }
}

function validateOutboxId(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(value) ||
    value.includes("..")
  ) {
    failUnavailable(`${label} is invalid.`);
  }
  return value;
}

function immutableOutboxDigestView(record) {
  return Object.freeze({
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

function outboxBundleDigest(records = []) {
  return contractDigest(records.map(immutableOutboxDigestView));
}

function cloneOutboxRecordStrict(record, label) {
  assertExactDataKeys(record, OUTBOX_RECORD_REQUIRED_KEYS, OUTBOX_RECORD_OPTIONAL_KEYS, label);
  const clone = canonicalPlainJsonClone(record, label);
  validateOutboxId(clone.outboxId, `${label}.outboxId`);
  if (clone.browserSessionPolicy !== "same-browser-session") failUnavailable(`${label}.browserSessionPolicy is invalid.`);
  if (!INTEGRATION_EVENT_TYPES_FOR_OUTBOX.has(clone.type)) failUnavailable(`${label}.type is invalid.`);
  if (!Number.isSafeInteger(clone.expectedPreviousSeq) || clone.expectedPreviousSeq < 0) {
    failUnavailable(`${label}.expectedPreviousSeq is invalid.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(clone.expectedPreviousHash) || !/^[a-f0-9]{64}$/u.test(clone.expectedEventHash)) {
    failUnavailable(`${label} cursor hashes are invalid.`);
  }
  if (typeof clone.createdAt !== "string" || Number.isNaN(Date.parse(clone.createdAt))) {
    failUnavailable(`${label}.createdAt is invalid.`);
  }
  if (typeof clone.delivered !== "boolean") failUnavailable(`${label}.delivered must be boolean.`);
  if (clone.deliveredEventSeq !== undefined && (!Number.isSafeInteger(clone.deliveredEventSeq) || clone.deliveredEventSeq < 1)) {
    failUnavailable(`${label}.deliveredEventSeq is invalid.`);
  }
  for (const key of ["deliveredEventHash", "deliveredEventDigest"]) {
    if (clone[key] !== undefined && !/^[a-f0-9]{64}$/u.test(clone[key])) failUnavailable(`${label}.${key} is invalid.`);
  }
  return clone;
}

const INTEGRATION_EVENT_TYPES_FOR_OUTBOX = new Set([
  "output.delta",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

function cloneOutboxBatchStrict(records = [], label = "outbox batch") {
  const canonicalRecords = canonicalPlainJsonClone(records, label);
  if (!Array.isArray(canonicalRecords)) failUnavailable(`${label} must be an array.`);
  const ids = new Set();
  const clonedRecords = [];
  for (let index = 0; index < canonicalRecords.length; index += 1) {
    const cloned = cloneOutboxRecordStrict(canonicalRecords[index], `${label}[${index}]`);
    if (ids.has(cloned.outboxId)) failUnavailable(`${label} contains a duplicate outbox id.`);
    ids.add(cloned.outboxId);
    clonedRecords.push(cloned);
  }
  return Object.freeze(clonedRecords);
}

function validateReturnedOutboxSet(records = [], expected = [], completedAt) {
  const strictRecords = cloneOutboxBatchStrict(records, "returned outbox batch");
  if (strictRecords.length !== expected.length) {
    failUnavailable("Repository returned an unexpected public outbox event count.");
  }
  let sawTerminal = false;
  return Object.freeze(strictRecords.map((record, index) => {
    const item = expected[index];
    if (sawTerminal) failUnavailable("Repository returned an event after the terminal event.");
    if (
      !record ||
      typeof record.outboxId !== "string" ||
      !record.outboxId ||
      record.type !== item.type ||
      record.createdAt !== completedAt ||
      item.createdAt !== completedAt ||
      contractDigest(record.payload || {}) !== contractDigest(item.payload || {}) ||
      record.expectedPreviousSeq !== item.expectedPreviousSeq ||
      record.expectedPreviousHash !== item.expectedPreviousHash ||
      record.expectedEventHash !== item.expectedEventHash
    ) {
      failUnavailable("Repository returned an outbox event outside the expected completion set.");
    }
    if (TERMINAL_EVENT_TYPES.completed === record.type || TERMINAL_EVENT_TYPES.failed === record.type || TERMINAL_EVENT_TYPES.cancelled === record.type) {
      sawTerminal = true;
    }
    return record;
  }));
}

function validateCompletionCursor(value, label) {
  assertExactDataKeys(value, COMPLETION_OUTBOX_CURSOR_KEYS, [], label);
  const cursor = canonicalPlainJsonClone(value, label);
  if (
    cursor.firstSeq !== 1 ||
    cursor.prunedThroughSeq !== 0 ||
    !Number.isSafeInteger(cursor.lastSeq) ||
    cursor.lastSeq < 0 ||
    !/^[a-f0-9]{64}$/u.test(cursor.lastHash) ||
    ((cursor.lastSeq === 0) !== (cursor.lastHash === ZERO_DIGEST))
  ) {
    failUnavailable(`${label} is invalid.`);
  }
  return cursor;
}

function completionMetadataFor({ records = [], runRecord = {}, scope = {}, cursor = {}, threadRecord = null }) {
  return Object.freeze({
    schemaVersion: COMPLETION_OUTBOX_METADATA_VERSION,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    threadId: scope.threadId,
    runId: scope.runId,
    status: runRecord.status,
    completedAt: runRecord.completedAt,
    runtimeRevision: assertRuntimeRevision(runRecord.authority?.runtimeRevision, "completion metadata runtime"),
    completionRevision: assertRevision(runRecord.revision, "completion metadata run"),
    threadRevision: threadRecord ? assertRevision(threadRecord.revision, "completion metadata thread") : runRecord.authority?.completionOutbox?.threadRevision,
    originalCursor: validateCompletionCursor(cursor, "completion metadata cursor"),
    outboxIds: Object.freeze(records.map((record) => record.outboxId)),
    eventTypes: Object.freeze(records.map((record) => record.type)),
    eventHashes: Object.freeze(records.map((record) => record.expectedEventHash)),
    orderedBundleDigest: outboxBundleDigest(records),
  });
}

function validateCompletionOutboxMetadata(runRecord = {}, scope = {}, records = [], options = {}) {
  const metadata = runRecord.authority?.completionOutbox;
  assertExactDataKeys(metadata, COMPLETION_OUTBOX_METADATA_KEYS, [], "completion outbox metadata");
  const cloned = canonicalPlainJsonClone(metadata, "completion outbox metadata");
  const cursor = options.expectedCursor
    ? validateCompletionCursor({
        firstSeq: options.expectedCursor.firstSeq ?? 1,
        lastSeq: options.expectedCursor.lastSeq,
        lastHash: options.expectedCursor.lastHash,
        prunedThroughSeq: options.expectedCursor.prunedThroughSeq ?? 0,
      }, "completion outbox metadata expected cursor")
    : validateCompletionCursor(cloned.originalCursor, "completion outbox metadata cursor");
  const expected = completionMetadataFor({
    records,
    runRecord,
    scope,
    cursor,
    threadRecord: options.threadRecord || null,
  });
  if (contractDigest(cloned) !== contractDigest(expected)) {
    failUnavailable("Terminal run completion outbox metadata does not match the durable bundle.");
  }
  return expected;
}

export function createAgintiIntegrationRuntimeAuthority(options = {}) {
  rejectRemovedDependencyOptions(options);
  rejectThenableDependency(options.cancellationAttestation, "cancellation attestation");
  rejectThenableDependency(options.hardenedSandboxAttestation, "hardened sandbox attestation");
  rejectThenableDependency(options.hardenedSandboxAttestation?.isolationAttestation, "hardened sandbox isolation attestation");
  const repository = validateRepository(options.threadSessionRepository);
  const eventLedgerStore = validateEventLedgerStore(options.eventLedgerStore);
  const retainedNativeExecutionEvidence = options.retainedNativeExecutionEvidence === undefined
    ? null
    : assertRetainedIntegrationNativeExecutionEvidence(options.retainedNativeExecutionEvidence);
  const retainedRecoveryCoordinator = options.retainedRecoveryCoordinator === undefined
    ? null
    : assertRetainedIntegrationRuntimeRecoveryCoordinator(options.retainedRecoveryCoordinator, {
        repository: options.threadSessionRepository,
        nativeExecutionEvidence: retainedNativeExecutionEvidence,
      });
  if (Boolean(retainedNativeExecutionEvidence) !== Boolean(retainedRecoveryCoordinator)) {
    failUnavailable("Retained native execution evidence and recovery coordinator must be supplied together.");
  }
  if (
    retainedNativeExecutionEvidence &&
    repository.attestation.retainedDescriptorStorageAuthority !== true
  ) {
    failUnavailable("Retained native execution evidence requires the retained repository authority.");
  }
  const runRegistry = createIntegrationRunRegistry();
  const projector = createIntegrationCoreEventProjector({ eventLedgerStore });
  validateNativeRuntimeRootsAttestation(repository.attestation.runtimeRoots);
  const runtimeRootsAttestation = repository.attestation.runtimeRoots;
  let processOwnerPromise = null;
  const reconciliationByScope = new Map();
  const operationGateByScope = new Map();

  function processOwner() {
    processOwnerPromise ||= currentProcessOwner();
    return processOwnerPromise;
  }

  async function callRepository(method, payload) {
    return repository.methods[method](Object.freeze({ ...payload }));
  }

  function operationGateKey(scope) {
    return `${scope.principalId}\n${scope.browserSessionId}`;
  }

  async function withScopeOperationGate(scope, operation) {
    const key = operationGateKey(scope);
    const previous = operationGateByScope.get(key) || Promise.resolve();
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    operationGateByScope.set(key, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      releaseGate();
      if (operationGateByScope.get(key) === tail) operationGateByScope.delete(key);
    }
  }

  function outboxScopeFromFallback(fallbackScope = {}) {
    return Object.freeze({
      principalId: assertPrincipalId(fallbackScope.principalId),
      browserSessionId: assertBrowserSessionId(fallbackScope.browserSessionId),
      browserSessionPolicy: "same-browser-session",
      threadId: validateIntegrationThreadId(fallbackScope.threadId),
      runId: validateIntegrationRunId(fallbackScope.runId),
    });
  }

  function assertOutboxRecordScope(record = {}, scope) {
    if (
      record.principalId !== scope.principalId ||
      record.browserSessionId !== scope.browserSessionId ||
      record.browserSessionPolicy !== "same-browser-session" ||
      record.threadId !== scope.threadId ||
      record.runId !== scope.runId
    ) {
      authorityFail("NOT_FOUND", "Run events were not found.", { status: 404 });
    }
    validateIntegrationThreadId(record.threadId);
    validateIntegrationRunId(record.runId);
  }

  function classificationFromDurableRun(run = {}) {
    const status = run.status;
    if (!TERMINAL_STATUSES.has(status)) {
      failUnavailable("Repository returned pending outbox for a non-terminal run.");
    }
    const persistedRuntimeRevision = assertRuntimeRevision(run.authority?.runtimeRevision, "durable run authority");
    if (!run.completedAt) failUnavailable("Terminal run outbox is missing completedAt.");
    if (status === "completed") {
      if (run.error) failUnavailable("Completed run must not carry a public error.");
      if (run.output) assertNoUnsafeCoreEventFields({ output: run.output }, "run output");
      return Object.freeze({
        status,
        output: run.output || "",
        error: null,
        persistedRuntimeRevision,
        digest: contractDigest({
          durableRun: run.id,
          status,
          outputDigest: run.output ? contractDigest(run.output) : ZERO_DIGEST,
        }),
      });
    }
    if (!run.error || typeof run.error !== "object" || Array.isArray(run.error)) {
      failUnavailable("Failed/cancelled run must carry a public error envelope.");
    }
    if (!PUBLIC_ERROR_CODES.has(run.error.code)) failUnavailable("Run error code is not public.");
    assertNoUnsafeCoreEventFields({ message: run.error.message || "" }, "run error");
    return Object.freeze({
      status,
      output: "",
      error: run.error,
      persistedRuntimeRevision,
      digest: contractDigest({ durableRun: run.id, status, errorCode: run.error.code }),
    });
  }

  function validateDurableRunOutboxBatch(records = [], runRecord = {}, scope = {}, options = {}) {
    const strictRecords = cloneOutboxBatchStrict(records, "durable outbox batch");
    if (strictRecords.length === 0) return Object.freeze([]);
    for (const record of strictRecords) assertOutboxRecordScope(record, scope);
    if (runRecord.id !== scope.runId || runRecord.threadId !== scope.threadId) {
      failUnavailable("Durable outbox does not match the owned run.");
    }
    assertOwnedBinding(runRecord, scope, "Run");
    const metadata = validateCompletionOutboxMetadata(runRecord, scope, strictRecords, {
      threadRecord: options.threadRecord || null,
      ...(options.expectedCursor ? { expectedCursor: options.expectedCursor } : {}),
    });
    const classification = classificationFromDurableRun(runRecord);
    const expected = expectedCompletionEvents({
      classification,
      status: runRecord.status,
      completedAt: runRecord.completedAt,
      cursor: metadata.originalCursor,
      threadId: scope.threadId,
      runId: scope.runId,
    });
    return validateReturnedOutboxSet(strictRecords, expected, runRecord.completedAt);
  }

  function validateCompletionBundle({ bundleRecords = [], pendingRecords = [], runRecord = {}, threadRecord = null, scope = {} }) {
    const full = validateDurableRunOutboxBatch(bundleRecords, runRecord, scope, { threadRecord });
    if (!Array.isArray(pendingRecords) || pendingRecords.length === 0) {
      failUnavailable("Pending outbox identifiers are unavailable.");
    }
    const pending = cloneOutboxBatchStrict(pendingRecords, "pending outbox batch");
    const bundleIds = new Set(full.map((record) => record.outboxId));
    for (const pendingRecord of pending) {
      assertOutboxRecordScope(pendingRecord, scope);
      if (!bundleIds.has(pendingRecord.outboxId)) {
        failUnavailable("Pending outbox identifier is not part of the durable completion bundle.");
      }
    }
    return full;
  }

  async function drainOutboxRecords(records = [], fallbackScope = {}, ownedRun = null, options = {}) {
    if (!Array.isArray(records)) failUnavailable("Repository returned an invalid outbox batch.");
    if (records.length === 0) return Object.freeze([]);
    const scope = outboxScopeFromFallback(fallbackScope);
    const batch = ownedRun
      ? validateDurableRunOutboxBatch(records, ownedRun, scope, {
          threadRecord: options.threadRecord || null,
          ...(options.expectedCursor ? { expectedCursor: options.expectedCursor } : {}),
        })
      : cloneOutboxBatchStrict(records, "public outbox batch");
    const delivered = [];
    const suppressDeliveryErrors = options.suppressDeliveryErrors === true;
    const existingEvents = new Map();
    for (const record of batch) {
      assertOutboxRecordScope(record, scope);
      let existing = null;
      try {
        existing = await eventLedgerStore.lookupByOutboxId(scope, { outboxId: record.outboxId });
      } catch (error) {
        if (suppressDeliveryErrors) return Object.freeze(delivered);
        throw error;
      }
      if (existing) {
        verifyOutboxEvent(record, existing, scope);
        existingEvents.set(record.outboxId, existing);
      }
    }
    for (const record of batch) {
      assertOutboxRecordScope(record, scope);
      let event = existingEvents.get(record.outboxId) || null;
      if (!event && typeof eventLedgerStore.appendByOutboxId === "function") {
        try {
          event = await eventLedgerStore.appendByOutboxId(scope, {
            outboxId: record.outboxId,
            type: record.type,
            payload: record.payload || {},
            createdAt: record.createdAt,
            expectedPreviousSeq: record.expectedPreviousSeq,
            expectedPreviousHash: record.expectedPreviousHash,
            expectedEventHash: record.expectedEventHash,
          });
        } catch (error) {
          if (suppressDeliveryErrors) return Object.freeze(delivered);
          throw error;
        }
        verifyOutboxEvent(record, event, scope);
      }
      if (!event) failUnavailable("Public event ledger cannot publish the durable outbox idempotently.");
      let marked;
      try {
        marked = await callRepository("markIntegrationOutboxDelivered", {
          outboxId: record.outboxId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          threadId: scope.threadId,
          runId: scope.runId,
          eventSeq: event.seq,
          eventHash: event.hash,
          eventDigest: contractDigest(event),
        });
      } catch (error) {
        if (suppressDeliveryErrors) return Object.freeze(delivered);
        throw error;
      }
      if (marked?.delivered !== true) failUnavailable("Repository did not mark the outbox event as delivered.");
      if (record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled") {
        projector.clearRun(scope, { terminal: true });
      }
      delivered.push(event);
    }
    return Object.freeze(delivered);
  }

  function groupOutboxRecordsByRun(records = []) {
    const groups = new Map();
    for (const record of records || []) {
      const runId = validateIntegrationRunId(record.runId);
      if (!groups.has(runId)) groups.set(runId, []);
      groups.get(runId).push(record);
    }
    return groups;
  }

  async function drainPendingOutboxRecords(records = [], baseScope = {}) {
    if (!Array.isArray(records) || records.length === 0) return Object.freeze([]);
    const delivered = [];
    for (const [runId, batch] of groupOutboxRecordsByRun(records)) {
      const run = await loadRun(runId, baseScope);
      const thread = await assertRunThreadMapping(run, baseScope);
      const scope = Object.freeze({
        principalId: baseScope.principalId,
        browserSessionId: baseScope.browserSessionId,
        browserSessionPolicy: "same-browser-session",
        threadId: run.threadId,
        runId: run.id,
      });
      const bundleResult = await callRepository("getIntegrationCompletionOutboxBundle", {
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        threadId: scope.threadId,
        runId: scope.runId,
      });
      const bundle = validateCompletionBundle({
        bundleRecords: unwrap(bundleResult, "outboxEvents") || [],
        pendingRecords: batch,
        runRecord: run,
        threadRecord: thread,
        scope,
      });
      delivered.push(...(await drainOutboxRecords(bundle, scope, run, { threadRecord: thread })));
    }
    return Object.freeze(delivered);
  }

  async function ensureReconciled(scope) {
    const key = `${scope.principalId}\n${scope.browserSessionId}`;
    if (reconciliationByScope.has(key)) return reconciliationByScope.get(key);
    const promise = withScopeOperationGate(scope, async () => {
      const liveRunClaims = validateLiveRunClaims(runRegistry.listLiveRunClaims(scope), scope);
      const owner = await processOwner();
      const request = buildDispatchReconciliationRequest(scope, owner, liveRunClaims);
      const response = await validateDispatchReconciliationResponse(
        await callRepository("reconcileIntegrationDispatches", request),
        request
      );
      await drainPendingOutboxRecords(response.pendingOutboxEvents, scope);
      return response;
    });
    reconciliationByScope.set(key, promise);
    promise
      .finally(() => {
        if (reconciliationByScope.get(key) === promise) reconciliationByScope.delete(key);
      })
      .catch(() => {});
    return promise;
  }

  async function loadThread(threadId, scope) {
    const id = validateIntegrationThreadId(threadId);
    const result = await callRepository("getIntegrationThread", {
      threadId: id,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
    });
    const record = snapshotThreadRecord(unwrap(snapshotRepositoryEnvelope(result, "get thread response"), "thread"), "loaded thread");
    threadPublicRecord(record, scope, id);
    return record;
  }

  async function loadRun(runId, scope) {
    const id = validateIntegrationRunId(runId);
    const result = await callRepository("getIntegrationRun", {
      runId: id,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
    });
    const record = snapshotRunRecord(unwrap(snapshotRepositoryEnvelope(result, "get run response"), "run"), "loaded run");
    if (!record) notFound("Run");
    assertRunNotRecoveryHeld(record);
    await runPublicRecord(record, scope, eventLedgerStore, id);
    return record;
  }

  async function assertRunThreadMapping(run, scope) {
    const thread = await loadThread(run.threadId, scope);
    if (thread.nativeSessionId !== run.nativeSessionId) failUnavailable("Run repository changed the native session mapping.");
    return thread;
  }

  async function assertNoActiveRun(thread, scope) {
    if (runRegistry.hasActiveThreadRun(thread.id)) conflict("RUN_CONFLICT", "Thread already has an active integration run.");
    const result = await callRepository("getActiveIntegrationRunForThread", {
      threadId: thread.id,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
    });
    const active = snapshotRunRecord(unwrap(snapshotRepositoryEnvelope(result, "active run response"), "run"), "active run");
    if (active && ACTIVE_RUN_STATUSES.has(active.status)) conflict("RUN_CONFLICT", "Thread already has an active integration run.");
  }

  function assertRunFields(run, expected, label) {
    if (expected.runId && run.id !== expected.runId) failUnavailable(`${label} id did not match.`);
    if (expected.threadId && run.threadId !== expected.threadId) failUnavailable(`${label} thread did not match.`);
    if (expected.nativeSessionId && run.nativeSessionId !== expected.nativeSessionId) failUnavailable(`${label} native session did not match.`);
    if (expected.principalId && run.principalId !== expected.principalId) notFound("Run");
    if (expected.browserSessionId && run.browserSessionId !== expected.browserSessionId) notFound("Run");
    if (expected.status && run.status !== expected.status) failUnavailable(`${label} status did not match.`);
    if (expected.allowedStatuses && !expected.allowedStatuses.has(run.status)) failUnavailable(`${label} status did not match.`);
    if (expected.runtimeRevision !== undefined && run.authority?.runtimeRevision !== expected.runtimeRevision) {
      failUnavailable(`${label} native runtime revision did not match.`);
    }
    if (expected.dispatchLeaseId && run.dispatchLeaseId !== expected.dispatchLeaseId) failUnavailable(`${label} dispatch lease did not match.`);
    if (expected.dispatchOutbox !== undefined && run.dispatchOutbox !== expected.dispatchOutbox) {
      failUnavailable(`${label} dispatch outbox flag did not match.`);
    }
    if (expected.createdAt && run.createdAt !== expected.createdAt) failUnavailable(`${label} creation timestamp did not match.`);
    if (expected.startedAt && run.startedAt !== expected.startedAt) failUnavailable(`${label} start timestamp did not match.`);
    if (expected.dispatchedAt && run.dispatchedAt !== expected.dispatchedAt) failUnavailable(`${label} dispatch timestamp did not match.`);
    if (expected.cancelRequestedAt && run.cancelRequestedAt !== expected.cancelRequestedAt) {
      failUnavailable(`${label} cancellation timestamp did not match.`);
    }
    if (expected.completedAt && run.completedAt !== expected.completedAt) failUnavailable(`${label} completion timestamp did not match.`);
    if (expected.processOwner) assertProcessOwner(run, expected.processOwner, label);
  }

  function attemptDigestFor(attempt = {}) {
    const { attemptDigest: _attemptDigest, ...unsigned } = attempt;
    return contractDigest(unsigned);
  }

  function nativeStartAuthorizationDigestFor(authorization = {}) {
    const {
      authorizationId: _authorizationId,
      authorizationDigest: _authorizationDigest,
      ...unsigned
    } = authorization;
    return contractDigest(unsigned);
  }

  function nativeStartAuthorizationIdForDigest(digest) {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
      failUnavailable("Native start authorization digest is invalid.");
    }
    return `nstart_${digest.slice(0, 48)}`;
  }

  function validateNativeStartAuthorizationRecord(record = {}, label = "native start authorization") {
    assertExactDataKeys(record, NATIVE_START_AUTHORIZATION_KEYS, [], label);
    const clone = canonicalPlainJsonClone(record, label);
    if (clone.schemaVersion !== NATIVE_START_AUTHORIZATION_VERSION) {
      failUnavailable("Native start authorization schema is invalid.");
    }
    if (clone.mode !== "start" && clone.mode !== "resume") failUnavailable("Native start authorization mode is invalid.");
    assertPrincipalId(clone.principalId);
    assertBrowserSessionId(clone.browserSessionId);
    if (clone.browserSessionPolicy !== "same-browser-session") failUnavailable("Native start authorization browser policy is invalid.");
    validateIntegrationThreadId(clone.threadId);
    validateIntegrationRunId(clone.runId);
    assertNativeSessionId(clone.nativeSessionId);
    if (clone.mode === "start") {
      if (
        clone.previousRunId !== null ||
        clone.previousRunRevision !== null ||
        clone.previousRunRuntimeRevision !== null
      ) {
        failUnavailable("Start native authorization must not bind a previous run.");
      }
    } else {
      validateIntegrationRunId(clone.previousRunId);
      assertRevision(clone.previousRunRevision, "previous run");
      assertRuntimeRevision(clone.previousRunRuntimeRevision, "previous run runtime");
    }
    assertRevision(clone.threadRevision, "native start authorization thread");
    if (typeof clone.threadPreservationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(clone.threadPreservationDigest)) {
      failUnavailable("Native start authorization thread preservation digest is invalid.");
    }
    assertCanonicalIso(clone.createdAt, "native start authorization createdAt");
    assertCanonicalIso(clone.startedAt, "native start authorization startedAt");
    if (clone.startedAt !== clone.createdAt) failUnavailable("Native start authorization start timestamp is invalid.");
    const expectedNativeRevision = assertRuntimeRevision(
      clone.expectedNativeRuntimeRevision,
      "native start authorization expected runtime"
    );
    if (clone.mode === "resume" && clone.previousRunRuntimeRevision !== expectedNativeRevision) {
      failUnavailable("Resume native authorization previous runtime revision did not match the dispatched runtime.");
    }
    const targetNativeRevision = assertRuntimeRevision(
      clone.targetNativeRuntimeRevision,
      "native start authorization target runtime"
    );
    if (clone.mode === "start" && targetNativeRevision !== expectedNativeRevision) {
      failUnavailable("Start native authorization target runtime revision is invalid.");
    }
    if (clone.mode === "resume" && targetNativeRevision !== expectedNativeRevision + 1) {
      failUnavailable("Resume native authorization target runtime revision is invalid.");
    }
    if (assertRevision(clone.expectedRunRevision, "native start authorization run") !== 2) {
      failUnavailable("Native start authorization must bind dispatched run revision 2.");
    }
    if (assertRevision(clone.targetRunRevision, "native start authorization run target") !== 3) {
      failUnavailable("Native start authorization must advance the run to revision 3.");
    }
    if (typeof clone.dispatchLeaseId !== "string" || !/^[a-f0-9]{64}$/u.test(clone.dispatchLeaseId)) {
      failUnavailable("Native start authorization dispatch lease is invalid.");
    }
    if (clone.dispatchOutbox !== true) failUnavailable("Native start authorization dispatch outbox flag is invalid.");
    assertCanonicalIso(clone.dispatchedAt, "native start authorization dispatchedAt");
    assertProcessOwnerEnvelope(clone.processOwner, "native start authorization");
    assertCanonicalIso(clone.authorizedAt, "native start authorization authorizedAt");
    if (clone.authorizedAt !== clone.dispatchedAt) {
      failUnavailable("Native start authorization must use a durable dispatch timestamp.");
    }
    const digest = nativeStartAuthorizationDigestFor(clone);
    if (clone.authorizationDigest !== digest) failUnavailable("Native start authorization digest is invalid.");
    if (clone.authorizationId !== nativeStartAuthorizationIdForDigest(digest)) {
      failUnavailable("Native start authorization id is invalid.");
    }
    return clone;
  }

  function buildNativeStartAuthorization({ mode, scope, thread, run, previousRun = null, targetNativeRuntimeRevision }) {
    const threadSnapshot = snapshotThreadRecord(thread, "native start authorization thread");
    const runSnapshot = snapshotRunRecord(run, "native start authorization run");
    if (!Object.prototype.hasOwnProperty.call(runSnapshot, "nativeStartReceipt") || runSnapshot.nativeStartReceipt !== null) {
      failUnavailable("Dispatched run must not already contain a native start receipt.");
    }
    if (runSnapshot.status !== "running" || assertRevision(runSnapshot.revision, "dispatched run") !== 2) {
      failUnavailable("Native start authorization requires a dispatched running revision 2 run.");
    }
    assertRunFields(runSnapshot, {
      runId: runSnapshot.id,
      threadId: threadSnapshot.id,
      nativeSessionId: threadSnapshot.nativeSessionId,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      status: "running",
      runtimeRevision: threadRuntimeRevision(threadSnapshot, "native start authorization thread"),
      createdAt: runSnapshot.createdAt,
      startedAt: runSnapshot.createdAt,
      dispatchLeaseId: runSnapshot.dispatchLeaseId,
      dispatchOutbox: true,
      dispatchedAt: runSnapshot.dispatchedAt,
      processOwner: runSnapshot.processOwner,
    }, "native start authorization run");
    const previousRunSnapshot = previousRun ? snapshotRunRecord(previousRun, "native start authorization previous run") : null;
    const previousRunId = runSnapshot.previousRunId ?? null;
    const base = {
      schemaVersion: NATIVE_START_AUTHORIZATION_VERSION,
      mode,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      browserSessionPolicy: "same-browser-session",
      threadId: threadSnapshot.id,
      runId: runSnapshot.id,
      nativeSessionId: threadSnapshot.nativeSessionId,
      previousRunId,
      previousRunRevision: previousRunSnapshot ? assertRevision(previousRunSnapshot.revision, "previous run") : null,
      previousRunRuntimeRevision: previousRunSnapshot
        ? assertRuntimeRevision(previousRunSnapshot.authority?.runtimeRevision, "previous run runtime")
        : null,
      threadRevision: assertRevision(threadSnapshot.revision, "native start authorization thread"),
      threadPreservationDigest: threadPreservationDigestFor(threadSnapshot, "native start authorization thread"),
      createdAt: runSnapshot.createdAt,
      startedAt: runSnapshot.startedAt,
      expectedNativeRuntimeRevision: assertRuntimeRevision(runSnapshot.authority?.runtimeRevision, "native start authorization runtime"),
      targetNativeRuntimeRevision: assertRuntimeRevision(targetNativeRuntimeRevision, "native start authorization target runtime"),
      expectedRunRevision: assertRevision(runSnapshot.revision, "native start authorization run"),
      targetRunRevision: assertRevision(runSnapshot.revision, "native start authorization run") + 1,
      dispatchLeaseId: runSnapshot.dispatchLeaseId,
      dispatchOutbox: runSnapshot.dispatchOutbox,
      dispatchedAt: runSnapshot.dispatchedAt,
      processOwner: assertProcessOwnerEnvelope(runSnapshot.processOwner, "native start authorization"),
      authorizedAt: runSnapshot.dispatchedAt,
      authorizationId: "",
      authorizationDigest: ZERO_DIGEST,
    };
    if (mode === "start" && previousRunSnapshot) failUnavailable("Start native authorization cannot bind a previous run.");
    if (mode === "resume") {
      if (!previousRunSnapshot || previousRunId !== previousRunSnapshot.id) notFound("Run");
      if (previousRunSnapshot.threadId !== threadSnapshot.id || previousRunSnapshot.nativeSessionId !== threadSnapshot.nativeSessionId) {
        failUnavailable("Resume native authorization previous run lineage is invalid.");
      }
    }
    const digest = nativeStartAuthorizationDigestFor(base);
    return validateNativeStartAuthorizationRecord(Object.freeze({
      ...base,
      authorizationId: nativeStartAuthorizationIdForDigest(digest),
      authorizationDigest: digest,
    }));
  }

  function assertNativeStartReceipt(receipt, authorization, label = "native start receipt") {
    const sealed = validateNativeStartAuthorizationRecord(receipt, label);
    if (sealed.authorizationDigest !== authorization.authorizationDigest) {
      failUnavailable("Native start receipt digest did not match the authorization.");
    }
    if (contractDigest(sealed) !== contractDigest(authorization)) {
      failUnavailable("Native start receipt did not match the authorization.");
    }
    return sealed;
  }

  function validateNativeStartAuthorizationResponse(result, authorization) {
    let response = result;
    if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "authorization")) {
      assertExactDataKeys(result, ["authorization"], [], "native start authorization response wrapper");
      response = result.authorization;
    }
    assertExactDataKeys(response, NATIVE_START_AUTHORIZATION_RESPONSE_KEYS, [], "native start authorization response");
    const cloned = canonicalPlainJsonClone(response, "native start authorization response");
    if (cloned.schemaVersion !== NATIVE_START_AUTHORIZATION_VERSION) {
      failUnavailable("Native start authorization response schema is invalid.");
    }
    if (cloned.authorizationId !== authorization.authorizationId || cloned.authorizationDigest !== authorization.authorizationDigest) {
      failUnavailable("Native start authorization response did not match the request.");
    }
    if (cloned.outcome !== "authorized" && cloned.outcome !== "already-authorized") {
      failUnavailable("Native start authorization response outcome is invalid.");
    }
    if (cloned.authorized !== true || cloned.idempotent !== (cloned.outcome === "already-authorized")) {
      failUnavailable("Native start authorization response flags are invalid.");
    }
    const receipt = assertNativeStartReceipt(cloned.receipt, authorization);
    const run = snapshotRunRecord(cloned.run, "authorized native start run");
    const thread = snapshotThreadRecord(cloned.thread, "authorized native start thread");
    if (!run || !thread) failUnavailable("Native start authorization response must include run and thread.");
    assertRunFields(run, {
      runId: authorization.runId,
      threadId: authorization.threadId,
      nativeSessionId: authorization.nativeSessionId,
      principalId: authorization.principalId,
      browserSessionId: authorization.browserSessionId,
      status: "running",
      runtimeRevision: authorization.expectedNativeRuntimeRevision,
      createdAt: authorization.createdAt,
      startedAt: authorization.startedAt,
      dispatchLeaseId: authorization.dispatchLeaseId,
      dispatchOutbox: true,
      dispatchedAt: authorization.dispatchedAt,
      processOwner: authorization.processOwner,
    }, "authorized native start run");
    if (
      run.previousRunId !== authorization.previousRunId ||
      run.revision !== authorization.targetRunRevision ||
      run.hidden !== false ||
      run.tombstone !== false ||
      run.cancelRequestedAt !== null ||
      run.completedAt !== null ||
      run.output !== "" ||
      run.error !== null
    ) {
      failUnavailable("Authorized native start run did not match the authorization.");
    }
    assertNativeStartReceipt(run.nativeStartReceipt, authorization, "authorized run native start receipt");
    if (
      thread.id !== authorization.threadId ||
      thread.nativeSessionId !== authorization.nativeSessionId ||
      thread.principalId !== authorization.principalId ||
      thread.browserSessionId !== authorization.browserSessionId ||
      thread.browserSessionPolicy !== "same-browser-session" ||
      thread.status !== "running" ||
      thread.lastRunId !== authorization.runId ||
      thread.updatedAt !== authorization.createdAt ||
      thread.revision !== authorization.threadRevision ||
      threadRuntimeRevision(thread, "authorized native start thread") !== authorization.expectedNativeRuntimeRevision
    ) {
      failUnavailable("Authorized native start thread did not match the authorization.");
    }
    if (threadPreservationDigestFor(thread, "authorized native start thread") !== authorization.threadPreservationDigest) {
      failUnavailable("Authorized native start thread preservation digest did not match.");
    }
    return Object.freeze({ outcome: cloned.outcome, receipt, run, thread });
  }

  function recoveryStateDigestFor(state = {}) {
    const { digest: _digest, ...unsigned } = state;
    return contractDigest(unsigned);
  }

  function validateNativeStartRecoveryState(state = {}, label = "native start recovery state") {
    assertExactDataKeys(state, NATIVE_START_RECOVERY_STATE_KEYS, [], label);
    const clone = canonicalPlainJsonClone(state, label);
    if (
      clone.schemaVersion !== NATIVE_START_RECOVERY_STATE_VERSION ||
      clone.status !== "recovery_hold" ||
      clone.reason !== "retained_descriptor_unavailable"
    ) {
      failUnavailable("Native start recovery state is invalid.");
    }
    if (typeof clone.authorizationId !== "string" || !/^nstart_[a-f0-9]{48}$/u.test(clone.authorizationId)) {
      failUnavailable("Native start recovery authorization id is invalid.");
    }
    if (typeof clone.authorizationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(clone.authorizationDigest)) {
      failUnavailable("Native start recovery authorization digest is invalid.");
    }
    const sourceRunRevision = assertRevision(clone.sourceRunRevision, "native start recovery source run");
    const appliedRunRevision = assertRevision(clone.appliedRunRevision, "native start recovery applied run");
    if (appliedRunRevision !== sourceRunRevision + 1) {
      failUnavailable("Native start recovery revision transition is invalid.");
    }
    assertCanonicalIso(clone.heldAt, "native start recovery heldAt");
    assertProcessOwnerEnvelope(clone.observedByProcessOwner, "native start recovery");
    if (clone.digest !== recoveryStateDigestFor(clone)) failUnavailable("Native start recovery digest is invalid.");
    return clone;
  }

  function recoveryStateForRun(run, label = "run") {
    if (!run || !Object.prototype.hasOwnProperty.call(run, "recoveryState")) {
      failUnavailable(`${label} recovery state field is unavailable.`);
    }
    if (run.recoveryState === null || run.recoveryState === undefined) return null;
    return validateNativeStartRecoveryState(run.recoveryState, `${label} recovery state`);
  }

  function validateOptionalCancelRequestedAt(value, label = "run cancellation timestamp") {
    if (value === null) return null;
    return assertCanonicalIso(value, label);
  }

  function legalActiveRunRevisionForReceipt(run, receipt, cancelRequestedAt) {
    const targetRunRevision = assertRevision(receipt.targetRunRevision, "native start receipt target run");
    if (cancelRequestedAt) return targetRunRevision + 1;
    return targetRunRevision;
  }

  function assertRunNotRecoveryHeld(run) {
    const recovery = recoveryStateForRun(run, "loaded run");
    if (recovery?.status === "recovery_hold") {
      authorityFail("RECOVERY_HOLD", "Native start recovery is held until retained-descriptor state is available.", {
        status: 503,
      });
    }
  }

  function reconciliationRequestDigestFor(request = {}) {
    const { requestDigest: _requestDigest, ...unsigned } = request;
    return contractDigest(unsigned);
  }

  function reconciliationResponseDigestFor(response = {}) {
    const { responseDigest: _responseDigest, ...unsigned } = response;
    return contractDigest(unsigned);
  }

  function validateLiveRunClaims(claims = [], scope, label = "live run claims") {
    const cloned = canonicalPlainJsonClone(claims, label);
    if (!Array.isArray(cloned)) failUnavailable("Live run claims must be an array.");
    const seen = new Set();
    let previousRunId = "";
    return Object.freeze(cloned.map((claim, index) => {
      assertExactDataKeys(claim, DISPATCH_RECONCILIATION_LIVE_CLAIM_KEYS, [], `${label}[${index}]`);
      const runId = validateIntegrationRunId(claim.runId);
      const threadId = validateIntegrationThreadId(claim.threadId);
      const nativeSessionId = assertNativeSessionId(claim.nativeSessionId);
      assertCanonicalIso(claim.claimedAt, "live run claim claimedAt");
      if (runId <= previousRunId || seen.has(runId)) failUnavailable("Live run claims must be sorted and unique.");
      previousRunId = runId;
      seen.add(runId);
      return Object.freeze({
        runId,
        threadId,
        nativeSessionId,
        claimedAt: claim.claimedAt,
      });
    }));
  }

  function validateDispatchReconciliationRequest(request = {}, scope) {
    assertExactDataKeys(request, DISPATCH_RECONCILIATION_REQUEST_KEYS, [], "dispatch reconciliation request");
    const cloned = canonicalPlainJsonClone(request, "dispatch reconciliation request");
    if (
      cloned.schemaVersion !== DISPATCH_RECONCILIATION_VERSION ||
      cloned.principalId !== scope.principalId ||
      cloned.browserSessionId !== scope.browserSessionId ||
      cloned.browserSessionPolicy !== "same-browser-session"
    ) {
      failUnavailable("Dispatch reconciliation request scope is invalid.");
    }
    assertProcessOwnerEnvelope(cloned.processOwner, "dispatch reconciliation request");
    validateLiveRunClaims(cloned.liveRunClaims, scope);
    assertCanonicalIso(cloned.reconciledAt, "dispatch reconciliation request reconciledAt");
    if (cloned.requestDigest !== reconciliationRequestDigestFor(cloned)) {
      failUnavailable("Dispatch reconciliation request digest is invalid.");
    }
    return cloned;
  }

  function buildDispatchReconciliationRequest(scope, owner, capturedLiveRunClaims = runRegistry.listLiveRunClaims(scope)) {
    const liveRunClaims = validateLiveRunClaims(capturedLiveRunClaims, scope);
    const unsigned = Object.freeze({
      schemaVersion: DISPATCH_RECONCILIATION_VERSION,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      browserSessionPolicy: "same-browser-session",
      processOwner: assertProcessOwnerEnvelope(owner, "dispatch reconciliation"),
      liveRunClaims,
      reconciledAt: nowIso(),
      requestDigest: ZERO_DIGEST,
    });
    return validateDispatchReconciliationRequest(Object.freeze({
      ...unsigned,
      requestDigest: reconciliationRequestDigestFor(unsigned),
    }), scope);
  }

  function liveClaimMapFor(request) {
    return new Map(request.liveRunClaims.map((claim) => [claim.runId, claim]));
  }

  function liveClaimBindsDispatchWindow(claim, run, request) {
    if (!claim) return false;
    const claimedAtMs = Date.parse(claim.claimedAt);
    const dispatchedAtMs = Date.parse(run.dispatchedAt);
    const reconciledAtMs = Date.parse(request.reconciledAt);
    return (
      Number.isFinite(claimedAtMs) &&
      Number.isFinite(dispatchedAtMs) &&
      Number.isFinite(reconciledAtMs) &&
      claimedAtMs >= dispatchedAtMs &&
      claimedAtMs <= reconciledAtMs
    );
  }

  function requestLiveClaimMatchesRun(claim, run, request) {
    return Boolean(
      claim &&
        claim.runId === run.id &&
        claim.threadId === run.threadId &&
        claim.nativeSessionId === run.nativeSessionId &&
        run.principalId === request.principalId &&
        run.browserSessionId === request.browserSessionId &&
        run.browserSessionPolicy === "same-browser-session" &&
        liveClaimBindsDispatchWindow(claim, run, request)
    );
  }

  function currentLiveClaimMatchesRun(currentClaim, run, request) {
    return Boolean(
      currentClaim &&
        currentClaim.runId === run.id &&
        currentClaim.threadId === run.threadId &&
        currentClaim.nativeSessionId === run.nativeSessionId &&
        currentClaim.principalId === request.principalId &&
        currentClaim.browserSessionId === request.browserSessionId &&
        currentClaim.browserSessionPolicy === "same-browser-session" &&
        liveClaimBindsDispatchWindow(currentClaim, run, request)
    );
  }

  function currentLiveClaimMatchesRequestClaim(currentClaim, requestClaim) {
    return Boolean(
      currentClaim &&
        requestClaim &&
        currentClaim.runId === requestClaim.runId &&
        currentClaim.threadId === requestClaim.threadId &&
        currentClaim.nativeSessionId === requestClaim.nativeSessionId &&
        currentClaim.claimedAt === requestClaim.claimedAt
    );
  }

  function validateDispatchReconciliationResult(result = {}, request, liveClaims, index) {
    assertExactDataKeys(result, DISPATCH_RECONCILIATION_RESULT_KEYS, [], `dispatch reconciliation result ${index}`);
    const action = result.action;
    if (!["live", "held", "already-held"].includes(action)) {
      failUnavailable("Dispatch reconciliation result action is invalid.");
    }
    const run = snapshotRunRecord(result.run, `dispatch reconciliation run ${index}`);
    const thread = snapshotThreadRecord(result.thread, `dispatch reconciliation thread ${index}`);
    assertOwnedBinding(run, request, "Run");
    assertOwnedBinding(thread, request, "Thread");
    if (
      run.status !== "running" ||
      run.threadId !== thread.id ||
      run.nativeSessionId !== thread.nativeSessionId ||
      thread.status !== "running" ||
      thread.lastRunId !== run.id ||
      run.completedAt !== null ||
      run.hidden !== false ||
      run.tombstone !== false ||
      run.output !== "" ||
      run.error !== null
    ) {
      failUnavailable("Dispatch reconciliation run/thread result is invalid.");
    }
    const cancelRequestedAt = validateOptionalCancelRequestedAt(
      run.cancelRequestedAt,
      "dispatch reconciliation cancelRequestedAt"
    );
    const receipt = assertNativeStartReceipt(run.nativeStartReceipt, run.nativeStartReceipt, "reconciled native start receipt");
    if (
      receipt.runId !== run.id ||
      receipt.threadId !== run.threadId ||
      receipt.nativeSessionId !== run.nativeSessionId ||
      receipt.principalId !== run.principalId ||
      receipt.browserSessionId !== run.browserSessionId ||
      receipt.browserSessionPolicy !== run.browserSessionPolicy ||
      receipt.authorizationId !== run.nativeStartReceipt.authorizationId ||
      receipt.authorizationDigest !== run.nativeStartReceipt.authorizationDigest ||
      receipt.createdAt !== run.createdAt ||
      receipt.startedAt !== run.startedAt ||
      receipt.previousRunId !== run.previousRunId ||
      receipt.expectedNativeRuntimeRevision !== run.authority?.runtimeRevision ||
      receipt.expectedNativeRuntimeRevision !== threadRuntimeRevision(thread, "dispatch reconciliation thread") ||
      receipt.threadRevision !== thread.revision ||
      thread.updatedAt !== receipt.createdAt ||
      receipt.dispatchLeaseId !== run.dispatchLeaseId ||
      receipt.dispatchOutbox !== true ||
      run.dispatchOutbox !== true ||
      receipt.dispatchedAt !== run.dispatchedAt ||
      threadPreservationDigestFor(thread, "dispatch reconciliation thread") !== receipt.threadPreservationDigest
    ) {
      failUnavailable("Dispatch reconciliation receipt binding is invalid.");
    }
    const legalActiveRevision = legalActiveRunRevisionForReceipt(run, receipt, cancelRequestedAt);
    assertProcessOwner(run, receipt.processOwner, "dispatch reconciliation run");
    const claim = liveClaims.get(run.id) || null;
    const currentLiveClaim = runRegistry.getLiveRunClaim(run.id, request);
    const hasExactLiveClaim = Boolean(
        requestLiveClaimMatchesRun(claim, run, request) &&
        currentLiveClaimMatchesRun(currentLiveClaim, run, request) &&
        currentLiveClaimMatchesRequestClaim(currentLiveClaim, claim) &&
        sameProcessOwner(assertProcessOwnerEnvelope(run.processOwner, "dispatch reconciliation run"), request.processOwner)
    );
    const hasCurrentLiveRun = Boolean(
      currentLiveClaimMatchesRun(currentLiveClaim, run, request) &&
        sameProcessOwner(assertProcessOwnerEnvelope(run.processOwner, "dispatch reconciliation run"), request.processOwner)
    );
    const recoveryState = recoveryStateForRun(run, `dispatch reconciliation run ${index}`);
    if (action === "live") {
      if (!hasExactLiveClaim || recoveryState !== null || run.revision !== legalActiveRevision) {
        failUnavailable("Dispatch reconciliation live result is invalid.");
      }
    } else {
      if (hasCurrentLiveRun) failUnavailable("Dispatch reconciliation held a live owned run.");
      const recovery = recoveryState;
      if (!recovery) failUnavailable("Dispatch reconciliation recovery state is unavailable.");
      if (
        recovery.authorizationId !== receipt.authorizationId ||
        recovery.authorizationDigest !== receipt.authorizationDigest ||
        recovery.sourceRunRevision !== legalActiveRevision ||
        run.revision !== recovery.appliedRunRevision ||
        (action === "held" && recovery.heldAt !== request.reconciledAt) ||
        (action === "held" && !sameProcessOwner(recovery.observedByProcessOwner, request.processOwner))
      ) {
        failUnavailable("Dispatch reconciliation recovery state is invalid.");
      }
    }
    return Object.freeze({ action, run, thread });
  }

  async function validateReloadedDispatchReconciliationResult(result, request, liveClaims, index) {
    const runResult = snapshotRepositoryEnvelope(await callRepository("getIntegrationRun", {
      runId: result.run.id,
      principalId: request.principalId,
      browserSessionId: request.browserSessionId,
    }), `dispatch reconciliation reloaded run response ${index}`);
    const reloadedRun = snapshotRunRecord(unwrap(runResult, "run"), `dispatch reconciliation reloaded run ${index}`);
    const threadResult = snapshotRepositoryEnvelope(await callRepository("getIntegrationThread", {
      threadId: result.thread.id,
      principalId: request.principalId,
      browserSessionId: request.browserSessionId,
    }), `dispatch reconciliation reloaded thread response ${index}`);
    const reloadedThread = snapshotThreadRecord(unwrap(threadResult, "thread"), `dispatch reconciliation reloaded thread ${index}`);
    if (
      contractDigest(reloadedRun) !== contractDigest(result.run) ||
      contractDigest(reloadedThread) !== contractDigest(result.thread)
    ) {
      failUnavailable("Dispatch reconciliation result did not match the durable repository reload.");
    }
    return validateDispatchReconciliationResult(
      Object.freeze({ action: result.action, run: reloadedRun, thread: reloadedThread }),
      request,
      liveClaims,
      index
    );
  }

  async function validateDispatchReconciliationResponse(result = {}, request) {
    assertExactDataKeys(result, DISPATCH_RECONCILIATION_RESPONSE_KEYS, [], "dispatch reconciliation response");
    const cloned = canonicalPlainJsonClone(result, "dispatch reconciliation response");
    if (
      cloned.schemaVersion !== DISPATCH_RECONCILIATION_VERSION ||
      cloned.requestDigest !== request.requestDigest ||
      cloned.reconciled !== true ||
      cloned.responseDigest !== reconciliationResponseDigestFor(cloned)
    ) {
      failUnavailable("Dispatch reconciliation response is invalid.");
    }
    if (!Array.isArray(cloned.receiptRunResults) || !Array.isArray(cloned.pendingOutboxEvents)) {
      failUnavailable("Dispatch reconciliation response arrays are invalid.");
    }
    const liveClaims = liveClaimMapFor(request);
    const seen = new Set();
    let previousRunId = "";
    const receiptRunResults = [];
    for (let index = 0; index < cloned.receiptRunResults.length; index += 1) {
      const checked = await validateReloadedDispatchReconciliationResult(
        validateDispatchReconciliationResult(cloned.receiptRunResults[index], request, liveClaims, index),
        request,
        liveClaims,
        index
      );
      if (checked.run.id <= previousRunId || seen.has(checked.run.id)) {
        failUnavailable("Dispatch reconciliation results must be sorted and unique.");
      }
      previousRunId = checked.run.id;
      seen.add(checked.run.id);
      receiptRunResults.push(checked);
    }
    const frozenReceiptRunResults = Object.freeze(receiptRunResults);
    return Object.freeze({
      receiptRunResults: frozenReceiptRunResults,
      pendingOutboxEvents: cloned.pendingOutboxEvents,
      recoveryHolds: Object.freeze(frozenReceiptRunResults
        .filter((item) => item.action === "held" || item.action === "already-held")
        .map((item) => Object.freeze({ runId: item.run.id, status: "recovery_hold" }))),
    });
  }

  function sealPreLaunchAbortAttempt(attempt = {}) {
    assertExactDataKeys(attempt, PRE_LAUNCH_ABORT_ATTEMPT_KEYS, [], "pre-launch abort attempt");
    const clone = canonicalPlainJsonClone(attempt, "pre-launch abort attempt");
    if (clone.schemaVersion !== PRE_LAUNCH_ABORT_ATTEMPT_VERSION) failUnavailable("Pre-launch abort attempt schema is invalid.");
    if (clone.mode !== "start" && clone.mode !== "resume") failUnavailable("Pre-launch abort attempt mode is invalid.");
    assertPrincipalId(clone.principalId);
    assertBrowserSessionId(clone.browserSessionId);
    if (clone.browserSessionPolicy !== "same-browser-session") failUnavailable("Pre-launch abort browser policy is invalid.");
    validateIntegrationThreadId(clone.threadId);
    validateIntegrationRunId(clone.runId);
    assertNativeSessionId(clone.nativeSessionId);
    if (clone.mode === "start" && clone.previousRunId !== null) failUnavailable("Start pre-launch abort must not bind a previous run.");
    if (clone.mode === "resume") validateIntegrationRunId(clone.previousRunId);
    assertRevision(clone.previousThreadRevision, "pre-launch abort previous thread");
    assertRuntimeRevision(clone.expectedNativeRuntimeRevision, "pre-launch abort native runtime");
    if (typeof clone.threadPreservationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(clone.threadPreservationDigest)) {
      failUnavailable("Pre-launch abort thread preservation digest is invalid.");
    }
    if (clone.nativeStartReceiptMustBeAbsent !== true) {
      failUnavailable("Pre-launch abort must explicitly require native start receipt absence.");
    }
    assertCanonicalIso(clone.createdAt, "pre-launch abort createdAt");
    if (typeof clone.dispatchAttempted !== "boolean") failUnavailable("Pre-launch abort dispatch flag is invalid.");
    if (clone.dispatchAttempted) {
      if (typeof clone.dispatchLeaseId !== "string" || !/^[a-f0-9]{64}$/u.test(clone.dispatchLeaseId)) {
        failUnavailable("Pre-launch abort dispatch lease is invalid.");
      }
      if (clone.dispatchOutbox !== true) failUnavailable("Pre-launch abort dispatch outbox flag is invalid.");
      assertCanonicalIso(clone.dispatchedAt, "pre-launch abort dispatchedAt");
      assertProcessOwnerEnvelope(clone.processOwner, "pre-launch abort");
    } else if (
      clone.dispatchLeaseId !== null ||
      clone.dispatchOutbox !== false ||
      clone.dispatchedAt !== null ||
      clone.processOwner !== null
    ) {
      failUnavailable("Pre-launch abort dispatch fields are invalid.");
    }
    assertCanonicalIso(clone.abortAt, "pre-launch abort abortAt");
    if (clone.attemptDigest !== attemptDigestFor(clone)) failUnavailable("Pre-launch abort attempt digest is invalid.");
    return clone;
  }

  function buildPreLaunchAbortBase({ mode, scope, thread, runId, previousRunId, previousThreadRevision, expectedRuntimeRevision, createdAt }) {
    return Object.freeze({
      schemaVersion: PRE_LAUNCH_ABORT_ATTEMPT_VERSION,
      mode,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      browserSessionPolicy: "same-browser-session",
      threadId: thread.id,
      runId,
      nativeSessionId: assertNativeSessionId(thread.nativeSessionId),
      previousRunId,
      previousThreadRevision,
      expectedNativeRuntimeRevision: expectedRuntimeRevision,
      threadPreservationDigest: threadPreservationDigestFor(thread, "pre-launch abort original thread"),
      nativeStartReceiptMustBeAbsent: true,
      createdAt,
      dispatchAttempted: false,
      dispatchLeaseId: null,
      dispatchOutbox: false,
      dispatchedAt: null,
      processOwner: null,
      abortAt: createdAt,
      attemptDigest: ZERO_DIGEST,
    });
  }

  function markPreLaunchDispatchAttempt(attempt, { dispatchLeaseId, dispatchOutbox, dispatchedAt, processOwner }) {
    return Object.freeze({
      ...attempt,
      dispatchAttempted: true,
      dispatchLeaseId,
      dispatchOutbox,
      dispatchedAt,
      processOwner: canonicalPlainJsonClone(processOwner, "pre-launch abort process owner"),
    });
  }

  function abortAttemptWithTimestamp(attempt, abortAt) {
    const unsigned = {
      ...attempt,
      abortAt,
      attemptDigest: ZERO_DIGEST,
    };
    return sealPreLaunchAbortAttempt(Object.freeze({
      ...unsigned,
      attemptDigest: attemptDigestFor(unsigned),
    }));
  }

  function validatePreLaunchAbortResponse(result, attempt) {
    const response = unwrap(result, "abort");
    assertExactDataKeys(response, PRE_LAUNCH_ABORT_RESPONSE_KEYS, [], "pre-launch abort response");
    const cloned = canonicalPlainJsonClone(response, "pre-launch abort response");
    if (cloned.schemaVersion !== PRE_LAUNCH_ABORT_RESPONSE_VERSION) failUnavailable("Pre-launch abort response schema is invalid.");
    if (cloned.attemptDigest !== attempt.attemptDigest) failUnavailable("Pre-launch abort response digest did not match.");
    if (!["not-created", "aborted", "already-aborted"].includes(cloned.action)) {
      failUnavailable("Pre-launch abort response action is invalid.");
    }
    if (cloned.action === "not-created") {
      if (cloned.aborted !== false || cloned.idempotent !== false || cloned.run !== null || cloned.thread !== null) {
        failUnavailable("Pre-launch abort no-op response is invalid.");
      }
      return cloned;
    }
    if (cloned.aborted !== true || (cloned.action === "aborted" ? cloned.idempotent !== false : cloned.idempotent !== true)) {
      failUnavailable("Pre-launch abort applied response is invalid.");
    }
    const run = cloned.run;
    const thread = cloned.thread;
    if (!run || !thread) failUnavailable("Pre-launch abort response did not return the tombstoned run and thread.");
    if (
      run.id !== attempt.runId ||
      run.threadId !== attempt.threadId ||
      run.nativeSessionId !== attempt.nativeSessionId ||
      run.principalId !== attempt.principalId ||
      run.browserSessionId !== attempt.browserSessionId ||
      run.browserSessionPolicy !== "same-browser-session" ||
      run.previousRunId !== attempt.previousRunId ||
      run.createdAt !== attempt.createdAt ||
      run.startedAt !== attempt.createdAt ||
      run.status !== "aborted_before_launch" ||
      run.hidden !== true ||
      run.tombstone !== true ||
      run.nativeStartReceipt !== null ||
      run.completedAt !== null ||
      run.output !== "" ||
      run.error !== null ||
      run.abortAttemptDigest !== attempt.attemptDigest ||
      run.abortAt !== attempt.abortAt
    ) {
      failUnavailable("Pre-launch abort tombstoned run did not match the attempt.");
    }
    if (run.authority?.runtimeRevision !== attempt.expectedNativeRuntimeRevision) {
      failUnavailable("Pre-launch abort changed the native runtime revision.");
    }
    const runRevision = assertRevision(run.revision, "pre-launch abort run");
    if (attempt.dispatchAttempted && run.dispatchLeaseId !== null) {
      if (
        run.dispatchLeaseId !== attempt.dispatchLeaseId ||
        run.dispatchOutbox !== true ||
        run.dispatchedAt !== attempt.dispatchedAt
      ) {
        failUnavailable("Pre-launch abort did not preserve the dispatch lease.");
      }
      assertProcessOwner(run, attempt.processOwner, "pre-launch abort run");
      if (runRevision !== 3) failUnavailable("Pre-launch abort dispatched run revision is invalid.");
    } else if (attempt.dispatchAttempted) {
      if (
        run.dispatchOutbox !== false ||
        run.dispatchedAt !== null ||
        run.processOwner !== null ||
        runRevision !== 2
      ) {
        failUnavailable("Pre-launch abort starting run revision is invalid.");
      }
    } else if (
      run.dispatchLeaseId !== null ||
      run.dispatchOutbox !== false ||
      run.dispatchedAt !== null ||
      run.processOwner !== null ||
      runRevision !== 2
    ) {
      failUnavailable("Pre-launch abort run has unexpected dispatch fields.");
    }
    if (
      thread.id !== attempt.threadId ||
      thread.nativeSessionId !== attempt.nativeSessionId ||
      thread.principalId !== attempt.principalId ||
      thread.browserSessionId !== attempt.browserSessionId ||
      thread.browserSessionPolicy !== "same-browser-session" ||
      thread.status !== "idle" ||
      thread.updatedAt !== attempt.abortAt ||
      thread.lastRunId !== attempt.previousRunId ||
      thread.authority?.runtimeRevision !== attempt.expectedNativeRuntimeRevision
    ) {
      failUnavailable("Pre-launch abort thread rollback did not match the attempt.");
    }
    if (threadPreservationDigestFor(thread, "pre-launch abort returned thread") !== attempt.threadPreservationDigest) {
      failUnavailable("Pre-launch abort thread preservation digest did not match.");
    }
    const expectedThreadRevision = attempt.previousThreadRevision + 2;
    if (assertRevision(thread.revision, "pre-launch abort thread") !== expectedThreadRevision) {
      failUnavailable("Pre-launch abort thread revision did not advance exactly once after create.");
    }
    return cloned;
  }

  async function abortIntegrationRunBeforeLaunch(attemptBase) {
    const attempt = abortAttemptWithTimestamp(attemptBase, nowIso());
    const result = snapshotRepositoryEnvelope(
      await callRepository("abortIntegrationRunBeforeLaunch", { attempt }),
      "pre-launch abort response envelope"
    );
    return validatePreLaunchAbortResponse(result, attempt);
  }

  async function authorizeNativeStart(authorization, beforeRepositoryCall) {
    if (beforeRepositoryCall) beforeRepositoryCall();
    const result = snapshotRepositoryEnvelope(
      await callRepository("authorizeIntegrationRunNativeStart", { authorization }),
      "native start authorization response envelope"
    );
    const authorized = validateNativeStartAuthorizationResponse(result, authorization);
    if (authorized.outcome === "already-authorized") {
      authorityFail("RECOVERY_HOLD", "Native start authorization already exists and requires retained-descriptor recovery.", {
        status: 503,
      });
    }
    return authorized;
  }

  function prepareLaunch({ mode, thread, runId, inputText, scope }) {
    const nativeSessionId = assertNativeSessionId(thread.nativeSessionId);
    const expectedRuntimeRevision = threadRuntimeRevision(thread);
    const completedRuntimeRevision = mode === "resume" ? expectedRuntimeRevision + 1 : expectedRuntimeRevision;
    const { controller, cleanup } = createChildAbortController(scope.abortSignal);
    let eventTail = Promise.resolve();
    let observerClosed = false;
    const eventScope = Object.freeze({
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      browserSessionPolicy: "same-browser-session",
      threadId: thread.id,
      runId,
    });
    const onEvent = (type, data = {}) => {
      if (observerClosed) return;
      eventTail = eventTail.then(() => projector.appendCoreEvent(type, data, eventScope));
      eventTail.catch(() => {});
    };
    try {
      const config = buildFixedNativeRunAgentConfig({
        mode,
        policy: scope.policy,
        threadId: thread.id,
        runId,
        nativeSessionId,
        inputText,
        abortSignal: controller.signal,
        onEvent,
        repositoryRoots: runtimeRootsAttestation,
        expectedRuntimeRevision,
        ...(retainedNativeExecutionEvidence
          ? { retainedNativeExecutionEvidence }
          : {}),
      });
      return Object.freeze({
        nativeSessionId,
        expectedRuntimeRevision,
        completedRuntimeRevision,
        controller,
        cleanup,
        config,
        eventScope,
        closeObserver() {
          observerClosed = true;
        },
        async drainEvents() {
          await eventTail;
        },
      });
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async function finishWithOutbox(runId, scope, classificationInput, prepared, { suppressOutboxErrors = false } = {}) {
    const current = await loadRun(runId, scope);
    if (TERMINAL_STATUSES.has(current.status)) return current;
    const currentThread = await assertRunThreadMapping(current, scope);
    const currentThreadRevision = assertRevision(currentThread.revision, "current thread");
    const currentThreadNativeSessionId = currentThread.nativeSessionId;
    let classification = classificationInput;
    const persistedRuntimeRevision = assertRuntimeRevision(
      classification?.persistedRuntimeRevision,
      "persisted native runtime"
    );
    if (prepared?.controller?.signal?.aborted || current.cancelRequestedAt) {
      classification = Object.freeze({
        status: "cancelled",
        output: "",
        error: Object.freeze({ code: "CANCELLED", message: "Run cancelled." }),
        persistedRuntimeRevision,
        digest: contractDigest({ status: "cancelled", runId }),
      });
    }
    const status = classification.status;
    const previousRevision = assertRevision(current.revision, "run");
    const cursor = await eventCursorFor(eventLedgerStore, current, scope);
    const completedAt = nowIso();
    const owner = await processOwner();
    const completedRuntimeRevision = assertRuntimeRevision(
      classification.persistedRuntimeRevision,
      "completed native runtime"
    );
    const expectedOutboxEvents = expectedCompletionEvents({
      classification,
      status,
      completedAt,
      cursor,
      threadId: current.threadId,
      runId: current.id,
    });
    try {
      await recordRetainedNativeTerminalEvidence(prepared.config, {
        status,
        output: status === "completed" ? classification.output : "",
        error: status === "completed" ? null : classification.error,
        resultDigest: classification.digest,
        completedAt,
        persistedRuntimeRevision: completedRuntimeRevision,
      });
    } catch (error) {
      error.integrationTerminalEvidenceError = true;
      throw error;
    }
    let result;
    try {
      result = snapshotRepositoryEnvelope(await callRepository("finishIntegrationRunWithOutbox", {
      runId: current.id,
      threadId: current.threadId,
      nativeSessionId: current.nativeSessionId,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      expectedRevision: previousRevision,
      expectedNativeRuntimeRevision: prepared.expectedRuntimeRevision,
      completedNativeRuntimeRevision: completedRuntimeRevision,
      status,
      output: status === "completed" ? classification.output : "",
      error: status === "completed" ? null : classification.error,
      completedAt,
      processOwner: owner,
      expectedCursor: cursor,
      outputEvent: expectedOutboxEvents.find((event) => event.type === "output.delta") || null,
      terminalEvent: Object.freeze({ type: TERMINAL_EVENT_TYPES[status], payload: {}, createdAt: completedAt }),
      resultDigest: classification.digest,
      }), "finish run response");
    } catch (error) {
      if (retainedNativeExecutionEvidence) error.integrationTerminalCommitError = true;
      throw error;
    }
    const finished = snapshotRunRecord(unwrap(result, "run"), "finished run");
    if (result.resultDigest !== classification.digest) {
      failUnavailable("Repository did not persist the exact native terminal result digest.");
    }
    assertRunFields(finished, {
      runId: current.id,
      threadId: current.threadId,
      nativeSessionId: current.nativeSessionId,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      status,
      runtimeRevision: completedRuntimeRevision,
      completedAt,
      processOwner: owner,
    }, "finished run");
    assertRevisionAdvanced(previousRevision, finished.revision, "run");
    if (status === "completed" && finished.output !== classification.output) {
      failUnavailable("Repository did not persist the exact public run output.");
    }
    const outboxScope = Object.freeze({
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      browserSessionPolicy: "same-browser-session",
      threadId: current.threadId,
      runId: current.id,
    });
    const updatedThread = snapshotThreadRecord(unwrap(result, "thread"), "finished thread");
    if (!updatedThread || updatedThread.id !== current.threadId) failUnavailable("Repository did not return the updated thread.");
    assertOwnedBinding(updatedThread, scope, "Thread");
    if (updatedThread.nativeSessionId !== currentThreadNativeSessionId) {
      failUnavailable("Repository changed the native session mapping at completion.");
    }
    if (updatedThread.lastRunId !== current.id) failUnavailable("Repository did not preserve the finished thread lastRunId.");
    assertRevisionAdvanced(currentThreadRevision, updatedThread.revision, "finished thread");
    if (threadRuntimeRevision(updatedThread, "finished thread") !== completedRuntimeRevision) {
      failUnavailable("Repository did not advance the finished thread runtime revision.");
    }
    const returnedOutboxEvents = validateReturnedOutboxSet(result.outboxEvents || [], expectedOutboxEvents, completedAt);
    const durableOutboxEvents = validateDurableRunOutboxBatch(returnedOutboxEvents, finished, outboxScope, {
      threadRecord: updatedThread,
      expectedCursor: cursor,
    });
    await drainOutboxRecords(durableOutboxEvents, outboxScope, finished, {
      threadRecord: updatedThread,
      expectedCursor: cursor,
      suppressDeliveryErrors: suppressOutboxErrors,
    });
    return finished;
  }

function aggregateRuntimeObserverError(runtimeError, observerError) {
    if (!observerError) return runtimeError;
    const error = new Error("Native AgInTi execution failed and observer event delivery also failed.");
    error.code = runtimeError?.code || observerError?.code || "AGINTI_RUNTIME_ERROR";
    error.cause = runtimeError;
    error.observerError = observerError;
    error.persistedRuntimeRevision =
      runtimeError?.persistedRuntimeRevision ?? observerError?.persistedRuntimeRevision;
    return error;
  }

  function nativePromiseShapeIsValid(promise) {
    return Boolean(
      promise &&
        (typeof promise === "object" || typeof promise === "function") &&
        !utilTypes.isProxy(promise) &&
        utilTypes.isPromise(promise) &&
        ObjectGetPrototypeOf(promise) === PromisePrototype &&
        ReflectOwnKeys(promise).every((key) => typeof key !== "string")
    );
  }

  function createNativeDeferredPromise() {
    let resolveDeferred;
    let rejectDeferred;
    const promise = new NativePromise((resolve, reject) => {
      resolveDeferred = resolve;
      rejectDeferred = reject;
    });
    if (!nativePromiseShapeIsValid(promise)) {
      failUnavailable("Native AgInTi deferred launch promise is invalid.");
    }
    return Object.freeze({
      promise,
      resolve: resolveDeferred,
      reject: rejectDeferred,
    });
  }

  function launchExecutor({ run, scope, prepared, preflight }) {
    runRegistry.claimRun({
      runId: run.id,
      threadId: run.threadId,
      nativeSessionId: run.nativeSessionId,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      controller: prepared.controller,
    });
    let deferred;
    try {
      deferred = createNativeDeferredPromise();
      runRegistry.attachPromise(run.id, deferred.promise);
    } catch (error) {
      runRegistry.releaseRun(run.id);
      throw error;
    }
    let released = false;
    function releaseAuthorizedNativeExecution(authorizedRunInput) {
      if (released) failUnavailable("Native AgInTi execution was already released.");
      const authorizedRun = snapshotRunRecord(authorizedRunInput, "authorized native execution run");
      if (authorizedRun.id !== run.id || authorizedRun.threadId !== run.threadId || authorizedRun.nativeSessionId !== run.nativeSessionId) {
        failUnavailable("Authorized native execution run did not match the dispatch.");
      }
      released = true;
      const worker = (async () => {
        try {
          const result = await executeNativeAgintiRun(prepared.config, { preflight });
          const classification = classifyRunAgentResult(result, {
            nativeSessionId: prepared.nativeSessionId,
            abortSignal: prepared.controller.signal,
          });
          prepared.closeObserver();
          try {
            await prepared.drainEvents();
          } catch (error) {
            error.persistedRuntimeRevision = result.persistedRuntimeRevision;
            error.integrationObserverError = true;
            throw error;
          }
          return await finishWithOutbox(authorizedRun.id, scope, classification, prepared, { suppressOutboxErrors: true });
        } catch (error) {
          if (error?.integrationTerminalEvidenceError || error?.integrationTerminalCommitError) {
            throw error;
          }
          prepared.closeObserver();
          let observerError = null;
          if (error?.integrationObserverError !== true) {
            try {
              await prepared.drainEvents();
            } catch (drainError) {
              observerError = drainError;
            }
          }
          const classification = classifyRunAgentError(aggregateRuntimeObserverError(error, observerError), {
            abortSignal: prepared.controller.signal,
          });
          return await finishWithOutbox(authorizedRun.id, scope, classification, prepared, { suppressOutboxErrors: true });
        } finally {
          prepared.closeObserver();
          projector.clearRun(prepared.eventScope);
          prepared.cleanup();
          runRegistry.releaseRun(authorizedRun.id);
        }
      })();
      ReflectApply(PromisePrototypeThen, worker, [deferred.resolve, deferred.reject]);
      return deferred.promise;
    }
    function abandon(error) {
      if (released) return;
      prepared.closeObserver();
      projector.clearRun(prepared.eventScope);
      prepared.cleanup();
      runRegistry.releaseRun(run.id);
      deferred.reject(error);
    }
    return Object.freeze({
      promise: deferred.promise,
      releaseAuthorizedNativeExecution,
      abandon,
    });
  }

  function getIntegrationRuntimeProof() {
    const repositoryProof = validateRepositoryAttestation(repository.attestation, {
      requireRetainedDescriptorStorage: true,
    });
    const appendProof = validateEventAppendProof(eventLedgerStore);
    const cancellationProof = validateCancellationProof(options.cancellationAttestation);
    const sandboxProof = validateSandboxProof(options.hardenedSandboxAttestation);
    if (NATIVE_INTEGRATION_EXECUTOR_PROOF.cancellation !== true) {
      failUnavailable("native executor cancellation proof is unavailable.");
    }
    const unsignedProof = canonicalPlainJsonClone({
      schemaVersion: NATIVE_INTEGRATION_RUNTIME_PROOF_VERSION,
      owner: "aginti",
      stableSessionIds: true,
      runtimeRevisions: true,
      contextDigests: true,
      compactionMetadata: true,
      adaptersAreTransportOnly: true,
      noRawEvents: true,
      publicArtifactsOnly: false,
      noHostedProviders: NATIVE_INTEGRATION_EXECUTOR_PROOF.noHostedProviders === true,
      noWrappers: NATIVE_INTEGRATION_EXECUTOR_PROOF.noWrappers === true,
      noMcp: NATIVE_INTEGRATION_EXECUTOR_PROOF.noMcp === true,
      noWeb: NATIVE_INTEGRATION_EXECUTOR_PROOF.noWeb === true,
      sandboxPrerequisites: Object.freeze({
        owner: "aginti",
        valid: sandboxProof.valid === true,
        enabled: sandboxProof.enabled === true,
        digest: sandboxProof.digest,
      }),
      isolationAttestation: sandboxProof.isolationAttestation,
      repositoryProofDigest: repositoryProof.digest,
      executorProofDigest: NATIVE_INTEGRATION_EXECUTOR_PROOF.digest,
      eventAppendProofDigest: appendProof.digest,
      cancellationProofDigest: cancellationProof.digest,
      retainedNativeExecutionEvidenceProofDigest:
        retainedNativeExecutionEvidence?.attestation?.digest || ZERO_DIGEST,
      retainedRecoveryCoordinatorProofDigest:
        retainedRecoveryCoordinator?.attestation?.digest || ZERO_DIGEST,
    }, "integration runtime proof");
    return canonicalPlainJsonClone({
      ...unsignedProof,
      proofDigest: contractDigest(unsignedProof),
    }, "integration runtime proof");
  }

  const authority = {
    getIntegrationRuntimeProof,

    async listIntegrationThreads(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const result = snapshotRepositoryEnvelope(await callRepository("listIntegrationThreads", {
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        limit: payload.limit,
        before: payload.before || "",
      }), "list threads response");
      return Object.freeze({
        threads: Object.freeze((result.threads || []).map((thread, index) =>
          threadPublicRecord(snapshotThreadRecord(thread, `listed thread ${index}`), scope)
        )),
        nextBefore: result.nextBefore || null,
      });
    },

    async createIntegrationThread(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const threadId = runtimeId("thr");
      const nativeSessionId = nativeSessionIdForThread();
      const result = snapshotRepositoryEnvelope(await callRepository("createIntegrationThread", {
        threadId,
        nativeSessionId,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        browserSessionPolicy: "same-browser-session",
        title: payload.title || "New agent thread",
        createdAt: nowIso(),
        policyFingerprint: scope.policy.fingerprint,
      }), "create thread response");
      const thread = snapshotThreadRecord(unwrap(result, "thread"), "created thread");
      if (
        thread.id !== threadId ||
        thread.nativeSessionId !== nativeSessionId ||
        thread.revision !== 1 ||
        thread.lastRunId !== null ||
        threadRuntimeRevision(thread, "created thread") !== 1
      ) {
        failUnavailable("Thread repository did not preserve the exact public/native session mapping.");
      }
      return Object.freeze({ thread: threadPublicRecord(thread, scope, threadId) });
    },

    async getIntegrationThread(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const thread = await loadThread(payload.threadId, scope);
      return Object.freeze({ thread: threadPublicRecord(thread, scope, payload.threadId) });
    },

    async updateIntegrationThread(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const current = await loadThread(payload.threadId, scope);
      await assertNoActiveRun(current, scope);
      const previousRevision = assertRevision(current.revision, "thread");
      const result = snapshotRepositoryEnvelope(await callRepository("updateIntegrationThread", {
        threadId: current.id,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        expectedRevision: previousRevision,
        title: payload.title,
        updatedAt: nowIso(),
      }), "update thread response");
      const updated = snapshotThreadRecord(unwrap(result, "thread"), "updated thread");
      assertRevisionAdvanced(previousRevision, updated.revision, "thread");
      if (updated.nativeSessionId !== current.nativeSessionId) failUnavailable("Thread repository changed the native session mapping.");
      if (updated.lastRunId !== current.lastRunId) failUnavailable("Thread repository changed the latest run during title update.");
      if (threadRuntimeRevision(updated, "updated thread") !== threadRuntimeRevision(current, "current thread")) {
        failUnavailable("Thread repository changed runtime revision during title update.");
      }
      return Object.freeze({ thread: threadPublicRecord(updated, scope, current.id) });
    },

    async deleteIntegrationThread(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const current = await loadThread(payload.threadId, scope);
      await assertNoActiveRun(current, scope);
      const result = snapshotRepositoryEnvelope(await callRepository("deleteIntegrationThread", {
        threadId: current.id,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        expectedRevision: assertRevision(current.revision, "thread"),
      }), "delete thread response");
      if (result.thread) threadPublicRecord(snapshotThreadRecord(result.thread, "deleted thread"), scope, current.id);
      return Object.freeze({ deleted: true, threadId: current.id, principalId: scope.principalId });
    },

    async startIntegrationRun(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const gatedLaunch = await withScopeOperationGate(scope, async () => {
      const thread = await loadThread(payload.threadId, scope);
      if (thread.lastRunId !== null) failUnavailable("Start requires a pristine thread with no previous run.");
      if (threadRuntimeRevision(thread, "start thread") !== 1) failUnavailable("Start requires native runtime revision 1.");
      await assertNoActiveRun(thread, scope);
      const runId = runtimeId("run");
      const prepared = prepareLaunch({ mode: "start", thread, runId, inputText: payload.input.text, scope });
      const threadId = validateIntegrationThreadId(thread.id);
      const nativeSessionId = assertNativeSessionId(thread.nativeSessionId);
      const expectedRuntimeRevision = prepared.expectedRuntimeRevision;
      const previousThreadRevision = assertRevision(thread.revision, "thread");
      const createdAt = nowIso();
      let createAttempted = false;
      let authorizationStarted = false;
      let nativeStartReceiptObserved = false;
      let nativeLaunch = null;
      let abortAttempt = buildPreLaunchAbortBase({
        mode: "start",
        scope,
        thread,
        runId,
        previousRunId: null,
        previousThreadRevision,
        expectedRuntimeRevision,
        createdAt,
      });
      try {
        createAttempted = true;
        const createResult = snapshotRepositoryEnvelope(await callRepository("createIntegrationRun", {
          runId,
          threadId,
          nativeSessionId,
          previousRunId: null,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          browserSessionPolicy: "same-browser-session",
          expectedThreadRevision: previousThreadRevision,
          expectedNativeRuntimeRevision: expectedRuntimeRevision,
          input: Object.freeze({ text: payload.input.text }),
          createdAt,
          status: "starting",
        }), "create run response");
        const created = snapshotRunRecord(unwrap(createResult, "run"), "created run");
        assertRunFields(created, {
          runId,
          threadId,
          nativeSessionId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          status: "starting",
          runtimeRevision: expectedRuntimeRevision,
          createdAt,
          startedAt: createdAt,
        }, "created run");
        if (created.previousRunId) failUnavailable("Start run must not bind a previous run.");
        if (created.revision !== 1) failUnavailable("Run repository must durable-create a starting revision 1 run.");
        const createdThread = snapshotThreadRecord(unwrap(createResult, "thread"), "created run thread");
        if (
          !createdThread ||
          createdThread.id !== threadId ||
          createdThread.nativeSessionId !== nativeSessionId ||
          createdThread.lastRunId !== runId
        ) {
          failUnavailable("Repository did not return the updated thread for start.");
        }
        assertRevisionAdvanced(previousThreadRevision, createdThread.revision, "thread");
        if (threadPreservationDigestFor(createdThread, "created run thread") !== threadPreservationDigestFor(thread, "start thread")) {
          failUnavailable("Repository changed preserved thread fields during start.");
        }
        if (threadRuntimeRevision(createdThread, "created run thread") !== expectedRuntimeRevision) {
          failUnavailable("Repository changed thread runtime revision during start.");
        }
        const createdRevision = assertRevision(created.revision, "created run");
        const owner = await processOwner();
        const dispatchLeaseId = contractDigest({ runId, nativeSessionId, createdAt });
        const dispatchedAt = nowIso();
        abortAttempt = markPreLaunchDispatchAttempt(abortAttempt, {
          dispatchLeaseId,
          dispatchOutbox: true,
          dispatchedAt,
          processOwner: owner,
        });
        const dispatchResult = snapshotRepositoryEnvelope(await callRepository("markIntegrationRunDispatching", {
          runId,
          threadId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          expectedRevision: createdRevision,
          expectedNativeRuntimeRevision: expectedRuntimeRevision,
          dispatchLeaseId,
          dispatchOutbox: true,
          processOwner: owner,
          dispatchedAt,
        }), "dispatch run response");
        const dispatched = snapshotRunRecord(unwrap(dispatchResult, "run"), "dispatched run");
        assertRevisionAdvanced(createdRevision, dispatched.revision, "run");
        assertRunFields(dispatched, {
          runId,
          threadId,
          nativeSessionId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          status: "running",
          runtimeRevision: expectedRuntimeRevision,
          createdAt,
          startedAt: createdAt,
          dispatchLeaseId,
          dispatchOutbox: true,
          dispatchedAt,
          processOwner: owner,
        }, "dispatched run");
        if (dispatched.nativeStartReceipt !== null) {
          nativeStartReceiptObserved = true;
          failUnavailable("Dispatched run must not already contain a native start receipt.");
        }
        const publicRun = await runPublicRecord(dispatched, scope, eventLedgerStore, runId);
        const authorization = buildNativeStartAuthorization({
          mode: "start",
          scope,
          thread: createdThread,
          run: dispatched,
          targetNativeRuntimeRevision: prepared.completedRuntimeRevision,
        });
        const preflight = await preflightNativeSessionRuntime(prepared.config);
        nativeLaunch = launchExecutor({ run: dispatched, scope, prepared, preflight });
        const authorized = await authorizeNativeStart(authorization, () => {
          authorizationStarted = true;
        });
        await bindRetainedNativeExecution(prepared.config, {
          authorization: authorized.receipt,
          snapshotHash: authorized.run.authority.snapshotHash,
        });
        return Object.freeze({
          response: Object.freeze({ run: publicRun }),
          nativeLaunch,
          authorizedRun: authorized.run,
        });
      } catch (error) {
        if (nativeLaunch) {
          nativeLaunch.abandon(error);
        } else {
          prepared.cleanup();
          prepared.closeObserver();
          projector.clearRun(prepared.eventScope);
        }
        if (createAttempted && !authorizationStarted && !nativeStartReceiptObserved) {
          try {
            await abortIntegrationRunBeforeLaunch(abortAttempt);
          } catch (abortError) {
            throw abortError;
          }
        }
        throw error;
      }
      });
      try {
        gatedLaunch.nativeLaunch.releaseAuthorizedNativeExecution(gatedLaunch.authorizedRun);
      } catch (error) {
        gatedLaunch.nativeLaunch.abandon(error);
        throw error;
      }
      return gatedLaunch.response;
    },

    async getIntegrationRunStatus(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const run = await loadRun(payload.runId, scope);
      await assertRunThreadMapping(run, scope);
      return Object.freeze({ run: await runPublicRecord(run, scope, eventLedgerStore, payload.runId) });
    },

    async cancelIntegrationRun(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const current = await loadRun(payload.runId, scope);
      await assertRunThreadMapping(current, scope);
      if (!ACTIVE_RUN_STATUSES.has(current.status)) {
        return Object.freeze({ run: await runPublicRecord(current, scope, eventLedgerStore, current.id) });
      }
      const cancelDescriptor = Object.getOwnPropertyDescriptor(current, "cancelRequestedAt");
      if (
        !cancelDescriptor ||
        cancelDescriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(cancelDescriptor, "value")
      ) {
        failUnavailable("Active run cancellation marker is unavailable.");
      }
      const existingCancelRequestedAt = validateOptionalCancelRequestedAt(
        cancelDescriptor.value,
        "existing run cancellation timestamp"
      );
      if (existingCancelRequestedAt !== null) {
        runRegistry.cancelRun(current.id, scope, new Error("Integration run cancelled."));
        return Object.freeze({ run: await runPublicRecord(current, scope, eventLedgerStore, current.id) });
      }
      const owner = await processOwner();
      const previousRevision = assertRevision(current.revision, "run");
      const cancelRequestedAt = nowIso();
      const cancelResult = snapshotRepositoryEnvelope(await callRepository("markIntegrationRunCancelling", {
        runId: current.id,
        threadId: current.threadId,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        expectedRevision: previousRevision,
        processOwner: owner,
        cancelRequestedAt,
      }), "cancel run response");
      const cancelling = snapshotRunRecord(unwrap(cancelResult, "run"), "cancelling run");
      assertRevisionAdvanced(previousRevision, cancelling.revision, "run");
      assertRunFields(cancelling, {
        runId: current.id,
        threadId: current.threadId,
        nativeSessionId: current.nativeSessionId,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        allowedStatuses: ACTIVE_RUN_STATUSES,
        runtimeRevision: current.authority.runtimeRevision,
        cancelRequestedAt,
        processOwner: owner,
      }, "cancelling run");
      runRegistry.cancelRun(current.id, scope, new Error("Integration run cancelled."));
      return Object.freeze({ run: await runPublicRecord(cancelling, scope, eventLedgerStore, current.id) });
    },

    async resumeIntegrationRun(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const gatedLaunch = await withScopeOperationGate(scope, async () => {
      const previous = await loadRun(payload.runId, scope);
      const thread = await assertRunThreadMapping(previous, scope);
      if (!TERMINAL_STATUSES.has(previous.status)) failUnavailable("Resume requires the latest run to be terminal.");
      if (thread.lastRunId !== previous.id) notFound("Run");
      if (threadRuntimeRevision(thread, "resume thread") !== assertRuntimeRevision(previous.authority?.runtimeRevision, "previous run authority")) {
        failUnavailable("Resume thread runtime revision does not match the latest run.");
      }
      await assertNoActiveRun(thread, scope);
      const runId = runtimeId("run");
      const inputText = payload.input?.text || "";
      const prepared = prepareLaunch({ mode: "resume", thread, runId, inputText, scope });
      const threadId = validateIntegrationThreadId(thread.id);
      const nativeSessionId = assertNativeSessionId(thread.nativeSessionId);
      const previousRunId = validateIntegrationRunId(previous.id);
      const expectedRuntimeRevision = prepared.expectedRuntimeRevision;
      const previousThreadRevision = assertRevision(thread.revision, "thread");
      const createdAt = nowIso();
      let createAttempted = false;
      let authorizationStarted = false;
      let nativeStartReceiptObserved = false;
      let nativeLaunch = null;
      let abortAttempt = buildPreLaunchAbortBase({
        mode: "resume",
        scope,
        thread,
        runId,
        previousRunId,
        previousThreadRevision,
        expectedRuntimeRevision,
        createdAt,
      });
      try {
        createAttempted = true;
        const createResult = snapshotRepositoryEnvelope(await callRepository("createIntegrationRun", {
          runId,
          threadId,
          nativeSessionId,
          previousRunId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          browserSessionPolicy: "same-browser-session",
          expectedThreadRevision: previousThreadRevision,
          expectedNativeRuntimeRevision: expectedRuntimeRevision,
          input: Object.freeze({ text: inputText }),
          createdAt,
          status: "starting",
        }), "create resumed run response");
        const created = snapshotRunRecord(unwrap(createResult, "run"), "created resumed run");
        assertRunFields(created, {
          runId,
          threadId,
          nativeSessionId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          status: "starting",
          runtimeRevision: expectedRuntimeRevision,
          createdAt,
          startedAt: createdAt,
        }, "created resumed run");
        if (created.previousRunId !== previousRunId) notFound("Run");
        if (created.revision !== 1) failUnavailable("Run repository must durable-create a starting revision 1 run.");
        const createdThread = snapshotThreadRecord(unwrap(createResult, "thread"), "created resumed run thread");
        if (
          !createdThread ||
          createdThread.id !== threadId ||
          createdThread.nativeSessionId !== nativeSessionId ||
          createdThread.lastRunId !== runId
        ) {
          failUnavailable("Repository did not return the updated thread for resume.");
        }
        assertRevisionAdvanced(previousThreadRevision, createdThread.revision, "thread");
        if (threadPreservationDigestFor(createdThread, "created resumed run thread") !== threadPreservationDigestFor(thread, "resume thread")) {
          failUnavailable("Repository changed preserved thread fields during resume.");
        }
        if (threadRuntimeRevision(createdThread, "created resumed run thread") !== expectedRuntimeRevision) {
          failUnavailable("Repository changed thread runtime revision during resume.");
        }
        const createdRevision = assertRevision(created.revision, "created resumed run");
        const owner = await processOwner();
        const dispatchLeaseId = contractDigest({ runId, nativeSessionId, createdAt });
        const dispatchedAt = nowIso();
        abortAttempt = markPreLaunchDispatchAttempt(abortAttempt, {
          dispatchLeaseId,
          dispatchOutbox: true,
          dispatchedAt,
          processOwner: owner,
        });
        const dispatchResult = snapshotRepositoryEnvelope(await callRepository("markIntegrationRunDispatching", {
          runId,
          threadId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          expectedRevision: createdRevision,
          expectedNativeRuntimeRevision: expectedRuntimeRevision,
          dispatchLeaseId,
          dispatchOutbox: true,
          processOwner: owner,
          dispatchedAt,
        }), "dispatch resumed run response");
        const dispatched = snapshotRunRecord(unwrap(dispatchResult, "run"), "dispatched resumed run");
        assertRevisionAdvanced(createdRevision, dispatched.revision, "run");
        assertRunFields(dispatched, {
          runId,
          threadId,
          nativeSessionId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          status: "running",
          runtimeRevision: expectedRuntimeRevision,
          createdAt,
          startedAt: createdAt,
          dispatchLeaseId,
          dispatchOutbox: true,
          dispatchedAt,
          processOwner: owner,
        }, "dispatched resumed run");
        if (dispatched.nativeStartReceipt !== null) {
          nativeStartReceiptObserved = true;
          failUnavailable("Dispatched run must not already contain a native start receipt.");
        }
        const publicRun = await runPublicRecord(dispatched, scope, eventLedgerStore, runId);
        const authorization = buildNativeStartAuthorization({
          mode: "resume",
          scope,
          thread: createdThread,
          run: dispatched,
          previousRun: previous,
          targetNativeRuntimeRevision: prepared.completedRuntimeRevision,
        });
        const preflight = await preflightNativeSessionRuntime(prepared.config);
        nativeLaunch = launchExecutor({ run: dispatched, scope, prepared, preflight });
        const authorized = await authorizeNativeStart(authorization, () => {
          authorizationStarted = true;
        });
        await bindRetainedNativeExecution(prepared.config, {
          authorization: authorized.receipt,
          snapshotHash: authorized.run.authority.snapshotHash,
        });
        return Object.freeze({
          response: Object.freeze({ run: publicRun }),
          nativeLaunch,
          authorizedRun: authorized.run,
        });
      } catch (error) {
        if (nativeLaunch) {
          nativeLaunch.abandon(error);
        } else {
          prepared.cleanup();
          prepared.closeObserver();
          projector.clearRun(prepared.eventScope);
        }
        if (createAttempted && !authorizationStarted && !nativeStartReceiptObserved) {
          try {
            await abortIntegrationRunBeforeLaunch(abortAttempt);
          } catch (abortError) {
            throw abortError;
          }
        }
        throw error;
      }
      });
      try {
        gatedLaunch.nativeLaunch.releaseAuthorizedNativeExecution(gatedLaunch.authorizedRun);
      } catch (error) {
        gatedLaunch.nativeLaunch.abandon(error);
        throw error;
      }
      return gatedLaunch.response;
    },

    async listIntegrationArtifacts(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      if (payload.threadId) await loadThread(payload.threadId, scope);
      if (payload.runId) await loadRun(payload.runId, scope);
      const result = await callRepository("listIntegrationArtifacts", {
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        threadId: payload.threadId || "",
        runId: payload.runId || "",
        publishedOnly: true,
      });
      return Object.freeze({
        artifacts: Object.freeze((result.artifacts || []).map((artifact) => artifactPublicRecord(artifact, scope, payload))),
      });
    },

    async getIntegrationArtifact(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const artifact = unwrap(await callRepository("getIntegrationArtifact", {
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        artifactId: payload.artifactId,
        publishedOnly: true,
      }), "artifact");
      return Object.freeze({ artifact: artifactPublicRecord(artifact, scope) });
    },

    async reconcileIntegrationDispatches(context = {}) {
      const scope = normalizeContext(context);
      return await withScopeOperationGate(scope, async () => {
        const liveRunClaims = validateLiveRunClaims(runRegistry.listLiveRunClaims(scope), scope);
        const owner = await processOwner();
        const request = buildDispatchReconciliationRequest(scope, owner, liveRunClaims);
        const response = await validateDispatchReconciliationResponse(
          await callRepository("reconcileIntegrationDispatches", request),
          request
        );
        const delivered = await drainPendingOutboxRecords(response.pendingOutboxEvents, scope);
        return Object.freeze({
          reconciled: true,
          recoveryHolds: response.recoveryHolds,
          deliveredOutboxEvents: delivered.length,
        });
      });
    },
  };

  assertNoSemanticMethods(authority, "integration runtime authority");
  return Object.freeze(authority);
}
