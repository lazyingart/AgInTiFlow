import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getModelPresets, CODEX_CLI_DEFAULT_MODEL } from "./model-routing.js";
import { redactSensitiveText } from "./redaction.js";

export const WRAPPER_NAMES = ["codex", "claude", "gemini", "copilot", "qwen"];
export const DEFAULT_WRAPPER_NAME = "codex";

const BASE_ADVISORY_PROMPT = [
  "You are being called as an advisory wrapper tool inside AgInTiFlow.",
  "Do not modify files, run destructive commands, push commits, install packages, or use secrets.",
  "Return concise findings, commands to consider, or an implementation plan.",
].join(" ");

export function commandExists(command) {
  try {
    if (process.platform === "win32") {
      execFileSync("where", [command], { stdio: "ignore" });
    } else {
      execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function cleanOutput(value, limit) {
  return redactSensitiveText(value).trim().slice(0, limit);
}

function killChildTree(child, signal = "SIGTERM") {
  // `killed` records signal delivery, not exit. In particular, it must not
  // suppress the later SIGKILL of a still-open process group.
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process may already have exited.
    }
  }
}

function wrapperAbortError() {
  const error = new Error("Wrapper interrupted by user.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function assertWrapperNotAborted(config) {
  if (config.abortSignal?.aborted) throw wrapperAbortError();
}

function mayTrySpare(error) {
  return error?.name !== "AbortError" && error?.code !== "ABORT_ERR" &&
    error?.code !== 124 && error?.code !== "WRAPPER_TERMINATION_UNPROVEN" &&
    error?.code !== "WRAPPER_SIGNALLED" && error?.code !== "WRAPPER_PROCESS_ERROR";
}

function runWrapperProcess(spec, config) {
  assertWrapperNotAborted(config);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: config.commandCwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const requestedTimeout = Number(config.wrapperTimeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 120000;
    const maxStdout = 512 * 1024;
    const maxStderr = 128 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let processError = null;
    let stopping = false;
    let killTimer = null;
    let closeTimer = null;

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      if (config.abortSignal && onAbort) config.abortSignal.removeEventListener("abort", onAbort);
      callback();
    };
    const makeError = (message, code = 1) => {
      const error = new Error(message);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      return error;
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      killTimer = setTimeout(() => {
        closeTimer = setTimeout(() => {
          const error = makeError("Wrapper termination could not be confirmed.", "WRAPPER_TERMINATION_UNPROVEN");
          if (aborted) error.name = "AbortError";
          settle(() => reject(error));
        }, 3000);
        killChildTree(child, "SIGKILL");
      }, 1200);
      killChildTree(child, "SIGTERM");
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxStdout) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxStderr) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        processError = makeError("Wrapper process failed; waiting for termination.", "WRAPPER_PROCESS_ERROR");
        stop();
        return;
      }
      settle(() => reject(makeError(error instanceof Error ? error.message : String(error), 1)));
    });
    child.on("close", (code, signal) => {
      if (aborted) {
        const error = makeError("Wrapper interrupted by user.", "ABORT_ERR");
        error.name = "AbortError";
        settle(() => reject(error));
        return;
      }
      if (timedOut) {
        settle(() => reject(makeError(`Wrapper timed out after ${timeoutMs}ms.`, 124)));
        return;
      }
      if (processError) {
        settle(() => reject(processError));
        return;
      }
      if (code === 0 && !signal) {
        settle(() => resolve({ stdout, stderr }));
        return;
      }
      settle(() => reject(makeError(`Wrapper exited with ${signal || code}.`, signal ? "WRAPPER_SIGNALLED" : Number.isInteger(code) ? code : 1)));
    });
    if (config.abortSignal) config.abortSignal.addEventListener("abort", onAbort, { once: true });
    // Covers cancellation during spawn/setup without returning before close.
    if (config.abortSignal?.aborted) onAbort();
  });
}

function buildPrompt(prompt) {
  return `${BASE_ADVISORY_PROMPT}\n\nTask:\n${prompt}`;
}

function codexArgs(prompt, config, preset) {
  return [
    "exec",
    ...(preset.model === CODEX_CLI_DEFAULT_MODEL ? [] : ["--model", preset.model]),
    "-c",
    `model_reasoning_effort="${preset.reasoning}"`,
    "--sandbox",
    "read-only",
    "--cd",
    config.commandCwd,
    "--skip-git-repo-check",
    buildPrompt(prompt),
  ];
}

