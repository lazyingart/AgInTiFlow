import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { authorityFail } from "./integration-durable-common.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_STORAGE_AUTHORITY_VERSION = "aginti-retained-storage-authority-v1";
export const INTEGRATION_RETAINED_DIRECTORY_VERSION = "aginti-retained-directory-v1";
export const INTEGRATION_STORAGE_ATTESTATION_VERSION = "aginti-retained-storage-attestation-v1";

// Node 22 does not expose openat/openat2/renameat2/unlinkat. This primitive
// only retains directory FileHandles and walks read-only children through
// /proc/self/fd; it is a pre-enable building block, not same-uid mutation-safe
// production storage and not a file-write/rename/unlink authority.
export const INTEGRATION_STORAGE_LIMITATIONS = Object.freeze({
  preEnablePrimitive: true,
  procfsRequired: true,
  nodeOpenat: false,
  nodeOpenat2: false,
  openat2ResolveBeneath: false,
  noXdev: false,
  nodeRenameat2: false,
  nodeUnlinkat: false,
  sameUidMutationSafety: false,
  mutationMethods: false,
});

const AUTHORITY_KEYS = Object.freeze(["rootPath", "role", "ownerUid", "ownerGid", "label"]);
const EXPECTED_AUTHORITY_KEYS = Object.freeze(["role", "canonicalPath", "rootIdentityDigest"]);
const ATTESTATION_KEYS = Object.freeze([
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
const AUTHORITY_SURFACE_KEYS = Object.freeze([
  "schemaVersion",
  "attestation",
  "identity",
  "openDirectory",
  "admitOperation",
  "recheckNamedBinding",
  "close",
  "isClosed",
]);
const DIRECTORY_SURFACE_KEYS = Object.freeze([
  "schemaVersion",
  "attestation",
  "identity",
  "openDirectory",
  "close",
  "isClosed",
]);
const LEASE_SURFACE_KEYS = Object.freeze(["schemaVersion", "release"]);

const authorityBrand = new WeakMap();
const directoryBrand = new WeakMap();
const attestationBrand = new WeakMap();
const leaseBrand = new WeakMap();

const OPEN_DIRECTORY_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const MAX_SEGMENT_UTF8_BYTES = 160;
const MAX_WALK_SEGMENTS = 64;

function fail(code, message, details = {}) {
  authorityFail(code, message, { details });
}

function isAuthorityError(error) {
  return error?.name === "IntegrationAuthorityError" || Boolean(error?.publicCode);
}

function ensureLinuxNode22() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (process.platform !== "linux" || major !== 22) {
    fail("INTEGRATION_STORAGE_UNAVAILABLE", "Retained storage authority requires Linux Node 22.");
  }
  if (
    typeof fsConstants.O_DIRECTORY !== "number" ||
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    !Number.isSafeInteger(process.getuid?.()) ||
    !Number.isSafeInteger(process.getgid?.())
  ) {
    fail("INTEGRATION_STORAGE_UNAVAILABLE", "Retained storage authority requires directory no-follow support.");
  }
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) freezeDeep(value[key]);
  return Object.freeze(value);
}

function assertPlainDataObject(value, allowedKeys, label, { required = [] } = {}) {
  if (value && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value)) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} must not be a Proxy.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} prototype is invalid.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} must not contain symbols.`);
  }
  for (const key of keys) {
    if (!allowedKeys.includes(key)) fail("INTEGRATION_STORAGE_INVALID", `${label}.${key} is not allowed.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("INTEGRATION_STORAGE_INVALID", `${label}.${key} must be an enumerable data field.`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("INTEGRATION_STORAGE_INVALID", `${label}.${key} is required.`);
    }
  }
  const clone = {};
  for (const key of keys) clone[key] = Object.getOwnPropertyDescriptor(value, key).value;
  return Object.freeze(clone);
}

