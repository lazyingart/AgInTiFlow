import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UID = process.getuid();
const GID = process.getgid();
const HELPER_PATH = "/usr/bin/flock";
const ZERO_DIGEST = "0".repeat(64);
const MODE = String(process.argv.find((value) => value.startsWith("--mock-mode=")) || "").slice(12);
const FAULT_MODES = Object.freeze(["rename-before", "rename-after"]);
const REPOSITORY_SNAPSHOT_FILE = "repository.snapshot.json";
const fault = { armed: false, hits: 0 };
let fsMock = null;

if (FAULT_MODES.includes(MODE)) {
  const { mock } = await import("node:test");
  const realFs = fs;
  const mockFs = { ...realFs };
  mockFs.rename = async (source, target) => {
    if (
      fault.armed &&
      path.basename(String(target)) === REPOSITORY_SNAPSHOT_FILE
    ) {
      fault.armed = false;
      fault.hits += 1;
      if (MODE === "rename-before") {
        const error = new Error("synthetic native-session repository rename-before failure");
        error.code = "EIO";
        throw error;
      }
      await realFs.rename(source, target);
      const error = new Error("synthetic native-session repository rename-after ambiguity");
      error.code = "EIO";
      throw error;
    }
    return realFs.rename(source, target);
  };
  fsMock = mock.module("node:fs/promises", { defaultExport: mockFs });
}

const [domainApi, kernelApi, sessionApi, storageApi, durableApi, contractApi] = await Promise.all([
  import(new URL("../src/integration-retained-native-session-repository-state.js", import.meta.url).href),
  import(new URL("../src/integration-runtime-repository.js", import.meta.url).href),
  import(new URL("../src/integration-retained-session-state-store.js", import.meta.url).href),
  import(new URL("../src/integration-storage-authority.js", import.meta.url).href),
  import(new URL("../src/integration-durable-common.js", import.meta.url).href),
  import(new URL("../src/integration-runtime-repository-contract.js", import.meta.url).href),
]);

const {
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_ATTESTATION_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_DOMAIN_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_SNAPSHOT_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_LAST_MUTATION_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_THREAD_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RUN_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_ARTIFACT_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MUTATION_RECEIPT_VERSION,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_DIGEST_DOMAIN,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_REQUEST_DIGEST_DOMAIN,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_LAST_MUTATION_DIGEST_DOMAIN,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_THREADS,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RUNS,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_OUTBOX_EVENTS,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_ARTIFACTS,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MUTATION_RECEIPTS,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MESSAGES_PER_THREAD,
  INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_LIMITATIONS,
  createRetainedIntegrationNativeSessionRepositoryState,
  assertRetainedIntegrationNativeSessionRepositoryState,
} = domainApi;
const {
  INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_INTEGRITY_DOMAIN,
  INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
  INTEGRATION_RETAINED_REPOSITORY_PAYLOAD_DIGEST_DOMAIN,
  INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE,
  INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_INTEGRITY_DOMAIN,
  createRetainedIntegrationRuntimeRepositoryKernel,
} = kernelApi;
const {
  INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
  createRetainedIntegrationSessionStateStore,
} = sessionApi;
const { INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE } = durableApi;
const { assertIntegrationRuntimeRepositorySurface } = contractApi;

const SURFACE_KEYS = Object.freeze([
  "schemaVersion",
  "attestation",
  "loadDomainSnapshot",
  "compareAndSwapDomainSnapshot",
  "isClosed",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "snapshotRevision",
  "previousIntegrityDigest",
  "state",
  "stateDigest",
  "lastMutation",
  "integrityDigest",
]);
const LAST_MUTATION_KEYS = Object.freeze([
  "schemaVersion",
  "mutationId",
  "requestDigest",
  "baseSnapshotRevision",
  "baseIntegrityDigest",
  "resultSnapshotRevision",
  "stateDigest",
  "mutationDigest",
]);
const RESULT_KEYS = Object.freeze(["outcome", "snapshot"]);
const DOMAIN_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "repositoryPointerDigest",
  "sessionStateNamespaceDigest",
  "generation",
  "threads",
  "runs",
  "outboxEvents",
  "artifacts",
  "mutationReceipts",
]);

const PRINCIPAL = "principalAAAAAAAA";
const BROWSER_SESSION = "a".repeat(64);
const THREAD_ID = "thr_00000000-0000-4000-8000-000000000121";
const RUN_ID = "run_00000000-0000-4000-8000-000000000122";
const ARTIFACT_ID = `art_${"e".repeat(64)}`;
const NATIVE_SESSION_ID = "aginti:repository-state-smoke";
const CREATED_AT = "2026-08-22T01:00:00.000Z";
const DISPATCHED_AT = "2026-08-22T01:00:01.000Z";
const COMPLETED_AT = "2026-08-22T01:00:02.000Z";
const RESUME_CREATED_AT = "2026-08-22T01:00:03.000Z";
const RESUME_DISPATCHED_AT = "2026-08-22T01:00:04.000Z";
const RESUME_COMPLETED_AT = "2026-08-22T01:00:05.000Z";

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("independent canonical JSON received unsupported data");
}

