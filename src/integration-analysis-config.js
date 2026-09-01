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
import {
  INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
  INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS,
} from "./integration-grounded-search.js";
import {
  INTEGRATION_DOCUMENT_WORKER_TIMEOUT_MS,
  validateIntegrationDocumentWorkerEndpoint,
} from "./integration-document-worker-client.js";
import { INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES } from "./integration-analysis-state-persistence.js";
import { INTEGRATION_RPC_PATH_LIST, INTEGRATION_RPC_PATHS } from "./integration-policy.js";

export const INTEGRATION_ANALYSIS_SERVICE_CONFIG_SCHEMA_VERSION =
  "aginti-integration-analysis-service-config-v2";
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
export const INTEGRATION_ANALYSIS_GROUNDED_SEARCH_CREDENTIAL_NAME = "localllm-search-token";
export const INTEGRATION_ANALYSIS_DOCUMENT_WORKER_CREDENTIAL_NAME = "document-artifact-edge-token";
export const INTEGRATION_ANALYSIS_TRUSTED_CLIENT_ID = "aginti-bff";
export const INTEGRATION_ANALYSIS_LOCALLLM_CREDENTIAL_PATH =
  `${INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY}/${INTEGRATION_ANALYSIS_LOCALLLM_CREDENTIAL_NAME}`;
export const INTEGRATION_ANALYSIS_GROUNDED_SEARCH_CREDENTIAL_PATH =
  `${INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY}/${INTEGRATION_ANALYSIS_GROUNDED_SEARCH_CREDENTIAL_NAME}`;
export const INTEGRATION_ANALYSIS_DOCUMENT_WORKER_CREDENTIAL_PATH =
  `${INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY}/${INTEGRATION_ANALYSIS_DOCUMENT_WORKER_CREDENTIAL_NAME}`;
export const MAX_INTEGRATION_ANALYSIS_CONFIG_BYTES = 32 * 1024;

const CONFIG_KEYS = Object.freeze([
  "schemaVersion",
  "capability",
  "listen",
  "stateRoot",
  "idempotencyRoot",
  "statePersistence",
  "vision",
  "localModel",
  "groundedSearch",
  "documentWorker",
  "trustedPrincipalProxy",
]);
const REQUIRED_CONFIG_KEYS = Object.freeze(
  CONFIG_KEYS.filter((key) => !new Set(["vision", "groundedSearch", "documentWorker"]).has(key))
);
const CAPABILITY_KEYS = Object.freeze(["enabled", "mode"]);
const LISTEN_KEYS = Object.freeze(["host", "port"]);
const MODEL_KEYS = Object.freeze([
  "baseURL",
  "model",
  "contextWindowTokens",
  "maxOutputTokens",
  "modelTimeoutMs",
]);
const STATE_PERSISTENCE_KEYS = Object.freeze(["mode"]);
const VISION_KEYS = Object.freeze(["enabled"]);
const SEARCH_KEYS = Object.freeze(["enabled", "endpoint", "timeoutMs", "maximumSources"]);
const DOCUMENT_WORKER_KEYS = Object.freeze(["enabled", "endpoint", "timeoutMs"]);
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

function defaultVisionEnabledForStatePersistence(mode) {
  return mode === INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3;
}

