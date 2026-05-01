import { runAgent } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import { listAgentWrappers } from "./tool-wrappers.js";
import { getModelPresets } from "./model-routing.js";
import { getDockerSandboxStatus, runDockerPreflight } from "./docker-sandbox.js";
import { buildCapabilityReport, printCapabilityReport } from "./capabilities.js";
import { startInteractiveCli } from "./interactive-cli.js";
import { SessionStore } from "./session-store.js";
import {
  doctorReport,
  initProject,
  listProjectSessions,
  providerKeyStatus,
  setProviderKey,
  showProjectSession,
} from "./project.js";
import { listTaskProfiles } from "./task-profiles.js";
import { promptAndSaveDeepSeekKey, promptHidden, shouldPromptForDeepSeek } from "./auth-onboarding.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));

function readOption(argv, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

export function parseArgs(argv) {
  const result = {
    goal: "",
    startUrl: "",
    resume: "",
    sessionId: "",
    provider: "",
    model: "",
    routingMode: "",
    commandCwd: "",
    sandboxMode: "",
    packageInstallPolicy: "",
    allowShellTool: undefined,
    allowFileTools: undefined,
    allowWrapperTools: undefined,
    allowDestructive: undefined,
    preferredWrapper: "",
    taskProfile: "",
    useDockerSandbox: undefined,
    headless: undefined,
    maxSteps: undefined,
    listRoutes: false,
    listWrappers: false,
    sandboxStatus: false,
    sandboxPreflight: false,
    web: false,
    interactive: false,
    port: "",
    host: "",
    listProfiles: false,
    latex: false,
  };

  const parts = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "web" || arg === "--web") {
      result.web = true;
      continue;
    }
    if (arg === "chat" || arg === "interactive" || arg === "--chat" || arg === "--interactive") {
      result.interactive = true;
      continue;
    }
    if (arg === "--port") {
      result.port = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--host") {
      result.host = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--start-url") {
      result.startUrl = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--resume") {
      result.resume = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--session-id") {
      result.sessionId = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--provider") {
      result.provider = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--model") {
      result.model = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--routing") {
      result.routingMode = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--cwd") {
      result.commandCwd = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--sandbox-mode") {
      result.sandboxMode = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--package-install-policy") {
      result.packageInstallPolicy = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--approve-package-installs") {
      result.packageInstallPolicy = "allow";
      result.sandboxMode = result.sandboxMode || "docker-workspace";
      continue;
    }
    if (arg === "--latex") {
      result.latex = true;
      result.taskProfile = "latex";
      result.sandboxMode = result.sandboxMode || "docker-workspace";
      result.packageInstallPolicy = result.packageInstallPolicy || "allow";
      result.maxSteps = result.maxSteps || 30;
      continue;
    }
    if (arg === "--max-steps") {
      result.maxSteps = Number(readOption(argv, i));
      i += 1;
      continue;
    }
    if (arg === "--allow-shell") {
      result.allowShellTool = true;
      continue;
    }
    if (arg === "--no-shell") {
      result.allowShellTool = false;
      continue;
    }
    if (arg === "--allow-destructive" || arg === "--trusted-host-shell") {
      result.allowDestructive = true;
      continue;
    }
    if (arg === "--allow-file-tools") {
      result.allowFileTools = true;
      continue;
    }
    if (arg === "--no-file-tools") {
      result.allowFileTools = false;
      continue;
    }
    if (arg === "--allow-wrappers") {
      result.allowWrapperTools = true;
      continue;
    }
    if (arg === "--wrapper" || arg === "--preferred-wrapper") {
      result.preferredWrapper = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--profile" || arg === "--task-profile") {
      result.taskProfile = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--docker-sandbox") {
      result.useDockerSandbox = true;
      result.sandboxMode = result.sandboxMode || "docker-readonly";
      continue;
    }
    if (arg === "--headless") {
      result.headless = true;
      continue;
    }
    if (arg === "--list-routes") {
      result.listRoutes = true;
      continue;
    }
    if (arg === "--list-wrappers") {
      result.listWrappers = true;
      continue;
    }
    if (arg === "--list-profiles") {
      result.listProfiles = true;
      continue;
    }
    if (arg === "--sandbox-status") {
      result.sandboxStatus = true;
      continue;
    }
    if (arg === "--sandbox-preflight") {
      result.sandboxPreflight = true;
      result.useDockerSandbox = true;
      result.sandboxMode = result.sandboxMode || "docker-readonly";
      continue;
    }
    parts.push(arg);
  }

  result.goal = parts.join(" ").trim();
  return result;
}

