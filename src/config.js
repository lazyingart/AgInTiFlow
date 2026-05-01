import path from "node:path";
import crypto from "node:crypto";
import { getProviderDefaults, normalizeRoutingMode, selectModelRoute } from "./model-routing.js";
import { normalizePackageInstallPolicy, normalizeSandboxMode } from "./command-policy.js";
import { normalizeWrapperName } from "./tool-wrappers.js";
import { loadProjectEnv, resolveProjectRoot } from "./project.js";
import { normalizeTaskProfile } from "./task-profiles.js";

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
    (process.env.DEEPSEEK_API_KEY ? "deepseek" : process.env.OPENAI_API_KEY ? "openai" : "deepseek");
  const routingMode = normalizeRoutingMode(overrides.routingMode || args.routingMode || process.env.AGENT_ROUTING_MODE || "smart");
  const route = selectModelRoute({
    routingMode,
    provider: requestedProvider,
    model: overrides.model || args.model || process.env.LLM_MODEL || "",
    goal: args.goal || "",
  });

  const defaults = getProviderDefaults(route.provider);
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
    taskProfile: normalizeTaskProfile(overrides.taskProfile || args.taskProfile || process.env.AGINTI_TASK_PROFILE || "auto"),
    routeReason: route.reason,
    routeComplexityScore: route.complexityScore,
    requestedProvider,
    requestedModel: overrides.model || args.model || process.env.LLM_MODEL || "",
    provider: route.provider,
    apiKey: overrides.apiKey || defaults.apiKey,
    baseURL: overrides.baseURL || defaults.baseURL,
    model: route.model || defaults.model,
    maxSteps: parseNumber(overrides.maxSteps ?? args.maxSteps ?? process.env.MAX_STEPS, 24),
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
