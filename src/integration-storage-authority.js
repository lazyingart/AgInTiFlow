import crypto from "node:crypto";
import { constants as fsConstants, fstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder, types as utilTypes } from "node:util";
import { authorityFail } from "./integration-authority-error.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_STORAGE_AUTHORITY_VERSION = "aginti-retained-storage-authority-v1";
export const INTEGRATION_RETAINED_DIRECTORY_VERSION = "aginti-retained-directory-v1";
export const INTEGRATION_STORAGE_ATTESTATION_VERSION = "aginti-retained-storage-attestation-v1";
export const INTEGRATION_RETAINED_FILE_PRIMITIVES_VERSION = "aginti-retained-file-primitives-v1";
export const INTEGRATION_RETAINED_FILE_ATTESTATION_VERSION = "aginti-retained-file-attestation-v1";

// Node 22 does not expose openat/openat2/renameat2/unlinkat. This primitive
// retains directory FileHandles and walks children through /proc/self/fd. The
// base authority surface has no mutation method. The separately branded file
// primitive below is still pre-enable and is not same-uid mutation-safe.
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

export const INTEGRATION_RETAINED_FILE_LIMITATIONS = Object.freeze({
  preEnablePrimitive: true,
  procfsRequired: true,
  preprovisionedDirectoryRequired: true,
  nodeOpenat: false,
  nodeOpenat2: false,
  openat2ResolveBeneath: false,
  noXdev: false,
  nodeRenameat2: false,
  nodeUnlinkat: false,
  sameUidMutationSafety: false,
  namedBindingRaceFree: false,
  crossProcessSerialization: false,
  compareAndSwap: false,
  directoryMutationMethods: false,
  appendMethods: false,
  listMethods: false,
  deleteMethods: false,
  lockMethods: false,
  crashOrphanCleanup: false,
  crashMayLeaveReservedTemp: true,
  commitMayBeAmbiguousAfterRename: true,
  hardwareDurabilityGuarantee: false,
});

