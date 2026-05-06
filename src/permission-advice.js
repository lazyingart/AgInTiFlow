import { redactSensitiveText } from "./redaction.js";

const NETWORK_FAILURE_PATTERNS = [
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /name or service not known/i,
  /network is unreachable/i,
  /failed to connect/i,
  /connection timed out/i,
  /unable to access ['"].*?:/i,
];

const DOCKER_WORKSPACE_PATH_FAILURE_PATTERNS = [
  /\/home\/[^:\n]+:\s+No such file or directory/i,
  /\/Users\/[^:\n]+:\s+No such file or directory/i,
  /[A-Z]:\\[^:\n]+:\s+No such file or directory/i,
  /cannot statx? ['"][^'"]+['"]:\s+No such file or directory/i,
];

function quoteShell(value = "") {
  const text = String(value || "");
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function compactLine(value = "", max = 220) {
  const text = redactSensitiveText(String(value || "")).replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function sessionIdFrom(config = {}, state = {}) {
  return state.sessionId || config.resume || config.sessionId || "<session-id>";
}

function cwdFrom(config = {}) {
  return config.commandCwd || process.cwd();
}

function resumeCommand({ config = {}, state = {}, sandboxMode = "docker-workspace", destructive = false, prompt = "Continue the same task from the last blocker. Do not repeat the blocked command without new permission evidence." } = {}) {
  const parts = [
    "aginti",
    "--resume",
    quoteShell(sessionIdFrom(config, state)),
    "--cwd",
    quoteShell(cwdFrom(config)),
    "--sandbox-mode",
    sandboxMode,
    "--package-install-policy",
    "allow",
    "--approve-package-installs",
    "--allow-shell",
    "--allow-file-tools",
  ];
  if (destructive) parts.push("--allow-destructive");
  parts.push(quoteShell(prompt));
  return parts.join(" ");
}

function currentMode(config = {}) {
  return {
    sandboxMode: config.sandboxMode || "",
    packageInstallPolicy: config.packageInstallPolicy || "",
    allowShellTool: Boolean(config.allowShellTool),
    allowFileTools: Boolean(config.allowFileTools),
    allowDestructive: Boolean(config.allowDestructive),
    commandCwd: cwdFrom(config),
  };
}

function adviceForCategory(category = "", { toolName = "", args = {}, config = {}, state = {}, reason = "" } = {}) {
  const command = compactLine(args.command || args.text || "");
  const base = {
    category: category || "permission",
    reason: compactLine(reason || "The runtime policy blocked this operation."),
    currentMode: currentMode(config),
    blockedOperation: command ? `${toolName || "tool"}: ${command}` : toolName,
    instruction:
      "Stop and present this blocker to the user instead of repeatedly trying variants. Continue only after the user approves a safer mode, changes the workspace, or gives a replacement instruction.",
  };

  if (category === "workspace-path") {
    return {
      ...base,
      summary:
        "The requested path is outside the configured project workspace or is a protected path. Current-folder writes are allowed; outside-folder writes need the user to change the working directory or choose a trusted run.",
      options: [
        "Refuse: keep all outputs inside the current workspace and ask for a workspace-relative path.",
        "Allow this project: rerun from the intended project folder with --cwd <project-folder>.",
        "Trusted host: only if the user explicitly wants host-wide writes, rerun in host mode with --allow-destructive.",
      ],
      suggestedCommand: resumeCommand({
        config,
        state,
        sandboxMode: "host",
        destructive: true,
        prompt: "Continue after the user approved writing outside the previous workspace. Keep a clear audit trail and do not touch unrelated files.",
      }),
    };
  }

  if (category === "workspace-write") {
    return {
      ...base,
      summary:
        "Safe mode requires approval before workspace writes. Read-only inspection can continue; writing a file or patching code needs a one-time approval or a switch to normal mode for this session.",
      options: [
        "No: keep inspecting without edits.",
        "Yes this time: allow the current workspace write and continue once.",
        "Yes and always for this session: switch this session to normal mode.",
      ],
      suggestedCommand: resumeCommand({
        config,
        state,
        sandboxMode: "docker-workspace",
        prompt: "Continue after the user approved current-project writes for this task. Keep edits inside the workspace and verify changed files before finishing.",
      }),
    };
  }

  if (category === "host-sudo" || category === "system-package-install") {
    return {
      ...base,
      summary:
        "Host sudo and host OS package installs are not run automatically. Use Docker workspace setup when possible, or ask the user to run the exact host command manually.",
      options: [
        "Refuse: report the exact missing dependency and the manual host command.",
        "Allow contained setup: rerun in docker-workspace with package installs approved.",
        "Manual host setup: user runs the sudo command, then resumes the session.",
      ],
      suggestedCommand: resumeCommand({
        config,
        state,
        sandboxMode: "docker-workspace",
        prompt: "Continue using Docker workspace setup where possible. If host sudo is still required, stop and provide the exact manual command.",
      }),
    };
  }

  if (category === "package-install" || category === "env-setup" || category === "network-fetch" || category === "git-remote") {
    return {
      ...base,
      summary:
        "This operation needs network or environment setup. It is allowed when shell is enabled in docker-workspace mode with package installs approved.",
      options: [
        "Refuse: stop and explain that network/setup is not approved.",
        "Allow this task: rerun with docker-workspace and approved package installs.",
        "Trusted host: use host mode only when the user specifically needs host tools or host network behavior.",
      ],
      suggestedCommand: resumeCommand({
        config,
        state,
        sandboxMode: "docker-workspace",
        prompt: "Continue the same task with network/setup approved in Docker workspace mode. Verify the operation actually creates the expected output before reporting success.",
      }),
    };
  }

  if (category === "destructive") {
    return {
      ...base,
      summary:
        "This command is destructive and was blocked. Do not retry variants. First offer inspect-only or dry-run cleanup evidence; destructive cleanup requires explicit user approval.",
      options: [
        "Inspect only: run non-destructive checks such as `git status --short`, `git clean -nd`, `find <path> -maxdepth ... -print`, or targeted file listings.",
        "Safer cleanup plan: write a report listing exact files that would be removed. Do not include executable delete/reset/clean commands in the safe or non-destructive section.",
        "Explicit destructive approval: only after the user accepts data-loss risk, provide a separate approval path such as a rerun command with --allow-destructive.",
      ],
      suggestedCommand: resumeCommand({
        config,
        state,
        sandboxMode: "docker-workspace",
        prompt: "Continue with inspect-only or dry-run cleanup evidence. Do not delete, reset, clean, overwrite, or include executable destructive cleanup commands in safe/non-destructive instructions unless the user explicitly approves destructive actions.",
      }),
      destructiveApprovalCommand: resumeCommand({
        config,
        state,
        sandboxMode: "docker-workspace",
        destructive: true,
        prompt: "Continue after the user explicitly approved destructive project-local cleanup. Inspect first, delete only the named targets, and verify git status afterwards.",
      }),
      trustedHostCommand: resumeCommand({
        config,
        state,
        sandboxMode: "host",
        destructive: true,
        prompt: "Continue after the user explicitly approved trusted host destructive execution. Inspect first, avoid unrelated files, and keep git status understandable.",
      }),
    };
  }

  if (category === "permission-change" || category === "general-shell") {
    return {
      ...base,
      summary:
        "This command is broader or destructive enough to require a stronger trust mode. Prefer Docker workspace for project-local work; use trusted host mode only when necessary.",
      options: [
        "Refuse: explain the blocked command and ask for a safer project-local alternative.",
        "Allow contained broad shell: rerun in docker-workspace with package installs approved.",
        "Allow trusted host: rerun in host mode with --allow-destructive when the user accepts host risk.",
      ],
      suggestedCommand: resumeCommand({
        config,
        state,
        sandboxMode: "docker-workspace",
        prompt: "Continue with broad shell access inside Docker workspace. Avoid destructive host actions and verify outputs before finishing.",
      }),
      trustedHostCommand: resumeCommand({
        config,
        state,
        sandboxMode: "host",
        destructive: true,
        prompt: "Continue after the user approved trusted host execution. Inspect first, avoid unrelated files, and keep git status understandable.",
      }),
    };
  }

  return {
    ...base,
    summary:
      "The current runtime policy blocked this tool. Ask the user whether to keep the task inside the current workspace, approve a stronger mode, or stop.",
    options: [
      "Refuse: report the blocker and do not continue.",
      "Allow this task: rerun with explicit shell/file/package flags appropriate to the blocker.",
      "Change request: ask the user for a safer workspace-relative output or a manual setup step.",
    ],
    suggestedCommand: resumeCommand({ config, state }),
  };
}

export function buildPermissionAdvice({ toolName = "", args = {}, guard = {}, config = {}, state = {}, reason = "" } = {}) {
  const category = guard.category || "permission";
  return adviceForCategory(category, {
    toolName,
    args,
    config,
    state,
    reason: reason || guard.reason || "",
  });
}

export function looksLikeNetworkFailure(result = {}) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  return NETWORK_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksLikeDockerWorkspacePathFailure(result = {}, config = {}) {
  if ((config.sandboxMode || "") !== "docker-workspace") return false;
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  return DOCKER_WORKSPACE_PATH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildFailedCommandAdvice({ args = {}, commandPolicy = {}, commandResult = {}, config = {}, state = {} } = {}) {
  if (looksLikeDockerWorkspacePathFailure(commandResult, config)) {
    return {
      ...adviceForCategory("workspace-path", {
        toolName: "run_command",
        args,
        config,
        state,
        reason:
          "The command referenced a host absolute path that is not mounted inside the Docker workspace. Do not retry shell variants; keep output in the workspace or ask for explicit host-mode approval.",
      }),
      failureKind: "workspace-path",
    };
  }
  if (!looksLikeNetworkFailure(commandResult)) return null;
  return {
    ...adviceForCategory(commandPolicy.needsNetwork ? "network-fetch" : "general-shell", {
      toolName: "run_command",
      args,
      config,
      state,
      reason:
        "The command failed with a network-resolution/connectivity error. Do not report success unless a later check proves the expected artifact was created in this run.",
    }),
    failureKind: "network",
  };
}