function printUsage() {
  console.log(
    'Usage: aginti [chat] OR aginti web [--port 3210] OR aginti login deepseek OR aginti resume [latest|<session-id>] ["prompt"] OR aginti queue <session-id> "message" OR aginti [--latex] [--routing smart|fast|complex|manual] [--provider deepseek|openai|mock] [--sandbox-mode host|docker-readonly|docker-workspace] [--package-install-policy block|prompt|allow] [--approve-package-installs] [--allow-shell|--no-shell] [--allow-destructive] [--allow-file-tools|--no-file-tools] [--allow-wrappers --wrapper codex] [--sandbox-status|--sandbox-preflight] "your task"'
  );
}

function agentDefaults(args) {
  const defaults = {
    ...args,
    allowShellTool: args.allowShellTool ?? true,
    allowFileTools: args.allowFileTools ?? true,
    sandboxMode: args.sandboxMode || "docker-workspace",
    packageInstallPolicy: args.packageInstallPolicy || "allow",
    useDockerSandbox: args.useDockerSandbox ?? true,
    maxSteps: args.maxSteps || (args.latex || args.taskProfile === "latex" ? 30 : 24),
  };

  if (defaults.sandboxMode === "host") {
    defaults.useDockerSandbox = false;
    defaults.packageInstallPolicy = args.packageInstallPolicy || "prompt";
  }

  return defaults;
}

function printRoutes() {
  const presets = getModelPresets();
  for (const preset of Object.values(presets)) {
    const reasoning = preset.reasoning ? ` reasoning=${preset.reasoning}` : "";
    console.log(`${preset.id}: provider=${preset.provider} model=${preset.model}${reasoning} - ${preset.description}`);
  }
}

function printWrappers() {
  for (const wrapper of listAgentWrappers()) {
    console.log(`${wrapper.name}: ${wrapper.available ? "available" : "missing"} - ${wrapper.role}`);
  }
}

function printProfiles() {
  for (const profile of listTaskProfiles()) {
    console.log(`${profile.id}: ${profile.label} - ${profile.prompt}`);
  }
}

function printInitResult(result) {
  console.log(`AgInTiFlow project initialized: ${result.projectRoot}`);
  console.log(`control=${result.controlDir}`);
  console.log(`sessions=${result.sessionsDir}`);
  console.log(`created=${result.created.length} updated=${result.updated.length} skipped=${result.skipped.length}`);
}

function printDoctorReport(report) {
  console.log(`AgInTiFlow ${report.package.version} (npm latest: ${report.package.npmLatest})`);
  console.log(`node=${report.node.version} ok=${report.node.ok}`);
  console.log(`project=${report.project.root}`);
  console.log(`sessions=${report.project.sessionsDir}`);
  console.log(`sessionDb=${report.project.sessionDbPath}`);
  console.log(
    `keys: deepseek=${report.keys.deepseek ? "available" : "missing"} openai=${
      report.keys.openai ? "available" : "missing"
    } mock=available localEnv=${report.project.localEnvPresent}`
  );
  console.log(
    `sandbox=${report.sandbox?.sandboxMode || "unknown"} docker=${
      report.sandbox?.dockerAvailable ? "available" : "missing"
    } imageReady=${Boolean(report.sandbox?.imageReady)}`
  );
  console.log(
    `wrappers=${report.wrappers.map((wrapper) => `${wrapper.name}:${wrapper.available ? "ok" : "missing"}`).join(" ")}`
  );
  console.log(`sessions=${report.sessions.length}`);
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input.trim();
}

