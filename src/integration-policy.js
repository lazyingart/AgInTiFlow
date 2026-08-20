import crypto from "node:crypto";
import { isLocalLLMBaseURL } from "./provider-contract.js";

export const AGENT_WORKER_SCHEMA_VERSION = "1";
export const INTEGRATION_API_PREFIX = "/agent/v1";
export const INTEGRATION_POLICY_ID = "localllm-docker-workspace-netless-v1";
export const DEFAULT_INTEGRATION_LOCALLLM_BASE_URL = "http://127.0.0.1:8008/v1";
export const DEFAULT_INTEGRATION_ROUTE_MODEL = "localllm-fast";
export const DEFAULT_INTEGRATION_MAIN_MODEL = "localllm-deep";
export const DEFAULT_INTEGRATION_SPARE_MODEL = "localllm-deep";
export const DEFAULT_INTEGRATION_CONTEXT_WINDOW_TOKENS = 32768;
export const DEFAULT_INTEGRATION_CONTEXT_TARGET_TOKENS = 24576;
export const DEFAULT_INTEGRATION_MAX_OUTPUT_TOKENS = 8192;

export const INTEGRATION_RPC_PATHS = Object.freeze({
  capabilities: "/agent/v1/capabilities",
  threadsList: "/agent/v1/threads/list",
  threadsCreate: "/agent/v1/threads/create",
  threadsGet: "/agent/v1/threads/get",
  threadsUpdate: "/agent/v1/threads/update",
  threadsDelete: "/agent/v1/threads/delete",
  runsStart: "/agent/v1/runs/start",
  runsStatus: "/agent/v1/runs/status",
  runsEvents: "/agent/v1/runs/events",
  runsCancel: "/agent/v1/runs/cancel",
  runsResume: "/agent/v1/runs/resume",
  artifactsList: "/agent/v1/artifacts/list",
  artifactsGet: "/agent/v1/artifacts/get",
});

export const INTEGRATION_RPC_PATH_LIST = Object.freeze(Object.values(INTEGRATION_RPC_PATHS));
export const INTEGRATION_ARTIFACT_KINDS = Object.freeze(["plot", "table", "markdown"]);
export const INTEGRATION_RUN_STATUSES = Object.freeze(["starting", "running", "completed", "failed", "cancelled"]);
export const INTEGRATION_THREAD_STATUSES = Object.freeze(["idle", "running", "deleting"]);
export const REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS = Object.freeze([
  "dedicatedInstance",
  "dockerLocal",
  "nonRoot",
  "readOnlyRootfs",
  "capDropAll",
  "noNewPrivileges",
  "seccomp",
  "networkNone",
  "noHostReadMounts",
  "noSharedCaches",
  "cpuLimit",
  "memoryLimit",
  "pidsLimit",
  "wallTimeLimit",
  "diskLimit",
  "dedicatedOutputDir",
  "abortAllContainers",
]);

const RPC_PATH_SET = new Set(INTEGRATION_RPC_PATH_LIST);
const MUTATING_RPC_PATHS = new Set([
  INTEGRATION_RPC_PATHS.threadsCreate,
  INTEGRATION_RPC_PATHS.threadsUpdate,
  INTEGRATION_RPC_PATHS.threadsDelete,
  INTEGRATION_RPC_PATHS.runsStart,
  INTEGRATION_RPC_PATHS.runsCancel,
  INTEGRATION_RPC_PATHS.runsResume,
]);

const ID_PATTERNS = Object.freeze({
  threadId: /^thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  runId: /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  artifactId: /^art_[A-Za-z0-9_-]{32,86}$/u,
  idempotencyKey: /^[A-Za-z0-9._~-]{16,160}$/u,
});
const BROWSER_SESSION_ID_PATTERN = /^[a-f0-9]{64}$/u;
const INTEGRATION_LEDGER_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ZERO_DIGEST = "0".repeat(64);
const BROWSER_SESSION_ID_FIELDS = Object.freeze([
  "browserSessionId",
  "ownerBrowserSessionId",
  "policyBrowserSessionId",
  "initiatingBrowserSessionId",
  "activeBrowserSessionId",
]);
const BROWSER_SESSION_POLICY_FIELDS = Object.freeze(["browserSessionPolicy", "browserSessionBinding"]);

