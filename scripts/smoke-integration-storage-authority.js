#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertIntegrationRetainedDirectory,
  assertIntegrationStorageAttestation,
  assertIntegrationStorageAuthority,
  assertIntegrationStorageLease,
  openIntegrationStorageAuthority,
} from "../src/integration-storage-authority.js";

const UID = process.getuid();
const GID = process.getgid();
const execFileAsync = promisify(execFile);
const MODULE_MOCK_CHILD = process.argv.includes("--module-mock-child");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function expectCode(action, code) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
    if (error?.code === code || error?.publicCode === code || (Array.isArray(code) && code.includes(error?.code))) {
      return error;
    }
  }
  if (!captured) assert.fail(`Expected ${code} rejection, but action completed.`);
  assert.fail(`Expected ${code} rejection, got ${captured?.code || captured?.name}: ${captured?.message}`);
}

async function makeOwnerDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700);
  await fs.chown(dirPath, UID, GID);
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

function assertNoPathEscape(surface) {
  const serialized = JSON.stringify(surface, (key, value) => (typeof value === "bigint" ? value.toString() : value));
  assert.equal(serialized.includes("/proc/self/fd"), false);
  assert.equal(serialized.includes('"fd"'), false);
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

function deferred() {
  let resolve = null;
  let reject = null;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

async function runModuleMockChild() {
  const { mock } = await import("node:test");
  const realFsModule = await import("node:fs/promises");
  const realFs = realFsModule.default;
  const state = {
    lstatCounts: new Map(),
    failSecondLstatPath: "",
    pause: null,
    captureOpenHandles: false,
    openedHandles: [],
    failCloseSuffix: "",
    failStatSuffix: "",
    mutateOwnerStatSuffix: "",
    failSyncSuffix: "",
    failSyncRemaining: 0,
  };
  const mockFs = { ...realFs };
  mockFs.lstat = async (target, ...args) => {
    const targetPath = String(target);
    const count = (state.lstatCounts.get(targetPath) || 0) + 1;
    state.lstatCounts.set(targetPath, count);
    if (state.failSecondLstatPath === targetPath && count === 2) {
      throw Object.assign(new Error("synthetic named-binding disappearance"), { code: "ENOENT" });
    }
    if (state.pause?.path === targetPath && state.pause.armed) {
      state.pause.armed = false;
      state.pause.entered.resolve(Object.freeze({ entered: true }));
      await state.pause.release.promise;
    }
    return realFs.lstat(target, ...args);
  };
  mockFs.open = async (target, ...args) => {
    const handle = await realFs.open(target, ...args);
    const targetPath = String(target);
    if (state.captureOpenHandles) state.openedHandles.push(Object.freeze({ targetPath, handle }));
    const failClose = Boolean(state.failCloseSuffix && targetPath.endsWith(state.failCloseSuffix));
    const failStat = Boolean(state.failStatSuffix && targetPath.endsWith(state.failStatSuffix));
    const mutateOwner = Boolean(
      state.mutateOwnerStatSuffix && targetPath.endsWith(state.mutateOwnerStatSuffix)
    );
    const wrapSync = Boolean(state.failSyncSuffix && targetPath.endsWith(state.failSyncSuffix));
    if (!failClose && !failStat && !mutateOwner && !wrapSync) return handle;
    const close = handle.close.bind(handle);
    let injected = false;
    return {
      get fd() {
        return handle.fd;
      },
      async stat(...statArgs) {
        if (failStat) {
          throw Object.assign(new Error("synthetic retained child fstat failure"), {
            code: "INTEGRATION_STORAGE_TEST_FSTAT_FAILURE",
          });
        }
        const stat = await handle.stat(...statArgs);
        if (!mutateOwner) return stat;
        return Object.freeze({
          dev: stat.dev,
          ino: stat.ino,
          mode: stat.mode,
          uid: stat.uid + 1n,
          gid: stat.gid,
          nlink: stat.nlink,
          ctimeNs: stat.ctimeNs,
          isDirectory: stat.isDirectory.bind(stat),
        });
      },
      async close() {
        await close();
        if (failClose && !injected) {
          injected = true;
          throw Object.assign(new Error("synthetic retained directory close failure"), {
            code: "INTEGRATION_STORAGE_TEST_CLOSE_FAILURE",
          });
        }
      },
      async sync(...syncArgs) {
        if (wrapSync && state.failSyncRemaining > 0) {
          state.failSyncRemaining -= 1;
          throw Object.assign(new Error("synthetic retained directory fsync failure"), {
            code: "EIO",
          });
        }
        return handle.sync(...syncArgs);
      },
    };
  };

  const moduleMock = mock.module("node:fs/promises", { defaultExport: mockFs });
  const moduleUrl = new URL(`../src/integration-storage-authority.js?mock-child=${Date.now()}`, import.meta.url);
  const {
    createIntegrationRetainedBinaryFilePrimitives: createMockedBinaryFiles,
    openIntegrationStorageAuthority: openMockedAuthority,
  } = await import(moduleUrl.href);
  const smokeRoot = await realFs.mkdtemp(path.join(os.tmpdir(), "aginti-storage-authority-mock-"));
  const opened = [];
  const armLstatPause = (targetPath) => {
    const point = {
      path: targetPath,
      armed: true,
      entered: deferred(),
      release: deferred(),
    };
    state.pause = point;
    return point;
  };
  const retainedCapturedHandles = () => state.openedHandles
    .map((entry) => entry.handle)
    .filter((handle) => Number.isInteger(handle.fd) && handle.fd >= 0);

  try {
    const initialFailRoot = path.join(smokeRoot, "initial-fail-root");
    await makeOwnerDirectory(initialFailRoot);
    state.lstatCounts.clear();
    state.failSecondLstatPath = initialFailRoot;
    await expectCode(
      () => openMockedAuthority({
        rootPath: initialFailRoot,
        role: "initial-fail",
        ownerUid: UID,
        ownerGid: GID,
        label: "initial recheck cleanup",
      }),
      "INTEGRATION_STORAGE_POISONED"
    );
    state.failSecondLstatPath = "";
    assert.deepEqual(await fdTargetsContaining(initialFailRoot), []);

    const raceRoot = path.join(smokeRoot, "race-root");
    await makeOwnerDirectory(raceRoot);
    await makeOwnerDirectory(path.join(raceRoot, "parent"));
    await makeOwnerDirectory(path.join(raceRoot, "parent", "child"));
    const raceAuthority = await openMockedAuthority({
      rootPath: raceRoot,
      role: "race",
      ownerUid: UID,
      ownerGid: GID,
      label: "directory lifecycle race",
    });
    opened.push(raceAuthority);
    const raceParent = await raceAuthority.openDirectory(["parent"]);
    opened.push(raceParent);
    const openPause = armLstatPause(raceRoot);
    let raceParentCloseSettled = false;
    const childOpen = raceParent.openDirectory(["child"]);
    await withTimeout(openPause.entered.promise, 1000, "child open admission");
    const raceParentClose = raceParent.close().then(() => {
      raceParentCloseSettled = true;
    });
    await delay(25);
    assert.equal(raceParentCloseSettled, false);
    openPause.release.resolve(Object.freeze({ released: true }));
    const raceChild = await withTimeout(childOpen, 1000, "child open after directory close race");
    opened.push(raceChild);
    await withTimeout(raceParentClose, 1000, "directory close after child open");
    assert.equal(raceParent.isClosed(), true);
    await raceChild.identity();
    state.pause = null;

    const identityRaceRoot = path.join(smokeRoot, "identity-race-root");
    await makeOwnerDirectory(identityRaceRoot);
    await makeOwnerDirectory(path.join(identityRaceRoot, "parent"));
    const identityRaceAuthority = await openMockedAuthority({
      rootPath: identityRaceRoot,
      role: "identity-race",
      ownerUid: UID,
      ownerGid: GID,
      label: "directory identity race",
    });
    opened.push(identityRaceAuthority);
    const identityRaceParent = await identityRaceAuthority.openDirectory(["parent"]);
    opened.push(identityRaceParent);
    const identityPause = armLstatPause(identityRaceRoot);
    let identityCloseSettled = false;
    const identityPromise = identityRaceParent.identity();
    await withTimeout(identityPause.entered.promise, 1000, "directory identity admission");
    const identityClose = identityRaceParent.close().then(() => {
      identityCloseSettled = true;
    });
    await delay(25);
    assert.equal(identityCloseSettled, false);
    identityPause.release.resolve(Object.freeze({ released: true }));
    await withTimeout(identityPromise, 1000, "directory identity before close");
    await withTimeout(identityClose, 1000, "directory close after identity");
    assert.equal(identityRaceParent.isClosed(), true);
    state.pause = null;

    const concurrentPoisonRoot = path.join(smokeRoot, "concurrent-poison-root");
    await makeOwnerDirectory(concurrentPoisonRoot);
    const concurrentPoisonAuthority = await openMockedAuthority({
      rootPath: concurrentPoisonRoot,
      role: "concurrent-poison",
      ownerUid: UID,
      ownerGid: GID,
      label: "concurrent poison validation",
    });
    opened.push(concurrentPoisonAuthority);
    const concurrentPause = armLstatPause(concurrentPoisonRoot);
    const concurrentValidation = concurrentPoisonAuthority.recheckNamedBinding();
    await withTimeout(concurrentPause.entered.promise, 1000, "concurrent validation pause");
    await realFs.chmod(concurrentPoisonRoot, 0o755);
    await expectCode(() => concurrentPoisonAuthority.identity(), "INTEGRATION_STORAGE_POISONED");
    concurrentPause.release.resolve(Object.freeze({ released: true }));
    await expectCode(() => concurrentValidation, "INTEGRATION_STORAGE_POISONED");
    await expectCode(() => concurrentPoisonAuthority.recheckNamedBinding(), "INTEGRATION_STORAGE_POISONED");
    state.pause = null;

    const liveFstatRoot = path.join(smokeRoot, "live-fstat-root");
    await makeOwnerDirectory(liveFstatRoot);
    await makeOwnerDirectory(path.join(liveFstatRoot, "child"));
    const liveFstatAuthority = await openMockedAuthority({
      rootPath: liveFstatRoot,
      role: "live-fstat",
      ownerUid: UID,
      ownerGid: GID,
      label: "live child fstat poison",
    });
    opened.push(liveFstatAuthority);
    state.failStatSuffix = "/child";
    await expectCode(() => liveFstatAuthority.openDirectory(["child"]), "INTEGRATION_STORAGE_POISONED");
    state.failStatSuffix = "";
    await expectCode(() => liveFstatAuthority.identity(), "INTEGRATION_STORAGE_POISONED");

    const liveOwnerRoot = path.join(smokeRoot, "live-owner-root");
    await makeOwnerDirectory(liveOwnerRoot);
    await makeOwnerDirectory(path.join(liveOwnerRoot, "child"));
    const liveOwnerAuthority = await openMockedAuthority({
      rootPath: liveOwnerRoot,
      role: "live-owner",
      ownerUid: UID,
      ownerGid: GID,
      label: "live child owner poison",
    });
    opened.push(liveOwnerAuthority);
    state.mutateOwnerStatSuffix = "/child";
    await expectCode(() => liveOwnerAuthority.openDirectory(["child"]), "INTEGRATION_STORAGE_POISONED");
    state.mutateOwnerStatSuffix = "";
    await expectCode(() => liveOwnerAuthority.identity(), "INTEGRATION_STORAGE_POISONED");

    const closedChildRoot = path.join(smokeRoot, "closed-child-root");
    await makeOwnerDirectory(closedChildRoot);
    await makeOwnerDirectory(path.join(closedChildRoot, "child"));
    const closedChildAuthority = await openMockedAuthority({
      rootPath: closedChildRoot,
      role: "closed-child",
      ownerUid: UID,
      ownerGid: GID,
      label: "closed child handle",
    });
    opened.push(closedChildAuthority);
    state.openedHandles = [];
    state.captureOpenHandles = true;
    const closedChild = await closedChildAuthority.openDirectory(["child"]);
    state.captureOpenHandles = false;
    opened.push(closedChild);
    assert.equal(retainedCapturedHandles().length, 1);
    await retainedCapturedHandles()[0].close();
    const childFdReuseProbe = await realFs.open("/dev/null", "r");
    try {
      await expectCode(() => closedChild.identity(), "INTEGRATION_STORAGE_POISONED");
    } finally {
      await childFdReuseProbe.close();
    }
    await expectCode(() => closedChildAuthority.openDirectory(["child"]), "INTEGRATION_STORAGE_POISONED");

    const closedRoot = path.join(smokeRoot, "closed-root");
    await makeOwnerDirectory(closedRoot);
    await makeOwnerDirectory(path.join(closedRoot, "child"));
    state.openedHandles = [];
    state.captureOpenHandles = true;
    const closedRootAuthority = await openMockedAuthority({
      rootPath: closedRoot,
      role: "closed-root",
      ownerUid: UID,
      ownerGid: GID,
      label: "closed root handle",
    });
    state.captureOpenHandles = false;
    opened.push(closedRootAuthority);
    assert.equal(retainedCapturedHandles().length, 1);
    await retainedCapturedHandles()[0].close();
    const rootFdReuseProbe = await realFs.open("/dev/null", "r");
    try {
      await expectCode(() => closedRootAuthority.identity(), "INTEGRATION_STORAGE_POISONED");
    } finally {
      await rootFdReuseProbe.close();
    }
    await expectCode(() => closedRootAuthority.openDirectory(["child"]), "INTEGRATION_STORAGE_POISONED");

    const binarySyncRoot = path.join(smokeRoot, "binary-sync-root");
    await makeOwnerDirectory(binarySyncRoot);
    await makeOwnerDirectory(path.join(binarySyncRoot, "binary"));
    const binarySyncAuthority = await openMockedAuthority({
      rootPath: binarySyncRoot,
      role: "binary-sync",
      ownerUid: UID,
      ownerGid: GID,
      label: "binary directory sync fault",
    });
    opened.push(binarySyncAuthority);
    state.failSyncSuffix = "/binary";
    const binaryDirectory = await binarySyncAuthority.openDirectory(["binary"]);
    opened.push(binaryDirectory);
    const binaryIdentity = await binaryDirectory.identity();
    const binaryExpected = Object.freeze({
      role: "binary-sync",
      canonicalPath: binarySyncRoot,
      rootIdentityDigest: binarySyncAuthority.attestation.rootIdentityDigest,
      relativeSegments: Object.freeze(["binary"]),
      directoryIdentityDigest: binaryIdentity.digest,
    });
    const binaryFiles = createMockedBinaryFiles(binaryDirectory, binaryExpected);
    const durableBytes = Buffer.from("durable-after-explicit-directory-sync");
    state.failSyncRemaining = 2;
    const ambiguous = await expectCode(
      () => binaryFiles.atomicWriteProtectedBinaryFile("durable.bin", durableBytes, { maxBytes: 4096 }),
      "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS"
    );
    assert.equal(ambiguous.details.directorySynced, false);
    assert.equal((await binaryFiles.syncProtectedBinaryDirectory()).directorySynced, true);
    assert.deepEqual((await binaryFiles.readProtectedBinaryFile("durable.bin", { maxBytes: 4096 })).bytes, durableBytes);

    state.failSyncRemaining = 3;
    const undurable = await expectCode(
      () => binaryFiles.atomicWriteProtectedBinaryFile("orphan.bin", Buffer.from("orphan-only"), { maxBytes: 4096 }),
      "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS"
    );
    assert.equal(undurable.details.directorySynced, false);
    await expectCode(
      () => binaryFiles.syncProtectedBinaryDirectory(),
      "INTEGRATION_STORAGE_FILE_UNAVAILABLE"
    );
    state.failSyncRemaining = 0;
    await binaryFiles.syncProtectedBinaryDirectory();
    state.failSyncSuffix = "";

    const cleanupRoot = path.join(smokeRoot, "cleanup-root");
    await makeOwnerDirectory(cleanupRoot);
    await makeOwnerDirectory(path.join(cleanupRoot, "one"));
    await makeOwnerDirectory(path.join(cleanupRoot, "two"));
    const cleanupAuthority = await openMockedAuthority({
      rootPath: cleanupRoot,
      role: "cleanup",
      ownerUid: UID,
      ownerGid: GID,
      label: "cleanup failure",
    });
    opened.push(cleanupAuthority);
    state.failCloseSuffix = "/one";
    const cleanupOne = await cleanupAuthority.openDirectory(["one"]);
    opened.push(cleanupOne);
    state.failCloseSuffix = "";
    const cleanupTwo = await cleanupAuthority.openDirectory(["two"]);
    opened.push(cleanupTwo);
    await expectCode(() => cleanupAuthority.close(), "INTEGRATION_STORAGE_CLEANUP_FAILED");
    assert.equal(cleanupAuthority.isClosed(), true);
    assert.deepEqual(await fdTargetsContaining(cleanupRoot), []);
    await expectCode(() => cleanupAuthority.close(), "INTEGRATION_STORAGE_CLEANUP_FAILED");
    await expectCode(() => cleanupAuthority.openDirectory(["one"]), "INTEGRATION_STORAGE_CLOSED");

    for (const item of opened.reverse()) await item.close().catch(() => {});
    opened.length = 0;
  } finally {
    state.pause?.release.resolve(Object.freeze({ released: true }));
    for (const item of opened.reverse()) await item.close().catch(() => {});
    moduleMock.restore();
    await realFs.rm(smokeRoot, { recursive: true, force: true }).catch(() => {});
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write("integration storage authority module-mock smoke: ok\n");
}

async function runModuleMockProcess() {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-test-module-mocks", fileURLToPath(import.meta.url), "--module-mock-child"],
    { timeout: 20_000, maxBuffer: 1024 * 1024 }
  );
  assert.match(stdout, /integration storage authority module-mock smoke: ok/u);
}

async function main() {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-storage-authority-smoke-"));
  const opened = [];
  try {
    const source = await fs.readFile(new URL("../src/integration-storage-authority.js", import.meta.url), "utf8");
    assert.equal(source.includes("fs.open(options.rootPath"), false);
    assert.ok(source.includes("openRootComponentByComponent"));
    assert.equal(source.includes("INTEGRATION_STORAGE_TEST_TOKEN"), false);
    assert.equal(source.includes("getIntegrationStorageAuthorityTestApi"), false);

    const rootA = path.join(smokeRoot, "root-a");
    const rootB = path.join(smokeRoot, "root-b");
    await makeOwnerDirectory(rootA);
    await makeOwnerDirectory(rootB);
    await makeOwnerDirectory(path.join(rootA, "alpha"));
    await makeOwnerDirectory(path.join(rootA, "alpha", "beta"));
    await makeOwnerDirectory(path.join(rootA, "alpha", "beta", "gamma"));
    await makeOwnerDirectory(path.join(rootA, "aginti:session-1"));
    await makeOwnerDirectory(path.join(rootA, "real"));
    await makeOwnerDirectory(path.join(rootA, "real", "child"));
    await fs.symlink("real", path.join(rootA, "link-mid"));
    await fs.symlink("child", path.join(rootA, "real", "link-final"));

    const authority = await openIntegrationStorageAuthority({
      rootPath: rootA,
      role: "role-a",
      ownerUid: UID,
      ownerGid: GID,
      label: "storage smoke",
    });
    opened.push(authority);
    assert.equal(assertIntegrationStorageAuthority(authority), authority);
    assert.equal(assertIntegrationStorageAttestation(authority.attestation), authority.attestation);
    assertExactFrozenSurface(authority, [
      "schemaVersion",
      "attestation",
      "identity",
      "openDirectory",
      "admitOperation",
      "recheckNamedBinding",
      "close",
      "isClosed",
    ]);
    assertExactFrozenSurface(authority.attestation, [
      "schemaVersion",
      "owner",
      "authority",
      "role",
      "platform",
      "nodeMajor",
      "canonicalPath",
      "retainedDirectoryFileHandles",
      "procSelfFdWalk",
      "ownerUid",
      "ownerGid",
      "ownerOnlyMode",
      "rootIdentityDigest",
      "limitations",
      "digest",
    ]);
    assertNoPathEscape(authority.attestation);
    assert.equal(authority.attestation.role, "role-a");
    assert.equal(authority.attestation.canonicalPath, rootA);
    assert.equal(authority.attestation.limitations.preEnablePrimitive, true);
    assert.equal(authority.attestation.limitations.procfsRequired, true);
    assert.equal(authority.attestation.limitations.openat2ResolveBeneath, false);
    assert.equal(authority.attestation.limitations.resolveBeneath, false);
    assert.equal(authority.attestation.limitations.noXdev, false);

    const identity = await authority.identity();
    assert.equal(typeof identity.dev, "string");
    assert.equal(typeof identity.ino, "string");
    assert.equal(typeof identity.digest, "string");
    assert.equal(authority.attestation.rootIdentityDigest, identity.digest);
    assertNoPathEscape(identity);
    const expectedAuthorityA = Object.freeze({
      role: "role-a",
      canonicalPath: rootA,
      rootIdentityDigest: identity.digest,
    });
    assert.equal(assertIntegrationStorageAuthority(authority, expectedAuthorityA), authority);
    assert.equal(assertIntegrationStorageAttestation(authority.attestation, expectedAuthorityA), authority.attestation);
    await expectCode(
      () => assertIntegrationStorageAuthority(authority, { ...expectedAuthorityA, role: "role-b" }),
      "INTEGRATION_STORAGE_INVALID"
    );
    await expectCode(
      () => assertIntegrationStorageAuthority(authority, { ...expectedAuthorityA, extra: true }),
      "INTEGRATION_STORAGE_INVALID"
    );
    await expectCode(
      () => openIntegrationStorageAuthority({ rootPath: rootA, ownerUid: UID, ownerGid: GID }),
      "INTEGRATION_STORAGE_INVALID"
    );

    const nested = await authority.openDirectory(["alpha", "beta"]);
    assert.equal(assertIntegrationRetainedDirectory(nested), nested);
    assertExactFrozenSurface(nested, ["schemaVersion", "attestation", "identity", "openDirectory", "close", "isClosed"]);
    opened.push(nested);
    const leaf = await nested.openDirectory(["gamma"]);
    assert.equal(assertIntegrationRetainedDirectory(leaf), leaf);
    opened.push(leaf);
    const leafIdentity = await leaf.identity();
    assert.notEqual(leafIdentity.digest, identity.digest);
    assertNoPathEscape(leafIdentity);

    const colonDirectory = await authority.openDirectory(["aginti:session-1"]);
    opened.push(colonDirectory);
    assert.equal(assertIntegrationRetainedDirectory(colonDirectory), colonDirectory);

    const walkRoot = path.join(smokeRoot, "walk-root");
    await makeOwnerDirectory(walkRoot);
    await makeOwnerDirectory(path.join(walkRoot, "one"));
    await makeOwnerDirectory(path.join(walkRoot, "one", "two"));
    await makeOwnerDirectory(path.join(walkRoot, "one", "two", "three"));
    const walkAuthority = await openIntegrationStorageAuthority({
      rootPath: walkRoot,
      role: "walk",
      ownerUid: UID,
      ownerGid: GID,
      label: "successful walk cleanup",
    });
    opened.push(walkAuthority);
    const walkCountBefore = (await fdTargetsContaining(walkRoot)).length;
    const walkFinal = await walkAuthority.openDirectory(["one", "two", "three"]);
    opened.push(walkFinal);
    assert.equal((await fdTargetsContaining(walkRoot)).length, walkCountBefore + 1);
    const walkTargets = await fdTargetsContaining(path.join(walkRoot, "one"));
    assert.ok(walkTargets.some((target) => target === path.join(walkRoot, "one", "two", "three")));
    assert.equal(walkTargets.some((target) => target === path.join(walkRoot, "one")), false);
    assert.equal(walkTargets.some((target) => target === path.join(walkRoot, "one", "two")), false);

    await expectCode(() => authority.openDirectory(["link-mid", "child"]), "INTEGRATION_STORAGE_UNAVAILABLE");
    await expectCode(() => authority.openDirectory(["real", "link-final"]), "INTEGRATION_STORAGE_UNAVAILABLE");
    const failWalkRoot = path.join(smokeRoot, "fail-walk-root");
    await makeOwnerDirectory(failWalkRoot);
    await makeOwnerDirectory(path.join(failWalkRoot, "first"));
    await fs.symlink("missing", path.join(failWalkRoot, "first", "second"));
    const failWalkAuthority = await openIntegrationStorageAuthority({
      rootPath: failWalkRoot,
      role: "fail-walk",
      ownerUid: UID,
      ownerGid: GID,
      label: "failed walk cleanup",
    });
    opened.push(failWalkAuthority);
    await expectCode(() => failWalkAuthority.openDirectory(["first", "second"]), "INTEGRATION_STORAGE_UNAVAILABLE");
    assert.deepEqual(await fdTargetsContaining(path.join(failWalkRoot, "first")), []);
    for (const bad of [
      ["slash/name"],
      ["."],
      [".."],
      [""],
      ["nul\0byte"],
      ["a".repeat(200)],
    ]) {
      await expectCode(() => authority.openDirectory(bad), "INTEGRATION_STORAGE_INVALID");
    }
    const sparse = [];
    sparse.length = 1;
    await expectCode(() => authority.openDirectory(sparse), "INTEGRATION_STORAGE_INVALID");
    const accessorSegments = ["alpha"];
    Object.defineProperty(accessorSegments, "0", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("segment accessor must not run");
      },
    });
    await expectCode(() => authority.openDirectory(accessorSegments), "INTEGRATION_STORAGE_INVALID");
    let segmentProxyTrapCount = 0;
    const proxiedSegments = new Proxy(["alpha"], {
      get(target, property, receiver) {
        segmentProxyTrapCount += 1;
        return Reflect.get(target, property, receiver);
      },
      ownKeys(target) {
        segmentProxyTrapCount += 1;
        return Reflect.ownKeys(target);
      },
    });
    await expectCode(() => authority.openDirectory(proxiedSegments), "INTEGRATION_STORAGE_INVALID");
    assert.equal(segmentProxyTrapCount, 0);

    const rootBAuthority = await openIntegrationStorageAuthority({
      rootPath: rootB,
      role: "role-b",
      ownerUid: UID,
      ownerGid: GID,
      label: "storage smoke b",
    });
    opened.push(rootBAuthority);
    const rootBIdentity = await rootBAuthority.identity();
    assert.notEqual(rootBIdentity.digest, identity.digest);
    await expectCode(
      () => assertIntegrationStorageAuthority(rootBAuthority, expectedAuthorityA),
      "INTEGRATION_STORAGE_INVALID"
    );
    await expectCode(
      () => assertIntegrationStorageAttestation(rootBAuthority.attestation, expectedAuthorityA),
      "INTEGRATION_STORAGE_INVALID"
    );

    await expectCode(
      () => openIntegrationStorageAuthority({ rootPath: rootA, role: "role-a", ownerUid: UID + 1, ownerGid: GID }),
      "INTEGRATION_STORAGE_UNAVAILABLE"
    );
    const looseMode = path.join(smokeRoot, "loose-mode");
    await makeOwnerDirectory(looseMode);
    await fs.chmod(looseMode, 0o755);
    await expectCode(
      () => openIntegrationStorageAuthority({ rootPath: looseMode, role: "loose-mode", ownerUid: UID, ownerGid: GID }),
      "INTEGRATION_STORAGE_UNAVAILABLE"
    );
    const specialBits = path.join(smokeRoot, "special-bits");
    await makeOwnerDirectory(specialBits);
    await fs.chmod(specialBits, 0o1700);
    await expectCode(
      () => openIntegrationStorageAuthority({ rootPath: specialBits, role: "special-bits", ownerUid: UID, ownerGid: GID }),
      "INTEGRATION_STORAGE_UNAVAILABLE"
    );

    const liveModeRoot = path.join(smokeRoot, "live-mode-root");
    await makeOwnerDirectory(liveModeRoot);
    const liveModeAuthority = await openIntegrationStorageAuthority({
      rootPath: liveModeRoot,
      role: "live-mode-root",
      ownerUid: UID,
      ownerGid: GID,
      label: "live root mode poison",
    });
    opened.push(liveModeAuthority);
    await fs.chmod(liveModeRoot, 0o755);
    await expectCode(() => liveModeAuthority.identity(), "INTEGRATION_STORAGE_POISONED");
    await expectCode(() => liveModeAuthority.identity(), "INTEGRATION_STORAGE_POISONED");

    const liveChildRoot = path.join(smokeRoot, "live-child-root");
    await makeOwnerDirectory(liveChildRoot);
    await makeOwnerDirectory(path.join(liveChildRoot, "child"));
    const liveChildAuthority = await openIntegrationStorageAuthority({
      rootPath: liveChildRoot,
      role: "live-child",
      ownerUid: UID,
      ownerGid: GID,
      label: "live child mode poison",
    });
    opened.push(liveChildAuthority);
    const liveChild = await liveChildAuthority.openDirectory(["child"]);
    opened.push(liveChild);
    await fs.chmod(path.join(liveChildRoot, "child"), 0o755);
    await expectCode(() => liveChild.identity(), "INTEGRATION_STORAGE_POISONED");
    await expectCode(() => liveChild.identity(), "INTEGRATION_STORAGE_POISONED");
    await expectCode(() => liveChildAuthority.identity(), "INTEGRATION_STORAGE_POISONED");

    const liveChildAdmissionRoot = path.join(smokeRoot, "live-child-admission-root");
    await makeOwnerDirectory(liveChildAdmissionRoot);
    await makeOwnerDirectory(path.join(liveChildAdmissionRoot, "child"));
    const liveChildAdmissionAuthority = await openIntegrationStorageAuthority({
      rootPath: liveChildAdmissionRoot,
      role: "live-child-admission",
      ownerUid: UID,
      ownerGid: GID,
      label: "live child admission mode poison",
    });
    opened.push(liveChildAdmissionAuthority);
    await fs.chmod(path.join(liveChildAdmissionRoot, "child"), 0o755);
    await expectCode(
      () => liveChildAdmissionAuthority.openDirectory(["child"]),
      "INTEGRATION_STORAGE_POISONED"
    );
    await expectCode(() => liveChildAdmissionAuthority.identity(), "INTEGRATION_STORAGE_POISONED");

    let optionsProxyTrapCount = 0;
    const optionsProxy = new Proxy({ rootPath: rootA, role: "role-a", ownerUid: UID, ownerGid: GID }, {
      get(target, property, receiver) {
        optionsProxyTrapCount += 1;
        return Reflect.get(target, property, receiver);
      },
      ownKeys(target) {
        optionsProxyTrapCount += 1;
        return Reflect.ownKeys(target);
      },
    });
    await expectCode(() => openIntegrationStorageAuthority(optionsProxy), "INTEGRATION_STORAGE_INVALID");
    assert.equal(optionsProxyTrapCount, 0);
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, "rootPath", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("options accessor must not run");
      },
    });
    await expectCode(() => openIntegrationStorageAuthority(accessorOptions), "INTEGRATION_STORAGE_INVALID");
    await expectCode(
      () => openIntegrationStorageAuthority({ rootPath: rootA, role: "role-a", ownerUid: UID, ownerGid: GID, then: () => {} }),
      "INTEGRATION_STORAGE_INVALID"
    );
    let thenGetterCount = 0;
    const thenAccessorOptions = { rootPath: rootA, role: "role-a", ownerUid: UID, ownerGid: GID };
    Object.defineProperty(thenAccessorOptions, "then", {
      enumerable: true,
      configurable: true,
      get() {
        thenGetterCount += 1;
        return () => {};
      },
    });
    await expectCode(() => openIntegrationStorageAuthority(thenAccessorOptions), "INTEGRATION_STORAGE_INVALID");
    assert.equal(thenGetterCount, 0);

    const forgedAttestation = Object.freeze({ ...authority.attestation });
    await expectCode(() => assertIntegrationStorageAttestation(forgedAttestation), "INTEGRATION_STORAGE_INVALID");
    const forgedAuthority = Object.freeze({ ...authority });
    await expectCode(() => assertIntegrationStorageAuthority(forgedAuthority), "INTEGRATION_STORAGE_INVALID");
    const forgedLease = Object.freeze({ schemaVersion: "aginti-retained-storage-operation-lease-v1", release() {} });
    await expectCode(() => assertIntegrationStorageLease(forgedLease), "INTEGRATION_STORAGE_INVALID");

    const replacementRoot = path.join(smokeRoot, "replacement-root");
    await makeOwnerDirectory(replacementRoot);
    await makeOwnerDirectory(path.join(replacementRoot, "old-child"));
    const poisonAuthority = await openIntegrationStorageAuthority({
      rootPath: replacementRoot,
      role: "replacement",
      ownerUid: UID,
      ownerGid: GID,
      label: "replacement poison",
    });
    opened.push(poisonAuthority);
    const retainedDigest = (await poisonAuthority.identity()).digest;
    const renamedRoot = path.join(smokeRoot, "replacement-root-retained");
    await fs.rename(replacementRoot, renamedRoot);
    await makeOwnerDirectory(replacementRoot);
    await makeOwnerDirectory(path.join(replacementRoot, "new-child"));
    await expectCode(() => poisonAuthority.openDirectory(["new-child"]), "INTEGRATION_STORAGE_POISONED");
    assert.equal(typeof retainedDigest, "string");
    await expectCode(() => poisonAuthority.identity(), "INTEGRATION_STORAGE_POISONED");
    await expectCode(() => poisonAuthority.openDirectory(["old-child"]), "INTEGRATION_STORAGE_POISONED");

    const symlinkRoot = path.join(smokeRoot, "symlink-root");
    await makeOwnerDirectory(symlinkRoot);
    await makeOwnerDirectory(path.join(symlinkRoot, "old-child"));
    const symlinkAuthority = await openIntegrationStorageAuthority({
      rootPath: symlinkRoot,
      role: "symlink",
      ownerUid: UID,
      ownerGid: GID,
      label: "symlink poison",
    });
    opened.push(symlinkAuthority);
    const symlinkRetained = path.join(smokeRoot, "symlink-root-retained");
    await fs.rename(symlinkRoot, symlinkRetained);
    await fs.symlink(symlinkRetained, symlinkRoot);
    await expectCode(() => symlinkAuthority.openDirectory(["old-child"]), "INTEGRATION_STORAGE_POISONED");
    await expectCode(() => symlinkAuthority.identity(), "INTEGRATION_STORAGE_POISONED");

    const closeRoot = path.join(smokeRoot, "close-root");
    await makeOwnerDirectory(closeRoot);
    await makeOwnerDirectory(path.join(closeRoot, "child"));
    const closeAuthority = await openIntegrationStorageAuthority({
      rootPath: closeRoot,
      role: "close",
      ownerUid: UID,
      ownerGid: GID,
      label: "close wait",
    });
    opened.push(closeAuthority);
    const lease = closeAuthority.admitOperation("blocked close");
    assert.equal(assertIntegrationStorageLease(lease), lease);
    assertExactFrozenSurface(lease, ["schemaVersion", "release"]);
    let closeSettled = false;
    const closePromise = closeAuthority.close().then(() => {
      closeSettled = true;
    });
    await delay(25);
    assert.equal(closeSettled, false);
    await expectCode(() => closeAuthority.openDirectory(["child"]), "INTEGRATION_STORAGE_CLOSED");
    assert.deepEqual(lease.release(), { released: true });
    assert.deepEqual(lease.release(), { released: false });
    await closePromise;
    assert.equal(closeAuthority.isClosed(), true);
    await expectCode(() => closeAuthority.openDirectory(["child"]), "INTEGRATION_STORAGE_CLOSED");
    await expectCode(() => closeAuthority.admitOperation("after close"), "INTEGRATION_STORAGE_CLOSED");
    const fdReuseProbe = await fs.open("/dev/null", "r");
    try {
      await expectCode(() => closeAuthority.openDirectory(["child"]), "INTEGRATION_STORAGE_CLOSED");
    } finally {
      await fdReuseProbe.close();
    }

    await runModuleMockProcess();

    for (const item of opened.reverse()) await item.close().catch(() => {});
    opened.length = 0;
  } finally {
    for (const item of opened.reverse()) await item.close().catch(() => {});
    await fs.rm(smokeRoot, { recursive: true, force: true }).catch(() => {});
    const leaked = await fdTargetsContaining(smokeRoot);
    assert.deepEqual(leaked, []);
    await assert.rejects(() => fs.stat(smokeRoot), (error) => error?.code === "ENOENT");
  }
  process.stdout.write("integration storage authority smoke: ok\n");
}

const selectedMain = MODULE_MOCK_CHILD ? runModuleMockChild : main;

selectedMain().catch((error) => {
  process.stderr.write(`integration storage authority smoke: failed (${error?.code || error?.name || "ERROR"})\n`);
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