const AUTHORITY_KEYS = Object.freeze(["rootPath", "role", "ownerUid", "ownerGid", "label"]);
const EXPECTED_AUTHORITY_KEYS = Object.freeze(["role", "canonicalPath", "rootIdentityDigest"]);
const EXPECTED_DIRECTORY_KEYS = Object.freeze([
  "role",
  "canonicalPath",
  "rootIdentityDigest",
  "relativeSegments",
  "directoryIdentityDigest",
]);
const FILE_READ_OPTION_KEYS = Object.freeze(["optional", "maxBytes"]);
const FILE_WRITE_OPTION_KEYS = Object.freeze(["maxBytes"]);
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
const FILE_PRIMITIVES_SURFACE_KEYS = Object.freeze([
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

const authorityBrand = new WeakMap();
const directoryBrand = new WeakMap();
const attestationBrand = new WeakMap();
const leaseBrand = new WeakMap();
const filePrimitivesBrand = new WeakMap();

const OPEN_DIRECTORY_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const OPEN_PROTECTED_READ_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const MAX_SEGMENT_UTF8_BYTES = 160;
const MAX_WALK_SEGMENTS = 64;
const DEFAULT_PROTECTED_FILE_BYTES = 1024 * 1024;
const MAX_PROTECTED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CANONICAL_JSON_DEPTH = 64;
const MAX_CANONICAL_JSON_NODES = 100_000;
const ATOMIC_TEMP_PREFIX = ".aginti-atomic-v1-";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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
    typeof fsConstants.O_NONBLOCK !== "number" ||
    typeof fstatSync !== "function" ||
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

function normalizeExpectedDirectory(input) {
  const expected = assertPlainDataObject(input, EXPECTED_DIRECTORY_KEYS, "expected retained directory", {
    required: EXPECTED_DIRECTORY_KEYS,
  });
  if (typeof expected.rootIdentityDigest !== "string" || !/^[a-f0-9]{64}$/u.test(expected.rootIdentityDigest)) {
    fail("INTEGRATION_STORAGE_INVALID", "expected retained directory rootIdentityDigest is invalid.");
  }
  if (typeof expected.directoryIdentityDigest !== "string" || !/^[a-f0-9]{64}$/u.test(expected.directoryIdentityDigest)) {
    fail("INTEGRATION_STORAGE_INVALID", "expected retained directory directoryIdentityDigest is invalid.");
  }
  const relativeSegments = cloneSegments(expected.relativeSegments, "expected retained directory relativeSegments", {
    allowEmpty: true,
  });
  if (relativeSegments.some((segment) => segment.startsWith(ATOMIC_TEMP_PREFIX))) {
    fail("INTEGRATION_STORAGE_INVALID", "expected retained directory uses the reserved atomic temporary prefix.");
  }
  return Object.freeze({
    role: assertSafeRole(expected.role),
    canonicalPath: assertCanonicalRootPath(expected.canonicalPath),
    rootIdentityDigest: expected.rootIdentityDigest,
    relativeSegments,
    directoryIdentityDigest: expected.directoryIdentityDigest,
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

function assertSafeFileName(value) {
  const fileName = assertSafeSegment(value, "protected file name");
  if (fileName.startsWith(ATOMIC_TEMP_PREFIX)) {
    fail("INTEGRATION_STORAGE_INVALID", "protected file name uses the reserved atomic temporary prefix.");
  }
  return fileName;
}

function cloneSegments(input, label = "directory segments", { allowEmpty = false } = {}) {
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
  const minimum = allowEmpty ? 0 : 1;
  if (input.length < minimum || input.length > MAX_WALK_SEGMENTS || indexKeys.length !== input.length) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} must be a dense ${allowEmpty ? "" : "non-empty "}array.`);
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

function normalizeMaxBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PROTECTED_FILE_BYTES) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} is invalid.`);
  }
  return value;
}

function normalizeReadOptions(input) {
  const options = assertPlainDataObject(input === undefined ? {} : input, FILE_READ_OPTION_KEYS, "protected read options");
  if (options.optional !== undefined && typeof options.optional !== "boolean") {
    fail("INTEGRATION_STORAGE_INVALID", "protected read options.optional must be boolean.");
  }
  return Object.freeze({
    optional: options.optional === true,
    maxBytes: normalizeMaxBytes(options.maxBytes ?? DEFAULT_PROTECTED_FILE_BYTES, "protected read options.maxBytes"),
  });
}

function normalizeWriteOptions(input) {
  const options = assertPlainDataObject(input === undefined ? {} : input, FILE_WRITE_OPTION_KEYS, "protected write options");
  return Object.freeze({
    maxBytes: normalizeMaxBytes(options.maxBytes ?? DEFAULT_PROTECTED_FILE_BYTES, "protected write options.maxBytes"),
  });
}

function canonicalJsonTrapSafe(value) {
  const active = new WeakSet();
  const counter = { nodes: 0 };

  function visit(item, depth) {
    counter.nodes += 1;
    if (counter.nodes > MAX_CANONICAL_JSON_NODES || depth > MAX_CANONICAL_JSON_DEPTH) {
      fail("INTEGRATION_STORAGE_INVALID", "protected JSON exceeds structural bounds.");
    }
    if (item && (typeof item === "object" || typeof item === "function") && utilTypes.isProxy(item)) {
      fail("INTEGRATION_STORAGE_INVALID", "protected JSON must not contain a Proxy.");
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("INTEGRATION_STORAGE_INVALID", "protected JSON contains a non-finite number.");
      return JSON.stringify(item);
    }
    if (!item || typeof item !== "object") {
      fail("INTEGRATION_STORAGE_INVALID", "protected JSON contains a non-JSON value.");
    }
    if (active.has(item)) fail("INTEGRATION_STORAGE_INVALID", "protected JSON must not contain cycles.");
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || !Number.isSafeInteger(item.length)) {
          fail("INTEGRATION_STORAGE_INVALID", "protected JSON array shape is invalid.");
        }
        const keys = Reflect.ownKeys(item);
        if (keys.length !== item.length + 1 || keys[keys.length - 1] !== "length") {
          fail("INTEGRATION_STORAGE_INVALID", "protected JSON array fields are invalid.");
        }
        const values = [];
        for (let index = 0; index < item.length; index += 1) {
          if (keys[index] !== String(index)) fail("INTEGRATION_STORAGE_INVALID", "protected JSON array must be dense.");
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
            fail("INTEGRATION_STORAGE_INVALID", "protected JSON array fields must be enumerable data.");
          }
          values.push(visit(descriptor.value, depth + 1));
        }
        return `[${values.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("INTEGRATION_STORAGE_INVALID", "protected JSON object prototype is invalid.");
      }
      const keys = Reflect.ownKeys(item);
      if (keys.some((key) => typeof key !== "string")) {
        fail("INTEGRATION_STORAGE_INVALID", "protected JSON object must not contain symbols.");
      }
      const values = new Map();
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          fail("INTEGRATION_STORAGE_INVALID", "protected JSON object fields must be enumerable data.");
        }
        values.set(key, descriptor.value);
      }
      return `{${[...keys]
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit(values.get(key), depth + 1)}`)
        .join(",")}}`;
    } finally {
      active.delete(item);
    }
  }

  return visit(value, 0);
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

function sameSegments(left, right) {
  return Boolean(
    Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((segment, index) => segment === right[index])
  );
}

function assertExpectedDirectoryState(dir, expectedInput, label) {
  const expected = normalizeExpectedDirectory(expectedInput);
  const directoryIdentityDigest = identityDigest(dir.identity);
  if (
    dir.root.role !== expected.role ||
    dir.root.canonicalPath !== expected.canonicalPath ||
    identityDigest(dir.root.rootIdentity) !== expected.rootIdentityDigest ||
    !sameSegments(dir.relativeSegments, expected.relativeSegments) ||
    directoryIdentityDigest !== expected.directoryIdentityDigest
  ) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} does not match the expected retained directory.`);
  }
  return expected;
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

async function recheckDirectoryNamedBinding(dir) {
  assertDirectoryOpen(dir);
  await fstatDirectoryHandle(dir);
  assertDirectoryOpen(dir);
  await recheckNamedBinding(dir.root);
  assertDirectoryOpen(dir);
  if (dir.relativeSegments.length === 0) return makePublicIdentity(dir.identity);

  const opened = [];
  let currentHandle = dir.root.rootDirectory.handle;
  let routeIdentity = null;
  let routeError = null;
  try {
    for (const segment of dir.relativeSegments) {
      const nextHandle = await fs.open(procFdChildPath(currentHandle, segment), OPEN_DIRECTORY_FLAGS);
      opened.push(nextHandle);
      currentHandle = nextHandle;
      assertDirectoryOpen(dir);
      const stat = await nextHandle.stat({ bigint: true });
      assertDirectoryOpen(dir);
      assertLiveOwnerOnlyDirectoryStat(stat, dir.root, "retained directory named route");
      routeIdentity = bigintIdentityFromStat(stat);
    }
    if (!sameRequiredIdentity(routeIdentity, dir.identity)) {
      fail("INTEGRATION_STORAGE_POISONED", "Retained directory named binding changed.");
    }
  } catch (error) {
    routeError = error;
  }

  const cleanupFailures = [];
  for (const handle of opened.reverse()) {
    await closeHandleBestEffort(handle, cleanupFailures, "retained directory named-route handle");
  }
  if (cleanupFailures.length > 0) {
    dir.poisoned = true;
    dir.poisonReason = "Retained directory named-route cleanup failed.";
    dir.root.poisoned = true;
    dir.root.poisonReason = dir.poisonReason;
    throwCleanupFailure("Retained directory named-route cleanup failed.", cleanupFailures, {
      originalCode: routeError?.publicCode || routeError?.code || "",
    });
  }
  if (routeError) {
    dir.poisoned = true;
    dir.poisonReason = "Retained directory named binding cannot be proven.";
    dir.root.poisoned = true;
    dir.root.poisonReason = dir.poisonReason;
    if (routeError?.publicCode === "INTEGRATION_STORAGE_POISONED") throw routeError;
    fail("INTEGRATION_STORAGE_POISONED", "Retained directory named binding cannot be proven.", {
      causeCode: routeError?.publicCode || routeError?.code || "",
    });
  }

  await fstatDirectoryHandle(dir);
  assertDirectoryOpen(dir);
  await recheckNamedBinding(dir.root);
  assertDirectoryOpen(dir);
  return makePublicIdentity(dir.identity);
}

function protectedFileIdentityFromStat(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function sameProtectedFileObject(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode &&
      left.uid === right.uid &&
      left.gid === right.gid &&
      left.nlink === right.nlink
  );
}

function sameStableProtectedFile(left, right) {
  return Boolean(
    sameProtectedFileObject(left, right) &&
      left.size === right.size &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs
  );
}

function assertProtectedRegularFileStat(stat, root, maxBytes, label) {
  if (!stat.isFile()) fail("INTEGRATION_STORAGE_FILE_CORRUPT", `${label} must be a regular file.`);
  if (stat.uid !== BigInt(root.ownerUid) || stat.gid !== BigInt(root.ownerGid)) {
    fail("INTEGRATION_STORAGE_FILE_CORRUPT", `${label} owner uid/gid is invalid.`);
  }
  if ((stat.mode & 0o7777n) !== 0o600n) {
    fail("INTEGRATION_STORAGE_FILE_CORRUPT", `${label} mode must be exactly 0600.`);
  }
  if (stat.nlink !== 1n) fail("INTEGRATION_STORAGE_FILE_CORRUPT", `${label} must not have hard links.`);
  if (stat.size < 0n || stat.size > BigInt(maxBytes)) {
    fail("INTEGRATION_STORAGE_FILE_CORRUPT", `${label} size exceeds its protected bound.`);
  }
  return protectedFileIdentityFromStat(stat);
}

function assertProtectedNameBinding(stat, expectedIdentity, root, maxBytes, label, { stable = false } = {}) {
  const namedIdentity = assertProtectedRegularFileStat(stat, root, maxBytes, label);
  const matches = stable
    ? sameStableProtectedFile(namedIdentity, expectedIdentity)
    : sameProtectedFileObject(namedIdentity, expectedIdentity);
  if (!matches) fail("INTEGRATION_STORAGE_FILE_CORRUPT", `${label} named binding changed.`);
  return namedIdentity;
}

function throwNormalizedFileOperationError(error, operation) {
  if (isAuthorityError(error)) {
    const code = typeof error?.publicCode === "string" ? error.publicCode : "INTEGRATION_STORAGE_FILE_UNAVAILABLE";
    const messages = {
      INTEGRATION_STORAGE_INVALID: `Protected file ${operation} input is invalid.`,
      INTEGRATION_STORAGE_CLOSED: `Protected file ${operation} rejected a closed retained directory.`,
      INTEGRATION_STORAGE_POISONED: `Protected file ${operation} rejected a poisoned retained binding.`,
      INTEGRATION_STORAGE_FILE_CORRUPT: `Protected file ${operation} detected corrupt or unstable state.`,
      INTEGRATION_STORAGE_CLEANUP_FAILED: `Protected file ${operation} cleanup failed.`,
    };
    authorityFail(code, messages[code] || `Protected file ${operation} failed safely.`, {
      status: Number.isSafeInteger(error?.status) ? error.status : 503,
      details: { phase: operation },
    });
  }
  if (error?.code === "ELOOP") {
    fail("INTEGRATION_STORAGE_FILE_CORRUPT", `Protected file ${operation} rejected a symbolic link.`);
  }
  fail("INTEGRATION_STORAGE_FILE_UNAVAILABLE", `Protected file ${operation} failed.`, { phase: operation });
}

async function boundedReadUtf8(handle, dir, maxBytes) {
  const chunks = [];
  let total = 0;
  let position = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const result = await handle.read(buffer, 0, buffer.length, position);
    assertDirectoryOpen(dir);
    if (result.bytesRead === 0) break;
    chunks.push(buffer.subarray(0, result.bytesRead));
    total += result.bytesRead;
    position += result.bytesRead;
  }
  if (total > maxBytes) fail("INTEGRATION_STORAGE_FILE_CORRUPT", "Protected file exceeds its read bound.");
  const bytes = Buffer.concat(chunks, total);
  try {
    return Object.freeze({ text: UTF8_DECODER.decode(bytes), bytes: total });
  } catch {
    fail("INTEGRATION_STORAGE_FILE_CORRUPT", "Protected file is not valid UTF-8.");
  }
}

async function readRetainedProtectedFile(state, fileNameInput, optionsInput, { parseJson = false } = {}) {
  const fileName = assertSafeFileName(fileNameInput);
  const options = normalizeReadOptions(optionsInput);
  const dir = state.directory;
  const release = admitDirectoryOperation(dir, parseJson ? "readProtectedJsonFile" : "readProtectedUtf8File");
  let handle = null;
  let missing = false;
  let problem = null;
  let result = null;
  try {
    await recheckDirectoryNamedBinding(dir);
    assertDirectoryOpen(dir);
    const filePath = procFdChildPath(dir.handle, fileName);
    try {
      handle = await fs.open(filePath, OPEN_PROTECTED_READ_FLAGS);
    } catch (error) {
      if (options.optional && error?.code === "ENOENT") {
        await recheckDirectoryNamedBinding(dir);
        assertDirectoryOpen(dir);
        missing = true;
      } else {
        throw error;
      }
    }
    if (!missing) {
      assertDirectoryOpen(dir);
      const beforeStat = await handle.stat({ bigint: true });
      assertDirectoryOpen(dir);
      const beforeIdentity = assertProtectedRegularFileStat(
        beforeStat,
        dir.root,
        options.maxBytes,
        "protected file"
      );
      const beforeNamed = await fs.lstat(filePath, { bigint: true });
      assertDirectoryOpen(dir);
      assertProtectedNameBinding(beforeNamed, beforeIdentity, dir.root, options.maxBytes, "protected file");
      const read = await boundedReadUtf8(handle, dir, options.maxBytes);
      const afterStat = await handle.stat({ bigint: true });
      assertDirectoryOpen(dir);
      const afterIdentity = assertProtectedRegularFileStat(
        afterStat,
        dir.root,
        options.maxBytes,
        "protected file"
      );
      if (!sameStableProtectedFile(beforeIdentity, afterIdentity) || afterIdentity.size !== BigInt(read.bytes)) {
        fail("INTEGRATION_STORAGE_FILE_CORRUPT", "Protected file changed while it was read.");
      }
      const afterNamed = await fs.lstat(filePath, { bigint: true });
      assertDirectoryOpen(dir);
      assertProtectedNameBinding(afterNamed, afterIdentity, dir.root, options.maxBytes, "protected file", {
        stable: true,
      });
      await recheckDirectoryNamedBinding(dir);
      assertDirectoryOpen(dir);
      if (!parseJson) {
        result = read.text;
      } else {
        try {
          const parsed = JSON.parse(read.text);
          canonicalJsonTrapSafe(parsed);
          result = freezeDeep(parsed);
        } catch {
          fail("INTEGRATION_STORAGE_FILE_CORRUPT", "Protected file contains invalid JSON.");
        }
      }
    }
  } catch (error) {
    problem = error;
  }

  const cleanupFailures = [];
  await closeHandleBestEffort(handle, cleanupFailures, "protected read file handle");
  release();
  if (cleanupFailures.length > 0) {
    fail("INTEGRATION_STORAGE_CLEANUP_FAILED", "Protected read file handle cleanup failed.", {
      phase: "read-handle-close",
      failureCount: cleanupFailures.length,
    });
  }
  if (problem) throwNormalizedFileOperationError(problem, "read");
  return result;
}

async function validateExistingProtectedDestination(dir, filePath, maxBytes) {
  let handle = null;
  let problem = null;
  let result = null;
  try {
    try {
      handle = await fs.open(filePath, OPEN_PROTECTED_READ_FLAGS);
    } catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ exists: false });
      throw error;
    }
    assertDirectoryOpen(dir);
    const stat = await handle.stat({ bigint: true });
    assertDirectoryOpen(dir);
    const identity = assertProtectedRegularFileStat(stat, dir.root, maxBytes, "protected destination");
    const named = await fs.lstat(filePath, { bigint: true });
    assertDirectoryOpen(dir);
    assertProtectedNameBinding(named, identity, dir.root, maxBytes, "protected destination", { stable: true });
    result = Object.freeze({ exists: true, identity });
  } catch (error) {
    problem = error;
  }
  const cleanupFailures = [];
  await closeHandleBestEffort(handle, cleanupFailures, "protected destination validation handle");
  if (cleanupFailures.length > 0) {
    throwCleanupFailure("Protected destination validation cleanup failed.", cleanupFailures, {
      originalCode: problem?.publicCode || problem?.code || "",
    });
  }
  if (problem) throw problem;
  return result;
}

function atomicTempName() {
  return `${ATOMIC_TEMP_PREFIX}${process.pid}-${crypto.randomBytes(16).toString("hex")}`;
}

async function cleanupUncommittedTemp(dir, tempPath, tempIdentity, tempCreated) {
  const failures = [];
  if (!tempCreated) return failures;
  if (!tempPath || !tempIdentity) {
    failures.push({
      label: "protected atomic temporary ownership proof",
      error: Object.assign(new Error("Protected atomic temporary ownership could not be proven."), {
        code: "INTEGRATION_STORAGE_TEMP_UNPROVEN",
      }),
    });
    return failures;
  }
  try {
    const named = await fs.lstat(tempPath, { bigint: true });
    const namedIdentity = protectedFileIdentityFromStat(named);
    if (!sameProtectedFileObject(namedIdentity, tempIdentity)) {
      failures.push({
        label: "protected atomic temporary identity",
        error: Object.assign(new Error("Protected atomic temporary named binding changed."), {
          code: "INTEGRATION_STORAGE_TEMP_CHANGED",
        }),
      });
      return failures;
    }
    await fs.unlink(tempPath);
    await dir.handle.sync();
  } catch (error) {
    if (error?.code !== "ENOENT") failures.push({ label: "protected atomic temporary cleanup", error });
  }
  return failures;
}

async function atomicWriteRetainedProtectedFile(state, fileNameInput, textInput, optionsInput) {
  const fileName = assertSafeFileName(fileNameInput);
  if (typeof textInput !== "string") {
    fail("INTEGRATION_STORAGE_INVALID", "protected UTF-8 write value must be a primitive string.");
  }
  const options = normalizeWriteOptions(optionsInput);
  const bytes = Buffer.from(textInput, "utf8");
  if (UTF8_DECODER.decode(bytes) !== textInput) {
    fail("INTEGRATION_STORAGE_INVALID", "protected UTF-8 write value does not round-trip exactly.");
  }
  if (bytes.length > options.maxBytes) fail("INTEGRATION_STORAGE_INVALID", "protected write exceeds its byte bound.");
  let digest = "";
  let tempName = "";
  try {
    digest = crypto.createHash("sha256").update(bytes).digest("hex");
    tempName = atomicTempName();
  } catch {
    fail("INTEGRATION_STORAGE_FILE_UNAVAILABLE", "Protected atomic write initialization failed.", {
      phase: "pre-admission",
    });
  }
  const dir = state.directory;
  const finalPath = procFdChildPath(dir.handle, fileName);
  const tempPath = procFdChildPath(dir.handle, tempName);
  const release = admitDirectoryOperation(dir, "atomicWriteProtectedFile");
  let handle = null;
  let tempCreated = false;
  let tempIdentity = null;
  let renameIssued = false;
  let renamed = false;
  let directorySynced = false;
  let postRenameSyncFailed = false;
  let phase = "preflight";
  let result = null;
  let problem = null;

  try {
    await recheckDirectoryNamedBinding(dir);
    assertDirectoryOpen(dir);
    await validateExistingProtectedDestination(dir, finalPath, options.maxBytes);
    assertDirectoryOpen(dir);
    handle = await fs.open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    tempCreated = true;
    phase = "temp-created";
    const createdStat = fstatSync(handle.fd, { bigint: true });
    tempIdentity = protectedFileIdentityFromStat(createdStat);
    assertProtectedRegularFileStat(createdStat, dir.root, options.maxBytes, "protected atomic temporary");
    assertDirectoryOpen(dir);
    if (tempIdentity.size !== 0n) fail("INTEGRATION_STORAGE_FILE_CORRUPT", "Protected atomic temporary was not empty.");
    const createdNamed = await fs.lstat(tempPath, { bigint: true });
    assertDirectoryOpen(dir);
    assertProtectedNameBinding(
      createdNamed,
      tempIdentity,
      dir.root,
      options.maxBytes,
      "protected atomic temporary",
      { stable: true }
    );
    await handle.writeFile(bytes);
    phase = "temp-written";
    assertDirectoryOpen(dir);
    const writtenStat = await handle.stat({ bigint: true });
    assertDirectoryOpen(dir);
    const writtenIdentity = assertProtectedRegularFileStat(
      writtenStat,
      dir.root,
      options.maxBytes,
      "protected atomic temporary"
    );
    if (!sameProtectedFileObject(tempIdentity, writtenIdentity) || writtenIdentity.size !== BigInt(bytes.length)) {
      fail("INTEGRATION_STORAGE_FILE_CORRUPT", "Protected atomic temporary changed while it was written.");
    }
    tempIdentity = writtenIdentity;
    await handle.sync();
    phase = "temp-synced";
    assertDirectoryOpen(dir);
    const syncedStat = await handle.stat({ bigint: true });
    assertDirectoryOpen(dir);
    const syncedIdentity = assertProtectedRegularFileStat(
      syncedStat,
      dir.root,
      options.maxBytes,
      "protected atomic temporary"
    );
    if (!sameStableProtectedFile(tempIdentity, syncedIdentity)) {
      fail("INTEGRATION_STORAGE_FILE_CORRUPT", "Protected atomic temporary changed while it was synced.");
    }
    tempIdentity = syncedIdentity;
    const syncedNamed = await fs.lstat(tempPath, { bigint: true });
    assertDirectoryOpen(dir);
    assertProtectedNameBinding(
      syncedNamed,
      tempIdentity,
      dir.root,
      options.maxBytes,
      "protected atomic temporary",
      { stable: true }
    );
    await recheckDirectoryNamedBinding(dir);
    assertDirectoryOpen(dir);
    await validateExistingProtectedDestination(dir, finalPath, options.maxBytes);
    assertDirectoryOpen(dir);
    const finalTempNamed = await fs.lstat(tempPath, { bigint: true });
    assertDirectoryOpen(dir);
    assertProtectedNameBinding(
      finalTempNamed,
      tempIdentity,
      dir.root,
      options.maxBytes,
      "protected atomic temporary",
      { stable: true }
    );

    renameIssued = true;
    phase = "rename-issued";
    await fs.rename(tempPath, finalPath);
    renamed = true;
    phase = "renamed";
    const committedNamed = await fs.lstat(finalPath, { bigint: true });
    const committedNamedIdentity = assertProtectedNameBinding(
      committedNamed,
      tempIdentity,
      dir.root,
      options.maxBytes,
      "protected committed file"
    );
    const committedStat = await handle.stat({ bigint: true });
    const committedIdentity = assertProtectedRegularFileStat(
      committedStat,
      dir.root,
      options.maxBytes,
      "protected committed file"
    );
    if (
      !sameProtectedFileObject(tempIdentity, committedIdentity) ||
      committedIdentity.size !== BigInt(bytes.length) ||
      !sameStableProtectedFile(committedNamedIdentity, committedIdentity)
    ) {
      fail("INTEGRATION_STORAGE_FILE_CORRUPT", "Protected committed file identity changed.");
    }
    tempIdentity = committedIdentity;
    await dir.handle.sync();
    directorySynced = true;
    phase = "directory-synced";
    await recheckDirectoryNamedBinding(dir);
    assertDirectoryOpen(dir);
    phase = "complete";
    result = Object.freeze({
      committed: true,
      bytes: bytes.length,
      digest,
      directorySynced: true,
    });
  } catch (error) {
    problem = error;
  }

  if (renameIssued && !directorySynced && problem) {
    try {
      await dir.handle.sync();
      directorySynced = true;
    } catch {
      postRenameSyncFailed = true;
    }
  }

  const proofFailures = [];
  if (!renameIssued && tempCreated && !tempIdentity && handle) {
    try {
      const cleanupStat = fstatSync(handle.fd, { bigint: true });
      tempIdentity = protectedFileIdentityFromStat(cleanupStat);
      assertProtectedRegularFileStat(cleanupStat, dir.root, options.maxBytes, "protected atomic temporary");
    } catch (error) {
      if (!tempIdentity) proofFailures.push({ label: "protected atomic temporary ownership proof", error });
    }
  }
  const closeFailures = [];
  await closeHandleBestEffort(handle, closeFailures, "protected atomic file handle");
  let cleanupFailures = [];
  if (!renameIssued) cleanupFailures = await cleanupUncommittedTemp(dir, tempPath, tempIdentity, tempCreated);
  release();

  if (renameIssued && (problem || closeFailures.length > 0)) {
    fail("INTEGRATION_STORAGE_COMMIT_AMBIGUOUS", "Protected atomic replace outcome is ambiguous after rename was issued.", {
      phase: closeFailures.length > 0 && !problem ? "handle-close" : phase,
      bytes: bytes.length,
      digest,
      renamed,
      directorySynced,
      postRenameSyncFailed,
    });
  }
  if (proofFailures.length > 0 || closeFailures.length > 0 || cleanupFailures.length > 0) {
    fail("INTEGRATION_STORAGE_CLEANUP_FAILED", "Protected atomic temporary cleanup failed.", {
      phase: "pre-rename-cleanup",
      failureCount: proofFailures.length + closeFailures.length + cleanupFailures.length,
    });
  }
  if (problem) throwNormalizedFileOperationError(problem, "atomic replace");
  return result;
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
    return makeDirectorySurface(
      parent.root,
      handle,
      bigintIdentityFromStat(stat),
      parent.depth + 1,
      Object.freeze([...parent.relativeSegments, segment])
    );
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

function makeDirectorySurface(root, handle, identity, depth, relativeSegments) {
  const dir = {
    root,
    handle,
    identity,
    depth,
    relativeSegments,
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

function buildRetainedFileAttestation(dir, expected) {
  const unsigned = {
    schemaVersion: INTEGRATION_RETAINED_FILE_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    role: expected.role,
    canonicalPath: expected.canonicalPath,
    rootIdentityDigest: expected.rootIdentityDigest,
    relativeSegments: Object.freeze([...expected.relativeSegments]),
    relativePointer: expected.relativeSegments.length > 0 ? expected.relativeSegments.join("/") : ".",
    directoryIdentityDigest: expected.directoryIdentityDigest,
    protectedRegularFiles: true,
    atomicSameDirectoryReplace: true,
    fileSyncBeforeRename: true,
    directorySyncAfterRename: true,
    limitations: INTEGRATION_RETAINED_FILE_LIMITATIONS,
    digest: "0".repeat(64),
  };
  const { digest: _digest, ...digestInput } = unsigned;
  return validateSurface(
    freezeDeep({
      ...unsigned,
      digest: contractDigest(digestInput),
    }),
    FILE_ATTESTATION_KEYS,
    "retained file attestation"
  );
}

function assertExpectedFilePrimitivesState(state, expectedInput, label) {
  if (expectedInput === undefined) return;
  const expected = assertExpectedDirectoryState(state.directory, expectedInput, label);
  if (
    state.expected.role !== expected.role ||
    state.expected.canonicalPath !== expected.canonicalPath ||
    state.expected.rootIdentityDigest !== expected.rootIdentityDigest ||
    state.expected.directoryIdentityDigest !== expected.directoryIdentityDigest ||
    !sameSegments(state.expected.relativeSegments, expected.relativeSegments)
  ) {
    fail("INTEGRATION_STORAGE_INVALID", `${label} does not match its retained directory binding.`);
  }
}

export function createIntegrationRetainedFilePrimitives(directory, expectedInput) {
  const dir = directory && typeof directory === "object" ? directoryBrand.get(directory) : null;
  if (!dir) fail("INTEGRATION_STORAGE_INVALID", "Integration retained directory brand is invalid.");
  validateSurface(directory, DIRECTORY_SURFACE_KEYS, "directory");
  const expected = assertExpectedDirectoryState(dir, expectedInput, "Integration retained file primitives");
  assertDirectoryOpen(dir);
  if (dir.closing || dir.root.closing) {
    fail("INTEGRATION_STORAGE_CLOSED", "Integration retained directory is closing.");
  }
  const state = {
    directory: dir,
    expected,
    attestation: null,
    surface: null,
  };
  state.attestation = buildRetainedFileAttestation(dir, expected);
  const surface = Object.freeze({
    schemaVersion: INTEGRATION_RETAINED_FILE_PRIMITIVES_VERSION,
    attestation: state.attestation,
    readProtectedUtf8File(fileName, options) {
      return readRetainedProtectedFile(state, fileName, options);
    },
    readProtectedJsonFile(fileName, options) {
      return readRetainedProtectedFile(state, fileName, options, { parseJson: true });
    },
    atomicWriteProtectedUtf8File(fileName, value, options) {
      return atomicWriteRetainedProtectedFile(state, fileName, value, options);
    },
    async atomicWriteProtectedJson(fileName, value, options) {
      const canonical = `${canonicalJsonTrapSafe(value)}\n`;
      return atomicWriteRetainedProtectedFile(state, fileName, canonical, options);
    },
    isClosed() {
      return dir.closing || dir.closed || dir.root.closing || dir.root.closed;
    },
  });
  state.surface = validateSurface(surface, FILE_PRIMITIVES_SURFACE_KEYS, "retained file primitives");
  filePrimitivesBrand.set(surface, state);
  return surface;
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
    const rootDirectory = makeDirectorySurface(root, openedRoot.handle, rootIdentity, 0, Object.freeze([]));
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

export function assertIntegrationRetainedDirectory(value, expected) {
  const state = value && typeof value === "object" ? directoryBrand.get(value) : null;
  if (!state) fail("INTEGRATION_STORAGE_INVALID", "Integration retained directory brand is invalid.");
  validateSurface(value, DIRECTORY_SURFACE_KEYS, "directory");
  if (expected !== undefined) assertExpectedDirectoryState(state, expected, "Integration retained directory");
  return value;
}

export function assertIntegrationRetainedFilePrimitives(value, expected) {
  const state = value && typeof value === "object" ? filePrimitivesBrand.get(value) : null;
  if (!state) fail("INTEGRATION_STORAGE_INVALID", "Integration retained file primitives brand is invalid.");
  validateSurface(value, FILE_PRIMITIVES_SURFACE_KEYS, "retained file primitives");
  if (value.attestation !== state.attestation) {
    fail("INTEGRATION_STORAGE_CORRUPT", "Integration retained file primitives attestation changed.");
  }
  assertExpectedFilePrimitivesState(state, expected, "Integration retained file primitives");
  return value;
}

export function assertIntegrationStorageLease(value) {
  const state = value && typeof value === "object" ? leaseBrand.get(value) : null;
  if (!state) fail("INTEGRATION_STORAGE_INVALID", "Integration storage lease brand is invalid.");
  validateSurface(value, LEASE_SURFACE_KEYS, "lease");
  return value;
}
