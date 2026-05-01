import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { runAgent } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import { initProject, listProjectSessions, providerKeyStatus, readProjectInstructions, setProviderKey } from "./project.js";
import { normalizePackageInstallPolicy, normalizeSandboxMode } from "./command-policy.js";
import { defaultMaxStepsForProfile, normalizeTaskProfile } from "./task-profiles.js";
import { recommendedMaxStepsForTask } from "./engineering-guidance.js";
import { promptAndSaveDeepSeekKey, promptHidden, shouldPromptForDeepSeek } from "./auth-onboarding.js";

const useColor = Boolean(input.isTTY && output.isTTY && process.env.AGINTIFLOW_NO_COLOR !== "1");
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  faint: "\x1b[2m",
  clearLine: "\x1b[2K",
  cursorHide: "\x1b[?25l",
  cursorShow: "\x1b[?25h",
  userBg: "\x1b[48;5;24m\x1b[38;5;231m",
  agentBg: "\x1b[48;5;29m\x1b[38;5;231m",
  systemBg: "\x1b[48;5;236m\x1b[38;5;245m",
};
const brandPalette = ["\x1b[38;5;45m", "\x1b[38;5;81m", "\x1b[38;5;86m", "\x1b[38;5;118m", "\x1b[38;5;226m"];
const SLASH_COMMANDS = [
  "/help",
  "/status",
  "/login",
  "/auth",
  "/instructions",
  "/memory",
  "/auxilliary",
  "/auxiliary",
  "/new",
  "/resume",
  "/sessions",
  "/profile",
  "/web-search",
  "/scouts",
  "/routing",
  "/provider",
  "/model",
  "/docker",
  "/latex",
  "/installs",
  "/cwd",
  "/init",
  "/web",
  "/exit",
];
const promptHistory = [];

