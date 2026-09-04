#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildModelTimeoutRetryMessages,
  genericArtifactFilenameBlock,
  goalClearlyAllowsOverwrite,
  incompatibleDocumentCompilerSourceBlock,
  modelTimeoutExhaustionRoute,
  modelTimeoutRetryRoute,
  normalizeNoMatchQueryResult,
  applyModelTimeoutRetryRoute,
  recoverFocusedTextRewriteWithWritingSpecialist,
  reconcileRuntimeRepositoryState,
  repairModelMessageHistory,
  shouldResetStaticDiscoveryPhase,
  runAgent,
  sanitizeToolResult,
  toolResultForModel,
  shouldPauseForPermissionAdvice,
  shouldShortCircuitToolBatch,
  shellDiagnosticHint,
  skippedAfterBlockedToolResult,
} from "../src/agent-runner.js";
import { createToolContract, resolveDispatchableToolCallBatch } from "../src/tool-contract.js";
import { formatBehaviorContractForPrompt } from "../src/behavior-contract.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { readCodebaseMap } from "../src/codebase-map.js";
import {
  classifyCommand,
  evaluateCommandPolicy,
  externalValidatorCommandContract,
} from "../src/command-policy.js";
import { checkToolUse } from "../src/guardrails.js";
import { shouldReviewToolResult } from "../src/scs-controller.js";
import {
  engineeringGuidanceForTask,
  recommendedMaxStepsForTask,
  shouldUseSurgicalContextForTask,
} from "../src/engineering-guidance.js";
import { createPlan } from "../src/model-client.js";
import { selectModelRoute } from "../src/model-routing.js";
import { listParallelScouts, runParallelScouts, shouldRunParallelScouts } from "../src/parallel-scouts.js";
import {
  buildFailedCommandAdvice,
  buildPermissionAdvice,
  isOptionalGeneratedPreviewCleanup,
  isUnrequestedCleanupCommand,
} from "../src/permission-advice.js";
import { runJsonSpecialist } from "../src/json-specialist.js";
import { SessionStore } from "../src/session-store.js";
import { getTaskProfile } from "../src/task-profiles.js";
import { searchWeb } from "../src/web-search.js";
import { isLikelyWritingSpecialistGoal, runWritingSpecialist } from "../src/writing-specialist.js";
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

async function verifyRunAgentRuntimeGitHygiene() {
  const gitWorkspace = path.join(tempRoot, "runtime-git-workspace");
  await fs.mkdir(gitWorkspace, { recursive: true });
  const initialized = spawnSync("git", ["init"], {
    cwd: gitWorkspace,
    encoding: "utf8",
  });
  assert(initialized.status === 0, `runtime Git hygiene setup failed: ${initialized.stderr || initialized.stdout}`);
  const config = resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "hello",
      commandCwd: gitWorkspace,
      maxSteps: 2,
    },
    {
      baseDir: runtimeDir,
      packageDir: repoRoot,
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      commandCwd: gitWorkspace,
      allowShellTool: false,
      allowFileTools: true,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      sessionId: "coding-runtime-git-hygiene",
    }
  );
  await runAgent(config);
  const localExclude = await fs.readFile(path.join(gitWorkspace, ".git", "info", "exclude"), "utf8");
  assert(
    localExclude.includes(".aginti/codebase-map.json") &&
      localExclude.includes(".aginti/verification/"),
    "runAgent did not protect runtime cache paths in its resolved commandCwd"
  );
  const gitignore = await fs.readFile(path.join(gitWorkspace, ".gitignore"), "utf8").catch(() => "");
  assert(gitignore === "", "runAgent runtime setup edited the tracked .gitignore");
  const staleRepositoryState = {
    meta: {
      projectVerification: {
        mutationRevision: 4,
        privateMutationRevision: 0,
        testRuns: [{
          command: "python3 acceptance.py",
          mutationRevision: 4,
          privateMutationRevision: 0,
          passed: false,
          failureSignature: "dirty-worktree",
          failureSummary: "FAIL: Git worktree is not clean: ?? .aginti/",
        }],
      },
      testFailureRepair: { key: "4:dirty-worktree" },
    },
  };
  const reconciled = await reconcileRuntimeRepositoryState(
    staleRepositoryState,
    { commandCwd: gitWorkspace },
    { changed: false }
  );
  assert(
    reconciled?.clean === true &&
      staleRepositoryState.meta.projectVerification.privateMutationRevision === 1 &&
      !staleRepositoryState.meta.testFailureRepair,
    "a retained cleanliness failure was not invalidated after the live worktree became clean"
  );
}

