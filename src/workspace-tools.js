import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "./redaction.js";

export const WORKSPACE_TOOL_NAMES = ["list_files", "read_file", "search_files", "write_file", "apply_patch"];
export const WORKSPACE_WRITE_TOOL_NAMES = ["write_file", "apply_patch"];

const MAX_READ_BYTES = 220_000;
const MAX_WRITE_BYTES = 220_000;
const MAX_LIST_ENTRIES = 360;
const MAX_SEARCH_RESULTS = 80;
const DEFAULT_MAX_DEPTH = 4;
const SKIP_DIRS = new Set([".git", "node_modules", ".sessions"]);
const SENSITIVE_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx", ".crt", ".csr"]);
const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
]);

function normalizeRelative(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized || ".";
}

function workspaceRoot(config) {
  return path.resolve(config.commandCwd || process.cwd());
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compactPreview(value, limit = 180) {
  const text = redactSensitiveText(String(value ?? ""));
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function sanitizePathInput(inputPath) {
  const value = String(inputPath || ".").trim();
  if (!value) return ".";
  if (value.includes("\0")) throw new Error("Path contains a null byte.");
  return value;
}

function normalizeWorkspaceInputPath(rawPath) {
  if (rawPath === "/workspace") return ".";
  if (rawPath.startsWith("/workspace/")) return rawPath.slice("/workspace/".length) || ".";
  return rawPath;
}

export function resolveWorkspacePath(config, inputPath = ".") {
  const root = workspaceRoot(config);
  const rawPath = sanitizePathInput(inputPath);
  const workspacePath = normalizeWorkspaceInputPath(rawPath);
  const absolutePath = path.resolve(root, workspacePath);

  if (!isInside(root, absolutePath)) {
    throw new Error(`Path escapes the configured workspace: ${rawPath}`);
  }

  return {
    root,
    absolutePath,
    relativePath: normalizeRelative(path.relative(root, absolutePath)),
  };
}

function pathSegments(relativePath) {
  return normalizeRelative(relativePath)
    .split("/")
    .filter(Boolean);
}

function isSensitivePath(relativePath) {
  const segments = pathSegments(relativePath);
  const basename = segments.at(-1) || "";
  const lowerBase = basename.toLowerCase();
  const lowerPath = normalizeRelative(relativePath).toLowerCase();
  if (segments.includes(".git")) return true;
  if (lowerBase === ".env" || lowerBase.startsWith(".env.")) return true;
  if (SENSITIVE_BASENAMES.has(lowerBase)) return true;
  if (SENSITIVE_EXTENSIONS.has(path.extname(lowerBase))) return true;
  return /(^|\/)(secrets?|tokens?|passwords?|private[-_]?keys?|credentials?)(\/|\.|$)/i.test(lowerPath);
}

function isNodeModulesPath(relativePath) {
  return pathSegments(relativePath).includes("node_modules");
}

function pathPolicy(toolName, relativePath) {
  const write = WORKSPACE_WRITE_TOOL_NAMES.includes(toolName);
  if (isSensitivePath(relativePath)) {
    return {
      allowed: false,
      reason: "Path is blocked because it may contain secrets or repository internals.",
      category: "workspace-path",
    };
  }
  if (write && isNodeModulesPath(relativePath)) {
    return {
      allowed: false,
      reason: "Writes inside node_modules are blocked.",
      category: "workspace-path",
    };
  }
  return { allowed: true };
}

export function checkWorkspaceToolUse(toolName, args, config) {
  if (!WORKSPACE_TOOL_NAMES.includes(toolName)) return { allowed: true };
  if (!config.allowFileTools) {
    return { allowed: false, reason: "Workspace file tools are disabled for this run.", category: "workspace-tools" };
  }

  try {
    const target = resolveWorkspacePath(config, args.path || ".");
    return pathPolicy(toolName, target.relativePath);
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : String(error),
      category: "workspace-path",
    };
  }
}

export function summarizeWorkspaceTools(config) {
  return {
    enabled: Boolean(config.allowFileTools),
    workspace: workspaceRoot(config),
    tools: WORKSPACE_TOOL_NAMES,
    writeTools: WORKSPACE_WRITE_TOOL_NAMES,
    limits: {
      maxReadBytes: MAX_READ_BYTES,
      maxWriteBytes: MAX_WRITE_BYTES,
      maxListEntries: MAX_LIST_ENTRIES,
      maxSearchResults: MAX_SEARCH_RESULTS,
    },
  };
}

async function fileInfo(absolutePath, root) {
  const stat = await fs.stat(absolutePath);
  return {
    path: normalizeRelative(path.relative(root, absolutePath)),
    type: stat.isDirectory() ? "directory" : "file",
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

async function listFiles(config, args) {
  const target = resolveWorkspacePath(config, args.path || ".");
  const maxDepth = Math.min(Math.max(Number(args.maxDepth) || DEFAULT_MAX_DEPTH, 1), 8);
  const limit = Math.min(Math.max(Number(args.limit) || MAX_LIST_ENTRIES, 1), MAX_LIST_ENTRIES);
  const entries = [];

  async function walk(currentPath, depth) {
    if (entries.length >= limit) return;
    const info = await fileInfo(currentPath, target.root);
    const policy = pathPolicy("read_file", info.path);
    if (!policy.allowed) return;

    entries.push(info);
    if (info.type !== "directory" || depth >= maxDepth) return;

    const children = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (SKIP_DIRS.has(child.name)) continue;
      await walk(path.join(currentPath, child.name), depth + 1);
      if (entries.length >= limit) break;
    }
  }

  await walk(target.absolutePath, 0);
  return {
    ok: true,
    toolName: "list_files",
    path: target.relativePath,
    entries,
    truncated: entries.length >= limit,
  };
}

async function readTextFile(target) {
  const stat = await fs.stat(target.absolutePath);
  if (!stat.isFile()) throw new Error(`Path is not a file: ${target.relativePath}`);
  if (stat.size > MAX_READ_BYTES) throw new Error(`File is too large to read safely: ${target.relativePath}`);

  const buffer = await fs.readFile(target.absolutePath);
  if (buffer.includes(0)) throw new Error(`Binary files are not readable through this tool: ${target.relativePath}`);
  return {
    stat,
    content: buffer.toString("utf8"),
    hash: hashBuffer(buffer),
  };
}

async function readFile(config, args) {
  const target = resolveWorkspacePath(config, args.path);
  const { stat, content, hash } = await readTextFile(target);
  return {
    ok: true,
    toolName: "read_file",
    path: target.relativePath,
    bytes: stat.size,
    sha256: hash,
    content: redactSensitiveText(content),
  };
}

async function searchFiles(config, args) {
  const target = resolveWorkspacePath(config, args.path || ".");
  const query = String(args.query || "").trim();
  if (query.length < 2) throw new Error("Search query must be at least 2 characters.");

  const caseSensitive = Boolean(args.caseSensitive);
  const needle = caseSensitive ? query : query.toLowerCase();
  const maxResults = Math.min(Math.max(Number(args.maxResults) || MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
  const results = [];

  async function visit(currentPath, depth = 0) {
    if (results.length >= maxResults || depth > DEFAULT_MAX_DEPTH + 2) return;
    const stat = await fs.stat(currentPath).catch(() => null);
    if (!stat) return;

    const relativePath = normalizeRelative(path.relative(target.root, currentPath));
    const policy = pathPolicy("read_file", relativePath);
    if (!policy.allowed) return;

    if (stat.isDirectory()) {
      const children = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (SKIP_DIRS.has(child.name)) continue;
        await visit(path.join(currentPath, child.name), depth + 1);
        if (results.length >= maxResults) break;
      }
      return;
    }

    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return;
    const buffer = await fs.readFile(currentPath).catch(() => null);
    if (!buffer || buffer.includes(0)) return;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (results.length >= maxResults) return;
      const haystack = caseSensitive ? line : line.toLowerCase();
      if (haystack.includes(needle)) {
        results.push({
          path: relativePath,
          line: index + 1,
          text: compactPreview(line, 240),
        });
      }
    });
  }

  await visit(target.absolutePath);
  return {
    ok: true,
    toolName: "search_files",
    query: compactPreview(query, 120),
    path: target.relativePath,
    results,
    truncated: results.length >= maxResults,
  };
}

function compactDiff(relativePath, beforeText, afterText) {
  const beforeLines = String(beforeText || "").split("\n");
  const afterLines = String(afterText || "").split("\n");
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix + prefix < beforeLines.length &&
    suffix + prefix < afterLines.length &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const beforeChanged = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterChanged = afterLines.slice(prefix, afterLines.length - suffix);
  const maxLines = 28;
  const lines = [`--- a/${relativePath}`, `+++ b/${relativePath}`, `@@ line ${prefix + 1} @@`];

  beforeChanged.slice(0, maxLines).forEach((line) => lines.push(`-${redactSensitiveText(line)}`));
  afterChanged.slice(0, maxLines).forEach((line) => lines.push(`+${redactSensitiveText(line)}`));
  if (beforeChanged.length + afterChanged.length > maxLines * 2) lines.push("... diff truncated ...");
  return lines.join("\n");
}

async function writeChange(target, nextContent, action, details = {}) {
  const content = String(nextContent ?? "");
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`Write is too large for safe workspace tools: ${target.relativePath}`);
  }

  await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
  let beforeText = "";
  let beforeHash = null;
  let beforeBytes = 0;
  let existed = false;

  try {
    const before = await fs.readFile(target.absolutePath);
    if (before.length > MAX_READ_BYTES) throw new Error(`Existing file is too large to overwrite safely: ${target.relativePath}`);
    if (before.includes(0)) throw new Error(`Binary files cannot be overwritten through this tool: ${target.relativePath}`);
    existed = true;
    beforeText = before.toString("utf8");
    beforeHash = hashBuffer(before);
    beforeBytes = before.length;
  } catch {
    // Missing files are valid for create/overwrite actions.
  }

  await fs.writeFile(target.absolutePath, content, "utf8");
  const afterBuffer = await fs.readFile(target.absolutePath);
  const afterText = afterBuffer.toString("utf8");
  const afterHash = hashBuffer(afterBuffer);

  return {
    ok: true,
    action,
    path: target.relativePath,
    beforeHash,
    afterHash,
    beforeBytes,
    afterBytes: afterBuffer.length,
    created: !existed,
    diff: compactDiff(target.relativePath, beforeText, afterText),
    contentSha256: hashText(content),
    ...details,
  };
}

