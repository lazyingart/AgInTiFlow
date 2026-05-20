import fs from "node:fs";
import path from "node:path";
import { agintiflowHome } from "../session-index.js";

export const MCP_CONFIG_ENV = "AGINTIFLOW_MCP_CONFIG";
export const MCP_CONFIG_JSON_ENV = "AGINTIFLOW_MCP_CONFIG_JSON";
export const MCP_SERVERS_JSON_ENV = "AGINTIFLOW_MCP_SERVERS";

const SAFE_SERVER_NAME = /^[A-Za-z0-9_.-]{1,80}$/;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function expandHome(value = "") {
  const text = String(value || "");
  if (text === "~") return process.env.HOME || text;
  if (text.startsWith("~/")) return path.join(process.env.HOME || "", text.slice(2));
  return text;
}

function splitPathList(value = "") {
  return String(value || "")
    .split(new RegExp(`[${escapeRegExp(path.delimiter)},]`))
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readJsonFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 2_000_000) return { ok: false, path: filePath, warning: "not a small JSON file" };
    return { ok: true, path: filePath, json: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, path: filePath, missing: true };
    return { ok: false, path: filePath, warning: error instanceof Error ? error.message : String(error) };
  }
}

function parseJsonEnv(name) {
  const value = process.env[name];
  if (!value) return { ok: false, missing: true };
  try {
    return { ok: true, path: `env:${name}`, json: JSON.parse(value) };
  } catch (error) {
    return { ok: false, path: `env:${name}`, warning: error instanceof Error ? error.message : String(error) };
  }
}

export function defaultMcpConfigPaths(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot || process.cwd());
  return {
    globalPath: path.join(agintiflowHome(), "mcp.json"),
    projectPath: path.join(root, ".aginti", "mcp.json"),
  };
}

function normalizeMcpRoot(json) {
  if (!json || typeof json !== "object") return {};
  if (json.mcpServers && typeof json.mcpServers === "object") return json.mcpServers;
  if (json.servers && typeof json.servers === "object") return json.servers;
  return json;
}

function normalizeNumber(value, fallback, min = 100, max = 600_000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEnvMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = String(raw ?? "");
  }
  return env;
}

function normalizeHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = String(key || "").trim();
    if (!name || /[\r\n]/.test(name)) continue;
    headers[name] = String(raw ?? "");
  }
  return headers;
}

