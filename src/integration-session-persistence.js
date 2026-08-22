import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { contractDigest } from "./integration-policy.js";
import {
  assertRetainedIntegrationNativeExecutionEvidence,
} from "./integration-retained-native-execution-evidence.js";
import {
  assertRetainedIntegrationTextWorkspace,
} from "./integration-retained-text-workspace.js";
import {
  assertRetainedIntegrationVisionWorkspace,
} from "./integration-retained-vision-workspace.js";

const registrations = new WeakMap();
const integrationSessionScope = new AsyncLocalStorage();
const integrationOperationScope = new AsyncLocalStorage();
const activeSessionLeases = new Map();

function fail(code, message) {
  throw makeError(code, message);
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.publicCode = code;
  error.status = 503;
  error.statusCode = 503;
  return error;
}

function handledRejection(code, message) {
  const promise = Promise.reject(makeError(code, message));
  promise.catch(() => {});
  return promise;
}

function assertNativeSessionId(value) {
  const id = String(value || "");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(id) ||
    id.includes("..") ||
    id.startsWith("aginti-evidence-v1:")
  ) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration native session id is invalid.");
  }
  return id;
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) freezeDeep(value[key]);
  return Object.freeze(value);
}

function canonicalCloneStrict(value, label = "value", seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} must contain only finite JSON numbers.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} must contain only strict JSON data.`);
  }
  if (utilTypes.isProxy(value)) fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} must not be a Proxy.`);
  if (seen.has(value)) fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} must not contain cycles.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} array prototype is invalid.`);
      }
      const keys = Reflect.ownKeys(value);
      const indexKeys = keys.filter((key) => key !== "length");
      if (indexKeys.some((key) => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
        fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} array must not contain symbols or named fields.`);
      }
      if (indexKeys.length !== value.length) {
        fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} array must be dense.`);
      }
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          !descriptor ||
          descriptor.enumerable !== true ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label}[${index}] must be an enumerable data field.`);
        }
        clone[index] = canonicalCloneStrict(descriptor.value, `${label}[${index}]`, seen);
      }
      return freezeDeep(clone);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} prototype is invalid.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} must not contain symbols.`);
    }
    if (Object.prototype.hasOwnProperty.call(value, "toJSON")) {
      fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} must not define toJSON.`);
    }
    const clone = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label}.${key} must be an enumerable data field.`);
      }
      clone[key] = canonicalCloneStrict(descriptor.value, `${label}.${key}`, seen);
    }
    return freezeDeep(clone);
  } finally {
    seen.delete(value);
  }
}

function mutableCloneOfValidatedData(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const clone = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      clone[index] = mutableCloneOfValidatedData(value[index]);
    }
    return clone;
  }
  const clone = {};
  for (const key of Reflect.ownKeys(value)) {
    clone[key] = mutableCloneOfValidatedData(value[key]);
  }
  return clone;
}

function assertFrozenRegisteredConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) || !Object.isFrozen(config)) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration fixed config must be the exact frozen registered object.");
  }
  const registration = registrations.get(config);
  if (!registration) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration fixed config was not registered by AgInTi.");
  }
  return registration;
}

export function assertRegisteredIntegrationSessionConfig(config) {
  assertFrozenRegisteredConfig(config);
}

function assertRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} revision is invalid.`);
  }
  return value;
}

