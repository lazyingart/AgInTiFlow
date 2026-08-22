#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import { contractDigest } from "../src/integration-policy.js";

const execFileAsync = promisify(execFile);
const STATE_FILE_PREFIX_LITERAL = "native-session-state-";
const STATE_FILE_SUFFIX_LITERAL = ".json";
const LOCK_FILE_LITERAL = ".aginti-flock-v1-native-session-state";
const MODE = String(process.argv.find((value) => value.startsWith("--mock-mode=")) || "").slice(12);
const RECOVERY_ROOT = String(
  process.argv.find((value) => value.startsWith("--recovery-root=")) || ""
).slice(16);
const RECOVERY_MODE = String(
  process.argv.find((value) => value.startsWith("--recovery-mode=")) || ""
).slice(16);
const SPECIAL_MODE = String(
  process.argv.find((value) => value.startsWith("--special-mode=")) || ""
).slice(15);
const SPECIAL_ROOT = String(
  process.argv.find((value) => value.startsWith("--special-root=")) || ""
).slice(15);
const FAULT_MODES = Object.freeze([
  "prewrite",
  "rename-before",
  "rename-after",
  "directory-sync",
  "post-rename-recheck",
  "postwrite-read",
  "lock-release-commit",
  "lock-release-load",
  "compound-rename-lock-release",
  "compound-prewrite-lock-release",
]);
const fault = {
  armed: false,
  renameCompleted: false,
  failNextStateRead: false,
  failNextPostRenameLstat: false,
};
let fsMock = null;

function isStateFileTarget(target) {
  const base = path.basename(String(target));
  return base.startsWith(STATE_FILE_PREFIX_LITERAL) && base.endsWith(STATE_FILE_SUFFIX_LITERAL);
}

if (FAULT_MODES.includes(MODE)) {
  const { mock } = await import("node:test");
  const realFs = fs;
  const mockFs = { ...realFs };
  mockFs.rename = async (source, target) => {
    if (fault.armed && MODE === "rename-before" && isStateFileTarget(target)) {
      const error = new Error("synthetic retained state rename-before failure");
      error.code = "EIO";
      throw error;
    }
    await realFs.rename(source, target);
    if (fault.armed && isStateFileTarget(target)) {
      fault.renameCompleted = true;
      if (MODE === "rename-after" || MODE === "compound-rename-lock-release") {
        const error = new Error("synthetic retained state rename-after ambiguity");
        error.code = "EIO";
        throw error;
      }
      if (MODE === "post-rename-recheck") fault.failNextPostRenameLstat = true;
      if (MODE === "postwrite-read") fault.failNextStateRead = true;
    }
  };
  mockFs.lstat = async (target, ...args) => {
    if (fault.failNextPostRenameLstat && isStateFileTarget(target)) {
      fault.failNextPostRenameLstat = false;
      const error = new Error("synthetic retained state post-rename recheck failure");
      error.code = "EIO";
      throw error;
    }
    return realFs.lstat(target, ...args);
  };
  mockFs.open = async (target, flags, ...args) => {
    const targetText = String(target);
    if (
      fault.armed && (MODE === "prewrite" || MODE === "compound-prewrite-lock-release") &&
      targetText.includes(".aginti-atomic-v1-")
    ) {
      if (MODE === "prewrite") fault.armed = false;
      const error = new Error("synthetic retained state prewrite failure");
      error.code = "EIO";
      throw error;
    }
    if (fault.failNextStateRead && isStateFileTarget(targetText)) {
      fault.failNextStateRead = false;
      const error = new Error("synthetic retained state postwrite read failure");
      error.code = "EIO";
      throw error;
    }
    const handle = await realFs.open(target, flags, ...args);
    const base = path.basename(targetText);
    if (base === "native:sessions") {
      return Object.freeze(Object.assign(Object.create(null), {
        get fd() { return handle.fd; },
        stat: (...statArgs) => handle.stat(...statArgs),
        close: () => handle.close(),
        sync: async () => {
          if (fault.armed && MODE === "directory-sync" && fault.renameCompleted) {
            const error = new Error("synthetic retained state directory sync failure");
            error.code = "EIO";
            throw error;
          }
          return handle.sync();
        },
      }));
    }
    if (
      fault.armed && base === LOCK_FILE_LITERAL &&
      (
        MODE === "lock-release-commit" || MODE === "lock-release-load" ||
        MODE === "compound-rename-lock-release" || MODE === "compound-prewrite-lock-release"
      )
    ) {
      return Object.freeze(Object.assign(Object.create(null), {
        get fd() { return handle.fd; },
        stat: (...statArgs) => handle.stat(...statArgs),
        close: async () => {
          await handle.close();
          if (fault.armed) {
            fault.armed = false;
            const error = new Error("synthetic retained state lock close ambiguity");
            error.code = "EIO";
            throw error;
          }
        },
      }));
    }
    return handle;
  };
  fsMock = mock.module("node:fs/promises", { defaultExport: mockFs });
}

const [storeApi, storageApi, durableApi] = await Promise.all([
  import(new URL("../src/integration-retained-session-state-store.js", import.meta.url).href),
  import(new URL("../src/integration-storage-authority.js", import.meta.url).href),
  import(new URL("../src/integration-durable-common.js", import.meta.url).href),
]);

const {
  INTEGRATION_RETAINED_SESSION_STATE_ENVELOPE_INTEGRITY_DOMAIN,
  INTEGRATION_RETAINED_SESSION_STATE_FILE_NAME_DOMAIN,
  INTEGRATION_RETAINED_SESSION_STATE_FILE_PREFIX,
  INTEGRATION_RETAINED_SESSION_STATE_FILE_SUFFIX,
  INTEGRATION_RETAINED_SESSION_STATE_LAST_MUTATION_INTEGRITY_DOMAIN,
  INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
  INTEGRATION_RETAINED_SESSION_STATE_MAX_JSON_DEPTH,
  INTEGRATION_RETAINED_SESSION_STATE_MAX_JSON_NODES,
  INTEGRATION_RETAINED_SESSION_STATE_PAYLOAD_DIGEST_DOMAIN,
  INTEGRATION_RETAINED_SESSION_STATE_POINTER_DOMAIN,
  INTEGRATION_RETAINED_SESSION_STATE_REQUEST_DIGEST_DOMAIN,
  INTEGRATION_RETAINED_SESSION_STATE_STORE_LIMITATIONS,
  INTEGRATION_RETAINED_SESSION_STATE_STORE_VERSION,
  assertRetainedIntegrationSessionStateStore,
  createRetainedIntegrationSessionStateStore,
} = storeApi;
const { INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE } = durableApi;

const UID = process.getuid();
const GID = process.getgid();
const HELPER_PATH = "/usr/bin/flock";
const ZERO_DIGEST = "0".repeat(64);
const SURFACE_KEYS = Object.freeze([
  "schemaVersion",
  "attestation",
  "loadSessionSnapshot",
  "compareAndSwapSessionSnapshot",
  "isClosed",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "pointerDigest",
  "nativeSessionId",
  "fileName",
  "persistenceRevision",
  "runtimeRevision",
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
  "basePersistenceRevision",
  "baseIntegrityDigest",
  "baseRuntimeRevision",
  "resultPersistenceRevision",
  "resultRuntimeRevision",
  "stateDigest",
  "mutationDigest",
]);
const SAVE_RESULT_KEYS = Object.freeze(["outcome", "snapshot"]);
const ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "preEnableStorageKernel",
  "runtimeCapabilityEnabled",
  "runtimeWiringIncluded",
  "nativeSessionStoreSurface",
  "runtimeSessionStoreSurface",
  "runtimeRecoveryIntegration",
  "dispatchIntegration",
  "fullSessionStateSchemaValidation",
  "canonicalStateValidation",
  "topLevelSessionIdBinding",
  "flatDigestNamedFiles",
  "rawSessionIdInFileName",
  "globalStoreLock",
  "boundedInProcessFifo",
  "compareAndSwap",
  "persistenceRevisionExactlyOne",
  "initialRuntimeRevisionExactlyOne",
  "runtimeRevisionSameOrNext",
  "exactLastMutationReplay",
  "postWriteReloadVerification",
  "storageLifecycleOwned",
  "fileNameDomain",
  "fileNamePrefix",
  "fileNameSuffix",
  "lockFileNameDigest",
  "logicalNamespaceDigest",
  "admissionBindingDigest",
  "maxStateBytes",
  "maxJsonDepth",
  "maxJsonNodes",
  "maxPendingOperations",
  "maxPendingPayloadBytes",
  "maxPendingPayloadNodes",
  "maxTransientNormalizationBytes",
  "maxTransientNormalizationNodes",
  "lockWaitMs",
  "limitations",
  "digest",
]);

function nullRecord(fields) {
  return Object.freeze(Object.assign(Object.create(null), fields));
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
    await fs.lstat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.writeFile(filePath, "", { mode: 0o600 });
  }
  await fs.chmod(filePath, 0o600);
  await fs.chown(filePath, UID, GID);
}

async function openFixture(
  rootPath,
  role,
  { maxStateBytes = 256 * 1024, lockWaitMs = 2000 } = {}
) {
  const relativeSegments = Object.freeze(["native:sessions"]);
  const dataPath = path.join(rootPath, ...relativeSegments);
  const lockPath = path.join(dataPath, INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE);
  await ensureOwnerDirectory(rootPath);
  await ensureOwnerDirectory(dataPath);
  await ensureLockFile(lockPath);
  const authority = await storageApi.openIntegrationStorageAuthority({
    rootPath,
    role,
    ownerUid: UID,
    ownerGid: GID,
    label: "retained native-session state smoke",
  });
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
  const helperSha256 = crypto.createHash("sha256").update(await fs.readFile(HELPER_PATH)).digest("hex");
  const helperIdentityDigest = identityDigest(await fs.stat(HELPER_PATH, { bigint: true }));
  const lockFileIdentityDigest = identityDigest(await fs.stat(lockPath, { bigint: true }));
  const lockExpected = Object.freeze({
    ...directoryExpected,
    lockFileName: INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
    helperSha256,
    lockFileIdentityDigest,
    helperIdentityDigest,
  });
  const expected = Object.freeze({
    ...directoryExpected,
    lockFileIdentityDigest,
    helperSha256,
    helperIdentityDigest,
    maxStateBytes,
    lockWaitMs,
  });
  const lock = await storageApi.openIntegrationRetainedRegularFileLock(files, lockExpected);
  return Object.freeze({
    authority,
    directory,
    files,
    lock,
    lockExpected,
    expected,
    dataPath,
    lockPath,
    rootPath,
    role,
  });
}

