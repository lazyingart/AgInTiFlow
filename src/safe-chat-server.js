import crypto from "node:crypto";
import http from "node:http";
import { getSafeChatStatus, runSafeChat } from "./safe-chat-wrapper.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3212;
const DEFAULT_BODY_BYTES = 16 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function writeJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
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
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && safeTokenEqual(match[1], expectedToken));
}

async function readJsonBody(req, maxBodyBytes) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    error.publicCode = "invalid_request";
    throw error;
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      const error = new Error(`Request body exceeds ${maxBodyBytes} bytes.`);
      error.status = 413;
      error.publicCode = "invalid_request";
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Request body must contain valid JSON.");
    error.status = 400;
    error.publicCode = "invalid_request";
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

function requestFailure(error) {
  const status = Number(error?.status) || 400;
  const code = String(error?.publicCode || "invalid_request");
  const knownMessage =
    status === 415
      ? "Content-Type must be application/json."
      : status === 413
        ? "Safe chat request body is too large."
        : status === 400
          ? "Safe chat request body is invalid."
          : "Safe chat request failed.";
  return {
    status,
    body: {
      ok: false,
      feature: "safe-chat",
      code,
      retryable: false,
      error: knownMessage,
      modelExposed: false,
      providerExposed: false,
    },
  };
}

export function createSafeChatHttpServer(options = {}) {
  const env = options.env || process.env;
  const host = String(options.host || env.AGINTI_SAFE_CHAT_HOST || DEFAULT_HOST).trim();
  const expectedToken = String(options.bearerToken ?? env.AGINTI_SAFE_CHAT_BEARER_TOKEN ?? "").trim();
  const maxBodyBytes = boundedInteger(
    options.maxBodyBytes ?? env.AGINTI_SAFE_CHAT_MAX_BODY_BYTES,
    DEFAULT_BODY_BYTES,
    { min: 1024, max: 64 * 1024 }
  );

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("Safe chat server is loopback-only.");
  }
  if (!expectedToken) {
    throw new Error("Safe chat server requires a server-owned bearer token, including on loopback.");
  }
  if (expectedToken.length < 24) {
    throw new Error("Safe chat server bearer token must contain at least 24 characters.");
  }

  const run =
    options.run ||
    ((body, runOptions = {}) =>
      runSafeChat(body, {
        env,
        ...(options.clientFactory ? { clientFactory: options.clientFactory } : {}),
        ...(runOptions.abortSignal ? { abortSignal: runOptions.abortSignal } : {}),
      }));
  const status = options.status || (() => getSafeChatStatus(env));

  const server = http.createServer(async (req, res) => {
    if (!requestAuthorized(req, expectedToken)) {
      writeJson(res, 401, {
        ok: false,
        feature: "safe-chat",
        code: "unauthorized",
        retryable: false,
        error: "Unauthorized.",
        modelExposed: false,
        providerExposed: false,
      });
      return;
    }

    const pathname = normalizePathname(req);
    if (req.method === "GET" && pathname === "/health") {
      writeJson(res, 200, { ok: true, service: "aginti-safe-chat" });
      return;
    }
    if (req.method === "GET" && pathname === "/ready") {
      const current = status();
      writeJson(res, current.available ? 200 : 503, current);
      return;
    }
    if (
      req.method === "GET" &&
      ["/v1/chat/status", "/api/safe-chat/status"].includes(pathname)
    ) {
      writeJson(res, 200, status());
      return;
    }
    if (
      req.method === "POST" &&
      ["/v1/chat", "/api/safe-chat"].includes(pathname)
    ) {
      const disconnectController = new AbortController();
      const cancelDisconnectedRequest = () => {
        if (!res.writableEnded && !disconnectController.signal.aborted) {
          disconnectController.abort();
        }
      };
      req.once("aborted", cancelDisconnectedRequest);
      res.once("close", cancelDisconnectedRequest);
      try {
        const body = await readJsonBody(req, maxBodyBytes);
        const result = await run(body, { abortSignal: disconnectController.signal });
        writeJson(res, result.ok ? 200 : Number(result.status) || 503, result);
      } catch (error) {
        const failed = requestFailure(error);
        writeJson(res, failed.status, failed.body);
      } finally {
        req.removeListener("aborted", cancelDisconnectedRequest);
        res.removeListener("close", cancelDisconnectedRequest);
      }
      return;
    }

    writeJson(res, 404, {
      ok: false,
      feature: "safe-chat",
      code: "not_found",
      retryable: false,
      error: "Not found.",
      modelExposed: false,
      providerExposed: false,
    });
  });

  server.headersTimeout = 5000;
  server.requestTimeout = 125000;
  server.keepAliveTimeout = 5000;

  return { server, host, maxBodyBytes };
}

export async function listenSafeChatServer(options = {}) {
  const env = options.env || process.env;
  const port = boundedInteger(options.port ?? env.AGINTI_SAFE_CHAT_PORT, DEFAULT_PORT, {
    min: 1,
    max: 65535,
  });
  const created = createSafeChatHttpServer(options);
  await new Promise((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(port, created.host, resolve);
  });
  const address = created.server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  const displayHost = created.host.includes(":") ? `[${created.host}]` : created.host;
  return {
    ...created,
    port: activePort,
    url: `http://${displayHost}:${activePort}`,
  };
}
