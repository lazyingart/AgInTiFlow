#!/usr/bin/env node
import crypto from "node:crypto";
import assertStrict from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSessionRunLock, runAgent } from "../src/agent-runner.js";
import { RESEARCH_VERSION } from "../src/deep-research.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { classifyCommand, evaluateCommandPolicy } from "../src/command-policy.js";
import { createToolContract } from "../src/tool-contract.js";
import {
  browserSubmitFinishIssue,
  isRecoverableShellToolResult,
  isSuspiciousBroadBrowserToolResult,
  shouldActivateScs,
  shouldReviewToolResult,
} from "../src/scs-controller.js";
import {
  ambiguousDeclarationTokenPatchBlock,
  ambiguousPythonMainGuardPatchBlock,
  announceConvergenceOutputPhase,
  applyConcreteContinuationStepBudgetBoundary,
  applyContinuationContractTransition,
  artifactValidationAcceptanceIsCurrent,
  artifactValidationFinishBlock,
  artifactValidationScopeBlock,
  buildConstrainedRecoveryRequest,
  buildFailedTestRecoveryPacket,
  buildKnownConstrainedPhasePlan,
  buildTaskOwnedCommitCommand,
  buildTaskOwnedHeadRestoreCommand,
  changedGitStatusPaths,
  bindPatchContextRepairArguments,
  canonicalizeVerifiedArtifactCompletion,
  completedDeepResearchReuse,
  completionTaskContract,
  convergenceSuppressedToolNames,
  completionEvidenceNeedsCommand,
  completionRepairMutationRequirement,
  compactFailedTestEvidence,
  consumeGeneratedArtifactProducerDiagnosticRead,
  consumePatchContextRefreshRead,
  continuationAddsConcreteRequirement,
  documentSourceMaterialMutationBlock,
  documentQualityCommitAssessment,
  derivePatchContextAnchor,
  enqueueFailedTestRepairInstruction,
  failedTestWorkspaceDiagnosticReadPaths,
  failedTestRequiresCleanRepositoryState,
  failedTestRepairPatchBlock,
  failedTestSpecificationMutationBlock,
  failedTestAliasedIndexComparisons,
  failedTestIndexComparisons,
  failedTestLiteralOperands,
  failedTestMembershipPredicates,
  failedTestMockBehaviorContract,
  groundedDeclarationPatchFromPartialFile,
  generatedArtifactProducerDiagnosticLineAnchor,
  isCompletedContinuationNoop,
  isSubstantiveTestCommand,
  mergeDurableGitEvidence,
  nextStepRuntimeConfig,
  patchContextRefreshDecision,
  patchContextReplacementScopeIssue,
  patchContextScopeMismatchAttemptCount,
  parseGitPorcelainStatus,
  pythonMainGuardOrderDefects,
  projectAcceptanceFromMarkdown,
  prematureRequestedArtifactCommitBlock,
  projectTestVerificationFinishBlock,
  prospectivePythonExactPatchSyntaxBlock,
  preservesCurrentTaskBoundary,
  completionExternalBlockerCanClose,
  pythonTopLevelDefinitionDuplicates,
  recordCanonicalGeneratedOutputProgress,
  recordAlreadyCommittedRepositoryRepair,
  recordDurableEvidenceCategories,
  recordProjectVerificationOutcome,
  repositoryStateInspectionCommand,
  recordExactOutputProgress,
  recordStaticDiscoveryProgress,
  recoverProducerDiagnosticEvidencePatch,
  resetGoalScopedRuntimeState,
  resetSameTaskExecutionContract,
  resetStaticDiscoveryAfterContextLoss,
  toolResultWorkspacePath,
  runtimeMessagesSinceLatestContinuationBoundary,
  shellDiagnosticHint,
  rememberCompletedDeepResearch,
  forbiddenCurrentTestRerunBlock,
  unchangedFailedTestRerunBlock,
  repeatedNoProgressToolBlock,
  redundantCadValidationAliasPatchBlock,
  regressiveInversePatchBlock,
  repeatedSuccessfulMutationBlock,
  repeatedStaticToolBlock,
  reopenedArtifactRepairPending,
  shouldResetStaticDiscoveryPhase,
  trimCommandOutput,
  testCommandCoversMutatedPath,
  updateGoalContract,
  validateMutatedPythonSourceQuality,
} from "../src/agent-runner.js";
import {
  augmentScsTaskContractWithProjectVerification,
  buildScsEvidenceLedger,
  deriveScsTaskContract,
  evaluateScsEvidence,
  inferGitActionsFromCommand,
  inferSuccessfulGitActionsFromCommandResult,
  successfulGitCommitProvesFileMutation,
  parseExplicitExitStatus,
  parseNonMutatingExitStatusWrapper,
  evaluateScsSemanticContract,
} from "../src/scs-evidence.js";
import {
  repositoryGroundingState,
} from "../src/progressive-tool-selection.js";
import {
  createStepBudgetState,
  decideStepBudgetExtension,
  isStaticDiscoveryToolCall,
  staticToolCallSignature,
  normalizeDynamicStepsMode,
  shouldEvaluateResumeBoundary,
  summarizeStagnantValidationLoop,
  summarizeRepeatedStaticDiscovery,
} from "../src/step-budget-controller.js";
import { SessionStore } from "../src/session-store.js";
import { recommendedMaxStepsForTask } from "../src/engineering-guidance.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const customVerifierSemanticEvidence = evaluateScsSemanticContract(
  {},
  {
    events: [
      {
        type: "tool.completed",
        data: {
          toolName: "inspect_project",
          ok: true,
          testFiles: [{ path: "src/test/java/example/ServiceTest.java" }],
        },
      },
      {
        type: "file.changed",
        data: { path: "src/main/java/example/Service.java" },
      },
      {
        type: "tool.completed",
        data: {
          toolName: "run_command",
          ok: true,
          exitCode: 0,
          args: { command: "scripts/test.sh" },
          projectTest: {
            command: "scripts/test.sh",
            passed: true,
            mutationRevision: 4,
          },
        },
      },
    ],
  }
);
assertStrict.equal(
  customVerifierSemanticEvidence.ok === true &&
    customVerifierSemanticEvidence.projectTestVerification?.testRuns?.at(-1)
      ?.source === "project-verification-ledger",
  true,
  "SCS ignored a runtime-verified custom project test command after a source change"
);

const supersededOutputState = {
  goal: "Repair the service lifecycle.",
  meta: {
    goalContract: {
      version: 3,
      revision: 3,
      status: "active",
      taskGoal: "Repair the service lifecycle.",
      activeGoal: "Repair the service lifecycle.",
      history: [],
      lifecycle: [],
    },
    projectVerification: {
      requiredOutputs: ["verification_suite.py", "service_ctl.py"],
    },
    scs: {
      taskContract: {
        exactOutputPaths: [".aginti/verification/lifecycle/verification_suite.py", "service_ctl.py"],
      },
    },
    artifactProgress: {
      exactOutputPaths: ["verification_suite.py", "service_ctl.py"],
    },
  },
};
updateGoalContract(
  supersededOutputState,
  "Continue the same task. verification_suite.py does not exist and must not be rerun or created. Repair service_ctl.py.",
  { preserveTaskBoundary: true }
);
assert(
  !supersededOutputState.meta.projectVerification.requiredOutputs.includes("verification_suite.py"),
  "a current explicit exclusion did not prune retained verification outputs"
);
assert(
  !supersededOutputState.meta.scs.taskContract.exactOutputPaths.some((item) => item.includes("verification_suite.py")),
  "a current explicit exclusion did not prune retained SCS outputs"
);
assert(
  supersededOutputState.meta.artifactProgress === undefined,
  "artifact progress was not invalidated after its output contract was pruned"
);
assert(
  !completionTaskContract({ taskProfile: "devops" }, supersededOutputState).exactOutputPaths.some((item) =>
    item.includes("verification_suite.py")
  ),
  "completion rebuilt a stale output that the current request explicitly forbids"
);

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
  const readOnlyVerificationGoal = [
    "Continue this exact saved task in the same workspace. Do not start over and do",
    "not modify source_brief.md, measurements.csv, prompt.txt, or TASK.md.",
    "The prior run completed the task-owned repository repair. Run exactly `git status --short`.",
    "Do not rebuild, rewrite, recommit, or restore obsolete outputs when the worktree is clean.",
  ].join("\n");
  const readOnlyVerificationState = {
    goal: readOnlyVerificationGoal,
    messages: [
      toolMessage({
        toolName: "run_command",
        ok: true,
        exitCode: 0,
        args: { command: "git status --short" },
        stdout: "",
        goalRevision: 15,
        projectMutationRevision: 23,
      }),
    ],
    meta: {
      goalContract: {
        version: 3,
        revision: 15,
        activeGoalRevision: 15,
        taskGoal: "Create the editable deck, commit the focused repair, and verify it.",
        activeGoal: readOnlyVerificationGoal,
        currentRequest: readOnlyVerificationGoal,
        currentPreview: readOnlyVerificationGoal,
        history: [{ revision: 15, refreshExecutionContract: true }],
      },
      activeExecutionContract: {
        revision: 15,
        startedMutationRevision: 22,
        requiresWorkspaceMutation: false,
        requiresFileMutation: false,
        requiresSourceGrounding: false,
        requiredProjectCommands: ["git status --short"],
      },
      projectVerification: {
        mutationRevision: 23,
        requiredCommands: ["git status --short"],
      },
      durableGitActions: ["commit", "status"],
      durableGitEvidence: [
        { action: "commit", goalRevision: 13, mutationRevision: 19 },
        { action: "status", goalRevision: 15, mutationRevision: 23 },
      ],
    },
  };
  const readOnlyVerificationContract = completionTaskContract(
    { taskProfile: "slides" },
    readOnlyVerificationState
  );
  assert(
    readOnlyVerificationContract.requiresWorkspaceMutation === false &&
      readOnlyVerificationContract.requiresFileMutation === false &&
      readOnlyVerificationContract.requiresSourceGrounding === false,
    "a verification-only continuation inherited stale mutation requirements from retained task context"
  );
  assert(
    readOnlyVerificationContract.requiredGitActions.includes("commit") &&
      Number(readOnlyVerificationContract.requiredGitRevision || 0) === 0 &&
      Number(readOnlyVerificationContract.requiredGitMutationRevision || 0) === 0,
    "a verification-only continuation demanded a new commit instead of accepting retained same-task Git evidence"
  );
  const readOnlyGitEvaluation = evaluateScsEvidence(
    {
      ...readOnlyVerificationContract,
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredProjectCommands: [],
    },
    buildScsEvidenceLedger({ state: readOnlyVerificationState })
  );
  assert(
    readOnlyVerificationState.messages.every(
      (message) => !String(message.content || "").includes("git commit")
    ),
    "read-only compaction regression accidentally retained the historical commit message"
  );
  assert(
    readOnlyGitEvaluation.missingGitActions.length === 0,
    "a prior verified same-task commit did not satisfy a read-only completion continuation"
  );
  const cleanupOnlyGoal = [
    "Resume the same completed repair from its current verified state.",
    "Do not alter production source, tests, or commits.",
    "Remove only disposable .build output, confirm git status is clean, and finish.",
  ].join(" ");
  const cleanupOnlyState = structuredClone(readOnlyVerificationState);
  cleanupOnlyState.goal = cleanupOnlyGoal;
  cleanupOnlyState.meta.goalContract.revision = 16;
  cleanupOnlyState.meta.goalContract.activeGoalRevision = 16;
  cleanupOnlyState.meta.goalContract.activeGoal = cleanupOnlyGoal;
  cleanupOnlyState.meta.goalContract.currentRequest = cleanupOnlyGoal;
  cleanupOnlyState.meta.goalContract.currentPreview = cleanupOnlyGoal;
  cleanupOnlyState.meta.goalContract.history = [
    { revision: 16, refreshExecutionContract: true },
  ];
  cleanupOnlyState.meta.activeExecutionContract = {
    revision: 16,
    startedMutationRevision: 23,
    requiresWorkspaceMutation: true,
    requiresFileMutation: false,
    requiresSourceGrounding: false,
    requiredProjectCommands: [],
  };
  const cleanupOnlyContract = completionTaskContract(
    { taskProfile: "java" },
    cleanupOnlyState
  );
  const cleanupFileEvidence = cleanupOnlyContract.requiredEvidence.find(
    (item) => item.category === "file"
  );
  const cleanupCommandEvidence = cleanupOnlyContract.requiredEvidence.find(
    (item) => item.category === "command"
  );
  assert(
    cleanupOnlyContract.requiresWorkspaceMutation === true &&
      cleanupOnlyContract.requiresFileMutation === false &&
      cleanupOnlyContract.requiresSourceGrounding === false &&
      Number(cleanupFileEvidence?.minimumGoalRevision || 0) === 0 &&
      Number(cleanupCommandEvidence?.minimumGoalRevision || 0) === 16 &&
      Number(cleanupOnlyContract.requiredGitRevision || 0) === 0 &&
      Number(cleanupOnlyContract.requiredGitMutationRevision || 0) === 0,
    "a disposable cleanup-only continuation demanded a fresh source edit or commit"
  );

  const runLockConfig = {
    sessionsDir: path.join(tempRoot, "run-lock-sessions"),
  };
  const releaseFirstRunLock = await acquireSessionRunLock(
    runLockConfig,
    "same-session-run-lock"
  );
  let concurrentRunLockError = null;
  try {
    await acquireSessionRunLock(runLockConfig, "same-session-run-lock");
  } catch (error) {
    concurrentRunLockError = error;
  }
  assert(
    concurrentRunLockError?.code === "SESSION_RUN_ACTIVE" &&
      concurrentRunLockError?.ownerPid === process.pid,
    "a concurrent resume was allowed to acquire the same durable session run lease"
  );
  await releaseFirstRunLock();
  const releaseRecoveredRunLock = await acquireSessionRunLock(
    runLockConfig,
    "same-session-run-lock"
  );
  await releaseRecoveredRunLock();
  assert(
    !(await fs
      .stat(
        path.join(
          runLockConfig.sessionsDir,
          "same-session-run-lock",
          ".agent-run.lock"
        )
      )
      .then(() => true)
      .catch(() => false)),
    "the durable session run lease was not released after the owner finished"
  );
  assert(
    pythonTopLevelDefinitionDuplicates(
      "def start():\n    return 1\n\ndef start():\n    return 2\n"
    )[0]?.name === "start",
    "duplicate top-level Python functions were not detected"
  );
  assert(
    pythonTopLevelDefinitionDuplicates(
      "from typing import overload\n\n@overload\ndef parse(value: str) -> str: ...\n\n@overload\ndef parse(value: int) -> int: ...\n\ndef parse(value):\n    return value\n"
    ).length === 0,
    "legitimate Python overload declarations were treated as duplicate implementations"
  );
  const earlyMainGuardSource = [
    "def main():",
    "    return start_service()",
    "",
    "if __name__ == '__main__':",
    "    raise SystemExit(main())",
    "",
    "def start_service():",
    "    return 0",
    "",
  ].join("\n");
  const earlyMainGuardDefects = pythonMainGuardOrderDefects(earlyMainGuardSource);
  assert(
    earlyMainGuardDefects.length === 1 &&
      earlyMainGuardDefects[0].guardLine === 4 &&
      earlyMainGuardDefects[0].calledLater[0]?.name === "start_service" &&
      earlyMainGuardDefects[0].guardSearch.includes("raise SystemExit(main())") &&
      earlyMainGuardDefects[0].repairSearch.includes("def start_service"),
    "an executable Python main guard before a required declaration was not diagnosed"
  );
  await fs.writeFile(
    path.join(workspace, "entrypoint-order.py"),
    earlyMainGuardSource,
    "utf8"
  );
  const entrypointOrderState = {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        testRuns: [{
          command: "python test_entrypoint_order.py",
          mutationRevision: 0,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "python-entrypoint-order",
          failureSummary: "NameError: start_service is not defined",
        }],
      },
      failedTestDiagnostic: {
        packetVersion: 17,
        mutationRevision: 0,
        failureSignature: "python-entrypoint-order",
        focuses: [{
          kind: "python-main-guard-order",
          path: "entrypoint-order.py",
          directSearch: earlyMainGuardDefects[0].repairSearch,
          calledLater: earlyMainGuardDefects[0].calledLater,
        }],
      },
    },
  };
  assert(
    (await failedTestRepairPatchBlock(
      entrypointOrderState,
      "apply_patch",
      {
        path: "entrypoint-order.py",
        search: earlyMainGuardDefects[0].repairSearch,
        replace:
          earlyMainGuardDefects[0].repairSearch +
          "# The guard should eventually move below start_service.\n",
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-nonrepairing-patch",
    "a comment-only patch was allowed to leave the Python entrypoint-order defect active"
  );
  assert(
    (await failedTestRepairPatchBlock(
      entrypointOrderState,
      "apply_patch",
      {
        path: "entrypoint-order.py",
        search: earlyMainGuardDefects[0].repairSearch,
        replace: [
          "def start_service():",
          "    return 0",
          "",
          "if __name__ == '__main__':",
          "    raise SystemExit(main())",
          "",
        ].join("\n"),
      },
      { commandCwd: workspace }
    )) === null,
    "a transaction that moved the Python main guard below the required declaration was blocked"
  );
  assert(
    pythonMainGuardOrderDefects(
      [
        "def start_service():",
        "    return 0",
        "",
        "def main():",
        "    return start_service()",
        "",
        "if __name__ == '__main__':",
        "    raise SystemExit(main())",
        "",
      ].join("\n")
    ).length === 0,
    "a final Python main guard was incorrectly treated as an execution-order defect"
  );
  const duplicateSource = [
    "import os",
    "",
    "def status_service():",
    "    return 'old'",
    "",
    "def status_service():",
    "    return 'current'",
    "",
    "def main():",
    "    return status_service()",
    "",
    "if __name__ == '__main__':",
    "    raise SystemExit(main())",
    "",
  ].join("\n");
  const canonicalDuplicateSource = [
    "import os",
    "",
    "def status_service():",
    "    return 'current'",
    "",
    "def main():",
    "    return status_service()",
    "",
    "if __name__ == '__main__':",
    "    raise SystemExit(main())",
    "",
  ].join("\n");
  await fs.writeFile(path.join(workspace, "duplicate-source.py"), duplicateSource, "utf8");
  const duplicateRepairState = {
    meta: {
      projectVerification: {
        mutationRevision: 1,
        lastMutation: { revision: 1, paths: ["duplicate-source.py"] },
        discoveredTests: ["duplicate-source.py"],
        testRuns: [{
          command: "python test_duplicate_source.py",
          mutationRevision: 1,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "python-duplicate-source",
          failureSummary: "duplicate top-level production declarations remain",
        }],
      },
    },
  };
  const duplicatePacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace },
    duplicateRepairState
  );
  const duplicateFocus = duplicateRepairState.meta.failedTestDiagnostic.focuses.find(
    (focus) => focus.kind === "python-duplicate-top-level-definition"
  );
  assert(
    duplicatePacket.content.includes("Duplicate top-level Python declarations") &&
      duplicateFocus?.directSearch === duplicateSource &&
      duplicateFocus?.duplicateDeclarations?.[0]?.name === "status_service",
    "duplicate production declarations were not promoted into a focused failed-test repair"
  );
  const dependencyRecoveryWorkspace = path.join(tempRoot, "dependency-recovery-workspace");
  await fs.mkdir(path.join(dependencyRecoveryWorkspace, "config"), { recursive: true });
  await fs.mkdir(path.join(dependencyRecoveryWorkspace, "raw"), { recursive: true });
  await fs.mkdir(path.join(dependencyRecoveryWorkspace, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(dependencyRecoveryWorkspace, "analysis.py"),
    [
      "from pathlib import Path",
      "import json",
      "",
      "ROOT = Path(__file__).resolve().parent",
      "config = json.loads((ROOT / 'config' / 'experiment.json').read_text())",
      "for source_file in ('run_a.csv', 'run_b.csv'):",
      "    print((ROOT / 'raw' / source_file).read_text())",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(dependencyRecoveryWorkspace, "tests", "test_analysis.py"),
    "from analysis import config\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(dependencyRecoveryWorkspace, "config", "experiment.json"),
    '{"offset":10}\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(dependencyRecoveryWorkspace, "raw", "run_a.csv"),
    "sample,signal\nA,100\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(dependencyRecoveryWorkspace, "raw", "run_b.csv"),
    "sample,signal\nB,90\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(dependencyRecoveryWorkspace, "raw", "unrelated.csv"),
    "private,unrelated\nno,1\n",
    "utf8"
  );
  const dependencyRecoveryState = {
    meta: {
      projectVerification: {
        mutationRevision: 2,
        lastMutation: {
          revision: 2,
          toolName: "apply_patch",
          paths: ["analysis.py"],
        },
        discoveredTests: ["tests/test_analysis.py"],
        testRuns: [{
          command: "python analysis.py",
          mutationRevision: 2,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "source-dependency-schema-mismatch",
          failureSummary: "File \"analysis.py\", line 7, in <module>: KeyError: signal_mv",
        }],
      },
      toolLoop: {
        recent: [
          "config/experiment.json",
          "raw/run_a.csv",
          "raw/run_b.csv",
          "raw/unrelated.csv",
        ].map((readPath) => ({
          toolName: "read_file",
          path: readPath,
          ok: true,
          blocked: false,
        })),
      },
    },
  };
  const dependencyRecoveryPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: dependencyRecoveryWorkspace },
    dependencyRecoveryState
  );
  assert(
    [
      "analysis.py",
      "config/experiment.json",
      "raw/run_a.csv",
      "raw/run_b.csv",
    ].every((item) => dependencyRecoveryPacket.paths.includes(item)) &&
      !dependencyRecoveryPacket.paths.includes("raw/unrelated.csv") &&
      JSON.stringify(dependencyRecoveryPacket.repairPaths) === JSON.stringify(["analysis.py"]),
    `failed-test recovery dropped previously read immutable dependencies or widened mutation scope: ${JSON.stringify(dependencyRecoveryPacket)}`
  );
  const baselineWorkspace = path.join(tempRoot, "baseline-recovery-workspace");
  await fs.mkdir(baselineWorkspace, { recursive: true });
  const trackedBaselineSource = [
    "#!/usr/bin/env python3",
    "from pathlib import Path",
    "",
    "PROJECT_ROOT = Path(__file__).resolve().parent",
    "",
    "def build_service_command(root: Path):",
    "    return [str(root / 'service')]",
    "",
    "def launch_service(command):",
    "    return command",
    "",
    "def wait_until_healthy(process):",
    "    return bool(process)",
    "",
    "def start_service(root: Path):",
    "    return wait_until_healthy(launch_service(build_service_command(root)))",
    "",
    "def main():",
    "    return 0 if start_service(PROJECT_ROOT) else 1",
    "",
    "if __name__ == '__main__':",
    "    raise SystemExit(main())",
    "",
  ].join("\n");
  const truncatedTrackedSource = [
    "def start_service(root: Path):",
    "    return True",
    "",
    "if __name__ == '__main__':",
    "    raise SystemExit(main())",
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(baselineWorkspace, "baseline-recovery.py"),
    trackedBaselineSource,
    "utf8"
  );
  for (const args of [
    ["init"],
    ["config", "user.email", "smoke@example.invalid"],
    ["config", "user.name", "AgInTi Smoke"],
    ["config", "commit.gpgsign", "false"],
    ["add", "baseline-recovery.py"],
    ["commit", "-m", "baseline"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: baselineWorkspace,
      encoding: "utf8",
    });
    assert(
      result.status === 0,
      `failed to prepare tracked baseline recovery fixture: git ${args.join(" ")} ${result.stderr || ""}`
    );
  }
  await fs.writeFile(
    path.join(baselineWorkspace, "baseline-recovery.py"),
    truncatedTrackedSource,
    "utf8"
  );
  const baselineRecoveryState = {
    meta: {
      projectVerification: {
        mutationRevision: 3,
        lastMutation: { revision: 3, paths: ["baseline-recovery.py"] },
        discoveredTests: ["baseline-recovery.py"],
        testRuns: [{
          command: "python baseline-recovery.py",
          mutationRevision: 3,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "python-tracked-source-regression",
          failureSummary: "NameError: name 'Path' is not defined",
        }],
      },
    },
  };
  const baselinePacket = await buildFailedTestRecoveryPacket(
    { commandCwd: baselineWorkspace },
    baselineRecoveryState
  );
  const baselineFocus = baselineRecoveryState.meta.failedTestDiagnostic.focuses.find(
    (focus) => focus.kind === "python-git-baseline-recovery"
  );
  assert(
    baselinePacket.content.includes("Version-controlled source regression") &&
      baselinePacket.content.includes("Exact version-controlled baseline") &&
      baselineFocus?.directSearch === truncatedTrackedSource &&
      baselineFocus?.baselineSource === trackedBaselineSource &&
      baselineFocus?.missingDeclarations?.some(
        (item) => item.name === "build_service_command"
      ) &&
      baselineFocus?.missingDeclarations?.some((item) => item.name === "main"),
    "a severely truncated task-mutated tracked Python source was not promoted to exact baseline recovery"
  );
  const authoritativeRestoreWorkspace = path.join(
    tempRoot,
    "authoritative-test-restore-workspace"
  );
  const authoritativeTestPath = "src/test/java/example/AuthoritativeTest.java";
  const authoritativeSourcePath = "src/main/java/example/Service.java";
  const authoritativeTestBaseline = [
    "package example;",
    "public final class AuthoritativeTest {",
    "    static void verifiesContract() { Service.answer(); }",
    "}",
    "",
  ].join("\n");
  const authoritativeTestDamaged = [
    "package example;",
    "public final class AuthoritativeTest {",
    "    static void answer() { throw new AssertionError(); }",
    "}",
    "",
  ].join("\n");
  await fs.mkdir(
    path.join(authoritativeRestoreWorkspace, path.dirname(authoritativeTestPath)),
    { recursive: true }
  );
  await fs.mkdir(
    path.join(authoritativeRestoreWorkspace, path.dirname(authoritativeSourcePath)),
    { recursive: true }
  );
  await fs.writeFile(
    path.join(authoritativeRestoreWorkspace, authoritativeTestPath),
    authoritativeTestBaseline,
    "utf8"
  );
  await fs.writeFile(
    path.join(authoritativeRestoreWorkspace, authoritativeSourcePath),
    "package example; public final class Service { }\n",
    "utf8"
  );
  for (const args of [
    ["init"],
    ["config", "user.email", "smoke@example.invalid"],
    ["config", "user.name", "AgInTi Smoke"],
    ["config", "commit.gpgsign", "false"],
    ["add", authoritativeTestPath, authoritativeSourcePath],
    ["commit", "-m", "baseline"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: authoritativeRestoreWorkspace,
      encoding: "utf8",
    });
    assert(
      result.status === 0,
      `failed to prepare authoritative-test restore fixture: git ${args.join(" ")} ${result.stderr || ""}`
    );
  }
  await fs.writeFile(
    path.join(authoritativeRestoreWorkspace, authoritativeTestPath),
    authoritativeTestDamaged,
    "utf8"
  );
  const authoritativePacketState = {
    goal: "Repair production while preserving the existing authoritative test.",
    meta: {
      goalContract: {
        taskGoal: "Repair production while preserving the existing authoritative test.",
      },
      projectVerification: {
        mutationRevision: 3,
        commandRuns: [
          {
            command: `git checkout HEAD -- '${authoritativeTestPath}'`,
            ok: true,
            mutationRevision: 1,
          },
        ],
        mutationHistory: [
          {
            revision: 1,
            toolName: "run_command",
            paths: [],
            commandCategory: "destructive",
          },
          {
            revision: 2,
            toolName: "apply_patch",
            paths: [authoritativeTestPath],
            patch: {
              afterContentSha256: crypto
                .createHash("sha256")
                .update(authoritativeTestDamaged)
                .digest("hex"),
            },
          },
          {
            revision: 3,
            toolName: "apply_patch",
            paths: [authoritativeSourcePath],
          },
        ],
        discoveredTests: [authoritativeTestPath, authoritativeSourcePath],
        testRuns: [
          {
            command: "scripts/test.sh",
            mutationRevision: 3,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "authoritative-test-damaged-by-agent",
            failureSummary: "cannot find symbol: method answer() in Service",
          },
        ],
      },
    },
  };
  const authoritativePacket = await buildFailedTestRecoveryPacket(
    { commandCwd: authoritativeRestoreWorkspace },
    authoritativePacketState
  );
  assertStrict.deepEqual(
    authoritativePacket.authoritativeTestRestores,
    [
      {
        path: authoritativeTestPath,
        restoredRevision: 1,
        agentMutationRevision: 2,
        afterContentSha256: crypto
          .createHash("sha256")
          .update(authoritativeTestDamaged)
          .digest("hex"),
        currentSha256: crypto
          .createHash("sha256")
          .update(authoritativeTestDamaged)
          .digest("hex"),
        baselineSha256: crypto
          .createHash("sha256")
          .update(authoritativeTestBaseline)
          .digest("hex"),
        currentBytes: Buffer.byteLength(authoritativeTestDamaged, "utf8"),
        baselineBytes: Buffer.byteLength(authoritativeTestBaseline, "utf8"),
      },
    ],
    "failed-test packet did not retain a hash-bound restore candidate for a same-session damaged authoritative test"
  );
  const authoritativeSourceBaseline =
    "package example; public final class Service { }\n";
  const authoritativeSourceDamaged =
    "package example; public final class Service { static int wrong() { return -1; } }\n";
  await fs.writeFile(
    path.join(authoritativeRestoreWorkspace, authoritativeSourcePath),
    authoritativeSourceDamaged,
    "utf8"
  );
  const explicitHeadRestoreState = {
    goal: `Restore ${authoritativeSourcePath} exactly to HEAD.`,
    meta: {
      goalContract: {
        revision: 4,
        currentRequest: `Restore ${authoritativeSourcePath} exactly to HEAD.`,
      },
      activeExecutionContract: {
        revision: 4,
        requiresFileMutation: true,
        requiresSourceGrounding: true,
        baselineMutationRevision: 3,
        materialMutationRevision: 3,
      },
      projectVerification: {
        mutationRevision: 3,
        lastMutation: {
          revision: 3,
          paths: [authoritativeSourcePath],
        },
        mutationHistory: [
          {
            revision: 3,
            toolName: "apply_patch",
            paths: [authoritativeSourcePath],
          },
        ],
      },
    },
  };
  const explicitHeadRestoreConfig = nextStepRuntimeConfig(
    { commandCwd: authoritativeRestoreWorkspace },
    explicitHeadRestoreState
  );
  const expectedHeadRestoreCommand =
    `git checkout HEAD -- '${authoritativeSourcePath}'`;
  assert(
    explicitHeadRestoreConfig.completionFreshMutationRequired === true &&
      explicitHeadRestoreConfig.completionFreshMutationRestorePending === true &&
      explicitHeadRestoreConfig.completionFreshMutationNeedsSourceRead === false &&
      explicitHeadRestoreConfig.completionFreshMutationRestoreCommand ===
        expectedHeadRestoreCommand &&
      explicitHeadRestoreConfig.completionFreshMutationRestorePaths?.[0] ===
        authoritativeSourcePath,
    `an explicit dirty tracked HEAD restore did not become an exact constrained recovery phase: ${JSON.stringify({
      required: explicitHeadRestoreConfig.completionFreshMutationRequired,
      pending: explicitHeadRestoreConfig.completionFreshMutationRestorePending,
      needsRead: explicitHeadRestoreConfig.completionFreshMutationNeedsSourceRead,
      command: explicitHeadRestoreConfig.completionFreshMutationRestoreCommand,
      paths: explicitHeadRestoreConfig.completionFreshMutationRestorePaths,
      candidates: explicitHeadRestoreConfig.completionFreshMutationPaths,
    })}`
  );
  const explicitHeadRestoreWithFailureState = structuredClone(
    explicitHeadRestoreState
  );
  explicitHeadRestoreWithFailureState.meta.projectVerification.requiredCommands = [
    "scripts/test.sh",
  ];
  explicitHeadRestoreWithFailureState.meta.projectVerification.testRuns = [
    {
      command: "scripts/test.sh",
      mutationRevision: 3,
      privateMutationRevision: 0,
      passed: false,
      failureEvidenceVersion: 2,
      failureSignature: "retained-source-failure",
      failureSummary: "retained source failure",
    },
  ];
  const explicitHeadRestoreWithFailureConfig = nextStepRuntimeConfig(
    { commandCwd: authoritativeRestoreWorkspace },
    explicitHeadRestoreWithFailureState
  );
  const explicitHeadRestoreWithFailurePhase = buildKnownConstrainedPhasePlan(
    { commandCwd: authoritativeRestoreWorkspace },
    explicitHeadRestoreWithFailureState,
    explicitHeadRestoreWithFailureConfig
  );
  assert(
    explicitHeadRestoreWithFailurePhase?.mode === "fresh-source-mutation" &&
      explicitHeadRestoreWithFailurePhase.command === expectedHeadRestoreCommand,
    "a retained failed test preempted an explicit provenance-bound HEAD restore"
  );
  const explicitHeadRestoreResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: expectedHeadRestoreCommand },
    projectMutationPaths: [authoritativeSourcePath],
  };
  recordProjectVerificationOutcome(
    explicitHeadRestoreState,
    explicitHeadRestoreResult,
    {
      commandCwd: authoritativeRestoreWorkspace,
      ...explicitHeadRestoreConfig,
    }
  );
  assert(
    explicitHeadRestoreResult.explicitHeadRestore === true &&
      explicitHeadRestoreState.meta.projectVerification.mutationRevision === 4 &&
      explicitHeadRestoreState.meta.activeExecutionContract.materialMutationRevision === 4 &&
      explicitHeadRestoreState.meta.activeExecutionContract.materialMutationPaths.includes(
        authoritativeSourcePath
      ),
    "a successful exact HEAD restore did not satisfy the active material-mutation contract"
  );
  assert(
    buildTaskOwnedHeadRestoreCommand([authoritativeSourcePath]) ===
      expectedHeadRestoreCommand &&
      buildTaskOwnedHeadRestoreCommand(["../outside.java"]) === "" &&
      buildTaskOwnedHeadRestoreCommand([".private/token.txt"]) === "",
    "task-owned HEAD restore command construction accepted an unsafe path"
  );
  await fs.writeFile(
    path.join(authoritativeRestoreWorkspace, authoritativeSourcePath),
    authoritativeSourceBaseline,
    "utf8"
  );
  const baselineTracebackRecoveryState = {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        discoveredTests: [],
        testRuns: [{
          command: "python -m unittest discover -s tests -v",
          mutationRevision: 0,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "python-tracked-source-regression-after-state-loss",
          failureSummary:
            `File "${path.join(baselineWorkspace, "baseline-recovery.py")}", line 1, in <module>\n` +
            "NameError: name 'Path' is not defined",
        }],
      },
    },
  };
  await buildFailedTestRecoveryPacket(
    { commandCwd: baselineWorkspace },
    baselineTracebackRecoveryState
  );
  assert(
    baselineTracebackRecoveryState.meta.failedTestDiagnostic.focuses.some(
      (focus) =>
        focus.kind === "python-git-baseline-recovery" &&
        focus.path === "baseline-recovery.py"
    ),
    "an exact traceback-bound tracked source could not recover its baseline after durable mutation metadata was lost"
  );
  const baselineWithoutHelper = trackedBaselineSource.replace(
    "def wait_until_healthy(process):\n    return bool(process)\n\n",
    ""
  );
  assert(
    (await failedTestRepairPatchBlock(
      baselineRecoveryState,
      "apply_patch",
      {
        path: "baseline-recovery.py",
        search: truncatedTrackedSource,
        replace: baselineWithoutHelper,
      },
      { commandCwd: baselineWorkspace }
    ))?.category === "failed-test-nonrepairing-patch",
    "baseline reconstruction was allowed to omit a tracked helper declaration"
  );
  assert(
    (await failedTestRepairPatchBlock(
      baselineRecoveryState,
      "apply_patch",
      {
        path: "baseline-recovery.py",
        search: truncatedTrackedSource,
        replace: trackedBaselineSource.slice(
          trackedBaselineSource.indexOf("def build_service_command")
        ),
      },
      { commandCwd: baselineWorkspace }
    ))?.category === "failed-test-regression",
    "baseline reconstruction was allowed to discard the tracked module preamble"
  );
  assert(
    (await failedTestRepairPatchBlock(
      baselineRecoveryState,
      "apply_patch",
      {
        path: "baseline-recovery.py",
        search: truncatedTrackedSource,
        replace: trackedBaselineSource,
      },
      { commandCwd: baselineWorkspace }
    )) === null,
    "a complete coherent tracked baseline reconstruction was blocked"
  );
  const harnessTestsDir = path.join(baselineWorkspace, "tests");
  await fs.mkdir(harnessTestsDir, { recursive: true });
  await fs.writeFile(
    path.join(baselineWorkspace, "service_ctl.py"),
    "raise SystemExit(0)\n",
    "utf8"
  );
  const brokenHarnessSource = [
    "import subprocess",
    "import sys",
    "import unittest",
    "from pathlib import Path",
    "",
    'SERVICE_CTL = "../service_ctl.py"',
    "",
    "class TestLifecycle(unittest.TestCase):",
    "    def test_start(self):",
    "        result = subprocess.run([sys.executable, SERVICE_CTL], capture_output=True)",
    "        self.assertEqual(result.returncode, 0)",
    "",
  ].join("\n");
  const repairedHarnessAssignment =
    'SERVICE_CTL = (Path(__file__).resolve().parent / "../service_ctl.py").resolve()';
  const harnessTestPath = path.join(harnessTestsDir, "test_service_lifecycle.py");
  await fs.writeFile(harnessTestPath, brokenHarnessSource, "utf8");
  const harnessRepairState = {
    meta: {
      projectVerification: {
        mutationRevision: 4,
        discoveredTests: ["tests/test_service_lifecycle.py"],
        testRuns: [{
          command: "python3 -m unittest discover -s tests -v",
          mutationRevision: 4,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "agent-created-test-harness-path",
          failureSummary:
            "File \"./tests/test_service_lifecycle.py\", line 11, in test_start -> " +
            "self.assertEqual(result.returncode, 0) Failure evidence: AssertionError: 2 != 0",
        }],
      },
    },
  };
  const harnessPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: baselineWorkspace },
    harnessRepairState
  );
  const harnessFocus = harnessRepairState.meta.failedTestDiagnostic.focuses.find(
    (focus) => focus.kind === "python-agent-test-harness-path"
  );
  assert(
    harnessPacket.content.includes("Agent-created test harness path") &&
      harnessFocus?.path === "tests/test_service_lifecycle.py" &&
      harnessFocus?.directSearch === 'SERVICE_CTL = "../service_ctl.py"' &&
      harnessFocus?.directReplacement === repairedHarnessAssignment &&
      harnessFocus?.expectedWorkspacePath === "service_ctl.py" &&
      harnessFocus?.testNames?.join(",") === "test_start" &&
      harnessFocus?.assertionCount === 1,
    "a Git-new Python test with a verifier-cwd launch defect was not isolated to its exact assignment"
  );
  assert(
    (await failedTestRepairPatchBlock(
      harnessRepairState,
      "apply_patch",
      {
        path: "tests/test_service_lifecycle.py",
        search: 'SERVICE_CTL = "../service_ctl.py"',
        replace: 'SERVICE_CTL = "service_ctl.py"',
      },
      { commandCwd: baselineWorkspace }
    ))?.category === "failed-test-nonrepairing-patch",
    "an arbitrary test-path edit bypassed the exact agent-created harness repair"
  );
  assert(
    (await failedTestRepairPatchBlock(
      harnessRepairState,
      "apply_patch",
      {
        path: "tests/test_service_lifecycle.py",
        search: 'SERVICE_CTL = "../service_ctl.py"',
        replace: repairedHarnessAssignment,
      },
      { commandCwd: baselineWorkspace }
    )) === null,
    "the exact cwd-independent agent-created test harness repair was blocked"
  );
  const foreignListener = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    foreignListener.once("error", reject);
    foreignListener.listen(0, "127.0.0.1", resolve);
  });
  try {
    const collisionPort = Number(foreignListener.address()?.port || 0);
    assert(collisionPort >= 1024, "failed to allocate the foreign-listener smoke port");
    await fs.writeFile(
      path.join(baselineWorkspace, "service_ctl.py"),
      [
        "from pathlib import Path",
        "",
        'GATEWAY = Path(__file__).resolve().parent / "gateway_service.py"',
        "raise SystemExit(0)",
        "",
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(baselineWorkspace, "gateway_service.py"),
      "print('sensor gateway fixture')\n",
      "utf8"
    );
    const portCollisionSource = [
      "import subprocess",
      "import sys",
      "import unittest",
      "from pathlib import Path",
      "",
      'SERVICE_CTL = (Path(__file__).resolve().parent / "../service_ctl.py").resolve()',
      "",
      "class TestLifecycle(unittest.TestCase):",
      "    def test_start(self):",
      `        first = subprocess.run([sys.executable, SERVICE_CTL, "start", "--port", "${collisionPort}"], capture_output=True)`,
      `        second = subprocess.run([sys.executable, SERVICE_CTL, "status", "--port", "${collisionPort}"], capture_output=True)`,
      "        self.assertEqual(first.returncode, 0)",
      "        self.assertEqual(second.returncode, 0)",
      "",
    ].join("\n");
    await fs.writeFile(harnessTestPath, portCollisionSource, "utf8");
    const portCollisionState = {
      meta: {
        projectVerification: {
          mutationRevision: 5,
          discoveredTests: ["tests/test_service_lifecycle.py"],
          testRuns: [{
            command: "python3 -m unittest discover -s tests -v",
            mutationRevision: 5,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "agent-created-test-foreign-port-collision",
            failureSummary:
              "test_start AssertionError: 1 != 0 while starting the task service",
          }],
        },
      },
    };
    const portCollisionPacket = await buildFailedTestRecoveryPacket(
      { commandCwd: baselineWorkspace },
      portCollisionState
    );
    const portCollisionFocus = portCollisionState.meta.failedTestDiagnostic.focuses.find(
      (focus) => focus.kind === "python-agent-test-foreign-port-collision"
    );
    assert(
      portCollisionPacket.content.includes("Foreign listener collision") &&
        portCollisionPacket.paths.includes("gateway_service.py") &&
        portCollisionFocus?.path === "tests/test_service_lifecycle.py" &&
        portCollisionFocus?.ports?.[0] === collisionPort &&
        portCollisionFocus?.portOccurrences === 2 &&
        portCollisionFocus?.listenerEvidence?.[0]?.ownership === "outside-task-workspace" &&
        portCollisionFocus?.testNames?.join(",") === "test_start" &&
        portCollisionFocus?.assertionCount === 2,
      "a foreign hard-coded port or its exact executable dependency was not retained for repair"
    );
    const dynamicPortSource = [
      "import socket",
      "import subprocess",
      "import sys",
      "import unittest",
      "from pathlib import Path",
      "",
      'SERVICE_CTL = (Path(__file__).resolve().parent / "../service_ctl.py").resolve()',
      "",
      "def free_port():",
      "    with socket.socket() as probe:",
      '        probe.bind(("127.0.0.1", 0))',
      "        return probe.getsockname()[1]",
      "",
      "class TestLifecycle(unittest.TestCase):",
      "    def test_start(self):",
      "        port = free_port()",
      "        first = subprocess.run([sys.executable, SERVICE_CTL, \"start\", \"--port\", str(port)], capture_output=True)",
      "        second = subprocess.run([sys.executable, SERVICE_CTL, \"status\", \"--port\", str(port)], capture_output=True)",
      "        self.assertEqual(first.returncode, 0)",
      "        self.assertEqual(second.returncode, 0)",
      "",
    ].join("\n");
    assert(
      (await failedTestRepairPatchBlock(
        portCollisionState,
        "apply_patch",
        {
          path: "tests/test_service_lifecycle.py",
          search: portCollisionSource,
          replace: dynamicPortSource.replace(
            "        self.assertEqual(second.returncode, 0)",
            "        self.assertTrue(True)"
          ),
        },
        { commandCwd: baselineWorkspace }
      ))?.category === "failed-test-regression",
      "foreign-port isolation was allowed to change the assertion-method contract"
    );
    assert(
      (await failedTestRepairPatchBlock(
        portCollisionState,
        "apply_patch",
        {
          path: "tests/test_service_lifecycle.py",
          search: portCollisionSource,
          replace: dynamicPortSource,
        },
        { commandCwd: baselineWorkspace }
      )) === null,
      "a complete dynamic-port rewrite of the Git-new test was blocked"
    );
  } finally {
    await new Promise((resolve) => foreignListener.close(resolve));
  }
  for (const args of [
    ["add", "service_ctl.py", "tests/test_service_lifecycle.py"],
    ["commit", "-m", "tracked harness boundary"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: baselineWorkspace,
      encoding: "utf8",
    });
    assert(
      result.status === 0,
      `failed to prepare tracked test-harness boundary: git ${args.join(" ")} ${result.stderr || ""}`
    );
  }
  const trackedHarnessState = structuredClone(harnessRepairState);
  trackedHarnessState.meta.projectVerification.testRuns[0].failureSignature =
    "tracked-test-harness-path";
  await buildFailedTestRecoveryPacket(
    { commandCwd: baselineWorkspace },
    trackedHarnessState
  );
  assert(
    !trackedHarnessState.meta.failedTestDiagnostic.focuses.some(
      (focus) =>
        focus.kind === "python-agent-test-harness-path" ||
        focus.kind === "python-agent-test-foreign-port-collision"
    ),
    "an agent-created test exception was incorrectly applied to a tracked authoritative test"
  );
  await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "tests", "test_traceback_packet.py"),
    "from pathlib import Path\n\ndef test_contract():\n    assert Path('duplicate-source.py').exists()\n",
    "utf8"
  );
  const tracebackPacketState = {
    meta: {
      projectVerification: {
        mutationRevision: 1,
        lastMutation: { revision: 1, paths: ["duplicate-source.py"] },
        discoveredTests: [],
        testRuns: [{
          command: "python3 -m unittest discover -s tests -v",
          mutationRevision: 1,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "traceback-file-recovery",
          failureSummary:
            `File "${path.join(workspace, "tests", "test_traceback_packet.py")}", line 4, in test_contract\n` +
            `File "${path.join(workspace, "duplicate-source.py")}", line 1, in <module>`,
        }],
      },
    },
  };
  const tracebackPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace },
    tracebackPacketState
  );
  assert(
    tracebackPacket.paths.includes("tests/test_traceback_packet.py") &&
      tracebackPacket.content.includes("### tests/test_traceback_packet.py"),
    "exact same-workspace test files named by a traceback were omitted when discovery metadata was empty"
  );
  const repeatedTracebackPacketState = structuredClone(tracebackPacketState);
  repeatedTracebackPacketState.meta.projectVerification.testRuns[0].failureSignature =
    "repeated-validator-traceback-file-recovery";
  repeatedTracebackPacketState.meta.projectVerification.testRuns[0].failureSummary =
    [
      `File "${path.join(workspace, "duplicate-source.py")}", line 1, in first`,
      `File "${path.join(workspace, "duplicate-source.py")}", line 2, in second`,
      `File "${path.join(workspace, "duplicate-source.py")}", line 3, in third`,
      `File "${path.join(workspace, "tests", "test_traceback_packet.py")}", line 4, in test_contract`,
    ].join("\n");
  const repeatedTracebackPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace },
    repeatedTracebackPacketState
  );
  assert(
    repeatedTracebackPacket.paths.includes("tests/test_traceback_packet.py"),
    "duplicate frames from one validator crowded the actual failing test out of recovery evidence"
  );
  const nestedTracebackSource = [
    "def write_manifest(items):",
    "    lines = []",
    "    for name, path in items:",
    '        lines.append(f"| {name} | {path.stat().st_size} |")',
    "    return lines",
    "",
    "def main():",
    "    return write_manifest([])",
    "",
    "main()",
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(workspace, "traceback-source.py"),
    nestedTracebackSource,
    "utf8"
  );
  const nestedTracebackState = {
    meta: {
      taskProfile: "cad",
      projectVerification: {
        taskProfile: "cad",
        mutationRevision: 7,
        lastMutation: { revision: 7, paths: ["traceback-source.py"] },
        discoveredTests: [],
        testRuns: [{
          command: "python3 validate.py --root .",
          mutationRevision: 7,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "nested-manifest-traceback",
          failureSummary: [
            'Failing tests: isolated manifest rebuild failed.',
            'File "./traceback-source.py", line 10, in <module> -> main()',
            'File "./traceback-source.py", line 8, in main -> return write_manifest([])',
            'File "./traceback-source.py", line 4, in write_manifest -> lines.append(f"| {name} | {path.stat().st_size} |")',
          ].join(" | "),
          failingTests: ["isolated manifest rebuild failed"],
        }],
      },
    },
  };
  const nestedTracebackPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace, taskProfile: "cad" },
    nestedTracebackState
  );
  const nestedTracebackFocus =
    nestedTracebackState.meta.failedTestDiagnostic.focuses[0];
  assert(
    nestedTracebackFocus?.kind === "failed-test-traceback-line" &&
      nestedTracebackFocus.path === "traceback-source.py" &&
      nestedTracebackFocus.decisiveLine === 4 &&
      nestedTracebackFocus.directSearch ===
        '        lines.append(f"| {name} | {path.stat().st_size} |")',
    `nested same-file traceback did not bind the deepest current source line: ${JSON.stringify(nestedTracebackFocus)}`
  );
  assert(
    !nestedTracebackState.meta.failedTestDiagnostic.focuses.some(
      (focus) => focus.kind === "generated-artifact-semantic-producer"
    ) &&
      nestedTracebackPacket.content.includes(
        "Current actionable traceback line in traceback-source.py (line 4)"
      ) &&
      nestedTracebackPacket.content.includes(
        "Exact current source context around traceback-source.py:4"
      ) &&
      nestedTracebackPacket.content.includes(
        '4:         lines.append(f"| {name} | {path.stat().st_size} |")'
      ),
    "the exact actionable traceback line or its bounded current-source context was omitted"
  );
  assert(
    (await failedTestRepairPatchBlock(
      nestedTracebackState,
      "apply_patch",
      {
        path: "traceback-source.py",
        search: nestedTracebackFocus.directSearch,
        replace: [
          "        if path.exists():",
          '            lines.append(f"| {name} | {path.stat().st_size} |")',
        ].join("\n"),
      },
      { commandCwd: workspace, taskProfile: "cad" }
    )) === null,
    "a syntactically valid repair at the deepest current traceback line was blocked"
  );
  assert(
    (await failedTestRepairPatchBlock(
      nestedTracebackState,
      "apply_patch",
      {
        path: "traceback-source.py",
        search: nestedTracebackFocus.directSearch,
        replace: nestedTracebackFocus.directSearch,
      },
      { commandCwd: workspace, taskProfile: "cad" }
    ))?.category === "failed-test-nonrepairing-patch",
    "an unchanged traceback-line repair was accepted as progress"
  );
  const nestedHelperTracebackSource = [
    "def sha256_file(path):",
    '    with path.open("rb") as fh:',
    "        return fh.read()",
    "",
    "def write_manifest(items):",
    "    lines = []",
    "    for name, path in items:",
    '        lines.append(f"| {name} | {path.stat().st_size} | {sha256_file(path)} |")',
    "    return lines",
    "",
    "def main():",
    "    return write_manifest([])",
    "",
    "main()",
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(workspace, "traceback-helper-source.py"),
    nestedHelperTracebackSource,
    "utf8"
  );
  const nestedHelperTracebackState = {
    meta: {
      taskProfile: "cad",
      projectVerification: {
        taskProfile: "cad",
        mutationRevision: 8,
        lastMutation: { revision: 8, paths: ["traceback-helper-source.py"] },
        discoveredTests: [],
        testRuns: [{
          command: "python3 validate.py --root .",
          mutationRevision: 8,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "nested-helper-manifest-traceback",
          failureSummary: [
            "Failing tests: isolated manifest rebuild failed.",
            'File "./traceback-helper-source.py", line 14, in <module> -> main()',
            'File "./traceback-helper-source.py", line 12, in main -> return write_manifest([])',
            'File "./traceback-helper-source.py", line 8, in write_manifest -> lines.append(f"| {name} | {path.stat().st_size} | {sha256_file(path)} |")',
            'File "./traceback-helper-source.py", line 2, in sha256_file -> with path.open("rb") as fh:',
          ].join(" | "),
          failingTests: ["isolated manifest rebuild failed"],
        }],
      },
    },
  };
  await buildFailedTestRecoveryPacket(
    { commandCwd: workspace, taskProfile: "cad" },
    nestedHelperTracebackState
  );
  const nestedHelperTracebackFocus =
    nestedHelperTracebackState.meta.failedTestDiagnostic.focuses[0];
  assert(
    nestedHelperTracebackFocus?.kind === "failed-test-traceback-line" &&
      nestedHelperTracebackFocus.path === "traceback-helper-source.py" &&
      nestedHelperTracebackFocus.decisiveLine === 8 &&
      nestedHelperTracebackFocus.directSearch.includes("sha256_file(path)"),
    `a one-call helper frame displaced its richer actionable caller: ${JSON.stringify(nestedHelperTracebackFocus)}`
  );
  assert(
    (await failedTestRepairPatchBlock(
      duplicateRepairState,
      "apply_patch",
      {
        path: "duplicate-source.py",
        search: duplicateSource,
        replace: duplicateSource,
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-nonrepairing-patch",
    "a rewrite that retained duplicate top-level declarations was accepted"
  );
  assert(
    (await failedTestRepairPatchBlock(
      duplicateRepairState,
      "apply_patch",
      {
        path: "duplicate-source.py",
        search: duplicateSource,
        replace: [
          "def main():",
          "    return status_service()",
          "",
          "if __name__ == '__main__':",
          "    raise SystemExit(main())",
          "",
        ].join("\n"),
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-regression",
    "duplicate cleanup was allowed to remove every implementation of a required declaration"
  );
  assert(
    (await failedTestRepairPatchBlock(
      duplicateRepairState,
      "apply_patch",
      {
        path: "duplicate-source.py",
        search: duplicateSource,
        replace: [
          "import os",
          "",
          "def status_service():",
          "    return 'current'",
          "",
          "if __name__ == '__main__':",
          "    raise SystemExit(main())",
          "",
        ].join("\n"),
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-regression",
    "duplicate cleanup was allowed to discard a unique top-level declaration"
  );
  assert(
    (await failedTestRepairPatchBlock(
      duplicateRepairState,
      "apply_patch",
      {
        path: "duplicate-source.py",
        search: duplicateSource,
        replace: canonicalDuplicateSource.replace(/^import os\n\n/, ""),
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-regression",
    "duplicate cleanup was allowed to discard the module preamble"
  );
  assert(
    (await failedTestRepairPatchBlock(
      duplicateRepairState,
      "apply_patch",
      {
        path: "duplicate-source.py",
        search: duplicateSource,
        replace: canonicalDuplicateSource,
      },
      { commandCwd: workspace }
    )) === null,
    "a coherent duplicate declaration consolidation was blocked"
  );
  const incrementalDeclarationPatch = groundedDeclarationPatchFromPartialFile(
    [
      "#!/usr/bin/env python3",
      "import os",
      "",
      "def start_service():",
      "    return 'old-start'",
      "",
      "def status_service():",
      "    return 'old-status'",
      "",
    ].join("\n"),
    [
      "import sys",
      "",
      "def main():",
      "    return 0",
      "",
      "def start_service():",
      "    return 'new-start'",
      "",
      "def status_service():",
      "    return 'new-status'",
      "",
      "def main():",
      "    return 1",
      "",
    ].join("\n")
  );
  assert(
    incrementalDeclarationPatch?.identity === "start_service" &&
      incrementalDeclarationPatch.search.includes("old-start") &&
      incrementalDeclarationPatch.replace.includes("new-start") &&
      !incrementalDeclarationPatch.replace.includes("status_service") &&
      !incrementalDeclarationPatch.replace.includes("def main"),
    "an incomplete multi-declaration rewrite was not reduced to one unique grounded declaration"
  );
  const requiredInsertionSource = [
    "#!/usr/bin/env python3",
    "import os",
    "import subprocess",
    "",
    "def build_service_command(host: str, port: int) -> list[str]:",
    "    return ['sensor-gateway', '--host', host, '--port', str(port)]",
    "",
    "def start_service(host: str, port: int):",
    "    return build_service_command(host, port)",
    "",
    "def main():",
    "    return start_service('127.0.0.1', 8080)",
    "",
    "if __name__ == '__main__':",
    "    raise SystemExit(main())",
    "",
    "def main():",
    "    return 0",
    "",
  ].join("\n");
  const requiredInsertionAnchor = [
    "def start_service(host: str, port: int):",
    "    return build_service_command(host, port)",
    "",
  ].join("\n");
  const requiredInsertionHash = crypto
    .createHash("sha256")
    .update(requiredInsertionSource)
    .digest("hex");
  const requiredInsertionState = {
    meta: {
      goalContract: {
        version: 3,
        revision: 1,
        status: "active",
        taskGoal: "Repair the service lifecycle.",
        activeGoal: "Repair the service lifecycle.",
        history: [],
        lifecycle: [],
      },
      projectVerification: {
        mutationRevision: 2,
        privateMutationRevision: 0,
        testRuns: [
          {
            command: "python3 -m unittest discover -s tests -v",
            mutationRevision: 2,
            privateMutationRevision: 0,
            passed: false,
            failureSignature: "missing-launch-service",
            failureSummary:
              "AttributeError: module service_ctl has no attribute launch_service",
          },
        ],
      },
      requiredSymbolRepair: {
        version: 1,
        kind: "python-patch-object",
        owner: "service_ctl",
        symbol: "launch_service",
        path: "service_ctl.py",
        contracts: [
          {
            kind: "python-patch-object",
            owner: "service_ctl",
            symbol: "launch_service",
            path: "service_ctl.py",
          },
          {
            kind: "python-patch-object",
            owner: "service_ctl",
            symbol: "wait_until_healthy",
            path: "service_ctl.py",
          },
        ],
        confirmedAbsent: true,
        goalRevision: 1,
        mutationRevision: 2,
        failureSignature: "missing-launch-service",
      },
      toolLoop: {
        patchContextRepair: {
          version: 1,
          path: "service_ctl.py",
          goalRevision: 1,
          mutationRevision: 2,
          privateMutationRevision: 0,
          failureSignature: "missing-launch-service",
          search: requiredInsertionAnchor,
          searchHash: crypto
            .createHash("sha256")
            .update(requiredInsertionAnchor)
            .digest("hex"),
          sourceHash: requiredInsertionHash,
          anchorKind: "declaration-identity",
          anchorIdentity: "start_service",
          completeSource: requiredInsertionSource,
          completeSourceHash: requiredInsertionHash,
          completeSourceBytes: Buffer.byteLength(requiredInsertionSource, "utf8"),
        },
      },
    },
  };
  const requiredInsertionBinding = bindPatchContextRepairArguments(
    requiredInsertionState,
    {
      path: "service_ctl.py",
      search: requiredInsertionAnchor,
      replace: [
        "import pathlib",
        "",
        "def launch_service(host: str, port: int, stdout, stderr):",
        "    command = build_service_command(host, port)",
        "    return subprocess.Popen(command, stdout=stdout, stderr=stderr)",
        "",
        "def wait_until_healthy(host: str, port: int) -> bool:",
        "    return True",
        "",
        "import pathlib",
      ].join("\n"),
    }
  );
  assert(
    requiredInsertionBinding?.incrementalDeclarationRecovery?.mode ===
      "insert-required-declaration" &&
      requiredInsertionBinding.incrementalDeclarationRecovery.identity ===
        "launch_service" &&
      requiredInsertionBinding.args.replace.indexOf("def launch_service") <
        requiredInsertionBinding.args.replace.indexOf("def main") &&
      !requiredInsertionBinding.args.replace.includes("def wait_until_healthy") &&
      !requiredInsertionBinding.args.replace.includes("import pathlib") &&
      requiredInsertionBinding.scopeIssue === null,
    "a required missing declaration was not safely inserted before the first Python entrypoint"
  );
  const unrelatedInsertionBinding = bindPatchContextRepairArguments(
    requiredInsertionState,
    {
      path: "service_ctl.py",
      search: requiredInsertionAnchor,
      replace: [
        "def evil_helper():",
        "    return 'not acceptance grounded'",
      ].join("\n"),
    }
  );
  assert(
    !unrelatedInsertionBinding?.incrementalDeclarationRecovery &&
      Boolean(unrelatedInsertionBinding?.scopeIssue),
    "an unrelated missing declaration escaped the active failed-test symbol contract"
  );
  const declarationBoundarySource = [
    "def build_preview():",
    "    path = 'preview.png'",
    "    return path",
    "",
    "def main():",
    "    return build_preview()",
    "",
  ].join("\n");
  const declarationBoundaryOffset = declarationBoundarySource.indexOf("def main():");
  const declarationBoundaryAnchor = declarationBoundarySource.slice(
    0,
    declarationBoundaryOffset
  );
  const declarationBoundaryState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { mutationRevision: 1, privateMutationRevision: 0 },
      toolLoop: {
        patchContextRepair: {
          version: 1,
          path: "preview_builder.py",
          goalRevision: 1,
          mutationRevision: 1,
          privateMutationRevision: 0,
          search: declarationBoundaryAnchor,
          searchHash: crypto
            .createHash("sha256")
            .update(declarationBoundaryAnchor)
            .digest("hex"),
          sourceHash: crypto
            .createHash("sha256")
            .update(declarationBoundarySource)
            .digest("hex"),
          anchorKind: "declaration-identity",
          anchorIdentity: "build_preview",
        },
      },
    },
  };
  const declarationBoundaryBinding = bindPatchContextRepairArguments(
    declarationBoundaryState,
    {
      replace: [
        "def build_preview():",
        "    path = 'preview-fixed.png'",
        "    return path",
      ].join("\n"),
    }
  );
  assert(
    declarationBoundaryBinding?.boundaryWhitespacePreserved === true &&
      declarationBoundaryBinding.args.replace.endsWith("\n") &&
      /return path\n+def main\(\):/.test(
        `${declarationBoundaryBinding.args.replace}${declarationBoundarySource.slice(declarationBoundaryOffset)}`
      ),
    "revision-bound declaration replacement did not preserve its Python declaration boundary"
  );
  await fs.writeFile(
    path.join(workspace, "preview_builder.py"),
    declarationBoundarySource,
    "utf8"
  );
  assert(
    (await prospectivePythonExactPatchSyntaxBlock(
      "apply_patch",
      declarationBoundaryBinding.args,
      { commandCwd: workspace }
    )) === null,
    "the boundary-preserved declaration replacement still produced invalid Python"
  );
  const incrementalAnchorSearch = [
    "    path = 'preview.png'",
    "    return path",
  ].join("\n");
  const incrementalAnchorBinding = bindPatchContextRepairArguments(
    declarationBoundaryState,
    {
      path: "preview_builder.py",
      search: incrementalAnchorSearch,
      replace: [
        "    path = 'preview-fixed.png'",
        "    path.write_text('ready')",
        "    return path",
      ].join("\n"),
    }
  );
  assert(
    incrementalAnchorBinding?.incrementalDeclarationRecovery?.mode ===
      "replace-anchor-subrange" &&
      incrementalAnchorBinding.args.search === declarationBoundaryAnchor &&
      incrementalAnchorBinding.args.replace.startsWith("def build_preview():") &&
      incrementalAnchorBinding.args.replace.includes("path.write_text('ready')") &&
      !incrementalAnchorBinding.args.replace.includes("path = 'preview.png'") &&
      incrementalAnchorBinding.scopeIssue === null,
    "an exact partial edit inside a revision-bound declaration was not expanded into one complete declaration replacement"
  );
  assert(
    (await prospectivePythonExactPatchSyntaxBlock(
      "apply_patch",
      incrementalAnchorBinding.args,
      { commandCwd: workspace }
    )) === null,
    "the expanded incremental declaration replacement produced invalid Python"
  );
  const syntaxRefreshDecision = patchContextRefreshDecision(
    {
      meta: {
        goalContract: { revision: 1 },
        projectVerification: { mutationRevision: 1, privateMutationRevision: 0 },
        toolLoop: { stagnationEpoch: 0, recent: [] },
      },
    },
    {
      toolName: "apply_patch",
      ok: false,
      category: "python-syntax-regression",
      args: {
        path: "preview_builder.py",
        search: declarationBoundaryAnchor,
      },
    }
  );
  assert(
    syntaxRefreshDecision?.triggerCategory === "python-syntax-regression" &&
      syntaxRefreshDecision.path === "preview_builder.py",
    "a prospective Python syntax regression did not force a fresh exact-source read"
  );
  const noChangeRefreshDecision = patchContextRefreshDecision(
    {
      meta: {
        goalContract: { revision: 1 },
        projectVerification: { mutationRevision: 1, privateMutationRevision: 0 },
        toolLoop: { stagnationEpoch: 0, recent: [] },
      },
    },
    {
      toolName: "apply_patch",
      ok: false,
      error: "Patch made no changes to build.py.",
      args: {
        path: "build.py",
        search: "def write_manifest(",
      },
    }
  );
  assert(
    noChangeRefreshDecision?.triggerCategory === "no-change-patch" &&
      noChangeRefreshDecision.path === "build.py" &&
      noChangeRefreshDecision.failedSearchPreview === "def write_manifest(",
    "a semantically empty patch did not force a focused exact-source refresh"
  );
  const semanticScopeMismatchState = {
    meta: {
      goalContract: { revision: 4 },
      projectVerification: { mutationRevision: 7 },
      toolLoop: {
        stagnationEpoch: 3,
        recent: [
          {
            toolName: "apply_patch",
            path: "service_ctl.py",
            ok: false,
            category: "patch-context-scope-mismatch",
            signature: "patch:proposal-a",
            stagnationEpoch: 3,
            goalRevision: 4,
            mutationRevision: 7,
          },
          {
            toolName: "apply_patch",
            path: "service_ctl.py",
            ok: false,
            category: "patch-context-scope-mismatch",
            signature: "patch:proposal-b",
            stagnationEpoch: 3,
            goalRevision: 4,
            mutationRevision: 7,
          },
        ],
      },
    },
  };
  assert(
    patchContextScopeMismatchAttemptCount(
      semanticScopeMismatchState,
      "service_ctl.py"
    ) === 3,
    "slightly different whole-file proposals evaded the revision-scoped scope-mismatch cap"
  );
  assert(
    patchContextScopeMismatchAttemptCount(
      semanticScopeMismatchState,
      "other.py"
    ) === 1,
    "scope-mismatch attempts leaked across source paths"
  );
  const correctiveGoal = [
    "Continue the same task. The repository implementation is incomplete.",
    "Re-read the repository requirements and current implementation before editing.",
    "Repair the service lifecycle, add meaningful regression tests, update the operator documentation, run the test suite, and commit the task-owned work.",
  ].join(" ");
  assert(
    preservesCurrentTaskBoundary(
      {
        goal: "Repair the service controller.",
        meta: { goalContract: { taskGoal: "Repair the service controller." } },
      },
      "Continue the same service-controller repair from the current fixture state. Fix the CLI."
    ),
    "a natural same-repair continuation was misclassified as an unrelated task"
  );
  const scopedRuntimeMessages = runtimeMessagesSinceLatestContinuationBoundary([
    { role: "user", content: "Repair the old task." },
    toolMessage({ toolName: "run_command", ok: true, args: { command: "npm test" } }),
    { role: "user", content: `Continue the current task from saved state: ${correctiveGoal}` },
    toolMessage({ toolName: "read_file", ok: true, path: "service_ctl.py" }),
  ]);
  assert(
    scopedRuntimeMessages.length === 2 &&
      scopedRuntimeMessages[1].content.includes("service_ctl.py"),
    "local context recovery retained stale pre-continuation tool loops"
  );
  await fs.writeFile(
    path.join(workspace, "service_ctl.py"),
    "import subprocess\n\ndef start_service(command):\n    return subprocess.Popen(command)\n",
    "utf8"
  );
  const correctiveState = {
    goal: correctiveGoal,
    commandCwd: workspace,
    meta: {
      taskProfile: "devops",
      goalContract: {
        revision: 7,
        activeGoalRevision: 7,
        currentRequest: correctiveGoal,
        currentPreview: correctiveGoal,
        activeGoal: correctiveGoal,
        taskGoal: "Repair the service lifecycle and commit the tested result.",
        history: [{ revision: 7, refreshExecutionContract: true }],
      },
      activeExecutionContract: {
        revision: 7,
        startedMutationRevision: 16,
        requiresWorkspaceMutation: true,
        requiresFileMutation: true,
        requiresSourceGrounding: true,
        requiredProjectCommands: [],
      },
      projectVerification: {
        mutationRevision: 16,
        discoveredTests: ["tests/test_service_ctl.py"],
        mutationHistory: [],
        testRuns: [],
      },
      scs: { acceptanceCriteria: [] },
    },
  };
  const correctiveContract = completionTaskContract(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    correctiveState
  );
  assert(
    correctiveContract.requiresFileMutation === true &&
      correctiveContract.requiredFreshMutationRevision === 17,
    "the current correction contract did not require one fresh project mutation"
  );
  const failedNoMutationCommandState = structuredClone(correctiveState);
  recordProjectVerificationOutcome(
    failedNoMutationCommandState,
    {
      ok: false,
      toolName: "run_command",
      args: { command: ".build" },
      exitCode: 127,
      stderr: "/bin/bash: .build: command not found",
      commandPolicy: {
        category: "general-shell",
        writesWorkspace: true,
      },
      projectMutationPaths: [],
    },
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace }
  );
  assert(
    failedNoMutationCommandState.meta.projectVerification.mutationRevision === 16,
    "a failed shell command with no observed mutation fabricated a fresh project revision"
  );
  const missingVerifierInvocationState = structuredClone(correctiveState);
  const missingVerifierInvocationResult = {
    ok: false,
    toolName: "run_command",
    args: { command: ".build" },
    exitCode: 127,
    stderr: "/bin/bash: line 1: .build: command not found",
    commandPolicy: {
      category: "general-shell",
      writesWorkspace: true,
    },
    projectMutationPaths: [],
  };
  recordProjectVerificationOutcome(
    missingVerifierInvocationState,
    missingVerifierInvocationResult,
    {
      goal: correctiveGoal,
      taskProfile: "devops",
      commandCwd: workspace,
      testVerificationPending: true,
      testVerificationCommand: ".build",
    }
  );
  assert(
    missingVerifierInvocationResult.projectTestDiscoveryFailure?.invalidInvocation === true &&
      projectTestVerificationFinishBlock(missingVerifierInvocationState) === null,
    "a missing shell command was misclassified as a project source-test failure"
  );
  const heuristicFalseContractState = structuredClone(correctiveState);
  heuristicFalseContractState.meta.goalContract.history = [
    { revision: 7, refreshExecutionContract: false },
  ];
  const heuristicFalseContract = completionTaskContract(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    heuristicFalseContractState
  );
  assert(
    heuristicFalseContract.requiresFileMutation === true &&
      heuristicFalseContract.requiredFreshMutationRevision === 17,
    "a goal-history heuristic suppressed the current explicit execution contract"
  );
  const correctiveRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    correctiveState
  );
  assert(
    correctiveRuntime.repositoryGroundingRequired === true,
    "a fresh source-changing correction did not require repository grounding before mutation"
  );
  assert(
    correctiveRuntime.repositoryGroundingRequiresTests === true,
    "a regression-test correction did not require reading an existing test before mutation"
  );
  const requiredCorrectionCommand = "python3 -m unittest discover -s tests -v";
  const commandAfterMutationState = structuredClone(correctiveState);
  commandAfterMutationState.meta.activeExecutionContract.requiredProjectCommands = [
    requiredCorrectionCommand,
  ];
  commandAfterMutationState.meta.projectVerification.requiredCommands = [
    requiredCorrectionCommand,
  ];
  commandAfterMutationState.meta.projectVerification.commandRuns = [];
  const preMutationCommandRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    commandAfterMutationState
  );
  assert(
    preMutationCommandRuntime.repositoryGroundingRequired === true &&
      preMutationCommandRuntime.requiredProjectCommandPending !== true,
    "a non-mutating required test preempted the current correction's fresh source mutation"
  );
  const cosmeticMutationState = structuredClone(correctiveState);
  recordProjectVerificationOutcome(
    cosmeticMutationState,
    {
      ok: true,
      toolName: "apply_patch",
      path: "service_ctl.py",
      changes: [
        {
          path: "service_ctl.py",
          beforeHash: "semantic-source-before",
          afterHash: "cosmetic-source-after",
          diff: [
            "--- a/service_ctl.py",
            "+++ b/service_ctl.py",
            "@@ line 12 @@",
            "-",
            "+   ",
          ].join("\n"),
        },
      ],
    },
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace }
  );
  assert(
    cosmeticMutationState.meta.projectVerification.mutationRevision === 17 &&
      cosmeticMutationState.meta.activeExecutionContract.materialMutationRevision === undefined,
    "a cosmetic patch did not invalidate ordinary evidence separately from material correction evidence"
  );
  const cosmeticMutationRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    cosmeticMutationState
  );
  assert(
    cosmeticMutationRuntime.repositoryGroundingRequired === true &&
      cosmeticMutationRuntime.completionFreshMutationRequired === true,
    "a whitespace-only patch incorrectly satisfied the current correction's material mutation contract"
  );
  const materialMutationState = structuredClone(correctiveState);
  recordProjectVerificationOutcome(
    materialMutationState,
    {
      ok: true,
      toolName: "apply_patch",
      path: "service_ctl.py",
      changes: [
        {
          path: "service_ctl.py",
          beforeHash: "broken-source-before",
          afterHash: "repaired-source-after",
          diff: [
            "--- a/service_ctl.py",
            "+++ b/service_ctl.py",
            "@@ line 42 @@",
            "-        stdout=subprocess.PIPE,",
            "+        stdout=log_handle,",
          ].join("\n"),
        },
      ],
    },
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace }
  );
  assert(
    materialMutationState.meta.activeExecutionContract.materialMutationRevision === 17 &&
      JSON.stringify(materialMutationState.meta.activeExecutionContract.materialMutationPaths) ===
        JSON.stringify(["service_ctl.py"]),
    "a material source repair did not bind semantic mutation evidence to the active execution contract"
  );
  assert(
    nextStepRuntimeConfig(
      { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
      materialMutationState
    ).repositoryGroundingRequired !== true,
    "a material source repair did not close the current correction's grounding phase"
  );
  commandAfterMutationState.meta.projectVerification.mutationRevision = 17;
  commandAfterMutationState.meta.activeExecutionContract.materialMutationRevision = 17;
  const implementationOpenRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    commandAfterMutationState
  );
  assert(
    implementationOpenRuntime.requiredProjectCommandPending !== true,
    "a required final test preempted additional requested implementation after the first mutation"
  );
  commandAfterMutationState.meta.completionEvidenceRepair = {
    key: "pending-final-verification",
    at: "2026-08-26T10:03:00.000Z",
  };
  const requiredCommandRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    commandAfterMutationState
  );
  assert(
    requiredCommandRuntime.requiredProjectCommandPending === true &&
      requiredCommandRuntime.requiredProjectCommand === requiredCorrectionCommand,
    "the required final test did not become pending after implementation requested completion"
  );
  const equivalentShellVerifierState = structuredClone(commandAfterMutationState);
  equivalentShellVerifierState.meta.activeExecutionContract.requiredProjectCommands = [
    "bash scripts/test.sh",
  ];
  equivalentShellVerifierState.meta.projectVerification.requiredCommands = [
    "scripts/test.sh",
  ];
  equivalentShellVerifierState.meta.projectVerification.commandRuns = [
    {
      command: "bash scripts/test.sh",
      mutationRevision: 17,
      privateMutationRevision: 0,
      ok: true,
      requiredProjectCommand: "bash scripts/test.sh",
    },
  ];
  equivalentShellVerifierState.meta.projectVerification.testRuns = [
    {
      command: "bash scripts/test.sh",
      mutationRevision: 17,
      privateMutationRevision: 0,
      passed: true,
      requiredProjectCommand: "bash scripts/test.sh",
    },
  ];
  equivalentShellVerifierState.meta.completionEvidenceRepair = {
    key: "equivalent-shell-verifier-complete",
    at: "2026-08-26T10:03:00.000Z",
  };
  const equivalentShellVerifierRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    equivalentShellVerifierState
  );
  assert(
    equivalentShellVerifierRuntime.requiredProjectCommandPending !== true,
    "bash script and direct script spellings became duplicate required verifier runs"
  );
  const mutatingRequiredCommand = "python3 scripts/generate_fixture.py";
  const mutatingCommandState = structuredClone(correctiveState);
  mutatingCommandState.meta.activeExecutionContract.requiredProjectCommands = [
    mutatingRequiredCommand,
  ];
  mutatingCommandState.meta.projectVerification.requiredCommands = [
    mutatingRequiredCommand,
  ];
  mutatingCommandState.meta.projectVerification.commandRuns = [];
  const mutatingCommandRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    mutatingCommandState
  );
  assert(
    mutatingCommandRuntime.requiredProjectCommandPending === true &&
      mutatingCommandRuntime.requiredProjectCommand === mutatingRequiredCommand,
    "a required generator command was incorrectly deferred behind a separate mutation"
  );
  const postMutationCorrectiveState = structuredClone(correctiveState);
  postMutationCorrectiveState.meta.projectVerification.mutationRevision = 17;
  postMutationCorrectiveState.meta.activeExecutionContract.materialMutationRevision = 17;
  const postMutationRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    postMutationCorrectiveState
  );
  assert(
    postMutationRuntime.repositoryGroundingRequired !== true,
    "repository grounding reopened after the current correction already mutated canonical source"
  );
  const completionMutationState = structuredClone(correctiveState);
  completionMutationState.meta.completionEvidenceRepair = {
    key: "missing-fresh-source",
    attempts: 1,
    at: "2026-08-26T10:00:00.000Z",
    goalRevision: 7,
    mutationRevision: 16,
    requiresFreshFileMutation: true,
    requiredFreshMutationRevision: 17,
    missingEvidence: ["file", "command", "git"],
  };
  completionMutationState.meta.toolLoop = {
    recent: [
      {
        toolName: "read_file",
        path: "service_ctl.py",
        ok: true,
        at: "2026-08-26T09:59:00.000Z",
      },
      {
        toolName: "read_file",
        path: ".aginti/verification/lifecycle/smoke_test.py",
        ok: true,
        at: "2026-08-26T10:01:00.000Z",
      },
    ],
  };
  const completionMutationReadRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    completionMutationState
  );
  assert(
    completionMutationReadRuntime.completionFreshMutationRequired === true &&
      completionMutationReadRuntime.completionFreshMutationNeedsSourceRead === true &&
      JSON.stringify(completionMutationReadRuntime.completionFreshMutationPaths) ===
        JSON.stringify(["service_ctl.py"]),
    "a rejected completion did not retain a private-evidence-safe exact canonical source read phase"
  );
  completionMutationState.meta.toolLoop.recent.push({
    toolName: "read_file",
    path: "service_ctl.py",
    ok: true,
    at: "2026-08-26T10:02:00.000Z",
  });
  const completionMutationPatchRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    completionMutationState
  );
  assert(
    completionMutationPatchRuntime.completionFreshMutationRequired === true &&
      completionMutationPatchRuntime.completionFreshMutationNeedsSourceRead === false,
    "a fresh canonical source read did not advance completion repair to mutation-only mode"
  );
  const hostedSourceMutationRequest = buildConstrainedRecoveryRequest(
    completionMutationState,
    { goal: correctiveGoal, provider: "deepseek", taskProfile: "devops", commandCwd: workspace },
    {},
    8,
    completionMutationPatchRuntime
  );
  assert(
    hostedSourceMutationRequest?.mode === "fresh-source-mutation" &&
      hostedSourceMutationRequest?.maxOutputTokens === 8192,
    "hosted reasoning models did not retain enough constrained output budget to emit the source mutation"
  );
  const boundedLocalSourceMutationRequest = buildConstrainedRecoveryRequest(
    completionMutationState,
    {
      goal: correctiveGoal,
      provider: "localllm",
      taskProfile: "devops",
      commandCwd: workspace,
      maxOutputTokens: 4096,
    },
    {},
    8,
    { ...completionMutationPatchRuntime, provider: "localllm", maxOutputTokens: 4096 }
  );
  assert(
    boundedLocalSourceMutationRequest?.maxOutputTokens === 4096,
    "a smaller explicit local output budget was not preserved for constrained mutation"
  );
  const staleCompletionMarkerState = structuredClone(commandAfterMutationState);
  staleCompletionMarkerState.meta.projectVerification.mutationRevision = 17;
  staleCompletionMarkerState.meta.completionEvidenceRepair = {
    key: "pre-source-quality-precedence-fix",
    at: "2026-08-26T10:03:00.000Z",
    mutationRevision: 17,
    requiresFreshFileMutation: false,
    requiredFreshMutationRevision: 17,
    missingEvidence: ["command", "git"],
  };
  staleCompletionMarkerState.meta.sourceCodeQuality = {
    checked: true,
    ok: false,
    paths: ["service_ctl.py"],
    defects: [{ code: "python-syntax-error", path: "service_ctl.py" }],
  };
  staleCompletionMarkerState.meta.toolLoop = { recent: [] };
  const staleCompletionMarkerRuntime = nextStepRuntimeConfig(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    staleCompletionMarkerState
  );
  const staleCompletionMarkerPhase = buildKnownConstrainedPhasePlan(
    { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
    staleCompletionMarkerState,
    staleCompletionMarkerRuntime
  );
  assert(
    staleCompletionMarkerRuntime.completionFreshMutationRequired === true &&
      staleCompletionMarkerRuntime.completionFreshMutationRevision === 18 &&
      staleCompletionMarkerRuntime.completionFreshMutationNeedsSourceRead === true &&
      staleCompletionMarkerPhase?.mode === "fresh-source-mutation",
    "a persisted pre-fix completion marker still allowed tests or Git to preempt current source-quality repair"
  );
  const explicitPathRecoveryState = {
    goal:
      "Repair service_ctl.py and do not create verification_suite.py. A report citation uses DOI 10.1016/j.c and is not a source path.",
    meta: {
      taskProfile: "devops",
      goalContract: {
        revision: 3,
        currentRequest:
          "Repair service_ctl.py so subprocess.Popen uses start_new_session=True. verification_suite.py is absent and must not be created. A report citation uses DOI 10.1016/j.c and is not a source path.",
      },
      activeExecutionContract: {
        revision: 3,
        startedMutationRevision: 0,
        requiresFileMutation: true,
      },
      projectVerification: {
        mutationRevision: 0,
        mutationHistory: [],
      },
      completionEvidenceRepair: {
        key: "missing-executable-source",
        at: "2026-08-26T10:00:00.000Z",
        requiresFreshFileMutation: true,
        requiredFreshMutationRevision: 1,
      },
      toolLoop: { recent: [] },
    },
  };
  assert(
    (await fs.stat(path.join(workspace, "service_ctl.py"))).isFile(),
    "fresh-mutation path smoke lost its canonical source fixture"
  );
  const explicitPathRecoveryRuntime = nextStepRuntimeConfig(
    { goal: explicitPathRecoveryState.goal, taskProfile: "devops", commandCwd: workspace },
    explicitPathRecoveryState
  );
  assert(
    JSON.stringify(explicitPathRecoveryRuntime.completionFreshMutationPaths) ===
      JSON.stringify(["service_ctl.py"]),
    `fresh-mutation recovery did not derive the explicitly named canonical production source: ${JSON.stringify(
      explicitPathRecoveryRuntime.completionFreshMutationPaths
    )}`
  );
  assert(
    explicitPathRecoveryRuntime.completionFreshMutationRequired === true &&
      explicitPathRecoveryRuntime.completionFreshMutationNeedsSourceRead === true,
    "a concrete source correction did not enter its deterministic read-before-mutate phase"
  );
  explicitPathRecoveryState.meta.activeExecutionContract.refreshedAt =
    "2026-08-26T10:00:00.000Z";
  explicitPathRecoveryState.meta.toolLoop.recent.push({
    toolName: "read_file",
    path: "service_ctl.py",
    ok: true,
    at: "2026-08-26T10:01:00.000Z",
  });
  const explicitPathPatchRuntime = nextStepRuntimeConfig(
    { goal: explicitPathRecoveryState.goal, taskProfile: "devops", commandCwd: workspace },
    explicitPathRecoveryState
  );
  assert(
    explicitPathPatchRuntime.completionFreshMutationRequired === true &&
      explicitPathPatchRuntime.completionFreshMutationNeedsSourceRead === false,
    "a fresh current-turn source read did not advance directly to bounded mutation"
  );
  completionMutationState.meta.projectVerification.mutationRevision = 17;
  completionMutationState.meta.activeExecutionContract.materialMutationRevision = 17;
  assert(
    nextStepRuntimeConfig(
      { goal: correctiveGoal, taskProfile: "devops", commandCwd: workspace },
      completionMutationState
    ).completionFreshMutationRequired !== true,
    "completion repair remained mutation-gated after the required project revision advanced"
  );

  const priorGroundingMessages = [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "old-inspect",
          function: { name: "inspect_project", arguments: "{}" },
        },
      ],
    },
    toolMessage({
      toolName: "inspect_project",
      ok: true,
      topLevel: [{ path: "README.md", type: "file" }],
    }),
    {
      role: "user",
      content: `Continue the current task from saved state: ${correctiveGoal}`,
    },
  ];
  assert(
    repositoryGroundingState(priorGroundingMessages).phase === "inspect",
    "repository grounding reused discovery from before the current continuation boundary"
  );
  const naturalContinuationMessages = [
    ...priorGroundingMessages.slice(0, -1),
    {
      role: "user",
      content: correctiveGoal,
    },
  ];
  assert(
    repositoryGroundingState(naturalContinuationMessages).phase === "inspect",
    "repository grounding reused discovery before a natural same-task correction boundary"
  );
  const compactedWithoutBoundary = [
    {
      role: "user",
      content: "Continue from this compacted, valid transcript.",
    },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "stale-compacted-inspect",
          function: { name: "inspect_project", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "stale-compacted-inspect",
      content: JSON.stringify({
        ok: true,
        toolName: "inspect_project",
        goalRevision: 6,
        topLevel: [{ path: "README.md", type: "file" }],
      }),
    },
  ];
  assert(
    repositoryGroundingState(compactedWithoutBoundary, {
      minimumGoalRevision: 7,
    }).phase === "inspect",
    "repository grounding accepted stale compacted discovery from an older goal revision"
  );
  const groundedMessages = [...priorGroundingMessages];
  const appendGroundingTool = (id, name, args, result) => {
    groundedMessages.push({
      role: "assistant",
      tool_calls: [
        {
          id,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    groundedMessages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(result) });
  };
  appendGroundingTool("inspect-current", "inspect_project", {}, {
    ok: true,
    goalRevision: 7,
    topLevel: [
      { path: "README.md", type: "file" },
      { path: "service_ctl.py", type: "file" },
      { path: "gateway_service.py", type: "file" },
      { path: "tests", type: "directory" },
    ],
    recommendedReads: ["README.md", "tests", "tests/test_service_ctl.py"],
    manifestFiles: [{ path: "README.md" }],
    testFiles: [{ path: "tests/test_service_ctl.py" }],
    sourceDirs: [{ path: "tests", kind: "tests" }],
  });
  assert(
    repositoryGroundingState(groundedMessages).phase === "read-instructions",
    "repository grounding did not require current project instructions after inspection"
  );
  assert(
    !repositoryGroundingState(groundedMessages).paths.includes("tests"),
    "repository grounding exposed a known directory as a read_file candidate"
  );
  appendGroundingTool("read-readme", "read_file", { path: "README.md" }, {
    ok: true,
    goalRevision: 7,
    path: "README.md",
  });
  assert(
    repositoryGroundingState(groundedMessages).phase === "read-context",
    "repository grounding did not require current implementation context"
  );
  appendGroundingTool("read-source", "read_file", { path: "service_ctl.py" }, {
    ok: true,
    goalRevision: 7,
    path: "service_ctl.py",
  });
  assert(
    repositoryGroundingState(groundedMessages).phase === "read-tests",
    "repository grounding did not require an existing regression test"
  );
  appendGroundingTool("read-test", "read_file", { path: "tests/test_service_ctl.py" }, {
    ok: true,
    goalRevision: 7,
    path: "tests/test_service_ctl.py",
  });
  assert(
    repositoryGroundingState(groundedMessages).phase === "ready",
    "repository grounding did not reopen mutation tools after all current evidence was read"
  );
  assert(
    repositoryGroundingState(groundedMessages, {
      minimumGoalRevision: 7,
    }).phase === "ready",
    "repository grounding rejected complete current-revision discovery evidence"
  );
  for (const category of ["file", "command", "test"]) {
    const requirement = correctiveContract.requiredEvidence.find(
      (item) => item.category === category
    );
    assert(
      requirement?.minimumGoalRevision === 7 && requirement?.minimumMutationRevision === 17,
      `a corrective ${category} requirement reused stale pre-correction evidence`
    );
  }
  assert(
    correctiveContract.requiredGitRevision === 7 &&
      correctiveContract.requiredGitMutationRevision === 17,
    "a corrective commit could be satisfied before the required source mutation"
  );
  const staleCorrectiveLedger = buildScsEvidenceLedger({
    state: {
      messages: [
        toolMessage({
          ok: true,
          toolName: "apply_patch",
          path: "service_ctl.py",
          goalRevision: 6,
          projectMutationRevision: 16,
        }),
        toolMessage({
          ok: true,
          toolName: "run_command",
          args: { command: "python3 -m unittest discover -s tests -v" },
          exitCode: 0,
          goalRevision: 6,
          projectMutationRevision: 16,
          projectTest: {
            passed: true,
            command: "python3 -m unittest discover -s tests -v",
            mutationRevision: 16,
          },
        }),
        toolMessage({
          ok: true,
          toolName: "run_command",
          args: { command: "git commit -am 'incomplete repair'" },
          exitCode: 0,
          stdout: "[main abc1234] incomplete repair",
          goalRevision: 6,
          projectMutationRevision: 16,
        }),
      ],
    },
  });
  const staleCorrectiveEvaluation = evaluateScsEvidence(
    correctiveContract,
    staleCorrectiveLedger
  );
  assert(
    !staleCorrectiveEvaluation.ok &&
      ["file", "command", "test"].every((category) =>
        staleCorrectiveEvaluation.missing.some((item) => item.category === category)
      ) &&
      staleCorrectiveEvaluation.missingGitActions.includes("commit"),
    "a concrete correction accepted historical file, test, command, or commit evidence"
  );
  assert(
    /missing fresh post-correction evidence/i.test(staleCorrectiveEvaluation.reason) &&
      /file/.test(staleCorrectiveEvaluation.reason) &&
      !/^Missing required git action/i.test(staleCorrectiveEvaluation.reason),
    "completion diagnostics prioritized a downstream commit before the missing correction"
  );
  const freshCorrectiveLedger = buildScsEvidenceLedger({
    state: {
      messages: [
        toolMessage({
          ok: true,
          toolName: "apply_patch",
          path: "service_ctl.py",
          goalRevision: 7,
          projectMutationRevision: 17,
        }),
        toolMessage({
          ok: true,
          toolName: "run_command",
          args: { command: "python3 -m unittest discover -s tests -v" },
          exitCode: 0,
          goalRevision: 7,
          projectMutationRevision: 17,
          projectTest: {
            passed: true,
            command: "python3 -m unittest discover -s tests -v",
            mutationRevision: 17,
          },
        }),
        toolMessage({
          ok: true,
          toolName: "run_command",
          args: { command: "git commit -am 'complete lifecycle repair'" },
          exitCode: 0,
          stdout: "[main def5678] complete lifecycle repair",
          goalRevision: 7,
          projectMutationRevision: 17,
        }),
      ],
    },
  });
  assert(
    evaluateScsEvidence(correctiveContract, freshCorrectiveLedger).ok,
    "fresh post-correction mutation, test, command, and commit evidence was rejected"
  );
  const exactHeadRestoreLedger = buildScsEvidenceLedger({
    state: {
      messages: [
        toolMessage({
          ok: true,
          toolName: "run_command",
          args: {
            command: "git checkout HEAD -- 'src/main/java/example/WindowSummary.java'",
          },
          exitCode: 0,
          goalRevision: 25,
          projectMutationRevision: 43,
          explicitHeadRestore: true,
          explicitHeadRestorePaths: [
            "src/main/java/example/WindowSummary.java",
          ],
        }),
      ],
    },
  });
  const exactHeadRestoreFileEvidence = exactHeadRestoreLedger.items.find(
    (item) => item.category === "file" && item.explicitHeadRestore === true
  );
  assert(
    exactHeadRestoreFileEvidence?.target ===
      "src/main/java/example/WindowSummary.java" &&
      exactHeadRestoreFileEvidence?.mutationRevision === 43,
    "a runtime-verified exact HEAD restore did not become fresh path-scoped file evidence"
  );
  assert(
    evaluateScsEvidence(
      {
        requiresExternalEvidence: true,
        requiredEvidence: [{
          id: "file",
          category: "file",
          description: "workspace file mutation",
          minimumGoalRevision: 25,
          minimumMutationRevision: 43,
        }],
        requiredToolCalls: [],
        requiredGitActions: [],
        requiredProjectCommands: [],
      },
      exactHeadRestoreLedger
    ).ok,
    "fresh completion evidence rejected a runtime-verified exact HEAD restore"
  );
  const pythonQualityWorkspace = path.join(tempRoot, "python-quality-workspace");
  await fs.mkdir(pythonQualityWorkspace, { recursive: true });
  await fs.writeFile(
    path.join(pythonQualityWorkspace, "service_ctl.py"),
    "def stop_service():\n    return 0\n\ndef stop_service():\n    return 1\n",
    "utf8"
  );
  const duplicateSourceQuality = await validateMutatedPythonSourceQuality(
    { commandCwd: pythonQualityWorkspace },
    {
      meta: {
        projectVerification: {
          mutationHistory: [{ revision: 1, paths: ["service_ctl.py"] }],
        },
      },
    }
  );
  assert(
    duplicateSourceQuality.ok === false &&
      duplicateSourceQuality.defects[0]?.name === "stop_service",
    "completion source-quality validation accepted a task-mutated duplicate Python definition"
  );
  await fs.writeFile(
    path.join(pythonQualityWorkspace, "broken_service_ctl.py"),
    "def parse_arguments():\n    return parser.parse_args()(state_dir: Path) -> int:\n",
    "utf8"
  );
  const syntaxSourceQuality = await validateMutatedPythonSourceQuality(
    { commandCwd: pythonQualityWorkspace },
    {
      meta: {
        projectVerification: {
          mutationHistory: [{ revision: 2, paths: ["broken_service_ctl.py"] }],
        },
      },
    }
  );
  assert(
    syntaxSourceQuality.ok === false &&
      syntaxSourceQuality.defects.some((item) => item.code === "python-syntax-error"),
    "completion source-quality validation accepted syntactically invalid Python"
  );
  const syntaxRepairRequirement = completionRepairMutationRequirement({
    contract: { requiresFileMutation: false, requiredFreshMutationRevision: 0 },
    evaluation: { missing: [] },
    sourceQuality: syntaxSourceQuality,
    projectMutationRevision: 7,
  });
  assert(
    syntaxRepairRequirement.requiresFreshFileMutation === true &&
      syntaxRepairRequirement.sourceQualityRepairRequired === true &&
      syntaxRepairRequirement.requiredFreshMutationRevision === 8,
    "invalid task-mutated Python did not preempt tests and Git with a fresh source repair revision"
  );
  const evidenceOnlyRepairRequirement = completionRepairMutationRequirement({
    contract: { requiresFileMutation: true, requiredFreshMutationRevision: 3 },
    evaluation: { missing: [{ category: "file" }] },
    sourceQuality: { checked: true, ok: true, paths: ["valid_service_ctl.py"] },
    projectMutationRevision: 7,
  });
  assert(
    evidenceOnlyRepairRequirement.requiresFreshFileMutation === true &&
      evidenceOnlyRepairRequirement.sourceQualityRepairRequired === false &&
      evidenceOnlyRepairRequirement.requiredFreshMutationRevision === 3,
    "ordinary missing file evidence no longer retained its contract-bound mutation revision"
  );
  await fs.writeFile(
    path.join(pythonQualityWorkspace, "valid_service_ctl.py"),
    "from pathlib import Path\n\ndef start_service(state_dir: Path) -> int:\n    return 0\n",
    "utf8"
  );
  const syntaxRegressionBlock = await prospectivePythonExactPatchSyntaxBlock(
    "apply_patch",
    {
      path: "valid_service_ctl.py",
      search: "def start_service",
      replace: "def parse_arguments():\n    return object()",
    },
    { commandCwd: pythonQualityWorkspace }
  );
  assert(
    syntaxRegressionBlock?.category === "python-syntax-regression",
    "prospective syntax validation accepted a declaration-token patch that corrupts valid Python"
  );
  const declarationTokenBlock = await ambiguousDeclarationTokenPatchBlock(
    "apply_patch",
    {
      path: "valid_service_ctl.py",
      search: "def start_service",
      replace: "def parse_arguments():\n    return object()",
    },
    { commandCwd: pythonQualityWorkspace }
  );
  assert(
    declarationTokenBlock?.category === "ambiguous-declaration-token-patch",
    "an incomplete declaration-token patch could remove its declaration identity"
  );
  const declarationTokenPreserved = await ambiguousDeclarationTokenPatchBlock(
    "apply_patch",
    {
      path: "valid_service_ctl.py",
      search: "def start_service",
      replace: "import argparse\n\ndef start_service",
    },
    { commandCwd: pythonQualityWorkspace }
  );
  assert(
    declarationTokenPreserved === null,
    "a declaration-token patch that preserves its identity was rejected"
  );
  await fs.writeFile(
    path.join(pythonQualityWorkspace, "partial_main_guard.py"),
    [
      "def main():",
      "    return 0",
      "",
      "if __name__ == \"__main__\":",
      "    result = main()",
      "    raise SystemExit(result)",
      "",
    ].join("\n"),
    "utf8"
  );
  const partialMainGuardBlock = await ambiguousPythonMainGuardPatchBlock(
    "apply_patch",
    {
      path: "partial_main_guard.py",
      search: "if __name__ == \"__main__\":\n    result = main()",
      replace: "def replacement_main():\n    return 0\n\nif __name__ == \"__main__\":\n    replacement_main()",
    },
    { commandCwd: pythonQualityWorkspace }
  );
  assert(
    partialMainGuardBlock?.category === "ambiguous-python-main-guard-patch",
    "an incomplete top-level Python main-guard replacement could orphan its remaining suite"
  );
  const completeMainGuardBlock = await ambiguousPythonMainGuardPatchBlock(
    "apply_patch",
    {
      path: "partial_main_guard.py",
      search: "if __name__ == \"__main__\":\n    result = main()\n    raise SystemExit(result)",
      replace: "if __name__ == \"__main__\":\n    raise SystemExit(main())",
    },
    { commandCwd: pythonQualityWorkspace }
  );
  assert(
    completeMainGuardBlock === null,
    "a complete top-level Python main-guard replacement was rejected"
  );
  const innerMainGuardStatement = await ambiguousPythonMainGuardPatchBlock(
    "apply_patch",
    {
      path: "partial_main_guard.py",
      search: "    result = main()",
      replace: "    result = int(main())",
    },
    { commandCwd: pythonQualityWorkspace }
  );
  assert(
    innerMainGuardStatement === null,
    "an exact inner statement patch inside a Python main guard was rejected"
  );
  const syntaxPreservingPatchBlock = await prospectivePythonExactPatchSyntaxBlock(
    "apply_patch",
    {
      path: "valid_service_ctl.py",
      search: "def start_service",
      replace: "import argparse\n\ndef start_service",
    },
    { commandCwd: pythonQualityWorkspace }
  );
  assert(
    syntaxPreservingPatchBlock === null,
    "prospective syntax validation rejected a parseable exact Python patch"
  );
  const existingSyntaxRepairBlock = await prospectivePythonExactPatchSyntaxBlock(
    "apply_patch",
    {
      path: "broken_service_ctl.py",
      search: "return parser.parse_args()",
      replace: "return parser.parse_args()",
    },
    { commandCwd: pythonQualityWorkspace }
  );
  assert(
    existingSyntaxRepairBlock === null,
    "prospective syntax validation deadlocked an already-invalid Python file"
  );
  assert(
    testCommandCoversMutatedPath(
      "python3 -m unittest discover -s tests -v",
      "tests/test_service_launch.py"
    ),
    "unittest discovery scope did not cover a changed test under its start directory"
  );
  assert(
    !testCommandCoversMutatedPath(
      "python3 -m unittest discover -s tests -v",
      "test_service_launch.py"
    ),
    "unittest discovery incorrectly covered a changed test outside its start directory"
  );
  await fs.writeFile(
    path.join(pythonQualityWorkspace, "test_service_launch.py"),
    "import unittest\n\nclass LaunchTest(unittest.TestCase):\n    def test_launch(self):\n        self.assertTrue(True)\n",
    "utf8"
  );
  const uncoveredTestQuality = await validateMutatedPythonSourceQuality(
    { commandCwd: pythonQualityWorkspace },
    {
      meta: {
        projectVerification: {
          mutationRevision: 2,
          mutationHistory: [{ revision: 2, paths: ["test_service_launch.py"] }],
          testRuns: [{
            command: "python3 -m unittest discover -s tests -v",
            mutationRevision: 2,
            privateMutationRevision: 0,
            passed: true,
          }],
        },
      },
    }
  );
  assert(
    uncoveredTestQuality.ok === false &&
      uncoveredTestQuality.defects[0]?.code === "mutated-test-not-covered-by-validation",
    "completion accepted a changed regression test that the successful test command could not discover"
  );
  await fs.mkdir(path.join(pythonQualityWorkspace, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(pythonQualityWorkspace, "tests", "test_service_launch.py"),
    "import unittest\n\nclass LaunchTest(unittest.TestCase):\n    def test_launch(self):\n        self.assertTrue(True)\n",
    "utf8"
  );
  const coveredTestQuality = await validateMutatedPythonSourceQuality(
    { commandCwd: pythonQualityWorkspace },
    {
      meta: {
        projectVerification: {
          mutationRevision: 3,
          mutationHistory: [{ revision: 3, paths: ["tests/test_service_launch.py"] }],
          testRuns: [{
            command: "python3 -m unittest discover -s tests -v",
            mutationRevision: 3,
            privateMutationRevision: 0,
            passed: true,
          }],
        },
      },
    }
  );
  assert(coveredTestQuality.ok === true, coveredTestQuality.reason);
  const coveredBeforeAcceptanceQuality = await validateMutatedPythonSourceQuality(
    { commandCwd: pythonQualityWorkspace },
    {
      meta: {
        projectVerification: {
          mutationRevision: 3,
          privateMutationRevision: 0,
          mutationHistory: [{ revision: 3, paths: ["tests/test_service_launch.py"] }],
          testRuns: [
            {
              command: "PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v",
              mutationRevision: 3,
              privateMutationRevision: 0,
              passed: true,
            },
            {
              command: "python3 /tmp/project_acceptance.py",
              mutationRevision: 3,
              privateMutationRevision: 0,
              passed: true,
            },
          ],
        },
      },
    }
  );
  assert(
    coveredBeforeAcceptanceQuality.ok === true,
    "a later passing acceptance verifier erased current unit-suite coverage for a changed test"
  );
  assert(normalizeDynamicStepsMode("off") === "off", "dynamic mode off did not normalize");
  for (const command of [
    "npm run build",
    "npm run lint",
    "npm run check",
    "node --check src/index.js",
    "python -m py_compile src/tool.py",
  ]) {
    assert(
      !isSubstantiveTestCommand(command),
      `a validation-only command was accepted as project test evidence: ${command}`
    );
  }
  for (const command of [
    "npm run test:publish",
    "npm run test:prepublishOnly",
    "npm run smoke:deploy",
    "npm run check:token",
    "npm run lint:install",
    "pnpm run smoke:prepare",
    "yarn test:prepack",
  ]) {
    const classification = classifyCommand(command);
    const policy = evaluateCommandPolicy(command, {
      allowShellTool: true,
      allowDestructive: false,
      sandboxMode: "host",
      useDockerSandbox: false,
      packageInstallPolicy: "block",
    });
    assert(
      classification.category === "blocked" && policy.allowed === false,
      `a dangerous package-script lifecycle bypassed strict host policy: ${command}`
    );
  }
  for (const command of [
    "make test --eval='$(shell npm publish)'",
    "gmake check -E 'test:; npm publish'",
    "make test X='$(file >report.md,changed)'",
  ]) {
    const classification = classifyCommand(command);
    const policy = evaluateCommandPolicy(command, {
      allowShellTool: true,
      allowDestructive: true,
      allowPasswords: true,
      sandboxMode: "host",
    });
    assert(
      classification.category === "blocked" &&
        classification.hardBlocked === true &&
        policy.allowed === false,
      `interpreter-owned validation evaluation bypassed the hard policy: ${command}`
    );
  }
  for (const command of [
    "ctest -S /tmp/attacker.cmake",
    "ctest --script=/tmp/attacker.cmake",
    "ctest --test-dir /tmp/attacker",
    "ctest --test-dir=/tmp/attacker",
    "ctest -D Experimental",
    "ctest --build-and-test /tmp/source /tmp/build --build-generator Ninja",
    "make test -f /tmp/attacker.mk",
    "make check --directory=/tmp/attacker",
    "cargo test --manifest-path /tmp/evil/Cargo.toml",
    "./gradlew test -b /tmp/evil.gradle",
    "dotnet test /tmp/evil.csproj",
    "go test /tmp/evil",
    "mvn test -f /tmp/evil-pom.xml",
  ]) {
    const classification = classifyCommand(command);
    const policy = evaluateCommandPolicy(command, {
      allowShellTool: true,
      allowDestructive: false,
      sandboxMode: "host",
      packageInstallPolicy: "block",
    });
    assert(
      classification.category === "general-shell" &&
        classification.substantiveTest !== true &&
        classification.writesWorkspace === true &&
        classification.mayMutateProject === true &&
        policy.allowed === false,
      `a delegated validation plan bypassed trusted shell policy: ${command}`
    );
  }
  for (const command of [
    "/tmp/pytest -q",
    "/tmp/cargo test",
    "../../evil/node --test",
    "/tmp/python tests/test_api.py",
  ]) {
    const classification = classifyCommand(command);
    const policy = evaluateCommandPolicy(command, {
      allowShellTool: true,
      allowDestructive: false,
      sandboxMode: "host",
      packageInstallPolicy: "block",
    });
    assert(
      classification.category === "general-shell" &&
        classification.substantiveTest !== true &&
        classification.writesWorkspace === true &&
        classification.mayMutateProject === true &&
        policy.allowed === false,
      `an out-of-workspace validation executable inherited trust from its basename: ${command}`
    );
  }
  for (const command of [
    `cargo test --manifest-path ${workspace}/Cargo.toml`,
    `ctest --test-dir ${workspace}/build`,
    `./gradlew test -b ${workspace}/build.gradle`,
    `dotnet test ${workspace}/app.csproj`,
    `go test ${workspace}/pkg`,
    `mvn test -f ${workspace}/pom.xml`,
  ]) {
    const policy = evaluateCommandPolicy(command, {
      commandCwd: workspace,
      allowShellTool: true,
      allowDestructive: false,
      sandboxMode: "host",
      packageInstallPolicy: "block",
    });
    assert(
      policy.allowed === true &&
        policy.category === "test" &&
        policy.substantiveTest === true,
      `a workspace-contained delegated validation plan was rejected: ${command}`
    );
  }
  const workspacePytestExecutable = path.join(workspace, "bin", "pytest");
  const workspaceExecutablePolicy = evaluateCommandPolicy(`${workspacePytestExecutable} -q`, {
    commandCwd: workspace,
    allowShellTool: true,
    allowDestructive: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
  });
  assert(
    workspaceExecutablePolicy.allowed === true &&
      workspaceExecutablePolicy.category === "test" &&
      workspaceExecutablePolicy.substantiveTest === true,
    "an absolute validation executable inside the current workspace was rejected"
  );
  for (const command of [
    "cargo test --help",
    "go test -h",
    "dotnet test --help",
    "ctest --help",
    "make test --help",
    "pytest --help",
    "python -m pytest --help",
    "pytest --collect-only",
    "pytest --co tests",
    "python -m pytest --collect-only tests",
    "python -m unittest --list-tests",
    "cargo test -- --list",
    "go test -list . ./...",
    "go test ./... -list TestName",
    "npm test -- --help",
  ]) {
    const classification = classifyCommand(command);
    assert(
      classification.category === "test" &&
        classification.substantiveTest === false &&
        !isSubstantiveTestCommand(command),
      `a help-only runner fabricated substantive test evidence: ${command}`
    );
  }
  for (const command of [
    "npm test",
    "make check",
    "python test_api.py",
    "python tests/test_api.py",
    "python -u tests/test_api.py",
    "python3 -X dev tests/test_api.py",
    "python tests\\test_api.py",
    "python3.11 -m pytest",
    "python3.12 tests/test_api.py",
    "npm test -- --coverage --runInBand",
    "npm run test -- --coverage --runInBand",
    "npm --prefix packages/api test -- --runInBand",
    "./mvnw test",
    "npm test && echo done",
    "npm test && git fetch",
    "git pull --ff-only && npm test",
    "npm test \\\n  -- --runInBand",
  ]) {
    assert(
      isSubstantiveTestCommand(command),
      `an actual project test command was not recognized: ${command}`
    );
  }
  for (const command of [
    "npm test; echo done",
    "npm test || echo failed",
    "npm test && git pull --ff-only",
    "npm test && git checkout feature-branch",
    "npm test &",
    "npm test & sed -i 's/old/new/' report.md",
    `node -e 'require("fs").writeFileSync("report.md", "changed")' --test`,
    "node test/unit.test.js --test",
  ]) {
    assert(
      !isSubstantiveTestCommand(command),
      `a failure-masking test sequence was accepted as project test evidence: ${command}`
    );
  }
  for (const command of [
    'git tag -a v1 -m "$(touch report.md)"',
    'git commit -m "release $HOME"',
    'git config user.name "`touch report.md`"',
  ]) {
    const classification = classifyCommand(command);
    assert(
      classification.gitOnly !== true && classification.category !== "git-workflow",
      `shell expansion was accepted as a bounded Git-only workflow: ${command}`
    );
  }
  const literalGitMessage = classifyCommand("git commit -m 'document $PATH and `literal`'");
  assert(
    literalGitMessage.category === "git-workflow" && literalGitMessage.gitOnly === true,
    "single-quoted literal Git prose was mistaken for active shell expansion"
  );
  assert(
    JSON.stringify(inferGitActionsFromCommand("git commit -m 'git push'")) === JSON.stringify(["commit"]),
    "quoted commit prose fabricated a Git push action"
  );
  assert(
    JSON.stringify(inferGitActionsFromCommand("git add report.md && git commit -m 'git push' && git push")) ===
      JSON.stringify(["add", "commit", "push"]),
    "top-level Git action parsing lost a real compound workflow"
  );
  for (const command of [
    'gh pr create --title "Fix" --body "Verified"',
    'glab mr create --title "Fix" --description "Verified"',
    'hub pull-request -m "Fix"',
  ]) {
    assert(
      JSON.stringify(inferGitActionsFromCommand(command)) === JSON.stringify(["pull-request"]),
      `a supported forge CLI lost pull-request evidence: ${command}`
    );
  }
  assert(
    JSON.stringify(
      inferGitActionsFromCommand(
        "git commit --allow-empty -m 'first' && git push && git commit --allow-empty -m 'second'"
      )
    ) === JSON.stringify(["commit", "push", "commit"]),
    "ordered Git action parsing collapsed a repeated consequential action"
  );
  assert(
    inferGitActionsFromCommand("git push 'origin\\\\'; true").length === 0,
    "a backslash inside single quotes hid a failure-masking shell separator"
  );
  assert(
    inferGitActionsFromCommand("echo ready # git push").length === 0,
    "a shell comment fabricated a Git action"
  );
  assert(
    inferGitActionsFromCommand("echo `printf ready; git push`").length === 0,
    "a command substitution fabricated a top-level Git action"
  );
  assert(
    inferGitActionsFromCommand("git push; git commit --allow-empty -m 'mask failed push'").length === 0,
    "a non-propagating shell sequence fabricated successful Git evidence"
  );
  const missingStandaloneGitAction = evaluateScsEvidence(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: ["push"],
      requiredGitRevision: 1,
    },
    buildScsEvidenceLedger({
      state: {
        messages: [
          toolMessage({
            toolName: "run_command",
            ok: true,
            exitCode: 0,
            args: { command: 'git push; printf "EXIT_CODE=%d\\n" "$?"' },
            stdout: "EXIT_CODE=1\n",
            goalRevision: 1,
          }),
        ],
      },
    })
  );
  assert(
    missingStandaloneGitAction.ok === false &&
      missingStandaloneGitAction.missingGitActions?.includes("push"),
    "an explicit missing Git action was ignored when external evidence was otherwise optional"
  );
  const staleMutationCommitEvidence = evaluateScsEvidence(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: ["commit"],
      requiredGitRevision: 5,
      requiredGitMutationRevision: 9,
    },
    buildScsEvidenceLedger({
      state: {
        messages: [
          toolMessage({
            toolName: "run_command",
            ok: true,
            exitCode: 0,
            args: { command: "git commit --allow-empty -m 'stale mutation'" },
            goalRevision: 5,
            projectMutationRevision: 8,
          }),
        ],
      },
    })
  );
  assert(
    !staleMutationCommitEvidence.ok && staleMutationCommitEvidence.missingGitActions?.includes("commit"),
    "a commit predating the latest project mutation satisfied Git evidence"
  );
  const currentMutationCommitEvidence = evaluateScsEvidence(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: ["commit"],
      requiredGitRevision: 5,
      requiredGitMutationRevision: 9,
    },
    buildScsEvidenceLedger({
      state: {
        messages: [
          toolMessage({
            toolName: "run_command",
            ok: true,
            exitCode: 0,
            args: { command: "git commit --allow-empty -m 'current mutation'" },
            goalRevision: 5,
            projectMutationRevision: 9,
          }),
        ],
      },
    })
  );
  assert(currentMutationCommitEvidence.ok, "a current-mutation commit was not accepted as Git evidence");
  const outOfOrderGitActions = evaluateScsEvidence(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: ["commit", "push"],
      requiredGitRevision: 1,
    },
    buildScsEvidenceLedger({
      state: {
        messages: [
          toolMessage({
            toolName: "run_command",
            ok: true,
            exitCode: 0,
            args: { command: "git push && git commit --allow-empty -m 'late commit'" },
            goalRevision: 1,
          }),
        ],
      },
    })
  );
  assert(
    outOfOrderGitActions.ok === false && outOfOrderGitActions.missingGitActions?.includes("push"),
    "a push performed before its required commit satisfied an ordered Git workflow"
  );
  const stalePushEvidence = evaluateScsEvidence(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: ["commit", "push"],
      requiredGitRevision: 1,
    },
    buildScsEvidenceLedger({
      state: {
        messages: [
          toolMessage({
            toolName: "run_command",
            ok: true,
            exitCode: 0,
            args: {
              command:
                "git commit --allow-empty -m 'first' && git push && git commit --allow-empty -m 'second'",
            },
            goalRevision: 1,
          }),
        ],
      },
    })
  );
  assert(
    stalePushEvidence.ok === false && stalePushEvidence.missingGitActions?.includes("push"),
    "a commit after the required push left stale push evidence accepted"
  );
  const refreshedPushEvidence = evaluateScsEvidence(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: ["commit", "push"],
      requiredGitRevision: 1,
    },
    buildScsEvidenceLedger({
      state: {
        messages: [
          toolMessage({
            toolName: "run_command",
            ok: true,
            exitCode: 0,
            args: {
              command:
                "git commit --allow-empty -m 'first' && git push && git commit --allow-empty -m 'second' && git push && git status --short",
            },
            goalRevision: 1,
          }),
        ],
      },
    })
  );
  assert(refreshedPushEvidence.ok === true, "a final successful re-push did not refresh Git evidence");
  const mergedCorrectionGitContract = {
    requiresExternalEvidence: false,
    requiredEvidence: [],
    requiredToolCalls: [],
    requiredGitActions: ["push", "commit"],
    requiredGitRevision: 1,
  };
  const mergedCorrectionStalePush = evaluateScsEvidence(
    mergedCorrectionGitContract,
    buildScsEvidenceLedger({
      state: {
        messages: [
          toolMessage({
            toolName: "run_command",
            ok: true,
            exitCode: 0,
            args: { command: "git push && git commit --allow-empty -m 'correction'" },
            goalRevision: 1,
          }),
        ],
      },
    })
  );
  assert(
    !mergedCorrectionStalePush.ok && mergedCorrectionStalePush.missingGitActions.includes("push"),
    "a fresh correction commit remained accepted after only an earlier required push"
  );
  const mergedCorrectionFreshPush = evaluateScsEvidence(
    mergedCorrectionGitContract,
    buildScsEvidenceLedger({
      state: {
        messages: [
          toolMessage({
            toolName: "run_command",
            ok: true,
            exitCode: 0,
            args: { command: "git commit --allow-empty -m 'correction' && git push" },
            goalRevision: 1,
          }),
        ],
      },
    })
  );
  assert(
    mergedCorrectionFreshPush.ok,
    "a correction commit followed by its fresh push did not satisfy the merged Git contract"
  );
  const mirroredPushPayload = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "git push" },
    goalRevision: 1,
  };
  const mirroredCommitPayload = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "git commit --allow-empty -m 'late commit'" },
    goalRevision: 1,
  };
  const mirroredOutOfOrderGitActions = evaluateScsEvidence(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: ["commit", "push"],
      requiredGitRevision: 1,
    },
    buildScsEvidenceLedger({
      state: {
        messages: [toolMessage(mirroredPushPayload), toolMessage(mirroredCommitPayload)],
      },
      context: {
        events: [
          { type: "tool.completed", data: mirroredPushPayload },
          { type: "tool.completed", data: mirroredCommitPayload },
        ],
      },
    })
  );
  assert(
    mirroredOutOfOrderGitActions.ok === false &&
      mirroredOutOfOrderGitActions.missingGitActions?.includes("push"),
    "mirrored event and message evidence fabricated an ordered Git workflow"
  );
  assert(
    JSON.stringify(
      inferSuccessfulGitActionsFromCommandResult({
        toolName: "run_command",
        ok: true,
        exitCode: 0,
        args: { command: 'git push; printf "EXIT_CODE=%d\\n" "$?"' },
        stdout: "EXIT_CODE=0\n",
      })
    ) === JSON.stringify(["push"]),
    "a verified zero-status Git wrapper lost its durable action evidence"
  );
  assert(
    inferSuccessfulGitActionsFromCommandResult({
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command: 'git push; printf "EXIT_CODE=%d\\n" "$?"' },
      stdout: "EXIT_CODE=1\n",
    }).length === 0,
    "a failed wrapped Git command fabricated durable action evidence"
  );
  for (const command of ["git push &", "git push & true", "git push & wait"]) {
    assert(
      inferSuccessfulGitActionsFromCommandResult({
        toolName: "run_command",
        ok: true,
        exitCode: 0,
        args: { command },
      }).length === 0,
      `a backgrounded Git command fabricated durable action evidence: ${command}`
    );
  }
  const expandedReadOnly = classifyCommand('git status "$(touch report.md)"');
  assert(
    expandedReadOnly.writesWorkspace === true && expandedReadOnly.category === "general-shell",
    "active expansion was accepted as a bounded read-only command"
  );
  for (const command of ["git rev-parse --show-toplevel", "git ls-files", "python3.11 --version"]) {
    assert(
      classifyCommand(command).writesWorkspace === false,
      `a common bounded read-only command was treated as a project mutation: ${command}`
    );
  }
  const acceptanceValidator =
    "python3 /tmp/supervision/acceptance/context_contract.py --root /tmp/workspace --phase final";
  const acceptanceClassification = classifyCommand(acceptanceValidator);
  assert(
    acceptanceClassification.category === "test" &&
      acceptanceClassification.writesWorkspace === false &&
      acceptanceClassification.substantiveTest === true,
    "a structurally named Python acceptance validator was treated as an arbitrary mutating script"
  );
  const externalAcceptanceValidator =
    "/opt/conda/bin/python /tmp/supervision/acceptance/webapp_booking_contract.py";
  const externalAcceptanceClassification = classifyCommand(externalAcceptanceValidator);
  assert(
    externalAcceptanceClassification.category === "general-shell" &&
      externalAcceptanceClassification.writesWorkspace === true &&
      externalAcceptanceClassification.mayMutateProject === true &&
      externalAcceptanceClassification.semanticMayMutateProject === false,
    "trusted-shell authorization for an external Python validator was conflated with project mutation"
  );
  assert(
    classifyCommand(`${acceptanceValidator} --output report.json`).writesWorkspace === true,
    "a Python acceptance validator with an explicit output destination was treated as read-only"
  );
  assert(
    shellDiagnosticHint("git commit -m 'update'", {
      ok: false,
      stdout: "Changes not staged for commit:\nno changes added to commit",
    }).includes("stage only the task-owned paths"),
    "a failed unstaged Git commit did not provide bounded staging recovery"
  );
  for (const command of [
    "curl -o report.md https://example.com/report.md",
    "curl -oreport.md https://example.com/report.md",
    "curl --output=report.md https://example.com/report.md",
    "wget https://example.com/report.md",
    "wget -Oreport.md https://example.com/report.md",
    "wget --output-document=report.md https://example.com/report.md",
  ]) {
    const classification = classifyCommand(command);
    assert(
      classification.category === "network-fetch" &&
        classification.writesWorkspace === true &&
        classification.mayMutateProject === true,
      `a file-producing network fetch escaped workspace mutation tracking: ${command}`
    );
  }
  for (const command of [
    "curl https://example.com/status",
    "curl -o /dev/null https://example.com/status",
    "curl -T report.md https://example.com/upload",
    "wget --spider https://example.com/status",
    "wget -O- https://example.com/status",
  ]) {
    const classification = classifyCommand(command);
    assert(
      classification.category === "network-fetch" && classification.writesWorkspace === false,
      `a non-writing network transfer fabricated a workspace mutation: ${command}`
    );
  }
  for (const command of [
    "npm run build",
    "npm run lint:fix",
    "npm run check:write",
    "npm run test:update-snapshots",
    "npm test -- --updateSnapshot",
    "pnpm lint --fix",
    "yarn lint --write",
    "bun run check --fix",
    "pytest --snapshot-update",
    "node --test --test-update-snapshots",
  ]) {
    const classification = classifyCommand(command);
    assert(
      classification.writesWorkspace === true && classification.mayMutateProject === true,
      `a write-capable validation command was treated as non-mutating: ${command}`
    );
  }
  const requiredCommandMarkdown = [
    "# Task",
    "",
    "The validation commands must run before completion:",
    "",
    "```bash",
    "npm run check",
    "npm test",
    "python scripts/verify.py \\",
    "  --strict",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(requiredCommandMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(["npm run check", "npm test", "python scripts/verify.py --strict"]),
    "a fenced acceptance block did not preserve separate commands and explicit continuations"
  );
  assert(
    projectAcceptanceFromMarkdown(
      requiredCommandMarkdown,
      "agentic_tools/android_device_agent/README.md"
    ).requiredCommands.length === 0,
    "an arbitrary nested README gained task-wide acceptance authority"
  );
  assert(
    JSON.stringify(
      projectAcceptanceFromMarkdown(
        requiredCommandMarkdown,
        "docs/TASK.md",
        { authoritativePaths: ["docs/TASK.md"] }
      ).requiredCommands
    ) === JSON.stringify(["npm run check", "npm test", "python scripts/verify.py --strict"]),
    "an explicitly declared nested task instruction lost acceptance authority"
  );
  const consoleTranscriptMarkdown = [
    "# Usage",
    "",
    "The validation command must run before completion:",
    "",
    "```console",
    "$ npm test",
    "Server listening on 3000",
    "Ready",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(consoleTranscriptMarkdown, "README.md").requiredCommands) ===
      JSON.stringify(["npm test"]),
    "console output lines were mistaken for required shell commands"
  );
  const operatorGuideMarkdown = [
    "# Service",
    "",
    "The controller must provide start, status, restart, and stop.",
    "",
    "## Operator Guidance",
    "",
    "### Start the service",
    "",
    "```bash",
    "python3 service_ctl.py start --state-dir .runtime",
    "```",
    "",
    "### Check service status",
    "",
    "```bash",
    "python3 service_ctl.py status --state-dir .runtime",
    "```",
    "",
    "## Running Tests",
    "",
    "Run the visible regression suite with:",
    "",
    "```bash",
    "python3 -m unittest discover -s tests -v",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(operatorGuideMarkdown, "README.md").requiredCommands) ===
      JSON.stringify(["python3 -m unittest discover -s tests -v"]),
    "ordinary operator examples became mandatory acceptance commands"
  );
  const refreshedAcceptanceState = {
    commandCwd: workspace,
    meta: {
      projectVerification: {
        requiredOutputs: ["stale-output.txt"],
        requiredCommands: [
          "python3 service_ctl.py start --state-dir .runtime",
          "python3 service_ctl.py status --state-dir .runtime",
        ],
        acceptanceSource: "README.md",
      },
    },
  };
  recordProjectVerificationOutcome(
    refreshedAcceptanceState,
    {
      ok: true,
      toolName: "read_file",
      path: "README.md",
      content: operatorGuideMarkdown,
    },
    { commandCwd: workspace, taskProfile: "devops" }
  );
  assert(
    JSON.stringify(refreshedAcceptanceState.meta.projectVerification.requiredCommands) ===
      JSON.stringify(["python3 -m unittest discover -s tests -v"]) &&
      refreshedAcceptanceState.meta.projectVerification.requiredOutputs.length === 0,
    "rereading one authoritative source retained its stale acceptance requirements"
  );
  const resumedAcceptanceWorkspace = path.join(workspace, "resumed-acceptance");
  await fs.mkdir(resumedAcceptanceWorkspace, { recursive: true });
  await fs.writeFile(
    path.join(resumedAcceptanceWorkspace, "README.md"),
    operatorGuideMarkdown,
    "utf8"
  );
  const resumedAcceptanceState = {
    commandCwd: resumedAcceptanceWorkspace,
    goal: "Repair the service and run its tests.",
    meta: {
      goalContract: { revision: 4, currentRequest: "Repair the service and run its tests." },
      projectVerification: {
        requiredCommands: [
          "python3 service_ctl.py start --state-dir .runtime",
          "python3 service_ctl.py status --state-dir .runtime",
        ],
        acceptanceSource: "README.md",
      },
    },
  };
  resetSameTaskExecutionContract(resumedAcceptanceState, 4);
  assert(
    JSON.stringify(resumedAcceptanceState.meta.projectVerification.requiredCommands) ===
      JSON.stringify(["python3 -m unittest discover -s tests -v"]),
    "same-task resume retained stale requirements from an older README parser"
  );
  recordProjectVerificationOutcome(
    refreshedAcceptanceState,
    {
      ok: true,
      toolName: "read_file",
      path: "TASK.md",
      content: requiredCommandMarkdown,
    },
    { commandCwd: workspace, taskProfile: "devops" }
  );
  assert(
    JSON.stringify(refreshedAcceptanceState.meta.projectVerification.requiredCommands) ===
      JSON.stringify([
        "python3 -m unittest discover -s tests -v",
        "npm run check",
        "npm test",
        "python scripts/verify.py --strict",
      ]),
    "source-scoped acceptance refresh discarded a distinct authoritative source"
  );
  const operatorContinuedCommandMarkdown = [
    "# Task",
    "",
    "The validation commands must run before completion:",
    "",
    "```bash",
    "npm run check &&",
    "  npm test",
    "python scripts/verify.py --label \"two",
    "  words\"",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(operatorContinuedCommandMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(["npm run check && npm test", 'python scripts/verify.py --label "two words"']),
    "operator- or quote-continued acceptance commands were split into impossible requirements"
  );
  const backtickContinuedCommandMarkdown = [
    "# Task",
    "",
    "The validation command must run before completion:",
    "",
    "```bash",
    "echo `printf foo",
    "bar`",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(
      projectAcceptanceFromMarkdown(backtickContinuedCommandMarkdown, "TASK.md").requiredCommands
    ) === JSON.stringify(["echo `printf foo bar`"]),
    "a multiline backtick substitution was split into impossible requirements"
  );
  const statefulCommandMarkdown = [
    "# Task",
    "The validation commands must run before completion:",
    "```bash",
    "cd packages/api",
    "npm test",
    "npm run check",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(statefulCommandMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(["cd packages/api && npm test", "cd packages/api && npm run check"]),
    "a stateful validation fence lost its working-directory context"
  );
  const compoundCommandMarkdown = [
    "# Task",
    "The validation commands must run before completion:",
    "```bash",
    "for file in a b; do",
    '  test -f "$file"',
    "done",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(compoundCommandMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(['for file in a b; do\n  test -f "$file"\ndone']),
    "a compound validation script was split into non-executable lines"
  );
  const functionCommandMarkdown = [
    "# Task",
    "The validation commands must run before completion:",
    "```bash",
    "verify() {",
    "  printf 'ok\\n'",
    "}",
    "verify",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(functionCommandMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(["verify() {\n  printf 'ok\\n'\n} && verify"]),
    "a shell function definition was not retained with its invocation"
  );
  const keywordFunctionCommandMarkdown = [
    "# Task",
    "The validation commands must run before completion:",
    "```bash",
    "function verify() {",
    "  printf 'ok\\n'",
    "}",
    "verify",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(keywordFunctionCommandMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(["function verify() {\n  printf 'ok\\n'\n} && verify"]),
    "a function keyword plus parenthesized name was split from its body"
  );
  const commandSubstitutionMarkdown = [
    "# Task",
    "The validation commands must run before completion:",
    "```bash",
    "value=$(",
    "  printf ok",
    ")",
    'printf "%s\\n" "$value"',
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(commandSubstitutionMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(['value=$( printf ok ) && printf "%s\\n" "$value"']),
    "a multiline command substitution was split from its assignment context"
  );
  const processSubstitutionMarkdown = [
    "# Task",
    "The validation commands must run before completion:",
    "```bash",
    "diff <(",
    "  printf a",
    ") <(",
    "  printf b",
    ")",
    "npm test",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(processSubstitutionMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(["diff <( printf a ) <( printf b )", "npm test"]),
    "multiline process substitutions were split into impossible acceptance commands"
  );
  const arrayAssignmentMarkdown = [
    "# Task",
    "The validation commands must run before completion:",
    "```bash",
    "files=(",
    "  a",
    "  b",
    ")",
    'printf "%s\\n" "${files[@]}"',
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(arrayAssignmentMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(['files=(\n  a\n  b\n) && printf "%s\\n" "${files[@]}"']),
    "a multiline array assignment was split into malformed validation commands"
  );
  const heredocCommandMarkdown = [
    "# Task",
    "The validation command must run before completion:",
    "```bash",
    "python - <<'PY'",
    'print("ok")',
    "# retained heredoc content",
    "PY",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(heredocCommandMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(["python - <<'PY'\nprint(\"ok\")\n# retained heredoc content\nPY"]),
    "a heredoc validation script lost its body or terminator"
  );
  const heredocRequiredCommands = projectAcceptanceFromMarkdown(
    heredocCommandMarkdown,
    "TASK.md"
  ).requiredCommands;
  const heredocContract = augmentScsTaskContractWithProjectVerification(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: [],
      taskProfile: "code",
    },
    {
      meta: {
        projectVerification: { requiredCommands: heredocRequiredCommands },
      },
    },
    { taskProfile: "code" }
  );
  assert(
    JSON.stringify(heredocContract.requiredProjectCommands) ===
      JSON.stringify(heredocRequiredCommands),
    "a multiline required command was flattened while entering the evidence contract"
  );
  for (const [opener, label] of [
    ["cat <<\\EOF", "escaped"],
    ['cat <<E"OF"', "partially quoted"],
    ["cat <<'E'OF", "concatenated quoted"],
  ]) {
    const markdown = [
      "# Task",
      "The validation command must run before completion:",
      "```bash",
      opener,
      "payload",
      "EOF",
      "```",
    ].join("\n");
    assert(
      JSON.stringify(projectAcceptanceFromMarkdown(markdown, "TASK.md").requiredCommands) ===
        JSON.stringify([`${opener}\npayload\nEOF`]),
      `${label} heredoc delimiter quote removal lost the body or terminator`
    );
  }
  const literalHeredocMarkdown = [
    "# Task",
    "The validation command must run before completion:",
    "```bash",
    "cat <<'EOF'",
    "it's literal",
    "left\\",
    "right",
    "EOF",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(literalHeredocMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(["cat <<'EOF'\nit's literal\nleft\\\nright\nEOF"]),
    "quoted heredoc payload bytes were changed by shell continuation folding"
  );
  const arithmeticShiftMarkdown = [
    "# Task",
    "The validation commands must run before completion:",
    "```bash",
    "((mask = 1 << 2))",
    "echo $((mask << 1))",
    "npm test",
    "```",
  ].join("\n");
  assert(
    JSON.stringify(projectAcceptanceFromMarkdown(arithmeticShiftMarkdown, "TASK.md").requiredCommands) ===
      JSON.stringify(["((mask = 1 << 2))", "echo $((mask << 1))", "npm test"]),
    "arithmetic shifts were mistaken for heredoc openers"
  );
  for (const command of [
    'npm test -- --testNamePattern "renders dashboard"',
    'pytest -k "not slow"',
    "node --test test/shell-syntax.test.js",
    'cargo test "quoted filter"',
    'go test ./... -run "Test Quoted Filter"',
    'dotnet test --filter "FullyQualifiedName~Quoted Filter"',
    './mvnw test -Dtest="Quoted Filter"',
    './gradlew test --tests "example.Quoted Filter"',
    'ctest -R "Quoted Filter"',
    'make check LABEL="quoted filter"',
  ]) {
    const classification = classifyCommand(command);
    assert(
      classification.category === "test" &&
        classification.substantiveTest === true &&
        isSubstantiveTestCommand(command),
      `a bounded filtered test invocation lost test identity: ${command}`
    );
  }
  for (const command of [
    "go test -c",
    "cargo test --no-run",
    "ctest -N",
    "dotnet test --list-tests",
    "./gradlew test -x test",
    "./mvnw test -DskipTests",
    "make test -n",
  ]) {
    const classification = classifyCommand(command);
    assert(
      classification.category === "test" &&
        classification.substantiveTest === false &&
        !isSubstantiveTestCommand(command),
      `a compile/list/skip-only runner fabricated substantive test evidence: ${command}`
    );
  }
  for (const command of [
    "node --test --test-reporter-destination=reports/node-tests.txt",
    "go test ./... -coverprofile=reports/go-cover.out",
    "ctest --output-junit reports/ctest-junit.xml",
    'python -m pytest --junitxml "reports/test output.xml"',
    "python3 -m pytest --html=reports/pytest.html",
  ]) {
    const classification = classifyCommand(command);
    assert(
      classification.category === "test" &&
        classification.writesWorkspace === true &&
        classification.mayMutateProject === true,
      `a test-runner output destination bypassed project mutation tracking: ${command}`
    );
  }
  for (const command of [
    "node --test src/shell-syntax.js",
    "node --test tests/../src/shell-syntax.js",
    "node --test test/../../src/shell-syntax.js",
    "node --test --help",
    "node --test --version",
    "node -v --test",
    "node --test -v",
    "node --test /dev/null",
    "node --test scripts/generate",
    "node --test README",
    "python tests/update_fixtures.py",
  ]) {
    assert(
      !isSubstantiveTestCommand(command),
      `a helper or ordinary source module fabricated substantive test evidence: ${command}`
    );
  }
  for (const command of [
    "node --test --require=./test/setup.js",
    "node --test -r ./test/setup.js",
    "node --test --import=./test/setup.js",
    "node --test --loader ./test/loader.js",
    "node --test --experimental-loader=./test/loader.js",
    "node --test --test-global-setup=./test/setup.js",
    "node --test --test-reporter=./test/reporter.js",
    "node --test --require ./setup.js test/foo.test.js",
    "node --test --test-reporter=./reporter.js test/foo.test.js",
  ]) {
    const classification = classifyCommand(command);
    assert(
      classification.category === "test" &&
        classification.substantiveTest === true &&
        classification.writesWorkspace === true &&
        classification.mayMutateProject === true,
      `an executable Node test hook bypassed project mutation tracking: ${command}`
    );
  }
  const nodeZeroTestState = { meta: { goalContract: { revision: 1 } } };
  const nodeZeroTestResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "node --test" },
    stdout: "TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(nodeZeroTestState, nodeZeroTestResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    nodeZeroTestResult.projectTest?.zeroTests === true &&
      nodeZeroTestResult.projectTest?.passed === false,
    "a successful Node runner invocation with zero tests fabricated passing evidence"
  );
  const invalidPytestState = { meta: { goalContract: { revision: 1 } } };
  const invalidPytestResult = {
    toolName: "run_command",
    ok: false,
    exitCode: 4,
    args: {
      command: "python -m pytest .aginti/verification/lifecycle/missing_suite.py",
    },
    stdout: "collected 0 items\n\n============================ no tests ran in 0.00s ============================\n",
    stderr:
      "ERROR: file or directory not found: .aginti/verification/lifecycle/missing_suite.py\n",
  };
  recordProjectVerificationOutcome(invalidPytestState, invalidPytestResult, {
    commandCwd: workspace,
    taskProfile: "devops",
  });
  const invalidPytestRuntime = nextStepRuntimeConfig(
    { goal: "Repair the service lifecycle.", commandCwd: workspace, taskProfile: "devops" },
    invalidPytestState
  );
  assert(
    !invalidPytestResult.projectTest &&
      invalidPytestResult.projectTestDiscoveryFailure?.invalidInvocation === true &&
      invalidPytestState.meta.projectVerification.testRuns.length === 0 &&
      invalidPytestState.meta.projectVerification.invalidTestInvocations.length === 1 &&
      invalidPytestRuntime.testFailureRepairActive !== true,
    "a nonexistent pytest target became an authoritative source-failure repair gate"
  );
  invalidPytestState.meta.projectVerification.testRuns = [
    {
      command: invalidPytestResult.args.command,
      mutationRevision: 0,
      privateMutationRevision: 0,
      passed: false,
      failureSignature: "legacy-missing-pytest-target",
      failureSummary:
        "Failing tests: file or directory not found: .aginti/verification/lifecycle/missing_suite.py.",
    },
  ];
  assert(
    nextStepRuntimeConfig(
      { goal: "Repair the service lifecycle.", commandCwd: workspace, taskProfile: "devops" },
      invalidPytestState
    ).testFailureRepairActive !== true &&
      projectTestVerificationFinishBlock(invalidPytestState) === null,
    "a persisted legacy missing-test-path run reopened source-failure repair after restart"
  );
  const nodeAllSkippedState = { meta: { goalContract: { revision: 1 } } };
  const nodeAllSkippedResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "node --test --test-name-pattern=nomatch test/foo.test.js" },
    stdout:
      "TAP version 13\n1..1\n# tests 1\n# pass 0\n# fail 0\n# skipped 1\n# cancelled 0\n# todo 0\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(nodeAllSkippedState, nodeAllSkippedResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    nodeAllSkippedResult.projectTest?.zeroTests === true &&
      nodeAllSkippedResult.projectTest?.passed === false,
    "an all-skipped Node test run fabricated executed test evidence"
  );
  const nodePartiallySkippedState = { meta: { goalContract: { revision: 1 } } };
  const nodePartiallySkippedResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "node --test test/foo.test.js" },
    stdout:
      "TAP version 13\n1..2\n# tests 2\n# pass 1\n# fail 0\n# skipped 1\n# cancelled 0\n# todo 0\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(nodePartiallySkippedState, nodePartiallySkippedResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    nodePartiallySkippedResult.projectTest?.zeroTests === false &&
      nodePartiallySkippedResult.projectTest?.passed === true,
    "a mixed pass/skip Node run was incorrectly reduced to zero executed tests"
  );
  for (const [command, stdout] of [
    ["cargo test missing_filter", "running 0 tests\n\ntest result: ok. 0 passed; 0 failed"],
    ["go test ./... -run Missing", "testing: warning: no tests to run\nPASS\nok example/pkg 0.002s [no tests to run]"],
    ["./mvnw test -Dtest=Missing", "Tests run: 0, Failures: 0, Errors: 0, Skipped: 0"],
    ["dotnet test --filter Missing", "Total tests: 0\nPassed: 0"],
    ["./gradlew test", "> Task :test NO-SOURCE\n\nBUILD SUCCESSFUL in 1s"],
  ]) {
    const state = { meta: { goalContract: { revision: 1 } } };
    const result = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout,
      stderr: "",
    };
    recordProjectVerificationOutcome(state, result, {
      commandCwd: workspace,
      taskProfile: "code",
    });
    assert(
      result.projectTest?.zeroTests === true && result.projectTest?.passed === false,
      `a native runner's zero-test output fabricated passing evidence: ${command}`
    );
  }
  const mixedCargoState = { meta: { goalContract: { revision: 1 } } };
  const mixedCargoResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "cargo test" },
    stdout: "running 2 tests\n..\ntest result: ok. 2 passed\nrunning 0 tests\ntest result: ok. 0 passed",
    stderr: "",
  };
  recordProjectVerificationOutcome(mixedCargoState, mixedCargoResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    mixedCargoResult.projectTest?.zeroTests === false && mixedCargoResult.projectTest?.passed === true,
    "a zero-test subgroup erased positive native-runner execution evidence"
  );
  const mixedGoState = { meta: { goalContract: { revision: 1 } } };
  const mixedGoResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "go test ./..." },
    stdout: "? example/cmd [no test files]\nok example/pkg 0.012s\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(mixedGoState, mixedGoResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    mixedGoResult.projectTest?.zeroTests === false && mixedGoResult.projectTest?.passed === true,
    "a package without Go tests erased positive execution evidence from another package"
  );
  const testThenLintFixState = { meta: { goalContract: { revision: 1 } } };
  const testThenLintFixResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "npm test && npm run lint:fix" },
    stdout: "1 test passed\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(testThenLintFixState, testThenLintFixResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    testThenLintFixState.meta.projectVerification?.mutationRevision === 1 &&
      !testThenLintFixResult.projectTest,
    "a mutating npm script suffix preserved stale test evidence"
  );
  const backgroundTestState = { meta: { goalContract: { revision: 1 } } };
  const backgroundTestResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "npm test &" },
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(backgroundTestState, backgroundTestResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    backgroundTestState.meta.projectVerification?.mutationRevision === 1 &&
      !backgroundTestResult.projectTest,
    "a background test launch fabricated passing evidence or preserved stale verification"
  );
  const directPythonTestState = { meta: {} };
  const directPythonTestResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "python tests/test_api.py" },
    stdout: "Ran 3 tests\nOK\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(directPythonTestState, directPythonTestResult, {
    commandCwd: workspace,
    taskProfile: "python",
  });
  assert(
    directPythonTestResult.projectTest?.passed === true &&
      directPythonTestState.meta.projectVerification?.mutationRevision === 0,
    "a direct Python test script was treated as a source mutation or lost its test evidence"
  );
  for (const command of [
    "python -u tests/test_api.py",
    "python3 -X dev tests/test_api.py",
    "python tests\\test_api.py",
  ]) {
    const result = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout: "Ran 3 tests\nOK\n",
      stderr: "",
    };
    const state = { meta: {} };
    recordProjectVerificationOutcome(state, result, {
      commandCwd: workspace,
      taskProfile: "python",
    });
    assert(
      result.projectTest?.passed === true &&
        state.meta.projectVerification?.mutationRevision === 0,
      `a bounded Python test invocation lost test identity: ${command}`
    );
  }
  const snapshotUpdateState = { meta: { goalContract: { revision: 1 } } };
  const snapshotUpdateResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "npm test -- --updateSnapshot" },
    stdout: "1 test passed\n1 snapshot updated\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(snapshotUpdateState, snapshotUpdateResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    snapshotUpdateState.meta.projectVerification?.mutationRevision === 1 &&
      snapshotUpdateResult.projectTest?.passed === true &&
      snapshotUpdateResult.projectTest?.mutationRevision === 1,
    "a snapshot-updating test did not retain test identity at its new mutation revision"
  );
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
  const failedNumericExitProbeState = { meta: {} };
  const failedNumericExitProbeResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: 'npm test; printf "EXIT_CODE=%d\\n" "$?"' },
    stdout: "EXIT_CODE=1\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(failedNumericExitProbeState, failedNumericExitProbeResult, {
    commandCwd: workspace,
    taskProfile: "qa",
  });
  assert(
    failedNumericExitProbeResult.projectTest?.passed === false &&
      failedNumericExitProbeResult.projectTest?.explicitExitStatus === 1,
    "a numeric wrapped nonzero test status was recorded as passing"
  );
  const failedSpacedExitProbeState = { meta: {} };
  const failedSpacedExitProbeResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: 'npm test; echo "EXIT: $?"' },
    stdout: "tests failed\nEXIT: 1\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(failedSpacedExitProbeState, failedSpacedExitProbeResult, {
    commandCwd: workspace,
    taskProfile: "qa",
  });
  assert(
    failedSpacedExitProbeResult.projectTest?.passed === false &&
      failedSpacedExitProbeResult.projectTest?.explicitExitStatus === 1,
    "a spaced nonzero test-status wrapper was recorded as successful generic evidence"
  );
  for (const [command, output, expectedRevision] of [
    ['npm test; printf "EXIT_CODE=%d\\n" "$?"', "EXIT_CODE=0\n", 0],
    ['git push; echo "EXIT=$?"', "EXIT=0\n", 0],
    ['npm run build; printf "EXIT_CODE=%d\\n" "$?"', "EXIT_CODE=0\n", 1],
  ]) {
    const state = { meta: { goalContract: { revision: 1 } } };
    const result = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout: output,
      stderr: "",
    };
    recordProjectVerificationOutcome(state, result, {
      commandCwd: workspace,
      taskProfile: "code",
    });
    assert(
      state.meta.projectVerification?.mutationRevision === expectedRevision,
      `a status wrapper changed the inner command's mutation identity: ${command}`
    );
  }
  const readOnlyValidatorState = { meta: { goalContract: { revision: 1 } } };
  const readOnlyValidatorResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command:
        'python3 tmp/external_agent_reliability_quality.py . ; echo "EXIT=$?"',
    },
    stdout: "agent reliability research contract passed\nEXIT=1\n",
    stderr: "agent reliability research quality failed\n",
    commandPolicy: {
      category: "toolchain",
      writesWorkspace: true,
      mayMutateProject: false,
      substantiveTest: false,
    },
  };
  recordProjectVerificationOutcome(readOnlyValidatorState, readOnlyValidatorResult, {
    commandCwd: workspace,
    taskProfile: "writing",
  });
  assert(
    readOnlyValidatorState.meta.projectVerification?.mutationRevision === 0 &&
      readOnlyValidatorResult.projectMutationRevision === 0,
    "a semantically read-only validator fabricated project mutation progress"
  );
  const externalReadOnlyValidatorState = { meta: { goalContract: { revision: 1 } } };
  const externalReadOnlyValidatorCommand =
    "cd . && /opt/conda/bin/python /tmp/supervision/acceptance/webapp_booking_contract.py && git status --short";
  const externalReadOnlyValidatorResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: externalReadOnlyValidatorCommand },
    stdout: "webapp booking contract: PASS\n",
    stderr: "",
    commandPolicy: classifyCommand(externalReadOnlyValidatorCommand),
  };
  recordProjectVerificationOutcome(
    externalReadOnlyValidatorState,
    externalReadOnlyValidatorResult,
    {
      commandCwd: workspace,
      taskProfile: "app",
      sandboxMode: "host",
    }
  );
  assert(
    externalReadOnlyValidatorState.meta.projectVerification?.mutationRevision === 0 &&
      externalReadOnlyValidatorResult.projectMutationRevision === 0,
    "an absolute-interpreter acceptance validator forced a post-validation commit"
  );
  const shellMutationState = { meta: { goalContract: { revision: 1 } } };
  const shellMutationResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "sed -i 's/old/new/' report.md" },
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(shellMutationState, shellMutationResult, {
    commandCwd: workspace,
    taskProfile: "writing",
    allowShellTool: true,
    allowDestructive: true,
    sandboxMode: "host",
  });
  assert(
    shellMutationState.meta.projectVerification?.mutationRevision === 1 &&
      shellMutationResult.projectMutationRevision === 1,
    "a successful shell edit did not advance project mutation evidence"
  );
  const fileDeletionState = { meta: { goalContract: { revision: 1 } } };
  const fileDeletionResult = {
    toolName: "apply_patch",
    ok: true,
    changes: [
      {
        action: "apply_patch_delete",
        path: "obsolete.js",
        beforeHash: "before",
        afterHash: null,
        beforeBytes: 10,
        afterBytes: 0,
        deleted: true,
      },
    ],
  };
  recordProjectVerificationOutcome(fileDeletionState, fileDeletionResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    fileDeletionState.meta.projectVerification?.mutationRevision === 1 &&
      fileDeletionState.meta.projectVerification?.lastMutation?.paths?.includes("obsolete.js"),
    "a successful file deletion preserved stale project verification"
  );
  const noOpOverwriteState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        mutationRevision: 2,
        testRuns: [{ passed: true, mutationRevision: 2 }],
      },
    },
  };
  const noOpOverwriteResult = {
    toolName: "write_file",
    ok: true,
    path: "report.md",
    change: {
      action: "overwrite_file",
      path: "report.md",
      beforeHash: "unchanged",
      afterHash: "unchanged",
      beforeBytes: 42,
      afterBytes: 42,
    },
  };
  recordProjectVerificationOutcome(noOpOverwriteState, noOpOverwriteResult, {
    commandCwd: workspace,
    taskProfile: "writing",
  });
  assert(
    noOpOverwriteState.meta.projectVerification?.mutationRevision === 2 &&
      noOpOverwriteResult.projectMutationRevision === undefined,
    "a byte-identical overwrite invalidated current project verification"
  );
  const fileMoveState = { meta: { goalContract: { revision: 1 } } };
  const fileMoveResult = {
    toolName: "apply_patch",
    ok: true,
    path: "renamed.md",
    changes: [
      {
        action: "apply_patch_move",
        path: "renamed.md",
        fromPath: "report.md",
        beforeHash: "unchanged",
        afterHash: "unchanged",
        beforeBytes: 42,
        afterBytes: 42,
      },
    ],
  };
  recordProjectVerificationOutcome(fileMoveState, fileMoveResult, {
    commandCwd: workspace,
    taskProfile: "writing",
  });
  assert(
    fileMoveState.meta.projectVerification?.mutationRevision === 1 &&
      fileMoveState.meta.projectVerification?.lastMutation?.paths?.includes("report.md") &&
      fileMoveState.meta.projectVerification?.lastMutation?.paths?.includes("renamed.md"),
    "a content-preserving file move escaped revision tracking or lost one path"
  );
  const invalidArtifactWriteState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        mutationRevision: 3,
        testRuns: [{ passed: true, mutationRevision: 3 }],
      },
    },
  };
  const invalidArtifactWriteResult = {
    toolName: "write_file",
    ok: false,
    path: "figure.svg",
    change: {
      action: "overwrite_file",
      path: "figure.svg",
      beforeHash: "valid-svg",
      afterHash: "invalid-svg",
      beforeBytes: 80,
      afterBytes: 40,
      artifactValidation: { ok: false, reason: "invalid SVG" },
    },
    artifactValidation: { ok: false, reason: "invalid SVG" },
  };
  recordProjectVerificationOutcome(invalidArtifactWriteState, invalidArtifactWriteResult, {
    commandCwd: workspace,
    taskProfile: "figure",
  });
  assert(
    invalidArtifactWriteState.meta.projectVerification?.mutationRevision === 4 &&
      invalidArtifactWriteResult.projectMutationRevision === 4,
    "a post-write artifact validation failure preserved stale project verification"
  );
  const failedShellMutationState = { meta: { goalContract: { revision: 1 } } };
  const failedShellMutationResult = {
    toolName: "run_command",
    ok: false,
    exitCode: 1,
    args: { command: "sed -i 's/old/new/' report.md; false" },
    stdout: "",
    stderr: "",
    projectMutationPaths: ["report.md"],
  };
  recordProjectVerificationOutcome(failedShellMutationState, failedShellMutationResult, {
    commandCwd: workspace,
    taskProfile: "writing",
    allowShellTool: true,
    allowDestructive: true,
    sandboxMode: "host",
  });
  assert(
    failedShellMutationState.meta.projectVerification?.mutationRevision === 1 &&
      failedShellMutationResult.projectMutationRevision === 1,
    "a failed shell command with an observed partial edit preserved stale verification"
  );
  const generatedCleanupState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        mutationRevision: 3,
        privateMutationRevision: 0,
        requiredCommands: ["scripts/test.sh"],
        commandRuns: [{
          command: "scripts/test.sh",
          ok: true,
          mutationRevision: 3,
          privateMutationRevision: 0,
        }],
        testRuns: [{
          command: "scripts/test.sh",
          passed: true,
          ok: true,
          mutationRevision: 3,
          privateMutationRevision: 0,
        }],
      },
    },
  };
  const generatedCleanupResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command:
        'rm -rf .build && echo "---STATUS---" && git status --short && git log --oneline -3',
    },
    stdout: "",
    stderr: "",
    projectMutationPaths: [
      ".build/classes/example/Reading.class",
      ".build/classes/example/WindowSummary.class",
    ],
  };
  recordProjectVerificationOutcome(generatedCleanupState, generatedCleanupResult, {
    commandCwd: workspace,
    taskProfile: "java",
    allowShellTool: true,
    allowDestructive: true,
    sandboxMode: "host",
  });
  assert(
    generatedCleanupState.meta.projectVerification?.mutationRevision === 3 &&
      generatedCleanupResult.disposableGeneratedCleanup === true,
    "cleaning only disposable build output invalidated fresh semantic test evidence"
  );
  const conditionalGeneratedCleanupState = structuredClone(generatedCleanupState);
  const conditionalGeneratedCleanupResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command:
        'if [ -d .build ]; then echo "BUILD_PRESENT"; rm -rf .build; else echo "BUILD_ABSENT"; fi; git status --short',
    },
    stdout: "BUILD_PRESENT\n",
    stderr: "",
    projectMutationPaths: [
      ".build/classes/example/Reading.class",
      ".build/classes/example/WindowSummary.class",
    ],
  };
  recordProjectVerificationOutcome(
    conditionalGeneratedCleanupState,
    conditionalGeneratedCleanupResult,
    {
      commandCwd: workspace,
      taskProfile: "java",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    }
  );
  assert(
    conditionalGeneratedCleanupState.meta.projectVerification?.mutationRevision === 3 &&
      conditionalGeneratedCleanupResult.disposableGeneratedCleanup === true,
    "a conditional disposable-build cleanup fabricated a new semantic mutation revision"
  );
  const generatedTestSideEffectState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        mutationRevision: 3,
        privateMutationRevision: 0,
        requiredCommands: ["scripts/test.sh"],
      },
    },
  };
  const generatedTestSideEffectResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "scripts/test.sh" },
    stdout: "PASS duration units and decimals\nall telemetry window tests passed\n",
    stderr: "",
    projectMutationPaths: [
      ".build/classes/example/Reading.class",
      ".build/classes/example/WindowSummary.class",
    ],
  };
  recordProjectVerificationOutcome(
    generatedTestSideEffectState,
    generatedTestSideEffectResult,
    {
      commandCwd: workspace,
      taskProfile: "java",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    }
  );
  assert(
    generatedTestSideEffectState.meta.projectVerification?.mutationRevision === 3 &&
      generatedTestSideEffectResult.disposableGeneratedVerificationSideEffects === true &&
      generatedTestSideEffectResult.projectTest?.passed === true &&
      generatedTestSideEffectResult.projectTest?.mutationRevision === 3,
    "a required Java verifier invalidated itself by compiling disposable class files"
  );
  const generatedTestSourceMutationState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        mutationRevision: 3,
        privateMutationRevision: 0,
        requiredCommands: ["scripts/test.sh"],
      },
    },
  };
  const generatedTestSourceMutationResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "scripts/test.sh" },
    stdout: "all telemetry window tests passed\n",
    stderr: "",
    projectMutationPaths: [
      ".build/classes/example/WindowSummary.class",
      "src/main/java/example/WindowSummary.java",
    ],
  };
  recordProjectVerificationOutcome(
    generatedTestSourceMutationState,
    generatedTestSourceMutationResult,
    {
      commandCwd: workspace,
      taskProfile: "java",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    }
  );
  assert(
    generatedTestSourceMutationState.meta.projectVerification?.mutationRevision === 4 &&
      generatedTestSourceMutationResult.disposableGeneratedVerificationSideEffects !== true &&
      generatedTestSourceMutationResult.projectTest?.mutationRevision === 4,
    "a source-changing verifier was mistaken for disposable build output"
  );
  const generatedTestRequiredOutputState = {
    meta: {
      goalContract: { revision: 1 },
      artifactProgress: { exactOutputPaths: [".build/test-results.xml"] },
      projectVerification: {
        mutationRevision: 3,
        privateMutationRevision: 0,
        requiredCommands: ["scripts/test.sh"],
      },
    },
  };
  const generatedTestRequiredOutputResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "scripts/test.sh" },
    stdout: "all telemetry window tests passed\n",
    stderr: "",
    projectMutationPaths: [".build/test-results.xml"],
  };
  recordProjectVerificationOutcome(
    generatedTestRequiredOutputState,
    generatedTestRequiredOutputResult,
    {
      commandCwd: workspace,
      taskProfile: "java",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    }
  );
  assert(
    generatedTestRequiredOutputState.meta.projectVerification?.mutationRevision === 4 &&
      generatedTestRequiredOutputResult.disposableGeneratedVerificationSideEffects !== true &&
      generatedTestRequiredOutputResult.projectTest?.mutationRevision === 4,
    "a verifier-generated declared artifact was discarded as a disposable side effect"
  );
  const requiredGeneratedOutputState = {
    meta: {
      goalContract: { revision: 1 },
      artifactProgress: { exactOutputPaths: [".build/release.jar"] },
      projectVerification: {
        mutationRevision: 3,
        privateMutationRevision: 0,
        requiredCommands: ["scripts/test.sh"],
        testRuns: [{
          command: "scripts/test.sh",
          passed: true,
          ok: true,
          mutationRevision: 3,
          privateMutationRevision: 0,
        }],
      },
    },
  };
  const requiredGeneratedOutputCleanup = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command:
        'rm -rf .build && echo "---STATUS---" && git status --short && git log --oneline -3',
    },
    stdout: "",
    stderr: "",
    projectMutationPaths: [".build/release.jar"],
  };
  recordProjectVerificationOutcome(
    requiredGeneratedOutputState,
    requiredGeneratedOutputCleanup,
    {
      commandCwd: workspace,
      taskProfile: "java",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    }
  );
  assert(
    requiredGeneratedOutputState.meta.projectVerification?.mutationRevision === 4 &&
      requiredGeneratedOutputCleanup.disposableGeneratedCleanup !== true,
    "cleanup of a declared output incorrectly preserved stale completion evidence"
  );
  const testThenEditState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        mutationRevision: 2,
        testRuns: [{ passed: true, mutationRevision: 2 }],
      },
    },
  };
  const testThenEditResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "npm test && sed -i 's/old/new/' report.md" },
    stdout: "1 test passed",
    stderr: "",
  };
  recordProjectVerificationOutcome(testThenEditState, testThenEditResult, {
    commandCwd: workspace,
    taskProfile: "code",
    allowShellTool: true,
    allowDestructive: true,
    sandboxMode: "host",
  });
  assert(
    testThenEditState.meta.projectVerification?.mutationRevision === 3 &&
      !testThenEditResult.projectTest,
    "a test-plus-edit chain preserved stale test evidence"
  );
  const declaredVerificationState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: ["git status", "make test"] },
    },
  };
  for (const command of ["git status", "make test"]) {
    recordProjectVerificationOutcome(
      declaredVerificationState,
      {
        toolName: "run_command",
        ok: true,
        exitCode: 0,
        args: { command },
        stdout: "checks passed",
        stderr: "",
      },
      {
        commandCwd: workspace,
        taskProfile: "code",
        allowShellTool: true,
        allowDestructive: true,
        sandboxMode: "host",
      }
    );
  }
  assert(
    declaredVerificationState.meta.projectVerification?.mutationRevision === 0 &&
      declaredVerificationState.meta.projectVerification?.commandRuns.every(
        (run) => run.mutationRevision === 0
      ),
    "successful project-declared verification commands invalidated one another"
  );
  recordProjectVerificationOutcome(
    declaredVerificationState,
    {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command: "git status; touch changed.txt" },
      stdout: "",
      stderr: "",
    },
    {
      commandCwd: workspace,
      taskProfile: "code",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    }
  );
  assert(
    declaredVerificationState.meta.projectVerification?.mutationRevision === 1,
    "an appended mutation was mistaken for a declared verification command"
  );
  const requiredGeneratorState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: ["node generate.js"] },
    },
  };
  const requiredGeneratorResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "node generate.js" },
    stdout: "generated report\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(requiredGeneratorState, requiredGeneratorResult, {
    commandCwd: workspace,
    taskProfile: "code",
    allowShellTool: true,
    allowDestructive: true,
    sandboxMode: "host",
  });
  assert(
    requiredGeneratorState.meta.projectVerification?.mutationRevision === 1 &&
      requiredGeneratorState.meta.projectVerification?.commandRuns?.at(-1)?.mutationRevision === 1,
    "a required write-capable generator escaped revision tracking or lost its fresh evidence"
  );
  const wrappedGeneratorOutput = path.join(workspace, "wrapped-generator-output.txt");
  await fs.writeFile(wrappedGeneratorOutput, "generated\n", "utf8");
  const wrappedGeneratorState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        requiredCommands: ["node generate.js"],
        requiredOutputs: ["wrapped-generator-output.txt"],
      },
      artifactProgress: {
        exactOutputPaths: ["wrapped-generator-output.txt"],
        completedAbsolutePaths: [],
        complete: false,
      },
    },
  };
  const wrappedGeneratorResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: 'node generate.js; printf "EXIT=%s\\n" "$?"' },
    verifiedGeneratedOutputPaths: ["wrapped-generator-output.txt"],
    stdout: "generated\nEXIT=0\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(wrappedGeneratorState, wrappedGeneratorResult, {
    commandCwd: workspace,
    taskProfile: "code",
    allowShellTool: true,
    sandboxMode: "host",
  });
  const wrappedGeneratorProgress = await recordCanonicalGeneratedOutputProgress(
    wrappedGeneratorState,
    wrappedGeneratorResult,
    { commandCwd: workspace, allowFileTools: true }
  );
  assert(
    wrappedGeneratorProgress?.active === true &&
      wrappedGeneratorProgress.completed.includes("wrapped-generator-output.txt"),
    "an explicit status probe hid a required generator from exact-output discovery"
  );
  const staleOutputPath = path.join(workspace, "stale-report.md");
  await fs.writeFile(staleOutputPath, "old report\n", "utf8");
  const staleOutputState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        requiredCommands: ["npm test"],
        requiredOutputs: ["stale-report.md"],
      },
      artifactProgress: {
        exactOutputPaths: ["stale-report.md"],
        completedAbsolutePaths: [],
        complete: false,
      },
    },
  };
  const staleOutputTestResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "npm test" },
    stdout: "1 test passed\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(staleOutputState, staleOutputTestResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  const staleOutputProgress = await recordCanonicalGeneratedOutputProgress(
    staleOutputState,
    staleOutputTestResult,
    { commandCwd: workspace, allowFileTools: true }
  );
  assert(
    staleOutputProgress === null && staleOutputState.meta.artifactProgress.complete === false,
    "an unrelated required test credited a stale pre-existing exact output"
  );
  const requiredGeneratorCommands = [
    "node scripts/generate-a.js",
    "node scripts/generate-b.js",
  ];
  const requiredGeneratorBatchState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: requiredGeneratorCommands },
    },
  };
  const requiredGeneratorBatchResults = [];
  for (const command of requiredGeneratorCommands) {
    const result = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout: "generated\n",
      stderr: "",
    };
    recordProjectVerificationOutcome(requiredGeneratorBatchState, result, {
      commandCwd: workspace,
      taskProfile: "code",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    });
    requiredGeneratorBatchResults.push(result);
  }
  const requiredGeneratorBatchContract = augmentScsTaskContractWithProjectVerification(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: [],
      taskProfile: "code",
    },
    requiredGeneratorBatchState,
    { taskProfile: "code" }
  );
  const requiredGeneratorBatchLedger = buildScsEvidenceLedger({
    state: {
      messages: requiredGeneratorBatchResults.map((result) => toolMessage(result)),
    },
  });
  assert(
    requiredGeneratorBatchState.meta.projectVerification?.mutationRevision === 2 &&
      requiredGeneratorBatchResults.every(
        (result) =>
          result.requiredCommandBatchId ===
          requiredGeneratorBatchContract.requiredProjectCommandBatchId
      ) &&
      evaluateScsEvidence(
        requiredGeneratorBatchContract,
        requiredGeneratorBatchLedger
      ).ok,
    "multiple required mutating commands invalidated one another instead of converging as one batch"
  );
  const inlineGeneratorGoal = "Run `node gen-a.js`, then run `node gen-b.js`.";
  const inlineGeneratorState = {
    goal: inlineGeneratorGoal,
    meta: { goalContract: { revision: 1, taskGoal: inlineGeneratorGoal } },
  };
  const inlineGeneratorResults = [];
  for (const command of ["node gen-a.js", "node gen-b.js"]) {
    const result = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout: "generated\n",
      stderr: "",
    };
    recordProjectVerificationOutcome(inlineGeneratorState, result, {
      commandCwd: workspace,
      taskProfile: "code",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    });
    inlineGeneratorResults.push(result);
  }
  const inlineGeneratorContract = augmentScsTaskContractWithProjectVerification(
    deriveScsTaskContract({ goal: inlineGeneratorGoal, taskProfile: "code" }),
    inlineGeneratorState,
    { taskProfile: "code" }
  );
  const inlineGeneratorLedger = buildScsEvidenceLedger({
    state: { messages: inlineGeneratorResults.map((result) => toolMessage(result)) },
  });
  assert(
    inlineGeneratorContract.requiredProjectCommandBatchCommands.length === 2 &&
      inlineGeneratorResults.every(
        (result) =>
          result.requiredCommandBatchId ===
          inlineGeneratorContract.requiredProjectCommandBatchId
      ) &&
      evaluateScsEvidence(inlineGeneratorContract, inlineGeneratorLedger).ok,
    "inline required mutating commands were omitted from the shared command batch"
  );
  const mutatingValidationCommands = [
    "npm run lint:fix",
    "npm test -- --updateSnapshot",
  ];
  const mutatingValidationState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: mutatingValidationCommands },
    },
  };
  const mutatingValidationResults = [];
  for (const command of mutatingValidationCommands) {
    const result = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout: "1 test passed\n1 snapshot updated\n",
      stderr: "",
    };
    recordProjectVerificationOutcome(mutatingValidationState, result, {
      commandCwd: workspace,
      taskProfile: "code",
      allowShellTool: true,
      sandboxMode: "host",
    });
    mutatingValidationResults.push(result);
  }
  const mutatingValidationContract = augmentScsTaskContractWithProjectVerification(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: [],
      taskProfile: "code",
    },
    mutatingValidationState,
    { taskProfile: "code" }
  );
  const mutatingValidationLedger = buildScsEvidenceLedger({
    state: { messages: mutatingValidationResults.map((result) => toolMessage(result)) },
  });
  assert(
    mutatingValidationState.meta.projectVerification?.mutationRevision === 2 &&
      mutatingValidationResults.every(
        (result) =>
          result.requiredCommandBatchId ===
          mutatingValidationContract.requiredProjectCommandBatchId
      ) &&
      evaluateScsEvidence(mutatingValidationContract, mutatingValidationLedger).ok,
    "a batch of required mutating validators could not converge"
  );
  const orderedValidationCommands = [
    "node scripts/generate-a.js",
    "npm run check",
    "node scripts/generate-b.js",
  ];
  const orderedValidationState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: orderedValidationCommands },
    },
  };
  const orderedValidationResults = [];
  for (const command of orderedValidationCommands) {
    const result = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout: "checks passed\n",
      stderr: "",
    };
    recordProjectVerificationOutcome(orderedValidationState, result, {
      commandCwd: workspace,
      taskProfile: "code",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    });
    orderedValidationResults.push(result);
  }
  const staleOrderedContract = augmentScsTaskContractWithProjectVerification(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: [],
      taskProfile: "code",
    },
    orderedValidationState,
    { taskProfile: "code" }
  );
  const staleOrderedLedger = buildScsEvidenceLedger({
    state: { messages: orderedValidationResults.map((result) => toolMessage(result)) },
  });
  assert(
    !evaluateScsEvidence(staleOrderedContract, staleOrderedLedger).ok &&
      staleOrderedContract.requiredProjectCommandRuns.length === 2 &&
      staleOrderedContract.requiredProjectCommandRuns.every(
        (run) => run.command !== "npm run check"
      ),
    "a validation run before the final required mutation remained current"
  );
  const pluralValidationCommands = [
    "python scripts/run_checks.py",
    "node scripts/generate.js",
  ];
  const pluralValidationState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: pluralValidationCommands },
    },
  };
  const pluralValidationResults = [];
  for (const command of pluralValidationCommands) {
    const result = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout: "completed\n",
      stderr: "",
    };
    recordProjectVerificationOutcome(pluralValidationState, result, {
      commandCwd: workspace,
      taskProfile: "code",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    });
    pluralValidationResults.push(result);
  }
  const pluralValidationContract = augmentScsTaskContractWithProjectVerification(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: [],
      taskProfile: "code",
    },
    pluralValidationState,
    { taskProfile: "code" }
  );
  const pluralValidationLedger = buildScsEvidenceLedger({
    state: { messages: pluralValidationResults.map((result) => toolMessage(result)) },
  });
  assert(
    !evaluateScsEvidence(pluralValidationContract, pluralValidationLedger).ok &&
      pluralValidationContract.requiredProjectCommandRuns.every(
        (run) => run.command !== "python scripts/run_checks.py"
      ),
    "a plural checker name retained stale validation after a later mutation"
  );
  const rerunValidationResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "npm run check" },
    stdout: "checks passed\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(orderedValidationState, rerunValidationResult, {
    commandCwd: workspace,
    taskProfile: "code",
    allowShellTool: true,
    allowDestructive: true,
    sandboxMode: "host",
  });
  orderedValidationResults.push(rerunValidationResult);
  const freshOrderedContract = augmentScsTaskContractWithProjectVerification(
    staleOrderedContract,
    orderedValidationState,
    { taskProfile: "code" }
  );
  const freshOrderedLedger = buildScsEvidenceLedger({
    state: { messages: orderedValidationResults.map((result) => toolMessage(result)) },
  });
  assert(
    freshOrderedContract.requiredProjectCommandRuns.length === 3 &&
      evaluateScsEvidence(freshOrderedContract, freshOrderedLedger).ok,
    "rerunning validation after the final required mutation did not satisfy the batch"
  );
  const opaqueValidationCommands = [
    "node scripts/generate-a.js",
    "python scripts/verify.py --strict",
    "node scripts/generate-b.js",
  ];
  const opaqueValidationState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: opaqueValidationCommands },
    },
  };
  const opaqueValidationResults = [];
  for (const command of opaqueValidationCommands) {
    const result = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout: "completed\n",
      stderr: "",
    };
    recordProjectVerificationOutcome(opaqueValidationState, result, {
      commandCwd: workspace,
      taskProfile: "code",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    });
    opaqueValidationResults.push(result);
  }
  const staleOpaqueValidationContract = augmentScsTaskContractWithProjectVerification(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: [],
      taskProfile: "code",
    },
    opaqueValidationState,
    { taskProfile: "code" }
  );
  const staleOpaqueValidationLedger = buildScsEvidenceLedger({
    state: { messages: opaqueValidationResults.map((result) => toolMessage(result)) },
  });
  assert(
    !evaluateScsEvidence(staleOpaqueValidationContract, staleOpaqueValidationLedger).ok &&
      !staleOpaqueValidationContract.requiredProjectCommandRuns.some(
        (run) => run.command === "python scripts/verify.py --strict"
      ),
    "an opaque verifier remained current after a later required mutation"
  );
  const refreshedOpaqueValidation = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "python scripts/verify.py --strict" },
    stdout: "verified\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(opaqueValidationState, refreshedOpaqueValidation, {
    commandCwd: workspace,
    taskProfile: "code",
    allowShellTool: true,
    allowDestructive: true,
    sandboxMode: "host",
  });
  opaqueValidationResults.push(refreshedOpaqueValidation);
  const freshOpaqueValidationContract = augmentScsTaskContractWithProjectVerification(
    staleOpaqueValidationContract,
    opaqueValidationState,
    { taskProfile: "code" }
  );
  const freshOpaqueValidationLedger = buildScsEvidenceLedger({
    state: { messages: opaqueValidationResults.map((result) => toolMessage(result)) },
  });
  assert(
    evaluateScsEvidence(freshOpaqueValidationContract, freshOpaqueValidationLedger).ok,
    "rerunning an opaque verifier after the final mutation did not refresh the batch"
  );

  const equivalentWorkspaceCommand = `cd ${workspace} && npm test`;
  const equivalentWorkspaceState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: [equivalentWorkspaceCommand] },
    },
  };
  const equivalentWorkspaceResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "cd . && npm test" },
    stdout: "1 test passed\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(equivalentWorkspaceState, equivalentWorkspaceResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  const equivalentWorkspaceContract = augmentScsTaskContractWithProjectVerification(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: [],
      taskProfile: "code",
    },
    equivalentWorkspaceState,
    { taskProfile: "code" }
  );
  const equivalentWorkspaceLedger = buildScsEvidenceLedger({
    state: { messages: [toolMessage(equivalentWorkspaceResult)] },
  });
  assert(
    equivalentWorkspaceResult.requiredProjectCommand === equivalentWorkspaceCommand &&
      evaluateScsEvidence(equivalentWorkspaceContract, equivalentWorkspaceLedger).ok,
    "equivalent workspace command spelling diverged between execution and evidence"
  );
  const continuedRequiredCommand = "npm test -- --runInBand";
  const continuedRequiredState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: [continuedRequiredCommand] },
    },
  };
  const continuedRequiredResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: ["npm test " + String.fromCharCode(92), "  -- --runInBand"].join("\n") },
    stdout: "1 test passed\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(continuedRequiredState, continuedRequiredResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    continuedRequiredResult.requiredProjectCommand === continuedRequiredCommand &&
      continuedRequiredResult.projectTest?.passed === true,
    "a backslash-newline continuation lost required-command or test evidence"
  );
  for (const [requiredCommand, observedCommand] of [
    [`echo '${workspace}'`, "echo '.'"],
    [`grep '${workspace}/needle' report.md`, "grep 'needle' report.md"],
  ]) {
    const literalPathState = {
      meta: {
        goalContract: { revision: 1 },
        projectVerification: { requiredCommands: [requiredCommand] },
      },
    };
    const literalPathResult = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command: observedCommand },
      stdout: "literal command completed\n",
      stderr: "",
    };
    recordProjectVerificationOutcome(literalPathState, literalPathResult, {
      commandCwd: workspace,
      taskProfile: "code",
    });
    const literalPathContract = augmentScsTaskContractWithProjectVerification(
      {
        requiresExternalEvidence: false,
        requiredEvidence: [],
        requiredToolCalls: [],
        requiredGitActions: [],
        taskProfile: "code",
      },
      literalPathState,
      { taskProfile: "code" }
    );
    const literalPathLedger = buildScsEvidenceLedger({
      state: { messages: [toolMessage(literalPathResult)] },
    });
    assert(
      !literalPathResult.requiredProjectCommand &&
        !evaluateScsEvidence(literalPathContract, literalPathLedger).ok,
      `workspace text inside a command argument was rewritten into false equivalence: ${requiredCommand}`
    );
  }
  const equivalentGeneratorOutput = path.join(workspace, "equivalent-generator-output.txt");
  await fs.writeFile(equivalentGeneratorOutput, "generated\n", "utf8");
  const equivalentGeneratorCommand = `cd ${workspace} && node generate.js`;
  const equivalentGeneratorState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        requiredCommands: [equivalentGeneratorCommand],
        requiredOutputs: ["equivalent-generator-output.txt"],
      },
      artifactProgress: {
        exactOutputPaths: ["equivalent-generator-output.txt"],
        completedAbsolutePaths: [],
        complete: false,
      },
    },
  };
  const equivalentGeneratorResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "cd . && node generate.js" },
    verifiedGeneratedOutputPaths: ["equivalent-generator-output.txt"],
    stdout: "generated\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(equivalentGeneratorState, equivalentGeneratorResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  const equivalentGeneratorProgress = await recordCanonicalGeneratedOutputProgress(
    equivalentGeneratorState,
    equivalentGeneratorResult,
    { commandCwd: workspace, allowFileTools: true }
  );
  assert(
    equivalentGeneratorResult.requiredProjectCommand === equivalentGeneratorCommand &&
      equivalentGeneratorProgress?.active === true &&
      equivalentGeneratorProgress.completed.includes("equivalent-generator-output.txt"),
    "a safely equivalent generator spelling lost its required-command binding or output credit"
  );
  const unrelatedMutationAfterBatch = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "node scripts/other.js" },
    stdout: "updated unrelated output\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(requiredGeneratorBatchState, unrelatedMutationAfterBatch, {
    commandCwd: workspace,
    taskProfile: "code",
    allowShellTool: true,
    allowDestructive: true,
    sandboxMode: "host",
  });
  const invalidatedGeneratorBatchContract = augmentScsTaskContractWithProjectVerification(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: [],
      taskProfile: "code",
    },
    requiredGeneratorBatchState,
    { taskProfile: "code" }
  );
  const invalidatedGeneratorBatchLedger = buildScsEvidenceLedger({
    state: {
      messages: [
        ...requiredGeneratorBatchResults.map((result) => toolMessage(result)),
        toolMessage(unrelatedMutationAfterBatch),
      ],
    },
  });
  const invalidatedGeneratorBatchEvaluation = evaluateScsEvidence(
    invalidatedGeneratorBatchContract,
    invalidatedGeneratorBatchLedger
  );
  assert(
    requiredGeneratorBatchState.meta.projectVerification?.mutationRevision === 3 &&
      !requiredGeneratorBatchState.meta.projectVerification?.requiredCommandBatch &&
      !invalidatedGeneratorBatchContract.requiredProjectCommandBatchId &&
      !invalidatedGeneratorBatchEvaluation.ok &&
      invalidatedGeneratorBatchEvaluation.missingProjectCommands.length === 2,
    "an unrelated mutation did not invalidate the completed required-command batch"
  );
  const gitMetadataResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "git add report.md && git commit -m 'record report'" },
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(shellMutationState, gitMetadataResult, {
    commandCwd: workspace,
    taskProfile: "writing",
    allowShellTool: true,
    sandboxMode: "host",
  });
  assert(
    shellMutationState.meta.projectVerification?.mutationRevision === 1,
    "git metadata incorrectly invalidated current project-content verification"
  );
  const gitMetadataWithObservationsResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command:
        "git add report.md && git commit -m 'record verified report' && echo '=== status ===' && git status --porcelain && git log -1 --oneline",
    },
    stdout: "=== status ===\nabc123 record verified report",
    stderr: "",
  };
  recordProjectVerificationOutcome(shellMutationState, gitMetadataWithObservationsResult, {
    commandCwd: workspace,
    taskProfile: "writing",
    allowShellTool: true,
    sandboxMode: "host",
  });
  assert(
    shellMutationState.meta.projectVerification?.mutationRevision === 1,
    "metadata-only Git chain with observational output invalidated current verification"
  );
  assert(
    classifyCommand("md5sum output/report.pdf").writesWorkspace === false &&
      classifyCommand("md5sum -c .aginti/verification/source-hashes.txt").writesWorkspace === false &&
      classifyCommand("diff .aginti/verification/run-1.txt .aginti/verification/run-2.txt").writesWorkspace === false,
    "checksum or diff evidence probes were not classified as read-only"
  );
  const privateEvidenceState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: ["bash build.sh"] },
    },
  };
  const privateEvidenceBuild = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "bash build.sh" },
    stdout: "build complete\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(privateEvidenceState, privateEvidenceBuild, {
    commandCwd: workspace,
    taskProfile: "writing",
    allowShellTool: true,
    sandboxMode: "host",
  });
  const privateEvidenceRevision =
    privateEvidenceState.meta.projectVerification?.mutationRevision;
  const privateEvidenceCommand = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command:
        "md5sum output/report.pdf > .aginti/verification/hashes-final.txt && cat .aginti/verification/hashes-final.txt && diff .aginti/verification/hashes-run1.txt .aginti/verification/hashes-final.txt && md5sum -c .aginti/verification/source-hashes.txt && git status --porcelain",
    },
    stdout: "MATCH\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(privateEvidenceState, privateEvidenceCommand, {
    commandCwd: workspace,
    taskProfile: "writing",
    allowShellTool: true,
    sandboxMode: "host",
  });
  const privateEvidenceWrite = {
    toolName: "write_file",
    ok: true,
    path: ".aginti/verification/visual-check.txt",
    changes: [
      {
        path: ".aginti/verification/visual-check.txt",
        created: true,
        beforeHash: "",
        afterHash: "private-evidence",
      },
    ],
  };
  recordProjectVerificationOutcome(privateEvidenceState, privateEvidenceWrite, {
    commandCwd: workspace,
    taskProfile: "writing",
  });
  const privateEvidenceContract = augmentScsTaskContractWithProjectVerification(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: [],
      taskProfile: "writing",
    },
    privateEvidenceState,
    { taskProfile: "writing" }
  );
  const privateEvidenceLedger = buildScsEvidenceLedger({
    state: {
      messages: [privateEvidenceBuild, privateEvidenceCommand, privateEvidenceWrite].map((result) =>
        toolMessage(result)
      ),
    },
  });
  assert(
    privateEvidenceRevision === 1 &&
      privateEvidenceState.meta.projectVerification?.mutationRevision === 1 &&
      privateEvidenceState.meta.projectVerification?.requiredCommandBatch?.complete === true &&
      evaluateScsEvidence(privateEvidenceContract, privateEvidenceLedger).ok,
    "ignored private verification evidence invalidated a successful canonical build"
  );
  const scopedTaskRoot = path.join(workspace, "output", "agent-task-1");
  const scopedTaskGoal = [
    "Create and verify output/result.json.",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "task",
      request: "Create and verify output/result.json.",
      artifact_root: scopedTaskRoot,
    })}`,
  ].join("\n");
  const scopedTaskState = {
    goal: scopedTaskGoal,
    commandCwd: workspace,
    meta: {
      goalContract: {
        revision: 1,
        taskGoal: scopedTaskGoal,
        currentRequest: "Create and verify output/result.json.",
      },
    },
  };
  recordProjectVerificationOutcome(
    scopedTaskState,
    {
      toolName: "write_file",
      ok: true,
      path: "output/result.json",
      changes: [
        {
          path: "output/result.json",
          created: true,
          beforeHash: "",
          afterHash: "requested-output",
        },
      ],
    },
    { commandCwd: workspace, taskProfile: "auto" }
  );
  const requestedOutputRevision =
    scopedTaskState.meta.projectVerification?.mutationRevision;
  const readOnlyArtifactValidation = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command:
        "python3 -c \"import json; d=json.load(open('output/result.json')); assert d; print('PASS valid JSON')\"",
    },
    projectMutationPaths: [],
    stdout: "PASS valid JSON\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(
    scopedTaskState,
    readOnlyArtifactValidation,
    {
      commandCwd: workspace,
      taskProfile: "auto",
      allowShellTool: true,
      sandboxMode: "host",
    }
  );
  recordProjectVerificationOutcome(
    scopedTaskState,
    {
      toolName: "write_file",
      ok: true,
      path: path.join(scopedTaskRoot, "agent-result.json"),
      changes: [
        {
          path: path.join(scopedTaskRoot, "agent-result.json"),
          created: true,
          beforeHash: "",
          afterHash: "delivery-manifest",
        },
      ],
    },
    { commandCwd: workspace, taskProfile: "auto" }
  );
  const scopedManifestCommand = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command: `printf '%s\\n' '{}' > ${JSON.stringify(
        path.join(scopedTaskRoot, "agent-result.json")
      )}`,
    },
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(
    scopedTaskState,
    scopedManifestCommand,
    {
      commandCwd: workspace,
      taskProfile: "auto",
      allowShellTool: true,
      sandboxMode: "host",
    }
  );
  const pythonScopedManifestCommand = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command: [
        "python3 - <<'PY'",
        `out = ${JSON.stringify(path.join(scopedTaskRoot, "agent-result.json"))}`,
        "with open(out, 'w', encoding='utf-8') as handle:",
        "    handle.write('{}')",
        "PY",
      ].join("\n"),
    },
    projectMutationPaths: [],
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(
    scopedTaskState,
    pythonScopedManifestCommand,
    {
      commandCwd: workspace,
      taskProfile: "auto",
      allowShellTool: true,
      sandboxMode: "host",
    }
  );
  assert(
    requestedOutputRevision === 1 &&
      scopedTaskState.meta.projectVerification?.mutationRevision === 1 &&
      readOnlyArtifactValidation.readOnlyArtifactValidation === true &&
      scopedManifestCommand.scopedTaskArtifactWrite === true &&
      pythonScopedManifestCommand.scopedTaskArtifactWrite === true,
    "task-scoped delivery bookkeeping invalidated requested artifact evidence"
  );
  const mutatingInlinePython = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command: "python3 -c \"open('output/side.txt','w').write('changed')\"",
    },
    projectMutationPaths: [],
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(
    scopedTaskState,
    mutatingInlinePython,
    {
      commandCwd: workspace,
      taskProfile: "auto",
      allowShellTool: true,
      sandboxMode: "host",
    }
  );
  assert(
    scopedTaskState.meta.projectVerification?.mutationRevision === 2 &&
      mutatingInlinePython.readOnlyArtifactValidation !== true,
    "write-capable inline Python was incorrectly classified as read-only validation"
  );
  const privateVerifierCommand =
    "python3 .aginti/verification/lifecycle/smoke_test.py";
  const privateVerifierState = {
    goal: "Repair the service lifecycle and prove it with the retained private smoke test.",
    commandCwd: workspace,
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        mutationRevision: 0,
        privateMutationRevision: 0,
        requiredCommands: [privateVerifierCommand],
        commandRuns: [],
        mutationHistory: [],
        testRuns: [
          {
            command: privateVerifierCommand,
            at: "2026-08-26T00:00:00.000Z",
            ok: false,
            passed: false,
            mutationRevision: 0,
            privateMutationRevision: 0,
            failureEvidenceVersion: 2,
            failureSignature: "private-verifier-import-root",
          },
        ],
      },
    },
  };
  assert(
    unchangedFailedTestRerunBlock(
      privateVerifierState,
      "run_command",
      { command: privateVerifierCommand },
      { commandCwd: workspace }
    )?.category === "unchanged-failed-test-rerun",
    "an unchanged private verifier failure was not initially mutation-gated"
  );
  recordProjectVerificationOutcome(
    privateVerifierState,
    {
      toolName: "apply_patch",
      ok: true,
      path: ".aginti/verification/lifecycle/smoke_test.py",
      changes: [
        {
          path: ".aginti/verification/lifecycle/smoke_test.py",
          beforeHash: "broken-private-verifier",
          afterHash: "repaired-private-verifier",
        },
      ],
    },
    { commandCwd: workspace, taskProfile: "devops" }
  );
  const repairedVerifierRuntime = nextStepRuntimeConfig(
    {
      goal: privateVerifierState.goal,
      commandCwd: workspace,
      taskProfile: "devops",
      provider: "localllm",
    },
    privateVerifierState
  );
  assert(
    privateVerifierState.meta.projectVerification.mutationRevision === 0 &&
      privateVerifierState.meta.projectVerification.privateMutationRevision === 1 &&
      privateVerifierState.meta.projectVerification.mutationHistory.length === 0 &&
      privateVerifierState.meta.projectVerification.privateMutationHistory.at(-1)?.paths?.includes(
        ".aginti/verification/lifecycle/smoke_test.py"
      ),
    "a private verifier repair either became task-owned work or failed to advance verifier freshness"
  );
  assert(
    unchangedFailedTestRerunBlock(
      privateVerifierState,
      "run_command",
      { command: privateVerifierCommand },
      { commandCwd: workspace }
    ) === null &&
      repairedVerifierRuntime.testVerificationPending === true &&
      repairedVerifierRuntime.testVerificationCommand === privateVerifierCommand &&
      projectTestVerificationFinishBlock(privateVerifierState)?.category ===
        "project-test-verification-stale",
    "repairing a private verifier did not permit and require one fresh exact rerun"
  );
  recordProjectVerificationOutcome(
    privateVerifierState,
    {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command: privateVerifierCommand },
      stdout: "service lifecycle smoke passed\n",
      stderr: "",
    },
    {
      commandCwd: workspace,
      taskProfile: "devops",
      allowShellTool: true,
      sandboxMode: "host",
      testVerificationPending: true,
      testVerificationCommand: privateVerifierCommand,
    }
  );
  assert(
    privateVerifierState.meta.projectVerification.testRuns.at(-1)?.passed === true &&
      privateVerifierState.meta.projectVerification.testRuns.at(-1)
        ?.privateMutationRevision === 1 &&
      projectTestVerificationFinishBlock(privateVerifierState) === null,
    "a passing rerun did not become current at the repaired private verifier revision"
  );
  recordProjectVerificationOutcome(
    privateVerifierState,
    {
      toolName: "write_file",
      ok: true,
      path: ".aginti/verification/lifecycle/expectations.json",
      changes: [
        {
          path: ".aginti/verification/lifecycle/expectations.json",
          created: true,
          beforeHash: "",
          afterHash: "updated-private-expectations",
        },
      ],
    },
    { commandCwd: workspace, taskProfile: "devops" }
  );
  const secondVerifierRuntime = nextStepRuntimeConfig(
    {
      goal: privateVerifierState.goal,
      commandCwd: workspace,
      taskProfile: "devops",
      provider: "localllm",
    },
    privateVerifierState
  );
  assert(
    privateVerifierState.meta.projectVerification.mutationRevision === 0 &&
      privateVerifierState.meta.projectVerification.privateMutationRevision === 2 &&
      secondVerifierRuntime.testVerificationPending === true &&
      secondVerifierRuntime.testVerificationCommand === privateVerifierCommand &&
      secondVerifierRuntime.requiredProjectCommandPending === true &&
      secondVerifierRuntime.requiredProjectCommand === privateVerifierCommand,
    "a later private verifier mutation did not invalidate both test and validation-command evidence"
  );
  const publicEvidenceMutation = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "md5sum output/report.pdf > output/hashes-final.txt" },
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(privateEvidenceState, publicEvidenceMutation, {
    commandCwd: workspace,
    taskProfile: "writing",
    allowShellTool: true,
    sandboxMode: "host",
  });
  assert(
    privateEvidenceState.meta.projectVerification?.mutationRevision === 2 &&
      !privateEvidenceState.meta.projectVerification?.requiredCommandBatch,
    "a non-private output write was incorrectly exempted from project mutation tracking"
  );
  const gitCheckoutResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "git checkout feature-branch" },
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(shellMutationState, gitCheckoutResult, {
    commandCwd: workspace,
    taskProfile: "writing",
    allowShellTool: true,
    sandboxMode: "host",
  });
  assert(
    shellMutationState.meta.projectVerification?.mutationRevision === 2 &&
      gitCheckoutResult.projectMutationRevision === 2,
    "a worktree-changing git command did not invalidate prior project verification"
  );
  const gitPullResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "git pull --ff-only" },
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(shellMutationState, gitPullResult, {
    commandCwd: workspace,
    taskProfile: "writing",
    allowShellTool: true,
    sandboxMode: "host",
  });
  assert(
    shellMutationState.meta.projectVerification?.mutationRevision === 3 &&
      gitPullResult.projectMutationRevision === 3,
    "a remote worktree update did not invalidate prior project verification"
  );
  const chainedGitMutationState = { meta: { goalContract: { revision: 1 } } };
  for (const command of ["git pull --ff-only; git status", "git checkout feature-branch; git status"]) {
    recordProjectVerificationOutcome(
      chainedGitMutationState,
      {
        toolName: "run_command",
        ok: true,
        exitCode: 0,
        args: { command },
        stdout: "",
        stderr: "",
      },
      {
        commandCwd: workspace,
        taskProfile: "writing",
        allowShellTool: true,
        sandboxMode: "host",
      }
    );
  }
  assert(
    chainedGitMutationState.meta.projectVerification?.mutationRevision === 2,
    "a non-propagating Git chain hid a possible worktree mutation from revision tracking"
  );
  const testBeforePullState = { meta: { goalContract: { revision: 1 } } };
  const testBeforePullResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "npm test && git pull --ff-only" },
    stdout: "1 test passed",
    stderr: "",
    commandPolicy: {
      category: "git-remote",
      writesWorkspace: true,
      mayMutateProject: false,
      substantiveTest: true,
      gitOnly: false,
    },
  };
  recordProjectVerificationOutcome(testBeforePullState, testBeforePullResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    testBeforePullState.meta.projectVerification?.mutationRevision === 1 &&
      !testBeforePullResult.projectTest,
    "a test run before a later worktree mutation was recorded against the new revision"
  );
  const absoluteWorkspaceTestState = { meta: { goalContract: { revision: 1 } } };
  const absoluteWorkspaceTestResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: `cd ${workspace} && npm test` },
    stdout: "1 test passed",
    stderr: "",
  };
  recordProjectVerificationOutcome(absoluteWorkspaceTestState, absoluteWorkspaceTestResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    absoluteWorkspaceTestState.meta.projectVerification?.mutationRevision === 0 &&
      absoluteWorkspaceTestResult.projectTest?.passed === true,
    "an authorized absolute-workspace test lost retained verification identity"
  );
  const absoluteWorkspaceMutationState = { meta: { goalContract: { revision: 1 } } };
  const absoluteWorkspaceMutationResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: `cd ${workspace} && git pull --ff-only && npm test` },
    stdout: "1 test passed",
    stderr: "",
  };
  recordProjectVerificationOutcome(absoluteWorkspaceMutationState, absoluteWorkspaceMutationResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    absoluteWorkspaceMutationState.meta.projectVerification?.mutationRevision === 1 &&
      absoluteWorkspaceMutationResult.projectTest?.passed === true &&
      absoluteWorkspaceMutationResult.projectTest?.mutationRevision === 1,
    "policy-normalized absolute workspace mutation and test evidence diverged"
  );
  const pullBeforeTestState = { meta: { goalContract: { revision: 1 } } };
  const pullBeforeTestResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "git pull --ff-only && npm test" },
    stdout: "1 test passed",
    stderr: "",
  };
  recordProjectVerificationOutcome(pullBeforeTestState, pullBeforeTestResult, {
    commandCwd: workspace,
    taskProfile: "code",
  });
  assert(
    pullBeforeTestState.meta.projectVerification?.mutationRevision === 1 &&
      pullBeforeTestResult.projectTest?.passed === true &&
      pullBeforeTestResult.projectTest?.mutationRevision === 1,
    "a test run after a worktree mutation was not retained at the new revision"
  );
  const mixedRemoteMutationState = { meta: { goalContract: { revision: 1 } } };
  for (const command of [
    "npm test -- --updateSnapshot && git fetch",
    "npm run build && git fetch",
  ]) {
    recordProjectVerificationOutcome(
      mixedRemoteMutationState,
      {
        toolName: "run_command",
        ok: true,
        exitCode: 0,
        args: { command },
        stdout: "1 test passed",
        stderr: "",
      },
      { commandCwd: workspace, taskProfile: "code" }
    );
  }
  assert(
    mixedRemoteMutationState.meta.projectVerification?.mutationRevision === 2,
    "a mixed Git-remote sequence hid a write-capable non-Git segment"
  );
  const destructiveGitMutationState = { meta: { goalContract: { revision: 1 } } };
  for (const command of ["git reset --hard HEAD~1", "git rebase main", "git clean -fd"]) {
    const result = {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command },
      stdout: "",
      stderr: "",
    };
    recordProjectVerificationOutcome(destructiveGitMutationState, result, {
      commandCwd: workspace,
      taskProfile: "writing",
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    });
  }
  assert(
    destructiveGitMutationState.meta.projectVerification?.mutationRevision === 3,
    "destructive git commands did not invalidate prior project verification"
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
  const zeroTestWithStatusResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "npm test" },
    stdout: "ok server ready\nRan 0 tests\nOK\n",
    stderr: "",
  };
  recordProjectVerificationOutcome({ meta: {} }, zeroTestWithStatusResult, {
    commandCwd: workspace,
    taskProfile: "qa",
  });
  assert(
    zeroTestWithStatusResult.projectTest?.zeroTests === true &&
      zeroTestWithStatusResult.projectTest?.passed === false,
    "an arbitrary ok status line overrode a definitive zero-test summary"
  );
  const mixedGoPackageResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "go test ./..." },
    stdout: "?\texample/empty\t[no test files]\nok\texample/tested\t0.123s\n",
    stderr: "",
  };
  recordProjectVerificationOutcome({ meta: {} }, mixedGoPackageResult, {
    commandCwd: workspace,
    taskProfile: "qa",
  });
  assert(
    mixedGoPackageResult.projectTest?.zeroTests === false &&
      mixedGoPackageResult.projectTest?.passed === true,
    "a mixed Go package run with executed tests was mistaken for a zero-test run"
  );
  const requiredCommandContract = {
    requiresExternalEvidence: false,
    requiredEvidence: [],
    requiredToolCalls: [],
    requiredGitActions: [],
    requiredProjectCommands: ["npm test"],
    projectMutationRevision: 0,
  };
  const longWrappedCommandLedger = buildScsEvidenceLedger({
    state: {
      messages: [
        toolMessage({
          toolName: "run_command",
          ok: true,
          exitCode: 0,
          args: { command: 'npm test; printf "EXIT=%s\\n" "$?"' },
          stdout: `${"test output ".repeat(80)}\nEXIT=0\n`,
          stderr: "",
        }),
      ],
    },
  });
  assert(
    evaluateScsEvidence(requiredCommandContract, longWrappedCommandLedger).ok,
    "a valid status marker beyond compact display output did not satisfy the exact command contract"
  );
  for (const stdout of [
    "test output without marker\n",
    "test output\nEXIT=1\n",
    "test printed EXIT=0 itself\nmore output after the false marker\n",
  ]) {
    const ledger = buildScsEvidenceLedger({
      state: {
        messages: [
          toolMessage({
            toolName: "run_command",
            ok: true,
            exitCode: 0,
            args: { command: 'npm test; printf "EXIT=%s\\n" "$?"' },
            stdout,
            stderr: "",
          }),
        ],
      },
    });
    assert(
      !evaluateScsEvidence(requiredCommandContract, ledger).ok,
      `invalid wrapped command evidence satisfied the contract: ${stdout.trim()}`
    );
  }
  const failedBoundCommandState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: ["npm test"] },
    },
  };
  const failedBoundCommandResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: 'npm test; echo "EXIT=$?"' },
    stdout: "tests failed\nEXIT=1\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(failedBoundCommandState, failedBoundCommandResult, {
    commandCwd: workspace,
    taskProfile: "qa",
  });
  const failedBoundCommandContract = augmentScsTaskContractWithProjectVerification(
    {
      requiresExternalEvidence: false,
      requiredEvidence: [],
      requiredToolCalls: [],
      requiredGitActions: [],
      taskProfile: "qa",
    },
    failedBoundCommandState,
    { taskProfile: "qa" }
  );
  const failedBoundCommandLedger = buildScsEvidenceLedger({
    state: { messages: [toolMessage(failedBoundCommandResult)] },
  });
  assert(
    failedBoundCommandResult.requiredProjectCommand === "npm test" &&
      failedBoundCommandResult.projectTest?.passed === false &&
      !evaluateScsEvidence(failedBoundCommandContract, failedBoundCommandLedger).ok,
    "a failed status-wrapped command used its required-command binding to fabricate acceptance"
  );
  const failedRuntimeCommand = "python3 service_ctl.py start --state-dir .runtime";
  const failedRuntimeCommandState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: { requiredCommands: [failedRuntimeCommand] },
    },
  };
  const failedRuntimeCommandResult = {
    toolName: "run_command",
    ok: false,
    exitCode: 1,
    args: { command: failedRuntimeCommand },
    stdout: "",
    stderr: "TypeError: launch_service() got an unexpected keyword argument 'stdout'",
  };
  recordProjectVerificationOutcome(
    failedRuntimeCommandState,
    failedRuntimeCommandResult,
    { commandCwd: workspace, taskProfile: "devops" }
  );
  assert(
    failedRuntimeCommandResult.requiredProjectCommand === failedRuntimeCommand &&
      failedRuntimeCommandResult.projectTest?.passed === false &&
      failedRuntimeCommandResult.projectTest?.requiredCommandFailure === true &&
      failedRuntimeCommandResult.projectTest?.failureSummary.includes("TypeError"),
    "a failed non-test required command did not become bounded repair evidence"
  );
  const failedRuntimeCommandRecovery = nextStepRuntimeConfig(
    { provider: "deepseek", taskProfile: "devops", commandCwd: workspace },
    failedRuntimeCommandState
  );
  assert(
    failedRuntimeCommandRecovery.testFailureRepairActive === true &&
      failedRuntimeCommandRecovery.requiredProjectCommandPending !== true &&
      buildKnownConstrainedPhasePlan(
        { provider: "deepseek", taskProfile: "devops", commandCwd: workspace },
        failedRuntimeCommandState,
        failedRuntimeCommandRecovery
      ) === null,
    "a failed non-test required command stayed trapped in exact-command constrained recovery"
  );
  const staleValidatorCommand =
    'python3 missing_local_validator.py --root . 2>&1; echo "EXIT=$?"';
  const authoritativeValidatorCommand =
    "/opt/cad/bin/python /workspace/acceptance/cad_contract.py --root .";
  const authoritativeValidatorGoal =
    `Continue the same repair and run this exact declared validator command: \`${authoritativeValidatorCommand}\`.`;
  const authoritativeValidatorState = {
    goal: authoritativeValidatorGoal,
    meta: {
      taskProfile: "cad",
      goalContract: {
        revision: 9,
        currentRequest: authoritativeValidatorGoal,
        activeGoal: authoritativeValidatorGoal,
        taskGoal: "Repair and validate the CAD artifact.",
        history: [{ revision: 9, refreshExecutionContract: true }],
      },
      activeExecutionContract: {
        revision: 9,
        startedMutationRevision: 4,
        materialMutationRevision: 5,
        requiresWorkspaceMutation: true,
        requiresFileMutation: true,
        requiresSourceGrounding: true,
        requiredProjectCommands: [authoritativeValidatorCommand],
      },
      completionEvidenceRepair: {
        key: "current-turn-final-validation",
        at: "2026-08-28T07:00:00.000Z",
      },
      projectVerification: {
        mutationRevision: 5,
        privateMutationRevision: 0,
        requiredCommands: [],
        contractRequiredCommands: [],
        requiredCommandBatch: {
          id: "required-command-batch-9",
          key: JSON.stringify([authoritativeValidatorCommand]),
          requiredCommands: [authoritativeValidatorCommand],
          completedCommands: [],
          completedRuns: [],
          goalRevision: 9,
          startedMutationRevision: 5,
          lastMutationRevision: 5,
          complete: false,
        },
        commandRuns: [],
        testRuns: [{
          command: staleValidatorCommand,
          at: "2026-08-28T06:59:00.000Z",
          ok: false,
          passed: false,
          mutationRevision: 5,
          privateMutationRevision: 0,
          failureSignature: "stale-missing-validator",
          failureSummary: "python3: cannot open missing_local_validator.py",
        }],
      },
    },
  };
  const authoritativeValidatorRuntime = nextStepRuntimeConfig(
    { provider: "deepseek", taskProfile: "cad", commandCwd: workspace },
    authoritativeValidatorState
  );
  assert(
    authoritativeValidatorRuntime.testFailureRepairActive !== true &&
      authoritativeValidatorRuntime.requiredProjectCommandPending === true &&
      authoritativeValidatorRuntime.requiredProjectCommand === authoritativeValidatorCommand &&
      authoritativeValidatorRuntime.supersededTestFailureCommand === staleValidatorCommand,
    "a stale non-required validator failure suppressed the current turn's exact authoritative command"
  );
  const priorRevisionValidatorState = structuredClone(authoritativeValidatorState);
  delete priorRevisionValidatorState.meta.completionEvidenceRepair;
  priorRevisionValidatorState.meta.projectVerification.mutationRevision = 6;
  priorRevisionValidatorState.meta.activeExecutionContract.materialMutationRevision = 6;
  const priorRevisionValidatorRuntime = nextStepRuntimeConfig(
    { provider: "deepseek", taskProfile: "cad", commandCwd: workspace },
    priorRevisionValidatorState
  );
  assert(
    priorRevisionValidatorRuntime.testFailureRepairActive !== true &&
      priorRevisionValidatorRuntime.testVerificationPending !== true &&
      priorRevisionValidatorRuntime.testVerificationCommand !== staleValidatorCommand &&
      priorRevisionValidatorRuntime.supersededTestFailureCommand === staleValidatorCommand,
    "a prior-revision non-required validator failure was reintroduced after the current turn mutated the source"
  );
  priorRevisionValidatorState.meta.completionEvidenceRepair = {
    key: "prior-revision-final-validation",
    at: "2026-08-28T07:01:00.000Z",
  };
  const priorRevisionCompletionRuntime = nextStepRuntimeConfig(
    { provider: "deepseek", taskProfile: "cad", commandCwd: workspace },
    priorRevisionValidatorState
  );
  assert(
    priorRevisionCompletionRuntime.testFailureRepairActive !== true &&
      priorRevisionCompletionRuntime.testVerificationPending !== true &&
      priorRevisionCompletionRuntime.requiredProjectCommandPending === true &&
      priorRevisionCompletionRuntime.requiredProjectCommand === authoritativeValidatorCommand,
    "completion repair did not select the current exact validator after superseding a prior-revision failure"
  );
  const stillRequiredPriorFailureState = structuredClone(priorRevisionValidatorState);
  stillRequiredPriorFailureState.meta.activeExecutionContract.requiredProjectCommands = [
    staleValidatorCommand,
  ];
  stillRequiredPriorFailureState.meta.projectVerification.contractRequiredCommands = [
    staleValidatorCommand,
  ];
  stillRequiredPriorFailureState.meta.projectVerification.requiredCommandBatch = {
    id: "required-command-batch-10",
    key: JSON.stringify([staleValidatorCommand]),
    requiredCommands: [staleValidatorCommand],
    completedCommands: [],
    completedRuns: [],
    goalRevision: 9,
    startedMutationRevision: 6,
    lastMutationRevision: 6,
    complete: false,
  };
  const stillRequiredPriorFailureRuntime = nextStepRuntimeConfig(
    { provider: "deepseek", taskProfile: "cad", commandCwd: workspace },
    stillRequiredPriorFailureState
  );
  assert(
    stillRequiredPriorFailureRuntime.testVerificationPending === true &&
      stillRequiredPriorFailureRuntime.testVerificationCommand === staleValidatorCommand,
    "a prior-revision failure was discarded even though the current turn still requires the same command"
  );
  const preservedTailOutput = trimCommandOutput(
    `${"long test output\n".repeat(1000)}EXIT=0\n`,
    800
  );
  assert(
    preservedTailOutput.length <= 800 && parseExplicitExitStatus(preservedTailOutput) === 0,
    "bounded shell output truncation discarded the terminal exit-status evidence"
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
      verifiedCompletionCandidate: { version: 1, mutationRevision: 4, goalRevision: 1 },
      completedDeepResearch: [{ goalKey: "retained-other-goal" }],
    },
  };
  const removedGoalState = resetGoalScopedRuntimeState(newGoalState);
  assert(removedGoalState.includes("artifactProgress"), "new goal did not clear stale artifact progress");
  assert(!newGoalState.meta.projectVerification, "new goal retained stale project verification");
  assert(!newGoalState.meta.scs, "new goal retained the previous SCS task contract");
  assert(
    !newGoalState.meta.verifiedCompletionCandidate,
    "new goal retained a prior verification completion candidate"
  );
  assert(!newGoalState.meta.durableEvidenceCategories, "new goal inherited completed evidence categories");
  assert(newGoalState.meta.goalContract?.revision === 2, "new goal reset its durable goal contract");
  assert(newGoalState.meta.completedDeepResearch?.length === 1, "new goal discarded goal-keyed research cache");

  const durableVerification = {
    mutationRevision: 4,
    requiredOutputs: ["handoff.md", "coverage.json"],
    requiredCommands: ["node scripts/check-handoff.js"],
  };
  const concreteContinuationState = {
    goal: "Repair the source provenance in the existing handoff.",
    plan: "Inspect one old output and repair it.",
    meta: {
      goalContract: {
        version: 2,
        revision: 3,
        status: "paused",
        taskGoal: "Create and validate the experiment handoff.",
        currentRequest: "Repair the source provenance in the existing handoff.",
      },
      artifactProgress: { complete: true, exactOutputPaths: ["README.md"] },
      completionEvidenceRepair: { attempts: 1 },
      failedTestRecoveryPacket: { content: "old repair" },
      projectVerification: durableVerification,
      scs: {
        taskContract: { exactOutputPaths: ["README.md"] },
        acceptanceCriteria: ["Only the old output is in scope."],
      },
      toolLoop: { staticCounts: { stale: 2 }, staticTotal: 2 },
    },
  };
  const concreteContinuation =
    "Two follow-up notes arrived. Continue the same task from saved state: update the existing handoff and coverage, validate the repository state, and commit the coherent update.";
  const leadingContinuationState = structuredClone(concreteContinuationState);
  const leadingContinuationUpdate = applyContinuationContractTransition(
    leadingContinuationState,
    `Continue the same task from the saved state. Restore the damaged source ledger, rerun validation, and commit the coherent repair. ${"Preserve the complete retained context while applying this concrete correction. ".repeat(12)}`,
    { at: "2026-08-24T09:59:00.000Z" }
  );
  assert(
    leadingContinuationUpdate?.preserveTaskBoundary &&
      leadingContinuationUpdate?.refreshExecutionContract,
    "a leading bare continuation clause followed by concrete details became a new task"
  );
  const activeTaskContinuationState = structuredClone(concreteContinuationState);
  const retainedActiveTaskVerification = activeTaskContinuationState.meta.projectVerification;
  const activeTaskContinuationUpdate = applyContinuationContractTransition(
    activeTaskContinuationState,
    `Continue the exact active DevOps task from the current workspace. Diagnose the retained failures from exact evidence, rerun validation, and commit the coherent repair. ${"Preserve the existing task lineage while applying this correction. ".repeat(12)}`,
    { at: "2026-08-24T09:59:30.000Z" }
  );
  assert(
    activeTaskContinuationUpdate?.preserveTaskBoundary &&
      activeTaskContinuationUpdate?.refreshExecutionContract,
    "an explicit exact active-task continuation opened a new task boundary"
  );
  assert(
    activeTaskContinuationState.meta.projectVerification === retainedActiveTaskVerification,
    "an exact active-task continuation discarded durable verification evidence"
  );
  const recoverPrompt =
    "Recover the same unfinished task from its current broken intermediate state. Re-read the current production source and tests, replace the accumulated partial edits with one coherent minimal implementation, run the canonical checks, clean generated outputs, and commit only after the repository is verified.";
  const recoverContinuationState = {
    goal: "Implement and verify the Java event-window summary.",
    plan: "Repair the production source, run scripts/test.sh, and commit the verified result.",
    meta: {
      taskProfile: "coding",
      goalContract: {
        version: 3,
        revision: 4,
        status: "paused",
        currentRequest: "Implement and verify the Java event-window summary.",
        taskGoal: "Implement and verify the Java event-window summary.",
        activeGoal: "Implement and verify the Java event-window summary.",
        activeGoalRevision: 4,
        history: [],
        lifecycle: [],
      },
      projectVerification: {
        mutationRevision: 7,
        requiredOutputs: [],
        requiredCommands: ["bash scripts/test.sh"],
        testRuns: [{
          command: "bash scripts/test.sh",
          mutationRevision: 7,
          passed: false,
        }],
      },
      failedTestRecoveryPacket: {
        command: "bash scripts/test.sh",
        mutationRevision: 7,
      },
    },
  };
  const retainedRecoverVerification = recoverContinuationState.meta.projectVerification;
  const recoverContinuationUpdate = applyContinuationContractTransition(
    recoverContinuationState,
    recoverPrompt,
    { at: "2026-08-29T03:10:00.000Z" }
  );
  assert(
    preservesCurrentTaskBoundary(
      {
        goal: "Implement and verify the Java event-window summary.",
        meta: {
          goalContract: {
            taskGoal: "Implement and verify the Java event-window summary.",
          },
        },
      },
      recoverPrompt
    ),
    "an explicit recover-the-same-task prompt opened a new task boundary"
  );
  assert(
    recoverContinuationUpdate?.preserveTaskBoundary === true &&
      recoverContinuationState.meta.goalContract.taskRelation === "same-task" &&
      recoverContinuationState.meta.goalContract.taskGoal ===
        "Implement and verify the Java event-window summary." &&
      recoverContinuationState.meta.projectVerification === retainedRecoverVerification,
    "same-task recovery discarded the original goal or durable verifier evidence"
  );
  const postMutationVerifier = "python3 -m unittest discover -s tests -v";
  const postMutationVerificationState = {
    goal: "Repair and verify the current service controller.",
    meta: {
      goalContract: {
        revision: 12,
        currentRequest: "Repair and verify the current service controller.",
      },
      activeExecutionContract: {
        revision: 12,
        startedMutationRevision: 7,
        materialMutationRevision: 8,
        requiresFileMutation: true,
        requiresSourceGrounding: true,
      },
      projectVerification: {
        mutationRevision: 8,
        testRuns: [{
          command: postMutationVerifier,
          mutationRevision: 7,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "pre-repair-failure",
        }],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 7,
        failureSignature: "pre-repair-failure",
        content: "Bounded failed-test evidence packet v17.",
      },
    },
  };
  const postMutationVerificationRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "devops",
      commandCwd: workspace,
      goal: postMutationVerificationState.goal,
    },
    postMutationVerificationState
  );
  assert(
    postMutationVerificationRuntime.testVerificationPending === true &&
      postMutationVerificationRuntime.testVerificationCommand === postMutationVerifier,
    "a material failed-test repair did not advance directly to its exact retained verifier"
  );
  const generatedDeckValidatorPath = path.join(
    tempRoot,
    "acceptance",
    "presentation_deck_contract.py"
  );
  await fs.mkdir(path.dirname(generatedDeckValidatorPath), { recursive: true });
  await fs.writeFile(
    generatedDeckValidatorPath,
    "raise SystemExit('acceptance fixture')\n",
    "utf8"
  );
  const generatedDeckValidator =
    `python3 ${generatedDeckValidatorPath} --root .`;
  const opaqueExternalValidatorState = {
    goal: [
      "Create the requested workbook from the local inputs.",
      `Run exactly: \`${generatedDeckValidator}\``,
      "Do not edit that external validator.",
    ].join("\n"),
    meta: {
      taskProfile: "data",
      goalContract: {
        revision: 1,
        currentRequest: "Create the requested workbook and run the exact validator.",
      },
      projectVerification: {
        mutationRevision: 0,
        mutationHistory: [],
        commandRuns: [],
        testRuns: [],
      },
      toolLoop: { recent: [] },
    },
  };
  const opaqueExternalValidatorRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "data",
      commandCwd: workspace,
      goal: opaqueExternalValidatorState.goal,
    },
    opaqueExternalValidatorState
  );
  assert(
    JSON.stringify(opaqueExternalValidatorRuntime.opaqueExternalValidatorPaths) ===
      JSON.stringify([generatedDeckValidatorPath]) &&
      JSON.stringify(opaqueExternalValidatorRuntime.opaqueExternalValidatorCommands) ===
        JSON.stringify([generatedDeckValidator]),
    "an exact external validator was not retained as an opaque execute-only contract before its first run"
  );
  await fs.mkdir(path.join(workspace, "inputs"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "inputs", "measurements.csv"),
    "item,measurement_mm\nseat_diameter,40.2\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(workspace, "build_deck.py"),
    [
      "from pathlib import Path",
      "import argparse",
      "import csv",
      "import datetime",
      "import hashlib",
      "import io",
      "import json",
      "import os",
      "import tempfile",
      "import zipfile",
      "ROOT = Path(__file__).resolve().parent",
      "INPUT_CSV = ROOT / 'inputs' / 'measurements.csv'",
      "",
      "def write_manifest():",
      "    payload = {'artifacts': []}",
      "    return payload",
      "",
      "print('build canonical deck')",
      "",
    ].join("\n"),
    "utf8"
  );
  const staleGeneratedDeckState = {
    goal: [
      "Rebuild the canonical presentation output after repairing build_deck.py.",
      "Do not modify source_brief.md, measurements.csv,",
      "prompt.txt, or TASK.md.",
      `Run ${generatedDeckValidator} only after the generated deck is fresh.`,
    ].join("\n"),
    meta: {
      taskProfile: "slides",
      goalContract: {
        revision: 13,
        currentRequest: "Rebuild the canonical presentation output from build_deck.py.",
      },
      activeExecutionContract: {
        revision: 13,
        startedMutationRevision: 8,
        materialMutationRevision: 9,
        requiresFileMutation: true,
        requiresSourceGrounding: true,
      },
      projectVerification: {
        mutationRevision: 9,
        mutationHistory: [
          { revision: 8, toolName: "run_command", paths: [] },
          { revision: 9, toolName: "apply_patch", paths: ["build_deck.py"] },
        ],
        commandRuns: [{
          command:
            'rm -rf dist && echo "removed dist" && python3 build_deck.py && ls -la output',
          at: "2026-08-27T18:18:14.726Z",
          ok: true,
          mutationRevision: 8,
          privateMutationRevision: 0,
        }],
        testRuns: [{
          command: generatedDeckValidator,
          at: "2026-08-27T18:24:28.347Z",
          mutationRevision: 9,
          privateMutationRevision: 0,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "stale-generated-deck",
          failureSummary: "acceptance failed: deck omits source-grounded phrase: single reader",
        }],
      },
      completionEvidenceRepair: {
        key: "stale-generated-deck-repair",
        at: "2026-08-27T19:00:00.000Z",
        mutationRevision: 9,
        requiresFreshFileMutation: true,
        requiredFreshMutationRevision: 10,
      },
      sourceCodeQuality: {
        checked: true,
        ok: true,
        paths: ["build_deck.py"],
        defects: [],
        mutationRevision: 9,
      },
    },
  };
  const staleGeneratedDeckRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: staleGeneratedDeckState.goal,
    },
    staleGeneratedDeckState
  );
  const staleGeneratedDeckPhase = buildKnownConstrainedPhasePlan(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: staleGeneratedDeckState.goal,
    },
    staleGeneratedDeckState,
    staleGeneratedDeckRuntime
  );
  assert(
    staleGeneratedDeckRuntime.generatedArtifactProducerPending === true &&
      staleGeneratedDeckRuntime.generatedArtifactProducerCommand === "python3 build_deck.py" &&
      staleGeneratedDeckRuntime.completionFreshMutationRequired !== true &&
      staleGeneratedDeckPhase?.mode === "generated-artifact-producer" &&
      staleGeneratedDeckPhase?.command === "python3 build_deck.py",
    `a stale generated artifact did not recover its exact safe producer before validation: ${JSON.stringify(
      staleGeneratedDeckRuntime
    )}`
  );
  const repairedSourceBeforeProducerState = structuredClone(staleGeneratedDeckState);
  repairedSourceBeforeProducerState.meta.projectVerification.mutationRevision = 10;
  repairedSourceBeforeProducerState.meta.projectVerification.mutationHistory.push({
    revision: 10,
    toolName: "apply_patch",
    paths: ["build_deck.py"],
  });
  repairedSourceBeforeProducerState.meta.activeExecutionContract.materialMutationRevision = 10;
  repairedSourceBeforeProducerState.meta.sourceCodeQuality.mutationRevision = 10;
  const repairedSourceBeforeProducerRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: repairedSourceBeforeProducerState.goal,
    },
    repairedSourceBeforeProducerState
  );
  const repairedSourceBeforeProducerPhase = buildKnownConstrainedPhasePlan(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: repairedSourceBeforeProducerState.goal,
    },
    repairedSourceBeforeProducerState,
    repairedSourceBeforeProducerRuntime
  );
  assert(
    repairedSourceBeforeProducerRuntime.generatedArtifactProducerPending === true &&
      repairedSourceBeforeProducerRuntime.generatedArtifactProducerCommand ===
        "python3 build_deck.py" &&
      repairedSourceBeforeProducerPhase?.mode === "generated-artifact-producer" &&
      repairedSourceBeforeProducerPhase?.command === "python3 build_deck.py",
    `a source repair exposed the stale validator before rebuilding generated artifacts: ${JSON.stringify({
      runtime: repairedSourceBeforeProducerRuntime,
      phase: repairedSourceBeforeProducerPhase,
    })}`
  );
  const documentRepairBeforeProducerState = structuredClone(
    repairedSourceBeforeProducerState
  );
  documentRepairBeforeProducerState.meta.projectVerification.testRuns = [];
  documentRepairBeforeProducerState.meta.completionEvidenceRepair = {
    key: "document-quality-repair",
    at: "2026-08-27T19:00:00.000Z",
    mutationRevision: 9,
    requiresFreshFileMutation: true,
    requiredFreshMutationRevision: 10,
    artifactQualityRepairRequired: true,
  };
  const documentRepairBeforeProducerRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "writing",
      commandCwd: workspace,
      goal: documentRepairBeforeProducerState.goal,
    },
    documentRepairBeforeProducerState
  );
  assert(
    documentRepairBeforeProducerRuntime.generatedArtifactProducerPending === true &&
      documentRepairBeforeProducerRuntime.generatedArtifactProducerCommand ===
        "python3 build_deck.py" &&
      documentRepairBeforeProducerRuntime.taskOwnedCommitPending !== true,
    `a document-quality source repair reached Git completion before rebuilding its derived artifact: ${JSON.stringify(
      documentRepairBeforeProducerRuntime
    )}`
  );
  const missingDocumentRequirement = completionRepairMutationRequirement({
    contract: { requiresFileMutation: false },
    evaluation: { missing: [] },
    documentQuality: {
      checked: true,
      ok: false,
      defects: [{ code: "missing-document-artifact" }],
    },
    projectMutationRevision: 7,
    documentArtifactProducerAvailable: true,
  });
  assert(
    missingDocumentRequirement.requiresFreshFileMutation === false &&
      missingDocumentRequirement.documentArtifactGenerationRequired === true &&
      missingDocumentRequirement.artifactQualityRepairRequired === false,
    `a missing compiled document incorrectly reopened source mutation: ${JSON.stringify(
      missingDocumentRequirement
    )}`
  );
  const missingDocumentSourceRequirement = completionRepairMutationRequirement({
    contract: { requiresFileMutation: false },
    evaluation: { missing: [] },
    documentQuality: {
      checked: true,
      ok: false,
      defects: [{ code: "missing-document-artifact" }],
    },
    projectMutationRevision: 7,
    documentArtifactProducerAvailable: false,
  });
  assert(
    missingDocumentSourceRequirement.requiresFreshFileMutation === true &&
      missingDocumentSourceRequirement.documentArtifactGenerationRequired === false &&
      missingDocumentSourceRequirement.artifactQualityRepairRequired === true &&
      missingDocumentSourceRequirement.requiredFreshMutationRevision === 8,
    `a missing document artifact without source did not require source creation: ${JSON.stringify(
      missingDocumentSourceRequirement
    )}`
  );
  await fs.writeFile(
    path.join(workspace, "report.tex"),
    "\\documentclass{article}\\begin{document}Report\\end{document}\n",
    "utf8"
  );
  const missingDocumentArtifactState = {
    goal: "Compile the prepared report.tex into report.pdf, verify it, and commit the intentional work.",
    messages: [],
    meta: {
      taskProfile: "writing",
      goalContract: {
        revision: 1,
        activeGoalRevision: 1,
      },
      projectVerification: {
        mutationRevision: 1,
        privateMutationRevision: 0,
        mutationHistory: [{
          revision: 1,
          at: "2026-08-27T19:10:00.000Z",
          toolName: "write_file",
          paths: ["report.tex"],
          goalRevision: 1,
        }],
        commandRuns: [],
        testRuns: [],
      },
      completionEvidenceRepair: {
        key: "missing-document-artifact",
        at: "2026-08-27T19:11:00.000Z",
        mutationRevision: 1,
        requiresFreshFileMutation: false,
        requiredFreshMutationRevision: 0,
        artifactQualityRepairRequired: false,
        documentArtifactGenerationRequired: true,
        documentArtifactProducerCommand:
          "pdflatex -interaction=nonstopmode -halt-on-error 'report.tex'",
      },
    },
  };
  const missingDocumentArtifactRuntime = nextStepRuntimeConfig(
    {
      goal: missingDocumentArtifactState.goal,
      provider: "localllm",
      taskProfile: "writing",
      commandCwd: workspace,
    },
    missingDocumentArtifactState
  );
  assert(
    missingDocumentArtifactRuntime.generatedArtifactProducerPending === true &&
      missingDocumentArtifactRuntime.generatedArtifactProducerCommand ===
        "pdflatex -interaction=nonstopmode -halt-on-error 'report.tex'" &&
      missingDocumentArtifactRuntime.completionFreshMutationRequired !== true &&
      missingDocumentArtifactRuntime.taskOwnedCommitPending !== true,
    `a missing document artifact did not schedule its bounded producer before Git completion: ${JSON.stringify(
      missingDocumentArtifactRuntime
    )}`
  );
  const failedDocumentProducerState = structuredClone(
    missingDocumentArtifactState
  );
  recordProjectVerificationOutcome(
    failedDocumentProducerState,
    {
      toolName: "run_command",
      ok: false,
      exitCode: 1,
      args: {
        command:
          "pdflatex -interaction=nonstopmode -halt-on-error 'report.tex'",
      },
      stdout: "! LaTeX Error: Undefined control sequence at line 12.\nNo output PDF file produced.",
      stderr: "",
      commandPolicy: {
        category: "toolchain",
        writesWorkspace: true,
        mayMutateProject: true,
      },
      projectMutationPaths: ["report.aux", "report.log"],
    },
    {
      goal: failedDocumentProducerState.goal,
      provider: "localllm",
      taskProfile: "writing",
      commandCwd: workspace,
      generatedArtifactProducerPending: true,
      generatedArtifactProducerCommand:
        "pdflatex -interaction=nonstopmode -halt-on-error 'report.tex'",
    }
  );
  assert(
    failedDocumentProducerState.meta.generatedArtifactProducerFailure?.sourcePaths?.includes(
      "report.tex"
    ),
    `a failed generated-artifact producer did not retain its exact source repair contract: ${JSON.stringify(
      failedDocumentProducerState.meta.generatedArtifactProducerFailure || {}
    )}`
  );
  const failedDocumentProducerRuntime = nextStepRuntimeConfig(
    {
      goal: failedDocumentProducerState.goal,
      provider: "localllm",
      taskProfile: "writing",
      commandCwd: workspace,
    },
    failedDocumentProducerState
  );
  assert(
    failedDocumentProducerRuntime.generatedArtifactProducerRepairActive === true &&
      failedDocumentProducerRuntime.completionFreshMutationRequired === true &&
      failedDocumentProducerRuntime.completionFreshMutationRevision === 2 &&
      failedDocumentProducerRuntime.completionFreshMutationPaths.includes(
        "report.tex"
      ) &&
      failedDocumentProducerRuntime.generatedArtifactProducerPending !== true,
    `a failed generated-artifact producer was replayed instead of routing to bounded source repair: ${JSON.stringify(
      failedDocumentProducerRuntime
    )}`
  );
  const missingArtifactCommitWorkspace = path.join(
    tempRoot,
    "missing-artifact-commit"
  );
  await fs.mkdir(missingArtifactCommitWorkspace, { recursive: true });
  const missingArtifactCommitState = {
    goal:
      "Create editable memo.tex and compiled mobile-readable memo.pdf, verify both, and commit only the intentional work.",
    messages: [],
    meta: {
      taskProfile: "writing",
      goalContract: {
        revision: 1,
        activeGoalRevision: 1,
        currentRequest:
          "Create editable memo.tex and compiled mobile-readable memo.pdf, verify both, and commit only the intentional work.",
      },
      projectVerification: {
        mutationRevision: 1,
        privateMutationRevision: 0,
        mutationHistory: [{ revision: 1, paths: ["memo.md"] }],
      },
    },
  };
  assert(
    prematureRequestedArtifactCommitBlock(
      missingArtifactCommitState,
      "run_command",
      {
        command:
          "git add -- 'memo.md' && git commit -m 'Complete LaTeX report'",
      },
      {
        goal: missingArtifactCommitState.goal,
        taskProfile: "writing",
        commandCwd: missingArtifactCommitWorkspace,
      }
    )?.category === "requested-artifact-incomplete",
    "Git completion was allowed before exact requested document artifacts existed"
  );
  const precommitDocumentQualityState = {
    goal:
      "Create editable memo.tex and compiled mobile-readable memo.pdf, verify both, and commit only the intentional work.",
    messages: [],
    meta: {
      taskProfile: "writing",
      goalContract: {
        revision: 2,
        activeGoalRevision: 2,
        activeGoal:
          "Create editable memo.tex and compiled mobile-readable memo.pdf, verify both, and commit only the intentional work.",
      },
      projectVerification: {
        mutationRevision: 3,
        privateMutationRevision: 0,
        mutationHistory: [{
          revision: 3,
          toolName: "write_file",
          paths: ["memo.tex"],
        }],
      },
    },
  };
  let precommitValidatorInput = null;
  const precommitQualityBlock = await documentQualityCommitAssessment(
    precommitDocumentQualityState,
    "run_command",
    {
      command:
        "git add -- 'memo.tex' 'memo.pdf' && git commit -m 'Complete memo'",
    },
    {
      commandCwd: missingArtifactCommitWorkspace,
      taskProfile: "writing",
      taskOwnedCommitPaths: ["memo.tex", "memo.pdf"],
      documentArtifactValidator: async (input) => {
        precommitValidatorInput = input;
        return {
          ok: false,
          checked: true,
          artifacts: [{ path: "memo.pdf" }],
          defects: [{
            code: "duplicated-prose-fragment",
            message: "The report repeats one non-adjacent paragraph.",
          }],
          reason: "The report repeats one non-adjacent paragraph.",
        };
      },
    }
  );
  assert(
    precommitQualityBlock?.ok === false &&
      precommitQualityBlock.category === "document-quality-incomplete" &&
      precommitDocumentQualityState.meta.completionEvidenceRepair
        ?.requiresFreshFileMutation === true &&
      precommitDocumentQualityState.meta.completionEvidenceRepair
        ?.requiredFreshMutationRevision === 4,
    "a failed independent document check did not block Git and open a bounded source repair"
  );
  assertStrict.deepEqual(
    precommitValidatorInput?.exactOutputPaths,
    ["memo.tex", "memo.pdf"],
    "pre-commit document validation should inspect the exact task-owned commit paths when filenames were inferred during execution"
  );
  const precommitQualityPass = await documentQualityCommitAssessment(
    precommitDocumentQualityState,
    "run_command",
    {
      command:
        "git add -- 'memo.tex' 'memo.pdf' && git commit -m 'Complete memo'",
    },
    {
      commandCwd: missingArtifactCommitWorkspace,
      taskProfile: "writing",
      documentArtifactValidator: async () => ({
        ok: true,
        checked: true,
        artifacts: [{ path: "memo.pdf" }],
        defects: [],
        reason: "Independent document checks passed.",
      }),
    }
  );
  assert(
    precommitQualityPass?.ok === true &&
      precommitDocumentQualityState.meta.completionEvidenceRepair === undefined,
    "a passing pre-commit document check did not clear its bounded repair marker"
  );
  const currentGoalGeneratedDocumentState = {
    goal:
      "Read TASK.md, produce a verified PDF memo for the current task, and commit only the intentional work.",
    messages: [],
    meta: {
      taskProfile: "writing",
      goalContract: {
        revision: 5,
        activeGoalRevision: 5,
        activeGoal:
          "Read TASK.md, produce a verified PDF memo for the current task, and commit only the intentional work.",
      },
      projectVerification: {
        mutationRevision: 12,
        privateMutationRevision: 0,
        mutationHistory: [
          {
            revision: 8,
            at: "2026-09-01T09:00:00.000Z",
            toolName: "run_command",
            paths: ["stale-root.pdf"],
            goalRevision: 4,
          },
          {
            revision: 11,
            at: "2026-09-01T09:05:00.000Z",
            toolName: "write_file",
            paths: ["daily_memo.tex"],
            goalRevision: 5,
          },
          {
            revision: 12,
            at: "2026-09-01T09:06:00.000Z",
            toolName: "run_command",
            paths: [
              "daily_memo.pdf",
              "daily_memo.aux",
              "/tmp/escape.pdf",
              ".env.pdf",
              "secrets/hidden.pdf",
            ],
            goalRevision: 5,
          },
        ],
      },
    },
  };
  let currentGoalDocumentValidatorInput = null;
  const currentGoalDocumentAssessment = await documentQualityCommitAssessment(
    currentGoalGeneratedDocumentState,
    "run_command",
    { command: "git add -- daily_memo.tex daily_memo.pdf && git commit -m memo" },
    {
      commandCwd: missingArtifactCommitWorkspace,
      taskProfile: "writing",
      documentArtifactValidator: async (input) => {
        currentGoalDocumentValidatorInput = input;
        return {
          ok: true,
          checked: true,
          artifacts: [{ path: "daily_memo.pdf" }],
          defects: [],
          reason: "Independent document checks passed for daily_memo.pdf.",
        };
      },
    }
  );
  assert(
    currentGoalDocumentAssessment?.ok === true &&
      currentGoalDocumentValidatorInput?.exactOutputPaths?.includes(
        "daily_memo.pdf"
      ) &&
      !currentGoalDocumentValidatorInput.exactOutputPaths.includes(
        "stale-root.pdf"
      ) &&
      !currentGoalDocumentValidatorInput.exactOutputPaths.includes(
        "daily_memo.aux"
      ) &&
      !currentGoalDocumentValidatorInput.exactOutputPaths.includes(
        "secrets/hidden.pdf"
      ),
    `a current-goal generated root PDF was not discovered safely for pre-commit validation: ${JSON.stringify(
      currentGoalDocumentValidatorInput
    )}`
  );
  const unrelatedRootWorkspace = path.join(
    tempRoot,
    "unrelated-root-document"
  );
  await fs.mkdir(unrelatedRootWorkspace, { recursive: true });
  await fs.writeFile(
    path.join(unrelatedRootWorkspace, "unrelated.pdf"),
    "pre-existing root PDF that the current goal did not create",
    "utf8"
  );
  const unrelatedRootDocumentState = {
    goal:
      "Produce a verified PDF artifact for this task and commit the intentional work.",
    messages: [],
    meta: {
      taskProfile: "writing",
      goalContract: {
        revision: 6,
        activeGoalRevision: 6,
        activeGoal:
          "Produce a verified PDF artifact for this task and commit the intentional work.",
      },
      projectVerification: {
        mutationRevision: 4,
        privateMutationRevision: 0,
        mutationHistory: [
          {
            revision: 3,
            at: "2026-09-01T09:10:00.000Z",
            toolName: "run_command",
            paths: ["unrelated.pdf"],
            goalRevision: 5,
          },
          {
            revision: 4,
            at: "2026-09-01T09:12:00.000Z",
            toolName: "write_file",
            paths: ["notes.tex"],
            goalRevision: 6,
          },
        ],
      },
    },
  };
  let unrelatedRootValidatorInput = null;
  const unrelatedRootAssessment = await documentQualityCommitAssessment(
    unrelatedRootDocumentState,
    "run_command",
    { command: "git add -- notes.tex && git commit -m notes" },
    {
      commandCwd: unrelatedRootWorkspace,
      taskProfile: "writing",
      documentArtifactValidator: async (input) => {
        unrelatedRootValidatorInput = input;
        return {
          ok: false,
          checked: true,
          artifacts: [],
          defects: [{ code: "missing-document-artifact" }],
          reason: "No readable DOCX or PDF artifact was found for the completed document task.",
        };
      },
    }
  );
  assert(
    unrelatedRootAssessment?.ok === false &&
      unrelatedRootAssessment.category === "document-quality-incomplete" &&
      !unrelatedRootValidatorInput?.exactOutputPaths?.includes(
        "unrelated.pdf"
      ),
    `an unrelated pre-existing root PDF was accepted as current-goal evidence: ${JSON.stringify(
      unrelatedRootValidatorInput
    )}`
  );
  const semanticGateDocumentState = structuredClone(
    currentGoalGeneratedDocumentState
  );
  semanticGateDocumentState.meta.scs = {
    taskContract: { exactInputPaths: ["TASK.md"] },
  };
  let semanticGateValidatorInput = null;
  const semanticGateAssessment = await documentQualityCommitAssessment(
    semanticGateDocumentState,
    "run_command",
    { command: "git add -- daily_memo.tex daily_memo.pdf && git commit -m memo" },
    {
      commandCwd: missingArtifactCommitWorkspace,
      taskProfile: "writing",
      documentArtifactValidator: async (input) => {
        semanticGateValidatorInput = input;
        return {
          ok: false,
          checked: true,
          artifacts: [{ path: "daily_memo.pdf" }],
          defects: [{
            code: "source-topic-coverage-incomplete",
            path: "daily_memo.pdf",
            message: "The memo omitted current source-status facts.",
          }],
          reason: "daily_memo.pdf: The memo omitted current source-status facts.",
        };
      },
    }
  );
  assert(
    semanticGateAssessment?.ok === false &&
      semanticGateAssessment.category === "document-quality-incomplete" &&
      semanticGateDocumentState.meta.completionEvidenceRepair
        ?.artifactQualityRepairRequired === true &&
      semanticGateDocumentState.meta.completionEvidenceRepair
        ?.documentArtifactGenerationRequired !== true &&
      semanticGateValidatorInput?.exactOutputPaths?.includes(
        "daily_memo.pdf"
      ) &&
      semanticGateValidatorInput?.exactInputPaths?.includes("TASK.md"),
    `current-goal artifact discovery bypassed source/status quality gates or reopened the missing-artifact loop: ${JSON.stringify({
      assessment: semanticGateAssessment,
      input: semanticGateValidatorInput,
      repair: semanticGateDocumentState.meta.completionEvidenceRepair,
    })}`
  );
  await fs.writeFile(
    path.join(missingArtifactCommitWorkspace, "TASK.md"),
    [
      "# Task",
      "Produce an editable LaTeX source plus a compiled mobile-readable PDF.",
      "Verify the PDF and commit only intentional project files.",
    ].join("\n"),
    "utf8"
  );
  const groundedTaskCallId = "grounded-project-task";
  const groundedTaskState = {
    goal:
      "This project is incomplete. Inspect it, finish it properly, verify it, and commit the intentional work.",
    messages: [
      {
        role: "assistant",
        tool_calls: [{
          id: groundedTaskCallId,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "TASK.md" }),
          },
        }],
      },
      {
        role: "tool",
        tool_call_id: groundedTaskCallId,
        content: JSON.stringify({
          ok: true,
          toolName: "read_file",
          path: "TASK.md",
          content: [
            "# Task",
            "Produce an editable LaTeX source plus a compiled mobile-readable PDF.",
            "Verify the PDF and commit only intentional project files.",
          ].join("\n"),
          contentTruncated: false,
          contentTruncatedByLines: false,
        }),
      },
    ],
    meta: {
      taskProfile: "writing",
      goalContract: {
        revision: 1,
        activeGoalRevision: 1,
        activeGoal:
          "This project is incomplete. Inspect it, finish it properly, verify it, and commit the intentional work.",
      },
      projectVerification: {
        mutationRevision: 0,
        privateMutationRevision: 0,
      },
    },
  };
  const groundedTaskContract = completionTaskContract(
    {
      goal: groundedTaskState.goal,
      taskProfile: "writing",
      commandCwd: missingArtifactCommitWorkspace,
    },
    groundedTaskState
  );
  assert(
    groundedTaskContract.requiredArtifactKinds.some(
      (item) => item.extension === ".tex"
    ) &&
      groundedTaskContract.requiredArtifactKinds.some(
        (item) => item.extension === ".pdf"
      ) &&
      groundedTaskContract.requiredGitActions.includes("commit"),
    `a completely read project TASK did not become the artifact/Git contract for a generic finish request: ${JSON.stringify(
      groundedTaskContract
    )}`
  );
  const compactedGroundedTaskState = structuredClone(groundedTaskState);
  recordProjectVerificationOutcome(
    compactedGroundedTaskState,
    {
      toolName: "read_file",
      ok: true,
      path: "TASK.md",
      args: { path: "TASK.md" },
      content: [
        "# Task",
        "Produce an editable LaTeX source plus a compiled mobile-readable PDF.",
        "Verify the PDF and commit only intentional project files.",
      ].join("\n"),
      contentTruncated: false,
      contentTruncatedByLines: false,
    },
    {
      goal: compactedGroundedTaskState.goal,
      taskProfile: "writing",
      commandCwd: missingArtifactCommitWorkspace,
    }
  );
  compactedGroundedTaskState.messages = [];
  const compactedGroundedContract = completionTaskContract(
    {
      goal: compactedGroundedTaskState.goal,
      taskProfile: "writing",
      commandCwd: missingArtifactCommitWorkspace,
    },
    compactedGroundedTaskState
  );
  assert(
    compactedGroundedContract.requiredArtifactKinds.some(
      (item) => item.extension === ".tex"
    ) &&
      compactedGroundedContract.requiredArtifactKinds.some(
        (item) => item.extension === ".pdf"
      ),
    `compaction discarded the persisted project TASK artifact contract: ${JSON.stringify(
      compactedGroundedContract
    )}`
  );
  const missingRequestedSourceRuntime = nextStepRuntimeConfig(
    {
      goal: compactedGroundedTaskState.goal,
      taskProfile: "writing",
      commandCwd: missingArtifactCommitWorkspace,
    },
    compactedGroundedTaskState
  );
  assert(
    missingRequestedSourceRuntime.requestedArtifactRequirementsPending === true &&
      missingRequestedSourceRuntime.requestedArtifactCreationExtensions?.includes(".tex"),
    `a missing requested LaTeX source did not activate deterministic creation: ${JSON.stringify(
      missingRequestedSourceRuntime
    )}`
  );
  assertStrict.equal(
    buildKnownConstrainedPhasePlan(
      {
        goal: compactedGroundedTaskState.goal,
        taskProfile: "writing",
        commandCwd: missingArtifactCommitWorkspace,
      },
      compactedGroundedTaskState,
      missingRequestedSourceRuntime
    )?.mode,
    "requested-artifact-creation",
    "a missing requested editable source did not become the only constrained phase"
  );
  const resetCompactedGroundedTaskState = structuredClone(compactedGroundedTaskState);
  resetGoalScopedRuntimeState(resetCompactedGroundedTaskState);
  assertStrict.equal(
    resetCompactedGroundedTaskState.meta.groundedProjectTaskInstruction,
    undefined,
    "goal reset retained a stale persisted project TASK contract"
  );
  await fs.writeFile(
    path.join(missingArtifactCommitWorkspace, "memo.tex"),
    "\\documentclass{article}\\begin{document}Memo\\end{document}\n",
    "utf8"
  );
  const requestedLatexProducerFailureState = structuredClone(
    compactedGroundedTaskState
  );
  requestedLatexProducerFailureState.meta.projectVerification = {
    mutationRevision: 1,
    privateMutationRevision: 0,
    mutationHistory: [{
      revision: 1,
      toolName: "write_file",
      paths: ["memo.tex"],
      goalRevision: 1,
    }],
    commandRuns: [],
    testRuns: [],
  };
  requestedLatexProducerFailureState.meta.generatedArtifactProducerFailure = {
    version: 1,
    command: "pdflatex -interaction=nonstopmode -halt-on-error 'memo.tex'",
    attempts: 1,
    goalRevision: 1,
    mutationRevision: 1,
    sourcePaths: ["memo.tex"],
    failureSummary:
      "! Missing $ inserted.\nl.12 This report synthesizes the complete `chat_history.md` evidence.",
    at: new Date().toISOString(),
  };
  const requestedLatexProducerFailureRuntime = nextStepRuntimeConfig(
    {
      goal: requestedLatexProducerFailureState.goal,
      taskProfile: "writing",
      commandCwd: missingArtifactCommitWorkspace,
    },
    requestedLatexProducerFailureState
  );
  assert(
    requestedLatexProducerFailureRuntime.generatedArtifactProducerRepairActive === true &&
      requestedLatexProducerFailureRuntime.completionFreshMutationRequired === true &&
      requestedLatexProducerFailureRuntime.completionFreshMutationPaths?.includes("memo.tex") &&
      requestedLatexProducerFailureRuntime.generatedArtifactProducerPending !== true,
    `a failed producer for a semantically requested PDF replayed instead of routing to source repair: ${JSON.stringify(
      requestedLatexProducerFailureRuntime
    )}`
  );
  const diagnosticLatexSource = [
    "\\documentclass{article}",
    "\\usepackage{geometry}",
    "\\geometry{margin=20mm}",
    "\\title{Project Memo}",
    "\\author{}",
    "\\date{}",
    "\\begin{document}",
    "\\maketitle",
    "\\begin{abstract}",
    "The memo preserves bounded project evidence.",
    "The source remains editable and reviewable.",
    "This report synthesizes the complete `chat_history.md` evidence.",
    "\\end{abstract}",
    "\\end{document}",
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(missingArtifactCommitWorkspace, "memo.tex"),
    diagnosticLatexSource,
    "utf8"
  );
  const directDiagnosticAnchor = generatedArtifactProducerDiagnosticLineAnchor(
    requestedLatexProducerFailureState,
    "memo.tex",
    diagnosticLatexSource
  );
  const sectionedLatexSource = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section*{Completed}",
    "\\begin{itemize}",
    "\\item Book backup is verified.",
    "\\end{itemize}",
    "\\section*{Pending}",
    "\\begin{itemize}",
    "\\item Instagram login is required.",
    "\\end{itemize}",
    "\\end{document}",
    "",
  ].join("\n");
  const latexSectionAnchor = derivePatchContextAnchor(
    sectionedLatexSource,
    "\\item Book backup is verified."
  );
  assert(
    latexSectionAnchor?.anchorIdentity === "latex:section:Completed" &&
      latexSectionAnchor.lineStart === 3 &&
      latexSectionAnchor.lineEnd === 6 &&
      !latexSectionAnchor.search.includes("\\section*{Pending}"),
    `a LaTeX document repair widened beyond its containing section: ${JSON.stringify(
      latexSectionAnchor
    )}`
  );
  assert(
    patchContextReplacementScopeIssue(
      latexSectionAnchor,
      [
        "\\section*{Completed}",
        "\\begin{itemize}",
        "\\item Book backup remains unverified.",
        "",
      ].join("\n")
    )?.changedLatexEnvironments?.includes("itemize"),
    "a LaTeX section repair was allowed to drop its closing environment boundary"
  );
  assert(
    directDiagnosticAnchor?.anchorKind === "producer-diagnostic-line" &&
      directDiagnosticAnchor.lineStart === 12 &&
      directDiagnosticAnchor.lineEnd === 12 &&
      directDiagnosticAnchor.search.includes("`chat_history.md`") &&
      !directDiagnosticAnchor.search.includes("\\begin{abstract}"),
    `a compiler line diagnostic widened beyond its exact current source line: ${JSON.stringify(
      directDiagnosticAnchor
    )}`
  );
  const consumedProducerDiagnostic =
    consumeGeneratedArtifactProducerDiagnosticRead(
      requestedLatexProducerFailureState,
      {
        toolName: "read_file",
        ok: true,
        path: "memo.tex",
        content: diagnosticLatexSource,
      }
    );
  const diagnosticRepairRuntime = nextStepRuntimeConfig(
    {
      goal: requestedLatexProducerFailureState.goal,
      taskProfile: "writing",
      commandCwd: missingArtifactCommitWorkspace,
    },
    requestedLatexProducerFailureState
  );
  assert(
    consumedProducerDiagnostic?.diagnosticLine === 12 &&
      consumedProducerDiagnostic.repairHint.includes("chat\\_history.md") &&
      diagnosticRepairRuntime.patchContextRepairRequired === true &&
      diagnosticRepairRuntime.patchContextRepairAnchorKind ===
        "producer-diagnostic-line" &&
      diagnosticRepairRuntime.patchContextRepairLineStart === 12 &&
      diagnosticRepairRuntime.patchContextRepairLineEnd === 12 &&
      diagnosticRepairRuntime.patchContextRepairTriggerCategory ===
        "generated-artifact-producer-diagnostic" &&
      diagnosticRepairRuntime.patchContextRepairDiagnosticHint.includes(
        "chat\\_history.md"
      ) &&
      diagnosticRepairRuntime.patchContextRepairEvidenceReplacement.includes(
        "chat\\_history.md"
      ),
    `a successful producer-source read did not install an exact diagnostic-bound repair: ${JSON.stringify({
      consumedProducerDiagnostic,
      diagnosticRepairRuntime,
    })}`
  );
  const diagnosticEvidenceReplacement =
    diagnosticRepairRuntime.patchContextRepairEvidenceReplacement;
  const producerDiagnosticContract = createToolContract([
      {
        type: "function",
        function: {
          name: "apply_patch",
          description: "Apply one exact compiler-evidenced repair.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", enum: ["memo.tex"] },
              search: { type: "string" },
              replace: {
                type: "string",
                enum: [diagnosticEvidenceReplacement],
              },
              expectedReplacements: { type: "integer", enum: [1] },
            },
            required: ["replace"],
            additionalProperties: false,
          },
        },
      },
    ]);
  const recoveredOversizedProducerPatch =
    recoverProducerDiagnosticEvidencePatch(
      diagnosticRepairRuntime,
      requestedLatexProducerFailureState,
      [
        {
          id: "call_oversized_producer_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              replace: `${directDiagnosticAnchor.search}${diagnosticLatexSource}`,
            }),
          },
        },
      ],
      producerDiagnosticContract,
      {
        ok: false,
        errors: [
          {
            code: "TOOL_ARGUMENTS_SCHEMA_INVALID",
            path: "$",
          },
          {
            code: "ARGUMENT_STRING_TOO_LONG",
            path: "$.replace",
          },
        ],
      }
    );
  assert(
    recoveredOversizedProducerPatch?.ok === true &&
      recoveredOversizedProducerPatch
        .recoveredProducerDiagnosticEvidencePatch === true &&
      JSON.parse(
        recoveredOversizedProducerPatch.acceptedToolCalls[0].function
          .arguments
      ).replace === diagnosticEvidenceReplacement,
    `an oversized local-model patch was not recovered as the exact compiler-evidenced replacement: ${JSON.stringify(
      recoveredOversizedProducerPatch
    )}`
  );
  const appendOnlyProducerRepair = bindPatchContextRepairArguments(
    requestedLatexProducerFailureState,
    {
      replace:
        `${directDiagnosticAnchor.search.trimEnd()} Compilation is verified.\n`,
    }
  );
  assert(
    appendOnlyProducerRepair?.scopeIssue?.retainedFailedAnchor === true,
    "an append-only producer repair retained the complete compiler-failing line unchanged"
  );
  const producerScopeRefresh = patchContextRefreshDecision(
    requestedLatexProducerFailureState,
    {
      toolName: "apply_patch",
      ok: false,
      category: "patch-context-scope-mismatch",
      args: {
        path: "memo.tex",
        searchHash: directDiagnosticAnchor.searchHash,
      },
    }
  );
  assert(
    producerScopeRefresh?.producerDiagnosticRepair === true &&
      producerScopeRefresh.diagnosticLine === 12 &&
      producerScopeRefresh.completeFileFallback === false,
    `a rejected producer patch discarded its exact diagnostic location: ${JSON.stringify(
      producerScopeRefresh
    )}`
  );
  delete requestedLatexProducerFailureState.meta.toolLoop.patchContextRepair;
  requestedLatexProducerFailureState.meta.toolLoop.patchContextRequired =
    producerScopeRefresh;
  const refreshedProducerDiagnostic = consumePatchContextRefreshRead(
    requestedLatexProducerFailureState,
    {
      toolName: "read_file",
      ok: true,
      path: "memo.tex",
      content: diagnosticLatexSource,
    }
  );
  assert(
    refreshedProducerDiagnostic?.repairAnchorKind ===
      "producer-diagnostic-line" &&
      refreshedProducerDiagnostic.repairAnchorLineStart === 12 &&
      refreshedProducerDiagnostic.repairAnchorLineEnd === 12 &&
      requestedLatexProducerFailureState.meta.toolLoop.patchContextRepair
        ?.triggerCategory === "generated-artifact-producer-diagnostic" &&
      requestedLatexProducerFailureState.meta.toolLoop.patchContextRepair
        ?.repairHint.includes("chat\\_history.md"),
    `a producer retry refresh widened its compiler line into a broad source anchor: ${JSON.stringify(
      refreshedProducerDiagnostic
    )}`
  );
  const correctedProducerRepair = bindPatchContextRepairArguments(
    requestedLatexProducerFailureState,
    {
      replace:
        "This report synthesizes the complete \\texttt{chat\\_history.md} evidence.\n",
    }
  );
  assert(
    correctedProducerRepair?.scopeIssue === null &&
      correctedProducerRepair.args.search === directDiagnosticAnchor.search,
    `a direct correction of the compiler-reported source line was not accepted: ${JSON.stringify(
      correctedProducerRepair
    )}`
  );
  assert(
    prematureRequestedArtifactCommitBlock(
      groundedTaskState,
      "run_command",
      {
        command:
          "git add -- 'memo_report.tex' && git commit -m 'Finish report'",
      },
      {
        goal: groundedTaskState.goal,
        taskProfile: "writing",
        commandCwd: missingArtifactCommitWorkspace,
      }
    )?.category === "requested-artifact-incomplete",
    "a generic project-finish request ignored the artifact contract from its completely read TASK.md"
  );
  for (const command of [
    "pdflatex -interaction=nonstopmode -halt-on-error 'memo.tex'",
    'xelatex -interaction=nonstopmode -halt-on-error "memo.tex"',
    "latexmk -pdf -interaction=nonstopmode -halt-on-error 'memo.tex'",
  ]) {
    const policy = evaluateCommandPolicy(command, {
      commandCwd: missingArtifactCommitWorkspace,
      allowShellTool: true,
      allowDestructive: false,
      sandboxMode: "host",
      packageInstallPolicy: "block",
    });
    assert(
      policy.allowed === true && policy.category === "toolchain",
      `a bounded quoted LaTeX producer was not allowed: ${command}`
    );
  }
  assert(
    isSubstantiveTestCommand(generatedDeckValidator, {
      commandCwd: workspace,
      testVerificationPending: true,
      testVerificationCommand: generatedDeckValidator,
    }),
    "an exact retained external validator was not treated as authoritative verification"
  );
  const exactValidatorFailureState = structuredClone(repairedSourceBeforeProducerState);
  recordProjectVerificationOutcome(
    exactValidatorFailureState,
    {
      toolName: "run_command",
      ok: false,
      exitCode: 1,
      args: { command: generatedDeckValidator },
      stdout: "FAIL: manifest parameters omit holder_width_mm\n",
      stderr: "",
      commandPolicy: {
        category: "general-shell",
        writesWorkspace: true,
        mayMutateProject: true,
        substantiveTest: false,
      },
    },
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: exactValidatorFailureState.goal,
      testVerificationPending: true,
      testVerificationCommand: generatedDeckValidator,
      allowShellTool: true,
      sandboxMode: "host",
    }
  );
  const exactValidatorRecordedTest =
    exactValidatorFailureState.meta.projectVerification.testRuns.at(-1);
  const exactValidatorRepairRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: exactValidatorFailureState.goal,
    },
    exactValidatorFailureState
  );
  assert(
    exactValidatorFailureState.meta.projectVerification.mutationRevision === 10 &&
      exactValidatorRecordedTest?.command === generatedDeckValidator &&
      exactValidatorRecordedTest?.passed === false &&
      exactValidatorRecordedTest?.mutationRevision === 10 &&
      exactValidatorRepairRuntime.testFailureRepairActive === true &&
      exactValidatorRepairRuntime.testVerificationPending !== true,
    `an exact external validator failure was not retained as current repair evidence: ${JSON.stringify({
      verification: exactValidatorFailureState.meta.projectVerification,
      runtime: exactValidatorRepairRuntime,
    })}`
  );
  const staleGeneratedDeckSourceDefectState = JSON.parse(
    JSON.stringify(staleGeneratedDeckState)
  );
  staleGeneratedDeckSourceDefectState.meta.sourceCodeQuality = {
    checked: true,
    ok: false,
    paths: ["build_deck.py"],
    defects: ["build_deck.py still contains a concrete source defect"],
    mutationRevision: 9,
  };
  const staleGeneratedDeckSourceDefectRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: staleGeneratedDeckSourceDefectState.goal,
    },
    staleGeneratedDeckSourceDefectState
  );
  const staleGeneratedDeckSourceDefectPhase = buildKnownConstrainedPhasePlan(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: staleGeneratedDeckSourceDefectState.goal,
    },
    staleGeneratedDeckSourceDefectState,
    staleGeneratedDeckSourceDefectRuntime
  );
  assert(
    staleGeneratedDeckSourceDefectRuntime.completionFreshMutationRequired === true &&
      staleGeneratedDeckSourceDefectPhase?.mode !== "generated-artifact-producer",
    `a retained source-quality defect was incorrectly bypassed by a stale artifact producer: ${JSON.stringify({
      runtime: staleGeneratedDeckSourceDefectRuntime,
      phase: staleGeneratedDeckSourceDefectPhase,
    })}`
  );
  recordProjectVerificationOutcome(
    staleGeneratedDeckState,
    {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command: "python3 build_deck.py" },
      stdout: "Wrote output/deck.pptx\n",
      stderr: "",
      commandPolicy: {
        category: "toolchain",
        writesWorkspace: true,
        mayMutateProject: false,
        substantiveTest: false,
      },
    },
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: staleGeneratedDeckState.goal,
      allowShellTool: true,
      sandboxMode: "host",
    }
  );
  const postProducerRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: staleGeneratedDeckState.goal,
    },
    staleGeneratedDeckState
  );
  assert(
    staleGeneratedDeckState.meta.projectVerification.mutationRevision === 10 &&
      postProducerRuntime.generatedArtifactProducerPending !== true &&
      postProducerRuntime.testVerificationPending === true &&
      postProducerRuntime.testVerificationCommand === generatedDeckValidator,
    `a successful producer replay did not advance exactly once to fresh validation: ${JSON.stringify({
      verification: staleGeneratedDeckState.meta.projectVerification,
      activeExecutionContract: staleGeneratedDeckState.meta.activeExecutionContract,
      runtime: postProducerRuntime,
    })}`
  );
  const failedAfterProducerState = structuredClone(staleGeneratedDeckState);
  failedAfterProducerState.meta.goalContract.taskGoal = failedAfterProducerState.goal;
  failedAfterProducerState.meta.projectVerification.mutationHistory.splice(1, 0, {
    revision: 8,
    toolName: "apply_patch",
    paths: ["TASK.md"],
  });
  failedAfterProducerState.meta.projectVerification.testRuns.push({
    command: generatedDeckValidator,
    at: "2026-08-27T19:05:00.000Z",
    mutationRevision: 10,
    privateMutationRevision: 0,
    passed: false,
    failureEvidenceVersion: 2,
    failureSignature: "fresh-generated-deck-visible-text",
    failureSummary: "acceptance failed: deck omits source-grounded phrase: single reader",
  });
  await fs.writeFile(
    path.join(workspace, "TASK.md"),
    "Treat source_brief.md, measurements.csv, prompt.txt, and TASK.md as immutable.\n",
    "utf8"
  );
  const failedAfterProducerPacket = await buildFailedTestRecoveryPacket(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: failedAfterProducerState.goal,
    },
    failedAfterProducerState
  );
  assert(
    JSON.stringify(failedAfterProducerPacket.repairPaths) ===
      JSON.stringify(["build_deck.py"]),
    "a fresh generated-artifact failure dropped its latest mutable producer or retained an explicitly immutable input"
  );
  failedAfterProducerState.meta.failedTestRecoveryPacket = {
    packetVersion: 17,
    content: failedAfterProducerPacket.content,
    paths: failedAfterProducerPacket.paths,
    repairPaths: failedAfterProducerPacket.repairPaths,
    mutationRevision: 10,
    failureSignature: "fresh-generated-deck-visible-text",
    generatedAt: "2026-08-27T19:05:01.000Z",
  };
  const failedAfterProducerRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: failedAfterProducerState.goal,
    },
    failedAfterProducerState
  );
  assert(
    JSON.stringify(failedAfterProducerRuntime.testFailureRepairContextPaths) ===
      JSON.stringify(["build_deck.py", "inputs/measurements.csv"]),
    "failed-test recovery did not preserve the canonical producer and its exact read-only input as separate context evidence"
  );
  assert(
    JSON.stringify(failedAfterProducerRuntime.testFailureDiagnosticReadPaths) ===
      JSON.stringify([generatedDeckValidatorPath]) &&
      failedAfterProducerRuntime.readOnlyRoots.includes(
        path.dirname(generatedDeckValidatorPath)
      ),
    "an exact external validator from the retained failed command was not exposed through a narrow read-only root"
  );
  const consumedExternalValidatorState = structuredClone(failedAfterProducerState);
  consumedExternalValidatorState.meta.toolLoop =
    consumedExternalValidatorState.meta.toolLoop || { recent: [] };
  consumedExternalValidatorState.meta.toolLoop.recent = [
    ...(consumedExternalValidatorState.meta.toolLoop.recent || []),
    {
      toolName: "read_file",
      path: generatedDeckValidatorPath,
      ok: true,
      blocked: false,
      goalRevision: 13,
      at: "2026-08-27T19:05:02.000Z",
    },
  ];
  const consumedExternalValidatorRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: consumedExternalValidatorState.goal,
    },
    consumedExternalValidatorState
  );
  assert(
    consumedExternalValidatorRuntime.testFailureDiagnosticReadPaths.length === 0,
    "an exact external validator remained exposed after its bounded read completed"
  );
  await fs.mkdir(path.join(workspace, "artifacts"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "artifacts", "manifest.json"),
    JSON.stringify(
      {
        schema: "generated-artifacts/v1",
        artifacts: [
          {
            name: "fixture.step",
            path: "artifacts/fixture.step",
            bytes: 120,
            sha256: "abc123",
          },
          {
            name: "PRINT_THIS_fixture.stl",
            path: "artifacts/PRINT_THIS_fixture.stl",
            bytes: 240,
            sha256: "def456",
          },
          {
            name: "PRINT_THIS_fixture.3mf",
            path: "artifacts/PRINT_THIS_fixture.3mf",
            bytes: 360,
            sha256: "789abc",
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
  const generatedManifestFailureState = structuredClone(failedAfterProducerState);
  generatedManifestFailureState.goal = [
    generatedManifestFailureState.goal,
    "Do not inspect the external acceptance-validator source.",
  ].join("\n");
  generatedManifestFailureState.meta.goalContract.taskGoal =
    generatedManifestFailureState.goal;
  generatedManifestFailureState.meta.projectVerification.requiredOutputs = [
    ...(generatedManifestFailureState.meta.projectVerification.requiredOutputs || []),
    "artifacts/manifest.json",
  ];
  const generatedManifestFailure =
    generatedManifestFailureState.meta.projectVerification.testRuns.at(-1);
  generatedManifestFailure.failureSignature = "generated-manifest-validation-evidence";
  generatedManifestFailure.failureSummary =
    "Failing tests: manifest lacks STEP/STL/3MF validation evidence.";
  generatedManifestFailure.failingTests = [
    "manifest lacks STEP/STL/3MF validation evidence",
  ];
  generatedManifestFailureState.meta.failedTestRecoveryPacket = {
    packetVersion: 17,
    content: "Current source packet for the generated manifest failure.",
    paths: ["build_deck.py"],
    repairPaths: ["build_deck.py"],
    mutationRevision: generatedManifestFailure.mutationRevision,
    failureSignature: generatedManifestFailure.failureSignature,
    command: generatedManifestFailure.command,
    generatedAt: "2026-08-27T19:05:01.000Z",
  };
  const generatedManifestGoalRevision = Math.max(
    0,
    Number(generatedManifestFailureState.meta.goalContract?.revision || 0)
  );
  assertStrict.deepEqual(
    failedTestWorkspaceDiagnosticReadPaths(
      {
        provider: "deepseek",
        taskProfile: "slides",
        commandCwd: workspace,
        goal: generatedManifestFailureState.goal,
      },
      generatedManifestFailureState,
      generatedManifestFailure
    ),
    ["artifacts/manifest.json"],
    "a named generated manifest failure did not expose the exact required text artifact"
  );
  const generatedManifestSemanticPacket = await buildFailedTestRecoveryPacket(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: generatedManifestFailureState.goal,
    },
    generatedManifestFailureState
  );
  assertStrict.match(
    generatedManifestSemanticPacket.content,
    /Generated-artifact semantic gap in artifacts\/manifest\.json/i,
    "the failed-test packet did not convert the generated manifest into bounded semantic evidence"
  );
  assertStrict.match(
    generatedManifestSemanticPacket.content,
    /artifact-record keys: bytes, name, path, sha256/i,
    "the generated diagnostic did not report the manifest structure it actually observed"
  );
  assertStrict.match(
    generatedManifestSemanticPacket.content,
    /No generated key records validation, verification, checks, evidence/i,
    "the generated diagnostic did not state the observed validation-evidence gap"
  );
  assertStrict.match(
    generatedManifestSemanticPacket.content,
    /canonical producer build_deck\.py/i,
    "the semantic gap was not routed back to the discovered canonical producer"
  );
  assert(
    generatedManifestSemanticPacket.paths.includes("inputs/measurements.csv") &&
      generatedManifestSemanticPacket.content.includes("seat_diameter,40.2"),
    "a Python pathlib input dependency was not retained in the failed-test packet"
  );
  assertStrict.match(
    generatedManifestSemanticPacket.content,
    /Focused canonical producer declaration in build_deck\.py \(write_manifest,[\s\S]*def write_manifest\(\):[\s\S]*return payload/,
    "the failed-test packet did not retain the complete declaration that produces the named manifest"
  );
  assert(
    generatedManifestFailureState.meta.failedTestDiagnostic.focuses.some(
      (focus) =>
        focus.kind === "generated-artifact-semantic-producer" &&
        focus.path === "build_deck.py" &&
        focus.directSearch.includes("def write_manifest():") &&
        focus.directSearch.includes("return payload")
    ),
    "the semantic producer declaration was not preserved as an exact patch anchor"
  );

  const compactProducerOriginal = await fs.readFile(
    path.join(workspace, "build_deck.py"),
    "utf8"
  );
  try {
    const longProducerLines = Array.from(
      { length: 132 },
      (_, index) =>
        `    stage_${index + 1} = "preserve unrelated generated-artifact production context ${index + 1}"`
    );
    await fs.writeFile(
      path.join(workspace, "build_deck.py"),
      [
        "from pathlib import Path",
        "import json",
        "",
        "def write_manifest():",
        ...longProducerLines,
        "    validation = {",
        '        "step": {"status": "checked"},',
        '        "stl": {"status": "checked"},',
        '        "3mf": {"status": "checked"},',
        "    }",
        "    artifacts = []",
        "    json_payload = {",
        '        "schema": "generated-artifacts/v1",',
        '        "validation": validation,',
        '        "artifacts": artifacts,',
        "    }",
        "    Path('artifacts/manifest.json').write_text(",
        "        json.dumps(json_payload, indent=2), encoding='utf8'",
        "    )",
        "    return json_payload",
        "",
      ].join("\n"),
      "utf8"
    );
    const longProducerState = structuredClone(generatedManifestFailureState);
    delete longProducerState.meta.failedTestRecoveryPacket;
    delete longProducerState.meta.failedTestDiagnostic;
    longProducerState.meta.toolLoop = { recent: [] };
    await buildFailedTestRecoveryPacket(
      {
        provider: "deepseek",
        taskProfile: "slides",
        commandCwd: workspace,
        goal: longProducerState.goal,
      },
      longProducerState
    );
    const compactFocus = longProducerState.meta.failedTestDiagnostic.focuses.find(
      (focus) =>
        focus.kind === "generated-artifact-semantic-producer" &&
        focus.path === "build_deck.py"
    );
    assert(
      compactFocus?.directSearch.includes("json_payload = {") &&
        compactFocus.directSearch.includes('"validation": validation') &&
        !compactFocus.directSearch.includes("def write_manifest") &&
        Buffer.byteLength(compactFocus.directSearch, "utf8") < 3_200,
      `a long semantic producer was not narrowed to its compact machine-readable manifest block: ${JSON.stringify(compactFocus)}`
    );
  } finally {
    await fs.writeFile(
      path.join(workspace, "build_deck.py"),
      compactProducerOriginal,
      "utf8"
    );
  }

  const redundantEvidenceProducerOriginal = await fs.readFile(
    path.join(workspace, "build_deck.py"),
    "utf8"
  );
  try {
    await fs.writeFile(
      path.join(workspace, "build_deck.py"),
      [
        "from pathlib import Path",
        "import json",
        "",
        "def write_manifest():",
        "    validation = {",
        '        "STEP": {"check": "readable", "passed": True},',
        '        "STL": {"check": "readable", "passed": True},',
        '        "3MF": {"check": "readable", "passed": True},',
        "    }",
        "    artifacts = []",
        "    json_payload = {",
        '        "validation": validation,',
        '        "validation_evidence": [',
        '            {"artifact": "STEP", "check": "readable", "passed": True},',
        '            {"artifact": "STL", "check": "readable", "passed": True},',
        '            {"artifact": "3MF", "check": "readable", "passed": True},',
        "        ],",
        '        "artifacts": artifacts,',
        '        "validation_results": [',
        '            {"artifact": "STEP", "check": "readable", "passed": True},',
        '            {"artifact": "STL", "check": "readable", "passed": True},',
        '            {"artifact": "3MF", "check": "readable", "passed": True},',
        "        ],",
        "    }",
        "    Path('artifacts/manifest.json').write_text(",
        "        json.dumps(json_payload, indent=2), encoding='utf8'",
        "    )",
        "    return json_payload",
        "",
      ].join("\n"),
      "utf8"
    );
    const evidenceReshapeState = structuredClone(generatedManifestFailureState);
    delete evidenceReshapeState.meta.failedTestRecoveryPacket;
    delete evidenceReshapeState.meta.failedTestDiagnostic;
    evidenceReshapeState.meta.toolLoop = { recent: [] };
    await buildFailedTestRecoveryPacket(
      {
        provider: "deepseek",
        taskProfile: "slides",
        commandCwd: workspace,
        goal: evidenceReshapeState.goal,
      },
      evidenceReshapeState
    );
    const evidenceReshapeFocus =
      evidenceReshapeState.meta.failedTestDiagnostic.focuses.find(
        (focus) =>
          focus.kind === "generated-artifact-semantic-producer" &&
          focus.path === "build_deck.py"
      );
    assert(
      evidenceReshapeFocus?.directSearch.includes('"validation_results": ['),
      "the semantic producer focus did not retain the redundant evidence shape"
    );
    const canonicalEvidenceReplacement = evidenceReshapeFocus.directSearch.replace(
      /        "validation_evidence": \[[\s\S]*?        \],\n        "artifacts": artifacts,\n        "validation_results": \[[\s\S]*?        \],/,
      [
        '        "artifacts": artifacts,',
        '        "validation_evidence": {',
        '            "STEP": validation["STEP"],',
        '            "STL": validation["STL"],',
        '            "3MF": validation["3MF"],',
        "        },",
      ].join("\n")
    );
    assertStrict.notStrictEqual(
      canonicalEvidenceReplacement,
      evidenceReshapeFocus.directSearch,
      "the regression fixture did not create a canonical evidence reshape"
    );
    const semanticTermPattern =
      /\b(?:validat(?:e|ed|es|ing|ion)?|checks?|evidence|pass(?:ed|es)?|results?)\b/gi;
    assert(
      [...canonicalEvidenceReplacement.matchAll(semanticTermPattern)].length <
        [...evidenceReshapeFocus.directSearch.matchAll(semanticTermPattern)].length,
      "the regression fixture did not reduce redundant semantic evidence terms"
    );
    const evidenceReshapeBlock = await failedTestRepairPatchBlock(
      evidenceReshapeState,
      "apply_patch",
      {
        path: "build_deck.py",
        search: evidenceReshapeFocus.directSearch,
        replace: canonicalEvidenceReplacement,
      },
      { commandCwd: workspace }
    );
    assertStrict.equal(
      evidenceReshapeBlock,
      null,
      "a material canonical STEP/STL/3MF evidence reshape was blocked because it reduced redundant keyword counts"
    );
  } finally {
    await fs.writeFile(
      path.join(workspace, "build_deck.py"),
      redundantEvidenceProducerOriginal,
      "utf8"
    );
  }

  const generatedManifestOriginal = await fs.readFile(
    path.join(workspace, "artifacts", "manifest.json"),
    "utf8"
  );
  try {
    const rejectedValidationShape = JSON.parse(generatedManifestOriginal);
    rejectedValidationShape.validation = {
      step: { status: "checked", bytes: 120 },
      stl: { status: "checked", bytes: 240 },
      "3mf": { status: "checked", bytes: 360 },
    };
    await fs.writeFile(
      path.join(workspace, "artifacts", "manifest.json"),
      JSON.stringify(rejectedValidationShape, null, 2),
      "utf8"
    );
    const rejectedShapeState = structuredClone(generatedManifestFailureState);
    delete rejectedShapeState.meta.failedTestRecoveryPacket;
    delete rejectedShapeState.meta.failedTestDiagnostic;
    rejectedShapeState.meta.toolLoop = { recent: [] };
    const rejectedShapePacket = await buildFailedTestRecoveryPacket(
      {
        provider: "deepseek",
        taskProfile: "slides",
        commandCwd: workspace,
        goal: rejectedShapeState.goal,
      },
      rejectedShapeState
    );
    assertStrict.match(
      rejectedShapePacket.content,
      /Generated-artifact evidence shape still rejected/i,
      "an existing but rejected validation shape suppressed the generated-artifact diagnostic"
    );
    assertStrict.match(
      rejectedShapePacket.content,
      /Observed validation-related keys:[^\n]*validation/i,
      "the rejected-shape diagnostic did not report the validation key it observed"
    );
    assertStrict.match(
      rejectedShapePacket.content,
      /Do not add another synonymous top-level list/i,
      "the rejected-shape diagnostic encouraged another already-rejected top-level alias"
    );
    assertStrict.doesNotMatch(
      rejectedShapePacket.content,
      /validation_evidence|required[_ -]?schema|verifier[_ -]?schema/i,
      "the rejected-shape diagnostic leaked or invented a hidden verifier-specific field"
    );
  } finally {
    await fs.writeFile(
      path.join(workspace, "artifacts", "manifest.json"),
      generatedManifestOriginal,
      "utf8"
    );
  }

  const unrelatedSemanticPatchBlock = await failedTestRepairPatchBlock(
    generatedManifestFailureState,
    "apply_patch",
    {
      path: "build_deck.py",
      search: "    payload = {'artifacts': []}",
      replace: "    payload = {'artifacts': [], 'mode': 'strict'}",
    },
    { commandCwd: workspace }
  );
  assertStrict.equal(
    unrelatedSemanticPatchBlock?.category,
    "failed-test-semantic-drift",
    "an unrelated producer parameter edit was allowed despite a retained generated-evidence gap"
  );
  const noChangeSemanticPatchBlock = await failedTestRepairPatchBlock(
    generatedManifestFailureState,
    "apply_patch",
    {
      path: "build_deck.py",
      search: "    payload = {'artifacts': []}",
      replace: "    payload = {'artifacts': []}",
    },
    { commandCwd: workspace }
  );
  assertStrict.equal(
    noChangeSemanticPatchBlock,
    null,
    "the semantic drift guard masked an exact no-change patch before executor recovery"
  );
  const semanticEvidencePatchBlock = await failedTestRepairPatchBlock(
    generatedManifestFailureState,
    "apply_patch",
    {
      path: "build_deck.py",
      search: "    payload = {'artifacts': []}",
      replace:
        "    payload = {'artifacts': [], 'validation': {'status': 'checked'}}",
    },
    { commandCwd: workspace }
  );
  assertStrict.equal(
    semanticEvidencePatchBlock,
    null,
    "a producer edit that introduces generated validation evidence was incorrectly blocked"
  );
  const explicitOutcomePatchBlock = await failedTestRepairPatchBlock(
    generatedManifestFailureState,
    "apply_patch",
    {
      path: "build_deck.py",
      search: "    payload = {'artifacts': []}",
      replace:
        "    payload = {'artifacts': [], 'passed': True, 'outcome': 'pass', 'measurements': {}}",
    },
    { commandCwd: workspace }
  );
  assertStrict.equal(
    explicitOutcomePatchBlock,
    null,
    "explicit pass/outcome/measurement evidence was mistaken for semantic drift"
  );
  generatedManifestFailureState.meta.failedTestRecoveryPacket = {
    packetVersion: 17,
    content: generatedManifestSemanticPacket.content,
    paths: generatedManifestSemanticPacket.paths,
    repairPaths: generatedManifestSemanticPacket.repairPaths,
    mutationRevision: generatedManifestFailure.mutationRevision,
    failureSignature: generatedManifestFailure.failureSignature,
    command: generatedManifestFailure.command,
    generatedAt: "2026-08-27T19:05:03.000Z",
  };
  const generatedManifestFocusedRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: generatedManifestFailureState.goal,
    },
    generatedManifestFailureState
  );
  assert(
    generatedManifestFocusedRuntime.testFailureRepairPatchTargets?.[0]?.kind ===
      "generated-artifact-semantic-producer" &&
      generatedManifestFocusedRuntime.testFailureRepairPatchTargets[0].search.includes(
        "def write_manifest():"
      ) &&
      JSON.stringify(generatedManifestFocusedRuntime.testFailureCanonicalRepairPaths) ===
        JSON.stringify(["build_deck.py"]),
    "a generated semantic gap was not promoted to the exact canonical producer repair target"
  );
  assertStrict.match(
    generatedManifestSemanticPacket.content,
    /do not keep changing unrelated design parameters or aliases/i,
    "the semantic gap did not suppress unrelated parameter-alias churn"
  );
  assertStrict.doesNotMatch(
    generatedManifestSemanticPacket.content,
    /required[_ -]?schema|validation_records|must equal true/i,
    "the generated diagnostic invented a hidden verifier-specific implementation contract"
  );
  const unrelatedManifestFailureState = structuredClone(
    generatedManifestFailureState
  );
  const unrelatedManifestFailure =
    unrelatedManifestFailureState.meta.projectVerification.testRuns.at(-1);
  unrelatedManifestFailure.failureSignature = "unrelated-manifest-title";
  unrelatedManifestFailure.failureSummary =
    "Failing tests: generated title is not viewer-facing.";
  unrelatedManifestFailure.failingTests = [
    "generated title is not viewer-facing",
  ];
  const unrelatedManifestPacket = await buildFailedTestRecoveryPacket(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: unrelatedManifestFailureState.goal,
    },
    unrelatedManifestFailureState
  );
  assertStrict.doesNotMatch(
    unrelatedManifestPacket.content,
    /Generated-artifact semantic gap/i,
    "an unrelated failed test received a fabricated manifest-validation diagnostic"
  );
  assertStrict.equal(
    toolResultWorkspacePath({
      toolName: "read_file",
      args: { path: "artifacts/manifest.json" },
      path: "artifacts/manifest.json",
    }),
    "artifacts/manifest.json",
    "the tool-loop evidence recorder discarded a safe generated diagnostic path"
  );
  assertStrict.equal(
    toolResultWorkspacePath({
      toolName: "read_file",
      args: { path: "artifacts/tube_cradle.step" },
      path: "artifacts/tube_cradle.step",
    }),
    "",
    "the diagnostic path recorder broadened consumption tracking to binary artifacts"
  );
  const generatedManifestRuntime = nextStepRuntimeConfig(
    {
      provider: "deepseek",
      taskProfile: "slides",
      commandCwd: workspace,
      goal: generatedManifestFailureState.goal,
    },
    generatedManifestFailureState
  );
  assert(
    generatedManifestRuntime.testFailureForbidExternalDiagnosticRead === true &&
      generatedManifestRuntime.testFailureExternalDiagnosticReadPaths.length === 0 &&
      JSON.stringify(generatedManifestRuntime.testFailureWorkspaceDiagnosticReadPaths) ===
        JSON.stringify(["artifacts/manifest.json"]) &&
      generatedManifestRuntime.testFailureDiagnosticReadPaths.includes(
        "artifacts/manifest.json"
      ),
    "forbidding external validator source also hid exact in-workspace generated diagnostic evidence"
  );
  const generatedManifestReadBeforeFailureState = structuredClone(
    generatedManifestFailureState
  );
  generatedManifestReadBeforeFailureState.meta.toolLoop = {
    recent: [
      {
        toolName: "read_file",
        path: "artifacts/manifest.json",
        ok: true,
        blocked: false,
        mutationRevision: generatedManifestFailure.mutationRevision,
        at: "2026-08-27T19:04:59.000Z",
      },
    ],
  };
  assert(
    nextStepRuntimeConfig(
      {
        provider: "deepseek",
        taskProfile: "slides",
        commandCwd: workspace,
        goal: generatedManifestReadBeforeFailureState.goal,
      },
      generatedManifestReadBeforeFailureState
    ).testFailureWorkspaceDiagnosticReadPaths.includes("artifacts/manifest.json"),
    "a stale pre-failure generated artifact read suppressed fresh diagnostic evidence"
  );
  const generatedManifestReadAfterFailureState = structuredClone(
    generatedManifestFailureState
  );
  generatedManifestReadAfterFailureState.meta.toolLoop = {
    recent: [
      {
        toolName: "read_file",
        path: "artifacts/manifest.json",
        ok: true,
        blocked: false,
        goalRevision: generatedManifestGoalRevision,
        mutationRevision: generatedManifestFailure.mutationRevision,
        at: "2026-08-27T19:05:02.000Z",
      },
    ],
  };
  assert(
    !nextStepRuntimeConfig(
      {
        provider: "deepseek",
        taskProfile: "slides",
        commandCwd: workspace,
        goal: generatedManifestReadAfterFailureState.goal,
      },
      generatedManifestReadAfterFailureState
    ).testFailureWorkspaceDiagnosticReadPaths.includes("artifacts/manifest.json"),
    "a current generated artifact diagnostic read remained exposed after consumption"
  );
  const generatedManifestPriorGoalReadState = structuredClone(
    generatedManifestReadAfterFailureState
  );
  generatedManifestPriorGoalReadState.meta.toolLoop.recent[0].goalRevision =
    Math.max(0, generatedManifestGoalRevision - 1);
  generatedManifestPriorGoalReadState.meta.goalContract.revision =
    generatedManifestGoalRevision;
  assert(
    nextStepRuntimeConfig(
      {
        provider: "deepseek",
        taskProfile: "slides",
        commandCwd: workspace,
        goal: generatedManifestPriorGoalReadState.goal,
      },
      generatedManifestPriorGoalReadState
    ).testFailureWorkspaceDiagnosticReadPaths.includes("artifacts/manifest.json"),
    "a prior-goal generated artifact read suppressed a bounded current-goal reread"
  );
  const generatedManifestLegacyBlankPathState = structuredClone(
    generatedManifestFailureState
  );
  generatedManifestLegacyBlankPathState.meta.toolLoop = {
    recent: [
      {
        signature: `file-read:${JSON.stringify({
          lineLimit: 0,
          path: path.join(workspace, "artifacts", "manifest.json"),
          startLine: 1,
        })}`,
        toolName: "read_file",
        path: "",
        ok: true,
        blocked: false,
        goalRevision: generatedManifestGoalRevision,
        mutationRevision: generatedManifestFailure.mutationRevision,
        at: "2026-08-27T19:05:02.000Z",
      },
    ],
  };
  assert(
    !nextStepRuntimeConfig(
      {
        provider: "deepseek",
        taskProfile: "slides",
        commandCwd: workspace,
        goal: generatedManifestLegacyBlankPathState.goal,
      },
      generatedManifestLegacyBlankPathState
    ).testFailureWorkspaceDiagnosticReadPaths.includes("artifacts/manifest.json"),
    "a legacy blank-path tool-loop entry did not consume its signed generated diagnostic read"
  );
  const immutableOnlyRepairState = {
    goal: "Treat service_ctl.py as immutable read-only source evidence and finish from existing results.",
    meta: {
      taskProfile: "devops",
      projectVerification: {
        mutationRevision: 0,
        mutationHistory: [],
        commandRuns: [],
        testRuns: [],
      },
      completionEvidenceRepair: {
        key: "protected-source-only",
        at: "2026-08-27T19:00:00.000Z",
        requiresFreshFileMutation: true,
        requiredFreshMutationRevision: 1,
      },
      toolLoop: { recent: [] },
    },
  };
  assert(
    nextStepRuntimeConfig(
      {
        provider: "deepseek",
        taskProfile: "devops",
        commandCwd: workspace,
        goal: immutableOnlyRepairState.goal,
      },
      immutableOnlyRepairState
    ).completionFreshMutationRequired !== true,
    "completion recovery forced a mutation when every concrete candidate was immutable"
  );
  const concreteGoalUpdate = applyContinuationContractTransition(
    concreteContinuationState,
    concreteContinuation,
    { at: "2026-08-24T10:00:00.000Z" }
  );
  assert(concreteGoalUpdate?.preserveTaskBoundary, "a concrete same-task interruption lost task continuity");
  assert(concreteGoalUpdate?.refreshExecutionContract, "a concrete same-task interruption retained stale acceptance state");
  assert(
    concreteContinuationState.goal === concreteContinuation,
    "a concrete interruption did not become the active execution goal"
  );
  assert(concreteContinuationState.plan === "", "a concrete interruption retained the obsolete phase plan");
  assert(!concreteContinuationState.meta.scs, "a concrete interruption retained the obsolete SCS contract");
  assert(!concreteContinuationState.meta.artifactProgress, "a concrete interruption retained stale artifact scope");
  assert(
    concreteContinuationState.meta.projectVerification === durableVerification,
    "a concrete interruption discarded durable project evidence"
  );
  assert(
    concreteContinuationState.meta.goalContract.taskGoal === "Create and validate the experiment handoff." &&
      concreteContinuationState.meta.goalContract.activeGoal === concreteContinuation &&
      concreteContinuationState.meta.goalContract.activeGoalRevision === 4,
    "the goal contract did not separate durable task lineage from the active interruption"
  );

  const exactVerifier = "python3 /tmp/security_labshare_contract.py";
  const exactStatus = "git status --short";
  const retainedUnitTest = "python3 -m unittest discover -s tests -v";
  const freshCommandState = {
    goal: "Repair and verify the current security task.",
    plan: "The prior implementation and validation are complete.",
    messages: [
      toolMessage({
        ok: true,
        toolName: "run_command",
        args: { command: retainedUnitTest },
        exitCode: 0,
        stdout: "OK",
        projectMutationRevision: 7,
        goalRevision: 5,
      }),
      toolMessage({
        ok: true,
        toolName: "run_command",
        args: { command: exactVerifier },
        exitCode: 0,
        stdout: "security_labshare_contract: PASS",
        projectMutationRevision: 7,
        requiredCommandBatchId: "required-command-batch-2",
        requiredProjectCommand: exactVerifier,
        goalRevision: 5,
      }),
      toolMessage({
        ok: true,
        toolName: "run_command",
        args: { command: exactStatus },
        exitCode: 0,
        stdout: "",
        projectMutationRevision: 7,
        requiredCommandBatchId: "required-command-batch-2",
        requiredProjectCommand: exactStatus,
        goalRevision: 5,
      }),
    ],
    meta: {
      taskProfile: "security",
      goalContract: {
        version: 3,
        revision: 5,
        status: "completed",
        taskGoal: "Repair and verify the current security task.",
        activeGoal: "Repair and verify the current security task.",
        currentRequest: "Repair and verify the current security task.",
        history: [{ revision: 5, taskHash: "same-security-task" }],
      },
      projectVerification: {
        mutationRevision: 7,
        requiredCommands: [retainedUnitTest],
        contractRequiredCommands: [exactVerifier, exactStatus],
        requiredCommandBatchSequence: 2,
        requiredCommandBatch: {
          id: "required-command-batch-2",
          key: JSON.stringify([exactVerifier, exactStatus]),
          requiredCommands: [exactVerifier, exactStatus],
          goalRevision: 5,
          completedCommands: [exactVerifier, exactStatus],
          completedRuns: [
            { command: exactVerifier, mutationRevision: 7 },
            { command: exactStatus, mutationRevision: 7 },
          ],
          startedMutationRevision: 7,
          lastMutationRevision: 7,
          complete: true,
        },
        commandRuns: [{
          command: retainedUnitTest,
          mutationRevision: 7,
          ok: true,
        }],
        testRuns: [],
      },
    },
  };
  const freshCommandRequest =
    "Continue the same corrective task. Run `python3 /tmp/security_labshare_contract.py`, verify `git status --short`, and finish without editing or recommitting files.";
  const freshCommandUpdate = applyContinuationContractTransition(
    freshCommandState,
    freshCommandRequest,
    { at: "2026-08-26T04:00:00.000Z" }
  );
  assert(
    freshCommandUpdate?.preserveTaskBoundary && freshCommandUpdate?.refreshExecutionContract,
    "an explicit same-task command rerun did not refresh the execution contract"
  );
  assert(
    JSON.stringify(freshCommandState.meta.activeExecutionContract.requiredProjectCommands) ===
      JSON.stringify([exactVerifier, exactStatus]),
    "the current turn lost an explicitly verified inline command"
  );
  assert(
    freshCommandState.meta.projectVerification.requiredCommandBatch.goalRevision === 6,
    "the fresh command batch was not bound to the current goal revision"
  );
  assert(
    freshCommandState.meta.projectVerification.requiredCommandBatch.completedCommands.length === 0,
    "retained command evidence pre-completed a current-turn rerun obligation"
  );
  const freshCommandConfig = {
    taskProfile: "security",
    commandCwd: workspace,
  };
  let freshCommandRuntime = nextStepRuntimeConfig(freshCommandConfig, freshCommandState);
  assert(
    freshCommandRuntime.requiredProjectCommandPending === true,
    "the current-turn verifier was not marked pending"
  );
  assert(
    freshCommandRuntime.requiredProjectCommand === exactVerifier,
    "the first explicitly repeated command was not pending"
  );
  const verifierResult = {
    ok: true,
    toolName: "run_command",
    args: { command: exactVerifier },
    exitCode: 0,
    stdout: "security_labshare_contract: PASS",
    stderr: "",
  };
  recordProjectVerificationOutcome(freshCommandState, verifierResult, freshCommandConfig);
  freshCommandState.messages.push(toolMessage(verifierResult));
  freshCommandRuntime = nextStepRuntimeConfig(freshCommandConfig, freshCommandState);
  assert(
    freshCommandRuntime.requiredProjectCommand === exactStatus,
    "the second current-turn command was not retained after the verifier passed"
  );
  const statusResult = {
    ok: true,
    toolName: "run_command",
    args: { command: exactStatus },
    exitCode: 0,
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(freshCommandState, statusResult, freshCommandConfig);
  freshCommandState.messages.push(toolMessage(statusResult));
  freshCommandRuntime = nextStepRuntimeConfig(freshCommandConfig, freshCommandState);
  assert(
    freshCommandRuntime.requiredProjectCommandPending !== true,
    "the fresh command batch stayed pending after both exact commands passed"
  );

  const bareContinuationState = {
    goal: concreteContinuation,
    plan: "Update both retained outputs, validate, and commit.",
    meta: {
      goalContract: {
        ...concreteContinuationState.meta.goalContract,
        status: "paused",
      },
      artifactProgress: { complete: false, exactOutputPaths: ["handoff.md", "coverage.json"] },
      projectVerification: durableVerification,
      scs: { taskContract: { exactOutputPaths: ["handoff.md", "coverage.json"] } },
      stepBudget: {
        initialMaxSteps: 30,
        currentMaxSteps: 81,
        hardCap: 90,
        extensionsUsed: 3,
      },
    },
  };
  const retainedPlan = bareContinuationState.plan;
  const retainedScs = bareContinuationState.meta.scs;
  const bareGoalUpdate = applyContinuationContractTransition(
    bareContinuationState,
    "Continue the same task from the saved state.",
    { at: "2026-08-24T10:05:00.000Z" }
  );
  assert(bareGoalUpdate?.preserveTaskBoundary, "a bare resume lost task continuity");
  assert(!bareGoalUpdate?.refreshExecutionContract, "a bare resume unnecessarily refreshed the active contract");
  assert(bareContinuationState.goal === concreteContinuation, "a bare resume forgot the latest concrete instruction");
  assert(bareContinuationState.plan === retainedPlan, "a bare resume discarded the approved active plan");
  assert(bareContinuationState.meta.scs === retainedScs, "a bare resume discarded the active SCS phase");
  assert(
    bareContinuationState.meta.stepBudget.currentMaxSteps === 81,
    "a bare resume discarded its approved expanded step budget"
  );
  assert(
    bareContinuationState.meta.goalContract.activeGoalRevision === 4,
    "a bare resume fabricated a new active-goal revision"
  );

  const isolatedRefreshState = {
    plan: "old plan",
    meta: {
      goalContract: { revision: 8 },
      artifactProgress: {},
      scs: {},
      stepBudget: {
        initialMaxSteps: 30,
        currentMaxSteps: 81,
        hardCap: 90,
        extensionsUsed: 3,
      },
      projectVerification: durableVerification,
    },
  };
  const isolatedRemoved = resetSameTaskExecutionContract(isolatedRefreshState, 8);
  assert(
    isolatedRemoved.includes("artifactProgress") && isolatedRemoved.includes("scs"),
    "same-task contract refresh did not report the removed per-turn state"
  );
  assert(
    isolatedRefreshState.meta.projectVerification === durableVerification,
    "same-task contract refresh removed durable verification evidence"
  );
  assert(
    isolatedRemoved.includes("stepBudget") && !isolatedRefreshState.meta.stepBudget,
    "a concrete same-task correction inherited an exhausted expanded step budget"
  );
  const newTaskBoundaryState = {
    goal: "Repair the old service controller.",
    meta: {
      taskProfile: "devops",
      goalContract: { revision: 4, taskGoal: "Repair the old service controller." },
      activeExecutionContract: {
        revision: 4,
        startedMutationRevision: 7,
        requiresFileMutation: true,
      },
      projectVerification: { mutationRevision: 7 },
      toolLoop: {
        staticCounts: { "file-read:service_ctl.py": 1 },
        staticOrder: ["file-read:service_ctl.py"],
        staticTotal: 1,
        staticCallTotal: 1,
      },
    },
  };
  const newTaskUpdate = applyContinuationContractTransition(
    newTaskBoundaryState,
    "Create deployment-status.md as a standalone report for a new project.",
    { at: "2026-08-26T10:04:00.000Z" }
  );
  assert(
    newTaskUpdate?.preserveTaskBoundary === false &&
      newTaskBoundaryState.meta.activeExecutionContract.revision === 5 &&
      newTaskBoundaryState.meta.activeExecutionContract.requiresFileMutation === true &&
      newTaskBoundaryState.meta.projectVerification === undefined &&
      newTaskBoundaryState.meta.toolLoop.staticTotal === 0 &&
      Object.keys(newTaskBoundaryState.meta.toolLoop.staticCounts).length === 0,
    "a true new-task boundary retained the prior task's execution contract or verification"
  );
  const sourceGroundingRefreshState = {
    goal: "Repair service_ctl.py and run its tests.",
    meta: {
      taskProfile: "devops",
      goalContract: {
        revision: 9,
        currentRequest: "Repair service_ctl.py and run its tests.",
      },
      projectVerification: { mutationRevision: 4 },
    },
  };
  resetSameTaskExecutionContract(sourceGroundingRefreshState, 9);
  assert(
    sourceGroundingRefreshState.meta.activeExecutionContract.requiresFileMutation === true &&
      sourceGroundingRefreshState.meta.activeExecutionContract.requiresSourceGrounding === true,
    "a concrete file correction did not require current source grounding"
  );
  const scopedStaticArtifactRequest =
    "Create and verify output/parity/result.json with one JSON object. Read it back and finish.";
  const scopedStaticArtifactGoal = [
    "You are the persistent LabCanvas agent.",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "task",
      request: scopedStaticArtifactRequest,
      artifact_root: "/tmp/labcanvas-task-1",
    })}`,
    "Read AGENTS.md and inspect implementation before editing.",
  ].join("\n\n");
  const scopedStaticArtifactState = {
    goal: scopedStaticArtifactGoal,
    meta: {
      taskProfile: "auto",
      goalContract: {
        revision: 10,
        currentRequest: scopedStaticArtifactGoal,
      },
      projectVerification: { mutationRevision: 0 },
    },
  };
  resetSameTaskExecutionContract(scopedStaticArtifactState, 10);
  assert(
    scopedStaticArtifactState.meta.activeExecutionContract.requiresFileMutation === true &&
      scopedStaticArtifactState.meta.activeExecutionContract.requiresSourceGrounding === false,
    "LabCanvas wrapper instructions leaked into the scoped static-artifact execution contract"
  );
  const concreteBudgetConfig = { maxSteps: 81, resetStepBudget: false };
  assert(
    applyConcreteContinuationStepBudgetBoundary(
      concreteBudgetConfig,
      { refreshExecutionContract: true },
      {
        initialMaxSteps: 36,
        currentMaxSteps: 81,
        hardCap: 90,
        extensionsUsed: 3,
      }
    ) === true &&
      concreteBudgetConfig.resetStepBudget === true &&
      concreteBudgetConfig.maxSteps === 36,
    "a concrete correction did not restore the original pre-extension step budget"
  );
  const explicitConcreteBudgetConfig = { maxSteps: 18, resetStepBudget: true };
  applyConcreteContinuationStepBudgetBoundary(
    explicitConcreteBudgetConfig,
    { refreshExecutionContract: true },
    { initialMaxSteps: 36, currentMaxSteps: 81 }
  );
  assert(
    explicitConcreteBudgetConfig.maxSteps === 18,
    "a concrete correction overrode an explicit operator max-steps boundary"
  );
  const bareBudgetConfig = { maxSteps: 81, resetStepBudget: false };
  assert(
    applyConcreteContinuationStepBudgetBoundary(
      bareBudgetConfig,
      { refreshExecutionContract: false },
      { initialMaxSteps: 36, currentMaxSteps: 81 }
    ) === false &&
      bareBudgetConfig.maxSteps === 81 &&
      bareBudgetConfig.resetStepBudget === false,
    "a bare resume reset its retained step budget"
  );

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
  const completedJavaVerificationContract = deriveScsTaskContract({
    goal:
      "Resume the same completed Java repair from its current committed state. Do not alter production source or authoritative tests. Run the retained project verifier once, remove only disposable generated build output, confirm the repository is clean, and finish without repeating completed commits.",
    taskProfile: "java",
  });
  assert(
    completedJavaVerificationContract.requiresWorkspaceMutation === false &&
      completedJavaVerificationContract.requiresFileMutation === false &&
      !completedJavaVerificationContract.requiredEvidence.some(
        (item) => item.category === "artifact"
      ) &&
      completedJavaVerificationContract.forbiddenActions.some((item) =>
        /alter production source/i.test(item)
      ),
    "a completed verification-only Java continuation was mistaken for a new source repair"
  );
  const completedJavaFollowupRepairContract = deriveScsTaskContract({
    goal:
      "Resume the completed Java repair, but fix src/main/java/example/WindowSummary.java if the overflow guard is still missing, then run the tests.",
    taskProfile: "java",
  });
  assert(
    completedJavaFollowupRepairContract.requiresWorkspaceMutation === true &&
      completedJavaFollowupRepairContract.requiresFileMutation === true,
    "a concrete follow-up source repair was suppressed as completed-work narration"
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
  const stagingVerificationState = {
    meta: {
      goalContract: { revision: 1 },
      projectVerification: {
        mutationRevision: 2,
        mutationHistory: [
          { revision: 1, paths: ["labshare.py"] },
          { revision: 2, paths: ["tests/test_labshare.py"] },
        ],
      },
    },
  };
  recordProjectVerificationOutcome(
    stagingVerificationState,
    {
      ok: true,
      toolName: "run_command",
      args: { command: "cd /workspace && git add labshare.py tests/test_labshare.py" },
      commandPolicy: {
        category: "git-workflow",
        gitOnly: true,
        writesWorkspace: true,
        mayMutateProject: false,
      },
      exitCode: 0,
      stdout: "",
      stderr: "",
    },
    { commandCwd: workspace, sandboxMode: "docker-workspace" }
  );
  assert(
    stagingVerificationState.meta.projectVerification.mutationRevision === 2,
    "staging task-owned paths invalidated passing project verification"
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
    isStaticDiscoveryToolCall("web_search", { query: "project memo guidance" }) &&
      isStaticDiscoveryToolCall("read_web_page", { url: "https://example.com/memo" }),
    "read-only web discovery was allowed to reset convergence"
  );
  const repeatedWebQuerySignature = staticToolCallSignature(
    "web_search",
    { query: "  Project   Memo Guidance ", maxResults: 10 },
    { commandCwd: workspace }
  );
  assert(
    repeatedWebQuerySignature ===
      staticToolCallSignature(
        "web_search",
        { query: "project memo guidance", provider: "research" },
        { commandCwd: workspace }
      ),
    "equivalent web searches did not share one semantic discovery signature"
  );
  assert(
    repeatedStaticToolBlock(
      {
        meta: {
          toolLoop: {
            staticCounts: { [repeatedWebQuerySignature]: 2 },
            staticOrder: [repeatedWebQuerySignature],
            staticTotal: 1,
          },
        },
      },
      "web_search",
      { query: "project memo guidance", maxResults: 5 },
      { commandCwd: workspace }
    )?.category === "repeated-read-only-call",
    "a third semantically identical web search was not blocked"
  );
  assert(
    !shouldResetStaticDiscoveryPhase({ ok: false, toolName: "read_image", args: { path: "missing.png" } }),
    "failed non-mutating perception should not reset static discovery convergence"
  );
  assert(
    shouldResetStaticDiscoveryPhase({ ok: true, toolName: "write_file", args: { path: "report.md" } }),
    "successful output creation should reset static discovery convergence"
  );
  assert(
    !shouldResetStaticDiscoveryPhase({
      ok: true,
      toolName: "run_command",
      args: { command: "python3 - <<'PY'\nprint('inspect only')\nPY" },
      commandPolicy: {
        writesWorkspace: true,
        mayMutateProject: false,
        substantiveTest: false,
      },
      exitCode: 0,
      stdout: "inspect only",
    }),
    "a read-only diagnostic shell probe reset static discovery because of a conservative write heuristic"
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
  const retainedDiscoveryState = {
    meta: {
      toolLoop: {
        recent: [],
        warned: ["file-read:/reference/A.md"],
        staticCounts: { "file-read:/reference/A.md": 2 },
        staticOrder: ["file-read:/reference/A.md"],
        staticTotal: 1,
        staticCallTotal: 2,
      },
    },
  };
  resetStaticDiscoveryAfterContextLoss(
    retainedDiscoveryState,
    "proactive-context-compaction",
    { preserveStaticEvidence: true }
  );
  assert(
    retainedDiscoveryState.meta.toolLoop.staticTotal === 1 &&
      retainedDiscoveryState.meta.toolLoop.staticCounts["file-read:/reference/A.md"] === 2,
    "lossless context compaction reopened already completed discovery"
  );
  assert(
    retainedDiscoveryState.meta.toolLoop.lastContextRecovery?.preservedStaticEvidence === true,
    "lossless context compaction did not record preserved discovery evidence"
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
      {
        meta: {
          projectVerification: { mutationRevision: 4 },
          toolLoop: {
            patchContextRequired: {
              version: 1,
              path: "service_ctl.py",
              mutationRevision: 4,
              goalRevision: 0,
            },
            staticCounts: {
              [staticToolCallSignature("read_file", { path: "service_ctl.py" }, {
                commandCwd: workspace,
              })]: 1,
            },
            staticTotal: 1,
          },
        },
      },
      "read_file",
      { path: "service_ctl.py" },
      { commandCwd: workspace }
    ) === null,
    "the repeated-read guard blocked an exact source refresh required after a stale patch"
  );
  assert(
    repeatedStaticToolBlock(
      {
        meta: {
          toolLoop: {
            staticCounts: {
              [staticToolCallSignature("read_file", { path: "service_ctl.py" }, {
                commandCwd: workspace,
              })]: 1,
            },
            staticTotal: 1,
          },
        },
      },
      "read_file",
      { path: "service_ctl.py" },
      {
        commandCwd: workspace,
        testFailureRepairContextPaths: ["service_ctl.py"],
      }
    ) === null,
    "the repeated-read guard blocked an exact bounded failed-test context refresh"
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
  const repeatedReadBlockState = {
    meta: {
      toolLoop: {
        recent: [
          {
            toolName: "read_file",
            signature: exactReadSignature,
            ok: false,
            blocked: true,
            category: "repeated-read-only-call",
          },
        ],
      },
    },
  };
  assert(
    JSON.stringify(convergenceSuppressedToolNames(repeatedReadBlockState)) ===
      JSON.stringify(["read_file"]),
    "an explicitly blocked duplicate read was not suppressed for the next model turn"
  );
  assert(
    JSON.stringify(nextStepRuntimeConfig({}, repeatedReadBlockState).convergenceSuppressedToolNames) ===
      JSON.stringify(["read_file"]),
    "the next-step runtime did not carry the convergence suppression into tool selection"
  );
  assert(
    JSON.stringify(
      convergenceSuppressedToolNames({
        meta: {
          toolLoop: {
            stagnationEpoch: 7,
            recent: [
              {
                toolName: "run_command",
                ok: false,
                blocked: true,
                category: "repeated-no-progress-call",
                stagnationEpoch: 7,
              },
              {
                toolName: "read_file",
                ok: true,
                blocked: false,
                stagnationEpoch: 7,
              },
            ],
          },
        },
      })
    ) === JSON.stringify(["run_command"]),
    "a harmless read incorrectly re-enabled a convergence-blocked command before mutation"
  );
  assert(
    convergenceSuppressedToolNames({
      meta: {
        toolLoop: {
          stagnationEpoch: 8,
          recent: [
            {
              toolName: "run_command",
              ok: false,
              blocked: true,
              category: "repeated-no-progress-call",
              stagnationEpoch: 7,
            },
            {
              toolName: "apply_patch",
              ok: true,
              blocked: false,
              successfulMutation: true,
              stagnationEpoch: 8,
            },
          ],
        },
      },
    }).length === 0,
    "a completed mutation did not clear an earlier convergence suppression epoch"
  );
  const boundedSynthesisWorkspace = path.join(
    tempRoot,
    "bounded-local-synthesis"
  );
  await fs.mkdir(boundedSynthesisWorkspace, { recursive: true });
  await fs.writeFile(
    path.join(boundedSynthesisWorkspace, "TASK.md"),
    "Read chat_history.md and produce an editable LaTeX source plus a compiled PDF.\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(boundedSynthesisWorkspace, "chat_history.md"),
    "Current facts for the local memo.\n",
    "utf8"
  );
  const boundedSynthesisMessages = [
    {
      role: "assistant",
      tool_calls: [{
        id: "bounded-task-read",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "TASK.md" }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "bounded-task-read",
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: "TASK.md",
        content:
          "Read chat_history.md and produce an editable LaTeX source plus a compiled PDF.\n",
        contentTruncated: false,
        contentTruncatedByLines: false,
      }),
    },
    {
      role: "assistant",
      tool_calls: [{
        id: "bounded-source-read",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "chat_history.md" }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "bounded-source-read",
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: "chat_history.md",
        content: "Current facts for the local memo.\n",
        contentTruncated: false,
        contentTruncatedByLines: false,
      }),
    },
  ];
  const boundedSynthesisState = {
    goal:
      "This project is incomplete. Inspect it, finish it, verify it, and commit the intentional work.",
    messages: boundedSynthesisMessages,
    meta: {
      taskProfile: "writing",
      goalContract: {
        revision: 4,
        activeGoalRevision: 4,
        activeGoal:
          "This project is incomplete. Inspect it, finish it, verify it, and commit the intentional work.",
      },
      projectVerification: {
        mutationRevision: 0,
        privateMutationRevision: 0,
      },
      toolLoop: {
        recent: ["web_search", "read_web_page"].map((toolName) => ({
          toolName,
          ok: true,
          blocked: false,
          goalRevision: 4,
          mutationRevision: 0,
        })),
      },
    },
  };
  assert(
    [
      "web_search",
      "read_web_page",
      "web_research",
      "deep_research",
      "open_url",
    ].every((toolName) =>
      convergenceSuppressedToolNames(boundedSynthesisState, {
        commandCwd: boundedSynthesisWorkspace,
        taskProfile: "writing",
      }).includes(toolName)
    ),
    "a source-complete local synthesis task retained unbounded external research tools"
  );
  const explicitResearchState = structuredClone(boundedSynthesisState);
  explicitResearchState.goal =
    "Research the latest evidence and cite primary sources in the report.";
  explicitResearchState.meta.goalContract.activeGoal =
    explicitResearchState.goal;
  assert(
    !convergenceSuppressedToolNames(explicitResearchState, {
      commandCwd: boundedSynthesisWorkspace,
      taskProfile: "writing",
    }).includes("web_search"),
    "an explicit external research task lost its web tools to the local-synthesis budget"
  );
  const mutatedSynthesisState = structuredClone(boundedSynthesisState);
  mutatedSynthesisState.meta.projectVerification.mutationRevision = 1;
  assert(
    !convergenceSuppressedToolNames(mutatedSynthesisState, {
      commandCwd: boundedSynthesisWorkspace,
      taskProfile: "writing",
    }).includes("web_search"),
    "a fresh source mutation did not reset the bounded local-synthesis web budget"
  );
  assert(
    convergenceSuppressedToolNames({
      meta: {
        toolLoop: {
          recent: [
            {
              toolName: "apply_patch",
              ok: false,
              blocked: false,
              category: "patch-search-not-found",
            },
          ],
        },
      },
    }).length === 0,
    "an ordinary recoverable tool failure was incorrectly suppressed"
  );
  const noVerifierRerunState = {
    meta: {
      goalContract: {
        currentRequest:
          "Do not rerun the verifier. Remove the generated build directory and finish.",
      },
      projectVerification: {
        requiredCommands: ["scripts/test.sh"],
        testRuns: [
          {
            command: "bash scripts/test.sh",
            passed: true,
          },
        ],
      },
    },
  };
  assert(
    forbiddenCurrentTestRerunBlock(
      noVerifierRerunState,
      "run_command",
      { command: "./scripts/test.sh" },
      { commandCwd: workspace }
    )?.category === "current-request-forbidden-test-rerun",
    "an explicit current-request ban did not block the known verifier"
  );
  assert(
    forbiddenCurrentTestRerunBlock(
      noVerifierRerunState,
      "run_command",
      { command: "rm -rf .build && git status --short" },
      { commandCwd: workspace }
    ) === null,
    "an explicit verifier-rerun ban incorrectly blocked cleanup or status work"
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
    repeatedNoProgressToolBlock(repeatedProbeState, "run_command", repeatedProbeArgs, {
      commandCwd: workspace,
      generatedArtifactProducerPending: true,
      generatedArtifactProducerCommand: repeatedProbeArgs.command,
    }) === null,
    "the exact authoritative generated-artifact producer remained blocked by stale no-progress history"
  );
  const currentProducerAttemptState = structuredClone(repeatedProbeState);
  currentProducerAttemptState.meta.goalContract = { revision: 3 };
  currentProducerAttemptState.meta.projectVerification = {
    mutationRevision: 5,
  };
  currentProducerAttemptState.meta.toolLoop.recent =
    currentProducerAttemptState.meta.toolLoop.recent.map((entry) => ({
      ...entry,
      generatedArtifactProducerAttempt: true,
      goalRevision: 3,
      mutationRevision: 5,
    }));
  assert(
    repeatedNoProgressToolBlock(
      currentProducerAttemptState,
      "run_command",
      repeatedProbeArgs,
      {
        commandCwd: workspace,
        generatedArtifactProducerPending: true,
        generatedArtifactProducerCommand: repeatedProbeArgs.command,
      }
    )?.category === "repeated-no-progress-call",
    "a current failed generated-artifact producer was allowed to loop"
  );
  assert(
    repeatedNoProgressToolBlock(repeatedProbeState, "run_command", repeatedProbeArgs, {
      commandCwd: workspace,
      generatedArtifactProducerPending: true,
      generatedArtifactProducerCommand: "python3 build_deck.py",
    })?.category === "repeated-no-progress-call",
    "a mismatched generated-artifact producer disabled the ordinary no-progress guard"
  );
  const repeatedFailureState = {
    meta: {
      toolLoop: {
        stagnationEpoch: 4,
        recent: repeatedProbeState.meta.toolLoop.recent.map((entry) => ({
          ...entry,
          ok: false,
          outcomeFingerprint: "same-failure",
        })),
      },
    },
  };
  assert(
    repeatedNoProgressToolBlock(repeatedFailureState, "run_command", repeatedProbeArgs, {
      commandCwd: workspace,
    })?.category === "repeated-no-progress-call",
    "a third identical failed shell command was not blocked"
  );
  const newlyAuthoritativeVerificationState = structuredClone(repeatedFailureState);
  newlyAuthoritativeVerificationState.meta.projectVerification = {
    mutationRevision: 6,
    privateMutationRevision: 0,
    testRuns: [],
  };
  assert(
    repeatedNoProgressToolBlock(
      newlyAuthoritativeVerificationState,
      "run_command",
      repeatedProbeArgs,
      {
        commandCwd: workspace,
        testVerificationPending: true,
        testVerificationCommand: repeatedProbeArgs.command,
      }
    ) === null,
    "a newly authoritative exact verifier remained blocked by stale generic-command history"
  );
  newlyAuthoritativeVerificationState.meta.projectVerification.testRuns.push({
    command: repeatedProbeArgs.command,
    mutationRevision: 6,
    privateMutationRevision: 0,
    passed: false,
  });
  assert(
    repeatedNoProgressToolBlock(
      newlyAuthoritativeVerificationState,
      "run_command",
      repeatedProbeArgs,
      {
        commandCwd: workspace,
        testVerificationPending: true,
        testVerificationCommand: repeatedProbeArgs.command,
      }
    )?.category === "repeated-no-progress-call",
    "a current recorded verifier result bypassed the ordinary no-progress guard"
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
  const failedValidationCommand =
    "python3 /tmp/supervision/acceptance/context_contract.py --root /tmp/workspace --phase final";
  const failedValidationState = {
    meta: {
      projectVerification: {
        mutationRevision: 6,
        testRuns: [
          {
            command: failedValidationCommand,
            mutationRevision: 6,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "same-failure",
          },
        ],
      },
    },
  };
  assert(
    unchangedFailedTestRerunBlock(
      failedValidationState,
      "run_command",
      { command: failedValidationCommand },
      { commandCwd: workspace }
    )?.category === "unchanged-failed-test-rerun",
    "an unchanged failed validator could rerun before a repair mutation"
  );
  const repositoryCleanGateFailure = {
    ...failedValidationState,
    meta: {
      projectVerification: {
        ...failedValidationState.meta.projectVerification,
        testRuns: [{
          ...failedValidationState.meta.projectVerification.testRuns[0],
          failureSignature: "repository-state-gate",
          failureSummary:
            "File contract.py, line 77 -> require(git_output(root, \"status\", \"--short\") == \"\", \"repository worktree is not clean\")",
        }],
      },
    },
  };
  assert(
    failedTestRequiresCleanRepositoryState(
      repositoryCleanGateFailure.meta.projectVerification.testRuns[0]
    ),
    "a standard empty git-status assertion was not classified as a repository-state gate"
  );
  assert(
    failedTestRequiresCleanRepositoryState({
      failureSummary:
        "Traceback context: require(not status.stdout.strip(), message) | AssertionError: project worktree is not clean",
    }),
    "a direct clean-worktree assertion was not classified when the traceback omitted the Git helper call"
  );
  assert(
    failedTestRequiresCleanRepositoryState({
      failureSummary: "acceptance failed: repository is not clean",
    }),
    "a concise authoritative acceptance failure did not activate repository-state repair"
  );
  assert(
    failedTestRequiresCleanRepositoryState({
      failureSummary:
        "FAIL: Git worktree is not clean: M .gitignore M README.md ?? .aginti/ ?? build_cad.py",
    }),
    "an explicit validator FAIL line did not activate repository-state repair"
  );
  assert(
    failedTestRequiresCleanRepositoryState({
      failureSummary: "Failing tests: Git worktree is not clean: M .gitignore.",
    }),
    "an aggregated failing-tests clean-worktree summary did not activate repository-state repair"
  );
  assert(
    !failedTestRequiresCleanRepositoryState({
      failureSummary: "The generated prose says the repository worktree is not clean.",
    }),
    "plain task prose was mistaken for a repository-state gate without Git-status evidence"
  );
  assertStrict.deepEqual(
    parseGitPorcelainStatus(
      " M build_deck.py\n D dist/deck.pdf\n?? output/deck.pptx\n?? output/slide 1.png\n"
    ),
    [
      { status: " M", path: "build_deck.py" },
      { status: " D", path: "dist/deck.pdf" },
      { status: "??", path: "output/deck.pptx" },
      { status: "??", path: "output/slide 1.png" },
    ],
    "bounded porcelain parsing lost a deletion, untracked output, or path containing spaces"
  );
  assertStrict.deepEqual(
    changedGitStatusPaths(
      {
        entries: [
          { status: " M", path: "unrelated.md", fingerprint: "same" },
          { status: " M", path: "build_deck.py", fingerprint: "before" },
        ],
      },
      {
        entries: [
          { status: " M", path: "unrelated.md", fingerprint: "same" },
          { status: " M", path: "build_deck.py", fingerprint: "after" },
          { status: " D", path: "dist/deck.pdf", fingerprint: "missing" },
          { status: "??", path: "output/deck.pptx", fingerprint: "file:1" },
        ],
      }
    ),
    ["build_deck.py", "dist/deck.pdf", "output/deck.pptx"],
    "command-bound Git capture included untouched pre-existing dirt or lost generated relocation paths"
  );
  assertStrict.deepEqual(
    changedGitStatusPaths(
      {
        entries: [
          { status: " M", path: "tests/AuthoritativeTest.java", fingerprint: "dirty" },
          { status: " M", path: "unrelated.md", fingerprint: "same" },
        ],
      },
      {
        entries: [
          { status: " M", path: "unrelated.md", fingerprint: "same" },
        ],
      }
    ),
    ["tests/AuthoritativeTest.java"],
    "restoring a dirty task-owned path to HEAD disappeared from command mutation evidence"
  );
  const producerMutationState = {
    goal: "Rebuild the generated presentation.",
    meta: {
      goalContract: { revision: 3, taskGoal: "Rebuild the generated presentation." },
      activeExecutionContract: { revision: 3 },
    },
  };
  recordProjectVerificationOutcome(
    producerMutationState,
    {
      toolName: "run_command",
      ok: true,
      exitCode: 0,
      args: { command: "python3 build_deck.py" },
      commandPolicy: {
        category: "toolchain",
        writesWorkspace: true,
        mayMutateProject: false,
      },
      projectMutationPaths: [
        "build_deck.py",
        "dist/deck.pdf",
        "output/deck.pptx",
      ],
      stdout: "wrote output/deck.pptx",
      stderr: "",
    },
    { commandCwd: workspace, taskProfile: "slides" }
  );
  assertStrict.deepEqual(
    producerMutationState.meta.projectVerification.mutationHistory.at(-1).paths,
    ["build_deck.py", "dist/deck.pdf", "output/deck.pptx"],
    "a producer command discarded the exact Git paths captured across its execution boundary"
  );
  const inspectedRepositoryState = structuredClone(repositoryCleanGateFailure);
  inspectedRepositoryState.meta.goalContract = { revision: 4 };
  const repositoryInspectionResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: repositoryStateInspectionCommand() },
    stdout: " D dist/deck.pdf\n?? output/deck.pptx\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(
    inspectedRepositoryState,
    repositoryInspectionResult,
    {
      commandCwd: workspace,
      taskProfile: "slides",
      testFailureRepositoryStateRepair: true,
      testFailureSignature: "repository-state-gate",
    }
  );
  const inspectedRepositoryRuntime = nextStepRuntimeConfig(
    { provider: "deepseek", taskProfile: "slides", commandCwd: workspace },
    inspectedRepositoryState
  );
  assertStrict.deepEqual(
    inspectedRepositoryRuntime.repositoryStateRepairObservedPaths,
    ["dist/deck.pdf", "output/deck.pptx"],
    "a bounded dirty-worktree inspection did not persist exact path candidates for the next turn"
  );
  assert(
    unchangedFailedTestRerunBlock(
      repositoryCleanGateFailure,
      "run_command",
      { command: failedValidationCommand },
      { commandCwd: workspace }
    ) === null,
    "a clean-worktree verification gate could not rerun after a Git-state repair"
  );
  const successfulRepositoryRepairState = structuredClone(repositoryCleanGateFailure);
  successfulRepositoryRepairState.goal = "Repair and verify the service lifecycle.";
  successfulRepositoryRepairState.meta.goalContract = { revision: 4 };
  successfulRepositoryRepairState.meta.activeExecutionContract = {
    revision: 4,
    materialMutationRevision: 6,
  };
  const successfulRepositoryCommit = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command:
        "git add -- 'gateway_service.py' && git commit -m 'Repair service lifecycle'",
    },
    stdout:
      "[main abcdef1] Repair service lifecycle\n 1 file changed, 1 insertion(+), 1 deletion(-)\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(
    successfulRepositoryRepairState,
    successfulRepositoryCommit,
    { commandCwd: workspace, taskProfile: "devops" }
  );
  const successfulRepositoryRepairMarker = recordAlreadyCommittedRepositoryRepair(
    successfulRepositoryRepairState,
    successfulRepositoryCommit
  );
  const postCommitRepositoryRuntime = nextStepRuntimeConfig(
    { provider: "deepseek", taskProfile: "devops", commandCwd: workspace },
    successfulRepositoryRepairState
  );
  assert(
    successfulRepositoryRepairMarker?.source === "successful-commit" &&
      postCommitRepositoryRuntime.testFailureRepositoryStateRepair !== true &&
      postCommitRepositoryRuntime.testVerificationPending === true &&
      postCommitRepositoryRuntime.testVerificationCommand === failedValidationCommand,
    "a successful bounded repair commit did not advance directly to the exact failed verifier"
  );
  const cleanStatusRepositoryRepairState = structuredClone(repositoryCleanGateFailure);
  cleanStatusRepositoryRepairState.goal = "Resume the committed service repair.";
  cleanStatusRepositoryRepairState.meta.goalContract = { revision: 5 };
  cleanStatusRepositoryRepairState.meta.activeExecutionContract = {
    revision: 5,
    startedMutationRevision: 6,
    materialMutationRevision: 6,
    requiresFileMutation: true,
    requiresSourceGrounding: true,
  };
  cleanStatusRepositoryRepairState.meta.durableGitEvidence = [{
    action: "commit",
    goalRevision: 5,
    mutationRevision: 5,
  }];
  const cleanStatusAfterCommit = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: "git status --short" },
    stdout: "",
    stderr: "",
  };
  recordProjectVerificationOutcome(
    cleanStatusRepositoryRepairState,
    cleanStatusAfterCommit,
    { commandCwd: workspace, taskProfile: "devops" }
  );
  const cleanStatusRepositoryRepairMarker = recordAlreadyCommittedRepositoryRepair(
    cleanStatusRepositoryRepairState,
    cleanStatusAfterCommit
  );
  const cleanStatusRepositoryRuntime = nextStepRuntimeConfig(
    { provider: "deepseek", taskProfile: "devops", commandCwd: workspace },
    cleanStatusRepositoryRepairState
  );
  assert(
    cleanStatusRepositoryRepairMarker?.source === "clean-status-after-commit" &&
      cleanStatusRepositoryRuntime.completionFreshMutationRequired !== true &&
      cleanStatusRepositoryRuntime.testVerificationPending === true &&
      cleanStatusRepositoryRuntime.testVerificationCommand === failedValidationCommand &&
      buildKnownConstrainedPhasePlan(
        { provider: "deepseek", taskProfile: "devops", commandCwd: workspace },
        cleanStatusRepositoryRepairState,
        cleanStatusRepositoryRuntime
      )?.mode === "exact-verification",
    "current commit plus an exact clean Git status did not recover an interrupted repository repair"
  );
  const repeatedDirtyRepositoryResult = {
    toolName: "run_command",
    ok: false,
    exitCode: 1,
    args: { command: failedValidationCommand },
    stdout: "",
    stderr:
      "AssertionError: repository worktree is not clean after a new unrelated mutation",
  };
  recordProjectVerificationOutcome(
    successfulRepositoryRepairState,
    repeatedDirtyRepositoryResult,
    {
      provider: "deepseek",
      taskProfile: "devops",
      commandCwd: workspace,
      testVerificationPending: true,
      testVerificationCommand: failedValidationCommand,
    }
  );
  const repeatedDirtyRepositoryRuntime = nextStepRuntimeConfig(
    { provider: "deepseek", taskProfile: "devops", commandCwd: workspace },
    successfulRepositoryRepairState
  );
  assert(
    repeatedDirtyRepositoryResult.repositoryStateRepairConsumed === true &&
      !successfulRepositoryRepairState.meta.repositoryStateRepair &&
      repeatedDirtyRepositoryRuntime.testFailureRepositoryStateRepair === true &&
      repeatedDirtyRepositoryRuntime.testVerificationPending !== true,
    "a consumed repository-repair marker caused an unchanged clean-worktree verifier loop"
  );
  const oversizedRepositoryState = {
    ...repositoryCleanGateFailure,
    goal: "Complete the current repository task and preserve its established acceptance contract.",
    messages: [
      {
        role: "system",
        content: "Use evidence and enabled tools only. ".repeat(500),
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        role: "user",
        content: `Historical context ${index}: ${"bounded but no longer operational. ".repeat(80)}`,
      })),
    ],
  };
  const repositoryRecoveryRequest = buildConstrainedRecoveryRequest(
    oversizedRepositoryState,
    { provider: "localllm", taskProfile: "qa", contextWindowTokens: 32768 },
    {},
    9
  );
  const repositoryRecoveryText = JSON.stringify(repositoryRecoveryRequest?.messages || []);
  assert(
    repositoryRecoveryRequest?.mode === "repository-state-repair",
    "repository-state recovery did not activate its generic narrow execution context"
  );
  assert(
    repositoryRecoveryRequest?.maxOutputTokens === 1536,
    "repository-state recovery did not reserve enough bounded output for its multi-action phase"
  );
  assert(
    repositoryRecoveryText.includes(failedValidationCommand),
    "repository-state recovery lost the exact retained verification command"
  );
  assert(
    /not a content defect/i.test(repositoryRecoveryText) &&
      !/apply one minimal patch to the canonical producer/i.test(repositoryRecoveryText),
    "repository-state recovery retained contradictory content-mutation guidance"
  );
  assert(
    repositoryRecoveryRequest.messageChars < JSON.stringify(oversizedRepositoryState.messages).length / 4,
    "repository-state recovery did not materially reduce irrelevant historical context"
  );
  const boundedCommitCommand = buildTaskOwnedCommitCommand(
    ["handoff.md", "notes/review's-summary.md"],
    "Polish verified handoff prose"
  );
  assert(
    boundedCommitCommand.includes("git add -- 'handoff.md'") &&
      boundedCommitCommand.includes("'notes/review'\"'\"'s-summary.md'") &&
      boundedCommitCommand.includes("git commit -m 'Polish verified handoff prose'") &&
      !boundedCommitCommand.includes("git add -A") &&
      !boundedCommitCommand.includes("git add -- ."),
    "the task-owned commit routine did not shell-quote its exact evidence-derived paths"
  );
  const artifactCommitRecoveryRequest = buildConstrainedRecoveryRequest(
    {
      goal: "Commit the accepted security repair.",
      messages: oversizedRepositoryState.messages,
      meta: {
        artifactProgress: { complete: true },
      },
    },
    { provider: "localllm", taskProfile: "security" },
    {},
    10,
    {
      provider: "localllm",
      taskProfile: "security",
      artifactValidationPhase: true,
      artifactValidationPendingGitActions: ["commit"],
      artifactValidationCommitPaths: ["SECURITY.md", "labshare.py", "tests/test_labshare.py"],
    }
  );
  const artifactCommitRecoveryText = JSON.stringify(
    artifactCommitRecoveryRequest?.messages || []
  );
  assert(
    artifactCommitRecoveryRequest?.mode === "artifact-git-completion" &&
      artifactCommitRecoveryRequest?.maxOutputTokens === 1536,
    "artifact Git completion did not activate its bounded recovery turn"
  );
  assert(
    /only the required local commit is missing/i.test(artifactCommitRecoveryText) &&
      /do not inspect unstaged diffs/i.test(artifactCommitRecoveryText),
    "artifact Git completion did not suppress redundant rediscovery and preview guessing"
  );
  const taskOwnedCommitRecoveryRequest = buildConstrainedRecoveryRequest(
    {
      goal: "Commit only the verified task-owned service repair.",
      messages: oversizedRepositoryState.messages,
      meta: {},
    },
    { provider: "localllm", taskProfile: "devops" },
    {},
    11,
    {
      provider: "localllm",
      taskProfile: "devops",
      taskOwnedCommitPending: true,
      taskOwnedPendingGitActions: ["commit"],
      taskOwnedCommitPaths: ["service_ctl.py", "tests/test_service_ctl.py"],
    }
  );
  const taskOwnedCommitRecoveryText = JSON.stringify(
    taskOwnedCommitRecoveryRequest?.messages || []
  );
  assert(
    taskOwnedCommitRecoveryRequest?.mode === "task-owned-git-completion" &&
      taskOwnedCommitRecoveryRequest?.maxOutputTokens === 1536,
    "verified non-artifact code work did not enter a bounded task-owned commit phase"
  );
  assert(
    /fresh passing verification/i.test(taskOwnedCommitRecoveryText) &&
      /do not reread, rewrite, or rerun completed work/i.test(taskOwnedCommitRecoveryText),
    "task-owned Git completion did not suppress post-test implementation drift"
  );
  assert(
    buildTaskOwnedCommitCommand(["../outside.md"], "Unsafe path") === "" &&
      buildTaskOwnedCommitCommand(["handoff.md"], "bad\nsubject") === "",
    "the task-owned commit routine accepted an escaped path or multiline subject"
  );
  const nonTextCommitCommand = buildTaskOwnedCommitCommand(
    ["assets/preview.png", "AGENTS.md", "Makefile"],
    "Commit verified project assets"
  );
  assert(
    nonTextCommitCommand.includes("'assets/preview.png'") &&
      nonTextCommitCommand.includes("'AGENTS.md'") &&
      nonTextCommitCommand.includes("'Makefile'"),
    "the task-owned commit routine reused the plain-text recovery evidence filter"
  );
  const windowsCommitCommand = buildTaskOwnedCommitCommand(
    ["src/runtime file.js", "assets/preview.png"],
    "Commit verified project assets",
    { platform: "win32" }
  );
  assert(
    windowsCommitCommand ===
      'git add -- "src/runtime file.js" "assets/preview.png" && git commit -m "Commit verified project assets"' &&
      buildTaskOwnedCommitCommand(["src/runtime.js"], "unsafe %PATH% subject", {
        platform: "win32",
      }) === "",
    "the task-owned commit routine did not use a conservative cmd.exe-safe command"
  );
  assert(
    buildTaskOwnedCommitCommand([".private/token.txt"], "Unsafe private path") === "" &&
      buildTaskOwnedCommitCommand(["secrets/key.txt"], "Unsafe secret path") === "",
    "the task-owned commit routine accepted a protected workspace path"
  );
  assert(
    buildTaskOwnedCommitCommand(
      ["main.tex", "main.pdf", "main.synctex.gz"],
      "Commit verified report"
    ) === "",
    "the task-owned commit routine accepted a generated LaTeX synchronization file"
  );
  const pendingVerificationState = {
    goal: "Finish the current task after fresh verification.",
    messages: oversizedRepositoryState.messages,
    meta: {
      projectVerification: {
        mutationRevision: 7,
        testRuns: [{
          command: failedValidationCommand,
          mutationRevision: 6,
          passed: true,
        }],
      },
    },
  };
  const pendingVerificationRequest = buildConstrainedRecoveryRequest(
    pendingVerificationState,
    { provider: "localllm", taskProfile: "qa", maxOutputTokens: 320 },
    {},
    10
  );
  const pendingVerificationText = JSON.stringify(pendingVerificationRequest?.messages || []);
  assert(
    pendingVerificationRequest?.mode === "exact-verification",
    "a post-mutation verification turn did not activate the generic narrow execution context"
  );
  assert(
    pendingVerificationRequest?.maxOutputTokens === 320,
    "a narrower explicit output limit was not preserved"
  );
  assert(
    pendingVerificationText.includes(failedValidationCommand) &&
      /run the exact retained verification command now/i.test(pendingVerificationText),
    "post-mutation verification lost its one remaining concrete action"
  );
  const verifiedCompletionState = {
    goal: "Finish the current task after fresh verification.",
    messages: oversizedRepositoryState.messages,
    meta: {
      goalContract: { revision: 11 },
      projectVerification: {
        mutationRevision: 8,
        testRuns: [{
          command: failedValidationCommand,
          mutationRevision: 7,
          passed: true,
        }],
      },
    },
  };
  const freshPassingVerification = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: { command: failedValidationCommand },
    stdout: "Acceptance contract passed.\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(verifiedCompletionState, freshPassingVerification, {
    commandCwd: workspace,
    taskProfile: "qa",
    testVerificationPending: true,
    testVerificationCommand: failedValidationCommand,
  });
  assert(
    verifiedCompletionState.meta.verifiedCompletionCandidate?.mutationRevision === 8 &&
      verifiedCompletionState.meta.verifiedCompletionCandidate?.goalRevision === 11,
    "a fresh bounded verifier pass did not record a revision-bound completion candidate"
  );
  const verifiedCompletionRuntime = nextStepRuntimeConfig(
    { provider: "localllm", taskProfile: "qa" },
    verifiedCompletionState
  );
  assert(
    verifiedCompletionRuntime.verifiedCompletionPending === true,
    "a current recovery verifier pass did not activate bounded completion"
  );
  const verifiedCompletionRequest = buildConstrainedRecoveryRequest(
    verifiedCompletionState,
    { provider: "localllm", taskProfile: "qa" },
    {},
    11,
    verifiedCompletionRuntime
  );
  const verifiedCompletionText = JSON.stringify(verifiedCompletionRequest?.messages || []);
  assert(
    verifiedCompletionRequest?.mode === "verified-completion" &&
      verifiedCompletionRequest?.maxOutputTokens === 2048,
    "fresh passing evidence did not narrow the final response turn"
  );
  assert(
    /call finish once/i.test(verifiedCompletionText) &&
      !/run the exact retained verification command now/i.test(verifiedCompletionText),
    "bounded completion asked the agent to repeat an already passing verifier"
  );
  const incompleteCommitCompletionState = structuredClone(verifiedCompletionState);
  incompleteCommitCompletionState.goal =
    "Fix the security issue, update SECURITY.md, run tests, commit the repair, and finish cleanly.";
  incompleteCommitCompletionState.meta.goalContract = {
    revision: 11,
    activeGoalRevision: 11,
    activeGoal: incompleteCommitCompletionState.goal,
    currentRequest: incompleteCommitCompletionState.goal,
    taskGoal: incompleteCommitCompletionState.goal,
  };
  assert(
    nextStepRuntimeConfig(
      { provider: "localllm", taskProfile: "security" },
      incompleteCommitCompletionState
    ).verifiedCompletionPending !== true,
    "one passing test forced finish-only mode while the task's required commit remained unsatisfied"
  );
  const postCommitWorkspace = path.join(tempRoot, "post-task-owned-commit");
  await fs.mkdir(postCommitWorkspace, { recursive: true });
  await fs.writeFile(path.join(postCommitWorkspace, "memo.md"), "# Verified memo\n");
  const postCommitGoal = "Create memo.md, verify the result, and commit the intentional work.";
  const postCommitState = {
    goal: postCommitGoal,
    commandCwd: postCommitWorkspace,
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          ok: true,
          toolName: "write_file",
          path: "memo.md",
          goalRevision: 1,
          projectMutationRevision: 1,
        }),
      },
    ],
    meta: {
      taskProfile: "writing",
      goalContract: {
        revision: 1,
        currentRequest: postCommitGoal,
        taskGoal: postCommitGoal,
        activeGoal: postCommitGoal,
        activeGoalRevision: 1,
      },
      durableEvidenceCategories: ["file", "command"],
      projectVerification: {
        mutationRevision: 1,
        privateMutationRevision: 0,
        mutationHistory: [{
          revision: 1,
          at: new Date().toISOString(),
          toolName: "write_file",
          paths: ["memo.md"],
          goalRevision: 1,
        }],
        commandRuns: [{
          command: "test -s memo.md",
          at: new Date().toISOString(),
          ok: true,
          mutationRevision: 1,
          privateMutationRevision: 0,
        }],
      },
    },
  };
  const boundedCommitResult = {
    toolName: "run_command",
    ok: true,
    exitCode: 0,
    args: {
      command: "git add -- 'memo.md' && git commit -m 'Commit verified memo'",
    },
    stdout: "[main abc1234] Commit verified memo\n 1 file changed, 1 insertion(+)\n",
    stderr: "",
  };
  recordProjectVerificationOutcome(postCommitState, boundedCommitResult, {
    goal: postCommitGoal,
    taskProfile: "writing",
    commandCwd: postCommitWorkspace,
    taskOwnedCommitPending: true,
    taskOwnedCommitPaths: ["memo.md"],
  });
  recordDurableEvidenceCategories(postCommitState, boundedCommitResult);
  const postCommitCompletionRuntime = nextStepRuntimeConfig(
    { goal: postCommitGoal, provider: "localllm", taskProfile: "writing", commandCwd: postCommitWorkspace },
    postCommitState
  );
  assert(
    postCommitCompletionRuntime.verifiedCompletionPending === true &&
      postCommitCompletionRuntime.taskOwnedCommitCompletionPending === true &&
      postCommitCompletionRuntime.taskOwnedCommitPending !== true,
    `a successful bounded task-owned commit did not converge directly to a finish-only turn: ${JSON.stringify({
      verifiedCompletionPending: postCommitCompletionRuntime.verifiedCompletionPending,
      taskOwnedCommitCompletionPending:
        postCommitCompletionRuntime.taskOwnedCommitCompletionPending,
      taskOwnedCommitPending: postCommitCompletionRuntime.taskOwnedCommitPending,
      marker: postCommitState.meta.projectVerification?.taskOwnedCompletionCommit,
    })}`
  );
  assert(
    buildConstrainedRecoveryRequest(
      postCommitState,
      { provider: "localllm", taskProfile: "writing", commandCwd: postCommitWorkspace },
      {},
      12,
      postCommitCompletionRuntime
    )?.mode === "verified-completion",
    "post-commit convergence reopened ordinary tool execution instead of final validation"
  );
  const staleCompletionState = structuredClone(verifiedCompletionState);
  staleCompletionState.meta.projectVerification.mutationRevision += 1;
  assert(
    nextStepRuntimeConfig(
      { provider: "localllm", taskProfile: "qa" },
      staleCompletionState
    ).verifiedCompletionPending !== true,
    "a later mutation revision reused stale completion evidence"
  );
  const repairCompletionState = structuredClone(verifiedCompletionState);
  repairCompletionState.meta.completionEvidenceRepair = { attempts: 1 };
  assert(
    nextStepRuntimeConfig(
      { provider: "localllm", taskProfile: "qa" },
      repairCompletionState
    ).verifiedCompletionPending === true,
    "an older repair record suppressed a newer exact verifier pass"
  );
  assert(
    buildConstrainedRecoveryRequest(
      { goal: "Inspect a project.", messages: [], meta: {} },
      { provider: "localllm", taskProfile: "code" },
      {},
      1
    ) === null,
    "ordinary agent work was incorrectly narrowed to a recovery-only context"
  );
  const acceptedArtifactState = {
    goal: "Fix the security issue, write SECURITY.md, run tests, and commit the repair.",
    commandCwd: workspace,
    messages: [],
    meta: {
      goalContract: {
        revision: 9,
        currentHash: "same-task-hash",
        currentRequest: "Continue the same task and finish the requested commit.",
        currentPreview: "Continue the same task and finish the requested commit.",
        taskGoal: "Fix the security issue, write SECURITY.md, run tests, and commit the repair.",
        activeGoal: "Fix the security issue, write SECURITY.md, run tests, and commit the repair.",
        activeGoalRevision: 3,
        taskRelation: "same-task",
        history: [{ revision: 9, hash: "same-task-hash", refreshExecutionContract: false }],
      },
      projectVerification: {
        mutationRevision: 8,
        testRuns: [{
          command: "python -m unittest discover -s tests -v",
          mutationRevision: 8,
          passed: true,
        }],
      },
      artifactProgress: {
        complete: true,
        contractKey: "security-artifact-contract",
        preflightFingerprint: "accepted",
        preflightGoalRevision: 8,
        preflightGoalHash: "same-task-hash",
        preflightContractKey: "security-artifact-contract",
        preflightMutationRevision: 8,
        preflight: {
          evidenceOk: true,
          semanticOk: true,
          defectCount: 0,
          missingEvidence: [],
          missingToolCalls: [],
          missingProjectCommands: [],
          missingGitActions: [],
        },
        needsRepair: false,
        needsCommand: false,
        needsSourceRead: false,
        defectCount: 0,
      },
    },
  };
  const acceptedArtifactRuntime = nextStepRuntimeConfig(
    { provider: "localllm", taskProfile: "security", commandCwd: workspace },
    acceptedArtifactState
  );
  assert(
    acceptedArtifactRuntime.verifiedCompletionPending === true &&
      acceptedArtifactRuntime.artifactValidationPendingGitActions.length === 0,
    "an identical same-task resume renewed an already satisfied commit or failed to enter finish-only mode"
  );
  const acceptedArtifactRecovery = buildConstrainedRecoveryRequest(
    acceptedArtifactState,
    { provider: "localllm", taskProfile: "security", commandCwd: workspace },
    {},
    12,
    acceptedArtifactRuntime
  );
  assert(
    acceptedArtifactRecovery?.mode === "verified-completion",
    "an accepted artifact resume did not narrow to the verified completion turn"
  );
  assert(
    unchangedFailedTestRerunBlock(
      {
        meta: {
          projectVerification: {
            mutationRevision: 6,
            testRuns: [
              {
                command: failedValidationCommand,
                mutationRevision: 6,
                passed: false,
                failureSignature: "legacy-evidence",
              },
            ],
          },
        },
      },
      "run_command",
      { command: failedValidationCommand },
      { commandCwd: workspace }
    ) === null,
    "a retained failure with an obsolete evidence schema could not refresh once"
  );
  assert(
    unchangedFailedTestRerunBlock(
      {
        meta: {
          projectVerification: {
            ...failedValidationState.meta.projectVerification,
            mutationRevision: 7,
          },
        },
      },
      "run_command",
      { command: failedValidationCommand },
      { commandCwd: workspace }
    ) === null,
    "a repair mutation did not reopen the exact failed validator"
  );
  assert(
    unchangedFailedTestRerunBlock(
      failedValidationState,
      "run_command",
      { command: "git diff --check" },
      { commandCwd: workspace }
    ) === null,
    "failed-test gating blocked a different diagnostic command"
  );
  assert(
    projectTestVerificationFinishBlock(failedValidationState)?.category === "project-test-current-failure",
    "a current unresolved substantive test failure did not block completion"
  );
  const verifiedExternalBlockerLedger = {
    blockerCount: 1,
    blockers: [
      {
        toolName: "browser",
        category: "login-required",
        reason: "Human login is required.",
      },
    ],
  };
  assert(
    completionExternalBlockerCanClose({
      candidateResult: "I cannot continue because login is required.",
      evidenceLedger: verifiedExternalBlockerLedger,
    }) === true,
    "a genuine evidenced external blocker could not close an otherwise valid run"
  );
  assert(
    completionExternalBlockerCanClose({
      candidateResult: "I cannot continue because login is required.",
      evidenceLedger: verifiedExternalBlockerLedger,
      projectTestBlock: projectTestVerificationFinishBlock(failedValidationState),
    }) === false,
    "an external-blocker narrative overrode a current failed project test"
  );
  const staleValidationState = {
    meta: {
      projectVerification: {
        ...failedValidationState.meta.projectVerification,
        mutationRevision: 7,
      },
    },
  };
  assert(
    projectTestVerificationFinishBlock(staleValidationState)?.category === "project-test-verification-stale",
    "a real mutation after a failed test did not require fresh passing evidence"
  );
  const repairedValidationState = {
    meta: {
      projectVerification: {
        mutationRevision: 7,
        testRuns: [
          ...failedValidationState.meta.projectVerification.testRuns,
          {
            command: failedValidationCommand,
            mutationRevision: 7,
            passed: true,
          },
        ],
      },
    },
  };
  assert(
    projectTestVerificationFinishBlock(repairedValidationState) === null,
    "a passing rerun at the current real mutation revision did not reopen completion"
  );
  const supersededDiscoveryFailureState = {
    meta: {
      projectVerification: {
        mutationRevision: 7,
        privateMutationRevision: 0,
        testRuns: [
          {
            command: "mvn test",
            mutationRevision: 1,
            privateMutationRevision: 0,
            passed: false,
            failureSignature: "missing-maven",
          },
          {
            command: "scripts/test.sh",
            mutationRevision: 7,
            privateMutationRevision: 0,
            passed: true,
          },
        ],
      },
    },
  };
  assert(
    projectTestVerificationFinishBlock(supersededDiscoveryFailureState) === null,
    "an obsolete failed discovery command blocked a canonical verifier that passed at the current revision"
  );
  const presentationWrappedValidationState = {
    meta: {
      projectVerification: {
        mutationRevision: 7,
        privateMutationRevision: 0,
        testRuns: [
          {
            command: "python3 -m unittest discover -s tests -v 2>&1",
            mutationRevision: 2,
            privateMutationRevision: 0,
            passed: false,
          },
          {
            command: "PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v",
            mutationRevision: 7,
            privateMutationRevision: 0,
            passed: true,
          },
        ],
      },
    },
  };
  assert(
    projectTestVerificationFinishBlock(presentationWrappedValidationState) === null,
    "presentation-only test wrappers left a superseded failure unresolved"
  );
  const tracebackEvidence = compactFailedTestEvidence(
    {
      stderr: [
        "Traceback (most recent call last):",
        `  File "${workspace}/acceptance_check.py", line 89, in main`,
        '    require("needle" in folded and folded.index("before") < folded.index("needle"), "order failed")',
        `  File "${workspace}/acceptance_check.py", line 17, in require`,
        "    raise AssertionError(message)",
        "AssertionError: order failed",
      ].join("\n"),
    },
    { commandCwd: workspace }
  );
  assert(
    tracebackEvidence.failureSummary.includes(
      'require("needle" in folded and folded.index("before") < folded.index("needle")'
    ),
    "failed-test compaction discarded the traceback source expression needed for diagnosis"
  );
  assert(
    tracebackEvidence.failureSummary.includes("AssertionError: order failed"),
    "failed-test compaction discarded the terminal assertion"
  );
  assert(
    tracebackEvidence.failureEvidenceVersion === 2,
    "failed-test compaction did not stamp the current evidence schema"
  );
  assert(
    JSON.stringify(failedTestLiteralOperands(tracebackEvidence.failureSummary)) ===
      JSON.stringify(["needle", "before", "order failed"]),
    "literal validator operands were not derived generically from traceback evidence"
  );
  assert(
    JSON.stringify(failedTestIndexComparisons(tracebackEvidence.failureSummary)) ===
      JSON.stringify([
        {
          variable: "folded",
          left: "before",
          operator: "<",
          right: "needle",
        },
      ]),
    "index-order predicates were not derived generically from traceback evidence"
  );
  const membershipFailureSummary =
    'Traceback context: File "/tmp/acceptance_check.py", line 9, in main -> require("{\\"id\\"" not in report and "transport.jsonl" not in folded, "raw transport copied")';
  assert(
    JSON.stringify(failedTestMembershipPredicates(membershipFailureSummary)) ===
      JSON.stringify([
        { variable: "report", literal: '{"id"', negated: true },
        { variable: "folded", literal: "transport.jsonl", negated: true },
      ]),
    "escaped membership predicates were not derived generically from traceback evidence"
  );
  assert(
    !tracebackEvidence.failureSummary.includes(workspace),
    "failed-test compaction leaked the absolute workspace path"
  );
  const completedContinuation = {
    preserveTaskBoundary: true,
    previousStatus: "completed",
  };
  assert(
    !isCompletedContinuationNoop(
      completedContinuation,
      "Continue the same task from the saved state.",
      failedValidationState
    ),
    "a legacy completed label bypassed retained failed-test evidence on resume"
  );
  assert(
    isCompletedContinuationNoop(
      completedContinuation,
      "Continue the same task from the saved state.",
      { meta: {} }
    ),
    "a genuinely completed task lost idempotent bare-resume behavior"
  );
  const missingRecoveryPacketState = {
    meta: {
      testFailureRepair: { key: "6:same-failure" },
      projectVerification: failedValidationState.meta.projectVerification,
    },
    messages: [],
  };
  const rebuiltRepair = enqueueFailedTestRepairInstruction(missingRecoveryPacketState, [
    { projectTest: failedValidationState.meta.projectVerification.testRuns[0] },
  ]);
  assert(
    rebuiltRepair?.rebuildRecoveryPacket === true,
    "a same-task refresh could not rebuild a missing failed-test evidence packet"
  );
  missingRecoveryPacketState.meta.failedTestRecoveryPacket = {
    packetVersion: 17,
    content: "Bounded failed-test evidence packet v17.",
    mutationRevision: 6,
    failureSignature: "same-failure",
  };
  assert(
    enqueueFailedTestRepairInstruction(missingRecoveryPacketState, [
      { projectTest: failedValidationState.meta.projectVerification.testRuns[0] },
    ]) === null,
    "an already-current failed-test evidence packet was redundantly rebuilt"
  );
  await fs.writeFile(
    path.join(workspace, "task-referenced-source.py"),
    "def sanitize(value):\n    return value\n",
    "utf8"
  );
  const taskReferencedPacketState = {
    goal: "Repair task-referenced-source.py and rerun the external security contract.",
    meta: {
      projectVerification: {
        mutationRevision: 0,
        discoveredTests: [],
        testRuns: [{
          command: "python external_security_contract.py",
          at: "2026-08-25T12:00:00.000Z",
          mutationRevision: 0,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "external-contract-no-traceback-source",
          failureSummary: "AssertionError: audit fields permit newline log injection",
        }],
      },
    },
  };
  const taskReferencedPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace, taskProfile: "security" },
    taskReferencedPacketState
  );
  assert(
    taskReferencedPacket.paths.includes("task-referenced-source.py") &&
      taskReferencedPacket.content.includes("def sanitize(value)"),
    "failed-test recovery ignored an explicitly named canonical workspace source when mutation history was empty"
  );
  await fs.writeFile(
    path.join(workspace, "ordered-report.md"),
    "The needle marker appears first.\nThe before marker appears later.\n",
    "utf8"
  );
  const literalPacketState = {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        discoveredTests: ["ordered-report.md"],
        lastMutation: { paths: ["ordered-report.md"] },
        testRuns: [
          {
            command: "python acceptance_check.py",
            mutationRevision: 0,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "literal-order",
            failureSummary: tracebackEvidence.failureSummary,
          },
        ],
      },
    },
  };
  const literalPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace },
    literalPacketState
  );
  assert(
    literalPacket.content.includes('"needle": exact first match line 1') &&
      literalPacket.content.includes('"before": exact first match line 2') &&
      /folded\.index\("before"\) < folded\.index\("needle"\) => \d+ < \d+ is false/.test(
        literalPacket.content
      ) &&
      literalPacket.content.includes("An edit after both first-match offsets cannot change it"),
    "failed-test recovery did not include bounded literal first-match evidence"
  );
  assert(
    literalPacketState.meta.failedTestDiagnostic?.focuses?.some(
      (focus) =>
        focus.path === "ordered-report.md" &&
        focus.left === "before" &&
        focus.operator === "<" &&
        focus.right === "needle" &&
        focus.decisiveLine === 1 &&
        focus.directSearch === "The needle marker appears first."
    ),
    "failed-test recovery did not persist a generic first-match repair focus"
  );
  const irrelevantFailedTestPatch = await failedTestRepairPatchBlock(
    literalPacketState,
    "apply_patch",
    {
      path: "ordered-report.md",
      search: "The before marker appears later.",
      replace: "The before marker remains later.",
    },
    { commandCwd: workspace }
  );
  assert(
    irrelevantFailedTestPatch?.category === "failed-test-irrelevant-patch",
    "a same-file patch after the decisive first occurrence was not blocked"
  );
  assert(
    irrelevantFailedTestPatch.diagnosticHint.includes(
      'folded.index("before") < folded.index("needle")'
    ) &&
      irrelevantFailedTestPatch.diagnosticHint.includes('first "needle" occurs at line 1') &&
      irrelevantFailedTestPatch.reason.includes("starts at line 2"),
    "an irrelevant patch block omitted the exact dynamically evaluated repair location"
  );
  assert(
    (await failedTestRepairPatchBlock(
      literalPacketState,
      "apply_patch",
      {
        path: "ordered-report.md",
        search: "The needle marker appears first.",
        replace: "The marker appears first.",
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-nonrepairing-patch",
    "a decisive patch that removed a required operand was not rejected transactionally"
  );
  assert(
    (await failedTestRepairPatchBlock(
      literalPacketState,
      "apply_patch",
      {
        path: "ordered-report.md",
        search: "The needle marker appears first.",
        replace: "The needle marker appears first. The before marker was appended later.",
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-nonrepairing-patch",
    "a decisive patch that retained the failing first occurrence was not rejected transactionally"
  );
  assert(
    (await failedTestRepairPatchBlock(
      literalPacketState,
      "apply_patch",
      {
        path: "ordered-report.md",
        search: "The needle marker appears first.",
        replace: "The before marker now appears before the needle marker.",
      },
      { commandCwd: workspace }
    )) === null,
    "a decisive patch that makes the retained relation true was incorrectly blocked"
  );
  assert(
    (await failedTestRepairPatchBlock(
      literalPacketState,
      "apply_patch",
      {
        path: "ordered-report.md",
        search: "The needle marker appears first.",
        replace:
          "The before marker now appears before the needle marker. The retained validator requires this wording.",
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-control-plane-leak",
    "internal repair guidance was allowed to leak into a tested artifact"
  );
  await fs.writeFile(path.join(workspace, "producer.js"), "export const value = 1;\n", "utf8");
  assert(
    (await failedTestRepairPatchBlock(
      literalPacketState,
      "apply_patch",
      {
        path: "producer.js",
        search: "value = 1",
        replace: "value = 2",
      },
      { commandCwd: workspace }
    )) === null,
    "a patch to a separate canonical producer was incorrectly blocked"
  );
  const pythonMockContractSource = [
    "def test_stale_pid_routes_through_patchable_seams(self):",
    "    with mock.patch.object(service_behavior, \"launch_service\") as launch:",
    "        launch.return_value = mock.Mock(pid=32123)",
    "        with mock.patch.object(service_behavior, \"wait_until_healthy\", return_value=True):",
    "            result = service_behavior.start_service(state_dir, \"127.0.0.1\", 8765)",
    "    self.assertEqual(result, 0)",
    "    self.assertTrue(launch.called)",
    "",
  ].join("\n");
  const pythonMockContract = failedTestMockBehaviorContract(pythonMockContractSource);
  assert(
    pythonMockContract.seams.some(
      (item) =>
        item.owner === "service_behavior" &&
        item.symbol === "launch_service" &&
        item.callExpectation === "called" &&
        item.returnAttributes.includes("pid=32123")
    ) &&
      pythonMockContract.seams.some(
        (item) =>
          item.owner === "service_behavior" &&
          item.symbol === "wait_until_healthy" &&
          item.returnValue === "True"
      ) &&
      pythonMockContract.invocations.some(
        (item) =>
          item.owner === "service_behavior" &&
          item.symbol === "start_service" &&
          item.assignedTo === "result"
      ) &&
      pythonMockContract.resultAssertions.some(
        (item) => item.variable === "result" && item.expected === "0"
      ),
    "the generic Python mock contract did not retain patched returns, observed calls, entrypoint, and result assertion"
  );
  await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "tests", "test_service_behavior.py"),
    pythonMockContractSource,
    "utf8"
  );
  await fs.writeFile(
    path.join(workspace, "service_behavior.py"),
    "def start_service(state_dir, host, port):\n    return 2\n",
    "utf8"
  );
  const mockBehaviorPacketState = {
    meta: {
      projectVerification: {
        mutationRevision: 1,
        discoveredTests: ["tests/test_service_behavior.py"],
        lastMutation: { paths: ["service_behavior.py"] },
        testRuns: [{
          command: "python3 -m unittest discover -s tests -v",
          mutationRevision: 1,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "mock-behavior-contract",
          failureSummary: [
            'with mock.patch.object(service_behavior, "launch_service") as launch:',
            'with mock.patch.object(service_behavior, "wait_until_healthy", return_value=True):',
            "AssertionError: 2 != 0",
          ].join(" "),
        }],
      },
    },
  };
  const mockBehaviorPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace },
    mockBehaviorPacketState
  );
  assert(
    mockBehaviorPacket.content.includes(
      "Acceptance behavior distilled from the exact current test source"
    ) &&
      mockBehaviorPacket.content.includes(
        "Tested production call(s): service_behavior.start_service -> result"
      ) &&
      mockBehaviorPacket.content.includes(
        "Patchable seam service_behavior.launch_service: explicitly asserted called; test-double attributes pid=32123"
      ) &&
      mockBehaviorPacket.content.includes(
        "Patchable seam service_behavior.wait_until_healthy: test-double return True"
      ) &&
      mockBehaviorPacket.content.includes(
        "Result contract: service_behavior.start_service returns 0"
      ),
    "the bounded failed-test packet did not front-load generic mock interaction behavior"
  );
  const seamSource = [
    "def start_service():",
    "    return 0",
    "",
  ].join("\n");
  await fs.writeFile(path.join(workspace, "service_topology.py"), seamSource, "utf8");
  const seamFailureSummary = [
    "Failing test: test_start_routes_through_mockable_seams.",
    'with mock.patch.object(service_topology, "launch_service") as launch:',
    'with mock.patch.object(service_topology, "wait_until_healthy", return_value=True):',
    "AttributeError: module service_topology has no attribute launch_service",
  ].join(" ");
  const seamRepairState = {
    meta: {
      projectVerification: {
        mutationRevision: 2,
        testRuns: [
          {
            command: "python3 -m unittest discover -s tests -v",
            mutationRevision: 2,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "required-seam-topology",
            failureSummary: seamFailureSummary,
          },
        ],
      },
      failedTestRecoveryPacket: {
        paths: ["tests/test_service_topology.py", "service_topology.py"],
        content: seamFailureSummary,
      },
    },
  };
  const definitionOnlySource = [
    "def launch_service():",
    "    return object()",
    "",
    "def start_service():",
    "    return 0",
    "",
  ].join("\n");
  assert(
    (
      await failedTestRepairPatchBlock(
        seamRepairState,
        "apply_patch",
        {
          path: "service_topology.py",
          search: seamSource,
          replace: definitionOnlySource,
          expectedReplacements: 1,
        },
        { commandCwd: workspace }
      )
    )?.category === "failed-test-required-symbol-topology",
    "a definition-only acceptance seam repair was allowed without a production call site"
  );
  const duplicateDefinitionSource = [
    "def launch_service():",
    "    return object()",
    "",
    "def launch_service():",
    "    return object()",
    "",
    "def start_service():",
    "    return launch_service()",
    "",
  ].join("\n");
  assert(
    (
      await failedTestRepairPatchBlock(
        seamRepairState,
        "apply_patch",
        {
          path: "service_topology.py",
          search: seamSource,
          replace: duplicateDefinitionSource,
          expectedReplacements: 1,
        },
        { commandCwd: workspace }
      )
    )?.category === "failed-test-required-symbol-topology",
    "duplicate acceptance seam definitions were allowed"
  );
  const recursiveDefinitionSource = [
    "def launch_service():",
    "    return launch_service()",
    "",
    "def start_service():",
    "    return 0",
    "",
  ].join("\n");
  assert(
    (
      await failedTestRepairPatchBlock(
        seamRepairState,
        "apply_patch",
        {
          path: "service_topology.py",
          search: seamSource,
          replace: recursiveDefinitionSource,
          expectedReplacements: 1,
        },
        { commandCwd: workspace }
      )
    )?.category === "failed-test-required-symbol-topology",
    "a recursive seam wrapper was mistaken for production routing"
  );
  const routedSeamSource = [
    "def launch_service():",
    "    return object()",
    "",
    "def start_service():",
    "    return launch_service()",
    "",
  ].join("\n");
  assert(
    (await failedTestRepairPatchBlock(
      seamRepairState,
      "apply_patch",
      {
        path: "service_topology.py",
        search: seamSource,
        replace: routedSeamSource,
        expectedReplacements: 1,
      },
      { commandCwd: workspace }
    )) === null,
    "a single seam definition routed through production was incorrectly blocked"
  );
  assert(
    (
      await failedTestRepairPatchBlock(
        seamRepairState,
        "apply_patch",
        {
          patch: [
            "*** Begin Patch",
            "*** Update File: tests/test_service_topology.py",
            "@@",
            '-with mock.patch.object(service_topology, "launch_service"):',
            "+with mock.patch.object(service_topology, 'other_service'):",
            "*** End Patch",
          ].join("\n"),
        },
        { commandCwd: workspace }
      )
    )?.category === "failed-test-required-symbol-path",
    "a unified test-edit patch bypassed the canonical required-seam source path"
  );
  assert(
    (await failedTestRepairPatchBlock(
      seamRepairState,
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: service_topology.py",
          "@@",
          "-def start_service():",
          "-    return 0",
          "+def launch_service():",
          "+    return object()",
          "+",
          "+def start_service():",
          "+    return launch_service()",
          "*** End Patch",
        ].join("\n"),
      },
      { commandCwd: workspace }
    )) === null,
    "a coherent unified source patch with one declaration and production call was blocked"
  );
  await fs.writeFile(
    path.join(workspace, "membership-report.md"),
    "Source transport.jsonl was copied here.\nSafe summary follows.\nA second transport.jsonl reference remains.\n",
    "utf8"
  );
  const membershipPacketState = {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        discoveredTests: ["membership-report.md"],
        lastMutation: { paths: ["membership-report.md"] },
        testRuns: [
          {
            command: "python acceptance_check.py",
            mutationRevision: 0,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "membership-exclusion",
            failureSummary: membershipFailureSummary,
          },
        ],
      },
    },
  };
  const membershipPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace },
    membershipPacketState
  );
  assert(
    membershipPacket.content.includes(
      '"transport.jsonl" not in folded => found at offset'
    ) &&
      membershipPacketState.meta.failedTestDiagnostic?.focuses?.some(
        (focus) =>
          focus.kind === "membership" &&
          focus.path === "membership-report.md" &&
          focus.literal === "transport.jsonl" &&
          focus.negated === true &&
          focus.caseFolded === true &&
          focus.decisiveLine === 1 &&
          focus.directSearch === "Source transport.jsonl was copied here."
      ),
    "failed-test recovery did not persist a generic membership repair focus"
  );
  assert(
    (await failedTestRepairPatchBlock(
      membershipPacketState,
      "apply_patch",
      {
        path: "membership-report.md",
        search: "Safe summary follows.",
        replace: "A safe summary follows.",
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-irrelevant-patch",
    "a patch after a forbidden membership occurrence was not blocked"
  );
  assert(
    (await failedTestRepairPatchBlock(
      membershipPacketState,
      "apply_patch",
      {
        path: "membership-report.md",
        search: "Source transport.jsonl was copied here.",
        replace: "Source transport.jsonl remains here.",
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-nonrepairing-patch",
    "a decisive patch retaining a forbidden membership literal was not blocked"
  );
  assert(
    (await failedTestRepairPatchBlock(
      membershipPacketState,
      "apply_patch",
      {
        path: "membership-report.md",
        search: "Source transport.jsonl was copied here.",
        replace: "Source material was summarized without copying transport records.",
      },
      { commandCwd: workspace }
    )) === null,
    "a decisive patch making monotonic progress on a membership exclusion was incorrectly blocked"
  );
  const requiredMembershipFailureSummary =
    'Traceback context: File "/tmp/acceptance_check.py", line 10, in main -> require("alpha" in folded and "beta marker" in folded, "required marker missing")';
  await fs.writeFile(
    path.join(workspace, "required-membership-report.md"),
    "The alpha marker is present.\n",
    "utf8"
  );
  const requiredMembershipState = {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        discoveredTests: ["required-membership-report.md"],
        lastMutation: { paths: ["required-membership-report.md"] },
        testRuns: [
          {
            command: "python acceptance_check.py",
            mutationRevision: 0,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "membership-inclusion",
            failureSummary: requiredMembershipFailureSummary,
          },
        ],
      },
    },
  };
  await buildFailedTestRecoveryPacket({ commandCwd: workspace }, requiredMembershipState);
  assert(
    requiredMembershipState.meta.failedTestDiagnostic?.focuses?.some(
      (focus) =>
        focus.kind === "membership" &&
        focus.literal === "beta marker" &&
        focus.negated === false &&
        focus.anchorLiteral === "alpha" &&
        focus.directSearch === "The alpha marker is present."
    ),
    "a missing membership literal did not inherit a present same-expression repair anchor"
  );
  assert(
    (await failedTestRepairPatchBlock(
      requiredMembershipState,
      "apply_patch",
      {
        path: "required-membership-report.md",
        search: "The alpha marker is present.",
        replace: "The alpha marker is still present.",
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-nonrepairing-patch",
    "an anchored patch that left a required membership literal absent was not blocked"
  );
  assert(
    (await failedTestRepairPatchBlock(
      requiredMembershipState,
      "apply_patch",
      {
        path: "required-membership-report.md",
        search: "The alpha marker is present.",
        replace: "The alpha and beta marker are present.",
      },
      { commandCwd: workspace }
    )) === null,
    "an anchored patch that supplied a required membership literal was incorrectly blocked"
  );
  await fs.writeFile(
    path.join(workspace, "control-leak-report.md"),
    "Result: the exact search is an evidence-derived anchor containing the related assertion operand.\n",
    "utf8"
  );
  const controlLeakState = {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        discoveredTests: ["control-leak-report.md"],
        lastMutation: { paths: ["control-leak-report.md"] },
        testRuns: [
          {
            command: "python acceptance_check.py",
            mutationRevision: 0,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "formatting-failure",
            failureSummary: "Failure evidence: AssertionError: report formatting failed",
          },
        ],
      },
    },
  };
  const controlLeakPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace },
    controlLeakState
  );
  assert(
    controlLeakPacket.content.includes("Internal repair guidance detected") &&
      controlLeakState.meta.failedTestDiagnostic?.focuses?.some(
        (focus) =>
          focus.kind === "control-plane-leak" &&
          focus.path === "control-leak-report.md" &&
          focus.decisiveLine === 1
      ),
    "existing control-plane prose was not retained as repair evidence"
  );
  assert(
    (await failedTestRepairPatchBlock(
      controlLeakState,
      "apply_patch",
      {
        path: "control-leak-report.md",
        search:
          "Result: the exact search is an evidence-derived anchor containing the related assertion operand.",
        replace: "Result: the report contains the verified measurement summary.",
      },
      { commandCwd: workspace }
    )) === null,
    "a patch removing existing control-plane leakage was incorrectly blocked"
  );
  const multiFocusProgressState = structuredClone(controlLeakState);
  multiFocusProgressState.meta.failedTestDiagnostic.focuses.push({
    kind: "membership",
    path: "control-leak-report.md",
    variable: "report",
    literal: "required calibration marker",
    negated: false,
    caseFolded: true,
    decisiveLine: 1,
    directSearch:
      "Result: the exact search is an evidence-derived anchor containing the related assertion operand.",
  });
  assert(
    (await failedTestRepairPatchBlock(
      multiFocusProgressState,
      "apply_patch",
      {
        path: "control-leak-report.md",
        search:
          "Result: the exact search is an evidence-derived anchor containing the related assertion operand.",
        replace: "Result: the report contains a concise measurement summary.",
      },
      { commandCwd: workspace }
    )) === null,
    "a transaction improving one retained focus while preserving another was incorrectly blocked"
  );
  const multiFocusRegressionState = structuredClone(controlLeakState);
  multiFocusRegressionState.meta.failedTestDiagnostic.focuses.push({
    kind: "membership",
    path: "control-leak-report.md",
    variable: "report",
    literal: "Result:",
    negated: false,
    caseFolded: false,
    decisiveLine: 1,
    directSearch:
      "Result: the exact search is an evidence-derived anchor containing the related assertion operand.",
  });
  assert(
    (await failedTestRepairPatchBlock(
      multiFocusRegressionState,
      "apply_patch",
      {
        path: "control-leak-report.md",
        search:
          "Result: the exact search is an evidence-derived anchor containing the related assertion operand.",
        replace: "The report contains a concise measurement summary.",
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-regression",
    "a transaction that repaired one focus by regressing another was not rejected"
  );
  const validatorPath = path.join(tempRoot, "acceptance_check.py");
  await fs.writeFile(
    validatorPath,
    [
      "def require(value, message):",
      "    if not value:",
      "        raise AssertionError(message)",
      "",
      "def validate(report):",
      "    folded = report.casefold()",
      '    first_index = folded.find("first marker")',
      '    second_index = folded.find("second marker")',
      '    require(first_index < second_index, "marker order failed")',
      "",
    ].join("\n"),
    "utf8"
  );
  const sourceEvidenceState = {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        discoveredTests: ["required-membership-report.md"],
        lastMutation: { paths: ["required-membership-report.md"] },
        testRuns: [
          {
            command: `python3 ${validatorPath}`,
            mutationRevision: 0,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "derived-order",
            failureSummary:
              `Traceback context: File "${validatorPath}", line 9, in validate -> ` +
              'require(first_index < second_index, "marker order failed")',
          },
        ],
      },
    },
  };
  const sourceEvidencePacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace },
    sourceEvidenceState
  );
  assert(
    sourceEvidencePacket.content.includes("Exact validator source around acceptance_check.py:9") &&
      sourceEvidencePacket.content.includes('first_index = folded.find("first marker")') &&
      sourceEvidencePacket.content.includes('second_index = folded.find("second marker")'),
    "a command-bound traceback source excerpt was not retained for derived-value diagnosis"
  );
  const aliasedValidatorPath = path.join(tempRoot, "aliased_acceptance_check.py");
  const aliasedValidatorSource = [
    "def require(value, message):",
    "    if not value:",
    "        raise AssertionError(message)",
    "",
    "def validate(report):",
    "    folded = report.casefold()",
    '    preflight_index = min(index for index in (folded.find("preflight"), folded.find("fit check")) if index >= 0)',
    '    baseline_index = min(index for index in (folded.find("baseline marker"), folded.find("measurement")) if index >= 0)',
    '    require(preflight_index < baseline_index, "preflight must precede baseline")',
    "",
  ].join("\n");
  await fs.writeFile(aliasedValidatorPath, aliasedValidatorSource, "utf8");
  const aliasedComparisons = failedTestAliasedIndexComparisons(
    aliasedValidatorSource,
    'Traceback context: require(preflight_index < baseline_index, "preflight must precede baseline")'
  );
  assert(
    aliasedComparisons.length === 1 &&
      aliasedComparisons[0].operator === "<" &&
      aliasedComparisons[0].leftAggregation === "min" &&
      aliasedComparisons[0].rightAggregation === "min" &&
      aliasedComparisons[0].leftAlternatives.join("|") === "preflight|fit check" &&
      aliasedComparisons[0].rightAlternatives.join("|") === "baseline marker|measurement",
    "aliased first-match groups were not derived generically from validator source"
  );
  await fs.writeFile(
    path.join(workspace, "aliased-order-report.md"),
    "The baseline marker appears first.\nThe fit check appears later.\nThe baseline marker appears first.\n",
    "utf8"
  );
  const aliasedOrderState = {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        discoveredTests: ["aliased-order-report.md"],
        lastMutation: { paths: ["aliased-order-report.md"] },
        testRuns: [
          {
            command: `python3 ${aliasedValidatorPath}`,
            mutationRevision: 0,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "aliased-derived-order",
            failureSummary:
              `Traceback context: File "${aliasedValidatorPath}", line 9, in validate -> ` +
              'require(preflight_index < baseline_index, "preflight must precede baseline")',
          },
        ],
      },
    },
  };
  const aliasedOrderPacket = await buildFailedTestRecoveryPacket(
    { commandCwd: workspace },
    aliasedOrderState
  );
  const aliasedOrderFocus = aliasedOrderState.meta.failedTestDiagnostic?.focuses?.find(
    (focus) => focus.path === "aliased-order-report.md" && focus.kind === "index-comparison"
  );
  assert(
    aliasedOrderPacket.content.includes('min first-match ["preflight","fit check"]') &&
      aliasedOrderFocus?.decisiveLine === 1 &&
      aliasedOrderFocus?.directSearch ===
        "The baseline marker appears first.\nThe fit check appears later." &&
      aliasedOrderFocus?.leftAlternatives?.join("|") === "preflight|fit check" &&
      aliasedOrderFocus?.rightAlternatives?.join("|") === "baseline marker|measurement",
    "the failed-test packet did not retain the decisive aliased first-match relation"
  );
  assert(
    (await failedTestRepairPatchBlock(
      aliasedOrderState,
      "apply_patch",
      {
        path: "aliased-order-report.md",
        search: "The fit check appears later.",
        replace: "The preflight appears later.",
      },
      { commandCwd: workspace }
    ))?.category === "failed-test-irrelevant-patch",
    "a patch after the decisive aliased first match was not rejected"
  );
  assert(
    (await failedTestRepairPatchBlock(
      aliasedOrderState,
      "apply_patch",
      {
        path: "aliased-order-report.md",
        search: "The baseline marker appears first.\nThe fit check appears later.",
        replace:
          "The preflight appears before the baseline marker.\nThe fit check appears later.",
      },
      { commandCwd: workspace }
    )) === null,
    "a patch satisfying an aliased first-match relation was incorrectly blocked"
  );
  await fs.writeFile(
    path.join(workspace, "partial-order-report.md"),
    "Repeated blocker.\nUnique context.\nRepeated blocker.\nDesired marker.\n",
    "utf8"
  );
  const partialOrderState = {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        testRuns: [
          {
            command: "python partial_order_check.py",
            mutationRevision: 0,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "partial-derived-order",
          },
        ],
      },
      failedTestDiagnostic: {
        packetVersion: 17,
        mutationRevision: 0,
        failureSignature: "partial-derived-order",
        focuses: [
          {
            kind: "index-comparison",
            path: "partial-order-report.md",
            variable: "folded",
            left: "desired marker",
            operator: "<",
            right: "repeated blocker",
            leftAlternatives: ["desired marker"],
            rightAlternatives: ["repeated blocker"],
            leftAggregation: "min",
            rightAggregation: "min",
            caseFolded: true,
            decisiveLine: 1,
            directSearch: "Repeated blocker.\nUnique context.",
          },
        ],
      },
    },
  };
  assert(
    (await failedTestRepairPatchBlock(
      partialOrderState,
      "apply_patch",
      {
        path: "partial-order-report.md",
        search: "Repeated blocker.\nUnique context.",
        replace: "Unique context.",
      },
      { commandCwd: workspace }
    )) === null,
    "a duplicate removal that reduced a retained ordering violation was incorrectly blocked"
  );
  const inversePatchState = {
    meta: {
      projectVerification: {
        mutationRevision: 5,
        mutationHistory: [
          {
            revision: 5,
            toolName: "apply_patch",
            paths: ["report.md"],
            patch: {
              path: "report.md",
              searchHash: "old-content-hash",
              replaceHash: "new-content-hash",
            },
          },
        ],
        testRuns: [
          {
            mutationRevision: 4,
            passed: false,
            failureSignature: "earlier-failure",
          },
          {
            mutationRevision: 5,
            passed: false,
            failureSignature: "later-failure",
          },
        ],
      },
    },
  };
  assert(
    regressiveInversePatchBlock(
      inversePatchState,
      "apply_patch",
      {
        path: "report.md",
        search: "new content",
        replace: "old content",
        searchHash: "new-content-hash",
        replaceHash: "old-content-hash",
      },
      { commandCwd: workspace }
    )?.category === "failed-test-regressive-inverse-patch",
    "an exact inverse that restored a known earlier failure was not blocked"
  );
  const sameFailureInverseState = {
    meta: {
      projectVerification: {
        mutationRevision: 7,
        mutationHistory: [
          {
            revision: 6,
            toolName: "apply_patch",
            paths: ["manifest.py"],
            patch: {
              path: "manifest.py",
              searchHash: "canonical-validation-hash",
              replaceHash: "validation-alias-hash",
            },
          },
        ],
        testRuns: [
          {
            mutationRevision: 5,
            passed: false,
            failureSignature: "validation-shape-failure",
          },
          {
            mutationRevision: 7,
            passed: false,
            failureSignature: "validation-shape-failure",
          },
        ],
      },
    },
  };
  const sameFailureInverseBlock = regressiveInversePatchBlock(
    sameFailureInverseState,
    "apply_patch",
    {
      path: "manifest.py",
      search: "validation alias",
      replace: "canonical validation",
      searchHash: "validation-alias-hash",
      replaceHash: "canonical-validation-hash",
    },
    { commandCwd: workspace }
  );
  assert(
    sameFailureInverseBlock?.category === "failed-test-regressive-inverse-patch" &&
      /same assertion/i.test(sameFailureInverseBlock.reason || ""),
    "an exact inverse was allowed to oscillate between two states rejected by the same assertion"
  );
  const cadManifestFailureState = {
    meta: {
      projectVerification: {
        mutationRevision: 9,
        testRuns: [
          {
            mutationRevision: 9,
            passed: false,
            failureSignature: "cad-manifest-evidence",
            failureSummary:
              "Failing tests: manifest lacks STEP/STL/3MF validation evidence.",
            failingTests: [
              "manifest lacks STEP/STL/3MF validation evidence",
            ],
          },
        ],
      },
    },
  };
  const redundantCadAliasBlock = redundantCadValidationAliasPatchBlock(
    cadManifestFailureState,
    "apply_patch",
    {
      path: "build_cad.py",
      search: [
        '        "validation": validation,',
        '        "artifacts": artifacts,',
      ].join("\n"),
      replace: [
        '        "validation": validation,',
        '        "validation_evidence": validation,',
        '        "artifacts": artifacts,',
      ].join("\n"),
    },
    { taskProfile: "cad" }
  );
  assert(
    redundantCadAliasBlock?.category === "cad-validation-schema-alias" &&
      /solid_count[\s\S]*bbox_mm/i.test(
        redundantCadAliasBlock.diagnosticHint || ""
      ),
    "a CAD manifest repair was allowed to duplicate the canonical validation schema"
  );
  const runtimeCadAliasBlock = redundantCadValidationAliasPatchBlock(
    {
      meta: {
        projectVerification: {
          ...cadManifestFailureState.meta.projectVerification,
          taskProfile: "cad",
        },
      },
    },
    "apply_patch",
    {
      path: "build_cad.py",
      search: [
        "    json_payload = {",
        `        "description": "${"x".repeat(300)}",`,
        '        "validation": validation,',
        "    }",
      ].join("\n"),
      replace: [
        "    json_payload = {",
        `        "description": "${"x".repeat(300)}",`,
        '        "validation": validation,',
        '        "validation_evidence": validation,',
        "    }",
      ].join("\n"),
    },
    {}
  );
  assert(
    runtimeCadAliasBlock?.category === "cad-validation-schema-alias",
    "the CAD alias guard relied on a logging-safe/truncated patch or explicit config profile"
  );
  const canonicalValidationText = [
    "    json_payload = {",
    '        "validation": validation,',
    "    }",
  ].join("\n");
  const aliasedValidationText = [
    "    json_payload = {",
    '        "validation": validation,',
    '        "validation_evidence": validation,',
    "    }",
  ].join("\n");
  const cadAliasCleanupState = {
    meta: {
      projectVerification: {
        taskProfile: "cad",
        mutationRevision: 11,
        mutationHistory: [
          {
            revision: 10,
            toolName: "apply_patch",
            patch: {
              path: "build_cad.py",
              searchHash: "canonical-hash",
              replaceHash: "aliased-hash",
            },
          },
        ],
        testRuns: [
          {
            mutationRevision: 9,
            passed: false,
            failureSignature: "cad-manifest-evidence",
            failureSummary:
              "Failing tests: manifest lacks STEP/STL/3MF validation evidence.",
            failingTests: [
              "manifest lacks STEP/STL/3MF validation evidence",
            ],
          },
          {
            mutationRevision: 11,
            passed: false,
            failureSignature: "cad-manifest-evidence",
            failureSummary:
              "Failing tests: manifest lacks STEP/STL/3MF validation evidence.",
            failingTests: [
              "manifest lacks STEP/STL/3MF validation evidence",
            ],
          },
        ],
      },
    },
  };
  assertStrict.equal(
    regressiveInversePatchBlock(
      cadAliasCleanupState,
      "apply_patch",
      {
        path: "build_cad.py",
        search: aliasedValidationText,
        replace: canonicalValidationText,
        searchHash: "aliased-hash",
        replaceHash: "canonical-hash",
      },
      {}
    ),
    null,
    "the inverse-patch guard blocked removal of a forbidden CAD validation alias"
  );
  assertStrict.equal(
    redundantCadValidationAliasPatchBlock(
      cadManifestFailureState,
      "apply_patch",
      {
        path: "build_cad.py",
        search: [
          '        "validation_evidence": validation,',
          '        "artifacts": artifacts,',
        ].join("\n"),
        replace: [
          '        "validation": {',
          '            "STEP": {"solid_count": 1, "bbox_mm": bounds},',
          '            "STL": {"watertight": True},',
          '            "3MF": {"object_count": 1, "build_item_count": 1},',
          "        },",
          '        "artifacts": artifacts,',
        ].join("\n"),
      },
      { taskProfile: "cad" }
    ),
    null,
    "a material alias-to-canonical CAD evidence repair was blocked"
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
      version: RESEARCH_VERSION,
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
  completedResearchState.meta.completedDeepResearch[0].result.version = RESEARCH_VERSION - 1;
  assert(
    completedDeepResearchReuse(
      completedResearchState,
      { query: "A model-expanded query", outputPath: "report.md", refresh: true },
      { commandCwd: workspace }
    ) === null,
    "a stale deep-research engine result was reused after the report contract changed"
  );
  completedResearchState.meta.completedDeepResearch[0].result.version = RESEARCH_VERSION;
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
      goalContract: { revision: 4, currentHash: "artifact-goal-v4" },
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
  const recordStreamContract = deriveScsTaskContract({
    goal:
      "Read records.jsonl as the complete source, update handoff.md and coverage.json, validate the outputs, and commit the coherent result.",
    taskProfile: "writing",
  });
  assert(
    recordStreamContract.exactInputPaths.includes("records.jsonl"),
    "newline-delimited source records were not inferred as an exact input"
  );
  const protectedInputState = {
    goal: "Continue the same task from the saved state.",
    commandCwd: workspace,
    meta: {
      goalContract: {
        revision: 6,
        currentRequest: "Continue the same task from the saved state.",
        activeGoal:
          "Read records.jsonl as the complete source, update handoff.md and coverage.json, validate the outputs, and commit the coherent result.",
        activeGoalRevision: 5,
      },
      projectVerification: {
        mutationRevision: 3,
        requiredOutputs: ["handoff.md", "coverage.json"],
      },
      artifactProgress: {
        exactOutputPaths: ["handoff.md", "coverage.json"],
        needsRepair: true,
      },
    },
  };
  assert(
    artifactValidationScopeBlock(
      protectedInputState,
      "write_file",
      { path: "records.jsonl", content: "replacement", mode: "overwrite" },
      { commandCwd: workspace, taskProfile: "writing", artifactValidationPhase: true }
    )?.category === "artifact-validation-input-mutation",
    "artifact validation allowed an inferred source ledger to be overwritten"
  );
  assert(
    artifactValidationScopeBlock(
      protectedInputState,
      "apply_patch",
      {
        patch:
          "*** Begin Patch\n*** Update File: handoff.md\n@@\n-old\n+new\n*** End Patch",
      },
      { commandCwd: workspace, taskProfile: "writing", artifactValidationPhase: true }
    ) === null,
    "source-input protection blocked a declared output repair"
  );
  const sourceReadMessages = [
    {
      role: "assistant",
      tool_calls: [{
        id: "read-writing-source-task",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "TASK.md" }) },
      }],
    },
    {
      role: "tool",
      tool_call_id: "read-writing-source-task",
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: "TASK.md",
        content: "Create memo.tex and memo.pdf from chat_history.md without changing source files.",
        contentTruncated: false,
        contentTruncatedByLines: false,
      }),
    },
  ];
  const discoveredWritingSourceState = {
    goal: "Inspect this incomplete writing project, finish it, verify it, and commit the intentional work.",
    messages: sourceReadMessages,
    meta: {
      taskProfile: "writing",
      goalContract: {
        revision: 1,
        activeGoal: "Inspect this incomplete writing project, finish it, verify it, and commit the intentional work.",
      },
    },
  };
  assert(
    documentSourceMaterialMutationBlock(
      discoveredWritingSourceState,
      "apply_patch",
      { path: "TASK.md", search: "Create", replace: "Created" },
      { commandCwd: workspace, taskProfile: "writing" }
    )?.category === "document-source-material-mutation",
    "a discovered writing-task instruction source remained writable without explicit user authorization"
  );
  const explicitTaskEditState = structuredClone(discoveredWritingSourceState);
  explicitTaskEditState.meta.goalContract.activeGoal = "Update TASK.md to correct its output instructions.";
  assert(
    documentSourceMaterialMutationBlock(
      explicitTaskEditState,
      "apply_patch",
      { path: "TASK.md", search: "Create", replace: "Created" },
      { commandCwd: workspace, taskProfile: "writing" }
    ) === null,
    "an explicit user request to edit an exact writing source was blocked"
  );
  assert(
    documentSourceMaterialMutationBlock(
      discoveredWritingSourceState,
      "apply_patch",
      { path: "TASK.md", search: "Create", replace: "Created" },
      { commandCwd: workspace, taskProfile: "code" }
    ) === null,
    "document-source immutability leaked into a coding profile"
  );
  for (const patch of [
    '*** Begin Patch\n*** Delete File: "report.md"\n*** End Patch',
    "--- a/report.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-old",
    "*** Begin Patch\n*** Update File: report.md\n*** Move to: archived.md\n@@\n-old\n+new\n*** End Patch",
  ]) {
    assert(
      artifactValidationScopeBlock(
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
        { patch },
        { commandCwd: workspace, artifactValidationPhase: true }
      )?.category === "artifact-validation-delete-output",
      `artifact validation allowed an alternate exact-output delete form: ${patch}`
    );
  }
  const nestedDirectoryArtifactState = {
    commandCwd: workspace,
    meta: {
      goalContract: { revision: 1, currentHash: "nested-output-goal" },
      artifactProgress: {
        exactOutputPaths: ["a/report.md"],
        needsRepair: false,
        preflight: { defectCount: 0 },
        preflightFingerprint: "passed",
        preflightGoalRevision: 1,
        preflightGoalHash: "nested-output-goal",
        contractKey: "nested-output-contract",
        preflightContractKey: "nested-output-contract",
      },
    },
  };
  assert(
    artifactValidationScopeBlock(
      nestedDirectoryArtifactState,
      "apply_patch",
      {
        patch:
          "*** Begin Patch\n*** Update File: a/report.md\n@@\n-old\n+new\n*** End Patch",
      },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.category === "artifact-validation-complete",
    "a real directory named a was stripped from a custom patch path"
  );
  assert(
    artifactValidationScopeBlock(
      nestedDirectoryArtifactState,
      "apply_patch",
      { patch: "*** Begin Patch\n*** Delete File: a/report.md\n*** End Patch" },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.category === "artifact-validation-delete-output",
    "a real directory named a was stripped from a custom delete path"
  );
  assert(
    artifactValidationScopeBlock(
      nestedDirectoryArtifactState,
      "write_file",
      { path: "/workspace/a/report.md" },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.category === "artifact-validation-complete",
    "the virtual /workspace alias bypassed the exact-output acceptance guard"
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
  const failedTestDuringArtifactValidationState = {
    commandCwd: workspace,
    meta: {
      artifactProgress: {
        exactOutputPaths: ["AGINTI.md"],
        needsRepair: false,
      },
    },
  };
  assert(
    artifactValidationScopeBlock(
      failedTestDuringArtifactValidationState,
      "read_file",
      { path: "src/main/java/example/WindowSummary.java" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        testFailureRepairActive: true,
        testFailureRepairMutationRequired: true,
      }
    ) === null,
    "artifact validation blocked a source read reopened by an active failed-test contract"
  );
  const authoritativeTestState = {
    goal: "Repair the production implementation and run the existing tests.",
    commandCwd: workspace,
    meta: {
      goalContract: {
        taskGoal: "Repair the production implementation and run the existing tests.",
        activeGoal: "Recover the same unfinished task. Re-read production source and tests.",
        currentRequest: "Recover the same unfinished task. Re-read production source and tests.",
      },
    },
  };
  const authoritativeTestConfig = {
    commandCwd: workspace,
    testFailureRepairActive: true,
  };
  assert(
    failedTestSpecificationMutationBlock(
      authoritativeTestState,
      "apply_patch",
      {
        path: "src/test/java/example/WindowSummaryTest.java",
        search: "expected",
        replace: "observed",
      },
      authoritativeTestConfig
    )?.category === "failed-test-specification-mutation",
    "failed-test repair allowed an unsolicited mutation of an authoritative Java test"
  );
  assert(
    failedTestSpecificationMutationBlock(
      authoritativeTestState,
      "apply_patch",
      {
        path: "src/main/java/example/WindowSummary.java",
        search: "broken",
        replace: "fixed",
      },
      authoritativeTestConfig
    ) === null,
    "failed-test test-specification protection blocked production-source repair"
  );
  assert(
    failedTestSpecificationMutationBlock(
      {
        ...authoritativeTestState,
        goal: "Update the existing test harness to use the project-local executable.",
        meta: {
          goalContract: {
            taskGoal: "Update the existing test harness to use the project-local executable.",
          },
        },
      },
      "apply_patch",
      {
        path: "tests/test_harness.py",
        search: "old_path",
        replace: "new_path",
      },
      authoritativeTestConfig
    ) === null,
    "an explicit user request to update a test harness was incorrectly blocked"
  );
  assert(
    failedTestSpecificationMutationBlock(
      authoritativeTestState,
      "apply_patch",
      {
        path: "tests/test_harness.py",
        search: "old_path",
        replace: "new_path",
      },
      {
        ...authoritativeTestConfig,
        testFailureRepairPatchTargets: [{
          kind: "python-agent-test-harness-path",
          path: "tests/test_harness.py",
          search: "old_path",
        }],
      }
    ) === null,
    "an exact deterministic test-harness repair target was incorrectly blocked"
  );
  const ownedTestPath = "src/test/java/example/WindowSummaryTest.java";
  const ownedProductionPath = "src/main/java/example/WindowSummary.java";
  const ownedDependencyPath = "src/main/java/example/Reading.java";
  const ownedVerifierPath = "scripts/test.sh";
  const ownedTestSource =
    "final class WindowSummaryTest { Reading reading; WindowSummary summary; broken agent edit; }\n";
  await fs.mkdir(path.join(workspace, path.dirname(ownedTestPath)), { recursive: true });
  await fs.mkdir(path.join(workspace, path.dirname(ownedProductionPath)), { recursive: true });
  await fs.mkdir(path.join(workspace, path.dirname(ownedVerifierPath)), { recursive: true });
  await fs.writeFile(path.join(workspace, ownedTestPath), ownedTestSource, "utf8");
  await fs.writeFile(
    path.join(workspace, ownedProductionPath),
    "final class WindowSummary { }\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(workspace, ownedDependencyPath),
    "record Reading(long timestampMillis, String sensorId, double value) { }\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(workspace, ownedVerifierPath),
    "#!/usr/bin/env bash\nset -euo pipefail\n",
    "utf8"
  );
  const compilerFailurePacket = await buildFailedTestRecoveryPacket(
    { provider: "deepseek", commandCwd: workspace },
    {
      goal: "Repair the production implementation from the existing Java tests.",
      commandCwd: workspace,
      meta: {
        projectVerification: {
          mutationRevision: 3,
          mutationHistory: [{
            revision: 3,
            toolName: "apply_patch",
            paths: [ownedProductionPath],
          }],
          testRuns: [{
            command: "scripts/test.sh",
            passed: false,
            ok: false,
            mutationRevision: 3,
            failureSignature: "java-compiler-source-path",
            failureSummary: [
              `./${ownedTestPath}:30: error: cannot find symbol`,
              "WindowSummary.percentile(values, 0.5);",
            ].join("\n"),
          }],
        },
      },
    }
  );
  assert(
    compilerFailurePacket.paths.includes(ownedTestPath) &&
      compilerFailurePacket.paths.includes(ownedProductionPath),
    "a compiler-reported authoritative test path was omitted from bounded failed-test evidence"
  );
  assert(
    compilerFailurePacket.paths.includes(ownedDependencyPath) &&
      compilerFailurePacket.paths.includes(ownedVerifierPath),
    "failed-test recovery omitted a same-package Java dependency or the exact verifier script"
  );
  assert(
    compilerFailurePacket.repairPaths.includes(ownedProductionPath) &&
      !compilerFailurePacket.repairPaths.includes(ownedTestPath),
    "compiler evidence made an authoritative test writable during production repair"
  );
  const ownedTestSha256 = crypto
    .createHash("sha256")
    .update(ownedTestSource)
    .digest("hex");
  const authoritativeRestoreState = {
    goal: "Repair the production implementation and preserve the authoritative tests.",
    commandCwd: workspace,
    meta: {
      goalContract: {
        revision: 4,
        taskGoal: "Repair the production implementation and preserve the authoritative tests.",
        activeGoal: "Continue the same production repair.",
        currentRequest: "Continue the same production repair.",
      },
      activeExecutionContract: { revision: 4 },
      projectVerification: {
        mutationRevision: 2,
        privateMutationRevision: 0,
        requiredCommands: ["scripts/test.sh"],
        commandRuns: [
          {
            command: `git checkout HEAD -- '${ownedTestPath}'`,
            ok: true,
            mutationRevision: 1,
          },
        ],
        mutationHistory: [
          {
            revision: 1,
            toolName: "run_command",
            paths: [],
            commandCategory: "destructive",
          },
          {
            revision: 2,
            toolName: "apply_patch",
            paths: [ownedTestPath],
            patch: { afterContentSha256: ownedTestSha256 },
          },
        ],
        testRuns: [
          {
            command: "scripts/test.sh",
            passed: false,
            ok: false,
            mutationRevision: 2,
            privateMutationRevision: 0,
            failureSignature: "authoritative-test-corruption",
            failureSummary: "cannot find symbol in WindowSummaryTest",
          },
        ],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        content: "bounded packet",
        paths: [ownedTestPath, ownedProductionPath],
        repairPaths: [ownedProductionPath],
        mutationRevision: 2,
        failureSignature: "authoritative-test-corruption",
        command: "scripts/test.sh",
        generatedAt: "2026-08-29T03:00:00.000Z",
        authoritativeTestRestores: [
          {
            path: ownedTestPath,
            currentSha256: ownedTestSha256,
            baselineSha256: "baseline-sha256",
            restoredRevision: 1,
            agentMutationRevision: 2,
          },
        ],
      },
      toolLoop: {
        recent: [0, 1, 2].map((index) => ({
          toolName: "apply_patch",
          ok: false,
          blocked: true,
          category: "failed-test-specification-mutation",
          mutationRevision: 2,
          at: `2026-08-29T03:00:0${index + 1}.000Z`,
        })),
      },
    },
  };
  const authoritativeRestoreRuntime = nextStepRuntimeConfig(
    { provider: "deepseek", commandCwd: workspace },
    authoritativeRestoreState
  );
  assert(
    authoritativeRestoreRuntime.testFailureAuthoritativeRestorePending === true,
    "three rejected authoritative-test rewrites did not expose a provenance-bound restoration"
  );
  assertStrict.deepEqual(
    authoritativeRestoreRuntime.testFailureAuthoritativeRestorePaths,
    [ownedTestPath],
    "authoritative-test restoration broadened beyond the exact task-owned damaged path"
  );
  assertStrict.equal(
    authoritativeRestoreRuntime.testFailureAuthoritativeRestoreCommand,
    `git checkout HEAD -- '${ownedTestPath}'`,
    "authoritative-test restoration was not bound to one exact HEAD command"
  );
  await fs.writeFile(
    path.join(workspace, ownedTestPath),
    `${ownedTestSource}// external change\n`,
    "utf8"
  );
  assert(
    nextStepRuntimeConfig(
      { provider: "deepseek", commandCwd: workspace },
      authoritativeRestoreState
    ).testFailureAuthoritativeRestorePending !== true,
    "authoritative-test restoration ignored a post-packet content-hash change"
  );
  await fs.writeFile(path.join(workspace, ownedTestPath), ownedTestSource, "utf8");
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
  const commandArtifactState = {
    meta: {
      scs: {
        taskContract: {
          exactOutputPaths: ["output/generated.json"],
        },
      },
    },
  };
  const commandArtifactProgress = recordExactOutputProgress(
    commandArtifactState,
    {
      ok: true,
      toolName: "run_command",
      verifiedGeneratedOutputPaths: ["output/generated.json"],
    },
    { commandCwd: workspace }
  );
  assert(
    commandArtifactProgress.justActivated &&
      commandArtifactState.meta.artifactProgress.complete,
    "snapshot-verified shell output did not activate exact artifact progress"
  );
  assert(
    nextStepRuntimeConfig({ provider: "localllm" }, artifactState).artifactValidationPhase === true,
    "next step did not enter artifact validation mode"
  );
  const reopenedRepairState = {
    commandCwd: workspace,
    meta: {
      goalContract: { revision: 9 },
      artifactProgress: {
        reopenedGoalRevision: 9,
        reopenedMutationRevision: 4,
        reopenedSourcePaths: ["analysis.py"],
      },
      projectVerification: { mutationRevision: 4, mutationHistory: [] },
    },
  };
  assert(
    reopenedArtifactRepairPending(reopenedRepairState),
    "a fresh same-task correction was cleared before any source mutation"
  );
  recordProjectVerificationOutcome(
    reopenedRepairState,
    {
      toolName: "apply_patch",
      ok: true,
      path: "unrelated.py",
      change: { path: "unrelated.py", beforeHash: "before", afterHash: "after" },
    },
    { commandCwd: workspace, taskProfile: "code" }
  );
  assert(
    reopenedArtifactRepairPending(reopenedRepairState),
    "an unrelated mutation incorrectly satisfied a named source correction"
  );
  recordProjectVerificationOutcome(
    reopenedRepairState,
    {
      toolName: "apply_patch",
      ok: true,
      path: "analysis.py",
      change: { path: "analysis.py", beforeHash: "before", afterHash: "after" },
    },
    { commandCwd: workspace, taskProfile: "code" }
  );
  assert(
    !reopenedArtifactRepairPending(reopenedRepairState),
    "a named source mutation did not satisfy the revision-scoped repair obligation"
  );
  recordProjectVerificationOutcome(
    reopenedRepairState,
    {
      toolName: "apply_patch",
      ok: true,
      path: "later-unrelated.py",
      change: { path: "later-unrelated.py", beforeHash: "before", afterHash: "after" },
    },
    { commandCwd: workspace, taskProfile: "code" }
  );
  assert(
    !reopenedArtifactRepairPending(reopenedRepairState),
    "a later unrelated mutation erased the earlier named source correction"
  );
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
  artifactState.meta.artifactProgress.preflightFingerprint = "passed";
  artifactState.meta.artifactProgress.preflight = { defectCount: 0 };
  artifactState.meta.artifactProgress.preflightGoalRevision = 4;
  artifactState.meta.artifactProgress.preflightGoalHash = "artifact-goal-v4";
  artifactState.meta.artifactProgress.preflightContractKey =
    artifactState.meta.artifactProgress.contractKey;
  assert(
    artifactValidationAcceptanceIsCurrent(artifactState),
    "current revision-scoped artifact acceptance was not recognized"
  );
  artifactState.meta.projectVerification = { mutationRevision: 1 };
  assert(
    !artifactValidationAcceptanceIsCurrent(artifactState),
    "artifact acceptance survived a newer project mutation revision"
  );
  artifactState.meta.artifactProgress.preflightMutationRevision = 1;
  assert(
    artifactValidationAcceptanceIsCurrent(artifactState),
    "artifact acceptance did not recover after validation bound the new project revision"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "write_file",
      { path: "MEDIA_ROUTINE_READINESS.md" },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.category === "artifact-validation-complete",
    "artifact validation allowed a rewrite after deterministic success"
  );
  const acceptedArtifactPath = path.join(workspace, "MEDIA_ROUTINE_READINESS.md");
  const acceptedArtifactAlias = path.join(workspace, "accepted-output-alias.md");
  await fs.writeFile(acceptedArtifactPath, "accepted\n", "utf8");
  await fs.symlink(acceptedArtifactPath, acceptedArtifactAlias);
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "write_file",
      { path: "accepted-output-alias.md" },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.category === "artifact-validation-complete",
    "a symlink alias bypassed the accepted exact-output write guard"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "apply_patch",
      { path: "handoff.md", patch: "*** Begin Patch\n*** Update File: handoff.md\n*** End Patch" },
      { commandCwd: workspace, artifactValidationPhase: true }
    ) === null,
    "acceptance of one exact output froze a different required project file"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "apply_patch",
      {
        patch:
          "--- a/handoff.md\n+++ b/handoff.md\n@@ -1 +1 @@\n-old\n+new",
      },
      { commandCwd: workspace, artifactValidationPhase: true }
    ) === null,
    "acceptance of one exact output froze an unrelated unified patch"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "apply_patch",
      {
        patch:
          "--- a/MEDIA_ROUTINE_READINESS.md\n+++ b/MEDIA_ROUTINE_READINESS.md\n@@ -1 +1 @@\n-old\n+new",
      },
      { commandCwd: workspace, artifactValidationPhase: true }
    )?.category === "artifact-validation-complete",
    "an accepted exact output remained writable through a unified patch"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "apply_patch",
      {
        path: "MEDIA_ROUTINE_READINESS.md",
        search: "old",
        replace: "new validation evidence",
      },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        testFailureRepairActive: true,
        testFailureRepairMutationRequired: true,
        testFailureRepairPatchTargets: [{ path: "MEDIA_ROUTINE_READINESS.md" }],
      }
    ) === null,
    "a current exact failed-test repair could not reopen its accepted output source"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "apply_patch",
      {
        path: "MEDIA_ROUTINE_READINESS.md",
        search: "old",
        replace: "unrelated",
      },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        testFailureRepairActive: true,
        testFailureRepairMutationRequired: true,
        testFailureRepairPatchTargets: [{ path: "different_source.py" }],
      }
    )?.category === "artifact-validation-complete",
    "a mismatched failed-test repair target reopened an accepted exact output"
  );
  for (const patch of [
    '*** Begin Patch\n*** Update File: "MEDIA_ROUTINE_READINESS.md"\n@@\n-old\n+new\n*** End Patch',
    '*** Begin Patch\n*** Add File: "MEDIA_ROUTINE_READINESS.md"\n+new\n*** End Patch',
    "*** Begin Patch\n*** Update File: handoff.md\n*** Move to: MEDIA_ROUTINE_READINESS.md\n@@\n-old\n+new\n*** End Patch",
  ]) {
    assert(
      artifactValidationScopeBlock(
        artifactState,
        "apply_patch",
        { patch },
        { commandCwd: workspace, artifactValidationPhase: true }
      )?.category === "artifact-validation-complete",
      `an accepted exact output remained writable through a normalized patch path: ${patch}`
    );
  }
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "apply_patch",
      {
        patch: "*** Begin Patch\n*** Add File: a/MEDIA_ROUTINE_READINESS.md\n+new\n*** End Patch",
      },
      { commandCwd: workspace, artifactValidationPhase: true }
    ) === null,
    "a real directory named a was mistaken for a synthetic unified-diff prefix"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git status --short" },
      { commandCwd: workspace, artifactValidationPhase: true, allowShellTool: true }
    ) === null,
    "artifact validation blocked a bounded read-only shell check"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "sed -i 's/old/new/' MEDIA_ROUTINE_READINESS.md" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        allowShellTool: true,
        allowDestructive: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "a shell mutation bypassed current artifact acceptance"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "python3 build_deck.py" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        generatedArtifactProducerPending: true,
        generatedArtifactProducerCommand: "python3 build_deck.py",
        allowShellTool: true,
        allowDestructive: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation blocked the exact pending generated-artifact producer"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "python3 unrelated_generator.py" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        generatedArtifactProducerPending: true,
        generatedArtifactProducerCommand: "python3 build_deck.py",
        allowShellTool: true,
        allowDestructive: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "an unrelated generator borrowed permission from the pending artifact producer"
  );
  const retainedValidatorCommand =
    "/opt/cad/bin/python /workspace/acceptance/cad_contract.py --root .";
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: retainedValidatorCommand },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        testVerificationPending: true,
        testVerificationCommand: retainedValidatorCommand,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation blocked the exact runtime-selected retained validator"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "/opt/cad/bin/python /workspace/acceptance/other_contract.py --root ." },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        testVerificationPending: true,
        testVerificationCommand: retainedValidatorCommand,
        allowShellTool: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "an unrelated external command borrowed permission from the retained validator"
  );
  artifactState.meta.artifactProgress.needsCommand = true;
  artifactState.meta.artifactProgress.preflight.missingProjectCommands = ["npm test"];
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "npm test" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsCommand: true,
        allowShellTool: true,
      }
    ) === null,
    "artifact validation blocked the exact pending project command"
  );
  artifactState.meta.artifactProgress.preflight.missingProjectCommands = [
    `cd ${workspace} && node generate.js`,
  ];
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "cd . && node generate.js" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsCommand: true,
        allowShellTool: true,
        allowDestructive: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation rejected a workspace-equivalent pending command"
  );
  const explicitRunGoal = "Write `demo.py`. Then run `python demo.py` and report its output.";
  const explicitRunContract = deriveScsTaskContract({
    goal: explicitRunGoal,
    taskProfile: "code",
  });
  const explicitRunState = {
    commandCwd: workspace,
    meta: {
      goalContract: { revision: 1, currentHash: "explicit-run-goal" },
      projectVerification: {
        mutationRevision: 1,
        requiredCommands: ["npm test"],
      },
      artifactProgress: {
        complete: true,
        exactOutputPaths: ["demo.py"],
        contractKey: "explicit-run-contract",
        preflight: {
          missingEvidence: ["command"],
          missingProjectCommands: ["python demo.py", "npm test"],
        },
        preflightFingerprint: "explicit-run-preflight",
        preflightGoalRevision: 1,
        preflightGoalHash: "explicit-run-goal",
        preflightContractKey: "explicit-run-contract",
        preflightMutationRevision: 1,
        needsCommand: true,
        needsRepair: false,
      },
    },
  };
  const augmentedExplicitRunContract = augmentScsTaskContractWithProjectVerification(
    explicitRunContract,
    explicitRunState,
    { taskProfile: "code" }
  );
  assert(
    JSON.stringify(explicitRunContract.requiredProjectCommands) ===
      JSON.stringify(["python demo.py"]) &&
      augmentedExplicitRunContract.requiredProjectCommands.includes("python demo.py") &&
      augmentedExplicitRunContract.requiredProjectCommands.includes("npm test"),
    "an explicitly requested inline command was not preserved as first-class evidence"
  );
  const coordinatedExplicitRunContract = deriveScsTaskContract({
    goal: "Write `demo.py` and then run `python demo.py`.",
    taskProfile: "code",
  });
  assert(
    JSON.stringify(coordinatedExplicitRunContract.requiredProjectCommands) ===
      JSON.stringify(["python demo.py"]),
    "a coordinated explicit inline command was lost"
  );
  const exactVerifierWithCleanupContract = deriveScsTaskContract({
    goal:
      "Run the canonical verifier `scripts/test.sh` exactly once, retain its result, remove only disposable `.build` output, confirm `git status --short` is clean, and finish.",
    taskProfile: "code",
  });
  assert(
    JSON.stringify(exactVerifierWithCleanupContract.requiredProjectCommands) ===
      JSON.stringify(["scripts/test.sh", "git status --short"]) &&
      exactVerifierWithCleanupContract.exactOutputPaths.length === 0,
    "a backticked cleanup path displaced the explicitly requested verifier"
  );
  const staleTurnCommandState = {
    goal:
      "Run the canonical verifier `scripts/test.sh` exactly once and confirm `git status --short` is clean.",
    meta: {
      taskProfile: "code",
      goalContract: {
        revision: 8,
        currentRequest:
          "Run the canonical verifier `scripts/test.sh` exactly once and confirm `git status --short` is clean.",
      },
      projectVerification: {
        mutationRevision: 4,
        contractRequiredCommands: [".build"],
        requiredCommands: ["scripts/test.sh"],
        requiredCommandBatch: {
          id: "required-command-batch-stale",
          key: JSON.stringify([".build"]),
          requiredCommands: [".build"],
        },
      },
    },
  };
  resetSameTaskExecutionContract(staleTurnCommandState, 8);
  assert(
    JSON.stringify(
      staleTurnCommandState.meta.projectVerification.contractRequiredCommands
    ) === JSON.stringify(["scripts/test.sh", "git status --short"]) &&
      !staleTurnCommandState.meta.projectVerification.requiredCommandBatch.requiredCommands.includes(
        ".build"
      ),
    "a refreshed continuation retained superseded turn-scoped project commands"
  );
  const bareVerifierPath =
    "/home/lachlan/ProjectsLFS/Aginti-Test/supervision/acceptance/security_labshare_contract.py";
  const bareVerifierContract = deriveScsTaskContract({
    goal: `Run the visible unittest suite and ${bareVerifierPath}, commit only labshare.py, tests/test_labshare.py, and SECURITY.md, then verify a clean worktree.`,
    taskProfile: "security",
  });
  assert(
    JSON.stringify(bareVerifierContract.requiredProjectCommands) ===
      JSON.stringify([`python3 ${bareVerifierPath}`]),
    "an explicitly requested bare verifier path was not retained as an executable canonical command"
  );
  assert(
    !bareVerifierContract.requiredEvidence.some((item) => item.category === "visual"),
    "the phrase visible unittest suite fabricated screenshot evidence"
  );
  assert(
    deriveScsTaskContract({
      goal: `Read ${bareVerifierPath} and explain its checks without running it.`,
      taskProfile: "writing",
    }).requiredProjectCommands.length === 0,
    "a descriptive bare verifier path fabricated an execution requirement"
  );
  assert(
    deriveScsTaskContract({
      goal: "Open the visible browser preview and inspect the image before finishing.",
      taskProfile: "design",
    }).requiredEvidence.some((item) => item.category === "visual"),
    "a genuine visible browser-preview request lost visual evidence"
  );
  assert(
    successfulGitCommitProvesFileMutation({
      ok: true,
      exitCode: 0,
      args: { command: "git commit -m 'Focused repair'" },
      stdout: "[main abcdef1] Focused repair\n 3 files changed, 12 insertions(+), 2 deletions(-)\n",
    }) === true,
    "a successful non-empty commit did not preserve inherited file-mutation evidence"
  );
  assert(
    successfulGitCommitProvesFileMutation({
      ok: false,
      exitCode: 1,
      args: { command: "git commit -m 'Focused repair'" },
      stdout: "On branch main\nnothing to commit, working tree clean\n",
    }) === false,
    "a no-op commit fabricated file-mutation evidence"
  );
  let boundedGitEvidence = [
    { action: "commit", goalRevision: 12, mutationRevision: 3 },
  ];
  for (let index = 0; index < 100; index += 1) {
    boundedGitEvidence = mergeDurableGitEvidence(boundedGitEvidence, ["add"], {
      goalRevision: 12,
      mutationRevision: 3,
    });
  }
  assert(
    boundedGitEvidence.some(
      (item) =>
        item.action === "commit" &&
        item.goalRevision === 12 &&
        item.mutationRevision === 3
    ) &&
      boundedGitEvidence.filter((item) => item.action === "add").length === 1,
    "repeated staging evidence evicted a stronger durable commit"
  );
  for (const goal of [
    "Run this command: `npm test`.",
    "Please run: `npm test`.",
    "Execute the following command - `npm test`.",
    "Run `./check.sh`.",
    "Execute `scripts/verify.py`.",
    "Run this exact declared validator command without reading or editing its source: `/opt/cad/bin/python /workspace/acceptance/cad_contract.py --root .`.",
    "Run this exact declared validator command without reading or editing its source:\n\n`/opt/cad/bin/python /workspace/acceptance/cad_contract.py --root .`.",
    "After the producer succeeds, run this exact declared validator command unchanged\nas a separate standalone tool call, without reading or editing its source:\n\n`/opt/cad/bin/python /workspace/acceptance/cad_contract.py --root .`.",
  ]) {
    const requestedCommand = goal.match(/`([^`]+)`/)?.[1] || "";
    assert(
      JSON.stringify(deriveScsTaskContract({ goal, taskProfile: "code" }).requiredProjectCommands) ===
        JSON.stringify([requestedCommand]),
      `normal punctuation hid an explicitly requested inline command: ${goal}`
    );
  }
  const multilineValidatorContinuation = `Continue this exact CAD task from the preserved session and current workspace.
Do not restart or redesign it. The fresh external-gate diagnostic after the
successful rebuild is:

\`FAIL: manifest parameters omit seat_diameter_mm\`

Repair only the source-of-truth manifest generation needed by this diagnostic.
Run the existing documented producer command as one standalone tool call after
each source repair. Then run this exact declared validator command unchanged as
a separate standalone tool call, without reading or editing its source:

\`/opt/cad/bin/python /workspace/acceptance/cad_contract.py --root .\`

Do not prefix, suffix, wrap, redirect, pipe, or combine that validator command.`;
  const semanticContinuation = [
    "Continue the current task from its preserved state.",
    "The latest correction changes the acceptance meaning substantially even though it deliberately names no file, command, literal token, or output path.",
    "Keep the valid work already completed, replace the stale interpretation with this clarified behavior, reconcile every affected decision against the current evidence, and verify the resulting behavior before finishing.",
  ].join(" ");
  assert(
    continuationAddsConcreteRequirement(semanticContinuation),
    "a long substantive continuation without parser-recognized literals was treated as a bare resume"
  );
  const semanticContinuationState = {
    goal: "Use the earlier interpretation.",
    plan: "Continue using the earlier interpretation.",
    meta: {
      taskProfile: "auto",
      goalContract: {
        version: 3,
        revision: 3,
        status: "paused",
        currentRequest: "Use the earlier interpretation.",
        taskGoal: "Complete the retained task.",
        activeGoal: "Use the earlier interpretation.",
        activeGoalRevision: 3,
        history: [],
        lifecycle: [],
      },
    },
  };
  const semanticContinuationUpdate = applyContinuationContractTransition(
    semanticContinuationState,
    semanticContinuation,
    { at: "2026-08-29T02:35:43.215Z" }
  );
  assert(
    semanticContinuationUpdate?.refreshExecutionContract === true &&
      semanticContinuationState.goal === semanticContinuation &&
      semanticContinuationState.meta.goalContract.activeGoal === semanticContinuation,
    "a substantive same-task correction left the stale active goal authoritative"
  );
  const multilineValidatorContract = deriveScsTaskContract({
    goal: multilineValidatorContinuation,
    taskProfile: "cad",
  });
  assert(
    JSON.stringify(multilineValidatorContract.requiredProjectCommands) ===
      JSON.stringify([authoritativeValidatorCommand]),
    "multiline continuation selected a diagnostic or dropped the later exact validator command"
  );
  const multilineContinuationState = {
    goal: "Repair and validate the current CAD artifact.",
    plan: "Inspect, repair, rebuild, validate, and commit.",
    meta: {
      taskProfile: "cad",
      goalContract: {
        version: 3,
        revision: 8,
        status: "paused",
        currentRequest: "Repair and validate the current CAD artifact.",
        taskGoal: "Repair and validate the current CAD artifact.",
        activeGoal: "Repair and validate the current CAD artifact.",
        activeGoalRevision: 8,
        history: [],
        lifecycle: [],
      },
      projectVerification: {
        mutationRevision: 42,
        requiredOutputs: [],
        requiredCommands: [],
        acceptanceBySource: {},
      },
    },
  };
  const multilineContinuationUpdate = applyContinuationContractTransition(
    multilineContinuationState,
    multilineValidatorContinuation,
    { at: "2026-08-28T08:28:42.959Z" }
  );
  assert(
    multilineContinuationUpdate?.refreshExecutionContract === true &&
      multilineContinuationState.meta.activeExecutionContract.revision === 9 &&
      JSON.stringify(
        multilineContinuationState.meta.activeExecutionContract.requiredProjectCommands
      ) === JSON.stringify([authoritativeValidatorCommand]),
    "same-task contract refresh dropped the multiline exact validator command"
  );
  for (const goal of [
    "Document how to run `npm test`.",
    "Explain the `python demo.py` command.",
    "Do not run `python mutate.py`.",
    "Check likely validation commands from manifests. Bound shell checks with `timeout 30s ...` when available.",
  ]) {
    assert(
      deriveScsTaskContract({ goal, taskProfile: "writing" }).requiredProjectCommands.length === 0,
      `descriptive or forbidden inline command prose fabricated execution: ${goal}`
    );
  }
  assert(
    artifactValidationScopeBlock(
      explicitRunState,
      "run_command",
      { command: "python demo.py" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsCommand: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation blocked the exact toolchain command requested by the user"
  );
  assert(
    artifactValidationScopeBlock(
      explicitRunState,
      "run_command",
      { command: "python mutate.py" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsCommand: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "an unrelated toolchain command borrowed permission from an explicit requested command"
  );
  artifactState.meta.artifactProgress.preflight.missingProjectCommands = [];
  for (const command of ["npm run build", "python -m py_compile src/out.py"]) {
    assert(
      artifactValidationScopeBlock(
        artifactState,
        "run_command",
        { command },
        {
          commandCwd: workspace,
          artifactValidationPhase: true,
          artifactValidationNeedsCommand: true,
          allowShellTool: true,
        }
      ) === null,
      `artifact validation blocked bounded generic command evidence: ${command}`
    );
  }
  for (const command of [
    "npm test && git checkout feature-branch",
    "npm test && git switch feature-branch",
    "npm test && git branch validation-side-effect",
    "npm test && git tag validation-side-effect",
  ]) {
    assert(
      artifactValidationScopeBlock(
        artifactState,
        "run_command",
        { command },
        {
          commandCwd: workspace,
          artifactValidationPhase: true,
          artifactValidationNeedsCommand: true,
          allowShellTool: true,
          sandboxMode: "host",
        }
      )?.category === "artifact-validation-shell-mutation",
      `a generic validation command permitted an unrelated mutating suffix: ${command}`
    );
  }
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "npm test && git status --short" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsCommand: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "a bounded test followed by an observational command was rejected"
  );
  const batchGuardState = {
    commandCwd: workspace,
    meta: {
      goalContract: { revision: 2, currentHash: "batch-goal" },
      projectVerification: { mutationRevision: 0 },
      artifactProgress: {
        complete: true,
        contractKey: "batch-contract",
        exactOutputPaths: ["MEDIA_ROUTINE_READINESS.md"],
        preflight: { defectCount: 0 },
        preflightFingerprint: "passed",
        preflightGoalRevision: 2,
        preflightGoalHash: "batch-goal",
        preflightContractKey: "batch-contract",
        preflightMutationRevision: 0,
        needsRepair: false,
        needsCommand: false,
      },
    },
  };
  assert(
    artifactValidationAcceptanceIsCurrent(batchGuardState),
    "batch guard fixture did not begin with current artifact acceptance"
  );
  recordProjectVerificationOutcome(
    batchGuardState,
    {
      toolName: "apply_patch",
      ok: true,
      path: "handoff.md",
      change: { path: "handoff.md", beforeHash: "before", afterHash: "after" },
    },
    { commandCwd: workspace, taskProfile: "code" }
  );
  assert(
    !artifactValidationAcceptanceIsCurrent(batchGuardState),
    "an earlier mutation in the tool batch did not stale artifact acceptance"
  );
  assert(
    artifactValidationScopeBlock(
      batchGuardState,
      "run_command",
      { command: "python mutate.py" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationAcceptedAtBatchStart: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "an earlier tool mutation disabled the artifact shell guard inside the same batch"
  );
  assert(
    artifactValidationScopeBlock(
      batchGuardState,
      "write_file",
      { path: "MEDIA_ROUTINE_READINESS.md", content: "rewritten" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationAcceptedAtBatchStart: true,
      }
    )?.category === "artifact-validation-complete",
    "an earlier tool mutation disabled the accepted exact-output write fence inside the same batch"
  );
  artifactState.meta.artifactProgress.preflight.missingProjectCommands = ["npm test"];
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: 'npm test; printf "EXIT=%s\\n" "$?"' },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsCommand: true,
        allowShellTool: true,
        allowDestructive: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation blocked the narrow exit-status wrapper for the exact pending command"
  );
  assert(
    parseNonMutatingExitStatusWrapper('npm test; printf "EXIT=%s\\n" "$?"')?.command ===
      "npm test",
    "the shared exit-status parser rejected its bounded non-mutating form"
  );
  assert(
    parseNonMutatingExitStatusWrapper('npm test; printf "EXIT_CODE=%d\\n" "$?"')
      ?.command === "npm test",
    "the shared exit-status parser rejected a bounded numeric status probe"
  );
  for (const command of [
    'npm test; printf "EXIT=%s\\n" "$?" > MEDIA_ROUTINE_READINESS.md',
    'npm test; printf "EXIT=%s $(touch MEDIA_ROUTINE_READINESS.md)\\n" "$?"',
    'npm test; echo "EXIT=$?" && sed -i "s/old/new/" MEDIA_ROUTINE_READINESS.md',
  ]) {
    assert(
      parseNonMutatingExitStatusWrapper(command) === null,
      `a mutating status wrapper was accepted: ${command}`
    );
    assert(
      artifactValidationScopeBlock(
        artifactState,
        "run_command",
        { command },
        {
          commandCwd: workspace,
          artifactValidationPhase: true,
          artifactValidationNeedsCommand: true,
          allowShellTool: true,
          allowDestructive: true,
          sandboxMode: "host",
        }
      )?.category === "artifact-validation-shell-mutation",
      `a mutating status wrapper bypassed artifact validation: ${command}`
    );
  }
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "python mutate.py" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsCommand: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "an unrelated toolchain command bypassed pending command evidence"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "npm test && sed -i 's/old/new/' MEDIA_ROUTINE_READINESS.md" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsCommand: true,
        allowShellTool: true,
        allowDestructive: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "extra shell mutation was appended to an exact pending command"
  );
  artifactState.meta.artifactProgress.needsCommand = false;
  artifactState.meta.artifactProgress.preflight.missingProjectCommands = [];
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "sed -i 's/old/new/' MEDIA_ROUTINE_READINESS.md && git status --short" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        allowDestructive: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "adding a git probe allowed a compound shell mutation to bypass artifact acceptance"
  );
  artifactState.meta.artifactProgress.preflight.missingGitActions = ["commit"];
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git add MEDIA_ROUTINE_READINESS.md" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation blocked bounded staging required before the pending commit"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git add MEDIA_ROUTINE_READINESS.md && git commit -m 'verify artifact'" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation blocked the git action required by its completion contract"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      {
        command:
          'git add MEDIA_ROUTINE_READINESS.md && git commit -m "verify artifact" -m "Preserve validated output and record the intentional repair."',
      },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation blocked a required commit with a bounded second message paragraph"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      {
        command:
          "git add MEDIA_ROUTINE_READINESS.md && git commit -m 'verify artifact' && git status --short",
      },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "a trailing observational Git status invalidated a required commit"
  );
  artifactState.meta.artifactProgress.preflight.missingGitActions = [];
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git commit -m 'verify generic git evidence'" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
      }
    ) === null,
    "artifact validation blocked a bounded non-observational action for generic Git evidence"
  );
  artifactState.meta.artifactProgress.preflight.missingGitActions = ["tag"];
  for (const command of [
    "rm -rf MEDIA_ROUTINE_READINESS.md && git tag v0.20.216",
    "git tag v0.20.216 && echo done",
  ]) {
    assert(
      artifactValidationScopeBlock(
        artifactState,
        "run_command",
        { command },
        {
          commandCwd: workspace,
          artifactValidationPhase: true,
          artifactValidationNeedsGitEvidence: true,
          allowShellTool: true,
          allowDestructive: true,
          sandboxMode: "host",
        }
      )?.category === "artifact-validation-shell-mutation",
      `a required git action excused a non-git command segment: ${command}`
    );
  }
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git tag v0.20.216" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation blocked a safe tag required by its completion contract"
  );
  artifactState.meta.artifactProgress.preflight.missingGitActions = ["push"];
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git commit -m 'git push'" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "quoted Git prose fabricated the pending push action inside artifact validation"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git push; git tag unrelated-release" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "a pending push action permitted an unrelated Git tag side effect"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git push && git commit --allow-empty -m 'left unpushed'" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "a pending push action allowed a later commit to remain unpushed"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git push" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation blocked the real pending push action"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git push && git status --short" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "a trailing observational Git status invalidated a required push"
  );
  artifactState.meta.artifactProgress.preflight.missingGitActions = ["commit"];
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git status --short && git add MEDIA_ROUTINE_READINESS.md && git commit -m 'verify artifact'" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "a bounded read-only Git preflight broke an exact pending commit workflow"
  );
  artifactState.meta.artifactProgress.preflight.missingGitActions = ["push"];
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: 'git push; printf "EXIT_CODE=%d\\n" "$?"' },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    ) === null,
    "artifact validation blocked the bounded exit-status wrapper for the pending push"
  );
  const restoreGoal = "Create report.md, then run git restore source.md";
  const restoreContract = deriveScsTaskContract({ goal: restoreGoal, taskProfile: "writing" });
  assert(
    restoreContract.requiresExternalEvidence === true &&
      restoreContract.requiredGitActions.includes("restore") &&
      restoreContract.requiredEvidence.some((item) => item.category === "git"),
    "an explicitly required Git action did not become a first-class evidence obligation"
  );
  const commitAndPushContract = deriveScsTaskContract({
    goal: "Please commit the tested changes and push the branch.",
    taskProfile: "code",
  });
  assert(
    commitAndPushContract.requiredGitActions.includes("commit") &&
      commitAndPushContract.requiredGitActions.includes("push"),
    "a compound explicit Git request lost one of its required actions"
  );
  const pullRequestContract = deriveScsTaskContract({
    goal: "Open a pull request for these changes.",
    taskProfile: "code",
  });
  assert(
    pullRequestContract.requiredGitActions.includes("pull-request") &&
      pullRequestContract.requiredEvidence.some((item) => item.category === "git"),
    "an explicit pull-request operation did not require matching Git evidence"
  );
  const pushTagContract = deriveScsTaskContract({
    goal: "Push a git tag.",
    taskProfile: "code",
  });
  assert(
    pushTagContract.requiredGitActions.includes("push") &&
      pushTagContract.requiredEvidence.some((item) => item.category === "git"),
    "an explicit tag-push operation did not require matching Git evidence"
  );
  for (const goal of [
    "Fix the code and commit the changes.",
    "Repair, test and commit the changes.",
    "Update README and git push origin main.",
    "Fix it, commit it, push it.",
    "Commit and then push.",
    "Please stage, commit, and push the changes.",
    "Fix the bug and ensure you commit and push.",
    "Fix the bug and make sure you commit and push.",
  ]) {
    const requestedActions = deriveScsTaskContract({ goal, taskProfile: "code" }).requiredGitActions;
    const expectedAction = /push/i.test(goal) ? "push" : "commit";
    assert(
      requestedActions.includes(expectedAction),
      `a Git action after a non-Git or coordination prefix was lost: ${goal}`
    );
  }
  for (const [goal, expected] of [
    ["Checkout and merge the feature branch.", ["checkout", "merge"]],
    ["Commit the fix. Push it.", ["commit", "push"]],
    ["Repair the repository, verify it, commit, and push the intentional work.", ["commit", "push"]],
    ["Fix the bug and ensure you commit and push.", ["commit", "push"]],
    ["Fix the bug and make sure you commit and push.", ["commit", "push"]],
    ["Please ensure the changes are committed and pushed.", ["commit", "push"]],
  ]) {
    const requestedActions = deriveScsTaskContract({ goal, taskProfile: "code" }).requiredGitActions;
    assert(
      JSON.stringify(requestedActions) === JSON.stringify(expected),
      `a coordinated Git action sequence was not preserved: ${goal}`
    );
  }
  for (const [goal, forbiddenAction] of [
    ["Commit the fix. Push notifications must stay disabled.", "push"],
    ["Commit the fix. Branch coverage must remain above 90%.", "branch"],
    ["Commit the fix. Tag names in the UI should remain unchanged.", "tag"],
    ["Commit the fix. Switch behavior should remain unchanged.", "switch"],
    ["Commit the fix. Restore the previous visual spacing in the component.", "restore"],
  ]) {
    const requestedActions = deriveScsTaskContract({ goal, taskProfile: "code" }).requiredGitActions;
    assert(
      requestedActions.includes("commit") && !requestedActions.includes(forbiddenAction),
      `independent prose fabricated a Git continuation: ${goal}`
    );
  }
  for (const goal of [
    "Branch coverage must remain above 90%.",
    "Tag names in the UI should remain unchanged.",
    "Push notifications must stay disabled.",
    "Stage the release in a test environment.",
    "Stage the experiment before imaging.",
    "Create a commit message for these changes.",
    "Make a commit message template for contributors.",
    "Create a tag name field in the UI.",
    "Make a branch diagram for the documentation.",
  ]) {
    const contract = deriveScsTaskContract({ goal, taskProfile: "code" });
    assert(
      contract.requiredGitActions.length === 0 &&
        !contract.requiredEvidence.some((item) => item.category === "git"),
      `descriptive vocabulary fabricated generic Git evidence: ${goal}`
    );
  }
  for (const goal of [
    "Inspect commit abc123 and summarize the change.",
    "Find which commit introduced this bug.",
    "Review the latest commit; do not change anything.",
    "Write a report that includes the commit hash.",
    "Document the git restore command in report.md.",
    "Explain how git restore works.",
    "Inspect uses of git restore in README.md.",
  ]) {
    const descriptiveGitContract = deriveScsTaskContract({ goal, taskProfile: "review" });
    assert(
      descriptiveGitContract.requiredGitActions.length === 0,
      `descriptive Git prose fabricated an execution obligation: ${goal}`
    );
  }
  for (const goal of [
    "Continue the current task, commit only complete task-owned changes if any remain, and stop after terminal evidence.",
    "Commit if changes remain.",
    "Only commit if there are changes.",
    "If changes remain, commit them.",
    "Commit the task-owned changes if any are left.",
    "Commit only when the worktree is dirty.",
    "如果仍有改动才提交代码。",
  ]) {
    const conditionalGitContract = deriveScsTaskContract({ goal, taskProfile: "code" });
    assert(
      !conditionalGitContract.requiredGitActions.includes("commit"),
      `a no-op-safe conditional instruction fabricated a mandatory commit: ${goal}`
    );
  }
  for (const goal of [
    "Commit the changes.",
    "Commit only the complete task-owned changes.",
    "If tests pass, commit the changes.",
  ]) {
    const mandatoryGitContract = deriveScsTaskContract({ goal, taskProfile: "code" });
    assert(
      mandatoryGitContract.requiredGitActions.includes("commit"),
      `an explicit commit instruction was incorrectly treated as optional: ${goal}`
    );
  }
  const restoreArtifactState = {
    commandCwd: workspace,
    goal: restoreGoal,
    meta: {
      goalContract: {
        revision: 1,
        currentHash: "restore-goal-v1",
        taskGoal: restoreGoal,
        currentRequest: restoreGoal,
      },
      projectVerification: { mutationRevision: 0 },
      artifactProgress: {
        complete: true,
        exactOutputPaths: ["report.md"],
        preflight: { missingGitActions: ["restore"] },
        needsCommand: true,
        needsRepair: false,
        needsSourceRead: false,
      },
      scs: { taskContract: { exactOutputPaths: ["report.md"] } },
    },
  };
  const restoreRuntimeConfig = nextStepRuntimeConfig(
    {
      goal: restoreGoal,
      taskProfile: "writing",
      commandCwd: workspace,
      allowShellTool: true,
      allowDestructive: true,
      sandboxMode: "host",
    },
    restoreArtifactState
  );
  assert(
    restoreRuntimeConfig.artifactValidationNeedsGitEvidence === true &&
      artifactValidationScopeBlock(
        restoreArtifactState,
        "run_command",
        { command: "git restore source.md" },
        restoreRuntimeConfig
      ) === null,
    "a required Git restore could not execute after artifact completion"
  );
  for (const [action, command, allowDestructive = false] of [
    ["checkout", "git checkout feature-branch"],
    ["switch", "git switch feature-branch"],
    ["merge", "git merge --ff-only feature-branch"],
    ["pull", "git pull --ff-only"],
    ["restore", "git restore report.md", true],
  ]) {
    artifactState.meta.artifactProgress.preflight.missingGitActions = [action];
    assert(
      artifactValidationScopeBlock(
        artifactState,
        "run_command",
        { command },
        {
          commandCwd: workspace,
          artifactValidationPhase: true,
          artifactValidationNeedsGitEvidence: true,
          allowShellTool: true,
          allowDestructive,
          sandboxMode: "host",
        }
      ) === null,
      `artifact validation deadlocked the explicitly required git ${action} action`
    );
  }
  artifactState.meta.artifactProgress.preflight.missingGitActions = ["tag"];
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "run_command",
      { command: "git checkout unrelated-branch" },
      {
        commandCwd: workspace,
        artifactValidationPhase: true,
        artifactValidationNeedsGitEvidence: true,
        allowShellTool: true,
        sandboxMode: "host",
      }
    )?.category === "artifact-validation-shell-mutation",
    "a worktree-changing git action bypassed a different pending git requirement"
  );
  artifactState.meta.goalContract = { revision: 5, currentHash: "artifact-goal-v5" };
  assert(
    !artifactValidationAcceptanceIsCurrent(artifactState),
    "artifact acceptance leaked into a newer authoritative goal revision"
  );
  assert(
    artifactValidationScopeBlock(
      artifactState,
      "write_file",
      { path: "MEDIA_ROUTINE_READINESS.md" },
      { commandCwd: workspace, artifactValidationPhase: true }
    ) === null,
    "a stale prior-revision acceptance blocked a current correction"
  );
  artifactState.meta.artifactProgress.preflightGoalRevision = 5;
  artifactState.meta.artifactProgress.preflightGoalHash = "artifact-goal-v5";
  assert(
    artifactValidationAcceptanceIsCurrent(artifactState),
    "refreshed acceptance did not bind to the new goal revision"
  );
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
      goalContract: { revision: 2, currentHash: "portable-goal" },
      artifactProgress: {
        complete: true,
        exactOutputPaths: [path.join(workspace, "reports", "fluorescence-dose-response-analysis.pdf")],
        contractKey: "portable-contract",
        preflight: { defectCount: 0 },
        preflightFingerprint: "passed",
        preflightGoalRevision: 2,
        preflightGoalHash: "portable-goal",
        preflightContractKey: "portable-contract",
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
  const prospectivePatchSyntaxCorrection = {
    toolName: "apply_patch",
    ok: false,
    blocked: false,
    recoverable: true,
    stopRun: false,
    category: "python-syntax-regression",
    error: "Exact Python patch failed prospective syntax validation.",
    diagnosticHint: "SyntaxError: unterminated string literal",
  };
  assert(
    !shouldReviewToolResult(prospectivePatchSyntaxCorrection, { meta: {} }),
    "SCS replanned instead of letting the agent correct a deterministic prospective patch rejection"
  );
  const nonRepairingFailedTestPatch = {
    toolName: "apply_patch",
    ok: false,
    blocked: true,
    recoverable: true,
    stopRun: false,
    category: "failed-test-nonrepairing-patch",
    reason: "The replacement leaves the current actionable traceback line unchanged.",
    diagnosticHint: "Return a materially revised source line.",
  };
  assert(
    !shouldReviewToolResult(nonRepairingFailedTestPatch, { meta: {} }),
    "SCS replanned instead of returning a deterministic non-repairing patch rejection to the agent"
  );
  assert(
    shouldReviewToolResult(
      {
        ...nonRepairingFailedTestPatch,
        category: "unclassified-workspace-blocker",
      },
      { meta: {} }
    ),
    "SCS skipped an unclassified blocked patch result"
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

  const stagnantValidatorCommand = "python /workspace/acceptance.py --root .";
  const stagnantValidatorEvents = [
    { type: "goal.updated", data: { revision: 4 } },
    ...[1, 2, 3].flatMap((mutationRevision) => [
      { type: "file.changed", data: { path: "build.py", mutationRevision } },
      {
        type: "tool.completed",
        data: {
          toolName: "run_command",
          projectTest: {
            command: stagnantValidatorCommand,
            passed: false,
            failureSignature: "unchanged-validator-diagnostic",
            mutationRevision,
          },
        },
      },
    ]),
  ];
  const stagnantValidation = summarizeStagnantValidationLoop(stagnantValidatorEvents);
  assert(
    stagnantValidation.detected && stagnantValidation.mutationPhases === 3,
    "unchanged validator failures across source revisions were not recognized as stagnation"
  );
  const stagnantValidationDecision = decideStepBudgetExtension({
    config: { scsActive: true, commandCwd: "/tmp/workspace" },
    budget: createStepBudgetState(
      { provider: "localllm", maxSteps: 12, dynamicSteps: "on", dynamicStepExtensionLimit: 2, scsActive: true },
      { meta: {}, stepsCompleted: 0 }
    ),
    step: 11,
    state: {
      messages: [
        toolMessage({ toolName: "apply_patch", ok: true, path: "build.py" }),
      ],
    },
    events: stagnantValidatorEvents,
  });
  assert(
    !stagnantValidationDecision.approved &&
      /same validation failure|non-converging repair loop/i.test(stagnantValidationDecision.reason),
    "step budget extended an unchanged validator failure across repeated source mutations"
  );
  const freshRecoveryPacketState = {
    messages: [
      toolMessage({ toolName: "apply_patch", ok: true, path: "build.py" }),
    ],
    meta: {
      projectVerification: {
        lastFailedTest: {
          command: stagnantValidatorCommand,
          passed: false,
          failureSignature: "unchanged-validator-diagnostic",
          failureSummary: "Failing tests: generated manifest lacks validation evidence.",
          mutationRevision: 3,
          at: "2026-08-28T10:24:36.660Z",
        },
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        content: "Fresh exact failure-scoped source and artifact evidence.",
        command: stagnantValidatorCommand,
        failureSignature: "unchanged-validator-diagnostic",
        mutationRevision: 3,
        generatedAt: "2026-08-28T10:24:36.680Z",
      },
    },
  };
  const freshRecoveryBudget = createStepBudgetState(
    {
      provider: "localllm",
      maxSteps: 12,
      dynamicSteps: "on",
      dynamicStepExtensionLimit: 2,
      scsActive: true,
    },
    freshRecoveryPacketState
  );
  const freshRecoveryDecision = decideStepBudgetExtension({
    config: { scsActive: true, commandCwd: "/tmp/workspace" },
    budget: freshRecoveryBudget,
    step: 11,
    state: freshRecoveryPacketState,
    events: stagnantValidatorEvents,
  });
  assert(
    freshRecoveryDecision.approved &&
      /fresh failure-scoped recovery packet|bounded diagnostic continuation/i.test(
        freshRecoveryDecision.reason
      ),
    `the first fresh diagnostic packet could not cross the step boundary: ${freshRecoveryDecision.reason}`
  );
  const repeatedRecoveryDecision = decideStepBudgetExtension({
    config: { scsActive: true, commandCwd: "/tmp/workspace" },
    budget: { ...freshRecoveryBudget, extensionsUsed: 1 },
    step: 19,
    state: freshRecoveryPacketState,
    events: stagnantValidatorEvents,
  });
  assert(
    !repeatedRecoveryDecision.approved &&
      /same validation failure|non-converging repair loop/i.test(
        repeatedRecoveryDecision.reason
      ),
    "the fresh-packet exception allowed a second extension for the same stagnant failure"
  );
  const advancingValidatorEvents = stagnantValidatorEvents.map((event, index) => {
    if (event.type !== "tool.completed") return event;
    return {
      ...event,
      data: {
        ...event.data,
        projectTest: {
          ...event.data.projectTest,
          failureSignature: `advancing-diagnostic-${index}`,
        },
      },
    };
  });
  assert(
    !summarizeStagnantValidationLoop(advancingValidatorEvents).detected,
    "advancing validator diagnostics were mistaken for an unchanged repair loop"
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
  const readOnlyShellDecision = decideStepBudgetExtension({
    config: { scsActive: true, commandCwd: "/tmp/workspace" },
    budget: createStepBudgetState(
      { provider: "localllm", maxSteps: 12, dynamicSteps: "on", dynamicStepExtensionLimit: 2, scsActive: true },
      { meta: {}, stepsCompleted: 0 }
    ),
    step: 11,
    state: {
      messages: Array.from({ length: 5 }, (_, index) =>
        toolMessage({
          toolName: "run_command",
          ok: true,
          args: { command: `python3 -c "print('inspect ${index}')"` },
          commandPolicy: {
            writesWorkspace: true,
            mayMutateProject: false,
            substantiveTest: false,
          },
          exitCode: 0,
          stdout: `inspection ${index}`,
        })
      ),
    },
    events: [],
  });
  assert(
    !readOnlyShellDecision.approved,
    "budget gate extended a run containing only read-only diagnostic shell output"
  );

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

  const educationWorkspace = path.join(tempRoot, "education-artifact-contract");
  await fs.mkdir(path.join(educationWorkspace, "workshop"), { recursive: true });
  await fs.writeFile(path.join(educationWorkspace, "workshop", "lesson-deck.md"), "# Lesson\n");
  const educationGoal =
    "Create an editable lesson deck, a separate practice sheet and answer key, printable materials, a helpful preview, and a reproducible build entrypoint. Verify and commit the work.";
  const educationState = {
    goal: educationGoal,
    commandCwd: educationWorkspace,
    plan: "Create every requested artifact, verify them, and commit the complete set.",
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          ok: true,
          toolName: "write_file",
          path: "workshop/lesson-deck.md",
          goalRevision: 1,
          projectMutationRevision: 1,
        }),
      },
    ],
    meta: {
      taskProfile: "education",
      goalContract: {
        revision: 1,
        currentRequest: educationGoal,
        taskGoal: educationGoal,
        activeGoalRevision: 1,
        lifecycle: [{ at: new Date(Date.now() - 2000).toISOString() }],
      },
      projectVerification: {
        mutationRevision: 1,
        mutationHistory: [
          {
            revision: 1,
            at: new Date().toISOString(),
            toolName: "write_file",
            paths: ["workshop/lesson-deck.md"],
            goalRevision: 1,
          },
        ],
      },
    },
  };
  const incompleteEducationRuntime = nextStepRuntimeConfig(
    { goal: educationGoal, taskProfile: "education", commandCwd: educationWorkspace },
    educationState
  );
  assert(
    incompleteEducationRuntime.requestedArtifactRequirementsPending === true &&
      incompleteEducationRuntime.taskOwnedCommitPending !== true,
    "a partial multi-artifact task entered task-owned Git completion before its deliverables existed"
  );

  const securityWorkspace = path.join(tempRoot, "security-test-before-commit");
  await fs.mkdir(securityWorkspace, { recursive: true });
  await fs.writeFile(path.join(securityWorkspace, "labshare.py"), "def record_access():\n    pass\n");
  const securityGoal = [
    "Independent acceptance failed: audit fields permit newline log injection.",
    "Add a focused regression test, fix the root cause, run the full visible tests,",
    "review the diff, and commit only this corrective work.",
  ].join(" ");
  const securityState = {
    goal: securityGoal,
    commandCwd: securityWorkspace,
    plan: "Patch the source and regression test, run the full suite, then commit the verified work.",
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          ok: true,
          toolName: "apply_patch",
          path: "labshare.py",
          goalRevision: 1,
          projectMutationRevision: 1,
        }),
      },
      {
        role: "tool",
        content: JSON.stringify({
          ok: true,
          toolName: "run_command",
          exitCode: 0,
          args: { command: "git status --short" },
          stdout: " M labshare.py\n",
          goalRevision: 1,
          projectMutationRevision: 1,
        }),
      },
    ],
    meta: {
      taskProfile: "security",
      goalContract: {
        revision: 1,
        currentRequest: securityGoal,
        taskGoal: securityGoal,
        activeGoal: securityGoal,
        activeGoalRevision: 1,
        history: [{ revision: 1, refreshExecutionContract: true }],
        lifecycle: [{ at: new Date(Date.now() - 2000).toISOString() }],
      },
      // Reproduce the pre-fix persisted contract that recognized a mutation
      // but failed to classify the requested regression test as file work.
      activeExecutionContract: {
        revision: 1,
        startedMutationRevision: 0,
        materialMutationRevision: 1,
        requiresWorkspaceMutation: true,
        requiresFileMutation: false,
      },
      projectVerification: {
        mutationRevision: 1,
        mutationHistory: [
          {
            revision: 1,
            at: new Date().toISOString(),
            toolName: "apply_patch",
            paths: ["labshare.py"],
            goalRevision: 1,
          },
        ],
      },
    },
  };
  const securityCompletionContract = completionTaskContract(
    { goal: securityGoal, taskProfile: "security", commandCwd: securityWorkspace },
    securityState
  );
  const preTestSecurityRuntime = nextStepRuntimeConfig(
    { goal: securityGoal, taskProfile: "security", commandCwd: securityWorkspace },
    securityState
  );
  assert(
    securityCompletionContract.requiresFileMutation === true &&
      securityCompletionContract.requiredEvidence.some((item) => item.category === "test") &&
      preTestSecurityRuntime.taskOwnedCommitPending !== true,
    "a regression-test repair entered task-owned Git completion before fresh test evidence"
  );

  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log("smoke-dynamic-step-budget ok");
} catch (error) {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  console.error(error);
  process.exit(1);
}
