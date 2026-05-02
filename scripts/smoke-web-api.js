#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-api-smoke-"));
const port = 43000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "web", "--port", String(port), "--host", "127.0.0.1"], {
  cwd: runtimeDir,
  env: {
    ...process.env,
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
  if (config.project?.root !== runtimeDir) throw new Error("web project root did not default to launch directory");
  if (config.preferences?.commandCwd !== runtimeDir) throw new Error("commandCwd did not default to project root");
  if (config.preferences?.sandboxMode !== "docker-workspace") throw new Error("web did not default to docker workspace");
  if (config.preferences?.packageInstallPolicy !== "allow") throw new Error("web did not default to Docker package installs");
  if (Number(config.preferences?.maxSteps) < 24) throw new Error("web default max steps is too low");
  if (!Array.isArray(config.taskProfiles) || !config.taskProfiles.some((profile) => profile.id === "latex")) {
    throw new Error("task profiles are not advertised by /api/config");
  }

  const keyStatus = await fetchJson("/api/keys/status");
  if (typeof keyStatus.keyStatus?.deepseek !== "boolean") throw new Error("key status endpoint is invalid");
  if ("localEnvPath" in keyStatus.keyStatus) throw new Error("key status leaked a local env path");
  const capabilities = await fetchJson("/api/capabilities");
  if (capabilities.project?.root !== runtimeDir || !Array.isArray(capabilities.checks)) {
    throw new Error("capability endpoint returned an invalid project report");
  }
  if (!capabilities.checks.some((check) => check.name === "npm-prefix-test-policy")) {
    throw new Error("capability endpoint did not include command policy checks");
  }
  if (!capabilities.trustedDockerPolicy?.some((check) => check.command.startsWith("apt-get install") && check.allowed)) {
    throw new Error("capability endpoint did not report trusted Docker package policy");
  }
  const savedKey = await fetchJson("/api/keys/deepseek", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "test-deepseek-key-not-real" }),
  });
  if (!savedKey.ok || !savedKey.keyStatus?.deepseek || "apiKey" in savedKey || "key" in savedKey) {
    throw new Error("local key save endpoint returned invalid or sensitive data");
  }

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

  const fileRunStart = await fetchJson("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "Create notes/hello.md with safe web API content.",
      commandCwd: runtimeDir,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      allowShellTool: false,
      allowFileTools: true,
      preferredWrapper: "codex",
      maxSteps: 4,
      headless: true,
      taskProfile: "code",
    }),
  });
  const fileRun = await waitForRun(fileRunStart.sessionId);
  if (fileRun.status !== "finished") throw new Error(`mock file run failed: ${fileRun.error || "unknown error"}`);
  const hello = await fs.readFile(path.join(runtimeDir, "notes", "hello.md"), "utf8");
  if (!hello.includes("Created by AgInTiFlow mock mode.")) throw new Error("mock file run did not create requested path");

  const chat = await fetchJson(`/api/sessions/${encodeURIComponent(runStart.sessionId)}/chat`);
  if (!Array.isArray(chat.chat) || chat.chat.length < 2) throw new Error("chat history was not persisted");
  if (!Array.isArray(chat.inbox)) throw new Error("chat endpoint did not include shared inbox state");

  const queued = await fetchJson(`/api/sessions/${encodeURIComponent(runStart.sessionId)}/inbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "continue from web inbox smoke", priority: "asap" }),
  });
  if (!queued.item?.id || queued.item.priority !== "asap") throw new Error("inbox queue endpoint did not return an ASAP item");

  const inbox = await fetchJson(`/api/sessions/${encodeURIComponent(runStart.sessionId)}/inbox`);
  if (!inbox.items?.some((item) => item.id === queued.item.id)) throw new Error("inbox endpoint did not list queued item");

  const edited = await fetchJson(
    `/api/sessions/${encodeURIComponent(runStart.sessionId)}/inbox/${encodeURIComponent(queued.item.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "edited web inbox smoke" }),
    }
  );
  if (!edited.item?.content.includes("edited web inbox smoke")) throw new Error("inbox edit endpoint did not persist content");

  const deletedInbox = await fetchJson(
    `/api/sessions/${encodeURIComponent(runStart.sessionId)}/inbox/${encodeURIComponent(queued.item.id)}`,
    {
      method: "DELETE",
    }
  );
  if (!deletedInbox.ok) throw new Error("inbox delete endpoint failed");
  const inboxStore = new SessionStore(path.join(runtimeDir, ".sessions"), runStart.sessionId);
  const remainingInbox = await inboxStore.loadInbox();
  if (remainingInbox.some((item) => item.id === queued.item.id)) throw new Error("inbox delete endpoint left item on disk");

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

  const canvasRunStart = await fetchJson("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "Create a canvas artifact preview for this smoke test.",
      commandCwd: runtimeDir,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      allowShellTool: false,
      allowFileTools: true,
      preferredWrapper: "codex",
      maxSteps: 4,
      headless: true,
    }),
  });
  const canvasRun = await waitForRun(canvasRunStart.sessionId);
  if (canvasRun.status !== "finished") throw new Error(`mock canvas run failed: ${canvasRun.error || "unknown error"}`);

  const artifacts = await fetchJson(`/api/sessions/${encodeURIComponent(canvasRunStart.sessionId)}/artifacts`);
  if (!Array.isArray(artifacts.items) || artifacts.items.length === 0) {
    throw new Error("artifact endpoint returned no items for a finished mock run");
  }
  if (!artifacts.items.some((item) => item.source === "agent-canvas")) {
    throw new Error("mock run did not publish an agent canvas artifact");
  }
  const selectedArtifactId = artifacts.selectedItemId || artifacts.items[0].id;
  const selected = await fetchJson(`/api/sessions/${encodeURIComponent(canvasRunStart.sessionId)}/artifacts/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifactId: selectedArtifactId }),
  });
  if (!selected.ok) throw new Error("artifact selection endpoint failed");
  const artifactContent = await fetchJson(
    `/api/sessions/${encodeURIComponent(canvasRunStart.sessionId)}/artifacts/${encodeURIComponent(selectedArtifactId)}`
  );
  if (!artifactContent.text && !artifactContent.dataUrl) {
    throw new Error("artifact content endpoint did not return renderable content");
  }

  const deleted = await fetchJson(`/api/sessions/${encodeURIComponent(runStart.sessionId)}`, {
    method: "DELETE",
  });
  if (!deleted.ok) throw new Error("session delete failed");

  const canvasDeleted = await fetchJson(`/api/sessions/${encodeURIComponent(canvasRunStart.sessionId)}`, {
    method: "DELETE",
  });
  if (!canvasDeleted.ok) throw new Error("canvas session delete failed");

  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoints: [
          "/api/config",
          "/api/keys/status",
          "/api/capabilities",
          "POST /api/keys/:provider",
          "/api/sandbox/status",
          "/api/sandbox/preflight",
          "/api/runs",
          "/api/sessions/:id/chat",
          "/api/sessions/:id/inbox",
          "POST /api/sessions/:id/inbox",
          "PATCH /api/sessions/:id/inbox/:itemId",
          "DELETE /api/sessions/:id/inbox/:itemId",
          "PATCH /api/sessions/:id",
          "POST /api/sessions/:id/auto-title",
          "DELETE /api/sessions/:id",
          "/api/workspace/changes",
          "/api/sessions/:id/artifacts",
          "/api/sessions/:id/artifacts/:artifactId",
          "POST /api/sessions/:id/artifacts/select",
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
