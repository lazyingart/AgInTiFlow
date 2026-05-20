#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { mcpCliCommand } from "../src/mcp/tool-bridge.js";
import { closeAllMcpConnections } from "../src/mcp/client-registry.js";
import { checkMcpToolUse } from "../src/mcp/policy.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureServer = path.join(repoRoot, "scripts", "fixtures", "mcp-stdio-smoke-server.mjs");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-mcp-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, ".agintiflow-home");
process.env.AGINTIFLOW_NO_WEB_AUTO_START = "1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function configFor(projectRoot) {
  return loadConfig(
    {
      goal: "mcp smoke",
      commandCwd: projectRoot,
      permissionMode: "normal",
      sandboxMode: "host",
      packageInstallPolicy: "prompt",
      allowShellTool: true,
      allowFileTools: true,
      allowMcpTools: true,
      allowDestructive: false,
      provider: "mock",
    },
    { packageDir: repoRoot, baseDir: projectRoot }
  );
}

try {
  const projectRoot = path.join(tempRoot, "project");
  await fs.mkdir(path.join(projectRoot, ".aginti"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, ".aginti", "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          smoke: {
            transport: "stdio",
            command: process.execPath,
            args: [fixtureServer],
            trust: "trusted",
            readOnly: true,
            allowedTools: ["echo"],
            enabled: true,
          },
        },
      },
      null,
      2
    )
  );

  const config = configFor(projectRoot);
  const status = await mcpCliCommand(["status"], config);
  assert(status.servers?.some((server) => server.id === "smoke"), "mcp status did not list smoke server");
  assert(status.servers[0].envKeys?.length === 0, "mcp status should not expose env values");

  const tools = await mcpCliCommand(["tools", "smoke"], config);
  assert(tools.tools?.some((tool) => tool.name === "echo"), "mcp tools did not list echo");

  const echo = await mcpCliCommand(["call", "smoke", "echo", '{"text":"hello"}'], config);
  const echoJson = JSON.stringify(echo);
  assert(echo.ok === true && echoJson.includes("echo:hello"), "mcp call echo did not return expected content");

  const resourceList = await mcpCliCommand(["resources", "smoke"], config);
  assert(resourceList.resources?.some((resource) => resource.uri === "aginti://smoke/note"), "mcp resources did not list note");
  const resource = await mcpCliCommand(["read", "smoke", "aginti://smoke/note"], config);
  assert(JSON.stringify(resource).includes("hello from mcp resource"), "mcp read resource failed");

  const prompts = await mcpCliCommand(["prompts", "smoke"], config);
  assert(prompts.prompts?.some((prompt) => prompt.name === "hello"), "mcp prompts did not list hello prompt");
  const prompt = await mcpCliCommand(["prompt", "smoke", "hello", '{"name":"Agi"}'], config);
  assert(JSON.stringify(prompt).includes("Hello Agi"), "mcp get prompt failed");

  const blocked = checkMcpToolUse("mcp_call_tool", { server: "smoke", name: "create_note" }, config);
  assert(!blocked.allowed && /allowedTools/.test(blocked.reason || ""), "mutating or unlisted MCP tool was not blocked");

  let blockedFromCli = false;
  try {
    await mcpCliCommand(["call", "smoke", "create_note", '{"title":"bad"}'], config);
  } catch (error) {
    blockedFromCli = /allowedTools|not in allowedTools|blocked/i.test(String(error?.message || ""));
  }
  assert(blockedFromCli, "CLI MCP call bypassed MCP policy");

  const disabledConfig = { ...config, allowMcpTools: false };
  const disabled = checkMcpToolUse("mcp_list_tools", { server: "smoke" }, disabledConfig);
  assert(!disabled.allowed && /disabled/i.test(disabled.reason || ""), "allowMcpTools=false did not block MCP tools");

  await closeAllMcpConnections();
  console.log("smoke:mcp passed");
} finally {
  await closeAllMcpConnections().catch(() => {});
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