const ArrayIsArray = Array.isArray;
const ArrayPrototypeJoin = Array.prototype.join;
const ArrayPrototypePush = Array.prototype.push;
const ArrayPrototypeSort = Array.prototype.sort;
const JsonStringify = JSON.stringify;
const NumberIsFinite = Number.isFinite;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectKeys = Object.keys;
const ObjectPrototypeHasOwn = Object.prototype.hasOwnProperty;
const ReflectOwnKeys = Reflect.ownKeys;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

export const AGENT_PUBLIC_CAPABILITY_TEMPLATE = Object.freeze({
  schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
  enabled: false,
  agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
  model: Object.freeze({ label: "LocalLLM" }),
  actions: Object.freeze({ cancel: false, resume: false, retry: false }),
  attachments: Object.freeze({ enabled: false }),
  artifacts: Object.freeze({
    kinds: Object.freeze([...INTEGRATION_ARTIFACT_KINDS]),
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
  }),
});

export class IntegrationValidationError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = "IntegrationValidationError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
    this.details = details;
  }
}

export function integrationInvalid(message, { code = "INVALID_REQUEST", status = 400, details = {} } = {}) {
  throw new IntegrationValidationError(code, message, { status, details });
}

export function integrationPlainObject(value, label) {
  const prototype = value && typeof value === "object" ? ObjectGetPrototypeOf(value) : null;
  if (value === null || typeof value !== "object" || ArrayIsArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    integrationInvalid(`${label} must be a plain JSON object`);
  }
  const keys = ObjectKeys(value);
  const ownKeys = ReflectOwnKeys(value);
  if (ownKeys.length !== keys.length) {
    integrationInvalid(`${label} must not contain symbols or non-enumerable fields`);
  }
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (typeof ownKeys[index] !== "string") integrationInvalid(`${label} must not contain symbols or non-enumerable fields`);
  }
  for (const key of keys) {
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !ObjectPrototypeHasOwn.call(descriptor, "value")) {
      integrationInvalid(`${label} must contain only data fields`);
    }
  }
  return value;
}

export function integrationExactKeys(value, allowed, label, required = []) {
  const object = integrationPlainObject(value, label);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) {
      integrationInvalid(`${label} contains unsupported field "${key}"`, { code: "UNSUPPORTED_FIELD" });
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) integrationInvalid(`${label}.${key} is required`);
  }
  return object;
}

