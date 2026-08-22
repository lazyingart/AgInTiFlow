#!/usr/bin/env node
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRetainedIntegrationNativeExecutionEvidence,
} from "../src/integration-retained-native-execution-evidence.js";
import {
  createRetainedIntegrationNativeSessionRepositoryState,
} from "../src/integration-retained-native-session-repository-state.js";
import {
  INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
  createRetainedIntegrationSessionStateStore,
} from "../src/integration-retained-session-state-store.js";
import {
  INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
  createRetainedIntegrationRuntimeRepositoryKernel,
} from "../src/integration-runtime-repository.js";
import {
  createIntegrationRetainedFilePrimitives,
  openIntegrationRetainedRegularFileLock,
  openIntegrationStorageAuthority,
} from "../src/integration-storage-authority.js";
import {
  PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
} from "../src/integration-events.js";
import {
  NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
} from "../src/integration-native-runtime-roots.js";
import {
  bindRetainedNativeExecution,
  buildFixedNativeRunAgentConfig,
  expectedFixedSessionRuntimeSnapshot,
  postflightNativeSessionRuntime,
  preflightNativeSessionRuntime,
  recordRetainedNativeTerminalEvidence,
} from "../src/integration-native-executor.js";
import {
  acquireRetainedIntegrationRuntimeRepositoryFence,
  compactRetainedIntegrationRuntimeRepository,
  createRetainedIntegrationRuntimeRecoveryCoordinator,
  createRetainedIntegrationRuntimeRepositorySurface,
  handoffRetainedIntegrationRuntimeRepositoryFence,
} from "../src/integration-retained-runtime-repository-surface.js";
import {
  createAgintiIntegrationRuntimeAuthority,
  createIntegrationRuntimeProcessOwnerBootstrap,
  INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY,
  INTEGRATION_EVENT_APPEND_ATTESTATION_VERSION,
  INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION,
  INTEGRATION_RUNTIME_CANCELLATION_ATTESTATION_VERSION,
} from "../src/integration-runtime-authority.js";
import {
  buildFixedIntegrationPolicy,
  contractDigest,
  REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS,
} from "../src/integration-policy.js";
import {
  runWithIntegrationSessionScope,
} from "../src/integration-session-persistence.js";
import { SessionStore } from "../src/session-store.js";

const UID = process.getuid();
const GID = process.getgid();
const HELPER_PATH = "/usr/bin/flock";
const ZERO_DIGEST = "0".repeat(64);
const PRINCIPAL = "principalAAAAAAAA";
const BROWSER_SESSION = "a".repeat(64);
const POLICY_FINGERPRINT = "b".repeat(64);
const ROLE = "retained-native-evidence-smoke";
const THREAD_ID = "thr_00000000-0000-4000-8000-000000000301";
const RUN_ID = "run_00000000-0000-4000-8000-000000000302";
const RESUME_RUN_ID = "run_00000000-0000-4000-8000-000000000304";
const NATIVE_SESSION_ID = "aginti:00000000-0000-4000-8000-000000000303";
const BASE_MS = Date.parse("2026-08-22T08:00:00.000Z");
const CHILD_MODE = String(process.argv.find((value) => value.startsWith("--child=")) || "").slice(8);
const CHILD_ROOT = String(process.argv.find((value) => value.startsWith("--root=")) || "").slice(7);

