import { types as utilTypes } from "node:util";
import { authorityFail } from "./integration-durable-common.js";
import { contractDigest, validateIntegrationRunId, validateIntegrationThreadId } from "./integration-policy.js";
import {
  assertRetainedIntegrationNativeExecutionEvidence,
} from "./integration-retained-native-execution-evidence.js";
import {
  assertRetainedIntegrationSessionStateStore,
} from "./integration-retained-session-state-store.js";
import {
  assertRetainedIntegrationRuntimeNativeWriteFence,
  assertRetainedIntegrationRuntimeNativeWriteFenceCurrent,
  assertRetainedIntegrationRuntimeRecoveryCoordinator,
  assertRetainedIntegrationRuntimeRepositoryFenceLeaseCurrent,
  assertRetainedIntegrationRuntimeRepositorySurface,
} from "./integration-retained-runtime-repository-surface.js";
import {
  assertIntegrationRuntimeProcessOwnerBootstrap,
} from "./integration-runtime-process-owner-bootstrap.js";

export const INTEGRATION_TEXT_WORKSPACE_PROFILE_ID = "text-workspace-v1";
export const INTEGRATION_RETAINED_TEXT_WORKSPACE_VERSION =
  "aginti-retained-text-workspace-v2";
export const INTEGRATION_RETAINED_TEXT_WORKSPACE_ATTESTATION_VERSION =
  "aginti-retained-text-workspace-attestation-v3";
export const INTEGRATION_RETAINED_TEXT_WORKSPACE_CURRENT_PROOF_VERSION =
  "aginti-retained-text-workspace-current-proof-v2";
export const INTEGRATION_RETAINED_TEXT_WORKSPACE_JOURNAL_VERSION =
  "aginti-retained-text-workspace-event-journal-v1";
export const INTEGRATION_RETAINED_TEXT_WORKSPACE_EVENT_VERSION =
  "aginti-retained-text-workspace-event-v1";
export const INTEGRATION_RETAINED_TEXT_WORKSPACE_JOURNAL_ID_DOMAIN =
  "aginti-retained-text-workspace-journal-id-v1";
export const INTEGRATION_RETAINED_TEXT_WORKSPACE_JOURNAL_ID_PREFIX =
  "aginti-evidence-v1:text-workspace-journal:";

export const INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES = Object.freeze([
  "inspect_project",
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "finish",
]);

export const INTEGRATION_TEXT_WORKSPACE_MAX_EVENTS = 512;
export const INTEGRATION_TEXT_WORKSPACE_MAX_EVENT_BYTES = 64 * 1024;
export const INTEGRATION_TEXT_WORKSPACE_MAX_JOURNAL_BYTES = 512 * 1024;

const ZERO_DIGEST = "0".repeat(64);
const MAX_CANONICAL_NODES = 100_000;
const MAX_CANONICAL_DEPTH = 64;
const profileBrand = new WeakMap();
const preflightBrand = new WeakMap();
const executionBrand = new WeakMap();
const OMIT_EVENT_FIELD = Symbol("omit-event-field");

const OPERATION_DISPOSITIONS = Object.freeze(Object.assign(Object.create(null), {
  ensure: "no-op",
  writePointer: "deny",
  loadState: "retained-native-state-cas",
  saveState: "retained-native-state-cas",
  savePlan: "durable-state-projection-no-file",
  saveJsonArtifact: "disabled-empty-projection",
  appendEvent: "retained-bounded-hash-journal",
  loadEvents: "retained-bounded-hash-journal",
  removeStaleInboxLock: "deny",
  acquireInboxLock: "deny",
  withInboxLock: "deny",
  readJsonLinesUnlocked: "deny",
  appendJsonRecordsUnlocked: "deny",
  readInboxDataUnlocked: "deny",
  visibleInboxItems: "deny",
  rewriteActiveInboxUnlocked: "deny",
  shouldCompactInbox: "deny",
  compactInboxUnlocked: "deny",
  appendInbox: "deny",
  loadInboxAcknowledgements: "disabled-empty",
  loadInbox: "disabled-empty",
  saveInbox: "disabled-empty-only-no-op",
  mutateInbox: "deny",
  drainInbox: "disabled-empty",
  markInboxApplied: "disabled-false",
  acknowledgeDrainedInbox: "no-op",
  releaseInboxClaims: "no-op",
  saveSnapshot: "opaque-digest-no-file",
  screenshotPath: "deny",
  remove: "deny",
}));

