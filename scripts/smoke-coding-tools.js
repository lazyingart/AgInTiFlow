#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairModelMessageHistory, runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-coding-tools-"));
const runtimeDir = path.join(tempRoot, "runtime");
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runMock(goal, sessionId) {
  const config = resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal,
      commandCwd: workspace,
      maxSteps: 5,
    },
    {
      baseDir: runtimeDir,
      packageDir: repoRoot,
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      commandCwd: workspace,
      allowShellTool: false,
      allowFileTools: true,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      sessionId,
    }
  );

  const result = await runAgent(config);
  const store = new SessionStore(config.sessionsDir, result.sessionId);
  return {
    result,
    events: await store.loadEvents(),
  };
}

try {
  const staleDeepSeekState = {
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "draw a figure" },
      { role: "assistant", content: "Execution plan:\n1. stale synthetic plan" },
      {
        role: "assistant",
        content: "I will call a tool.",
        tool_calls: [{ id: "stale-call", type: "function", function: { name: "list_files", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "stale-call", content: "{\"ok\":true}" },
      { role: "assistant", content: "Old final answer." },
    ],
  };
  const repair = repairModelMessageHistory(staleDeepSeekState, { provider: "deepseek" });
  assert(repair.changed, "stale DeepSeek history was not repaired");
  assert(
    staleDeepSeekState.messages.every(
      (message) => message.role !== "assistant" || message.reasoning_content || message.reasoningContent
    ),
    "repaired DeepSeek history still has assistant messages without reasoning_content"
  );
  assert(
    !staleDeepSeekState.messages.some((message) => message.role === "tool" && message.tool_call_id === "stale-call"),
    "repaired DeepSeek history retained an orphan stale tool message"
  );

  const writeRun = await runMock("Create file: notes/mock-output.txt with a short coding smoke message.", "coding-write");
  const written = await fs.readFile(path.join(workspace, "notes/mock-output.txt"), "utf8");
  assert(written.includes("Created by AgInTiFlow mock mode."), "mock write did not create expected file");
  assert(writeRun.events.some((event) => event.type === "file.changed"), "write run did not persist file.changed event");

  await runMock("Create file: /workspace/virtual-output.txt with virtual Docker path support.", "coding-write-virtual");
  const virtualWritten = await fs.readFile(path.join(workspace, "virtual-output.txt"), "utf8");
  assert(virtualWritten.includes("Created by AgInTiFlow mock mode."), "virtual /workspace path was not mapped safely");

  await fs.writeFile(path.join(workspace, "patch-target.txt"), "old\n", "utf8");
  const patchRun = await runMock("Patch file: patch-target.txt replace old with new.", "coding-patch");
  const patched = await fs.readFile(path.join(workspace, "patch-target.txt"), "utf8");
  assert(patched === "new\n", "mock patch did not update expected file");
  assert(patchRun.events.some((event) => event.type === "file.changed"), "patch run did not persist file.changed event");

  const envRun = await runMock("Create file: .env with blocked content.", "coding-block-env");
  await fs
    .access(path.join(workspace, ".env"))
    .then(() => {
      throw new Error(".env was created despite path guardrails");
    })
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  assert(envRun.events.some((event) => event.type === "tool.blocked"), ".env guardrail did not emit tool.blocked");

  const outsideRun = await runMock("Create file: ../outside-workspace.txt with blocked content.", "coding-block-outside");
  await fs
    .access(path.join(tempRoot, "outside-workspace.txt"))
    .then(() => {
      throw new Error("outside-workspace.txt was created despite path guardrails");
    })
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  assert(outsideRun.events.some((event) => event.type === "tool.blocked"), "outside path guardrail did not emit tool.blocked");

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspace,
        checks: [
          "deepseek_history_repair",
          "write_file",
          "virtual_workspace_path",
          "apply_patch",
          "block_env",
          "block_outside",
        ],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
