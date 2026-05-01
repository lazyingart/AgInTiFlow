#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairModelMessageHistory, runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { engineeringGuidanceForTask, recommendedMaxStepsForTask } from "../src/engineering-guidance.js";
import { selectModelRoute } from "../src/model-routing.js";
import { SessionStore } from "../src/session-store.js";
import { executeWorkspaceTool } from "../src/workspace-tools.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-coding-tools-"));
const runtimeDir = path.join(tempRoot, "runtime");
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runMock(goal, sessionId, { resume = false } = {}) {
  const config = resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal,
      commandCwd: workspace,
      maxSteps: 5,
      resume: resume ? sessionId : "",
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
      sessionId: resume ? "" : sessionId,
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
  const patchRoute = selectModelRoute({
    routingMode: "smart",
    provider: "deepseek",
    goal: "patch this large codebase and migrate the database tests",
  });
  assert(/pro/i.test(patchRoute.model), "patch/refactor task did not route to DeepSeek pro");
  const largeProfileRoute = selectModelRoute({
    routingMode: "smart",
    provider: "deepseek",
    goal: "fix this bug",
    taskProfile: "large-codebase",
  });
  assert(/pro/i.test(largeProfileRoute.model), "large-codebase profile did not route to DeepSeek pro");
  const autoSystemRoute = selectModelRoute({
    routingMode: "smart",
    provider: "deepseek",
    goal: "debug this Python project system bug and fix failing tests",
    taskProfile: "auto",
  });
  assert(/pro/i.test(autoSystemRoute.model), "auto system/code problem did not route to DeepSeek pro");
  assert(
    recommendedMaxStepsForTask({
      goal: "debug this Python project system bug and fix failing tests",
      taskProfile: "auto",
      complexityScore: autoSystemRoute.complexityScore,
    }) >= 36,
    "auto system/code problem did not get engineering step budget"
  );
  const guidance = engineeringGuidanceForTask("debug this Python project system bug and fix failing tests", "auto");
  assert(guidance.includes("Python:"), "engineering guidance did not include Python stack advice");
  assert(guidance.includes("System/shell:"), "engineering guidance did not include system stack advice");

  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(path.join(workspace, "test"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "agintiflow-inspect-smoke",
        scripts: {
          test: "node --test test/index.test.js",
          check: "node --check src/index.js",
        },
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(path.join(workspace, "src/index.js"), "export function answer() { return 42; }\n", "utf8");
  await fs.writeFile(path.join(workspace, "test/index.test.js"), "import test from 'node:test';\n", "utf8");
  const inspected = await executeWorkspaceTool(
    "inspect_project",
    { path: ".", maxDepth: 4, limit: 200 },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(inspected.ok, "inspect_project failed");
  assert(inspected.manifestFiles.some((item) => item.path === "package.json"), "inspect_project did not find package.json");
  assert(inspected.packageScripts.some((item) => item.name === "test"), "inspect_project did not extract package scripts");
  assert(inspected.sourceDirs.some((item) => item.path === "src"), "inspect_project did not identify src directory");
  assert(inspected.testFiles.some((item) => item.path === "test/index.test.js"), "inspect_project did not identify test file");
  assert(inspected.recommendedReads.includes("package.json"), "inspect_project did not recommend package.json");

  const inspectRun = await runMock("Inspect this large codebase and recommend next reads.", "coding-inspect");
  assert(
    inspectRun.events.some((event) => event.type === "tool.completed" && event.data?.toolName === "inspect_project"),
    "mock large-codebase run did not use inspect_project"
  );

  const writeRun = await runMock("Create notes/hello.md with a short coding smoke message.", "coding-write");
  const written = await fs.readFile(path.join(workspace, "notes/hello.md"), "utf8");
  assert(written.includes("Created by AgInTiFlow mock mode."), "mock write did not create expected file");
  assert(writeRun.events.some((event) => event.type === "file.changed"), "write run did not persist file.changed event");

  await runMock("Create notes/resume.md with resumed session content.", "coding-write", { resume: true });
  const resumed = await fs.readFile(path.join(workspace, "notes/resume.md"), "utf8");
  assert(resumed.includes("Created by AgInTiFlow mock mode."), "mock resume did not create a new requested file");

  let duplicateFailed = false;
  try {
    await runMock("Create notes/hello.md with duplicate content.", "coding-write-duplicate");
  } catch (error) {
    duplicateFailed = /File already exists|Mock tool failed/.test(String(error));
  }
  assert(duplicateFailed, "duplicate mock write did not fail safely");

  await runMock("Create file: /workspace/virtual-output.txt with virtual Docker path support.", "coding-write-virtual");
  const virtualWritten = await fs.readFile(path.join(workspace, "virtual-output.txt"), "utf8");
  assert(virtualWritten.includes("Created by AgInTiFlow mock mode."), "virtual /workspace path was not mapped safely");

  await fs.writeFile(path.join(workspace, "patch-target.txt"), "old\n", "utf8");
  const patchRun = await runMock("Patch file: patch-target.txt replace old with new.", "coding-patch");
  const patched = await fs.readFile(path.join(workspace, "patch-target.txt"), "utf8");
  assert(patched === "new\n", "mock patch did not update expected file");
  assert(patchRun.events.some((event) => event.type === "file.changed"), "patch run did not persist file.changed event");

  await fs.writeFile(path.join(workspace, "patch-target.txt"), "old\n", "utf8");
  const multiPatchRun = await runMock("Apply multi-file Codex patch to replace old and add a note.", "coding-patch-multi");
  const multiPatched = await fs.readFile(path.join(workspace, "patch-target.txt"), "utf8");
  const patchNote = await fs.readFile(path.join(workspace, "notes/patch-note.md"), "utf8");
  assert(multiPatched === "new\n", "mock multi-file patch did not update expected file");
  assert(patchNote.includes("multi-file patch smoke"), "mock multi-file patch did not add expected file");
  assert(
    multiPatchRun.events.filter((event) => event.type === "file.changed").length >= 2,
    "multi-file patch did not persist per-file change events"
  );

  await fs.writeFile(path.join(workspace, "unified-target.txt"), "alpha\nold\nomega\n", "utf8");
  const unified = await executeWorkspaceTool(
    "apply_patch",
    {
      patch: [
        "--- a/unified-target.txt",
        "+++ b/unified-target.txt",
        "@@ -1,3 +1,3 @@",
        " alpha",
        "-old",
        "+new",
        " omega",
      ].join("\n"),
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  const unifiedText = await fs.readFile(path.join(workspace, "unified-target.txt"), "utf8");
  assert(unified.ok && unifiedText === "alpha\nnew\nomega\n", "unified apply_patch did not update expected file");

  const blockedPatch = await executeWorkspaceTool(
    "apply_patch",
    {
      patch: ["*** Begin Patch", "*** Add File: .env", "+TOKEN=blocked", "*** End Patch"].join("\n"),
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(blockedPatch.blocked, "patch document to sensitive path was not blocked by guardrail");

  await fs.writeFile(path.join(workspace, "move-source.txt"), "source\n", "utf8");
  await fs.writeFile(path.join(workspace, "move-target.txt"), "target\n", "utf8");
  const moveOverResult = await executeWorkspaceTool(
    "apply_patch",
    {
      patch: [
        "*** Begin Patch",
        "*** Update File: move-source.txt",
        "*** Move to: move-target.txt",
        "@@",
        "-source",
        "+moved",
        "*** End Patch",
      ].join("\n"),
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  )
    .then(() => "")
    .catch((error) => String(error?.message || error));
  assert(
    /move over an existing file/.test(moveOverResult),
    "patch move over an existing file was not rejected"
  );

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
          "deepseek_pro_patch_route",
          "large_profile_pro_route",
          "auto_system_pro_route",
          "auto_engineering_guidance",
          "inspect_project",
          "mock_inspect_project",
          "write_file",
          "duplicate_write_failed",
          "resume_session_write",
          "virtual_workspace_path",
          "apply_patch",
          "multi_file_patch",
          "unified_patch",
          "patch_guardrail",
          "patch_move_no_overwrite",
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
