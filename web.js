import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./src/agent-runner.js";
import { resolveRuntimeConfig } from "./src/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3210);
const runs = new Map();

function defaultsFor(provider) {
  return provider === "deepseek"
    ? { provider: "deepseek", model: "deepseek-chat" }
    : { provider: "openai", model: "gpt-5.4-mini" };
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
    keyStatus: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    },
  });
});

app.post("/api/runs", (req, res) => {
  const body = req.body || {};
  const provider = body.provider === "deepseek" ? "deepseek" : "openai";
  const goal = String(body.goal || "").trim();
  if (!goal) {
    res.status(400).json({ error: "Goal is required." });
    return;
  }

  const config = resolveRuntimeConfig(
    {
      goal,
      startUrl: String(body.startUrl || ""),
      resume: "",
      sessionId: "",
    },
    {
      provider,
      model: String(body.model || defaultsFor(provider).model),
      headless: body.headless === true,
      maxSteps: Number(body.maxSteps) || 15,
      allowedDomains: String(body.allowedDomains || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      allowPasswords: body.allowPasswords === true,
      allowDestructive: body.allowDestructive === true,
      allowShellTool: body.allowShellTool === true,
      commandCwd: String(body.commandCwd || process.cwd()),
      baseDir: process.cwd(),
    }
  );

  if (!config.apiKey) {
    res.status(400).json({ error: `Missing API key for ${provider}.` });
    return;
  }

  const run = {
    sessionId: config.sessionId,
    status: "running",
    provider: config.provider,
    model: config.model,
    goal,
    startedAt: new Date().toISOString(),
    endedAt: "",
    result: "",
    error: "",
    logs: [],
  };
  runs.set(run.sessionId, run);

  const push = (kind, message, data = {}) => {
    run.logs.push({
      at: new Date().toISOString(),
      kind,
      message,
      data,
    });
  };

  push("session", `Started session ${run.sessionId}`);

  void runAgent({
    ...config,
    onLog: (message, data = {}) => push("log", message, data),
    onEvent: (type, data = {}) => push("event", type, data),
  })
    .then((result) => {
      run.status = "finished";
      run.result = result?.result || "";
      run.endedAt = new Date().toISOString();
      push("session", "Run finished", { result: run.result });
    })
    .catch((error) => {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.endedAt = new Date().toISOString();
      push("error", "Run failed", { error: run.error });
    });

  res.json({ sessionId: run.sessionId });
});

app.get("/api/runs/:sessionId", (req, res) => {
  const run = runs.get(req.params.sessionId);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  res.json(serializeRun(run));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, port });
});

app.listen(port, () => {
  console.log(`Website control agent UI running on http://127.0.0.1:${port}`);
});