function normalizeServer(name, value, source, projectRoot) {
  const id = String(name || "").trim();
  if (!SAFE_SERVER_NAME.test(id)) {
    return { warning: `${source}: skipped invalid MCP server name ${JSON.stringify(id)}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { warning: `${source}: skipped MCP server ${id}; config must be an object` };
  }

  const rawTransport = String(value.transport || value.type || "").toLowerCase();
  const transport = rawTransport || (value.url ? "http" : value.command ? "stdio" : "");
  const enabled = value.enabled !== false && value.disabled !== true;
  const trust = String(value.trust || value.policy || (value.readOnly ? "read-only" : "untrusted")).toLowerCase();
  const cwd = value.cwd
    ? path.resolve(projectRoot || process.cwd(), expandHome(String(value.cwd)))
    : path.resolve(projectRoot || process.cwd());
  const base = {
    id,
    name: id,
    label: String(value.label || value.title || id).trim(),
    description: String(value.description || "").trim(),
    source,
    enabled,
    transport,
    trust,
    readOnly: value.readOnly === true || trust === "read-only",
    allowAllTools: value.allowAllTools === true || trust === "trusted",
    allowHostProcess: value.allowHostProcess === true || value.hostProcess === true || trust === "trusted",
    allowedTools: normalizeStringList(value.allowedTools || value.allowTools || value.allow),
    deniedTools: normalizeStringList(value.deniedTools || value.denyTools || value.deny),
    startupTimeoutMs: normalizeNumber(value.startupTimeoutMs || value.timeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
    requestTimeoutMs: normalizeNumber(value.requestTimeoutMs || value.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    cwd,
  };

  if (transport === "stdio") {
    const command = String(value.command || "").trim();
    if (!command) return { warning: `${source}: skipped MCP stdio server ${id}; command is required` };
    return {
      server: {
        ...base,
        transport: "stdio",
        command,
        args: Array.isArray(value.args) ? value.args.map((arg) => String(arg)) : [],
        env: normalizeEnvMap(value.env),
      },
    };
  }

  if (transport === "http" || transport === "streamable-http" || transport === "streamableHttp") {
    const url = String(value.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return { warning: `${source}: skipped MCP HTTP server ${id}; valid http(s) url is required` };
    return {
      server: {
        ...base,
        transport: "http",
        url,
        headers: normalizeHeaders(value.headers),
        sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
      },
    };
  }

  return { warning: `${source}: skipped MCP server ${id}; unsupported transport ${JSON.stringify(transport || "(missing)")}` };
}

function loadConfigSources(projectRoot) {
  const paths = defaultMcpConfigPaths(projectRoot);
  const sources = [
    readJsonFile(paths.globalPath),
    readJsonFile(paths.projectPath),
    ...splitPathList(process.env[MCP_CONFIG_ENV]).map((item) => readJsonFile(path.resolve(expandHome(item)))),
    parseJsonEnv(MCP_CONFIG_JSON_ENV),
    parseJsonEnv(MCP_SERVERS_JSON_ENV),
  ];
  return sources.filter((source) => source.ok || source.warning);
}

export function loadMcpConfig(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot || process.cwd());
  const sources = loadConfigSources(root);
  const servers = new Map();
  const warnings = [];
  const loadedPaths = [];

  for (const source of sources) {
    if (source.warning) {
      warnings.push(source.warning);
      continue;
    }
    if (!source.ok) continue;
    loadedPaths.push(source.path);
    const entries = normalizeMcpRoot(source.json);
    for (const [name, value] of Object.entries(entries)) {
      const normalized = normalizeServer(name, value, source.path, root);
      if (normalized.warning) {
        warnings.push(normalized.warning);
        continue;
      }
      if (normalized.server) servers.set(normalized.server.id, normalized.server);
    }
  }

  return {
    ok: true,
    projectRoot: root,
    paths: defaultMcpConfigPaths(root),
    loadedPaths,
    warnings,
    servers: [...servers.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function findMcpServer(serverId, projectRoot = process.cwd()) {
  const config = loadMcpConfig(projectRoot);
  const id = String(serverId || "").trim();
  return {
    config,
    server: config.servers.find((server) => server.id === id) || null,
  };
}

export function publicMcpServer(server) {
  if (!server) return null;
  return {
    id: server.id,
    label: server.label,
    description: server.description,
    source: server.source,
    enabled: server.enabled,
    transport: server.transport,
    trust: server.trust,
    readOnly: server.readOnly,
    allowAllTools: server.allowAllTools,
    allowHostProcess: server.transport === "stdio" ? server.allowHostProcess : undefined,
    allowedTools: server.allowedTools,
    deniedTools: server.deniedTools,
    startupTimeoutMs: server.startupTimeoutMs,
    requestTimeoutMs: server.requestTimeoutMs,
    cwd: server.cwd,
    command: server.transport === "stdio" ? server.command : undefined,
    args: server.transport === "stdio" ? server.args : undefined,
    envKeys: server.transport === "stdio" ? Object.keys(server.env || {}).sort() : undefined,
    url: server.transport === "http" ? server.url : undefined,
    headerKeys: server.transport === "http" ? Object.keys(server.headers || {}).sort() : undefined,
  };
}

export function summarizeMcpConfig(projectRoot = process.cwd()) {
  const config = loadMcpConfig(projectRoot);
  return {
    ok: true,
    projectRoot: config.projectRoot,
    loadedPaths: config.loadedPaths,
    warnings: config.warnings,
    servers: config.servers.map(publicMcpServer),
  };
}