function sessionState(nativeSessionId, runtimeRevision, marker, extra = Object.create(null)) {
  return nullRecord({
    sessionId: nativeSessionId,
    meta: nullRecord({ runtimeConfig: nullRecord({ revision: runtimeRevision }) }),
    marker,
    ...extra,
  });
}

function saveInput(mutationId, current, state) {
  return Object.freeze({
    mutationId,
    nativeSessionId: state.sessionId,
    expectedPersistenceRevision: current.persistenceRevision,
    expectedIntegrityDigest: current.integrityDigest,
    state,
  });
}

function publicErrorText(error) {
  return JSON.stringify({
    code: error?.publicCode || error?.code || "",
    message: error?.message || "",
    details: error?.details || {},
  });
}

async function expectCode(action, expectedCode, forbiddenRoot = "") {
  let captured;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  assert.ok(captured, `Expected ${expectedCode}, but operation completed.`);
  assert.equal(captured.publicCode || captured.code, expectedCode, publicErrorText(captured));
  const exposed = publicErrorText(captured);
  assert.equal(exposed.includes("/proc/self/fd"), false);
  assert.equal(exposed.includes(HELPER_PATH), false);
  assert.equal(/"fd"\s*:/u.test(exposed), false);
  if (forbiddenRoot) assert.equal(exposed.includes(forbiddenRoot), false);
  return captured;
}

function assertExactFrozenNullFields(value, keys) {
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual([...Reflect.ownKeys(value)].sort(), [...keys].sort());
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.equal(descriptor?.enumerable, true);
    assert.equal(descriptor?.configurable, false);
    assert.equal(descriptor?.writable, false);
    assert.equal(Object.prototype.hasOwnProperty.call(descriptor || {}, "value"), true);
  }
}

function canonicalSortedJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalSortedJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalSortedJson(value[key])}`
  )).join(",")}}`;
}

function canonicalNullPrototypeJson(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalNullPrototypeJson(item));
  const clone = Object.create(null);
  for (const key of Object.keys(value).sort()) clone[key] = canonicalNullPrototypeJson(value[key]);
  return clone;
}

async function assertNoAtomicResidue(dataPath) {
  const names = await fs.readdir(dataPath);
  assert.deepEqual(names.filter((name) => name.startsWith(".aginti-atomic-v1-")), []);
}

async function assertFaultAtomicResidue(dataPath, mode, maxStateBytes, expectedNames = null) {
  const names = (await fs.readdir(dataPath))
    .filter((name) => name.startsWith(".aginti-atomic-v1-"))
    .sort();
  if (mode !== "rename-before") {
    assert.deepEqual(names, []);
    if (expectedNames) assert.deepEqual(names, expectedNames);
    return names;
  }
  assert.equal(names.length, 1);
  assert.match(names[0], /^\.aginti-atomic-v1-[1-9][0-9]*-[a-f0-9]{32}$/u);
  if (expectedNames) assert.deepEqual(names, expectedNames);
  const stat = await fs.lstat(path.join(dataPath, names[0]), { bigint: true });
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o7777n, 0o600n);
  assert.equal(stat.uid, BigInt(UID));
  assert.equal(stat.gid, BigInt(GID));
  assert.equal(stat.nlink, 1n);
  assert.equal(stat.size > 0n, true);
  assert.equal(stat.size <= BigInt(maxStateBytes), true);
  return names;
}

function digestWithout(value, omittedKey) {
  const unsigned = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (key !== omittedKey) unsigned[key] = value[key];
  }
  return unsigned;
}

function verifyPersistedSnapshot(raw, snapshot, expected, previousSnapshot) {
  const parsed = JSON.parse(raw);
  assert.deepEqual(
    canonicalNullPrototypeJson(parsed),
    canonicalNullPrototypeJson(snapshot)
  );
  assert.equal(raw, `${canonicalSortedJson(parsed)}\n`);
  assert.equal(raw, `${canonicalSortedJson(snapshot)}\n`);
  assert.equal(parsed.fileName, `${INTEGRATION_RETAINED_SESSION_STATE_FILE_PREFIX}${contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_FILE_NAME_DOMAIN,
    nativeSessionId: parsed.nativeSessionId,
  })}${INTEGRATION_RETAINED_SESSION_STATE_FILE_SUFFIX}`);
  assert.equal(parsed.pointerDigest, contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_POINTER_DOMAIN,
    schemaVersion: parsed.schemaVersion,
    role: expected.role,
    canonicalPath: expected.canonicalPath,
    relativeSegments: expected.relativeSegments,
    nativeSessionId: parsed.nativeSessionId,
    fileName: parsed.fileName,
  }));
  assert.equal(parsed.persistenceRevision, previousSnapshot.persistenceRevision + 1);
  assert.equal(parsed.previousIntegrityDigest, previousSnapshot.integrityDigest);
  assert.equal(parsed.lastMutation.basePersistenceRevision, previousSnapshot.persistenceRevision);
  assert.equal(parsed.lastMutation.baseIntegrityDigest, previousSnapshot.integrityDigest);
  assert.equal(parsed.lastMutation.baseRuntimeRevision, previousSnapshot.runtimeRevision);
  assert.equal(parsed.stateDigest, contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_PAYLOAD_DIGEST_DOMAIN,
    nativeSessionId: parsed.nativeSessionId,
    state: parsed.state,
  }));
  assert.equal(parsed.lastMutation.requestDigest, contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_REQUEST_DIGEST_DOMAIN,
    mutationId: parsed.lastMutation.mutationId,
    nativeSessionId: parsed.nativeSessionId,
    expectedPersistenceRevision: parsed.lastMutation.basePersistenceRevision,
    expectedIntegrityDigest: parsed.lastMutation.baseIntegrityDigest,
    runtimeRevision: parsed.lastMutation.resultRuntimeRevision,
    stateDigest: parsed.lastMutation.stateDigest,
  }));
  assert.equal(parsed.lastMutation.mutationDigest, contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_LAST_MUTATION_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(parsed.lastMutation, "mutationDigest"),
  }));
  assert.equal(parsed.integrityDigest, contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_ENVELOPE_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(parsed, "integrityDigest"),
  }));
}

function resealLastMutation(parsed) {
  parsed.lastMutation.stateDigest = parsed.stateDigest;
  parsed.lastMutation.requestDigest = contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_REQUEST_DIGEST_DOMAIN,
    mutationId: parsed.lastMutation.mutationId,
    nativeSessionId: parsed.nativeSessionId,
    expectedPersistenceRevision: parsed.lastMutation.basePersistenceRevision,
    expectedIntegrityDigest: parsed.lastMutation.baseIntegrityDigest,
    runtimeRevision: parsed.lastMutation.resultRuntimeRevision,
    stateDigest: parsed.lastMutation.stateDigest,
  });
  parsed.lastMutation.mutationDigest = contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_LAST_MUTATION_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(parsed.lastMutation, "mutationDigest"),
  });
}

function resealEnvelope(parsed, { resealReceipt = true } = {}) {
  parsed.stateDigest = contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_PAYLOAD_DIGEST_DOMAIN,
    nativeSessionId: parsed.nativeSessionId,
    state: parsed.state,
  });
  if (resealReceipt) resealLastMutation(parsed);
  parsed.integrityDigest = contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_ENVELOPE_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(parsed, "integrityDigest"),
  });
}

async function writeCanonicalEnvelope(filePath, parsed) {
  await fs.writeFile(filePath, `${canonicalSortedJson(parsed)}\n`, { mode: 0o600 });
}

