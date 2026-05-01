import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { runAgent } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import { initProject, listProjectSessions, providerKeyStatus, setProviderKey } from "./project.js";
import { normalizePackageInstallPolicy, normalizeSandboxMode } from "./command-policy.js";
import { defaultMaxStepsForProfile, normalizeTaskProfile } from "./task-profiles.js";
import { promptAndSaveDeepSeekKey, promptHidden, shouldPromptForDeepSeek } from "./auth-onboarding.js";

const useColor = Boolean(input.isTTY && output.isTTY && process.env.AGINTIFLOW_NO_COLOR !== "1");
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  clearLine: "\x1b[2K",
  cursorHide: "\x1b[?25l",
  cursorShow: "\x1b[?25h",
  userBg: "\x1b[48;5;24m\x1b[38;5;231m",
  agentBg: "\x1b[48;5;29m\x1b[38;5;231m",
  systemBg: "\x1b[48;5;236m\x1b[38;5;245m",
};
const brandPalette = ["\x1b[38;5;45m", "\x1b[38;5;81m", "\x1b[38;5;86m", "\x1b[38;5;118m", "\x1b[38;5;226m"];
const SLASH_COMMANDS = [
  "/help",
  "/status",
  "/login",
  "/auth",
  "/auxilliary",
  "/auxiliary",
  "/new",
  "/resume",
  "/sessions",
  "/profile",
  "/routing",
  "/provider",
  "/model",
  "/docker",
  "/latex",
  "/installs",
  "/cwd",
  "/init",
  "/web",
  "/exit",
];

