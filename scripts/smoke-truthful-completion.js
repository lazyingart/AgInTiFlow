#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  continuationExecutionContractDirective,
  removeSupersededCompletionRepairInstructions,
  runAgent,
} from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";
import { deriveScsTaskContract, finishResultClaimsIncompleteWork } from "../src/scs-evidence.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-truthful-completion-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, "home");

assert.equal(
  finishResultClaimsIncompleteWork(
    "The report is complete and the verification that was previously paused now passes. No work remains."
  ),
  false,
  "historical paused wording was mistaken for current unfinished work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The earlier step was paused, but the report is complete and verified now."
  ),
  false,
  "resolved historical pause was mistaken for current unfinished work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The bounded verification (the previously-paused step) passed, and the audit is complete."
  ),
  false,
  "a hyphenated resolved historical pause was mistaken for current unfinished work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The earlier step was paused and the report is still incomplete."
  ),
  true,
  "historical-pause normalization hid genuinely incomplete current work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The earlier report was complete, but the current task is unfinished."
  ),
  true,
  "historical wording hid an unrelated current unfinished task"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The verifier passed, git status confirms no pending changes, and no further action is needed."
  ),
  false,
  "a clean completed repository was mistaken for pending work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The verifier passed, git status confirms no pending changes, and there is no need for further action."
  ),
  false,
  "a no-further-action completion statement was mistaken for future work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "Read-only check done, nothing sent or changed. Still retrying: nightly_pdf (quality_retry_pending; next attempt at 10:14). Queues are otherwise healthy."
  ),
  false,
  "external retry status in a read-only answer was mistaken for unfinished agent work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "Schedule status: memo delivered, export retry pending, next attempt tomorrow. This is only a status report."
  ),
  false,
  "external pending status in a read-only answer was mistaken for unfinished agent work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The current report is pending and I will finish it next."
  ),
  true,
  "agent-owned pending report work was accepted as a completed result"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "Pending validation remains before this task is complete."
  ),
  true,
  "agent-owned pending validation was accepted as a completed result"
);

const staleCompletionRepair =
  "The proposed completion was rejected because the requested action is not supported by concrete runtime evidence. Reason: Missing required git action(s): commit.";
const repairCleanup = removeSupersededCompletionRepairInstructions([
  { role: "assistant", content: "The project validator passed." },
  { role: "user", content: staleCompletionRepair },
  { role: "user", content: "A genuine later user message." },
]);
assert.equal(repairCleanup.removed, 1);
assert.deepEqual(
  repairCleanup.messages.map((message) => message.content),
  ["The project validator passed.", "A genuine later user message."],
  "continuation cleanup removed genuine conversation instead of only turn-scoped runtime repair text"
);
const conditionalCommitDirective = continuationExecutionContractDirective(
  {
    goal: "Continue the task.",
    meta: {
      taskProfile: "cad",
      goalContract: {
        revision: 9,
        activeGoal: "Finish the task and commit task-owned changes if any remain.",
      },
    },
  },
  { taskProfile: "cad" },
  { supersededCompletionRepair: true }
);
assert.match(conditionalCommitDirective, /required Git actions = none/i);
assert.match(conditionalCommitDirective, /Do not manufacture a file edit, empty\/no-op commit/i);
const mandatoryCommitDirective = continuationExecutionContractDirective(
  {
    meta: {
      taskProfile: "code",
      goalContract: {
        revision: 10,
        activeGoal: "Commit the tested changes and push the branch.",
      },
    },
  },
  { taskProfile: "code" },
  { supersededCompletionRepair: true }
);
assert.match(mandatoryCommitDirective, /required Git actions = commit, push/i);

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
  provider = "openai",
  model = "scripted-model",
  routingMode = "manual",
  responses,
  allowShellTool = false,
  allowFileTools = false,
  allowDestructive = false,
  executionTier = "",
  maxOutputTokens = undefined,
  resume = false,
  runtimePatch = undefined,
  expectedRuntimeRevision = undefined,
  providerReadinessMode = undefined,
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
  const factoryConfigs = [];
  const clientFactory = async (runtimeConfig = {}) => {
    factoryConfigs.push({
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
    });
    return client;
  };
  clientFactory.agintiDeterministicTest = true;
  const config = resolveRuntimeConfig(
    {
      provider,
      routingMode,
      model,
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
      provider,
      routingMode,
      model,
      executionTier,
      sessionId: id,
      resume: resume ? id : "",
      commandCwd: workspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      allowDestructive,
      allowShellTool,
      allowFileTools,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: scsActive ? "auto" : "off",
      clientFactory,
    }
  );
  Object.assign(config, {
    apiKey: "scripted-test-only",
    resume: resume ? id : "",
    clientFactory,
    sessionsDir,
    projectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    allowDestructive,
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
    ...(providerReadinessMode ? { providerReadinessMode } : {}),
    ...(runtimePatch ? { runtimePatch } : {}),
    ...(expectedRuntimeRevision !== undefined ? { expectedRuntimeRevision } : {}),
  });
  const result = await runAgent(config);
  const store = new SessionStore(sessionsDir, id, { projectRoot: workspace, commandCwd: workspace, projectSessionsDir });
  return {
    result,
    calls,
    factoryConfigs,
    events: await store.loadEvents(),
    state: await store.loadState(),
  };
}

