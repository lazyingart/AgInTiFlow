import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { agintiflowHome } from "./session-index.js";
import { redactSensitiveText, redactValue } from "./redaction.js";

const MAX_PREVIEW_CHARS = 360;
const MAX_EVENTS_FILE_BYTES = 8 * 1024 * 1024;
let queue = Promise.resolve();

function enabled() {
  return String(process.env.AGINTIFLOW_HOUSEKEEPING || "1").toLowerCase() !== "0";
}

export function housekeepingPaths(home = agintiflowHome()) {
  const root = path.join(home, "housekeeping");
  return {
    root,
    eventsPath: path.join(root, "events.jsonl"),
    capabilitiesPath: path.join(root, "capabilities.json"),
    readmePath: path.join(root, "README.md"),
  };
}

function hashText(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function redactContextText(value = "", context = {}) {
  let text = redactSensitiveText(value);
  const replacements = [
    [context.projectRoot, "$PROJECT"],
    [context.commandCwd, "$CWD"],
    [os.homedir(), "~"],
  ].filter(([needle]) => needle && typeof needle === "string");
  for (const [needle, replacement] of replacements) {
    text = text.split(needle).join(replacement);
  }
  return text;
}

function previewText(value = "", context = {}, limit = MAX_PREVIEW_CHARS) {
  const text = redactContextText(String(value ?? ""), context).replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(limit - 1, 1))}...`;
}

function sanitizePath(value = "", context = {}) {
  const text = redactContextText(String(value || ""), context);
  if (!text) return "";
  if (text.startsWith("$PROJECT/") || text.startsWith("$CWD/") || text.startsWith("~/")) return text;
  if (path.isAbsolute(text)) return path.basename(text);
  return text;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function safeProjectName(projectRoot = "") {
  return projectRoot ? path.basename(projectRoot) : "";
}

function sanitizeToolCalls(toolCalls = [], context = {}) {
  return safeArray(toolCalls).slice(0, 20).map((call) => {
    const name = call.name || call.function?.name || "";
    const args = call.arguments || call.function?.arguments || "";
    return {
      id: call.id ? hashText(call.id) : "",
      name,
      argumentsPreview: previewText(args, context, 260),
      argumentsHash: args ? hashText(args) : "",
    };
  });
}

function sanitizeEvent(type, data = {}, context = {}) {
  const redacted = redactValue(data || {});
  const base = {
    type,
    sessionId: context.sessionId || "",
    projectHash: context.projectRoot ? hashText(path.resolve(context.projectRoot)) : "",
    projectName: safeProjectName(context.projectRoot),
  };

  if (type === "session.created" || type === "session.resumed" || type === "session.finished" || type === "session.stopped") {
    return {
      ...base,
      provider: redacted.provider || "",
      model: redacted.model || "",
      routingMode: redacted.routingMode || "",
      routeReason: redacted.routeReason || "",
      reason: redacted.reason || "",
      mode: redacted.mode || "",
      goalPreview: previewText(redacted.goal || "", context),
      goalHash: redacted.goal ? hashText(redacted.goal) : "",
      resultPreview: previewText(redacted.result || "", context),
      resultHash: redacted.result ? hashText(redacted.result) : "",
    };
  }

  if (type === "skills.selected") {
    return {
      ...base,
      taskProfile: redacted.taskProfile || "",
      skills: safeArray(redacted.skills).map(String).slice(0, 30),
      goalHash: redacted.goal ? hashText(redacted.goal) : "",
    };
  }

  if (type === "model.requested") {
    return {
      ...base,
      step: redacted.step || 0,
      provider: redacted.provider || "",
      model: redacted.model || "",
    };
  }

  if (type === "model.responded") {
    const content = String(redacted.content || "");
    return {
      ...base,
      step: redacted.step || 0,
      contentPreview: previewText(content, context),
      contentHash: content ? hashText(content) : "",
      contentChars: content.length,
      toolCalls: sanitizeToolCalls(redacted.toolCalls, context),
    };
  }

  if (type.startsWith("tool.")) {
    return {
      ...base,
      toolName: redacted.toolName || "",
      ok: redacted.ok,
      blocked: Boolean(redacted.blocked),
      category: redacted.commandPolicy?.category || redacted.category || "",
      commandPreview: previewText(redacted.args?.command || redacted.command || "", context, 260),
      path: sanitizePath(redacted.path || redacted.args?.path || "", context),
      stdoutPreview: previewText(redacted.stdout || "", context, 220),
      stderrPreview: previewText(redacted.stderr || redacted.error || redacted.reason || "", context, 220),
    };
  }

  if (type === "file.changed") {
    const diff = String(redacted.diff || "");
    return {
      ...base,
      toolName: redacted.toolName || "",
      path: sanitizePath(redacted.path || "", context),
      beforeHash: redacted.beforeHash || "",
      afterHash: redacted.afterHash || "",
      diffPreview: previewText(diff, context, 260),
      diffHash: diff ? hashText(diff) : "",
      skillTouched: /^skills\/[^/]+\/SKILL\.md$/.test(String(redacted.path || "")),
    };
  }

  if (type === "plan.created") {
    const plan = String(redacted.plan || "");
    return {
      ...base,
      planPreview: previewText(plan, context),
      planHash: plan ? hashText(plan) : "",
    };
  }

  if (type === "parallel_scouts.completed") {
    return {
      ...base,
      model: redacted.model || "",
      requested: redacted.requested || 0,
      completed: redacted.completed || 0,
      scoutNames: safeArray(redacted.scouts).map((scout) => scout.name || "").filter(Boolean).slice(0, 20),
      synthesisHash: redacted.synthesis ? hashText(redacted.synthesis) : "",
    };
  }

  if (type.startsWith("canvas.") || type === "image.generated") {
    return {
      ...base,
      kind: redacted.kind || "",
      title: previewText(redacted.title || "", context, 160),
      path: sanitizePath(redacted.path || redacted.outputPath || redacted.artifactPath || "", context),
      notePreview: previewText(redacted.note || redacted.preview || "", context, 220),
    };
  }

  return {
    ...base,
    dataPreview: previewText(JSON.stringify(redacted), context),
    dataHash: hashText(JSON.stringify(redacted)),
  };
}

function emptyCapabilities() {
  return {
    version: 1,
    updatedAt: "",
    totals: {
      events: 0,
      sessions: 0,
      modelRequests: 0,
      modelResponses: 0,
      toolEvents: 0,
      skillSelections: 0,
      skillFileChanges: 0,
    },
    models: {},
    tools: {},
    skills: {},
    sessions: {},
    projects: {},
  };
}

async function readCapabilities(paths) {
  try {
    return JSON.parse(await fs.readFile(paths.capabilitiesPath, "utf8"));
  } catch {
    return emptyCapabilities();
  }
}

function bumpCounter(map, key, patch = {}) {
  if (!key) return;
  const current = map[key] || { count: 0 };
  map[key] = {
    ...current,
    ...patch,
    count: (current.count || 0) + 1,
    lastSeenAt: patch.lastSeenAt || new Date().toISOString(),
  };
}

async function maybeRotateEvents(paths) {
  const stat = await fs.stat(paths.eventsPath).catch(() => null);
  if (!stat || stat.size < MAX_EVENTS_FILE_BYTES) return;
  const rotated = path.join(paths.root, `events-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  await fs.rename(paths.eventsPath, rotated).catch(() => {});
}

