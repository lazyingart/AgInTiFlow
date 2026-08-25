#!/usr/bin/env node
import assertStrict from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_VALIDATION_TOOL_NAMES,
  DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET,
  LOCAL_COMPACT_CODE_TOOL_NAMES,
  LOCAL_COMPACT_GENERAL_TOOL_NAMES,
  LOCAL_TOOL_HARD_CAP,
  selectProgressiveTools,
} from "../src/progressive-tool-selection.js";
import { requestNextStep } from "../src/model-client.js";
import {
  buildModelTimeoutRetryMessages,
  completionContractGoal,
  integrationTextWorkspaceToolExecutionBlock,
  nextStepRuntimeConfig,
  recoverFocusedWholeFileWriteAsExactPatch,
  runAgent,
} from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";
import {
  INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
  INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES,
} from "../src/integration-retained-text-workspace.js";
import {
  attachToolContract,
  createToolContract,
  resolveDispatchableToolCallBatch,
  safeSequentialToolBatchLimit,
  toolContractFromResponse,
  validateToolCallBatch,
} from "../src/tool-contract.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tool(name, description = `${name} tool`) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          value: { type: "string", description: `Input for ${name}.` },
        },
        additionalProperties: false,
      },
    },
  };
}

function names(tools) {
  return tools.map((item) => item.function.name);
}

function sameNames(actual, expected, message) {
  assert(JSON.stringify(names(actual)) === JSON.stringify(expected), `${message}: ${names(actual).join(", ")}`);
}

async function captureRequestTools(overrides = {}) {
  let payload = null;
  const client = {
    chat: {
      completions: {
        create: async (request) => {
          payload = request;
          return { choices: [{ message: { role: "assistant", content: "done", tool_calls: [] } }] };
        },
      },
    },
  };
  const response = await requestNextStep(
    client,
    {
      provider: "localllm",
      model: "localllm-fast",
      baseURL: "http://127.0.0.1:8008/v1",
      apiKey: "local-dev-key",
      goal: "Exercise the complete local tool schema.",
      taskProfile: "general",
      toolSurfacePolicy: "full",
      allowShellTool: false,
      allowFileTools: true,
      allowWebSearch: true,
      allowMcpTools: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowHostedImagePerception: false,
      allowHostedWebResearch: false,
      allowHostedJsonSpecialist: false,
      allowHostedWritingSpecialist: false,
      modelTimeoutMs: 0,
      ...overrides,
    },
    [{ role: "user", content: "Exercise the complete local tool schema." }]
  );
  const selected = payload?.tools || [];
  const contract = toolContractFromResponse(response);
  assert(contract, "requestNextStep did not preserve its per-turn tool contract");
  assertStrict.deepEqual(contract.tools, selected, "response tool contract diverged from the exact descriptors sent to the model");
  return selected;
}

function enumFor(tools, toolName, property) {
  const descriptor = tools.find((item) => item.function?.name === toolName);
  return descriptor?.function?.parameters?.properties?.[property]?.enum || [];
}

const knownNames = [
  "open_url",
  "json_specialist",
  "json_specialist_batch",
  "click",
  "type",
  "scroll",
  "press",
  "back",
  "wait",
  "writing_specialist",
  "web_search",
  "read_web_page",
  "web_research",
  "deep_research",
  "mcp_list_servers",
  "mcp_list_tools",
  "mcp_call_tool",
  "mcp_list_resources",
  "mcp_read_resource",
  "mcp_list_prompts",
  "mcp_get_prompt",
  "agentlink_status",
  "agentlink_list_peers",
  "agentlink_create_board",
  "agentlink_get_board",
  "agentlink_send_message",
  "agentlink_claim_task",
  "agentlink_attach_evidence",
  "agentlink_summarize_session",
  "read_image",
  "open_workspace_file",
  "preview_workspace",
  "start_long_job",
  "long_job_status",
  "tmux_list_sessions",
  "tmux_capture_pane",
  "tmux_send_keys",
  "tmux_start_session",
  "run_command",
  "inspect_project",
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "delegate_agent",
  "research_wrapper",
  "generate_image",
  "send_to_canvas",
  "custom_hosted_tool",
  "finish",
];
const allTools = knownNames.map((name) => tool(name));

const codeTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Implement the bug fix and run tests.",
  profile: "code",
});
sameNames(codeTools, LOCAL_COMPACT_CODE_TOOL_NAMES, "code profile did not select the canonical compact set");

const convergenceTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", convergenceOutputPhase: true },
  goal: "Inspect the established routines, then write the requested readiness report.",
  profile: "code",
});
assert(names(convergenceTools).includes("write_file"), "convergence phase omitted write_file");
assert(names(convergenceTools).includes("apply_patch"), "convergence phase omitted apply_patch");
assert(names(convergenceTools).includes("finish"), "convergence phase omitted finish");
assert(
  !names(convergenceTools).some((name) => ["inspect_project", "list_files", "read_file", "search_files", "read_image", "run_command"].includes(name)),
  "convergence phase still exposed bounded-out discovery tools"
);
const convergenceCheckTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    convergenceOutputPhase: true,
    convergenceAllowRunCommand: true,
  },
  goal: "Run the required source-derived doctor checks, then write the readiness report.",
  profile: "code",
});
assert(names(convergenceCheckTools).includes("run_command"), "convergence hid a task-required bounded command check");
assert(!names(convergenceCheckTools).includes("read_file"), "convergence check mode reopened broad file discovery");

const artifactValidationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", artifactValidationPhase: true },
  goal: "The exact report exists. Validate it once, then finish.",
  profile: "code",
});
sameNames(
  artifactValidationTools,
  ARTIFACT_VALIDATION_TOOL_NAMES,
  "artifact validation phase did not expose the exact validate-correct-deliver-finish surface"
);
assert(!names(artifactValidationTools).includes("search_files"), "artifact validation phase reopened broad search");
assert(!names(artifactValidationTools).includes("open_url"), "artifact validation phase reopened browser discovery");

const localFailureRecoveryTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", localFailureRecoveryActive: true },
  goal: "Recover from repeated failed edits without restarting the task.",
  profile: "code",
  messages: [
    { role: "assistant", tool_calls: [{ id: "failed-edit", function: { name: "apply_patch", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "failed-edit", content: '{"ok":false}' },
  ],
});
sameNames(
  localFailureRecoveryTools,
  ["read_file", "read_image", "apply_patch", "write_file", "run_command", "search_files", "inspect_project", "finish"],
  "local failure recovery did not restore the bounded repair surface"
);

const dataDiscoveryStarterTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
});
sameNames(
  dataDiscoveryStarterTools,
  ["inspect_project", "finish"],
  "local data task exposed mutation tools before project inspection"
);

const dataInspectionMessages = [
  { role: "user", content: "Goal: Clean these experiment exports and leave a reproducible analysis." },
  {
    role: "assistant",
    tool_calls: [{ id: "data-inspect", function: { name: "inspect_project", arguments: '{"path":"."}' } }],
  },
  {
    role: "tool",
    tool_call_id: "data-inspect",
    content: JSON.stringify({
      ok: true,
      recommendedReads: ["README.md", "tests/test_analysis.py"],
      manifestFiles: [{ path: "README.md" }],
      testFiles: [{ path: "tests/test_analysis.py" }],
      topLevel: [
        { path: "analysis.py", type: "file" },
        { path: "TASK.md", type: "file" },
      ],
    }),
  },
];
const dataContextTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
  messages: dataInspectionMessages,
});
sameNames(
  dataContextTools,
  ["read_file", "finish"],
  "local data task exposed mutation tools before reading project contracts"
);
assertStrict.deepEqual(
  enumFor(dataContextTools, "read_file", "path"),
  ["README.md"],
  "local data instruction phase did not constrain read_file to discovered instruction paths"
);

const dataImplementationMessages = [
  ...dataInspectionMessages,
  {
    role: "assistant",
    tool_calls: [{ id: "data-readme", function: { name: "read_file", arguments: '{"path":"README.md"}' } }],
  },
  { role: "tool", tool_call_id: "data-readme", content: '{"ok":true,"path":"README.md"}' },
];
const dataImplementationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
  messages: dataImplementationMessages,
});
sameNames(
  dataImplementationTools,
  ["read_file", "finish"],
  "local data task exposed mutation tools before reading an analyzer/config/test surface"
);
assertStrict.deepEqual(
  enumFor(dataImplementationTools, "read_file", "path"),
  ["analysis.py"],
  "local data context phase did not constrain read_file to discovered analysis paths"
);

const dataTestDiscoveryMessages = [
  ...dataImplementationMessages,
  {
    role: "assistant",
    tool_calls: [
      { id: "data-analysis", function: { name: "read_file", arguments: '{"path":"analysis.py"}' } },
    ],
  },
  { role: "tool", tool_call_id: "data-analysis", content: '{"ok":true,"path":"analysis.py"}' },
];
const dataTestDiscoveryTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
  messages: dataTestDiscoveryMessages,
});
sameNames(
  dataTestDiscoveryTools,
  ["read_file", "finish"],
  "local data task exposed mutation tools before reading a discovered test"
);
assertStrict.deepEqual(
  enumFor(dataTestDiscoveryTools, "read_file", "path"),
  ["tests/test_analysis.py"],
  "local data test phase did not constrain read_file to discovered tests"
);

const timeoutError = new Error("agent step request timed out after 300000ms");
timeoutError.name = "ModelTimeoutError";
const compactedDataTestMessages = buildModelTimeoutRetryMessages(
  {
    goal: "Clean these experiment exports and leave a reproducible analysis.",
    plan: "",
    messages: dataTestDiscoveryMessages,
    meta: {},
  },
  {
    taskProfile: "data",
    sandboxMode: "host",
    packageInstallPolicy: "block",
    commandCwd: repoRoot,
    maxSteps: 30,
  },
  { title: "No browser page open", url: "" },
  4,
  timeoutError
);
const compactedDataTestTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
  messages: compactedDataTestMessages,
});
sameNames(
  compactedDataTestTools,
  ["read_file", "finish"],
  "timeout compaction discarded completed data discovery state"
);
assertStrict.deepEqual(
  enumFor(compactedDataTestTools, "read_file", "path"),
  ["tests/test_analysis.py"],
  "timeout compaction did not resume at the next exact discovered test"
);

const dataReadyMessages = [
  ...dataTestDiscoveryMessages,
  {
    role: "assistant",
    tool_calls: [
      { id: "data-test", function: { name: "read_file", arguments: '{"path":"tests/test_analysis.py"}' } },
    ],
  },
  { role: "tool", tool_call_id: "data-test", content: '{"ok":true,"path":"tests/test_analysis.py"}' },
];
const dataReadyTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
  messages: dataReadyMessages,
});
sameNames(dataReadyTools, LOCAL_COMPACT_CODE_TOOL_NAMES, "local data task did not unlock after bounded discovery");

const dataRecoveryBeforeDiscoveryTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", localFailureRecoveryActive: true },
  goal: "Recover this data task after a failed mutation.",
  profile: "data",
});
sameNames(
  dataRecoveryBeforeDiscoveryTools,
  ["inspect_project", "finish"],
  "local recovery bypassed the incomplete data discovery gate"
);

const dataRecoveryAfterDiscoveryTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", localFailureRecoveryActive: true },
  goal: "Recover this data task after a failed mutation.",
  profile: "data",
  messages: dataReadyMessages,
});
sameNames(
  dataRecoveryAfterDiscoveryTools,
  ["read_file", "read_image", "apply_patch", "write_file", "run_command", "search_files", "inspect_project", "finish"],
  "local recovery remained trapped after data discovery completed"
);

const retainedDataRecoveryTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    localFailureRecoveryActive: true,
    dataProjectDiscoveryReady: true,
  },
  goal: "Continue the same retained data repair.",
  profile: "data",
});
sameNames(
  retainedDataRecoveryTools,
  ["read_file", "read_image", "apply_patch", "write_file", "run_command", "search_files", "inspect_project", "finish"],
  "retained local data recovery omitted mutation and verification tools"
);

const artifactRepairTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", artifactValidationPhase: true, artifactValidationNeedsRepair: true },
  goal: "Repair the exact report from deterministic preflight evidence.",
  profile: "code",
});
assertStrict.equal(names(artifactRepairTools)[0], "apply_patch", "artifact repair did not prioritize the patch tool");
assert(names(artifactRepairTools).includes("finish"), "artifact repair surface omitted finish");
assert(!names(artifactRepairTools).includes("run_command"), "artifact repair exposed command checks before content was valid");

const embeddedArtifactRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsRepair: true,
    artifactValidationOutputEmbedded: true,
  },
  goal: "Repair the exact report whose full content is embedded in the validation packet.",
  profile: "code",
});
assert(!names(embeddedArtifactRepairTools).includes("read_file"), "embedded artifact repair redundantly exposed read_file");
assert(!names(embeddedArtifactRepairTools).includes("write_file"), "embedded artifact repair allowed a drifting whole-file rewrite");
assert(names(embeddedArtifactRepairTools).includes("apply_patch"), "embedded artifact repair omitted apply_patch");

const focusedArtifactRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsRepair: true,
    artifactValidationRepairAttempts: 1,
  },
  goal: "Apply a focused repair after the first whole-artifact correction.",
  profile: "code",
});
assertStrict.equal(names(focusedArtifactRepairTools)[0], "apply_patch", "later artifact repair did not retain patch priority");
assert(!names(focusedArtifactRepairTools).includes("write_file"), "later artifact repair still allowed whole-artifact rewrites");
assert(!names(focusedArtifactRepairTools).includes("run_command"), "later artifact repair exposed unrelated command checks");

const repairWithMissingCheckTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsRepair: true,
    artifactValidationNeedsCommand: true,
    artifactValidationRepairAttempts: 1,
  },
  goal: "Collect the missing doctor evidence, then apply a focused report repair.",
  profile: "code",
});
assertStrict.equal(
  names(repairWithMissingCheckTools)[0],
  "run_command",
  "artifact repair was prioritized ahead of its missing execution evidence"
);
assert(names(repairWithMissingCheckTools).includes("apply_patch"), "combined evidence/repair surface omitted patching");
assert(!names(repairWithMissingCheckTools).includes("write_file"), "combined later repair reopened whole-file rewriting");

const artifactCommandTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsCommand: true,
    artifactValidationUsedTools: ["read_file"],
  },
  goal: "Run one bounded verification command, then finish.",
  profile: "code",
});
assertStrict.equal(names(artifactCommandTools)[0], "run_command", "artifact command evidence was not prioritized");
assert(!names(artifactCommandTools).includes("read_file"), "already-used artifact read remained exposed");

const pendingCompletionEvidenceTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsGitEvidence: true,
    artifactValidationNeedsVisualEvidence: true,
    artifactValidationUsedTools: ["run_command", "read_image"],
  },
  goal: "Finish only after the generated plot is inspected and the intentional changes are committed.",
  profile: "data",
});
assertStrict.equal(
  names(pendingCompletionEvidenceTools)[0],
  "read_image",
  "pending visual evidence did not prioritize actual image perception"
);
assert(
  names(pendingCompletionEvidenceTools).includes("run_command"),
  "pending git evidence did not reopen the shell after an earlier generator command"
);

const resumedArtifactRuntime = nextStepRuntimeConfig(
  {
    goal: "Perform a visual screenshot inspection of the generated plot and commit the intentional changes.",
    taskProfile: "data",
  },
  {
    goal: "Perform a visual screenshot inspection of the generated plot and commit the intentional changes.",
    meta: {
      taskProfile: "data",
      artifactProgress: {
        complete: true,
        usedValidationTools: ["run_command", "read_image"],
      },
      durableEvidenceCategories: [],
    },
    messages: [],
  }
);
assert(
  resumedArtifactRuntime.artifactValidationNeedsGitEvidence === true,
  "artifact resume lost the durable git evidence requirement"
);
assert(
  resumedArtifactRuntime.artifactValidationNeedsVisualEvidence === true,
  "artifact resume lost the durable visual evidence requirement"
);

const visuallyVerifiedArtifactRuntime = nextStepRuntimeConfig(
  {
    goal: "Perform a visual screenshot inspection of the generated plot and commit the intentional changes.",
    taskProfile: "data",
  },
  {
    goal: "Perform a visual screenshot inspection of the generated plot and commit the intentional changes.",
    meta: {
      taskProfile: "data",
      durableEvidenceCategories: ["visual", "artifact"],
      artifactProgress: { complete: true, usedValidationTools: ["read_image"] },
    },
    messages: [],
  }
);
assert(
  visuallyVerifiedArtifactRuntime.artifactValidationNeedsVisualEvidence === false,
  "durable visual evidence was forgotten after history compaction"
);
assert(
  visuallyVerifiedArtifactRuntime.artifactValidationNeedsGitEvidence === true,
  "durable visual evidence incorrectly satisfied the separate git requirement"
);

const statusOnlyArtifactState = {
  goal: "Generate the required outputs.",
  meta: {
    taskProfile: "data",
    goalContract: {
      revision: 7,
      taskGoal: "Generate the required outputs.",
      currentRequest: "Commit only analysis.py and AGINTI.md after cleanup.",
    },
    durableEvidenceCategories: ["git"],
    durableGitActions: ["status", "diff"],
    durableGitEvidence: [
      { action: "status", goalRevision: 7 },
      { action: "diff", goalRevision: 7 },
    ],
    artifactProgress: { complete: true, usedValidationTools: ["run_command"] },
  },
  messages: [],
};
assert(
  completionContractGoal({ taskProfile: "data" }, statusOnlyArtifactState).includes(
    "Commit only analysis.py and AGINTI.md"
  ),
  "the latest same-task continuation disappeared from the completion contract"
);
assert(
  nextStepRuntimeConfig({ taskProfile: "data" }, statusOnlyArtifactState)
    .artifactValidationNeedsGitEvidence === true,
  "durable git status incorrectly hid the shell before the requested commit"
);
assert(
  nextStepRuntimeConfig({ taskProfile: "data" }, statusOnlyArtifactState)
    .artifactValidationNeedsCommand === true,
  "a fresh pending commit did not reopen the command tool"
);
const staleCommitArtifactRuntime = nextStepRuntimeConfig(
  { taskProfile: "data" },
  {
    ...statusOnlyArtifactState,
    meta: {
      ...statusOnlyArtifactState.meta,
      durableGitActions: ["status", "diff", "commit"],
      durableGitEvidence: [
        { action: "status", goalRevision: 7 },
        { action: "commit", goalRevision: 6 },
      ],
    },
  }
);
assert(
  staleCommitArtifactRuntime.artifactValidationNeedsGitEvidence === true,
  "a commit from an earlier goal revision satisfied a fresh commit request"
);
const committedArtifactRuntime = nextStepRuntimeConfig(
  { taskProfile: "data" },
  {
    ...statusOnlyArtifactState,
    meta: {
      ...statusOnlyArtifactState.meta,
      durableGitActions: ["status", "diff", "add", "commit"],
      durableGitEvidence: [
        { action: "status", goalRevision: 7 },
        { action: "commit", goalRevision: 7 },
      ],
    },
  }
);
assert(
  committedArtifactRuntime.artifactValidationNeedsGitEvidence === false,
  "a durable matching commit was forgotten after compaction"
);
const bareResumeCommitState = {
  goal: "Continue the same task from the saved state.",
  meta: {
    taskProfile: "writing",
    goalContract: {
      revision: 6,
      currentRequest: "Continue the same task from the saved state.",
      activeGoal: "Update handoff.md from records.jsonl, validate it, and commit the coherent result.",
      activeGoalRevision: 5,
    },
    projectVerification: {
      mutationRevision: 9,
      requiredOutputs: ["handoff.md"],
    },
    durableEvidenceCategories: ["git"],
    durableGitActions: ["commit"],
    durableGitEvidence: [{ action: "commit", goalRevision: 5, mutationRevision: 8 }],
    artifactProgress: { complete: true, exactOutputPaths: ["handoff.md"], usedValidationTools: [] },
  },
  messages: [],
};
assert(
  nextStepRuntimeConfig({ taskProfile: "writing" }, bareResumeCommitState)
    .artifactValidationNeedsGitEvidence === true,
  "a commit predating the latest mutation satisfied a bare resumed task"
);
const currentMutationCommitState = {
  ...bareResumeCommitState,
  meta: {
    ...bareResumeCommitState.meta,
    durableGitEvidence: [{ action: "commit", goalRevision: 5, mutationRevision: 9 }],
  },
};
assert(
  nextStepRuntimeConfig({ taskProfile: "writing" }, currentMutationCommitState)
    .artifactValidationNeedsGitEvidence === false,
  "a commit covering the active goal and latest mutation was not retained"
);
const pendingCanonicalCommandRuntime = nextStepRuntimeConfig(
  { taskProfile: "data" },
  {
    goal: "Finish the validated data project.",
    meta: {
      taskProfile: "data",
      projectVerification: {
        mutationRevision: 4,
        requiredCommands: ["python analysis.py"],
        requiredOutputs: ["outputs/summary.json"],
        commandRuns: [],
        testRuns: [],
      },
      artifactProgress: { complete: true, usedValidationTools: [] },
    },
    messages: [],
  }
);
assert(
  pendingCanonicalCommandRuntime.artifactValidationNeedsCommand === true,
  "a missing canonical project command did not reopen command execution"
);

const artifactSourceReadTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsSourceRead: true,
  },
  goal: "Inspect one exact missing source, then finish.",
  profile: "code",
});
assertStrict.equal(names(artifactSourceReadTools)[0], "read_file", "missing source evidence did not prioritize an exact read");

const embeddedArtifactSourceReadTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsSourceRead: true,
    artifactValidationOutputEmbedded: true,
  },
  goal: "Inspect one exact missing source while the output itself is already embedded.",
  profile: "code",
});
assertStrict.equal(
  names(embeddedArtifactSourceReadTools)[0],
  "read_file",
  "embedding the output incorrectly hid a genuinely missing source read"
);

const browserTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Open the browser, fill in the form, and take a screenshot.",
  profile: "browser",
});
assert(names(browserTools).includes("open_url"), "browser bundle omitted open_url");
assert(names(browserTools).includes("click") && names(browserTools).includes("type"), "browser bundle omitted interaction tools");
assert(!names(browserTools).includes("run_command"), "browser bundle leaked the code shell tool");

const failedTestRepairTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", testFailureRepairActive: true },
  goal: "Repair the current project after a failing test.",
  profile: "data",
});
sameNames(
  failedTestRepairTools,
  ["read_file", "search_files", "apply_patch", "run_command", "finish"],
  "failed-test repair did not receive the bounded diagnose-patch-retest tool surface"
);

const mutationOnlyFailedTestRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
  },
  goal: "Repair the current project after an unchanged failing test rerun.",
  profile: "data",
});
sameNames(
  mutationOnlyFailedTestRepairTools,
  ["apply_patch", "finish"],
  "an unchanged failed-test rerun did not close discovery until a real mutation"
);

const failedTestPatchContextTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairNeedsPatchContext: true,
  },
  goal: "Repair the current project after an unchanged replacement.",
  profile: "data",
});
sameNames(
  failedTestPatchContextTools,
  ["read_file", "search_files", "apply_patch", "finish"],
  "a failed no-op patch did not reopen one bounded diagnostic source turn"
);

const failedTestRepairWithRequiredInstruction = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairAllowedCreates: ["AGINTI.md"],
  },
  goal: "Repair the current project and create the required project instructions.",
  profile: "data",
});
sameNames(
  failedTestRepairWithRequiredInstruction,
  ["read_file", "search_files", "apply_patch", "write_file", "run_command", "finish"],
  "failed-test repair omitted the exact required instruction-file creation exception"
);
const constrainedInstructionWrite = failedTestRepairWithRequiredInstruction.find(
  (tool) => tool.function.name === "write_file"
);
assertStrict.deepEqual(constrainedInstructionWrite.function.parameters.properties.path.enum, ["AGINTI.md"]);
assertStrict.deepEqual(constrainedInstructionWrite.function.parameters.properties.mode.enum, ["create"]);

const continuedFailedTestRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 1,
        discoveredTests: ["python -m pytest -q"],
        requiredOutputs: [],
        testRuns: [
          {
            command: "python -m pytest -q",
            mutationRevision: 0,
            passed: false,
            failureSignature: "baseline-failure",
          },
        ],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  continuedFailedTestRepairRuntime.testVerificationPending,
  true,
  "a real repair mutation did not require the retained failed test before more edits"
);
assertStrict.equal(
  continuedFailedTestRepairRuntime.testVerificationCommand,
  "python -m pytest -q",
  "a real repair mutation lost the exact retained verification command"
);
const mutationGatedRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 1,
        testRuns: [
          {
            command: "python -m pytest -q",
            mutationRevision: 1,
            passed: false,
            failureSignature: "current-failure",
          },
        ],
      },
      toolLoop: {
        stagnationEpoch: 4,
        recent: [
          {
            category: "unchanged-failed-test-rerun",
            stagnationEpoch: 4,
          },
        ],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  mutationGatedRepairRuntime.testFailureRepairMutationRequired,
  true,
  "a blocked unchanged validator did not advance failed-test recovery to mutation-only mode"
);
const repositoryStateRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 2,
        testRuns: [{
          command: "python acceptance.py --phase final",
          mutationRevision: 2,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "repository-state-gate",
          failureSummary:
            "require(git_output(root, \"status\", \"--short\") == \"\", \"repository worktree is not clean\")",
        }],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  repositoryStateRepairRuntime.testFailureRepositoryStateRepair,
  true,
  "an empty Git-status assertion did not activate repository-state repair"
);
assertStrict.equal(
  repositoryStateRepairRuntime.testFailureRepairMutationRequired,
  false,
  "a repository-state repair incorrectly required another content mutation"
);
const repositoryStateRepairTools = selectProgressiveTools(allTools, {
  config: repositoryStateRepairRuntime,
  goal: "Finish the verified task and leave the repository clean.",
  profile: "qa",
});
sameNames(
  repositoryStateRepairTools,
  ["run_command", "finish"],
  "repository-state repair exposed document mutation tools"
);
assert(
  /stage and commit only those changes/i.test(
    repositoryStateRepairTools.find((item) => item.function.name === "run_command")?.function.description || ""
  ),
  "repository-state repair did not explain the bounded Git workflow"
);
const taskOwnedRepositoryState = {
  meta: {
    goalContract: { revision: 6 },
    projectVerification: {
      mutationRevision: 5,
      commandRuns: [{
        command: "git add -- old.md && git commit -m 'Prior task'",
        ok: true,
        mutationRevision: 2,
      }],
      mutationHistory: [
        { revision: 1, paths: ["old.md"] },
        { revision: 4, paths: ["handoff.md"] },
        { revision: 5, paths: ["notes/summary.md", "handoff.md"] },
      ],
      testRuns: [{
        command: "python acceptance.py --phase final",
        mutationRevision: 5,
        passed: false,
        failureEvidenceVersion: 2,
        failureSignature: "repository-state-gate-with-owned-paths",
        failureSummary:
          "require(git_output(root, \"status\", \"--short\") == \"\", \"repository worktree is not clean\")",
      }],
    },
  },
  messages: [],
};
const taskOwnedRepositoryRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  taskOwnedRepositoryState
);
assertStrict.deepEqual(
  taskOwnedRepositoryRuntime.repositoryStateRepairCommitPaths,
  ["handoff.md", "notes/summary.md"],
  "repository-state repair did not isolate agent-owned paths since the latest successful commit"
);
const taskOwnedRepositoryTools = selectProgressiveTools(allTools, {
  config: taskOwnedRepositoryRuntime,
  goal: "Finish the verified task and leave the repository clean.",
  profile: "qa",
});
sameNames(
  taskOwnedRepositoryTools,
  ["commit_project_changes", "finish"],
  "repository-state repair exposed an open-ended shell after task-owned paths were known"
);
assertStrict.deepEqual(
  taskOwnedRepositoryTools[0].function.parameters.required,
  ["message"],
  "the task-owned commit tool delegated path selection back to the model"
);
const verifiedCompletionTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    taskProfile: "qa",
    verifiedCompletionPending: true,
    artifactValidationPhase: true,
    testFailureRepairActive: true,
  },
  goal: "Conclude from current verified evidence.",
  profile: "qa",
});
sameNames(
  verifiedCompletionTools,
  ["finish"],
  "verified completion exposed tools that could repeat or mutate completed work"
);
const retainedPacketRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 3,
        testRuns: [
          {
            command: "python -m pytest -q",
            mutationRevision: 3,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "retained-failure",
          },
        ],
      },
      failedTestRecoveryPacket: {
        packetVersion: 7,
        mutationRevision: 3,
        failureSignature: "retained-failure",
        content: "Bounded failed-test evidence packet v7.",
      },
      failedTestDiagnostic: {
        packetVersion: 7,
        mutationRevision: 3,
        failureSignature: "retained-failure",
        at: "2026-08-24T02:00:00.000Z",
        focuses: [],
      },
      toolLoop: {
        stagnationEpoch: 9,
        recent: [],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  retainedPacketRepairRuntime.testFailureRepairMutationRequired,
  true,
  "a current retained evidence packet lost its mutation gate across a resume boundary"
);
assertStrict.equal(
  retainedPacketRepairRuntime.testFailureRepairNeedsPatchContext,
  true,
  "a fresh retained evidence packet did not allow one bounded diagnostic source turn"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: retainedPacketRepairRuntime,
    goal: "Resume the current failed-test repair from retained evidence.",
    profile: "qa",
  }),
  ["read_file", "search_files", "apply_patch", "finish"],
  "a fresh retained evidence packet exposed an unbounded failed-test tool surface"
);
const focusedPatchRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 5,
        testRuns: [
          {
            command: "python -m pytest -q",
            mutationRevision: 5,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "focused-failure",
          },
        ],
      },
      failedTestRecoveryPacket: {
        packetVersion: 7,
        mutationRevision: 5,
        failureSignature: "focused-failure",
        content: "Bounded failed-test evidence packet v7.",
      },
      failedTestDiagnostic: {
        packetVersion: 7,
        mutationRevision: 5,
        failureSignature: "focused-failure",
        at: "2026-08-24T02:00:00.000Z",
        focuses: [
          {
            path: "report.md",
            decisiveLine: 2,
            directSearch: "The earlier marker is incorrect.",
            left: "correct",
            operator: "<",
            right: "incorrect",
            caseFolded: true,
          },
          {
            kind: "membership",
            path: "report.md",
            decisiveLine: 2,
            directSearch: "The earlier marker is incorrect.",
            literal: "required marker",
            negated: false,
            anchorLiteral: "earlier marker",
            caseFolded: true,
          },
        ],
      },
      toolLoop: {
        stagnationEpoch: 10,
        recent: [
          {
            category: "failed-test-irrelevant-patch",
            failureSignature: "focused-failure",
            failedTestMutationRevision: 5,
            ok: false,
            blocked: true,
            at: "2026-08-24T02:00:01.000Z",
          },
          {
            category: "failed-test-irrelevant-patch",
            failureSignature: "focused-failure",
            failedTestMutationRevision: 5,
            ok: false,
            blocked: true,
            at: "2026-08-24T02:00:02.000Z",
          },
          {
            toolName: "read_file",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:03.000Z",
          },
        ],
      },
    },
    messages: [],
  }
);
assertStrict.deepEqual(
  focusedPatchRepairRuntime.testFailureRepairPatchTargets,
  [
    {
      kind: "index-comparison",
      path: "report.md",
      search: "The earlier marker is incorrect.",
      line: 2,
      left: "correct",
      operator: "<",
      right: "incorrect",
      literal: "",
      anchorLiteral: "",
      negated: false,
      caseFolded: true,
    },
    {
      kind: "membership",
      path: "report.md",
      search: "The earlier marker is incorrect.",
      line: 2,
      left: "",
      operator: "",
      right: "",
      literal: "required marker",
      anchorLiteral: "earlier marker",
      negated: false,
      caseFolded: true,
    },
  ],
  "repeated evidence-proven late patches did not activate a generic focused repair target"
);
const focusedPatchRepairTools = selectProgressiveTools(allTools, {
  config: focusedPatchRepairRuntime,
  goal: "Repair the exact earlier occurrence after repeated irrelevant patches.",
  profile: "qa",
});
sameNames(
  focusedPatchRepairTools,
  ["apply_patch", "finish"],
  "focused failed-test repair reopened unrelated tools"
);
const focusedApplyPatch = focusedPatchRepairTools.find(
  (tool) => tool.function.name === "apply_patch"
);
const focusedReplacementDescription =
  focusedApplyPatch.function.parameters.properties.replace.description;
assertStrict.deepEqual(
  focusedApplyPatch.function.parameters.properties.path.enum,
  ["report.md"],
  "focused failed-test repair did not constrain the exact task-owned path"
);
assertStrict.ok(
  focusedReplacementDescription.includes('first "correct" < first "incorrect"') &&
    focusedReplacementDescription.includes("appending later text is insufficient") &&
    focusedReplacementDescription.includes('"required marker" must appear'),
  "focused failed-test repair dropped one of multiple evidence-derived constraints on the same line"
);
assertStrict.ok(
  focusedApplyPatch.function.parameters.properties.replace.pattern === undefined &&
    focusedReplacementDescription.includes("natural project content") &&
    !focusedApplyPatch.function.description.includes("The earlier marker is incorrect."),
  "focused failed-test repair should explain natural artifact content without a brittle phrase blacklist"
);
assertStrict.deepEqual(
  focusedApplyPatch.function.parameters.properties.search.enum,
  ["The earlier marker is incorrect."],
  "focused failed-test repair did not constrain the evidence-derived decisive line"
);
const separatorRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairPatchTargets: [
      {
        kind: "membership",
        path: "report.md",
        search: "Keep the required-marker beside the verified value.",
        line: 3,
        literal: "required marker",
        anchorLiteral: "verified value",
        negated: false,
        caseFolded: true,
      },
    ],
  },
  goal: "Repair the retained exact membership failure.",
  profile: "qa",
});
const separatorRepairPatch = separatorRepairTools.find(
  (tool) => tool.function.name === "apply_patch"
);
assertStrict.deepEqual(
  separatorRepairPatch.function.parameters.properties.replace.enum,
  ["Keep the required marker beside the verified value."],
  "an unambiguous separator-only membership repair was not exposed as an exact evidence-derived value"
);
assertStrict.ok(
  separatorRepairPatch.function.parameters.properties.replace.description.includes(
    "single lossless separator normalization"
  ),
  "the exact separator repair omitted its generic rationale"
);
const duplicateLineRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairPatchTargets: [
      {
        kind: "index-comparison",
        path: "report.md",
        search: "Repeated summary line.\nUnique neighboring context.",
        line: 1,
        left: "later marker",
        operator: "<",
        right: "repeated summary",
        decisiveText: "Repeated summary line.",
        decisiveSide: "right",
        decisiveDuplicateCount: 3,
        caseFolded: true,
      },
    ],
  },
  goal: "Repair the retained first-match relation without duplicating content.",
  profile: "qa",
});
const duplicateLineRepairPatch = duplicateLineRepairTools.find(
  (tool) => tool.function.name === "apply_patch"
);
assertStrict.deepEqual(
  duplicateLineRepairPatch.function.parameters.properties.replace.enum,
  ["Unique neighboring context."],
  "a duplicated decisive line did not yield one lossless evidence-derived removal"
);
assertStrict.ok(
  duplicateLineRepairPatch.function.parameters.properties.replace.description.includes(
    "single lossless duplicate-line removal"
  ),
  "the duplicate-line repair omitted its generic rationale"
);
const prematureOperandRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairPatchTargets: [
      {
        kind: "index-comparison",
        path: "notes.md",
        search: "A carefully preloaded summary.",
        line: 4,
        left: "baseline",
        operator: "<",
        right: "load",
        decisiveText: "A carefully preloaded summary.",
        decisiveSide: "right",
        decisiveDuplicateCount: 1,
        caseFolded: true,
      },
    ],
  },
  goal: "Repair the retained first-match relation using natural prose.",
  profile: "qa",
});
const prematureOperandRepairPatch = prematureOperandRepairTools.find(
  (tool) => tool.function.name === "rewrite_text_excerpt"
);
const prematureOperandReplace =
  prematureOperandRepairPatch.function.parameters.properties.revisedText;
