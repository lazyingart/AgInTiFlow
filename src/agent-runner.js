import crypto from "node:crypto";
import fs from "node:fs/promises";
import { exec as execCallback } from "node:child_process";
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
import { executeWorkspaceTool, summarizeWorkspaceTools, WORKSPACE_TOOL_NAMES } from "./workspace-tools.js";
import { normalizeCanvasPayload } from "./artifact-tunnel.js";

const exec = promisify(execCallback);
const BROWSER_TOOLS = new Set(["open_url", "click", "type", "scroll", "press", "back"]);
const WORKSPACE_TOOLS = new Set(WORKSPACE_TOOL_NAMES);

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

function createInitialState(config, sessionId) {
  const now = new Date().toISOString();
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
          "If the shell tool can satisfy a local task, prefer it before opening a browser.",
          "Do not open a browser page just because a start URL exists. Treat it as a suggestion only.",
          "Only reference element ids from the latest browser snapshot.",
          "Prefer short, deliberate actions over guessing.",
          "Never navigate outside the allowed domains when an allowlist exists.",
          "Avoid destructive actions, purchases, account changes, and sensitive workflows.",
          config.allowShellTool
            ? config.useDockerSandbox
              ? `A shell command tool is available inside Docker sandbox mode ${config.sandboxMode}. Read-only commands have no network. Package installs or environment setup require approved package policy and Docker workspace-write mode.`
              : "A read-only host shell command tool is available for short local inspection tasks."
            : "No shell command tool is available.",
          config.allowFileTools
            ? `Workspace file tools are available in ${config.commandCwd}: list_files, read_file, search_files, write_file, and apply_patch. Always use workspace-relative paths such as plot_fx.svg or docs/report.tex, never absolute host paths. Secret paths, .git internals, node_modules writes, and huge files are blocked.`
            : "No workspace file tools are available.",
          config.allowWrapperTools
            ? `External coding-agent wrappers are available as advisory tools only. Use the selected wrapper only: ${normalizeWrapperName(config.preferredWrapper)}. Wrapper status: ${wrapperStatusText()}.`
            : "External coding-agent wrappers are disabled.",
          "A frontend canvas/artifacts tunnel exists. Use send_to_canvas when important markdown, diffs, screenshots, images, or workspace files should be highlighted in the UI. It is optional and ordinary final text can still go directly to finish.",
          "For visual-output requests such as draw, plot, graph, chart, diagram, figure, image, or visualization, proactively publish a canvas artifact even when the user does not mention canvas. If workspace file tools are enabled, prefer creating a small SVG or markdown artifact and call send_to_canvas with selected=true.",
          "For LaTeX/PDF requests, create a .tex file, compile it when shell toolchain support is available with an allowlisted command such as latexmk -pdf -interaction=nonstopmode -halt-on-error report.tex, and publish the resulting PDF through send_to_canvas. Prefer Docker workspace-write mode for compilation.",
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
              ? `Shell working directory mounted into Docker as /workspace from ${config.commandCwd}. Use relative paths or /workspace paths, not absolute host temp paths. Sandbox mode: ${config.sandboxMode}. Package install policy: ${config.packageInstallPolicy}.`
              : `Shell working directory: ${config.commandCwd}`
            : "",
          config.allowFileTools ? `Workspace file tools enabled in: ${config.commandCwd}. Use workspace-relative paths.` : "",
          config.allowWrapperTools
            ? `Agent wrappers: selected=${normalizeWrapperName(config.preferredWrapper)}; ${wrapperStatusText()}`
            : "",
          "Canvas/artifacts tunnel: available through send_to_canvas for optional frontend rendering.",
          "Visual-output requests should produce a canvas artifact without requiring the user to ask for canvas explicitly.",
          "LaTeX/PDF requests should produce a .tex artifact and, when possible, a compiled PDF artifact using latexmk -pdf -interaction=nonstopmode -halt-on-error report.tex.",
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
          ? `Shell working directory mounted into Docker as /workspace from ${config.commandCwd}. Use relative paths or /workspace paths. Sandbox mode: ${config.sandboxMode}. Package install policy: ${config.packageInstallPolicy}.`
          : `Shell working directory: ${config.commandCwd}`
        : "",
      config.allowFileTools ? `Workspace file tools enabled in: ${config.commandCwd}. Use workspace-relative paths.` : "",
      config.allowWrapperTools
        ? `Agent wrappers: selected=${normalizeWrapperName(config.preferredWrapper)}; ${wrapperStatusText()}`
        : "",
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
      search: typeof args.search === "string" ? redactSensitiveText(args.search).slice(0, 160) : safeArgs.search,
      replace: typeof args.replace === "string" ? redactSensitiveText(args.replace).slice(0, 160) : safeArgs.replace,
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

async function runShellCommand(command, config, policy = evaluateCommandPolicy(command, config)) {
  if (config.useDockerSandbox) {
    return runDockerSandboxCommand(command, config, policy);
  }

  const result = await exec(command, {
    cwd: config.commandCwd,
    timeout: 5000,
    maxBuffer: 200 * 1024,
    shell: "/bin/bash",
    env: safeExecutionEnv(),
  });

  return {
    stdout: redactSensitiveText(result.stdout).trim().slice(0, 8000),
    stderr: redactSensitiveText(result.stderr).trim().slice(0, 4000),
  };
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
          ? `Shell tool available in Docker with mounted workspace /workspace from ${config.commandCwd}. Use relative paths or /workspace paths. Sandbox mode: ${config.sandboxMode}. Package install policy: ${config.packageInstallPolicy}.`
          : `Shell tool available in: ${config.commandCwd}`
        : "Shell tool disabled.",
      config.allowFileTools
        ? `Workspace file tools available in: ${config.commandCwd}. Use workspace-relative paths.`
        : "Workspace file tools disabled.",
      config.allowWrapperTools
        ? `Agent wrappers available: selected=${normalizeWrapperName(config.preferredWrapper)}; ${wrapperStatusText()}`
        : "Agent wrappers disabled.",
      "Canvas/artifacts tunnel available through send_to_canvas.",
      "For draw/plot/graph/chart/diagram/figure requests, publish a canvas artifact proactively.",
      "For LaTeX/PDF requests, publish the .tex and compiled PDF artifacts when available. Prefer latexmk -pdf -interaction=nonstopmode -halt-on-error report.tex.",
      "Use open_url only if the task actually needs the web.",
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

async function executeTool(browserState, toolCall, snapshot, config, store, observers, state) {
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
        await browserState.page.goto(String(args.url), { waitUntil: "domcontentloaded" });
        break;
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
        if (result.change) {
          const change = {
            ...result.change,
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
          ok: true,
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
    if (!state.plan) {
      const plan = await createPlan(client, config, state);
      state.plan = plan;
      state.messages.push({
        role: "assistant",
        content: `Execution plan:\n${plan}`,
      });
      await store.savePlan(plan);
      await store.appendEvent("plan.created", { plan });
      await store.saveState(state);
      observers.event("plan.created", { plan });
    }

    observers.log("session.context", {
      sessionId,
      provider: config.provider,
      model: config.model,
      routingMode: config.routingMode,
      routeReason: config.routeReason,
      commandCwd: config.commandCwd,
      allowShellTool: config.allowShellTool,
      allowWrapperTools: config.allowWrapperTools,
      preferredWrapper: normalizeWrapperName(config.preferredWrapper),
      wrappers: config.allowWrapperTools ? wrapperStatusText() : "",
      workspaceFileTools: summarizeWorkspaceTools(config),
      shellSandbox: config.useDockerSandbox ? "docker" : "host",
      sandboxMode: config.sandboxMode,
      packageInstallPolicy: config.packageInstallPolicy,
      dockerSandboxImage: config.useDockerSandbox ? config.dockerSandboxImage : "",
      startUrl: config.startUrl,
    });

    console.log(`Session: ${sessionId}`);
    console.log(`Provider: ${config.provider}`);
    console.log(`Model: ${config.model}`);
    console.log(`Routing: ${config.routingMode} (${config.routeReason})`);
    if (state.plan) {
      console.log("\nPlan:");
      console.log(state.plan);
      console.log("");
    }

    for (let step = state.stepsCompleted + 1; step <= config.maxSteps; step += 1) {
      const snapshot = await buildSnapshot(browserState, store, step, config);
      state.meta.lastUrl = snapshot.url || state.meta.lastUrl;
      await saveBrowserState(browserState, store).catch(() => {});

      await store.appendEvent("snapshot.captured", {
        step,
        url: snapshot.url,
        title: snapshot.title,
        screenshotPath: snapshot.screenshotPath,
        snapshotPath: snapshot.snapshotPath,
      });
      observers.event("snapshot.captured", {
        step,
        url: snapshot.url,
        title: snapshot.title,
        screenshotPath: snapshot.screenshotPath,
      });

      state.messages.push({
        role: "user",
        content: `Step ${step}/${config.maxSteps}. Latest runtime snapshot:\n${JSON.stringify({
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
          shellSandbox: config.useDockerSandbox ? "docker" : "host",
          sandboxMode: config.sandboxMode,
          packageInstallPolicy: config.packageInstallPolicy,
          commandCwd: config.commandCwd,
          suggestedStartUrl: config.startUrl || "",
          canvasArtifactsAvailable: true,
        })}`,
      });

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
        console.log(fallback);
        state.stepsCompleted = step;
        state.updatedAt = new Date().toISOString();
        await store.saveState(state);
        return {
          sessionId,
          result: fallback,
        };
      }

      for (const toolCall of toolCalls) {
        const toolResult = await executeTool(browserState, toolCall, snapshot, config, store, observers, state);
        state.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        });

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
          console.log(toolResult.result);
          return {
            sessionId,
            result: toolResult.result,
          };
        }
      }

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
    console.error(`Stopped after ${config.maxSteps} steps without finish().`);
    return {
      sessionId,
      result: "",
    };
  } finally {
    await closeBrowser(browserState, store);
  }
}
