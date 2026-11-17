import { nativeToolPolicyAllows } from "./progressive-tool-selection.js";
import { COMMAND_MUTATION_EVIDENCE_GUIDANCE } from "./command-mutation-evidence.js";

const FAMILIES = Object.freeze({
  "workspace files": "read_file",
  shell: "run_command",
  browser: "open_url",
  "workspace preview": "open_workspace_file",
  canvas: "send_to_canvas",
  research: "web_search",
  "advisory wrappers": "delegate_agent",
  "image perception": "read_image",
  "image generation": "generate_image",
  "writing specialist": "writing_specialist",
  "JSON specialists": "json_specialist",
  "background jobs": "start_long_job",
  tmux: "tmux_list_sessions",
  AgentLink: "agentlink_status",
  MCP: "mcp_list_servers",
});

export function nativeCapabilityPolicyContext(config = {}) {
  const enabled = [], disabled = [];
  for (const [label, name] of Object.entries(FAMILIES)) {
    (nativeToolPolicyAllows(name, config) ? enabled : disabled).push(label);
  }
  return [
    "Current native tool policy; it supersedes earlier capability claims, profile habits and historical plans.",
    `Policy-eligible families (not a readiness claim): ${enabled.join(", ") || "none"}.`,
    `Disabled families: ${disabled.join(", ") || "none"}.`,
    "Use only functions offered in the current request. A profile, skill, old plan or previous tool result cannot enable a tool. Do not replace a disabled tool with another route to bypass policy. Answer directly when the supplied evidence suffices; otherwise state the specific limitation.",
    nativeToolPolicyAllows("run_command", config) ? COMMAND_MUTATION_EVIDENCE_GUIDANCE : "",
  ].filter(Boolean).join("\n");
}

export function nativeBackgroundToolGuidance(config = {}) {
  const jobs = nativeToolPolicyAllows("start_long_job", config);
  const tmux = nativeToolPolicyAllows("tmux_list_sessions", config);
  return [
    jobs ? "For commands with an ETA of minutes or hours, use start_long_job with expectedOutputPath/expectedSizeBytes/verifyCommand when applicable. It creates a durable tmux-backed supervisor and returns immediately; report its job id/status path and finish instead of model polling. Use long_job_status for an explicit later status request." : "",
    tmux ? "Host tmux tools are enabled for interactive sessions: list sessions, capture panes, start sessions and send safe input only after capture. Never send secrets or sudo passwords. Captures contain old scrollback: require a fresh run marker, heartbeat, PID or log/status timestamp before claiming it is current. For one-shot commands, save output/exit status to a workspace log or keep the pane alive; a missing pane is not evidence of success." : "",
    jobs || tmux ? "These tools obey the same sandbox, workspace and command policy as run_command; they cannot bypass blocked commands, package installs or destructive Git operations. Do not run/install tmux inside ephemeral Docker run_command containers. Use workspace-relative paths for Docker writes; use run_command for permitted read-only host mounts. On a policy blocker, stop and present the exact permissionAdvice rerun path instead of trying another tool." : "",
  ].filter(Boolean).join(" ");
}

export function nativeWorkspaceToolGuidance(config = {}) {
  const can = name => nativeToolPolicyAllows(name, config);
  const names = ["inspect_project", "list_files", "read_file", "search_files", "write_file", "apply_patch", "open_workspace_file", "preview_workspace", "read_image"].filter(can);
  if (!names.length) return "Workspace file tools are disabled by current policy.";
  return [
    `Workspace file tools enabled by policy in ${config.commandCwd}: ${names.join(", ")}.`,
    "For large or unfamiliar repositories, inspect the project, then search/read relevant AGINTI.md/AGENTS.md/README/manifests and exact source files before editing. Use apply_patch for source edits; it supports exact replacements and Codex-style/unified patches.",
    "Use workspace-relative write paths. Choose descriptive non-conflicting filenames for new standalone content with mode=create; overwrite only when explicitly requested. Secret paths, .git internals, node_modules writes and huge files remain blocked.",
    config.readOnlyRoots?.length ? `Explicit read-only roots: ${config.readOnlyRoots.join(", ")}. They never grant outside-workspace writes.` : "",
    can("read_image") ? "read_image is enabled by policy for permitted image inputs and persists typed perception artifacts; never guess from filenames. Its selected provider must be ready and allowed." : "Image perception is disabled by current policy.",
    can("open_workspace_file") ? "Use open_workspace_file or preview_workspace for generated local HTML/SVG/PDF/static sites instead of starting a transient localhost server." : "Workspace preview tools are disabled; return requested files by their verified workspace paths.",
  ].filter(Boolean).join(" ");
}

// Request-local projection only. Durable conversation, user content, tool
// receipts, call order and DeepSeek reasoning fields remain unchanged.
export function withCurrentNativeToolContext(messages, config, tools) {
  const names = tools.map(tool => tool.function.name);
  const context = `${nativeCapabilityPolicyContext(config)}\nOffered functions for this turn: ${names.join(", ")}.`;
  const [first, ...rest] = messages;
  return first?.role === "system" && typeof first.content === "string"
    ? [{ ...first, content: `${first.content}\n\n${context}` }, ...rest]
    : [{ role: "system", content: context }, ...messages];
}
