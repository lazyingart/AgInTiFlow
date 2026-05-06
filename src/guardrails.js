import { evaluateCommandPolicy } from "./command-policy.js";
import { checkWorkspaceToolUse, WORKSPACE_TOOL_NAMES } from "./workspace-tools.js";
import { normalizeWrapperName } from "./tool-wrappers.js";
import { checkTmuxToolUse, TMUX_TOOL_NAMES } from "./tmux-tools.js";

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
  if (WORKSPACE_TOOL_NAMES.includes(toolName)) {
    return checkWorkspaceToolUse(toolName, args, config);
  }

  if (TMUX_TOOL_NAMES.includes(toolName)) {
    return checkTmuxToolUse(toolName, args, config);
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

  if (toolName === "web_research") {
    if (config.allowWebSearch === false) {
      return { allowed: false, reason: "Web research is disabled because web search is disabled for this run.", category: "web-search" };
    }
    const query = String(args.query || "").trim();
    if (!query) return { allowed: false, reason: "Research query is required.", category: "web-search" };
    if (Buffer.byteLength(query, "utf8") > 1000) {
      return { allowed: false, reason: "Research query is too large.", category: "web-search" };
    }
    return { allowed: true };
  }

  if (toolName === "read_image") {
    if (!config.allowFileTools) {
      return { allowed: false, reason: "Image reading requires workspace file tools to be enabled.", category: "perception-tools" };
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

  if (toolName === "generate_image") {
    if (!config.allowAuxiliaryTools) {
      return { allowed: false, reason: "Auxiliary tools are disabled for this run.", category: "auxiliary-tools" };
    }

    const prompt = String(args.prompt || "").trim();
    if (!prompt) return { allowed: false, reason: "Image prompt is required.", category: "auxiliary-tools" };
    if (Buffer.byteLength(prompt, "utf8") > MAX_CANVAS_CONTENT_BYTES) {
      return { allowed: false, reason: "Image prompt is too large.", category: "auxiliary-tools" };
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
