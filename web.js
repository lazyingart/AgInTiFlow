import fs from "node:fs/promises";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./src/agent-runner.js";
import { resolveRuntimeConfig } from "./src/config.js";
import { WebDatabase } from "./src/web-db.js";
import { SessionStore } from "./src/session-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseDir = process.cwd();
const sessionsDir = path.join(baseDir, ".sessions");

const app = express();
const port = Number(process.env.PORT || 3210);
const runs = new Map();
const db = new WebDatabase(baseDir);

function defaultsFor(provider) {
  return provider === "deepseek"
    ? { provider: "deepseek", model: "deepseek-chat" }
    : { provider: "openai", model: "gpt-5.4-mini" };
}

function sessionStore(sessionId) {
  return new SessionStore(sessionsDir, sessionId);
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
    startedAt: run.startedAt,
    endedAt: run.endedAt || null,
    result: run.result || "",
    error: run.error || "",
    logs: run.logs.slice(-300),
  };
}

function normalizePreferencePayload(body = {}, current = db.getPreferences()) {
  const provider =
    body.provider === "openai" || body.provider === "deepseek" ? body.provider : current.provider || "deepseek";
  const providerDefaults = defaultsFor(provider);
  const parsedMaxSteps = Number(body.maxSteps);

  return {
    provider,
    model:
      typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : current.provider !== provider
          ? providerDefaults.model
          : current.model || providerDefaults.model,
    headless: typeof body.headless === "boolean" ? body.headless : Boolean(current.headless),
    maxSteps: Number.isFinite(parsedMaxSteps) && parsedMaxSteps > 0 ? parsedMaxSteps : Number(current.maxSteps) || 15,
    startUrl: typeof body.startUrl === "string" ? body.startUrl.trim() : current.startUrl || "",
    allowedDomains:
      typeof body.allowedDomains === "string" ? body.allowedDomains.trim() : current.allowedDomains || "",
    commandCwd:
      typeof body.commandCwd === "string" && body.commandCwd.trim()
        ? body.commandCwd.trim()
        : current.commandCwd || path.resolve(baseDir, ".."),
    allowShellTool: typeof body.allowShellTool === "boolean" ? body.allowShellTool : Boolean(current.allowShellTool),
    useDockerSandbox:
      typeof body.useDockerSandbox === "boolean" ? body.useDockerSandbox : Boolean(current.useDockerSandbox),
    dockerSandboxImage:
      typeof body.dockerSandboxImage === "string" && body.dockerSandboxImage.trim()
        ? body.dockerSandboxImage.trim()
        : current.dockerSandboxImage || "agintiflow-sandbox:latest",
    allowPasswords: typeof body.allowPasswords === "boolean" ? body.allowPasswords : Boolean(current.allowPasswords),
    allowDestructive:
      typeof body.allowDestructive === "boolean" ? body.allowDestructive : Boolean(current.allowDestructive),
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
      model: merged.model || defaultsFor(merged.provider).model,
      headless: merged.headless,
      maxSteps: merged.maxSteps,
      allowedDomains: String(merged.allowedDomains || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      allowPasswords: merged.allowPasswords,
      allowDestructive: merged.allowDestructive,
      allowShellTool: merged.allowShellTool,
      useDockerSandbox: merged.useDockerSandbox,
      dockerSandboxImage: merged.dockerSandboxImage,
      commandCwd: merged.commandCwd,
      baseDir,
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
    model: state.model || existing?.model || defaultsFor(state.provider || existing?.provider || "deepseek").model,
    goal: state.goal || existing?.goal || "",
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
    provider: state?.provider || meta?.provider || "",
    model: state?.model || meta?.model || "",
    chat: deriveChatFromState(state, meta),
  };
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
    onLog: (message, data = {}) => push("log", message, data),
    onEvent: (type, data = {}) => push("event", type, data),
  })
    .then((result) => {
      record.status = "finished";
      record.result = result?.result || "";
      record.updatedAt = new Date().toISOString();
      record.endedAt = new Date().toISOString();
      push("session", "Run finished", { result: record.result });
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

app.get("/api/config", (_req, res) => {
  res.json({
    defaults: {
      openai: defaultsFor("openai"),
      deepseek: defaultsFor("deepseek"),
      headless: true,
      maxSteps: 15,
    },
    preferences: db.getPreferences(),
    keyStatus: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    },
    sessions: db.listSessions(20),
  });
});

app.post("/api/preferences", (req, res) => {
  const preferences = normalizePreferencePayload(req.body || {}, db.getPreferences());
  db.savePreferences(preferences);
  res.json({ ok: true, preferences });
});

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: db.listSessions(20) });
});

app.get("/api/sessions/:sessionId/chat", async (req, res) => {
  const data = await loadChat(req.params.sessionId);
  if (!data) {
    res.status(404).json({ error: "Session not found." });
    return;
  }
  res.json(data);
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, port });
});

await syncStoredSessions();

app.listen(port, () => {
  console.log(`Website control agent UI running on http://127.0.0.1:${port}`);
});
