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
  announceConvergenceOutputPhase,
  artifactValidationFinishBlock,
  artifactValidationScopeBlock,
  canonicalizeVerifiedArtifactCompletion,
  completedDeepResearchReuse,
  completionEvidenceNeedsCommand,
  enqueueFailedTestRepairInstruction,
  nextStepRuntimeConfig,
  projectAcceptanceFromMarkdown,
  recordCanonicalGeneratedOutputProgress,
  recordProjectVerificationOutcome,
  recordExactOutputProgress,
  recordStaticDiscoveryProgress,
  resetGoalScopedRuntimeState,
  resetStaticDiscoveryAfterContextLoss,
  rememberCompletedDeepResearch,
  repeatedNoProgressToolBlock,
  repeatedSuccessfulMutationBlock,
  repeatedStaticToolBlock,
  reopenedArtifactRepairPending,
  shouldResetStaticDiscoveryPhase,
} from "../src/agent-runner.js";
import {
  augmentScsTaskContractWithProjectVerification,
  buildScsEvidenceLedger,
  deriveScsTaskContract,
  evaluateScsEvidence,
} from "../src/scs-evidence.js";
import {
  createStepBudgetState,
  decideStepBudgetExtension,
  isStaticDiscoveryToolCall,
  staticToolCallSignature,
  normalizeDynamicStepsMode,
  shouldEvaluateResumeBoundary,
  summarizeRepeatedStaticDiscovery,
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
  const failedExitProbeState = { meta: {} };
  const failedExitProbeResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: 'python -m unittest discover -s tests; echo "EXIT:$?"' },
    stdout: "external contract did not pass\nEXIT:1\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(failedExitProbeState, failedExitProbeResult, {
    commandCwd: workspace,
    taskProfile: "qa",
  });
  assert(
    failedExitProbeResult.projectTest?.passed === false &&
      failedExitProbeResult.projectTest?.explicitExitStatus === 1,
    "a wrapped nonzero test status was recorded as passing"
  );
  const missingExitProbeState = { meta: {} };
  const missingExitProbeResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: 'python -m unittest discover -s tests; printf "EXIT=%s\\n" "$?"' },
    stdout: "external contract output ended before the status marker\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(missingExitProbeState, missingExitProbeResult, {
    commandCwd: workspace,
    taskProfile: "qa",
  });
  assert(
    missingExitProbeResult.projectTest?.passed === false &&
      missingExitProbeResult.projectTest?.explicitExitStatus === null,
    "a missing wrapped test status was recorded as passing"
  );
  const passingExitProbeState = { meta: {} };
  const passingExitProbeResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: 'python -m unittest discover -s tests; echo "EXIT=$?"' },
    stdout: "contract checks passed\nEXIT=0\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(passingExitProbeState, passingExitProbeResult, {
    commandCwd: workspace,
    taskProfile: "qa",
  });
  assert(
    passingExitProbeResult.projectTest?.passed === true &&
      passingExitProbeResult.projectTest?.explicitExitStatus === 0,
    "a wrapped zero test status was not accepted"
  );

  const newGoalState = {
    meta: {
      artifactProgress: { complete: true },
      completionEvidenceRepair: { attempts: 1 },
      dataProjectWorkflow: { ready: true },
      durableEvidenceCategories: ["file", "visual"],
      durableGitActions: ["commit"],
      durableGitEvidence: [{ action: "commit", goalRevision: 1 }],
      failedTestRecoveryPacket: { content: "old failure" },
      goalContract: { revision: 2 },
      projectVerification: { mutationRevision: 4 },
      scs: { taskContract: { exactOutputPaths: ["old-output.md"] } },
      completedDeepResearch: [{ goalKey: "retained-other-goal" }],
    },
  };
  const removedGoalState = resetGoalScopedRuntimeState(newGoalState);
  assert(removedGoalState.includes("artifactProgress"), "new goal did not clear stale artifact progress");
  assert(!newGoalState.meta.projectVerification, "new goal retained stale project verification");
  assert(!newGoalState.meta.scs, "new goal retained the previous SCS task contract");
  assert(!newGoalState.meta.durableEvidenceCategories, "new goal inherited completed evidence categories");
  assert(newGoalState.meta.goalContract?.revision === 2, "new goal reset its durable goal contract");
  assert(newGoalState.meta.completedDeepResearch?.length === 1, "new goal discarded goal-keyed research cache");

  const optionalVisualContract = deriveScsTaskContract({
    goal: "Repair the repository, verify it, commit, and push the intentional work.",
    taskProfile: "github",
    acceptanceCriteria: [
      "Do not rely only on chat summaries; verify files, commands, screenshots, PDFs, reports, or app launches as appropriate.",
    ],
  });
  assert(
    !optionalVisualContract.requiredEvidence.some((item) => item.category === "visual"),
    "an optional evidence example forced irrelevant visual validation"
  );
  const explicitVisualContract = deriveScsTaskContract({
    goal: "Capture and inspect a screenshot of the repaired interface.",
    taskProfile: "website",
  });
  assert(
    explicitVisualContract.requiredEvidence.some((item) => item.category === "visual"),
    "an explicit screenshot request lost visual validation"
  );
  const readOnlyCheckerContract = deriveScsTaskContract({
    goal:
      "Re-run /tmp/acceptance/github_maintenance_contract.py once, verify the repository, and do not edit, commit, or push anything.",
    taskProfile: "github",
  });
  assert(
    !readOnlyCheckerContract.requiredEvidence.some((item) => item.category === "file"),
    "a read-only checker path was mistaken for a requested file change"
  );
  const canvasOnlyContract = deriveScsTaskContract({
    goal: "Create a canvas artifact preview for this smoke test.",
  });
  assert(
    canvasOnlyContract.requiredEvidence.some((item) => item.category === "artifact") &&
      !canvasOnlyContract.requiredEvidence.some((item) => item.category === "file"),
    "a virtual canvas artifact was mistaken for a workspace-file mutation"
  );
  const sourceRepairContract = deriveScsTaskContract({
    goal: "Fix src/runtime.py and verify the focused tests.",
    taskProfile: "python",
  });
  assert(
    sourceRepairContract.requiredEvidence.some((item) => item.category === "file"),
    "an explicit source repair lost its file-change evidence gate"
  );
  const ignoredGeneratedOutputsContract = deriveScsTaskContract({
    goal: [
      "You have explicit trusted-host approval for this isolated Java fixture.",
      "Continue the same task from the current edits. Run the checked-in project test script, repair any failures,",
      "create the required project guidance, ignore generated build and session outputs, commit only intentional work,",
      "and finish with verified evidence.",
    ].join(" "),
    taskProfile: "java",
  });
  assert(
    ignoredGeneratedOutputsContract.requiredEvidence.some((item) => item.category === "file") &&
      ignoredGeneratedOutputsContract.requiredEvidence.some((item) => item.category === "command") &&
      ignoredGeneratedOutputsContract.requiredEvidence.some((item) => item.category === "git") &&
      !ignoredGeneratedOutputsContract.requiredEvidence.some((item) => item.category === "artifact"),
    "ignoring generated build/session outputs invented a standalone artifact requirement"
  );
  const durableArtifactPath = path.join(workspace, "reports", "durable-report.pdf");
  await fs.mkdir(path.dirname(durableArtifactPath), { recursive: true });
  await fs.writeFile(durableArtifactPath, "%PDF-1.4\nsmoke\n", "utf8");
  const artifactEvents = [
    {
      type: "tool.completed",
      data: {
        ok: true,
        toolName: "run_command",
        args: { command: "printf smoke > reports/durable-report.pdf" },
        stdout: "created reports/durable-report.pdf",
        exitCode: 0,
      },
    },
  ];
  const durableArtifactLedger = buildScsEvidenceLedger({
    context: { events: artifactEvents, commandCwd: workspace },
  });
  assert(
    durableArtifactLedger.categories.includes("artifact"),
    "an existing shell-generated PDF did not count as durable artifact evidence"
  );
  await fs.rm(durableArtifactPath);
  const removedArtifactLedger = buildScsEvidenceLedger({
    context: { events: artifactEvents, commandCwd: workspace },
  });
  assert(
    !removedArtifactLedger.categories.includes("artifact") &&
      removedArtifactLedger.items.some((item) => item.category === "artifact" && item.verified === false),
    "a removed artifact continued to satisfy the final evidence ledger"
  );
  const labelOnlyArtifactLedger = buildScsEvidenceLedger({
    context: {
      events: [
        {
          type: "tool.completed",
          data: {
            ok: true,
            toolName: "run_command",
            args: { command: "echo ARTIFACT READY" },
            stdout: "ARTIFACT READY",
            exitCode: 0,
          },
        },
      ],
      commandCwd: workspace,
    },
  });
  assert(
    !labelOnlyArtifactLedger.categories.includes("artifact"),
    "an artifact label in generic shell text counted as a durable artifact"
  );
  assert(
    completionEvidenceNeedsCommand({ missingProjectCommands: ["python analysis.py"] }),
    "a pending canonical command did not reopen command execution"
  );
  assert(
    completionEvidenceNeedsCommand({ missingGitActions: ["commit"] }),
    "a pending git action did not reopen command execution"
  );
  assert(
    !completionEvidenceNeedsCommand({ missing: [], missingProjectCommands: [], missingGitActions: [] }),
    "satisfied completion evidence kept command execution open"
  );
  assert(normalizeDynamicStepsMode("always") === "on", "dynamic mode always did not normalize to on");
  assert(normalizeDynamicStepsMode("smart") === "auto", "dynamic mode smart did not normalize to auto");
  const inheritedBudget = createStepBudgetState(
    { maxSteps: 16, dynamicSteps: "off" },
    {
      stepsCompleted: 0,
      meta: {
        stepBudget: {
          initialMaxSteps: 30,
          currentMaxSteps: 40,
          extensionsUsed: 1,
          lastExtensionStep: 28,
        },
      },
    }
  );
  assert(inheritedBudget.currentMaxSteps === 40, "ordinary resume did not retain its prior expanded budget");
  const explicitBudget = createStepBudgetState(
    { maxSteps: 16, dynamicSteps: "off", resetStepBudget: true },
    {
      stepsCompleted: 0,
      meta: {
        stepBudget: {
          initialMaxSteps: 30,
          currentMaxSteps: 40,
          extensionsUsed: 1,
          lastExtensionStep: 28,
        },
      },
    }
  );
  assert(explicitBudget.initialMaxSteps === 16, "explicit resumed max-steps did not reset the initial budget");
  assert(explicitBudget.currentMaxSteps === 16, "a prior extension overrode explicit resumed max-steps");
  assert(explicitBudget.extensionsUsed === 0, "explicit resumed max-steps retained stale extension usage");
  assert(explicitBudget.resetFromExplicitOverride, "explicit resumed max-steps reset was not recorded");
  assert(isStaticDiscoveryToolCall("run_command", { command: "ls -la ../Musia" }), "static ls discovery was not classified");
  assert(isStaticDiscoveryToolCall("read_image", { path: "snapshot.png" }), "image perception was not classified as static discovery");
  assert(
    !shouldResetStaticDiscoveryPhase({ ok: false, toolName: "read_image", args: { path: "missing.png" } }),
    "failed non-mutating perception should not reset static discovery convergence"
  );
  assert(
    shouldResetStaticDiscoveryPhase({ ok: true, toolName: "write_file", args: { path: "report.md" } }),
    "successful output creation should reset static discovery convergence"
  );
  const uniqueDiscovery = {};
  recordStaticDiscoveryProgress(uniqueDiscovery, "read_file:/reference/A.md");
  recordStaticDiscoveryProgress(uniqueDiscovery, "read_file:/reference/A.md");
  recordStaticDiscoveryProgress(uniqueDiscovery, "read_file:/reference/B.md");
  assert(uniqueDiscovery.staticTotal === 2, "duplicate reads consumed the unique convergence budget");
  assert(uniqueDiscovery.staticCallTotal === 3, "raw static call telemetry did not retain duplicate calls");
  assert(uniqueDiscovery.staticCounts["read_file:/reference/A.md"] === 2, "per-signature loop accounting was lost");
  const compactedDiscoveryState = {
    meta: {
      toolLoop: {
        recent: [],
        warned: ["file-read:/reference/A.md", "run_command:keep"],
        staticCounts: { "file-read:/reference/A.md": 1 },
        staticOrder: ["file-read:/reference/A.md"],
        staticTotal: 1,
        staticCallTotal: 1,
        convergenceAnnounced: { staticTotal: 1 },
      },
    },
  };
  resetStaticDiscoveryAfterContextLoss(compactedDiscoveryState, "smoke-compaction");
  assert(compactedDiscoveryState.meta.toolLoop.staticTotal === 0, "context recovery kept a stale static convergence total");
  assert(compactedDiscoveryState.meta.toolLoop.staticOrder.length === 0, "context recovery kept stale read signatures active");
  assert(compactedDiscoveryState.meta.toolLoop.staticHistory.length === 1, "context recovery did not archive discovery telemetry");
  assert(
    JSON.stringify(compactedDiscoveryState.meta.toolLoop.warned) === JSON.stringify(["run_command:keep"]),
    "context recovery did not clear only stale static-read warnings"
  );
  const exactReadSignature = staticToolCallSignature("read_file", { path: "/reference/A.md" }, {
    commandCwd: workspace,
  });
  assert(
    repeatedStaticToolBlock(
      { meta: { toolLoop: { staticCounts: { [exactReadSignature]: 1 }, staticTotal: 1 } } },
      "read_file",
      { path: "/reference/A.md" },
      { commandCwd: workspace }
    )?.category === "repeated-read-only-call",
    "an exact successful source reread was not closed after the first call"
  );
  assert(
    repeatedStaticToolBlock(
      { meta: { toolLoop: { staticCounts: { [exactReadSignature]: 1 }, staticTotal: 1 } } },
      "read_file",
      { path: "/reference/A.md", startLine: 200, lineLimit: 80 },
      { commandCwd: workspace }
    ) === null,
    "a bounded continuation read was mistaken for an exact reread"
  );
  const repeatedProbeArgs = { command: "python -c \"print(100.0)\"" };
  const repeatedProbeSignature = staticToolCallSignature("run_command", repeatedProbeArgs, {
    commandCwd: workspace,
  });
  const repeatedProbeState = {
    meta: {
      toolLoop: {
        stagnationEpoch: 4,
        recent: [
          {
            signature: repeatedProbeSignature,
            toolName: "run_command",
            ok: true,
            blocked: false,
            noProgressProbe: true,
            outcomeFingerprint: "same-output",
            stagnationEpoch: 4,
          },
          {
            signature: repeatedProbeSignature,
            toolName: "run_command",
            ok: true,
            blocked: false,
            noProgressProbe: true,
            outcomeFingerprint: "same-output",
            stagnationEpoch: 4,
          },
        ],
      },
    },
  };
  assert(
    repeatedNoProgressToolBlock(repeatedProbeState, "run_command", repeatedProbeArgs, {
      commandCwd: workspace,
    })?.category === "repeated-no-progress-call",
    "a third identical unchanged shell probe was not blocked"
  );
  assert(
    repeatedNoProgressToolBlock(
      {
        meta: {
          toolLoop: {
            stagnationEpoch: 5,
            recent: repeatedProbeState.meta.toolLoop.recent,
          },
        },
      },
      "run_command",
      repeatedProbeArgs,
      { commandCwd: workspace }
    ) === null,
    "a new mutation epoch did not reopen bounded validation"
  );
  assert(
    repeatedNoProgressToolBlock(
      repeatedProbeState,
      "run_command",
      { command: "python monitor.py --status" },
      { commandCwd: workspace }
    ) === null,
    "an explicit status polling command was incorrectly blocked"
  );
  const repeatedPatchArgs = {
    path: "analysis.py",
    search: "signal = raw_signal",
    replace: "signal = raw_signal - offset",
    searchHash: "search-hash",
    replaceHash: "replace-hash",
  };
  const repeatedPatchSignature = staticToolCallSignature("apply_patch", repeatedPatchArgs, {
    commandCwd: workspace,
  });
  const repeatedPatchState = {
    meta: {
      toolLoop: {
        stagnationEpoch: 7,
        recent: [
          {
            signature: repeatedPatchSignature,
            toolName: "apply_patch",
            ok: true,
            blocked: false,
            successfulMutation: true,
            stagnationEpoch: 7,
          },
        ],
      },
    },
  };
  assert(
    repeatedSuccessfulMutationBlock(repeatedPatchState, "apply_patch", repeatedPatchArgs, {
      commandCwd: workspace,
    })?.category === "repeated-successful-mutation",
    "an exact already-successful patch was not blocked in the same mutation epoch"
  );
  assert(
    repeatedSuccessfulMutationBlock(
      {
        meta: {
          toolLoop: {
            stagnationEpoch: 8,
            recent: repeatedPatchState.meta.toolLoop.recent,
          },
        },
      },
      "apply_patch",
      repeatedPatchArgs,
      { commandCwd: workspace }
    ) === null,
    "a user continuation did not reopen an intentional exact patch"
  );
  assert(
    repeatedSuccessfulMutationBlock(
      repeatedPatchState,
      "apply_patch",
      { ...repeatedPatchArgs, replaceHash: "different-replacement-hash" },
      { commandCwd: workspace }
    ) === null,
    "a materially different patch was mistaken for an exact replay"
  );
  const completedResearchState = {
    goal: "Create one cited report",
    meta: { goalContract: { revision: 1, currentHash: "goal-one" } },
  };
  rememberCompletedDeepResearch(
    completedResearchState,
    { query: "Research evidence", outputPath: "report.md" },
    { commandCwd: workspace, provider: "deepseek", model: "deepseek-v4-pro" },
    {
      ok: true,
      toolName: "deep_research",
      researchId: "research-one",
      status: "completed",
      reportPath: path.join(workspace, "report.md"),
      artifactPath: path.join(workspace, "research.json"),
      answer: "Verified result.",
    }
  );
  const reusedResearch = completedDeepResearchReuse(
    completedResearchState,
    { query: "A model-expanded query", outputPath: "report.md", refresh: true },
    { commandCwd: workspace }
  );
  assert(
    reusedResearch?.duplicateSuppressed && reusedResearch.reportPath === path.join(workspace, "report.md"),
    "same-goal deep research did not reuse an already completed exact report"
  );
  completedResearchState.meta.goalContract = { revision: 2, currentHash: "goal-two" };
  assert(
    completedDeepResearchReuse(
      completedResearchState,
      { query: "A new user request", outputPath: "report.md" },
      { commandCwd: workspace }
    ) === null,
    "a later user goal revision could not intentionally refresh a research report"
  );
  const researchOutputState = {
    meta: {
      scs: { taskContract: { exactOutputPaths: ["report.md"] } },
    },
  };
  const researchOutputProgress = recordExactOutputProgress(
    researchOutputState,
    { ok: true, toolName: "deep_research", reportPath: path.join(workspace, "report.md") },
    { commandCwd: workspace }
  );
  assert(
    researchOutputProgress.justActivated && researchOutputProgress.completed[0] === "report.md",
    "deep research did not activate exact-output validation for its completed report"
  );
  const convergenceState = {
    messages: [],
    meta: {
      toolLoop: { staticTotal: 14 },
      scs: { taskContract: { exactOutputPaths: ["report.md"] } },
    },
  };
  const convergenceTransition = announceConvergenceOutputPhase(convergenceState);
  assert(convergenceTransition?.exactOutputs?.[0] === "report.md", "convergence transition lost the exact output path");
  assert(
    /does not offer inspect_project.*Create the requested output now: report\.md/i.test(
      convergenceState.messages.at(-1)?.content || ""
    ),
    "convergence transition did not tell the model that discovery tools closed before output creation"
  );
  assert(
    announceConvergenceOutputPhase(convergenceState) === null,
    "convergence transition was announced more than once"
  );
  assert(
    nextStepRuntimeConfig({ provider: "localllm" }, convergenceState).convergenceOutputPhase === true,
    "convergence transition did not narrow the next tool surface"
  );
  const checkedConvergenceState = {
    messages: [],
    meta: {
      toolLoop: { staticTotal: 14 },
      scs: {
        taskContract: {
          exactOutputPaths: ["readiness.md"],
          requiresPerSourceChecks: true,
        },
      },
    },
  };
  const checkedTransition = announceConvergenceOutputPhase(checkedConvergenceState);
  assert(checkedTransition?.requiresPerSourceChecks === true, "required source checks were lost at convergence");
  assert(
    /bounded run_command remains available/i.test(checkedConvergenceState.messages.at(-1)?.content || ""),
    "convergence closed the command needed for task-required source checks"
  );
  assert(
    /one source root per probe/i.test(checkedConvergenceState.messages.at(-1)?.content || ""),
    "convergence did not prohibit compound multi-root checks"
  );
  assert(
    nextStepRuntimeConfig({ provider: "localllm" }, checkedConvergenceState).convergenceAllowRunCommand === true,
    "convergence runtime config did not retain the bounded check tool"
  );
  const artifactState = {
    commandCwd: workspace,
    meta: {
      scs: {
        taskContract: {
          exactOutputPaths: ["MEDIA_ROUTINE_READINESS.md"],
        },
      },
    },
  };
  const deleteOutputBlock = artifactValidationScopeBlock(
    {
      commandCwd: workspace,
      meta: {
        artifactProgress: {
          exactOutputPaths: ["report.md"],
          needsRepair: true,
        },
      },
    },
    "apply_patch",
    { patch: "*** Begin Patch\n*** Delete File: report.md\n*** End Patch" },
    { commandCwd: workspace, artifactValidationPhase: true }
  );
  assert(
    deleteOutputBlock?.category === "artifact-validation-delete-output",
    "artifact validation allowed delete-and-recreate repair of an exact output"
  );
  const reopenedSourceReadState = {
    commandCwd: workspace,
    meta: {
      artifactProgress: {
        exactOutputPaths: ["outputs/report.md"],
        needsRepair: true,
        needsSourceRead: true,
        reopenedSourcePaths: ["analysis.py"],
      },
    },
  };
  assert(
    artifactValidationScopeBlock(
      reopenedSourceReadState,
      "read_file",
      { path: "analysis.py" },
      { commandCwd: workspace, artifactValidationPhase: true }
    ) === null,
    "a correction request could not inspect its exact named source file"
  );
  assert(
    artifactValidationScopeBlock(
      reopenedSourceReadState,
      "read_file",
      { path: "unrelated.py" },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.category === "artifact-validation-scope",
    "the correction source allowance leaked to unrelated files"
  );
  const artifactProgress = recordExactOutputProgress(
    artifactState,
    {
      ok: true,
      toolName: "write_file",
      path: "MEDIA_ROUTINE_READINESS.md",
      change: { path: "MEDIA_ROUTINE_READINESS.md", afterBytes: 1200 },
    },
    { commandCwd: workspace }
  );
  assert(artifactProgress.justActivated, "exact output mutation did not activate artifact validation");
  assert(artifactState.meta.artifactProgress.complete, "exact output progress was not persisted");
  assert(
    nextStepRuntimeConfig({ provider: "localllm" }, artifactState).artifactValidationPhase === true,
    "next step did not enter artifact validation mode"
  );
  const reopenedRepairState = {
    meta: {
      goalContract: { revision: 9 },
      artifactProgress: { reopenedGoalRevision: 9, reopenedMutationRevision: 4 },
      projectVerification: { mutationRevision: 4 },
    },
  };
  assert(
    reopenedArtifactRepairPending(reopenedRepairState),
    "a fresh same-task correction was cleared before any source mutation"
  );
  reopenedRepairState.meta.projectVerification.mutationRevision = 5;
  assert(
    !reopenedArtifactRepairPending(reopenedRepairState),
    "a source mutation did not satisfy the revision-scoped repair obligation"
  );
  reopenedRepairState.meta.projectVerification.mutationRevision = 4;
  reopenedRepairState.meta.goalContract.revision = 10;
  assert(
    !reopenedArtifactRepairPending(reopenedRepairState),
    "an old correction obligation leaked into a different goal revision"
  );
  artifactState.meta.artifactProgress.needsRepair = true;
  artifactState.meta.artifactProgress.outputEmbedded = true;
  artifactState.meta.artifactProgress.usedValidationTools = ["read_file"];
  const repairConfig = nextStepRuntimeConfig({ provider: "localllm" }, artifactState);
  assert(repairConfig.artifactValidationNeedsRepair === true, "artifact repair state was not propagated");
  assert(repairConfig.artifactValidationOutputEmbedded === true, "embedded-output state was not propagated");
  assert(repairConfig.artifactValidationRepairAttempts === 0, "artifact repair-attempt state was not propagated");
  assert(
    repairConfig.artifactValidationUsedTools.includes("read_file"),
    "used artifact validation tools were not propagated"
  );
  artifactState.meta.artifactProgress.needsSourceRead = true;
  artifactState.meta.artifactProgress.preflight = { missingSourceReads: ["../Musia"] };
  assert(
    nextStepRuntimeConfig({ provider: "localllm" }, artifactState).artifactValidationNeedsSourceRead === true,
    "missing source-read state was not propagated"
  );
  recordExactOutputProgress(
    artifactState,
    { ok: true, toolName: "read_file", path: "MEDIA_ROUTINE_READINESS.md" },
    { commandCwd: workspace }
  );
  assert(artifactState.meta.artifactProgress.complete, "later validation reads cleared completed output progress");
  assert(artifactState.meta.artifactProgress.needsRepair, "later validation reads cleared semantic preflight state");
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "read_file",
      { path: "/home/lachlan/ProjectsLFS/Musia/README.md" },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.category === "artifact-validation-scope",
    "artifact validation allowed unrelated source discovery"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "read_file",
      { path: "../Musia/README.md" },
      { commandCwd: workspace, artifactValidationPhase: true }
    ) === null,
    "artifact validation blocked a specifically missing source root"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "read_file",
      { path: "MEDIA_ROUTINE_READINESS.md" },
      { commandCwd: workspace, artifactValidationPhase: true }
    ) === null,
    "artifact validation blocked the exact requested output"
  );
  artifactState.meta.artifactProgress.repairAttempts = 3;
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "apply_patch",
      { path: "MEDIA_ROUTINE_READINESS.md", patch: "noop" },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.stopRun === true,
    "artifact validation did not stop an exhausted repair loop"
  );
  artifactState.meta.artifactProgress.bestDefectCount = 4;
  artifactState.meta.artifactProgress.stagnantRepairAttempts = 0;
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "apply_patch",
      { path: "MEDIA_ROUTINE_READINESS.md", patch: "improving" },
      { commandCwd: workspace, artifactValidationPhase: true }
    ) === null,
    "artifact validation stopped a repair route that was still measurably converging"
  );
  artifactState.meta.artifactProgress.repairAttempts = 6;
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "apply_patch",
      { path: "MEDIA_ROUTINE_READINESS.md", patch: "hard-cap" },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.stopRun === true,
    "artifact validation did not enforce the bounded hard repair cap"
  );
  artifactState.meta.artifactProgress.needsRepair = false;
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "write_file",
      { path: "MEDIA_ROUTINE_READINESS.md" },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.category === "artifact-validation-complete",
    "artifact validation allowed a rewrite after deterministic success"
  );
  artifactState.meta.artifactProgress.preflightFingerprint = "passed";
  artifactState.meta.artifactProgress.preflight = { defectCount: 0 };
  artifactState.meta.artifactProgress.defectCount = 0;
  artifactState.meta.artifactProgress.needsCommand = false;
  artifactState.meta.artifactProgress.needsSourceRead = false;
  artifactState.meta.artifactProgress.repairAttempts = 0;
  artifactState.meta.artifactProgress.stagnantRepairAttempts = 0;
  artifactState.meta.artifactProgress.finishRejects = 0;
  assert(
    artifactValidationFinishBlock(artifactState) === null,
    "artifact validation blocked finish after deterministic preflight passed"
  );
  assert(
    canonicalizeVerifiedArtifactCompletion(
      artifactState,
      "Completed a different file at OLD_REPORT.md."
    ) === "Completed the requested work and verified it from runtime evidence. Verified output: MEDIA_ROUTINE_READINESS.md. Deterministic artifact validation passed.",
    "verified completion did not replace a mismatched model-authored output path with the exact contract path"
  );
  assert(
    canonicalizeVerifiedArtifactCompletion(
      artifactState,
      "Completed and verified MEDIA_ROUTINE_READINESS.md."
    ) === "Completed and verified MEDIA_ROUTINE_READINESS.md.",
    "verified completion rewrote a result that already named the exact contract output"
  );
  const portablePathState = {
    commandCwd: workspace,
    meta: {
      artifactProgress: {
        complete: true,
        exactOutputPaths: [path.join(workspace, "reports", "fluorescence-dose-response-analysis.pdf")],
        preflight: { defectCount: 0 },
        preflightFingerprint: "passed",
        defectCount: 0,
        needsRepair: false,
        needsCommand: false,
        needsSourceRead: false,
      },
    },
  };
  const portableCompletion = canonicalizeVerifiedArtifactCompletion(portablePathState, "");
  assert(
    portableCompletion.includes("reports/fluorescence-dose-response-analysis.pdf") &&
      !portableCompletion.includes(workspace),
    "verified completion leaked an absolute private workspace path"
  );
  artifactState.meta.artifactProgress.needsRepair = true;
  artifactState.meta.artifactProgress.defectCount = 2;
  assert(
    artifactValidationFinishBlock(artifactState)?.category === "artifact-validation-finish-rejected",
    "artifact validation allowed finish with unresolved deterministic defects"
  );
  artifactState.meta.artifactProgress.finishRejects = 1;
  assert(
    artifactValidationFinishBlock(artifactState)?.stopRun === true,
    "artifact validation did not stop a repeated unresolved finish attempt for fallback"
  );
  artifactState.meta.artifactProgress.finishRejects = 0;
  artifactState.meta.artifactProgress.needsRepair = false;
  artifactState.meta.artifactProgress.defectCount = 0;
  artifactState.meta.artifactProgress.preflightFingerprint = "";
  assert(
    artifactValidationFinishBlock(artifactState)?.category === "artifact-validation-finish-rejected",
    "artifact validation allowed finish before deterministic preflight ran"
  );
  assert(
    !isStaticDiscoveryToolCall("run_command", { command: "python poll_job.py --status" }),
    "dynamic status polling should remain repeatable"
  );
  const semanticListContext = { commandCwd: "/tmp/workspace" };
  assert(
    staticToolCallSignature("list_files", { path: "../Musia", maxDepth: 2 }, semanticListContext) ===
      staticToolCallSignature("run_command", { command: "ls -la /tmp/Musia" }, semanticListContext),
    "semantic discovery identity did not normalize relative/absolute list variants"
  );
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
  const boundedSearchRecovery = {
    toolName: "run_command",
    ok: false,
    blocked: true,
    args: { command: "grep -r routine /tmp/project" },
    permissionAdvice: { autoRecover: true, instruction: "Use a bounded targeted search." },
  };
  assert(
    !shouldReviewToolResult(boundedSearchRecovery, { meta: {} }),
    "SCS should let deterministic autoRecover advice repair bounded search shape without replanning"
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
  const migratedDefaultBudget = createStepBudgetState(
    {
      provider: "localllm",
      maxSteps: 30,
      dynamicSteps: "auto",
      dynamicStepExtensionLimit: 1,
      dynamicStepExtensionLimitExplicit: false,
      scsActive: false,
    },
    {
      meta: {
        stepBudget: {
          initialMaxSteps: 30,
          currentMaxSteps: 40,
          hardCap: 60,
          extensionLimit: 1,
          extensionsUsed: 1,
        },
      },
      stepsCompleted: 40,
    }
  );
  assert(
    migratedDefaultBudget.extensionLimit === 3 && migratedDefaultBudget.extensionsUsed === 1,
    "resumed non-explicit step budget did not adopt the current bounded default"
  );
  assert(
    shouldEvaluateResumeBoundary(
      { resume: "existing-session" },
      { stepsCompleted: 40 },
      migratedDefaultBudget
    ),
    "a resumed session at its consumed boundary did not request bounded capacity before the loop"
  );
  assert(
    !shouldEvaluateResumeBoundary(
      { resume: "existing-session" },
      { stepsCompleted: migratedDefaultBudget.hardCap },
      { ...migratedDefaultBudget, currentMaxSteps: migratedDefaultBudget.hardCap }
    ),
    "a resumed session attempted to exceed its dynamic hard cap"
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

  const repairBudget = createStepBudgetState(
    {
      provider: "localllm",
      maxSteps: 30,
      dynamicSteps: "on",
      dynamicStepExtensionLimit: 2,
      scsActive: false,
    },
    { meta: {}, stepsCompleted: 0 }
  );
  const repairDecision = decideStepBudgetExtension({
    config: { scsActive: false, commandCwd: "/tmp/workspace" },
    budget: repairBudget,
    step: 29,
    state: {
      messages: [
        toolMessage({
          toolName: "run_command",
          ok: false,
          exitCode: 1,
          args: { command: "python -m unittest discover -s tests" },
          stderr: "AssertionError: expected calibrated values",
        }),
        toolMessage({
          toolName: "apply_patch",
          ok: false,
          reason: "Patch search text was not found in analysis.py.",
        }),
        toolMessage({
          toolName: "read_file",
          ok: true,
          args: { path: "analysis.py" },
          path: "analysis.py",
        }),
        toolMessage({
          toolName: "read_file",
          ok: false,
          blocked: true,
          category: "repeated-read-only-call",
          reason: "The same static discovery call already ran once.",
        }),
      ],
    },
    events: [
      { type: "file.changed", data: { path: "analysis.py" } },
      ...Array.from({ length: 30 }, (_, index) => ({
        type: index % 2 === 0 ? "snapshot.captured" : "model.requested",
        data: {},
      })),
      { type: "tool.completed", data: { toolName: "run_command", exitCode: 1 } },
      { type: "tool.failed", data: { toolName: "apply_patch" } },
      { type: "tool.blocked", data: { toolName: "read_file" } },
    ],
  });
  assert(
    repairDecision.approved && repairDecision.extraSteps > 0,
    `budget gate denied an active repair after concrete file progress: ${repairDecision.reason}`
  );

  const repeatedDiscoveryMessages = [
    "ls -la ../Musia",
    "ls -la ../LALACHAN",
    "ls -la /tmp/lazyedit",
    "ls -la ../Musia",
    "ls -la ../LALACHAN",
    "ls -la /tmp/lazyedit",
    "ls -la ../Musia",
    "ls -la ../LALACHAN",
  ].map((command) =>
    toolMessage({
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout: "same static listing",
    })
  );
  const repeatedSummary = summarizeRepeatedStaticDiscovery(
    repeatedDiscoveryMessages.map((message) => JSON.parse(message.content))
  );
  assert(repeatedSummary.duplicateCount >= 3, "static discovery repetition was not detected");
  const repeatedDiscoveryDecision = decideStepBudgetExtension({
    config: { scsActive: true },
    budget: createStepBudgetState(
      { provider: "localllm", maxSteps: 12, dynamicSteps: "on", dynamicStepExtensionLimit: 2, scsActive: true },
      { meta: {}, stepsCompleted: 0 }
    ),
    step: 11,
    state: { messages: repeatedDiscoveryMessages },
    events: repeatedDiscoveryMessages.map(() => ({ type: "tool.completed", data: {} })),
  });
  assert(
    !repeatedDiscoveryDecision.approved && /repeated|loop/i.test(repeatedDiscoveryDecision.reason),
    "budget gate extended a static discovery loop"
  );
  const staticOnlyDecision = decideStepBudgetExtension({
    config: { scsActive: true, commandCwd: "/tmp/workspace" },
    budget: createStepBudgetState(
      { provider: "localllm", maxSteps: 12, dynamicSteps: "on", dynamicStepExtensionLimit: 2, scsActive: true },
      { meta: {}, stepsCompleted: 0 }
    ),
    step: 11,
    state: {
      messages: [
        toolMessage({ toolName: "read_file", ok: true, args: { path: "README.md" }, path: "README.md" }),
        toolMessage({ toolName: "search_files", ok: true, args: { path: ".", query: "workflow" }, path: "." }),
      ],
    },
    events: [],
  });
  assert(!staticOnlyDecision.approved, "budget gate treated static discovery alone as implementation progress");

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

  const resumed = await runAgent({
    ...config,
    goal: "Create notes/explicit-resume-budget.md with one concise line.",
    resume: run.sessionId,
    sessionId: run.sessionId,
    maxSteps: 2,
    dynamicSteps: "off",
    runtimePatch: { maxSteps: 2, dynamicSteps: "off" },
    expectedRuntimeRevision: state.meta?.runtimeConfig?.revision,
  });
  assert(!resumed.stopped, "explicit bounded resume stopped before completing its simple task");
  const resumedEvents = await store.loadEvents();
  const resumedBudget = resumedEvents.filter((event) => event.type === "budget.initialized").at(-1)?.data;
  assert(resumedBudget?.initialMaxSteps === 2, "runAgent did not apply explicit resumed max-steps as the initial budget");
  assert(resumedBudget?.currentMaxSteps === 2, "runAgent inherited an older expanded budget over explicit resumed max-steps");
  assert(resumedBudget?.extensionsUsed === 0, "runAgent retained stale extension usage after an explicit resumed max-steps patch");
  assert(resumedBudget?.resetFromExplicitOverride === true, "runAgent did not record the explicit budget reset boundary");

  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log("smoke-dynamic-step-budget ok");
} catch (error) {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  console.error(error);
  process.exit(1);
}