function assertCanonicalRootPath(value) {
  if (typeof value !== "string") fail("INTEGRATION_STORAGE_INVALID", "rootPath must be a string.");
  if (value.includes("\0")) fail("INTEGRATION_STORAGE_INVALID", "rootPath must not contain NUL.");
  if (!path.isAbsolute(value)) fail("INTEGRATION_STORAGE_INVALID", "rootPath must be absolute.");
  if (path.normalize(value) !== value || (value.length > 1 && value.endsWith(path.sep))) {
    fail("INTEGRATION_STORAGE_INVALID", "rootPath must be canonical.");
  }
  if (value === path.sep) fail("INTEGRATION_STORAGE_INVALID", "rootPath must not be the filesystem root.");
  return value;
}

function assertUid(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail("INTEGRATION_STORAGE_INVALID", `${label} is invalid.`);
  return value;
}

function normalizeOptions(input) {
  const options = assertPlainDataObject(input, AUTHORITY_KEYS, "storage options", {
    required: ["rootPath", "role"],
  });
  return Object.freeze({
    rootPath: assertCanonicalRootPath(options.rootPath),
    role: assertSafeRole(options.role),
    ownerUid: options.ownerUid === undefined ? process.getuid() : assertUid(options.ownerUid, "ownerUid"),
    ownerGid: options.ownerGid === undefined ? process.getgid() : assertUid(options.ownerGid, "ownerGid"),
    label: options.label === undefined ? "integration storage root" : assertSafeLabel(options.label),
  });
}

function normalizeExpectedAuthority(input) {
  const expected = assertPlainDataObject(input, EXPECTED_AUTHORITY_KEYS, "expected storage authority", {
    required: EXPECTED_AUTHORITY_KEYS,
  });
  if (typeof expected.rootIdentityDigest !== "string" || !/^[a-f0-9]{64}$/u.test(expected.rootIdentityDigest)) {
    fail("INTEGRATION_STORAGE_INVALID", "expected storage authority rootIdentityDigest is invalid.");
  }
  return Object.freeze({
    role: assertSafeRole(expected.role),
    canonicalPath: assertCanonicalRootPath(expected.canonicalPath),
    rootIdentityDigest: expected.rootIdentityDigest,
  });
}

function assertSafeLabel(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9 ._-]{1,80}$/u.test(value)) {
    fail("INTEGRATION_STORAGE_INVALID", "storage label is invalid.");
  }
  return value;
}

function assertSafeRole(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/u.test(value)) {
    fail("INTEGRATION_STORAGE_INVALID", "storage role is invalid.");
  }
  return value;
}

