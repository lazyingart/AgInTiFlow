import { BASELINE_PROVIDER, normalizeProviderId, providerContract } from "./provider-contract.js";
import { ROUTING_MODES, REASONING_EFFORTS } from "./model-routing.js";
import { permissionModeDefaults } from "./permission-modes.js";
import { TASK_PROFILES } from "./task-profiles.js";
import { WRAPPER_NAMES } from "./tool-wrappers.js";

export const SESSION_RUNTIME_SCHEMA_VERSION = 1;
export const SESSION_RUNTIME_CONFLICT = "SESSION_RUNTIME_CONFLICT";

const EXECUTION_TIERS = new Set(["focused", "thorough"]);
const SCS_MODES = new Set(["off", "on", "auto"]);
const SCS_VALIDATION_MODES = new Set(["auto", "model", "deterministic"]);
const DYNAMIC_STEP_MODES = new Set(["off", "on", "auto"]);
const PERMISSION_MODES = new Set(["safe", "normal", "danger"]);
const SANDBOX_MODES = new Set(["host", "docker-readonly", "docker-workspace"]);
const PACKAGE_INSTALL_POLICIES = new Set(["block", "prompt", "allow"]);
const WORKSPACE_WRITE_POLICIES = new Set(["prompt", "allow"]);
const CONTEXT_BUDGET_MODES = new Set(["off", "on", "auto"]);
const LANGUAGES = new Set(["", "en", "ja", "zh-Hans", "zh-Hant", "ko", "fr", "es", "ar", "vi", "de", "ru"]);
const WRAPPERS = new Set(WRAPPER_NAMES);
const AUXILIARY_PROVIDERS = new Set(["grsai", "venice", "venice-image"]);

const BOOLEAN_FIELDS = Object.freeze([
  "headless",
  "allowShellTool",
  "allowFileTools",
  "allowWrapperTools",
  "allowAuxiliaryTools",
  "allowWebSearch",
  "allowMcpTools",
  "allowParallelScouts",
  "allowHostedImagePerception",
  "allowHostedWebResearch",
  "allowHostedJsonSpecialist",
  "allowHostedWritingSpecialist",
  "allowPasswords",
  "allowDestructive",
  "allowOutsideWorkspaceFileTools",
  "useDockerSandbox",
]);

const NUMBER_FIELDS = Object.freeze({
  maxSteps: { min: 1, max: 512, integer: true },
  dynamicStepExtensionLimit: { min: 0, max: 8, integer: true },
  dynamicStepHardCap: { min: 0, max: 4096, integer: true },
  dynamicStepExtensionSize: { min: 0, max: 512, integer: true },
  parallelScoutCount: { min: 1, max: 10, integer: true },
  contextBudgetChars: { min: 0, max: 50_000_000, integer: true },
  contextBudgetTargetChars: { min: 0, max: 50_000_000, integer: true },
  contextWindowTokens: { min: 0, max: 262_144, integer: true },
  maxOutputTokens: { min: 0, max: 8_192, integer: true },
  contextToolReserveTokens: { min: 0, max: 16_384, integer: true },
  contextBudgetTargetTokens: { min: 0, max: 2_000_000, integer: true },
});

