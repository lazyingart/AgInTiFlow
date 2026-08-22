#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { contractDigest } from "../src/integration-policy.js";

const execFileAsync = promisify(execFile);
const UID = process.getuid();
const GID = process.getgid();
const HELPER_PATH = "/usr/bin/flock";
const ZERO_DIGEST = "0".repeat(64);
const MODE = String(process.argv.find((value) => value.startsWith("--mock-mode=")) || "").slice(12);
const FAULT_MODES = Object.freeze([
  "prewrite",
  "rename-before",
  "rename-after",
  "post-rename-recheck",
  "postwrite-read",
  "lock-release-commit",
  "lock-release-load",
  "compound-rename-lock-release",
  "compound-prewrite-lock-release",
]);
const fault = {
  armed: false,
  failNextSnapshotRead: false,
  failNextPostRenameLstat: false,
  snapshotPath: "",
  lockPath: "",
};
let fsMock = null;

if (Reflect.apply(Array.prototype.includes, FAULT_MODES, [MODE])) {
  const { mock } = await import("node:test");
  const realFs = fs;
  const mockFs = { ...realFs };
  mockFs.rename = async (source, target) => {
    if (
      fault.armed &&
      MODE === "rename-before" &&
      path.basename(String(target)) === INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE
    ) {
      fault.armed = false;
      const error = new Error("synthetic /proc/self/fd/881 rename-before failure");
      error.code = "EIO";
      throw error;
    }
    await realFs.rename(source, target);
    if (fault.armed && path.basename(String(target)) === INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE) {
      if (MODE === "rename-after" || MODE === "compound-rename-lock-release") {
        if (MODE === "rename-after") fault.armed = false;
        const error = new Error("synthetic /proc/self/fd/882 rename-after ambiguity");
        error.code = "EIO";
        throw error;
      }
      if (MODE === "postwrite-read") {
        fault.armed = false;
        fault.failNextSnapshotRead = true;
      }
      if (MODE === "post-rename-recheck") {
        fault.armed = false;
        fault.failNextPostRenameLstat = true;
      }
    }
  };
  mockFs.lstat = async (target, ...args) => {
    if (
      fault.failNextPostRenameLstat &&
      path.basename(String(target)) === INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE
    ) {
      fault.failNextPostRenameLstat = false;
      const error = new Error("synthetic /proc/self/fd/886 post-rename recheck failure");
      error.code = "EIO";
      throw error;
    }
    return realFs.lstat(target, ...args);
  };
  mockFs.open = async (target, flags, ...args) => {
    const targetText = String(target);
    if (
      fault.armed &&
      (MODE === "prewrite" || MODE === "compound-prewrite-lock-release") &&
      targetText.includes(".aginti-atomic-v1-")
    ) {
      if (MODE === "prewrite") fault.armed = false;
      const error = new Error("synthetic /proc/self/fd/883 prewrite failure");
      error.code = "EIO";
      throw error;
    }
    if (
      fault.failNextSnapshotRead &&
      path.basename(targetText) === INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE
    ) {
      fault.failNextSnapshotRead = false;
      const error = new Error("synthetic /proc/self/fd/884 postwrite verification failure");
      error.code = "EIO";
      throw error;
    }
    const handle = await realFs.open(target, flags, ...args);
    if (
      fault.armed &&
      path.basename(targetText) === INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE &&
      (
        MODE === "lock-release-commit" ||
        MODE === "lock-release-load" ||
        MODE === "compound-rename-lock-release" ||
        MODE === "compound-prewrite-lock-release"
      )
    ) {
      const wrapped = Object.create(null);
      Object.defineProperties(wrapped, {
        fd: { enumerable: true, get: () => handle.fd },
        stat: { enumerable: true, value: (...statArgs) => handle.stat(...statArgs) },
        close: {
          enumerable: true,
          value: async () => {
            await handle.close();
            if (fault.armed) {
              fault.armed = false;
              const error = new Error("synthetic /proc/self/fd/885 lock close ambiguity");
              error.code = "EIO";
              throw error;
            }
          },
        },
      });
      return Object.freeze(wrapped);
    }
    return handle;
  };
  fsMock = mock.module("node:fs/promises", { defaultExport: mockFs });
}

const [kernelApi, storageApi, durableApi] = await Promise.all([
  import(new URL("../src/integration-runtime-repository.js", import.meta.url).href),
  import(new URL("../src/integration-storage-authority.js", import.meta.url).href),
  import(new URL("../src/integration-durable-common.js", import.meta.url).href),
]);
const { INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE } = durableApi;

const {
  INTEGRATION_RETAINED_REPOSITORY_KERNEL_ATTESTATION_VERSION,
  INTEGRATION_RETAINED_REPOSITORY_KERNEL_LIMITATIONS,
  INTEGRATION_RETAINED_REPOSITORY_KERNEL_VERSION,
  INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_INTEGRITY_DOMAIN,
  INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
  INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH,
  INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES,
  INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_BYTES,
  INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_NODES,
  INTEGRATION_RETAINED_REPOSITORY_PAYLOAD_DIGEST_DOMAIN,
  INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE,
  INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_INTEGRITY_DOMAIN,
  assertRetainedIntegrationRuntimeRepositoryKernel,
  createRetainedIntegrationRuntimeRepositoryKernel,
} = kernelApi;

