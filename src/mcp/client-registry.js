import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { redactSensitiveText } from "../redaction.js";
import { findMcpServer, publicMcpServer } from "./config.js";

const connections = new Map();
const MAX_INLINE_TEXT = 60_000;
const MAX_LIST_ITEMS = 200;

function connectionKey(projectRoot, serverId) {
  return `${projectRoot || process.cwd()}::${serverId}`;
}

function requestOptions(server, config) {
  return {
    timeout: server.requestTimeoutMs,
    signal: config.abortSignal,
  };
}

function compactText(value, limit = MAX_INLINE_TEXT) {
  const text = redactSensitiveText(String(value ?? ""));
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated by AgInTiFlow MCP bridge]`;
}

function compactJson(value, limit = MAX_INLINE_TEXT) {
  try {
    return compactText(JSON.stringify(value, null, 2), limit);
  } catch {
    return compactText(String(value), limit);
  }
}

function sanitizeResult(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return compactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, MAX_LIST_ITEMS).map((item) => sanitizeResult(item));
  if (typeof value === "object") {
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
      if (/token|secret|password|authorization|cookie|api[-_]?key/i.test(key)) {
        result[key] = "[REDACTED]";
      } else if (typeof raw === "string") {
        result[key] = compactText(raw);
      } else {
        result[key] = sanitizeResult(raw);
      }
    }
    return result;
  }
  return compactText(String(value));
}

function stderrCollector(stream) {
  const lines = [];
  if (!stream) return { lines };
  stream.on("data", (chunk) => {
    const text = redactSensitiveText(Buffer.from(chunk).toString("utf8"));
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      lines.push(line.slice(0, 500));
      while (lines.length > 20) lines.shift();
    }
  });
  return { lines };
}

function clientInfo(config = {}) {
  return {
    name: "agintiflow",
    version: String(config.packageVersion || process.env.npm_package_version || "0.0.0"),
  };
}

function createTransport(server) {
  if (server.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args || [],
      cwd: server.cwd,
      env: Object.keys(server.env || {}).length ? server.env : undefined,
      stderr: "pipe",
    });
    return { transport, stderr: stderrCollector(transport.stderr) };
  }
  if (server.transport === "http") {
    const headers = server.headers && Object.keys(server.headers).length ? { ...server.headers } : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      sessionId: server.sessionId || undefined,
      requestInit: headers ? { headers } : undefined,
    });
    return { transport, stderr: { lines: [] } };
  }
  throw new Error(`Unsupported MCP transport: ${server.transport}`);
}

async function connectServer(server, config) {
  const client = new Client(clientInfo(config), { capabilities: {} });
  const { transport, stderr } = createTransport(server);
  await client.connect(transport, {
    timeout: server.startupTimeoutMs,
    signal: config.abortSignal,
  });
  return {
    client,
    transport,
    stderr,
    server,
    connectedAt: new Date().toISOString(),
    serverCapabilities: sanitizeResult(client.getServerCapabilities() || {}),
    serverVersion: sanitizeResult(client.getServerVersion() || {}),
    instructions: compactText(client.getInstructions() || "", 8000),
  };
}

export async function getMcpConnection(serverId, config = {}) {
  const projectRoot = config.commandCwd || config.baseDir || process.cwd();
  const { server } = findMcpServer(serverId, projectRoot);
  if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
  if (!server.enabled) throw new Error(`MCP server is disabled: ${server.id}`);
  const key = connectionKey(projectRoot, server.id);
  const existing = connections.get(key);
  if (existing?.client) return existing;
  const connection = await connectServer(server, config);
  connections.set(key, connection);
  return connection;
}

export async function closeMcpConnection(serverId, config = {}) {
  const projectRoot = config.commandCwd || config.baseDir || process.cwd();
  const key = connectionKey(projectRoot, serverId);
  const connection = connections.get(key);
  if (!connection) return { ok: true, closed: false, server: serverId };
  connections.delete(key);
  await connection.client.close().catch(() => {});
  await connection.transport.close?.().catch(() => {});
  return { ok: true, closed: true, server: serverId };
}

export async function closeAllMcpConnections() {
  const entries = [...connections.entries()];
  connections.clear();
  for (const [, connection] of entries) {
    await connection.client.close().catch(() => {});
    await connection.transport.close?.().catch(() => {});
  }
  return { ok: true, closed: entries.length };
}

export function listLiveMcpConnections(projectRoot = process.cwd()) {
  const prefix = `${projectRoot || process.cwd()}::`;
  return [...connections.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, connection]) => ({
      server: connection.server.id,
      connectedAt: connection.connectedAt,
      serverVersion: connection.serverVersion,
      capabilities: connection.serverCapabilities,
      stderr: connection.stderr.lines,
    }));
}

export async function inspectMcpServer(serverId, config = {}) {
  const connection = await getMcpConnection(serverId, config);
  return {
    ok: true,
    server: publicMcpServer(connection.server),
    connectedAt: connection.connectedAt,
    serverVersion: connection.serverVersion,
    capabilities: connection.serverCapabilities,
    instructions: connection.instructions,
    stderr: connection.stderr.lines,
  };
}

export async function listMcpTools(serverId, config = {}) {
  const connection = await getMcpConnection(serverId, config);
  const result = await connection.client.listTools({}, requestOptions(connection.server, config));
  return {
    ok: true,
    server: connection.server.id,
    tools: (result.tools || []).slice(0, MAX_LIST_ITEMS).map((tool) => sanitizeResult(tool)),
    nextCursor: result.nextCursor || "",
    untrustedDescriptions: true,
  };
}

export async function callMcpTool(serverId, toolName, args = {}, config = {}) {
  const connection = await getMcpConnection(serverId, config);
  const result = await connection.client.callTool(
    {
      name: toolName,
      arguments: args && typeof args === "object" ? args : {},
    },
    undefined,
    requestOptions(connection.server, config)
  );
  return {
    ok: !result.isError,
    server: connection.server.id,
    remoteTool: toolName,
    isError: Boolean(result.isError),
    result: sanitizeResult(result),
    untrustedResult: true,
  };
}

export async function listMcpResources(serverId, config = {}) {
  const connection = await getMcpConnection(serverId, config);
  const result = await connection.client.listResources({}, requestOptions(connection.server, config));
  return {
    ok: true,
    server: connection.server.id,
    resources: (result.resources || []).slice(0, MAX_LIST_ITEMS).map((resource) => sanitizeResult(resource)),
    nextCursor: result.nextCursor || "",
    untrustedDescriptions: true,
  };
}

export async function readMcpResource(serverId, uri, config = {}) {
  const connection = await getMcpConnection(serverId, config);
  const result = await connection.client.readResource({ uri }, requestOptions(connection.server, config));
  return {
    ok: true,
    server: connection.server.id,
    uri,
    contents: sanitizeResult(result.contents || []),
    untrustedResource: true,
  };
}

export async function listMcpPrompts(serverId, config = {}) {
  const connection = await getMcpConnection(serverId, config);
  const result = await connection.client.listPrompts({}, requestOptions(connection.server, config));
  return {
    ok: true,
    server: connection.server.id,
    prompts: (result.prompts || []).slice(0, MAX_LIST_ITEMS).map((prompt) => sanitizeResult(prompt)),
    nextCursor: result.nextCursor || "",
    untrustedDescriptions: true,
  };
}

export async function getMcpPrompt(serverId, name, args = {}, config = {}) {
  const connection = await getMcpConnection(serverId, config);
  const result = await connection.client.getPrompt(
    {
      name,
      arguments: args && typeof args === "object" ? args : {},
    },
    requestOptions(connection.server, config)
  );
  return {
    ok: true,
    server: connection.server.id,
    prompt: name,
    result: sanitizeResult(result),
    untrustedPrompt: true,
  };
}

export function formatMcpContentForToolResult(result) {
  return compactJson(result, MAX_INLINE_TEXT);
}