function assertSafeSegment(value, label = "path segment") {
  if (typeof value !== "string") fail("INTEGRATION_STORAGE_INVALID", `${label} must be a string.`);
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_SEGMENT_UTF8_BYTES ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} is invalid.`);
  }
  return value;
}

function cloneSegments(input, label = "directory segments") {
  if (input && (typeof input === "object" || typeof input === "function") && utilTypes.isProxy(input)) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} must not be a Proxy.`);
  }
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} must be an exact array.`);
  }
  const keys = Reflect.ownKeys(input);
  const indexKeys = keys.filter((key) => key !== "length");
  if (indexKeys.some((key) => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} must not contain symbols or named fields.`);
  }
  if (input.length < 1 || input.length > MAX_WALK_SEGMENTS || indexKeys.length !== input.length) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} must be a dense non-empty array.`);
  }
  const segments = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("INTEGRATION_STORAGE_INVALID", `${label}[${index}] must be an enumerable data field.`);
    }
    segments.push(assertSafeSegment(descriptor.value, `${label}[${index}]`));
  }
  return Object.freeze(segments);
}

function bigintIdentityFromStat(stat) {
  return freezeDeep({
    schemaVersion: "aginti-retained-inode-identity-v1",
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    nlink: stat.nlink,
    ctimeNs: stat.ctimeNs,
  });
}

function digestibleIdentity(identity) {
  return {
    schemaVersion: identity.schemaVersion,
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    mode: identity.mode.toString(),
    uid: identity.uid.toString(),
    gid: identity.gid.toString(),
    nlink: identity.nlink.toString(),
    ctimeNs: identity.ctimeNs.toString(),
  };
}

function makePublicIdentity(identity) {
  return freezeDeep({
    ...digestibleIdentity(identity),
    digest: identityDigest(identity),
  });
}

function identityDigest(identity) {
  return contractDigest(digestibleIdentity(identity));
}

function sameRequiredIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.uid === right.uid &&
      left.gid === right.gid &&
      left.mode === right.mode &&
      left.nlink === right.nlink
  );
}

function assertOwnerOnlyDirectoryStat(stat, expected, label) {
  if (!stat.isDirectory()) fail("INTEGRATION_STORAGE_UNAVAILABLE", `${label} must be a directory.`);
  if (stat.uid !== BigInt(expected.ownerUid) || stat.gid !== BigInt(expected.ownerGid)) {
    fail("INTEGRATION_STORAGE_UNAVAILABLE", `${label} owner uid/gid is invalid.`);
  }
  if ((stat.mode & 0o7777n) !== 0o700n) {
    fail("INTEGRATION_STORAGE_UNAVAILABLE", `${label} mode must be exactly 0700.`);
  }
  if (stat.nlink < 2n) fail("INTEGRATION_STORAGE_UNAVAILABLE", `${label} link count is invalid.`);
}

function assertLiveOwnerOnlyDirectoryStat(stat, expected, label) {
  try {
    assertOwnerOnlyDirectoryStat(stat, expected, label);
  } catch (error) {
    if (error?.publicCode === "INTEGRATION_STORAGE_POISONED") throw error;
    fail("INTEGRATION_STORAGE_POISONED", `${label} live metadata diverged.`, {
      causeCode: error?.publicCode || error?.code || "",
    });
  }
}

function buildAttestation({ role, canonicalPath, ownerUid, ownerGid, rootIdentity }) {
  const unsigned = {
    schemaVersion: INTEGRATION_STORAGE_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    role,
    platform: "linux",
    nodeMajor: 22,
    canonicalPath,
    retainedDirectoryFileHandles: true,
    procSelfFdWalk: true,
    ownerUid,
    ownerGid,
    ownerOnlyMode: "0700",
    rootIdentityDigest: identityDigest(rootIdentity),
    limitations: INTEGRATION_STORAGE_LIMITATIONS,
    digest: "0".repeat(64),
  };
  const { digest: _digest, ...digestInput } = unsigned;
  const attestation = freezeDeep({
    ...unsigned,
    digest: contractDigest(digestInput),
  });
  attestationBrand.set(attestation, Object.freeze({
    role,
    canonicalPath,
    rootIdentityDigest: unsigned.rootIdentityDigest,
  }));
  return attestation;
}

function assertExpectedStorageState(state, expectedInput, label) {
  if (expectedInput === undefined) return;
  const expected = normalizeExpectedAuthority(expectedInput);
  const actualRootIdentityDigest = state.rootIdentityDigest || identityDigest(state.rootIdentity);
  if (
    state.role !== expected.role ||
    state.canonicalPath !== expected.canonicalPath ||
    actualRootIdentityDigest !== expected.rootIdentityDigest
  ) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} does not match the expected retained storage authority.`);
  }
}

async function fstatRetainedHandleIdentity(handle, expectedIdentity, expectedOwner, label) {
  let stat = null;
  try {
    stat = await handle.stat({ bigint: true });
  } catch (error) {
    fail("INTEGRATION_STORAGE_POISONED", `${label} retained handle is unavailable.`, {
      causeCode: error?.code || "",
    });
  }
  assertLiveOwnerOnlyDirectoryStat(stat, expectedOwner, label);
  const current = bigintIdentityFromStat(stat);
  if (!sameRequiredIdentity(current, expectedIdentity)) {
    fail("INTEGRATION_STORAGE_POISONED", `${label} retained handle identity changed.`);
  }
  return current;
}

