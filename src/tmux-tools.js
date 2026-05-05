import crypto from "node:crypto";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { evaluateCommandPolicy } from "./command-policy.js";
import { redactSensitiveText } from "./redaction.js";

const execFile = promisify(execFileCallback);
const MAX_CAPTURE_LINES = 500;
const MAX_SEND_BYTES = 12000;
const MAX_COMMAND_BYTES = 4000;
const TARGET_PATTERN = /^[A-Za-z0-9_.:@%+-]{1,120}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_.+-]{1,80}$/;
const FIELD_SEPARATOR = "|";
const ALLOWED_KEYS = new Set([
  "Enter",
  "C-c",
  "C-d",
  "Escape",
  "Tab",
  "Up",
  "Down",
  "Left",
  "Right",
  "Backspace",
  "C-a",
  "C-e",
  "C-u",
  "C-k",
]);
const SECRET_PATTERN = /(api[_-]?key|auth[_-]?token|npm[_-]?token|_authToken|password|passwd|secret|bearer\s+[A-Za-z0-9._-]+)/i;
const DESTRUCTIVE_PATTERN =
  /\b(rm\s+-[^\n;]*[rf][^\n;]*(\/|\*|~|\$HOME)|mkfs(?:\.[a-z0-9]+)?\b|dd\s+if=.*\s+of=\/dev\/|shutdown\b|reboot\b|poweroff\b)/i;
const ABSOLUTE_PATH_PATTERN = /(^|[\s"'`=(:])((?:\/[A-Za-z0-9._@%+~:-]+)+\/?)/g;
const ALWAYS_ALLOWED_ABSOLUTE_PATHS = new Set(["/dev/null"]);

export const TMUX_TOOL_NAMES = ["tmux_list_sessions", "tmux_capture_pane", "tmux_send_keys", "tmux_start_session"];

function safeEnv() {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    TERM: process.env.TERM || "xterm-256color",
  };
}

async function runTmux(args, options = {}) {
  try {
    const result = await execFile("tmux", args, {
      timeout: options.timeout ?? 12000,
      maxBuffer: options.maxBuffer ?? 220 * 1024,
      env: safeEnv(),
    });
    return {
      ok: true,
      stdout: redactSensitiveText(result.stdout || ""),
      stderr: redactSensitiveText(result.stderr || ""),
    };
  } catch (error) {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      stdout: redactSensitiveText(String(error?.stdout || "")),
      stderr: redactSensitiveText(String(error?.stderr || message)),
      error: message,
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
    };
  }
}

export async function tmuxAvailable() {
  const result = await runTmux(["-V"], { timeout: 4000, maxBuffer: 16 * 1024 });
  return Boolean(result.ok);
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function validateTarget(target) {
  const normalized = String(target || "").trim();
  if (!normalized) return { ok: false, reason: "tmux target is required." };
  if (!TARGET_PATTERN.test(normalized)) {
    return { ok: false, reason: "tmux target contains unsupported characters." };
  }
  return { ok: true, target: normalized };
}

function validateSessionName(name) {
  const normalized = String(name || `aginti-${Date.now()}`).trim();
  if (!SESSION_PATTERN.test(normalized)) {
    return { ok: false, reason: "tmux session name must use letters, numbers, dot, underscore, plus, or dash." };
  }
  return { ok: true, name: normalized };
}

function resolveCwd(config, cwd = ".") {
  const root = path.resolve(config.commandCwd || process.cwd());
  const requested = path.resolve(root, String(cwd || "."));
  const relative = path.relative(root, requested);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: "tmux cwd must stay inside the configured workspace." };
  }
  return { ok: true, cwd: requested };
}

function isInsideDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueAbsolutePaths(text = "") {
  const paths = new Set();
  for (const match of String(text || "").matchAll(ABSOLUTE_PATH_PATTERN)) {
    const candidate = match[2];
    if (!candidate || candidate.startsWith("//")) continue;
    paths.add(candidate.replace(/[),.;]+$/g, ""));
  }
  return [...paths].filter(Boolean);
}

