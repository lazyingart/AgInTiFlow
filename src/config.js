import path from "node:path";
import crypto from "node:crypto";
import {
  LOCALLLM_MODEL_TIERS,
  getModelRoleDefaults,
  getProviderDefaults,
  normalizeReasoningEffort,
  normalizeRoutingMode,
  selectModelRoute,
} from "./model-routing.js";
import { normalizePackageInstallPolicy, normalizeSandboxMode } from "./command-policy.js";
import { normalizeWrapperName } from "./tool-wrappers.js";
import { loadProjectEnv, projectPaths, resolveProjectRoot } from "./project.js";
import { normalizeTaskProfile } from "./task-profiles.js";
import { recommendedMaxStepsForTask } from "./engineering-guidance.js";
import { resolveLanguage } from "./i18n.js";
import {
  DEFAULT_SCS_MODE,
  normalizeScsMode,
  normalizeScsValidationMode,
  shouldActivateScs,
} from "./scs-controller.js";
import { applyPermissionMode, normalizePermissionMode } from "./permission-modes.js";
import { normalizeDynamicStepsMode } from "./step-budget-controller.js";
import { maxStepsForExecutionPolicy, selectExecutionPolicy } from "./execution-policy.js";
import { normalizeContextBudgetMode } from "./context-budget-controller.js";
import { BASELINE_PROVIDER, normalizeProviderBaseURL, normalizeProviderId } from "./provider-contract.js";

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePathList(value) {
  if (!value) return [];
  return String(value)
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function configuredReasoning(overrides, args, key, envName) {
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  if (Object.prototype.hasOwnProperty.call(args, key) && String(args[key] ?? "").trim()) return args[key];
  if (process.env[envName] !== undefined) return process.env[envName];
  return undefined;
}

function hostedProviderFromEnv() {
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.QWEN_API_KEY) return "qwen";
  if (process.env.VENICE_API_KEY) return "venice";
  return BASELINE_PROVIDER;
}

function localFirstEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.AGINTI_LOCAL_FIRST ?? "1").trim());
}

function resolveRequestedProvider(overrides, args) {
  const explicitProvider = overrides.provider || args.provider || process.env.AGENT_PROVIDER || "";
  if (explicitProvider) {
    const normalized = normalizeProviderId(explicitProvider, "");
    if (normalized) return normalized;
    throw new Error(`Unknown provider "${explicitProvider}". Use localllm, deepseek, openai, openrouter, qwen, venice, or mock.`);
  }
  return localFirstEnabled() ? BASELINE_PROVIDER : hostedProviderFromEnv();
}

function requestedModelOverride(overrides, args, provider) {
  const explicit = overrides.model || args.model || "";
  if (explicit) return explicit;
  return provider === BASELINE_PROVIDER ? "" : process.env.LLM_MODEL || "";
}