async function runSurfaceAndTransitionChecks(fixture, store) {
  assertExactFrozenNullFields(store, SURFACE_KEYS);
  assertExactFrozenNullFields(store.attestation, ATTESTATION_KEYS);
  assert.equal(store.attestation.digest, contractDigest(digestWithout(store.attestation, "digest")));
  assert.equal(store.attestation.maxStateBytes, fixture.expected.maxStateBytes);
  assert.equal(store.attestation.lockWaitMs, fixture.expected.lockWaitMs);
  assert.equal(store.schemaVersion, INTEGRATION_RETAINED_SESSION_STATE_STORE_VERSION);
  assert.equal(store.attestation.runtimeCapabilityEnabled, false);
  assert.equal(store.attestation.runtimeWiringIncluded, false);
  assert.equal(store.attestation.fullSessionStateSchemaValidation, false);
  assert.equal(store.attestation.canonicalStateValidation, true);
  assert.equal(store.attestation.topLevelSessionIdBinding, true);
  assert.equal(store.attestation.initialRuntimeRevisionExactlyOne, true);
  assert.equal(store.attestation.limitations, INTEGRATION_RETAINED_SESSION_STATE_STORE_LIMITATIONS);
  assert.equal(store.attestation.limitations.forwardRevisionGapsAccepted, true);
  assert.equal(store.attestation.limitations.forwardGapLineageVerification, false);
  assert.equal(store.attestation.limitations.inputOwnKeyEnumerationTransientMemoryBounded, false);
  assert.equal(store.attestation.limitations.protectedReadRawUtf8StringMayCoexistWithParsedEnvelope, true);
  assert.equal(store.attestation.limitations.jsonParseInputByteBoundedByMaxStateBytes, true);
  assert.equal(store.attestation.limitations.jsonParseTransientNodeAllocationBoundedByMaxJsonNodes, false);
  assert.equal(store.attestation.limitations.oneActiveCanonicalSnapshotSerializationMayBeAdditional, true);
  assert.equal(store.attestation.limitations.crashMayLeaveReservedTemp, true);
  assert.equal(store.attestation.limitations.renameIssuedAmbiguityMayLeaveReservedTemp, true);
  assert.equal(store.attestation.limitations.reservedTempMayContainFullSnapshot, true);
  assert.equal(store.attestation.limitations.automaticTempRecovery, false);
  assert.equal(store.attestation.limitations.missingLoadsRetainedInObservedSessionMap, false);
  assert.equal(store.attestation.limitations.singleSessionFailurePoisonsEntireStoreSurface, true);
  assert.equal(store.attestation.nativeSessionStoreSurface, false);
  assert.equal(store.attestation.runtimeSessionStoreSurface, false);
  assert.equal(store.attestation.runtimeRecoveryIntegration, false);
  assert.equal(store.attestation.dispatchIntegration, false);
  assert.equal(assertRetainedIntegrationSessionStateStore(store, fixture.expected), store);
  const forged = Object.freeze(Object.assign(Object.create(null), {
    schemaVersion: store.schemaVersion,
    attestation: store.attestation,
    loadSessionSnapshot: store.loadSessionSnapshot,
    compareAndSwapSessionSnapshot: store.compareAndSwapSessionSnapshot,
    isClosed: store.isClosed,
  }));
  await expectCode(
    () => assertRetainedIntegrationSessionStateStore(forged, fixture.expected),
    "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE",
    fixture.rootPath
  );
  let surfaceProxyHits = 0;
  const proxiedSurface = new Proxy(store, {
    get() { surfaceProxyHits += 1; throw new Error("surface proxy get trap"); },
    ownKeys() { surfaceProxyHits += 1; throw new Error("surface proxy ownKeys trap"); },
  });
  await expectCode(
    () => assertRetainedIntegrationSessionStateStore(proxiedSurface, fixture.expected),
    "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE",
    fixture.rootPath
  );
  assert.equal(surfaceProxyHits, 0);
  await expectCode(
    () => assertRetainedIntegrationSessionStateStore(store, nullRecord({
      ...fixture.expected,
      role: `${fixture.expected.role}-wrong`,
    })),
    "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE",
    fixture.rootPath
  );
  await expectCode(
    () => createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected),
    "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE",
    fixture.rootPath
  );
  await expectCode(() => store.loadSessionSnapshot(), "INTEGRATION_SESSION_STATE_STORE_INVALID", fixture.rootPath);
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(),
    "INTEGRATION_SESSION_STATE_STORE_INVALID",
    fixture.rootPath
  );

  const nativeSessionId = "aginti:session-smoke-a";
  const zero = await store.loadSessionSnapshot(nativeSessionId);
  assertExactFrozenNullFields(zero, SNAPSHOT_KEYS);
  assert.equal(zero.persistenceRevision, 0);
  assert.equal(zero.runtimeRevision, 0);
  assert.equal(zero.integrityDigest, ZERO_DIGEST);
  assert.equal(zero.state, null);

  await expectCode(
    () => store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.initial.runtime.two",
      zero,
      sessionState(nativeSessionId, 2, "invalid-initial")
    )),
    "INTEGRATION_SESSION_STATE_STORE_CONFLICT",
    fixture.rootPath
  );

  const firstInput = saveInput(
    "mutation.session.0001",
    zero,
    sessionState(nativeSessionId, 1, "first", JSON.parse('{"__proto__":{"safe":true}}'))
  );
  const first = await store.compareAndSwapSessionSnapshot(firstInput);
  assertExactFrozenNullFields(first, SAVE_RESULT_KEYS);
  assert.equal(first.outcome, "committed");
  assert.equal(first.snapshot.persistenceRevision, 1);
  assert.equal(first.snapshot.runtimeRevision, 1);
  assert.equal(first.snapshot.previousIntegrityDigest, ZERO_DIGEST);
  assert.equal(first.snapshot.lastMutation.basePersistenceRevision, 0);
  assert.equal(first.snapshot.lastMutation.baseRuntimeRevision, 0);
  assert.equal(first.snapshot.lastMutation.resultRuntimeRevision, 1);
  assertExactFrozenNullFields(first.snapshot, SNAPSHOT_KEYS);
  assertExactFrozenNullFields(first.snapshot.lastMutation, LAST_MUTATION_KEYS);
  assert.equal(Object.prototype.hasOwnProperty.call(first.snapshot.state, "__proto__"), true);
  assert.equal({}.safe, undefined);

  const replay = await store.compareAndSwapSessionSnapshot(firstInput);
  assertExactFrozenNullFields(replay, SAVE_RESULT_KEYS);
  assert.equal(replay.outcome, "replayed");
  assert.equal(replay.snapshot.integrityDigest, first.snapshot.integrityDigest);
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(Object.freeze({
      ...firstInput,
      state: sessionState(nativeSessionId, 1, "mutation-id-reused"),
    })),
    "INTEGRATION_SESSION_STATE_STORE_MUTATION_CONFLICT",
    fixture.rootPath
  );

  const secondInput = saveInput(
    "mutation.session.0002",
    first.snapshot,
    sessionState(nativeSessionId, 1, "same-runtime-new-persistence")
  );
  const second = await store.compareAndSwapSessionSnapshot(secondInput);
  assertExactFrozenNullFields(second, SAVE_RESULT_KEYS);
  assert.equal(second.snapshot.persistenceRevision, 2);
  assert.equal(second.snapshot.runtimeRevision, 1);
  const thirdInput = saveInput(
    "mutation.session.0003",
    second.snapshot,
    sessionState(nativeSessionId, 2, "next-runtime")
  );
  const third = await store.compareAndSwapSessionSnapshot(thirdInput);
  assertExactFrozenNullFields(third, SAVE_RESULT_KEYS);
  assert.equal(third.snapshot.persistenceRevision, 3);
  assert.equal(third.snapshot.runtimeRevision, 2);
  assert.equal(third.snapshot.lastMutation.baseRuntimeRevision, 1);
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.runtime.jump.invalid",
      third.snapshot,
      sessionState(nativeSessionId, 4, "runtime-jump")
    )),
    "INTEGRATION_SESSION_STATE_STORE_CONFLICT",
    fixture.rootPath
  );
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.runtime.rollback",
      third.snapshot,
      sessionState(nativeSessionId, 1, "runtime-rollback")
    )),
    "INTEGRATION_SESSION_STATE_STORE_CONFLICT",
    fixture.rootPath
  );
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(Object.freeze({
      mutationId: "mutation.identity.mismatch",
      nativeSessionId,
      expectedPersistenceRevision: third.snapshot.persistenceRevision,
      expectedIntegrityDigest: third.snapshot.integrityDigest,
      state: sessionState("aginti:different-session", 2, "wrong-id"),
    })),
    "INTEGRATION_SESSION_STATE_STORE_INVALID",
    fixture.rootPath
  );
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.stale.session",
      first.snapshot,
      sessionState(nativeSessionId, 1, "stale")
    )),
    "INTEGRATION_SESSION_STATE_STORE_CONFLICT",
    fixture.rootPath
  );

  const raw = await fs.readFile(path.join(fixture.dataPath, third.snapshot.fileName), "utf8");
  verifyPersistedSnapshot(raw, third.snapshot, fixture.expected, second.snapshot);
  assert.match(
    third.snapshot.fileName,
    new RegExp(`^${INTEGRATION_RETAINED_SESSION_STATE_FILE_PREFIX}[a-f0-9]{64}\\${INTEGRATION_RETAINED_SESSION_STATE_FILE_SUFFIX}$`, "u")
  );
  assert.equal(third.snapshot.fileName.includes(nativeSessionId), false);
  assert.equal(third.snapshot.fileName, `${INTEGRATION_RETAINED_SESSION_STATE_FILE_PREFIX}${contractDigest({
    domain: INTEGRATION_RETAINED_SESSION_STATE_FILE_NAME_DOMAIN,
    nativeSessionId,
  })}${INTEGRATION_RETAINED_SESSION_STATE_FILE_SUFFIX}`);
  const names = await fs.readdir(fixture.dataPath);
  assert.deepEqual(names.filter((name) => name.startsWith(INTEGRATION_RETAINED_SESSION_STATE_FILE_PREFIX)), [
    third.snapshot.fileName,
  ]);
  assert.deepEqual(names.filter((name) => name.startsWith(".aginti-atomic-v1-")), []);
  assert.equal(names.some((name) => name === nativeSessionId), false);
  return Object.freeze({ nativeSessionId, head: third.snapshot, replayInput: thirdInput });
}

