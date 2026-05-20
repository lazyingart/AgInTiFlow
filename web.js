import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./src/agent-runner.js";
import { resolveRuntimeConfig } from "./src/config.js";
import { WebDatabase } from "./src/web-db.js";
import { SessionStore } from "./src/session-store.js";
import {
  AUXILIARY_MODEL_CATALOG,
  MODEL_PROVIDER_GROUPS,
  PROVIDER_MODEL_CATALOG,
  getModelPresets,
  getModelRoleDefaults,
  getProviderDefaults,
  normalizeRoutingMode,
} from "./src/model-routing.js";
import { listAgentWrappers, normalizeWrapperName } from "./src/tool-wrappers.js";
import { getDockerSandboxStatus, getSandboxLogs, runDockerPreflight } from "./src/docker-sandbox.js";
import { normalizePackageInstallPolicy, normalizeSandboxMode } from "./src/command-policy.js";
import { summarizeWorkspaceTools, WORKSPACE_TOOL_NAMES } from "./src/workspace-tools.js";
import { listTaskProfiles, normalizeTaskProfile } from "./src/task-profiles.js";
import {
  applyPermissionMode,
  normalizePermissionMode,
  permissionModeForApprovalCategory,
} from "./src/permission-modes.js";
import { normalizeScsMode } from "./src/scs-controller.js";
import { normalizeDynamicStepsMode } from "./src/step-budget-controller.js";
import {
  ensureProjectSessionStorage,
  listProjectSessions,
  loadProjectEnv,
  projectPaths,
  providerKeyStatus,
  renameProjectSession,
  setProviderKey,
} from "./src/project.js";
import { buildCapabilityReport } from "./src/capabilities.js";
import { listExternalSkillPacks, listSkills } from "./src/skill-library.js";
import { platformInfo, platformLabel, platformSetupHints } from "./src/platform.js";
import { normalizeLanguage } from "./src/i18n.js";
import { summarizeMcpConfig } from "./src/mcp/config.js";
import { mcpCliCommand } from "./src/mcp/tool-bridge.js";
import {
  buildArtifacts,
  countUnreadArtifacts,
  findArtifact,
  readArtifactContent,
  resolveArtifactFile,
  serializeArtifacts,
} from "./src/artifact-tunnel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = __dirname;
const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
const baseDir = path.resolve(process.env.AGINTIFLOW_RUNTIME_DIR || process.cwd());
const storagePaths = projectPaths(baseDir);
const sessionsDir = storagePaths.globalSessionsDir;
const projectSessionsDir = storagePaths.sessionsDir;
loadProjectEnv(baseDir);
await ensureProjectSessionStorage(baseDir);

const app = express();
let port = Number(process.env.PORT || 3210);
const host = process.env.HOST || "127.0.0.1";
const runs = new Map();
const db = new WebDatabase(baseDir);

function sessionStore(sessionId) {
  return new SessionStore(sessionsDir, sessionId, {
    projectRoot: baseDir,
    projectSessionsDir,
    legacySessionDir: path.join(storagePaths.legacySessionsDir, sessionId),
  });
}

function isSafeSessionId(sessionId) {
  return /^[A-Za-z0-9._:-]+$/.test(String(sessionId || "")) && !String(sessionId || "").includes("..");
}

