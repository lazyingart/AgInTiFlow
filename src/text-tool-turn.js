import { parseNativeToolArguments } from "./native-tool-arguments.js";

// A textual transport must preserve the same original-JSON ambiguity boundary
// as native function arguments. Parse one whole grammar, never merge successful
// fragments from competing parsers or discard an invalid member of a batch.
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_CALLS = 16;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const malformed = () => { throw new Error("Malformed text tool turn"); };
const whitespace = (text, offset) => {
  while (offset < text.length && /\s/u.test(text[offset])) offset++;
  return offset;
};
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

function firstUnfencedMatch(text, pattern) {
  const search = new RegExp(pattern.source, pattern.flags + "g");
  let fence = text.indexOf("```"), inside = false, match;
  while ((match = search.exec(text))) {
    while (fence >= 0 && fence < match.index) {
      inside = !inside; fence = text.indexOf("```", fence + 3);
    }
    if (!inside) return match;
    if (fence < 0) return null;
    search.lastIndex = fence + 3;
    inside = false; fence = text.indexOf("```", fence + 3);
  }
  return null;
}

export function findTextToolProtocol(text) {
  if (typeof text !== "string" || !text.isWellFormed()) return { kind: "invalid", index: 0 };
  const scan = text.slice(0, MAX_BYTES + 256);
  const candidates = [
    ["dsml", /<\/?[|｜]{2}DSML[|｜]{2}/iu],
    ["bracket", /\[TOOL_CALLS\b/u],
    ["block", /\bTOOL_CALLS\s*:/iu],
    ["requested", /\bRequested tools?\s*:/iu],
    ["xml", /<tool_calls?\b/iu],
    ["function", /<function\s*=/iu],
    ["standalone", /^\s*\{\s*"toolName"\s*:/mu],
  ].flatMap(([kind, pattern]) => {
    const match = firstUnfencedMatch(scan, pattern);
    return match ? [{ kind, index: match.index }] : [];
  }).sort((a, b) => a.index - b.index);
  if (!candidates.length) return null;
  const first = candidates[0];
  if (Buffer.byteLength(text) > MAX_BYTES) return { kind: "invalid", index: first.index };
  return first;
}

function jsonAt(text, start, xmlEncoded = false) {
  const begin = whitespace(text, start), stack = [];
  if (!["{", "["].includes(text[begin])) malformed();
  let quoted = false, escaped = false;
  for (let index = begin; index < text.length; index++) {
    let char = text[index];
    if (xmlEncoded && char === "&") {
      const entity = /^&(quot|apos|lt|gt|amp);/u.exec(text.slice(index, index + 6));
      if (entity) {
        char = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" }[entity[1]];
        index += entity[0].length - 1;
      }
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      stack.push(char);
      if (stack.length > 33) malformed();
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) malformed();
      if (!stack.length) {
        const raw = xmlEncoded ? decode(text.slice(begin, index + 1)) : text.slice(begin, index + 1);
        return { raw, value: parseNativeToolArguments(raw), end: index + 1 };
      }
    }
  }
  malformed();
}

function exactKeys(value, allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) malformed();
}

function append(calls, name, args, id, raw) {
  if (typeof name !== "string" || !NAME.test(name) || !plain(args) || calls.length >= MAX_CALLS) malformed();
  const callId = id === undefined ? `text-tool-${calls.length + 1}` : id;
  if (typeof callId !== "string" || !ID.test(callId) || calls.some(call => call.id === callId)) malformed();
  calls.push({ id: callId, type: "function", function: { name, arguments: raw ?? JSON.stringify(args) } });
}

function requested(text) {
  const marker = /^Requested tools?\s*:/iu.exec(text);
  if (!marker) malformed();
  const calls = []; let offset = whitespace(text, marker[0].length);
  while (offset < text.length) {
    const header = /^([A-Za-z0-9_-]{1,128})\s*\(/u.exec(text.slice(offset));
    if (!header) malformed();
    const begin = whitespace(text, offset + header[0].length);
    const data = text[begin] === ")" ? { raw: "{}", value: {}, end: begin } : jsonAt(text, begin);
    offset = whitespace(text, data.end);
    if (text[offset++] !== ")") malformed();
    append(calls, header[1], data.value, undefined, data.raw);
    const beforeSpace = offset; offset = whitespace(text, offset);
    if (offset === text.length) break;
    if (text[offset] === ";" || text[offset] === ",") {
      const terminator = text[offset];
      offset = whitespace(text, offset + 1);
      if (offset === text.length) { if (terminator === ";") break; malformed(); }
    } else if (beforeSpace === offset) malformed();
  }
  if (!calls.length) malformed();
  return calls;
}

function bracket(text) {
  const calls = []; let offset = 0;
  while (offset < text.length) {
    const header = /^\[TOOL_CALLS\]([A-Za-z0-9_-]{1,128})\[ARGS\]/u.exec(text.slice(offset));
    if (!header) malformed();
    offset = whitespace(text, offset + header[0].length);
    let id;
    if (text[offset] !== "{") {
      const withId = /^([A-Za-z0-9_-]{1,128})\[ARGS\]/u.exec(text.slice(offset));
      if (!withId) malformed();
      id = withId[1]; offset = whitespace(text, offset + withId[0].length);
    }
    const data = jsonAt(text, offset);
    append(calls, header[1], data.value, id, data.raw);
    offset = whitespace(text, data.end);
  }
  if (!calls.length) malformed();
  return calls;
}

function block(text) {
  const header = /^TOOL_CALLS\s*:\s*```(?:json)?\s*/iu.exec(text);
  if (!header) malformed();
  const data = jsonAt(text, header[0].length);
  if (!Array.isArray(data.value) || !data.value.length || data.value.length > MAX_CALLS || !/^\s*```\s*$/u.test(text.slice(data.end))) malformed();
  const calls = [];
  for (const item of data.value) {
    exactKeys(item, ["name", "tool", "arguments", "id"]);
    if (Object.hasOwn(item, "name") === Object.hasOwn(item, "tool")) malformed();
    append(calls, item.name ?? item.tool, Object.hasOwn(item, "arguments") ? item.arguments : {}, item.id);
  }
  return calls;
}

