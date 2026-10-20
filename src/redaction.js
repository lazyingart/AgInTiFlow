const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /(\/\/registry\.npmjs\.org\/:_authToken=)[^\s"'`]+/gi,
  /(Authorization:\s*Bearer\s+)[^\s"'`]+/gi,
];

const SECRET_ASSIGNMENT_PATTERN = /(\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apiKey|auth[_-]?token|authToken|token|secret|password|passwd|npm[_-]?token|npmToken|_authToken|grsai|venice[_-]?api[_-]?key|veniceApiKey|openrouter[_-]?api[_-]?key)[^\S\r\n]*([:=])[^\S\r\n]*)([^\s\\"'`,;|(){}]+)/gi;
const SAFE_ASSIGNMENT_VALUE_PATTERN = /^(?:false|true|null|none|unset|missing|not[-_ ]?set|\[REDACTED\]|\*{3,})$/i;
const SOURCE_TYPE_ANNOTATION_PATTERN = /^(?:str|string|bytes|bytearray|int|float|complex|bool|dict|list|tuple|set|frozenset|object|any|unknown|never|void|path|(?:typing\.)?(?:Any|Optional|Union|Literal|Annotated|Sequence|Mapping|MutableMapping|Callable|Type|ClassVar|Final|List|Dict|Tuple|Set|FrozenSet)\[[^\r\n]{1,120}\])$/i;
const SOURCE_CALL_HEAD_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

function redactSecretAssignments(value) {
  return String(value ?? "").replace(
    SECRET_ASSIGNMENT_PATTERN,
    (match, prefix, separator, assignedValue, offset, source) => {
      if (SAFE_ASSIGNMENT_VALUE_PATTERN.test(assignedValue)) return match;
      if (separator === ":" && SOURCE_TYPE_ANNOTATION_PATTERN.test(assignedValue)) return match;
      if (
        SOURCE_CALL_HEAD_PATTERN.test(assignedValue) &&
        String(source || "").slice(Number(offset || 0) + match.length).startsWith("(")
      ) {
        return match;
      }
      return `${prefix}[REDACTED]`;
    }
  );
}

export function redactSensitiveText(value) {
  let text = redactSecretAssignments(value);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      const captures = args.slice(1, -2).filter((item) => typeof item === "string");
      const prefix = captures[0] || "";
      return `${prefix}[REDACTED]`;
    });
  }
  return text;
}

export function hasSensitiveText(value) {
  const text = String(value ?? "");
  return redactSensitiveText(text) !== text;
}

export function redactValue(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}
