import { hasActiveShellExpansion, parseTopLevelShellSequence, tokenizeShellWords } from "./shell-syntax.js";

// A closed, loop-free AWK inspection language, not a claim that arbitrary AWK
// is read-only. No program rewriting, file APIs, subprocesses or dynamic formats.
// These are syntax classifiers; callers retain credential/path and shell gates.
const SPECIAL = new Set(["NR", "FNR", "NF"]);
const RESERVED = new Set([
  "BEGIN", "END", "BEGINFILE", "ENDFILE", "ARGC", "ARGV", "ARGIND", "ENVIRON", "FILENAME",
  "FS", "RS", "OFS", "ORS", "SUBSEP", "CONVFMT", "OFMT", "PROCINFO", "FUNCTAB", "SYMTAB",
  "ERRNO", "FIELDWIDTHS", "FPAT", "RT", "TEXTDOMAIN", "PREC", "ROUNDMODE", "IGNORECASE", "BINMODE", "LINT",
  "if", "else", "for", "while", "do", "switch", "case", "function", "return", "next", "nextfile", "exit",
  "delete", "in", "getline", "system", "close", "fflush", "print", "printf", "sprintf",
]);
const PRECEDENCE = new Map([["||", 1], ["&&", 2], ["==", 3], ["!=", 3], ["<", 3], [">", 3], ["<=", 3], [">=", 3], ["+", 4], ["-", 4], ["*", 5], ["/", 5], ["%", 5], ["^", 6]]);
const ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "%=", "^="]);

function invalid() { throw new Error("Unsupported AWK inspection language"); }

function lex(program) {
  const tokens = [];
  for (let index = 0; index < program.length;) {
    const char = program[index];
    if (char === " " || char === "\t") { index++; continue; }
    if (char === "\n") { tokens.push({ kind: ";", value: ";" }); index++; if (tokens.length > 512) invalid(); continue; }
    if (char === '"') {
      let value = "", closed = false; index++;
      while (index < program.length) {
        const next = program[index++];
        if (next === '"') { closed = true; break; }
        if (next === "\\") {
          const escape = program[index++], escapes = { '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t" };
          if (!Object.hasOwn(escapes, escape)) invalid();
          value += escapes[escape];
        } else {
          if (next < " " || next === "\u007f") invalid();
          value += next;
        }
        if (Buffer.byteLength(value) > 512) invalid();
      }
      if (!closed) invalid();
      tokens.push({ kind: "string", value });
    } else if (char === "$") {
      const match = /^\$(0|[1-9][0-9]{0,2})(?![0-9])/.exec(program.slice(index));
      if (!match || Number(match[1]) > 256) invalid();
      tokens.push({ kind: "field", value: match[0] }); index += match[0].length;
    } else {
      const rest = program.slice(index);
      const number = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(rest);
      const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
      const pair = rest.slice(0, 2);
      if (number) {
        if (number[0].length > 32 || !Number.isFinite(Number(number[0]))) invalid();
        tokens.push({ kind: "number", value: number[0] }); index += number[0].length;
      } else if (name) {
        if (name[0].length > 32) invalid();
        tokens.push({ kind: "name", value: name[0] }); index += name[0].length;
      } else if (["++", "--", "+=", "-=", "*=", "/=", "%=", "^=", "==", "!=", "<=", ">=", "&&", "||"].includes(pair)) {
        tokens.push({ kind: pair, value: pair }); index += 2;
      } else if ("{}(),;+-*/%^=!<>".includes(char)) {
        tokens.push({ kind: char, value: char }); index++;
      } else invalid();
    }
    if (tokens.length > 512) invalid();
  }
  return tokens;
}

function formatIsBounded(value) {
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "%") continue;
    if (value[index + 1] === "%") { index++; continue; }
    const match = /^%[-+ #0]*([0-9]{0,3})(?:\.([0-9]{1,2}))?[diuoxXeEfFgGs]/.exec(value.slice(index));
    if (!match || Number(match[1] || 0) > 128 || Number(match[2] || 0) > 32) return false;
    index += match[0].length - 1;
  }
  return true;
}

