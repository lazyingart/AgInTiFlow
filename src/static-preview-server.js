import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const root = path.resolve(process.argv[2] || process.cwd());
const port = Number(process.argv[3] || 0);
const host = "127.0.0.1";

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
  if (segments.includes(".git") || segments.includes("node_modules") || segments.includes(".sessions")) return true;
  if (lowerBase === ".env" || lowerBase.startsWith(".env.")) return true;
  if (lowerBase === ".npmrc" || lowerBase === ".pypirc") return true;
  return /(^|\/)(secrets?|tokens?|passwords?|private[-_]?keys?|credentials?)(\/|\.|$)/i.test(lowerPath);
}

const server = http.createServer(async (req, res) => {
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

    let filePath = target;
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    const finalStat = await fs.stat(filePath).catch(() => null);
    if (!finalStat?.isFile()) {
      send(res, 404, "Not Found");
      return;
    }

    const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": finalStat.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const content = await fs.readFile(filePath);
    res.end(content);
  } catch (error) {
    send(res, 500, error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`AgInTiFlow static preview http://${host}:${actualPort}/ root=${root}`);
});
