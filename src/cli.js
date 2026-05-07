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
  listProjectSessionRemovalCandidates,
  listProjectSessions,
  renameProjectSession,
  removeProjectSessions,
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
import { maybeAutoUpdate } from "./auto-update.js";
import { readHousekeepingSummary } from "./housekeeping.js";
import { handleSkillMeshCommand } from "./skillmesh.js";
import { handleAapsCliCommand } from "./aaps-adapter.js";
import { formatInstructionTemplateList, normalizeInstructionTemplate } from "./behavior-contract.js";
import { applyPermissionMode, normalizePermissionMode } from "./permission-modes.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import * as readlineRaw from "node:readline";

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

function readOptionalScsMode(argv, index) {
  const value = readOption(argv, index);
  const normalized = String(value || "").trim().toLowerCase();
  if (!["on", "off", "auto", "smart", "true", "false", "yes", "no", "enable", "disable", "enabled", "disabled", "1", "0"].includes(normalized)) {
    return { mode: "on", consumed: false };
  }
  return { mode: value, consumed: true };
}

function suggestCliOption(option = "") {
  const normalized = String(option || "");
  const aliases = {
    "--allow-web-search": "--web-search",
    "--disable-web-search": "--no-web-search",
    "--allow-scouts": "--parallel-scouts",
    "--disable-scouts": "--no-parallel-scouts",
    "--allow-auxiliary": "--allow-auxiliary-tools",
    "--disable-auxiliary": "--no-auxiliary-tools",
    "--allow-files": "--allow-file-tools",
    "--no-files": "--no-file-tools",
  };
  if (aliases[normalized]) return aliases[normalized];
  return "";
}

function printUnknownCliOptions(options = []) {
  const unique = [...new Set(options.filter(Boolean))];
  for (const option of unique) {
    const suggestion = suggestCliOption(option);
    console.error(`Unknown option: ${option}${suggestion ? `. Did you mean ${suggestion}?` : ""}`);
  }
  console.error("Use `--` before a prompt that intentionally starts with a dash.");
}

const CLI_VALUE_OPTIONS = new Set([
  "--port",
  "--host",
  "--language",
  "--lang",
  "-L",
  "--start-url",
  "--resume",
  "--session-id",
  "--provider",
  "--model",
  "--route-provider",
  "--route-model",
  "--main-provider",
  "--main-model",
  "--spare-provider",
  "--spare-model",
  "--spare-reasoning",
  "--wrapper-model",
  "--wrapper-reasoning",
  "--aux-provider",
  "--auxiliary-provider",
  "--aux-model",
  "--auxiliary-model",
  "--routing",
  "--cwd",
  "--permission-mode",
  "--safety",
  "-s",
  "--sandbox-mode",
  "--package-install-policy",
  "--max-steps",
  "--dynamic-steps",
  "--dynamic-step-limit",
  "--dynamic-step-hard-cap",
  "--dynamic-step-size",
  "--scout-count",
  "--wrapper",
  "--preferred-wrapper",
  "--profile",
  "--task-profile",
]);

const CLI_FLAG_OPTIONS = new Set([
  "--web",
  "--chat",
  "--interactive",
  "--no-auto-update",
  "--auto-update",
  "--enable-scs",
  "--disable-scs",
  "--no-scs",
  "--approve-package-installs",
  "--latex",
  "--image",
  "--image-gen",
  "--image-generation",
  "--allow-shell",
  "--no-shell",
  "--allow-destructive",
  "--trusted-host-shell",
  "--allow-file-tools",
  "--no-file-tools",
  "--allow-auxiliary-tools",
  "--allow-auxiliary",
  "--no-auxiliary-tools",
  "--no-auxiliary",
  "--web-search",
  "--no-web-search",
  "--parallel-scouts",
  "--no-parallel-scouts",
  "--allow-wrappers",
  "--docker-sandbox",
  "--headless",
  "--list-routes",
  "--list-models",
  "--models",
  "--list-wrappers",
  "--list-profiles",
  "--list-skills",
  "--sandbox-status",
  "--sandbox-preflight",
  "--scs",
]);

function collectCliOption(argv, index) {
  const arg = argv[index];
  if (arg === "--scs" || arg === "--enable-scs") {
    const { consumed } = readOptionalScsMode(argv, index);
    return { recognized: true, args: consumed ? [arg, argv[index + 1]] : [arg], nextIndex: index + (consumed ? 2 : 1) };
  }
  if (arg === "--language" || arg === "--lang" || arg === "-L") {
    const first = readOption(argv, index);
    const second = argv[index + 2] && !String(argv[index + 2]).startsWith("--") ? argv[index + 2] : "";
    if (["cn", "zh"].includes(String(first || "").toLowerCase()) && ["s", "t"].includes(String(second || "").toLowerCase())) {
      return { recognized: true, args: [arg, first, second], nextIndex: index + 3 };
    }
    return first
      ? { recognized: true, args: [arg, first], nextIndex: index + 2 }
      : { recognized: true, args: [arg], nextIndex: index + 1 };
  }
  if (CLI_VALUE_OPTIONS.has(arg)) {
    const value = readOption(argv, index);
    return value
      ? { recognized: true, args: [arg, value], nextIndex: index + 2 }
      : { recognized: true, args: [arg], nextIndex: index + 1 };
  }
  if (CLI_FLAG_OPTIONS.has(arg)) {
    return { recognized: true, args: [arg], nextIndex: index + 1 };
  }
  return { recognized: false, args: [], nextIndex: index };
}

