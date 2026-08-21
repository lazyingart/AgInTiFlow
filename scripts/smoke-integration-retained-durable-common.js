#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertRetainedProtectedFilePrimitives,
  createRetainedProtectedFilePrimitives,
} from "../src/integration-durable-common.js";
import {
  INTEGRATION_RETAINED_FILE_ATTESTATION_VERSION,
  INTEGRATION_RETAINED_FILE_PRIMITIVES_VERSION,
  assertIntegrationRetainedFilePrimitives,
  createIntegrationRetainedFilePrimitives,
  openIntegrationStorageAuthority,
} from "../src/integration-storage-authority.js";

const UID = process.getuid();
const GID = process.getgid();
const execFileAsync = promisify(execFile);
const MOCK_MODE = String(process.argv.find((value) => value.startsWith("--mock-mode=")) || "").slice(12);
const FILE_SURFACE_KEYS = Object.freeze([
  "schemaVersion",
  "attestation",
  "readProtectedUtf8File",
  "readProtectedJsonFile",
  "atomicWriteProtectedUtf8File",
  "atomicWriteProtectedJson",
  "isClosed",
]);
const FILE_ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "role",
  "canonicalPath",
  "rootIdentityDigest",
  "relativeSegments",
  "relativePointer",
  "directoryIdentityDigest",
  "protectedRegularFiles",
  "atomicSameDirectoryReplace",
  "fileSyncBeforeRename",
  "directorySyncAfterRename",
  "limitations",
  "digest",
]);