try {
  await verifyRunAgentRuntimeGitHygiene();
  const externalValidatorPath = path.join(
    tempRoot,
    "private-acceptance",
    "spreadsheet_contract.py"
  );
  const externalValidatorCommand = `python3 ${externalValidatorPath}`;
  assert(
    externalValidatorCommandContract(externalValidatorCommand, {
      commandCwd: workspace,
    })?.path === externalValidatorPath,
    "an exact external validator command did not produce an opaque contract"
  );
  assert(
    externalValidatorCommandContract("python3 tests/local_contract.py", {
      commandCwd: workspace,
    }) === null,
    "an in-workspace project test was incorrectly treated as an opaque external validator"
  );
  const opaqueValidatorPolicy = {
    commandCwd: workspace,
    allowShellTool: true,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    opaqueExternalValidatorPaths: [externalValidatorPath],
    opaqueExternalValidatorCommands: [externalValidatorCommand],
  };
  assert(
    evaluateCommandPolicy(externalValidatorCommand, opaqueValidatorPolicy).allowed === true,
    "the exact declared external validator execution was blocked"
  );
  for (const inspectionCommand of [
    `cat ${externalValidatorPath}`,
    `sed -n '1,160p' ${externalValidatorPath}`,
    `cat ${path.relative(workspace, externalValidatorPath)}`,
    `V=${externalValidatorPath}; grep -n expected "$V"`,
    `echo validator; cat ${externalValidatorPath}; git status --short`,
  ]) {
    const decision = evaluateCommandPolicy(inspectionCommand, opaqueValidatorPolicy);
    assert(
      decision.allowed === false &&
        decision.category === "opaque-external-validator-inspection" &&
        decision.recoverable === true,
      `external validator source inspection escaped the opaque contract: ${inspectionCommand}`
    );
  }
  const combinedValidatorCommand =
    `python3 build_artifact.py; ${externalValidatorCommand}`;
  const combinedValidatorDecision = evaluateCommandPolicy(
    combinedValidatorCommand,
    opaqueValidatorPolicy
  );
  assert(
    combinedValidatorDecision.allowed === false &&
      combinedValidatorDecision.category === "opaque-external-validator-inspection" &&
      combinedValidatorDecision.recoverable === true,
    "a combined producer and external validator command escaped the opaque validator contract"
  );
  const combinedValidatorAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: { command: combinedValidatorCommand },
    guard: combinedValidatorDecision,
    config: opaqueValidatorPolicy,
    state: { sessionId: "opaque-validator-command-shape-smoke" },
  });
  assert(
    combinedValidatorAdvice.autoRecover === true &&
      !combinedValidatorAdvice.suggestedCommand &&
      /separately|standalone/i.test(combinedValidatorAdvice.instruction) &&
      /exact declared external validator command unchanged/i.test(
        combinedValidatorAdvice.instruction
      ) &&
      !shouldPauseForPermissionAdvice({
        blocked: true,
        permissionAdvice: combinedValidatorAdvice,
      }),
    "a recoverable external-validator command-shape error became a permission pause"
  );

  const genericArtifactBlock = await genericArtifactFilenameBlock(
    "write_file",
    { path: "report.md", content: "summary" },
    { commandCwd: workspace, taskProfile: "data", goal: "Analyze the fluorescence experiment exports." },
    { goal: "Analyze the fluorescence experiment exports.", messages: [], meta: {} }
  );
  assert(
    genericArtifactBlock?.category === "artifact-filename" &&
      /fluorescence|experiment/i.test(genericArtifactBlock.permissionAdvice?.instruction || ""),
    "new generic artifact filename was not redirected to a meaningful topic-derived name"
  );
  const echoedGenericArtifactBlock = await genericArtifactFilenameBlock(
    "write_file",
    { path: "output/task/report.tex", content: "document" },
    {
      commandCwd: workspace,
      taskProfile: "writing",
      goal: "Create a reader-facing evidence brief with a meaningful filename.",
    },
    {
      goal: "Create a reader-facing evidence brief with a meaningful filename.",
      messages: [
        {
          role: "user",
          content:
            "Runtime recovery: the previous attempt to create output/task/report.tex was blocked. Continue safely.",
        },
      ],
      meta: {
        goalContract: {
          currentRequest: "Create a reader-facing evidence brief with a meaningful filename.",
        },
      },
    }
  );
  assert(
    echoedGenericArtifactBlock?.category === "artifact-filename",
    "runtime feedback echoed a blocked generic filename into apparent user authorization"
  );
  assert(
    (await genericArtifactFilenameBlock(
      "write_file",
      { path: "output/task/report.tex", content: "document" },
      {
        commandCwd: workspace,
        taskProfile: "writing",
        goal: "Create output/task/report.tex exactly as named.",
      },
      {
        goal: "Create output/task/report.tex exactly as named.",
        messages: [],
        meta: {
          goalContract: {
            currentRequest: "Create output/task/report.tex exactly as named.",
          },
        },
      }
    )) === null,
    "an exact filename in the active goal contract was incorrectly blocked"
  );
  assert(
    (await genericArtifactFilenameBlock(
      "write_file",
      { path: "outputs/summary.json", content: "{}" },
      { commandCwd: workspace, taskProfile: "data", goal: "Analyze the experiment." },
      {
        goal: "Analyze the experiment.",
        messages: [],
        meta: { projectVerification: { requiredOutputs: ["outputs/summary.json"] } },
      }
    )) === null,
    "an exact project-declared artifact filename was incorrectly rejected as generic"
  );
  assert(
    (await genericArtifactFilenameBlock(
      "write_file",
      { path: "reports/fluorescence-dose-response-analysis.md", content: "summary" },
      { commandCwd: workspace, taskProfile: "data" },
      { goal: "Analyze the experiment.", messages: [], meta: {} }
    )) === null,
    "a descriptive artifact filename was incorrectly blocked"
  );

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
  const deepSeekCompactionState = {
    goal: "Continue a data repair from retained evidence.",
    plan: "Use the verified source evidence, repair once, then test.",
    stepsCompleted: 4,
    meta: {},
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "inspect the exact source" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "The source must be read before editing.",
        tool_calls: [
          { id: "deep-read", type: "function", function: { name: "read_file", arguments: '{"path":"analysis.py"}' } },
        ],
      },
      { role: "tool", tool_call_id: "deep-read", content: '{"ok":true,"path":"analysis.py","content":"verified source"}' },
    ],
  };
  const deepSeekCompacted = buildModelTimeoutRetryMessages(
    deepSeekCompactionState,
    { provider: "deepseek", model: "deepseek-v4-pro", contextWindowTokens: 32768 },
    { url: "", title: "No browser page open" },
    5,
    new Error("synthetic timeout")
  );
  assert(
    !deepSeekCompacted.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls)),
    "DeepSeek compaction synthesized assistant tool calls without original reasoning_content"
  );
  assert(
    deepSeekCompacted.some(
      (message) => message.role === "user" && /Retained runtime tool evidence/.test(message.content) && /analysis\.py/.test(message.content) && /verified source/.test(message.content)
    ),
    "DeepSeek compaction dropped bounded source evidence while removing synthetic tool-call messages"
  );
  assert(
    !shouldReviewToolResult(
      { ok: true, toolName: "read_file", path: "analysis.py" },
      { meta: { toolLoop: { warned: ["old-read"], recent: [{ toolName: "read_file", ok: false }] } } }
    ),
    "SCS scheduled a redundant review for a successful read because an older read failed"
  );
  assert(
    shouldReviewToolResult(
      { ok: false, blocked: true, toolName: "read_file", reason: "exact read blocked" },
      { meta: { toolLoop: { warned: [], recent: [] } } }
    ),
    "SCS stopped reviewing an exact blocked tool result"
  );
  assert(
    !shouldResetStaticDiscoveryPhase({
      ok: true,
      toolName: "run_command",
      args: { command: 'echo "SOURCE"; cat analysis.py; echo "DIFF"; git diff -- analysis.py' },
      commandPolicy: { writesWorkspace: false },
    }),
    "composite read-only shell discovery incorrectly reset the bounded discovery phase"
  );
  assert(
    shouldResetStaticDiscoveryPhase({
      ok: true,
      toolName: "run_command",
      args: { command: "python analysis.py" },
      commandPolicy: { writesWorkspace: true },
    }),
    "a successful workspace-writing command did not reset the discovery phase"
  );
  const workspaceToolConfig = {
    commandCwd: workspace,
    allowFileTools: true,
    workspaceWritePolicy: "allow",
    sandboxMode: "host",
  };
  const externalReadRoot = path.join(tempRoot, "external-reference");
  await fs.mkdir(externalReadRoot, { recursive: true });
  await fs.writeFile(path.join(externalReadRoot, "README.md"), "# External reference\nverified routine\n", "utf8");
  const blockedExternalRead = await executeWorkspaceTool(
    "read_file",
    { path: path.join(externalReadRoot, "README.md") },
    workspaceToolConfig
  );
  assert(blockedExternalRead.blocked, "outside read unexpectedly bypassed explicit read-root policy");
  const readRootConfig = { ...workspaceToolConfig, readOnlyRoots: [externalReadRoot] };
  const allowedExternalRead = await executeWorkspaceTool(
    "read_file",
    { path: path.join(externalReadRoot, "README.md") },
    readRootConfig
  );
  assert(allowedExternalRead.ok, "explicit read root did not allow a structured read");
  assert(allowedExternalRead.content.includes("verified routine"), "explicit read-root content was not returned");
  const blockedExternalWrite = await executeWorkspaceTool(
    "write_file",
    { path: path.join(externalReadRoot, "should-not-write.md"), content: "blocked\n", mode: "create" },
    readRootConfig
  );
  assert(blockedExternalWrite.blocked, "read root incorrectly authorized an outside-workspace write");
  const selectedSkillPath = path.join(externalReadRoot, "SKILL.md");
  await fs.writeFile(selectedSkillPath, "# Selected skill\nexact file only\n", "utf8");
  const selectedSkillConfig = { ...workspaceToolConfig, skillReadOnlyRoots: [selectedSkillPath] };
  const selectedSkillRead = await executeWorkspaceTool(
    "read_file",
    { path: selectedSkillPath },
    selectedSkillConfig
  );
  assert(selectedSkillRead.ok, "selected skill file did not receive exact read-only authorization");
  const selectedSkillSiblingRead = await executeWorkspaceTool(
    "read_file",
    { path: path.join(externalReadRoot, "README.md") },
    selectedSkillConfig
  );
  assert(selectedSkillSiblingRead.blocked, "selected skill authorization leaked to sibling files");
  const recursiveGrepPolicy = evaluateCommandPolicy("grep -r 'make a song' /tmp/reference", {
    allowShellTool: true,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    commandCwd: workspace,
  });
  assert(!recursiveGrepPolicy.allowed, "recursive grep should be blocked as unbounded discovery");
  assert(recursiveGrepPolicy.category === "unbounded-discovery", "recursive grep used the wrong policy category");
  assert(recursiveGrepPolicy.recoverable, "recursive grep block should be automatically recoverable");
  const boundedRgPolicy = evaluateCommandPolicy("rg -n --max-count 20 'make a song' /tmp/reference", {
    allowShellTool: true,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    commandCwd: workspace,
  });
  const opaqueInPlaceEditPolicy = evaluateCommandPolicy("sed -i 's/old/new/' report.md", {
    allowShellTool: true,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    commandCwd: workspace,
    allowDestructive: true,
  });
  assert(
    opaqueInPlaceEditPolicy.writesWorkspace === true,
    "an unknown host shell edit was incorrectly classified as read-only"
  );
  const destructiveGitPolicy = evaluateCommandPolicy("git reset --hard HEAD~1", {
    allowShellTool: true,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    commandCwd: workspace,
    allowDestructive: true,
  });
  assert(
    destructiveGitPolicy.category === "destructive" &&
      destructiveGitPolicy.writesWorkspace === true,
    "a destructive git command was not classified as a workspace mutation"
  );
  const safeTagPolicy = evaluateCommandPolicy("git tag v0.20.216", {
    allowShellTool: true,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    commandCwd: workspace,
  });
  assert(
    safeTagPolicy.allowed && safeTagPolicy.category === "git-workflow" && safeTagPolicy.writesWorkspace,
    "a bounded local git tag was not classified as a git workflow action"
  );
  assert(boundedRgPolicy.allowed, "targeted bounded rg should remain allowed");
  const boundedAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: { command: "grep -r 'make a song' /tmp/reference" },
    guard: recursiveGrepPolicy,
    config: { allowShellTool: true, sandboxMode: "host", commandCwd: workspace },
    state: { sessionId: "bounded-search-smoke" },
  });
  assert(boundedAdvice.autoRecover, "unbounded discovery advice should tell the agent to recover automatically");
  assert(/Do not ask the user/i.test(boundedAdvice.instruction), "bounded recovery advice should not require user approval");
  const cdataSvgResult = await executeWorkspaceTool(
    "write_file",
    {
      path: "figures/cdata-wrapped.svg",
      content: "<![CDATA[<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"></svg>]]>",
    },
    workspaceToolConfig
  );
  assert(cdataSvgResult.ok === false, "CDATA-wrapped SVG write should be marked not ok");
  assert(cdataSvgResult.artifactValidation?.kind === "svg", "SVG validation result missing");
  assert(/CDATA/i.test(cdataSvgResult.artifactValidation.errors.join(" ")), "CDATA SVG validation did not explain the wrapper problem");
  const invalidXmlSvgResult = await executeWorkspaceTool(
    "write_file",
    {
      path: "figures/invalid-unescaped-text.svg",
      content: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"><text x="4" y="24">latency < 50 ms</text></svg>',
    },
    workspaceToolConfig
  );
  assert(invalidXmlSvgResult.ok === false, "SVG write with unescaped text '<' should be marked not ok");
  assert(
    /XML parser rejected/i.test(invalidXmlSvgResult.artifactValidation?.errors?.join(" ") || ""),
    "invalid SVG XML was not rejected by the XML parser"
  );
  const validSvgResult = await executeWorkspaceTool(
    "write_file",
    {
      path: "figures/valid.svg",
      content: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\" /></svg>",
    },
    workspaceToolConfig
  );
  assert(validSvgResult.ok === true, "valid standalone SVG write should pass");
  assert(validSvgResult.artifactValidation?.ok === true, "valid SVG validation did not pass");
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
  const novelRoute = selectModelRoute({
    routingMode: "smart",
    provider: "deepseek",
    goal: "write a novel chapter with a complete story bible, continuity, and scene-level revision notes",
    taskProfile: "novel",
  });
  assert(/pro/i.test(novelRoute.model), "novel profile did not route substantial writing work to DeepSeek pro");
  assert(
    isLikelyWritingSpecialistGoal("Write a novel chapter from this story bible and keep the tone lyrical.", "novel"),
    "writing specialist goal detector did not recognize novel chapter drafting"
  );
  const writerDraft = await runWritingSpecialist(
    {
      task: "draft",
      kind: "novel",
      writingBrief: "Write the opening of a quiet science-fiction chapter.",
      canon: "The protagonist repairs drones in a rain-soaked harbor city.",
      styleGuide: "Concrete sensory prose, restrained dialogue.",
      formatIntent: "markdown",
    },
    { provider: "mock", model: "mock-agent" }
  );
  assert(writerDraft.ok, "mock writing specialist did not succeed");
  assert(writerDraft.draft.includes("Writing brief honored"), "mock writing specialist did not return draft prose");
  assert(writerDraft.formatHandoff?.targetFormat === "markdown", "writing specialist did not preserve formatter handoff");
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
  assert(guidance.includes("Surgical editing contract:"), "engineering guidance did not include surgical editing contract");
  assert(guidance.includes("Evidence-card template:"), "engineering guidance did not include evidence-card template");
  const cadGuidance = engineeringGuidanceForTask(
    "Build a centered parametric CAD cradle and export STEP, STL, 3MF, and a render for 3D printing.",
    "auto"
  );
  assert(cadGuidance.includes("CAD/fabrication:"), "auto guidance did not recognize a CAD fabrication task");
  assert(cadGuidance.includes("one canonical validation section"), "auto CAD guidance permits ambiguous validation aliases");
  assert(
    recommendedMaxStepsForTask({ goal: "Build a CAD holder with STEP STL and 3MF validation.", taskProfile: "auto" }) >= 44,
    "auto CAD task did not receive a complete build/render/validation budget"
  );
  assert(
    shouldUseSurgicalContextForTask({
      goal: "fix this large repository bug by tracing callers",
      taskProfile: "auto",
      complexityScore: 3,
    }),
    "surgical context did not trigger for complex repository bug"
  );
  assert(
    !shouldUseSurgicalContextForTask({ goal: "say hello", taskProfile: "auto", complexityScore: 0 }),
    "surgical context triggered for a trivial non-engineering request"
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
  const hostReadRootPolicy = {
    ...hostWorkspacePolicy,
    readOnlyRoots: [externalReadRoot],
  };
  const exactReadOnlySkillLoop = [
    "for f in",
    "/home/lachlan/.agintiflow/skillmesh/skills/lazyedit-publish-workflow/SKILL.md",
    "/home/lachlan/.codex/skills/musia-music-production/SKILL.md",
    "/home/lachlan/.codex/skills/musia-lalachan-mv-workflow/SKILL.md",
    "/home/lachlan/.codex/skills/lalachan-xyq-browser-video/SKILL.md",
    "/home/lachlan/.nvm/versions/node/v22.21.0/lib/node_modules/@lazyingart/agintiflow/skills/browser-automation/SKILL.md",
    "/home/lachlan/.codex/skills/musia-song-localization/SKILL.md;",
    'do echo "===== $f ====="; wc -l "$f"; done',
  ].join(" ");
  const exactReadOnlySkillLoopPolicy = evaluateCommandPolicy(exactReadOnlySkillLoop, hostWorkspacePolicy);
  assert(
    exactReadOnlySkillLoopPolicy.allowed &&
      exactReadOnlySkillLoopPolicy.category === "read-only" &&
      exactReadOnlySkillLoopPolicy.boundedForLoop === true &&
      exactReadOnlySkillLoopPolicy.needsNetwork === false &&
      exactReadOnlySkillLoopPolicy.writesWorkspace === false,
    "a finite echo/wc skill audit loop incorrectly required destructive host permission"
  );
  const multilineReadOnlyLoopPolicy = evaluateCommandPolicy(
    [
      "for target in README.md package.json",
      "do",
      '  echo "== ${target} =="',
      '  wc -l "$target"',
      "done",
    ].join("\n"),
    hostWorkspacePolicy
  );
  assert(
    multilineReadOnlyLoopPolicy.allowed && multilineReadOnlyLoopPolicy.category === "read-only",
    "a multiline finite read-only loop was not recognized"
  );
  for (const unsafeLoop of [
    'for f in README.md; do rm -rf "$f"; done',
    'for f in README.md; do curl "https://example.com/$f"; done',
    'for f in README.md; do cp "$f" copied.md; done',
    'for f in README.md; do echo "$f" > report.md; done',
    'for f in $(find . -type f); do wc -l "$f"; done',
    'for f in *.md; do wc -l "$f"; done',
    'for f in --pre=unsafe-helper; do rg pattern "$f"; done',
    'for f in $FILES; do wc -l "$f"; done',
    'for f in README.md; do wc -l "${f:-package.json}"; done',
    'for f in README.md; do for g in package.json; do wc -l "$g"; done; done',
    'for f in README.md; do wc -l "$f" & done',
  ]) {
    const unsafeLoopPolicy = evaluateCommandPolicy(unsafeLoop, hostWorkspacePolicy);
    assert(
      !unsafeLoopPolicy.allowed && unsafeLoopPolicy.category !== "read-only",
      `unsafe or dynamic shell loop bypassed the bounded read-only policy: ${unsafeLoop}`
    );
  }
  const exactCompoundReadOnlyAudit = [
    'echo "=== CWD ==="',
    'pwd',
    'echo "=== workspace listing ==="',
    'ls -la',
    'echo "=== workspace git status ==="',
    'git status --short 2>&1 | head -40',
    'echo "=== read roots ==="',
    'for d in /home/lachlan/ProjectsLFS/AgenticApp /home/lachlan/ProjectsLFS/Musia /home/lachlan/ProjectsLFS/LALACHAN /home/lachlan/DiskMech/Projects/lazyedit; do echo "--- $d ---"; if [ -d "$d" ]; then ls -la "$d" 2>&1 | head -80; else echo "MISSING"; fi; done',
  ].join("; ");
  const exactCompoundReadOnlyAuditPolicy = evaluateCommandPolicy(
    exactCompoundReadOnlyAudit,
    hostReadRootPolicy
  );
  assert(
    exactCompoundReadOnlyAuditPolicy.allowed &&
      exactCompoundReadOnlyAuditPolicy.category === "read-only" &&
      exactCompoundReadOnlyAuditPolicy.boundedForLoop === true &&
      exactCompoundReadOnlyAuditPolicy.boundedCompoundSequence === true &&
      exactCompoundReadOnlyAuditPolicy.needsNetwork === false &&
      exactCompoundReadOnlyAuditPolicy.writesWorkspace === false,
    "a finite read-only prelude and conditional directory audit incorrectly required destructive host permission"
  );
  const exactReadOnlyExistenceLoopWithSuffix =
    'for f in scripts/xyq_cdp_browser.py scripts/xyq_chrome/launch_chrome.sh scripts/xyq_chrome/watch_thread_dom_download.py scripts/musia_mv_finalize.sh; do test -e "/home/lachlan/ProjectsLFS/LALACHAN/$f" && echo "OK   $f" || echo "MISS $f"; done; echo "---mv_packs---"; ls -1 /home/lachlan/ProjectsLFS/Musia/data/mv_packs 2>&1; echo "---creative_projects---"; ls -1 /home/lachlan/ProjectsLFS/Musia/data/creative_projects 2>&1 | head -20';
  const exactReadOnlyExistenceLoopWithSuffixPolicy = evaluateCommandPolicy(
    exactReadOnlyExistenceLoopWithSuffix,
    hostReadRootPolicy
  );
  assert(
    exactReadOnlyExistenceLoopWithSuffixPolicy.allowed &&
      exactReadOnlyExistenceLoopWithSuffixPolicy.category === "read-only" &&
      exactReadOnlyExistenceLoopWithSuffixPolicy.boundedForLoop === true &&
      exactReadOnlyExistenceLoopWithSuffixPolicy.boundedCompoundSequence === true &&
      exactReadOnlyExistenceLoopWithSuffixPolicy.needsNetwork === false &&
      exactReadOnlyExistenceLoopWithSuffixPolicy.writesWorkspace === false,
    "a finite read-only existence loop with bounded list suffix incorrectly required destructive host permission"
  );
  const exactReadOnlyReportLiteralAudit =
    'cd . && for s in \'handoff/LABCANVAS_AGENT_API_HANDOFF_2026_07_29.md\' \'/home/lachlan/ProjectsLFS/AgenticApp\' \'src/agenticapp/musia_ops.py\' \'scripts/xyq_chrome/watch_thread_dom_download.py\' \'Reviewed master\' \'ffprobe verification\' \'Song-only versus MV separation\' \'MV request versus publication separation\'; do n=$(grep -c -- "$s" media-routine-readiness.md); echo "$n :: $s"; done; echo \'--- git status ---\'; git status --short';
  const exactReadOnlyReportLiteralAuditPolicy = evaluateCommandPolicy(
    exactReadOnlyReportLiteralAudit,
    hostWorkspacePolicy
  );
  assert(
    exactReadOnlyReportLiteralAuditPolicy.allowed &&
      exactReadOnlyReportLiteralAuditPolicy.category === "read-only" &&
      exactReadOnlyReportLiteralAuditPolicy.boundedForLoop === true &&
      exactReadOnlyReportLiteralAuditPolicy.needsNetwork === false &&
      exactReadOnlyReportLiteralAuditPolicy.writesWorkspace === false,
    "a bounded report literal-count audit incorrectly required destructive host permission"
  );
  const exactReadOnlyFormattedReportAudit = [
    "f=media-routine-readiness.md",
    "printf 'lines\\tbytes\\tsha256\\n'",
    'wc -lc "$f"',
    'sha256sum "$f"',
    "printf '\\n--- literal occurrence counts (bounded) ---\\n'",
    "for s in \\",
    "  '/home/lachlan/ProjectsLFS/Musia' \\",
    "  '/home/lachlan/ProjectsLFS/AgenticApp' \\",
    "  'music generation' \\",
    "; do",
    '  n=$(grep -oF -- "$s" "$f" | wc -l | tr -d \' \')',
    '  printf \'%-58s %s\\n\' "$s" "$n"',
    "done",
  ].join("\n");
  const exactReadOnlyFormattedReportAuditPolicy = evaluateCommandPolicy(
    exactReadOnlyFormattedReportAudit,
    hostWorkspacePolicy
  );
  assert(
    exactReadOnlyFormattedReportAuditPolicy.allowed &&
      exactReadOnlyFormattedReportAuditPolicy.category === "read-only" &&
      exactReadOnlyFormattedReportAuditPolicy.boundedForLoop === true &&
      exactReadOnlyFormattedReportAuditPolicy.needsNetwork === false &&
      exactReadOnlyFormattedReportAuditPolicy.writesWorkspace === false,
    "a literal-file formatted count audit incorrectly required destructive host permission"
  );
  const exactReadOnlyMultiPatternSummary =
    "grep -oF -e 'handoff/report.md' -e 'Reviewed master' -e 'ffprobe' report.md | sort | uniq -c";
  const exactReadOnlyMultiPatternSummaryPolicy = evaluateCommandPolicy(
    exactReadOnlyMultiPatternSummary,
    hostWorkspacePolicy
  );
  assert(
    exactReadOnlyMultiPatternSummaryPolicy.allowed &&
      exactReadOnlyMultiPatternSummaryPolicy.category === "read-only" &&
      exactReadOnlyMultiPatternSummaryPolicy.needsNetwork === false &&
      exactReadOnlyMultiPatternSummaryPolicy.writesWorkspace === false,
    "a bounded grep/sort/uniq count summary incorrectly required destructive host permission"
  );
  const exactPdfHeaderAudit =
    'cd /home/lachlan/ProjectsLFS/AgenticApp/output/wechat_worker/task-123 && file report.pdf && head -c 8 report.pdf | xxd | head -1';
  const exactPdfHeaderAuditPolicy = evaluateCommandPolicy(
    exactPdfHeaderAudit,
    {
      ...hostWorkspacePolicy,
      commandCwd: "/home/lachlan/ProjectsLFS/AgenticApp",
    }
  );
  assert(
    exactPdfHeaderAuditPolicy.allowed &&
      exactPdfHeaderAuditPolicy.category === "read-only" &&
      exactPdfHeaderAuditPolicy.needsNetwork === false &&
      exactPdfHeaderAuditPolicy.writesWorkspace === false,
    "a bounded workspace-local PDF header audit incorrectly required destructive host permission"
  );
  const pdfinfoPolicy = evaluateCommandPolicy("pdfinfo report.pdf", hostWorkspacePolicy);
  assert(
    pdfinfoPolicy.allowed &&
      pdfinfoPolicy.category === "read-only" &&
      pdfinfoPolicy.needsNetwork === false &&
      pdfinfoPolicy.writesWorkspace === false,
    "plain workspace-local pdfinfo inspection incorrectly required host permission"
  );
  for (const unsafeXxdCommand of [
    "xxd -r - output.bin",
    "xxd report.pdf output.hex",
  ]) {
    const unsafeXxdPolicy = evaluateCommandPolicy(
      unsafeXxdCommand,
      hostWorkspacePolicy
    );
    assert(
      !unsafeXxdPolicy.allowed ||
        unsafeXxdPolicy.category !== "read-only" ||
        unsafeXxdPolicy.writesWorkspace === true,
      `write-capable xxd command bypassed host policy: ${unsafeXxdCommand}`
    );
  }
  const exactReadOnlyGitIdentityProbe =
    'git status --short && echo "TOPLEVEL=$(git rev-parse --show-toplevel 2>&1)" && echo "BRANCH=$(git rev-parse --abbrev-ref HEAD 2>&1)"';
  const exactReadOnlyGitIdentityProbePolicy = evaluateCommandPolicy(
    exactReadOnlyGitIdentityProbe,
    hostWorkspacePolicy
  );
  assert(
    exactReadOnlyGitIdentityProbePolicy.allowed &&
      exactReadOnlyGitIdentityProbePolicy.category === "read-only" &&
      exactReadOnlyGitIdentityProbePolicy.needsNetwork === false &&
      exactReadOnlyGitIdentityProbePolicy.writesWorkspace === false,
    "bounded read-only git identity substitutions incorrectly required destructive host permission"
  );
  const exactReadOnlyGitIdentityLoop =
    'for d in /home/lachlan/ProjectsLFS/AgenticApp /home/lachlan/ProjectsLFS/Musia /home/lachlan/ProjectsLFS/LALACHAN /home/lachlan/DiskMech/Projects/lazyedit; do echo "=== $d ==="; echo "user.name=[$(git -C "$d" config user.name 2>/dev/null)]"; echo "user.email=[$(git -C "$d" config user.email 2>/dev/null)]"; echo "--status--"; git -C "$d" status --short 2>&1 | head -15; echo; done';
  const exactReadOnlyGitIdentityLoopPolicy = evaluateCommandPolicy(
    exactReadOnlyGitIdentityLoop,
    hostReadRootPolicy
  );
  assert(
    exactReadOnlyGitIdentityLoopPolicy.allowed &&
      exactReadOnlyGitIdentityLoopPolicy.category === "read-only" &&
      exactReadOnlyGitIdentityLoopPolicy.boundedForLoop === true &&
      exactReadOnlyGitIdentityLoopPolicy.needsNetwork === false &&
      exactReadOnlyGitIdentityLoopPolicy.writesWorkspace === false,
    "bounded per-repository Git identity/status audit incorrectly required destructive host permission"
  );
  const exactReadOnlyGitRepositoryAudit =
    'for d in /home/lachlan/ProjectsLFS/AgenticApp /home/lachlan/ProjectsLFS/Musia /home/lachlan/ProjectsLFS/LALACHAN /home/lachlan/DiskMech/Projects/lazyedit; do echo "=== $d ==="; git -C "$d" config --get user.name; git -C "$d" config --get user.email; git -C "$d" status --porcelain=v1 --branch; echo "--- remotes ---"; git -C "$d" remote -v; echo; done';
  const exactReadOnlyGitRepositoryAuditPolicy = evaluateCommandPolicy(
    exactReadOnlyGitRepositoryAudit,
    hostReadRootPolicy
  );
  assert(
    exactReadOnlyGitRepositoryAuditPolicy.allowed &&
      exactReadOnlyGitRepositoryAuditPolicy.category === "read-only" &&
      exactReadOnlyGitRepositoryAuditPolicy.boundedForLoop === true &&
      exactReadOnlyGitRepositoryAuditPolicy.needsNetwork === false &&
      exactReadOnlyGitRepositoryAuditPolicy.writesWorkspace === false,
    "bounded per-repository Git identity/status/remote audit incorrectly required destructive host permission"
  );
  for (const unsafeEchoSubstitution of [
    'echo "VALUE=$(rm -rf report.md)"',
    'echo "VALUE=$(cp README.md report.md)"',
    'echo "VALUE=$(curl https://example.com)"',
    'echo "VALUE=$(git status; rm -rf report.md)"',
    'echo "VALUE=$(echo $(pwd))"',
    'echo "VALUE=$((1 + 1))"',
    'echo "VALUE=$(git status)" > report.md',
    'echo "VALUE=`git status`"',
  ]) {
    const unsafeEchoSubstitutionPolicy = evaluateCommandPolicy(
      unsafeEchoSubstitution,
      hostWorkspacePolicy
    );
    assert(
      !unsafeEchoSubstitutionPolicy.allowed ||
        unsafeEchoSubstitutionPolicy.category !== "read-only" ||
        unsafeEchoSubstitutionPolicy.writesWorkspace === true ||
        unsafeEchoSubstitutionPolicy.needsNetwork === true,
      `unsafe echo command substitution bypassed the bounded read-only policy: ${unsafeEchoSubstitution}`
    );
  }
  for (const unsafeLoopSubstitution of [
    'for d in /tmp; do echo "VALUE=$(rm -rf report.md)"; done',
    'for d in /tmp; do echo "VALUE=$(curl https://example.com)"; done',
    'for d in /tmp; do echo "VALUE=$(echo $(pwd))"; done',
    'for d in /tmp; do echo "VALUE=$SECRET"; done',
    'for d in /tmp; do echo "VALUE=$(git -C "$d" config user.name attacker)"; done',
    'for d in /tmp; do echo "VALUE=$(git -C "$d" config --global user.name)"; done',
    'for d in /tmp; do echo "VALUE=$(git -C "$d" status; rm -rf report.md)"; done',
    'for d in /tmp; do git -C "$d" status --short > report.md; done',
    'for d in /tmp; do git -C "$d" remote add origin https://example.com/repo.git; done',
    'for d in /tmp; do git -C "$d" remote set-url origin https://example.com/repo.git; done',
    'for s in README.md; do n=$(rm -rf report.md); echo "$n :: $s"; done',
    'for s in README.md; do n=$(curl https://example.com); echo "$n :: $s"; done',
    'for s in README.md; do n=$(cat "$s"); echo "$n :: $s"; done',
    'for s in README.md; do n=$(grep -c -- "$s" README.md); rm -rf "$n"; done',
    'f=README.md; printf "%s\\n" "$(cat .aginti/.env)"; for s in one; do echo "$s"; done',
    'f=README.md; printf "%s\\n" "$f" > copied.md; for s in one; do echo "$s"; done',
    'f=$(cat README.md); printf "%s\\n" "$f"; for s in one; do echo "$s"; done',
    'f=README.md; for s in one; do n=$(grep -oF -- "$s" "$f" | wc -l | tr -d " "); printf -v target "%s" "$n"; done',
    'f=README.md; for s in one; do n=$(grep -oF -- "$s" "$f" | wc -l | tr -d " "); rm -rf "$n"; done',
    "grep -oF -e 'term' report.md | sort | uniq -c output.txt",
    "grep -oF -e 'term' report.md | sort | uniq -c > output.txt",
    'grep -oF -e "$(cat .aginti/.env)" report.md | sort | uniq -c',
    'for s in \'README.md; rm -rf report.md\'; do echo "$s"; done',
  ]) {
    const unsafeLoopSubstitutionPolicy = evaluateCommandPolicy(
      unsafeLoopSubstitution,
      hostReadRootPolicy
    );
    assert(
      !unsafeLoopSubstitutionPolicy.allowed ||
        unsafeLoopSubstitutionPolicy.category !== "read-only" ||
        unsafeLoopSubstitutionPolicy.writesWorkspace === true ||
        unsafeLoopSubstitutionPolicy.needsNetwork === true,
      `unsafe loop substitution bypassed the bounded read-only policy: ${unsafeLoopSubstitution}`
    );
  }
  for (const unsafeCompoundAudit of [
    'cp README.md copied.md; for d in /tmp; do echo "$d"; done',
    'echo start; for d in /tmp; do if [ -d "$d" ]; then rm -rf "$d"; else echo missing; fi; done',
    'echo start; for d in /tmp; do if [ -d "$d" ]; then curl https://example.com; else echo missing; fi; done',
    'echo start; for d in /tmp; do if [ -d "$d" ]; then echo "$d" > report.md; else echo missing; fi; done',
    'echo start; for d in /tmp; do if [ -d "$(pwd)" ]; then ls; else echo missing; fi; done',
    'echo start; for d in /tmp; do if [ -d "$d" ]; then if [ -f "$d/x" ]; then cat "$d/x"; else echo missing; fi; else echo absent; fi; done',
    'echo start; for d in $ROOTS; do if [ -d "$d" ]; then ls "$d"; else echo missing; fi; done',
    'echo start; for d in /tmp; do if [ -d "$d" ]; then ls "$d"; else echo missing; fi; done; rm -rf report.md',
    'for f in README.md; do test -e "$f" && echo ok || echo missing; done; cp README.md copied.md',
    'for f in README.md; do test -e "$f" && echo ok || echo missing; done; curl https://example.com',
    'for f in README.md; do test -e "$f" && echo ok || echo missing; done; echo done > report.md',
  ]) {
    const unsafeCompoundAuditPolicy = evaluateCommandPolicy(unsafeCompoundAudit, hostReadRootPolicy);
    assert(
      !unsafeCompoundAuditPolicy.allowed ||
        unsafeCompoundAuditPolicy.category !== "read-only" ||
        unsafeCompoundAuditPolicy.writesWorkspace === true ||
        unsafeCompoundAuditPolicy.needsNetwork === true,
      `unsafe compound shell audit bypassed the bounded read-only policy: ${unsafeCompoundAudit}`
    );
  }
  const readRootDoctorPolicy = evaluateCommandPolicy(
    `cd ${externalReadRoot} && node bin/musia.js doctor --json 2>&1 | head -80`,
    hostReadRootPolicy
  );
  assert(readRootDoctorPolicy.allowed, "explicit read root blocked a bounded read-only doctor command");
  assert(readRootDoctorPolicy.category === "read-only", "read-root doctor command was not read-only");
  assert(readRootDoctorPolicy.readOnlyRoot === externalReadRoot, "read-root doctor command lost root provenance");
  const relativeReadRootDoctorPolicy = evaluateCommandPolicy(
    "cd ../external-reference && node bin/musia.js doctor --json",
    hostReadRootPolicy
  );
  assert(relativeReadRootDoctorPolicy.allowed, "relative path to an explicit read root was not recognized");
  const readRootHelpPolicy = evaluateCommandPolicy(
    `cd ${externalReadRoot} && python3 scripts/tool.py --help 2>&1 | head -40`,
    hostReadRootPolicy
  );
  assert(readRootHelpPolicy.allowed, "explicit read root blocked a bounded Python help command");
  const readRootCondaHelpPolicy = evaluateCommandPolicy(
    `cd ${externalReadRoot} && conda run -n lazyedit python scripts/tool.py --help 2>&1 | head -40`,
    hostReadRootPolicy
  );
  assert(readRootCondaHelpPolicy.allowed, "explicit read root blocked a bounded Conda Python help command");
  assert(readRootCondaHelpPolicy.category === "read-only", "Conda Python help command was not read-only");
  const readRootCondaMutationPolicy = evaluateCommandPolicy(
    `cd ${externalReadRoot} && conda run -n lazyedit python scripts/tool.py generate`,
    hostReadRootPolicy
  );
  assert(!readRootCondaMutationPolicy.allowed, "explicit read root authorized a mutating Conda tool invocation");
  const multilineReadRootPolicy = evaluateCommandPolicy(
    [
      `cd ${externalReadRoot} && node bin/musia.js doctor --json`,
      `cd ${externalReadRoot} && python3 scripts/tool.py --help`,
    ].join("\n"),
    hostReadRootPolicy
  );
  assert(multilineReadRootPolicy.allowed, "newline-separated bounded read-root checks were treated as broad shell");
  assert(multilineReadRootPolicy.category === "read-only", "multiline read-root checks lost read-only classification");
  const redirectedReadRootInspectionPolicy = evaluateCommandPolicy(
    `cd ${externalReadRoot} 2>&1 && echo "=== PWD ===" && pwd && git status --short 2>&1 | head -20 && ls -la 2>&1 | head -40 && cat package.json 2>&1 | head -60`,
    hostReadRootPolicy
  );
  assert(
    redirectedReadRootInspectionPolicy.allowed,
    "a benign stderr redirect after cd made a bounded read-root inspection look like broad host shell"
  );
  assert(
    redirectedReadRootInspectionPolicy.category === "read-only",
    "redirected read-root inspection lost its read-only classification"
  );
  const readRootMutationPolicy = evaluateCommandPolicy(
    `cd ${externalReadRoot} && node bin/musia.js generate`,
    hostReadRootPolicy
  );
  assert(!readRootMutationPolicy.allowed, "explicit read root authorized a non-inspection command");
  const readRootTestPolicy = evaluateCommandPolicy(`cd ${externalReadRoot} && npm test`, hostReadRootPolicy);
  assert(!readRootTestPolicy.allowed, "explicit read root authorized a test that could write caches or builds");
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
  const pgrepNoMatchPolicy = evaluateCommandPolicy(
    "pgrep -af gateway_service",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(
    pgrepNoMatchPolicy.allowed &&
      pgrepNoMatchPolicy.category === "read-only" &&
      pgrepNoMatchPolicy.noMatchExitIsSuccess === true,
    "pgrep should be a read-only query whose no-match exit is meaningful evidence"
  );
  const pgrepNoMatchResult = normalizeNoMatchQueryResult(
    { ok: false, exitCode: 1, stdout: "", stderr: "" },
    pgrepNoMatchPolicy
  );
  assert(
    pgrepNoMatchResult.ok === true &&
      pgrepNoMatchResult.noMatch === true &&
      pgrepNoMatchResult.semanticOutcome === "no-match",
    "pgrep exit 1 with no diagnostics should normalize to successful no-match evidence"
  );
  assert(
    normalizeNoMatchQueryResult(
      { ok: false, exitCode: 2, stdout: "", stderr: "invalid option" },
      pgrepNoMatchPolicy
    ).ok === false,
    "an actual pgrep error was incorrectly normalized as no-match evidence"
  );
  const readonlyDiffSlicePolicy = evaluateCommandPolicy(
    "git diff -- src/agent-runner.js | sed -n '1,240p'",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(
    readonlyDiffSlicePolicy.allowed && readonlyDiffSlicePolicy.category === "read-only",
    "a bounded sed print filter made a read-only Git diff pipeline require broad shell access"
  );
  const nodeNpmTestPolicy = evaluateCommandPolicy(
    'cd /workspace && node --version && npm test 2>&1; echo "EXIT:$?"',
    dockerWorkspaceNoInstallsPolicy
  );
  assert(nodeNpmTestPolicy.allowed, "node --version plus npm test should not require package-install-policy=allow");
  assert(nodeNpmTestPolicy.category === "test", "node --version plus npm test should be classified as test");
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
  for (const engine of ["xelatex", "lualatex"]) {
    const unicodeLatexCompilePolicy = evaluateCommandPolicy(
      `${engine} -interaction=nonstopmode -halt-on-error main.tex`,
      hostWorkspacePolicy
    );
    assert(unicodeLatexCompilePolicy.allowed, `workspace-local ${engine} compile should be allowed without destructive host access`);
    assert(unicodeLatexCompilePolicy.category === "toolchain", `workspace-local ${engine} compile should be classified as toolchain`);
  }
  const latexmkCompilePolicy = evaluateCommandPolicy(
    'cd profile-latex-20260506 && latexmk -pdf main.tex 2>&1; echo "LATEXMK_EXIT:$?"',
    dockerWorkspaceNoInstallsPolicy
  );
  assert(latexmkCompilePolicy.allowed, "workspace-local latexmk compile should be allowed without package installs");
  assert(latexmkCompilePolicy.category === "toolchain", "workspace-local latexmk compile should be classified as toolchain");
  const latexmkSynctexCompilePolicy = evaluateCommandPolicy(
    "latexmk -synctex=1 -interaction=nonstopmode main.tex",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(
    latexmkSynctexCompilePolicy.allowed,
    "bounded workspace-local latexmk synctex compile should be allowed"
  );
  assert(
    latexmkSynctexCompilePolicy.category === "toolchain",
    "bounded workspace-local latexmk synctex compile should be classified as toolchain"
  );
  assert(
    goalClearlyAllowsOverwrite("Remove the unrelated article and produce the requested memo."),
    "explicit removal of a wrong artifact did not authorize its coherent replacement"
  );
  assert(
    goalClearlyAllowsOverwrite("删除错误文件后生成正确报告。"),
    "explicit Chinese deletion request did not authorize coherent replacement"
  );
  const pythonUnittestPolicy = evaluateCommandPolicy(
    "python3 -m unittest test_data_helper.py 2>&1",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(pythonUnittestPolicy.allowed, "stdlib python unittest should be allowed without package installs");
  assert(pythonUnittestPolicy.category === "test", "stdlib python unittest should be classified as test");
  const pythonNoBytecodeAcceptancePolicy = evaluateCommandPolicy(
    "PYTHONDONTWRITEBYTECODE=1 python3 /tmp/devops_sensor_gateway_contract.py",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(
    pythonNoBytecodeAcceptancePolicy.allowed &&
      pythonNoBytecodeAcceptancePolicy.category === "test" &&
      pythonNoBytecodeAcceptancePolicy.substantiveTest === true,
    "a no-bytecode Python acceptance command should retain substantive test classification"
  );
  const pythonDemoPolicy = evaluateCommandPolicy("python3 demo.py 2>&1", dockerWorkspaceNoInstallsPolicy);
  assert(pythonDemoPolicy.allowed, "workspace-local python demo script should be allowed without package installs");
  assert(pythonDemoPolicy.category === "toolchain", "workspace-local python demo script should be classified as toolchain");
  const scopedPdfBuildPolicy = evaluateCommandPolicy(
    "cd output/task-1 && python3 build_report.py 2>&1 | tail -20 && ls -la *.pdf && sha256sum *.pdf",
    hostWorkspacePolicy
  );
  assert(scopedPdfBuildPolicy.allowed, "bounded PDF builder plus read-only verification was treated as broad host shell");
  assert(scopedPdfBuildPolicy.category === "toolchain", "bounded PDF builder pipeline should remain a toolchain");
  const broadLocalProbePolicy = evaluateCommandPolicy(
    'python3 --version; echo "---IMPORT TEST---"; python3 -c "import pathlib; print(pathlib.Path.cwd())" 2>&1; echo "---FILES---"; ls -la 2>&1 | head -20',
    dockerWorkspaceNoInstallsPolicy
  );
  assert(
    broadLocalProbePolicy.allowed && broadLocalProbePolicy.category === "general-shell",
    "networkless general shell inside docker-workspace should not require package-install permission"
  );
  const broadLocalHostProbePolicy = evaluateCommandPolicy(
    'python3 -c "import pathlib; print(pathlib.Path.cwd())"',
    { ...hostWorkspacePolicy, packageInstallPolicy: "block" }
  );
  assert(
    !broadLocalHostProbePolicy.allowed,
    "general shell on the host should remain blocked without trusted destructive access"
  );
  const explicitBlockedInstallPolicy = evaluateCommandPolicy(
    "python3 -m pip install requests",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(
    !explicitBlockedInstallPolicy.allowed && explicitBlockedInstallPolicy.category === "package-install",
    "decoupling broad shell from install authorization must not allow explicit package installs"
  );
  const destructiveNoInstallsPolicy = evaluateCommandPolicy("rm -rf reports", dockerWorkspaceNoInstallsPolicy);
  assert(
    !destructiveNoInstallsPolicy.allowed && destructiveNoInstallsPolicy.category === "destructive",
    "decoupling broad shell from install authorization must not weaken destructive-command guards"
  );
  const multiParagraphCommitPolicy = evaluateCommandPolicy(
    'git commit -m "Harden LabShare" -m "Fix path traversal, avoid shell injection, and preserve normal use."',
    dockerWorkspaceNoInstallsPolicy
  );
  assert(
    multiParagraphCommitPolicy.allowed &&
      multiParagraphCommitPolicy.category === "git-workflow" &&
      multiParagraphCommitPolicy.gitOnly === true,
    "a bounded multi-paragraph Git commit message should remain a Git-only workflow"
  );
  const boundedTaskCommitPolicy = evaluateCommandPolicy(
    "git add -- 'labshare.py' 'tests/test_labshare.py' 'SECURITY.md' && git commit -m 'Harden LabShare'",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(
    boundedTaskCommitPolicy.allowed &&
      boundedTaskCommitPolicy.category === "git-workflow" &&
      boundedTaskCommitPolicy.gitOnly === true,
    "the task-owned add-and-commit routine should remain a bounded Git workflow"
  );
  const rVersionProbePolicy = evaluateCommandPolicy("R --version 2>&1", dockerWorkspaceNoInstallsPolicy);
  assert(rVersionProbePolicy.allowed, "R version probe should be allowed without package installs");
  assert(rVersionProbePolicy.category === "read-only", "R version probe should be classified as read-only");
  const rscriptVersionProbePolicy = evaluateCommandPolicy("Rscript --version 2>&1", dockerWorkspaceNoInstallsPolicy);
  assert(rscriptVersionProbePolicy.allowed, "Rscript version probe should be allowed without package installs");
  assert(rscriptVersionProbePolicy.category === "read-only", "Rscript version probe should be classified as read-only");
  const rscriptToolchainPolicy = evaluateCommandPolicy(
    "Rscript scripts/analyze_sales.R --input data/monthly_sales.csv --output reports/r-analysis-20260506 2>&1",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(rscriptToolchainPolicy.allowed, "workspace-local Rscript run should be allowed without package installs");
  assert(rscriptToolchainPolicy.category === "toolchain", "workspace-local Rscript run should be classified as toolchain");
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
  const grepCountHint = shellDiagnosticHint("grep -c 'Fatal\\|Emergency' article.log && echo done", {
    ok: false,
    exitCode: 1,
    stdout: "0\n",
    stderr: "",
  });
  assert(grepCountHint.includes("grep -c exits 1"), "failed grep-count validation should explain clean zero-match exit behavior");
  const actualDangerAfterQuotePolicy = evaluateCommandPolicy('echo "rm -rf is text" && rm -rf reports', dockerWorkspacePolicy);
  assert(!actualDangerAfterQuotePolicy.allowed, "actual destructive command after quoted text should still be blocked");
  assert(actualDangerAfterQuotePolicy.category === "destructive", "actual destructive command after quoted text was not classified as destructive");
  for (const command of [
    "npm test &",
    "npm test & sed -i 's/old/new/' report.md",
  ]) {
    const classification = classifyCommand(command);
    const policy = evaluateCommandPolicy(command, hostWorkspacePolicy);
    assert(
      !policy.allowed &&
        classification.category !== "test" &&
        classification.substantiveTest !== true &&
        classification.writesWorkspace === true,
      `background execution bypassed bounded test policy: ${command}`
    );
  }
  const backgroundPublishPolicy = evaluateCommandPolicy(
    "npm test & npm publish",
    { ...hostWorkspacePolicy, allowDestructive: true, allowPasswords: true }
  );
  assert(
    !backgroundPublishPolicy.allowed && backgroundPublishPolicy.category === "blocked",
    "a background test bypassed the hard package-publication guard"
  );
  for (const command of [
    `node -e 'require("fs").writeFileSync("report.md", "changed")' --test`,
    "node test/unit.test.js --test",
  ]) {
    const classification = classifyCommand(command);
    assert(
      classification.category !== "test" &&
        classification.substantiveTest !== true &&
        classification.writesWorkspace === true,
      `a Node entrypoint fabricated test-runner identity: ${command}`
    );
  }
  const redirectedTestPolicy = evaluateCommandPolicy("npm test 2>&1", hostWorkspacePolicy);
  assert(
    redirectedTestPolicy.allowed && redirectedTestPolicy.substantiveTest === true,
    "descriptor redirection was mistaken for background test execution"
  );
  const singleQuoteBackslashPolicy = evaluateCommandPolicy(
    "git status 'x\\\\'; touch report.md",
    dockerWorkspacePolicy
  );
  assert(
    !singleQuoteBackslashPolicy.allowed || singleQuoteBackslashPolicy.category !== "read-only",
    "a literal backslash inside single quotes hid a following workspace mutation"
  );
  const safeChmodAndRunPolicy = evaluateCommandPolicy(
    'chmod +x /workspace/reports/run_bounded_02079_v2.sh && bash /workspace/reports/run_bounded_02079.sh 2>&1; echo "RUN_COMMAND_EXIT: $?"',
    dockerWorkspacePolicy
  );
  assert(safeChmodAndRunPolicy.allowed, "safe workspace chmod + script run sequence should be allowed in docker-workspace allow mode");
  const unsafeChmodPolicy = evaluateCommandPolicy("chmod +x /etc/passwd", dockerWorkspacePolicy);
  assert(!unsafeChmodPolicy.allowed, "chmod outside the workspace should be blocked");
  const documentBuildSequencePolicy = evaluateCommandPolicy(
    "sha256sum README.md PROJECT_NOTES.md source/budget.csv source/meeting-notes.txt source/style-notes.md > /tmp/src-before.sha256 && cat /tmp/src-before.sha256 && echo '---' && chmod +x build.sh scripts/*.py && ./build.sh",
    dockerWorkspacePolicy
  );
  assert(
    documentBuildSequencePolicy.allowed,
    "bounded document build sequence with workspace-local chmod glob should be allowed in trusted Docker mode"
  );
  assert(
    documentBuildSequencePolicy.category === "general-shell",
    "document build sequence should remain broad trusted shell, not destructive"
  );
  const documentIntegrityBuildPolicy = evaluateCommandPolicy(
    "set -e; mkdir -p output .verification; echo '== source hashes BEFORE build =='; sha256sum README.md PROJECT_NOTES.md source/budget.csv source/meeting-notes.txt source/style-notes.md | tee .verification/src-before.sha256; echo '== chmod + build =='; chmod +x build.sh scripts/*.py; ./build.sh; echo '== source hashes AFTER build (must match BEFORE) =='; sha256sum README.md PROJECT_NOTES.md source/budget.csv source/meeting-notes.txt source/style-notes.md | tee .verification/src-after.sha256; diff .verification/src-before.sha256 .verification/src-after.sha256 && echo 'SOURCE FILES UNCHANGED (byte-for-byte preserved)'",
    dockerWorkspacePolicy
  );
  assert(
    documentIntegrityBuildPolicy.allowed,
    "document integrity build with bounded workspace tee targets should be allowed in trusted Docker mode"
  );
  assert(
    documentIntegrityBuildPolicy.category === "general-shell",
    "document integrity build should remain broad trusted shell, not destructive"
  );
  const externalTeePolicy = evaluateCommandPolicy("tee /etc/aginti-test", dockerWorkspacePolicy);
  assert(!externalTeePolicy.allowed, "tee outside the workspace should remain blocked");
  const globTeePolicy = evaluateCommandPolicy("tee reports/*.txt", dockerWorkspacePolicy);
  assert(!globTeePolicy.allowed, "tee wildcard targets should remain blocked");
  const hostGlobChmodPolicy = evaluateCommandPolicy("chmod +x scripts/*.py", hostWorkspacePolicy);
  assert(!hostGlobChmodPolicy.allowed, "host workspace chmod globs should require explicit trusted host access");
  const recursiveChmodPolicy = evaluateCommandPolicy("chmod -R +x scripts", dockerWorkspacePolicy);
  assert(!recursiveChmodPolicy.allowed, "recursive chmod should remain outside the bounded permission-change policy");
  const parentTraversalChmodPolicy = evaluateCommandPolicy("chmod +x scripts/../outside.py", dockerWorkspacePolicy);
  assert(!parentTraversalChmodPolicy.allowed, "chmod parent traversal should remain blocked");
  const hostWorkspaceChmodPolicy = evaluateCommandPolicy("chmod +x android-app/gradlew && echo \"CHMOD_OK\"", hostWorkspacePolicy);
  assert(hostWorkspaceChmodPolicy.allowed, "host mode should allow workspace-local chmod without full-host destructive access");
  assert(
    hostWorkspaceChmodPolicy.category === "permission-change",
    "host workspace chmod sequence should remain categorized as permission-change"
  );
  const androidReadonlyProbePolicy = evaluateCommandPolicy(
    'test -x /usr/bin/gradle && echo "GRADLE_OK" ; test -x /usr/bin/java && /usr/bin/java -version 2>&1 | head -1; adb devices; emulator -list-avds; find android-app -maxdepth 16 -type f | sort',
    hostWorkspacePolicy
  );
  assert(androidReadonlyProbePolicy.allowed, "Android host read-only probes should not require full-host destructive access");
  assert(androidReadonlyProbePolicy.category === "read-only", "Android host probes should remain read-only");
  const hostLocalhostJsonProbePolicy = evaluateCommandPolicy(
    "curl -s http://127.0.0.1:9222/json/version | python3 -m json.tool",
    hostWorkspacePolicy
  );
  assert(hostLocalhostJsonProbePolicy.allowed, "host localhost JSON probe should not require full-host destructive access");
  assert(hostLocalhostJsonProbePolicy.category === "network-fetch", "host localhost JSON probe should stay classified as network-fetch");
  const absolutePythonHelperPolicy = evaluateCommandPolicy(
    "/home/lachlan/miniconda3/bin/python scripts/browser_cdp_helper.py list-pages",
    hostWorkspacePolicy
  );
  assert(absolutePythonHelperPolicy.allowed, "host absolute Python helper script should be allowed without full-host destructive access");
  assert(absolutePythonHelperPolicy.category === "toolchain", "host absolute Python helper should remain classified as toolchain");
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
  const gitRmCachedPolicy = evaluateCommandPolicy(
    "git rm --cached -q build/__pycache__/content.cpython-312.pyc",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(gitRmCachedPolicy.allowed, "bounded git rm --cached should preserve the working tree and remain allowed");
  assert(gitRmCachedPolicy.category === "git-workflow", "bounded git rm --cached should be a git workflow command");
  const gitRmCachedRecursivePolicy = evaluateCommandPolicy(
    "git rm --cached -r build",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(!gitRmCachedRecursivePolicy.allowed, "recursive git rm --cached should remain guarded");
  const gitRmCachedGlobPolicy = evaluateCommandPolicy(
    "git rm --cached 'build/**/*.pyc'",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(!gitRmCachedGlobPolicy.allowed, "globbed git rm --cached should remain guarded");
  const gitRmWorkingTreePolicy = evaluateCommandPolicy(
    "git rm build/content.py",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(!gitRmWorkingTreePolicy.allowed, "git rm without --cached must remain guarded");
  const localGitInitPolicy = evaluateCommandPolicy("git init", dockerWorkspaceNoInstallsPolicy);
  assert(localGitInitPolicy.allowed, "local git init should be allowed without package installs");
  assert(localGitInitPolicy.category === "git-workflow", "local git init should be classified as git-workflow");
  const localGitCommitPolicy = evaluateCommandPolicy('git commit -m "Initial local workflow commit"', dockerWorkspaceNoInstallsPolicy);
  assert(localGitCommitPolicy.allowed, "local git commit should be allowed without package installs");
  assert(localGitCommitPolicy.category === "git-workflow", "local git commit should be classified as git-workflow");
  const privateRuntimeStagePolicy = evaluateCommandPolicy("git add -- '.aginti/'", dockerWorkspaceNoInstallsPolicy);
  assert(!privateRuntimeStagePolicy.allowed, "private .aginti runtime state must never be stageable");
  assert(
    privateRuntimeStagePolicy.permissionAdvice?.autoRecover === true,
    "private runtime staging should recover automatically instead of pausing for user approval"
  );
  const chainedPrivateRuntimeStagePolicy = evaluateCommandPolicy(
    "git add -- 'service_ctl.py' && git add -- '.aginti/' && git commit -m 'Repair service'",
    dockerWorkspaceNoInstallsPolicy
  );
  assert(!chainedPrivateRuntimeStagePolicy.allowed, "a chained command must not stage private runtime state");
  const broadGitAddPolicy = evaluateCommandPolicy("git add -A", dockerWorkspaceNoInstallsPolicy);
  assert(!broadGitAddPolicy.allowed, "broad git staging must be rejected");
  assert(
    broadGitAddPolicy.permissionAdvice?.autoRecover === true,
    "broad staging should recover automatically to exact task-owned paths"
  );
  const commitAllPolicy = evaluateCommandPolicy("git commit -a -m 'Repair service'", dockerWorkspaceNoInstallsPolicy);
  assert(!commitAllPolicy.allowed, "git commit -a must not bypass bounded task-owned staging");
  const boundedGitAddPolicy = evaluateCommandPolicy("git add -- 'service_ctl.py'", dockerWorkspaceNoInstallsPolicy);
  assert(boundedGitAddPolicy.allowed, "bounded task-owned git staging should remain available");
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
  const wrongWorkspaceCdAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: {
      command:
        "cd /home/example/project-parent && python3 -m unittest discover -s tests -v",
    },
    guard: {
      category: "blocked",
      reason:
        "cd target must be a safe workspace-relative directory: /home/example/project-parent",
    },
    config: {
      ...dockerWorkspacePolicy,
      commandCwd: "/home/example/project-parent/current-project",
    },
    state: { sessionId: "coding-wrong-workspace-cd-smoke" },
  });
  assert(
    wrongWorkspaceCdAdvice.autoRecover === true,
    "an unnecessary outside-workspace cd should be corrected in-turn instead of pausing"
  );
  assert(
    /configured project root/i.test(wrongWorkspaceCdAdvice.instruction),
    "workspace cd correction did not direct the model back to the configured project root"
  );
  assert(
    !shouldPauseForPermissionAdvice({
      blocked: true,
      permissionAdvice: wrongWorkspaceCdAdvice,
    }),
    "recoverable workspace cd correction still paused the session"
  );
  const outsideScratchAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: { command: "mkdir -p /tmp/test_service && cd /tmp/test_service" },
    guard: {
      category: "blocked",
      reason: "mkdir target must be a safe workspace-relative directory: /tmp/test_service",
    },
    config: {
      ...dockerWorkspacePolicy,
      commandCwd: "/home/example/project",
    },
    state: { sessionId: "coding-outside-scratch-smoke" },
  });
  assert(
    outsideScratchAdvice.autoRecover === true,
    "an outside scratch-directory request should be corrected in-turn instead of pausing"
  );
  assert(
    /\.aginti\/verification/i.test(outsideScratchAdvice.instruction),
    "scratch-directory correction did not provide a workspace-relative verification path"
  );
  assert(
    !/package-install|approve-package/i.test(
      [outsideScratchAdvice.summary, outsideScratchAdvice.instruction].join("\n")
    ),
    "scratch-directory correction incorrectly suggested package-install escalation"
  );
  assert(
    !shouldPauseForPermissionAdvice({
      blocked: true,
      permissionAdvice: outsideScratchAdvice,
    }),
    "recoverable scratch-directory correction still paused the session"
  );
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
  const optionalPreviewCleanupArgs = {
    command:
      "rm -f build/verification/page-1.png build/verification/page-2.png; git status --short",
  };
  assert(
    isOptionalGeneratedPreviewCleanup("run_command", optionalPreviewCleanupArgs),
    "bounded generated verification-preview cleanup was not recognized"
  );
  const optionalPreviewCleanupAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: optionalPreviewCleanupArgs,
    guard: {
      category: "destructive",
      reason: "Destructive shell commands require Allow destructive actions.",
    },
    config: dockerWorkspacePolicy,
    state: { sessionId: "coding-optional-preview-cleanup-smoke" },
  });
  assert(
    optionalPreviewCleanupAdvice.autoRecover === true,
    "optional generated-preview cleanup should retain evidence and recover without pausing"
  );
  assert(
    /leave every candidate file in place/i.test(optionalPreviewCleanupAdvice.instruction),
    "optional generated-preview cleanup advice did not tell the agent to retain evidence"
  );
  assert(
    !isOptionalGeneratedPreviewCleanup("run_command", {
      command: "rm -f output/final-report.pdf",
    }),
    "a requested final artifact was misclassified as optional preview cleanup"
  );
  const mixedValidationCleanupArgs = {
    command:
      "python3 validate.py; rm -f output/page-*.png scratch-notes.md; git status --short",
  };
  assert(
    isUnrequestedCleanupCommand(
      "run_command",
      mixedValidationCleanupArgs,
      { goal: "Create and verify a clean document." },
      {}
    ),
    "unrequested cleanup embedded after validation was not recognized as recoverable"
  );
  const mixedValidationCleanupAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: mixedValidationCleanupArgs,
    guard: {
      category: "destructive",
      reason: "Destructive shell commands require Allow destructive actions.",
    },
    config: { ...dockerWorkspacePolicy, goal: "Create and verify a clean document." },
    state: { sessionId: "coding-unrequested-cleanup-smoke" },
  });
  assert(
    mixedValidationCleanupAdvice.autoRecover === true,
    "unrequested cleanup should be skipped without pausing substantive work"
  );
  const pythonCacheCleanupArgs = {
    command:
      "find . -type d -name __pycache__ -prune -exec rm -rf {} + ; find . -type f -name '*.pyc' -delete; git status --short",
  };
  assert(
    isUnrequestedCleanupCommand(
      "run_command",
      pythonCacheCleanupArgs,
      { goal: "Repair the service, run its tests, and commit the intentional work." },
      {}
    ),
    "post-acceptance Python cache deletion was not recognized as optional housekeeping"
  );
  const pythonCacheCleanupAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: pythonCacheCleanupArgs,
    guard: {
      category: "destructive",
      reason: "Destructive shell commands require Allow destructive actions.",
    },
    config: {
      ...dockerWorkspacePolicy,
      goal: "Repair the service, run its tests, and commit the intentional work.",
    },
    state: { sessionId: "coding-python-cache-cleanup-smoke" },
  });
  assert(
    pythonCacheCleanupAdvice.autoRecover === true,
    "ignored Python cache cleanup should be skipped without pausing a completed task"
  );
  assert(
    !isUnrequestedCleanupCommand(
      "run_command",
      { command: "find . -type f -delete" },
      { goal: "Repair the service and commit the result." },
      {}
    ),
    "broad find deletion was incorrectly classified as optional Python cache cleanup"
  );
  assert(
    !isUnrequestedCleanupCommand(
      "run_command",
      { command: "rm -f output/obsolete.pdf" },
      { goal: "Delete the obsolete PDF." },
      {}
    ),
    "an explicitly requested deletion was incorrectly treated as optional housekeeping"
  );
  assert(
    isUnrequestedCleanupCommand(
      "run_command",
      { command: "rm -rf /tmp/run-a /tmp/run-b" },
      {
        goal:
          "Continue the deterministic comparison. Do not delete any project or temporary directory; use fresh paths instead.",
      },
      {}
    ),
    "a negated deletion constraint was mistaken for destructive authorization"
  );
  const negatedCleanupAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: { command: "rm -rf /tmp/run-a /tmp/run-b" },
    guard: {
      category: "destructive",
      reason: "Destructive shell commands require Allow destructive actions.",
    },
    config: {
      ...dockerWorkspacePolicy,
      goal: "Do not delete any project or temporary directory; keep working on the build.",
    },
    state: { sessionId: "coding-negated-cleanup-smoke" },
  });
  assert(
    negatedCleanupAdvice.autoRecover === true,
    "blocked cleanup under a do-not-delete goal should recover without pausing"
  );
  const retainedReportCleanupArgs = {
    command:
      "rm -f /home/lachlan/ProjectsLFS/AgenticApp/output/wechat_worker/task/2026-09-03-evidence-brief.pdf /home/lachlan/ProjectsLFS/AgenticApp/output/wechat_worker/task/2026-09-03-evidence-brief.aux /home/lachlan/ProjectsLFS/AgenticApp/output/wechat_worker/task/2026-09-03-evidence-brief.log /home/lachlan/ProjectsLFS/AgenticApp/output/wechat_worker/task/2026-09-03-evidence-brief.out",
  };
  const retainedReportCleanupGoal =
    "Revise the existing report and enable host compilation. Unless the current request explicitly requires deletion, never bundle `rm`, delete, clean, reset, or scratch-file cleanup into a build or validation command. Keep prior task artifacts as evidence.";
  assert(
    isUnrequestedCleanupCommand(
      "run_command",
      retainedReportCleanupArgs,
      { goal: retainedReportCleanupGoal },
      {}
    ),
    "a safety rule against bundled cleanup was mistaken for deletion authorization"
  );
  const retainedReportCleanupAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: retainedReportCleanupArgs,
    guard: {
      category: "destructive",
      reason: "Destructive shell commands require Allow destructive actions.",
    },
    config: { ...dockerWorkspacePolicy, goal: retainedReportCleanupGoal },
    state: { sessionId: "coding-retained-report-cleanup-smoke" },
  });
  assert(
    retainedReportCleanupAdvice.autoRecover === true &&
      !shouldPauseForPermissionAdvice({
        blocked: true,
        permissionAdvice: retainedReportCleanupAdvice,
      }),
    "unrequested pre-build report cleanup still paused the substantive revision"
  );
  assert(
    !isUnrequestedCleanupCommand(
      "run_command",
      retainedReportCleanupArgs,
      {
        goal:
          `${retainedReportCleanupGoal} Delete the obsolete PDF and its generated sidecars after inspection.`,
      },
      {}
    ),
    "a separate explicit deletion request was erased with the safety rule"
  );
  const dynamicEvidenceAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: {
      command:
        'STAMP=$(date -u +%Y%m%dT%H%M%SZ); bash build.sh 2>&1 | tee ".aginti/build-${STAMP}.log"',
    },
    guard: {
      category: "destructive",
      reason:
        'Command contains a write-capable or destructive token: tee ".aginti/build-${STAMP}.log"',
    },
    config: {
      ...dockerWorkspacePolicy,
      goal: "Build twice and retain deterministic evidence without deleting anything.",
    },
    state: { sessionId: "coding-dynamic-evidence-smoke" },
  });
  assert(
    dynamicEvidenceAdvice.autoRecover === true &&
      /literal workspace-relative evidence paths/i.test(dynamicEvidenceAdvice.instruction),
    "dynamic evidence filename false positive should recover into literal workspace paths"
  );
  assert(
    !shouldPauseForPermissionAdvice({ blocked: true, permissionAdvice: dynamicEvidenceAdvice }),
    "dynamic evidence filename recovery still produced a permission pause"
  );
  const mixedToolchainAuditCommand = [
    "cd output/task-1 && python3 build_report.py",
    "python3 - <<'PY'",
    "from pathlib import Path",
    "print(Path('report.pdf').stat().st_size)",
    "PY",
  ].join(" && ");
  const mixedToolchainAuditAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: { command: mixedToolchainAuditCommand },
    guard: {
      category: "general-shell",
      reason: "General shell commands on the host require Allow destructive actions.",
    },
    config: hostWorkspacePolicy,
    state: { sessionId: "coding-mixed-toolchain-audit-smoke" },
  });
  assert(
    mixedToolchainAuditAdvice.autoRecover === true &&
      mixedToolchainAuditAdvice.recoveryCommand ===
        "cd output/task-1 && python3 build_report.py",
    "mixed toolchain and inline audit did not recover to the safe build prefix"
  );
  assert(
    !shouldPauseForPermissionAdvice({
      blocked: true,
      permissionAdvice: mixedToolchainAuditAdvice,
    }),
    "mixed toolchain and inline audit recovery still paused the session"
  );
  const unsafeMixedAuditAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: {
      command:
        "rm -rf output/task-1 && python3 build_report.py && python3 - <<'PY'\nprint('x')\nPY",
    },
    guard: {
      category: "general-shell",
      reason: "General shell commands on the host require Allow destructive actions.",
    },
    config: hostWorkspacePolicy,
    state: { sessionId: "coding-unsafe-mixed-audit-smoke" },
  });
  assert(
    unsafeMixedAuditAdvice.autoRecover !== true,
    "destructive mixed audit received an unsafe automatic recovery"
  );
  const inlinePdfAuditAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: {
      command:
        'cd output/task-1 && python3 -c "import re;d=open(\'report.pdf\',\'rb\').read();print(len(re.findall(rb\'/Type\\\\s*/Page[^s]\',d)))"',
    },
    guard: {
      category: "general-shell",
      reason: "General shell commands on the host require Allow destructive actions.",
    },
    config: hostWorkspacePolicy,
    state: { sessionId: "coding-inline-pdf-audit-smoke" },
  });
  assert(
    inlinePdfAuditAdvice.autoRecover === true &&
      /deterministic artifact gate/i.test(inlinePdfAuditAdvice.instruction),
    "read-only inline PDF audit did not recover without stronger permission"
  );
  assert(
    !shouldPauseForPermissionAdvice({
      blocked: true,
      permissionAdvice: inlinePdfAuditAdvice,
    }),
    "read-only inline PDF audit recovery still paused the session"
  );
  const inlinePdfWriteAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: {
      command:
        'cd output/task-1 && python3 -c "open(\'report.pdf\',\'wb\').write(b\'replacement\')"',
    },
    guard: {
      category: "general-shell",
      reason: "General shell commands on the host require Allow destructive actions.",
    },
    config: hostWorkspacePolicy,
    state: { sessionId: "coding-inline-pdf-write-smoke" },
  });
  assert(
    inlinePdfWriteAdvice.autoRecover !== true,
    "write-capable inline Python received read-only automatic recovery"
  );
  const malformedPatchGuard = {
    allowed: false,
    category: "workspace-patch",
    reason: "Patch did not contain any supported file operations.",
    permissionAdvice: {
      category: "workspace-patch",
      autoRecover: true,
      summary: "The patch format or exact context was not accepted; this is not a permission blocker.",
      instruction: "Inspect the exact file and retry with a supported focused edit.",
    },
  };
  const malformedPatchAdvice = buildPermissionAdvice({
    toolName: "apply_patch",
    args: { patch: "*** a/labshare.py\n*** b/labshare.py" },
    guard: malformedPatchGuard,
    config: dockerWorkspacePolicy,
    state: { sessionId: "coding-malformed-patch-smoke" },
  });
  assert(
    malformedPatchAdvice === malformedPatchGuard.permissionAdvice,
    "explicit recoverable workspace-patch advice was replaced by generic permission advice"
  );
  assert(
    !shouldPauseForPermissionAdvice({ blocked: true, permissionAdvice: malformedPatchAdvice }),
    "recoverable malformed patch advice still paused the session for permission"
  );
  const destructiveDynamicEvidenceAdvice = buildPermissionAdvice({
    toolName: "run_command",
    args: {
      command:
        'rm -rf output; STAMP=$(date -u +%Y%m%dT%H%M%SZ); bash build.sh 2>&1 | tee ".aginti/build-${STAMP}.log"',
    },
    guard: {
      category: "destructive",
      reason: "Destructive shell commands require Allow destructive actions.",
    },
    config: { ...dockerWorkspacePolicy, goal: "Build and verify the document." },
    state: { sessionId: "coding-destructive-dynamic-evidence-smoke" },
  });
  assert(
    destructiveDynamicEvidenceAdvice.autoRecover === true &&
      /Unrequested cleanup was blocked safely/i.test(destructiveDynamicEvidenceAdvice.summary),
    "a real cleanup token should not be mislabeled as only dynamic evidence formatting"
  );
  const documentPageBatchGuard = checkToolUse({
    toolName: "read_image",
    args: { imagePaths: ["build/verification/page-1.png", "build/verification/page-2.png"] },
    snapshot: {},
    config: { ...dockerWorkspacePolicy, allowFileTools: true, taskProfile: "word" },
  });
  assert(
    documentPageBatchGuard.allowed === false &&
      documentPageBatchGuard.category === "document-page-visual-batch",
    "Word document review did not require one visual call per rendered page"
  );
  const documentPageBatchAdvice = buildPermissionAdvice({
    toolName: "read_image",
    args: { imagePaths: ["build/verification/page-1.png", "build/verification/page-2.png"] },
    guard: documentPageBatchGuard,
    config: { ...dockerWorkspacePolicy, taskProfile: "word" },
    state: { sessionId: "coding-document-page-visual-batch-smoke" },
  });
  assert(
    documentPageBatchAdvice.autoRecover === true &&
      /once for each rendered page/i.test(documentPageBatchAdvice.instruction),
    "Word document page batching did not recover into separate visual checks"
  );
  const alreadyCommittedAdvice = buildFailedCommandAdvice({
    args: { command: "git commit -m 'Focused repair'" },
    commandPolicy: evaluateCommandPolicy("git commit -m 'Focused repair'", dockerWorkspacePolicy),
    commandResult: {
      ok: false,
      exitCode: 1,
      stdout: "On branch main\nnothing to commit, working tree clean\n",
    },
    config: dockerWorkspacePolicy,
    state: {
      meta: {
        goalContract: { revision: 9 },
        projectVerification: { mutationRevision: 4 },
        durableGitEvidence: [{ action: "commit", goalRevision: 9, mutationRevision: 4 }],
      },
    },
  });
  assert(
    alreadyCommittedAdvice?.failureKind === "repository-already-committed" &&
      alreadyCommittedAdvice.autoRecover === true &&
      /should not be retried/i.test(alreadyCommittedAdvice.summary),
    "a clean no-op commit with current durable evidence did not converge"
  );
  const sameTaskContinuationAdvice = buildFailedCommandAdvice({
    args: { command: "git commit -m 'Focused repair'" },
    commandPolicy: evaluateCommandPolicy("git commit -m 'Focused repair'", dockerWorkspacePolicy),
    commandResult: {
      ok: false,
      exitCode: 1,
      stdout: "On branch main\nnothing to commit, working tree clean\n",
    },
    config: dockerWorkspacePolicy,
    state: {
      meta: {
        goalContract: {
          revision: 10,
          history: [
            { revision: 9, taskHash: "task-a" },
            { revision: 10, taskHash: "task-a" },
          ],
        },
        projectVerification: { mutationRevision: 4 },
        durableGitEvidence: [{ action: "commit", goalRevision: 9, mutationRevision: 4 }],
      },
    },
  });
  assert(
    sameTaskContinuationAdvice?.failureKind === "repository-already-committed",
    "a same-task continuation invalidated a clean commit at the current mutation revision"
  );
  const newTaskAdvice = buildFailedCommandAdvice({
    args: { command: "git commit -m 'Focused repair'" },
    commandPolicy: evaluateCommandPolicy("git commit -m 'Focused repair'", dockerWorkspacePolicy),
    commandResult: {
      ok: false,
      exitCode: 1,
      stdout: "On branch main\nnothing to commit, working tree clean\n",
    },
    config: dockerWorkspacePolicy,
    state: {
      meta: {
        goalContract: {
          revision: 10,
          history: [
            { revision: 9, taskHash: "task-a" },
            { revision: 10, taskHash: "task-b" },
          ],
        },
        projectVerification: { mutationRevision: 4 },
        durableGitEvidence: [{ action: "commit", goalRevision: 9, mutationRevision: 4 }],
      },
    },
  });
  assert(
    newTaskAdvice === null,
    "a commit from a prior task satisfied a genuinely new task"
  );
  const staleCommitAdvice = buildFailedCommandAdvice({
    args: { command: "git commit -m 'Focused repair'" },
    commandPolicy: evaluateCommandPolicy("git commit -m 'Focused repair'", dockerWorkspacePolicy),
    commandResult: {
      ok: false,
      exitCode: 1,
      stdout: "On branch main\nnothing to commit, working tree clean\n",
    },
    config: dockerWorkspacePolicy,
    state: {
      meta: {
        goalContract: { revision: 9 },
        projectVerification: { mutationRevision: 4 },
        durableGitEvidence: [{ action: "commit", goalRevision: 8, mutationRevision: 4 }],
      },
    },
  });
  assert(
    staleCommitAdvice === null,
    "a stale commit from an earlier goal revision satisfied a fresh commit request"
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
  const failedDockerLocalhostAdvice = buildFailedCommandAdvice({
    args: { command: "curl -fsS http://127.0.0.1:9222/json/version" },
    commandPolicy: evaluateCommandPolicy("curl -fsS http://127.0.0.1:9222/json/version", dockerWorkspacePolicy),
    commandResult: { ok: false, stderr: "curl: (7) Failed to connect to 127.0.0.1 port 9222: Connection refused" },
    config: dockerWorkspacePolicy,
    state: { sessionId: "coding-localhost-cdp-smoke" },
  });
  assert(failedDockerLocalhostAdvice?.failureKind === "host-local-service", "Docker localhost failure advice was not generated");
  assert(
    failedDockerLocalhostAdvice.suggestedCommand.includes("--sandbox-mode host"),
    "Docker localhost advice did not suggest host mode"
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
  const missingReadonlyHostPathAdvice = buildFailedCommandAdvice({
    args: { command: "ls /home/lachlan/ProjectsLFS/ProteinStructure" },
    commandPolicy: evaluateCommandPolicy("ls /home/lachlan/ProjectsLFS/ProteinStructure", dockerWorkspacePolicy),
    commandResult: {
      ok: false,
      stdout: "",
      stderr: "ls: cannot access '/home/lachlan/ProjectsLFS/ProteinStructure': No such file or directory",
    },
    config: dockerWorkspacePolicy,
    state: { sessionId: "coding-readonly-missing-host-path-smoke" },
  });
  assert(missingReadonlyHostPathAdvice === null, "missing read-only host path should not trigger danger-mode permission advice");
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
  let privateQueryDispatches = 0;
  const privateTranscriptQueries = [
    "Chat History for sunnyyty的聊天记录",
    "\"Conversation transcript with Alice\"",
    "孙小雨的对话记录",
    "アリスとのチャット履歴",
  ];
  for (const query of privateTranscriptQueries) {
    const guard = checkToolUse({
      toolName: "web_search",
      args: { query },
      snapshot: {},
      config: { allowWebSearch: true },
    });
    assert(!guard.allowed && guard.category === "web-search-private-context", `private transcript query passed tool guard: ${query}`);
    const result = await searchWeb(
      { query },
      {
        allowWebSearch: true,
        webSearchImpl: async () => {
          privateQueryDispatches += 1;
          return { ok: true, toolName: "web_search", results: [] };
        },
      }
    );
    assert(!result.ok && result.blocked && result.category === "web-search-private-context", `private transcript query reached search dispatch: ${query}`);
  }
  assert(privateQueryDispatches === 0, "private transcript title reached a public web-search provider");
  for (const query of [
    "how to export WeChat chat history safely",
    "research on conversation history in task-oriented dialogue systems",
    "organoid microfluidics primary research 2026",
  ]) {
    const guard = checkToolUse({
      toolName: "web_search",
      args: { query },
      snapshot: {},
      config: { allowWebSearch: true },
    });
    assert(guard.allowed, `legitimate public research query was blocked: ${query}`);
  }
  const secretQuery = await searchWeb(
    { query: "debug API_KEY=secret-production-value" },
    {
      allowWebSearch: true,
      webSearchImpl: async () => {
        privateQueryDispatches += 1;
        return { ok: true, toolName: "web_search", results: [] };
      },
    }
  );
  assert(!secretQuery.ok && secretQuery.category === "web-search-sensitive-query", "secret-bearing web query was not rejected");
  assert(privateQueryDispatches === 0, "secret-bearing query reached a public web-search provider");
  for (const command of [
    "pdflatex report.md",
    "cd artifacts && xelatex -interaction=nonstopmode daily-briefing.markdown",
    "env TEXINPUTS=. latexmk -pdf notes.txt",
    "lualatex existing-report.pdf",
  ]) {
    const block = incompatibleDocumentCompilerSourceBlock("run_command", { command });
    assert(block?.category === "document-compiler-source-type" && block.recoverable, `incompatible document compiler source was not rejected: ${command}`);
    assert(block.blocked && shouldShortCircuitToolBatch(block), `incompatible document compiler source did not stop its tool batch: ${command}`);
  }
  for (const command of [
    "pdflatex -interaction=nonstopmode report.tex",
    "pdflatex -jobname release.pdf report.tex",
    "latexmk -output-directory=build.pdf -pdf report.tex",
    "cd artifacts && latexmk -pdf daily-briefing.tex",
    "pandoc report.md -o report.tex",
    "python scripts/build_report.py report.md",
  ]) {
    assert(!incompatibleDocumentCompilerSourceBlock("run_command", { command }), `valid document command was rejected: ${command}`);
  }
  const writingRun = await runMock("Write a novel chapter about a harbor drone repairer and save the draft.", "coding-writing-specialist");
  assert(
    writingRun.events.some((event) => event.type === "tool.completed" && event.data?.toolName === "writing_specialist"),
    "mock agent did not route writing work through writing_specialist"
  );
  const jsonResult = await runJsonSpecialist(
    {
      task: "Return a strict JSON status object.",
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          complete: { type: "boolean" },
        },
        required: ["summary", "complete"],
        additionalProperties: false,
      },
      inputText: "structured JSON smoke",
      provider: "mock",
    },
    { provider: "mock", model: "mock-agent" },
    new SessionStore(runtimeDir, "json-specialist-smoke", { projectRoot: workspace, commandCwd: workspace })
  );
  assert(jsonResult.ok && jsonResult.result?.complete === true, "json_specialist mock result did not satisfy schema");
  const jsonRun = await runMock("Extract a valid JSON object with schema from this text.", "coding-json-specialist");
  assert(
    jsonRun.events.some((event) => event.type === "tool.completed" && event.data?.toolName === "json_specialist"),
    "mock agent did not route structured JSON work through json_specialist"
  );

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
  await fs.mkdir(path.join(workspace, "scripts"), { recursive: true });
  await fs.mkdir(path.join(workspace, ".conda/cache"), { recursive: true });
  await fs.mkdir(path.join(workspace, ".runtime-generated/cache"), { recursive: true });
  await fs.writeFile(path.join(workspace, "scripts/routine_entry.py"), "print('ready')\n", "utf8");
  await fs.writeFile(path.join(workspace, ".conda/cache/routine_entry.py"), "private cache noise\n", "utf8");
  await fs.writeFile(path.join(workspace, ".runtime-generated/cache/noise.txt"), "generated runtime noise\n", "utf8");
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
  const sanitizedCommandResult = sanitizeToolResult({
    ok: true,
    toolName: "run_command",
    args: { command: "echo password=private-value" },
    commandPolicy: { normalizedCommand: "echo password=private-value" },
    stdout: "password=private-value",
  });
  const serializedCommandResult = JSON.stringify(sanitizedCommandResult);
  assert(
    !serializedCommandResult.includes("private-value") && serializedCommandResult.includes("[REDACTED]"),
    "a nested normalized command bypassed tool-event redaction"
  );
  const largeModelRead = toolResultForModel({
    ok: true,
    toolName: "read_file",
    path: "large-skill.md",
    startLine: 1,
    content: Array.from({ length: 1600 }, (_, index) => `skill line ${index + 1}`).join("\n"),
  });
  assert(largeModelRead.contentTruncated, "large model-facing read was not bounded");
  assert(largeModelRead.content.length <= 12100, "large model-facing read exceeded the context cap");
  assert(largeModelRead.nextStartLine > 1, "large model-facing read omitted its continuation line");
  assert(
    largeModelRead.continuationHint.includes(`startLine=${largeModelRead.nextStartLine}`),
    "large model-facing read described a continuation argument that the read_file schema does not accept"
  );
  const largeModelList = toolResultForModel({
    ok: true,
    toolName: "list_files",
    entries: Array.from({ length: 150 }, (_, index) => ({ path: `file-${index}.txt` })),
  });
  assert(largeModelList.entries.length === 80, "model-facing list was not capped");
  assert(largeModelList.entryCount === 150 && largeModelList.entriesTruncated, "model-facing list omitted truncation evidence");
  const largeModelEvidence = toolResultForModel({
    ok: true,
    toolName: "read_file",
    path: "large-skill.md",
    commandEvidence: Array.from({ length: 40 }, (_, index) => ({ signature: `tool command ${index}` })),
    pathEvidence: Array.from({ length: 80 }, (_, index) => ({ path: `references/path-${index}.md` })),
  });
  assert(largeModelEvidence.commandEvidence.length === 16, "model-facing command provenance was not bounded");
  assert(
    largeModelEvidence.commandEvidenceCount === 40 && largeModelEvidence.commandEvidenceTruncated,
    "model-facing command provenance omitted retained-count metadata"
  );
  assert(largeModelEvidence.pathEvidence.length === 32, "model-facing path provenance was not bounded");
  assert(
    largeModelEvidence.pathEvidenceCount === 80 && largeModelEvidence.pathEvidenceTruncated,
    "model-facing path provenance omitted retained-count metadata"
  );
  const limitedReadResult = await executeWorkspaceTool(
    "read_file",
    { path: "small-read-smoke.md", startLine: 2, lineLimit: 3 },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(limitedReadResult.content === "line 001\nline 002\nline 003", "read_file lineLimit did not return the requested line slice");
  assert(limitedReadResult.contentTruncatedByLines === true, "read_file lineLimit should report remaining lines");
  const largeReadLines = Array.from({ length: 30000 }, (_, index) => `large line ${String(index + 1).padStart(5, "0")}`).join("\n");
  await fs.writeFile(path.join(workspace, "large-read-smoke.md"), largeReadLines, "utf8");
  const largeLimitedReadResult = await executeWorkspaceTool(
    "read_file",
    { path: "large-read-smoke.md", startLine: 100, lineLimit: 2 },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(
    largeLimitedReadResult.content === "large line 00100\nlarge line 00101",
    "read_file lineLimit should work on larger text files"
  );
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
  const boundedList = await executeWorkspaceTool(
    "list_files",
    { path: ".", maxDepth: 4, limit: 200 },
    { commandCwd: workspace, allowFileTools: true }
  );
  assert(!boundedList.entries.some((item) => item.path.startsWith(".conda")), "list_files traversed a cache-heavy .conda tree");
  assert(
    !boundedList.entries.some((item) => item.path.startsWith(".runtime-generated")),
    "list_files traversed an unrecognized hidden runtime directory"
  );
  await fs.mkdir(path.join(workspace, "output", "task-scope"), { recursive: true });
  await fs.writeFile(path.join(workspace, "output", "task-scope", "report.md"), "scoped\n", "utf8");
  await fs.writeFile(path.join(workspace, "unrelated.md"), "unrelated\n", "utf8");
  const scopedRead = await executeWorkspaceTool(
    "read_file",
    { path: "output/task-scope/report.md" },
    {
      commandCwd: workspace,
      allowFileTools: true,
      workspacePathScopeRoots: ["output/task-scope"],
    }
  );
  assert(scopedRead.content === "scoped\n", "task-scoped artifact read failed inside its root");
  const outsideScopedRead = await executeWorkspaceTool(
    "read_file",
    { path: "unrelated.md" },
    {
      commandCwd: workspace,
      allowFileTools: true,
      workspacePathScopeRoots: ["output/task-scope"],
    }
  );
  assert(
    outsideScopedRead.blocked === true &&
      /outside the active task artifact scope/.test(String(outsideScopedRead.reason || "")),
    "task-scoped artifact tools could read an unrelated repository file"
  );
  const writeScopedRead = await executeWorkspaceTool(
    "read_file",
    { path: "unrelated.md" },
    {
      commandCwd: workspace,
      allowFileTools: true,
      workspaceWritePathScopeRoots: ["output/task-scope"],
    }
  );
  assert(
    writeScopedRead.content === "unrelated\n",
    "write-scoped artifact work could not read safe workspace evidence"
  );
  const outsideWriteScopedWrite = await executeWorkspaceTool(
    "write_file",
    { path: "outside-scoped-write.md", content: "blocked\n" },
    {
      commandCwd: workspace,
      allowFileTools: true,
      workspaceWritePathScopeRoots: ["output/task-scope"],
    }
  );
  assert(
    outsideWriteScopedWrite.blocked === true &&
      /outside the active task artifact scope/.test(
        String(outsideWriteScopedWrite.reason || "")
      ),
    "write-scoped artifact work could mutate an unrelated repository file"
  );
  const filenameSearch = await executeWorkspaceTool(
    "search_files",
    { path: ".", query: "routine_entry.py", maxResults: 5 },
    { commandCwd: workspace, allowFileTools: true }
  );
  assert(
    filenameSearch.results.some((item) => item.path === "scripts/routine_entry.py" && item.line === 0),
    "search_files did not return a direct filename match"
  );
  assert(
    !filenameSearch.results.some((item) => item.path.startsWith(".conda")),
    "search_files traversed a cache-heavy .conda tree"
  );
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
  const rStanProfile = getTaskProfile("r-stan");
  assert(/Rscript\/CmdStan checks when available/i.test(rStanProfile.prompt), "R/Stan profile does not require runtime checks");
  assert(
    /user disallows installs/i.test(rStanProfile.prompt) && /do not present package-install approval as the primary continuation path/i.test(rStanProfile.prompt),
    "R/Stan profile does not handle missing toolchains under no-install user instructions"
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
  const deepSeekTimeoutRoute = modelTimeoutRetryRoute({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    modelTimeoutMs: 180000,
  });
  assert(
    deepSeekTimeoutRoute.model === "deepseek-v4-flash" && deepSeekTimeoutRoute.switchedModel,
    "DeepSeek timeout retry did not stay in-provider and switch to the fast route"
  );
  assert(
    deepSeekTimeoutRoute.retryTimeoutMs === 135000,
    "DeepSeek fast timeout retry retained the old doubled stall window"
  );
  const localTimeoutRoute = modelTimeoutRetryRoute({
    provider: "localllm",
    model: "localllm-deep",
    modelTimeoutMs: 120000,
  });
  assert(
    localTimeoutRoute.model === "localllm-fast" && localTimeoutRoute.retryTimeoutMs === 90000,
    "LocalLLM timeout retry did not switch to its same-boundary fast route"
  );
  const adoptedLocalTimeoutRoute = applyModelTimeoutRetryRoute(
    { provider: "localllm", model: "localllm-deep", routingMode: "manual" },
    localTimeoutRoute
  );
  assert(
    adoptedLocalTimeoutRoute.model === "localllm-fast" &&
      adoptedLocalTimeoutRoute.modelTimeoutRecoveryActive === true &&
      /continuing this run/.test(adoptedLocalTimeoutRoute.routeReason),
    "a successful in-provider timeout retry was not retained for later steps in the same run"
  );
  const focusedRewriteDescriptor = {
    type: "function",
    function: {
      name: "rewrite_text_excerpt",
      description: "Rewrite one evidence-selected excerpt.",
      parameters: {
        type: "object",
        properties: {
          revisedText: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            pattern: "^(?:(?!load)[\\s\\S])+$",
            description:
              "Return only the complete revised excerpt. Remove the premature first-match operand while preserving the technical meaning.",
          },
        },
        required: ["revisedText"],
        additionalProperties: false,
      },
    },
  };
  const focusedRewriteContract = createToolContract([focusedRewriteDescriptor]);
  const invalidFocusedRewriteCall = {
    id: "focused-rewrite-smoke",
    type: "function",
    function: {
      name: "rewrite_text_excerpt",
      arguments: JSON.stringify({ revisedText: "A carefully preloaded technical summary." }),
    },
  };
  const invalidFocusedRewrite = resolveDispatchableToolCallBatch(
    [invalidFocusedRewriteCall],
    focusedRewriteContract
  );
  assert(
    !invalidFocusedRewrite.ok &&
      invalidFocusedRewrite.errors.some((error) => error.code === "ARGUMENT_PATTERN_MISMATCH"),
    "focused rewrite smoke input did not exercise the semantic pattern failure"
  );
  const commandDescriptor = {
    type: "function",
    function: {
      name: "run_command",
      description: "Run one command.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", minLength: 1 } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  };
  const annotatedCommandBatch = [
    {
      id: "annotated-command-one",
      type: "function",
      function: {
        name: "run_command",
        arguments: JSON.stringify({
          command: "printf one",
          description: "Inspect the first item",
        }),
      },
    },
    {
      id: "annotated-command-two",
      type: "function",
      function: {
        name: "run_command",
        arguments: JSON.stringify({
          command: "printf two",
          description: "Inspect the second item",
        }),
      },
    },
  ];
  const recoveredAnnotatedCommands = resolveDispatchableToolCallBatch(
    annotatedCommandBatch,
    createToolContract([commandDescriptor])
  );
  assert(recoveredAnnotatedCommands.ok, "benign command annotations were not normalized");
  assert(
    recoveredAnnotatedCommands.recoveredToolCallAnnotations,
    "benign command annotation recovery was not recorded"
  );
  assert(
    recoveredAnnotatedCommands.recoveredSequentially,
    "annotated command batch did not retain bounded sequential dispatch"
  );
  assert(
    recoveredAnnotatedCommands.acceptedToolCalls.length === 1 &&
      recoveredAnnotatedCommands.deferredToolCalls.length === 1,
    "annotated command batch did not dispatch one call and defer the suffix"
  );
  for (const call of [
    ...recoveredAnnotatedCommands.acceptedToolCalls,
    ...recoveredAnnotatedCommands.deferredToolCalls,
  ]) {
    assert(
      !Object.hasOwn(JSON.parse(call.function.arguments), "description"),
      "non-executable command description reached dispatch"
    );
  }
  const unknownAnnotatedCommand = resolveDispatchableToolCallBatch(
    [
      {
        id: "unknown-command-annotation",
        type: "function",
        function: {
          name: "run_command",
          arguments: JSON.stringify({
            command: "printf blocked",
            rationale: "This key is not an approved annotation",
          }),
        },
      },
    ],
    createToolContract([commandDescriptor])
  );
  assert(
    !unknownAnnotatedCommand.ok &&
      unknownAnnotatedCommand.errors.some(
        (error) => error.code === "ARGUMENT_ADDITIONAL_PROPERTY"
      ),
    "an unknown command annotation bypassed the exact tool schema"
  );
  const focusedWriterCalls = [];
  const focusedRewriteState = {
    meta: {
      failedTestDiagnostic: {
        mutationRevision: 7,
        failureSignature: "generic-first-occurrence-relation",
      },
    },
  };
  const focusedRewriteConfig = {
    provider: "localllm",
    model: "localllm-fast",
    baseURL: "http://127.0.0.1:8008/v1",
    testFailureSignature: "generic-first-occurrence-relation",
    testFailureRepairPatchTargets: [{
      path: "notes/handoff.md",
      search: "A carefully preloaded technical summary.",
    }],
    writingClientFactory: (writingConfig) => {
      focusedWriterCalls.push(writingConfig);
      return {
        chat: {
          completions: {
            create: async () => ({
              choices: [{
                message: {
                  content: JSON.stringify({
                    draft: "A carefully prepared technical summary.",
                    revision_notes: [],
                    continuity_notes: [],
                    format_handoff: {},
                    quality_checks: ["constraint satisfied"],
                    questions: [],
                  }),
                },
              }],
            }),
          },
        },
      };
    },
  };
  const recoveredFocusedRewrite = await recoverFocusedTextRewriteWithWritingSpecialist(
    focusedRewriteConfig,
    focusedRewriteState,
    [invalidFocusedRewriteCall],
    focusedRewriteContract,
    invalidFocusedRewrite
  );
  assert(recoveredFocusedRewrite?.ok, "writing specialist did not recover the bounded semantic rewrite");
  assert(
    recoveredFocusedRewrite.recoveredFocusedTextRewrite === true &&
      JSON.parse(recoveredFocusedRewrite.acceptedToolCalls[0].function.arguments).revisedText ===
        "A carefully prepared technical summary.",
    "writing specialist recovery did not return a schema-valid focused rewrite call"
  );
  assert(
    focusedWriterCalls.length === 1 &&
      focusedWriterCalls[0].provider === "localllm" &&
      focusedWriterCalls[0].model === "localllm-fast",
    "focused rewrite recovery crossed the active provider/model boundary"
  );
  assert(
    (await recoverFocusedTextRewriteWithWritingSpecialist(
      focusedRewriteConfig,
      focusedRewriteState,
      [invalidFocusedRewriteCall],
      focusedRewriteContract,
      invalidFocusedRewrite
    )) === null && focusedWriterCalls.length === 1,
    "focused rewrite recovery repeated for the same retained failure state"
  );
  const defaultLocalTimeoutRoute = modelTimeoutRetryRoute({
    provider: "localllm",
    model: "localllm-fast",
  });
  assert(
    defaultLocalTimeoutRoute.timeoutMs === 300000 && defaultLocalTimeoutRoute.retryTimeoutMs === 180000,
    "LocalLLM same-model timeout retry retained a doubled stall window after prompt compaction"
  );
  const exhaustedFastRoute = modelTimeoutExhaustionRoute(
    {
      provider: "localllm",
      model: "localllm-fast",
      mainProvider: "localllm",
      mainModel: "localllm-deep",
      spareProvider: "localllm",
      spareModel: "localllm-deep",
      localAvailableModels: ["localllm-fast", "localllm-deep"],
    },
    defaultLocalTimeoutRoute
  );
  assert(
    exhaustedFastRoute.switchedModel === true &&
      exhaustedFastRoute.model === "localllm-deep" &&
      exhaustedFastRoute.retryTimeoutMs === 240000,
    "two bounded fast-route timeouts did not select one stronger in-provider recovery hop"
  );
  const alreadySwitchedTimeoutRoute = modelTimeoutExhaustionRoute(
    {
      provider: "localllm",
      model: "localllm-deep",
      mainProvider: "localllm",
      mainModel: "localllm-deep",
    },
    modelTimeoutRetryRoute({
      provider: "localllm",
      model: "localllm-deep",
      modelTimeoutMs: 120000,
    })
  );
  assert(
    alreadySwitchedTimeoutRoute.switchedModel === false,
    "timeout exhaustion attempted an unbounded model bounce after an existing route switch"
  );
  const artifactTimeoutMessages = buildModelTimeoutRetryMessages(
    {
      meta: {
        artifactProgress: {
          complete: true,
          needsRepair: true,
          defectCount: 2,
        },
      },
      messages: [
        { role: "system", content: "artifact repair system" },
        { role: "user", content: "Exact output report.md:\n# Report\nUnsupported command: invented-cli run" },
        { role: "user", content: "Deterministic preflight: remove invented-cli run; remaining defects: 2." },
      ],
    },
    { taskProfile: "research", commandCwd: workspace },
    { title: "No browser page open", url: "" },
    9,
    planTimeoutError
  );
  assert(
    artifactTimeoutMessages.some((message) => /Exact output report\.md/.test(message.content || "")),
    "artifact timeout retry discarded the embedded exact output"
  );
  assert(
    artifactTimeoutMessages.some((message) => /remove invented-cli run/.test(message.content || "")),
    "artifact timeout retry discarded deterministic preflight defects"
  );
  assert(
    artifactTimeoutMessages.every((message) => message.role !== "tool" && !Array.isArray(message.tool_calls)),
    "artifact timeout retry retained invalid native tool history"
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
  assert(
    inspectRun.events.some((event) => event.type === "surgical_context.prepared" && event.data?.fingerprint),
    "mock large-codebase run did not prepare surgical context"
  );
  assert(inspectRun.state?.meta?.surgicalContext?.fingerprint, "surgical context metadata was not saved on state");
  assert(
    inspectRun.state?.messages?.some((message) => /Surgical context pack for this engineering task/.test(message.content || "")),
    "surgical context message was not injected into model history"
  );

  const helloRun = await runMock("hello", "coding-direct-hello");
  assert(helloRun.result.result.includes("Hello"), "bare hello did not finish with a direct greeting");
  assert(!helloRun.state?.plan, "bare hello should not create an execution plan");
  assert(
    helloRun.events.some((event) => event.type === "session.finished" && event.data?.mode === "direct-answer"),
    "bare hello did not finish through the direct-answer path"
  );
  assert(
    !helloRun.events.some((event) => event.type === "tool.started" || event.type === "tool.completed"),
    "bare hello should not call tools"
  );
  const helloPyExists = await fs
    .stat(path.join(workspace, "hello.py"))
    .then(() => true)
    .catch(() => false);
  assert(!helloPyExists, "bare hello should not create hello.py");

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
  const multiPatchRun = await executeWorkspaceTool(
    "apply_patch",
    {
      patch: [
        "*** Begin Patch",
        "*** Update File: patch-target.txt",
        "@@",
        "-old",
        "+new",
        "*** Add File: notes/patch-note.md",
        "+Created by AgInTiFlow mock mode.",
        "+Goal: multi-file patch smoke.",
        "*** End Patch",
      ].join("\n"),
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  const multiPatched = await fs.readFile(path.join(workspace, "patch-target.txt"), "utf8");
  const patchNote = await fs.readFile(path.join(workspace, "notes/patch-note.md"), "utf8");
  assert(multiPatched === "new\n", "mock multi-file patch did not update expected file");
  assert(patchNote.includes("multi-file patch smoke"), "mock multi-file patch did not add expected file");
  assert(
    multiPatchRun.ok && multiPatchRun.changes?.length >= 2,
    "multi-file patch did not report each file change"
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

  await fs.writeFile(path.join(workspace, "no-op-patch-target.txt"), "already correct\n", "utf8");
  const noOpPatchError = await executeWorkspaceTool(
    "apply_patch",
    {
      path: "no-op-patch-target.txt",
      search: "already correct",
      replace: "already correct",
      expectedReplacements: 1,
    },
    { commandCwd: workspace, allowFileTools: true }
  )
    .then(() => "")
    .catch((error) => String(error?.message || error));
  assert(
    /patch made no changes/i.test(noOpPatchError) &&
      (await fs.readFile(path.join(workspace, "no-op-patch-target.txt"), "utf8")) === "already correct\n",
    "an exact byte-identical replacement was reported as a successful mutation"
  );

  await fs.writeFile(path.join(workspace, "hybrid-patch-target.txt"), "alpha\nold\nomega\n", "utf8");
  const hybridPatch = await executeWorkspaceTool(
    "apply_patch",
    {
      patch: [
        "*** Begin Patch ***",
        "--- a/hybrid-patch-target.txt",
        "+++ b/hybrid-patch-target.txt",
        "@@ -1,3 +1,3 @@",
        " alpha",
        "-old",
        "+new",
        " omega",
        "*** End Patch ***",
      ].join("\n"),
    },
    { commandCwd: workspace, allowFileTools: true }
  );
  const hybridPatchText = await fs.readFile(path.join(workspace, "hybrid-patch-target.txt"), "utf8");
  assert(
    hybridPatch.ok && hybridPatchText === "alpha\nnew\nomega\n",
    "hybrid wrapped unified apply_patch did not update expected file"
  );

  await fs.mkdir(path.join(workspace, "a"), { recursive: true });
  await fs.writeFile(path.join(workspace, "report.md"), "root report\n", "utf8");
  await fs.writeFile(path.join(workspace, "a", "report.md"), "nested old\n", "utf8");
  const nestedCustomPatch = await executeWorkspaceTool(
    "apply_patch",
    {
      patch: [
        "*** Begin Patch",
        "*** Update File: a/report.md",
        "@@",
        "-nested old",
        "+nested new",
        "*** End Patch",
      ].join("\n"),
    },
    { commandCwd: workspace, allowFileTools: true }
  );
  assert(
    nestedCustomPatch.ok &&
      (await fs.readFile(path.join(workspace, "a", "report.md"), "utf8")) === "nested new\n" &&
      (await fs.readFile(path.join(workspace, "report.md"), "utf8")) === "root report\n",
    "custom patch path canonicalization confused a real a/ directory with a unified-diff prefix"
  );
  const nestedCustomDelete = await executeWorkspaceTool(
    "apply_patch",
    { patch: ["*** Begin Patch", "*** Delete File: a/report.md", "*** End Patch"].join("\n") },
    { commandCwd: workspace, allowFileTools: true }
  );
  assert(nestedCustomDelete.ok, "custom patch could not delete its exact nested target");
  const nestedStillExists = await fs
    .stat(path.join(workspace, "a", "report.md"))
    .then(() => true)
    .catch(() => false);
  assert(
    !nestedStillExists && (await fs.readFile(path.join(workspace, "report.md"), "utf8")) === "root report\n",
    "custom delete stripped a real a/ directory and deleted the wrong root file"
  );

  await fs.writeFile(path.join(workspace, "repair-report.md"), "old report\n", "utf8");
  const ordinaryAddExistingError = await executeWorkspaceTool(
    "apply_patch",
    {
      patch: ["*** Begin Patch", "*** Add File: repair-report.md", "+new report", "*** End Patch"].join("\n"),
    },
    { commandCwd: workspace, allowFileTools: true }
  )
    .then(() => "")
    .catch((error) => String(error?.message || error));
  assert(
    /cannot add an existing file/i.test(ordinaryAddExistingError),
    "ordinary apply_patch unexpectedly replaced an existing file"
  );
  const repairReplace = await executeWorkspaceTool(
    "apply_patch",
    {
      patch: ["*** Begin Patch", "*** Add File: repair-report.md", "+new report", "*** End Patch"].join("\n"),
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
      artifactValidationReplacePaths: ["repair-report.md"],
    }
  );
  assert(repairReplace.ok, "artifact repair did not atomically replace its exact output");
  assert(
    (await fs.readFile(path.join(workspace, "repair-report.md"), "utf8")).trim() === "new report",
    "atomic exact-output replacement wrote the wrong content"
  );
  assert(
    repairReplace.change?.action === "apply_patch_replace",
    "atomic exact-output replacement did not preserve distinct audit provenance"
  );

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

  const safeEnvReferenceResult = await executeWorkspaceTool(
    "write_file",
    {
      path: "scripts/safe-env-reference.py",
      content: [
        "import os",
        "from openai import OpenAI",
        "def load_api_key():",
        '    return os.environ.get("DEEPSEEK_API_KEY")',
        "api_key = load_api_key()",
        'client = OpenAI(api_key=api_key, base_url="https://api.deepseek.com")',
        "print(client)",
        "",
      ].join("\n"),
      mode: "create",
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(safeEnvReferenceResult.ok, "write_file should allow safe env-var credential references in source code");

  const safeTokenVariableSyntaxResult = await executeWorkspaceTool(
    "write_file",
    {
      path: "scripts/safe-token-variable-syntax.py",
      content: [
        "def validate(tokens):",
        "    for token in tokens:",
        "        if not isinstance(token, dict) or \"t\" not in token:",
        "            raise ValueError(\"token must contain t\")",
        "        text = str(token.get(\"t\", \"\"))",
        "        if token:",
        "            print(text)",
        "",
      ].join("\n"),
      mode: "create",
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(safeTokenVariableSyntaxResult.ok, "write_file should allow benign token variable syntax in source code");

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

  const credentialStatusReportResult = await executeWorkspaceTool(
    "write_file",
    {
      path: "notes/credential-status-report.md",
      content: [
        "Runtime readiness:",
        "- openai_api_key = false",
        "- deepseek_api_key: not-set",
        "- hf_token = [REDACTED]",
        "",
      ].join("\n"),
      mode: "create",
    },
    {
      commandCwd: workspace,
      allowFileTools: true,
    }
  );
  assert(credentialStatusReportResult.ok, "write_file blocked safe credential availability statuses");

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
          "run_agent_runtime_git_hygiene",
          "interleaved_tool_history_repair",
          "blocked_tool_batch_short_circuit",
          "deepseek_pro_patch_route",
          "deepseek_pro_writing_route",
          "writing_specialist_mock",
          "writing_specialist_mock_routing",
          "json_specialist_mock",
          "json_specialist_mock_routing",
          "runtime_time_context",
          "large_profile_pro_route",
          "auto_system_pro_route",
          "auto_engineering_guidance",
          "surgical_context_trigger",
          "command_policy_readonly_probe_sequence_no_installs",
          "command_policy_readonly_version_pipeline_no_installs",
          "command_policy_readonly_test_echo_no_installs",
          "command_policy_readonly_r_version_probe_no_installs",
          "command_policy_rscript_toolchain_no_installs",
          "command_policy_pdflatex_compile_no_installs",
          "command_policy_latexmk_compile_no_installs",
          "command_policy_local_git_workflow_no_installs",
          "command_policy_git_rebase_still_guarded",
          "command_policy_git_clone_network",
          "command_policy_safe_chmod_sequence",
          "command_policy_host_workspace_chmod",
          "command_policy_android_host_probes",
          "command_policy_host_localhost_json_probe",
          "command_policy_absolute_python_helper",
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
          "surgical_context_pack",
          "mock_inspect_project",
          "direct_greeting_no_tools",
          "write_file",
          "duplicate_write_failed",
          "resume_session_write",
          "resume_runtime_time_context",
          "virtual_workspace_path",
          "svg_cdata_validation_failure",
          "svg_unescaped_text_xml_validation_failure",
          "svg_standalone_validation_pass",
          "apply_patch",
          "multi_file_patch",
          "unified_patch",
          "patch_guardrail",
          "patch_move_no_overwrite",
          "block_env",
          "block_secret_write_content",
          "allow_safe_env_reference_content",
          "allow_redacted_write_content",
          "block_secret_patch_content",
          "block_outside",
          "node_profile_cli_package_manifest",
          "python_profile_helper_test_report",
          "model_timeout_compact_retry_messages",
          "focused_text_rewrite_specialist_recovery",
        ],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
