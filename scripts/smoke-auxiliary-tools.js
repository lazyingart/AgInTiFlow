#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { runAgent } from "../src/agent-runner.js";
import { generateImage, listAuxiliarySkills } from "../src/auxiliary-tools.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { providerKeyStatus, setProviderKey } from "../src/project.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-auxiliary-"));
const originalImageEnv = {
  AGINTIFLOW_HOME: process.env.AGINTIFLOW_HOME,
  GRSAI: process.env.GRSAI,
  GRSAI_API_KEY: process.env.GRSAI_API_KEY,
  VENICE_API_KEY: process.env.VENICE_API_KEY,
  AGINTI_AUX_PROVIDER: process.env.AGINTI_AUX_PROVIDER,
};
process.env.AGINTIFLOW_HOME = path.join(tempRoot, ".agintiflow-home");
delete process.env.GRSAI;
delete process.env.GRSAI_API_KEY;
delete process.env.VENICE_API_KEY;
delete process.env.AGINTI_AUX_PROVIDER;
const runtimeDir = path.join(tempRoot, "runtime");
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await setProviderKey(workspace, "venice", "test-venice-key");
  const autoVeniceDryRun = await generateImage(
    {
      prompt: "A small cyan robot holding a paintbrush, clean bright product illustration.",
      outputDir: "artifacts/images/auto-venice-dry-run",
      outputStem: "robot",
      dryRun: true,
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(autoVeniceDryRun.ok && autoVeniceDryRun.provider === "venice", "generate_image did not auto-select Venice when only Venice image key was available");
  await setProviderKey(workspace, "grsai", "test-grsai-key");
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
  const referencePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAACJ7f8GAAAADElEQVR42mP8z8AARAAAIf4BfQKxMQAAAABJRU5ErkJggg==",
    "base64"
  );
  await fs.mkdir(path.join(workspace, "refs"), { recursive: true });
  await fs.writeFile(path.join(workspace, "refs/reference.png"), referencePng);
  const referenceDryRun = await generateImage(
    {
      prompt: "Use the reference image geometry for a diagnostic dry run.",
      outputDir: "artifacts/images/reference-dry-run",
      outputStem: "reference",
      referenceImages: ["refs/reference.png"],
      matchReferenceSize: true,
      dryRun: true,
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(referenceDryRun.ok && /Reference-size matching/i.test(referenceDryRun.geometryNotice || ""), "reference dry run did not report geometry notice");
  const referenceManifest = JSON.parse(await fs.readFile(path.join(workspace, "artifacts/images/reference-dry-run/task_manifest.json"), "utf8"));
  assert(referenceManifest.referenceImages?.[0]?.dimensions?.width === 2, "reference manifest did not record source image width");
  assert(referenceManifest.referenceImages?.[0]?.dimensions?.height === 3, "reference manifest did not record source image height");
  assert(referenceManifest.matchReferenceSize === true, "reference manifest did not record matchReferenceSize");
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
  const svgFallbackDryRun = await generateImage(
    {
      provider: "venice",
      prompt: "A simple geometric logo requested as SVG.",
      outputDir: "artifacts/images/svg-fallback-dry-run",
      outputStem: "logo.svg",
      format: "svg",
      dryRun: true,
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(svgFallbackDryRun.ok && svgFallbackDryRun.requestedFormat === "svg", "SVG fallback did not record requestedFormat");
  assert(svgFallbackDryRun.actualFormat === "png", "SVG fallback did not select PNG output");
  assert(/raster PNG/i.test(svgFallbackDryRun.formatNotice || ""), "SVG fallback did not explain the PNG fallback");
  const svgFallbackManifest = JSON.parse(
    await fs.readFile(path.join(workspace, "artifacts/images/svg-fallback-dry-run/task_manifest.json"), "utf8")
  );
  assert(svgFallbackManifest.requestedFormat === "svg" && svgFallbackManifest.actualFormat === "png", "SVG fallback manifest missing format contract");

  const cliImage = await execFile(
    process.execPath,
    [
      path.join(repoRoot, "bin/aginti-cli.js"),
      "--no-auto-update",
      "image",
      "--json",
      "--dry-run",
      "--cwd",
      workspace,
      "--provider",
      "venice",
      "--format",
      "svg",
      "--output-dir",
      "artifacts/images/cli-svg-fallback",
      "--output-stem",
      "diagram.svg",
      "A simple geometric diagram requested as SVG.",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, AGINTIFLOW_HOME: process.env.AGINTIFLOW_HOME },
    }
  );
  const cliImageResult = JSON.parse(cliImage.stdout);
  assert(cliImageResult.ok && cliImageResult.requestedFormat === "svg", "direct image CLI did not record requestedFormat");
  assert(cliImageResult.actualFormat === "png", "direct image CLI did not select PNG fallback");
  assert(/raster PNG/i.test(cliImageResult.formatNotice || ""), "direct image CLI did not explain SVG-to-PNG fallback");
  await fs.access(path.join(workspace, "artifacts/images/cli-svg-fallback/task_manifest.json"));
  const cliImageHelp = await execFile(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "--no-auto-update", "image", "--help"], {
    cwd: repoRoot,
    env: { ...process.env, AGINTIFLOW_HOME: process.env.AGINTIFLOW_HOME },
  });
  assert(cliImageHelp.stdout.includes("--reference"), "aginti image --help did not show reference-image options");
  assert(cliImageHelp.stdout.includes("--match-reference-size"), "aginti image --help did not show match-reference-size");

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
          "reference_image_manifest_dimensions",
          "auto_venice_when_grsai_missing",
          "venice_generate_image_dry_run",
          "svg_request_png_fallback",
          "direct_image_cli_svg_request_png_fallback",
          "direct_image_cli_subcommand_help",
          "generate_image_guardrail",
          "mock_agent_image_tool",
        ],
      },
      null,
      2
    )
  );
} finally {
  for (const [key, value] of Object.entries(originalImageEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
}
