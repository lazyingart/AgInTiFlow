import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  assertFixedIntegrationPolicy,
  buildFixedIntegrationRuntimeOverrides,
  contractDigest,
  integrationBoundedText,
  integrationExactKeys,
} from "./integration-policy.js";
import { validateIntegrationEventPayload } from "./integration-events.js";
import { authorityFail } from "./integration-durable-common.js";
import { redactSensitiveText } from "./redaction.js";
import { SessionStore } from "./session-store.js";
import { SESSION_RUNTIME_FIELDS, captureSessionRuntime } from "./session-runtime.js";
import { runAgent } from "./agent-runner.js";
import {
  assertRegisteredIntegrationSessionConfig,
  registerIntegrationSessionConfig,
  runWithIntegrationSessionScope,
} from "./integration-session-persistence.js";

export const NATIVE_INTEGRATION_EXECUTOR_PROOF_VERSION = "aginti-native-run-agent-executor-v1";
export const NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION = "aginti-native-runtime-roots-v1";

const ZERO_DIGEST = "0".repeat(64);
const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s("'`<>\[{=])(?:file:\/\/\/[^\s"'`<>)\]}]+|\/(?!\/)[^\s"'`<>)\]}]+|[A-Za-z]:[\\/][^\s"'`<>)\]}]+|\\\\[^\\/\s"'`<>)\]}]+\\[^\s"'`<>)\]}]+)/giu;
const PUBLIC_FAILURE_CODES = new Set([
  "AGINTI_RUNTIME_ERROR",
  "CANCELLED",
  "PROVIDER_PREFLIGHT_FAILED",
  "MODEL_TIMEOUT",
  "MAX_STEPS",
  "SESSION_RUNTIME_TAKEOVER_BLOCKED",
]);
const DANGEROUS_ROOTS = new Set([
  "/",
  "/home",
  "/Users",
  "/mnt",
  "/media",
  "/Volumes",
  "/etc",
  "/root",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/var",
  "/usr",
  "/opt",
  "/srv",
  "/tmp",
]);
const REQUIRED_DISABLED_FLAGS = Object.freeze([
  "allowWrapperTools",
  "allowAuxiliaryTools",
  "allowWebSearch",
  "allowMcpTools",
  "allowParallelScouts",
  "allowHostedImagePerception",
  "allowHostedWebResearch",
  "allowHostedJsonSpecialist",
  "allowHostedWritingSpecialist",
  "allowAgentLinkTools",
  "allowCoordinationTools",
  "allowBrowserTools",
  "allowCanvasTools",
  "allowPasswords",
  "allowDestructive",
  "allowOutsideWorkspaceFileTools",
]);

function fail(message) {
  authorityFail("AGENT_UNAVAILABLE", message);
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) freezeDeep(value[key]);
  return Object.freeze(value);
}

function sealAttestation(value) {
  const unsigned = { ...value };
  return freezeDeep({ ...unsigned, digest: contractDigest(unsigned) });
}

export const NATIVE_INTEGRATION_EXECUTOR_PROOF = sealAttestation({
  schemaVersion: NATIVE_INTEGRATION_EXECUTOR_PROOF_VERSION,
  owner: "aginti",
  authority: "aginti",
  executor: "lexical-imported-runAgent",
  actualFixedProfileExecution: true,
  cancellation: true,
  resultClassification: true,
  noHostedProviders: true,
  noWrappers: true,
  noMcp: true,
  noWeb: true,
  planEvents: false,
  artifactEvents: false,
});

function isIntegrationMarkedConfig(config = {}) {
  return Boolean(config.integrationPolicyLock || config.integrationPolicyFingerprint);
}

function thenableReject(value, label) {
  if (value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") {
    if (typeof value.catch === "function") value.catch(() => {});
    fail(`${label} must be synchronous plain data.`);
  }
}