function looksLikeResumeSessionSelector(value) {
  if (!value) return true;
  const normalized = String(value);
  return (
    normalized === "latest" ||
    normalized.startsWith("web-agent-") ||
    normalized.startsWith("round") ||
    normalized.startsWith("session-") ||
    normalized.startsWith("aginti-")
  );
}

function looksLikeResumeInvocation(resumeArgv = []) {
  for (let index = 0; index < resumeArgv.length;) {
    const arg = resumeArgv[index];
    if (arg === "--" || looksLikeResumeSessionSelector(arg)) return looksLikeResumeSessionSelector(arg);
    if (arg === "--all-sessions") {
      index += 1;
      continue;
    }
    const collected = collectCliOption(resumeArgv, index);
    if (collected.recognized) {
      index = collected.nextIndex;
      continue;
    }
    return looksLikeResumeSessionSelector(arg);
  }
  return true;
}

export function splitResumeCommandArgv(argv = []) {
  if (argv[0] === "resume") {
    return { leadingOptionArgv: [], resumeArgv: argv.slice(1) };
  }

  const leadingOptionArgv = [];
  let index = 0;
  while (index < argv.length) {
    if (argv[index] === "resume") {
      const resumeArgv = argv.slice(index + 1);
      return looksLikeResumeInvocation(resumeArgv) ? { leadingOptionArgv, resumeArgv } : null;
    }
    const collected = collectCliOption(argv, index);
    if (!collected.recognized) return null;
    leadingOptionArgv.push(...collected.args);
    index = collected.nextIndex;
  }
  return null;
}

