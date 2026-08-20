import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_INTEGRATION_CREDENTIAL_NAME,
  createIntegrationClient,
  validateIntegrationBearerToken,
  validateIntegrationClientId,
} from "./integration-auth.js";
import { INTEGRATION_RPC_PATH_LIST, INTEGRATION_RPC_PATHS } from "./integration-policy.js";

export const INTEGRATION_SERVICE_CONFIG_SCHEMA = "aginti-integration-service-config-v1";
export const DEFAULT_INTEGRATION_CONFIG_PATH = "/etc/agintiflow/integration.json";
export const DEFAULT_INTEGRATION_STATE_ROOT = "/var/lib/agintiflow-integration";
export const INTEGRATION_LISTEN_HOST = "127.0.0.1";
export const MAX_INTEGRATION_CONFIG_BYTES = 32 * 1024;
export const INTEGRATION_SYSTEMD_UNIT_NAME = "agintiflow-integration.service";
export const INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY =
  `/run/credentials/${INTEGRATION_SYSTEMD_UNIT_NAME}`;

const CONFIG_KEYS = Object.freeze([
  "schemaVersion",
  "capability",
  "listen",
  "stateRoot",
  "trustedPrincipalProxy",
]);
const CAPABILITY_KEYS = Object.freeze(["enabled"]);
const LISTEN_KEYS = Object.freeze(["host", "port"]);
const TRUSTED_PROXY_KEYS = Object.freeze(["clientId", "label", "scopes"]);
const RPC_PATH_SET = new Set(INTEGRATION_RPC_PATH_LIST);

export class IntegrationServiceConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IntegrationServiceConfigError";
    this.code = code;
    this.publicCode = code;
  }
}

function configFail(code, message) {
  throw new IntegrationServiceConfigError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowedKeys, requiredKeys, label) {
  if (!isPlainObject(value)) configFail("INTEGRATION_CONFIG_INVALID", `${label} must be a plain object.`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    configFail("INTEGRATION_CONFIG_INVALID", `${label} may contain only string data fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || !allowedKeys.includes(key)) {
      configFail("INTEGRATION_CONFIG_INVALID", `${label} contains an unsupported field.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      configFail("INTEGRATION_CONFIG_INVALID", `${label} is missing a required field.`);
    }
  }
  return value;
}

function boundedLabel(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 80 || /[\u0000-\u001f\u007f]/u.test(value)) {
    configFail("INTEGRATION_CONFIG_INVALID", "trustedPrincipalProxy.label is invalid.");
  }
  const normalized = value.trim();
  if (!normalized) configFail("INTEGRATION_CONFIG_INVALID", "trustedPrincipalProxy.label is invalid.");
  return normalized;
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > INTEGRATION_RPC_PATH_LIST.length) {
    configFail("INTEGRATION_CONFIG_INVALID", "trustedPrincipalProxy.scopes must be a bounded explicit route list.");
  }
  const scopes = [];
  const seen = new Set();
  for (const scope of value) {
    if (typeof scope !== "string" || scope === "*" || !RPC_PATH_SET.has(scope) || seen.has(scope)) {
      configFail("INTEGRATION_CONFIG_INVALID", "trustedPrincipalProxy.scopes contains an invalid or duplicate route.");
    }
    seen.add(scope);
    scopes.push(scope);
  }
  if (!seen.has(INTEGRATION_RPC_PATHS.capabilities)) {
    configFail("INTEGRATION_CONFIG_INVALID", "trustedPrincipalProxy.scopes must include the capabilities route.");
  }
  return Object.freeze(scopes);
}

function validateStateRoot(value) {
  if (typeof value !== "string" || value !== DEFAULT_INTEGRATION_STATE_ROOT || !path.isAbsolute(value)) {
    configFail(
      "INTEGRATION_CONFIG_INVALID",
      "stateRoot must be the dedicated AgInTi integration state root."
    );
  }
  return value;
}