function fail(code, message, status = 503) {
  authorityFail(code, message, { status });
}

function frozenRecord(value) {
  return Object.freeze(Object.assign(Object.create(null), value));
}

function assertPlainObject(value, label) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} must be plain data.`, 400);
  }
  return value;
}

function exactObject(input, required, optional, label) {
  const value = cloneCanonical(input, label);
  assertPlainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} fields are invalid.`, 400);
  }
  return value;
}

function exactPayload(input, required, optional, label) {
  assertPlainObject(input, label);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
  ) {
    fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} fields are invalid.`, 400);
  }
  const clone = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label}.${key} must be a data field.`, 400);
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

function cloneCanonical(
  value,
  label,
  state = { active: new WeakSet(), nodes: 0 },
  depth = 0,
  mode = "strict",
  container = "root"
) {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    fail("INTEGRATION_TEXT_WORKSPACE_FULL", `${label} exceeds structural bounds.`, 409);
  }
  if (value === undefined && mode === "event") {
    return container === "array" ? null : OMIT_EVENT_FIELD;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} contains a non-canonical number.`, 400);
    }
    return value;
  }
  if (value && typeof value === "object" && utilTypes.isProxy(value)) {
    fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} must contain trap-safe data.`, 400);
  }
  if (value && typeof value === "object" && utilTypes.isPromise(value)) {
    if (Object.getPrototypeOf(value) === Promise.prototype) {
      Promise.prototype.then.call(value, undefined, () => undefined);
    }
    fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} must be synchronous data.`, 400);
  }
  if (!value || typeof value !== "object" || state.active.has(value)) {
    fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} must be acyclic JSON data.`, 400);
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} array prototype is invalid.`, 400);
      }
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (keys.length !== value.length) {
        fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} array must be dense data.`, 400);
      }
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label}[${index}] must be a data field.`, 400);
        }
        const child = cloneCanonical(descriptor.value, `${label}[${index}]`, state, depth + 1, mode, "array");
        clone[index] = child === OMIT_EVENT_FIELD ? null : child;
      }
      return Object.freeze(clone);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} object prototype is invalid.`, 400);
    }
    const clone = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} must not contain symbols.`, 400);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label}.${key} must be a data field.`, 400);
      }
      const child = cloneCanonical(descriptor.value, `${label}.${key}`, state, depth + 1, mode, "object");
      if (child === OMIT_EVENT_FIELD) continue;
      Object.defineProperty(clone, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: child,
      });
    }
    return Object.freeze(clone);
  } finally {
    state.active.delete(value);
  }
}