const DEFAULTS = Object.freeze({
  routingMode: "smart",
  reasoning: "",
  routeReasoning: "",
  mainReasoning: "",
  preferredWrapper: "codex",
  wrapperModel: "gpt-5.5",
  wrapperReasoning: "medium",
  auxiliaryProvider: "grsai",
  auxiliaryModel: "nano-banana-2",
  taskProfile: "auto",
  language: "",
  executionTier: "focused",
  enableScs: "auto",
  scsValidationMode: "auto",
  maxSteps: 24,
  dynamicSteps: "auto",
  dynamicStepExtensionLimit: 3,
  dynamicStepHardCap: 0,
  dynamicStepExtensionSize: 0,
  headless: false,
  allowShellTool: true,
  allowFileTools: true,
  allowWrapperTools: false,
  allowAuxiliaryTools: false,
  allowWebSearch: true,
  allowMcpTools: true,
  allowParallelScouts: false,
  allowHostedImagePerception: false,
  allowHostedWebResearch: false,
  allowHostedJsonSpecialist: false,
  allowHostedWritingSpecialist: false,
  parallelScoutCount: 3,
  permissionMode: "normal",
  sandboxMode: "docker-workspace",
  packageInstallPolicy: "allow",
  workspaceWritePolicy: "allow",
  allowPasswords: false,
  allowDestructive: false,
  allowOutsideWorkspaceFileTools: false,
  useDockerSandbox: true,
  contextBudgetMode: "auto",
  contextBudgetChars: 180_000,
  contextBudgetTargetChars: 0,
  contextWindowTokens: 32_768,
  maxOutputTokens: 8_192,
  contextToolReserveTokens: 4_096,
  contextBudgetTargetTokens: 0,
  commandCwd: "",
  allowedDomains: Object.freeze([]),
  readOnlyRoots: Object.freeze([]),
});

export const SESSION_RUNTIME_FIELDS = Object.freeze([
  "provider",
  "model",
  "routingMode",
  "reasoning",
  "routeProvider",
  "routeModel",
  "routeReasoning",
  "mainProvider",
  "mainModel",
  "mainReasoning",
  "spareProvider",
  "spareModel",
  "spareReasoning",
  "preferredWrapper",
  "wrapperModel",
  "wrapperReasoning",
  "auxiliaryProvider",
  "auxiliaryModel",
  "taskProfile",
  "language",
  "executionTier",
  "enableScs",
  "scsValidationMode",
  "maxSteps",
  "dynamicSteps",
  "dynamicStepExtensionLimit",
  "dynamicStepHardCap",
  "dynamicStepExtensionSize",
  ...BOOLEAN_FIELDS.slice(0, 8),
  "parallelScoutCount",
  "permissionMode",
  "sandboxMode",
  "packageInstallPolicy",
  "workspaceWritePolicy",
  ...BOOLEAN_FIELDS.slice(8),
  "contextBudgetMode",
  "contextBudgetChars",
  "contextBudgetTargetChars",
  "contextWindowTokens",
  "maxOutputTokens",
  "contextToolReserveTokens",
  "contextBudgetTargetTokens",
  "commandCwd",
  "allowedDomains",
  "readOnlyRoots",
]);

const RUNTIME_FIELD_SET = new Set(SESSION_RUNTIME_FIELDS);

export class SessionRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = code === SESSION_RUNTIME_CONFLICT ? "SessionRuntimeConflictError" : "SessionRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export class SessionRuntimeConflictError extends SessionRuntimeError {
  constructor(expectedRevision, actualRevision) {
    super(
      SESSION_RUNTIME_CONFLICT,
      `Session runtime revision conflict: expected ${String(expectedRevision)}, current revision is ${actualRevision}.`,
      { expectedRevision, actualRevision }
    );
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(field, reason) {
  throw new SessionRuntimeError(
    field.toLowerCase().includes("provider") ? "SESSION_RUNTIME_INVALID_PROVIDER" : "SESSION_RUNTIME_INVALID_FIELD",
    `Invalid session runtime field "${field}": ${reason}.`,
    { field }
  );
}

function positiveRevision(value, field = "revision") {
  const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new SessionRuntimeError("SESSION_RUNTIME_INVALID_REVISION", `${field} must be a positive safe integer.`, {
      field,
    });
  }
  return number;
}

function safeProvider(value, field, fallback = "") {
  if (value === undefined || value === null || value === "") {
    if (fallback) return fallback;
    invalid(field, "provider id is required");
  }
  if (typeof value !== "string") invalid(field, "expected a provider id string");
  const raw = value.trim();
  if (!raw && fallback) return fallback;
  const provider = normalizeProviderId(raw, "");
  if (!provider) invalid(field, "unknown provider id");
  return provider;
}

