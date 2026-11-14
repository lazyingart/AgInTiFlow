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
const QUOTED_SECRET_FIELD_NAME = String.raw`(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apiKey|auth[_-]?token|authToken|token|secret|password|passwd|npm[_-]?token|npmToken|_authToken|grsai|venice[_-]?api[_-]?key|veniceApiKey|openrouter[_-]?api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)`;
const QUOTED_SECRET_FIELD = new RegExp(`^(?:${QUOTED_SECRET_FIELD_NAME})$`, "i");
// Inspect literal assignments without executing source. Quoted JSON keys may
// use escapes; quoted values may also be truncated at an input/log boundary.
const QUOTED_SECRET_ASSIGNMENT = new RegExp(String.raw`(("(?:\\[^\r\n]|[^"\\\r\n]){1,256}"|'(?:\\[^\r\n]|[^'\\\r\n]){1,256}'|(?<!["'\\])\b${QUOTED_SECRET_FIELD_NAME})([^\S\r\n]*[:=][^\S\r\n]*))(["'])((?:\\[^\r\n]|(?!\4)[^\\\r\n])*)(\4|(?=$|[\r\n]))`, "gi");

function safeSecretLiteral(key, value) {
  return value === "" || SAFE_ASSIGNMENT_VALUE_PATTERN.test(value) ||
    (/^authorization$/i.test(key) && /^Bearer[ \t]*$/i.test(value));
}

function redactQuotedSecretAssignments(text) {
  return text.replace(QUOTED_SECRET_ASSIGNMENT, (match, prefix, rawKey, _separator, quote, rawValue, closing) => {
    let key = rawKey, value = rawValue;
    if (rawKey.startsWith('"')) {
      try { key = JSON.parse(rawKey); } catch { return match; }
    } else if (rawKey.startsWith("'")) key = rawKey.slice(1, -1);
    if (!QUOTED_SECRET_FIELD.test(key)) return match;
    if (quote === '"' && closing) {
      try { value = JSON.parse(quote + rawValue + closing); } catch { /* Mask malformed literal data too. */ }
    }
    if (safeSecretLiteral(key, value)) return match;
    return `${prefix}${quote}[REDACTED]${closing}`;
  });
}

function redactSecretAssignments(value) {
  return redactQuotedSecretAssignments(String(value ?? "")).replace(
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

const JSON_STRING_LITERAL = /"(?:\\[^\r\n]|[^"\\\r\n])*"/g;

function redactText(value, depth) {
  let text = redactSecretAssignments(value);
  // Native arguments and persisted context can serialize another JSON/source
  // string. Decode literal strings only, never execute hooks or source code.
  text = text.replace(JSON_STRING_LITERAL, (literal) => {
    if (!/[\\:=]/.test(literal)) return literal;
    let decoded;
    try { decoded = JSON.parse(literal); } catch { return literal; }
    const redacted = depth < 32 ? redactText(decoded, depth + 1) : "[REDACTED]";
    return redacted === decoded ? literal : JSON.stringify(redacted);
  });
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      const captures = args.slice(1, -2).filter((item) => typeof item === "string");
      const prefix = captures[0] || "";
      return `${prefix}[REDACTED]`;
    });
  }
  return text;
}

export function redactSensitiveText(value) {
  return redactText(value, 0);
}

export function hasSensitiveText(value) {
  const text = String(value ?? "");
  return redactSensitiveText(text) !== text;
}

export function redactValue(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      typeof item === "string" && QUOTED_SECRET_FIELD.test(key) && !safeSecretLiteral(key, item)
        ? "[REDACTED]" : redactValue(item),
    ]));
  }
  return value;
}
