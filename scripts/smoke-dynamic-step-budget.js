#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { RESEARCH_VERSION } from "../src/deep-research.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { classifyCommand, evaluateCommandPolicy } from "../src/command-policy.js";
import {
  browserSubmitFinishIssue,
  isRecoverableShellToolResult,
  isSuspiciousBroadBrowserToolResult,
  shouldActivateScs,
  shouldReviewToolResult,
} from "../src/scs-controller.js";
import {
  announceConvergenceOutputPhase,
  applyContinuationContractTransition,
  artifactValidationAcceptanceIsCurrent,
  artifactValidationFinishBlock,
  artifactValidationScopeBlock,
  buildConstrainedRecoveryRequest,
  buildFailedTestRecoveryPacket,
  buildTaskOwnedCommitCommand,
  canonicalizeVerifiedArtifactCompletion,
  completedDeepResearchReuse,
  completionEvidenceNeedsCommand,
  compactFailedTestEvidence,
  enqueueFailedTestRepairInstruction,
  failedTestRequiresCleanRepositoryState,
  failedTestRepairPatchBlock,
  failedTestAliasedIndexComparisons,
  failedTestIndexComparisons,
  failedTestLiteralOperands,
  failedTestMembershipPredicates,
  failedTestMockBehaviorContract,
  isCompletedContinuationNoop,
  isSubstantiveTestCommand,
  mergeDurableGitEvidence,
  nextStepRuntimeConfig,
  projectAcceptanceFromMarkdown,
  projectTestVerificationFinishBlock,
  pythonTopLevelDefinitionDuplicates,
  recordCanonicalGeneratedOutputProgress,
  recordProjectVerificationOutcome,
  recordExactOutputProgress,
  recordStaticDiscoveryProgress,
  resetGoalScopedRuntimeState,
  resetSameTaskExecutionContract,
  resetStaticDiscoveryAfterContextLoss,
  shellDiagnosticHint,
  rememberCompletedDeepResearch,
  unchangedFailedTestRerunBlock,
  repeatedNoProgressToolBlock,
  regressiveInversePatchBlock,
  repeatedSuccessfulMutationBlock,
  repeatedStaticToolBlock,
  reopenedArtifactRepairPending,
  shouldResetStaticDiscoveryPhase,
  trimCommandOutput,
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
    "a failed shell command that could already have edited files preserved stale verification"
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
    bareContinuationState.meta.goalContract.activeGoalRevision === 4,
    "a bare resume fabricated a new active-goal revision"
  );

  const isolatedRefreshState = {
    plan: "old plan",
    meta: {
      goalContract: { revision: 8 },
      artifactProgress: {},
      scs: {},
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
    !failedTestRequiresCleanRepositoryState({
      failureSummary: "The generated prose says the repository worktree is not clean.",
    }),
    "plain task prose was mistaken for a repository-state gate without Git-status evidence"
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
      verifiedCompletionRequest?.maxOutputTokens === 768,
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
    packetVersion: 8,
    content: "Bounded failed-test evidence packet v8.",
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
        packetVersion: 8,
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
  ]) {
    const requestedCommand = goal.match(/`([^`]+)`/)?.[1] || "";
    assert(
      JSON.stringify(deriveScsTaskContract({ goal, taskProfile: "code" }).requiredProjectCommands) ===
        JSON.stringify([requestedCommand]),
      `normal punctuation hid an explicitly requested inline command: ${goal}`
    );
  }
  for (const goal of [
    "Document how to run `npm test`.",
    "Explain the `python demo.py` command.",
    "Do not run `python mutate.py`.",
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

  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log("smoke-dynamic-step-budget ok");
} catch (error) {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  console.error(error);
  process.exit(1);
}