function safeDownloadFilename(value) {
  const basename = path.basename(String(value || "artifact").replace(/\\/g, "/"));
  return (
    basename
      .replace(/[\r\n"\\]+/g, "_")
      .replace(/^\.+/, "")
      .replace(/[^A-Za-z0-9._ -]+/g, "-")
      .slice(0, 120) || "artifact"
  );
}

function mapEventLogs(events) {
  return events.map((event) => ({
    at: event.timestamp,
    kind: "event",
    message: event.type,
    data: event.data || {},
  }));
}

function compactText(value = "", limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(limit - 1, 1)).trim()}...`;
}

function normalizedTimelineText(value = "") {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function timelineTextFingerprint(value = "") {
  return normalizedTimelineText(value).replace(/\s+/g, " ").trim();
}

function embeddedWorkspaceChangesFromText(value = "") {
  const lines = String(value || "").split(/\r?\n/);
  const changes = [];
  let currentTool = "";

  for (let index = 0; index < lines.length; index += 1) {
    const toolMatch = lines[index].match(/^\s*Tool:\s*(.+?)\s*$/i);
    if (toolMatch) {
      currentTool = toolMatch[1].trim();
      continue;
    }

    const pathMatch = lines[index].match(/^\s*Path:\s*(.+?)\s*$/i);
    if (!pathMatch) continue;

    let cursor = index + 1;
    while (cursor < lines.length && !/^\s*Diff:\s*$/i.test(lines[cursor]) && !/^\s*(?:Tool|Path):\s*/i.test(lines[cursor])) {
      cursor += 1;
    }
    if (!/^\s*Diff:\s*$/i.test(lines[cursor] || "")) continue;

    const diffLines = [];
    cursor += 1;
    while (cursor < lines.length) {
      if (diffLines.length && /^\s*(?:Tool|Path):\s*/i.test(lines[cursor])) break;
      if (
        diffLines.length &&
        /^\s*(?:Output:|No command output|Blocked by guardrail\.|Mock run complete\.)/i.test(lines[cursor]) &&
        !/^[-+@ ]/.test(lines[cursor])
      ) {
        break;
      }
      diffLines.push(lines[cursor]);
      cursor += 1;
    }
    while (diffLines.length && !diffLines[diffLines.length - 1].trim()) diffLines.pop();
    if (diffLines.length) {
      changes.push({
        toolName: currentTool || "write_file",
        path: pathMatch[1].trim(),
        diff: diffLines.join("\n"),
      });
      index = Math.max(index, cursor - 1);
    }
  }

  return changes;
}

function workspaceChangeFingerprint(change = {}) {
  const pathKey = String(change.path || change.args?.path || "").replace(/\\/g, "/").trim();
  const diffKey = normalizedTimelineText(change.diff || "");
  return pathKey || diffKey ? `${pathKey}\n${diffKey}` : "";
}

function eventWorkspaceChangeFingerprint(event = {}) {
  const data = event.data || {};
  if (event.type === "file.changed") return workspaceChangeFingerprint(data);
  if ((event.type === "tool.completed" || event.type === "tool.failed") && data.diff) return workspaceChangeFingerprint(data);
  return "";
}

function eventWorkspaceChangePath(event = {}) {
  const data = event.data || {};
  if (event.type !== "file.changed" && !data.diff) return "";
  return String(data.path || data.args?.path || "").replace(/\\/g, "/").trim();
}

function toolLifecycleKey(event = {}) {
  const data = event.data || {};
  const args = data.args || {};
  const focusedArgs = {
    path: args.path || args.file || data.path || "",
    command: args.command || data.command || "",
    title: args.title || data.title || "",
    kind: args.kind || data.kind || "",
    query: args.query || args.q || "",
    url: args.url || data.url || "",
  };
  return `${data.toolName || ""}:${JSON.stringify(focusedArgs)}`;
}

function shouldSuppressTimelineEvent(event = {}, context = {}) {
  const type = String(event.type || "");
  const data = event.data || {};
  const toolName = String(data.toolName || "");
  const resultFingerprint = timelineTextFingerprint(data.result || data.args?.result || "");

  if (type === "tool.started" && context.terminalToolKeys.has(toolLifecycleKey(event))) return true;
  if (type === "tool.started" && toolName === "finish" && resultFingerprint) {
    return context.chatResultFingerprints.has(resultFingerprint) || context.finishResultFingerprints.has(resultFingerprint);
  }

  if (["tool.completed", "tool.failed", "tool.skipped"].includes(type)) {
    if (toolName === "finish" && resultFingerprint && context.chatResultFingerprints.has(resultFingerprint)) return true;
    if (["write_file", "apply_patch"].includes(toolName)) {
      const pathKey = String(data.path || data.args?.path || data.args?.file || "").replace(/\\/g, "/").trim();
      if (pathKey && context.workspaceChangePaths.has(pathKey)) return true;
      const changeKey = eventWorkspaceChangeFingerprint(event);
      if (changeKey && context.workspaceChangeKeys.has(changeKey)) return true;
    }
  }

  if (type === "session.finished" && resultFingerprint) {
    return context.chatResultFingerprints.has(resultFingerprint) || context.finishResultFingerprints.has(resultFingerprint);
  }

  return false;
}

function toolTimelineSummary(data = {}) {
  const tool = data.toolName || "unknown";
  const args = data.args || {};
  if (tool === "run_command" && args.command) return `${tool}: ${compactText(args.command, 92)}`;
  if ((tool === "write_file" || tool === "apply_patch" || tool === "read_file" || tool === "open_workspace_file") && args.path) {
    return `${tool}: ${compactText(args.path, 92)}`;
  }
  if ((tool === "open_url" || tool === "web_research" || tool === "web_search") && (args.url || args.query || args.q)) {
    return `${tool}: ${compactText(args.url || args.query || args.q, 92)}`;
  }
  return tool;
}

function timelineEntryForEvent(event = {}) {
  const type = String(event.type || "");
  const data = event.data || {};
  const at = event.timestamp || "";
  if (type === "plan.created" && data.plan) {
    return {
      role: "event",
      eventType: type,
      eventLabel: "plan",
      data,
      content: data.plan,
      markdown: true,
      at,
    };
  }
  if (type === "tool.started") {
    return {
      role: "event",
      eventType: type,
      eventLabel: "tool",
      data,
      content: toolTimelineSummary(data),
      at,
    };
  }
  if (type === "tool.completed" || type === "tool.failed" || type === "tool.skipped") {
    const failed = type === "tool.failed" || data.ok === false || data.blocked || data.error;
    const stdout = data.toolName === "run_command" && data.stdout ? `\nstdout: ${compactText(data.stdout, 180)}` : "";
    const stderr = data.toolName === "run_command" && data.stderr ? `\nstderr: ${compactText(data.stderr, 180)}` : "";
    return {
      role: "event",
      eventType: type,
      eventLabel: failed ? "tool failed" : "tool done",
      data,
      content: `${toolTimelineSummary(data)}${stdout}${stderr}`,
      at,
    };
  }
  if (type === "tool.blocked") {
    return {
      role: "event",
      eventType: type,
      eventLabel: "permission",
      data,
      content: data.permissionAdvice?.summary || data.reason || data.toolName || "Permission blocked.",
      at,
    };
  }
  if (type === "file.changed") {
    return {
      role: "event",
      eventType: type,
      eventLabel: data.toolName === "apply_patch" ? "patch" : "write",
      data,
      content: [data.toolName || data.action || "file.changed", data.path || "", data.created ? "created" : "updated"]
        .filter(Boolean)
        .join(" "),
      at,
    };
  }
  if (type === "budget.initialized") {
    return {
      role: "event",
      eventType: type,
      eventLabel: "budget",
      data,
      content: `${data.currentMaxSteps || data.initialMaxSteps || data.maxSteps || "unknown"} steps`,
      at,
    };
  }
  if (type === "conversation.continued") {
    return {
      role: "event",
      eventType: type,
      eventLabel: "continued",
      data,
      content: data.prompt || "",
      at,
    };
  }
  if (type === "conversation.queued_input_applied") {
    return {
      role: "event",
      eventType: type,
      eventLabel: "queued input",
      data,
      content: data.priority === "asap" ? "ASAP queued input applied" : "Queued input applied",
      at,
    };
  }
  if (type === "session.finished" || type === "session.failed" || type === "session.stopped") {
    return {
      role: "event",
      eventType: type,
      eventLabel: type.replace("session.", ""),
      data,
      content: data.result || data.error || data.reason || type,
      at,
    };
  }
  return null;
}

function sessionTimelineFromChatAndEvents(chat = [], events = []) {
  const eventList = Array.isArray(events) ? events : [];
  const workspaceChangeKeys = new Set(eventList.map(eventWorkspaceChangeFingerprint).filter(Boolean));
  const workspaceChangePaths = new Set(eventList.map(eventWorkspaceChangePath).filter(Boolean));
  const chatResultFingerprints = new Set(
    (Array.isArray(chat) ? chat : [])
      .filter((entry) => entry?.role === "assistant" && entry?.content)
      .map((entry) => timelineTextFingerprint(entry.content))
      .filter(Boolean)
  );
  const finishResultFingerprints = new Set(
    eventList
      .filter((event) => (event.type === "tool.completed" && event.data?.toolName === "finish") || event.type === "session.finished")
      .map((event) => timelineTextFingerprint(event.data?.result || ""))
      .filter(Boolean)
  );
  const terminalToolKeys = new Set(
    eventList
      .filter((event) => ["tool.completed", "tool.failed", "tool.skipped", "tool.blocked"].includes(event.type))
      .map(toolLifecycleKey)
      .filter(Boolean)
  );
  const suppressContext = {
    chatResultFingerprints,
    finishResultFingerprints,
    terminalToolKeys,
    workspaceChangeKeys,
    workspaceChangePaths,
  };
  const chatItems = (Array.isArray(chat) ? chat : [])
    .filter((entry) => entry?.content)
    .map((entry, index) => {
      const embeddedChanges = entry.role === "assistant" ? embeddedWorkspaceChangesFromText(entry.content) : [];
      const suppressEmbeddedWorkspaceDiffs =
        embeddedChanges.length > 0 && embeddedChanges.every((change) => workspaceChangeKeys.has(workspaceChangeFingerprint(change)));
      return { ...entry, suppressEmbeddedWorkspaceDiffs, order: index * 2, sortAt: Date.parse(entry.at || "") || 0 };
    });
  const eventItems = eventList
    .filter((event) => !shouldSuppressTimelineEvent(event, suppressContext))
    .map(timelineEntryForEvent)
    .filter(Boolean)
    .map((entry, index) => ({ ...entry, order: index * 2 + 1, sortAt: Date.parse(entry.at || "") || 0 }));
  return [...chatItems, ...eventItems]
    .sort((left, right) => (left.sortAt || 0) - (right.sortAt || 0) || left.order - right.order)
    .map(({ sortAt: _sortAt, order: _order, ...entry }) => entry);
}

async function loadStoredRun(sessionId) {
  const meta = db.getSession(sessionId);
  if (!meta) return null;

  const store = sessionStore(sessionId);
  const events = await store.loadEvents();
  const terminalEvent = [...events]
    .reverse()
    .find((event) => ["session.finished", "session.failed", "session.stopped"].includes(event.type));
  const orphanedRunning = meta.status === "running" && !runs.has(sessionId);
  const reconciled = { ...meta };

  if (orphanedRunning && terminalEvent) {
    reconciled.status =
      terminalEvent.type === "session.finished" ? "finished" : terminalEvent.type === "session.failed" ? "failed" : "stopped";
    reconciled.endedAt = reconciled.endedAt || terminalEvent.timestamp || new Date().toISOString();
    reconciled.updatedAt = terminalEvent.timestamp || reconciled.updatedAt || reconciled.endedAt;
    reconciled.result =
      reconciled.status === "finished" ? String(terminalEvent.data?.result || reconciled.result || "") : reconciled.result || "";
    reconciled.error =
      reconciled.status === "failed"
        ? String(terminalEvent.data?.error || terminalEvent.data?.reason || reconciled.error || "Run failed.")
        : reconciled.status === "stopped"
          ? String(terminalEvent.data?.reason || reconciled.error || "Run stopped.")
          : reconciled.error || "";
    db.upsertSession(reconciled);
  } else if (orphanedRunning) {
    reconciled.status = "stopped";
    reconciled.endedAt = reconciled.endedAt || new Date().toISOString();
    reconciled.updatedAt = reconciled.endedAt;
    reconciled.error =
      reconciled.error ||
      "Run is not active in this web process. It may have ended before the web server restarted.";
    db.upsertSession(reconciled);
  }

  return {
    sessionId: reconciled.sessionId,
    status: reconciled.status,
    provider: reconciled.provider,
    model: reconciled.model,
    goal: reconciled.goal,
    title: reconciled.title || "",
    startedAt: reconciled.startedAt,
    endedAt: reconciled.endedAt || null,
    result: reconciled.result || "",
    error: reconciled.error || "",
    logs: mapEventLogs(events).slice(-300),
  };
}

function serializeRun(run) {
  return {
    sessionId: run.sessionId,
    status: run.status,
    provider: run.provider,
    model: run.model,
    goal: run.goal,
    title: run.title || "",
    startedAt: run.startedAt,
    endedAt: run.endedAt || null,
    result: run.result || "",
    error: run.error || "",
    logs: run.logs.slice(-300),
  };
}

function normalizePreferencePayload(body = {}, current = db.getPreferences()) {
  const modelPresets = getModelPresets();
  const modelRoles = getModelRoleDefaults();
  const providerCandidate = body.provider || current.provider || "deepseek";
  const provider = ["openai", "deepseek", "qwen", "venice", "mock"].includes(providerCandidate) ? providerCandidate : "deepseek";
  const routingMode =
    provider === "mock" ? "manual" : normalizeRoutingMode(body.routingMode || current.routingMode || "smart");
  const providerDefaults = getProviderDefaults(provider);
  const parsedMaxSteps = Number(body.maxSteps);
  const parsedWrapperTimeoutMs = Number(body.wrapperTimeoutMs);
  const parsedParallelScoutCount = Number(body.parallelScoutCount);
  const permissionMode = normalizePermissionMode(body.permissionMode || current.permissionMode || "normal");
  const permissionDefaults = applyPermissionMode({}, permissionMode, { override: true });
  const bodyHasExplicitRuntime =
    body.sandboxMode !== undefined ||
    body.packageInstallPolicy !== undefined ||
    body.workspaceWritePolicy !== undefined ||
    body.allowPasswords !== undefined ||
    body.allowDestructive !== undefined ||
    body.allowOutsideWorkspaceFileTools !== undefined;
  const currentModeChanged = permissionMode !== normalizePermissionMode(current.permissionMode || "normal");
  const sandboxMode = normalizeSandboxMode(
    bodyHasExplicitRuntime && !currentModeChanged
      ? body.sandboxMode || current.sandboxMode || permissionDefaults.sandboxMode
      : permissionDefaults.sandboxMode
  );

  return {
    routingMode,
    provider,
    model:
      typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : current.provider !== provider
          ? providerDefaults.model
          : current.model || modelPresets.fast.model || providerDefaults.model,
    routeProvider:
      typeof body.routeProvider === "string" && body.routeProvider.trim()
        ? body.routeProvider.trim()
        : current.routeProvider || modelRoles.route.provider,
    routeModel:
      typeof body.routeModel === "string" && body.routeModel.trim()
        ? body.routeModel.trim()
        : current.routeModel || modelRoles.route.model,
    mainProvider:
      typeof body.mainProvider === "string" && body.mainProvider.trim()
        ? body.mainProvider.trim()
        : current.mainProvider || modelRoles.main.provider,
    mainModel:
      typeof body.mainModel === "string" && body.mainModel.trim()
        ? body.mainModel.trim()
        : current.mainModel || modelRoles.main.model,
    spareProvider:
      typeof body.spareProvider === "string" && body.spareProvider.trim()
        ? body.spareProvider.trim()
        : current.spareProvider || modelRoles.spare.provider,
    spareModel:
      typeof body.spareModel === "string" && body.spareModel.trim()
        ? body.spareModel.trim()
        : current.spareModel || modelRoles.spare.model,
    spareReasoning:
      typeof body.spareReasoning === "string" && body.spareReasoning.trim()
        ? body.spareReasoning.trim()
        : current.spareReasoning || modelRoles.spare.reasoning,
    wrapperModel:
      typeof body.wrapperModel === "string" && body.wrapperModel.trim()
        ? body.wrapperModel.trim()
        : current.wrapperModel || modelRoles.wrapper.model,
    wrapperReasoning:
      typeof body.wrapperReasoning === "string" && body.wrapperReasoning.trim()
        ? body.wrapperReasoning.trim()
        : current.wrapperReasoning || modelRoles.wrapper.reasoning,
    auxiliaryProvider:
      typeof body.auxiliaryProvider === "string" && body.auxiliaryProvider.trim()
        ? body.auxiliaryProvider.trim()
        : current.auxiliaryProvider || modelRoles.auxiliary.provider,
    auxiliaryModel:
      typeof body.auxiliaryModel === "string" && body.auxiliaryModel.trim()
        ? body.auxiliaryModel.trim()
        : current.auxiliaryModel || modelRoles.auxiliary.model,
    headless: typeof body.headless === "boolean" ? body.headless : Boolean(current.headless),
    maxSteps: Number.isFinite(parsedMaxSteps) && parsedMaxSteps > 0 ? parsedMaxSteps : Number(current.maxSteps) || 24,
    startUrl: typeof body.startUrl === "string" ? body.startUrl.trim() : current.startUrl || "",
    allowedDomains:
      typeof body.allowedDomains === "string" ? body.allowedDomains.trim() : current.allowedDomains || "",
    commandCwd:
      typeof body.commandCwd === "string" && body.commandCwd.trim()
        ? body.commandCwd.trim()
        : current.commandCwd || baseDir,
    taskProfile: normalizeTaskProfile(body.taskProfile || current.taskProfile || "auto"),
    permissionMode,
    allowShellTool:
      typeof body.allowShellTool === "boolean" && !currentModeChanged
        ? body.allowShellTool
        : currentModeChanged
          ? permissionDefaults.allowShellTool
          : Boolean(current.allowShellTool),
    allowFileTools:
      typeof body.allowFileTools === "boolean" && !currentModeChanged
        ? body.allowFileTools
        : currentModeChanged
          ? permissionDefaults.allowFileTools
          : current.allowFileTools !== false,
    allowAuxiliaryTools:
      typeof body.allowAuxiliaryTools === "boolean" ? body.allowAuxiliaryTools : current.allowAuxiliaryTools !== false,
    allowWebSearch:
      typeof body.allowWebSearch === "boolean" ? body.allowWebSearch : current.allowWebSearch !== false,
    allowMcpTools:
      typeof body.allowMcpTools === "boolean" ? body.allowMcpTools : current.allowMcpTools !== false,
    allowParallelScouts:
      typeof body.allowParallelScouts === "boolean" ? body.allowParallelScouts : current.allowParallelScouts !== false,
    enableScs: normalizeScsMode(body.enableScs || current.enableScs || process.env.AGINTI_SCS_MODE || "on"),
    dynamicSteps: normalizeDynamicStepsMode(body.dynamicSteps || current.dynamicSteps || process.env.AGINTI_DYNAMIC_STEPS || "auto"),
    veniceMode: typeof body.veniceMode === "boolean" ? body.veniceMode : current.veniceMode === true,
    parallelScoutCount:
      Number.isFinite(parsedParallelScoutCount) && parsedParallelScoutCount > 0
        ? Math.min(Math.max(parsedParallelScoutCount, 1), 10)
        : Number(current.parallelScoutCount) || 3,
    allowWrapperTools:
      typeof body.allowWrapperTools === "boolean" ? body.allowWrapperTools : Boolean(current.allowWrapperTools),
    preferredWrapper: normalizeWrapperName(body.preferredWrapper || current.preferredWrapper || "codex"),
    wrapperTimeoutMs:
      Number.isFinite(parsedWrapperTimeoutMs) && parsedWrapperTimeoutMs >= 10000
        ? parsedWrapperTimeoutMs
        : Number(current.wrapperTimeoutMs) || 120000,
    useDockerSandbox:
      sandboxMode !== "host"
        ? true
        : typeof body.useDockerSandbox === "boolean"
          ? body.useDockerSandbox
          : Boolean(current.useDockerSandbox),
    sandboxMode,
    packageInstallPolicy: normalizePackageInstallPolicy(
      bodyHasExplicitRuntime && !currentModeChanged
        ? body.packageInstallPolicy || current.packageInstallPolicy || permissionDefaults.packageInstallPolicy
        : permissionDefaults.packageInstallPolicy
    ),
    workspaceWritePolicy:
      bodyHasExplicitRuntime && !currentModeChanged
        ? body.workspaceWritePolicy || current.workspaceWritePolicy || permissionDefaults.workspaceWritePolicy
        : permissionDefaults.workspaceWritePolicy,
    dockerSandboxImage:
      typeof body.dockerSandboxImage === "string" && body.dockerSandboxImage.trim()
        ? body.dockerSandboxImage.trim()
        : current.dockerSandboxImage || "agintiflow-sandbox:latest",
    allowPasswords:
      typeof body.allowPasswords === "boolean" && !currentModeChanged
        ? body.allowPasswords
        : currentModeChanged
          ? permissionDefaults.allowPasswords
          : Boolean(current.allowPasswords),
    allowDestructive:
      typeof body.allowDestructive === "boolean" && !currentModeChanged
        ? body.allowDestructive
        : currentModeChanged
          ? permissionDefaults.allowDestructive
          : Boolean(current.allowDestructive),
    allowOutsideWorkspaceFileTools:
      typeof body.allowOutsideWorkspaceFileTools === "boolean" && !currentModeChanged
        ? body.allowOutsideWorkspaceFileTools
        : currentModeChanged
          ? permissionDefaults.allowOutsideWorkspaceFileTools
          : Boolean(current.allowOutsideWorkspaceFileTools),
    language: normalizeLanguage(body.language || process.env.AGINTI_LANGUAGE || current.language, current.language || "en"),
  };
}

function publicProviderDefault(provider) {
  const defaults = getProviderDefaults(provider);
  return {
    provider: defaults.provider,
    model: defaults.model,
    baseURL: defaults.baseURL,
  };
}

function publicKeyStatus(projectRoot = baseDir) {
  const status = providerKeyStatus(projectRoot);
  return {
    openai: status.openai,
    deepseek: status.deepseek,
    qwen: status.qwen,
    venice: status.venice,
    grsai: status.grsai,
    mock: true,
    localEnv: status.localEnv,
    envVars: status.envVars,
  };
}

function expandUserPath(value = "") {
  const text = String(value || "").trim();
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function uniquePaths(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(expandUserPath(value));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

async function readableDirectory(value = "") {
  try {
    const stat = await fs.stat(value);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function directoryChildren(parent = "", prefix = "", limit = 20) {
  const entries = [];
  try {
    const dirents = await fs.readdir(parent, { withFileTypes: true });
    const normalizedPrefix = prefix.toLowerCase();
    for (const entry of dirents) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (normalizedPrefix && !entry.name.toLowerCase().startsWith(normalizedPrefix)) continue;
      entries.push(path.join(parent, entry.name));
      if (entries.length >= limit) break;
    }
  } catch {
    return [];
  }
  return entries.sort((left, right) => left.localeCompare(right));
}

async function pathSuggestions(query = "") {
  const raw = String(query || "").trim();
  const home = os.homedir();
  const projectsLfs = path.join(home, "ProjectsLFS");
  const baseCandidates = uniquePaths([
    baseDir,
    path.dirname(baseDir),
    process.cwd(),
    home,
    projectsLfs,
    path.join(home, "Documents"),
    path.join(home, "Desktop"),
  ]);
  const suggestions = [];
  for (const candidate of baseCandidates) {
    if (await readableDirectory(candidate)) suggestions.push(candidate);
  }

  if (raw) {
    const expanded = expandUserPath(raw);
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
    const parent = raw.endsWith("/") || raw.endsWith(path.sep) ? absolute : path.dirname(absolute);
    const prefix = raw.endsWith("/") || raw.endsWith(path.sep) ? "" : path.basename(absolute);
    suggestions.push(...(await directoryChildren(parent, prefix, 16)));
    for (const root of baseCandidates.slice(0, 5)) {
      suggestions.push(...(await directoryChildren(root, path.basename(expanded), 4)));
    }
  } else {
    for (const root of baseCandidates.slice(0, 4)) {
      suggestions.push(...(await directoryChildren(root, "", 4)));
    }
  }

  return uniquePaths(suggestions).slice(0, 20);
}

function buildRunConfig(body, overrides = {}) {
  const preferences = normalizePreferencePayload(body, db.getPreferences());
  const merged = {
    ...preferences,
    ...overrides,
  };

  return resolveRuntimeConfig(
    {
      goal: String(body.goal || "").trim(),
      startUrl: merged.startUrl || "",
      resume: overrides.resume || "",
      sessionId: overrides.sessionId || "",
    },
    {
      provider: merged.provider,
      model: merged.model || getProviderDefaults(merged.provider).model,
      routingMode: merged.routingMode,
      routeProvider: merged.routeProvider,
      routeModel: merged.routeModel,
      mainProvider: merged.mainProvider,
      mainModel: merged.mainModel,
      spareProvider: merged.spareProvider,
      spareModel: merged.spareModel,
      spareReasoning: merged.spareReasoning,
      wrapperModel: merged.wrapperModel,
      wrapperReasoning: merged.wrapperReasoning,
      auxiliaryProvider: merged.auxiliaryProvider,
      auxiliaryModel: merged.auxiliaryModel,
      headless: merged.headless,
      maxSteps: merged.maxSteps,
      allowedDomains: String(merged.allowedDomains || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      allowPasswords: merged.allowPasswords,
      allowDestructive: merged.allowDestructive,
      allowShellTool: merged.allowShellTool,
      allowFileTools: merged.allowFileTools,
      allowAuxiliaryTools: merged.allowAuxiliaryTools,
      allowWebSearch: merged.allowWebSearch,
      allowMcpTools: merged.allowMcpTools,
      allowParallelScouts: merged.allowParallelScouts,
      enableScs: merged.enableScs,
      dynamicSteps: merged.dynamicSteps,
      parallelScoutCount: merged.parallelScoutCount,
      allowWrapperTools: merged.allowWrapperTools,
      preferredWrapper: merged.preferredWrapper,
      wrapperTimeoutMs: merged.wrapperTimeoutMs,
      permissionMode: merged.permissionMode,
      sandboxMode: merged.sandboxMode,
      packageInstallPolicy: merged.packageInstallPolicy,
      workspaceWritePolicy: merged.workspaceWritePolicy,
      useDockerSandbox: merged.useDockerSandbox,
      allowOutsideWorkspaceFileTools: merged.allowOutsideWorkspaceFileTools,
      dockerSandboxImage: merged.dockerSandboxImage,
      commandCwd: merged.commandCwd,
      taskProfile: merged.taskProfile,
      language: merged.language,
      baseDir,
      packageDir,
      sessionId: overrides.sessionId,
    }
  );
}

function parseToolContent(message) {
  try {
    return JSON.parse(message.content);
  } catch {
    return null;
  }
}

function deriveSessionRecordFromState(state, existing = null) {
  const updatedAt = state.updatedAt || state.createdAt || existing?.updatedAt || new Date().toISOString();
  const finishMessage = [...(state.messages || [])]
    .reverse()
    .find((message) => message.role === "tool" && typeof message.content === "string");
  const finishPayload = finishMessage ? parseToolContent(finishMessage) : null;
  const status = finishPayload?.done ? "finished" : existing?.status && existing.status !== "running" ? existing.status : "saved";

  return {
    sessionId: state.sessionId,
    provider: state.provider || existing?.provider || "deepseek",
    model: state.model || existing?.model || getProviderDefaults(state.provider || existing?.provider || "deepseek").model,
    goal: state.goal || existing?.goal || "",
    title: state.title || existing?.title || "",
    commandCwd: state.commandCwd || existing?.commandCwd || baseDir,
    status,
    startedAt: state.createdAt || existing?.startedAt || new Date().toISOString(),
    updatedAt,
    endedAt: finishPayload?.done ? updatedAt : existing?.endedAt || null,
    result: finishPayload?.done ? String(finishPayload.result || "") : existing?.result || "",
    error: existing?.error || "",
  };
}

async function syncStoredSessions() {
  const sessions = await listProjectSessions(baseDir, 500);
  for (const session of sessions) {
    const store = sessionStore(session.sessionId);
    const state = await store.loadState();
    if (!state?.sessionId) continue;

    const existing = db.getSession(state.sessionId);
    db.upsertSession({
      ...deriveSessionRecordFromState(state, existing),
      projectRoot: baseDir,
      projectSessionsDir,
      sessionDir: store.sessionDir,
    });
  }
}

function deriveChatFromState(state, meta) {
  if (!state) {
    return meta?.goal
      ? [
          {
            role: "user",
            content: meta.goal,
            at: meta.startedAt || new Date().toISOString(),
          },
        ]
      : [];
  }

  if (Array.isArray(state.chat) && state.chat.length > 0) {
    return state.chat;
  }

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
      // Best-effort fallback only.
    }
  }

  return chat;
}

async function loadChat(sessionId) {
  const store = sessionStore(sessionId);
  const [state, meta, events] = await Promise.all([
    store.loadState(),
    Promise.resolve(db.getSession(sessionId)),
    store.loadEvents().catch(() => []),
  ]);

  if (!state && !meta) return null;

  const inbox = await store.loadInbox().catch(() => []);
  const chat = deriveChatFromState(state, meta);
  return {
    sessionId,
    goal: state?.goal || meta?.goal || "",
    title: meta?.title || "",
    provider: state?.provider || meta?.provider || "",
    model: state?.model || meta?.model || "",
    status: meta?.status || "",
    inbox,
    chat,
    events: events.slice(-120),
    timeline: sessionTimelineFromChatAndEvents(chat, events).slice(-220),
  };
}

function pushActiveInboxLog(sessionId, message, data = {}) {
  const active = runs.get(sessionId);
  if (active?.status !== "running") return;
  active.logs.push({
    at: new Date().toISOString(),
    kind: "event",
    message,
    data,
  });
  active.updatedAt = new Date().toISOString();
  db.upsertSession(active);
}

async function loadInboxSession(sessionId) {
  if (!isSafeSessionId(sessionId)) {
    return { error: "Invalid session id.", status: 400 };
  }

  const data = await loadChat(sessionId);
  if (!data) {
    return { error: "Session not found.", status: 404 };
  }

  return { store: sessionStore(sessionId), data };
}

function queuedMessagePreview(content) {
  return String(content || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function normalizeSessionTitle(title) {
  return String(title || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function autoSessionTitleFromChat(data) {
  const candidate =
    data?.chat?.find((entry) => entry.role === "user" && String(entry.content || "").trim())?.content ||
    data?.goal ||
    "Untitled conversation";
  const cleaned = normalizeSessionTitle(candidate)
    .replace(/^please\s+/i, "")
    .replace(/^could you\s+/i, "")
    .replace(/^can you\s+/i, "")
    .replace(/^plz\s+/i, "")
    .replace(/^i want to\s+/i, "");
  return normalizeSessionTitle(cleaned.length > 72 ? `${cleaned.slice(0, 69).trim()}...` : cleaned) || "Untitled conversation";
}

async function ensureNotRunning(sessionId) {
  const inMemory = runs.get(sessionId);
  if (inMemory?.status === "running") {
    throw new Error("This session is already running.");
  }

  const stored = await loadStoredRun(sessionId);
  if (stored?.status === "running") {
    throw new Error("This session is already running.");
  }
}

async function latestPermissionAdvice(sessionId) {
  const inMemory = runs.get(sessionId);
  const memoryEntry = [...(inMemory?.logs || [])]
    .reverse()
    .find((entry) => entry.message === "tool.blocked" && entry.data?.permissionAdvice);
  if (memoryEntry?.data?.permissionAdvice) {
    return {
      ...memoryEntry.data.permissionAdvice,
      category: memoryEntry.data.permissionAdvice.category || memoryEntry.data.category || "",
    };
  }

  const events = await sessionStore(sessionId).loadEvents().catch(() => []);
  const event = [...events].reverse().find((candidate) => candidate.type === "tool.blocked" && candidate.data?.permissionAdvice);
  if (!event?.data?.permissionAdvice) return null;
  return {
    ...event.data.permissionAdvice,
    category: event.data.permissionAdvice.category || event.data.category || "",
  };
}

function permissionApprovalPrompt(action, advice = {}, originalGoal = "") {
  const original = originalGoal ? `Original request: ${originalGoal}` : "";
  if (action === "once") {
    return [
      "Continue the same task after the user approved the previously blocked permission once.",
      original,
      "Do not repeat unrelated blocked actions.",
      "Keep the work scoped to the user's request and verify outputs before finishing.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    "Continue the same task after the user approved this permission mode for the current session.",
    original,
    "Use the stronger mode only for the requested task.",
    "Verify outputs before finishing.",
    advice.summary ? `Previous blocker: ${advice.summary}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function collectWorkspaceActivity(limit = 24) {
  const activity = [];
  const sessions = db.listSessions(30);

  for (const session of sessions) {
    const store = sessionStore(session.sessionId);
    const events = await store.loadEvents();
    for (const event of events) {
      if (event.type === "file.changed") {
        activity.push({
          at: event.timestamp,
          kind: "changed",
          sessionId: session.sessionId,
          goal: session.goal,
          ...event.data,
        });
      }

      if (
        event.type === "tool.blocked" &&
        (WORKSPACE_TOOL_NAMES.includes(event.data?.toolName) || WORKSPACE_TOOL_NAMES.includes(event.data?.args?.toolName))
      ) {
        activity.push({
          at: event.timestamp,
          kind: "blocked",
          sessionId: session.sessionId,
          goal: session.goal,
          toolName: event.data?.toolName || "",
          path: event.data?.args?.path || "",
          reason: event.data?.reason || "",
          category: event.data?.category || "",
          permissionAdvice: event.data?.permissionAdvice || null,
        });
      }
    }
  }

  return activity.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

async function loadArtifactBundle(sessionId) {
  if (!isSafeSessionId(sessionId)) {
    return { error: "Invalid session id.", status: 400 };
  }

  const meta = db.getSession(sessionId);
  const store = sessionStore(sessionId);
  const events = await store.loadEvents();
  if (!meta && events.length === 0) {
    return { error: "Session not found.", status: 404 };
  }

  const preferences = normalizePreferencePayload({}, db.getPreferences());
  const config = buildRunConfig({ ...preferences, goal: "" });
  const bundle = buildArtifacts({ sessionId, events, store });
  return {
    ...bundle,
    store,
    config,
  };
}

function createRunRecord(config, goal, existingLogs = []) {
  return {
    sessionId: config.sessionId,
    status: "running",
    provider: config.provider,
    model: config.model,
    goal,
    projectRoot: baseDir,
    commandCwd: config.commandCwd,
    projectSessionsDir,
    sessionDir: path.join(sessionsDir, config.sessionId),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: "",
    result: "",
    error: "",
    logs: [...existingLogs],
  };
}

function wireRun(record, config) {
  const abortController = new AbortController();
  record.abortController = abortController;
  const push = (kind, message, data = {}) => {
    record.logs.push({
      at: new Date().toISOString(),
      kind,
      message,
      data,
    });
  };

  push("session", `Started session ${record.sessionId}`);
  record.updatedAt = new Date().toISOString();
  db.upsertSession(record);

  void runAgent({
    ...config,
    abortSignal: abortController.signal,
    onLog: (message, data = {}) => push("log", message, data),
    onEvent: (type, data = {}) => push("event", type, data),
  })
    .then((result) => {
      record.status = result?.failed ? "failed" : result?.stopped ? "stopped" : "finished";
      record.result = result?.result || "";
      record.error = result?.failed
        ? result.reason || result.result || "Run failed."
        : result?.stopped
          ? result.reason || "Run stopped before finish."
          : "";
      record.updatedAt = new Date().toISOString();
      record.endedAt = new Date().toISOString();
      push("session", result?.failed ? "Run failed" : result?.stopped ? "Run stopped" : "Run finished", {
        result: record.result,
        reason: result?.reason || "",
      });
      db.upsertSession(record);
    })
    .catch((error) => {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.updatedAt = new Date().toISOString();
      record.endedAt = new Date().toISOString();
      push("error", "Run failed", { error: record.error });
      db.upsertSession(record);
    });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/logos", express.static(path.join(__dirname, "logos")));

app.get("/api/config", async (_req, res) => {
  await syncStoredSessions();
  const preferences = normalizePreferencePayload({}, db.getPreferences());
  const config = buildRunConfig({ ...preferences, goal: "" });
  const paths = projectPaths(baseDir);
  const keyStatus = publicKeyStatus(baseDir);
  const platform = platformInfo();
  res.json({
    project: {
      root: paths.root,
      commandCwd: config.commandCwd,
      sessionsDir,
      projectSessionsDir,
      sessionDbPath: paths.sessionDbPath,
      sharedSessionFolder: path.resolve(config.sessionsDir) === path.resolve(sessionsDir),
      globalSessionIndexPath: paths.globalSessionIndexPath,
      localEnvPresent: keyStatus.localEnv,
      platform: {
        ...platform,
        label: platformLabel(platform),
        setupHints: platformSetupHints(platform),
      },
    },
    defaults: {
      openai: publicProviderDefault("openai"),
      deepseek: publicProviderDefault("deepseek"),
      qwen: publicProviderDefault("qwen"),
      venice: publicProviderDefault("venice"),
      mock: publicProviderDefault("mock"),
      headless: true,
      maxSteps: 24,
    },
    modelCatalog: PROVIDER_MODEL_CATALOG,
    modelGroups: MODEL_PROVIDER_GROUPS,
    auxiliaryModelCatalog: AUXILIARY_MODEL_CATALOG,
    modelRoles: getModelRoleDefaults(preferences),
    taskProfiles: listTaskProfiles(),
    skillPacks: listExternalSkillPacks().map((pack) => ({
      id: pack.id,
      label: pack.label,
      category: pack.category,
      skillsDir: pack.skillsDir,
    })),
    skills: listSkills(),
    routing: {
      modes: ["smart", "fast", "complex", "manual"],
      presets: getModelPresets(),
    },
    wrappers: listAgentWrappers(),
    sandbox: {
      logs: getSandboxLogs(),
    },
    workspace: summarizeWorkspaceTools(config),
    mcp: summarizeMcpConfig(config.commandCwd || baseDir),
    preferences,
    keyStatus,
    sessions: db.listSessions(100),
  });
});

app.get("/api/path-suggestions", async (req, res) => {
  const suggestions = await pathSuggestions(String(req.query.q || ""));
  res.json({ ok: true, suggestions });
});

app.get("/api/keys/status", (_req, res) => {
  res.json({ ok: true, keyStatus: publicKeyStatus(baseDir) });
});

app.get("/api/capabilities", async (_req, res) => {
  const preferences = normalizePreferencePayload({}, db.getPreferences());
  const config = buildRunConfig({
    ...preferences,
    goal: "capabilities",
    allowShellTool: true,
    allowFileTools: true,
  });
  const report = await buildCapabilityReport(baseDir, packageJson.version, config);
  res.json(report);
});

app.get("/api/mcp", async (_req, res) => {
  const preferences = normalizePreferencePayload({}, db.getPreferences());
  const config = buildRunConfig({
    ...preferences,
    goal: "mcp status",
    allowShellTool: true,
    allowFileTools: true,
    allowMcpTools: true,
  });
  res.json(await mcpCliCommand(["status"], config));
});

app.post("/api/mcp", async (req, res) => {
  try {
    const preferences = normalizePreferencePayload({}, db.getPreferences());
    const config = buildRunConfig({
      ...preferences,
      goal: "mcp",
      allowShellTool: true,
      allowFileTools: true,
      allowMcpTools: true,
    });
    const action = Array.isArray(req.body?.argv)
      ? req.body.argv.map((item) => String(item || ""))
      : String(req.body?.command || req.body?.action || "status")
          .split(/\s+/)
          .filter(Boolean);
    res.json(await mcpCliCommand(action.length ? action : ["status"], config));
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/keys/:provider", async (req, res) => {
  try {
    const result = await setProviderKey(baseDir, req.params.provider, req.body?.apiKey || req.body?.key || "");
    res.json({
      ok: true,
      provider: result.provider,
      keyName: result.keyName,
      keyStatus: publicKeyStatus(baseDir),
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/sandbox/status", async (_req, res) => {
  const config = buildRunConfig({ ...db.getPreferences(), goal: "" });
  const status = await getDockerSandboxStatus(config);
  res.json({ ok: true, status });
});

app.post("/api/sandbox/preflight", async (req, res) => {
  const body = {
    ...db.getPreferences(),
    ...(req.body || {}),
    goal: "",
  };
  const config = buildRunConfig(body);
  const result = await runDockerPreflight(config, { buildImage: Boolean(req.body?.buildImage) });
  res.json(result);
});

app.post("/api/preferences", (req, res) => {
  const preferences = normalizePreferencePayload(req.body || {}, db.getPreferences());
  db.savePreferences(preferences);
  res.json({ ok: true, preferences });
});

app.get("/api/sessions", async (_req, res) => {
  await syncStoredSessions();
  res.json({ sessions: db.listSessions(100) });
});

app.get("/api/workspace/changes", async (_req, res) => {
  const preferences = normalizePreferencePayload({}, db.getPreferences());
  const config = buildRunConfig({ ...preferences, goal: "" });
  res.json({
    ok: true,
    workspace: summarizeWorkspaceTools(config),
    activity: await collectWorkspaceActivity(),
  });
});

app.get("/api/sessions/:sessionId/artifacts", async (req, res) => {
  const bundle = await loadArtifactBundle(req.params.sessionId);
  if (bundle.error) {
    res.status(bundle.status || 500).json({ error: bundle.error });
    return;
  }

  res.json({
    ok: true,
    sessionId: req.params.sessionId,
    items: serializeArtifacts(bundle.items),
    selectedItemId: bundle.selectedItemId,
    unreadCount: countUnreadArtifacts(bundle.items, req.query.seenAfter),
  });
});

app.get("/api/sessions/:sessionId/artifacts/:artifactId", async (req, res) => {
  const bundle = await loadArtifactBundle(req.params.sessionId);
  if (bundle.error) {
    res.status(bundle.status || 500).json({ error: bundle.error });
    return;
  }

  const artifact = findArtifact(bundle.items, req.params.artifactId);
  const content = await readArtifactContent(artifact, bundle);
  if (!content.ok) {
    res.status(artifact ? 400 : 404).json({ error: content.error || "Artifact not found." });
    return;
  }
  res.json(content);
});

app.get("/api/sessions/:sessionId/artifacts/:artifactId/raw", async (req, res) => {
  const bundle = await loadArtifactBundle(req.params.sessionId);
  if (bundle.error) {
    res.status(bundle.status || 500).json({ error: bundle.error });
    return;
  }

  const artifact = findArtifact(bundle.items, req.params.artifactId);
  const file = await resolveArtifactFile(artifact, bundle);
  if (!file.ok) {
    res.status(artifact ? 400 : 404).json({ error: file.error || "Artifact not found." });
    return;
  }

  const filename = safeDownloadFilename(file.path || file.title || file.absolutePath);
  const disposition = req.query.download === "1" ? "attachment" : "inline";
  res.setHeader("Content-Type", file.mime || "application/octet-stream");
  res.setHeader("Content-Length", String(file.size));
  res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, max-age=0, no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const stream = createReadStream(file.absolutePath);
  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    res.destroy(error);
  });
  stream.pipe(res);
});

app.post("/api/sessions/:sessionId/artifacts/select", async (req, res) => {
  const bundle = await loadArtifactBundle(req.params.sessionId);
  if (bundle.error) {
    res.status(bundle.status || 500).json({ error: bundle.error });
    return;
  }

  const artifactId = String(req.body?.artifactId || "");
  const artifact = findArtifact(bundle.items, artifactId);
  if (!artifact) {
    res.status(404).json({ error: "Artifact not found." });
    return;
  }

  await sessionStore(req.params.sessionId).appendEvent("canvas.selected", {
    artifactId,
    title: artifact.title,
    source: "user",
  });
  res.json({ ok: true, artifact: serializeArtifacts([artifact])[0] });
});

app.get("/api/sessions/:sessionId/chat", async (req, res) => {
  const data = await loadChat(req.params.sessionId);
  if (!data) {
    res.status(404).json({ error: "Session not found." });
    return;
  }
  res.json(data);
});

app.get("/api/sessions/:sessionId/inbox", async (req, res) => {
  const loaded = await loadInboxSession(req.params.sessionId);
  if (loaded.error) {
    res.status(loaded.status || 500).json({ error: loaded.error });
    return;
  }

  res.json({
    ok: true,
    sessionId: req.params.sessionId,
    items: loaded.data.inbox || [],
  });
});

app.post("/api/sessions/:sessionId/inbox", async (req, res) => {
  const loaded = await loadInboxSession(req.params.sessionId);
  if (loaded.error) {
    res.status(loaded.status || 500).json({ error: loaded.error });
    return;
  }

  const content = String(req.body?.content || "").trim();
  if (!content) {
    res.status(400).json({ error: "Message content is required." });
    return;
  }

  const priority = req.body?.priority === "normal" ? "normal" : "asap";
  const item = await loaded.store.appendInbox(content, { source: "web", priority });
  await loaded.store
    .appendEvent("conversation.queued_input", {
      itemId: item?.id,
      priority,
      source: "web",
      preview: queuedMessagePreview(content),
    })
    .catch(() => {});
  pushActiveInboxLog(req.params.sessionId, "conversation.queued_input", {
    itemId: item?.id,
    priority,
    source: "web",
    preview: queuedMessagePreview(content),
  });

  res.json({ ok: true, sessionId: req.params.sessionId, item });
});

app.patch("/api/sessions/:sessionId/inbox/:itemId", async (req, res) => {
  const loaded = await loadInboxSession(req.params.sessionId);
  if (loaded.error) {
    res.status(loaded.status || 500).json({ error: loaded.error });
    return;
  }

  const content = String(req.body?.content || "").trim();
  if (!content) {
    res.status(400).json({ error: "Message content is required." });
    return;
  }

  const items = await loaded.store.loadInbox();
  const index = items.findIndex((item) => item.id === req.params.itemId);
  if (index < 0) {
    res.status(404).json({ error: "Queued message not found. It may already have been consumed by the agent." });
    return;
  }

  const item = {
    ...items[index],
    content,
    updatedAt: new Date().toISOString(),
    editedBy: "web",
  };
  items[index] = item;
  await loaded.store.saveInbox(items);
  await loaded.store
    .appendEvent("conversation.queued_input_edited", {
      itemId: item.id,
      source: "web",
      preview: queuedMessagePreview(content),
    })
    .catch(() => {});
  pushActiveInboxLog(req.params.sessionId, "conversation.queued_input_edited", {
    itemId: item.id,
    source: "web",
    preview: queuedMessagePreview(content),
  });

  res.json({ ok: true, sessionId: req.params.sessionId, item });
});

app.delete("/api/sessions/:sessionId/inbox/:itemId", async (req, res) => {
  const loaded = await loadInboxSession(req.params.sessionId);
  if (loaded.error) {
    res.status(loaded.status || 500).json({ error: loaded.error });
    return;
  }

  const items = await loaded.store.loadInbox();
  const item = items.find((candidate) => candidate.id === req.params.itemId);
  if (!item) {
    res.status(404).json({ error: "Queued message not found. It may already have been consumed by the agent." });
    return;
  }

  await loaded.store.saveInbox(items.filter((candidate) => candidate.id !== req.params.itemId));
  await loaded.store
    .appendEvent("conversation.queued_input_removed", {
      itemId: item.id,
      source: "web",
      preview: queuedMessagePreview(item.content),
    })
    .catch(() => {});
  pushActiveInboxLog(req.params.sessionId, "conversation.queued_input_removed", {
    itemId: item.id,
    source: "web",
    preview: queuedMessagePreview(item.content),
  });

  res.json({ ok: true, sessionId: req.params.sessionId, itemId: item.id });
});

app.patch("/api/sessions/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!isSafeSessionId(sessionId)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  const meta = db.getSession(sessionId);
  if (!meta) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  const title = normalizeSessionTitle(req.body?.title);
  if (!title) {
    res.status(400).json({ error: "Title is required." });
    return;
  }

  await renameProjectSession(baseDir, sessionId, title);
  db.renameSession(sessionId, title);
  await sessionStore(sessionId).appendEvent("session.renamed", { title }).catch(() => {});
  res.json({ ok: true, session: db.getSession(sessionId) });
});

app.post("/api/sessions/:sessionId/auto-title", async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!isSafeSessionId(sessionId)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  const data = await loadChat(sessionId);
  if (!data) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  const title = autoSessionTitleFromChat(data);
  await renameProjectSession(baseDir, sessionId, title);
  db.renameSession(sessionId, title);
  await sessionStore(sessionId).appendEvent("session.auto_renamed", { title }).catch(() => {});
  res.json({ ok: true, session: db.getSession(sessionId) });
});

app.delete("/api/sessions/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!isSafeSessionId(sessionId)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  try {
    await ensureNotRunning(sessionId);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const meta = db.getSession(sessionId);
  if (!meta) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  runs.delete(sessionId);
  db.deleteSession(sessionId);
  await sessionStore(sessionId).remove();
  res.json({ ok: true, sessionId });
});

app.post("/api/runs", async (req, res) => {
  const body = req.body || {};
  const goal = String(body.goal || "").trim();
  if (!goal) {
    res.status(400).json({ error: "Goal is required." });
    return;
  }

  const config = buildRunConfig(body);
  db.savePreferences(normalizePreferencePayload(body, db.getPreferences()));

  if (!config.apiKey) {
    res.status(400).json({ error: `Missing API key for ${config.provider}.` });
    return;
  }

  const run = createRunRecord(config, goal);
  runs.set(run.sessionId, run);
  wireRun(run, config);
  res.json({ sessionId: run.sessionId });
});

app.post("/api/sessions/:sessionId/messages", async (req, res) => {
  const sessionId = req.params.sessionId;
  const content = String(req.body?.content || "").trim();

  if (!content) {
    res.status(400).json({ error: "Message content is required." });
    return;
  }

  if (!isSafeSessionId(sessionId)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  const active = runs.get(sessionId);
  if (active?.status === "running") {
    const store = sessionStore(sessionId);
    const item = await store.appendInbox(content, { source: "web", priority: "asap" });
    await store
      .appendEvent("conversation.queued_input", {
        itemId: item?.id,
        priority: "asap",
        source: "web",
        preview: queuedMessagePreview(content),
      })
      .catch(() => {});
    active.logs.push({
      at: new Date().toISOString(),
      kind: "event",
      message: "conversation.queued_input",
      data: { itemId: item?.id, priority: "asap", source: "web", preview: queuedMessagePreview(content) },
    });
    active.updatedAt = new Date().toISOString();
    db.upsertSession(active);
    res.json({ sessionId, queued: true, item });
    return;
  }

  try {
    await ensureNotRunning(sessionId);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const meta = db.getSession(sessionId);
  if (!meta) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  const body = {
    ...db.getPreferences(),
    ...req.body,
    goal: content,
  };

  const config = buildRunConfig(body, {
    resume: sessionId,
    sessionId,
    provider: body.provider || meta.provider,
    model: body.model || meta.model,
  });

  if (!config.apiKey) {
    res.status(400).json({ error: `Missing API key for ${config.provider}.` });
    return;
  }

  db.savePreferences(normalizePreferencePayload(body, db.getPreferences()));

  const existing = runs.get(sessionId);
  const stored = existing || (await loadStoredRun(sessionId));
  const run = createRunRecord(config, content, stored?.logs || []);
  runs.set(sessionId, run);
  wireRun(run, config);
  res.json({ sessionId });
});

app.post("/api/sessions/:sessionId/approve-permission", async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!isSafeSessionId(sessionId)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  const action = String(req.body?.action || "no").trim().toLowerCase();
  if (!["no", "once", "always"].includes(action)) {
    res.status(400).json({ error: "Action must be no, once, or always." });
    return;
  }

  try {
    await ensureNotRunning(sessionId);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const meta = db.getSession(sessionId);
  if (!meta) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  const advice = await latestPermissionAdvice(sessionId);
  if (!advice) {
    res.status(404).json({ error: "No pending permission advice found for this session." });
    return;
  }

  const store = sessionStore(sessionId);
  if (action === "no") {
    await store.appendEvent("permission.approval_declined", {
      source: "web",
      category: advice.category || "",
    });
    const existing = runs.get(sessionId);
    if (existing) {
      existing.logs.push({
        at: new Date().toISOString(),
        kind: "event",
        message: "permission.approval_declined",
        data: { source: "web", category: advice.category || "" },
      });
    }
    res.json({ ok: true, sessionId, action });
    return;
  }

  const targetMode = normalizePermissionMode(req.body?.permissionMode || permissionModeForApprovalCategory(advice.category || ""));
  const preferences = normalizePreferencePayload(
    {
      ...db.getPreferences(),
      ...req.body,
      permissionMode: targetMode,
      goal: permissionApprovalPrompt(action, advice, meta.goal),
    },
    db.getPreferences()
  );
  if (action === "always") db.savePreferences(preferences);

  const config = buildRunConfig(
    {
      ...preferences,
      goal: permissionApprovalPrompt(action, advice, meta.goal),
    },
    {
      resume: sessionId,
      sessionId,
      provider: preferences.provider || meta.provider,
      model: preferences.model || meta.model,
    }
  );

  if (!config.apiKey) {
    res.status(400).json({ error: `Missing API key for ${config.provider}.` });
    return;
  }

  await store.appendEvent("permission.approval_granted", {
    source: "web",
    action,
    category: advice.category || "",
    permissionMode: targetMode,
  });

  const stored = await loadStoredRun(sessionId);
  const run = createRunRecord(config, config.goal, stored?.logs || []);
  runs.set(sessionId, run);
  wireRun(run, config);
  res.json({ ok: true, sessionId, action, permissionMode: targetMode });
});

app.get("/api/runs/:sessionId", async (req, res) => {
  const inMemory = runs.get(req.params.sessionId);
  if (inMemory) {
    res.json(serializeRun(inMemory));
    return;
  }

  const stored = await loadStoredRun(req.params.sessionId);
  if (!stored) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  res.json(stored);
});

app.post("/api/runs/:sessionId/stop", async (req, res) => {
  const run = runs.get(req.params.sessionId);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  if (run.status !== "running") {
    res.status(409).json({ error: "Run is not active.", status: run.status });
    return;
  }

  run.abortController?.abort(new Error("Stopped from web UI."));
  run.logs.push({
    at: new Date().toISOString(),
    kind: "event",
    message: "session.stop_requested",
    data: { source: "web" },
  });
  run.updatedAt = new Date().toISOString();
  db.upsertSession(run);
  await sessionStore(req.params.sessionId).appendEvent("session.stop_requested", { source: "web" }).catch(() => {});
  res.json({ ok: true, sessionId: req.params.sessionId });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    app: "agintiflow",
    version: packageJson.version,
    pid: process.pid,
    host,
    port,
    url: `http://${host}:${port}`,
    runtimeDir: baseDir,
    projectRoot: baseDir,
    agintiflowHome: storagePaths.agintiflowHome,
    sessionsDir,
    projectSessionsDir,
    packageDir,
    storageDriver: db.driver || "sqlite",
  });
});

await fs.mkdir(sessionsDir, { recursive: true });
await syncStoredSessions();

function listenOnPort(candidatePort) {
  return new Promise((resolve, reject) => {
    const server = app.listen({ port: candidatePort, host });
    server.once("error", (error) => reject(error));
    server.once("listening", () => resolve(server));
  });
}

async function listenWithFallback(preferredPort, attempts = 50) {
  const startPort = Number.isInteger(Number(preferredPort)) && Number(preferredPort) > 0 ? Number(preferredPort) : 3210;
  let lastError = null;
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidatePort = startPort + offset;
    if (candidatePort >= 65536) break;
    try {
      return await listenOnPort(candidatePort);
    } catch (error) {
      lastError = error;
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  const error = new Error(`No available AgInTiFlow web port from ${startPort} after ${attempts} attempts.`);
  error.cause = lastError;
  throw error;
}

export const webServer = await listenWithFallback(port);
port = webServer.address()?.port || port;
export const webUrl = `http://${host}:${port}`;
console.log(`Website control agent UI running on ${webUrl}`);
