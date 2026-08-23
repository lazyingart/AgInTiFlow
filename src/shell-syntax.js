export function hasActiveShellExpansion(value = "") {
  const text = String(value || "");
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      else if (char === "$" || char === "`") return true;
      continue;
    }
    if (char === "'") {
      quote = char;
      continue;
    }
    if (char === '"') {
      quote = char;
      continue;
    }
    if (char === "$" || char === "`") return true;
  }
  return false;
}

export function canonicalizeShellCommand(value = "") {
  const normalized = collapseEscapedLineContinuations(
    String(value || "").replace(/\r\n?/g, "\n")
  ).trim();
  if (!normalized || normalized.includes("\n")) return normalized;
  return normalized.replace(/\s+/g, " ").trim();
}

export function collapseEscapedLineContinuations(value = "") {
  const text = String(value || "");
  let output = "";
  let quote = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      output += char;
      if (char === "'") quote = "";
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1];
      if (next === "\n") {
        output += " ";
        index += 1;
        continue;
      }
      output += char;
      if (next !== undefined) {
        output += next;
        index += 1;
      }
      continue;
    }
    output += char;
    if (char === '"') {
      quote = quote === '"' ? "" : quote || '"';
    } else if (!quote && char === "'") {
      quote = "'";
    }
  }
  return output;
}

export function hasActiveShellCommandSubstitution(value = "") {
  const text = String(value || "");
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      else if (char === "`" || (char === "$" && text[index + 1] === "(")) return true;
      continue;
    }
    if (char === "'") {
      quote = char;
      continue;
    }
    if (char === '"') {
      quote = char;
      continue;
    }
    if (char === "`" || (char === "$" && text[index + 1] === "(")) return true;
  }
  return false;
}

export function parseTopLevelShellSequence(value = "") {
  const text = String(value || "");
  const commands = [];
  const separators = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let pendingSeparator = "";

  const flush = () => {
    const command = current.trim();
    if (command) {
      if (commands.length) separators.push(pendingSeparator || "unknown");
      commands.push(command);
      pendingSeparator = "";
    }
    current = "";
  };

  const separate = (separator) => {
    flush();
    if (commands.length && !pendingSeparator) pendingSeparator = separator;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    // POSIX single quotes make every enclosed byte literal. In particular, a
    // backslash cannot escape the closing quote.
    if (quote === "'") {
      current += char;
      if (char === "'") quote = "";
      continue;
    }
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
    if (quote === '"') {
      current += char;
      if (char === '"') quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === "#" && (!current || /\s/.test(current.at(-1)))) {
      flush();
      while (index + 1 < text.length && !/[\r\n]/.test(text[index + 1])) index += 1;
      if (text[index + 1] === "\r" && text[index + 2] === "\n") {
        if (commands.length && !pendingSeparator) pendingSeparator = "newline";
        index += 2;
      } else if (/[\r\n]/.test(text[index + 1] || "")) {
        if (commands.length && !pendingSeparator) pendingSeparator = "newline";
        index += 1;
      }
      continue;
    }
    const pair = text.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      separate(pair);
      index += 1;
      continue;
    }
    // Descriptor duplication is redirection, not a background boundary.
    // Preserve forms such as `2>&1`, `<&3`, and `&>` for downstream policy.
    if (
      char === "&" &&
      (text[index - 1] === ">" || text[index - 1] === "<" || text[index + 1] === ">")
    ) {
      current += char;
      continue;
    }
    if (char === "&") {
      separate("&");
      continue;
    }
    if (char === ";" || char === "\n" || char === "\r" || char === "|") {
      separate(char === "\n" || char === "\r" ? "newline" : char);
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      continue;
    }
    current += char;
  }
  flush();
  return {
    commands,
    separators,
    trailingSeparator: pendingSeparator,
    openQuote: quote,
    trailingEscape: escaped,
  };
}

function readHeredocDelimiterWord(value = "", startIndex = 0) {
  const text = String(value || "");
  let delimiter = "";
  let quote = "";
  let index = startIndex;

  while (index < text.length) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      else delimiter += char;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = "";
        index += 1;
        continue;
      }
      if (char === "\\") {
        const next = text[index + 1];
        if (["$", "`", '"', "\\"].includes(next)) {
          delimiter += next;
          index += 2;
          continue;
        }
        if (next === "\n" || next === "\r") {
          index += next === "\r" && text[index + 2] === "\n" ? 3 : 2;
          continue;
        }
      }
      delimiter += char;
      index += 1;
      continue;
    }
    if (/[\s;&|<>]/.test(char)) break;
    if (char === "'" || char === '"') {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        index += 1;
        continue;
      }
      if (next === "\n" || next === "\r") {
        index += next === "\r" && text[index + 2] === "\n" ? 3 : 2;
        continue;
      }
      delimiter += next;
      index += 2;
      continue;
    }
    delimiter += char;
    index += 1;
  }
  return { delimiter, endIndex: index };
}