function wrapperCommand(wrapper, prompt, config, { fallback = false } = {}) {
  const presets = getModelPresets({
    wrapperModel: config.wrapperModel,
    wrapperReasoning: config.wrapperReasoning,
  });
  switch (wrapper) {
    case "codex":
      return {
        command: "codex",
        args: codexArgs(prompt, config, fallback ? presets.codexSpare : presets.codexPrimary),
      };
    case "claude":
      return {
        command: "claude",
        args: [
          "--print",
          "--permission-mode",
          "plan",
          "--output-format",
          "text",
          "--model",
          process.env.CLAUDE_WRAPPER_MODEL || "sonnet",
          buildPrompt(prompt),
        ],
      };
    case "gemini":
      return {
        command: "gemini",
        args: ["--prompt", buildPrompt(prompt)],
      };
    case "copilot":
      return {
        command: "gh",
        args: ["copilot", "-p", buildPrompt(prompt)],
      };
    case "qwen":
      return {
        command: "qwen",
        args: ["--approval-mode", "plan", "--output-format", "text", buildPrompt(prompt)],
      };
    default:
      return null;
  }
}

export function isKnownWrapper(wrapper) {
  return WRAPPER_NAMES.includes(wrapper);
}

export function normalizeWrapperName(wrapper, fallback = DEFAULT_WRAPPER_NAME) {
  const candidate = String(wrapper || "").trim().toLowerCase();
  return isKnownWrapper(candidate) ? candidate : fallback;
}

export function listAgentWrappers() {
  const presets = getModelPresets();
  return [
    {
      name: "codex",
      label: "Codex",
      available: commandExists("codex"),
      role: presets.codexPrimary.model === CODEX_CLI_DEFAULT_MODEL
        ? "Optional advice using the configured Codex CLI model; no automatic model substitution."
        : `Coding enhancement wrapper; primary ${presets.codexPrimary.model} ${presets.codexPrimary.reasoning}, spare ${presets.codexSpare.model} ${presets.codexSpare.reasoning}.`,
    },
    {
      name: "claude",
      label: "Claude Code",
      available: commandExists("claude"),
      role: "Planning and codebase reasoning wrapper in plan mode.",
    },
    {
      name: "gemini",
      label: "Gemini CLI",
      available: commandExists("gemini"),
      role: "General research and large-context CLI wrapper when installed.",
    },
    {
      name: "copilot",
      label: "GitHub Copilot CLI",
      available: commandExists("gh"),
      role: "GitHub/Copilot CLI wrapper when authenticated.",
    },
    {
      name: "qwen",
      label: "Qwen Code",
      available: commandExists("qwen"),
      role: "Chinese/open provider coding wrapper in plan approval mode.",
    },
  ];
}

export function isWrapperAvailable(wrapper) {
  const candidate = normalizeWrapperName(wrapper);
  return Boolean(wrapperCommand(candidate, "", {}, {}) && commandExists(wrapperCommand(candidate, "", {}, {}).command));
}

export function wrapperStatusText() {
  return listAgentWrappers()
    .map((wrapper) => `${wrapper.name}:${wrapper.available ? "available" : "missing"}`)
    .join(", ");
}

