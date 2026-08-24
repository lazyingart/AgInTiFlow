import crypto from "node:crypto";
import http from "node:http";

import { EXECUTION_LIMITS, ExecutionWorkerError } from "./execution-worker.js";

export const EXECUTION_WORKER_API_SCHEMA_VERSION = "aginti-execution-worker-api-v1";
export const EXECUTION_WORKER_API_PREFIX = "/executor/v1";
export const EXECUTION_WORKER_LISTEN_HOST = "127.0.0.1";
export const EXECUTION_WORKER_LISTEN_PORT = 18_130;
export const EXECUTION_WORKER_MAX_REQUEST_BYTES =
  2 * (EXECUTION_LIMITS.maximumSourceBytes + EXECUTION_LIMITS.maximumStdinBytes) + 16 * 1024;
export const EXECUTION_WORKER_REQUEST_TIMEOUT_MS = 5_000;
export const EXECUTION_WORKER_RPC_PATHS = Object.freeze({
  capabilities: "/executor/v1/capabilities",
  jobsStart: "/executor/v1/jobs/start",
  jobsStatus: "/executor/v1/jobs/status",
  jobsEvents: "/executor/v1/jobs/events",
  jobsCancel: "/executor/v1/jobs/cancel",
  artifactsList: "/executor/v1/artifacts/list",
  artifactsGet: "/executor/v1/artifacts/get",
});
export const EXECUTION_WORKER_RPC_PATH_LIST = Object.freeze(Object.values(EXECUTION_WORKER_RPC_PATHS));

const RPC_PATH_SET = new Set(EXECUTION_WORKER_RPC_PATH_LIST);
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/u;
const PUBLIC_ERROR_CODES = new Set([
  "EXECUTION_REQUEST_INVALID",
  "EXECUTION_BUSY",
  "EXECUTION_UNAVAILABLE",
  "EXECUTION_JOB_NOT_FOUND",
  "EXECUTION_ARTIFACT_NOT_FOUND",
  "EXECUTION_IDEMPOTENCY_CONFLICT",
  "EXECUTION_CURSOR_INVALID",
  "EXECUTION_CURSOR_CONFLICT",
]);

function apiError(code, status) {
  return new ExecutionWorkerError(code, code, { status });
}

export function validateExecutionWorkerBearerToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new TypeError("execution worker bearer token must be an opaque 32-256 character secret");
  }
  return value;
}

function headerOccurrences(req, name) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index]).toLowerCase() === name) count += 1;
  }
  return count;
}

function authenticated(req, bearerToken) {
  if (headerOccurrences(req, "authorization") !== 1) return false;
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  if (!TOKEN_PATTERN.test(supplied)) return false;
  const expectedDigest = crypto.createHash("sha256").update(bearerToken).digest();
  const suppliedDigest = crypto.createHash("sha256").update(supplied).digest();
  return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

function jsonHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function writeJson(res, status, value) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { ...jsonHeaders(), "content-length": Buffer.byteLength(body, "utf8") });
  res.end(body);
}

function writeError(res, error) {
  const known = error instanceof ExecutionWorkerError && PUBLIC_ERROR_CODES.has(error.code);
  const status = known && Number.isSafeInteger(error.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 503;
  const code = known ? error.code : "EXECUTION_UNAVAILABLE";
  writeJson(res, status, Object.freeze({
    schemaVersion: EXECUTION_WORKER_API_SCHEMA_VERSION,
    error: Object.freeze({ code }),
  }));
}

function exactEmptyObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== 0) {
    throw apiError("EXECUTION_REQUEST_INVALID", 400);
  }
  return value;
}

function validContentType(req) {
  if (headerOccurrences(req, "content-type") !== 1) return false;
  return /^application\/json(?:;\s*charset=utf-8)?$/iu.test(String(req.headers["content-type"] || ""));
}

