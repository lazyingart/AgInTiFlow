import path from "node:path";
import crypto from "node:crypto";
import { getModelRoleDefaults, getProviderDefaults, normalizeRoutingMode, selectModelRoute } from "./model-routing.js";
import { normalizePackageInstallPolicy, normalizeSandboxMode } from "./command-policy.js";
import { normalizeWrapperName } from "./tool-wrappers.js";
import { loadProjectEnv, projectPaths, resolveProjectRoot } from "./project.js";
import { normalizeTaskProfile } from "./task-profiles.js";
import { recommendedMaxStepsForTask } from "./engineering-guidance.js";
import { resolveLanguage } from "./i18n.js";
import { normalizeScsMode, shouldActivateScs } from "./scs-controller.js";
import { applyPermissionMode, normalizePermissionMode } from "./permission-modes.js";
import { normalizeDynamicStepsMode } from "./step-budget-controller.js";

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

export function resolveRuntimeConfig(args, overrides = {}) {
  const baseDir = resolveProjectRoot(overrides.baseDir || process.cwd());
  const paths = projectPaths(baseDir);
  loadProjectEnv(baseDir);
  const requestedProvider =
    overrides.provider ||
    args.provider ||
    process.env.AGENT_PROVIDER ||
    (process.env.DEEPSEEK_API_KEY
      ? "deepseek"
      : process.env.OPENAI_API_KEY
        ? "openai"
        : process.env.QWEN_API_KEY
          ? "qwen"
          : process.env.VENICE_API_KEY
            ? "venice"
            : "deepseek");
  const routingMode = normalizeRoutingMode(overrides.routingMode || args.routingMode || process.env.AGENT_ROUTING_MODE || "smart");
  const taskProfile = normalizeTaskProfile(overrides.taskProfile || args.taskProfile || process.env.AGINTI_TASK_PROFILE || "auto");
  const language = resolveLanguage(overrides.language || args.language || process.env.AGINTI_LANGUAGE || "");
  const route = selectModelRoute({
    routingMode,
    provider: requestedProvider,
    model: overrides.model || args.model || process.env.LLM_MODEL || "",
    goal: args.goal || "",
    taskProfile,
    routeProvider: overrides.routeProvider || args.routeProvider || process.env.AGINTI_ROUTE_PROVIDER || "",
    routeModel: overrides.routeModel || args.routeModel || process.env.AGINTI_ROUTE_MODEL || "",
    mainProvider: overrides.mainProvider || args.mainProvider || process.env.AGINTI_MAIN_PROVIDER || "",
    mainModel: overrides.mainModel || args.mainModel || process.env.AGINTI_MAIN_MODEL || "",
  });
  const modelRoles = getModelRoleDefaults({
    routeProvider: overrides.routeProvider || args.routeProvider || process.env.AGINTI_ROUTE_PROVIDER || "",
    routeModel: overrides.routeModel || args.routeModel || process.env.AGINTI_ROUTE_MODEL || "",
    mainProvider: overrides.mainProvider || args.mainProvider || process.env.AGINTI_MAIN_PROVIDER || "",
    mainModel: overrides.mainModel || args.mainModel || process.env.AGINTI_MAIN_MODEL || "",
    spareProvider: overrides.spareProvider || args.spareProvider || process.env.AGINTI_SPARE_PROVIDER || "",
    spareModel: overrides.spareModel || args.spareModel || process.env.AGINTI_SPARE_MODEL || "",
    spareReasoning: overrides.spareReasoning || args.spareReasoning || process.env.AGINTI_SPARE_REASONING || "",
    wrapperModel: overrides.wrapperModel || args.wrapperModel || process.env.AGINTI_WRAPPER_MODEL || "",
    wrapperReasoning: overrides.wrapperReasoning || args.wrapperReasoning || process.env.AGINTI_WRAPPER_REASONING || "",
    auxiliaryProvider: overrides.auxiliaryProvider || args.auxiliaryProvider || process.env.AGINTI_AUX_PROVIDER || "",
    auxiliaryModel: overrides.auxiliaryModel || args.auxiliaryModel || process.env.AGINTI_AUX_MODEL || "",
  });

  const scsMode = normalizeScsMode(overrides.enableScs ?? args.enableScs ?? process.env.AGINTI_SCS_MODE ?? "off");
  const scsActive = shouldActivateScs(scsMode, {
    goal: args.goal || "",
    taskProfile,
    complexityScore: route.complexityScore,
  });
  const activeProvider = scsActive && route.provider !== "mock" ? modelRoles.main.provider : route.provider;
  const activeModel = scsActive && route.provider !== "mock" ? modelRoles.main.model : route.model;
  const defaults = getProviderDefaults(activeProvider);
  const defaultMaxSteps = recommendedMaxStepsForTask({
    goal: args.goal || "",
    taskProfile,
    complexityScore: route.complexityScore,
  });
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
    true
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
    enableScs: scsMode,
    scsActive,
    scsModelPolicy: scsActive ? "main" : "route",
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
    perceptionReasoning: overrides.perceptionReasoning || args.perceptionReasoning || process.env.AGINTI_PERCEPTION_REASONING || "medium",
    webResearchModel: overrides.webResearchModel || args.webResearchModel || process.env.AGINTI_WEB_RESEARCH_MODEL || "gpt-5.4-mini",
    webResearchReasoning: overrides.webResearchReasoning || args.webResearchReasoning || process.env.AGINTI_WEB_RESEARCH_REASONING || "medium",
    researchWrapperModel: overrides.researchWrapperModel || args.researchWrapperModel || process.env.AGINTI_RESEARCH_WRAPPER_MODEL || "gpt-5.4-mini",
    researchWrapperReasoning:
      overrides.researchWrapperReasoning || args.researchWrapperReasoning || process.env.AGINTI_RESEARCH_WRAPPER_REASONING || "medium",
    auxiliaryProvider: modelRoles.auxiliary.provider,
    auxiliaryModel: modelRoles.auxiliary.model,
    requestedProvider,
    requestedModel: overrides.model || args.model || process.env.LLM_MODEL || "",
    provider: activeProvider,
    apiKey: overrides.apiKey || defaults.apiKey,
    baseURL: overrides.baseURL || defaults.baseURL,
    model: activeModel || defaults.model,
    maxSteps: parseNumber(overrides.maxSteps ?? args.maxSteps ?? process.env.MAX_STEPS, defaultMaxSteps),
    dynamicSteps: normalizeDynamicStepsMode(overrides.dynamicSteps ?? args.dynamicSteps ?? process.env.AGINTI_DYNAMIC_STEPS ?? "auto"),
    dynamicStepExtensionLimit: clampNumber(
      parseNumber(
        overrides.dynamicStepExtensionLimit ?? args.dynamicStepExtensionLimit ?? process.env.AGINTI_STEP_EXTENSION_LIMIT,
        scsActive ? 2 : 1
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
    headless: parseBoolean(overrides.headless ?? args.headless ?? process.env.HEADLESS, false),
    allowedDomains: Array.isArray(overrides.allowedDomains)
      ? overrides.allowedDomains
      : parseList(process.env.ALLOWED_DOMAINS),
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
      true
    ),
    allowWebSearch: parseBoolean(overrides.allowWebSearch ?? args.allowWebSearch ?? process.env.ALLOW_WEB_SEARCH, true),
    allowParallelScouts: scsActive && !explicitParallelScouts ? false : allowParallelScouts,
    parallelScoutCount: clampNumber(
      parseNumber(overrides.parallelScoutCount ?? args.parallelScoutCount ?? process.env.AGINTI_SCOUT_COUNT, 3),
      1,
      10
    ),
    preferredWrapper: normalizeWrapperName(
      overrides.preferredWrapper ?? args.preferredWrapper ?? process.env.PREFERRED_WRAPPER ?? process.env.AGENT_WRAPPER
    ),
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
  };
}

export function loadConfig(args, overrides = {}) {
  return resolveRuntimeConfig(args, overrides);
}
