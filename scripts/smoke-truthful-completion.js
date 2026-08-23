#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-truthful-completion-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, "home");

function assistant(content, toolCalls = []) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}

function reasoningOnly(reasoning, finishReason = "length") {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          role: "assistant",
          content: "",
          reasoning_content: reasoning,
        },
      },
    ],
  };
}

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function scriptedClient(responses, calls) {
  return {
    chat: {
      completions: {
        create: async (payload) => {
          calls.push(payload);
          const response = responses.shift();
          assert(response, `Unexpected model call ${calls.length}.`);
          return response;
        },
      },
    },
  };
}

async function runCase({
  id,
  goal,
  taskProfile = "auto",
  responses,
  allowShellTool = false,
  allowFileTools = false,
  executionTier = "",
  resume = false,
  setup = null,
  scsActive = false,
}) {
  const workspace = path.join(tempRoot, "workspaces", id);
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  await fs.mkdir(workspace, { recursive: true });
  if (typeof setup === "function") await setup(workspace);
  const calls = [];
  const client = scriptedClient([...responses], calls);
  const config = resolveRuntimeConfig(
    {
      provider: "openai",
      routingMode: "manual",
      model: "scripted-model",
      goal,
      taskProfile,
      executionTier,
      allowShellTool,
      allowFileTools,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: scsActive ? "auto" : "off",
      commandCwd: workspace,
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      provider: "openai",
      routingMode: "manual",
      model: "scripted-model",
      executionTier,
      sessionId: id,
      resume: resume ? id : "",
      commandCwd: workspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      allowShellTool,
      allowFileTools,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: scsActive ? "auto" : "off",
      clientFactory: async () => client,
    }
  );
  Object.assign(config, {
    apiKey: "scripted-test-only",
    resume: resume ? id : "",
    clientFactory: async () => client,
    sessionsDir,
    projectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    allowShellTool,
    allowFileTools,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    scsActive,
    enableScs: scsActive ? "auto" : "off",
    executionPolicy: scsActive
      ? { tier: "focused", requiresPlan: false, reason: "Scripted SCS completion regression." }
      : undefined,
    modelTimeoutMs: 1_000,
    ...(executionTier ? { executionTier, executionPolicy: { tier: executionTier, requiresPlan: false, reason: "Scripted completion smoke." } } : {}),
  });
  const result = await runAgent(config);
  const store = new SessionStore(sessionsDir, id, { projectRoot: workspace, commandCwd: workspace, projectSessionsDir });
  return {
    result,
    calls,
    events: await store.loadEvents(),
    state: await store.loadState(),
  };
}

