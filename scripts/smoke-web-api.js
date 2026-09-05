#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../src/session-store.js";
import { projectPaths, sessionStoreOptions } from "../src/project.js";
import { WebDatabase } from "../src/web-db.js";
import { allocateLoopbackTestPort } from "./fixtures/loopback-test-port.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureMcpServer = path.join(repoRoot, "scripts", "fixtures", "mcp-stdio-smoke-server.mjs");
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-api-smoke-root-"));
const runtimeDir = path.join(fixtureRoot, "workspace");
await fs.mkdir(runtimeDir, { recursive: true });
const agintiflowHome = path.join(runtimeDir, ".agintiflow-home");
process.env.AGINTIFLOW_HOME = agintiflowHome;
const port = await allocateLoopbackTestPort();
let baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "web", "--port", String(port), "--host", "127.0.0.1"], {
  cwd: runtimeDir,
  env: {
    ...process.env,
    AGINTIFLOW_NO_AUTO_UPDATE: "1",
    AGINTIFLOW_RUNTIME_DIR: runtimeDir,
    AGINTIFLOW_HOME: agintiflowHome,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
  const announcedUrl = stdout.match(/Website control agent UI running on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  if (announcedUrl) baseUrl = announcedUrl;
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
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    const announcedUrl = stdout.match(/Website control agent UI running on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!announcedUrl) {
      await delay(100);
      continue;
    }
    baseUrl = announcedUrl;
    try {
      const health = await fetchJson("/health");
      if (health.ok) return health;
    } catch {
      await delay(250);
    }
  }

  throw new Error(`web server did not become healthy. stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`);
}

async function waitForRun(sessionId, terminalStatuses = ["finished", "failed"]) {
  const acceptedStatuses = new Set(terminalStatuses);
  const deadline = Date.now() + 20000;
  let lastRun = null;
  while (Date.now() < deadline) {
    const run = await fetchJson(`/api/runs/${encodeURIComponent(sessionId)}`);
    lastRun = run;
    if (acceptedStatuses.has(run.status)) return run;
    await delay(400);
  }
  throw new Error(
    `run ${sessionId} did not finish in time; ` +
      `lastRun=${JSON.stringify(lastRun ? {
        status: lastRun.status,
        error: lastRun.error,
        endedAt: lastRun.endedAt,
        logs: Array.isArray(lastRun.logs) ? lastRun.logs.slice(-12) : [],
      } : null)} ` +
      `stdout=${stdout.slice(-1000)} stderr=${stderr.slice(-1000)}`
  );
}

try {
  await waitForHealth();
  await fs.mkdir(path.join(runtimeDir, ".aginti"), { recursive: true });
  await fs.writeFile(
    path.join(runtimeDir, ".aginti", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        smoke: {
          transport: "stdio",
          command: process.execPath,
          args: [fixtureMcpServer],
          trust: "trusted",
          allowedTools: ["echo"],
        },
      },
    })
  );
  await fs.mkdir(path.join(runtimeDir, "notes"), { recursive: true });
  await fs.mkdir(path.join(runtimeDir, "data"), { recursive: true });
  await fs.writeFile(path.join(runtimeDir, "notes", "workspace-smoke.md"), "# Workspace smoke\n\nEditable text.\n");
  await fs.writeFile(path.join(runtimeDir, "data", "workspace-smoke.csv"), "sample,value\nalpha,1\n");
  await fs.writeFile(path.join(runtimeDir, ".aginti", ".env"), "DEEPSEEK_API_KEY=should-not-render\n");

  const webAppHtml = await fs.readFile(path.join(repoRoot, "public", "index.html"), "utf8");
  const chatThreadIndex = webAppHtml.indexOf('id="chat-thread"');
  const chatPendingIndex = webAppHtml.indexOf('id="chat-pending"');
  if (chatThreadIndex < 0 || chatPendingIndex < 0 || chatPendingIndex < chatThreadIndex) {
    throw new Error("pending message panel must render below the chat thread");
  }
  for (const marker of [
    'id="new-session"',
    'id="run-state"',
    'id="toast-region"',
    'id="chat-submit"',
    'id="command-cwd-suggestions"',
    'id="workspace-explorer"',
    'id="workspace-workbench"',
    'id="workspace-editor"',
    'id="enableScs"',
    'id="aapsModeToggle"',
    'id="veniceModeToggle"',
    'id="dynamicSteps"',
  ]) {
    if (!webAppHtml.includes(marker)) throw new Error(`web UI is missing ${marker}`);
  }
  if (webAppHtml.includes('id="goal"') || /<button[^>]+type="submit"[^>]*>\s*Start run\s*<\/button>/i.test(webAppHtml)) {
    throw new Error("web UI still exposes the old separate goal/start-run form");
  }

  const config = await fetchJson("/api/config");
  if (!config.keyStatus?.localllm) throw new Error("LocalLLM provider is not advertised by /api/config");
  if (!config.keyStatus?.mock) throw new Error("mock provider is not advertised by /api/config");
  const invalidProviderResponse = await fetch(`${baseUrl}/api/preferences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "not-a-provider" }),
  });
  const invalidProviderBody = await invalidProviderResponse.json().catch(() => ({}));
  if (
    invalidProviderResponse.status !== 400 ||
    invalidProviderBody.code !== "INVALID_PROVIDER" ||
    invalidProviderBody.provider !== "not-a-provider"
  ) {
    throw new Error(`unknown web provider did not fail closed: ${JSON.stringify(invalidProviderBody)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(config.keyStatus || {}, "openrouter")) {
    throw new Error("OpenRouter key status is not advertised by /api/config");
  }
  if (config.defaults?.openrouter?.baseURL !== "https://openrouter.ai/api/v1") {
    throw new Error(`OpenRouter defaults are missing from /api/config: ${JSON.stringify(config.defaults?.openrouter)}`);
  }
  if (!config.modelCatalog?.openrouter?.some((model) => model.id === "openrouter/auto")) {
    throw new Error("OpenRouter model catalog is missing from /api/config");
  }
  if (
    !config.modelCatalog?.localllm?.some((model) => model.id === "localllm-fast") ||
    !config.modelCatalog?.localllm?.some((model) => model.id === "localllm-deep")
  ) {
    throw new Error("LocalLLM model catalog is missing fast/deep aliases from /api/config");
  }
  if (!config.modelGroups?.["openrouter-openai"]) {
    throw new Error("OpenRouter company model groups are missing from /api/config");
  }
  const agentLinkStatus = await fetchJson("/api/agentlink/status");
  if (agentLinkStatus.feature !== "agentlink" || agentLinkStatus.rawSessionSharing !== false) {
    throw new Error("AgentLink status endpoint returned an invalid payload");
  }
  const agentLinkBoard = await fetchJson("/api/agentlink/boards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ boardId: "web-smoke", title: "Web AgentLink smoke", objective: "Exercise web AgentLink API." }),
  });
  if (agentLinkBoard.board?.boardId !== "web-smoke") throw new Error("AgentLink board create endpoint failed");
  const agentLinkMessage = await fetchJson("/api/agentlink/boards/web-smoke/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "web smoke message", kind: "status" }),
  });
  if (!agentLinkMessage.message?.messageId) throw new Error("AgentLink message endpoint failed");
  const agentLinkEvidence = await fetchJson("/api/agentlink/boards/web-smoke/evidence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: "web smoke evidence", path: "notes/workspace-smoke.md" }),
  });
  if (!agentLinkEvidence.evidence?.evidenceId) throw new Error("AgentLink evidence endpoint failed");
  const agentLinkRead = await fetchJson("/api/agentlink/boards/web-smoke");
  if (!agentLinkRead.messages?.length || !agentLinkRead.evidence?.length) {
    throw new Error("AgentLink board read endpoint did not include messages and evidence");
  }
  if (!config.workspace?.enabled) throw new Error("workspace file tools are not advertised by /api/config");
  if (config.preferences?.preferredWrapper !== "codex") throw new Error("Codex is not the default preferred wrapper");
  if (config.project?.root !== runtimeDir) throw new Error("web project root did not default to launch directory");
  if (config.preferences?.commandCwd !== runtimeDir) throw new Error("commandCwd did not default to project root");
  const pathSuggest = await fetchJson(`/api/path-suggestions?q=${encodeURIComponent(runtimeDir.slice(0, runtimeDir.lastIndexOf("/")))}`);
  if (!pathSuggest.ok || !Array.isArray(pathSuggest.suggestions) || !pathSuggest.suggestions.some((item) => item === runtimeDir)) {
    throw new Error(`path suggestions did not include the runtime directory: ${JSON.stringify(pathSuggest)}`);
  }
  const pathChildren = await fetchJson(`/api/path-children?path=${encodeURIComponent(path.dirname(runtimeDir))}`);
  if (!pathChildren.ok || !pathChildren.children?.some((item) => item.path === runtimeDir && item.kind === "directory")) {
    throw new Error(`path children did not include the runtime directory: ${JSON.stringify(pathChildren)}`);
  }
  const workspaceSnapshot = await fetchJson("/api/workspace/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandCwd: runtimeDir }),
  });
  if (!workspaceSnapshot.ok || workspaceSnapshot.root !== runtimeDir) {
    throw new Error(`workspace snapshot root mismatch: ${JSON.stringify(workspaceSnapshot)}`);
  }
  if (!workspaceSnapshot.files?.some((file) => file.path === "notes/workspace-smoke.md" && file.content.includes("Editable text."))) {
    throw new Error(`workspace snapshot did not include editable note: ${JSON.stringify(workspaceSnapshot.files?.slice(0, 5))}`);
  }
  if (workspaceSnapshot.files?.some((file) => file.path === ".aginti/.env" || file.path === ".aginti/mcp.json" || file.path === ".env")) {
    throw new Error(`workspace snapshot exposed protected internal/secret files: ${JSON.stringify(workspaceSnapshot.files?.slice(0, 10))}`);
  }
  const rawWorkspaceResponse = await fetch(
    `${baseUrl}/api/workspace/raw?commandCwd=${encodeURIComponent(runtimeDir)}&path=${encodeURIComponent("notes/workspace-smoke.md")}`
  );
  const rawWorkspaceText = await rawWorkspaceResponse.text();
  if (!rawWorkspaceResponse.ok || !rawWorkspaceText.includes("Workspace smoke")) {
    throw new Error(`workspace raw endpoint failed: status=${rawWorkspaceResponse.status} body=${rawWorkspaceText.slice(0, 120)}`);
  }
  const protectedRawResponse = await fetch(
    `${baseUrl}/api/workspace/raw?commandCwd=${encodeURIComponent(runtimeDir)}&path=${encodeURIComponent(".aginti/.env")}`
  );
  if (protectedRawResponse.ok) {
    throw new Error("workspace raw endpoint exposed protected .aginti/.env");
  }
  const protectedWriteResponse = await fetch(`${baseUrl}/api/workspace/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandCwd: runtimeDir, path: ".env", content: "SECRET=blocked\n" }),
  });
  if (protectedWriteResponse.ok) {
    throw new Error("workspace write endpoint allowed protected .env");
  }
  const writtenWorkspace = await fetchJson("/api/workspace/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandCwd: runtimeDir, path: "notes/workspace-written.md", content: "written from web api\n" }),
  });
  if (!writtenWorkspace.ok || (await fs.readFile(path.join(runtimeDir, "notes", "workspace-written.md"), "utf8")) !== "written from web api\n") {
    throw new Error("workspace write endpoint did not persist expected content");
  }
  const renamedWorkspace = await fetchJson("/api/workspace/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandCwd: runtimeDir, from: "notes/workspace-written.md", to: "notes/workspace-renamed.md" }),
  });
  if (!renamedWorkspace.ok || !(await fs.stat(path.join(runtimeDir, "notes", "workspace-renamed.md")).then(() => true).catch(() => false))) {
    throw new Error("workspace rename endpoint did not move the file");
  }
  const deletedWorkspace = await fetchJson("/api/workspace/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandCwd: runtimeDir, path: "notes/workspace-renamed.md" }),
  });
  if (!deletedWorkspace.ok || (await fs.stat(path.join(runtimeDir, "notes", "workspace-renamed.md")).then(() => true).catch(() => false))) {
    throw new Error("workspace delete endpoint did not remove the file");
  }
  const traversalResponse = await fetch(`${baseUrl}/api/workspace/raw?commandCwd=${encodeURIComponent(runtimeDir)}&path=../escape.txt`);
  if (traversalResponse.ok) throw new Error("workspace raw endpoint allowed path traversal");
  const imageApiDryRun = await fetchJson("/api/auxiliary/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commandCwd: runtimeDir,
      provider: "venice",
      prompt: "A compact logo requested as SVG for API fallback testing.",
      format: "svg",
      outputDir: "artifacts/images/api-svg-fallback",
      outputStem: "api-logo.svg",
      dryRun: true,
    }),
  });
  if (!imageApiDryRun.ok || imageApiDryRun.requestedFormat !== "svg" || imageApiDryRun.actualFormat !== "png") {
    throw new Error(`direct auxiliary image API did not return SVG-to-PNG fallback: ${JSON.stringify(imageApiDryRun)}`);
  }
  await fs.access(path.join(runtimeDir, "artifacts/images/api-svg-fallback/task_manifest.json"));
  if (config.preferences?.sandboxMode !== "docker-workspace") throw new Error("web did not default to docker workspace");
  if (config.preferences?.packageInstallPolicy !== "allow") throw new Error("web did not default to Docker package installs");
  if (config.preferences?.permissionMode !== "normal") throw new Error("web did not default to normal permission mode");
  if (config.preferences?.workspaceWritePolicy !== "allow") throw new Error("web did not default to workspace writes allowed");
  if (config.preferences?.enableScs !== "auto") throw new Error("web did not default to CLI-aligned SCS auto mode");
  if (config.preferences?.dynamicSteps !== "auto") throw new Error("web did not default to CLI-aligned dynamic steps auto mode");
  if (config.preferences?.veniceMode !== false) throw new Error("web should default Venice shortcut mode off");
  if (config.preferences?.allowAuxiliaryTools !== false) throw new Error("hosted auxiliary tools should default off");
  if (Number(config.preferences?.maxSteps) < 24) throw new Error("web default max steps is too low");
  if (!Array.isArray(config.taskProfiles) || !config.taskProfiles.some((profile) => profile.id === "latex")) {
    throw new Error("task profiles are not advertised by /api/config");
  }
  if (!Array.isArray(config.skills) || !config.skills.some((skill) => skill.id === "website-app")) {
    throw new Error("built-in skills are not advertised by /api/config");
  }
  if (!Array.isArray(config.skillPacks)) {
    throw new Error("skill packs are not advertised by /api/config");
  }
  if (!config.mcp?.servers?.some((server) => server.id === "smoke" && server.allowHostProcess === true)) {
    throw new Error("MCP servers are not advertised by /api/config");
  }
  if (!config.modelCatalog?.venice?.some((model) => model.id === "venice-uncensored-1-2")) {
    throw new Error("venice model catalog is not advertised by /api/config");
  }
  if (
    config.modelRoles?.route?.provider !== "localllm" ||
    config.modelRoles?.route?.model !== "localllm-fast" ||
    config.modelRoles?.main?.provider !== "localllm" ||
    config.modelRoles?.main?.model !== "localllm-deep"
  ) {
    throw new Error("model role defaults are not advertised by /api/config");
  }
  if (!config.modelGroups?.["venice-gpt"] || !config.auxiliaryModelCatalog?.["venice-image"]) {
    throw new Error("model provider groups are not advertised by /api/config");
  }

  const keyStatus = await fetchJson("/api/keys/status");
  if (keyStatus.keyStatus?.localllm !== true) throw new Error("LocalLLM keyless status is missing");
  if (typeof keyStatus.keyStatus?.deepseek !== "boolean") throw new Error("key status endpoint is invalid");
  if (typeof keyStatus.keyStatus?.qwen !== "boolean") throw new Error("qwen key status is missing");
  if (typeof keyStatus.keyStatus?.venice !== "boolean") throw new Error("venice key status is missing");
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
  if (!capabilities.tools?.mcp?.servers?.some((server) => server.id === "smoke")) {
    throw new Error("capability endpoint did not report MCP config");
  }
  const mcpStatus = await fetchJson("/api/mcp");
  if (!mcpStatus.servers?.some((server) => server.id === "smoke")) {
    throw new Error("MCP status endpoint did not report configured smoke server");
  }
  const savedKey = await fetchJson("/api/keys/deepseek", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "test-deepseek-key-not-real" }),
  });
  if (!savedKey.ok || !savedKey.keyStatus?.deepseek || "apiKey" in savedKey || "key" in savedKey) {
    throw new Error("local key save endpoint returned invalid or sensitive data");
  }
  const savedQwenKey = await fetchJson("/api/keys/qwen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "test-qwen-key-not-real" }),
  });
  if (!savedQwenKey.ok || !savedQwenKey.keyStatus?.qwen || "apiKey" in savedQwenKey || "key" in savedQwenKey) {
    throw new Error("qwen local key save endpoint returned invalid or sensitive data");
  }
  const savedVeniceKey = await fetchJson("/api/keys/venice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "test-venice-key-not-real" }),
  });
  if (!savedVeniceKey.ok || !savedVeniceKey.keyStatus?.venice || "apiKey" in savedVeniceKey || "key" in savedVeniceKey) {
    throw new Error("venice local key save endpoint returned invalid or sensitive data");
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
      routeModel: "deepseek-v4-flash",
      mainModel: "deepseek-v4-pro",
      spareProvider: "openai",
      spareModel: "gpt-5.4",
      auxiliaryProvider: "grsai",
      auxiliaryModel: "nano-banana-2",
      goal: "Report the current working directory with a safe command.",
      enableScs: "off",
      dynamicSteps: "off",
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
  const fileChat = await fetchJson(`/api/sessions/${encodeURIComponent(fileRunStart.sessionId)}/chat`);
  if (fileChat.runtime?.provider !== "mock" || fileChat.runtimeRevision !== 1) {
    throw new Error(`saved session runtime metadata is missing or invalid: ${JSON.stringify(fileChat.runtime)}`);
  }
  const fileChange = fileChat.timeline?.find((entry) => entry.role === "event" && entry.eventType === "file.changed");
  if (!fileChange?.data?.diff || !fileChange.data.diff.includes("+Created by AgInTiFlow mock mode.")) {
    throw new Error("chat timeline did not preserve structured file-change diff data");
  }

  const staleContinuation = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(fileRunStart.sessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "This stale continuation must not run.", expectedRuntimeRevision: 99 }),
  });
  const staleContinuationBody = await staleContinuation.json().catch(() => ({}));
  if (staleContinuation.status !== 409 || staleContinuationBody.code !== "SESSION_RUNTIME_CONFLICT") {
    throw new Error(`stale session runtime continuation did not fail before execution: ${JSON.stringify(staleContinuationBody)}`);
  }

  const localRuntimeContinuation = await fetchJson(
    `/api/sessions/${encodeURIComponent(fileRunStart.sessionId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Explain briefly why a saved runtime should stay provider-neutral.",
        expectedRuntimeRevision: fileChat.runtimeRevision,
        provider: "openai",
        model: "gpt-5.5",
        routeProvider: "deepseek",
        mainProvider: "openai",
      }),
    }
  );
  const continuedLocalRun = await waitForRun(localRuntimeContinuation.sessionId);
  if (continuedLocalRun.status !== "finished" || continuedLocalRun.provider !== "mock") {
    throw new Error(`saved mock runtime drifted to incoming hosted preferences: ${JSON.stringify(continuedLocalRun)}`);
  }
  const continuedState = await new SessionStore(projectPaths(runtimeDir).globalSessionsDir, fileRunStart.sessionId, {
    ...sessionStoreOptions(runtimeDir),
    projectSessionsDir: projectPaths(runtimeDir).sessionsDir,
  }).loadState();
  if (
    continuedState?.provider !== "mock" ||
    continuedState?.model !== "mock-agent" ||
    continuedState?.meta?.runtimeConfig?.provider !== "mock"
  ) {
    throw new Error(`saved effective runtime drifted: ${JSON.stringify(continuedState?.meta?.runtimeConfig)}`);
  }

  const raceRunStart = await fetchJson("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "Explain one benefit of revision checks.",
      commandCwd: runtimeDir,
      allowShellTool: false,
      allowFileTools: false,
      maxSteps: 4,
      headless: true,
    }),
  });
  await waitForRun(raceRunStart.sessionId);
  const raceChat = await fetchJson(`/api/sessions/${encodeURIComponent(raceRunStart.sessionId)}/chat`);
  const concurrentBodies = ["Concurrent continuation A", "Concurrent continuation B"];
  const concurrentResponses = await Promise.all(
    concurrentBodies.map((content) =>
      fetch(`${baseUrl}/api/sessions/${encodeURIComponent(raceRunStart.sessionId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, expectedRuntimeRevision: raceChat.runtimeRevision }),
      })
    )
  );
  const concurrentStatuses = concurrentResponses.map((response) => response.status);
  const concurrentResponseBodies = await Promise.all(
    concurrentResponses.map((response) => response.json().catch(() => ({})))
  );
  const startedCount = concurrentResponseBodies.filter((body, index) => concurrentStatuses[index] === 200 && !body.queued).length;
  const safelyDeferredCount = concurrentResponseBodies.filter(
    (body, index) => concurrentStatuses[index] === 409 || (concurrentStatuses[index] === 200 && body.queued === true)
  ).length;
  if (startedCount !== 1 || safelyDeferredCount !== 1) {
    throw new Error(
      `concurrent continuations were not serialized or durably queued: ${JSON.stringify({ concurrentStatuses, concurrentResponseBodies })}`
    );
  }
  await waitForRun(raceRunStart.sessionId);
  const racedState = await new SessionStore(projectPaths(runtimeDir).globalSessionsDir, raceRunStart.sessionId, {
    ...sessionStoreOptions(runtimeDir),
    projectSessionsDir: projectPaths(runtimeDir).sessionsDir,
  }).loadState();
  const acceptedConcurrentTurns = (racedState?.messages || []).filter(
    (message) => message.role === "user" && concurrentBodies.some((content) => String(message.content || "").includes(content))
  );
  const racedChat = await fetchJson(`/api/sessions/${encodeURIComponent(raceRunStart.sessionId)}/chat`);
  const queuedConcurrentTurns = (racedChat.inbox || []).filter((item) => concurrentBodies.includes(item.content));
  const queuedResponseCount = concurrentResponseBodies.filter((body) => body.queued === true).length;
  const expectedDurableTurns = 1 + queuedResponseCount;
  if (acceptedConcurrentTurns.length + queuedConcurrentTurns.length < expectedDurableTurns) {
    throw new Error(
      `concurrent continuation race was not safe: ${JSON.stringify({ accepted: acceptedConcurrentTurns.length, queued: queuedConcurrentTurns.length })}`
    );
  }

  const approvalRaceStart = await fetchJson("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      permissionMode: "safe",
      goal: "Create notes/safe-web-approval-race.md with serialized approval content.",
      commandCwd: runtimeDir,
      allowShellTool: false,
      allowFileTools: true,
      maxSteps: 4,
      headless: true,
    }),
  });
  const approvalRaceBlocked = await waitForRun(approvalRaceStart.sessionId, ["stopped", "failed"]);
  if (approvalRaceBlocked.status !== "stopped") {
    throw new Error(`permission/message race fixture did not stop for approval: ${approvalRaceBlocked.status}`);
  }
  if (!approvalRaceBlocked.logs?.some((entry) => entry.message === "tool.blocked" && entry.data?.permissionAdvice)) {
    throw new Error("permission/message race fixture did not produce pending permission advice");
  }
  const approvalRaceChat = await fetchJson(`/api/sessions/${encodeURIComponent(approvalRaceStart.sessionId)}/chat`);
  const [approvalRaceResponse, messageRaceResponse] = await Promise.all([
    fetch(`${baseUrl}/api/sessions/${encodeURIComponent(approvalRaceStart.sessionId)}/approve-permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "once", expectedRuntimeRevision: approvalRaceChat.runtimeRevision }),
    }),
    fetch(`${baseUrl}/api/sessions/${encodeURIComponent(approvalRaceStart.sessionId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "This continuation must not race the permission approval.",
        expectedRuntimeRevision: approvalRaceChat.runtimeRevision,
      }),
    }),
  ]);
  const approvalRaceStatuses = [approvalRaceResponse.status, messageRaceResponse.status].sort((a, b) => a - b);
  if (approvalRaceStatuses[0] !== 200 || approvalRaceStatuses[1] !== 409) {
    const bodies = await Promise.all([
      approvalRaceResponse.json().catch(() => ({})),
      messageRaceResponse.json().catch(() => ({})),
    ]);
    throw new Error(`permission approval and message preparation were not serialized: ${JSON.stringify({ approvalRaceStatuses, bodies })}`);
  }
  await waitForRun(approvalRaceStart.sessionId);

  const safeRunStart = await fetchJson("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      permissionMode: "safe",
      goal: "Create notes/safe-web-approval.md with web approval content.",
      commandCwd: runtimeDir,
      allowShellTool: false,
      allowFileTools: true,
      preferredWrapper: "codex",
      maxSteps: 4,
      headless: true,
    }),
  });
  const safeRun = await waitForRun(safeRunStart.sessionId, ["stopped", "failed"]);
  if (safeRun.status !== "stopped") {
    throw new Error(`safe mode web run did not stop for approval: ${safeRun.status}`);
  }
  if (!safeRun.logs?.some((entry) => entry.message === "tool.blocked" && entry.data?.permissionAdvice?.category === "workspace-write")) {
    throw new Error("safe mode web run did not expose workspace-write permission advice");
  }
  const safePath = path.join(runtimeDir, "notes", "safe-web-approval.md");
  const beforeApprovalExists = await fs.stat(safePath).then(() => true).catch(() => false);
  if (beforeApprovalExists) throw new Error("safe mode created a file before approval");
  const safeChat = await fetchJson(`/api/sessions/${encodeURIComponent(safeRunStart.sessionId)}/chat`);
  const approval = await fetchJson(`/api/sessions/${encodeURIComponent(safeRunStart.sessionId)}/approve-permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "once",
      expectedRuntimeRevision: safeChat.runtimeRevision,
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
    }),
  });
  if (!approval.ok || approval.permissionMode !== "normal") throw new Error("permission approval endpoint did not escalate to normal");
  if (approval.runtimeRevision !== safeChat.runtimeRevision + 1) {
    throw new Error("permission runtime patch did not advance the session revision exactly once");
  }
  const approvedRun = await waitForRun(safeRunStart.sessionId);
  if (approvedRun.status !== "finished") {
    throw new Error(
      `permission-approved continuation did not finish: ${approvedRun.error || approvedRun.status}; logs=${JSON.stringify(
        approvedRun.logs?.slice(-12) || []
      )}`
    );
  }
  const safeApproved = await fs.readFile(safePath, "utf8");
  if (!safeApproved.includes("Created by AgInTiFlow mock mode.")) {
    throw new Error("permission-approved continuation did not create the requested file");
  }
  const staleApproval = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(safeRunStart.sessionId)}/approve-permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "once" }),
  });
  if (staleApproval.status !== 404) {
    throw new Error(`resolved permission advice remained reusable: ${staleApproval.status}`);
  }
  await fetchJson("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "mock", routingMode: "manual", model: "mock-agent", permissionMode: "normal", commandCwd: runtimeDir }),
  });

  const chat = await fetchJson(`/api/sessions/${encodeURIComponent(runStart.sessionId)}/chat`);
  if (!Array.isArray(chat.chat) || chat.chat.length < 2) throw new Error("chat history was not persisted");
  if (!Array.isArray(chat.inbox)) throw new Error("chat endpoint did not include shared inbox state");
  if (!Array.isArray(chat.events) || !chat.events.some((entry) => entry.type === "plan.skipped")) {
    throw new Error("chat endpoint did not include the focused execution plan decision");
  }
  if (
    !Array.isArray(chat.timeline) ||
    !chat.timeline.some((entry) => entry.role === "event" && entry.eventType === "plan.skipped" && String(entry.content || "").trim())
  ) {
    throw new Error("chat endpoint did not return a resume-ready timeline with the focused execution decision");
  }

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
  const paths = projectPaths(runtimeDir);
  const inboxStore = new SessionStore(paths.globalSessionsDir, runStart.sessionId, sessionStoreOptions(runtimeDir, runStart.sessionId));
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

  const staleSessionId = "stale-running-smoke";
  const staleStore = new SessionStore(paths.globalSessionsDir, staleSessionId, sessionStoreOptions(runtimeDir, staleSessionId));
  await staleStore.ensure();
  await staleStore.appendEvent("session.finished", {
    result: "stale running session reconciled",
    mode: "smoke",
  });
  const staleDb = new WebDatabase(runtimeDir);
  staleDb.upsertSession({
    sessionId: staleSessionId,
    provider: "mock",
    model: "mock-agent",
    goal: "Synthetic stale running session.",
    status: "running",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 30_000).toISOString(),
    endedAt: "",
    result: "",
    error: "",
    projectRoot: runtimeDir,
    commandCwd: runtimeDir,
    projectSessionsDir: paths.sessionsDir,
    sessionDir: staleStore.sessionDir,
  });
  const reconciledStaleRun = await fetchJson(`/api/runs/${encodeURIComponent(staleSessionId)}`);
  if (reconciledStaleRun.status !== "finished" || !reconciledStaleRun.result.includes("reconciled")) {
    throw new Error(`orphaned running session was not reconciled: ${JSON.stringify(reconciledStaleRun)}`);
  }

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

  const largeSessionId = "large-artifact-smoke";
  const largeStore = new SessionStore(paths.globalSessionsDir, largeSessionId, sessionStoreOptions(runtimeDir, largeSessionId));
  await largeStore.ensure();
  const largeCanvasDir = path.join(largeStore.artifactsDir, "canvas");
  await fs.mkdir(largeCanvasDir, { recursive: true });
  const largeImagePath = path.join(largeCanvasDir, "large-image.png");
  await fs.writeFile(largeImagePath, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(4_200_000)]));
  await largeStore.appendEvent("canvas.item", {
    artifactId: "large-image",
    title: "Large streamed image",
    kind: "image",
    path: "large-image.png",
    sessionFilePath: largeImagePath,
    selected: true,
  });
  const largeArtifacts = await fetchJson(`/api/sessions/${encodeURIComponent(largeSessionId)}/artifacts`);
  if (!largeArtifacts.items?.some((item) => item.id === "large-image")) {
    throw new Error("large artifact endpoint did not list session artifact");
  }
  const largeContent = await fetchJson(`/api/sessions/${encodeURIComponent(largeSessionId)}/artifacts/large-image`);
  if (!largeContent.tooLargeForInline || !largeContent.url || largeContent.dataUrl) {
    throw new Error("large artifact metadata did not switch to streamed preview");
  }
  const rawResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(largeSessionId)}/artifacts/large-image/raw`);
  if (!rawResponse.ok) throw new Error(`large artifact raw endpoint failed: ${rawResponse.status}`);
  if (!/^image\/png\b/i.test(rawResponse.headers.get("content-type") || "")) {
    throw new Error("large artifact raw endpoint did not preserve image content type");
  }
  const rawBytes = await rawResponse.arrayBuffer();
  if (rawBytes.byteLength <= 4_000_000) throw new Error("large artifact raw endpoint returned truncated content");

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
          "/api/mcp",
          "/api/agentlink/status",
          "/api/agentlink/peers",
          "/api/agentlink/boards",
          "POST /api/agentlink/boards",
          "/api/agentlink/boards/:boardId",
          "POST /api/agentlink/boards/:boardId/messages",
          "POST /api/agentlink/boards/:boardId/evidence",
          "POST /api/keys/:provider",
          "/api/sandbox/status",
          "/api/sandbox/preflight",
          "/api/runs",
          "POST /api/sessions/:id/approve-permission",
          "/api/sessions/:id/chat",
          "/api/sessions/:id/inbox",
          "POST /api/sessions/:id/inbox",
          "PATCH /api/sessions/:id/inbox/:itemId",
          "DELETE /api/sessions/:id/inbox/:itemId",
          "PATCH /api/sessions/:id",
          "POST /api/sessions/:id/auto-title",
          "DELETE /api/sessions/:id",
          "/api/path-children",
          "POST /api/workspace/snapshot",
          "/api/workspace/raw",
          "POST /api/workspace/write",
          "POST /api/workspace/rename",
          "POST /api/workspace/delete",
          "POST /api/auxiliary/generate-image",
          "/api/workspace/changes",
          "stale running status reconciliation",
          "/api/sessions/:id/artifacts",
          "/api/sessions/:id/artifacts/:artifactId",
          "/api/sessions/:id/artifacts/:artifactId/raw",
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
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