export function integrationBoundedInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    integrationInvalid(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function integrationBoundedText(value, label, maximum, { minimum = 0, presentational = false } = {}) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    integrationInvalid(`${label} must contain ${minimum}-${maximum} characters`);
  }
  if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    integrationInvalid(`${label} contains forbidden control characters`);
  }
  if (
    presentational &&
    (/[<>]/u.test(value) ||
      /(?:javascript\s*:|(?:https?|data|file)\s*:\/\/)/iu.test(value) ||
      /(?:^|[\s("'`])\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/|\b)/iu.test(value) ||
      /(?:^|[\s("'`])[A-Za-z]:\\/u.test(value))
  ) {
    integrationInvalid(`${label} may not contain markup, scripts, URLs, or private runtime paths`, {
      code: "UNSAFE_PRESENTATION",
    });
  }
  return value;
}

function strictIdentifier(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) integrationInvalid(`${label} is invalid`);
  return value;
}

export function validateIntegrationThreadId(value) {
  return strictIdentifier(value, "threadId", ID_PATTERNS.threadId);
}

export function validateIntegrationRunId(value) {
  return strictIdentifier(value, "runId", ID_PATTERNS.runId);
}

export function validateIntegrationArtifactId(value) {
  return strictIdentifier(value, "artifactId", ID_PATTERNS.artifactId);
}

export function validateIntegrationIdempotencyKey(value) {
  if (typeof value !== "string" || !ID_PATTERNS.idempotencyKey.test(value)) {
    integrationInvalid("Idempotency-Key must be an opaque 16-160 character identifier", {
      code: "INVALID_IDEMPOTENCY_KEY",
    });
  }
  return value;
}

export function validateIntegrationLedgerHash(value, label = "afterHash") {
  if (typeof value !== "string" || !INTEGRATION_LEDGER_HASH_PATTERN.test(value)) integrationInvalid(`${label} is invalid`);
  return value;
}

function bindingNotFound(label) {
  throw new IntegrationValidationError("NOT_FOUND", `${label} was not found.`, { status: 404 });
}

function inheritedDataDescriptor(value, key, label) {
  if (!value || typeof value !== "object") return null;
  let cursor = value;
  while (cursor && cursor !== Object.prototype) {
    const descriptor = ObjectGetOwnPropertyDescriptor(cursor, key);
    if (descriptor) {
      if (!ObjectPrototypeHasOwn.call(descriptor, "value")) bindingNotFound(label);
      return descriptor;
    }
    cursor = ObjectGetPrototypeOf(cursor);
  }
  return null;
}

function canonicalBrowserPolicyValue(value, label) {
  if (value === undefined || value === null || value === "" || value === false) return "";
  if (value !== "same-browser-session") bindingNotFound(label);
  return value;
}

function canonicalBrowserSessionValue(value, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !BROWSER_SESSION_ID_PATTERN.test(value)) bindingNotFound(label);
  return value;
}

export function validateIntegrationBrowserSessionBinding(value = {}, context = {}, options = {}) {
  const label = options.label || "Resource";
  const requireBound = options.requireBound === true;
  const policies = [];
  for (const field of BROWSER_SESSION_POLICY_FIELDS) {
    const policy = canonicalBrowserPolicyValue(inheritedDataDescriptor(value, field, label)?.value, label);
    if (policy) policies.push(policy);
  }
  if (new Set(policies).size > 1) bindingNotFound(label);

  const sessions = [];
  for (const field of BROWSER_SESSION_ID_FIELDS) {
    const browserSessionId = canonicalBrowserSessionValue(inheritedDataDescriptor(value, field, label)?.value, label);
    if (browserSessionId) sessions.push(browserSessionId);
  }
  const uniqueSessions = new Set(sessions);
  if (uniqueSessions.size > 1) bindingNotFound(label);

  const policy = policies[0] || "";
  const browserSessionId = sessions[0] || "";
  if (policy === "same-browser-session" && !browserSessionId) bindingNotFound(label);
  if (browserSessionId && !policy && requireBound) bindingNotFound(label);
  if (requireBound && (policy !== "same-browser-session" || !browserSessionId)) bindingNotFound(label);
  if (browserSessionId) {
    if (typeof context.browserSessionId !== "string" || !BROWSER_SESSION_ID_PATTERN.test(context.browserSessionId)) {
      bindingNotFound(label);
    }
    if (browserSessionId !== context.browserSessionId) bindingNotFound(label);
  }
  return Object.freeze({ policy, browserSessionId, bound: Boolean(browserSessionId) });
}

export function validateIntegrationRpcPath(pathname = "") {
  const path = String(pathname || "");
  if (!RPC_PATH_SET.has(path)) integrationInvalid("Unknown agent RPC path", { code: "NOT_FOUND", status: 404 });
  return path;
}

export function integrationRpcPathIsMutation(pathname = "") {
  return MUTATING_RPC_PATHS.has(pathname);
}

function validateTitle(value, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  const title = integrationBoundedText(value, "title", 120, { minimum: 1, presentational: true }).trim();
  if (!title) integrationInvalid("title must contain a non-whitespace character");
  return title;
}

function validateInput(value, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  const input = integrationExactKeys(value, ["text"], "input", ["text"]);
  const text = integrationBoundedText(input.text, "input.text", 32_000, { minimum: 1 }).trim();
  if (!text) integrationInvalid("input.text must contain a non-whitespace character");
  return Object.freeze({ text });
}

export function sanitizeIntegrationRequest(pathname, value = {}) {
  const path = validateIntegrationRpcPath(pathname);
  const body = value === undefined ? {} : value;
  switch (path) {
    case INTEGRATION_RPC_PATHS.capabilities:
      integrationExactKeys(body, [], "request");
      return Object.freeze({});
    case INTEGRATION_RPC_PATHS.threadsList: {
      const object = integrationExactKeys(body, ["limit", "before"], "request");
      return Object.freeze({
        limit: object.limit === undefined ? 50 : integrationBoundedInteger(object.limit, "limit", { minimum: 1, maximum: 100 }),
        before: object.before === undefined ? "" : integrationBoundedText(object.before, "before", 128),
      });
    }
    case INTEGRATION_RPC_PATHS.threadsCreate: {
      const object = integrationExactKeys(body, ["title"], "request");
      return Object.freeze({ title: validateTitle(object.title, { optional: true }) || "New agent thread" });
    }
    case INTEGRATION_RPC_PATHS.threadsGet:
    case INTEGRATION_RPC_PATHS.threadsDelete: {
      const object = integrationExactKeys(body, ["threadId"], "request", ["threadId"]);
      return Object.freeze({ threadId: validateIntegrationThreadId(object.threadId) });
    }
    case INTEGRATION_RPC_PATHS.threadsUpdate: {
      const object = integrationExactKeys(body, ["threadId", "title"], "request", ["threadId", "title"]);
      return Object.freeze({
        threadId: validateIntegrationThreadId(object.threadId),
        title: validateTitle(object.title),
      });
    }
    case INTEGRATION_RPC_PATHS.runsStart: {
      const object = integrationExactKeys(body, ["threadId", "input"], "request", ["threadId", "input"]);
      return Object.freeze({
        threadId: validateIntegrationThreadId(object.threadId),
        input: validateInput(object.input),
      });
    }
    case INTEGRATION_RPC_PATHS.runsStatus:
    case INTEGRATION_RPC_PATHS.runsCancel: {
      const object = integrationExactKeys(body, ["runId"], "request", ["runId"]);
      return Object.freeze({ runId: validateIntegrationRunId(object.runId) });
    }
    case INTEGRATION_RPC_PATHS.runsEvents: {
      const object = integrationExactKeys(body, ["runId", "afterSeq", "afterHash"], "request", ["runId", "afterSeq", "afterHash"]);
      const afterSeq = integrationBoundedInteger(object.afterSeq, "afterSeq", { maximum: 10_000_000_000 });
      const afterHash = validateIntegrationLedgerHash(object.afterHash, "afterHash");
      if (afterSeq === 0 && afterHash !== ZERO_DIGEST) integrationInvalid("afterHash must be the zero hash when afterSeq is 0");
      if (afterSeq > 0 && afterHash === ZERO_DIGEST) integrationInvalid("afterHash must be a non-zero ledger hash when afterSeq is non-zero");
      return Object.freeze({
        runId: validateIntegrationRunId(object.runId),
        afterSeq,
        afterHash,
      });
    }
    case INTEGRATION_RPC_PATHS.runsResume: {
      const object = integrationExactKeys(body, ["runId", "input"], "request", ["runId"]);
      const nextInput = validateInput(object.input, { optional: true });
      return Object.freeze({
        runId: validateIntegrationRunId(object.runId),
        ...(nextInput === undefined ? {} : { input: nextInput }),
      });
    }
    case INTEGRATION_RPC_PATHS.artifactsList: {
      const object = integrationExactKeys(body, ["threadId", "runId"], "request");
      if (Boolean(object.threadId) === Boolean(object.runId)) integrationInvalid("Exactly one of threadId or runId is required");
      return Object.freeze({
        threadId: object.threadId ? validateIntegrationThreadId(object.threadId) : "",
        runId: object.runId ? validateIntegrationRunId(object.runId) : "",
      });
    }
    case INTEGRATION_RPC_PATHS.artifactsGet: {
      const object = integrationExactKeys(body, ["artifactId"], "request", ["artifactId"]);
      return Object.freeze({ artifactId: validateIntegrationArtifactId(object.artifactId) });
    }
    default:
      integrationInvalid("Unknown agent RPC path", { code: "NOT_FOUND", status: 404 });
  }
}

export function normalizeIntegrationLocalLLMBaseURL(value = DEFAULT_INTEGRATION_LOCALLLM_BASE_URL) {
  const text = String(value || DEFAULT_INTEGRATION_LOCALLLM_BASE_URL).trim();
  if (!isLocalLLMBaseURL(text)) {
    throw new IntegrationValidationError(
      "POLICY_INVALID",
      "Integration LocalLLM base URL must be a loopback OpenAI-compatible /v1 endpoint.",
      { status: 503 }
    );
  }
  return new URL(text).toString().replace(/\/+$/, "");
}

function assertCanonicalArray(value) {
  if (ObjectGetPrototypeOf(value) !== Array.prototype) {
    integrationInvalid("Canonical JSON rejects arrays with extended prototypes");
  }
  if (!Number.isSafeInteger(value.length) || value.length > 100_000) {
    integrationInvalid("Canonical JSON rejects arrays outside supported bounds");
  }
  const keys = ReflectOwnKeys(value);
  for (const key of keys) {
    if (typeof key !== "string") integrationInvalid("Canonical JSON rejects symbol array fields");
    if (key === "length") continue;
    if (!ARRAY_INDEX_PATTERN.test(key) || Number(key) >= value.length) {
      integrationInvalid("Canonical JSON rejects arrays with extended fields");
    }
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !ObjectPrototypeHasOwn.call(descriptor, "value")) {
      integrationInvalid("Canonical JSON rejects accessor array fields");
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!ObjectPrototypeHasOwn.call(value, String(index))) {
      integrationInvalid("Canonical JSON rejects sparse arrays");
    }
  }
}

function assertCanonicalObject(value) {
  const prototype = ObjectGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    integrationInvalid("Canonical JSON rejects extended objects");
  }
  const keys = ObjectKeys(value);
  const ownKeys = ReflectOwnKeys(value);
  if (ownKeys.length !== keys.length) {
    integrationInvalid("Canonical JSON rejects symbols or non-enumerable object fields");
  }
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (typeof ownKeys[index] !== "string") integrationInvalid("Canonical JSON rejects symbols or non-enumerable object fields");
  }
  for (const key of keys) {
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !ObjectPrototypeHasOwn.call(descriptor, "value")) {
      integrationInvalid("Canonical JSON rejects accessor object fields");
    }
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JsonStringify(value);
  if (typeof value === "number") {
    if (!NumberIsFinite(value)) integrationInvalid("Canonical JSON does not accept non-finite numbers");
    return JsonStringify(value);
  }
  if (ArrayIsArray(value)) {
    assertCanonicalArray(value);
    const items = [];
    for (let index = 0; index < value.length; index += 1) ArrayPrototypePush.call(items, canonicalJson(value[index]));
    return `[${ArrayPrototypeJoin.call(items, ",")}]`;
  }
  if (value && typeof value === "object") {
    assertCanonicalObject(value);
    const keys = ArrayPrototypeSort.call(ObjectKeys(value));
    const entries = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      ArrayPrototypePush.call(entries, `${JsonStringify(key)}:${canonicalJson(value[key])}`);
    }
    return `{${ArrayPrototypeJoin.call(entries, ",")}}`;
  }
  integrationInvalid("Canonical JSON accepts only JSON values");
}

