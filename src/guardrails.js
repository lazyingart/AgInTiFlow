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

const SAFE_COMMAND_PATTERNS = [
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
  /^git\s+(status|branch|log|diff(?:\s+--stat)?|remote\s+-v)$/,
  /^node\s+-v$/,
  /^npm\s+-v$/,
  /^python(?:3)?\s+--version$/,
  /^echo(?:\s+.+)?$/,
];

const DISALLOWED_COMMAND_PARTS = [
  "&&",
  "||",
  ";",
  "|",
  ">",
  "<",
  "$(",
  "`",
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
    if (!config.allowShellTool) {
      return { allowed: false, reason: "Shell tool is disabled for this run." };
    }

    const command = String(args.command || "").trim();
    const lowered = ` ${command.toLowerCase()} `;

    if (DISALLOWED_COMMAND_PARTS.some((part) => lowered.includes(part))) {
      return {
        allowed: false,
        reason: `Command contains blocked shell syntax or a write-capable token: ${command}`,
      };
    }

    const allowed = SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
    if (!allowed) {
      return {
        allowed: false,
        reason: `Command is outside the read-only allowlist: ${command}`,
      };
    }

    return { allowed: true };
  }

  return { allowed: true };
}