async function readJsonBody(req) {
  if (!validContentType(req) || req.headers["content-encoding"] !== undefined) {
    throw apiError("EXECUTION_REQUEST_INVALID", 415);
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(declared)
      || Number(declared) > EXECUTION_WORKER_MAX_REQUEST_BYTES)) {
    throw apiError("EXECUTION_REQUEST_INVALID", 413);
  }
  const chunks = [];
  let bytes = 0;
  let tooLarge = false;
  const timeout = setTimeout(() => req.destroy(apiError("EXECUTION_REQUEST_INVALID", 408)), EXECUTION_WORKER_REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    for await (const chunk of req) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > EXECUTION_WORKER_MAX_REQUEST_BYTES) {
        tooLarge = true;
        continue;
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ExecutionWorkerError) throw error;
    throw apiError("EXECUTION_REQUEST_INVALID", 400);
  } finally {
    clearTimeout(timeout);
  }
  if (tooLarge) throw apiError("EXECUTION_REQUEST_INVALID", 413);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw apiError("EXECUTION_REQUEST_INVALID", 400);
  }
  return parsed;
}

async function dispatch(manager, pathname, body) {
  switch (pathname) {
    case EXECUTION_WORKER_RPC_PATHS.capabilities:
      exactEmptyObject(body);
      return manager.capabilities();
    case EXECUTION_WORKER_RPC_PATHS.jobsStart:
      return manager.start(body);
    case EXECUTION_WORKER_RPC_PATHS.jobsStatus:
      return manager.status(body);
    case EXECUTION_WORKER_RPC_PATHS.jobsEvents:
      return manager.events(body);
    case EXECUTION_WORKER_RPC_PATHS.jobsCancel:
      return manager.cancel(body);
    case EXECUTION_WORKER_RPC_PATHS.artifactsList:
      return manager.listArtifacts(body);
    case EXECUTION_WORKER_RPC_PATHS.artifactsGet:
      return manager.getArtifact(body);
    default:
      throw apiError("EXECUTION_REQUEST_INVALID", 404);
  }
}

export function createExecutionWorkerApiServer({ manager, bearerToken, serverFactory = http.createServer } = {}) {
  if (!manager || typeof manager.capabilities !== "function" || typeof manager.start !== "function"
      || typeof manager.status !== "function" || typeof manager.events !== "function"
      || typeof manager.cancel !== "function" || typeof manager.listArtifacts !== "function"
      || typeof manager.getArtifact !== "function") {
    throw new TypeError("manager must provide the fixed execution worker RPC surface");
  }
  const token = validateExecutionWorkerBearerToken(bearerToken);
  if (typeof serverFactory !== "function") throw new TypeError("serverFactory must be a function");
  const server = serverFactory(async (req, res) => {
    const pathname = typeof req.url === "string" && RPC_PATH_SET.has(req.url) ? req.url : "";
    if (!pathname) {
      writeJson(res, 404, { schemaVersion: EXECUTION_WORKER_API_SCHEMA_VERSION, error: { code: "NOT_FOUND" } });
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { schemaVersion: EXECUTION_WORKER_API_SCHEMA_VERSION, error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    if (!authenticated(req, token)) {
      writeJson(res, 401, { schemaVersion: EXECUTION_WORKER_API_SCHEMA_VERSION, error: { code: "UNAUTHORIZED" } });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const response = await dispatch(manager, pathname, body);
      writeJson(res, 200, Object.freeze({ schemaVersion: EXECUTION_WORKER_API_SCHEMA_VERSION, response }));
    } catch (error) {
      writeError(res, error);
    }
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 6_000;
  server.requestTimeout = 10_000;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return server;
}

export async function listenExecutionWorkerSystemdSocket(server, { fd = 3 } = {}) {
  if (!server || typeof server.listen !== "function" || typeof server.close !== "function") {
    throw new TypeError("server must be an HTTP server");
  }
  if (fd !== 3 || process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== "1") {
    throw new Error("execution worker requires exactly one systemd-activated socket on fd 3");
  }
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ fd, exclusive: true });
  });
  const address = server.address();
  if (!address || typeof address !== "object" || address.address !== EXECUTION_WORKER_LISTEN_HOST
      || address.port !== EXECUTION_WORKER_LISTEN_PORT || address.family !== "IPv4") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("systemd activated an unexpected execution worker loopback listener");
  }
  return Object.freeze({
    host: EXECUTION_WORKER_LISTEN_HOST,
    port: EXECUTION_WORKER_LISTEN_PORT,
    systemdActivated: true,
    fd,
  });
}
