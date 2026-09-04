import { redactSensitiveText } from "./redaction.js";

const NETWORK_FAILURE_PATTERNS = [
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /name or service not known/i,
  /network is unreachable/i,
  /failed to connect/i,
  /failed to establish a new connection/i,
  /connection refused/i,
  /\bECONNREFUSED\b/i,
  /connection timed out/i,
  /unable to access ['"].*?:/i,
];

const LOCALHOST_TARGET_PATTERN = /\b(127\.0\.0\.1|localhost|::1)\b/i;
const READ_ONLY_FILE_TOOLS = new Set(["inspect_project", "list_files", "read_file", "search_files", "read_image"]);

const DOCKER_WORKSPACE_PATH_FAILURE_PATTERNS = [
  /\/home\/[^:\n]+:\s+No such file or directory/i,
  /\/Users\/[^:\n]+:\s+No such file or directory/i,
  /[A-Z]:\\[^:\n]+:\s+No such file or directory/i,
  /cannot statx? ['"][^'"]+['"]:\s+No such file or directory/i,
];

function unquoteShellToken(value = "") {
  const text = String(value || "").trim();
  if (
    text.length >= 2 &&
    ((text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('"') && text.endsWith('"')))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function isGeneratedVerificationPreviewPath(value = "") {
  const target = unquoteShellToken(value).replace(/\\/g, "/");
  if (
    !target ||
    target.startsWith("/") ||
    target.includes("..") ||
    /[*?\[\]{}$`]/.test(target)
  ) {
    return false;
  }
  return (
    /^(?:build|artifacts)\/verification\/[A-Za-z0-9._/-]+\.(?:png|jpe?g|webp)$/i.test(target) ||
    /^output\/preview[-_][A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/i.test(target)
  );
}

export function isOptionalGeneratedPreviewCleanup(toolName = "", args = {}) {
  if (toolName !== "run_command") return false;
  const firstSegment = String(args.command || args.text || "")
    .trim()
    .split(/(?:&&|;|\n)/, 1)[0]
    .trim();
  const match = firstSegment.match(/^rm\s+-f\s+(.+)$/);
  if (!match) return false;
  const targets = match[1].trim().split(/\s+/).filter(Boolean);
  return (
    targets.length > 0 &&
    targets.length <= 20 &&
    targets.every((target) => isGeneratedVerificationPreviewPath(target))
  );
}

export function isRecoverableDynamicEvidenceWrite(toolName = "", args = {}, guard = {}) {
  if (toolName !== "run_command" || guard?.category !== "destructive") return false;
  const command = String(args.command || args.text || "");
  if (!/\btee\s+/i.test(command)) return false;
  if (
    /(?:^|[;&|\n]\s*)(?:command\s+)?(?:rm|rmdir|mv|chmod|chown)\b/i.test(command) ||
    /\bgit\s+(?:checkout|switch|reset|clean)\b/i.test(command) ||
    /(?:^|\s)-delete(?:\s|$)/i.test(command)
  ) {
    return false;
  }
  const dynamicWorkspaceEvidenceTarget = new RegExp(
    String.raw`\btee\s+(?:--?append\s+|-a\s+)?["']?(?:\.aginti|artifacts|build/verification|output/verification)/[^\n;|]*\$\{?[A-Z_][A-Z0-9_]*\}?`,
    "i"
  );
  return dynamicWorkspaceEvidenceTarget.test(command);
}

export function recoverableMixedToolchainAudit(toolName = "", args = {}, guard = {}) {
  if (toolName !== "run_command" || guard?.category !== "general-shell") return null;
  const command = String(args.command || args.text || "").trim();
  const auditStart = command.search(
    /\s+&&\s+(?:python3?|node|ruby)\s+-\s*<<\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/i
  );
  if (auditStart <= 0) return null;

  const buildCommand = command.slice(0, auditStart).trim();
  const safePath = String.raw`[A-Za-z0-9._/-]+`;
  const safeBuild = new RegExp(
    String.raw`^(?:cd\s+['"]?(${safePath})['"]?\s*&&\s*)?(?:python3?|python)\s+['"]?(${safePath}\.py)['"]?(?:\s+2>&1)?$`,
    "i"
  );
  const match = buildCommand.match(safeBuild);
  if (!match) return null;
  const paths = [match[1], match[2]].filter(Boolean);
  if (
    paths.some(
      (value) =>
        value.startsWith("/") ||
        value.split("/").includes("..") ||
        /[*?\[\]{}$`]/.test(value)
    )
  ) {
    return null;
  }
  return { buildCommand };
}

export function recoverableInlineReadOnlyArtifactAudit(toolName = "", args = {}, guard = {}) {
  if (toolName !== "run_command" || guard?.category !== "general-shell") return null;
  const command = String(args.command || args.text || "").trim();
  const cdMatch = command.match(
    /^cd\s+(['"]?)([A-Za-z0-9._/-]+)\1\s*&&\s*([\s\S]+)$/i
  );
  const relativeCwd = cdMatch?.[2] || "";
  if (
    relativeCwd &&
    (relativeCwd.startsWith("/") ||
      relativeCwd.split("/").includes("..") ||
      /[*?\[\]{}$`]/.test(relativeCwd))
  ) {
    return null;
  }
  const auditCommand = String(cdMatch?.[3] || command).trim();
  if (!/^(?:python3?|python)\s+-c\s+(?:"[\s\S]*"|'[\s\S]*')(?:\s+2>&1)?$/i.test(auditCommand)) {
    return null;
  }
  if (
    !/(?:\bopen\s*\(|\.read(?:_bytes|_text)?\s*\(|\.stat\s*\(|hashlib\b|PdfReader\b|fitz\.open\s*\()/i.test(
      auditCommand
    )
  ) {
    return null;
  }
  const writeCapable = [
    /\bopen\s*\([^)]*,\s*['"][^'"]*[wax+][^'"]*['"]/i,
    /\.(?:write|write_bytes|write_text|touch|mkdir|unlink|rename|replace|rmdir|chmod|chown)\s*\(/i,
    /\b(?:subprocess|os\.system|shutil|socket|requests|urllib|http\.client|eval|exec|__import__)\b/i,
  ];
  if (writeCapable.some((pattern) => pattern.test(auditCommand))) return null;
  return { relativeCwd };
}

function goalRequestsDeletion(config = {}, state = {}) {
  const goal = String(config.goal || state.goal || state.meta?.goalContract?.current || "")
    .replace(/`([^`]+)`/g, "$1");
  const deletionIntent = /\b(?:delete|remove|clean\s+up|cleanup|purge|erase|discard|drop)\b|删除|刪除|移除|清理|清除|删掉|刪掉|削除|消去/i;
  if (!deletionIntent.test(goal)) return false;

  // A safety constraint such as "do not delete" is the opposite of
  // authorization. Strip bounded negated phrases before looking for a genuine
  // deletion request elsewhere in the goal.
  const withoutNegatedDeletion = goal
    .replace(
      /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|shouldn't|without)\s+(?:bundle|include|run|execute|retry)\b[^.\n]{0,320}(?:\.|$)/gi,
      " "
    )
    .replace(
      /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|shouldn't|without)\s+(?:retry(?:ing)?\s+or\s+)?(?:delete|remove|clean\s+up|cleanup|purge|erase|discard|drop)(?:\s+any)?\b/gi,
      " "
    )
    .replace(/(?:不要|不可|禁止|无需|無需|不需要)(?:再)?(?:删除|刪除|移除|清理|清除|删掉|刪掉)/g, " ")
    .replace(/(?:削除|消去)(?:しない|するな|不要)/g, " ");
  return deletionIntent.test(withoutNegatedDeletion);
}

export function isUnrequestedCleanupCommand(toolName = "", args = {}, config = {}, state = {}) {
  const goal = String(config.goal || state.goal || state.meta?.goalContract?.current || "").trim();
  if (!goal || toolName !== "run_command" || goalRequestsDeletion(config, state)) return false;
  const command = String(args.command || args.text || "");
  return command
    .split(/(?:&&|;|\n)/)
    .map((segment) => segment.trim())
    .some(
      (segment) =>
        /^(?:command\s+)?rm\s+(?:-[A-Za-z]*[fr][A-Za-z]*\s+|--force\s+)/.test(segment) ||
        /^find\s+\.\s+-type\s+d\s+-name\s+['"]?__pycache__['"]?\s+-prune\s+-exec\s+rm\s+-rf\s+\{\}\s+\+$/.test(
          segment
        ) ||
        /^find\s+\.\s+-type\s+f\s+-name\s+(['"]?)\*\.pyc\1\s+-delete$/.test(segment)
    );
}

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

  if (category === "opaque-external-validator-inspection") {
    return {
      ...base,
      autoRecover: true,
      summary:
        "The exact external validator was combined with another command or treated as inspectable source. This is a recoverable command-shape error, not a permission blocker.",
      instruction:
        "Continue automatically. Run any producer, build, or repair command separately first. Then run the exact declared external validator command unchanged in its own tool call. Do not inspect, wrap, prefix, suffix, pipe, redirect, or combine the validator, and do not ask for stronger permissions.",
      options: [
        "Run the required producer or build as one standalone command.",
        "Run the exact declared external validator unchanged as the next standalone command.",
        "Use only the validator's returned diagnostics as repair evidence.",
      ],
    };
  }

  if (category === "workspace-path") {
    if (READ_ONLY_FILE_TOOLS.has(toolName)) {
      return {
        ...base,
        autoRecover: Boolean(config.allowShellTool && config.sandboxMode === "host"),
        summary:
          "The read-only path is outside the workspace and outside the run's explicit read roots. Do not repeat the same file-tool call.",
        instruction:
          config.allowShellTool && config.sandboxMode === "host"
            ? "Continue automatically with one bounded read-only shell probe, or resume with an explicit --read-root for repeated structured reads. Do not ask for destructive permission and do not use recursive grep."
            : "Resume with an explicit --read-root for the required repository, or keep inspection inside the current workspace. This does not require destructive permission.",
        options: [
          "Immediate recovery: in host mode, use narrow read-only commands such as `test -d`, `sed -n`, `rg --files <exact-root>`, or `rg -n --max-count <N> <pattern> <exact-root>`.",
          "Structured recovery: rerun or resume with one repeatable `--read-root <absolute-path>` per repository that may be inspected.",
          "Keep writes in the configured workspace; read roots never authorize edits outside it.",
        ],
      };
    }
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

  if (category === "unbounded-discovery") {
    return {
      ...base,
      autoRecover: true,
      summary:
        "The command was read-only but unbounded. This is a recoverable search-shape problem, not a permission blocker.",
      instruction:
        "Continue automatically with a bounded search. Do not ask the user for approval and do not retry recursive grep.",
      options: [
        "Use `search_files` with a precise path and bounded result count.",
        "Use `rg -n --max-count <N> <pattern> <exact-file-or-directory>` with relevant `-g` filters.",
        "Inspect README, manifests, documented entry points, or `--help` output before searching implementation details.",
      ],
    };
  }

  if (category === "document-page-visual-batch") {
    return {
      ...base,
      autoRecover: true,
      summary:
        "The document review batched multiple rendered pages, so page-specific visual defects could be missed.",
      instruction:
        "Continue automatically by calling read_image once for each rendered page. Evaluate clipping, overflow, orphaned headings, sparse spill pages, table splits, margins, and hierarchy on that page before moving to the next one.",
      options: [
        "Review page 1 alone, repair any defect, and rebuild before reviewing later pages.",
        "Review each remaining page in a separate read_image call.",
        "Finish only after every page has its own accepted visual evidence.",
      ],
    };
  }

  if (category === "workspace-content") {
    return {
      ...base,
      autoRecover: true,
      summary:
        "The workspace write was blocked because its proposed content contains a secret-like value. Stronger permission cannot make that content safe to persist.",
      instruction:
        "Continue automatically with one corrected write: redact the sensitive value as [REDACTED] or omit the private URL, token, credential, cookie, or signed query entirely. Preserve the useful non-sensitive content and the requested artifact path. Do not repeat the blocked value, ask for stronger permission, or modify an authoritative source record merely to sanitize a derived artifact.",
      options: [
        "Rewrite the intended derived artifact with the sensitive value replaced by [REDACTED].",
        "Omit the private source field when it is unnecessary to the reader-facing result.",
        "Use dedicated key storage only when the task truly requires a reusable credential reference.",
      ],
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

  if (category === "host-local-service") {
    return {
      ...base,
      summary:
        "The command tried to reach a localhost service from inside the Docker workspace. In Docker, 127.0.0.1 is the container, not the host browser/server. Do not keep retrying the same URL from Docker.",
      options: [
        "If the service is a host browser/debug server/dev server, rerun the session in host sandbox mode and retry the exact connectivity probe.",
        "If Docker must be used, expose the service on a reachable host interface or use a configured gateway such as host.docker.internal when available.",
        "If the service is not running, start or ask the user to start it, then verify with a small curl probe before continuing.",
      ],
      suggestedCommand: resumeCommand({
        config,
        state,
        sandboxMode: "host",
        prompt:
          "Continue after switching to host sandbox because the task needs a host-local browser/dev-server endpoint. First rerun the exact localhost connectivity probe, then continue only if it succeeds.",
      }),
    };
  }

  if (category === "destructive") {
    if (isRecoverableDynamicEvidenceWrite(toolName, args, { category, reason })) {
      return {
        ...base,
        autoRecover: true,
        summary:
          "A generated-evidence command used a shell-expanded output filename that the workspace guard could not prove safe. The command stayed blocked, but no destructive permission is needed.",
        instruction:
          "Do not retry the same command and do not request destructive approval. Reissue the check with fresh literal workspace-relative evidence paths under `.aginti/verification/`; avoid variables, globs, and `/tmp` in tee/redirection targets, then continue the substantive validation.",
        options: [
          "Use a literal timestamp or nonce already written into the command text.",
          "Keep every log, hash file, and render under `.aginti/verification/`.",
          "Split the build and evidence checks into smaller commands if that makes each output path explicit.",
        ],
      };
    }
    if (
      isOptionalGeneratedPreviewCleanup(toolName, args) ||
      isUnrequestedCleanupCommand(toolName, args, config, state)
    ) {
      return {
        ...base,
        autoRecover: true,
        summary:
          "Unrequested cleanup was blocked safely; generated or verification files can remain ignored and the substantive task should continue.",
        instruction:
          "Do not retry, rename, or seek approval for this cleanup. Leave every candidate file in place, run any remaining read-only checks in a separate call, and finish the requested task when its substantive evidence passes.",
        options: [
          "Retain the generated previews as private verification evidence.",
          "Run source hashes, artifact checks, and git status separately without a delete command.",
          "Continue to a real content or layout repair if validation still reports a defect.",
        ],
      };
    }
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
    const mixedToolchainAudit = recoverableMixedToolchainAudit(
      toolName,
      args,
      { category, reason }
    );
    if (mixedToolchainAudit) {
      return {
        ...base,
        autoRecover: true,
        summary:
          "A safe project-local build was bundled with a broad inline audit. The combined command stayed blocked, but the build itself does not need stronger permission.",
        instruction:
          "Continue automatically by running only the supplied recoveryCommand as one toolchain call. Then inspect the artifact with built-in file tools or separate bounded read-only commands. Do not use a heredoc, shell-generated audit program, or request destructive permission.",
        options: [
          "Run the project-local builder by itself.",
          "Use read_file/list_files and separate checksum or document-metadata commands for evidence.",
          "Leave final reader-quality enforcement to the caller's deterministic artifact gate when one exists.",
        ],
        recoveryCommand: mixedToolchainAudit.buildCommand,
      };
    }
    const inlineReadOnlyAudit = recoverableInlineReadOnlyArtifactAudit(
      toolName,
      args,
      { category, reason }
    );
    if (inlineReadOnlyAudit) {
      return {
        ...base,
        autoRecover: true,
        summary:
          "A read-only artifact audit was expressed as an inline interpreter program. It remained blocked because arbitrary inline code is broad, but the task does not need stronger permission.",
        instruction:
          "Do not retry the inline program and do not request destructive permission. Continue from the retained build evidence, inspect the exact artifact with built-in file tools or bounded read-only metadata commands, and accept the caller's deterministic artifact gate when it is available.",
        options: [
          "Use read_file, list_files, or read_image for the exact artifact.",
          "Use an allowlisted bounded metadata command such as file, pdfinfo, sha256sum, or a short header read.",
          "Return the already-built artifact when the caller owns the final quality gate.",
        ],
      };
    }
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
  if (guard.permissionAdvice && typeof guard.permissionAdvice === "object") {
    return guard.permissionAdvice;
  }
  const guardReason = String(reason || guard.reason || "");
  if (
    toolName === "run_command" &&
    /^(?:cd|mkdir) target must be a safe workspace-relative directory:/i.test(guardReason)
  ) {
    const command = compactLine(args.command || args.text || "");
    const blockedCommand = /^mkdir target/i.test(guardReason) ? "mkdir" : "cd";
    return {
      category: "workspace-command-correction",
      reason: compactLine(guardReason),
      currentMode: currentMode(config),
      blockedOperation: command ? `${toolName}: ${command}` : toolName,
      autoRecover: true,
      summary:
        blockedCommand === "mkdir"
          ? "The command selected an outside-workspace scratch directory. This is a recoverable command-shape error, not a request for stronger permissions."
          : "The command added an unnecessary or out-of-scope cd prefix. The configured project is already the command working directory, so this is a recoverable command-shape error rather than a permission request.",
      instruction:
        blockedCommand === "mkdir"
          ? "Continue automatically with an ignored workspace-relative scratch directory such as .aginti/verification/<purpose>. Run the intended check from that subdirectory when an unrelated working directory is required. Do not ask for stronger permissions."
          : "Continue automatically from the configured project root. Remove the cd prefix, correct any paths that were relative to the wrong directory, and retry only the intended workspace-bounded command. Do not ask for stronger permissions.",
      options: [
        "Run the intended command directly from the configured project root.",
        "Use an ignored workspace-relative scratch subdirectory when the check requires another working directory.",
        "Keep external absolute paths read-only and keep all mutations inside the configured project.",
      ],
    };
  }
  const category = guard.category || "permission";
  return adviceForCategory(category, {
    toolName,
    args,
    config,
    state,
    reason: guardReason,
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

export function looksLikeDockerLocalhostFailure(args = {}, result = {}, config = {}) {
  if (!String(config.sandboxMode || "").startsWith("docker")) return false;
  const command = String(args.command || args.text || "");
  if (!LOCALHOST_TARGET_PATTERN.test(command)) return false;
  return looksLikeNetworkFailure(result);
}

export function goalRevisionCoversActiveTask(state = {}, evidenceRevision = 0) {
  const goalContract = state.meta?.goalContract || {};
  const currentRevision = Math.max(0, Number(goalContract.revision || 0));
  const candidateRevision = Math.max(0, Number(evidenceRevision || 0));
  if (currentRevision <= 0 || candidateRevision <= 0) return false;
  if (candidateRevision >= currentRevision) return true;

  const history = Array.isArray(goalContract.history) ? goalContract.history : [];
  const activeEntry = [...history]
    .reverse()
    .find(
      (item) =>
        Number(item?.revision || 0) <= currentRevision &&
        String(item?.taskHash || "").trim()
    );
  const activeTaskHash = String(activeEntry?.taskHash || "").trim();
  if (!activeTaskHash) return false;
  const activeTaskStartRevision = history
    .filter((item) => String(item?.taskHash || "").trim() === activeTaskHash)
    .map((item) => Math.max(0, Number(item?.revision || 0)))
    .filter(Boolean)
    .reduce((lowest, revision) => Math.min(lowest, revision), currentRevision);
  return candidateRevision >= activeTaskStartRevision;
}

function hasDurableCommitEvidence(state = {}, { requireCurrentMutation = true } = {}) {
  const mutationRevision = Math.max(
    0,
    Number(state.meta?.projectVerification?.mutationRevision || 0)
  );
  return (Array.isArray(state.meta?.durableGitEvidence) ? state.meta.durableGitEvidence : []).some(
    (item) =>
      String(item?.action || "").toLowerCase() === "commit" &&
      goalRevisionCoversActiveTask(state, item?.goalRevision) &&
      (
        !requireCurrentMutation ||
        Number(item?.mutationRevision || 0) >= mutationRevision
      )
  );
}

export function isCleanGitStatusAfterCurrentCommit(args = {}, result = {}, state = {}) {
  const command = String(args.command || args.text || "").trim();
  const cleanStatusCommand =
    /^git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+status\s+(?:--short|--porcelain(?:=[^\s]+)?)(?:\s+--untracked-files=(?:all|normal))?$/i.test(
      command
    );
  if (
    !cleanStatusCommand ||
    result.ok === false ||
    Number(result.exitCode ?? 0) !== 0 ||
    String(result.stdout || "").trim() ||
    String(result.stderr || "").trim()
  ) {
    return false;
  }
  // An exact clean status proves that the current files match HEAD. Permit a
  // same-task commit from an earlier mutation revision so interrupted work
  // that was externally restored to HEAD can return to its verifier. The
  // verifier, not this marker, still decides task completion.
  return hasDurableCommitEvidence(state, { requireCurrentMutation: false });
}

export function isAlreadyCommittedCleanGitNoop(args = {}, result = {}, state = {}) {
  const command = String(args.command || args.text || "");
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (
    !/(?:^|[;&|]\s*)git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+commit\b/i.test(command) ||
    !/nothing to commit/i.test(output) ||
    !/working tree clean/i.test(output)
  ) {
    return false;
  }
  return hasDurableCommitEvidence(state);
}

export function buildFailedCommandAdvice({ args = {}, commandPolicy = {}, commandResult = {}, config = {}, state = {} } = {}) {
  if (isAlreadyCommittedCleanGitNoop(args, commandResult, state)) {
    return {
      category: "repository-already-committed",
      reason:
        "Git reported that the current worktree is clean, and durable evidence already contains a commit covering this goal and mutation revision.",
      currentMode: currentMode(config),
      blockedOperation: compactLine(args.command || args.text || "git commit"),
      autoRecover: true,
      summary:
        "The requested commit is already satisfied. This no-op is not a permission problem and should not be retried.",
      instruction:
        "Do not stage or commit again. Run any still-pending exact verifier once, then call finish from the retained commit and verification evidence.",
      options: [
        "Run the pending exact verifier named in the current task contract.",
        "Call finish when all retained verification is current.",
      ],
      failureKind: "repository-already-committed",
    };
  }
  if (looksLikeDockerLocalhostFailure(args, commandResult, config)) {
    return {
      ...adviceForCategory("host-local-service", {
        toolName: "run_command",
        args,
        config,
        state,
        reason:
          "The command targeted localhost from Docker and failed to connect. This usually means the intended service is on the host loopback, not inside the container.",
      }),
      failureKind: "host-local-service",
    };
  }
  if (looksLikeDockerWorkspacePathFailure(commandResult, config) && commandPolicy.category !== "read-only") {
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