export function contractDigest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function integrationPolicyFingerprint(policy) {
  return contractDigest(policy);
}

export function buildFixedIntegrationPolicy(options = {}) {
  const localLLMBaseURL = normalizeIntegrationLocalLLMBaseURL(options.localLLMBaseURL);
  if (localLLMBaseURL !== DEFAULT_INTEGRATION_LOCALLLM_BASE_URL) {
    throw new IntegrationValidationError("POLICY_INVALID", "Integration policy LocalLLM base URL is fixed.", {
      status: 503,
    });
  }
  const routeModel = String(options.routeModel || DEFAULT_INTEGRATION_ROUTE_MODEL).trim();
  const mainModel = String(options.mainModel || DEFAULT_INTEGRATION_MAIN_MODEL).trim();
  const spareModel = String(options.spareModel || DEFAULT_INTEGRATION_SPARE_MODEL).trim();
  if (
    routeModel !== DEFAULT_INTEGRATION_ROUTE_MODEL ||
    mainModel !== DEFAULT_INTEGRATION_MAIN_MODEL ||
    spareModel !== DEFAULT_INTEGRATION_SPARE_MODEL
  ) {
    throw new IntegrationValidationError("POLICY_INVALID", "Integration policy models are fixed.", { status: 503 });
  }
  const runtime = Object.freeze({
    provider: "localllm",
    routeProvider: "localllm",
    mainProvider: "localllm",
    spareProvider: "localllm",
    model: mainModel,
    routeModel,
    mainModel,
    spareModel,
    baseURL: localLLMBaseURL,
    routingMode: "smart",
    allowShellTool: true,
    allowFileTools: true,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    allowHostedImagePerception: false,
    allowHostedWebResearch: false,
    allowHostedJsonSpecialist: false,
    allowHostedWritingSpecialist: false,
    allowAgentLinkTools: false,
    allowCoordinationTools: false,
    allowBrowserTools: false,
    allowCanvasTools: false,
    allowPasswords: false,
    allowDestructive: false,
    allowOutsideWorkspaceFileTools: false,
    useDockerSandbox: true,
    sandboxMode: "docker-workspace",
    packageInstallPolicy: "block",
    workspaceWritePolicy: "allow",
    dockerNetwork: "none",
    allowedDomains: Object.freeze([]),
    readOnlyRoots: Object.freeze([]),
    readOnlyHostMounts: Object.freeze([]),
    contextBudgetMode: "auto",
    contextWindowTokens: DEFAULT_INTEGRATION_CONTEXT_WINDOW_TOKENS,
    contextBudgetTargetTokens: DEFAULT_INTEGRATION_CONTEXT_TARGET_TOKENS,
    maxOutputTokens: DEFAULT_INTEGRATION_MAX_OUTPUT_TOKENS,
  });
  const policy = {
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    id: INTEGRATION_POLICY_ID,
    owner: "aginti",
    localLLMBaseURL,
    runtime,
    disabledCapabilities: Object.freeze({
      hostedProviders: true,
      wrapperTools: true,
      auxiliaryTools: true,
      mcpTools: true,
      webSearch: true,
      browserTools: true,
      agentLink: true,
      hostMounts: true,
      dockerNetwork: true,
      packageInstalls: true,
    }),
  };
  return Object.freeze({
    ...policy,
    fingerprint: integrationPolicyFingerprint(policy),
  });
}