async function fstatRootHandle(root) {
  if (!root.rootDirectory || root.rootDirectory.closed) {
    fail("INTEGRATION_STORAGE_POISONED", "Retained storage root handle is unavailable.");
  }
  try {
    const identity = await fstatRetainedHandleIdentity(
      root.rootDirectory.handle,
      root.rootIdentity,
      root,
      "retained storage root"
    );
    assertRootOpen(root);
    return identity;
  } catch (error) {
    root.poisoned = true;
    root.poisonReason = error?.message || "Retained storage root handle changed.";
    if (error?.publicCode === "INTEGRATION_STORAGE_POISONED") throw error;
    fail("INTEGRATION_STORAGE_POISONED", root.poisonReason, {
      causeCode: error?.publicCode || error?.code || "",
    });
  }
}

async function fstatDirectoryHandle(dir) {
  try {
    const identity = await fstatRetainedHandleIdentity(dir.handle, dir.identity, dir.root, "retained directory");
    assertDirectoryOpen(dir);
    return identity;
  } catch (error) {
    dir.poisoned = true;
    dir.poisonReason = error?.message || "Retained directory handle changed.";
    dir.root.poisoned = true;
    dir.root.poisonReason = dir.poisonReason;
    if (error?.publicCode === "INTEGRATION_STORAGE_POISONED") throw error;
    fail("INTEGRATION_STORAGE_POISONED", dir.poisonReason, {
      causeCode: error?.publicCode || error?.code || "",
    });
  }
}

function validateSurface(surface, keys, label) {
  if (utilTypes.isProxy(surface) || !Object.isFrozen(surface)) {
    fail("INTEGRATION_STORAGE_CORRUPT", `${label} surface is not frozen data.`);
  }
  if (Object.getPrototypeOf(surface) !== Object.prototype) {
    fail("INTEGRATION_STORAGE_CORRUPT", `${label} surface prototype is invalid.`);
  }
  const ownKeys = Reflect.ownKeys(surface);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key, index) => key !== keys[index])
  ) {
    fail("INTEGRATION_STORAGE_CORRUPT", `${label} surface keys are invalid.`);
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(surface, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== false ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("INTEGRATION_STORAGE_CORRUPT", `${label}.${String(key)} descriptor is invalid.`);
    }
  }
  return surface;
}

function assertRootOpen(root) {
  if (root.closed) fail("INTEGRATION_STORAGE_CLOSED", "Retained storage authority is closed.");
  if (root.poisoned) fail("INTEGRATION_STORAGE_POISONED", root.poisonReason || "Retained storage authority is poisoned.");
}

function assertDirectoryOpen(dir) {
  assertRootOpen(dir.root);
  if (dir.closed) fail("INTEGRATION_STORAGE_CLOSED", "Retained directory handle is closed.");
  if (dir.poisoned) fail("INTEGRATION_STORAGE_POISONED", dir.poisonReason || "Retained directory handle is poisoned.");
}

function releaseOperation(target, token) {
  if (!target.activeOperations.has(token)) return;
  target.activeOperations.delete(token);
  for (const waiter of target.waiters.splice(0)) waiter();
}

function admitRootOperation(root, label) {
  assertRootOpen(root);
  if (root.closing) fail("INTEGRATION_STORAGE_CLOSED", "Retained storage authority is closing.");
  const token = Object.freeze({ label, id: Symbol(label) });
  root.activeOperations.add(token);
  return () => releaseOperation(root, token);
}

function admitDirectoryOperation(dir, label) {
  const releaseRoot = admitRootOperation(dir.root, label);
  try {
    assertDirectoryOpen(dir);
    if (dir.closing) fail("INTEGRATION_STORAGE_CLOSED", "Retained directory handle is closing.");
    const token = Object.freeze({ label, id: Symbol(label) });
    dir.activeOperations.add(token);
    return () => {
      releaseOperation(dir, token);
      releaseRoot();
    };
  } catch (error) {
    releaseRoot();
    throw error;
  }
}

