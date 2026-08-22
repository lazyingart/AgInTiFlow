#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRetainedIntegrationNativeExecutionEvidence,
} from "../src/integration-retained-native-execution-evidence.js";
import {
  createRetainedIntegrationTextWorkspace,
  INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
  INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES,
} from "../src/integration-retained-text-workspace.js";
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
  registerIntegrationSessionConfig,
  runWithIntegrationSessionScope,
} from "../src/integration-session-persistence.js";
import { SessionStore } from "../src/session-store.js";
import { runAgent } from "../src/agent-runner.js";

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
  const poisonTarget = path.join(rootPath, "legacy-session-root-poison");
  await fs.mkdir(poisonTarget, { recursive: true, mode: 0o700 });
  await fs.chmod(poisonTarget, 0o000);
  await fs.symlink(poisonTarget, path.join(sessionPath, NATIVE_SESSION_ID)).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
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
  const textWorkspace = createRetainedIntegrationTextWorkspace({
    sessionStateStore,
    sessionStateStoreExpected: sessionBinding.expected,
    nativeExecutionEvidence: evidence,
  });
  const recovery = createRetainedIntegrationRuntimeRecoveryCoordinator({
    repository,
    nativeExecutionEvidence: evidence,
  });
  const openDistinctSessionStore = async () => {
    const distinctBinding = await binding(
      sessionSegments,
      INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
      sessionLockPath,
      "maxStateBytes",
      512 * 1024
    );
    return createRetainedIntegrationSessionStateStore(
      distinctBinding.files,
      distinctBinding.lock,
      distinctBinding.expected
    );
  };
  return Object.freeze({
    authority,
    repository,
    repositoryState,
    sessionStateStore,
    evidence,
    textWorkspace,
    recovery,
    expected,
    openDistinctSessionStore,
  });
}

function installLegacySessionRootGuard(legacyRoot) {
  const names = [
    "access", "appendFile", "chmod", "chown", "copyFile", "cp", "link", "lstat", "mkdir", "mkdtemp",
    "open", "opendir", "readFile", "readdir", "readlink", "realpath", "rename", "rm", "stat",
    "symlink", "truncate", "unlink", "utimes", "writeFile",
  ];
  const originals = new Map();
  const hits = [];
  const matches = (value) => {
    let candidate = value;
    if (value instanceof URL && value.protocol === "file:") candidate = fileURLToPath(value);
    if (Buffer.isBuffer(candidate)) candidate = candidate.toString("utf8");
    if (typeof candidate !== "string") return false;
    const resolved = path.resolve(candidate);
    return resolved === legacyRoot || resolved.startsWith(`${legacyRoot}${path.sep}`);
  };
  for (const name of names) {
    if (typeof fs[name] !== "function") continue;
    const original = fs[name];
    originals.set(name, original);
    fs[name] = async (...args) => {
      if (args.some(matches)) {
        hits.push(Object.freeze({ name, path: String(args.find(matches)) }));
        const error = new Error(`Forbidden legacy SessionStore root access: ${name}`);
        error.code = "EACCES";
        throw error;
      }
      return original(...args);
    };
  }
  return Object.freeze({
    hits,
    restore() {
      for (const [name, original] of originals) fs[name] = original;
    },
  });
}