function checkWorkspaceBoundTmuxText(text = "", config = {}, label = "tmux text") {
  if (!config.useDockerSandbox) return { ok: true };
  const root = path.resolve(config.commandCwd || process.cwd());
  for (const candidate of uniqueAbsolutePaths(text)) {
    if (ALWAYS_ALLOWED_ABSOLUTE_PATHS.has(candidate)) continue;
    const resolved = path.resolve(candidate);
    if (!isInsideDirectory(root, resolved)) {
      return {
        ok: false,
        reason: `${label} references an absolute host path outside the configured workspace while Docker sandbox mode is active: ${candidate}. Use a workspace-relative path or rerun with --sandbox-mode host for trusted whole-host access.`,
      };
    }
  }
  return { ok: true };
}

function checkHostShellPolicyForTmuxText(text = "", config = {}, label = "tmux text") {
  const command = String(text || "").trim();
  if (!command) return { ok: true };
  if (config.useDockerSandbox || config.sandboxMode !== "host" || config.allowDestructive) {
    return { ok: true };
  }
  const policy = evaluateCommandPolicy(command, config);
  if (policy.allowed) return { ok: true };
  return {
    ok: false,
    reason: `${label} is blocked by the same host shell policy as run_command: ${policy.reason}`,
    category: policy.category || "tmux",
    needsApproval: policy.needsApproval,
  };
}

function parseSessions(stdout = "") {
  return String(stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, windows, attached, created, activity] = line.split(FIELD_SEPARATOR);
      return {
        name,
        windows: Number(windows) || 0,
        attached: Number(attached) || 0,
        created: Number(created) || 0,
        activity: Number(activity) || 0,
      };
    });
}

function parsePanes(stdout = "") {
  return String(stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [target, cwd, command, active, title] = line.split(FIELD_SEPARATOR);
      return {
        target,
        cwd,
        command,
        active: active === "1",
        title,
      };
    });
}

export async function listTmuxSessions(args = {}) {
  const sessionsResult = await runTmux([
    "list-sessions",
    "-F",
    "#{session_name}|#{session_windows}|#{session_attached}|#{session_created}|#{session_activity}",
  ]);
  if (!sessionsResult.ok && /no server running|failed to connect/i.test(`${sessionsResult.stderr} ${sessionsResult.error}`)) {
    return { ok: true, toolName: "tmux_list_sessions", sessions: [], panes: [], summary: "No tmux server is running." };
  }
  if (!sessionsResult.ok) return { ok: false, toolName: "tmux_list_sessions", error: sessionsResult.stderr || sessionsResult.error };

  let panes = [];
  if (args.includePanes !== false) {
    const panesResult = await runTmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index}|#{pane_current_path}|#{pane_current_command}|#{pane_active}|#{pane_title}",
    ]);
    if (panesResult.ok) panes = parsePanes(panesResult.stdout);
  }
  const sessions = parseSessions(sessionsResult.stdout);
  return {
    ok: true,
    toolName: "tmux_list_sessions",
    sessions,
    panes,
    summary: `${sessions.length} tmux session(s), ${panes.length} pane(s).`,
  };
}

export async function captureTmuxPane(args = {}) {
  const target = validateTarget(args.target);
  if (!target.ok) return { ok: false, toolName: "tmux_capture_pane", blocked: true, reason: target.reason };
  const lines = clampInteger(args.lines, 80, 1, MAX_CAPTURE_LINES);
  const result = await runTmux(["capture-pane", "-t", target.target, "-p", "-S", `-${lines}`], {
    timeout: 8000,
    maxBuffer: 260 * 1024,
  });
  if (!result.ok) return { ok: false, toolName: "tmux_capture_pane", target: target.target, error: result.stderr || result.error };
  const content = redactSensitiveText(result.stdout || "").replace(/\s+$/g, "");
  return {
    ok: true,
    toolName: "tmux_capture_pane",
    target: target.target,
    lines,
    content,
    contentBytes: Buffer.byteLength(content, "utf8"),
  };
}