function assertDigest(value, label, allowZero = true) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value) || (!allowZero && value === ZERO_DIGEST)) {
    fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function assertIdentity(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function normalizeScope(input, { requireRun = true } = {}) {
  const value = exactObject(
    input,
    ["mode", "principalId", "browserSessionId", "threadId", "runId", "nativeSessionId"],
    [],
    "text-workspace scope"
  );
  const normalized = frozenRecord({
    mode: value.mode === "resume" ? "resume" : value.mode === "start" ? "start" : "",
    principalId: assertIdentity(value.principalId, /^[A-Za-z0-9._~-]{16,128}$/u, "principal id"),
    browserSessionId: assertDigest(value.browserSessionId, "browser session id"),
    threadId: validateIntegrationThreadId(value.threadId),
    runId: requireRun ? validateIntegrationRunId(value.runId) : String(value.runId || ""),
    nativeSessionId: assertIdentity(
      value.nativeSessionId,
      /^(?!aginti-evidence-v1:)[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u,
      "native session id"
    ),
  });
  if (!normalized.mode) fail("INTEGRATION_TEXT_WORKSPACE_INVALID", "Execution mode is invalid.", 400);
  return normalized;
}

function journalSessionIdFor(scope, storageNamespaceDigest) {
  const digest = contractDigest({
    domain: INTEGRATION_RETAINED_TEXT_WORKSPACE_JOURNAL_ID_DOMAIN,
    profile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
    storageNamespaceDigest,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    threadId: scope.threadId,
    nativeSessionId: scope.nativeSessionId,
  });
  return `${INTEGRATION_RETAINED_TEXT_WORKSPACE_JOURNAL_ID_PREFIX}${digest}`;
}

function snapshotFacts(snapshot, label) {
  assertPlainObject(snapshot, label);
  return frozenRecord({
    nativeSessionId: String(snapshot.nativeSessionId || ""),
    pointerDigest: assertDigest(snapshot.pointerDigest, `${label} pointer digest`, false),
    fileName: String(snapshot.fileName || ""),
    persistenceRevision: Number(snapshot.persistenceRevision),
    runtimeRevision: Number(snapshot.runtimeRevision),
    stateDigest: assertDigest(snapshot.stateDigest, `${label} state digest`),
    integrityDigest: assertDigest(snapshot.integrityDigest, `${label} integrity digest`),
  });
}

function sameSnapshot(left, right) {
  return contractDigest(snapshotFacts(left, "left snapshot")) ===
    contractDigest(snapshotFacts(right, "right snapshot"));
}

function emptyJournal(scope, journalSessionId) {
  return frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_TEXT_WORKSPACE_JOURNAL_VERSION,
    profile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    threadId: scope.threadId,
    nativeSessionId: scope.nativeSessionId,
    journalSessionId,
    eventCount: 0,
    eventBytes: 0,
    lastEventHash: ZERO_DIGEST,
    events: Object.freeze([]),
  });
}

function journalState(journal) {
  return frozenRecord({
    sessionId: journal.journalSessionId,
    meta: frozenRecord({
      runtimeConfig: frozenRecord({ revision: 1 }),
      integrationTextWorkspaceEventJournal: journal,
    }),
  });
}

function validateJournal(snapshot, scope, journalSessionId) {
  const facts = snapshotFacts(snapshot, "retained event journal snapshot");
  if (facts.nativeSessionId !== journalSessionId) {
    fail("INTEGRATION_TEXT_WORKSPACE_CORRUPT", "Retained event journal identity changed.");
  }
  if (facts.persistenceRevision === 0) return emptyJournal(scope, journalSessionId);
  if (facts.runtimeRevision !== 1 || !snapshot.state) {
    fail("INTEGRATION_TEXT_WORKSPACE_CORRUPT", "Retained event journal revision is invalid.");
  }
  const journal = cloneCanonical(
    snapshot.state.meta?.integrationTextWorkspaceEventJournal,
    "retained event journal"
  );
  if (
    journal.schemaVersion !== INTEGRATION_RETAINED_TEXT_WORKSPACE_JOURNAL_VERSION ||
    journal.profile !== INTEGRATION_TEXT_WORKSPACE_PROFILE_ID ||
    journal.principalId !== scope.principalId ||
    journal.browserSessionId !== scope.browserSessionId ||
    journal.threadId !== scope.threadId ||
    journal.nativeSessionId !== scope.nativeSessionId ||
    journal.journalSessionId !== journalSessionId ||
    !Array.isArray(journal.events) ||
    !Number.isSafeInteger(journal.eventCount) ||
    journal.eventCount !== journal.events.length ||
    !Number.isSafeInteger(journal.eventBytes) ||
    journal.eventBytes < 0 ||
    journal.eventCount > INTEGRATION_TEXT_WORKSPACE_MAX_EVENTS ||
    journal.eventBytes > INTEGRATION_TEXT_WORKSPACE_MAX_JOURNAL_BYTES
  ) {
    fail("INTEGRATION_TEXT_WORKSPACE_CORRUPT", "Retained event journal fields are invalid.");
  }
  let previousHash = ZERO_DIGEST;
  let eventBytes = 0;
  for (let index = 0; index < journal.events.length; index += 1) {
    const event = journal.events[index];
    if (
      event.schemaVersion !== INTEGRATION_RETAINED_TEXT_WORKSPACE_EVENT_VERSION ||
      event.sequence !== index + 1 ||
      event.previousHash !== previousHash ||
      typeof event.timestamp !== "string" ||
      typeof event.type !== "string" ||
      !event.type.trim() ||
      event.hash !== contractDigest({
        schemaVersion: event.schemaVersion,
        sequence: event.sequence,
        previousHash: event.previousHash,
        timestamp: event.timestamp,
        type: event.type,
        data: event.data,
      })
    ) {
      fail("INTEGRATION_TEXT_WORKSPACE_CORRUPT", "Retained event journal chain is invalid.");
    }
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (bytes > INTEGRATION_TEXT_WORKSPACE_MAX_EVENT_BYTES) {
      fail("INTEGRATION_TEXT_WORKSPACE_CORRUPT", "Retained event exceeds its byte bound.");
    }
    eventBytes += bytes;
    previousHash = event.hash;
  }
  if (journal.eventBytes !== eventBytes || journal.lastEventHash !== previousHash) {
    fail("INTEGRATION_TEXT_WORKSPACE_CORRUPT", "Retained event journal summary is invalid.");
  }
  return journal;
}

function eventRecord(typeInput, dataInput, journal) {
  if (typeof typeInput !== "string" || typeInput.length < 1 || typeInput.length > 128 || typeInput.trim() !== typeInput) {
    fail("INTEGRATION_TEXT_WORKSPACE_INVALID", "Event type is invalid.", 400);
  }
  const data = cloneCanonical(dataInput, "event data", undefined, 0, "event");
  if (data === OMIT_EVENT_FIELD) {
    fail("INTEGRATION_TEXT_WORKSPACE_INVALID", "Event data must be JSON data.", 400);
  }
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_TEXT_WORKSPACE_EVENT_VERSION,
    sequence: journal.eventCount + 1,
    previousHash: journal.lastEventHash,
    timestamp: new Date().toISOString(),
    type: typeInput,
    data,
  });
  const event = frozenRecord({ ...unsigned, hash: contractDigest(unsigned) });
  const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  if (bytes > INTEGRATION_TEXT_WORKSPACE_MAX_EVENT_BYTES) {
    fail("INTEGRATION_TEXT_WORKSPACE_FULL", "Event exceeds the retained journal byte bound.", 409);
  }
  return frozenRecord({ event, bytes });
}

