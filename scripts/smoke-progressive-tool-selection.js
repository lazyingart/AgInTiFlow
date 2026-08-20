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
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";
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
