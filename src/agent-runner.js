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

const exec = promisify(execCallback);
const BROWSER_TOOLS = new Set(["open_url", "click", "type", "scroll", "press", "back"]);

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
              ? "A read-only shell command tool is available inside a Docker sandbox with no network and a mounted working directory."
              : "A read-only shell command tool is available for short local inspection tasks."
            : "No shell command tool is available.",
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
              ? `Shell working directory mounted into Docker: ${config.commandCwd}`
              : `Shell working directory: ${config.commandCwd}`
            : "",
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
          ? `Shell working directory mounted into Docker: ${config.commandCwd}`
          : `Shell working directory: ${config.commandCwd}`
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

async function runShellCommand(command, config) {
  if (config.useDockerSandbox) {
    return runDockerSandboxCommand(command, config);
  }

  const result = await exec(command, {
    cwd: config.commandCwd,
    timeout: 5000,
    maxBuffer: 200 * 1024,
    shell: "/bin/bash",
  });

  return {
    stdout: result.stdout.trim().slice(0, 8000),
    stderr: result.stderr.trim().slice(0, 4000),
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
          ? `Shell tool available in Docker with mounted workspace: ${config.commandCwd}`
          : `Shell tool available in: ${config.commandCwd}`
        : "Shell tool disabled.",
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
  const guard = checkToolUse({
    toolName: toolCall.function.name,
    args,
    snapshot,
    config,
  });

  if (!guard.allowed) {
    await store.appendEvent("tool.blocked", {
      toolName: toolCall.function.name,
      args,
      reason: guard.reason,
    });
    observers.event("tool.blocked", {
      toolName: toolCall.function.name,
      args,
      reason: guard.reason,
    });
    return {
      ok: false,
      blocked: true,
      reason: guard.reason,
      toolName: toolCall.function.name,
    };
  }

  await store.appendEvent("tool.started", {
    toolName: toolCall.function.name,
    args,
  });
  observers.event("tool.started", {
    toolName: toolCall.function.name,
    args,
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
      case "run_command": {
        if (config.useDockerSandbox) {
          await ensureDockerSandboxReady(config, observers);
        }
        const commandResult = await runShellCommand(String(args.command), config);
        const result = {
          ok: true,
          toolName: "run_command",
          args,
          sandbox: config.useDockerSandbox ? "docker" : "host",
          ...commandResult,
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
      args,
      url: browserState.page?.url() || state.meta.lastUrl || "",
    };

    await store.appendEvent("tool.completed", result);
    observers.event("tool.completed", result);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      toolName: toolCall.function.name,
      args,
      error: error instanceof Error ? error.message : String(error),
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
      commandCwd: config.commandCwd,
      allowShellTool: config.allowShellTool,
      shellSandbox: config.useDockerSandbox ? "docker" : "host",
      dockerSandboxImage: config.useDockerSandbox ? config.dockerSandboxImage : "",
      startUrl: config.startUrl,
    });

    console.log(`Session: ${sessionId}`);
    console.log(`Provider: ${config.provider}`);
    console.log(`Model: ${config.model}`);
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
          shellSandbox: config.useDockerSandbox ? "docker" : "host",
          commandCwd: config.commandCwd,
          suggestedStartUrl: config.startUrl || "",
        })}`,
      });

      const response = await requestNextStep(client, config, state.messages);
      const assistantMessage = response.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error("Model returned no assistant message.");
      }

      state.messages.push({
        role: "assistant",
        content: assistantMessage.content || "",
        tool_calls: assistantMessage.tool_calls,
      });

      await store.appendEvent("model.responded", {
        step,
        content: assistantMessage.content || "",
        toolCalls: (assistantMessage.tool_calls || []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
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
            command: toolResult.args.command,
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
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
