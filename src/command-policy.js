export const SANDBOX_MODES = ["host", "docker-readonly", "docker-workspace"];
export const PACKAGE_INSTALL_POLICIES = ["block", "prompt", "allow"];

const READ_ONLY_PATTERNS = [
  /^pwd$/,
  /^date$/,
  /^whoami$/,
  /^which\s+[-\w.]+(?:\s+[-\w.]+)*$/,
  /^command\s+-v\s+[-\w.]+$/,
  /^uname(?:\s+-a)?$/,
  /^ls(?:\s+[-\w./~*]+)*$/,
  /^find(?:\s+[./~\w-]+)*(?:\s+-maxdepth\s+\d+)?(?:\s+-type\s+[fd])?$/,
  /^rg(?:\s+.+)?$/,
  /^cat(?:\s+[-\w./~*]+)+$/,
  /^head(?:\s+.+)?$/,
  /^tail(?:\s+.+)?$/,
  /^wc(?:\s+.+)?$/,
  /^sed\s+-n\s+['"0-9,:p\s-]+\s+[-\w./~*]+$/,
  /^git\s+(status|branch|log|show|diff(?:\s+--stat)?|remote\s+-v)(?:\s+.+)?$/,
  /^node\s+-v$/,
  /^npm\s+-v$/,
  /^python(?:3)?\s+--version$/,
  /^pip(?:3)?\s+--version$/,
  /^conda\s+--version$/,
  /^echo(?:\s+.+)?$/,
];

const TEST_PATTERNS = [
  /^npm\s+(run\s+)?(check|test|build|lint)(?:\s+--\s+[-\w./:=]+)*$/,
  /^npm\s+--prefix\s+[-\w./]+\s+(run\s+)?(check|test|build|lint)(?:\s+--\s+[-\w./:=]+)*$/,
  /^npm\s+test$/,
  /^node\s+--check\s+[-\w./]+$/,
  /^node\s+--test(?:\s+[-\w./]+)*$/,
  /^bash\s+-n\s+[-\w./]+\.sh$/,
  /^sh\s+-n\s+[-\w./]+\.sh$/,
  /^python(?:3)?\s+-m\s+py_compile\s+[-\w./]+\.py$/,
  /^python(?:3)?\s+-m\s+pytest(?:\s+[-\w./:=]+)*$/,
  /^pytest(?:\s+[-\w./:=]+)*$/,
];

const SAFE_WORKSPACE_WRITE_PATTERNS = [/^mkdir\s+-p\s+[-\w./]+$/];
const PERMISSION_CHANGE_PATTERNS = [/^(?:sudo\s+)?chmod\s+[-+=,rwxugoXst0-7]+\s+[-\w./]+$/];

const NETWORK_FETCH_PATTERNS = [
  /^curl\b(?=[\s\S]*https?:\/\/\S+)[\s\S]*$/,
  /^wget\b(?=[\s\S]*https?:\/\/\S+)[\s\S]*$/,
];

const GIT_WORKFLOW_PATTERNS = [
  /^git\s+add(?:\s+[-\w./*]+)+$/,
  /^git\s+commit\s+(?:-a\s+)?-m\s+(['"])[^'"\n]{1,220}\1$/,
  /^git\s+fetch(?:\s+[-\w./:=]+)*$/,
  /^git\s+pull\s+--ff-only(?:\s+[-\w./:=]+)*$/,
  /^git\s+push(?:\s+[-\w./:=]+)*$/,
];

const UNSAFE_GIT_PATTERNS = [
  /^git\s+pull\b(?!\s+--ff-only(?:\s|$))/,
  /^git\s+(merge|rebase|reset|checkout|switch|clean)\b/,
];

const TOOLCHAIN_PATTERNS = [
  /^python(?:3)?\s+[-\w./]+\.py(?:\s+[-\w./:=]+)*$/,
  /^latexmk\s+(?=[-\w./=\s]*-pdf\b)(?:(?:-cd|-pdf|-interaction=nonstopmode|-halt-on-error|-output-directory=[-\w./]+)\s+)+[-\w./]+\.tex$/,
  /^pdflatex\s+(?:(?:-interaction=nonstopmode|-halt-on-error|-output-directory=[-\w./]+|-jobname\s+[-\w./]+)\s+)*[-\w./]+\.tex$/,
];

const PACKAGE_INSTALL_PATTERNS = [
  /^npm\s+ci$/,
  /^npm\s+install(?:\s+[-@\w./:=]+)*$/,
  /^pnpm\s+install$/,
  /^pnpm\s+add(?:\s+[-@\w./:=]+)+$/,
  /^yarn\s+install$/,
  /^yarn\s+add(?:\s+[-@\w./:=]+)+$/,
  /^python(?:3)?\s+-m\s+pip\s+install\s+-r\s+[-\w./]+$/,
  /^python(?:3)?\s+-m\s+pip\s+install(?:\s+[-@\w./:=]+)+$/,
  /^pip(?:3)?\s+install\s+-r\s+[-\w./]+$/,
  /^pip(?:3)?\s+install(?:\s+[-@\w./:=]+)+$/,
  /^uv\s+(sync|pip\s+install)(?:\s+[-@\w./:=]+)*$/,
  /^conda\s+env\s+(create|update)\s+-f\s+[-\w./]+$/,
  /^conda\s+install(?:\s+[-@\w./:=]+)+$/,
];

const SYSTEM_PACKAGE_INSTALL_PATTERNS = [
  /^(?:sudo\s+)?apt(?:-get)?\s+update$/,
  /^(?:sudo\s+)?apt(?:-get)?\s+install(?:\s+-y)?(?:\s+[-@\w.+:=]+)+$/,
  /^(?:sudo\s+)?(?:dnf|yum)\s+(?:makecache|check-update)(?:\s+[-\w]+)*$/,
  /^(?:sudo\s+)?(?:dnf|yum)\s+install(?:\s+-y)?(?:\s+[-@\w.+:=]+)+$/,
  /^apk\s+add(?:\s+--no-cache)?(?:\s+[-@\w.+:=]+)+$/,
  /^brew\s+install(?:\s+[-@\w.+:=/]+)+$/,
  /^winget\s+install(?:\s+[-@\w.+:=/]+)+$/,
  /^choco\s+install(?:\s+[-@\w.+:=/]+)+$/,
];

const ENV_SETUP_PATTERNS = [
  /^python(?:3)?\s+-m\s+venv\s+\.venv$/,
  /^python(?:3)?\s+-m\s+venv\s+venv$/,
  /^npm\s+init\s+-y$/,
];

const BLOCKED_SHELL_TOKENS = ["&&", "||", ";", "|", ">", "<", "$(", "`"];
const BLOCKED_WRITE_TOKENS = [
  " rm",
  " mv",
  " chmod",
  " chown",
  " rmdir",
  " touch",
  " tee",
  "-delete",
  "git checkout",
  "git switch",
  "git reset",
  "git clean",
];

const ALWAYS_BLOCKED_PATTERNS = [
  /^npm\s+publish\b/i,
  /^npm\s+token\b/i,
  /^npm\s+(login|adduser)\b/i,
  /^npm\s+config\s+set\s+.*(?:_authToken|token)\b/i,
  /NPM_TOKEN\s*=/i,
  /_authToken\s*=/i,
  /OPENAI_API_KEY\s*=/i,
  /DEEPSEEK_API_KEY\s*=/i,
  /QWEN_API_KEY\s*=/i,
  /VENICE_API_KEY\s*=/i,
  /GRSAI(?:_API_KEY)?\s*=/i,
];

const SENSITIVE_COMMAND_PATTERNS = [
  /(^|[\s./])\.env(\s|$|[./])/i,
  /(^|[\s./])\.npmrc(\s|$|[./])/i,
  /^(env|printenv)(\s|$)/i,
  /(api[_-]?key|auth[_-]?token|npm[_-]?token|_authToken|bearer\s+[A-Za-z0-9._-]+)/i,
];

function normalizePolicy(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function normalizeSandboxMode(value) {
  return normalizePolicy(value, SANDBOX_MODES, "host");
}

export function normalizePackageInstallPolicy(value) {
  return normalizePolicy(value, PACKAGE_INSTALL_POLICIES, "prompt");
}

function matchAny(patterns, command) {
  return patterns.some((pattern) => pattern.test(command));
}

function isSafeRelativeDir(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("~")) return false;
  return normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

function isSafeVirtualWorkspaceDir(value) {
  const normalized = String(value || "").trim();
  if (!normalized.startsWith("/workspace/")) return false;
  return isSafeRelativeDir(normalized.replace(/^\/workspace\//, ""));
}

function classifyGitClone(normalized) {
  const match = normalized.match(
    /^git\s+clone(?:\s+--depth\s+\d+)?(?:\s+--branch\s+[-\w./]+)?\s+(https:\/\/\S+)(?:\s+([-\w./]+))?$/
  );
  if (!match) return null;

  const target = match[2] || "";
  if (target && !isSafeRelativeDir(target) && !isSafeVirtualWorkspaceDir(target)) {
    return {
      category: "blocked",
      reason: `git clone target must be a safe workspace-relative directory: ${target}`,
    };
  }

  return {
    category: "git-remote",
    needsNetwork: true,
    writesWorkspace: true,
    virtualWorkspacePath: Boolean(target && isSafeVirtualWorkspaceDir(target)),
    reason: "Git clone writes into the workspace and requires network access.",
  };
}

function classifySimpleCommand(normalized) {
  if (ALWAYS_BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { category: "blocked", reason: "Command is blocked because it may expose secrets or publish packages." };
  }
  if (SENSITIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { category: "blocked", reason: "Command is blocked because it references secrets or credential files." };
  }
  if (matchAny(UNSAFE_GIT_PATTERNS, normalized)) {
    return {
      category: "destructive",
      needsApproval: true,
      reason:
        "Git merge/rebase/reset/checkout/switch/clean, and non-ff-only pulls, can rewrite or conflict with local work. Inspect status/diff first and ask the user when the repository is divergent or conflicted.",
    };
  }

  if (matchAny(SAFE_WORKSPACE_WRITE_PATTERNS, normalized)) {
    const target = normalized.replace(/^mkdir\s+-p\s+/, "");
    const virtualWorkspacePath = isSafeVirtualWorkspaceDir(target);
    if (!isSafeRelativeDir(target) && !virtualWorkspacePath) {
      return { category: "blocked", reason: `mkdir target must be a safe workspace-relative directory: ${target}` };
    }
    return { category: "workspace-write", needsNetwork: false, writesWorkspace: true, virtualWorkspacePath };
  }
  if (matchAny(PERMISSION_CHANGE_PATTERNS, normalized)) {
    return {
      category: "permission-change",
      needsNetwork: false,
      writesWorkspace: true,
      reason: `Command changes workspace file mode: ${normalized}`,
    };
  }
  if (matchAny(GIT_WORKFLOW_PATTERNS, normalized)) {
    const remote = /^git\s+(fetch|pull|push)\b/.test(normalized);
    const writesWorkspace = /^git\s+(add|commit|pull)\b/.test(normalized);
    return {
      category: remote ? "git-remote" : "git-workflow",
      needsNetwork: remote,
      writesWorkspace,
      reason: "Git workflow command. Agent should run git status/diff first and stop on conflicts or divergence.",
    };
  }
  const gitCloneClassification = classifyGitClone(normalized);
  if (gitCloneClassification) return gitCloneClassification;

  const lowered = ` ${normalized.toLowerCase()} `;
  if (BLOCKED_WRITE_TOKENS.some((part) => lowered.includes(part))) {
    return {
      category: "destructive",
      needsNetwork: false,
      writesWorkspace: true,
      reason: `Command contains a write-capable or destructive token: ${normalized}`,
    };
  }
  if (BLOCKED_SHELL_TOKENS.some((part) => normalized.includes(part))) {
    return {
      category: "general-shell",
      needsNetwork: true,
      writesWorkspace: true,
      reason: `Command uses general shell syntax: ${normalized}`,
    };
  }

  if (matchAny(READ_ONLY_PATTERNS, normalized)) {
    return { category: "read-only", needsNetwork: false, writesWorkspace: false };
  }
  if (matchAny(TEST_PATTERNS, normalized)) {
    return { category: "test", needsNetwork: false, writesWorkspace: false };
  }
  if (matchAny(TOOLCHAIN_PATTERNS, normalized)) {
    return { category: "toolchain", needsNetwork: false, writesWorkspace: true };
  }
  if (matchAny(NETWORK_FETCH_PATTERNS, normalized)) {
    return { category: "network-fetch", needsNetwork: true, writesWorkspace: /(\s-o\s|\s-O\s)/.test(normalized) };
  }
  if (matchAny(SYSTEM_PACKAGE_INSTALL_PATTERNS, normalized)) {
    return { category: "system-package-install", needsNetwork: true, writesWorkspace: false, requiresDockerRoot: true };
  }
  if (matchAny(PACKAGE_INSTALL_PATTERNS, normalized)) {
    return { category: "package-install", needsNetwork: true, writesWorkspace: true };
  }
  if (matchAny(ENV_SETUP_PATTERNS, normalized)) {
    return { category: "env-setup", needsNetwork: false, writesWorkspace: true };
  }

  return {
    category: "general-shell",
    needsNetwork: false,
    writesWorkspace: false,
    reason: `Command is outside the narrow allowlist and requires a trusted shell policy: ${normalized}`,
  };
}

function classifyCdCommand(normalized) {
  const match = normalized.match(/^cd\s+([-\w./]+)\s+&&\s+(.+)$/);
  if (!match) return null;
  const [, dir, inner] = match;
  const virtualWorkspacePath = isSafeVirtualWorkspaceDir(dir);
  if (!isSafeRelativeDir(dir) && !virtualWorkspacePath) {
    return { category: "blocked", reason: `cd target must be a safe workspace-relative directory: ${dir}` };
  }
  const innerClassification = classifySimpleCommand(inner.trim());
  if (innerClassification.category === "blocked") return innerClassification;
  return { ...innerClassification, cdDir: dir, virtualWorkspacePath };
}

export function classifyCommand(command) {
  const normalized = String(command || "").trim();
  if (!normalized) return { category: "blocked", reason: "Command is empty." };

  return classifyCdCommand(normalized) || classifySimpleCommand(normalized);
}

export function evaluateCommandPolicy(command, config) {
  const classification = classifyCommand(command);
  const normalizedCommand = String(command || "").trim();
  const sandboxMode = normalizeSandboxMode(config.sandboxMode);
  const packageInstallPolicy = normalizePackageInstallPolicy(config.packageInstallPolicy);
  const dockerWorkspace = sandboxMode === "docker-workspace";
  const packageInstallsAllowed = packageInstallPolicy === "allow";
  const trustedDockerShell = dockerWorkspace && packageInstallsAllowed;
  const trustedHostShell = sandboxMode === "host" && Boolean(config.allowDestructive);

  if (classification.category === "blocked") {
    return { allowed: false, ...classification, sandboxMode, packageInstallPolicy };
  }

  if (classification.virtualWorkspacePath && !config.useDockerSandbox) {
    return {
      allowed: false,
      ...classification,
      reason: "Virtual /workspace shell paths are allowed only inside Docker sandbox mode.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (!config.allowShellTool) {
    return {
      allowed: false,
      category: classification.category,
      reason: "Shell tool is disabled for this run.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (sandboxMode === "host" && /^sudo\b/.test(normalizedCommand)) {
    return {
      allowed: false,
      category: "host-sudo",
      needsApproval: true,
      reason:
        "Interactive host sudo is not run by AgInTiFlow because it can hang on password prompts or change the machine globally. Prefer project-local setup, Docker workspace mode, or return the exact manual install command for the user.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.category === "system-package-install" && sandboxMode === "host") {
    return {
      allowed: false,
      category: classification.category,
      needsApproval: true,
      reason:
        "Host OS package installs are not run automatically. Prefer an existing toolchain, project-local setup, Docker workspace mode, or report the exact manual command the user can run.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (
    classification.category === "package-install" ||
    classification.category === "env-setup" ||
    classification.category === "system-package-install"
  ) {
    if (packageInstallPolicy !== "allow") {
      return {
        allowed: false,
        category: classification.category,
        needsApproval: true,
        reason:
          packageInstallPolicy === "prompt"
            ? "Environment setup or package install requires explicit approval in the UI."
            : "Environment setup and package installs are blocked by policy.",
        sandboxMode,
        packageInstallPolicy,
      };
    }
  }

  if (classification.category === "general-shell" && !trustedDockerShell && !trustedHostShell) {
    return {
      allowed: false,
      ...classification,
      needsApproval: true,
      reason:
        sandboxMode === "host"
          ? "General shell commands on the host require Allow destructive actions. Prefer Docker workspace mode for broad shell access."
          : "General Docker shell commands require Package installs = allow in docker-workspace mode.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.category === "permission-change" && !trustedDockerShell && !trustedHostShell) {
    return {
      allowed: false,
      ...classification,
      needsApproval: true,
      reason:
        sandboxMode === "host"
          ? "Workspace permission changes on the host require Allow destructive actions. Prefer Docker workspace mode."
          : "Docker permission changes require docker-workspace mode with Package installs = allow.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.category === "destructive" && !config.allowDestructive) {
    return {
      allowed: false,
      ...classification,
      needsApproval: true,
      reason: "Destructive shell commands require Allow destructive actions.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.needsNetwork && config.useDockerSandbox && !trustedDockerShell) {
    return {
      allowed: false,
      ...classification,
      needsApproval: true,
      reason: "Docker network commands require docker-workspace mode with Package installs = allow.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.writesWorkspace && config.useDockerSandbox && sandboxMode !== "docker-workspace") {
    return {
      allowed: false,
      category: classification.category,
      reason: "Workspace-writing toolchain commands must run in Docker workspace-write sandbox mode.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  return {
    allowed: true,
    ...classification,
    requiresDockerRoot: Boolean(classification.requiresDockerRoot && config.useDockerSandbox),
    sandboxMode,
    packageInstallPolicy,
  };
}