export async function runAgentWrapper({ wrapper, prompt }, config) {
  assertWrapperNotAborted(config);
  if (!isKnownWrapper(wrapper)) {
    return { ok: false, wrapper, error: `Unknown wrapper: ${wrapper}` };
  }

  const commandSpec = wrapperCommand(wrapper, prompt, config);
  if (!commandSpec || !commandExists(commandSpec.command)) {
    return { ok: false, wrapper, error: `Wrapper command is not available: ${wrapper}` };
  }

  const runOnce = async (spec) => runWrapperProcess(spec, config);

  try {
    const result = await runOnce(commandSpec);
    return {
      ok: true,
      wrapper,
      stdout: cleanOutput(result.stdout, 12000),
      stderr: cleanOutput(result.stderr, 4000),
    };
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
    if (wrapper === "codex" && getModelPresets({ wrapperModel: config.wrapperModel }).codexPrimary.model !== CODEX_CLI_DEFAULT_MODEL && mayTrySpare(error)) {
      const fallbackSpec = wrapperCommand(wrapper, prompt, config, { fallback: true });
      try {
        const fallback = await runOnce(fallbackSpec);
        return {
          ok: true,
          wrapper,
          fallback: true,
          stdout: cleanOutput(fallback.stdout, 12000),
          stderr: cleanOutput(fallback.stderr, 4000),
        };
      } catch (fallbackError) {
        if (fallbackError?.name === "AbortError" || fallbackError?.code === "ABORT_ERR") throw fallbackError;
        return {
          ok: false,
          wrapper,
          error: redactSensitiveText(fallbackError instanceof Error ? fallbackError.message : String(fallbackError)),
          primaryError: redactSensitiveText(error instanceof Error ? error.message : String(error)),
          stdout: cleanOutput(fallbackError.stdout, 8000),
          stderr: cleanOutput(fallbackError.stderr, 4000),
          primaryStderr: cleanOutput(error.stderr, 4000),
        };
      }
    }

    return {
      ok: false,
      wrapper,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      stdout: cleanOutput(error.stdout, 8000),
      stderr: cleanOutput(error.stderr, 4000),
    };
  }
}

function codexImageArgs(prompt, imagePaths, config, preset, outputFile) {
  const imageArgs = [];
  for (const imagePath of imagePaths || []) {
    imageArgs.push("--image", imagePath);
  }
  return [
    "exec",
    ...(preset.model === CODEX_CLI_DEFAULT_MODEL ? [] : ["--model", preset.model]),
    "-c",
    `model_reasoning_effort="${preset.reasoning}"`,
    "--sandbox",
    "read-only",
    "--cd",
    config.commandCwd,
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile,
    ...imageArgs,
    "--",
    buildPrompt(prompt),
  ];
}

export async function runCodexImageWrapper({ prompt, imagePaths = [] }, config) {
  assertWrapperNotAborted(config);
  if (!commandExists("codex")) {
    return { ok: false, wrapper: "codex", error: "Codex CLI is not available on PATH." };
  }
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    return { ok: false, wrapper: "codex", error: "At least one image file is required for Codex image reading." };
  }

  const presets = getModelPresets({
    wrapperModel: config.wrapperModel,
    wrapperReasoning: config.wrapperReasoning,
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-codex-image-"));
  const runOnce = async (preset, label) => {
    const outputFile = path.join(tempDir, `${label}.txt`);
    const result = await runWrapperProcess(
      {
        command: "codex",
        args: codexImageArgs(prompt, imagePaths, config, preset, outputFile),
      },
      config
    );
    const lastMessage = await fs.readFile(outputFile, "utf8").catch(() => "");
    assertWrapperNotAborted(config);
    return {
      stdout: cleanOutput(lastMessage || result.stdout, 24000),
      stderr: cleanOutput(result.stderr, 4000),
    };
  };

  try {
    const result = await runOnce(presets.codexPrimary, "primary");
    return {
      ok: true,
      wrapper: "codex",
      model: presets.codexPrimary.model,
      reasoning: presets.codexPrimary.reasoning,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
    if (presets.codexPrimary.model === CODEX_CLI_DEFAULT_MODEL || !mayTrySpare(error)) {
      return {
        ok: false,
        wrapper: "codex",
        error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        stdout: cleanOutput(error.stdout, 8000),
        stderr: cleanOutput(error.stderr, 4000),
      };
    }
    try {
      const fallback = await runOnce(presets.codexSpare, "fallback");
      return {
        ok: true,
        wrapper: "codex",
        fallback: true,
        model: presets.codexSpare.model,
        reasoning: presets.codexSpare.reasoning,
        stdout: fallback.stdout,
        stderr: fallback.stderr,
      };
    } catch (fallbackError) {
      if (fallbackError?.name === "AbortError" || fallbackError?.code === "ABORT_ERR") throw fallbackError;
      return {
        ok: false,
        wrapper: "codex",
        error: redactSensitiveText(fallbackError instanceof Error ? fallbackError.message : String(fallbackError)),
        primaryError: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        stdout: cleanOutput(fallbackError.stdout, 8000),
        stderr: cleanOutput(fallbackError.stderr, 4000),
      };
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
