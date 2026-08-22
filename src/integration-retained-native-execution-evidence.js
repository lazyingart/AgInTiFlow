import { types as utilTypes } from "node:util";
import {
  assertRetainedIntegrationSessionStateStore,
} from "./integration-retained-session-state-store.js";
import {
  contractDigest,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";
import { authorityFail } from "./integration-durable-common.js";
import { redactSensitiveText } from "./redaction.js";

export const INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_VERSION =
  "aginti-retained-native-execution-evidence-v1";
export const INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_ATTESTATION_VERSION =
  "aginti-retained-native-execution-evidence-attestation-v1";
export const INTEGRATION_RETAINED_NATIVE_EXECUTION_TERMINAL_VERSION =
  "aginti-retained-native-execution-terminal-v1";
export const INTEGRATION_RETAINED_NATIVE_STATE_MARKER_VERSION =
  "aginti-retained-native-state-marker-v1";
export const INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_ID_DOMAIN =
  "aginti-retained-native-execution-evidence-id-v1";
export const INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_ID_PREFIX =
  "aginti-evidence-v1:";

const ZERO_DIGEST = "0".repeat(64);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PUBLIC_ERROR_CODES = new Set([
  "AGINTI_RUNTIME_ERROR",
  "CANCELLED",
  "PROVIDER_PREFLIGHT_FAILED",
  "MODEL_TIMEOUT",
  "MAX_STEPS",
  "SESSION_RUNTIME_TAKEOVER_BLOCKED",
]);
const AUTHORIZATION_KEYS = Object.freeze([
  "schemaVersion", "mode", "principalId", "browserSessionId", "browserSessionPolicy", "threadId", "runId",
  "nativeSessionId", "previousRunId", "previousRunRevision", "previousRunRuntimeRevision", "threadRevision",
  "threadPreservationDigest", "createdAt", "startedAt", "expectedNativeRuntimeRevision",
  "targetNativeRuntimeRevision", "expectedRunRevision", "targetRunRevision", "dispatchLeaseId",
  "dispatchOutbox", "dispatchedAt", "processOwner", "authorizedAt", "authorizationId", "authorizationDigest",
]);
const MAX_CANONICAL_NODES = 250_000;
const MAX_CANONICAL_DEPTH = 64;
const PRIVATE_RUNTIME_PATTERN =
  /(?:^|[\s("'`])(?:\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/|\b)|[A-Za-z]:\\)|(?:api[_-]?key|token|secret|password)\s*[:=]/iu;
const laneBrand = new WeakMap();
const bindingBrand = new WeakMap();

function fail(code, message, status = 503) {
  authorityFail(code, message, { status });
}

function assertPlainData(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} must be plain data.`, 400);
  }
  return value;
}

function assertExactKeys(value, required, optional, label) {
  assertPlainData(value, label);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} fields are invalid.`, 400);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label}.${String(key)} must be a data field.`, 400);
    }
  }
  return value;
}

function cloneCanonical(value, label, state = { nodes: 0, active: new WeakSet() }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} exceeds structural bounds.`, 400);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} contains a non-canonical number.`, 400);
    }
    return value;
  }
  if (value && typeof value === "object" && utilTypes.isProxy(value)) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} must contain trap-safe data.`, 400);
  }
  if (value && typeof value === "object" && utilTypes.isPromise(value)) {
    if (Object.getPrototypeOf(value) === Promise.prototype) {
      Promise.prototype.then.call(value, undefined, () => undefined);
    }
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} must be synchronous data.`, 400);
  }
  if (!value || typeof value !== "object" || state.active.has(value)) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} must be acyclic JSON data.`, 400);
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} array prototype is invalid.`, 400);
      }
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (keys.length !== value.length) {
        fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} array must be dense data.`, 400);
      }
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label}[${index}] must be a data field.`, 400);
        }
        clone[index] = cloneCanonical(descriptor.value, `${label}[${index}]`, state, depth + 1);
      }
      return Object.freeze(clone);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} object prototype is invalid.`, 400);
    }
    const clone = Object.create(null);
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== "string") {
        fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} must not contain symbols.`, 400);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label}.${key} must be a data field.`, 400);
      }
      Object.defineProperty(clone, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: cloneCanonical(descriptor.value, `${label}.${key}`, state, depth + 1),
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

function assertDigest(value, label, { allowZero = true } = {}) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value) || (!allowZero && value === ZERO_DIGEST)) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function assertNativeSessionId(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value) ||
    value.includes("..") ||
    value.startsWith(INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_ID_PREFIX)
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Native session id is invalid or reserved.", 400);
  }
  return value;
}