assertStrict.deepEqual(
  Object.keys(prematureOperandRepairPatch.function.parameters.properties),
  ["revisedText"],
  "a single evidence-selected prose repair still exposed redundant path and anchor arguments"
);
assertStrict.deepEqual(
  prematureOperandRepairPatch.function.parameters.required,
  ["revisedText"],
  "the replacement-only focused repair did not require revised text"
);
assertStrict.ok(
  prematureOperandRepairPatch.function.description.includes("not the whole file"),
  "the focused rewrite alias did not distinguish one excerpt from a whole-file replacement"
);
assertStrict.ok(
  typeof prematureOperandReplace.pattern === "string" &&
    !new RegExp(prematureOperandReplace.pattern).test("A carefully preloaded summary.") &&
    !new RegExp(prematureOperandReplace.pattern).test("A preloaded summary after the baseline.") &&
    new RegExp(prematureOperandReplace.pattern).test("A concise technical summary.") &&
    new RegExp(prematureOperandReplace.pattern).test("A baseline precedes the preloaded summary."),
  "a single premature comparison operand was not constrained by the evidence-derived relation"
);
assertStrict.ok(
  prematureOperandReplace.description.includes('premature operand "load"') &&
    prematureOperandReplace.description.includes('"pre[load]ed"') &&
    prematureOperandReplace.description.includes("place the required counterpart before") &&
    !prematureOperandReplace.description.includes("preloaded summary"),
  "premature-operand guidance omitted the containing-token evidence or leaked the full fixture prose"
);
const patchContextRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: mutationGatedRepairRuntime.testFailureRepairActive
        ? {
            mutationRevision: 0,
            testRuns: [
              {
                command: "python -m pytest -q",
                mutationRevision: 0,
                passed: false,
                failureEvidenceVersion: 2,
                failureSignature: "baseline-failure",
              },
            ],
          }
        : {},
      toolLoop: {
        stagnationEpoch: 4,
        recent: [
          {
            category: "unchanged-failed-test-rerun",
            toolName: "run_command",
            ok: false,
            stagnationEpoch: 4,
          },
          {
            category: "workspace-patch",
            toolName: "apply_patch",
            ok: false,
            error: "Patch made no changes to report.md.",
            stagnationEpoch: 4,
          },
        ],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  patchContextRepairRuntime.testFailureRepairNeedsPatchContext,
  true,
  "a no-op repair patch did not request one bounded diagnostic source turn"
);
const consumedPatchContextRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        testRuns: [
          {
            command: "python -m pytest -q",
            mutationRevision: 0,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "baseline-failure",
          },
        ],
      },
      testFailurePatchContext: {
        mutationRevision: 0,
        failureSignature: "baseline-failure",
        at: "2026-08-24T01:00:00.000Z",
      },
      toolLoop: {
        stagnationEpoch: 4,
        recent: [
          {
            category: "unchanged-failed-test-rerun",
            toolName: "run_command",
            ok: false,
            stagnationEpoch: 4,
            at: "2026-08-24T00:59:58.000Z",
          },
          {
            category: "workspace-patch",
            toolName: "apply_patch",
            ok: false,
            error: "Patch made no changes to report.md.",
            stagnationEpoch: 4,
            at: "2026-08-24T01:00:00.000Z",
          },
          {
            toolName: "read_file",
            ok: true,
            blocked: false,
            stagnationEpoch: 4,
            at: "2026-08-24T01:00:01.000Z",
          },
        ],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  consumedPatchContextRepairRuntime.testFailureRepairNeedsPatchContext,
  false,
  "failed-test repair kept reopening discovery after one successful diagnostic source turn"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: consumedPatchContextRepairRuntime,
    goal: "Repair the current project after one bounded diagnostic source turn.",
    profile: "qa",
  }),
  ["apply_patch", "finish"],
  "a consumed failed-test diagnostic turn did not return to mutation-only mode"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: continuedFailedTestRepairRuntime,
    goal: "Verify the coherent repair before continuing.",
    profile: "qa",
  }),
  ["run_command", "finish"],
  "a completed repair mutation did not close broad tools until the retained test reran"
);

const pendingTestTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testVerificationPending: true,
    testVerificationCommand: "python -m unittest discover -s tests -v",
  },
  goal: "Verify the canonical mutation.",
  profile: "data",
});
sameNames(pendingTestTools, ["run_command", "finish"], "post-mutation verification offered unrelated tools");
assertStrict.deepEqual(
  pendingTestTools[0].function.parameters.properties.command.enum,
  ["python -m unittest discover -s tests -v"],
  "post-mutation verification did not constrain the exact retained test command"
);

const researchTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Research the latest primary sources and cite them.",
  profile: "research",
});
assert(names(researchTools).includes("web_search"), "research bundle omitted web_search");
assert(names(researchTools).includes("read_web_page"), "research bundle omitted read_web_page");
assert(names(researchTools).includes("web_research"), "research bundle omitted web_research");
assert(names(researchTools).includes("deep_research"), "research bundle omitted deep_research");
assert(!names(researchTools).includes("click"), "research bundle exposed unrelated browser interaction tools");

const explicitDeepResearchStarter = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal: "Write a deep web research report comparing at least three primary papers and one PDF.",
  profile: "research",
});
sameNames(
  explicitDeepResearchStarter,
  ["deep_research", "finish"],
  "explicit deep research did not start on the bounded provider-neutral tool surface"
);
const explicitDeepResearchFollowup = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal: "Write a deep web research report comparing at least three primary papers and one PDF.",
  profile: "research",
  messages: [{ role: "assistant", tool_calls: [{ id: "deep-1", function: { name: "deep_research", arguments: "{}" } }] }],
});
assert(names(explicitDeepResearchFollowup).includes("web_search"), "deep-research follow-up did not restore targeted recovery tools");

const localEvidenceResearchStarter = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal:
    "Investigate the reliability problem in this folder, correct PROJECT_NOTES.md, write an evidence review and sources.json, then commit the intentional work.",
  profile: "research",
});
assert(names(localEvidenceResearchStarter).includes("deep_research"), "local evidence research omitted deep_research");
assert(names(localEvidenceResearchStarter).includes("read_file"), "local evidence research omitted read_file");
assert(names(localEvidenceResearchStarter).includes("write_file"), "local evidence research omitted write_file");
assert(names(localEvidenceResearchStarter).includes("run_command"), "local evidence research omitted shell/git access");
assert(
  !(names(localEvidenceResearchStarter).length === 2 && names(localEvidenceResearchStarter)[0] === "deep_research"),
  "local evidence research was trapped on deep_research before reading its source material"
);
const localEvidenceResearchAfterInspection = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal:
    "Investigate the reliability problem in this folder, correct PROJECT_NOTES.md, write an evidence review and sources.json, then commit the intentional work.",
  profile: "research",
  messages: [
    {
      role: "user",
      content:
        "Investigate the reliability problem in this folder, correct PROJECT_NOTES.md, write an evidence review and sources.json, then commit the intentional work.",
    },
    {
      role: "assistant",
      tool_calls: [{ id: "local-notes", function: { name: "read_file", arguments: '{"path":"PROJECT_NOTES.md"}' } }],
    },
    {
      role: "assistant",
      tool_calls: [{ id: "local-sources", function: { name: "read_file", arguments: '{"path":"sources.json"}' } }],
    },
  ],
});
sameNames(
  localEvidenceResearchAfterInspection,
  ["deep_research", "finish"],
  "local evidence research did not enter the bounded research engine after inspection"
);
const retainedEvidenceManifestRepair = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal:
    "Investigate the reliability problem in this folder, write an evidence review and sources.json, then commit the intentional work.",
  profile: "research",
  messages: [
    {
      role: "user",
      content: [
        "Resume the saved evidence-review task.",
        "Do not restart the task, run deep_research, or reopen broad discovery.",
        "Use the retained completed evidence and rebuild sources.json.",
      ].join("\n"),
    },
    {
      role: "assistant",
      tool_calls: [{ id: "retained-sources", function: { name: "read_file", arguments: '{"path":"sources.json"}' } }],
    },
    {
      role: "assistant",
      tool_calls: [{ id: "retained-evidence", function: { name: "read_file", arguments: '{"path":"tmp/reliability-evidence-pass.md"}' } }],
    },
  ],
});
assert(
  names(retainedEvidenceManifestRepair).includes("write_file"),
  "retained-evidence manifest repair omitted write_file after inspection"
);
assert(
  names(retainedEvidenceManifestRepair).includes("read_file"),
  "retained-evidence manifest repair omitted bounded source reads"
);
assert(
  !(names(retainedEvidenceManifestRepair).length === 2 &&
    names(retainedEvidenceManifestRepair)[0] === "deep_research"),
  "explicit retained-evidence reuse was forced back into deep_research"
);
const localEvidenceAfterDeepResearchCompaction = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal:
    "Investigate the reliability problem in this folder, correct PROJECT_NOTES.md, write an evidence review and sources.json, then commit the intentional work.",
  profile: "research",
  messages: [
    {
      role: "user",
      content:
        "The runtime proactively compacted a long agent history before the provider context became inefficient or unstable.",
    },
    {
      role: "user",
      content: [
        "Retained runtime tool evidence. This operation already completed; use its result and do not repeat it solely because context was compacted.",
        "Tool: deep_research",
        'Arguments: {"query":"reliability evidence"}',
        'Verified result: {"ok":true,"version":14,"status":"completed"}',
      ].join("\n"),
    },
  ],
});
assert(
  names(localEvidenceAfterDeepResearchCompaction).includes("read_file"),
  "post-research compaction did not restore local workspace tools"
);
assert(
  !(names(localEvidenceAfterDeepResearchCompaction).length === 2 && names(localEvidenceAfterDeepResearchCompaction)[0] === "deep_research"),
  "post-research compaction forgot the completed bounded research call"
);

const documentRuntimeSnapshot =
  'Step 1/30. Latest runtime snapshot:\n{"pageText":"Workspace file tools are ready. Web search and resumable deep research are available when current evidence is required."}';
const localDocumentStarter = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal: "Turn the files in this folder into an editable, phone-friendly handoff and finish it properly.",
  profile: "word",
  messages: [
    { role: "user", content: "Turn the files in this folder into an editable, phone-friendly handoff and finish it properly." },
    { role: "user", content: documentRuntimeSnapshot },
  ],
});
assert(names(localDocumentStarter).includes("read_file"), "local document start omitted workspace reading tools");
assert(names(localDocumentStarter).includes("write_file"), "local document start omitted workspace writing tools");
assert(
  !(names(localDocumentStarter).length === 2 && names(localDocumentStarter)[0] === "deep_research"),
  "runtime snapshot prose forced a local document task into deep research"
);

const documentRepairAfterCompaction = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal: "Turn the files in this folder into an editable, phone-friendly handoff and finish it properly.",
  profile: "word",
  messages: [
    {
      role: "user",
      content:
        "The runtime proactively compacted a long agent history before the provider context became inefficient or unstable. Authoritative current goal: create the document.",
    },
    {
      role: "user",
      content:
        "The previous tool-call batch was rejected before dispatch. Reason code: TOOL_NOT_OFFERED. Rejected request: apply_patch. Tools offered in that turn: deep_research, finish.",
    },
    { role: "user", content: documentRuntimeSnapshot },
  ],
});
assert(names(documentRepairAfterCompaction).includes("apply_patch"), "document repair after compaction omitted apply_patch");
assert(names(documentRepairAfterCompaction).includes("run_command"), "document repair after compaction omitted build verification");
assert(
  !(names(documentRepairAfterCompaction).length === 2 && names(documentRepairAfterCompaction)[0] === "deep_research"),
  "post-failure runtime scaffolding regressed a local document repair into deep research"
);

const scopedArtifactPrompt = `You are a persistent workspace agent. The surrounding policy mentions an evidence review.
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"task","request":"Create one plain-text artifact and verify it."}
Repository evidence to consult as relevant: literature review, evidence review, research report.`;
const scopedArtifactTools = selectProgressiveTools(allTools, {
  config: { provider: "deepseek", progressiveTools: true },
  goal: scopedArtifactPrompt,
  profile: "auto",
  messages: [
    { role: "user", content: scopedArtifactPrompt },
    {
      role: "user",
      content: "Runtime snapshot: consult the surrounding literature review and evidence review policy before acting.",
    },
  ],
});
assert(names(scopedArtifactTools).includes("write_file"), "scoped artifact task omitted write_file");
assert(
  !(names(scopedArtifactTools).length === 2 && names(scopedArtifactTools)[0] === "deep_research"),
  "surrounding policy prose incorrectly forced a scoped artifact task into deep research"
);

const scopedDeepResearchPrompt = `Generic workspace policy.
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"task","request":"Write a deep research evidence review comparing three primary papers."}`;
const scopedDeepResearchTools = selectProgressiveTools(allTools, {
  config: { provider: "deepseek", progressiveTools: true },
  goal: scopedDeepResearchPrompt,
  profile: "auto",
  messages: [{ role: "user", content: scopedDeepResearchPrompt }],
});
sameNames(
  scopedDeepResearchTools,
  ["deep_research", "finish"],
  "explicit deep research inside the scoped user request was not preserved"
);

const writingTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Draft and revise a chapter, then save it.",
  profile: "writing",
});
sameNames(
  writingTools,
  ["writing_specialist", "read_file", "write_file", "apply_patch", "web_search", "send_to_canvas", "finish"],
  "writing task did not select the exact specialist bundle"
);

const longJobTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Run this download as a long-running background job.",
  profile: "auto",
});
sameNames(
  longJobTools,
  ["start_long_job", "long_job_status", "run_command", "inspect_project", "read_file", "send_to_canvas", "finish"],
  "long-running task did not select the exact background-job bundle"
);

const tmuxTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  profile: "auto",
  messages: [{ role: "user", content: "Use tmux to list sessions, capture the pane, and send keys." }],
});
sameNames(
  tmuxTools,
  [
    "tmux_list_sessions",
    "tmux_capture_pane",
    "tmux_send_keys",
    "tmux_start_session",
    "run_command",
    "inspect_project",
    "read_file",
    "finish",
  ],
  "tmux message did not select the exact session-coordination bundle"
);

const supervisionTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Continue supervising the worker.",
  profile: "supervision",
});
sameNames(supervisionTools, names(tmuxTools), "supervision profile did not preserve tmux coordination tools");

const pipelineTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Continue the workflow.",
  profile: "pipeline",
});
sameNames(
  pipelineTools,
  [
    "start_long_job",
    "long_job_status",
    "tmux_list_sessions",
    "tmux_capture_pane",
    "tmux_send_keys",
    "tmux_start_session",
    "run_command",
    "inspect_project",
    "read_file",
    "search_files",
    "apply_patch",
    "finish",
  ],
  "pipeline profile did not select its exact long-running coordination bundle"
);

const agentLinkTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Coordinate peer agents on a shared task board.",
  profile: "collaboration",
});
sameNames(
  agentLinkTools,
  [
    "agentlink_status",
    "agentlink_list_peers",
    "agentlink_create_board",
    "agentlink_get_board",
    "agentlink_send_message",
    "agentlink_claim_task",
    "agentlink_attach_evidence",
    "agentlink_summarize_session",
    "finish",
  ],
  "AgentLink profile did not select the exact collaboration bundle"
);

const mcpTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Use MCP resources and tools through the Model Context Protocol.",
  profile: "auto",
});
sameNames(
  mcpTools,
  [
    "mcp_list_servers",
    "mcp_list_tools",
    "mcp_call_tool",
    "mcp_list_resources",
    "mcp_read_resource",
    "mcp_list_prompts",
    "mcp_get_prompt",
    "finish",
  ],
  "MCP task did not select the exact bridge bundle"
);

const mixedMcpCodeGoal = "Use MCP to inspect the project, then implement the fix and run the tests.";
const mixedMcpCodeTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedMcpCodeGoal,
  profile: "auto",
});
sameNames(
  mixedMcpCodeTools,
  [
    "mcp_list_servers",
    "mcp_list_tools",
    "mcp_call_tool",
    "read_file",
    "search_files",
    "write_file",
    "apply_patch",
    "run_command",
    "mcp_list_resources",
    "mcp_read_resource",
    "inspect_project",
    "finish",
  ],
  "mixed MCP/code discovery phase did not reserve implementation and verification tools"
);

const mixedMcpFixTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Inspect the issue through MCP, then fix it and verify the result.",
  profile: "auto",
});
for (const requiredName of ["mcp_call_tool", "write_file", "apply_patch", "run_command"]) {
  assert(names(mixedMcpFixTools).includes(requiredName), `mixed MCP/fix inference omitted ${requiredName}`);
}

const completedMcpMessages = [
  { role: "user", content: `Goal: ${mixedMcpCodeGoal}` },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "mcp-discovery-1",
        type: "function",
        function: { name: "mcp_list_servers", arguments: "{}" },
      },
    ],
  },
  { role: "tool", tool_call_id: "mcp-discovery-1", content: '{"ok":true}' },
];
const mixedMcpImplementationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedMcpCodeGoal,
  profile: "auto",
  messages: completedMcpMessages,
});
sameNames(
  mixedMcpImplementationTools,
  [
    "run_command",
    "inspect_project",
    "list_files",
    "read_file",
    "search_files",
    "write_file",
    "apply_patch",
    "mcp_list_tools",
    "mcp_call_tool",
    "mcp_list_resources",
    "mcp_read_resource",
    "finish",
  ],
  "completed MCP discovery did not escalate to the code-first implementation phase"
);

const mixedMcpVerificationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedMcpCodeGoal,
  profile: "auto",
  messages: [
    ...completedMcpMessages,
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "edit-1",
          type: "function",
          function: { name: "apply_patch", arguments: '{"patch":"fixture"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "edit-1", content: '{"ok":true}' },
  ],
});
sameNames(
  mixedMcpVerificationTools,
  [
    "run_command",
    "read_file",
    "search_files",
    "inspect_project",
    "apply_patch",
    "write_file",
    "list_files",
    "mcp_list_tools",
    "mcp_call_tool",
    "mcp_list_resources",
    "mcp_read_resource",
    "finish",
  ],
  "completed edit did not advance the mixed workflow to verification-first ordering"
);

const unresolvedMcpCallTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedMcpCodeGoal,
  profile: "auto",
  messages: completedMcpMessages.slice(0, -1),
});
sameNames(
  unresolvedMcpCallTools,
  names(mixedMcpCodeTools),
  "an MCP request without a matching tool result incorrectly advanced the workflow phase"
);

const newRequestBoundaryTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedMcpCodeGoal,
  profile: "auto",
  messages: [
    ...completedMcpMessages,
    { role: "user", content: `Continue with this new request: ${mixedMcpCodeGoal}` },
  ],
});
sameNames(
  newRequestBoundaryTools,
  names(mixedMcpCodeTools),
  "completed tools from an earlier continuation leaked into the new workflow phase"
);

const mixedResearchCodeTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Research the current primary documentation, then implement the fix and test it.",
  profile: "auto",
});
for (const requiredName of ["web_search", "web_research", "write_file", "apply_patch", "run_command"]) {
  assert(names(mixedResearchCodeTools).includes(requiredName), `mixed research/code phase omitted ${requiredName}`);
}
assert(mixedResearchCodeTools.length <= 12, "mixed research/code phase exceeded the default local limit");

const mixedAgentLinkCodeGoal = "Use AgentLink peers to coordinate, then fix the code and run tests.";
const mixedAgentLinkCodeTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedAgentLinkCodeGoal,
});
for (const requiredName of [
  "agentlink_status",
  "agentlink_list_peers",
  "agentlink_create_board",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "run_command",
  "finish",
]) {
  assert(
    names(mixedAgentLinkCodeTools).includes(requiredName),
    `mixed AgentLink/code coordination phase omitted ${requiredName}`
  );
}
assert(mixedAgentLinkCodeTools.length <= 12, "mixed AgentLink/code phase exceeded the default local limit");

const mixedAgentLinkImplementationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedAgentLinkCodeGoal,
  messages: [
    { role: "user", content: `Goal: ${mixedAgentLinkCodeGoal}` },
    {
      role: "assistant",
      tool_calls: [
        { id: "agentlink-call-1", type: "function", function: { name: "agentlink_create_board", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "agentlink-call-1", content: '{"ok":true,"boardId":"board-1"}' },
  ],
});
for (const requiredName of ["read_file", "search_files", "write_file", "apply_patch", "run_command", "agentlink_get_board", "finish"]) {
  assert(
    names(mixedAgentLinkImplementationTools).includes(requiredName),
    `completed AgentLink coordination did not retain ${requiredName} for implementation`
  );
}
assert(
  names(mixedAgentLinkImplementationTools)[0] === "run_command",
  "completed AgentLink coordination did not advance to a code-first phase"
);

const disabledMixedMcpCodeTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", allowFileTools: false, allowShellTool: false },
  goal: mixedMcpCodeGoal,
  profile: "auto",
});
for (const disabledName of ["read_file", "search_files", "write_file", "apply_patch", "run_command"]) {
  assert(!names(disabledMixedMcpCodeTools).includes(disabledName), `mixed workflow leaked disabled tool ${disabledName}`);
}
assert(names(disabledMixedMcpCodeTools).includes("mcp_call_tool"), "mixed workflow lost its enabled MCP capability");

const jsonTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Use the JSON specialist for schema-bound extraction into strict structured JSON.",
  profile: "auto",
});
sameNames(
  jsonTools,
  ["json_specialist", "json_specialist_batch", "read_file", "write_file", "search_files", "send_to_canvas", "finish"],
  "structured JSON task did not select the exact specialist bundle"
);

const imageReadTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Use image perception to analyze the supplied PNG.",
  profile: "vision",
});
sameNames(imageReadTools, ["read_image", "send_to_canvas", "finish"], "vision task did not select the exact perception bundle");

const retainedTextWorkspaceTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    integrationSessionProfile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
    integrationAllowedToolNames: INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES,
    allowImagePerception: false,
  },
  goal: "Inspect the screenshot, edit the project, and preview it in a browser.",
  profile: "vision",
});
for (const selected of names(retainedTextWorkspaceTools)) {
  assert(
    INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES.includes(selected),
    `retained text-workspace leaked disallowed tool ${selected}`
  );
}
assert(!names(retainedTextWorkspaceTools).includes("read_image"), "retained text-workspace exposed read_image");
assert(!names(retainedTextWorkspaceTools).includes("run_command"), "retained text-workspace exposed run_command");
assert(!names(retainedTextWorkspaceTools).includes("send_to_canvas"), "retained text-workspace exposed canvas");
assert(!names(retainedTextWorkspaceTools).includes("open_url"), "retained text-workspace exposed browser tools");
assert(names(retainedTextWorkspaceTools).includes("finish"), "retained text-workspace lost finish");
const forgedReadImageBlock = integrationTextWorkspaceToolExecutionBlock(
  { integrationSessionProfile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID },
  "read_image"
);
assert(forgedReadImageBlock?.blocked === true, "executeTool second-line gate accepted forged read_image");
const forgedRunCommandBlock = integrationTextWorkspaceToolExecutionBlock(
  { integrationSessionProfile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID },
  "run_command"
);
assert(forgedRunCommandBlock?.blocked === true, "executeTool second-line gate accepted forged run_command");
assert(
  integrationTextWorkspaceToolExecutionBlock(
    { integrationSessionProfile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID },
    "read_file"
  ) === null,
  "executeTool second-line gate blocked an allowed text tool"
);

const imageGenerationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", allowAuxiliaryTools: true },
  goal: "Generate a raster illustration.",
  profile: "image",
});
sameNames(
  imageGenerationTools,
  ["generate_image", "read_image", "write_file", "send_to_canvas", "finish"],
  "image task did not select the exact generation bundle"
);

const imageGenerationOffTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Generate a raster illustration.",
  profile: "image",
});
assert(!names(imageGenerationOffTools).includes("generate_image"), "local image generation was exposed without explicit enablement");

const canvasTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Send the finished artifact to the canvas.",
  profile: "canvas",
});
sameNames(canvasTools, ["send_to_canvas", "read_file", "write_file", "finish"], "canvas task did not select the exact artifact bundle");

const explicitProfileTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  profile: {
    id: "custom",
    tools: ["MCP_CALL_TOOL", "custom_hosted_tool", "not_registered", "finish"],
  },
});
sameNames(
  explicitProfileTools,
  ["mcp_call_tool", "finish"],
  "explicit profile tools were not safely intersected with compact registered tools"
);

const disabledTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    allowFileTools: false,
    allowShellTool: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowBrowserTools: false,
    allowCanvasTools: false,
  },
  profile: "auto",
});
sameNames(disabledTools, ["finish"], "disabled feature flags left compact tools exposed");

const disabledBundleCases = [
  {
    label: "background jobs",
    config: { allowLongJobTools: false },
    goal: "Run this as a long-running background job.",
    expected: ["run_command", "inspect_project", "read_file", "send_to_canvas", "finish"],
  },
  {
    label: "tmux",
    config: { allowTmuxTools: false },
    goal: "Use tmux to capture the pane and send keys.",
    expected: ["run_command", "inspect_project", "read_file", "finish"],
  },
  {
    label: "AgentLink",
    config: { allowAgentLinkTools: false },
    goal: "Use AgentLink with peer agents and a shared task board.",
    expected: ["finish"],
  },
  {
    label: "MCP",
    config: { allowMcpTools: false },
    goal: "Use MCP resources through the Model Context Protocol.",
    expected: ["finish"],
  },
  {
    label: "JSON specialist",
    config: { allowJsonTools: false },
    goal: "Use the JSON specialist for strict structured JSON.",
    expected: ["read_file", "write_file", "search_files", "send_to_canvas", "finish"],
  },
  {
    label: "image generation",
    config: { allowAuxiliaryTools: false },
    goal: "Generate a raster illustration.",
    expected: ["read_image", "write_file", "send_to_canvas", "finish"],
  },
  {
    label: "image perception",
    config: { allowVisionTools: false },
    goal: "Use image perception to analyze the supplied PNG.",
    expected: ["send_to_canvas", "finish"],
  },
  {
    label: "canvas",
    config: { allowCanvasTools: false },
    goal: "Send the finished artifact to the canvas.",
    expected: ["read_file", "write_file", "finish"],
  },
  {
    label: "writing specialist",
    config: { allowWritingTools: false },
    goal: "Draft and revise a novel chapter.",
    expected: ["read_file", "write_file", "apply_patch", "web_search", "send_to_canvas", "finish"],
  },
];
for (const testCase of disabledBundleCases) {
  const selected = selectProgressiveTools(allTools, {
    config: { provider: "localllm", ...testCase.config },
    goal: testCase.goal,
    profile: "auto",
  });
  sameNames(selected, testCase.expected, `${testCase.label} allow flag was not enforced`);
}