function makeLease(root, label) {
  const release = admitRootOperation(root, label);
  let released = false;
  const lease = Object.freeze({
    schemaVersion: "aginti-retained-storage-operation-lease-v1",
    release() {
      if (released) return Object.freeze({ released: false });
      released = true;
      release();
      return Object.freeze({ released: true });
    },
  });
  validateSurface(lease, LEASE_SURFACE_KEYS, "lease");
  leaseBrand.set(lease, { root });
  return lease;
}

async function waitForOperations(target) {
  while (target.activeOperations.size > 0) {
    await new Promise((resolve) => {
      target.waiters.push(resolve);
    });
  }
}

function closeFailureDetails(error, label) {
  return Object.freeze({
    label,
    code: typeof error?.code === "string" ? error.code : "",
    message: typeof error?.message === "string" ? error.message : String(error || ""),
  });
}

function throwCleanupFailure(message, failures, extra = {}) {
  fail("INTEGRATION_STORAGE_CLEANUP_FAILED", message, {
    ...extra,
    failures: failures.map((failure) => closeFailureDetails(failure.error, failure.label)),
  });
}

async function closeHandleBestEffort(handle, failures, label) {
  if (!handle) return;
  try {
    await handle.close();
  } catch (error) {
    failures.push({ label, error });
  }
}

async function closeDirectoryState(dir) {
  if (dir.closePromise) return dir.closePromise;
  if (dir.closed) return Object.freeze({ closed: true });
  dir.closing = true;
  dir.closePromise = (async () => {
    await waitForOperations(dir);
    dir.closed = true;
    dir.poisoned = true;
    dir.poisonReason = "Retained directory handle is closed.";
    dir.root.directories.delete(dir);
    const failures = [];
    await closeHandleBestEffort(dir.handle, failures, "retained directory");
    if (failures.length > 0) {
      dir.root.poisoned = true;
      dir.root.poisonReason = "Retained directory handle cleanup failed.";
      throwCleanupFailure("Retained directory handle cleanup failed.", failures);
    }
    return Object.freeze({ closed: true });
  })();
  return dir.closePromise;
}

async function closeRootState(root) {
  if (root.closePromise) return root.closePromise;
  root.closing = true;
  root.closePromise = (async () => {
    await waitForOperations(root);
    const directories = [...root.directories].sort((left, right) => right.depth - left.depth);
    const failures = [];
    for (const dir of directories) {
      try {
        await closeDirectoryState(dir);
      } catch (error) {
        failures.push({ label: `retained directory depth ${dir.depth}`, error });
      }
    }
    root.closed = true;
    if (failures.length > 0) {
      root.poisoned = true;
      root.poisonReason = "Retained storage authority cleanup failed.";
      throwCleanupFailure("Retained storage authority cleanup failed.", failures);
    }
    return Object.freeze({ closed: true });
  })();
  return root.closePromise;
}