const SURFACE_KEYS = Object.freeze([
  "schemaVersion",
  "attestation",
  "loadSnapshot",
  "compareAndSwapSnapshot",
  "isClosed",
]);
const ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "preEnableStorageKernel",
  "runtimeCapabilityEnabled",
  "runtimeWiringIncluded",
  "runtimeRepositorySurface",
  "repositoryDomainValidation",
  "repositoryTransitionsIncluded",
  "artifactSemanticsIncluded",
  "recoverySemanticsIncluded",
  "singleCanonicalSnapshot",
  "boundedSnapshot",
  "compareAndSwap",
  "revisionExactlyOne",
  "globalStoreLock",
  "postWriteReloadVerification",
  "storageLifecycleOwned",
  "snapshotFileName",
  "lockFileNameDigest",
  "pointerDigest",
  "admissionBindingDigest",
  "namespaceSealBindingDigest",
  "maxSnapshotBytes",
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
const SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "pointerDigest",
  "snapshotRevision",
  "previousIntegrityDigest",
  "payload",
  "payloadDigest",
  "lastCommit",
  "integrityDigest",
]);
const LAST_COMMIT_KEYS = Object.freeze([
  "schemaVersion",
  "transactionId",
  "requestDigest",
  "baseSnapshotRevision",
  "baseIntegrityDigest",
  "resultSnapshotRevision",
  "payloadDigest",
  "commitDigest",
]);

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

async function makeOwnerDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
  await fs.chown(directoryPath, UID, GID);
}

async function makeLockFile(filePath) {
  await fs.writeFile(filePath, "", { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  await fs.chown(filePath, UID, GID);
}

async function openFixture(rootPath, role, { maxSnapshotBytes = 256 * 1024, lockWaitMs = 2000 } = {}) {
  const dataPath = path.join(rootPath, "data:repository");
  const lockPath = path.join(dataPath, INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE);
  await makeOwnerDirectory(rootPath);
  await makeOwnerDirectory(dataPath);
  await makeLockFile(lockPath);
  const authority = await storageApi.openIntegrationStorageAuthority({
    rootPath,
    role,
    ownerUid: UID,
    ownerGid: GID,
    label: "retained repository kernel smoke",
  });
  const directory = await authority.openDirectory(["data:repository"]);
  const directoryIdentity = await directory.identity();
  const directoryExpected = Object.freeze({
    role,
    canonicalPath: rootPath,
    rootIdentityDigest: authority.attestation.rootIdentityDigest,
    relativeSegments: Object.freeze(["data:repository"]),
    directoryIdentityDigest: directoryIdentity.digest,
  });
  const files = storageApi.createIntegrationRetainedFilePrimitives(directory, directoryExpected);
  const helperSha256 = crypto.createHash("sha256").update(await fs.readFile(HELPER_PATH)).digest("hex");
  const helperIdentityDigest = identityDigest(await fs.stat(HELPER_PATH, { bigint: true }));
  const lockFileIdentityDigest = identityDigest(await fs.stat(lockPath, { bigint: true }));
  const lockExpected = Object.freeze({
    ...directoryExpected,
    lockFileName: INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
    helperSha256,
    lockFileIdentityDigest,
    helperIdentityDigest,
  });
  const expected = Object.freeze({
    ...directoryExpected,
    lockFileIdentityDigest,
    helperSha256,
    helperIdentityDigest,
    maxSnapshotBytes,
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
    snapshotPath: path.join(dataPath, INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE),
    rootPath,
  });
}

function casInput(transactionId, current, payload, requestTag = transactionId) {
  return Object.freeze({
    transactionId,
    requestDigest: contractDigest({ domain: "repository-kernel-smoke-request-v1", requestTag }),
    expectedSnapshotRevision: current.snapshotRevision,
    expectedIntegrityDigest: current.integrityDigest,
    payload,
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

async function fdTargetsContaining(text) {
  const targets = [];
  for (const name of await fs.readdir("/proc/self/fd")) {
    const target = await fs.readlink(`/proc/self/fd/${name}`).catch(() => "");
    if (target.includes(text)) targets.push(target);
  }
  return targets.sort();
}

function nullRecord(entries) {
  return Object.freeze(Object.assign(Object.create(null), entries));
}

function digestWithout(value, omittedKey) {
  const unsigned = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (key !== omittedKey) unsigned[key] = value[key];
  }
  return unsigned;
}

function verifyPersistedEnvelope(raw, snapshot) {
  assert.equal(raw, `${JSON.stringify(JSON.parse(raw))}\n`);
  assert.equal(snapshot.payloadDigest, contractDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_PAYLOAD_DIGEST_DOMAIN,
    payload: snapshot.payload,
  }));
  assert.equal(snapshot.lastCommit.commitDigest, contractDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(snapshot.lastCommit, "commitDigest"),
  }));
  assert.equal(snapshot.integrityDigest, contractDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(snapshot, "integrityDigest"),
  }));
}