export function resolveRuntimeConfig(args, overrides = {}) {
  const baseDir = resolveProjectRoot(overrides.baseDir || process.cwd());
  const paths = projectPaths(baseDir);
  loadProjectEnv(baseDir);
  const requestedProvider = resolveRequestedProvider(overrides, args);
  const routingMode = normalizeRoutingMode(overrides.routingMode || args.routingMode || process.env.AGENT_ROUTING_MODE || "smart");
  const taskProfile = normalizeTaskProfile(overrides.taskProfile || args.taskProfile || process.env.AGINTI_TASK_PROFILE || "auto");
  const language = resolveLanguage(overrides.language || args.language || process.env.AGINTI_LANGUAGE || "");
  // Capability/resource snapshots are trusted runtime inputs. They are deliberately
  // not inferred from ambient cloud credentials or optimistic environment flags.
  // The shipped auto-Max path starts on Deep here and can upgrade only after the
  // runner performs authenticated model discovery and a fresh resource probe.
  const localCapabilities =
    overrides.localCapabilities && typeof overrides.localCapabilities === "object"
      ? { ...overrides.localCapabilities }
      : {};
  const localResourcePolicy =
    overrides.localResourcePolicy && typeof overrides.localResourcePolicy === "object"
      ? { ...overrides.localResourcePolicy }
      : {};
  const localMaxModel =
    overrides.localMaxModel ||
    process.env.AGINTI_LOCALLLM_MAX_MODEL ||
    LOCALLLM_MODEL_TIERS.max.model;
  const localCodeModel =
    overrides.localCodeModel ||
    process.env.AGINTI_LOCALLLM_CODE_MODEL ||
    LOCALLLM_MODEL_TIERS.code.model;
  const allowLocalAutoMax = parseBoolean(
    overrides.allowLocalAutoMax ??
      args.allowLocalAutoMax ??
      process.env.AGINTI_LOCALLLM_ALLOW_AUTO_MAX,
    false
  );
  const requestedModel = requestedModelOverride(overrides, args, requestedProvider);
  const sessionModelLocked = overrides.sessionModelLocked === true;
  // Once the top-level provider has been resolved, it is the default trust
  // boundary for every model role. Dedicated role settings remain stronger,
  // but a stale ambient AGENT_PROVIDER must not repopulate missing roles and
  // silently move an explicit LocalLLM run to a hosted SCS main model.
  const routeProvider = overrides.routeProvider || args.routeProvider || process.env.AGINTI_ROUTE_PROVIDER || requestedProvider;
  const mainProvider = overrides.mainProvider || args.mainProvider || process.env.AGINTI_MAIN_PROVIDER || requestedProvider;
  const spareProvider = overrides.spareProvider || args.spareProvider || process.env.AGINTI_SPARE_PROVIDER || requestedProvider;
  const selectedRoute = selectModelRoute({
    routingMode: sessionModelLocked ? "manual" : routingMode,
    provider: requestedProvider,
    model: requestedModel,
    goal: args.goal || "",
    taskProfile,
    routeProvider,
    routeModel: overrides.routeModel || args.routeModel || process.env.AGINTI_ROUTE_MODEL || "",
    mainProvider,
    mainModel: overrides.mainModel || args.mainModel || process.env.AGINTI_MAIN_MODEL || "",
    localCapabilities,
    localResourcePolicy,
    localModelOverrides: {
      fastModel: overrides.localFastModel || "",
      deepModel: overrides.localDeepModel || "",
      codeModel: localCodeModel,
      maxModel: localMaxModel,
      visionModel: overrides.localVisionModel || process.env.AGINTI_LOCALLLM_VISION_MODEL || "",
    },
  });
  // A resumed session's CAS snapshot stores the effective provider/model, not a
  // fresh routing suggestion. Resolve it through the normal provider contract,
  // but keep that concrete choice authoritative for this continuation. New smart
  // runs omit this internal flag and remain complexity-routed.
  const route = sessionModelLocked
    ? {
        ...selectedRoute,
        routingMode,
        reason: "Saved session runtime kept its authoritative provider/model selection.",
        localSelection: selectedRoute.provider === BASELINE_PROVIDER ? "session-snapshot" : selectedRoute.localSelection,
      }
    : selectedRoute;
  const modelRoles = getModelRoleDefaults({
    routeProvider,
    routeModel: overrides.routeModel || args.routeModel || process.env.AGINTI_ROUTE_MODEL || "",
    routeReasoning: configuredReasoning(overrides, args, "routeReasoning", "AGINTI_ROUTE_REASONING"),
    mainProvider,
    mainModel: overrides.mainModel || args.mainModel || process.env.AGINTI_MAIN_MODEL || "",
    mainReasoning: configuredReasoning(overrides, args, "mainReasoning", "AGINTI_MAIN_REASONING"),
    spareProvider,
    spareModel: overrides.spareModel || args.spareModel || process.env.AGINTI_SPARE_MODEL || "",
    spareReasoning: configuredReasoning(overrides, args, "spareReasoning", "AGINTI_SPARE_REASONING"),
    wrapperModel: overrides.wrapperModel || args.wrapperModel || process.env.AGINTI_WRAPPER_MODEL || "",
    wrapperReasoning: overrides.wrapperReasoning || args.wrapperReasoning || process.env.AGINTI_WRAPPER_REASONING || "",
    auxiliaryProvider: overrides.auxiliaryProvider || args.auxiliaryProvider || process.env.AGINTI_AUX_PROVIDER || "",
    auxiliaryModel: overrides.auxiliaryModel || args.auxiliaryModel || process.env.AGINTI_AUX_MODEL || "",
  });

  const scsMode = normalizeScsMode(overrides.enableScs ?? args.enableScs ?? process.env.AGINTI_SCS_MODE ?? DEFAULT_SCS_MODE);
  const scsValidationMode = normalizeScsValidationMode(
    overrides.scsValidationMode ?? args.scsValidationMode ?? process.env.AGINTI_SCS_VALIDATION_MODE ?? "auto"
  );
  const scsActive = shouldActivateScs(scsMode, {
    goal: args.goal || "",
    taskProfile,
    complexityScore: route.complexityScore,
  });
  const preserveSpecializedLocalRoute =
    scsActive &&
    route.provider === BASELINE_PROVIDER &&
    (route.localCodeCandidate === true || ["code", "max", "vision"].includes(route.localTier || ""));
  const preserveSessionModel = scsActive && sessionModelLocked;
  const useScsMainRole = scsActive && route.provider !== "mock" && !preserveSpecializedLocalRoute && !preserveSessionModel;
  const activeProvider = useScsMainRole ? modelRoles.main.provider : route.provider;
  const activeModel = useScsMainRole ? modelRoles.main.model : route.model;
  const explicitReasoning = normalizeReasoningEffort(
    overrides.reasoning ??
      args.reasoning ??
      configuredReasoning(overrides, args, "mainReasoning", "AGINTI_MAIN_REASONING") ??
      configuredReasoning(overrides, args, "routeReasoning", "AGINTI_ROUTE_REASONING") ??
      process.env.AGINTI_REASONING ??
      ""
  );
  const activeReasoning =
    sessionModelLocked
      ? explicitReasoning
      : useScsMainRole
      ? modelRoles.main.reasoning
      : route.provider === modelRoles.main.provider && route.model === modelRoles.main.model
        ? modelRoles.main.reasoning
        : route.provider === modelRoles.route.provider && route.model === modelRoles.route.model
          ? modelRoles.route.reasoning
          : explicitReasoning;
  const defaults = getProviderDefaults(activeProvider);
  const activeBaseURL =
    activeProvider === BASELINE_PROVIDER
      ? normalizeProviderBaseURL(activeProvider, overrides.baseURL || defaults.baseURL)
      : overrides.baseURL || defaults.baseURL;
  const defaultMaxSteps = recommendedMaxStepsForTask({
    goal: args.goal || "",
    taskProfile,
    complexityScore: route.complexityScore,
  });
  const requestedExecutionTier =
    overrides.executionTier || args.executionTier || process.env.AGINTI_EXECUTION_TIER || "";
  const executionPolicy = selectExecutionPolicy({
    requestedTier: requestedExecutionTier,
    routingMode,
    taskProfile,
    complexityScore: route.complexityScore,
    scsActive,
  });
  const configuredMaxSteps = overrides.maxSteps ?? args.maxSteps ?? process.env.MAX_STEPS;
  const maxStepsExplicit = configuredMaxSteps !== undefined && String(configuredMaxSteps).trim() !== "";
  const maxSteps = maxStepsForExecutionPolicy(
    parseNumber(configuredMaxSteps, defaultMaxSteps),
    executionPolicy,
    { explicit: maxStepsExplicit }
  );
  const configuredDynamicStepExtensionLimit =
    overrides.dynamicStepExtensionLimit ?? args.dynamicStepExtensionLimit ?? process.env.AGINTI_STEP_EXTENSION_LIMIT;
  const dynamicStepExtensionLimitExplicit =
    configuredDynamicStepExtensionLimit !== undefined && String(configuredDynamicStepExtensionLimit).trim() !== "";
  const packageDir = path.resolve(overrides.packageDir || process.env.AGINTIFLOW_PACKAGE_DIR || baseDir);
  const permissionMode = normalizePermissionMode(
    overrides.permissionMode || args.permissionMode || process.env.AGINTI_PERMISSION_MODE || "normal"
  );
  const permissionDefaults = applyPermissionMode({}, permissionMode, { override: true });
  const dockerRequested = parseBoolean(overrides.useDockerSandbox ?? args.useDockerSandbox ?? process.env.USE_DOCKER_SANDBOX, true);
  const requestedSandboxMode =
    overrides.sandboxMode ||
    args.sandboxMode ||
    process.env.SANDBOX_MODE ||
    permissionDefaults.sandboxMode ||
    (dockerRequested ? "docker-workspace" : "host");
  const sandboxMode = normalizeSandboxMode(requestedSandboxMode);
  const explicitParallelScouts =
    overrides.allowParallelScouts !== undefined ||
    args.allowParallelScouts !== undefined ||
    process.env.AGINTI_PARALLEL_SCOUTS !== undefined;
  const allowParallelScouts = parseBoolean(
    overrides.allowParallelScouts ?? args.allowParallelScouts ?? process.env.AGINTI_PARALLEL_SCOUTS,
    activeProvider !== BASELINE_PROVIDER
  );
  const preferredWrapper = normalizeWrapperName(
    overrides.preferredWrapper ?? args.preferredWrapper ?? process.env.PREFERRED_WRAPPER ?? process.env.AGENT_WRAPPER
  );
  const contextWindowTokens = clampNumber(
    parseNumber(
      overrides.contextWindowTokens ??
        args.contextWindowTokens ??
        (activeProvider === BASELINE_PROVIDER
          ? process.env.AGINTI_LOCALLLM_CONTEXT_TOKENS
          : process.env.AGINTI_CONTEXT_WINDOW_TOKENS),
      activeProvider === BASELINE_PROVIDER ? 32768 : 0
    ),
    0,
    262144
  );
  const maxOutputTokens = clampNumber(
    parseNumber(
      overrides.maxOutputTokens ??
        args.maxOutputTokens ??
        (activeProvider === BASELINE_PROVIDER
          ? process.env.AGINTI_LOCALLLM_MAX_OUTPUT_TOKENS
          : process.env.AGINTI_MAX_OUTPUT_TOKENS),
      activeProvider === BASELINE_PROVIDER ? 8192 : 0
    ),
    0,
    8192
  );
  const contextToolReserveTokens = clampNumber(
    parseNumber(
      overrides.contextToolReserveTokens ??
        args.contextToolReserveTokens ??
        process.env.AGINTI_LOCALLLM_TOOL_SCHEMA_TOKENS,
      activeProvider === BASELINE_PROVIDER ? 4096 : 0
    ),
    0,
    16384
  );

  return {
    ...defaults,
    baseDir,
    packageDir,
    goal: args.goal || "",
    startUrl: args.startUrl || "",
    resume: args.resume || "",
    sessionId: overrides.sessionId || args.sessionId || process.env.SESSION_ID || `web-agent-${crypto.randomUUID()}`,
    routingMode,
    taskProfile,
    language,
    routeReason: route.reason,
    routeComplexityScore: route.complexityScore,
    localTier: route.localTier || "",
    localSelection: route.localSelection || "",
    localUpgradeBlocked: route.localUpgradeBlocked || "",
    localCodeCandidate: route.localCodeCandidate === true,
    localCodeModel: route.localCodeModel || localCodeModel,
    localCodeFallbackModel: route.localCodeFallbackModel || LOCALLLM_MODEL_TIERS.deep.model,
    localCapabilities,
    localResourcePolicy,
    localMaxModel,
    allowLocalAutoMax,
    requiresResourcePreflight: Boolean(route.requiresResourcePreflight),
    executionTier: executionPolicy.tier,
    executionPolicy,
    enableScs: scsMode,
    scsActive,
    scsModelPolicy: scsActive ? (preserveSpecializedLocalRoute || preserveSessionModel ? "selected" : "main") : "route",
    scsValidationMode,
    modelRoles,
    routeProvider: modelRoles.route.provider,
    routeModel: modelRoles.route.model,
    mainProvider: modelRoles.main.provider,
    mainModel: modelRoles.main.model,
    spareProvider: modelRoles.spare.provider,
    spareModel: modelRoles.spare.model,
    spareReasoning: modelRoles.spare.reasoning,
    wrapperModel: modelRoles.wrapper.model,
    wrapperReasoning: modelRoles.wrapper.reasoning,
    perceptionModel: overrides.perceptionModel || args.perceptionModel || process.env.AGINTI_PERCEPTION_MODEL || "gpt-5.4-mini",
    perceptionReasoning: normalizeReasoningEffort(
      overrides.perceptionReasoning ?? args.perceptionReasoning ?? process.env.AGINTI_PERCEPTION_REASONING ?? "medium",
      "medium"
    ),
    webResearchModel: overrides.webResearchModel || args.webResearchModel || process.env.AGINTI_WEB_RESEARCH_MODEL || "gpt-5.4-mini",
    webResearchReasoning: normalizeReasoningEffort(
      overrides.webResearchReasoning ?? args.webResearchReasoning ?? process.env.AGINTI_WEB_RESEARCH_REASONING ?? "medium",
      "medium"
    ),
    researchWrapperModel: overrides.researchWrapperModel || args.researchWrapperModel || process.env.AGINTI_RESEARCH_WRAPPER_MODEL || "gpt-5.4-mini",
    researchWrapperReasoning: normalizeReasoningEffort(
      overrides.researchWrapperReasoning ?? args.researchWrapperReasoning ?? process.env.AGINTI_RESEARCH_WRAPPER_REASONING ?? "medium",
      "medium"
    ),
    auxiliaryProvider: modelRoles.auxiliary.provider,
    auxiliaryModel: modelRoles.auxiliary.model,
    requestedProvider,
    requestedModel,
    provider: activeProvider,
    apiKey: overrides.apiKey || defaults.apiKey,
    baseURL: activeBaseURL,
    model: activeModel || defaults.model,
    reasoning: activeReasoning,
    providerReadinessTimeoutMs: parseNumber(
      overrides.providerReadinessTimeoutMs ?? args.providerReadinessTimeoutMs ?? process.env.AGINTI_PROVIDER_READINESS_TIMEOUT_MS,
      3000
    ),
    maxSteps,
    maxStepsExplicit,
    dynamicSteps: normalizeDynamicStepsMode(overrides.dynamicSteps ?? args.dynamicSteps ?? process.env.AGINTI_DYNAMIC_STEPS ?? "auto"),
    dynamicStepExtensionLimitExplicit,
    dynamicStepExtensionLimit: clampNumber(
      parseNumber(
        configuredDynamicStepExtensionLimit,
        3
      ),
      0,
      8
    ),
    dynamicStepHardCap: parseNumber(
      overrides.dynamicStepHardCap ?? args.dynamicStepHardCap ?? process.env.AGINTI_STEP_EXTENSION_HARD_CAP,
      0
    ),
    dynamicStepExtensionSize: parseNumber(
      overrides.dynamicStepExtensionSize ?? args.dynamicStepExtensionSize ?? process.env.AGINTI_STEP_EXTENSION_SIZE,
      0
    ),
    contextBudgetMode: normalizeContextBudgetMode(
      overrides.contextBudgetMode ?? args.contextBudgetMode ?? process.env.AGINTI_CONTEXT_BUDGET_MODE ?? "auto"
    ),
    contextBudgetChars: parseNumber(
      overrides.contextBudgetChars ?? args.contextBudgetChars ?? process.env.AGINTI_CONTEXT_BUDGET_CHARS,
      180000
    ),
    contextBudgetTargetChars: parseNumber(
      overrides.contextBudgetTargetChars ?? args.contextBudgetTargetChars ?? process.env.AGINTI_CONTEXT_TARGET_CHARS,
      0
    ),
    contextWindowTokens,
    maxOutputTokens,
    contextToolReserveTokens,
    contextBudgetTargetTokens: parseNumber(
      overrides.contextBudgetTargetTokens ?? args.contextBudgetTargetTokens ?? process.env.AGINTI_CONTEXT_TARGET_TOKENS,
      0
    ),
    headless: parseBoolean(overrides.headless ?? args.headless ?? process.env.HEADLESS, false),
    allowedDomains: Array.isArray(overrides.allowedDomains)
      ? overrides.allowedDomains
      : parseList(process.env.ALLOWED_DOMAINS),
    readOnlyRoots: (
      Array.isArray(overrides.readOnlyRoots)
        ? overrides.readOnlyRoots
        : Array.isArray(args.readOnlyRoots) && args.readOnlyRoots.length > 0
          ? args.readOnlyRoots
          : parsePathList(process.env.AGINTI_READ_ROOTS)
    ).map((item) => path.resolve(item)),
    allowPasswords: parseBoolean(overrides.allowPasswords ?? args.allowPasswords ?? process.env.ALLOW_PASSWORDS, permissionDefaults.allowPasswords || false),
    allowDestructive: parseBoolean(
      overrides.allowDestructive ?? args.allowDestructive ?? process.env.ALLOW_DESTRUCTIVE,
      permissionDefaults.allowDestructive || false
    ),
    allowShellTool: parseBoolean(
      overrides.allowShellTool ?? args.allowShellTool ?? process.env.ALLOW_SHELL_TOOL,
      permissionDefaults.allowShellTool ?? true
    ),
    allowFileTools: parseBoolean(
      overrides.allowFileTools ?? args.allowFileTools ?? process.env.ALLOW_FILE_TOOLS,
      permissionDefaults.allowFileTools ?? true
    ),
    allowWrapperTools: parseBoolean(
      overrides.allowWrapperTools ?? args.allowWrapperTools ?? process.env.ALLOW_WRAPPER_TOOLS,
      false
    ),
    allowAuxiliaryTools: parseBoolean(
      overrides.allowAuxiliaryTools ?? args.allowAuxiliaryTools ?? process.env.ALLOW_AUXILIARY_TOOLS,
      false
    ),
    allowHostedImagePerception: parseBoolean(
      overrides.allowHostedImagePerception ??
        args.allowHostedImagePerception ??
        process.env.AGINTI_ALLOW_HOSTED_IMAGE_PERCEPTION,
      activeProvider === "openai"
    ),
    allowHostedWebResearch: parseBoolean(
      overrides.allowHostedWebResearch ??
        args.allowHostedWebResearch ??
        process.env.AGINTI_ALLOW_HOSTED_WEB_RESEARCH,
      activeProvider === "openai"
    ),
    allowHostedJsonSpecialist: parseBoolean(
      overrides.allowHostedJsonSpecialist ??
        args.allowHostedJsonSpecialist ??
        process.env.AGINTI_ALLOW_HOSTED_JSON_SPECIALIST,
      false
    ),
    allowHostedWritingSpecialist: parseBoolean(
      overrides.allowHostedWritingSpecialist ??
        args.allowHostedWritingSpecialist ??
        process.env.AGINTI_ALLOW_HOSTED_WRITING_SPECIALIST,
      false
    ),
    allowWebSearch: parseBoolean(overrides.allowWebSearch ?? args.allowWebSearch ?? process.env.ALLOW_WEB_SEARCH, true),
    webSearchProvider: String(
      overrides.webSearchProvider ?? args.webSearchProvider ?? process.env.AGINTI_WEB_SEARCH_PROVIDER ?? "auto"
    ).trim().toLowerCase(),
    braveSearchApiKey: String(overrides.braveSearchApiKey ?? process.env.BRAVE_SEARCH_API_KEY ?? "").trim(),
    allowMcpTools: parseBoolean(overrides.allowMcpTools ?? args.allowMcpTools ?? process.env.AGINTI_ALLOW_MCP_TOOLS, true),
    allowParallelScouts: scsActive && !explicitParallelScouts ? false : allowParallelScouts,
    parallelScoutCount: clampNumber(
      parseNumber(overrides.parallelScoutCount ?? args.parallelScoutCount ?? process.env.AGINTI_SCOUT_COUNT, 3),
      1,
      10
    ),
    preferredWrapper,
    wrapperTimeoutMs: parseNumber(overrides.wrapperTimeoutMs ?? process.env.WRAPPER_TIMEOUT_MS, 120000),
    permissionMode,
    sandboxMode,
    packageInstallPolicy: normalizePackageInstallPolicy(
      overrides.packageInstallPolicy ||
        args.packageInstallPolicy ||
        process.env.PACKAGE_INSTALL_POLICY ||
        permissionDefaults.packageInstallPolicy ||
        (sandboxMode === "host" ? "prompt" : "allow")
    ),
    workspaceWritePolicy:
      overrides.workspaceWritePolicy || args.workspaceWritePolicy || process.env.AGINTI_WORKSPACE_WRITE_POLICY || permissionDefaults.workspaceWritePolicy || "allow",
    allowOutsideWorkspaceFileTools: parseBoolean(
      overrides.allowOutsideWorkspaceFileTools ??
        args.allowOutsideWorkspaceFileTools ??
        process.env.AGINTI_ALLOW_OUTSIDE_WORKSPACE_FILE_TOOLS,
      permissionDefaults.allowOutsideWorkspaceFileTools || false
    ),
    useDockerSandbox: sandboxMode !== "host",
    dockerSandboxImage: overrides.dockerSandboxImage || process.env.DOCKER_SANDBOX_IMAGE || "agintiflow-sandbox:latest",
    commandCwd: path.resolve(overrides.commandCwd || args.commandCwd || process.env.COMMAND_CWD || baseDir),
    sessionsDir: paths.globalSessionsDir,
    projectSessionsDir: paths.sessionsDir,
    sessionDbPath: paths.sessionDbPath,
    globalSessionIndexPath: paths.globalSessionIndexPath,
    onLog: overrides.onLog,
    onEvent: overrides.onEvent,
    onConsole: overrides.onConsole,
  };
}

export function loadConfig(args, overrides = {}) {
  return resolveRuntimeConfig(args, overrides);
}
