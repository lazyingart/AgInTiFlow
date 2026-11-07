import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { ensureRuntimeGitExcludes, projectPaths } from "./project.js";
import { redactSensitiveText } from "./redaction.js";
import { executeWorkspaceTool } from "./workspace-tools.js";
import { publishWorkspaceTextFile } from "./workspace-file-publication.js";
import { createWorkspaceReadBoundary, readWorkspaceFileSnapshot } from "./workspace-read-boundary.js";

const MAP_VERSION = 1;
const DEFAULT_CONTEXT_PACK_CHARS = 3800;
// Same bound as the existing native atomic text publisher. The overview is
// optional; an oversized/unsafe cache must not grant broader write authority.
const MAX_MAP_BYTES = 220_000;

async function assertCacheEntry(file) {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o7000n) !== 0n ||
      typeof process.geteuid === "function" && stat.uid !== BigInt(process.geteuid())) {
    throw Object.assign(new Error("Project cache must be an owned, singly linked regular file without special permission bits."), { code: "PROJECT_CACHE_UNSAFE" });
  }
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

// Cache data is a versioned overview, not authority or evidence of current
// source correctness. Inspect only own data descriptors; formatting an invalid
// optional map must not invoke input hooks or break capability discovery.
function dataProperties(value) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(fields)) {
    const field = fields[key];
    if (typeof key !== "string" || !field.enumerable || !Object.hasOwn(field, "value")) return null;
  }
  return fields;
}
function record(value, schema) {
  const fields = dataProperties(value), keys = fields && Reflect.ownKeys(fields);
  if (!keys || keys.length !== Object.keys(schema).length) return false;
  for (const key of keys) if (!Object.hasOwn(schema, key) || !schema[key](fields[key].value)) return false;
  return true;
}
const text = (limit, nonblank = false) => value => typeof value === "string" && value.length <= limit &&
  !value.includes("\0") && (!nonblank || value.trim().length > 0);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const boolean = value => typeof value === "boolean";