async function runBrandAndBindingChecks(fixture, kernel) {
  assertExactFrozenNullSurface(kernel, SURFACE_KEYS);
  assert.equal(kernel.schemaVersion, INTEGRATION_RETAINED_REPOSITORY_KERNEL_VERSION);
  assert.equal(kernel.attestation.schemaVersion, INTEGRATION_RETAINED_REPOSITORY_KERNEL_ATTESTATION_VERSION);
  assertExactFrozenNullSurface(kernel.attestation, ATTESTATION_KEYS);
  assert.equal(kernel.attestation.runtimeCapabilityEnabled, false);
  assert.equal(kernel.attestation.runtimeWiringIncluded, false);
  assert.equal(kernel.attestation.runtimeRepositorySurface, false);
  assert.equal(kernel.attestation.repositoryDomainValidation, false);
  assert.equal(kernel.attestation.repositoryTransitionsIncluded, false);
  assert.equal(kernel.attestation.artifactSemanticsIncluded, false);
  assert.equal(kernel.attestation.recoverySemanticsIncluded, false);
  assert.equal(kernel.attestation.limitations, INTEGRATION_RETAINED_REPOSITORY_KERNEL_LIMITATIONS);
  assert.equal(kernel.attestation.limitations.wholeSnapshotRewrite, true);
  assert.equal(kernel.attestation.limitations.multiFileTransactions, false);
  assert.equal(kernel.attestation.limitations.nativeSessionStoreIntegration, false);
  assert.equal(kernel.attestation.limitations.eventLedgerIntegration, false);
  assert.equal(kernel.attestation.limitations.idempotencyStoreIntegration, false);
  assert.equal(kernel.attestation.limitations.crossStoreIdempotency, false);
  assert.equal(kernel.attestation.limitations.automaticTempRecovery, false);
  assert.equal(kernel.attestation.maxPendingPayloadBytes, INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_BYTES);
  assert.equal(kernel.attestation.maxPendingPayloadNodes, INTEGRATION_RETAINED_REPOSITORY_MAX_PENDING_PAYLOAD_NODES);
  assert.equal(assertRetainedIntegrationRuntimeRepositoryKernel(kernel, fixture.expected), kernel);
  await expectCode(() => kernel.loadSnapshot("unexpected"), "INTEGRATION_REPOSITORY_KERNEL_INVALID", fixture.rootPath);
  await expectCode(() => kernel.compareAndSwapSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_INVALID", fixture.rootPath);
  await expectCode(
    () => assertRetainedIntegrationRuntimeRepositoryKernel(kernel),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  await expectCode(
    () => assertRetainedIntegrationRuntimeRepositoryKernel(Object.freeze(Object.create(null)), fixture.expected),
    "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
    fixture.rootPath
  );
  await expectCode(
    () => assertRetainedIntegrationRuntimeRepositoryKernel(kernel, Object.freeze({
      ...fixture.expected,
      role: "bad role",
    })),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  await expectCode(
    () => assertRetainedIntegrationRuntimeRepositoryKernel(kernel, Object.freeze({
      ...fixture.expected,
      canonicalPath: `${fixture.rootPath}/`,
    })),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  await expectCode(
    () => assertRetainedIntegrationRuntimeRepositoryKernel(kernel, Object.freeze({
      ...fixture.expected,
      role: "different-valid-role",
    })),
    "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
    fixture.rootPath
  );
  let traps = 0;
  const proxy = new Proxy({}, {
    get() { traps += 1; throw new Error("proxy get trap"); },
    ownKeys() { traps += 1; throw new Error("proxy ownKeys trap"); },
  });
  await expectCode(
    () => assertRetainedIntegrationRuntimeRepositoryKernel(kernel, proxy),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  assert.equal(traps, 0);
  for (const segment of [
    ".",
    "..",
    "bad/segment",
    "bad\\segment",
    ".aginti-atomic-v1-forbidden",
    ".aginti-flock-v1-forbidden",
    "x".repeat(161),
  ]) {
    await expectCode(
      () => assertRetainedIntegrationRuntimeRepositoryKernel(kernel, Object.freeze({
        ...fixture.expected,
        relativeSegments: Object.freeze([segment]),
      })),
      "INTEGRATION_REPOSITORY_KERNEL_INVALID",
      fixture.rootPath
    );
  }
  await expectCode(
    () => createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected),
    "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
    fixture.rootPath
  );
}

async function runCasChecks(fixture, kernel) {
  const zero = await kernel.loadSnapshot();
  assertExactFrozenNullFields(zero, SNAPSHOT_KEYS);
  assert.equal(zero.snapshotRevision, 0);
  assert.equal(zero.integrityDigest, ZERO_DIGEST);
  assert.equal(zero.payload, null);
  assert.equal(Object.getPrototypeOf(zero), null);
  assert.equal(Object.isFrozen(zero), true);

  const firstInput = casInput(
    "transaction.kernel.0001",
    zero,
    JSON.parse('{"__proto__":{"polluted":true},"constructor":{"safe":true},"threads":[],"marker":"alpha"}')
  );
  const first = await kernel.compareAndSwapSnapshot(firstInput);
  assert.equal(first.outcome, "committed");
  assert.equal(first.snapshot.snapshotRevision, 1);
  assert.equal(first.snapshot.previousIntegrityDigest, ZERO_DIGEST);
  assert.equal(first.snapshot.lastCommit.baseSnapshotRevision, 0);
  assert.equal(first.snapshot.lastCommit.baseIntegrityDigest, ZERO_DIGEST);
  assert.equal(first.snapshot.lastCommit.resultSnapshotRevision, 1);
  assertExactFrozenNullFields(first.snapshot, SNAPSHOT_KEYS);
  assertExactFrozenNullFields(first.snapshot.lastCommit, LAST_COMMIT_KEYS);
  assert.equal(Object.isFrozen(first.snapshot.payload), true);
  assert.equal(Object.getPrototypeOf(first.snapshot.payload), null);
  assert.equal(Object.prototype.hasOwnProperty.call(first.snapshot.payload, "__proto__"), true);
  assert.equal({}.polluted, undefined);
  const replay = await kernel.compareAndSwapSnapshot(firstInput);
  assert.equal(replay.outcome, "replayed");
  assert.equal(replay.snapshot.integrityDigest, first.snapshot.integrityDigest);
  const beforeTransactionConflict = await fs.readFile(fixture.snapshotPath, "utf8");
  await expectCode(
    () => kernel.compareAndSwapSnapshot(Object.freeze({
      ...firstInput,
      requestDigest: contractDigest({ changed: true }),
    })),
    "INTEGRATION_REPOSITORY_KERNEL_TRANSACTION_CONFLICT",
    fixture.rootPath
  );
  assert.equal(await fs.readFile(fixture.snapshotPath, "utf8"), beforeTransactionConflict);

  const secondInput = casInput(
    "transaction.kernel.0002",
    first.snapshot,
    nullRecord({ threads: Object.freeze([nullRecord({ id: "thread-1", state: "open" })]), marker: "beta" })
  );
  const second = await kernel.compareAndSwapSnapshot(secondInput);
  assert.equal(second.outcome, "committed");
  assert.equal(second.snapshot.snapshotRevision, 2);
  assert.equal(second.snapshot.previousIntegrityDigest, first.snapshot.integrityDigest);
  const beforeStale = await fs.readFile(fixture.snapshotPath, "utf8");
  await expectCode(
    () => kernel.compareAndSwapSnapshot(firstInput),
    "INTEGRATION_REPOSITORY_KERNEL_CONFLICT",
    fixture.rootPath
  );
  assert.equal(await fs.readFile(fixture.snapshotPath, "utf8"), beforeStale);
  await expectCode(
    () => kernel.compareAndSwapSnapshot(casInput(
      "transaction.kernel.stale",
      first.snapshot,
      nullRecord({ marker: "stale" })
    )),
    "INTEGRATION_REPOSITORY_KERNEL_CONFLICT",
    fixture.rootPath
  );
  assert.equal((await kernel.loadSnapshot()).integrityDigest, second.snapshot.integrityDigest);

  const concurrentA = casInput("transaction.kernel.concurrent.a", second.snapshot, nullRecord({ winner: "a" }));
  const concurrentB = casInput("transaction.kernel.concurrent.b", second.snapshot, nullRecord({ winner: "b" }));
  const concurrent = await Promise.allSettled([
    kernel.compareAndSwapSnapshot(concurrentA),
    kernel.compareAndSwapSnapshot(concurrentB),
  ]);
  assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(concurrent.find((entry) => entry.status === "rejected").reason.publicCode,
    "INTEGRATION_REPOSITORY_KERNEL_CONFLICT");
  const head = await kernel.loadSnapshot();
  assert.equal(head.snapshotRevision, 3);

  const raw = await fs.readFile(fixture.snapshotPath, "utf8");
  verifyPersistedEnvelope(raw, head);
  assert.equal(JSON.parse(raw).integrityDigest, head.integrityDigest);
  return head;
}

async function runInvalidInputChecks(fixture, kernel, current) {
  let inputTrapHits = 0;
  const inputProxy = new Proxy({}, {
    get() { inputTrapHits += 1; throw new Error("input proxy get"); },
    ownKeys() { inputTrapHits += 1; throw new Error("input proxy ownKeys"); },
  });
  await expectCode(
    () => kernel.compareAndSwapSnapshot(inputProxy),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  assert.equal(inputTrapHits, 0);
  let inputGetterHits = 0;
  const accessorInput = { ...casInput("transaction.invalid.input.accessor", current, { valid: true }) };
  Object.defineProperty(accessorInput, "payload", {
    enumerable: true,
    get() { inputGetterHits += 1; throw new Error("input getter"); },
  });
  await expectCode(
    () => kernel.compareAndSwapSnapshot(accessorInput),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  assert.equal(inputGetterHits, 0);
  const symbolInput = { ...casInput("transaction.invalid.input.symbol", current, { valid: true }) };
  symbolInput[Symbol("unsupported")] = true;
  await expectCode(
    () => kernel.compareAndSwapSnapshot(symbolInput),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  let inputThenHits = 0;
  const thenableInput = {
    ...casInput("transaction.invalid.input.thenable", current, { valid: true }),
    then() { inputThenHits += 1; },
  };
  await expectCode(
    () => kernel.compareAndSwapSnapshot(thenableInput),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  assert.equal(inputThenHits, 0);
  for (const payload of [null, [], Object.create({ inherited: true })]) {
    await expectCode(
      () => kernel.compareAndSwapSnapshot(casInput("transaction.invalid.payload.root", current, payload)),
      "INTEGRATION_REPOSITORY_KERNEL_INVALID",
      fixture.rootPath
    );
  }
  const invalidValues = [];
  const cycle = {};
  cycle.self = cycle;
  invalidValues.push(cycle);
  invalidValues.push({ list: new Array(2) });
  invalidValues.push({ custom: new Date(0) });
  invalidValues.push({ bad: undefined });
  invalidValues.push({ bad() {} });
  invalidValues.push({ bad: Symbol("bad") });
  invalidValues.push({ bad: 1n });
  invalidValues.push({ bad: Number.NaN });
  invalidValues.push({ bad: -0 });
  const symbolKey = { ok: true };
  symbolKey[Symbol("secret")] = true;
  invalidValues.push(symbolKey);
  for (let index = 0; index < invalidValues.length; index += 1) {
    await expectCode(
      () => kernel.compareAndSwapSnapshot(casInput(
        `transaction.invalid.${String(index).padStart(4, "0")}`,
        current,
        invalidValues[index]
      )),
      "INTEGRATION_REPOSITORY_KERNEL_INVALID",
      fixture.rootPath
    );
  }

  let getterHits = 0;
  const accessorPayload = {};
  Object.defineProperty(accessorPayload, "private-root-token", {
    enumerable: true,
    get() { getterHits += 1; throw new Error("secret getter"); },
  });
  const accessorError = await expectCode(
    () => kernel.compareAndSwapSnapshot(casInput("transaction.invalid.accessor", current, accessorPayload)),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  assert.equal(getterHits, 0);
  assert.equal(publicErrorText(accessorError).includes("private-root-token"), false);

  let proxyHits = 0;
  const nestedProxy = new Proxy({}, {
    get() { proxyHits += 1; throw new Error("proxy getter"); },
    ownKeys() { proxyHits += 1; throw new Error("proxy ownKeys"); },
  });
  await expectCode(
    () => kernel.compareAndSwapSnapshot(casInput(
      "transaction.invalid.proxy",
      current,
      { nested: nestedProxy }
    )),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  assert.equal(proxyHits, 0);

  let thenHits = 0;
  const thenable = {};
  Object.defineProperty(thenable, "then", {
    configurable: false,
    enumerable: true,
    writable: false,
    value() { thenHits += 1; },
  });
  await expectCode(
    () => kernel.compareAndSwapSnapshot(casInput(
      "transaction.invalid.thenable",
      current,
      { nested: thenable }
    )),
    "INTEGRATION_REPOSITORY_KERNEL_INVALID",
    fixture.rootPath
  );
  assert.equal(thenHits, 0);

  let deep = { leaf: true };
  for (let index = 0; index <= INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_DEPTH; index += 1) {
    deep = { nested: deep };
  }
  await expectCode(
    () => kernel.compareAndSwapSnapshot(casInput("transaction.full.depth", current, deep)),
    "INTEGRATION_REPOSITORY_KERNEL_FULL",
    fixture.rootPath
  );

  const tooManyKeys = Object.create(null);
  for (let index = 0; index < INTEGRATION_RETAINED_REPOSITORY_MAX_JSON_NODES; index += 1) {
    tooManyKeys[`k${index}`] = null;
  }
  await expectCode(
    () => kernel.compareAndSwapSnapshot(casInput("transaction.full.nodes", current, tooManyKeys)),
    "INTEGRATION_REPOSITORY_KERNEL_FULL",
    fixture.rootPath
  );
  await expectCode(
    () => kernel.compareAndSwapSnapshot(casInput(
      "transaction.full.bytes",
      current,
      { huge: "x".repeat(fixture.expected.maxSnapshotBytes) }
    )),
    "INTEGRATION_REPOSITORY_KERNEL_FULL",
    fixture.rootPath
  );
}

async function runPromiseAndFifoChecks(fixture, kernel, current) {
  const holder = await storageApi.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
  const entered = deferred();
  const release = deferred();
  const holding = holder.runExclusive(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const blockedAhead = kernel.loadSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const speciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  const constructorDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor");
  const arrayMethods = Object.freeze({
    map: Object.getOwnPropertyDescriptor(Array.prototype, "map"),
    sort: Object.getOwnPropertyDescriptor(Array.prototype, "sort"),
    join: Object.getOwnPropertyDescriptor(Array.prototype, "join"),
  });
  let trapHits = 0;
  let queued;
  try {
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get() { trapHits += 1; throw new Error("species trap"); },
    });
    Object.defineProperty(Promise.prototype, "constructor", {
      configurable: true,
      get() { trapHits += 1; throw new Error("constructor trap"); },
    });
    for (const method of ["map", "sort", "join"]) {
      Object.defineProperty(Array.prototype, method, {
        configurable: true,
        writable: true,
        value() { trapHits += 1; throw new Error("array prototype trap"); },
      });
    }
    queued = kernel.compareAndSwapSnapshot(casInput(
      "transaction.promise.poison",
      current,
      { safe: [1, 2, 3] }
    ));
  } finally {
    Object.defineProperty(Promise, Symbol.species, speciesDescriptor);
    Object.defineProperty(Promise.prototype, "constructor", constructorDescriptor);
    for (const method of ["map", "sort", "join"]) {
      Object.defineProperty(Array.prototype, method, arrayMethods[method]);
    }
    release.resolve();
  }
  assert.equal((await blockedAhead).integrityDigest, current.integrityDigest);
  const committed = await queued;
  await holding;
  assert.equal(committed.outcome, "committed");
  assert.equal(trapHits, 0);

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const now = committed.snapshot;
  try {
    void kernel.compareAndSwapSnapshot(casInput(
      "transaction.ignored.rejection",
      current,
      { ignored: true }
    ));
    const continued = await kernel.compareAndSwapSnapshot(casInput(
      "transaction.fifo.continues",
      now,
      { continued: true }
    ));
    assert.equal(continued.outcome, "committed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(unhandled, []);
    return continued.snapshot;
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

async function runCrossFactorySerialization(rootPath) {
  const fixture = await openFixture(rootPath, "repository-kernel-cross-factory");
  try {
    const secondLock = await storageApi.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
    const first = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    const second = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, secondLock, fixture.expected);
    const zero = await first.loadSnapshot();
    const outcomes = await Promise.allSettled([
      first.compareAndSwapSnapshot(casInput("transaction.cross.factory.a", zero, { from: "a" })),
      second.compareAndSwapSnapshot(casInput("transaction.cross.factory.b", zero, { from: "b" })),
    ]);
    assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(outcomes.find((entry) => entry.status === "rejected").reason.publicCode,
      "INTEGRATION_REPOSITORY_KERNEL_CONFLICT");
    assert.equal((await first.loadSnapshot()).snapshotRevision, 1);
    assert.equal((await second.loadSnapshot()).snapshotRevision, 1);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runPendingWeightCaps(smokeRoot) {
  const cases = [
    Object.freeze({
      name: "bytes",
      maxSnapshotBytes: 4 * 1024 * 1024,
      makePayload: (index) => ({ index, blob: "x".repeat(3_500_000) }),
      acceptedCount: 9,
    }),
    Object.freeze({
      name: "nodes",
      maxSnapshotBytes: 256 * 1024,
      makePayload: (index) => ({ index, nodes: new Array(19_000).fill(null) }),
      acceptedCount: 10,
    }),
  ];
  for (const testCase of cases) {
    const fixture = await openFixture(
      path.join(smokeRoot, `pending-${testCase.name}`),
      `repository-kernel-pending-${testCase.name}`,
      { maxSnapshotBytes: testCase.maxSnapshotBytes, lockWaitMs: 5000 }
    );
    try {
      const holder = await storageApi.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
      const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
      const zero = await kernel.loadSnapshot();
      const entered = deferred();
      const release = deferred();
      const holding = holder.runExclusive(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = [];
      for (let index = 0; index < testCase.acceptedCount; index += 1) {
        queued.push(kernel.compareAndSwapSnapshot(casInput(
          `transaction.pending.${testCase.name}.${String(index).padStart(4, "0")}`,
          zero,
          testCase.makePayload(index)
        )));
      }
      let firstSettled = false;
      void queued[0].then(
        () => { firstSettled = true; },
        () => { firstSettled = true; }
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(firstSettled, false);
      await expectCode(
        () => kernel.compareAndSwapSnapshot(casInput(
          `transaction.pending.${testCase.name}.overflow`,
          zero,
          testCase.makePayload(999)
        )),
        "INTEGRATION_REPOSITORY_KERNEL_BUSY",
        fixture.rootPath
      );
      release.resolve();
      await holding;
      const settled = await Promise.allSettled(queued);
      assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
      assert.equal(settled.filter((entry) => entry.status === "rejected").length, testCase.acceptedCount - 1);
      const head = await kernel.loadSnapshot();
      assert.equal(head.snapshotRevision, 1);
      const continued = await Promise.allSettled([
        kernel.compareAndSwapSnapshot(casInput(
          `transaction.pending.${testCase.name}.released.a`,
          head,
          testCase.makePayload(777)
        )),
        kernel.compareAndSwapSnapshot(casInput(
          `transaction.pending.${testCase.name}.released.b`,
          head,
          testCase.makePayload(778)
        )),
      ]);
      assert.equal(continued.filter((entry) => entry.status === "fulfilled").length, 1);
      assert.equal(continued.filter((entry) => entry.status === "rejected").length, 1);
      assert.equal((await kernel.loadSnapshot()).snapshotRevision, 2);
    } finally {
      await fixture.authority.close().catch(() => {});
    }
  }
}

async function installBadSnapshot(fixture, kind) {
  if (kind === "empty") {
    await fs.writeFile(fixture.snapshotPath, "", { mode: 0o600 });
  } else if (kind === "corrupt") {
    await fs.writeFile(fixture.snapshotPath, "{not-json}\n", { mode: 0o600 });
  } else if (kind === "symlink") {
    const target = path.join(fixture.dataPath, "symlink-target");
    await fs.writeFile(target, "{}\n", { mode: 0o600 });
    await fs.symlink(target, fixture.snapshotPath);
  } else if (kind === "hardlink") {
    const target = path.join(fixture.dataPath, "hardlink-target");
    await fs.writeFile(target, "{}\n", { mode: 0o600 });
    await fs.link(target, fixture.snapshotPath);
  } else if (kind === "fifo") {
    await execFileAsync("/usr/bin/mkfifo", [fixture.snapshotPath]);
    await fs.chmod(fixture.snapshotPath, 0o600);
  } else if (kind === "directory") {
    await fs.mkdir(fixture.snapshotPath, { mode: 0o700 });
  } else if (kind === "wrong-mode") {
    await fs.writeFile(fixture.snapshotPath, "{}\n", { mode: 0o644 });
    await fs.chmod(fixture.snapshotPath, 0o644);
  }
}

async function runInvalidSnapshotNodes(smokeRoot) {
  for (const kind of ["empty", "corrupt", "symlink", "hardlink", "fifo", "directory", "wrong-mode"]) {
    const rootPath = path.join(smokeRoot, `invalid-file-${kind}`);
    const dataPath = path.join(rootPath, "data:repository");
    await makeOwnerDirectory(rootPath);
    await makeOwnerDirectory(dataPath);
    await makeLockFile(path.join(dataPath, INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE));
    await installBadSnapshot({
      dataPath,
      snapshotPath: path.join(dataPath, INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_FILE),
    }, kind);
    const fixture = await openFixture(
      rootPath,
      `repository-kernel-invalid-${kind}`
    );
    try {
      const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
      await expectCode(
        () => Promise.race([
          kernel.loadSnapshot(),
          new Promise((resolve, reject) => setTimeout(() => reject(new Error("special-file read timed out")), 1500)),
        ]),
        "INTEGRATION_REPOSITORY_KERNEL_CORRUPT",
        fixture.rootPath
      );
      await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_POISONED", fixture.rootPath);
    } finally {
      await fixture.authority.close().catch(() => {});
    }
  }
}

async function runIntegrityTamper(smokeRoot) {
  const rootPath = path.join(smokeRoot, "integrity-tamper");
  let fixture = await openFixture(rootPath, "repository-kernel-integrity-tamper");
  try {
    const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    const zero = await kernel.loadSnapshot();
    await kernel.compareAndSwapSnapshot(casInput("transaction.tamper.seed", zero, { value: true }));
  } finally {
    await fixture.authority.close().catch(() => {});
  }
  const parsed = JSON.parse(await fs.readFile(fixture.snapshotPath, "utf8"));
  parsed.integrityDigest = "f".repeat(64);
  await fs.writeFile(fixture.snapshotPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  fixture = await openFixture(rootPath, "repository-kernel-integrity-tamper");
  try {
    const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_CORRUPT", fixture.rootPath);
    await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_POISONED", fixture.rootPath);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runPointerReopen(rootPath) {
  let fixture = await openFixture(rootPath, "repository-kernel-pointer");
  let pointer;
  let admissionBinding;
  let expectedHead;
  try {
    const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    pointer = kernel.attestation.pointerDigest;
    admissionBinding = kernel.attestation.admissionBindingDigest;
    const zero = await kernel.loadSnapshot();
    expectedHead = (await kernel.compareAndSwapSnapshot(casInput(
      "transaction.pointer.seed",
      zero,
      { persistent: true }
    ))).snapshot;
  } finally {
    await fixture.authority.close().catch(() => {});
  }
  fixture = await openFixture(rootPath, "repository-kernel-pointer");
  try {
    const reopened = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    assert.equal(reopened.attestation.pointerDigest, pointer);
    assert.notEqual(reopened.attestation.admissionBindingDigest, admissionBinding);
    const loaded = await reopened.loadSnapshot();
    assert.equal(loaded.integrityDigest, expectedHead.integrityDigest);
    assert.deepEqual(loaded.payload, expectedHead.payload);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runObservedDeletion(smokeRoot) {
  const fixture = await openFixture(path.join(smokeRoot, "observed-deletion"), "repository-kernel-observed-deletion");
  try {
    const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    const zero = await kernel.loadSnapshot();
    await kernel.compareAndSwapSnapshot(casInput("transaction.observed.seed", zero, { exists: true }));
    await fs.unlink(fixture.snapshotPath);
    await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_CORRUPT", fixture.rootPath);
    await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_POISONED", fixture.rootPath);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runObservedRollback(smokeRoot) {
  const fixture = await openFixture(path.join(smokeRoot, "observed-rollback"), "repository-kernel-observed-rollback");
  try {
    const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    const zero = await kernel.loadSnapshot();
    const first = (await kernel.compareAndSwapSnapshot(casInput(
      "transaction.rollback.first",
      zero,
      { revision: 1 }
    ))).snapshot;
    const validRevisionOne = await fs.readFile(fixture.snapshotPath, "utf8");
    const second = (await kernel.compareAndSwapSnapshot(casInput(
      "transaction.rollback.second",
      first,
      { revision: 2 }
    ))).snapshot;
    assert.equal(second.snapshotRevision, 2);
    await fs.writeFile(fixture.snapshotPath, validRevisionOne, { mode: 0o600 });
    await fs.chmod(fixture.snapshotPath, 0o600);
    await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_CORRUPT", fixture.rootPath);
    await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_POISONED", fixture.rootPath);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runSemanticTamper(smokeRoot) {
  const rootPath = path.join(smokeRoot, "semantic-tamper");
  let fixture = await openFixture(rootPath, "repository-kernel-semantic-tamper");
  try {
    const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    const zero = await kernel.loadSnapshot();
    await kernel.compareAndSwapSnapshot(casInput("transaction.semantic.seed", zero, { value: "sealed" }));
  } finally {
    await fixture.authority.close().catch(() => {});
  }
  const parsed = JSON.parse(await fs.readFile(fixture.snapshotPath, "utf8"));
  parsed.lastCommit.resultSnapshotRevision = parsed.snapshotRevision + 1;
  parsed.lastCommit.commitDigest = contractDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_LAST_COMMIT_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(parsed.lastCommit, "commitDigest"),
  });
  parsed.integrityDigest = contractDigest({
    domain: INTEGRATION_RETAINED_REPOSITORY_SNAPSHOT_INTEGRITY_DOMAIN,
    securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
    payload: digestWithout(parsed, "integrityDigest"),
  });
  await fs.writeFile(fixture.snapshotPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  fixture = await openFixture(rootPath, "repository-kernel-semantic-tamper");
  try {
    const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_CORRUPT", fixture.rootPath);
    await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_POISONED", fixture.rootPath);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
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
  const fixture = await openFixture(rootPath, "repository-kernel-fault");
  try {
    const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    const current = await kernel.loadSnapshot();
    const input = casInput(`transaction.fault.${mode}`, nullRecord({
      snapshotRevision: 0,
      integrityDigest: ZERO_DIGEST,
    }), { mode });
    if (mode === "rename-before" || mode === "compound-prewrite-lock-release") {
      assert.equal(current.snapshotRevision, 0);
      const committed = await kernel.compareAndSwapSnapshot(input);
      assert.equal(committed.outcome, "committed");
      assert.equal(committed.snapshot.snapshotRevision, 1);
    } else {
      assert.equal(current.snapshotRevision, 1);
      const replayed = await kernel.compareAndSwapSnapshot(input);
      assert.equal(replayed.outcome, "replayed");
      assert.equal(replayed.snapshot.integrityDigest, current.integrityDigest);
    }
  } finally {
    await fixture.authority.close().catch(() => {});
  }
  process.stdout.write(`integration retained repository kernel recovery ${mode}: ok\n`);
}

async function runFaultMode(mode) {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), `aginti-repository-kernel-${mode}-`));
  const rootPath = path.join(smokeRoot, "root");
  let fixture;
  try {
    fixture = await openFixture(rootPath, "repository-kernel-fault");
    fault.snapshotPath = fixture.snapshotPath;
    fault.lockPath = fixture.lockPath;
    const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
    const zero = await kernel.loadSnapshot();
    const input = casInput(`transaction.fault.${mode}`, zero, { mode });
    fault.armed = true;
    if (mode === "lock-release-load") {
      const unavailable = await expectCode(
        () => kernel.loadSnapshot(),
        "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
        smokeRoot
      );
      assert.equal(unavailable.details.writeAttempted, false);
      assert.equal(unavailable.details.writeConfirmed, false);
      assert.equal(unavailable.details.storagePhase, "lock-handle-close");
      await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_POISONED", smokeRoot);
      process.stdout.write(`integration retained repository kernel ${mode} mock: ok\n`);
      return;
    }
    const expectedCode = mode === "prewrite" || mode === "compound-prewrite-lock-release"
      ? "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE"
      : "INTEGRATION_REPOSITORY_KERNEL_COMMIT_AMBIGUOUS";
    const problem = await expectCode(() => kernel.compareAndSwapSnapshot(input), expectedCode, smokeRoot);
    assert.equal(problem.details.writeAttempted, true);
    if (mode === "prewrite") {
      assert.equal(problem.details.writeConfirmed, false);
      assert.equal((await kernel.loadSnapshot()).snapshotRevision, 0);
      const committed = await kernel.compareAndSwapSnapshot(input);
      assert.equal(committed.outcome, "committed");
      assert.equal(committed.snapshot.snapshotRevision, 1);
      process.stdout.write(`integration retained repository kernel ${mode} mock: ok\n`);
      return;
    } else {
      assert.equal(problem.details.operationStarted, true);
      assert.equal(problem.details.operationSettled, true);
      if (mode === "rename-after") {
        assert.equal(problem.details.writeConfirmed, false);
        assert.equal(problem.details.renamed, false);
        assert.equal(problem.details.directorySynced, true);
        assert.equal(problem.details.postRenameSyncFailed, false);
      }
      if (mode === "rename-before") {
        assert.equal(problem.details.writeConfirmed, false);
        assert.equal(problem.details.commitMayHaveOccurred, true);
        assert.equal(problem.details.renamed, false);
        assert.equal(problem.details.directorySynced, true);
        assert.equal(problem.details.postRenameSyncFailed, false);
      }
      if (mode === "post-rename-recheck") {
        assert.equal(problem.details.writeConfirmed, false);
        assert.equal(problem.details.renamed, true);
        assert.equal(problem.details.directorySynced, true);
        assert.equal(problem.details.postRenameSyncFailed, false);
      }
      if (mode === "postwrite-read") {
        assert.equal(problem.details.writeConfirmed, true);
        assert.equal(problem.details.postWriteVerified, false);
      }
      if (mode === "lock-release-commit") {
        assert.equal(problem.details.writeConfirmed, true);
        assert.equal(problem.details.postWriteVerified, true);
        assert.equal(problem.details.operationFailed, false);
        assert.equal(problem.details.storagePhase, "lock-handle-close");
      }
      if (mode === "compound-rename-lock-release") {
        assert.equal(problem.details.writeConfirmed, false);
        assert.equal(problem.details.commitMayHaveOccurred, true);
        assert.equal(problem.details.storagePhase, "lock-handle-close");
      }
      if (mode === "compound-prewrite-lock-release") {
        assert.equal(problem.details.writeConfirmed, false);
        assert.equal(problem.details.commitMayHaveOccurred, false);
        assert.equal(problem.details.storagePhase, "lock-handle-close");
      }
      await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_POISONED", smokeRoot);
    }
    await fixture.authority.close().catch(() => {});
    fixture = null;
    const { stdout } = await execFileAsync(process.execPath, recoveryArguments(rootPath, mode), {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert.match(stdout, new RegExp(`recovery ${mode}: ok`, "u"));
  } finally {
    await fixture?.authority.close().catch(() => {});
    fsMock?.restore();
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write(`integration retained repository kernel ${mode} mock: ok\n`);
}

async function runCloseGate(rootPath) {
  const fixture = await openFixture(rootPath, "repository-kernel-close-gate");
  const kernel = createRetainedIntegrationRuntimeRepositoryKernel(fixture.files, fixture.lock, fixture.expected);
  await fixture.authority.close();
  assert.equal(kernel.isClosed(), true);
  await expectCode(() => kernel.loadSnapshot(), "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE", rootPath);
  await expectCode(
    () => kernel.compareAndSwapSnapshot(casInput(
      "transaction.closed.kernel",
      nullRecord({ snapshotRevision: 0, integrityDigest: ZERO_DIGEST }),
      { closed: true }
    )),
    "INTEGRATION_REPOSITORY_KERNEL_UNAVAILABLE",
    rootPath
  );
}

async function runStaticBoundaryChecks() {
  const source = await fs.readFile(new URL("../src/integration-runtime-repository.js", import.meta.url), "utf8");
  const config = await fs.readFile(new URL("../src/integration-config.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'].+integration-(?:runtime-authority|server|session|api|native-executor)/u);
  assert.doesNotMatch(source, /createAgintiIntegrationRuntimeAuthority|createIntegrationServer|createNativeIntegrationSessionService/u);
  assert.match(source, /runtimeCapabilityEnabled:\s*false/u);
  assert.match(source, /runtimeWiringIncluded:\s*false/u);
  assert.match(config, /capability:\s*Object\.freeze\(\{ enabled: false \}\)/u);
}

async function runCore() {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-repository-kernel-smoke-"));
  let mainFixture;
  try {
    await runStaticBoundaryChecks();
    mainFixture = await openFixture(path.join(smokeRoot, "main"), "repository-kernel-main");
    const kernel = createRetainedIntegrationRuntimeRepositoryKernel(
      mainFixture.files,
      mainFixture.lock,
      mainFixture.expected
    );
    await runBrandAndBindingChecks(mainFixture, kernel);
    let head = await runCasChecks(mainFixture, kernel);
    await runInvalidInputChecks(mainFixture, kernel, head);
    head = await runPromiseAndFifoChecks(mainFixture, kernel, head);
    assert.equal((await kernel.loadSnapshot()).integrityDigest, head.integrityDigest);
    assert.deepEqual(
      (await fs.readdir(mainFixture.dataPath)).filter((name) => name.startsWith(".aginti-atomic-v1-")),
      []
    );
    await mainFixture.authority.close();
    assert.equal(kernel.isClosed(), true);
    mainFixture = null;

    await runCrossFactorySerialization(path.join(smokeRoot, "cross-factory"));
    await runPendingWeightCaps(smokeRoot);
    await runInvalidSnapshotNodes(smokeRoot);
    await runIntegrityTamper(smokeRoot);
    await runSemanticTamper(smokeRoot);
    await runObservedDeletion(smokeRoot);
    await runObservedRollback(smokeRoot);
    await runPointerReopen(path.join(smokeRoot, "pointer-reopen"));
    await runCloseGate(path.join(smokeRoot, "close-gate"));

    for (const mode of FAULT_MODES) {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--experimental-test-module-mocks", fileURLToPath(import.meta.url), `--mock-mode=${mode}`],
        { timeout: 45_000, maxBuffer: 1024 * 1024 }
      );
      assert.match(stdout, new RegExp(`repository kernel ${mode} mock: ok`, "u"));
    }
  } finally {
    await mainFixture?.authority.close().catch(() => {});
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write("integration retained repository kernel smoke: ok\n");
}

const recoveryRoot = String(process.argv.find((value) => value.startsWith("--recovery-root=")) || "").slice(16);
const recoveryMode = String(process.argv.find((value) => value.startsWith("--recovery-mode=")) || "").slice(16);
if (recoveryRoot) {
  await runRecoveryMode(recoveryRoot, recoveryMode);
} else if (MODE) {
  await runFaultMode(MODE);
} else {
  await runCore();
}