function assertPrincipalId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/u.test(value)) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Principal id is invalid.", 400);
  }
  return value;
}

function assertBrowserSessionId(value) {
  return assertDigest(value, "browser session id");
}

function assertRevision(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function assertCanonicalIso(value, label) {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} is invalid.`, 400);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function assertPublicText(value, label, maximum, minimum = 0, { trim = false } = {}) {
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum ||
    /\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    redactSensitiveText(value) !== value || PRIVATE_RUNTIME_PATTERN.test(value) ||
    (trim && value.trim() !== value)
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function evidenceSessionIdFor(binding) {
  const digest = contractDigest({
    domain: INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_ID_DOMAIN,
    storageNamespaceDigest: binding.storageNamespaceDigest,
    principalId: binding.principalId,
    browserSessionId: binding.browserSessionId,
    threadId: binding.threadId,
    runId: binding.runId,
    nativeSessionId: binding.nativeSessionId,
    authorizationDigest: binding.authorizationDigest,
  });
  return `${INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_ID_PREFIX}${digest}`;
}

function snapshotFacts(snapshot, label) {
  assertPlainData(snapshot, label);
  const facts = frozenRecord({
    nativeSessionId: assertNativeSessionId(snapshot.nativeSessionId),
    pointerDigest: assertDigest(snapshot.pointerDigest, `${label} pointer digest`, { allowZero: false }),
    fileName: assertPublicText(snapshot.fileName, `${label} file name`, 256, 1),
    persistenceRevision: assertRevision(snapshot.persistenceRevision, `${label} persistence revision`),
    runtimeRevision: assertRevision(snapshot.runtimeRevision, `${label} runtime revision`),
    stateDigest: assertDigest(snapshot.stateDigest, `${label} state digest`),
    integrityDigest: assertDigest(snapshot.integrityDigest, `${label} integrity digest`),
  });
  if (
    (facts.persistenceRevision === 0) !== (facts.integrityDigest === ZERO_DIGEST) ||
    (facts.persistenceRevision === 0) !== (facts.stateDigest === ZERO_DIGEST) ||
    (facts.persistenceRevision === 0) !== (snapshot.state === null)
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_CORRUPT", `${label} absence proof is inconsistent.`);
  }
  return facts;
}

function exactSnapshotMatch(snapshot, facts) {
  const current = snapshotFacts(snapshot, "retained native snapshot");
  return contractDigest(current) === contractDigest(facts);
}

function normalizeAuthorization(input) {
  const authorization = assertExactKeys(
    cloneCanonical(input, "native start authorization"),
    AUTHORIZATION_KEYS,
    [],
    "native start authorization"
  );
  if (authorization.schemaVersion !== "aginti-native-start-authorization-v1") {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Native start authorization schema is invalid.", 400);
  }
  const mode = authorization.mode;
  if (mode !== "start" && mode !== "resume") {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Native start authorization mode is invalid.", 400);
  }
  const normalized = frozenRecord({
    mode,
    principalId: assertPrincipalId(authorization.principalId),
    browserSessionId: assertBrowserSessionId(authorization.browserSessionId),
    threadId: validateIntegrationThreadId(authorization.threadId),
    runId: validateIntegrationRunId(authorization.runId),
    nativeSessionId: assertNativeSessionId(authorization.nativeSessionId),
    authorizationId: assertPublicText(authorization.authorizationId, "authorization id", 128, 8),
    authorizationDigest: assertDigest(authorization.authorizationDigest, "authorization digest", { allowZero: false }),
    processOwnerDigest: contractDigest(authorization.processOwner),
    expectedNativeRuntimeRevision: assertRevision(
      authorization.expectedNativeRuntimeRevision,
      "expected native runtime revision",
      1
    ),
    targetNativeRuntimeRevision: assertRevision(
      authorization.targetNativeRuntimeRevision,
      "target native runtime revision",
      1
    ),
  });
  if (
    (mode === "start" && normalized.targetNativeRuntimeRevision !== normalized.expectedNativeRuntimeRevision) ||
    (mode === "resume" && normalized.targetNativeRuntimeRevision !== normalized.expectedNativeRuntimeRevision + 1)
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Native start authorization revision transition is invalid.", 400);
  }
  const {
    authorizationId: _authorizationId,
    authorizationDigest: _authorizationDigest,
    ...unsigned
  } = authorization;
  const digest = contractDigest(unsigned);
  if (
    authorization.browserSessionPolicy !== "same-browser-session" ||
    authorization.authorizationDigest !== digest ||
    authorization.authorizationId !== `nstart_${digest.slice(0, 48)}`
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Native start authorization receipt digest is invalid.", 400);
  }
  return normalized;
}

function bindingInput(input, storageNamespaceDigest) {
  const raw = assertExactKeys(
    input,
    ["authorization", "snapshotHash", "preflightSnapshot"],
    [],
    "native execution binding"
  );
  const authorization = normalizeAuthorization(raw.authorization);
  const snapshotHash = assertDigest(raw.snapshotHash, "immutable run snapshot hash", { allowZero: false });
  const preflightSnapshot = snapshotFacts(raw.preflightSnapshot, "native preflight snapshot");
  if (preflightSnapshot.nativeSessionId !== authorization.nativeSessionId) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Native preflight session binding changed.", 400);
  }
  if (
    (authorization.mode === "start" && (
      preflightSnapshot.persistenceRevision !== 0 || preflightSnapshot.runtimeRevision !== 0
    )) ||
    (authorization.mode === "resume" && (
      preflightSnapshot.persistenceRevision < 1 ||
      preflightSnapshot.runtimeRevision !== authorization.expectedNativeRuntimeRevision
    ))
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_CONFLICT", "Native preflight revision no longer matches authorization.", 409);
  }
  return frozenRecord({
    ...authorization,
    snapshotHash,
    storageNamespaceDigest,
    preflightSnapshot,
  });
}

function nativeMarkerFor(binding) {
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_STATE_MARKER_VERSION,
    principalId: binding.principalId,
    browserSessionId: binding.browserSessionId,
    threadId: binding.threadId,
    runId: binding.runId,
    nativeSessionId: binding.nativeSessionId,
    authorizationId: binding.authorizationId,
    authorizationDigest: binding.authorizationDigest,
    processOwnerDigest: binding.processOwnerDigest,
    snapshotHash: binding.snapshotHash,
    expectedNativeRuntimeRevision: binding.expectedNativeRuntimeRevision,
    targetNativeRuntimeRevision: binding.targetNativeRuntimeRevision,
    storageNamespaceDigest: binding.storageNamespaceDigest,
  });
  return frozenRecord({ ...unsigned, digest: contractDigest(unsigned) });
}

function markerMatches(value, binding) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    contractDigest(value) === contractDigest(nativeMarkerFor(binding))
  );
}

function stateWithMarker(stateInput, binding) {
  const state = cloneCanonical(stateInput, "native SessionStore state");
  if (
    !state || typeof state !== "object" || Array.isArray(state) ||
    state.sessionId !== binding.nativeSessionId ||
    state.meta?.runtimeConfig?.revision !== binding.targetNativeRuntimeRevision
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Native SessionStore state does not match the execution target.", 400);
  }
  return Object.freeze({
    ...state,
    meta: Object.freeze({
      ...state.meta,
      integrationNativeExecution: nativeMarkerFor(binding),
    }),
  });
}

function normalizeTerminal(input, binding, nativeSnapshot) {
  const raw = assertExactKeys(
    input,
    ["status", "output", "error", "resultDigest", "completedAt", "persistedRuntimeRevision"],
    [],
    "native terminal evidence"
  );
  if (!TERMINAL_STATUSES.has(raw.status)) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Native terminal status is invalid.", 400);
  }
  const output = assertPublicText(raw.output, "native terminal output", 32_000);
  let error = null;
  if (raw.error !== null) {
    const envelope = assertExactKeys(raw.error, ["code", "message"], [], "native terminal error");
    if (!PUBLIC_ERROR_CODES.has(envelope.code)) {
      fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Native terminal error code is invalid.", 400);
    }
    error = frozenRecord({
      code: envelope.code,
      message: assertPublicText(envelope.message, "native terminal error message", 600, 1, { trim: true }),
    });
  }
  if (
    (raw.status === "completed" && error !== null) ||
    (raw.status !== "completed" && (output !== "" || error === null)) ||
    (raw.status === "cancelled") !== (error?.code === "CANCELLED")
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_INVALID", "Native terminal output and error do not match status.", 400);
  }
  const persistedRuntimeRevision = assertRevision(
    raw.persistedRuntimeRevision,
    "terminal persisted runtime revision",
    1
  );
  if (
    persistedRuntimeRevision !== binding.targetNativeRuntimeRevision ||
    nativeSnapshot.runtimeRevision !== persistedRuntimeRevision
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_CONFLICT", "Native terminal revision was not retained.", 409);
  }
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_EXECUTION_TERMINAL_VERSION,
    evidenceSessionId: evidenceSessionIdFor(binding),
    principalId: binding.principalId,
    browserSessionId: binding.browserSessionId,
    threadId: binding.threadId,
    runId: binding.runId,
    nativeSessionId: binding.nativeSessionId,
    authorizationId: binding.authorizationId,
    authorizationDigest: binding.authorizationDigest,
    processOwnerDigest: binding.processOwnerDigest,
    snapshotHash: binding.snapshotHash,
    expectedNativeRuntimeRevision: binding.expectedNativeRuntimeRevision,
    targetNativeRuntimeRevision: binding.targetNativeRuntimeRevision,
    storageNamespaceDigest: binding.storageNamespaceDigest,
    nativePointerDigest: nativeSnapshot.pointerDigest,
    nativeFileName: nativeSnapshot.fileName,
    nativePersistenceRevision: nativeSnapshot.persistenceRevision,
    nativeRuntimeRevision: nativeSnapshot.runtimeRevision,
    nativeStateDigest: nativeSnapshot.stateDigest,
    nativeIntegrityDigest: nativeSnapshot.integrityDigest,
    status: raw.status,
    output,
    error,
    resultDigest: assertDigest(raw.resultDigest, "terminal result digest", { allowZero: false }),
    completedAt: assertCanonicalIso(raw.completedAt, "terminal completedAt"),
  });
  return frozenRecord({ ...unsigned, evidenceDigest: contractDigest(unsigned) });
}

function evidenceState(record) {
  return frozenRecord({
    sessionId: record.evidenceSessionId,
    meta: frozenRecord({
      runtimeConfig: frozenRecord({ revision: 1 }),
      nativeExecutionEvidence: record,
    }),
  });
}

function recordedNativeSnapshotFacts(record, binding) {
  return frozenRecord({
    nativeSessionId: binding.nativeSessionId,
    pointerDigest: assertDigest(record.nativePointerDigest, "recorded native pointer digest", {
      allowZero: false,
    }),
    fileName: assertPublicText(record.nativeFileName, "recorded native file name", 256, 1),
    persistenceRevision: assertRevision(
      record.nativePersistenceRevision,
      "recorded native persistence revision",
      1
    ),
    runtimeRevision: assertRevision(record.nativeRuntimeRevision, "recorded native runtime revision", 1),
    stateDigest: assertDigest(record.nativeStateDigest, "recorded native state digest", { allowZero: false }),
    integrityDigest: assertDigest(record.nativeIntegrityDigest, "recorded native integrity digest", {
      allowZero: false,
    }),
  });
}

function validateTerminalRecord(recordInput, binding, liveNativeSnapshot = null) {
  const record = assertPlainData(recordInput, "retained terminal evidence record");
  const recordedSnapshot = recordedNativeSnapshotFacts(record, binding);
  if (
    record.schemaVersion !== INTEGRATION_RETAINED_NATIVE_EXECUTION_TERMINAL_VERSION ||
    record.evidenceSessionId !== evidenceSessionIdFor(binding) ||
    record.evidenceDigest !== contractDigest(Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "evidenceDigest")
    ))
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_CORRUPT", "Retained terminal evidence identity is invalid.");
  }
  if (
    liveNativeSnapshot !== null && (
      !exactSnapshotMatch(liveNativeSnapshot, recordedSnapshot) ||
      !markerMatches(liveNativeSnapshot.state?.meta?.integrationNativeExecution, binding)
    )
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_CORRUPT", "Retained terminal evidence does not match native state.");
  }
  const rebuilt = normalizeTerminal({
    status: record.status,
    output: record.output,
    error: record.error,
    resultDigest: record.resultDigest,
    completedAt: record.completedAt,
    persistedRuntimeRevision: record.nativeRuntimeRevision,
  }, binding, recordedSnapshot);
  if (contractDigest(rebuilt) !== contractDigest(record)) {
    fail("INTEGRATION_NATIVE_EVIDENCE_CORRUPT", "Retained terminal evidence fields are invalid.");
  }
  return frozenRecord({ record, nativeSnapshot: recordedSnapshot });
}

function runBinding(run, storageNamespaceDigest) {
  const record = assertPlainData(run, "recovery-held run");
  validateIntegrationRunId(record.id);
  validateIntegrationThreadId(record.threadId);
  const receipt = assertPlainData(record.nativeStartReceipt, "recovery-held native start receipt");
  const held = record.status === "running" && record.recoveryState !== null;
  const terminal = TERMINAL_STATUSES.has(record.status) && record.recoveryState === null;
  const recovery = held ? assertPlainData(record.recoveryState, "recovery-held state") : null;
  if (
    (!held && !terminal) ||
    (held && (
      recovery.status !== "recovery_hold" ||
      receipt.authorizationId !== recovery.authorizationId ||
      receipt.authorizationDigest !== recovery.authorizationDigest
    ))
  ) {
    fail("RECOVERY_EVIDENCE_UNAVAILABLE", "Run is not in an exact native recovery hold.");
  }
  return frozenRecord({
    mode: receipt.mode,
    principalId: assertPrincipalId(record.principalId),
    browserSessionId: assertBrowserSessionId(record.browserSessionId),
    threadId: record.threadId,
    runId: record.id,
    nativeSessionId: assertNativeSessionId(record.nativeSessionId),
    authorizationId: assertPublicText(receipt.authorizationId, "authorization id", 128, 8),
    authorizationDigest: assertDigest(receipt.authorizationDigest, "authorization digest", { allowZero: false }),
    processOwnerDigest: contractDigest(receipt.processOwner),
    expectedNativeRuntimeRevision: assertRevision(receipt.expectedNativeRuntimeRevision, "expected runtime revision", 1),
    targetNativeRuntimeRevision: assertRevision(receipt.targetNativeRuntimeRevision, "target runtime revision", 1),
    snapshotHash: assertDigest(record.authority?.snapshotHash, "immutable run snapshot hash", { allowZero: false }),
    storageNamespaceDigest,
    preflightSnapshot: null,
  });
}

function buildAttestation(store, expected) {
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    runtimeCapabilityEnabled: false,
    publicServerCapabilityEnabled: false,
    descriptorBoundSessionState: true,
    readOnlyPreflightBeforeAuthorization: true,
    nativeWriteRequiresAuthorizationBinding: true,
    authorizationProcessOwnerDigestBound: true,
    terminalEvidenceRetained: true,
    recoveryRequiresExactTerminalEvidence: true,
    recoveryFromRevisionOnly: false,
    recoveryFromAbsenceOrBaseRevision: false,
    crossProcessExecutionFence: false,
    fullSessionStoreRetained: false,
    evidenceIdDomain: INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_ID_DOMAIN,
    evidenceIdPrefix: INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_ID_PREFIX,
    storageNamespaceDigest: store.attestation.logicalNamespaceDigest,
    storageAdmissionBindingDigest: store.attestation.admissionBindingDigest,
    storageExpectedDigest: contractDigest(expected),
  });
  return frozenRecord({ ...unsigned, digest: contractDigest(unsigned) });
}

export function createRetainedIntegrationNativeExecutionEvidence(input = {}) {
  const options = assertExactKeys(
    input,
    ["sessionStateStore", "sessionStateStoreExpected"],
    [],
    "native execution evidence factory"
  );
  const store = assertRetainedIntegrationSessionStateStore(
    options.sessionStateStore,
    options.sessionStateStoreExpected
  );
  if (store.isClosed()) fail("INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE", "Retained native evidence store is closed.");
  const expected = cloneCanonical(options.sessionStateStoreExpected, "retained native evidence expected binding");
  const attestation = buildAttestation(store, expected);
  const state = { store, expected, attestation };

  const surface = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_VERSION,
    attestation,

    async loadNativeSessionSnapshot(nativeSessionIdInput) {
      const nativeSessionId = assertNativeSessionId(nativeSessionIdInput);
      return store.loadSessionSnapshot(nativeSessionId);
    },

    async bindAuthorizedExecution(inputBinding) {
      const binding = bindingInput(inputBinding, attestation.storageNamespaceDigest);
      const current = await store.loadSessionSnapshot(binding.nativeSessionId);
      if (!exactSnapshotMatch(current, binding.preflightSnapshot)) {
        fail("INTEGRATION_NATIVE_EVIDENCE_CONFLICT", "Native state changed after read-only preflight.", 409);
      }
      const handle = frozenRecord({
        schemaVersion: "aginti-retained-native-execution-binding-v1",
        bindingDigest: contractDigest(binding),
      });
      bindingBrand.set(handle, { lane: state, binding, current });
      return handle;
    },

    async loadNativeState(handle) {
      const active = bindingBrand.get(handle);
      if (!active || active.lane !== state) {
        fail("INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE", "Native execution binding is unavailable.");
      }
      const current = await store.loadSessionSnapshot(active.binding.nativeSessionId);
      if (!exactSnapshotMatch(current, snapshotFacts(active.current, "authorized native baseline"))) {
        fail("INTEGRATION_NATIVE_EVIDENCE_CONFLICT", "Native state changed outside the authorized SessionStore.", 409);
      }
      if (current.persistenceRevision === 0) return null;
      return current.state;
    },

    async saveNativeState(handle, nativeStateInput) {
      const active = bindingBrand.get(handle);
      if (!active || active.lane !== state) {
        fail("INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE", "Native execution binding is unavailable.");
      }
      const current = active.current;
      const durableState = stateWithMarker(nativeStateInput, active.binding);
      const mutationId = `native-state.${active.binding.authorizationDigest}.${current.persistenceRevision + 1}`;
      const result = await store.compareAndSwapSessionSnapshot({
        mutationId,
        nativeSessionId: active.binding.nativeSessionId,
        expectedPersistenceRevision: current.persistenceRevision,
        expectedIntegrityDigest: current.integrityDigest,
        state: durableState,
      });
      active.current = result.snapshot;
      return result.snapshot.state;
    },

    async recordTerminalEvidence(handle, terminalInput) {
      const active = bindingBrand.get(handle);
      if (!active || active.lane !== state) {
        fail("INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE", "Native execution binding is unavailable.");
      }
      const nativeSnapshot = await store.loadSessionSnapshot(active.binding.nativeSessionId);
      if (
        nativeSnapshot.persistenceRevision !== active.current.persistenceRevision ||
        nativeSnapshot.integrityDigest !== active.current.integrityDigest ||
        nativeSnapshot.stateDigest !== active.current.stateDigest ||
        nativeSnapshot.runtimeRevision !== active.binding.targetNativeRuntimeRevision ||
        !markerMatches(nativeSnapshot.state?.meta?.integrationNativeExecution, active.binding)
      ) {
        fail("INTEGRATION_NATIVE_EVIDENCE_CONFLICT", "Exact authorized native persistence evidence is unavailable.", 409);
      }
      const terminal = normalizeTerminal(terminalInput, active.binding, nativeSnapshot);
      const evidenceSessionId = terminal.evidenceSessionId;
      const current = await store.loadSessionSnapshot(evidenceSessionId);
      if (current.persistenceRevision > 0) {
        const existing = current.state?.meta?.nativeExecutionEvidence;
        if (contractDigest(existing) !== contractDigest(terminal)) {
          fail("INTEGRATION_NATIVE_EVIDENCE_CONFLICT", "Terminal evidence already exists with different content.", 409);
        }
        return frozenRecord({ outcome: "replayed", evidence: existing, snapshot: current });
      }
      const result = await store.compareAndSwapSessionSnapshot({
        mutationId: `native-terminal.${active.binding.authorizationDigest}`,
        nativeSessionId: evidenceSessionId,
        expectedPersistenceRevision: 0,
        expectedIntegrityDigest: ZERO_DIGEST,
        state: evidenceState(terminal),
      });
      return frozenRecord({ outcome: result.outcome, evidence: terminal, snapshot: result.snapshot });
    },

    async inspectRecoveryEvidence(runInput) {
      const binding = runBinding(runInput, attestation.storageNamespaceDigest);
      const held = runInput.status === "running" && runInput.recoveryState?.status === "recovery_hold";
      const liveNativeSnapshot = held
        ? await store.loadSessionSnapshot(binding.nativeSessionId)
        : null;
      if (
        held && (
          liveNativeSnapshot.persistenceRevision < 1 ||
          liveNativeSnapshot.runtimeRevision !== binding.targetNativeRuntimeRevision ||
          !markerMatches(liveNativeSnapshot.state?.meta?.integrationNativeExecution, binding)
        )
      ) {
        fail(
          "RECOVERY_EVIDENCE_UNAVAILABLE",
          "Exact terminal native-state evidence is unavailable; recovery hold is preserved."
        );
      }
      const evidenceId = evidenceSessionIdFor(binding);
      const evidenceSnapshot = await store.loadSessionSnapshot(evidenceId);
      if (evidenceSnapshot.persistenceRevision !== 1 || evidenceSnapshot.runtimeRevision !== 1) {
        fail(
          "RECOVERY_EVIDENCE_UNAVAILABLE",
          "Exact retained terminal classification is unavailable; recovery hold is preserved."
        );
      }
      const validatedTerminal = validateTerminalRecord(
        evidenceSnapshot.state?.meta?.nativeExecutionEvidence,
        binding,
        liveNativeSnapshot
      );
      const terminal = validatedTerminal.record;
      const nativeSnapshot = validatedTerminal.nativeSnapshot;
      if (
        TERMINAL_STATUSES.has(runInput.status) && (
          runInput.status !== terminal.status ||
          runInput.output !== terminal.output ||
          contractDigest(runInput.error) !== contractDigest(terminal.error) ||
          runInput.completedAt !== terminal.completedAt ||
          runInput.authority?.runtimeRevision !== terminal.nativeRuntimeRevision
        )
      ) {
        fail("INTEGRATION_NATIVE_EVIDENCE_CORRUPT", "Terminal run diverged from its retained execution evidence.");
      }
      return frozenRecord({
        schemaVersion: "aginti-retained-native-recovery-evidence-v1",
        runId: binding.runId,
        authorizationId: binding.authorizationId,
        authorizationDigest: binding.authorizationDigest,
        snapshotHash: binding.snapshotHash,
        nativeSnapshot,
        evidenceSnapshot: frozenRecord({
          nativeSessionId: evidenceSnapshot.nativeSessionId,
          pointerDigest: evidenceSnapshot.pointerDigest,
          fileName: evidenceSnapshot.fileName,
          persistenceRevision: evidenceSnapshot.persistenceRevision,
          runtimeRevision: evidenceSnapshot.runtimeRevision,
          stateDigest: evidenceSnapshot.stateDigest,
          integrityDigest: evidenceSnapshot.integrityDigest,
        }),
        terminal,
        proofDigest: contractDigest({
          runId: binding.runId,
          authorizationDigest: binding.authorizationDigest,
          processOwnerDigest: binding.processOwnerDigest,
          snapshotHash: binding.snapshotHash,
          nativeIntegrityDigest: nativeSnapshot.integrityDigest,
          evidenceIntegrityDigest: evidenceSnapshot.integrityDigest,
          terminalEvidenceDigest: terminal.evidenceDigest,
        }),
      });
    },

    isClosed() {
      return store.isClosed();
    },
  });
  laneBrand.set(surface, state);
  return surface;
}

export function assertRetainedIntegrationNativeExecutionEvidence(value, expected = {}) {
  const state = value && typeof value === "object" && !utilTypes.isProxy(value)
    ? laneBrand.get(value)
    : null;
  if (!state || value.schemaVersion !== INTEGRATION_RETAINED_NATIVE_EXECUTION_EVIDENCE_VERSION) {
    fail("INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE", "Retained native execution evidence lexical brand is invalid.");
  }
  if (expected.sessionStateStoreExpected) {
    assertRetainedIntegrationSessionStateStore(state.store, expected.sessionStateStoreExpected);
  }
  if (
    expected.storageNamespaceDigest &&
    value.attestation.storageNamespaceDigest !== expected.storageNamespaceDigest
  ) {
    fail("INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE", "Retained native evidence namespace binding changed.");
  }
  if (value.attestation.digest !== contractDigest(Object.fromEntries(
    Object.entries(value.attestation).filter(([key]) => key !== "digest")
  ))) {
    fail("INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE", "Retained native evidence attestation is invalid.");
  }
  return value;
}
