import OpenAI from "openai";
import { WRAPPER_NAMES, wrapperStatusText } from "./tool-wrappers.js";

export function createClient(config) {
  if (config.provider === "mock") {
    return {
      mock: true,
      provider: "mock",
    };
  }

  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

function mockToolCall(name, args = {}) {
  return {
    id: `mock-${name}-${Date.now()}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function latestToolPayload(messages) {
  const toolMessage = [...messages].reverse().find((message) => message.role === "tool" && message.content);
  if (!toolMessage) return null;

  try {
    return JSON.parse(toolMessage.content);
  } catch {
    return null;
  }
}

function mockCommandForGoal(goal = "") {
  const text = String(goal).toLowerCase();
  if (/\blist\b|folder contents|directory contents|files?/.test(text)) return "ls -la";
  return "pwd";
}

function mockPathForGoal(goal = "") {
  const text = String(goal);
  const explicit = text.match(/(?:file|path):\s*`?([A-Za-z0-9_./-]+)`?/i)?.[1];
  if (explicit) return explicit;
  if (/\.env/i.test(text)) return ".env";
  if (/outside|escape/i.test(text)) return "../outside-workspace.txt";
  if (/patch/i.test(text)) return "patch-target.txt";
  return "mock-output.txt";
}

function mockWorkspaceToolForGoal(goal = "") {
  const text = String(goal).toLowerCase();
  const targetPath = mockPathForGoal(goal);
  if (/patch|replace|edit/.test(text)) {
    return mockToolCall("apply_patch", {
      path: targetPath,
      search: "old",
      replace: "new",
      expectedReplacements: 1,
    });
  }
  if (/write|create|file|coding/.test(text)) {
    return mockToolCall("write_file", {
      path: targetPath,
      mode: "create",
      content: `Created by AgInTiFlow mock mode.\nGoal: ${String(goal).slice(0, 160)}\n`,
    });
  }
  return null;
}

function mockChatResponse(content, toolCalls = []) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls,
        },
      },
    ],
  };
}

export async function createPlan(client, config, state) {
  if (client.mock) {
    return [
      "1. Inspect the request and prefer the local shell when available.",
      "2. Use one safe allowlisted command if it answers the task.",
      "3. Return a concise mock-mode result without using external model credentials.",
    ].join("\n");
  }

  const response = await client.chat.completions.create({
    model: config.model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are planning a browser-and-shell automation task. If a local shell command can satisfy the goal, prefer that before browser actions. Treat any suggested start URL as optional. Write a concise execution plan with 3 to 6 steps. Mention risks or blockers when relevant. Keep it short and practical.",
      },
      {
        role: "user",
        content: [
          `Goal: ${state.goal}`,
          state.startUrl ? `Suggested start URL: ${state.startUrl}` : "",
          config.allowedDomains.length > 0 ? `Allowed domains: ${config.allowedDomains.join(", ")}` : "",
          config.allowShellTool
            ? `Shell tool is enabled in ${config.commandCwd}. Sandbox mode: ${config.sandboxMode}. Package install policy: ${config.packageInstallPolicy}. For npm/pip/conda/venv setup, explain the need and wait for approval unless policy is allow.`
            : "",
          config.allowFileTools
            ? `Workspace file tools are enabled in ${config.commandCwd}: list_files, read_file, search_files, write_file, apply_patch. Keep all paths workspace-relative and avoid secrets.`
            : "",
          config.allowWrapperTools ? `Agent wrappers are enabled: ${wrapperStatusText()}.` : "",
          "Return a numbered plan only.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || "1. Inspect the page.\n2. Use the smallest safe action.\n3. Finish with a concise answer.";
}

export async function requestNextStep(client, config, messages) {
  const tools = [
    {
      type: "function",
      function: {
        name: "open_url",
        description: "Open an absolute http or https URL in the browser.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "click",
        description: "Click a visible element by its id from the latest snapshot.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "type",
        description: "Type text into an input-like element by id. Optionally press Enter after typing.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            pressEnter: { type: "boolean" },
          },
          required: ["id", "text"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "scroll",
        description: "Scroll the page vertically.",
        parameters: {
          type: "object",
          properties: {
            direction: { type: "string", enum: ["up", "down"] },
            amount: { type: "integer" },
          },
          required: ["direction"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "press",
        description: "Press a keyboard key such as Enter, Tab, Escape, ArrowDown, or ArrowUp.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string" },
          },
          required: ["key"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "back",
        description: "Go back to the previous page in browser history.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "wait",
        description: "Wait for the page to update after an action.",
        parameters: {
          type: "object",
          properties: {
            ms: { type: "integer" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description: "Return the final answer when the goal is complete.",
        parameters: {
          type: "object",
          properties: {
            result: { type: "string" },
          },
          required: ["result"],
          additionalProperties: false,
        },
      },
    },
  ];

  if (config.allowShellTool) {
    tools.splice(-1, 0, {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run an allowlisted terminal command in the configured working directory. Good for inspection, tests, and approved Docker package/environment setup. NPM publishing, tokens, sudo, arbitrary network commands, and destructive git/file actions are blocked.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    });
  }

  if (config.allowFileTools) {
    tools.splice(
      -1,
      0,
      {
        type: "function",
        function: {
          name: "list_files",
          description:
            "List workspace-local files under the configured working directory. Paths must stay inside the workspace; .git, node_modules, sessions, and sensitive files are skipped.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative path to list. Defaults to ." },
              maxDepth: { type: "integer", description: "Recursive depth, 1 to 8." },
              limit: { type: "integer", description: "Maximum entries to return." },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read_file",
          description:
            "Read a small UTF-8 workspace file. Secret paths, .git internals, files outside the workspace, binary files, and huge files are blocked.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file path." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "search_files",
          description:
            "Search small UTF-8 workspace files for literal text. Secret paths, .git internals, node_modules, and huge files are skipped.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              path: { type: "string", description: "Workspace-relative directory or file. Defaults to ." },
              caseSensitive: { type: "boolean" },
              maxResults: { type: "integer" },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description:
            "Create or overwrite a small UTF-8 workspace file. Use mode=create for new files and mode=overwrite only after reading/understanding the existing file. Secret paths, .git, node_modules writes, and outside-workspace paths are blocked. The runtime records before/after hashes and a compact diff.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file path." },
              content: { type: "string" },
              mode: { type: "string", enum: ["create", "overwrite"] },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "apply_patch",
          description:
            "Apply a deterministic workspace-local search/replace patch to one small UTF-8 file. Provide exact search and replacement text. The runtime records before/after hashes and a compact diff.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file path." },
              search: { type: "string" },
              replace: { type: "string" },
              expectedReplacements: { type: "integer" },
            },
            required: ["path", "search", "replace"],
            additionalProperties: false,
          },
        },
      }
    );
  }

  if (config.allowWrapperTools) {
    tools.splice(-1, 0, {
      type: "function",
      function: {
        name: "delegate_agent",
        description:
          "Ask an installed external coding agent wrapper for advisory help. Use for codebase analysis, implementation strategy, or second-opinion review. The wrapper is instructed to avoid modifying files.",
        parameters: {
          type: "object",
          properties: {
            wrapper: { type: "string", enum: WRAPPER_NAMES },
            prompt: { type: "string" },
          },
          required: ["wrapper", "prompt"],
          additionalProperties: false,
        },
      },
    });
  }

  if (client.mock) {
    const toolPayload = latestToolPayload(messages);
    if (toolPayload) {
      const output = [
        toolPayload.stdout,
        toolPayload.stderr,
        toolPayload.error,
        toolPayload.reason,
        toolPayload.path ? `Path: ${toolPayload.path}` : "",
        toolPayload.change?.diff ? `Diff:\n${toolPayload.change.diff}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return mockChatResponse("Mock mode finished after receiving the latest tool result.", [
        mockToolCall("finish", {
          result: [
            "Mock run complete.",
            toolPayload.toolName ? `Tool: ${toolPayload.toolName}` : "",
            toolPayload.args?.command ? `Command: ${toolPayload.args.command}` : "",
            toolPayload.blocked ? "Blocked by guardrail." : "",
            output ? `Output:\n${output}` : "No command output was returned.",
          ]
            .filter(Boolean)
            .join("\n"),
        }),
      ]);
    }

    if (config.allowFileTools) {
      const workspaceTool = mockWorkspaceToolForGoal(config.goal);
      if (workspaceTool) {
        return mockChatResponse("Mock mode will exercise a guarded workspace file tool.", [workspaceTool]);
      }
    }

    if (config.allowShellTool) {
      return mockChatResponse("Mock mode will use the guarded shell tool for a non-dangerous local inspection.", [
        mockToolCall("run_command", { command: mockCommandForGoal(config.goal) }),
      ]);
    }

    return mockChatResponse("Mock mode can complete without external model credentials.", [
      mockToolCall("finish", {
        result: `Mock run complete for: ${config.goal}`,
      }),
    ]);
  }

  return client.chat.completions.create({
    model: config.model,
    temperature: 0,
    tool_choice: "auto",
    parallel_tool_calls: false,
    messages,
    tools,
  });
}
