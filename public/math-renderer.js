import katex from "katex";

const MAX_TEX_LENGTH = 8192;

function escapeMathHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
  );
}

function isEscaped(value, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function findClosingDelimiter(value, startIndex, delimiter, { dollar = false } = {}) {
  for (let index = startIndex; index <= value.length - delimiter.length; index += 1) {
    if (!value.startsWith(delimiter, index) || isEscaped(value, index)) continue;
    if (dollar && (value[index - 1] === "$" || value[index + 1] === "$")) continue;
    if (dollar && /\s/.test(value[index - 1] || "")) continue;
    return index;
  }
  return -1;
}

function mathFallback(source, { displayMode = false, block = false } = {}) {
  const tag = block ? "div" : "code";
  const classes = block ? "math-display math-fallback" : `math-fallback ${displayMode ? "math-display" : "math-inline"}`;
  const keyboardScroll = block ? ' tabindex="0"' : "";
  return `<${tag} class="${classes}" role="math" data-math-fallback="true"${keyboardScroll}>${escapeMathHtml(source)}</${tag}>`;
}

export function renderMathExpression(expression, { displayMode = false, block = false, source = "" } = {}) {
  const tex = String(expression ?? "").trim();
  const fallbackSource = source || tex;
  if (!tex || tex.length > MAX_TEX_LENGTH) return mathFallback(fallbackSource, { displayMode, block });

  try {
    const rendered = katex.renderToString(tex, {
      displayMode,
      throwOnError: true,
      strict: "error",
      trust: false,
      output: "htmlAndMathml",
      maxExpand: 1000,
      maxSize: 20,
    });
    const tag = block ? "div" : "span";
    const kind = displayMode ? "display" : "inline";
    const classes = `math-rendered math-${kind}`;
    const keyboardScroll = block ? ' tabindex="0"' : "";
    return `<${tag} class="${classes}" role="math" data-math-rendered="${kind}"${keyboardScroll}>${rendered}</${tag}>`;
  } catch {
    return mathFallback(fallbackSource, { displayMode, block });
  }
}

export function replaceInlineMath(value, protect) {
  const source = String(value ?? "");
  const preserve = typeof protect === "function" ? protect : (html) => html;
  let output = "";
  let cursor = 0;

  while (cursor < source.length) {
    let opening = null;
    if (source.startsWith("$$", cursor) && !isEscaped(source, cursor)) {
      opening = { open: "$$", close: "$$", displayMode: true, dollar: false };
    } else if (source.startsWith("\\[", cursor) && !isEscaped(source, cursor)) {
      opening = { open: "\\[", close: "\\]", displayMode: true, dollar: false };
    } else if (source.startsWith("\\(", cursor) && !isEscaped(source, cursor)) {
      opening = { open: "\\(", close: "\\)", displayMode: false, dollar: false };
    } else if (
      source[cursor] === "$" &&
      !isEscaped(source, cursor) &&
      source[cursor + 1] !== "$" &&
      !/\s/.test(source[cursor + 1] || "")
    ) {
      opening = { open: "$", close: "$", displayMode: false, dollar: true };
    }

    if (!opening) {
      output += source[cursor];
      cursor += 1;
      continue;
    }

    const expressionStart = cursor + opening.open.length;
    const closingIndex = findClosingDelimiter(source, expressionStart, opening.close, { dollar: opening.dollar });
    if (closingIndex < 0) {
      output += source[cursor];
      cursor += 1;
      continue;
    }

    const expression = source.slice(expressionStart, closingIndex);
    const rawSource = source.slice(cursor, closingIndex + opening.close.length);
    output += preserve(
      renderMathExpression(expression, {
        displayMode: opening.displayMode,
        block: false,
        source: rawSource,
      })
    );
    cursor = closingIndex + opening.close.length;
  }

  return output;
}

export function readDisplayMathBlock(lines, startIndex) {
  const firstLine = String(lines[startIndex] ?? "");
  const trimmed = firstLine.trim();
  const pair = trimmed.startsWith("$$")
    ? { open: "$$", close: "$$" }
    : trimmed.startsWith("\\[")
      ? { open: "\\[", close: "\\]" }
      : null;
  if (!pair) return null;

  const firstRemainder = trimmed.slice(pair.open.length);
  if (firstRemainder.endsWith(pair.close)) {
    const expression = firstRemainder.slice(0, -pair.close.length);
    return {
      endIndex: startIndex,
      html: renderMathExpression(expression, {
        displayMode: true,
        block: true,
        source: trimmed,
      }),
    };
  }
  if (firstRemainder.includes(pair.close)) return null;

  const expressionLines = firstRemainder ? [firstRemainder] : [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const candidate = String(lines[index] ?? "");
    const candidateTrimmedEnd = candidate.trimEnd();
    if (!candidateTrimmedEnd.endsWith(pair.close)) {
      expressionLines.push(candidate);
      continue;
    }

    expressionLines.push(candidateTrimmedEnd.slice(0, -pair.close.length));
    const rawSource = lines.slice(startIndex, index + 1).join("\n");
    return {
      endIndex: index,
      html: renderMathExpression(expressionLines.join("\n"), {
        displayMode: true,
        block: true,
        source: rawSource,
      }),
    };
  }

  return null;
}

export function startsDisplayMathBlock(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed.startsWith("$$") || trimmed.startsWith("\\[");
}