export function validateIntegrationListenConfig(value) {
  const listen = exactObject(value, LISTEN_KEYS, LISTEN_KEYS, "listen");
  if (listen.host !== INTEGRATION_LISTEN_HOST) {
    configFail("INTEGRATION_LISTEN_INVALID", "listen.host must be the exact IPv4 loopback address.");
  }
  if (!Number.isSafeInteger(listen.port) || listen.port < 1 || listen.port > 65535) {
    configFail("INTEGRATION_LISTEN_INVALID", "listen.port must be a fixed nonzero TCP port.");
  }
  return Object.freeze({ host: INTEGRATION_LISTEN_HOST, port: listen.port });
}

export function validateIntegrationServiceConfig(value) {
  const config = exactObject(value, CONFIG_KEYS, CONFIG_KEYS, "integration config");
  if (config.schemaVersion !== INTEGRATION_SERVICE_CONFIG_SCHEMA) {
    configFail("INTEGRATION_CONFIG_INVALID", "integration config schemaVersion is unsupported.");
  }

  const capability = exactObject(config.capability, CAPABILITY_KEYS, CAPABILITY_KEYS, "capability");
  if (capability.enabled !== false) {
    configFail("INTEGRATION_CAPABILITY_LOCKED", "The first production mount keeps public integration disabled.");
  }

  const proxy = exactObject(
    config.trustedPrincipalProxy,
    TRUSTED_PROXY_KEYS,
    TRUSTED_PROXY_KEYS,
    "trustedPrincipalProxy"
  );
  let clientId;
  try {
    clientId = validateIntegrationClientId(proxy.clientId);
  } catch {
    configFail("INTEGRATION_CONFIG_INVALID", "trustedPrincipalProxy.clientId is invalid.");
  }

  return Object.freeze({
    schemaVersion: INTEGRATION_SERVICE_CONFIG_SCHEMA,
    capability: Object.freeze({ enabled: false }),
    listen: validateIntegrationListenConfig(config.listen),
    stateRoot: validateStateRoot(config.stateRoot),
    trustedPrincipalProxy: Object.freeze({
      clientId,
      label: boundedLabel(proxy.label),
      scopes: normalizeScopes(proxy.scopes),
    }),
  });
}

function allowedOwner(stat, ownerUid, allowRootOwner) {
  return stat.uid === ownerUid || (allowRootOwner && stat.uid === 0);
}

function protectedMode(stat) {
  return ((stat.mode & 0o777) & 0o077) === 0;
}

function sameFileSnapshot(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readProtectedTextFile(
  filePath,
  { label, ownerUid, allowRootOwner = true, minimumBytes = 1, maximumBytes }
) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    configFail("INTEGRATION_PROTECTED_FILE_INVALID", `${label} path must be absolute.`);
  }
  let handle;
  try {
    const canonicalPath = path.resolve(filePath);
    const realPath = await fs.realpath(canonicalPath);
    if (canonicalPath !== filePath || realPath !== canonicalPath) {
      configFail("INTEGRATION_PROTECTED_FILE_INVALID", `${label} path must not contain symbolic links.`);
    }
    handle = await fs.open(
      canonicalPath,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        (fsConstants.O_NONBLOCK || 0) |
        (fsConstants.O_CLOEXEC || 0)
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !allowedOwner(before, ownerUid, allowRootOwner) ||
      !protectedMode(before) ||
      before.size < minimumBytes ||
      before.size > maximumBytes
    ) {
      configFail("INTEGRATION_PROTECTED_FILE_INVALID", `${label} is not an owner-only protected regular file.`);
    }
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    if (!sameFileSnapshot(before, after) || Buffer.byteLength(text, "utf8") !== after.size) {
      configFail("INTEGRATION_PROTECTED_FILE_CHANGED", `${label} changed while it was being read.`);
    }
    return text;
  } catch (error) {
    if (error instanceof IntegrationServiceConfigError) throw error;
    if (error?.code === "ELOOP") {
      configFail("INTEGRATION_PROTECTED_FILE_INVALID", `${label} must not be a symbolic link.`);
    }
    configFail("INTEGRATION_PROTECTED_FILE_INVALID", `${label} could not be read safely.`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function effectiveOwnerUid(options = {}) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const ownerUid = Number(options.ownerUid ?? currentUid);
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    configFail("INTEGRATION_PROTECTED_FILE_INVALID", "Protected-file owner UID is invalid.");
  }
  return ownerUid;
}

