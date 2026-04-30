import path from "node:path";
import crypto from "node:crypto";
import { getProviderDefaults, normalizeRoutingMode, selectModelRoute } from "./model-routing.js";

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
  const baseDir = path.resolve(overrides.baseDir || process.cwd());

  return {
    ...defaults,
    baseDir,
    goal: args.goal || "",
    startUrl: args.startUrl || "",
    resume: args.resume || "",
    sessionId: overrides.sessionId || args.sessionId || process.env.SESSION_ID || `web-agent-${crypto.randomUUID()}`,
    routingMode,
    routeReason: route.reason,
    routeComplexityScore: route.complexityScore,
    requestedProvider,
    requestedModel: overrides.model || args.model || process.env.LLM_MODEL || "",
    provider: route.provider,
    apiKey: overrides.apiKey || defaults.apiKey,
    baseURL: overrides.baseURL || defaults.baseURL,
    model: route.model || defaults.model,
    maxSteps: parseNumber(overrides.maxSteps ?? args.maxSteps ?? process.env.MAX_STEPS, 15),
    headless: parseBoolean(overrides.headless ?? args.headless ?? process.env.HEADLESS, false),
    allowedDomains: Array.isArray(overrides.allowedDomains)
      ? overrides.allowedDomains
      : parseList(process.env.ALLOWED_DOMAINS),
    allowPasswords: parseBoolean(overrides.allowPasswords ?? process.env.ALLOW_PASSWORDS, false),
    allowDestructive: parseBoolean(overrides.allowDestructive ?? process.env.ALLOW_DESTRUCTIVE, false),
    allowShellTool: parseBoolean(overrides.allowShellTool ?? args.allowShellTool ?? process.env.ALLOW_SHELL_TOOL, false),
    allowWrapperTools: parseBoolean(
      overrides.allowWrapperTools ?? args.allowWrapperTools ?? process.env.ALLOW_WRAPPER_TOOLS,
      false
    ),
    wrapperTimeoutMs: parseNumber(overrides.wrapperTimeoutMs ?? process.env.WRAPPER_TIMEOUT_MS, 120000),
    useDockerSandbox: parseBoolean(overrides.useDockerSandbox ?? args.useDockerSandbox ?? process.env.USE_DOCKER_SANDBOX, false),
    dockerSandboxImage: overrides.dockerSandboxImage || process.env.DOCKER_SANDBOX_IMAGE || "agintiflow-sandbox:latest",
    commandCwd: path.resolve(overrides.commandCwd || args.commandCwd || process.env.COMMAND_CWD || process.cwd()),
    sessionsDir: path.resolve(baseDir, ".sessions"),
    onLog: overrides.onLog,
    onEvent: overrides.onEvent,
  };
}

export function loadConfig(args) {
  return resolveRuntimeConfig(args);
}
