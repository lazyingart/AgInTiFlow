import fs from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import { readProtectedJsonFile } from "./integration-durable-common.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_EXECUTION_WORKER_BINDING_CONFIG_SCHEMA_VERSION =
  "aginti-integration-execution-worker-binding-config-v1";
export const INTEGRATION_EXECUTION_WORKER_BINDING_SCHEMA_VERSION =
  "aginti-integration-execution-worker-binding-v1";
export const INTEGRATION_EXECUTION_WORKER_BINDING_CONFIG_PATH =
  "/etc/agintiflow-integration/execution-worker-bindings.json";
export const INTEGRATION_EXECUTION_WORKER_FIXED_CREDENTIAL_NAME = "execution-worker-token";
export const INTEGRATION_EXECUTION_WORKER_MAXIMUM_BINDINGS = 16;
export const INTEGRATION_EXECUTION_WORKER_LAZYEDGE_PORT_RANGE = Object.freeze({
  minimum: 18_131,
  maximum: 18_194,
});

const BINDING_BRAND = new WeakSet();
const BINDING_ID = /^binding_[A-Za-z0-9_-]{16,96}$/u;
const CREDENTIAL_NAME = /^execution-worker-binding-[A-Za-z0-9_-]{8,64}$/u;
const TRANSPORTS = new Set(["local-loopback-http-v1", "lazyedge-private-http-v1"]);
const MAXIMUM_CONFIG_BYTES = 32 * 1024;

