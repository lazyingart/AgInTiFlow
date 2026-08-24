import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  DEFAULT_INTEGRATION_CREDENTIAL_NAME,
  createIntegrationClient,
  validateIntegrationBearerToken,
  validateIntegrationClientId,
} from "./integration-auth.js";
import {
  INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY,
  IntegrationServiceConfigError,
  validateSystemdCredentialMetadata,
} from "./integration-config.js";
import { INTEGRATION_RPC_PATH_LIST, INTEGRATION_RPC_PATHS } from "./integration-policy.js";

export const INTEGRATION_ANALYSIS_SERVICE_CONFIG_SCHEMA_VERSION =
  "aginti-integration-analysis-service-config-v1";
export const DEFAULT_INTEGRATION_ANALYSIS_CONFIG_PATH = "/etc/agintiflow/integration-analysis.json";
export const DEFAULT_INTEGRATION_ANALYSIS_SERVICE_STATE_ROOT = "/var/lib/agintiflow-integration/analysis";
export const INTEGRATION_ANALYSIS_LISTEN_HOST = "127.0.0.1";
export const INTEGRATION_ANALYSIS_LISTEN_PORT = 18009;
export const DEFAULT_INTEGRATION_ANALYSIS_IDEMPOTENCY_ROOT =
  "/var/lib/agintiflow-integration/analysis-idempotency";
export const INTEGRATION_ANALYSIS_LOCALLLM_BASE_URL = "http://127.0.0.1:18080/v1";
export const INTEGRATION_ANALYSIS_LOCALLLM_MODEL = "localllm-code";
export const INTEGRATION_ANALYSIS_LOCALLLM_CONTEXT_TOKENS = 32_768;
export const INTEGRATION_ANALYSIS_LOCALLLM_OUTPUT_TOKENS = 4_096;
export const INTEGRATION_ANALYSIS_LOCALLLM_TIMEOUT_MS = 180_000;
export const INTEGRATION_ANALYSIS_LOCALLLM_CREDENTIAL_NAME = "localllm-token";
export const INTEGRATION_ANALYSIS_TRUSTED_CLIENT_ID = "aginti-bff";
export const INTEGRATION_ANALYSIS_LOCALLLM_CREDENTIAL_PATH =
  `${INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY}/${INTEGRATION_ANALYSIS_LOCALLLM_CREDENTIAL_NAME}`;
export const MAX_INTEGRATION_ANALYSIS_CONFIG_BYTES = 32 * 1024;

const CONFIG_KEYS = Object.freeze([
  "schemaVersion",
  "capability",
  "listen",
  "stateRoot",
  "idempotencyRoot",
  "localModel",
  "trustedPrincipalProxy",
]);
const CAPABILITY_KEYS = Object.freeze(["enabled", "mode"]);
const LISTEN_KEYS = Object.freeze(["host", "port"]);
const MODEL_KEYS = Object.freeze([
  "baseURL",
  "model",
  "contextWindowTokens",
  "maxOutputTokens",
  "modelTimeoutMs",
]);
const TRUSTED_PROXY_KEYS = Object.freeze(["clientId", "label", "scopes"]);
const RPC_PATH_SET = new Set(INTEGRATION_RPC_PATH_LIST);

function fail(code, message) {
  throw new IntegrationServiceConfigError(code, message);
}

function plainDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowedKeys, requiredKeys, label) {
  if (!plainDataObject(value)) fail("ANALYSIS_CONFIG_INVALID", `${label} must be a plain data object.`);
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("ANALYSIS_CONFIG_INVALID", `${label} contains an unsupported field.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("ANALYSIS_CONFIG_INVALID", `${label}.${key} is required.`);
    }
  }
  return value;
}

function fixed(value, expected, label) {
  if (value !== expected) fail("ANALYSIS_CONFIG_LOCKED", `${label} must use the fixed production value.`);
  return expected;
}

function boundedLabel(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 80 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("ANALYSIS_CONFIG_INVALID", "trustedPrincipalProxy.label is invalid.");
  }
  const label = value.trim();
  if (!label) fail("ANALYSIS_CONFIG_INVALID", "trustedPrincipalProxy.label is invalid.");
  return label;
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > INTEGRATION_RPC_PATH_LIST.length) {
    fail("ANALYSIS_CONFIG_INVALID", "trustedPrincipalProxy.scopes must be a bounded explicit route list.");
  }
  const seen = new Set();
  const scopes = [];
  for (const scope of value) {
    if (typeof scope !== "string" || scope === "*" || !RPC_PATH_SET.has(scope) || seen.has(scope)) {
      fail("ANALYSIS_CONFIG_INVALID", "trustedPrincipalProxy.scopes contains an invalid or duplicate route.");
    }
    seen.add(scope);
    scopes.push(scope);
  }
  if (!seen.has(INTEGRATION_RPC_PATHS.capabilities)) {
    fail("ANALYSIS_CONFIG_INVALID", "trustedPrincipalProxy.scopes must include the capabilities route.");
  }
  return Object.freeze(scopes);
}

export function validateIntegrationAnalysisServiceConfig(value) {
  const config = exactObject(value, CONFIG_KEYS, CONFIG_KEYS, "analysis integration config");
  fixed(
    config.schemaVersion,
    INTEGRATION_ANALYSIS_SERVICE_CONFIG_SCHEMA_VERSION,
    "analysis integration config schemaVersion"
  );
  const capability = exactObject(config.capability, CAPABILITY_KEYS, CAPABILITY_KEYS, "capability");
  fixed(capability.enabled, true, "capability.enabled");
  fixed(capability.mode, "analysis-execution", "capability.mode");
  const listen = exactObject(config.listen, LISTEN_KEYS, LISTEN_KEYS, "listen");
  fixed(listen.host, INTEGRATION_ANALYSIS_LISTEN_HOST, "listen.host");
  fixed(listen.port, INTEGRATION_ANALYSIS_LISTEN_PORT, "listen.port");
  fixed(config.stateRoot, DEFAULT_INTEGRATION_ANALYSIS_SERVICE_STATE_ROOT, "stateRoot");
  fixed(config.idempotencyRoot, DEFAULT_INTEGRATION_ANALYSIS_IDEMPOTENCY_ROOT, "idempotencyRoot");

  const localModel = exactObject(config.localModel, MODEL_KEYS, MODEL_KEYS, "localModel");
  fixed(localModel.baseURL, INTEGRATION_ANALYSIS_LOCALLLM_BASE_URL, "localModel.baseURL");
  fixed(localModel.model, INTEGRATION_ANALYSIS_LOCALLLM_MODEL, "localModel.model");
  fixed(
    localModel.contextWindowTokens,
    INTEGRATION_ANALYSIS_LOCALLLM_CONTEXT_TOKENS,
    "localModel.contextWindowTokens"
  );
  fixed(localModel.maxOutputTokens, INTEGRATION_ANALYSIS_LOCALLLM_OUTPUT_TOKENS, "localModel.maxOutputTokens");
  fixed(localModel.modelTimeoutMs, INTEGRATION_ANALYSIS_LOCALLLM_TIMEOUT_MS, "localModel.modelTimeoutMs");

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
    fail("ANALYSIS_CONFIG_INVALID", "trustedPrincipalProxy.clientId is invalid.");
  }
  fixed(clientId, INTEGRATION_ANALYSIS_TRUSTED_CLIENT_ID, "trustedPrincipalProxy.clientId");

  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_SERVICE_CONFIG_SCHEMA_VERSION,
    capability: Object.freeze({ enabled: true, mode: "analysis-execution" }),
    listen: Object.freeze({ host: INTEGRATION_ANALYSIS_LISTEN_HOST, port: INTEGRATION_ANALYSIS_LISTEN_PORT }),
    stateRoot: DEFAULT_INTEGRATION_ANALYSIS_SERVICE_STATE_ROOT,
    idempotencyRoot: DEFAULT_INTEGRATION_ANALYSIS_IDEMPOTENCY_ROOT,
    localModel: Object.freeze({
      baseURL: INTEGRATION_ANALYSIS_LOCALLLM_BASE_URL,
      model: INTEGRATION_ANALYSIS_LOCALLLM_MODEL,
      contextWindowTokens: INTEGRATION_ANALYSIS_LOCALLLM_CONTEXT_TOKENS,
      maxOutputTokens: INTEGRATION_ANALYSIS_LOCALLLM_OUTPUT_TOKENS,
      modelTimeoutMs: INTEGRATION_ANALYSIS_LOCALLLM_TIMEOUT_MS,
    }),
    trustedPrincipalProxy: Object.freeze({
      clientId,
      label: boundedLabel(proxy.label),
      scopes: normalizeScopes(proxy.scopes),
    }),
  });
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

async function readProtectedConfig(filePath, options = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    fail("ANALYSIS_CONFIG_FILE_INVALID", "Analysis integration config path must be canonical and absolute.");
  }
  const ownerUid = Number(
    options.ownerUid ?? (typeof process.geteuid === "function" ? process.geteuid() : process.getuid?.() ?? 0)
  );
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    fail("ANALYSIS_CONFIG_FILE_INVALID", "Analysis integration config owner is invalid.");
  }
  let handle;
  try {
    const [realPath, beforePath] = await Promise.all([fs.realpath(filePath), fs.lstat(filePath)]);
    if (
      realPath !== filePath ||
      beforePath.isSymbolicLink() ||
      !beforePath.isFile() ||
      beforePath.nlink !== 1 ||
      !new Set(options.allowRootOwner === false ? [ownerUid] : [0, ownerUid]).has(beforePath.uid) ||
      ((beforePath.mode & 0o777) & 0o077) !== 0 ||
      beforePath.size < 2 ||
      beforePath.size > MAX_INTEGRATION_ANALYSIS_CONFIG_BYTES
    ) {
      fail("ANALYSIS_CONFIG_FILE_INVALID", "Analysis integration config is not a protected regular file.");
    }
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY |
        Number(fsConstants.O_NOFOLLOW || 0) |
        Number(fsConstants.O_NONBLOCK || 0) |
        Number(fsConstants.O_CLOEXEC || 0)
    );
    const before = await handle.stat();
    if (!sameFileSnapshot(beforePath, before)) {
      fail("ANALYSIS_CONFIG_FILE_CHANGED", "Analysis integration config changed before it was read.");
    }
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    const afterPath = await fs.lstat(filePath);
    if (
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(after, afterPath) ||
      Buffer.byteLength(text, "utf8") !== after.size
    ) {
      fail("ANALYSIS_CONFIG_FILE_CHANGED", "Analysis integration config changed while it was read.");
    }
    return text;
  } catch (error) {
    if (error instanceof IntegrationServiceConfigError) throw error;
    fail("ANALYSIS_CONFIG_FILE_INVALID", "Analysis integration config could not be read safely.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function loadIntegrationAnalysisServiceConfig(
  filePath = DEFAULT_INTEGRATION_ANALYSIS_CONFIG_PATH,
  options = {}
) {
  const text = await readProtectedConfig(filePath, options);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("ANALYSIS_CONFIG_INVALID", "Analysis integration config is not valid JSON.");
  }
  return validateIntegrationAnalysisServiceConfig(parsed);
}

function credentialMetadata(stat, kind) {
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

export function parseIntegrationAnalysisLocalModelCredential(raw) {
  if (typeof raw !== "string" || raw.includes("\u0000") || raw.includes("\r")) {
    fail("ANALYSIS_CREDENTIAL_INVALID", "LocalLLM credential has invalid framing.");
  }
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!token || token.includes("\n")) {
    fail("ANALYSIS_CREDENTIAL_INVALID", "LocalLLM credential must contain exactly one line.");
  }
  try {
    return validateIntegrationBearerToken(token, { field: "LocalLLM credential" });
  } catch {
    fail("ANALYSIS_CREDENTIAL_INVALID", "LocalLLM credential is invalid.");
  }
}

export async function loadIntegrationAnalysisLocalModelCredential(...args) {
  if (args.length !== 0) {
    fail("ANALYSIS_CREDENTIAL_SOURCE_FORBIDDEN", "LocalLLM credential source is fixed by systemd LoadCredential.");
  }
  const directory = INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY;
  const credentialPath = INTEGRATION_ANALYSIS_LOCALLLM_CREDENTIAL_PATH;
  let handle;
  try {
    const [directoryReal, directoryBefore, credentialReal, credentialPathBefore] = await Promise.all([
      fs.realpath(directory),
      fs.lstat(directory),
      fs.realpath(credentialPath),
      fs.lstat(credentialPath),
    ]);
    if (
      directoryReal !== directory ||
      credentialReal !== credentialPath ||
      directoryBefore.isSymbolicLink() ||
      credentialPathBefore.isSymbolicLink()
    ) {
      fail("ANALYSIS_CREDENTIAL_INVALID", "LocalLLM credential path must be canonical and symlink-free.");
    }
    validateSystemdCredentialMetadata({
      directory: credentialMetadata(directoryBefore, "directory"),
      credential: credentialMetadata(credentialPathBefore, "credential"),
    });
    handle = await fs.open(
      credentialPath,
      fsConstants.O_RDONLY |
        Number(fsConstants.O_NOFOLLOW || 0) |
        Number(fsConstants.O_NONBLOCK || 0) |
        Number(fsConstants.O_CLOEXEC || 0)
    );
    const before = await handle.stat();
    if (!sameFileSnapshot(credentialPathBefore, before)) {
      fail("ANALYSIS_CREDENTIAL_CHANGED", "LocalLLM credential changed before it was read.");
    }
    const raw = await handle.readFile("utf8");
    const after = await handle.stat();
    const [afterPath, directoryAfter, directoryRealAfter, credentialRealAfter] = await Promise.all([
      fs.lstat(credentialPath),
      fs.lstat(directory),
      fs.realpath(directory),
      fs.realpath(credentialPath),
    ]);
    if (
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(after, afterPath) ||
      !sameFileSnapshot(directoryBefore, directoryAfter) ||
      directoryRealAfter !== directory ||
      credentialRealAfter !== credentialPath ||
      Buffer.byteLength(raw, "utf8") !== after.size
    ) {
      fail("ANALYSIS_CREDENTIAL_CHANGED", "LocalLLM credential changed while it was read.");
    }
    return parseIntegrationAnalysisLocalModelCredential(raw);
  } catch (error) {
    if (error instanceof IntegrationServiceConfigError) throw error;
    fail("ANALYSIS_CREDENTIAL_INVALID", "LocalLLM credential could not be read safely.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function createIntegrationAnalysisTrustedProxyClient(configInput, bearerToken) {
  const config = validateIntegrationAnalysisServiceConfig(configInput);
  try {
    return createIntegrationClient({
      token: bearerToken,
      clientId: config.trustedPrincipalProxy.clientId,
      label: config.trustedPrincipalProxy.label,
      scopes: config.trustedPrincipalProxy.scopes,
      trustedProxy: true,
    });
  } catch {
    fail("ANALYSIS_CREDENTIAL_INVALID", "Trusted principal proxy credential is invalid.");
  }
}

export function publicIntegrationAnalysisServiceConfig(configInput) {
  const config = validateIntegrationAnalysisServiceConfig(configInput);
  return Object.freeze({
    schemaVersion: config.schemaVersion,
    capability: config.capability,
    listen: config.listen,
    stateRoot: config.stateRoot,
    idempotencyRoot: config.idempotencyRoot,
    localModel: config.localModel,
    trustedPrincipalProxy: Object.freeze({
      clientId: config.trustedPrincipalProxy.clientId,
      label: config.trustedPrincipalProxy.label,
      scopes: config.trustedPrincipalProxy.scopes,
      credentialName: DEFAULT_INTEGRATION_CREDENTIAL_NAME,
    }),
    localModelCredentialName: INTEGRATION_ANALYSIS_LOCALLLM_CREDENTIAL_NAME,
  });
}