export function parseResumeCommandArgs(resumeArgv = [], leadingOptionArgv = []) {
  const optionArgv = [...leadingOptionArgv];
  const positional = [];
  const promptParts = [];
  const unknownOptions = [];
  let allSessions = false;
  let promptMode = false;

  for (let index = 0; index < resumeArgv.length;) {
    const arg = resumeArgv[index];
    if (promptMode) {
      promptParts.push(arg);
      index += 1;
      continue;
    }
    if (arg === "--") {
      promptMode = true;
      index += 1;
      continue;
    }
    if (arg === "--all-sessions") {
      allSessions = true;
      index += 1;
      continue;
    }
    const collected = collectCliOption(resumeArgv, index);
    if (collected.recognized) {
      optionArgv.push(...collected.args);
      index = collected.nextIndex;
      continue;
    }
    if (String(arg || "").startsWith("--") && promptParts.length === 0) {
      unknownOptions.push(arg);
      index += 1;
      continue;
    }
    if (positional.length === 0) positional.push(arg);
    else promptParts.push(arg);
    index += 1;
  }

  return {
    allSessions,
    optionArgv,
    sessionId: positional[0] || "",
    prompt: promptParts.join(" ").trim(),
    unknownOptions,
  };
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
    permissionMode: "",
    packageInstallPolicy: "",
    workspaceWritePolicy: undefined,
    allowOutsideWorkspaceFileTools: undefined,
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
    dynamicSteps: undefined,
    dynamicStepExtensionLimit: undefined,
    dynamicStepHardCap: undefined,
    dynamicStepExtensionSize: undefined,
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
    autoUpdate: undefined,
    enableScs: "",
    unknownOptions: [],
  };

  const parts = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      parts.push(...argv.slice(i + 1));
      break;
    }
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
    if (arg === "--no-auto-update") {
      result.autoUpdate = false;
      continue;
    }
    if (arg === "--auto-update") {
      result.autoUpdate = true;
      continue;
    }
    if (arg === "--enable-scs" || arg === "--scs") {
      const { mode, consumed } = readOptionalScsMode(argv, i);
      result.enableScs = mode;
      if (consumed) i += 1;
      continue;
    }
    if (arg === "--disable-scs" || arg === "--no-scs") {
      result.enableScs = "off";
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
    if (arg === "-s" || arg === "--safety" || arg === "--permission-mode") {
      const mode = normalizePermissionMode(readOption(argv, i), "");
      if (mode) applyPermissionMode(result, mode, { override: true });
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
    if (arg === "--dynamic-steps") {
      result.dynamicSteps = readOption(argv, i);
      i += 1;
      continue;
    }
    if (arg === "--dynamic-step-limit") {
      result.dynamicStepExtensionLimit = Number(readOption(argv, i));
      i += 1;
      continue;
    }
    if (arg === "--dynamic-step-hard-cap") {
      result.dynamicStepHardCap = Number(readOption(argv, i));
      i += 1;
      continue;
    }
    if (arg === "--dynamic-step-size") {
      result.dynamicStepExtensionSize = Number(readOption(argv, i));
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
    if (String(arg || "").startsWith("--") && parts.length === 0) {
      result.unknownOptions.push(arg);
      continue;
    }
    parts.push(arg);
  }

  result.goal = parts.join(" ").trim();
  return result;
}

function exitOnUnknownOptions(parsed) {
  if (!parsed?.unknownOptions?.length) return false;
  printUnknownCliOptions(parsed.unknownOptions);
  process.exit(1);
}

function printUsage() {
  console.log(
    'Usage: aginti [chat] OR aginti init [--template minimal|disciplined|coding|research|writing|design|aaps|supervision] OR aginti web [--port 3210] OR aginti update OR aginti models OR aginti aaps [status|init|files|validate|compile|check|run] OR aginti skills [query] OR aginti skillmesh [status|off|record|share|sync|serve|service] OR aginti housekeeping [--json] OR aginti auth [deepseek|openai|qwen|venice|grsai] OR aginti resume [--all-sessions] [latest|<session-id>] ["prompt"] OR aginti --remove-empty-sessions OR aginti --remove-sessions OR aginti queue <session-id> "message" OR aginti [--no-auto-update] [-s safe|normal|danger] [--language en|ja|zh-Hans|zh-Hant|ko|fr|es|ar|vi|de|ru] [--image] [--latex] [--scs|--scs auto|--no-scs] [--dynamic-steps auto|on|off] [--routing smart|fast|complex|manual] [--provider deepseek|openai|qwen|venice|mock] [--model MODEL] [--route-model MODEL] [--main-model MODEL] [--spare-model MODEL --spare-reasoning medium] [--aux-provider grsai|venice --aux-model MODEL] [--sandbox-mode host|docker-readonly|docker-workspace] [--package-install-policy block|prompt|allow] [--approve-package-installs] [--allow-shell|--no-shell] [--allow-file-tools|--no-file-tools] [--web-search|--no-web-search] [--parallel-scouts|--no-parallel-scouts --scout-count 1..10] [--allow-auxiliary-tools|--no-auxiliary-tools] [--allow-wrappers --wrapper codex --wrapper-model gpt-5.5] [--list-models|--list-routes] "your task"'
  );
  console.log("Permission shortcuts: -s safe asks before writes/setup; -s normal allows current-project writes and Docker setup; -s danger enables trusted host/full-access mode.");
  console.log(`Languages: ${["en", "ja", "zh-Hans", "zh-Hant", "ko", "fr", "es", "ar", "vi", "de", "ru"].map((code) => `${code}=${languageLabel(code)}`).join(", ")}`);
}

function stripLeadingGlobalOptions(argv = []) {
  let index = 0;
  const options = {
    commandCwd: "",
  };
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--no-auto-update" || arg === "--auto-update") {
      index += 1;
      continue;
    }
    if (arg === "--language" || arg === "--lang" || arg === "-L") {
      index += readOption(argv, index) ? 2 : 1;
      continue;
    }
    if (arg === "--cwd") {
      const cwd = readOption(argv, index);
      if (cwd) options.commandCwd = path.resolve(cwd);
      index += cwd ? 2 : 1;
      continue;
    }
    break;
  }
  return {
    argv: argv.slice(index),
    options,
  };
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
  const permissionMode = normalizePermissionMode(args.permissionMode || process.env.AGINTI_PERMISSION_MODE || "normal");
  const permissionDefaults = permissionMode ? applyPermissionMode({}, permissionMode, { override: true }) : {};
  const defaults = {
    ...args,
    permissionMode,
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
    allowShellTool: args.allowShellTool ?? permissionDefaults.allowShellTool ?? true,
    allowFileTools: args.allowFileTools ?? permissionDefaults.allowFileTools ?? true,
    allowAuxiliaryTools: args.allowAuxiliaryTools ?? true,
    allowWebSearch: args.allowWebSearch ?? true,
    allowParallelScouts: args.allowParallelScouts ?? true,
    enableScs: args.enableScs || process.env.AGINTI_SCS_MODE || "off",
    parallelScoutCount: args.parallelScoutCount || (Number.isFinite(envScoutCount) && envScoutCount > 0 ? envScoutCount : 3),
    sandboxMode: args.sandboxMode || envSandboxMode || permissionDefaults.sandboxMode || "docker-workspace",
    packageInstallPolicy: args.packageInstallPolicy || envPackageInstallPolicy || permissionDefaults.packageInstallPolicy || "allow",
    workspaceWritePolicy: args.workspaceWritePolicy || permissionDefaults.workspaceWritePolicy || "allow",
    allowDestructive: args.allowDestructive ?? permissionDefaults.allowDestructive ?? false,
    allowPasswords: args.allowPasswords ?? permissionDefaults.allowPasswords ?? false,
    allowOutsideWorkspaceFileTools:
      args.allowOutsideWorkspaceFileTools ?? permissionDefaults.allowOutsideWorkspaceFileTools ?? false,
    useDockerSandbox:
      args.useDockerSandbox ??
      permissionDefaults.useDockerSandbox ??
      (envUseDockerSandbox === undefined ? true : String(envUseDockerSandbox).toLowerCase() !== "false"),
    maxSteps:
      args.maxSteps ||
      recommendedMaxStepsForTask({
        goal: args.goal || "",
        taskProfile,
      }),
    dynamicSteps: args.dynamicSteps || process.env.AGINTI_DYNAMIC_STEPS || "auto",
    dynamicStepExtensionLimit: args.dynamicStepExtensionLimit,
    dynamicStepHardCap: args.dynamicStepHardCap,
    dynamicStepExtensionSize: args.dynamicStepExtensionSize,
  };

  if (defaults.sandboxMode === "host") {
    defaults.useDockerSandbox = false;
    defaults.packageInstallPolicy =
      args.packageInstallPolicy || envPackageInstallPolicy || permissionDefaults.packageInstallPolicy || "prompt";
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
    const source = skill.source && skill.source !== "built-in" ? ` source=${skill.source}` : "";
    console.log(`${skill.id}: ${skill.label} - ${skill.description}${triggers}${tools}${source}`);
  }
}

