#!/usr/bin/env node
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFixedIntegrationPolicy,
  buildFixedIntegrationRuntimeOverrides,
  contractDigest,
  REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS,
} from "../src/integration-policy.js";
import {
  createAgintiIntegrationRuntimeAuthority,
  INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY,
  INTEGRATION_EVENT_APPEND_ATTESTATION_VERSION,
  INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION,
  INTEGRATION_RUNTIME_CANCELLATION_ATTESTATION_VERSION,
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY,
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION,
} from "../src/integration-runtime-authority.js";
import { createIntegrationRunRegistry } from "../src/integration-run-registry.js";
import { createIntegrationCoreEventProjector } from "../src/integration-core-event-projector.js";
import {
  PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
  createPublicIntegrationEvent,
} from "../src/integration-events.js";
import {
  NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
  buildFixedNativeRunAgentConfig,
  classifyRunAgentError,
  classifyRunAgentResult,
  executeNativeAgintiRun,
  expectedFixedSessionRuntimeSnapshot,
  outputEventForRunResult,
  postflightNativeSessionRuntime,
  preflightNativeSessionRuntime,
} from "../src/integration-native-executor.js";
import { runAgent } from "../src/agent-runner.js";
import { SessionStore } from "../src/session-store.js";

const PRINCIPAL = "principalAAAAAAAA";
const OTHER_PRINCIPAL = "principalBBBBBBBB";
const BROWSER_SESSION = "a".repeat(64);
const OTHER_BROWSER_SESSION = "b".repeat(64);
const ZERO_DIGEST = "0".repeat(64);
const CONTEXT_DIGEST = "c".repeat(64);
const SNAPSHOT_HASH = "d".repeat(64);
const ARTIFACT_ID = `art_${"e".repeat(64)}`;
const COMPLETION_OUTBOX_METADATA_VERSION = "aginti-completion-outbox-bundle-v1";
const PRE_LAUNCH_ABORT_ATTEMPT_VERSION = "aginti-pre-launch-abort-attempt-v3";
const PRE_LAUNCH_ABORT_RESPONSE_VERSION = "aginti-pre-launch-abort-response-v1";
const NATIVE_START_AUTHORIZATION_VERSION = "aginti-native-start-authorization-v1";
const NATIVE_START_RECOVERY_STATE_VERSION = "aginti-native-start-recovery-v1";
const DISPATCH_RECONCILIATION_VERSION = "aginti-dispatch-reconciliation-v1";
let SMOKE_ROOT = "";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGate() {
  let resolveGate;
  const promise = new Promise((resolve) => {
    resolveGate = resolve;
  });
  return Object.freeze({ promise, resolve: resolveGate });
}