export function assertFixedIntegrationPolicy(policy = {}) {
  if (policy.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION || policy.id !== INTEGRATION_POLICY_ID) {
    throw new IntegrationValidationError("POLICY_INVALID", "Integration policy is not the fixed LocalLLM policy.", {
      status: 503,
    });
  }
  const runtime = policy.runtime || {};
  const { fingerprint, ...fingerprintedPolicy } = policy;
  if (typeof fingerprint !== "string" || fingerprint !== integrationPolicyFingerprint(fingerprintedPolicy)) {
    throw new IntegrationValidationError("POLICY_INVALID", "Integration policy fingerprint is invalid.", {
      status: 503,
    });
  }
  for (const field of ["provider", "routeProvider", "mainProvider", "spareProvider"]) {
    if (runtime[field] !== "localllm") {
      throw new IntegrationValidationError("POLICY_INVALID", `Integration policy ${field} must be localllm.`, {
        status: 503,
      });
    }
  }
  if (!isLocalLLMBaseURL(runtime.baseURL || policy.localLLMBaseURL)) {
    throw new IntegrationValidationError("POLICY_INVALID", "Integration LocalLLM endpoint is not loopback /v1.", {
      status: 503,
    });
  }
  if (
    policy.owner !== "aginti" ||
    policy.localLLMBaseURL !== DEFAULT_INTEGRATION_LOCALLLM_BASE_URL ||
    runtime.baseURL !== DEFAULT_INTEGRATION_LOCALLLM_BASE_URL ||
    runtime.routeModel !== DEFAULT_INTEGRATION_ROUTE_MODEL ||
    runtime.mainModel !== DEFAULT_INTEGRATION_MAIN_MODEL ||
    runtime.spareModel !== DEFAULT_INTEGRATION_SPARE_MODEL ||
    runtime.model !== DEFAULT_INTEGRATION_MAIN_MODEL
  ) {
    throw new IntegrationValidationError("POLICY_INVALID", "Integration policy does not match the fixed LocalLLM profile.", {
      status: 503,
    });
  }
  for (const disabled of [
    "allowWrapperTools",
    "allowAuxiliaryTools",
    "allowWebSearch",
    "allowMcpTools",
    "allowParallelScouts",
    "allowHostedImagePerception",
    "allowHostedWebResearch",
    "allowHostedJsonSpecialist",
    "allowHostedWritingSpecialist",
    "allowAgentLinkTools",
    "allowCoordinationTools",
    "allowBrowserTools",
    "allowCanvasTools",
    "allowPasswords",
    "allowDestructive",
    "allowOutsideWorkspaceFileTools",
  ]) {
    if (runtime[disabled] !== false) {
      throw new IntegrationValidationError("POLICY_INVALID", `Integration policy must disable ${disabled}.`, {
        status: 503,
      });
    }
  }
  if (runtime.useDockerSandbox !== true || runtime.sandboxMode !== "docker-workspace") {
    throw new IntegrationValidationError("POLICY_INVALID", "Integration policy must use docker-workspace.", {
      status: 503,
    });
  }
  if (runtime.packageInstallPolicy !== "block" || runtime.dockerNetwork !== "none") {
    throw new IntegrationValidationError(
      "POLICY_INVALID",
      "Integration policy must block package installs and Docker network.",
      { status: 503 }
    );
  }
  if (
    runtime.allowWebSearch !== false ||
    runtime.allowMcpTools !== false ||
    (Array.isArray(runtime.readOnlyRoots) && runtime.readOnlyRoots.length > 0) ||
    (Array.isArray(runtime.readOnlyHostMounts) && runtime.readOnlyHostMounts.length > 0) ||
    (Array.isArray(runtime.allowedDomains) && runtime.allowedDomains.length > 0)
  ) {
    throw new IntegrationValidationError(
      "POLICY_INVALID",
      "Integration policy must not include host mounts, read-only roots, web routes, MCP, or allowed domains.",
      { status: 503 }
    );
  }
  return policy;
}