function systemdCredentialMetadata(stat, kind) {
  return Object.freeze({
    kind,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777,
    nlink: stat.nlink,
    size: stat.size,
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
  });
}

export function validateSystemdCredentialMetadata(value) {
  const directory = value?.directory;
  const credential = value?.credential;
  const directoryModeAllowed = directory?.mode === 0o550 || directory?.mode === 0o500;
  const credentialModeAllowed = credential?.mode === 0o440 || credential?.mode === 0o400;

  if (
    !directory ||
    directory.kind !== "directory" ||
    directory.isDirectory !== true ||
    directory.isFile !== false ||
    directory.isSymbolicLink !== false ||
    directory.uid !== 0 ||
    directory.gid !== 0 ||
    !directoryModeAllowed ||
    !Number.isSafeInteger(directory.nlink) ||
    directory.nlink < 2
  ) {
    configFail(
      "INTEGRATION_CREDENTIALS_INVALID",
      "The systemd credentials directory must be a root:root, non-writable 0550 directory."
    );
  }

  if (
    !credential ||
    credential.kind !== "credential" ||
    credential.isDirectory !== false ||
    credential.isFile !== true ||
    credential.isSymbolicLink !== false ||
    credential.uid !== 0 ||
    credential.gid !== 0 ||
    !credentialModeAllowed ||
    credential.nlink !== 1 ||
    !Number.isSafeInteger(credential.size) ||
    credential.size < 32 ||
    credential.size > 4097
  ) {
    configFail(
      "INTEGRATION_CREDENTIALS_INVALID",
      "The systemd credential must be a root:root, single-link, non-writable 0440 regular file."
    );
  }
  return true;
}

