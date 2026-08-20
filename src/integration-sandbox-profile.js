import crypto from "node:crypto";
import path from "node:path";

// These primitives consume AgInTi-internal preflight facts. Runtime and workspace
// attestations must never be accepted from a browser, model, or integration API body.

export const PUBLIC_INTEGRATION_SANDBOX_PROFILE_ID = "aginti-public-rootless-netless-v1";
export const PUBLIC_INTEGRATION_RUNTIME_ATTESTATION_SCHEMA =
  "aginti.public-integration.rootless-runtime-attestation/v1";
export const PUBLIC_INTEGRATION_WORKSPACE_ATTESTATION_SCHEMA =
  "aginti.public-integration.workspace-attestation/v1";
export const PUBLIC_INTEGRATION_INVOCATION_SCHEMA = "aginti.public-integration.sandbox-invocation/v1";
export const PUBLIC_INTEGRATION_EXECUTOR_PREFLIGHT_SCHEMA =
  "aginti.public-integration.executor-preflight/v1";
export const PUBLIC_INTEGRATION_SANDBOX_CAPABILITY_ENABLED = false;
export const PUBLIC_INTEGRATION_FACT_MAX_TTL_MS = 30_000;
export const PUBLIC_INTEGRATION_RESTAT_MAX_AGE_MS = 1_000;

export const PUBLIC_INTEGRATION_CONTAINER_USER = Object.freeze({ uid: 65532, gid: 65532 });

export const PUBLIC_INTEGRATION_DEFAULT_LIMITS = Object.freeze({
  cpuMillis: 1500,
  memoryBytes: 1536 * 1024 * 1024,
  pids: 128,
  fileDescriptors: 256,
  wallTimeMs: 3 * 60 * 1000,
  stdoutBytes: 1024 * 1024,
  stderrBytes: 1024 * 1024,
  workspaceBytes: 512 * 1024 * 1024,
  workspaceFiles: 20000,
  tmpfsBytes: 128 * 1024 * 1024,
  homeTmpfsBytes: 32 * 1024 * 1024,
  runTmpfsBytes: 16 * 1024 * 1024,
});

export const PUBLIC_INTEGRATION_LIMIT_CEILINGS = Object.freeze({
  cpuMillis: 4000,
  memoryBytes: 4 * 1024 * 1024 * 1024,
  pids: 256,
  fileDescriptors: 512,
  wallTimeMs: 15 * 60 * 1000,
  stdoutBytes: 4 * 1024 * 1024,
  stderrBytes: 4 * 1024 * 1024,
  workspaceBytes: 2 * 1024 * 1024 * 1024,
  workspaceFiles: 100000,
  tmpfsBytes: 512 * 1024 * 1024,
  homeTmpfsBytes: 64 * 1024 * 1024,
  runTmpfsBytes: 32 * 1024 * 1024,
});

const LIMIT_FLOORS = Object.freeze({
  cpuMillis: 100,
  memoryBytes: 128 * 1024 * 1024,
  pids: 16,
  fileDescriptors: 32,
  wallTimeMs: 1000,
  stdoutBytes: 1024,
  stderrBytes: 1024,
  workspaceBytes: 1024 * 1024,
  workspaceFiles: 100,
  tmpfsBytes: 8 * 1024 * 1024,
  homeTmpfsBytes: 4 * 1024 * 1024,
  runTmpfsBytes: 1024 * 1024,
});

const INPUT_KEYS = Object.freeze([
  "runtime",
  "workspace",
  "image",
  "runId",
  "threadId",
  "leaseId",
  "command",
  "limits",
]);
const RUNTIME_KEYS = Object.freeze([
  "schema",
  "attestationId",
  "capturedAt",
  "expiresAt",
  "bootId",
  "subject",
  "engine",
  "executable",
  "executableIdentity",
  "executableDigest",
  "executableVerified",
  "executableSymlinkFree",
  "executableWritableByUntrusted",
  "available",
  "rootless",
  "remote",
  "effectiveUid",
  "engineUid",
  "controlEndpoint",
  "capabilities",
  "security",
  "supervisor",
  "image",
]);
const RUNTIME_SUBJECT_KEYS = Object.freeze(["runId", "threadId", "leaseId"]);
const CONTROL_ENDPOINT_KEYS = Object.freeze(["kind", "path", "identity", "ownerUid", "ownerOnly", "symlinkFree"]);
const RUNTIME_CAPABILITY_KEYS = Object.freeze([
  "readOnlyRootfs",
  "capDropAll",
  "noNewPrivileges",
  "seccomp",
  "apparmor",
  "networkNone",
  "nonRootUser",
  "tmpfs",
  "memoryLimit",
  "memorySwapLimit",
  "cpuLimit",
  "pidsLimit",
  "ulimit",
  "labels",
  "cidfile",
  "immutableContainerId",
  "labelVerifiedLifecycle",
  "pullNever",
  "privateNamespaces",
  "cgroupNamespacePrivate",
  "ipcNone",
  "bindPropagationPrivate",
  "noImplicitHostMounts",
  "hostDevicesDisabled",
  "hostSocketForwardingDisabled",
  "logDriverNone",
  "init",
  "stopTimeout",
]);
const SECURITY_KEYS = Object.freeze(["seccomp", "apparmor"]);
const SECCOMP_KEYS = Object.freeze([
  "available",
  "enforced",
  "profilePath",
  "identity",
  "profileDigest",
  "profileVerified",
  "profileImmutable",
  "symlinkFree",
  "writableByUntrusted",
]);
const APPARMOR_KEYS = Object.freeze(["available", "enforced", "profileName", "profileLoaded"]);
const SUPERVISOR_KEYS = Object.freeze([
  "wallTimeoutEnforced",
  "stdoutLimitEnforced",
  "stderrLimitEnforced",
  "outputBytesCountedBeforeDecode",
  "workspaceQuotaEnforced",
  "abortKillsExactContainer",
  "reconcileByLabels",
  "killEscalation",
]);
const IMAGE_ATTESTATION_KEYS = Object.freeze([
  "reference",
  "digestVerified",
  "approved",
  "pullDisabled",
  "credentialsAbsent",
  "environmentAllowlisted",
  "volumesAbsent",
]);
const WORKSPACE_KEYS = Object.freeze([
  "schema",
  "capturedAt",
  "expiresAt",
  "bootId",
  "root",
  "path",
  "realRoot",
  "realPath",
  "rootIdentity",
  "pathIdentity",
  "filesystem",
  "threadId",
  "runId",
  "leaseId",
  "exists",
  "directory",
  "dedicated",
  "exclusiveLease",
  "noSymlinkComponents",
  "noNestedMounts",
  "noSpecialFiles",
  "noCredentialFiles",
  "mountPropagationPrivate",
  "ownerOnly",
  "writableByContainerUser",
  "containerUid",
  "containerGid",
  "hostOwnerUid",
  "hostOwnerGid",
  "uidMap",
  "quota",
]);
const WORKSPACE_QUOTA_KEYS = Object.freeze([
  "method",
  "id",
  "filesystem",
  "limitBytes",
  "usedBytes",
  "inodeLimit",
  "usedInodes",
  "supportsBytes",
  "supportsInodes",
  "enforced",
  "hard",
  "noSharedPool",
]);
const FACT_IDENTITY_KEYS = Object.freeze(["dev", "ino", "ctimeMs", "nlink", "uid", "gid", "mode", "digest"]);
const FILESYSTEM_BINDING_KEYS = Object.freeze([
  "mountId",
  "fsType",
  "device",
  "root",
  "dev",
  "ino",
  "ctimeMs",
  "nlink",
  "uid",
  "gid",
  "mode",
  "digest",
]);
const UID_MAP_KEYS = Object.freeze(["containerUid", "containerGid", "hostUid", "hostGid", "size", "proven"]);
const INVOCATION_KEYS = Object.freeze([
  "schema",
  "profileId",
  "executable",
  "args",
  "spawn",
  "container",
  "limits",
  "supervisor",
  "lifecycle",
  "executorPreflight",
  "capability",
  "attestation",
]);