async function recheckNamedBinding(root) {
  assertRootOpen(root);
  await fstatRootHandle(root);
  assertRootOpen(root);
  const link = await fs.lstat(root.rootPath, { bigint: true }).catch((error) => {
    root.poisoned = true;
    root.poisonReason = "Retained storage named root binding disappeared.";
    fail("INTEGRATION_STORAGE_POISONED", "Retained storage named root binding disappeared.", {
      causeCode: error?.code || "",
    });
  });
  assertRootOpen(root);
  if (link.isSymbolicLink()) {
    root.poisoned = true;
    root.poisonReason = "Retained storage named root binding is a symlink.";
    fail("INTEGRATION_STORAGE_POISONED", "Retained storage named root binding is a symlink.");
  }
  const realPath = await fs.realpath(root.rootPath).catch((error) => {
    root.poisoned = true;
    root.poisonReason = "Retained storage named root binding cannot be resolved.";
    fail("INTEGRATION_STORAGE_POISONED", "Retained storage named root binding cannot be resolved.", {
      causeCode: error?.code || "",
    });
  });
  assertRootOpen(root);
  if (realPath !== root.rootPath) {
    root.poisoned = true;
    root.poisonReason = "Retained storage named root realpath changed.";
    fail("INTEGRATION_STORAGE_POISONED", "Retained storage named root realpath changed.");
  }
  const stat = await fs.stat(root.rootPath, { bigint: true }).catch((error) => {
    root.poisoned = true;
    root.poisonReason = "Retained storage named root binding disappeared.";
    fail("INTEGRATION_STORAGE_POISONED", "Retained storage named root binding disappeared.", {
      causeCode: error?.code || "",
    });
  });
  assertRootOpen(root);
  try {
    assertLiveOwnerOnlyDirectoryStat(stat, root, "named storage root");
    const current = bigintIdentityFromStat(stat);
    if (!sameRequiredIdentity(current, root.rootIdentity)) {
      fail("INTEGRATION_STORAGE_POISONED", "Retained storage named root binding changed.");
    }
    assertRootOpen(root);
    return Object.freeze({
      ok: true,
      poisoned: false,
      identityDigest: identityDigest(root.rootIdentity),
    });
  } catch (error) {
    root.poisoned = true;
    root.poisonReason = error?.message || "Retained storage named binding changed.";
    throw error;
  }
}

function procFdChildPath(handle, segment) {
  return `/proc/self/fd/${handle.fd}/${segment}`;
}

async function openOneChildDirectory(parent, segment) {
  assertDirectoryOpen(parent);
  await fstatDirectoryHandle(parent);
  assertDirectoryOpen(parent);
  const childPath = procFdChildPath(parent.handle, segment);
  let handle = null;
  try {
    handle = await fs.open(childPath, OPEN_DIRECTORY_FLAGS);
    assertDirectoryOpen(parent);
    const stat = await handle.stat({ bigint: true });
    assertDirectoryOpen(parent);
    assertOwnerOnlyDirectoryStat(stat, parent.root, "retained child directory");
    return makeDirectorySurface(parent.root, handle, bigintIdentityFromStat(stat), parent.depth + 1);
  } catch (error) {
    if (handle) {
      const failures = [];
      await closeHandleBestEffort(handle, failures, "failed retained child directory");
      if (failures.length > 0) {
        throwCleanupFailure("Retained child directory cleanup failed.", failures, {
          originalCode: error?.publicCode || error?.code || "",
        });
      }
    }
    if (isAuthorityError(error)) throw error;
    fail("INTEGRATION_STORAGE_UNAVAILABLE", "Retained child directory could not be opened.");
  }
}

async function openDirectoryFrom(parent, input) {
  const segments = cloneSegments(input);
  const release = admitDirectoryOperation(parent, "openDirectory");
  let current = parent;
  const openedDuringWalk = [];
  let priorWalkDirectory = null;
  try {
    await recheckNamedBinding(parent.root);
    assertDirectoryOpen(parent);
    for (const segment of segments) {
      const next = await openOneChildDirectory(current, segment);
      openedDuringWalk.push(next);
      if (priorWalkDirectory) {
        await closeDirectoryState(priorWalkDirectory);
        assertDirectoryOpen(parent);
        openedDuringWalk.splice(openedDuringWalk.indexOf(priorWalkDirectory), 1);
      }
      priorWalkDirectory = next;
      current = next;
    }
    await recheckNamedBinding(parent.root);
    assertDirectoryOpen(parent);
    openedDuringWalk.length = 0;
    return current.surface;
  } catch (error) {
    const cleanupFailures = [];
    for (const dir of openedDuringWalk.reverse()) {
      try {
        await closeDirectoryState(dir);
      } catch (closeError) {
        cleanupFailures.push({ label: `retained opened directory depth ${dir.depth}`, error: closeError });
      }
    }
    if (cleanupFailures.length > 0) {
      throwCleanupFailure("Retained opened directory cleanup failed.", cleanupFailures, {
        originalCode: error?.publicCode || error?.code || "",
      });
    }
    throw error;
  } finally {
    release();
  }
}