function safeString(value, field, { fallback = "", maxLength = 512, allowEmpty = true } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") invalid(field, "expected a string");
  const text = value.trim();
  if (!allowEmpty && !text) invalid(field, "must not be empty");
  if (text.length > maxLength) invalid(field, `must be at most ${maxLength} characters`);
  if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) invalid(field, "contains control characters");
  return text;
}

function safeStringArray(value, field, { fallback = [], maxItems = 128, maxLength = 512 } = {}) {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) invalid(field, "expected an array of strings");
  if (value.length > maxItems) invalid(field, `must contain at most ${maxItems} entries`);
  return value.map((item, index) =>
    safeString(item, `${field}[${index}]`, { allowEmpty: false, maxLength })
  );
}

function safeEnum(value, field, allowed, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") invalid(field, "expected a string");
  const text = value.trim();
  if (!allowed.has(text)) invalid(field, `unsupported value "${text}"`);
  return text;
}

function safeBoolean(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") invalid(field, "expected a boolean");
  return value;
}

function safeNumber(value, field, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field, "expected a finite number");
  const spec = NUMBER_FIELDS[field];
  if (spec.integer && !Number.isInteger(value)) invalid(field, "expected an integer");
  if (value < spec.min || value > spec.max) invalid(field, `must be between ${spec.min} and ${spec.max}`);
  return value;
}

function safeTaskProfile(value, fallback = DEFAULTS.taskProfile) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") invalid("taskProfile", "expected a string");
  const profile = value.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(TASK_PROFILES, profile)) invalid("taskProfile", `unknown task profile "${profile}"`);
  return profile;
}

function safeReasoning(value, field, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") invalid(field, "expected a string");
  const reasoning = value.trim().toLowerCase();
  if (!REASONING_EFFORTS.includes(reasoning)) invalid(field, `unsupported reasoning effort "${reasoning}"`);
  return reasoning;
}

function roleValue(config, role, field) {
  const directName = `${role}${field[0].toUpperCase()}${field.slice(1)}`;
  if (config?.[directName] !== undefined) return config[directName];
  return config?.modelRoles?.[role]?.[field];
}

function defaultModel(provider) {
  return providerContract(provider).defaultModel || "";
}