function heredocOpeners(line = "") {
  const text = String(line || "");
  const openers = [];
  let quote = "";
  let escaped = false;
  let arithmeticParenthesisDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (arithmeticParenthesisDepth > 0) {
      if (char === "(") arithmeticParenthesisDepth += 1;
      else if (char === ")") arithmeticParenthesisDepth -= 1;
      continue;
    }
    if (text.slice(index, index + 3) === "$((") {
      arithmeticParenthesisDepth = 2;
      index += 2;
      continue;
    }
    if (text.slice(index, index + 2) === "((") {
      arithmeticParenthesisDepth = 2;
      index += 1;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(text[index - 1]))) break;
    if (text.slice(index, index + 2) !== "<<" || text[index + 2] === "<") continue;

    index += 2;
    let stripTabs = false;
    if (text[index] === "-") {
      stripTabs = true;
      index += 1;
    }
    while (/\s/.test(text[index] || "")) index += 1;
    const parsed = readHeredocDelimiterWord(text, index);
    const delimiter = parsed.delimiter;
    index = Math.max(index, parsed.endIndex - 1);
    if (delimiter) openers.push({ delimiter, stripTabs });
  }
  return openers;
}

function shellWithoutHeredocBodies(value = "") {
  const retained = [];
  const pending = [];
  for (const line of String(value || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (pending.length) {
      const expected = pending[0];
      const candidate = expected.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === expected.delimiter) pending.shift();
      continue;
    }
    retained.push(line);
    pending.push(...heredocOpeners(line));
  }
  return { text: retained.join("\n"), pendingHeredocs: pending };
}

function shellControlTokens(value = "") {
  const tokens = [];
  let current = "";
  let quotedWord = false;
  let quote = "";
  let escaped = false;
  const flush = () => {
    if (current) tokens.push({ value: current, quoted: quotedWord, control: false });
    current = "";
    quotedWord = false;
  };

  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      else current += char;
      continue;
    }
    if (escaped) {
      current += char;
      quotedWord = true;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quotedWord = true;
      continue;
    }
    if (char === "#" && (!current || /\s/.test(text[index - 1] || ""))) {
      flush();
      while (index + 1 < text.length && !/[\r\n]/.test(text[index + 1])) index += 1;
      continue;
    }
    const pair = text.slice(index, index + 2);
    if (pair === "<(" || pair === ">(") {
      flush();
      tokens.push({
        value: pair,
        quoted: false,
        control: true,
        processSubstitution: true,
      });
      index += 1;
      continue;
    }
    if (pair === "&&" || pair === "||" || pair === ";;") {
      flush();
      tokens.push({ value: pair, quoted: false, control: true });
      index += 1;
      continue;
    }
    if (/[;\n\r|&(){}]/.test(char)) {
      flush();
      tokens.push({ value: char === "\r" ? "\n" : char, quoted: false, control: true });
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

export function startsWithShellArrayAssignment(value = "") {
  return /^(?:(?:declare|typeset|local|readonly)\s+(?:-[A-Za-z]+\s+)*)?[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\n]*\])?\+?=\s*\(/.test(
    String(value || "").trimStart()
  );
}

