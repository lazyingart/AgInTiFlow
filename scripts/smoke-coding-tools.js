#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildModelTimeoutRetryMessages,
  repairModelMessageHistory,
  runAgent,
  sanitizeToolResult,
  shouldShortCircuitToolBatch,
  skippedAfterBlockedToolResult,
} from "../src/agent-runner.js";
import { formatBehaviorContractForPrompt } from "../src/behavior-contract.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { readCodebaseMap } from "../src/codebase-map.js";
import { evaluateCommandPolicy } from "../src/command-policy.js";
import { engineeringGuidanceForTask, recommendedMaxStepsForTask } from "../src/engineering-guidance.js";
import { createPlan } from "../src/model-client.js";
import { selectModelRoute } from "../src/model-routing.js";
import { listParallelScouts, runParallelScouts, shouldRunParallelScouts } from "../src/parallel-scouts.js";
import { buildFailedCommandAdvice, buildPermissionAdvice } from "../src/permission-advice.js";
import { SessionStore } from "../src/session-store.js";
import { getTaskProfile } from "../src/task-profiles.js";
import { searchWeb } from "../src/web-search.js";
import { executeWorkspaceTool } from "../src/workspace-tools.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-coding-tools-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, ".agintiflow-home");
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
    state: await store.loadState(),
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

  const interleavedToolState = {
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "do guarded writes" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-a", type: "function", function: { name: "write_file", arguments: "{\"path\":\".env\",\"content\":\"TOKEN=blocked\"}" } },
          { id: "call-b", type: "function", function: { name: "write_file", arguments: "{\"path\":\"notes/ok.md\",\"content\":\"ok\"}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-a", content: "{\"ok\":false,\"blocked\":true}" },
      { role: "user", content: "Loop guard: do not repeat the blocked call." },
      { role: "tool", tool_call_id: "call-b", content: "{\"ok\":false,\"skipped\":true}" },
    ],
  };
  const interleavedRepair = repairModelMessageHistory(interleavedToolState, { provider: "openai" });
  assert(interleavedRepair.changed, "interleaved tool-call history repair did not report a change");
  const roles = interleavedToolState.messages.map((message) => `${message.role}:${message.tool_call_id || ""}`);
  assert(
    roles.join("|") === "system:|user:|assistant:|tool:call-a|tool:call-b|user:",
    `interleaved tool-call history was not repaired into provider-valid order: ${roles.join("|")}`
  );
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
  const interruptedDeepSeekState = {
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "old request" },
      {
        role: "assistant",
        content: "Running checks.",
        reasoning_content: "Need shell evidence.",
        tool_calls: [
          { id: "call-a", type: "function", function: { name: "run_command", arguments: "{}" } },
          { id: "call-b", type: "function", function: { name: "run_command", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-a", content: "{\"ok\":true}" },
      { role: "user", content: "Continue with this new request: /review" },
    ],
  };
  const interruptedRepair = repairModelMessageHistory(interruptedDeepSeekState, { provider: "deepseek" });
  assert(interruptedRepair.changed, "interrupted tool-call history was not repaired");
  assert(interruptedRepair.incompleteToolCallMessages === 1, "interrupted repair did not count the incomplete tool call");
  assert(
    !interruptedDeepSeekState.messages.some((message) => Array.isArray(message.tool_calls) && message.tool_calls.length > 0),
    "interrupted repair retained incomplete assistant tool calls"
  );
  assert(
    !interruptedDeepSeekState.messages.some((message) => message.role === "tool"),
    "interrupted repair retained orphan partial tool result"
  );
  assert(
    interruptedDeepSeekState.messages.at(-1)?.content === "Continue with this new request: /review",
    "interrupted repair dropped the new user request"
  );
  const blockedBatchResult = {
    ok: false,
    blocked: true,
    toolName: "run_command",
    category: "nested-aginti",
    permissionAdvice: { category: "nested-aginti", suggestedCommand: "aginti doctor --json" },
  };
  assert(shouldShortCircuitToolBatch(blockedBatchResult), "permissionAdvice block did not trigger batch short-circuit");
  const skippedBatchResult = skippedAfterBlockedToolResult(
    {
      id: "call-b",
      type: "function",
      function: { name: "run_command", arguments: "{\"command\":\"npx aginti capabilities --json\"}" },
    },
    blockedBatchResult
  );
  assert(skippedBatchResult.skipped, "skipped tool result did not mark skipped=true");
  assert(skippedBatchResult.blocked, "skipped tool result did not remain blocked");
  assert(skippedBatchResult.priorBlockedCategory === "nested-aginti", "skipped tool result did not preserve prior block category");
  const completeToolState = {
    messages: [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: "Using a tool.",
        tool_calls: [{ id: "call-ok", type: "function", function: { name: "list_files", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call-ok", content: "{\"ok\":true}" },
      { role: "user", content: "next" },
    ],
  };
  const completeRepair = repairModelMessageHistory(completeToolState, { provider: "openai" });
  assert(!completeRepair.changed, "complete OpenAI-format tool history should not be modified");
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
  const codeProfileRoute = selectModelRoute({
    routingMode: "smart",
    provider: "deepseek",
    goal: "this repo has some bugs and messy parts. can you make it good and leave it clean?",
    taskProfile: "code",
  });
  assert(/pro/i.test(codeProfileRoute.model), "code profile did not route vague bugfix work to DeepSeek pro");
  assert(
    recommendedMaxStepsForTask({
      goal: "this repo has some bugs and messy parts. can you make it good and leave it clean?",
      taskProfile: "code",
      complexityScore: codeProfileRoute.complexityScore,
    }) >= 36,
    "code profile did not get enough steps for inspect-fix-test-cleanup"
  );
  for (const complexProfile of ["qa", "database", "devops", "security"]) {
    const route = selectModelRoute({
      routingMode: "smart",
      provider: "deepseek",
      goal: "do the work",
      taskProfile: complexProfile,
    });
    assert(/pro/i.test(route.model), `${complexProfile} profile did not route to DeepSeek pro`);
  }
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
  assert(
    guidance.includes("workspace-relative commands"),
    "engineering guidance did not include workspace-relative shell advice"
  );
  assert(
    guidance.includes("obvious duplicates"),
    "engineering guidance did not include output-polish advice"
  );
  assert(
    guidance.includes("clean git status means tracked work is clean"),
    "engineering guidance did not distinguish git-clean from transient artifacts"
  );
  assert(
    guidance.includes("find . -type d -name __pycache__"),
    "engineering guidance did not include recursive Python transient checks"
  );
  const behaviorContract = formatBehaviorContractForPrompt();
  assert(
    behaviorContract.includes("For tmux one-shot jobs"),
    "behavior contract did not include tmux one-shot evidence guidance"
  );
  assert(
    behaviorContract.includes("do not claim stdout, stderr, or exit status"),
    "behavior contract did not forbid inferring tmux output after capture failure"
  );
  const dockerWorkspacePolicy = {
    allowShellTool: true,
    useDockerSandbox: true,
    sandboxMode: "docker-workspace",
    packageInstallPolicy: "allow",
    commandCwd: workspace,
  };
  const dockerWorkspaceNoInstallsPolicy = {
    ...dockerWorkspacePolicy,
    packageInstallPolicy: "block",
  };
  const hostWorkspacePolicy = {
    allowShellTool: true,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "allow",
    allowDestructive: false,
    commandCwd: workspace,
  };
  const readonlyProbePolicy = evaluateCommandPolicy(
    'which pdflatex 2>&1; which latexmk 2>&1; echo "---"; find /workspace -name \'*.tex\' -maxdepth 3 2>/dev/null; echo "exit: $?"',
    dockerWorkspaceNoInstallsPolicy
  );
  assert(readonlyProbePolicy.allowed, "read-only toolchain probe sequence should not require package-install-policy=allow");
  assert(readonlyProbePolicy.category === "read-only", "read-only toolchain probe sequence should be classified as read-only");
  const readonlyVersionPipelinePolicy = evaluateCommandPolicy(
    "which pdflatex latexmk python3 2>&1; pdflatex --version 2>&1 | head -2; latexmk --version 2>&1 | head -2",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(readonlyVersionPipelinePolicy.allowed, "read-only version probe pipelines should not require package-install-policy=allow");
  assert(readonlyVersionPipelinePolicy.category === "read-only", "read-only version probe pipelines should be classified as read-only");
  const readonlyTestEchoPolicy = evaluateCommandPolicy(
    'test -f /usr/bin/pdflatex && echo "pdflatex: FOUND" || echo "pdflatex: NOT FOUND"; test -f /usr/bin/latexmk && echo "latexmk: FOUND" || echo "latexmk: NOT FOUND"; python3 --version 2>&1',
    dockerWorkspaceNoInstallsPolicy
  );
  assert(readonlyTestEchoPolicy.allowed, "read-only test/echo probe sequence should not require package-install-policy=allow");
  assert(readonlyTestEchoPolicy.category === "read-only", "read-only test/echo probe sequence should be classified as read-only");
  const readonlyFileMetadataPolicy = evaluateCommandPolicy(
    "ls -lh plot_sales.png && file plot_sales.png && stat plot_sales.png && sha256sum plot_sales.png",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(readonlyFileMetadataPolicy.allowed, "read-only file metadata sequence should not require package-install-policy=allow");
  assert(readonlyFileMetadataPolicy.category === "read-only", "read-only file metadata sequence should be classified as read-only");
  const pdflatexCompilePolicy = evaluateCommandPolicy(
    'cd profile-latex-20260506 && pdflatex -interaction=nonstopmode -halt-on-error main.tex 2>&1; echo "PDFLATEX_EXIT:$?"',
    dockerWorkspaceNoInstallsPolicy
  );
  assert(pdflatexCompilePolicy.allowed, "workspace-local pdflatex compile should be allowed without package installs");
  assert(pdflatexCompilePolicy.category === "toolchain", "workspace-local pdflatex compile should be classified as toolchain");
  const latexmkCompilePolicy = evaluateCommandPolicy(
    'cd profile-latex-20260506 && latexmk -pdf main.tex 2>&1; echo "LATEXMK_EXIT:$?"',
    dockerWorkspaceNoInstallsPolicy
  );
  assert(latexmkCompilePolicy.allowed, "workspace-local latexmk compile should be allowed without package installs");
  assert(latexmkCompilePolicy.category === "toolchain", "workspace-local latexmk compile should be classified as toolchain");
  const pythonUnittestPolicy = evaluateCommandPolicy(
    "python3 -m unittest test_data_helper.py 2>&1",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(pythonUnittestPolicy.allowed, "stdlib python unittest should be allowed without package installs");
  assert(pythonUnittestPolicy.category === "test", "stdlib python unittest should be classified as test");
  const pythonDemoPolicy = evaluateCommandPolicy("python3 demo.py 2>&1", dockerWorkspaceNoInstallsPolicy);
  assert(pythonDemoPolicy.allowed, "workspace-local python demo script should be allowed without package installs");
  assert(pythonDemoPolicy.category === "toolchain", "workspace-local python demo script should be classified as toolchain");
  const curlPolicy = evaluateCommandPolicy("curl -s -o /dev/null -w '%{http_code}' https://github.com/lazyingart/AgInTiFlow.git", dockerWorkspacePolicy);
  assert(curlPolicy.allowed, "curl URL probe with flags should be allowed in docker-workspace allow mode");
  assert(curlPolicy.needsNetwork, "curl URL probe with flags was not classified as network");
  const clonePolicy = evaluateCommandPolicy("git clone https://github.com/lazyingart/AgInTiFlow.git", dockerWorkspacePolicy);
  assert(clonePolicy.allowed, "git clone should be allowed in docker-workspace allow mode");
  assert(clonePolicy.needsNetwork, "git clone was not classified as network");
  assert(clonePolicy.writesWorkspace, "git clone was not classified as workspace-writing");
  const quotedDangerSearchPolicy = evaluateCommandPolicy(
    'grep -nE "rm -rf|git reset --hard|git clean -fd|find . -delete" reports/destructive-command-policy.md',
    dockerWorkspacePolicy
  );
  assert(quotedDangerSearchPolicy.allowed, "read-only grep for destructive command strings should be allowed");
  assert(
    quotedDangerSearchPolicy.category !== "destructive",
    "quoted destructive strings in grep pattern should not classify as a destructive command"
  );
  const actualDangerAfterQuotePolicy = evaluateCommandPolicy('echo "rm -rf is text" && rm -rf reports', dockerWorkspacePolicy);
  assert(!actualDangerAfterQuotePolicy.allowed, "actual destructive command after quoted text should still be blocked");
  assert(actualDangerAfterQuotePolicy.category === "destructive", "actual destructive command after quoted text was not classified as destructive");
  const safeChmodAndRunPolicy = evaluateCommandPolicy(
    'chmod +x /workspace/reports/run_bounded_02079_v2.sh && bash /workspace/reports/run_bounded_02079.sh 2>&1; echo "RUN_COMMAND_EXIT: $?"',
    dockerWorkspacePolicy
  );
  assert(safeChmodAndRunPolicy.allowed, "safe workspace chmod + script run sequence should be allowed in docker-workspace allow mode");
  const unsafeChmodPolicy = evaluateCommandPolicy("chmod +x /etc/passwd", dockerWorkspacePolicy);
  assert(!unsafeChmodPolicy.allowed, "chmod outside the workspace should be blocked");
  const hostWorkspaceChmodPolicy = evaluateCommandPolicy("chmod +x android-app/gradlew && echo \"CHMOD_OK\"", hostWorkspacePolicy);
  assert(hostWorkspaceChmodPolicy.allowed, "host mode should allow workspace-local chmod without full-host destructive access");
  assert(
    hostWorkspaceChmodPolicy.category === "permission-change",
    "host workspace chmod sequence should remain categorized as permission-change"
  );
  const androidReadonlyProbePolicy = evaluateCommandPolicy(
    'test -x /usr/bin/gradle && echo "GRADLE_OK" ; test -x /usr/bin/java && /usr/bin/java -version 2>&1 | head -1; adb devices; emulator -list-avds; find android-app -type f | sort',
    hostWorkspacePolicy
  );
  assert(androidReadonlyProbePolicy.allowed, "Android host read-only probes should not require full-host destructive access");
  assert(androidReadonlyProbePolicy.category === "read-only", "Android host probes should remain read-only");
  const androidGradleBuildPolicy = evaluateCommandPolicy("cd android-app && ./gradlew :app:assembleDebug", hostWorkspacePolicy);
  assert(androidGradleBuildPolicy.allowed, "workspace-local Gradle Android build should be allowed in host workspace mode");
  assert(androidGradleBuildPolicy.category === "toolchain", "workspace-local Gradle Android build should be toolchain");
  const androidEnvGradleBuildPolicy = evaluateCommandPolicy(
    'cd android-app && export ANDROID_HOME=/home/lachlan/Android/Sdk && export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 && ./gradlew assembleDebug 2>&1; echo "EXIT:$?" > /home/lachlan/ProjectsLFS/aginti-test/android-app/build-exit.log',
    {
      ...hostWorkspacePolicy,
      commandCwd: "/home/lachlan/ProjectsLFS/aginti-test",
    }
  );
  assert(androidEnvGradleBuildPolicy.allowed, "Android build with safe env exports and workspace-local status log should be allowed");
  assert(androidEnvGradleBuildPolicy.category === "toolchain", "Android env build sequence should remain classified as toolchain");
  const androidInlineEnvGradleBuildPolicy = evaluateCommandPolicy(
    "cd android-app && ANDROID_HOME=/home/lachlan/Android/Sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew assembleDebug",
    hostWorkspacePolicy
  );
  assert(androidInlineEnvGradleBuildPolicy.allowed, "Android build with inline safe env assignments should be allowed");
  assert(androidInlineEnvGradleBuildPolicy.category === "toolchain", "Android inline env build should be toolchain");
  const androidPathGradleBuildPolicy = evaluateCommandPolicy(
    'ANDROID_HOME=/home/lachlan/Android/Sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 android-app/gradlew -p android-app assembleDebug 2>&1; echo "EXIT:$?"',
    hostWorkspacePolicy
  );
  assert(androidPathGradleBuildPolicy.allowed, "Android path-prefixed Gradle wrapper with -p should be allowed");
  assert(androidPathGradleBuildPolicy.category === "toolchain", "Android path-prefixed Gradle wrapper should be toolchain");
  const androidUnsafeEnvPolicy = evaluateCommandPolicy("OPENAI_API_KEY=sk-test ./gradlew assembleDebug", hostWorkspacePolicy);
  assert(!androidUnsafeEnvPolicy.allowed, "secret-like inline env assignments must remain blocked");
  const androidOutsideLogPolicy = evaluateCommandPolicy(
    'cd android-app && ./gradlew assembleDebug 2>&1; echo "EXIT:$?" > /tmp/aginti-build-exit.log',
    hostWorkspacePolicy
  );
  assert(!androidOutsideLogPolicy.allowed, "status-log redirection outside the workspace should remain blocked");
  const cdWorkspacePolicy = evaluateCommandPolicy("cd /workspace && git status --short 2>&1 | head -20", dockerWorkspacePolicy);
  assert(cdWorkspacePolicy.allowed, "cd /workspace should be allowed in docker-workspace mode");
  const gitCleanDryRunPolicy = evaluateCommandPolicy("git clean -nd reports", dockerWorkspacePolicy);
  assert(gitCleanDryRunPolicy.allowed, "git clean dry-run should be allowed as read-only inspection evidence");
  const localGitInitPolicy = evaluateCommandPolicy("git init", dockerWorkspaceNoInstallsPolicy);
  assert(localGitInitPolicy.allowed, "local git init should be allowed without package installs");
  assert(localGitInitPolicy.category === "git-workflow", "local git init should be classified as git-workflow");
  const localGitCommitPolicy = evaluateCommandPolicy('git commit -m "Initial local workflow commit"', dockerWorkspaceNoInstallsPolicy);
  assert(localGitCommitPolicy.allowed, "local git commit should be allowed without package installs");
  assert(localGitCommitPolicy.category === "git-workflow", "local git commit should be classified as git-workflow");
  const localGitSwitchPolicy = evaluateCommandPolicy("git switch -c feature-a", dockerWorkspaceNoInstallsPolicy);
  assert(localGitSwitchPolicy.allowed, "local git switch -c should be allowed without package installs");
  const localGitCheckoutExistingPolicy = evaluateCommandPolicy("git checkout main", dockerWorkspaceNoInstallsPolicy);
  assert(localGitCheckoutExistingPolicy.allowed, "local git checkout existing branch should be allowed without package installs");
  const localGitMergePolicy = evaluateCommandPolicy("git merge --ff-only feature-a", dockerWorkspaceNoInstallsPolicy);
  assert(localGitMergePolicy.allowed, "local git fast-forward merge should be allowed without package installs");
  const localGitNoFfMergePolicy = evaluateCommandPolicy("git merge --no-ff --no-edit feature-b", dockerWorkspaceNoInstallsPolicy);
  assert(localGitNoFfMergePolicy.allowed, "local git explicit no-ff merge should be allowed without package installs");
  const localGitNoFfMergeAltPolicy = evaluateCommandPolicy("git merge --no-ff feature-b --no-edit", dockerWorkspaceNoInstallsPolicy);
  assert(localGitNoFfMergeAltPolicy.allowed, "local git explicit no-ff merge alternate arg order should be allowed");
  const localGitWorkflowSequencePolicy = evaluateCommandPolicy(
    "cd /workspace/git-practice && git checkout main && git merge --ff-only feature-a",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(localGitWorkflowSequencePolicy.allowed, "local git checkout + ff-only merge sequence should be allowed without package installs");
  const plainGitMergePolicy = evaluateCommandPolicy("git merge feature-a", dockerWorkspaceNoInstallsPolicy);
  assert(!plainGitMergePolicy.allowed, "plain git merge should stay guarded because it can hang or make an ambiguous merge");
  const unsafeRebasePolicy = evaluateCommandPolicy("git rebase main", dockerWorkspaceNoInstallsPolicy);
  assert(!unsafeRebasePolicy.allowed, "git rebase should still require stronger permission because it rewrites history");
  const unsafeCloneTarget = evaluateCommandPolicy("git clone https://github.com/lazyingart/AgInTiFlow.git ../AgInTiFlow", dockerWorkspacePolicy);
  assert(!unsafeCloneTarget.allowed, "git clone outside the workspace should be blocked");
  const blockedClonePolicy = evaluateCommandPolicy("git clone https://github.com/lazyingart/AgInTiFlow.git", {
    ...dockerWorkspacePolicy,
    packageInstallPolicy: "block",
  });
  assert(!blockedClonePolicy.allowed, "git clone should be blocked when Docker package/network setup is blocked");
  const permissionAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: { command: "git clone https://github.com/lazyingart/AgInTiFlow.git" },
    guard: blockedClonePolicy,
    config: dockerWorkspacePolicy,
    state: { sessionId: "coding-policy-smoke" },
  });
  assert(permissionAdvice.suggestedCommand.includes("coding-policy-smoke"), "permission advice did not include resume session id");
  assert(permissionAdvice.suggestedCommand.includes("--sandbox-mode docker-workspace"), "permission advice did not suggest docker-workspace recovery");
  const destructiveAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: { command: "rm -rf reports && git reset --hard" },
    guard: { category: "destructive", reason: "Destructive shell commands require Allow destructive actions." },
    config: dockerWorkspacePolicy,
    state: { sessionId: "coding-destructive-smoke" },
  });
  const destructiveAdviceText = [
    destructiveAdvice.summary,
    ...(destructiveAdvice.options || []),
    destructiveAdvice.suggestedCommand,
    destructiveAdvice.destructiveApprovalCommand,
  ].join("\n");
  assert(/dry-run|inspect-only/i.test(destructiveAdviceText), "destructive advice did not lead with dry-run or inspect-only alternatives");
  assert(
    /Do not include executable delete\/reset\/clean commands/.test(destructiveAdviceText),
    "destructive advice did not prohibit destructive commands inside safe cleanup instructions"
  );
  assert(
    !destructiveAdvice.suggestedCommand.includes("--allow-destructive"),
    "default destructive advice suggested command should not enable destructive mode"
  );
  assert(
    destructiveAdvice.destructiveApprovalCommand.includes("--allow-destructive"),
    "destructive advice did not provide an explicit approval command"
  );
  const failedNetworkAdvice = buildFailedCommandAdvice({
    args: { command: "git clone https://github.com/lazyingart/AgInTiFlow.git" },
    commandPolicy: clonePolicy,
    commandResult: { ok: false, stderr: "fatal: unable to access 'https://github.com/lazyingart/AgInTiFlow.git/': Could not resolve host: github.com" },
    config: dockerWorkspacePolicy,
    state: { sessionId: "coding-network-smoke" },
  });
  assert(failedNetworkAdvice?.failureKind === "network", "network failure advice was not generated");
  assert(
    failedNetworkAdvice.instruction.includes("Stop and present this blocker"),
    "network failure advice did not tell the model to stop and ask"
  );
  const failedOutsidePathAdvice = buildFailedCommandAdvice({
    args: { command: 'echo "outside permission test" > /home/lachlan/ProjectsLFS/outside.txt' },
    commandPolicy: evaluateCommandPolicy('echo "outside permission test" > /home/lachlan/ProjectsLFS/outside.txt', dockerWorkspacePolicy),
    commandResult: {
      ok: false,
      stdout: "EXIT: 1",
      stderr: "bash: line 1: /home/lachlan/ProjectsLFS/outside.txt: No such file or directory",
    },
    config: dockerWorkspacePolicy,
    state: { sessionId: "coding-outside-path-smoke" },
  });
  assert(failedOutsidePathAdvice?.failureKind === "workspace-path", "outside host path failure advice was not generated");
  assert(failedOutsidePathAdvice.suggestedCommand.includes("--sandbox-mode host"), "outside path advice did not suggest host mode");
  assert(!failedOutsidePathAdvice.suggestedCommand.includes("aginti run --sandbox host"), "outside path advice used legacy sandbox syntax");
  assert(
    shouldRunParallelScouts(
      {
        provider: "deepseek",
        allowParallelScouts: true,
        routeComplexityScore: autoSystemRoute.complexityScore,
        taskProfile: "auto",
        goal: "debug this Python project system bug and fix failing tests",
      },
      { meta: {}, goal: "debug this Python project system bug and fix failing tests" }
    ),
    "parallel scouts did not enable for complex auto task"
  );
  const scoutNames = listParallelScouts().map((scout) => scout.name);
  assert(scoutNames.length >= 10, "parallel scout roster did not expose 10 scout roles");
  for (const expectedScout of ["cartographer", "git-operator", "integrator", "symbol-tracer", "dependency-doctor"]) {
    assert(scoutNames.includes(expectedScout), `parallel scout roster missing ${expectedScout}`);
  }
  const scoutConfig = resolveRuntimeConfig(
    { provider: "mock", parallelScoutCount: 99, commandCwd: workspace },
    { baseDir: runtimeDir, packageDir: repoRoot, provider: "mock", commandCwd: workspace }
  );
  assert(scoutConfig.parallelScoutCount === 10, "parallel scout count did not clamp to 10");
  const drySearch = await searchWeb(
    { query: "AgInTiFlow web_search smoke", maxResults: 2 },
    { allowWebSearch: true, webSearchDryRun: true }
  );
  assert(drySearch.ok && drySearch.results.length === 1, "web_search dry-run did not return deterministic result");

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
  const longSmallFile = [
    "# Small file read smoke",
    "line 001",
    "line 002",
    "line 003",
    "line 004",
    "line 005",
    "line 006",
    "line 007",
    "line 008",
    "line 009",
    "line 010",
    "line 011",
    "line 012",
    "line 013",
    "line 014",
    "line 015",
    "line 016",
    "line 017",
    "line 018",
    "line 019",
    "line 020",
    "FINAL_SENTINEL_SMALL_FILE_FULL_CONTENT",
    "",
  ].join("\n");
  await fs.writeFile(path.join(workspace, "small-read-smoke.md"), longSmallFile, "utf8");
  const smallReadResult = await executeWorkspaceTool(
    "read_file",
    { path: "small-read-smoke.md" },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  const sanitizedSmallRead = sanitizeToolResult(smallReadResult);
  assert(sanitizedSmallRead.content === longSmallFile, "small read_file result did not keep full content for the model");
  assert(sanitizedSmallRead.contentTruncated === false, "small read_file result should not be marked truncated");
  assert(!("contentPreview" in sanitizedSmallRead), "small read_file result should not replace full content with preview");
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
  const nodeProfile = getTaskProfile("node");
  assert(/package\.json/.test(nodeProfile.prompt), "node profile does not require package manifest awareness");
  assert(/bin entry/i.test(nodeProfile.prompt), "node profile does not guide new CLI tools toward bin entries");
  assert(/scripts for test\/check\/start/i.test(nodeProfile.prompt), "node profile does not guide new Node projects toward package scripts");
  const pythonProfile = getTaskProfile("python");
  assert(/unittest|test script/i.test(pythonProfile.prompt), "python profile does not guide helper/tool work toward tests");
  assert(/py_compile/i.test(pythonProfile.prompt), "python profile does not require syntax-check evidence");
  assert(/durable report/i.test(pythonProfile.prompt), "python profile does not require durable evidence reports");
  assert(
    /__pycache__/.test(pythonProfile.prompt) && /do not claim transient artifacts are absent/i.test(pythonProfile.prompt),
    "python profile does not guard against unverified transient artifact claims"
  );
  let planTimeoutError = null;
  const neverCompletesClient = {
    chat: {
      completions: {
        create: () => new Promise(() => {}),
      },
    },
  };
  try {
    await createPlan(
      neverCompletesClient,
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        taskProfile: "security",
        goal: "perform a safe read-only security audit",
        commandCwd: workspace,
        allowedDomains: [],
        allowShellTool: true,
        allowFileTools: true,
        allowWrapperTools: false,
        allowAuxiliaryTools: false,
        allowWebSearch: false,
        allowParallelScouts: false,
        sandboxMode: "host",
        packageInstallPolicy: "block",
        modelTimeoutMs: 25,
      },
      { goal: "perform a safe read-only security audit", meta: {} }
    );
  } catch (error) {
    planTimeoutError = error;
  }
  assert(planTimeoutError?.name === "ModelTimeoutError", "plan model request did not fail with explicit timeout");
  assert(/plan request timed out/.test(planTimeoutError.message), "plan timeout error message was not specific");
  const compactRetryMessages = buildModelTimeoutRetryMessages(
    {
      plan: "Inspect safely, write a bounded report.",
      messages: [
        { role: "system", content: "system guidance" },
        { role: "user", content: "Do a safe security audit and write reports/audit.md." },
        { role: "user", content: "Step 3/8 (5 steps remain after this one). Latest runtime snapshot:\n{\"large\":\"snapshot\"}" },
        {
          role: "assistant",
          content: "I will scan.",
          tool_calls: [{ id: "call-a", type: "function", function: { name: "run_command", arguments: "{\"command\":\"grep -r token .\"}" } }],
        },
        {
          role: "tool",
          tool_call_id: "call-a",
          content: JSON.stringify({
            toolName: "run_command",
            ok: false,
            blocked: true,
            category: "general-shell",
            reason: "General shell commands on the host require Allow destructive actions.",
            args: { command: "grep -r token ." },
          }),
        },
      ],
    },
    {
      taskProfile: "security",
      sandboxMode: "host",
      packageInstallPolicy: "block",
      commandCwd: workspace,
      maxSteps: 8,
    },
    { title: "No browser page open", url: "" },
    3,
    planTimeoutError
  );
  assert(compactRetryMessages.every((message) => message.role !== "tool"), "timeout retry messages retained tool role messages");
  assert(
    !compactRetryMessages.some((message) => Array.isArray(message.tool_calls)),
    "timeout retry messages retained native tool_call records"
  );
  assert(
    compactRetryMessages.some((message) => /compacted, valid transcript/.test(message.content || "")),
    "timeout retry messages did not explain compacted recovery"
  );
  assert(
    compactRetryMessages.some((message) => /blocked=general-shell/.test(message.content || "")),
    "timeout retry messages did not retain blocked tool evidence"
  );
  const fakeScoutPrompts = [];
  const fakeScoutClient = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          const systemContent = messages.find((message) => message.role === "system")?.content || "";
          const userContent = messages.find((message) => message.role === "user")?.content || "";
          fakeScoutPrompts.push(userContent);
          const role = userContent.match(/Scout role: ([^\n]+)/)?.[1] || "coordinator";
          return {
            choices: [
              {
                message: {
                  content: systemContent.includes("synthesize")
                    ? "Swarm Board: read package.json first, inspect src/test, patch narrowly, run npm test, stop on unrelated git changes."
                    : `Advice from ${role}: use the shared context pack and inspect package.json before editing.`,
                },
              },
            ],
          };
        },
      },
    },
  };
  const scoutRun = await runParallelScouts(
    fakeScoutClient,
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      commandCwd: workspace,
      allowFileTools: true,
      parallelScoutCount: 10,
      goal: "fix this complicated repo test bug",
      taskProfile: "large-codebase",
      sandboxMode: "host",
      packageInstallPolicy: "block",
    },
    { goal: "fix this complicated repo test bug", meta: {}, plan: "Inspect and patch." }
  );
  assert(scoutRun.requested === 10 && scoutRun.completed === 10, "parallel scout fake run did not complete 10 scouts");
  assert(scoutRun.contextPack.includes("package.json"), "parallel scout context pack did not include manifest evidence");
  assert(scoutRun.summary.includes("## shared context pack"), "parallel scout summary omitted shared context pack");
  assert(scoutRun.summary.includes("## coordinator"), "parallel scout summary omitted coordinator synthesis");
  assert(scoutRun.codebaseMap?.fingerprint, "parallel scout run did not return durable codebase map metadata");
  assert(scoutRun.blackboard?.lanes?.length === 10, "parallel scout blackboard did not include all scout lanes");
  assert(scoutRun.blackboard?.coordinator.includes("Swarm Board"), "parallel scout blackboard did not retain coordinator synthesis");
  assert(
    fakeScoutPrompts.filter((prompt) => /Shared context pack:[\s\S]*package\.json/.test(prompt)).length >= 10,
    "parallel scouts did not receive the shared context pack"
  );
  const codebaseMap = await readCodebaseMap(workspace);
  assert(codebaseMap.ok && codebaseMap.map.fingerprint === scoutRun.codebaseMap.fingerprint, "durable codebase map was not persisted");
  const blackboardStore = new SessionStore(runtimeDir, "blackboard-smoke");
  const blackboardPath = await blackboardStore.saveJsonArtifact("scout-blackboard.json", scoutRun.blackboard);
  const blackboardJson = JSON.parse(await fs.readFile(blackboardPath, "utf8"));
  assert(blackboardJson.lanes.length === 10, "scout blackboard artifact did not persist lanes");

  const inspectRun = await runMock("Inspect this large codebase and recommend next reads.", "coding-inspect");
  assert(
    inspectRun.state?.messages?.some(
      (message) => message.role === "system" && /Runtime time context: local=.*utc=/.test(message.content || "")
    ),
    "agent prompt did not include local/UTC runtime time context"
  );
  assert(
    inspectRun.events.some((event) => event.type === "tool.completed" && event.data?.toolName === "inspect_project"),
    "mock large-codebase run did not use inspect_project"
  );

  const writeRun = await runMock("Create notes/hello.md with a short coding smoke message.", "coding-write");
  const written = await fs.readFile(path.join(workspace, "notes/hello.md"), "utf8");
  assert(written.includes("Created by AgInTiFlow mock mode."), "mock write did not create expected file");
  assert(writeRun.events.some((event) => event.type === "file.changed"), "write run did not persist file.changed event");

  const resumedRun = await runMock("Create notes/resume.md with resumed session content.", "coding-write", { resume: true });
  const resumed = await fs.readFile(path.join(workspace, "notes/resume.md"), "utf8");
  assert(resumed.includes("Created by AgInTiFlow mock mode."), "mock resume did not create a new requested file");
  assert(
    resumedRun.state?.messages?.some(
      (message) =>
        message.role === "user" &&
        /Continue with this new request/.test(message.content || "") &&
        /Runtime time context: local=.*utc=/.test(message.content || "")
    ),
    "resumed session prompt did not refresh local/UTC runtime time context"
  );

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

  const secretContentResult = await executeWorkspaceTool(
    "write_file",
    {
      path: "notes/secret-leak-report.md",
      content: "Content attempted: DEMO_SECRET_TOKEN=aginti_fake_do_not_use\n",
      mode: "create",
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(secretContentResult.blocked && secretContentResult.category === "workspace-content", "write_file secret-like content was not blocked");
  await fs
    .access(path.join(workspace, "notes/secret-leak-report.md"))
    .then(() => {
      throw new Error("secret-like report content was written despite content guardrails");
    })
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });

  const redactedContentResult = await executeWorkspaceTool(
    "write_file",
    {
      path: "notes/redacted-report.md",
      content: "Content attempted: DEMO_SECRET_TOKEN=[REDACTED]\n",
      mode: "create",
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(redactedContentResult.ok, "write_file should allow already-redacted secret placeholders");

  const secretPatchResult = await executeWorkspaceTool(
    "apply_patch",
    {
      patch: ["*** Begin Patch", "*** Add File: notes/secret-patch.md", "+DEMO_SECRET_TOKEN=aginti_fake_do_not_use", "*** End Patch"].join("\n"),
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(secretPatchResult.blocked && secretPatchResult.category === "workspace-content", "apply_patch secret-like additions were not blocked");

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
          "interleaved_tool_history_repair",
          "blocked_tool_batch_short_circuit",
          "deepseek_pro_patch_route",
          "runtime_time_context",
          "large_profile_pro_route",
          "auto_system_pro_route",
          "auto_engineering_guidance",
          "command_policy_readonly_probe_sequence_no_installs",
          "command_policy_readonly_version_pipeline_no_installs",
          "command_policy_readonly_test_echo_no_installs",
          "command_policy_pdflatex_compile_no_installs",
          "command_policy_latexmk_compile_no_installs",
          "command_policy_local_git_workflow_no_installs",
          "command_policy_git_rebase_still_guarded",
          "command_policy_git_clone_network",
          "command_policy_safe_chmod_sequence",
          "command_policy_host_workspace_chmod",
          "command_policy_android_host_probes",
          "command_policy_android_gradle_build",
          "command_policy_android_gradle_build_with_safe_env",
          "command_policy_cd_workspace",
          "command_policy_git_clean_dry_run",
          "permission_recovery_advice",
          "parallel_scout_trigger",
          "parallel_scout_roster",
          "parallel_scout_count_clamp",
          "web_search_dry_run",
          "inspect_project",
          "small_read_file_full_content",
          "parallel_scout_context_pack",
          "durable_codebase_map",
          "scout_blackboard",
          "mock_inspect_project",
          "write_file",
          "duplicate_write_failed",
          "resume_session_write",
          "resume_runtime_time_context",
          "virtual_workspace_path",
          "apply_patch",
          "multi_file_patch",
          "unified_patch",
          "patch_guardrail",
          "patch_move_no_overwrite",
          "block_env",
          "block_secret_write_content",
          "allow_redacted_write_content",
          "block_secret_patch_content",
          "block_outside",
          "node_profile_cli_package_manifest",
          "python_profile_helper_test_report",
          "model_timeout_compact_retry_messages",
        ],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
