#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { checkToolUse } from "../src/guardrails.js";
import { firstJsonObject, readImage, researchWrapper, webResearch } from "../src/perception-tools.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-perception-research-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, ".agintiflow-home");
const runtimeDir = path.join(tempRoot, "runtime");
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(path.join(workspace, "artifacts", "screenshots"), { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const pngPath = path.join(workspace, "artifacts", "screenshots", "tiny.png");
  await fs.writeFile(
    pngPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64")
  );

  const store = new SessionStore(path.join(runtimeDir, "sessions"), "perception-research-smoke");
  await store.ensure();
  const config = {
    commandCwd: workspace,
    allowFileTools: true,
    allowWebSearch: true,
    allowWrapperTools: true,
    preferredWrapper: "codex",
    webSearchDryRun: true,
  };

  const repairedImageJson = firstJsonObject(
    '{"summary":"A simple red square is visible.","visibleText":[],"observations":["The shape is a square."],"issues":[],"answer":"A red square.","uncertainty":[],\r\n}'
  );
  assert(repairedImageJson?.answer === "A red square.", "read_image did not repair a common trailing-comma near-JSON response");

  const fencedWrapperJson = firstJsonObject('```json\n{"ok":true,"task":"read_image","summary":"done",}\n```');
  assert(fencedWrapperJson?.summary === "done", "research_wrapper did not repair fenced trailing-comma near-JSON");

  const image = await readImage(
    {
      path: "artifacts/screenshots/tiny.png",
      prompt: "Describe this tiny image.",
      dryRun: true,
    },
    config,
    store
  );
  assert(image.ok, `read_image dry-run failed: ${image.error || "unknown"}`);
  assert(image.images?.[0]?.sha256, "read_image did not record image hash");
  assert(image.artifactPath, "read_image did not persist a perception artifact");
  await fs.access(image.artifactPath);

  const secretBlock = checkToolUse({
    toolName: "read_image",
    args: { path: ".env" },
    snapshot: { elements: [] },
    config,
  });
  assert(!secretBlock.allowed, "read_image did not block a sensitive path");

  const research = await webResearch(
    {
      query: "AgInTiFlow smoke current docs",
      maxResults: 2,
    },
    config,
    store
  );
  assert(research.ok, `web_research dry-run failed: ${research.error || "unknown"}`);
  assert(research.sources?.length === 1, "web_research did not return dry-run sources");
  assert(research.artifactPath, "web_research did not persist a research artifact");
  await fs.access(research.artifactPath);

  const wrapper = await researchWrapper(
    {
      task: "web_research",
      query: "AgInTiFlow wrapper smoke",
      dryRun: true,
    },
    config,
    store
  );
  assert(wrapper.ok, `research_wrapper dry-run failed: ${wrapper.error || "unknown"}`);
  assert(wrapper.model === "gpt-5.4-mini", "research_wrapper did not default to gpt-5.4-mini");
  assert(wrapper.reasoning === "medium", "research_wrapper did not default to medium reasoning");
  assert(wrapper.artifactPath, "research_wrapper did not persist an artifact");

  const agentConfig = resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "Read image artifacts/screenshots/tiny.png and tell me what it shows.",
      commandCwd: workspace,
      allowFileTools: true,
      allowShellTool: false,
      maxSteps: 4,
    },
    {
      baseDir: runtimeDir,
      packageDir: repoRoot,
      provider: "mock",
    }
  );
  const run = await runAgent(agentConfig);
  const runStore = new SessionStore(agentConfig.sessionsDir, run.sessionId);
  const events = await runStore.loadEvents();
  assert(events.some((event) => event.type === "tool.completed" && event.data?.toolName === "read_image"), "mock agent did not call read_image");

  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log("smoke-perception-research ok");
}

main().catch(async (error) => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  console.error(error);
  process.exit(1);
});