const REQUIRED_TRUE_RUNTIME_CAPABILITIES = new Set(RUNTIME_CAPABILITY_KEYS);
const REQUIRED_TRUE_SUPERVISOR_ASSERTIONS = new Set(SUPERVISOR_KEYS);
const HARD_QUOTA_METHODS = new Set(["xfs-project", "ext4-project"]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SAFE_PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IMAGE_DIGEST_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,220}@sha256:[a-f0-9]{64}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BOOT_ID_PATTERN = /^[a-f0-9][a-f0-9-]{15,63}$/;
const FORBIDDEN_WORKSPACE_ROOTS = Object.freeze([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/tmp",
  "/usr",
  "/var/lib/containers",
  "/var/lib/containerd",
  "/var/lib/docker",
  "/var/lib/kubelet",
  "/var/log",
  "/var/run",
  "/var/spool",
  "/var/tmp",
  "/Volumes",
]);
const TOO_BROAD_WORKSPACE_ROOTS = new Set(["/opt", "/srv", "/var", "/var/lib"]);

const CONTAINER_ENVIRONMENT = Object.freeze([
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "HOME=/home/agent",
  "XDG_CONFIG_HOME=/home/agent/.config",
  "XDG_CACHE_HOME=/tmp/cache",
  "XDG_STATE_HOME=/home/agent/.local/state",
  "TMPDIR=/tmp",
  "HISTFILE=/dev/null",
  "LESSHISTFILE=-",
  "PYTHONHISTFILE=/dev/null",
  "NPM_CONFIG_CACHE=/tmp/npm-cache",
  "PIP_CACHE_DIR=/tmp/pip-cache",
  "UV_CACHE_DIR=/tmp/uv-cache",
  "CARGO_HOME=/home/agent/.cargo",
  "SSH_AUTH_SOCK=",
  "DOCKER_HOST=",
  "DOCKER_CONTEXT=",
  "CONTAINER_HOST=",
  "PODMAN_SYSTEM_CONNECTION=",
  "CONTAINERS_CONF=",
  "CONTAINERS_STORAGE_CONF=",
  "REGISTRY_AUTH_FILE=",
  "HTTP_PROXY=",
  "HTTPS_PROXY=",
  "ALL_PROXY=",
  "NO_PROXY=*",
  "http_proxy=",
  "https_proxy=",
  "all_proxy=",
  "no_proxy=*",
]);

export class PublicIntegrationSandboxError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PublicIntegrationSandboxError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, pathName, value) {
  const details = pathName ? { path: pathName } : {};
  if (value !== undefined) details.value = value;
  throw new PublicIntegrationSandboxError(code, message, details);
}

const ArrayIsArray = Array.isArray;
const ArrayPrototype = Array.prototype;
const NumberIsFinite = Number.isFinite;
const ObjectCreate = Object.create;
const ObjectFreeze = Object.freeze;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectKeys = Object.keys;
const ObjectPrototype = Object.prototype;
const ObjectPrototypeHasOwn = Object.prototype.hasOwnProperty;
const ReflectOwnKeys = Reflect.ownKeys;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || ArrayIsArray(value)) return false;
  return ObjectGetPrototypeOf(value) === ObjectPrototype;
}

function assertPlainObject(value, pathName) {
  if (!isPlainObject(value)) fail("sandbox_profile_invalid", `${pathName} must be a plain object.`, pathName);
  const enumerableKeys = ObjectKeys(value);
  const ownKeys = ReflectOwnKeys(value);
  if (ownKeys.length !== enumerableKeys.length || ownKeys.some((key) => typeof key !== "string")) {
    fail("sandbox_profile_unknown_field", `${pathName} contains unsupported hidden or symbolic fields.`, pathName);
  }
  for (const key of enumerableKeys) {
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !ObjectPrototypeHasOwn.call(descriptor, "value")) {
      fail("sandbox_profile_invalid", `${pathName}.${key} must be a canonical data field.`, `${pathName}.${key}`);
    }
  }
}

function assertOnlyKeys(value, allowedKeys, pathName) {
  assertPlainObject(value, pathName);
  const allowed = new Set(allowedKeys);
  const unknown = ObjectKeys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(
      "sandbox_profile_unknown_field",
      `${pathName} contains unsupported field ${unknown[0]}.`,
      `${pathName}.${unknown[0]}`
    );
  }
}

function assertDenseArray(value, pathName, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!ArrayIsArray(value) || ObjectGetPrototypeOf(value) !== ArrayPrototype || value.length < minimum || value.length > maximum) {
    fail("sandbox_profile_invalid", `${pathName} must be a dense array with ${minimum}-${maximum} entries.`, pathName);
  }
  const ownKeys = ReflectOwnKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      fail("sandbox_profile_unknown_field", `${pathName} contains unsupported symbolic fields.`, pathName);
    }
    if (key === "length") continue;
    if (!ARRAY_INDEX_PATTERN.test(key) || Number(key) >= value.length) {
      fail("sandbox_profile_unknown_field", `${pathName} contains unsupported field ${key}.`, `${pathName}.${key}`);
    }
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !ObjectPrototypeHasOwn.call(descriptor, "value")) {
      fail("sandbox_profile_invalid", `${pathName}.${key} must be a canonical data field.`, `${pathName}.${key}`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!ObjectPrototypeHasOwn.call(value, String(index))) {
      fail("sandbox_profile_invalid", `${pathName} must not contain sparse entries.`, `${pathName}.${index}`);
    }
  }
}