function buildAttestation(
  store,
  expected,
  evidence,
  nativeWriteFence,
  repository,
  recovery,
  bootstrap,
  fence
) {
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_TEXT_WORKSPACE_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    profile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
    runtimeCapabilityEnabled: false,
    publicServerCapabilityEnabled: false,
    fullSessionStoreRetained: false,
    reachableOperationsRetained: true,
    legacySessionRootAccess: false,
    retainedNativeStateCas: true,
    retainedBoundedHashChainedEventJournal: true,
    journalFailClosedNoPruning: true,
    maxEvents: INTEGRATION_TEXT_WORKSPACE_MAX_EVENTS,
    maxEventBytes: INTEGRATION_TEXT_WORKSPACE_MAX_EVENT_BYTES,
    maxJournalBytes: INTEGRATION_TEXT_WORKSPACE_MAX_JOURNAL_BYTES,
    snapshotOpaqueNoFile: true,
    planProjectedFromDurableState: true,
    queuedInboxDisabled: true,
    browserStorageDisabled: true,
    typedArtifactPersistence: false,
    imagePerception: false,
    shellExecution: false,
    crossProcessExecutionFence: true,
    repositoryTransitionFenceBound: true,
    repositoryFenceDurablyCurrentAtConstruction: true,
    currentRepositoryFenceRevalidationRequired: true,
    exactNativeWriteFenceRequired: true,
    nativeSessionStateWriterFencing: true,
    nativeSessionStateWriterQuiescenceProven: true,
    repositoryFenceDoesNotQuiesceNativeWriters: false,
    fullSessionStoreSidecarsFenced: false,
    imagePerceptionSidecarsFenced: false,
    journalIdDomain: INTEGRATION_RETAINED_TEXT_WORKSPACE_JOURNAL_ID_DOMAIN,
    journalIdPrefix: INTEGRATION_RETAINED_TEXT_WORKSPACE_JOURNAL_ID_PREFIX,
    operationDispositions: OPERATION_DISPOSITIONS,
    operationDispositionDigest: contractDigest(OPERATION_DISPOSITIONS),
    enabledToolNames: INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES,
    enabledToolDigest: contractDigest(INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES),
    storageNamespaceDigest: store.attestation.logicalNamespaceDigest,
    storageAdmissionBindingDigest: store.attestation.admissionBindingDigest,
    storageExpectedDigest: contractDigest(expected),
    nativeExecutionEvidenceDigest: evidence.attestation.digest,
    nativeWriteFenceAttestationDigest: nativeWriteFence.attestation.digest,
    nativeWriteFenceSealDigest: nativeWriteFence.attestation.sessionStateWriteFenceSealDigest,
    repositoryAttestationDigest: repository.integrationRuntimeRepositoryAttestation.digest,
    recoveryCoordinatorAttestationDigest: recovery.attestation.digest,
    processOwnerBootstrapDigest: bootstrap.digest,
    repositoryIdentityDigest: fence.repositoryIdentityDigest,
    repositoryFenceGeneration: fence.generation,
    repositoryFenceOwnerDigest: fence.ownerDigest,
    repositoryFenceOwnerIdentityDigest: fence.ownerIdentityDigest,
    repositoryFenceDigest: fence.fenceDigest,
    repositoryFenceLeaseDigest: fence.leaseDigest,
  });
  return frozenRecord({ ...unsigned, digest: contractDigest(unsigned) });
}

