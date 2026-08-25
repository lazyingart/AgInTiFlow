import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import { validateIntegrationBearerToken } from "./integration-auth.js";
import { DOCUMENT_WORKER_LIMITS } from "./integration-document-worker-contract.js";

export const DOCUMENT_WORKER_SERVICE_CONFIG_SCHEMA_VERSION =
  "aginti-document-worker-service-config-v1";
export const DOCUMENT_WORKER_SYSTEMD_UNIT = "aginti-document-worker.service";
export const DOCUMENT_WORKER_CONFIG_PATH = "/etc/agintiflow/document-worker.json";
export const DOCUMENT_WORKER_STATE_ROOT = "/var/lib/aginti-document-worker";
export const DOCUMENT_WORKER_LISTEN_HOST = "127.0.0.1";
export const DOCUMENT_WORKER_LISTEN_PORT = 18102;
export const DOCUMENT_WORKER_UPSTREAM_CREDENTIAL_NAME = "document-worker-upstream-token";
export const DOCUMENT_WORKER_CREDENTIALS_DIRECTORY =
  `/run/credentials/${DOCUMENT_WORKER_SYSTEMD_UNIT}`;
export const DOCUMENT_WORKER_UPSTREAM_CREDENTIAL_PATH =
  `${DOCUMENT_WORKER_CREDENTIALS_DIRECTORY}/${DOCUMENT_WORKER_UPSTREAM_CREDENTIAL_NAME}`;
export const DOCUMENT_WORKER_MAXIMUM_CONFIG_BYTES = 32 * 1024;

const CONFIG_KEYS = Object.freeze(["schemaVersion", "listen", "stateRoot", "creation"]);
const LISTEN_KEYS = Object.freeze(["host", "port"]);
const CREATION_KEYS = Object.freeze(["enabled", "maximumConcurrentCompiles"]);
const O_NOFOLLOW = Number(fsConstants.O_NOFOLLOW || 0);
const O_NONBLOCK = Number(fsConstants.O_NONBLOCK || 0);
const O_CLOEXEC = Number(fsConstants.O_CLOEXEC || 0);

export class IntegrationDocumentWorkerConfigError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationDocumentWorkerConfigError";
    this.code = code;
    this.publicCode = code;
    this.status = 503;
    this.statusCode = 503;
  }
}

function fail(code, message, cause) {
  throw new IntegrationDocumentWorkerConfigError(code, message, { cause });
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    fail("DOCUMENT_WORKER_CONFIG_INVALID", `${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("DOCUMENT_WORKER_CONFIG_INVALID", `${label} must be a plain data object.`);
  }
  return value;
}

function exact(value, allowedKeys, requiredKeys, label) {
  const object = plainObject(value, label);
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(object, key) : null;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      fail("DOCUMENT_WORKER_CONFIG_INVALID", `${label} contains an unsupported field.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(object, key)) {
      fail("DOCUMENT_WORKER_CONFIG_INVALID", `${label}.${key} is required.`);
    }
  }
  return object;
}

export function validateIntegrationDocumentWorkerConfig(value) {
  const config = exact(value, CONFIG_KEYS, CONFIG_KEYS, "document worker config");
  if (config.schemaVersion !== DOCUMENT_WORKER_SERVICE_CONFIG_SCHEMA_VERSION) {
    fail("DOCUMENT_WORKER_CONFIG_INVALID", "Document worker config schemaVersion is unsupported.");
  }
  const listen = exact(config.listen, LISTEN_KEYS, LISTEN_KEYS, "document worker listen config");
  if (listen.host !== DOCUMENT_WORKER_LISTEN_HOST || listen.port !== DOCUMENT_WORKER_LISTEN_PORT) {
    fail(
      "DOCUMENT_WORKER_CONFIG_LOCKED",
      `Document worker listener must be ${DOCUMENT_WORKER_LISTEN_HOST}:${DOCUMENT_WORKER_LISTEN_PORT}.`
    );
  }
  if (
    typeof config.stateRoot !== "string" ||
    config.stateRoot !== DOCUMENT_WORKER_STATE_ROOT ||
    !path.isAbsolute(config.stateRoot) ||
    path.normalize(config.stateRoot) !== config.stateRoot
  ) {
    fail("DOCUMENT_WORKER_CONFIG_LOCKED", "Document worker stateRoot is fixed to its private StateDirectory.");
  }
  const creation = exact(config.creation, CREATION_KEYS, CREATION_KEYS, "document worker creation config");
  if (typeof creation.enabled !== "boolean") {
    fail("DOCUMENT_WORKER_CONFIG_INVALID", "creation.enabled must be a boolean.");
  }
  if (creation.maximumConcurrentCompiles !== DOCUMENT_WORKER_LIMITS.maximumConcurrentCompiles) {
    fail(
      "DOCUMENT_WORKER_CONFIG_LOCKED",
      `creation.maximumConcurrentCompiles must be ${DOCUMENT_WORKER_LIMITS.maximumConcurrentCompiles}.`
    );
  }
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SERVICE_CONFIG_SCHEMA_VERSION,
    listen: Object.freeze({ host: DOCUMENT_WORKER_LISTEN_HOST, port: DOCUMENT_WORKER_LISTEN_PORT }),
    stateRoot: DOCUMENT_WORKER_STATE_ROOT,
    creation: Object.freeze({
      enabled: creation.enabled,
      maximumConcurrentCompiles: DOCUMENT_WORKER_LIMITS.maximumConcurrentCompiles,
    }),
  });
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function permittedOwner(stat, ownerUid, allowRootOwner) {
  return stat.uid === ownerUid || (allowRootOwner && stat.uid === 0);
}