function deepCloneFreeze(value, label, seen = new Map()) {
  thenableReject(value, label);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof AbortSignal) return value;
  if (typeof value === "function") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const array = value.map((item, index) => deepCloneFreeze(item, `${label}[${index}]`, seen));
    return Object.freeze(array);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be plain JSON-compatible data.`);
  const clone = {};
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(`${label} contains unsupported symbol fields.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      fail(`${label}.${key} must be an enumerable data field.`);
    }
    clone[key] = deepCloneFreeze(descriptor.value, `${label}.${key}`, seen);
  }
  return Object.freeze(clone);
}

function redactPublicText(value) {
  return redactSensitiveText(String(value || "")).replace(ABSOLUTE_PATH_PATTERN, (match) => {
    const prefix = /^[\s("'`]/u.test(match) ? match[0] : "";
    return `${prefix}[REDACTED_PATH]`;
  });
}

function canonicalDigest(value) {
  return contractDigest(value);
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(`${label} digest is invalid.`);
  return value;
}

function assertNativeSessionId(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value) ||
    value.includes("..")
  ) {
    fail("Native AgInTi session id is invalid.");
  }
  return value;
}

function assertSafeRootPath(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is unavailable.`);
  const resolved = path.resolve(value);
  if (resolved !== value) fail(`${label} must be an exact absolute path.`);
  if (DANGEROUS_ROOTS.has(resolved)) fail(`${label} must not be a host root or system directory.`);
  if (/^\/home\/[^/]+$/u.test(resolved) || /^\/Users\/[^/]+$/u.test(resolved) || /^\/Volumes\/[^/]+$/u.test(resolved)) {
    fail(`${label} must not be a shallow user or volume root.`);
  }
  if (resolved.includes("/../") || resolved.endsWith("/..")) fail(`${label} must not contain parent traversal.`);
  return resolved;
}

function pathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsDisjoint(left, right) {
  return !pathInside(left, right) && !pathInside(right, left);
}

export function validateNativeRuntimeRootsAttestation(value = {}) {
  if (value && typeof value === "object" && utilTypes.isProxy(value)) {
    fail("Native runtime roots attestation must not be a Proxy.");
  }
  thenableReject(value, "native runtime roots attestation");
  if (!Object.isFrozen(value)) fail("Native runtime roots attestation must be frozen.");
  const roots = integrationExactKeys(
    value,
    [
      "schemaVersion",
      "sessionsDir",
      "baseDir",
      "commandCwd",
      "retainedDescriptor",
      "symlinkFree",
      "outsideForbiddenRoots",
      "digest",
    ],
    "native runtime roots attestation",
    [
      "schemaVersion",
      "sessionsDir",
      "baseDir",
      "commandCwd",
      "retainedDescriptor",
      "symlinkFree",
      "outsideForbiddenRoots",
      "digest",
    ]
  );
  for (const key of Object.keys(roots)) thenableReject(roots[key], `native runtime roots attestation.${key}`);
  const unsigned = { ...roots };
  delete unsigned.digest;
  if (
    roots.schemaVersion !== NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION ||
    roots.retainedDescriptor !== true ||
    roots.symlinkFree !== true ||
    roots.outsideForbiddenRoots !== true ||
    roots.digest !== canonicalDigest(unsigned)
  ) {
    fail("Native runtime roots attestation is unavailable.");
  }
  const sessionsDir = assertSafeRootPath(roots.sessionsDir, "sessionsDir");
  const baseDir = assertSafeRootPath(roots.baseDir, "baseDir");
  const commandCwd = assertSafeRootPath(roots.commandCwd, "commandCwd");
  if (!pathInside(commandCwd, baseDir)) {
    fail("Native runtime command workspace must be bound under the repository-attested workspace root.");
  }
  if (!pathsDisjoint(sessionsDir, commandCwd) || !pathsDisjoint(sessionsDir, baseDir)) {
    fail("Native session state root must be disjoint from the command/tool workspace.");
  }
  return Object.freeze({ sessionsDir, baseDir, commandCwd, digest: roots.digest });
}

function assertNoEscapeFlags(config) {
  for (const field of ["provider", "routeProvider", "mainProvider", "spareProvider"]) {
    if (config[field] !== "localllm") fail(`Fixed runtime config must bind ${field}=localllm.`);
  }
  for (const field of REQUIRED_DISABLED_FLAGS) {
    if (config[field] !== false) fail(`Fixed runtime config must disable ${field}.`);
  }
  if (config.packageInstallPolicy !== "block" || config.dockerNetwork !== "none") {
    fail("Fixed runtime config must block package installs and Docker networking.");
  }
  if (Array.isArray(config.allowedDomains) && config.allowedDomains.length !== 0) {
    fail("Fixed runtime config must not allow network domains.");
  }
  if (Array.isArray(config.readOnlyRoots) && config.readOnlyRoots.length !== 0) {
    fail("Fixed runtime config must not allow host read roots.");
  }
  if (Array.isArray(config.readOnlyHostMounts) && config.readOnlyHostMounts.length !== 0) {
    fail("Fixed runtime config must not allow host mounts.");
  }
}

export function buildFixedNativeRunAgentConfig(input = {}) {
  thenableReject(input, "native executor config input");
  const policy = assertFixedIntegrationPolicy(input.policy);
  const nativeSessionId = assertNativeSessionId(input.nativeSessionId);
  thenableReject(input.repositoryRoots, "native executor repository roots");
  const roots = validateNativeRuntimeRootsAttestation(input.repositoryRoots);
  const inputText = integrationBoundedText(input.inputText || "", "run input", 64_000);
  if (input.mode !== "start" && input.mode !== "resume") fail("Native executor mode is invalid.");
  if (!input.abortSignal || !(input.abortSignal instanceof AbortSignal)) fail("Native executor requires an AbortSignal.");
  if (typeof input.onEvent !== "function") fail("Native executor requires an observer callback.");
  const expectedRevision = Number(input.expectedRuntimeRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    fail("Native executor requires an explicit expected runtime revision.");
  }
  if (input.mode === "start" && expectedRevision !== 1) fail("Start requires native runtime revision 1.");
  const fixed = {
    ...buildFixedIntegrationRuntimeOverrides(policy, { sessionId: nativeSessionId }),
    goal: inputText,
    abortSignal: input.abortSignal,
    onEvent: input.onEvent,
    sessionsDir: roots.sessionsDir,
    baseDir: roots.baseDir,
    commandCwd: roots.commandCwd,
    expectedIntegrationRuntimeRevision: expectedRevision,
    integrationRuntimeRootsDigest: roots.digest,
    ...(input.mode === "resume" ? { resume: nativeSessionId } : {}),
  };
  if (input.mode === "resume") {
    const targetSnapshot = expectedFixedSessionRuntimeSnapshot(fixed, expectedRevision + 1);
    fixed.expectedRuntimeRevision = expectedRevision;
    fixed.runtimePatch = exhaustiveRuntimePatchFromSnapshot(targetSnapshot);
  }
  const expectedKeys = [
    ...Object.keys(buildFixedIntegrationRuntimeOverrides(policy, { sessionId: nativeSessionId })),
    "goal",
    "abortSignal",
    "onEvent",
    "sessionsDir",
    "baseDir",
    "commandCwd",
    "expectedIntegrationRuntimeRevision",
    "integrationRuntimeRootsDigest",
    ...(input.mode === "resume" ? ["resume"] : []),
    ...(input.mode === "resume" ? ["expectedRuntimeRevision", "runtimePatch"] : []),
  ].sort();
  const actualKeys = Reflect.ownKeys(fixed).filter((key) => typeof key === "string").sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail("Fixed runtime config contains unsupported fields.");
  }
  assertNoEscapeFlags(fixed);
  const frozen = deepCloneFreeze(fixed, "fixed native runAgent config");
  if (frozen.abortSignal !== input.abortSignal || frozen.onEvent !== input.onEvent) {
    fail("Fixed runtime config lost callback identity.");
  }
  const expectedBeforeRevision = input.mode === "resume" ? expectedRevision : 0;
  const expectedAfterRevision = input.mode === "resume" ? expectedRevision + 1 : 1;
  const expectedBeforeRuntimeDigest =
    input.mode === "resume" ? contractDigest(expectedFixedSessionRuntimeSnapshot(frozen, expectedBeforeRevision)) : ZERO_DIGEST;
  const expectedAfterRuntimeDigest = contractDigest(expectedFixedSessionRuntimeSnapshot(frozen, expectedAfterRevision));
  return registerIntegrationSessionConfig(frozen, {
    nativeSessionId,
    mode: input.mode,
    policyLock: frozen.integrationPolicyLock,
    policyFingerprint: frozen.integrationPolicyFingerprint,
    runtimeRootsDigest: roots.digest,
    sessionsDir: roots.sessionsDir,
    baseDir: roots.baseDir,
    commandCwd: roots.commandCwd,
    expectedBeforeRevision,
    expectedAfterRevision,
    expectedBeforeRuntimeDigest,
    expectedAfterRuntimeDigest,
  });
}

function canonicalClone(value, label = "value") {
  try {
    return deepCloneFreeze(JSON.parse(JSON.stringify(value)), label);
  } catch {
    fail(`${label} must be canonical JSON data.`);
  }
}

function exhaustiveRuntimePatchFromSnapshot(snapshot = {}) {
  const patch = {};
  for (const field of SESSION_RUNTIME_FIELDS) patch[field] = snapshot[field];
  return deepCloneFreeze(patch, "fixed runtime patch");
}

export function expectedFixedSessionRuntimeSnapshot(config = {}, revision = 1) {
  return deepCloneFreeze(captureSessionRuntime(config, { revision }), "fixed session runtime snapshot");
}

function assertRuntimeSnapshotEquals(actual, expected, label) {
  const actualClone = canonicalClone(actual, label);
  if (contractDigest(actualClone) !== contractDigest(expected)) {
    authorityFail("SESSION_RUNTIME_TAKEOVER_BLOCKED", `${label} diverged from the fixed integration profile.`, {
      status: 503,
    });
  }
  return actualClone;
}

function assertPolicyBinding(state = {}, config = {}, label = "session state") {
  const meta = state.meta || {};
  const runtime = meta.runtimeConfig || {};
  const lock = meta.integrationPolicyLock || runtime.integrationPolicyLock || "";
  const fingerprint = meta.integrationPolicyFingerprint || runtime.integrationPolicyFingerprint || "";
  const rootsDigest = meta.integrationRuntimeRootsDigest || runtime.integrationRuntimeRootsDigest || "";
  if (lock && lock !== config.integrationPolicyLock) fail(`${label} integration policy lock diverged.`);
  if (fingerprint && fingerprint !== config.integrationPolicyFingerprint) fail(`${label} integration policy fingerprint diverged.`);
  if (rootsDigest && rootsDigest !== config.integrationRuntimeRootsDigest) {
    fail(`${label} integration runtime roots diverged.`);
  }
  if (!lock || !fingerprint || !rootsDigest) {
    authorityFail("SESSION_RUNTIME_TAKEOVER_BLOCKED", `${label} does not contain the fixed integration policy binding.`, {
      status: 503,
    });
  }
}

async function readNativeSessionState(config = {}) {
  const store = new SessionStore(config.sessionsDir, config.sessionId, {
    projectRoot: config.baseDir,
    commandCwd: config.commandCwd,
  });
  return store.loadState();
}

export async function preflightNativeSessionRuntime(config = {}) {
  assertRegisteredIntegrationSessionConfig(config);
  if (!isIntegrationMarkedConfig(config)) fail("Integration native execution requires a fixed marked config.");
  const expectedRevision = Number(config.expectedIntegrationRuntimeRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail("Expected integration runtime revision is invalid.");
  const state = await readNativeSessionState(config);
  if (config.resume) {
    if (!state) fail("Resume requires an existing native AgInTi session state.");
    assertPolicyBinding(state, config, "preflight session state");
    const current = canonicalClone(state.meta?.runtimeConfig, "preflight runtime snapshot");
    if (current.revision !== expectedRevision) {
      authorityFail("SESSION_RUNTIME_TAKEOVER_BLOCKED", "Stored runtime revision does not match the mapped thread.", {
        status: 503,
      });
    }
    assertRuntimeSnapshotEquals(current, expectedFixedSessionRuntimeSnapshot(config, expectedRevision), "preflight runtime snapshot");
    if (config.expectedRuntimeRevision !== expectedRevision) fail("Resume did not bind the expected runtime revision.");
    const target = expectedFixedSessionRuntimeSnapshot(config, expectedRevision + 1);
    if (contractDigest(config.runtimePatch) !== contractDigest(exhaustiveRuntimePatchFromSnapshot(target))) {
      fail("Resume runtime patch is not the exhaustive fixed integration profile.");
    }
    return Object.freeze({ skipped: false, mode: "resume", beforeRevision: current.revision, expectedAfterRevision: expectedRevision + 1 });
  }
  if (state) {
    authorityFail("SESSION_RUNTIME_TAKEOVER_BLOCKED", "Start requires pristine absent native session state.", {
      status: 503,
    });
  }
  return Object.freeze({ skipped: false, mode: "start", expectedAfterRevision: expectedRevision });
}

export async function postflightNativeSessionRuntime(config = {}, preflight = {}) {
  assertRegisteredIntegrationSessionConfig(config);
  if (!isIntegrationMarkedConfig(config) || preflight.skipped) fail("Integration native postflight requires a fixed marked config.");
  const state = await readNativeSessionState(config);
  if (!state) fail("Native AgInTi session state disappeared after execution.");
  assertPolicyBinding(state, config, "postflight session state");
  if (!Number.isSafeInteger(preflight.expectedAfterRevision) || preflight.expectedAfterRevision < 1) {
    fail("Integration native postflight expected revision is invalid.");
  }
  const expected = expectedFixedSessionRuntimeSnapshot(
    config,
    preflight.expectedAfterRevision
  );
  assertRuntimeSnapshotEquals(state.meta?.runtimeConfig, expected, "postflight runtime snapshot");
  return Object.freeze({ skipped: false, revision: expected.revision });
}

export async function executeNativeAgintiRun(config) {
  assertRegisteredIntegrationSessionConfig(config);
  const preflight = await preflightNativeSessionRuntime(config);
  let result;
  let runError = null;
  try {
    result = await runWithIntegrationSessionScope(config, () => runAgent(config));
  } catch (error) {
    if (error?.code === "INTEGRATION_SESSION_SCOPE_INVALID") throw error;
    runError = error;
  }
  const postflight = await postflightNativeSessionRuntime(config, preflight);
  if (runError) {
    runError.persistedRuntimeRevision = postflight.revision;
    throw runError;
  }
  return Object.freeze({ ...result, persistedRuntimeRevision: postflight.revision });
}

function publicResultText(result = {}) {
  const raw =
    result.result ??
    result.output ??
    result.text ??
    result.answer ??
    result.message ??
    "";
  const text = integrationBoundedText(redactPublicText(raw), "run result output", 32_000);
  return text;
}

function safeFailure(code = "AGINTI_RUNTIME_ERROR", message = "AgInTi runtime execution failed.") {
  const candidate = String(code || "AGINTI_RUNTIME_ERROR").trim().toUpperCase();
  const safeCode = PUBLIC_FAILURE_CODES.has(candidate) ? candidate : "AGINTI_RUNTIME_ERROR";
  const safeMessage = integrationBoundedText(redactPublicText(message), "run error message", 600, {
    minimum: 1,
    presentational: true,
  });
  return Object.freeze({ code: safeCode, message: safeMessage });
}

function assertPersistedRuntimeRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must carry the exact persisted native runtime revision.`);
  }
  return value;
}

