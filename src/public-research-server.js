import crypto from "node:crypto";
import http from "node:http";
import { getPublicResearchWrapperStatus, runPublicResearchWrapper } from "./public-research-wrapper.js";
import { redactSensitiveText } from "./redaction.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3211;
const DEFAULT_BODY_BYTES = 16 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function safeTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""), "utf8");
  const expectedBuffer = Buffer.from(String(expected || ""), "utf8");
  if (!actualBuffer.length || actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function requestAuthorized(req, expectedToken) {
  if (!expectedToken) return true;
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && safeTokenEqual(match[1], expectedToken));
}

async function readJsonBody(req, maxBodyBytes) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    throw error;
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      const error = new Error(`Request body exceeds ${maxBodyBytes} bytes.`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Request body must contain valid JSON.");
    error.status = 400;
    throw error;
  }
}

function normalizePathname(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
}

export function createPublicResearchHttpServer(options = {}) {
  const env = options.env || process.env;
  const host = String(options.host || env.AGINTI_PUBLIC_RESEARCH_HOST || DEFAULT_HOST).trim();
  const expectedToken = String(options.bearerToken ?? env.AGINTI_PUBLIC_RESEARCH_BEARER_TOKEN ?? "");
  const allowRemote = truthy(options.allowRemote ?? env.AGINTI_PUBLIC_RESEARCH_ALLOW_REMOTE);
  const maxBodyBytes = boundedInteger(
    options.maxBodyBytes ?? env.AGINTI_PUBLIC_RESEARCH_MAX_BODY_BYTES,
    DEFAULT_BODY_BYTES,
    { min: 1024, max: 64 * 1024 }
  );
  const run = options.run || ((body) => runPublicResearchWrapper(body, env));
  const status = options.status || (() => getPublicResearchWrapperStatus(env));

  if (!LOOPBACK_HOSTS.has(host) && !allowRemote) {
    throw new Error("Public research server binds to loopback by default; remote binding requires explicit enablement.");
  }
  if (!LOOPBACK_HOSTS.has(host) && !expectedToken) {
    throw new Error("Remote public research binding requires a server-owned bearer token.");
  }

  const server = http.createServer(async (req, res) => {
    const pathname = normalizePathname(req);
    if (req.method === "GET" && pathname === "/health") {
      writeJson(res, 200, { ok: true, service: "aginti-public-research" });
      return;
    }

    if (!requestAuthorized(req, expectedToken)) {
      writeJson(res, 401, { ok: false, error: "Unauthorized.", code: "unauthorized" });
      return;
    }

    if (req.method === "GET" && pathname === "/ready") {
      const current = status();
      writeJson(res, current.available ? 200 : 503, current);
      return;
    }

    if (
      req.method === "GET" &&
      ["/v1/research/status", "/api/public-research/status"].includes(pathname)
    ) {
      writeJson(res, 200, status());
      return;
    }

    if (
      req.method === "POST" &&
      ["/v1/research", "/api/public-research"].includes(pathname)
    ) {
      try {
        const body = await readJsonBody(req, maxBodyBytes);
        const result = await run(body);
        writeJson(res, result.ok ? 200 : result.status || (result.blocked ? 429 : 503), result);
      } catch (error) {
        writeJson(res, Number(error?.status) || 400, {
          ok: false,
          error: redactSensitiveText(error instanceof Error ? error.message : "Invalid request."),
          code: "invalid_request",
        });
      }
      return;
    }

    writeJson(res, 404, { ok: false, error: "Not found.", code: "not_found" });
  });

  server.headersTimeout = 5000;
  server.requestTimeout = 310000;
  server.keepAliveTimeout = 5000;

  return { server, host, maxBodyBytes };
}

export async function listenPublicResearchServer(options = {}) {
  const env = options.env || process.env;
  const port = boundedInteger(options.port ?? env.AGINTI_PUBLIC_RESEARCH_PORT, DEFAULT_PORT, {
    min: 1,
    max: 65535,
  });
  const created = createPublicResearchHttpServer(options);
  await new Promise((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(port, created.host, resolve);
  });
  const address = created.server.address();
  return {
    ...created,
    port: typeof address === "object" && address ? address.port : port,
    url: `http://${created.host}:${typeof address === "object" && address ? address.port : port}`,
  };
}
