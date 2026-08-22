#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import crypto from "node:crypto";
import realFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UID = process.getuid();
const GID = process.getgid();
const HELPER_PATH = "/usr/bin/flock";
const ROLE = "retained-runtime-repository-phase-b-smoke";
const ZERO_DIGEST = "0".repeat(64);
const PRINCIPAL = "principalPhaseBBBB";
const BROWSER_SESSION = "b".repeat(64);
const POLICY_FINGERPRINT = "c".repeat(64);
const FAULT_MODE = String(process.argv.find((value) => value.startsWith("--fault=")) || "").slice(8);
const CHILD_MODE = String(process.argv.find((value) => value.startsWith("--child=")) || "").slice(8);
const CHILD_ROOT = String(process.argv.find((value) => value.startsWith("--root=")) || "").slice(7);
const fault = { armed: false };
let fsMock = null;

if (FAULT_MODE === "rename-before" || FAULT_MODE === "rename-after") {
  const { mock } = await import("node:test");
  const mockFs = { ...realFs };
  mockFs.rename = async (source, target) => {
    const isRepositorySnapshot = path.basename(String(target)) === "repository.snapshot.json";
    if (fault.armed && isRepositorySnapshot && FAULT_MODE === "rename-before") {
      fault.armed = false;
      const error = new Error("synthetic compaction rename-before failure");
      error.code = "EIO";
      throw error;
    }
    await realFs.rename(source, target);
    if (fault.armed && isRepositorySnapshot && FAULT_MODE === "rename-after") {
      fault.armed = false;
      const error = new Error("synthetic compaction rename-after ambiguity");
      error.code = "EIO";
      throw error;
    }
  };
  fsMock = mock.module("node:fs/promises", { defaultExport: mockFs });
}

const [
  policyApi,
  eventApi,
  stateApi,
  sessionStoreApi,
  kernelApi,
  storageApi,
  rootsApi,
  surfaceApi,
  runtimeApi,
] = await Promise.all([
  import("../src/integration-policy.js"),
  import("../src/integration-events.js"),
  import("../src/integration-retained-native-session-repository-state.js"),
  import("../src/integration-retained-session-state-store.js"),
  import("../src/integration-runtime-repository.js"),
  import("../src/integration-storage-authority.js"),
  import("../src/integration-native-runtime-roots.js"),
  import("../src/integration-retained-runtime-repository-surface.js"),
  import("../src/integration-runtime-authority.js"),
]);

const { contractDigest } = policyApi;
const { createPublicIntegrationEvent } = eventApi;
const { createRetainedIntegrationNativeSessionRepositoryState } = stateApi;
const {
  INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
  createRetainedIntegrationSessionStateStore,
} = sessionStoreApi;
const {
  INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
  INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE,
  createRetainedIntegrationRuntimeRepositoryKernel,
} = kernelApi;
const {
  createIntegrationRetainedFilePrimitives,
  openIntegrationRetainedRegularFileLock,
  openIntegrationStorageAuthority,
} = storageApi;
const { NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION } = rootsApi;
const {
  acquireRetainedIntegrationRuntimeRepositoryFence,
  assertRetainedIntegrationRuntimeRepositoryFenceLease,
  compactRetainedIntegrationRuntimeRepository,
  createRetainedIntegrationRuntimeRepositorySurface,
  handoffRetainedIntegrationRuntimeRepositoryFence,
} = surfaceApi;
const { createIntegrationRuntimeProcessOwnerBootstrap } = runtimeApi;

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
  await realFs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await realFs.stat(directoryPath);
  if ((stat.mode & 0o777) !== 0o700) await realFs.chmod(directoryPath, 0o700);
  if (stat.uid !== UID || stat.gid !== GID) await realFs.chown(directoryPath, UID, GID);
}

