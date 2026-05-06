#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { shouldActivateScs } from "../src/scs-controller.js";
import {
  createStepBudgetState,
  decideStepBudgetExtension,
  normalizeDynamicStepsMode,
} from "../src/step-budget-controller.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-dynamic-budget-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, ".agintiflow-home");
const runtimeDir = path.join(tempRoot, "runtime");
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function toolMessage(payload) {
  return {
    role: "tool",
    tool_call_id: `tool-${payload.toolName || "unknown"}`,
    content: JSON.stringify(payload),
  };
}

try {
  assert(normalizeDynamicStepsMode("off") === "off", "dynamic mode off did not normalize");
  assert(normalizeDynamicStepsMode("always") === "on", "dynamic mode always did not normalize to on");
  assert(normalizeDynamicStepsMode("smart") === "auto", "dynamic mode smart did not normalize to auto");
  assert(
    shouldActivateScs("auto", {
      goal: "debug a failing Android Gradle build and install on an emulator",
      taskProfile: "auto",
      complexityScore: 1,
    }),
    "/scs auto should activate for complex engineering prompts"
  );
  assert(
    !shouldActivateScs("auto", { goal: "say hello", taskProfile: "auto", complexityScore: 0 }),
    "/scs auto should stay off for trivial prompts"
  );

  const normalBudget = createStepBudgetState(
    {
      provider: "deepseek",
      maxSteps: 4,
      dynamicSteps: "auto",
      dynamicStepExtensionLimit: 1,
      scsActive: false,
    },
    { meta: {}, stepsCompleted: 0 }
  );
  const progressDecision = decideStepBudgetExtension({
    config: { scsActive: false },
    budget: normalBudget,
    step: 3,
    state: {
      messages: [
        toolMessage({
          toolName: "write_file",
          ok: true,
          path: "notes/progress.md",
        }),
      ],
    },
    events: [{ type: "file.changed", data: { path: "notes/progress.md" } }],
  });
  assert(progressDecision.approved && progressDecision.extraSteps > 0, "normal budget did not approve verified progress");

  const blockedDecision = decideStepBudgetExtension({
    config: { scsActive: false },
    budget: normalBudget,
    step: 3,
    state: {
      messages: [
        toolMessage({
          toolName: "run_command",
          ok: false,
          blocked: true,
          category: "general-shell",
          reason: "Host command requires approval for destructive actions.",
        }),
        toolMessage({
          toolName: "run_command",
          ok: false,
          blocked: true,
          category: "general-shell",
          reason: "Host command requires approval for destructive actions.",
        }),
      ],
    },
    events: [],
  });
  assert(!blockedDecision.approved && /permission|approval|blocked/i.test(blockedDecision.reason), "budget gate did not deny blocker loops");

  const mockAutoBudget = createStepBudgetState({ provider: "mock", maxSteps: 4, dynamicSteps: "auto" }, { meta: {}, stepsCompleted: 0 });
  assert(!mockAutoBudget.enabled, "mock provider should not auto-extend unless explicitly enabled");

  const config = resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "Create notes/dynamic-budget.md with a dynamic budget smoke message.",
      commandCwd: workspace,
      maxSteps: 1,
      dynamicSteps: "on",
      allowFileTools: true,
      allowShellTool: false,
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
      sessionId: "dynamic-step-budget-smoke",
    }
  );
  const run = await runAgent(config);
  assert(!run.stopped, "mock run stopped instead of using dynamic extension");
  const written = await fs.readFile(path.join(workspace, "notes/dynamic-budget.md"), "utf8");
  assert(written.includes("Created by AgInTiFlow mock mode."), "dynamic budget run did not create expected file");
  const store = new SessionStore(config.sessionsDir, run.sessionId);
  const events = await store.loadEvents();
  const extension = events.find((event) => event.type === "budget.extension_approved");
  assert(extension, "dynamic budget run did not emit budget.extension_approved");
  assert(extension.data?.approvedExtraSteps > 0, "dynamic budget extension did not record approved extra steps");
  const state = await store.loadState();
  assert(state.meta?.stepBudget?.extensionsUsed === 1, "dynamic budget state did not persist extension count");

  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log("smoke-dynamic-step-budget ok");
} catch (error) {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  console.error(error);
  process.exit(1);
}