async function runInvalidAndPromiseChecks(fixture, store, nativeSessionId, head) {
  let proxyHits = 0;
  const proxy = new Proxy({}, {
    get() { proxyHits += 1; throw new Error("proxy get trap"); },
    ownKeys() { proxyHits += 1; throw new Error("proxy ownKeys trap"); },
  });
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(proxy),
    "INTEGRATION_SESSION_STATE_STORE_INVALID",
    fixture.rootPath
  );
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.nested.proxy",
      head,
      sessionState(nativeSessionId, head.runtimeRevision, "proxy", { nested: proxy })
    )),
    "INTEGRATION_SESSION_STATE_STORE_INVALID",
    fixture.rootPath
  );
  assert.equal(proxyHits, 0);

  let getterHits = 0;
  const accessorState = sessionState(nativeSessionId, head.runtimeRevision, "accessor");
  const mutableAccessorState = { ...accessorState };
  Object.defineProperty(mutableAccessorState, "secret", {
    enumerable: true,
    get() { getterHits += 1; throw new Error("private getter"); },
  });
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(saveInput("mutation.state.accessor", head, mutableAccessorState)),
    "INTEGRATION_SESSION_STATE_STORE_INVALID",
    fixture.rootPath
  );
  assert.equal(getterHits, 0);

  for (const bad of [Number.NaN, -0, undefined, 1n, Symbol("bad"), new Date(0)]) {
    await expectCode(
      () => store.compareAndSwapSessionSnapshot(saveInput(
        "mutation.invalid.value",
        head,
        sessionState(nativeSessionId, head.runtimeRevision, "invalid", { bad })
      )),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
  }
  const cycle = {};
  cycle.self = cycle;
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.invalid.cycle",
      head,
      sessionState(nativeSessionId, head.runtimeRevision, "cycle", { cycle })
    )),
    "INTEGRATION_SESSION_STATE_STORE_INVALID",
    fixture.rootPath
  );
  const malformedStates = [
    null,
    [],
    "not-an-object",
    nullRecord({
      sessionId: nativeSessionId,
      marker: "missing-meta",
    }),
    nullRecord({
      sessionId: nativeSessionId,
      meta: null,
      marker: "null-meta",
    }),
    nullRecord({
      sessionId: nativeSessionId,
      meta: nullRecord({}),
      marker: "missing-runtime-config",
    }),
    nullRecord({
      sessionId: nativeSessionId,
      meta: nullRecord({ runtimeConfig: [] }),
      marker: "array-runtime-config",
    }),
    nullRecord({
      sessionId: nativeSessionId,
      meta: nullRecord({ runtimeConfig: nullRecord({ revision: 0 }) }),
      marker: "zero-runtime-revision",
    }),
    nullRecord({
      sessionId: nativeSessionId,
      meta: nullRecord({ runtimeConfig: nullRecord({ revision: 1.5 }) }),
      marker: "fractional-runtime-revision",
    }),
  ];
  for (let index = 0; index < malformedStates.length; index += 1) {
    await expectCode(
      () => store.compareAndSwapSessionSnapshot(Object.freeze({
        mutationId: `mutation.malformed.state.${String(index).padStart(4, "0")}`,
        nativeSessionId,
        expectedPersistenceRevision: head.persistenceRevision,
        expectedIntegrityDigest: head.integrityDigest,
        state: malformedStates[index],
      })),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
  }
  const sparse = [];
  sparse[1] = "present";
  const symbolState = sessionState(nativeSessionId, head.runtimeRevision, "symbol-key");
  const mutableSymbolState = { ...symbolState };
  mutableSymbolState[Symbol("unsupported")] = true;
  for (const [mutationId, state] of [
    ["mutation.invalid.sparse-array", sessionState(nativeSessionId, head.runtimeRevision, "sparse", { sparse })],
    ["mutation.invalid.symbol-key", mutableSymbolState],
    ["mutation.invalid.function", sessionState(nativeSessionId, head.runtimeRevision, "function", {
      callback() {},
    })],
  ]) {
    await expectCode(
      () => store.compareAndSwapSessionSnapshot(saveInput(mutationId, head, state)),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
  }
  const validInput = saveInput(
    "mutation.exact.input.valid",
    head,
    sessionState(nativeSessionId, head.runtimeRevision, "exact-input")
  );
  const missingState = { ...validInput };
  delete missingState.state;
  for (const malformedInput of [
    Object.freeze({ ...validInput, unsupported: true }),
    Object.freeze(missingState),
    Object.freeze({ ...validInput, mutationId: "too-short" }),
    Object.freeze({ ...validInput, expectedPersistenceRevision: -1 }),
    Object.freeze({ ...validInput, expectedPersistenceRevision: 1.5 }),
    Object.freeze({ ...validInput, expectedIntegrityDigest: "not-a-digest" }),
    Object.freeze({ ...validInput, expectedPersistenceRevision: 0 }),
    Object.freeze({ ...validInput, expectedIntegrityDigest: ZERO_DIGEST }),
  ]) {
    await expectCode(
      () => store.compareAndSwapSessionSnapshot(malformedInput),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
  }
  let deep = { leaf: true };
  for (let index = 0; index <= INTEGRATION_RETAINED_SESSION_STATE_MAX_JSON_DEPTH; index += 1) {
    deep = { nested: deep };
  }
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.full.depth",
      head,
      sessionState(nativeSessionId, head.runtimeRevision, "deep", { deep })
    )),
    "INTEGRATION_SESSION_STATE_STORE_FULL",
    fixture.rootPath
  );

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const rejectedLoadId = Promise.reject(new Error("benign rejected load id"));
    await expectCode(
      () => store.loadSessionSnapshot(rejectedLoadId),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
    const rejectedInput = Promise.reject(new Error("benign rejected input"));
    await expectCode(
      () => store.compareAndSwapSessionSnapshot(rejectedInput),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
    const rejectedNested = Promise.reject(new Error("benign rejected nested state"));
    await expectCode(
      () => store.compareAndSwapSessionSnapshot(saveInput(
        "mutation.rejected.nested",
        head,
        sessionState(nativeSessionId, head.runtimeRevision, "promise", { rejectedNested })
      )),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
    for (const field of [
      "mutationId",
      "nativeSessionId",
      "expectedPersistenceRevision",
      "expectedIntegrityDigest",
      "state",
    ]) {
      const rejectedField = Promise.reject(new Error(`benign rejected compare field ${field}`));
      await expectCode(
        () => store.compareAndSwapSessionSnapshot(Object.freeze({
          ...validInput,
          [field]: rejectedField,
        })),
        "INTEGRATION_SESSION_STATE_STORE_INVALID",
        fixture.rootPath
      );
    }
    const rejectedExpected = Promise.reject(new Error("benign rejected expected binding"));
    await expectCode(
      () => createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, rejectedExpected),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
    for (const field of Reflect.ownKeys(fixture.expected)) {
      const rejectedField = Promise.reject(new Error(`benign rejected expected field ${String(field)}`));
      await expectCode(
        () => createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, nullRecord({
          ...fixture.expected,
          [field]: rejectedField,
        })),
        "INTEGRATION_SESSION_STATE_STORE_INVALID",
        fixture.rootPath
      );
    }
    const rejectedPrimitives = Promise.reject(new Error("benign rejected file primitives"));
    await expectCode(
      () => createRetainedIntegrationSessionStateStore(rejectedPrimitives, fixture.lock, fixture.expected),
      "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE",
      fixture.rootPath
    );
    const rejectedLock = Promise.reject(new Error("benign rejected lock"));
    await expectCode(
      () => createRetainedIntegrationSessionStateStore(fixture.files, rejectedLock, fixture.expected),
      "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE",
      fixture.rootPath
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  const unsafe = Promise.reject(new Error("unsafe promise was pre-handled"));
  await Reflect.apply(Promise.prototype.then, unsafe, [undefined, () => undefined]);
  let constructorGetterHits = 0;
  Object.defineProperty(unsafe, "constructor", {
    configurable: false,
    get() { constructorGetterHits += 1; throw new Error("constructor trap"); },
  });
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.unsafe.promise",
      head,
      sessionState(nativeSessionId, head.runtimeRevision, "unsafe", { unsafe })
    )),
    "INTEGRATION_SESSION_STATE_STORE_INVALID",
    fixture.rootPath
  );
  assert.equal(constructorGetterHits, 0);

  const speciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  const speciesUnsafe = Promise.reject(new Error("unsafe species promise was pre-handled"));
  await Reflect.apply(Promise.prototype.then, speciesUnsafe, [undefined, () => undefined]);
  let speciesHits = 0;
  try {
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get() { speciesHits += 1; throw new Error("species trap"); },
    });
    await expectCode(
      () => store.compareAndSwapSessionSnapshot(saveInput(
        "mutation.unsafe.species",
        head,
        sessionState(nativeSessionId, head.runtimeRevision, "species", { speciesUnsafe })
      )),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
  } finally {
    Object.defineProperty(Promise, Symbol.species, speciesDescriptor);
  }
  assert.equal(speciesHits, 0);

  const unsafeUnhandled = [];
  const onUnsafeUnhandled = (reason) => unsafeUnhandled.push(reason);
  process.on("unhandledRejection", onUnsafeUnhandled);
  try {
    class PromiseSubclass extends Promise {}
    const subclassPromise = PromiseSubclass.reject(new Error("subclass rejection pre-handled by smoke"));
    await Reflect.apply(Promise.prototype.then, subclassPromise, [undefined, () => undefined]);
    await expectCode(
      () => store.loadSessionSnapshot(subclassPromise),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
    const crossRealm = vm.runInNewContext(`(() => {
      const promise = Promise.reject(new Error("cross-realm rejection pre-handled by smoke"));
      const handled = promise.then(undefined, () => undefined);
      return { promise, handled };
    })()`);
    await crossRealm.handled;
    await expectCode(
      () => store.loadSessionSnapshot(crossRealm.promise),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
    const prototypeAdjustedPromise = Promise.reject(
      new Error("prototype-adjusted rejection pre-handled by smoke")
    );
    await Reflect.apply(Promise.prototype.then, prototypeAdjustedPromise, [undefined, () => undefined]);
    Object.setPrototypeOf(prototypeAdjustedPromise, null);
    await expectCode(
      () => store.loadSessionSnapshot(prototypeAdjustedPromise),
      "INTEGRATION_SESSION_STATE_STORE_INVALID",
      fixture.rootPath
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unsafeUnhandled, []);
  } finally {
    process.off("unhandledRejection", onUnsafeUnhandled);
  }
}

async function runFifoAndConcurrencyChecks(fixture, store, nativeSessionId, head) {
  const holder = await storageApi.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
  const entered = deferred();
  const release = deferred();
  const holding = holder.runExclusive(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const blockedLoad = store.loadSessionSnapshot(nativeSessionId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const speciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  const constructorDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor");
  let trapHits = 0;
  let queued;
  try {
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get() { trapHits += 1; throw new Error("Promise species trap"); },
    });
    Object.defineProperty(Promise.prototype, "constructor", {
      configurable: true,
      get() { trapHits += 1; throw new Error("Promise constructor trap"); },
    });
    queued = store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.fifo.promise",
      head,
      sessionState(nativeSessionId, head.runtimeRevision, "fifo")
    ));
  } finally {
    Object.defineProperty(Promise, Symbol.species, speciesDescriptor);
    Object.defineProperty(Promise.prototype, "constructor", constructorDescriptor);
    release.resolve();
  }
  assert.equal((await blockedLoad).integrityDigest, head.integrityDigest);
  const fifoCommit = await queued;
  await holding;
  assert.equal(fifoCommit.outcome, "committed");
  assert.equal(trapHits, 0);
  head = fifoCommit.snapshot;

  const inputA = saveInput(
    "mutation.concurrent.a",
    head,
    sessionState(nativeSessionId, head.runtimeRevision, "winner-a")
  );
  const inputB = saveInput(
    "mutation.concurrent.b",
    head,
    sessionState(nativeSessionId, head.runtimeRevision, "winner-b")
  );
  const concurrent = await Promise.allSettled([
    store.compareAndSwapSessionSnapshot(inputA),
    store.compareAndSwapSessionSnapshot(inputB),
  ]);
  assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(
    concurrent.find((entry) => entry.status === "rejected").reason.publicCode,
    "INTEGRATION_SESSION_STATE_STORE_CONFLICT"
  );
  return store.loadSessionSnapshot(nativeSessionId);
}

