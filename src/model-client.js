import OpenAI from "openai";
import { normalizeWrapperName, wrapperStatusText } from "./tool-wrappers.js";
import { getTaskProfile } from "./task-profiles.js";
import { listAuxiliarySkills } from "./auxiliary-tools.js";
import { engineeringGuidanceForTask } from "./engineering-guidance.js";
import { formatSkillsForPrompt, selectSkillsForGoal } from "./skill-library.js";
import { platformInfo, platformLabel } from "./platform.js";
import { formatBehaviorContractForPrompt } from "./behavior-contract.js";
import { redactSensitiveText } from "./redaction.js";

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
  for (const message of [...messages].reverse()) {
    if (message.role === "user" && /^Continue with this new request:|^Goal:/i.test(String(message.content || ""))) {
      return null;
    }
    if (message.role !== "tool" || !message.content) continue;
    try {
      const payload = JSON.parse(message.content);
      return payload?.done ? null : payload;
    } catch {
      return null;
    }
  }
  return null;
}

function prepareMessages(config, messages) {
  if (config.provider === "deepseek") return messages;
  return messages.map((message) => {
    const prepared = { ...message };
    delete prepared.reasoning_content;
    delete prepared.reasoningContent;
    return prepared;
  });
}

function requestOptions(config) {
  const timeout = Number(config.modelTimeoutMs || process.env.AGINTI_MODEL_TIMEOUT_MS || 90000);
  return {
    ...(config.abortSignal ? { signal: config.abortSignal } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
  };
}

function toolChoiceForProvider(config, messages = []) {
  if (config.provider !== "venice") return "auto";

  // Venice accepts OpenAI tool calls but often treats the first "auto" call as plain chat.
  // Require one tool call to enter the agent loop, then allow normal answer/finish behavior.
  return messages.some((message) => message.role === "tool") ? "auto" : "required";
}

export function usesTextToolProtocol(config = {}) {
  if (config.provider !== "venice") return false;
  const model = String(config.model || "").toLowerCase();
  return model === "gemma-4-uncensored" || model === "e2ee-venice-uncensored-24b-p" || model === "venice-uncensored";
}

function shouldRetryWithTextToolProtocol(error, config = {}) {
  if (config.provider !== "venice") return false;
  const message = [
    error?.message,
    error?.error?.message,
    error?.response?.data?.error?.message,
    error?.response?.data?.message,
  ]
    .filter(Boolean)
    .join(" ");
  return /invalid request parameters|tool_choice|parallel_tool_calls|tools/i.test(message);
}

function textToolProtocolPrompt(tools = []) {
  const toolLines = tools.map((tool) => {
    const fn = tool.function || {};
    const properties = fn.parameters?.properties ? Object.keys(fn.parameters.properties).slice(0, 8) : [];
    const required = Array.isArray(fn.parameters?.required) ? fn.parameters.required : [];
    const args = properties.length > 0 ? ` args=${properties.join(",")}${required.length ? ` required=${required.join(",")}` : ""}` : "";
    return `- ${fn.name}: ${String(fn.description || "").slice(0, 180)}${args}`;
  });
  return [
    "This provider/model may not accept native OpenAI function-call parameters.",
    "Use this text tool protocol when you need a tool:",
    '[TOOL_CALLS]tool_name[ARGS]{"arg":"value"}',
    'A strict id form is also accepted: [TOOL_CALLS]tool_name[ARGS]call_short_id[ARGS]{"arg":"value"}',
    'A JSON block form is accepted too: TOOL_CALLS: ```json [{"name":"tool_name","arguments":{"arg":"value"}}] ```',
    "Return only one or more TOOL_CALLS blocks when calling tools; do not wrap them in markdown.",
    "Keep tool-call JSON valid and complete. For long write_file content, prefer a concise complete file or smaller follow-up edits over emitting huge/truncated JSON.",
    "If no tool is needed, answer normally.",
    "Available text tools:",
    ...toolLines,
  ].join("\n");
}

function messagesWithTextToolProtocol(config, messages, tools) {
  const prepared = prepareMessages(config, messages).map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: `Tool result for ${message.tool_call_id || "previous tool"}:\n${message.content || ""}`,
      };
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return {
        role: "assistant",
        content:
          message.content ||
          `Requested tools: ${message.tool_calls
            .map((call) => `${call.function?.name || "tool"}(${call.function?.arguments || "{}"})`)
            .join("; ")}`,
      };
    }
    return message;
  });
  const protocol = { role: "system", content: textToolProtocolPrompt(tools) };
  if (prepared[0]?.role === "system") return [prepared[0], protocol, ...prepared.slice(1)];
  return [protocol, ...prepared];
}

