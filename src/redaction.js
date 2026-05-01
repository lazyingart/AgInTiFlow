const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /((?:api[_-]?key|token|secret|password|passwd|npm_token|_authToken|grsai)\s*[:=]\s*)[^\s"'`]+/gi,
  /(\/\/registry\.npmjs\.org\/:_authToken=)[^\s"'`]+/gi,
  /(Authorization:\s*Bearer\s+)[^\s"'`]+/gi,
];

export function redactSensitiveText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      const captures = args.slice(1, -2).filter((item) => typeof item === "string");
      const prefix = captures[0] || "";
      return `${prefix}[REDACTED]`;
    });
  }
  return text;
}

export function redactValue(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}
