import {
  hasLocalResearchWorkspaceIntent,
  shouldStartWithDeepResearch,
} from "./research-routing.js";
import { hasAgintiEvidenceScope, scopedChatopsEvidenceGoal } from "./scs-evidence.js";
import {
  INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
  isIntegrationTextWorkspaceToolAllowed,
} from "./integration-retained-text-workspace.js";
import {
  INTEGRATION_VISION_WORKSPACE_PROFILE_ID,
  isIntegrationVisionWorkspaceToolAllowed,
} from "./integration-retained-vision-workspace.js";

const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const DEFAULT_LOCAL_TOOL_LIMIT = 12;
export const LOCAL_TOOL_HARD_CAP = 16;
export const DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET = 16_000;

export const LOCAL_COMPACT_CODE_TOOL_NAMES = Object.freeze([
  "run_command",
  "inspect_project",
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "finish",
]);

export const LOCAL_COMPACT_GENERAL_TOOL_NAMES = Object.freeze([
  ...LOCAL_COMPACT_CODE_TOOL_NAMES.slice(0, -1),
  "open_url",
  "web_search",
  "send_to_canvas",
  "finish",
]);

const COMPACT_TOOL_BUNDLES = Object.freeze({
  general: LOCAL_COMPACT_GENERAL_TOOL_NAMES,
  code: LOCAL_COMPACT_CODE_TOOL_NAMES,
  browser: Object.freeze([
    "open_url",
    "click",
    "type",
    "scroll",
    "press",
    "back",
    "wait",
    "read_image",
    "send_to_canvas",
    "finish",
  ]),
  research: Object.freeze([
    "deep_research",
    "web_search",
    "read_web_page",
    "web_research",
    "open_url",
    "read_file",
    "write_file",
    "send_to_canvas",
    "finish",
  ]),
  writing: Object.freeze([
    "writing_specialist",
    "read_file",
    "write_file",
    "apply_patch",
    "web_search",
    "send_to_canvas",
    "finish",
  ]),
  "long-job": Object.freeze([
    "start_long_job",
    "long_job_status",
    "run_command",
    "inspect_project",
    "read_file",
    "send_to_canvas",
    "finish",
  ]),
  tmux: Object.freeze([
    "tmux_list_sessions",
    "tmux_capture_pane",
    "tmux_send_keys",
    "tmux_start_session",
    "run_command",
    "inspect_project",
    "read_file",
    "finish",
  ]),
  agentlink: Object.freeze([
    "agentlink_status",
    "agentlink_list_peers",
    "agentlink_create_board",
    "agentlink_get_board",
    "agentlink_send_message",
    "agentlink_claim_task",
    "agentlink_attach_evidence",
    "agentlink_summarize_session",
    "finish",
  ]),
  mcp: Object.freeze([
    "mcp_list_servers",
    "mcp_list_tools",
    "mcp_call_tool",
    "mcp_list_resources",
    "mcp_read_resource",
    "mcp_list_prompts",
    "mcp_get_prompt",
    "finish",
  ]),
  json: Object.freeze([
    "json_specialist",
    "json_specialist_batch",
    "read_file",
    "write_file",
    "search_files",
    "send_to_canvas",
    "finish",
  ]),
  "image-read": Object.freeze(["read_image", "send_to_canvas", "finish"]),
  "image-generation": Object.freeze([
    "generate_image",
    "read_image",
    "write_file",
    "send_to_canvas",
    "finish",
  ]),
  canvas: Object.freeze(["send_to_canvas", "read_file", "write_file", "finish"]),
  pipeline: Object.freeze([
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
  ]),
});

const MIXED_DISCOVERY_BUNDLES = new Set(["mcp", "research", "agentlink"]);
const DISCOVERY_STARTER_TOOL_NAMES = Object.freeze({
  mcp: Object.freeze(["mcp_list_servers", "mcp_list_tools", "mcp_call_tool"]),
  research: Object.freeze(["deep_research", "web_search", "web_research"]),
  agentlink: Object.freeze(["agentlink_status", "agentlink_list_peers", "agentlink_create_board"]),
});
const DISCOVERY_FOLLOWUP_TOOL_NAMES = Object.freeze({
  mcp: Object.freeze(["mcp_list_resources", "mcp_read_resource"]),
  research: Object.freeze(["read_web_page", "open_url"]),
  agentlink: Object.freeze(["agentlink_get_board", "agentlink_send_message"]),
});
const DISCOVERY_CONTINUATION_TOOL_NAMES = Object.freeze({
  mcp: Object.freeze(["mcp_list_tools", "mcp_call_tool", "mcp_list_resources", "mcp_read_resource"]),
  research: Object.freeze(["web_search", "read_web_page", "web_research", "deep_research", "open_url"]),
  agentlink: Object.freeze([
    "agentlink_get_board",
    "agentlink_send_message",
    "agentlink_claim_task",
    "agentlink_attach_evidence",
  ]),
});
const DISCOVERY_COMPLETION_TOOL_NAMES = Object.freeze({
  mcp: Object.freeze(COMPACT_TOOL_BUNDLES.mcp.filter((name) => name !== "finish")),
  research: Object.freeze(["web_search", "read_web_page", "web_research", "deep_research", "open_url"]),
  agentlink: Object.freeze(COMPACT_TOOL_BUNDLES.agentlink.filter((name) => name !== "finish")),
});
const IMPLEMENTATION_CRITICAL_TOOL_NAMES = Object.freeze([
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "run_command",
]);
const VERIFICATION_FIRST_CODE_TOOL_NAMES = Object.freeze([
  "run_command",
  "read_file",
  "search_files",
  "inspect_project",
  "apply_patch",
  "write_file",
  "list_files",
]);
const MUTATION_TOOL_NAMES = new Set(["write_file", "apply_patch"]);
const CONVERGENCE_DISCOVERY_TOOL_NAMES = new Set([
  "inspect_project",
  "list_files",
  "read_file",
  "search_files",
  "read_image",
  "run_command",
]);
export const ARTIFACT_VALIDATION_TOOL_NAMES = Object.freeze([
  "finish",
  "read_file",
  "run_command",
  "apply_patch",
  "write_file",
  "read_image",
  "send_to_canvas",
  "open_workspace_file",
  "preview_workspace",
]);

