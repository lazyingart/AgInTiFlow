import path from "node:path";

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
  /^grep(?:\s+.+)?$/,
  /^cat(?:\s+[-\w./~*]+)+$/,
  /^head(?:\s+.+)?$/,
  /^tail(?:\s+.+)?$/,
  /^sort(?:\s+[-\w./~*]+)*$/,
  /^wc(?:\s+.+)?$/,
  /^file(?:\s+[-\w./~*]+)+$/,
  /^stat(?:\s+[-\w./~*]+)+$/,
  /^sha256sum(?:\s+[-\w./~*]+)+$/,
  /^sed\s+-n\s+['"0-9,:p\s-]+\s+[-\w./~*]+$/,
  /^git\s+(status|branch|log|show|diff(?:\s+--stat)?|remote\s+-v)(?:\s+.+)?$/,
  /^node\s+(?:-v|--version)$/,
  /^npm\s+(?:-v|--version)$/,
  /^python(?:3)?\s+--version$/,
  /^pip(?:3)?\s+--version$/,
  /^conda\s+--version$/,
  /^R\s+--version$/,
  /^Rscript\s+--version$/,
  /^(?:[-/\w.]+\/)?java\s+-version$/,
  /^(?:[-/\w.]+\/)?gradle\s+--version$/,
  /^(?:[-/\w.]+\/)?adb\s+devices(?:\s+-l)?$/,
  /^(?:[-/\w.]+\/)?emulator\s+-list-avds$/,
  /^(?:[-/\w.]+\/)?sdkmanager\s+--list(?:\s+[-\w./:=]+)*$/,
  /^(?:pdflatex|latexmk)\s+--version$/,
  /^test\s+-[efdx]\s+[-\w./~]+$/,
  /^true$/,
  /^false$/,
  /^echo(?:\s+.+)?$/,
];

function stripBenignRedirections(command = "") {
  return String(command || "")
    .replace(/\s+2>&1\b/g, "")
    .replace(/\s+1>&2\b/g, "")
    .replace(/\s+2>\/dev\/null\b/g, "")
    .replace(/\s+1>\/dev\/null\b/g, "")
    .replace(/\s+>\/dev\/null\b/g, "")
    .trim();
}

function isReadOnlyFindCommand(command = "") {
  const normalized = stripBenignRedirections(command);
  if (!/^find\s+/.test(normalized)) return false;
  if (/(^|\s)(-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprintf|-fls)\b/.test(normalized)) return false;
  const unquoted = stripQuotedSegments(normalized);
  if (/[|<>;&`$]/.test(unquoted)) return false;
  return /^find\s+(?:[-./~\w]+|\/workspace)(?:\s+[-\w]+(?:\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s|<>;&`$]+))?)*$/.test(normalized);
}

const TEST_PATTERNS = [
  /^npm\s+(run\s+)?(check|test|build|lint)(?:\s+--\s+[-\w./:=]+)*$/,
  /^npm\s+--prefix\s+[-\w./]+\s+(run\s+)?(check|test|build|lint)(?:\s+--\s+[-\w./:=]+)*$/,
  /^npm\s+test$/,
  /^node\s+--check\s+[-\w./]+$/,
  /^node\s+--test(?:\s+[-\w./]+)*$/,
  /^bash\s+-n\s+[-\w./]+\.sh$/,
  /^sh\s+-n\s+[-\w./]+\.sh$/,
  /^python(?:3)?\s+-m\s+py_compile\s+[-\w./]+\.py$/,
  /^python(?:3)?\s+-m\s+unittest(?:\s+[-\w./:=]+)*$/,
  /^python(?:3)?\s+-m\s+pytest(?:\s+[-\w./:=]+)*$/,
  /^pytest(?:\s+[-\w./:=]+)*$/,
];

const SAFE_WORKSPACE_WRITE_PATTERNS = [/^mkdir\s+-p\s+[-\w./]+$/];
const PERMISSION_CHANGE_PATTERNS = [/^(?:sudo\s+)?chmod\s+[-+=,rwxugoXst0-7]+\s+[-\w./]+$/];
const SAFE_ENV_ASSIGNMENT_NAMES = new Set(["ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME", "GRADLE_USER_HOME", "PATH"]);
const SAFE_ENV_VALUE_PATTERN = /^[-\w./:@+,%]+$/;