async function protectedTextFile(filePath, {
  label,
  ownerUid,
  allowRootOwner,
  minimumBytes,
  maximumBytes,
}) {
  if (
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    path.normalize(filePath) !== filePath
  ) {
    fail("DOCUMENT_WORKER_PROTECTED_FILE_INVALID", `${label} path must be canonical and absolute.`);
  }
  let handle;
  try {
    const [real, named] = await Promise.all([fs.realpath(filePath), fs.lstat(filePath)]);
    if (
      real !== filePath ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      named.nlink !== 1 ||
      !permittedOwner(named, ownerUid, allowRootOwner) ||
      ((named.mode & 0o777) & 0o077) !== 0 ||
      named.size < minimumBytes ||
      named.size > maximumBytes
    ) {
      fail("DOCUMENT_WORKER_PROTECTED_FILE_INVALID", `${label} is not a protected regular file.`);
    }
    handle = await fs.open(filePath, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    const before = await handle.stat();
    if (!sameSnapshot(named, before)) {
      fail("DOCUMENT_WORKER_PROTECTED_FILE_CHANGED", `${label} changed before it was read.`);
    }
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    const afterNamed = await fs.lstat(filePath);
    if (
      !sameSnapshot(before, after) ||
      !sameSnapshot(after, afterNamed) ||
      Buffer.byteLength(text, "utf8") !== after.size
    ) {
      fail("DOCUMENT_WORKER_PROTECTED_FILE_CHANGED", `${label} changed while it was read.`);
    }
    return text;
  } catch (error) {
    if (error instanceof IntegrationDocumentWorkerConfigError) throw error;
    fail("DOCUMENT_WORKER_PROTECTED_FILE_INVALID", `${label} could not be read safely.`, error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function filePolicy(options = {}) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const ownerUid = Number(options.ownerUid ?? currentUid);
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    fail("DOCUMENT_WORKER_PROTECTED_FILE_INVALID", "Protected-file owner UID is invalid.");
  }
  return Object.freeze({ ownerUid, allowRootOwner: options.allowRootOwner !== false });
}

export async function loadIntegrationDocumentWorkerConfig(
  filePath = DOCUMENT_WORKER_CONFIG_PATH,
  options = {}
) {
  const policy = filePolicy(options);
  const raw = await protectedTextFile(filePath, {
    label: "Document worker config",
    ...policy,
    minimumBytes: 2,
    maximumBytes: DOCUMENT_WORKER_MAXIMUM_CONFIG_BYTES,
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail("DOCUMENT_WORKER_CONFIG_INVALID", "Document worker config is not valid JSON.", error);
  }
  return validateIntegrationDocumentWorkerConfig(parsed);
}

export function parseIntegrationDocumentWorkerCredential(raw) {
  if (typeof raw !== "string" || raw.includes("\u0000") || raw.includes("\r")) {
    fail("DOCUMENT_WORKER_CREDENTIAL_INVALID", "Document worker credential framing is invalid.");
  }
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!token || token.includes("\n")) {
    fail("DOCUMENT_WORKER_CREDENTIAL_INVALID", "Document worker credential must contain exactly one line.");
  }
  try {
    return validateIntegrationBearerToken(token, { field: "Document worker upstream credential" });
  } catch (error) {
    fail("DOCUMENT_WORKER_CREDENTIAL_INVALID", "Document worker credential is invalid.", error);
  }
}

async function validateCredentialDirectory(options) {
  const policy = filePolicy(options);
  try {
    const [real, stat] = await Promise.all([
      fs.realpath(DOCUMENT_WORKER_CREDENTIALS_DIRECTORY),
      fs.lstat(DOCUMENT_WORKER_CREDENTIALS_DIRECTORY),
    ]);
    if (
      real !== DOCUMENT_WORKER_CREDENTIALS_DIRECTORY ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !permittedOwner(stat, policy.ownerUid, true) ||
      ((stat.mode & 0o777) & 0o022) !== 0
    ) {
      fail("DOCUMENT_WORKER_CREDENTIAL_INVALID", "Systemd credential directory is unsafe.");
    }
    return policy;
  } catch (error) {
    if (error instanceof IntegrationDocumentWorkerConfigError) throw error;
    fail("DOCUMENT_WORKER_CREDENTIAL_INVALID", "Systemd credential directory is unavailable.", error);
  }
}

export async function loadIntegrationDocumentWorkerCredential(...args) {
  if (args.length > 1) {
    fail(
      "DOCUMENT_WORKER_CREDENTIAL_SOURCE_FORBIDDEN",
      "Document worker credential source is fixed by systemd LoadCredential."
    );
  }
  const options = args[0] || {};
  const policy = await validateCredentialDirectory(options);
  const raw = await protectedTextFile(DOCUMENT_WORKER_UPSTREAM_CREDENTIAL_PATH, {
    label: "Document worker upstream credential",
    ...policy,
    minimumBytes: 32,
    maximumBytes: 4097,
  });
  return parseIntegrationDocumentWorkerCredential(raw);
}

export function publicIntegrationDocumentWorkerConfig(configInput) {
  const config = validateIntegrationDocumentWorkerConfig(configInput);
  return Object.freeze({
    schemaVersion: config.schemaVersion,
    listen: config.listen,
    stateRoot: config.stateRoot,
    creation: config.creation,
    upstreamCredentialName: DOCUMENT_WORKER_UPSTREAM_CREDENTIAL_NAME,
  });
}
