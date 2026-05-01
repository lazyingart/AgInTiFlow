import fs from "node:fs/promises";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./src/agent-runner.js";
import { resolveRuntimeConfig } from "./src/config.js";
import { WebDatabase } from "./src/web-db.js";
import { SessionStore } from "./src/session-store.js";
import { getModelPresets, getProviderDefaults, normalizeRoutingMode } from "./src/model-routing.js";
import { listAgentWrappers, normalizeWrapperName } from "./src/tool-wrappers.js";
import { getDockerSandboxStatus, getSandboxLogs, runDockerPreflight } from "./src/docker-sandbox.js";
import { normalizePackageInstallPolicy, normalizeSandboxMode } from "./src/command-policy.js";
import { summarizeWorkspaceTools, WORKSPACE_TOOL_NAMES } from "./src/workspace-tools.js";
import { listTaskProfiles, normalizeTaskProfile } from "./src/task-profiles.js";
import { loadProjectEnv, projectPaths, providerKeyStatus, setProviderKey } from "./src/project.js";
import { buildCapabilityReport } from "./src/capabilities.js";
import {
  buildArtifacts,
  countUnreadArtifacts,
  findArtifact,
  readArtifactContent,
  serializeArtifacts,
} from "./src/artifact-tunnel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = __dirname;
const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
const baseDir = path.resolve(process.env.AGINTIFLOW_RUNTIME_DIR || process.cwd());
const sessionsDir = path.join(baseDir, ".sessions");
loadProjectEnv(baseDir);

const app = express();
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || "127.0.0.1";
const runs = new Map();
const db = new WebDatabase(baseDir);
const supportedLanguages = new Set([
  "en",
  "ar",
  "es",
  "fr",
  "ja",
  "ko",
  "vi",
  "zh-Hans",
  "zh-Hant",
  "de",
  "ru",
]);

function normalizeLanguage(language, fallback = "en") {
  if (supportedLanguages.has(language)) return language;
  return supportedLanguages.has(fallback) ? fallback : "en";
}

function sessionStore(sessionId) {
  return new SessionStore(sessionsDir, sessionId);
}

function isSafeSessionId(sessionId) {
  return /^[A-Za-z0-9._:-]+$/.test(String(sessionId || "")) && !String(sessionId || "").includes("..");
}

function mapEventLogs(events) {
  return events.map((event) => ({
    at: event.timestamp,
    kind: "event",
    message: event.type,
    data: event.data || {},
  }));
}

async function loadStoredRun(sessionId) {
  const meta = db.getSession(sessionId);
  if (!meta) return null;

  const store = sessionStore(sessionId);
  const events = await store.loadEvents();

  return {
    sessionId: meta.sessionId,
    status: meta.status,
    provider: meta.provider,
    model: meta.model,
    goal: meta.goal,
    title: meta.title || "",
    startedAt: meta.startedAt,
    endedAt: meta.endedAt || null,
    result: meta.result || "",
    error: meta.error || "",
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
  const providerCandidate = body.provider || current.provider || "deepseek";
  const provider = ["openai", "deepseek", "mock"].includes(providerCandidate) ? providerCandidate : "deepseek";
  const routingMode =
    provider === "mock" ? "manual" : normalizeRoutingMode(body.routingMode || current.routingMode || "smart");
  const providerDefaults = getProviderDefaults(provider);
  const parsedMaxSteps = Number(body.maxSteps);
  const parsedWrapperTimeoutMs = Number(body.wrapperTimeoutMs);
  const parsedParallelScoutCount = Number(body.parallelScoutCount);
  const sandboxMode = normalizeSandboxMode(body.sandboxMode || current.sandboxMode || "docker-workspace");

  return {
    routingMode,
    provider,
    model:
      typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : current.provider !== provider
          ? providerDefaults.model
          : current.model || modelPresets.fast.model || providerDefaults.model,
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
    allowShellTool: typeof body.allowShellTool === "boolean" ? body.allowShellTool : Boolean(current.allowShellTool),
    allowFileTools: typeof body.allowFileTools === "boolean" ? body.allowFileTools : current.allowFileTools !== false,
    allowAuxiliaryTools:
      typeof body.allowAuxiliaryTools === "boolean" ? body.allowAuxiliaryTools : current.allowAuxiliaryTools !== false,
    allowWebSearch:
      typeof body.allowWebSearch === "boolean" ? body.allowWebSearch : current.allowWebSearch !== false,
    allowParallelScouts:
      typeof body.allowParallelScouts === "boolean" ? body.allowParallelScouts : current.allowParallelScouts !== false,
    parallelScoutCount:
      Number.isFinite(parsedParallelScoutCount) && parsedParallelScoutCount > 0
        ? Math.min(Math.max(parsedParallelScoutCount, 1), 4)
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
      body.packageInstallPolicy || current.packageInstallPolicy || (sandboxMode === "host" ? "prompt" : "allow")
    ),
    dockerSandboxImage:
      typeof body.dockerSandboxImage === "string" && body.dockerSandboxImage.trim()
        ? body.dockerSandboxImage.trim()
        : current.dockerSandboxImage || "agintiflow-sandbox:latest",
    allowPasswords: typeof body.allowPasswords === "boolean" ? body.allowPasswords : Boolean(current.allowPasswords),
    allowDestructive:
      typeof body.allowDestructive === "boolean" ? body.allowDestructive : Boolean(current.allowDestructive),
    language: normalizeLanguage(body.language, current.language),
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
    grsai: status.grsai,
    mock: true,
    localEnv: status.localEnv,
    envVars: status.envVars,
  };
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
      allowParallelScouts: merged.allowParallelScouts,
      parallelScoutCount: merged.parallelScoutCount,
      allowWrapperTools: merged.allowWrapperTools,
      preferredWrapper: merged.preferredWrapper,
      wrapperTimeoutMs: merged.wrapperTimeoutMs,
      sandboxMode: merged.sandboxMode,
      packageInstallPolicy: merged.packageInstallPolicy,
      useDockerSandbox: merged.useDockerSandbox,
      dockerSandboxImage: merged.dockerSandboxImage,
      commandCwd: merged.commandCwd,
      taskProfile: merged.taskProfile,
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
    title: existing?.title || "",
    status,
    startedAt: state.createdAt || existing?.startedAt || new Date().toISOString(),
    updatedAt,
    endedAt: finishPayload?.done ? updatedAt : existing?.endedAt || null,
    result: finishPayload?.done ? String(finishPayload.result || "") : existing?.result || "",
    error: existing?.error || "",
  };
}