function rootPathSegments(rootPath) {
  return Object.freeze(rootPath.split(path.sep).filter(Boolean).map((segment, index) =>
    assertSafeSegment(segment, `rootPath segment ${index}`)
  ));
}

async function openRootComponentByComponent(options) {
  const segments = rootPathSegments(options.rootPath);
  const opened = [];
  let currentHandle = null;
  try {
    currentHandle = await fs.open(path.sep, OPEN_DIRECTORY_FLAGS);
    opened.push(currentHandle);
    for (const segment of segments) {
      const nextHandle = await fs.open(procFdChildPath(currentHandle, segment), OPEN_DIRECTORY_FLAGS);
      opened.push(nextHandle);
      currentHandle = nextHandle;
    }
    const handle = opened[opened.length - 1];
    const stat = await handle.stat({ bigint: true });
    assertOwnerOnlyDirectoryStat(stat, options, "storage root");
    for (const intermediate of opened.slice(0, -1).reverse()) await intermediate.close();
    opened.length = 0;
    return Object.freeze({ handle, identity: bigintIdentityFromStat(stat) });
  } catch (error) {
    const cleanupFailures = [];
    for (const handle of opened.reverse()) await closeHandleBestEffort(handle, cleanupFailures, "root path walk handle");
    if (cleanupFailures.length > 0) {
      throwCleanupFailure("storage root component-walk cleanup failed.", cleanupFailures, {
        originalCode: error?.publicCode || error?.code || "",
      });
    }
    if (isAuthorityError(error)) throw error;
    fail("INTEGRATION_STORAGE_UNAVAILABLE", "storage root could not be opened component-by-component.");
  }
}

function makeDirectorySurface(root, handle, identity, depth) {
  const dir = {
    root,
    handle,
    identity,
    depth,
    activeOperations: new Set(),
    waiters: [],
    closing: false,
    closed: false,
    poisoned: false,
    poisonReason: "",
    closePromise: null,
    surface: null,
  };
  const surface = Object.freeze({
    schemaVersion: INTEGRATION_RETAINED_DIRECTORY_VERSION,
    attestation: root.attestation,
    async identity() {
      const release = admitDirectoryOperation(dir, "directory identity");
      try {
        await fstatDirectoryHandle(dir);
        assertDirectoryOpen(dir);
        await recheckNamedBinding(root);
        assertDirectoryOpen(dir);
        return makePublicIdentity(dir.identity);
      } finally {
        release();
      }
    },
    openDirectory(segments) {
      return openDirectoryFrom(dir, segments);
    },
    close() {
      return closeDirectoryState(dir).then(() => Object.freeze({ closed: true }));
    },
    isClosed() {
      return dir.closed || root.closed;
    },
  });
  dir.surface = validateSurface(surface, DIRECTORY_SURFACE_KEYS, "directory");
  root.directories.add(dir);
  directoryBrand.set(surface, dir);
  return dir;
}

function makeAuthoritySurface(root, rootDirectory) {
  const surface = Object.freeze({
    schemaVersion: INTEGRATION_STORAGE_AUTHORITY_VERSION,
    attestation: root.attestation,
    async identity() {
      const release = admitRootOperation(root, "authority identity");
      try {
        await recheckNamedBinding(root);
        assertRootOpen(root);
        return makePublicIdentity(root.rootIdentity);
      } finally {
        release();
      }
    },
    openDirectory(segments) {
      return openDirectoryFrom(rootDirectory, segments);
    },
    admitOperation(label = "operation") {
      if (typeof label !== "string" || label.length > 80) {
        fail("INTEGRATION_STORAGE_INVALID", "operation label is invalid.");
      }
      return makeLease(root, label);
    },
    recheckNamedBinding() {
      const release = admitRootOperation(root, "recheckNamedBinding");
      return recheckNamedBinding(root).finally(release);
    },
    close() {
      return closeRootState(root);
    },
    isClosed() {
      return root.closed;
    },
  });
  authorityBrand.set(surface, root);
  return validateSurface(surface, AUTHORITY_SURFACE_KEYS, "authority");
}

