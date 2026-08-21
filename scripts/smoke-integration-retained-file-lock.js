#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile, spawn as spawnChild } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertRetainedRegularFileLock,
  createRetainedProtectedFilePrimitives,
  openRetainedRegularFileLock,
} from "../src/integration-durable-common.js";
import { contractDigest } from "../src/integration-policy.js";
import {
  INTEGRATION_RETAINED_REGULAR_FILE_LOCK_ATTESTATION_VERSION,
  INTEGRATION_RETAINED_REGULAR_FILE_LOCK_VERSION,
  assertIntegrationRetainedRegularFileLock,
  createIntegrationRetainedFilePrimitives,
  openIntegrationRetainedRegularFileLock,
  openIntegrationStorageAuthority,
} from "../src/integration-storage-authority.js";

const UID = process.getuid();
const GID = process.getgid();
const LOCK_NAME = ".aginti-flock-v1-smoke";
const HELPER_PATH = "/usr/bin/flock";
const execFileAsync = promisify(execFile);
const CHILD_MODE = String(process.argv.find((value) => value.startsWith("--child-mode=")) || "").slice(13);
const CHILD_ROOT = String(process.argv.find((value) => value.startsWith("--child-root=")) || "").slice(13);
const MOCK_MODE = String(process.argv.find((value) => value.startsWith("--mock-mode=")) || "").slice(12);
const LOCK_SURFACE_KEYS = Object.freeze(["schemaVersion", "attestation", "runExclusive", "isClosed"]);
const LOCK_ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "role",
  "canonicalPath",
  "rootIdentityDigest",
  "relativeSegments",
  "relativePointer",
  "directoryIdentityDigest",
  "lockFileNameDigest",
  "lockFileIdentityDigest",
  "lockFileMode",
  "lockFileEmpty",
  "kernelPrimitive",
  "helperIdentityDigest",
  "helperSha256",
  "advisoryExclusive",
  "crashRelease",
  "lockFileMutation",
  "limitations",
  "digest",
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
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

async function helperExpected() {
  const bytes = await fs.readFile(HELPER_PATH);
  return Object.freeze({
    helperSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    helperIdentityDigest: identityDigest(await fs.stat(HELPER_PATH, { bigint: true })),
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

async function fdTargetsContaining(text) {
  const names = await fs.readdir("/proc/self/fd");
  const targets = [];
  for (const name of names) {
    const target = await fs.readlink(`/proc/self/fd/${name}`).catch(() => "");
    if (target.includes(text)) targets.push(target);
  }
  return targets.sort();
}

function assertExactFrozenSurface(surface, keys) {
  assert.equal(Object.isFrozen(surface), true);
  assert.equal(Object.getPrototypeOf(surface), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(surface), keys);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(surface, key);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.configurable, false);
    assert.equal(Object.prototype.hasOwnProperty.call(descriptor, "value"), true);
  }
}

function publicErrorText(error) {
  return JSON.stringify({
    code: error?.publicCode || error?.code || "",
    message: error?.message || "",
    details: error?.details || {},
  });
}

async function expectCode(action, code, forbiddenRoot = "") {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
    if (error?.publicCode === code || error?.code === code || (Array.isArray(code) && code.includes(error?.publicCode))) {
      const exposed = publicErrorText(error);
      assert.equal(exposed.includes("/proc/self/fd"), false);
      assert.equal(exposed.includes(HELPER_PATH), false);
      assert.equal(/"fd"\s*:/u.test(exposed), false);
      if (forbiddenRoot) assert.equal(exposed.includes(forbiddenRoot), false);
      return error;
    }
  }
  if (!captured) assert.fail(`Expected ${code} rejection, but action completed.`);
  assert.fail(`Expected ${code}, got ${captured?.publicCode || captured?.code || captured?.name}: ${captured?.message}`);
}

