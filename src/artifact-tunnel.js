import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "./redaction.js";
import { checkWorkspaceToolUse, resolveWorkspacePath } from "./workspace-tools.js";

const MAX_INLINE_TEXT_BYTES = 120_000;
const MAX_ARTIFACT_TEXT_BYTES = 520_000;
const MAX_ARTIFACT_IMAGE_BYTES = 4_000_000;
const MAX_PERSISTED_CANVAS_FILE_BYTES = 50_000_000;
const IMAGE_MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);
const BINARY_RENDER_MIME_BY_EXT = new Map([[".pdf", "application/pdf"]]);

function normalizeDisplayPath(value) {
  return String(value || "")
    .split(path.sep)
    .join("/");
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stableId(...parts) {
  return crypto.createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\0")).digest("base64url");
}

function previewText(value, limit = 220) {
  const text = redactSensitiveText(String(value || "")).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit).trim()}...` : text;
}

function normalizeKind(kind, filePath = "") {
  const candidate = String(kind || "").toLowerCase();
  if (candidate === "file") {
    if (IMAGE_MIME_BY_EXT.has(path.extname(String(filePath || "")).toLowerCase())) return "image";
    if (BINARY_RENDER_MIME_BY_EXT.has(path.extname(String(filePath || "")).toLowerCase())) return "pdf";
    if (String(filePath || "").toLowerCase().endsWith(".json")) return "json";
    if (String(filePath || "").toLowerCase().endsWith(".md")) return "markdown";
    return "file";
  }
  if (["image", "markdown", "text", "json", "diff", "pdf"].includes(candidate)) return candidate;
  if (IMAGE_MIME_BY_EXT.has(path.extname(String(filePath || "")).toLowerCase())) return "image";
  if (BINARY_RENDER_MIME_BY_EXT.has(path.extname(String(filePath || "")).toLowerCase())) return "pdf";
  if (String(filePath || "").toLowerCase().endsWith(".json")) return "json";
  if (String(filePath || "").toLowerCase().endsWith(".md")) return "markdown";
  return "text";
}

function mimeForPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return IMAGE_MIME_BY_EXT.get(ext) || BINARY_RENDER_MIME_BY_EXT.get(ext) || "text/plain; charset=utf-8";
}

function safeCanvasFilename(artifactId, filePath) {
  const rawBase = path.basename(String(filePath || "artifact"));
  const safeBase = rawBase
    .replace(/^\.+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 90);
  return `${String(artifactId || "canvas").replace(/[^A-Za-z0-9._-]+/g, "-")}-${safeBase || "artifact"}`;
}

function publicArtifact(item) {
  return {
    id: item.id,
    sessionId: item.sessionId,
    kind: item.kind,
    title: item.title,
    path: item.path || "",
    preview: item.preview || "",
    source: item.source,
    tab: item.tab,
    createdAt: item.createdAt,
    selected: Boolean(item.selected),
    mime: item.mime || "",
  };
}

function sessionRelativePath(store, filePath) {
  const absolutePath = path.resolve(String(filePath || ""));
  if (!isInside(store.sessionDir, absolutePath)) return "";
  return normalizeDisplayPath(path.relative(store.sessionDir, absolutePath));
}

function addSnapshotArtifacts(items, event, store, sessionId) {
  const data = event.data || {};
  if (data.screenshotPath) {
    const displayPath = sessionRelativePath(store, data.screenshotPath);
    if (displayPath) {
      items.push({
        id: stableId(sessionId, event.timestamp, "snapshot-image", displayPath),
        sessionId,
        kind: "image",
        title: `Browser screenshot step ${data.step || "?"}`,
        path: displayPath,
        preview: data.title || data.url || "Captured browser screenshot.",
        source: "snapshot",
        tab: "canvas",
        createdAt: event.timestamp,
        mime: "image/png",
        ref: {
          type: "session-file",
          path: path.resolve(data.screenshotPath),
        },
      });
    }
  }

  if (data.snapshotPath) {
    const displayPath = sessionRelativePath(store, data.snapshotPath);
    if (displayPath) {
      items.push({
        id: stableId(sessionId, event.timestamp, "snapshot-json", displayPath),
        sessionId,
        kind: "json",
        title: `Runtime snapshot step ${data.step || "?"}`,
        path: displayPath,
        preview: data.title || data.url || "Browser/runtime snapshot JSON.",
        source: "snapshot",
        tab: "explorer",
        createdAt: event.timestamp,
        mime: "application/json",
        ref: {
          type: "session-file",
          path: path.resolve(data.snapshotPath),
        },
      });
    }
  }
}

function addWorkspaceArtifacts(items, event, sessionId) {
  const data = event.data || {};
  const filePath = normalizeDisplayPath(data.path || "");
  if (!filePath) return;

  const diff = redactSensitiveText(String(data.diff || ""));
  items.push({
    id: stableId(sessionId, event.timestamp, "file-diff", filePath, diff),
    sessionId,
    kind: "diff",
    title: `Change: ${filePath}`,
    path: filePath,
    preview: previewText(diff || `${data.toolName || "file tool"} changed ${filePath}`),
    source: "file-change",
    tab: "notifications",
    createdAt: event.timestamp,
    mime: "text/x-diff",
    ref: {
      type: "inline",
      text: diff || JSON.stringify(data, null, 2),
    },
  });

  items.push({
    id: stableId(sessionId, event.timestamp, "workspace-file", filePath),
    sessionId,
    kind: normalizeKind("file", filePath),
    title: `Workspace file: ${filePath}`,
    path: filePath,
    preview: "Open the current workspace file through guarded read policy.",
    source: "workspace-file",
    tab: "explorer",
    createdAt: event.timestamp,
    mime: mimeForPath(filePath),
    ref: {
      type: "workspace-file",
      path: filePath,
      commandCwd: data.commandCwd || "",
    },
  });
}

function addCanvasArtifact(items, event, sessionId, store) {
  const data = event.data || {};
  const artifactId = data.artifactId || stableId(sessionId, event.timestamp, "canvas", data.title, data.path);
  const artifactPath = normalizeDisplayPath(data.path || "");
  const sessionFilePath = typeof data.sessionFilePath === "string" ? path.resolve(data.sessionFilePath) : "";
  const sessionRef =
    sessionFilePath && store?.sessionDir && isInside(store.sessionDir, sessionFilePath)
      ? {
          type: "session-file",
          path: sessionFilePath,
        }
      : null;
  const text = typeof data.content === "string" ? redactSensitiveText(data.content) : "";
  items.push({
    id: artifactId,
    sessionId,
    kind: normalizeKind(data.kind, artifactPath),
    title: String(data.title || "Agent canvas item").slice(0, 120),
    path: artifactPath,
    preview: previewText(data.note || text || artifactPath || "Agent selected this item for canvas display."),
    source: "agent-canvas",
    tab: "canvas",
    createdAt: event.timestamp,
    mime: mimeForPath(sessionRef?.path || artifactPath),
    ref: text
      ? {
          type: "inline",
          text,
        }
      : sessionRef
        ? sessionRef
        : artifactPath
        ? {
            type: "workspace-file",
            path: artifactPath,
            commandCwd: data.commandCwd || "",
          }
        : {
            type: "inline",
            text: redactSensitiveText(String(data.note || "")),
          },
  });
}

function addFinalAnswerArtifact(items, event, sessionId) {
  const result = String(event.data?.result || "");
  if (!result.trim()) return;
  items.push({
    id: stableId(sessionId, event.timestamp, "final-answer", result),
    sessionId,
    kind: "markdown",
    title: "Final answer",
    path: "",
    preview: previewText(result),
    source: "session",
    tab: "notifications",
    createdAt: event.timestamp,
    mime: "text/markdown; charset=utf-8",
    ref: {
      type: "inline",
      text: redactSensitiveText(result),
    },
  });
}

function selectedArtifactId(events) {
  return [...events].reverse().find((event) => event.type === "canvas.selected")?.data?.artifactId || "";
}

export function buildArtifacts({ sessionId, events, store }) {
  const items = [];
  const selectedId = selectedArtifactId(events);

  for (const event of events) {
    if (event.type === "canvas.item") addCanvasArtifact(items, event, sessionId, store);
    if (event.type === "snapshot.captured") addSnapshotArtifacts(items, event, store, sessionId);
    if (event.type === "file.changed") addWorkspaceArtifacts(items, event, sessionId);
    if (event.type === "session.finished") addFinalAnswerArtifact(items, event, sessionId);
  }

  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const fallbackSelected = selectedId || items.find((item) => item.tab === "canvas")?.id || items[0]?.id || "";
  for (const item of items) item.selected = item.id === fallbackSelected;

  return {
    items,
    selectedItemId: fallbackSelected,
  };
}

export function serializeArtifacts(items) {
  return items.map(publicArtifact);
}

export function countUnreadArtifacts(items, seenAfter = "") {
  const seenAt = Date.parse(String(seenAfter || ""));
  if (!Number.isFinite(seenAt)) return items.length;
  return items.filter((item) => Date.parse(item.createdAt) > seenAt).length;
}

export function findArtifact(items, artifactId) {
  return items.find((item) => item.id === artifactId) || null;
}

export async function readArtifactContent(item, { store, config }) {
  if (!item) {
    return { ok: false, error: "Artifact not found." };
  }

  if (item.ref?.type === "inline") {
    return {
      ok: true,
      id: item.id,
      kind: item.kind,
      title: item.title,
      path: item.path || "",
      mime: item.mime || "text/plain; charset=utf-8",
      text: redactSensitiveText(String(item.ref.text || "")),
    };
  }

  if (item.ref?.type === "session-file") {
    const absolutePath = path.resolve(item.ref.path);
    if (!isInside(store.sessionDir, absolutePath)) {
      return { ok: false, error: "Artifact path is outside this session." };
    }

    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) return { ok: false, error: "Artifact file is missing." };
    const mime = mimeForPath(absolutePath);
    const isBinaryRenderable = mime.startsWith("image/") || mime === "application/pdf";
    const maxBytes = isBinaryRenderable ? MAX_ARTIFACT_IMAGE_BYTES : MAX_ARTIFACT_TEXT_BYTES;
    if (stat.size > maxBytes) return { ok: false, error: "Artifact is too large to preview safely." };

    const buffer = await fs.readFile(absolutePath);
    if (isBinaryRenderable) {
      return {
        ok: true,
        id: item.id,
        kind: mime === "application/pdf" ? "pdf" : "image",
        title: item.title,
        path: item.path || "",
        mime,
        dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
      };
    }

    if (buffer.includes(0)) return { ok: false, error: "Binary artifact cannot be rendered as text." };
    return {
      ok: true,
      id: item.id,
      kind: item.kind,
      title: item.title,
      path: item.path || "",
      mime,
      text: redactSensitiveText(buffer.toString("utf8")),
    };
  }

  if (item.ref?.type === "workspace-file") {
    const itemConfig = item.ref.commandCwd ? { ...config, commandCwd: item.ref.commandCwd } : config;
    const guard = checkWorkspaceToolUse("read_file", { path: item.ref.path }, itemConfig);
    if (!guard.allowed) {
      return { ok: false, error: guard.reason || "Workspace read blocked." };
    }

    const target = resolveWorkspacePath(itemConfig, item.ref.path);
    const stat = await fs.stat(target.absolutePath).catch(() => null);
    if (!stat?.isFile()) return { ok: false, error: "Workspace file is missing." };

    const mime = mimeForPath(target.absolutePath);
    const isBinaryRenderable = mime.startsWith("image/") || mime === "application/pdf";
    const maxBytes = isBinaryRenderable ? MAX_ARTIFACT_IMAGE_BYTES : MAX_ARTIFACT_TEXT_BYTES;
    if (stat.size > maxBytes) return { ok: false, error: "Workspace file is too large to preview safely." };

    const buffer = await fs.readFile(target.absolutePath);
    if (isBinaryRenderable) {
      return {
        ok: true,
        id: item.id,
        kind: mime === "application/pdf" ? "pdf" : "image",
        title: item.title,
        path: item.path || "",
        mime,
        dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
      };
    }

    if (buffer.includes(0)) return { ok: false, error: "Binary workspace file cannot be rendered as text." };
    return {
      ok: true,
      id: item.id,
      kind: item.kind,
      title: item.title,
      path: item.path || "",
      mime,
      text: redactSensitiveText(buffer.toString("utf8")),
    };
  }

  return { ok: false, error: "Artifact has no readable content." };
}

export function normalizeCanvasPayload(args, config) {
  const artifactId = `canvas-${crypto.randomUUID()}`;
  const title = String(args.title || "Agent canvas item").replace(/\s+/g, " ").trim().slice(0, 120);
  const pathInput = String(args.path || "").trim();
  const content = typeof args.content === "string" ? args.content : "";
  const note = typeof args.note === "string" ? args.note : "";

  if (!title) {
    return { ok: false, reason: "Canvas title is required." };
  }

  if (Buffer.byteLength(content, "utf8") > MAX_INLINE_TEXT_BYTES) {
    return { ok: false, reason: "Canvas content is too large. Write it to a workspace file and send the path instead." };
  }

  let relativePath = "";
  if (pathInput) {
    const guard = checkWorkspaceToolUse("read_file", { path: pathInput }, config);
    if (!guard.allowed) return { ok: false, reason: guard.reason || "Canvas path is blocked." };
    relativePath = resolveWorkspacePath(config, pathInput).relativePath;
  }

  return {
    ok: true,
    payload: {
      artifactId,
      title,
      kind: normalizeKind(args.kind, relativePath),
      path: relativePath,
      content: content ? redactSensitiveText(content) : "",
      contentBytes: content ? Buffer.byteLength(content, "utf8") : 0,
      note: note ? previewText(note, 500) : "",
      selected: args.selected !== false,
    },
  };
}

export async function persistCanvasPayloadFile(payload, { config, store }) {
  if (!payload?.path) return { ok: true, payload };
  if (!store?.artifactsDir || !store?.sessionDir) {
    return { ok: false, reason: "Canvas session artifact store is unavailable." };
  }

  let target;
  try {
    target = resolveWorkspacePath(config, payload.path);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const stat = await fs.stat(target.absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    return { ok: false, reason: `Canvas path does not exist or is not a file: ${payload.path}` };
  }

  if (stat.size > MAX_PERSISTED_CANVAS_FILE_BYTES) {
    return {
      ok: true,
      payload: {
        ...payload,
        originalPath: payload.path,
        artifactPersisted: false,
        artifactBytes: stat.size,
        artifactPersistenceWarning: `Canvas file is larger than ${MAX_PERSISTED_CANVAS_FILE_BYTES} bytes; keep the workspace file for preview.`,
      },
    };
  }

  await store.ensure();
  const canvasDir = path.join(store.artifactsDir, "canvas");
  await fs.mkdir(canvasDir, { recursive: true });
  const sessionFilePath = path.join(canvasDir, safeCanvasFilename(payload.artifactId, target.relativePath));
  await fs.copyFile(target.absolutePath, sessionFilePath);

  return {
    ok: true,
    payload: {
      ...payload,
      originalPath: payload.path,
      sessionPath: normalizeDisplayPath(path.relative(store.sessionDir, sessionFilePath)),
      sessionFilePath,
      artifactPersisted: true,
      artifactBytes: stat.size,
    },
  };
}