function artifactValidationToolNames(config = {}) {
  const used = new Set(
    Array.isArray(config.artifactValidationUsedTools)
      ? config.artifactValidationUsedTools.map((item) => String(item || ""))
      : []
  );
  const needsRepair = config.artifactValidationNeedsRepair === true;
  const needsCommand = config.artifactValidationNeedsCommand === true;
  const needsSourceRead = config.artifactValidationNeedsSourceRead === true;
  const outputEmbedded = config.artifactValidationOutputEmbedded === true;
  const needsGitEvidence = config.artifactValidationNeedsGitEvidence === true;
  const needsVisualEvidence = config.artifactValidationNeedsVisualEvidence === true;
  const repairAttempts = Math.max(0, Number(config.artifactValidationRepairAttempts || 0));
  const outputReadTools = outputEmbedded ? [] : ["read_file"];
  const repairTools = outputEmbedded
    ? ["apply_patch", "finish"]
    : repairAttempts > 0
    ? ["apply_patch", ...outputReadTools, "finish"]
    : ["apply_patch", "write_file", ...outputReadTools, "finish"];
  const ordered = needsCommand
    ? ["run_command", ...(needsRepair ? repairTools : ["finish", ...outputReadTools, "apply_patch", "write_file"])]
    : needsSourceRead
      ? needsRepair
        ? repairAttempts > 0
          ? ["read_file", "apply_patch", "finish"]
          : ["read_file", "apply_patch", "write_file", "finish"]
        : ["read_file", "finish", "run_command", "apply_patch", "write_file"]
      : needsRepair
        ? repairTools
        : ["finish", ...outputReadTools, "run_command", "apply_patch", "write_file"];
  if (needsGitEvidence) ordered.unshift("run_command");
  if (needsVisualEvidence) ordered.unshift("read_image");
  for (const name of ["read_image", "send_to_canvas", "open_workspace_file", "preview_workspace"]) ordered.push(name);
  return [...new Set(ordered)].filter(
    (name) =>
      name === "finish" ||
      (name === "run_command" && needsGitEvidence) ||
      (name === "read_image" && needsVisualEvidence) ||
      !used.has(name)
  );
}

const CODE_PROFILES = new Set([
  "code",
  "large-codebase",
  "review",
  "docs",
  "data",
  "qa",
  "database",
  "devops",
  "security",
  "app",
  "website",
  "python",
  "shell",
  "node",
  "java",
  "android",
  "ios",
  "go",
  "rust",
  "dotnet",
  "php",
  "ruby",
  "c-cpp",
  "r-stan",
  "aaps",
  "github",
  "maintenance",
  "system",
]);
const BROWSER_PROFILES = new Set(["browser", "browser-automation", "web-browser"]);
const RESEARCH_PROFILES = new Set(["research"]);
const WRITING_PROFILES = new Set([
  "writing",
  "paper",
  "book",
  "novel",
  "design",
  "slides",
  "education",
  "latex",
  "word",
]);
const LONG_JOB_TOOL_NAMES = new Set(["start_long_job", "long_job_status"]);
const TMUX_TOOL_NAMES = new Set([
  "tmux_list_sessions",
  "tmux_capture_pane",
  "tmux_send_keys",
  "tmux_start_session",
]);
const AGENTLINK_TOOL_NAMES = new Set([
  "agentlink_status",
  "agentlink_list_peers",
  "agentlink_create_board",
  "agentlink_get_board",
  "agentlink_send_message",
  "agentlink_claim_task",
  "agentlink_attach_evidence",
  "agentlink_summarize_session",
]);
const JSON_TOOL_NAMES = new Set(["json_specialist", "json_specialist_batch"]);
const WRITING_TOOL_NAMES = new Set(["writing_specialist"]);

const FILE_TOOL_NAMES = new Set([
  "read_image",
  "open_workspace_file",
  "preview_workspace",
  "inspect_project",
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
]);
const SHELL_TOOL_NAMES = new Set([
  "start_long_job",
  "long_job_status",
  "tmux_list_sessions",
  "tmux_capture_pane",
  "tmux_send_keys",
  "tmux_start_session",
  "run_command",
]);
const BROWSER_TOOL_NAMES = new Set(["open_url", "click", "type", "scroll", "press", "back", "wait"]);
const WEB_SEARCH_TOOL_NAMES = new Set(["web_search", "read_web_page", "web_research", "deep_research"]);
const WRAPPER_TOOL_NAMES = new Set(["delegate_agent", "research_wrapper"]);
const AUXILIARY_TOOL_NAMES = new Set(["generate_image"]);
const IMAGE_TOOL_NAMES = new Set(["read_image", "generate_image"]);
const SPECIALIST_TOOL_NAMES = new Set(["json_specialist", "json_specialist_batch", "writing_specialist"]);

const PROFILE_TOOL_ALIASES = Object.freeze({
  browser: COMPACT_TOOL_BUNDLES.browser,
  canvas: Object.freeze(["send_to_canvas"]),
  coordination: Object.freeze([...COMPACT_TOOL_BUNDLES.tmux, ...COMPACT_TOOL_BUNDLES.agentlink]),
  files: Object.freeze([
    "inspect_project",
    "list_files",
    "read_file",
    "search_files",
    "write_file",
    "apply_patch",
    "read_image",
  ]),
  inspect_project: Object.freeze(["inspect_project"]),
  long_job: COMPACT_TOOL_BUNDLES["long-job"],
  "long-job": COMPACT_TOOL_BUNDLES["long-job"],
  long_jobs: COMPACT_TOOL_BUNDLES["long-job"],
  mcp: COMPACT_TOOL_BUNDLES.mcp,
  sandbox: Object.freeze(["run_command"]),
  shell: Object.freeze(["run_command"]),
  tmux: COMPACT_TOOL_BUNDLES.tmux,
  agentlink: COMPACT_TOOL_BUNDLES.agentlink,
  json: COMPACT_TOOL_BUNDLES.json,
  json_specialist: Object.freeze(["json_specialist"]),
  image: COMPACT_TOOL_BUNDLES["image-generation"],
  vision: COMPACT_TOOL_BUNDLES["image-read"],
  perception: COMPACT_TOOL_BUNDLES["image-read"],
  image_generation: COMPACT_TOOL_BUNDLES["image-generation"],
  "image-generation": COMPACT_TOOL_BUNDLES["image-generation"],
  "auxiliary:image_generation": COMPACT_TOOL_BUNDLES["image-generation"],
  web_search: COMPACT_TOOL_BUNDLES.research,
  writing_specialist: Object.freeze(["writing_specialist"]),
});

const COMPACT_ELIGIBLE_TOOL_NAMES = new Set([
  ...Object.values(COMPACT_TOOL_BUNDLES).flat(),
  ...Object.values(PROFILE_TOOL_ALIASES).flat(),
]);

function isDisabled(value) {
  if (value === false || value === 0) return true;
  return /^(false|off|no|0)$/i.test(String(value ?? "").trim());
}

function openAiFunctionName(tool) {
  if (!tool || typeof tool !== "object" || tool.type !== "function") return "";
  if (!tool.function || typeof tool.function !== "object") return "";
  const name = typeof tool.function.name === "string" ? tool.function.name : "";
  if (name !== name.trim() || !FUNCTION_NAME_PATTERN.test(name)) return "";
  if (
    tool.function.parameters !== undefined &&
    (!tool.function.parameters || typeof tool.function.parameters !== "object" || Array.isArray(tool.function.parameters))
  ) {
    return "";
  }
  return name;
}

function validatedUniqueTools(tools) {
  if (!Array.isArray(tools)) throw new TypeError("tools must be an array of OpenAI function tool descriptors");
  const seen = new Set();
  const valid = [];
  for (const tool of tools) {
    const name = openAiFunctionName(tool);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    valid.push({ name, tool });
  }
  return valid;
}

