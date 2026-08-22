#!/usr/bin/env node
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRetainedIntegrationNativeExecutionEvidence,
} from "../src/integration-retained-native-execution-evidence.js";
import {
  assertRetainedIntegrationTextWorkspaceCurrent,
  createRetainedIntegrationTextWorkspace,
  INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
  INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES,
} from "../src/integration-retained-text-workspace.js";
import {
  createRetainedIntegrationNativeSessionRepositoryState,
} from "../src/integration-retained-native-session-repository-state.js";
import {
  INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
  bindRetainedIntegrationSessionStateStoreWriteFence,
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
  createRetainedIntegrationRuntimeNativeWriteFence,
  createRetainedIntegrationRuntimeRecoveryCoordinator,
  createRetainedIntegrationRuntimeRepositorySurface,
  handoffRetainedIntegrationRuntimeRepositoryFence,
  retainedIntegrationRuntimeNativeWriteFenceActivityProof,
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

function runtimeAuthorityForFixture(fixture, overrides = {}) {
  return createAgintiIntegrationRuntimeAuthority({
    threadSessionRepository: fixture.repository,
    eventLedgerStore: runtimeEventLedgerStore(),
    cancellationAttestation: runtimeCancellationAttestation(),
    hardenedSandboxAttestation: runtimeSandboxAttestation(),
    processOwnerBootstrap: fixture.processOwnerBootstrap,
    repositoryFenceLease: fixture.acquiredFence.lease,
    nativeWriteFence: fixture.nativeWriteFence,
    retainedNativeExecutionEvidence: fixture.evidence,
    retainedRecoveryCoordinator: fixture.recovery,
    retainedTextWorkspace: fixture.textWorkspace,
    ...overrides,
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

async function openFixture(rootPath, now, processOwnerBootstrap, options = {}) {
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
  const acquiredFence = await acquireRetainedIntegrationRuntimeRepositoryFence(repository, {
    processOwnerBootstrap,
  });
  if (options.probeFakeWriteFence === true) {
    const fakeFence = deepFreeze({
      schemaVersion: "aginti-retained-runtime-native-write-fence-v1",
      fenceIdentity: Object.freeze({ passthrough: true }),
      seal: Object.freeze({ passthrough: true }),
      admit: (operation) => operation(),
      attestation: Object.freeze({
        sessionStateNamespaceDigest: sessionStateStore.attestation.logicalNamespaceDigest,
        sessionStateAdmissionBindingDigest: sessionStateStore.attestation.admissionBindingDigest,
      }),
    });
    await expectCode(
      () => bindRetainedIntegrationSessionStateStoreWriteFence(
        sessionStateStore,
        sessionBinding.expected,
        fakeFence
      ),
      "INTEGRATION_SESSION_STATE_STORE_WRITE_FENCE_INVALID"
    );
  }
  const nativeWriteFence = options.skipNativeWriteFence === true
    ? null
    : await createRetainedIntegrationRuntimeNativeWriteFence(repository, {
        processOwnerBootstrap,
        repositoryFenceLease: acquiredFence.lease,
      });
  const evidence = nativeWriteFence
    ? createRetainedIntegrationNativeExecutionEvidence({
        sessionStateStore,
        sessionStateStoreExpected: sessionBinding.expected,
        nativeWriteFence,
      })
    : null;
  const recovery = nativeWriteFence
    ? createRetainedIntegrationRuntimeRecoveryCoordinator({
        repository,
        nativeExecutionEvidence: evidence,
        processOwnerBootstrap,
        repositoryFenceLease: acquiredFence.lease,
        nativeWriteFence,
      })
    : null;
  const textWorkspace = nativeWriteFence
    ? await createRetainedIntegrationTextWorkspace({
        sessionStateStore,
        sessionStateStoreExpected: sessionBinding.expected,
        nativeExecutionEvidence: evidence,
        nativeWriteFence,
        repository,
        recoveryCoordinator: recovery,
        processOwnerBootstrap,
        repositoryFenceLease: acquiredFence.lease,
      })
    : null;
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
    processOwnerBootstrap,
    processOwner: processOwnerBootstrap.processOwner,
    acquiredFence,
    nativeWriteFence,
    sessionBinding,
    openDistinctSessionStore,
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
  return Object.freeze({
    repository,
    repositoryState: fixture.repositoryState,
    processOwnerBootstrap: fixture.processOwnerBootstrap,
    processOwner: fixture.processOwner,
    acquiredFence,
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

function fillerThreadId(index) {
  return `thr_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function fillerNativeSessionId(index) {
  return `aginti:00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function fillerRunId(index) {
  return `run_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
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

function spawnSessionLockBarrier(lockPath) {
  const child = spawn(
    HELPER_PATH,
    ["-x", lockPath, "/bin/bash", "-c", "echo locked; IFS= read -r _"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const locked = new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("locked")) resolve();
    });
    child.once("exit", (code, signal) => {
      if (!output.includes("locked")) {
        reject(new Error(`session lock barrier exited ${code}/${signal}: ${stderr}`));
      }
    });
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    resolve({ code, signal, stderr });
  }));
  return Object.freeze({
    child,
    locked,
    exited,
    release() {
      child.stdin.end("release\n");
    },
    terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  });
}

async function waitForFenceActivity(nativeWriteFence, predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const proof = retainedIntegrationRuntimeNativeWriteFenceActivityProof(nativeWriteFence);
    if (predicate(proof)) return proof;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for native-write fence ${label}.`);
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
    const textWorkspaceProof = await fixture.textWorkspace.attestCurrent();
    const recovered = await fixture.recovery.resolveRecoveryHeldRun(message.payload);
    const replay = await fixture.recovery.resolveRecoveryHeldRun(message.payload);
    const resumedNativeSessionId = fillerNativeSessionId(9001);
    const predecessorNativeSnapshot = await fixture.sessionStateStore.loadSessionSnapshot(
      resumedNativeSessionId
    );
    const successorNativeWrite = await fixture.sessionStateStore.compareAndSwapSessionSnapshot(
      Object.freeze({
        mutationId: "native-write-fence.successor-resume-after-handoff",
        nativeSessionId: resumedNativeSessionId,
        expectedPersistenceRevision: predecessorNativeSnapshot.persistenceRevision,
        expectedIntegrityDigest: predecessorNativeSnapshot.integrityDigest,
        state: Object.freeze({
          sessionId: resumedNativeSessionId,
          meta: Object.freeze({ runtimeConfig: Object.freeze({ revision: 2 }) }),
        }),
      })
    );
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
        nativeWriteFence: runtimeProof.nativeWriteFence,
        textWorkspace: {
          profile: fixture.textWorkspace.attestation.profile,
          attestationDigest: fixture.textWorkspace.attestation.digest,
          currentProofDigest: textWorkspaceProof.digest,
          nativeWriteFenceAttestationDigest:
            textWorkspaceProof.nativeWriteFenceAttestationDigest,
          durablyCurrent: textWorkspaceProof.durablyCurrent,
          nativeSessionStateWriterFencing:
            textWorkspaceProof.nativeSessionStateWriterFencing,
          nativeSessionStateWriterQuiescenceProven:
            textWorkspaceProof.nativeSessionStateWriterQuiescenceProven,
          fullSessionStoreSidecarsFenced:
            textWorkspaceProof.fullSessionStoreSidecarsFenced,
          imagePerceptionSidecarsFenced:
            textWorkspaceProof.imagePerceptionSidecarsFenced,
          runtimeProofDigest: runtimeProof.retainedTextWorkspaceCurrentProofDigest,
          runtimeNativeWriterFencing:
            runtimeProof.retainedTextWorkspaceNativeWriterFencing,
          runtimeNativeWriterQuiescence:
            runtimeProof.retainedTextWorkspaceNativeWriterQuiescence,
        },
        successorNativeWrite: {
          outcome: successorNativeWrite.outcome,
          persistenceRevision: successorNativeWrite.snapshot.persistenceRevision,
          runtimeRevision: successorNativeWrite.snapshot.runtimeRevision,
        },
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

async function authorizeStaleTextProfileProbe(fixture, dispatchOwner) {
  const identity = 9_902;
  const threadId = fillerThreadId(identity);
  const runId = fillerRunId(identity);
  const nativeSessionId = fillerNativeSessionId(identity);
  const createdAt = timestamp(75);
  const thread = (await fixture.repository.createIntegrationThread(Object.freeze({
    threadId,
    nativeSessionId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    title: "Stale text-profile fence probe",
    createdAt,
    policyFingerprint: POLICY_FINGERPRINT,
  }))).thread;
  const created = await fixture.repository.createIntegrationRun(Object.freeze({
    runId,
    threadId,
    nativeSessionId,
    previousRunId: null,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    expectedThreadRevision: thread.revision,
    expectedNativeRuntimeRevision: 1,
    input: Object.freeze({ text: "Hold one exact stale profile write proof." }),
    createdAt,
    status: "starting",
  }));
  const dispatchedAt = timestamp(76);
  const dispatched = (await fixture.repository.markIntegrationRunDispatching(Object.freeze({
    runId,
    threadId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: created.run.revision,
    expectedNativeRuntimeRevision: 1,
    dispatchLeaseId: contractDigest({ runId, nativeSessionId, createdAt }),
    dispatchOutbox: true,
    processOwner: dispatchOwner,
    dispatchedAt,
  }))).run;
  const authorization = authorizationFor(dispatched, created.thread);
  const authorized = await fixture.repository.authorizeIntegrationRunNativeStart({ authorization });
  return Object.freeze({ threadId, runId, nativeSessionId, authorized });
}

async function run() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-native-evidence-"));
  const mismatchRootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-native-evidence-mismatch-")
  );
  const spliceRootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-native-evidence-splice-")
  );
  let fixture = null;
  let mismatchFixture = null;
  let spliceFixture = null;
  let spliceReplacementFixture = null;
  let staleRuntimeFixture = null;
  let successor = null;
  let sessionLockBarrier = null;
  let tick = 100;
  const now = () => new Date(BASE_MS + tick++ * 1000);
  const processOwnerBootstrap = await createIntegrationRuntimeProcessOwnerBootstrap();
  try {
    fixture = await openFixture(rootPath, now, processOwnerBootstrap, {
      probeFakeWriteFence: true,
    });
    mismatchFixture = await openFixture(mismatchRootPath, now, processOwnerBootstrap);
    spliceFixture = await openFixture(spliceRootPath, now, processOwnerBootstrap);
    await spliceFixture.authority.close();
    spliceFixture = null;
    const replacedRepositoryPath = path.join(spliceRootPath, "data:repository");
    await fs.rename(
      replacedRepositoryPath,
      path.join(spliceRootPath, "data:repository.replaced")
    );
    await ensureOwnerDirectory(replacedRepositoryPath);
    await ensureLockFile(path.join(
      replacedRepositoryPath,
      INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE
    ));
    spliceReplacementFixture = await openFixture(
      spliceRootPath,
      now,
      processOwnerBootstrap,
      { skipNativeWriteFence: true }
    );
    await expectCode(
      () => createRetainedIntegrationRuntimeNativeWriteFence(
        spliceReplacementFixture.repository,
        {
          processOwnerBootstrap,
          repositoryFenceLease: spliceReplacementFixture.acquiredFence.lease,
        }
      ),
      "INTEGRATION_SESSION_STATE_STORE_WRITE_FENCE_INVALID"
    );
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
    const rawProbeSessionId = fillerNativeSessionId(9001);
    await expectCode(
      () => sameDescriptorStore.compareAndSwapSessionSnapshot(Object.freeze({
        mutationId: "native-write-fence.raw-reopen-probe",
        nativeSessionId: rawProbeSessionId,
        expectedPersistenceRevision: 0,
        expectedIntegrityDigest: ZERO_DIGEST,
        state: Object.freeze({
          sessionId: rawProbeSessionId,
          meta: Object.freeze({
            runtimeConfig: Object.freeze({ revision: 1 }),
          }),
        }),
      })),
      "INTEGRATION_SESSION_STATE_STORE_WRITE_FENCE_REQUIRED"
    );
    await bindRetainedIntegrationSessionStateStoreWriteFence(
      sameDescriptorStore,
      sameDescriptorExpected,
      fixture.nativeWriteFence
    );
    const sameDescriptorEvidence = createRetainedIntegrationNativeExecutionEvidence({
      sessionStateStore: sameDescriptorStore,
      sessionStateStoreExpected: sameDescriptorExpected,
      nativeWriteFence: fixture.nativeWriteFence,
    });
    await expectCode(
      () => createRetainedIntegrationRuntimeRecoveryCoordinator({
        repository: fixture.repository,
        nativeExecutionEvidence: sameDescriptorEvidence,
        processOwnerBootstrap,
        repositoryFenceLease: fixture.acquiredFence.lease,
        nativeWriteFence: fixture.nativeWriteFence,
      }),
      "INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE"
    );
    const distinctSameDescriptorStore = await fixture.openDistinctSessionStore();
    await expectCode(
      () => createRetainedIntegrationTextWorkspace({
        sessionStateStore: distinctSameDescriptorStore,
        sessionStateStoreExpected: fixture.expected.sessionStateStore,
        nativeExecutionEvidence: fixture.evidence,
        nativeWriteFence: fixture.nativeWriteFence,
        repository: fixture.repository,
        recoveryCoordinator: fixture.recovery,
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
        nativeWriteFence: fixture.nativeWriteFence,
      }),
      "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE"
    );
    await expectCode(
      () => bindRetainedIntegrationSessionStateStoreWriteFence(
        mismatchFixture.sessionStateStore,
        mismatchFixture.sessionBinding.expected,
        fixture.nativeWriteFence
      ),
      "INTEGRATION_SESSION_STATE_STORE_WRITE_FENCE_INVALID"
    );
    await expectCode(
      () => createRetainedIntegrationTextWorkspace({
        sessionStateStore: fixture.sessionStateStore,
        sessionStateStoreExpected: fixture.expected.sessionStateStore,
        nativeExecutionEvidence: fixture.evidence,
        nativeWriteFence: fixture.nativeWriteFence,
        repository: mismatchFixture.repository,
        recoveryCoordinator: mismatchFixture.recovery,
        processOwnerBootstrap,
        repositoryFenceLease: mismatchFixture.acquiredFence.lease,
      }),
      "INTEGRATION_NATIVE_WRITE_FENCE_UNAVAILABLE"
    );
    const serializedNativeWriteFence = deepFreeze(
      JSON.parse(JSON.stringify(fixture.nativeWriteFence))
    );
    await expectCode(
      () => createRetainedIntegrationTextWorkspace({
        sessionStateStore: fixture.sessionStateStore,
        sessionStateStoreExpected: fixture.expected.sessionStateStore,
        nativeExecutionEvidence: fixture.evidence,
        nativeWriteFence: serializedNativeWriteFence,
        repository: fixture.repository,
        recoveryCoordinator: fixture.recovery,
        processOwnerBootstrap,
        repositoryFenceLease: fixture.acquiredFence.lease,
      }),
      "INTEGRATION_NATIVE_WRITE_FENCE_UNAVAILABLE"
    );
    await expectCode(
      () => runtimeAuthorityForFixture(fixture, {
        nativeWriteFence: serializedNativeWriteFence,
      }),
      "INTEGRATION_NATIVE_WRITE_FENCE_UNAVAILABLE"
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
    assert.equal(fixture.textWorkspace.attestation.crossProcessExecutionFence, true);
    assert.equal(fixture.evidence.attestation.crossProcessExecutionFence, true);
    assert.equal(fixture.textWorkspace.attestation.repositoryTransitionFenceBound, true);
    assert.equal(fixture.textWorkspace.attestation.nativeSessionStateWriterFencing, true);
    assert.equal(fixture.textWorkspace.attestation.nativeSessionStateWriterQuiescenceProven, true);
    assert.equal(fixture.textWorkspace.attestation.fullSessionStoreSidecarsFenced, false);
    assert.equal(fixture.textWorkspace.attestation.imagePerceptionSidecarsFenced, false);
    assert.equal(
      fixture.textWorkspace.attestation.nativeWriteFenceAttestationDigest,
      fixture.nativeWriteFence.attestation.digest
    );
    const currentProfileProof = await fixture.textWorkspace.attestCurrent();
    assert.equal(currentProfileProof.durablyCurrent, true);
    assert.equal(currentProfileProof.nativeSessionStateWriterFencing, true);
    assert.equal(currentProfileProof.nativeSessionStateWriterQuiescenceProven, true);
    assert.equal(currentProfileProof.fullSessionStoreSidecarsFenced, false);
    assert.equal(currentProfileProof.imagePerceptionSidecarsFenced, false);
    assert.equal(
      currentProfileProof.nativeWriteFenceAttestationDigest,
      fixture.nativeWriteFence.attestation.digest
    );
    assert.equal(currentProfileProof.repositoryFenceLeaseDigest, fixture.acquiredFence.lease.digest);
    const integratedRuntimeProof = await runtimeAuthorityForFixture(fixture).getIntegrationRuntimeProof();
    assert.equal(
      integratedRuntimeProof.retainedNativeExecutionEvidenceProofDigest,
      fixture.evidence.attestation.digest
    );
    assert.equal(
      integratedRuntimeProof.retainedRecoveryCoordinatorProofDigest,
      fixture.recovery.attestation.digest
    );
    assert.equal(
      integratedRuntimeProof.retainedTextWorkspaceProofDigest,
      fixture.textWorkspace.attestation.digest
    );
    assert.equal(integratedRuntimeProof.retainedTextWorkspaceCurrentProofDigest, currentProfileProof.digest);
    assert.equal(integratedRuntimeProof.retainedTextWorkspaceNativeWriterFencing, true);
    assert.equal(integratedRuntimeProof.retainedTextWorkspaceNativeWriterQuiescence, true);
    assert.equal(integratedRuntimeProof.retainedTextWorkspaceFullSessionStoreSidecarsFenced, false);
    assert.equal(integratedRuntimeProof.retainedTextWorkspaceImagePerceptionSidecarsFenced, false);
    assert.equal(integratedRuntimeProof.nativeWriteFence.nativeSessionStateWriterFencing, true);
    assert.equal(integratedRuntimeProof.nativeWriteFence.fullSessionStoreSidecarsFenced, false);
    assert.equal(integratedRuntimeProof.nativeWriteFence.imagePerceptionSidecarsFenced, false);
    assert.equal(integratedRuntimeProof.repositoryFence.leaseDigest, fixture.acquiredFence.lease.digest);
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
    for (const [key, value] of Object.entries({
      nativeWriteFence: fixture.nativeWriteFence,
      repository: fixture.repository,
      recoveryCoordinator: fixture.recovery,
      processOwnerBootstrap,
      repositoryFenceLease: fixture.acquiredFence.lease,
    })) {
      Object.defineProperty(accessorFactoryPayload, key, { enumerable: true, value });
    }
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
    const staleTextProbe = await authorizeStaleTextProfileProbe(fixture, resumeOwner);
    const staleTextPreflight = await fixture.textWorkspace.prepareExecution(Object.freeze({
      mode: "start",
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: staleTextProbe.threadId,
      runId: staleTextProbe.runId,
      nativeSessionId: staleTextProbe.nativeSessionId,
    }));
    const staleTextExecution = await fixture.textWorkspace.bindAuthorizedExecution({
      authorization: staleTextProbe.authorized.receipt,
      snapshotHash: staleTextProbe.authorized.run.authority.snapshotHash,
      preflight: staleTextPreflight.handle,
    });
    const staleTextEventsBeforeHandoff = await fixture.textWorkspace.invoke(
      staleTextExecution,
      "loadEvents"
    );
    staleRuntimeFixture = await openSiblingFixture(rootPath, now, fixture);
    await expectCode(
      () => createRetainedIntegrationRuntimeNativeWriteFence(staleRuntimeFixture.repository, {
        processOwnerBootstrap,
        repositoryFenceLease: staleRuntimeFixture.acquiredFence.lease,
      }),
      "INTEGRATION_NATIVE_WRITE_FENCE_UNAVAILABLE"
    );
    const staleRuntimeAuthority = runtimeAuthorityForFixture(fixture);
    const beforeHandoffProof = await staleRuntimeAuthority.getIntegrationRuntimeProof();
    assert.equal(beforeHandoffProof.repositoryFence.acquired, true);
    assert.equal(beforeHandoffProof.repositoryFence.durablyCurrent, true);
    assert.equal(beforeHandoffProof.nativeWriteFence.required, true);
    assert.equal(beforeHandoffProof.nativeWriteFence.acquired, true);
    assert.equal(beforeHandoffProof.nativeWriteFence.exactLexicalCapability, true);
    assert.equal(beforeHandoffProof.nativeWriteFence.durablyCurrent, true);
    assert.equal(beforeHandoffProof.nativeWriteFence.fullSessionStoreSidecarsFenced, false);
    assert.equal(
      beforeHandoffProof.nativeWriteFence.attestationDigest,
      fixture.nativeWriteFence.attestation.digest
    );
    assert.equal(
      beforeHandoffProof.repositoryFence.leaseDigest,
      fixture.acquiredFence.lease.digest
    );
    successor = spawnSuccessor(rootPath);
    const successorReady = await successor.ready;
    await expectCode(
      () => handoffRetainedIntegrationRuntimeRepositoryFence(staleRuntimeFixture.repository, {
        currentProcessOwnerBootstrap: processOwnerBootstrap,
        successorProcessOwner: successorReady.processOwner,
        nativeWriteFence: fixture.nativeWriteFence,
      }),
      "INTEGRATION_NATIVE_WRITE_FENCE_UNAVAILABLE"
    );
    sessionLockBarrier = spawnSessionLockBarrier(path.join(
      rootPath,
      "native:sessions",
      INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE
    ));
    await sessionLockBarrier.locked;
    const completionOrder = [];
    const admittedCasPromise = fixture.sessionStateStore.compareAndSwapSessionSnapshot(
      Object.freeze({
        mutationId: "native-write-fence.admitted-before-handoff",
        nativeSessionId: rawProbeSessionId,
        expectedPersistenceRevision: 0,
        expectedIntegrityDigest: ZERO_DIGEST,
        state: Object.freeze({
          sessionId: rawProbeSessionId,
          meta: Object.freeze({ runtimeConfig: Object.freeze({ revision: 1 }) }),
        }),
      })
    ).then((result) => {
      completionOrder[completionOrder.length] = "native-cas";
      return result;
    });
    await waitForFenceActivity(
      fixture.nativeWriteFence,
      (proof) => proof.activeWrites === 1 && proof.quiescing === false,
      "admitted CAS"
    );
    const handoffPromise = handoffRetainedIntegrationRuntimeRepositoryFence(fixture.repository, {
      currentProcessOwnerBootstrap: processOwnerBootstrap,
      successorProcessOwner: successorReady.processOwner,
      nativeWriteFence: fixture.nativeWriteFence,
    }).then((result) => {
      completionOrder[completionOrder.length] = "handoff";
      return result;
    });
    const drainingProof = await waitForFenceActivity(
      fixture.nativeWriteFence,
      (proof) => proof.activeWrites === 1 && proof.quiescing === true,
      "handoff drain"
    );
    assert.equal(drainingProof.quiesced, false);
    sessionLockBarrier.release();
    const barrierExit = await sessionLockBarrier.exited;
    assert.equal(barrierExit.code, 0, barrierExit.stderr);
    sessionLockBarrier = null;
    const [admittedCas, handoff] = await Promise.all([admittedCasPromise, handoffPromise]);
    assert.equal(admittedCas.outcome, "committed");
    assert.deepEqual(completionOrder, ["native-cas", "handoff"]);
    await expectCode(
      () => staleRuntimeAuthority.getIntegrationRuntimeProof(),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => fixture.textWorkspace.attestCurrent(),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => createRetainedIntegrationTextWorkspace({
        sessionStateStore: fixture.sessionStateStore,
        sessionStateStoreExpected: fixture.expected.sessionStateStore,
        nativeExecutionEvidence: fixture.evidence,
        nativeWriteFence: fixture.nativeWriteFence,
        repository: fixture.repository,
        recoveryCoordinator: fixture.recovery,
        processOwnerBootstrap,
        repositoryFenceLease: fixture.acquiredFence.lease,
      }),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => fixture.textWorkspace.invoke(
        staleTextExecution,
        "appendEvent",
        ["native.write-fence.stale-text-profile", Object.freeze({ afterHandoff: true })]
      ),
      "INTEGRATION_NATIVE_WRITE_FENCE_STALE"
    );
    const staleTextEventsAfterHandoff = await fixture.textWorkspace.invoke(
      staleTextExecution,
      "loadEvents"
    );
    assert.deepEqual(staleTextEventsAfterHandoff, staleTextEventsBeforeHandoff);
    const successorRequest = Object.freeze({
      runId: RESUME_RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedCursor: noEvidenceCursor,
    });
    await expectCode(
      () => fixture.recovery.resolveRecoveryHeldRun(successorRequest),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => fixture.repository.finishIntegrationRunWithOutbox(resumedFinishPayload),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    const staleRawBefore = await fixture.sessionStateStore.loadSessionSnapshot(rawProbeSessionId);
    await expectCode(
      () => fixture.sessionStateStore.compareAndSwapSessionSnapshot(Object.freeze({
        mutationId: "native-write-fence.stale-raw-cas",
        nativeSessionId: rawProbeSessionId,
        expectedPersistenceRevision: staleRawBefore.persistenceRevision,
        expectedIntegrityDigest: staleRawBefore.integrityDigest,
        state: Object.freeze({
          sessionId: rawProbeSessionId,
          meta: Object.freeze({ runtimeConfig: Object.freeze({ revision: 1 }) }),
        }),
      })),
      "INTEGRATION_NATIVE_WRITE_FENCE_STALE"
    );
    const staleRawAfter = await fixture.sessionStateStore.loadSessionSnapshot(rawProbeSessionId);
    assert.equal(staleRawAfter.persistenceRevision, staleRawBefore.persistenceRevision);
    assert.equal(staleRawAfter.integrityDigest, staleRawBefore.integrityDigest);
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
    assert.equal(successorResult.nativeWriteFence.acquired, true);
    assert.equal(successorResult.nativeWriteFence.durablyCurrent, true);
    assert.equal(successorResult.nativeWriteFence.generation, successorResult.fence.generation);
    assert.equal(successorResult.nativeWriteFence.fenceDigest, successorResult.fence.fenceDigest);
    assert.equal(successorResult.nativeWriteFence.nativeSessionStateWriterFencing, true);
    assert.equal(successorResult.nativeWriteFence.fullSessionStoreSidecarsFenced, false);
    assert.equal(successorResult.nativeWriteFence.imagePerceptionSidecarsFenced, false);
    assert.equal(successorResult.textWorkspace.profile, INTEGRATION_TEXT_WORKSPACE_PROFILE_ID);
    assert.equal(successorResult.textWorkspace.durablyCurrent, true);
    assert.equal(successorResult.textWorkspace.nativeSessionStateWriterFencing, true);
    assert.equal(successorResult.textWorkspace.nativeSessionStateWriterQuiescenceProven, true);
    assert.equal(successorResult.textWorkspace.fullSessionStoreSidecarsFenced, false);
    assert.equal(successorResult.textWorkspace.imagePerceptionSidecarsFenced, false);
    assert.equal(
      successorResult.textWorkspace.nativeWriteFenceAttestationDigest,
      successorResult.nativeWriteFence.attestationDigest
    );
    assert.equal(
      successorResult.textWorkspace.currentProofDigest,
      successorResult.textWorkspace.runtimeProofDigest
    );
    assert.equal(successorResult.textWorkspace.runtimeNativeWriterFencing, true);
    assert.equal(successorResult.textWorkspace.runtimeNativeWriterQuiescence, true);
    assert.equal(successorResult.successorNativeWrite.outcome, "committed");
    assert.equal(successorResult.successorNativeWrite.persistenceRevision, 2);
    assert.equal(successorResult.successorNativeWrite.runtimeRevision, 2);
    assert.equal(successorResult.coordinatorFenceDigest, successorResult.fence.fenceDigest);
    assert.equal(successorResult.coordinatorLeaseDigest, successorResult.fence.leaseDigest);
    const successorExit = await successor.exited;
    assert.equal(successorExit.code, 0, successorExit.stderr);
    const closedTextWorkspace = mismatchFixture.textWorkspace;
    await mismatchFixture.authority.close();
    await expectCode(
      () => closedTextWorkspace.attestCurrent(),
      "INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE"
    );
    await expectCode(
      () => assertRetainedIntegrationTextWorkspaceCurrent(closedTextWorkspace, {
        nativeExecutionEvidence: mismatchFixture.evidence,
        nativeWriteFence: mismatchFixture.nativeWriteFence,
        repository: mismatchFixture.repository,
        recoveryCoordinator: mismatchFixture.recovery,
        processOwnerBootstrap,
        repositoryFenceLease: mismatchFixture.acquiredFence.lease,
      }),
      "INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE"
    );
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
      stableSealSurvivesRestart: true,
      mismatchedStableRootRejected: true,
      samePathRepositoryLockReplacementRejected: true,
      maliciousFakePresealRejected: true,
      rawReopenedStoreWriteRejected: true,
      siblingSurfaceGuardRejected: true,
      staleRawCasRejectedBeforeCommit: true,
      admittedNativeCasDrainedBeforeHandoff: true,
      authorizationProcessOwnerBound: true,
      missingTerminalEvidenceHeld: true,
      historicalRecoveryReplayAfterReceiptPruningExpired: true,
      durableRuntimeProofReload: true,
      staleCoordinatorRejectedAfterHandoff: true,
      staleRepositoryMutationRejectedAfterHandoff: true,
      staleTextWorkspaceConstructionRejectedAfterHandoff: true,
      staleTextWorkspaceAttestationRejectedAfterHandoff: true,
      staleTextWorkspaceCasRejectedAfterHandoff: true,
      successorRecoveryAfterHandoff: true,
      successorNativeResumeWriteAfterHandoff: true,
      successorTextWorkspaceReopenedAfterHandoff: true,
      closedTextWorkspaceCurrentProofRejected: true,
      exactRuntimeNativeWriteFenceAttestation: true,
      textWorkspaceProfile: true,
      retainedHashChainedEventJournal: true,
      eventReplayAcrossResume: true,
      legacySessionRootAccess: false,
      imagePerception: false,
      shellExecution: false,
      nativeSessionStateWriterFencing: true,
      nativeSessionStateWriterQuiescenceProven: true,
      fullSessionStoreSidecarsFenced: false,
      fullSessionStoreRetained: false,
      runtimeCapabilityEnabled: false,
    }));
  } finally {
    sessionLockBarrier?.terminate();
    successor?.terminate();
    await staleRuntimeFixture?.authority?.close?.().catch(() => {});
    await fixture?.authority.close().catch(() => {});
    await mismatchFixture?.authority.close().catch(() => {});
    await spliceFixture?.authority.close().catch(() => {});
    await spliceReplacementFixture?.authority.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    await fs.rm(mismatchRootPath, { recursive: true, force: true });
    await fs.rm(spliceRootPath, { recursive: true, force: true });
  }
}

if (CHILD_MODE === "successor") await runSuccessorChild();
else await run();
