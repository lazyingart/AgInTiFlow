import {
  validateIntegrationBrowserSessionBinding,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";
import { authorityFail } from "./integration-durable-common.js";
import { types as utilTypes } from "node:util";

export const INTEGRATION_RUN_REGISTRY_ATTESTATION_VERSION = "aginti-live-run-registry-v1";

const PromisePrototype = Promise.prototype;
const PromisePrototypeThen = Promise.prototype.then;
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;

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

function notFound(label) {
  authorityFail("NOT_FOUND", `${label} was not found.`, { status: 404 });
}

function assertScope(record, scope, label = "Run") {
  if (record.principalId !== scope.principalId) notFound(label);
  validateIntegrationBrowserSessionBinding(record, scope, { label, requireBound: true });
}

function normalizeClaim(claim = {}) {
  const runId = validateIntegrationRunId(claim.runId);
  const threadId = validateIntegrationThreadId(claim.threadId);
  const principalId = assertPrincipalId(claim.principalId);
  const browserSessionId = assertBrowserSessionId(claim.browserSessionId);
  const controller = claim.controller;
  if (!controller || typeof controller.abort !== "function" || !controller.signal) {
    authorityFail("AGENT_UNAVAILABLE", "Live run registry requires an AbortController.");
  }
  return Object.freeze({
    runId,
    threadId,
    principalId,
    browserSessionId,
    browserSessionPolicy: "same-browser-session",
    controller,
  });
}

export function createIntegrationRunRegistry() {
  const runs = new Map();
  const threadActiveRun = new Map();

  function releaseExactRecord(runId, record) {
    const current = runs.get(runId);
    if (current !== record) return Object.freeze({ released: false });
    runs.delete(runId);
    if (threadActiveRun.get(record.threadId) === runId) threadActiveRun.delete(record.threadId);
    return Object.freeze({ released: true, runId });
  }

  function assertNativePromise(promise) {
    if (promise && (typeof promise === "object" || typeof promise === "function") && utilTypes.isProxy(promise)) {
      authorityFail("AGENT_UNAVAILABLE", "Live run registry requires a native run promise.");
    }
    if (!utilTypes.isPromise(promise) || Object.getPrototypeOf(promise) !== PromisePrototype) {
      authorityFail("AGENT_UNAVAILABLE", "Live run registry requires a native run promise.");
    }
    if (ReflectOwnKeys(promise).length !== 0) {
      authorityFail("AGENT_UNAVAILABLE", "Live run registry promise must not expose own fields.");
    }
    return promise;
  }

  function claimRun(claimInput = {}) {
    const claim = normalizeClaim(claimInput);
    const active = threadActiveRun.get(claim.threadId);
    if (active && runs.has(active)) {
      authorityFail("RUN_CONFLICT", "Thread already has an active integration run.", { status: 409 });
    }
    if (runs.has(claim.runId)) {
      authorityFail("RUN_CONFLICT", "Integration run is already active.", { status: 409 });
    }
    const record = {
      ...claim,
      promise: null,
      claimedAt: new Date().toISOString(),
    };
    runs.set(claim.runId, record);
    threadActiveRun.set(claim.threadId, claim.runId);
    return Object.freeze({
      runId: claim.runId,
      threadId: claim.threadId,
      principalId: claim.principalId,
      browserSessionId: claim.browserSessionId,
      browserSessionPolicy: claim.browserSessionPolicy,
      claimedAt: record.claimedAt,
    });
  }

  function attachPromise(runIdInput, promise) {
    const runId = validateIntegrationRunId(runIdInput);
    const record = runs.get(runId);
    if (!record) notFound("Run");
    if (record.promise) {
      authorityFail("RUN_CONFLICT", "Integration run already has a native run promise.", { status: 409 });
    }
    try {
      const nativePromise = assertNativePromise(promise);
      const release = () => {
        releaseExactRecord(runId, record);
      };
      const observer = ReflectApply(PromisePrototypeThen, nativePromise, [release, release]);
      ReflectApply(PromisePrototypeThen, observer, [undefined, () => {}]);
      record.promise = nativePromise;
      return nativePromise;
    } catch (error) {
      releaseExactRecord(runId, record);
      if (error?.code || error?.publicCode) throw error;
      authorityFail("AGENT_UNAVAILABLE", "Live run registry could not attach the native run promise.");
    }
  }

  function getRun(runIdInput, scope = {}) {
    const runId = validateIntegrationRunId(runIdInput);
    const record = runs.get(runId);
    if (!record) return null;
    const checkedScope = Object.freeze({
      principalId: assertPrincipalId(scope.principalId),
      browserSessionId: assertBrowserSessionId(scope.browserSessionId),
    });
    assertScope(record, checkedScope, "Run");
    return Object.freeze({
      runId: record.runId,
      threadId: record.threadId,
      principalId: record.principalId,
      browserSessionId: record.browserSessionId,
      browserSessionPolicy: record.browserSessionPolicy,
      claimedAt: record.claimedAt,
      promise: record.promise,
      aborted: Boolean(record.controller.signal.aborted),
    });
  }

  function cancelRun(runIdInput, scope = {}, reason = new Error("Integration run cancelled.")) {
    const runId = validateIntegrationRunId(runIdInput);
    const record = runs.get(runId);
    if (!record) return Object.freeze({ cancelled: false, live: false });
    const checkedScope = Object.freeze({
      principalId: assertPrincipalId(scope.principalId),
      browserSessionId: assertBrowserSessionId(scope.browserSessionId),
    });
    assertScope(record, checkedScope, "Run");
    if (!record.controller.signal.aborted) record.controller.abort(reason);
    return Object.freeze({ cancelled: true, live: true, runId });
  }

  function releaseRun(runIdInput) {
    const runId = validateIntegrationRunId(runIdInput);
    const record = runs.get(runId);
    if (!record) return Object.freeze({ released: false });
    return releaseExactRecord(runId, record);
  }

  function hasActiveThreadRun(threadIdInput) {
    const threadId = validateIntegrationThreadId(threadIdInput);
    const runId = threadActiveRun.get(threadId);
    return Boolean(runId && runs.has(runId));
  }

  return Object.freeze({
    owner: "aginti",
    authority: "aginti",
    schemaVersion: INTEGRATION_RUN_REGISTRY_ATTESTATION_VERSION,
    durable: false,
    liveOnly: true,
    claimRun,
    attachPromise,
    getRun,
    cancelRun,
    releaseRun,
    hasActiveThreadRun,
    snapshot() {
      return Object.freeze({
        activeRuns: runs.size,
        activeThreads: threadActiveRun.size,
      });
    },
  });
}