try {
  const explanation = await runCase({
    id: "ordinary-explanation",
    goal: "Explain why recursion needs a base case.",
    responses: [assistant("A base case stops recursive calls and lets the stack unwind.")],
  });
  assert.equal(explanation.calls.length, 1);
  assert.equal(explanation.result.stopped, undefined);
  assert.match(explanation.result.result, /stops recursive calls/i);
  assert(explanation.events.some((event) => event.type === "session.finished"));
  assert(!explanation.events.some((event) => event.type === "completion.evidence_rejected"));
  assert(
    String(explanation.state.messages.find((message) => message.role === "system")?.content || "").length < 10_000,
    "focused runtime prompt did not use progressive disclosure"
  );
  assert(
    Math.max(
      ...explanation.state.messages
        .filter((message) => /^Step \d+\/\d+ .*Latest runtime snapshot:/i.test(String(message.content || "")))
        .map((message) => String(message.content || "").length)
    ) < 2_000,
    "focused runtime snapshot repeated the full capability manual"
  );

  // Recreate a state written by the older continuation classifier: the
  // expanded continuation was incorrectly persisted as the durable task.
  // A later generic resume must still recover the original material request.
  {
    const workspace = path.join(tempRoot, "workspaces", "ordinary-explanation");
    const store = new SessionStore(path.join(tempRoot, "sessions"), "ordinary-explanation", {
      projectRoot: workspace,
      commandCwd: workspace,
      projectSessionsDir: path.join(workspace, ".aginti-sessions"),
    });
    const stale = await store.loadState();
    const expandedContinuation =
      "Please continue and finish the same task from retained state. Repair the canonical project in place, follow every documented requirement, verify every deliverable, and leave the folder tidy.";
    stale.goal = expandedContinuation;
    stale.meta.goalContract.taskGoal = expandedContinuation;
    stale.meta.goalContract.history.push({
      revision: stale.meta.goalContract.revision + 1,
      kind: "continuation",
      relation: "new-request",
      preview: expandedContinuation,
    });
    await store.saveState(stale);
  }

  const sameTaskContinuation = await runCase({
    id: "ordinary-explanation",
    goal: "Please continue and finish the same task from the retained state. Repair the canonical project in place, follow every documented requirement, verify every deliverable, and leave the folder tidy.",
    resume: true,
    responses: [assistant("A base case also defines the smallest directly solvable input.")],
  });
  const continuationEvent = [...sameTaskContinuation.events]
    .reverse()
    .find((event) => event.type === "conversation.continued");
  assert.equal(continuationEvent?.data?.preservesTaskBoundary, true);
  assert.equal(
    sameTaskContinuation.state.goal,
    "Explain why recursion needs a base case.",
    "a generic same-task resume replaced the authoritative task goal"
  );
  assert(
    sameTaskContinuation.state.messages.some(
      (message) =>
        message.role === "user" &&
        /^Continue the current task from saved state:/i.test(String(message.content || ""))
    ),
    "same-task resume used the new-request boundary marker"
  );

  const prefixedSameTaskContinuation = await runCase({
    id: "ordinary-explanation",
    goal: [
      "You have explicit trusted-host approval for this isolated fixture.",
      "Continue the same task from the current edits. Finish it with verified evidence.",
    ].join(" "),
    resume: true,
    responses: [assistant("A base case remains the condition that terminates recursive expansion.")],
  });
  const prefixedContinuationEvent = [...prefixedSameTaskContinuation.events]
    .reverse()
    .find((event) => event.type === "conversation.continued");
  assert.equal(
    prefixedContinuationEvent?.data?.preservesTaskBoundary,
    true,
    "a same-task continuation prefixed by a permission statement opened a new task boundary"
  );
  assert.equal(
    prefixedSameTaskContinuation.state.meta?.goalContract?.taskGoal,
    "Explain why recursion needs a base case.",
    "a prefixed same-task continuation replaced the durable task goal"
  );

  const quotedChatClassification = await runCase({
    id: "quoted-chat-classification",
    taskProfile: "chatops",
    goal: [
      "Context:",
      "- Message 1: Generate a new video from the supplied video, but do not publish.",
      "- Message 2: Return the generated MP4 to the same chat.",
      'Return exactly one JSON object and no prose: {"intent":"generation_only","publish":false}.',
    ].join("\n"),
    responses: [assistant('{"intent":"generation_only","publish":false}')],
  });
  assert.equal(quotedChatClassification.calls.length, 1);
  assert.equal(quotedChatClassification.result.stopped, undefined);
  assert.equal(quotedChatClassification.result.result, '{"intent":"generation_only","publish":false}');
  assert(!quotedChatClassification.events.some((event) => event.type === "completion.evidence_rejected"));

  const proseOnlyAction = await runCase({
    id: "prose-only-action",
    goal: "Run pwd and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("The command would print the working directory."),
      assistant("Here is the command instead: pwd"),
    ],
  });
  assert.equal(proseOnlyAction.calls.length, 2);
  assert.equal(proseOnlyAction.result.stopped, true);
  assert.equal(proseOnlyAction.result.reason, "model_did_not_execute");
  assert.equal(proseOnlyAction.events.filter((event) => event.type === "completion.repair_requested").length, 1);
  assert.equal(proseOnlyAction.events.filter((event) => event.type === "completion.evidence_rejected").length, 2);
  assert(!proseOnlyAction.events.some((event) => event.type === "session.finished"));

  const permissionPause = await runCase({
    id: "permission-pause",
    goal: "Run the checked-in project test script and report its verified result.",
    taskProfile: "java",
    allowShellTool: true,
    scsActive: true,
    setup: async (workspace) => {
      await fs.mkdir(path.join(workspace, "scripts"), { recursive: true });
      await fs.writeFile(path.join(workspace, "scripts", "test.sh"), "#!/usr/bin/env bash\necho pass\n", "utf8");
    },
    responses: [
      assistant("", [toolCall("permission-test", "run_command", { command: "bash scripts/test.sh" })]),
    ],
  });
  assert.equal(permissionPause.calls.length, 1, "permission blocker consumed another model turn");
  assert.equal(permissionPause.result.stopped, true);
  assert.equal(permissionPause.result.reason, "permission_required");
  assert(permissionPause.result.permissionAdvice?.suggestedCommand, "permission pause lost its exact resume command");
  assert.equal(
    permissionPause.events.filter((event) => event.type === "session.stopped" && event.data?.reason === "permission_required").length,
    1,
    "permission blocker did not persist exactly one paused state"
  );
  assert(
    !permissionPause.events.some((event) =>
      ["scs.student.rethink_plan", "scs.student.reject_phase", "scs.committee.replan_drafted"].includes(event.type)
    ),
    "permission blocker triggered an SCS replan instead of waiting for approval"
  );

  const reasoningTruncation = await runCase({
    id: "reasoning-only-tool-continuation",
    goal: "Run pwd and report the verified working directory.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      reasoningOnly("The next concrete action is to run pwd with the shell tool."),
      assistant("", [toolCall("reasoning-run", "run_command", { command: "pwd" })]),
      assistant("", [toolCall("reasoning-finish", "finish", { result: "Ran pwd and verified the working directory." })]),
    ],
  });
  assert.equal(reasoningTruncation.calls.length, 3);
  assert.equal(reasoningTruncation.result.stopped, undefined);
  assert.equal(
    reasoningTruncation.events.filter((event) => event.type === "model.reasoning_continuation_requested").length,
    1
  );
  assert.equal(
    reasoningTruncation.events.filter((event) => event.type === "completion.evidence_rejected").length,
    0,
    "reasoning-only truncation was treated as a completion claim"
  );
  assert.equal(
    reasoningTruncation.calls[1].tool_choice,
    "required",
    "reasoning-only continuation did not require one native tool call"
  );
  assert(
    reasoningTruncation.calls[1].messages.some(
      (message) => /exactly one enabled tool call/i.test(String(message.content || ""))
    ),
    "reasoning-only continuation instruction was not retained in the next request"
  );

  const resumedAfterRejectedCompletion = await runCase({
    id: "prose-only-action",
    goal: "Please continue and finish the same task from the retained state.",
    taskProfile: "shell",
    allowShellTool: true,
    resume: true,
    responses: [
      assistant("I will run the command and verify it next."),
      assistant("", [toolCall("resume-run", "run_command", { command: "pwd" })]),
      assistant("", [toolCall("resume-finish", "finish", { result: "Ran pwd and verified the working directory." })]),
    ],
  });
  assert.equal(resumedAfterRejectedCompletion.calls.length, 3);
  assert.equal(resumedAfterRejectedCompletion.result.stopped, undefined);
  assert.match(resumedAfterRejectedCompletion.result.result, /verified the working directory/i);

  const falseFinish = await runCase({
    id: "false-finish-tool",
    goal: "Run printf 4 and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("finish-1", "finish", { result: "The output was 4." })]),
      assistant("", [toolCall("finish-2", "finish", { result: "Done." })]),
    ],
  });
  assert.equal(falseFinish.calls.length, 2);
  assert.equal(falseFinish.result.reason, "model_did_not_execute");
  assert(!falseFinish.events.some((event) => event.type === "session.finished"));

  const scsApprovalNarrative = await runCase({
    id: "scs-approval-narrative",
    goal: "Repair analysis.py in place and run the documented verification command.",
    taskProfile: "shell",
    allowShellTool: true,
    scsActive: true,
    responses: [
      assistant("I must ask for approval before replacing the file. Do you approve? Reply yes to proceed."),
      assistant("After approval, I will rewrite the file and run the verification command."),
    ],
  });
  assert.equal(scsApprovalNarrative.calls.length, 2);
  assert.equal(scsApprovalNarrative.result.stopped, true);
  assert.equal(scsApprovalNarrative.result.reason, "model_did_not_execute");
  assert.equal(
    scsApprovalNarrative.events.filter((event) => event.type === "completion.evidence_rejected").length,
    2
  );
  assert(!scsApprovalNarrative.events.some((event) => event.type === "session.finished"));

  const scsUnsupportedNarrative = await runCase({
    id: "scs-unsupported-success-narrative",
    goal: "Run pwd and report the verified working directory.",
    taskProfile: "shell",
    allowShellTool: true,
    scsActive: true,
    responses: [
      assistant("The task is complete and the working directory is correct."),
      assistant("Completed successfully with all requested checks."),
    ],
  });
  assert.equal(scsUnsupportedNarrative.result.stopped, true);
  assert.equal(scsUnsupportedNarrative.result.reason, "model_did_not_execute");
  assert.equal(
    scsUnsupportedNarrative.events.filter((event) => event.type === "completion.evidence_rejected").length,
    2
  );
  assert(!scsUnsupportedNarrative.events.some((event) => event.type === "session.finished"));

  const approvalNarrativeWithBlockerEvidence = await runCase({
    id: "approval-narrative-with-blocker-evidence",
    goal: "Run which definitely_missing_aginti_command and report the result.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [
        toolCall("missing-command", "run_command", { command: "which definitely_missing_aginti_command" }),
      ]),
      assistant("The command is unavailable. Approve installing it and I will continue after approval."),
      assistant("Unable to execute the requested command because it is not installed in this environment."),
    ],
  });
  assert.equal(approvalNarrativeWithBlockerEvidence.calls.length, 3);
  assert.match(approvalNarrativeWithBlockerEvidence.result.result, /not installed/i);
  assert(
    approvalNarrativeWithBlockerEvidence.events.some(
      (event) => event.type === "completion.evidence_rejected"
    ),
    "an approval narrative overrode existing blocker evidence"
  );

  const futureWorkFinish = await runCase({
    id: "future-work-finish",
    goal: "Execute the shell command pwd and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [
        toolCall("finish-future", "finish", {
          result: "The task is paused. The command will be run and verified next.",
        }),
      ]),
      assistant("", [toolCall("run-after-reject", "run_command", { command: "pwd" })]),
      assistant("", [
        toolCall("finish-after-proof", "finish", { result: "Ran pwd and verified the working directory." }),
      ]),
    ],
  });
  assert.equal(futureWorkFinish.calls.length, 3);
  assert.equal(futureWorkFinish.result.stopped, undefined);
  assert.match(futureWorkFinish.result.result, /verified the working directory/i);
  assert(futureWorkFinish.events.some((event) => event.type === "completion.evidence_rejected"));

  const verifiedAction = await runCase({
    id: "verified-action",
    goal: "Execute the shell command pwd and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("run-1", "run_command", { command: "pwd" })]),
      assistant("", [toolCall("finish-verified", "finish", { result: "Verified the current working directory with pwd." })]),
    ],
  });
  assert.equal(verifiedAction.calls.length, 2);
  assert.equal(verifiedAction.result.stopped, undefined);
  assert.match(verifiedAction.result.result, /working directory/i);
  assert(verifiedAction.events.some((event) => event.type === "tool.completed" && event.data?.toolName === "run_command"));
  assert(verifiedAction.events.some((event) => event.type === "session.finished"));
  assert(!verifiedAction.events.some((event) => event.type === "completion.repair_requested"));

  const sourceChangeRequiresFreshTests = await runCase({
    id: "source-change-requires-fresh-tests",
    goal: "Repair this Python project and verify the result.",
    taskProfile: "python",
    allowShellTool: true,
    allowFileTools: true,
    executionTier: "focused",
    setup: async (workspace) => {
      await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
      await fs.writeFile(path.join(workspace, "analysis.py"), "VALUE = 1\n", "utf8");
      await fs.writeFile(
        path.join(workspace, "tests", "test_analysis.py"),
        [
          "import unittest",
          "import analysis",
          "",
          "class AnalysisTests(unittest.TestCase):",
          "    def test_value(self):",
          "        self.assertEqual(analysis.VALUE, 2)",
          "",
          "if __name__ == '__main__':",
          "    unittest.main()",
          "",
        ].join("\n"),
        "utf8"
      );
    },
    responses: [
      assistant("", [toolCall("inspect-source-tests", "inspect_project", { path: "." })]),
      assistant("", [
        toolCall("patch-source", "apply_patch", {
          path: "analysis.py",
          search: "VALUE = 1",
          replace: "VALUE = 2",
        }),
      ]),
      assistant("", [toolCall("run-not-test", "run_command", { command: "python analysis.py" })]),
      assistant("", [toolCall("finish-before-test", "finish", { result: "The repair is verified." })]),
      assistant("", [
        toolCall("run-tests", "run_command", { command: "python -m unittest discover -s tests" }),
      ]),
      assistant("", [toolCall("finish-after-test", "finish", { result: "The repair and focused tests passed." })]),
    ],
  });
  assert.equal(
    sourceChangeRequiresFreshTests.calls.length,
    6,
    JSON.stringify(
      sourceChangeRequiresFreshTests.events.map((event) => ({
        type: event.type,
        toolName: event.data?.toolName || "",
        path: event.data?.path || "",
        testFiles: event.data?.testFiles || [],
        command: event.data?.args?.command || "",
      }))
    )
  );
  assert.equal(
    sourceChangeRequiresFreshTests.result.stopped,
    undefined,
    JSON.stringify({
      result: sourceChangeRequiresFreshTests.result,
      events: sourceChangeRequiresFreshTests.events
        .filter((event) => ["tool.completed", "tool.failed", "tool.blocked", "completion.evidence_rejected"].includes(event.type))
        .map((event) => ({
          type: event.type,
          toolName: event.data?.toolName || "",
          command: event.data?.args?.command || "",
          exitCode: event.data?.exitCode,
          reason: event.data?.reason || "",
          error: event.data?.error || "",
        })),
    })
  );
  assert.match(sourceChangeRequiresFreshTests.result.result, /focused tests passed/i);
  assert.equal(
    sourceChangeRequiresFreshTests.events.filter((event) => event.type === "completion.evidence_rejected").length,
    1
  );
  assert(
    sourceChangeRequiresFreshTests.events.some(
      (event) =>
        event.type === "completion.evidence_rejected" &&
        /no relevant test command succeeded/i.test(String(event.data?.reason || ""))
    ),
    "source-changing completion was not rejected before a fresh test run"
  );
  assert(
    sourceChangeRequiresFreshTests.events.some(
      (event) =>
        event.type === "tool.completed" &&
        event.data?.toolName === "run_command" &&
        event.data?.args?.command === "python -m unittest discover -s tests" &&
        event.data?.exitCode === 0
    ),
    "fresh project test command did not pass"
  );
  assert(sourceChangeRequiresFreshTests.events.some((event) => event.type === "session.finished"));

  const failedValidationCanBeRepaired = await runCase({
    id: "failed-validation-can-be-repaired",
    goal: "Repair this Python project and verify the result.",
    taskProfile: "python",
    allowShellTool: true,
    allowFileTools: true,
    executionTier: "focused",
    setup: async (workspace) => {
      await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
      await fs.writeFile(path.join(workspace, "analysis.py"), "VALUE = 1\n", "utf8");
      await fs.writeFile(
        path.join(workspace, "tests", "test_analysis.py"),
        [
          "import unittest",
          "import analysis",
          "",
          "class AnalysisTests(unittest.TestCase):",
          "    def test_value(self):",
          "        self.assertEqual(analysis.VALUE, 3)",
          "",
          "if __name__ == '__main__':",
          "    unittest.main()",
          "",
        ].join("\n"),
        "utf8"
      );
    },
    responses: [
      assistant("", [toolCall("inspect-repair-tests", "inspect_project", { path: "." })]),
      assistant("", [
        toolCall("patch-wrong-value", "apply_patch", {
          path: "analysis.py",
          search: "VALUE = 1",
          replace: "VALUE = 20",
        }),
      ]),
      assistant("", [toolCall("finish-without-tests", "finish", { result: "The repair is verified." })]),
      assistant("", [
        toolCall("run-failing-tests", "run_command", { command: "python -m unittest discover -s tests" }),
      ]),
      assistant("", [toolCall("finish-after-failed-tests", "finish", { result: "The repair is verified." })]),
      assistant("", [
        toolCall("patch-correct-value", "apply_patch", {
          path: "analysis.py",
          search: "VALUE = 20",
          replace: "VALUE = 3",
        }),
      ]),
      assistant("", [
        toolCall("run-passing-tests", "run_command", { command: "python -m unittest discover -s tests" }),
      ]),
      assistant("", [toolCall("finish-after-repair", "finish", { result: "The repair and focused tests passed." })]),
    ],
  });
  assert.equal(
    failedValidationCanBeRepaired.calls.length,
    8,
    JSON.stringify(
      failedValidationCanBeRepaired.events
        .filter((event) =>
          ["tool.completed", "tool.failed", "tool.blocked", "completion.evidence_rejected", "completion.repair_requested"].includes(
            event.type
          )
        )
        .map((event) => ({
          type: event.type,
          toolName: event.data?.toolName || "",
          command: event.data?.args?.command || "",
          exitCode: event.data?.exitCode,
          reason: event.data?.reason || "",
          repairAttempt: event.data?.repairAttempt,
          progressCount: event.data?.progressCount,
        }))
    )
  );
  assert.equal(failedValidationCanBeRepaired.result.stopped, undefined);
  assert.match(failedValidationCanBeRepaired.result.result, /focused tests passed/i);
  assert.equal(
    failedValidationCanBeRepaired.events.filter((event) => event.type === "completion.evidence_rejected").length,
    2
  );
  assert.equal(
    failedValidationCanBeRepaired.events.filter((event) => event.type === "completion.repair_requested").length,
    2
  );
  assert(
    failedValidationCanBeRepaired.events.some(
      (event) =>
        event.type === "tool.completed" &&
        event.data?.args?.command === "python -m unittest discover -s tests" &&
        event.data?.exitCode === 1
    ),
    "failing validation evidence was not preserved for another repair turn"
  );
  assert(
    failedValidationCanBeRepaired.events.some(
      (event) =>
        event.type === "tool.completed" &&
        event.data?.args?.command === "python -m unittest discover -s tests" &&
        event.data?.exitCode === 0
    ),
    "repaired project tests did not pass"
  );
  assert(failedValidationCanBeRepaired.events.some((event) => event.type === "session.finished"));

  const verifiedEmptyCompletion = await runCase({
    id: "verified-empty-completion",
    goal: "Execute the shell command pwd and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("run-empty", "run_command", { command: "pwd" })]),
      assistant(""),
      assistant(""),
    ],
  });
  assert.equal(verifiedEmptyCompletion.calls.length, 3);
  assert.equal(verifiedEmptyCompletion.result.stopped, undefined);
  assert.match(verifiedEmptyCompletion.result.result, /verified.*runtime evidence/i);
  assert.equal(
    verifiedEmptyCompletion.events.filter((event) => event.type === "completion.empty_response_repair_requested").length,
    1
  );
  assert.equal(
    verifiedEmptyCompletion.events.filter((event) => event.type === "completion.verified_fallback").length,
    1
  );
  assert(!verifiedEmptyCompletion.result.result.includes("No tool call returned"));

  const unusableEmptyChat = await runCase({
    id: "unusable-empty-chat",
    goal: "Explain why recursion needs a base case.",
    responses: [assistant(""), assistant("")],
  });
  assert.equal(unusableEmptyChat.calls.length, 2);
  assert.equal(unusableEmptyChat.result.stopped, true);
  assert.equal(unusableEmptyChat.result.reason, "empty_model_response");
  assert.equal(
    unusableEmptyChat.events.filter((event) => event.type === "completion.empty_response_repair_requested").length,
    1
  );
  assert(!unusableEmptyChat.events.some((event) => event.type === "session.finished"));
  assert(!unusableEmptyChat.result.result.includes("No tool call returned"));

  const resumedAction = await runCase({
    id: "verified-action",
    goal: "Run printf 4 and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    resume: true,
    responses: [
      assistant("The command would print 4."),
      assistant("Here is the command instead: printf 4"),
    ],
  });
  assert.equal(resumedAction.calls.length, 2, "stale command evidence prevented the continuation repair request");
  assert.equal(resumedAction.result.stopped, true, "stale command evidence satisfied a different continuation goal");
  assert.equal(resumedAction.result.reason, "model_did_not_execute");
  assert.equal(
    resumedAction.events.filter((event) => event.type === "completion.repair_requested").length,
    1,
    "the new continuation did not get its own bounded evidence repair"
  );

  const verifiedBlocker = await runCase({
    id: "verified-blocker",
    goal: "Run which definitely_not_an_aginti_command and report the result.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("run-blocked", "run_command", { command: "which definitely_not_an_aginti_command" })]),
      assistant("", [
        toolCall("finish-blocked", "finish", {
          result: "Unable to execute the requested command because it is not installed in this environment.",
        }),
      ]),
    ],
  });
  assert.equal(verifiedBlocker.calls.length, 2);
  assert.equal(verifiedBlocker.result.stopped, undefined);
  assert.match(verifiedBlocker.result.result, /not installed/i);
  assert(verifiedBlocker.events.some((event) => event.type === "session.finished"));
  assert(!verifiedBlocker.events.some((event) => event.type === "completion.repair_requested"));

  console.log("smoke-truthful-completion ok");
} finally {
  if (process.env.AGINTI_KEEP_SMOKE_TEMP === "1") {
    console.error(`Preserved smoke workspace: ${tempRoot}`);
  } else {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