async function runForwardGapChecks(rootPath) {
  const fixture = await openFixture(rootPath, "session-state-forward-gap");
  try {
    const first = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    const secondLock = await storageApi.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
    const second = createRetainedIntegrationSessionStateStore(fixture.files, secondLock, fixture.expected);
    const nativeSessionId = "aginti:forward-gap";
    const zero = await first.loadSessionSnapshot(nativeSessionId);
    const revisionOne = (await first.compareAndSwapSessionSnapshot(saveInput(
      "mutation.forward.0001",
      zero,
      sessionState(nativeSessionId, 1, "one")
    ))).snapshot;
    assert.equal((await second.loadSessionSnapshot(nativeSessionId)).integrityDigest, revisionOne.integrityDigest);
    const revisionTwo = (await second.compareAndSwapSessionSnapshot(saveInput(
      "mutation.forward.0002",
      revisionOne,
      sessionState(nativeSessionId, 2, "two")
    ))).snapshot;
    const revisionThree = (await second.compareAndSwapSessionSnapshot(saveInput(
      "mutation.forward.0003",
      revisionTwo,
      sessionState(nativeSessionId, 3, "three")
    ))).snapshot;
    const observedGap = await first.loadSessionSnapshot(nativeSessionId);
    assert.equal(observedGap.persistenceRevision, 3);
    assert.equal(observedGap.runtimeRevision, 3);
    assert.equal(observedGap.integrityDigest, revisionThree.integrityDigest);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runReopenAndCanonicalRootChecks(rootPath, copiedRootPath) {
  const role = "session-state-reopen";
  let fixture = await openFixture(rootPath, role);
  let fileName;
  let input;
  let logicalNamespaceDigest;
  let admissionBindingDigest;
  try {
    const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    const nativeSessionId = "aginti:reopen-session";
    const zero = await store.loadSessionSnapshot(nativeSessionId);
    input = saveInput("mutation.reopen.0001", zero, sessionState(nativeSessionId, 1, "reopen"));
    const committed = await store.compareAndSwapSessionSnapshot(input);
    fileName = committed.snapshot.fileName;
    logicalNamespaceDigest = store.attestation.logicalNamespaceDigest;
    admissionBindingDigest = store.attestation.admissionBindingDigest;
  } finally {
    await fixture.authority.close().catch(() => {});
  }

  fixture = await openFixture(rootPath, role);
  try {
    const reopened = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    assert.equal(reopened.attestation.logicalNamespaceDigest, logicalNamespaceDigest);
    assert.notEqual(reopened.attestation.admissionBindingDigest, admissionBindingDigest);
    const replay = await reopened.compareAndSwapSessionSnapshot(input);
    assert.equal(replay.outcome, "replayed");
  } finally {
    await fixture.authority.close().catch(() => {});
  }

  const copiedDataPath = path.join(copiedRootPath, "native:sessions");
  await ensureOwnerDirectory(copiedRootPath);
  await ensureOwnerDirectory(copiedDataPath);
  await ensureLockFile(path.join(copiedDataPath, INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE));
  await fs.copyFile(path.join(rootPath, "native:sessions", fileName), path.join(copiedDataPath, fileName));
  await fs.chmod(path.join(copiedDataPath, fileName), 0o600);
  await fs.chown(path.join(copiedDataPath, fileName), UID, GID);
  const copied = await openFixture(copiedRootPath, role);
  try {
    const copiedStore = createRetainedIntegrationSessionStateStore(copied.files, copied.lock, copied.expected);
    await expectCode(
      () => copiedStore.loadSessionSnapshot("aginti:reopen-session"),
      "INTEGRATION_SESSION_STATE_STORE_CORRUPT",
      copiedRootPath
    );
    await expectCode(
      () => copiedStore.loadSessionSnapshot("aginti:reopen-session"),
      "INTEGRATION_SESSION_STATE_STORE_POISONED",
      copiedRootPath
    );
  } finally {
    await copied.authority.close().catch(() => {});
  }
}

async function runObservedDeletionAndRollback(smokeRoot) {
  for (const mode of ["delete", "rollback"]) {
    const fixture = await openFixture(path.join(smokeRoot, mode), `session-state-${mode}`);
    try {
      const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
      const nativeSessionId = `aginti:${mode}-session`;
      const zero = await store.loadSessionSnapshot(nativeSessionId);
      const first = (await store.compareAndSwapSessionSnapshot(saveInput(
        `mutation.${mode}.0001`,
        zero,
        sessionState(nativeSessionId, 1, "first")
      ))).snapshot;
      const statePath = path.join(fixture.dataPath, first.fileName);
      if (mode === "delete") {
        await fs.unlink(statePath);
      } else {
        const firstRaw = await fs.readFile(statePath, "utf8");
        await store.compareAndSwapSessionSnapshot(saveInput(
          "mutation.rollback.0002",
          first,
          sessionState(nativeSessionId, 2, "second")
        ));
        await fs.writeFile(statePath, firstRaw, { mode: 0o600 });
      }
      await expectCode(
        () => store.loadSessionSnapshot(nativeSessionId),
        "INTEGRATION_SESSION_STATE_STORE_CORRUPT",
        fixture.rootPath
      );
      await expectCode(
        () => store.loadSessionSnapshot(`${nativeSessionId}-sibling`),
        "INTEGRATION_SESSION_STATE_STORE_POISONED",
        fixture.rootPath
      );
    } finally {
      await fixture.authority.close().catch(() => {});
    }
  }
}

async function runSemanticTamperChecks(smokeRoot) {
  const modes = [
    "same-revision-divergence",
    "adjacent-bad-predecessor",
    "adjacent-bad-base-runtime",
    "forward-runtime-rollback",
    "receipt-tamper",
  ];
  for (const mode of modes) {
    const fixture = await openFixture(path.join(smokeRoot, `semantic-${mode}`), `semantic-${mode}`);
    try {
      const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
      const nativeSessionId = `aginti:semantic-${mode}`;
      const zero = await store.loadSessionSnapshot(nativeSessionId);
      const first = (await store.compareAndSwapSessionSnapshot(saveInput(
        `mutation.semantic.${mode}.0001`,
        zero,
        sessionState(nativeSessionId, 1, "first")
      ))).snapshot;
      let observed = first;
      if (mode === "forward-runtime-rollback") {
        observed = (await store.compareAndSwapSessionSnapshot(saveInput(
          `mutation.semantic.${mode}.0002`,
          first,
          sessionState(nativeSessionId, 2, "second")
        ))).snapshot;
      }
      const statePath = path.join(fixture.dataPath, observed.fileName);
      const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
      if (mode === "same-revision-divergence") {
        parsed.state.marker = "resealed-same-revision-divergence";
        resealEnvelope(parsed);
      } else if (mode === "adjacent-bad-predecessor") {
        const wrongPredecessor = observed.integrityDigest === "a".repeat(64)
          ? "b".repeat(64)
          : "a".repeat(64);
        parsed.persistenceRevision = observed.persistenceRevision + 1;
        parsed.previousIntegrityDigest = wrongPredecessor;
        parsed.state.marker = "adjacent-with-wrong-predecessor";
        parsed.lastMutation.mutationId = "mutation.semantic.adjacent.bad.predecessor";
        parsed.lastMutation.basePersistenceRevision = observed.persistenceRevision;
        parsed.lastMutation.baseIntegrityDigest = wrongPredecessor;
        parsed.lastMutation.baseRuntimeRevision = observed.runtimeRevision;
        parsed.lastMutation.resultPersistenceRevision = parsed.persistenceRevision;
        parsed.lastMutation.resultRuntimeRevision = parsed.runtimeRevision;
        resealEnvelope(parsed);
      } else if (mode === "adjacent-bad-base-runtime") {
        parsed.persistenceRevision = observed.persistenceRevision + 1;
        parsed.runtimeRevision = observed.runtimeRevision + 1;
        parsed.previousIntegrityDigest = observed.integrityDigest;
        parsed.state.meta.runtimeConfig.revision = parsed.runtimeRevision;
        parsed.state.marker = "adjacent-with-wrong-base-runtime";
        parsed.lastMutation.mutationId = "mutation.semantic.adjacent.bad.base.runtime";
        parsed.lastMutation.basePersistenceRevision = observed.persistenceRevision;
        parsed.lastMutation.baseIntegrityDigest = observed.integrityDigest;
        parsed.lastMutation.baseRuntimeRevision = parsed.runtimeRevision;
        parsed.lastMutation.resultPersistenceRevision = parsed.persistenceRevision;
        parsed.lastMutation.resultRuntimeRevision = parsed.runtimeRevision;
        resealEnvelope(parsed);
      } else if (mode === "forward-runtime-rollback") {
        parsed.persistenceRevision = observed.persistenceRevision + 2;
        parsed.runtimeRevision = observed.runtimeRevision - 1;
        parsed.previousIntegrityDigest = observed.integrityDigest;
        parsed.state.meta.runtimeConfig.revision = parsed.runtimeRevision;
        parsed.state.marker = "forward-persistence-runtime-rollback";
        parsed.lastMutation.mutationId = "mutation.semantic.forward.runtime.rollback";
        parsed.lastMutation.basePersistenceRevision = parsed.persistenceRevision - 1;
        parsed.lastMutation.baseIntegrityDigest = observed.integrityDigest;
        parsed.lastMutation.baseRuntimeRevision = parsed.runtimeRevision;
        parsed.lastMutation.resultPersistenceRevision = parsed.persistenceRevision;
        parsed.lastMutation.resultRuntimeRevision = parsed.runtimeRevision;
        resealEnvelope(parsed);
      } else {
        parsed.lastMutation.mutationId = "mutation.semantic.receipt.tampered";
        resealEnvelope(parsed, { resealReceipt: false });
      }
      await writeCanonicalEnvelope(statePath, parsed);
      assert.equal(await fs.readFile(statePath, "utf8"), `${canonicalSortedJson(parsed)}\n`);
      if (mode !== "receipt-tamper") {
        const verifierLock = await storageApi.openIntegrationRetainedRegularFileLock(
          fixture.files,
          fixture.lockExpected
        );
        const verifier = createRetainedIntegrationSessionStateStore(
          fixture.files,
          verifierLock,
          fixture.expected
        );
        const independentlyAccepted = await verifier.loadSessionSnapshot(nativeSessionId);
        assert.equal(independentlyAccepted.persistenceRevision, parsed.persistenceRevision);
        assert.equal(independentlyAccepted.runtimeRevision, parsed.runtimeRevision);
        assert.equal(independentlyAccepted.integrityDigest, parsed.integrityDigest);
      }
      await expectCode(
        () => store.loadSessionSnapshot(nativeSessionId),
        "INTEGRATION_SESSION_STATE_STORE_CORRUPT",
        fixture.rootPath
      );
      await expectCode(
        () => store.loadSessionSnapshot(`${nativeSessionId}-sibling`),
        "INTEGRATION_SESSION_STATE_STORE_POISONED",
        fixture.rootPath
      );
      await assertNoAtomicResidue(fixture.dataPath);
    } finally {
      await fixture.authority.close().catch(() => {});
    }
  }
}

async function runMalformedMutationIdCheck(rootPath) {
  let fixture = await openFixture(rootPath, "session-state-malformed-mutation");
  let statePath;
  try {
    const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    const nativeSessionId = "aginti:malformed-mutation";
    const zero = await store.loadSessionSnapshot(nativeSessionId);
    const committed = (await store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.malformed.0001",
      zero,
      sessionState(nativeSessionId, 1, "valid")
    ))).snapshot;
    statePath = path.join(fixture.dataPath, committed.fileName);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
  const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
  parsed.lastMutation.mutationId = "bad";
  await fs.writeFile(statePath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  fixture = await openFixture(rootPath, "session-state-malformed-mutation");
  try {
    const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    await expectCode(
      () => store.loadSessionSnapshot("aginti:malformed-mutation"),
      "INTEGRATION_SESSION_STATE_STORE_CORRUPT",
      rootPath
    );
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function fdTargetsContaining(text) {
  const targets = [];
  for (const name of await fs.readdir("/proc/self/fd")) {
    const target = await fs.readlink(`/proc/self/fd/${name}`).catch(() => "");
    if (target.includes(text)) targets.push(target);
  }
  return targets.sort();
}

function recoveryArguments(rootPath, mode) {
  return [
    "--experimental-test-module-mocks",
    fileURLToPath(import.meta.url),
    `--recovery-root=${rootPath}`,
    `--recovery-mode=${mode}`,
  ];
}

async function runRecoveryMode(rootPath, mode) {
  const fixture = await openFixture(rootPath, "session-state-fault");
  try {
    const residueBefore = await assertFaultAtomicResidue(
      fixture.dataPath,
      mode,
      fixture.expected.maxStateBytes
    );
    const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    const nativeSessionId = "aginti:fault-session";
    const current = await store.loadSessionSnapshot(nativeSessionId);
    const virtual = nullRecord({ persistenceRevision: 0, integrityDigest: ZERO_DIGEST });
    const input = saveInput(
      `mutation.fault.${mode}`,
      virtual,
      sessionState(nativeSessionId, 1, mode)
    );
    if (mode === "prewrite" || mode === "rename-before" || mode === "compound-prewrite-lock-release") {
      assert.equal(current.persistenceRevision, 0);
      const committed = await store.compareAndSwapSessionSnapshot(input);
      assert.equal(committed.outcome, "committed");
      assert.equal(committed.snapshot.persistenceRevision, 1);
    } else {
      assert.equal(current.persistenceRevision, 1);
      const replayed = await store.compareAndSwapSessionSnapshot(input);
      assert.equal(replayed.outcome, "replayed");
      assert.equal(replayed.snapshot.integrityDigest, current.integrityDigest);
    }
    await assertFaultAtomicResidue(
      fixture.dataPath,
      mode,
      fixture.expected.maxStateBytes,
      residueBefore
    );
  } finally {
    await fixture.authority.close().catch(() => {});
  }
  process.stdout.write(`integration retained session-state recovery ${mode}: ok\n`);
}

async function runFaultMode(mode) {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), `aginti-session-state-${mode}-`));
  const rootPath = path.join(smokeRoot, "root");
  let fixture;
  let residueNames = [];
  let maxStateBytes = 0;
  try {
    fixture = await openFixture(rootPath, "session-state-fault");
    maxStateBytes = fixture.expected.maxStateBytes;
    const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    const nativeSessionId = "aginti:fault-session";
    const zero = await store.loadSessionSnapshot(nativeSessionId);
    const input = saveInput(
      `mutation.fault.${mode}`,
      zero,
      sessionState(nativeSessionId, 1, mode)
    );
    fault.armed = true;
    if (mode === "lock-release-load") {
      const unavailable = await expectCode(
        () => store.loadSessionSnapshot(nativeSessionId),
        "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE",
        smokeRoot
      );
      assert.equal(unavailable.details.writeAttempted, false);
      assert.equal(unavailable.details.writeConfirmed, false);
      assert.equal(unavailable.details.storagePhase, "lock-handle-close");
      residueNames = await assertFaultAtomicResidue(fixture.dataPath, mode, maxStateBytes);
      await expectCode(
        () => store.loadSessionSnapshot(`${nativeSessionId}-sibling`),
        "INTEGRATION_SESSION_STATE_STORE_POISONED",
        smokeRoot
      );
      process.stdout.write(`integration retained session-state ${mode} mock: ok\n`);
      return;
    }
    const expectedCode = mode === "prewrite" || mode === "compound-prewrite-lock-release"
      ? "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE"
      : "INTEGRATION_SESSION_STATE_STORE_COMMIT_AMBIGUOUS";
    const problem = await expectCode(
      () => store.compareAndSwapSessionSnapshot(input),
      expectedCode,
      smokeRoot
    );
    residueNames = await assertFaultAtomicResidue(fixture.dataPath, mode, maxStateBytes);
    assert.equal(problem.details.writeAttempted, true);
    assert.equal(problem.details.fileName.startsWith(STATE_FILE_PREFIX_LITERAL), true);
    if (mode === "prewrite") {
      assert.equal(problem.details.writeConfirmed, false);
      assert.equal(problem.details.commitMayHaveOccurred, false);
      assert.equal(problem.details.storagePhase, "atomic replace");
      assert.equal((await store.loadSessionSnapshot(nativeSessionId)).persistenceRevision, 0);
      const committed = await store.compareAndSwapSessionSnapshot(input);
      assert.equal(committed.outcome, "committed");
      await assertFaultAtomicResidue(fixture.dataPath, mode, maxStateBytes, residueNames);
      process.stdout.write(`integration retained session-state ${mode} mock: ok\n`);
      return;
    }
    assert.equal(problem.details.operationStarted, true);
    assert.equal(problem.details.operationSettled, true);
    assert.equal(
      problem.details.commitMayHaveOccurred,
      mode !== "compound-prewrite-lock-release"
    );
    if (mode === "rename-before" || mode === "rename-after") {
      assert.equal(problem.details.writeConfirmed, false);
      assert.equal(problem.details.storagePhase, "rename-issued");
      assert.equal(problem.details.renamed, false);
      assert.equal(problem.details.directorySynced, true);
      assert.equal(problem.details.postRenameSyncFailed, false);
    }
    if (mode === "directory-sync") {
      assert.equal(problem.details.writeConfirmed, false);
      assert.equal(problem.details.storagePhase, "renamed");
      assert.equal(problem.details.renamed, true);
      assert.equal(problem.details.directorySynced, false);
      assert.equal(problem.details.postRenameSyncFailed, true);
    }
    if (mode === "post-rename-recheck") {
      assert.equal(problem.details.writeConfirmed, false);
      assert.equal(problem.details.storagePhase, "renamed");
      assert.equal(problem.details.renamed, true);
      assert.equal(problem.details.directorySynced, true);
    }
    if (mode === "postwrite-read") {
      assert.equal(problem.details.writeConfirmed, true);
      assert.equal(problem.details.postWriteVerified, false);
      assert.equal(problem.details.storagePhase, "read");
    }
    if (mode === "lock-release-commit") {
      assert.equal(problem.details.writeConfirmed, true);
      assert.equal(problem.details.postWriteVerified, true);
      assert.equal(problem.details.operationFailed, false);
      assert.equal(problem.details.storagePhase, "lock-handle-close");
    }
    if (mode === "compound-rename-lock-release") {
      assert.equal(problem.details.writeConfirmed, false);
      assert.equal(problem.details.originalStorageCode, "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS");
      assert.equal(problem.details.storagePhase, "lock-handle-close");
      assert.equal(problem.details.renamed, false);
      assert.equal(problem.details.directorySynced, true);
    }
    if (mode === "compound-prewrite-lock-release") {
      assert.equal(problem.details.writeConfirmed, false);
      assert.equal(problem.details.originalStorageCode, "INTEGRATION_STORAGE_FILE_UNAVAILABLE");
      assert.equal(problem.details.storagePhase, "lock-handle-close");
    }
    await expectCode(
      () => store.loadSessionSnapshot(nativeSessionId),
      "INTEGRATION_SESSION_STATE_STORE_POISONED",
      smokeRoot
    );
    await fixture.authority.close().catch(() => {});
    fixture = null;
    fsMock?.restore();
    const { stdout } = await execFileAsync(process.execPath, recoveryArguments(rootPath, mode), {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert.match(stdout, new RegExp(`session-state recovery ${mode}: ok`, "u"));
    await assertFaultAtomicResidue(
      path.join(rootPath, "native:sessions"),
      mode,
      maxStateBytes,
      residueNames
    );
  } finally {
    await fixture?.authority.close().catch(() => {});
    fsMock?.restore();
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write(`integration retained session-state ${mode} mock: ok\n`);
}

function nestedChain(objectCount) {
  let value = "leaf";
  for (let index = 0; index < objectCount; index += 1) value = { nested: value };
  return value;
}

async function runExactStructuralBoundaryChecks(rootPath) {
  const fixture = await openFixture(rootPath, "session-state-boundaries", { maxStateBytes: 2 * 1024 * 1024 });
  try {
    const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    const depthSessionId = "aginti:depth-boundary";
    const depthZero = await store.loadSessionSnapshot(depthSessionId);
    const depth63 = await store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.depth.boundary.63",
      depthZero,
      sessionState(depthSessionId, 1, "depth-63", { deep: nestedChain(62) })
    ));
    assert.equal(depth63.outcome, "committed");
    await expectCode(
      () => store.compareAndSwapSessionSnapshot(saveInput(
        "mutation.depth.boundary.64",
        depth63.snapshot,
        sessionState(depthSessionId, 1, "depth-64", { deep: nestedChain(63) })
      )),
      "INTEGRATION_SESSION_STATE_STORE_FULL",
      fixture.rootPath
    );

    const nodeSessionId = "aginti:node-boundary";
    const nodeZero = await store.loadSessionSnapshot(nodeSessionId);
    const exactStateNodes = new Array(INTEGRATION_RETAINED_SESSION_STATE_MAX_JSON_NODES - 30).fill(null);
    const exactNodes = await store.compareAndSwapSessionSnapshot(saveInput(
      "mutation.nodes.boundary.exact",
      nodeZero,
      sessionState(nodeSessionId, 1, "nodes-exact", { nodes: exactStateNodes })
    ));
    assert.equal(exactNodes.outcome, "committed");
    const oneTooMany = new Array(INTEGRATION_RETAINED_SESSION_STATE_MAX_JSON_NODES - 29).fill(null);
    await expectCode(
      () => store.compareAndSwapSessionSnapshot(saveInput(
        "mutation.nodes.boundary.full",
        exactNodes.snapshot,
        sessionState(nodeSessionId, 1, "nodes-full", { nodes: oneTooMany })
      )),
      "INTEGRATION_SESSION_STATE_STORE_FULL",
      fixture.rootPath
    );
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runSpecialFileMode(rootPath, mode) {
  const fixture = await openFixture(rootPath, `session-state-${mode}`);
  try {
    const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    const nativeSessionId = `aginti:special-${mode}`;
    const zero = await store.loadSessionSnapshot(nativeSessionId);
    const targetPath = path.join(fixture.dataPath, zero.fileName);
    const backingPath = path.join(fixture.dataPath, `backing-${mode}`);
    if (mode === "corrupt" || mode === "wrong-mode") {
      await fs.writeFile(targetPath, "not-json\n", { mode: mode === "wrong-mode" ? 0o644 : 0o600 });
      await fs.chown(targetPath, UID, GID);
      await fs.chmod(targetPath, mode === "wrong-mode" ? 0o644 : 0o600);
    } else if (mode === "empty") {
      await fs.writeFile(targetPath, "", { mode: 0o600 });
      await fs.chown(targetPath, UID, GID);
      await fs.chmod(targetPath, 0o600);
    } else if (mode === "directory") {
      await fs.mkdir(targetPath, { mode: 0o700 });
      await fs.chown(targetPath, UID, GID);
      await fs.chmod(targetPath, 0o700);
    } else if (mode === "symlink") {
      await fs.writeFile(backingPath, "not-json\n", { mode: 0o600 });
      await fs.symlink(backingPath, targetPath);
    } else if (mode === "hardlink") {
      await fs.writeFile(backingPath, "not-json\n", { mode: 0o600 });
      await fs.chown(backingPath, UID, GID);
      await fs.chmod(backingPath, 0o600);
      await fs.link(backingPath, targetPath);
    } else if (mode === "fifo") {
      await execFileAsync("/usr/bin/mkfifo", [targetPath]);
      await fs.chown(targetPath, UID, GID);
      await fs.chmod(targetPath, 0o600);
    } else {
      assert.fail(`Unsupported special-file smoke mode: ${mode}`);
    }
    const startedAt = Date.now();
    const expectedCode = mode === "directory"
      ? "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE"
      : "INTEGRATION_SESSION_STATE_STORE_CORRUPT";
    const problem = await expectCode(
      () => store.loadSessionSnapshot(nativeSessionId),
      expectedCode,
      fixture.rootPath
    );
    if (mode === "fifo") assert.ok(Date.now() - startedAt < 1000, "FIFO rejection must be nonblocking.");
    if (mode === "directory") {
      assert.equal(problem.details.operationStarted, false);
      assert.equal(problem.details.storagePhase, "acquire");
      await expectCode(
        () => store.loadSessionSnapshot(`${nativeSessionId}-sibling`),
        "INTEGRATION_SESSION_STATE_STORE_POISONED",
        fixture.rootPath
      );
    } else {
      await expectCode(
        () => store.loadSessionSnapshot(nativeSessionId),
        "INTEGRATION_SESSION_STATE_STORE_POISONED",
        fixture.rootPath
      );
    }
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runSpecialFileChecks(smokeRoot) {
  for (const mode of ["corrupt", "empty", "wrong-mode", "directory", "symlink", "hardlink"]) {
    await runSpecialFileMode(path.join(smokeRoot, `special-${mode}`), mode);
  }
  const fifoRoot = path.join(smokeRoot, "special-fifo");
  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-test-module-mocks",
    fileURLToPath(import.meta.url),
    "--special-mode=fifo",
    `--special-root=${fifoRoot}`,
  ], { timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.match(stdout, /session-state special fifo: ok/u);
}

async function runCrossFactoryConcurrent(rootPath) {
  const fixture = await openFixture(rootPath, "session-state-cross-factory");
  try {
    const first = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    const secondLock = await storageApi.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
    const second = createRetainedIntegrationSessionStateStore(fixture.files, secondLock, fixture.expected);
    const nativeSessionId = "aginti:cross-factory";
    const [zeroFirst, zeroSecond] = await Promise.all([
      first.loadSessionSnapshot(nativeSessionId),
      second.loadSessionSnapshot(nativeSessionId),
    ]);
    const concurrent = await Promise.allSettled([
      first.compareAndSwapSessionSnapshot(saveInput(
        "mutation.cross.factory.a",
        zeroFirst,
        sessionState(nativeSessionId, 1, "a")
      )),
      second.compareAndSwapSessionSnapshot(saveInput(
        "mutation.cross.factory.b",
        zeroSecond,
        sessionState(nativeSessionId, 1, "b")
      )),
    ]);
    assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(
      concurrent.find((entry) => entry.status === "rejected").reason.publicCode,
      "INTEGRATION_SESSION_STATE_STORE_CONFLICT"
    );
    assert.equal((await first.loadSessionSnapshot(nativeSessionId)).persistenceRevision, 1);
    assert.equal((await second.loadSessionSnapshot(nativeSessionId)).persistenceRevision, 1);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runCloseQueueAndPostCloseChecks(rootPath) {
  const fixture = await openFixture(rootPath, "session-state-close-queue", { lockWaitMs: 10_000 });
  const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
  const holder = await storageApi.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
  const entered = deferred();
  const release = deferred();
  const holding = holder.runExclusive(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const queued = store.loadSessionSnapshot("aginti:close-queue");
  await new Promise((resolve) => setTimeout(resolve, 30));
  let closeSettled = false;
  const closing = fixture.authority.close().then(() => { closeSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closeSettled, false);
  assert.equal(store.isClosed(), true);
  release.resolve();
  await holding;
  await expectCode(() => queued, "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE", fixture.rootPath);
  await closing;
  await expectCode(
    () => store.loadSessionSnapshot("aginti:close-queue"),
    "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE",
    fixture.rootPath
  );
  await expectCode(
    () => store.compareAndSwapSessionSnapshot(Object.freeze({})),
    "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE",
    fixture.rootPath
  );
}

async function runPendingOperationCap(rootPath) {
  const fixture = await openFixture(rootPath, "session-state-operation-cap", { lockWaitMs: 60_000 });
  const holder = await storageApi.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
  const entered = deferred();
  const release = deferred();
  const holding = holder.runExclusive(async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
    const pending = [];
    for (let index = 0; index < 1024; index += 1) {
      pending.push(store.loadSessionSnapshot(`aginti:queued-${String(index).padStart(4, "0")}`));
    }
    await expectCode(
      () => store.loadSessionSnapshot("aginti:queued-overflow"),
      "INTEGRATION_SESSION_STATE_STORE_BUSY",
      fixture.rootPath
    );
    release.resolve();
    await holding;
    const settled = await Promise.allSettled(pending);
    assert.equal(settled.length, 1024);
    assert.equal(settled.every((entry) => (
      entry.status === "fulfilled" && entry.value.persistenceRevision === 0
    )), true);
    const reusable = await store.loadSessionSnapshot("aginti:queue-after-release");
    assert.equal(reusable.persistenceRevision, 0);
    assert.equal(store.isClosed(), false);
  } finally {
    release.resolve();
    await holding.catch(() => {});
    await fixture.authority.close().catch(() => {});
  }
}

async function runBlockedWeightCap(
  rootPath,
  role,
  states,
  overflowState,
  overflowMutationId
) {
  const fixture = await openFixture(rootPath, role, {
    maxStateBytes: 16 * 1024 * 1024,
    lockWaitMs: 60_000,
  });
  const store = createRetainedIntegrationSessionStateStore(fixture.files, fixture.lock, fixture.expected);
  const holder = await storageApi.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
  const entered = deferred();
  const release = deferred();
  const holding = holder.runExclusive(async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    const zero = nullRecord({ persistenceRevision: 0, integrityDigest: ZERO_DIGEST });
    const queued = states.map((state, index) => store.compareAndSwapSessionSnapshot(saveInput(
      `mutation.weight.${role}.initial.${index}`,
      zero,
      state
    )));
    await expectCode(
      () => store.compareAndSwapSessionSnapshot(saveInput(overflowMutationId, zero, overflowState)),
      "INTEGRATION_SESSION_STATE_STORE_BUSY",
      fixture.rootPath
    );
    release.resolve();
    await holding;
    const initial = await Promise.allSettled(queued);
    assert.equal(initial.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(initial.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(initial.find((entry) => entry.status === "fulfilled").value.outcome, "committed");
    assert.equal(
      initial.find((entry) => entry.status === "rejected").reason.publicCode,
      "INTEGRATION_SESSION_STATE_STORE_CONFLICT"
    );
    const nativeSessionId = states[0].sessionId;
    const head = await store.loadSessionSnapshot(nativeSessionId);
    assert.equal(head.persistenceRevision, 1);

    const reusedWeight = states.map((state, index) => store.compareAndSwapSessionSnapshot(saveInput(
      `mutation.weight.${role}.reused.${index}`,
      head,
      state
    )));
    const reused = await Promise.allSettled(reusedWeight);
    assert.equal(reused.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(reused.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(reused.find((entry) => entry.status === "fulfilled").value.outcome, "committed");
    assert.equal(
      reused.find((entry) => entry.status === "rejected").reason.publicCode,
      "INTEGRATION_SESSION_STATE_STORE_CONFLICT"
    );
    const finalHead = await store.loadSessionSnapshot(nativeSessionId);
    assert.equal(finalHead.persistenceRevision, 2);
    assert.equal(store.isClosed(), false);
  } finally {
    release.resolve();
    await holding.catch(() => {});
    await fixture.authority.close().catch(() => {});
  }
}

async function runPendingWeightCaps(smokeRoot) {
  const byteSessionId = "aginti:weight-bytes";
  const fifteenMiB = "x".repeat(15 * 1024 * 1024);
  await runBlockedWeightCap(
    path.join(smokeRoot, "weight-bytes"),
    "session-state-weight-bytes",
    [
      sessionState(byteSessionId, 1, "byte-a", { large: fifteenMiB }),
      sessionState(byteSessionId, 1, "byte-b", { large: fifteenMiB }),
    ],
    sessionState(byteSessionId, 1, "byte-overflow", { large: "y".repeat(3 * 1024 * 1024) }),
    "mutation.weight.bytes.overflow"
  );

  const nodeSessionId = "aginti:weight-nodes";
  await runBlockedWeightCap(
    path.join(smokeRoot, "weight-nodes"),
    "session-state-weight-nodes",
    [
      sessionState(nodeSessionId, 1, "node-a", { nodes: new Array(90_000).fill(null) }),
      sessionState(nodeSessionId, 1, "node-b", { nodes: new Array(90_000).fill(null) }),
    ],
    sessionState(nodeSessionId, 1, "node-overflow", { nodes: new Array(30_000).fill(null) }),
    "mutation.weight.nodes.overflow"
  );
}

async function runStaticBoundaryChecks() {
  const source = await fs.readFile(new URL("../src/integration-retained-session-state-store.js", import.meta.url), "utf8");
  const config = await fs.readFile(new URL("../src/integration-config.js", import.meta.url), "utf8");
  const allowedPreEnableConsumer = "integration-retained-native-session-repository-state.js";
  assert.doesNotMatch(source, /from\s+["'].+integration-(?:runtime-authority|server|native-executor)/u);
  assert.doesNotMatch(source, /createAgintiIntegrationRuntimeAuthority|createIntegrationServer/u);
  assert.match(source, /runtimeCapabilityEnabled:\s*false/u);
  assert.match(source, /runtimeWiringIncluded:\s*false/u);
  assert.match(config, /capability:\s*Object\.freeze\(\{ enabled: false \}\)/u);
  assert.doesNotMatch(
    config,
    /integration-retained-session-state-store|(?:create|assert)RetainedIntegrationSessionStateStore/u
  );
  const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
  const consumerNames = (await fs.readdir(sourceDirectory)).filter((name) => (
    name.endsWith(".js") &&
    name !== "integration-retained-session-state-store.js" &&
    /(?:server|runtime|session|persistence|executor)/u.test(name)
  ));
  for (const requiredName of [
    "integration-native-executor.js",
    allowedPreEnableConsumer,
    "integration-runtime-authority.js",
    "integration-native-runtime-roots.js",
    "integration-server.js",
    "integration-session-persistence.js",
    "integration-session-service.js",
    "session-store.js",
  ]) assert.equal(consumerNames.includes(requiredName), true, `Missing no-wiring consumer scan: ${requiredName}`);
  for (const consumerName of consumerNames) {
    const consumer = await fs.readFile(path.join(sourceDirectory, consumerName), "utf8");
    if (consumerName === allowedPreEnableConsumer) {
      assert.match(consumer, /runtimeCapabilityEnabled:\s*false/u);
      assert.match(consumer, /runtimeWiringIncluded:\s*false/u);
      assert.doesNotMatch(
        consumer,
        /integration-(?:runtime-authority|server|native-executor|session-service|session-persistence|api|runtime-repository-contract|event-ledger-store|idempotency-store)\.js|(?:^|\/)session-store\.js|artifact-tunnel\.js/u,
        `${consumerName} may bind the retained session-state store only as a capability-disabled pre-enable domain surface.`
      );
      continue;
    }
    assert.doesNotMatch(
      consumer,
      /integration-retained-session-state-store|(?:create|assert)RetainedIntegrationSessionStateStore/u,
      `${consumerName} must not wire the capability-disabled retained session-state kernel.`
    );
  }
}

async function main() {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-session-state-store-smoke-"));
  let mainFixture;
  try {
    await runStaticBoundaryChecks();
    mainFixture = await openFixture(path.join(smokeRoot, "main"), "session-state-main");
    const store = createRetainedIntegrationSessionStateStore(
      mainFixture.files,
      mainFixture.lock,
      mainFixture.expected
    );
    const transition = await runSurfaceAndTransitionChecks(mainFixture, store);
    await runInvalidAndPromiseChecks(mainFixture, store, transition.nativeSessionId, transition.head);
    const head = await runFifoAndConcurrencyChecks(
      mainFixture,
      store,
      transition.nativeSessionId,
      transition.head
    );
    assert.equal((await store.loadSessionSnapshot(transition.nativeSessionId)).integrityDigest, head.integrityDigest);
    await mainFixture.authority.close();
    assert.equal(store.isClosed(), true);
    mainFixture = null;

    await runForwardGapChecks(path.join(smokeRoot, "forward-gap"));
    await runReopenAndCanonicalRootChecks(
      path.join(smokeRoot, "reopen"),
      path.join(smokeRoot, "copied-root")
    );
    await runObservedDeletionAndRollback(smokeRoot);
    await runSemanticTamperChecks(smokeRoot);
    await runMalformedMutationIdCheck(path.join(smokeRoot, "malformed"));
    await runExactStructuralBoundaryChecks(path.join(smokeRoot, "boundaries"));
    await runSpecialFileChecks(smokeRoot);
    await runCrossFactoryConcurrent(path.join(smokeRoot, "cross-factory"));
    await runPendingOperationCap(path.join(smokeRoot, "operation-cap"));
    await runPendingWeightCaps(smokeRoot);
    await runCloseQueueAndPostCloseChecks(path.join(smokeRoot, "close-queue"));

    for (const mode of FAULT_MODES) {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--experimental-test-module-mocks", fileURLToPath(import.meta.url), `--mock-mode=${mode}`],
        { timeout: 45_000, maxBuffer: 1024 * 1024 }
      );
      assert.match(stdout, new RegExp(`session-state ${mode} mock: ok`, "u"));
    }
  } finally {
    await mainFixture?.authority.close().catch(() => {});
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write("integration retained session-state store smoke: ok\n");
}

if (RECOVERY_ROOT) await runRecoveryMode(RECOVERY_ROOT, RECOVERY_MODE);
else if (MODE) await runFaultMode(MODE);
else if (SPECIAL_MODE) {
  assert.equal(SPECIAL_MODE, "fifo");
  assert.equal(path.isAbsolute(SPECIAL_ROOT), true);
  await runSpecialFileMode(SPECIAL_ROOT, SPECIAL_MODE);
  process.stdout.write(`integration retained session-state special ${SPECIAL_MODE}: ok\n`);
} else await main();