async function loadCanonicalSystemdCredential() {
  const directory = INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY;
  const credentialPath = path.join(directory, DEFAULT_INTEGRATION_CREDENTIAL_NAME);
  let handle;
  try {
    if (path.resolve(directory) !== directory || path.resolve(credentialPath) !== credentialPath) {
      configFail("INTEGRATION_CREDENTIALS_INVALID", "The production credential path is not canonical.");
    }

    const [directoryRealPathBefore, directoryBefore, credentialRealPathBefore, credentialPathBefore] =
      await Promise.all([
        fs.realpath(directory),
        fs.lstat(directory),
        fs.realpath(credentialPath),
        fs.lstat(credentialPath),
      ]);
    if (
      directoryRealPathBefore !== directory ||
      credentialRealPathBefore !== credentialPath ||
      directoryBefore.isSymbolicLink() ||
      credentialPathBefore.isSymbolicLink()
    ) {
      configFail("INTEGRATION_CREDENTIALS_INVALID", "The production credential path must not contain symbolic links.");
    }

    validateSystemdCredentialMetadata({
      directory: systemdCredentialMetadata(directoryBefore, "directory"),
      credential: systemdCredentialMetadata(credentialPathBefore, "credential"),
    });

    handle = await fs.open(
      credentialPath,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        (fsConstants.O_NONBLOCK || 0) |
        (fsConstants.O_CLOEXEC || 0)
    );
    const credentialBefore = await handle.stat();
    if (!sameFileSnapshot(credentialPathBefore, credentialBefore)) {
      configFail("INTEGRATION_PROTECTED_FILE_CHANGED", "The systemd credential changed before it was read.");
    }
    const raw = await handle.readFile("utf8");
    const credentialAfter = await handle.stat();
    const [credentialPathAfter, directoryAfter, directoryRealPathAfter, credentialRealPathAfter] =
      await Promise.all([
        fs.lstat(credentialPath),
        fs.lstat(directory),
        fs.realpath(directory),
        fs.realpath(credentialPath),
      ]);
    if (
      !sameFileSnapshot(credentialBefore, credentialAfter) ||
      !sameFileSnapshot(credentialAfter, credentialPathAfter) ||
      !sameFileSnapshot(directoryBefore, directoryAfter) ||
      directoryRealPathAfter !== directory ||
      credentialRealPathAfter !== credentialPath ||
      Buffer.byteLength(raw, "utf8") !== credentialAfter.size
    ) {
      configFail("INTEGRATION_PROTECTED_FILE_CHANGED", "The systemd credential changed while it was being read.");
    }
    return raw;
  } catch (error) {
    if (error instanceof IntegrationServiceConfigError) throw error;
    configFail("INTEGRATION_CREDENTIALS_INVALID", "The canonical systemd credential could not be read safely.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseTrustedPrincipalProxyCredential(raw) {
  if (raw.includes("\u0000") || raw.includes("\r")) {
    configFail("INTEGRATION_CREDENTIALS_INVALID", "The trusted principal proxy credential has invalid framing.");
  }
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!token || token.includes("\n")) {
    configFail("INTEGRATION_CREDENTIALS_INVALID", "The trusted principal proxy credential must contain one line.");
  }
  try {
    return validateIntegrationBearerToken(token, { field: "trusted principal proxy credential" });
  } catch {
    configFail("INTEGRATION_CREDENTIALS_INVALID", "The trusted principal proxy credential is invalid.");
  }
}

export async function loadIntegrationServiceConfig(filePath = DEFAULT_INTEGRATION_CONFIG_PATH, options = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    configFail("INTEGRATION_PROTECTED_FILE_INVALID", "integration config path must be absolute.");
  }
  const ownerUid = effectiveOwnerUid(options);
  const raw = await readProtectedTextFile(filePath, {
    label: "integration config",
    ownerUid,
    allowRootOwner: options.allowRootOwner !== false,
    minimumBytes: 2,
    maximumBytes: MAX_INTEGRATION_CONFIG_BYTES,
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    configFail("INTEGRATION_CONFIG_INVALID", "integration config is not valid JSON.");
  }
  return validateIntegrationServiceConfig(parsed);
}

export async function loadTrustedPrincipalProxyCredential(...args) {
  if (args.length !== 0) {
    configFail(
      "INTEGRATION_CREDENTIAL_SOURCE_FORBIDDEN",
      "The production credential loader accepts no path, filesystem, or source overrides."
    );
  }
  return parseTrustedPrincipalProxyCredential(await loadCanonicalSystemdCredential());
}

export function createTrustedPrincipalProxyClient(configInput, bearerToken) {
  const config = validateIntegrationServiceConfig(configInput);
  try {
    return createIntegrationClient({
      token: bearerToken,
      clientId: config.trustedPrincipalProxy.clientId,
      label: config.trustedPrincipalProxy.label,
      scopes: config.trustedPrincipalProxy.scopes,
      trustedProxy: true,
    });
  } catch {
    configFail("INTEGRATION_CREDENTIALS_INVALID", "The trusted principal proxy client could not be constructed.");
  }
}

export function publicIntegrationServiceConfig(configInput) {
  const config = validateIntegrationServiceConfig(configInput);
  return Object.freeze({
    schemaVersion: config.schemaVersion,
    capability: config.capability,
    listen: config.listen,
    stateRoot: config.stateRoot,
    trustedPrincipalProxy: Object.freeze({
      clientId: config.trustedPrincipalProxy.clientId,
      label: config.trustedPrincipalProxy.label,
      scopes: config.trustedPrincipalProxy.scopes,
      credentialName: DEFAULT_INTEGRATION_CREDENTIAL_NAME,
    }),
  });
}