export class IntegrationExecutionWorkerBindingConfigError extends Error {
  constructor(code, message, { status = 503, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationExecutionWorkerBindingConfigError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, options) {
  throw new IntegrationExecutionWorkerBindingConfigError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowedKeys, requiredKeys, label) {
  if (!isPlainObject(value)) fail("EXECUTION_BINDING_CONFIG_INVALID", `${label} must be a plain data object.`);
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("EXECUTION_BINDING_CONFIG_INVALID", `${label} contains an unsupported field.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("EXECUTION_BINDING_CONFIG_INVALID", `${label}.${key} is required.`);
    }
  }
  return value;
}

function validateBinding(value) {
  const binding = exactObject(
    value,
    ["schemaVersion", "bindingId", "transport", "host", "port", "credentialName"],
    ["schemaVersion", "bindingId", "transport", "host", "port", "credentialName"],
    "execution worker binding"
  );
  if (
    binding.schemaVersion !== INTEGRATION_EXECUTION_WORKER_BINDING_SCHEMA_VERSION ||
    typeof binding.bindingId !== "string" ||
    !BINDING_ID.test(binding.bindingId) ||
    typeof binding.transport !== "string" ||
    !TRANSPORTS.has(binding.transport) ||
    binding.host !== "127.0.0.1" ||
    !Number.isSafeInteger(binding.port)
  ) {
    fail("EXECUTION_BINDING_CONFIG_INVALID", "execution worker binding identity is invalid.");
  }
  if (binding.transport === "local-loopback-http-v1") {
    if (binding.port !== 18_130 || binding.credentialName !== INTEGRATION_EXECUTION_WORKER_FIXED_CREDENTIAL_NAME) {
      fail("EXECUTION_BINDING_CONFIG_INVALID", "local execution worker binding must use its fixed socket and credential.");
    }
  } else if (
    binding.port < INTEGRATION_EXECUTION_WORKER_LAZYEDGE_PORT_RANGE.minimum ||
    binding.port > INTEGRATION_EXECUTION_WORKER_LAZYEDGE_PORT_RANGE.maximum ||
    typeof binding.credentialName !== "string" ||
    !CREDENTIAL_NAME.test(binding.credentialName)
  ) {
    fail("EXECUTION_BINDING_CONFIG_INVALID", "LazyEdge execution worker binding is outside its reserved relay range.");
  }
  return Object.freeze({
    schemaVersion: INTEGRATION_EXECUTION_WORKER_BINDING_SCHEMA_VERSION,
    bindingId: binding.bindingId,
    transport: binding.transport,
    host: "127.0.0.1",
    port: binding.port,
    credentialName: binding.credentialName,
  });
}

export function validateIntegrationExecutionWorkerBindingConfig(value) {
  const config = exactObject(value, ["schemaVersion", "bindings"], ["schemaVersion", "bindings"], "execution worker binding config");
  if (
    config.schemaVersion !== INTEGRATION_EXECUTION_WORKER_BINDING_CONFIG_SCHEMA_VERSION ||
    !Array.isArray(config.bindings) ||
    config.bindings.length < 1 ||
    config.bindings.length > INTEGRATION_EXECUTION_WORKER_MAXIMUM_BINDINGS
  ) {
    fail("EXECUTION_BINDING_CONFIG_INVALID", "execution worker binding config shape is invalid.");
  }
  const bindings = config.bindings.map(validateBinding).sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  for (const field of ["bindingId", "port", "credentialName"]) {
    if (new Set(bindings.map((binding) => binding[field])).size !== bindings.length) {
      fail("EXECUTION_BINDING_CONFIG_INVALID", `execution worker binding ${field} values must be unique.`);
    }
  }
  const unsigned = Object.freeze({
    schemaVersion: INTEGRATION_EXECUTION_WORKER_BINDING_CONFIG_SCHEMA_VERSION,
    bindings: Object.freeze(bindings),
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.gid === right.gid && left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function trustedOwner(stat) {
  const uid = typeof process.geteuid === "function" ? process.geteuid() : process.getuid?.();
  return stat.uid === 0 || (Number.isSafeInteger(uid) && stat.uid === uid);
}

async function protectedManifest(pathname) {
  const directory = path.dirname(pathname);
  try {
    const [directoryReal, directoryBefore, fileReal, fileBefore] = await Promise.all([
      fs.realpath(directory),
      fs.lstat(directory),
      fs.realpath(pathname),
      fs.lstat(pathname),
    ]);
    if (
      directoryReal !== directory ||
      fileReal !== pathname ||
      directoryBefore.isSymbolicLink() ||
      !directoryBefore.isDirectory() ||
      !trustedOwner(directoryBefore) ||
      (directoryBefore.mode & 0o022) !== 0 ||
      fileBefore.isSymbolicLink() ||
      !fileBefore.isFile() ||
      !trustedOwner(fileBefore) ||
      fileBefore.nlink !== 1 ||
      (fileBefore.mode & 0o777) !== 0o600 ||
      fileBefore.size < 2 ||
      fileBefore.size > MAXIMUM_CONFIG_BYTES
    ) {
      fail("EXECUTION_BINDING_CONFIG_UNSAFE", "execution worker binding manifest metadata is unsafe.");
    }
    const parsed = await readProtectedJsonFile(pathname, { maxBytes: MAXIMUM_CONFIG_BYTES });
    const [directoryAfter, fileAfter, directoryRealAfter, fileRealAfter] = await Promise.all([
      fs.lstat(directory),
      fs.lstat(pathname),
      fs.realpath(directory),
      fs.realpath(pathname),
    ]);
    if (
      !sameStat(directoryBefore, directoryAfter) ||
      !sameStat(fileBefore, fileAfter) ||
      directoryRealAfter !== directory ||
      fileRealAfter !== pathname
    ) {
      fail("EXECUTION_BINDING_CONFIG_CHANGED", "execution worker binding manifest changed while it was read.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof IntegrationExecutionWorkerBindingConfigError) throw error;
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      fail("EXECUTION_BINDING_CONFIG_MISSING", "execution worker binding manifest is not installed.", {
        cause: error,
      });
    }
    fail("EXECUTION_BINDING_CONFIG_UNAVAILABLE", "execution worker binding manifest could not be read safely.", {
      cause: error,
    });
  }
}

export async function loadIntegrationExecutionWorkerBindingConfig(...args) {
  if (args.length !== 0) {
    fail("EXECUTION_BINDING_CONFIG_SOURCE_FORBIDDEN", "execution worker binding manifest path is fixed.");
  }
  const config = validateIntegrationExecutionWorkerBindingConfig(
    await protectedManifest(INTEGRATION_EXECUTION_WORKER_BINDING_CONFIG_PATH)
  );
  const bindings = config.bindings.map((binding) => {
    const branded = Object.freeze({ ...binding, configDigest: config.digest });
    BINDING_BRAND.add(branded);
    return branded;
  });
  return Object.freeze({
    schemaVersion: config.schemaVersion,
    bindings: Object.freeze(bindings),
    digest: config.digest,
  });
}

export function assertIntegrationExecutionWorkerBinding(value) {
  if (!value || !BINDING_BRAND.has(value)) {
    throw new TypeError("execution worker binding is not loaded from the fixed AgInTi manifest");
  }
  return value;
}
