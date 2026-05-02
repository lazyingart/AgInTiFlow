import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { runAgent } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import { initProject, listProjectSessions, projectPaths, providerKeyStatus, readProjectInstructions } from "./project.js";
import { normalizePackageInstallPolicy, normalizeSandboxMode } from "./command-policy.js";
import { defaultMaxStepsForProfile, normalizeTaskProfile } from "./task-profiles.js";
import { recommendedMaxStepsForTask } from "./engineering-guidance.js";
import { normalizeAuthProvider, runAuthWizard, shouldPromptForDeepSeek } from "./auth-onboarding.js";
import { SessionStore } from "./session-store.js";
import { listSkills, selectSkillsForGoal } from "./skill-library.js";
import {
  AUXILIARY_MODEL_CATALOG,
  MODEL_PROVIDER_GROUPS,
  PROVIDER_MODEL_CATALOG,
  getModelRoleDefaults,
  modelsForProviderGroup,
} from "./model-routing.js";

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
  responseBg: "\x1b[48;5;25m\x1b[38;5;231m",
  statusBg: "\x1b[48;5;23m\x1b[38;5;231m",
  systemBg: "\x1b[48;5;236m\x1b[38;5;245m",
};
const brandPalette = ["\x1b[38;5;45m", "\x1b[38;5;81m", "\x1b[38;5;86m", "\x1b[38;5;118m", "\x1b[38;5;226m"];
const LARGE_LAUNCH_TITLE = [
  " █████╗  ██████╗ ██╗███╗   ██╗████████╗██╗    ███████╗██╗      ██████╗ ██╗    ██╗",
  "██╔══██╗██╔════╝ ██║████╗  ██║╚══██╔══╝██║    ██╔════╝██║     ██╔═══██╗██║    ██║",
  "███████║██║  ███╗██║██╔██╗ ██║   ██║   ██║    █████╗  ██║     ██║   ██║██║ █╗ ██║",
  "██╔══██║██║   ██║██║██║╚██╗██║   ██║   ██║    ██╔══╝  ██║     ██║   ██║██║███╗██║",
  "██║  ██║╚██████╔╝██║██║ ╚████║   ██║   ██║    ██║     ███████╗╚██████╔╝╚███╔███╔╝",
  "╚═╝  ╚═╝ ╚═════╝ ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝    ╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝ ",
];
const COMPACT_LAUNCH_TITLE = ["AgInTi Flow"];
const SLASH_COMMANDS = [
  "/help",
  "/status",
  "/login",
  "/auth",
  "/instructions",
  "/memory",
  "/auxiliary",
  "/new",
  "/resume",
  "/sessions",
  "/skills",
  "/skill",
  "/profile",
  "/web-search",
  "/scouts",
  "/models",
  "/venice",
  "/route",
  "/main",
  "/spare",
  "/wrapper",
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
let activeRunInput = null;

function color(value, ...codes) {
  if (!useColor || codes.length === 0) return String(value);
  return `${codes.join("")}${value}${ansi.reset}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ROLE_LABEL_WIDTH = "aginti".length;
const PROMPT_LABEL_WIDTH = "aginti>".length;

function labelText(name, { prompt = false } = {}) {
  const raw = String(name || "");
  const width = prompt || raw.endsWith(">") ? PROMPT_LABEL_WIDTH : ROLE_LABEL_WIDTH;
  return ` ${raw.padEnd(width, " ")} `;
}

function label(name, bgCode) {
  return color(labelText(name), bgCode, ansi.bold);
}

function outputLine(line = "") {
  if (activeRunInput) {
    activeRunInput.printLine(String(line));
    return;
  }
  console.log(line);
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
  if (SLASH_COMMANDS.includes(trimmed)) return [trimmed];
  return SLASH_COMMANDS.filter((command) => command.startsWith(trimmed)).slice(0, 8);
}

function renderSuggestionList(suggestions = [], selectedIndex = 0) {
  return suggestions
    .map((suggestion, index) => {
      const active = index === selectedIndex;
      if (!active) return suggestion;
      return useColor ? color(suggestion, ansi.userBg, ansi.bold) : `>${suggestion}`;
    })
    .join("  ");
}

function resolveSlashCommand(command = "") {
  const raw = String(command || "").trim();
  if (!raw) return raw;
  const slashCommand = `/${raw}`;
  if (SLASH_COMMANDS.includes(slashCommand)) return raw;
  const suggestion = SLASH_COMMANDS.find((candidate) => candidate.startsWith(slashCommand));
  return suggestion ? suggestion.slice(1) : raw;
}

export function canonicalSlashPromptBuffer(value = "") {
  const text = String(value || "");
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return text;
  const raw = trimmed.slice(1);
  const resolved = resolveSlashCommand(raw);
  return resolved === raw ? text : `/${resolved}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function compactLine(value = "", limit = 96) {
  const text = stripAnsi(String(value || "").replace(/\s+/g, " ").trim());
  return text.length <= limit ? text : `${text.slice(0, Math.max(limit - 1, 1))}…`;
}

function wrapTextLine(value = "", width = 72) {
  const text = stripAnsi(String(value || ""));
  if (text.length <= width) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > width) {
    let splitAt = remaining.lastIndexOf(" ", width);
    if (splitAt < Math.floor(width * 0.45)) splitAt = width;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function stripMarkdown(text) {
  const lines = String(text || "").split(/\r?\n/);
  let inFence = false;
  let diffContext = 0;
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

    if (/^\s*Diff:\s*$/i.test(line)) diffContext = 80;
    const patchLine = renderPatchLine(line, { active: diffContext > 0 || inFence });
    if (patchLine) {
      rendered.push(patchLine);
      diffContext = 80;
      continue;
    }
    if (diffContext > 0) diffContext -= 1;

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

function renderPatchLine(line = "", { active = false } = {}) {
  const value = String(line || "");
  if (/^diff --git\s+/.test(value)) return color(value, ansi.bold, ansi.cyan);
  if (/^@@\s+/.test(value)) return color(value, ansi.cyan);
  if (/^---\s+a\//.test(value)) return color(value, ansi.red);
  if (/^\+\+\+\s+b\//.test(value)) return color(value, ansi.green);
  if (active && /^\+(?!\+\+)/.test(value)) return color(value, ansi.green);
  if (active && /^-(?!--)/.test(value)) return color(value, ansi.red);
  return "";
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

function responsePrefix() {
  return `${color(" | ", ansi.responseBg)} `;
}

function printWrapped(prefix, text, { stripCode = "" } = {}) {
  const rendered = stripMarkdown(text);
  const lines = rendered.split("\n");
  const visible = stripAnsi(prefix).length;
  const gutter = `${" ".repeat(Math.max(visible - 2, 0))}${stripCode ? color("|", stripCode) : "|"} `;
  outputLine(`${prefix}${lines[0] || ""}`);
  for (const line of lines.slice(1)) {
    outputLine(`${gutter}${line}`);
  }
}

function printAgentMessage(text) {
  outputLine(label("aginti>", ansi.agentBg).trimEnd());
  const rendered = stripMarkdown(text);
  const lines = rendered.split("\n");
  for (const line of lines) outputLine(`${responsePrefix()}${line}`);
}

export function formatWorkspaceChange(change = {}) {
  const toolName = String(change.toolName || change.action || "change");
  const path = String(change.path || "");
  const summary = [
    toolName,
    path,
    change.created ? "created" : "",
    change.beforeHash ? `before=${String(change.beforeHash).slice(0, 8)}` : "before=new",
    change.afterHash ? `after=${String(change.afterHash).slice(0, 8)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const diff = String(change.diff || "").trim();
  const renderedDiff = diff ? stripMarkdown(`Diff:\n${diff}`).split("\n") : [];
  return {
    label: toolName === "apply_patch" || toolName.startsWith("apply_patch") ? "patch" : "write",
    summary,
    lines: renderedDiff,
  };
}

function printWorkspaceChange(change = {}) {
  if (!change?.diff) return;
  const formatted = formatWorkspaceChange(change);
  const bg = formatted.label === "patch" ? ansi.magenta : ansi.systemBg;
  outputLine(`${label(formatted.label, bg)} ${compactLine(formatted.summary, 92)}`);
  const gutter = `${color(" | ", bg)} `;
  for (const line of formatted.lines) outputLine(`${gutter}${line}`);
}

function printPreviewBlock(role, text, { time = "", bg = ansi.systemBg, maxLines = 5 } = {}) {
  const header = [label(role, bg).trimEnd(), time ? color(time, ansi.dim) : ""].filter(Boolean).join(" ");
  outputLine(header);
  const width = Math.max(terminalWidth() - 8, 38);
  const rendered = stripMarkdown(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line.trim() || (index > 0 && index < all.length - 1));
  const wrapped = rendered.flatMap((line) => wrapTextLine(line || " ", width)).slice(0, maxLines);
  const truncated = rendered.flatMap((line) => wrapTextLine(line || " ", width)).length > maxLines;
  for (const [index, line] of (wrapped.length ? wrapped : ["(empty)"]).entries()) {
    const suffix = truncated && index === wrapped.length - 1 ? " …" : "";
    outputLine(`${color(" | ", bg)} ${line}${suffix}`);
  }
}

function printHistoryBlock(role, text, { time = "", bg = ansi.systemBg } = {}) {
  const header = [label(role, bg).trimEnd(), time ? color(time, ansi.dim) : ""].filter(Boolean).join(" ");
  outputLine(header);
  const width = Math.max(terminalWidth() - 8, 38);
  const rendered = stripMarkdown(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const lines = rendered.length ? rendered : ["(empty)"];
  for (const line of lines) {
    const wrapped = wrapTextLine(line || " ", width);
    for (const wrappedLine of wrapped) outputLine(`${color(" | ", bg)} ${wrappedLine}`);
  }
}

function printSystemLine(text) {
  if (!String(text || "").trim()) {
    outputLine("");
    return;
  }
  outputLine(`${label("state", ansi.systemBg)} ${color(text, ansi.dim)}`);
}

function outputStats(value = "") {
  const text = String(value || "");
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    lines: text ? text.split(/\r?\n/).length : 0,
  };
}

function outputPreview(value = "", maxLines = 12) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .filter((line, index, all) => line.trim() || index < all.length - 1);
  const shown = lines.slice(0, maxLines);
  const hidden = Math.max(lines.length - shown.length, 0);
  return { shown, hidden, total: lines.length };
}

function printCommandOutputLog(data = {}) {
  const command = String(data.command || "").trim();
  const stdout = String(data.stdout || "");
  const stderr = String(data.stderr || "");
  const isGit = /^git\b/.test(command);
  const failed = Boolean(data.error || stderr || data.blocked);
  if (!isGit && !failed) return;

  const stdoutStats = outputStats(stdout);
  const stderrStats = outputStats(stderr);
  const policy = data.commandPolicy?.category ? ` ${data.commandPolicy.category}` : "";
  outputLine(
    `${label("shell", ansi.systemBg)} ${compactLine(command || "(command)", 86)}${policy} stdout=${stdoutStats.lines} stderr=${stderrStats.lines}`
  );

  for (const [name, value] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    if (!value) continue;
    const preview = outputPreview(value, 12);
    outputLine(`${color(" | ", ansi.systemBg)} ${name}`);
    for (const line of preview.shown) outputLine(`${color(" | ", ansi.systemBg)} ${line}`);
    if (preview.hidden > 0) outputLine(`${color(" | ", ansi.systemBg)} ... ${preview.hidden} more line(s) folded`);
  }
}

function printHeading(text) {
  outputLine(color(stripMarkdown(text), ansi.bold, ansi.cyan));
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

function centerLine(value, width) {
  const text = String(value || "");
  return `${" ".repeat(Math.max(Math.floor((width - visualLength(text)) / 2), 0))}${text}`;
}

function launchTitleLines(contentWidth) {
  const largeWidth = Math.max(...LARGE_LAUNCH_TITLE.map((line) => visualLength(line)));
  return largeWidth <= contentWidth ? LARGE_LAUNCH_TITLE : COMPACT_LAUNCH_TITLE;
}

export function buildLaunchHeaderLines({ packageVersion = "", frame = 2, width = terminalWidth(), animated = true } = {}) {
  const subtitle = "web-first agent workspace";
  const tagline = "browser + shell + files + docker + web search + scouts";
  const version = packageVersion ? `v${packageVersion}` : "";
  const terminalColumns = Math.max(Number(width) || 80, 50);
  const contentWidth = Math.min(Math.max(terminalColumns - 8, 58), 112);
  const titleLines = launchTitleLines(contentWidth).map((line, index) => centerLine(animated ? shimmerText(line, frame + index) : line, contentWidth));
  const borderWidth = contentWidth + 2;
  const border = "\x1b[38;5;45m";
  const top = color(`╭${"─".repeat(borderWidth)}╮`, border);
  const mid = color(`├${"─".repeat(borderWidth)}┤`, border);
  const bottom = color(`╰${"─".repeat(borderWidth)}╯`, border);
  const row = (content = "", code = "") => `${color("│", border)} ${code ? color(padVisible(content, contentWidth), code) : padVisible(content, contentWidth)} ${color("│", border)}`;
  const versionLine = version ? centerLine(color(version, ansi.dim), contentWidth) : "";
  const boxLines = [
    top,
    ...titleLines.map((line) => row(line)),
    versionLine ? row(versionLine) : "",
    row(centerLine(subtitle, contentWidth), ansi.dim),
    mid,
    row(centerLine(tagline, contentWidth), ansi.cyan),
    bottom,
  ].filter(Boolean);
  const indent = " ".repeat(Math.max(Math.floor((terminalColumns - Math.max(...boxLines.map((line) => visualLength(line)))) / 2), 0));
  return boxLines.map((line) => `${indent}${line}`);
}

async function renderLaunchHeader(packageVersion = "") {
  if (!useColor || process.env.AGINTIFLOW_NO_ANIMATION === "1") {
    console.log(buildLaunchHeaderLines({ packageVersion, animated: false }).join("\n"));
    return;
  }

  const topPadding = Math.min(Math.max(Math.floor((terminalHeight() - 28) / 8), 0), 2);
  const paddingLines = Array.from({ length: topPadding }, () => "");
  let previousLineCount = 0;
  output.write(ansi.cursorHide);
  for (let frame = 0; frame < 18; frame += 1) {
    const lines = [...paddingLines, ...buildLaunchHeaderLines({ packageVersion, frame, animated: true })];
    if (previousLineCount > 0) output.write(`\x1b[${previousLineCount}A`);
    output.write(lines.map((line) => `\r${ansi.clearLine}${line}`).join("\n"));
    output.write("\n");
    previousLineCount = lines.length;
    await sleep(32);
  }
  output.write(ansi.cursorShow);
}

function printHelp() {
  printAgentMessage(
    [
      "Commands:",
      "  /help                     Show this help.",
      "  /status                   Show active route, workspace, sandbox, and session.",
      "  /login [deepseek|openai|qwen|venice|grsai]  Pick, paste, and save project-local API keys.",
      "  /auth [deepseek|openai|qwen|venice|grsai]   Alias for /login.",
      "  /instructions             Show AGINTI.md project instructions status.",
      "  /memory                   Alias for /instructions.",
      "  /models                   Show route/main/spare/wrapper/auxiliary model roles.",
      "  /venice [off|model]       Pick Venice route/main models, or restore DeepSeek defaults.",
      "  /route [mode|provider/model]",
      "                            Open route selector, or set routing/fast route model.",
      "  /model [provider/model]   Open main-model selector, or set the active/main model.",
      "  /spare [provider/model] [reasoning]",
      "                            Open spare selector, or set e.g. /spare openai/gpt-5.4 medium.",
      "  /wrapper [on|off|codex model reasoning]",
      "                            Configure optional external wrapper.",
      "  /auxiliary [status|grsai|venice|model [provider/model]|on|off|image]",
      "                            Manage optional auxiliary skills, including image generation.",
      "  /new                      Start a fresh session on the next message.",
      "  /resume <session-id>      Continue a saved session.",
      "  /sessions                 List recent sessions in this project.",
      "  /skills [query]           List Markdown skills selected for a topic.",
      "  /profile <name>           Set task profile, e.g. code, website, latex, maintenance.",
      "  /web-search on|off        Enable or disable the web_search tool.",
      "  /scouts on|off|<1-10>     Enable parallel DeepSeek scouts and set scout count.",
      "  /routing <mode>           Set routing: smart, fast, complex, manual.",
      "  /provider [name]          Open provider selector, or set deepseek/openai/qwen/venice/mock.",
      "  /docker on                Use docker-workspace with approved package installs.",
      "  /docker off               Use host shell policy.",
      "  /latex on                 Use the LaTeX/PDF profile in Docker with a larger step budget.",
      "  /installs block|prompt|allow",
      "  /cwd <path>               Change command workspace.",
      "  /exit                     Quit.",
      "",
      "Type a normal request to run the agent. Example: write a Python CLI app with tests",
      "Type / then Tab to autocomplete commands.",
      "While a run is active, Enter pipes a message into the current run (→), Tab queues it after finish (↳).",
      "Alt+Up edits the last piped message; Shift+Left edits the last queued message.",
      "Esc is ignored while idle. During a run, Esc waits for pending → pipe messages or stops if none; Ctrl+C always stops.",
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

export function buildPromptLayout(buffer = "", cursor = 0, width = terminalWidth(), height = terminalHeight(), options = {}) {
  const safeBuffer = String(buffer || "");
  const safeCursor = clamp(Number(cursor) || 0, 0, safeBuffer.length);
  const lineWidth = editorWidth(width);
  const firstPrefix = labelText("user>", { prompt: true });
  const nextPrefix = labelText("...", { prompt: true });
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

  const suggestions = Array.isArray(options.suggestions)
    ? options.suggestions
    : commandSuggestions(safeBuffer.split("\n")[0] || "");
  const suggestionIndex = clamp(Number(options.suggestionIndex) || 0, 0, Math.max(suggestions.length - 1, 0));
  const emptyHint = "type a request, /help, Enter to send, Ctrl+J for newline";
  const visible = promptVisibleWindow(rows, cursorRow, height);
  const renderedRows = [];
  let renderedCursorRow = cursorRow - visible.start;
  const useInputPadding = options.inputPadding !== false && height >= 10;

  if (options.statusLine) {
    renderedRows.push(panelLine(`${labelText("run", { prompt: true })}${compactLine(options.statusLine, lineWidth - 10)}`, ansi.statusBg, lineWidth));
    renderedCursorRow += 1;
  }

  const pendingAsap = Array.isArray(options.pendingAsap) ? options.pendingAsap : [];
  const pendingQueued = Array.isArray(options.pendingQueued) ? options.pendingQueued : [];
  for (const item of pendingAsap.slice(-4)) {
    renderedRows.push(panelLine(`  → ${compactLine(item.content || item, lineWidth - 6)}`, ansi.systemBg, lineWidth));
    renderedCursorRow += 1;
  }
  for (const item of pendingQueued.slice(-4)) {
    renderedRows.push(panelLine(`  ↳ ${compactLine(item.content || item, lineWidth - 6)}`, ansi.systemBg, lineWidth));
    renderedCursorRow += 1;
  }

  if (visible.topHidden > 0) {
    renderedRows.push(panelLine(`  ... ${visible.topHidden} earlier input row${visible.topHidden === 1 ? "" : "s"}`, ansi.systemBg, lineWidth));
    renderedCursorRow += 1;
  }

  if (useInputPadding) {
    renderedRows.push(panelLine("", ansi.userBg, lineWidth));
    renderedCursorRow += 1;
  }

  for (const row of rows.slice(visible.start, visible.end)) {
    const content = safeBuffer ? `${row.prefix}${row.text}` : `${row.prefix}${emptyHint}`;
    renderedRows.push(panelLine(content, ansi.userBg, lineWidth));
  }

  if (useInputPadding) {
    renderedRows.push(panelLine("", ansi.userBg, lineWidth));
  }

  if (visible.bottomHidden > 0) {
    renderedRows.push(panelLine(`  ... ${visible.bottomHidden} later input row${visible.bottomHidden === 1 ? "" : "s"}`, ansi.systemBg, lineWidth));
  }

  if (suggestions.length > 0) {
    renderedRows.push(panelLine(`${labelText("hint", { prompt: true })}${renderSuggestionList(suggestions, suggestionIndex)}`, ansi.systemBg, lineWidth));
  }
  if (options.commandCwd) {
    renderedRows.push(panelLine(`${labelText("cwd", { prompt: true })}${options.commandCwd}`, ansi.systemBg, lineWidth));
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
  let sequence = ansi.cursorHide;
  const below = previous.lineCount - 1 - previous.cursorRow;
  if (below > 0) sequence += `\x1b[${below}B`;
  sequence += `\r${ansi.clearLine}`;
  for (let index = 1; index < previous.lineCount; index += 1) {
    sequence += `\x1b[1A\r${ansi.clearLine}`;
  }
  sequence += ansi.cursorShow;
  output.write(sequence);
}

function renderedRowsEqual(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

export function buildPromptRenderSequence(layout, previous = { lineCount: 0, cursorRow: 0, renderedRows: [] }) {
  const previousRows = Array.isArray(previous.renderedRows) ? previous.renderedRows : [];
  const previousLineCount = Number(previous.lineCount) || 0;
  const previousCursorRow = Number(previous.cursorRow) || 0;
  const nextRows = layout.renderedRows || [];

  if (previousLineCount > 0 && renderedRowsEqual(previousRows, nextRows)) {
    const rowDelta = layout.cursorRow - previousCursorRow;
    return `${rowDelta > 0 ? `\x1b[${rowDelta}B` : rowDelta < 0 ? `\x1b[${Math.abs(rowDelta)}A` : ""}\r\x1b[${
      layout.cursorColumn + 1
    }G`;
  }

  let sequence = ansi.cursorHide;
  if (previousLineCount > 0) {
    const below = Math.max(previousLineCount - 1 - previousCursorRow, 0);
    if (below > 0) sequence += `\x1b[${below}B`;
    sequence += "\r";
    if (previousLineCount > 1) sequence += `\x1b[${previousLineCount - 1}A`;
  }

  const lineCount = Math.max(previousLineCount, nextRows.length);
  for (let index = 0; index < lineCount; index += 1) {
    sequence += `\r${ansi.clearLine}${nextRows[index] || ""}`;
    if (index < lineCount - 1) sequence += "\n";
  }

  const cursorUp = Math.max(lineCount - 1 - layout.cursorRow, 0);
  if (cursorUp > 0) sequence += `\x1b[${cursorUp}A`;
  sequence += `\r\x1b[${layout.cursorColumn + 1}G${ansi.cursorShow}`;
  return sequence;
}

function renderPromptBuffer(buffer, cursor, previous = { lineCount: 0, cursorRow: 0, renderedRows: [] }, options = {}) {
  const layout = buildPromptLayout(buffer, cursor, terminalWidth(), terminalHeight(), options);
  output.write(buildPromptRenderSequence(layout, previous));
  return {
    lineCount: layout.renderedRows.length,
    cursorRow: layout.cursorRow,
    renderedRows: layout.renderedRows,
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

export function classifyEscapeAction({ active = false, pendingAsap = [] } = {}) {
  if (!active) return "noop";
  return Array.isArray(pendingAsap) && pendingAsap.length > 0 ? "wait-for-asap" : "abort";
}

function readTtyPrompt(options = {}) {
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
    let suggestionAnchor = "";
    let suggestionIndex = 0;

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
      const suggestions = commandSuggestions(suggestionAnchor || buffer.split("\n")[0] || "");
      rendered = renderPromptBuffer(buffer, cursor, rendered, {
        ...options,
        suggestions,
        suggestionIndex,
      });
    };

    const redraw = () => {
      if (redrawHandle) return;
      redrawHandle = setImmediate(() => {
        redrawHandle = null;
        renderNow();
      });
    };

    const submit = () => {
      const canonical = canonicalSlashPromptBuffer(buffer);
      if (canonical !== buffer) {
        buffer = canonical;
        cursor = buffer.length;
      }
      renderNow();
      moveToPromptBottom(rendered);
      cleanup();
      output.write("\n");
      const saved = buffer.trim();
      if (saved && promptHistory[promptHistory.length - 1] !== buffer) promptHistory.push(buffer);
      resolve(buffer);
    };

    const setBuffer = (nextBuffer, nextCursor = nextBuffer.length, { keepSuggestionAnchor = false } = {}) => {
      buffer = nextBuffer;
      cursor = clamp(nextCursor, 0, buffer.length);
      preferredColumn = null;
      if (!keepSuggestionAnchor) {
        suggestionAnchor = "";
        suggestionIndex = 0;
      }
      redraw();
    };

    const cycleSuggestion = (delta) => {
      const firstLine = buffer.split("\n")[0] || "";
      if (!suggestionAnchor) suggestionAnchor = firstLine;
      const suggestions = commandSuggestions(suggestionAnchor);
      if (suggestions.length === 0) {
        suggestionAnchor = "";
        suggestionIndex = 0;
        return false;
      }
      suggestionIndex = (suggestionIndex + delta + suggestions.length) % suggestions.length;
      setBuffer(suggestions[suggestionIndex], suggestions[suggestionIndex].length, { keepSuggestionAnchor: true });
      return true;
    };

    const suggestionModeActive = () => commandSuggestions(suggestionAnchor || buffer.split("\n")[0] || "").length > 1;

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
        suggestionAnchor = "";
        suggestionIndex = 0;
        redraw();
        return;
      }
      if (key.name === "delete") {
        ({ buffer, cursor } = removeAt(buffer, cursor));
        preferredColumn = null;
        suggestionAnchor = "";
        suggestionIndex = 0;
        redraw();
        return;
      }
      if (key.name === "left") {
        if (suggestionModeActive() && cycleSuggestion(-1)) return;
        cursor = Math.max(cursor - 1, 0);
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.name === "right") {
        if (suggestionModeActive() && cycleSuggestion(1)) return;
        cursor = Math.min(cursor + 1, buffer.length);
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.name === "up") {
        if (suggestionModeActive() && cycleSuggestion(-1)) return;
        moveVertical(-1);
        return;
      }
      if (key.name === "down") {
        if (suggestionModeActive() && cycleSuggestion(1)) return;
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
        const suggestions = commandSuggestions(suggestionAnchor || buffer.split("\n")[0] || "");
        if (suggestions.length > 0) {
          buffer = suggestions[clamp(suggestionIndex, 0, suggestions.length - 1)];
          cursor = buffer.length;
          suggestionAnchor = "";
          suggestionIndex = 0;
        }
        preferredColumn = null;
        redraw();
        return;
      }
      if (key.name === "escape") {
        if (classifyEscapeAction({ active: false }) === "noop") return;
        return;
      }
      if (key.ctrl || key.meta) return;
      if (str && !key.sequence?.startsWith("\x1b")) {
        const text = str.replace(/\r/g, "");
        ({ buffer, cursor } = insertAt(buffer, cursor, text));
        preferredColumn = null;
        suggestionAnchor = "";
        suggestionIndex = 0;
        redraw();
      }
    };

    input.resume();
    input.setRawMode(true);
    input.on("keypress", handler);
    renderNow();
  });
}

async function readPromptAnswer(rl, state = {}) {
  if (input.isTTY && output.isTTY && typeof input.setRawMode === "function") {
    return readTtyPrompt({ commandCwd: state.commandCwd || process.cwd() });
  }
  return rl.question(userPrompt());
}

class LiveRunInput {
  constructor({ state, store, controller }) {
    this.state = state;
    this.store = store;
    this.controller = controller;
    this.buffer = "";
    this.cursor = 0;
    this.rendered = { lineCount: 0, cursorRow: 0, renderedRows: [] };
    this.redrawHandle = null;
    this.preferredColumn = null;
    this.pendingAsap = [];
    this.pendingQueued = [];
    this.statusLine = "";
    this.wasRaw = Boolean(input.isRaw);
    this.started = false;
    this.handler = this.handleKey.bind(this);
  }

  get commandCwd() {
    return this.state.commandCwd || process.cwd();
  }

  start() {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return false;
    emitKeypressEvents(input);
    input.resume();
    input.setRawMode(true);
    input.on("keypress", this.handler);
    activeRunInput = this;
    this.started = true;
    this.renderNow();
    return true;
  }

  async stop() {
    if (!this.started) return [];
    if (this.redrawHandle) {
      clearImmediate(this.redrawHandle);
      this.redrawHandle = null;
    }
    input.off("keypress", this.handler);
    if (typeof input.setRawMode === "function") input.setRawMode(this.wasRaw);
    this.clearForExternalOutput();
    output.write(ansi.cursorShow);
    if (activeRunInput === this) activeRunInput = null;
    this.started = false;

    const unappliedAsap = [...this.pendingAsap];
    if (unappliedAsap.length > 0) {
      await this.removeInboxItems(unappliedAsap.map((item) => item.id));
    }
    return [
      ...unappliedAsap.map((item) => ({ ...item, kind: "asap" })),
      ...this.pendingQueued.map((item) => ({ ...item, kind: "queued" })),
    ];
  }

  printLine(line = "") {
    this.clearForExternalOutput();
    output.write(`${line}\n`);
    this.renderNow();
  }

  clearForExternalOutput() {
    if (!this.rendered.lineCount) return;
    output.write(ansi.cursorHide);
    clearRenderedPrompt(this.rendered);
    this.rendered = { lineCount: 0, cursorRow: 0, renderedRows: [] };
    output.write(ansi.cursorShow);
  }

  renderNow() {
    if (this.redrawHandle) {
      clearImmediate(this.redrawHandle);
      this.redrawHandle = null;
    }
    this.rendered = renderPromptBuffer(this.buffer, this.cursor, this.rendered, {
      commandCwd: this.commandCwd,
      statusLine: this.statusLine,
      pendingAsap: this.pendingAsap,
      pendingQueued: this.pendingQueued,
    });
  }

  redraw() {
    if (this.redrawHandle) return;
    this.redrawHandle = setImmediate(() => {
      this.redrawHandle = null;
      this.renderNow();
    });
  }

  setBuffer(nextBuffer, nextCursor = nextBuffer.length) {
    this.buffer = String(nextBuffer || "");
    this.cursor = clamp(nextCursor, 0, this.buffer.length);
    this.preferredColumn = null;
    this.redraw();
  }

  setStatus(value = "") {
    const nextStatus = compactLine(value, Math.max(terminalWidth() - 16, 36));
    if (this.statusLine === nextStatus) return;
    this.statusLine = nextStatus;
    this.redraw();
  }

  moveVertical(direction) {
    const layout = buildPromptLayout(this.buffer, this.cursor, terminalWidth(), terminalHeight(), {
      commandCwd: this.commandCwd,
      statusLine: this.statusLine,
      pendingAsap: this.pendingAsap,
      pendingQueued: this.pendingQueued,
    });
    const location = cursorLocation(layout, this.cursor);
    const targetRowIndex = location.rowIndex + direction;
    if (targetRowIndex < 0 || targetRowIndex >= layout.rows.length) return;
    const currentColumn = this.preferredColumn ?? location.column;
    const targetRow = layout.rows[targetRowIndex];
    this.cursor = targetRow.start + Math.min(currentColumn, targetRow.end - targetRow.start);
    this.preferredColumn = currentColumn;
    this.redraw();
  }

  async removeInboxItems(ids = []) {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const inbox = await this.store.loadInbox().catch(() => []);
    await this.store.saveInbox(inbox.filter((item) => !idSet.has(item.id))).catch(() => {});
  }

  async submitAsap() {
    const content = this.buffer.trim();
    if (!content) return;
    if (content.startsWith("/")) {
      this.printLine(`${label("warn", ansi.red)} Slash commands are disabled while a run is active. Press Esc/Ctrl+C to stop, or wait until idle.`);
      this.setStatus(`running · command ${compactLine(content, 24)} not accepted during active run`);
      return;
    }
    const item = {
      id: `cli-asap-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      content,
      priority: "asap",
      source: "cli-live",
    };
    this.pendingAsap.push(item);
    this.setBuffer("");
    await this.store.appendInbox(content, item).catch((error) => {
      this.pendingAsap = this.pendingAsap.filter((pending) => pending.id !== item.id);
      this.printLine(`${label("error", ansi.systemBg)} failed to pipe message: ${error.message}`);
    });
    await this.store.appendEvent("conversation.piped_input", {
      id: item.id,
      prompt: content,
      source: item.source,
      priority: item.priority,
    }).catch(() => {});
    this.redraw();
  }

  queueAfterFinish() {
    const content = this.buffer.trim();
    if (!content) return;
    if (content.startsWith("/")) {
      this.printLine(`${label("warn", ansi.red)} Slash commands cannot be queued during a run. Wait until idle, then run ${content}.`);
      this.setStatus(`running · command ${compactLine(content, 24)} not queued`);
      return;
    }
    this.pendingQueued.push({
      id: `cli-queued-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      content,
      priority: "after-finish",
      source: "cli-live",
    });
    this.setBuffer("");
  }

  editLastQueued() {
    const item = this.pendingQueued.pop();
    if (!item) return;
    this.setBuffer(item.content);
  }

  editLastAsap() {
    const item = this.pendingAsap.pop();
    if (!item) return;
    void this.removeInboxItems([item.id]);
    this.setBuffer(item.content);
  }

  markApplied(data = {}) {
    const id = data.id || "";
    const prompt = String(data.prompt || "");
    if (id) {
      this.pendingAsap = this.pendingAsap.filter((item) => item.id !== id);
    } else if (prompt) {
      const index = this.pendingAsap.findIndex((item) => item.content === prompt);
      if (index >= 0) this.pendingAsap.splice(index, 1);
    }
    this.redraw();
  }

  handleKey(str = "", key = {}) {
    if (key.ctrl && key.name === "c") {
      this.controller.abort(new Error("Interrupted by ctrl-c."));
      return;
    }
    if (key.name === "escape") {
      const action = classifyEscapeAction({ active: true, pendingAsap: this.pendingAsap });
      if (action === "wait-for-asap") {
        const count = this.pendingAsap.length;
        this.setStatus(`running · waiting to apply ${count} asap pipe message${count === 1 ? "" : "s"}`);
        this.redraw();
        return;
      }
      this.controller.abort(new Error("Interrupted by escape."));
      return;
    }
    if (key.meta && key.name === "up") {
      this.editLastAsap();
      return;
    }
    if ((key.shift && key.name === "left") || key.sequence === "\x1b[1;2D") {
      this.editLastQueued();
      return;
    }
    if ((key.ctrl && key.name === "j") || key.sequence === "\n") {
      ({ buffer: this.buffer, cursor: this.cursor } = insertAt(this.buffer, this.cursor, "\n"));
      this.preferredColumn = null;
      this.redraw();
      return;
    }
    if (key.name === "return" || key.name === "enter" || key.sequence === "\r" || str === "\r") {
      void this.submitAsap();
      return;
    }
    if (key.name === "tab") {
      this.queueAfterFinish();
      return;
    }
    if (key.name === "backspace") {
      ({ buffer: this.buffer, cursor: this.cursor } = removeBefore(this.buffer, this.cursor));
      this.preferredColumn = null;
      this.redraw();
      return;
    }
    if (key.name === "delete") {
      ({ buffer: this.buffer, cursor: this.cursor } = removeAt(this.buffer, this.cursor));
      this.preferredColumn = null;
      this.redraw();
      return;
    }
    if (key.name === "left") {
      this.cursor = Math.max(this.cursor - 1, 0);
      this.preferredColumn = null;
      this.redraw();
      return;
    }
    if (key.name === "right") {
      this.cursor = Math.min(this.cursor + 1, this.buffer.length);
      this.preferredColumn = null;
      this.redraw();
      return;
    }
    if (key.name === "up") {
      this.moveVertical(-1);
      return;
    }
    if (key.name === "down") {
      this.moveVertical(1);
      return;
    }
    if ((key.ctrl && key.name === "a") || key.name === "home") {
      this.cursor = lineBounds(this.buffer, this.cursor).start;
      this.preferredColumn = null;
      this.redraw();
      return;
    }
    if ((key.ctrl && key.name === "e") || key.name === "end") {
      this.cursor = lineBounds(this.buffer, this.cursor).end;
      this.preferredColumn = null;
      this.redraw();
      return;
    }
    if (key.ctrl && key.name === "u") {
      const bounds = lineBounds(this.buffer, this.cursor);
      this.buffer = `${this.buffer.slice(0, bounds.start)}${this.buffer.slice(this.cursor)}`;
      this.cursor = bounds.start;
      this.preferredColumn = null;
      this.redraw();
      return;
    }
    if (key.ctrl && key.name === "k") {
      const bounds = lineBounds(this.buffer, this.cursor);
      this.buffer = `${this.buffer.slice(0, this.cursor)}${this.buffer.slice(bounds.end)}`;
      this.preferredColumn = null;
      this.redraw();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (str && !key.sequence?.startsWith("\x1b")) {
      const text = str.replace(/\r/g, "");
      ({ buffer: this.buffer, cursor: this.cursor } = insertAt(this.buffer, this.cursor, text));
      this.preferredColumn = null;
      this.redraw();
    }
  }
}

function printStatus(state) {
  printSystemLine(`project=${process.cwd()}`);
  printSystemLine(`cwd=${state.commandCwd || process.cwd()}`);
  printSystemLine(`session=${state.sessionId || "new"}`);
  printSystemLine(`status=${state.status || "idle"}${state.activeGoal ? ` workingOn=${state.activeGoal}` : ""}`);
  if (state.lastEvent) printSystemLine(`last=${state.lastEvent}`);
  printSystemLine(`provider=${state.provider || "auto"} routing=${state.routingMode} model=${state.model || "auto"}`);
  printSystemLine(
    `roles route=${state.routeProvider || "deepseek"}/${state.routeModel || "deepseek-v4-flash"} main=${
      state.mainProvider || "deepseek"
    }/${state.mainModel || "deepseek-v4-pro"} spare=${state.spareProvider || "openai"}/${state.spareModel || "gpt-5.4"}`
  );
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

function printHistoryEntry(entry) {
  const role = entry.role === "assistant" ? "aginti" : entry.role === "user" ? "user" : String(entry.role || "note");
  const bg = role === "aginti" ? ansi.agentBg : role === "user" ? ansi.userBg : ansi.systemBg;
  const time = entry.at ? new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  printHistoryBlock(role, entry.content, { time, bg });
}

async function printResumeHistory(state, { limit = 0 } = {}) {
  if (!state.sessionId) return;
  const store = new SessionStore(projectPaths(process.cwd()).sessionsDir, state.sessionId);
  const saved = await store.loadState().catch(() => null);
  const chat = Array.isArray(saved?.chat) ? saved.chat.filter((entry) => entry?.content) : [];
  if (chat.length === 0) {
    printSystemLine(`resume history session=${state.sessionId} messages=0`);
    return;
  }

  const shown = limit > 0 ? chat.slice(-limit) : chat;
  printSystemLine(
    `resume history session=${state.sessionId} messages=${chat.length}${limit > 0 ? ` showing=${shown.length}/${chat.length}` : ""}`
  );
  for (const entry of shown) printHistoryEntry(entry);
}

function printStatusEvent(state, label, details = "") {
  const safeDetails = compactLine(details, 72);
  state.lastEvent = safeDetails ? `${label}: ${safeDetails}` : label;
  const statusText = `${state.status || "running"} · ${state.lastEvent}`;
  if (activeRunInput) {
    activeRunInput.setStatus(statusText);
    return;
  }
  printSystemLine(`status=${statusText}`);
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
    routeProvider: args.routeProvider || "",
    routeModel: args.routeModel || "",
    mainProvider: args.mainProvider || "",
    mainModel: args.mainModel || "",
    spareProvider: args.spareProvider || "openai",
    spareModel: args.spareModel || "gpt-5.4",
    spareReasoning: args.spareReasoning || "medium",
    wrapperModel: args.wrapperModel || "gpt-5.5",
    wrapperReasoning: args.wrapperReasoning || "medium",
    auxiliaryProvider: args.auxiliaryProvider || "grsai",
    auxiliaryModel: args.auxiliaryModel || "nano-banana-2",
    taskProfile: normalizeTaskProfile(args.taskProfile || "auto"),
    headless: args.headless ?? false,
    maxSteps:
      Number.isFinite(args.maxSteps) && args.maxSteps > 0
        ? args.maxSteps
        : defaultMaxStepsForProfile(args.taskProfile || (args.latex ? "latex" : "auto")),
    sessionId: args.resume || "",
  };
}

function parseProviderModel(value, fallbackProvider = "") {
  const text = String(value || "").trim();
  if (!text) return { provider: fallbackProvider, model: "" };
  if (text.includes("/")) {
    const [provider, ...modelParts] = text.split("/");
    return {
      provider: provider.trim() || fallbackProvider,
      model: modelParts.join("/").trim(),
    };
  }
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && ["deepseek", "openai", "qwen", "venice", "mock", "grsai", "venice-image"].includes(parts[0])) {
    return { provider: parts[0], model: parts.slice(1).join(" ") };
  }
  return { provider: fallbackProvider, model: text };
}

function useDeepSeekDefaults(state) {
  state.routingMode = "smart";
  state.provider = "deepseek";
  state.model = "";
  state.routeProvider = "deepseek";
  state.routeModel = "deepseek-v4-flash";
  state.mainProvider = "deepseek";
  state.mainModel = "deepseek-v4-pro";
}

function veniceTextModelChoices() {
  return [
    {
      provider: "venice",
      model: "venice-uncensored-1-2",
      label: "Venice 1.2",
      description: "default Venice text model; 128K context",
    },
    {
      provider: "venice",
      model: "venice-uncensored",
      label: "Venice 1.1",
      description: "legacy Venice text model; 32K context",
    },
    {
      provider: "venice",
      model: "gemma-4-uncensored",
      label: "Gemma 4",
      description: "Gemma-family Venice text model; 256K context",
    },
    {
      action: "disable",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      label: "Disable Venice",
      description: "restore DeepSeek route/main defaults",
    },
  ];
}

function resolveVeniceTextModel(value = "") {
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === "on" || normalized === "venice" || normalized === "1.2" || normalized === "venice-1.2") {
    return "venice-uncensored-1-2";
  }
  if (
    normalized === "1.1" ||
    normalized === "venice-1.1"
  ) {
    return "venice-uncensored";
  }
  if (normalized === "legacy" || normalized === "venice-uncensored") {
    return "venice-uncensored";
  }
  if (normalized === "e2ee" || normalized === "e2ee-venice-uncensored-24b-p") {
    return "e2ee-venice-uncensored-24b-p";
  }
  if (normalized === "gemma" || normalized === "gemma4" || normalized === "gemma-4" || normalized === "gemma-4-uncensored") {
    return "gemma-4-uncensored";
  }
  const exact = veniceTextModelChoices().find((item) => item.model.toLowerCase() === normalized);
  return exact?.model || "";
}

function useVeniceModels(state, routeModel = "venice-uncensored-1-2", mainModel = routeModel) {
  state.routingMode = "smart";
  state.provider = "deepseek";
  state.model = "";
  state.routeProvider = "venice";
  state.routeModel = routeModel;
  state.mainProvider = "venice";
  state.mainModel = mainModel;
}

function printModelRoles(state) {
  const roles = getModelRoleDefaults({
    routeProvider: state.routeProvider,
    routeModel: state.routeModel,
    mainProvider: state.mainProvider,
    mainModel: state.mainModel,
    spareProvider: state.spareProvider,
    spareModel: state.spareModel,
    spareReasoning: state.spareReasoning,
    wrapperModel: state.wrapperModel,
    wrapperReasoning: state.wrapperReasoning,
    auxiliaryProvider: state.auxiliaryProvider,
    auxiliaryModel: state.auxiliaryModel,
  });
  const roleLines = Object.values(roles).map((role) => {
    const reasoning = role.reasoning ? ` reasoning=${role.reasoning}` : "";
    return `${role.command.padEnd(12)} ${role.provider}/${role.model}${reasoning}\n  ${role.description}`;
  });
  const groups = Object.entries(MODEL_PROVIDER_GROUPS).map(([id, group]) => {
    const models = modelsForProviderGroup(id)
      .map((item) => item.id)
      .join(", ");
    return `${id}: ${group.role}${models ? ` (${models})` : ""}`;
  });
  const auxiliary = Object.entries(AUXILIARY_MODEL_CATALOG).map(
    ([id, models]) => `${id}: ${models.map((item) => item.id).join(", ")}`
  );
  const directProviders = Object.entries(PROVIDER_MODEL_CATALOG).map(([provider, models]) => {
    const compact = models
      .slice(0, 6)
      .map((item) => item.id)
      .join(", ");
    return `${provider}: ${compact}${models.length > 6 ? ", ..." : ""}`;
  });
  printAgentMessage(
    [
      "Model roles",
      ...roleLines,
      "",
      "Set roles",
      "/route deepseek/deepseek-v4-flash",
      "/model deepseek/deepseek-v4-pro",
      "/spare openai/gpt-5.4 medium",
      "/wrapper codex gpt-5.5 medium",
      "/auxiliary model grsai/nano-banana-2",
      "",
      "Provider groups",
      ...groups,
      "",
      "Auxiliary image groups",
      ...auxiliary,
      "",
      "Direct provider models",
      ...directProviders,
    ].join("\n")
  );
}

function compactReasoning(model = {}) {
  const values = Array.isArray(model.reasoning) ? model.reasoning : [];
  if (values.length === 0) return "";
  const preferred = model.id === "gpt-5.4-mini" || model.id === "gpt-5.3-codex-spark" ? "high" : "medium";
  return `${preferred} reasoning`;
}

function modelSelectorGroup(provider, model = {}) {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openai") return "OpenAI";
  if (provider === "qwen") return "Qwen";
  if (provider === "mock") return "Mock";
  if (provider === "venice") {
    if (model.bucket === "venice-uncensored") return "Venice Uncensored";
    if (model.bucket === "venice-gpt") return "Venice GPT";
    if (model.bucket === "venice-claude") return "Venice Claude";
    if (model.bucket === "venice-gemma") return "Venice Gemma";
    if (model.bucket === "venice-qwen") return "Venice Qwen";
    return "Venice";
  }
  return provider;
}

function textModelRoleChoices() {
  const providerOrder = ["deepseek", "venice", "openai", "qwen", "mock"];
  const veniceOrder = [
    "venice-uncensored-1-2",
    "venice-uncensored",
    "gemma-4-uncensored",
    "openai-gpt-55",
    "claude-sonnet-4-6",
    "qwen3-6-27b",
  ];
  const choices = [];
  for (const provider of providerOrder) {
    let models = PROVIDER_MODEL_CATALOG[provider] || [];
    if (provider === "venice") {
      const byId = new Map(models.filter((model) => !model.hidden).map((model) => [model.id, model]));
      models = veniceOrder.map((id) => byId.get(id)).filter(Boolean);
    } else {
      models = models.filter((model) => !model.hidden);
    }
    for (const model of models) {
      const group = modelSelectorGroup(provider, model);
      const reasoning = compactReasoning(model);
      const context = model.context ? `${model.context} context` : "";
      const details = [reasoning, context, model.description].filter(Boolean).join("; ");
      choices.push({
        provider,
        model: model.id,
        label: `${group} · ${model.label}`,
        group,
        description: details,
        reasoningDefault: reasoning ? reasoning.split(" ")[0] : "",
      });
    }
  }
  return choices;
}

export function modelRoleChoices(role = "main") {
  if (role !== "auxiliary") return textModelRoleChoices();
  const common = [
    {
      provider: "grsai",
      model: "nano-banana-2",
      label: "GRS AI Nano Banana",
      description: "default auxiliary image model",
      auxiliary: true,
    },
    {
      provider: "venice",
      model: "gpt-image-2",
      label: "Venice GPT Image 2",
      description: "high-quality Venice image generation",
      auxiliary: true,
    },
    {
      provider: "venice",
      model: "nano-banana-2",
      label: "Venice Nano Banana 2",
      description: "Venice image generation route",
      auxiliary: true,
    },
  ];
  return common.filter((item) => item.auxiliary).sort((a, b) => Number(b.provider === "grsai") - Number(a.provider === "grsai"));
}

function providerChoices() {
  return [
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      label: "DeepSeek",
      description: "default smart route with flash/pro roles",
    },
    {
      provider: "openai",
      model: "gpt-5.4",
      label: "OpenAI",
      description: "manual GPT route; use /model for exact model",
    },
    {
      provider: "venice",
      model: "venice-uncensored-1-2",
      label: "Venice",
      description: "manual Venice route; /venice picks route+main roles",
    },
    {
      provider: "qwen",
      model: "qwen-plus",
      label: "Qwen",
      description: "manual Qwen route",
    },
    {
      provider: "mock",
      model: "mock-agent",
      label: "Mock local",
      description: "deterministic offline smoke-test provider",
    },
  ];
}

function modelChoiceLine(option) {
  if (option.action === "disable") return `${option.label}  ${option.description}`;
  return `${option.label}  ${option.provider}/${option.model}  ${option.description}`;
}

function clearSelector(lineCount) {
  for (let index = 0; index < lineCount; index += 1) {
    output.write("\x1b[1A\r\x1b[2K");
  }
}

function clearSelectorSequence(lineCount) {
  return Array.from({ length: Math.max(lineCount, 0) }, () => "\x1b[1A\r\x1b[2K").join("");
}

function renderSelector({ title, subtitle, options, selectedIndex, lineCount = 0 }) {
  const width = Math.min(Math.max(terminalWidth() - 2, 60), 110);
  const bodyWidth = width - 4;
  const safeTitle = compactLine(title, bodyWidth);
  const safeSubtitle = compactLine(subtitle, bodyWidth);
  const rows = [
    `╭${"─".repeat(width - 2)}╮`,
    `│ ${padVisible(safeTitle, bodyWidth)} │`,
    `│ ${padVisible(safeSubtitle, bodyWidth)} │`,
    `├${"─".repeat(width - 2)}┤`,
    ...options.map((option, index) => {
      const marker = index === selectedIndex ? ">" : " ";
      const rendered = `${marker} ${compactLine(modelChoiceLine(option), bodyWidth - 2)}`;
      return `│ ${padVisible(index === selectedIndex ? color(rendered, ansi.userBg, ansi.bold) : rendered, bodyWidth)} │`;
    }),
    `╰${"─".repeat(width - 2)}╯`,
  ];
  output.write(`${lineCount > 0 ? clearSelectorSequence(lineCount) : ""}${rows.join("\n")}\n`);
  return rows.length;
}

function selectModelChoice({ title, subtitle, options, initialIndex = 0 }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    emitKeypressEvents(input);
    const wasRaw = Boolean(input.isRaw);
    const startedAt = Date.now();
    let selectedIndex = clamp(initialIndex, 0, Math.max(options.length - 1, 0));
    let lineCount = 0;
    const cleanup = () => {
      input.off("keypress", handler);
      if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
      input.pause();
      output.write(ansi.cursorShow);
    };
    const redraw = () => {
      lineCount = renderSelector({ title, subtitle, options, selectedIndex, lineCount });
    };
    const finish = (value) => {
      if (lineCount > 0) clearSelector(lineCount);
      cleanup();
      resolve(value);
    };
    const handler = (_str = "", key = {}) => {
      if (key.ctrl && key.name === "c") {
        finish(null);
        return;
      }
      if (key.name === "escape") {
        finish(null);
        return;
      }
      if (key.name === "up" || key.name === "left") {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        redraw();
        return;
      }
      if (key.name === "down" || key.name === "right" || key.name === "tab") {
        selectedIndex = (selectedIndex + 1) % options.length;
        redraw();
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.sequence === "\r") {
        if (Date.now() - startedAt < 120) return;
        finish(options[selectedIndex]);
      }
    };
    input.resume();
    input.setRawMode(true);
    input.on("keypress", handler);
    output.write(ansi.cursorHide);
    redraw();
  });
}

async function pickModelRole(role, state) {
  const options = modelRoleChoices(role);
  const currentProvider =
    role === "route"
      ? state.routeProvider || "deepseek"
      : role === "spare"
        ? state.spareProvider || "openai"
        : role === "auxiliary"
          ? state.auxiliaryProvider || "grsai"
          : state.mainProvider || state.provider || "deepseek";
  const currentModel =
    role === "route"
      ? state.routeModel || "deepseek-v4-flash"
      : role === "spare"
        ? state.spareModel || "gpt-5.4"
        : role === "auxiliary"
          ? state.auxiliaryModel || "nano-banana-2"
          : state.mainModel || "deepseek-v4-pro";
  const initialIndex = Math.max(
    options.findIndex((item) => item.provider === currentProvider && item.model === currentModel),
    0
  );
  const selected = await selectModelChoice({
    title:
      role === "route"
        ? "Select route model"
        : role === "spare"
          ? "Select spare model"
          : role === "auxiliary"
            ? "Select auxiliary model"
            : "Select main model",
    subtitle: "Up/Down/Left/Right selects, Enter confirms, Esc cancels.",
    options,
    initialIndex,
  });
  if (!selected) return false;

  state.routingMode = "smart";
  state.provider = "deepseek";
  state.model = "";
  if (role === "route") {
    state.routeProvider = selected.provider;
    state.routeModel = selected.model;
    printSystemLine(`route=${state.routeProvider}/${state.routeModel}`);
  } else if (role === "spare") {
    state.spareProvider = selected.provider;
    state.spareModel = selected.model;
    state.spareReasoning = selected.reasoningDefault || state.spareReasoning || "medium";
    printSystemLine(`spare=${state.spareProvider}/${state.spareModel} reasoning=${state.spareReasoning}`);
  } else if (role === "auxiliary") {
    state.auxiliaryProvider = selected.provider;
    state.auxiliaryModel = selected.model;
    state.allowAuxiliaryTools = true;
    printSystemLine(`auxiliary=${state.auxiliaryProvider}/${state.auxiliaryModel}`);
  } else {
    state.mainProvider = selected.provider;
    state.mainModel = selected.model;
    printSystemLine(`main=${state.mainProvider}/${state.mainModel}`);
  }
  return true;
}

async function pickVeniceRouteAndMain(state) {
  const options = veniceTextModelChoices();
  const routeIndex = Math.max(
    options.findIndex((item) => item.provider === state.routeProvider && item.model === state.routeModel),
    0
  );
  const route = await selectModelChoice({
    title: "Select Venice route model",
    subtitle: "Route handles planning and short turns. Up/Down selects, Enter confirms, Esc cancels.",
    options,
    initialIndex: routeIndex,
  });
  if (!route) return false;
  if (route.action === "disable") {
    useDeepSeekDefaults(state);
    printSystemLine("venice=off routing=smart route=deepseek/deepseek-v4-flash main=deepseek/deepseek-v4-pro");
    return true;
  }

  const mainIndex = Math.max(
    options.findIndex((item) => item.action !== "disable" && item.provider === state.mainProvider && item.model === state.mainModel),
    options.findIndex((item) => item.action !== "disable" && item.model === route.model),
    0
  );
  const main = await selectModelChoice({
    title: "Select Venice main model",
    subtitle: "Main handles complex work. Up/Down selects, Enter confirms, Esc cancels.",
    options,
    initialIndex: mainIndex,
  });
  if (!main) return false;
  if (main.action === "disable") {
    useDeepSeekDefaults(state);
    printSystemLine("venice=off routing=smart route=deepseek/deepseek-v4-flash main=deepseek/deepseek-v4-pro");
    return true;
  }

  useVeniceModels(state, route.model, main.model);
  printSystemLine(`venice=on routing=smart route=venice/${state.routeModel} main=venice/${state.mainModel}`);
  return true;
}

async function pickProvider(state) {
  const options = providerChoices();
  const currentProvider = state.provider || "deepseek";
  const initialIndex = Math.max(
    options.findIndex((item) => item.provider === currentProvider),
    0
  );
  const selected = await selectModelChoice({
    title: "Select provider",
    subtitle: "Up/Down/Left/Right selects, Enter confirms, Esc cancels.",
    options,
    initialIndex,
  });
  if (!selected) return false;

  state.provider = selected.provider;
  state.model = selected.model;
  state.routingMode = selected.provider === "deepseek" ? "smart" : "manual";
  printSystemLine(`provider=${state.provider} model=${state.model} routing=${state.routingMode}`);
  return true;
}

async function maybeOnboardDeepSeekKey(state) {
  if (!shouldPromptForDeepSeek(state, process.cwd())) return;

  printAgentMessage(
    [
      "No main model API key is configured for this project.",
      "Choose DeepSeek, OpenAI, or Qwen, then paste a key to save in `.aginti/.env` with 0600 permissions.",
      "After that, you can optionally paste the auxiliary image key. Press Esc to skip.",
    ].join("\n")
  );
  const result = await runAuthWizard(process.cwd(), { provider: state.provider || "", includeAuxiliary: true });
  applyAuthWizardResult(result, state);
  if (result.saved.some((item) => item.provider !== "grsai")) {
    return;
  }

  state.provider = "mock";
  state.routingMode = "manual";
  state.model = "mock-agent";
  printAgentMessage("No main key saved. Continuing in local mock mode. Use `/auth` later to save DeepSeek, OpenAI, Qwen, or Venice.");
}

function applyAuthWizardResult(result, state = null) {
  if (state) {
    const main = result.saved.find((item) => item.provider !== "grsai");
    if (main) state.provider = main.provider;
    if (state.routingMode === "manual" && state.model === "mock-agent") {
      state.routingMode = "smart";
      state.model = "";
    }
    if (result.saved.some((item) => item.provider === "grsai")) state.allowAuxiliaryTools = true;
  }
  if (result.saved.length > 0) {
    printAgentMessage(
      result.saved.map((item) => `Saved ${item.keyName} to project-local ignored env. Raw key was not printed.`).join("\n")
    );
  } else {
    printAgentMessage("No key saved.");
  }
}

async function promptAndSaveProviderKey(provider = "", state = null) {
  const canonical = normalizeAuthProvider(provider || "", "");
  const result = await runAuthWizard(process.cwd(), { provider: canonical, includeAuxiliary: canonical !== "grsai" });
  applyAuthWizardResult(result, state);
}

async function handleCommand(line, state, packageDir) {
  const [rawCommand, ...rest] = line.slice(1).trim().split(/\s+/);
  const command = resolveSlashCommand(rawCommand);
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
      } qwen=${keys.qwen ? "available" : "missing"} venice=${keys.venice ? "available" : "missing"}`
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
  if (command === "auxiliary") {
    const action = value || "status";
    if (action === "status") {
      const keys = providerKeyStatus(process.cwd());
      printAgentMessage(
        [
          `Auxiliary tools: ${state.allowAuxiliaryTools ? "on" : "off"}`,
          `Image generation: ${keys.grsai ? "GRSAI key available" : "missing GRSAI key"}`,
          `Venice image: ${keys.venice ? "Venice key available" : "missing Venice key"}`,
          `Selected auxiliary: ${state.auxiliaryProvider || "grsai"}/${state.auxiliaryModel || "nano-banana-2"}`,
          "Use `/auxiliary grsai` or `/auxiliary venice` to paste a key, `/auxiliary model grsai/nano-banana-2`, `/auxiliary image`, or `/auxiliary off`.",
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
    if (action.startsWith("model")) {
      const modelValue = action.replace(/^model\s*/, "");
      if (!modelValue.trim() && input.isTTY && output.isTTY && typeof input.setRawMode === "function") {
        const changed = await pickModelRole("auxiliary", state);
        if (!changed) printSystemLine(`auxiliary=${state.auxiliaryProvider || "grsai"}/${state.auxiliaryModel || "nano-banana-2"}`);
        return true;
      }
      const selected = parseProviderModel(modelValue, state.auxiliaryProvider || "grsai");
      state.auxiliaryProvider = selected.provider || "grsai";
      state.auxiliaryModel = selected.model || state.auxiliaryModel || "nano-banana-2";
      printSystemLine(`auxiliary=${state.auxiliaryProvider}/${state.auxiliaryModel}`);
      return true;
    }
    if (["grsai", "venice", "login", "key", "token"].includes(action)) {
      await promptAndSaveProviderKey(action === "venice" ? "venice" : "grsai", state);
      return true;
    }
    printAgentMessage("Usage: /auxiliary [status|grsai|venice|model grsai/nano-banana-2|on|off|image]");
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
        await printResumeHistory(state);
      }
    } else {
      state.sessionId = value;
      printAgentMessage(`Resuming ${state.sessionId}`);
      await printResumeHistory(state);
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
  if (command === "skills" || command === "skill") {
    const skills = value
      ? selectSkillsForGoal(value, { taskProfile: state.taskProfile, limit: 12, includeBody: false })
      : listSkills({ includeBody: false });
    if (skills.length === 0) {
      printAgentMessage("No matching skills found.");
      return true;
    }
    printAgentMessage(
      skills
        .map((skill) =>
          [
            `${skill.id}: ${skill.label}`,
            `  ${skill.description}`,
            skill.triggers?.length ? `  triggers: ${skill.triggers.join(", ")}` : "",
            skill.tools?.length ? `  tools: ${skill.tools.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        )
        .join("\n\n")
    );
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
      if (Number.isFinite(count) && count > 0) state.parallelScoutCount = Math.min(Math.max(count, 1), 10);
    }
    printSystemLine(`parallelScouts=${state.allowParallelScouts ? "on" : "off"} count=${state.parallelScoutCount}`);
    return true;
  }
  if (command === "models") {
    printModelRoles(state);
    return true;
  }
  if (command === "venice") {
    const canUseSelector = input.isTTY && output.isTTY && typeof input.setRawMode === "function";
    const action = value || (canUseSelector ? "select" : "on");
    if (action === "off" || action === "deepseek" || action === "default") {
      useDeepSeekDefaults(state);
      printSystemLine("venice=off routing=smart route=deepseek/deepseek-v4-flash main=deepseek/deepseek-v4-pro");
      return true;
    }
    if (action === "select" && canUseSelector) {
      const changed = await pickVeniceRouteAndMain(state);
      if (!changed) {
        printSystemLine(`route=${state.routeProvider || "deepseek"}/${state.routeModel || "deepseek-v4-flash"} main=${state.mainProvider || "deepseek"}/${state.mainModel || "deepseek-v4-pro"}`);
        return true;
      }
      const keys = providerKeyStatus(process.cwd());
      if (!keys.venice) {
        printAgentMessage("Venice model roles are selected, but no Venice key is configured. Run `/auth venice` to save one.");
      }
      return true;
    }

    const parts = action.split(/\s+/).filter(Boolean);
    const routeModel = resolveVeniceTextModel(parts[0] || "on");
    const mainModel = resolveVeniceTextModel(parts.slice(1).join(" ") || parts[0] || "on");
    if (!routeModel || !mainModel) {
      printAgentMessage(
        [
          "Usage: /venice [off|1.2|1.1|gemma] [main-model]",
          "Examples:",
          "  /venice",
          "  /venice gemma",
          "  /venice 1.2 gemma",
          "  /venice off",
        ].join("\n")
      );
      return true;
    }
    useVeniceModels(state, routeModel, mainModel);
    const keys = providerKeyStatus(process.cwd());
    printSystemLine(`venice=on routing=smart route=venice/${state.routeModel} main=venice/${state.mainModel}`);
    if (!keys.venice) {
      printAgentMessage("Venice model roles are selected, but no Venice key is configured. Run `/auth venice` to save one.");
    }
    return true;
  }
  if (command === "route") {
    if (!value) {
      if (input.isTTY && output.isTTY && typeof input.setRawMode === "function") {
        const changed = await pickModelRole("route", state);
        if (!changed) printSystemLine(`route=${state.routeProvider || "deepseek"}/${state.routeModel || "deepseek-v4-flash"}`);
        return true;
      }
      printAgentMessage(
        `Route model: ${state.routeProvider || "deepseek"}/${state.routeModel || "deepseek-v4-flash"}\nUse /route deepseek/deepseek-v4-flash or /route fast|smart|complex.`
      );
      return true;
    }
    if (["smart", "fast", "complex", "manual"].includes(value)) {
      state.routingMode = value;
      printSystemLine(`routing=${state.routingMode}`);
      return true;
    }
    const selected = parseProviderModel(value, state.routeProvider || "deepseek");
    state.routeProvider = selected.provider || "deepseek";
    state.routeModel = selected.model || state.routeModel || "deepseek-v4-flash";
    printSystemLine(`route=${state.routeProvider}/${state.routeModel}`);
    return true;
  }
  if (command === "main" || command === "model") {
    if (!value) {
      if (input.isTTY && output.isTTY && typeof input.setRawMode === "function") {
        const changed = await pickModelRole("main", state);
        if (!changed) printSystemLine(`main=${state.mainProvider || state.provider || "deepseek"}/${state.mainModel || state.model || "deepseek-v4-pro"}`);
        return true;
      }
      printAgentMessage(
        `Main model: ${state.mainProvider || state.provider || "deepseek"}/${state.mainModel || state.model || "deepseek-v4-pro"}\nUse /model deepseek/deepseek-v4-pro or /model auto.`
      );
      return true;
    }
    if (value === "auto") {
      if (command === "main") {
        state.mainProvider = "";
        state.mainModel = "";
        printSystemLine("main=auto");
      } else {
        state.model = "";
        printSystemLine("model=auto");
      }
      return true;
    }
    const selected = parseProviderModel(value, state.mainProvider || state.provider || "deepseek");
    if (command === "main" || selected.provider) {
      state.mainProvider = selected.provider || "deepseek";
      state.mainModel = selected.model || "deepseek-v4-pro";
      if (command === "model") {
        state.provider = state.mainProvider;
        state.model = state.mainModel;
      }
      printSystemLine(`main=${state.mainProvider}/${state.mainModel}`);
      return true;
    }
    state.model = value;
    printSystemLine(`model=${state.model || "auto"}`);
    return true;
  }
  if (command === "spare") {
    if (!value) {
      if (input.isTTY && output.isTTY && typeof input.setRawMode === "function") {
        const changed = await pickModelRole("spare", state);
        if (!changed) printSystemLine(`spare=${state.spareProvider}/${state.spareModel} reasoning=${state.spareReasoning}`);
        return true;
      }
      printAgentMessage(`Spare model: ${state.spareProvider}/${state.spareModel} reasoning=${state.spareReasoning}`);
      return true;
    }
    const parts = value.split(/\s+/).filter(Boolean);
    const selected = parseProviderModel(parts[0] || "", state.spareProvider || "openai");
    state.spareProvider = selected.provider || "openai";
    state.spareModel = selected.model || state.spareModel || "gpt-5.4";
    if (parts[1]) state.spareReasoning = parts[1];
    printSystemLine(`spare=${state.spareProvider}/${state.spareModel} reasoning=${state.spareReasoning}`);
    return true;
  }
  if (command === "wrapper") {
    if (!value) {
      printAgentMessage(
        `Wrapper: ${state.preferredWrapper || "codex"} model=${state.wrapperModel || "gpt-5.5"} reasoning=${
          state.wrapperReasoning || "medium"
        } tools=${state.allowWrapperTools ? "on" : "off"}`
      );
      return true;
    }
    const parts = value.split(/\s+/).filter(Boolean);
    if (parts[0] === "on" || parts[0] === "off") {
      state.allowWrapperTools = parts[0] === "on";
      printSystemLine(`wrappers=${state.allowWrapperTools ? "on" : "off"}`);
      return true;
    }
    state.preferredWrapper = parts[0] || state.preferredWrapper || "codex";
    if (parts[1]) state.wrapperModel = parts[1];
    if (parts[2]) state.wrapperReasoning = parts[2];
    printSystemLine(`wrapper=${state.preferredWrapper} model=${state.wrapperModel} reasoning=${state.wrapperReasoning}`);
    return true;
  }
  if (command === "routing") {
    state.routingMode = value || "smart";
    printSystemLine(`routing=${state.routingMode}`);
    return true;
  }
  if (command === "provider") {
    if (!value) {
      if (input.isTTY && output.isTTY && typeof input.setRawMode === "function") {
        const changed = await pickProvider(state);
        if (!changed) printSystemLine(`provider=${state.provider || "auto"} model=${state.model || "auto"}`);
        return true;
      }
      printAgentMessage(`Provider: ${state.provider || "auto"}\nUse /provider deepseek|openai|qwen|venice|mock.`);
      return true;
    }
    state.provider = value === "auto" ? "" : value;
    printSystemLine(`provider=${state.provider || "auto"}`);
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
      routeProvider: state.routeProvider,
      routeModel: state.routeModel,
      mainProvider: state.mainProvider,
      mainModel: state.mainModel,
      spareProvider: state.spareProvider,
      spareModel: state.spareModel,
      spareReasoning: state.spareReasoning,
      wrapperModel: state.wrapperModel,
      wrapperReasoning: state.wrapperReasoning,
      auxiliaryProvider: state.auxiliaryProvider,
      auxiliaryModel: state.auxiliaryModel,
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
  state.activeGoal = compactLine(prompt, 84);
  state.lastEvent = "";

  const store = new SessionStore(config.sessionsDir, state.sessionId);
  const liveInput = new LiveRunInput({ state, store, controller });
  const liveStarted = liveInput.start();
  const detachInterrupts = liveStarted ? () => {} : attachRunInterrupts(controller);
  if (liveStarted) {
    liveInput.setStatus(`running · ${state.activeGoal}`);
  } else {
    printSystemLine(`session=${state.sessionId}`);
    printSystemLine(`status=running workingOn=${state.activeGoal}`);
  }
  let result;
  let runError = null;
  let queuedAfterFinish = [];
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
          outputLine(`${label("error", ansi.systemBg)} ${stripMarkdown(text)}`);
        } else if (options.kind === "meta" && liveStarted) {
          const trimmed = String(text || "").trim();
          if (trimmed) liveInput.setStatus(trimmed);
        } else {
          printSystemLine(text);
        }
      },
      onLog: (message, data = {}) => {
        if (message === "command.output") printCommandOutputLog(data);
      },
      onEvent: (type, data = {}) => {
        if (type === "plan.created") {
          printStatusEvent(state, "planned");
        } else if (type === "model.requested") {
          printStatusEvent(state, "model_wait", `${data.provider || "model"}/${data.model || ""}`);
        } else if (type === "tool.started") {
          printStatusEvent(state, "tool", data.toolName || "unknown");
        } else if (type === "tool.completed") {
          printStatusEvent(state, "tool_done", data.toolName || "unknown");
        } else if (type === "file.changed") {
          printWorkspaceChange(data);
        } else if (type === "tool.blocked") {
          printStatusEvent(state, "tool_blocked", data.toolName || data.reason || "unknown");
        } else if (type === "loop.guard") {
          printStatusEvent(state, "loop_guard", data.toolName || "");
        } else if (type === "conversation.queued_input_applied") {
          liveInput.markApplied(data);
          printStatusEvent(state, "queued_input_applied", data.priority === "asap" ? "asap" : "");
        } else if (type === "session.finished") {
          printStatusEvent(state, "finished");
        } else if (type === "session.stopped") {
          printStatusEvent(state, "stopped", data.reason || "");
        } else if (type === "model.responded") {
          printStatusEvent(state, "model_responded", data.content ? data.content.slice(0, 80).replace(/\s+/g, " ") : "");
        }
      },
    });
  } catch (error) {
    runError = error;
  } finally {
    detachInterrupts();
    queuedAfterFinish = await liveInput.stop();
  }
  if (runError) {
    state.status = isAbortError(runError) ? "stopped" : "failed";
    state.activeGoal = "";
    printSystemLine(`status=${state.status} session=${state.sessionId}`);
    throw runError;
  }
  state.sessionId = result.sessionId || state.sessionId;
  state.status = result.stopped ? "stopped" : "idle";
  state.activeGoal = "";
  printSystemLine(`status=${state.status} session=${state.sessionId}`);
  if (result.stopped && result.reason === "user_interrupt") {
    await printResumeHint(state);
    return [];
  }
  return queuedAfterFinish;
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
  await printResumeHistory(state);

  try {
    while (true) {
      let answer = "";
      try {
        answer = await readPromptAnswer(rl, state);
      } catch (error) {
        if (error?.code === "ERR_USE_AFTER_CLOSE") break;
        if (isAbortError(error)) {
          await printResumeHint(state);
          break;
        }
        throw error;
      }
      const line = canonicalSlashPromptBuffer(answer).trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const keepGoing = await handleCommand(line, state, packageDir);
        if (!keepGoing) break;
        continue;
      }

      try {
        const pendingPrompts = [{ content: line }];
        while (pendingPrompts.length > 0) {
          const nextPrompt = pendingPrompts.shift();
          const content = canonicalSlashPromptBuffer(String(nextPrompt.content || "")).trim();
          if (!content) continue;
          if (content.startsWith("/")) {
            const keepGoing = await handleCommand(content, state, packageDir);
            if (!keepGoing) return;
            continue;
          }
          const queued = await runPrompt(content, state, packageDir);
          pendingPrompts.push(...queued.filter((item) => String(item.content || "").trim()));
        }
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
