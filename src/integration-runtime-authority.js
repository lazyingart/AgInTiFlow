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
import { authorityFail, currentProcessOwner, normalizeProcessIdentity, nowIso } from "./integration-durable-common.js";
import { createIntegrationCoreEventProjector, assertNoUnsafeCoreEventFields } from "./integration-core-event-projector.js";
import { createIntegrationRunRegistry } from "./integration-run-registry.js";
import { NATIVE_INTEGRATION_RUNTIME_PROOF_VERSION } from "./integration-session-service.js";
import {
  NATIVE_INTEGRATION_EXECUTOR_PROOF,
  buildFixedNativeRunAgentConfig,
  classifyRunAgentError,
  classifyRunAgentResult,
  executeNativeAgintiRun,
  outputEventForRunResult,
  validateNativeRuntimeRootsAttestation,
} from "./integration-native-executor.js";

export const INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION =
  "aginti-integration-thread-session-repository-v2";
export const INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY =
  "integrationRuntimeRepositoryAttestation";
export const INTEGRATION_EVENT_APPEND_ATTESTATION_VERSION = "aginti-public-event-append-attestation-v1";
export const INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY = "integrationEventAppendAttestation";
export const INTEGRATION_RUNTIME_CANCELLATION_ATTESTATION_VERSION =
  "aginti-runtime-cancellation-attestation-v1";
export const INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION =
  "aginti-hardened-sandbox-runtime-attestation-v1";

