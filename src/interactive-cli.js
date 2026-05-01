import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runAgent } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import { initProject, listProjectSessions } from "./project.js";
import { normalizePackageInstallPolicy, normalizeSandboxMode } from "./command-policy.js";
import { normalizeTaskProfile } from "./task-profiles.js";

function printHelp() {
  console.log(
    [
      "Commands:",
      "  /help                     Show this help.",
      "  /status                   Show active route, workspace, sandbox, and session.",
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
    ].join("\n")
  );
}

function printStatus(state) {
  console.log(`project=${process.cwd()}`);
  console.log(`cwd=${state.commandCwd || process.cwd()}`);
  console.log(`session=${state.sessionId || "new"}`);
  console.log(`provider=${state.provider || "auto"} routing=${state.routingMode} model=${state.model || "auto"}`);
  console.log(`profile=${state.taskProfile} maxSteps=${state.maxSteps}`);
  console.log(
    `shell=${state.allowShellTool} files=${state.allowFileTools} sandbox=${state.sandboxMode} installs=${state.packageInstallPolicy}`
  );
  if (state.sandboxMode !== "host") {
    console.log(`dockerWorkspace=/workspace -> ${state.commandCwd || process.cwd()}`);
  }
}

function isAbortError(error) {
  return error?.code === "ABORT_ERR" || error?.name === "AbortError";
}

function printResumeHint(state) {
  const sessionId = state.sessionId || "";
  console.log("");
  if (sessionId) {
    console.log("Interrupted. Session saved.");
    console.log(`Resume: aginti resume ${sessionId}`);
    console.log(`One-shot: aginti resume ${sessionId} "continue"`);
  } else {
    console.log("Interrupted. No active session yet.");
    console.log("Restart: aginti");
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
    allowWrapperTools: args.allowWrapperTools ?? false,
    allowDestructive: args.allowDestructive ?? false,
    preferredWrapper: args.preferredWrapper || "codex",
    taskProfile: normalizeTaskProfile(args.taskProfile || "auto"),
    headless: args.headless ?? false,
    maxSteps: Number.isFinite(args.maxSteps) && args.maxSteps > 0 ? args.maxSteps : args.latex ? 30 : 24,
    sessionId: args.resume || "",
  };
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
    return true;
  }
  if (command === "new") {
    state.sessionId = "";
    console.log("Next message will start a new session.");
    return true;
  }
  if (command === "resume") {
    if (!value) console.log("Usage: /resume <session-id>");
    else {
      state.sessionId = value;
      console.log(`Resuming ${state.sessionId}`);
    }
    return true;
  }
  if (command === "sessions") {
    const sessions = await listProjectSessions(process.cwd(), 20);
    if (sessions.length === 0) console.log("No project-local sessions found.");
    else {
      for (const session of sessions) {
        const goal = session.goal ? ` ${session.goal.slice(0, 80)}` : "";
        console.log(`${session.sessionId} ${session.provider}/${session.model} ${session.updatedAt}${goal}`);
      }
    }
    return true;
  }
  if (command === "profile") {
    state.taskProfile = normalizeTaskProfile(value || "auto");
    console.log(`profile=${state.taskProfile}`);
    return true;
  }
  if (command === "routing") {
    state.routingMode = value || "smart";
    console.log(`routing=${state.routingMode}`);
    return true;
  }
  if (command === "provider") {
    state.provider = value === "auto" ? "" : value;
    console.log(`provider=${state.provider || "auto"}`);
    return true;
  }
  if (command === "model") {
    state.model = value === "auto" ? "" : value;
    console.log(`model=${state.model || "auto"}`);
    return true;
  }
  if (command === "installs") {
    state.packageInstallPolicy = normalizePackageInstallPolicy(value || "prompt");
    console.log(`installs=${state.packageInstallPolicy}`);
    return true;
  }
  if (command === "docker") {
    if (value === "on") {
      state.sandboxMode = "docker-workspace";
      state.packageInstallPolicy = "allow";
      console.log(`docker=on /workspace -> ${state.commandCwd || process.cwd()} installs=allow`);
    } else if (value === "off") {
      state.sandboxMode = "host";
      state.packageInstallPolicy = "prompt";
      console.log("docker=off sandbox=host installs=prompt");
    } else {
      console.log("Usage: /docker on OR /docker off");
    }
    return true;
  }
  if (command === "latex") {
    if (value === "on" || value === "") {
      state.taskProfile = "latex";
      state.sandboxMode = "docker-workspace";
      state.packageInstallPolicy = "allow";
      state.maxSteps = Math.max(state.maxSteps, 30);
      console.log("latex=on profile=latex sandbox=docker-workspace installs=allow maxSteps=30");
    } else if (value === "off") {
      state.taskProfile = "auto";
      console.log("latex=off profile=auto");
    } else {
      console.log("Usage: /latex on OR /latex off");
    }
    return true;
  }
  if (command === "cwd") {
    state.commandCwd = value || process.cwd();
    console.log(`cwd=${state.commandCwd}`);
    return true;
  }
  if (command === "init") {
    const result = await initProject(process.cwd());
    console.log(`initialized project=${result.projectRoot}`);
    return true;
  }
  if (command === "web") {
    const port = value || "3220";
    console.log(`Run in another terminal: aginti web --port ${port}`);
    return true;
  }

  console.log(`Unknown command: /${command}. Use /help.`);
  return true;
}

async function runPrompt(prompt, state, packageDir) {
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

  const result = await runAgent(config);
  state.sessionId = result.sessionId || state.sessionId;
}

export async function startInteractiveCli(args = {}, { packageDir, packageVersion } = {}) {
  const state = createState(args);
  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });

  console.log(`AgInTiFlow ${packageVersion || ""}`.trim());
  console.log(`Project: ${process.cwd()}`);
  console.log("Interactive agent chat. Type /help for commands, /exit to quit.");
  printStatus(state);

  try {
    while (true) {
      let answer = "";
      try {
        answer = await rl.question("\naginti> ");
      } catch (error) {
        if (error?.code === "ERR_USE_AFTER_CLOSE") break;
        if (isAbortError(error)) {
          printResumeHint(state);
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
          printResumeHint(state);
          break;
        }
        console.error(`error: ${error.message}`);
      }
    }
  } finally {
    rl.close();
  }
}