export function validateIntegrationAnalysisServiceConfig(value) {
  const config = exactObject(value, CONFIG_KEYS, REQUIRED_CONFIG_KEYS, "analysis integration config");
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
  const statePersistence = exactObject(
    config.statePersistence,
    STATE_PERSISTENCE_KEYS,
    STATE_PERSISTENCE_KEYS,
    "statePersistence"
  );
  if (!Object.values(INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES).includes(statePersistence.mode)) {
    fail("ANALYSIS_CONFIG_INVALID", "statePersistence.mode is invalid.");
  }

  let vision;
  if (config.vision !== undefined) {
    const candidate = exactObject(config.vision, VISION_KEYS, VISION_KEYS, "vision");
    if (typeof candidate.enabled !== "boolean") {
      fail("ANALYSIS_CONFIG_INVALID", "vision.enabled must be a boolean.");
    }
    if (
      candidate.enabled &&
      statePersistence.mode !== INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3
    ) {
      fail("ANALYSIS_CONFIG_INVALID", "Enabled vision requires native-v3 state persistence.");
    }
    vision = Object.freeze({ enabled: candidate.enabled });
  } else {
    vision = Object.freeze({ enabled: defaultVisionEnabledForStatePersistence(statePersistence.mode) });
  }

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

  let groundedSearch;
  if (config.groundedSearch !== undefined) {
    const search = exactObject(
      config.groundedSearch,
      SEARCH_KEYS,
      ["enabled"],
      "groundedSearch"
    );
    if (typeof search.enabled !== "boolean") {
      fail("ANALYSIS_CONFIG_INVALID", "groundedSearch.enabled must be a boolean.");
    }
    if (!search.enabled) {
      if (Reflect.ownKeys(search).length !== 1) {
        fail("ANALYSIS_CONFIG_INVALID", "Disabled groundedSearch may contain only enabled=false.");
      }
      groundedSearch = Object.freeze({ enabled: false });
    } else {
      exactObject(search, SEARCH_KEYS, SEARCH_KEYS, "groundedSearch");
      fixed(search.endpoint, INTEGRATION_GROUNDED_SEARCH_ENDPOINT, "groundedSearch.endpoint");
      fixed(search.timeoutMs, INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS, "groundedSearch.timeoutMs");
      fixed(search.maximumSources, 20, "groundedSearch.maximumSources");
      groundedSearch = Object.freeze({
        enabled: true,
        endpoint: INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
        timeoutMs: INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS,
        maximumSources: 20,
      });
    }
  }

  let documentWorker;
  if (config.documentWorker !== undefined) {
    const worker = exactObject(config.documentWorker, DOCUMENT_WORKER_KEYS, ["enabled"], "documentWorker");
    if (typeof worker.enabled !== "boolean") {
      fail("ANALYSIS_CONFIG_INVALID", "documentWorker.enabled must be a boolean.");
    }
    if (!worker.enabled) {
      if (Reflect.ownKeys(worker).length !== 1) {
        fail("ANALYSIS_CONFIG_INVALID", "Disabled documentWorker may contain only enabled=false.");
      }
      documentWorker = Object.freeze({ enabled: false });
    } else {
      exactObject(worker, DOCUMENT_WORKER_KEYS, DOCUMENT_WORKER_KEYS, "documentWorker");
      let endpoint;
      try {
        endpoint = validateIntegrationDocumentWorkerEndpoint(worker.endpoint);
      } catch {
        fail("ANALYSIS_CONFIG_INVALID", "documentWorker.endpoint must be a private loopback route.");
      }
      fixed(worker.timeoutMs, INTEGRATION_DOCUMENT_WORKER_TIMEOUT_MS, "documentWorker.timeoutMs");
      documentWorker = Object.freeze({
        enabled: true,
        endpoint,
        timeoutMs: INTEGRATION_DOCUMENT_WORKER_TIMEOUT_MS,
      });
    }
  }

  if (
    statePersistence.mode === INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2 &&
    (groundedSearch?.enabled === true || documentWorker?.enabled === true)
  ) {
    fail(
      "ANALYSIS_CONFIG_INVALID",
      "r67-compatible-v2 state persistence forbids grounded Search and document worker activation."
    );
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
    fail("ANALYSIS_CONFIG_INVALID", "trustedPrincipalProxy.clientId is invalid.");
  }
  fixed(clientId, INTEGRATION_ANALYSIS_TRUSTED_CLIENT_ID, "trustedPrincipalProxy.clientId");

  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_SERVICE_CONFIG_SCHEMA_VERSION,
    capability: Object.freeze({ enabled: true, mode: "analysis-execution" }),
    listen: Object.freeze({ host: INTEGRATION_ANALYSIS_LISTEN_HOST, port: INTEGRATION_ANALYSIS_LISTEN_PORT }),
    stateRoot: DEFAULT_INTEGRATION_ANALYSIS_SERVICE_STATE_ROOT,
    idempotencyRoot: DEFAULT_INTEGRATION_ANALYSIS_IDEMPOTENCY_ROOT,
    statePersistence: Object.freeze({ mode: statePersistence.mode }),
    vision,
    localModel: Object.freeze({
      baseURL: INTEGRATION_ANALYSIS_LOCALLLM_BASE_URL,
      model: INTEGRATION_ANALYSIS_LOCALLLM_MODEL,
      contextWindowTokens: INTEGRATION_ANALYSIS_LOCALLLM_CONTEXT_TOKENS,
      maxOutputTokens: INTEGRATION_ANALYSIS_LOCALLLM_OUTPUT_TOKENS,
      modelTimeoutMs: INTEGRATION_ANALYSIS_LOCALLLM_TIMEOUT_MS,
    }),
    ...(groundedSearch === undefined ? {} : { groundedSearch }),
    ...(documentWorker === undefined ? {} : { documentWorker }),
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

function parseIntegrationAnalysisCredential(raw, label) {
  if (typeof raw !== "string" || raw.includes("\u0000") || raw.includes("\r")) {
    fail("ANALYSIS_CREDENTIAL_INVALID", `${label} has invalid framing.`);
  }
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!token || token.includes("\n")) {
    fail("ANALYSIS_CREDENTIAL_INVALID", `${label} must contain exactly one line.`);
  }
  if (token !== token.trim()) {
    fail("ANALYSIS_CREDENTIAL_INVALID", `${label} must not contain leading or trailing whitespace.`);
  }
  try {
    return validateIntegrationBearerToken(token, { field: label });
  } catch {
    fail("ANALYSIS_CREDENTIAL_INVALID", `${label} is invalid.`);
  }
}