async function printHousekeeping(argv = []) {
  const summary = await readHousekeepingSummary();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const totals = summary.capabilities?.totals || {};
  console.log("AgInTiFlow housekeeping");
  console.log(`root=${summary.paths.root}`);
  console.log(`events=${summary.paths.eventsPath}`);
  console.log(`capabilities=${summary.paths.capabilitiesPath}`);
  console.log(
    `totals events=${totals.events || 0} modelRequests=${totals.modelRequests || 0} toolEvents=${totals.toolEvents || 0} skillSelections=${totals.skillSelections || 0}`
  );
  const tools = Object.entries(summary.capabilities?.tools || {})
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
    .slice(0, 8)
    .map(([name, item]) => `${name}:${item.count || 0}`)
    .join(" ");
  const skills = Object.entries(summary.capabilities?.skills || {})
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
    .slice(0, 8)
    .map(([name, item]) => `${name}:${item.count || 0}`)
    .join(" ");
  if (tools) console.log(`topTools ${tools}`);
  if (skills) console.log(`topSkills ${skills}`);
  console.log("Set AGINTIFLOW_HOUSEKEEPING=0 to disable local sanitized housekeeping logs.");
}

function printInitResult(result) {
  console.log(`AgInTiFlow project initialized: ${result.projectRoot}`);
  console.log(`instructions=${result.instructionsPath}`);
  if (result.template) console.log(`template=${result.template}`);
  console.log(`control=${result.controlDir}`);
  console.log(`projectSessions=${result.sessionsDir}`);
  console.log(`created=${result.created.length} updated=${result.updated.length} skipped=${result.skipped.length}`);
}

function parseInitOptions(argv = []) {
  let template = "disciplined";
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--template" || arg === "-t") {
      template = readOption(argv, index) || template;
      index += 1;
      continue;
    }
    if (arg === "--list-templates" || arg === "templates" || arg === "list") {
      list = true;
      continue;
    }
    if (!arg.startsWith("-")) template = arg;
  }
  return {
    template: normalizeInstructionTemplate(template),
    list,
  };
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

const removeSessionAnsi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  inverse: "\x1b[7m",
};

function removeSessionColor(text, ...codes) {
  return `${codes.join("")}${text}${removeSessionAnsi.reset}`;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function ellipsize(text, width) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= width) return value.padEnd(width, " ");
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function buttonLabel(label, focused, disabled = false, danger = false) {
  const text = ` ${label} `;
  if (disabled) return removeSessionColor(text, removeSessionAnsi.dim);
  const codes = [];
  if (danger) codes.push(removeSessionAnsi.red, removeSessionAnsi.bold);
  if (focused) codes.push(removeSessionAnsi.inverse, removeSessionAnsi.bold);
  return codes.length > 0 ? removeSessionColor(text, ...codes) : text;
}

function renderSessionRemovalWizard(state) {
  const width = Math.min(Math.max(process.stdout.columns || 100, 80), 128);
  const rows = process.stdout.rows || 28;
  const bodyWidth = width - 4;
  const visibleCount = Math.max(5, Math.min(state.items.length || 1, rows - 11));
  if (state.cursor < state.scroll) state.scroll = state.cursor;
  if (state.cursor >= state.scroll + visibleCount) state.scroll = state.cursor - visibleCount + 1;
  const shown = state.items.slice(state.scroll, state.scroll + visibleCount);
  const selectedCount = state.selected.size;
  const border = "─".repeat(width - 2);
  const line = (content = "") => {
    const value = String(content || "");
    const clipped = stripAnsi(value).length > bodyWidth ? ellipsize(stripAnsi(value), bodyWidth) : value;
    return `│ ${clipped}${" ".repeat(Math.max(0, bodyWidth - stripAnsi(clipped).length))} │`;
  };
  const listRows = shown.map((session, offset) => {
    const index = state.scroll + offset;
    const checked = state.selected.has(session.sessionId) ? "[x]" : "[ ]";
    const cursor = index === state.cursor ? ">" : " ";
    const badge = session.isEmpty ? "empty" : "work";
    const title = session.title || session.goal || "(no title)";
    const meta = `${session.provider || "unknown"}/${session.model || "unknown"} chat=${session.chatCount} steps=${session.stepsCompleted} files=${session.artifactFileCount}`;
    const row = `${cursor} ${checked} ${badge.padEnd(5)} ${session.sessionId} ${meta} ${title}`;
    const clipped = ellipsize(row, bodyWidth);
    return state.focus === "list" && index === state.cursor ? line(removeSessionColor(clipped, removeSessionAnsi.inverse)) : line(clipped);
  });
  const footer =
    state.phase === "confirm"
      ? `Confirm deletion: ${buttonLabel("Delete", state.confirmFocus === "yes", false, true)}  ${buttonLabel("Cancel", state.confirmFocus === "cancel")}`
      : `Actions: ${buttonLabel(`Delete ${selectedCount}`, state.focus === "ok", selectedCount === 0, true)}  ${buttonLabel("Cancel", state.focus === "cancel")}`;
  const guidance =
    state.phase === "confirm"
      ? "Left/Right switches choice. Enter/Space confirms. Esc/q cancels."
      : "Space toggles or activates focused button. Up/Down moves. Tab changes focus. Esc/q cancels.";
  const lines = [
    `╭${border}╮`,
    line(state.title),
    line(state.subtitle),
    line(`Showing ${state.items.length === 0 ? 0 : state.scroll + 1}-${Math.min(state.items.length, state.scroll + visibleCount)} of ${state.items.length}; selected ${selectedCount}`),
    `├${border}┤`,
    ...listRows,
    `├${border}┤`,
    line(footer),
    line(state.message || guidance),
    `╰${border}╯`,
  ];
  process.stdout.write(`\x1b[H\x1b[2J${lines.join("\n")}`);
}