async function ensureLockFile(filePath) {
  try {
    await realFs.stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await realFs.writeFile(filePath, "", { flag: "wx", mode: 0o600 }).catch((writeError) => {
      if (writeError?.code !== "EEXIST") throw writeError;
    });
  }
  const stat = await realFs.stat(filePath);
  if ((stat.mode & 0o777) !== 0o600) await realFs.chmod(filePath, 0o600);
  if (stat.uid !== UID || stat.gid !== GID) await realFs.chown(filePath, UID, GID);
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

async function openFixture(rootPath, { lockWaitMs = 10_000 } = {}) {
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
    label: "retained runtime repository phase-b smoke",
  });
  const helperSha256 = crypto.createHash("sha256").update(await realFs.readFile(HELPER_PATH)).digest("hex");
  const helperIdentityDigest = identityDigest(await realFs.stat(HELPER_PATH, { bigint: true }));

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
    const lockFileIdentityDigest = identityDigest(await realFs.stat(lockPath, { bigint: true }));
    const lock = await openIntegrationRetainedRegularFileLock(files, Object.freeze({
      ...directoryExpected,
      lockFileName,
      helperSha256,
      lockFileIdentityDigest,
      helperIdentityDigest,
    }));
    const expected = Object.freeze({
      ...directoryExpected,
      lockFileIdentityDigest,
      helperSha256,
      helperIdentityDigest,
      [bytesKey]: bytesValue,
      lockWaitMs,
    });
    return Object.freeze({ files, lock, expected });
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
  const sessionStore = createRetainedIntegrationSessionStateStore(
    sessionBinding.files,
    sessionBinding.lock,
    sessionBinding.expected
  );
  const expected = Object.freeze({
    repositoryKernel: repositoryBinding.expected,
    sessionStateStore: sessionBinding.expected,
  });
  const repositoryState = createRetainedIntegrationNativeSessionRepositoryState(kernel, sessionStore, expected);
  const repository = createRetainedIntegrationRuntimeRepositorySurface({
    repositoryState,
    repositoryStateExpected: expected,
    runtimeRoots: runtimeRoots(rootPath),
  });
  return Object.freeze({
    authority,
    expected,
    repository,
    repositoryLock: repositoryBinding.lock,
    repositoryPath,
    repositoryState,
  });
}

function timestamp(baseMs, offsetSeconds) {
  return new Date(baseMs + offsetSeconds * 1000).toISOString();
}