function independentDigest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function digestWithout(value, omittedKey) {
  return Object.fromEntries(Object.keys(value).filter((key) => key !== omittedKey).map((key) => [key, value[key]]));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function identityDigest(stat) {
  return independentDigest({
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
  await fs.writeFile(filePath, "", { flag: "a", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  await fs.chown(filePath, UID, GID);
}

async function openCombinedFixture(rootPath, role = "native-session-repository-state-smoke") {
  const repositorySegments = Object.freeze(["data:repository"]);
  const sessionSegments = Object.freeze(["native:sessions"]);
  const repositoryPath = path.join(rootPath, ...repositorySegments);
  const sessionPath = path.join(rootPath, ...sessionSegments);
  const repositoryLockPath = path.join(repositoryPath, INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE);
  const sessionLockPath = path.join(sessionPath, INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE);
  await ensureOwnerDirectory(rootPath);
  await ensureOwnerDirectory(repositoryPath);
  await ensureOwnerDirectory(sessionPath);
  await ensureLockFile(repositoryLockPath);
  await ensureLockFile(sessionLockPath);
  const authority = await storageApi.openIntegrationStorageAuthority({
    rootPath,
    role,
    ownerUid: UID,
    ownerGid: GID,
    label: "retained native-session repository-state smoke",
  });
  const helperSha256 = crypto.createHash("sha256").update(await fs.readFile(HELPER_PATH)).digest("hex");
  const helperIdentityDigest = identityDigest(await fs.stat(HELPER_PATH, { bigint: true }));

  async function openBoundDirectory(relativeSegments, lockFileName, lockPath, byteField, byteValue) {
    const directory = await authority.openDirectory(relativeSegments);
    const directoryIdentity = await directory.identity();
    const directoryExpected = Object.freeze({
      role,
      canonicalPath: rootPath,
      rootIdentityDigest: authority.attestation.rootIdentityDigest,
      relativeSegments,
      directoryIdentityDigest: directoryIdentity.digest,
    });
    const files = storageApi.createIntegrationRetainedFilePrimitives(directory, directoryExpected);
    const lockFileIdentityDigest = identityDigest(await fs.stat(lockPath, { bigint: true }));
    const lockExpected = Object.freeze({
      ...directoryExpected,
      lockFileName,
      helperSha256,
      lockFileIdentityDigest,
      helperIdentityDigest,
    });
    const expected = Object.freeze({
      ...directoryExpected,
      lockFileIdentityDigest,
      helperSha256,
      helperIdentityDigest,
      [byteField]: byteValue,
      lockWaitMs: 2000,
    });
    const lock = await storageApi.openIntegrationRetainedRegularFileLock(files, lockExpected);
    return Object.freeze({ directory, files, lock, expected });
  }

  const repository = await openBoundDirectory(
    repositorySegments,
    INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
    repositoryLockPath,
    "maxSnapshotBytes",
    512 * 1024
  );
  const session = await openBoundDirectory(
    sessionSegments,
    INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
    sessionLockPath,
    "maxStateBytes",
    256 * 1024
  );
  const kernel = createRetainedIntegrationRuntimeRepositoryKernel(
    repository.files,
    repository.lock,
    repository.expected
  );
  const sessionStateStore = createRetainedIntegrationSessionStateStore(
    session.files,
    session.lock,
    session.expected
  );
  const expected = Object.freeze({
    repositoryKernel: repository.expected,
    sessionStateStore: session.expected,
  });
  const surface = createRetainedIntegrationNativeSessionRepositoryState(
    kernel,
    sessionStateStore,
    expected
  );
  return Object.freeze({
    rootPath,
    authority,
    repository,
    session,
    kernel,
    sessionStateStore,
    expected,
    surface,
    repositoryPath,
    sessionPath,
    repositorySnapshotPath: path.join(repositoryPath, INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE),
  });
}

function assertExactFrozenNullSurface(value, keys) {
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual(Reflect.ownKeys(value), keys);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.equal(descriptor?.enumerable, true);
    assert.equal(descriptor?.configurable, false);
    assert.equal(descriptor?.writable, false);
    assert.equal(Object.prototype.hasOwnProperty.call(descriptor || {}, "value"), true);
  }
}

async function expectCode(action, expected, forbiddenRoot = "") {
  const expectedCodes = Array.isArray(expected) ? expected : [expected];
  let captured;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  assert(captured, `Expected ${expectedCodes.join(" or ")}`);
  assert.equal(expectedCodes.includes(captured.publicCode || captured.code), true, String(captured?.message || captured));
  const publicText = JSON.stringify({
    code: captured.publicCode || captured.code,
    message: captured.message,
    details: captured.details,
  });
  assert.equal(publicText.includes("/proc/self/fd"), false);
  assert.equal(publicText.includes(HELPER_PATH), false);
  if (forbiddenRoot) assert.equal(publicText.includes(forbiddenRoot), false);
  return captured;
}

async function fdTargetsContaining(text) {
  const targets = [];
  for (const name of await fs.readdir("/proc/self/fd")) {
    const target = await fs.readlink(`/proc/self/fd/${name}`).catch(() => "");
    if (target.includes(text)) targets.push(target);
  }
  return targets.sort();
}

function processOwner() {
  return {
    schemaVersion: "aginti-process-owner-v1",
    pid: 4242,
    token: "1".repeat(32),
    processIdentity: {
      schemaVersion: "aginti-process-identity-v1",
      bootId: "01234567-89ab-cdef-0123-456789abcdef",
      startTimeTicks: "123456",
    },
    acquiredAt: CREATED_AT,
    heartbeatAt: DISPATCHED_AT,
  };
}

function nativeStartReceiptFor({
  owner,
  mode = "start",
  runId = RUN_ID,
  previousRunId = null,
  previousRunRevision = null,
  previousRunRuntimeRevision = null,
  threadRevision = 5,
  createdAt = CREATED_AT,
  dispatchedAt = DISPATCHED_AT,
  expectedNativeRuntimeRevision = 7,
  targetNativeRuntimeRevision = expectedNativeRuntimeRevision,
  dispatchLeaseId = "3".repeat(64),
}) {
  const unsigned = {
    schemaVersion: "aginti-native-start-authorization-v1",
    mode,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId: THREAD_ID,
    runId,
    nativeSessionId: NATIVE_SESSION_ID,
    previousRunId,
    previousRunRevision,
    previousRunRuntimeRevision,
    threadRevision,
    threadPreservationDigest: "2".repeat(64),
    createdAt,
    startedAt: createdAt,
    expectedNativeRuntimeRevision,
    targetNativeRuntimeRevision,
    expectedRunRevision: 2,
    targetRunRevision: 3,
    dispatchLeaseId,
    dispatchOutbox: true,
    dispatchedAt,
    processOwner: owner,
    authorizedAt: dispatchedAt,
  };
  const authorizationDigest = independentDigest(unsigned);
  return {
    ...unsigned,
    authorizationId: `nstart_${authorizationDigest.slice(0, 48)}`,
    authorizationDigest,
  };
}

function nativeStartReceipt(owner) {
  return nativeStartReceiptFor({ owner });
}

function completionOutboxRecord({
  outboxId,
  runId = RUN_ID,
  type = "run.completed",
  payload = {},
  createdAt = COMPLETED_AT,
  expectedPreviousSeq = 0,
  expectedPreviousHash = ZERO_DIGEST,
  delivered = false,
}) {
  const seq = expectedPreviousSeq + 1;
  const eventEnvelope = {
    schemaVersion: "1",
    id: `${runId}.${seq}`,
    seq,
    type,
    threadId: THREAD_ID,
    runId,
    createdAt,
    payload,
    previousHash: expectedPreviousHash,
  };
  const expectedEventHash = independentDigest(eventEnvelope);
  return {
    outboxId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId: THREAD_ID,
    runId,
    type,
    payload,
    createdAt,
    expectedPreviousSeq,
    expectedPreviousHash,
    expectedEventHash,
    delivered,
    deliveredEventSeq: delivered ? seq : null,
    deliveredEventHash: delivered ? expectedEventHash : null,
    deliveredEventDigest: delivered
      ? independentDigest({ ...eventEnvelope, hash: expectedEventHash })
      : null,
  };
}

function terminalOutbox() {
  return completionOutboxRecord({ outboxId: "outbox.repository-state.terminal" });
}

function completionDigestView(outbox) {
  return {
    outboxId: outbox.outboxId,
    principalId: outbox.principalId,
    browserSessionId: outbox.browserSessionId,
    browserSessionPolicy: outbox.browserSessionPolicy,
    threadId: outbox.threadId,
    runId: outbox.runId,
    type: outbox.type,
    payload: outbox.payload,
    createdAt: outbox.createdAt,
    expectedPreviousSeq: outbox.expectedPreviousSeq,
    expectedPreviousHash: outbox.expectedPreviousHash,
    expectedEventHash: outbox.expectedEventHash,
  };
}

function completionMetadataFor({
  runId = RUN_ID,
  status = "completed",
  completedAt = COMPLETED_AT,
  runtimeRevision = 7,
  completionRevision = 4,
  threadRevision = 6,
  outboxes,
}) {
  const first = outboxes[0];
  return {
    schemaVersion: "aginti-completion-outbox-bundle-v1",
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId: THREAD_ID,
    runId,
    status,
    completedAt,
    runtimeRevision,
    completionRevision,
    threadRevision,
    originalCursor: {
      firstSeq: 1,
      lastSeq: first.expectedPreviousSeq,
      lastHash: first.expectedPreviousHash,
      prunedThroughSeq: 0,
    },
    outboxIds: outboxes.map((outbox) => outbox.outboxId),
    eventTypes: outboxes.map((outbox) => outbox.type),
    eventHashes: outboxes.map((outbox) => outbox.expectedEventHash),
    orderedBundleDigest: independentDigest(outboxes.map(completionDigestView)),
  };
}

function completionMetadata(outbox) {
  return completionMetadataFor({ outboxes: [outbox] });
}

function fullRecords() {
  const owner = processOwner();
  const outbox = terminalOutbox();
  const receipt = nativeStartReceipt(owner);
  const thread = {
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_THREAD_VERSION,
    id: THREAD_ID,
    nativeSessionId: NATIVE_SESSION_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    title: "Repository state smoke",
    status: "idle",
    revision: 6,
    createdAt: CREATED_AT,
    updatedAt: COMPLETED_AT,
    deletedAt: null,
    tombstone: false,
    lastRunId: RUN_ID,
    authority: {
      kind: "aginti",
      mapped: true,
      runtimeRevision: 7,
      contextDigest: "4".repeat(64),
      lastCompaction: null,
    },
    replay: { prunedMessageCount: 0, anchorDigest: ZERO_DIGEST },
    messages: [{
      id: "msg_repository_state_0001",
      role: "assistant",
      content: "Completed safely.",
      runId: RUN_ID,
      createdAt: COMPLETED_AT,
      digest: "5".repeat(64),
    }],
  };
  const run = {
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_RUN_VERSION,
    id: RUN_ID,
    threadId: THREAD_ID,
    nativeSessionId: NATIVE_SESSION_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    previousRunId: null,
    status: "completed",
    revision: 4,
    createdAt: CREATED_AT,
    startedAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    cancelRequestedAt: null,
    dispatchLeaseId: receipt.dispatchLeaseId,
    dispatchOutbox: true,
    dispatchedAt: DISPATCHED_AT,
    processOwner: owner,
    hidden: false,
    tombstone: false,
    abortAttemptDigest: null,
    abortAt: null,
    nativeStartReceipt: receipt,
    recoveryState: null,
    inputDigest: "6".repeat(64),
    output: "",
    error: null,
    authority: {
      kind: "aginti",
      snapshotHash: "7".repeat(64),
      runtimeRevision: 7,
      contextDigest: "4".repeat(64),
      completionOutbox: completionMetadata(outbox),
    },
  };
  const artifact = {
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_ARTIFACT_VERSION,
    id: ARTIFACT_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId: THREAD_ID,
    runId: RUN_ID,
    title: "Safe report",
    kind: "markdown",
    spec: { schemaVersion: "1", markdown: "Repository state report" },
    revision: 3,
    stagedAt: COMPLETED_AT,
    published: false,
    publishedAt: null,
  };
  const result = { schemaVersion: "1", outcome: "recorded" };
  const mutationReceipt = {
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MUTATION_RECEIPT_VERSION,
    mutationId: "receipt.repository.state.0001",
    operation: "schema-smoke",
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    requestDigest: "8".repeat(64),
    baseSnapshotRevision: 0,
    baseIntegrityDigest: ZERO_DIGEST,
    resultSnapshotRevision: 1,
    resultDigest: independentDigest(result),
    result,
    committedAt: COMPLETED_AT,
  };
  return { thread, run, outbox, artifact, mutationReceipt };
}

function domainStateFor(surface, generation, overrides = {}) {
  const records = fullRecords();
  return {
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_DOMAIN_VERSION,
    owner: "aginti",
    authority: "aginti",
    repositoryPointerDigest: surface.attestation.repositoryPointerDigest,
    sessionStateNamespaceDigest: surface.attestation.sessionStateNamespaceDigest,
    generation,
    threads: [records.thread],
    runs: [records.run],
    outboxEvents: [records.outbox],
    artifacts: [records.artifact],
    mutationReceipts: [records.mutationReceipt],
    ...overrides,
  };
}

function emptyDomainStateFor(surface, generation) {
  return {
    schemaVersion: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_DOMAIN_VERSION,
    owner: "aginti",
    authority: "aginti",
    repositoryPointerDigest: surface.attestation.repositoryPointerDigest,
    sessionStateNamespaceDigest: surface.attestation.sessionStateNamespaceDigest,
    generation,
    threads: [],
    runs: [],
    outboxEvents: [],
    artifacts: [],
    mutationReceipts: [],
  };
}

function domainStateFromRecords(surface, generation, {
  threads,
  runs,
  outboxEvents = [],
  artifacts = [],
  mutationReceipts = [],
}) {
  return {
    ...emptyDomainStateFor(surface, generation),
    threads,
    runs,
    outboxEvents,
    artifacts,
    mutationReceipts,
  };
}

function casInput(mutationId, current, state) {
  return {
    mutationId,
    expectedSnapshotRevision: current.snapshotRevision,
    expectedIntegrityDigest: current.integrityDigest,
    state,
  };
}

function independentStateDigest(state) {
  return independentDigest({
    domain: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_DIGEST_DOMAIN,
    state,
  });
}

function independentRequestDigest(input, stateDigest) {
  return independentDigest({
    domain: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_REQUEST_DIGEST_DOMAIN,
    mutationId: input.mutationId,
    expectedSnapshotRevision: input.expectedSnapshotRevision,
    expectedIntegrityDigest: input.expectedIntegrityDigest,
    resultGeneration: input.state.generation,
    stateDigest,
  });
}

function independentLastMutationDigest(lastMutation) {
  return independentDigest({
    domain: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_LAST_MUTATION_DIGEST_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    mutation: digestWithout(lastMutation, "mutationDigest"),
  });
}

function verifyPersistedEnvelope(raw, parsed, result, input) {
  assert.equal(raw, `${canonicalJson(parsed)}\n`);
  assert.equal(canonicalJson(parsed.payload), canonicalJson(result.snapshot.state));
  const payloadDigest = independentDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_PAYLOAD_DIGEST_DOMAIN,
    payload: parsed.payload,
  });
  assert.equal(parsed.payloadDigest, payloadDigest);
  assert.equal(parsed.lastCommit.requestDigest, independentRequestDigest(input, result.snapshot.stateDigest));
  assert.equal(parsed.lastCommit.commitDigest, independentDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(parsed.lastCommit, "commitDigest"),
  }));
  assert.equal(parsed.integrityDigest, independentDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(parsed, "integrityDigest"),
  }));
  assert.equal(result.snapshot.stateDigest, independentStateDigest(result.snapshot.state));
  assert.equal(result.snapshot.lastMutation.mutationDigest, independentLastMutationDigest(result.snapshot.lastMutation));
  assert.equal(result.snapshot.integrityDigest, parsed.integrityDigest);
}

