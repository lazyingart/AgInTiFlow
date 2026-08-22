#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPublicIntegrationEvent,
} from "../src/integration-events.js";
import {
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MUTATION_RECEIPT_VERSION,
  createRetainedIntegrationNativeSessionRepositoryState,
} from "../src/integration-retained-native-session-repository-state.js";
import {
  INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
  createRetainedIntegrationSessionStateStore,
} from "../src/integration-retained-session-state-store.js";
import {
  INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
  INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE,
  createRetainedIntegrationRuntimeRepositoryKernel,
} from "../src/integration-runtime-repository.js";
import {
  createIntegrationRetainedFilePrimitives,
  openIntegrationRetainedRegularFileLock,
  openIntegrationStorageAuthority,
} from "../src/integration-storage-authority.js";
import {
  NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
} from "../src/integration-native-runtime-roots.js";
import {
  contractDigest,
} from "../src/integration-policy.js";
import {
  INTEGRATION_RUNTIME_REPOSITORY_METHODS,
  assertIntegrationRuntimeRepositorySurface,
} from "../src/integration-runtime-repository-contract.js";
import {
  INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS,
  acquireRetainedIntegrationRuntimeRepositoryFence,
  assertRetainedIntegrationRuntimeRepositorySurface,
  createRetainedIntegrationRuntimeRepositorySurface,
} from "../src/integration-retained-runtime-repository-surface.js";
import { createIntegrationRuntimeProcessOwnerBootstrap } from "../src/integration-runtime-authority.js";

const UID = process.getuid();
const GID = process.getgid();
const HELPER_PATH = "/usr/bin/flock";
const ZERO_DIGEST = "0".repeat(64);
const PRINCIPAL = "principalAAAAAAAA";
const BROWSER_SESSION = "a".repeat(64);
const OTHER_PRINCIPAL = "principalBBBBBBBB";
const OTHER_BROWSER_SESSION = "d".repeat(64);
const POLICY_FINGERPRINT = "b".repeat(64);
const ROLE = "retained-runtime-repository-surface-smoke";
const BASE_MS = Date.parse("2026-08-22T02:00:00.000Z");
let primaryProcessOwnerBootstrap = null;
let primaryProcessOwner = null;

const IDS = Object.freeze({
  mainThread: "thr_00000000-0000-4000-8000-000000000201",
  mainRun: "run_00000000-0000-4000-8000-000000000202",
  cancelThread: "thr_00000000-0000-4000-8000-000000000203",
  cancelRun: "run_00000000-0000-4000-8000-000000000204",
  abortThread: "thr_00000000-0000-4000-8000-000000000205",
  abortRun: "run_00000000-0000-4000-8000-000000000206",
  preauthThread: "thr_00000000-0000-4000-8000-000000000207",
  preauthRun: "run_00000000-0000-4000-8000-000000000208",
  heldThread: "thr_00000000-0000-4000-8000-000000000209",
  heldRun: "run_00000000-0000-4000-8000-000000000210",
  deletedThread: "thr_00000000-0000-4000-8000-000000000211",
  otherThread: "thr_00000000-0000-4000-8000-000000000212",
  otherRun: "run_00000000-0000-4000-8000-000000000213",
  resumeHeldRun: "run_00000000-0000-4000-8000-000000000214",
});

function timestamp(offsetSeconds) {
  return new Date(BASE_MS + offsetSeconds * 1000).toISOString();
}

function owner(tokenDigit = "1", offsetSeconds = 0) {
  if ((tokenDigit === "1" || tokenDigit === "9") && primaryProcessOwner) return primaryProcessOwner;
  const numericDigit = Number(tokenDigit);
  return Object.freeze({
    schemaVersion: "aginti-process-owner-v1",
    pid: 4242 + numericDigit,
    token: tokenDigit.repeat(32),
    processIdentity: Object.freeze({
      schemaVersion: "aginti-process-identity-v1",
      bootId: "01234567-89ab-cdef-0123-456789abcdef",
      startTimeTicks: `12345${tokenDigit}`,
    }),
    acquiredAt: timestamp(offsetSeconds),
    heartbeatAt: timestamp(offsetSeconds),
  });
}