function deny(operation) {
  fail(
    "INTEGRATION_TEXT_WORKSPACE_OPERATION_DENIED",
    `${operation} is outside the retained ${INTEGRATION_TEXT_WORKSPACE_PROFILE_ID} SessionStore profile.`,
    403
  );
}

function exactEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length !== 0) {
    fail("INTEGRATION_TEXT_WORKSPACE_OPERATION_DENIED", `${label} accepts only an exact empty array.`, 403);
  }
}

export async function createRetainedIntegrationTextWorkspace(input = {}) {
  const options = exactPayload(
    input,
    [
      "sessionStateStore",
      "sessionStateStoreExpected",
      "nativeExecutionEvidence",
      "nativeWriteFence",
      "repository",
      "recoveryCoordinator",
      "processOwnerBootstrap",
      "repositoryFenceLease",
    ],
    [],
    "retained text-workspace factory"
  );
  const repository = assertRetainedIntegrationRuntimeRepositorySurface(options.repository);
  const bootstrap = assertIntegrationRuntimeProcessOwnerBootstrap(options.processOwnerBootstrap);
  const nativeWriteFence = await assertRetainedIntegrationRuntimeNativeWriteFenceCurrent(
    options.nativeWriteFence,
    {
      repository,
      processOwnerBootstrap: options.processOwnerBootstrap,
      repositoryFenceLease: options.repositoryFenceLease,
    }
  );
  const evidence = assertRetainedIntegrationNativeExecutionEvidence(
    options.nativeExecutionEvidence,
    {
      sessionStateStore: options.sessionStateStore,
      nativeWriteFence,
    }
  );
  const store = assertRetainedIntegrationSessionStateStore(
    options.sessionStateStore,
    options.sessionStateStoreExpected
  );
  assertRetainedIntegrationNativeExecutionEvidence(evidence, {
    sessionStateStore: store,
    sessionStateStoreExpected: options.sessionStateStoreExpected,
    storageNamespaceDigest: store.attestation.logicalNamespaceDigest,
    nativeWriteFence,
  });
  const recovery = assertRetainedIntegrationRuntimeRecoveryCoordinator(options.recoveryCoordinator, {
    repository,
    nativeExecutionEvidence: evidence,
    processOwnerBootstrap: options.processOwnerBootstrap,
    repositoryFenceLease: options.repositoryFenceLease,
    nativeWriteFence,
  });
  const fence = await assertRetainedIntegrationRuntimeRepositoryFenceLeaseCurrent(
    repository,
    options.repositoryFenceLease
  );
  if (fence.ownerDigest !== bootstrap.ownerDigest) {
    fail("INTEGRATION_REPOSITORY_FENCE_STALE", "Text-workspace process owner does not hold the repository fence.");
  }
  if (store.isClosed() || evidence.isClosed()) {
    fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Retained text-workspace storage is closed.");
  }
  const expected = cloneCanonical(options.sessionStateStoreExpected, "retained storage expected binding");
  const attestation = buildAttestation(
    store,
    expected,
    evidence,
    nativeWriteFence,
    repository,
    recovery,
    bootstrap,
    fence
  );
  const state = {
    store,
    evidence,
    nativeWriteFence,
    expected,
    repository,
    recovery,
    bootstrap,
    repositoryFenceLease: options.repositoryFenceLease,
    attestation,
  };

  const surface = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_TEXT_WORKSPACE_VERSION,
    attestation,

    async attestCurrent() {
      return currentTextWorkspaceProof(state);
    },

    async prepareExecution(scopeInput) {
      const scope = normalizeScope(scopeInput);
      const journalSessionId = journalSessionIdFor(scope, attestation.storageNamespaceDigest);
      const [nativeSnapshot, journalSnapshot] = await Promise.all([
        evidence.loadNativeSessionSnapshot(scope.nativeSessionId),
        store.loadSessionSnapshot(journalSessionId),
      ]);
      validateJournal(journalSnapshot, scope, journalSessionId);
      const handle = frozenRecord({
        schemaVersion: "aginti-retained-text-workspace-preflight-v1",
        proofDigest: contractDigest({
          scope,
          nativeSnapshot: snapshotFacts(nativeSnapshot, "native preflight snapshot"),
          journalSnapshot: snapshotFacts(journalSnapshot, "journal preflight snapshot"),
        }),
      });
      preflightBrand.set(handle, { lane: state, scope, nativeSnapshot, journalSnapshot, journalSessionId });
      return frozenRecord({ handle, nativeState: nativeSnapshot.state, nativeSnapshot });
    },

    async bindAuthorizedExecution(bindingInput) {
      const raw = exactPayload(
        bindingInput,
        ["authorization", "snapshotHash", "preflight"],
        [],
        "text-workspace authorization binding"
      );
      const prepared = preflightBrand.get(raw.preflight);
      if (!prepared || prepared.lane !== state) {
        fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Text-workspace preflight proof is unavailable.");
      }
      const authorization = cloneCanonical(raw.authorization, "native authorization receipt");
      assertPlainObject(authorization, "native authorization receipt");
      if (
        authorization.mode !== prepared.scope.mode ||
        authorization.principalId !== prepared.scope.principalId ||
        authorization.browserSessionId !== prepared.scope.browserSessionId ||
        authorization.threadId !== prepared.scope.threadId ||
        authorization.runId !== prepared.scope.runId ||
        authorization.nativeSessionId !== prepared.scope.nativeSessionId
      ) {
        fail("INTEGRATION_TEXT_WORKSPACE_CONFLICT", "Authorization changed the prepared text-workspace scope.", 409);
      }
      const journalCurrent = await store.loadSessionSnapshot(prepared.journalSessionId);
      if (!sameSnapshot(journalCurrent, prepared.journalSnapshot)) {
        fail("INTEGRATION_TEXT_WORKSPACE_CONFLICT", "Event journal changed after read-only preflight.", 409);
      }
      const nativeBinding = await evidence.bindAuthorizedExecution({
        authorization,
        snapshotHash: raw.snapshotHash,
        preflightSnapshot: prepared.nativeSnapshot,
      });
      const handle = frozenRecord({
        schemaVersion: "aginti-retained-text-workspace-execution-v1",
        bindingDigest: contractDigest({
          preflightProofDigest: raw.preflight.proofDigest,
          authorizationDigest: authorization.authorizationDigest,
          snapshotHash: raw.snapshotHash,
        }),
      });
      executionBrand.set(handle, {
        lane: state,
        scope: prepared.scope,
        nativeBinding,
        journalSessionId: prepared.journalSessionId,
        journalCurrent,
        authorizationDigest: assertDigest(authorization.authorizationDigest, "authorization digest", false),
      });
      preflightBrand.delete(raw.preflight);
      return handle;
    },

    async invoke(handle, operationInput, argsInput = []) {
      const active = executionBrand.get(handle);
      if (!active || active.lane !== state) {
        fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Text-workspace execution binding is unavailable.");
      }
      if (typeof operationInput !== "string") {
        fail("INTEGRATION_TEXT_WORKSPACE_INVALID", "SessionStore operation name is invalid.", 400);
      }
      const operation = operationInput;
      if (!Object.prototype.hasOwnProperty.call(OPERATION_DISPOSITIONS, operation)) deny(operation || "unknown operation");
      if (OPERATION_DISPOSITIONS[operation] === "deny") deny(operation);
      const args = cloneCanonical(
        argsInput,
        `${operation} arguments`,
        undefined,
        0,
        operation === "appendEvent" ? "event" : "strict"
      );
      if (!Array.isArray(args)) {
        fail("INTEGRATION_TEXT_WORKSPACE_INVALID", `${operation} arguments must be an array.`, 400);
      }
      switch (operation) {
        case "ensure":
        case "acknowledgeDrainedInbox":
        case "releaseInboxClaims":
          return undefined;
        case "loadState":
          return evidence.loadNativeState(active.nativeBinding);
        case "saveState":
          return evidence.saveNativeState(active.nativeBinding, args[0]);
        case "savePlan":
          return "";
        case "saveJsonArtifact":
          return "";
        case "saveSnapshot":
          return `aginti-snapshot-v1:${contractDigest({
            profile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
            step: args[0],
            snapshot: cloneCanonical(args[1], "opaque snapshot"),
          })}`;
        case "loadInboxAcknowledgements":
        case "loadInbox":
        case "drainInbox":
          return Object.freeze([]);
        case "saveInbox":
          exactEmptyArray(args[0], "saveInbox");
          return undefined;
        case "markInboxApplied":
          return false;
        case "appendEvent": {
          const current = await store.loadSessionSnapshot(active.journalSessionId);
          if (!sameSnapshot(current, active.journalCurrent)) {
            fail("INTEGRATION_TEXT_WORKSPACE_CONFLICT", "Event journal changed outside the authorized execution.", 409);
          }
          const journal = validateJournal(current, active.scope, active.journalSessionId);
          if (journal.eventCount >= INTEGRATION_TEXT_WORKSPACE_MAX_EVENTS) {
            fail("INTEGRATION_TEXT_WORKSPACE_FULL", "Retained event journal event cap is exhausted.", 409);
          }
          const { event, bytes } = eventRecord(args[0], args[1] ?? {}, journal);
          if (journal.eventBytes + bytes > INTEGRATION_TEXT_WORKSPACE_MAX_JOURNAL_BYTES) {
            fail("INTEGRATION_TEXT_WORKSPACE_FULL", "Retained event journal byte cap is exhausted.", 409);
          }
          const events = Object.freeze([...journal.events, event]);
          const next = frozenRecord({
            ...journal,
            eventCount: events.length,
            eventBytes: journal.eventBytes + bytes,
            lastEventHash: event.hash,
            events,
          });
          const result = await store.compareAndSwapSessionSnapshot({
            mutationId: `text-workspace-event.${active.authorizationDigest}.${event.sequence}`,
            nativeSessionId: active.journalSessionId,
            expectedPersistenceRevision: current.persistenceRevision,
            expectedIntegrityDigest: current.integrityDigest,
            state: journalState(next),
          });
          active.journalCurrent = result.snapshot;
          return undefined;
        }
        case "loadEvents": {
          const current = await store.loadSessionSnapshot(active.journalSessionId);
          if (!sameSnapshot(current, active.journalCurrent)) {
            fail("INTEGRATION_TEXT_WORKSPACE_CONFLICT", "Event journal changed outside the authorized execution.", 409);
          }
          const journal = validateJournal(current, active.scope, active.journalSessionId);
          return Object.freeze(journal.events.map((event) => frozenRecord({
            timestamp: event.timestamp,
            type: event.type,
            data: event.data,
          })));
        }
        default:
          return deny(operation);
      }
    },

    async recordTerminalEvidence(handle, terminal) {
      const active = executionBrand.get(handle);
      if (!active || active.lane !== state) {
        fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Text-workspace execution binding is unavailable.");
      }
      return evidence.recordTerminalEvidence(active.nativeBinding, terminal);
    },

    isClosed() {
      return store.isClosed() || evidence.isClosed();
    },
  });
  profileBrand.set(surface, state);
  return surface;
}

