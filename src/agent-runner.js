import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { exec as execCallback, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { createClient, createPlan, requestNextStep } from "./model-client.js";
import { SessionStore } from "./session-store.js";
import { captureSnapshot } from "./snapshot.js";
import { checkToolUse } from "./guardrails.js";
import { ensureDockerSandboxReady, runDockerSandboxCommand } from "./docker-sandbox.js";
import { normalizeWrapperName, runAgentWrapper, wrapperStatusText } from "./tool-wrappers.js";
import { evaluateCommandPolicy } from "./command-policy.js";
import { redactSensitiveText, redactValue } from "./redaction.js";
import { executeWorkspaceTool, resolveWorkspacePath, summarizeWorkspaceTools, WORKSPACE_TOOL_NAMES } from "./workspace-tools.js";
import { normalizeCanvasPayload } from "./artifact-tunnel.js";
import { getTaskProfile } from "./task-profiles.js";
import { generateImage, listAuxiliarySkills } from "./auxiliary-tools.js";
import { engineeringGuidanceForTask } from "./engineering-guidance.js";
import { searchWeb } from "./web-search.js";
import { runParallelScouts, shouldRunParallelScouts } from "./parallel-scouts.js";

const exec = promisify(execCallback);
const BROWSER_TOOLS = new Set(["open_url", "open_workspace_file", "preview_workspace", "click", "type", "scroll", "press", "back"]);
const WORKSPACE_TOOLS = new Set(WORKSPACE_TOOL_NAMES);
const STATIC_PREVIEW_SERVER_PATH = fileURLToPath(new URL("./static-preview-server.js", import.meta.url));
const previewServers = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(config) {
  if (config.abortSignal?.aborted) {
    const reason = config.abortSignal.reason;
    const error = reason instanceof Error ? reason : new Error("Run interrupted by user.");
    error.name = error.name || "AbortError";
    throw error;
  }
}

function isAbortError(error, config = {}) {
  return Boolean(
    config.abortSignal?.aborted ||
      error?.name === "AbortError" ||
      error?.code === "ABORT_ERR" ||
      /aborted|interrupted/i.test(String(error?.message || ""))
  );
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Run interrupted by user."));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Run interrupted by user."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(preferredPort = 8765) {
  const preferred = Number(preferredPort);
  const start = Number.isFinite(preferred) && preferred > 0 ? preferred : 8765;
  for (let port = start; port < start + 80; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available preview port found near ${start}.`);
}

async function waitForPort(port, signal) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Preview interrupted.");
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await sleep(100);
  }
  throw new Error(`Preview server did not become ready on port ${port}.`);
}

async function startPreviewServer(root, preferredPort, signal) {
  const key = path.resolve(root);
  const existing = previewServers.get(key);
  if (existing && existing.child.exitCode === null) {
    return existing;
  }

  const port = await findAvailablePort(preferredPort);
  const child = spawn(process.execPath, [STATIC_PREVIEW_SERVER_PATH, key, String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const server = { root: key, port, child, url: `http://127.0.0.1:${port}/` };
  previewServers.set(key, server);
  await waitForPort(port, signal);
  return server;
}

function normalizeUrlPath(relativePath) {
  const normalized = String(relativePath || ".").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized === ".") return "";
  return normalized
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function preserveAssistantMessage(message) {
  const preserved = {
    role: "assistant",
    content: message.content || "",
    tool_calls: message.tool_calls,
  };

  const reasoningContent = message.reasoning_content || message.reasoningContent;
  if (reasoningContent) {
    preserved.reasoning_content = reasoningContent;
  }

  return preserved;
}

export function repairModelMessageHistory(state, config = {}) {
  if (config.provider !== "deepseek" || !Array.isArray(state?.messages)) {
    return { changed: false, droppedAssistantMessages: 0, convertedAssistantMessages: 0, droppedToolMessages: 0 };
  }

  const repaired = [];
  const droppedToolCallIds = new Set();
  let droppedAssistantMessages = 0;
  let convertedAssistantMessages = 0;
  let droppedToolMessages = 0;

  for (const message of state.messages) {
    if (message.role === "assistant") {
      const hasReasoningContent = Boolean(message.reasoning_content || message.reasoningContent);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const content = String(message.content || "");

      if (!hasReasoningContent) {
        if (content.startsWith("Execution plan:")) {
          droppedAssistantMessages += 1;
          continue;
        }

        if (toolCalls.length > 0) {
          for (const call of toolCalls) {
            if (call?.id) droppedToolCallIds.add(call.id);
          }
          droppedAssistantMessages += 1;
          continue;
        }

        if (content.trim()) {
          repaired.push({
            role: "user",
            content: `Previous assistant response retained as compacted history for DeepSeek thinking mode:\n${content}`,
          });
          convertedAssistantMessages += 1;
        } else {
          droppedAssistantMessages += 1;
        }
        continue;
      }

      repaired.push(preserveAssistantMessage(message));
      continue;
    }

    if (message.role === "tool" && droppedToolCallIds.has(message.tool_call_id)) {
      droppedToolMessages += 1;
      continue;
    }

    repaired.push(message);
  }

  const changed =
    droppedAssistantMessages > 0 ||
    convertedAssistantMessages > 0 ||
    droppedToolMessages > 0 ||
    repaired.length !== state.messages.length;

  if (changed) {
    state.messages = repaired;
  }

  return {
    changed,
    droppedAssistantMessages,
    convertedAssistantMessages,
    droppedToolMessages,
  };
}

function createInitialState(config, sessionId) {
  const now = new Date().toISOString();
  const taskProfile = getTaskProfile(config.taskProfile);
  const engineeringGuidance = engineeringGuidanceForTask(config.goal, config.taskProfile);
  return {
    sessionId,
    createdAt: now,
    updatedAt: now,
    provider: config.provider,
    model: config.model,
    goal: config.goal,
    startUrl: config.startUrl,
    plan: "",
    stepsCompleted: 0,
    meta: {
      lastUrl: "",
    },
    chat: [
      {
        role: "user",
        content: config.goal,
        at: now,
      },
    ],
    messages: [
      {
        role: "system",
        content: [
          "You are a careful browser and shell agent with a small tool surface.",
          "Use only the provided tools.",
          "The execution plan is not the final answer. After planning, actively use tools until the requested task is complete or genuinely blocked.",
          "If the shell tool can satisfy a local task, prefer it before opening a browser.",
          "Do not open a browser page just because a start URL exists. Treat it as a suggestion only.",
          "Only reference element ids from the latest browser snapshot.",
          "Prefer short, deliberate actions over guessing.",
          "Never navigate outside the allowed domains when an allowlist exists.",
          "Avoid destructive actions, purchases, account changes, and sensitive workflows.",
          config.allowShellTool
            ? config.useDockerSandbox
              ? `A shell command tool is available inside Docker sandbox mode ${config.sandboxMode}. Docker workspace mode with approved package installs supports broader setup and network commands. The project is mounted at /workspace and the persistent agent toolchain is mounted at /aginti-env with caches under /aginti-cache.`
              : "A host shell command tool is available under the configured trust policy."
            : "No shell command tool is available.",
          config.allowFileTools
            ? `Workspace file tools are available in ${config.commandCwd}: inspect_project, list_files, read_file, search_files, write_file, apply_patch, open_workspace_file, and preview_workspace. For large or unfamiliar repositories, call inspect_project first, then search/read exact files before editing. apply_patch supports exact single-file replacements plus Codex-style/unified multi-file patches; prefer it for source edits after reading/searching the relevant context. Always use workspace-relative paths such as plot_fx.svg or docs/report.tex, never absolute host paths. Secret paths, .git internals, node_modules writes, and huge files are blocked. For generated local websites/pages, use open_workspace_file or preview_workspace instead of starting a localhost server inside Docker.`
            : "No workspace file tools are available.",
          config.allowWrapperTools
            ? `External coding-agent wrappers are available as advisory tools only. Use the selected wrapper only: ${normalizeWrapperName(config.preferredWrapper)}. Wrapper status: ${wrapperStatusText()}.`
            : "External coding-agent wrappers are disabled.",
          config.allowAuxiliaryTools
            ? `Auxiliary skills are available: ${listAuxiliarySkills()
                .map((skill) => `${skill.id} via ${skill.toolName} (${skill.available ? "key available" : `needs ${skill.keyName}`})`)
                .join(", ")}. Use generate_image for real raster image/photo/illustration/cover/poster/logo requests when appropriate; if the key is missing, ask the user to run /auxilliary grsai or aginti login grsai.`
            : "Auxiliary skills are disabled for this run.",
          config.allowWebSearch
            ? "web_search is available for current information, docs, package/toolchain errors, and source discovery. Prefer web_search over browser search-engine navigation."
            : "web_search is disabled.",
          config.allowParallelScouts
            ? `Parallel DeepSeek scouts may run before complex execution. Scout count: ${config.parallelScoutCount}.`
            : "Parallel scouts are disabled.",
          `Task profile: ${taskProfile.label}. ${taskProfile.prompt}`,
          engineeringGuidance,
          "A frontend canvas/artifacts tunnel exists. Use send_to_canvas when important markdown, diffs, screenshots, images, or workspace files should be highlighted in the UI. It is optional and ordinary final text can still go directly to finish.",
          "For visual-output requests such as draw, plot, graph, chart, diagram, figure, image, or visualization, proactively publish a canvas artifact even when the user does not mention canvas. If workspace file tools are enabled, prefer creating a small SVG or markdown artifact and call send_to_canvas with selected=true.",
          "Work like a practical coding agent: orient with inspect_project/search/read, patch code with apply_patch, run safe checks when they add confidence, iterate on failures, and keep outputs inside the workspace.",
          "For large projects, decompose into useful files and milestones, identify entry points/tests/contracts first, implement a coherent minimal version, then iterate with checks rather than only describing what you would do.",
          "For website/app/code/LaTeX/Python/C/shell tasks, create or edit real workspace files, run available build/compile/test commands, and surface artifacts through the canvas when useful.",
          "For research or web-search tasks, use browser tools or safe shell network tools when the current policy allows; cite or save useful sources in workspace notes when the task needs traceability.",
          "Use the canvas tunnel for outputs the user would likely want to inspect visually, such as figures, PDFs, screenshots, images, important markdown, or generated files.",
          "For environment or system-maintenance work, use the configured sandbox and package policy; Docker workspace mode is the preferred place for installs and toolchain setup.",
          "If the user asks to open a generated local website or file, use open_workspace_file for a file or preview_workspace for a static site. Do not keep retrying the same localhost URL when a preview fails.",
          "Docker language/toolchain installs should prefer /aginti-env or project files so they persist across runs; apt/apk changes are ephemeral unless the image is rebuilt.",
          "If the run is close to the max-step limit, finish with the best complete artifact and honest limitations instead of starting a new approach.",
          "When the requested outcome is complete and a useful check has passed or been honestly skipped, stop and call finish.",
          "When done, call finish with a concise result.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Goal: ${config.goal}`,
          config.startUrl ? `Suggested start URL: ${config.startUrl}` : "",
          config.allowedDomains.length > 0 ? `Allowed domains: ${config.allowedDomains.join(", ")}` : "",
          config.allowShellTool
            ? config.useDockerSandbox
              ? `Shell working directory mounted into Docker as /workspace from ${config.commandCwd}. Use relative paths or /workspace paths, not absolute host temp paths. Persistent Docker env: /aginti-env, caches: /aginti-cache. Sandbox mode: ${config.sandboxMode}. Package install policy: ${config.packageInstallPolicy}.`
              : `Shell working directory: ${config.commandCwd}`
            : "",
          config.allowFileTools
            ? `Workspace file tools enabled in: ${config.commandCwd}. Use inspect_project first for large/unfamiliar codebases. Use workspace-relative paths. Use apply_patch for code edits; it accepts exact replacements or Codex-style/unified multi-file patches. Local preview tools available: open_workspace_file and preview_workspace.`
            : "",
          config.allowWrapperTools
            ? `Agent wrappers: selected=${normalizeWrapperName(config.preferredWrapper)}; ${wrapperStatusText()}`
            : "",
          config.allowAuxiliaryTools
            ? `Auxiliary skills: ${listAuxiliarySkills()
                .map((skill) => `${skill.id}:${skill.available ? "available" : "missing-key"}`)
                .join(" ")}`
            : "",
          config.allowWebSearch ? "Web search tool: enabled." : "Web search tool: disabled.",
          config.allowParallelScouts ? `Parallel scouts: enabled count=${config.parallelScoutCount}.` : "Parallel scouts: disabled.",
          `Task profile: ${taskProfile.label}. ${taskProfile.prompt}`,
          engineeringGuidance,
          "Canvas/artifacts tunnel: available through send_to_canvas for optional frontend rendering.",
          "Visual-output requests should produce a canvas artifact without requiring the user to ask for canvas explicitly.",
          "Use file, shell, browser, canvas, and wrapper tools when they are useful; choose the workflow from the user's request. For complicated engineering tasks, keep a tight loop: inspect, choose minimal files, patch, run focused checks, repair, then summarize.",
          "Do not stop at a plan when tools can accomplish the request. Continue through implementation, checks, artifact selection, and finish.",
          "Use the configured sandbox and package policy for environment or system-maintenance work.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  };
}

function createObservers(config) {
  return {
    log(message, data = {}) {
      if (typeof config.onLog === "function") config.onLog(message, data);
    },
    event(type, data = {}) {
      if (typeof config.onEvent === "function") config.onEvent(type, data);
    },
  };
}

function emitConsole(config, value = "", options = {}) {
  if (typeof config.onConsole === "function") {
    config.onConsole(String(value), options);
    return;
  }

  if (options.error) console.error(value);
  else console.log(value);
}

function createBrowserState() {
  return {
    browser: null,
    context: null,
    page: null,
  };
}

function ensureChatState(state) {
  if (Array.isArray(state.chat)) return;

  const chat = [];
  if (state.goal) {
    chat.push({
      role: "user",
      content: state.goal,
      at: state.createdAt || new Date().toISOString(),
    });
  }

  const finishTool = [...(state.messages || [])]
    .reverse()
    .find((message) => message.role === "tool" && typeof message.content === "string");

  if (finishTool) {
    try {
      const parsed = JSON.parse(finishTool.content);
      if (parsed.done && parsed.result) {
        chat.push({
          role: "assistant",
          content: parsed.result,
          at: state.updatedAt || new Date().toISOString(),
        });
      }
    } catch {
      // Keep derived chat best-effort only.
    }
  }

  state.chat = chat;
}

function appendChatEntry(state, role, content) {
  ensureChatState(state);
  state.chat.push({
    role,
    content,
    at: new Date().toISOString(),
  });
}

function applyContinuationPrompt(state, config, observers) {
  if (!config.resume || !config.goal) return;

  const taskProfile = getTaskProfile(config.taskProfile);
  const engineeringGuidance = engineeringGuidanceForTask(config.goal, config.taskProfile);
  ensureChatState(state);
  state.goal = config.goal;
  state.provider = config.provider;
  state.model = config.model;
  state.startUrl = config.startUrl;
  state.plan = "";
  state.stepsCompleted = 0;
  state.updatedAt = new Date().toISOString();
  state.messages.push({
    role: "user",
    content: [
      `Continue with this new request: ${config.goal}`,
      config.startUrl ? `Suggested start URL: ${config.startUrl}` : "",
      config.allowedDomains.length > 0 ? `Allowed domains: ${config.allowedDomains.join(", ")}` : "",
      config.allowShellTool
        ? config.useDockerSandbox
          ? `Shell working directory mounted into Docker as /workspace from ${config.commandCwd}. Use relative paths or /workspace paths. Persistent Docker env: /aginti-env, caches: /aginti-cache. Sandbox mode: ${config.sandboxMode}. Package install policy: ${config.packageInstallPolicy}.`
          : `Shell working directory: ${config.commandCwd}`
        : "",
      config.allowFileTools
        ? `Workspace file tools enabled in: ${config.commandCwd}. Use inspect_project first for large or unfamiliar codebases, then search/read exact files before editing. Use workspace-relative paths. Use apply_patch for code edits; it accepts exact replacements or Codex-style/unified multi-file patches. For generated local files/sites, use open_workspace_file or preview_workspace.`
        : "",
      config.allowWrapperTools
        ? `Agent wrappers: selected=${normalizeWrapperName(config.preferredWrapper)}; ${wrapperStatusText()}`
        : "",
      `Task profile: ${taskProfile.label}. ${taskProfile.prompt}`,
      engineeringGuidance,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  appendChatEntry(state, "user", config.goal);
  observers.event("conversation.continued", {
    sessionId: state.sessionId,
    prompt: config.goal,
  });
}

async function saveBrowserState(browserState, store) {
  if (browserState.context) {
    await browserState.context.storageState({ path: store.storageStatePath });
  }
}

async function ensureBrowser(browserState, config, store, state, observers) {
  if (browserState.page) return browserState;

  observers.log("browser.starting", { headless: config.headless });
  browserState.browser = await chromium.launch({ headless: config.headless });
  browserState.context = await browserState.browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: await fs
      .access(store.storageStatePath)
      .then(() => store.storageStatePath)
      .catch(() => undefined),
  });
  browserState.page = await browserState.context.newPage();

  if (state.meta.lastUrl) {
    await browserState.page.goto(state.meta.lastUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  return browserState;
}

async function closeBrowser(browserState, store) {
  await saveBrowserState(browserState, store).catch(() => {});
  await browserState.context?.close().catch(() => {});
  await browserState.browser?.close().catch(() => {});
}

function safeExecutionEnv() {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
  };
}

function hashForLog(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function sanitizeToolArgs(toolName, args) {
  const safeArgs = redactValue(args);
  if (toolName === "write_file" && typeof args.content === "string") {
    return {
      ...safeArgs,
      content: `[${Buffer.byteLength(args.content, "utf8")} bytes sha256=${hashForLog(args.content)}]`,
    };
  }
  if (toolName === "send_to_canvas" && typeof args.content === "string") {
    return {
      ...safeArgs,
      content: `[${Buffer.byteLength(args.content, "utf8")} bytes sha256=${hashForLog(args.content)}]`,
    };
  }
  if (toolName === "apply_patch") {
    return {
      ...safeArgs,
      patch: typeof args.patch === "string" ? `[${Buffer.byteLength(args.patch, "utf8")} bytes sha256=${hashForLog(args.patch)}]` : safeArgs.patch,
      search: typeof args.search === "string" ? redactSensitiveText(args.search).slice(0, 160) : safeArgs.search,
      replace: typeof args.replace === "string" ? redactSensitiveText(args.replace).slice(0, 160) : safeArgs.replace,
    };
  }
  if (toolName === "generate_image") {
    return {
      ...safeArgs,
      prompt: typeof args.prompt === "string" ? `[${Buffer.byteLength(args.prompt, "utf8")} bytes sha256=${hashForLog(args.prompt)}]` : safeArgs.prompt,
      referenceImages: Array.isArray(args.referenceImages)
        ? args.referenceImages.map((item) => (String(item || "").startsWith("data:") ? `[data-uri ${String(item).length} chars]` : redactSensitiveText(item)))
        : safeArgs.referenceImages,
    };
  }
  return safeArgs;
}

function sanitizeToolResult(result) {
  const safeResult = redactValue(result);
  if (typeof safeResult.content === "string") {
    safeResult.contentPreview = safeResult.content.slice(0, 600);
    safeResult.contentBytes = Buffer.byteLength(safeResult.content, "utf8");
    delete safeResult.content;
  }
  return safeResult;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function applyToolLoopGuard(state, toolResult, store, observers) {
  if (!toolResult || toolResult.done || toolResult.ok !== false) return;
  state.meta.toolLoop = state.meta.toolLoop || { recent: [], warned: [] };
  const signature = `${toolResult.toolName}:${stableStringify(toolResult.args || {})}`;
  const entry = {
    signature,
    toolName: toolResult.toolName,
    ok: Boolean(toolResult.ok),
    blocked: Boolean(toolResult.blocked),
    error: toolResult.error || toolResult.reason || "",
    at: new Date().toISOString(),
  };
  state.meta.toolLoop.recent.push(entry);
  state.meta.toolLoop.recent = state.meta.toolLoop.recent.slice(-20);

  const failures = state.meta.toolLoop.recent.filter((item) => item.signature === signature && item.ok === false).length;
  if (failures < 2 || state.meta.toolLoop.warned.includes(signature)) return;

  state.meta.toolLoop.warned.push(signature);
  state.meta.toolLoop.warned = state.meta.toolLoop.warned.slice(-20);
  const message = [
    `Loop guard: ${toolResult.toolName} with the same arguments has failed or been blocked ${failures} times.`,
    "Do not repeat that exact call.",
    "If this is a local workspace preview, use open_workspace_file or preview_workspace instead of repeatedly starting localhost servers or opening the same URL.",
    "If enough work is complete, call finish with the usable local path or preview URL.",
  ].join(" ");
  state.messages.push({ role: "user", content: message });
  await store.appendEvent("loop.guard", {
    toolName: toolResult.toolName,
    failures,
    message,
  });
  observers.event("loop.guard", {
    toolName: toolResult.toolName,
    failures,
    message,
  });
}

async function runShellCommand(command, config, policy = evaluateCommandPolicy(command, config)) {
  try {
    throwIfAborted(config);
    const result = config.useDockerSandbox
      ? await runDockerSandboxCommand(command, config, policy, { signal: config.abortSignal })
      : await exec(command, {
          cwd: config.commandCwd,
          timeout: 30000,
          maxBuffer: 200 * 1024,
          shell: "/bin/bash",
          env: safeExecutionEnv(),
          signal: config.abortSignal,
        });

    return {
      ok: true,
      exitCode: 0,
      stdout: redactSensitiveText(result.stdout).trim().slice(0, 8000),
      stderr: redactSensitiveText(result.stderr).trim().slice(0, 4000),
    };
  } catch (error) {
    if (isAbortError(error, config)) throw error;
    return {
      ok: false,
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: redactSensitiveText(String(error?.stdout || "")).trim().slice(0, 8000),
      stderr: redactSensitiveText(String(error?.stderr || error?.message || "")).trim().slice(0, 4000),
    };
  }
}

async function captureSyntheticSnapshot(store, step, config) {
  const snapshot = {
    title: "No browser page open",
    url: "",
    pageText: [
      "No browser page is currently open.",
      config.startUrl ? `Suggested start URL: ${config.startUrl}` : "",
      config.allowShellTool
        ? config.useDockerSandbox
          ? `Shell tool available in Docker with mounted workspace /workspace from ${config.commandCwd}. Use relative paths or /workspace paths. Persistent Docker env: /aginti-env, caches: /aginti-cache. Sandbox mode: ${config.sandboxMode}. Package install policy: ${config.packageInstallPolicy}.`
          : `Shell tool available in: ${config.commandCwd}`
        : "Shell tool disabled.",
      config.allowFileTools
        ? `Workspace file tools available in: ${config.commandCwd}. Use inspect_project first for large or unfamiliar codebases, then search/read exact files before editing. Use workspace-relative paths. Use apply_patch for code edits; it supports exact single-file replacement and multi-file Codex-style/unified patches.`
        : "Workspace file tools disabled.",
      config.allowWrapperTools
        ? `Agent wrappers available: selected=${normalizeWrapperName(config.preferredWrapper)}; ${wrapperStatusText()}`
        : "Agent wrappers disabled.",
      "Canvas/artifacts tunnel available through send_to_canvas.",
      "For draw/plot/graph/chart/diagram/figure requests, publish a canvas artifact proactively.",
      "For LaTeX/PDF requests, publish the source and compiled PDF artifacts when available. Keep subfolder outputs beside their source and use pdflatex-compatible figure formats.",
      "Use open_url only if the task actually needs the web.",
      "For generated local HTML/SVG/PDF/site output, use open_workspace_file or preview_workspace instead of shelling a transient local server.",
    ]
      .filter(Boolean)
      .join(" "),
    elements: [],
  };

  const snapshotPath = await store.saveSnapshot(step, snapshot);
  return {
    ...snapshot,
    screenshotPath: "",
    snapshotPath,
  };
}

async function buildSnapshot(browserState, store, step, config) {
  if (browserState.page) {
    return captureSnapshot(browserState.page, store, step);
  }
  return captureSyntheticSnapshot(store, step, config);
}

async function injectQueuedUserMessages(store, state, observers) {
  const inbox = await store.drainInbox();
  if (inbox.length === 0) return;

  for (const item of inbox) {
    const content = String(item.content || "").trim();
    if (!content) continue;
    appendChatEntry(state, "user", content);
    state.messages.push({
      role: "user",
      content: `Additional user message received while this run was active:\n${content}`,
    });
    await store.appendEvent("conversation.queued_input_applied", {
      prompt: content,
      source: item.source || "inbox",
    });
    observers.event("conversation.queued_input_applied", {
      prompt: content,
      source: item.source || "inbox",
    });
  }
}

async function executeTool(browserState, toolCall, snapshot, config, store, observers, state) {
  throwIfAborted(config);
  const args = JSON.parse(toolCall.function.arguments || "{}");
  const safeArgs = sanitizeToolArgs(toolCall.function.name, args);
  const guard = checkToolUse({
    toolName: toolCall.function.name,
    args,
    snapshot,
    config,
  });

  if (!guard.allowed) {
    await store.appendEvent("tool.blocked", {
      toolName: toolCall.function.name,
      args: safeArgs,
      reason: guard.reason,
      category: guard.category,
      needsApproval: guard.needsApproval,
    });
    observers.event("tool.blocked", {
      toolName: toolCall.function.name,
      args: safeArgs,
      reason: guard.reason,
      category: guard.category,
      needsApproval: guard.needsApproval,
    });
    return {
      ok: false,
      blocked: true,
      reason: guard.reason,
      category: guard.category,
      needsApproval: guard.needsApproval,
      toolName: toolCall.function.name,
      args: safeArgs,
    };
  }

  await store.appendEvent("tool.started", {
    toolName: toolCall.function.name,
    args: safeArgs,
  });
  observers.event("tool.started", {
    toolName: toolCall.function.name,
    args: safeArgs,
  });

  try {
    if (BROWSER_TOOLS.has(toolCall.function.name)) {
      await ensureBrowser(browserState, config, store, state, observers);
    }

    switch (toolCall.function.name) {
      case "open_url":
        await abortable(browserState.page.goto(String(args.url), { waitUntil: "domcontentloaded" }), config.abortSignal);
        break;
      case "web_search": {
        const result = await searchWeb(args, config);
        const eventResult = sanitizeToolResult(result);
        await store.appendEvent(result.ok ? "tool.completed" : "tool.failed", eventResult);
        observers.event(result.ok ? "tool.completed" : "tool.failed", eventResult);
        return result;
      }
      case "open_workspace_file": {
        const target = resolveWorkspacePath(config, args.path || args.file || ".");
        const stat = await fs.stat(target.absolutePath);
        if (!stat.isFile()) throw new Error(`Workspace preview target is not a file: ${target.relativePath}`);
        const fileUrl = pathToFileURL(target.absolutePath).href;
        await abortable(browserState.page.goto(fileUrl, { waitUntil: "domcontentloaded" }), config.abortSignal);
        const result = {
          ok: true,
          toolName: "open_workspace_file",
          args: safeArgs,
          path: target.relativePath,
          url: browserState.page.url(),
        };
        await store.appendEvent("tool.completed", result);
        observers.event("tool.completed", result);
        return result;
      }
      case "preview_workspace": {
        const target = resolveWorkspacePath(config, args.path || args.file || ".");
        const stat = await fs.stat(target.absolutePath);
        const server = await startPreviewServer(config.commandCwd, args.port || 8765, config.abortSignal);
        const urlPath = stat.isDirectory() ? normalizeUrlPath(target.relativePath === "." ? "" : `${target.relativePath}/`) : normalizeUrlPath(target.relativePath);
        const previewUrl = `${server.url}${urlPath}`;
        await abortable(browserState.page.goto(previewUrl, { waitUntil: "domcontentloaded" }), config.abortSignal);
        const result = {
          ok: true,
          toolName: "preview_workspace",
          args: safeArgs,
          path: target.relativePath,
          url: browserState.page.url(),
          port: server.port,
          root: server.root,
        };
        await store.appendEvent("tool.completed", result);
        observers.event("tool.completed", result);
        return result;
      }
      case "click": {
        const locator = browserState.page.locator(`[data-agent-id="${args.id}"]`).first();
        await locator.scrollIntoViewIfNeeded();
        await locator.click({ timeout: 5000 });
        await browserState.page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
        break;
      }
      case "type": {
        const locator = browserState.page.locator(`[data-agent-id="${args.id}"]`).first();
        await locator.scrollIntoViewIfNeeded();
        await locator.fill(String(args.text));
        if (args.pressEnter) {
          await locator.press("Enter");
        }
        await browserState.page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
        break;
      }
      case "scroll": {
        const amount = Number.isFinite(args.amount) ? Number(args.amount) : 700;
        const dy = args.direction === "up" ? -Math.abs(amount) : Math.abs(amount);
        await browserState.page.mouse.wheel(0, dy);
        await browserState.page.waitForTimeout(300);
        break;
      }
      case "press":
        await browserState.page.keyboard.press(String(args.key));
        await browserState.page.waitForTimeout(200);
        break;
      case "back":
        await browserState.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        break;
      case "wait":
        if (browserState.page) {
          await browserState.page.waitForTimeout(Number.isFinite(args.ms) ? Number(args.ms) : 1000);
        } else {
          await new Promise((resolve) => setTimeout(resolve, Number.isFinite(args.ms) ? Number(args.ms) : 1000));
        }
        break;
      case "inspect_project":
      case "list_files":
      case "read_file":
      case "search_files":
      case "write_file":
      case "apply_patch": {
        const result = await executeWorkspaceTool(toolCall.function.name, args, config);
        const eventResult = sanitizeToolResult(result);
        if (result.blocked) {
          await store.appendEvent("tool.blocked", {
            toolName: toolCall.function.name,
            args: safeArgs,
            reason: result.reason,
            category: result.category,
          });
          observers.event("tool.blocked", {
            toolName: toolCall.function.name,
            args: safeArgs,
            reason: result.reason,
            category: result.category,
          });
          return result;
        }

        await store.appendEvent("tool.completed", eventResult);
        observers.event("tool.completed", eventResult);
        const changes = Array.isArray(result.changes) && result.changes.length ? result.changes : result.change ? [result.change] : [];
        for (const item of changes) {
          const change = {
            ...item,
            toolName: toolCall.function.name,
            commandCwd: config.commandCwd,
          };
          await store.appendEvent("file.changed", change);
          observers.event("file.changed", change);
        }
        return result;
      }
      case "run_command": {
        const policy = evaluateCommandPolicy(String(args.command), config);
        if (config.useDockerSandbox) {
          await ensureDockerSandboxReady(config, observers);
        }
        const commandResult = await runShellCommand(String(args.command), config, policy);
        const result = {
          ok: commandResult.ok !== false,
          toolName: "run_command",
          args: safeArgs,
          sandbox: config.useDockerSandbox ? "docker" : "host",
          commandPolicy: {
            category: policy.category,
            sandboxMode: policy.sandboxMode,
            packageInstallPolicy: policy.packageInstallPolicy,
            needsNetwork: Boolean(policy.needsNetwork),
            writesWorkspace: Boolean(policy.writesWorkspace),
          },
          ...commandResult,
        };
        await store.appendEvent("tool.completed", result);
        observers.event("tool.completed", result);
        return result;
      }
      case "delegate_agent": {
        const wrapperResult = await runAgentWrapper(
          {
            wrapper: String(args.wrapper || ""),
            prompt: String(args.prompt || ""),
          },
          config
        );
        const result = {
          ok: Boolean(wrapperResult.ok),
          toolName: "delegate_agent",
          args: safeArgs,
          ...wrapperResult,
        };
        await store.appendEvent("tool.completed", result);
        observers.event("tool.completed", result);
        return result;
      }
      case "generate_image": {
        const imageResult = await generateImage(args, config);
        const result = {
          ok: Boolean(imageResult.ok),
          toolName: "generate_image",
          args: safeArgs,
          ...imageResult,
        };
        const eventResult = sanitizeToolResult(result);
        await store.appendEvent("tool.completed", eventResult);
        observers.event("tool.completed", eventResult);

        if (result.ok) {
          const generated = {
            path: result.path,
            imagePaths: result.imagePaths || [],
            manifestPath: result.manifestPath || "",
            promptPath: result.promptPath || "",
            requestPayloadPath: result.requestPayloadPath || "",
            commandCwd: config.commandCwd,
          };
          await store.appendEvent("image.generated", generated);
          observers.event("image.generated", generated);

          const selectedPath = result.imagePaths?.[0] || result.manifestPath || "";
          if (selectedPath) {
            const normalized = normalizeCanvasPayload(
              {
                title: result.imagePaths?.length ? "Generated image" : "Image generation payload",
                kind: result.imagePaths?.length ? "image" : "json",
                path: selectedPath,
                note: result.summary || "Generated image artifact.",
                selected: Boolean(result.imagePaths?.length),
              },
              config
            );
            if (normalized.ok) {
              const canvasItem = {
                ...normalized.payload,
                toolName: "generate_image",
                commandCwd: config.commandCwd,
              };
              await store.appendEvent("canvas.item", canvasItem);
              observers.event("canvas.item", canvasItem);
              if (canvasItem.selected) {
                await store.appendEvent("canvas.selected", {
                  artifactId: canvasItem.artifactId,
                  title: canvasItem.title,
                  source: "generate_image",
                });
                observers.event("canvas.selected", {
                  artifactId: canvasItem.artifactId,
                  title: canvasItem.title,
                  source: "generate_image",
                });
              }
            }
          }
        }
        return result;
      }
      case "send_to_canvas": {
        const normalized = normalizeCanvasPayload(args, config);
        if (!normalized.ok) {
          await store.appendEvent("tool.blocked", {
            toolName: "send_to_canvas",
            args: safeArgs,
            reason: normalized.reason,
            category: "canvas",
          });
          observers.event("tool.blocked", {
            toolName: "send_to_canvas",
            args: safeArgs,
            reason: normalized.reason,
            category: "canvas",
          });
          return {
            ok: false,
            blocked: true,
            reason: normalized.reason,
            toolName: "send_to_canvas",
          };
        }

        const canvasItem = {
          ...normalized.payload,
          toolName: "send_to_canvas",
          commandCwd: config.commandCwd,
        };
        await store.appendEvent("canvas.item", canvasItem);
        observers.event("canvas.item", canvasItem);
        if (canvasItem.selected) {
          await store.appendEvent("canvas.selected", {
            artifactId: canvasItem.artifactId,
            title: canvasItem.title,
            source: "agent",
          });
          observers.event("canvas.selected", {
            artifactId: canvasItem.artifactId,
            title: canvasItem.title,
            source: "agent",
          });
        }

        const result = {
          ok: true,
          toolName: "send_to_canvas",
          args: safeArgs,
          artifactId: canvasItem.artifactId,
          title: canvasItem.title,
          kind: canvasItem.kind,
          path: canvasItem.path,
          selected: canvasItem.selected,
        };
        await store.appendEvent("tool.completed", result);
        observers.event("tool.completed", result);
        return result;
      }
      case "finish":
        return { ok: true, done: true, result: String(args.result || ""), toolName: "finish" };
      default:
        throw new Error(`Unknown tool: ${toolCall.function.name}`);
    }

    await saveBrowserState(browserState, store);

    const result = {
      ok: true,
      toolName: toolCall.function.name,
      args: safeArgs,
      url: browserState.page?.url() || state.meta.lastUrl || "",
    };

    await store.appendEvent("tool.completed", result);
    observers.event("tool.completed", result);
    return result;
  } catch (error) {
    if (isAbortError(error, config)) throw error;
    const result = {
      ok: false,
      toolName: toolCall.function.name,
      args: safeArgs,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
    await store.appendEvent("tool.failed", result);
    observers.event("tool.failed", result);
    return result;
  }
}

export async function runAgent(config) {
  if (!config.apiKey) {
    throw new Error(`Missing API key for provider "${config.provider}".`);
  }

  const sessionId = config.resume || config.sessionId || `web-agent-${crypto.randomUUID()}`;
  const store = new SessionStore(config.sessionsDir, sessionId);
  const client = createClient(config);
  const observers = createObservers(config);
  const browserState = createBrowserState();

  if (config.allowFileTools || config.allowShellTool) {
    await fs.mkdir(config.commandCwd, { recursive: true });
  }
  await store.ensure();

  let state = await store.loadState();

  if (config.resume && !state) {
    throw new Error(`No saved session found for "${config.resume}".`);
  }

  if (!state) {
    state = createInitialState(config, sessionId);
    await store.appendEvent("session.created", {
      sessionId,
      provider: config.provider,
      model: config.model,
      routingMode: config.routingMode,
      routeReason: config.routeReason,
      goal: config.goal,
    });
    await store.saveState(state);
  } else {
    await store.appendEvent("session.resumed", { sessionId });
    applyContinuationPrompt(state, config, observers);
    await store.saveState(state);
  }

  ensureChatState(state);

  observers.log("session.ready", {
    sessionId,
    provider: config.provider,
    model: config.model,
    routingMode: config.routingMode,
    routeReason: config.routeReason,
  });

  try {
    throwIfAborted(config);
    if (!state.plan) {
      const plan = await createPlan(client, config, state);
      state.plan = plan;
      await store.savePlan(plan);
      await store.appendEvent("plan.created", { plan });
      await store.saveState(state);
      observers.event("plan.created", { plan });
    }

    if (shouldRunParallelScouts(config, state)) {
      const scouts = await runParallelScouts(client, config, state);
      state.meta.parallelScoutsCompleted = true;
      state.meta.parallelScouts = {
        model: scouts.model,
        requested: scouts.requested,
        completed: scouts.completed,
      };
      state.messages.push({
        role: "user",
        content: scouts.summary,
      });
      await store.appendEvent("parallel_scouts.completed", {
        model: scouts.model,
        requested: scouts.requested,
        completed: scouts.completed,
        scouts: scouts.scouts.map((scout) => ({
          name: scout.name,
          model: scout.model,
          content: scout.content || "",
          error: scout.error || "",
        })),
      });
      await store.saveState(state);
      observers.event("parallel_scouts.completed", {
        model: scouts.model,
        requested: scouts.requested,
        completed: scouts.completed,
      });
      emitConsole(config, `Parallel scouts: ${scouts.completed}/${scouts.requested} completed using ${scouts.model}`, {
        kind: "meta",
      });
    }

    const repair = repairModelMessageHistory(state, config);
    if (repair.changed) {
      await store.appendEvent("history.repaired", repair);
      observers.event("history.repaired", repair);
      await store.saveState(state);
    }

    observers.log("session.context", {
      sessionId,
      provider: config.provider,
      model: config.model,
      routingMode: config.routingMode,
      routeReason: config.routeReason,
      taskProfile: config.taskProfile,
      commandCwd: config.commandCwd,
      allowShellTool: config.allowShellTool,
      allowWrapperTools: config.allowWrapperTools,
      preferredWrapper: normalizeWrapperName(config.preferredWrapper),
      allowWebSearch: config.allowWebSearch,
      allowParallelScouts: config.allowParallelScouts,
      parallelScoutCount: config.parallelScoutCount,
      wrappers: config.allowWrapperTools ? wrapperStatusText() : "",
      workspaceFileTools: summarizeWorkspaceTools(config),
      shellSandbox: config.useDockerSandbox ? "docker" : "host",
      sandboxMode: config.sandboxMode,
      packageInstallPolicy: config.packageInstallPolicy,
      dockerSandboxImage: config.useDockerSandbox ? config.dockerSandboxImage : "",
      startUrl: config.startUrl,
    });

    emitConsole(config, `Session: ${sessionId}`, { kind: "meta" });
    emitConsole(config, `Provider: ${config.provider}`, { kind: "meta" });
    emitConsole(config, `Model: ${config.model}`, { kind: "meta" });
    emitConsole(config, `Routing: ${config.routingMode} (${config.routeReason})`, { kind: "meta" });
    emitConsole(config, `Workspace: ${config.commandCwd}`, { kind: "meta" });
    emitConsole(config, `Sessions: ${config.sessionsDir}`, { kind: "meta" });
    if (config.useDockerSandbox) {
      emitConsole(
        config,
        `Docker: image=${config.dockerSandboxImage} mode=${config.sandboxMode} packagePolicy=${config.packageInstallPolicy}`,
        { kind: "meta" }
      );
      emitConsole(config, `Docker workspace: /workspace -> ${config.commandCwd}`, { kind: "meta" });
      emitConsole(config, "Docker env: /aginti-env persistent toolchain; /aginti-cache persistent caches", { kind: "meta" });
    } else if (config.allowShellTool) {
      emitConsole(config, `Shell: host policy=${config.packageInstallPolicy}`, { kind: "meta" });
    }
    if (state.plan) {
      emitConsole(config, "\nPlan:", { kind: "heading" });
      emitConsole(config, state.plan, { kind: "plan", markdown: true });
      emitConsole(config, "", { kind: "meta" });
    }

    for (let step = state.stepsCompleted + 1; step <= config.maxSteps; step += 1) {
      throwIfAborted(config);
      await injectQueuedUserMessages(store, state, observers);
      const snapshot = await buildSnapshot(browserState, store, step, config);
      state.meta.lastUrl = snapshot.url || state.meta.lastUrl;
      await saveBrowserState(browserState, store).catch(() => {});

      await store.appendEvent("snapshot.captured", {
        step,
        url: snapshot.url,
        title: snapshot.title,
        screenshotPath: snapshot.screenshotPath,
        screenshotWarning: snapshot.screenshotWarning || "",
        snapshotPath: snapshot.snapshotPath,
      });
      observers.event("snapshot.captured", {
        step,
        url: snapshot.url,
        title: snapshot.title,
        screenshotPath: snapshot.screenshotPath,
        screenshotWarning: snapshot.screenshotWarning || "",
      });

      state.messages.push({
        role: "user",
        content: `Step ${step}/${config.maxSteps} (${config.maxSteps - step} steps remain after this one). Latest runtime snapshot:\n${JSON.stringify({
          title: snapshot.title,
          url: snapshot.url,
          pageText: snapshot.pageText,
          elements: snapshot.elements,
          browserOpen: Boolean(browserState.page),
          shellToolAvailable: config.allowShellTool,
          fileToolsAvailable: config.allowFileTools,
          workspaceFileTools: summarizeWorkspaceTools(config),
          agentWrappersAvailable: config.allowWrapperTools,
          preferredWrapper: normalizeWrapperName(config.preferredWrapper),
          agentWrappers: config.allowWrapperTools ? wrapperStatusText() : "",
          webSearchAvailable: config.allowWebSearch !== false,
          parallelScouts: state.meta.parallelScouts || null,
          shellSandbox: config.useDockerSandbox ? "docker" : "host",
          sandboxMode: config.sandboxMode,
          packageInstallPolicy: config.packageInstallPolicy,
          dockerWorkspace: config.useDockerSandbox ? "/workspace" : "",
          dockerPersistentEnv: config.useDockerSandbox ? "/aginti-env" : "",
          dockerPersistentCache: config.useDockerSandbox ? "/aginti-cache" : "",
          commandCwd: config.commandCwd,
          plan: state.plan || "",
          suggestedStartUrl: config.startUrl || "",
          canvasArtifactsAvailable: true,
          taskProfile: getTaskProfile(config.taskProfile),
        })}`,
      });

      throwIfAborted(config);
      const response = await requestNextStep(client, config, state.messages);
      const assistantMessage = response.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error("Model returned no assistant message.");
      }

      state.messages.push(preserveAssistantMessage(assistantMessage));

      await store.appendEvent("model.responded", {
        step,
        content: assistantMessage.content || "",
        toolCalls: (assistantMessage.tool_calls || []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: redactSensitiveText(call.function.arguments),
        })),
      });
      observers.event("model.responded", {
        step,
        content: assistantMessage.content || "",
      });

      const toolCalls = assistantMessage.tool_calls || [];

      if (toolCalls.length === 0) {
        const fallback = assistantMessage.content?.trim() || "No tool call returned.";
        appendChatEntry(state, "assistant", fallback);
        await store.appendEvent("session.finished", {
          result: fallback,
          mode: "assistant-content",
        });
        observers.event("session.finished", {
          result: fallback,
          sessionId,
        });
        emitConsole(config, fallback, { kind: "assistant", markdown: true });
        state.stepsCompleted = step;
        state.updatedAt = new Date().toISOString();
        await store.saveState(state);
        return {
          sessionId,
          result: fallback,
        };
      }

      for (const toolCall of toolCalls) {
        throwIfAborted(config);
        const toolResult = await executeTool(browserState, toolCall, snapshot, config, store, observers, state);
        state.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        });
        await applyToolLoopGuard(state, toolResult, store, observers);

        if (toolResult.toolName === "run_command") {
          observers.log("command.output", {
            command: redactSensitiveText(toolResult.args?.command || ""),
            stdout: toolResult.stdout || "",
            stderr: toolResult.stderr || "",
            commandPolicy: toolResult.commandPolicy,
            blocked: Boolean(toolResult.blocked),
            error: toolResult.error || toolResult.reason || "",
          });
        }

        if (WORKSPACE_TOOLS.has(toolResult.toolName)) {
          observers.log("workspace.output", sanitizeToolResult(toolResult));
        }

        if (toolResult.toolName === "delegate_agent") {
          observers.log("wrapper.output", {
            wrapper: toolResult.wrapper,
            ok: toolResult.ok,
            fallback: Boolean(toolResult.fallback),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            error: toolResult.error,
          });
        }

        if (config.provider === "mock" && toolResult.ok === false && !toolResult.blocked) {
          throw new Error(
            `Mock tool failed: ${toolResult.error || toolResult.reason || `${toolResult.toolName || "tool"} returned ok=false`}`
          );
        }

        if (toolResult.done) {
          state.stepsCompleted = step;
          state.updatedAt = new Date().toISOString();
          state.meta.lastUrl = browserState.page?.url() || state.meta.lastUrl;
          state.messages.push({
            role: "assistant",
            content: toolResult.result,
          });
          appendChatEntry(state, "assistant", toolResult.result);
          await store.saveState(state);
          await store.appendEvent("session.finished", {
            result: toolResult.result,
            mode: "finish-tool",
          });
          observers.event("session.finished", {
            result: toolResult.result,
            sessionId,
          });
          emitConsole(config, toolResult.result, { kind: "assistant", markdown: true });
          return {
            sessionId,
            result: toolResult.result,
          };
        }
      }

      await injectQueuedUserMessages(store, state, observers);

      state.stepsCompleted = step;
      state.updatedAt = new Date().toISOString();
      await store.saveState(state);
    }

    await store.appendEvent("session.stopped", {
      reason: "max_steps_reached",
      maxSteps: config.maxSteps,
    });
    observers.event("session.stopped", {
      reason: "max_steps_reached",
      sessionId,
    });
    emitConsole(config, `Stopped after ${config.maxSteps} steps without finish().`, { kind: "error", error: true });
    return {
      sessionId,
      result: "",
      stopped: true,
      reason: "max_steps_reached",
    };
  } catch (error) {
    if (!isAbortError(error, config)) throw error;
    state.stepsCompleted = state.stepsCompleted || 0;
    state.updatedAt = new Date().toISOString();
    await store.saveState(state).catch(() => {});
    await store.appendEvent("session.stopped", {
      reason: "user_interrupt",
    });
    observers.event("session.stopped", {
      reason: "user_interrupt",
      sessionId,
    });
    return {
      sessionId,
      result: "",
      stopped: true,
      reason: "user_interrupt",
    };
  } finally {
    await closeBrowser(browserState, store);
  }
}
