import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createWorkspaceReadBoundary, readWorkspaceFileSnapshot } from "./workspace-read-boundary.js";

const root = path.resolve(process.argv[2] || process.cwd());
const port = Number(process.argv[3] || 0);
const host = "127.0.0.1";
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const idleTtlMs = Math.max(Number(process.env.AGINTIFLOW_PREVIEW_TTL_MS) || 6 * 60 * 60 * 1000, 1000);
let lastRequestAt = Date.now();

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
]);

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function normalizeUrlPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
  const withoutLeadingSlash = decoded.replace(/^\/+/, "") || "index.html";
  return path.normalize(withoutLeadingSlash);
}

function isInsideRoot(target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isBlockedPath(relativePath) {
  const segments = relativePath.split(path.sep).filter(Boolean);
  const lowerBase = (segments.at(-1) || "").toLowerCase();
  const lowerPath = segments.join("/").toLowerCase();
  if (
    segments.includes(".git") ||
    segments.includes("node_modules") ||
    segments.includes(".sessions") ||
    segments.includes(".aginti-sessions")
  ) {
    return true;
  }
  if (lowerBase === ".env" || lowerBase.startsWith(".env.")) return true;
  if (lowerBase === ".npmrc" || lowerBase === ".pypirc") return true;
  return /(^|\/)(secrets?|tokens?|passwords?|private[-_]?keys?|credentials?)(\/|\.|$)/i.test(lowerPath);
}

const boundary = await createWorkspaceReadBoundary({
  root, blockedPath: (canonical, canonicalRoot) => isBlockedPath(path.relative(canonicalRoot, canonical)),
});
const server = http.createServer(async (req, res) => {
  lastRequestAt = Date.now();
  if (!["GET", "HEAD"].includes(req.method || "")) {
    send(res, 405, "Method Not Allowed");
    return;
  }

  try {
    const relative = normalizeUrlPath(req.url || "/");
    const target = path.resolve(root, relative);
    if (!isInsideRoot(target) || isBlockedPath(path.relative(root, target))) {
      send(res, 403, "Forbidden");
      return;
    }
    await boundary.verifyRoots();

    let filePath = target;
    const canonical = await boundary.resolve(filePath);
    const stat = await fs.stat(canonical);
    if (stat?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    const finalCanonical = await boundary.resolve(filePath);
    const finalStat = await fs.stat(finalCanonical);
    if (!finalStat?.isFile()) {
      send(res, 404, "Not Found");
      return;
    }

    const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    if (finalStat.size > MAX_PREVIEW_BYTES) { send(res, 413, "Preview file is too large."); return; }
    await boundary.revalidate(filePath, finalCanonical);
    const headers = {
      "Content-Type": contentType,
      "Content-Length": finalStat.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (req.method === "HEAD") {
      send(res, 200, undefined, headers);
      return;
    }
    const { buffer } = await readWorkspaceFileSnapshot(filePath, boundary, { maxBytes: MAX_PREVIEW_BYTES });
    send(res, 200, buffer, { ...headers, "Content-Length": buffer.length });
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    const code = error?.code;
    send(res, code === "WORKSPACE_READ_SCOPE" ? 403 : ["ENOENT", "ENOTDIR"].includes(code) ? 404
      : code === "WORKSPACE_READ_TOO_LARGE" ? 413 : 500,
    code === "WORKSPACE_READ_SCOPE" ? "Forbidden" : ["ENOENT", "ENOTDIR"].includes(code) ? "Not Found"
      : code === "WORKSPACE_READ_TOO_LARGE" ? "Preview file is too large." : "Preview unavailable.");
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`AgInTiFlow static preview http://${host}:${actualPort}/ root=${root}`);
});

const ttlTimer = setInterval(async () => {
  const rootExists = await fs
    .stat(root)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (rootExists && Date.now() - lastRequestAt < idleTtlMs) return;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}, Math.min(Math.max(Math.floor(idleTtlMs / 2), 1000), 60_000));
ttlTimer.unref();