function parseIntegrationAnalysisVisibleAsciiCredential(raw, label) {
  if (typeof raw !== "string" || raw.includes("\u0000") || raw.includes("\r")) {
    fail("ANALYSIS_CREDENTIAL_INVALID", `${label} has invalid framing.`);
  }
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!token || token.includes("\n")) {
    fail("ANALYSIS_CREDENTIAL_INVALID", `${label} must contain exactly one line.`);
  }
  if (token !== token.trim()) {
    fail("ANALYSIS_CREDENTIAL_INVALID", `${label} must not contain leading or trailing whitespace.`);
  }
  if (token.length < 16 || Buffer.byteLength(token, "utf8") > 512 || !/^[\x21-\x7e]+$/u.test(token)) {
    fail("ANALYSIS_CREDENTIAL_INVALID", `${label} must use 16-512 visible ASCII characters without whitespace.`);
  }
  return token;
}

export function parseIntegrationAnalysisLocalModelCredential(raw) {
  return parseIntegrationAnalysisCredential(raw, "LocalLLM model credential");
}

export function parseIntegrationAnalysisGroundedSearchCredential(raw) {
  return parseIntegrationAnalysisVisibleAsciiCredential(raw, "LocalLLM search credential");
}

export function parseIntegrationAnalysisDocumentWorkerCredential(raw) {
  return parseIntegrationAnalysisCredential(raw, "document artifact edge credential");
}

