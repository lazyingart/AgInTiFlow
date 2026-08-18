import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listAgentWrappers } from "./tool-wrappers.js";
import { getDockerSandboxStatus } from "./docker-sandbox.js";
import { platformInfo, platformLabel, platformSetupHints } from "./platform.js";
import { nodeSqliteRecoveryLines, nodeSqliteStatus } from "./sqlite.js";
import { buildAgintiInstructions, normalizeInstructionTemplate } from "./behavior-contract.js";
import { normalizeProviderId, providerRequiresApiKey } from "./provider-contract.js";
import {
  LEGACY_PROJECT_SESSIONS_DIR_NAME,
  PROJECT_SESSIONS_DIR_NAME,
  deleteSessionIndex,
  globalSessionPaths,
  isSafeSessionId,
  listSessionIndex,
  renameSessionIndex,
  upsertSessionIndex,
} from "./session-index.js";

const execFileAsync = promisify(execFile);
const LOCAL_ENV_KEYS = new Set([
  "AGENT_PROVIDER",
  "AGENT_ROUTING_MODE",
  "AGINTI_LOCAL_FIRST",
  "AGINTI_LOCALLLM_API_KEY",
  "AGINTI_LOCALLLM_BASE_URL",
  "AGINTI_LOCALLLM_MODEL",
  "AGINTI_LOCALLLM_ROUTE_MODEL",
  "AGINTI_LOCALLLM_MAIN_MODEL",
  "AGINTI_LOCALLLM_CODE_MODEL",
  "AGINTI_LOCALLLM_MAX_MODEL",
  "AGINTI_LOCALLLM_VISION_MODEL",
  "AGINTI_LOCALLLM_CONTEXT_TOKENS",
  "AGINTI_LOCALLLM_MAX_OUTPUT_TOKENS",
  "AGINTI_LOCALLLM_TOOL_SCHEMA_TOKENS",
  "AGINTI_LOCALLLM_ALLOW_AUTO_MAX",
  "LOCALLLM_API_KEY",
  "LOCALLLM_BASE_URL",
  "LOCALLLM_MODEL",
  "LOCAL_LLM_API_KEY",
  "LOCAL_LLM_BASE_URL",
  "LOCAL_LLM_MODEL",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
  "OPENROUTER_DEFAULT_MODEL",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_APP_TITLE",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "DEEPSEEK_FAST_MODEL",
  "DEEPSEEK_PRO_MODEL",
  "OPENAI_DEFAULT_MODEL",
  "AGINTI_ROUTE_PROVIDER",
  "AGINTI_ROUTE_MODEL",
  "AGINTI_ROUTE_REASONING",
  "AGINTI_MAIN_PROVIDER",
  "AGINTI_MAIN_MODEL",
  "AGINTI_MAIN_REASONING",
  "AGINTI_SPARE_PROVIDER",
  "AGINTI_SPARE_MODEL",
  "AGINTI_SPARE_REASONING",
  "AGINTI_WRAPPER_MODEL",
  "AGINTI_WRAPPER_REASONING",
  "AGINTI_AUX_PROVIDER",
  "AGINTI_AUX_MODEL",
  "AGINTI_ALLOW_HOSTED_IMAGE_PERCEPTION",
  "AGINTI_ALLOW_HOSTED_WEB_RESEARCH",
  "AGINTI_ALLOW_HOSTED_JSON_SPECIALIST",
  "AGINTI_ALLOW_HOSTED_WRITING_SPECIALIST",
  "AGINTI_WRITING_PROVIDER",
  "AGINTI_WRITING_MODEL",
  "AGINTI_WRITING_PROVIDER_ZH",
  "AGINTI_WRITING_MODEL_ZH",
  "AGINTI_WRITING_PROVIDER_EN",
  "AGINTI_WRITING_MODEL_EN",
  "AGINTI_WRITING_PROVIDER_JA",
  "AGINTI_WRITING_MODEL_JA",
  "AGINTI_WRITING_PROVIDER_KO",
  "AGINTI_WRITING_MODEL_KO",
  "QWEN_API_KEY",
  "QWEN_DEFAULT_MODEL",
  "QWEN_BASE_URL",
  "VENICE_API_KEY",
  "VENICE_API_BASE",
  "VENICE_BASE_URL",
  "VENICE_MODEL",
  "VENICE_DEFAULT_MODEL",
  "VENICE_CHAT_ENDPOINT",
  "VENICE_TIMEOUT_SECONDS",
  "VENICE_IMAGE_MODEL",
  "GRSAI",
  "GRSAI_API_KEY",
]);

