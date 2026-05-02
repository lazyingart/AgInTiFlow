import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listAgentWrappers } from "./tool-wrappers.js";
import { getDockerSandboxStatus } from "./docker-sandbox.js";

const execFileAsync = promisify(execFile);
const LOCAL_ENV_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "DEEPSEEK_FAST_MODEL",
  "DEEPSEEK_PRO_MODEL",
  "OPENAI_DEFAULT_MODEL",
  "GRSAI",
  "GRSAI_API_KEY",
]);

export function resolveProjectRoot(input = process.cwd()) {
  return path.resolve(input || process.cwd());
}

export function projectPaths(projectRoot = process.cwd()) {
  const root = resolveProjectRoot(projectRoot);
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
    sessionsDir: path.join(root, ".sessions"),
    sessionDbPath: path.join(root, ".sessions", "web-state.sqlite"),
    gitignorePath: path.join(root, ".gitignore"),
  };
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
      "- `.sessions/` at the project root stores CLI and web run history.",
      "",
    ].join("\n")
  );
  await ensureFile(
    paths.envExamplePath,
    [
      "# Copy values into .aginti/.env. Never commit real secrets.",
      "DEEPSEEK_API_KEY=",
      "OPENAI_API_KEY=",
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
    ".sessions/",
  ]);
  if (gitignore.changed) updated.push(paths.gitignorePath);
  else skipped.push(paths.gitignorePath);

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
    grsai: Boolean(process.env.GRSAI || process.env.GRSAI_API_KEY),
    mock: true,
    localEnv: env.loaded,
    localEnvPath: env.path,
    envVars: {
      openai: ["OPENAI_API_KEY", "LLM_API_KEY"],
      deepseek: ["DEEPSEEK_API_KEY", "LLM_API_KEY"],
      qwen: ["QWEN_API_KEY"],
      grsai: ["GRSAI", "GRSAI_API_KEY"],
    },
  };
}

export async function setProviderKey(projectRoot, provider, value) {
  const normalizedProvider = String(provider || "").toLowerCase();
  const aliases = {
    auxiliary: "grsai",
    auxilliary: "grsai",
    image: "grsai",
    imagegen: "grsai",
  };
  const canonicalProvider = aliases[normalizedProvider] || normalizedProvider;
  const keyName =
    canonicalProvider === "openai"
      ? "OPENAI_API_KEY"
      : canonicalProvider === "qwen"
        ? "QWEN_API_KEY"
        : canonicalProvider === "grsai"
          ? "GRSAI"
          : "DEEPSEEK_API_KEY";
  if (!["deepseek", "openai", "qwen", "grsai"].includes(canonicalProvider)) {
    throw new Error("Provider must be deepseek, openai, qwen, or grsai.");
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
  const paths = projectPaths(projectRoot);
  const entries = await fsp.readdir(paths.sessionsDir, { withFileTypes: true }).catch(() => []);
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(paths.sessionsDir, entry.name, "state.json");
    try {
      const state = JSON.parse(await fsp.readFile(statePath, "utf8"));
      sessions.push({
        sessionId: state.sessionId || entry.name,
        provider: state.provider || "",
        model: state.model || "",
        goal: state.goal || "",
        createdAt: state.createdAt || "",
        updatedAt: state.updatedAt || state.createdAt || "",
        stepsCompleted: state.stepsCompleted || 0,
      });
    } catch {
      // Ignore malformed or unrelated session folders.
    }
  }
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
}

export async function showProjectSession(projectRoot, sessionId) {
  const paths = projectPaths(projectRoot);
  const safeId = String(sessionId || "");
  if (!/^[A-Za-z0-9._:-]+$/.test(safeId) || safeId.includes("..")) {
    throw new Error("Invalid session id.");
  }
  const sessionDir = path.join(paths.sessionsDir, safeId);
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
    createdAt: state.createdAt || "",
    updatedAt: state.updatedAt || "",
    chat: state.chat || [],
    events: events.slice(-80),
  };
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
    project: {
      root: paths.root,
      instructionsPath: paths.agintiInstructionsPath,
      instructionsPresent: instructions.exists,
      controlDir: paths.controlDir,
      sessionsDir: paths.sessionsDir,
      sessionDbPath: paths.sessionDbPath,
      localEnvPresent: keyStatus.localEnv,
    },
    keys: {
      openai: keyStatus.openai,
      deepseek: keyStatus.deepseek,
      qwen: keyStatus.qwen,
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
