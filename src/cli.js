import { runAgent } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import { listAgentWrappers } from "./tool-wrappers.js";
import { getModelPresets } from "./model-routing.js";

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
    allowShellTool: undefined,
    allowWrapperTools: undefined,
    useDockerSandbox: undefined,
    headless: undefined,
    maxSteps: undefined,
    listRoutes: false,
    listWrappers: false,
  };

  const parts = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
    if (arg === "--max-steps") {
      result.maxSteps = Number(readOption(argv, i));
      i += 1;
      continue;
    }
    if (arg === "--allow-shell") {
      result.allowShellTool = true;
      continue;
    }
    if (arg === "--allow-wrappers") {
      result.allowWrapperTools = true;
      continue;
    }
    if (arg === "--docker-sandbox") {
      result.useDockerSandbox = true;
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.listRoutes) {
    printRoutes();
    return;
  }

  if (args.listWrappers) {
    printWrappers();
    return;
  }

  if (!args.goal && !args.resume) {
    console.error(
      'Usage: aginti-cli [--routing smart|fast|complex|manual] [--provider deepseek|openai] [--model model] [--allow-shell] [--allow-wrappers] [--start-url https://example.com] [--resume session-id] "your task"'
    );
    process.exit(1);
  }

  const config = loadConfig(args);
  await runAgent(config);
}