const disabledFullTools = selectProgressiveTools(allTools, {
  config: {
    provider: "openai",
    allowFileTools: false,
    allowShellTool: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowBrowserTools: false,
    allowCanvasTools: false,
  },
});
const disabledFullNames = names(disabledFullTools);
for (const disabledName of [
  "run_command",
  "read_file",
  "read_image",
  "web_search",
  "read_web_page",
  "web_research",
  "deep_research",
  "mcp_call_tool",
  "delegate_agent",
  "research_wrapper",
  "generate_image",
  "open_url",
  "click",
  "send_to_canvas",
]) {
  assert(!disabledFullNames.includes(disabledName), `hosted full policy leaked disabled tool ${disabledName}`);
}
assert(disabledFullNames.includes("custom_hosted_tool"), "feature filtering removed an unrelated hosted tool");
assert(disabledFullNames.includes("finish"), "feature filtering removed finish");

const unknownProfileTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  profile: "not-a-real-profile",
});
sameNames(
  unknownProfileTools,
  LOCAL_COMPACT_GENERAL_TOOL_NAMES,
  "unknown profile did not fall back to the compact general set"
);
assert(!names(unknownProfileTools).includes("read_image"), "general fallback exposed vision without image intent");

const messageInferredTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  profile: "auto",
  messages: [{ role: "user", content: "Please research current primary sources and cite them." }],
});
assert(names(messageInferredTools).includes("web_research"), "message text did not drive task-aware selection");
assert(!names(messageInferredTools).includes("run_command"), "message-inferred research leaked the code shell tool");

const hostedInput = [...allTools, { type: "invalid", function: { name: "invalid_tool" } }, allTools[0]];
const hostedTools = selectProgressiveTools(hostedInput, {
  config: { provider: "openai", allowWrapperTools: true, allowAuxiliaryTools: true },
  profile: "code",
});
sameNames(hostedTools, knownNames, "hosted auto policy did not preserve the complete valid tool surface");
assert(hostedTools.every((item) => hostedInput.includes(item)), "hosted selection manufactured a descriptor");

const explicitFullTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", toolSurfacePolicy: "full", allowWrapperTools: true, allowAuxiliaryTools: true },
});
sameNames(explicitFullTools, knownNames, "explicit full policy did not preserve the local tool surface");

const hardCapTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    allowAuxiliaryTools: true,
    toolSurfaceMaxTools: 999,
    toolSurfaceMaxChars: 100_000,
  },
  goal:
    "Start a long-running background code job in tmux, coordinate peer agents with AgentLink, use MCP and the JSON specialist, generate an image, and send the artifact to canvas.",
  profile: "auto",
});
assert(hardCapTools.length === LOCAL_TOOL_HARD_CAP, "compact mixed-task selection did not exercise the hard cap");
assert(hardCapTools.at(-1)?.function?.name === "finish", "hard-capped selection did not reserve finish");
assert(hardCapTools.every((item) => allTools.includes(item)), "hard-capped selection manufactured a descriptor");

for (const selected of [
  codeTools,
  browserTools,
  researchTools,
  writingTools,
  longJobTools,
  tmuxTools,
  supervisionTools,
  pipelineTools,
  agentLinkTools,
  mcpTools,
  jsonTools,
  imageReadTools,
  imageGenerationTools,
  canvasTools,
]) {
  assert(selected.length <= 12, `default local bundle exceeded 12 tools: ${names(selected).join(", ")}`);
  assert(selected.at(-1)?.function?.name === "finish", "default local bundle did not retain finish");
  assert(selected.every((item) => allTools.includes(item)), "default local bundle manufactured a descriptor");
}

const bulkyTools = knownNames.map((name) => tool(name, `${name}: ${"schema detail ".repeat(180)}`));
const sizeBoundTools = selectProgressiveTools(bulkyTools, {
  config: { provider: "localllm" },
  profile: "auto",
});
assert(
  JSON.stringify(sizeBoundTools).length <= DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET,
  "compact selection exceeded its serialized schema-size target"
);
assert(sizeBoundTools.at(-1)?.function?.name === "finish", "size-bounded selection omitted finish");

const localBoundaryTools = await captureRequestTools();
assert(
  JSON.stringify(enumFor(localBoundaryTools, "writing_specialist", "provider")) === JSON.stringify(["localllm"]),
  "LocalLLM tool schema exposed a cross-provider writing route"
);
assert(
  JSON.stringify(enumFor(localBoundaryTools, "json_specialist", "provider")) === JSON.stringify(["localllm"]),
  "LocalLLM tool schema exposed a cross-provider JSON route"
);
assert(
  JSON.stringify(enumFor(localBoundaryTools, "read_image", "provider")) === JSON.stringify(["auto", "localllm"]),
  "LocalLLM tool schema exposed hosted image perception"
);
assert(
  JSON.stringify(enumFor(localBoundaryTools, "web_research", "mode")) === JSON.stringify(["snippets"]),
  "LocalLLM tool schema exposed hosted web synthesis"
);

const explicitlyHostedTools = await captureRequestTools({
  allowHostedImagePerception: true,
  allowHostedWebResearch: true,
  allowHostedJsonSpecialist: true,
  allowHostedWritingSpecialist: true,
});
assert(enumFor(explicitlyHostedTools, "writing_specialist", "provider").includes("openai"), "explicit writer permission did not expose hosted providers");
assert(enumFor(explicitlyHostedTools, "json_specialist", "provider").includes("openai"), "explicit JSON permission did not expose hosted providers");
assert(enumFor(explicitlyHostedTools, "read_image", "provider").includes("openai"), "explicit image permission did not expose OpenAI");
assert(enumFor(explicitlyHostedTools, "web_research", "mode").includes("openai"), "explicit research permission did not expose OpenAI");

function contractCall(id, name, args, { raw = false } = {}) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: raw ? args : JSON.stringify(args),
    },
  };
}

const focusedTranslationRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "agintiflow-focused-write-translation-")
);
try {
  const currentFocusedContent = [
    "# Report",
    "The earlier marker is incorrect.",
    "Keep this trailing evidence.",
  ].join("\n");
  const proposedFocusedContent = [
    "# Report",
    "The required marker is correct.",
    "Keep this trailing evidence.",
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(focusedTranslationRoot, "report.md"),
    currentFocusedContent,
    "utf8"
  );
  const focusedContract = createToolContract([focusedApplyPatch]);
  const rejectedWholeFileCall = contractCall("focused-whole-file", "write_file", {
    path: "report.md",
    content: proposedFocusedContent,
    mode: "overwrite",
  });
  const rejectedWholeFileValidation = resolveDispatchableToolCallBatch(
    [rejectedWholeFileCall],
    focusedContract
  );
  assert(!rejectedWholeFileValidation.ok, "unoffered whole-file write unexpectedly passed directly");
  const translatedFocusedWrite = await recoverFocusedWholeFileWriteAsExactPatch(
    { commandCwd: focusedTranslationRoot },
    {
      meta: {
        failedTestDiagnostic: {
          focuses: [
            {
              kind: "membership",
              path: "report.md",
              directSearch: "The earlier marker is incorrect.",
            },
          ],
        },
      },
    },
    [rejectedWholeFileCall],
    focusedContract,
    rejectedWholeFileValidation
  );
  assert(translatedFocusedWrite?.ok, "lossless focused whole-file intent was not translated");
  assert(translatedFocusedWrite.recoveredFocusedWholeFileWrite, "focused translation was not marked");
  assert(
    translatedFocusedWrite.terminalNewlineNormalized,
    "focused translation did not record its bounded terminal-newline normalization"
  );
  assertStrict.deepEqual(
    JSON.parse(translatedFocusedWrite.acceptedToolCalls[0].function.arguments),
    {
      path: "report.md",
      search: "The earlier marker is incorrect.",
      replace: "The required marker is correct.",
    },
    "focused whole-file intent did not become the exact minimal patch"
  );
  assertStrict.equal(
    await fs.readFile(path.join(focusedTranslationRoot, "report.md"), "utf8"),
    currentFocusedContent,
    "intent translation mutated the workspace before normal tool dispatch"
  );

  const driftingWholeFileCall = contractCall("drifting-whole-file", "write_file", {
    path: "report.md",
    content: proposedFocusedContent.replace("Keep this trailing evidence.", "Unrelated drift."),
    mode: "overwrite",
  });
  assertStrict.equal(
    await recoverFocusedWholeFileWriteAsExactPatch(
      { commandCwd: focusedTranslationRoot },
      {
        meta: {
          failedTestDiagnostic: {
            focuses: [
              {
                kind: "membership",
                path: "report.md",
                directSearch: "The earlier marker is incorrect.",
              },
            ],
          },
        },
      },
      [driftingWholeFileCall],
      focusedContract,
      resolveDispatchableToolCallBatch([driftingWholeFileCall], focusedContract)
    ),
    null,
    "whole-file intent with unrelated drift was translated into a focused mutation"
  );
} finally {
  await fs.rm(focusedTranslationRoot, { recursive: true, force: true });
}

const strictWriteDescriptor = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["create", "overwrite"] },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};
const strictContract = createToolContract([strictWriteDescriptor]);
assert(
  validateToolCallBatch(
    [contractCall("valid-write", "write_file", { path: "valid.txt", content: "ok", mode: "create" })],
    strictContract
  ).ok,
  "valid offered tool call did not satisfy its exact schema"
);