const ZERO_DIGEST = "0".repeat(64);
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
const REQUIRED_REPOSITORY_METHODS = Object.freeze([
  "listIntegrationThreads",
  "createIntegrationThread",
  "getIntegrationThread",
  "updateIntegrationThread",
  "deleteIntegrationThread",
  "getActiveIntegrationRunForThread",
  "createIntegrationRun",
  "markIntegrationRunDispatching",
  "getIntegrationRun",
  "markIntegrationRunCancelling",
  "finishIntegrationRunWithOutbox",
  "reconcileIntegrationDispatches",
  "listPendingIntegrationOutboxEvents",
  "markIntegrationOutboxDelivered",
  "listIntegrationArtifacts",
  "getIntegrationArtifact",
  "stageIntegrationArtifactOutbox",
  "publishIntegrationArtifactOutbox",
]);
const REPOSITORY_ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "descriptorBound",
  "nativeSessionMapping",
  "onePublicThreadToOneNativeSession",
  "principalBound",
  "browserSessionBound",
  "optimisticRevisions",
  "casRevisions",
  "immutableNativeSessionId",
  "durableThreadSessionMapping",
  "dispatchLeases",
  "dispatchOutbox",
  "terminalOutbox",
  "outboxDelivery",
  "startupReconciliation",
  "processIdentity",
  "artifactTransactionalOutbox",
  "publishedArtifactsOnly",
  "exactOwnership",
  "noPathThreadMapStore",
  "durable",
  "retainedDescriptorStorageAuthority",
  "runtimeRoots",
  "digest",
]);
const EVENT_APPEND_ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "appendPublicEvent",
  "appendByOutboxId",
  "lookupByOutboxId",
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
const REPOSITORY_SHAPE_KEYS = Object.freeze([
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY,
  ...REQUIRED_REPOSITORY_METHODS,
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
  "ledgerForRun",
]);
const EVENT_LEDGER_STORE_OPTIONAL_KEYS = Object.freeze([
  "appendByOutboxId",
  "lookupByOutboxId",
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
    value.includes("..")
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
  rejectThenableDependency(value, label);
  const proof = keys ? assertExactFrozenPlainObject(value, keys, label) : assertFrozenPlainObject(value, label);
  if (typeof proof.digest !== "string" || proof.digest !== digestWithoutDigest(proof)) {
    failUnavailable(`${label} digest is invalid.`);
  }
  return proof;
}

function validateRepositoryAttestation(value, { requireRetainedDescriptorStorage = false } = {}) {
  rejectThenableDependency(value?.runtimeRoots, "repository runtime roots attestation");
  const proof = assertFrozenAttestation(value, "repository attestation", REPOSITORY_ATTESTATION_KEYS);
  validateNativeRuntimeRootsAttestation(proof.runtimeRoots);
  if (
    proof.schemaVersion !== INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.descriptorBound !== true ||
    proof.nativeSessionMapping !== "repository" ||
    proof.onePublicThreadToOneNativeSession !== true ||
    proof.principalBound !== true ||
    proof.browserSessionBound !== true ||
    proof.optimisticRevisions !== true ||
    proof.casRevisions !== true ||
    proof.immutableNativeSessionId !== true ||
    proof.durableThreadSessionMapping !== true ||
    proof.dispatchLeases !== true ||
    proof.dispatchOutbox !== true ||
    proof.terminalOutbox !== true ||
    proof.outboxDelivery !== true ||
    proof.startupReconciliation !== true ||
    proof.processIdentity !== true ||
    proof.artifactTransactionalOutbox !== true ||
    proof.publishedArtifactsOnly !== true ||
    proof.exactOwnership !== true ||
    proof.noPathThreadMapStore !== true ||
    proof.durable !== true ||
    typeof proof.retainedDescriptorStorageAuthority !== "boolean"
  ) {
    failUnavailable("Integration repository attestation is unavailable.");
  }
  if (requireRetainedDescriptorStorage && proof.retainedDescriptorStorageAuthority !== true) {
    failUnavailable("Retained-descriptor storage authority is not proven.");
  }
  return proof;
}

function validateRepository(repository) {
  rejectThenableDependency(repository, "thread/session repository");
  assertExactFrozenShape(repository, {
    label: "thread/session repository",
    requiredKeys: REPOSITORY_SHAPE_KEYS,
  });
  assertNoSemanticMethods(repository, "thread/session repository");
  const attestation = validateRepositoryAttestation(
    ownDataDescriptor(repository, INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY, "thread/session repository").value
  );
  const methods = {};
  for (const method of REQUIRED_REPOSITORY_METHODS) {
    const descriptor = ownDataDescriptor(repository, method, "thread/session repository");
    if (descriptor.writable !== false || descriptor.configurable !== false) {
      failUnavailable(`thread/session repository.${method} must be immutable.`);
    }
    if (typeof descriptor.value !== "function") failUnavailable(`thread/session repository.${method} is unavailable.`);
    methods[method] = descriptor.value.bind(repository);
  }
  return Object.freeze({ attestation, methods: Object.freeze(methods) });
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
    proof.lookupByOutboxId !== Boolean(lookupMethod) ||
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
  rejectThenableDependency(value?.isolationAttestation, "hardened sandbox isolation attestation");
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
  for (const method of ["appendPublicEvent", "ledgerForRun"]) {
    const descriptor = ownDataDescriptor(eventLedgerStore, method, "event ledger store");
    if (descriptor.writable !== false || descriptor.configurable !== false || typeof descriptor.value !== "function") {
      failUnavailable(`event ledger store.${method} must be an immutable own method.`);
    }
  }
  for (const method of ["appendByOutboxId", "lookupByOutboxId"]) {
    const descriptor = Object.getOwnPropertyDescriptor(eventLedgerStore, method);
    if (!descriptor) continue;
    if (
      descriptor.enumerable !== true ||
      descriptor.writable !== false ||
      descriptor.configurable !== false ||
      typeof descriptor.value !== "function"
    ) {
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

function sameProcessOwner(left = {}, right = {}) {
  const leftIdentity = normalizeProcessIdentity(left.processIdentity, { optional: true });
  const rightIdentity = normalizeProcessIdentity(right.processIdentity, { optional: true });
  return Boolean(
    left.schemaVersion === "aginti-process-owner-v1" &&
      right.schemaVersion === "aginti-process-owner-v1" &&
      left.token === right.token &&
      leftIdentity &&
      rightIdentity &&
      leftIdentity.bootId === rightIdentity.bootId &&
      leftIdentity.startTimeTicks === rightIdentity.startTimeTicks
  );
}

function assertCanonicalIso(value, label) {
  if (typeof value !== "string") failUnavailable(`${label} must be a canonical timestamp.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    failUnavailable(`${label} must be a canonical timestamp.`);
  }
  return value;
}

function assertProcessOwnerEnvelope(owner, label) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner) || utilTypes.isProxy(owner)) {
    failUnavailable(`${label} process owner is unavailable.`);
  }
  const keys = Reflect.ownKeys(owner);
  if (
    keys.length !== PROCESS_OWNER_KEYS.length ||
    keys.some((key) => typeof key !== "string" || !PROCESS_OWNER_KEYS.includes(key)) ||
    PROCESS_OWNER_KEYS.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      return !descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value");
    })
  ) {
    failUnavailable(`${label} process owner envelope is invalid.`);
  }
  if (owner.schemaVersion !== "aginti-process-owner-v1") failUnavailable(`${label} process owner schema is invalid.`);
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) failUnavailable(`${label} process owner pid is invalid.`);
  if (typeof owner.token !== "string" || !/^[a-f0-9]{32}$/u.test(owner.token)) {
    failUnavailable(`${label} process owner token is invalid.`);
  }
  if (!normalizeProcessIdentity(owner.processIdentity, { optional: true })) {
    failUnavailable(`${label} process identity is invalid.`);
  }
  assertCanonicalIso(owner.acquiredAt, `${label} process owner acquiredAt`);
  assertCanonicalIso(owner.heartbeatAt, `${label} process owner heartbeatAt`);
  return owner;
}

function assertProcessOwner(record, owner, label) {
  if (record.processOwner === undefined || record.processOwner === null) {
    failUnavailable(`${label} process owner is unavailable.`);
  }
  assertProcessOwnerEnvelope(record.processOwner, label);
  assertProcessOwnerEnvelope(owner, "expected");
  if (!sameProcessOwner(record.processOwner, owner)) {
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
    cancelRequestedAt: record.cancelRequestedAt ?? null,
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
  return value?.[key] || value;
}

function safePublicError(error, { cancelled = false } = {}) {
  if (cancelled) return Object.freeze({ code: "CANCELLED", message: "Run cancelled." });
  const code = String(error?.code || error?.publicCode || "AGINTI_RUNTIME_ERROR")
    .replace(/[^A-Z0-9_]/gu, "_")
    .slice(0, 96);
  return Object.freeze({ code: code || "AGINTI_RUNTIME_ERROR", message: "AgInTi runtime execution failed." });
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
  if (
    !event ||
    event.threadId !== scope.threadId ||
    event.runId !== scope.runId ||
    event.seq !== record.expectedPreviousSeq + 1 ||
    event.previousHash !== record.expectedPreviousHash ||
    event.hash !== record.expectedEventHash ||
    event.outboxId !== record.outboxId ||
    event.type !== record.type ||
    event.createdAt !== record.createdAt ||
    contractDigest(event.payload) !== contractDigest(record.payload || {}) ||
    (event.principalId !== undefined && event.principalId !== scope.principalId) ||
    (event.browserSessionId !== undefined && event.browserSessionId !== scope.browserSessionId)
  ) {
    authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger outbox record does not match the durable outbox.", {
      status: 503,
    });
  }
  return event;
}

export function createAgintiIntegrationRuntimeAuthority(options = {}) {
  rejectRemovedDependencyOptions(options);
  const repository = validateRepository(options.threadSessionRepository);
  const eventLedgerStore = validateEventLedgerStore(options.eventLedgerStore);
  const runRegistry = createIntegrationRunRegistry();
  const projector = createIntegrationCoreEventProjector({ eventLedgerStore });
  validateNativeRuntimeRootsAttestation(repository.attestation.runtimeRoots);
  const runtimeRootsAttestation = repository.attestation.runtimeRoots;
  let processOwnerPromise = null;
  const reconciliationByScope = new Map();

  function processOwner() {
    processOwnerPromise ||= currentProcessOwner();
    return processOwnerPromise;
  }

  async function callRepository(method, payload) {
    return repository.methods[method](Object.freeze({ ...payload }));
  }

  async function drainOutboxRecords(records = [], fallbackScope = {}) {
    const delivered = [];
    for (const record of records || []) {
      const scope = Object.freeze({
        principalId: assertPrincipalId(record.principalId || fallbackScope.principalId),
        browserSessionId: assertBrowserSessionId(record.browserSessionId || fallbackScope.browserSessionId),
        browserSessionPolicy: "same-browser-session",
        threadId: validateIntegrationThreadId(record.threadId || fallbackScope.threadId),
        runId: validateIntegrationRunId(record.runId || fallbackScope.runId),
      });
      let event = null;
      if (typeof eventLedgerStore.lookupByOutboxId === "function") {
        event = await eventLedgerStore.lookupByOutboxId(scope, { outboxId: record.outboxId });
        if (event) verifyOutboxEvent(record, event, scope);
      }
      if (!event && typeof eventLedgerStore.appendByOutboxId === "function") {
        event = await eventLedgerStore.appendByOutboxId(scope, {
          outboxId: record.outboxId,
          type: record.type,
          payload: record.payload || {},
          createdAt: record.createdAt,
          expectedPreviousSeq: record.expectedPreviousSeq,
          expectedPreviousHash: record.expectedPreviousHash,
          expectedEventHash: record.expectedEventHash,
        });
        verifyOutboxEvent(record, event, scope);
      }
      if (!event) failUnavailable("Public event ledger cannot publish the durable outbox idempotently.");
      const marked = await callRepository("markIntegrationOutboxDelivered", {
        outboxId: record.outboxId,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        threadId: scope.threadId,
        runId: scope.runId,
        eventSeq: event.seq,
        eventHash: event.hash,
        eventDigest: contractDigest(event),
      });
      if (marked?.delivered !== true) failUnavailable("Repository did not mark the outbox event as delivered.");
      delivered.push(event);
    }
    return Object.freeze(delivered);
  }

  async function ensureReconciled(scope) {
    const key = `${scope.principalId}\n${scope.browserSessionId}`;
    if (reconciliationByScope.has(key)) return reconciliationByScope.get(key);
    const promise = (async () => {
      const owner = await processOwner();
      const result = await callRepository("reconcileIntegrationDispatches", {
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        processOwner: owner,
      });
      await drainOutboxRecords(result.pendingOutboxEvents || [], scope);
      return result;
    })();
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
    const record = unwrap(await callRepository("getIntegrationThread", {
      threadId: id,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
    }), "thread");
    threadPublicRecord(record, scope, id);
    return record;
  }

  async function loadRun(runId, scope) {
    const id = validateIntegrationRunId(runId);
    const record = unwrap(await callRepository("getIntegrationRun", {
      runId: id,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
    }), "run");
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
    const active = unwrap(await callRepository("getActiveIntegrationRunForThread", {
      threadId: thread.id,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
    }), "run");
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
    if (expected.dispatchedAt && run.dispatchedAt !== expected.dispatchedAt) failUnavailable(`${label} dispatch timestamp did not match.`);
    if (expected.cancelRequestedAt && run.cancelRequestedAt !== expected.cancelRequestedAt) {
      failUnavailable(`${label} cancellation timestamp did not match.`);
    }
    if (expected.completedAt && run.completedAt !== expected.completedAt) failUnavailable(`${label} completion timestamp did not match.`);
    if (expected.processOwner) assertProcessOwner(run, expected.processOwner, label);
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
      eventTail = eventTail.then(() => projector.appendCoreEvent(type, data, eventScope)).catch(() => null);
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
    let classification = classificationInput;
    if (prepared?.controller?.signal?.aborted || current.cancelRequestedAt) {
      classification = Object.freeze({
        status: "cancelled",
        output: "",
        error: Object.freeze({ code: "CANCELLED", message: "Run cancelled." }),
        digest: contractDigest({ status: "cancelled", runId }),
      });
    }
    const status = classification.status;
    const previousRevision = assertRevision(current.revision, "run");
    const cursor = await eventCursorFor(eventLedgerStore, current, scope);
    const completedAt = nowIso();
    const owner = await processOwner();
    const completedRuntimeRevision = status === "completed" ? prepared.completedRuntimeRevision : prepared.expectedRuntimeRevision;
    const result = await callRepository("finishIntegrationRunWithOutbox", {
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
      outputEvent: outputEventForRunResult(classification, { createdAt: completedAt }),
      terminalEvent: Object.freeze({ type: TERMINAL_EVENT_TYPES[status], payload: {}, createdAt: completedAt }),
      resultDigest: classification.digest,
    });
    const finished = unwrap(result, "run");
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
    if (suppressOutboxErrors) await drainOutboxRecords(result.outboxEvents || [], scope).catch(() => {});
    else await drainOutboxRecords(result.outboxEvents || [], scope);
    return finished;
  }

  function launchExecutor({ run, scope, prepared }) {
    runRegistry.claimRun({
      runId: run.id,
      threadId: run.threadId,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      controller: prepared.controller,
    });
    const promise = (async () => {
      try {
        const result = await executeNativeAgintiRun(prepared.config);
        const classification = classifyRunAgentResult(result, {
          nativeSessionId: prepared.nativeSessionId,
          abortSignal: prepared.controller.signal,
        });
        await prepared.drainEvents();
        return await finishWithOutbox(run.id, scope, classification, prepared, { suppressOutboxErrors: true });
      } catch (error) {
        await prepared.drainEvents().catch(() => {});
        const classification = classifyRunAgentError(error, { abortSignal: prepared.controller.signal });
        return await finishWithOutbox(run.id, scope, classification, prepared, { suppressOutboxErrors: true });
      } finally {
        prepared.closeObserver();
        prepared.cleanup();
        runRegistry.releaseRun(run.id);
      }
    })();
    runRegistry.attachPromise(run.id, promise);
    return promise;
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
      const result = await callRepository("listIntegrationThreads", {
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        limit: payload.limit,
        before: payload.before || "",
      });
      return Object.freeze({
        threads: Object.freeze((result.threads || []).map((thread) => threadPublicRecord(thread, scope))),
        nextBefore: result.nextBefore || null,
      });
    },

    async createIntegrationThread(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const threadId = runtimeId("thr");
      const nativeSessionId = nativeSessionIdForThread();
      const thread = unwrap(await callRepository("createIntegrationThread", {
        threadId,
        nativeSessionId,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        browserSessionPolicy: "same-browser-session",
        title: payload.title || "New agent thread",
        createdAt: nowIso(),
        policyFingerprint: scope.policy.fingerprint,
      }), "thread");
      if (thread.id !== threadId || thread.nativeSessionId !== nativeSessionId || thread.revision !== 1) {
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
      const previousRevision = assertRevision(current.revision, "thread");
      const updated = unwrap(await callRepository("updateIntegrationThread", {
        threadId: current.id,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        expectedRevision: previousRevision,
        title: payload.title,
        updatedAt: nowIso(),
      }), "thread");
      assertRevisionAdvanced(previousRevision, updated.revision, "thread");
      if (updated.nativeSessionId !== current.nativeSessionId) failUnavailable("Thread repository changed the native session mapping.");
      return Object.freeze({ thread: threadPublicRecord(updated, scope, current.id) });
    },

    async deleteIntegrationThread(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const current = await loadThread(payload.threadId, scope);
      await assertNoActiveRun(current, scope);
      const result = await callRepository("deleteIntegrationThread", {
        threadId: current.id,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        expectedRevision: assertRevision(current.revision, "thread"),
      });
      if (result.thread) threadPublicRecord(result.thread, scope, current.id);
      return Object.freeze({ deleted: true, threadId: current.id, principalId: scope.principalId });
    },

    async startIntegrationRun(payload = {}, context = {}) {
      const scope = normalizeContext(context);
      await ensureReconciled(scope);
      const thread = await loadThread(payload.threadId, scope);
      await assertNoActiveRun(thread, scope);
      const runId = runtimeId("run");
      const prepared = prepareLaunch({ mode: "start", thread, runId, inputText: payload.input.text, scope });
      let created = null;
      try {
        created = unwrap(await callRepository("createIntegrationRun", {
          runId,
          threadId: thread.id,
          nativeSessionId: assertNativeSessionId(thread.nativeSessionId),
          previousRunId: null,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          browserSessionPolicy: "same-browser-session",
          expectedThreadRevision: assertRevision(thread.revision, "thread"),
          expectedNativeRuntimeRevision: prepared.expectedRuntimeRevision,
          input: Object.freeze({ text: payload.input.text }),
          createdAt: nowIso(),
          status: "starting",
        }), "run");
        assertRunFields(created, {
          runId,
          threadId: thread.id,
          nativeSessionId: thread.nativeSessionId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          status: "starting",
          runtimeRevision: prepared.expectedRuntimeRevision,
        }, "created run");
        if (created.previousRunId) failUnavailable("Start run must not bind a previous run.");
        if (created.revision !== 1) failUnavailable("Run repository must durable-create a starting revision 1 run.");
        const owner = await processOwner();
        const dispatchLeaseId = contractDigest({ runId, nativeSessionId: thread.nativeSessionId, createdAt: created.createdAt });
        const dispatchedAt = nowIso();
        const dispatched = unwrap(await callRepository("markIntegrationRunDispatching", {
          runId,
          threadId: thread.id,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          expectedRevision: assertRevision(created.revision, "run"),
          expectedNativeRuntimeRevision: prepared.expectedRuntimeRevision,
          dispatchLeaseId,
          dispatchOutbox: true,
          processOwner: owner,
          dispatchedAt,
        }), "run");
        assertRevisionAdvanced(created.revision, dispatched.revision, "run");
        assertRunFields(dispatched, {
          runId,
          threadId: thread.id,
          nativeSessionId: thread.nativeSessionId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          status: "running",
          runtimeRevision: prepared.expectedRuntimeRevision,
          dispatchLeaseId,
          dispatchOutbox: true,
          dispatchedAt,
          processOwner: owner,
        }, "dispatched run");
        const publicRun = await runPublicRecord(dispatched, scope, eventLedgerStore, runId);
        launchExecutor({ run: dispatched, scope, prepared });
        return Object.freeze({ run: publicRun });
      } catch (error) {
        prepared.cleanup();
        prepared.closeObserver();
        if (created) {
          const classification = Object.freeze({
            status: "failed",
            output: "",
            error: safePublicError(error),
            digest: contractDigest({ postCreateFailure: true, code: error?.code || "" }),
          });
          await finishWithOutbox(runId, scope, classification, prepared, { suppressOutboxErrors: true }).catch(() => {});
        }
        throw error;
      }
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
      const owner = await processOwner();
      const previousRevision = assertRevision(current.revision, "run");
      const cancelRequestedAt = nowIso();
      const cancelling = unwrap(await callRepository("markIntegrationRunCancelling", {
        runId: current.id,
        threadId: current.threadId,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        expectedRevision: previousRevision,
        processOwner: owner,
        cancelRequestedAt,
      }), "run");
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
      const previous = await loadRun(payload.runId, scope);
      const thread = await assertRunThreadMapping(previous, scope);
      await assertNoActiveRun(thread, scope);
      const runId = runtimeId("run");
      const inputText = payload.input?.text || "";
      const prepared = prepareLaunch({ mode: "resume", thread, runId, inputText, scope });
      let created = null;
      try {
        created = unwrap(await callRepository("createIntegrationRun", {
          runId,
          threadId: thread.id,
          nativeSessionId: assertNativeSessionId(thread.nativeSessionId),
          previousRunId: previous.id,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          browserSessionPolicy: "same-browser-session",
          expectedThreadRevision: assertRevision(thread.revision, "thread"),
          expectedNativeRuntimeRevision: prepared.expectedRuntimeRevision,
          input: Object.freeze({ text: inputText }),
          createdAt: nowIso(),
          status: "starting",
        }), "run");
        assertRunFields(created, {
          runId,
          threadId: thread.id,
          nativeSessionId: thread.nativeSessionId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          status: "starting",
          runtimeRevision: prepared.expectedRuntimeRevision,
        }, "created resumed run");
        if (created.previousRunId !== previous.id) notFound("Run");
        if (created.revision !== 1) failUnavailable("Run repository must durable-create a starting revision 1 run.");
        const owner = await processOwner();
        const dispatchLeaseId = contractDigest({ runId, nativeSessionId: thread.nativeSessionId, createdAt: created.createdAt });
        const dispatchedAt = nowIso();
        const dispatched = unwrap(await callRepository("markIntegrationRunDispatching", {
          runId,
          threadId: thread.id,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          expectedRevision: assertRevision(created.revision, "run"),
          expectedNativeRuntimeRevision: prepared.expectedRuntimeRevision,
          dispatchLeaseId,
          dispatchOutbox: true,
          processOwner: owner,
          dispatchedAt,
        }), "run");
        assertRevisionAdvanced(created.revision, dispatched.revision, "run");
        assertRunFields(dispatched, {
          runId,
          threadId: thread.id,
          nativeSessionId: thread.nativeSessionId,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          status: "running",
          runtimeRevision: prepared.expectedRuntimeRevision,
          dispatchLeaseId,
          dispatchOutbox: true,
          dispatchedAt,
          processOwner: owner,
        }, "dispatched resumed run");
        const publicRun = await runPublicRecord(dispatched, scope, eventLedgerStore, runId);
        launchExecutor({ run: dispatched, scope, prepared });
        return Object.freeze({ run: publicRun });
      } catch (error) {
        prepared.cleanup();
        prepared.closeObserver();
        if (created) {
          const classification = Object.freeze({
            status: "failed",
            output: "",
            error: safePublicError(error),
            digest: contractDigest({ postCreateFailure: true, code: error?.code || "" }),
          });
          await finishWithOutbox(runId, scope, classification, prepared, { suppressOutboxErrors: true }).catch(() => {});
        }
        throw error;
      }
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
      const owner = await processOwner();
      const result = await callRepository("reconcileIntegrationDispatches", {
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        processOwner: owner,
      });
      const delivered = await drainOutboxRecords(result.pendingOutboxEvents || [], scope);
      return Object.freeze({ ...result, deliveredOutboxEvents: delivered.length });
    },
  };

  assertNoSemanticMethods(authority, "integration runtime authority");
  return Object.freeze(authority);
}