export async function sendTmuxKeys(args = {}, config = {}) {
  const target = validateTarget(args.target);
  if (!target.ok) return { ok: false, toolName: "tmux_send_keys", blocked: true, reason: target.reason };
  const text = String(args.text || "");
  const keys = Array.isArray(args.keys) ? args.keys.map(String).filter(Boolean) : [];
  const enter = args.enter !== false;
  if (text && Buffer.byteLength(text, "utf8") > MAX_SEND_BYTES) {
    return { ok: false, toolName: "tmux_send_keys", blocked: true, reason: "tmux text payload is too large." };
  }
  if (SECRET_PATTERN.test(text)) {
    return { ok: false, toolName: "tmux_send_keys", blocked: true, reason: "tmux text appears to contain a secret." };
  }
  if (DESTRUCTIVE_PATTERN.test(text)) {
    return { ok: false, toolName: "tmux_send_keys", blocked: true, reason: "tmux text appears destructive; ask the user before sending it." };
  }
  const workspaceBound = checkWorkspaceBoundTmuxText(text, config, "tmux text");
  if (!workspaceBound.ok) {
    return { ok: false, toolName: "tmux_send_keys", blocked: true, reason: workspaceBound.reason };
  }
  const hostPolicy = checkHostShellPolicyForTmuxText(text, config, "tmux text");
  if (!hostPolicy.ok) {
    return {
      ok: false,
      toolName: "tmux_send_keys",
      blocked: true,
      reason: hostPolicy.reason,
      category: hostPolicy.category,
      needsApproval: hostPolicy.needsApproval,
    };
  }
  for (const key of keys) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, toolName: "tmux_send_keys", blocked: true, reason: `Unsupported tmux key: ${key}` };
    }
  }

  const steps = [];
  if (text) {
    const sent = await runTmux(["send-keys", "-t", target.target, "-l", text], { timeout: 8000 });
    if (!sent.ok) return { ok: false, toolName: "tmux_send_keys", target: target.target, error: sent.stderr || sent.error };
    steps.push("literal-text");
  }
  const keyArgs = [...keys];
  if (enter) keyArgs.push("Enter");
  if (keyArgs.length > 0) {
    const sent = await runTmux(["send-keys", "-t", target.target, ...keyArgs], { timeout: 8000 });
    if (!sent.ok) return { ok: false, toolName: "tmux_send_keys", target: target.target, error: sent.stderr || sent.error };
    steps.push(...keyArgs);
  }

  return {
    ok: true,
    toolName: "tmux_send_keys",
    target: target.target,
    sentTextBytes: Buffer.byteLength(text, "utf8"),
    sentTextSha256: text ? crypto.createHash("sha256").update(text).digest("hex") : "",
    keys: keyArgs,
    steps,
  };
}

export async function startTmuxSession(args = {}, config = {}) {
  const name = validateSessionName(args.name);
  if (!name.ok) return { ok: false, toolName: "tmux_start_session", blocked: true, reason: name.reason };
  const cwd = resolveCwd(config, args.cwd || ".");
  if (!cwd.ok) return { ok: false, toolName: "tmux_start_session", blocked: true, reason: cwd.reason };
  const command = String(args.command || "").trim();
  if (command && Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
    return { ok: false, toolName: "tmux_start_session", blocked: true, reason: "tmux startup command is too large." };
  }
  if (SECRET_PATTERN.test(command)) {
    return { ok: false, toolName: "tmux_start_session", blocked: true, reason: "tmux startup command appears to contain a secret." };
  }
  if (DESTRUCTIVE_PATTERN.test(command)) {
    return {
      ok: false,
      toolName: "tmux_start_session",
      blocked: true,
      reason: "tmux startup command appears destructive; ask the user before starting it.",
    };
  }
  const workspaceBound = checkWorkspaceBoundTmuxText(command, config, "tmux startup command");
  if (!workspaceBound.ok) {
    return { ok: false, toolName: "tmux_start_session", blocked: true, reason: workspaceBound.reason };
  }
  const hostPolicy = checkHostShellPolicyForTmuxText(command, config, "tmux startup command");
  if (!hostPolicy.ok) {
    return {
      ok: false,
      toolName: "tmux_start_session",
      blocked: true,
      reason: hostPolicy.reason,
      category: hostPolicy.category,
      needsApproval: hostPolicy.needsApproval,
    };
  }

  const tmuxArgs = ["new-session", "-d", "-s", name.name, "-c", cwd.cwd];
  if (command) tmuxArgs.push(command);
  const result = await runTmux(tmuxArgs, { timeout: 10000 });
  if (!result.ok) return { ok: false, toolName: "tmux_start_session", session: name.name, error: result.stderr || result.error };
  return {
    ok: true,
    toolName: "tmux_start_session",
    session: name.name,
    target: `${name.name}:0.0`,
    cwd: cwd.cwd,
    command: command ? redactSensitiveText(command) : "",
  };
}

