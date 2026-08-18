import { evaluateCommandPolicy } from "./command-policy.js";
import { checkWorkspaceToolUse, WORKSPACE_TOOL_NAMES } from "./workspace-tools.js";
import { normalizeWrapperName } from "./tool-wrappers.js";
import { checkTmuxToolUse, TMUX_TOOL_NAMES } from "./tmux-tools.js";
import { checkLongJobToolUse, LONG_JOB_TOOL_NAMES } from "./long-job-tools.js";
import { checkMcpToolUse, isMcpBridgeTool } from "./mcp/policy.js";
import { AGENTLINK_TOOL_NAMES, checkAgentLinkToolUse } from "./agentlink.js";
import { normalizeProviderId } from "./provider-contract.js";
import { resolveAuxiliaryImageEndpoint } from "./auxiliary-tools.js";

const DESTRUCTIVE_KEYWORDS = [
  "delete",
  "remove",
  "purchase",
  "buy now",
  "checkout",
  "pay now",
  "place order",
  "confirm order",
  "sign out",
  "log out",
  "logout",
];

const KNOWN_WRAPPERS = new Set(["codex", "claude", "gemini", "copilot", "qwen"]);
const KNOWN_SPECIALIST_PROVIDERS = new Set(["localllm", "deepseek", "openai", "openrouter", "qwen", "venice", "mock"]);
const MAX_CANVAS_CONTENT_BYTES = 120_000;
const DESTRUCTIVE_PROMPT_HINTS = [
  "delete",
  "remove files",
  "rm -",
  "git push",
  "git reset",
  "git checkout",
  "install",
  "sudo",
  "deploy",
  "publish",
];

function checkSpecialistProviderBoundary({ rawProvider, config = {}, permissionFlag, label, category }) {
  const raw = String(rawProvider || "").trim();
  if (!raw) return null;
  const requested = normalizeProviderId(raw, "");
  if (!requested || !KNOWN_SPECIALIST_PROVIDERS.has(requested)) {
    return { allowed: false, reason: `Unknown ${label} provider: ${raw}`, category };
  }
  const active = normalizeProviderId(config.provider || "localllm", "");
  if (requested !== active && config[permissionFlag] !== true) {
    return {
      allowed: false,
      reason: `${label} provider override ${active || "unknown"} -> ${requested} is disabled for this run. Select ${requested} as the active provider or explicitly enable ${permissionFlag}.`,
      category,
    };
  }
  return null;
}

function isTransientDockerPreviewCommand(command) {
  return /\bpython3?\s+-m\s+http\.server\b|\bnpx\s+(?:--yes\s+)?(?:serve|http-server)\b|\bnpm\s+exec\s+(?:serve|http-server)\b|\bphp\s+-S\s+127\.0\.0\.1:/i.test(
    command
  );
}

function isDockerTmuxProcessCommand(command = "") {
  return [
    /^tmux\b/i,
    /^(?:sudo\s+)?apt(?:-get)?\s+install\b.*\btmux\b/i,
    /^(?:sudo\s+)?(?:dnf|yum)\s+install\b.*\btmux\b/i,
    /^apk\s+add\b.*\btmux\b/i,
    /^brew\s+install\b.*\btmux\b/i,
    /^(curl|wget)\b.*\btmux\b/i,
  ].some((pattern) => pattern.test(command));
}

function isNpxAgintiCommand(command = "") {
  return /\b(?:npx(?:\s+(?:-y|--yes))?|npm\s+exec|pnpm\s+dlx|yarn\s+dlx)\s+(?:@lazyingart\/agintiflow|aginti)\b/i.test(
    command
  );
}