function canonicalData(value, pathName = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!NumberIsFinite(value)) fail("sandbox_profile_invalid", `${pathName} must be a finite number.`, pathName);
    return value;
  }
  if (ArrayIsArray(value)) {
    assertDenseArray(value, pathName);
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      copy.push(canonicalData(ObjectGetOwnPropertyDescriptor(value, String(index)).value, `${pathName}.${index}`));
    }
    return copy;
  }
  if (value && typeof value === "object") {
    assertPlainObject(value, pathName);
    const copy = ObjectCreate(null);
    for (const key of ObjectKeys(value).sort()) {
      copy[key] = canonicalData(ObjectGetOwnPropertyDescriptor(value, key).value, `${pathName}.${key}`);
    }
    return copy;
  }
  fail("sandbox_profile_invalid", `${pathName} must be canonical JSON-compatible data.`, pathName);
}

function canonicalSerialize(value, pathName = "value") {
  const data = canonicalData(value, pathName);
  function serialize(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number") {
      return JSON.stringify(item);
    }
    if (ArrayIsArray(item)) {
      const parts = [];
      for (let index = 0; index < item.length; index += 1) parts.push(serialize(item[index]));
      return `[${parts.join(",")}]`;
    }
    const keys = ObjectKeys(item).sort();
    const parts = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      parts.push(`${JSON.stringify(key)}:${serialize(item[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return serialize(data);
}

function canonicalDigest(value, pathName = "value") {
  return `sha256:${sha256(canonicalSerialize(value, pathName))}`;
}

function assertExactTrue(value, pathName) {
  if (value !== true) fail("sandbox_attestation_missing", `${pathName} must be explicitly attested true.`, pathName);
}

function assertExactFalse(value, pathName) {
  if (value !== false) fail("sandbox_attestation_missing", `${pathName} must be explicitly attested false.`, pathName);
}

function assertSafeId(value, pathName) {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    fail("sandbox_profile_invalid", `${pathName} must be a bounded opaque identifier.`, pathName);
  }
  return value;
}

function assertInteger(value, pathName, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("sandbox_profile_invalid", `${pathName} is outside the permitted integer range.`, pathName);
  }
  return value;
}

function assertDigest(value, pathName) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail("sandbox_profile_invalid", `${pathName} must be an immutable SHA-256 digest.`, pathName);
  }
  return value;
}

function assertBootId(value, pathName) {
  if (typeof value !== "string" || !BOOT_ID_PATTERN.test(value)) {
    fail("sandbox_profile_invalid", `${pathName} must be an attested boot identifier.`, pathName);
  }
  return value;
}

function parseFactTime(value, pathName) {
  if (typeof value !== "string") fail("sandbox_profile_invalid", `${pathName} must be an ISO timestamp.`, pathName);
  const milliseconds = Date.parse(value);
  if (!NumberIsFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("sandbox_profile_invalid", `${pathName} must be a canonical ISO timestamp.`, pathName);
  }
  return milliseconds;
}

function assertFreshFactWindow(container, pathName) {
  const capturedAt = parseFactTime(container.capturedAt, `${pathName}.capturedAt`);
  const expiresAt = parseFactTime(container.expiresAt, `${pathName}.expiresAt`);
  if (expiresAt <= capturedAt || expiresAt - capturedAt > PUBLIC_INTEGRATION_FACT_MAX_TTL_MS) {
    fail("sandbox_fact_stale", `${pathName} facts must expire within the short public integration TTL.`, `${pathName}.expiresAt`);
  }
  return { capturedAt, expiresAt };
}

function assertFactIdentity(value, pathName, { uid, gid, nlink, modeNotWritableByUntrusted = true } = {}) {
  assertOnlyKeys(value, FACT_IDENTITY_KEYS, pathName);
  const identity = {
    dev: assertInteger(value.dev, `${pathName}.dev`, 0),
    ino: assertInteger(value.ino, `${pathName}.ino`, 1),
    ctimeMs: assertInteger(value.ctimeMs, `${pathName}.ctimeMs`, 0),
    nlink: assertInteger(value.nlink, `${pathName}.nlink`, 1, 1_000_000),
    uid: assertInteger(value.uid, `${pathName}.uid`, 0, 2 ** 31 - 1),
    gid: assertInteger(value.gid, `${pathName}.gid`, 0, 2 ** 31 - 1),
    mode: assertInteger(value.mode, `${pathName}.mode`, 0, 0o7777),
    digest: assertDigest(value.digest, `${pathName}.digest`),
  };
  if (uid !== undefined && identity.uid !== uid) {
    fail("sandbox_fact_identity_mismatch", `${pathName} uid does not match the attested owner.`, `${pathName}.uid`);
  }
  if (gid !== undefined && identity.gid !== gid) {
    fail("sandbox_fact_identity_mismatch", `${pathName} gid does not match the attested group.`, `${pathName}.gid`);
  }
  if (nlink !== undefined && identity.nlink !== nlink) {
    fail("sandbox_fact_identity_mismatch", `${pathName} link count is not the attested single identity.`, `${pathName}.nlink`);
  }
  if (modeNotWritableByUntrusted && (identity.mode & 0o022) !== 0) {
    fail("sandbox_fact_identity_mismatch", `${pathName} is writable by group/world.`, `${pathName}.mode`);
  }
  return Object.freeze(identity);
}

function assertFilesystemBinding(value, pathName) {
  assertOnlyKeys(value, FILESYSTEM_BINDING_KEYS, pathName);
  const binding = {
    mountId: assertSafeId(value.mountId, `${pathName}.mountId`),
    fsType: assertSafeId(value.fsType, `${pathName}.fsType`),
    device: assertSafeId(value.device, `${pathName}.device`),
    root: assertAbsoluteSafePath(value.root, `${pathName}.root`),
    dev: assertInteger(value.dev, `${pathName}.dev`, 0),
    ino: assertInteger(value.ino, `${pathName}.ino`, 1),
    ctimeMs: assertInteger(value.ctimeMs, `${pathName}.ctimeMs`, 0),
    nlink: assertInteger(value.nlink, `${pathName}.nlink`, 1, 1_000_000),
    uid: assertInteger(value.uid, `${pathName}.uid`, 0, 2 ** 31 - 1),
    gid: assertInteger(value.gid, `${pathName}.gid`, 0, 2 ** 31 - 1),
    mode: assertInteger(value.mode, `${pathName}.mode`, 0, 0o7777),
    digest: assertDigest(value.digest, `${pathName}.digest`),
  };
  return Object.freeze(binding);
}

function assertAbsoluteSafePath(value, pathName) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    /[\0\r\n,]/.test(value)
  ) {
    fail("sandbox_profile_invalid", `${pathName} must be a canonical absolute path without mount delimiters.`, pathName);
  }
  return value;
}

function isInsideOrEqual(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function assertDedicatedWorkspaceRoot(value, pathName) {
  const canonical = assertAbsoluteSafePath(value, pathName);
  for (const forbidden of FORBIDDEN_WORKSPACE_ROOTS) {
    if (isInsideOrEqual(canonical, forbidden)) {
      fail("sandbox_workspace_forbidden", `${pathName} is a host or common-data root and cannot be mounted.`, pathName);
    }
  }
  const segments = canonical.split(path.sep).filter(Boolean);
  if (segments.length < 2 || TOO_BROAD_WORKSPACE_ROOTS.has(canonical)) {
    fail("sandbox_workspace_forbidden", `${pathName} is too broad for a per-thread workspace root.`, pathName);
  }
  return canonical;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  ObjectFreeze(value);
  for (const key of ReflectOwnKeys(value)) {
    if (key === "length") continue;
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (descriptor && ObjectPrototypeHasOwn.call(descriptor, "value")) deepFreeze(descriptor.value);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function resolveLimits(candidate) {
  if (candidate === undefined) return { ...PUBLIC_INTEGRATION_DEFAULT_LIMITS };
  assertOnlyKeys(candidate, ObjectKeys(PUBLIC_INTEGRATION_DEFAULT_LIMITS), "limits");
  const resolved = {};
  for (const key of ObjectKeys(PUBLIC_INTEGRATION_DEFAULT_LIMITS)) {
    const value = candidate[key] ?? PUBLIC_INTEGRATION_DEFAULT_LIMITS[key];
    resolved[key] = assertInteger(value, `limits.${key}`, LIMIT_FLOORS[key], PUBLIC_INTEGRATION_LIMIT_CEILINGS[key]);
  }
  const aggregateTmpfs = resolved.tmpfsBytes + resolved.homeTmpfsBytes + resolved.runTmpfsBytes;
  if (aggregateTmpfs > Math.floor(resolved.memoryBytes / 2)) {
    fail(
      "sandbox_profile_invalid",
      "Private tmpfs ceilings must not exceed half of the container memory limit.",
      "limits.tmpfsBytes"
    );
  }
  return resolved;
}

function validateContainerCommand(command) {
  assertDenseArray(command, "command", { minimum: 1, maximum: 64 });
  let bytes = 0;
  const checked = [];
  for (let index = 0; index < command.length; index += 1) {
    const entry = ObjectGetOwnPropertyDescriptor(command, String(index)).value;
    if (typeof entry !== "string" || entry.length === 0 || /[\0\r]/.test(entry)) {
      fail("sandbox_profile_invalid", `command[${index}] must be a non-empty string without NUL or CR.`, `command.${index}`);
    }
    bytes += Buffer.byteLength(entry, "utf8");
    if (Buffer.byteLength(entry, "utf8") > 16 * 1024) {
      fail("sandbox_profile_invalid", `command[${index}] is too large.`, `command.${index}`);
    }
    checked.push(entry);
  }
  if (bytes > 32 * 1024) fail("sandbox_profile_invalid", "command exceeds the argv byte budget.", "command");
  if (!checked[0].startsWith("/") || checked[0].includes("..") || checked[0].includes("\n")) {
    fail("sandbox_profile_invalid", "command[0] must be an absolute executable inside the approved image.", "command.0");
  }
  return checked;
}

function validateImageReference(image) {
  if (typeof image !== "string" || !IMAGE_DIGEST_PATTERN.test(image)) {
    fail(
      "sandbox_image_not_immutable",
      "image must be a normalized repository reference pinned by @sha256:<64 lowercase hex>.",
      "image"
    );
  }
  return image;
}

function attestControlEndpoint(endpoint, runtime) {
  assertOnlyKeys(endpoint, CONTROL_ENDPOINT_KEYS, "runtime.controlEndpoint");
  if (endpoint.kind !== "local-unix") {
    fail(
      "sandbox_runtime_not_rootless",
      "The public integration profile only accepts a local rootless Podman Unix endpoint.",
      "runtime.controlEndpoint.kind"
    );
  }
  assertInteger(endpoint.ownerUid, "runtime.controlEndpoint.ownerUid", 1, 2 ** 31 - 1);
  if (endpoint.ownerUid !== runtime.effectiveUid) {
    fail("sandbox_runtime_not_rootless", "The runtime endpoint is not owned by the effective rootless user.", "runtime.controlEndpoint.ownerUid");
  }
  assertExactTrue(endpoint.ownerOnly, "runtime.controlEndpoint.ownerOnly");
  assertExactTrue(endpoint.symlinkFree, "runtime.controlEndpoint.symlinkFree");

  const endpointPath = assertAbsoluteSafePath(endpoint.path, "runtime.controlEndpoint.path");
  const requiredPrefix = `/run/user/${runtime.effectiveUid}`;
  if (!isInsideOrEqual(endpointPath, requiredPrefix) || endpointPath === requiredPrefix) {
    fail(
      "sandbox_runtime_not_rootless",
      "The runtime socket must be beneath the effective user's private /run/user directory.",
      "runtime.controlEndpoint.path"
    );
  }
  if (!endpointPath.endsWith("/podman/podman.sock")) {
    fail(
      "sandbox_runtime_not_rootless",
      "The runtime socket must be the exact rootless Podman service endpoint.",
      "runtime.controlEndpoint.path"
    );
  }
  return Object.freeze({
    kind: endpoint.kind,
    path: endpointPath,
    identity: assertFactIdentity(endpoint.identity, "runtime.controlEndpoint.identity", {
      uid: runtime.effectiveUid,
      nlink: 1,
      modeNotWritableByUntrusted: true,
    }),
    ownerUid: endpoint.ownerUid,
    ownerOnly: true,
    symlinkFree: true,
  });
}

function attestSecurity(security) {
  assertOnlyKeys(security, SECURITY_KEYS, "runtime.security");
  assertOnlyKeys(security.seccomp, SECCOMP_KEYS, "runtime.security.seccomp");
  assertExactTrue(security.seccomp.available, "runtime.security.seccomp.available");
  assertExactTrue(security.seccomp.enforced, "runtime.security.seccomp.enforced");
  assertExactTrue(security.seccomp.profileVerified, "runtime.security.seccomp.profileVerified");
  assertExactTrue(security.seccomp.profileImmutable, "runtime.security.seccomp.profileImmutable");
  assertExactTrue(security.seccomp.symlinkFree, "runtime.security.seccomp.symlinkFree");
  assertExactFalse(security.seccomp.writableByUntrusted, "runtime.security.seccomp.writableByUntrusted");
  const seccompPath = assertAbsoluteSafePath(security.seccomp.profilePath, "runtime.security.seccomp.profilePath");
  if (
    isInsideOrEqual(seccompPath, "/home") ||
    isInsideOrEqual(seccompPath, "/root") ||
    isInsideOrEqual(seccompPath, "/tmp") ||
    isInsideOrEqual(seccompPath, "/run")
  ) {
    fail(
      "sandbox_security_profile_untrusted",
      "The seccomp profile must come from an immutable administrator-controlled path.",
      "runtime.security.seccomp.profilePath"
    );
  }
  const seccompIdentity = assertFactIdentity(security.seccomp.identity, "runtime.security.seccomp.identity", {
    uid: 0,
    nlink: 1,
    modeNotWritableByUntrusted: true,
  });
  const seccompDigest = assertDigest(security.seccomp.profileDigest, "runtime.security.seccomp.profileDigest");
  if (seccompIdentity.digest !== seccompDigest) {
    fail("sandbox_fact_identity_mismatch", "Seccomp profile digest does not match its captured identity.", "runtime.security.seccomp.identity.digest");
  }

  assertOnlyKeys(security.apparmor, APPARMOR_KEYS, "runtime.security.apparmor");
  assertExactTrue(security.apparmor.available, "runtime.security.apparmor.available");
  assertExactTrue(security.apparmor.enforced, "runtime.security.apparmor.enforced");
  assertExactTrue(security.apparmor.profileLoaded, "runtime.security.apparmor.profileLoaded");
  if (typeof security.apparmor.profileName !== "string" || !SAFE_PROFILE_NAME_PATTERN.test(security.apparmor.profileName)) {
    fail(
      "sandbox_security_profile_untrusted",
      "The AppArmor profile name is missing or unsafe.",
      "runtime.security.apparmor.profileName"
    );
  }
  return Object.freeze({
    seccomp: Object.freeze({
      ...security.seccomp,
      profilePath: seccompPath,
      identity: seccompIdentity,
      profileDigest: seccompDigest,
    }),
    apparmor: Object.freeze({ ...security.apparmor }),
  });
}

function attestRuntime(runtime, image, identifiers) {
  assertOnlyKeys(runtime, RUNTIME_KEYS, "runtime");
  if (runtime.schema !== PUBLIC_INTEGRATION_RUNTIME_ATTESTATION_SCHEMA) {
    fail("sandbox_attestation_missing", "Unsupported rootless runtime attestation schema.", "runtime.schema");
  }
  assertSafeId(runtime.attestationId, "runtime.attestationId");
  assertFreshFactWindow(runtime, "runtime");
  const bootId = assertBootId(runtime.bootId, "runtime.bootId");
  assertOnlyKeys(runtime.subject, RUNTIME_SUBJECT_KEYS, "runtime.subject");
  for (const key of RUNTIME_SUBJECT_KEYS) {
    if (runtime.subject[key] !== identifiers[key]) {
      fail(
        "sandbox_attestation_subject_mismatch",
        `The runtime attestation is not bound to this ${key}.`,
        `runtime.subject.${key}`
      );
    }
  }
  if (runtime.engine !== "podman") {
    fail(
      "sandbox_runtime_unavailable",
      "Public integration v1 supports only rootless Podman until portable Docker UID mapping can be proven.",
      "runtime.engine"
    );
  }
  const executable = assertAbsoluteSafePath(runtime.executable, "runtime.executable");
  if (path.basename(executable) !== runtime.engine) {
    fail("sandbox_runtime_unavailable", "The runtime executable does not match the attested engine.", "runtime.executable");
  }
  const executableIdentity = assertFactIdentity(runtime.executableIdentity, "runtime.executableIdentity", {
    uid: 0,
    nlink: 1,
    modeNotWritableByUntrusted: true,
  });
  const executableDigest = assertDigest(runtime.executableDigest, "runtime.executableDigest");
  if (executableIdentity.digest !== executableDigest) {
    fail("sandbox_fact_identity_mismatch", "Runtime executable digest does not match its captured identity.", "runtime.executableIdentity.digest");
  }
  assertExactTrue(runtime.executableVerified, "runtime.executableVerified");
  assertExactTrue(runtime.executableSymlinkFree, "runtime.executableSymlinkFree");
  assertExactFalse(runtime.executableWritableByUntrusted, "runtime.executableWritableByUntrusted");
  assertExactTrue(runtime.available, "runtime.available");
  assertExactTrue(runtime.rootless, "runtime.rootless");
  assertExactFalse(runtime.remote, "runtime.remote");
  assertInteger(runtime.effectiveUid, "runtime.effectiveUid", 1, 2 ** 31 - 1);
  assertInteger(runtime.engineUid, "runtime.engineUid", 1, 2 ** 31 - 1);
  if (runtime.engineUid !== runtime.effectiveUid) {
    fail("sandbox_runtime_not_rootless", "The container engine is not owned by the effective non-root user.", "runtime.engineUid");
  }
  const controlEndpoint = attestControlEndpoint(runtime.controlEndpoint, runtime);

  assertOnlyKeys(runtime.capabilities, RUNTIME_CAPABILITY_KEYS, "runtime.capabilities");
  for (const key of REQUIRED_TRUE_RUNTIME_CAPABILITIES) {
    assertExactTrue(runtime.capabilities[key], `runtime.capabilities.${key}`);
  }
  const security = attestSecurity(runtime.security);

  assertOnlyKeys(runtime.supervisor, SUPERVISOR_KEYS, "runtime.supervisor");
  for (const key of REQUIRED_TRUE_SUPERVISOR_ASSERTIONS) {
    assertExactTrue(runtime.supervisor[key], `runtime.supervisor.${key}`);
  }

  assertOnlyKeys(runtime.image, IMAGE_ATTESTATION_KEYS, "runtime.image");
  if (runtime.image.reference !== image) {
    fail("sandbox_image_not_immutable", "The runtime image attestation does not match the requested digest.", "runtime.image.reference");
  }
  for (const key of [
    "digestVerified",
    "approved",
    "pullDisabled",
    "credentialsAbsent",
    "environmentAllowlisted",
    "volumesAbsent",
  ]) {
    assertExactTrue(runtime.image[key], `runtime.image.${key}`);
  }

  return deepFreeze({
    schema: runtime.schema,
    attestationId: runtime.attestationId,
    capturedAt: runtime.capturedAt,
    expiresAt: runtime.expiresAt,
    bootId,
    subject: {
      runId: runtime.subject.runId,
      threadId: runtime.subject.threadId,
      leaseId: runtime.subject.leaseId,
    },
    engine: runtime.engine,
    executable,
    executableIdentity,
    executableDigest,
    executableVerified: true,
    executableSymlinkFree: true,
    executableWritableByUntrusted: false,
    available: true,
    rootless: true,
    remote: false,
    effectiveUid: runtime.effectiveUid,
    engineUid: runtime.engineUid,
    controlEndpoint,
    capabilities: canonicalData(runtime.capabilities, "runtime.capabilities"),
    security,
    supervisor: canonicalData(runtime.supervisor, "runtime.supervisor"),
    image: canonicalData(runtime.image, "runtime.image"),
  });
}

function attestUidMap(value, pathName) {
  assertOnlyKeys(value, UID_MAP_KEYS, pathName);
  const mapping = {
    containerUid: assertInteger(value.containerUid, `${pathName}.containerUid`, 1, 2 ** 31 - 1),
    containerGid: assertInteger(value.containerGid, `${pathName}.containerGid`, 1, 2 ** 31 - 1),
    hostUid: assertInteger(value.hostUid, `${pathName}.hostUid`, 1, 2 ** 31 - 1),
    hostGid: assertInteger(value.hostGid, `${pathName}.hostGid`, 1, 2 ** 31 - 1),
    size: assertInteger(value.size, `${pathName}.size`, 1, 2 ** 31 - 1),
    proven: value.proven,
  };
  assertExactTrue(mapping.proven, `${pathName}.proven`);
  if (
    mapping.containerUid !== PUBLIC_INTEGRATION_CONTAINER_USER.uid ||
    mapping.containerGid !== PUBLIC_INTEGRATION_CONTAINER_USER.gid
  ) {
    fail("sandbox_uid_mapping_unproven", "The fixed container user is not covered by the proven rootless UID map.", pathName);
  }
  return Object.freeze(mapping);
}

function attestWorkspace(workspace, identifiers, limits, runtime) {
  assertOnlyKeys(workspace, WORKSPACE_KEYS, "workspace");
  if (workspace.schema !== PUBLIC_INTEGRATION_WORKSPACE_ATTESTATION_SCHEMA) {
    fail("sandbox_attestation_missing", "Unsupported workspace attestation schema.", "workspace.schema");
  }
  assertFreshFactWindow(workspace, "workspace");
  const bootId = assertBootId(workspace.bootId, "workspace.bootId");
  if (bootId !== runtime.bootId) {
    fail("sandbox_fact_identity_mismatch", "Workspace facts were captured from a different boot.", "workspace.bootId");
  }
  const workspaceRoot = assertDedicatedWorkspaceRoot(workspace.root, "workspace.root");
  const workspacePath = assertAbsoluteSafePath(workspace.path, "workspace.path");
  if (!isInsideOrEqual(workspacePath, workspaceRoot) || workspacePath === workspaceRoot) {
    fail("sandbox_workspace_forbidden", "The workspace must be a dedicated child of its attested root.", "workspace.path");
  }
  if (workspace.realRoot !== workspaceRoot || workspace.realPath !== workspacePath) {
    fail("sandbox_workspace_forbidden", "Workspace real paths do not match their canonical paths.", "workspace.realPath");
  }
  if (
    workspace.runId !== identifiers.runId ||
    workspace.threadId !== identifiers.threadId ||
    workspace.leaseId !== identifiers.leaseId
  ) {
    fail("sandbox_workspace_forbidden", "The workspace lease does not belong to this thread and run.", "workspace.threadId");
  }
  for (const key of [
    "exists",
    "directory",
    "dedicated",
    "exclusiveLease",
    "noSymlinkComponents",
    "noNestedMounts",
    "noSpecialFiles",
    "noCredentialFiles",
    "mountPropagationPrivate",
    "ownerOnly",
    "writableByContainerUser",
  ]) {
    assertExactTrue(workspace[key], `workspace.${key}`);
  }
  if (
    workspace.containerUid !== PUBLIC_INTEGRATION_CONTAINER_USER.uid ||
    workspace.containerGid !== PUBLIC_INTEGRATION_CONTAINER_USER.gid
  ) {
    fail("sandbox_workspace_forbidden", "The workspace is not provisioned for the fixed non-root container user.", "workspace.containerUid");
  }
  assertInteger(workspace.hostOwnerUid, "workspace.hostOwnerUid", 1, 2 ** 31 - 1);
  assertInteger(workspace.hostOwnerGid, "workspace.hostOwnerGid", 1, 2 ** 31 - 1);
  const uidMap = attestUidMap(workspace.uidMap, "workspace.uidMap");
  if (uidMap.hostUid !== workspace.hostOwnerUid || uidMap.hostGid !== workspace.hostOwnerGid) {
    fail("sandbox_uid_mapping_unproven", "Workspace ownership is not bound to the proven container UID map.", "workspace.uidMap");
  }
  const rootIdentity = assertFactIdentity(workspace.rootIdentity, "workspace.rootIdentity", {
    modeNotWritableByUntrusted: true,
  });
  const pathIdentity = assertFactIdentity(workspace.pathIdentity, "workspace.pathIdentity", {
    uid: workspace.hostOwnerUid,
    gid: workspace.hostOwnerGid,
    modeNotWritableByUntrusted: true,
  });
  const filesystem = assertFilesystemBinding(workspace.filesystem, "workspace.filesystem");
  if (!isInsideOrEqual(workspaceRoot, filesystem.root)) {
    fail("sandbox_fact_identity_mismatch", "Workspace root is not bound to the attested filesystem.", "workspace.filesystem.root");
  }

  assertOnlyKeys(workspace.quota, WORKSPACE_QUOTA_KEYS, "workspace.quota");
  if (!HARD_QUOTA_METHODS.has(workspace.quota.method)) {
    fail(
      "sandbox_quota_unproven",
      "Workspace quota must use a kernel-enforced method that supports both bytes and inodes.",
      "workspace.quota.method"
    );
  }
  assertSafeId(workspace.quota.id, "workspace.quota.id");
  const quotaFilesystem = assertFilesystemBinding(workspace.quota.filesystem, "workspace.quota.filesystem");
  if (canonicalSerialize(quotaFilesystem, "workspace.quota.filesystem") !== canonicalSerialize(filesystem, "workspace.filesystem")) {
    fail("sandbox_quota_unproven", "Workspace quota is not bound to the attested workspace filesystem.", "workspace.quota.filesystem");
  }
  assertInteger(workspace.quota.limitBytes, "workspace.quota.limitBytes", 1);
  assertInteger(workspace.quota.usedBytes, "workspace.quota.usedBytes", 0);
  assertInteger(workspace.quota.inodeLimit, "workspace.quota.inodeLimit", 1);
  assertInteger(workspace.quota.usedInodes, "workspace.quota.usedInodes", 0);
  assertExactTrue(workspace.quota.supportsBytes, "workspace.quota.supportsBytes");
  assertExactTrue(workspace.quota.supportsInodes, "workspace.quota.supportsInodes");
  assertExactTrue(workspace.quota.enforced, "workspace.quota.enforced");
  assertExactTrue(workspace.quota.hard, "workspace.quota.hard");
  assertExactTrue(workspace.quota.noSharedPool, "workspace.quota.noSharedPool");
  if (workspace.quota.limitBytes !== limits.workspaceBytes || workspace.quota.usedBytes > workspace.quota.limitBytes) {
    fail("sandbox_quota_unproven", "Workspace quota does not exactly enforce the requested byte limit.", "workspace.quota.limitBytes");
  }
  if (workspace.quota.inodeLimit !== limits.workspaceFiles || workspace.quota.usedInodes > workspace.quota.inodeLimit) {
    fail(
      "sandbox_quota_unproven",
      "Workspace quota does not exactly enforce the requested inode limit.",
      "workspace.quota.inodeLimit"
    );
  }

  return Object.freeze({
    bootId,
    workspaceRoot,
    workspacePath,
    rootIdentity,
    pathIdentity,
    filesystem,
    uidMap,
    quota: Object.freeze({
      method: workspace.quota.method,
      id: workspace.quota.id,
      filesystem: quotaFilesystem,
      limitBytes: workspace.quota.limitBytes,
      usedBytes: workspace.quota.usedBytes,
      inodeLimit: workspace.quota.inodeLimit,
      usedInodes: workspace.quota.usedInodes,
      supportsBytes: true,
      supportsInodes: true,
      enforced: true,
      hard: true,
      noSharedPool: true,
    }),
  });
}

function normalizeRequest(input) {
  assertOnlyKeys(input, INPUT_KEYS, "request");
  const image = validateImageReference(input.image);
  const identifiers = {
    runId: assertSafeId(input.runId, "runId"),
    threadId: assertSafeId(input.threadId, "threadId"),
    leaseId: assertSafeId(input.leaseId, "leaseId"),
  };
  const command = validateContainerCommand(input.command);
  const limits = resolveLimits(input.limits);
  const runtime = attestRuntime(input.runtime, image, identifiers);
  const workspace = attestWorkspace(input.workspace, identifiers, limits, runtime);
  return { image, identifiers, command, limits, runtime, workspace };
}

function cpuLimit(cpuMillis) {
  return (cpuMillis / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function buildLabels(normalized) {
  const { identifiers, image, runtime, workspace } = normalized;
  const reconcileKey = sha256(
    `${PUBLIC_INTEGRATION_SANDBOX_PROFILE_ID}\0${identifiers.runId}\0${identifiers.threadId}\0${identifiers.leaseId}`
  );
  return Object.freeze({
    "art.lazying.aginti.public.managed": "true",
    "art.lazying.aginti.public.profile": PUBLIC_INTEGRATION_SANDBOX_PROFILE_ID,
    "art.lazying.aginti.public.run": identifiers.runId,
    "art.lazying.aginti.public.thread": identifiers.threadId,
    "art.lazying.aginti.public.lease": identifiers.leaseId,
    "art.lazying.aginti.public.reconcile": reconcileKey,
    "art.lazying.aginti.public.workspace": sha256(workspace.workspacePath),
    "art.lazying.aginti.public.image": image.slice(image.indexOf("@") + 1),
    "art.lazying.aginti.public.runtime-attestation": runtime.attestationId,
  });
}

function buildHostSpawnEnvironment(runtime) {
  const endpointUri = `unix://${runtime.controlEndpoint.path}`;
  return Object.freeze([
    "PATH=/usr/bin:/bin",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    `XDG_RUNTIME_DIR=/run/user/${runtime.effectiveUid}`,
    `CONTAINER_HOST=${endpointUri}`,
    "DOCKER_HOST=",
    "DOCKER_CONTEXT=",
    "PODMAN_SYSTEM_CONNECTION=",
    "CONTAINERS_CONF=",
    "CONTAINERS_STORAGE_CONF=",
    "REGISTRY_AUTH_FILE=",
    "SSH_AUTH_SOCK=",
    "HTTP_PROXY=",
    "HTTPS_PROXY=",
    "ALL_PROXY=",
    "NO_PROXY=*",
    "http_proxy=",
    "https_proxy=",
    "all_proxy=",
    "no_proxy=*",
  ]);
}

function buildInvocationFromNormalized(normalized) {
  const { identifiers, command, image, limits, runtime, workspace } = normalized;
  const labels = buildLabels(normalized);
  const cidfile = `${workspace.workspacePath}/.aginti-public/${identifiers.leaseId}.cid`;
  const capturedContainerId = "{{capturedContainerId}}";
  const mount = `type=bind,src=${workspace.workspacePath},dst=/workspace,rw,bind-propagation=rprivate`;
  const args = [
    "run",
    "--rm",
    "--cidfile",
    cidfile,
    "--log-driver",
    "none",
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--security-opt",
    `seccomp=${runtime.security.seccomp.profilePath}`,
    "--security-opt",
    `apparmor=${runtime.security.apparmor.profileName}`,
    "--user",
    `${PUBLIC_INTEGRATION_CONTAINER_USER.uid}:${PUBLIC_INTEGRATION_CONTAINER_USER.gid}`,
    "--pids-limit",
    String(limits.pids),
    "--memory",
    String(limits.memoryBytes),
    "--memory-swap",
    String(limits.memoryBytes),
    "--cpus",
    cpuLimit(limits.cpuMillis),
    "--ulimit",
    `nofile=${limits.fileDescriptors}:${limits.fileDescriptors}`,
    "--ulimit",
    "core=0:0",
    "--stop-timeout",
    "3",
    "--ipc",
    "none",
    "--cgroupns",
    "private",
    "--init",
    "--hostname",
    "aginti-public-sandbox",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${limits.tmpfsBytes},mode=1777`,
    "--tmpfs",
    `/run:rw,nosuid,nodev,noexec,size=${limits.runTmpfsBytes},mode=700,uid=${PUBLIC_INTEGRATION_CONTAINER_USER.uid},gid=${PUBLIC_INTEGRATION_CONTAINER_USER.gid}`,
    "--tmpfs",
    `/home/agent:rw,nosuid,nodev,noexec,size=${limits.homeTmpfsBytes},mode=700,uid=${PUBLIC_INTEGRATION_CONTAINER_USER.uid},gid=${PUBLIC_INTEGRATION_CONTAINER_USER.gid}`,
    "--mount",
    mount,
  ];
  for (const key of ObjectKeys(labels)) args.push("--label", `${key}=${labels[key]}`);
  for (const entry of CONTAINER_ENVIRONMENT) args.push("--env", entry);
  args.push("--workdir", "/workspace", "--entrypoint", command[0], image);
  for (let index = 1; index < command.length; index += 1) args.push(command[index]);

  const lifecycleLabels = [
    `art.lazying.aginti.public.managed=true`,
    `art.lazying.aginti.public.profile=${PUBLIC_INTEGRATION_SANDBOX_PROFILE_ID}`,
    `art.lazying.aginti.public.run=${identifiers.runId}`,
    `art.lazying.aginti.public.thread=${identifiers.threadId}`,
    `art.lazying.aginti.public.lease=${identifiers.leaseId}`,
    `art.lazying.aginti.public.reconcile=${labels["art.lazying.aginti.public.reconcile"]}`,
  ];
  const lifecycleLabelRequirements = [...lifecycleLabels];
  const reconcileArgs = ["ps", "--all"];
  for (let index = 0; index < lifecycleLabels.length; index += 1) {
    reconcileArgs.push("--filter", `label=${lifecycleLabels[index]}`);
  }
  reconcileArgs.push("--format", "{{.ID}}");
  const containerIdSource = Object.freeze({
    cidfile,
    immutable: true,
    capturedAfterSpawn: true,
    requireNonReusableName: true,
  });
  const identityChecks = {
    executable: runtime.executableIdentity,
    controlEndpoint: runtime.controlEndpoint.identity,
    seccomp: runtime.security.seccomp.identity,
    workspaceRoot: workspace.rootIdentity,
    workspacePath: workspace.pathIdentity,
    workspaceFilesystem: workspace.filesystem,
    quotaFilesystem: workspace.quota.filesystem,
  };
  const invocationCore = {
    schema: PUBLIC_INTEGRATION_INVOCATION_SCHEMA,
    profileId: PUBLIC_INTEGRATION_SANDBOX_PROFILE_ID,
    executable: runtime.executable,
    args,
    spawn: {
      executable: runtime.executable,
      cwd: "/",
      clearInheritedEnv: true,
      env: buildHostSpawnEnvironment(runtime),
      endpoint: {
        kind: runtime.controlEndpoint.kind,
        uri: `unix://${runtime.controlEndpoint.path}`,
        identity: runtime.controlEndpoint.identity,
      },
    },
    container: {
      image,
      user: `${PUBLIC_INTEGRATION_CONTAINER_USER.uid}:${PUBLIC_INTEGRATION_CONTAINER_USER.gid}`,
      workspace: workspace.workspacePath,
      cidfile,
      idRef: capturedContainerId,
      labels,
    },
    limits: { ...limits },
    supervisor: {
      wallTimeMs: limits.wallTimeMs,
      stdoutBytes: limits.stdoutBytes,
      stderrBytes: limits.stderrBytes,
      workspaceBytes: limits.workspaceBytes,
      workspaceFiles: limits.workspaceFiles,
      countOutputBytesBeforeDecode: true,
      disconnectCancelsRun: false,
      requireAbortSignal: true,
    },
    lifecycle: {
      inspect: {
        executable: runtime.executable,
        args: ["inspect", "--format", "{{json .Config.Labels}}", capturedContainerId],
        containerIdSource,
        requireAllLabels: lifecycleLabelRequirements,
      },
      stop: {
        executable: runtime.executable,
        args: ["stop", "--time", "3", capturedContainerId],
        containerIdSource,
        requiresPriorLabelVerification: true,
        requireAllLabels: lifecycleLabelRequirements,
      },
      kill: {
        executable: runtime.executable,
        args: ["kill", "--signal", "KILL", capturedContainerId],
        containerIdSource,
        requiresPriorLabelVerification: true,
        requireAllLabels: lifecycleLabelRequirements,
      },
      remove: {
        executable: runtime.executable,
        args: ["rm", "--force", capturedContainerId],
        containerIdSource,
        requiresPriorLabelVerification: true,
        requireAllLabels: lifecycleLabelRequirements,
      },
      reconcile: {
        executable: runtime.executable,
        args: reconcileArgs,
        requireAllLabels: lifecycleLabels,
      },
    },
    executorPreflight: {
      schema: PUBLIC_INTEGRATION_EXECUTOR_PREFLIGHT_SCHEMA,
      mustRestatBeforeSpawn: true,
      mustRedigestBeforeSpawn: true,
      maxRestatAgeMs: PUBLIC_INTEGRATION_RESTAT_MAX_AGE_MS,
      bootId: runtime.bootId,
      capturedAt: runtime.capturedAt,
      expiresAt: runtime.expiresAt,
      identityChecks,
    },
    capability: {
      enabled: PUBLIC_INTEGRATION_SANDBOX_CAPABILITY_ENABLED,
      reason: "fresh_collector_executor_revalidation_required",
    },
  };
  const digest = canonicalDigest(invocationCore, "invocation");
  return {
    ...invocationCore,
    attestation: {
      ok: true,
      digest,
      runtimeAttestationId: runtime.attestationId,
      workspaceLeaseId: identifiers.leaseId,
      rootless: true,
      readOnlyRootfs: true,
      network: "none",
      imageDigest: image.slice(image.indexOf("@") + 1),
      quotaEnforcement: "runtime-supervisor-and-filesystem",
      capabilityEnabled: PUBLIC_INTEGRATION_SANDBOX_CAPABILITY_ENABLED,
    },
  };
}