async function ensureDeepSeekKeyForOneShot(args) {
  if (!shouldPromptForDeepSeek(args, process.cwd())) return true;
  console.log("DeepSeek API key is not configured for this project.");
  console.log("Paste it once to save it in `.aginti/.env` with 0600 permissions, or press Enter to cancel.");
  const result = await promptAndSaveDeepSeekKey(process.cwd(), {
    promptText: "DeepSeek API key: ",
  });
  if (result.saved) {
    console.log(`saved ${result.keyName} to project-local ignored env`);
    return true;
  }
  console.error("No DeepSeek key saved. Run `aginti login deepseek` later, or use `--provider mock` for local tests.");
  return false;
}

async function handleKeyCommand(argv) {
  const [verb = "status", provider = ""] = argv;
  if (verb === "status") {
    const status = providerKeyStatus(process.cwd());
    console.log(
      `keys: deepseek=${status.deepseek ? "available" : "missing"} openai=${
        status.openai ? "available" : "missing"
      } mock=available localEnv=${status.localEnv}`
    );
    console.log("env vars: DeepSeek=DEEPSEEK_API_KEY or LLM_API_KEY; OpenAI=OPENAI_API_KEY or LLM_API_KEY");
    return;
  }

  if (verb === "set") {
    const target = provider || "deepseek";
    const key = argv.includes("--stdin") ? await readStdin() : await promptHidden(`${target === "openai" ? "OpenAI" : "DeepSeek"} API key: `);
    if (!key) {
      console.error("No key saved.");
      process.exit(1);
    }
    const result = await setProviderKey(process.cwd(), target, key);
    console.log(`saved ${result.provider} key to project-local ignored env (${result.keyName})`);
    return;
  }

  console.error("Usage: aginti keys status OR aginti keys set deepseek [--stdin]");
  process.exit(1);
}

