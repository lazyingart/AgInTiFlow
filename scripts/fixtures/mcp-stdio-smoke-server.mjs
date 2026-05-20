#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const server = new McpServer({
  name: "agintiflow-smoke-mcp",
  version: "1.0.0",
});

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Return the input text with a smoke-test prefix.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo:${text}` }],
  })
);

server.registerTool(
  "create_note",
  {
    title: "Create note",
    description: "Mutating-looking tool used to verify AgInTiFlow policy blocks untrusted writes.",
    inputSchema: { title: z.string().optional() },
  },
  async ({ title = "untitled" }) => ({
    content: [{ type: "text", text: `created:${title}` }],
  })
);

server.registerResource(
  "smoke-note",
  "aginti://smoke/note",
  {
    title: "Smoke note",
    description: "Static MCP smoke-test resource.",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/plain",
        text: "hello from mcp resource",
      },
    ],
  })
);

server.registerPrompt(
  "hello",
  {
    title: "Hello prompt",
    description: "Return a small user prompt for smoke validation.",
    argsSchema: { name: z.string() },
  },
  async ({ name }) => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: `Hello ${name}` },
      },
    ],
  })
);

await server.connect(new StdioServerTransport());
