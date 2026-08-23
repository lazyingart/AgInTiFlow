#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
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
  artifactValidationAcceptanceIsCurrent,
  artifactValidationFinishBlock,
  artifactValidationScopeBlock,
  canonicalizeVerifiedArtifactCompletion,
  completedDeepResearchReuse,
  completionEvidenceNeedsCommand,
  enqueueFailedTestRepairInstruction,
  isSubstantiveTestCommand,
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
  trimCommandOutput,
} from "../src/agent-runner.js";
import {
  augmentScsTaskContractWithProjectVerification,
  buildScsEvidenceLedger,
  deriveScsTaskContract,
  evaluateScsEvidence,
  inferGitActionsFromCommand,
  inferSuccessfulGitActionsFromCommandResult,
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
