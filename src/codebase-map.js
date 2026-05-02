import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { projectPaths } from "./project.js";
import { redactSensitiveText } from "./redaction.js";
import { executeWorkspaceTool } from "./workspace-tools.js";

const MAP_VERSION = 1;
const DEFAULT_CONTEXT_PACK_CHARS = 3800;

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
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
  if (!map?.inspection) return "Context pack: no durable codebase map available.";
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
    const raw = await fs.readFile(paths.codebaseMapPath, "utf8");
    return {
      ok: true,
      path: paths.codebaseMapPath,
      map: JSON.parse(raw),
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
  const fingerprint = stableHash({
    summary: inspection.summary,
    counts: inspection.counts,
    manifests: inspection.manifestFiles.map((item) => item.path),
    sourceDirs: inspection.sourceDirs.map((item) => item.path),
    tests: inspection.testFiles.map((item) => item.path),
    packageScripts: inspection.packageScripts,
    languages: inspection.languageCounts,
  });
  const map = {
    version: MAP_VERSION,
    generatedAt: new Date().toISOString(),
    projectRoot: paths.root,
    commandCwd: projectRoot,
    fingerprint,
    inspection,
  };

  await fs.mkdir(paths.controlDir, { recursive: true });
  await fs.writeFile(paths.codebaseMapPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  return {
    ok: true,
    path: paths.codebaseMapPath,
    map,
    contextPack: codebaseMapToContextPack(map),
  };
}