async function syncStoredSessions() {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const store = sessionStore(entry.name);
    const state = await store.loadState();
    if (!state?.sessionId) continue;

    const existing = db.getSession(state.sessionId);
    db.upsertSession(deriveSessionRecordFromState(state, existing));
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
  const [state, meta] = await Promise.all([store.loadState(), Promise.resolve(db.getSession(sessionId))]);

  if (!state && !meta) return null;

  return {
    sessionId,
    goal: state?.goal || meta?.goal || "",
    title: meta?.title || "",
    provider: state?.provider || meta?.provider || "",
    model: state?.model || meta?.model || "",
    chat: deriveChatFromState(state, meta),
  };
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

  const meta = db.getSession(sessionId);
  if (meta?.status === "running") {
    throw new Error("This session is already running.");
  }
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
      record.status = result?.stopped ? "stopped" : "finished";
      record.result = result?.result || "";
      record.error = result?.stopped ? result.reason || "Run stopped before finish." : "";
      record.updatedAt = new Date().toISOString();
      record.endedAt = new Date().toISOString();
      push("session", result?.stopped ? "Run stopped" : "Run finished", {
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
  res.json({
    project: {
      root: paths.root,
      commandCwd: config.commandCwd,
      sessionsDir,
      sessionDbPath: paths.sessionDbPath,
      sharedSessionFolder: path.resolve(config.sessionsDir) === path.resolve(sessionsDir),
      localEnvPresent: keyStatus.localEnv,
    },
    defaults: {
      openai: publicProviderDefault("openai"),
      deepseek: publicProviderDefault("deepseek"),
      mock: publicProviderDefault("mock"),
      headless: true,
      maxSteps: 24,
    },
    taskProfiles: listTaskProfiles(),
    routing: {
      modes: ["smart", "fast", "complex", "manual"],
      presets: getModelPresets(),
    },
    wrappers: listAgentWrappers(),
    sandbox: {
      logs: getSandboxLogs(),
    },
    workspace: summarizeWorkspaceTools(config),
    preferences,
    keyStatus,
    sessions: db.listSessions(100),
  });
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
    await store.appendInbox(content, { source: "web" });
    await store.appendEvent("conversation.queued_input", { prompt: content, source: "web" }).catch(() => {});
    active.logs.push({
      at: new Date().toISOString(),
      kind: "event",
      message: "conversation.queued_input",
      data: { prompt: content, source: "web" },
    });
    active.updatedAt = new Date().toISOString();
    db.upsertSession(active);
    res.json({ sessionId, queued: true });
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
  res.json({ ok: true, port });
});

await fs.mkdir(sessionsDir, { recursive: true });
await syncStoredSessions();

app.listen(port, host, () => {
  console.log(`Website control agent UI running on http://${host}:${port}`);
});
