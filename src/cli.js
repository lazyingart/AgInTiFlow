import { runAgent } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import { listAgentWrappers } from "./tool-wrappers.js";
import {
  AUXILIARY_MODEL_CATALOG,
  MODEL_PROVIDER_GROUPS,
  PROVIDER_MODEL_CATALOG,
  getModelPresets,
  getModelRoleDefaults,
  modelsForProviderGroup,
} from "./model-routing.js";
import { getDockerSandboxStatus, runDockerPreflight } from "./docker-sandbox.js";
import { buildCapabilityReport, printCapabilityReport } from "./capabilities.js";
import { startInteractiveCli } from "./interactive-cli.js";
import { SessionStore } from "./session-store.js";
import {
  doctorReport,
  ensureProjectSessionStorage,
  initProject,
  listProjectSessions,
  renameProjectSession,
  providerKeyStatus,
  setProviderKey,
  showProjectSession,
  sessionStoreOptions,
} from "./project.js";
import { listTaskProfiles } from "./task-profiles.js";
import { recommendedMaxStepsForTask } from "./engineering-guidance.js";
import { normalizeAuthProvider, promptHidden, runAuthWizard, shouldPromptForDeepSeek } from "./auth-onboarding.js";
import { listSkills, selectSkillsForGoal } from "./skill-library.js";
import { languageLabel, resolveLanguage } from "./i18n.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));