const NETWORK_FETCH_PATTERNS = [
  /^curl\b(?=[\s\S]*https?:\/\/\S+)[\s\S]*$/,
  /^wget\b(?=[\s\S]*https?:\/\/\S+)[\s\S]*$/,
];

const GIT_WORKFLOW_PATTERNS = [
  /^git\s+init(?:\s+(?:\.|[-\w./]+))?$/,
  /^git\s+config(?:\s+--local)?\s+user\.(?:name|email)\s+(['"])[^'"\n]{1,160}\1$/,
  /^git\s+config(?:\s+--local)?\s+init\.defaultBranch\s+(?:main|master|trunk|develop)$/,
  /^git\s+add(?:\s+[-\w./*]+)+$/,
  /^git\s+add\s+-A$/,
  /^git\s+commit\s+(?:(?:-a|--allow-empty)\s+)*-m\s+(['"])[^'"\n]{1,220}\1$/,
  /^git\s+branch\s+-M\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+branch\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+switch\s+(?:-c\s+)?[A-Za-z0-9][-\w./]*$/,
  /^git\s+checkout\s+-b\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+checkout\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+merge\s+--ff-only\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+merge\s+--no-ff\s+--no-edit\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+merge\s+--no-ff\s+[A-Za-z0-9][-\w./]*\s+--no-edit$/,
  /^git\s+merge\s+--no-edit\s+--no-ff\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+merge\s+[A-Za-z0-9][-\w./]*\s+--no-ff\s+--no-edit$/,
  /^git\s+merge\s+[A-Za-z0-9][-\w./]*\s+--no-edit\s+--no-ff$/,
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
  /^Rscript\s+[-\w./]+\.R(?:\s+[-\w./:=]+)*$/,
  /^(?:\.\/gradlew|[-\w./]+\/gradlew)\s+(?:-p\s+[-\w./]+\s+)?(?:(?::[-\w]+:)?(?:assembleDebug|assembleRelease|bundleDebug|bundleRelease|compileDebugKotlin|compileReleaseKotlin|testDebugUnitTest|lintDebug|lint|check|build))(?:\s+[-\w./:=]+)*$/,
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

function isHardBlockedClassification(classification = {}) {
  const reason = String(classification.reason || "");
  return /empty|secret|credential|token|publish/i.test(reason);
}

function matchAny(patterns, command) {
  return patterns.some((pattern) => pattern.test(command));
}

function stripQuotedSegments(command = "") {
  let output = "";
  let quote = "";
  let escaped = false;
  for (const char of String(command || "")) {
    if (escaped) {
      escaped = false;
      if (!quote) output += " ";
      continue;
    }
    if (char === "\\") {
      escaped = true;
      if (!quote) output += char;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      output += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

function isSafeRelativeDir(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("~")) return false;
  return normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

function isSafeVirtualWorkspaceDir(value) {
  const normalized = String(value || "").trim();
  if (normalized === "/workspace") return true;
  if (!normalized.startsWith("/workspace/")) return false;
  return isSafeRelativeDir(normalized.replace(/^\/workspace\//, ""));
}

function isSafeVirtualWorkspacePath(value) {
  const normalized = String(value || "").trim();
  return normalized.startsWith("/workspace/") && isSafeRelativeDir(normalized.replace(/^\/workspace\//, ""));
}

function isSafeWorkspacePath(value) {
  return isSafeRelativeDir(value) || isSafeVirtualWorkspacePath(value);
}

function isInsideDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativizeWorkspaceAbsolutePaths(command = "", root = "") {
  if (!root) return String(command || "");
  const workspaceRoot = path.resolve(root);
  return String(command || "").replace(/(?<!:)\/[^\s'"|;&<>]+/g, (candidate) => {
    if (candidate.startsWith("//")) return candidate;
    const resolved = path.resolve(candidate);
    if (!isInsideDirectory(workspaceRoot, resolved)) return candidate;
    return path.relative(workspaceRoot, resolved) || ".";
  });
}

function isSafeEnvAssignment(name = "", value = "") {
  if (!SAFE_ENV_ASSIGNMENT_NAMES.has(String(name || ""))) return false;
  if (!value || !SAFE_ENV_VALUE_PATTERN.test(String(value || ""))) return false;
  if (/(?:api[_-]?key|auth[_-]?token|secret|password|_authToken|bearer)/i.test(`${name}=${value}`)) return false;
  return true;
}

function classifySafeEnvExport(normalized = "") {
  const match = normalized.match(/^export\s+([A-Z_][A-Z0-9_]*)=([^\s;&|<>`$]+)$/);
  if (!match) return null;
  const [, name, value] = match;
  if (!isSafeEnvAssignment(name, value)) return null;
  return {
    category: "read-only",
    needsNetwork: false,
    writesWorkspace: false,
    reason: `Safe local toolchain environment assignment: ${name}`,
  };
}

function stripSafeInlineEnvAssignments(command = "") {
  let remaining = String(command || "").trim();
  let stripped = false;
  for (let guard = 0; guard < 8; guard += 1) {
    const match = remaining.match(/^([A-Z_][A-Z0-9_]*)=([^\s;&|<>`$]+)\s+(.+)$/);
    if (!match) break;
    const [, name, value, rest] = match;
    if (!isSafeEnvAssignment(name, value)) break;
    remaining = rest.trim();
    stripped = true;
  }
  return stripped ? remaining : command;
}

function classifySafeEchoRedirect(normalized = "") {
  const match = normalized.match(/^echo\s+(?:"[^"\n]*"|'[^'\n]*'|[-\w.:/]+)\s+>>?\s+([-\w./]+|\/workspace\/[-\w./]+)$/);
  if (!match) return null;
  const target = match[1] || "";
  if (!isSafeWorkspacePath(target)) return null;
  return {
    category: "workspace-write",
    needsNetwork: false,
    writesWorkspace: true,
    virtualWorkspacePath: isSafeVirtualWorkspacePath(target),
    reason: `Command writes a small workspace status log: ${target}`,
  };
}

function classifyGitCleanDryRun(normalized) {
  const match = normalized.match(/^git\s+clean\b([\s\S]*)$/);
  if (!match) return null;
  const args = match[1] || "";
  if (!/(^|\s)(?:-n\b|--dry-run\b|-[A-Za-z]*n[A-Za-z]*\b)/.test(args)) return null;
  if (/(^|\s)(?:-f\b|--force\b|-[A-Za-z]*f[A-Za-z]*\b)/.test(args)) return null;
  return {
    category: "read-only",
    needsNetwork: false,
    writesWorkspace: false,
    reason: "Git clean dry-run is read-only inspection evidence.",
  };
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

function classifyGitWorkflow(normalized) {
  if (!matchAny(GIT_WORKFLOW_PATTERNS, normalized)) return null;
  const remote = /^git\s+(fetch|pull|push)\b/.test(normalized);
  const writesWorkspace = !/^git\s+fetch\b/.test(normalized);
  return {
    category: remote ? "git-remote" : "git-workflow",
    needsNetwork: remote,
    writesWorkspace,
    reason:
      remote
        ? "Git remote workflow command. Agent should inspect status/diff first and stop on divergence or conflicts."
        : "Local git workflow command. Agent should inspect status/diff first and stop on conflicts or unrelated dirty work.",
  };
}

function classifySimpleCommand(normalized) {
  const benignRedirectCommand = stripBenignRedirections(normalized);
  if (ALWAYS_BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { category: "blocked", reason: "Command is blocked because it may expose secrets or publish packages." };
  }
  if (SENSITIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { category: "blocked", reason: "Command is blocked because it references secrets or credential files." };
  }
  const gitCleanDryRun = classifyGitCleanDryRun(normalized);
  if (gitCleanDryRun) return gitCleanDryRun;
  const gitWorkflowClassification = classifyGitWorkflow(normalized);
  if (gitWorkflowClassification) return gitWorkflowClassification;
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
    const target = normalized.split(/\s+/).at(-1) || "";
    const virtualWorkspacePath = isSafeVirtualWorkspacePath(target);
    if (!isSafeWorkspacePath(target)) {
      return { category: "blocked", reason: `chmod target must be a safe workspace-relative path: ${target}` };
    }
    return {
      category: "permission-change",
      needsNetwork: false,
      writesWorkspace: true,
      virtualWorkspacePath,
      reason: `Command changes workspace file mode: ${normalized}`,
    };
  }
  const gitCloneClassification = classifyGitClone(normalized);
  if (gitCloneClassification) return gitCloneClassification;
  const envExportClassification = classifySafeEnvExport(normalized);
  if (envExportClassification) return envExportClassification;
  const echoRedirectClassification = classifySafeEchoRedirect(normalized);
  if (echoRedirectClassification) return echoRedirectClassification;

  const commandForPatternMatching = stripSafeInlineEnvAssignments(benignRedirectCommand);
  const unquoted = stripQuotedSegments(commandForPatternMatching);
  const lowered = ` ${unquoted.toLowerCase()} `;
  if (BLOCKED_WRITE_TOKENS.some((part) => lowered.includes(part))) {
    return {
      category: "destructive",
      needsNetwork: false,
      writesWorkspace: true,
      reason: `Command contains a write-capable or destructive token: ${normalized}`,
    };
  }
  if (BLOCKED_SHELL_TOKENS.some((part) => unquoted.includes(part))) {
    return {
      category: "general-shell",
      needsNetwork: true,
      writesWorkspace: true,
      reason: `Command uses general shell syntax: ${normalized}`,
    };
  }

  if (matchAny(READ_ONLY_PATTERNS, commandForPatternMatching) || isReadOnlyFindCommand(normalized)) {
    return { category: "read-only", needsNetwork: false, writesWorkspace: false };
  }
  if (matchAny(TEST_PATTERNS, commandForPatternMatching)) {
    return { category: "test", needsNetwork: false, writesWorkspace: false };
  }
  if (matchAny(TOOLCHAIN_PATTERNS, commandForPatternMatching)) {
    return { category: "toolchain", needsNetwork: false, writesWorkspace: true };
  }
  if (matchAny(NETWORK_FETCH_PATTERNS, commandForPatternMatching)) {
    return { category: "network-fetch", needsNetwork: true, writesWorkspace: /(\s-o\s|\s-O\s)/.test(commandForPatternMatching) };
  }
  if (matchAny(SYSTEM_PACKAGE_INSTALL_PATTERNS, commandForPatternMatching)) {
    return { category: "system-package-install", needsNetwork: true, writesWorkspace: false, requiresDockerRoot: true };
  }
  if (matchAny(PACKAGE_INSTALL_PATTERNS, commandForPatternMatching)) {
    return { category: "package-install", needsNetwork: true, writesWorkspace: true };
  }
  if (matchAny(ENV_SETUP_PATTERNS, commandForPatternMatching)) {
    return { category: "env-setup", needsNetwork: false, writesWorkspace: true };
  }

  return {
    category: "general-shell",
    needsNetwork: false,
    writesWorkspace: false,
    reason: `Command is outside the narrow allowlist and requires a trusted shell policy: ${normalized}`,
  };
}

function splitTopLevelShellSequence(command = "") {
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let hadSeparator = false;
  const text = String(command || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === ";" || (char === "&" && text[index + 1] === "&") || (char === "|" && text[index + 1] === "|")) {
      const part = current.trim();
      if (!part) return null;
      parts.push(part);
      current = "";
      hadSeparator = true;
      if (char === "&" || char === "|") index += 1;
      continue;
    }
    current += char;
  }
  const finalPart = current.trim();
  if (finalPart) parts.push(finalPart);
  if (!hadSeparator || parts.length < 2) return null;
  return parts;
}

function classifyShellSequence(normalized) {
  const parts = splitTopLevelShellSequence(normalized);
  if (!parts) return null;
  const classifications = parts.map((part) => classifyCdCommand(part) || classifyPipelineSequence(part) || classifySimpleCommand(part));
  const blocked = classifications.find((classification) => classification.category === "blocked" || classification.category === "destructive");
  if (blocked) return blocked;
  const broad = classifications.find((classification) => classification.category === "general-shell");
  if (broad) {
    return {
      ...broad,
      reason: `Command sequence includes a broad shell segment and requires trusted shell policy: ${normalized}`,
    };
  }
  const categories = new Set(classifications.map((classification) => classification.category));
  const aggregate = {
    needsNetwork: classifications.some((classification) => classification.needsNetwork),
    writesWorkspace: classifications.some((classification) => classification.writesWorkspace),
    requiresDockerRoot: classifications.some((classification) => classification.requiresDockerRoot),
    virtualWorkspacePath: classifications.some((classification) => classification.virtualWorkspacePath),
    reason: `Command sequence uses shell separators with individually classified safe segments: ${normalized}`,
  };
  if (categories.has("system-package-install")) return { category: "system-package-install", ...aggregate };
  if (categories.has("package-install")) return { category: "package-install", ...aggregate };
  if (categories.has("env-setup")) return { category: "env-setup", ...aggregate };
  if (categories.has("permission-change")) return { category: "permission-change", ...aggregate };
  if (categories.has("git-remote")) return { category: "git-remote", ...aggregate };
  if (categories.has("network-fetch")) return { category: "network-fetch", ...aggregate };
  if (categories.has("toolchain")) return { category: "toolchain", ...aggregate };
  if (categories.has("workspace-write")) return { category: "workspace-write", ...aggregate };
  if (categories.has("test")) return { category: "test", ...aggregate };
  if (categories.has("git-workflow")) return { category: "git-workflow", ...aggregate };
  return {
    category: "read-only",
    ...aggregate,
  };
}

function splitTopLevelPipeline(command = "") {
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let hadPipe = false;
  const text = String(command || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === "|" && text[index + 1] !== "|") {
      const part = current.trim();
      if (!part) return null;
      parts.push(part);
      current = "";
      hadPipe = true;
      continue;
    }
    current += char;
  }
  const finalPart = current.trim();
  if (finalPart) parts.push(finalPart);
  if (!hadPipe || parts.length < 2) return null;
  return parts;
}

function classifyPipelineSequence(normalized) {
  const parts = splitTopLevelPipeline(normalized);
  if (!parts) return null;
  const classifications = parts.map((part) => classifyCdCommand(part) || classifySimpleCommand(part));
  const blocked = classifications.find((classification) => classification.category === "blocked" || classification.category === "destructive");
  if (blocked) return blocked;
  if (classifications.every((classification) => classification.category === "read-only")) {
    return {
      category: "read-only",
      needsNetwork: false,
      writesWorkspace: false,
      reason: `Read-only shell pipeline: ${normalized}`,
    };
  }
  return {
    category: "general-shell",
    needsNetwork: classifications.some((classification) => classification.needsNetwork),
    writesWorkspace: classifications.some((classification) => classification.writesWorkspace),
    reason: `Shell pipeline includes a broad segment and requires trusted shell policy: ${normalized}`,
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
  const innerClassification = classifyShellSequence(inner.trim()) || classifyPipelineSequence(inner.trim()) || classifySimpleCommand(inner.trim());
  if (innerClassification.category === "blocked") return innerClassification;
  return { ...innerClassification, cdDir: dir, virtualWorkspacePath };
}

export function classifyCommand(command) {
  const normalized = String(command || "").trim();
  if (!normalized) return { category: "blocked", reason: "Command is empty." };

  return classifyCdCommand(normalized) || classifyShellSequence(normalized) || classifyPipelineSequence(normalized) || classifySimpleCommand(normalized);
}

export function evaluateCommandPolicy(command, config = {}) {
  const normalizedForPolicy = relativizeWorkspaceAbsolutePaths(command, config.commandCwd);
  const classification = classifyCommand(normalizedForPolicy);
  const normalizedCommand = String(command || "").trim();
  const sandboxMode = normalizeSandboxMode(config.sandboxMode);
  const packageInstallPolicy = normalizePackageInstallPolicy(config.packageInstallPolicy);
  const dockerWorkspace = sandboxMode === "docker-workspace";
  const packageInstallsAllowed = packageInstallPolicy === "allow";
  const trustedDockerShell = dockerWorkspace && packageInstallsAllowed;
  const trustedHostShell = sandboxMode === "host" && Boolean(config.allowDestructive);
  const trustedDangerHost = sandboxMode === "host" && Boolean(config.allowDestructive) && Boolean(config.allowPasswords);

  if (classification.category === "blocked") {
    if (trustedDangerHost && !isHardBlockedClassification(classification)) {
      return {
        allowed: true,
        ...classification,
        category: "general-shell",
        trustedDangerOverride: true,
        reason: `Trusted danger host mode allows this broad host command: ${classification.reason}`,
        sandboxMode,
        packageInstallPolicy,
      };
    }
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

  if (sandboxMode === "host" && /^sudo\b/.test(normalizedCommand) && !trustedDangerHost) {
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

  if (classification.category === "system-package-install" && sandboxMode === "host" && !trustedDangerHost) {
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

  if (classification.category === "permission-change" && sandboxMode !== "host" && !trustedDockerShell && !trustedHostShell) {
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
