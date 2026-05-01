#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
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
  const writeRun = await runMock("Create file: notes/mock-output.txt with a short coding smoke message.", "coding-write");
  const written = await fs.readFile(path.join(workspace, "notes/mock-output.txt"), "utf8");
  assert(written.includes("Created by AgInTiFlow mock mode."), "mock write did not create expected file");
  assert(writeRun.events.some((event) => event.type === "file.changed"), "write run did not persist file.changed event");

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
        checks: ["write_file", "apply_patch", "block_env", "block_outside"],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