export function parseTextToolCalls(content = "") {
  const text = String(content || "");
  if (!hasTextToolCallMarker(text)) return [];

  const calls = [];
  for (const call of parseRequestedToolCalls(text)) calls.push(call);
  const jsonBlock = text.match(/TOOL_CALLS\s*:\s*```(?:json)?\s*([\s\S]*?)```/i);
  if (jsonBlock?.[1]) {
    try {
      const parsed = JSON.parse(jsonBlock[1].trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const name = String(item?.name || item?.tool || "").trim();
          if (!name) continue;
          const args = item?.arguments && typeof item.arguments === "object" ? item.arguments : {};
          calls.push({
            id: String(item?.id || `text-tool-${calls.length + 1}`),
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(args),
            },
          });
        }
      }
    } catch {
      // Fall through to bracket parser below.
    }
  }

  for (const chunk of text.split("[TOOL_CALLS]").slice(1)) {
    const match = chunk.match(/^([A-Za-z0-9_-]+)\[ARGS\]([\s\S]*?)$/);
    const name = match?.[1]?.trim();
    let rawArgs = match?.[2]?.trim() || "{}";
    let id = `text-tool-${calls.length + 1}`;
    const strictParts = rawArgs.split("[ARGS]");
    if (strictParts.length >= 2 && !rawArgs.startsWith("{") && !rawArgs.startsWith("[")) {
      id = strictParts.shift()?.trim() || id;
      rawArgs = strictParts.join("[ARGS]").trim() || "{}";
    }
    if (!name) continue;
    try {
      JSON.parse(rawArgs);
    } catch {
      continue;
    }
    calls.push({
      id,
      type: "function",
      function: {
        name,
        arguments: rawArgs,
      },
    });
  }
  return calls;
}

function hasTextToolCallMarker(content = "") {
  const text = String(content || "");
  return text.includes("[TOOL_CALLS]") || /TOOL_CALLS\s*:/i.test(text) || /Requested tools?\s*:/i.test(text);
}