function canonicalSnapshot(config = {}, revision = 1) {
  if (!isPlainObject(config)) {
    throw new SessionRuntimeError("SESSION_RUNTIME_INVALID_FIELD", "Session runtime input must be a plain object.");
  }

  const provider = safeProvider(config.provider || config.requestedProvider || BASELINE_PROVIDER, "provider");
  const model = safeString(config.model, "model", {
    fallback: defaultModel(provider),
    allowEmpty: false,
  });
  const routeProvider = safeProvider(roleValue(config, "route", "provider") || provider, "routeProvider");
  const mainProvider = safeProvider(roleValue(config, "main", "provider") || provider, "mainProvider");
  const spareProvider = safeProvider(roleValue(config, "spare", "provider") || provider, "spareProvider");
  const routeModel = safeString(roleValue(config, "route", "model"), "routeModel", {
    fallback: routeProvider === provider ? model : defaultModel(routeProvider),
    allowEmpty: false,
  });
  const mainModel = safeString(roleValue(config, "main", "model"), "mainModel", {
    fallback: mainProvider === provider ? model : defaultModel(mainProvider),
    allowEmpty: false,
  });
  const spareModel = safeString(roleValue(config, "spare", "model"), "spareModel", {
    fallback: spareProvider === provider ? model : defaultModel(spareProvider),
    allowEmpty: false,
  });

  const snapshot = {
    schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION,
    revision: positiveRevision(revision),
    provider,
    model,
    routingMode: safeEnum(config.routingMode, "routingMode", new Set(ROUTING_MODES), DEFAULTS.routingMode),
    reasoning: safeReasoning(config.reasoning, "reasoning", DEFAULTS.reasoning),
    routeProvider,
    routeModel,
    routeReasoning: safeReasoning(roleValue(config, "route", "reasoning"), "routeReasoning", DEFAULTS.routeReasoning),
    mainProvider,
    mainModel,
    mainReasoning: safeReasoning(roleValue(config, "main", "reasoning"), "mainReasoning", DEFAULTS.mainReasoning),
    spareProvider,
    spareModel,
    spareReasoning: safeReasoning(roleValue(config, "spare", "reasoning"), "spareReasoning", DEFAULTS.mainReasoning),
    preferredWrapper: safeEnum(config.preferredWrapper, "preferredWrapper", WRAPPERS, DEFAULTS.preferredWrapper),
    wrapperModel: safeString(config.wrapperModel || roleValue(config, "wrapper", "model"), "wrapperModel", {
      fallback: DEFAULTS.wrapperModel,
      allowEmpty: false,
    }),
    wrapperReasoning: safeReasoning(
      config.wrapperReasoning ?? roleValue(config, "wrapper", "reasoning"),
      "wrapperReasoning",
      DEFAULTS.wrapperReasoning
    ),
    auxiliaryProvider: safeEnum(
      config.auxiliaryProvider || roleValue(config, "auxiliary", "provider"),
      "auxiliaryProvider",
      AUXILIARY_PROVIDERS,
      DEFAULTS.auxiliaryProvider
    ),
    auxiliaryModel: safeString(config.auxiliaryModel || roleValue(config, "auxiliary", "model"), "auxiliaryModel", {
      fallback: DEFAULTS.auxiliaryModel,
      allowEmpty: false,
    }),
    taskProfile: safeTaskProfile(config.taskProfile),
    language: safeEnum(config.language, "language", LANGUAGES, DEFAULTS.language),
    executionTier: safeEnum(config.executionTier, "executionTier", EXECUTION_TIERS, DEFAULTS.executionTier),
    enableScs: safeEnum(config.enableScs, "enableScs", SCS_MODES, DEFAULTS.enableScs),
    scsValidationMode: safeEnum(
      config.scsValidationMode,
      "scsValidationMode",
      SCS_VALIDATION_MODES,
      DEFAULTS.scsValidationMode
    ),
    maxSteps: safeNumber(config.maxSteps, "maxSteps", DEFAULTS.maxSteps),
    dynamicSteps: safeEnum(config.dynamicSteps, "dynamicSteps", DYNAMIC_STEP_MODES, DEFAULTS.dynamicSteps),
    dynamicStepExtensionLimit: safeNumber(
      config.dynamicStepExtensionLimit,
      "dynamicStepExtensionLimit",
      DEFAULTS.dynamicStepExtensionLimit
    ),
    dynamicStepExtensionLimitExplicit: config.dynamicStepExtensionLimitExplicit === true,
    dynamicStepHardCap: safeNumber(config.dynamicStepHardCap, "dynamicStepHardCap", DEFAULTS.dynamicStepHardCap),
    dynamicStepExtensionSize: safeNumber(config.dynamicStepExtensionSize, "dynamicStepExtensionSize", DEFAULTS.dynamicStepExtensionSize),
  };

  for (const field of BOOLEAN_FIELDS.slice(0, 8)) {
    snapshot[field] = safeBoolean(config[field], field, DEFAULTS[field]);
  }
  snapshot.parallelScoutCount = safeNumber(config.parallelScoutCount, "parallelScoutCount", DEFAULTS.parallelScoutCount);
  snapshot.permissionMode = safeEnum(config.permissionMode, "permissionMode", PERMISSION_MODES, DEFAULTS.permissionMode);
  snapshot.sandboxMode = safeEnum(config.sandboxMode, "sandboxMode", SANDBOX_MODES, DEFAULTS.sandboxMode);
  snapshot.packageInstallPolicy = safeEnum(
    config.packageInstallPolicy,
    "packageInstallPolicy",
    PACKAGE_INSTALL_POLICIES,
    DEFAULTS.packageInstallPolicy
  );
  snapshot.workspaceWritePolicy = safeEnum(
    config.workspaceWritePolicy,
    "workspaceWritePolicy",
    WORKSPACE_WRITE_POLICIES,
    DEFAULTS.workspaceWritePolicy
  );
  for (const field of BOOLEAN_FIELDS.slice(8)) {
    snapshot[field] = safeBoolean(config[field], field, DEFAULTS[field]);
  }
  snapshot.contextBudgetMode = safeEnum(
    config.contextBudgetMode,
    "contextBudgetMode",
    CONTEXT_BUDGET_MODES,
    DEFAULTS.contextBudgetMode
  );
  for (const field of [
    "contextBudgetChars",
    "contextBudgetTargetChars",
    "contextWindowTokens",
    "maxOutputTokens",
    "contextToolReserveTokens",
    "contextBudgetTargetTokens",
  ]) {
    snapshot[field] = safeNumber(config[field], field, DEFAULTS[field]);
  }
  snapshot.commandCwd = safeString(config.commandCwd, "commandCwd", {
    fallback: DEFAULTS.commandCwd,
    maxLength: 4096,
  });
  snapshot.allowedDomains = safeStringArray(config.allowedDomains, "allowedDomains", {
    fallback: DEFAULTS.allowedDomains,
  });
  snapshot.readOnlyRoots = safeStringArray(config.readOnlyRoots, "readOnlyRoots", {
    fallback: DEFAULTS.readOnlyRoots,
    maxItems: 32,
    maxLength: 4096,
  });
  return snapshot;
}