function isAgintiCliCommand(command = "") {
  return /(?:^|[\s;&|('"])(?:node\s+[-\w./]*aginti-cli\.js|aginti)(?:\s|$)/i.test(command);
}

function normalizeDomain(hostname) {
  return hostname.replace(/^www\./, "").toLowerCase();
}

export function isDomainAllowed(urlString, allowedDomains) {
  if (!allowedDomains || allowedDomains.length === 0) return true;
  const url = new URL(urlString);
  const hostname = normalizeDomain(url.hostname);

  return allowedDomains.some((allowed) => {
    const candidate = normalizeDomain(allowed);
    return hostname === candidate || hostname.endsWith(`.${candidate}`);
  });
}

export function checkToolUse({ toolName, args, snapshot, config }) {
  if (isMcpBridgeTool(toolName)) {
    return checkMcpToolUse(toolName, args, config);
  }

  if (WORKSPACE_TOOL_NAMES.includes(toolName)) {
    return checkWorkspaceToolUse(toolName, args, config);
  }

  if (TMUX_TOOL_NAMES.includes(toolName)) {
    return checkTmuxToolUse(toolName, args, config);
  }

  if (LONG_JOB_TOOL_NAMES.includes(toolName)) {
    return checkLongJobToolUse(toolName, args, config);
  }

  if (AGENTLINK_TOOL_NAMES.includes(toolName)) {
    return checkAgentLinkToolUse(toolName, args, config);
  }

  if (toolName === "open_url") {
    if (!/^https?:\/\//.test(String(args.url || ""))) {
      return { allowed: false, reason: "Only http and https URLs are allowed." };
    }

    if (!isDomainAllowed(args.url, config.allowedDomains)) {
      return {
        allowed: false,
        reason: `Domain is outside the allowlist: ${args.url}`,
      };
    }

    return { allowed: true };
  }

  if (toolName === "web_search") {
    if (config.allowWebSearch === false) {
      return { allowed: false, reason: "Web search is disabled for this run.", category: "web-search" };
    }
    const query = String(args.query || "").trim();
    if (!query) return { allowed: false, reason: "Search query is required.", category: "web-search" };
    if (Buffer.byteLength(query, "utf8") > 500) {
      return { allowed: false, reason: "Search query is too large.", category: "web-search" };
    }
    return { allowed: true };
  }

  if (toolName === "read_web_page") {
    if (config.allowWebSearch === false) {
      return { allowed: false, reason: "Web page reading is disabled because web search is disabled for this run.", category: "web-search" };
    }
    const url = String(args.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      return { allowed: false, reason: "A public http/https source URL is required.", category: "web-search" };
    }
    if (!isDomainAllowed(url, Array.isArray(args.domains) && args.domains.length ? args.domains : config.allowedDomains)) {
      return { allowed: false, reason: `Domain is outside the research allowlist: ${url}`, category: "web-search" };
    }
    if (Number(args.maxChars) > 40_000 || Number(args.maxPassages) > 16) {
      return { allowed: false, reason: "Requested page extraction exceeds the bounded research limits.", category: "web-search" };
    }
    return { allowed: true };
  }

  if (toolName === "web_research") {
    if (config.allowWebSearch === false) {
      return { allowed: false, reason: "Web research is disabled because web search is disabled for this run.", category: "web-search" };
    }
    const query = String(args.query || "").trim();
    if (!query) return { allowed: false, reason: "Research query is required.", category: "web-search" };
    if (Buffer.byteLength(query, "utf8") > 1000) {
      return { allowed: false, reason: "Research query is too large.", category: "web-search" };
    }
    const mode = String(args.mode || "snippets").trim().toLowerCase();
    if (!["snippets", "openai"].includes(mode)) {
      return { allowed: false, reason: `Unknown web research mode: ${mode}`, category: "web-search" };
    }
    const activeProvider = normalizeProviderId(config.provider || "localllm", "localllm");
    if (mode === "openai" && activeProvider !== "openai" && config.allowHostedWebResearch !== true) {
      return {
        allowed: false,
        reason: "Hosted OpenAI web research is disabled for this provider boundary. Select OpenAI as the active provider or explicitly enable allowHostedWebResearch.",
        category: "web-search",
      };
    }
    return { allowed: true };
  }

  if (toolName === "deep_research") {
    if (config.allowWebSearch === false) {
      return { allowed: false, reason: "Deep research is disabled because web search is disabled for this run.", category: "web-search" };
    }
    const query = String(args.query || args.question || "").trim();
    if (!query) return { allowed: false, reason: "Research query is required.", category: "web-search" };
    if (Buffer.byteLength(query, "utf8") > 4000) {
      return { allowed: false, reason: "Research query is too large.", category: "web-search" };
    }
    const depth = String(args.depth || "standard").trim().toLowerCase();
    if (!["quick", "standard", "deep"].includes(depth)) {
      return { allowed: false, reason: `Unknown deep research depth: ${depth}`, category: "web-search" };
    }
    if (Number(args.maxQueries) > 12 || Number(args.maxSources) > 24) {
      return { allowed: false, reason: "Deep research request exceeds the bounded query/source budget.", category: "web-search" };
    }
    return { allowed: true };
  }

  if (toolName === "read_image") {
    if (!config.allowFileTools) {
      return { allowed: false, reason: "Image reading requires workspace file tools to be enabled.", category: "perception-tools" };
    }
    const provider = String(args.provider || args.engine || "auto").trim().toLowerCase();
    const knownProviders = new Set(["", "auto", "default", "localllm", "local", "local-llm", "local_llm", "openai", "codex"]);
    if (!knownProviders.has(provider)) {
      return { allowed: false, reason: `Unknown image-reading provider: ${provider}`, category: "perception-tools" };
    }
    const activeProvider = normalizeProviderId(config.provider || "localllm", "localllm");
    if (provider === "openai" && activeProvider !== "openai" && config.allowHostedImagePerception !== true) {
      return {
        allowed: false,
        reason: "Hosted OpenAI image perception is disabled for this provider boundary. Select OpenAI as the active provider or explicitly enable allowHostedImagePerception.",
        category: "perception-tools",
      };
    }
    if (provider === "codex" && config.allowWrapperTools !== true) {
      return { allowed: false, reason: "Codex image perception requires wrapper tools to be explicitly enabled.", category: "perception-tools" };
    }
    if (
      !args.dryRun &&
      ["", "auto", "default"].includes(provider) &&
      !["localllm", "openai"].includes(activeProvider) &&
      config.allowHostedImagePerception !== true
    ) {
      return {
        allowed: false,
        reason: `No automatic image-reading backend is enabled for active provider ${activeProvider}. Select localllm or explicitly enable a hosted image backend.`,
        category: "perception-tools",
      };
    }
    const values = []
      .concat(args.imagePaths || args.images || args.paths || args.imagePath || args.path || args.url || [])
      .flat()
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (values.length === 0) return { allowed: false, reason: "At least one image path or URL is required.", category: "perception-tools" };
    if (values.length > 4) return { allowed: false, reason: "Too many images. Maximum is 4.", category: "perception-tools" };
    for (const value of values) {
      if (/^https?:\/\//i.test(value)) {
        if (config.allowWebSearch === false) {
          return { allowed: false, reason: "Remote image reading requires web access to be enabled.", category: "perception-tools" };
        }
        if (!isDomainAllowed(value, config.allowedDomains)) {
          return { allowed: false, reason: `Remote image domain is outside the allowlist: ${value}`, category: "perception-tools" };
        }
        continue;
      }
      const policy = checkWorkspaceToolUse("read_file", { path: value }, config);
      if (!policy.allowed) return policy;
    }
    return { allowed: true };
  }

  if (toolName === "open_workspace_file" || toolName === "preview_workspace") {
    if (!config.allowFileTools) {
      return { allowed: false, reason: "Workspace preview tools require file tools to be enabled.", category: "workspace-tools" };
    }
    return checkWorkspaceToolUse("read_file", { path: args.path || args.file || "." }, config);
  }

  if (toolName === "click") {
    const element = snapshot.elements.find((item) => item.id === String(args.id));
    if (!element) return { allowed: false, reason: `Element ${args.id} is not in the latest snapshot.` };

    const label = `${element.text} ${element.ariaLabel}`.toLowerCase();
    if (!config.allowDestructive && DESTRUCTIVE_KEYWORDS.some((word) => label.includes(word))) {
      return { allowed: false, reason: `Blocked potentially destructive click target: "${label.trim()}"` };
    }

    return { allowed: true, element };
  }

  if (toolName === "type") {
    const element = snapshot.elements.find((item) => item.id === String(args.id));
    if (!element) return { allowed: false, reason: `Element ${args.id} is not in the latest snapshot.` };

    const looksSensitive =
      element.inputType === "password" ||
      /password/.test(element.autocomplete || "") ||
      /password/.test(`${element.text} ${element.ariaLabel} ${element.placeholder}`.toLowerCase());

    if (!config.allowPasswords && looksSensitive) {
      return { allowed: false, reason: "Typing into password-like fields is blocked by default." };
    }

    return { allowed: true, element };
  }

  if (toolName === "run_command") {
    const command = String(args.command || "").trim();
    if (isNpxAgintiCommand(command)) {
      return {
        allowed: false,
        reason:
          "`npx aginti`/`npm exec aginti` is blocked inside agent shell tools because it can resolve a stale project-local AgInTiFlow package, install from the network, or start a nested agent session. Use the current runtime status, project/session files, or ask the user to run a host CLI diagnostic.",
        category: "nested-aginti",
      };
    }
    if (config.useDockerSandbox && isAgintiCliCommand(command)) {
      return {
        allowed: false,
        reason:
          "Nested AgInTiFlow CLI calls are blocked in Docker run_command because the container may not have the active host CLI and may resolve stale project node_modules. Use current session evidence, workspace files, or ask the user to run host-side `aginti doctor --json`/`aginti capabilities --json`.",
        category: "nested-aginti",
      };
    }
    if (config.useDockerSandbox && isDockerTmuxProcessCommand(command)) {
      return {
        allowed: false,
        reason:
          "Docker run_command containers are short-lived, so tmux started there cannot persist. Use host tmux tools: tmux_start_session, tmux_capture_pane, tmux_send_keys, or tmux_list_sessions.",
        category: "tmux",
      };
    }
    if (config.useDockerSandbox && isTransientDockerPreviewCommand(command)) {
      return {
        allowed: false,
        reason:
          "Transient localhost preview servers inside Docker are not useful because command containers stop and ports are not published. Use preview_workspace/open_workspace_file, or switch to host mode for a persistent dev server.",
        category: "preview-server",
      };
    }
    return evaluateCommandPolicy(command, config);
  }

  if (toolName === "delegate_agent") {
    if (!config.allowWrapperTools) {
      return { allowed: false, reason: "Agent wrapper tools are disabled for this run." };
    }

    const wrapper = String(args.wrapper || "");
    if (!KNOWN_WRAPPERS.has(wrapper)) {
      return { allowed: false, reason: `Unknown agent wrapper: ${wrapper}` };
    }

    const preferredWrapper = normalizeWrapperName(config.preferredWrapper);
    if (wrapper !== preferredWrapper) {
      return { allowed: false, reason: `Only the selected wrapper is enabled for this run: ${preferredWrapper}` };
    }

    const prompt = String(args.prompt || "").trim();
    if (prompt.length < 8) {
      return { allowed: false, reason: "Agent wrapper prompt is too short." };
    }
    if (prompt.length > 4000) {
      return { allowed: false, reason: "Agent wrapper prompt is too long." };
    }

    const loweredPrompt = prompt.toLowerCase();
    if (!config.allowDestructive && DESTRUCTIVE_PROMPT_HINTS.some((hint) => loweredPrompt.includes(hint))) {
      return { allowed: false, reason: "Agent wrapper prompt appears to request write-capable or destructive work." };
    }

    return { allowed: true };
  }

  if (toolName === "research_wrapper") {
    if (!config.allowWrapperTools) {
      return { allowed: false, reason: "Research wrapper tools are disabled for this run.", category: "wrapper-tools" };
    }
    const wrapper = String(args.wrapper || config.preferredWrapper || "");
    if (wrapper && !KNOWN_WRAPPERS.has(wrapper)) {
      return { allowed: false, reason: `Unknown agent wrapper: ${wrapper}`, category: "wrapper-tools" };
    }
    const query = String(args.query || "").trim();
    const prompt = String(args.prompt || "").trim();
    if (!query && !prompt && !args.imagePath && !args.imagePaths && !args.images && !args.paths && !args.url) {
      return { allowed: false, reason: "Research wrapper requires a query, prompt, or image path.", category: "wrapper-tools" };
    }
    if (Buffer.byteLength(`${query}\n${prompt}`, "utf8") > 4000) {
      return { allowed: false, reason: "Research wrapper prompt is too large.", category: "wrapper-tools" };
    }
    return { allowed: true };
  }

  if (toolName === "writing_specialist") {
    const brief = String(args.writingBrief || args.brief || args.prompt || "").trim();
    if (!brief) return { allowed: false, reason: "Writing specialist requires writingBrief.", category: "writing-specialist" };
    const provider = String(args.provider || process.env.AGINTI_WRITING_PROVIDER || "").trim();
    const providerBoundary = checkSpecialistProviderBoundary({
      rawProvider: provider,
      config,
      permissionFlag: "allowHostedWritingSpecialist",
      label: "Writing specialist",
      category: "writing-specialist",
    });
    if (providerBoundary) return providerBoundary;
    const payloadBytes = Buffer.byteLength(
      [
        brief,
        args.canon,
        args.background,
        args.context,
        args.styleGuide,
        args.priorDraft,
        args.constraints,
        args.target,
        args.audience,
      ]
        .filter(Boolean)
        .join("\n"),
      "utf8"
    );
    if (payloadBytes > 180_000) {
      return {
        allowed: false,
        reason: "Writing specialist context is too large. Save the canon/draft to workspace files and ask for a focused section pass.",
        category: "writing-specialist",
      };
    }
    return { allowed: true };
  }

  if (toolName === "json_specialist") {
    const task = String(args.task || args.prompt || "").trim();
    if (!task) return { allowed: false, reason: "JSON specialist requires task.", category: "json-specialist" };
    if (!args.schema && !String(args.schemaJson || "").trim()) {
      return { allowed: false, reason: "JSON specialist requires schema or schemaJson.", category: "json-specialist" };
    }
    const provider = String(args.provider || process.env.AGINTI_JSON_PROVIDER || "").trim();
    const providerBoundary = checkSpecialistProviderBoundary({
      rawProvider: provider,
      config,
      permissionFlag: "allowHostedJsonSpecialist",
      label: "JSON specialist",
      category: "json-specialist",
    });
    if (providerBoundary) return providerBoundary;
    const payloadBytes = Buffer.byteLength(
      [
        task,
        args.instructions,
        args.requirements,
        args.context,
        args.inputText,
        args.source,
        args.content,
        args.schemaJson,
        args.inputJson ? JSON.stringify(args.inputJson) : "",
        args.schema ? JSON.stringify(args.schema) : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "utf8"
    );
    if (payloadBytes > 220_000) {
      return {
        allowed: false,
        reason: "JSON specialist payload is too large. Split the source into smaller independent items or save inputs to files and pass a focused excerpt.",
        category: "json-specialist",
      };
    }
    return { allowed: true };
  }

  if (toolName === "json_specialist_batch") {
    const items = Array.isArray(args.items) ? args.items : [];
    if (items.length === 0) return { allowed: false, reason: "JSON specialist batch requires items.", category: "json-specialist" };
    if (items.length > 32) return { allowed: false, reason: "JSON specialist batch is limited to 32 items per tool call.", category: "json-specialist" };
    const concurrency = Number(args.concurrency || 4);
    if (Number.isFinite(concurrency) && concurrency > 16) {
      return { allowed: false, reason: "JSON specialist batch concurrency is limited to 16.", category: "json-specialist" };
    }
    const provider = String(args.provider || args.defaults?.provider || process.env.AGINTI_JSON_PROVIDER || "").trim();
    const providerBoundary = checkSpecialistProviderBoundary({
      rawProvider: provider,
      config,
      permissionFlag: "allowHostedJsonSpecialist",
      label: "JSON specialist",
      category: "json-specialist",
    });
    if (providerBoundary) return providerBoundary;
    const payloadBytes = Buffer.byteLength(JSON.stringify({ defaults: args.defaults || {}, items }), "utf8");
    if (payloadBytes > 360_000) {
      return {
        allowed: false,
        reason: "JSON specialist batch payload is too large. Use fewer items or smaller chunk text per call.",
        category: "json-specialist",
      };
    }
    return { allowed: true };
  }

  if (toolName === "generate_image") {
    if (!config.allowAuxiliaryTools) {
      return { allowed: false, reason: "Auxiliary tools are disabled for this run.", category: "auxiliary-tools" };
    }

    const prompt = String(args.prompt || "").trim();
    if (!prompt) return { allowed: false, reason: "Image prompt is required.", category: "auxiliary-tools" };
    if (Buffer.byteLength(prompt, "utf8") > MAX_CANVAS_CONTENT_BYTES) {
      return { allowed: false, reason: "Image prompt is too large.", category: "auxiliary-tools" };
    }

    try {
      resolveAuxiliaryImageEndpoint(args, config);
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : "Image-generation endpoint override was refused.",
        category: "auxiliary-tools",
      };
    }

    const outputDir = String(args.outputDir || "artifacts/images/generated").trim();
    return checkWorkspaceToolUse("write_file", { path: `${outputDir.replace(/\/+$/, "")}/task_manifest.json` }, config);
  }

  if (toolName === "send_to_canvas") {
    const title = String(args.title || "").trim();
    if (!title) return { allowed: false, reason: "Canvas title is required." };
    const content = typeof args.content === "string" ? args.content : "";
    if (Buffer.byteLength(content, "utf8") > MAX_CANVAS_CONTENT_BYTES) {
      return {
        allowed: false,
        reason: "Canvas content is too large. Write it to a workspace file and send the path instead.",
      };
    }

    const canvasPath = String(args.path || "").trim();
    if (canvasPath) {
      return checkWorkspaceToolUse("read_file", { path: canvasPath }, config);
    }

    return { allowed: true };
  }

  return { allowed: true };
}
