import { evaluateCommandPolicy } from "./command-policy.js";
import { checkWorkspaceToolUse, WORKSPACE_TOOL_NAMES } from "./workspace-tools.js";
import { normalizeWrapperName } from "./tool-wrappers.js";

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