function providerRuntimePatch(provider, model) {
  return {
    provider,
    model,
    routingMode: "manual",
    routeProvider: provider,
    routeModel: model,
    mainProvider: provider,
    mainModel: model,
    spareProvider: provider,
    spareModel: model,
  };
}

function scopedTaskGoal(request, artifactRoot) {
  return [
    "User request:",
    request,
    "",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "task",
      request,
      artifact_root: artifactRoot,
    })}`,
    "",
    "Artifact contract:",
    "- If no file is produced, use an empty artifacts list.",
  ].join("\n");
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
  assert.match(
    String(explanation.state.messages.find((message) => message.role === "system")?.content || ""),
    /run that command unchanged before probing --help, alternate wrappers/i,
    "focused runtime did not prioritize exact established routine commands"
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

  const providerSwitchSessionId = "provider-switch-resume-contract";
  const providerSwitchFirstTurn = await runCase({
    id: providerSwitchSessionId,
    goal: "Create provider-switch-proof.md with the exact text provider switch proof.",
    taskProfile: "auto",
    provider: "localllm",
    model: "localllm-fast",
    providerReadinessMode: "deterministic-test",
    allowFileTools: true,
    responses: [
      assistant("", [
        toolCall("write-provider-switch-proof", "write_file", {
          path: "provider-switch-proof.md",
          mode: "create",
          content: "provider switch proof\n",
        }),
      ]),
      assistant("", [
        toolCall("finish-provider-switch-proof", "finish", {
          result: "Created provider-switch-proof.md.",
        }),
      ]),
    ],
  });
  assert.equal(providerSwitchFirstTurn.result.stopped, undefined);
  assert.equal(providerSwitchFirstTurn.state.meta?.runtimeConfig?.provider, "localllm");
  assert.equal(providerSwitchFirstTurn.state.meta?.runtimeConfig?.model, "localllm-fast");

  const providerSwitchSecondTurn = await runCase({
    id: providerSwitchSessionId,
    goal: "Resume this exact session with the default provider and return exactly: DEEPSEEK_RESUME_OK",
    taskProfile: "auto",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    resume: true,
    runtimePatch: providerRuntimePatch("deepseek", "deepseek-v4-flash"),
    expectedRuntimeRevision: providerSwitchFirstTurn.state.meta.runtimeConfig.revision,
    responses: [
      assistant("", [
        toolCall("finish-provider-switch-deepseek", "finish", {
          result: "DEEPSEEK_RESUME_OK",
        }),
      ]),
    ],
  });
  assert.equal(providerSwitchSecondTurn.result.stopped, undefined);
  assert.equal(providerSwitchSecondTurn.result.result, "DEEPSEEK_RESUME_OK");
  assert.equal(providerSwitchSecondTurn.state.meta?.runtimeConfig?.provider, "deepseek");
  assert.equal(providerSwitchSecondTurn.state.meta?.runtimeConfig?.model, "deepseek-v4-flash");
  assert.equal(
    providerSwitchSecondTurn.events.filter(
      (event) => event.type === "session.runtime_resolved" && event.data?.provider === "deepseek"
    ).length,
    1,
    "explicit DeepSeek resume did not persist a provider switch"
  );

  const forcedLocalRequest =
    "Resume this exact session and return exactly: LOCALLLM_FORCED_RESUME_OK Do not create or modify any file.";
  const forcedLocalGoal = scopedTaskGoal(
    forcedLocalRequest,
    path.join(tempRoot, "artifacts", "provider-switch-resume-contract")
  );
  const forcedLocalContract = deriveScsTaskContract({ goal: forcedLocalGoal, taskProfile: "auto" });
  assert.equal(
    forcedLocalContract.requiresExternalEvidence,
    false,
    "a forbidden file-mutation clause made a pure response-only resume require external evidence"
  );
  assert.deepEqual(forcedLocalContract.requiredEvidence, []);
  assert.deepEqual(forcedLocalContract.exactOutputPaths, []);
  assert(
    forcedLocalContract.forbiddenActions.some((item) => /create or modify any file/i.test(item)),
    "forbidden file mutation was not retained as a guardrail"
  );

  const forcedLocalResume = await runCase({
    id: providerSwitchSessionId,
    goal: forcedLocalGoal,
    taskProfile: "auto",
    provider: "localllm",
    model: "localllm-fast",
    providerReadinessMode: "deterministic-test",
    resume: true,
    runtimePatch: providerRuntimePatch("localllm", "localllm-fast"),
    expectedRuntimeRevision: providerSwitchSecondTurn.state.meta.runtimeConfig.revision,
    responses: [
      assistant("", [
        toolCall("finish-provider-switch-localllm", "finish", {
          result: "LOCALLLM_FORCED_RESUME_OK",
        }),
      ]),
    ],
  });
  assert.equal(forcedLocalResume.result.stopped, undefined);
  assert.equal(forcedLocalResume.result.result, "LOCALLLM_FORCED_RESUME_OK");
  assert.equal(forcedLocalResume.calls.length, 1);
  assert.deepEqual(forcedLocalResume.factoryConfigs, [{ provider: "localllm", model: "localllm-fast" }]);
  assert.equal(forcedLocalResume.state.meta?.runtimeConfig?.provider, "localllm");
  assert.equal(forcedLocalResume.state.meta?.runtimeConfig?.model, "localllm-fast");
  assert.equal(
    forcedLocalResume.events.filter(
      (event) =>
        event.type === "session.runtime_resolved" &&
        event.data?.provider === "localllm" &&
        event.data?.model === "localllm-fast"
    ).length,
    1,
    "explicit LocalLLM resume did not persist the forced provider/model switch"
  );
  assert(
    !forcedLocalResume.events.some(
      (event) =>
        event.type === "completion.evidence_rejected" &&
        /ledger is empty/i.test(String(event.data?.reason || ""))
    ),
    "pure LocalLLM resume was rejected for missing external evidence"
  );

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

  const resumedAfterSupersededRepair = await runCase({
    id: "prose-only-action",
    goal: "Continue the current task from saved state. Do not repeat completed work.",
    taskProfile: "shell",
    allowShellTool: true,
    resume: true,
    responses: [
      assistant("I will run the command and verify it next."),
      assistant("", [toolCall("run-pwd-after-repair", "run_command", { command: "pwd" })]),
      assistant("", [toolCall("finish-pwd-after-repair", "finish", {
        result: "Verified the current working directory with pwd.",
      })]),
    ],
  });
  const resumedRepairPrompt = resumedAfterSupersededRepair.calls[0]?.messages || [];
  assert(
    resumedRepairPrompt.some(
      (message) =>
        message.role === "user" &&
        /Authoritative execution contract for goal revision/i.test(String(message.content || "")) &&
        /required Git actions = none/i.test(String(message.content || ""))
    ),
    "a resumed turn did not receive the authoritative replacement for its superseded repair contract"
  );
  assert(
    !resumedRepairPrompt.some(
      (message) => String(message.content || "").startsWith(staleCompletionRepair.split(" Reason:")[0])
    ),
    "the prior turn's generated completion-repair instruction leaked into the resumed model request"
  );
  assert.equal(
    resumedAfterSupersededRepair.calls.length,
    3,
    "a prose preamble incorrectly ended the resumed action before tool execution"
  );
  assert.equal(resumedAfterSupersededRepair.result.stopped, undefined);
  assert.match(resumedAfterSupersededRepair.result.result, /working directory/i);

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

  const readOnlyExternalRetryStatus = await runCase({
    id: "read-only-external-retry-status",
    goal: "Execute the shell command pwd and report the status without changing anything.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("external-status-proof", "run_command", { command: "pwd" })]),
      assistant("", [
        toolCall("finish-external-status", "finish", {
          result:
            "Read-only check done; nothing was sent or changed. Still retrying: nightly_pdf (quality_retry_pending; next attempt at 10:14). The requested command evidence is present.",
        }),
      ]),
    ],
  });
  assert.equal(readOnlyExternalRetryStatus.calls.length, 2);
  assert.equal(readOnlyExternalRetryStatus.result.stopped, undefined);
  assert.match(readOnlyExternalRetryStatus.result.result, /Still retrying: nightly_pdf/);
  assert(
    readOnlyExternalRetryStatus.events.some(
      (event) =>
        event.type === "completion.candidate_assessed" &&
        event.data?.claimsIncompleteWork === false
    ),
    "read-only external retry status was still marked claimsIncompleteWork=true"
  );
  assert(
    !readOnlyExternalRetryStatus.events.some(
      (event) => event.type === "completion.evidence_rejected"
    ),
    "read-only external retry status still triggered a completion repair"
  );

  const compactHealthCommand = "PYTHONPATH=src python -m agenticapp wechat health --compact --json";
  const compactHealthGoal = [
    "User request:",
    "i was checking phone and schedulr tell me which daily things actually got delivered today and which still retrying, also can msg from me and msg from other people both reach agent. dont send chat or change anything, just inspect and answer short with evidence",
    "",
    "Matched established routines",
    `- \`wechat-chatops\` ready=true; commands=[${JSON.stringify(compactHealthCommand)}, "python agentic_tools/wechat_gui_agent/scripts/wechat_android_ingress.py --status"]; outputs=["messages", "files", "task records"]; guidance=For a read-only phone, message-intake, queue, or schedule question, run the canonical compact health command first; it already includes both Android lanes. Use the raw Android status commands only when compact health marks a lane unknown or stale. Treat that current snapshot as authoritative and stop once it answers the request. Do not inspect raw chat text or private message ledgers or artifact directories, and do not send or mutate anything, unless the current request explicitly needs it.`,
  ].join("\n");
  const compactHealthFallback = await runCase({
    id: "read-only-compact-health-empty-finish-fallback",
    goal: compactHealthGoal,
    taskProfile: "chatops",
    allowShellTool: true,
    allowDestructive: true,
    maxOutputTokens: 768,
    setup: async (workspace) => {
      await fs.mkdir(path.join(workspace, "src", "agenticapp"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "agenticapp", "__init__.py"), "", "utf8");
      await fs.writeFile(
        path.join(workspace, "src", "agenticapp", "__main__.py"),
        [
          "import json",
          "payload = {",
          "  'ok': True,",
          "  'operational': True,",
          "  'degraded': True,",
          "  'issues': ['wechat_login_required'],",
          "  'phone_ingress': {",
          "    'other_people': {'ok': True, 'fresh': True, 'reaches_agent': True, 'routes': 6},",
          "    'self_authored': {'ok': True, 'fresh': True, 'reaches_agent': True, 'routes': 6, 'seeded_routes': 6},",
          "  },",
          "  'queues': {",
          "    'wechat': {'ok': True, 'pending': 0, 'active': 0, 'recent_failure_count': 0, 'stale_count': 0},",
          "    'wecom': {'ok': True, 'pending': 0, 'active': 0, 'recent_failure_count': 0, 'stale_count': 0},",
          "  },",
          "  'schedules': {",
          "    'career_daily': {'delivered': True, 'retry_pending': False, 'running': True, 'status': 'delivered'},",
          "    'echomind_daily_pdf': {'retry_pending': True, 'status': 'quality_retry_pending', 'next_attempt_at': '2026-08-31T02:47:35+00:00'},",
          "    'memo_daily': {'delivered': True, 'required': True, 'retry_pending': False, 'status': 'delivered'},",
          "  }",
          "}",
          "print(json.dumps(payload, indent=2, sort_keys=True))",
          "",
        ].join("\n"),
        "utf8"
      );
    },
    responses: [
      assistant("", [toolCall("run-compact-health", "run_command", { command: compactHealthCommand })]),
      reasoningOnly("The compact health JSON already answers the read-only status question, so I should produce a short final answer.", "length"),
      reasoningOnly("I need to summarize delivered schedules, retrying schedules, phone ingress, and queues from the retained JSON.", "length"),
    ],
  });
  assert.equal(
    compactHealthFallback.calls.length,
    3,
    "empty finish-only verified completion burned extra model turns before fallback"
  );
  assert.equal(
    compactHealthFallback.calls[1]?.max_tokens,
    2048,
    "verified-completion turn did not raise the installed 768-token cap"
  );
  assert.equal(
    compactHealthFallback.calls[2]?.max_tokens,
    2048,
    "verified-completion retry did not retain the raised output cap"
  );
  assert.match(compactHealthFallback.result.result, /Delivered: .*career_daily.*memo_daily/i);
  assert.match(compactHealthFallback.result.result, /Still retrying: .*echomind_daily_pdf.*next attempt 2026-08-31T02:47:35\+00:00/i);
  assert.match(compactHealthFallback.result.result, /phone_ingress reaches the agent for: .*other_people.*self_authored/i);
  assert.match(compactHealthFallback.result.result, /Queues: .*wechat pending 0 active 0.*wecom pending 0 active 0/i);
  assert.match(compactHealthFallback.result.result, /Verified from runtime evidence/i);
  assert.doesNotMatch(compactHealthFallback.result.result, /^Completed the requested work and verified it from runtime evidence\. Evidence: command/i);
  assert.equal(
    compactHealthFallback.events.filter(
      (event) => event.type === "tool.started" && event.data?.toolName !== "finish"
    ).length,
    1,
    "compact health fallback dispatched more than the authoritative command"
  );
  assert(
    !compactHealthFallback.events.some(
      (event) =>
        event.type === "tool.started" &&
        /(?:^|[ /])(?:\\.private|private|raw|sqlite|jsonl|artifact)(?:$|[ /.-])/i.test(
          String(event.data?.args?.command || "")
        )
    ),
    "compact health fallback explored forbidden private/raw evidence"
  );
  assert.equal(
    compactHealthFallback.events.filter((event) => event.type === "completion.verified_fallback").length,
    1,
    "compact health empty response did not persist exactly one verified fallback"
  );
  assert.equal(
    compactHealthFallback.events.filter((event) => event.type === "completion.empty_response_repair_requested").length,
    0,
    "finish-only reasoning repair still spent a separate empty-response repair turn"
  );

  const wordCompletionWithoutArtifact = await runCase({
    id: "word-completion-without-artifact",
    goal: "Create an editable, phone-friendly project handoff from this folder.",
    taskProfile: "word",
    allowFileTools: true,
    responses: [
      assistant("", [toolCall("word-finish-without-file-1", "finish", { result: "The handoff is complete." })]),
      assistant("", [toolCall("word-finish-without-file-2", "finish", { result: "The handoff is complete." })]),
    ],
  });
  assert.equal(wordCompletionWithoutArtifact.result.stopped, true);
  assert.equal(wordCompletionWithoutArtifact.result.reason, "model_did_not_execute");
  assert(
    wordCompletionWithoutArtifact.events.some(
      (event) =>
        event.type === "document.quality_assessed" &&
        event.data?.ok === false &&
        /no readable DOCX or PDF/i.test(String(event.data?.reason || ""))
    ),
    "Word completion without a document artifact bypassed the independent quality gate"
  );
  assert(
    wordCompletionWithoutArtifact.events.some(
      (event) =>
        event.type === "completion.evidence_rejected" &&
        /no readable DOCX or PDF/i.test(String(event.data?.reason || ""))
    ),
    "missing Word artifacts did not produce an actionable completion repair"
  );

  const writingPdfCompletionWithoutArtifact = await runCase({
    id: "writing-pdf-completion-without-artifact",
    goal: "Read chat_history.md and produce an editable source plus a mobile-readable PDF.",
    taskProfile: "writing",
    allowFileTools: true,
    executionTier: "focused",
    responses: [
      assistant("", [toolCall("writing-pdf-finish-without-file-1", "finish", { result: "The PDF report is complete." })]),
      assistant("", [toolCall("writing-pdf-finish-without-file-2", "finish", { result: "The PDF report is complete." })]),
    ],
  });
  assert.equal(writingPdfCompletionWithoutArtifact.result.stopped, true);
  assert(
    writingPdfCompletionWithoutArtifact.events.some(
      (event) =>
        event.type === "document.quality_assessed" &&
        event.data?.ok === false &&
        /no readable DOCX or PDF/i.test(String(event.data?.reason || ""))
    ),
    "a writing-profile PDF task bypassed the independent document quality gate"
  );

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

  const retainedValidatorRequiresFreshPass = await runCase({
    id: "retained-validator-requires-fresh-pass",
    goal: "Repair the current project and verify the result.",
    taskProfile: "writing",
    allowShellTool: true,
    allowFileTools: true,
    executionTier: "focused",
    setup: async (workspace) => {
      await fs.writeFile(path.join(workspace, "report.md"), "status: wrong\n", "utf8");
      await fs.writeFile(
        path.join(workspace, "acceptance_check.py"),
        [
          "from pathlib import Path",
          "",
          "content = Path('report.md').read_text(encoding='utf-8')",
          "raise SystemExit(0 if content == 'status: correct\\n' else 1)",
          "",
        ].join("\n"),
        "utf8"
      );
    },
    responses: [
      assistant("", [
        toolCall("run-retained-validator-failing", "run_command", {
          command: "python3 acceptance_check.py",
        }),
      ]),
      assistant("", [
        toolCall("repair-retained-validator-output", "apply_patch", {
          path: "report.md",
          search: "status: wrong",
          replace: "status: correct",
          expectedReplacements: 1,
        }),
      ]),
      assistant("", [
        toolCall("finish-before-retained-validator-rerun", "finish", {
          result: "The project repair is complete and verified.",
        }),
      ]),
      assistant("", [
        toolCall("run-retained-validator-passing", "run_command", {
          command: "python3 acceptance_check.py",
        }),
      ]),
      assistant("", [
        toolCall("finish-after-retained-validator-rerun", "finish", {
          result: "The project repair and retained validator both passed.",
        }),
      ]),
    ],
  });
  assert.equal(
    retainedValidatorRequiresFreshPass.calls.length,
    5,
    "completion accepted stale substantive validation after a real mutation"
  );
  assert(
    retainedValidatorRequiresFreshPass.events.some(
      (event) =>
        event.type === "completion.evidence_rejected" &&
        event.data?.suggestedTestCommands?.includes("python3 acceptance_check.py")
    ),
    "completion repair did not retain the exact substantive validator command"
  );
  assert(
    retainedValidatorRequiresFreshPass.events.some(
      (event) =>
        event.type === "tool.completed" &&
        event.data?.args?.command === "python3 acceptance_check.py" &&
        event.data?.exitCode === 0
    ),
    "the retained validator did not pass at the latest mutation revision"
  );
  assert(retainedValidatorRequiresFreshPass.events.some((event) => event.type === "session.finished"));

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