async function activateRepository(repository) {
  return acquireRetainedIntegrationRuntimeRepositoryFence(repository, {
    processOwnerBootstrap: primaryProcessOwnerBootstrap,
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

function runtimeRoots(rootPath, { sessionsDir = path.join(rootPath, "native:sessions") } = {}) {
  const unsigned = Object.freeze({
    schemaVersion: NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
    sessionsDir,
    baseDir: path.join(rootPath, "workspace"),
    commandCwd: path.join(rootPath, "workspace"),
    retainedDescriptor: true,
    symlinkFree: true,
    outsideForbiddenRoots: true,
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

async function openFixture(rootPath, now) {
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
    label: "retained runtime repository surface smoke",
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
    const expected = Object.freeze({
      ...directoryExpected,
      lockFileIdentityDigest,
      helperSha256,
      helperIdentityDigest,
      [bytesKey]: bytesValue,
      lockWaitMs: 3000,
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
    now,
    processOwnerLiveness: async () => "alive",
  });
  return Object.freeze({ authority, repositoryState, repository, expected });
}

function createThreadPayload(
  threadId,
  nativeSessionId,
  createdAt,
  title = "Durable native thread",
  principalId = PRINCIPAL,
  browserSessionId = BROWSER_SESSION
) {
  return Object.freeze({
    threadId,
    nativeSessionId,
    principalId,
    browserSessionId,
    browserSessionPolicy: "same-browser-session",
    title,
    createdAt,
    policyFingerprint: POLICY_FINGERPRINT,
  });
}

function threadScope(threadId, principalId = PRINCIPAL, browserSessionId = BROWSER_SESSION) {
  return Object.freeze({ threadId, principalId, browserSessionId });
}

function runScope(runId, principalId = PRINCIPAL, browserSessionId = BROWSER_SESSION) {
  return Object.freeze({ runId, principalId, browserSessionId });
}

function createRunPayload({ runId, thread, previousRunId = null, createdAt, text = "Create durable proof." }) {
  return Object.freeze({
    runId,
    threadId: thread.id,
    nativeSessionId: thread.nativeSessionId,
    previousRunId,
    principalId: thread.principalId,
    browserSessionId: thread.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    expectedThreadRevision: thread.revision,
    expectedNativeRuntimeRevision: thread.authority.runtimeRevision,
    input: Object.freeze({ text }),
    createdAt,
    status: "starting",
  });
}

function dispatchPayload(run, dispatchedAt, processOwner = owner("1", 1)) {
  return Object.freeze({
    runId: run.id,
    threadId: run.threadId,
    principalId: run.principalId,
    browserSessionId: run.browserSessionId,
    expectedRevision: run.revision,
    expectedNativeRuntimeRevision: run.authority.runtimeRevision,
    dispatchLeaseId: contractDigest({ runId: run.id, nativeSessionId: run.nativeSessionId, createdAt: run.createdAt }),
    dispatchOutbox: true,
    processOwner,
    dispatchedAt,
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

function authorizationFor({ mode = "start", run, thread, previous = null, targetRuntimeRevision }) {
  const unsigned = {
    schemaVersion: "aginti-native-start-authorization-v1",
    mode,
    principalId: run.principalId,
    browserSessionId: run.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    threadId: thread.id,
    runId: run.id,
    nativeSessionId: run.nativeSessionId,
    previousRunId: previous?.id || null,
    previousRunRevision: previous?.revision || null,
    previousRunRuntimeRevision: previous?.authority.runtimeRevision || null,
    threadRevision: thread.revision,
    threadPreservationDigest: threadPreservationDigest(thread),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    expectedNativeRuntimeRevision: run.authority.runtimeRevision,
    targetNativeRuntimeRevision: targetRuntimeRevision,
    expectedRunRevision: run.revision,
    targetRunRevision: run.revision + 1,
    dispatchLeaseId: run.dispatchLeaseId,
    dispatchOutbox: true,
    dispatchedAt: run.dispatchedAt,
    processOwner: run.processOwner,
    authorizedAt: run.dispatchedAt,
  };
  const authorizationDigest = contractDigest(unsigned);
  return Object.freeze({
    ...unsigned,
    authorizationId: `nstart_${authorizationDigest.slice(0, 48)}`,
    authorizationDigest,
  });
}

function abortAttemptFor({ originalThread, run, abortAt, dispatchAttempted = false }) {
  const unsigned = {
    schemaVersion: "aginti-pre-launch-abort-attempt-v3",
    mode: run.previousRunId ? "resume" : "start",
    principalId: run.principalId,
    browserSessionId: run.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    threadId: run.threadId,
    runId: run.id,
    nativeSessionId: run.nativeSessionId,
    previousRunId: run.previousRunId,
    previousThreadRevision: originalThread.revision,
    expectedNativeRuntimeRevision: originalThread.authority.runtimeRevision,
    threadPreservationDigest: threadPreservationDigest(originalThread),
    nativeStartReceiptMustBeAbsent: true,
    createdAt: run.createdAt,
    dispatchAttempted,
    dispatchLeaseId: dispatchAttempted ? run.dispatchLeaseId : null,
    dispatchOutbox: dispatchAttempted,
    dispatchedAt: dispatchAttempted ? run.dispatchedAt : null,
    processOwner: dispatchAttempted ? run.processOwner : null,
    abortAt,
  };
  return Object.freeze({ ...unsigned, attemptDigest: contractDigest(unsigned) });
}

function reconciliationRequest(processOwner, reconciledAt, liveRunClaims = []) {
  const unsigned = Object.freeze({
    schemaVersion: "aginti-dispatch-reconciliation-v1",
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    processOwner,
    liveRunClaims: Object.freeze(liveRunClaims),
    reconciledAt,
  });
  return Object.freeze({ ...unsigned, requestDigest: contractDigest(unsigned) });
}

async function createDispatched(repository, {
  threadId,
  runId,
  nativeSessionId,
  createdAt,
  dispatchedAt,
  principalId = PRINCIPAL,
  browserSessionId = BROWSER_SESSION,
  processOwner = owner("1", 1),
}) {
  const threadPayload = createThreadPayload(
    threadId,
    nativeSessionId,
    createdAt,
    "Durable native thread",
    principalId,
    browserSessionId
  );
  const originalThread = (await repository.createIntegrationThread(threadPayload)).thread;
  const created = await repository.createIntegrationRun(createRunPayload({ runId, thread: originalThread, createdAt }));
  const dispatched = (await repository.markIntegrationRunDispatching(
    dispatchPayload(created.run, dispatchedAt, processOwner)
  )).run;
  return Object.freeze({ threadPayload, originalThread, createdThread: created.thread, dispatched });
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

async function run() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-runtime-repository-"));
  let clockTick = 500;
  const now = () => new Date(BASE_MS + clockTick++ * 1000);
  let fixture = null;
  try {
    primaryProcessOwnerBootstrap = await createIntegrationRuntimeProcessOwnerBootstrap();
    primaryProcessOwner = primaryProcessOwnerBootstrap.processOwner;
    fixture = await openFixture(rootPath, now);
    const { repository } = fixture;
    await activateRepository(repository);
    assert.equal(assertRetainedIntegrationRuntimeRepositorySurface(repository), repository);
    assert.equal(
      assertIntegrationRuntimeRepositorySurface(repository, { requireRetainedDescriptorStorage: true }).attestation,
      repository.integrationRuntimeRepositoryAttestation
    );
    assert.deepEqual(
      Reflect.ownKeys(repository).slice(1),
      INTEGRATION_RUNTIME_REPOSITORY_METHODS
    );
    assert.equal(repository.integrationRuntimeRepositoryAttestation.retainedDescriptorStorageAuthority, true);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.runtimeCapabilityEnabled, false);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.artifactCompletionAtomic, false);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.artifactRuntimeProducerWiring, false);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.singleRuntimeProcessRequired, false);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.rollingRestartOverlapSafe, true);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.sharedProcessLeaseOrFence, true);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.nativeSessionMappingTombstonePruning, false);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.liveOwnerPublishedArtifactPruning, false);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.trustedDependencyIntrinsicsRequired, true);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.dependencyWidePrototypePoisonResistance, false);
    assert.equal(INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS.artifactOwnerTombstoneVisibilityFiltering, true);
    await expectCode(
      () => createRetainedIntegrationRuntimeRepositorySurface({
        repositoryState: fixture.repositoryState,
        repositoryStateExpected: fixture.expected,
        runtimeRoots: runtimeRoots(rootPath, { sessionsDir: path.join(rootPath, "unbound-native:sessions") }),
        now,
      }),
      "INTEGRATION_REPOSITORY_UNAVAILABLE"
    );

    const unhandledRejections = [];
    const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const rejectedThreadId = Promise.reject(new Error("already rejected repository payload"));
      await expectCode(
        () => repository.getIntegrationThread({
          threadId: rejectedThreadId,
          principalId: PRINCIPAL,
          browserSessionId: BROWSER_SESSION,
        }),
        "INTEGRATION_REPOSITORY_INVALID"
      );
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
    }
    assert.deepEqual(unhandledRejections, []);

    let speciesGetterCalls = 0;
    class SpeciesTrapPromise extends Promise {}
    Object.defineProperty(SpeciesTrapPromise, Symbol.species, {
      configurable: true,
      get() {
        speciesGetterCalls += 1;
        throw new Error("promise species getter must not run");
      },
    });
    const speciesTrapPromise = new SpeciesTrapPromise(() => {});
    await expectCode(
      () => repository.getIntegrationThread({
        threadId: speciesTrapPromise,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
      }),
      "INTEGRATION_REPOSITORY_INVALID"
    );
    assert.equal(speciesGetterCalls, 0);

    let thenGetterCalls = 0;
    const plainThenable = Object.create(null);
    Object.defineProperty(plainThenable, "then", {
      enumerable: true,
      get() {
        thenGetterCalls += 1;
        throw new Error("plain thenable getter must not run");
      },
    });
    await expectCode(
      () => repository.getIntegrationThread({
        threadId: plainThenable,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
      }),
      "INTEGRATION_REPOSITORY_INVALID"
    );
    assert.equal(thenGetterCalls, 0);

    let proxyTrapCalls = 0;
    const nestedProxy = new Proxy(Object.freeze({}), {
      get() {
        proxyTrapCalls += 1;
        throw new Error("nested proxy get trap must not run");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("nested proxy ownKeys trap must not run");
      },
    });
    await expectCode(
      () => repository.getIntegrationThread({
        threadId: Object.freeze({ nestedProxy }),
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
      }),
      "INTEGRATION_REPOSITORY_INVALID"
    );
    assert.equal(proxyTrapCalls, 0);
    const revoked = Proxy.revocable(Object.freeze({}), {});
    revoked.revoke();
    await expectCode(
      () => repository.getIntegrationThread({
        threadId: revoked.proxy,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
      }),
      "INTEGRATION_REPOSITORY_INVALID"
    );

    const mainCreatedAt = timestamp(0);
    const mainThreadPayload = createThreadPayload(IDS.mainThread, "aginti:durable-main", mainCreatedAt);
    const concurrent = await Promise.all([
      repository.createIntegrationThread(mainThreadPayload),
      repository.createIntegrationThread(mainThreadPayload),
    ]);
    assert.deepEqual(concurrent[0], concurrent[1]);
    assert.equal(concurrent[0].thread.revision, 1);
    const afterConcurrent = await fixture.repositoryState.loadDomainSnapshot();
    assert.equal(afterConcurrent.state.threads.length, 1);
    assert.equal(afterConcurrent.state.mutationReceipts.length, 1);
    assert.equal(
      afterConcurrent.state.mutationReceipts[0].schemaVersion,
      INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MUTATION_RECEIPT_VERSION
    );
    await expectCode(
      () => repository.createIntegrationThread({ ...mainThreadPayload, title: "Changed retry body" }),
      "THREAD_CONFLICT"
    );

    const updatedThread = (await repository.updateIntegrationThread({
      threadId: IDS.mainThread,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: 1,
      title: "Durable renamed thread",
      updatedAt: timestamp(1),
    })).thread;
    assert.equal(updatedThread.revision, 2);
    assert.equal((await repository.getIntegrationThread(threadScope(IDS.mainThread))).thread.title, "Durable renamed thread");
    assert.equal((await repository.listIntegrationThreads({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      limit: 20,
      before: "",
    })).threads.length, 1);

    const createdMain = await repository.createIntegrationRun(createRunPayload({
      runId: IDS.mainRun,
      thread: updatedThread,
      createdAt: timestamp(2),
    }));
    assert.equal(createdMain.run.status, "starting");
    assert.equal((await repository.getActiveIntegrationRunForThread(threadScope(IDS.mainThread))).run.id, IDS.mainRun);
    const dispatchedMain = (await repository.markIntegrationRunDispatching(
      dispatchPayload(createdMain.run, timestamp(3), owner("1", 1))
    )).run;
    const mainAuthorization = authorizationFor({
      run: dispatchedMain,
      thread: createdMain.thread,
      targetRuntimeRevision: 1,
    });
    const authorizedMain = await repository.authorizeIntegrationRunNativeStart({ authorization: mainAuthorization });
    assert.equal(authorizedMain.outcome, "authorized");
    assert.equal(authorizedMain.run.revision, 3);

    const mainOutput = "D".repeat(32_000);
    const finishMainPayload = Object.freeze({
      runId: IDS.mainRun,
      threadId: IDS.mainThread,
      nativeSessionId: dispatchedMain.nativeSessionId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: authorizedMain.run.revision,
      expectedNativeRuntimeRevision: 1,
      completedNativeRuntimeRevision: 1,
      status: "completed",
      output: mainOutput,
      error: null,
      completedAt: timestamp(4),
      processOwner: owner("1", 1),
      expectedCursor: Object.freeze({ firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 }),
      outputEvent: Object.freeze({ type: "output.delta", payload: Object.freeze({ text: mainOutput.slice(0, 4_000) }), createdAt: timestamp(4) }),
      terminalEvent: Object.freeze({ type: "run.completed", payload: Object.freeze({}), createdAt: timestamp(4) }),
      resultDigest: contractDigest({ status: "completed", output: mainOutput }),
    });
    await expectCode(
      () => repository.finishIntegrationRunWithOutbox({
        ...finishMainPayload,
        processOwner: owner("3", 1),
      }),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => repository.finishIntegrationRunWithOutbox({
        ...finishMainPayload,
        output: Object.freeze({ text: "not a scalar" }),
        outputEvent: null,
      }),
      "INTEGRATION_REPOSITORY_INVALID"
    );
    await expectCode(
      () => repository.finishIntegrationRunWithOutbox({
        ...finishMainPayload,
        status: "cancelled",
        output: "",
        error: Object.freeze({ code: "AGINTI_RUNTIME_ERROR", message: "Wrong cancellation code." }),
        outputEvent: null,
        terminalEvent: Object.freeze({ type: "run.cancelled", payload: Object.freeze({}), createdAt: timestamp(4) }),
      }),
      "INTEGRATION_REPOSITORY_INVALID"
    );
    await expectCode(
      () => repository.finishIntegrationRunWithOutbox({
        ...finishMainPayload,
        status: "failed",
        output: "",
        error: Object.freeze({ code: "CANCELLED", message: "Wrong failure code." }),
        outputEvent: null,
        terminalEvent: Object.freeze({ type: "run.failed", payload: Object.freeze({}), createdAt: timestamp(4) }),
      }),
      "INTEGRATION_REPOSITORY_INVALID"
    );
    await expectCode(
      () => repository.finishIntegrationRunWithOutbox({
        ...finishMainPayload,
        output: "D".repeat(32_001),
        outputEvent: null,
      }),
      "INTEGRATION_REPOSITORY_INVALID"
    );
    await expectCode(
      () => repository.finishIntegrationRunWithOutbox({
        ...finishMainPayload,
        status: "failed",
        output: "",
        error: Object.freeze({ code: "PRIVATE_RUNTIME_ERROR", message: "Not public." }),
        outputEvent: null,
        terminalEvent: Object.freeze({ type: "run.failed", payload: Object.freeze({}), createdAt: timestamp(4) }),
      }),
      "INTEGRATION_REPOSITORY_INVALID"
    );
    const finishedMain = await repository.finishIntegrationRunWithOutbox(finishMainPayload);
    assert.equal(finishedMain.run.status, "completed");
    assert.equal(finishedMain.resultDigest, finishMainPayload.resultDigest);
    assert.equal(finishedMain.run.authority.snapshotHash, authorizedMain.run.authority.snapshotHash);
    assert.equal(finishedMain.run.authority.completionOutbox.schemaVersion, "aginti-completion-outbox-bundle-v2");
    assert.equal(finishedMain.outboxEvents.length, 2);
    const bundle = await repository.getIntegrationCompletionOutboxBundle({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: IDS.mainThread,
      runId: IDS.mainRun,
    });
    assert.deepEqual(bundle.outboxEvents.map((record) => record.outboxId), finishedMain.outboxEvents.map((record) => record.outboxId));

    assert.equal((await repository.listPendingIntegrationOutboxEvents({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    })).outboxEvents.length, 2);
    for (const record of finishedMain.outboxEvents) {
      const event = createPublicIntegrationEvent({
        threadId: record.threadId,
        runId: record.runId,
        seq: record.expectedPreviousSeq + 1,
        type: record.type,
        payload: record.payload,
        createdAt: record.createdAt,
        previousHash: record.expectedPreviousHash,
      });
      await repository.markIntegrationOutboxDelivered({
        outboxId: record.outboxId,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
        threadId: record.threadId,
        runId: record.runId,
        eventSeq: event.seq,
        eventHash: event.hash,
        eventDigest: contractDigest(event),
        deliveredAt: timestamp(5),
      });
    }
    assert.equal((await repository.listPendingIntegrationOutboxEvents({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    })).outboxEvents.length, 0);

    const stagedAt = timestamp(5);
    const artifactInput = Object.freeze({
      id: `art_${"c".repeat(64)}`,
      title: "Durable proof",
      kind: "markdown",
      spec: Object.freeze({ schemaVersion: "1", markdown: "Durable repository proof." }),
    });
    const stagePayload = Object.freeze({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: IDS.mainThread,
      runId: IDS.mainRun,
      artifact: artifactInput,
      stagedAt,
    });
    const staged = await repository.stageIntegrationArtifactOutbox(stagePayload);
    assert.equal(staged.artifact.published, false);
    assert.notEqual(staged.artifact.id, artifactInput.id);
    assert.equal((await repository.listIntegrationArtifacts({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: IDS.mainThread,
      runId: "",
      publishedOnly: true,
    })).artifacts.length, 0);
    assert.equal((await repository.getIntegrationArtifact({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      artifactId: staged.artifact.id,
      publishedOnly: true,
    })).artifact, null);

    const generationBeforeRestart = (await fixture.repositoryState.loadDomainSnapshot()).snapshotRevision;
    await fixture.authority.close();
    fixture = await openFixture(rootPath, now);
    const reopened = fixture.repository;
    await activateRepository(reopened);
    assert.equal((await reopened.getIntegrationRun(runScope(IDS.mainRun))).run.output, mainOutput);
    assert.equal((await reopened.getIntegrationThread(threadScope(IDS.mainThread))).thread.nativeSessionId, "aginti:durable-main");
    const replayedThread = await reopened.createIntegrationThread(mainThreadPayload);
    assert.equal(replayedThread.thread.revision, 1);
    const replayedFinish = await reopened.finishIntegrationRunWithOutbox(finishMainPayload);
    assert.equal(replayedFinish.resultDigest, finishMainPayload.resultDigest);
    assert.deepEqual(replayedFinish.outboxEvents.map((record) => record.outboxId), finishedMain.outboxEvents.map((record) => record.outboxId));
    const replayedStage = await reopened.stageIntegrationArtifactOutbox(stagePayload);
    assert.equal(replayedStage.artifact.published, false);
    assert.equal((await fixture.repositoryState.loadDomainSnapshot()).snapshotRevision, generationBeforeRestart);
    const authorizeReplay = await reopened.authorizeIntegrationRunNativeStart({ authorization: mainAuthorization });
    assert.equal(authorizeReplay.outcome, "already-authorized");
    assert.deepEqual(authorizeReplay.run, authorizedMain.run);
    assert.deepEqual(authorizeReplay.thread, authorizedMain.thread);

    const publishedAt = timestamp(6);
    const publishPayload = Object.freeze({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: IDS.mainThread,
      runId: IDS.mainRun,
      artifactId: staged.artifact.id,
      expectedRevision: 1,
      publishedAt,
    });
    const published = await reopened.publishIntegrationArtifactOutbox(publishPayload);
    assert.equal(published.artifact.published, true);
    assert.equal((await reopened.publishIntegrationArtifactOutbox(publishPayload)).artifact.revision, 2);
    assert.equal((await reopened.listIntegrationArtifacts({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: IDS.mainThread,
      runId: "",
      publishedOnly: true,
    })).artifacts.length, 1);
    assert.equal((await reopened.getIntegrationArtifact({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      artifactId: staged.artifact.id,
      publishedOnly: true,
    })).artifact.id, staged.artifact.id);

    const cancelledFlow = await createDispatched(reopened, {
      threadId: IDS.cancelThread,
      runId: IDS.cancelRun,
      nativeSessionId: "aginti:durable-cancel",
      createdAt: timestamp(10),
      dispatchedAt: timestamp(11),
    });
    const cancelledAuthorization = authorizationFor({
      run: cancelledFlow.dispatched,
      thread: cancelledFlow.createdThread,
      targetRuntimeRevision: 1,
    });
    const cancelAuthorized = await reopened.authorizeIntegrationRunNativeStart({ authorization: cancelledAuthorization });
    const cancelPayload = Object.freeze({
      runId: IDS.cancelRun,
      threadId: IDS.cancelThread,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: cancelAuthorized.run.revision,
      processOwner: owner("1", 1),
      cancelRequestedAt: timestamp(12),
    });
    await expectCode(
      () => reopened.markIntegrationRunCancelling({
        ...cancelPayload,
        processOwner: owner("2", 12),
      }),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    const cancelling = await reopened.markIntegrationRunCancelling(cancelPayload);
    assert.equal(cancelling.run.cancelRequestedAt, timestamp(12));
    assert.deepEqual(await reopened.markIntegrationRunCancelling(cancelPayload), cancelling);
    const cancelledFinishPayload = Object.freeze({
      runId: IDS.cancelRun,
      threadId: IDS.cancelThread,
      nativeSessionId: cancelledFlow.dispatched.nativeSessionId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: cancelling.run.revision,
      expectedNativeRuntimeRevision: 1,
      completedNativeRuntimeRevision: 1,
      status: "cancelled",
      output: "",
      error: Object.freeze({ code: "CANCELLED", message: "Run cancelled." }),
      completedAt: timestamp(13),
      processOwner: owner("1", 1),
      expectedCursor: Object.freeze({ firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 }),
      outputEvent: null,
      terminalEvent: Object.freeze({ type: "run.cancelled", payload: Object.freeze({}), createdAt: timestamp(13) }),
      resultDigest: contractDigest({ status: "cancelled" }),
    });
    await expectCode(
      () => reopened.finishIntegrationRunWithOutbox({
        ...cancelledFinishPayload,
        status: "failed",
        error: Object.freeze({ code: "AGINTI_RUNTIME_ERROR", message: "Cancellation cannot become failure." }),
        terminalEvent: Object.freeze({ type: "run.failed", payload: Object.freeze({}), createdAt: timestamp(13) }),
      }),
      "REVISION_CONFLICT"
    );
    const cancelledFinish = await reopened.finishIntegrationRunWithOutbox(cancelledFinishPayload);
    assert.equal(cancelledFinish.run.status, "cancelled");
    const repeatedArtifact = await reopened.stageIntegrationArtifactOutbox(Object.freeze({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: IDS.cancelThread,
      runId: IDS.cancelRun,
      artifact: artifactInput,
      stagedAt: timestamp(14),
    }));
    assert.notEqual(repeatedArtifact.artifact.id, staged.artifact.id);
    await reopened.deleteIntegrationThread(Object.freeze({
      threadId: IDS.cancelThread,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: cancelledFinish.thread.revision,
      deletedAt: timestamp(15),
    }));
    await expectCode(
      () => reopened.publishIntegrationArtifactOutbox(Object.freeze({
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
        threadId: IDS.cancelThread,
        runId: IDS.cancelRun,
        artifactId: repeatedArtifact.artifact.id,
        expectedRevision: 1,
        publishedAt: timestamp(15),
      })),
      "ARTIFACT_CONFLICT"
    );

    const abortOriginal = (await reopened.createIntegrationThread(
      createThreadPayload(IDS.abortThread, "aginti:durable-abort", timestamp(20))
    )).thread;
    const abortCreated = await reopened.createIntegrationRun(createRunPayload({
      runId: IDS.abortRun,
      thread: abortOriginal,
      createdAt: timestamp(21),
    }));
    const abortAttempt = abortAttemptFor({ originalThread: abortOriginal, run: abortCreated.run, abortAt: timestamp(22) });
    const aborted = await reopened.abortIntegrationRunBeforeLaunch({ attempt: abortAttempt });
    assert.equal(aborted.action, "aborted");
    const advancedAbortThread = (await reopened.updateIntegrationThread({
      threadId: IDS.abortThread,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: aborted.thread.revision,
      title: "Advanced after abort",
      updatedAt: timestamp(23),
    })).thread;
    const abortReplay = await reopened.abortIntegrationRunBeforeLaunch({ attempt: abortAttempt });
    assert.equal(abortReplay.action, "already-aborted");
    assert.deepEqual(abortReplay.run, aborted.run);
    assert.deepEqual(abortReplay.thread, aborted.thread);
    assert.equal((await reopened.getIntegrationRun(runScope(IDS.abortRun))).run, null);
    assert.deepEqual((await reopened.getIntegrationThread(threadScope(IDS.abortThread))).thread, advancedAbortThread);

    const beforeReadOnlyReconciliation = await fixture.repositoryState.loadDomainSnapshot();
    const snapshotPath = path.join(rootPath, "data:repository", INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE);
    const snapshotBytesBeforeReadOnlyReconciliation = (await fs.stat(snapshotPath)).size;
    for (let index = 0; index < 20; index += 1) {
      const response = await reopened.reconcileIntegrationDispatches(
        reconciliationRequest(owner("1", 1), timestamp(24 + index))
      );
      assert.deepEqual(response.receiptRunResults, []);
    }
    const afterReadOnlyReconciliation = await fixture.repositoryState.loadDomainSnapshot();
    assert.equal(afterReadOnlyReconciliation.snapshotRevision, beforeReadOnlyReconciliation.snapshotRevision);
    assert.equal(afterReadOnlyReconciliation.integrityDigest, beforeReadOnlyReconciliation.integrityDigest);
    assert.equal(
      afterReadOnlyReconciliation.state.mutationReceipts.length,
      beforeReadOnlyReconciliation.state.mutationReceipts.length
    );
    assert.equal((await fs.stat(snapshotPath)).size, snapshotBytesBeforeReadOnlyReconciliation);

    const preauth = await createDispatched(reopened, {
      threadId: IDS.preauthThread,
      runId: IDS.preauthRun,
      nativeSessionId: "aginti:startup-preauth",
      createdAt: timestamp(30),
      dispatchedAt: timestamp(31),
    });
    const held = await createDispatched(reopened, {
      threadId: IDS.heldThread,
      runId: IDS.heldRun,
      nativeSessionId: "aginti:startup-held",
      createdAt: timestamp(32),
      dispatchedAt: timestamp(33),
    });
    const heldAuthorization = authorizationFor({ run: held.dispatched, thread: held.createdThread, targetRuntimeRevision: 1 });
    await reopened.authorizeIntegrationRunNativeStart({ authorization: heldAuthorization });
    await fixture.authority.close();
    fixture = await openFixture(rootPath, now);
    const afterRestart = fixture.repository;
    await activateRepository(afterRestart);
    const staleReconcile = reconciliationRequest(owner("1", 1), timestamp(29));
    const beforeStaleReconcile = (await fixture.repositoryState.loadDomainSnapshot()).snapshotRevision;
    const staleResponse = await afterRestart.reconcileIntegrationDispatches(staleReconcile);
    assert.deepEqual(staleResponse.receiptRunResults, []);
    assert.equal((await afterRestart.getIntegrationRun(runScope(IDS.preauthRun))).run.status, "running");
    assert.equal((await afterRestart.getIntegrationRun(runScope(IDS.heldRun))).run.recoveryState, null);
    assert.equal((await fixture.repositoryState.loadDomainSnapshot()).snapshotRevision, beforeStaleReconcile);
    assert.deepEqual(await afterRestart.reconcileIntegrationDispatches(staleReconcile), staleResponse);
    assert.equal((await fixture.repositoryState.loadDomainSnapshot()).snapshotRevision, beforeStaleReconcile);
    const overlapClaim = Object.freeze({
      runId: IDS.heldRun,
      threadId: IDS.heldThread,
      nativeSessionId: held.dispatched.nativeSessionId,
      claimedAt: timestamp(39),
    });
    const reconcile = reconciliationRequest(owner("9", 40), timestamp(40), []);
    const reconciled = await afterRestart.reconcileIntegrationDispatches(reconcile);
    assert.equal(reconciled.receiptRunResults.length, 1);
    assert.equal(reconciled.receiptRunResults[0].run.id, IDS.heldRun);
    assert.equal(reconciled.receiptRunResults[0].action, "held");
    assert.equal((await afterRestart.getIntegrationRun(runScope(IDS.preauthRun))).run, null);
    assert.equal((await afterRestart.getIntegrationThread(threadScope(IDS.preauthThread))).thread.status, "idle");
    assert.equal((await afterRestart.getIntegrationRun(runScope(IDS.heldRun))).run.recoveryState.status, "recovery_hold");
    const reconcileRevision = (await fixture.repositoryState.loadDomainSnapshot()).snapshotRevision;
    assert.deepEqual(await afterRestart.reconcileIntegrationDispatches(reconcile), reconciled);
    assert.equal((await fixture.repositoryState.loadDomainSnapshot()).snapshotRevision, reconcileRevision);
    const laterReconcileRequest = reconciliationRequest(owner("9", 40), timestamp(41));
    const beforeNoChangeReconcile = (await fixture.repositoryState.loadDomainSnapshot()).snapshotRevision;
    const laterReconcile = await afterRestart.reconcileIntegrationDispatches(laterReconcileRequest);
    assert.equal(laterReconcile.receiptRunResults[0].action, "already-held");
    const afterNoChangeReconcile = (await fixture.repositoryState.loadDomainSnapshot()).snapshotRevision;
    assert.equal(afterNoChangeReconcile, beforeNoChangeReconcile);
    assert.deepEqual(await afterRestart.reconcileIntegrationDispatches(laterReconcileRequest), laterReconcile);
    assert.equal((await fixture.repositoryState.loadDomainSnapshot()).snapshotRevision, afterNoChangeReconcile);

    const heldRun = (await afterRestart.getIntegrationRun(runScope(IDS.heldRun))).run;
    const recoveredFinishPayload = Object.freeze({
      runId: IDS.heldRun,
      threadId: IDS.heldThread,
      nativeSessionId: heldRun.nativeSessionId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: heldRun.revision,
      expectedNativeRuntimeRevision: 1,
      completedNativeRuntimeRevision: 1,
      status: "failed",
      output: "",
      error: Object.freeze({ code: "AGINTI_RUNTIME_ERROR", message: "Authorized run did not survive restart." }),
      completedAt: timestamp(42),
      processOwner: owner("9", 40),
      expectedCursor: Object.freeze({ firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 }),
      outputEvent: null,
      terminalEvent: Object.freeze({ type: "run.failed", payload: Object.freeze({}), createdAt: timestamp(42) }),
      resultDigest: contractDigest({ status: "failed", reason: "restart-recovery" }),
    });
    await expectCode(
      () => afterRestart.finishIntegrationRunWithOutbox({
        ...recoveredFinishPayload,
        processOwner: owner("8", 41),
      }),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => afterRestart.finishIntegrationRunWithOutbox(recoveredFinishPayload),
      "RECOVERY_HOLD"
    );
    assert.equal((await afterRestart.getIntegrationRun(runScope(IDS.heldRun))).run.recoveryState.status, "recovery_hold");

    const mainThreadForResume = (await afterRestart.getIntegrationThread(threadScope(IDS.mainThread))).thread;
    const resumeCreated = await afterRestart.createIntegrationRun(createRunPayload({
      runId: IDS.resumeHeldRun,
      thread: mainThreadForResume,
      previousRunId: IDS.mainRun,
      createdAt: timestamp(70),
      text: "Resume recovery evidence proof.",
    }));
    const resumeDispatched = (await afterRestart.markIntegrationRunDispatching(
      dispatchPayload(resumeCreated.run, timestamp(71), owner("9", 40))
    )).run;
    const resumeAuthorization = authorizationFor({
      mode: "resume",
      run: resumeDispatched,
      thread: resumeCreated.thread,
      previous: finishedMain.run,
      targetRuntimeRevision: 2,
    });
    await afterRestart.authorizeIntegrationRunNativeStart({ authorization: resumeAuthorization });
    const resumeReconciliation = await afterRestart.reconcileIntegrationDispatches(
      reconciliationRequest(owner("9", 40), timestamp(72))
    );
    const resumeHeld = resumeReconciliation.receiptRunResults.find(
      (item) => item.run.id === IDS.resumeHeldRun
    );
    assert.equal(resumeHeld.action, "held");
    await expectCode(
      () => afterRestart.finishIntegrationRunWithOutbox(Object.freeze({
        runId: IDS.resumeHeldRun,
        threadId: IDS.mainThread,
        nativeSessionId: resumeHeld.run.nativeSessionId,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
        expectedRevision: resumeHeld.run.revision,
        expectedNativeRuntimeRevision: 1,
        completedNativeRuntimeRevision: 2,
        status: "failed",
        output: "",
        error: Object.freeze({ code: "AGINTI_RUNTIME_ERROR", message: "Resume evidence is unavailable." }),
        completedAt: timestamp(73),
        processOwner: owner("9", 40),
        expectedCursor: Object.freeze({ firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 }),
        outputEvent: null,
        terminalEvent: Object.freeze({ type: "run.failed", payload: Object.freeze({}), createdAt: timestamp(73) }),
        resultDigest: contractDigest({ status: "failed", reason: "missing-resume-evidence" }),
      })),
      "RECOVERY_HOLD"
    );

    const otherFlow = await createDispatched(afterRestart, {
      threadId: IDS.otherThread,
      runId: IDS.otherRun,
      nativeSessionId: "aginti:other-owner-artifact",
      createdAt: timestamp(80),
      dispatchedAt: timestamp(81),
      principalId: OTHER_PRINCIPAL,
      browserSessionId: OTHER_BROWSER_SESSION,
      processOwner: owner("9", 40),
    });
    const otherAuthorization = authorizationFor({
      run: otherFlow.dispatched,
      thread: otherFlow.createdThread,
      targetRuntimeRevision: 1,
    });
    const otherAuthorized = await afterRestart.authorizeIntegrationRunNativeStart({
      authorization: otherAuthorization,
    });
    const otherFinished = await afterRestart.finishIntegrationRunWithOutbox(Object.freeze({
      runId: IDS.otherRun,
      threadId: IDS.otherThread,
      nativeSessionId: otherFlow.dispatched.nativeSessionId,
      principalId: OTHER_PRINCIPAL,
      browserSessionId: OTHER_BROWSER_SESSION,
      expectedRevision: otherAuthorized.run.revision,
      expectedNativeRuntimeRevision: 1,
      completedNativeRuntimeRevision: 1,
      status: "failed",
      output: "",
      error: Object.freeze({ code: "AGINTI_RUNTIME_ERROR", message: "Cross-owner artifact proof terminal." }),
      completedAt: timestamp(82),
      processOwner: otherFlow.dispatched.processOwner,
      expectedCursor: Object.freeze({ firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 }),
      outputEvent: null,
      terminalEvent: Object.freeze({ type: "run.failed", payload: Object.freeze({}), createdAt: timestamp(82) }),
      resultDigest: contractDigest({ status: "failed", scope: "other-owner" }),
    }));
    const otherArtifact = await afterRestart.stageIntegrationArtifactOutbox(Object.freeze({
      principalId: OTHER_PRINCIPAL,
      browserSessionId: OTHER_BROWSER_SESSION,
      threadId: IDS.otherThread,
      runId: IDS.otherRun,
      artifact: artifactInput,
      stagedAt: timestamp(83),
    }));
    assert.notEqual(otherArtifact.artifact.id, staged.artifact.id);
    assert.notEqual(otherArtifact.artifact.id, repeatedArtifact.artifact.id);
    await afterRestart.publishIntegrationArtifactOutbox(Object.freeze({
      principalId: OTHER_PRINCIPAL,
      browserSessionId: OTHER_BROWSER_SESSION,
      threadId: IDS.otherThread,
      runId: IDS.otherRun,
      artifactId: otherArtifact.artifact.id,
      expectedRevision: 1,
      publishedAt: timestamp(84),
    }));
    assert.equal((await afterRestart.getIntegrationArtifact({
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      artifactId: otherArtifact.artifact.id,
      publishedOnly: true,
    })).artifact, null);
    assert.equal((await afterRestart.getIntegrationArtifact({
      principalId: OTHER_PRINCIPAL,
      browserSessionId: OTHER_BROWSER_SESSION,
      artifactId: otherArtifact.artifact.id,
      publishedOnly: true,
    })).artifact.id, otherArtifact.artifact.id);
    await afterRestart.deleteIntegrationThread(Object.freeze({
      threadId: IDS.otherThread,
      principalId: OTHER_PRINCIPAL,
      browserSessionId: OTHER_BROWSER_SESSION,
      expectedRevision: otherFinished.thread.revision,
      deletedAt: timestamp(85),
    }));
    assert.equal((await afterRestart.getIntegrationArtifact({
      principalId: OTHER_PRINCIPAL,
      browserSessionId: OTHER_BROWSER_SESSION,
      artifactId: otherArtifact.artifact.id,
      publishedOnly: true,
    })).artifact, null);
    assert.deepEqual((await afterRestart.listIntegrationArtifacts({
      principalId: OTHER_PRINCIPAL,
      browserSessionId: OTHER_BROWSER_SESSION,
      threadId: "",
      runId: IDS.otherRun,
      publishedOnly: true,
    })).artifacts, []);

    const deletePayload = createThreadPayload(IDS.deletedThread, "aginti:delete-proof", timestamp(90));
    const deleteThread = (await afterRestart.createIntegrationThread(deletePayload)).thread;
    const updatedDelete = (await afterRestart.updateIntegrationThread({
      threadId: deleteThread.id,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: deleteThread.revision,
      title: "Delete proof renamed",
      updatedAt: timestamp(91),
    })).thread;
    const deleteMutation = Object.freeze({
      threadId: updatedDelete.id,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: updatedDelete.revision,
      deletedAt: timestamp(92),
    });
    const deleted = await afterRestart.deleteIntegrationThread(deleteMutation);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.thread.tombstone, true);
    assert.deepEqual(await afterRestart.deleteIntegrationThread(deleteMutation), deleted);
    assert.equal((await afterRestart.getIntegrationThread(threadScope(IDS.deletedThread))).thread, null);

    const finalSnapshot = await fixture.repositoryState.loadDomainSnapshot();
    assert(finalSnapshot.snapshotRevision > 20);
    assert.equal(finalSnapshot.state.threads.some((thread) => thread.nativeSessionId === "aginti:durable-main"), true);
    assert.equal(finalSnapshot.state.mutationReceipts.every((receipt) => receipt.resultDigest === contractDigest(receipt.result)), true);
    assert.equal(new Set(finalSnapshot.state.mutationReceipts.map((receipt) => receipt.mutationId)).size, finalSnapshot.state.mutationReceipts.length);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      methods: INTEGRATION_RUNTIME_REPOSITORY_METHODS.length,
      snapshotRevision: finalSnapshot.snapshotRevision,
      threads: finalSnapshot.state.threads.length,
      runs: finalSnapshot.state.runs.length,
      outboxEvents: finalSnapshot.state.outboxEvents.length,
      artifacts: finalSnapshot.state.artifacts.length,
      mutationReceipts: finalSnapshot.state.mutationReceipts.length,
      restartReplay: true,
      nativeStartReplayBlocked: true,
      startupPreauthorizationAbort: true,
      startupAuthorizedRecoveryHold: true,
      recoveryHoldTerminalResolutionRequiresRetainedEvidence: true,
      resumeRecoveryWithoutEvidenceBlocked: true,
      staleReconciliationIsolation: true,
      rollingRestartOverlapHeldFailClosed: true,
      ownerScopedArtifactIdentity: true,
      artifactOwnerTombstoneVisibilityFiltering: true,
    })}\n`);
  } finally {
    await fixture?.authority.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

await run();