export function assertRetainedIntegrationTextWorkspace(value, expected = {}) {
  const state = value && typeof value === "object" && !utilTypes.isProxy(value)
    ? profileBrand.get(value)
    : null;
  if (!state || value.schemaVersion !== INTEGRATION_RETAINED_TEXT_WORKSPACE_VERSION) {
    fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Retained text-workspace lexical brand is invalid.");
  }
  if (expected.nativeExecutionEvidence && state.evidence !== expected.nativeExecutionEvidence) {
    fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Text-workspace native evidence identity changed.");
  }
  if (expected.nativeWriteFence && state.nativeWriteFence !== expected.nativeWriteFence) {
    fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Text-workspace native-write fence identity changed.");
  }
  if (expected.sessionStateStore && state.store !== expected.sessionStateStore) {
    fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Text-workspace retained store identity changed.");
  }
  if (
    expected.repository && state.repository !== expected.repository ||
    expected.recoveryCoordinator && state.recovery !== expected.recoveryCoordinator ||
    expected.processOwnerBootstrap && state.bootstrap !== expected.processOwnerBootstrap ||
    expected.repositoryFenceLease && state.repositoryFenceLease !== expected.repositoryFenceLease
  ) {
    fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Text-workspace repository fence binding changed.");
  }
  if (expected.sessionStateStoreExpected) {
    assertRetainedIntegrationSessionStateStore(state.store, expected.sessionStateStoreExpected);
  }
  assertRetainedIntegrationRuntimeNativeWriteFence(state.nativeWriteFence, {
    repository: state.repository,
    processOwnerBootstrap: state.bootstrap,
    repositoryFenceLease: state.repositoryFenceLease,
  });
  assertRetainedIntegrationNativeExecutionEvidence(state.evidence, {
    sessionStateStore: state.store,
    sessionStateStoreExpected: state.expected,
    nativeWriteFence: state.nativeWriteFence,
  });
  assertRetainedIntegrationRuntimeRecoveryCoordinator(state.recovery, {
    repository: state.repository,
    nativeExecutionEvidence: state.evidence,
    processOwnerBootstrap: state.bootstrap,
    repositoryFenceLease: state.repositoryFenceLease,
    nativeWriteFence: state.nativeWriteFence,
  });
  if (value.attestation.digest !== contractDigest(Object.fromEntries(
    Object.entries(value.attestation).filter(([key]) => key !== "digest")
  ))) {
    fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Retained text-workspace attestation is invalid.");
  }
  return value;
}

