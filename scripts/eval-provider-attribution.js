#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { createClient } from "../src/model-client.js";
import {
  buildProviderAttributionReport,
  classifyProviderAttribution,
  validateAttributedOutput,
} from "../src/provider-attribution.js";
import { loadProjectEnv } from "../src/project.js";
import { redactSensitiveText } from "../src/redaction.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

async function timed(run) {
  const started = Date.now();
  try {
    return { ok: true, output: await run(), latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      output: "",
      latencyMs: Date.now() - started,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function deterministicSelfTest() {
  const expected = { intent: "generation_only", publish: false };
  const contract = { mode: "exact-json", expected };
  assert.equal(validateAttributedOutput(JSON.stringify(expected), contract).pass, true);
  assert.equal(validateAttributedOutput('{"intent":"generation_only"}', contract).pass, false);
  assert.equal(classifyProviderAttribution({ rawPass: true, agentPass: true }), "both_pass");
  assert.equal(classifyProviderAttribution({ rawPass: true, agentPass: false }), "orchestration_loss");
  assert.equal(classifyProviderAttribution({ rawPass: false, agentPass: true }), "orchestration_help");
  assert.equal(classifyProviderAttribution({ rawPass: false, agentPass: false }), "provider_limit");
  return { ok: true, live: false, checks: 6 };
}

if (!has("--live") && process.env.AGINTIFLOW_PROVIDER_ATTRIBUTION_LIVE !== "1") {
  console.log(JSON.stringify(await deterministicSelfTest(), null, 2));
  process.exit(0);
}

const provider = option("--provider", "deepseek");
const cwd = path.resolve(option("--workspace", process.cwd()));
loadProjectEnv(cwd);
const promptFile = option("--prompt-file");
const prompt = promptFile
  ? await fs.readFile(path.resolve(promptFile), "utf8")
  : option("--prompt", process.env.AGINTIFLOW_ATTRIBUTION_PROMPT || "");
if (!prompt.trim()) throw new Error("Provide --prompt, --prompt-file, or AGINTIFLOW_ATTRIBUTION_PROMPT.");

const expectedFile = option("--expected-file");
const expectedText = expectedFile
  ? await fs.readFile(path.resolve(expectedFile), "utf8")
  : option("--expected", process.env.AGINTIFLOW_ATTRIBUTION_EXPECTED || "");
const mode = option("--mode", expectedText ? "exact-json" : "nonempty");
const contract = {
  mode,
  expected: mode === "exact-json" && expectedText ? JSON.parse(expectedText) : expectedText,
  requiredTerms: option("--required-terms")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
};

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-provider-attribution-"));
try {
  const config = resolveRuntimeConfig(
    {
      provider,
      model: option("--model"),
      routingMode: "manual",
      goal: prompt,
      taskProfile: "chatops",
      maxSteps: 2,
      dynamicSteps: "off",
      enableScs: "off",
      allowShellTool: false,
      allowFileTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      commandCwd: cwd,
    },
    {
      baseDir: cwd,
      packageDir: repoRoot,
      provider,
      model: option("--model"),
      routingMode: "manual",
      commandCwd: cwd,
      sessionsDir: path.join(tempRoot, "sessions"),
      projectSessionsDir: path.join(tempRoot, "project-sessions"),
      sessionId: `provider-attribution-${Date.now()}`,
      maxSteps: 2,
      dynamicSteps: "off",
      enableScs: "off",
      allowShellTool: false,
      allowFileTools: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      onConsole: () => {},
    }
  );

  const raw = await timed(async () => {
    const client = createClient(config);
    const completion = await client.chat.completions.create({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: Math.min(4096, Number(config.maxOutputTokens || 4096)),
      temperature: 0,
    });
    return String(completion?.choices?.[0]?.message?.content || "").trim();
  });
  const agent = await timed(async () => {
    const result = await runAgent(config);
    if (result?.failed || !String(result?.result || "").trim()) {
      throw new Error(result?.reason || "AgInTi returned no result");
    }
    return String(result.result).trim();
  });
  const report = buildProviderAttributionReport({
    provider: config.provider,
    model: config.model,
    raw,
    agent,
    contract,
    showOutput: has("--show-output"),
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.classification === "orchestration_loss") process.exitCode = 2;
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