process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") process.exit(0);
  throw error;
});

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
    routeProvider: "",
    routeModel: "",
    mainProvider: "",
    mainModel: "",
    spareProvider: "",
    spareModel: "",
    spareReasoning: "",
    wrapperModel: "",
    wrapperReasoning: "",
    auxiliaryProvider: "",
    auxiliaryModel: "",
    routingMode: "",
    commandCwd: "",
    sandboxMode: "",
    packageInstallPolicy: "",
    allowShellTool: undefined,
    allowFileTools: undefined,
    allowWrapperTools: undefined,
    allowAuxiliaryTools: undefined,
    allowWebSearch: undefined,
    allowParallelScouts: undefined,
    parallelScoutCount: undefined,
    allowDestructive: undefined,
    preferredWrapper: "",
    taskProfile: "",
    useDockerSandbox: undefined,
    headless: undefined,
    maxSteps: undefined,
    listRoutes: false,
    listModels: false,
    listWrappers: false,
    sandboxStatus: false,
    sandboxPreflight: false,
    web: false,
    interactive: false,
    port: "",
    host: "",
    listProfiles: false,
    listSkills: false,
    latex: false,
    image: false,
    language: "",
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
    if (arg === "--language" || arg === "--lang" || arg === "-L") {
      const first = readOption(argv, i);
      const second = argv[i + 2] && !String(argv[i + 2]).startsWith("--") ? argv[i + 2] : "";
      if (["cn", "zh"].includes(String(first || "").toLowerCase()) && ["s", "t"].includes(String(second || "").toLowerCase())) {
        result.language = `${first}-${second}`;
        i += 2;
      } else {
        result.language = first;
        i += 1;
      }
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
    if (arg === "--route-provider") {
      result.routeProvider = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--route-model") {
      result.routeModel = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--main-provider") {
      result.mainProvider = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--main-model") {
      result.mainModel = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--spare-provider") {
      result.spareProvider = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--spare-model") {
      result.spareModel = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--spare-reasoning") {
      result.spareReasoning = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--wrapper-model") {
      result.wrapperModel = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--wrapper-reasoning") {
      result.wrapperReasoning = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--aux-provider" || arg === "--auxiliary-provider") {
      result.auxiliaryProvider = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--aux-model" || arg === "--auxiliary-model") {
      result.auxiliaryModel = readOption(argv, i);
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
    if (arg === "--image" || arg === "--image-gen" || arg === "--image-generation") {
      result.image = true;
      result.taskProfile = "image";
      result.allowAuxiliaryTools = true;
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
    if (arg === "--allow-auxiliary-tools" || arg === "--allow-auxiliary") {
      result.allowAuxiliaryTools = true;
      continue;
    }
    if (arg === "--no-auxiliary-tools" || arg === "--no-auxiliary") {
      result.allowAuxiliaryTools = false;
      continue;
    }
    if (arg === "--web-search") {
      result.allowWebSearch = true;
      continue;
    }
    if (arg === "--no-web-search") {
      result.allowWebSearch = false;
      continue;
    }
    if (arg === "--parallel-scouts") {
      result.allowParallelScouts = true;
      continue;
    }
    if (arg === "--no-parallel-scouts") {
      result.allowParallelScouts = false;
      continue;
    }
    if (arg === "--scout-count") {
      result.parallelScoutCount = Number(readOption(argv, i));
      i += 1;
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
    if (arg === "--list-models" || arg === "--models") {
      result.listModels = true;
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
    if (arg === "--list-skills") {
      result.listSkills = true;
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
    'Usage: aginti [chat] OR aginti web [--port 3210] OR aginti models OR aginti skills [query] OR aginti auth [deepseek|openai|qwen|venice|grsai] OR aginti resume [latest|<session-id>] ["prompt"] OR aginti queue <session-id> "message" OR aginti [--language en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru] [--image] [--latex] [--routing smart|fast|complex|manual] [--provider deepseek|openai|qwen|venice|mock] [--model MODEL] [--route-model MODEL] [--main-model MODEL] [--spare-model MODEL --spare-reasoning medium] [--aux-provider grsai|venice --aux-model MODEL] [--sandbox-mode host|docker-readonly|docker-workspace] [--package-install-policy block|prompt|allow] [--approve-package-installs] [--allow-shell|--no-shell] [--allow-file-tools|--no-file-tools] [--web-search|--no-web-search] [--parallel-scouts|--no-parallel-scouts --scout-count 1..10] [--allow-auxiliary-tools|--no-auxiliary-tools] [--allow-wrappers --wrapper codex --wrapper-model gpt-5.5] [--list-models|--list-routes] "your task"'
  );
  console.log(`Languages: ${["en", "ja", "zh-Hans", "zh-Hant", "ko", "fr", "es", "ar", "vi", "de", "ru"].map((code) => `${code}=${languageLabel(code)}`).join(", ")}`);
}

function providerLabel(provider) {
  const normalized = String(provider || "").toLowerCase();
  if (normalized === "openai") return "OpenAI";
  if (normalized === "qwen") return "Qwen";
  if (normalized === "venice") return "Venice";
  if (normalized === "grsai" || normalized === "auxiliary") return "GRSAI";
  return "DeepSeek";
}

function agentDefaults(args) {
  const envSandboxMode = process.env.SANDBOX_MODE || "";
  const envPackageInstallPolicy = process.env.PACKAGE_INSTALL_POLICY || "";
  const envUseDockerSandbox = process.env.USE_DOCKER_SANDBOX;
  const envScoutCount = Number(process.env.AGINTI_SCOUT_COUNT);
  const taskProfile = args.taskProfile || process.env.AGINTI_TASK_PROFILE || (args.latex ? "latex" : "auto");
  const defaults = {
    ...args,
    provider: args.provider || process.env.AGENT_PROVIDER || "",
    routingMode: args.routingMode || process.env.AGENT_ROUTING_MODE || "smart",
    routeProvider: args.routeProvider || process.env.AGINTI_ROUTE_PROVIDER || "",
    routeModel: args.routeModel || process.env.AGINTI_ROUTE_MODEL || "",
    mainProvider: args.mainProvider || process.env.AGINTI_MAIN_PROVIDER || "",
    mainModel: args.mainModel || process.env.AGINTI_MAIN_MODEL || "",
    spareProvider: args.spareProvider || process.env.AGINTI_SPARE_PROVIDER || "",
    spareModel: args.spareModel || process.env.AGINTI_SPARE_MODEL || "",
    spareReasoning: args.spareReasoning || process.env.AGINTI_SPARE_REASONING || "",
    taskProfile,
    language: resolveLanguage(args.language || process.env.AGINTI_LANGUAGE || ""),
    allowShellTool: args.allowShellTool ?? true,
    allowFileTools: args.allowFileTools ?? true,
    allowAuxiliaryTools: args.allowAuxiliaryTools ?? true,
    allowWebSearch: args.allowWebSearch ?? true,
    allowParallelScouts: args.allowParallelScouts ?? true,
    parallelScoutCount: args.parallelScoutCount || (Number.isFinite(envScoutCount) && envScoutCount > 0 ? envScoutCount : 3),
    sandboxMode: args.sandboxMode || envSandboxMode || "docker-workspace",
    packageInstallPolicy: args.packageInstallPolicy || envPackageInstallPolicy || "allow",
    useDockerSandbox:
      args.useDockerSandbox ??
      (envUseDockerSandbox === undefined ? true : String(envUseDockerSandbox).toLowerCase() !== "false"),
    maxSteps:
      args.maxSteps ||
      recommendedMaxStepsForTask({
        goal: args.goal || "",
        taskProfile,
      }),
  };

  if (defaults.sandboxMode === "host") {
    defaults.useDockerSandbox = false;
    defaults.packageInstallPolicy = args.packageInstallPolicy || envPackageInstallPolicy || "prompt";
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

function printModels() {
  const roles = getModelRoleDefaults();
  console.log("Model roles:");
  for (const role of Object.values(roles)) {
    const reasoning = role.reasoning ? ` reasoning=${role.reasoning}` : "";
    console.log(`  ${role.command}: ${role.provider}/${role.model}${reasoning} - ${role.description}`);
  }
  console.log("");
  console.log("Provider groups:");
  for (const [id, group] of Object.entries(MODEL_PROVIDER_GROUPS)) {
    const models = modelsForProviderGroup(id)
      .map((item) => item.id)
      .join(", ");
    console.log(`  ${id}: provider=${group.provider} role=${group.role} models=${models || "(none)"}`);
  }
  console.log("");
  console.log("Auxiliary image groups:");
  for (const [id, models] of Object.entries(AUXILIARY_MODEL_CATALOG)) {
    console.log(`  ${id}: ${models.map((item) => item.id).join(", ")}`);
  }
  console.log("");
  console.log("Direct provider models:");
  for (const [provider, models] of Object.entries(PROVIDER_MODEL_CATALOG)) {
    console.log(`  ${provider}: ${models.map((item) => item.id).join(", ")}`);
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

function printSkills(query = "") {
  const skills = query
    ? selectSkillsForGoal(query, { taskProfile: "auto", limit: 40, includeBody: false })
    : listSkills({ includeBody: false });
  for (const skill of skills) {
    const triggers = skill.triggers?.length ? ` triggers=${skill.triggers.join(",")}` : "";
    const tools = skill.tools?.length ? ` tools=${skill.tools.join(",")}` : "";
    console.log(`${skill.id}: ${skill.label} - ${skill.description}${triggers}${tools}`);
  }
}

function printInitResult(result) {
  console.log(`AgInTiFlow project initialized: ${result.projectRoot}`);
  console.log(`instructions=${result.instructionsPath}`);
  console.log(`control=${result.controlDir}`);
  console.log(`projectSessions=${result.sessionsDir}`);
  console.log(`created=${result.created.length} updated=${result.updated.length} skipped=${result.skipped.length}`);
}

function printDoctorReport(report) {
  console.log(`AgInTiFlow ${report.package.version} (npm latest: ${report.package.npmLatest})`);
  console.log(`node=${report.node.version} ok=${report.node.ok}`);
  console.log(`platform=${report.platform.label} family=${report.platform.linuxFamily || report.platform.platform}`);
  console.log(`project=${report.project.root}`);
  console.log(`instructions=${report.project.instructionsPath} present=${report.project.instructionsPresent}`);
  console.log(`projectSessions=${report.project.sessionsDir}`);
  console.log(`globalSessions=${report.project.globalSessionsDir}`);
  console.log(`sessionDb=${report.project.sessionDbPath}`);
  console.log(
    `keys: deepseek=${report.keys.deepseek ? "available" : "missing"} openai=${
      report.keys.openai ? "available" : "missing"
    } qwen=${report.keys.qwen ? "available" : "missing"} venice=${
      report.keys.venice ? "available" : "missing"
    } grsai=${
      report.keys.grsai ? "available" : "missing"
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
  if (report.platform.setupHints.length > 0) {
    console.log("platform setup hints:");
    for (const hint of report.platform.setupHints) console.log(`- ${hint}`);
  }
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input.trim();
}

async function ensureDeepSeekKeyForOneShot(args) {
  if (!shouldPromptForDeepSeek(args, process.cwd())) return true;
  console.log("No main model API key is configured for this project.");
  console.log("Choose DeepSeek, OpenAI, Qwen, or Venice, then paste a key to save in `.aginti/.env` with 0600 permissions.");
  const result = await runAuthWizard(process.cwd(), { provider: args.provider || "" });
  printAuthWizardResult(result);
  if (result.saved.some((item) => item.provider !== "grsai")) {
    return true;
  }
  console.error("No main key saved. Run `aginti auth` later, or use `--provider mock` for local tests.");
  return false;
}

async function handleKeyCommand(argv) {
  const [verb = "status", provider = ""] = argv;
  if (verb === "status") {
    const status = providerKeyStatus(process.cwd());
    console.log(
      `keys: deepseek=${status.deepseek ? "available" : "missing"} openai=${
        status.openai ? "available" : "missing"
      } qwen=${status.qwen ? "available" : "missing"} venice=${
        status.venice ? "available" : "missing"
      } grsai=${status.grsai ? "available" : "missing"} mock=available localEnv=${status.localEnv}`
    );
    console.log("env vars: DeepSeek=DEEPSEEK_API_KEY or LLM_API_KEY; OpenAI=OPENAI_API_KEY or LLM_API_KEY; Qwen=QWEN_API_KEY; Venice=VENICE_API_KEY; image=GRSAI or GRSAI_API_KEY");
    return;
  }

  if (verb === "set") {
    const target = provider || "deepseek";
    const key = argv.includes("--stdin") ? await readStdin() : await promptHidden(`${providerLabel(target)} API key/token: `);
    if (!key) {
      console.error("No key saved.");
      process.exit(1);
    }
    const result = await setProviderKey(process.cwd(), target, key);
    console.log(`saved ${result.provider} key to project-local ignored env (${result.keyName})`);
    return;
  }

  console.error("Usage: aginti keys status OR aginti keys set deepseek|openai|qwen|venice|grsai [--stdin]");
  process.exit(1);
}

function printAuthWizardResult(result) {
  if (result.saved.length > 0) {
    for (const item of result.saved) {
      console.log(`saved ${item.provider} key to project-local ignored env (${item.keyName})`);
    }
  }
  if (result.saved.length === 0) console.log("No key saved.");
  if (result.skipped.length > 0) {
    console.log(`skipped: ${result.skipped.map((item) => item.provider).join(", ")}`);
  }
}

async function handleSessionsCommand(argv) {
  const [verb = "list", sessionId = "", ...rest] = argv;
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

  if (verb === "rename") {
    const title = rest.join(" ").trim();
    if (!sessionId || !title) {
      console.error('Usage: aginti sessions rename <session-id> "new title"');
      process.exit(1);
    }
    const result = await renameProjectSession(process.cwd(), sessionId, title);
    console.log(`renamed ${result.sessionId}: ${result.title}`);
    return;
  }

  console.error('Usage: aginti sessions list OR aginti sessions show <session-id> OR aginti sessions rename <session-id> "title"');
  process.exit(1);
}

async function promptSelectSession(sessions) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return sessions[0]?.sessionId || "";
  console.log("Select a session to resume:");
  sessions.slice(0, 20).forEach((session, index) => {
    const title = session.title || session.goal || "(untitled)";
    console.log(
      `${index + 1}. ${session.sessionId} ${session.provider || "unknown"}/${session.model || "unknown"} ${session.updatedAt || ""} ${title.slice(0, 90)}`
    );
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Session number: ");
    const index = Number(answer.trim()) - 1;
    return sessions[index]?.sessionId || "";
  } finally {
    rl.close();
  }
}

async function resolveResumeSessionId(sessionId) {
  if (sessionId && sessionId !== "latest") return sessionId;
  const sessions = await listProjectSessions(process.cwd(), 50);
  if (sessionId === "latest" || sessions.length <= 1 || !process.stdin.isTTY || !process.stdout.isTTY) {
    if (sessions[0]?.sessionId) return sessions[0].sessionId;
  } else {
    const selected = await promptSelectSession(sessions);
    if (selected) return selected;
  }
  throw new Error("No project-local sessions found. Run `aginti sessions list` to check this folder.");
}

async function handleQueueCommand(argv) {
  const sessionId = argv[0] || "";
  const content = argv.slice(1).join(" ").trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(sessionId) || !content) {
    console.error('Usage: aginti queue <session-id> "message to apply during the next agent step"');
    process.exit(1);
  }

  const paths = await ensureProjectSessionStorage(process.cwd());
  const store = new SessionStore(paths.globalSessionsDir, sessionId, sessionStoreOptions(process.cwd(), sessionId));
  await store.appendInbox(content, { source: "cli" });
  await store.appendEvent("conversation.queued_input", { prompt: content, source: "cli" }).catch(() => {});
  console.log(`queued message for ${sessionId}`);
}

async function handleStorageCommand(argv) {
  const [verb = "status", ...rest] = argv;
  if (verb !== "migrate" && verb !== "status") {
    console.error("Usage: aginti storage migrate [project-root ...] OR aginti storage status");
    process.exit(1);
  }

  const roots = verb === "migrate" && rest.length > 0 ? rest : [process.cwd()];
  for (const root of roots) {
    const projectRoot = path.resolve(root);
    const paths = await ensureProjectSessionStorage(projectRoot);
    const sessions = await listProjectSessions(projectRoot, 1000);
    console.log(
      `${verb === "migrate" ? "migrated" : "storage"} project=${paths.root} projectSessions=${paths.sessionsDir} globalSessions=${paths.globalSessionsDir} sessions=${sessions.length}`
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
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

  if (argv[0] === "auth" || argv[0] === "login") {
    const provider = normalizeAuthProvider(argv[1] || "", "");
    if (argv[0] === "auth" || (!provider && process.stdin.isTTY)) {
      const result = await runAuthWizard(process.cwd(), { provider });
      printAuthWizardResult(result);
      return;
    }
    const target = provider || "deepseek";
    const key = argv.includes("--stdin") || !process.stdin.isTTY
      ? await readStdin()
      : await promptHidden(`${providerLabel(target)} API key/token: `);
    if (!key) {
      console.error("No key saved.");
      process.exit(1);
    }
    const result = await setProviderKey(process.cwd(), target, key);
    console.log(`saved ${result.provider} key to project-local ignored env (${result.keyName})`);
    return;
  }

  if (argv[0] === "sessions") {
    await handleSessionsCommand(argv.slice(1));
    return;
  }

  if (argv[0] === "storage") {
    await handleStorageCommand(argv.slice(1));
    return;
  }

  if (argv[0] === "models" || argv[0] === "model") {
    printModels();
    return;
  }

  if (argv[0] === "skills" || argv[0] === "skill") {
    printSkills(argv.slice(1).join(" ").trim());
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
    if (args.language) process.env.AGINTI_LANGUAGE = resolveLanguage(args.language);
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

  if (args.listModels) {
    printModels();
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

  if (args.listSkills) {
    printSkills(args.goal);
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
