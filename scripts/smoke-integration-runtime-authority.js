#!/usr/bin/env node
import assert from "node:assert/strict";
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

const PRINCIPAL = "principalAAAAAAAA";
const OTHER_PRINCIPAL = "principalBBBBBBBB";
const BROWSER_SESSION = "a".repeat(64);
const OTHER_BROWSER_SESSION = "b".repeat(64);
const ZERO_DIGEST = "0".repeat(64);
const CONTEXT_DIGEST = "c".repeat(64);
const SNAPSHOT_HASH = "d".repeat(64);
const ARTIFACT_ID = `art_${"e".repeat(64)}`;
const SMOKE_ROOT = "/home/lachlan/ProjectsLFS/Agent/AgInTiFlow/.integration-runtime-authority-smoke-root";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    failNextDispatch: false,
    failNextCancel: false,
    failNextOutboxMark: false,
    substituteDispatchThread: false,
    substituteCancelCompleted: false,
    omitCancelProcessOwner: false,
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
    terminalOutbox: true,
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
    return run && run.principalId === payload.principalId && run.browserSessionId === payload.browserSessionId ? run : null;
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
      return { thread: ownedThread(payload) };
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
      return {
        run:
          [...state.runs.values()].find(
            (run) =>
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
      return { run };
    },
    async markIntegrationRunDispatching(payload) {
      calls.push(["markIntegrationRunDispatching", payload]);
      const run = ownedRun(payload);
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
        threadId: state.substituteDispatchThread ? "thr_00000000-0000-4000-8000-000000000001" : run.threadId,
        status: "running",
        dispatchLeaseId: payload.dispatchLeaseId,
        dispatchOutbox: payload.dispatchOutbox,
        processOwner: payload.processOwner,
        dispatchedAt: payload.dispatchedAt,
        revision: run.revision + 1,
      });
      return { run };
    },
    async getIntegrationRun(payload) {
      calls.push(["getIntegrationRun", payload]);
      return { run: ownedRun(payload) };
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
        processOwner: state.omitCancelProcessOwner ? undefined : payload.processOwner,
        revision: run.revision + 1,
      });
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
      return { run, outboxEvents: makeOutboxRecords(run, payload) };
    },
    async reconcileIntegrationDispatches(payload) {
      calls.push(["reconcileIntegrationDispatches", payload]);
      return {
        reconciled: true,
        pendingOutboxEvents: [...state.outbox.values()].filter(
          (record) =>
            !record.delivered &&
            record.principalId === payload.principalId &&
            record.browserSessionId === payload.browserSessionId
        ),
      };
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
      if (state.failNextOutboxMark) {
        state.failNextOutboxMark = false;
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
      const stored = Object.freeze({
        ...event,
        outboxId: eventInput.outboxId,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
      });
      events.push(stored);
      ledgers.set(key, events);
      byOutboxId.set(eventInput.outboxId, stored);
      return stored;
    },
    lookupByOutboxId(_scope, input) {
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

async function expectCode(action, code) {
  await assert.rejects(action, (error) => error?.code === code || error?.publicCode === code);
}

async function writeNativeState(config, state) {
  const sessionDir = path.join(config.sessionsDir, config.sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function main() {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    assert.equal(classifyRunAgentResult({ sessionId: "aginti:one", ok: true, result: "Direct answer." }, { nativeSessionId: "aginti:one" }).status, "completed");
    assert.equal(classifyRunAgentResult({ sessionId: "aginti:one", stopped: true, reason: "user_interrupt" }, { nativeSessionId: "aginti:one" }).status, "cancelled");
    assert.equal(classifyRunAgentResult({ sessionId: "aginti:one", ok: false, reason: "provider_error" }, { nativeSessionId: "aginti:one" }).status, "failed");
    assert.equal(classifyRunAgentResult({ sessionId: "aginti:one", stopped: true, reason: "max_steps_reached" }, { nativeSessionId: "aginti:one" }).status, "failed");
    assert.equal(classifyRunAgentResult({ sessionId: "aginti:one", stopped: true, reason: "model_timeout" }, { nativeSessionId: "aginti:one" }).status, "failed");
    assert.equal(classifyRunAgentResult({ sessionId: "aginti:one", stopped: true, reason: "some_other_stop" }, { nativeSessionId: "aginti:one" }).status, "failed");
    assert.equal(classifyRunAgentResult({ sessionId: "aginti:one", stopped: true, ok: false, reason: "user_interrupt" }, { nativeSessionId: "aginti:one" }).status, "failed");
    assert.throws(() => classifyRunAgentResult({ sessionId: "aginti:two", ok: true }, { nativeSessionId: "aginti:one" }), /RUN_AGENT_SESSION_MISMATCH|sessionId/);
    const abortController = new AbortController();
    abortController.abort(new Error("cancelled"));
    assert.equal(classifyRunAgentError(new Error("boom"), { abortSignal: abortController.signal }).status, "cancelled");
    const outputEvent = outputEventForRunResult(classifyRunAgentResult({ sessionId: "aginti:one", ok: true, result: "Direct answer." }, { nativeSessionId: "aginti:one" }));
    assert.equal(outputEvent.payload.text, "Direct answer.");
    const completionCreatedAt = now();
    const timedOutputEvent = outputEventForRunResult(
      classifyRunAgentResult({ sessionId: "aginti:one", ok: true, result: "Direct answer." }, { nativeSessionId: "aginti:one" }),
      { createdAt: completionCreatedAt }
    );
    assert.equal(timedOutputEvent.createdAt, completionCreatedAt);
    assert.throws(
      () =>
        outputEventForRunResult(
          classifyRunAgentResult({ sessionId: "aginti:one", ok: true, result: "Direct answer." }, { nativeSessionId: "aginti:one" }),
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
        runtimeConfig: hostileStoredRuntime,
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
        runtimeConfig: expectedFixedSessionRuntimeSnapshot(resumeConfig, 2),
      },
    });
    assert.equal((await postflightNativeSessionRuntime(resumeConfig, preflight)).revision, 2);

    const missingLockConfig = { ...resumeConfig, sessionId: "aginti:missing-lock", resume: "aginti:missing-lock" };
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
    assert.doesNotThrow(() => makeAuthority({ retained: true, appendProof: true, ledgerOptions: { omitLookupByOutboxId: true } }));
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

    const dispatchFailure = makeAuthority();
    const dispatchThread = (await dispatchFailure.authority.createIntegrationThread({ title: "Dispatch fail" }, context())).thread;
    dispatchFailure.repo.state.failNextDispatch = true;
    await assert.rejects(() => dispatchFailure.authority.startIntegrationRun({ threadId: dispatchThread.id, input: { text: "Dispatch" } }, context()));
    assert.equal([...dispatchFailure.repo.state.runs.values()][0].status, "failed");
    assert.equal(dispatchFailure.repo.calls.find(([name]) => name === "createIntegrationRun")[1].expectedNativeRuntimeRevision, 1);
    assert.equal(dispatchFailure.repo.calls.find(([name]) => name === "markIntegrationRunDispatching")[1].expectedNativeRuntimeRevision, 1);
    assert.equal(dispatchFailure.repo.calls.some(([name]) => name === "finishIntegrationRunWithOutbox"), true);

    const substitution = makeAuthority();
    const substitutionThread = (await substitution.authority.createIntegrationThread({ title: "Substitute" }, context())).thread;
    substitution.repo.state.substituteDispatchThread = true;
    await assert.rejects(() => substitution.authority.startIntegrationRun({ threadId: substitutionThread.id, input: { text: "Substitute" } }, context()));
    assert.equal(substitution.repo.calls.some(([name]) => name === "finishIntegrationRunWithOutbox"), true);

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
      output: "Already persisted.",
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
    outboxFixture.repo.state.outbox.set("out_recover", {
      outboxId: "out_recover",
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: rawRun.threadId,
      runId: rawRun.id,
      type: "run.completed",
      payload: {},
      createdAt: rawRun.completedAt,
      expectedPreviousSeq: 0,
      expectedPreviousHash: ZERO_DIGEST,
      expectedEventHash: terminal.hash,
      delivered: false,
    });
    const reconciled = await outboxFixture.authority.reconcileIntegrationDispatches(context());
    assert.equal(reconciled.deliveredOutboxEvents, 1);
    assert.equal(outboxFixture.ledger.eventsForRun(rawRun.id).at(-1).type, "run.completed");

    const outboxRetry = makeAuthority({ appendProof: true });
    const retryThread = (await outboxRetry.authority.createIntegrationThread({ title: "Outbox retry" }, context())).thread;
    const retryRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000019",
      threadId: retryThread.id,
      nativeSessionId: outboxRetry.repo.state.threads.get(retryThread.id).nativeSessionId,
      status: "completed",
      revision: 3,
      output: "Already persisted.",
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
    outboxRetry.repo.state.outbox.set("out_retry", {
      outboxId: "out_retry",
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: retryRun.threadId,
      runId: retryRun.id,
      type: "run.completed",
      payload: {},
      createdAt: retryRun.completedAt,
      expectedPreviousSeq: 0,
      expectedPreviousHash: ZERO_DIGEST,
      expectedEventHash: retryTerminal.hash,
      delivered: false,
    });
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

    const ordinaryRecovery = makeAuthority({ appendProof: true });
    const ordinaryThread = (await ordinaryRecovery.authority.createIntegrationThread({ title: "Ordinary recovery" }, context())).thread;
    await ordinaryRecovery.authority.listIntegrationThreads({ limit: 5 }, context());
    const ordinaryRun = runRecord({
      id: "run_00000000-0000-4000-8000-000000000020",
      threadId: ordinaryThread.id,
      nativeSessionId: ordinaryRecovery.repo.state.threads.get(ordinaryThread.id).nativeSessionId,
      status: "completed",
      revision: 3,
      output: "Already persisted.",
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
    ordinaryRecovery.repo.state.outbox.set("out_ordinary_recovery", {
      outboxId: "out_ordinary_recovery",
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: ordinaryRun.threadId,
      runId: ordinaryRun.id,
      type: "run.completed",
      payload: {},
      createdAt: ordinaryRun.completedAt,
      expectedPreviousSeq: 0,
      expectedPreviousHash: ZERO_DIGEST,
      expectedEventHash: ordinaryTerminal.hash,
      delivered: false,
    });
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
      { sessionId: directRun.nativeSessionId, ok: true, result: "Direct answer." },
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

    const artifactFixture = makeAuthority();
    const artifactThread = (await artifactFixture.authority.createIntegrationThread({ title: "Artifacts" }, context())).thread;
    artifactFixture.repo.state.artifacts.set(ARTIFACT_ID, plotArtifact({ threadId: artifactThread.id, runId: rawRun.id, published: false }));
    assert.equal((await artifactFixture.authority.listIntegrationArtifacts({ threadId: artifactThread.id }, context())).artifacts.length, 0);
    await artifactFixture.repo.repository.publishIntegrationArtifactOutbox({ artifactId: ARTIFACT_ID });
    assert.equal((await artifactFixture.authority.listIntegrationArtifacts({ threadId: artifactThread.id }, context())).artifacts.length, 1);
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
    const terminalClearLedger = makeEventLedgerStore();
    const terminalClearProjector = createIntegrationCoreEventProjector({ eventLedgerStore: terminalClearLedger });
    await terminalClearProjector.appendCoreEvent(
      "tool.started",
      { toolName: "run_command" },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: terminalClearRunId }
    );
    await terminalClearProjector.appendAuthorityTerminalEvent(
      "run.completed",
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: terminalClearRunId }
    );
    assert.equal(await terminalClearProjector.appendCoreEvent(
      "tool.progress",
      { toolName: "run_command" },
      { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, threadId: thread.id, runId: terminalClearRunId }
    ), null);
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
    assert.equal(cancelFixture.repo.calls.some(([name]) => name === "markIntegrationRunCancelling"), true);
    cancelFixture.repo.state.failNextCancel = true;
    await assert.rejects(() => cancelFixture.authority.cancelIntegrationRun({ runId: cancelRaw.id }, context()));
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

    const rejectingRegistry = createIntegrationRunRegistry();
    const registryController = new AbortController();
    const registryRunId = "run_00000000-0000-4000-8000-000000000018";
    const registryThreadId = "thr_00000000-0000-4000-8000-000000000018";
    rejectingRegistry.claimRun({ runId: registryRunId, threadId: registryThreadId, principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, controller: registryController });
    rejectingRegistry.attachPromise(registryRunId, Promise.reject(new Error("registry rejection")));
    await assert.rejects(() => rejectingRegistry.getRun(registryRunId, context()).promise);
    await delay(0);
    assert.equal(rejectingRegistry.snapshot().activeRuns, 0);
    assert.equal(unhandled.length, 0);

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-executor-smoke-"));
    const runAgentResult = await executeNativeAgintiRun({
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

    process.stdout.write("integration runtime authority smoke: ok\n");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

main().catch((error) => {
  process.stderr.write(`integration runtime authority smoke: failed (${String(error?.code || error?.name || "ERROR")})\n`);
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
