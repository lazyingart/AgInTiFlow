import { runAgent } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import { listAgentWrappers } from "./tool-wrappers.js";
import { getModelPresets } from "./model-routing.js";
import { getDockerSandboxStatus, runDockerPreflight } from "./docker-sandbox.js";
import {
  doctorReport,
  initProject,
  listProjectSessions,
  providerKeyStatus,
  setProviderKey,
  showProjectSession,
} from "./project.js";
import { listTaskProfiles } from "./task-profiles.js";
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
    port: "",
    host: "",
    listProfiles: false,
  };

  const parts = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "web" || arg === "--web") {
      result.web = true;
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
    if (arg === "--max-steps") {
      result.maxSteps = Number(readOption(argv, i));
      i += 1;
      continue;
    }
    if (arg === "--allow-shell") {
      result.allowShellTool = true;
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
    if (!argv.includes("--stdin")) {
      console.error(`Usage: aginti keys set ${target} --stdin`);
      process.exit(1);
    }
    const key = await readStdin();
    const result = await setProviderKey(process.cwd(), target, key);
    console.log(`saved ${result.provider} key to project-local ignored env (${result.keyName})`);
    return;
  }

  console.error("Usage: aginti keys status OR aginti keys set deepseek --stdin");
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

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "init") {
    printInitResult(await initProject(process.cwd()));
    return;
  }

  if (argv[0] === "doctor") {
    const config = loadConfig({ goal: "doctor" }, { packageDir, baseDir: process.cwd() });
    const report = await doctorReport(process.cwd(), packageJson.version, config);
    if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else printDoctorReport(report);
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
    if (!argv.includes("--stdin") && process.stdin.isTTY) {
      console.error(`Usage: printf '%s' '<key>' | aginti login ${provider} --stdin`);
      process.exit(1);
    }
    const key = await readStdin();
    const result = await setProviderKey(process.cwd(), provider, key);
    console.log(`saved ${result.provider} key to project-local ignored env (${result.keyName})`);
    return;
  }

  if (argv[0] === "sessions") {
    await handleSessionsCommand(argv.slice(1));
    return;
  }

  if (argv[0] === "resume") {
    const sessionId = argv[1] || "";
    const prompt = argv.slice(2).join(" ").trim();
    if (!sessionId || !prompt) {
      console.error('Usage: aginti resume <session-id> "new prompt"');
      process.exit(1);
    }
    const config = loadConfig({ ...parseArgs([prompt]), resume: sessionId, goal: prompt }, { packageDir });
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
    console.error(
      'Usage: aginti-cli web [--port 3210] OR aginti-cli [--routing smart|fast|complex|manual] [--provider deepseek|openai|mock] [--sandbox-mode host|docker-readonly|docker-workspace] [--package-install-policy block|prompt|allow] [--allow-shell] [--allow-file-tools|--no-file-tools] [--allow-wrappers --wrapper codex] [--sandbox-status|--sandbox-preflight] "your task"'
    );
    process.exit(1);
  }

  const config = loadConfig(args, { packageDir });
  await runAgent(config);
}