function exactPath(value, label) {
  const resolved = path.resolve(String(value || ""));
  if (!resolved || resolved !== value) fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} path is invalid.`);
  return resolved;
}

function runtimeDigest(snapshot) {
  return contractDigest(canonicalCloneStrict(snapshot, "runtime snapshot"));
}

function sessionLeaseKey(registration) {
  return `${registration.sessionsDir}\n${registration.nativeSessionId}`;
}

function currentLeaseMatches(scope) {
  return Boolean(scope?.active && activeSessionLeases.get(scope.leaseKey) === scope.leaseToken);
}

function currentOperationAdmits(scope) {
  const operation = integrationOperationScope.getStore();
  return Boolean(operation?.scope === scope && operation.active === true);
}

function retainedWorkspaceFor(registration) {
  return registration?.retainedVisionWorkspace || registration?.retainedTextWorkspace || null;
}

function partialIntegrationMarkers(config = {}) {
  if (!config || typeof config !== "object") return false;
  return Boolean(
    config.integrationPolicyLock !== undefined ||
      config.integrationPolicyFingerprint !== undefined ||
      config.integrationRuntimeRootsDigest !== undefined ||
      config.expectedIntegrationRuntimeRevision !== undefined
  );
}

export function registerIntegrationSessionConfig(config, registration = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config) || !Object.isFrozen(config)) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration fixed config must be frozen before registration.");
  }
  if (registrations.has(config)) fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration fixed config was already registered.");
  const mode = String(registration.mode || "");
  if (mode !== "start" && mode !== "resume") fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration execution mode is invalid.");
  const expectedBeforeRevision = assertRevision(registration.expectedBeforeRevision, "expected before");
  const expectedAfterRevision = assertRevision(registration.expectedAfterRevision, "expected after");
  if (mode === "start" && (expectedBeforeRevision !== 0 || expectedAfterRevision !== 1)) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Start must bind absent state to revision 1.");
  }
  if (mode === "resume" && expectedAfterRevision !== expectedBeforeRevision + 1) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Resume must bind N to N+1.");
  }
  const retainedNativeExecutionEvidence = registration.retainedNativeExecutionEvidence === undefined
    ? null
    : assertRetainedIntegrationNativeExecutionEvidence(registration.retainedNativeExecutionEvidence);
  const retainedTextWorkspace = registration.retainedTextWorkspace === undefined
    ? null
    : assertRetainedIntegrationTextWorkspace(registration.retainedTextWorkspace, {
        nativeExecutionEvidence: retainedNativeExecutionEvidence,
      });
  const retainedVisionWorkspace = registration.retainedVisionWorkspace === undefined
    ? null
    : assertRetainedIntegrationVisionWorkspace(registration.retainedVisionWorkspace, {
        textWorkspace: retainedTextWorkspace,
        sessionStateStore: undefined,
        nativeExecutionEvidence: retainedNativeExecutionEvidence,
      });
  if (retainedVisionWorkspace && !retainedTextWorkspace) {
    fail(
      "INTEGRATION_SESSION_SCOPE_INVALID",
      "The retained vision-workspace profile requires its exact retained text-workspace base."
    );
  }
  if ((retainedTextWorkspace || retainedVisionWorkspace) && !retainedNativeExecutionEvidence) {
    fail(
      "INTEGRATION_SESSION_SCOPE_INVALID",
      "The retained text-workspace profile and native execution evidence must be supplied together."
    );
  }
  const retainedExecutionState = retainedNativeExecutionEvidence
    ? { preflightSnapshot: null, profilePreflight: null, binding: null }
    : null;
  const normalized = Object.freeze({
    schemaVersion: "aginti-integration-session-persistence-v1",
    config,
    nativeSessionId: assertNativeSessionId(registration.nativeSessionId),
    mode,
    policyLock: String(registration.policyLock || ""),
    policyFingerprint: String(registration.policyFingerprint || ""),
    runtimeRootsDigest: String(registration.runtimeRootsDigest || ""),
    sessionsDir: exactPath(registration.sessionsDir, "sessionsDir"),
    baseDir: exactPath(registration.baseDir, "baseDir"),
    commandCwd: exactPath(registration.commandCwd, "commandCwd"),
    expectedBeforeRevision,
    expectedAfterRevision,
    expectedBeforeRuntimeDigest: String(registration.expectedBeforeRuntimeDigest || ""),
    expectedAfterRuntimeDigest: String(registration.expectedAfterRuntimeDigest || ""),
    principalId: String(registration.principalId || ""),
    browserSessionId: String(registration.browserSessionId || ""),
    threadId: String(registration.threadId || ""),
    runId: String(registration.runId || ""),
    retainedNativeExecutionEvidence,
    retainedTextWorkspace,
    retainedVisionWorkspace,
    retainedExecutionState,
  });
  if (
    !normalized.nativeSessionId ||
    !normalized.policyLock ||
    !/^[a-f0-9]{64}$/u.test(normalized.policyFingerprint) ||
    !/^[a-f0-9]{64}$/u.test(normalized.runtimeRootsDigest) ||
    !/^(?:0{64}|[a-f0-9]{64})$/u.test(normalized.expectedBeforeRuntimeDigest) ||
    !/^[a-f0-9]{64}$/u.test(normalized.expectedAfterRuntimeDigest) ||
    ((retainedTextWorkspace || retainedVisionWorkspace) && (
      !/^[A-Za-z0-9._~-]{16,128}$/u.test(normalized.principalId) ||
      !/^[a-f0-9]{64}$/u.test(normalized.browserSessionId) ||
      !normalized.threadId ||
      !normalized.runId
    ))
  ) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration session registration is incomplete.");
  }
  registrations.set(config, normalized);
  return config;
}

export function runWithIntegrationSessionScope(config, operation) {
  const registration = assertFrozenRegisteredConfig(config);
  if (typeof operation !== "function") fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration session operation is invalid.");
  if (
    registration.retainedNativeExecutionEvidence &&
    !registration.retainedExecutionState?.binding
  ) {
    fail(
      "INTEGRATION_SESSION_SCOPE_INVALID",
      "Retained native execution must be bound to a durable authorization before runAgent starts."
    );
  }
  const leaseKey = sessionLeaseKey(registration);
  if (activeSessionLeases.has(leaseKey)) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration native session already has an active scoped run.");
  }
  const leaseToken = Symbol("integration-session-lease");
  const scope = {
    schemaVersion: registration.schemaVersion,
    registration,
    active: true,
    acceptingOperations: true,
    claimed: false,
    claimCount: 0,
    runAgentEntered: false,
    runAgentEntryCount: 0,
    persisted: false,
    persistedRevision: 0,
    leaseKey,
    leaseToken,
    operations: new Set(),
    operationErrors: [],
  };
  activeSessionLeases.set(leaseKey, leaseToken);
  const execute = async () => {
    let result;
    let primaryError = null;
    try {
      try {
        result = await operation();
      } catch (error) {
        primaryError = error;
      }
      scope.acceptingOperations = false;
      while (scope.operations.size > 0) {
        await Promise.allSettled([...scope.operations]);
      }
      if (primaryError) throw primaryError;
      if (scope.operationErrors.length > 0) throw scope.operationErrors[0];
      if (scope.claimCount !== 1) {
        fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration run must claim exactly one native SessionStore.");
      }
      if (retainedWorkspaceFor(registration) && (scope.runAgentEntered !== true || scope.runAgentEntryCount !== 1)) {
        fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration scope must enter lexical runAgent exactly once.");
      }
      if (scope.persisted !== true || scope.persistedRevision !== registration.expectedAfterRevision) {
        fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration run did not persist the expected native session revision.");
      }
      return result;
    } finally {
      scope.acceptingOperations = false;
      scope.active = false;
      if (activeSessionLeases.get(leaseKey) === leaseToken) activeSessionLeases.delete(leaseKey);
    }
  };
  return integrationSessionScope.run(scope, execute);
}

export function runIntegrationSessionOperation(claim, label, operation) {
  if (typeof operation !== "function") {
    return handledRejection("INTEGRATION_SESSION_SCOPE_INVALID", `${label} operation is invalid.`);
  }
  const ambientScope = integrationSessionScope.getStore();
  if (!claim) {
    if (ambientScope) {
      return handledRejection(
        "INTEGRATION_SESSION_SCOPE_INVALID",
        `${label} attempted to use an unclaimed SessionStore inside an integration scope.`
      );
    }
    return operation();
  }
  const { scope } = claim;
  if (!currentLeaseMatches(scope)) {
    return handledRejection("INTEGRATION_SESSION_SCOPE_INVALID", `${label} attempted to use a closed integration SessionStore.`);
  }
  if (scope.acceptingOperations !== true && !currentOperationAdmits(scope)) {
    return handledRejection(
      "INTEGRATION_SESSION_SCOPE_INVALID",
      `${label} attempted to start after the integration scope closed admission.`
    );
  }
  const token = { scope, label: String(label || "SessionStore operation"), active: true };
  let tracked;
  let raw;
  try {
    raw = integrationOperationScope.run(token, () => {
      try {
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    });
  } catch (error) {
    raw = Promise.reject(error);
  }
  raw.catch(() => {});
  tracked = raw
    .then(
      () => {},
      (error) => {
      scope.operationErrors.push(error);
      }
    )
    .finally(() => {
      token.active = false;
      scope.operations.delete(tracked);
    });
  scope.operations.add(tracked);
  tracked.catch(() => {});
  const returned = raw.finally(() => tracked.catch(() => {}));
  returned.catch(() => {});
  return returned;
}

export function assertIntegrationSessionOperationAllowed(claim, label) {
  const ambientScope = integrationSessionScope.getStore();
  if (!claim) {
    if (ambientScope) {
      fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} attempted to use an unclaimed SessionStore inside an integration scope.`);
    }
    return;
  }
  const { scope } = claim;
  if (!currentLeaseMatches(scope)) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} attempted to use a closed integration SessionStore.`);
  }
  if (scope.acceptingOperations !== true && !currentOperationAdmits(scope)) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", `${label} attempted to start after the integration scope closed admission.`);
  }
}

export function claimIntegrationSessionStore(store = {}) {
  const scope = integrationSessionScope.getStore();
  if (!scope) return null;
  const registration = scope.registration;
  if (!currentLeaseMatches(scope)) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration SessionStore claim escaped its active run scope.");
  }
  if (scope.claimed) fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration execution attempted to claim more than one SessionStore.");
  if (
    store.sessionId !== registration.nativeSessionId ||
    store.baseDir !== registration.sessionsDir ||
    store.sessionDir !== path.join(registration.sessionsDir, registration.nativeSessionId) ||
    (store.projectRoot || "") !== registration.baseDir ||
    (store.commandCwd || "") !== registration.commandCwd
  ) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "SessionStore does not match the registered integration scope.");
  }
  scope.claimed = true;
  scope.claimCount += 1;
  return Object.freeze({ scope, registration });
}

export async function loadIntegrationSessionSnapshotForConfig(config, fallbackLoader) {
  const registration = assertFrozenRegisteredConfig(config);
  if (!registration.retainedNativeExecutionEvidence) {
    if (typeof fallbackLoader !== "function") {
      fail("INTEGRATION_SESSION_SCOPE_INVALID", "Native session fallback loader is unavailable.");
    }
    return Object.freeze({ retained: false, state: await fallbackLoader(), snapshot: null });
  }
  if (registration.retainedExecutionState.binding) {
    const retainedWorkspace = retainedWorkspaceFor(registration);
    const state = retainedWorkspace
      ? await retainedWorkspace.invoke(
          registration.retainedExecutionState.binding,
          "loadState"
        )
      : await registration.retainedNativeExecutionEvidence.loadNativeState(
          registration.retainedExecutionState.binding
        );
    const snapshot = await registration.retainedNativeExecutionEvidence.loadNativeSessionSnapshot(
      registration.nativeSessionId
    );
    return Object.freeze({ retained: true, state, snapshot });
  }
  const retainedWorkspace = retainedWorkspaceFor(registration);
  if (retainedWorkspace) {
    const prepared = await retainedWorkspace.prepareExecution({
      mode: registration.mode,
      principalId: registration.principalId,
      browserSessionId: registration.browserSessionId,
      threadId: registration.threadId,
      runId: registration.runId,
      nativeSessionId: registration.nativeSessionId,
    });
    registration.retainedExecutionState.profilePreflight = prepared.handle;
    registration.retainedExecutionState.preflightSnapshot = prepared.nativeSnapshot;
    return Object.freeze({ retained: true, state: prepared.nativeState, snapshot: prepared.nativeSnapshot });
  }
  const snapshot = await registration.retainedNativeExecutionEvidence.loadNativeSessionSnapshot(registration.nativeSessionId);
  registration.retainedExecutionState.preflightSnapshot = snapshot;
  return Object.freeze({ retained: true, state: snapshot.state, snapshot });
}

export async function bindIntegrationNativeExecution(config, input = {}) {
  const registration = assertFrozenRegisteredConfig(config);
  if (!registration.retainedNativeExecutionEvidence) return null;
  if (!registration.retainedExecutionState.preflightSnapshot) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Retained native execution has no read-only preflight proof.");
  }
  if (registration.retainedExecutionState.binding) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Retained native execution was already bound.");
  }
  const retainedWorkspace = retainedWorkspaceFor(registration);
  const binding = retainedWorkspace
    ? await retainedWorkspace.bindAuthorizedExecution({
        authorization: input.authorization,
        snapshotHash: input.snapshotHash,
        preflight: registration.retainedExecutionState.profilePreflight,
      })
    : await registration.retainedNativeExecutionEvidence.bindAuthorizedExecution({
        authorization: input.authorization,
        snapshotHash: input.snapshotHash,
        preflightSnapshot: registration.retainedExecutionState.preflightSnapshot,
      });
  registration.retainedExecutionState.binding = binding;
  return binding;
}

export async function loadIntegrationClaimedSessionState(claim, fallbackLoader) {
  if (!claim?.registration?.retainedNativeExecutionEvidence) {
    return typeof fallbackLoader === "function" ? fallbackLoader() : null;
  }
  const binding = claim.registration.retainedExecutionState?.binding;
  if (!binding) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Retained native SessionStore load lacks an authorization binding.");
  }
  const retainedWorkspace = retainedWorkspaceFor(claim.registration);
  return retainedWorkspace
    ? retainedWorkspace.invoke(binding, "loadState")
    : claim.registration.retainedNativeExecutionEvidence.loadNativeState(binding);
}

export async function saveIntegrationClaimedSessionState(claim, state) {
  if (!claim?.registration?.retainedNativeExecutionEvidence) return false;
  const binding = claim.registration.retainedExecutionState?.binding;
  if (!binding) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Retained native SessionStore save lacks an authorization binding.");
  }
  const retainedWorkspace = retainedWorkspaceFor(claim.registration);
  if (retainedWorkspace) {
    await retainedWorkspace.invoke(binding, "saveState", [state]);
  } else {
    await claim.registration.retainedNativeExecutionEvidence.saveNativeState(binding, state);
  }
  return true;
}

export function retainedIntegrationSessionStateEnabled(claim) {
  return Boolean(claim?.registration?.retainedNativeExecutionEvidence);
}

export function retainedIntegrationTextWorkspaceEnabled(claim) {
  return Boolean(retainedWorkspaceFor(claim?.registration));
}

export function invokeIntegrationTextWorkspace(claim, operation, args = []) {
  const profile = retainedWorkspaceFor(claim?.registration);
  if (!profile) return null;
  const binding = claim.registration.retainedExecutionState?.binding;
  if (!binding) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", `${operation} lacks a retained text-workspace authorization binding.`);
  }
  return profile.invoke(binding, operation, args);
}

export function invokeIntegrationVisionWorkspace(config, args = {}) {
  const scope = integrationSessionScope.getStore();
  const registration = scope?.registration || null;
  if (
    !registration || !registration.retainedVisionWorkspace || scope.registration !== registration ||
    !currentLeaseMatches(scope) || scope.runAgentEntered !== true
  ) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Retained read_image escaped its exact vision-workspace run scope.");
  }
  if (
    config !== registration.config
  ) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Retained read_image runtime profile binding changed.");
  }
  const binding = registration.retainedExecutionState?.binding;
  if (!binding) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Retained read_image lacks an authorization binding.");
  }
  const runtime = {
    abortSignal: registration.config.abortSignal,
    ...(registration.config.providerReadinessTimeoutMs === undefined
      ? {}
      : { providerReadinessTimeoutMs: registration.config.providerReadinessTimeoutMs }),
    ...(registration.config.modelTimeoutMs === undefined
      ? {}
      : { modelTimeoutMs: registration.config.modelTimeoutMs }),
  };
  return registration.retainedVisionWorkspace.invokeReadImage(binding, args, Object.freeze(runtime));
}

export async function recordIntegrationNativeTerminalEvidence(config, terminal) {
  const registration = assertFrozenRegisteredConfig(config);
  if (!registration.retainedNativeExecutionEvidence) return null;
  const binding = registration.retainedExecutionState?.binding;
  if (!binding) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Retained native terminal evidence lacks an authorization binding.");
  }
  const retainedWorkspace = retainedWorkspaceFor(registration);
  return retainedWorkspace
    ? retainedWorkspace.recordTerminalEvidence(binding, terminal)
    : registration.retainedNativeExecutionEvidence.recordTerminalEvidence(binding, terminal);
}

export function assertIntegrationRunAgentInvocation(config = {}) {
  const registered = config && typeof config === "object" ? registrations.get(config) : null;
  if (!registered) {
    if (partialIntegrationMarkers(config)) {
      fail("INTEGRATION_SESSION_SCOPE_INVALID", "Marked integration runAgent config was not registered by AgInTi.");
    }
    return;
  }
  const scope = integrationSessionScope.getStore();
  if (!scope || scope.registration !== registered || scope.registration.config !== config || !currentLeaseMatches(scope)) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Registered integration runAgent config escaped its active AgInTi scope.");
  }
  scope.runAgentEntered = true;
  scope.runAgentEntryCount += 1;
  if (scope.runAgentEntryCount !== 1) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Registered integration runAgent config was entered more than once.");
  }
}

function assertSessionTopIdentity(state = {}, registration, label) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", `${label} session state must be an object.`);
  }
  if (state.sessionId !== registration.nativeSessionId) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", `${label} sessionId diverged from the mapped native session.`);
  }
  if (state.baseDir !== registration.baseDir) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", `${label} baseDir diverged from the repository root.`);
  }
  if (state.commandCwd !== registration.commandCwd) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", `${label} commandCwd diverged from the command workspace.`);
  }
}

function assertIntegrationMarkers(state = {}, registration, label) {
  const meta = state.meta || {};
  if (
    meta.integrationPolicyLock !== registration.policyLock ||
    meta.integrationPolicyFingerprint !== registration.policyFingerprint ||
    meta.integrationRuntimeRootsDigest !== registration.runtimeRootsDigest
  ) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", `${label} integration persistence markers diverged.`);
  }
}

function assertRuntimeSnapshot(state = {}, expectedRevision, expectedDigest, label) {
  const snapshot = state.meta?.runtimeConfig;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", `${label} runtime snapshot is unavailable.`);
  }
  if (snapshot.revision !== expectedRevision) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", `${label} runtime revision diverged.`);
  }
  if (runtimeDigest(snapshot) !== expectedDigest) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", `${label} runtime snapshot diverged from the fixed profile.`);
  }
  return snapshot;
}

export function validateIntegrationLoadedState(claim, state) {
  if (!claim) return state;
  const { scope, registration } = claim;
  if (state === null) {
    if (registration.mode === "start" && scope.persisted !== true) return null;
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", "Resume requires an existing integration session state.");
  }
  const clone = canonicalCloneStrict(state, "loaded session state");
  if (registration.mode === "start" && scope.persisted !== true) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", "Start requires pristine absent native session state.");
  }
  assertSessionTopIdentity(clone, registration, "loaded session state");
  assertIntegrationMarkers(clone, registration, "loaded session state");
  assertRuntimeSnapshot(
    clone,
    scope.persisted === true ? registration.expectedAfterRevision : registration.expectedBeforeRevision,
    scope.persisted === true ? registration.expectedAfterRuntimeDigest : registration.expectedBeforeRuntimeDigest,
    "loaded session state"
  );
  return mutableCloneOfValidatedData(clone);
}

export function prepareIntegrationStateForSave(claim, state) {
  if (!claim) return state;
  const { scope, registration } = claim;
  if (!currentLeaseMatches(scope)) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration session persistence escaped its active run scope.");
  }
  const clone = canonicalCloneStrict(state, "saved session state");
  if (!clone.meta || typeof clone.meta !== "object" || Array.isArray(clone.meta)) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", "Saved session state meta is unavailable.");
  }
  if (
    (clone.meta.integrationPolicyLock !== undefined && clone.meta.integrationPolicyLock !== registration.policyLock) ||
    (clone.meta.integrationPolicyFingerprint !== undefined &&
      clone.meta.integrationPolicyFingerprint !== registration.policyFingerprint) ||
    (clone.meta.integrationRuntimeRootsDigest !== undefined &&
      clone.meta.integrationRuntimeRootsDigest !== registration.runtimeRootsDigest)
  ) {
    fail("SESSION_RUNTIME_TAKEOVER_BLOCKED", "Saved session integration markers diverged.");
  }
  const durable = freezeDeep({
    ...clone,
    meta: {
      ...clone.meta,
      integrationPolicyLock: registration.policyLock,
      integrationPolicyFingerprint: registration.policyFingerprint,
      integrationRuntimeRootsDigest: registration.runtimeRootsDigest,
    },
  });
  assertSessionTopIdentity(durable, registration, "saved session state");
  assertRuntimeSnapshot(
    durable,
    registration.expectedAfterRevision,
    registration.expectedAfterRuntimeDigest,
    "saved session state"
  );
  return durable;
}

export function markIntegrationStatePersisted(claim, state) {
  if (!claim) return;
  const { scope, registration } = claim;
  if (!currentLeaseMatches(scope)) {
    fail("INTEGRATION_SESSION_SCOPE_INVALID", "Integration persisted marker escaped its active run scope.");
  }
  const clone = canonicalCloneStrict(state, "persisted session state");
  assertSessionTopIdentity(clone, registration, "persisted session state");
  assertIntegrationMarkers(clone, registration, "persisted session state");
  assertRuntimeSnapshot(
    clone,
    registration.expectedAfterRevision,
    registration.expectedAfterRuntimeDigest,
    "persisted session state"
  );
  scope.persistedRevision = registration.expectedAfterRevision;
  scope.persisted = true;
}

export function integrationPersistedRevisionForConfig(config) {
  assertFrozenRegisteredConfig(config);
  const scope = integrationSessionScope.getStore();
  if (scope?.registration?.config === config && scope.persisted) return scope.persistedRevision;
  return 0;
}
