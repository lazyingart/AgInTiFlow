import { evaluateCommandPolicy } from "../command-policy.js";
import { findMcpServer } from "./config.js";

export const MCP_BRIDGE_TOOL_NAMES = [
  "mcp_list_servers",
  "mcp_list_tools",
  "mcp_call_tool",
  "mcp_list_resources",
  "mcp_read_resource",
  "mcp_list_prompts",
  "mcp_get_prompt",
];

const MUTATING_TOOL_RE = /\b(write|create|update|delete|remove|insert|patch|apply|edit|exec|execute|shell|command|run|install|publish|deploy|push|send|email|payment|purchase|order)\b/i;
const READLIKE_TOOL_RE = /\b(list|get|read|fetch|search|query|find|inspect|describe|status|lookup|metadata|schema)\b/i;

function commandLineForServer(server) {
  if (!server || server.transport !== "stdio") return "";
  return [server.command, ...(server.args || [])].map((part) => shellQuote(String(part || ""))).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeName(value = "") {
  return String(value || "").trim();
}

export function isMcpBridgeTool(toolName = "") {
  return MCP_BRIDGE_TOOL_NAMES.includes(toolName);
}

export function classifyMcpToolName(toolName = "") {
  const name = normalizeName(toolName);
  if (!name) return { category: "missing", mutating: false, readLike: false };
  const mutating = MUTATING_TOOL_RE.test(name);
  const readLike = READLIKE_TOOL_RE.test(name);
  return {
    category: mutating ? "mutating" : readLike ? "read-like" : "unknown",
    mutating,
    readLike,
  };
}

function checkServerAvailable(server, bridgeToolName) {
  if (!server) {
    return { allowed: false, reason: "Unknown MCP server.", category: "mcp-server" };
  }
  if (!server.enabled) {
    return { allowed: false, reason: `MCP server is disabled: ${server.id}`, category: "mcp-server" };
  }
  if (server.transport === "stdio" && bridgeToolName !== "mcp_list_servers") {
    return null;
  }
  return null;
}

function checkStdioPolicy(server, config) {
  if (server.transport !== "stdio") return { allowed: true };
  if (!config.allowShellTool) {
    return { allowed: false, reason: "MCP stdio servers require shell tools to be enabled.", category: "mcp-stdio" };
  }
  const commandPolicy = evaluateCommandPolicy(commandLineForServer(server), {
    ...config,
    // Stdio MCP servers are spawned on the host by the MCP transport. Do not
    // accidentally approve them through Docker-shell policy.
    sandboxMode: "host",
    useDockerSandbox: false,
    packageInstallPolicy: "prompt",
  });
  if (!commandPolicy.allowed) {
    if (server.allowHostProcess && config.permissionMode !== "safe") {
      return { allowed: true, commandPolicy, preapprovedBy: "mcp-server-trust" };
    }
    return {
      allowed: false,
      reason:
        `MCP stdio server command is blocked by host command policy: ${commandPolicy.reason || "not allowed"}. ` +
        "Set trust=trusted or allowHostProcess=true for a server you explicitly trust.",
      category: "mcp-stdio",
      needsApproval: commandPolicy.needsApproval,
      commandPolicy,
    };
  }
  return { allowed: true, commandPolicy };
}

export function checkMcpToolUse(toolName, args = {}, config = {}) {
  if (!isMcpBridgeTool(toolName)) return { allowed: true };
  if (config.allowMcpTools === false) {
    return { allowed: false, reason: "MCP tools are disabled for this run.", category: "mcp" };
  }
  if (toolName === "mcp_list_servers") return { allowed: true };

  const { server } = findMcpServer(args.server, config.commandCwd || config.baseDir || process.cwd());
  const serverBlock = checkServerAvailable(server, toolName);
  if (serverBlock) return serverBlock;
  const stdioPolicy = checkStdioPolicy(server, config);
  if (!stdioPolicy.allowed) return stdioPolicy;

  if (toolName === "mcp_call_tool") {
    const requestedTool = normalizeName(args.name || args.tool);
    if (!requestedTool) return { allowed: false, reason: "MCP tool name is required.", category: "mcp-tool" };
    if (server.deniedTools?.includes(requestedTool)) {
      return { allowed: false, reason: `MCP tool is denied for server ${server.id}: ${requestedTool}`, category: "mcp-tool" };
    }
    if (server.allowedTools?.length && !server.allowedTools.includes(requestedTool)) {
      return { allowed: false, reason: `MCP tool is not in allowedTools for server ${server.id}: ${requestedTool}`, category: "mcp-tool" };
    }
    const classification = classifyMcpToolName(requestedTool);
    if (server.readOnly && classification.mutating && !server.allowAllTools) {
      return {
        allowed: false,
        reason: `MCP server ${server.id} is read-only and tool ${requestedTool} looks mutating.`,
        category: "mcp-tool",
      };
    }
    if (!server.allowAllTools && !server.allowedTools?.includes(requestedTool) && classification.mutating && !config.allowDestructive) {
      return {
        allowed: false,
        reason:
          `MCP tool ${requestedTool} looks mutating. Add it to allowedTools, set trust=trusted/allowAllTools, or run with explicit destructive trust.`,
        category: "mcp-tool",
        needsApproval: true,
      };
    }
  }

  if ((toolName === "mcp_read_resource" || toolName === "mcp_get_prompt") && server.trust === "untrusted" && config.permissionMode === "safe") {
    return {
      allowed: false,
      reason: `Reading MCP resources/prompts from untrusted server ${server.id} is blocked in safe mode.`,
      category: "mcp-context",
    };
  }

  return { allowed: true };
}