async function promptRemoveSessions(candidates, { defaultSelectedIds = [], title = "Remove sessions", subtitle = "" } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    console.log("Interactive terminal required; no sessions removed.");
    return null;
  }
  const state = {
    items: candidates,
    selected: new Set(defaultSelectedIds),
    cursor: 0,
    scroll: 0,
    focus: "list",
    phase: "select",
    confirmFocus: "cancel",
    message: "",
    title,
    subtitle,
  };
  return await new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    const cleanup = (value) => {
      input.off("keypress", onKeypress);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h\x1b[?1049l");
      resolve(value);
    };
    const moveCursor = (delta) => {
      state.focus = "list";
      state.cursor = Math.min(Math.max(state.cursor + delta, 0), Math.max(0, state.items.length - 1));
      state.message = "";
    };
    const toggleCurrent = () => {
      const session = state.items[state.cursor];
      if (!session) return;
      if (state.selected.has(session.sessionId)) state.selected.delete(session.sessionId);
      else state.selected.add(session.sessionId);
      state.message = `${state.selected.size} session(s) selected.`;
    };
    const openConfirm = () => {
      if (state.selected.size === 0) {
        state.message = "Select at least one session before confirming.";
        return;
      }
      state.phase = "confirm";
      state.confirmFocus = "cancel";
      state.message = "Second confirmation required before deleting session data.";
    };
    function onKeypress(char, key = {}) {
      if (key.ctrl && key.name === "c") return cleanup(null);
      const name = key.name || char;
      if (name === "escape" || name === "q") return cleanup(null);
      if (state.phase === "confirm") {
        if (name === "left" || name === "right" || name === "tab") state.confirmFocus = state.confirmFocus === "yes" ? "cancel" : "yes";
        else if (name === "return" || name === "enter" || name === "space") return cleanup(state.confirmFocus === "yes" ? [...state.selected] : null);
        renderSessionRemovalWizard(state);
        return;
      }
      if (name === "up") moveCursor(-1);
      else if (name === "down") moveCursor(1);
      else if (name === "pageup") moveCursor(-8);
      else if (name === "pagedown") moveCursor(8);
      else if (name === "space") {
        if (state.focus === "list") toggleCurrent();
        else if (state.focus === "cancel") return cleanup(null);
        else openConfirm();
      }
      else if (name === "tab") state.focus = state.focus === "list" ? "ok" : state.focus === "ok" ? "cancel" : "list";
      else if (name === "left" || name === "right") state.focus = state.focus === "cancel" ? "ok" : "cancel";
      else if (name === "return" || name === "enter") {
        if (state.focus === "cancel") return cleanup(null);
        openConfirm();
      }
      renderSessionRemovalWizard(state);
    }
    readlineRaw.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[?1049h\x1b[?25l");
    input.on("keypress", onKeypress);
    renderSessionRemovalWizard(state);
  });
}

function printRemovalPreview(candidates) {
  for (const session of candidates) {
    const title = session.title || session.goal || "(no title)";
    const status = session.isEmpty ? "empty" : "work";
    console.log(`${status.padEnd(5)} ${session.sessionId} ${session.updatedAt || ""} ${title.slice(0, 90)}`);
  }
}

async function handleRemoveSessionsCommand({ emptyOnly = false } = {}) {
  const candidates = await listProjectSessionRemovalCandidates(process.cwd(), {
    limit: 1000,
    emptyOnly,
  });
  if (candidates.length === 0) {
    console.log(emptyOnly ? "No empty sessions found for this cwd." : "No sessions found for this cwd.");
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printRemovalPreview(candidates);
    console.log("No sessions removed because this command needs an interactive terminal.");
    return;
  }
  const defaultSelectedIds = emptyOnly ? candidates.map((session) => session.sessionId) : [];
  const selected = await promptRemoveSessions(candidates, {
    defaultSelectedIds,
    title: emptyOnly ? "Remove empty AgInTiFlow sessions in this cwd" : "Remove AgInTiFlow sessions in this cwd",
    subtitle: emptyOnly
      ? "Only empty sessions are shown and selected by default."
      : "All cwd sessions are shown; nothing is selected by default.",
  });
  if (!selected || selected.length === 0) {
    console.log("No sessions removed.");
    return;
  }
  const allowedIds = new Set(candidates.map((session) => session.sessionId));
  const safeSelected = selected.filter((sessionId) => allowedIds.has(sessionId));
  const result = await removeProjectSessions(process.cwd(), safeSelected);
  console.log(`Removed ${result.removed.length} session(s) from this cwd:`);
  for (const item of result.removed) console.log(`- ${item.sessionId}`);
}

