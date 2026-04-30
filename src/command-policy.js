export const SANDBOX_MODES = ["host", "docker-readonly", "docker-workspace"];
export const PACKAGE_INSTALL_POLICIES = ["block", "prompt", "allow"];

const READ_ONLY_PATTERNS = [
  /^pwd$/,
  /^date$/,
  /^whoami$/,
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
  /^npm\s+test$/,
  /^node\s+--check\s+[-\w./]+$/,
  /^python(?:3)?\s+-m\s+pytest(?:\s+[-\w./:=]+)*$/,
  /^pytest(?:\s+[-\w./:=]+)*$/,
];

const PACKAGE_INSTALL_PATTERNS = [
  /^npm\s+ci$/,
  /^npm\s+install$/,
  /^pnpm\s+install$/,
  /^yarn\s+install$/,
  /^python(?:3)?\s+-m\s+pip\s+install\s+-r\s+[-\w./]+$/,
  /^pip(?:3)?\s+install\s+-r\s+[-\w./]+$/,
  /^conda\s+env\s+(create|update)\s+-f\s+[-\w./]+$/,
];

const ENV_SETUP_PATTERNS = [
  /^python(?:3)?\s+-m\s+venv\s+\.venv$/,
  /^python(?:3)?\s+-m\s+venv\s+venv$/,
  /^npm\s+init\s+-y$/,
];

const BLOCKED_SHELL_TOKENS = ["&&", "||", ";", "|", ">", "<", "$(", "`"];
const BLOCKED_WRITE_TOKENS = [
  "sudo ",
  " rm",
  " mv",
  " cp",
  " chmod",
  " chown",
  " mkdir",
  " rmdir",
  " touch",
  " tee",
  "-delete",
  "git add",
  "git commit",
  "git push",
  "git pull",
  "git checkout",
  "git switch",
  "git reset",
  "git clean",
  "curl ",
  "wget ",
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

export function classifyCommand(command) {
  const normalized = String(command || "").trim();
  if (!normalized) return { category: "blocked", reason: "Command is empty." };

  if (ALWAYS_BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { category: "blocked", reason: "Command is blocked because it may expose secrets or publish packages." };
  }

  const lowered = ` ${normalized.toLowerCase()} `;
  if (BLOCKED_SHELL_TOKENS.some((part) => normalized.includes(part))) {
    return { category: "blocked", reason: `Command contains blocked shell syntax: ${normalized}` };
  }
  if (BLOCKED_WRITE_TOKENS.some((part) => lowered.includes(part))) {
    return { category: "blocked", reason: `Command contains a write-capable or network token: ${normalized}` };
  }

  if (matchAny(READ_ONLY_PATTERNS, normalized)) {
    return { category: "read-only", needsNetwork: false, writesWorkspace: false };
  }
  if (matchAny(TEST_PATTERNS, normalized)) {
    return { category: "test", needsNetwork: false, writesWorkspace: false };
  }
  if (matchAny(PACKAGE_INSTALL_PATTERNS, normalized)) {
    return { category: "package-install", needsNetwork: true, writesWorkspace: true };
  }
  if (matchAny(ENV_SETUP_PATTERNS, normalized)) {
    return { category: "env-setup", needsNetwork: false, writesWorkspace: true };
  }

  return { category: "blocked", reason: `Command is outside the execution allowlist: ${normalized}` };
}

export function evaluateCommandPolicy(command, config) {
  const classification = classifyCommand(command);
  const sandboxMode = normalizeSandboxMode(config.sandboxMode);
  const packageInstallPolicy = normalizePackageInstallPolicy(config.packageInstallPolicy);

  if (classification.category === "blocked") {
    return { allowed: false, ...classification, sandboxMode, packageInstallPolicy };
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

  if (classification.category === "package-install" || classification.category === "env-setup") {
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

    if (sandboxMode !== "docker-workspace") {
      return {
        allowed: false,
        category: classification.category,
        reason: "Approved package/environment setup must run in Docker workspace-write sandbox mode.",
        sandboxMode,
        packageInstallPolicy,
      };
    }
  }

  return {
    allowed: true,
    ...classification,
    sandboxMode,
    packageInstallPolicy,
  };
}
