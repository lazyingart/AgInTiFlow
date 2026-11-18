import { redactSensitiveText } from "./redaction.js";

// Identify only the slash of a paired end tag. Attribute values, element
// content and every other path candidate still go through ordinary redaction.
// These offsets describe literal text, never a DOM or an executable format.
const NAME = "[A-Za-z_][A-Za-z0-9_.:-]{0,127}";
const OPEN_ELEMENT = new RegExp(
  `^<(${NAME})(?:\\s+${NAME}\\s*=\\s*(?:"[^"<>]*"|'[^'<>]*'))*\\s*(/?)>$`, "u"
);
const CLOSE_ELEMENT = new RegExp(`^</(${NAME})>$`, "u");

function collectEndTags(text, start, offsets, jsonString) {
  // Declarations, comments and embedded active content need a format-aware
  // consumer. Leave those fragments on the existing strict redaction path.
  if (/<!|<\/?(?:script|style|iframe|object|embed|template|svg)(?=[\s/>])/iu.test(text)) return;
  const names = [];
  for (const token of text.matchAll(/<[^<>]*>/gu)) {
    const literal = token[0];
    if (literal.startsWith("</")) {
      const close = CLOSE_ELEMENT.exec(literal);
      if (close && names.at(-1) === close[1]) {
        names.pop();
        offsets.add(start + token.index);
      } else {
        names.length = 0;
      }
    } else {
      const open = OPEN_ELEMENT.exec(jsonString ? literal.replaceAll('\\"', '"') : literal);
      if (open && !open[2]) names.push(open[1]);
      else if (!open) names.length = 0;
    }
  }
}

function isJsonContainer(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function pairedEndTags(text) {
  const offsets = new Set();

  if (/^\s*(?:\{|\[)/u.test(text) && isJsonContainer(text)) {
    // Public JSON inference is serialized before redaction. One key/value
    // must never supply an opening tag for another value's path candidate.
    for (const item of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/gu)) {
      collectEndTags(item[0], item.index, offsets, true);
    }
  } else {
    collectEndTags(text, 0, offsets, false);
  }
  return offsets;
}

export function redactIntegrationTextPaths(value, pathPattern, { conversation = false } = {}) {
  const text = redactSensitiveText(value);
  const endTags = conversation && text.includes("</") ? pairedEndTags(text) : null;
  return text.replace(pathPattern, (match, offset) => {
    if (endTags?.has(offset) && text[offset + match.length] === ">") return match;
    const prefix = /^[\s("'`<>\[{=]/u.test(match) ? match[0] : "";
    return `${prefix}[REDACTED_PATH]`;
  });
}