async function runStaticBoundaryChecks(surface) {
  const source = await fs.readFile(
    new URL("../src/integration-retained-native-session-repository-state.js", import.meta.url),
    "utf8"
  );
  const config = await fs.readFile(new URL("../src/integration-config.js", import.meta.url), "utf8");
  assert.match(source, /runtimeCapabilityEnabled:\s*false/u);
  assert.match(source, /runtimeWiringIncluded:\s*false/u);
  assert.doesNotMatch(
    source,
    /integration-(?:runtime-authority|server|native-executor|session-service|session-persistence|api|runtime-repository-contract|event-ledger-store|idempotency-store)\.js|(?:^|\/)session-store\.js|artifact-tunnel\.js/u
  );
  assert.match(config, /capability:\s*Object\.freeze\(\{ enabled: false \}\)/u);
  const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
  for (const consumerName of [
    "integration-native-executor.js",
    "integration-runtime-authority.js",
    "integration-native-runtime-roots.js",
    "integration-server.js",
    "integration-session-persistence.js",
    "integration-session-service.js",
    "session-store.js",
  ]) {
    const consumer = await fs.readFile(path.join(sourceDirectory, consumerName), "utf8");
    assert.doesNotMatch(
      consumer,
      /integration-retained-native-session-repository-state|(?:create|assert)RetainedIntegrationNativeSessionRepositoryState/u,
      `${consumerName} must not wire the capability-disabled repository-state surface.`
    );
  }
  assert.throws(
    () => assertIntegrationRuntimeRepositorySurface(surface),
    (error) => (error?.publicCode || error?.code) === "AGENT_UNAVAILABLE"
  );
}