async function openBase(api, rootPath, role, { lockName = LOCK_NAME, expectedIdentity = null } = {}) {
  const authority = await api.openIntegrationStorageAuthority({
    rootPath,
    role,
    ownerUid: UID,
    ownerGid: GID,
    label: "retained flock smoke",
  });
  const directory = await authority.openDirectory(["data"]);
  const directoryIdentity = await directory.identity();
  const expectedDirectory = Object.freeze({
    role,
    canonicalPath: rootPath,
    rootIdentityDigest: authority.attestation.rootIdentityDigest,
    relativeSegments: Object.freeze(["data"]),
    directoryIdentityDigest: directoryIdentity.digest,
  });
  const files = api.createIntegrationRetainedFilePrimitives(directory, expectedDirectory);
  const helper = await helperExpected();
  const lockPath = path.join(rootPath, "data", lockName);
  const lockFileIdentityDigest = expectedIdentity || identityDigest(await fs.stat(lockPath, { bigint: true }));
  const expected = Object.freeze({
    ...expectedDirectory,
    lockFileName: lockName,
    helperSha256: helper.helperSha256,
    lockFileIdentityDigest,
    helperIdentityDigest: helper.helperIdentityDigest,
  });
  return Object.freeze({ authority, directory, files, expected, lockPath, rootPath });
}

async function openFixture(api, rootPath, role) {
  await makeOwnerDirectory(path.join(rootPath, "data"));
  await makeLockFile(path.join(rootPath, "data", LOCK_NAME));
  const base = await openBase(api, rootPath, role);
  const lock = await api.openIntegrationRetainedRegularFileLock(base.files, base.expected);
  return Object.freeze({ ...base, lock });
}

async function waitForLine(stream, line, timeoutMs = 3000) {
  let text = "";
  return withTimeout(new Promise((resolve, reject) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      text += chunk;
      if (text.includes(line)) resolve(text);
    });
    stream.on("error", reject);
  }), timeoutMs, `waiting for ${line}`);
}

async function runHoldingChild() {
  const fixture = await openBase(
    { openIntegrationStorageAuthority, createIntegrationRetainedFilePrimitives },
    CHILD_ROOT,
    "cross-process"
  );
  const lock = await openIntegrationRetainedRegularFileLock(fixture.files, fixture.expected);
  await lock.runExclusive(async () => {
    process.stdout.write("LOCKED\n");
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }, { waitMs: 1000 });
}

async function runHelperFailureMock() {
  const { mock } = await import("node:test");
  const { EventEmitter } = await import("node:events");
  const childMock = mock.module("node:child_process", {
    namedExports: {
      spawn() {
        const child = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 17, null));
        return child;
      },
    },
  });
  const api = await import(new URL(`../src/integration-storage-authority.js?helper-failure=${Date.now()}`, import.meta.url));
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-flock-helper-failure-"));
  let fixture = null;
  try {
    fixture = await openFixture(api, path.join(smokeRoot, "root"), "helper-failure");
    let called = false;
    await expectCode(() => fixture.lock.runExclusive(async () => { called = true; }), "INTEGRATION_STORAGE_LOCK_UNAVAILABLE", smokeRoot);
    assert.equal(called, false);
    assert.equal(await fs.readFile(fixture.lockPath, "utf8"), "");
  } finally {
    await fixture?.authority.close().catch(() => {});
    childMock.restore();
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
}