const timestamp = value => {
  if (!text(40, true)(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};
const rootPath = value => text(32768, true)(value) && path.isAbsolute(value) && path.resolve(value) === value;
const relativePath = value => text(32768)(value) && value.length > 0 && !path.isAbsolute(value) &&
  path.posix.normalize(value) === value && value !== ".." && !value.startsWith("../");
const list = (limit, item) => value => {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(value, "length").value;
  if (!natural(length) || length > limit || Reflect.ownKeys(value).length !== length + 1) return false;
  for (let i = 0; i < length; i++) {
    const field = Object.getOwnPropertyDescriptor(value, String(i));
    if (!field?.enumerable || !Object.hasOwn(field, "value") || !item(field.value)) return false;
  }
  return true;
};
const topEntry = value => {
  const fields = dataProperties(value);
  if (!fields) return false;
  return fields.type?.value === "directory"
    ? record(value, { path: relativePath, type: v => v === "directory" })
    : record(value, { path: relativePath, type: v => v === "file", size: natural });
};
const fileEntry = value => record(value, { path: relativePath, size: natural, modifiedAt: timestamp });
const inspectionData = value => record(value, {
  summary: text(4096, true), counts: v => record(v, { files: natural, directories: natural, totalBytes: natural }), truncated: boolean,
  topLevel: list(80, topEntry), manifestFiles: list(80, fileEntry),
  sourceDirs: list(60, v => record(v, { path: relativePath, kind: k => k === "source" || k === "tests" })),
  testFiles: list(80, fileEntry), packageManagers: list(20, text(220, true)),
  packageScripts: list(30, v => record(v, { name: text(120000), command: text(220) })),
  languageCounts: list(30, v => record(v, { name: text(512), count: natural })),
  git: v => record(v, { present: boolean, recommendedCommands: list(2, text(220)), workflow: text(2048) }),
  recommendedReads: list(40, relativePath), engineeringHints: list(20, text(2048, true)),
});
function mapFingerprint(inspection) {
  // Explicit field order keeps existing version-1 producer digests valid even
  // when a reader reformats JSON object keys. It is consistency, not a MAC.
  return stableHash({
    summary: inspection.summary,
    counts: { files: inspection.counts.files, directories: inspection.counts.directories, totalBytes: inspection.counts.totalBytes },
    manifests: inspection.manifestFiles.map(item => item.path), sourceDirs: inspection.sourceDirs.map(item => item.path),
    tests: inspection.testFiles.map(item => item.path),
    packageScripts: inspection.packageScripts.map(item => ({ name: item.name, command: item.command })),
    languages: inspection.languageCounts.map(item => ({ name: item.name, count: item.count })),
  });
}
function validMap(value, expectedRoot) {
  return record(value, { version: v => v === MAP_VERSION, generatedAt: timestamp, projectRoot: rootPath, commandCwd: rootPath,
    fingerprint: v => typeof v === "string" && /^[a-f0-9]{16}$/.test(v), inspection: inspectionData }) &&
    value.projectRoot === value.commandCwd && (expectedRoot === undefined || value.projectRoot === expectedRoot) &&
    value.fingerprint === mapFingerprint(value.inspection);
}

function truncateText(text, limit = DEFAULT_CONTEXT_PACK_CHARS) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(limit - 80, 1))}\n... [truncated ${value.length - limit + 80} chars]`;
}

function listValues(items, limit, mapper) {
  const values = Array.isArray(items) ? items.slice(0, limit).map(mapper).filter(Boolean) : [];
  if (!values.length) return "";
  const suffix = Array.isArray(items) && items.length > limit ? `, ... +${items.length - limit}` : "";
  return `${values.join(", ")}${suffix}`;
}

function packageScriptValues(scripts) {
  if (!Array.isArray(scripts) || !scripts.length) return "";
  return listValues(scripts, 14, (item) => `${item.name}: ${item.command}`);
}

function compactInspection(inspected) {
  return {
    summary: inspected.summary || "",
    counts: inspected.counts || {},
    truncated: Boolean(inspected.truncated),
    topLevel: Array.isArray(inspected.topLevel) ? inspected.topLevel.slice(0, 80) : [],
    manifestFiles: Array.isArray(inspected.manifestFiles) ? inspected.manifestFiles.slice(0, 80) : [],
    sourceDirs: Array.isArray(inspected.sourceDirs) ? inspected.sourceDirs.slice(0, 60) : [],
    testFiles: Array.isArray(inspected.testFiles) ? inspected.testFiles.slice(0, 80) : [],
    packageManagers: Array.isArray(inspected.packageManagers) ? inspected.packageManagers.slice(0, 20) : [],
    packageScripts: Array.isArray(inspected.packageScripts) ? inspected.packageScripts.slice(0, 30) : [],
    languageCounts: Array.isArray(inspected.languageCounts) ? inspected.languageCounts.slice(0, 30) : [],
    git: inspected.git || {},
    recommendedReads: Array.isArray(inspected.recommendedReads) ? inspected.recommendedReads.slice(0, 40) : [],
    engineeringHints: Array.isArray(inspected.engineeringHints) ? inspected.engineeringHints.slice(0, 20) : [],
  };
}

export function codebaseMapToContextPack(map, { maxChars = DEFAULT_CONTEXT_PACK_CHARS } = {}) {
  if (!validMap(map)) return "Context pack: no durable codebase map available.";
  const inspected = map.inspection;
  const sections = [
    `Context pack for ${map.commandCwd || map.projectRoot}`,
    `Map: version=${map.version} generatedAt=${map.generatedAt} fingerprint=${map.fingerprint}`,
    `Summary: ${inspected.summary || "no summary"}`,
    inspected.counts
      ? `Counts: files=${inspected.counts.files} dirs=${inspected.counts.directories} bytes=${inspected.counts.totalBytes}`
      : "",
    `Top level: ${listValues(inspected.topLevel, 20, (item) => `${item.type}:${item.path}`)}`,
    `Manifests: ${listValues(inspected.manifestFiles, 18, (item) => item.path)}`,
    `Source dirs: ${listValues(inspected.sourceDirs, 14, (item) => item.path)}`,
    `Tests: ${listValues(inspected.testFiles, 18, (item) => item.path)}`,
    `Package managers: ${listValues(inspected.packageManagers, 8, (item) => item.name || item.path || item)}`,
    packageScriptValues(inspected.packageScripts) ? `Package scripts: ${packageScriptValues(inspected.packageScripts)}` : "",
    `Languages: ${listValues(inspected.languageCounts, 10, (item) => `${item.name}:${item.count}`)}`,
    inspected.git?.present
      ? `Git: present; start with ${inspected.git.recommendedCommands?.join(" && ") || "git status --short"}; ${inspected.git.workflow}`
      : "Git: not detected at workspace root.",
    `Recommended reads: ${listValues(inspected.recommendedReads, 16, (item) => item)}`,
    `Engineering hints: ${listValues(inspected.engineeringHints, 8, (item) => item)}`,
  ].filter(Boolean);
  return truncateText(redactSensitiveText(sections.join("\n")), maxChars);
}

export async function readCodebaseMap(projectRoot = process.cwd()) {
  const paths = projectPaths(projectRoot);
  try {
    // A generated cache is a specific project-owned entry, never a read-only
    // root or a user-authorized alias to another control file. The selected
    // workspace root may itself be an alias, as with ordinary native files.
    const boundary = await createWorkspaceReadBoundary({ root: paths.root, writeAccess: true });
    const canonical = await boundary.resolve(paths.codebaseMapPath);
    await assertCacheEntry(canonical);
    const { content: raw } = await readWorkspaceFileSnapshot(paths.codebaseMapPath, boundary, { maxBytes: MAX_MAP_BYTES, text: true });
    await assertCacheEntry(canonical);
    let map;
    try { map = JSON.parse(raw); } catch { /* Invalid optional metadata stays unavailable. */ }
    if (!validMap(map, paths.root)) return { ok: false, path: paths.codebaseMapPath, reason: "invalid-map" };
    return {
      ok: true,
      path: paths.codebaseMapPath,
      map,
    };
  } catch (error) {
    return {
      ok: false,
      path: paths.codebaseMapPath,
      reason: error?.code === "ENOENT" ? "missing" : error instanceof Error ? error.message : String(error),
    };
  }
}

export async function refreshCodebaseMap(config, options = {}) {
  if (!config.allowFileTools) {
    return { ok: false, reason: "workspace file tools disabled" };
  }
  const projectRoot = path.resolve(options.projectRoot || config.commandCwd || config.baseDir || process.cwd());
  const paths = projectPaths(projectRoot);
  const inspected = await executeWorkspaceTool(
    "inspect_project",
    {
      path: options.path || ".",
      maxDepth: options.maxDepth || 4,
      limit: options.limit || 1000,
      includeFiles: Boolean(options.includeFiles),
    },
    {
      ...config,
      commandCwd: projectRoot,
      allowFileTools: true,
    }
  );

  if (!inspected?.ok) {
    return {
      ok: false,
      path: paths.codebaseMapPath,
      reason: inspected?.reason || inspected?.error || "inspect_project failed",
    };
  }

  const inspection = compactInspection(inspected);
  const fingerprint = mapFingerprint(inspection);
  const map = {
    version: MAP_VERSION,
    generatedAt: new Date().toISOString(),
    projectRoot: paths.root,
    commandCwd: projectRoot,
    fingerprint,
    inspection,
  };
  if (!validMap(map, paths.root)) throw new Error("Generated project overview has invalid version-1 data.");

  await ensureRuntimeGitExcludes(projectRoot, [".aginti/codebase-map.json"]).catch(() => {});
  // Reuse the guarded native publisher: child directory symlinks, final
  // symlinks/hardlinks and unsafe incumbents are refused before truncation.
  // It stages and syncs complete JSON before atomic publication. These are
  // path-policy checks, not retained-descriptor or same-UID isolation proof.
  const { publication } = await publishWorkspaceTextFile({
    root: paths.root, absolutePath: paths.codebaseMapPath,
    relativePath: ".aginti/codebase-map.json", outsideWorkspace: false,
  }, Buffer.from(`${JSON.stringify(map, null, 2)}\n`));
  if (publication.stagingCleanupPending) {
    return { ok: false, path: paths.codebaseMapPath, publication,
      reason: "Project cache was published, but staging cleanup is pending; the optional cache is not ready." };
  }
  return {
    ok: true,
    path: paths.codebaseMapPath,
    map,
    contextPack: codebaseMapToContextPack(map),
  };
}