/** Capture the safe, provider-independent runtime choices for a newly created session. */
export function captureSessionRuntime(config = {}, { revision = 1 } = {}) {
  return canonicalSnapshot(config, revision);
}

export const captureInitialSessionRuntime = captureSessionRuntime;

/**
 * Convert an old state.json that only recorded provider/model into schema v1.
 * Route and main are deliberately derived from those saved values, never from
 * current preferences or environment-backed defaults.
 */
export function migrateLegacySessionRuntime(state = {}) {
  if (!isPlainObject(state)) {
    throw new SessionRuntimeError("SESSION_RUNTIME_INVALID_FIELD", "Legacy session state must be a plain object.");
  }
  const provider = safeProvider(state.provider || BASELINE_PROVIDER, "provider");
  const model = safeString(state.model, "model", {
    fallback: defaultModel(provider),
    allowEmpty: false,
  });
  return canonicalSnapshot(
    {
      provider,
      model,
      routingMode: "manual",
      routeProvider: provider,
      routeModel: model,
      mainProvider: provider,
      mainModel: model,
      spareProvider: provider,
      spareModel: model,
      reasoning: state.reasoning,
      routeReasoning: state.reasoning,
      mainReasoning: state.reasoning,
      taskProfile: state.taskProfile,
      language: state.language,
      executionTier: state.meta?.executionPolicy?.tier || state.executionTier,
      commandCwd: state.commandCwd,
    },
    1
  );
}

function normalizeStoredSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    throw new SessionRuntimeError("SESSION_RUNTIME_INVALID_FIELD", "Saved session runtime must be a plain object.");
  }
  if (snapshot.schemaVersion !== SESSION_RUNTIME_SCHEMA_VERSION) {
    throw new SessionRuntimeError(
      "SESSION_RUNTIME_UNSUPPORTED_SCHEMA",
      `Unsupported session runtime schema version ${String(snapshot.schemaVersion)}.`,
      { schemaVersion: snapshot.schemaVersion }
    );
  }
  return canonicalSnapshot(snapshot, positiveRevision(snapshot.revision));
}

export function sessionRuntimeFromState(state = {}) {
  const saved = state?.meta?.runtimeConfig;
  return saved ? normalizeStoredSnapshot(saved) : migrateLegacySessionRuntime(state);
}

/** Return only fields safe to feed back through resolveRuntimeConfig. */
export function sessionRuntimeOverrides(snapshot) {
  const normalized = normalizeStoredSnapshot(snapshot);
  return Object.fromEntries(SESSION_RUNTIME_FIELDS.map((field) => [field, normalized[field]]));
}