function color(value, ...codes) {
  if (!useColor || codes.length === 0) return String(value);
  return `${codes.join("")}${value}${ansi.reset}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function label(name, bgCode) {
  return color(` ${name} `, bgCode, ansi.bold);
}

function terminalWidth() {
  return Math.max(Number(output.columns) || 80, 40);
}

function terminalHeight() {
  return Math.max(Number(output.rows) || 24, 10);
}

function editorWidth(width = terminalWidth()) {
  return Math.max(Number(width) - 1, 39);
}

function promptViewportRows(height = terminalHeight()) {
  return Math.max(Math.min(Math.floor(Number(height) * 0.42), 10), 4);
}

function visualLength(value) {
  return stripAnsi(value).length;
}

function padVisible(value, width) {
  const padding = Math.max(width - visualLength(value), 0);
  return `${value}${" ".repeat(padding)}`;
}

function panelLine(content = "", bgCode = ansi.systemBg, width = editorWidth()) {
  const raw = String(content || "");
  const safeContent = visualLength(raw) > width ? stripAnsi(raw).slice(0, width) : raw;
  if (!useColor) return padVisible(safeContent, width);
  const padded = padVisible(safeContent, width).replaceAll(ansi.reset, `${ansi.reset}${bgCode}`);
  return `${bgCode}${padded}${ansi.reset}`;
}

function userPrompt() {
  return `\n${label("user>", ansi.userBg)} ${color("|", ansi.userBg)} `;
}

function commandCompleter(line = "") {
  const trimmed = String(line || "");
  if (!trimmed.startsWith("/")) return [[], trimmed];
  const hits = SLASH_COMMANDS.filter((command) => command.startsWith(trimmed));
  return [hits.length > 0 ? hits : SLASH_COMMANDS, trimmed];
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function promptGutter() {
  const visible = stripAnsi(userPrompt()).replace(/^\n/, "").length;
  return " ".repeat(Math.max(visible - 2, 0)) + `${color("|", ansi.userBg)} `;
}

function commandSuggestions(line = "") {
  const trimmed = String(line || "");
  if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return [];
  return SLASH_COMMANDS.filter((command) => command.startsWith(trimmed)).slice(0, 8);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function stripMarkdown(text) {
  const lines = String(text || "").split(/\r?\n/);
  let inFence = false;
  const rendered = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    let line = rawLine;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (inFence) {
        const language = line.replace(/^\s*```/, "").trim();
        rendered.push(color(language ? `code ${language}` : "code", ansi.dim));
      }
      continue;
    }

    if (!inFence) {
      if (/^\s*[-*_]{3,}\s*$/.test(line)) {
        rendered.push(color("-".repeat(42), ansi.dim));
        continue;
      }
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (heading) {
        rendered.push(color(heading[2].replace(/\s+#*$/, ""), ansi.bold, ansi.cyan));
        continue;
      }
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
        continue;
      }
      const table = parseMarkdownTable(lines, index);
      if (table) {
        rendered.push(...renderMarkdownTable(table));
        index += table.rawLineCount - 1;
        continue;
      }
      line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
      line = line.replace(/\*\*([^*]+)\*\*/g, (_, value) => color(value, ansi.bold));
      line = line.replace(/__([^_]+)__/g, (_, value) => color(value, ansi.bold));
      line = line.replace(/(^|[^\w])\*([^*\n]+)\*/g, "$1$2");
      line = line.replace(/(^|[^\w])_([^_\n]+)_/g, "$1$2");
      line = line.replace(/`([^`]+)`/g, (_, value) => color(value, ansi.yellow));
      line = line.replace(/^(\s*)[-*+]\s+/, "$1- ");
      line = line.replace(/^\s*>\s?(.+)$/, (_, value) => color(`| ${value}`, ansi.dim));
    } else {
      line = color(`  ${line}`, ansi.yellow);
    }

    rendered.push(line);
  }

  return rendered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function splitMarkdownTableRow(line = "") {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("|")) return null;
  const normalized = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = normalized.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(line = "") {
  const cells = splitMarkdownTableRow(line);
  return Boolean(cells?.length) && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTable(lines, startIndex) {
  const header = splitMarkdownTableRow(lines[startIndex]);
  if (!header || !isMarkdownTableSeparator(lines[startIndex + 1] || "")) return null;
  const rows = [];
  let index = startIndex + 2;
  while (index < lines.length) {
    const row = splitMarkdownTableRow(lines[index]);
    if (!row) break;
    rows.push(row);
    index += 1;
  }
  return {
    header,
    rows,
    rawLineCount: Math.max(index - startIndex, 2),
  };
}

function renderMarkdownTable(table) {
  const allRows = [table.header, ...table.rows];
  const columnCount = Math.max(...allRows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_unused, column) =>
    Math.min(
      Math.max(
        ...allRows.map((row) => visualLength(stripMarkdownInline(row[column] || ""))),
        3
      ),
      36
    )
  );
  const formatRow = (row, header = false) =>
    widths
      .map((width, column) => {
        const value = stripMarkdownInline(row[column] || "");
        return padVisible(value, width);
      })
      .join(color("  │  ", ansi.dim));
  const separator = widths.map((width) => "─".repeat(width)).join(color("──┼──", ansi.dim));
  return [
    color(formatRow(table.header, true), ansi.bold, ansi.cyan),
    color(separator, ansi.dim),
    ...table.rows.map((row) => formatRow(row)),
  ];
}

function stripMarkdownInline(value = "") {
  return String(value)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, (_, text) => color(text, ansi.bold))
    .replace(/__([^_]+)__/g, (_, text) => color(text, ansi.bold))
    .replace(/`([^`]+)`/g, (_, text) => color(text, ansi.yellow))
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
}

function rolePrefix(name, bgCode) {
  return `${label(name, bgCode)} ${color("|", bgCode)} `;
}

function printWrapped(prefix, text, { stripCode = "" } = {}) {
  const rendered = stripMarkdown(text);
  const lines = rendered.split("\n");
  const visible = stripAnsi(prefix).length;
  const gutter = `${" ".repeat(Math.max(visible - 2, 0))}${stripCode ? color("|", stripCode) : "|"} `;
  console.log(`${prefix}${lines[0] || ""}`);
  for (const line of lines.slice(1)) {
    console.log(`${gutter}${line}`);
  }
}

function printAgentMessage(text) {
  printWrapped(rolePrefix("aginti>", ansi.agentBg), text, { stripCode: ansi.agentBg });
}

function printSystemLine(text) {
  if (!String(text || "").trim()) {
    console.log("");
    return;
  }
  console.log(`${label("state", ansi.systemBg)} ${color(text, ansi.dim)}`);
}

function printHeading(text) {
  console.log(color(stripMarkdown(text), ansi.bold, ansi.cyan));
}

function shimmerText(text, frame) {
  if (!useColor) return text;
  return [...text]
    .map((char, index) => {
      if (char === " ") return char;
      const code = brandPalette[(index + frame) % brandPalette.length];
      return `${code}${ansi.bold}${char}${ansi.reset}`;
    })
    .join("");
}

async function renderLaunchHeader(packageVersion = "") {
  const title = "AgInTi Flow";
  const subtitle = "web-first agent workspace";
  const version = packageVersion ? `v${packageVersion}` : "";
  const width = Math.min(Math.max(terminalWidth() - 2, 58), 82);
  const top = `╭${"─".repeat(width)}╮`;
  const mid = `├${"─".repeat(width)}┤`;
  const bottom = `╰${"─".repeat(width)}╯`;

  if (!useColor || process.env.AGINTIFLOW_NO_ANIMATION === "1") {
    console.log(` AgInTiFlow ${packageVersion || ""}`.trim());
    return;
  }

  output.write(ansi.cursorHide);
  for (let frame = 0; frame < 18; frame += 1) {
    output.write(`\r${ansi.clearLine}${shimmerText(title, frame)} ${color("is starting", ansi.dim)}`);
    await sleep(32);
  }
  output.write(`\r${ansi.clearLine}`);
  output.write(ansi.cursorShow);

  const border = "\x1b[38;5;45m";
  const titleLine = `${shimmerText(title, 2)} ${color(version, ansi.dim)}`;
  const tagline = "browser + shell + files + docker + web search + scouts";
  console.log(color(top, border));
  console.log(`${color("│", border)} ${padVisible(titleLine, width - 2)} ${color("│", border)}`);
  console.log(`${color("│", border)} ${color(padVisible(subtitle, width - 2), ansi.dim)} ${color("│", border)}`);
  console.log(color(mid, border));
  console.log(`${color("│", border)} ${color(padVisible(tagline, width - 2), ansi.cyan)} ${color("│", border)}`);
  console.log(color(bottom, border));
}

function printHelp() {
  printAgentMessage(
    [
      "Commands:",
      "  /help                     Show this help.",
      "  /status                   Show active route, workspace, sandbox, and session.",
      "  /login [deepseek|openai|grsai]  Paste and save a project-local API key.",
      "  /auth [deepseek|openai|grsai]   Alias for /login.",
      "  /instructions             Show AGINTI.md project instructions status.",
      "  /memory                   Alias for /instructions.",
      "  /auxilliary [status|grsai|on|off|image]",
      "                            Manage optional auxiliary skills, including GRS AI image generation.",
      "  /new                      Start a fresh session on the next message.",
      "  /resume <session-id>      Continue a saved session.",
      "  /sessions                 List recent sessions in this project.",
      "  /profile <name>           Set task profile, e.g. code, website, latex, maintenance.",
      "  /web-search on|off        Enable or disable the web_search tool.",
      "  /scouts on|off|<1-4>      Enable parallel DeepSeek scouts and set scout count.",
      "  /routing <mode>           Set routing: smart, fast, complex, manual.",
      "  /provider <name>          Set provider: deepseek, openai, mock.",
      "  /model <name>             Set an explicit model, or /model auto.",
      "  /docker on                Use docker-workspace with approved package installs.",
      "  /docker off               Use host shell policy.",
      "  /latex on                 Use the LaTeX/PDF profile in Docker with a larger step budget.",
      "  /installs block|prompt|allow",
      "  /cwd <path>               Change command workspace.",
      "  /exit                     Quit.",
      "",
      "Type a normal request to run the agent. Example: write a Python CLI app with tests",
      "Type / then Tab to autocomplete commands.",
      "While a run is active, press Esc or Ctrl+C once to stop gracefully and print a resume command.",
    ].join("\n")
  );
}

function logicalLinesWithOffsets(buffer = "") {
  const lines = String(buffer).split("\n");
  let offset = 0;
  return lines.map((line, index) => {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    return {
      text: line,
      start,
      end,
      hasNewline: index < lines.length - 1,
    };
  });
}

function promptVisibleWindow(rows, cursorRow, height = terminalHeight()) {
  const maxRows = promptViewportRows(height);
  if (rows.length <= maxRows) {
    return { start: 0, end: rows.length, topHidden: 0, bottomHidden: 0 };
  }
  const half = Math.floor(maxRows / 2);
  const start = clamp(cursorRow - half, 0, rows.length - maxRows);
  const end = start + maxRows;
  return {
    start,
    end,
    topHidden: start,
    bottomHidden: rows.length - end,
  };
}

export function buildPromptLayout(buffer = "", cursor = 0, width = terminalWidth(), height = terminalHeight()) {
  const safeBuffer = String(buffer || "");
  const safeCursor = clamp(Number(cursor) || 0, 0, safeBuffer.length);
  const lineWidth = editorWidth(width);
  const firstPrefix = " user ";
  const nextPrefix = "  ... ";
  const firstInnerWidth = Math.max(lineWidth - firstPrefix.length, 8);
  const nextInnerWidth = Math.max(lineWidth - nextPrefix.length, 8);
  const rows = [];

  for (const [lineIndex, line] of logicalLinesWithOffsets(safeBuffer).entries()) {
    let localOffset = 0;
    const text = line.text;
    if (!text) {
      rows.push({
        prefix: lineIndex === 0 ? firstPrefix : nextPrefix,
        text: "",
        start: line.start,
        end: line.start,
        innerWidth: lineIndex === 0 ? firstInnerWidth : nextInnerWidth,
        lineStart: line.start,
        lineEnd: line.end,
        hasNewline: line.hasNewline,
      });
      continue;
    }

    while (localOffset < text.length) {
      const prefix = lineIndex === 0 && localOffset === 0 ? firstPrefix : nextPrefix;
      const innerWidth = prefix === firstPrefix ? firstInnerWidth : nextInnerWidth;
      const chunk = text.slice(localOffset, localOffset + innerWidth);
      rows.push({
        prefix,
        text: chunk,
        start: line.start + localOffset,
        end: line.start + localOffset + chunk.length,
        innerWidth,
        lineStart: line.start,
        lineEnd: line.end,
        hasNewline: line.hasNewline,
      });
      localOffset += chunk.length;
    }
  }

  if (rows.length === 0) {
    rows.push({
      prefix: firstPrefix,
      text: "",
      start: 0,
      end: 0,
      innerWidth: firstInnerWidth,
      lineStart: 0,
      lineEnd: 0,
      hasNewline: false,
    });
  }

  const last = rows[rows.length - 1];
  if (safeCursor === safeBuffer.length && last.end === safeCursor && last.text.length >= last.innerWidth) {
    rows.push({
      prefix: nextPrefix,
      text: "",
      start: safeCursor,
      end: safeCursor,
      innerWidth: nextInnerWidth,
      lineStart: safeCursor,
      lineEnd: safeCursor,
      hasNewline: false,
    });
  }

  let cursorRow = rows.length - 1;
  let cursorColumn = rows[cursorRow].prefix.length;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const next = rows[index + 1];
    if (safeCursor < row.end) {
      cursorRow = index;
      cursorColumn = row.prefix.length + safeCursor - row.start;
      break;
    }
    if (safeCursor === row.end) {
      if (next && next.start === safeCursor && row.text.length >= row.innerWidth) continue;
      cursorRow = index;
      cursorColumn = row.prefix.length + safeCursor - row.start;
      break;
    }
  }

  const suggestions = commandSuggestions(safeBuffer.split("\n")[0] || "");
  const emptyHint = "type a request, /help, Enter to send, Ctrl+J for newline";
  const visible = promptVisibleWindow(rows, cursorRow, height);
  const renderedRows = [];
  let renderedCursorRow = cursorRow - visible.start;

  if (visible.topHidden > 0) {
    renderedRows.push(panelLine(`  ... ${visible.topHidden} earlier input row${visible.topHidden === 1 ? "" : "s"}`, ansi.systemBg, lineWidth));
    renderedCursorRow += 1;
  }

  for (const row of rows.slice(visible.start, visible.end)) {
    const content = safeBuffer ? `${row.prefix}${row.text}` : `${row.prefix}${emptyHint}`;
    renderedRows.push(panelLine(content, ansi.userBg, lineWidth));
  }

  if (visible.bottomHidden > 0) {
    renderedRows.push(panelLine(`  ... ${visible.bottomHidden} later input row${visible.bottomHidden === 1 ? "" : "s"}`, ansi.systemBg, lineWidth));
  }

  if (suggestions.length > 0) {
    renderedRows.push(panelLine(` hint  ${suggestions.join("  ")}`, ansi.systemBg, lineWidth));
  }

  return {
    rows,
    renderedRows,
    cursorRow: renderedCursorRow,
    absoluteCursorRow: cursorRow,
    cursorColumn: clamp(cursorColumn, 0, editorWidth(width) - 1),
  };
}

function cursorLocation(layout, cursor) {
  for (let index = 0; index < layout.rows.length; index += 1) {
    const row = layout.rows[index];
    const next = layout.rows[index + 1];
    if (cursor < row.end) return { rowIndex: index, column: cursor - row.start };
    if (cursor === row.end) {
      if (next && next.start === cursor && row.text.length >= row.innerWidth) continue;
      return { rowIndex: index, column: cursor - row.start };
    }
  }
  const rowIndex = Math.max(layout.rows.length - 1, 0);
  const row = layout.rows[rowIndex];
  return { rowIndex, column: Math.max(row.end - row.start, 0) };
}

function clearRenderedPrompt(previous) {
  if (!previous.lineCount) return;
  const below = previous.lineCount - 1 - previous.cursorRow;
  if (below > 0) output.write(`\x1b[${below}B`);
  output.write(`\r${ansi.clearLine}`);
  for (let index = 1; index < previous.lineCount; index += 1) {
    output.write(`\x1b[1A\r${ansi.clearLine}`);
  }
}

function renderPromptBuffer(buffer, cursor, previous = { lineCount: 0, cursorRow: 0 }) {
  output.write(ansi.cursorHide);
  clearRenderedPrompt(previous);
  const layout = buildPromptLayout(buffer, cursor);
  output.write(layout.renderedRows.join("\n"));
  const below = layout.renderedRows.length - 1 - layout.cursorRow;
  if (below > 0) output.write(`\x1b[${below}A`);
  output.write(`\r\x1b[${layout.cursorColumn + 1}G`);
  output.write(ansi.cursorShow);
  return {
    lineCount: layout.renderedRows.length,
    cursorRow: layout.cursorRow,
  };
}

function moveToPromptBottom(rendered) {
  const below = Math.max((rendered?.lineCount || 1) - 1 - (rendered?.cursorRow || 0), 0);
  if (below > 0) output.write(`\x1b[${below}B`);
  output.write("\r");
}

function lineBounds(buffer, cursor) {
  const safeCursor = clamp(cursor, 0, buffer.length);
  const start = buffer.lastIndexOf("\n", safeCursor - 1) + 1;
  const nextNewline = buffer.indexOf("\n", safeCursor);
  const end = nextNewline === -1 ? buffer.length : nextNewline;
  return { start, end };
}

function insertAt(buffer, cursor, text) {
  return {
    buffer: `${buffer.slice(0, cursor)}${text}${buffer.slice(cursor)}`,
    cursor: cursor + text.length,
  };
}

function removeBefore(buffer, cursor) {
  if (cursor <= 0) return { buffer, cursor };
  return {
    buffer: `${buffer.slice(0, cursor - 1)}${buffer.slice(cursor)}`,
    cursor: cursor - 1,
  };
}

function removeAt(buffer, cursor) {
  if (cursor >= buffer.length) return { buffer, cursor };
  return {
    buffer: `${buffer.slice(0, cursor)}${buffer.slice(cursor + 1)}`,
    cursor,
  };
}

function createAbortError(message = "Aborted with Ctrl+C") {
  const error = new Error(message);
  error.code = "ABORT_ERR";
  error.name = "AbortError";
  return error;
}

function readTtyPrompt() {
  return new Promise((resolve, reject) => {
    emitKeypressEvents(input);
    const wasRaw = Boolean(input.isRaw);
    let buffer = "";
    let cursor = 0;
    let rendered = { lineCount: 0, cursorRow: 0 };
    let preferredColumn = null;
    let historyIndex = promptHistory.length;
    let draft = "";
    let redrawHandle = null;

    const cleanup = () => {
      if (redrawHandle) {
        clearImmediate(redrawHandle);
        redrawHandle = null;
      }
      input.off("keypress", handler);
      if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
      input.pause();
      output.write(ansi.cursorShow);
    };

    const renderNow = () => {
      if (redrawHandle) {
        clearImmediate(redrawHandle);
        redrawHandle = null;
      }
      rendered = renderPromptBuffer(buffer, cursor, rendered);
    };

    const redraw = () => {
      if (redrawHandle) return;
      redrawHandle = setImmediate(() => {
        redrawHandle = null;
        rendered = renderPromptBuffer(buffer, cursor, rendered);
      });
    };

    const submit = () => {
      renderNow();
      moveToPromptBottom(rendered);
      cleanup();
      output.write("\n");
      const saved = buffer.trim();
      if (saved && promptHistory[promptHistory.length - 1] !== buffer) promptHistory.push(buffer);
      resolve(buffer);
    };

    const setBuffer = (nextBuffer, nextCursor = nextBuffer.length) => {
      buffer = nextBuffer;
      cursor = clamp(nextCursor, 0, buffer.length);
      preferredColumn = null;
      redraw();
    };

    const moveVertical = (direction) => {
      const layout = buildPromptLayout(buffer, cursor);
      const location = cursorLocation(layout, cursor);
      const targetRowIndex = location.rowIndex + direction;
      if (targetRowIndex < 0) {
        if (promptHistory.length === 0) return;
        if (historyIndex === promptHistory.length) draft = buffer;
        historyIndex = Math.max(historyIndex - 1, 0);
        setBuffer(promptHistory[historyIndex], promptHistory[historyIndex].length);
        return;
      }
      if (targetRowIndex >= layout.rows.length) {
        if (historyIndex < promptHistory.length - 1) {
          historyIndex += 1;
          setBuffer(promptHistory[historyIndex], promptHistory[historyIndex].length);
        } else if (historyIndex < promptHistory.length) {
          historyIndex = promptHistory.length;
          setBuffer(draft, draft.length);
        }
        return;
      }
      const currentColumn = preferredColumn ?? location.column;
      const targetRow = layout.rows[targetRowIndex];
      cursor = targetRow.start + Math.min(currentColumn, targetRow.end - targetRow.start);
      preferredColumn = currentColumn;
      redraw();
    };

    const handler = (str = "", key = {}) => {
      if (key.ctrl && key.name === "c") {
        renderNow();
        moveToPromptBottom(rendered);
        cleanup();
        output.write("\n");
        reject(createAbortError());
        return;
      }
      if ((key.ctrl && key.name === "j") || key.sequence === "\n") {
        ({ buffer, cursor } = insertAt(buffer, cursor, "\n"));
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.sequence === "\r" || str === "\r") {
        submit();
        return;
      }
      if (key.name === "backspace") {
        ({ buffer, cursor } = removeBefore(buffer, cursor));
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.name === "delete") {
        ({ buffer, cursor } = removeAt(buffer, cursor));
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.name === "left") {
        cursor = Math.max(cursor - 1, 0);
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.name === "right") {
        cursor = Math.min(cursor + 1, buffer.length);
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.name === "up") {
        moveVertical(-1);
        return;
      }
      if (key.name === "down") {
        moveVertical(1);
        return;
      }
      if ((key.ctrl && key.name === "a") || key.name === "home") {
        cursor = lineBounds(buffer, cursor).start;
        preferredColumn = null;
        redraw();
        return;
      }
      if ((key.ctrl && key.name === "e") || key.name === "end") {
        cursor = lineBounds(buffer, cursor).end;
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.ctrl && key.name === "u") {
        const bounds = lineBounds(buffer, cursor);
        buffer = `${buffer.slice(0, bounds.start)}${buffer.slice(cursor)}`;
        cursor = bounds.start;
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.ctrl && key.name === "k") {
        const bounds = lineBounds(buffer, cursor);
        buffer = `${buffer.slice(0, cursor)}${buffer.slice(bounds.end)}`;
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.name === "tab") {
        const suggestions = commandSuggestions(buffer.split("\n")[0] || "");
        if (suggestions.length === 1) {
          buffer = suggestions[0];
          cursor = buffer.length;
        }
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.name === "escape") {
        buffer = "";
        cursor = 0;
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.ctrl || key.meta) return;
      if (str && !key.sequence?.startsWith("\x1b")) {
        const text = str.replace(/\r/g, "");
        ({ buffer, cursor } = insertAt(buffer, cursor, text));
        preferredColumn = null;
        redraw();
      }
    };

    input.resume();
    input.setRawMode(true);
    input.on("keypress", handler);
    renderNow();
  });
}

async function readPromptAnswer(rl) {
  if (input.isTTY && output.isTTY && typeof input.setRawMode === "function") {
    return readTtyPrompt();
  }
  return rl.question(userPrompt());
}

function printStatus(state) {
  printSystemLine(`project=${process.cwd()}`);
  printSystemLine(`cwd=${state.commandCwd || process.cwd()}`);
  printSystemLine(`session=${state.sessionId || "new"}`);
  printSystemLine(`status=${state.status || "idle"}${state.activeGoal ? ` workingOn=${state.activeGoal}` : ""}`);
  if (state.lastEvent) printSystemLine(`last=${state.lastEvent}`);
  printSystemLine(`provider=${state.provider || "auto"} routing=${state.routingMode} model=${state.model || "auto"}`);
  printSystemLine(`profile=${state.taskProfile} maxSteps=${state.maxSteps}`);
  printSystemLine(
    `shell=${state.allowShellTool} files=${state.allowFileTools} webSearch=${state.allowWebSearch} scouts=${state.allowParallelScouts}:${state.parallelScoutCount} auxiliary=${state.allowAuxiliaryTools} sandbox=${state.sandboxMode} installs=${state.packageInstallPolicy}`
  );
  if (state.sandboxMode !== "host") {
    printSystemLine(`dockerWorkspace=/workspace -> ${state.commandCwd || process.cwd()}`);
  }
}

function isAbortError(error) {
  return error?.code === "ABORT_ERR" || error?.name === "AbortError";
}

function formatSessionLine(session) {
  const goal = session.goal ? ` ${session.goal.slice(0, 72)}` : "";
  return `${session.sessionId} ${session.provider || "unknown"}/${session.model || "unknown"} ${session.updatedAt || ""}${goal}`.trim();
}

async function latestSession() {
  const sessions = await listProjectSessions(process.cwd(), 1);
  return sessions[0] || null;
}

function printStatusEvent(state, label, details = "") {
  state.lastEvent = details ? `${label}: ${details}` : label;
  printSystemLine(`status=${state.status || "running"} ${state.lastEvent}`);
}

function attachRunInterrupts(controller) {
  if (!input.isTTY || typeof input.setRawMode !== "function") return () => {};

  emitKeypressEvents(input);
  const wasRaw = Boolean(input.isRaw);
  input.resume();
  input.setRawMode(true);
  const handler = (_str, key = {}) => {
    const isEscape = key.name === "escape";
    const isCtrlC = key.ctrl && key.name === "c";
    if (!isEscape && !isCtrlC) return;
    if (controller.signal.aborted) return;
    const reason = isEscape ? "escape" : "ctrl-c";
    printSystemLine(`status=stopping reason=${reason}`);
    controller.abort(new Error(`Interrupted by ${reason}.`));
  };
  input.on("keypress", handler);
  return () => {
    input.off("keypress", handler);
    if (typeof input.setRawMode === "function") {
      input.setRawMode(wasRaw);
    }
  };
}

async function printResumeHint(state) {
  const sessionId = state.sessionId || "";
  console.log("");
  if (sessionId) {
    printAgentMessage(["Interrupted. Session saved.", `Resume: aginti resume ${sessionId}`, `One-shot: aginti resume ${sessionId} "continue"`].join("\n"));
  } else {
    printAgentMessage("Interrupted. No active session yet.");
    const sessions = await listProjectSessions(process.cwd(), 5).catch(() => []);
    if (sessions.length > 0) {
      printAgentMessage(
        [
          "Recent sessions:",
          ...sessions.map((session) => `  ${formatSessionLine(session)}`),
          `Resume latest: aginti resume ${sessions[0].sessionId}`,
          "List all: aginti sessions list",
        ].join("\n")
      );
    } else {
      printAgentMessage("Restart: aginti");
    }
  }
}

function createState(args = {}) {
  return {
    provider: args.provider || "",
    model: args.model || "",
    routingMode: args.routingMode || "smart",
    commandCwd: args.commandCwd || process.cwd(),
    sandboxMode: normalizeSandboxMode(args.sandboxMode || "docker-workspace"),
    packageInstallPolicy: normalizePackageInstallPolicy(args.packageInstallPolicy || "allow"),
    allowShellTool: args.allowShellTool ?? true,
    allowFileTools: args.allowFileTools ?? true,
    allowAuxiliaryTools: args.allowAuxiliaryTools ?? true,
    allowWebSearch: args.allowWebSearch ?? true,
    allowParallelScouts: args.allowParallelScouts ?? true,
    parallelScoutCount: args.parallelScoutCount || 3,
    allowWrapperTools: args.allowWrapperTools ?? false,
    allowDestructive: args.allowDestructive ?? false,
    preferredWrapper: args.preferredWrapper || "codex",
    taskProfile: normalizeTaskProfile(args.taskProfile || "auto"),
    headless: args.headless ?? false,
    maxSteps:
      Number.isFinite(args.maxSteps) && args.maxSteps > 0
        ? args.maxSteps
        : defaultMaxStepsForProfile(args.taskProfile || (args.latex ? "latex" : "auto")),
    sessionId: args.resume || "",
  };
}

async function maybeOnboardDeepSeekKey(state) {
  if (!shouldPromptForDeepSeek(state, process.cwd())) return;

  printAgentMessage(
    [
      "DeepSeek API key is not configured for this project.",
      "Paste it once to save it in `.aginti/.env` with 0600 permissions, or press Enter to continue in mock mode.",
    ].join("\n")
  );
  const result = await promptAndSaveDeepSeekKey(process.cwd(), {
    promptText: "DeepSeek API key: ",
  });
  if (result.saved) {
    printAgentMessage(`Saved ${result.keyName} to project-local ignored env.`);
    return;
  }

  state.provider = "mock";
  state.routingMode = "manual";
  state.model = "mock-agent";
  printAgentMessage("No key saved. Continuing in local mock mode. Use `/provider deepseek` after running `aginti login deepseek`.");
}

async function promptAndSaveProviderKey(provider = "deepseek", state = null) {
  const aliases = { auxiliary: "grsai", auxilliary: "grsai", image: "grsai", imagegen: "grsai" };
  const candidate = aliases[String(provider || "").toLowerCase()] || String(provider || "").toLowerCase();
  const normalized = ["openai", "deepseek", "grsai"].includes(candidate)
    ? String(provider || "").toLowerCase()
    : "deepseek";
  const canonical = aliases[normalized] || normalized;
  const labelText = canonical === "openai" ? "OpenAI" : canonical === "grsai" ? "GRSAI" : "DeepSeek";
  const key = await promptHidden(`${labelText} API key/token (paste, Enter to save): `);
  if (!key) {
    printAgentMessage("No key saved.");
    return;
  }

  const result = await setProviderKey(process.cwd(), canonical, key);
  if (state) {
    if (canonical !== "grsai") state.provider = canonical;
    if (state.routingMode === "manual" && state.model === "mock-agent") {
      state.routingMode = "smart";
      state.model = "";
    }
    if (canonical === "grsai") state.allowAuxiliaryTools = true;
  }
  printAgentMessage(`Saved ${result.keyName} to project-local ignored env. Raw key was not printed.`);
}

async function handleCommand(line, state, packageDir) {
  const [command, ...rest] = line.slice(1).trim().split(/\s+/);
  const value = rest.join(" ").trim();

  if (!command || command === "help" || command === "?") {
    printHelp();
    return true;
  }
  if (command === "exit" || command === "quit" || command === "q") return false;
  if (command === "status") {
    printStatus(state);
    const keys = providerKeyStatus(process.cwd());
    printSystemLine(
      `keys deepseek=${keys.deepseek ? "available" : "missing"} openai=${keys.openai ? "available" : "missing"} grsai=${
        keys.grsai ? "available" : "missing"
      }`
    );
    return true;
  }
  if (command === "login" || command === "auth") {
    await promptAndSaveProviderKey(value || "deepseek", state);
    return true;
  }
  if (command === "instructions" || command === "memory") {
    if (value === "init") {
      const result = await initProject(process.cwd());
      printAgentMessage(`AGINTI.md ready at ${result.instructionsPath}`);
      return true;
    }
    const instructions = await readProjectInstructions(process.cwd(), { maxBytes: 4000 });
    if (!instructions.exists) {
      printAgentMessage("No AGINTI.md found. Run `/init` or `/instructions init` to create editable project instructions.");
      return true;
    }
    printAgentMessage(
      [
        `AGINTI.md: ${instructions.path}${instructions.truncated ? " (preview truncated)" : ""}`,
        "",
        instructions.content.trim() || "(empty)",
        "",
        "To edit it, ask normally: update AGINTI.md to remember that tests use pytest.",
      ].join("\n")
    );
    return true;
  }
  if (command === "auxilliary" || command === "auxiliary") {
    const action = value || "status";
    if (action === "status") {
      const keys = providerKeyStatus(process.cwd());
      printAgentMessage(
        [
          `Auxiliary tools: ${state.allowAuxiliaryTools ? "on" : "off"}`,
          `Image generation: ${keys.grsai ? "GRSAI key available" : "missing GRSAI key"}`,
          "Use `/auxilliary grsai` to paste the image key, `/auxilliary image` to switch to the image profile, or `/auxilliary off` to hide auxiliary tools.",
        ].join("\n")
      );
      return true;
    }
    if (action === "on") {
      state.allowAuxiliaryTools = true;
      printSystemLine("auxiliary=on");
      return true;
    }
    if (action === "off") {
      state.allowAuxiliaryTools = false;
      printSystemLine("auxiliary=off");
      return true;
    }
    if (action === "image") {
      state.allowAuxiliaryTools = true;
      state.taskProfile = "image";
      printSystemLine("auxiliary=on profile=image");
      return true;
    }
    if (["grsai", "login", "key", "token"].includes(action)) {
      await promptAndSaveProviderKey("grsai", state);
      return true;
    }
    printAgentMessage("Usage: /auxilliary [status|grsai|on|off|image]");
    return true;
  }
  if (command === "new") {
    state.sessionId = "";
    printAgentMessage("Next message will start a new session.");
    return true;
  }
  if (command === "resume") {
    if (!value || value === "latest") {
      const latest = await latestSession();
      if (!latest) {
        printAgentMessage("No project-local sessions found. Use /new or type a request to start one.");
      } else {
        state.sessionId = latest.sessionId;
        printAgentMessage(`Resuming latest ${formatSessionLine(latest)}`);
      }
    } else {
      state.sessionId = value;
      printAgentMessage(`Resuming ${state.sessionId}`);
    }
    return true;
  }
  if (command === "sessions") {
    const sessions = await listProjectSessions(process.cwd(), 20);
    if (sessions.length === 0) printAgentMessage("No project-local sessions found.");
    else {
      printAgentMessage(
        sessions
          .map((session) => {
            const goal = session.goal ? ` ${session.goal.slice(0, 80)}` : "";
            return `${session.sessionId} ${session.provider}/${session.model} ${session.updatedAt}${goal}`;
          })
          .join("\n")
      );
    }
    return true;
  }
  if (command === "profile") {
    state.taskProfile = normalizeTaskProfile(value || "auto");
    state.maxSteps = Math.max(state.maxSteps, defaultMaxStepsForProfile(state.taskProfile));
    printSystemLine(`profile=${state.taskProfile}`);
    return true;
  }
  if (command === "web-search") {
    state.allowWebSearch = value !== "off";
    printSystemLine(`webSearch=${state.allowWebSearch ? "on" : "off"}`);
    return true;
  }
  if (command === "scouts") {
    if (value === "off") {
      state.allowParallelScouts = false;
    } else {
      state.allowParallelScouts = true;
      const count = Number(value);
      if (Number.isFinite(count) && count > 0) state.parallelScoutCount = Math.min(Math.max(count, 1), 4);
    }
    printSystemLine(`parallelScouts=${state.allowParallelScouts ? "on" : "off"} count=${state.parallelScoutCount}`);
    return true;
  }
  if (command === "routing") {
    state.routingMode = value || "smart";
    printSystemLine(`routing=${state.routingMode}`);
    return true;
  }
  if (command === "provider") {
    state.provider = value === "auto" ? "" : value;
    printSystemLine(`provider=${state.provider || "auto"}`);
    return true;
  }
  if (command === "model") {
    state.model = value === "auto" ? "" : value;
    printSystemLine(`model=${state.model || "auto"}`);
    return true;
  }
  if (command === "installs") {
    state.packageInstallPolicy = normalizePackageInstallPolicy(value || "prompt");
    printSystemLine(`installs=${state.packageInstallPolicy}`);
    return true;
  }
  if (command === "docker") {
    if (value === "on") {
      state.sandboxMode = "docker-workspace";
      state.packageInstallPolicy = "allow";
      printSystemLine(`docker=on /workspace -> ${state.commandCwd || process.cwd()} installs=allow`);
    } else if (value === "off") {
      state.sandboxMode = "host";
      state.packageInstallPolicy = "prompt";
      printSystemLine("docker=off sandbox=host installs=prompt");
    } else {
      printAgentMessage("Usage: /docker on OR /docker off");
    }
    return true;
  }
  if (command === "latex") {
    if (value === "on" || value === "") {
      state.taskProfile = "latex";
      state.sandboxMode = "docker-workspace";
      state.packageInstallPolicy = "allow";
      state.maxSteps = Math.max(state.maxSteps, 30);
      printSystemLine("latex=on profile=latex sandbox=docker-workspace installs=allow maxSteps=30");
    } else if (value === "off") {
      state.taskProfile = "auto";
      printSystemLine("latex=off profile=auto");
    } else {
      printAgentMessage("Usage: /latex on OR /latex off");
    }
    return true;
  }
  if (command === "cwd") {
    state.commandCwd = value || process.cwd();
    printSystemLine(`cwd=${state.commandCwd}`);
    return true;
  }
  if (command === "init") {
    const result = await initProject(process.cwd());
    printAgentMessage(`initialized project=${result.projectRoot}\nAGINTI.md=${result.instructionsPath}`);
    return true;
  }
  if (command === "web") {
    const port = value || "3220";
    printAgentMessage(`Run in another terminal: aginti web --port ${port}`);
    return true;
  }

  const typed = `/${command}`;
  const suggestions = SLASH_COMMANDS.filter((candidate) => candidate.startsWith(typed));
  printAgentMessage(
    suggestions.length > 0
      ? `Unknown command: /${command}. Did you mean:\n${suggestions.map((item) => `  ${item}`).join("\n")}`
      : `Unknown command: /${command}. Use /help.`
  );
  return true;
}

async function runPrompt(prompt, state, packageDir) {
  const controller = new AbortController();
  const runMaxSteps = Math.max(
    state.maxSteps,
    recommendedMaxStepsForTask({
      goal: prompt,
      taskProfile: state.taskProfile,
    })
  );
  const config = loadConfig(
    {
      provider: state.provider,
      model: state.model,
      routingMode: state.routingMode,
      commandCwd: state.commandCwd,
      sandboxMode: state.sandboxMode,
      packageInstallPolicy: state.packageInstallPolicy,
      allowShellTool: state.allowShellTool,
      allowFileTools: state.allowFileTools,
      allowAuxiliaryTools: state.allowAuxiliaryTools,
      allowWebSearch: state.allowWebSearch,
      allowParallelScouts: state.allowParallelScouts,
      parallelScoutCount: state.parallelScoutCount,
      allowWrapperTools: state.allowWrapperTools,
      allowDestructive: state.allowDestructive,
      preferredWrapper: state.preferredWrapper,
      taskProfile: state.taskProfile,
      maxSteps: runMaxSteps,
      headless: state.headless,
      resume: state.sessionId,
      goal: prompt,
    },
    { packageDir, baseDir: process.cwd() }
  );

  state.sessionId = config.resume || config.sessionId || state.sessionId;
  state.status = "running";
  state.activeGoal = prompt.replace(/\s+/g, " ").slice(0, 120);
  state.lastEvent = "";
  printSystemLine(`session=${state.sessionId}`);
  printSystemLine(`status=running workingOn=${state.activeGoal}`);

  const detachInterrupts = attachRunInterrupts(controller);
  let result;
  try {
    result = await runAgent({
      ...config,
      abortSignal: controller.signal,
      onConsole: (text, options = {}) => {
        if (options.kind === "assistant") {
          printAgentMessage(text);
        } else if (options.kind === "plan") {
          printWrapped(`${label("plan", ansi.systemBg)} `, text);
        } else if (options.kind === "heading") {
          printHeading(text);
        } else if (options.error) {
          console.error(`${label("error", ansi.systemBg)} ${stripMarkdown(text)}`);
        } else {
          printSystemLine(text);
        }
      },
      onEvent: (type, data = {}) => {
        if (type === "plan.created") {
          printStatusEvent(state, "planned");
        } else if (type === "tool.started") {
          printStatusEvent(state, "tool", data.toolName || "unknown");
        } else if (type === "tool.completed") {
          printStatusEvent(state, "tool_done", data.toolName || "unknown");
        } else if (type === "tool.blocked") {
          printStatusEvent(state, "tool_blocked", data.toolName || data.reason || "unknown");
        } else if (type === "loop.guard") {
          printStatusEvent(state, "loop_guard", data.toolName || "");
        } else if (type === "conversation.queued_input_applied") {
          printStatusEvent(state, "queued_input_applied");
        } else if (type === "session.finished") {
          printStatusEvent(state, "finished");
        } else if (type === "session.stopped") {
          printStatusEvent(state, "stopped", data.reason || "");
        } else if (type === "model.responded") {
          printStatusEvent(state, "model_responded", data.content ? data.content.slice(0, 80).replace(/\s+/g, " ") : "");
        }
      },
    });
  } finally {
    detachInterrupts();
  }
  state.sessionId = result.sessionId || state.sessionId;
  state.status = result.stopped ? "stopped" : "idle";
  state.activeGoal = "";
  printSystemLine(`status=${state.status} session=${state.sessionId}`);
  if (result.stopped && result.reason === "user_interrupt") {
    await printResumeHint(state);
  }
}

export async function startInteractiveCli(args = {}, { packageDir, packageVersion } = {}) {
  const state = createState(args);
  const rl =
    input.isTTY && output.isTTY
      ? null
      : readline.createInterface({
          input,
          output,
          terminal: false,
          completer: commandCompleter,
        });

  await renderLaunchHeader(packageVersion);
  printSystemLine(`Project: ${process.cwd()}`);
  await maybeOnboardDeepSeekKey(state);
  printAgentMessage("Interactive agent chat. Type /help for commands, /exit to quit.");
  printStatus(state);

  try {
    while (true) {
      let answer = "";
      try {
        answer = await readPromptAnswer(rl);
      } catch (error) {
        if (error?.code === "ERR_USE_AFTER_CLOSE") break;
        if (isAbortError(error)) {
          await printResumeHint(state);
          break;
        }
        throw error;
      }
      const line = answer.trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const keepGoing = await handleCommand(line, state, packageDir);
        if (!keepGoing) break;
        continue;
      }

      try {
        await runPrompt(line, state, packageDir);
      } catch (error) {
        if (isAbortError(error)) {
          await printResumeHint(state);
          break;
        }
        console.error(`${label("error", ansi.systemBg)} ${error.message}`);
      }
    }
  } finally {
    rl?.close();
  }
}