function timestamp(offsetSeconds) {
  return new Date(BASE_MS + offsetSeconds * 1000).toISOString();
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

function runtimeEventLedgerStore() {
  return Object.freeze({
    owner: "aginti",
    authority: "aginti",
    mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
    durable: true,
    persisted: true,
    contiguous: true,
    monotonic: true,
    bridgeOwned: false,
    appendPublicEvent() {
      throw new Error("runtime proof smoke does not append public events");
    },
    appendByOutboxId() {
      throw new Error("runtime proof smoke does not append outbox events");
    },
    lookupByOutboxId() {
      return null;
    },
    ledgerForRun() {
      throw new Error("runtime proof smoke does not open a public ledger");
    },
    [INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY]: seal({
      schemaVersion: INTEGRATION_EVENT_APPEND_ATTESTATION_VERSION,
      owner: "aginti",
      authority: "aginti",
      appendPublicEvent: true,
      appendByOutboxId: true,
      lookupByOutboxId: true,
      terminalFinality: true,
      durable: true,
      persisted: true,
      monotonic: true,
    }),
  });
}

function runtimeCancellationAttestation() {
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

function runtimeSandboxAttestation() {
  const isolationAttestation = deepFreeze({
    profileVersion: "hardened-v1",
    profileDigest: "f".repeat(64),
    ...Object.fromEntries(REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS.map((key) => [key, true])),
  });
  return seal({
    schemaVersion: INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    valid: true,
    enabled: true,
    isolationAttestation,
  });
}

function runtimeAuthorityForFixture(fixture) {
  return createAgintiIntegrationRuntimeAuthority({
    threadSessionRepository: fixture.repository,
    eventLedgerStore: runtimeEventLedgerStore(),
    cancellationAttestation: runtimeCancellationAttestation(),
    hardenedSandboxAttestation: runtimeSandboxAttestation(),
    processOwnerBootstrap: fixture.processOwnerBootstrap,
    repositoryFenceLease: fixture.acquiredFence.lease,
    retainedNativeExecutionEvidence: fixture.evidence,
    retainedRecoveryCoordinator: fixture.recovery,
  });
}

function identityDigest(stat) {
  return contractDigest({
    schemaVersion: "aginti-retained-regular-file-identity-v1",
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

async function ensureOwnerDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
  await fs.chown(directoryPath, UID, GID);
}

async function ensureLockFile(filePath) {
  try {
    await fs.stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.writeFile(filePath, "", { flag: "wx", mode: 0o600 });
  }
  await fs.chmod(filePath, 0o600);
  await fs.chown(filePath, UID, GID);
}

function runtimeRoots(rootPath) {
  const unsigned = Object.freeze({
    schemaVersion: NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
    sessionsDir: path.join(rootPath, "native:sessions"),
    baseDir: path.join(rootPath, "workspace"),
    commandCwd: path.join(rootPath, "workspace"),
    retainedDescriptor: true,
    symlinkFree: true,
    outsideForbiddenRoots: true,
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

async function openFixture(rootPath, now, processOwnerBootstrap) {
  const repositorySegments = Object.freeze(["data:repository"]);
  const sessionSegments = Object.freeze(["native:sessions"]);
  const repositoryPath = path.join(rootPath, ...repositorySegments);
  const sessionPath = path.join(rootPath, ...sessionSegments);
  const repositoryLockPath = path.join(repositoryPath, INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE);
  const sessionLockPath = path.join(sessionPath, INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE);
  await ensureOwnerDirectory(rootPath);
  await ensureOwnerDirectory(repositoryPath);
  await ensureOwnerDirectory(sessionPath);
  await ensureOwnerDirectory(path.join(rootPath, "workspace"));
  await ensureLockFile(repositoryLockPath);
  await ensureLockFile(sessionLockPath);
  const authority = await openIntegrationStorageAuthority({
    rootPath,
    role: ROLE,
    ownerUid: UID,
    ownerGid: GID,
    label: "retained native evidence smoke",
  });
  const helperSha256 = crypto.createHash("sha256").update(await fs.readFile(HELPER_PATH)).digest("hex");
  const helperIdentityDigest = identityDigest(await fs.stat(HELPER_PATH, { bigint: true }));

  async function binding(relativeSegments, lockFileName, lockPath, bytesKey, bytesValue) {
    const directory = await authority.openDirectory(relativeSegments);
    const directoryIdentity = await directory.identity();
    const directoryExpected = Object.freeze({
      role: ROLE,
      canonicalPath: rootPath,
      rootIdentityDigest: authority.attestation.rootIdentityDigest,
      relativeSegments,
      directoryIdentityDigest: directoryIdentity.digest,
    });
    const files = createIntegrationRetainedFilePrimitives(directory, directoryExpected);
    const lockFileIdentityDigest = identityDigest(await fs.stat(lockPath, { bigint: true }));
    const lock = await openIntegrationRetainedRegularFileLock(files, Object.freeze({
      ...directoryExpected,
      lockFileName,
      helperSha256,
      lockFileIdentityDigest,
      helperIdentityDigest,
    }));
    return Object.freeze({
      files,
      lock,
      expected: Object.freeze({
        ...directoryExpected,
        lockFileIdentityDigest,
        helperSha256,
        helperIdentityDigest,
        [bytesKey]: bytesValue,
        lockWaitMs: 3000,
      }),
    });
  }

  const repositoryBinding = await binding(
    repositorySegments,
    INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
    repositoryLockPath,
    "maxSnapshotBytes",
    2 * 1024 * 1024
  );
  const sessionBinding = await binding(
    sessionSegments,
    INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
    sessionLockPath,
    "maxStateBytes",
    512 * 1024
  );
  const kernel = createRetainedIntegrationRuntimeRepositoryKernel(
    repositoryBinding.files,
    repositoryBinding.lock,
    repositoryBinding.expected
  );
  const sessionStateStore = createRetainedIntegrationSessionStateStore(
    sessionBinding.files,
    sessionBinding.lock,
    sessionBinding.expected
  );
  const expected = Object.freeze({
    repositoryKernel: repositoryBinding.expected,
    sessionStateStore: sessionBinding.expected,
  });
  const repositoryState = createRetainedIntegrationNativeSessionRepositoryState(
    kernel,
    sessionStateStore,
    expected
  );
  const repository = createRetainedIntegrationRuntimeRepositorySurface({
    repositoryState,
    repositoryStateExpected: expected,
    runtimeRoots: runtimeRoots(rootPath),
    now,
  });
  const acquiredFence = await acquireRetainedIntegrationRuntimeRepositoryFence(repository, {
    processOwnerBootstrap,
  });
  const evidence = createRetainedIntegrationNativeExecutionEvidence({
    sessionStateStore,
    sessionStateStoreExpected: sessionBinding.expected,
  });
  const recovery = createRetainedIntegrationRuntimeRecoveryCoordinator({
    repository,
    nativeExecutionEvidence: evidence,
    processOwnerBootstrap,
    repositoryFenceLease: acquiredFence.lease,
  });
  return Object.freeze({
    authority,
    repository,
    repositoryState,
    sessionStateStore,
    evidence,
    recovery,
    expected,
    processOwnerBootstrap,
    processOwner: processOwnerBootstrap.processOwner,
    acquiredFence,
    sessionBinding,
  });
}

async function openSiblingFixture(rootPath, now, fixture) {
  const repository = createRetainedIntegrationRuntimeRepositorySurface({
    repositoryState: fixture.repositoryState,
    repositoryStateExpected: fixture.expected,
    runtimeRoots: runtimeRoots(rootPath),
    now,
  });
  const acquiredFence = await acquireRetainedIntegrationRuntimeRepositoryFence(repository, {
    processOwnerBootstrap: fixture.processOwnerBootstrap,
  });
  const recovery = createRetainedIntegrationRuntimeRecoveryCoordinator({
    repository,
    nativeExecutionEvidence: fixture.evidence,
    processOwnerBootstrap: fixture.processOwnerBootstrap,
    repositoryFenceLease: acquiredFence.lease,
  });
  return Object.freeze({
    repository,
    repositoryState: fixture.repositoryState,
    evidence: fixture.evidence,
    recovery,
    processOwnerBootstrap: fixture.processOwnerBootstrap,
    processOwner: fixture.processOwner,
    acquiredFence,
  });
}

function threadPreservationDigest(thread) {
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

function authorizationFor(run, thread, previousRun = null) {
  const mode = previousRun === null ? "start" : "resume";
  const expectedNativeRuntimeRevision = run.authority.runtimeRevision;
  const unsigned = Object.freeze({
    schemaVersion: "aginti-native-start-authorization-v1",
    mode,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId: run.threadId,
    runId: run.id,
    nativeSessionId: run.nativeSessionId,
    previousRunId: previousRun?.id || null,
    previousRunRevision: previousRun?.revision || null,
    previousRunRuntimeRevision: previousRun?.authority?.runtimeRevision || null,
    threadRevision: thread.revision,
    threadPreservationDigest: threadPreservationDigest(thread),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    expectedNativeRuntimeRevision,
    targetNativeRuntimeRevision:
      mode === "resume" ? expectedNativeRuntimeRevision + 1 : expectedNativeRuntimeRevision,
    expectedRunRevision: run.revision,
    targetRunRevision: run.revision + 1,
    dispatchLeaseId: run.dispatchLeaseId,
    dispatchOutbox: true,
    dispatchedAt: run.dispatchedAt,
    processOwner: run.processOwner,
    authorizedAt: run.dispatchedAt,
  });
  const authorizationDigest = contractDigest(unsigned);
  return Object.freeze({
    ...unsigned,
    authorizationId: `nstart_${authorizationDigest.slice(0, 48)}`,
    authorizationDigest,
  });
}

function reconciliationRequest(processOwner, reconciledAt) {
  const unsigned = Object.freeze({
    schemaVersion: "aginti-dispatch-reconciliation-v1",
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    processOwner,
    liveRunClaims: Object.freeze([]),
    reconciledAt,
  });
  return Object.freeze({ ...unsigned, requestDigest: contractDigest(unsigned) });
}

function fillerThreadId(index) {
  return `thr_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function fillerNativeSessionId(index) {
  return `aginti:00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function fillReplayReceipts(fixture, { startIndex, count, startOffset }) {
  for (let index = 0; index < count; index += 1) {
    const identity = startIndex + index;
    await fixture.repository.createIntegrationThread(Object.freeze({
      threadId: fillerThreadId(identity),
      nativeSessionId: fillerNativeSessionId(identity),
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      title: `Replay horizon filler ${identity}`,
      createdAt: timestamp(startOffset + index),
      policyFingerprint: POLICY_FINGERPRINT,
    }));
  }
}

async function expectCode(action, expectedCode) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  assert(captured, `Expected ${expectedCode}`);
  assert.equal(captured.publicCode || captured.code, expectedCode, captured.message);
}

function errorCode(error) {
  return String(error?.publicCode || error?.code || error?.name || "ERROR");
}

function spawnSuccessor(rootPath) {
  const child = fork(fileURLToPath(import.meta.url), ["--child=successor", `--root=${rootPath}`], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const pending = new Map();
  let nextId = 1;
  child.on("message", (message) => {
    if (message?.type === "ready") {
      readyResolve(message);
      return;
    }
    if (message?.type !== "response" || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(message.result);
    else {
      const error = new Error(message.message || message.code || "successor command failed");
      error.code = message.code;
      waiter.reject(error);
    }
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    const error = new Error(`successor exited (${code ?? signal}): ${stderr}`);
    readyReject(error);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    resolve({ code, signal, stderr });
  }));
  return Object.freeze({
    child,
    ready,
    exited,
    command(command, payload) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`successor ${command} timed out: ${stderr}`));
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        child.send({ type: "command", id, command, payload });
      });
    },
    terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  });
}

async function runSuccessorChild() {
  const processOwnerBootstrap = await createIntegrationRuntimeProcessOwnerBootstrap();
  const send = (payload) => new Promise((resolve, reject) => {
    if (typeof process.send !== "function") {
      reject(new Error("successor child requires an IPC channel"));
      return;
    }
    process.send(payload, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await send({ type: "ready", processOwner: processOwnerBootstrap.processOwner, pid: process.pid });
  const message = await new Promise((resolve) => process.once("message", resolve));
  let fixture = null;
  try {
    if (message?.type !== "command" || message.command !== "resolve") {
      throw new Error("successor received an invalid command");
    }
    let childTick = 500;
    const now = () => new Date(BASE_MS + childTick++ * 1000);
    fixture = await openFixture(CHILD_ROOT, now, processOwnerBootstrap);
    const runtimeAuthority = runtimeAuthorityForFixture(fixture);
    const runtimeProof = await runtimeAuthority.getIntegrationRuntimeProof();
    const recovered = await fixture.recovery.resolveRecoveryHeldRun(message.payload);
    const replay = await fixture.recovery.resolveRecoveryHeldRun(message.payload);
    const persisted = (await fixture.repository.getIntegrationRun({
      runId: message.payload.runId,
      principalId: message.payload.principalId,
      browserSessionId: message.payload.browserSessionId,
    })).run;
    await send({
      type: "response",
      id: message.id,
      ok: true,
      result: {
        runId: recovered.run.id,
        status: recovered.run.status,
        runtimeRevision: recovered.run.authority.runtimeRevision,
        processOwnerDigest: contractDigest(recovered.run.processOwner),
        replayOutcome: replay.outcome,
        persistedStatus: persisted.status,
        persistedRuntimeRevision: persisted.authority.runtimeRevision,
        persistedProcessOwnerDigest: contractDigest(persisted.processOwner),
        fence: runtimeProof.repositoryFence,
        coordinatorFenceDigest: fixture.recovery.attestation.repositoryFenceDigest,
        coordinatorLeaseDigest: fixture.recovery.attestation.repositoryFenceLeaseDigest,
      },
    });
  } catch (error) {
    await send({
      type: "response",
      id: message?.id,
      ok: false,
      code: errorCode(error),
      message: String(error?.message || error),
    });
  } finally {
    await fixture?.authority.close().catch(() => {});
    process.disconnect?.();
  }
}

async function authorizeRepositoryRun(fixture, dispatchOwner = fixture.processOwner) {
  const createdAt = timestamp(1);
  const originalThread = (await fixture.repository.createIntegrationThread(Object.freeze({
    threadId: THREAD_ID,
    nativeSessionId: NATIVE_SESSION_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    title: "Retained native evidence",
    createdAt,
    policyFingerprint: POLICY_FINGERPRINT,
  }))).thread;
  const created = await fixture.repository.createIntegrationRun(Object.freeze({
    runId: RUN_ID,
    threadId: THREAD_ID,
    nativeSessionId: NATIVE_SESSION_ID,
    previousRunId: null,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    expectedThreadRevision: originalThread.revision,
    expectedNativeRuntimeRevision: 1,
    input: Object.freeze({ text: "Prove retained native execution." }),
    createdAt,
    status: "starting",
  }));
  const dispatchedAt = timestamp(2);
  const dispatched = (await fixture.repository.markIntegrationRunDispatching(Object.freeze({
    runId: RUN_ID,
    threadId: THREAD_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: created.run.revision,
    expectedNativeRuntimeRevision: 1,
    dispatchLeaseId: contractDigest({ runId: RUN_ID, nativeSessionId: NATIVE_SESSION_ID, createdAt }),
    dispatchOutbox: true,
    processOwner: dispatchOwner,
    dispatchedAt,
  }))).run;
  const authorization = authorizationFor(dispatched, created.thread);
  const authorized = await fixture.repository.authorizeIntegrationRunNativeStart({ authorization });
  assert.equal(authorized.receipt.authorizationDigest, authorization.authorizationDigest);
  return Object.freeze({ created, dispatched, authorization, authorized });
}

async function authorizeRepositoryResume(fixture, previousRun, thread, dispatchOwner) {
  const createdAt = timestamp(60);
  const created = await fixture.repository.createIntegrationRun(Object.freeze({
    runId: RESUME_RUN_ID,
    threadId: THREAD_ID,
    nativeSessionId: NATIVE_SESSION_ID,
    previousRunId: previousRun.id,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    expectedThreadRevision: thread.revision,
    expectedNativeRuntimeRevision: previousRun.authority.runtimeRevision,
    input: Object.freeze({ text: "Advance the retained native execution." }),
    createdAt,
    status: "starting",
  }));
  const dispatchedAt = timestamp(61);
  const dispatched = (await fixture.repository.markIntegrationRunDispatching(Object.freeze({
    runId: RESUME_RUN_ID,
    threadId: THREAD_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: created.run.revision,
    expectedNativeRuntimeRevision: previousRun.authority.runtimeRevision,
    dispatchLeaseId: contractDigest({
      runId: RESUME_RUN_ID,
      nativeSessionId: NATIVE_SESSION_ID,
      createdAt,
    }),
    dispatchOutbox: true,
    processOwner: dispatchOwner,
    dispatchedAt,
  }))).run;
  const authorization = authorizationFor(dispatched, created.thread, previousRun);
  const authorized = await fixture.repository.authorizeIntegrationRunNativeStart({ authorization });
  assert.equal(authorized.receipt.authorizationDigest, authorization.authorizationDigest);
  return Object.freeze({ created, dispatched, authorization, authorized });
}

async function run() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-native-evidence-"));
  const mismatchRootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-native-evidence-mismatch-")
  );
  let fixture = null;
  let mismatchFixture = null;
  let staleRuntimeFixture = null;
  let successor = null;
  let tick = 100;
  const now = () => new Date(BASE_MS + tick++ * 1000);
  const processOwnerBootstrap = await createIntegrationRuntimeProcessOwnerBootstrap();
  try {
    fixture = await openFixture(rootPath, now, processOwnerBootstrap);
    mismatchFixture = await openFixture(mismatchRootPath, now, processOwnerBootstrap);
    const sameDescriptorExpected = fixture.sessionBinding.expected;
    const sameDescriptorLock = await openIntegrationRetainedRegularFileLock(
      fixture.sessionBinding.files,
      Object.freeze({
        role: sameDescriptorExpected.role,
        canonicalPath: sameDescriptorExpected.canonicalPath,
        rootIdentityDigest: sameDescriptorExpected.rootIdentityDigest,
        relativeSegments: sameDescriptorExpected.relativeSegments,
        directoryIdentityDigest: sameDescriptorExpected.directoryIdentityDigest,
        lockFileName: INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
        helperSha256: sameDescriptorExpected.helperSha256,
        lockFileIdentityDigest: sameDescriptorExpected.lockFileIdentityDigest,
        helperIdentityDigest: sameDescriptorExpected.helperIdentityDigest,
      })
    );
    const sameDescriptorStore = createRetainedIntegrationSessionStateStore(
      fixture.sessionBinding.files,
      sameDescriptorLock,
      sameDescriptorExpected
    );
    const sameDescriptorEvidence = createRetainedIntegrationNativeExecutionEvidence({
      sessionStateStore: sameDescriptorStore,
      sessionStateStoreExpected: sameDescriptorExpected,
    });
    await expectCode(
      () => createRetainedIntegrationRuntimeRecoveryCoordinator({
        repository: fixture.repository,
        nativeExecutionEvidence: sameDescriptorEvidence,
        processOwnerBootstrap,
        repositoryFenceLease: fixture.acquiredFence.lease,
      }),
      "INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE"
    );
    await expectCode(
      () => createRetainedIntegrationRuntimeRecoveryCoordinator({
        repository: fixture.repository,
        nativeExecutionEvidence: mismatchFixture.evidence,
        processOwnerBootstrap,
        repositoryFenceLease: fixture.acquiredFence.lease,
      }),
      "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE"
    );
    assert.equal(
      fixture.recovery.attestation.storageExpectedDigest,
      fixture.evidence.attestation.storageExpectedDigest
    );
    assert.equal(
      fixture.recovery.attestation.storageAdmissionBindingDigest,
      fixture.evidence.attestation.storageAdmissionBindingDigest
    );
    await authorizeRepositoryRun(mismatchFixture);
    await mismatchFixture.authority.close();
    mismatchFixture = await openFixture(mismatchRootPath, now, processOwnerBootstrap);
    await mismatchFixture.repository.reconcileIntegrationDispatches(
      reconciliationRequest(mismatchFixture.processOwner, timestamp(40))
    );
    const noEvidenceCursor = Object.freeze({
      firstSeq: 1,
      lastSeq: 0,
      lastHash: ZERO_DIGEST,
      prunedThroughSeq: 0,
    });
    await expectCode(
      () => mismatchFixture.recovery.resolveRecoveryHeldRun(Object.freeze({
        runId: RUN_ID,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
        expectedCursor: noEvidenceCursor,
      })),
      "RECOVERY_EVIDENCE_UNAVAILABLE"
    );
    const noEvidenceHeld = (await mismatchFixture.repository.getIntegrationRun({
      runId: RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    })).run;
    assert.equal(noEvidenceHeld.recoveryState.status, "recovery_hold");
    const roots = runtimeRoots(rootPath);
    const { authorization, authorized } = await authorizeRepositoryRun(fixture);
    const config = buildFixedNativeRunAgentConfig({
      mode: "start",
      policy: buildFixedIntegrationPolicy(),
      nativeSessionId: NATIVE_SESSION_ID,
      inputText: "Prove retained native execution.",
      abortSignal: new AbortController().signal,
      onEvent() {},
      repositoryRoots: roots,
      expectedRuntimeRevision: 1,
      retainedNativeExecutionEvidence: fixture.evidence,
    });
    const preflight = await preflightNativeSessionRuntime(config);
    assert.equal(preflight.retained, true);
    assert.equal(preflight.expectedAfterRevision, 1);
    await bindRetainedNativeExecution(config, {
      authorization: authorized.receipt,
      snapshotHash: authorized.run.authority.snapshotHash,
    });
    const expectedRuntime = expectedFixedSessionRuntimeSnapshot(config, 1);
    const nativeState = Object.freeze({
      sessionId: NATIVE_SESSION_ID,
      baseDir: roots.baseDir,
      commandCwd: roots.commandCwd,
      status: "completed",
      meta: Object.freeze({ runtimeConfig: expectedRuntime }),
    });
    await runWithIntegrationSessionScope(config, async () => {
      const store = new SessionStore(roots.sessionsDir, NATIVE_SESSION_ID, {
        projectRoot: roots.baseDir,
        commandCwd: roots.commandCwd,
      });
      assert.equal(await store.loadState(), null);
      await store.saveState(nativeState);
      const reloaded = await store.loadState();
      assert.equal(reloaded.meta.runtimeConfig.revision, 1);
      assert.equal(reloaded.meta.integrationNativeExecution.authorizationDigest, authorization.authorizationDigest);
      assert.equal(
        reloaded.meta.integrationNativeExecution.processOwnerDigest,
        contractDigest(authorization.processOwner)
      );
      assert.equal(reloaded.meta.integrationNativeExecution.snapshotHash, authorized.run.authority.snapshotHash);
    });
    const postflight = await postflightNativeSessionRuntime(config, preflight);
    assert.equal(postflight.revision, 1);
    const terminal = Object.freeze({
      status: "completed",
      output: "Retained native evidence completed.",
      error: null,
      resultDigest: contractDigest({ status: "completed", output: "Retained native evidence completed." }),
      completedAt: timestamp(8),
      persistedRuntimeRevision: 1,
    });
    const terminalReceipt = await recordRetainedNativeTerminalEvidence(config, terminal);
    assert.equal(terminalReceipt.outcome, "committed");
    const terminalReplay = await recordRetainedNativeTerminalEvidence(config, terminal);
    assert.equal(terminalReplay.outcome, "replayed");
    assert.equal((await fs.stat(path.join(roots.sessionsDir, NATIVE_SESSION_ID, "state.json")).catch(() => null)), null);

    await fixture.authority.close();
    fixture = await openFixture(rootPath, now, processOwnerBootstrap);
    const recoveryOwner = fixture.processOwner;
    const reconciliation = await fixture.repository.reconcileIntegrationDispatches(
      reconciliationRequest(recoveryOwner, timestamp(20))
    );
    assert.equal(reconciliation.receiptRunResults.length, 1);
    assert.equal(reconciliation.receiptRunResults[0].action, "held");
    const held = (await fixture.repository.getIntegrationRun({
      runId: RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    })).run;
    assert.equal(held.recoveryState.status, "recovery_hold");
    const publicFinish = {
      runId: held.id,
      threadId: held.threadId,
      nativeSessionId: held.nativeSessionId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: held.revision,
      expectedNativeRuntimeRevision: 1,
      completedNativeRuntimeRevision: 1,
      status: terminal.status,
      output: terminal.output,
      error: terminal.error,
      completedAt: terminal.completedAt,
      processOwner: recoveryOwner,
      expectedCursor: Object.freeze({ firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 }),
      outputEvent: Object.freeze({
        type: "output.delta",
        payload: Object.freeze({ text: terminal.output }),
        createdAt: terminal.completedAt,
      }),
      terminalEvent: Object.freeze({ type: "run.completed", payload: Object.freeze({}), createdAt: terminal.completedAt }),
      resultDigest: terminal.resultDigest,
    };
    await expectCode(
      () => fixture.repository.finishIntegrationRunWithOutbox(Object.freeze(publicFinish)),
      "RECOVERY_HOLD"
    );
    await fillReplayReceipts(fixture, { startIndex: 1_000, count: 20, startOffset: 21 });
    await compactRetainedIntegrationRuntimeRepository(fixture.repository);
    const delayedRecoverySnapshot = await fixture.repositoryState.loadDomainSnapshot();
    assert(
      delayedRecoverySnapshot.state.retention.replayCutoffAt >= terminal.completedAt,
      "recovery terminal timestamp must be behind the durable replay floor"
    );
    const recovered = await fixture.recovery.resolveRecoveryHeldRun(Object.freeze({
      runId: RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedCursor: publicFinish.expectedCursor,
    }));
    assert.equal(recovered.run.status, "completed");
    assert.equal(recovered.run.output, terminal.output);
    assert.equal(recovered.run.completedAt, terminal.completedAt);
    assert.equal(recovered.run.authority.snapshotHash, authorized.run.authority.snapshotHash);
    assert.equal(recovered.resultDigest, terminal.resultDigest);
    assert.equal(recovered.outboxEvents.length, 2);
    const replay = await fixture.recovery.resolveRecoveryHeldRun(Object.freeze({
      runId: RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedCursor: publicFinish.expectedCursor,
    }));
    assert.equal(replay.outcome, "already-recovered");
    assert.equal(replay.run.id, RUN_ID);
    assert.equal(replay.resultDigest, terminal.resultDigest);
    await fillReplayReceipts(fixture, { startIndex: 1_020, count: 20, startOffset: 45 });
    await compactRetainedIntegrationRuntimeRepository(fixture.repository);
    const beforeExpiredRecoveryReplay = await fixture.repositoryState.loadDomainSnapshot();
    await expectCode(
      () => fixture.recovery.resolveRecoveryHeldRun(Object.freeze({
        runId: RUN_ID,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
        expectedCursor: publicFinish.expectedCursor,
      })),
      "INTEGRATION_REPOSITORY_REPLAY_WINDOW_EXPIRED"
    );
    const afterExpiredRecoveryReplay = await fixture.repositoryState.loadDomainSnapshot();
    assert.equal(afterExpiredRecoveryReplay.snapshotRevision, beforeExpiredRecoveryReplay.snapshotRevision);
    assert.equal(afterExpiredRecoveryReplay.integrityDigest, beforeExpiredRecoveryReplay.integrityDigest);

    const resumeOwner = fixture.processOwner;
    const resumed = await authorizeRepositoryResume(
      fixture,
      recovered.run,
      recovered.thread,
      resumeOwner
    );
    const resumeConfig = buildFixedNativeRunAgentConfig({
      mode: "resume",
      policy: buildFixedIntegrationPolicy(),
      nativeSessionId: NATIVE_SESSION_ID,
      inputText: "Advance the retained native execution.",
      abortSignal: new AbortController().signal,
      onEvent() {},
      repositoryRoots: roots,
      expectedRuntimeRevision: 1,
      retainedNativeExecutionEvidence: fixture.evidence,
    });
    const resumePreflight = await preflightNativeSessionRuntime(resumeConfig);
    assert.equal(resumePreflight.beforeRevision, 1);
    assert.equal(resumePreflight.expectedAfterRevision, 2);
    await bindRetainedNativeExecution(resumeConfig, {
      authorization: resumed.authorized.receipt,
      snapshotHash: resumed.authorized.run.authority.snapshotHash,
    });
    const resumedRuntime = expectedFixedSessionRuntimeSnapshot(resumeConfig, 2);
    await runWithIntegrationSessionScope(resumeConfig, async () => {
      const store = new SessionStore(roots.sessionsDir, NATIVE_SESSION_ID, {
        projectRoot: roots.baseDir,
        commandCwd: roots.commandCwd,
      });
      assert.equal((await store.loadState()).meta.runtimeConfig.revision, 1);
      await store.saveState(Object.freeze({
        sessionId: NATIVE_SESSION_ID,
        baseDir: roots.baseDir,
        commandCwd: roots.commandCwd,
        status: "completed",
        meta: Object.freeze({ runtimeConfig: resumedRuntime }),
      }));
      const resumedState = await store.loadState();
      assert.equal(resumedState.meta.runtimeConfig.revision, 2);
      assert.equal(
        resumedState.meta.integrationNativeExecution.authorizationDigest,
        resumed.authorization.authorizationDigest
      );
    });
    assert.equal((await postflightNativeSessionRuntime(resumeConfig, resumePreflight)).revision, 2);
    const resumedTerminal = Object.freeze({
      status: "completed",
      output: "Retained native resume completed.",
      error: null,
      resultDigest: contractDigest({
        status: "completed",
        output: "Retained native resume completed.",
      }),
      completedAt: timestamp(62),
      persistedRuntimeRevision: 2,
    });
    await recordRetainedNativeTerminalEvidence(resumeConfig, resumedTerminal);
    const resumedReconciliation = await fixture.repository.reconcileIntegrationDispatches(
      reconciliationRequest(fixture.processOwner, timestamp(70))
    );
    assert.equal(resumedReconciliation.receiptRunResults.length, 1);
    assert.equal(resumedReconciliation.receiptRunResults[0].action, "held");
    const resumedHeld = (await fixture.repository.getIntegrationRun({
      runId: RESUME_RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    })).run;
    assert.equal(resumedHeld.recoveryState.status, "recovery_hold");
    const resumedFinishPayload = Object.freeze({
      runId: RESUME_RUN_ID,
      threadId: THREAD_ID,
      nativeSessionId: NATIVE_SESSION_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: resumedHeld.revision,
      expectedNativeRuntimeRevision: 1,
      completedNativeRuntimeRevision: 2,
      status: resumedTerminal.status,
      output: resumedTerminal.output,
      error: null,
      completedAt: resumedTerminal.completedAt,
      processOwner: resumeOwner,
      expectedCursor: noEvidenceCursor,
      outputEvent: Object.freeze({
        type: "output.delta",
        payload: Object.freeze({ text: resumedTerminal.output }),
        createdAt: resumedTerminal.completedAt,
      }),
      terminalEvent: Object.freeze({
        type: "run.completed",
        payload: Object.freeze({}),
        createdAt: resumedTerminal.completedAt,
      }),
      resultDigest: resumedTerminal.resultDigest,
    });
    staleRuntimeFixture = await openSiblingFixture(rootPath, now, fixture);
    const staleRuntimeAuthority = runtimeAuthorityForFixture(staleRuntimeFixture);
    const beforeHandoffProof = await staleRuntimeAuthority.getIntegrationRuntimeProof();
    assert.equal(beforeHandoffProof.repositoryFence.acquired, true);
    assert.equal(beforeHandoffProof.repositoryFence.durablyCurrent, true);
    assert.equal(
      beforeHandoffProof.repositoryFence.leaseDigest,
      staleRuntimeFixture.acquiredFence.lease.digest
    );
    successor = spawnSuccessor(rootPath);
    const successorReady = await successor.ready;
    const handoff = await handoffRetainedIntegrationRuntimeRepositoryFence(fixture.repository, {
      currentProcessOwnerBootstrap: processOwnerBootstrap,
      successorProcessOwner: successorReady.processOwner,
    });
    await expectCode(
      () => staleRuntimeAuthority.getIntegrationRuntimeProof(),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    const successorRequest = Object.freeze({
      runId: RESUME_RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedCursor: noEvidenceCursor,
    });
    await expectCode(
      () => staleRuntimeFixture.recovery.resolveRecoveryHeldRun(successorRequest),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => staleRuntimeFixture.repository.finishIntegrationRunWithOutbox(resumedFinishPayload),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    const successorResult = await successor.command("resolve", successorRequest);
    assert.equal(successorResult.runId, RESUME_RUN_ID);
    assert.equal(successorResult.status, "completed");
    assert.equal(successorResult.runtimeRevision, 2);
    assert.equal(successorResult.replayOutcome, "already-recovered");
    assert.equal(successorResult.processOwnerDigest, contractDigest(successorReady.processOwner));
    assert.equal(successorResult.persistedStatus, "completed");
    assert.equal(successorResult.persistedRuntimeRevision, 2);
    assert.equal(successorResult.persistedProcessOwnerDigest, contractDigest(successorReady.processOwner));
    assert.equal(successorResult.fence.generation, handoff.fence.generation);
    assert.equal(successorResult.fence.ownerDigest, contractDigest(successorReady.processOwner));
    assert.equal(successorResult.fence.durablyCurrent, true);
    assert.equal(successorResult.coordinatorFenceDigest, successorResult.fence.fenceDigest);
    assert.equal(successorResult.coordinatorLeaseDigest, successorResult.fence.leaseDigest);
    const successorExit = await successor.exited;
    assert.equal(successorExit.code, 0, successorExit.stderr);
    assert.equal(fixture.recovery.attestation.publicRepositoryMethodCountUnchanged, true);
    assert.equal(fixture.evidence.attestation.fullSessionStoreRetained, false);
    console.log(JSON.stringify({
      ok: true,
      retainedPreflight: true,
      pathStateWriteAbsent: true,
      crashRestartRecovery: true,
      publicRecoveryBlocked: true,
      privateRecoveryCommitted: true,
      privateRecoveryReplay: true,
      delayedRecoveryPastReplayFloor: true,
      prunedRecoveryReplayExpired: true,
      immutableSnapshotHash: true,
      exactStorageBinding: true,
      exactSessionStateStoreIdentityBinding: true,
      authorizationProcessOwnerBound: true,
      missingTerminalEvidenceHeld: true,
      historicalRecoveryReplayAfterReceiptPruningExpired: true,
      durableRuntimeProofReload: true,
      staleCoordinatorRejectedAfterHandoff: true,
      staleRepositoryMutationRejectedAfterHandoff: true,
      successorRecoveryAfterHandoff: true,
      fullSessionStoreRetained: false,
      runtimeCapabilityEnabled: false,
    }));
  } finally {
    successor?.terminate();
    await staleRuntimeFixture?.authority?.close?.().catch(() => {});
    await fixture?.authority.close().catch(() => {});
    await mismatchFixture?.authority.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    await fs.rm(mismatchRootPath, { recursive: true, force: true });
  }
}

if (CHILD_MODE === "successor") await runSuccessorChild();
else await run();