function toolIsDisabled(name, config) {
  if (
    config.integrationSessionProfile === INTEGRATION_TEXT_WORKSPACE_PROFILE_ID &&
    !isIntegrationTextWorkspaceToolAllowed(name)
  ) return true;
  if (
    config.integrationSessionProfile === INTEGRATION_VISION_WORKSPACE_PROFILE_ID &&
    !isIntegrationVisionWorkspaceToolAllowed(name)
  ) return true;
  if (isDisabled(config.allowFileTools) && FILE_TOOL_NAMES.has(name)) return true;
  if (isDisabled(config.allowFileTools) && name === "generate_image") return true;
  if (isDisabled(config.allowShellTool) && SHELL_TOOL_NAMES.has(name)) return true;
  if (isDisabled(config.allowWebSearch) && WEB_SEARCH_TOOL_NAMES.has(name)) return true;
  if (config.allowWrapperTools !== true && WRAPPER_TOOL_NAMES.has(name)) return true;
  if (config.allowAuxiliaryTools !== true && AUXILIARY_TOOL_NAMES.has(name)) return true;
  if (isDisabled(config.allowMcpTools) && name.startsWith("mcp_")) return true;
  if ((isDisabled(config.allowLongJobTools) || isDisabled(config.allowBackgroundJobs)) && LONG_JOB_TOOL_NAMES.has(name)) {
    return true;
  }
  if ((isDisabled(config.allowTmuxTools) || isDisabled(config.allowCoordinationTools)) && TMUX_TOOL_NAMES.has(name)) {
    return true;
  }
  if (isDisabled(config.allowBrowserTools) && BROWSER_TOOL_NAMES.has(name)) return true;
  if (isDisabled(config.allowCanvasTools) && name === "send_to_canvas") return true;
  if (
    (isDisabled(config.allowAgentLinkTools) || isDisabled(config.allowCoordinationTools)) &&
    AGENTLINK_TOOL_NAMES.has(name)
  ) {
    return true;
  }
  if ((isDisabled(config.allowImageTools) || isDisabled(config.allowVisionTools)) && IMAGE_TOOL_NAMES.has(name)) return true;
  if (isDisabled(config.allowImagePerception) && name === "read_image") return true;
  if (isDisabled(config.allowImageGeneration) && name === "generate_image") return true;
  if (isDisabled(config.allowSpecialistTools) && SPECIALIST_TOOL_NAMES.has(name)) return true;
  if ((isDisabled(config.allowJsonTools) || isDisabled(config.allowJsonSpecialist)) && JSON_TOOL_NAMES.has(name)) return true;
  if (
    (isDisabled(config.allowWritingTools) || isDisabled(config.allowWritingSpecialist)) &&
    WRITING_TOOL_NAMES.has(name)
  ) {
    return true;
  }
  return false;
}

function localCapability(config, profile) {
  const candidates = [
    profile && typeof profile === "object" ? profile : null,
    config.providerCapabilities,
    config.capabilities,
    config.modelProfile,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.local === "boolean") return candidate.local;
  }

  const provider = String(config.provider || "").trim().toLowerCase();
  if (["localllm", "local", "local-llm", "local_llm", "mock"].includes(provider)) {
    return true;
  }

  try {
    const baseURL = new URL(String(config.baseURL || ""));
    const hostname = baseURL.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  } catch {
    // A missing or non-URL base URL does not prove that a provider is local.
  }
  return false;
}

function toolSurfacePolicy(config, profile) {
  const profilePolicy = profile && typeof profile === "object" ? profile.toolSurfacePolicy || profile.toolPolicy : "";
  const raw = String(config.toolSurfacePolicy || config.toolPolicy || profilePolicy || "auto").trim().toLowerCase();
  if (["full", "all", "hosted"].includes(raw)) return "full";
  if (["compact", "progressive", "local"].includes(raw)) return "compact";
  if (config.progressiveTools === false) return "full";
  if (config.progressiveTools === true) return "compact";
  return localCapability(config, profile) ? "compact" : "full";
}

function profileId(config, profile) {
  if (typeof profile === "string") return profile.trim().toLowerCase();
  if (profile && typeof profile === "object") {
    const value = profile.taskProfile || profile.profile;
    if (value) return String(value).trim().toLowerCase();
    if (profile.id && typeof profile.local !== "boolean") return String(profile.id).trim().toLowerCase();
  }
  return String(config.taskProfile || "auto").trim().toLowerCase();
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function taskText(goal, config, messages) {
  const rawGoal = goal || config.goal || "";
  const scopedGoal = scopedChatopsEvidenceGoal(rawGoal);
  const recentConversation = !hasAgintiEvidenceScope(rawGoal) && Array.isArray(messages)
    ? messages
        .filter((message) => message && (message.role === "user" || message.role === "assistant"))
        .slice(-6)
        .map((message) => scopedChatopsEvidenceGoal(textContent(message.content)))
        .filter(Boolean)
        .join("\n")
    : "";
  return `${scopedGoal}\n${recentConversation}`.trim().toLowerCase();
}

function currentTaskMessages(messages) {
  if (!Array.isArray(messages)) return [];
  let boundary = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message?.role === "user" &&
      /^\s*(?:Continue with this new request:|Goal:)/i.test(textContent(message.content))
    ) {
      boundary = index;
    }
  }
  return messages.slice(boundary);
}

function completedToolNames(messages) {
  const callsById = new Map();
  const completed = new Set();
  for (const message of currentTaskMessages(messages)) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = String(call?.id || "").trim();
        const name = String(call?.function?.name || "").trim();
        if (id && FUNCTION_NAME_PATTERN.test(name)) callsById.set(id, name);
      }
      continue;
    }
    if (message?.role !== "tool") continue;
    const name = callsById.get(String(message.tool_call_id || "").trim());
    if (name) completed.add(name);
  }
  return completed;
}

const PRIMARY_PROJECT_INSTRUCTION_PATH_PATTERN = /(?:^|\/)(?:AGENTS?\.md|AGINTI\.md|README(?:\.[^/]+)?)$/i;
const PROJECT_INSTRUCTION_PATH_PATTERN = /(?:^|\/)(?:AGENTS?\.md|AGINTI\.md|README(?:\.[^/]+)?|TASK(?:\.[^/]+)?|CONTRIBUTING\.md)$/i;
const DATA_PROJECT_CONTEXT_PATH_PATTERN =
  /(?:^|\/)(?:config|tests?|specs?|src|scripts?|analysis|pipeline)(?:\/|$)|(?:^|\/)(?:pyproject\.toml|package\.json|requirements[^/]*\.txt|[^/]+\.(?:py|r|R|jl|ipynb|sql))$/i;
const DATA_PROJECT_TEST_PATH_PATTERN =
  /(?:^|\/)(?:tests?|specs?|__tests__)(?:\/|$)|(?:^|\/)(?:test_[^/]+|[^/]+(?:_test|\.test|\.spec)[^/]*)\.(?:py|js|jsx|ts|tsx|mjs|cjs|r|R|jl|sql)$/i;

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function completedToolRecords(messages) {
  const callsById = new Map();
  const records = [];
  for (const message of currentTaskMessages(messages)) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = String(call?.id || "").trim();
        const name = String(call?.function?.name || "").trim();
        if (!id || !FUNCTION_NAME_PATTERN.test(name)) continue;
        callsById.set(id, {
          name,
          args: parseJsonObject(call?.function?.arguments),
        });
      }
      continue;
    }
    if (message?.role !== "tool") continue;
    const call = callsById.get(String(message.tool_call_id || "").trim());
    if (!call) continue;
    records.push({ ...call, result: parseJsonObject(message.content) });
  }
  return records;
}