async function handleSessionsCommand(argv) {
  const [verb = "list", sessionId = ""] = argv;
  if (verb === "list") {
    const sessions = await listProjectSessions(process.cwd(), 80);
    if (sessions.length === 0) {
      console.log("No project-local sessions found.");
      return;
    }
    for (const session of sessions) {
      const goal = session.goal ? ` ${session.goal.slice(0, 90)}` : "";
      console.log(`${session.sessionId} ${session.provider}/${session.model} ${session.updatedAt}${goal}`);
    }
    return;
  }

  if (verb === "show") {
    if (!sessionId) {
      console.error("Usage: aginti sessions show <session-id>");
      process.exit(1);
    }
    const session = await showProjectSession(process.cwd(), sessionId);
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.error("Usage: aginti sessions list OR aginti sessions show <session-id>");
  process.exit(1);
}

async function resolveResumeSessionId(sessionId) {
  if (sessionId && sessionId !== "latest") return sessionId;
  const sessions = await listProjectSessions(process.cwd(), 1);
  if (sessions[0]?.sessionId) return sessions[0].sessionId;
  throw new Error("No project-local sessions found. Run `aginti sessions list` to check this folder.");
}

async function handleQueueCommand(argv) {
  const sessionId = argv[0] || "";
  const content = argv.slice(1).join(" ").trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(sessionId) || !content) {
    console.error('Usage: aginti queue <session-id> "message to apply during the next agent step"');
    process.exit(1);
  }

  const store = new SessionStore(path.resolve(process.cwd(), ".sessions"), sessionId);
  await store.appendInbox(content, { source: "cli" });
  await store.appendEvent("conversation.queued_input", { prompt: content, source: "cli" }).catch(() => {});
  console.log(`queued message for ${sessionId}`);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--help" || argv[0] === "help" || argv[0] === "-h") {
    printUsage();
    return;
  }

  if (argv[0] === "--version" || argv[0] === "version" || argv[0] === "-v") {
    console.log(packageJson.version);
    return;
  }

  if (argv[0] === "init") {
    printInitResult(await initProject(process.cwd()));
    return;
  }

  if (argv[0] === "doctor") {
    const parsed = parseArgs(argv.slice(1).filter((arg) => arg !== "--json" && arg !== "--capabilities"));
    const config = loadConfig(
      {
        ...parsed,
        goal: "doctor",
        allowShellTool: parsed.allowShellTool ?? true,
        allowFileTools: parsed.allowFileTools ?? true,
      },
      { packageDir, baseDir: process.cwd() }
    );
    const report = argv.includes("--capabilities")
      ? await buildCapabilityReport(process.cwd(), packageJson.version, config)
      : await doctorReport(process.cwd(), packageJson.version, config);
    if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else if (argv.includes("--capabilities")) printCapabilityReport(report);
    else printDoctorReport(report);
    return;
  }

  if (argv[0] === "capabilities") {
    const parsed = parseArgs(argv.slice(1).filter((arg) => arg !== "--json"));
    const config = loadConfig(
      {
        ...parsed,
        goal: "capabilities",
        allowShellTool: parsed.allowShellTool ?? true,
        allowFileTools: parsed.allowFileTools ?? true,
      },
      { packageDir, baseDir: process.cwd() }
    );
    const report = await buildCapabilityReport(process.cwd(), packageJson.version, config);
    if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else printCapabilityReport(report);
    return;
  }

  if (argv[0] === "keys/status") {
    await handleKeyCommand(["status"]);
    return;
  }

  if (argv[0] === "keys") {
    await handleKeyCommand(argv.slice(1));
    return;
  }

  if (argv[0] === "login") {
    const provider = argv[1] || "deepseek";
    const key = argv.includes("--stdin") || !process.stdin.isTTY
      ? await readStdin()
      : await promptHidden(`${provider === "openai" ? "OpenAI" : "DeepSeek"} API key: `);
    if (!key) {
      console.error("No key saved.");
      process.exit(1);
    }
    const result = await setProviderKey(process.cwd(), provider, key);
    console.log(`saved ${result.provider} key to project-local ignored env (${result.keyName})`);
    return;
  }

  if (argv[0] === "sessions") {
    await handleSessionsCommand(argv.slice(1));
    return;
  }

  if (argv[0] === "queue") {
    await handleQueueCommand(argv.slice(1));
    return;
  }

  if (argv[0] === "resume") {
    let sessionId = argv[1] || "";
    const prompt = argv.slice(2).join(" ").trim();
    try {
      sessionId = await resolveResumeSessionId(sessionId);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    if (!prompt) {
      await startInteractiveCli(agentDefaults({ ...parseArgs([]), resume: sessionId }), {
        packageDir,
        packageVersion: packageJson.version,
      });
      return;
    }
    const resumeArgs = agentDefaults({ ...parseArgs([prompt]), resume: sessionId, goal: prompt });
    if (!(await ensureDeepSeekKeyForOneShot(resumeArgs))) process.exit(1);
    const config = loadConfig(resumeArgs, { packageDir });
    await runAgent(config);
    return;
  }

  const args = parseArgs(argv);

  if (args.web) {
    if (args.port) process.env.PORT = String(args.port);
    if (args.host) process.env.HOST = String(args.host);
    process.env.AGINTIFLOW_PACKAGE_DIR = packageDir;
    await import("../web.js");
    return;
  }

  if (args.interactive || (!args.goal && !args.resume && process.stdin.isTTY)) {
    await startInteractiveCli(agentDefaults(args), { packageDir, packageVersion: packageJson.version });
    return;
  }

  if (args.listRoutes) {
    printRoutes();
    return;
  }

  if (args.listWrappers) {
    printWrappers();
    return;
  }

  if (args.listProfiles) {
    printProfiles();
    return;
  }

  if (args.sandboxStatus || args.sandboxPreflight) {
    const config = loadConfig({ ...args, goal: args.goal || "sandbox preflight" }, { packageDir });
    const result = args.sandboxPreflight
      ? await runDockerPreflight(config, { buildImage: true })
      : { ok: true, status: await getDockerSandboxStatus(config) };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!args.goal && !args.resume) {
    printUsage();
    process.exit(1);
  }

  const finalArgs = agentDefaults(args);
  if (!(await ensureDeepSeekKeyForOneShot(finalArgs))) process.exit(1);
  const config = loadConfig(finalArgs, { packageDir });
  await runAgent(config);
}
