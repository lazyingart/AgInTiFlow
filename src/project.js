import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listAgentWrappers } from "./tool-wrappers.js";
import { getDockerSandboxStatus } from "./docker-sandbox.js";
import { platformInfo, platformLabel, platformSetupHints } from "./platform.js";
import {
  LEGACY_PROJECT_SESSIONS_DIR_NAME,
  PROJECT_SESSIONS_DIR_NAME,
  globalSessionPaths,
  isSafeSessionId,
  listSessionIndex,
  renameSessionIndex,
  upsertSessionIndex,
} from "./session-index.js";

const execFileAsync = promisify(execFile);
const LOCAL_ENV_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "DEEPSEEK_FAST_MODEL",
  "DEEPSEEK_PRO_MODEL",
  "OPENAI_DEFAULT_MODEL",
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
  openai: ["OPENAI_API_KEY", "LLM_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY", "LLM_API_KEY"],
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
    globalSessionsDir: globalPaths.sessionsDir,
    globalSessionIndexPath: globalPaths.indexDbPath,
    gitignorePath: path.join(root, ".gitignore"),
  };
}

export function sessionStoreOptions(projectRoot = process.cwd(), sessionId = "") {
  const paths = projectPaths(projectRoot);
  return {
    projectRoot: paths.root,
    projectSessionsDir: paths.sessionsDir,
    legacySessionDir: sessionId ? path.join(paths.legacySessionsDir, sessionId) : "",
  };
}

export async function ensureProjectSessionStorage(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);
  await fsp.mkdir(paths.sessionsDir, { recursive: true });
  await fsp.mkdir(paths.globalSessionsDir, { recursive: true });

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

export function defaultAgintiInstructions() {
  return [
    "# AGINTI.md",
    "",
    "Project instructions for AgInTiFlow agents.",
    "",
    "Edit this file directly or ask AgInTiFlow to update it during chat. Keep durable project preferences here; keep secrets in `.aginti/.env` instead.",
    "",
    "## Project Goals",
    "",
    "- Describe what this project is for.",
    "- Note the main user-facing workflows the agent should preserve.",
    "",
    "## Agent Preferences",
    "",
    "- Prefer small, inspectable changes over broad rewrites.",
    "- Read relevant files before editing.",
    "- Run focused checks when tools and dependencies are available.",
    "- Keep generated artifacts in project folders with clear names.",
    "",
    "## Useful Commands",
    "",
    "- Add build, test, lint, preview, or compile commands here.",
    "",
    "## Notes",
    "",
    "- Add project-specific terminology, style preferences, and known constraints here.",
    "",
  ].join("\n");
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

export function loadProjectEnv(projectRoot = process.cwd(), { override = false } = {}) {
  const paths = projectPaths(projectRoot);
  const envPaths = [paths.rootEnvPath, paths.envPath];
  const loadedPaths = [];
  for (const envPath of envPaths) {
    try {
      const parsed = parseEnvText(fs.readFileSync(envPath, "utf8"));
      if (Object.keys(parsed).length === 0) continue;
      for (const [key, value] of Object.entries(parsed)) {
        if (override || !process.env[key]) process.env[key] = value;
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

export async function initProject(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);
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
    defaultAgintiInstructions()
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
      "DEEPSEEK_API_KEY=",
      "OPENAI_API_KEY=",
      "QWEN_API_KEY=",
      "VENICE_API_KEY=",
      "VENICE_API_BASE=https://api.venice.ai/api/v1",
      "VENICE_CHAT_ENDPOINT=/chat/completions",
      "VENICE_MODEL=venice-uncensored-1-2",
      "VENICE_IMAGE_MODEL=nano-banana-2",
      "GRSAI=",
      "DEEPSEEK_FAST_MODEL=deepseek-v4-flash",
      "DEEPSEEK_PRO_MODEL=deepseek-v4-pro",
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
  };
}

export function providerKeyStatus(projectRoot = process.cwd()) {
  const env = loadProjectEnv(projectRoot);
  return {
    openai: Boolean(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY),
    qwen: Boolean(process.env.QWEN_API_KEY),
    venice: Boolean(process.env.VENICE_API_KEY),
    grsai: Boolean(process.env.GRSAI || process.env.GRSAI_API_KEY),
    mock: true,
    localEnv: env.loaded,
    localEnvPath: env.path,
    envVars: {
      openai: ["OPENAI_API_KEY", "LLM_API_KEY"],
      deepseek: ["DEEPSEEK_API_KEY", "LLM_API_KEY"],
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
    v: "venice",
    venice: "venice",
  };
  const canonical = aliases[normalized] || normalized;
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

export async function setProviderKey(projectRoot, provider, value) {
  const normalizedProvider = String(provider || "").toLowerCase();
  const aliases = {
    auxiliary: "grsai",
    image: "grsai",
    imagegen: "grsai",
    v: "venice",
    venice: "venice",
  };
  const canonicalProvider = aliases[normalizedProvider] || normalizedProvider;
  const keyName =
    canonicalProvider === "openai"
      ? "OPENAI_API_KEY"
      : canonicalProvider === "qwen"
        ? "QWEN_API_KEY"
        : canonicalProvider === "venice"
          ? "VENICE_API_KEY"
          : canonicalProvider === "grsai"
            ? "GRSAI"
            : "DEEPSEEK_API_KEY";
  if (!["deepseek", "openai", "qwen", "venice", "grsai"].includes(canonicalProvider)) {
    throw new Error("Provider must be deepseek, openai, qwen, venice, or grsai.");
  }

  const keyValue = String(value || "").trim();
  if (!keyValue) throw new Error("Key value is required.");

  const paths = projectPaths(projectRoot);
  await fsp.mkdir(paths.controlDir, { recursive: true });
  await ensureLine(paths.gitignorePath, [
    ".aginti/.env",
    ".aginti/.env.*",
    "!.aginti/.env.example",
  ]);
  let parsed = {};
  try {
    parsed = parseEnvText(await fsp.readFile(paths.envPath, "utf8"));
  } catch {
    parsed = {};
  }
  parsed[keyName] = keyValue;
  const output = Object.entries(parsed)
    .filter(([key]) => LOCAL_ENV_KEYS.has(key))
    .map(([key, envValue]) => `${key}=${JSON.stringify(envValue)}`)
    .join("\n");
  await fsp.writeFile(paths.envPath, `${output}\n`, { mode: 0o600 });
  await fsp.chmod(paths.envPath, 0o600).catch(() => {});
  loadProjectEnv(projectRoot, { override: true });
  return {
    ok: true,
    provider: canonicalProvider,
    keyName,
    path: paths.envPath,
  };
}

export async function listProjectSessions(projectRoot = process.cwd(), limit = 50) {
  const paths = await ensureProjectSessionStorage(projectRoot);
  const indexed = (() => {
    try {
      return listSessionIndex({ projectRoot: paths.root, limit: Math.max(limit, 100) });
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
      title: state?.title || pointer.title || byId.get(sessionId)?.title || "",
      createdAt: state?.createdAt || pointer.createdAt || byId.get(sessionId)?.createdAt || "",
      updatedAt: state?.updatedAt || pointer.updatedAt || byId.get(sessionId)?.updatedAt || state?.createdAt || "",
      stepsCompleted: state?.stepsCompleted || 0,
    };
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
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
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
    },
    keys: {
      openai: keyStatus.openai,
      deepseek: keyStatus.deepseek,
      qwen: keyStatus.qwen,
      venice: keyStatus.venice,
      grsai: keyStatus.grsai,
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