export async function openIntegrationStorageAuthority(input = {}) {
  ensureLinuxNode22();
  const options = normalizeOptions(input);
  const link = await fs.lstat(options.rootPath, { bigint: true }).catch((error) => {
    if (error?.code === "ENOENT") fail("INTEGRATION_STORAGE_UNAVAILABLE", "storage root does not exist.");
    throw error;
  });
  if (link.isSymbolicLink()) {
    fail("INTEGRATION_STORAGE_INVALID", "storage root path must not be a symlink.");
  }
  const realPath = await fs.realpath(options.rootPath).catch((error) => {
    if (error?.code === "ENOENT") fail("INTEGRATION_STORAGE_UNAVAILABLE", "storage root does not exist.");
    throw error;
  });
  if (realPath !== options.rootPath) {
    fail("INTEGRATION_STORAGE_INVALID", "storage root path must be canonical and symlink-free.");
  }
  let openedRoot = null;
  try {
    openedRoot = await openRootComponentByComponent(options);
    const rootIdentity = openedRoot.identity;
    const attestation = buildAttestation({
      role: options.role,
      canonicalPath: options.rootPath,
      ownerUid: options.ownerUid,
      ownerGid: options.ownerGid,
      rootIdentity,
    });
    const root = {
      rootPath: options.rootPath,
      canonicalPath: options.rootPath,
      role: options.role,
      ownerUid: options.ownerUid,
      ownerGid: options.ownerGid,
      label: options.label,
      rootIdentity,
      attestation,
      rootDirectory: null,
      directories: new Set(),
      activeOperations: new Set(),
      waiters: [],
      closing: false,
      closed: false,
      poisoned: false,
      poisonReason: "",
      closePromise: null,
    };
    const rootDirectory = makeDirectorySurface(root, openedRoot.handle, rootIdentity, 0);
    root.rootDirectory = rootDirectory;
    openedRoot = null;
    const authority = makeAuthoritySurface(root, rootDirectory);
    try {
      await recheckNamedBinding(root);
    } catch (error) {
      await closeRootState(root);
      throw error;
    }
    return authority;
  } catch (error) {
    if (openedRoot?.handle) await openedRoot.handle.close();
    throw error;
  }
}

export function assertIntegrationStorageAuthority(value, expected) {
  const state = value && typeof value === "object" ? authorityBrand.get(value) : null;
  if (!state) fail("INTEGRATION_STORAGE_INVALID", "Integration storage authority brand is invalid.");
  validateSurface(value, AUTHORITY_SURFACE_KEYS, "authority");
  assertExpectedStorageState(state, expected, "Integration storage authority");
  return value;
}

export function assertIntegrationStorageAttestation(value, expected) {
  const state = value && typeof value === "object" && !utilTypes.isProxy(value) ? attestationBrand.get(value) : null;
  if (!state) {
    fail("INTEGRATION_STORAGE_INVALID", "Integration storage attestation brand is invalid.");
  }
  validateSurface(value, ATTESTATION_KEYS, "attestation");
  assertExpectedStorageState(state, expected, "Integration storage attestation");
  return value;
}

export function assertIntegrationRetainedDirectory(value) {
  const state = value && typeof value === "object" ? directoryBrand.get(value) : null;
  if (!state) fail("INTEGRATION_STORAGE_INVALID", "Integration retained directory brand is invalid.");
  validateSurface(value, DIRECTORY_SURFACE_KEYS, "directory");
  return value;
}

export function assertIntegrationStorageLease(value) {
  const state = value && typeof value === "object" ? leaseBrand.get(value) : null;
  if (!state) fail("INTEGRATION_STORAGE_INVALID", "Integration storage lease brand is invalid.");
  validateSurface(value, LEASE_SURFACE_KEYS, "lease");
  return value;
}
