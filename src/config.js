import path from "node:path";
import crypto from "node:crypto";
import { getModelRoleDefaults, getProviderDefaults, normalizeRoutingMode, selectModelRoute } from "./model-routing.js";
import { normalizePackageInstallPolicy, normalizeSandboxMode } from "./command-policy.js";
import { normalizeWrapperName } from "./tool-wrappers.js";
import { loadProjectEnv, resolveProjectRoot } from "./project.js";
import { normalizeTaskProfile } from "./task-profiles.js";
import { recommendedMaxStepsForTask } from "./engineering-guidance.js";
import { resolveLanguage } from "./i18n.js";

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

  const defaults = getProviderDefaults(route.provider);
  const defaultMaxSteps = recommendedMaxStepsForTask({
    goal: args.goal || "",
    taskProfile,
    complexityScore: route.complexityScore,
  });
  const packageDir = path.resolve(overrides.packageDir || process.env.AGINTIFLOW_PACKAGE_DIR || baseDir);
  const dockerRequested = parseBoolean(overrides.useDockerSandbox ?? args.useDockerSandbox ?? process.env.USE_DOCKER_SANDBOX, true);
  const requestedSandboxMode =
    overrides.sandboxMode || args.sandboxMode || process.env.SANDBOX_MODE || (dockerRequested ? "docker-workspace" : "host");
  const sandboxMode = normalizeSandboxMode(requestedSandboxMode);

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
    auxiliaryProvider: modelRoles.auxiliary.provider,
    auxiliaryModel: modelRoles.auxiliary.model,
    requestedProvider,
    requestedModel: overrides.model || args.model || process.env.LLM_MODEL || "",
    provider: route.provider,
    apiKey: overrides.apiKey || defaults.apiKey,
    baseURL: overrides.baseURL || defaults.baseURL,
    model: route.model || defaults.model,
    maxSteps: parseNumber(overrides.maxSteps ?? args.maxSteps ?? process.env.MAX_STEPS, defaultMaxSteps),
    headless: parseBoolean(overrides.headless ?? args.headless ?? process.env.HEADLESS, false),
    allowedDomains: Array.isArray(overrides.allowedDomains)
      ? overrides.allowedDomains
      : parseList(process.env.ALLOWED_DOMAINS),
    allowPasswords: parseBoolean(overrides.allowPasswords ?? process.env.ALLOW_PASSWORDS, false),
    allowDestructive: parseBoolean(overrides.allowDestructive ?? args.allowDestructive ?? process.env.ALLOW_DESTRUCTIVE, false),
    allowShellTool: parseBoolean(overrides.allowShellTool ?? args.allowShellTool ?? process.env.ALLOW_SHELL_TOOL, true),
    allowFileTools: parseBoolean(overrides.allowFileTools ?? args.allowFileTools ?? process.env.ALLOW_FILE_TOOLS, true),
    allowWrapperTools: parseBoolean(
      overrides.allowWrapperTools ?? args.allowWrapperTools ?? process.env.ALLOW_WRAPPER_TOOLS,
      false
    ),
    allowAuxiliaryTools: parseBoolean(
      overrides.allowAuxiliaryTools ?? args.allowAuxiliaryTools ?? process.env.ALLOW_AUXILIARY_TOOLS,
      true
    ),
    allowWebSearch: parseBoolean(overrides.allowWebSearch ?? args.allowWebSearch ?? process.env.ALLOW_WEB_SEARCH, true),
    allowParallelScouts: parseBoolean(
      overrides.allowParallelScouts ?? args.allowParallelScouts ?? process.env.AGINTI_PARALLEL_SCOUTS,
      true
    ),
    parallelScoutCount: clampNumber(
      parseNumber(overrides.parallelScoutCount ?? args.parallelScoutCount ?? process.env.AGINTI_SCOUT_COUNT, 3),
      1,
      10
    ),
    preferredWrapper: normalizeWrapperName(
      overrides.preferredWrapper ?? args.preferredWrapper ?? process.env.PREFERRED_WRAPPER ?? process.env.AGENT_WRAPPER
    ),
    wrapperTimeoutMs: parseNumber(overrides.wrapperTimeoutMs ?? process.env.WRAPPER_TIMEOUT_MS, 120000),
    sandboxMode,
    packageInstallPolicy: normalizePackageInstallPolicy(
      overrides.packageInstallPolicy || args.packageInstallPolicy || process.env.PACKAGE_INSTALL_POLICY || (sandboxMode === "host" ? "prompt" : "allow")
    ),
    useDockerSandbox: sandboxMode !== "host",
    dockerSandboxImage: overrides.dockerSandboxImage || process.env.DOCKER_SANDBOX_IMAGE || "agintiflow-sandbox:latest",
    commandCwd: path.resolve(overrides.commandCwd || args.commandCwd || process.env.COMMAND_CWD || baseDir),
    sessionsDir: path.resolve(baseDir, ".sessions"),
    onLog: overrides.onLog,
    onEvent: overrides.onEvent,
  };
}

export function loadConfig(args, overrides = {}) {
  return resolveRuntimeConfig(args, overrides);
}