export function checkTmuxToolUse(toolName, args = {}, config = {}) {
  if (!config.allowShellTool) {
    return { allowed: false, reason: "tmux tools require the shell tool to be enabled.", category: "tmux" };
  }
  if (toolName === "tmux_list_sessions") return { allowed: true, category: "tmux" };
  if (toolName === "tmux_capture_pane") {
    const target = validateTarget(args.target);
    return target.ok ? { allowed: true, category: "tmux" } : { allowed: false, reason: target.reason, category: "tmux" };
  }
  if (toolName === "tmux_send_keys") {
    const target = validateTarget(args.target);
    if (!target.ok) return { allowed: false, reason: target.reason, category: "tmux" };
    const text = String(args.text || "");
    if (Buffer.byteLength(text, "utf8") > MAX_SEND_BYTES) {
      return { allowed: false, reason: "tmux text payload is too large.", category: "tmux" };
    }
    if (SECRET_PATTERN.test(text)) {
      return { allowed: false, reason: "tmux text appears to contain a secret.", category: "tmux" };
    }
    if (DESTRUCTIVE_PATTERN.test(text)) {
      return { allowed: false, reason: "tmux text appears destructive; ask the user before sending it.", category: "tmux" };
    }
    const workspaceBound = checkWorkspaceBoundTmuxText(text, config, "tmux text");
    if (!workspaceBound.ok) return { allowed: false, reason: workspaceBound.reason, category: "tmux" };
    const hostPolicy = checkHostShellPolicyForTmuxText(text, config, "tmux text");
    if (!hostPolicy.ok) {
      return {
        allowed: false,
        reason: hostPolicy.reason,
        category: hostPolicy.category || "tmux",
        needsApproval: hostPolicy.needsApproval,
      };
    }
    for (const key of Array.isArray(args.keys) ? args.keys : []) {
      if (!ALLOWED_KEYS.has(String(key))) return { allowed: false, reason: `Unsupported tmux key: ${key}`, category: "tmux" };
    }
    return { allowed: true, category: "tmux" };
  }
  if (toolName === "tmux_start_session") {
    const name = validateSessionName(args.name);
    if (!name.ok) return { allowed: false, reason: name.reason, category: "tmux" };
    const cwd = resolveCwd(config, args.cwd || ".");
    if (!cwd.ok) return { allowed: false, reason: cwd.reason, category: "tmux" };
    const command = String(args.command || "");
    if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
      return { allowed: false, reason: "tmux startup command is too large.", category: "tmux" };
    }
    if (SECRET_PATTERN.test(command)) {
      return { allowed: false, reason: "tmux startup command appears to contain a secret.", category: "tmux" };
    }
    if (DESTRUCTIVE_PATTERN.test(command)) {
      return { allowed: false, reason: "tmux startup command appears destructive; ask the user before starting it.", category: "tmux" };
    }
    const workspaceBound = checkWorkspaceBoundTmuxText(command, config, "tmux startup command");
    if (!workspaceBound.ok) return { allowed: false, reason: workspaceBound.reason, category: "tmux" };
    const hostPolicy = checkHostShellPolicyForTmuxText(command, config, "tmux startup command");
    if (!hostPolicy.ok) {
      return {
        allowed: false,
        reason: hostPolicy.reason,
        category: hostPolicy.category || "tmux",
        needsApproval: hostPolicy.needsApproval,
      };
    }
    return { allowed: true, category: "tmux" };
  }
  return { allowed: true, category: "tmux" };
}