function deterministicRunAgentConfig(baseConfig, registration) {
  let toolTurn = 0;
  const promptAudit = {
    payloads: 0,
    planPayloads: 0,
    executionPayloads: 0,
  };
  const clientFactory = async () => ({
    chat: {
      completions: {
        async create(payload) {
          const promptText = JSON.stringify(payload.messages || []);
          assert.doesNotMatch(
            promptText,
            /common host data roots|home parent|supports broader setup and network commands|read-only at (?:their )?original absolute paths|Absolute host paths are acceptable/iu,
            "retained text-workspace prompt advertised unavailable host mounts or network setup"
          );
          assert.match(
            promptText,
            /(?:No shell command tool is available|Shell execution(?: and package installation)? (?:is|are) (?:unavailable|disabled))/iu,
            "retained text-workspace prompt did not disclose that shell execution is disabled"
          );
          promptAudit.payloads += 1;
          if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
            promptAudit.planPayloads += 1;
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: "1. Inspect the workspace.\n2. Verify retained evidence.\n3. Finish concisely.",
                },
              }],
            };
          }
          promptAudit.executionPayloads += 1;
          assert(
            !payload.tools.some((tool) => tool.function?.name === "run_command"),
            "real retained text-workspace execution offered run_command"
          );
          toolTurn += 1;
          const offered = new Set(payload.tools.map((tool) => tool.function?.name));
          const name = toolTurn === 1 && offered.has("inspect_project") ? "inspect_project" : "finish";
          return {
            choices: [{
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: `retained-text-workspace-${toolTurn}`,
                  type: "function",
                  function: {
                    name,
                    arguments: name === "finish"
                      ? JSON.stringify({ result: "Retained text-workspace execution completed with verified workspace evidence." })
                      : "{}",
                  },
                }],
              },
            }],
          };
        },
      },
    },
  });
  clientFactory.agintiDeterministicTest = true;
  clientFactory.promptAudit = promptAudit;
  const config = Object.freeze({
    ...baseConfig,
    clientFactory,
    providerReadinessMode: "deterministic-test",
    allowLocalAutoMax: false,
    localResourceProbe: async () => Object.freeze({
      ready: false,
      status: "unknown",
      sharedWorkstationPressure: null,
    }),
    executionPolicy: Object.freeze({
      tier: "thorough",
      requiresPlan: true,
      reason: "Deterministic retained-profile E2E coverage.",
    }),
  });
  const expectedBeforeRevision = registration.mode === "resume" ? registration.expectedRuntimeRevision : 0;
  const expectedAfterRevision = registration.mode === "resume" ? registration.expectedRuntimeRevision + 1 : 1;
  return registerIntegrationSessionConfig(config, {
    nativeSessionId: NATIVE_SESSION_ID,
    mode: registration.mode,
    policyLock: config.integrationPolicyLock,
    policyFingerprint: config.integrationPolicyFingerprint,
    runtimeRootsDigest: config.integrationRuntimeRootsDigest,
    sessionsDir: config.sessionsDir,
    baseDir: config.baseDir,
    commandCwd: config.commandCwd,
    expectedBeforeRevision,
    expectedAfterRevision,
    expectedBeforeRuntimeDigest: registration.mode === "resume"
      ? contractDigest(expectedFixedSessionRuntimeSnapshot(config, expectedBeforeRevision))
      : ZERO_DIGEST,
    expectedAfterRuntimeDigest: contractDigest(expectedFixedSessionRuntimeSnapshot(config, expectedAfterRevision)),
    retainedNativeExecutionEvidence: registration.evidence,
    retainedTextWorkspace: registration.textWorkspace,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    threadId: THREAD_ID,
    runId: registration.runId,
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
    const distinctSameDescriptorStore = await fixture.openDistinctSessionStore();
    await expectCode(
      () => createRetainedIntegrationTextWorkspace({
        sessionStateStore: distinctSameDescriptorStore,
        sessionStateStoreExpected: fixture.expected.sessionStateStore,
        nativeExecutionEvidence: fixture.evidence,
      }),
      "INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE"
    );
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
    assert.equal(fixture.textWorkspace.attestation.profile, INTEGRATION_TEXT_WORKSPACE_PROFILE_ID);
    assert.equal(fixture.textWorkspace.attestation.legacySessionRootAccess, false);
    assert.equal(fixture.textWorkspace.attestation.reachableOperationsRetained, true);
    assert.equal(fixture.textWorkspace.attestation.fullSessionStoreRetained, false);
    assert.equal(fixture.textWorkspace.attestation.shellExecution, false);
    assert.deepEqual(
      [...fixture.textWorkspace.attestation.enabledToolNames],
      [...INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES]
    );
    const sessionStoreMethods = Object.getOwnPropertyNames(SessionStore.prototype)
      .filter((name) => !["constructor", "withIntegrationOperation", "assertIntegrationOperation"].includes(name))
      .sort();
    assert.deepEqual(
      Object.keys(fixture.textWorkspace.attestation.operationDispositions).sort(),
      sessionStoreMethods
    );
    let accessorTrapCount = 0;
    const accessorFactoryPayload = {};
    Object.defineProperty(accessorFactoryPayload, "sessionStateStore", {
      enumerable: true,
      get() {
        accessorTrapCount += 1;
        return fixture.sessionStateStore;
      },
    });
    Object.defineProperty(accessorFactoryPayload, "sessionStateStoreExpected", {
      enumerable: true,
      value: fixture.expected.sessionStateStore,
    });
    Object.defineProperty(accessorFactoryPayload, "nativeExecutionEvidence", {
      enumerable: true,
      value: fixture.evidence,
    });
    await expectCode(
      () => createRetainedIntegrationTextWorkspace(accessorFactoryPayload),
      "INTEGRATION_TEXT_WORKSPACE_INVALID"
    );
    assert.equal(accessorTrapCount, 0);
    const revokedScope = Proxy.revocable({}, {});
    revokedScope.revoke();
    await expectCode(
      () => fixture.textWorkspace.prepareExecution(revokedScope.proxy),
      "INTEGRATION_TEXT_WORKSPACE_INVALID"
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
    const baseConfig = buildFixedNativeRunAgentConfig({
      mode: "start",
      policy: buildFixedIntegrationPolicy(),
      nativeSessionId: NATIVE_SESSION_ID,
      inputText: "Inspect this JavaScript workspace and produce a concise verified maintenance report without modifying files.",
      abortSignal: new AbortController().signal,
      onEvent() {},
      repositoryRoots: roots,
      expectedRuntimeRevision: 1,
      retainedNativeExecutionEvidence: fixture.evidence,
      retainedTextWorkspace: fixture.textWorkspace,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: THREAD_ID,
      runId: RUN_ID,
    });
    const config = deterministicRunAgentConfig(baseConfig, {
      mode: "start",
      expectedRuntimeRevision: 1,
      evidence: fixture.evidence,
      textWorkspace: fixture.textWorkspace,
      runId: RUN_ID,
    });
    assert.equal(config.integrationSessionProfile, INTEGRATION_TEXT_WORKSPACE_PROFILE_ID);
    assert.equal(config.allowShellTool, false);
    assert.equal(config.allowImagePerception, false);
    const legacySessionRoot = path.join(roots.sessionsDir, NATIVE_SESSION_ID);
    const legacyGuard = installLegacySessionRootGuard(legacySessionRoot);
    let preflight;
    let postflight;
    let nativeResult;
    try {
      preflight = await preflightNativeSessionRuntime(config);
      assert.equal(preflight.retained, true);
      assert.equal(preflight.expectedAfterRevision, 1);
      await bindRetainedNativeExecution(config, {
        authorization: authorized.receipt,
        snapshotHash: authorized.run.authority.snapshotHash,
      });
      nativeResult = await runWithIntegrationSessionScope(config, () => runAgent(config));
      postflight = await postflightNativeSessionRuntime(config, preflight);
    } finally {
      legacyGuard.restore();
    }
    assert.deepEqual(legacyGuard.hits, []);
    assert.equal((await fs.lstat(legacySessionRoot)).isSymbolicLink(), true);
    assert.match(nativeResult.result, /Retained text-workspace execution completed/u);
    assert(config.clientFactory.promptAudit.planPayloads >= 1);
    assert(config.clientFactory.promptAudit.executionPayloads >= 2);
    assert.equal(postflight.revision, 1);
    const terminal = Object.freeze({
      status: "completed",
      output: nativeResult.result,
      error: null,
      resultDigest: contractDigest({ status: "completed", output: nativeResult.result }),
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
    const resumeBaseConfig = buildFixedNativeRunAgentConfig({
      mode: "resume",
      policy: buildFixedIntegrationPolicy(),
      nativeSessionId: NATIVE_SESSION_ID,
      inputText: "Advance the retained native execution.",
      abortSignal: new AbortController().signal,
      onEvent() {},
      repositoryRoots: roots,
      expectedRuntimeRevision: 1,
      retainedNativeExecutionEvidence: fixture.evidence,
      retainedTextWorkspace: fixture.textWorkspace,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: THREAD_ID,
      runId: RESUME_RUN_ID,
    });
    const resumeConfig = deterministicRunAgentConfig(resumeBaseConfig, {
      mode: "resume",
      expectedRuntimeRevision: 1,
      evidence: fixture.evidence,
      textWorkspace: fixture.textWorkspace,
      runId: RESUME_RUN_ID,
    });
    const resumeLegacyGuard = installLegacySessionRootGuard(legacySessionRoot);
    let resumePreflight;
    let resumePostflight;
    let resumedNativeResult;
    try {
      resumePreflight = await preflightNativeSessionRuntime(resumeConfig);
      assert.equal(resumePreflight.beforeRevision, 1);
      assert.equal(resumePreflight.expectedAfterRevision, 2);
      await bindRetainedNativeExecution(resumeConfig, {
        authorization: resumed.authorized.receipt,
        snapshotHash: resumed.authorized.run.authority.snapshotHash,
      });
      resumedNativeResult = await runWithIntegrationSessionScope(resumeConfig, () => runAgent(resumeConfig));
      resumePostflight = await postflightNativeSessionRuntime(resumeConfig, resumePreflight);
    } finally {
      resumeLegacyGuard.restore();
    }
    assert.deepEqual(resumeLegacyGuard.hits, []);
    assert(resumeConfig.clientFactory.promptAudit.executionPayloads >= 2);
    assert.equal(resumePostflight.revision, 2);
    const resumedTerminal = Object.freeze({
      status: "completed",
      output: resumedNativeResult.result,
      error: null,
      resultDigest: contractDigest({
        status: "completed",
        output: resumedNativeResult.result,
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
      textWorkspaceProfile: true,
      retainedHashChainedEventJournal: true,
      eventReplayAcrossResume: true,
      legacySessionRootAccess: false,
      imagePerception: false,
      shellExecution: false,
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
