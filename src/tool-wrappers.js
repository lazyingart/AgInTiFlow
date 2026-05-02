import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { getModelPresets } from "./model-routing.js";
import { redactSensitiveText } from "./redaction.js";

const execFile = promisify(execFileCallback);

export const WRAPPER_NAMES = ["codex", "claude", "gemini", "copilot", "qwen"];
export const DEFAULT_WRAPPER_NAME = "codex";

const BASE_ADVISORY_PROMPT = [
  "You are being called as an advisory wrapper tool inside AgInTiFlow.",
  "Do not modify files, run destructive commands, push commits, install packages, or use secrets.",
  "Return concise findings, commands to consider, or an implementation plan.",
].join(" ");

function commandExists(command) {
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

function buildPrompt(prompt) {
  return `${BASE_ADVISORY_PROMPT}\n\nTask:\n${prompt}`;
}

function codexArgs(prompt, config, preset) {
  return [
    "exec",
    "--model",
    preset.model,
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
  const presets = getModelPresets();
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
      role: `Coding enhancement wrapper; primary ${presets.codexPrimary.model} ${presets.codexPrimary.reasoning}, spare ${presets.codexSpare.model} ${presets.codexSpare.reasoning}.`,
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

export function wrapperStatusText() {
  return listAgentWrappers()
    .map((wrapper) => `${wrapper.name}:${wrapper.available ? "available" : "missing"}`)
    .join(", ");
}

export async function runAgentWrapper({ wrapper, prompt }, config) {
  if (!isKnownWrapper(wrapper)) {
    return { ok: false, wrapper, error: `Unknown wrapper: ${wrapper}` };
  }

  const commandSpec = wrapperCommand(wrapper, prompt, config);
  if (!commandSpec || !commandExists(commandSpec.command)) {
    return { ok: false, wrapper, error: `Wrapper command is not available: ${wrapper}` };
  }

  const runOnce = async (spec) =>
    execFile(spec.command, spec.args, {
      cwd: config.commandCwd,
      timeout: Number(config.wrapperTimeoutMs) || 120000,
      maxBuffer: 512 * 1024,
      env: process.env,
    });

  try {
    const result = await runOnce(commandSpec);
    return {
      ok: true,
      wrapper,
      stdout: cleanOutput(result.stdout, 12000),
      stderr: cleanOutput(result.stderr, 4000),
    };
  } catch (error) {
    if (wrapper === "codex") {
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
        return {
          ok: false,
          wrapper,
          error: redactSensitiveText(fallbackError instanceof Error ? fallbackError.message : String(fallbackError)),
          primaryError: redactSensitiveText(error instanceof Error ? error.message : String(error)),
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