const PROVIDER_KEY_CANDIDATES = {
  localllm: ["AGINTI_LOCALLLM_API_KEY", "LOCALLLM_API_KEY", "LOCAL_LLM_API_KEY"],
  openai: ["OPENAI_API_KEY", "LLM_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY", "LLM_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  qwen: ["QWEN_API_KEY"],
  venice: ["VENICE_API_KEY"],
  grsai: ["GRSAI", "GRSAI_API_KEY"],
};

export function resolveProjectRoot(input = process.cwd()) {
  return path.resolve(input || process.cwd());
}

export function projectPaths(projectRoot = process.cwd()) {
  const root = resolveProjectRoot(projectRoot);
  const globalPaths = globalSessionPaths();
  return {
    root,
    agintiInstructionsPath: path.join(root, "AGINTI.md"),
    controlDir: path.join(root, ".aginti"),
    envPath: path.join(root, ".aginti", ".env"),
    rootEnvPath: path.join(root, ".env"),
    envExamplePath: path.join(root, ".aginti", ".env.example"),
    controlReadmePath: path.join(root, ".aginti", "README.md"),
    codebaseMapPath: path.join(root, ".aginti", "codebase-map.json"),
    notesDir: path.join(root, "notes"),
    notesReadmePath: path.join(root, "notes", "README.md"),
    sessionsDir: path.join(root, PROJECT_SESSIONS_DIR_NAME),
    legacySessionsDir: path.join(root, LEGACY_PROJECT_SESSIONS_DIR_NAME),
    sessionDbPath: path.join(root, PROJECT_SESSIONS_DIR_NAME, "web-state.sqlite"),
    legacySessionDbPath: path.join(root, LEGACY_PROJECT_SESSIONS_DIR_NAME, "web-state.sqlite"),
    agintiflowHome: globalPaths.home,
    globalEnvPath: path.join(globalPaths.home, ".env"),
    globalSessionsDir: globalPaths.sessionsDir,
    globalSessionIndexPath: globalPaths.indexDbPath,
    gitignorePath: path.join(root, ".gitignore"),
  };
}

export function sessionStoreOptions(projectRoot = process.cwd(), sessionId = "") {
  const paths = projectPaths(projectRoot);
  return {
    projectRoot: paths.root,
    commandCwd: paths.root,
    projectSessionsDir: paths.sessionsDir,
    legacySessionDir: sessionId ? path.join(paths.legacySessionsDir, sessionId) : "",
  };
}

export async function ensureProjectSessionStorage(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);
  await fsp.mkdir(paths.sessionsDir, { recursive: true });
  await fsp.mkdir(paths.globalSessionsDir, { recursive: true });
  await ensureLine(paths.gitignorePath, [
    ".aginti-sessions/",
    ".sessions/",
  ]).catch(() => {});

  const legacyEntries = await fsp.readdir(paths.legacySessionsDir, { withFileTypes: true }).catch(() => []);
  if (legacyEntries.length > 0) {
    for (const entry of legacyEntries) {
      if (!entry.isDirectory() || !isSafeSessionId(entry.name)) continue;
      const legacyDir = path.join(paths.legacySessionsDir, entry.name);
      const legacyStatePath = path.join(legacyDir, "state.json");
      const state = await fsp.readFile(legacyStatePath, "utf8").then(JSON.parse).catch(() => null);
      if (!state?.sessionId && !state?.createdAt) continue;

      const sessionId = isSafeSessionId(state.sessionId) ? state.sessionId : entry.name;
      const globalDir = path.join(paths.globalSessionsDir, sessionId);
      const globalStatePath = path.join(globalDir, "state.json");
      const hasGlobalState = await fsp.stat(globalStatePath).then((stat) => stat.isFile()).catch(() => false);
      if (!hasGlobalState) {
        await fsp.mkdir(path.dirname(globalDir), { recursive: true });
        await fsp.cp(legacyDir, globalDir, { recursive: true, force: false, errorOnExist: false });
      }

      const pointerDir = path.join(paths.sessionsDir, sessionId);
      await fsp.mkdir(pointerDir, { recursive: true });
      const pointer = {
        sessionId,
        projectRoot: paths.root,
        commandCwd: state.commandCwd || paths.root,
        sessionDir: globalDir,
        artifactsDir: path.join(globalDir, "artifacts"),
        createdAt: state.createdAt || state.startedAt || "",
        updatedAt: state.updatedAt || state.createdAt || "",
        title: state.title || "",
        goal: state.goal || "",
        provider: state.provider || "",
        model: state.model || "",
        migratedFrom: legacyDir,
      };
      await fsp.writeFile(path.join(pointerDir, "session.json"), `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
      try {
        upsertSessionIndex({
          ...state,
          sessionId,
          projectRoot: paths.root,
          commandCwd: state.commandCwd || paths.root,
          projectSessionsDir: paths.sessionsDir,
          sessionDir: globalDir,
          status: state.status || "saved",
        });
      } catch {
        // Migration should still leave readable pointers even if the global index is unavailable.
      }
    }
  }

  const hasNewDb = await fsp.stat(paths.sessionDbPath).then((stat) => stat.isFile()).catch(() => false);
  const hasLegacyDb = await fsp.stat(paths.legacySessionDbPath).then((stat) => stat.isFile()).catch(() => false);
  if (!hasNewDb && hasLegacyDb) {
    await fsp.copyFile(paths.legacySessionDbPath, paths.sessionDbPath).catch(() => {});
  }

  return paths;
}

export function defaultAgintiInstructions(template = "disciplined") {
  return buildAgintiInstructions(template);
}

export async function readProjectInstructions(projectRoot = process.cwd(), { maxBytes = 24_000 } = {}) {
  const paths = projectPaths(projectRoot);
  try {
    const stat = await fsp.stat(paths.agintiInstructionsPath);
    if (!stat.isFile()) return { exists: false, path: paths.agintiInstructionsPath, content: "", truncated: false };
    const handle = await fsp.open(paths.agintiInstructionsPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return {
        exists: true,
        path: paths.agintiInstructionsPath,
        content: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: stat.size > maxBytes,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { exists: false, path: paths.agintiInstructionsPath, content: "", truncated: false };
  }
}

export function parseEnvText(text = "") {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (!LOCAL_ENV_KEYS.has(key)) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function ensureSecretGitignoreLinesSync(gitignorePath) {
  const lines = [".aginti/.env", ".aginti/.env.*", "!.aginti/.env.example"];
  let current = "";
  try {
    current = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    current = "";
  }
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = lines.filter((line) => !existing.has(line));
  if (missing.length === 0) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(gitignorePath, `${current}${prefix}${missing.join("\n")}\n`, "utf8");
}

function envTextFromParsed(parsed = {}) {
  return Object.entries(parsed)
    .filter(([key]) => LOCAL_ENV_KEYS.has(key))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
}

export function loadProjectEnv(projectRoot = process.cwd(), { override = false } = {}) {
  const paths = projectPaths(projectRoot);
  const originalEnvKeys = new Set(
    [...LOCAL_ENV_KEYS].filter((key) => String(process.env[key] || "").trim())
  );
  const envPaths = [paths.globalEnvPath, paths.rootEnvPath, paths.envPath];
  const loadedPaths = [];
  for (const envPath of envPaths) {
    try {
      const parsed = parseEnvText(fs.readFileSync(envPath, "utf8"));
      if (Object.keys(parsed).length === 0) continue;
      const isProjectEnv = envPath === paths.rootEnvPath || envPath === paths.envPath;
      for (const [key, value] of Object.entries(parsed)) {
        if (override || !process.env[key] || (isProjectEnv && !originalEnvKeys.has(key))) {
          process.env[key] = value;
        }
      }
      loadedPaths.push(envPath);
    } catch {
      // Ignore missing or unreadable optional local env files.
    }
  }
  return {
    loaded: loadedPaths.length > 0,
    path: paths.envPath,
    paths: loadedPaths,
    globalEnv: loadedPaths.includes(paths.globalEnvPath),
    globalEnvPath: paths.globalEnvPath,
    projectEnv: loadedPaths.includes(paths.rootEnvPath) || loadedPaths.includes(paths.envPath),
    projectEnvPaths: loadedPaths.filter((item) => item === paths.rootEnvPath || item === paths.envPath),
    // Kept for API compatibility. Environment discovery is read-only; only
    // explicit `keys set` / `auth` actions may write credential files.
    ambientPersisted: false,
    ambientKeys: [],
  };
}

async function ensureLine(filePath, lines) {
  const desired = Array.isArray(lines) ? lines : [lines];
  let current = "";
  try {
    current = await fsp.readFile(filePath, "utf8");
  } catch {
    current = "";
  }

  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = desired.filter((line) => !existing.has(line));
  if (missing.length === 0) return { changed: false, path: filePath };

  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await fsp.writeFile(filePath, `${current}${prefix}${missing.join("\n")}\n`, "utf8");
  return { changed: true, path: filePath, added: missing };
}

export async function initProject(projectRoot = process.cwd(), { template = "disciplined" } = {}) {
  const paths = projectPaths(projectRoot);
  const instructionTemplate = normalizeInstructionTemplate(template);
  const created = [];
  const updated = [];
  const skipped = [];

  async function ensureDir(dirPath) {
    const existed = await fsp.stat(dirPath).then(() => true).catch(() => false);
    await fsp.mkdir(dirPath, { recursive: true });
    (existed ? skipped : created).push(dirPath);
  }

  async function ensureFile(filePath, content, mode) {
    const existed = await fsp.stat(filePath).then(() => true).catch(() => false);
    if (!existed) {
      await fsp.writeFile(filePath, content, mode ? { mode } : "utf8");
      created.push(filePath);
    } else {
      skipped.push(filePath);
    }
  }

  await ensureDir(paths.controlDir);
  await ensureDir(paths.notesDir);
  await ensureDir(paths.sessionsDir);
  await fsp.mkdir(paths.globalSessionsDir, { recursive: true });
  await ensureFile(
    paths.agintiInstructionsPath,
    defaultAgintiInstructions(instructionTemplate)
  );
  await ensureFile(
    paths.controlReadmePath,
    [
      "# AgInTi Project Control",
      "",
      "This folder stores project-local AgInTiFlow configuration.",
      "",
      "- `../AGINTI.md` stores editable project instructions for CLI and web agents.",
      "- `.env` is ignored and can hold local provider keys.",
      "- `.env.example` documents accepted variable names.",
      "- `codebase-map.json` is a generated, ignored project-intelligence cache.",
      "- `../.aginti-sessions/` stores project-local session pointers and the web UI database.",
      "- `~/.agintiflow/sessions/<session-id>/` stores canonical session history and artifacts.",
      "",
    ].join("\n")
  );
  await ensureFile(
    paths.envExamplePath,
    [
      "# Copy values into .aginti/.env. Never commit real secrets.",
      "# Account-wide defaults can be saved with `aginti auth`; this project file overrides them.",
      "AGINTI_LOCALLLM_BASE_URL=http://127.0.0.1:8008/v1",
      "AGINTI_LOCALLLM_API_KEY=local-dev-key",
      "AGINTI_LOCALLLM_ROUTE_MODEL=localllm-fast",
      "AGINTI_LOCALLLM_MAIN_MODEL=localllm-deep",
      "AGINTI_LOCALLLM_CODE_MODEL=localllm-code",
      "AGINTI_LOCALLLM_MAX_MODEL=localllm-max",
      "AGINTI_LOCALLLM_VISION_MODEL=localllm-vision-xl",
      "AGINTI_LOCALLLM_CONTEXT_TOKENS=32768",
      "AGINTI_LOCALLLM_MAX_OUTPUT_TOKENS=8192",
      "AGINTI_LOCALLLM_TOOL_SCHEMA_TOKENS=4096",
      "AGINTI_LOCALLLM_ALLOW_AUTO_MAX=false",
      "DEEPSEEK_API_KEY=",
      "OPENAI_API_KEY=",
      "OPENAI_BASE_URL=https://api.openai.com/v1",
      "OPENAI_DEFAULT_MODEL=gpt-5.4-mini",
      "OPENROUTER_API_KEY=",
      "OPENROUTER_BASE_URL=https://openrouter.ai/api/v1",
      "OPENROUTER_MODEL=openrouter/auto",
      "OPENROUTER_HTTP_REFERER=",
      "OPENROUTER_APP_TITLE=AgInTiFlow",
      "QWEN_API_KEY=",
      "VENICE_API_KEY=",
      "VENICE_API_BASE=https://api.venice.ai/api/v1",
      "VENICE_CHAT_ENDPOINT=/chat/completions",
      "VENICE_MODEL=venice-uncensored-1-2",
      "VENICE_IMAGE_MODEL=nano-banana-2",
      "GRSAI=",
      "DEEPSEEK_FAST_MODEL=deepseek-v4-flash",
      "DEEPSEEK_PRO_MODEL=deepseek-v4-pro",
      "AGENT_ROUTING_MODE=smart",
      "AGINTI_ROUTE_PROVIDER=",
      "AGINTI_ROUTE_MODEL=",
      "AGINTI_ROUTE_REASONING=provider-default",
      "AGINTI_MAIN_PROVIDER=",
      "AGINTI_MAIN_MODEL=",
      "AGINTI_MAIN_REASONING=provider-default",
      "AGINTI_SPARE_PROVIDER=localllm",
      "AGINTI_SPARE_MODEL=localllm-deep",
      "AGINTI_SPARE_REASONING=medium",
      "AGINTI_ALLOW_HOSTED_IMAGE_PERCEPTION=false",
      "AGINTI_ALLOW_HOSTED_WEB_RESEARCH=false",
      "AGINTI_ALLOW_HOSTED_JSON_SPECIALIST=false",
      "AGINTI_WRITING_PROVIDER=",
      "AGINTI_WRITING_MODEL=",
      "AGINTI_ALLOW_HOSTED_WRITING_SPECIALIST=false",
      "",
    ].join("\n")
  );
  await ensureFile(
    paths.notesReadmePath,
    [
      "# Notes",
      "",
      "Use this folder for agent-generated notes, drafts, and smoke-test files.",
      "",
    ].join("\n")
  );

  const gitignore = await ensureLine(paths.gitignorePath, [
    ".env",
    ".env.*",
    ".aginti/.env",
    ".aginti/.env.*",
    "!.aginti/.env.example",
    ".aginti/codebase-map.json",
    ".aginti-sessions/",
    ".sessions/",
  ]);
  if (gitignore.changed) updated.push(paths.gitignorePath);
  else skipped.push(paths.gitignorePath);

  await ensureProjectSessionStorage(projectRoot);

  return {
    ok: true,
    projectRoot: paths.root,
    instructionsPath: paths.agintiInstructionsPath,
    controlDir: paths.controlDir,
    sessionsDir: paths.sessionsDir,
    created,
    updated,
    skipped,
    template: instructionTemplate,
  };
}

export function providerKeyStatus(projectRoot = process.cwd()) {
  const env = loadProjectEnv(projectRoot);
  return {
    localllm: true,
    openai: Boolean(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    qwen: Boolean(process.env.QWEN_API_KEY),
    venice: Boolean(process.env.VENICE_API_KEY),
    grsai: Boolean(process.env.GRSAI || process.env.GRSAI_API_KEY),
    mock: true,
    localEnv: env.loaded,
    globalEnv: env.globalEnv,
    projectEnv: env.projectEnv,
    localEnvPath: env.path,
    globalEnvPath: env.globalEnvPath,
    ambientPersisted: env.ambientPersisted,
    ambientKeys: env.ambientKeys,
    envVars: {
      localllm: ["AGINTI_LOCALLLM_BASE_URL", "LOCALLLM_BASE_URL", "LOCAL_LLM_BASE_URL", "AGINTI_LOCALLLM_MODEL", "LOCALLLM_MODEL", "LOCAL_LLM_MODEL"],
      openai: ["OPENAI_API_KEY", "LLM_API_KEY"],
      deepseek: ["DEEPSEEK_API_KEY", "LLM_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      qwen: ["QWEN_API_KEY"],
      venice: ["VENICE_API_KEY"],
      grsai: ["GRSAI", "GRSAI_API_KEY"],
    },
  };
}

export function maskProviderKey(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 8) return `${text.slice(0, 1)}…${text.slice(-1)} (${text.length} chars)`;
  return `${text.slice(0, 4)}…${text.slice(-4)} (${text.length} chars)`;
}

export function providerKeyPreview(projectRoot = process.cwd(), provider = "") {
  loadProjectEnv(projectRoot);
  const normalized = String(provider || "").trim().toLowerCase();
  const aliases = {
    auxiliary: "grsai",
    image: "grsai",
    imagegen: "grsai",
    or: "openrouter",
    router: "openrouter",
    "open-router": "openrouter",
    local: "localllm",
    "local-llm": "localllm",
    local_llm: "localllm",
    localllm: "localllm",
    v: "venice",
    venice: "venice",
  };
  const canonical = aliases[normalized] || normalizeProviderId(normalized, normalized);
  if (canonical === "localllm" && !providerRequiresApiKey(canonical)) {
    return {
      available: true,
      provider: canonical,
      keyName: "",
      preview: "no API key required",
      length: 0,
    };
  }
  const keys = PROVIDER_KEY_CANDIDATES[canonical] || [];
  for (const keyName of keys) {
    const value = process.env[keyName];
    if (value) {
      return {
        available: true,
        provider: canonical,
        keyName,
        preview: maskProviderKey(value),
        length: String(value).trim().length,
      };
    }
  }
  return {
    available: false,
    provider: canonical,
    keyName: keys[0] || "",
    preview: "",
    length: 0,
  };
}

export async function setProviderKey(projectRoot, provider, value, options = {}) {
  const normalizedProvider = String(provider || "").toLowerCase();
  const aliases = {
    auxiliary: "grsai",
    image: "grsai",
    imagegen: "grsai",
    or: "openrouter",
    router: "openrouter",
    "open-router": "openrouter",
    local: "localllm",
    "local-llm": "localllm",
    local_llm: "localllm",
    localllm: "localllm",
    v: "venice",
    venice: "venice",
  };
  const canonicalProvider = aliases[normalizedProvider] || normalizedProvider;
  const keyName =
    canonicalProvider === "localllm"
      ? "AGINTI_LOCALLLM_API_KEY"
      : canonicalProvider === "openai"
      ? "OPENAI_API_KEY"
      : canonicalProvider === "qwen"
        ? "QWEN_API_KEY"
        : canonicalProvider === "openrouter"
          ? "OPENROUTER_API_KEY"
          : canonicalProvider === "venice"
            ? "VENICE_API_KEY"
            : canonicalProvider === "grsai"
              ? "GRSAI"
              : "DEEPSEEK_API_KEY";
  if (!["localllm", "deepseek", "openai", "openrouter", "qwen", "venice", "grsai"].includes(canonicalProvider)) {
    throw new Error("Provider must be localllm, deepseek, openai, openrouter, qwen, venice, or grsai.");
  }

  const keyValue = String(value || "").trim();
  if (!keyValue) throw new Error("Key value is required.");

  const paths = projectPaths(projectRoot);
  const requestedScope = String(options.scope || process.env.AGINTI_KEY_SCOPE || process.env.AGINTIFLOW_KEY_SCOPE || "global").toLowerCase();
  const scope = ["project", "local"].includes(requestedScope) ? "project" : "global";
  const targetPath = scope === "project" ? paths.envPath : paths.globalEnvPath;
  if (scope === "project") {
    await fsp.mkdir(paths.controlDir, { recursive: true });
    await ensureLine(paths.gitignorePath, [
      ".aginti/.env",
      ".aginti/.env.*",
      "!.aginti/.env.example",
    ]);
  }
  let parsed = {};
  try {
    parsed = parseEnvText(await fsp.readFile(targetPath, "utf8"));
  } catch {
    parsed = {};
  }
  parsed[keyName] = keyValue;
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, `${envTextFromParsed(parsed)}\n`, { mode: 0o600 });
  await fsp.chmod(targetPath, 0o600).catch(() => {});
  loadProjectEnv(projectRoot, { override: true });
  return {
    ok: true,
    provider: canonicalProvider,
    keyName,
    path: targetPath,
    scope,
  };
}

function normalizeSessionListOptions(projectRoot, limitOrOptions = 50) {
  const options = typeof limitOrOptions === "object" && limitOrOptions !== null ? limitOrOptions : { limit: limitOrOptions };
  const root = resolveProjectRoot(projectRoot);
  const commandCwd = options.commandCwd === false ? "" : path.resolve(options.commandCwd || root);
  return {
    limit: Math.min(Math.max(Number(options.limit) || 50, 1), 1000),
    commandCwd,
    allSessions: Boolean(options.allSessions),
  };
}

function sessionMatchesCommandCwd(session, commandCwd = "") {
  if (!commandCwd) return true;
  const value = session.commandCwd || session.projectRoot || "";
  if (!value) return false;
  return path.resolve(value) === path.resolve(commandCwd);
}

export async function listProjectSessions(projectRoot = process.cwd(), limitOrOptions = 50) {
  const options = normalizeSessionListOptions(projectRoot, limitOrOptions);
  const paths = await ensureProjectSessionStorage(projectRoot);
  const indexed = (() => {
    try {
      return listSessionIndex({
        projectRoot: options.allSessions ? "" : paths.root,
        commandCwd: options.allSessions ? "" : options.commandCwd,
        limit: Math.max(options.limit, 100),
      });
    } catch {
      return [];
    }
  })();
  const byId = new Map();
  for (const session of indexed) {
    if (session.sessionId) byId.set(session.sessionId, session);
  }

  const entries = await fsp.readdir(paths.sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSessionId(entry.name)) continue;
    const pointerPath = path.join(paths.sessionsDir, entry.name, "session.json");
    const pointer = await fsp.readFile(pointerPath, "utf8").then(JSON.parse).catch(() => ({}));
    const statePath = path.join(pointer.sessionDir || path.join(paths.globalSessionsDir, entry.name), "state.json");
    const state = await fsp.readFile(statePath, "utf8").then(JSON.parse).catch(() => null);
    const sessionId = state?.sessionId || pointer.sessionId || entry.name;
    if (!sessionId) continue;
    const record = {
      ...byId.get(sessionId),
      sessionId,
      projectRoot: paths.root,
      commandCwd: state?.commandCwd || pointer.commandCwd || paths.root,
      sessionDir: pointer.sessionDir || path.join(paths.globalSessionsDir, sessionId),
      provider: state?.provider || pointer.provider || byId.get(sessionId)?.provider || "",
      model: state?.model || pointer.model || byId.get(sessionId)?.model || "",
      goal: state?.goal || pointer.goal || byId.get(sessionId)?.goal || "",
      goalRevision: Number(state?.meta?.goalContract?.revision || byId.get(sessionId)?.goalRevision || 0),
      goalStatus: String(state?.meta?.goalContract?.status || byId.get(sessionId)?.goalStatus || ""),
      title: state?.title || pointer.title || byId.get(sessionId)?.title || "",
      createdAt: state?.createdAt || pointer.createdAt || byId.get(sessionId)?.createdAt || "",
      updatedAt: state?.updatedAt || pointer.updatedAt || byId.get(sessionId)?.updatedAt || state?.createdAt || "",
      stepsCompleted: state?.stepsCompleted || 0,
    };
    if (!options.allSessions && !sessionMatchesCommandCwd(record, options.commandCwd)) continue;
    byId.set(sessionId, record);
    try {
      upsertSessionIndex({
        ...record,
        projectSessionsDir: paths.sessionsDir,
        status: record.status || "saved",
      });
    } catch {
      // Project pointer scanning should not fail when the optional global index is unavailable.
    }
  }

  const sessions = [...byId.values()];
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, options.limit);
}

async function readJsonFile(filePath, fallback = {}) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readJsonLines(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function countFilesRecursive(dirPath, limit = 200) {
  let count = 0;
  async function walk(current) {
    if (count >= limit) return;
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (count >= limit) return;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) count += 1;
    }
  }
  await walk(dirPath);
  return count;
}

function isMeaningfulSessionEvent(event = {}) {
  const type = String(event.type || "");
  if (!type) return false;
  return /^(agent|assistant|browser|canvas|conversation|file|image|model|patch|plan|run|shell|tool|workspace|write)[.:_-]/.test(type);
}

export async function listProjectSessionRemovalCandidates(projectRoot = process.cwd(), options = {}) {
  const paths = await ensureProjectSessionStorage(projectRoot);
  const sessions = await listProjectSessions(projectRoot, {
    limit: options.limit || 1000,
    commandCwd: options.commandCwd,
    allSessions: options.allSessions,
  });
  const candidates = [];
  for (const session of sessions) {
    const safeId = String(session.sessionId || "");
    if (!isSafeSessionId(safeId)) continue;
    const pointerPath = path.join(paths.sessionsDir, safeId, "session.json");
    const pointer = await readJsonFile(pointerPath, {});
    const sessionDir = session.sessionDir || pointer.sessionDir || path.join(paths.globalSessionsDir, safeId);
    const state = await readJsonFile(path.join(sessionDir, "state.json"), {});
    const events = await readJsonLines(path.join(sessionDir, "events.jsonl"));
    const chat = Array.isArray(state.chat) ? state.chat : [];
    const goal = String(state.goal || pointer.goal || session.goal || "").trim();
    const title = String(state.title || pointer.title || session.title || "").trim();
    const stepsCompleted = Number(state.stepsCompleted || 0);
    const artifactsDir = state.artifactsDir || pointer.artifactsDir || path.join(sessionDir, "artifacts");
    const artifactFileCount = await countFilesRecursive(artifactsDir);
    const meaningfulEventCount = events.filter(isMeaningfulSessionEvent).length;
    const isEmpty =
      !goal &&
      !title &&
      chat.length === 0 &&
      stepsCompleted === 0 &&
      artifactFileCount === 0 &&
      meaningfulEventCount === 0;
    candidates.push({
      ...session,
      sessionId: safeId,
      sessionDir,
      pointerPath,
      chatCount: chat.length,
      eventCount: events.length,
      meaningfulEventCount,
      artifactFileCount,
      stepsCompleted,
      isEmpty,
    });
  }
  return options.emptyOnly ? candidates.filter((session) => session.isEmpty) : candidates;
}

export async function removeProjectSessions(projectRoot = process.cwd(), sessionIds = []) {
  const paths = await ensureProjectSessionStorage(projectRoot);
  const removed = [];
  for (const rawId of sessionIds) {
    const safeId = String(rawId || "");
    if (!isSafeSessionId(safeId)) throw new Error(`Invalid session id: ${rawId}`);
    const pointerDir = path.join(paths.sessionsDir, safeId);
    const pointer = await readJsonFile(path.join(pointerDir, "session.json"), {});
    const sessionDir = pointer.sessionDir || path.join(paths.globalSessionsDir, safeId);
    const legacyDir = path.join(paths.legacySessionsDir, safeId);
    await fsp.rm(sessionDir, { recursive: true, force: true });
    await fsp.rm(pointerDir, { recursive: true, force: true });
    await fsp.rm(legacyDir, { recursive: true, force: true }).catch(() => {});
    try {
      deleteSessionIndex(safeId);
    } catch {
      // The on-disk session and pointer are already removed; stale index cleanup can be retried later.
    }
    removed.push({ sessionId: safeId, sessionDir, pointerDir });
  }
  return { ok: true, removed };
}

export async function showProjectSession(projectRoot, sessionId) {
  const paths = await ensureProjectSessionStorage(projectRoot);
  const safeId = String(sessionId || "");
  if (!isSafeSessionId(safeId)) {
    throw new Error("Invalid session id.");
  }
  const pointer = await fsp.readFile(path.join(paths.sessionsDir, safeId, "session.json"), "utf8").then(JSON.parse).catch(() => ({}));
  const sessionDir = pointer.sessionDir || path.join(paths.globalSessionsDir, safeId);
  const state = JSON.parse(await fsp.readFile(path.join(sessionDir, "state.json"), "utf8"));
  let events = [];
  try {
    const raw = await fsp.readFile(path.join(sessionDir, "events.jsonl"), "utf8");
    events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    events = [];
  }
  return {
    sessionId: state.sessionId || safeId,
    provider: state.provider || "",
    model: state.model || "",
    goal: state.goal || "",
    goalRevision: Number(state.meta?.goalContract?.revision || 0),
    goalStatus: String(state.meta?.goalContract?.status || ""),
    goalHistory: (Array.isArray(state.meta?.goalContract?.history) ? state.meta.goalContract.history : []).map((entry) => ({
      revision: Number(entry?.revision || 0),
      kind: String(entry?.kind || ""),
      at: String(entry?.at || ""),
      preview: String(entry?.preview || ""),
    })),
    goalLifecycle: (Array.isArray(state.meta?.goalContract?.lifecycle) ? state.meta.goalContract.lifecycle : []).map((entry) => ({
      revision: Number(entry?.revision || 0),
      status: String(entry?.status || ""),
      reason: String(entry?.reason || ""),
      at: String(entry?.at || ""),
    })),
    title: state.title || pointer.title || "",
    commandCwd: state.commandCwd || pointer.commandCwd || paths.root,
    createdAt: state.createdAt || "",
    updatedAt: state.updatedAt || "",
    chat: state.chat || [],
    events: events.slice(-80),
  };
}

export async function renameProjectSession(projectRoot, sessionId, title) {
  const paths = await ensureProjectSessionStorage(projectRoot);
  const safeId = String(sessionId || "");
  if (!isSafeSessionId(safeId)) throw new Error("Invalid session id.");
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 90);
  if (!cleanTitle) throw new Error("Title is required.");
  const pointerPath = path.join(paths.sessionsDir, safeId, "session.json");
  const pointer = await fsp.readFile(pointerPath, "utf8").then(JSON.parse).catch(() => ({}));
  const sessionDir = pointer.sessionDir || path.join(paths.globalSessionsDir, safeId);
  const statePath = path.join(sessionDir, "state.json");
  const state = await fsp.readFile(statePath, "utf8").then(JSON.parse).catch(() => ({}));
  const updatedAt = new Date().toISOString();
  const nextState = {
    ...state,
    sessionId: state.sessionId || safeId,
    title: cleanTitle,
    updatedAt,
  };
  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  const nextPointer = {
    ...pointer,
    sessionId: safeId,
    projectRoot: paths.root,
    commandCwd: nextState.commandCwd || pointer.commandCwd || paths.root,
    sessionDir,
    artifactsDir: path.join(sessionDir, "artifacts"),
    title: cleanTitle,
    updatedAt,
    goal: nextState.goal || pointer.goal || "",
    provider: nextState.provider || pointer.provider || "",
    model: nextState.model || pointer.model || "",
  };
  await fsp.mkdir(path.dirname(pointerPath), { recursive: true });
  await fsp.writeFile(pointerPath, `${JSON.stringify(nextPointer, null, 2)}\n`, "utf8");
  try {
    renameSessionIndex(safeId, cleanTitle);
    upsertSessionIndex({
      ...nextState,
      sessionId: safeId,
      title: cleanTitle,
      projectRoot: paths.root,
      commandCwd: nextState.commandCwd || pointer.commandCwd || paths.root,
      projectSessionsDir: paths.sessionsDir,
      sessionDir,
      status: nextState.status || "saved",
    });
  } catch {
    // The title is still persisted in state.json and the project pointer.
  }
  return { ok: true, sessionId: safeId, title: cleanTitle, sessionDir };
}

export async function npmLatestVersion(packageName = "@lazyingart/agintiflow") {
  try {
    const { stdout } = await execFileAsync("npm", ["view", packageName, "version", "--json"], {
      timeout: 6000,
      maxBuffer: 100 * 1024,
      env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    });
    return JSON.parse(stdout.trim());
  } catch {
    return "";
  }
}

export async function doctorReport(projectRoot, packageVersion, config) {
  const paths = projectPaths(projectRoot);
  const keyStatus = providerKeyStatus(projectRoot);
  const platform = platformInfo();
  const sqliteStatus = nodeSqliteStatus();
  const [sessions, dockerStatus, latestVersion, instructions] = await Promise.all([
    listProjectSessions(projectRoot, 8),
    getDockerSandboxStatus(config).catch((error) => ({ ok: false, error: error.message })),
    npmLatestVersion(),
    readProjectInstructions(projectRoot, { maxBytes: 1 }),
  ]);

  return {
    ok: true,
    package: {
      name: "@lazyingart/agintiflow",
      version: packageVersion,
      npmLatest: latestVersion || "unknown",
    },
    node: {
      version: process.version,
      ok: Number(process.versions.node.split(".")[0]) >= 22,
      sqlite: sqliteStatus,
      recovery: sqliteStatus.ok ? [] : nodeSqliteRecoveryLines(sqliteStatus),
    },
    platform: {
      ...platform,
      label: platformLabel(platform),
      setupHints: platformSetupHints(platform),
    },
    project: {
      root: paths.root,
      instructionsPath: paths.agintiInstructionsPath,
      instructionsPresent: instructions.exists,
      controlDir: paths.controlDir,
      sessionsDir: paths.sessionsDir,
      sessionDbPath: paths.sessionDbPath,
      globalSessionsDir: paths.globalSessionsDir,
      globalSessionIndexPath: paths.globalSessionIndexPath,
      localEnvPresent: keyStatus.localEnv,
      globalEnvPresent: keyStatus.globalEnv,
      projectEnvPresent: keyStatus.projectEnv,
    },
    keys: {
      openai: keyStatus.openai,
      deepseek: keyStatus.deepseek,
      openrouter: keyStatus.openrouter,
      qwen: keyStatus.qwen,
      venice: keyStatus.venice,
      grsai: keyStatus.grsai,
      globalEnv: keyStatus.globalEnv,
      projectEnv: keyStatus.projectEnv,
      mock: true,
    },
    sandbox: dockerStatus,
    wrappers: listAgentWrappers().map((wrapper) => ({
      name: wrapper.name,
      label: wrapper.label,
      available: wrapper.available,
    })),
    sessions,
  };
}