function validatePatchField(field, value, current) {
  if (["provider", "routeProvider", "mainProvider", "spareProvider"].includes(field)) return safeProvider(value, field);
  if (["model", "routeModel", "mainModel", "spareModel"].includes(field)) {
    return safeString(value, field, { allowEmpty: false });
  }
  if (["reasoning", "routeReasoning", "mainReasoning", "spareReasoning"].includes(field)) return safeReasoning(value, field);
  if (field === "preferredWrapper") return safeEnum(value, field, WRAPPERS, current[field]);
  if (field === "auxiliaryProvider") return safeEnum(value, field, AUXILIARY_PROVIDERS, current[field]);
  if (["wrapperModel", "auxiliaryModel"].includes(field)) return safeString(value, field, { allowEmpty: false });
  if (field === "wrapperReasoning") return safeReasoning(value, field);
  if (field === "routingMode") return safeEnum(value, field, new Set(ROUTING_MODES), current[field]);
  if (field === "taskProfile") return safeTaskProfile(value, current[field]);
  if (field === "language") return safeEnum(value, field, LANGUAGES, current[field]);
  if (field === "executionTier") return safeEnum(value, field, EXECUTION_TIERS, current[field]);
  if (field === "enableScs") return safeEnum(value, field, SCS_MODES, current[field]);
  if (field === "scsValidationMode") return safeEnum(value, field, SCS_VALIDATION_MODES, current[field]);
  if (field === "dynamicSteps") return safeEnum(value, field, DYNAMIC_STEP_MODES, current[field]);
  if (field === "permissionMode") return safeEnum(value, field, PERMISSION_MODES, current[field]);
  if (field === "sandboxMode") return safeEnum(value, field, SANDBOX_MODES, current[field]);
  if (field === "packageInstallPolicy") return safeEnum(value, field, PACKAGE_INSTALL_POLICIES, current[field]);
  if (field === "workspaceWritePolicy") return safeEnum(value, field, WORKSPACE_WRITE_POLICIES, current[field]);
  if (field === "contextBudgetMode") return safeEnum(value, field, CONTEXT_BUDGET_MODES, current[field]);
  if (field === "commandCwd") return safeString(value, field, { maxLength: 4096 });
  if (field === "allowedDomains") return safeStringArray(value, field);
  if (field === "readOnlyRoots") return safeStringArray(value, field, { maxItems: 32, maxLength: 4096 });
  if (BOOLEAN_FIELDS.includes(field)) return safeBoolean(value, field, current[field]);
  if (NUMBER_FIELDS[field]) return safeNumber(value, field, current[field]);
  return current[field];
}