async function runCloseFailureMock() {
  const { mock } = await import("node:test");
  const realFs = (await import("node:fs/promises")).default;
  const state = { failLockClose: false };
  const mockFs = { ...realFs };
  mockFs.open = async (target, flags, ...args) => {
    const handle = await realFs.open(target, flags, ...args);
    if (!String(target).endsWith(`/${LOCK_NAME}`)) return handle;
    return {
      get fd() { return handle.fd; },
      stat: handle.stat.bind(handle),
      async close() {
        if (state.failLockClose) {
          state.lockCloseCalls = Number(state.lockCloseCalls || 0) + 1;
          state.failLockClose = false;
          await handle.close();
          throw new Error("synthetic /proc/self/fd/998 close failure");
        }
        await handle.close();
      },
    };
  };
  const fsMock = mock.module("node:fs/promises", { defaultExport: mockFs });
  const api = await import(new URL(`../src/integration-storage-authority.js?close-failure=${Date.now()}`, import.meta.url));
  const smokeRoot = await realFs.mkdtemp(path.join(os.tmpdir(), "aginti-flock-close-failure-"));
  let fixture = null;
  try {
    fixture = await openFixture(api, path.join(smokeRoot, "root"), "close-failure");
    state.failLockClose = true;
    const ambiguous = await expectCode(
      () => fixture.lock.runExclusive(async () => "ran"),
      "INTEGRATION_STORAGE_LOCK_RELEASE_AMBIGUOUS",
      smokeRoot
    );
    assert.equal(ambiguous.details.operationStarted, true);
    assert.equal(ambiguous.details.operationSettled, true);
    assert.equal(ambiguous.details.operationFailed, false);
    assert.equal(state.lockCloseCalls, 1);
    await expectCode(() => fixture.lock.runExclusive(async () => {}), "INTEGRATION_STORAGE_LOCK_POISONED", smokeRoot);
  } finally {
    await fixture?.authority.close().catch(() => {});
    fsMock.restore();
    await realFs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
}

async function runPreOperationCloseFailureMock(mode) {
  const { mock } = await import("node:test");
  const { EventEmitter } = await import("node:events");
  const realFs = (await import("node:fs/promises")).default;
  const conflictClose = mode === "conflict-close-failure";
  assert.equal(conflictClose || mode === "helper-close-failure", true);
  const state = { closeCalls: 0, failNextClose: false };
  const mockFs = { ...realFs };
  mockFs.open = async (target, flags, ...args) => {
    const handle = await realFs.open(target, flags, ...args);
    const targetText = String(target);
    const shouldWrap = conflictClose
      ? targetText.endsWith(`/${LOCK_NAME}`)
      : targetText === HELPER_PATH;
    if (!shouldWrap) return handle;
    return {
      get fd() { return handle.fd; },
      stat: handle.stat.bind(handle),
      read: handle.read.bind(handle),
      async close() {
        state.closeCalls += 1;
        if (state.failNextClose) {
          state.failNextClose = false;
          await handle.close();
          throw new Error("synthetic /proc/self/fd/997 close failure");
        }
        await handle.close();
      },
    };
  };
  const fsMock = mock.module("node:fs/promises", { defaultExport: mockFs });
  const childMock = mock.module("node:child_process", {
    namedExports: {
      spawn() {
        const child = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", conflictClose ? 42 : 0, null));
        return child;
      },
    },
  });
  const api = await import(new URL(`../src/integration-storage-authority.js?${mode}=${Date.now()}`, import.meta.url));
  const smokeRoot = await realFs.mkdtemp(path.join(os.tmpdir(), `aginti-flock-${mode}-`));
  let fixture = null;
  try {
    fixture = await openFixture(api, path.join(smokeRoot, "root"), mode);
    const baselineCloseCalls = state.closeCalls;
    state.failNextClose = true;
    let called = false;
    const cleanupFailure = await expectCode(
      () => fixture.lock.runExclusive(async () => { called = true; }, { waitMs: 0 }),
      "INTEGRATION_STORAGE_LOCK_CLEANUP_FAILED",
      smokeRoot
    );
    assert.equal(called, false);
    assert.equal(state.closeCalls - baselineCloseCalls, 1);
    assert.equal(cleanupFailure.details.phase, conflictClose ? "acquire" : "post-acquire-pre-operation");
    await expectCode(() => fixture.lock.runExclusive(async () => {}), "INTEGRATION_STORAGE_LOCK_POISONED", smokeRoot);
  } finally {
    await fixture?.authority.close().catch(() => {});
    childMock.restore();
    fsMock.restore();
    await realFs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
}

async function runMockProcesses() {
  for (const mode of [
    "helper-failure",
    "close-failure",
    "conflict-close-failure",
    "helper-close-failure",
  ]) {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-test-module-mocks", fileURLToPath(import.meta.url), `--mock-mode=${mode}`],
      { timeout: 20_000, maxBuffer: 1024 * 1024 }
    );
    assert.match(stdout, new RegExp(`integration retained file lock ${mode} mock: ok`, "u"));
  }
}

async function runInvalidLockFixtures(smokeRoot) {
  const cases = [
    ["nonempty", async (lockPath) => fs.writeFile(lockPath, "owner", { mode: 0o600 })],
    ["wrong-mode", async (lockPath) => { await makeLockFile(lockPath); await fs.chmod(lockPath, 0o644); }],
    ["directory", async (lockPath) => makeOwnerDirectory(lockPath)],
    ["fifo", async (lockPath) => execFileAsync("mkfifo", [lockPath])],
    ["symlink", async (lockPath, dataPath) => { const outside = path.join(path.dirname(dataPath), "outside"); await makeLockFile(outside); await fs.symlink(outside, lockPath); }],
    ["hardlink", async (lockPath, dataPath) => { const outside = path.join(path.dirname(dataPath), "outside-hard"); await makeLockFile(outside); await fs.link(outside, lockPath); }],
  ];
  for (const [name, provision] of cases) {
    const rootPath = path.join(smokeRoot, `invalid-${name}`);
    const dataPath = path.join(rootPath, "data");
    await makeOwnerDirectory(dataPath);
    const lockPath = path.join(dataPath, LOCK_NAME);
    await provision(lockPath, dataPath);
    const base = await openBase(
      { openIntegrationStorageAuthority, createIntegrationRetainedFilePrimitives },
      rootPath,
      `invalid-${name}`
    );
    try {
      await expectCode(
        () => withTimeout(openIntegrationRetainedRegularFileLock(base.files, base.expected), 1500, `${name} factory`),
        ["INTEGRATION_STORAGE_LOCK_CORRUPT", "INTEGRATION_STORAGE_LOCK_UNAVAILABLE"],
        smokeRoot
      );
    } finally {
      await base.authority.close().catch(() => {});
    }
  }
}

async function main() {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-flock-smoke-"));
  const authorities = [];
  try {
    const storageSource = await fs.readFile(new URL("../src/integration-storage-authority.js", import.meta.url), "utf8");
    const serverSource = await fs.readFile(new URL("../src/integration-server.js", import.meta.url), "utf8");
    const eventSource = await fs.readFile(new URL("../src/integration-event-ledger-store.js", import.meta.url), "utf8");
    const idempotencySource = await fs.readFile(new URL("../src/integration-idempotency-store.js", import.meta.url), "utf8");
    assert.equal(storageSource.includes("node:test"), false);
    assert.equal(storageSource.includes("testHooks"), false);
    assert.match(serverSource, /export const INTEGRATION_MOUNT_CAPABILITY_ENABLED = false;/u);
    assert.equal(serverSource.includes("openRetainedRegularFileLock"), false);
    assert.equal(eventSource.includes("openRetainedRegularFileLock"), false);
    assert.equal(idempotencySource.includes("openRetainedRegularFileLock"), false);

    const fixture = await openFixture(
      { openIntegrationStorageAuthority, createIntegrationRetainedFilePrimitives, openIntegrationRetainedRegularFileLock },
      path.join(smokeRoot, "main"),
      "regular-lock"
    );
    authorities.push(fixture.authority);
    const alias = await openRetainedRegularFileLock(fixture.files, fixture.expected);
    assert.equal(assertIntegrationRetainedRegularFileLock(fixture.lock, fixture.expected), fixture.lock);
    assert.equal(assertRetainedRegularFileLock(alias, fixture.expected), alias);
    assert.equal(fixture.lock.schemaVersion, INTEGRATION_RETAINED_REGULAR_FILE_LOCK_VERSION);
    assert.equal(
      fixture.lock.attestation.schemaVersion,
      INTEGRATION_RETAINED_REGULAR_FILE_LOCK_ATTESTATION_VERSION
    );
    assertExactFrozenSurface(fixture.lock, LOCK_SURFACE_KEYS);
    assertExactFrozenSurface(fixture.lock.attestation, LOCK_ATTESTATION_KEYS);
    assert.equal(Object.isFrozen(fixture.lock.attestation.limitations), true);
    assert.equal(fixture.lock.attestation.kernelPrimitive, "linux-flock-open-file-description-v1");
    assert.equal(fixture.lock.attestation.lockFileMode, "0600");
    assert.equal(fixture.lock.attestation.lockFileEmpty, true);
    assert.equal(fixture.lock.attestation.lockFileMutation, false);
    assert.equal(fixture.lock.attestation.limitations.automaticStaleRecovery, false);
    assert.equal(fixture.lock.attestation.limitations.ownerRecord, false);
    assert.equal(fixture.lock.attestation.limitations.quarantineMethods, false);
    assert.equal(fixture.lock.attestation.limitations.storeMigrationIncluded, false);
    const publicSurface = JSON.stringify(fixture.lock);
    assert.equal(publicSurface.includes("/proc/self/fd"), false);
    assert.equal(publicSurface.includes(HELPER_PATH), false);
    assert.equal(/"fd"\s*:/u.test(publicSurface), false);

    await expectCode(
      () => Promise.resolve(assertIntegrationRetainedRegularFileLock(Object.freeze({ ...fixture.lock }))),
      "INTEGRATION_STORAGE_INVALID",
      smokeRoot
    );
    await expectCode(
      () => openIntegrationRetainedRegularFileLock(fixture.files, { ...fixture.expected, helperSha256: "0".repeat(64) }),
      "INTEGRATION_STORAGE_LOCK_UNAVAILABLE",
      smokeRoot
    );
    await expectCode(
      () => openIntegrationRetainedRegularFileLock(fixture.files, {
        ...fixture.expected,
        lockFileIdentityDigest: "0".repeat(64),
      }),
      "INTEGRATION_STORAGE_LOCK_POISONED",
      smokeRoot
    );
    await expectCode(
      () => openIntegrationRetainedRegularFileLock(fixture.files, {
        ...fixture.expected,
        helperIdentityDigest: "0".repeat(64),
      }),
      "INTEGRATION_STORAGE_LOCK_POISONED",
      smokeRoot
    );
    let expectedProxyTouched = false;
    const expectedProxy = new Proxy(fixture.expected, {
      get() { expectedProxyTouched = true; throw new Error("trap"); },
    });
    await expectCode(
      () => openIntegrationRetainedRegularFileLock(fixture.files, expectedProxy),
      "INTEGRATION_STORAGE_INVALID",
      smokeRoot
    );
    assert.equal(expectedProxyTouched, false);
    let getterTouched = false;
    const getterExpected = { ...fixture.expected };
    Object.defineProperty(getterExpected, "lockFileName", {
      enumerable: true,
      get() { getterTouched = true; return LOCK_NAME; },
    });
    await expectCode(
      () => openIntegrationRetainedRegularFileLock(fixture.files, getterExpected),
      "INTEGRATION_STORAGE_INVALID",
      smokeRoot
    );
    assert.equal(getterTouched, false);
    await expectCode(
      () => openIntegrationRetainedRegularFileLock(fixture.files, { ...fixture.expected, [Symbol("bad")]: true }),
      "INTEGRATION_STORAGE_INVALID",
      smokeRoot
    );
    await expectCode(
      () => openIntegrationRetainedRegularFileLock(fixture.files, { ...fixture.expected, lockFileName: "ordinary.lock" }),
      "INTEGRATION_STORAGE_INVALID",
      smokeRoot
    );
    await expectCode(() => fixture.files.readProtectedUtf8File(LOCK_NAME), "INTEGRATION_STORAGE_INVALID", smokeRoot);
    await expectCode(
      () => fixture.files.atomicWriteProtectedUtf8File(LOCK_NAME, "overwrite"),
      "INTEGRATION_STORAGE_INVALID",
      smokeRoot
    );

    assert.equal(await fixture.lock.runExclusive(async () => "exclusive", { waitMs: 0 }), "exclusive");
    const callbackError = new Error("callback sentinel");
    await assert.rejects(() => fixture.lock.runExclusive(async () => { throw callbackError; }), (error) => error === callbackError);
    for (const falsy of [null, undefined, false, 0, ""]) {
      let rejected = false;
      try {
        await fixture.lock.runExclusive(async () => { throw falsy; });
      } catch (error) {
        rejected = true;
        assert.equal(error, falsy);
      }
      assert.equal(rejected, true);
    }
    let thenableRejected = false;
    try {
      await fixture.lock.runExclusive(() => ({ then(_resolve, reject) { reject(false); } }));
    } catch (error) {
      thenableRejected = true;
      assert.equal(error, false);
    }
    assert.equal(thenableRejected, true);
    assert.equal(await fixture.lock.runExclusive(async () => "released"), "released");
    await expectCode(
      () => fixture.lock.runExclusive(async () => {}, { waitMs: -1 }),
      "INTEGRATION_STORAGE_INVALID",
      smokeRoot
    );
    let optionGetterTouched = false;
    const getterOptions = {};
    Object.defineProperty(getterOptions, "waitMs", {
      enumerable: true,
      get() { optionGetterTouched = true; return 1; },
    });
    await expectCode(
      () => fixture.lock.runExclusive(async () => {}, getterOptions),
      "INTEGRATION_STORAGE_INVALID",
      smokeRoot
    );
    assert.equal(optionGetterTouched, false);

    const entered = deferred();
    const release = deferred();
    const active = fixture.lock.runExclusive(async () => {
      entered.resolve();
      await release.promise;
    });
    await withTimeout(entered.promise, 2000, "same-surface entry");
    await expectCode(
      () => fixture.lock.runExclusive(async () => assert.fail("non-reentrant callback ran")),
      "INTEGRATION_STORAGE_LOCK_BUSY",
      smokeRoot
    );
    release.resolve();
    await withTimeout(active, 2000, "same-surface release");

    const separateEntered = deferred();
    const separateRelease = deferred();
    const separateActive = fixture.lock.runExclusive(async () => {
      separateEntered.resolve();
      await separateRelease.promise;
    });
    await withTimeout(separateEntered.promise, 2000, "separate OFD entry");
    await expectCode(
      () => alias.runExclusive(async () => assert.fail("separate OFD contender ran"), { waitMs: 60 }),
      "INTEGRATION_STORAGE_LOCK_BUSY",
      smokeRoot
    );
    separateRelease.resolve();
    await withTimeout(separateActive, 2000, "separate OFD holder release");
    assert.equal(await alias.runExclusive(async () => "separate-ofd-acquired"), "separate-ofd-acquired");

    const child = spawnChild(
      process.execPath,
      [fileURLToPath(import.meta.url), "--child-mode=hold", `--child-root=${fixture.rootPath}`],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let childStderr = "";
    child.stderr.on("data", (chunk) => { childStderr += chunk; });
    await waitForLine(child.stdout, "LOCKED\n");
    await expectCode(
      () => fixture.lock.runExclusive(async () => assert.fail("contended callback ran"), { waitMs: 60 }),
      "INTEGRATION_STORAGE_LOCK_BUSY",
      smokeRoot
    );
    child.kill("SIGKILL");
    await withTimeout(new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }), 3000, `crash child close: ${childStderr}`);
    assert.equal(
      await fixture.lock.runExclusive(async () => "kernel-crash-release", { waitMs: 2000 }),
      "kernel-crash-release"
    );

    const originalDigest = identityDigest(await fs.stat(fixture.lockPath, { bigint: true }));
    assert.equal(await fs.readFile(fixture.lockPath, "utf8"), "");
    assert.equal(identityDigest(await fs.stat(fixture.lockPath, { bigint: true })), originalDigest);
    assert.deepEqual(
      (await fs.readdir(path.dirname(fixture.lockPath))).filter((name) => /stale|quarantine|owner/u.test(name)),
      []
    );

    const replaced = await openFixture(
      { openIntegrationStorageAuthority, createIntegrationRetainedFilePrimitives, openIntegrationRetainedRegularFileLock },
      path.join(smokeRoot, "replaced"),
      "replaced-lock"
    );
    authorities.push(replaced.authority);
    const replacementError = await expectCode(
      () => replaced.lock.runExclusive(async () => {
        await fs.rename(replaced.lockPath, `${replaced.lockPath}.old`);
        await makeLockFile(replaced.lockPath);
      }),
      "INTEGRATION_STORAGE_LOCK_POISONED",
      smokeRoot
    );
    assert.equal(replacementError.details.phase, "post-operation-validation");
    assert.equal(replacementError.details.operationStarted, true);
    assert.equal(replacementError.details.operationSettled, true);
    assert.equal(replacementError.details.operationFailed, false);
    await expectCode(
      () => replaced.lock.runExclusive(async () => {}),
      "INTEGRATION_STORAGE_LOCK_POISONED",
      smokeRoot
    );

    await runInvalidLockFixtures(smokeRoot);

    const closing = await openFixture(
      { openIntegrationStorageAuthority, createIntegrationRetainedFilePrimitives, openIntegrationRetainedRegularFileLock },
      path.join(smokeRoot, "closing"),
      "closing-lock"
    );
    authorities.push(closing.authority);
    const closeEntered = deferred();
    const closeRelease = deferred();
    const closeActive = closing.lock.runExclusive(async () => {
      closeEntered.resolve();
      await closeRelease.promise;
      return "done";
    });
    await withTimeout(closeEntered.promise, 2000, "close gate entry");
    let closeSettled = false;
    const closePromise = closing.authority.close().then(() => { closeSettled = true; });
    await delay(30);
    assert.equal(closeSettled, false);
    assert.equal(closing.lock.isClosed(), true);
    closeRelease.resolve();
    assert.equal(await withTimeout(closeActive, 2000, "active lock completion"), "done");
    await withTimeout(closePromise, 2000, "authority close after lock");
    await expectCode(() => closing.lock.runExclusive(async () => {}), "INTEGRATION_STORAGE_CLOSED", smokeRoot);

    for (const authority of authorities.reverse()) await authority.close().catch(() => {});
    authorities.length = 0;
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
    await runMockProcesses();
  } finally {
    for (const authority of authorities.reverse()) await authority.close().catch(() => {});
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write("integration retained file lock smoke: ok\n");
}

if (CHILD_MODE === "hold") await runHoldingChild();
else if (MOCK_MODE === "helper-failure") {
  await runHelperFailureMock();
  process.stdout.write("integration retained file lock helper-failure mock: ok\n");
} else if (MOCK_MODE === "close-failure") {
  await runCloseFailureMock();
  process.stdout.write("integration retained file lock close-failure mock: ok\n");
} else if (MOCK_MODE === "conflict-close-failure" || MOCK_MODE === "helper-close-failure") {
  await runPreOperationCloseFailureMock(MOCK_MODE);
  process.stdout.write(`integration retained file lock ${MOCK_MODE} mock: ok\n`);
} else await main();