function dataProjectDiscoveryState(messages) {
  const records = completedToolRecords(messages);
  const inspection = [...records]
    .reverse()
    .find((record) => record.name === "inspect_project" && record.result?.ok !== false);
  if (!inspection) return { phase: "inspect", paths: [] };

  const topLevelFiles = Array.isArray(inspection.result?.topLevel)
    ? inspection.result.topLevel.filter((item) => item?.type === "file").map((item) => item?.path)
    : [];
  const discoveredPaths = [
    ...(Array.isArray(inspection.result?.recommendedReads) ? inspection.result.recommendedReads : []),
    ...(Array.isArray(inspection.result?.manifestFiles)
      ? inspection.result.manifestFiles.map((item) => item?.path)
      : []),
    ...(Array.isArray(inspection.result?.testFiles) ? inspection.result.testFiles.map((item) => item?.path) : []),
    ...(Array.isArray(inspection.result?.files) ? inspection.result.files.map((item) => item?.path) : []),
    ...topLevelFiles,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
  const readPaths = records
    .filter((record) => record.name === "read_file" && record.result?.ok !== false)
    .map((record) => String(record.result?.path || record.args?.path || "").trim())
    .filter(Boolean);

  const primaryInstructionCandidates = discoveredPaths.filter((item) =>
    PRIMARY_PROJECT_INSTRUCTION_PATH_PATTERN.test(item)
  );
  const instructionCandidates =
    primaryInstructionCandidates.length > 0
      ? primaryInstructionCandidates
      : discoveredPaths.filter((item) => PROJECT_INSTRUCTION_PATH_PATTERN.test(item));
  const testCandidates = discoveredPaths.filter((item) => DATA_PROJECT_TEST_PATH_PATTERN.test(item));
  const dataContextCandidates = discoveredPaths.filter(
    (item) => DATA_PROJECT_CONTEXT_PATH_PATTERN.test(item) && !DATA_PROJECT_TEST_PATH_PATTERN.test(item)
  );
  const instructionRead =
    instructionCandidates.length === 0 || readPaths.some((item) => instructionCandidates.includes(item));
  if (!instructionRead) return { phase: "read-instructions", paths: instructionCandidates.slice(0, 24) };

  const dataContextRead =
    dataContextCandidates.length === 0 || readPaths.some((item) => dataContextCandidates.includes(item));
  if (!dataContextRead) return { phase: "read-context", paths: dataContextCandidates.slice(0, 24) };
  const testContextRead =
    testCandidates.length === 0 || readPaths.some((item) => testCandidates.includes(item));
  if (!testContextRead) return { phase: "read-tests", paths: testCandidates.slice(0, 24) };
  return { phase: "ready", paths: [] };
}

function constrainReadFilePaths(tool, paths, phase) {
  if (!tool || paths.length === 0) return tool;
  const pathSchema = tool.function?.parameters?.properties?.path || { type: "string" };
  return {
    ...tool,
    function: {
      ...tool.function,
      description:
        phase === "read-instructions"
          ? "Read one exact project instruction file discovered by inspect_project before data mutation or commands are enabled."
          : phase === "read-tests"
            ? "Read one exact existing test file discovered by inspect_project before data mutation or commands are enabled."
            : "Read one exact existing analyzer or configuration file discovered by inspect_project before data mutation or commands are enabled.",
      parameters: {
        ...tool.function.parameters,
        properties: {
          ...tool.function.parameters.properties,
          path: {
            ...pathSchema,
            enum: paths,
            description: "Exact workspace-relative path discovered by inspect_project.",
          },
        },
      },
    },
  };
}

function constrainWriteFilePaths(tool, paths = []) {
  if (!tool || paths.length === 0) return null;
  const pathSchema = tool.function?.parameters?.properties?.path || { type: "string" };
  const modeSchema = tool.function?.parameters?.properties?.mode || { type: "string" };
  return {
    ...tool,
    function: {
      ...tool.function,
      description:
        "Create one exact required project-instruction file while test repair is active. This exception cannot create sidecars, generated outputs, replacement analyzers, or arbitrary files; repair canonical source and pass the retained test before other artifact work.",
      parameters: {
        ...tool.function.parameters,
        properties: {
          ...tool.function.parameters.properties,
          path: {
            ...pathSchema,
            enum: paths,
            description: "Exact required project-instruction path from the retained acceptance contract.",
          },
          mode: {
            ...modeSchema,
            enum: ["create"],
            description: "Only creation is permitted for this missing required instruction file.",
          },
        },
      },
    },
  };
}

function exactSeparatorRepairCandidate(target = {}) {
  if (
    target.kind !== "membership" ||
    target.negated === true ||
    !String(target.search || "") ||
    !String(target.literal || "").trim()
  ) {
    return "";
  }
  const search = String(target.search);
  const literal = String(target.literal).trim();
  const comparableSearch = target.caseFolded
    ? search.toLocaleLowerCase("en-US")
    : search;
  const comparableLiteral = target.caseFolded
    ? literal.toLocaleLowerCase("en-US")
    : literal;
  if (comparableSearch.includes(comparableLiteral)) return "";
  const tokens = literal.split(/\s+/u).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 8) return "";
  const escapedTokens = tokens.map((token) =>
    token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  const pattern = new RegExp(
    escapedTokens.join("[\\s\\p{P}\\p{S}]+"),
    target.caseFolded ? "giu" : "gu"
  );
  const matches = [...search.matchAll(pattern)];
  if (matches.length !== 1 || !Number.isInteger(matches[0].index)) return "";
  const start = matches[0].index;
  const end = start + matches[0][0].length;
  const candidate = `${search.slice(0, start)}${literal}${search.slice(end)}`;
  return candidate !== search && candidate.length <= 4000 ? candidate : "";
}

function exactDuplicateDecisiveLineRemovalCandidate(target = {}) {
  if (
    target.kind !== "index-comparison" ||
    Number(target.decisiveDuplicateCount || 0) < 2 ||
    !String(target.search || "") ||
    !String(target.decisiveText || "")
  ) {
    return "";
  }
  const lines = String(target.search).replace(/\r/g, "").split("\n");
  const matchingIndexes = lines
    .map((line, index) => (line === target.decisiveText ? index : -1))
    .filter((index) => index >= 0);
  if (matchingIndexes.length !== 1 || lines.length < 2) return "";
  lines.splice(matchingIndexes[0], 1);
  const candidate = lines.join("\n");
  return candidate && candidate.length <= 4000 ? candidate : "";
}

function regexLiteral(value, { caseFolded = false } = {}) {
  const text = String(value || "");
  if (!text || text.length > 64 || /[\r\n]/u.test(text)) return "";
  if (caseFolded && /[^\x00-\x7F]/u.test(text)) return "";
  return [...text].map((character) => {
    if (caseFolded && /[A-Za-z]/u.test(character)) {
      const lower = character.toLowerCase();
      const upper = character.toUpperCase();
      return lower === upper ? lower : `[${lower}${upper}]`;
    }
    return character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }).join("");
}

function prematureComparisonOccurrence(target = {}) {
  if (target.kind !== "index-comparison") return "";
  const operator = String(target.operator || "");
  const decisiveSide = String(target.decisiveSide || "");
  const side =
    (["<", "<="].includes(operator) && decisiveSide === "right")
      ? "right"
      : ([">", ">="].includes(operator) && decisiveSide === "left")
        ? "left"
        : "";
  if (!side) return "";
  const alternatives = Array.isArray(target[`${side}Alternatives`]) &&
      target[`${side}Alternatives`].length
    ? target[`${side}Alternatives`].map(String)
    : [String(target[side] || "")];
  const search = String(target.search || "");
  const comparableSearch = target.caseFolded
    ? search.toLocaleLowerCase("en-US")
    : search;
  const selected = alternatives
    .map((literal) => ({
      literal,
      index: comparableSearch.indexOf(
        target.caseFolded ? literal.toLocaleLowerCase("en-US") : literal
      ),
    }))
    .filter((item) => item.literal && item.index >= 0)
    .sort((left, right) => left.index - right.index || right.literal.length - left.literal.length)[0];
  if (!selected) return null;
  let tokenStart = selected.index;
  let tokenEnd = selected.index + selected.literal.length;
  while (tokenStart > 0 && /[\p{L}\p{N}_-]/u.test(search[tokenStart - 1])) tokenStart -= 1;
  while (tokenEnd < search.length && /[\p{L}\p{N}_-]/u.test(search[tokenEnd])) tokenEnd += 1;
  const token = search.slice(tokenStart, tokenEnd);
  const matchStart = selected.index - tokenStart;
  return {
    literal: selected.literal,
    index: selected.index,
    token,
    markedToken: token
      ? `${token.slice(0, matchStart)}[${token.slice(matchStart, matchStart + selected.literal.length)}]${token.slice(matchStart + selected.literal.length)}`
      : "",
  };
}

function prematureComparisonLiteral(target = {}) {
  return prematureComparisonOccurrence(target)?.literal || "";
}

function prematureComparisonRepairPattern(target = {}) {
  const occurrence = prematureComparisonOccurrence(target);
  const premature = regexLiteral(occurrence?.literal, {
    caseFolded: target.caseFolded === true,
  });
  if (!premature) return "";
  const operator = String(target.operator || "");
  const prerequisiteSide = ["<", "<="].includes(operator) ? "left" : "right";
  const prerequisites = Array.isArray(target[`${prerequisiteSide}Alternatives`]) &&
      target[`${prerequisiteSide}Alternatives`].length
    ? target[`${prerequisiteSide}Alternatives`]
    : [target[prerequisiteSide]];
  const prerequisitePattern = prerequisites
    .map((literal) => regexLiteral(literal, { caseFolded: target.caseFolded === true }))
    .filter(Boolean)
    .map((literal) => `(?:${literal})`)
    .join("|");
  const absence = `(?![\\s\\S]*${premature})[\\s\\S]+`;
  if (!prerequisitePattern) return `^(?:${absence})$`;
  const prerequisiteBeforeFirstPremature =
    `(?:(?!${premature})[\\s\\S])*(?:${prerequisitePattern})[\\s\\S]*${premature}[\\s\\S]*`;
  return `^(?:${absence}|${prerequisiteBeforeFirstPremature})$`;
}

function constrainFailedTestApplyPatch(tool, targets = []) {
  if (!tool || !Array.isArray(targets) || targets.length === 0) return tool;
  const validTargets = targets
    .map((target) => ({
      kind: String(target?.kind || "index-comparison"),
      path: String(target?.path || "").trim(),
      search: String(target?.search || ""),
      line: Math.max(0, Number(target?.line || 0)),
      left: String(target?.left || ""),
      operator: String(target?.operator || ""),
      right: String(target?.right || ""),
      leftAlternatives: Array.isArray(target?.leftAlternatives)
        ? target.leftAlternatives.map(String).slice(0, 8)
        : [],
      rightAlternatives: Array.isArray(target?.rightAlternatives)
        ? target.rightAlternatives.map(String).slice(0, 8)
        : [],
      leftAggregation: String(target?.leftAggregation || "first"),
      rightAggregation: String(target?.rightAggregation || "first"),
      decisiveText: String(target?.decisiveText || ""),
      decisiveSide: String(target?.decisiveSide || ""),
      decisiveDuplicateCount: Math.max(0, Number(target?.decisiveDuplicateCount || 0)),
      literal: String(target?.literal || ""),
      anchorLiteral: String(target?.anchorLiteral || ""),
      negated: target?.negated === true,
      caseFolded: target?.caseFolded === true,
    }))
    .filter((target) => target.path && target.search)
    .slice(0, 4);
  if (!validTargets.length) return tool;
  const paths = [...new Set(validTargets.map((target) => target.path))];
  const searches = [...new Set(validTargets.map((target) => target.search))];
  const properties = tool.function?.parameters?.properties || {};
  const relationGuidance = validTargets
    .filter(
      (target) =>
        target.kind === "membership" ||
        (target.left && target.right && ["<", "<=", ">", ">="].includes(target.operator))
    )
    .map((target) => {
      if (target.kind === "membership") {
        const haystack = target.caseFolded
          ? target.search.toLocaleLowerCase("en-US")
          : target.search;
        const literal = target.caseFolded
          ? target.literal.toLocaleLowerCase("en-US")
          : target.literal;
        const presentInSearch = literal ? haystack.includes(literal) : false;
        return [
          `Required content rule: ${JSON.stringify(target.literal)} must ${target.negated ? "be absent" : "appear"}${target.caseFolded ? " (case-insensitive)" : ""}.`,
          target.negated && presentInSearch
            ? "Remove or naturally rephrase that occurrence while preserving the intended fact."
            : target.anchorLiteral
              ? `Keep the fact associated with ${JSON.stringify(target.anchorLiteral)}, and use the required wording naturally.`
              : "Make the content rule true.",
        ].join(" ");
      }
      const haystack = target.caseFolded ? target.search.toLocaleLowerCase("en-US") : target.search;
      const left = target.caseFolded ? target.left.toLocaleLowerCase("en-US") : target.left;
      const right = target.caseFolded ? target.right.toLocaleLowerCase("en-US") : target.right;
      const leftIndex = haystack.indexOf(left);
      const rightIndex = haystack.indexOf(right);
      const grouped = target.leftAlternatives.length > 1 || target.rightAlternatives.length > 1;
      const comparison = grouped
        ? `${target.leftAggregation} first-match ${JSON.stringify(target.leftAlternatives)} ` +
          `${target.operator} ${target.rightAggregation} first-match ${JSON.stringify(target.rightAlternatives)}`
        : `first ${JSON.stringify(target.left)} ${target.operator} first ${JSON.stringify(target.right)}`;
      if (["<", "<="].includes(target.operator) && rightIndex >= 0 && (leftIndex < 0 || leftIndex > rightIndex)) {
        return `Ordering rule: ${comparison}${target.caseFolded ? " (case-insensitive)" : ""}. Rewrite the earlier occurrence so ${JSON.stringify(target.left)} comes first; appending later text is insufficient.`;
      }
      if ([">", ">="].includes(target.operator) && leftIndex >= 0 && (rightIndex < 0 || rightIndex > leftIndex)) {
        return `Ordering rule: ${comparison}${target.caseFolded ? " (case-insensitive)" : ""}. Rewrite the earlier occurrence so ${JSON.stringify(target.right)} comes first; appending later text is insufficient.`;
      }
      return `Ordering rule: ${comparison}${target.caseFolded ? " (case-insensitive)" : ""}. Make that first-occurrence order true.`;
    });
  const cleanupGuidance = validTargets.some((target) => target.kind === "control-plane-leak")
    ? ["Remove internal tool, schema, validator, or recovery prose from the selected artifact line."]
    : [];
  const selectedLocations = [...new Set(
    validTargets.map((target) => `${target.path}${target.line ? ` line ${target.line}` : ""}`)
  )];
  const replacementGuidance = [
    "Write only concise natural project content for the replacement field.",
    ...cleanupGuidance,
    ...relationGuidance,
    "Preserve the underlying task fact and provenance, but do not repeat the search text unchanged or copy these instructions into the artifact.",
  ].join(" ");
  const separatorRepairCandidate =
    validTargets.length === 1 ? exactSeparatorRepairCandidate(validTargets[0]) : "";
  const duplicateRemovalCandidate =
    validTargets.length === 1 && !separatorRepairCandidate
      ? exactDuplicateDecisiveLineRemovalCandidate(validTargets[0])
      : "";
  const exactReplacementCandidate = separatorRepairCandidate || duplicateRemovalCandidate;
  const prematureLiteral =
    validTargets.length === 1 && !exactReplacementCandidate
      ? prematureComparisonLiteral(validTargets[0])
      : "";
  const prematureOccurrence =
    validTargets.length === 1 && !exactReplacementCandidate
      ? prematureComparisonOccurrence(validTargets[0])
      : null;
  const prematureRepairPattern =
    validTargets.length === 1 && !exactReplacementCandidate
      ? prematureComparisonRepairPattern(validTargets[0])
      : "";
  const replacementOnlyRepair = Boolean(prematureRepairPattern);
  const replacementProperty = {
    ...(properties.replace || { type: "string" }),
    minLength: 1,
    ...(replacementOnlyRepair ? { maxLength: 4000 } : {}),
    ...(exactReplacementCandidate ? { enum: [exactReplacementCandidate] } : {}),
    ...(prematureRepairPattern ? { pattern: prematureRepairPattern } : {}),
    description: exactReplacementCandidate
      ? `${replacementGuidance} ${separatorRepairCandidate
        ? "A single lossless separator normalization"
        : "A single lossless duplicate-line removal"} satisfies this exact retained rule; use the only allowed replacement value.`
      : prematureLiteral
        ? `The replacement must either omit the premature operand ${JSON.stringify(prematureLiteral)}${prematureOccurrence?.markedToken ? `, currently matched inside ${JSON.stringify(prematureOccurrence.markedToken)}` : ""}, or place the required counterpart before its first occurrence. Rewrite the containing word or sentence naturally so the retained first-match relation can advance. ${replacementGuidance}`
        : replacementGuidance,
  };
  return {
    ...tool,
    function: {
      ...tool.function,
      ...(replacementOnlyRepair ? { name: "rewrite_text_excerpt" } : {}),
      description: [
        replacementOnlyRepair
          ? "Rewrite one exact earlier text excerpt selected by retained failed-test evidence. The runtime owns its path and exact anchor; return only the complete revised excerpt, not the whole file."
          : "Repair one exact earlier occurrence selected by retained failed-test evidence.",
        `Selected location${selectedLocations.length === 1 ? "" : "s"}: ${selectedLocations.join(", ")}.`,
        replacementOnlyRepair
          ? "The runtime translates this bounded rewrite into an exact transactional patch and rejects unrelated or nonrepairing changes."
          : "Use the path and search enum values exactly, then provide a materially different natural replacement. A unified patch remains available only when the repair belongs in a separate canonical producer source.",
      ].join(" "),
      parameters: {
        ...(replacementOnlyRepair
          ? {
              type: "object",
              properties: {
                revisedText: {
                  ...replacementProperty,
                  description: `Return only the complete revised excerpt. Do not return the surrounding file. ${replacementProperty.description}`,
                },
              },
              required: ["revisedText"],
              additionalProperties: false,
            }
          : {
              ...tool.function.parameters,
              properties: {
                ...properties,
                path: {
                  ...(properties.path || { type: "string" }),
                  enum: paths,
                  description: "Evidence-derived task-owned path containing the decisive first occurrence.",
                },
                search: {
                  ...(properties.search || { type: "string" }),
                  enum: searches,
                  description: "Exact unique current line containing the decisive first occurrence.",
                },
                replace: replacementProperty,
                ...(properties.expectedReplacements
                  ? {
                      expectedReplacements: {
                        ...properties.expectedReplacements,
                        enum: [1],
                        description: "The evidence-derived decisive line is unique and must be replaced exactly once.",
                      },
                    }
                  : {}),
              },
            }),
      },
    },
  };
}

function constrainRunCommand(tool, command = "", description = "") {
  if (!tool || !command) return tool;
  const commandSchema = tool.function?.parameters?.properties?.command || { type: "string" };
  return {
    ...tool,
    function: {
      ...tool.function,
      description: description || tool.function?.description,
      parameters: {
        ...tool.function.parameters,
        properties: {
          ...tool.function.parameters.properties,
          command: {
            ...commandSchema,
            enum: [command],
            description: "Exact retained verification command required after the latest canonical-source mutation.",
          },
        },
      },
    },
  };
}

function constrainRepositoryStateCommit(tool, paths = []) {
  if (!tool || !Array.isArray(paths) || paths.length === 0) return null;
  const retainedPaths = [...new Set(paths.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, 32);
  if (!retainedPaths.length) return null;
  return {
    ...tool,
    function: {
      ...tool.function,
      name: "commit_project_changes",
      description: [
        "Commit the current task-owned project changes after a clean-worktree acceptance gate failed.",
        "The runtime stages only its evidence-derived changed paths, creates one local commit with the supplied concise message, and leaves unrelated paths untouched.",
        "Do not use this tool to change source content or to claim that verification passed; the exact retained verifier is offered in the next phase.",
        `Task-owned paths: ${retainedPaths.join(", ")}.`,
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            minLength: 3,
            maxLength: 120,
            pattern: "^[^\\r\\n\\u0000]+$",
            description: "A concise factual Git commit subject for the completed task-owned change.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
  };
}

function roundRobinToolNames(groups) {
  const names = [];
  const maxLength = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      if (group[index]) names.push(group[index]);
    }
  }
  return names;
}

function mixedDiscoveryCodeToolNames(bundleOrder, messages) {
  const discoveryBundles = bundleOrder.filter((bundle) => MIXED_DISCOVERY_BUNDLES.has(bundle));
  const completed = completedToolNames(messages);
  const discoveryCompleted = [...completed].some((name) =>
    discoveryBundles.some((bundle) => (DISCOVERY_COMPLETION_TOOL_NAMES[bundle] || []).includes(name))
  );
  const mutationCompleted = [...completed].some((name) => MUTATION_TOOL_NAMES.has(name));

  if (!discoveryCompleted && !mutationCompleted) {
    // Whole discovery + code bundles overflow the default 12-tool surface. Keep
    // discovery entry points while reserving local read/edit/test capabilities.
    const starters = roundRobinToolNames(
      discoveryBundles.map((bundle) => DISCOVERY_STARTER_TOOL_NAMES[bundle] || [])
    );
    const followups = roundRobinToolNames(
      discoveryBundles.map((bundle) => DISCOVERY_FOLLOWUP_TOOL_NAMES[bundle] || [])
    );
    return [
      ...starters,
      ...IMPLEMENTATION_CRITICAL_TOOL_NAMES,
      ...followups,
      "inspect_project",
      "list_files",
    ];
  }

  const codeTools = mutationCompleted
    ? VERIFICATION_FIRST_CODE_TOOL_NAMES
    : LOCAL_COMPACT_CODE_TOOL_NAMES.filter((name) => name !== "finish");
  const discoveryContinuation = roundRobinToolNames(
    discoveryBundles.map((bundle) => DISCOVERY_CONTINUATION_TOOL_NAMES[bundle] || [])
  );
  return [...codeTools, ...discoveryContinuation];
}

function bundlesForProfile(id) {
  if (id === "pipeline") return ["pipeline"];
  if (id === "supervision" || id === "tmux") return ["tmux"];
  if (["agentlink", "agent-link", "collaboration", "coordination"].includes(id)) return ["agentlink"];
  if (["mcp", "model-context-protocol"].includes(id)) return ["mcp"];
  if (["json", "structured-json", "structured-data", "extraction"].includes(id)) return ["json"];
  if (id === "image") return ["image-generation"];
  if (["vision", "perception", "image-read"].includes(id)) return ["image-read"];
  if (id === "canvas") return ["canvas"];
  if (["long-job", "long-jobs", "background-job"].includes(id)) return ["long-job"];
  if (CODE_PROFILES.has(id)) return ["code"];
  if (BROWSER_PROFILES.has(id)) return ["browser"];
  if (RESEARCH_PROFILES.has(id)) return ["research"];
  if (WRITING_PROFILES.has(id)) return ["writing"];
  return [];
}

function inferredBundles(text) {
  const bundles = [];
  if (
    /\b(start_long_job|long_job_status|long[- ]running|long job|background job|run (?:it|this|the command) in (?:the )?background|overnight job|durable job|asynchronous job)\b/i.test(text)
  ) {
    bundles.push("long-job");
  }
  if (/\b(tmux|tmux_[a-z_]+|terminal session|detached session|capture (?:the )?pane|send keys)\b/i.test(text)) {
    bundles.push("tmux");
  }
  if (
    /\b(agentlink|agent link|agentlink_[a-z_]+|peer agents?|agent collaboration|shared (?:task )?board|agent handoff)\b/i.test(text)
  ) {
    bundles.push("agentlink");
  }
  if (/\b(mcp|mcp_[a-z_]+|model context protocol)\b/i.test(text)) bundles.push("mcp");
  if (
    /\b(json specialist|json_specialist(?:_batch)?|schema[- ]bound|strict json|structured (?:json|output|data)|extract.{0,40}(?:as|into) json|batch annotation)\b/i.test(text)
  ) {
    bundles.push("json");
  }
  if (
    /\b(?:generate|create|draw|render|make)\b.{0,50}\b(?:image|photo|illustration|poster|cover|artwork|logo|picture)\b|\b(?:text[- ]to[- ]image|generate_image|image generation)\b/i.test(text)
  ) {
    bundles.push("image-generation");
  }
  if (
    /\b(?:read|inspect|analy[sz]e|describe|understand|ocr)\b.{0,50}\b(?:image|photo|picture|png|jpe?g|webp)\b|\b(?:read_image|image perception|vision model)\b/i.test(text)
  ) {
    bundles.push("image-read");
  }
  if (/\b(send_to_canvas|canvas)\b|\b(?:show|preview|display|send)\b.{0,30}\bartifact\b/i.test(text)) {
    bundles.push("canvas");
  }
  if (
    /\b(code|codebase|repository|repo|implement|debug|fix|repair|refactor|compile|build|test|tests|bug|patch|script|database|sql|docker|deploy|python|javascript|typescript|node(?:\.js)?|java|kotlin|swift|rust|golang)\b/i.test(text)
  ) {
    bundles.push("code");
  }
  if (
    /https?:\/\/|\b(browser|browse|web\s?page|navigate|click|fill (?:in|out)|submit (?:a |the )?form|log ?in|screenshot)\b/i.test(text)
  ) {
    bundles.push("browser");
  }
  if (/\b(research|web search|search (?:the )?web|find sources?|citations?|cite|latest|current information|literature review)\b/i.test(text)) {
    bundles.push("research");
  }
  if (
    /\b(draft|revise|rewrite|proofread|novel|book|chapter|story|essay|article|manuscript|screenplay|script prose|writing style)\b/i.test(text)
  ) {
    bundles.push("writing");
  }
  return bundles;
}

function profileToolNames(profile) {
  if (!profile || typeof profile !== "object" || !Array.isArray(profile.tools)) return [];
  const names = [];
  for (const item of profile.tools) {
    const value = String(item || "").trim();
    if (!value) continue;
    const normalized = value.toLowerCase();
    const alias = PROFILE_TOOL_ALIASES[normalized];
    if (alias) names.push(...alias);
    else if (COMPACT_ELIGIBLE_TOOL_NAMES.has(normalized)) names.push(normalized);
  }
  return names;
}

function finitePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function serializedChars(tools) {
  return JSON.stringify(tools).length;
}

function compactToolNames({ config, goal, profile, messages }) {
  const explicitBundles = bundlesForProfile(profileId(config, profile));
  const inferred = inferredBundles(taskText(goal, config, messages));
  const explicitProfileTools = profileToolNames(profile);
  const bundleOrder = [];
  for (const bundle of explicitBundles) bundleOrder.push(bundle);
  for (const bundle of inferred) {
    if (!bundleOrder.includes(bundle)) bundleOrder.push(bundle);
  }
  if (
    bundleOrder.includes("research") &&
    hasLocalResearchWorkspaceIntent(goal || config.goal, messages) &&
    !bundleOrder.includes("code")
  ) {
    bundleOrder.push("code");
  }
  if (bundleOrder.length === 0 && explicitProfileTools.length === 0) bundleOrder.push("general");

  const names = [];
  const seen = new Set();
  const append = (name) => {
    if (!name || name === "finish" || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  if (bundleOrder.includes("code") && bundleOrder.some((bundle) => MIXED_DISCOVERY_BUNDLES.has(bundle))) {
    for (const name of mixedDiscoveryCodeToolNames(bundleOrder, messages)) append(name);
  }
  for (const bundle of bundleOrder) {
    for (const name of COMPACT_TOOL_BUNDLES[bundle] || []) append(name);
  }
  for (const name of explicitProfileTools) append(name);
  return names;
}

/**
 * Return a pure, ordered subset of an existing OpenAI function-tool array.
 *
 * Hosted providers and an explicit `toolSurfacePolicy: "full"` retain every
 * valid, enabled descriptor. Local/loopback providers default to a compact,
 * task-shaped surface. Returned entries normally reuse the original descriptor
 * objects. A failed-test repair may expose one bounded internal rewrite alias
 * over the registered apply_patch tool; runtime validation still owns the exact
 * path, anchor, and transactional mutation.
 */
export function selectProgressiveTools(
  tools,
  { config = {}, goal = "", profile = "", messages = [] } = {}
) {
  const validated = validatedUniqueTools(tools);
  const enabled = validated.filter(({ name }) => !toolIsDisabled(name, config));
  const finish = enabled.find(({ name }) => name === "finish")?.tool;
  if (!finish) {
    throw new TypeError("An enabled, valid finish function tool must exist in the input tool array");
  }

  if (config.verifiedCompletionPending === true) {
    return [finish];
  }

  if (
    config.artifactValidationPhase === true &&
    config.testFailureRepairActive !== true &&
    config.testVerificationPending !== true
  ) {
    const available = new Map(enabled.map(({ name, tool }) => [name, tool]));
    const pendingGitActions = Array.isArray(config.artifactValidationPendingGitActions)
      ? config.artifactValidationPendingGitActions.map((item) => String(item || "").toLowerCase())
      : [];
    const boundedCommitPaths = Array.isArray(config.artifactValidationCommitPaths)
      ? config.artifactValidationCommitPaths
      : [];
    if (
      pendingGitActions.includes("commit") &&
      pendingGitActions.every((action) => ["add", "commit"].includes(action)) &&
      boundedCommitPaths.length > 0
    ) {
      const commitProjectChanges = constrainRepositoryStateCommit(
        available.get("run_command"),
        boundedCommitPaths
      );
      if (commitProjectChanges) return [commitProjectChanges, finish].filter(Boolean);
    }
    return artifactValidationToolNames(config).map((name) => available.get(name)).filter(Boolean);
  }

  if (config.testFailureRepairActive === true) {
    const available = new Map(enabled.map(({ name, tool }) => [name, tool]));
    if (config.testFailureRepositoryStateRepair === true) {
      const runCommand = available.get("run_command");
      const commitProjectChanges = constrainRepositoryStateCommit(
        runCommand,
        config.repositoryStateRepairCommitPaths
      );
      if (commitProjectChanges) {
        return [commitProjectChanges, finish].filter(Boolean);
      }
      const repositoryStateTool = runCommand
        ? {
            ...runCommand,
            function: {
              ...runCommand.function,
              description: [
                "Resolve the retained repository-state verification gate without changing task content merely to alter Git status.",
                "Inspect status and diff, preserve intended task-owned changes, run appropriate checks, stage and commit only those changes, then rerun the exact retained verification command.",
              ].join(" "),
            },
          }
        : null;
      return [repositoryStateTool, finish].filter(Boolean);
    }
    const constrainedRepairPatch = constrainFailedTestApplyPatch(
      available.get("apply_patch"),
      config.testFailureRepairPatchTargets
    );
    const constrainedInstructionCreate = constrainWriteFilePaths(
      available.get("write_file"),
      Array.isArray(config.testFailureRepairAllowedCreates)
        ? config.testFailureRepairAllowedCreates
        : []
    );
    const toolNames = config.testFailureRepairMutationRequired === true
      ? [
          ...(config.testFailureRepairNeedsPatchContext === true
            ? ["read_file", "search_files"]
            : []),
          "apply_patch",
          ...(constrainedInstructionCreate ? ["write_file"] : []),
          "finish",
        ]
      : [
          "read_file",
          "search_files",
          "apply_patch",
          ...(constrainedInstructionCreate ? ["write_file"] : []),
          "run_command",
          "finish",
        ];
    return toolNames
      .map((name) => {
        if (name === "apply_patch") return constrainedRepairPatch;
        if (name === "write_file") return constrainedInstructionCreate;
        return available.get(name);
      })
      .filter(Boolean);
  }

  if (config.requiredProjectCommandPending === true) {
    const available = new Map(enabled.map(({ name, tool }) => [name, tool]));
    const requiredCommand = constrainRunCommand(
      available.get("run_command"),
      config.requiredProjectCommand,
      "Run this exact user-requested project command now. It is retained as a first-class acceptance requirement. Do not substitute a nearby test, repeat Git operations, or restart discovery. If it fails, its concrete output will reopen bounded repair tools."
    );
    return [requiredCommand, finish].filter(Boolean);
  }

  if (config.testVerificationPending === true) {
    const available = new Map(enabled.map(({ name, tool }) => [name, tool]));
    const verificationCommand = constrainRunCommand(
      available.get("run_command"),
      config.testVerificationCommand,
      "Run the exact discovered test suite now. A canonical source changed after the last test, so no artifact work or further discovery is valid until this command passes or returns a concrete failure."
    );
    return [verificationCommand, finish].filter(Boolean);
  }

  if (
    profileId(config, profile) === "data" &&
    toolSurfacePolicy(config, profile) !== "full" &&
    config.dataProjectDiscoveryReady !== true
  ) {
    const available = new Map(enabled.map(({ name, tool }) => [name, tool]));
    const discovery = dataProjectDiscoveryState(messages);
    if (discovery.phase === "inspect") {
      return [available.get("inspect_project"), finish].filter(Boolean);
    }
    if (discovery.phase !== "ready") {
      const readFile = constrainReadFilePaths(available.get("read_file"), discovery.paths, discovery.phase);
      return [readFile, finish].filter(Boolean);
    }
  }

  if (config.localFailureRecoveryActive === true) {
    const available = new Map(enabled.map(({ name, tool }) => [name, tool]));
    const requestedLimit = finitePositiveInteger(
      config.toolSurfaceMaxTools ?? config.localToolMaxTools,
      DEFAULT_LOCAL_TOOL_LIMIT
    );
    const toolLimit = Math.min(requestedLimit, LOCAL_TOOL_HARD_CAP);
    const charTarget = finitePositiveInteger(
      config.toolSurfaceMaxChars ?? config.localToolSchemaCharTarget,
      DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET
    );
    const selected = [];
    for (const name of ["read_file", "read_image", "apply_patch", "write_file", "run_command", "search_files", "inspect_project"]) {
      if (selected.length + 1 >= toolLimit) break;
      const tool = available.get(name);
      if (!tool) continue;
      const candidate = [...selected, tool, finish];
      if (serializedChars(candidate) > charTarget) continue;
      selected.push(tool);
    }
    return [...selected, finish];
  }

  const phaseEnabled = config.convergenceOutputPhase === true
    ? enabled.filter(
        ({ name }) =>
          !CONVERGENCE_DISCOVERY_TOOL_NAMES.has(name) ||
          (name === "run_command" && config.convergenceAllowRunCommand === true)
      )
    : enabled;

  if (shouldStartWithDeepResearch(goal || config.goal, messages)) {
    const deepResearch = phaseEnabled.find(({ name }) => name === "deep_research")?.tool;
    if (deepResearch) return [deepResearch, finish];
  }

  if (toolSurfacePolicy(config, profile) === "full") return phaseEnabled.map(({ tool }) => tool);

  const available = new Map(phaseEnabled.map(({ name, tool }) => [name, tool]));
  const requestedLimit = finitePositiveInteger(
    config.toolSurfaceMaxTools ?? config.localToolMaxTools,
    DEFAULT_LOCAL_TOOL_LIMIT
  );
  const toolLimit = Math.min(requestedLimit, LOCAL_TOOL_HARD_CAP);
  const charTarget = finitePositiveInteger(
    config.toolSurfaceMaxChars ?? config.localToolSchemaCharTarget,
    DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET
  );
  const selected = [];

  for (const name of compactToolNames({ config, goal, profile, messages })) {
    if (selected.length + 1 >= toolLimit) break;
    const tool = available.get(name);
    if (!tool || tool === finish) continue;
    const candidate = [...selected, tool, finish];
    if (serializedChars(candidate) > charTarget) continue;
    selected.push(tool);
  }

  return [...selected, finish];
}
