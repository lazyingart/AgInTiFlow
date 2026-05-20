import { loadMcpConfig, publicMcpServer, summarizeMcpConfig } from "./config.js";
import {
  callMcpTool,
  closeMcpConnection,
  getMcpPrompt,
  inspectMcpServer,
  listLiveMcpConnections,
  listMcpPrompts,
  listMcpResources,
  listMcpTools,
  readMcpResource,
} from "./client-registry.js";
import { checkMcpToolUse } from "./policy.js";

export function mcpProjectRoot(config = {}) {
  return config.commandCwd || config.baseDir || process.cwd();
}

export function listConfiguredMcpServers(config = {}) {
  const projectRoot = mcpProjectRoot(config);
  const mcpConfig = loadMcpConfig(projectRoot);
  return {
    ok: true,
    toolName: "mcp_list_servers",
    projectRoot,
    loadedPaths: mcpConfig.loadedPaths,
    warnings: mcpConfig.warnings,
    servers: mcpConfig.servers.map(publicMcpServer),
    liveConnections: listLiveMcpConnections(projectRoot),
  };
}

export async function executeMcpBridgeTool(toolName, args = {}, config = {}) {
  const server = String(args.server || "").trim();
  switch (toolName) {
    case "mcp_list_servers":
      return listConfiguredMcpServers(config);
    case "mcp_list_tools":
      return { toolName, ...(await listMcpTools(server, config)) };
    case "mcp_call_tool":
      return {
        toolName,
        ...(await callMcpTool(server, String(args.name || args.tool || "").trim(), args.arguments || args.args || {}, config)),
      };
    case "mcp_list_resources":
      return { toolName, ...(await listMcpResources(server, config)) };
    case "mcp_read_resource":
      return { toolName, ...(await readMcpResource(server, String(args.uri || "").trim(), config)) };
    case "mcp_list_prompts":
      return { toolName, ...(await listMcpPrompts(server, config)) };
    case "mcp_get_prompt":
      return {
        toolName,
        ...(await getMcpPrompt(server, String(args.name || args.prompt || "").trim(), args.arguments || args.args || {}, config)),
      };
    default:
      throw new Error(`Unknown MCP bridge tool: ${toolName}`);
  }
}

function ensureAllowedBridgeCall(toolName, args = {}, config = {}) {
  const guard = checkMcpToolUse(toolName, args, config);
  if (guard.allowed) return;
  const error = new Error(guard.reason || "MCP bridge call blocked by policy.");
  error.guard = guard;
  throw error;
}

export async function mcpCliCommand(argv = [], config = {}) {
  const [actionRaw = "status", ...rest] = argv;
  const action = String(actionRaw || "status").toLowerCase();
  const projectRoot = mcpProjectRoot(config);
  if (action === "status" || action === "list" || action === "servers") {
    return listConfiguredMcpServers(config);
  }
  if (action === "inspect" || action === "show") {
    ensureAllowedBridgeCall("mcp_list_tools", { server: rest[0] }, config);
    return { toolName: "mcp_inspect", ...(await inspectMcpServer(rest[0], config)) };
  }
  if (action === "tools") {
    ensureAllowedBridgeCall("mcp_list_tools", { server: rest[0] }, config);
    return { toolName: "mcp_list_tools", ...(await listMcpTools(rest[0], config)) };
  }
  if (action === "resources") {
    ensureAllowedBridgeCall("mcp_list_resources", { server: rest[0] }, config);
    return { toolName: "mcp_list_resources", ...(await listMcpResources(rest[0], config)) };
  }
  if (action === "prompts") {
    ensureAllowedBridgeCall("mcp_list_prompts", { server: rest[0] }, config);
    return { toolName: "mcp_list_prompts", ...(await listMcpPrompts(rest[0], config)) };
  }
  if (action === "read") {
    ensureAllowedBridgeCall("mcp_read_resource", { server: rest[0], uri: rest.slice(1).join(" ") }, config);
    return { toolName: "mcp_read_resource", ...(await readMcpResource(rest[0], rest.slice(1).join(" "), config)) };
  }
  if (action === "prompt") {
    const args = parseJsonObject(rest.slice(2).join(" "));
    ensureAllowedBridgeCall("mcp_get_prompt", { server: rest[0], name: rest[1], arguments: args }, config);
    return { toolName: "mcp_get_prompt", ...(await getMcpPrompt(rest[0], rest[1], args, config)) };
  }
  if (action === "call") {
    const args = parseJsonObject(rest.slice(2).join(" "));
    ensureAllowedBridgeCall("mcp_call_tool", { server: rest[0], name: rest[1], arguments: args }, config);
    return { toolName: "mcp_call_tool", ...(await callMcpTool(rest[0], rest[1], args, config)) };
  }
  if (action === "restart") {
    ensureAllowedBridgeCall("mcp_list_tools", { server: rest[0] }, config);
    await closeMcpConnection(rest[0], config);
    return { toolName: "mcp_restart", ...(await inspectMcpServer(rest[0], config)) };
  }
  if (action === "config") {
    return { toolName: "mcp_config", ...summarizeMcpConfig(projectRoot) };
  }
  return {
    ok: false,
    toolName: "mcp",
    error:
      "Usage: aginti mcp [status|config|inspect <server>|tools <server>|resources <server>|read <server> <uri>|prompts <server>|prompt <server> <name> [json]|call <server> <tool> [json]|restart <server>]",
  };
}

function parseJsonObject(value = "") {
  const text = String(value || "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function formatMcpCliResult(result = {}) {
  if (result.toolName === "mcp_list_servers" || result.toolName === "mcp_config") {
    const lines = [
      `MCP project=${result.projectRoot || ""}`,
      result.loadedPaths?.length ? `config=${result.loadedPaths.join(", ")}` : "config=(none)",
      ...(result.warnings || []).map((warning) => `warning=${warning}`),
      ...(result.servers || []).map((server) =>
        [
          `${server.enabled ? "enabled" : "disabled"} ${server.id}`,
          `transport=${server.transport}`,
          `trust=${server.trust}`,
          server.transport === "stdio" ? `command=${server.command} ${(server.args || []).join(" ")}`.trim() : "",
          server.transport === "http" ? `url=${server.url}` : "",
        ]
          .filter(Boolean)
          .join(" ")
      ),
      result.liveConnections?.length ? `live=${result.liveConnections.map((item) => item.server).join(", ")}` : "",
    ].filter(Boolean);
    return lines.join("\n");
  }
  if (result.ok === false) return result.error || result.reason || "MCP command failed.";
  return JSON.stringify(result, null, 2);
}
