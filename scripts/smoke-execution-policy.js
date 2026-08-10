#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextBudgetCompactionMessages, runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  createContextBudgetState,
  decideContextCompaction,
  estimateMessageChars,
  estimateMessageTokens,
  estimateToolSchemaTokens,
  recordContextCompaction,
} from "../src/context-budget-controller.js";
import { maxStepsForExecutionPolicy, selectExecutionPolicy } from "../src/execution-policy.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-execution-policy-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, ".agintiflow-home");
const runtimeDir = path.join(tempRoot, "runtime");
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const focusedPolicy = selectExecutionPolicy({
    routingMode: "smart",
    taskProfile: "auto",
    complexityScore: 0,
    scsActive: false,
  });
  assert(focusedPolicy.tier === "focused" && !focusedPolicy.requiresPlan, "simple task should select focused execution");
  assert(maxStepsForExecutionPolicy(24, focusedPolicy) === 12, "focused execution should use a smaller default step budget");
  assert(
    maxStepsForExecutionPolicy(30, focusedPolicy, { explicit: true }) === 30,
    "focused execution should preserve an explicit user step budget"
  );

  const thoroughPolicy = selectExecutionPolicy({
    routingMode: "smart",
    taskProfile: "auto",
    complexityScore: 5,
    scsActive: false,
  });
  assert(thoroughPolicy.tier === "thorough" && thoroughPolicy.requiresPlan, "complex task should select thorough execution");
  const scsPolicy = selectExecutionPolicy({
    requestedTier: "focused",
    routingMode: "fast",
    taskProfile: "auto",
    complexityScore: 0,
    scsActive: true,
  });
  assert(scsPolicy.tier === "thorough" && scsPolicy.requiresPlan, "SCS must not run without a thorough phase plan");

  const simpleConfig = resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "Create notes/focused.md with one concise line.",
      commandCwd: workspace,
      allowFileTools: true,
      allowShellTool: false,
      enableScs: "off",
    },
    {
      baseDir: runtimeDir,
      packageDir: repoRoot,
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      commandCwd: workspace,
      allowFileTools: true,
      allowShellTool: false,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      sessionId: "focused-execution-smoke",
    }
  );
  assert(simpleConfig.executionTier === "focused", "simple runtime did not select focused execution");
  assert(simpleConfig.maxSteps === 12, "simple runtime did not reduce its default step budget");
  const simpleRun = await runAgent(simpleConfig);
  assert(!simpleRun.stopped && !simpleRun.failed, "focused runtime did not finish");
  const focusedFile = await fs.readFile(path.join(workspace, "notes/focused.md"), "utf8");
  assert(focusedFile.includes("Created by AgInTiFlow mock mode."), "focused runtime did not create the requested artifact");
  const simpleEvents = await new SessionStore(simpleConfig.sessionsDir, simpleRun.sessionId).loadEvents();
  assert(simpleEvents.some((event) => event.type === "plan.skipped"), "focused runtime did not record plan.skipped");
  assert(!simpleEvents.some((event) => event.type === "plan.requested"), "focused runtime still made a planning request");

  const localConfig = resolveRuntimeConfig(
    { provider: "localllm", routingMode: "manual", model: "localllm-deep", goal: "Implement and verify a parser." },
    { baseDir: runtimeDir, packageDir: repoRoot, provider: "localllm", routingMode: "manual", model: "localllm-deep" }
  );
  assert(localConfig.contextWindowTokens === 32768, "LocalLLM did not receive its conservative context window");
  assert(localConfig.maxOutputTokens === 8192, "LocalLLM output was not bounded and reserved");
  assert(localConfig.contextToolReserveTokens === 4096, "LocalLLM tool schemas have no context reserve");
  assert(!localConfig.allowParallelScouts, "LocalLLM silently enabled hosted parallel scouts");
  assert(!localConfig.allowWrapperTools, "LocalLLM silently enabled hosted agent wrappers");

  const hostedWrapperDefault = resolveRuntimeConfig(
    { provider: "openai", routingMode: "manual", model: "gpt-5.4-mini", goal: "Explain one function." },
    { baseDir: runtimeDir, packageDir: repoRoot, provider: "openai", routingMode: "manual", model: "gpt-5.4-mini" }
  );
  assert(!hostedWrapperDefault.allowWrapperTools, "an installed wrapper silently enabled itself for a hosted provider");
  const hostedWrapperOptIn = resolveRuntimeConfig(
    {
      provider: "openai",
      routingMode: "manual",
      model: "gpt-5.4-mini",
      goal: "Ask the explicitly enabled wrapper for advice.",
      allowWrapperTools: true,
    },
    {
      baseDir: runtimeDir,
      packageDir: repoRoot,
      provider: "openai",
      routingMode: "manual",
      model: "gpt-5.4-mini",
      allowWrapperTools: true,
    }
  );
  assert(hostedWrapperOptIn.allowWrapperTools, "explicit wrapper permission was not preserved");

  const complexConfig = resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "Debug failing tests and fix the build in a large repository.",
      commandCwd: workspace,
      allowFileTools: false,
      allowShellTool: false,
      enableScs: "off",
    },
    {
      baseDir: runtimeDir,
      packageDir: repoRoot,
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      commandCwd: workspace,
      allowFileTools: false,
      allowShellTool: false,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      sessionId: "thorough-execution-smoke",
    }
  );
  assert(complexConfig.executionTier === "thorough", "complex runtime did not select thorough execution");
  const complexRun = await runAgent(complexConfig);
  assert(complexRun.stopped && complexRun.reason === "model_did_not_execute", "thorough runtime did not stop truthfully without execution tools");
  const complexEvents = await new SessionStore(complexConfig.sessionsDir, complexRun.sessionId).loadEvents();
  assert(complexEvents.some((event) => event.type === "plan.requested"), "thorough runtime skipped its planning request");
  assert(complexEvents.some((event) => event.type === "plan.created"), "thorough runtime did not persist its plan");
  assert(
    complexEvents.some((event) => event.type === "completion.evidence_rejected"),
    "thorough runtime did not record missing execution evidence"
  );

  const longToolOutput = "verified-output ".repeat(1400);
  const contextState = {
    goal: "Repair src/router.js and verify test/router.test.js without changing unrelated files.",
    plan: "Inspect the router boundary, patch narrowly, run the focused router test.",
    meta: {},
    messages: [
      { role: "system", content: "Keep edits scoped and verify the result." },
      { role: "user", content: "Repair src/router.js and verify test/router.test.js." },
      {
        role: "tool",
        tool_call_id: "tool-1",
        content: JSON.stringify({
          toolName: "run_command",
          ok: true,
          args: { command: "npm test -- test/router.test.js" },
          stdout: longToolOutput,
        }),
      },
      { role: "assistant", content: longToolOutput },
    ],
  };
  const contextBudget = createContextBudgetState(
    { contextBudgetMode: "auto", contextBudgetChars: 4000, contextBudgetTargetChars: 2000 },
    contextState
  );
  const decision = decideContextCompaction({ state: contextState, budget: contextBudget, step: 6 });
  assert(decision.compact, "oversized context did not request proactive compaction");
  const compacted = buildContextBudgetCompactionMessages(
    contextState,
    {
      goal: contextState.goal,
      maxSteps: 12,
      taskProfile: "code",
      sandboxMode: "host",
      packageInstallPolicy: "block",
      commandCwd: workspace,
    },
    { title: "No browser", url: "" },
    6,
    decision
  );
  const charsAfter = estimateMessageChars(compacted);
  assert(charsAfter < decision.charsBefore, "context compaction did not reduce message size");
  assert(compacted.some((message) => message.content.includes(contextState.goal)), "compaction lost the authoritative goal");
  assert(compacted.some((message) => message.content.includes("npm test -- test/router.test.js")), "compaction lost tool evidence");
  const recorded = recordContextCompaction(contextBudget, {
    step: 6,
    charsBefore: decision.charsBefore,
    charsAfter,
  });
  assert(recorded.compactions === 1 && recorded.lastCompactedStep === 6, "context compaction state was not recorded");

  const denseState = { meta: {}, messages: [{ role: "user", content: "高密度上下文".repeat(1200) }] };
  const denseBudget = createContextBudgetState(
    {
      contextBudgetMode: "auto",
      contextBudgetChars: 1_000_000,
      contextWindowTokens: 12000,
      maxOutputTokens: 4000,
      contextToolReserveTokens: 3000,
    },
    denseState
  );
  const denseDecision = decideContextCompaction({ state: denseState, budget: denseBudget, step: 1 });
  assert(denseBudget.maxInputTokens === 5000, "token reserves were not subtracted from the LocalLLM window");
  assert(estimateMessageTokens(denseState.messages) > denseBudget.maxInputTokens, "dense Unicode estimator was not conservative");
  assert(denseDecision.compact && /token input budget/.test(denseDecision.reason), "dense Unicode did not trigger token-aware compaction");
  assert(
    estimateToolSchemaTokens([{ type: "function", function: { name: "fixture", description: "schema ".repeat(600) } }]) > 1000,
    "tool-schema estimator ignored serialized schema cost"
  );

  console.log("smoke-execution-policy ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