function threadIdFor(index) {
  return `thr_10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function runIdFor(index) {
  return `run_20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function threadPayload(index, createdAt) {
  return Object.freeze({
    threadId: threadIdFor(index),
    nativeSessionId: `aginti:phase-b-${index}`,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    title: `Phase B retained thread ${index}`,
    createdAt,
    policyFingerprint: POLICY_FINGERPRINT,
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

function authorizationFor(run, thread) {
  const unsigned = Object.freeze({
    schemaVersion: "aginti-native-start-authorization-v1",
    mode: "start",
    principalId: run.principalId,
    browserSessionId: run.browserSessionId,
    browserSessionPolicy: run.browserSessionPolicy,
    threadId: run.threadId,
    runId: run.id,
    nativeSessionId: run.nativeSessionId,
    previousRunId: null,
    previousRunRevision: null,
    previousRunRuntimeRevision: null,
    threadRevision: thread.revision,
    threadPreservationDigest: threadPreservationDigest(thread),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    expectedNativeRuntimeRevision: run.authority.runtimeRevision,
    targetNativeRuntimeRevision: run.authority.runtimeRevision,
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

async function prepareTerminalBundle(repository, processOwner, index = 1, baseMs = Date.now() - 120_000) {
  const createPayload = threadPayload(index, timestamp(baseMs, 0));
  const originalThread = (await repository.createIntegrationThread(createPayload)).thread;
  const created = await repository.createIntegrationRun(Object.freeze({
    runId: runIdFor(index),
    threadId: originalThread.id,
    nativeSessionId: originalThread.nativeSessionId,
    previousRunId: null,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    expectedThreadRevision: originalThread.revision,
    expectedNativeRuntimeRevision: originalThread.authority.runtimeRevision,
    input: Object.freeze({ text: "Prove retained compaction atomicity." }),
    createdAt: timestamp(baseMs, 1),
    status: "starting",
  }));
  const dispatched = await repository.markIntegrationRunDispatching(Object.freeze({
    runId: created.run.id,
    threadId: created.run.threadId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: created.run.revision,
    expectedNativeRuntimeRevision: created.run.authority.runtimeRevision,
    dispatchLeaseId: contractDigest({ runId: created.run.id, phase: "phase-b" }),
    dispatchOutbox: true,
    processOwner,
    dispatchedAt: timestamp(baseMs, 2),
  }));
  const authorization = authorizationFor(dispatched.run, created.thread);
  const authorized = await repository.authorizeIntegrationRunNativeStart(Object.freeze({ authorization }));
  const completedAt = timestamp(baseMs, 3);
  const finished = await repository.finishIntegrationRunWithOutbox(Object.freeze({
    runId: authorized.run.id,
    threadId: authorized.run.threadId,
    nativeSessionId: authorized.run.nativeSessionId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: authorized.run.revision,
    expectedNativeRuntimeRevision: authorized.run.authority.runtimeRevision,
    completedNativeRuntimeRevision: authorized.run.authority.runtimeRevision,
    status: "completed",
    output: "",
    error: null,
    completedAt,
    processOwner,
    expectedCursor: Object.freeze({
      firstSeq: 1,
      lastSeq: 0,
      lastHash: ZERO_DIGEST,
      prunedThroughSeq: 0,
    }),
    outputEvent: null,
    terminalEvent: Object.freeze({ type: "run.completed", payload: Object.freeze({}), createdAt: completedAt }),
    resultDigest: contractDigest({ status: "completed", index }),
  }));
  assert.equal(finished.outboxEvents.length, 1);
  const record = finished.outboxEvents[0];
  const event = createPublicIntegrationEvent({
    threadId: record.threadId,
    runId: record.runId,
    seq: record.expectedPreviousSeq + 1,
    type: record.type,
    payload: record.payload,
    createdAt: record.createdAt,
    previousHash: record.expectedPreviousHash,
  });
  const deliveryPayload = Object.freeze({
    outboxId: record.outboxId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    threadId: record.threadId,
    runId: record.runId,
    eventSeq: event.seq,
    eventHash: event.hash,
    eventDigest: contractDigest(event),
    deliveredAt: event.createdAt,
  });
  return Object.freeze({
    authorization,
    createPayload,
    deliveryPayload,
    finished,
    record,
  });
}

async function deliverTerminal(repository, prepared) {
  const result = await repository.markIntegrationOutboxDelivered(prepared.deliveryPayload);
  assert.equal(result.delivered, true);
  return result;
}

async function stagePublishAndDelete(repository, prepared, baseMs = Date.now() - 120_000) {
  await deliverTerminal(repository, prepared);
  const stagePayload = Object.freeze({
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    threadId: prepared.finished.run.threadId,
    runId: prepared.finished.run.id,
    artifact: Object.freeze({
      id: `art_${"d".repeat(64)}`,
      title: "Phase B durable artifact",
      kind: "markdown",
      spec: Object.freeze({ schemaVersion: "1", markdown: "Published artifacts survive retention." }),
    }),
    stagedAt: timestamp(baseMs, 4),
  });
  const staged = await repository.stageIntegrationArtifactOutbox(stagePayload);
  await repository.publishIntegrationArtifactOutbox(Object.freeze({
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    threadId: staged.artifact.threadId,
    runId: staged.artifact.runId,
    artifactId: staged.artifact.id,
    expectedRevision: staged.artifact.revision,
    publishedAt: timestamp(baseMs, 5),
  }));
  await repository.deleteIntegrationThread(Object.freeze({
    threadId: prepared.finished.thread.id,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: prepared.finished.thread.revision,
    deletedAt: timestamp(baseMs, 6),
  }));
  return Object.freeze({ artifactId: staged.artifact.id, stagePayload });
}

async function stageUnpublishedAndDelete(repository, prepared, baseMs = Date.now() - 110_000) {
  await deliverTerminal(repository, prepared);
  const stagePayload = Object.freeze({
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    threadId: prepared.finished.run.threadId,
    runId: prepared.finished.run.id,
    artifact: Object.freeze({
      id: `art_${"f".repeat(64)}`,
      title: "Phase B unpublished artifact",
      kind: "markdown",
      spec: Object.freeze({ schemaVersion: "1", markdown: "Eligible only after its exact receipt horizon closes." }),
    }),
    stagedAt: timestamp(baseMs, 4),
  });
  const staged = await repository.stageIntegrationArtifactOutbox(stagePayload);
  await repository.deleteIntegrationThread(Object.freeze({
    threadId: prepared.finished.thread.id,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: prepared.finished.thread.revision,
    deletedAt: timestamp(baseMs, 5),
  }));
  return Object.freeze({ artifactId: staged.artifact.id, stagePayload });
}

function abortPayloadFor(originalThread, run, abortAt) {
  const unsigned = Object.freeze({
    schemaVersion: "aginti-pre-launch-abort-attempt-v3",
    mode: "start",
    principalId: run.principalId,
    browserSessionId: run.browserSessionId,
    browserSessionPolicy: run.browserSessionPolicy,
    threadId: run.threadId,
    runId: run.id,
    nativeSessionId: run.nativeSessionId,
    previousRunId: null,
    previousThreadRevision: originalThread.revision,
    expectedNativeRuntimeRevision: originalThread.authority.runtimeRevision,
    threadPreservationDigest: threadPreservationDigest(originalThread),
    nativeStartReceiptMustBeAbsent: true,
    createdAt: run.createdAt,
    dispatchAttempted: false,
    dispatchLeaseId: null,
    dispatchOutbox: false,
    dispatchedAt: null,
    processOwner: null,
    abortAt,
  });
  return Object.freeze({ attempt: Object.freeze({ ...unsigned, attemptDigest: contractDigest(unsigned) }) });
}

function missingAbortPayload(baseMs = Date.now() - 100_000) {
  const unsigned = Object.freeze({
    schemaVersion: "aginti-pre-launch-abort-attempt-v3",
    mode: "start",
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId: "thr_30000000-0000-4000-8000-000000000001",
    runId: "run_30000000-0000-4000-8000-000000000002",
    nativeSessionId: "aginti:phase-b-never-created",
    previousRunId: null,
    previousThreadRevision: 1,
    expectedNativeRuntimeRevision: 1,
    threadPreservationDigest: "e".repeat(64),
    nativeStartReceiptMustBeAbsent: true,
    createdAt: timestamp(baseMs, 0),
    dispatchAttempted: false,
    dispatchLeaseId: null,
    dispatchOutbox: false,
    dispatchedAt: null,
    processOwner: null,
    abortAt: timestamp(baseMs, 1),
  });
  return Object.freeze({ attempt: Object.freeze({ ...unsigned, attemptDigest: contractDigest(unsigned) }) });
}

function errorCode(error) {
  return String(error?.publicCode || error?.code || "");
}

function deepFreezeData(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreezeData(value[key]);
  return Object.freeze(value);
}

async function runFaultMode() {
  const rootPath = await realFs.mkdtemp(path.join(os.tmpdir(), `aginti-phase-b-${FAULT_MODE}-`));
  let fixture = null;
  let reopened = null;
  try {
    const bootstrap = await createIntegrationRuntimeProcessOwnerBootstrap();
    fixture = await openFixture(rootPath);
    await acquireRetainedIntegrationRuntimeRepositoryFence(fixture.repository, {
      processOwnerBootstrap: bootstrap,
    });
    const prepared = await prepareTerminalBundle(fixture.repository, bootstrap.processOwner, 91);
    const before = await fixture.repositoryState.loadDomainSnapshot();
    assert.equal(before.state.outboxEvents.length, 1);
    assert.equal(before.state.runs[0].authority.completionOutbox.deliveryCheckpoint, null);
    fault.armed = true;
    let problem = null;
    try {
      await deliverTerminal(fixture.repository, prepared);
    } catch (error) {
      problem = error;
    }
    assert(problem, "faulted delivery compaction must fail or be ambiguous to the caller");
    await fixture.authority.close().catch(() => {});
    fixture = null;

    reopened = await openFixture(rootPath);
    const reacquired = await acquireRetainedIntegrationRuntimeRepositoryFence(reopened.repository, {
      processOwnerBootstrap: bootstrap,
    });
    assert.equal(reacquired.fence.generation, 1);
    const observed = await reopened.repositoryState.loadDomainSnapshot();
    const run = observed.state.runs.find((candidate) => candidate.id === prepared.finished.run.id);
    assert(run);
    if (FAULT_MODE === "rename-before") {
      assert.equal(observed.snapshotRevision, before.snapshotRevision);
      assert.equal(observed.integrityDigest, before.integrityDigest);
      assert.equal(observed.state.outboxEvents.length, 1);
      assert.equal(run.authority.completionOutbox.deliveryCheckpoint, null);
    } else {
      assert.equal(observed.snapshotRevision, before.snapshotRevision + 1);
      assert.equal(observed.state.outboxEvents.length, 0);
      const checkpoint = run.authority.completionOutbox.deliveryCheckpoint;
      assert(checkpoint);
      assert.equal(checkpoint.compactedAtSnapshotRevision, observed.snapshotRevision);
      assert.equal(checkpoint.deliveries.length, 1);
      assert.equal(checkpoint.deliveries[0].eventDigest, prepared.deliveryPayload.eventDigest);
    }
    await deliverTerminal(reopened.repository, prepared);
    const recovered = await reopened.repositoryState.loadDomainSnapshot();
    const recoveredRun = recovered.state.runs.find((candidate) => candidate.id === prepared.finished.run.id);
    assert.equal(recovered.state.outboxEvents.length, 0);
    assert(recoveredRun.authority.completionOutbox.deliveryCheckpoint);
    assert.equal(recoveredRun.authority.completionOutbox.deliveryCheckpoint.deliveries[0].outboxId, prepared.record.outboxId);
    process.stdout.write(`integration retained phase-b ${FAULT_MODE} fault: ok\n`);
  } finally {
    await fixture?.authority.close().catch(() => {});
    await reopened?.authority.close().catch(() => {});
    fsMock?.restore();
    await realFs.rm(rootPath, { recursive: true, force: true });
  }
}

function sendIpc(message) {
  if (typeof process.send === "function") process.send(message);
}

async function childOwnerMode() {
  const fixture = await openFixture(CHILD_ROOT, { lockWaitMs: 15_000 });
  const bootstrap = await createIntegrationRuntimeProcessOwnerBootstrap();
  const saved = Object.create(null);
  sendIpc({ type: "ready", bootstrap, owner: bootstrap.processOwner, pid: process.pid });
  process.on("message", async (message) => {
    const id = message?.id;
    try {
      let result;
      if (message.command === "acquire") {
        result = await acquireRetainedIntegrationRuntimeRepositoryFence(fixture.repository, {
          processOwnerBootstrap: bootstrap,
        });
        const lease = assertRetainedIntegrationRuntimeRepositoryFenceLease(fixture.repository, result.lease);
        assert.equal(lease.ownerDigest, result.fence.ownerDigest);
      } else if (message.command === "handoff") {
        result = await handoffRetainedIntegrationRuntimeRepositoryFence(fixture.repository, {
          currentProcessOwnerBootstrap: bootstrap,
          successorProcessOwner: message.successorOwner,
        });
      } else if (message.command === "stale-write") {
        result = await fixture.repository.createIntegrationThread(threadPayload(800_000 + process.pid, new Date(Date.now() - 1000).toISOString()));
      } else if (message.command === "retired-reacquire") {
        const replacement = await createIntegrationRuntimeProcessOwnerBootstrap();
        result = await acquireRetainedIntegrationRuntimeRepositoryFence(fixture.repository, {
          processOwnerBootstrap: replacement,
        });
      } else if (message.command === "forged-acquire") {
        result = await acquireRetainedIntegrationRuntimeRepositoryFence(fixture.repository, {
          processOwnerBootstrap: deepFreezeData(message.processOwnerBootstrap),
        });
      } else if (message.command === "prepare") {
        const baseMs = Date.now() - 120_000;
        saved.prepared = await prepareTerminalBundle(fixture.repository, bootstrap.processOwner, 11, baseMs);
        saved.artifact = await stagePublishAndDelete(fixture.repository, saved.prepared, baseMs);
        saved.abortPayload = missingAbortPayload(baseMs + 7_000);
        const abortResult = await fixture.repository.abortIntegrationRunBeforeLaunch(saved.abortPayload);
        assert.equal(abortResult.action, "not-created");
        saved.unpublishedPrepared = await prepareTerminalBundle(
          fixture.repository,
          bootstrap.processOwner,
          12,
          baseMs + 10_000
        );
        saved.unpublishedArtifact = await stageUnpublishedAndDelete(
          fixture.repository,
          saved.unpublishedPrepared,
          baseMs + 10_000
        );
        const hiddenOriginal = (await fixture.repository.createIntegrationThread(
          threadPayload(13, timestamp(baseMs, 20))
        )).thread;
        const hiddenCreated = await fixture.repository.createIntegrationRun(Object.freeze({
          runId: runIdFor(13),
          threadId: hiddenOriginal.id,
          nativeSessionId: hiddenOriginal.nativeSessionId,
          previousRunId: null,
          principalId: PRINCIPAL,
          browserSessionId: BROWSER_SESSION,
          browserSessionPolicy: "same-browser-session",
          expectedThreadRevision: hiddenOriginal.revision,
          expectedNativeRuntimeRevision: hiddenOriginal.authority.runtimeRevision,
          input: Object.freeze({ text: "Abort before launch." }),
          createdAt: timestamp(baseMs, 21),
          status: "starting",
        }));
        saved.hiddenAbortPayload = abortPayloadFor(
          hiddenOriginal,
          hiddenCreated.run,
          timestamp(baseMs, 22)
        );
        const hiddenAbort = await fixture.repository.abortIntegrationRunBeforeLaunch(saved.hiddenAbortPayload);
        assert.equal(hiddenAbort.action, "aborted");
        const preparedSnapshot = await fixture.repositoryState.loadDomainSnapshot();
        assert(preparedSnapshot.state.artifacts.some((artifact) => artifact.id === saved.unpublishedArtifact.artifactId));
        assert(preparedSnapshot.state.runs.some((run) => run.id === hiddenCreated.run.id && run.hidden));
        saved.hiddenRunId = hiddenCreated.run.id;
        result = {
          artifactId: saved.artifact.artifactId,
          hiddenRunId: saved.hiddenRunId,
          unpublishedArtifactId: saved.unpublishedArtifact.artifactId,
        };
      } else if (message.command === "fill") {
        const baseMs = Date.now() - 80_000;
        saved.firstFillPayload = null;
        for (let index = 0; index < message.count; index += 1) {
          const payload = threadPayload(20_000 + index, timestamp(baseMs, index));
          saved.firstFillPayload ||= payload;
          await fixture.repository.createIntegrationThread(payload);
        }
        const snapshot = await fixture.repositoryState.loadDomainSnapshot();
        result = { receipts: snapshot.state.mutationReceipts.length, revision: snapshot.snapshotRevision };
      } else if (message.command === "compact") {
        result = await compactRetainedIntegrationRuntimeRepository(fixture.repository);
      } else if (message.command === "replay-suite") {
        const before = await fixture.repositoryState.loadDomainSnapshot();
        const codes = Object.create(null);
        for (const [name, action] of [
          ["create", () => fixture.repository.createIntegrationThread(saved.firstFillPayload)],
          ["abort", () => fixture.repository.abortIntegrationRunBeforeLaunch(saved.abortPayload)],
          ["stage", () => fixture.repository.stageIntegrationArtifactOutbox(saved.artifact.stagePayload)],
          ["unpublishedStage", () => fixture.repository.stageIntegrationArtifactOutbox(saved.unpublishedArtifact.stagePayload)],
          ["hiddenAbort", () => fixture.repository.abortIntegrationRunBeforeLaunch(saved.hiddenAbortPayload)],
        ]) {
          try {
            await action();
            codes[name] = "unexpected-success";
          } catch (error) {
            codes[name] = errorCode(error);
          }
        }
        let authorizationCode = "unexpected-success";
        try {
          await fixture.repository.authorizeIntegrationRunNativeStart(Object.freeze({
            authorization: saved.prepared.authorization,
          }));
        } catch (error) {
          authorizationCode = errorCode(error);
        }
        const delivery = await fixture.repository.markIntegrationOutboxDelivered(saved.prepared.deliveryPayload);
        const after = await fixture.repositoryState.loadDomainSnapshot();
        result = {
          codes,
          authorizationCode,
          delivered: delivery.delivered,
          unchanged: before.snapshotRevision === after.snapshotRevision,
        };
      } else if (message.command === "snapshot") {
        const snapshot = await fixture.repositoryState.loadDomainSnapshot();
        const snapshotStat = await realFs.stat(path.join(fixture.repositoryPath, INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE));
        result = {
          artifacts: snapshot.state.artifacts.length,
          bytes: snapshotStat.size,
          checkpointCount: snapshot.state.runs.filter((run) => run.authority.completionOutbox?.deliveryCheckpoint).length,
          floor: snapshot.state.retention.exactReplayFloorSnapshotRevision,
          publishedArtifacts: snapshot.state.artifacts.filter((artifact) => artifact.published).length,
          hiddenAbortRuns: snapshot.state.runs.filter((run) => run.status === "aborted_before_launch" && run.hidden).length,
          receipts: snapshot.state.mutationReceipts.length,
          revision: snapshot.snapshotRevision,
          tombstoneThreads: snapshot.state.threads.filter((thread) => thread.tombstone).length,
          unpublishedArtifacts: snapshot.state.artifacts.filter((artifact) => !artifact.published).length,
        };
      } else if (message.command === "close") {
        await fixture.authority.close();
        result = { closed: true };
        sendIpc({ type: "response", id, ok: true, result });
        process.exit(0);
        return;
      } else {
        throw new Error(`unknown child owner command ${message.command}`);
      }
      sendIpc({ type: "response", id, ok: true, result });
    } catch (error) {
      sendIpc({
        type: "response",
        id,
        ok: false,
        code: errorCode(error),
        message: `${String(error?.message || error)} ${JSON.stringify(error?.details || {})}`,
      });
    }
  });
}

async function childLockMode() {
  const fixture = await openFixture(CHILD_ROOT, { lockWaitMs: 15_000 });
  sendIpc({ type: "ready", pid: process.pid });
  process.on("message", async (message) => {
    if (message.command !== "hold") return;
    try {
      await fixture.repositoryLock.runExclusive(async () => {
        sendIpc({ type: "lock-held", id: message.id });
        await new Promise(() => {});
      }, { waitMs: 15_000 });
    } catch (error) {
      sendIpc({ type: "response", id: message.id, ok: false, code: errorCode(error), message: error.message });
    }
  });
}

function spawnChild(mode, rootPath) {
  const child = fork(fileURLToPath(import.meta.url), [`--child=${mode}`, `--root=${rootPath}`], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const eventWaiters = [];
  child.on("message", (message) => {
    if (message?.type === "response" && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else {
        const error = new Error(`${waiter.command}: ${message.message || message.code || "child command failed"}`);
        error.code = message.code;
        waiter.reject(error);
      }
      return;
    }
    const waiterIndex = eventWaiters.findIndex((waiter) => waiter.type === message?.type);
    if (waiterIndex >= 0) {
      const [waiter] = eventWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      events.push(message);
    }
  });
  child.on("exit", (code, signal) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`child exited (${code ?? signal}): ${stderr}`));
    }
    pending.clear();
  });
  function waitEvent(type, timeoutMs = 15_000) {
    const index = events.findIndex((event) => event?.type === type);
    if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const waiterIndex = eventWaiters.indexOf(waiter);
        if (waiterIndex >= 0) eventWaiters.splice(waiterIndex, 1);
        reject(new Error(`timed out waiting for ${type}: ${stderr}`));
      }, timeoutMs);
      eventWaiters.push(waiter);
    });
  }
  function request(command, payload = {}, timeoutMs = 20_000) {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out running ${command}: ${stderr}`));
      }, timeoutMs);
      pending.set(id, {
        command,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    child.send({ id, command, ...payload });
    return promise;
  }
  return Object.freeze({ child, request, waitEvent, stderr: () => stderr });
}

async function killAndWait(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  const exited = new Promise((resolve) => handle.child.once("exit", resolve));
  handle.child.kill("SIGKILL");
  await exited;
}

async function expectChildCode(action, code) {
  let problem = null;
  try {
    await action();
  } catch (error) {
    problem = error;
  }
  assert(problem, `expected child error ${code}`);
  assert.equal(problem.code, code, problem.message);
}

async function runMultiProcessMode() {
  const rootPath = await realFs.mkdtemp(path.join(os.tmpdir(), "aginti-phase-b-multiprocess-"));
  const children = [];
  try {
    const first = spawnChild("owner", rootPath);
    children.push(first);
    const firstReady = await first.waitEvent("ready");
    const firstFence = await first.request("acquire");
    assert.equal(firstFence.fence.generation, 1);
    assert.match(firstFence.lease.digest, /^[a-f0-9]{64}$/u);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = spawnChild("owner", rootPath);
    children.push(second);
    const secondReady = await second.waitEvent("ready");
    await expectChildCode(() => second.request("acquire"), "INTEGRATION_REPOSITORY_FENCE_HELD");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const handoff = await first.request("handoff", { successorOwner: secondReady.owner });
    assert.equal(handoff.fence.generation, 2);
    const secondFence = await second.request("acquire");
    assert.equal(secondFence.fence.generation, 2);
    await expectChildCode(
      () => first.request("forged-acquire", { processOwnerBootstrap: secondReady.bootstrap }),
      "AGENT_UNAVAILABLE"
    );
    await expectChildCode(() => first.request("stale-write"), "INTEGRATION_REPOSITORY_FENCE_STALE");
    await expectChildCode(() => first.request("retired-reacquire"), "INTEGRATION_REPOSITORY_FENCE_RETIRED");

    await killAndWait(second);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const successor = spawnChild("owner", rootPath);
    children.push(successor);
    await successor.waitEvent("ready");
    const successorFence = await successor.request("acquire");
    assert.equal(successorFence.fence.generation, 3);
    await successor.request("prepare", {}, 30_000);
    const beforeHorizon = await successor.request("snapshot");
    assert.equal(beforeHorizon.unpublishedArtifacts, 1);
    assert.equal(beforeHorizon.hiddenAbortRuns, 1);
    assert.equal(beforeHorizon.receipts, 21);
    await successor.request("fill", { count: 20 }, 45_000);
    const beforeCompaction = await successor.request("snapshot");
    assert(beforeCompaction.receipts > 16 && beforeCompaction.receipts <= 24);
    assert.equal(beforeCompaction.publishedArtifacts, 1);
    assert.equal(beforeCompaction.tombstoneThreads, 2);
    assert.equal(beforeCompaction.checkpointCount, 2);
    assert.equal(beforeCompaction.unpublishedArtifacts, 0);
    assert.equal(beforeCompaction.hiddenAbortRuns, 1);

    const lockHolder = spawnChild("lock", rootPath);
    children.push(lockHolder);
    await lockHolder.waitEvent("ready");
    const holdId = 9_999;
    lockHolder.child.send({ id: holdId, command: "hold" });
    await lockHolder.waitEvent("lock-held");
    let compactSettled = false;
    const compactPromise = successor.request("compact", {}, 30_000).finally(() => { compactSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(compactSettled, false, "compaction must wait behind the real cross-process lock");
    await killAndWait(lockHolder);
    const compacted = await compactPromise;
    assert.equal(compacted.outcome, "committed");
    const afterCompaction = await successor.request("snapshot");
    assert.equal(afterCompaction.receipts, 16);
    assert(afterCompaction.floor > 0);
    assert(afterCompaction.bytes < 2 * 1024 * 1024);
    assert.equal(afterCompaction.publishedArtifacts, 1);
    assert.equal(afterCompaction.tombstoneThreads, 2);
    assert.equal(afterCompaction.unpublishedArtifacts, 0);
    assert.equal(afterCompaction.hiddenAbortRuns, 0);
    const replay = await successor.request("replay-suite");
    assert.deepEqual(replay.codes, {
      create: "INTEGRATION_REPOSITORY_REPLAY_WINDOW_EXPIRED",
      abort: "INTEGRATION_REPOSITORY_REPLAY_WINDOW_EXPIRED",
      stage: "INTEGRATION_REPOSITORY_REPLAY_WINDOW_EXPIRED",
      unpublishedStage: "INTEGRATION_REPOSITORY_REPLAY_WINDOW_EXPIRED",
      hiddenAbort: "INTEGRATION_REPOSITORY_REPLAY_WINDOW_EXPIRED",
    });
    assert.equal(replay.authorizationCode, "INTEGRATION_REPOSITORY_REPLAY_WINDOW_EXPIRED");
    assert.equal(replay.delivered, true);
    assert.equal(replay.unchanged, true);

    await killAndWait(successor);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const reopened = spawnChild("owner", rootPath);
    children.push(reopened);
    await reopened.waitEvent("ready");
    const reopenedFence = await reopened.request("acquire");
    assert.equal(reopenedFence.fence.generation, 4);
    const reopenedSnapshot = await reopened.request("snapshot");
    assert.equal(reopenedSnapshot.receipts, 16);
    assert.equal(reopenedSnapshot.publishedArtifacts, 1);
    assert.equal(reopenedSnapshot.tombstoneThreads, 2);
    assert.equal(reopenedSnapshot.checkpointCount, 2);
    assert.equal(reopenedSnapshot.unpublishedArtifacts, 0);
    assert.equal(reopenedSnapshot.hiddenAbortRuns, 0);
    await reopened.request("close");
    await killAndWait(first);
    process.stdout.write("integration retained phase-b multiprocess overlap/kill: ok\n");
  } finally {
    for (const child of children) await killAndWait(child).catch(() => {});
    await realFs.rm(rootPath, { recursive: true, force: true });
  }
}

async function runMain() {
  await runMultiProcessMode();
  for (const mode of ["rename-before", "rename-after"]) {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-test-module-mocks", fileURLToPath(import.meta.url), `--fault=${mode}`],
      { timeout: 60_000, maxBuffer: 1024 * 1024 }
    );
    assert.match(stdout, new RegExp(`phase-b ${mode} fault: ok`, "u"));
  }
  process.stdout.write("integration retained runtime repository phase-b smoke: ok\n");
}

if (FAULT_MODE) {
  await runFaultMode();
} else if (CHILD_MODE === "owner") {
  await childOwnerMode();
} else if (CHILD_MODE === "lock") {
  await childLockMode();
} else {
  await runMain();
}