function stableEqual(left, right) {
  return canonicalSerialize(left, "left") === canonicalSerialize(right, "right");
}

export function attestPublicIntegrationSandboxPrerequisites(input) {
  const normalized = normalizeRequest(input);
  return deepFreeze({
    ok: false,
    valid: true,
    enabled: PUBLIC_INTEGRATION_SANDBOX_CAPABILITY_ENABLED,
    profileId: PUBLIC_INTEGRATION_SANDBOX_PROFILE_ID,
    runtimeAttestationId: normalized.runtime.attestationId,
    engine: normalized.runtime.engine,
    rootless: true,
    image: normalized.image,
    workspace: normalized.workspace.workspacePath,
    limits: { ...normalized.limits },
    capability: {
      enabled: PUBLIC_INTEGRATION_SANDBOX_CAPABILITY_ENABLED,
      reason: "fresh_collector_executor_revalidation_required",
    },
    facts: {
      maxTtlMs: PUBLIC_INTEGRATION_FACT_MAX_TTL_MS,
      bootId: normalized.runtime.bootId,
      capturedAt: normalized.runtime.capturedAt,
      expiresAt: normalized.runtime.expiresAt,
    },
    assertions: {
      nonRootUser: true,
      readOnlyRootfs: true,
      capDropAll: true,
      noNewPrivileges: true,
      seccomp: true,
      apparmor: true,
      networkNone: true,
      singlePerThreadWorkspace: true,
      privateTmpfs: true,
      noSharedMutableState: true,
      boundedResources: true,
      exactLifecycleIdentity: true,
      immutableImage: true,
      freshFactsRequired: true,
      executorRestatBeforeSpawnRequired: true,
    },
  });
}

export function buildPublicIntegrationSandboxInvocation(input) {
  const normalized = normalizeRequest(input);
  return deepFreeze(buildInvocationFromNormalized(normalized));
}

export function attestPublicIntegrationSandboxInvocation(invocation, input) {
  assertOnlyKeys(invocation, INVOCATION_KEYS, "invocation");
  const normalized = normalizeRequest(input);
  const expected = buildInvocationFromNormalized(normalized);
  if (!stableEqual(invocation, expected)) {
    fail(
      "sandbox_invocation_tampered",
      "The container invocation differs from the canonical attested public integration profile.",
      "invocation"
    );
  }
  return deepFreeze({
    ok: true,
    profileId: expected.profileId,
    digest: expected.attestation.digest,
    capabilityEnabled: expected.capability.enabled,
    cidfile: expected.container.cidfile,
    containerIdRef: expected.container.idRef,
    runtimeAttestationId: expected.attestation.runtimeAttestationId,
    workspaceLeaseId: expected.attestation.workspaceLeaseId,
  });
}