export function isReadOnlyAwkProgram(program) {
  if (typeof program !== "string" || !program.isWellFormed() || !program.trim() || Buffer.byteLength(program) > 4096 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(program)) return false;
  try {
    const tokens = lex(program), assigned = new Set(), used = new Set();
    let position = 0, statements = 0, rules = 0;
    // Literal contents never act as punctuation or keywords in this parser.
    const value = () => tokens[position]?.kind === "string" ? undefined : tokens[position]?.value;
    const kind = () => tokens[position]?.kind;
    const accept = token => { if (value() !== token) return false; position++; return true; };
    const require = token => { if (!accept(token)) invalid(); };
    const local = name => {
      if (!name || RESERVED.has(name) || SPECIAL.has(name)) invalid();
      assigned.add(name); if (assigned.size > 64) invalid();
    };
    function expression(comparisons = true, minimum = 0, depth = 0) {
      if (depth > 16) invalid();
      if (accept("+") || accept("-") || (comparisons && accept("!"))) expression(comparisons, 7, depth + 1);
      else if (accept("(")) { expression(true, 0, depth + 1); require(")"); }
      else if (["number", "field", "string"].includes(kind())) position++;
      else if (kind() === "name" && !RESERVED.has(value())) { used.add(value()); position++; }
      else invalid();
      while (PRECEDENCE.has(value()) && PRECEDENCE.get(value()) >= minimum) {
        const operator = value(), precedence = PRECEDENCE.get(operator);
        // Bare print/printf comparisons are ambiguous with AWK redirection.
        // Comparisons are allowed only in conditions or explicit parentheses.
        if (!comparisons && precedence <= 3) break;
        position++;
        expression(comparisons, precedence + (operator === "^" ? 0 : 1), depth + 1);
      }
    }
    function output(printf) {
      const parenthesized = accept("(");
      if (printf) {
        if (kind() !== "string" || !formatIsBounded(tokens[position].value)) invalid();
        position++;
      } else {
        if (!parenthesized && [";", "}"].includes(value())) return;
        expression(parenthesized);
      }
      let count = 1;
      while (accept(",")) { if (++count > 32) invalid(); expression(parenthesized); }
      if (parenthesized) require(")");
    }
    function statement(depth = 0) {
      if (depth > 16 || ++statements > 128) invalid();
      if (value() === "{") { block(depth + 1); return true; }
      if (accept("if")) {
        require("("); expression(); require(")"); statement(depth + 1);
        if (value() === ";" && tokens[position + 1]?.value === "else") position++;
        if (accept("else")) statement(depth + 1);
        return true;
      }
      if (accept("printf")) { output(true); return false; }
      if (accept("print")) { output(false); return false; }
      if (accept("++") || accept("--")) {
        if (kind() !== "name") invalid(); local(value()); position++; return false;
      }
      if (kind() !== "name") invalid();
      const name = value(); local(name); position++;
      if (accept("++") || accept("--")) return false;
      if (!ASSIGN.has(value())) invalid();
      position++; expression(); return false;
    }
    function block(depth = 0) {
      if (depth > 16) invalid(); require("{");
      while (position < tokens.length && value() !== "}") {
        if (accept(";")) continue;
        const structured = statement(depth + 1);
        if (!structured && ![";", "}"].includes(value())) invalid();
      }
      require("}");
    }
    while (position < tokens.length) {
      if (accept(";")) continue;
      if (++rules > 16) invalid();
      if (value() === "BEGIN" || value() === "END") position++;
      else if (value() !== "{") expression();
      block();
    }
    return rules > 0 && [...used].every(name => SPECIAL.has(name) || assigned.has(name));
  } catch { return false; }
}

function wordSpans(source) {
  const result = [];
  let start = 0, quote = "", escaped = false;
  for (let index = 0; index <= source.length; index++) {
    const char = source[index];
    if (quote === "'") { if (char === "'") quote = ""; continue; }
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote === '"') { if (char === '"') quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (index === source.length || char === " " || char === "\t") {
      if (index > start) {
        const raw = source.slice(start, index), values = tokenizeShellWords(raw);
        if (values.length !== 1) return [];
        result.push({ raw, value: values[0] });
      }
      start = index + 1;
    }
  }
  return quote || escaped ? [] : result;
}

export function isReadOnlyAwkCommand(command) {
  if (typeof command !== "string" || !command.isWellFormed() || Buffer.byteLength(command) > 8192 || hasActiveShellExpansion(command)) return false;
  const sequence = parseTopLevelShellSequence(command);
  if (sequence.openQuote || sequence.trailingEscape || sequence.trailingSeparator || sequence.commands.length !== 1) return false;
  const words = wordSpans(command.replace(/^[ \t]+|[ \t]+$/g, ""));
  if (words[0]?.raw !== "awk") return false;
  let index = 1;
  if (words[index]?.value.startsWith("-F")) {
    const option = words[index++].value;
    const separator = option === "-F" ? words[index++]?.value : option.slice(2);
    if (![",", ":", " ", "\t", "\\t"].includes(separator)) return false;
  }
  if (words[index]?.value === "--") index++;
  const program = words[index++];
  // Exact single-quoted source keeps the validated program identical to the
  // executable argv; shell concatenation/escape decoding cannot repair it.
  if (!program || program.raw !== "'" + program.value + "'" || !isReadOnlyAwkProgram(program.value)) return false;
  const files = words.slice(index);
  return files.length >= 1 && files.length <= 16 && files.every(({ raw, value }) => {
    if (!value || Buffer.byteLength(value) > 512 || value.startsWith("-") || value.startsWith("/") || value.includes("=") || value.includes("\\")) return false;
    if (!/^[\p{L}\p{N}_./ +@%,-]+$/u.test(value)) return false;
    const parts = value.replace(/^\.\//, "").split("/");
    if (parts.some(part => !part || part === "." || part === "..")) return false;
    return raw === value || raw === "'" + value + "'" || raw === '"' + value + '"';
  });
}