function hasUnclosedShellCompound(value = "") {
  const { text } = shellWithoutHeredocBodies(value);
  const stack = [];
  let commandStart = true;
  const openers = new Map([
    ["if", "fi"],
    ["for", "done"],
    ["while", "done"],
    ["until", "done"],
    ["select", "done"],
    ["case", "esac"],
  ]);
  const tokens = shellControlTokens(text);
  const beginsCommand = (index) =>
    index === 0 ||
    [";", ";;", "\n", "&&", "||", "|", "&"].includes(tokens[index - 1]?.value);
  const shellIdentifier = (entry) =>
    Boolean(
      entry &&
        entry.control !== true &&
        entry.quoted !== true &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.value)
    );
  const functionBodyOpener = (index) => {
    if (tokens[index]?.value !== "{") return false;
    const posixName = tokens[index - 3];
    if (
      tokens[index - 2]?.value === "(" &&
      tokens[index - 1]?.value === ")" &&
      shellIdentifier(posixName) &&
      beginsCommand(index - 3)
    ) {
      return true;
    }
    const functionKeyword = tokens[index - 4];
    if (
      String(functionKeyword?.value || "").toLowerCase() === "function" &&
      functionKeyword?.quoted !== true &&
      shellIdentifier(tokens[index - 3]) &&
      tokens[index - 2]?.value === "(" &&
      tokens[index - 1]?.value === ")" &&
      beginsCommand(index - 4)
    ) {
      return true;
    }
    const keyword = tokens[index - 2];
    return (
      shellIdentifier(tokens[index - 1]) &&
      String(keyword?.value || "").toLowerCase() === "function" &&
      keyword?.quoted !== true &&
      beginsCommand(index - 2)
    );
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    const token = entry.value;
    const lower = token.toLowerCase();
    if ([";", ";;", "\n", "&&", "||", "|", "&"].includes(token)) {
      commandStart = true;
      continue;
    }
    if (entry.processSubstitution === true) {
      stack.push(")");
      commandStart = true;
      continue;
    }
    if (token === "(" || token === "{") {
      const priorToken = tokens[index - 1];
      const expansionOpener =
        priorToken?.control !== true && String(priorToken?.value || "").endsWith("$");
      const arrayAssignmentOpener =
        token === "(" &&
        priorToken?.control !== true &&
        priorToken?.quoted !== true &&
        /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/.test(String(priorToken?.value || ""));
      if (commandStart || functionBodyOpener(index) || expansionOpener || arrayAssignmentOpener) {
        stack.push(token === "(" ? ")" : "}");
      }
      commandStart = true;
      continue;
    }
    if (token === ")" || token === "}") {
      if (stack.at(-1) === token) stack.pop();
      commandStart = false;
      continue;
    }
    if (commandStart && !entry.quoted && ["fi", "done", "esac"].includes(lower)) {
      if (stack.at(-1) === lower) stack.pop();
      commandStart = false;
      continue;
    }
    if (commandStart && !entry.quoted && openers.has(lower)) {
      stack.push(openers.get(lower));
      commandStart = false;
      continue;
    }
    if (commandStart && !entry.quoted && ["then", "do", "else", "elif"].includes(lower)) {
      commandStart = true;
      continue;
    }
    commandStart = false;
  }
  return stack.length > 0;
}

function hasUnclosedBacktickSubstitution(value = "") {
  const text = String(value || "");
  const parentQuotes = [];
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (char === "`") {
      if (parentQuotes.length) {
        quote = parentQuotes.pop();
      } else {
        parentQuotes.push(quote);
        quote = "";
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      continue;
    }
    if (char === "'" || char === '"') quote = char;
  }
  return parentQuotes.length > 0;
}

export function shellCommandNeedsContinuation(value = "") {
  const heredoc = shellWithoutHeredocBodies(value);
  const syntax = parseTopLevelShellSequence(heredoc.text);
  return Boolean(
    syntax.openQuote ||
      syntax.trailingEscape ||
      ["&&", "||", "|"].includes(syntax.trailingSeparator) ||
      heredoc.pendingHeredocs.length ||
      hasUnclosedBacktickSubstitution(value) ||
      hasUnclosedShellCompound(value)
  );
}

export function splitTopLevelShellCommands(value = "") {
  return parseTopLevelShellSequence(value).commands;
}

export function tokenizeShellWords(value = "") {
  const text = String(value || "");
  const tokens = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let tokenStarted = false;
  const expansionClosers = [];

  const flush = () => {
    if (tokenStarted) tokens.push(current);
    current = "";
    tokenStarted = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      tokenStarted = true;
      if (char === "'") quote = "";
      else current += char;
      continue;
    }
    if (escaped) {
      current += char;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      tokenStarted = true;
      if (char === '"') quote = "";
      else current += char;
      continue;
    }
    const expansionPair = text.slice(index, index + 2);
    if (expansionPair === "$(" || expansionPair === "${") {
      current += expansionPair;
      tokenStarted = true;
      expansionClosers.push(expansionPair === "$(" ? ")" : "}");
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (expansionClosers.length) {
      if (char === "(" || char === "{") {
        expansionClosers.push(char === "(" ? ")" : "}");
      } else if (char === expansionClosers.at(-1)) {
        expansionClosers.pop();
      }
      current += char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (escaped) current += "\\";
  if (quote || expansionClosers.length) return [];
  flush();
  return tokens;
}