const safeReadDescriptors = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search files.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, query: { type: "string" } },
        required: ["path", "query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];
const safeReadCalls = [
  contractCall("safe-read", "read_file", { path: "AGENTS.md" }),
  contractCall("safe-search", "search_files", { path: ".", query: "lazyedit" }),
  contractCall("safe-list", "list_files", { path: "." }),
];
const safeReadContract = createToolContract(safeReadDescriptors);
assert(safeSequentialToolBatchLimit(safeReadCalls) === 4, "safe read batch did not receive the bounded sequential allowance");
assert(
  validateToolCallBatch(safeReadCalls, safeReadContract, {
    maxToolCalls: safeSequentialToolBatchLimit(safeReadCalls),
  }).ok,
  "valid safe read batch did not pass the exact per-turn contract"
);
const singletonReadContract = createToolContract([
  {
    ...safeReadDescriptors[0],
    function: {
      ...safeReadDescriptors[0].function,
      parameters: {
        ...safeReadDescriptors[0].function.parameters,
        properties: { path: { type: "string", enum: ["README.md"] } },
      },
    },
  },
]);
const repairedSingletonRead = resolveDispatchableToolCallBatch(
  [contractCall("wrong-singleton-read", "read_file", { path: "raw/run_a.csv" })],
  singletonReadContract
);
assert(repairedSingletonRead.ok, "singleton read-only enum mismatch was not repaired");
assert(repairedSingletonRead.recoveredSingletonEnums, "singleton enum recovery was not recorded");
assertStrict.deepEqual(
  JSON.parse(repairedSingletonRead.acceptedToolCalls[0].function.arguments),
  { path: "README.md" },
  "singleton enum recovery did not dispatch the only contract-authorized path"
);
const multipleReadChoices = createToolContract([
  {
    ...safeReadDescriptors[0],
    function: {
      ...safeReadDescriptors[0].function,
      parameters: {
        ...safeReadDescriptors[0].function.parameters,
        properties: { path: { type: "string", enum: ["README.md", "AGENTS.md"] } },
      },
    },
  },
]);
assert(
  !resolveDispatchableToolCallBatch(
    [contractCall("wrong-multi-read", "read_file", { path: "raw/run_a.csv" })],
    multipleReadChoices
  ).ok,
  "multi-choice read enum was silently rewritten"
);
const unsafeSingletonWrite = createToolContract([
  {
    ...strictWriteDescriptor,
    function: {
      ...strictWriteDescriptor.function,
      parameters: {
        ...strictWriteDescriptor.function.parameters,
        properties: {
          ...strictWriteDescriptor.function.parameters.properties,
          mode: { type: "string", enum: ["create"] },
        },
      },
    },
  },
]);
assert(
  !resolveDispatchableToolCallBatch(
    [contractCall("wrong-singleton-write", "write_file", { path: "unsafe.txt", content: "x", mode: "overwrite" })],
    unsafeSingletonWrite
  ).ok,
  "write argument was rewritten through read-only singleton recovery"
);
const mixedReadWriteCalls = [
  safeReadCalls[0],
  contractCall("unsafe-write", "write_file", { path: "blocked.txt", content: "bad" }),
];
assert(safeSequentialToolBatchLimit(mixedReadWriteCalls) === 1, "mixed read/write batch escaped the single-call limit");
assert(
  !validateToolCallBatch(mixedReadWriteCalls, createToolContract([...safeReadDescriptors, strictWriteDescriptor]), {
    maxToolCalls: safeSequentialToolBatchLimit(mixedReadWriteCalls),
  }).ok,
  "mixed read/write batch unexpectedly passed"
);
const recoveredMixedBatch = resolveDispatchableToolCallBatch(
  mixedReadWriteCalls,
  createToolContract([...safeReadDescriptors, strictWriteDescriptor])
);
assert(recoveredMixedBatch.ok, "valid mixed batch could not recover through bounded sequential deferral");
assert(recoveredMixedBatch.recoveredSequentially, "mixed batch recovery was not recorded");
assert(recoveredMixedBatch.acceptedToolCalls.length === 1, "mixed batch recovery dispatched more than one call");
assert(recoveredMixedBatch.deferredToolCalls.length === 1, "mixed batch recovery did not defer the extra call");
const fiveCallMixedBatch = [
  ...safeReadCalls,
  contractCall("safe-read-four", "read_file", { path: "fourth.txt" }),
  contractCall("deferred-write-five", "write_file", { path: "later.txt", content: "later" }),
];
const recoveredFiveCallMixedBatch = resolveDispatchableToolCallBatch(
  fiveCallMixedBatch,
  createToolContract([...safeReadDescriptors, strictWriteDescriptor])
);
assert(recoveredFiveCallMixedBatch.ok, "five-call mixed batch was rejected instead of bounded deferral");
assert(
  recoveredFiveCallMixedBatch.acceptedToolCalls.length === 1 &&
    recoveredFiveCallMixedBatch.deferredToolCalls.length === 4,
  "five-call mixed batch did not dispatch exactly one call and preserve the suffix"
);
assert(
  recoveredFiveCallMixedBatch.deferredToolCalls.at(-1)?.function?.name === "write_file",
  "bounded mixed recovery lost or executed the deferred write"
);
const oversizedReadCalls = Array.from({ length: 5 }, (_, index) =>
  contractCall(`read-${index}`, "read_file", { path: `file-${index}.txt` })
);
assert(
  !validateToolCallBatch(oversizedReadCalls, safeReadContract, {
    maxToolCalls: safeSequentialToolBatchLimit(oversizedReadCalls),
  }).ok,
  "oversized read batch escaped the bounded allowance"
);
const recoveredOversizedReadBatch = resolveDispatchableToolCallBatch(oversizedReadCalls, safeReadContract);
assert(recoveredOversizedReadBatch.ok, "oversized safe read batch was not recoverable in a bounded chunk");
assert(recoveredOversizedReadBatch.recoveredSequentially, "oversized safe read recovery was not recorded");
assert(recoveredOversizedReadBatch.acceptedToolCalls.length === 4, "oversized safe read recovery dispatched the wrong chunk size");
assert(recoveredOversizedReadBatch.deferredToolCalls.length === 1, "oversized safe read recovery lost its deferred suffix");
const excessiveReadBatch = Array.from({ length: 13 }, (_, index) =>
  contractCall(`excessive-read-${index}`, "read_file", { path: `file-${index}.txt` })
);
assert(
  !resolveDispatchableToolCallBatch(excessiveReadBatch, safeReadContract).ok,
  "unbounded safe read batch escaped the reported-call cap"
);
assert(
  !resolveDispatchableToolCallBatch(
    [...excessiveReadBatch.slice(0, 12), contractCall("excessive-write", "write_file", { path: "later.txt", content: "later" })],
    createToolContract([...safeReadDescriptors, strictWriteDescriptor])
  ).ok,
  "unbounded mixed batch escaped the reported-call cap"
);

for (const [label, call, expectedCode] of [
  [
    "hidden dryRun",
    contractCall("hidden-dry-run", "write_file", { path: "blocked.txt", content: "bad", dryRun: false }),
    "ARGUMENT_ADDITIONAL_PROPERTY",
  ],
  ["missing required", contractCall("missing", "write_file", { path: "blocked.txt" }), "ARGUMENT_REQUIRED_PROPERTY_MISSING"],
  [
    "wrong type",
    contractCall("wrong-type", "write_file", { path: 42, content: "bad" }),
    "ARGUMENT_WRONG_TYPE",
  ],
  [
    "invalid enum",
    contractCall("bad-enum", "write_file", { path: "blocked.txt", content: "bad", mode: "append" }),
    "ARGUMENT_ENUM_MISMATCH",
  ],
  ["unoffered tool", contractCall("unoffered", "run_command", { command: "touch blocked.txt" }), "TOOL_NOT_OFFERED"],
  ["malformed JSON", contractCall("bad-json", "write_file", "{", { raw: true }), "TOOL_ARGUMENTS_INVALID_JSON"],
  ["empty id", contractCall("", "write_file", { path: "blocked.txt", content: "bad" }), "TOOL_CALL_ID_EMPTY"],
]) {
  const validation = validateToolCallBatch([call], strictContract);
  assert(!validation.ok, `${label} call unexpectedly passed the tool contract`);
  assert(
    validation.errors.some((error) => error.code === expectedCode),
    `${label} call did not report ${expectedCode}: ${JSON.stringify(validation.errors)}`
  );
}

const duplicateBatchValidation = validateToolCallBatch(
  [
    contractCall("duplicate", "write_file", { path: "one.txt", content: "one" }),
    contractCall("duplicate", "write_file", { path: "two.txt", content: "two" }),
  ],
  strictContract
);
assert(!duplicateBatchValidation.ok, "duplicate-id multi-call batch unexpectedly passed");
assert(duplicateBatchValidation.errors.some((error) => error.code === "TOO_MANY_TOOL_CALLS"), "multi-call batch did not enforce the strict cap");
assert(duplicateBatchValidation.errors.some((error) => error.code === "TOOL_CALL_ID_DUPLICATE"), "duplicate tool-call id was not rejected");

const attachedResponse = attachToolContract({ choices: [] }, [strictWriteDescriptor]);
const attachedContract = toolContractFromResponse(attachedResponse);
assertStrict.deepEqual(attachedContract?.tools, [strictWriteDescriptor], "attached tool descriptors changed value");
assert(Object.isFrozen(attachedContract?.tools), "attached descriptor list was mutable");
assert(Object.isFrozen(attachedContract?.tools?.[0]?.function?.parameters), "attached tool schema was mutable");

function assistantWithToolCalls(toolCalls) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: toolCalls,
        },
      },
    ],
  };
}