function color(value, ...codes) {
  if (!useColor || codes.length === 0) return String(value);
  return `${codes.join("")}${value}${ansi.reset}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function label(name, bgCode) {
  return color(` ${name} `, bgCode, ansi.bold);
}

function userPrompt() {
  return `\n${label("user>", ansi.userBg)} ${color("|", ansi.userBg)} `;
}

function commandCompleter(line = "") {
  const trimmed = String(line || "");
  if (!trimmed.startsWith("/")) return [[], trimmed];
  const hits = SLASH_COMMANDS.filter((command) => command.startsWith(trimmed));
  return [hits.length > 0 ? hits : SLASH_COMMANDS, trimmed];
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function promptGutter() {
  const visible = stripAnsi(userPrompt()).replace(/^\n/, "").length;
  return " ".repeat(Math.max(visible - 2, 0)) + `${color("|", ansi.userBg)} `;
}

function commandSuggestions(line = "") {
  const trimmed = String(line || "");
  if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return [];
  return SLASH_COMMANDS.filter((command) => command.startsWith(trimmed)).slice(0, 8);
}

function stripMarkdown(text) {
  const lines = String(text || "").split(/\r?\n/);
  let inFence = false;
  const rendered = [];

  for (const rawLine of lines) {
    let line = rawLine;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (inFence) {
        const language = line.replace(/^\s*```/, "").trim();
        rendered.push(color(language ? `code ${language}` : "code", ansi.dim));
      }
      continue;
    }

    if (!inFence) {
      if (/^\s*[-*_]{3,}\s*$/.test(line)) {
        rendered.push(color("-".repeat(42), ansi.dim));
        continue;
      }
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (heading) {
        rendered.push(color(heading[2].replace(/\s+#*$/, ""), ansi.bold, ansi.cyan));
        continue;
      }
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
        continue;
      }
      line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
      line = line.replace(/\*\*([^*]+)\*\*/g, (_, value) => color(value, ansi.bold));
      line = line.replace(/__([^_]+)__/g, (_, value) => color(value, ansi.bold));
      line = line.replace(/(^|[^\w])\*([^*\n]+)\*/g, "$1$2");
      line = line.replace(/(^|[^\w])_([^_\n]+)_/g, "$1$2");
      line = line.replace(/`([^`]+)`/g, (_, value) => color(value, ansi.yellow));
      line = line.replace(/^(\s*)[-*+]\s+/, "$1- ");
      line = line.replace(/^\s*>\s?(.+)$/, (_, value) => color(`| ${value}`, ansi.dim));
    } else {
      line = color(`  ${line}`, ansi.yellow);
    }

    rendered.push(line);
  }

  return rendered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function rolePrefix(name, bgCode) {
  return `${label(name, bgCode)} ${color("|", bgCode)} `;
}

function printWrapped(prefix, text, { stripCode = "" } = {}) {
  const rendered = stripMarkdown(text);
  const lines = rendered.split("\n");
  const visible = stripAnsi(prefix).length;
  const gutter = `${" ".repeat(Math.max(visible - 2, 0))}${stripCode ? color("|", stripCode) : "|"} `;
  console.log(`${prefix}${lines[0] || ""}`);
  for (const line of lines.slice(1)) {
    console.log(`${gutter}${line}`);
  }
}

function printAgentMessage(text) {
  printWrapped(rolePrefix("aginti>", ansi.agentBg), text, { stripCode: ansi.agentBg });
}

function printSystemLine(text) {
  if (!String(text || "").trim()) {
    console.log("");
    return;
  }
  console.log(`${label("state", ansi.systemBg)} ${color(text, ansi.dim)}`);
}

function printHeading(text) {
  console.log(color(stripMarkdown(text), ansi.bold, ansi.cyan));
}

function shimmerText(text, frame) {
  if (!useColor) return text;
  return [...text]
    .map((char, index) => {
      if (char === " ") return char;
      const code = brandPalette[(index + frame) % brandPalette.length];
      return `${code}${ansi.bold}${char}${ansi.reset}`;
    })
    .join("");
}

async function renderLaunchHeader(packageVersion = "") {
  const title = "AgInTi Flow";
  const subtitle = "web-first agent workspace";
  const version = packageVersion ? `v${packageVersion}` : "";
  const line = "+--------------------------------------------------+";

  if (!useColor || process.env.AGINTIFLOW_NO_ANIMATION === "1") {
    console.log(` AgInTiFlow ${packageVersion || ""}`.trim());
    return;
  }

  output.write(ansi.cursorHide);
  for (let frame = 0; frame < 18; frame += 1) {
    output.write(`\r${ansi.clearLine}${shimmerText(title, frame)} ${color("is starting", ansi.dim)}`);
    await sleep(32);
  }
  output.write(`\r${ansi.clearLine}`);
  output.write(ansi.cursorShow);

  console.log(color(line, "\x1b[38;5;45m"));
  console.log(`${color("|", "\x1b[38;5;45m")} ${shimmerText(title, 2)} ${color(version.padStart(36 - title.length), ansi.dim)} ${color("|", "\x1b[38;5;45m")}`);
  console.log(`${color("|", "\x1b[38;5;45m")} ${color(subtitle.padEnd(48), ansi.dim)} ${color("|", "\x1b[38;5;45m")}`);
  console.log(`${color("|", "\x1b[38;5;45m")} ${color("browser + shell + files + docker + canvas".padEnd(48), ansi.cyan)} ${color("|", "\x1b[38;5;45m")}`);
  console.log(color(line, "\x1b[38;5;45m"));
}

function printHelp() {
  printAgentMessage(
    [
      "Commands:",
      "  /help                     Show this help.",
      "  /status                   Show active route, workspace, sandbox, and session.",
      "  /login [deepseek|openai|grsai]  Paste and save a project-local API key.",
      "  /auth [deepseek|openai|grsai]   Alias for /login.",
      "  /auxilliary [status|grsai|on|off|image]",
      "                            Manage optional auxiliary skills, including GRS AI image generation.",
      "  /new                      Start a fresh session on the next message.",
      "  /resume <session-id>      Continue a saved session.",
      "  /sessions                 List recent sessions in this project.",
      "  /profile <name>           Set task profile, e.g. code, website, latex, maintenance.",
      "  /routing <mode>           Set routing: smart, fast, complex, manual.",
      "  /provider <name>          Set provider: deepseek, openai, mock.",
      "  /model <name>             Set an explicit model, or /model auto.",
      "  /docker on                Use docker-workspace with approved package installs.",
      "  /docker off               Use host shell policy.",
      "  /latex on                 Use the LaTeX/PDF profile in Docker with a larger step budget.",
      "  /installs block|prompt|allow",
      "  /cwd <path>               Change command workspace.",
      "  /exit                     Quit.",
      "",
      "Type a normal request to run the agent. Example: write a Python CLI app with tests",
      "Type / then Tab to autocomplete commands.",
      "While a run is active, press Esc or Ctrl+C once to stop gracefully and print a resume command.",
    ].join("\n")
  );
}

function renderPromptBuffer(buffer, previousLineCount = 0) {
  for (let index = 0; index < previousLineCount; index += 1) {
    output.write(`\r${ansi.clearLine}`);
    if (index < previousLineCount - 1) output.write("\x1b[1A");
  }

  const lines = String(buffer || "").split("\n");
  const suggestions = commandSuggestions(lines[0] || "");
  const rendered = [];
  rendered.push(`${userPrompt().replace(/^\n/, "")}${lines[0] || ""}`);
  for (const line of lines.slice(1)) {
    rendered.push(`${promptGutter()}${line}`);
  }
  if (suggestions.length > 0) {
    rendered.push(`${promptGutter()}${color(`suggest: ${suggestions.join("  ")}`, ansi.dim)}`);
  }
  output.write(rendered.join("\n"));
  return rendered.length;
}

function createAbortError(message = "Aborted with Ctrl+C") {
  const error = new Error(message);
  error.code = "ABORT_ERR";
  error.name = "AbortError";
  return error;
}

function readTtyPrompt() {
  return new Promise((resolve, reject) => {
    emitKeypressEvents(input);
    const wasRaw = Boolean(input.isRaw);
    let buffer = "";
    let renderedLines = 0;

    const cleanup = () => {
      input.off("keypress", handler);
      if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
      input.pause();
      output.write(ansi.cursorShow);
    };

    const redraw = () => {
      renderedLines = renderPromptBuffer(buffer, renderedLines);
    };

    const submit = () => {
      cleanup();
      output.write("\n");
      resolve(buffer);
    };

    const handler = (str = "", key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        reject(createAbortError());
        return;
      }
      if ((key.ctrl && key.name === "j") || (key.sequence === "\n" && key.name !== "return" && key.name !== "enter")) {
        buffer += "\n";
        redraw();
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.sequence === "\r" || str === "\r") {
        submit();
        return;
      }
      if (key.name === "backspace") {
        buffer = buffer.slice(0, -1);
        redraw();
        return;
      }
      if (key.name === "tab") {
        const suggestions = commandSuggestions(buffer.split("\n")[0] || "");
        if (suggestions.length === 1) {
          buffer = suggestions[0];
        }
        redraw();
        return;
      }
      if (key.name === "escape") {
        buffer = "";
        redraw();
        return;
      }
      if (key.ctrl || key.meta) return;
      if (str && !key.sequence?.startsWith("\x1b")) {
        buffer += str;
        redraw();
      }
    };

    input.resume();
    input.setRawMode(true);
    output.write(ansi.cursorHide);
    input.on("keypress", handler);
    redraw();
  });
}

async function readPromptAnswer(rl) {
  if (input.isTTY && output.isTTY && typeof input.setRawMode === "function") {
    return readTtyPrompt();
  }
  return rl.question(userPrompt());
}

function printStatus(state) {
  printSystemLine(`project=${process.cwd()}`);
  printSystemLine(`cwd=${state.commandCwd || process.cwd()}`);
  printSystemLine(`session=${state.sessionId || "new"}`);
  printSystemLine(`status=${state.status || "idle"}${state.activeGoal ? ` workingOn=${state.activeGoal}` : ""}`);
  if (state.lastEvent) printSystemLine(`last=${state.lastEvent}`);
  printSystemLine(`provider=${state.provider || "auto"} routing=${state.routingMode} model=${state.model || "auto"}`);
  printSystemLine(`profile=${state.taskProfile} maxSteps=${state.maxSteps}`);
  printSystemLine(
    `shell=${state.allowShellTool} files=${state.allowFileTools} auxiliary=${state.allowAuxiliaryTools} sandbox=${state.sandboxMode} installs=${state.packageInstallPolicy}`
  );
  if (state.sandboxMode !== "host") {
    printSystemLine(`dockerWorkspace=/workspace -> ${state.commandCwd || process.cwd()}`);
  }
}

function isAbortError(error) {
  return error?.code === "ABORT_ERR" || error?.name === "AbortError";
}

function formatSessionLine(session) {
  const goal = session.goal ? ` ${session.goal.slice(0, 72)}` : "";
  return `${session.sessionId} ${session.provider || "unknown"}/${session.model || "unknown"} ${session.updatedAt || ""}${goal}`.trim();
}

async function latestSession() {
  const sessions = await listProjectSessions(process.cwd(), 1);
  return sessions[0] || null;
}

function printStatusEvent(state, label, details = "") {
  state.lastEvent = details ? `${label}: ${details}` : label;
  printSystemLine(`status=${state.status || "running"} ${state.lastEvent}`);
}

function attachRunInterrupts(controller) {
  if (!input.isTTY || typeof input.setRawMode !== "function") return () => {};

  emitKeypressEvents(input);
  const wasRaw = Boolean(input.isRaw);
  input.resume();
  input.setRawMode(true);
  const handler = (_str, key = {}) => {
    const isEscape = key.name === "escape";
    const isCtrlC = key.ctrl && key.name === "c";
    if (!isEscape && !isCtrlC) return;
    if (controller.signal.aborted) return;
    const reason = isEscape ? "escape" : "ctrl-c";
    printSystemLine(`status=stopping reason=${reason}`);
    controller.abort(new Error(`Interrupted by ${reason}.`));
  };
  input.on("keypress", handler);
  return () => {
    input.off("keypress", handler);
    if (typeof input.setRawMode === "function") {
      input.setRawMode(wasRaw);
    }
  };
}

async function printResumeHint(state) {
  const sessionId = state.sessionId || "";
  console.log("");
  if (sessionId) {
    printAgentMessage(["Interrupted. Session saved.", `Resume: aginti resume ${sessionId}`, `One-shot: aginti resume ${sessionId} "continue"`].join("\n"));
  } else {
    printAgentMessage("Interrupted. No active session yet.");
    const sessions = await listProjectSessions(process.cwd(), 5).catch(() => []);
    if (sessions.length > 0) {
      printAgentMessage(
        [
          "Recent sessions:",
          ...sessions.map((session) => `  ${formatSessionLine(session)}`),
          `Resume latest: aginti resume ${sessions[0].sessionId}`,
          "List all: aginti sessions list",
        ].join("\n")
      );
    } else {
      printAgentMessage("Restart: aginti");
    }
  }
}

function createState(args = {}) {
  return {
    provider: args.provider || "",
    model: args.model || "",
    routingMode: args.routingMode || "smart",
    commandCwd: args.commandCwd || process.cwd(),
    sandboxMode: normalizeSandboxMode(args.sandboxMode || "docker-workspace"),
    packageInstallPolicy: normalizePackageInstallPolicy(args.packageInstallPolicy || "allow"),
    allowShellTool: args.allowShellTool ?? true,
    allowFileTools: args.allowFileTools ?? true,
    allowAuxiliaryTools: args.allowAuxiliaryTools ?? true,
    allowWrapperTools: args.allowWrapperTools ?? false,
    allowDestructive: args.allowDestructive ?? false,
    preferredWrapper: args.preferredWrapper || "codex",
    taskProfile: normalizeTaskProfile(args.taskProfile || "auto"),
    headless: args.headless ?? false,
    maxSteps:
      Number.isFinite(args.maxSteps) && args.maxSteps > 0
        ? args.maxSteps
        : defaultMaxStepsForProfile(args.taskProfile || (args.latex ? "latex" : "auto")),
    sessionId: args.resume || "",
  };
}

async function maybeOnboardDeepSeekKey(state) {
  if (!shouldPromptForDeepSeek(state, process.cwd())) return;

  printAgentMessage(
    [
      "DeepSeek API key is not configured for this project.",
      "Paste it once to save it in `.aginti/.env` with 0600 permissions, or press Enter to continue in mock mode.",
    ].join("\n")
  );
  const result = await promptAndSaveDeepSeekKey(process.cwd(), {
    promptText: "DeepSeek API key: ",
  });
  if (result.saved) {
    printAgentMessage(`Saved ${result.keyName} to project-local ignored env.`);
    return;
  }

  state.provider = "mock";
  state.routingMode = "manual";
  state.model = "mock-agent";
  printAgentMessage("No key saved. Continuing in local mock mode. Use `/provider deepseek` after running `aginti login deepseek`.");
}

async function promptAndSaveProviderKey(provider = "deepseek", state = null) {
  const aliases = { auxiliary: "grsai", auxilliary: "grsai", image: "grsai", imagegen: "grsai" };
  const candidate = aliases[String(provider || "").toLowerCase()] || String(provider || "").toLowerCase();
  const normalized = ["openai", "deepseek", "grsai"].includes(candidate)
    ? String(provider || "").toLowerCase()
    : "deepseek";
  const canonical = aliases[normalized] || normalized;
  const labelText = canonical === "openai" ? "OpenAI" : canonical === "grsai" ? "GRSAI" : "DeepSeek";
  const key = await promptHidden(`${labelText} API key/token (paste, Enter to save): `);
  if (!key) {
    printAgentMessage("No key saved.");
    return;
  }

  const result = await setProviderKey(process.cwd(), canonical, key);
  if (state) {
    if (canonical !== "grsai") state.provider = canonical;
    if (state.routingMode === "manual" && state.model === "mock-agent") {
      state.routingMode = "smart";
      state.model = "";
    }
    if (canonical === "grsai") state.allowAuxiliaryTools = true;
  }
  printAgentMessage(`Saved ${result.keyName} to project-local ignored env. Raw key was not printed.`);
}

async function handleCommand(line, state, packageDir) {
  const [command, ...rest] = line.slice(1).trim().split(/\s+/);
  const value = rest.join(" ").trim();

  if (!command || command === "help" || command === "?") {
    printHelp();
    return true;
  }
  if (command === "exit" || command === "quit" || command === "q") return false;
  if (command === "status") {
    printStatus(state);
    const keys = providerKeyStatus(process.cwd());
    printSystemLine(
      `keys deepseek=${keys.deepseek ? "available" : "missing"} openai=${keys.openai ? "available" : "missing"} grsai=${
        keys.grsai ? "available" : "missing"
      }`
    );
    return true;
  }
  if (command === "login" || command === "auth") {
    await promptAndSaveProviderKey(value || "deepseek", state);
    return true;
  }
  if (command === "auxilliary" || command === "auxiliary") {
    const action = value || "status";
    if (action === "status") {
      const keys = providerKeyStatus(process.cwd());
      printAgentMessage(
        [
          `Auxiliary tools: ${state.allowAuxiliaryTools ? "on" : "off"}`,
          `Image generation: ${keys.grsai ? "GRSAI key available" : "missing GRSAI key"}`,
          "Use `/auxilliary grsai` to paste the image key, `/auxilliary image` to switch to the image profile, or `/auxilliary off` to hide auxiliary tools.",
        ].join("\n")
      );
      return true;
    }
    if (action === "on") {
      state.allowAuxiliaryTools = true;
      printSystemLine("auxiliary=on");
      return true;
    }
    if (action === "off") {
      state.allowAuxiliaryTools = false;
      printSystemLine("auxiliary=off");
      return true;
    }
    if (action === "image") {
      state.allowAuxiliaryTools = true;
      state.taskProfile = "image";
      printSystemLine("auxiliary=on profile=image");
      return true;
    }
    if (["grsai", "login", "key", "token"].includes(action)) {
      await promptAndSaveProviderKey("grsai", state);
      return true;
    }
    printAgentMessage("Usage: /auxilliary [status|grsai|on|off|image]");
    return true;
  }
  if (command === "new") {
    state.sessionId = "";
    printAgentMessage("Next message will start a new session.");
    return true;
  }
  if (command === "resume") {
    if (!value || value === "latest") {
      const latest = await latestSession();
      if (!latest) {
        printAgentMessage("No project-local sessions found. Use /new or type a request to start one.");
      } else {
        state.sessionId = latest.sessionId;
        printAgentMessage(`Resuming latest ${formatSessionLine(latest)}`);
      }
    } else {
      state.sessionId = value;
      printAgentMessage(`Resuming ${state.sessionId}`);
    }
    return true;
  }
  if (command === "sessions") {
    const sessions = await listProjectSessions(process.cwd(), 20);
    if (sessions.length === 0) printAgentMessage("No project-local sessions found.");
    else {
      printAgentMessage(
        sessions
          .map((session) => {
            const goal = session.goal ? ` ${session.goal.slice(0, 80)}` : "";
            return `${session.sessionId} ${session.provider}/${session.model} ${session.updatedAt}${goal}`;
          })
          .join("\n")
      );
    }
    return true;
  }
  if (command === "profile") {
    state.taskProfile = normalizeTaskProfile(value || "auto");
    state.maxSteps = Math.max(state.maxSteps, defaultMaxStepsForProfile(state.taskProfile));
    printSystemLine(`profile=${state.taskProfile}`);
    return true;
  }
  if (command === "routing") {
    state.routingMode = value || "smart";
    printSystemLine(`routing=${state.routingMode}`);
    return true;
  }
  if (command === "provider") {
    state.provider = value === "auto" ? "" : value;
    printSystemLine(`provider=${state.provider || "auto"}`);
    return true;
  }
  if (command === "model") {
    state.model = value === "auto" ? "" : value;
    printSystemLine(`model=${state.model || "auto"}`);
    return true;
  }
  if (command === "installs") {
    state.packageInstallPolicy = normalizePackageInstallPolicy(value || "prompt");
    printSystemLine(`installs=${state.packageInstallPolicy}`);
    return true;
  }
  if (command === "docker") {
    if (value === "on") {
      state.sandboxMode = "docker-workspace";
      state.packageInstallPolicy = "allow";
      printSystemLine(`docker=on /workspace -> ${state.commandCwd || process.cwd()} installs=allow`);
    } else if (value === "off") {
      state.sandboxMode = "host";
      state.packageInstallPolicy = "prompt";
      printSystemLine("docker=off sandbox=host installs=prompt");
    } else {
      printAgentMessage("Usage: /docker on OR /docker off");
    }
    return true;
  }
  if (command === "latex") {
    if (value === "on" || value === "") {
      state.taskProfile = "latex";
      state.sandboxMode = "docker-workspace";
      state.packageInstallPolicy = "allow";
      state.maxSteps = Math.max(state.maxSteps, 30);
      printSystemLine("latex=on profile=latex sandbox=docker-workspace installs=allow maxSteps=30");
    } else if (value === "off") {
      state.taskProfile = "auto";
      printSystemLine("latex=off profile=auto");
    } else {
      printAgentMessage("Usage: /latex on OR /latex off");
    }
    return true;
  }
  if (command === "cwd") {
    state.commandCwd = value || process.cwd();
    printSystemLine(`cwd=${state.commandCwd}`);
    return true;
  }
  if (command === "init") {
    const result = await initProject(process.cwd());
    printAgentMessage(`initialized project=${result.projectRoot}`);
    return true;
  }
  if (command === "web") {
    const port = value || "3220";
    printAgentMessage(`Run in another terminal: aginti web --port ${port}`);
    return true;
  }

  const typed = `/${command}`;
  const suggestions = SLASH_COMMANDS.filter((candidate) => candidate.startsWith(typed));
  printAgentMessage(
    suggestions.length > 0
      ? `Unknown command: /${command}. Did you mean:\n${suggestions.map((item) => `  ${item}`).join("\n")}`
      : `Unknown command: /${command}. Use /help.`
  );
  return true;
}

async function runPrompt(prompt, state, packageDir) {
  const controller = new AbortController();
  const config = loadConfig(
    {
      provider: state.provider,
      model: state.model,
      routingMode: state.routingMode,
      commandCwd: state.commandCwd,
      sandboxMode: state.sandboxMode,
      packageInstallPolicy: state.packageInstallPolicy,
      allowShellTool: state.allowShellTool,
      allowFileTools: state.allowFileTools,
      allowAuxiliaryTools: state.allowAuxiliaryTools,
      allowWrapperTools: state.allowWrapperTools,
      allowDestructive: state.allowDestructive,
      preferredWrapper: state.preferredWrapper,
      taskProfile: state.taskProfile,
      maxSteps: state.maxSteps,
      headless: state.headless,
      resume: state.sessionId,
      goal: prompt,
    },
    { packageDir, baseDir: process.cwd() }
  );

  state.sessionId = config.resume || config.sessionId || state.sessionId;
  state.status = "running";
  state.activeGoal = prompt.replace(/\s+/g, " ").slice(0, 120);
  state.lastEvent = "";
  printSystemLine(`session=${state.sessionId}`);
  printSystemLine(`status=running workingOn=${state.activeGoal}`);

  const detachInterrupts = attachRunInterrupts(controller);
  let result;
  try {
    result = await runAgent({
      ...config,
      abortSignal: controller.signal,
      onConsole: (text, options = {}) => {
        if (options.kind === "assistant") {
          printAgentMessage(text);
        } else if (options.kind === "plan") {
          printWrapped(`${label("plan", ansi.systemBg)} `, text);
        } else if (options.kind === "heading") {
          printHeading(text);
        } else if (options.error) {
          console.error(`${label("error", ansi.systemBg)} ${stripMarkdown(text)}`);
        } else {
          printSystemLine(text);
        }
      },
      onEvent: (type, data = {}) => {
        if (type === "plan.created") {
          printStatusEvent(state, "planned");
        } else if (type === "tool.started") {
          printStatusEvent(state, "tool", data.toolName || "unknown");
        } else if (type === "tool.completed") {
          printStatusEvent(state, "tool_done", data.toolName || "unknown");
        } else if (type === "tool.blocked") {
          printStatusEvent(state, "tool_blocked", data.toolName || data.reason || "unknown");
        } else if (type === "loop.guard") {
          printStatusEvent(state, "loop_guard", data.toolName || "");
        } else if (type === "conversation.queued_input_applied") {
          printStatusEvent(state, "queued_input_applied");
        } else if (type === "session.finished") {
          printStatusEvent(state, "finished");
        } else if (type === "session.stopped") {
          printStatusEvent(state, "stopped", data.reason || "");
        } else if (type === "model.responded") {
          printStatusEvent(state, "model_responded", data.content ? data.content.slice(0, 80).replace(/\s+/g, " ") : "");
        }
      },
    });
  } finally {
    detachInterrupts();
  }
  state.sessionId = result.sessionId || state.sessionId;
  state.status = result.stopped ? "stopped" : "idle";
  state.activeGoal = "";
  printSystemLine(`status=${state.status} session=${state.sessionId}`);
  if (result.stopped && result.reason === "user_interrupt") {
    await printResumeHint(state);
  }
}

export async function startInteractiveCli(args = {}, { packageDir, packageVersion } = {}) {
  const state = createState(args);
  const rl =
    input.isTTY && output.isTTY
      ? null
      : readline.createInterface({
          input,
          output,
          terminal: false,
          completer: commandCompleter,
        });

  await renderLaunchHeader(packageVersion);
  printSystemLine(`Project: ${process.cwd()}`);
  await maybeOnboardDeepSeekKey(state);
  printAgentMessage("Interactive agent chat. Type /help for commands, /exit to quit.");
  printStatus(state);

  try {
    while (true) {
      let answer = "";
      try {
        answer = await readPromptAnswer(rl);
      } catch (error) {
        if (error?.code === "ERR_USE_AFTER_CLOSE") break;
        if (isAbortError(error)) {
          await printResumeHint(state);
          break;
        }
        throw error;
      }
      const line = answer.trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const keepGoing = await handleCommand(line, state, packageDir);
        if (!keepGoing) break;
        continue;
      }

      try {
        await runPrompt(line, state, packageDir);
      } catch (error) {
        if (isAbortError(error)) {
          await printResumeHint(state);
          break;
        }
        console.error(`${label("error", ansi.systemBg)} ${error.message}`);
      }
    }
  } finally {
    rl?.close();
  }
}