async function loadIntegrationAnalysisCredential({ credentialPath, label, parse }) {
  const directory = INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY;
  let handle;
  try {
    let directoryBefore;
    let credentialPathBefore;
    try {
      directoryBefore = await fs.lstat(directory);
      credentialPathBefore = await fs.lstat(credentialPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        fail("ANALYSIS_CREDENTIAL_MISSING", `${label} is not installed.`);
      }
      throw error;
    }
    if (directoryBefore.isSymbolicLink() || credentialPathBefore.isSymbolicLink()) {
      fail("ANALYSIS_CREDENTIAL_INVALID", `${label} path must be canonical and symlink-free.`);
    }
    const [directoryReal, credentialReal] = await Promise.all([
      fs.realpath(directory),
      fs.realpath(credentialPath),
    ]);
    if (
      directoryReal !== directory ||
      credentialReal !== credentialPath
    ) {
      fail("ANALYSIS_CREDENTIAL_INVALID", `${label} path must be canonical and symlink-free.`);
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
      fail("ANALYSIS_CREDENTIAL_CHANGED", `${label} changed before it was read.`);
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
      fail("ANALYSIS_CREDENTIAL_CHANGED", `${label} changed while it was read.`);
    }
    return parse(raw);
  } catch (error) {
    if (error instanceof IntegrationServiceConfigError) throw error;
    fail("ANALYSIS_CREDENTIAL_INVALID", `${label} could not be read safely.`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function isMissingIntegrationAnalysisDocumentWorkerCredentialError(error) {
  return error instanceof IntegrationServiceConfigError && error.code === "ANALYSIS_CREDENTIAL_MISSING";
}

export function isMissingIntegrationAnalysisOptionalCredentialError(error) {
  return error instanceof IntegrationServiceConfigError && error.code === "ANALYSIS_CREDENTIAL_MISSING";
}

export async function loadIntegrationAnalysisLocalModelCredential(...args) {
  if (args.length !== 0) {
    fail(
      "ANALYSIS_CREDENTIAL_SOURCE_FORBIDDEN",
      "LocalLLM model credential source is fixed by systemd LoadCredential."
    );
  }
  return loadIntegrationAnalysisCredential({
    credentialPath: INTEGRATION_ANALYSIS_LOCALLLM_CREDENTIAL_PATH,
    label: "LocalLLM model credential",
    parse: parseIntegrationAnalysisLocalModelCredential,
  });
}

export async function loadIntegrationAnalysisGroundedSearchCredential(...args) {
  if (args.length !== 0) {
    fail(
      "ANALYSIS_CREDENTIAL_SOURCE_FORBIDDEN",
      "LocalLLM search credential source is fixed by systemd LoadCredential."
    );
  }
  return loadIntegrationAnalysisCredential({
    credentialPath: INTEGRATION_ANALYSIS_GROUNDED_SEARCH_CREDENTIAL_PATH,
    label: "LocalLLM search credential",
    parse: parseIntegrationAnalysisGroundedSearchCredential,
  });
}

export async function loadIntegrationAnalysisDocumentWorkerCredential(...args) {
  if (args.length !== 0) {
    fail(
      "ANALYSIS_CREDENTIAL_SOURCE_FORBIDDEN",
      "Document artifact edge credential source is fixed by systemd LoadCredential."
    );
  }
  return loadIntegrationAnalysisCredential({
    credentialPath: INTEGRATION_ANALYSIS_DOCUMENT_WORKER_CREDENTIAL_PATH,
    label: "document artifact edge credential",
    parse: parseIntegrationAnalysisDocumentWorkerCredential,
  });
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
    statePersistence: config.statePersistence,
    ...(config.vision === undefined ? {} : { vision: config.vision }),
    localModel: config.localModel,
    ...(config.groundedSearch === undefined ? {} : { groundedSearch: config.groundedSearch }),
    ...(config.documentWorker === undefined ? {} : { documentWorker: config.documentWorker }),
    trustedPrincipalProxy: Object.freeze({
      clientId: config.trustedPrincipalProxy.clientId,
      label: config.trustedPrincipalProxy.label,
      scopes: config.trustedPrincipalProxy.scopes,
      credentialName: DEFAULT_INTEGRATION_CREDENTIAL_NAME,
    }),
    localModelCredentialName: INTEGRATION_ANALYSIS_LOCALLLM_CREDENTIAL_NAME,
    ...(config.groundedSearch?.enabled === true
      ? { groundedSearchCredentialName: INTEGRATION_ANALYSIS_GROUNDED_SEARCH_CREDENTIAL_NAME }
      : {}),
    ...(config.documentWorker?.enabled === true
      ? { documentWorkerCredentialName: INTEGRATION_ANALYSIS_DOCUMENT_WORKER_CREDENTIAL_NAME }
      : {}),
  });
}