async function runToolContractCase({
  id,
  provider = "localllm",
  profile = "code",
  goal,
  toolCalls,
  textFallback = false,
  allowShellTool = false,
  toolSurfaceMaxTools = 12,
  targets = [],
  expectedTargets = [],
  followupToolCalls = null,
  expectSequentialRecovery = false,
  expectSuccess = false,
  expectedContractFailures = 0,
  maxSteps = 3,
  responseFactory = null,
  setupWorkspace = null,
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `agintiflow-tool-contract-${id}-`));
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  await fs.mkdir(workspace, { recursive: true });
  if (typeof setupWorkspace === "function") await setupWorkspace(workspace);
  const requests = [];
  let clientFactoryCalls = 0;
  const responseText = `[TOOL_CALLS]${toolCalls[0]?.function?.name || "finish"}[ARGS]${toolCalls[0]?.function?.arguments || "{}"}`;
  const client = {
    chat: {
      completions: {
        create: async (payload) => {
          requests.push(payload);
          if (typeof responseFactory === "function") {
            return responseFactory({ payload, requests, workspace });
          }
          if (textFallback && Array.isArray(payload.tools)) {
            throw new Error("invalid request parameters: tools");
          }
          if (textFallback) {
            return { choices: [{ message: { role: "assistant", content: responseText } }] };
          }
          const selectedToolCalls = Array.isArray(followupToolCalls) && requests.length > 1
            ? followupToolCalls
            : toolCalls;
          return assistantWithToolCalls(selectedToolCalls);
        },
      },
    },
  };
  const clientFactory = async () => {
    clientFactoryCalls += 1;
    return client;
  };
  clientFactory.agintiDeterministicTest = true;
  const scriptedModel = provider === "localllm" ? "localllm-fast" : "scripted-tool-contract-model";
  const config = resolveRuntimeConfig(
    {
      provider,
      routingMode: "manual",
      model: scriptedModel,
      goal,
      taskProfile: profile,
      allowShellTool,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      provider,
      routingMode: "manual",
      model: scriptedModel,
      sessionId: id,
      commandCwd: workspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      allowShellTool,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      clientFactory,
    }
  );
  Object.assign(config, {
    apiKey: provider === "localllm" ? "local-dev-key" : "scripted-test-only",
    baseURL: provider === "localllm" ? "http://127.0.0.1:8008/v1" : config.baseURL,
    clientFactory,
    providerReadinessMode: provider === "localllm" ? "deterministic-test" : config.providerReadinessMode,
    sessionsDir,
    projectSessionsDir,
    taskProfile: profile,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    permissionMode: "danger",
    allowShellTool,
    allowFileTools: true,
    allowBrowserTools: false,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    allowLocalAutoMax: false,
    scsActive: false,
    enableScs: "off",
    executionPolicy: { tier: "focused", requiresPlan: false, reason: "Focused deterministic contract smoke." },
    routeComplexityScore: 0,
    maxSteps,
    maxStepsExplicit: true,
    dynamicSteps: "off",
    contextBudgetMode: "off",
    toolSurfacePolicy: "compact",
    toolSurfaceMaxTools,
    modelTimeoutMs: 1_000,
    headless: true,
    onConsole: () => {},
  });

  try {
    const result = await runAgent(config);
    const store = new SessionStore(sessionsDir, id, {
      projectRoot: workspace,
      commandCwd: workspace,
      projectSessionsDir,
    });
    const events = await store.loadEvents();
    const contractFailures = events.filter((event) => event.type === "tool.failed" && event.data?.category === "tool-contract-violation");
    assert(clientFactoryCalls === 1, `${id} did not complete readiness and construct exactly one deterministic client`);
    if (expectSuccess) {
      assert(result.stopped !== true, `${id} stopped instead of recovering: ${JSON.stringify(result)}`);
      assert(
        contractFailures.length === expectedContractFailures,
        `${id} recorded ${contractFailures.length} tool-contract failures; expected ${expectedContractFailures}`
      );
      for (const target of expectedTargets) {
        const exists = await fs.access(path.join(workspace, target)).then(() => true).catch(() => false);
        assert(exists, `${id} did not preserve expected workspace file ${target}`);
      }
      return { result, requests, events, contractFailures, clientFactoryCalls };
    }
    if (expectSequentialRecovery) {
      assert(result.stopped !== true, `${id} stopped instead of completing the recovered sequential batch`);
      assert(contractFailures.length === 0, `${id} recorded a contract failure for a recoverable valid batch`);
      assert(
        events.some((event) => event.type === "tool.batch_deferred" && event.data?.deferredCount === toolCalls.length - 1),
        `${id} did not record bounded sequential deferral`
      );
      for (const target of expectedTargets) {
        const exists = await fs.access(path.join(workspace, target)).then(() => true).catch(() => false);
        assert(exists, `${id} did not create expected artifact ${target}`);
      }
      for (const target of targets) {
        const exists = await fs.access(path.join(workspace, target)).then(() => true).catch(() => false);
        assert(!exists, `${id} dispatched deferred artifact ${target}`);
      }
      return { result, requests, events, contractFailures, clientFactoryCalls };
    }
    assert(
      result.stopped === true && result.reason === "tool_contract_violation",
      `${id} did not stop after one bounded repair: ${JSON.stringify({
        result,
        failures: contractFailures.map((event) => event.data),
        toolSurfaces: requests.filter((request) => Array.isArray(request.tools)).map((request) => names(request.tools)),
      })}`
    );
    assert(contractFailures.length === 2, `${id} did not record exactly two bounded contract failures`);
    assert(!events.some((event) => event.type === "tool.started"), `${id} dispatched a tool from an invalid batch`);
    assert(!events.some((event) => event.type === "tool.completed"), `${id} completed a tool from an invalid batch`);
    for (const target of targets) {
      const exists = await fs.access(path.join(workspace, target)).then(() => true).catch(() => false);
      assert(!exists, `${id} created forbidden artifact ${target}`);
    }
    return { result, requests, events, contractFailures, clientFactoryCalls };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const hiddenDryRun = await runToolContractCase({
  id: "native-hidden-dry-run",
  goal: "Create hidden-dry-run.txt containing unsafe if this tool dispatches.",
  toolCalls: [
    contractCall("native-hidden", "write_file", {
      path: "hidden-dry-run.txt",
      content: "unsafe",
      mode: "create",
      dryRun: false,
    }),
  ],
  targets: ["hidden-dry-run.txt"],
});
assert(
  hiddenDryRun.contractFailures.every((event) =>
    event.data?.errors?.some((error) => error.code === "ARGUMENT_ADDITIONAL_PROPERTY")
  ),
  "native hidden dryRun was not rejected as an additional property"
);
assert(
  hiddenDryRun.requests.every((request) => request.parallel_tool_calls === false),
  "native requests did not keep parallel_tool_calls=false authoritative"
);

const unofferedFallback = await runToolContractCase({
  id: "text-unoffered",
  provider: "localllm",
  profile: "writing",
  goal: "Draft a short paragraph using the writing workflow.",
  toolCalls: [contractCall("text-unoffered", "run_command", { command: "printf unsafe > text-unoffered.txt" })],
  textFallback: true,
  allowShellTool: true,
  toolSurfaceMaxTools: 2,
  targets: ["text-unoffered.txt"],
});
assert(
  unofferedFallback.contractFailures.every((event) => event.data?.code === "TOOL_NOT_OFFERED"),
  "text fallback unoffered tool was not rejected by the exact per-turn surface"
);
const fallbackNativeRequests = unofferedFallback.requests.filter((request) => Array.isArray(request.tools));
assert(fallbackNativeRequests.length === 2, "text fallback did not exercise two native-to-text retries");
assert(
  fallbackNativeRequests.every((request) => !names(request.tools).includes("run_command")),
  "text fallback fixture unexpectedly offered run_command"
);

const multiCall = await runToolContractCase({
  id: "native-multi-call",
  goal: "Create multi-one.txt containing safe.",
  toolCalls: [
    contractCall("multi-one", "write_file", { path: "multi-one.txt", content: "safe", mode: "create" }),
    contractCall("multi-two", "write_file", { path: "multi-two.txt", content: "deferred", mode: "create" }),
  ],
  followupToolCalls: [contractCall("finish-recovered", "finish", { result: "Created and verified multi-one.txt." })],
  expectSequentialRecovery: true,
  expectedTargets: ["multi-one.txt"],
  targets: ["multi-two.txt"],
});
assert(
  multiCall.events.some((event) => event.type === "tool.completed" && event.data?.toolName === "write_file"),
  "recoverable multi-call batch did not dispatch its first valid call"
);

const duplicateId = await runToolContractCase({
  id: "native-duplicate-id",
  goal: "Create duplicate-one.txt and duplicate-two.txt.",
  toolCalls: [
    contractCall("duplicate-id", "write_file", { path: "duplicate-one.txt", content: "unsafe", mode: "create" }),
    contractCall("duplicate-id", "write_file", { path: "duplicate-two.txt", content: "unsafe", mode: "create" }),
  ],
  targets: ["duplicate-one.txt", "duplicate-two.txt"],
});
assert(
  duplicateId.contractFailures.every((event) => event.data?.errors?.some((error) => error.code === "TOOL_CALL_ID_DUPLICATE")),
  "duplicate tool-call ids were not rejected before dispatch"
);

const emptyId = await runToolContractCase({
  id: "native-empty-id",
  goal: "Create empty-id.txt.",
  toolCalls: [contractCall("", "write_file", { path: "empty-id.txt", content: "unsafe", mode: "create" })],
  targets: ["empty-id.txt"],
});
assert(
  emptyId.contractFailures.every((event) => event.data?.errors?.some((error) => error.code === "TOOL_CALL_ID_EMPTY")),
  "empty tool-call ids were not rejected before dispatch"
);

let malformedTextAttempts = 0;
const malformedTextRecovery = await runToolContractCase({
  id: "text-malformed-bounded-retry",
  provider: "localllm",
  profile: "code",
  goal: "Create readiness.md containing Recovered, verify it, and finish.",
  toolCalls: [contractCall("unused", "finish", { result: "Recovered." })],
  expectSuccess: true,
  expectedTargets: ["readiness.md"],
  responseFactory: ({ payload }) => {
    if (Array.isArray(payload.tools)) throw new Error("invalid request parameters: tools");
    malformedTextAttempts += 1;
    if (malformedTextAttempts === 1) {
      return {
          choices: [
            {
              message: {
                role: "assistant",
                content: 'Requested tools: write_file({"path":"readiness.md","content":"unfinished',
              },
            },
          ],
        };
    }
    return malformedTextAttempts === 2
      ? {
          choices: [
            {
              message: {
                role: "assistant",
                content: '[TOOL_CALLS]write_file[ARGS]{"path":"readiness.md","content":"Recovered\\n","mode":"create"}',
              },
            },
          ],
        }
      : {
          choices: [
            {
              message: {
                role: "assistant",
                content: '[TOOL_CALLS]finish[ARGS]{"result":"Recovered after one bounded textual syntax retry."}',
              },
            },
          ],
        };
  },
});
assert(malformedTextAttempts === 3, "malformed text-tool response did not retry once and then finish normally");
assert(
  malformedTextRecovery.events.filter((event) => event.type === "model.text_tool_retry_requested").length === 1,
  "malformed text-tool response did not record one protocol-level retry"
);
assert(
  !malformedTextRecovery.events.some((event) => event.type === "tool.started" && event.data?.toolName === "wait"),
  "malformed text-tool recovery dispatched a fabricated wait call"
);

let nonconsecutiveViolationStep = 0;
const nonconsecutiveViolationRecovery = await runToolContractCase({
  id: "native-nonconsecutive-contract-recovery",
  profile: "code",
  goal: "Create recovered.md containing Recovered and finish.",
  toolCalls: [contractCall("unused", "finish", { result: "Recovered." })],
  expectSuccess: true,
  expectedContractFailures: 2,
  expectedTargets: ["recovered.md"],
  maxSteps: 4,
  responseFactory: () => {
    nonconsecutiveViolationStep += 1;
    if (nonconsecutiveViolationStep === 1) {
      return assistantWithToolCalls([
        contractCall("invalid-before-success", "write_file", {
          path: "recovered.md",
          content: "unsafe",
          mode: "create",
          dryRun: false,
        }),
      ]);
    }
    if (nonconsecutiveViolationStep === 2) {
      return assistantWithToolCalls([
        contractCall("valid-write", "write_file", {
          path: "recovered.md",
          content: "Recovered\n",
          mode: "create",
        }),
      ]);
    }
    if (nonconsecutiveViolationStep === 3) {
      return assistantWithToolCalls([
        contractCall("invalid-after-success", "open_url", { url: "https://example.com" }),
      ]);
    }
    return assistantWithToolCalls([
      contractCall("finish-after-recovery", "finish", { result: "Created recovered.md." }),
    ]);
  },
});
assert(
  nonconsecutiveViolationRecovery.events.filter((event) => event.type === "tool.contract_recovered").length === 2,
  "successful intervening turns did not reset consecutive tool-contract violations"
);

let textAsImageStep = 0;
const textAsImageRecovery = await runToolContractCase({
  id: "text-file-requested-as-image",
  provider: "localllm",
  profile: "image",
  goal: "Inspect notes.md, report its exact readiness statement, and finish.",
  toolCalls: [contractCall("unused", "read_image", { path: "notes.md" })],
  expectSuccess: true,
  expectedTargets: ["notes.md"],
  setupWorkspace: async (workspace) => {
    await fs.writeFile(path.join(workspace, "notes.md"), "# Readiness\nVerified routine evidence.\n", "utf8");
  },
  responseFactory: () => {
    textAsImageStep += 1;
    return textAsImageStep === 1
      ? assistantWithToolCalls([contractCall("text-as-image", "read_image", { path: "notes.md" })])
      : assistantWithToolCalls([contractCall("finish-text-read", "finish", { result: "Verified routine evidence." })]);
  },
});
assert(
  textAsImageRecovery.events.some(
    (event) =>
      event.type === "tool.auto_corrected" &&
      event.data?.requestedToolName === "read_image" &&
      event.data?.toolName === "read_file"
  ),
  "plain text requested through read_image was not corrected to read_file"
);
assert(
  textAsImageRecovery.events.some(
    (event) => event.type === "tool.completed" && event.data?.toolName === "read_file" && event.data?.autoCorrected === true
  ),
  "corrected plain-text read did not complete with provenance"
);
assert(
  !textAsImageRecovery.events.some((event) => event.type === "tool.failed" && event.data?.toolName === "read_image"),
  "plain-text correction still invoked failing image perception"
);

let recordStreamAsImageStep = 0;
const recordStreamAsImageRecovery = await runToolContractCase({
  id: "record-stream-requested-as-image",
  provider: "localllm",
  profile: "image",
  goal: "Inspect the newline-delimited task records and report the latest request.",
  toolCalls: [contractCall("unused", "read_image", { path: "records.jsonl" })],
  expectSuccess: true,
  expectedTargets: ["records.jsonl"],
  setupWorkspace: async (workspace) => {
    await fs.writeFile(
      path.join(workspace, "records.jsonl"),
      '{"id":"m1","request":"preserve every inbound record"}\n',
      "utf8"
    );
  },
  responseFactory: () => {
    recordStreamAsImageStep += 1;
    return recordStreamAsImageStep === 1
      ? assistantWithToolCalls([contractCall("records-as-image", "read_image", { path: "records.jsonl" })])
      : assistantWithToolCalls([
          contractCall("finish-record-read", "finish", { result: "Preserve every inbound record." }),
        ]);
  },
});
assert(
  recordStreamAsImageRecovery.events.some(
    (event) =>
      event.type === "tool.auto_corrected" &&
      event.data?.requestedToolName === "read_image" &&
      event.data?.toolName === "read_file"
  ),
  "newline-delimited text requested through read_image was not corrected to read_file"
);
assert(
  recordStreamAsImageRecovery.events.some(
    (event) =>
      event.type === "tool.completed" &&
      event.data?.toolName === "read_file" &&
      event.data?.autoCorrected === true
  ),
  "corrected newline-delimited text read did not complete with provenance"
);
assert(
  !recordStreamAsImageRecovery.events.some(
    (event) => event.type === "tool.failed" && event.data?.toolName === "read_image"
  ),
  "newline-delimited text correction still invoked failing image perception"
);

assert(
  (() => {
    try {
      selectProgressiveTools([tool("run_command")], { config: { provider: "localllm" }, profile: "code" });
      return false;
    } catch (error) {
      return /finish/.test(String(error?.message || error));
    }
  })(),
  "selector did not reject an input surface without finish"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        "code",
        "browser",
        "research",
        "writing",
        "long-job",
        "tmux",
        "supervision-profile",
        "pipeline-profile",
        "agentlink",
        "mcp",
        "mixed-mcp-code-discovery",
        "mixed-mcp-fix-inference",
        "mixed-mcp-code-implementation",
        "mixed-mcp-code-verification",
        "mixed-phase-requires-tool-result",
        "mixed-phase-continuation-boundary",
        "mixed-research-code",
        "mixed-agentlink-code-coordination",
        "mixed-agentlink-code-implementation",
        "mixed-disabled-tools",
        "json-specialist",
        "image-perception",
        "image-generation",
        "image-generation-default-off",
        "canvas",
        "safe-explicit-profile",
        "disabled-tools",
        "disabled-specialist-bundles",
        "disabled-tools-full",
        "unknown-profile",
        "message-inference",
        "hosted-full",
        "explicit-full",
        "hard-cap",
        "serialized-size-target",
        "provider-boundary-schemas",
        "finish-contract",
        "per-turn-contract-preserved",
        "schema-required-type-enum-extra",
        "native-hidden-dry-run-zero-dispatch",
        "text-fallback-unoffered-zero-dispatch",
        "strict-single-call-batch",
        "duplicate-call-id",
        "empty-call-id",
        "malformed-text-tool-protocol-retry",
        "text-as-image-type-correction",
      ],
      localDefaultToolLimit: 12,
      localHardCap: LOCAL_TOOL_HARD_CAP,
      schemaCharTarget: DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET,
    },
    null,
    2
  )
);
