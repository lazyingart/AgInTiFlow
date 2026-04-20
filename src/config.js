import path from "node:path";
import crypto from "node:crypto";

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

function getProviderDefaults(provider) {
  if (provider === "deepseek") {
    return {
      provider: "deepseek",
      apiKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "",
      baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
      model: process.env.LLM_MODEL || "deepseek-chat",
    };
  }

  return {
    provider: "openai",
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "",
    baseURL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    model: process.env.LLM_MODEL || "gpt-5.4-mini",
  };
}

export function resolveRuntimeConfig(args, overrides = {}) {
  const provider =
    overrides.provider ||
    process.env.AGENT_PROVIDER ||
    (process.env.OPENAI_API_KEY ? "openai" : process.env.DEEPSEEK_API_KEY ? "deepseek" : "openai");

  const defaults = getProviderDefaults(provider);
  const baseDir = path.resolve(overrides.baseDir || process.cwd());

  return {
    ...defaults,
    goal: args.goal || "",
    startUrl: args.startUrl || "",
    resume: args.resume || "",
    sessionId: overrides.sessionId || args.sessionId || process.env.SESSION_ID || `web-agent-${crypto.randomUUID()}`,
    provider,
    apiKey: overrides.apiKey || defaults.apiKey,
    baseURL: overrides.baseURL || defaults.baseURL,
    model: overrides.model || defaults.model,
    maxSteps: parseNumber(overrides.maxSteps ?? process.env.MAX_STEPS, 15),
    headless: parseBoolean(overrides.headless ?? process.env.HEADLESS, false),
    allowedDomains: Array.isArray(overrides.allowedDomains)
      ? overrides.allowedDomains
      : parseList(process.env.ALLOWED_DOMAINS),
    allowPasswords: parseBoolean(overrides.allowPasswords ?? process.env.ALLOW_PASSWORDS, false),
    allowDestructive: parseBoolean(overrides.allowDestructive ?? process.env.ALLOW_DESTRUCTIVE, false),
    allowShellTool: parseBoolean(overrides.allowShellTool ?? process.env.ALLOW_SHELL_TOOL, false),
    commandCwd: path.resolve(overrides.commandCwd || process.env.COMMAND_CWD || process.cwd()),
    sessionsDir: path.resolve(baseDir, ".sessions"),
    onLog: overrides.onLog,
    onEvent: overrides.onEvent,
  };
}

export function loadConfig(args) {
  return resolveRuntimeConfig(args);
}