async function waitForGate(gate, label) {
  let timeout = null;
  try {
    return await Promise.race([
        gate.promise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${label} did not open`)), 15_000);
        }),
      ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForPromise(promise, label) {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} did not settle`)), 15_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForRepositoryRunTerminal(fixture, runId, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = fixture.repo.state.runs.get(runId);
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return run;
    await delay(10);
  }
  const run = fixture.repo.state.runs.get(runId) || null;
  throw new Error(`${label} did not reach a durable terminal run state\nrun=${JSON.stringify(run)}\nrecentCalls=${JSON.stringify(fixture.repo.calls.slice(-12).map(([name]) => name))}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function seal(value) {
  const unsigned = { ...value };
  return deepFreeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function sealShallow(value) {
  const unsigned = { ...value };
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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
  return `nstart_${digest.slice(0, 48)}`;
}

function reconciliationRequestDigestFor(request = {}) {
  const { requestDigest: _requestDigest, ...unsigned } = request;
  return contractDigest(unsigned);
}

function reconciliationResponseDigestFor(response = {}) {
  const { responseDigest: _responseDigest, ...unsigned } = response;
  return contractDigest(unsigned);
}

function recoveryStateDigestFor(state = {}) {
  const { digest: _digest, ...unsigned } = state;
  return contractDigest(unsigned);
}

function cloneFrozenWith(source, descriptors = {}, prototype = Object.prototype) {
  const clone = Object.create(prototype);
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(source));
  Object.defineProperties(clone, descriptors);
  return Object.freeze(clone);
}

function runtimeRoots(overrides = {}) {
  const unsigned = {
    schemaVersion: NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
    sessionsDir: `${SMOKE_ROOT}/state/sessions`,
    baseDir: `${SMOKE_ROOT}/workspace`,
    commandCwd: `${SMOKE_ROOT}/workspace`,
    retainedDescriptor: true,
    symlinkFree: true,
    outsideForbiddenRoots: true,
    ...overrides,
  };
  return deepFreeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function fullIsolationAttestation() {
  return deepFreeze({
    profileVersion: "hardened-v1",
    profileDigest: "f".repeat(64),
    ...Object.fromEntries(REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS.map((key) => [key, true])),
  });
}

function mutableIsolationAttestation() {
  return {
    profileVersion: "hardened-v1",
    profileDigest: "f".repeat(64),
    ...Object.fromEntries(REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS.map((key) => [key, true])),
  };
}

function now() {
  return new Date().toISOString();
}

function fakeProcessOwner(timestamp = now()) {
  return Object.freeze({
    schemaVersion: "aginti-process-owner-v1",
    pid: 1,
    token: "1".repeat(32),
    processIdentity: Object.freeze({
      schemaVersion: "aginti-process-identity-v1",
      bootId: "01234567-89ab-cdef-0123-456789abcdef",
      startTimeTicks: "1",
    }),
    acquiredAt: timestamp,
    heartbeatAt: timestamp,
  });
}

function plainProcessOwner(owner) {
  return JSON.parse(JSON.stringify(owner));
}

function poisonProcessOwner(owner, mode, state) {
  const plain = plainProcessOwner(owner);
  if (mode === "mutable") return plain;
  if (mode === "owner-proxy") {
    return new Proxy(plain, {
      get(target, property, receiver) {
        state.processOwnerTrapCount += 1;
        return Reflect.get(target, property, receiver);
      },
    });
  }
  if (mode === "identity-proxy") {
    plain.processIdentity = new Proxy(plain.processIdentity, {
      get(target, property, receiver) {
        state.processOwnerTrapCount += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    return plain;
  }
  if (mode === "owner-accessor") {
    Object.defineProperty(plain, "pid", {
      enumerable: true,
      configurable: true,
      get() {
        state.processOwnerTrapCount += 1;
        return 1;
      },
    });
    return plain;
  }
  if (mode === "identity-accessor") {
    Object.defineProperty(plain.processIdentity, "bootId", {
      enumerable: true,
      configurable: true,
      get() {
        state.processOwnerTrapCount += 1;
        return "01234567-89ab-cdef-0123-456789abcdef";
      },
    });
    return plain;
  }
  if (mode === "owner-custom-proto-then") {
    const proto = Object.create(Object.prototype, {
      then: {
        enumerable: true,
        get() {
          state.processOwnerTrapCount += 1;
          return () => {};
        },
      },
    });
    Object.setPrototypeOf(plain, proto);
    return plain;
  }
  if (mode === "identity-custom-proto-then") {
    const proto = Object.create(Object.prototype, {
      then: {
        enumerable: true,
        get() {
          state.processOwnerTrapCount += 1;
          return () => {};
        },
      },
    });
    Object.setPrototypeOf(plain.processIdentity, proto);
    return plain;
  }
  if (mode === "identity-inherited-boot") {
    const inherited = plain.processIdentity.bootId;
    delete plain.processIdentity.bootId;
    Object.setPrototypeOf(plain.processIdentity, { bootId: inherited });
    return plain;
  }
  if (mode === "owner-extra-string") {
    plain.extra = true;
    return plain;
  }
  if (mode === "owner-extra-symbol") {
    plain[Symbol("extra")] = true;
    return plain;
  }
  if (mode === "identity-extra-string") {
    plain.processIdentity.extra = true;
    return plain;
  }
  if (mode === "identity-extra-symbol") {
    plain.processIdentity[Symbol("extra")] = true;
    return plain;
  }
  if (mode === "pid-string") {
    plain.pid = "1";
    return plain;
  }
  if (mode === "token-object") {
    plain.token = { toString() { state.processOwnerTrapCount += 1; return "1".repeat(32); } };
    return plain;
  }
  if (mode === "boot-uppercase") {
    plain.processIdentity.bootId = plain.processIdentity.bootId.toUpperCase();
    return plain;
  }
  if (mode === "boot-object") {
    plain.processIdentity.bootId = { toString() { state.processOwnerTrapCount += 1; return "01234567-89ab-cdef-0123-456789abcdef"; } };
    return plain;
  }
  if (mode === "ticks-number") {
    plain.processIdentity.startTimeTicks = 1;
    return plain;
  }
  return owner;
}

function threadRecord(overrides = {}) {
  return {
    id: overrides.id,
    nativeSessionId: overrides.nativeSessionId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    title: "New agent thread",
    status: "idle",
    revision: 1,
    createdAt: now(),
    updatedAt: now(),
    lastRunId: null,
    authority: {
      kind: "aginti",
      mapped: true,
      runtimeRevision: 1,
      contextDigest: CONTEXT_DIGEST,
      lastCompaction: null,
    },
    replay: { prunedMessageCount: 0, anchorDigest: ZERO_DIGEST },
    messages: [],
    ...overrides,
  };
}

function runRecord(overrides = {}) {
  return {
    id: overrides.id,
    threadId: overrides.threadId,
    nativeSessionId: overrides.nativeSessionId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    previousRunId: null,
    status: "running",
    revision: 1,
    createdAt: now(),
    startedAt: now(),
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
    output: "",
    error: null,
    authority: {
      kind: "aginti",
      snapshotHash: SNAPSHOT_HASH,
      runtimeRevision: 1,
      contextDigest: CONTEXT_DIGEST,
    },
    ...overrides,
  };
}

function plotArtifact(overrides = {}) {
  return {
    id: ARTIFACT_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId: overrides.threadId,
    runId: overrides.runId,
    title: "Revenue",
    kind: "plot",
    spec: {
      schemaVersion: "1",
      type: "line",
      labels: ["Jan", "Feb"],
      series: [{ name: "Revenue", data: [1, 2] }],
    },
    published: false,
    ...overrides,
  };
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

function completionOutboxMetadata({ run, thread, records, cursor }) {
  return {
    schemaVersion: COMPLETION_OUTBOX_METADATA_VERSION,
    principalId: run.principalId,
    browserSessionId: run.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    threadId: run.threadId,
    runId: run.id,
    status: run.status,
    completedAt: run.completedAt,
    runtimeRevision: run.authority.runtimeRevision,
    completionRevision: run.revision,
    threadRevision: thread.revision,
    originalCursor: {
      firstSeq: cursor.firstSeq ?? 1,
      lastSeq: cursor.lastSeq,
      lastHash: cursor.lastHash,
      prunedThroughSeq: cursor.prunedThroughSeq ?? 0,
    },
    outboxIds: records.map((record) => record.outboxId),
    eventTypes: records.map((record) => record.type),
    eventHashes: records.map((record) => record.expectedEventHash),
    orderedBundleDigest: contractDigest(records.map(immutableOutboxDigestView)),
  };
}

function threadPreservationDigestFor(thread) {
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

function makeRepository({
  retainedDescriptorStorageAuthority = false,
  roots = runtimeRoots(),
  inheritedForbidden = false,
} = {}) {
  const calls = [];
  const state = {
    threads: new Map(),
    runs: new Map(),
    artifacts: new Map(),
    outbox: new Map(),
    failNextUpdate: false,
    failCreateBeforeCommit: false,
    failCreateAfterCommit: false,
    malformedCreateRun: false,
    malformedCreateThread: false,
    failNextDispatch: false,
    failDispatchAfterCommit: false,
    malformedDispatchRun: false,
    forgedDispatchNativeStartReceipt: false,
    failAuthorizeBeforeCommit: false,
    failAuthorizeAfterCommit: false,
    forceAuthorizeAlreadyAuthorized: false,
    forgedAuthorizeReceipt: false,
    forgedAuthorizeRunRevision: null,
    forgedAuthorizeOwnerTimestamp: false,
    forgedAuthorizeTimestamp: false,
    forgedAuthorizeRunAlias: "",
    forgedAuthorizeThreadAlias: "",
    forgedAuthorizeDescriptor: "",
    mutateAuthorizeResponseAliasAfterReturn: false,
    authorizeDescriptorTrapCount: 0,
    reconcileMode: "",
    reconcileTrapCount: 0,
    onAuthorizeAfterCommitBeforeReturn: null,
    onReconcileAfterRequestBeforeScan: null,
    onReconcileBeforeResponse: null,
    failNextPreLaunchAbort: false,
    corruptAbortLease: false,
    forgedAbortRunRevision: null,
    forgedAbortAction: "",
    forgedAbortRunCreatedAt: "",
    forgedAbortRunStartedAt: "",
    forgedAbortThreadUpdatedAt: "",
    forgedAbortThreadContextDigest: "",
    forgedAbortThreadReplay: false,
    forgedAbortThreadMessages: false,
    forgedAbortOwnerTimestamp: false,
    preLaunchAbortError: null,
    mutateGetThreadAliasAfterReturn: "",
    mutateActiveRunAliasAfterReturn: "",
    mutatePriorRunAliasDuringGetThread: "",
    mutateCreateAliasAfterReturn: "",
    failNextCancel: false,
    failFinishBeforeCommitCount: 0,
    onFinishBeforeCommit: null,
    onFinishBeforeCommitFailure: null,
    failNextOutboxMark: false,
    failOutboxMarkTypes: new Set(),
    bundleMode: "",
    substituteDispatchThread: false,
    substituteCancelCompleted: false,
    omitCancelProcessOwner: false,
    proxyCancelProcessIdentity: false,
    cancelProcessOwnerMode: "",
    successfulCancelMarks: 0,
    processOwnerTrapCount: 0,
    substituteFinishThread: false,
    reorderFinishOutbox: false,
    substituteFinishOutboxScope: false,
    corruptFinishOutboxCursor: false,
  };
  const attestation = seal({
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
    retainedDescriptorStorageAuthority,
    runtimeRoots: roots,
  });

  function ownedThread(payload) {
    const thread = state.threads.get(payload.threadId);
    return thread && thread.principalId === payload.principalId && thread.browserSessionId === payload.browserSessionId
      ? thread
      : null;
  }

  function ownedRun(payload) {
    const run = state.runs.get(payload.runId);
    return run && !run.hidden && run.principalId === payload.principalId && run.browserSessionId === payload.browserSessionId ? run : null;
  }

  function mutateThreadAlias(thread, mode) {
    if (!thread) return;
    if (mode === "native") thread.nativeSessionId = "aginti:mutated-native";
    else if (mode === "lastRun") thread.lastRunId = "run_00000000-0000-4000-8000-000000000099";
    else if (mode === "revision") thread.revision += 10;
    else if (mode === "status") thread.status = "running";
    else if (mode === "context") thread.authority = { ...thread.authority, contextDigest: "9".repeat(64) };
    else if (mode === "replay") thread.replay = { prunedMessageCount: 1, anchorDigest: "8".repeat(64) };
    else if (mode === "messages") thread.messages = [{ role: "assistant", content: "mutated" }];
    else if (mode === "updatedAt") thread.updatedAt = "2026-01-01T00:00:00.000Z";
  }

  function mutateRunAlias(run, mode) {
    if (!run) return;
    if (mode === "native") run.nativeSessionId = "aginti:mutated-run-native";
    else if (mode === "thread") run.threadId = "thr_00000000-0000-4000-8000-000000000099";
    else if (mode === "status") run.status = "completed";
    else if (mode === "revision") run.revision += 10;
    else if (mode === "createdAt") run.createdAt = "2026-01-01T00:00:00.000Z";
  }

  function makeOutboxRecords(run, payload) {
    let seq = payload.expectedCursor.lastSeq;
    let hash = payload.expectedCursor.lastHash;
    const events = [payload.outputEvent, payload.terminalEvent].filter(Boolean);
    return events.map((eventInput) => {
      const checked = createPublicIntegrationEvent({
        threadId: run.threadId,
        runId: run.id,
        seq: seq + 1,
        type: eventInput.type,
        payload: eventInput.payload,
        createdAt: eventInput.createdAt,
        previousHash: hash,
      });
      const record = {
        outboxId: `out_${contractDigest({ runId: run.id, seq: checked.seq, hash: checked.hash }).slice(0, 48)}`,
        principalId: run.principalId,
        browserSessionId: run.browserSessionId,
        browserSessionPolicy: "same-browser-session",
        threadId: run.threadId,
        runId: run.id,
        type: eventInput.type,
        payload: eventInput.payload,
        createdAt: eventInput.createdAt,
        expectedPreviousSeq: seq,
        expectedPreviousHash: hash,
        expectedEventHash: checked.hash,
        delivered: false,
      };
      state.outbox.set(record.outboxId, record);
      seq = checked.seq;
      hash = checked.hash;
      return record;
    });
  }

  function authorizationResponse(outcome, authorization, run, thread) {
    let receipt = cloneJson(run.nativeStartReceipt || authorization);
    if (state.forgedAuthorizeReceipt) {
      receipt = { ...receipt, authorizationDigest: "f".repeat(64) };
    }
    if (state.forgedAuthorizeTimestamp) {
      receipt = { ...receipt, authorizedAt: "2026-01-01T00:00:00.000Z" };
    }
    let responseRun = { ...run, nativeStartReceipt: receipt };
    if (state.forgedAuthorizeRunRevision !== null) responseRun.revision = state.forgedAuthorizeRunRevision;
    if (state.forgedAuthorizeOwnerTimestamp && responseRun.processOwner) {
      responseRun.processOwner = {
        ...responseRun.processOwner,
        acquiredAt: "2026-01-01T00:00:00.000Z",
        heartbeatAt: "2026-01-01T00:00:01.000Z",
      };
    }
    if (state.forgedAuthorizeRunAlias === "native") responseRun.nativeSessionId = "aginti:forged-native";
    if (state.forgedAuthorizeRunAlias === "thread") responseRun.threadId = "thr_00000000-0000-4000-8000-000000000092";
    if (state.forgedAuthorizeRunAlias === "startedAt") responseRun.startedAt = "2026-01-01T00:00:00.000Z";
    let responseThread = { ...thread };
    if (state.forgedAuthorizeThreadAlias === "native") responseThread.nativeSessionId = "aginti:forged-native";
    if (state.forgedAuthorizeThreadAlias === "revision") responseThread.revision += 1;
    if (state.forgedAuthorizeThreadAlias === "updatedAt") responseThread.updatedAt = "2026-01-01T00:00:00.000Z";
    if (state.forgedAuthorizeThreadAlias === "context") {
      responseThread.authority = { ...responseThread.authority, contextDigest: "6".repeat(64) };
    }
    const response = {
      schemaVersion: NATIVE_START_AUTHORIZATION_VERSION,
      outcome,
      authorized: true,
      idempotent: outcome === "already-authorized",
      authorizationId: authorization.authorizationId,
      authorizationDigest: authorization.authorizationDigest,
      receipt,
      run: responseRun,
      thread: responseThread,
    };
    if (state.mutateAuthorizeResponseAliasAfterReturn) {
      setTimeout(() => {
        response.run.nativeSessionId = "aginti:mutated-after-return";
        response.thread.revision += 10;
      }, 0);
    }
    if (state.forgedAuthorizeDescriptor === "proxy") {
      return new Proxy(response, {
        get(target, property, receiver) {
          state.authorizeDescriptorTrapCount += 1;
          return Reflect.get(target, property, receiver);
        },
      });
    }
    if (state.forgedAuthorizeDescriptor === "accessor") {
      Object.defineProperty(response, "run", {
        enumerable: true,
        configurable: true,
        get() {
          state.authorizeDescriptorTrapCount += 1;
          return responseRun;
        },
      });
    }
    if (state.forgedAuthorizeDescriptor === "non-enumerable") {
      Object.defineProperty(response, "thread", {
        enumerable: false,
        configurable: true,
        writable: true,
        value: responseThread,
      });
    }
    if (state.forgedAuthorizeDescriptor === "symbol") response[Symbol("private")] = true;
    if (state.forgedAuthorizeDescriptor === "extra") response.raw = "private";
    if (state.forgedAuthorizeDescriptor === "outer-wrapper-extra") {
      return { authorization: response, extra: "private" };
    }
    return response;
  }

  function assertReconciliationRequest(request) {
    assert.equal(Object.isFrozen(request), true);
    assert.deepEqual(Object.keys(request), [
      "schemaVersion",
      "principalId",
      "browserSessionId",
      "browserSessionPolicy",
      "processOwner",
      "liveRunClaims",
      "reconciledAt",
      "requestDigest",
    ]);
    assert.equal(request.schemaVersion, DISPATCH_RECONCILIATION_VERSION);
    assert.match(request.principalId, /^[A-Za-z0-9._~-]{16,128}$/u);
    assert.match(request.browserSessionId, /^[a-f0-9]{64}$/u);
    assert.equal(request.browserSessionPolicy, "same-browser-session");
    assert.equal(Object.isFrozen(request.processOwner), true);
    assert.equal(Object.isFrozen(request.processOwner.processIdentity), true);
    assert.equal(Array.isArray(request.liveRunClaims), true);
    assert.equal(Object.isFrozen(request.liveRunClaims), true);
    assert.equal(request.requestDigest, reconciliationRequestDigestFor(request));
    let previousRunId = "";
    for (const claim of request.liveRunClaims) {
      assert.equal(Object.isFrozen(claim), true);
      assert.deepEqual(Object.keys(claim), ["runId", "threadId", "nativeSessionId", "claimedAt"]);
      assert.ok(claim.runId > previousRunId);
      previousRunId = claim.runId;
    }
  }

  function makeRecoveryState({ run, request }) {
    const unsigned = {
      schemaVersion: NATIVE_START_RECOVERY_STATE_VERSION,
      status: "recovery_hold",
      reason: "retained_descriptor_unavailable",
      authorizationId: run.nativeStartReceipt.authorizationId,
      authorizationDigest: run.nativeStartReceipt.authorizationDigest,
      sourceRunRevision: run.revision,
      appliedRunRevision: run.revision + 1,
      heldAt: request.reconciledAt,
      observedByProcessOwner: cloneJson(request.processOwner),
      digest: ZERO_DIGEST,
    };
    return {
      ...unsigned,
      digest: recoveryStateDigestFor(unsigned),
    };
  }

  function fakeUnavailable(message) {
    const error = new Error(message);
    error.code = "AGENT_UNAVAILABLE";
    throw error;
  }

  function validateFakeRecoveryState(run) {
    if (!Object.prototype.hasOwnProperty.call(run, "recoveryState")) {
      fakeUnavailable("recovery state field missing");
    }
    if (run.recoveryState === null || run.recoveryState === undefined) return null;
    if (!run.recoveryState || typeof run.recoveryState !== "object" || Array.isArray(run.recoveryState)) {
      fakeUnavailable("recovery state marker corrupt");
    }
    const legalSourceRunRevision = run.cancelRequestedAt
      ? run.nativeStartReceipt.targetRunRevision + 1
      : run.nativeStartReceipt.targetRunRevision;
    if (
      run.recoveryState.schemaVersion !== NATIVE_START_RECOVERY_STATE_VERSION ||
      run.recoveryState.status !== "recovery_hold" ||
      run.recoveryState.reason !== "retained_descriptor_unavailable" ||
      run.recoveryState.authorizationId !== run.nativeStartReceipt.authorizationId ||
      run.recoveryState.authorizationDigest !== run.nativeStartReceipt.authorizationDigest ||
      run.recoveryState.sourceRunRevision !== legalSourceRunRevision ||
      run.recoveryState.appliedRunRevision !== run.revision ||
      run.recoveryState.digest !== recoveryStateDigestFor(run.recoveryState)
    ) {
      fakeUnavailable("recovery state marker invalid");
    }
    return run.recoveryState;
  }

  function fakeLiveClaimBindsDispatchWindow(claim, run, request) {
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

  function reconcileResponse({ request, receiptRunResults, pendingOutboxEvents }) {
    let results = [...receiptRunResults].sort((left, right) => left.run.id.localeCompare(right.run.id));
    if (state.reconcileMode === "duplicate-result" && results[0]) results = [results[0], results[0], ...results.slice(1)];
    if (state.reconcileMode === "unsorted-result" && results.length > 1) results = [...results].reverse();
    if (state.reconcileMode === "foreign-result" && results[0]) {
      results = [{ ...results[0], run: { ...results[0].run, principalId: OTHER_PRINCIPAL } }, ...results.slice(1)];
    }
    if (state.reconcileMode === "live-without-claim" && results[0]) {
      results = [{ ...results[0], action: "live" }, ...results.slice(1)];
    }
    if (state.reconcileMode === "bad-recovery-digest" && results[0]) {
      results = [
        {
          ...results[0],
          run: {
            ...results[0].run,
            recoveryState: { ...results[0].run.recoveryState, digest: "f".repeat(64) },
          },
        },
        ...results.slice(1),
      ];
    }
    if (state.reconcileMode === "bad-recovery-revision" && results[0]) {
      results = [
        {
          ...results[0],
          run: {
            ...results[0].run,
            revision: results[0].run.revision + 1,
          },
        },
        ...results.slice(1),
      ];
    }
    if (state.reconcileMode === "bad-recovery-source" && results[0]) {
      const forgedRecovery = {
        ...results[0].run.recoveryState,
        sourceRunRevision: 10,
        appliedRunRevision: 11,
        digest: ZERO_DIGEST,
      };
      forgedRecovery.digest = recoveryStateDigestFor(forgedRecovery);
      results[0].run.recoveryState = forgedRecovery;
      results[0].run.revision = 11;
    }
    if (state.reconcileMode === "bad-held-at" && results[0]) {
      const forgedRecovery = {
        ...results[0].run.recoveryState,
        heldAt: "2020-01-01T00:00:00.000Z",
        digest: ZERO_DIGEST,
      };
      forgedRecovery.digest = recoveryStateDigestFor(forgedRecovery);
      results[0].run.recoveryState = forgedRecovery;
    }
    if (state.reconcileMode === "stale-returned-already-held" && results[0]) {
      const forgedRun = cloneJson(results[0].run);
      forgedRun.recoveryState = {
        ...forgedRun.recoveryState,
        heldAt: "2020-01-01T00:00:00.000Z",
        digest: ZERO_DIGEST,
      };
      forgedRun.recoveryState.digest = recoveryStateDigestFor(forgedRun.recoveryState);
      results = [{ ...results[0], run: forgedRun }, ...results.slice(1)];
    }
    if (state.reconcileMode === "changed-thread-context" && results[0]) {
      results = [
        {
          ...results[0],
          thread: {
            ...results[0].thread,
            authority: { ...results[0].thread.authority, contextDigest: "9".repeat(64) },
          },
        },
        ...results.slice(1),
      ];
    }
    if (state.reconcileMode === "bad-thread-revision" && results[0]) {
      results[0].thread.revision += 1;
    }
    if (state.reconcileMode === "bad-thread-updated-at" && results[0]) {
      results[0].thread.updatedAt = "2020-01-01T00:00:00.000Z";
    }
    if (state.reconcileMode === "bad-runtime-revision" && results[0]) {
      results[0].run.authority = { ...results[0].run.authority, runtimeRevision: 99 };
    }
    if (state.reconcileMode === "bad-previous-run" && results[0]) {
      results[0].run.previousRunId = "run_00000000-0000-4000-8000-000000000092";
    }
    if (state.reconcileMode === "bad-cancel-requested" && results[0]) {
      results[0].run.cancelRequestedAt = "not-a-canonical-timestamp";
    }
    if (state.reconcileMode === "bad-dispatch-lease" && results[0]) {
      results = [
        {
          ...results[0],
          run: {
            ...results[0].run,
            dispatchLeaseId: "f".repeat(64),
          },
        },
        ...results.slice(1),
      ];
    }
    if (state.reconcileMode === "hidden-run" && results[0]) {
      results = [
        {
          ...results[0],
          run: {
            ...results[0].run,
            hidden: true,
          },
        },
        ...results.slice(1),
      ];
    }
    if (state.reconcileMode === "stale-returned-run" && results[0]) {
      const stale = {
        ...results[0],
        run: cloneJson(results[0].run),
        thread: cloneJson(results[0].thread),
      };
      const durableRun = state.runs.get(stale.run.id);
      if (durableRun) durableRun.revision += 1;
      results = [stale, ...results.slice(1)];
    }
    if (state.reconcileMode === "stale-returned-thread" && results[0]) {
      const stale = {
        ...results[0],
        run: cloneJson(results[0].run),
        thread: cloneJson(results[0].thread),
      };
      const durableThread = state.threads.get(stale.thread.id);
      if (durableThread) {
        durableThread.authority = { ...durableThread.authority, contextDigest: "4".repeat(64) };
      }
      results = [stale, ...results.slice(1)];
    }
    if (state.reconcileMode === "extra-result" && results[0]) {
      results = [{ ...results[0], raw: "private" }, ...results.slice(1)];
    }
    if (state.reconcileMode === "accessor-result" && results[0]) {
      const result = { ...results[0] };
      Object.defineProperty(result, "run", {
        enumerable: true,
        configurable: true,
        get() {
          state.reconcileTrapCount += 1;
          return results[0].run;
        },
      });
      results = [result, ...results.slice(1)];
    }
    if (state.reconcileMode === "sparse-results") {
      const sparse = [];
      sparse.length = (results.length || 1) + 1;
      if (results[0]) sparse[1] = results[0];
      results = sparse;
    }
    const unsignedResponse = {
      schemaVersion: DISPATCH_RECONCILIATION_VERSION,
      requestDigest: request.requestDigest,
      reconciled: true,
      receiptRunResults: results,
      pendingOutboxEvents,
    };
    let response = {
      ...unsignedResponse,
      responseDigest: reconciliationResponseDigestFor(unsignedResponse),
    };
    if (state.reconcileMode === "proxy-result" && results[0]) {
      response = {
        ...response,
        receiptRunResults: [
          new Proxy(results[0], {
            get(target, property, receiver) {
              state.reconcileTrapCount += 1;
              return Reflect.get(target, property, receiver);
            },
          }),
          ...results.slice(1),
        ],
      };
    }
    if (state.reconcileMode === "wrapper-extra") response = { ...response, extra: "private" };
    if (state.reconcileMode === "missing-response-digest") delete response.responseDigest;
    if (state.reconcileMode === "bad-response-digest") response = { ...response, responseDigest: "f".repeat(64) };
    return response;
  }

  const methods = {
    [INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY]: attestation,
    async listIntegrationThreads(payload) {
      calls.push(["listIntegrationThreads", payload]);
      return {
        threads: [...state.threads.values()].filter(
          (thread) => thread.principalId === payload.principalId && thread.browserSessionId === payload.browserSessionId
        ),
        nextBefore: null,
      };
    },
    async createIntegrationThread(payload) {
      calls.push(["createIntegrationThread", payload]);
      const thread = threadRecord({
        id: payload.threadId,
        nativeSessionId: payload.nativeSessionId,
        principalId: payload.principalId,
        browserSessionId: payload.browserSessionId,
        browserSessionPolicy: payload.browserSessionPolicy,
        title: payload.title,
        createdAt: payload.createdAt,
        updatedAt: payload.createdAt,
      });
      state.threads.set(thread.id, thread);
      return { thread };
    },
    async getIntegrationThread(payload) {
      calls.push(["getIntegrationThread", payload]);
      mutateRunAlias(state.lastReturnedRunAlias, state.mutatePriorRunAliasDuringGetThread);
      const thread = ownedThread(payload);
      mutateThreadAlias(thread, state.mutateGetThreadAliasAfterReturn);
      state.lastReturnedThreadAlias = thread;
      return { thread };
    },
    async updateIntegrationThread(payload) {
      calls.push(["updateIntegrationThread", payload]);
      const thread = ownedThread(payload);
      if (!thread || thread.revision !== payload.expectedRevision || state.failNextUpdate) {
        state.failNextUpdate = false;
        const error = new Error("revision conflict");
        error.code = "REVISION_CONFLICT";
        throw error;
      }
      Object.assign(thread, { title: payload.title, updatedAt: payload.updatedAt, revision: thread.revision + 1 });
      return { thread };
    },
    async deleteIntegrationThread(payload) {
      calls.push(["deleteIntegrationThread", payload]);
      const thread = ownedThread(payload);
      if (!thread || thread.revision !== payload.expectedRevision) {
        const error = new Error("revision conflict");
        error.code = "REVISION_CONFLICT";
        throw error;
      }
      state.threads.delete(thread.id);
      return { deleted: true, thread };
    },
    async getActiveIntegrationRunForThread(payload) {
      calls.push(["getActiveIntegrationRunForThread", payload]);
      mutateThreadAlias(state.lastReturnedThreadAlias, state.mutateActiveRunAliasAfterReturn);
      return {
        run:
          [...state.runs.values()].find(
            (run) =>
              !run.hidden &&
              run.threadId === payload.threadId &&
              run.principalId === payload.principalId &&
              run.browserSessionId === payload.browserSessionId &&
              ["starting", "running"].includes(run.status)
          ) || null,
      };
    },
    async createIntegrationRun(payload) {
      calls.push(["createIntegrationRun", payload]);
      const thread = ownedThread(payload);
      if (state.failCreateBeforeCommit) {
        state.failCreateBeforeCommit = false;
        const error = new Error("create failed before commit");
        error.code = "REVISION_CONFLICT";
        throw error;
      }
      if (
        !thread ||
        thread.revision !== payload.expectedThreadRevision ||
        thread.authority.runtimeRevision !== payload.expectedNativeRuntimeRevision
      ) {
        const error = new Error("revision conflict");
        error.code = "REVISION_CONFLICT";
        throw error;
      }
      const run = runRecord({
        id: payload.runId,
        threadId: payload.threadId,
        nativeSessionId: payload.nativeSessionId,
        principalId: payload.principalId,
        browserSessionId: payload.browserSessionId,
        browserSessionPolicy: payload.browserSessionPolicy,
        previousRunId: payload.previousRunId,
        status: payload.status,
        createdAt: payload.createdAt,
        startedAt: payload.createdAt,
        authority: {
          kind: "aginti",
          snapshotHash: SNAPSHOT_HASH,
          runtimeRevision: payload.expectedNativeRuntimeRevision,
          contextDigest: CONTEXT_DIGEST,
        },
      });
      state.runs.set(run.id, run);
      Object.assign(thread, { lastRunId: run.id, status: "running", revision: thread.revision + 1, updatedAt: payload.createdAt });
      if (state.failCreateAfterCommit) {
        state.failCreateAfterCommit = false;
        const error = new Error("create failed after commit");
        error.code = "CREATE_ACK_LOST";
        throw error;
      }
      if (state.malformedCreateRun) return { run: { ...run, id: "run_00000000-0000-4000-8000-000000000099" }, thread };
      if (state.malformedCreateThread) return { run, thread: { ...thread, lastRunId: "run_00000000-0000-4000-8000-000000000099" } };
      return { run, thread };
    },
    async markIntegrationRunDispatching(payload) {
      calls.push(["markIntegrationRunDispatching", payload]);
      mutateRunAlias(state.runs.get(payload.runId), state.mutateCreateAliasAfterReturn);
      mutateThreadAlias(state.threads.get(payload.threadId), state.mutateCreateAliasAfterReturn);
      const run = ownedRun(payload);
      if (!run || !Object.prototype.hasOwnProperty.call(run, "nativeStartReceipt") || run.nativeStartReceipt !== null) {
        const error = new Error("native start receipt already exists");
        error.code = "NATIVE_START_AUTHORIZATION_REFUSED";
        throw error;
      }
      if (
        !run ||
        run.revision !== payload.expectedRevision ||
        run.authority.runtimeRevision !== payload.expectedNativeRuntimeRevision ||
        state.failNextDispatch
      ) {
        state.failNextDispatch = false;
        const error = new Error("dispatch conflict");
        error.code = "REVISION_CONFLICT";
        throw error;
      }
      Object.assign(run, {
        threadId: run.threadId,
        status: "running",
        dispatchLeaseId: payload.dispatchLeaseId,
        dispatchOutbox: payload.dispatchOutbox,
        processOwner: payload.processOwner,
        dispatchedAt: payload.dispatchedAt,
        revision: run.revision + 1,
      });
      if (state.corruptAbortLease) run.dispatchLeaseId = "f".repeat(64);
      if (state.failDispatchAfterCommit) {
        state.failDispatchAfterCommit = false;
        const error = new Error("dispatch failed after commit");
        error.code = "DISPATCH_ACK_LOST";
        throw error;
      }
      if (state.malformedDispatchRun) return { run: { ...run, nativeSessionId: "aginti:wrong" } };
      if (state.forgedDispatchNativeStartReceipt) return { run: { ...run, nativeStartReceipt: { forged: true } } };
      if (state.substituteDispatchThread) return { run: { ...run, threadId: "thr_00000000-0000-4000-8000-000000000001" } };
      return { run };
    },
    async authorizeIntegrationRunNativeStart(payload) {
      calls.push(["authorizeIntegrationRunNativeStart", payload]);
      const authorization = payload.authorization;
      assert.equal(Object.isFrozen(payload), true);
      assert.equal(Object.isFrozen(authorization), true);
      assert.equal(Object.isFrozen(authorization.processOwner), true);
      assert.equal(Object.isFrozen(authorization.processOwner.processIdentity), true);
      const digest = nativeStartAuthorizationDigestFor(authorization);
      if (
        authorization.schemaVersion !== NATIVE_START_AUTHORIZATION_VERSION ||
        authorization.authorizationDigest !== digest ||
        authorization.authorizationId !== nativeStartAuthorizationIdForDigest(digest) ||
        authorization.browserSessionPolicy !== "same-browser-session" ||
        authorization.expectedRunRevision !== 2 ||
        authorization.targetRunRevision !== 3 ||
        authorization.dispatchOutbox !== true ||
        authorization.authorizedAt !== authorization.dispatchedAt
      ) {
        const error = new Error("native start authorization invalid");
        error.code = "NATIVE_START_AUTHORIZATION_REFUSED";
        throw error;
      }
      const run = ownedRun(authorization);
      const thread = ownedThread(authorization);
      if (!run || !thread) {
        const error = new Error("native start authorization target mismatch");
        error.code = "NATIVE_START_AUTHORIZATION_REFUSED";
        throw error;
      }
      if (run.nativeStartReceipt) {
        if (run.nativeStartReceipt.authorizationDigest !== authorization.authorizationDigest) {
          const error = new Error("native start authorization digest mismatch");
          error.code = "NATIVE_START_AUTHORIZATION_REFUSED";
          throw error;
        }
        return authorizationResponse("already-authorized", authorization, run, thread);
      }
      if (state.failAuthorizeBeforeCommit) {
        state.failAuthorizeBeforeCommit = false;
        const error = new Error("native start authorization failed before commit");
        error.code = "NATIVE_START_AUTHORIZATION_FAILED";
        throw error;
      }
      const previousRun = authorization.previousRunId ? state.runs.get(authorization.previousRunId) : null;
      if (
        run.status !== "running" ||
        run.revision !== authorization.expectedRunRevision ||
        run.threadId !== authorization.threadId ||
        run.nativeSessionId !== authorization.nativeSessionId ||
        run.previousRunId !== authorization.previousRunId ||
        run.createdAt !== authorization.createdAt ||
        run.startedAt !== authorization.startedAt ||
        run.dispatchLeaseId !== authorization.dispatchLeaseId ||
        run.dispatchOutbox !== true ||
        run.dispatchedAt !== authorization.dispatchedAt ||
        run.authority.runtimeRevision !== authorization.expectedNativeRuntimeRevision ||
        contractDigest(run.processOwner) !== contractDigest(authorization.processOwner) ||
        thread.status !== "running" ||
        thread.lastRunId !== run.id ||
        thread.revision !== authorization.threadRevision ||
        thread.updatedAt !== authorization.createdAt ||
        thread.nativeSessionId !== authorization.nativeSessionId ||
        threadPreservationDigestFor(thread) !== authorization.threadPreservationDigest ||
        thread.authority.runtimeRevision !== authorization.expectedNativeRuntimeRevision ||
        (authorization.mode === "start" && authorization.previousRunId !== null) ||
        (authorization.mode === "resume" &&
          (!previousRun ||
            !["completed", "failed", "cancelled"].includes(previousRun.status) ||
            previousRun.revision !== authorization.previousRunRevision ||
            previousRun.authority.runtimeRevision !== authorization.previousRunRuntimeRevision ||
            previousRun.authority.runtimeRevision !== authorization.expectedNativeRuntimeRevision ||
            previousRun.threadId !== authorization.threadId ||
            previousRun.nativeSessionId !== authorization.nativeSessionId))
      ) {
        const error = new Error("native start authorization state mismatch");
        error.code = "NATIVE_START_AUTHORIZATION_REFUSED";
        throw error;
      }
      Object.assign(run, {
        nativeStartReceipt: cloneJson(authorization),
        revision: authorization.targetRunRevision,
      });
      if (state.onAuthorizeAfterCommitBeforeReturn) {
        await state.onAuthorizeAfterCommitBeforeReturn({ authorization, run, thread });
      }
      if (state.failAuthorizeAfterCommit) {
        state.failAuthorizeAfterCommit = false;
        const error = new Error("native start authorization acknowledgement lost");
        error.code = "NATIVE_START_AUTHORIZATION_ACK_LOST";
        throw error;
      }
      return authorizationResponse(state.forceAuthorizeAlreadyAuthorized ? "already-authorized" : "authorized", authorization, run, thread);
    },
    async abortIntegrationRunBeforeLaunch(payload) {
      calls.push(["abortIntegrationRunBeforeLaunch", payload]);
      if (state.preLaunchAbortError) throw state.preLaunchAbortError;
      if (state.failNextPreLaunchAbort) {
        state.failNextPreLaunchAbort = false;
        const error = new Error("pre-launch abort failed");
        error.code = "PRE_LAUNCH_ABORT_FAILED";
        throw error;
      }
      const attempt = payload.attempt;
      if (attempt.schemaVersion !== PRE_LAUNCH_ABORT_ATTEMPT_VERSION || attempt.nativeStartReceiptMustBeAbsent !== true) {
        const error = new Error("pre-launch abort receipt precondition missing");
        error.code = "PRE_LAUNCH_ABORT_REFUSED";
        throw error;
      }
      const response = (action, aborted, idempotent, run, thread) => {
        const responseAction = state.forgedAbortAction || action;
        let responseRun = run;
        if (run) {
          responseRun = { ...run };
          if (state.forgedAbortRunRevision !== null) responseRun.revision = state.forgedAbortRunRevision;
          if (state.forgedAbortRunCreatedAt) responseRun.createdAt = state.forgedAbortRunCreatedAt;
          if (state.forgedAbortRunStartedAt) responseRun.startedAt = state.forgedAbortRunStartedAt;
          if (state.forgedAbortOwnerTimestamp && responseRun.processOwner) {
            responseRun.processOwner = {
              ...responseRun.processOwner,
              acquiredAt: "2026-01-01T00:00:00.000Z",
              heartbeatAt: "2026-01-01T00:00:01.000Z",
            };
          }
        }
        let responseThread = thread;
        if (thread) {
          responseThread = { ...thread };
          if (state.forgedAbortThreadUpdatedAt) responseThread.updatedAt = state.forgedAbortThreadUpdatedAt;
          if (state.forgedAbortThreadContextDigest) {
            responseThread.authority = { ...responseThread.authority, contextDigest: state.forgedAbortThreadContextDigest };
          }
          if (state.forgedAbortThreadReplay) responseThread.replay = { prunedMessageCount: 99, anchorDigest: "7".repeat(64) };
          if (state.forgedAbortThreadMessages) responseThread.messages = [{ role: "assistant", content: "forged" }];
        }
        return {
          schemaVersion: PRE_LAUNCH_ABORT_RESPONSE_VERSION,
          action: responseAction,
          aborted: responseAction === "not-created" ? false : aborted,
          idempotent: responseAction === "already-aborted" ? true : responseAction === "aborted" ? false : idempotent,
          attemptDigest: attempt.attemptDigest,
          run: responseRun,
          thread: responseThread,
        };
      };
      const run = state.runs.get(attempt.runId);
      if (!run) return response("not-created", false, false, null, null);
      if (run.nativeStartReceipt !== null) {
        const error = new Error("pre-launch abort native start receipt exists");
        error.code = "PRE_LAUNCH_ABORT_REFUSED";
        throw error;
      }
      const thread = state.threads.get(attempt.threadId);
      if (
        !thread ||
        run.principalId !== attempt.principalId ||
        run.browserSessionId !== attempt.browserSessionId ||
        run.threadId !== attempt.threadId ||
        run.nativeSessionId !== attempt.nativeSessionId ||
        run.previousRunId !== attempt.previousRunId ||
        run.authority.runtimeRevision !== attempt.expectedNativeRuntimeRevision ||
        thread.lastRunId !== attempt.runId && run.status !== "aborted_before_launch"
      ) {
        const error = new Error("pre-launch abort target mismatch");
        error.code = "PRE_LAUNCH_ABORT_REFUSED";
        throw error;
      }
      if (threadPreservationDigestFor(thread) !== attempt.threadPreservationDigest) {
        const error = new Error("pre-launch abort thread digest mismatch");
        error.code = "PRE_LAUNCH_ABORT_REFUSED";
        throw error;
      }
      if (run.status === "aborted_before_launch") {
        if (run.abortAttemptDigest !== attempt.attemptDigest) {
          const error = new Error("pre-launch abort digest mismatch");
          error.code = "PRE_LAUNCH_ABORT_REFUSED";
          throw error;
        }
        return response("already-aborted", true, true, run, thread);
      }
      if (run.status === "starting") {
        assert.equal(run.revision, 1);
      } else if (run.status === "running") {
        if (
          attempt.dispatchAttempted !== true ||
          run.revision !== 2 ||
          run.dispatchLeaseId !== attempt.dispatchLeaseId ||
          run.dispatchOutbox !== true ||
          run.dispatchedAt !== attempt.dispatchedAt ||
          contractDigest(run.processOwner) !== contractDigest(attempt.processOwner)
        ) {
          const error = new Error("pre-launch abort dispatch lease mismatch");
          error.code = "PRE_LAUNCH_ABORT_REFUSED";
          throw error;
        }
      } else {
        const error = new Error("pre-launch abort status mismatch");
        error.code = "PRE_LAUNCH_ABORT_REFUSED";
        throw error;
      }
      Object.assign(run, {
        status: "aborted_before_launch",
        hidden: true,
        tombstone: true,
        completedAt: null,
        output: "",
        error: null,
        abortAttemptDigest: attempt.attemptDigest,
        abortAt: attempt.abortAt,
        revision: run.revision + 1,
      });
      Object.assign(thread, {
        status: "idle",
        lastRunId: attempt.previousRunId,
        updatedAt: attempt.abortAt,
        revision: thread.revision + 1,
      });
      return response("aborted", true, false, run, thread);
    },
    async getIntegrationRun(payload) {
      calls.push(["getIntegrationRun", payload]);
      const run = ownedRun(payload);
      state.lastReturnedRunAlias = run;
      return { run };
    },
    async markIntegrationRunCancelling(payload) {
      calls.push(["markIntegrationRunCancelling", payload]);
      const run = ownedRun(payload);
      if (!run || run.revision !== payload.expectedRevision || state.failNextCancel) {
        state.failNextCancel = false;
        const error = new Error("revision conflict");
        error.code = "REVISION_CONFLICT";
        throw error;
      }
      Object.assign(run, {
        cancelRequestedAt: payload.cancelRequestedAt,
        status: state.substituteCancelCompleted ? "completed" : run.status,
        processOwner: state.omitCancelProcessOwner
          ? undefined
          : poisonProcessOwner(
              payload.processOwner,
              state.proxyCancelProcessIdentity ? "identity-proxy" : state.cancelProcessOwnerMode,
              state
            ),
        revision: run.revision + 1,
      });
      state.successfulCancelMarks += 1;
      return { run };
    },
    async finishIntegrationRunWithOutbox(payload) {
      calls.push(["finishIntegrationRunWithOutbox", payload]);
      const run = ownedRun(payload);
      if (
        !run ||
        run.revision !== payload.expectedRevision ||
        run.authority.runtimeRevision !== payload.expectedNativeRuntimeRevision
      ) {
        const error = new Error("revision conflict");
        error.code = "REVISION_CONFLICT";
        throw error;
      }
      if (state.onFinishBeforeCommit) await state.onFinishBeforeCommit({ payload, run, remaining: state.failFinishBeforeCommitCount });
      if (state.failFinishBeforeCommitCount > 0) {
        state.failFinishBeforeCommitCount -= 1;
        if (state.onFinishBeforeCommitFailure) {
          await state.onFinishBeforeCommitFailure({ payload, run, remaining: state.failFinishBeforeCommitCount });
        }
        const error = new Error("finish failed before commit");
        error.code = "REVISION_CONFLICT";
        error.persistedRuntimeRevision = payload.completedNativeRuntimeRevision;
        throw error;
      }
      Object.assign(run, {
        status: payload.status,
        completedAt: payload.completedAt,
        processOwner: payload.processOwner,
        output: payload.output,
        error: payload.error,
        authority: {
          ...run.authority,
          runtimeRevision: payload.completedNativeRuntimeRevision,
        },
        revision: run.revision + 1,
      });
      const thread = state.threads.get(run.threadId);
      if (thread) {
        Object.assign(thread, {
          status: "idle",
          updatedAt: payload.completedAt,
          authority: {
            ...thread.authority,
            runtimeRevision: payload.completedNativeRuntimeRevision,
          },
          revision: thread.revision + 1,
        });
      }
      const originalOutboxEvents = makeOutboxRecords(run, payload);
      Object.assign(run, {
        authority: {
          ...run.authority,
          completionOutbox: completionOutboxMetadata({
            run,
            thread,
            records: originalOutboxEvents,
            cursor: payload.expectedCursor,
          }),
        },
      });
      let outboxEvents = originalOutboxEvents;
      if (state.reorderFinishOutbox) outboxEvents = [...outboxEvents].reverse();
      if (state.substituteFinishOutboxScope && outboxEvents[0]) {
        outboxEvents = [{ ...outboxEvents[0], threadId: "thr_00000000-0000-4000-8000-000000000096" }, ...outboxEvents.slice(1)];
      }
      if (state.corruptFinishOutboxCursor && outboxEvents[0]) {
        outboxEvents = [{ ...outboxEvents[0], expectedPreviousSeq: outboxEvents[0].expectedPreviousSeq + 1 }, ...outboxEvents.slice(1)];
      }
      const returnedThread = state.substituteFinishThread
        ? { ...thread, id: "thr_00000000-0000-4000-8000-000000000097" }
        : thread;
      return { run, thread: returnedThread, outboxEvents, resultDigest: payload.resultDigest };
    },
    async getIntegrationCompletionOutboxBundle(payload) {
      calls.push(["getIntegrationCompletionOutboxBundle", payload]);
      const run = ownedRun(payload);
      if (!run || run.threadId !== payload.threadId) return { outboxEvents: [] };
      let outboxEvents = [...state.outbox.values()]
        .filter(
          (record) =>
            record.principalId === payload.principalId &&
            record.browserSessionId === payload.browserSessionId &&
            record.threadId === payload.threadId &&
            record.runId === payload.runId
        )
        .sort((left, right) => left.expectedPreviousSeq - right.expectedPreviousSeq);
      if (state.bundleMode === "truncated") outboxEvents = outboxEvents.slice(1);
      if (state.bundleMode === "reordered") outboxEvents = [...outboxEvents].reverse();
      if (state.bundleMode === "regenerated") {
        outboxEvents = outboxEvents.map((record, index) => ({
          ...record,
          outboxId: `${record.outboxId}_shifted_${index}`,
        }));
      }
      if (state.bundleMode === "extra" && outboxEvents[0]) {
        outboxEvents = [{ ...outboxEvents[0], raw: "private" }, ...outboxEvents.slice(1)];
      }
      if (state.bundleMode === "accessor" && outboxEvents[0]) {
        const record = { ...outboxEvents[0] };
        Object.defineProperty(record, "payload", {
          configurable: true,
          enumerable: true,
          get() {
            return {};
          },
        });
        outboxEvents = [record, ...outboxEvents.slice(1)];
      }
      if (state.bundleMode === "proxy" && outboxEvents[0]) {
        outboxEvents = [new Proxy(outboxEvents[0], {}), ...outboxEvents.slice(1)];
      }
      if (state.bundleMode === "sparse-array") {
        const sparse = [];
        sparse.length = outboxEvents.length;
        if (outboxEvents[1]) sparse[1] = outboxEvents[1];
        outboxEvents = sparse;
      }
      if (state.bundleMode === "accessor-array" && outboxEvents[0]) {
        const accessorArray = [...outboxEvents];
        Object.defineProperty(accessorArray, "0", {
          configurable: true,
          enumerable: true,
          get() {
            return outboxEvents[0];
          },
        });
        outboxEvents = accessorArray;
      }
      if (state.bundleMode === "custom-array") {
        const customArray = [...outboxEvents];
        Object.setPrototypeOf(customArray, {});
        outboxEvents = customArray;
      }
      if (state.bundleMode === "proxy-array") {
        outboxEvents = new Proxy([...outboxEvents], {});
      }
      if (state.bundleMode === "foreign" && outboxEvents[0]) {
        outboxEvents = [{ ...outboxEvents[0], threadId: "thr_00000000-0000-4000-8000-000000000098" }, ...outboxEvents.slice(1)];
      }
      return { outboxEvents };
    },
    async reconcileIntegrationDispatches(request) {
      calls.push(["reconcileIntegrationDispatches", request]);
      assertReconciliationRequest(request);
      if (state.onReconcileAfterRequestBeforeScan) {
        await state.onReconcileAfterRequestBeforeScan({ request });
      }
      const liveClaims = new Map(request.liveRunClaims.map((claim) => [claim.runId, claim]));
      const receiptRunResults = [];
      for (const run of [...state.runs.values()].sort((left, right) => left.id.localeCompare(right.id))) {
        if (
          run.hidden ||
          run.status !== "running" ||
          run.principalId !== request.principalId ||
          run.browserSessionId !== request.browserSessionId ||
          !run.nativeStartReceipt
        ) {
          continue;
        }
        const thread = state.threads.get(run.threadId);
        const claim = liveClaims.get(run.id);
        const existingRecoveryState = validateFakeRecoveryState(run);
        if (existingRecoveryState) {
          receiptRunResults.push({ action: "already-held", run, thread });
          continue;
        }
        const exactLive =
          claim &&
          claim.threadId === run.threadId &&
          claim.nativeSessionId === run.nativeSessionId &&
          fakeLiveClaimBindsDispatchWindow(claim, run, request) &&
          contractDigest(run.processOwner) === contractDigest(request.processOwner);
        if (exactLive) {
          receiptRunResults.push({ action: "live", run, thread });
          continue;
        }
        run.recoveryState = makeRecoveryState({ run, request });
        run.revision = run.recoveryState.appliedRunRevision;
        receiptRunResults.push({ action: "held", run, thread });
      }
      if (state.onReconcileBeforeResponse) {
        await state.onReconcileBeforeResponse({ request, receiptRunResults });
      }
      return reconcileResponse({
        request,
        receiptRunResults,
        pendingOutboxEvents: [...state.outbox.values()].filter(
          (record) =>
            !record.delivered &&
            record.principalId === request.principalId &&
            record.browserSessionId === request.browserSessionId
        ),
      });
    },
    async listPendingIntegrationOutboxEvents(payload) {
      calls.push(["listPendingIntegrationOutboxEvents", payload]);
      return {
        outboxEvents: [...state.outbox.values()].filter(
          (record) =>
            !record.delivered &&
            record.principalId === payload.principalId &&
            record.browserSessionId === payload.browserSessionId
        ),
      };
    },
    async markIntegrationOutboxDelivered(payload) {
      calls.push(["markIntegrationOutboxDelivered", payload]);
      const record = state.outbox.get(payload.outboxId);
      if (state.failNextOutboxMark || state.failOutboxMarkTypes.has(record?.type)) {
        state.failNextOutboxMark = false;
        if (record?.type) state.failOutboxMarkTypes.delete(record.type);
        const error = new Error("mark delivery failed");
        error.code = "OUTBOX_MARK_FAILED";
        throw error;
      }
      if (!record || record.runId !== payload.runId || record.expectedEventHash !== payload.eventHash) {
        const error = new Error("outbox conflict");
        error.code = "OUTBOX_CONFLICT";
        throw error;
      }
      record.delivered = true;
      record.deliveredEventHash = payload.eventHash;
      return { delivered: true, outboxId: payload.outboxId };
    },
    async listIntegrationArtifacts(payload) {
      calls.push(["listIntegrationArtifacts", payload]);
      return {
        artifacts: [...state.artifacts.values()].filter(
          (artifact) =>
            artifact.published === true &&
            artifact.principalId === payload.principalId &&
            artifact.browserSessionId === payload.browserSessionId &&
            (!payload.threadId || artifact.threadId === payload.threadId) &&
            (!payload.runId || artifact.runId === payload.runId)
        ),
      };
    },
    async getIntegrationArtifact(payload) {
      calls.push(["getIntegrationArtifact", payload]);
      const artifact = state.artifacts.get(payload.artifactId);
      return {
        artifact:
          artifact?.published === true &&
          artifact.principalId === payload.principalId &&
          artifact.browserSessionId === payload.browserSessionId
            ? artifact
            : null,
      };
    },
    async stageIntegrationArtifactOutbox(payload) {
      calls.push(["stageIntegrationArtifactOutbox", payload]);
      const artifact = plotArtifact({
        ...payload.artifact,
        principalId: payload.principalId,
        browserSessionId: payload.browserSessionId,
        threadId: payload.threadId,
        runId: payload.runId,
        published: false,
      });
      state.artifacts.set(artifact.id, artifact);
      return { artifact };
    },
    async publishIntegrationArtifactOutbox(payload) {
      calls.push(["publishIntegrationArtifactOutbox", payload]);
      const artifact = state.artifacts.get(payload.artifactId);
      if (artifact) artifact.published = true;
      return { artifact };
    },
  };
  const repository = inheritedForbidden ? Object.create({ plan() {} }) : {};
  for (const [key, value] of Object.entries(methods)) {
    Object.defineProperty(repository, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value,
    });
  }
  return { repository: Object.freeze(repository), calls, state };
}

function makeEventLedgerStore({
  appendProof = false,
  substituteAppend = false,
  badZeroHead = false,
  omitAppendByOutboxId = false,
  omitLookupByOutboxId = false,
  proofAppendByOutboxId,
  proofLookupByOutboxId,
  failAppends = 0,
  extraPublicEventField = false,
  corruptLookupByOutboxId = false,
  onLoadEventsAfter = null,
} = {}) {
  const ledgers = new Map();
  const byOutboxId = new Map();
  let remainingAppendFailures = failAppends;
  const store = {
    owner: "aginti",
    authority: "aginti",
    mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
    durable: true,
    persisted: true,
    contiguous: true,
    monotonic: true,
    bridgeOwned: false,
    appendPublicEvent(scope, eventInput) {
      if (remainingAppendFailures > 0) {
        remainingAppendFailures -= 1;
        throw new Error("append failed");
      }
      const key = scope.runId;
      const events = ledgers.get(key) || [];
      const previousHash = events.length ? events[events.length - 1].hash : ZERO_DIGEST;
      let event = createPublicIntegrationEvent({
        threadId: scope.threadId,
        runId: scope.runId,
        seq: events.length + 1,
        type: substituteAppend && eventInput.type === "output.delta" ? "run.status" : eventInput.type,
        payload: substituteAppend && eventInput.type === "output.delta" ? { status: "running" } : eventInput.payload,
        createdAt: eventInput.createdAt || now(),
        previousHash,
      });
      if (extraPublicEventField) event = Object.freeze({ ...event, raw: "private" });
      events.push(event);
      ledgers.set(key, events);
      return event;
    },
    appendByOutboxId(scope, eventInput) {
      const existing = byOutboxId.get(eventInput.outboxId);
      if (existing) return existing;
      const key = scope.runId;
      const events = ledgers.get(key) || [];
      const previousHash = events.length ? events[events.length - 1].hash : ZERO_DIGEST;
      assert.equal(previousHash, eventInput.expectedPreviousHash);
      assert.equal(events.length, eventInput.expectedPreviousSeq);
      const event = createPublicIntegrationEvent({
        threadId: scope.threadId,
        runId: scope.runId,
        seq: events.length + 1,
        type: eventInput.type,
        payload: eventInput.payload,
        createdAt: eventInput.createdAt,
        previousHash,
      });
      assert.equal(event.hash, eventInput.expectedEventHash);
      const stored = event;
      events.push(stored);
      ledgers.set(key, events);
      byOutboxId.set(eventInput.outboxId, stored);
      return stored;
    },
    lookupByOutboxId(_scope, input) {
      if (corruptLookupByOutboxId) {
        return createPublicIntegrationEvent({
          threadId: _scope.threadId,
          runId: _scope.runId,
          seq: 1,
          type: "run.status",
          payload: { status: "running" },
          createdAt: now(),
          previousHash: ZERO_DIGEST,
        });
      }
      return byOutboxId.get(input.outboxId) || null;
    },
    ledgerForRun(scope) {
      return {
        owner: "aginti",
        authority: "aginti",
        mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
        durable: true,
        persisted: true,
        contiguous: true,
        monotonic: true,
        bridgeOwned: false,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        browserSessionPolicy: "same-browser-session",
        threadId: scope.threadId,
        runId: scope.runId,
        async loadHead() {
          const events = ledgers.get(scope.runId) || [];
          if (!events.length && badZeroHead) return { seq: 0, hash: "1".repeat(64) };
          return events.length ? { seq: events.at(-1).seq, hash: events.at(-1).hash } : { seq: 0, hash: ZERO_DIGEST };
        },
        async loadCursor(seq) {
          if (seq === 0) return { seq: 0, hash: ZERO_DIGEST };
          return (ledgers.get(scope.runId) || []).find((event) => event.seq === seq) || null;
        },
        async loadEventsAfter(afterSeq) {
          if (typeof onLoadEventsAfter === "function") onLoadEventsAfter({ runId: scope.runId, afterSeq });
          return (ledgers.get(scope.runId) || []).filter((event) => event.seq > afterSeq);
        },
      };
    },
    eventsForRun(runId) {
      return [...(ledgers.get(runId) || [])];
    },
  };
  if (omitAppendByOutboxId) delete store.appendByOutboxId;
  if (omitLookupByOutboxId) delete store.lookupByOutboxId;
  if (appendProof) {
    const appendByOutboxId =
      proofAppendByOutboxId === undefined ? !omitAppendByOutboxId : proofAppendByOutboxId === true;
    const lookupByOutboxId =
      proofLookupByOutboxId === undefined ? !omitLookupByOutboxId : proofLookupByOutboxId === true;
    Object.defineProperty(store, INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: seal({
        schemaVersion: INTEGRATION_EVENT_APPEND_ATTESTATION_VERSION,
        owner: "aginti",
        authority: "aginti",
        appendPublicEvent: true,
        appendByOutboxId,
        lookupByOutboxId,
        terminalFinality: true,
        durable: true,
        persisted: true,
        monotonic: true,
      }),
    });
  }
  return Object.freeze(store);
}

function makeSandboxAttestation() {
  return seal({
    schemaVersion: INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    valid: true,
    enabled: true,
    isolationAttestation: fullIsolationAttestation(),
  });
}

function makeMutableNestedSandboxAttestation(isolationAttestation) {
  return sealShallow({
    schemaVersion: INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    valid: true,
    enabled: true,
    isolationAttestation,
  });
}

function makeBadDigestSandboxAttestation(isolationAttestation) {
  return Object.freeze({
    schemaVersion: INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    valid: true,
    enabled: true,
    isolationAttestation,
    digest: ZERO_DIGEST,
  });
}

function makeCancellationAttestation() {
  return seal({
    schemaVersion: INTEGRATION_RUNTIME_CANCELLATION_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    abortControllerBound: true,
    exactRunOnly: true,
    browserSessionBound: true,
    cancellation: true,
  });
}

function makeAuthority({
  retained = false,
  appendProof = false,
  substituteAppend = false,
  badZeroHead = false,
  roots = runtimeRoots(),
  ledgerOptions = {},
  sandboxAttestation,
} = {}) {
  const repo = makeRepository({ retainedDescriptorStorageAuthority: retained, roots });
  const ledger = makeEventLedgerStore({ appendProof, substituteAppend, badZeroHead, ...ledgerOptions });
  const authority = createAgintiIntegrationRuntimeAuthority({
    threadSessionRepository: repo.repository,
    eventLedgerStore: ledger,
    cancellationAttestation: appendProof ? makeCancellationAttestation() : undefined,
    hardenedSandboxAttestation: appendProof ? sandboxAttestation || makeSandboxAttestation() : undefined,
  });
  return { authority, repo, ledger };
}

function context(overrides = {}) {
  return {
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    policy: buildFixedIntegrationPolicy(),
    ...overrides,
  };
}

function errorSummary(error) {
  return [
    `name=${String(error?.name || "")}`,
    `code=${String(error?.code || "")}`,
    `publicCode=${String(error?.publicCode || "")}`,
    `status=${String(error?.status || error?.statusCode || "")}`,
    `message=${String(error?.message || error)}`,
    error?.stack ? `stack=${error.stack}` : "",
  ].filter(Boolean).join("\n");
}

async function expectCode(action, code) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
    if (error?.code === code || error?.publicCode === code) return error;
  }
  if (!captured) {
    assert.fail(`Expected ${code} rejection, but the action completed successfully.`);
  }
  assert.fail(`Expected ${code} rejection, but received:\n${errorSummary(captured)}`);
}

async function expectAuthorityError(action, { code, status }) {
  const captured = await expectCode(action, code);
  if (status !== undefined) {
    assert.equal(captured.status, status);
    assert.equal(captured.statusCode, status);
  }
  return captured;
}

async function writeNativeState(config, state) {
  const sessionDir = path.join(config.sessionsDir, config.sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function prepareCompletedOutputBundle(fixture, { title, runId, output = "Recovered output." }) {
  const thread = (await fixture.authority.createIntegrationThread({ title }, context())).thread;
  const rawRun = runRecord({
    id: runId,
    threadId: thread.id,
    nativeSessionId: fixture.repo.state.threads.get(thread.id).nativeSessionId,
    status: "running",
    revision: 2,
    output: "",
    completedAt: null,
  });
  fixture.repo.state.runs.set(rawRun.id, rawRun);
  const completedAt = now();
  const classification = classifyRunAgentResult(
    { sessionId: rawRun.nativeSessionId, ok: true, result: output, persistedRuntimeRevision: 2 },
    { nativeSessionId: rawRun.nativeSessionId }
  );
  const result = await fixture.repo.repository.finishIntegrationRunWithOutbox({
    runId: rawRun.id,
    threadId: rawRun.threadId,
    nativeSessionId: rawRun.nativeSessionId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: 2,
    expectedNativeRuntimeRevision: 1,
    completedNativeRuntimeRevision: 2,
    status: "completed",
    output: classification.output,
    error: null,
    completedAt,
    processOwner: fakeProcessOwner(completedAt),
    expectedCursor: { firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 },
    outputEvent: outputEventForRunResult(classification, { createdAt: completedAt }),
    terminalEvent: { type: "run.completed", payload: {}, createdAt: completedAt },
    resultDigest: classification.digest,
  });
  const [outputRecord, terminalRecord] = result.outboxEvents;
  assert.equal(outputRecord.type, "output.delta");
  assert.equal(terminalRecord.type, "run.completed");
  return { thread, run: result.run, outputRecord, terminalRecord };
}

async function prepareReceiptBearingRun(fixture, { title = "Receipt hold candidate", input = "Authorize" } = {}) {
  const thread = (await fixture.authority.createIntegrationThread({ title }, context())).thread;
  fixture.repo.state.failAuthorizeAfterCommit = true;
  await expectAuthorityError(
    () => fixture.authority.startIntegrationRun({ threadId: thread.id, input: { text: input } }, context()),
    { code: "NATIVE_START_AUTHORIZATION_ACK_LOST" }
  );
  const run = [...fixture.repo.state.runs.values()].find((candidate) => candidate.threadId === thread.id);
  assert.ok(run.nativeStartReceipt);
  assert.equal(run.status, "running");
  assert.equal(run.revision, 3);
  assert.equal(run.recoveryState, null);
  assertNoPreLaunchTerminalSideEffects(fixture, run.id);
  return { thread, run };
}

async function publishOutboxRecordOnly(fixture, scope, record) {
  const event = await fixture.ledger.appendByOutboxId(scope, {
    outboxId: record.outboxId,
    type: record.type,
    payload: record.payload || {},
    createdAt: record.createdAt,
    expectedPreviousSeq: record.expectedPreviousSeq,
    expectedPreviousHash: record.expectedPreviousHash,
    expectedEventHash: record.expectedEventHash,
  });
  await fixture.repo.repository.markIntegrationOutboxDelivered({
    outboxId: record.outboxId,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    threadId: scope.threadId,
    runId: scope.runId,
    eventSeq: event.seq,
    eventHash: event.hash,
    eventDigest: contractDigest(event),
  });
  return event;
}

function attachCompletionMetadata(fixture, run, records, cursor = { firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 }) {
  const thread = fixture.repo.state.threads.get(run.threadId);
  run.authority = {
    ...run.authority,
    completionOutbox: completionOutboxMetadata({ run, thread, records, cursor }),
  };
}

function callsNamed(fixture, name) {
  return fixture.repo.calls.filter(([callName]) => callName === name);
}

function lastCallPayload(fixture, name) {
  const calls = callsNamed(fixture, name);
  return calls.length ? calls.at(-1)[1] : null;
}

function assertNoPreLaunchTerminalSideEffects(fixture, runId) {
  assert.equal(callsNamed(fixture, "finishIntegrationRunWithOutbox").length, 0);
  assert.equal(callsNamed(fixture, "markIntegrationOutboxDelivered").length, 0);
  assert.equal(fixture.repo.state.outbox.size, 0);
  assert.equal(fixture.ledger.eventsForRun(runId).length, 0);
}

function assertRecoveryHoldApplied(fixture, { threadId, runId, sourceRunRevision = 3 }) {
  const thread = fixture.repo.state.threads.get(threadId);
  const run = fixture.repo.state.runs.get(runId);
  assert.equal(run.status, "running");
  assert.equal(run.hidden, false);
  assert.equal(run.tombstone, false);
  assert.equal(run.completedAt, null);
  assert.equal(run.output, "");
  assert.equal(run.error, null);
  assert.ok(run.nativeStartReceipt);
  assert.equal(run.revision, sourceRunRevision + 1);
  assert.equal(thread.status, "running");
  assert.equal(thread.lastRunId, run.id);
  assert.equal(thread.nativeSessionId, run.nativeSessionId);
  assert.equal(threadPreservationDigestFor(thread), run.nativeStartReceipt.threadPreservationDigest);
  assert.deepEqual(Object.keys(run.recoveryState), [
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
  assert.equal(run.recoveryState.schemaVersion, NATIVE_START_RECOVERY_STATE_VERSION);
  assert.equal(run.recoveryState.status, "recovery_hold");
  assert.equal(run.recoveryState.reason, "retained_descriptor_unavailable");
  assert.equal(run.recoveryState.authorizationId, run.nativeStartReceipt.authorizationId);
  assert.equal(run.recoveryState.authorizationDigest, run.nativeStartReceipt.authorizationDigest);
  assert.equal(run.recoveryState.sourceRunRevision, sourceRunRevision);
  assert.equal(run.recoveryState.appliedRunRevision, sourceRunRevision + 1);
  assert.equal(run.recoveryState.digest, recoveryStateDigestFor(run.recoveryState));
  assertNoPreLaunchTerminalSideEffects(fixture, runId);
}

function snapshotThreadMutationGuard(fixture, threadId) {
  const thread = fixture.repo.state.threads.get(threadId);
  return Object.freeze({
    title: thread.title,
    revision: thread.revision,
    digest: threadPreservationDigestFor(thread),
    raw: cloneJson(thread),
  });
}

function assertThreadMutationGuardUnchanged(fixture, threadId, guard) {
  const thread = fixture.repo.state.threads.get(threadId);
  assert.equal(thread.title, guard.title);
  assert.equal(thread.revision, guard.revision);
  assert.equal(threadPreservationDigestFor(thread), guard.digest);
  assert.deepEqual(thread, guard.raw);
}

function assertPreLaunchAbortApplied(fixture, { threadId, runId, previousRunId = null, expectedRuntimeRevision = 1, dispatched = false }) {
  const thread = fixture.repo.state.threads.get(threadId);
  const run = fixture.repo.state.runs.get(runId);
  assert.equal(run.hidden, true);
  assert.equal(run.tombstone, true);
  assert.equal(run.status, "aborted_before_launch");
  assert.equal(run.completedAt, null);
  assert.equal(run.startedAt, run.createdAt);
  assert.equal(run.nativeStartReceipt, null);
  assert.equal(run.output, "");
  assert.equal(run.error, null);
  assert.equal(run.authority.runtimeRevision, expectedRuntimeRevision);
  assert.equal(run.revision, dispatched ? 3 : 2);
  assert.equal(thread.lastRunId, previousRunId);
  assert.equal(thread.status, "idle");
  assert.equal(thread.nativeSessionId, run.nativeSessionId);
  assert.equal(thread.authority.runtimeRevision, expectedRuntimeRevision);
  assert.equal(thread.authority.contextDigest, CONTEXT_DIGEST);
  assert.deepEqual(thread.messages, []);
  assert.equal(dispatched ? run.dispatchLeaseId !== null : run.dispatchLeaseId === null, true);
  assertNoPreLaunchTerminalSideEffects(fixture, runId);
}

async function assertHiddenRunNotPublic(fixture, runId) {
  await expectCode(() => fixture.authority.getIntegrationRunStatus({ runId }, context()), "NOT_FOUND");
}

async function main() {
  SMOKE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-integration-runtime-authority-"));
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let finalSmokeOk = false;
  const finalSmokeWatchdog = setTimeout(() => {
    if (!finalSmokeOk) {
      process.stderr.write("integration runtime authority smoke: failed (TIMEOUT)\n");
      process.stderr.write("integration runtime authority smoke did not reach final ok marker\n");
      throw new Error("integration runtime authority smoke timed out before final ok marker");
    }
  }, 60_000);
  try {
    const withRevision = (result, persistedRuntimeRevision = 1) => ({ ...result, persistedRuntimeRevision });
    assert.equal(classifyRunAgentResult(withRevision({ sessionId: "aginti:one", ok: true, result: "Direct answer." }), { nativeSessionId: "aginti:one" }).status, "completed");
    assert.equal(classifyRunAgentResult(withRevision({ sessionId: "aginti:one", stopped: true, reason: "user_interrupt" }), { nativeSessionId: "aginti:one" }).status, "cancelled");
    assert.equal(classifyRunAgentResult(withRevision({ sessionId: "aginti:one", ok: false, reason: "provider_error" }), { nativeSessionId: "aginti:one" }).status, "failed");
    assert.equal(classifyRunAgentResult(withRevision({ sessionId: "aginti:one", stopped: true, reason: "max_steps_reached" }), { nativeSessionId: "aginti:one" }).status, "failed");
    assert.equal(classifyRunAgentResult(withRevision({ sessionId: "aginti:one", stopped: true, reason: "model_timeout" }), { nativeSessionId: "aginti:one" }).status, "failed");
    assert.equal(classifyRunAgentResult(withRevision({ sessionId: "aginti:one", stopped: true, reason: "some_other_stop" }), { nativeSessionId: "aginti:one" }).status, "failed");
    assert.equal(classifyRunAgentResult(withRevision({ sessionId: "aginti:one", stopped: true, ok: false, reason: "user_interrupt" }), { nativeSessionId: "aginti:one" }).status, "failed");
    assert.throws(() => classifyRunAgentResult(withRevision({ sessionId: "aginti:two", ok: true }), { nativeSessionId: "aginti:one" }), /RUN_AGENT_SESSION_MISMATCH|sessionId/);
    const abortController = new AbortController();
    abortController.abort(new Error("cancelled"));
    const cancelledError = new Error("boom");
    cancelledError.persistedRuntimeRevision = 1;
    assert.equal(classifyRunAgentError(cancelledError, { abortSignal: abortController.signal }).status, "cancelled");
    const failedError = new Error("timeout");
    failedError.code = "MODEL_TIMEOUT";
    failedError.persistedRuntimeRevision = 2;
    const failedClassification = classifyRunAgentError(failedError, {});
    assert.equal(failedClassification.status, "failed");
    assert.equal(failedClassification.persistedRuntimeRevision, 2);
    const outputEvent = outputEventForRunResult(classifyRunAgentResult(withRevision({ sessionId: "aginti:one", ok: true, result: "Direct answer." }), { nativeSessionId: "aginti:one" }));
    assert.equal(outputEvent.payload.text, "Direct answer.");
    const projectedPathText = classifyRunAgentResult(
      withRevision({
        sessionId: "aginti:one",
        ok: true,
        result:
          "paths /scratch/a /nix/store/pkg /boot/vmlinuz /lib/libc.so /foo C:\\Users\\alice\\secret \\\\server\\share\\secret file:///tmp/secret keep 1/2 and https://example.test/a",
      }),
      { nativeSessionId: "aginti:one" }
    ).output;
    for (const token of ["/scratch", "/nix/store", "/boot", "/lib", "/foo", "C:\\Users", "\\\\server", "file:///tmp"]) {
      assert.equal(projectedPathText.includes(token), false);
    }
    assert.match(projectedPathText, /\[REDACTED_PATH\]/u);
    assert.match(projectedPathText, /1\/2/u);
    assert.match(projectedPathText, /https:\/\/example\.test\/a/u);
    const completionCreatedAt = now();
    const timedOutputEvent = outputEventForRunResult(
      classifyRunAgentResult(withRevision({ sessionId: "aginti:one", ok: true, result: "Direct answer." }), { nativeSessionId: "aginti:one" }),
      { createdAt: completionCreatedAt }
    );
    assert.equal(timedOutputEvent.createdAt, completionCreatedAt);
    assert.throws(
      () =>
        outputEventForRunResult(
          classifyRunAgentResult(withRevision({ sessionId: "aginti:one", ok: true, result: "Direct answer." }), { nativeSessionId: "aginti:one" }),
          { createdAt: "not-iso" }
        ),
      /createdAt|canonical/iu
    );

    const fixedPolicy = buildFixedIntegrationPolicy();
    const controller = new AbortController();
    const fixedConfig = buildFixedNativeRunAgentConfig({
      mode: "start",
      policy: fixedPolicy,
      nativeSessionId: "aginti:fixed",
      inputText: "Hello",
      abortSignal: controller.signal,
      onEvent() {},
      repositoryRoots: runtimeRoots(),
      expectedRuntimeRevision: 1,
    });
    assert.throws(() =>
      buildFixedNativeRunAgentConfig({
        mode: "start",
        policy: fixedPolicy,
        nativeSessionId: "aginti:no-revision",
        inputText: "Hello",
        abortSignal: controller.signal,
        onEvent() {},
        repositoryRoots: runtimeRoots(),
      })
    );
    const expected = buildFixedIntegrationRuntimeOverrides(fixedPolicy, { sessionId: "aginti:fixed" });
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(fixedConfig[key], value);
    assert.equal(fixedConfig.provider, "localllm");
    assert.equal(fixedConfig.allowWrapperTools, false);
    assert.equal(fixedConfig.allowMcpTools, false);
    assert.equal(fixedConfig.allowWebSearch, false);
    assert.equal(fixedConfig.packageInstallPolicy, "block");
    assert.equal(fixedConfig.dockerNetwork, "none");
    assert.throws(() => {
      fixedConfig.provider = "deepseek";
    });
    const thenable = Promise.reject(new Error("thenable should be sunk"));
    assert.throws(() =>
      buildFixedNativeRunAgentConfig({
        mode: "start",
        policy: fixedPolicy,
        nativeSessionId: "aginti:fixed",
        inputText: "Hello",
        abortSignal: controller.signal,
        onEvent() {},
        repositoryRoots: thenable,
        expectedRuntimeRevision: 1,
      })
    );
    await delay(0);

    const preflightRoots = runtimeRoots({
      sessionsDir: `${SMOKE_ROOT}/state/preflight-sessions`,
      baseDir: `${SMOKE_ROOT}/workspace-preflight`,
      commandCwd: `${SMOKE_ROOT}/workspace-preflight`,
    });
    const resumeController = new AbortController();
    const resumeConfig = buildFixedNativeRunAgentConfig({
      mode: "resume",
      policy: fixedPolicy,
      nativeSessionId: "aginti:resume",
      inputText: "Resume",
      abortSignal: resumeController.signal,
      onEvent() {},
      repositoryRoots: preflightRoots,
      expectedRuntimeRevision: 1,
    });
    const hostileStoredRuntime = {
      ...expectedFixedSessionRuntimeSnapshot(resumeConfig, 1),
      provider: "deepseek",
      routeProvider: "deepseek",
      mainProvider: "deepseek",
      spareProvider: "deepseek",
    };
    await writeNativeState(resumeConfig, {
      sessionId: resumeConfig.sessionId,
      meta: {
        integrationPolicyLock: resumeConfig.integrationPolicyLock,
        integrationPolicyFingerprint: resumeConfig.integrationPolicyFingerprint,
        integrationRuntimeRootsDigest: resumeConfig.integrationRuntimeRootsDigest,
        runtimeConfig: hostileStoredRuntime,
      },
    });
    await expectCode(() => preflightNativeSessionRuntime(resumeConfig), "SESSION_RUNTIME_TAKEOVER_BLOCKED");
    await writeNativeState(resumeConfig, {
      sessionId: resumeConfig.sessionId,
      meta: {
        integrationPolicyLock: resumeConfig.integrationPolicyLock,
        integrationPolicyFingerprint: resumeConfig.integrationPolicyFingerprint,
        integrationRuntimeRootsDigest: resumeConfig.integrationRuntimeRootsDigest,
        runtimeConfig: expectedFixedSessionRuntimeSnapshot(resumeConfig, 1),
      },
    });
    const preflight = await preflightNativeSessionRuntime(resumeConfig);
    assert.equal(preflight.expectedAfterRevision, 2);
    assert.equal(contractDigest(resumeConfig.runtimePatch), contractDigest(Object.fromEntries(Object.entries(resumeConfig.runtimePatch))));
    await writeNativeState(resumeConfig, {
      sessionId: resumeConfig.sessionId,
      meta: {
        integrationPolicyLock: resumeConfig.integrationPolicyLock,
        integrationPolicyFingerprint: resumeConfig.integrationPolicyFingerprint,
        integrationRuntimeRootsDigest: resumeConfig.integrationRuntimeRootsDigest,
        runtimeConfig: expectedFixedSessionRuntimeSnapshot(resumeConfig, 2),
      },
    });
    assert.equal((await postflightNativeSessionRuntime(resumeConfig, preflight)).revision, 2);

    const missingLockConfig = buildFixedNativeRunAgentConfig({
      mode: "resume",
      policy: fixedPolicy,
      nativeSessionId: "aginti:missing-lock",
      inputText: "Resume",
      abortSignal: new AbortController().signal,
      onEvent() {},
      repositoryRoots: runtimeRoots({
        sessionsDir: `${SMOKE_ROOT}/state/missing-lock-sessions`,
        baseDir: `${SMOKE_ROOT}/workspace-missing-lock`,
        commandCwd: `${SMOKE_ROOT}/workspace-missing-lock`,
      }),
      expectedRuntimeRevision: 1,
    });
    await writeNativeState(missingLockConfig, {
      sessionId: missingLockConfig.sessionId,
      meta: { runtimeConfig: expectedFixedSessionRuntimeSnapshot(missingLockConfig, 1) },
    });
    await expectCode(() => preflightNativeSessionRuntime(missingLockConfig), "SESSION_RUNTIME_TAKEOVER_BLOCKED");

    const startConfig = buildFixedNativeRunAgentConfig({
      mode: "start",
      policy: fixedPolicy,
      nativeSessionId: "aginti:start-existing",
      inputText: "Start",
      abortSignal: new AbortController().signal,
      onEvent() {},
      repositoryRoots: runtimeRoots({
        sessionsDir: `${SMOKE_ROOT}/state/start-existing-sessions`,
        baseDir: `${SMOKE_ROOT}/workspace-start-existing`,
        commandCwd: `${SMOKE_ROOT}/workspace-start-existing`,
      }),
      expectedRuntimeRevision: 1,
    });
    await writeNativeState(startConfig, {
      sessionId: startConfig.sessionId,
      meta: {
        integrationPolicyLock: startConfig.integrationPolicyLock,
        integrationPolicyFingerprint: startConfig.integrationPolicyFingerprint,
        runtimeConfig: { ...expectedFixedSessionRuntimeSnapshot(startConfig, 1), provider: "deepseek" },
      },
    });
    await expectCode(() => preflightNativeSessionRuntime(startConfig), "SESSION_RUNTIME_TAKEOVER_BLOCKED");

    const fixture = makeAuthority();
    const { authority, repo, ledger } = fixture;
    for (const forbidden of ["plan", "summarize", "compactContext", "callModel", "completeWithModel", "executeDocker"]) {
      assert.equal(forbidden in authority, false);
    }
    assert.throws(
      () =>
        createAgintiIntegrationRuntimeAuthority({
          threadSessionRepository: repo.repository,
          eventLedgerStore: ledger,
          runAgentExecutor() {},
        }),
      /injected runAgentExecutor|AGENT_UNAVAILABLE|unavailable/iu
    );
    assert.throws(
      () =>
        createAgintiIntegrationRuntimeAuthority({
          threadSessionRepository: makeRepository({ inheritedForbidden: true }).repository,
          eventLedgerStore: ledger,
        }),
      /AGENT_UNAVAILABLE|unavailable|prototype/iu
    );
    const thenableLedger = Promise.reject(new Error("ledger thenable should be sunk"));
    assert.throws(
      () =>
        createAgintiIntegrationRuntimeAuthority({
          threadSessionRepository: repo.repository,
          eventLedgerStore: thenableLedger,
        }),
      /thenable|unavailable/iu
    );
    await delay(0);
    assert.throws(
      () =>
        createAgintiIntegrationRuntimeAuthority({
          threadSessionRepository: new Proxy(repo.repository, {}),
          eventLedgerStore: ledger,
        }),
      /Proxy|frozen object|unavailable/iu
    );
    assert.throws(
      () =>
        createAgintiIntegrationRuntimeAuthority({
          threadSessionRepository: repo.repository,
          eventLedgerStore: new Proxy(ledger, {}),
        }),
      /Proxy|frozen object|unavailable/iu
    );
    assert.throws(
      () =>
        createAgintiIntegrationRuntimeAuthority({
          threadSessionRepository: cloneFrozenWith(repo.repository, {
            extra: { enumerable: true, configurable: false, get() { return true; } },
          }),
          eventLedgerStore: ledger,
        }),
      /unsupported|unavailable/iu
    );
    assert.throws(
      () =>
        createAgintiIntegrationRuntimeAuthority({
          threadSessionRepository: cloneFrozenWith(repo.repository, {
            hidden: { enumerable: false, configurable: false, writable: false, value: true },
          }),
          eventLedgerStore: ledger,
        }),
      /unsupported|unavailable/iu
    );
    assert.throws(
      () =>
        createAgintiIntegrationRuntimeAuthority({
          threadSessionRepository: cloneFrozenWith(repo.repository, {
            [Symbol("extra")]: { enumerable: true, configurable: false, writable: false, value: true },
          }),
          eventLedgerStore: ledger,
        }),
      /unsupported|unavailable/iu
    );
    assert.throws(
      () =>
        createAgintiIntegrationRuntimeAuthority({
          threadSessionRepository: cloneFrozenWith(repo.repository, {}, { inheritedUnknown: true }),
          eventLedgerStore: ledger,
        }),
      /prototype|unavailable/iu
    );
    assert.throws(
      () =>
        createAgintiIntegrationRuntimeAuthority({
          threadSessionRepository: repo.repository,
          eventLedgerStore: cloneFrozenWith(ledger, {
            extra: { enumerable: true, configurable: false, writable: false, value: true },
          }),
        }),
      /unsupported|unavailable/iu
    );
    assert.throws(() => authority.getIntegrationRuntimeProof(), /Retained-descriptor|unavailable/iu);
    const proofFixture = makeAuthority({ retained: true, appendProof: true });
    const proof = proofFixture.authority.getIntegrationRuntimeProof();
    assert.equal(proof.noHostedProviders, true);
    assert.equal(proof.noWrappers, true);
    assert.equal(proof.noMcp, true);
    assert.equal(proof.noWeb, true);
    assert.equal(proof.publicArtifactsOnly, false);
    assert.throws(
      () => makeAuthority({ retained: true, appendProof: true, ledgerOptions: { omitLookupByOutboxId: true } }),
      /lookupByOutboxId|event ledger|event append|unavailable/iu
    );
    assert.throws(
      () => makeAuthority({ retained: true, appendProof: true, ledgerOptions: { proofLookupByOutboxId: false } }),
      /event append|unavailable/iu
    );
    assert.throws(
      () =>
        makeAuthority({
          retained: true,
          appendProof: true,
          ledgerOptions: {
            omitAppendByOutboxId: true,
            proofAppendByOutboxId: false,
            proofLookupByOutboxId: true,
          },
        }),
      /event append|unavailable/iu
    );
    assert.throws(
      () =>
        makeAuthority({
          retained: true,
          appendProof: true,
          ledgerOptions: { omitAppendByOutboxId: true, proofAppendByOutboxId: true },
        }).authority.getIntegrationRuntimeProof(),
      /event append|unavailable/iu
    );
    const thenableCancellation = Promise.reject(new Error("cancellation proof thenable should be sunk"));
    assert.throws(() =>
      createAgintiIntegrationRuntimeAuthority({
        threadSessionRepository: proofFixture.repo.repository,
        eventLedgerStore: proofFixture.ledger,
        cancellationAttestation: thenableCancellation,
        hardenedSandboxAttestation: makeSandboxAttestation(),
      }).getIntegrationRuntimeProof()
    );
    const thenableSandbox = Promise.reject(new Error("sandbox proof thenable should be sunk"));
    assert.throws(() =>
      createAgintiIntegrationRuntimeAuthority({
        threadSessionRepository: proofFixture.repo.repository,
        eventLedgerStore: proofFixture.ledger,
        cancellationAttestation: makeCancellationAttestation(),
        hardenedSandboxAttestation: thenableSandbox,
      }).getIntegrationRuntimeProof()
    );
    const thenableIsolation = Promise.reject(new Error("sandbox isolation thenable should be sunk"));
    assert.throws(() =>
      createAgintiIntegrationRuntimeAuthority({
        threadSessionRepository: proofFixture.repo.repository,
        eventLedgerStore: proofFixture.ledger,
        cancellationAttestation: makeCancellationAttestation(),
        hardenedSandboxAttestation: makeBadDigestSandboxAttestation(thenableIsolation),
      }).getIntegrationRuntimeProof()
    );
    await delay(0);
    assert.throws(
      () =>
        makeAuthority({
          retained: true,
          appendProof: true,
          ledgerOptions: { proofAppendByOutboxId: false },
        }).authority.getIntegrationRuntimeProof(),
      /event append|unavailable/iu
    );
    for (const missingRecoveryProof of ["receiptRecoveryHold", "exactReconciliationResults"]) {
      const recoveryProofFixture = makeAuthority();
      const baseProof = recoveryProofFixture.repo.repository[INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY];
      const { digest: _baseDigest, ...unsignedProof } = baseProof;
      const descriptors = Object.getOwnPropertyDescriptors(recoveryProofFixture.repo.repository);
      descriptors[INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY] = {
        value: seal({
          ...unsignedProof,
          [missingRecoveryProof]: false,
        }),
        enumerable: true,
        writable: false,
        configurable: false,
      };
      const badRepository = Object.freeze(Object.defineProperties({}, descriptors));
      assert.throws(
        () =>
          createAgintiIntegrationRuntimeAuthority({
            threadSessionRepository: badRepository,
            eventLedgerStore: recoveryProofFixture.ledger,
          }),
        /repository attestation|unavailable/iu
      );
    }
    const mutableIsolation = mutableIsolationAttestation();
    const mutableSandboxFixture = makeAuthority({
      retained: true,
      appendProof: true,
      sandboxAttestation: makeMutableNestedSandboxAttestation(mutableIsolation),
    });
    const issuedProof = mutableSandboxFixture.authority.getIntegrationRuntimeProof();
    const issuedProofDigest = issuedProof.proofDigest;
    assert.equal(issuedProof.isolationAttestation.networkNone, true);
    mutableIsolation.networkNone = false;
    assert.equal(issuedProof.isolationAttestation.networkNone, true);
    assert.equal(issuedProof.proofDigest, issuedProofDigest);
    assert.equal(Object.isFrozen(issuedProof.isolationAttestation), true);
    assert.throws(() => {
      issuedProof.isolationAttestation.networkNone = false;
    });
    assert.throws(
      () =>
        makeAuthority({
          retained: true,
          appendProof: true,
          sandboxAttestation: makeMutableNestedSandboxAttestation(new Proxy(mutableIsolationAttestation(), {})),
        }).authority.getIntegrationRuntimeProof(),
      /Proxy|unavailable/iu
    );
    assert.throws(() => makeAuthority({ roots: runtimeRoots({ baseDir: "/" }) }), /root|system|unavailable/iu);
    assert.throws(
      () => makeAuthority({ roots: runtimeRoots({ baseDir: "/home/lachlan", commandCwd: "/home/lachlan" }) }),
      /shallow user|unavailable/iu
    );
    assert.throws(
      () => makeAuthority({ roots: runtimeRoots({ baseDir: "/Users/lachlan", commandCwd: "/Users/lachlan" }) }),
      /shallow user|unavailable/iu
    );
    assert.throws(
      () => makeAuthority({ roots: runtimeRoots({ baseDir: "/Volumes/lachlan", commandCwd: "/Volumes/lachlan" }) }),
      /shallow user|volume|unavailable/iu
    );
    const mutableRoots = {
      schemaVersion: NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
      sessionsDir: `${SMOKE_ROOT}/state/sessions`,
      baseDir: `${SMOKE_ROOT}/workspace`,
      commandCwd: `${SMOKE_ROOT}/workspace`,
      retainedDescriptor: true,
      symlinkFree: true,
      outsideForbiddenRoots: true,
    };
    mutableRoots.digest = contractDigest(mutableRoots);
    const mutableFixture = makeAuthority({ roots: mutableRoots });
    const sealedRoots = mutableFixture.repo.repository[INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY].runtimeRoots;
    assert.equal(Object.isFrozen(sealedRoots), true);
    assert.throws(() => {
      sealedRoots.baseDir = "/";
    });

    const created = await authority.createIntegrationThread({ title: "Native thread" }, context());
    const thread = created.thread;
    const rawThread = repo.state.threads.get(thread.id);
    assert.equal(rawThread.revision, 1);
    assert.ok(rawThread.nativeSessionId.startsWith("aginti:"));
    assert.equal("nativeSessionId" in thread, false);
    assert.equal(rawThread.authority.runtimeRevision, 1);
    assert.equal(repo.calls.some(([name]) => name === "reconcileIntegrationDispatches"), true);
    const reconcileCall = repo.calls.find(([name]) => name === "reconcileIntegrationDispatches")[1];
    assert.equal(reconcileCall.schemaVersion, DISPATCH_RECONCILIATION_VERSION);
    assert.equal(reconcileCall.requestDigest, reconciliationRequestDigestFor(reconcileCall));
    assert.deepEqual(reconcileCall.liveRunClaims, []);
    assert.equal(reconcileCall.processOwner.schemaVersion, "aginti-process-owner-v1");
    assert.ok(reconcileCall.processOwner.processIdentity.bootId);

    assert.deepEqual((await authority.listIntegrationThreads({ limit: 10 }, context())).threads.map((item) => item.id), [thread.id]);
    const missingRuntimeRevisionFixture = makeAuthority();
    const missingRuntimeThread = (await missingRuntimeRevisionFixture.authority.createIntegrationThread({ title: "Missing revision" }, context())).thread;
    missingRuntimeRevisionFixture.repo.state.threads.get(missingRuntimeThread.id).authority.runtimeRevision = null;
    await expectCode(
      () => missingRuntimeRevisionFixture.authority.getIntegrationThread({ threadId: missingRuntimeThread.id }, context()),
      "AGENT_UNAVAILABLE"
    );
    await expectCode(
      () => authority.getIntegrationThread({ threadId: thread.id }, context({ principalId: OTHER_PRINCIPAL })),
      "NOT_FOUND"
    );
    const updateCallsBefore = repo.calls.filter(([name]) => name === "updateIntegrationThread").length;
    await expectCode(
      () => authority.updateIntegrationThread({ threadId: thread.id, title: "Blocked" }, context({ browserSessionId: OTHER_BROWSER_SESSION })),
      "NOT_FOUND"
    );
    assert.equal(repo.calls.filter(([name]) => name === "updateIntegrationThread").length, updateCallsBefore);
    repo.state.failNextUpdate = true;
    await assert.rejects(() => authority.updateIntegrationThread({ threadId: thread.id, title: "Conflict" }, context()));
    const beforeNativeSessionId = rawThread.nativeSessionId;
    const updated = await authority.updateIntegrationThread({ threadId: thread.id, title: "Updated" }, context());
    assert.equal(updated.thread.title, "Updated");
    assert.equal(repo.state.threads.get(thread.id).revision, 2);
    assert.equal(repo.state.threads.get(thread.id).nativeSessionId, beforeNativeSessionId);

    const createBefore = makeAuthority();
    const createBeforeThread = (await createBefore.authority.createIntegrationThread({ title: "Create before" }, context())).thread;
    const createBeforeRawThread = createBefore.repo.state.threads.get(createBeforeThread.id);
    createBefore.repo.state.failCreateBeforeCommit = true;
    await assert.rejects(() => createBefore.authority.startIntegrationRun({ threadId: createBeforeThread.id, input: { text: "Create" } }, context()));
    assert.equal(createBefore.repo.state.runs.size, 0);
    assert.equal(createBeforeRawThread.lastRunId, null);
    assert.equal(createBeforeRawThread.status, "idle");
    assert.equal(createBeforeRawThread.revision, 1);
    assert.equal(lastCallPayload(createBefore, "abortIntegrationRunBeforeLaunch").attempt.dispatchAttempted, false);
    assert.equal(callsNamed(createBefore, "abortIntegrationRunBeforeLaunch").length, 1);
    assert.equal(callsNamed(createBefore, "finishIntegrationRunWithOutbox").length, 0);

    const createAfter = makeAuthority();
    const createAfterThread = (await createAfter.authority.createIntegrationThread({ title: "Create after" }, context())).thread;
    createAfter.repo.state.failCreateAfterCommit = true;
    await assert.rejects(() => createAfter.authority.startIntegrationRun({ threadId: createAfterThread.id, input: { text: "Create" } }, context()));
    const createAfterRun = [...createAfter.repo.state.runs.values()][0];
    assertPreLaunchAbortApplied(createAfter, { threadId: createAfterThread.id, runId: createAfterRun.id });
    await assertHiddenRunNotPublic(createAfter, createAfterRun.id);
    const createAfterAbortPayload = lastCallPayload(createAfter, "abortIntegrationRunBeforeLaunch");
    const createAfterAgain = await createAfter.repo.repository.abortIntegrationRunBeforeLaunch(createAfterAbortPayload);
    assert.equal(createAfterAgain.action, "already-aborted");
    assert.equal(createAfterAgain.idempotent, true);
    createAfter.repo.state.failNextDispatch = true;
    await assert.rejects(() => createAfter.authority.startIntegrationRun({ threadId: createAfterThread.id, input: { text: "Retry" } }, context()));
    assert.equal([...createAfter.repo.state.runs.values()].filter((run) => run.status === "aborted_before_launch").length, 2);

    for (const [flag, pattern] of [
      ["malformedCreateRun", /created run|id|unavailable/iu],
      ["malformedCreateThread", /updated thread|lastRunId|unavailable/iu],
      ["malformedDispatchRun", /dispatched run|native session|unavailable/iu],
      ["substituteDispatchThread", /dispatched run|thread|unavailable/iu],
    ]) {
      const malformed = makeAuthority();
      const malformedThread = (await malformed.authority.createIntegrationThread({ title: `Malformed ${flag}` }, context())).thread;
      malformed.repo.state[flag] = true;
      await assert.rejects(
        () => malformed.authority.startIntegrationRun({ threadId: malformedThread.id, input: { text: flag } }, context()),
        (error) => pattern.test(`${error?.code || ""} ${error?.message || ""}`)
      );
      const malformedRun = [...malformed.repo.state.runs.values()][0];
      assertPreLaunchAbortApplied(malformed, {
        threadId: malformedThread.id,
        runId: malformedRun.id,
        dispatched: flag === "malformedDispatchRun" || flag === "substituteDispatchThread",
      });
    }

    const dispatchBefore = makeAuthority();
    const dispatchBeforeThread = (await dispatchBefore.authority.createIntegrationThread({ title: "Dispatch before" }, context())).thread;
    dispatchBefore.repo.state.failNextDispatch = true;
    await assert.rejects(() => dispatchBefore.authority.startIntegrationRun({ threadId: dispatchBeforeThread.id, input: { text: "Dispatch" } }, context()));
    const dispatchBeforeRun = [...dispatchBefore.repo.state.runs.values()][0];
    assert.equal(lastCallPayload(dispatchBefore, "abortIntegrationRunBeforeLaunch").attempt.dispatchAttempted, true);
    assertPreLaunchAbortApplied(dispatchBefore, { threadId: dispatchBeforeThread.id, runId: dispatchBeforeRun.id, dispatched: false });

    const dispatchAfter = makeAuthority();
    const dispatchAfterThread = (await dispatchAfter.authority.createIntegrationThread({ title: "Dispatch after" }, context())).thread;
    dispatchAfter.repo.state.failDispatchAfterCommit = true;
    await assert.rejects(() => dispatchAfter.authority.startIntegrationRun({ threadId: dispatchAfterThread.id, input: { text: "Dispatch" } }, context()));
    const dispatchAfterRun = [...dispatchAfter.repo.state.runs.values()][0];
    assertPreLaunchAbortApplied(dispatchAfter, { threadId: dispatchAfterThread.id, runId: dispatchAfterRun.id, dispatched: true });

    const attachedThreadUpdateBlocked = makeAuthority();
    const attachedThreadUpdateThread = (await attachedThreadUpdateBlocked.authority.createIntegrationThread({ title: "Attached thread update" }, context())).thread;
    const attachedNativeSessionId = attachedThreadUpdateBlocked.repo.state.threads.get(attachedThreadUpdateThread.id).nativeSessionId;
    const attachedReadBlocked = createGate();
    const attachedAllowRead = createGate();
    const attachedFinishFailed = createGate();
    const originalAttachedReadFile = fs.readFile;
    let attachedReadIntercepts = 0;
    let attachedRejectRead = false;
    let attachedFinishAttempts = 0;
    fs.readFile = async function attachedThreadUpdateReadFile(target, ...args) {
      const targetPath = String(target);
      if (
        attachedReadIntercepts === 0 &&
        targetPath === path.join(SMOKE_ROOT, "state/sessions", attachedNativeSessionId, "state.json")
      ) {
        attachedReadIntercepts += 1;
        attachedReadBlocked.resolve();
        await attachedAllowRead.promise;
        if (attachedRejectRead) {
          const error = new Error("attached thread update worker cancelled before provider preflight");
          error.code = "CANCELLED";
          error.persistedRuntimeRevision = 1;
          throw error;
        }
      }
      return Reflect.apply(originalAttachedReadFile, this, [target, ...args]);
    };
    try {
      const attachedStartPromise = attachedThreadUpdateBlocked.authority
        .startIntegrationRun(
          { threadId: attachedThreadUpdateThread.id, input: { text: "Attached update block" } },
          context()
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error })
        );
      await waitForGate(attachedReadBlocked, "attached thread update native preflight read");
      const attachedStartOutcome = await waitForPromise(attachedStartPromise, "attached thread update start response");
      if (attachedStartOutcome.error) throw attachedStartOutcome.error;
      const attachedRun = [...attachedThreadUpdateBlocked.repo.state.runs.values()][0];
      assert.equal(attachedStartOutcome.value.run.id, attachedRun.id);
      assert.equal(attachedRun.status, "running");
      assert.equal(attachedRun.revision, 3);
      assert.ok(attachedRun.nativeStartReceipt);
      const attachedGuard = snapshotThreadMutationGuard(attachedThreadUpdateBlocked, attachedThreadUpdateThread.id);
      const attachedActiveCalls = callsNamed(attachedThreadUpdateBlocked, "getActiveIntegrationRunForThread").length;
      const attachedUpdateCalls = callsNamed(attachedThreadUpdateBlocked, "updateIntegrationThread").length;
      await expectCode(
        () => attachedThreadUpdateBlocked.authority.updateIntegrationThread(
          { threadId: attachedThreadUpdateThread.id, title: "Should not update attached" },
          context()
        ),
        "RUN_CONFLICT"
      );
      assert.equal(callsNamed(attachedThreadUpdateBlocked, "getActiveIntegrationRunForThread").length, attachedActiveCalls);
      assert.equal(callsNamed(attachedThreadUpdateBlocked, "updateIntegrationThread").length, attachedUpdateCalls);
      assertThreadMutationGuardUnchanged(attachedThreadUpdateBlocked, attachedThreadUpdateThread.id, attachedGuard);
      const attachedSuccessfulCancelMarksBefore = attachedThreadUpdateBlocked.repo.state.successfulCancelMarks;
      const concurrentCancels = await Promise.allSettled([
        attachedThreadUpdateBlocked.authority.cancelIntegrationRun({ runId: attachedRun.id }, context()),
        attachedThreadUpdateBlocked.authority.cancelIntegrationRun({ runId: attachedRun.id }, context()),
      ]);
      const fulfilledCancels = concurrentCancels.filter((result) => result.status === "fulfilled");
      const rejectedCancels = concurrentCancels.filter((result) => result.status === "rejected");
      assert.ok(fulfilledCancels.length >= 1);
      for (const result of fulfilledCancels) {
        assert.equal(result.value.run.id, attachedRun.id);
      }
      for (const result of rejectedCancels) {
        assert.equal(result.reason?.code || result.reason?.publicCode, "REVISION_CONFLICT");
      }
      assert.equal(attachedRun.cancelRequestedAt !== null, true);
      assert.equal(attachedRun.revision, 4);
      const attachedCancelTimestamp = attachedRun.cancelRequestedAt;
      assert.equal(attachedThreadUpdateBlocked.repo.state.successfulCancelMarks, attachedSuccessfulCancelMarksBefore + 1);
      const attachedCancelRetry = await attachedThreadUpdateBlocked.authority.cancelIntegrationRun({ runId: attachedRun.id }, context());
      assert.equal(attachedCancelRetry.run.id, attachedRun.id);
      assert.equal(attachedRun.cancelRequestedAt, attachedCancelTimestamp);
      assert.equal(attachedRun.revision, 4);
      assert.equal(attachedThreadUpdateBlocked.repo.state.successfulCancelMarks, attachedSuccessfulCancelMarksBefore + 1);
      attachedThreadUpdateBlocked.repo.state.failFinishBeforeCommitCount = 1;
      attachedThreadUpdateBlocked.repo.state.onFinishBeforeCommit = async ({ payload }) => {
        attachedFinishAttempts += 1;
        assert.equal(payload.runId, attachedRun.id);
        assert.equal(payload.expectedRevision, 4);
      };
      attachedThreadUpdateBlocked.repo.state.onFinishBeforeCommitFailure = async ({ remaining }) => {
        if (remaining === 0) attachedFinishFailed.resolve();
      };
      attachedRejectRead = true;
      attachedAllowRead.resolve();
      await waitForGate(attachedFinishFailed, "attached thread update finish failure");
      await delay(0);
      let recoveryError = null;
      for (let attempt = 0; attempt < 100 && !recoveryError; attempt += 1) {
        try {
          await attachedThreadUpdateBlocked.authority.getIntegrationRunStatus({ runId: attachedRun.id }, context());
        } catch (error) {
          if (error?.code === "RECOVERY_HOLD" || error?.publicCode === "RECOVERY_HOLD") recoveryError = error;
          else throw error;
        }
        if (!recoveryError) await delay(10);
      }
      assert.ok(recoveryError, "attached thread update worker did not release into recovery hold");
      assert.equal(recoveryError.status, 503);
      assert.equal(recoveryError.statusCode, 503);
      assert.equal(attachedFinishAttempts, 1);
      assert.equal(attachedRun.status, "running");
      assert.equal(attachedRun.revision, 5);
      assert.equal(attachedRun.completedAt, null);
      assert.equal(attachedRun.output, "");
      assert.equal(attachedRun.error, null);
      assert.equal(attachedRun.recoveryState.sourceRunRevision, 4);
      assert.equal(attachedRun.recoveryState.appliedRunRevision, 5);
      assert.equal(attachedRun.recoveryState.digest, recoveryStateDigestFor(attachedRun.recoveryState));
      assert.equal(attachedThreadUpdateBlocked.repo.state.outbox.size, 0);
      assert.equal(attachedThreadUpdateBlocked.ledger.eventsForRun(attachedRun.id).length, 0);
      assertThreadMutationGuardUnchanged(attachedThreadUpdateBlocked, attachedThreadUpdateThread.id, attachedGuard);
    } finally {
      fs.readFile = originalAttachedReadFile;
      attachedAllowRead.resolve();
      attachedThreadUpdateBlocked.repo.state.onFinishBeforeCommit = null;
      attachedThreadUpdateBlocked.repo.state.onFinishBeforeCommitFailure = null;
      attachedThreadUpdateBlocked.repo.state.failFinishBeforeCommitCount = 0;
    }

    const claimFailure = makeAuthority();
    const claimFailureThread = (await claimFailure.authority.createIntegrationThread({ title: "Claim failure" }, context())).thread;
    const OriginalAbortController = globalThis.AbortController;
    class ClaimRejectingAbortController extends OriginalAbortController {
      constructor() {
        super();
        Object.defineProperty(this, "abort", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: null,
        });
      }
    }
    globalThis.AbortController = ClaimRejectingAbortController;
    try {
      await expectCode(
        () => claimFailure.authority.startIntegrationRun({ threadId: claimFailureThread.id, input: { text: "Claim" } }, context()),
        "AGENT_UNAVAILABLE"
      );
    } finally {
      globalThis.AbortController = OriginalAbortController;
    }
    const claimFailureRun = [...claimFailure.repo.state.runs.values()][0];
    assert.equal(callsNamed(claimFailure, "authorizeIntegrationRunNativeStart").length, 0);
    assert.equal(callsNamed(claimFailure, "abortIntegrationRunBeforeLaunch").length, 1);
    assertPreLaunchAbortApplied(claimFailure, { threadId: claimFailureThread.id, runId: claimFailureRun.id, dispatched: true });

    const attachFailure = makeAuthority();
    const attachFailureThread = (await attachFailure.authority.createIntegrationThread({ title: "Attach failure" }, context())).thread;
    const duplicatePromiseSpeciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
    const NativePromise = Promise;
    function ThrowingPromiseSpecies(executor) {
      if (String(new Error().stack || "").includes("integration-run-registry.js")) {
        throw new Error("species constructor must not attach");
      }
      return new NativePromise(executor);
    }
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      value: ThrowingPromiseSpecies,
    });
    try {
      await expectCode(
        () => attachFailure.authority.startIntegrationRun({ threadId: attachFailureThread.id, input: { text: "Attach" } }, context()),
        "AGENT_UNAVAILABLE"
      );
    } finally {
      if (duplicatePromiseSpeciesDescriptor) Object.defineProperty(Promise, Symbol.species, duplicatePromiseSpeciesDescriptor);
      else delete Promise[Symbol.species];
    }
    const attachFailureRun = [...attachFailure.repo.state.runs.values()][0];
    assert.equal(callsNamed(attachFailure, "authorizeIntegrationRunNativeStart").length, 0);
    assert.equal(callsNamed(attachFailure, "abortIntegrationRunBeforeLaunch").length, 1);
    assertPreLaunchAbortApplied(attachFailure, { threadId: attachFailureThread.id, runId: attachFailureRun.id, dispatched: true });

    const forgedDispatchReceipt = makeAuthority();
    const forgedDispatchReceiptThread = (await forgedDispatchReceipt.authority.createIntegrationThread({ title: "Forged dispatch receipt" }, context())).thread;
    forgedDispatchReceipt.repo.state.forgedDispatchNativeStartReceipt = true;
    await expectCode(
      () => forgedDispatchReceipt.authority.startIntegrationRun({ threadId: forgedDispatchReceiptThread.id, input: { text: "Receipt" } }, context()),
      "AGENT_UNAVAILABLE"
    );
    const forgedDispatchReceiptRun = [...forgedDispatchReceipt.repo.state.runs.values()][0];
    assert.equal(callsNamed(forgedDispatchReceipt, "authorizeIntegrationRunNativeStart").length, 0);
    assert.equal(callsNamed(forgedDispatchReceipt, "abortIntegrationRunBeforeLaunch").length, 0);
    assert.equal(forgedDispatchReceiptRun.status, "running");
    assert.equal(forgedDispatchReceiptRun.revision, 2);
    assert.equal(forgedDispatchReceiptRun.nativeStartReceipt, null);
    assertNoPreLaunchTerminalSideEffects(forgedDispatchReceipt, forgedDispatchReceiptRun.id);

    const authorizeBefore = makeAuthority();
    const authorizeBeforeThread = (await authorizeBefore.authority.createIntegrationThread({ title: "Authorize before commit" }, context())).thread;
    authorizeBefore.repo.state.failAuthorizeBeforeCommit = true;
    await expectCode(
      () => authorizeBefore.authority.startIntegrationRun({ threadId: authorizeBeforeThread.id, input: { text: "Authorize" } }, context()),
      "NATIVE_START_AUTHORIZATION_FAILED"
    );
    const authorizeBeforeRun = [...authorizeBefore.repo.state.runs.values()][0];
    assert.equal(callsNamed(authorizeBefore, "authorizeIntegrationRunNativeStart").length, 1);
    assert.equal(callsNamed(authorizeBefore, "abortIntegrationRunBeforeLaunch").length, 0);
    const authorizeBeforePayload = lastCallPayload(authorizeBefore, "authorizeIntegrationRunNativeStart");
    assert.equal(Object.isFrozen(authorizeBeforePayload), true);
    assert.equal(Object.isFrozen(authorizeBeforePayload.authorization), true);
    assert.equal(Object.isFrozen(authorizeBeforePayload.authorization.processOwner), true);
    assert.equal(Object.isFrozen(authorizeBeforePayload.authorization.processOwner.processIdentity), true);
    const originalAuthorizeOwnerToken = authorizeBeforePayload.authorization.processOwner.token;
    assert.notEqual(authorizeBeforePayload.authorization.processOwner, authorizeBeforeRun.processOwner);
    authorizeBeforeRun.processOwner = { ...authorizeBeforeRun.processOwner, token: "2".repeat(32) };
    assert.equal(authorizeBeforePayload.authorization.processOwner.token, originalAuthorizeOwnerToken);
    assert.equal(authorizeBeforeRun.status, "running");
    assert.equal(authorizeBeforeRun.revision, 2);
    assert.equal(authorizeBeforeRun.nativeStartReceipt, null);
    await delay(0);
    assertNoPreLaunchTerminalSideEffects(authorizeBefore, authorizeBeforeRun.id);

    const authorizeAfter = makeAuthority();
    const authorizeAfterThread = (await authorizeAfter.authority.createIntegrationThread({ title: "Authorize after commit" }, context())).thread;
    authorizeAfter.repo.state.failAuthorizeAfterCommit = true;
    await expectCode(
      () => authorizeAfter.authority.startIntegrationRun({ threadId: authorizeAfterThread.id, input: { text: "Authorize" } }, context()),
      "NATIVE_START_AUTHORIZATION_ACK_LOST"
    );
    const authorizeAfterRun = [...authorizeAfter.repo.state.runs.values()][0];
    assert.equal(callsNamed(authorizeAfter, "abortIntegrationRunBeforeLaunch").length, 0);
    assert.equal(authorizeAfterRun.status, "running");
    assert.equal(authorizeAfterRun.revision, 3);
    assert.equal(authorizeAfterRun.nativeStartReceipt.authorizationDigest, lastCallPayload(authorizeAfter, "authorizeIntegrationRunNativeStart").authorization.authorizationDigest);
    await delay(0);
    assertNoPreLaunchTerminalSideEffects(authorizeAfter, authorizeAfterRun.id);
    const authorizeAfterPayload = lastCallPayload(authorizeAfter, "authorizeIntegrationRunNativeStart");
    const authorizeAfterReplay = await authorizeAfter.repo.repository.authorizeIntegrationRunNativeStart(authorizeAfterPayload);
    assert.equal(authorizeAfterReplay.outcome, "already-authorized");
    await assert.rejects(
      () =>
        authorizeAfter.repo.repository.markIntegrationRunDispatching({
          runId: authorizeAfterRun.id,
          threadId: authorizeAfterRun.threadId,
          principalId: PRINCIPAL,
          browserSessionId: BROWSER_SESSION,
          expectedRevision: authorizeAfterRun.revision,
          expectedNativeRuntimeRevision: 1,
          dispatchLeaseId: "a".repeat(64),
          dispatchOutbox: true,
          processOwner: fakeProcessOwner(),
          dispatchedAt: now(),
        }),
      (error) => error?.code === "NATIVE_START_AUTHORIZATION_REFUSED"
    );
    const falseyReceiptRedispatch = makeAuthority();
    const falseyReceiptThread = (await falseyReceiptRedispatch.authority.createIntegrationThread({ title: "Falsey receipt dispatch" }, context())).thread;
    const falseyReceiptRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000091",
      threadId: falseyReceiptThread.id,
      nativeSessionId: falseyReceiptRedispatch.repo.state.threads.get(falseyReceiptThread.id).nativeSessionId,
      status: "starting",
      revision: 1,
      nativeStartReceipt: false,
    });
    falseyReceiptRedispatch.repo.state.runs.set(falseyReceiptRun.id, falseyReceiptRun);
    await assert.rejects(
      () =>
        falseyReceiptRedispatch.repo.repository.markIntegrationRunDispatching({
          runId: falseyReceiptRun.id,
          threadId: falseyReceiptRun.threadId,
          principalId: PRINCIPAL,
          browserSessionId: BROWSER_SESSION,
          expectedRevision: 1,
          expectedNativeRuntimeRevision: 1,
          dispatchLeaseId: "b".repeat(64),
          dispatchOutbox: true,
          processOwner: fakeProcessOwner(),
          dispatchedAt: now(),
        }),
      (error) => error?.code === "NATIVE_START_AUTHORIZATION_REFUSED"
    );
    const differentAuthorization = {
      ...authorizeAfterPayload.authorization,
      threadPreservationDigest: "9".repeat(64),
      authorizationId: "",
      authorizationDigest: ZERO_DIGEST,
    };
    differentAuthorization.authorizationDigest = nativeStartAuthorizationDigestFor(differentAuthorization);
    differentAuthorization.authorizationId = nativeStartAuthorizationIdForDigest(differentAuthorization.authorizationDigest);
    deepFreeze(differentAuthorization);
    await assert.rejects(
      () => authorizeAfter.repo.repository.authorizeIntegrationRunNativeStart(Object.freeze({ authorization: differentAuthorization })),
      (error) => error?.code === "NATIVE_START_AUTHORIZATION_REFUSED"
    );
    await assert.rejects(
      () => authorizeAfter.repo.repository.abortIntegrationRunBeforeLaunch({
        attempt: {
          schemaVersion: PRE_LAUNCH_ABORT_ATTEMPT_VERSION,
          mode: "start",
          principalId: PRINCIPAL,
          browserSessionId: BROWSER_SESSION,
          browserSessionPolicy: "same-browser-session",
          threadId: authorizeAfterRun.threadId,
          runId: authorizeAfterRun.id,
          nativeSessionId: authorizeAfterRun.nativeSessionId,
          previousRunId: null,
          previousThreadRevision: 1,
          expectedNativeRuntimeRevision: 1,
          threadPreservationDigest: threadPreservationDigestFor(authorizeAfter.repo.state.threads.get(authorizeAfterRun.threadId)),
          nativeStartReceiptMustBeAbsent: true,
          createdAt: authorizeAfterRun.createdAt,
          dispatchAttempted: true,
          dispatchLeaseId: authorizeAfterRun.dispatchLeaseId,
          dispatchOutbox: true,
          dispatchedAt: authorizeAfterRun.dispatchedAt,
          processOwner: authorizeAfterRun.processOwner,
          abortAt: authorizeAfterRun.createdAt,
          attemptDigest: ZERO_DIGEST,
        },
      }),
      (error) => error?.code === "PRE_LAUNCH_ABORT_REFUSED"
    );
    const authorizeAfterThreadBeforeHold = cloneJson(authorizeAfter.repo.state.threads.get(authorizeAfterRun.threadId));
    await expectAuthorityError(
      () => authorizeAfter.authority.getIntegrationRunStatus({ runId: authorizeAfterRun.id }, context()),
      { code: "RECOVERY_HOLD", status: 503 }
    );
    assertRecoveryHoldApplied(authorizeAfter, {
      threadId: authorizeAfterThread.id,
      runId: authorizeAfterRun.id,
      sourceRunRevision: 3,
    });
    assert.equal(authorizeAfter.repo.state.threads.get(authorizeAfterRun.threadId).revision, authorizeAfterThreadBeforeHold.revision);
    assert.equal(authorizeAfter.repo.state.threads.get(authorizeAfterRun.threadId).updatedAt, authorizeAfterThreadBeforeHold.updatedAt);
    const authorizeAfterHeldState = cloneJson(authorizeAfterRun.recoveryState);
    const authorizeAfterHeldRevision = authorizeAfterRun.revision;
    const authorizeAfterSummary = await authorizeAfter.authority.reconcileIntegrationDispatches(context());
    assert.deepEqual(authorizeAfterSummary, {
      reconciled: true,
      recoveryHolds: [{ runId: authorizeAfterRun.id, status: "recovery_hold" }],
      deliveredOutboxEvents: 0,
    });
    assert.deepEqual(authorizeAfterRun.recoveryState, authorizeAfterHeldState);
    assert.equal(authorizeAfterRun.revision, authorizeAfterHeldRevision);
    assertNoPreLaunchTerminalSideEffects(authorizeAfter, authorizeAfterRun.id);
    authorizeAfter.repo.state.reconcileMode = "stale-returned-already-held";
    await expectCode(() => authorizeAfter.authority.reconcileIntegrationDispatches(context()), "AGENT_UNAVAILABLE");
    assert.deepEqual(authorizeAfterRun.recoveryState, authorizeAfterHeldState);
    assert.equal(authorizeAfterRun.revision, authorizeAfterHeldRevision);
    authorizeAfter.repo.state.reconcileMode = "";
    await expectCode(
      () => authorizeAfter.authority.startIntegrationRun({ threadId: authorizeAfterThread.id, input: { text: "Blocked" } }, context()),
      "AGENT_UNAVAILABLE"
    );

    const freshHoldSource = makeAuthority();
    const freshHoldPrepared = await prepareReceiptBearingRun(freshHoldSource, {
      title: "Fresh authority receipt hold",
      input: "Fresh",
    });
    const freshHoldAuthority = createAgintiIntegrationRuntimeAuthority({
      threadSessionRepository: freshHoldSource.repo.repository,
      eventLedgerStore: freshHoldSource.ledger,
    });
    await expectAuthorityError(
      () => freshHoldAuthority.getIntegrationRunStatus({ runId: freshHoldPrepared.run.id }, context()),
      { code: "RECOVERY_HOLD", status: 503 }
    );
    const freshHoldReconcileCall = callsNamed(freshHoldSource, "reconcileIntegrationDispatches").at(-1)[1];
    assert.notEqual(freshHoldReconcileCall.processOwner.token, freshHoldPrepared.run.processOwner.token);
    assert.deepEqual(freshHoldReconcileCall.processOwner.processIdentity, freshHoldPrepared.run.processOwner.processIdentity);
    assertRecoveryHoldApplied(freshHoldSource, {
      threadId: freshHoldPrepared.thread.id,
      runId: freshHoldPrepared.run.id,
      sourceRunRevision: 3,
    });

    const alreadyAuthorized = makeAuthority();
    const alreadyAuthorizedThread = (await alreadyAuthorized.authority.createIntegrationThread({ title: "Already authorized" }, context())).thread;
    alreadyAuthorized.repo.state.forceAuthorizeAlreadyAuthorized = true;
    await expectAuthorityError(
      () => alreadyAuthorized.authority.startIntegrationRun({ threadId: alreadyAuthorizedThread.id, input: { text: "Already" } }, context()),
      { code: "RECOVERY_HOLD", status: 503 }
    );
    const alreadyAuthorizedRun = [...alreadyAuthorized.repo.state.runs.values()][0];
    assert.equal(alreadyAuthorizedRun.revision, 3);
    assert.ok(alreadyAuthorizedRun.nativeStartReceipt);
    assert.equal(callsNamed(alreadyAuthorized, "abortIntegrationRunBeforeLaunch").length, 0);
    await delay(0);
    assertNoPreLaunchTerminalSideEffects(alreadyAuthorized, alreadyAuthorizedRun.id);
    await expectAuthorityError(
      () => alreadyAuthorized.authority.getIntegrationRunStatus({ runId: alreadyAuthorizedRun.id }, context()),
      { code: "RECOVERY_HOLD", status: 503 }
    );
    assertRecoveryHoldApplied(alreadyAuthorized, {
      threadId: alreadyAuthorizedThread.id,
      runId: alreadyAuthorizedRun.id,
      sourceRunRevision: 3,
    });

    const ownerDeathHold = makeAuthority();
    assert.equal(ownerDeathHold.repo.repository[INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY].retainedDescriptorStorageAuthority, false);
    const ownerDeathThread = (await ownerDeathHold.authority.createIntegrationThread({ title: "Owner death recovery hold" }, context())).thread;
    ownerDeathHold.repo.state.forceAuthorizeAlreadyAuthorized = true;
    await expectAuthorityError(
      () => ownerDeathHold.authority.startIntegrationRun({ threadId: ownerDeathThread.id, input: { text: "Owner death" } }, context()),
      { code: "RECOVERY_HOLD", status: 503 }
    );
    const ownerDeathRun = [...ownerDeathHold.repo.state.runs.values()][0];
    assert.equal(ownerDeathRun.nativeStartReceipt.authorizationDigest, lastCallPayload(ownerDeathHold, "authorizeIntegrationRunNativeStart").authorization.authorizationDigest);
    assert.equal(callsNamed(ownerDeathHold, "abortIntegrationRunBeforeLaunch").length, 0);
    await delay(0);
    assertNoPreLaunchTerminalSideEffects(ownerDeathHold, ownerDeathRun.id);
    await expectAuthorityError(
      () => ownerDeathHold.authority.getIntegrationRunStatus({ runId: ownerDeathRun.id }, context()),
      { code: "RECOVERY_HOLD", status: 503 }
    );
    assertRecoveryHoldApplied(ownerDeathHold, {
      threadId: ownerDeathThread.id,
      runId: ownerDeathRun.id,
      sourceRunRevision: 3,
    });

    const repositoryActiveThreadUpdateBlocked = makeAuthority();
    const repositoryActiveThreadUpdateThread = (await repositoryActiveThreadUpdateBlocked.authority.createIntegrationThread({ title: "Repository-active thread update" }, context())).thread;
    const repositoryActiveThreadUpdateRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000121",
      threadId: repositoryActiveThreadUpdateThread.id,
      nativeSessionId: repositoryActiveThreadUpdateBlocked.repo.state.threads.get(repositoryActiveThreadUpdateThread.id).nativeSessionId,
      status: "running",
      revision: 2,
    });
    repositoryActiveThreadUpdateBlocked.repo.state.runs.set(repositoryActiveThreadUpdateRun.id, repositoryActiveThreadUpdateRun);
    const repositoryActiveGuard = snapshotThreadMutationGuard(repositoryActiveThreadUpdateBlocked, repositoryActiveThreadUpdateThread.id);
    const repositoryActiveUpdateCalls = callsNamed(repositoryActiveThreadUpdateBlocked, "updateIntegrationThread").length;
    await expectCode(
      () => repositoryActiveThreadUpdateBlocked.authority.updateIntegrationThread(
        { threadId: repositoryActiveThreadUpdateThread.id, title: "Should not update repository active" },
        context()
      ),
      "RUN_CONFLICT"
    );
    assert.equal(callsNamed(repositoryActiveThreadUpdateBlocked, "updateIntegrationThread").length, repositoryActiveUpdateCalls);
    assertThreadMutationGuardUnchanged(repositoryActiveThreadUpdateBlocked, repositoryActiveThreadUpdateThread.id, repositoryActiveGuard);

    const updateRevisionCas = makeAuthority();
    const updateRevisionThread = (await updateRevisionCas.authority.createIntegrationThread({ title: "Update CAS" }, context())).thread;
    const updateRevisionGuard = snapshotThreadMutationGuard(updateRevisionCas, updateRevisionThread.id);
    await assert.rejects(
      () => updateRevisionCas.repo.repository.updateIntegrationThread({
        threadId: updateRevisionThread.id,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
        expectedRevision: updateRevisionGuard.revision + 1,
        title: "Should not update stale",
        updatedAt: now(),
      }),
      (error) => error?.code === "REVISION_CONFLICT"
    );
    assertThreadMutationGuardUnchanged(updateRevisionCas, updateRevisionThread.id, updateRevisionGuard);

    const heldThreadUpdateBlocked = makeAuthority();
    const heldThreadPrepared = await prepareReceiptBearingRun(heldThreadUpdateBlocked, {
      title: "Held thread update",
      input: "held update block",
    });
    await expectAuthorityError(
      () => heldThreadUpdateBlocked.authority.getIntegrationRunStatus({ runId: heldThreadPrepared.run.id }, context()),
      { code: "RECOVERY_HOLD", status: 503 }
    );
    assertRecoveryHoldApplied(heldThreadUpdateBlocked, {
      threadId: heldThreadPrepared.thread.id,
      runId: heldThreadPrepared.run.id,
      sourceRunRevision: 3,
    });
    const heldGuard = snapshotThreadMutationGuard(heldThreadUpdateBlocked, heldThreadPrepared.thread.id);
    const heldUpdateCalls = callsNamed(heldThreadUpdateBlocked, "updateIntegrationThread").length;
    await expectCode(
      () => heldThreadUpdateBlocked.authority.updateIntegrationThread(
        { threadId: heldThreadPrepared.thread.id, title: "Should not update held" },
        context()
      ),
      "RUN_CONFLICT"
    );
    assert.equal(callsNamed(heldThreadUpdateBlocked, "updateIntegrationThread").length, heldUpdateCalls);
    assertThreadMutationGuardUnchanged(heldThreadUpdateBlocked, heldThreadPrepared.thread.id, heldGuard);

    const claimAppearsAfterRequest = makeAuthority();
    const claimAppearsThread = (await claimAppearsAfterRequest.authority.createIntegrationThread({ title: "Claim appears after request" }, context())).thread;
    const claimRequestCaptured = createGate();
    const claimAllowReconcile = createGate();
    let claimRequestWasEmpty = false;
    claimAppearsAfterRequest.repo.state.onReconcileAfterRequestBeforeScan = async ({ request }) => {
      if (request.liveRunClaims.length !== 0) return;
      claimRequestWasEmpty = true;
      claimRequestCaptured.resolve();
      await claimAllowReconcile.promise;
    };
    const claimReconcilePromise = claimAppearsAfterRequest.authority.reconcileIntegrationDispatches(context());
    await waitForGate(claimRequestCaptured, "stale-negative empty-claim reconcile request");
    claimAppearsAfterRequest.repo.state.failCreateBeforeCommit = true;
    const claimStartPromise = claimAppearsAfterRequest.authority
      .startIntegrationRun({ threadId: claimAppearsThread.id, input: { text: "Blocked by reconcile gate" } }, context())
      .then(
        () => {
          throw new Error("start unexpectedly passed while claim-after-request fixture was active");
        },
        (error) => error
      );
    await delay(0);
    assert.equal(claimRequestWasEmpty, true);
    assert.equal(callsNamed(claimAppearsAfterRequest, "createIntegrationRun").length, 0);
    assert.equal(callsNamed(claimAppearsAfterRequest, "markIntegrationRunDispatching").length, 0);
    assert.equal(callsNamed(claimAppearsAfterRequest, "authorizeIntegrationRunNativeStart").length, 0);
    assert.equal(claimAppearsAfterRequest.repo.state.runs.size, 0);
    claimAllowReconcile.resolve();
    const claimReconcileSummary = await claimReconcilePromise;
    assert.deepEqual(claimReconcileSummary, {
      reconciled: true,
      recoveryHolds: [],
      deliveredOutboxEvents: 0,
    });
    const claimStartError = await claimStartPromise;
    assert.equal(claimStartError.code, "REVISION_CONFLICT");
    assert.equal(claimAppearsAfterRequest.repo.state.runs.size, 0);
    claimAppearsAfterRequest.repo.state.onReconcileAfterRequestBeforeScan = null;

    const staleLiveRelease = makeAuthority();
    const staleLiveReleaseThread = (await staleLiveRelease.authority.createIntegrationThread({ title: "Stale live release" }, context())).thread;
    const staleNativeSessionId = staleLiveRelease.repo.state.threads.get(staleLiveReleaseThread.id).nativeSessionId;
    const staleLiveAbort = new AbortController();
    const staleSaveEntered = createGate();
    const staleAllowSaveProceed = createGate();
    const staleSavePersisted = createGate();
    const staleFinishEntered = createGate();
    const staleFinishFailed = createGate();
    const staleSaveStateDescriptor = Object.getOwnPropertyDescriptor(SessionStore.prototype, "saveState");
    let staleLiveRequestSnapshots = 0;
    let staleFinishAttempts = 0;
    let staleSaveIntercepts = 0;
    assert.equal(typeof staleSaveStateDescriptor?.value, "function");
    Object.defineProperty(SessionStore.prototype, "saveState", {
      ...staleSaveStateDescriptor,
      value: async function stalePositiveSaveState(state, ...args) {
        const isTargetFirstSave = this.sessionId === staleNativeSessionId && staleSaveIntercepts === 0;
        if (isTargetFirstSave) {
          staleSaveIntercepts += 1;
          staleSaveEntered.resolve();
          await staleAllowSaveProceed.promise;
        }
        const result = await Reflect.apply(staleSaveStateDescriptor.value, this, [state, ...args]);
        if (isTargetFirstSave) {
          staleSavePersisted.resolve();
          const error = new Error("stale-positive worker released after persisted native state");
          error.code = "CANCELLED";
          error.persistedRuntimeRevision = 1;
          throw error;
        }
        return result;
      },
    });
    let staleLiveReleaseRun = null;
    try {
      const staleStartPromise = staleLiveRelease.authority
        .startIntegrationRun(
          { threadId: staleLiveReleaseThread.id, input: { text: "Stale release" } },
          context({ abortSignal: staleLiveAbort.signal })
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error })
        );
      const staleStartOutcome = await waitForPromise(staleStartPromise, "stale-positive start response");
      if (staleStartOutcome.error) throw staleStartOutcome.error;
      await waitForGate(staleSaveEntered, "stale-positive native session save entered").catch((error) => {
        error.message = `${error.message}; target=${staleNativeSessionId}; calls=${JSON.stringify(staleLiveRelease.repo.calls.slice(-8).map(([name]) => name))}`;
        throw error;
      });
      staleLiveReleaseRun = staleLiveRelease.repo.state.runs.get(staleStartOutcome.value.run.id);
      assert.equal(staleLiveReleaseRun.status, "running");
      assert.equal(staleLiveReleaseRun.revision, 3);
      assert.ok(staleLiveReleaseRun.nativeStartReceipt);
      staleLiveRelease.repo.state.failFinishBeforeCommitCount = 1;
      staleLiveRelease.repo.state.onFinishBeforeCommit = async ({ payload }) => {
        staleFinishAttempts += 1;
        assert.equal(payload.runId, staleLiveReleaseRun.id);
        assert.equal(payload.expectedRevision, 3);
        assert.equal(Number.isSafeInteger(payload.completedNativeRuntimeRevision), true);
        if (staleFinishAttempts === 1) staleFinishEntered.resolve();
      };
      staleLiveRelease.repo.state.onFinishBeforeCommitFailure = async ({ remaining }) => {
        if (remaining === 0) staleFinishFailed.resolve();
      };
      staleLiveRelease.repo.state.onReconcileAfterRequestBeforeScan = async ({ request }) => {
        staleLiveRequestSnapshots += 1;
        assert.equal(request.liveRunClaims.length, 1);
        assert.equal(request.liveRunClaims[0].runId, staleLiveReleaseRun.id);
        assert.equal(request.liveRunClaims[0].threadId, staleLiveReleaseRun.threadId);
        assert.equal(request.liveRunClaims[0].nativeSessionId, staleLiveReleaseRun.nativeSessionId);
      };
      staleLiveRelease.repo.state.onReconcileBeforeResponse = async ({ request, receiptRunResults }) => {
        assert.equal(request.liveRunClaims.length, 1);
        assert.equal(receiptRunResults.length, 1);
        assert.equal(receiptRunResults[0].action, "live");
        assert.equal(receiptRunResults[0].run.id, staleLiveReleaseRun.id);
        staleAllowSaveProceed.resolve();
        await waitForGate(staleSavePersisted, "stale-positive native session save persisted").catch((error) => {
          error.message = `${error.message}; calls=${JSON.stringify(staleLiveRelease.repo.calls.slice(-12).map(([name]) => name))}`;
          throw error;
        });
        const persistedState = JSON.parse(await fs.readFile(path.join(SMOKE_ROOT, "state/sessions", staleNativeSessionId, "state.json"), "utf8"));
        assert.equal(persistedState.sessionId, staleNativeSessionId);
        assert.equal(persistedState.startUrl, "");
        assert.equal(persistedState.meta.integrationPolicyLock, buildFixedIntegrationPolicy().id);
        assert.equal(persistedState.meta.runtimeConfig.revision, 1);
        await waitForGate(staleFinishEntered, "stale-positive first finish attempt").catch((error) => {
          error.message = `${error.message}; calls=${JSON.stringify(staleLiveRelease.repo.calls.slice(-12).map(([name]) => name))}`;
          throw error;
        });
        await waitForGate(staleFinishFailed, "stale-positive finish failure");
        await delay(0);
      };
      await expectCode(
        () => staleLiveRelease.authority.reconcileIntegrationDispatches(context()),
        "AGENT_UNAVAILABLE"
      );
      assert.equal(staleStartOutcome.value.run.id, staleLiveReleaseRun.id);
      assert.equal(staleSaveIntercepts, 1);
      assert.equal(staleLiveRequestSnapshots, 1);
      assert.equal(callsNamed(staleLiveRelease, "finishIntegrationRunWithOutbox").length, 1);
      assert.equal(staleFinishAttempts, 1);
      assert.equal(callsNamed(staleLiveRelease, "abortIntegrationRunBeforeLaunch").length, 0);
      assert.equal(staleLiveReleaseRun.status, "running");
      assert.equal(staleLiveReleaseRun.revision, 3);
      assert.equal(staleLiveReleaseRun.recoveryState, null);
      assert.equal(staleLiveRelease.repo.state.outbox.size, 0);
      staleLiveRelease.repo.state.onReconcileAfterRequestBeforeScan = null;
      staleLiveRelease.repo.state.onReconcileBeforeResponse = null;
      staleLiveRelease.repo.state.onFinishBeforeCommit = null;
      staleLiveRelease.repo.state.onFinishBeforeCommitFailure = null;
      const staleSummary = await staleLiveRelease.authority.reconcileIntegrationDispatches(context());
      assert.deepEqual(staleSummary, {
        reconciled: true,
        recoveryHolds: [{ runId: staleLiveReleaseRun.id, status: "recovery_hold" }],
        deliveredOutboxEvents: 0,
      });
      assert.equal(staleLiveReleaseRun.status, "running");
      assert.equal(staleLiveReleaseRun.revision, 4);
      assert.equal(staleLiveReleaseRun.completedAt, null);
      assert.equal(staleLiveReleaseRun.output, "");
      assert.equal(staleLiveReleaseRun.error, null);
      assert.equal(staleLiveReleaseRun.recoveryState.sourceRunRevision, 3);
      assert.equal(staleLiveReleaseRun.recoveryState.appliedRunRevision, 4);
      assert.equal(staleLiveReleaseRun.recoveryState.digest, recoveryStateDigestFor(staleLiveReleaseRun.recoveryState));
      assert.equal(staleLiveRelease.repo.state.outbox.size, 0);
      assert.equal(staleLiveRelease.ledger.eventsForRun(staleLiveReleaseRun.id).length, 0);
    } finally {
      Object.defineProperty(SessionStore.prototype, "saveState", staleSaveStateDescriptor);
      staleAllowSaveProceed.resolve();
      staleLiveRelease.repo.state.onReconcileAfterRequestBeforeScan = null;
      staleLiveRelease.repo.state.onReconcileBeforeResponse = null;
      staleLiveRelease.repo.state.onFinishBeforeCommit = null;
      staleLiveRelease.repo.state.onFinishBeforeCommitFailure = null;
      staleLiveRelease.repo.state.failFinishBeforeCommitCount = 0;
      staleLiveRelease.repo.state.onAuthorizeAfterCommitBeforeReturn = null;
    }
    assert.deepEqual(Object.getOwnPropertyDescriptor(SessionStore.prototype, "saveState"), staleSaveStateDescriptor);
    assert.equal(Object.getPrototypeOf(new Promise(() => {})), Promise.prototype);

    const repeatStartAfterAlsOne = makeAuthority();
    const repeatStartAfterAlsOnePrepared = await prepareReceiptBearingRun(repeatStartAfterAlsOne, {
      title: "Repeat native start after ALS one",
      input: "repeat after ALS one",
    });
    assert.equal(repeatStartAfterAlsOnePrepared.run.revision, 3);
    assert.match(repeatStartAfterAlsOnePrepared.run.nativeStartReceipt.authorizationDigest, /^[a-f0-9]{64}$/u);
    assert.equal(repeatStartAfterAlsOnePrepared.run.nativeStartReceipt.targetRunRevision, 3);
    const repeatStartAfterAlsTwo = makeAuthority();
    const repeatStartAfterAlsTwoPrepared = await prepareReceiptBearingRun(repeatStartAfterAlsTwo, {
      title: "Repeat native start after ALS two",
      input: "repeat after ALS two",
    });
    assert.equal(repeatStartAfterAlsTwoPrepared.run.revision, 3);
    assert.match(repeatStartAfterAlsTwoPrepared.run.nativeStartReceipt.authorizationDigest, /^[a-f0-9]{64}$/u);
    assert.equal(repeatStartAfterAlsTwoPrepared.run.nativeStartReceipt.targetRunRevision, 3);

    const cancelledCrashHold = makeAuthority();
    const cancelledCrashPrepared = await prepareReceiptBearingRun(cancelledCrashHold, {
      title: "Cancelled crash recovery hold",
      input: "Cancelled crash",
    });
    const crashCancelRequestedAt = now();
    const crashCancelling = await cancelledCrashHold.repo.repository.markIntegrationRunCancelling({
      runId: cancelledCrashPrepared.run.id,
      threadId: cancelledCrashPrepared.run.threadId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: 3,
      processOwner: cancelledCrashPrepared.run.processOwner,
      cancelRequestedAt: crashCancelRequestedAt,
    });
    assert.equal(crashCancelling.run.revision, 4);
    assert.equal(cancelledCrashPrepared.run.cancelRequestedAt, crashCancelRequestedAt);
    const dispatchCallsBeforeCancelledHold = callsNamed(cancelledCrashHold, "markIntegrationRunDispatching").length;
    const authorizeCallsBeforeCancelledHold = callsNamed(cancelledCrashHold, "authorizeIntegrationRunNativeStart").length;
    const abortCallsBeforeCancelledHold = callsNamed(cancelledCrashHold, "abortIntegrationRunBeforeLaunch").length;
    await expectAuthorityError(
      () => cancelledCrashHold.authority.getIntegrationRunStatus({ runId: cancelledCrashPrepared.run.id }, context()),
      { code: "RECOVERY_HOLD", status: 503 }
    );
    assert.equal(cancelledCrashPrepared.run.cancelRequestedAt, crashCancelRequestedAt);
    assert.equal(callsNamed(cancelledCrashHold, "markIntegrationRunDispatching").length, dispatchCallsBeforeCancelledHold);
    assert.equal(callsNamed(cancelledCrashHold, "authorizeIntegrationRunNativeStart").length, authorizeCallsBeforeCancelledHold);
    assert.equal(callsNamed(cancelledCrashHold, "abortIntegrationRunBeforeLaunch").length, abortCallsBeforeCancelledHold);
    assertRecoveryHoldApplied(cancelledCrashHold, {
      threadId: cancelledCrashPrepared.thread.id,
      runId: cancelledCrashPrepared.run.id,
      sourceRunRevision: 4,
    });
    const cancelledCrashRecoveryState = cloneJson(cancelledCrashPrepared.run.recoveryState);
    await expectAuthorityError(
      () => cancelledCrashHold.authority.getIntegrationRunStatus({ runId: cancelledCrashPrepared.run.id }, context()),
      { code: "RECOVERY_HOLD", status: 503 }
    );
    assert.equal(cancelledCrashPrepared.run.cancelRequestedAt, crashCancelRequestedAt);
    assert.deepEqual(cancelledCrashPrepared.run.recoveryState, cancelledCrashRecoveryState);

    const forgedCancelWithoutRevision = makeAuthority();
    const forgedCancelWithoutRevisionPrepared = await prepareReceiptBearingRun(forgedCancelWithoutRevision, {
      title: "Forged cancel without revision",
      input: "cancel without revision",
    });
    forgedCancelWithoutRevisionPrepared.run.cancelRequestedAt = now();
    await expectCode(
      () => forgedCancelWithoutRevision.authority.getIntegrationRunStatus(
        { runId: forgedCancelWithoutRevisionPrepared.run.id },
        context()
      ),
      "AGENT_UNAVAILABLE"
    );
    assertNoPreLaunchTerminalSideEffects(forgedCancelWithoutRevision, forgedCancelWithoutRevisionPrepared.run.id);

    const forgedRevisionWithoutCancel = makeAuthority();
    const forgedRevisionWithoutCancelPrepared = await prepareReceiptBearingRun(forgedRevisionWithoutCancel, {
      title: "Forged revision without cancel",
      input: "revision without cancel",
    });
    forgedRevisionWithoutCancelPrepared.run.revision = 4;
    await expectCode(
      () => forgedRevisionWithoutCancel.authority.getIntegrationRunStatus(
        { runId: forgedRevisionWithoutCancelPrepared.run.id },
        context()
      ),
      "AGENT_UNAVAILABLE"
    );
    assertNoPreLaunchTerminalSideEffects(forgedRevisionWithoutCancel, forgedRevisionWithoutCancelPrepared.run.id);

    const liveRepositorySemantics = makeAuthority();
    const livePrepared = await prepareReceiptBearingRun(liveRepositorySemantics, {
      title: "Live claim repository semantics",
      input: "Live",
    });
    const liveRequestUnsigned = {
      schemaVersion: DISPATCH_RECONCILIATION_VERSION,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      processOwner: cloneJson(livePrepared.run.processOwner),
      liveRunClaims: [
        {
          runId: livePrepared.run.id,
          threadId: livePrepared.thread.id,
          nativeSessionId: livePrepared.run.nativeSessionId,
          claimedAt: now(),
        },
      ],
      reconciledAt: now(),
      requestDigest: ZERO_DIGEST,
    };
    const liveRequest = Object.freeze({
      ...liveRequestUnsigned,
      processOwner: Object.freeze({
        ...liveRequestUnsigned.processOwner,
        processIdentity: Object.freeze(liveRequestUnsigned.processOwner.processIdentity),
      }),
      liveRunClaims: Object.freeze(liveRequestUnsigned.liveRunClaims.map((claim) => Object.freeze(claim))),
      requestDigest: reconciliationRequestDigestFor(liveRequestUnsigned),
    });
    const liveResponse = await liveRepositorySemantics.repo.repository.reconcileIntegrationDispatches(liveRequest);
    assert.equal(liveResponse.receiptRunResults[0].action, "live");
    assert.equal(livePrepared.run.recoveryState, null);
    assert.equal(livePrepared.run.revision, 3);
    assertNoPreLaunchTerminalSideEffects(liveRepositorySemantics, livePrepared.run.id);
    const earlyClaimRequestUnsigned = {
      ...liveRequestUnsigned,
      liveRunClaims: [
        {
          ...liveRequestUnsigned.liveRunClaims[0],
          claimedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      reconciledAt: now(),
      requestDigest: ZERO_DIGEST,
    };
    const earlyClaimRequest = Object.freeze({
      ...earlyClaimRequestUnsigned,
      processOwner: Object.freeze({
        ...earlyClaimRequestUnsigned.processOwner,
        processIdentity: Object.freeze(earlyClaimRequestUnsigned.processOwner.processIdentity),
      }),
      liveRunClaims: Object.freeze(earlyClaimRequestUnsigned.liveRunClaims.map((claim) => Object.freeze(claim))),
      requestDigest: reconciliationRequestDigestFor(earlyClaimRequestUnsigned),
    });
    const earlyClaimResponse = await liveRepositorySemantics.repo.repository.reconcileIntegrationDispatches(earlyClaimRequest);
    assert.equal(earlyClaimResponse.receiptRunResults[0].action, "held");
    assertRecoveryHoldApplied(liveRepositorySemantics, {
      threadId: livePrepared.thread.id,
      runId: livePrepared.run.id,
      sourceRunRevision: 3,
    });

    for (const marker of [false, 0, "", { schemaVersion: NATIVE_START_RECOVERY_STATE_VERSION }, "missing"]) {
      const corruptRecoveryMarker = makeAuthority();
      const corruptPrepared = await prepareReceiptBearingRun(corruptRecoveryMarker, {
        title: `Corrupt recovery marker ${String(marker)}`,
        input: "marker",
      });
      if (marker === "missing") delete corruptPrepared.run.recoveryState;
      else corruptPrepared.run.recoveryState = marker;
      await expectCode(
        () => corruptRecoveryMarker.authority.getIntegrationRunStatus({ runId: corruptPrepared.run.id }, context()),
        "AGENT_UNAVAILABLE"
      );
      assert.equal(corruptPrepared.run.revision, 3);
      if (marker === "missing") assert.equal(Object.prototype.hasOwnProperty.call(corruptPrepared.run, "recoveryState"), false);
      else assert.equal(corruptPrepared.run.recoveryState, marker);
      assertNoPreLaunchTerminalSideEffects(corruptRecoveryMarker, corruptPrepared.run.id);
    }

    for (const mode of [
      "wrapper-extra",
      "missing-response-digest",
      "bad-response-digest",
      "extra-result",
      "foreign-result",
      "accessor-result",
      "proxy-result",
      "sparse-results",
      "duplicate-result",
      "live-without-claim",
      "bad-recovery-digest",
      "bad-recovery-revision",
      "bad-recovery-source",
      "bad-held-at",
      "changed-thread-context",
      "bad-thread-revision",
      "bad-thread-updated-at",
      "bad-runtime-revision",
      "bad-previous-run",
      "bad-cancel-requested",
      "bad-dispatch-lease",
      "hidden-run",
      "stale-returned-run",
      "stale-returned-thread",
    ]) {
      const malformedReconcile = makeAuthority();
      await prepareReceiptBearingRun(malformedReconcile, {
        title: `Malformed reconcile ${mode}`,
        input: mode,
      });
      malformedReconcile.repo.state.reconcileMode = mode;
      let rejectedMode = false;
      try {
        await malformedReconcile.authority.reconcileIntegrationDispatches(context());
      } catch (error) {
        rejectedMode = true;
        const expectedCodes = mode === "foreign-result" ? ["NOT_FOUND"] : ["AGENT_UNAVAILABLE", "INVALID_REQUEST"];
        assert.equal(expectedCodes.includes(error?.code || error?.publicCode), true, mode);
      }
      assert.equal(rejectedMode, true, `reconcile mode ${mode} must reject`);
      if (mode === "proxy-result") assert.equal(malformedReconcile.repo.state.reconcileTrapCount, 0);
    }
    const unsortedReconcile = makeAuthority();
    await prepareReceiptBearingRun(unsortedReconcile, { title: "Unsorted reconcile A", input: "A" });
    await prepareReceiptBearingRun(unsortedReconcile, { title: "Unsorted reconcile B", input: "B" });
    unsortedReconcile.repo.state.reconcileMode = "unsorted-result";
    await expectCode(() => unsortedReconcile.authority.reconcileIntegrationDispatches(context()), "AGENT_UNAVAILABLE");

    for (const [flag, value] of [
      ["forgedAuthorizeReceipt", true],
      ["forgedAuthorizeRunRevision", 4],
      ["forgedAuthorizeOwnerTimestamp", true],
      ["forgedAuthorizeTimestamp", true],
      ["forgedAuthorizeRunAlias", "native"],
      ["forgedAuthorizeRunAlias", "startedAt"],
      ["forgedAuthorizeThreadAlias", "revision"],
      ["forgedAuthorizeThreadAlias", "updatedAt"],
      ["forgedAuthorizeThreadAlias", "context"],
    ]) {
      const forgedAuthorize = makeAuthority();
      const forgedAuthorizeThread = (await forgedAuthorize.authority.createIntegrationThread({ title: `Forged authorize ${flag}` }, context())).thread;
      forgedAuthorize.repo.state[flag] = value;
      await expectCode(
        () => forgedAuthorize.authority.startIntegrationRun({ threadId: forgedAuthorizeThread.id, input: { text: flag } }, context()),
        "AGENT_UNAVAILABLE"
      );
      const forgedAuthorizeRun = [...forgedAuthorize.repo.state.runs.values()][0];
      assert.equal(callsNamed(forgedAuthorize, "abortIntegrationRunBeforeLaunch").length, 0);
      await delay(0);
      assertNoPreLaunchTerminalSideEffects(forgedAuthorize, forgedAuthorizeRun.id);
    }

    for (const mode of ["proxy", "accessor", "non-enumerable", "symbol", "extra", "outer-wrapper-extra"]) {
      const descriptorAttack = makeAuthority();
      const descriptorAttackThread = (await descriptorAttack.authority.createIntegrationThread({ title: `Authorize descriptor ${mode}` }, context())).thread;
      descriptorAttack.repo.state.forgedAuthorizeDescriptor = mode;
      await expectCode(
        () => descriptorAttack.authority.startIntegrationRun({ threadId: descriptorAttackThread.id, input: { text: mode } }, context()),
        "AGENT_UNAVAILABLE"
      );
      const descriptorAttackRun = [...descriptorAttack.repo.state.runs.values()][0];
      assert.equal(callsNamed(descriptorAttack, "abortIntegrationRunBeforeLaunch").length, 0);
      if (mode === "accessor") assert.equal(descriptorAttack.repo.state.authorizeDescriptorTrapCount, 0);
      await delay(0);
      assertNoPreLaunchTerminalSideEffects(descriptorAttack, descriptorAttackRun.id);
    }

    const responseAlias = makeAuthority();
    const responseAliasThread = (await responseAlias.authority.createIntegrationThread({ title: "Authorize response alias" }, context())).thread;
    responseAlias.repo.state.forceAuthorizeAlreadyAuthorized = true;
    responseAlias.repo.state.mutateAuthorizeResponseAliasAfterReturn = true;
    await expectCode(
      () => responseAlias.authority.startIntegrationRun({ threadId: responseAliasThread.id, input: { text: "Alias" } }, context()),
      "RECOVERY_HOLD"
    );
    const responseAliasRun = [...responseAlias.repo.state.runs.values()][0];
    assert.equal(callsNamed(responseAlias, "abortIntegrationRunBeforeLaunch").length, 0);
    await delay(5);
    assertNoPreLaunchTerminalSideEffects(responseAlias, responseAliasRun.id);

    for (const [label, action] of [
      ["aborted", ""],
      ["already-aborted", "already-aborted"],
    ]) {
      const forgedStarting = makeAuthority();
      const forgedStartingThread = (await forgedStarting.authority.createIntegrationThread({ title: `Forged starting ${label}` }, context())).thread;
      forgedStarting.repo.state.failCreateAfterCommit = true;
      forgedStarting.repo.state.forgedAbortRunRevision = 3;
      forgedStarting.repo.state.forgedAbortAction = action;
      await expectCode(
        () => forgedStarting.authority.startIntegrationRun({ threadId: forgedStartingThread.id, input: { text: "Forge" } }, context()),
        "AGENT_UNAVAILABLE"
      );
      const forgedStartingRun = [...forgedStarting.repo.state.runs.values()][0];
      assertNoPreLaunchTerminalSideEffects(forgedStarting, forgedStartingRun.id);

      const forgedDispatched = makeAuthority();
      const forgedDispatchedThread = (await forgedDispatched.authority.createIntegrationThread({ title: `Forged dispatched ${label}` }, context())).thread;
      forgedDispatched.repo.state.failDispatchAfterCommit = true;
      forgedDispatched.repo.state.forgedAbortRunRevision = 4;
      forgedDispatched.repo.state.forgedAbortAction = action;
      await expectCode(
        () => forgedDispatched.authority.startIntegrationRun({ threadId: forgedDispatchedThread.id, input: { text: "Forge" } }, context()),
        "AGENT_UNAVAILABLE"
      );
      const forgedDispatchedRun = [...forgedDispatched.repo.state.runs.values()][0];
      assertNoPreLaunchTerminalSideEffects(forgedDispatched, forgedDispatchedRun.id);
    }

    for (const [flag, value] of [
      ["forgedAbortRunCreatedAt", "2026-01-01T00:00:00.000Z"],
      ["forgedAbortRunStartedAt", "2026-01-01T00:00:00.000Z"],
      ["forgedAbortThreadUpdatedAt", "2026-01-01T00:00:00.000Z"],
      ["forgedAbortThreadContextDigest", "6".repeat(64)],
      ["forgedAbortThreadReplay", true],
      ["forgedAbortThreadMessages", true],
    ]) {
      const forgedAbort = makeAuthority();
      const forgedAbortThread = (await forgedAbort.authority.createIntegrationThread({ title: `Forged ${flag}` }, context())).thread;
      forgedAbort.repo.state.failCreateAfterCommit = true;
      forgedAbort.repo.state[flag] = value;
      await expectCode(
        () => forgedAbort.authority.startIntegrationRun({ threadId: forgedAbortThread.id, input: { text: flag } }, context()),
        "AGENT_UNAVAILABLE"
      );
      const forgedAbortRun = [...forgedAbort.repo.state.runs.values()][0];
      assertNoPreLaunchTerminalSideEffects(forgedAbort, forgedAbortRun.id);
    }

    const forgedOwnerTime = makeAuthority();
    const forgedOwnerThread = (await forgedOwnerTime.authority.createIntegrationThread({ title: "Forged owner time" }, context())).thread;
    forgedOwnerTime.repo.state.failDispatchAfterCommit = true;
    forgedOwnerTime.repo.state.forgedAbortOwnerTimestamp = true;
    await expectCode(
      () => forgedOwnerTime.authority.startIntegrationRun({ threadId: forgedOwnerThread.id, input: { text: "Owner" } }, context()),
      "AGENT_UNAVAILABLE"
    );
    const forgedOwnerRun = [...forgedOwnerTime.repo.state.runs.values()][0];
    assertNoPreLaunchTerminalSideEffects(forgedOwnerTime, forgedOwnerRun.id);

    const abortFailure = makeAuthority();
    const abortFailureThread = (await abortFailure.authority.createIntegrationThread({ title: "Abort failure" }, context())).thread;
    abortFailure.repo.state.failCreateAfterCommit = true;
    abortFailure.repo.state.failNextPreLaunchAbort = true;
    await assert.rejects(
      () => abortFailure.authority.startIntegrationRun({ threadId: abortFailureThread.id, input: { text: "Abort failure" } }, context()),
      (error) => error?.code === "PRE_LAUNCH_ABORT_FAILED"
    );
    const abortFailureRun = [...abortFailure.repo.state.runs.values()][0];
    assert.equal(abortFailureRun.hidden, false);
    assertNoPreLaunchTerminalSideEffects(abortFailure, abortFailureRun.id);

    const abortPassthrough = makeAuthority();
    const abortPassthroughThread = (await abortPassthrough.authority.createIntegrationThread({ title: "Abort passthrough" }, context())).thread;
    let abortErrorTrapCount = 0;
    const abortError = {};
    Object.defineProperty(abortError, "cause", {
      enumerable: true,
      configurable: false,
      get() {
        abortErrorTrapCount += 1;
        throw new Error("cause getter must not run");
      },
    });
    Object.preventExtensions(abortError);
    abortPassthrough.repo.state.failCreateAfterCommit = true;
    abortPassthrough.repo.state.preLaunchAbortError = Object.freeze(abortError);
    try {
      await abortPassthrough.authority.startIntegrationRun({ threadId: abortPassthroughThread.id, input: { text: "Abort passthrough" } }, context());
      assert.fail("pre-launch abort passthrough must reject");
    } catch (error) {
      assert.equal(error, abortPassthrough.repo.state.preLaunchAbortError);
    }
    assert.equal(abortErrorTrapCount, 0);
    const abortPassthroughRun = [...abortPassthrough.repo.state.runs.values()][0];
    assertNoPreLaunchTerminalSideEffects(abortPassthrough, abortPassthroughRun.id);

    const wrongLease = makeAuthority();
    const wrongLeaseThread = (await wrongLease.authority.createIntegrationThread({ title: "Wrong lease" }, context())).thread;
    wrongLease.repo.state.failDispatchAfterCommit = true;
    wrongLease.repo.state.corruptAbortLease = true;
    await assert.rejects(
      () => wrongLease.authority.startIntegrationRun({ threadId: wrongLeaseThread.id, input: { text: "Wrong lease" } }, context()),
      (error) => error?.code === "PRE_LAUNCH_ABORT_REFUSED"
    );
    const wrongLeaseRun = [...wrongLease.repo.state.runs.values()][0];
    assert.equal(wrongLeaseRun.status, "running");
    assert.equal(wrongLeaseRun.hidden, false);
    assertNoPreLaunchTerminalSideEffects(wrongLease, wrongLeaseRun.id);

    const activeAliasMutation = makeAuthority();
    const activeAliasThread = (await activeAliasMutation.authority.createIntegrationThread({ title: "Active alias mutation" }, context())).thread;
    const activeAliasRaw = activeAliasMutation.repo.state.threads.get(activeAliasThread.id);
    const activeAliasOriginalNative = activeAliasRaw.nativeSessionId;
    activeAliasMutation.repo.state.mutateActiveRunAliasAfterReturn = "native";
    await expectCode(
      () => activeAliasMutation.authority.startIntegrationRun({ threadId: activeAliasThread.id, input: { text: "Alias" } }, context()),
      "PRE_LAUNCH_ABORT_REFUSED"
    );
    const activeAliasAbort = lastCallPayload(activeAliasMutation, "abortIntegrationRunBeforeLaunch");
    assert.equal(activeAliasAbort.attempt.nativeSessionId, activeAliasOriginalNative);
    const activeAliasRun = [...activeAliasMutation.repo.state.runs.values()][0];
    assertNoPreLaunchTerminalSideEffects(activeAliasMutation, activeAliasRun.id);

    const getThreadAliasMutation = makeAuthority();
    const getThreadAliasThread = (await getThreadAliasMutation.authority.createIntegrationThread({ title: "Get thread alias mutation" }, context())).thread;
    getThreadAliasMutation.repo.state.mutateGetThreadAliasAfterReturn = "lastRun";
    await expectCode(
      () => getThreadAliasMutation.authority.startIntegrationRun({ threadId: getThreadAliasThread.id, input: { text: "Alias" } }, context()),
      "AGENT_UNAVAILABLE"
    );
    assert.equal(callsNamed(getThreadAliasMutation, "createIntegrationRun").length, 0);

    const processOwnerAliasMutation = makeAuthority();
    const processOwnerAliasThread = (await processOwnerAliasMutation.authority.createIntegrationThread({ title: "Process owner alias mutation" }, context())).thread;
    const processOwnerRaw = processOwnerAliasMutation.repo.state.threads.get(processOwnerAliasThread.id);
    const processOwnerOriginalNative = processOwnerRaw.nativeSessionId;
    processOwnerAliasMutation.repo.state.mutateCreateAliasAfterReturn = "native";
    await expectCode(
      () => processOwnerAliasMutation.authority.startIntegrationRun({ threadId: processOwnerAliasThread.id, input: { text: "Alias" } }, context()),
      "PRE_LAUNCH_ABORT_REFUSED"
    );
    const processOwnerAbort = lastCallPayload(processOwnerAliasMutation, "abortIntegrationRunBeforeLaunch");
    assert.equal(processOwnerAbort.attempt.nativeSessionId, processOwnerOriginalNative);
    const processOwnerAliasRun = [...processOwnerAliasMutation.repo.state.runs.values()][0];
    assertNoPreLaunchTerminalSideEffects(processOwnerAliasMutation, processOwnerAliasRun.id);

    const resumeRollback = makeAuthority();
    const resumeThread = (await resumeRollback.authority.createIntegrationThread({ title: "Resume rollback" }, context())).thread;
    const resumeRawThread = resumeRollback.repo.state.threads.get(resumeThread.id);
    const priorRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000047",
      threadId: resumeThread.id,
      nativeSessionId: resumeRawThread.nativeSessionId,
      status: "completed",
      revision: 3,
      completedAt: now(),
      output: "Prior terminal.",
      authority: {
        kind: "aginti",
        snapshotHash: SNAPSHOT_HASH,
        runtimeRevision: 2,
        contextDigest: CONTEXT_DIGEST,
      },
    });
    resumeRollback.repo.state.runs.set(priorRun.id, priorRun);
    Object.assign(resumeRawThread, {
      lastRunId: priorRun.id,
      status: "idle",
      authority: { ...resumeRawThread.authority, runtimeRevision: 2 },
      revision: resumeRawThread.revision + 1,
    });
    resumeRollback.repo.state.failCreateAfterCommit = true;
    await assert.rejects(() => resumeRollback.authority.resumeIntegrationRun({ runId: priorRun.id, input: { text: "Resume" } }, context()));
    const abortedResumeRun = [...resumeRollback.repo.state.runs.values()].find((run) => run.id !== priorRun.id);
    assertPreLaunchAbortApplied(resumeRollback, {
      threadId: resumeThread.id,
      runId: abortedResumeRun.id,
      previousRunId: priorRun.id,
      expectedRuntimeRevision: 2,
    });
    assert.equal(resumeRawThread.lastRunId, priorRun.id);
    resumeRollback.repo.state.failNextDispatch = true;
    await assert.rejects(() => resumeRollback.authority.resumeIntegrationRun({ runId: priorRun.id, input: { text: "Resume again" } }, context()));
    assert.equal([...resumeRollback.repo.state.runs.values()].filter((run) => run.status === "aborted_before_launch").length, 2);

    const priorAliasMutation = makeAuthority();
    const priorAliasThread = (await priorAliasMutation.authority.createIntegrationThread({ title: "Prior alias mutation" }, context())).thread;
    const priorAliasRawThread = priorAliasMutation.repo.state.threads.get(priorAliasThread.id);
    const priorAliasNative = priorAliasRawThread.nativeSessionId;
    const priorAliasRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000048",
      threadId: priorAliasThread.id,
      nativeSessionId: priorAliasNative,
      status: "completed",
      revision: 3,
      completedAt: now(),
      output: "Prior terminal.",
      authority: {
        kind: "aginti",
        snapshotHash: SNAPSHOT_HASH,
        runtimeRevision: 2,
        contextDigest: CONTEXT_DIGEST,
      },
    });
    priorAliasMutation.repo.state.runs.set(priorAliasRun.id, priorAliasRun);
    Object.assign(priorAliasRawThread, {
      lastRunId: priorAliasRun.id,
      status: "idle",
      authority: { ...priorAliasRawThread.authority, runtimeRevision: 2 },
      revision: priorAliasRawThread.revision + 1,
    });
    priorAliasMutation.repo.state.failCreateAfterCommit = true;
    priorAliasMutation.repo.state.mutatePriorRunAliasDuringGetThread = "native";
    await assert.rejects(() => priorAliasMutation.authority.resumeIntegrationRun({ runId: priorAliasRun.id, input: { text: "Resume alias" } }, context()));
    const priorAliasAbort = lastCallPayload(priorAliasMutation, "abortIntegrationRunBeforeLaunch");
    assert.equal(priorAliasAbort.attempt.previousRunId, priorAliasRun.id);
    assert.equal(priorAliasAbort.attempt.nativeSessionId, priorAliasNative);
    const priorAliasAbortedRun = [...priorAliasMutation.repo.state.runs.values()].find((run) => run.id !== priorAliasRun.id);
    assertNoPreLaunchTerminalSideEffects(priorAliasMutation, priorAliasAbortedRun.id);

    const fakeParentSignal = {
      aborted: false,
      listeners: 0,
      addEventListener(name, listener) {
        assert.equal(name, "abort");
        this.listener = listener;
        this.listeners += 1;
      },
      removeEventListener(name, listener) {
        assert.equal(name, "abort");
        assert.equal(listener, this.listener);
        this.listeners -= 1;
      },
    };
    const listenerFixture = makeAuthority();
    const listenerThread = (await listenerFixture.authority.createIntegrationThread({ title: "Listener" }, context())).thread;
    listenerFixture.repo.state.failNextDispatch = true;
    await assert.rejects(() =>
      listenerFixture.authority.startIntegrationRun(
        { threadId: listenerThread.id, input: { text: "Listener" } },
        context({ abortSignal: fakeParentSignal })
      )
    );
    assert.equal(fakeParentSignal.listeners, 0);

    const outboxFixture = makeAuthority({ appendProof: true });
    const outboxThread = (await outboxFixture.authority.createIntegrationThread({ title: "Outbox" }, context())).thread;
    const rawRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000010",
      threadId: outboxThread.id,
      nativeSessionId: outboxFixture.repo.state.threads.get(outboxThread.id).nativeSessionId,
      status: "completed",
      revision: 3,
      output: "",
      completedAt: now(),
    });
    outboxFixture.repo.state.runs.set(rawRun.id, rawRun);
    const terminal = createPublicIntegrationEvent({
      threadId: rawRun.threadId,
      runId: rawRun.id,
      seq: 1,
      type: "run.completed",
      payload: {},
      createdAt: rawRun.completedAt,
      previousHash: ZERO_DIGEST,
    });
    const recoverRecord = {
      outboxId: "out_recover",
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      threadId: rawRun.threadId,
      runId: rawRun.id,
      type: "run.completed",
      payload: {},
      createdAt: rawRun.completedAt,
      expectedPreviousSeq: 0,
      expectedPreviousHash: ZERO_DIGEST,
      expectedEventHash: terminal.hash,
      delivered: false,
    };
    outboxFixture.repo.state.outbox.set(recoverRecord.outboxId, recoverRecord);
    attachCompletionMetadata(outboxFixture, rawRun, [recoverRecord]);
    const reconciled = await outboxFixture.authority.reconcileIntegrationDispatches(context());
    assert.equal(reconciled.deliveredOutboxEvents, 1);
    assert.equal(outboxFixture.ledger.eventsForRun(rawRun.id).at(-1).type, "run.completed");

    const foreignOutbox = makeAuthority({ appendProof: true });
    const foreignOutboxThread = (await foreignOutbox.authority.createIntegrationThread({ title: "Foreign outbox" }, context())).thread;
    const foreignOutboxRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000027",
      threadId: foreignOutboxThread.id,
      nativeSessionId: foreignOutbox.repo.state.threads.get(foreignOutboxThread.id).nativeSessionId,
      status: "completed",
      revision: 3,
      output: "",
      completedAt: now(),
    });
    foreignOutbox.repo.state.runs.set(foreignOutboxRun.id, foreignOutboxRun);
    const foreignOutboxTerminal = createPublicIntegrationEvent({
      threadId: foreignOutboxRun.threadId,
      runId: foreignOutboxRun.id,
      seq: 1,
      type: "run.completed",
      payload: {},
      createdAt: foreignOutboxRun.completedAt,
      previousHash: ZERO_DIGEST,
    });
    const foreignRecord = {
      outboxId: "out_foreign_scope",
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      threadId: "thr_00000000-0000-4000-8000-000000000099",
      runId: foreignOutboxRun.id,
      type: "run.completed",
      payload: {},
      createdAt: foreignOutboxRun.completedAt,
      expectedPreviousSeq: 0,
      expectedPreviousHash: ZERO_DIGEST,
      expectedEventHash: foreignOutboxTerminal.hash,
      delivered: false,
    };
    foreignOutbox.repo.state.outbox.set(foreignRecord.outboxId, foreignRecord);
    attachCompletionMetadata(foreignOutbox, foreignOutboxRun, [{ ...foreignRecord, threadId: foreignOutboxRun.threadId }]);
    await expectCode(() => foreignOutbox.authority.reconcileIntegrationDispatches(context()), "NOT_FOUND");

    const outboxRetry = makeAuthority({ appendProof: true });
    const retryThread = (await outboxRetry.authority.createIntegrationThread({ title: "Outbox retry" }, context())).thread;
    const retryRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000019",
      threadId: retryThread.id,
      nativeSessionId: outboxRetry.repo.state.threads.get(retryThread.id).nativeSessionId,
      status: "completed",
      revision: 3,
      output: "",
      completedAt: now(),
    });
    outboxRetry.repo.state.runs.set(retryRun.id, retryRun);
    const retryTerminal = createPublicIntegrationEvent({
      threadId: retryRun.threadId,
      runId: retryRun.id,
      seq: 1,
      type: "run.completed",
      payload: {},
      createdAt: retryRun.completedAt,
      previousHash: ZERO_DIGEST,
    });
    const retryRecord = {
      outboxId: "out_retry",
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      threadId: retryRun.threadId,
      runId: retryRun.id,
      type: "run.completed",
      payload: {},
      createdAt: retryRun.completedAt,
      expectedPreviousSeq: 0,
      expectedPreviousHash: ZERO_DIGEST,
      expectedEventHash: retryTerminal.hash,
      delivered: false,
    };
    outboxRetry.repo.state.outbox.set(retryRecord.outboxId, retryRecord);
    attachCompletionMetadata(outboxRetry, retryRun, [retryRecord]);
    outboxRetry.repo.state.failNextOutboxMark = true;
    await assert.rejects(() => outboxRetry.authority.reconcileIntegrationDispatches(context()));
    assert.equal(outboxRetry.ledger.eventsForRun(retryRun.id).length, 1);
    const retried = await outboxRetry.authority.reconcileIntegrationDispatches(context());
    assert.equal(retried.deliveredOutboxEvents, 1);
    assert.equal(outboxRetry.ledger.eventsForRun(retryRun.id).length, 1);
    const freshAuthority = createAgintiIntegrationRuntimeAuthority({
      threadSessionRepository: outboxRetry.repo.repository,
      eventLedgerStore: outboxRetry.ledger,
      cancellationAttestation: makeCancellationAttestation(),
      hardenedSandboxAttestation: makeSandboxAttestation(),
    });
    outboxRetry.repo.state.outbox.get("out_retry").delivered = false;
    const fresh = await freshAuthority.reconcileIntegrationDispatches(context());
    assert.equal(fresh.deliveredOutboxEvents, 1);
    assert.equal(outboxRetry.ledger.eventsForRun(retryRun.id).length, 1);

    const partialSame = makeAuthority({ appendProof: true });
    const partialSameBundle = await prepareCompletedOutputBundle(partialSame, {
      title: "Partial same",
      runId: "run_00000000-0000-4000-8000-000000000031",
      output: "Recovered output same.",
    });
    const partialSameScope = {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      threadId: partialSameBundle.run.threadId,
      runId: partialSameBundle.run.id,
    };
    await publishOutboxRecordOnly(partialSame, partialSameScope, partialSameBundle.outputRecord);
    partialSame.repo.state.failOutboxMarkTypes.add("run.completed");
    await assert.rejects(() => partialSame.authority.reconcileIntegrationDispatches(context()));
    assert.deepEqual(partialSame.ledger.eventsForRun(partialSameBundle.run.id).map((event) => event.type), [
      "output.delta",
      "run.completed",
    ]);
    const partialSameRecovered = await partialSame.authority.reconcileIntegrationDispatches(context());
    assert.equal(partialSameRecovered.deliveredOutboxEvents, 2);
    assert.deepEqual(partialSame.ledger.eventsForRun(partialSameBundle.run.id).map((event) => event.type), [
      "output.delta",
      "run.completed",
    ]);
    assert.equal(partialSame.repo.state.outbox.get(partialSameBundle.outputRecord.outboxId).delivered, true);
    assert.equal(partialSame.repo.state.outbox.get(partialSameBundle.terminalRecord.outboxId).delivered, true);

    const partialFresh = makeAuthority({ appendProof: true });
    const partialFreshBundle = await prepareCompletedOutputBundle(partialFresh, {
      title: "Partial fresh",
      runId: "run_00000000-0000-4000-8000-000000000032",
      output: "Recovered output fresh.",
    });
    const partialFreshScope = {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      threadId: partialFreshBundle.run.threadId,
      runId: partialFreshBundle.run.id,
    };
    await publishOutboxRecordOnly(partialFresh, partialFreshScope, partialFreshBundle.outputRecord);
    partialFresh.repo.state.failOutboxMarkTypes.add("run.completed");
    await assert.rejects(() => partialFresh.authority.reconcileIntegrationDispatches(context()));
    const partialFreshAuthority = createAgintiIntegrationRuntimeAuthority({
      threadSessionRepository: partialFresh.repo.repository,
      eventLedgerStore: partialFresh.ledger,
      cancellationAttestation: makeCancellationAttestation(),
      hardenedSandboxAttestation: makeSandboxAttestation(),
    });
    const partialFreshRecovered = await partialFreshAuthority.reconcileIntegrationDispatches(context());
    assert.equal(partialFreshRecovered.deliveredOutboxEvents, 2);
    assert.deepEqual(partialFresh.ledger.eventsForRun(partialFreshBundle.run.id).map((event) => event.type), [
      "output.delta",
      "run.completed",
    ]);
    const partialFreshHashes = partialFresh.ledger.eventsForRun(partialFreshBundle.run.id).map((event) => event.hash);
    partialFresh.repo.state.outbox.get(partialFreshBundle.terminalRecord.outboxId).delivered = false;
    const idempotentReplay = await partialFresh.authority.reconcileIntegrationDispatches(context());
    assert.equal(idempotentReplay.deliveredOutboxEvents, 2);
    assert.deepEqual(partialFresh.ledger.eventsForRun(partialFreshBundle.run.id).map((event) => event.hash), partialFreshHashes);
    assert.equal(partialFresh.repo.state.outbox.get(partialFreshBundle.outputRecord.outboxId).delivered, true);
    assert.equal(partialFresh.repo.state.outbox.get(partialFreshBundle.terminalRecord.outboxId).delivered, true);

    const shiftedAfterOutput = makeAuthority({ appendProof: true });
    const shiftedBundle = await prepareCompletedOutputBundle(shiftedAfterOutput, {
      title: "Shifted after output",
      runId: "run_00000000-0000-4000-8000-000000000039",
      output: "Output already durable.",
    });
    const shiftedScope = {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      threadId: shiftedBundle.run.threadId,
      runId: shiftedBundle.run.id,
    };
    await publishOutboxRecordOnly(shiftedAfterOutput, shiftedScope, shiftedBundle.outputRecord);
    shiftedAfterOutput.repo.state.bundleMode = "regenerated";
    await assert.rejects(
      () => shiftedAfterOutput.authority.reconcileIntegrationDispatches(context()),
      /metadata|bundle|outbox|durable/iu
    );
    assert.deepEqual(shiftedAfterOutput.ledger.eventsForRun(shiftedBundle.run.id).map((event) => event.type), [
      "output.delta",
    ]);
    assert.equal(shiftedAfterOutput.repo.state.outbox.get(shiftedBundle.outputRecord.outboxId).delivered, true);
    assert.equal(shiftedAfterOutput.repo.state.outbox.get(shiftedBundle.terminalRecord.outboxId).delivered, false);

    const corruptExistingMapping = makeAuthority({
      appendProof: true,
      ledgerOptions: { corruptLookupByOutboxId: true },
    });
    const corruptExistingBundle = await prepareCompletedOutputBundle(corruptExistingMapping, {
      title: "Existing outbox mapping",
      runId: "run_00000000-0000-4000-8000-000000000041",
      output: "Must not partially publish.",
    });
    await assert.rejects(
      () => corruptExistingMapping.authority.reconcileIntegrationDispatches(context()),
      /outbox|ledger|substituted|event/iu
    );
    assert.equal(corruptExistingMapping.ledger.eventsForRun(corruptExistingBundle.run.id).length, 0);
    assert.equal(corruptExistingMapping.repo.state.outbox.get(corruptExistingBundle.outputRecord.outboxId).delivered, false);
    assert.equal(corruptExistingMapping.repo.state.outbox.get(corruptExistingBundle.terminalRecord.outboxId).delivered, false);

    for (const [mode, pattern] of [
      ["truncated", /bundle|outbox|count|identifier/iu],
      ["reordered", /outbox|completion|expected|count/iu],
      ["regenerated", /metadata|bundle|outbox|durable/iu],
      ["extra", /outbox|keys|metadata|durable/iu],
      ["accessor", /outbox|accessor|keys|durable/iu],
      ["proxy", /outbox|proxy|durable/iu],
      ["sparse-array", /outbox|array|dense|durable/iu],
      ["accessor-array", /outbox|array|data|durable/iu],
      ["custom-array", /outbox|array|prototype|durable/iu],
      ["proxy-array", /outbox|proxy|durable/iu],
      ["foreign", /NOT_FOUND|events|outbox/iu],
    ]) {
      const corruptBundle = makeAuthority({ appendProof: true });
      const corrupt = await prepareCompletedOutputBundle(corruptBundle, {
        title: `Corrupt ${mode}`,
        runId: `run_00000000-0000-4000-8000-0000000000${({
          truncated: "33",
          reordered: "34",
          regenerated: "35",
          extra: "36",
          accessor: "37",
          proxy: "38",
          "sparse-array": "42",
          "accessor-array": "43",
          "custom-array": "44",
          "proxy-array": "45",
          foreign: "46",
        })[mode]}`,
      });
      corruptBundle.repo.state.bundleMode = mode;
      await assert.rejects(
        () => corruptBundle.authority.reconcileIntegrationDispatches(context()),
        (error) => pattern.test(`${error?.code || ""} ${error?.message || ""}`)
      );
      assert.equal(corruptBundle.ledger.eventsForRun(corrupt.run.id).length, 0);
    }

    const ordinaryRecovery = makeAuthority({ appendProof: true });
    const ordinaryThread = (await ordinaryRecovery.authority.createIntegrationThread({ title: "Ordinary recovery" }, context())).thread;
    await ordinaryRecovery.authority.listIntegrationThreads({ limit: 5 }, context());
    const ordinaryRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000020",
      threadId: ordinaryThread.id,
      nativeSessionId: ordinaryRecovery.repo.state.threads.get(ordinaryThread.id).nativeSessionId,
      status: "completed",
      revision: 3,
      output: "",
      completedAt: now(),
    });
    ordinaryRecovery.repo.state.runs.set(ordinaryRun.id, ordinaryRun);
    const ordinaryTerminal = createPublicIntegrationEvent({
      threadId: ordinaryRun.threadId,
      runId: ordinaryRun.id,
      seq: 1,
      type: "run.completed",
      payload: {},
      createdAt: ordinaryRun.completedAt,
      previousHash: ZERO_DIGEST,
    });
    const ordinaryRecord = {
      outboxId: "out_ordinary_recovery",
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      threadId: ordinaryRun.threadId,
      runId: ordinaryRun.id,
      type: "run.completed",
      payload: {},
      createdAt: ordinaryRun.completedAt,
      expectedPreviousSeq: 0,
      expectedPreviousHash: ZERO_DIGEST,
      expectedEventHash: ordinaryTerminal.hash,
      delivered: false,
    };
    ordinaryRecovery.repo.state.outbox.set(ordinaryRecord.outboxId, ordinaryRecord);
    attachCompletionMetadata(ordinaryRecovery, ordinaryRun, [ordinaryRecord]);
    ordinaryRecovery.repo.state.failNextOutboxMark = true;
    await assert.rejects(() => ordinaryRecovery.authority.getIntegrationRunStatus({ runId: ordinaryRun.id }, context()));
    assert.equal(ordinaryRecovery.ledger.eventsForRun(ordinaryRun.id).length, 1);
    const recoveredStatus = await ordinaryRecovery.authority.getIntegrationRunStatus({ runId: ordinaryRun.id }, context());
    assert.equal(recoveredStatus.run.eventCursor.lastSeq, 1);
    assert.equal(ordinaryRecovery.ledger.eventsForRun(ordinaryRun.id).length, 1);
    assert.equal(ordinaryRecovery.repo.state.outbox.get("out_ordinary_recovery").delivered, true);

    const directAnswer = makeAuthority({ appendProof: true });
    const directThread = (await directAnswer.authority.createIntegrationThread({ title: "Direct answer" }, context())).thread;
    const directRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000021",
      threadId: directThread.id,
      nativeSessionId: directAnswer.repo.state.threads.get(directThread.id).nativeSessionId,
      status: "running",
      revision: 2,
      output: "",
      completedAt: null,
    });
    directAnswer.repo.state.runs.set(directRun.id, directRun);
    const directCompletedAt = now();
    const directClassification = classifyRunAgentResult(
      { sessionId: directRun.nativeSessionId, ok: true, result: "Direct answer.", persistedRuntimeRevision: 2 },
      { nativeSessionId: directRun.nativeSessionId }
    );
    const finishResult = await directAnswer.repo.repository.finishIntegrationRunWithOutbox({
      runId: directRun.id,
      threadId: directRun.threadId,
      nativeSessionId: directRun.nativeSessionId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: 2,
      expectedNativeRuntimeRevision: 1,
      completedNativeRuntimeRevision: 2,
      status: "completed",
      output: directClassification.output,
      error: null,
      completedAt: directCompletedAt,
      processOwner: fakeProcessOwner(directCompletedAt),
      expectedCursor: { firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 },
      outputEvent: outputEventForRunResult(directClassification, { createdAt: directCompletedAt }),
      terminalEvent: { type: "run.completed", payload: {}, createdAt: directCompletedAt },
      resultDigest: directClassification.digest,
    });
    assert.equal(finishResult.outboxEvents.length, 2);
    assert.deepEqual(finishResult.outboxEvents.map((record) => record.type), ["output.delta", "run.completed"]);
    assert.equal(finishResult.outboxEvents[0].createdAt, directCompletedAt);
    assert.equal(finishResult.outboxEvents[1].createdAt, directCompletedAt);
    const directStatus = await directAnswer.authority.getIntegrationRunStatus({ runId: directRun.id }, context());
    assert.equal(directStatus.run.output, "Direct answer.");
    assert.equal(directStatus.run.authority.runtimeRevision, 2);
    assert.equal(directStatus.run.eventCursor.lastSeq, 2);
    assert.equal(directStatus.run.eventCursor.lastHash, directAnswer.ledger.eventsForRun(directRun.id).at(-1).hash);
    assert.deepEqual(directAnswer.ledger.eventsForRun(directRun.id).map((event) => event.type), ["output.delta", "run.completed"]);
    assert.equal(directAnswer.ledger.eventsForRun(directRun.id)[0].createdAt, directCompletedAt);
    assert.equal(directAnswer.ledger.eventsForRun(directRun.id)[1].createdAt, directCompletedAt);

    const unsafeRunFixture = makeAuthority({ appendProof: true });
    const unsafeRunThread = (await unsafeRunFixture.authority.createIntegrationThread({ title: "Unsafe run" }, context())).thread;
    const unsafeOutputRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000028",
      threadId: unsafeRunThread.id,
      nativeSessionId: unsafeRunFixture.repo.state.threads.get(unsafeRunThread.id).nativeSessionId,
      status: "completed",
      revision: 3,
      output: "unsafe /scratch/a /nix/store/pkg /boot/vmlinuz /lib/libc.so /foo C:\\Users\\alice\\secret \\\\server\\share\\secret file:///tmp/secret",
      completedAt: now(),
      authority: { ...runRecord().authority, runtimeRevision: 2 },
    });
    unsafeRunFixture.repo.state.runs.set(unsafeOutputRun.id, unsafeOutputRun);
    await expectCode(
      () => unsafeRunFixture.authority.getIntegrationRunStatus({ runId: unsafeOutputRun.id }, context()),
      "UNSAFE_PRESENTATION"
    );
    const unsafeErrorMessageRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000030",
      threadId: unsafeRunThread.id,
      nativeSessionId: unsafeRunFixture.repo.state.threads.get(unsafeRunThread.id).nativeSessionId,
      status: "failed",
      revision: 3,
      output: "",
      error: { code: "AGINTI_RUNTIME_ERROR", message: "failed near /foo and file:///tmp/secret" },
      completedAt: now(),
      authority: { ...runRecord().authority, runtimeRevision: 2 },
    });
    unsafeRunFixture.repo.state.runs.set(unsafeErrorMessageRun.id, unsafeErrorMessageRun);
    await expectCode(
      () => unsafeRunFixture.authority.getIntegrationRunStatus({ runId: unsafeErrorMessageRun.id }, context()),
      "UNSAFE_PRESENTATION"
    );
    const unsafeErrorRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000029",
      threadId: unsafeRunThread.id,
      nativeSessionId: unsafeRunFixture.repo.state.threads.get(unsafeRunThread.id).nativeSessionId,
      status: "failed",
      revision: 3,
      output: "",
      error: { code: "SECRET_TOKEN", message: "provider token leaked" },
      completedAt: now(),
      authority: { ...runRecord().authority, runtimeRevision: 2 },
    });
    unsafeRunFixture.repo.state.runs.set(unsafeErrorRun.id, unsafeErrorRun);
    await expectCode(
      () => unsafeRunFixture.authority.getIntegrationRunStatus({ runId: unsafeErrorRun.id }, context()),
      "AGENT_UNAVAILABLE"
    );

    const artifactFixture = makeAuthority();
    const artifactThread = (await artifactFixture.authority.createIntegrationThread({ title: "Artifacts" }, context())).thread;
    artifactFixture.repo.state.artifacts.set(ARTIFACT_ID, plotArtifact({ threadId: artifactThread.id, runId: rawRun.id, published: false }));
    assert.equal((await artifactFixture.authority.listIntegrationArtifacts({ threadId: artifactThread.id }, context())).artifacts.length, 0);
    await artifactFixture.repo.repository.publishIntegrationArtifactOutbox({ artifactId: ARTIFACT_ID });
    assert.equal((await artifactFixture.authority.listIntegrationArtifacts({ threadId: artifactThread.id }, context())).artifacts.length, 1);
    const unsafeArtifactId = "art_".concat("e".repeat(64));
    artifactFixture.repo.state.artifacts.set(unsafeArtifactId, {
      ...plotArtifact({ id: unsafeArtifactId, threadId: artifactThread.id, runId: rawRun.id, published: true }),
      title: "/foo",
    });
    await expectCode(() => artifactFixture.authority.listIntegrationArtifacts({ threadId: artifactThread.id }, context()), "UNSAFE_PRESENTATION");
    artifactFixture.repo.state.artifacts.delete(unsafeArtifactId);
    artifactFixture.repo.state.artifacts.set("art_".concat("f".repeat(64)), {
      ...plotArtifact({ id: "art_".concat("f".repeat(64)), threadId: artifactThread.id, runId: rawRun.id, published: true }),
      url: "http://127.0.0.1/private",
    });
    await expectCode(() => artifactFixture.authority.listIntegrationArtifacts({ threadId: artifactThread.id }, context()), "UNSAFE_PRESENTATION");

    const projector = createIntegrationCoreEventProjector({ eventLedgerStore: ledger });
    const projectedTool = await projector.appendCoreEvent(
      "tool.started",
      { toolName: "run_command", callId: "raw-secret-call-id-/home/private", args: { command: "cat /etc/passwd" } },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000011" }
    );
    assert.equal(projectedTool.type, "tool.started");
    assert.equal(JSON.stringify(projectedTool).includes("raw-secret-call-id"), false);
    assert.equal(JSON.stringify(projectedTool).includes("/home/private"), false);
    const projectedToolProgress = await projector.appendCoreEvent(
      "tool.progress",
      { toolName: "run_command", callId: "different-raw-id", stdout: "secret" },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000011" }
    );
    assert.equal(projectedToolProgress.payload.callId, projectedTool.payload.callId);
    const projectedToolDone = await projector.appendCoreEvent(
      "tool.completed",
      { toolName: "run_command", callId: "third-raw-id", result: "secret" },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000011" }
    );
    assert.equal(projectedToolDone.payload.callId, projectedTool.payload.callId);
    assert.equal(await projector.appendCoreEvent(
      "tool.progress",
      { toolName: "run_command" },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000011" }
    ), null);
    const rollbackRunId = "run_00000000-0000-4000-8000-000000000024";
    const rollbackLedger = makeEventLedgerStore({ failAppends: 1 });
    const rollbackProjector = createIntegrationCoreEventProjector({ eventLedgerStore: rollbackLedger });
    await assert.rejects(() =>
      rollbackProjector.appendCoreEvent(
        "tool.started",
        { toolName: "run_command", callId: "raw-failed-start" },
        { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: rollbackRunId }
      )
    );
    const observerFailureRunId = "run_00000000-0000-4000-8000-000000000036";
    const observerFailureLedger = makeEventLedgerStore({ failAppends: 1 });
    const observerFailureProjector = createIntegrationCoreEventProjector({ eventLedgerStore: observerFailureLedger });
    let observerTail = Promise.resolve();
    observerTail = observerTail.then(() =>
      observerFailureProjector.appendCoreEvent(
        "output.delta",
        { text: "Accepted event must not be lost." },
        { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: observerFailureRunId }
      )
    );
    observerTail.catch(() => {});
    await assert.rejects(() => observerTail, /append failed/iu);
    assert.equal(observerFailureLedger.eventsForRun(observerFailureRunId).length, 0);
    const rollbackStarted = await rollbackProjector.appendCoreEvent(
      "tool.started",
      { toolName: "run_command", callId: "raw-retry-start" },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: rollbackRunId }
    );
    assert.equal(
      rollbackStarted.payload.callId,
      `tool_${contractDigest({ runId: rollbackRunId, toolKey: "run_command", ordinal: 1 }).slice(0, 32)}`
    );
    const rollbackCompleted = await rollbackProjector.appendCoreEvent(
      "tool.completed",
      { toolName: "run_command", callId: "raw-complete", result: "private" },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: rollbackRunId }
    );
    assert.equal(rollbackCompleted.payload.callId, rollbackStarted.payload.callId);
    const terminalClearRunId = "run_00000000-0000-4000-8000-000000000025";
    const terminalLoadCalls = [];
    const terminalClearLedger = makeEventLedgerStore({ onLoadEventsAfter: (call) => terminalLoadCalls.push(call) });
    const terminalClearProjector = createIntegrationCoreEventProjector({ eventLedgerStore: terminalClearLedger });
    assert.equal(Object.prototype.hasOwnProperty.call(terminalClearProjector, "appendProjectedEvent"), false);
    await terminalClearProjector.appendCoreEvent(
      "run.status",
      { status: "running" },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: terminalClearRunId }
    );
    await terminalClearProjector.appendCoreEvent(
      "tool.started",
      { toolName: "run_command" },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: terminalClearRunId }
    );
    await terminalClearProjector.appendAuthorityTerminalEvent(
      "run.completed",
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: terminalClearRunId }
    );
    terminalLoadCalls.length = 0;
    await assert.rejects(() =>
      terminalClearProjector.appendCoreEvent(
        "run.status",
        { status: "running" },
        { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: terminalClearRunId }
      )
    );
    assert.deepEqual(terminalLoadCalls.map((call) => call.afterSeq), [2]);
    const terminalReloadProjector = createIntegrationCoreEventProjector({ eventLedgerStore: terminalClearLedger });
    terminalLoadCalls.length = 0;
    await assert.rejects(() =>
      terminalReloadProjector.appendCoreEvent(
        "run.status",
        { status: "running" },
        { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: terminalClearRunId }
      )
    );
    assert.deepEqual(terminalLoadCalls.map((call) => call.afterSeq), [2]);
    assert.equal(await projector.appendCoreEvent(
      "session.finished",
      { result: "forged terminal" },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000012" }
    ), null);
    assert.equal(await projector.appendCoreEvent(
      "artifact.available",
      { artifact: plotArtifact({ threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000013" }) },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000013" }
    ), null);
    assert.equal(await projector.appendCoreEvent(
      "plan.created",
      { steps: [{ id: "one", label: "Plan", status: "pending" }] },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000014" }
    ), null);

    const substitutionLedger = makeEventLedgerStore({ substituteAppend: true });
    const substitutionProjector = createIntegrationCoreEventProjector({ eventLedgerStore: substitutionLedger });
    await assert.rejects(() =>
      substitutionProjector.appendCoreEvent(
        "output.delta",
        { text: "Public text" },
        { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000015" }
      )
    );
    const badCursorLedger = makeEventLedgerStore({ badZeroHead: true });
    const badCursorProjector = createIntegrationCoreEventProjector({ eventLedgerStore: badCursorLedger });
    await assert.rejects(() =>
      badCursorProjector.appendCoreEvent(
        "run.status",
        { status: "running" },
        { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000016" }
      )
    );
    const extraEventLedger = makeEventLedgerStore({ extraPublicEventField: true });
    const extraEventProjector = createIntegrationCoreEventProjector({ eventLedgerStore: extraEventLedger });
    await assert.rejects(() =>
      extraEventProjector.appendCoreEvent(
        "run.status",
        { status: "running" },
        { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: "run_00000000-0000-4000-8000-000000000026" }
      )
    );

    const cancelFixture = makeAuthority();
    const cancelThread = (await cancelFixture.authority.createIntegrationThread({ title: "Cancel" }, context())).thread;
    const cancelRaw = runRecord({
      id: "run_00000000-0000-4000-8000-000000000017",
      threadId: cancelThread.id,
      nativeSessionId: cancelFixture.repo.state.threads.get(cancelThread.id).nativeSessionId,
      status: "running",
      revision: 2,
    });
    cancelFixture.repo.state.runs.set(cancelRaw.id, cancelRaw);
    const cancelled = await cancelFixture.authority.cancelIntegrationRun({ runId: cancelRaw.id }, context());
    assert.equal(cancelled.run.cancelRequestedAt !== null, true);
    const firstCancelTimestamp = cancelRaw.cancelRequestedAt;
    assert.equal(callsNamed(cancelFixture, "markIntegrationRunCancelling").length, 1);
    cancelFixture.repo.state.failNextCancel = true;
    const cancelRetry = await cancelFixture.authority.cancelIntegrationRun({ runId: cancelRaw.id }, context());
    assert.equal(cancelRetry.run.id, cancelRaw.id);
    assert.equal(cancelRaw.cancelRequestedAt, firstCancelTimestamp);
    assert.equal(cancelRaw.revision, 3);
    assert.equal(callsNamed(cancelFixture, "markIntegrationRunCancelling").length, 1);
    cancelFixture.repo.state.failNextCancel = false;
    for (const [index, marker] of [
      ["missing", Symbol("missing")],
      ["undefined", undefined],
      ["false", false],
      ["zero", 0],
      ["empty", ""],
    ].entries()) {
      const malformedCancelMarker = makeAuthority();
      const malformedCancelThread = (await malformedCancelMarker.authority.createIntegrationThread({ title: `Malformed cancel marker ${marker[0]}` }, context())).thread;
      const malformedCancelRun = runRecord({
        id: `run_00000000-0000-4000-8000-00000000012${index}`,
        threadId: malformedCancelThread.id,
        nativeSessionId: malformedCancelMarker.repo.state.threads.get(malformedCancelThread.id).nativeSessionId,
        status: "running",
        revision: 3,
      });
      if (marker[0] === "missing") delete malformedCancelRun.cancelRequestedAt;
      else malformedCancelRun.cancelRequestedAt = marker[1];
      malformedCancelMarker.repo.state.runs.set(malformedCancelRun.id, malformedCancelRun);
      await expectCode(
        () => malformedCancelMarker.authority.cancelIntegrationRun({ runId: malformedCancelRun.id }, context()),
        "AGENT_UNAVAILABLE"
      );
      assert.equal(callsNamed(malformedCancelMarker, "markIntegrationRunCancelling").length, 0);
    }
    const cancelCompletedSubstitution = makeAuthority();
    const cancelCompletedThread = (await cancelCompletedSubstitution.authority.createIntegrationThread({ title: "Cancel substitution" }, context())).thread;
    const cancelCompletedRaw = runRecord({
      id: "run_00000000-0000-4000-8000-000000000022",
      threadId: cancelCompletedThread.id,
      nativeSessionId: cancelCompletedSubstitution.repo.state.threads.get(cancelCompletedThread.id).nativeSessionId,
      status: "running",
      revision: 2,
    });
    cancelCompletedSubstitution.repo.state.runs.set(cancelCompletedRaw.id, cancelCompletedRaw);
    cancelCompletedSubstitution.repo.state.substituteCancelCompleted = true;
    await expectCode(
      () => cancelCompletedSubstitution.authority.cancelIntegrationRun({ runId: cancelCompletedRaw.id }, context()),
      "AGENT_UNAVAILABLE"
    );
    const cancelMissingOwner = makeAuthority();
    const cancelMissingOwnerThread = (await cancelMissingOwner.authority.createIntegrationThread({ title: "Cancel owner" }, context())).thread;
    const cancelMissingOwnerRaw = runRecord({
      id: "run_00000000-0000-4000-8000-000000000023",
      threadId: cancelMissingOwnerThread.id,
      nativeSessionId: cancelMissingOwner.repo.state.threads.get(cancelMissingOwnerThread.id).nativeSessionId,
      status: "running",
      revision: 2,
    });
    cancelMissingOwner.repo.state.runs.set(cancelMissingOwnerRaw.id, cancelMissingOwnerRaw);
    cancelMissingOwner.repo.state.omitCancelProcessOwner = true;
    await expectCode(
      () => cancelMissingOwner.authority.cancelIntegrationRun({ runId: cancelMissingOwnerRaw.id }, context()),
      "AGENT_UNAVAILABLE"
    );
    const cancelMutableOwner = makeAuthority();
    const cancelMutableThread = (await cancelMutableOwner.authority.createIntegrationThread({ title: "Cancel mutable owner" }, context())).thread;
    const cancelMutableRaw = runRecord({
      id: "run_00000000-0000-4000-8000-000000000048",
      threadId: cancelMutableThread.id,
      nativeSessionId: cancelMutableOwner.repo.state.threads.get(cancelMutableThread.id).nativeSessionId,
      status: "running",
      revision: 2,
    });
    cancelMutableOwner.repo.state.runs.set(cancelMutableRaw.id, cancelMutableRaw);
    cancelMutableOwner.repo.state.cancelProcessOwnerMode = "mutable";
    const mutableCancel = await cancelMutableOwner.authority.cancelIntegrationRun({ runId: cancelMutableRaw.id }, context());
    assert.equal(mutableCancel.run.cancelRequestedAt !== null, true);

    for (const mode of [
      "owner-proxy",
      "identity-proxy",
      "owner-accessor",
      "identity-accessor",
      "owner-custom-proto-then",
      "identity-custom-proto-then",
      "identity-inherited-boot",
      "owner-extra-string",
      "owner-extra-symbol",
      "identity-extra-string",
      "identity-extra-symbol",
      "pid-string",
      "token-object",
      "boot-uppercase",
      "boot-object",
      "ticks-number",
    ]) {
      const poisonedOwner = makeAuthority();
      const poisonedThread = (await poisonedOwner.authority.createIntegrationThread({ title: `Cancel ${mode}` }, context())).thread;
      const poisonedRun = runRecord({
        id: `run_00000000-0000-4000-8000-${String(49 + mode.length).padStart(12, "0")}`,
        threadId: poisonedThread.id,
        nativeSessionId: poisonedOwner.repo.state.threads.get(poisonedThread.id).nativeSessionId,
        status: "running",
        revision: 2,
      });
      poisonedOwner.repo.state.runs.set(poisonedRun.id, poisonedRun);
      poisonedOwner.repo.state.cancelProcessOwnerMode = mode;
      await expectCode(
        () => poisonedOwner.authority.cancelIntegrationRun({ runId: poisonedRun.id }, context()),
        "AGENT_UNAVAILABLE"
      );
      assert.equal(poisonedOwner.repo.state.processOwnerTrapCount, 0);
    }

    const cancelNestedProxy = makeAuthority();
    const cancelNestedThread = (await cancelNestedProxy.authority.createIntegrationThread({ title: "Cancel nested proxy" }, context())).thread;
    const cancelNestedRaw = runRecord({
      id: "run_00000000-0000-4000-8000-000000000030",
      threadId: cancelNestedThread.id,
      nativeSessionId: cancelNestedProxy.repo.state.threads.get(cancelNestedThread.id).nativeSessionId,
      status: "running",
      revision: 2,
    });
    cancelNestedProxy.repo.state.runs.set(cancelNestedRaw.id, cancelNestedRaw);
    cancelNestedProxy.repo.state.proxyCancelProcessIdentity = true;
    await expectCode(
      () => cancelNestedProxy.authority.cancelIntegrationRun({ runId: cancelNestedRaw.id }, context()),
      "AGENT_UNAVAILABLE"
    );
    assert.equal(cancelNestedProxy.repo.state.processOwnerTrapCount, 0);

    const authoritySource = await fs.readFile(new URL("../src/integration-runtime-authority.js", import.meta.url), "utf8");
    const registrySource = await fs.readFile(new URL("../src/integration-run-registry.js", import.meta.url), "utf8");
    assert.ok(authoritySource.includes("const NativePromise = Promise;"));
    assert.ok(authoritySource.includes("const ObjectGetPrototypeOf = Object.getPrototypeOf;"));
    assert.ok(authoritySource.includes("const PromisePrototypeThen = PromisePrototype.then;"));
    assert.ok(authoritySource.includes("const ReflectApply = Reflect.apply;"));
    assert.ok(authoritySource.includes("new NativePromise("));
    assert.ok(authoritySource.includes("ReflectApply(PromisePrototypeThen, worker, [deferred.resolve, deferred.reject])"));
    assert.ok(registrySource.includes("const ObjectGetPrototypeOf = Object.getPrototypeOf;"));
    assert.ok(registrySource.includes("const PromisePrototypeThen = Promise.prototype.then;"));
    assert.ok(registrySource.includes("const ReflectApply = Reflect.apply;"));
    const launchStart = authoritySource.indexOf("function launchExecutor");
    const launchEnd = authoritySource.indexOf("function getIntegrationRuntimeProof", launchStart);
    assert.notEqual(launchStart, -1);
    assert.notEqual(launchEnd, -1);
    const launchBody = authoritySource.slice(launchStart, launchEnd);
    const attachPosition = launchBody.indexOf("runRegistry.attachPromise(run.id, deferred.promise)");
    const releasePosition = launchBody.indexOf("function releaseAuthorizedNativeExecution");
    const executePosition = launchBody.indexOf("executeNativeAgintiRun(prepared.config)");
    assert.ok(attachPosition > 0);
    assert.ok(releasePosition > attachPosition);
    assert.ok(executePosition > attachPosition);
    assert.ok(executePosition > releasePosition);
    assert.equal(launchBody.includes("const promise = (async () =>"), false);
    for (const [methodName, nextMethodName] of [
      ["async startIntegrationRun", "async getIntegrationRunStatus"],
      ["async resumeIntegrationRun", "async listIntegrationArtifacts"],
    ]) {
      const methodStart = authoritySource.indexOf(methodName);
      const methodEnd = authoritySource.indexOf(nextMethodName, methodStart + methodName.length);
      assert.notEqual(methodStart, -1);
      assert.notEqual(methodEnd, -1);
      const methodBody = authoritySource.slice(methodStart, methodEnd);
      const launchCall = methodBody.indexOf("nativeLaunch = launchExecutor");
      const authorizeCall = methodBody.indexOf("authorizeNativeStart(authorization");
      const releaseCall = methodBody.indexOf("nativeLaunch.releaseAuthorizedNativeExecution");
      assert.ok(launchCall > 0);
      assert.ok(authorizeCall > launchCall);
      assert.ok(releaseCall > authorizeCall);
    }
    const assertNoActiveRunStart = authoritySource.indexOf("async function assertNoActiveRun");
    const assertNoActiveRunEnd = authoritySource.indexOf("function assertRunFields", assertNoActiveRunStart);
    assert.notEqual(assertNoActiveRunStart, -1);
    assert.notEqual(assertNoActiveRunEnd, -1);
    const assertNoActiveRunBody = authoritySource.slice(assertNoActiveRunStart, assertNoActiveRunEnd);
    const registryActiveCheck = assertNoActiveRunBody.indexOf("runRegistry.hasActiveThreadRun(thread.id)");
    const repositoryActiveCheck = assertNoActiveRunBody.indexOf('callRepository("getActiveIntegrationRunForThread"');
    assert.ok(registryActiveCheck > 0);
    assert.ok(repositoryActiveCheck > registryActiveCheck);
    const updateThreadStart = authoritySource.indexOf("async updateIntegrationThread");
    const updateThreadEnd = authoritySource.indexOf("async deleteIntegrationThread", updateThreadStart);
    assert.notEqual(updateThreadStart, -1);
    assert.notEqual(updateThreadEnd, -1);
    const updateThreadBody = authoritySource.slice(updateThreadStart, updateThreadEnd);
    const updateGuardPosition = updateThreadBody.indexOf("await assertNoActiveRun(current, scope)");
    const updateRepositoryPosition = updateThreadBody.indexOf('callRepository("updateIntegrationThread"');
    assert.ok(updateGuardPosition > 0);
    assert.ok(updateRepositoryPosition > updateGuardPosition);

    const invalidRegistry = createIntegrationRunRegistry();
    const invalidRunId = "run_00000000-0000-4000-8000-000000000018";
    const invalidThreadId = "thr_00000000-0000-4000-8000-000000000018";
    invalidRegistry.claimRun({ runId: invalidRunId, threadId: invalidThreadId, principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, controller: new AbortController() });
    let proxyTrapCount = 0;
    const proxiedPromise = new Proxy(Promise.resolve("no traps"), {
      get(target, property, receiver) {
        proxyTrapCount += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await expectCode(() => invalidRegistry.attachPromise(invalidRunId, proxiedPromise), "AGENT_UNAVAILABLE");
    assert.equal(proxyTrapCount, 0);
    assert.equal(invalidRegistry.snapshot().activeRuns, 0);
    invalidRegistry.claimRun({ runId: invalidRunId, threadId: invalidThreadId, principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, controller: new AbortController() });
    let poisonedThenTrap = 0;
    const poisonedOwnThen = Promise.resolve("poisoned");
    Object.defineProperty(poisonedOwnThen, "then", {
      enumerable: true,
      configurable: true,
      get() {
        poisonedThenTrap += 1;
        return Promise.prototype.then;
      },
    });
    await expectCode(() => invalidRegistry.attachPromise(invalidRunId, poisonedOwnThen), "AGENT_UNAVAILABLE");
    assert.equal(poisonedThenTrap, 0);
    assert.equal(invalidRegistry.snapshot().activeRuns, 0);

    const postAls = new AsyncLocalStorage();
    await postAls.run({ smoke: "native-promise-symbol-metadata" }, async () => {});
    const postAlsRegistry = createIntegrationRunRegistry();
    const postAlsRunId = "run_00000000-0000-4000-8000-000000000022";
    const postAlsThreadId = "thr_00000000-0000-4000-8000-000000000022";
    const postAlsNativeSessionId = "aginti:00000000-0000-4000-8000-000000000022";
    let resolvePostAlsPromise;
    const postAlsPromise = new Promise((resolve) => {
      resolvePostAlsPromise = resolve;
    });
    assert.equal(Object.getPrototypeOf(postAlsPromise), Promise.prototype);
    const postAlsPromiseKeys = Reflect.ownKeys(postAlsPromise);
    assert.ok(postAlsPromiseKeys.length > 0);
    assert.equal(postAlsPromiseKeys.every((key) => typeof key === "symbol"), true);
    postAlsRegistry.claimRun({
      runId: postAlsRunId,
      threadId: postAlsThreadId,
      nativeSessionId: postAlsNativeSessionId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      controller: new AbortController(),
    });
    assert.equal(postAlsRegistry.attachPromise(postAlsRunId, postAlsPromise), postAlsPromise);
    assert.deepEqual(postAlsRegistry.getLiveRunClaim(postAlsRunId, context()), {
      runId: postAlsRunId,
      threadId: postAlsThreadId,
      nativeSessionId: postAlsNativeSessionId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      claimedAt: postAlsRegistry.getRun(postAlsRunId, context()).claimedAt,
    });
    resolvePostAlsPromise("post-als-ok");
    await postAlsPromise;
    await delay(0);
    assert.equal(postAlsRegistry.snapshot().activeRuns, 0);

    const inertSymbolRegistry = createIntegrationRunRegistry();
    const inertSymbolRunId = "run_00000000-0000-4000-8000-000000000023";
    const inertSymbolThreadId = "thr_00000000-0000-4000-8000-000000000023";
    const inertSymbolNativeSessionId = "aginti:00000000-0000-4000-8000-000000000023";
    let resolveInertSymbolPromise;
    const inertSymbolPromise = new Promise((resolve) => {
      resolveInertSymbolPromise = resolve;
    });
    inertSymbolPromise[Symbol("inert-test-metadata")] = Object.freeze({ smoke: true });
    inertSymbolRegistry.claimRun({
      runId: inertSymbolRunId,
      threadId: inertSymbolThreadId,
      nativeSessionId: inertSymbolNativeSessionId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      controller: new AbortController(),
    });
    assert.equal(inertSymbolRegistry.attachPromise(inertSymbolRunId, inertSymbolPromise), inertSymbolPromise);
    assert.ok(inertSymbolRegistry.getLiveRunClaim(inertSymbolRunId, context()));
    resolveInertSymbolPromise("inert-symbol-ok");
    await inertSymbolPromise;
    await delay(0);
    assert.equal(inertSymbolRegistry.snapshot().activeRuns, 0);

    const invalidPromiseCandidates = [
      Object.create(Promise.prototype),
      (() => {
        class SubclassPromise extends Promise {}
        return new SubclassPromise((resolve) => resolve("subclass"));
      })(),
      (() => {
        const promise = Promise.resolve("extra");
        promise.extra = true;
        return promise;
      })(),
      (() => {
        const promise = Promise.resolve("hidden-string");
        Object.defineProperty(promise, "hidden", { enumerable: false, configurable: true, value: true });
        return promise;
      })(),
      (() => {
        const promise = Promise.resolve("finally");
        Object.defineProperty(promise, "finally", { enumerable: true, configurable: true, value: () => {} });
        return promise;
      })(),
      (() => {
        const promise = Promise.resolve("catch");
        Object.defineProperty(promise, "catch", { enumerable: true, configurable: true, value: () => {} });
        return promise;
      })(),
      (() => {
        const promise = Promise.resolve("constructor");
        Object.defineProperty(promise, "constructor", { enumerable: true, configurable: true, value: Promise });
        return promise;
      })(),
    ];
    for (let index = 0; index < invalidPromiseCandidates.length; index += 1) {
      const candidate = invalidPromiseCandidates[index];
      const registry = createIntegrationRunRegistry();
      const runId = `run_00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`;
      const threadId = `thr_00000000-0000-4000-8000-${runId.slice(-12)}`;
      registry.claimRun({ runId, threadId, principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, controller: new AbortController() });
      await expectCode(() => registry.attachPromise(runId, candidate), "AGENT_UNAVAILABLE");
      assert.equal(registry.snapshot().activeRuns, 0);
    }

    const resolvingRegistry = createIntegrationRunRegistry();
    const resolvingRunId = "run_00000000-0000-4000-8000-000000000019";
    const resolvingThreadId = "thr_00000000-0000-4000-8000-000000000019";
    resolvingRegistry.claimRun({ runId: resolvingRunId, threadId: resolvingThreadId, principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, controller: new AbortController() });
    const resolvingPromise = Promise.resolve("resolved");
    assert.equal(resolvingRegistry.attachPromise(resolvingRunId, resolvingPromise), resolvingPromise);
    await resolvingPromise;
    await delay(0);
    assert.equal(resolvingRegistry.snapshot().activeRuns, 0);

    const rejectingRegistry = createIntegrationRunRegistry();
    const registryController = new AbortController();
    const registryRunId = "run_00000000-0000-4000-8000-000000000020";
    const registryThreadId = "thr_00000000-0000-4000-8000-000000000020";
    rejectingRegistry.claimRun({ runId: registryRunId, threadId: registryThreadId, principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, controller: registryController });
    const rejectingPromise = Promise.reject(new Error("registry rejection"));
    assert.equal(rejectingRegistry.attachPromise(registryRunId, rejectingPromise), rejectingPromise);
    await assert.rejects(() => rejectingRegistry.getRun(registryRunId, context()).promise);
    await delay(0);
    assert.equal(rejectingRegistry.snapshot().activeRuns, 0);
    assert.equal(unhandled.length, 0);

    const secondAttachRegistry = createIntegrationRunRegistry();
    const secondRunId = "run_00000000-0000-4000-8000-000000000021";
    const secondThreadId = "thr_00000000-0000-4000-8000-000000000021";
    secondAttachRegistry.claimRun({ runId: secondRunId, threadId: secondThreadId, principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, controller: new AbortController() });
    let releaseFirst;
    const firstPromise = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    secondAttachRegistry.attachPromise(secondRunId, firstPromise);
    await expectCode(() => secondAttachRegistry.attachPromise(secondRunId, Promise.resolve("second")), "RUN_CONFLICT");
    assert.equal(secondAttachRegistry.snapshot().activeRuns, 1);
    releaseFirst("done");
    await firstPromise;
    await delay(0);
    assert.equal(secondAttachRegistry.snapshot().activeRuns, 0);

    const onePromiseOneRunRegistry = createIntegrationRunRegistry();
    const onePromiseOriginalRunId = "run_00000000-0000-4000-8000-000000000024";
    const onePromiseOriginalThreadId = "thr_00000000-0000-4000-8000-000000000024";
    const onePromiseOriginalNativeSessionId = "aginti:00000000-0000-4000-8000-000000000024";
    let resolveOnePromise;
    const onePromise = new Promise((resolve) => {
      resolveOnePromise = resolve;
    });
    onePromise[Symbol("inert-one-run-metadata")] = Object.freeze({ smoke: true });
    onePromiseOneRunRegistry.claimRun({
      runId: onePromiseOriginalRunId,
      threadId: onePromiseOriginalThreadId,
      nativeSessionId: onePromiseOriginalNativeSessionId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      controller: new AbortController(),
    });
    assert.equal(onePromiseOneRunRegistry.attachPromise(onePromiseOriginalRunId, onePromise), onePromise);
    const onePromiseOriginal = onePromiseOneRunRegistry.getRun(onePromiseOriginalRunId, context());
    assert.equal(onePromiseOriginal.promise, onePromise);
    assert.ok(onePromiseOneRunRegistry.getLiveRunClaim(onePromiseOriginalRunId, context()));
    const promiseSpeciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
    let duplicateAttachSpeciesCalls = 0;
    function ThrowingDuplicateAttachSpecies(executor) {
      duplicateAttachSpeciesCalls += 1;
      throw new Error("duplicate attach must not install a promise observer");
    }
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      value: ThrowingDuplicateAttachSpecies,
    });
    async function expectPromiseReuseRejected(runId, threadId, nativeSessionId, label) {
      onePromiseOneRunRegistry.claimRun({
        runId,
        threadId,
        nativeSessionId,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
        controller: new AbortController(),
      });
      await expectCode(() => onePromiseOneRunRegistry.attachPromise(runId, onePromise), "RUN_CONFLICT");
      assert.equal(onePromiseOneRunRegistry.getRun(runId, context()), null, label);
      assert.equal(duplicateAttachSpeciesCalls, 0, label);
    }
    try {
      await expectPromiseReuseRejected(
        "run_00000000-0000-4000-8000-000000000025",
        "thr_00000000-0000-4000-8000-000000000025",
        "aginti:00000000-0000-4000-8000-000000000025",
        "simultaneous duplicate promise claim"
      );
      const onePromiseOriginalAfterDuplicate = onePromiseOneRunRegistry.getRun(onePromiseOriginalRunId, context());
      assert.equal(onePromiseOriginalAfterDuplicate.promise, onePromise);
      assert.equal(onePromiseOriginalAfterDuplicate.claimedAt, onePromiseOriginal.claimedAt);
      assert.equal(onePromiseOriginalAfterDuplicate.threadId, onePromiseOriginalThreadId);
      assert.equal(onePromiseOriginalAfterDuplicate.nativeSessionId, onePromiseOriginalNativeSessionId);
      assert.equal(onePromiseOneRunRegistry.snapshot().activeRuns, 1);
      assert.deepEqual(onePromiseOneRunRegistry.releaseRun(onePromiseOriginalRunId), {
        released: true,
        runId: onePromiseOriginalRunId,
      });
      assert.equal(onePromiseOneRunRegistry.snapshot().activeRuns, 0);
      await expectPromiseReuseRejected(
        "run_00000000-0000-4000-8000-000000000026",
        "thr_00000000-0000-4000-8000-000000000026",
        "aginti:00000000-0000-4000-8000-000000000026",
        "released pending duplicate promise claim"
      );
      resolveOnePromise("one-promise-one-run");
      await onePromise;
      await delay(0);
      await expectPromiseReuseRejected(
        "run_00000000-0000-4000-8000-000000000027",
        "thr_00000000-0000-4000-8000-000000000027",
        "aginti:00000000-0000-4000-8000-000000000027",
        "settled duplicate promise claim"
      );
      assert.equal(onePromiseOneRunRegistry.snapshot().activeRuns, 0);
    } finally {
      if (promiseSpeciesDescriptor) Object.defineProperty(Promise, Symbol.species, promiseSpeciesDescriptor);
      else delete Promise[Symbol.species];
    }

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-executor-smoke-"));
    try {
      const runAgentResult = await runAgent({
        provider: "mock",
        model: "mock-agent",
        goal: "hello",
        sessionId: "aginti-smoke-direct",
        sessionsDir: path.join(tempRoot, ".sessions"),
        baseDir: tempRoot,
        commandCwd: tempRoot,
        allowShellTool: false,
        allowFileTools: false,
        allowWrapperTools: false,
        allowAuxiliaryTools: false,
        allowWebSearch: false,
        allowMcpTools: false,
        allowParallelScouts: false,
        allowHostedImagePerception: false,
        allowHostedWebResearch: false,
        allowHostedJsonSpecialist: false,
        allowHostedWritingSpecialist: false,
        allowAgentLinkTools: false,
        allowCoordinationTools: false,
        allowBrowserTools: false,
        allowCanvasTools: false,
        useDockerSandbox: false,
        allowedDomains: [],
        readOnlyRoots: [],
        readOnlyHostMounts: [],
        packageInstallPolicy: "block",
        sandboxMode: "host",
        maxSteps: 1,
        onConsole() {},
      });
      assert.equal(runAgentResult.sessionId, "aginti-smoke-direct");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }

    finalSmokeOk = true;
    process.stdout.write("integration runtime authority smoke: ok\n");
  } finally {
    clearTimeout(finalSmokeWatchdog);
    process.removeListener("unhandledRejection", onUnhandled);
    await fs.rm(SMOKE_ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`integration runtime authority smoke: failed (${String(error?.code || error?.name || "ERROR")})\n`);
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