async function writeFile(config, args) {
  const target = resolveWorkspacePath(config, args.path);
  const mode = args.mode === "overwrite" ? "overwrite" : "create";
  const exists = await fs
    .stat(target.absolutePath)
    .then(() => true)
    .catch(() => false);
  if (exists && mode !== "overwrite") {
    throw new Error(`File already exists. Use mode=overwrite to modify it: ${target.relativePath}`);
  }

  const change = await writeChange(target, args.content || "", mode === "overwrite" ? "overwrite_file" : "create_file", {
    mode,
  });
  return {
    ok: true,
    toolName: "write_file",
    path: target.relativePath,
    change,
  };
}

async function applyPatch(config, args) {
  const target = resolveWorkspacePath(config, args.path);
  const { content: beforeText } = await readTextFile(target);
  const search = String(args.search || "");
  const replace = String(args.replace ?? "");
  if (!search) throw new Error("Patch search text is required.");

  const matches = beforeText.split(search).length - 1;
  if (matches === 0) throw new Error(`Patch search text was not found in ${target.relativePath}.`);
  const expected = Number(args.expectedReplacements);
  if (Number.isFinite(expected) && expected > 0 && matches !== expected) {
    throw new Error(`Patch expected ${expected} replacement(s), found ${matches}.`);
  }
  if (matches > 20) throw new Error(`Patch would replace too many sections (${matches}).`);

  const afterText = beforeText.split(search).join(replace);
  const change = await writeChange(target, afterText, "apply_patch", {
    replacements: matches,
    searchPreview: compactPreview(search),
    replacePreview: compactPreview(replace),
  });

  return {
    ok: true,
    toolName: "apply_patch",
    path: target.relativePath,
    change,
  };
}

export async function executeWorkspaceTool(toolName, args, config) {
  const guard = checkWorkspaceToolUse(toolName, args, config);
  if (!guard.allowed) {
    return {
      ok: false,
      blocked: true,
      reason: guard.reason,
      category: guard.category,
      toolName,
    };
  }

  switch (toolName) {
    case "list_files":
      return listFiles(config, args);
    case "read_file":
      return readFile(config, args);
    case "search_files":
      return searchFiles(config, args);
    case "write_file":
      return writeFile(config, args);
    case "apply_patch":
      return applyPatch(config, args);
    default:
      throw new Error(`Unknown workspace tool: ${toolName}`);
  }
}
