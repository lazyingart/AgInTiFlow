#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { generateImage, listAuxiliarySkills } from "../src/auxiliary-tools.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { providerKeyStatus, setProviderKey } from "../src/project.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-auxiliary-"));
const runtimeDir = path.join(tempRoot, "runtime");
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await setProviderKey(workspace, "grsai", "test-grsai-key");
  await setProviderKey(workspace, "venice", "test-venice-key");
  const keyStatus = providerKeyStatus(workspace);
  assert(keyStatus.grsai, "GRSAI key status was not detected");
  assert(keyStatus.venice, "Venice key status was not detected");
  assert(keyStatus.envVars.grsai.includes("GRSAI"), "GRSAI env var name was not reported");
  assert(listAuxiliarySkills().some((skill) => skill.id === "image_generation"), "image_generation skill missing");
  assert(listAuxiliarySkills().some((skill) => skill.id === "venice_image_generation"), "venice_image_generation skill missing");

  const dryRun = await generateImage(
    {
      prompt: "A small cyan robot holding a paintbrush, clean bright product illustration.",
      outputDir: "artifacts/images/dry-run",
      outputStem: "robot",
      dryRun: true,
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(dryRun.ok && dryRun.dryRun, "generate_image dry run failed");
  await fs.access(path.join(workspace, "artifacts/images/dry-run/task_manifest.json"));
  const payloadText = await fs.readFile(path.join(workspace, "artifacts/images/dry-run/request_payload.redacted.json"), "utf8");
  assert(payloadText.includes("nano-banana-2"), "redacted image payload was not written");
  const veniceDryRun = await generateImage(
    {
      provider: "venice",
      prompt: "A small cyan robot holding a paintbrush, clean bright product illustration.",
      outputDir: "artifacts/images/venice-dry-run",
      outputStem: "robot",
      dryRun: true,
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(veniceDryRun.ok && veniceDryRun.provider === "venice", "venice generate_image dry run failed");

  const blocked = await generateImage(
    {
      prompt: "blocked",
      outputDir: ".env/images",
      dryRun: true,
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(blocked.blocked, "generate_image did not block sensitive output path");

  const config = resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "Generate an image of a panda astronaut.",
      commandCwd: workspace,
      allowFileTools: true,
      allowAuxiliaryTools: true,
      maxSteps: 4,
    },
    {
      baseDir: runtimeDir,
      packageDir: repoRoot,
      provider: "mock",
    }
  );
  const run = await runAgent(config);
  const store = new SessionStore(config.sessionsDir, run.sessionId);
  const events = await store.loadEvents();
  assert(events.some((event) => event.type === "tool.completed" && event.data?.toolName === "generate_image"), "mock run did not call generate_image");
  await fs.access(path.join(workspace, "artifacts/images/mock-image/task_manifest.json"));

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspace,
        checks: [
          "grsai_key_status",
          "venice_key_status",
          "image_skill_listed",
          "venice_image_skill_listed",
          "generate_image_dry_run",
          "venice_generate_image_dry_run",
          "generate_image_guardrail",
          "mock_agent_image_tool",
        ],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
