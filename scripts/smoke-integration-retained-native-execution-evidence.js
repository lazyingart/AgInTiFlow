#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  createRetainedIntegrationRuntimeRecoveryCoordinator,
  createRetainedIntegrationRuntimeRepositorySurface,
} from "../src/integration-retained-runtime-repository-surface.js";
import {
  buildFixedIntegrationPolicy,
  contractDigest,
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

function timestamp(offsetSeconds) {
  return new Date(BASE_MS + offsetSeconds * 1000).toISOString();
}

function owner(tokenDigit = "1", offsetSeconds = 0) {
  return Object.freeze({
    schemaVersion: "aginti-process-owner-v1",
    pid: 4242,
    token: tokenDigit.repeat(32),
    processIdentity: Object.freeze({
      schemaVersion: "aginti-process-identity-v1",
      bootId: "01234567-89ab-cdef-0123-456789abcdef",
      startTimeTicks: "123456",
    }),
    acquiredAt: timestamp(offsetSeconds),
    heartbeatAt: timestamp(offsetSeconds),
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
  const evidence = createRetainedIntegrationNativeExecutionEvidence({
    sessionStateStore,
    sessionStateStoreExpected: sessionBinding.expected,
  });
  const recovery = createRetainedIntegrationRuntimeRecoveryCoordinator({
    repository,
    nativeExecutionEvidence: evidence,
  });
  return Object.freeze({ authority, repository, repositoryState, sessionStateStore, evidence, recovery, expected });
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

async function authorizeRepositoryRun(fixture, dispatchOwner = owner("1", 2)) {
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
  let tick = 100;
  const now = () => new Date(BASE_MS + tick++ * 1000);
  try {
    fixture = await openFixture(rootPath, now);
    mismatchFixture = await openFixture(mismatchRootPath, now);
    await expectCode(
      () => createRetainedIntegrationRuntimeRecoveryCoordinator({
        repository: fixture.repository,
        nativeExecutionEvidence: mismatchFixture.evidence,
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
    await authorizeRepositoryRun(mismatchFixture, owner("3", 30));
    await mismatchFixture.authority.close();
    mismatchFixture = await openFixture(mismatchRootPath, now);
    await mismatchFixture.repository.reconcileIntegrationDispatches(
      reconciliationRequest(owner("4", 40), timestamp(40))
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
    fixture = await openFixture(rootPath, now);
    const recoveryOwner = owner("2", 20);
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

    const resumeOwner = owner("5", 61);
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
    const resumedFinish = await fixture.repository.finishIntegrationRunWithOutbox(Object.freeze({
      runId: RESUME_RUN_ID,
      threadId: THREAD_ID,
      nativeSessionId: NATIVE_SESSION_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: resumed.authorized.run.revision,
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
    }));
    assert.equal(resumedFinish.run.status, "completed");
    assert.equal(resumedFinish.run.authority.runtimeRevision, 2);
    const historicalReplay = await fixture.recovery.resolveRecoveryHeldRun(Object.freeze({
      runId: RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedCursor: publicFinish.expectedCursor,
    }));
    assert.equal(historicalReplay.outcome, "already-recovered");
    assert.equal(historicalReplay.run.id, RUN_ID);
    assert.equal(historicalReplay.run.authority.runtimeRevision, 1);
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
      immutableSnapshotHash: true,
      exactStorageBinding: true,
      authorizationProcessOwnerBound: true,
      missingTerminalEvidenceHeld: true,
      historicalRecoveryReplayAfterResume: true,
      fullSessionStoreRetained: false,
      runtimeCapabilityEnabled: false,
    }));
  } finally {
    await fixture?.authority.close().catch(() => {});
    await mismatchFixture?.authority.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    await fs.rm(mismatchRootPath, { recursive: true, force: true });
  }
}

await run();