function standalone(text) {
  const calls = [], seen = new Set(); let reported = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (++reported > MAX_CALLS) malformed();
    if (!/^\s*\{\s*"toolName"\s*:/u.test(line)) malformed();
    const item = parseNativeToolArguments(line);
    exactKeys(item, ["toolName", "args", "id"]);
    if (!Object.hasOwn(item, "args")) malformed();
    const signature = JSON.stringify([item.toolName, item.args]);
    // Preserve the established repeated-line presentation dialect, but only
    // after every original line passes strict JSON and exact envelope checks.
    if (seen.has(signature)) {
      if (item.id !== undefined) malformed();
      continue;
    }
    seen.add(signature); append(calls, item.toolName, item.args, item.id);
  }
  if (!calls.length) malformed();
  return calls;
}

function decode(value) {
  return value.trim().replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function xml(text) {
  const outer = /^<tool_calls>/iu.exec(text);
  if (!outer) malformed();
  const calls = []; let offset = whitespace(text, outer[0].length);
  while (!/^<\/tool_calls>/iu.test(text.slice(offset))) {
    const header = /^<tool_call\s+name\s*=\s*(?:"([A-Za-z0-9_-]{1,128})"|'([A-Za-z0-9_-]{1,128})')\s*>/iu.exec(text.slice(offset));
    if (!header) malformed();
    const start = whitespace(text, offset + header[0].length);
    const data = /^<\/tool_call>/iu.test(text.slice(start)) ? { raw: "{}", value: {}, end: start } : jsonAt(text, start, true);
    offset = whitespace(text, data.end);
    const close = /^<\/tool_call>/iu.exec(text.slice(offset));
    if (!close) malformed();
    append(calls, header[1] ?? header[2], data.value, undefined, data.raw);
    offset = whitespace(text, offset + close[0].length);
  }
  if (!calls.length || !/^<\/tool_calls>\s*$/iu.test(text.slice(offset))) malformed();
  return calls;
}

function parameterValue(raw) {
  const value = decode(raw);
  if (/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u.test(value) || /^[\[{]/u.test(value)) {
    try { return parseNativeToolArguments(value); }
    catch (error) { if (error.kind !== "syntax") throw error; }
  }
  return value;
}

function functions(text) {
  const calls = []; let offset = 0;
  while (offset < text.length) {
    const header = /^<function\s*=\s*(?:"([A-Za-z0-9_-]{1,128})"|'([A-Za-z0-9_-]{1,128})'|([A-Za-z0-9_-]{1,128}))\s*>/iu.exec(text.slice(offset));
    if (!header) malformed();
    offset = whitespace(text, offset + header[0].length);
    const args = Object.create(null); let count = 0;
    while (!/^<\/function\s*>/iu.test(text.slice(offset))) {
      const parameter = /^<parameter\s*=\s*(?:"([A-Za-z0-9_-]{1,128})"|'([A-Za-z0-9_-]{1,128})'|([A-Za-z0-9_-]{1,128}))\s*>/iu.exec(text.slice(offset));
      if (!parameter || ++count > 64) malformed();
      const name = parameter[1] ?? parameter[2] ?? parameter[3];
      if (!NAME.test(name) || Object.hasOwn(args, name)) malformed();
      const start = offset + parameter[0].length, closing = /<\/parameter\s*>/giu;
      closing.lastIndex = start; const end = closing.exec(text);
      if (!end) malformed();
      args[name] = parameterValue(text.slice(start, end.index));
      offset = whitespace(text, closing.lastIndex);
    }
    const closing = /^<\/function\s*>/iu.exec(text.slice(offset));
    if (!closing) malformed();
    append(calls, header[1] ?? header[2] ?? header[3], args);
    offset = whitespace(text, offset + closing[0].length);
    const toleratedClose = /^<\/tool_call>/iu.exec(text.slice(offset));
    if (toleratedClose) offset = whitespace(text, offset + toleratedClose[0].length);
  }
  if (!calls.length) malformed();
  return calls;
}

export function parseLegacyTextToolTurn(text, start = findTextToolProtocol(text)) {
  if (!start) return { recognized: false, calls: [], prefix: "" };
  try {
    if (typeof text !== "string" || !text.isWellFormed() || Buffer.byteLength(text) > MAX_BYTES) malformed();
    const parser = { requested, bracket, block, standalone, xml, function: functions }[start.kind];
    if (!parser) malformed();
    const calls = parser(text.slice(start.index).trimEnd());
    return { recognized: true, calls, prefix: text.slice(0, start.index).trim() };
  } catch {
    return { recognized: true, calls: [], prefix: "" };
  }
}