function deferred() {
  let resolve = null;
  let reject = null;
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
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function publicErrorText(error) {
  return JSON.stringify({
    code: error?.publicCode || error?.code || "",
    message: error?.message || "",
    details: error?.details || {},
  });
}

async function expectCode(action, code) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
    if (error?.code === code || error?.publicCode === code || (Array.isArray(code) && code.includes(error?.code))) {
      const exposed = publicErrorText(error);
      assert.equal(exposed.includes("/proc/self/fd"), false);
      assert.equal(/"fd"\s*:/u.test(exposed), false);
      assert.equal(exposed.includes(os.tmpdir()), false);
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

async function writeProtected(filePath, value) {
  await fs.writeFile(filePath, value, { mode: 0o600 });
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

async function atomicTemps(dirPath) {
  return (await fs.readdir(dirPath).catch(() => []))
    .filter((name) => name.startsWith(".aginti-atomic-v1-"))
    .sort();
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

function assertNoRawAuthority(surface) {
  const text = JSON.stringify(surface, (key, value) => (typeof value === "bigint" ? value.toString() : value));
  assert.equal(text.includes("/proc/self/fd"), false);
  assert.equal(/"fd"\s*:/u.test(text), false);
}

async function openFixture(api, rootPath, role) {
  await makeOwnerDirectory(rootPath);
  await makeOwnerDirectory(path.join(rootPath, "data"));
  const authority = await api.openIntegrationStorageAuthority({
    rootPath,
    role,
    ownerUid: UID,
    ownerGid: GID,
    label: "retained durable smoke",
  });
  const directory = await authority.openDirectory(["data"]);
  const directoryIdentity = await directory.identity();
  const expected = Object.freeze({
    role,
    canonicalPath: rootPath,
    rootIdentityDigest: authority.attestation.rootIdentityDigest,
    relativeSegments: Object.freeze(["data"]),
    directoryIdentityDigest: directoryIdentity.digest,
  });
  const primitives = api.createIntegrationRetainedFilePrimitives(directory, expected);
  return Object.freeze({ authority, directory, primitives, expected, dataPath: path.join(rootPath, "data") });
}

async function runRandomFailureChild() {
  const { mock } = await import("node:test");
  const realCrypto = (await import("node:crypto")).default;
  const moduleMock = mock.module("node:crypto", {
    defaultExport: {
      ...realCrypto,
      randomBytes() {
        throw new Error("synthetic /proc/self/fd/991 randomness failure");
      },
    },
  });
  const moduleUrl = new URL(`../src/integration-storage-authority.js?random-failure=${Date.now()}`, import.meta.url);
  const api = await import(moduleUrl.href);
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-random-"));
  let fixture = null;
  try {
    fixture = await openFixture(api, path.join(smokeRoot, "root"), "random-failure");
    await expectCode(
      () => fixture.primitives.atomicWriteProtectedUtf8File("value.txt", "value"),
      "INTEGRATION_STORAGE_FILE_UNAVAILABLE"
    );
    assert.deepEqual(await atomicTemps(fixture.dataPath), []);
    await withTimeout(fixture.directory.close(), 1000, "directory close after random failure");
  } finally {
    await fixture?.authority.close().catch(() => {});
    moduleMock.restore();
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
}

async function runFstatFailureChild() {
  const { mock } = await import("node:test");
  const realFs = await import("node:fs");
  let fstatCalls = 0;
  const moduleMock = mock.module("node:fs", {
    namedExports: {
      constants: realFs.constants,
      fstatSync(...args) {
        fstatCalls += 1;
        if (fstatCalls === 1) {
          throw Object.assign(new Error("synthetic /proc/self/fd/992 fstat failure"), { code: "EIO" });
        }
        return realFs.fstatSync(...args);
      },
    },
  });
  const moduleUrl = new URL(`../src/integration-storage-authority.js?fstat-failure=${Date.now()}`, import.meta.url);
  const api = await import(moduleUrl.href);
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-fstat-"));
  let fixture = null;
  try {
    fixture = await openFixture(api, path.join(smokeRoot, "root"), "fstat-failure");
    await expectCode(
      () => fixture.primitives.atomicWriteProtectedUtf8File("value.txt", "value"),
      "INTEGRATION_STORAGE_FILE_UNAVAILABLE"
    );
    assert.ok(fstatCalls >= 2);
    assert.deepEqual(await atomicTemps(fixture.dataPath), []);
    assert.equal(await fs.stat(path.join(fixture.dataPath, "value.txt")).then(() => true).catch(() => false), false);
  } finally {
    await fixture?.authority.close().catch(() => {});
    moduleMock.restore();
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
}

function wrapFileHandle(handle, targetPath, flags, state, constants) {
  const isDirectory = (Number(flags) & constants.O_DIRECTORY) === constants.O_DIRECTORY;
  return {
    get fd() {
      return handle.fd;
    },
    stat: handle.stat.bind(handle),
    close: handle.close.bind(handle),
    writeFile: handle.writeFile.bind(handle),
    async read(...args) {
      if (state.pauseRead?.armed && targetPath.endsWith(`/${state.pauseRead.fileName}`)) {
        state.pauseRead.armed = false;
        state.pauseRead.entered.resolve(Object.freeze({ entered: true }));
        await state.pauseRead.release.promise;
      }
      return handle.read(...args);
    },
    async sync() {
      const isTemp = targetPath.includes("/.aginti-atomic-v1-");
      if (isTemp) state.events.push("file.sync");
      else if (isDirectory) state.events.push("directory.sync");
      if (!isTemp && isDirectory && state.failDirectorySyncOnce) {
        state.failDirectorySyncOnce = false;
        throw new Error("synthetic /proc/self/fd/993 directory sync failure");
      }
      await handle.sync();
      if (isTemp && state.pauseFileSync?.armed) {
        state.pauseFileSync.armed = false;
        state.pauseFileSync.entered.resolve(Object.freeze({ entered: true }));
        await state.pauseFileSync.release.promise;
      }
    },
  };
}

async function runFlowChild() {
  const { mock } = await import("node:test");
  const realFs = (await import("node:fs/promises")).default;
  const { constants } = await import("node:fs");
  const state = {
    events: [],
    pauseRead: null,
    pauseFileSync: null,
    pauseRename: null,
    failDirectorySyncOnce: false,
  };
  const mockFs = { ...realFs };
  mockFs.open = async (target, flags, ...args) => {
    const handle = await realFs.open(target, flags, ...args);
    return wrapFileHandle(handle, String(target), flags, state, constants);
  };
  mockFs.rename = async (from, to) => {
    state.events.push("rename");
    await realFs.rename(from, to);
    if (state.pauseRename?.armed) {
      state.pauseRename.armed = false;
      state.pauseRename.entered.resolve(Object.freeze({ entered: true }));
      await state.pauseRename.release.promise;
    }
  };
  const moduleMock = mock.module("node:fs/promises", { defaultExport: mockFs });
  const moduleUrl = new URL(`../src/integration-storage-authority.js?flow=${Date.now()}`, import.meta.url);
  const api = await import(moduleUrl.href);
  const smokeRoot = await realFs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-flow-"));
  const fixtures = [];
  try {
    const ordering = await openFixture(api, path.join(smokeRoot, "ordering-root"), "ordering");
    fixtures.push(ordering);
    state.events.length = 0;
    await ordering.primitives.atomicWriteProtectedUtf8File("ordered.txt", "ordered");
    const fileSyncIndex = state.events.indexOf("file.sync");
    const renameIndex = state.events.indexOf("rename");
    const directorySyncIndex = state.events.indexOf("directory.sync");
    assert.ok(fileSyncIndex >= 0 && renameIndex > fileSyncIndex && directorySyncIndex > renameIndex);

    await writeProtected(path.join(ordering.dataPath, "growth.txt"), "a");
    state.pauseRead = { fileName: "growth.txt", armed: true, entered: deferred(), release: deferred() };
    const growthRead = ordering.primitives.readProtectedUtf8File("growth.txt");
    await withTimeout(state.pauseRead.entered.promise, 1000, "growth read pause");
    await realFs.appendFile(path.join(ordering.dataPath, "growth.txt"), "b");
    state.pauseRead.release.resolve(Object.freeze({ released: true }));
    await expectCode(() => growthRead, "INTEGRATION_STORAGE_FILE_CORRUPT");

    await writeProtected(path.join(ordering.dataPath, "pause.txt"), "pause");
    state.pauseRead = { fileName: "pause.txt", armed: true, entered: deferred(), release: deferred() };
    const activeRead = ordering.primitives.readProtectedUtf8File("pause.txt");
    await withTimeout(state.pauseRead.entered.promise, 1000, "read pause entry");
    let closeSettled = false;
    const closePromise = ordering.directory.close().then(() => {
      closeSettled = true;
    });
    await delay(25);
    assert.equal(closeSettled, false);
    assert.equal(ordering.primitives.isClosed(), true);
    await expectCode(
      () => Promise.resolve(api.createIntegrationRetainedFilePrimitives(ordering.directory, ordering.expected)),
      "INTEGRATION_STORAGE_CLOSED"
    );
    state.pauseRead.release.resolve(Object.freeze({ released: true }));
    assert.equal(await withTimeout(activeRead, 1000, "active read completion"), "pause");
    await withTimeout(closePromise, 1000, "directory close after active read");
    await expectCode(() => ordering.primitives.readProtectedUtf8File("pause.txt"), "INTEGRATION_STORAGE_CLOSED");

    const rootClose = await openFixture(api, path.join(smokeRoot, "root-close"), "root-close");
    fixtures.push(rootClose);
    await writeProtected(path.join(rootClose.dataPath, "pause.txt"), "pause");
    state.pauseRead = { fileName: "pause.txt", armed: true, entered: deferred(), release: deferred() };
    const rootActiveRead = rootClose.primitives.readProtectedUtf8File("pause.txt");
    await withTimeout(state.pauseRead.entered.promise, 1000, "root-close read pause entry");
    let rootCloseSettled = false;
    const rootClosePromise = rootClose.authority.close().then(() => {
      rootCloseSettled = true;
    });
    await delay(25);
    assert.equal(rootCloseSettled, false);
    assert.equal(rootClose.primitives.isClosed(), true);
    state.pauseRead.release.resolve(Object.freeze({ released: true }));
    assert.equal(await withTimeout(rootActiveRead, 1000, "root-close active read completion"), "pause");
    await withTimeout(rootClosePromise, 1000, "root close after active read");
    await expectCode(() => rootClose.primitives.readProtectedUtf8File("pause.txt"), "INTEGRATION_STORAGE_CLOSED");

    const beforeRoot = path.join(smokeRoot, "before-root");
    const before = await openFixture(api, beforeRoot, "before-rename");
    fixtures.push(before);
    await writeProtected(path.join(before.dataPath, "value.txt"), "old");
    state.pauseFileSync = { armed: true, entered: deferred(), release: deferred() };
    const beforeWrite = before.primitives.atomicWriteProtectedUtf8File("value.txt", "new");
    await withTimeout(state.pauseFileSync.entered.promise, 1000, "pre-rename file sync pause");
    const beforeDisplaced = path.join(smokeRoot, "before-root-displaced");
    await realFs.rename(beforeRoot, beforeDisplaced);
    await makeOwnerDirectory(beforeRoot);
    await makeOwnerDirectory(path.join(beforeRoot, "data"));
    state.pauseFileSync.release.resolve(Object.freeze({ released: true }));
    await expectCode(() => beforeWrite, "INTEGRATION_STORAGE_POISONED");
    assert.equal(await realFs.readFile(path.join(beforeDisplaced, "data", "value.txt"), "utf8"), "old");
    assert.deepEqual(await atomicTemps(path.join(beforeDisplaced, "data")), []);

    const afterRoot = path.join(smokeRoot, "after-root");
    const after = await openFixture(api, afterRoot, "after-rename");
    fixtures.push(after);
    await writeProtected(path.join(after.dataPath, "value.txt"), "old");
    state.pauseRename = { armed: true, entered: deferred(), release: deferred() };
    const afterWrite = after.primitives.atomicWriteProtectedUtf8File("value.txt", "new");
    await withTimeout(state.pauseRename.entered.promise, 1000, "post-rename pause");
    const afterDisplaced = path.join(smokeRoot, "after-root-displaced");
    await realFs.rename(afterRoot, afterDisplaced);
    await makeOwnerDirectory(afterRoot);
    await makeOwnerDirectory(path.join(afterRoot, "data"));
    state.pauseRename.release.resolve(Object.freeze({ released: true }));
    const ambiguous = await expectCode(() => afterWrite, "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS");
    assert.equal(ambiguous.details.renamed, true);
    assert.equal(await realFs.readFile(path.join(afterDisplaced, "data", "value.txt"), "utf8"), "new");

    const syncFailure = await openFixture(api, path.join(smokeRoot, "sync-failure-root"), "sync-failure");
    fixtures.push(syncFailure);
    await writeProtected(path.join(syncFailure.dataPath, "value.txt"), "old");
    state.failDirectorySyncOnce = true;
    const syncAmbiguous = await expectCode(
      () => syncFailure.primitives.atomicWriteProtectedUtf8File("value.txt", "new"),
      "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS"
    );
    assert.equal(syncAmbiguous.details.renamed, true);
    assert.equal(syncAmbiguous.details.directorySynced, true);
    assert.equal(await realFs.readFile(path.join(syncFailure.dataPath, "value.txt"), "utf8"), "new");
  } finally {
    state.pauseRead?.release.resolve(Object.freeze({ released: true }));
    state.pauseFileSync?.release.resolve(Object.freeze({ released: true }));
    state.pauseRename?.release.resolve(Object.freeze({ released: true }));
    for (const fixture of fixtures.reverse()) await fixture.authority.close().catch(() => {});
    moduleMock.restore();
    await realFs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
}

async function runMockChild(mode) {
  if (mode === "random") await runRandomFailureChild();
  else if (mode === "fstat") await runFstatFailureChild();
  else if (mode === "flow") await runFlowChild();
  else assert.fail(`Unknown mock mode ${mode}`);
  process.stdout.write(`integration retained durable-common ${mode} mock: ok\n`);
}

async function runMockProcesses() {
  for (const mode of ["random", "fstat", "flow"]) {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-test-module-mocks", fileURLToPath(import.meta.url), `--mock-mode=${mode}`],
      { timeout: 20_000, maxBuffer: 1024 * 1024 }
    );
    assert.match(stdout, new RegExp(`integration retained durable-common ${mode} mock: ok`, "u"));
  }
}

async function main() {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-durable-smoke-"));
  const opened = [];
  try {
    const storageSource = await fs.readFile(new URL("../src/integration-storage-authority.js", import.meta.url), "utf8");
    const serverSource = await fs.readFile(new URL("../src/integration-server.js", import.meta.url), "utf8");
    const eventStoreSource = await fs.readFile(new URL("../src/integration-event-ledger-store.js", import.meta.url), "utf8");
    const idempotencySource = await fs.readFile(new URL("../src/integration-idempotency-store.js", import.meta.url), "utf8");
    assert.equal(storageSource.includes("node:test"), false);
    assert.equal(storageSource.includes("INTEGRATION_STORAGE_TEST_TOKEN"), false);
    assert.equal(storageSource.includes("getIntegrationStorageAuthorityTestApi"), false);
    assert.match(serverSource, /export const INTEGRATION_MOUNT_CAPABILITY_ENABLED = false;/u);
    assert.equal(serverSource.includes("createRetainedProtectedFilePrimitives"), false);
    assert.equal(eventStoreSource.includes("createRetainedProtectedFilePrimitives"), false);
    assert.equal(idempotencySource.includes("createRetainedProtectedFilePrimitives"), false);

    const rootPath = path.join(smokeRoot, "root");
    const fixture = await openFixture(
      { openIntegrationStorageAuthority, createIntegrationRetainedFilePrimitives },
      rootPath,
      "durable:smoke"
    );
    opened.push(fixture.authority);
    const primitives = createRetainedProtectedFilePrimitives(fixture.directory, fixture.expected);
    assert.equal(assertIntegrationRetainedFilePrimitives(primitives, fixture.expected), primitives);
    assert.equal(assertRetainedProtectedFilePrimitives(primitives, fixture.expected), primitives);
    assert.equal(primitives.schemaVersion, INTEGRATION_RETAINED_FILE_PRIMITIVES_VERSION);
    assert.equal(primitives.attestation.schemaVersion, INTEGRATION_RETAINED_FILE_ATTESTATION_VERSION);
    assertExactFrozenSurface(primitives, FILE_SURFACE_KEYS);
    assertExactFrozenSurface(primitives.attestation, FILE_ATTESTATION_KEYS);
    assert.equal(Object.isFrozen(primitives.attestation.relativeSegments), true);
    assert.equal(Object.isFrozen(primitives.attestation.limitations), true);
    assert.equal(primitives.attestation.relativePointer, "data");
    assert.equal(primitives.attestation.atomicSameDirectoryReplace, true);
    assert.equal(primitives.attestation.limitations.procfsRequired, true);
    assert.equal(primitives.attestation.limitations.preprovisionedDirectoryRequired, true);
    assert.equal(primitives.attestation.limitations.lockMethods, false);
    assert.equal(primitives.attestation.limitations.directoryMutationMethods, false);
    assert.equal(primitives.attestation.limitations.sameUidMutationSafety, false);
    assert.equal(primitives.attestation.limitations.crashMayLeaveReservedTemp, true);
    assertNoRawAuthority(primitives);

    await expectCode(
      () => Promise.resolve(assertIntegrationRetainedFilePrimitives(Object.freeze({ ...primitives }))),
      "INTEGRATION_STORAGE_INVALID"
    );
    await expectCode(
      () => Promise.resolve(createRetainedProtectedFilePrimitives(fixture.directory, { ...fixture.expected, role: "wrong" })),
      "INTEGRATION_STORAGE_INVALID"
    );
    let proxyTouched = false;
    const expectedProxy = new Proxy(fixture.expected, {
      get() {
        proxyTouched = true;
        throw new Error("expected proxy trap ran");
      },
    });
    await expectCode(
      () => Promise.resolve(createRetainedProtectedFilePrimitives(fixture.directory, expectedProxy)),
      "INTEGRATION_STORAGE_INVALID"
    );
    assert.equal(proxyTouched, false);
    let getterTouched = false;
    const getterExpected = { ...fixture.expected };
    Object.defineProperty(getterExpected, "role", {
      enumerable: true,
      get() {
        getterTouched = true;
        return fixture.expected.role;
      },
    });
    await expectCode(
      () => Promise.resolve(createRetainedProtectedFilePrimitives(fixture.directory, getterExpected)),
      "INTEGRATION_STORAGE_INVALID"
    );
    assert.equal(getterTouched, false);
    await expectCode(
      () => Promise.resolve(createRetainedProtectedFilePrimitives(fixture.directory, {
        ...fixture.expected,
        [Symbol("unexpected")]: true,
      })),
      "INTEGRATION_STORAGE_INVALID"
    );
    for (const segment of [".", "..", "a/b", "a\\b", ".aginti-atomic-v1-forged"]) {
      await expectCode(
        () => Promise.resolve(createRetainedProtectedFilePrimitives(fixture.directory, {
          ...fixture.expected,
          relativeSegments: Object.freeze([segment]),
        })),
        "INTEGRATION_STORAGE_INVALID"
      );
    }

    assert.equal(await primitives.readProtectedUtf8File("missing.txt", { optional: true }), null);
    const firstReceipt = await primitives.atomicWriteProtectedUtf8File("value:one.txt", "first");
    assert.deepEqual(firstReceipt, {
      committed: true,
      bytes: 5,
      digest: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
      directorySynced: true,
    });
    assert.equal(Object.isFrozen(firstReceipt), true);
    assert.equal(await primitives.readProtectedUtf8File("value:one.txt"), "first");
    await primitives.atomicWriteProtectedUtf8File("value:one.txt", "second");
    assert.equal(await primitives.readProtectedUtf8File("value:one.txt"), "second");
    await primitives.atomicWriteProtectedUtf8File("bom.txt", "\ufefftext");
    assert.equal(await primitives.readProtectedUtf8File("bom.txt"), "\ufefftext");
    await expectCode(
      () => primitives.atomicWriteProtectedUtf8File("surrogate.txt", "\ud800"),
      "INTEGRATION_STORAGE_INVALID"
    );
    const writtenStat = await fs.lstat(path.join(fixture.dataPath, "value:one.txt"));
    assert.equal(writtenStat.isFile(), true);
    assert.equal(writtenStat.mode & 0o7777, 0o600);
    assert.equal(writtenStat.nlink, 1);

    await primitives.atomicWriteProtectedJson("value.json", { b: 2, a: [1, true] });
    assert.equal(await fs.readFile(path.join(fixture.dataPath, "value.json"), "utf8"), '{"a":[1,true],"b":2}\n');
    const parsed = await primitives.readProtectedJsonFile("value.json");
    assert.deepEqual(parsed, { a: [1, true], b: 2 });
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.a), true);
    assert.throws(() => {
      parsed.a.push(false);
    }, TypeError);

    for (const badName of ["", ".", "..", "a/b", "a\\b", ".aginti-atomic-v1-forged"] ) {
      await expectCode(() => primitives.readProtectedUtf8File(badName, { optional: true }), "INTEGRATION_STORAGE_INVALID");
    }
    let optionGetterTouched = false;
    const getterOptions = {};
    Object.defineProperty(getterOptions, "maxBytes", {
      enumerable: true,
      get() {
        optionGetterTouched = true;
        return 10;
      },
    });
    await expectCode(() => primitives.readProtectedUtf8File("value.json", getterOptions), "INTEGRATION_STORAGE_INVALID");
    assert.equal(optionGetterTouched, false);
    let jsonGetterTouched = false;
    const getterJson = {};
    Object.defineProperty(getterJson, "value", {
      enumerable: true,
      get() {
        jsonGetterTouched = true;
        return "unsafe";
      },
    });
    await expectCode(() => primitives.atomicWriteProtectedJson("getter.json", getterJson), "INTEGRATION_STORAGE_INVALID");
    assert.equal(jsonGetterTouched, false);
    await expectCode(
      () => primitives.atomicWriteProtectedJson("proxy.json", new Proxy({}, { ownKeys() { throw new Error("trap"); } })),
      "INTEGRATION_STORAGE_INVALID"
    );
    await expectCode(
      () => primitives.atomicWriteProtectedJson("symbol.json", { [Symbol("unsafe")]: true }),
      "INTEGRATION_STORAGE_INVALID"
    );
    await expectCode(
      () => primitives.atomicWriteProtectedJson("thenable.json", { then() {} }),
      "INTEGRATION_STORAGE_INVALID"
    );

    const outside = path.join(smokeRoot, "outside.txt");
    await writeProtected(outside, "outside");
    await fs.symlink(outside, path.join(fixture.dataPath, "symlink.txt"));
    await expectCode(() => primitives.readProtectedUtf8File("symlink.txt"), "INTEGRATION_STORAGE_FILE_CORRUPT");
    await expectCode(
      () => primitives.atomicWriteProtectedUtf8File("symlink.txt", "changed"),
      "INTEGRATION_STORAGE_FILE_CORRUPT"
    );
    assert.equal(await fs.readFile(outside, "utf8"), "outside");

    const hardOutside = path.join(smokeRoot, "hard-outside.txt");
    await writeProtected(hardOutside, "hard");
    await fs.link(hardOutside, path.join(fixture.dataPath, "hardlink.txt"));
    await expectCode(() => primitives.readProtectedUtf8File("hardlink.txt"), "INTEGRATION_STORAGE_FILE_CORRUPT");
    await expectCode(
      () => primitives.atomicWriteProtectedUtf8File("hardlink.txt", "changed"),
      "INTEGRATION_STORAGE_FILE_CORRUPT"
    );
    assert.equal(await fs.readFile(hardOutside, "utf8"), "hard");

    const specialRoot = path.join(smokeRoot, "special-root");
    await makeOwnerDirectory(path.join(specialRoot, "data", "directory.txt"));
    const special = await openFixture(
      { openIntegrationStorageAuthority, createIntegrationRetainedFilePrimitives },
      specialRoot,
      "special-file"
    );
    opened.push(special.authority);
    await expectCode(() => special.primitives.readProtectedUtf8File("directory.txt"), "INTEGRATION_STORAGE_FILE_CORRUPT");
    await expectCode(
      () => special.primitives.atomicWriteProtectedUtf8File("directory.txt", "changed"),
      "INTEGRATION_STORAGE_FILE_CORRUPT"
    );

    const fifoPath = path.join(fixture.dataPath, "fifo.txt");
    await execFileAsync("mkfifo", [fifoPath]);
    await fs.chmod(fifoPath, 0o600);
    await expectCode(
      () => withTimeout(primitives.readProtectedUtf8File("fifo.txt"), 1000, "FIFO read"),
      "INTEGRATION_STORAGE_FILE_CORRUPT"
    );
    await expectCode(
      () => withTimeout(primitives.atomicWriteProtectedUtf8File("fifo.txt", "changed"), 1000, "FIFO overwrite"),
      "INTEGRATION_STORAGE_FILE_CORRUPT"
    );

    await writeProtected(path.join(fixture.dataPath, "wrong-mode.txt"), "mode");
    await fs.chmod(path.join(fixture.dataPath, "wrong-mode.txt"), 0o644);
    await expectCode(() => primitives.readProtectedUtf8File("wrong-mode.txt"), "INTEGRATION_STORAGE_FILE_CORRUPT");
    await expectCode(
      () => primitives.atomicWriteProtectedUtf8File("wrong-mode.txt", "changed"),
      "INTEGRATION_STORAGE_FILE_CORRUPT"
    );
    await writeProtected(path.join(fixture.dataPath, "large.txt"), "x".repeat(33));
    await expectCode(
      () => primitives.readProtectedUtf8File("large.txt", { maxBytes: 32 }),
      "INTEGRATION_STORAGE_FILE_CORRUPT"
    );
    await writeProtected(path.join(fixture.dataPath, "invalid-utf8.txt"), Buffer.from([0xff]));
    await expectCode(() => primitives.readProtectedUtf8File("invalid-utf8.txt"), "INTEGRATION_STORAGE_FILE_CORRUPT");
    await writeProtected(path.join(fixture.dataPath, "invalid.json"), "{not-json}\n");
    await expectCode(() => primitives.readProtectedJsonFile("invalid.json"), "INTEGRATION_STORAGE_FILE_CORRUPT");
    await writeProtected(
      path.join(fixture.dataPath, "bom.json"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"value":true}\n', "utf8")])
    );
    assert.equal((await primitives.readProtectedUtf8File("bom.json")).startsWith("\ufeff"), true);
    await expectCode(() => primitives.readProtectedJsonFile("bom.json"), "INTEGRATION_STORAGE_FILE_CORRUPT");
    assert.deepEqual(await atomicTemps(fixture.dataPath), []);

    const replacedRoot = path.join(smokeRoot, "replaced-root");
    const replaced = await openFixture(
      { openIntegrationStorageAuthority, createIntegrationRetainedFilePrimitives },
      replacedRoot,
      "replaced-child"
    );
    opened.push(replaced.authority);
    await writeProtected(path.join(replaced.dataPath, "value.txt"), "old");
    await fs.rename(replaced.dataPath, path.join(replacedRoot, "data-displaced"));
    await makeOwnerDirectory(replaced.dataPath);
    await expectCode(() => replaced.primitives.readProtectedUtf8File("value.txt"), "INTEGRATION_STORAGE_POISONED");
    await expectCode(() => replaced.primitives.readProtectedUtf8File("value.txt"), "INTEGRATION_STORAGE_POISONED");

    for (const authority of opened.reverse()) await authority.close().catch(() => {});
    opened.length = 0;
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
    await runMockProcesses();
  } finally {
    for (const authority of opened.reverse()) await authority.close().catch(() => {});
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write("integration retained durable-common smoke: ok\n");
}

if (MOCK_MODE) await runMockChild(MOCK_MODE);
else await main();