function findMatchingParen(text = "", openIndex = 0) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseRequestedToolCalls(content = "") {
  const marker = String(content || "").match(/Requested tools?\s*:/i);
  if (!marker) return [];

  const text = String(content).slice(marker.index + marker[0].length);
  const calls = [];
  let offset = 0;
  while (offset < text.length) {
    const match = text.slice(offset).match(/([A-Za-z0-9_-]+)\s*\(/);
    if (!match) break;

    const name = match[1]?.trim();
    const openIndex = offset + match.index + match[0].lastIndexOf("(");
    const closeIndex = findMatchingParen(text, openIndex);
    if (!name || closeIndex < 0) break;

    const rawArgs = text.slice(openIndex + 1, closeIndex).trim() || "{}";
    try {
      JSON.parse(rawArgs);
    } catch {
      offset = closeIndex + 1;
      continue;
    }
    calls.push({
      id: `text-tool-${calls.length + 1}`,
      type: "function",
      function: {
        name,
        arguments: rawArgs,
      },
    });
    offset = closeIndex + 1;
  }
  return calls;
}

function textBeforeToolCallMarker(content = "") {
  return String(content || "")
    .split("[TOOL_CALLS]")[0]
    .split("TOOL_CALLS:")[0]
    .split(/Requested tools?\s*:/i)[0]
    .split("<|tool_call>")[0]
    .trim();
}

export function normalizeTextToolCallResponse(response) {
  const message = response?.choices?.[0]?.message;
  if (!message || Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return response;

  const calls = parseTextToolCalls(message.content || "");
  if (calls.length === 0) {
    const cleanedContent = textBeforeToolCallMarker(message.content || "");
    if (!hasTextToolCallMarker(message.content || "")) return response;
    if (cleanedContent) {
      return {
        ...response,
        choices: response.choices.map((choice, index) =>
          index === 0
            ? {
                ...choice,
                message: {
                  ...message,
                  content: cleanedContent,
                },
              }
            : choice
        ),
      };
    }
    return {
      ...response,
      choices: response.choices.map((choice, index) =>
        index === 0
          ? {
              ...choice,
              message: {
                ...message,
                content:
                  "The previous text tool request was malformed or truncated and was not executed. Retry with one valid tool call using the configured tool interface. For long files, write a complete concise file or split the work into smaller valid edits; do not show raw tool-call JSON to the user.",
                tool_calls: [
                  {
                    id: "text-tool-retry-1",
                    type: "function",
                    function: {
                      name: "wait",
                      arguments: JSON.stringify({ ms: 1 }),
                    },
                  },
                ],
              },
            }
          : choice
      ),
    };
  }

  const content = textBeforeToolCallMarker(message.content || "");
  return {
    ...response,
    choices: response.choices.map((choice, index) =>
      index === 0
        ? {
            ...choice,
            message: {
              ...message,
              content,
              tool_calls: calls,
            },
          }
        : choice
    ),
  };
}

function mockCommandForGoal(goal = "") {
  const text = String(goal).toLowerCase();
  if (/\blist\b|folder contents|directory contents|files?/.test(text)) return "ls -la";
  return "pwd";
}

function mockPathForGoal(goal = "") {
  const text = String(goal);
  if (/\bAGINTI\.md\b|project instructions|remember (?:that|this)|durable preference/i.test(text)) return "AGINTI.md";
  const explicit = text.match(/(?:file|path):\s*`?([A-Za-z0-9_./-]+)`?/i)?.[1];
  if (explicit) return explicit;
  const createPath = text.match(
    /\b(?:create|write|make|save|generate)\s+(?:a\s+|an\s+|the\s+)?(?:file\s+)?`?((?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+\.(?:md|txt|js|ts|json|py|tex|html|css|svg|csv|yml|yaml))`?/i
  )?.[1];
  if (createPath) return createPath.replace(/^[`'"]+|[`'",.]+$/g, "");
  if (/\.env/i.test(text)) return ".env";
  if (/outside|escape/i.test(text)) return "../outside-workspace.txt";
  if (/patch/i.test(text)) return "patch-target.txt";
  return "mock-output.txt";
}

function mockWorkspaceToolForGoal(goal = "") {
  const text = String(goal).toLowerCase();
  const targetPath = mockPathForGoal(goal);
  if (targetPath === "AGINTI.md" && /update|remember|instruction|preference|aginti\.md/.test(text)) {
    return mockToolCall("write_file", {
      path: targetPath,
      mode: "overwrite",
      content: `# AGINTI.md\n\nProject instructions for AgInTiFlow agents.\n\n## Notes\n\n- ${String(goal).slice(0, 180)}\n`,
    });
  }
  if (/inspect|map|overview|architecture|large codebase|large repo|repository|repo\b|codebase/.test(text)) {
    return mockToolCall("inspect_project", {
      path: ".",
      maxDepth: 6,
      limit: 400,
    });
  }
  if (/patch|replace|edit/.test(text)) {
    if (/multi|codex|unified|several|multiple/i.test(text)) {
      return mockToolCall("apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Update File: patch-target.txt",
          "@@",
          "-old",
          "+new",
          "*** Add File: notes/patch-note.md",
          "+Created by AgInTiFlow mock mode.",
          "+Goal: multi-file patch smoke.",
          "*** End Patch",
        ].join("\n"),
      });
    }
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

function mockWebSearchToolForGoal(goal = "") {
  const text = String(goal || "");
  if (!/\b(web search|search web|search the web|look up|current|latest|recent|docs|documentation|online)\b/i.test(text)) return null;
  const query = text.replace(/\s+/g, " ").slice(0, 180);
  return mockToolCall("web_search", {
    query,
    maxResults: 3,
  });
}

function mockPreviewToolForGoal(goal = "") {
  const text = String(goal).toLowerCase();
  if (!/(open|preview|view|browser|website|web\s*site)/.test(text)) return null;
  const targetPath = mockPathForGoal(goal);
  if (targetPath === "mock-output.txt") return null;
  if (!/\.(html|htm|svg|png|jpe?g|webp|pdf|txt|md)$/i.test(targetPath)) return null;
  return mockToolCall("preview_workspace", {
    path: targetPath,
    port: 8765,
  });
}

function mockCanvasToolForGoal(goal = "") {
  const text = String(goal).toLowerCase();
  if (!/canvas|artifact|image|figure|visual|preview|render/.test(text)) return null;
  return mockToolCall("send_to_canvas", {
    title: "Mock canvas note",
    kind: "markdown",
    content: `# Mock canvas artifact\n\nAgInTiFlow can send selected text, diffs, snapshots, and files into the frontend canvas.\n\nGoal: ${String(goal).slice(0, 160)}`,
    note: "Mock mode exercised the backend-to-frontend artifact tunnel.",
    selected: true,
  });
}

function mockAuxiliaryToolForGoal(goal = "") {
  const text = String(goal || "").toLowerCase();
  if (!/\b(image|picture|photo|illustration|cover|poster|logo|generate art|draw a)\b/.test(text)) return null;
  return mockToolCall("generate_image", {
    prompt: `Mock image generation request: ${goal}`,
    outputDir: "artifacts/images/mock-image",
    outputStem: "mock-image",
    aspectRatio: "1:1",
    dryRun: true,
  });
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
  const taskProfile = getTaskProfile(config.taskProfile);
  const engineeringGuidance = engineeringGuidanceForTask(state.goal, config.taskProfile);
  const selectedSkills = selectSkillsForGoal(state.goal, { taskProfile: config.taskProfile, limit: 5 });
  const skillContext = formatSkillsForPrompt(selectedSkills);
  const projectInstructions = state.meta?.projectInstructions;
  const platform = platformInfo();
  if (client.mock) {
    return [
      "1. Inspect the request and prefer the local shell when available.",
      "2. Use one safe allowlisted command if it answers the task.",
      "3. Return a concise mock-mode result without using external model credentials.",
    ].join("\n");
  }

  const response = await client.chat.completions.create(
    {
      model: config.model,
      temperature: 0,
      messages: [
      {
        role: "system",
        content:
          `You are planning a browser, shell, workspace, and coding-agent task. The plan is only a launchpad: after planning, the runtime will continue with tools until the task is complete or genuinely blocked. Prefer real workspace edits/checks over advice-only answers. If a local shell command can satisfy the goal, prefer that before browser actions. Treat any suggested start URL as optional. ${formatBehaviorContractForPrompt({ mode: "plan" })} Write a concise execution plan with 3 to 6 steps. Mention risks or blockers when relevant. Keep it short and practical.`,
      },
      {
        role: "user",
        content: [
          `Goal: ${state.goal}`,
          state.startUrl ? `Suggested start URL: ${state.startUrl}` : "",
          config.allowedDomains.length > 0 ? `Allowed domains: ${config.allowedDomains.join(", ")}` : "",
          config.allowShellTool
            ? `Shell tool is enabled in ${config.commandCwd}. Host platform: ${platformLabel(platform)}. In Docker, this path is mounted as /workspace with persistent /aginti-env and /aginti-cache mounts. Use relative paths or /workspace paths, not absolute host temp paths. Sandbox mode: ${config.sandboxMode}. Package install policy: ${config.packageInstallPolicy}. For npm/pip/conda/venv setup, explain the need and wait for approval unless policy is allow. Do not run npx aginti, npm exec aginti, or nested aginti diagnostics from this shell; they may resolve stale project packages or create recursive agent sessions. On native Windows host mode, prefer PowerShell/cmd-compatible commands or WSL/Docker for bash-like toolchains.`
            : "",
          config.allowShellTool
            ? "Host tmux tools are enabled for long-running sessions. Plan to use tmux_start_session for durable jobs, tmux_capture_pane to monitor, tmux_send_keys to interact after capture, and tmux_list_sessions to discover existing sessions. Do not install or run tmux inside Docker run_command containers; those containers are short-lived and cannot preserve tmux servers. In Docker sandbox mode, tmux startup/send commands are still workspace-bound and shell-pane text follows the same Docker workspace command policy as run_command: use relative project paths, not absolute host paths outside the workspace, and do not use tmux as a workaround for package installs, destructive git rewrites, or broad shell commands. In host mode, tmux startup/send command text follows the same host shell policy as run_command; if blocked, present the suggested approval/rerun path instead of trying tmux as a workaround. Ask for --sandbox-mode host --allow-destructive before trusted whole-host tmux work."
            : "",
          config.allowFileTools
            ? `Workspace file tools are enabled in ${config.commandCwd}: inspect_project, list_files, read_file, search_files, write_file, apply_patch, open_workspace_file, preview_workspace. For large or unfamiliar repos, plan to call inspect_project first, then search/read AGINTI.md/AGENTS.md/README/manifests and exact files. apply_patch supports exact single-file replacements and Codex-style/unified multi-file patches; prefer it for edits after reading relevant context. Keep all paths workspace-relative, for example plot_fx.svg or docs/report.tex, and avoid secrets. For newly generated standalone prose/docs/stories/assets, choose a descriptive non-conflicting filename from the topic/language instead of generic names like story.txt or output.txt; do not overwrite existing files unless the user explicitly asked to update/replace/overwrite that file. For generated local HTML/SVG/PDF/static sites, plan to use open_workspace_file or preview_workspace rather than starting a localhost server inside Docker.`
            : "",
          projectInstructions?.exists
            ? `Project instructions: AGINTI.md is loaded from ${projectInstructions.path}${projectInstructions.truncated ? " (truncated)" : ""}. Follow it and update it with file tools when the user asks to remember or change project instructions.`
            : "Project instructions: AGINTI.md is not present unless created by /init or file tools.",
          config.allowWrapperTools
            ? `Agent wrappers are enabled. Use the selected wrapper only: ${normalizeWrapperName(config.preferredWrapper)}. Status: ${wrapperStatusText()}.`
            : "",
          config.allowAuxiliaryTools
            ? `Auxiliary skills are enabled: ${listAuxiliarySkills()
                .map((skill) => `${skill.id} via ${skill.toolName} (${skill.available ? "key available" : `needs ${skill.keyName}`})`)
                .join(", ")}. For raster image generation requests, plan to use generate_image when a GRSAI or Venice image key is available; otherwise ask the user to run /auxiliary grsai, aginti login grsai, or aginti login venice.`
            : "Auxiliary skills are disabled for this run.",
          config.allowWebSearch
            ? "web_search is available for current information, docs, install errors, package/toolchain questions, and source discovery. Prefer web_search over opening a search engine in the browser."
            : "web_search is disabled for this run.",
          config.allowParallelScouts
            ? `Parallel scout notes may be injected before execution for complex tasks. Scout count: ${config.parallelScoutCount}.`
            : "Parallel scouts are disabled.",
          `Task profile: ${taskProfile.label}. ${taskProfile.prompt}`,
          skillContext,
          engineeringGuidance,
          "A canvas/artifacts tunnel is available through send_to_canvas. Use it when an output should be highlighted visually, such as screenshots, image files, important markdown, diffs, or generated artifact paths. It is optional for ordinary text answers.",
          "Work like a practical coding agent: inspect when useful, edit with file tools, run safe checks when they add confidence, and keep outputs inside the workspace.",
          "When saving new standalone content, think of a specific filename from the request and use mode=create. If that name already exists and the user did not ask to replace it, choose a safe variant such as topic-language-v2.md instead of overwriting.",
          "For large apps, websites, LaTeX documents, Python/C/shell projects, or system tasks, plan a coherent minimal implementation, then use tools to create files, run checks, and publish artifacts.",
          "For LaTeX/PDF work, first check whether latexmk or pdflatex already exists in the active host/Docker environment; compile with the existing toolchain before installing packages or rebuilding Docker.",
          "For web search or current information tasks, plan to use browser tools or safe shell network tools when allowed, then preserve useful source notes if the output depends on them.",
          "Use the canvas tunnel for outputs the user would likely want to inspect visually, such as figures, PDFs, screenshots, images, important markdown, or generated files.",
          "For environment or system-maintenance work, prefer project-local dry-run plans/scripts unless the configured policy explicitly allows stronger actions.",
          "Docker language/toolchain installs should prefer /aginti-env or project files so they persist across runs; apt/apk changes are ephemeral unless the image is rebuilt.",
          "If a localhost/browser preview fails, do not loop on the same URL. Switch to open_workspace_file or preview_workspace, or finish with the local path and honest limitation.",
          "If the run is close to the max-step limit, finish with the best complete artifact and honest limitations instead of starting a new approach.",
          "Plan for a complete result, not endless exploration; finish once the request is satisfied and checks have passed or been honestly skipped.",
          "Return a numbered plan only.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      ],
    },
    requestOptions(config)
  );

  return redactSensitiveText(response.choices[0]?.message?.content?.trim() || "1. Inspect the page.\n2. Use the smallest safe action.\n3. Finish with a concise answer.");
}

export async function requestNextStep(client, config, messages) {
  const tools = [
    {
      type: "function",
      function: {
        name: "open_url",
        description:
          "Open a remote absolute http or https URL in the browser. Do not use this for generated local workspace files or localhost preview loops; use open_workspace_file or preview_workspace when available.",
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

  if (config.allowWebSearch !== false) {
    tools.splice(-1, 0, {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the public web for current information, documentation, install errors, package/toolchain guidance, and source discovery. Returns compact result titles, URLs, and snippets. Prefer this over browser search-engine navigation; open specific results only when needed.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query. Do not include secrets or tokens." },
            maxResults: { type: "integer", description: "Number of results, 1 to 10. Defaults to 5." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    });
  }

  if (config.allowFileTools) {
    tools.splice(
      0,
      0,
      {
        type: "function",
        function: {
          name: "open_workspace_file",
          description:
            "Open a workspace-local file directly in the browser, such as generated HTML, SVG, PNG, PDF, or text. Prefer this over starting a localhost server when the user asks to open a generated local page.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file path to open." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "preview_workspace",
          description:
            "Start a persistent host-side static preview server for a workspace file or directory, automatically choosing a free port, then open it in the browser. Use this for generated local websites instead of running python -m http.server inside Docker or repeatedly opening localhost URLs.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file or directory to preview. Defaults to ." },
              port: { type: "integer", description: "Preferred localhost port. The runtime chooses another if busy." },
            },
            additionalProperties: false,
          },
        },
      }
    );
  }

  if (config.allowShellTool) {
    tools.splice(
      -1,
      0,
      {
        type: "function",
        function: {
          name: "tmux_list_sessions",
          description:
            "List durable host tmux sessions and panes. Use this to discover long-running terminals, agent sessions, dev servers, or jobs before interacting with them. tmux tools run host-side even when command execution is Docker-sandboxed; do not use run_command to start tmux inside an ephemeral Docker container.",
          parameters: {
            type: "object",
            properties: {
              includePanes: { type: "boolean", description: "Include pane targets, current paths, and running commands. Defaults to true." },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "tmux_capture_pane",
          description:
            "Capture recent text from a durable host tmux pane by target such as session:0.0. Use this to monitor progress or inspect a long-running job without interrupting it. If capture fails because the session ended, do not infer stdout/stderr/exit status; use a durable workspace log or rerun with output redirected to a file.",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "tmux pane target, for example aginti-test:0.0 or %12." },
              lines: { type: "integer", description: "Recent lines to capture, 1 to 500. Defaults to 80." },
            },
            required: ["target"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "tmux_send_keys",
          description:
            "Send literal text and/or safe control keys to a durable host tmux pane. Use for interacting with known shells or agent sessions after capturing context. Do not send secrets, passwords, sudo passwords, destructive commands, or absolute host paths outside the workspace unless the run is explicitly in host sandbox mode.",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "tmux pane target, for example aginti-test:0.0 or %12." },
              text: { type: "string", description: "Literal text to send before keys." },
              enter: { type: "boolean", description: "Append Enter after text/keys. Defaults to true." },
              keys: {
                type: "array",
                items: {
                  type: "string",
                  enum: ["Enter", "C-c", "C-d", "Escape", "Tab", "Up", "Down", "Left", "Right", "Backspace", "C-a", "C-e", "C-u", "C-k"],
                },
                description: "Optional safe tmux key names.",
              },
            },
            required: ["target"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "tmux_start_session",
          description:
            "Start a detached durable host tmux session rooted inside the workspace, optionally with a startup command. Use for long-running local jobs that should be monitored with tmux_capture_pane instead of blocking the agent. For one-shot commands, redirect output and exit status to a durable workspace log or keep the shell open so capture can verify; do not claim results from an auto-terminated session. In Docker sandbox mode, startup commands must stay workspace-bound and must not reference absolute host paths outside the project; ask for --sandbox-mode host for trusted whole-host work.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Safe tmux session name. Defaults to aginti-<timestamp>." },
              cwd: { type: "string", description: "Workspace-relative cwd. Defaults to ." },
              command: { type: "string", description: "Optional non-secret startup command." },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "run_command",
          description:
            "Run a terminal command in the configured working directory under the active shell policy. Secrets, npm publishing, npx/npm-exec AgInTiFlow self-invocation, and recursive Docker aginti calls are blocked; Docker workspace mode with approved package installs supports broader network/setup commands, while host destructive or privileged work requires explicit trust.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
            additionalProperties: false,
          },
        },
      }
    );
  }

  if (config.allowFileTools) {
    tools.splice(
      -1,
      0,
      {
        type: "function",
        function: {
          name: "inspect_project",
          description:
            "Build a compact, deterministic map of the workspace for large-codebase work. Returns top-level entries, manifests, source/test directories, package scripts, language counts, and recommended files to read next. Use this before editing an unfamiliar or multi-file repository.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative directory to inspect. Defaults to ." },
              maxDepth: { type: "integer", description: "Recursive depth, 1 to 10. Defaults to 6." },
              limit: { type: "integer", description: "Maximum filesystem entries to inspect." },
              includeFiles: { type: "boolean", description: "Include a compact file list when needed. Defaults to false." },
            },
            additionalProperties: false,
          },
        },
      },
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
            "Read a small UTF-8 workspace file. Small files return full content; larger files return a truncated preview with contentTruncated=true, so do not quote or reproduce omitted content unless you read it another way. Secret paths, .git internals, files outside the workspace, binary files, and huge files are blocked.",
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
            "Create or overwrite a small UTF-8 workspace file. Use mode=create with a descriptive non-conflicting filename for newly generated standalone content. Use mode=overwrite only when the user explicitly asks to replace/update that file, or after reading the file and the task is clearly to modify it. Secret paths, .git, node_modules writes, and outside-workspace paths are blocked. The runtime records before/after hashes and a compact diff.",
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
            "Apply deterministic workspace-local code edits. Either provide path/search/replace for one exact replacement, or provide patch with a Codex-style patch envelope (*** Begin Patch / *** Update File / *** Add File / *** Delete File / *** End Patch) or unified diff. Use this after reading/searching relevant files. It supports multi-file add/update/delete patches, blocks secrets/.git/node_modules/outside-workspace paths, preflights hunks before writing, and records before/after hashes plus compact diffs.",
          parameters: {
            type: "object",
            properties: {
              patch: {
                type: "string",
                description:
                  "Optional multi-file patch document. Supports Codex-style patch envelope or unified diff. Use workspace-relative paths only.",
              },
              path: { type: "string", description: "Workspace-relative file path." },
              search: { type: "string", description: "Exact text to replace when using single-file patch mode." },
              replace: { type: "string", description: "Replacement text when using single-file patch mode." },
              expectedReplacements: { type: "integer" },
              baseHash: { type: "string", description: "Optional sha256 from read_file; rejects if file changed before patching." },
            },
            additionalProperties: false,
          },
        },
      }
    );
  }

  if (config.allowWrapperTools) {
    const selectedWrapper = normalizeWrapperName(config.preferredWrapper);
    tools.splice(-1, 0, {
      type: "function",
      function: {
        name: "delegate_agent",
        description:
          `Ask the selected external coding agent wrapper (${selectedWrapper}) for advisory help. Use for codebase analysis, implementation strategy, or second-opinion review. The wrapper is instructed to avoid modifying files.`,
        parameters: {
          type: "object",
          properties: {
            wrapper: { type: "string", enum: [selectedWrapper] },
            prompt: { type: "string" },
          },
          required: ["wrapper", "prompt"],
          additionalProperties: false,
        },
      },
    });
  }

  if (config.allowAuxiliaryTools) {
    tools.splice(-1, 0, {
      type: "function",
      function: {
        name: "generate_image",
        description:
          "Generate a raster image artifact through optional GRS AI Nano Banana or Venice image-generation skills. Use for user requests that explicitly need a real image/photo/illustration/cover/poster/logo concept rather than SVG/code-native graphics. Saves prompt, redacted payload, manifest, and downloaded images in the workspace. If keys are missing, ask the user to run /auxiliary grsai, aginti login grsai, or aginti login venice.",
        parameters: {
          type: "object",
          properties: {
            provider: {
              type: "string",
              enum: ["grsai", "venice"],
              description: "Image provider. Defaults to grsai; use venice when the user selects Venice image models.",
            },
            prompt: { type: "string", description: "Detailed image-generation prompt." },
            outputDir: { type: "string", description: "Workspace-relative output directory. Defaults to artifacts/images/<timestamp>." },
            outputStem: { type: "string", description: "Filename stem for downloaded images." },
            aspectRatio: { type: "string", description: "Aspect ratio such as 1:1, 16:9, 2:3, or 3:2." },
            imageSize: { type: "string", description: "Image size such as 1K, 2K, or 4K." },
            model: { type: "string", description: "Image model. Defaults to nano-banana-2; Venice also supports models such as gpt-image-2, wan-2-7-text-to-image, qwen-image-2, and bria-bg-remover." },
            referenceImages: {
              type: "array",
              items: { type: "string" },
              description: "Optional workspace-relative image paths, HTTPS URLs, or data URLs.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    });
  }

  tools.splice(-1, 0, {
    type: "function",
    function: {
      name: "send_to_canvas",
      description:
        "Send an optional artifact notification to the frontend canvas/artifacts tunnel. Use for important markdown/text, generated images, screenshots, figures, diffs, or workspace file paths the user should preview. Workspace files sent here are copied into session artifacts for durable preview, but if the user asked to save/capture/generate a file, keep a descriptive non-conflicting copy in the working directory too. Proactively use this for draw/plot/graph/chart/diagram/figure requests even when the user did not mention canvas. This does not replace finish.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short display title for the canvas item." },
          kind: {
            type: "string",
            enum: ["text", "markdown", "image", "json", "diff", "file", "pdf"],
            description: "Renderer hint. Use image/file with path, markdown/text/json/diff with content.",
          },
          content: { type: "string", description: "Inline text or markdown content to render." },
          path: { type: "string", description: "Optional existing workspace-relative file path to preview and persist into the session artifact store." },
          note: { type: "string", description: "Short notification message for the artifact explorer." },
          selected: { type: "boolean", description: "Whether the frontend should select this item immediately." },
        },
        required: ["title", "kind"],
        additionalProperties: false,
      },
    },
  });

  if (client.mock) {
    const toolPayload = latestToolPayload(messages);
    if (toolPayload) {
      if (toolPayload.ok === false && !toolPayload.blocked) {
        return mockChatResponse("Mock mode detected a tool failure and will stop instead of masking it.", [
          mockToolCall("finish", {
            result: `Mock run failed because ${toolPayload.toolName || "a tool"} failed: ${
              toolPayload.error || toolPayload.reason || "unknown error"
            }`,
          }),
        ]);
      }
      const output = [
        toolPayload.stdout,
        toolPayload.stderr,
        toolPayload.error,
        toolPayload.reason,
        toolPayload.summary ? `Summary: ${toolPayload.summary}` : "",
        toolPayload.counts ? `Counts: ${JSON.stringify(toolPayload.counts)}` : "",
        Array.isArray(toolPayload.recommendedReads) && toolPayload.recommendedReads.length
          ? `Recommended reads: ${toolPayload.recommendedReads.join(", ")}`
          : "",
        Array.isArray(toolPayload.results) && toolPayload.results.length
          ? `Results:\n${toolPayload.results.map((item, index) => `${index + 1}. ${item.title} ${item.url}`).join("\n")}`
          : "",
        toolPayload.path ? `Path: ${toolPayload.path}` : "",
        Array.isArray(toolPayload.changes)
          ? toolPayload.changes
              .map((change) => [change.path ? `Path: ${change.path}` : "", change.diff ? `Diff:\n${change.diff}` : ""].filter(Boolean).join("\n"))
              .filter(Boolean)
              .join("\n\n")
          : "",
        !Array.isArray(toolPayload.changes) && toolPayload.change?.diff ? `Diff:\n${toolPayload.change.diff}` : "",
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
      const previewTool = mockPreviewToolForGoal(config.goal);
      if (previewTool) {
        return mockChatResponse("Mock mode will exercise the workspace preview tool.", [previewTool]);
      }
    }

    if (config.allowAuxiliaryTools) {
      const auxiliaryTool = mockAuxiliaryToolForGoal(config.goal);
      if (auxiliaryTool) {
        return mockChatResponse("Mock mode will exercise an auxiliary skill tool in dry-run mode.", [auxiliaryTool]);
      }
    }

    if (config.allowWebSearch !== false) {
      const webSearchTool = mockWebSearchToolForGoal(config.goal);
      if (webSearchTool) {
        return mockChatResponse("Mock mode will exercise the web search tool.", [webSearchTool]);
      }
    }

    const canvasTool = mockCanvasToolForGoal(config.goal);
    if (canvasTool) {
      return mockChatResponse("Mock mode will publish a canvas artifact for the UI tunnel.", [canvasTool]);
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

  const textToolProtocol = usesTextToolProtocol(config);
  const nativePayload = {
    model: config.model,
    temperature: 0,
    tool_choice: toolChoiceForProvider(config, messages),
    parallel_tool_calls: false,
    messages: prepareMessages(config, messages),
    tools,
  };
  const textPayload = {
    model: config.model,
    temperature: 0,
    messages: messagesWithTextToolProtocol(config, messages, tools),
  };

  let response;
  try {
    response = await client.chat.completions.create(
      textToolProtocol ? textPayload : nativePayload,
      requestOptions(config)
    );
  } catch (error) {
    if (!textToolProtocol && shouldRetryWithTextToolProtocol(error, config)) {
      response = await client.chat.completions.create(textPayload, requestOptions(config));
    } else {
      throw error;
    }
  }
  return normalizeTextToolCallResponse(response);
}
