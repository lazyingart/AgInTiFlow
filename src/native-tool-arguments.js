// Model-origin JSON must have one interpretation before schema repair or tool
// dispatch. JSON.parse alone silently replaces repeated object keys. The raw
// argument string stays unchanged on success; strings containing JSON/source
// text are data and are never recursively interpreted.
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NODES = 50_000;
const MAX_DEPTH = 32;

export class NativeToolArgumentsError extends Error {
  constructor(kind) {
    super("Native tool arguments must be bounded, unambiguous JSON.");
    this.name = "NativeToolArgumentsError";
    this.code = "TOOL_ARGUMENTS_INVALID_JSON";
    this.kind = kind;
  }
}

export function parseNativeToolArguments(source) {
  const reject = (kind = "invalid") => { throw new NativeToolArgumentsError(kind); };
  if (typeof source !== "string" || !source.isWellFormed() || Buffer.byteLength(source) > MAX_BYTES) reject();
  let value;
  try { value = JSON.parse(source); } catch { reject("syntax"); }
  let offset = 0, nodes = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[offset] || "x")) offset++; };
  function string() {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") offset++;
      else if (char === '"') {
        const decoded = JSON.parse(source.slice(start, offset));
        if (!decoded.isWellFormed()) reject();
        return decoded;
      }
    }
    reject();
  }
  function visit(depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) reject();
    whitespace();
    const type = source[offset];
    if (type === '"') { string(); return; }
    if (type !== "{" && type !== "[") {
      const start = offset;
      while (offset < source.length && !/[\x20\t\r\n,}\]]/.test(source[offset])) offset++;
      // JSON grammar permits numeric overflow, which is not a finite JSON data
      // value in the runtime. Never let it bypass a nested schema or be nulled.
      if (type !== "t" && type !== "f" && type !== "n" && !Number.isFinite(Number(source.slice(start, offset)))) reject();
      return;
    }
    offset++; whitespace();
    const closing = type === "{" ? "}" : "]", keys = new Set();
    if (source[offset] === closing) { offset++; return; }
    while (true) {
      if (type === "{") {
        const key = string();
        if (keys.has(key)) reject("ambiguous");
        keys.add(key); whitespace(); offset++; // JSON grammar already proves ':'
      }
      visit(depth + 1); whitespace();
      if (source[offset++] === closing) return;
      whitespace(); // JSON grammar already proves ',' and the next member
    }
  }
  visit(0); whitespace();
  if (offset !== source.length) reject();
  return value;
}