async function handleSessionsCommand(argv) {
  const normalizedArgv = argv[0] === "--all-sessions" ? ["list", ...argv] : argv;
  const [verb = "list", sessionId = "", ...rest] = normalizedArgv;
  if (verb === "remove-empty" || verb === "delete-empty") {
    await handleRemoveSessionsCommand({ emptyOnly: true });
    return;
  }
  if (verb === "remove" || verb === "delete") {
    await handleRemoveSessionsCommand({ emptyOnly: false });
    return;
  }
  if (verb === "list") {
    const allSessions = normalizedArgv.includes("--all-sessions");
    const sessions = await listProjectSessions(process.cwd(), { limit: 80, allSessions });
    if (sessions.length === 0) {
      console.log(allSessions ? "No sessions found." : "No sessions found for this cwd.");
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

  console.error('Usage: aginti sessions list OR aginti sessions show <session-id> OR aginti sessions rename <session-id> "title" OR aginti sessions remove-empty OR aginti sessions remove');
  process.exit(1);
}

function sessionSearchText(session) {
  return [
    session.sessionId,
    session.provider,
    session.model,
    session.updatedAt,
    session.title,
    session.goal,
    session.projectRoot,
    session.commandCwd,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterSessions(sessions, filterText = "") {
  const needle = String(filterText || "").trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) => sessionSearchText(session).includes(needle));
}

const RESUME_SESSION_PAGE_SIZE = 20;

export function formatSessionChoices(sessions, { filterText = "", allSessions = false, maxShown = RESUME_SESSION_PAGE_SIZE, cwd = process.cwd() } = {}) {
  const scope = allSessions ? "all sessions" : `cwd ${cwd}`;
  const shown = sessions.slice(0, maxShown);
  const lines = [`Select a session to resume (${scope}; newest first, 1 is latest${filterText ? `, filter="${filterText}"` : ""}):`];
  if (shown.length === 0) {
    lines.push("No matching sessions. Type /text to change the filter, / to clear it, or q to quit.");
    return lines.join("\n");
  }
  shown.forEach((session, index) => {
    const title = session.title || session.goal || "(untitled)";
    lines.push(
      `${index + 1}. ${session.sessionId} ${session.provider || "unknown"}/${session.model || "unknown"} ${session.updatedAt || ""} ${title.slice(0, 90)}`
    );
  });
  if (sessions.length > shown.length) {
    lines.push(`... ${sessions.length - shown.length} more hidden; press Space or PageDown, or type more, to show next ${RESUME_SESSION_PAGE_SIZE}; /text narrows.`);
  }
  lines.push(
    sessions.length > shown.length
      ? "Type a number to select, Space/PageDown/more to show more, /text to filter, / to clear, all to show all, or q to quit."
      : "Type a number to select, /text to filter, / to clear, or q to quit."
  );
  return lines.join("\n");
}

function printSessionChoices(sessions, options = {}) {
  console.log(formatSessionChoices(sessions, options));
}

function handleResumeSelectorAnswer(rawAnswer = "", { filtered = [], visibleCount = 0, hasMore = false, setFilter, showMore, showAll, write } = {}) {
  const answer = String(rawAnswer || "").trim();
  const lower = answer.toLowerCase();
  if (!answer) {
    if (String(rawAnswer || "").length > 0 && hasMore) {
      showMore?.();
      return { redraw: true };
    }
    return { done: true, sessionId: "" };
  }
  if (lower === "q" || lower === "quit") return { done: true, sessionId: "" };
  if (lower === "more" || lower === "m" || lower === "n" || lower === "next" || lower === "+") {
    if (hasMore) {
      showMore?.();
      return { redraw: true };
    }
    write?.("All matching sessions are already shown.");
    return { redraw: false };
  }
  if (lower === "all") {
    showAll?.();
    return { redraw: true };
  }
  if (answer.startsWith("/")) {
    setFilter?.(answer.slice(1).trim());
    return { redraw: true };
  }
  const index = Number(answer) - 1;
  if (Number.isInteger(index) && index >= 0 && index < visibleCount) {
    return { done: true, sessionId: filtered[index]?.sessionId || "" };
  }
  return {
    redraw: true,
    message: hasMore
      ? "Invalid selection. Type a shown number, press Space or PageDown to show more, /text to filter, or q to quit."
      : "Invalid selection. Type a shown number, /text to filter, or q to quit.",
  };
}

async function promptSelectSession(sessions, { allSessions = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return sessions[0]?.sessionId || "";
  if (!process.stdin.setRawMode) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let filterText = "";
    let maxShown = RESUME_SESSION_PAGE_SIZE;
    try {
      while (true) {
        const filtered = filterSessions(sessions, filterText);
        const visibleCount = Math.min(filtered.length, maxShown);
        const hasMore = filtered.length > visibleCount;
        printSessionChoices(filtered, { filterText, allSessions, maxShown });
        const rawAnswer = await rl.question(hasMore ? "Session number/filter/space-more: " : "Session number/filter: ");
        const selected = handleResumeSelectorAnswer(rawAnswer, {
          filtered,
          visibleCount,
          hasMore,
          setFilter: (value) => {
            filterText = value;
            maxShown = RESUME_SESSION_PAGE_SIZE;
          },
          showMore: () => {
            maxShown = Math.min(filtered.length, maxShown + RESUME_SESSION_PAGE_SIZE);
          },
          showAll: () => {
            maxShown = filtered.length;
          },
          write: (message) => console.log(message),
        });
        if (selected.done) return selected.sessionId || "";
      }
    } finally {
      rl.close();
    }
  }

  let filterText = "";
  let maxShown = RESUME_SESSION_PAGE_SIZE;
  let buffer = "";
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;

  return new Promise((resolve) => {
    const cleanup = (sessionId = "") => {
      input.off("keypress", onKeypress);
      if (input.setRawMode) input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write("\n");
      resolve(sessionId || "");
    };
    const writePrompt = () => {
      const filtered = filterSessions(sessions, filterText);
      const visibleCount = Math.min(filtered.length, maxShown);
      const hasMore = filtered.length > visibleCount;
      printSessionChoices(filtered, { filterText, allSessions, maxShown });
      output.write(hasMore ? "Session number/filter/space-more: " : "Session number/filter: ");
    };
    const redraw = (message = "") => {
      buffer = "";
      output.write("\n");
      if (message) output.write(`${message}\n`);
      writePrompt();
    };
    const submit = (rawAnswer = "") => {
      const filtered = filterSessions(sessions, filterText);
      const visibleCount = Math.min(filtered.length, maxShown);
      const hasMore = filtered.length > visibleCount;
      const selected = handleResumeSelectorAnswer(rawAnswer, {
        filtered,
        visibleCount,
        hasMore,
        setFilter: (value) => {
          filterText = value;
          maxShown = RESUME_SESSION_PAGE_SIZE;
        },
        showMore: () => {
          maxShown = Math.min(filtered.length, maxShown + RESUME_SESSION_PAGE_SIZE);
        },
        showAll: () => {
          maxShown = filtered.length;
        },
        write: (message) => redraw(message),
      });
      if (selected.done) return cleanup(selected.sessionId || "");
      if (selected.redraw) return redraw(selected.message || "");
      return undefined;
    };
    function onKeypress(char, key = {}) {
      if (key.ctrl && key.name === "c") return cleanup("");
      const name = key.name || char;
      const filtered = filterSessions(sessions, filterText);
      const hasMore = filtered.length > Math.min(filtered.length, maxShown);
      if ((name === "space" || name === "pagedown") && !buffer) {
        if (hasMore) {
          maxShown = Math.min(filtered.length, maxShown + RESUME_SESSION_PAGE_SIZE);
          return redraw();
        }
        return undefined;
      }
      if ((name === "q" || name === "escape") && !buffer) return cleanup("");
      if (name === "return" || name === "enter") {
        output.write("\n");
        const rawAnswer = buffer;
        buffer = "";
        return submit(rawAnswer);
      }
      if (name === "backspace" || name === "delete") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          output.write("\b \b");
        }
        return undefined;
      }
      if (char && !key.ctrl && !key.meta && char >= " ") {
        buffer += char;
        output.write(char);
      }
      return undefined;
    }
    readlineRaw.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    writePrompt();
  });
}