async function ensureReadme(paths) {
  await fs.writeFile(
    paths.readmePath,
    [
      "# AgInTiFlow Housekeeping",
      "",
      "This folder stores local, redacted learning logs derived from session events.",
      "",
      "- `events.jsonl` is a sanitized cross-session event feed.",
      "- `capabilities.json` aggregates models, tools, selected skills, and touched skill files.",
      "- Full session history remains in `~/.agintiflow/sessions/<session-id>/` and should not be committed.",
      "",
      "The housekeeping files are local by default. Share only reviewed, sanitized capability packs.",
      "",
    ].join("\n"),
    "utf8"
  ).catch(() => {});
}

async function recordEvent(record) {
  const paths = housekeepingPaths();
  await fs.mkdir(paths.root, { recursive: true });
  await ensureReadme(paths);
  await maybeRotateEvents(paths);
  const timestamp = record.timestamp || new Date().toISOString();
  await fs.appendFile(paths.eventsPath, `${JSON.stringify({ timestamp, ...record })}\n`, "utf8");

  const capabilities = await readCapabilities(paths);
  capabilities.updatedAt = timestamp;
  capabilities.totals.events = (capabilities.totals.events || 0) + 1;
  bumpCounter(capabilities.projects, record.projectHash || "unknown", {
    name: record.projectName || "",
    lastSeenAt: timestamp,
  });

  capabilities.sessions ||= {};
  if (record.sessionId) {
    capabilities.sessions[record.sessionId] = {
      projectHash: record.projectHash || "",
      lastSeenAt: timestamp,
    };
    capabilities.totals.sessions = Object.keys(capabilities.sessions).length;
  }
  if (record.type === "model.requested") {
    capabilities.totals.modelRequests = (capabilities.totals.modelRequests || 0) + 1;
    bumpCounter(capabilities.models, `${record.provider}/${record.model}`, { lastSeenAt: timestamp });
  }
  if (record.type === "model.responded") {
    capabilities.totals.modelResponses = (capabilities.totals.modelResponses || 0) + 1;
  }
  if (record.type?.startsWith("tool.")) {
    capabilities.totals.toolEvents = (capabilities.totals.toolEvents || 0) + 1;
    bumpCounter(capabilities.tools, record.toolName || "unknown", {
      category: record.category || "",
      lastSeenAt: timestamp,
    });
  }
  if (record.type === "skills.selected") {
    capabilities.totals.skillSelections = (capabilities.totals.skillSelections || 0) + 1;
    for (const skill of record.skills || []) {
      bumpCounter(capabilities.skills, skill, { source: "selected", lastSeenAt: timestamp });
    }
  }
  if (record.type === "file.changed" && record.skillTouched) {
    capabilities.totals.skillFileChanges = (capabilities.totals.skillFileChanges || 0) + 1;
    const skillId = String(record.path || "").split("/")[1] || "unknown";
    bumpCounter(capabilities.skills, skillId, { source: "skill-file-change", lastSeenAt: timestamp });
  }

  await fs.writeFile(paths.capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`, "utf8");
}

export function enqueueHousekeepingEvent({ sessionId = "", projectRoot = "", commandCwd = "", event = {} } = {}) {
  if (!enabled()) return;
  const timestamp = event.timestamp || new Date().toISOString();
  const context = { sessionId, projectRoot, commandCwd };
  const record = {
    timestamp,
    ...sanitizeEvent(event.type || "event", event.data || {}, context),
  };
  queue = queue.then(() => recordEvent(record)).catch(() => {});
}

export async function flushHousekeeping() {
  await queue.catch(() => {});
}

export async function readHousekeepingSummary() {
  const paths = housekeepingPaths();
  return {
    paths,
    capabilities: await readCapabilities(paths),
  };
}