export function outputEventForRunResult(classification = {}, options = {}) {
  if (classification.status !== "completed") return null;
  const text = String(classification.output || "");
  if (!text.trim()) return null;
  const event = {
    type: "output.delta",
    payload: validateIntegrationEventPayload("output.delta", { text: text.slice(0, 4_000) }),
  };
  if (options.createdAt !== undefined) {
    const createdAt = integrationBoundedText(options.createdAt, "output event createdAt", 40, { minimum: 20 });
    const parsed = Date.parse(createdAt);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== createdAt) fail("output event createdAt must be canonical UTC.");
    event.createdAt = createdAt;
  }
  return Object.freeze(event);
}

function failureReason(result = {}) {
  return String(result.reason || result.stopReason || result.error?.reason || "").trim().toLowerCase();
}

function isExplicitCancelReason(reason) {
  return reason === "user_interrupt" || reason === "cancelled" || reason === "canceled" || reason === "aborted" || reason === "abort";
}

function isFailureReason(reason) {
  return /(?:provider|model|timeout|runtime|failed|error|max_steps|incomplete|exceeded|blocked)/u.test(reason);
}

export function classifyRunAgentResult(result = {}, options = {}) {
  const nativeSessionId = assertNativeSessionId(options.nativeSessionId);
  const persistedRuntimeRevision = assertPersistedRuntimeRevision(result?.persistedRuntimeRevision, "runAgent result");
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return Object.freeze({
      status: "failed",
      output: "",
      error: safeFailure("AGINTI_RUNTIME_ERROR", "AgInTi runtime returned an invalid result."),
      persistedRuntimeRevision,
      digest: contractDigest({ invalid: true }),
    });
  }
  if (result.sessionId !== nativeSessionId) {
    authorityFail("RUN_AGENT_SESSION_MISMATCH", "runAgent result sessionId does not match the mapped native session.", {
      status: 503,
    });
  }
  const reason = failureReason(result);
  const failed =
    result.ok === false ||
    result.failed === true ||
    Boolean(result.error) ||
    result.incomplete === true ||
    reason === "model_timeout" ||
    reason === "max_steps_reached" ||
    isFailureReason(reason) ||
    (result.stopped === true && !isExplicitCancelReason(reason));
  if (failed) {
    return Object.freeze({
      status: "failed",
      output: "",
      error: safeFailure(result.code || result.error?.code || "AGINTI_RUNTIME_ERROR"),
      persistedRuntimeRevision,
      digest: contractDigest({ status: "failed", sessionId: nativeSessionId, reason, ok: result.ok === false }),
    });
  }
  if (
    options.abortSignal?.aborted ||
    result.aborted === true ||
    result.cancelled === true ||
    isExplicitCancelReason(reason)
  ) {
    return Object.freeze({
      status: "cancelled",
      output: "",
      error: safeFailure("CANCELLED", "Run cancelled."),
      persistedRuntimeRevision,
      digest: contractDigest({ status: "cancelled", sessionId: nativeSessionId, reason }),
    });
  }
  const output = publicResultText(result);
  return Object.freeze({
    status: "completed",
    output,
    error: null,
    persistedRuntimeRevision,
    digest: contractDigest({
      status: "completed",
      sessionId: nativeSessionId,
      outputDigest: output ? contractDigest(output) : ZERO_DIGEST,
    }),
  });
}

export function classifyRunAgentError(error, options = {}) {
  const persistedRuntimeRevision = assertPersistedRuntimeRevision(error?.persistedRuntimeRevision, "runAgent error");
  if (options.abortSignal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR" || error?.code === "CANCELLED") {
    return Object.freeze({
      status: "cancelled",
      output: "",
      error: safeFailure("CANCELLED", "Run cancelled."),
      persistedRuntimeRevision,
      digest: contractDigest({ status: "cancelled", error: "abort" }),
    });
  }
  return Object.freeze({
    status: "failed",
    output: "",
    error: safeFailure(error?.code || error?.publicCode || "AGINTI_RUNTIME_ERROR"),
    persistedRuntimeRevision,
    digest: contractDigest({ status: "failed", code: error?.code || "", name: error?.name || "" }),
  });
}
