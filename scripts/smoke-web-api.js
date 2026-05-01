#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-api-smoke-"));
const port = 43000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(repoRoot, "web.js")], {
  cwd: runtimeDir,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    AGINTIFLOW_RUNTIME_DIR: runtimeDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${pathname} failed with ${response.status}: ${body.error || response.statusText}`);
  }
  return body;
}

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const health = await fetchJson("/health");
      if (health.ok) return health;
    } catch {
      await delay(250);
    }
  }

  throw new Error(`web server did not become healthy. stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`);
}

async function waitForRun(sessionId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const run = await fetchJson(`/api/runs/${encodeURIComponent(sessionId)}`);
    if (run.status === "finished" || run.status === "failed") return run;
    await delay(400);
  }
  throw new Error(`run ${sessionId} did not finish in time`);
}

try {
  await waitForHealth();

  const config = await fetchJson("/api/config");
  if (!config.keyStatus?.mock) throw new Error("mock provider is not advertised by /api/config");
  if (!config.workspace?.enabled) throw new Error("workspace file tools are not advertised by /api/config");
  if (config.preferences?.preferredWrapper !== "codex") throw new Error("Codex is not the default preferred wrapper");

  const status = await fetchJson("/api/sandbox/status");
  if (!status.status?.workspaceReadable) throw new Error("sandbox status did not report a readable workspace");

  const preflight = await fetchJson("/api/sandbox/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sandboxMode: "host",
      commandCwd: runtimeDir,
      buildImage: false,
    }),
  });
  if (!preflight.ok) throw new Error("host preflight did not pass");

  const runStart = await fetchJson("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "Report the current working directory with a safe command.",
      commandCwd: runtimeDir,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      allowShellTool: true,
      preferredWrapper: "codex",
      maxSteps: 4,
      headless: true,
    }),
  });

  const run = await waitForRun(runStart.sessionId);
  if (run.status !== "finished") throw new Error(`mock run failed: ${run.error || "unknown error"}`);
  if (!/Mock run complete/.test(run.result)) throw new Error("mock run did not return the expected result");

  const chat = await fetchJson(`/api/sessions/${encodeURIComponent(runStart.sessionId)}/chat`);
  if (!Array.isArray(chat.chat) || chat.chat.length < 2) throw new Error("chat history was not persisted");

  const renamed = await fetchJson(`/api/sessions/${encodeURIComponent(runStart.sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Smoke renamed conversation" }),
  });
  if (renamed.session?.title !== "Smoke renamed conversation") throw new Error("session rename did not persist");

  const autoRenamed = await fetchJson(`/api/sessions/${encodeURIComponent(runStart.sessionId)}/auto-title`, {
    method: "POST",
  });
  if (!/^Report the current working directory/i.test(autoRenamed.session?.title || "")) {
    throw new Error("session auto rename did not derive a title from chat history");
  }

  const changes = await fetchJson("/api/workspace/changes");
  if (!Array.isArray(changes.activity)) throw new Error("workspace changes endpoint returned an invalid payload");

  const deleted = await fetchJson(`/api/sessions/${encodeURIComponent(runStart.sessionId)}`, {
    method: "DELETE",
  });
  if (!deleted.ok) throw new Error("session delete failed");

  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoints: [
          "/api/config",
          "/api/sandbox/status",
          "/api/sandbox/preflight",
          "/api/runs",
          "/api/sessions/:id/chat",
          "PATCH /api/sessions/:id",
          "POST /api/sessions/:id/auto-title",
          "DELETE /api/sessions/:id",
          "/api/workspace/changes",
        ],
        provider: run.provider,
        model: run.model,
        sessionId: run.sessionId,
        runtimeDir,
      },
      null,
      2
    )
  );
} finally {
  server.kill("SIGTERM");
  await delay(150);
  await fs.rm(runtimeDir, { recursive: true, force: true });
}
