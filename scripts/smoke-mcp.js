#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
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

async function startStreamableHttpFixture() {
  const mcpServer = new McpServer({
    name: "agintiflow-streamable-http-smoke-mcp",
    version: "1.0.0",
  });
  mcpServer.registerTool(
    "echo",
    {
      title: "HTTP echo",
      description: "Return the input text through Streamable HTTP.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: `http-echo:${text}` }],
    })
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => "agintiflow-streamable-http-smoke-session",
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport);

  const server = http.createServer((request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    transport.handleRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    await mcpServer.close().catch(() => {});
    throw error;
  }

  const address = server.address();
  assert(address && typeof address === "object", "Streamable HTTP fixture did not bind a random port");
  let closePromise;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close() {
      closePromise ??= (async () => {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections?.();
        });
        await mcpServer.close();
      })();
      return closePromise;
    },
  };
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

let httpFixture;
try {
  httpFixture = await startStreamableHttpFixture();
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
          httpSmoke: {
            transport: "streamable-http",
            url: httpFixture.url,
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
  assert(
    status.servers?.some((server) => server.id === "httpSmoke" && server.transport === "http"),
    "mcp status did not list the Streamable HTTP smoke server"
  );
  assert(
    status.servers.find((server) => server.id === "smoke")?.envKeys?.length === 0,
    "mcp status should not expose env values"
  );

  const tools = await mcpCliCommand(["tools", "smoke"], config);
  assert(tools.tools?.some((tool) => tool.name === "echo"), "mcp tools did not list echo");

  const echo = await mcpCliCommand(["call", "smoke", "echo", '{"text":"hello"}'], config);
  const echoJson = JSON.stringify(echo);
  assert(echo.ok === true && echoJson.includes("echo:hello"), "mcp call echo did not return expected content");

  const httpTools = await mcpCliCommand(["tools", "httpSmoke"], config);
  assert(httpTools.tools?.some((tool) => tool.name === "echo"), "Streamable HTTP MCP tools did not list echo");

  const httpEcho = await mcpCliCommand(["call", "httpSmoke", "echo", '{"text":"hello"}'], config);
  assert(
    httpEcho.ok === true && JSON.stringify(httpEcho).includes("http-echo:hello"),
    "Streamable HTTP MCP call did not return expected content"
  );

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
  await httpFixture.close();
  httpFixture = undefined;
  console.log("smoke:mcp passed");
} finally {
  await closeAllMcpConnections().catch(() => {});
  await httpFixture?.close().catch(() => {});
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