export function applySessionRuntimePatch(snapshot, runtimePatch, expectedRevision) {
  const current = normalizeStoredSnapshot(snapshot);

  // The compare happens before patch shape/content validation so a stale caller
  // cannot learn from validation or accidentally influence the accepted value.
  let expected;
  try {
    expected = positiveRevision(expectedRevision, "expectedRevision");
  } catch {
    throw new SessionRuntimeConflictError(expectedRevision, current.revision);
  }
  if (expected !== current.revision) throw new SessionRuntimeConflictError(expected, current.revision);

  if (!isPlainObject(runtimePatch)) {
    throw new SessionRuntimeError("SESSION_RUNTIME_INVALID_FIELD", "runtimePatch must be a plain object.");
  }
  if (current.revision >= Number.MAX_SAFE_INTEGER) {
    throw new SessionRuntimeError("SESSION_RUNTIME_INVALID_REVISION", "Session runtime revision cannot be incremented safely.");
  }

  const candidate = { ...current };
  const permissionModeChanged = Object.prototype.hasOwnProperty.call(runtimePatch, "permissionMode");
  if (permissionModeChanged) {
    const permissionMode = validatePatchField("permissionMode", runtimePatch.permissionMode, current);
    Object.assign(candidate, permissionModeDefaults(permissionMode));
  }
  for (const field of SESSION_RUNTIME_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(runtimePatch, field)) continue;
    candidate[field] = validatePatchField(field, runtimePatch[field], candidate);
  }

  // Runtime config treats sandboxMode as authoritative and derives the Docker
  // transport flag from it. Keep the durable snapshot equally canonical even
  // when a caller co-supplies a contradictory legacy useDockerSandbox value.
  if (
    permissionModeChanged ||
    Object.prototype.hasOwnProperty.call(runtimePatch, "sandboxMode") ||
    Object.prototype.hasOwnProperty.call(runtimePatch, "useDockerSandbox")
  ) {
    candidate.useDockerSandbox = candidate.sandboxMode !== "host";
  }

  const providerChanged = Object.prototype.hasOwnProperty.call(runtimePatch, "provider");
  const modelChanged = Object.prototype.hasOwnProperty.call(runtimePatch, "model");
  if (providerChanged || modelChanged) {
    candidate.routingMode = Object.prototype.hasOwnProperty.call(runtimePatch, "routingMode")
      ? candidate.routingMode
      : "manual";
    if (providerChanged && !modelChanged) candidate.model = defaultModel(candidate.provider);
    if (!Object.prototype.hasOwnProperty.call(runtimePatch, "routeProvider")) candidate.routeProvider = candidate.provider;
    if (!Object.prototype.hasOwnProperty.call(runtimePatch, "mainProvider")) candidate.mainProvider = candidate.provider;
    if (!Object.prototype.hasOwnProperty.call(runtimePatch, "spareProvider")) candidate.spareProvider = candidate.provider;
    if (!Object.prototype.hasOwnProperty.call(runtimePatch, "routeModel")) candidate.routeModel = candidate.model;
    if (!Object.prototype.hasOwnProperty.call(runtimePatch, "mainModel")) candidate.mainModel = candidate.model;
    if (!Object.prototype.hasOwnProperty.call(runtimePatch, "spareModel")) candidate.spareModel = candidate.model;
  }

  for (const role of ["route", "main", "spare"]) {
    const providerField = `${role}Provider`;
    const modelField = `${role}Model`;
    if (
      Object.prototype.hasOwnProperty.call(runtimePatch, providerField) &&
      !Object.prototype.hasOwnProperty.call(runtimePatch, modelField)
    ) {
      candidate[modelField] = defaultModel(candidate[providerField]);
    }
  }

  candidate.revision = current.revision + 1;
  return canonicalSnapshot(candidate, candidate.revision);
}

/**
 * Resolve a resume without returning incoming credentials or endpoint data.
 * A durable snapshot (or conservative legacy migration) is authoritative; the
 * caller should feed runtimeOverrides into resolveRuntimeConfig so that provider
 * credentials are rebuilt through the normal secret-bearing configuration path.
 */
export function resolveSessionRuntime({
  state = null,
  savedState = null,
  savedRuntime = null,
  incomingConfig = {},
  runtimePatch,
  expectedRevision,
} = {}) {
  const durableState = state || savedState;
  let source = "initial";
  let snapshot;

  if (savedRuntime) {
    snapshot = normalizeStoredSnapshot(savedRuntime);
    source = "snapshot";
  } else if (durableState?.meta?.runtimeConfig) {
    snapshot = normalizeStoredSnapshot(durableState.meta.runtimeConfig);
    source = "snapshot";
  } else if (durableState) {
    snapshot = migrateLegacySessionRuntime(durableState);
    source = "legacy";
  } else {
    snapshot = captureSessionRuntime(incomingConfig);
  }

  const patched = runtimePatch !== undefined;
  if (patched) {
    snapshot = applySessionRuntimePatch(snapshot, runtimePatch, expectedRevision);
  } else if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== "") {
    let expected;
    try {
      expected = positiveRevision(expectedRevision, "expectedRevision");
    } catch {
      throw new SessionRuntimeConflictError(expectedRevision, snapshot.revision);
    }
    if (expected !== snapshot.revision) throw new SessionRuntimeConflictError(expected, snapshot.revision);
  }

  return {
    snapshot,
    runtimeOverrides: sessionRuntimeOverrides(snapshot),
    credentialProvider: snapshot.provider,
    source,
    patched,
  };
}

export function isSessionRuntimeField(field) {
  return RUNTIME_FIELD_SET.has(String(field || ""));
}
