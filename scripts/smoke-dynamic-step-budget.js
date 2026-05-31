#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  browserSubmitFinishIssue,
  isRecoverableShellToolResult,
  isSuspiciousBroadBrowserToolResult,
  shouldActivateScs,
  shouldReviewToolResult,
} from "../src/scs-controller.js";
import {
  createStepBudgetState,
  decideStepBudgetExtension,
  normalizeDynamicStepsMode,
} from "../src/step-budget-controller.js";
import { SessionStore } from "../src/session-store.js";
import { recommendedMaxStepsForTask } from "../src/engineering-guidance.js";

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
    shouldActivateScs("auto", {
      goal: "Use Chrome Driver/CDP on 127.0.0.1:9222 to upload five reference images, choose an asset-library video, submit the browser form, and monitor progress.",
      taskProfile: "auto",
      complexityScore: 1,
    }),
    "/scs auto should activate for browser automation and host-local CDP workflows"
  );
  assert(
    !shouldActivateScs("auto", { goal: "say hello", taskProfile: "auto", complexityScore: 0 }),
    "/scs auto should stay off for trivial prompts"
  );
  const broadBrowserClick = {
    toolName: "run_command",
    ok: true,
    args: {
      command: "python scripts/browser_cdp.py click-text PAGE \"Create\"",
    },
    stdout: JSON.stringify({
      ok: true,
      text: Array(30)
        .fill("New chat\nAsset library\nHistory\nAll\nYesterday\nThis month\nSettings\nUpload reference\nSubmit prompt")
        .join("\n"),
      x: 650,
      y: 390,
    }),
  };
  assert(
    isSuspiciousBroadBrowserToolResult(broadBrowserClick),
    "SCS should flag successful browser clicks that return broad whole-page text"
  );
  assert(
    shouldReviewToolResult(broadBrowserClick, { meta: {} }),
    "SCS should review suspicious broad browser click results"
  );
  const blockedSecretProbe = {
    toolName: "run_command",
    blocked: true,
    args: { command: "env | grep API_KEY" },
    reason: "Command is blocked because it references secrets or credential files.",
  };
  assert(isRecoverableShellToolResult(blockedSecretProbe), "SCS should classify blocked secret probes as recoverable shell results");
  assert(
    !shouldReviewToolResult(blockedSecretProbe, { meta: {} }),
    "SCS should not derail the phase for a safely blocked credential probe"
  );
  const malformedReadOnlyCheck = {
    toolName: "run_command",
    ok: false,
    exitCode: 2,
    args: { command: "for f in *.pdf; do python3 -c 'print(\"oops\")'" },
    stderr: "/bin/bash: -c: line 9: syntax error: unexpected end of file",
  };
  assert(isRecoverableShellToolResult(malformedReadOnlyCheck), "SCS should classify shell quoting mistakes as recoverable");
  assert(
    !shouldReviewToolResult(malformedReadOnlyCheck, { meta: {} }),
    "SCS should let the normal agent loop repair simple shell quoting mistakes"
  );
  assert(
    !isSuspiciousBroadBrowserToolResult({
      toolName: "run_command",
      ok: true,
      args: { command: "echo ok" },
      stdout: "ok",
    }),
    "SCS should not flag ordinary successful shell output as a browser click problem"
  );
  assert(
    recommendedMaxStepsForTask({
      goal: "Use Chrome CDP to upload five images, select an asset-library video, choose the requested non-premium model tier, and submit the browser composer.",
    }) >= 48,
    "browser submit workflows need a larger default step budget"
  );
  assert(
    browserSubmitFinishIssue(
      "网页创作器上传五张图，从素材库选择参考视频，然后提交生成",
      "素材库参考视频 未执行；提交 未执行；步骤不足。"
    ),
    "SCS finish gate should reject unfinished browser submit reports"
  );
  assert(
    !browserSubmitFinishIssue("网页创作器提交生成", "停止：积分不足，需要用户处理 credits not enough。"),
    "SCS finish gate should allow real external browser blockers"
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
  assert(config.enableScs === "auto", "runtime config should default SCS mode to auto");
  assert(config.scsActive === false, "simple mock write should not activate SCS in auto mode");
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