async function runSurfaceBindingAndHostilityChecks(fixture) {
  const { surface } = fixture;
  assertExactFrozenNullSurface(surface, SURFACE_KEYS);
  assert.equal(surface.schemaVersion, INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_VERSION);
  assert.equal(
    surface.attestation.schemaVersion,
    INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_ATTESTATION_VERSION
  );
  assert.equal(surface.attestation.runtimeCapabilityEnabled, false);
  assert.equal(surface.attestation.runtimeWiringIncluded, false);
  assert.equal(surface.attestation.runtimeRepositorySurface, false);
  assert.equal(surface.attestation.repositoryTransitionsIncluded, false);
  assert.equal(surface.attestation.artifactSemanticsIncluded, false);
  assert.equal(surface.attestation.eventLedgerIntegration, false);
  assert.equal(surface.attestation.sessionStateStoreMutation, false);
  assert.equal(surface.attestation.idempotencySemanticsIncluded, false);
  assert.equal(surface.attestation.crossStoreAtomicity, false);
  assert.equal(surface.attestation.snapshotLocalValidationOnly, true);
  assert.equal(surface.attestation.limitations, INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_LIMITATIONS);
  assert.equal(surface.attestation.maxThreads, INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_THREADS);
  assert.equal(surface.attestation.maxRuns, INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_RUNS);
  assert.equal(surface.attestation.maxOutboxEvents, INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_OUTBOX_EVENTS);
  assert.equal(surface.attestation.maxArtifacts, INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_ARTIFACTS);
  assert.equal(surface.attestation.maxMutationReceipts, INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MUTATION_RECEIPTS);
  assert.equal(surface.attestation.maxMessagesPerThread, INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_MESSAGES_PER_THREAD);
  assert.equal(
    surface.attestation.digest,
    independentDigest(digestWithout(surface.attestation, "digest"))
  );
  assert.equal(
    surface.attestation.admissionBindingDigest,
    independentDigest({
      schemaVersion: "aginti-retained-native-session-repository-state-admission-v1",
      repositoryKernel: fixture.expected.repositoryKernel,
      sessionStateStore: fixture.expected.sessionStateStore,
      repositoryPointerDigest: surface.attestation.repositoryPointerDigest,
      sessionStateNamespaceDigest: surface.attestation.sessionStateNamespaceDigest,
    })
  );
  assert.equal(
    assertRetainedIntegrationNativeSessionRepositoryState(surface, fixture.expected),
    surface
  );

  const changedPointer = {
    ...digestWithout(surface.attestation, "digest"),
    repositoryPointerDigest: "9".repeat(64),
  };
  const changedNamespace = {
    ...digestWithout(surface.attestation, "digest"),
    sessionStateNamespaceDigest: "b".repeat(64),
  };
  assert.notEqual(independentDigest(changedPointer), surface.attestation.digest);
  assert.notEqual(independentDigest(changedNamespace), surface.attestation.digest);
  assert.notEqual(
    independentDigest({ domain: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_STATE_DIGEST_DOMAIN, state: {} }),
    independentDigest({ domain: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_REQUEST_DIGEST_DOMAIN, state: {} })
  );

  await expectCode(
    () => assertRetainedIntegrationNativeSessionRepositoryState({ ...surface }, fixture.expected),
    "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
    fixture.rootPath
  );
  let proxyTraps = 0;
  const dependencyProxy = new Proxy(fixture.kernel, {
    get() {
      proxyTraps += 1;
      throw new Error("dependency Proxy trap must not run");
    },
  });
  await expectCode(
    () => createRetainedIntegrationNativeSessionRepositoryState(
      dependencyProxy,
      fixture.sessionStateStore,
      fixture.expected
    ),
    "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
    fixture.rootPath
  );
  assert.equal(proxyTraps, 0);

  let segmentTraps = 0;
  const relativeSegmentsProxy = new Proxy(["data:repository"], {
    get(target, key, receiver) {
      if (key === "length") segmentTraps += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const proxyExpected = {
    repositoryKernel: { ...fixture.expected.repositoryKernel, relativeSegments: relativeSegmentsProxy },
    sessionStateStore: fixture.expected.sessionStateStore,
  };
  await expectCode(
    () => createRetainedIntegrationNativeSessionRepositoryState(
      fixture.kernel,
      fixture.sessionStateStore,
      proxyExpected
    ),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  assert.equal(segmentTraps, 0);

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const rejectedActual = Promise.reject(new Error("rejected actual dependency"));
    const rejectedExpected = Promise.reject(new Error("rejected nested expected binding"));
    await expectCode(
      () => createRetainedIntegrationNativeSessionRepositoryState(
        rejectedActual,
        fixture.sessionStateStore,
        {
          repositoryKernel: rejectedExpected,
          sessionStateStore: fixture.expected.sessionStateStore,
        }
      ),
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      fixture.rootPath
    );
    const rejectedSurface = Promise.reject(new Error("rejected asserted surface"));
    const rejectedAssertExpected = Promise.reject(new Error("rejected asserted expected binding"));
    await expectCode(
      () => assertRetainedIntegrationNativeSessionRepositoryState(rejectedSurface, {
        repositoryKernel: rejectedAssertExpected,
        sessionStateStore: fixture.expected.sessionStateStore,
      }),
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      fixture.rootPath
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

async function runCoreDomainChecks(fixture) {
  const { surface } = fixture;
  const zero = await surface.loadDomainSnapshot();
  assertExactFrozenNullSurface(zero, SNAPSHOT_KEYS);
  assert.equal(zero.schemaVersion, INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_SNAPSHOT_VERSION);
  assert.equal(zero.snapshotRevision, 0);
  assert.equal(zero.state.generation, 0);
  assert.equal(zero.integrityDigest, ZERO_DIGEST);
  assert.equal(zero.lastMutation, null);
  assert.deepEqual(Reflect.ownKeys(zero.state), DOMAIN_KEYS);

  const state = domainStateFor(surface, 1);
  assert.equal(state.generation, 1);
  assert.equal(state.threads[0].revision, 6);
  assert.equal(state.runs[0].revision, 4);
  assert.equal(state.threads[0].authority.runtimeRevision, 7);
  assert.notEqual(state.generation, state.threads[0].revision);
  assert.notEqual(state.runs[0].revision, state.threads[0].authority.runtimeRevision);
  const firstInput = casInput("mutation.repository.state.0001", zero, state);
  const sessionBefore = await fs.readdir(fixture.sessionPath);
  const first = await surface.compareAndSwapDomainSnapshot(firstInput);
  assertExactFrozenNullSurface(first, RESULT_KEYS);
  assert.equal(first.outcome, "committed");
  assertExactFrozenNullSurface(first.snapshot, SNAPSHOT_KEYS);
  assertExactFrozenNullSurface(first.snapshot.lastMutation, LAST_MUTATION_KEYS);
  assert.equal(first.snapshot.snapshotRevision, 1);
  assert.equal(first.snapshot.lastMutation.schemaVersion, INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_LAST_MUTATION_VERSION);
  assert.equal(first.snapshot.lastMutation.mutationId, firstInput.mutationId);
  assert.deepEqual(await fs.readdir(fixture.sessionPath), sessionBefore);
  const raw = await fs.readFile(fixture.repositorySnapshotPath, "utf8");
  const parsed = JSON.parse(raw);
  verifyPersistedEnvelope(raw, parsed, first, firstInput);
  assert.equal(canonicalJson(first.snapshot.state), canonicalJson(state));
  assert.equal(Object.isFrozen(first.snapshot.state), true);
  assert.equal(Object.getPrototypeOf(first.snapshot.state), null);

  const replay = await surface.compareAndSwapDomainSnapshot(firstInput);
  assert.equal(replay.outcome, "replayed");
  assert.equal(replay.snapshot.integrityDigest, first.snapshot.integrityDigest);
  assert.equal(await fs.readFile(fixture.repositorySnapshotPath, "utf8"), raw);
  const changedSameMutation = deepClone(firstInput);
  changedSameMutation.state.threads[0].title = "Changed replay";
  await expectCode(
    () => surface.compareAndSwapDomainSnapshot(changedSameMutation),
    "INTEGRATION_REPOSITORY_KERNEL_TRANSACTION_CONFLICT",
    fixture.rootPath
  );
  assert.equal(await fs.readFile(fixture.repositorySnapshotPath, "utf8"), raw);

  const secondState = deepClone(first.snapshot.state);
  secondState.generation = 2;
  secondState.threads[0].title = "Second generation";
  const secondInput = casInput("mutation.repository.state.0002", first.snapshot, secondState);
  const second = await surface.compareAndSwapDomainSnapshot(secondInput);
  assert.equal(second.outcome, "committed");
  assert.equal(second.snapshot.snapshotRevision, 2);
  const afterSecond = await fs.readFile(fixture.repositorySnapshotPath, "utf8");
  await expectCode(
    () => surface.compareAndSwapDomainSnapshot(firstInput),
    "INTEGRATION_REPOSITORY_KERNEL_CONFLICT",
    fixture.rootPath
  );
  assert.equal(await fs.readFile(fixture.repositorySnapshotPath, "utf8"), afterSecond);
  return { firstInput, first, secondInput, second };
}

async function runValidVariantMatrix(rootPath) {
  const fixture = await openCombinedFixture(rootPath, "repository-state-valid-variants");
  try {
    let current = await fixture.surface.loadDomainSnapshot();
    const sessionBefore = await fs.readdir(fixture.sessionPath);

    async function commitVariant(label, state, verify) {
      assert.equal(state.generation, current.snapshotRevision + 1);
      const committed = await fixture.surface.compareAndSwapDomainSnapshot(
        casInput(`mutation.valid.${label}`, current, state)
      );
      assert.equal(committed.outcome, "committed");
      const loaded = await fixture.surface.loadDomainSnapshot();
      assert.equal(loaded.snapshotRevision, state.generation);
      assert.equal(loaded.integrityDigest, committed.snapshot.integrityDigest);
      assert.equal(canonicalJson(loaded.state), canonicalJson(state));
      assert.deepEqual(await fs.readdir(fixture.sessionPath), sessionBefore);
      verify(loaded.state);
      current = loaded;
    }

    {
      const { thread, run } = deepClone(fullRecords());
      Object.assign(thread, {
        status: "running",
        revision: 3,
        updatedAt: DISPATCHED_AT,
        lastRunId: RUN_ID,
        messages: [],
      });
      Object.assign(run, {
        status: "starting",
        revision: 2,
        completedAt: null,
        cancelRequestedAt: DISPATCHED_AT,
        dispatchLeaseId: null,
        dispatchOutbox: false,
        dispatchedAt: null,
        processOwner: processOwner(),
        hidden: false,
        tombstone: false,
        abortAttemptDigest: null,
        abortAt: null,
        nativeStartReceipt: null,
        recoveryState: null,
        output: "",
        error: null,
      });
      run.authority.completionOutbox = null;
      await commitVariant(
        "starting-cancel-owner",
        domainStateFromRecords(fixture.surface, 1, { threads: [thread], runs: [run] }),
        (state) => {
          assert.equal(state.runs[0].status, "starting");
          assert.equal(state.runs[0].cancelRequestedAt, DISPATCHED_AT);
          assert.equal(state.runs[0].processOwner.token, "1".repeat(32));
          assert.equal(state.runs[0].dispatchLeaseId, null);
          assert.equal(state.runs[0].dispatchOutbox, false);
          assert.equal(state.runs[0].dispatchedAt, null);
        }
      );
    }

    {
      const { thread, run } = deepClone(fullRecords());
      Object.assign(thread, {
        status: "running",
        revision: 4,
        updatedAt: DISPATCHED_AT,
        lastRunId: RUN_ID,
        messages: [],
      });
      Object.assign(run, {
        status: "running",
        revision: 2,
        completedAt: null,
        cancelRequestedAt: null,
        nativeStartReceipt: null,
        recoveryState: null,
        output: "",
        error: null,
      });
      run.authority.completionOutbox = null;
      await commitVariant(
        "running-preauthorization",
        domainStateFromRecords(fixture.surface, 2, { threads: [thread], runs: [run] }),
        (state) => {
          assert.equal(state.runs[0].status, "running");
          assert.equal(state.runs[0].dispatchOutbox, true);
          assert.equal(state.runs[0].nativeStartReceipt, null);
          assert.equal(state.runs[0].recoveryState, null);
        }
      );
    }

    {
      const { thread, run } = deepClone(fullRecords());
      const owner = processOwner();
      const receipt = nativeStartReceipt(owner);
      const recoveryUnsigned = {
        schemaVersion: "aginti-native-start-recovery-v1",
        status: "recovery_hold",
        reason: "retained_descriptor_unavailable",
        authorizationId: receipt.authorizationId,
        authorizationDigest: receipt.authorizationDigest,
        sourceRunRevision: 3,
        appliedRunRevision: 4,
        heldAt: COMPLETED_AT,
        observedByProcessOwner: owner,
      };
      Object.assign(thread, {
        status: "running",
        revision: 6,
        updatedAt: COMPLETED_AT,
        lastRunId: RUN_ID,
        messages: [],
      });
      Object.assign(run, {
        status: "running",
        revision: 4,
        completedAt: null,
        cancelRequestedAt: null,
        processOwner: owner,
        nativeStartReceipt: receipt,
        recoveryState: {
          ...recoveryUnsigned,
          digest: independentDigest(recoveryUnsigned),
        },
        output: "",
        error: null,
      });
      run.authority.completionOutbox = null;
      await commitVariant(
        "running-recovery-hold",
        domainStateFromRecords(fixture.surface, 3, { threads: [thread], runs: [run] }),
        (state) => {
          const loadedRun = state.runs[0];
          assert.equal(loadedRun.nativeStartReceipt.authorizationDigest, receipt.authorizationDigest);
          assert.equal(loadedRun.recoveryState.status, "recovery_hold");
          assert.equal(loadedRun.recoveryState.sourceRunRevision, 3);
          assert.equal(loadedRun.recoveryState.appliedRunRevision, loadedRun.revision);
          assert.equal(
            loadedRun.recoveryState.digest,
            independentDigest(digestWithout(loadedRun.recoveryState, "digest"))
          );
        }
      );
    }

    {
      const { thread, run } = deepClone(fullRecords());
      Object.assign(thread, {
        status: "idle",
        revision: 7,
        updatedAt: COMPLETED_AT,
        lastRunId: null,
        messages: [],
      });
      Object.assign(run, {
        status: "aborted_before_launch",
        revision: 3,
        completedAt: null,
        cancelRequestedAt: COMPLETED_AT,
        hidden: true,
        tombstone: true,
        abortAttemptDigest: "9".repeat(64),
        abortAt: COMPLETED_AT,
        nativeStartReceipt: null,
        recoveryState: null,
        output: "",
        error: null,
      });
      run.authority.completionOutbox = null;
      await commitVariant(
        "dispatched-aborted-before-launch",
        domainStateFromRecords(fixture.surface, 4, { threads: [thread], runs: [run] }),
        (state) => {
          assert.equal(state.runs[0].status, "aborted_before_launch");
          assert.equal(state.runs[0].dispatchOutbox, true);
          assert.equal(state.runs[0].cancelRequestedAt, COMPLETED_AT);
          assert.equal(state.runs[0].hidden, true);
          assert.equal(state.runs[0].tombstone, true);
          assert.equal(state.threads[0].lastRunId, null);
          assert.equal(state.threads[0].status, "idle");
        }
      );
    }

    {
      const childRunId = "run_00000000-0000-4000-8000-000000000123";
      const owner = processOwner();
      const priorOutbox = completionOutboxRecord({
        outboxId: "outbox.repository.variant5.prior",
      });
      const childOutbox = completionOutboxRecord({
        outboxId: "outbox.repository.variant5.resume",
        runId: childRunId,
        createdAt: RESUME_COMPLETED_AT,
        expectedPreviousSeq: 1,
        expectedPreviousHash: priorOutbox.expectedEventHash,
      });
      const prior = deepClone(fullRecords().run);
      prior.authority.completionOutbox = completionMetadataFor({
        threadRevision: 6,
        outboxes: [priorOutbox],
      });
      const childReceipt = nativeStartReceiptFor({
        owner,
        mode: "resume",
        runId: childRunId,
        previousRunId: prior.id,
        previousRunRevision: prior.revision,
        previousRunRuntimeRevision: prior.authority.runtimeRevision,
        threadRevision: 9,
        createdAt: RESUME_CREATED_AT,
        dispatchedAt: RESUME_DISPATCHED_AT,
        expectedNativeRuntimeRevision: 7,
        targetNativeRuntimeRevision: 8,
        dispatchLeaseId: "b".repeat(64),
      });
      const child = deepClone(prior);
      Object.assign(child, {
        id: childRunId,
        previousRunId: prior.id,
        createdAt: RESUME_CREATED_AT,
        startedAt: RESUME_CREATED_AT,
        completedAt: RESUME_COMPLETED_AT,
        dispatchLeaseId: childReceipt.dispatchLeaseId,
        dispatchedAt: RESUME_DISPATCHED_AT,
        processOwner: owner,
        nativeStartReceipt: childReceipt,
        inputDigest: "b".repeat(64),
      });
      Object.assign(child.authority, {
        snapshotHash: "c".repeat(64),
        runtimeRevision: 8,
        completionOutbox: completionMetadataFor({
          runId: childRunId,
          completedAt: RESUME_COMPLETED_AT,
          runtimeRevision: 8,
          threadRevision: 10,
          outboxes: [childOutbox],
        }),
      });
      const thread = deepClone(fullRecords().thread);
      Object.assign(thread, {
        revision: 10,
        updatedAt: RESUME_COMPLETED_AT,
        lastRunId: childRunId,
        messages: [],
      });
      thread.authority.runtimeRevision = 8;
      await commitVariant(
        "resume-completed-lineage",
        domainStateFromRecords(fixture.surface, 5, {
          threads: [thread],
          runs: [prior, child],
          outboxEvents: [priorOutbox, childOutbox],
        }),
        (state) => {
          const [loadedPrior, loadedChild] = state.runs;
          assert.equal(loadedChild.previousRunId, loadedPrior.id);
          assert.equal(loadedChild.nativeStartReceipt.mode, "resume");
          assert.equal(
            loadedChild.nativeStartReceipt.previousRunRuntimeRevision,
            loadedPrior.authority.runtimeRevision
          );
          assert.equal(loadedChild.authority.runtimeRevision, 8);
          assert.equal(state.threads[0].lastRunId, loadedChild.id);
          assert.equal(
            loadedPrior.authority.completionOutbox.threadRevision < state.threads[0].revision,
            true
          );
        }
      );
    }

    {
      const outputOutbox = completionOutboxRecord({
        outboxId: "outbox.repository.variant6.01-output",
        type: "output.delta",
        payload: { text: "Completed safely." },
        delivered: true,
      });
      const terminal = completionOutboxRecord({
        outboxId: "outbox.repository.variant6.02-terminal",
        expectedPreviousSeq: 1,
        expectedPreviousHash: outputOutbox.expectedEventHash,
        delivered: true,
      });
      const { thread, run } = deepClone(fullRecords());
      thread.authority.lastCompaction = {
        compactedMessages: 2,
        tokensBefore: 120,
        tokensAfter: 40,
        digest: "d".repeat(64),
      };
      thread.replay = {
        prunedMessageCount: 2,
        anchorDigest: "e".repeat(64),
      };
      run.output = "Completed safely.";
      run.authority.completionOutbox = completionMetadataFor({
        outboxes: [outputOutbox, terminal],
      });
      await commitVariant(
        "delivered-output-compaction",
        domainStateFromRecords(fixture.surface, 6, {
          threads: [thread],
          runs: [run],
          outboxEvents: [outputOutbox, terminal],
        }),
        (state) => {
          assert.deepEqual(state.runs[0].authority.completionOutbox.eventTypes, [
            "output.delta",
            "run.completed",
          ]);
          assert.equal(state.outboxEvents.every((outbox) => outbox.delivered), true);
          assert.equal(state.outboxEvents.every((outbox) => outbox.deliveredEventDigest !== null), true);
          assert.equal(state.threads[0].authority.lastCompaction.compactedMessages, 2);
          assert.equal(state.threads[0].replay.prunedMessageCount, 2);
          assert.notEqual(state.threads[0].replay.anchorDigest, ZERO_DIGEST);
        }
      );
    }
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runSchemaAndInputAdversaries(fixture, current) {
  const { surface } = fixture;
  const baselineRaw = await fs.readFile(fixture.repositorySnapshotPath, "utf8");
  async function rejectPrepared(label, state) {
    await expectCode(
      () => surface.compareAndSwapDomainSnapshot(casInput(`mutation.invalid.${label}`, current.snapshot, state)),
      ["INTEGRATION_REPOSITORY_KERNEL_INVALID", "INTEGRATION_REPOSITORY_KERNEL_FULL"],
      fixture.rootPath
    );
    assert.equal(await fs.readFile(fixture.repositorySnapshotPath, "utf8"), baselineRaw);
  }
  async function invalidState(label, mutate) {
    const state = deepClone(current.snapshot.state);
    state.generation = current.snapshot.snapshotRevision + 1;
    mutate(state);
    await rejectPrepared(label, state);
  }

  await invalidState("binding", (state) => { state.repositoryPointerDigest = "f".repeat(64); });
  await invalidState("thread-crossref", (state) => { state.threads[0].lastRunId = "run_00000000-0000-4000-8000-000000000999"; });
  await invalidState("run-scope", (state) => { state.runs[0].browserSessionId = "b".repeat(64); });
  await invalidState("outbox-hash", (state) => { state.outboxEvents[0].expectedEventHash = "c".repeat(64); });
  await invalidState("outbox-delivery", (state) => {
    state.outboxEvents[0].delivered = true;
    state.outboxEvents[0].deliveredEventSeq = 1;
  });
  await invalidState("artifact-unsafe", (state) => {
    state.artifacts[0].spec.markdown = "[unsafe](https://example.test)";
  });
  await invalidState("artifact-publication", (state) => {
    state.artifacts[0].published = true;
    state.artifacts[0].publishedAt = null;
  });
  await invalidState("receipt-digest", (state) => { state.mutationReceipts[0].resultDigest = "d".repeat(64); });
  await invalidState("receipt-revision", (state) => { state.mutationReceipts[0].resultSnapshotRevision = 2; });
  await invalidState("extra-key", (state) => { state.threads[0].unsupported = true; });
  await invalidState("unsorted", (state) => { state.threads.push({ ...state.threads[0] }); });

  const symbolState = deepClone(current.snapshot.state);
  symbolState.generation = current.snapshot.snapshotRevision + 1;
  symbolState.threads[0][Symbol("hostile-own-key")] = true;
  await rejectPrepared("symbol-own-key", symbolState);

  const customRecordState = deepClone(current.snapshot.state);
  customRecordState.generation = current.snapshot.snapshotRevision + 1;
  Object.setPrototypeOf(customRecordState.runs[0].authority, { inherited: true });
  await rejectPrepared("custom-record-prototype", customRecordState);

  const customArrayState = deepClone(current.snapshot.state);
  customArrayState.generation = current.snapshot.snapshotRevision + 1;
  Object.setPrototypeOf(customArrayState.artifacts, Object.create(Array.prototype));
  await rejectPrepared("custom-array-prototype", customArrayState);

  const sparseArrayState = deepClone(current.snapshot.state);
  sparseArrayState.generation = current.snapshot.snapshotRevision + 1;
  delete sparseArrayState.artifacts[0];
  assert.equal(sparseArrayState.artifacts.length, 1);
  assert.equal(Object.hasOwn(sparseArrayState.artifacts, 0), false);
  await rejectPrepared("sparse-array", sparseArrayState);

  const nonEnumerableState = deepClone(current.snapshot.state);
  nonEnumerableState.generation = current.snapshot.snapshotRevision + 1;
  Object.defineProperty(nonEnumerableState.runs[0].authority, "kind", {
    configurable: true,
    enumerable: false,
    value: "aginti",
    writable: true,
  });
  await rejectPrepared("nested-nonenumerable", nonEnumerableState);

  let nestedAccessorHits = 0;
  const nestedAccessorState = deepClone(current.snapshot.state);
  nestedAccessorState.generation = current.snapshot.snapshotRevision + 1;
  Object.defineProperty(nestedAccessorState.runs[0].authority, "kind", {
    enumerable: true,
    get() {
      nestedAccessorHits += 1;
      throw new Error("nested authority getter must not run");
    },
  });
  await rejectPrepared("nested-accessor", nestedAccessorState);
  assert.equal(nestedAccessorHits, 0);

  let accessorHits = 0;
  const accessorInput = {
    mutationId: "mutation.invalid.accessor",
    expectedSnapshotRevision: current.snapshot.snapshotRevision,
    expectedIntegrityDigest: current.snapshot.integrityDigest,
  };
  Object.defineProperty(accessorInput, "state", {
    enumerable: true,
    get() {
      accessorHits += 1;
      throw new Error("state getter must not run");
    },
  });
  await expectCode(
    () => surface.compareAndSwapDomainSnapshot(accessorInput),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  assert.equal(accessorHits, 0);

  let proxyHits = 0;
  const proxyState = new Proxy(deepClone(current.snapshot.state), {
    ownKeys() {
      proxyHits += 1;
      throw new Error("state Proxy trap must not run");
    },
  });
  await expectCode(
    () => surface.compareAndSwapDomainSnapshot(casInput("mutation.invalid.proxy", current.snapshot, proxyState)),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  assert.equal(proxyHits, 0);

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const rejectedInput = Promise.reject(new Error("rejected CAS input"));
    await expectCode(
      () => surface.compareAndSwapDomainSnapshot(rejectedInput),
      "INTEGRATION_REPOSITORY_KERNEL_INVALID",
      fixture.rootPath
    );
    const nestedRejected = Promise.reject(new Error("rejected nested state"));
    await expectCode(
      () => surface.compareAndSwapDomainSnapshot(casInput("mutation.invalid.promise", current.snapshot, nestedRejected)),
      "INTEGRATION_REPOSITORY_KERNEL_INVALID",
      fixture.rootPath
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(await fs.readFile(fixture.repositorySnapshotPath, "utf8"), baselineRaw);
}

async function runConcurrentCasAndContinuation(rootPath) {
  const fixture = await openCombinedFixture(rootPath, "repository-state-concurrency");
  try {
    const zero = await fixture.surface.loadDomainSnapshot();
    const stateA = domainStateFor(fixture.surface, 1);
    const stateB = deepClone(stateA);
    stateB.threads[0].title = "Concurrent competitor";
    const outcomes = await Promise.allSettled([
      fixture.surface.compareAndSwapDomainSnapshot(casInput("mutation.concurrent.state.a", zero, stateA)),
      fixture.surface.compareAndSwapDomainSnapshot(casInput("mutation.concurrent.state.b", zero, stateB)),
    ]);
    assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(
      outcomes.find((entry) => entry.status === "rejected").reason.publicCode ||
        outcomes.find((entry) => entry.status === "rejected").reason.code,
      "INTEGRATION_REPOSITORY_KERNEL_CONFLICT"
    );
    const head = await fixture.surface.loadDomainSnapshot();
    assert.equal(head.snapshotRevision, 1);
    const continuedState = deepClone(head.state);
    continuedState.generation = 2;
    continuedState.threads[0].title = "Queue continued";
    const continued = await fixture.surface.compareAndSwapDomainSnapshot(
      casInput("mutation.concurrent.continued", head, continuedState)
    );
    assert.equal(continued.outcome, "committed");
    assert.equal(continued.snapshot.snapshotRevision, 2);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runArtifactDurabilityCapCheck(rootPath) {
  const fixture = await openCombinedFixture(rootPath, "repository-state-artifact-cap");
  try {
    assert.equal(INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_MAX_ARTIFACTS, 50_000);
    assert.equal(fixture.surface.attestation.maxArtifacts, 50_000);
    const zero = await fixture.surface.loadDomainSnapshot();
    const state = domainStateFor(fixture.surface, 1);
    const template = state.artifacts[0];
    state.artifacts = Array.from({ length: 33 }, (_, index) => ({
      ...deepClone(template),
      id: `art_${index.toString(16).padStart(64, "0")}`,
      title: `Artifact ${String(index).padStart(2, "0")}`,
    }));
    const committed = await fixture.surface.compareAndSwapDomainSnapshot(
      casInput("mutation.artifact.capacity.33", zero, state)
    );
    assert.equal(committed.outcome, "committed");
    assert.equal(committed.snapshot.state.artifacts.length, 33);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

function resealKernelEnvelope(parsed) {
  parsed.payloadDigest = independentDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_PAYLOAD_DIGEST_DOMAIN,
    payload: parsed.payload,
  });
  parsed.lastCommit.payloadDigest = parsed.payloadDigest;
  const stateDigest = independentStateDigest(parsed.payload);
  parsed.lastCommit.requestDigest = independentDigest({
    domain: INTEGRATION_RETAINED_NATIVE_SESSION_REPOSITORY_REQUEST_DIGEST_DOMAIN,
    mutationId: parsed.lastCommit.transactionId,
    expectedSnapshotRevision: parsed.lastCommit.baseSnapshotRevision,
    expectedIntegrityDigest: parsed.lastCommit.baseIntegrityDigest,
    resultGeneration: parsed.payload.generation,
    stateDigest,
  });
  parsed.lastCommit.commitDigest = independentDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(parsed.lastCommit, "commitDigest"),
  });
  parsed.integrityDigest = independentDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(parsed, "integrityDigest"),
  });
  return parsed;
}

async function runCorruptionAndRollbackChecks(smokeRoot) {
  const rollback = await openCombinedFixture(path.join(smokeRoot, "rollback"), "repository-state-rollback");
  try {
    const zero = await rollback.surface.loadDomainSnapshot();
    const first = await rollback.surface.compareAndSwapDomainSnapshot(
      casInput("mutation.rollback.state.1", zero, domainStateFor(rollback.surface, 1))
    );
    const firstRaw = await fs.readFile(rollback.repositorySnapshotPath, "utf8");
    const nextState = deepClone(first.snapshot.state);
    nextState.generation = 2;
    nextState.threads[0].title = "Rollback head";
    await rollback.surface.compareAndSwapDomainSnapshot(
      casInput("mutation.rollback.state.2", first.snapshot, nextState)
    );
    await fs.writeFile(rollback.repositorySnapshotPath, firstRaw, { mode: 0o600 });
    await expectCode(
      () => rollback.surface.loadDomainSnapshot(),
      "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
      rollback.rootPath
    );
    await expectCode(
      () => rollback.surface.loadDomainSnapshot(),
      "INTEGRATION_REPOSITORY_KERNEL_POISONED",
      rollback.rootPath
    );
  } finally {
    await rollback.authority.close().catch(() => {});
  }

  const semanticRoot = path.join(smokeRoot, "semantic-reseal");
  let semantic = await openCombinedFixture(semanticRoot, "repository-state-semantic");
  try {
    const zero = await semantic.surface.loadDomainSnapshot();
    await semantic.surface.compareAndSwapDomainSnapshot(
      casInput("mutation.semantic.state.1", zero, domainStateFor(semantic.surface, 1))
    );
    const parsed = JSON.parse(await fs.readFile(semantic.repositorySnapshotPath, "utf8"));
    parsed.payload.sessionStateNamespaceDigest = "f".repeat(64);
    resealKernelEnvelope(parsed);
    await fs.writeFile(semantic.repositorySnapshotPath, `${canonicalJson(parsed)}\n`, { mode: 0o600 });
    await semantic.authority.close();
    semantic = null;
    const reopened = await openCombinedFixture(semanticRoot, "repository-state-semantic");
    try {
      await expectCode(
        () => reopened.surface.loadDomainSnapshot(),
        "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
        semanticRoot
      );
      await expectCode(
        () => reopened.surface.loadDomainSnapshot(),
        "INTEGRATION_REPOSITORY_KERNEL_POISONED",
        semanticRoot
      );
    } finally {
      await reopened.authority.close().catch(() => {});
    }
  } finally {
    await semantic?.authority.close().catch(() => {});
  }
}

async function atomicResidue(rootPath) {
  const names = [];
  async function walk(directoryPath) {
    for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
      const absolute = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.startsWith(".aginti-atomic-v1-")) names.push(absolute);
    }
  }
  await walk(rootPath);
  return names.sort();
}

async function runFaultMode(mode) {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), `aginti-repository-state-${mode}-`));
  const rootPath = path.join(smokeRoot, "root");
  let fixture;
  try {
    fixture = await openCombinedFixture(rootPath, "repository-state-fault");
    const zero = await fixture.surface.loadDomainSnapshot();
    const state = emptyDomainStateFor(fixture.surface, 1);
    const input = casInput(`mutation.repository.fault.${mode}`, zero, state);
    fault.armed = true;
    const ambiguous = await expectCode(
      () => fixture.surface.compareAndSwapDomainSnapshot(input),
      "INTEGRATION_REPOSITORY_KERNEL_COMMIT_AMBIGUOUS",
      smokeRoot
    );
    assert.equal(fault.hits, 1);
    assert.equal(ambiguous.details.writeAttempted, true);
    assert.equal(ambiguous.details.commitMayHaveOccurred, true);
    await expectCode(
      () => fixture.surface.loadDomainSnapshot(),
      "INTEGRATION_REPOSITORY_KERNEL_POISONED",
      smokeRoot
    );
    const residue = await atomicResidue(rootPath);
    if (mode === "rename-before") {
      assert.equal(residue.length, 1);
      assert.match(path.basename(residue[0]), /^\.aginti-atomic-v1-[1-9][0-9]*-[a-f0-9]{32}$/u);
      const stat = await fs.lstat(residue[0], { bigint: true });
      assert.equal(stat.isFile(), true);
      assert.equal(stat.mode & 0o7777n, 0o600n);
      assert.equal(stat.uid, BigInt(UID));
      assert.equal(stat.gid, BigInt(GID));
      assert.equal(stat.nlink, 1n);
      assert.equal(stat.size > 0n, true);
      assert.equal(stat.size <= 512n * 1024n, true);
    } else {
      assert.deepEqual(residue, []);
    }
    await fixture.authority.close();
    fixture = null;
    const reopened = await openCombinedFixture(rootPath, "repository-state-fault");
    try {
      const current = await reopened.surface.loadDomainSnapshot();
      const reboundState = emptyDomainStateFor(reopened.surface, 1);
      const reboundInput = casInput(`mutation.repository.fault.${mode}`, {
        snapshotRevision: 0,
        integrityDigest: ZERO_DIGEST,
      }, reboundState);
      if (mode === "rename-before") {
        assert.equal(current.snapshotRevision, 0);
        const committed = await reopened.surface.compareAndSwapDomainSnapshot(reboundInput);
        assert.equal(committed.outcome, "committed");
      } else {
        assert.equal(current.snapshotRevision, 1);
        const replayed = await reopened.surface.compareAndSwapDomainSnapshot(reboundInput);
        assert.equal(replayed.outcome, "replayed");
      }
      assert.equal((await reopened.surface.loadDomainSnapshot()).snapshotRevision, 1);
    } finally {
      await reopened.authority.close().catch(() => {});
    }
  } finally {
    await fixture?.authority.close().catch(() => {});
    fsMock?.restore();
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write(`integration retained native-session repository-state ${mode} mock: ok\n`);
}

async function runCore() {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-repository-state-smoke-"));
  let fixture;
  try {
    fixture = await openCombinedFixture(path.join(smokeRoot, "main"));
    await runStaticBoundaryChecks(fixture.surface);
    await runSurfaceBindingAndHostilityChecks(fixture);
    const transition = await runCoreDomainChecks(fixture);
    await runSchemaAndInputAdversaries(fixture, transition.second);
    assert.deepEqual(await atomicResidue(fixture.rootPath), []);
    await fixture.authority.close();
    assert.equal(fixture.surface.isClosed(), true);
    await expectCode(
      () => fixture.surface.loadDomainSnapshot(),
      "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
      fixture.rootPath
    );
    fixture = null;

    await runValidVariantMatrix(path.join(smokeRoot, "valid-variants"));
    await runConcurrentCasAndContinuation(path.join(smokeRoot, "concurrency"));
    await runArtifactDurabilityCapCheck(path.join(smokeRoot, "artifact-cap"));
    await runCorruptionAndRollbackChecks(smokeRoot);
    for (const mode of FAULT_MODES) {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--experimental-test-module-mocks", fileURLToPath(import.meta.url), `--mock-mode=${mode}`],
        { timeout: 45_000, maxBuffer: 1024 * 1024 }
      );
      assert.match(stdout, new RegExp(`repository-state ${mode} mock: ok`, "u"));
    }
  } finally {
    await fixture?.authority.close().catch(() => {});
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write("integration retained native-session repository-state smoke: ok\n");
}

if (MODE) await runFaultMode(MODE);
else await runCore();