async function resolveResumeSessionId(sessionId, { allSessions = false } = {}) {
  if (sessionId && sessionId !== "latest") return sessionId;
  const sessions = await listProjectSessions(process.cwd(), { limit: 1000, allSessions });
  if (sessionId === "latest" || sessions.length <= 1 || !process.stdin.isTTY || !process.stdout.isTTY) {
    if (sessions[0]?.sessionId) return sessions[0].sessionId;
  } else {
    const selected = await promptSelectSession(sessions, { allSessions });
    if (selected) return selected;
    return "";
  }
  throw new Error(allSessions ? "No sessions found." : "No sessions found for this cwd. Use `aginti resume --all-sessions` to browse all sessions.");
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

  if (argv[0] === "update" || argv[0] === "upgrade") {
    const updateResult = await maybeAutoUpdate({
      argv,
      force: true,
      manual: true,
      packageDir,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      restart: false,
    });
    if (updateResult.error) process.exit(1);
    return;
  }

  const autoUpdateResult = await maybeAutoUpdate({
    argv,
    force: argv.includes("--auto-update"),
    packageDir,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    restart: true,
  });
  if (autoUpdateResult.restarted) process.exit(autoUpdateResult.exitCode ?? 0);

  const stripped = stripLeadingGlobalOptions(argv);
  const commandArgv = stripped.argv;
  const commandCwd = stripped.options.commandCwd || process.cwd();
  const resumeCommand = splitResumeCommandArgv(commandArgv);

  if (commandArgv[0] === "aaps") {
    try {
      await handleAapsCliCommand(commandArgv.slice(1), { cwd: commandCwd, packageDir });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    return;
  }

  if (commandArgv.includes("--remove-empty-sessions") || commandArgv[0] === "remove-empty-sessions") {
    await handleRemoveSessionsCommand({ emptyOnly: true });
    return;
  }

  if (commandArgv.includes("--remove-sessions") || commandArgv[0] === "remove-sessions") {
    await handleRemoveSessionsCommand({ emptyOnly: false });
    return;
  }

  if (commandArgv[0] === "init") {
    const initOptions = parseInitOptions(commandArgv.slice(1));
    if (initOptions.list) {
      console.log(formatInstructionTemplateList());
      return;
    }
    printInitResult(await initProject(commandCwd, { template: initOptions.template }));
    return;
  }

  if (commandArgv[0] === "doctor") {
    const parsed = parseArgs(commandArgv.slice(1).filter((arg) => arg !== "--json" && arg !== "--capabilities"));
    exitOnUnknownOptions(parsed);
    const config = loadConfig(
      {
        ...parsed,
        goal: "doctor",
        commandCwd,
        allowShellTool: parsed.allowShellTool ?? true,
        allowFileTools: parsed.allowFileTools ?? true,
      },
      { packageDir, baseDir: commandCwd }
    );
    const report = commandArgv.includes("--capabilities")
      ? await buildCapabilityReport(commandCwd, packageJson.version, config)
      : await doctorReport(commandCwd, packageJson.version, config);
    if (commandArgv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else if (commandArgv.includes("--capabilities")) printCapabilityReport(report);
    else printDoctorReport(report);
    return;
  }

  if (commandArgv[0] === "capabilities") {
    const parsed = parseArgs(commandArgv.slice(1).filter((arg) => arg !== "--json"));
    exitOnUnknownOptions(parsed);
    const config = loadConfig(
      {
        ...parsed,
        goal: "capabilities",
        commandCwd,
        allowShellTool: parsed.allowShellTool ?? true,
        allowFileTools: parsed.allowFileTools ?? true,
      },
      { packageDir, baseDir: commandCwd }
    );
    const report = await buildCapabilityReport(commandCwd, packageJson.version, config);
    if (commandArgv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else printCapabilityReport(report);
    return;
  }

  if (commandArgv[0] === "housekeeping" || commandArgv[0] === "housekeeper") {
    await printHousekeeping(commandArgv.slice(1));
    return;
  }

  if (commandArgv[0] === "skillmesh" || commandArgv[0] === "skillsync" || commandArgv[0] === "skill-sync" || commandArgv[0] === "skill-share") {
    try {
      await handleSkillMeshCommand(commandArgv.slice(1));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    return;
  }

  if (commandArgv[0] === "keys/status") {
    await handleKeyCommand(["status"]);
    return;
  }

  if (commandArgv[0] === "keys") {
    await handleKeyCommand(commandArgv.slice(1));
    return;
  }

  if (commandArgv[0] === "auth" || commandArgv[0] === "login") {
    const provider = normalizeAuthProvider(commandArgv[1] || "", "");
    if (commandArgv[0] === "auth" || (!provider && process.stdin.isTTY)) {
      const result = await runAuthWizard(commandCwd, { provider });
      printAuthWizardResult(result);
      return;
    }
    const target = provider || "deepseek";
    const key = commandArgv.includes("--stdin") || !process.stdin.isTTY
      ? await readStdin()
      : await promptHidden(`${providerLabel(target)} API key/token: `);
    if (!key) {
      console.error("No key saved.");
      process.exit(1);
    }
    const result = await setProviderKey(commandCwd, target, key);
    console.log(`saved ${result.provider} key to project-local ignored env (${result.keyName})`);
    return;
  }

  if (commandArgv[0] === "sessions") {
    await handleSessionsCommand(commandArgv.slice(1));
    return;
  }

  if (commandArgv[0] === "storage") {
    await handleStorageCommand(commandArgv.slice(1));
    return;
  }

  if (commandArgv[0] === "models" || commandArgv[0] === "model") {
    printModels();
    return;
  }

  if (commandArgv[0] === "skills" || commandArgv[0] === "skill") {
    printSkills(commandArgv.slice(1).join(" ").trim());
    return;
  }

  if (commandArgv[0] === "queue") {
    await handleQueueCommand(commandArgv.slice(1));
    return;
  }

  if (resumeCommand) {
    const resumeOptions = parseResumeCommandArgs(resumeCommand.resumeArgv, resumeCommand.leadingOptionArgv);
    if (resumeOptions.unknownOptions?.length) {
      printUnknownCliOptions(resumeOptions.unknownOptions);
      process.exit(1);
    }
    let sessionId = resumeOptions.sessionId;
    const prompt = resumeOptions.prompt;
    try {
      sessionId = await resolveResumeSessionId(sessionId, { allSessions: resumeOptions.allSessions });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    if (!sessionId) return;
    if (!prompt) {
      const parsedResumeOptions = parseArgs(resumeOptions.optionArgv);
      exitOnUnknownOptions(parsedResumeOptions);
      await startInteractiveCli(agentDefaults({ ...parsedResumeOptions, resume: sessionId, commandCwd }), {
        packageDir,
        packageVersion: packageJson.version,
      });
      return;
    }
    const parsedResumeArgs = parseArgs([...resumeOptions.optionArgv, prompt]);
    exitOnUnknownOptions(parsedResumeArgs);
    const resumeArgs = agentDefaults({ ...parsedResumeArgs, resume: sessionId, goal: prompt, commandCwd });
    if (!(await ensureDeepSeekKeyForOneShot(resumeArgs))) process.exit(1);
    const config = loadConfig(resumeArgs, { packageDir });
    await runAgent(config);
    return;
  }

  const args = { ...parseArgs(commandArgv), commandCwd };
  exitOnUnknownOptions(args);

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