export function buildFixedIntegrationRuntimeOverrides(policy = buildFixedIntegrationPolicy(), options = {}) {
  assertFixedIntegrationPolicy(policy);
  return Object.freeze({
    ...policy.runtime,
    sessionId: String(options.sessionId || "").trim(),
    ...(options.localLLMApiKey ? { apiKey: String(options.localLLMApiKey) } : {}),
    integrationPolicyLock: policy.id,
    integrationPolicyFingerprint: policy.fingerprint,
  });
}

export function validateIntegrationIsolationAttestation(value) {
  const attestation = integrationExactKeys(
    value,
    ["profileVersion", "profileDigest", ...REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS],
    "isolation attestation",
    ["profileVersion", "profileDigest", ...REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS]
  );
  integrationBoundedText(attestation.profileVersion, "isolation attestation profileVersion", 64, { minimum: 1 });
  if (typeof attestation.profileDigest !== "string" || !/^[a-f0-9]{64}$/u.test(attestation.profileDigest)) {
    integrationInvalid("isolation attestation profileDigest must be a lowercase SHA-256 digest");
  }
  const missing = REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS.filter((key) => attestation[key] !== true);
  return Object.freeze({
    ok: missing.length === 0,
    missing: Object.freeze(missing),
    profileVersion: attestation.profileVersion,
    profileDigest: attestation.profileDigest,
  });
}

export function integrationCapabilitiesResponse({ enabled = false, cancel = false, resume = false } = {}) {
  return Object.freeze({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    enabled: Boolean(enabled),
    agent: Object.freeze({ kind: "aginti", label: "AgInTi Agent" }),
    model: Object.freeze({ label: "LocalLLM" }),
    actions: Object.freeze({
      cancel: Boolean(enabled && cancel),
      resume: Boolean(enabled && resume),
      retry: false,
    }),
    attachments: Object.freeze({ enabled: false }),
    artifacts: Object.freeze({
      kinds: Object.freeze([...INTEGRATION_ARTIFACT_KINDS]),
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    }),
  });
}