async function currentTextWorkspaceProof(state) {
  if (state.store.isClosed() || state.evidence.isClosed()) {
    fail("INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE", "Retained text-workspace storage is closed.");
  }
  assertRetainedIntegrationNativeExecutionEvidence(state.evidence, {
    sessionStateStore: state.store,
    sessionStateStoreExpected: state.expected,
    nativeWriteFence: state.nativeWriteFence,
  });
  const nativeWriteFence = await assertRetainedIntegrationRuntimeNativeWriteFenceCurrent(
    state.nativeWriteFence,
    {
      repository: state.repository,
      processOwnerBootstrap: state.bootstrap,
      repositoryFenceLease: state.repositoryFenceLease,
    }
  );
  assertRetainedIntegrationRuntimeRecoveryCoordinator(state.recovery, {
    repository: state.repository,
    nativeExecutionEvidence: state.evidence,
    processOwnerBootstrap: state.bootstrap,
    repositoryFenceLease: state.repositoryFenceLease,
    nativeWriteFence,
  });
  const fence = await assertRetainedIntegrationRuntimeRepositoryFenceLeaseCurrent(
    state.repository,
    state.repositoryFenceLease
  );
  if (
    fence.ownerDigest !== state.bootstrap.ownerDigest ||
    fence.repositoryIdentityDigest !== state.attestation.repositoryIdentityDigest ||
    fence.generation !== state.attestation.repositoryFenceGeneration ||
    fence.ownerIdentityDigest !== state.attestation.repositoryFenceOwnerIdentityDigest ||
    fence.fenceDigest !== state.attestation.repositoryFenceDigest ||
    fence.leaseDigest !== state.attestation.repositoryFenceLeaseDigest ||
    nativeWriteFence.attestation.digest !== state.attestation.nativeWriteFenceAttestationDigest ||
    nativeWriteFence.attestation.repositoryIdentityDigest !== fence.repositoryIdentityDigest ||
    nativeWriteFence.attestation.repositoryFenceGeneration !== fence.generation ||
    nativeWriteFence.attestation.repositoryFenceOwnerDigest !== fence.ownerDigest ||
    nativeWriteFence.attestation.repositoryFenceOwnerIdentityDigest !== fence.ownerIdentityDigest ||
    nativeWriteFence.attestation.repositoryFenceDigest !== fence.fenceDigest ||
    nativeWriteFence.attestation.repositoryFenceLeaseDigest !== fence.leaseDigest
  ) {
    fail("INTEGRATION_REPOSITORY_FENCE_STALE", "Text-workspace repository fence is stale or changed.");
  }
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_TEXT_WORKSPACE_CURRENT_PROOF_VERSION,
    profileAttestationDigest: state.attestation.digest,
    repositorySnapshotRevision: fence.repositorySnapshotRevision,
    repositoryIntegrityDigest: fence.repositoryIntegrityDigest,
    repositoryFenceGeneration: fence.generation,
    repositoryFenceOwnerDigest: fence.ownerDigest,
    repositoryFenceDigest: fence.fenceDigest,
    repositoryFenceLeaseDigest: fence.leaseDigest,
    durablyCurrent: true,
    nativeWriteFenceAttestationDigest: nativeWriteFence.attestation.digest,
    nativeWriteFenceSealDigest: nativeWriteFence.attestation.sessionStateWriteFenceSealDigest,
    nativeSessionStateWriterFencing: true,
    nativeSessionStateWriterQuiescenceProven: true,
    fullSessionStoreSidecarsFenced: false,
    imagePerceptionSidecarsFenced: false,
  });
  return frozenRecord({ ...unsigned, digest: contractDigest(unsigned) });
}

export async function assertRetainedIntegrationTextWorkspaceCurrent(value, expected = {}) {
  assertRetainedIntegrationTextWorkspace(value, expected);
  return currentTextWorkspaceProof(profileBrand.get(value));
}

export function isIntegrationTextWorkspaceToolAllowed(name) {
  return INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES.includes(String(name || ""));
}
