import crypto from "node:crypto";
import http from "node:http";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";

import {
  DOCUMENT_WORKER_LIMITS,
  DOCUMENT_WORKER_ROUTE_LIST,
  DOCUMENT_WORKER_ROUTES,
  canonicalDocumentWorkerJson,
  documentWorkerErrorStatus,
  publicDocumentWorkerErrorCode,
} from "./integration-document-worker-contract.js";
import {
  DOCUMENT_WORKER_LISTEN_HOST,
  DOCUMENT_WORKER_LISTEN_PORT,
  validateIntegrationDocumentWorkerConfig,
} from "./integration-document-worker-config.js";
import { assertIntegrationDocumentWorkerService } from "./integration-document-worker-service.js";
import { FILE_WORKER_ROUTE_LIST, FILE_WORKER_ROUTES } from "./integration-file-worker-contract.js";

export const DOCUMENT_WORKER_SERVER_SCHEMA_VERSION = "aginti-document-worker-server-v1";
export const DOCUMENT_WORKER_FAIL_STOP_SCHEMA_VERSION = "aginti-document-worker-fail-stop-v1";

const SERVER_BRAND = new WeakSet();
const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const ROUTES = new Set([...DOCUMENT_WORKER_ROUTE_LIST, ...FILE_WORKER_ROUTE_LIST]);

function rawHeaderCount(req, expected) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index] || "").toLowerCase() === expected) count += 1;
  }
  return count;
}

function fixedTimeTokenEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left || ""), "utf8").digest();
  const rightDigest = crypto.createHash("sha256").update(String(right || ""), "utf8").digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest) && left === right;
}

function authenticate(req, expectedToken) {
  if (rawHeaderCount(req, "authorization") !== 1) return false;
  const header = String(req.headers.authorization || "");
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/u.exec(header);
  return Boolean(match && fixedTimeTokenEqual(match[1], expectedToken));
}

function jsonHeaders(length, cacheControl = "no-store") {
  return {
    "cache-control": cacheControl,
    "content-length": String(length),
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function writeJson(res, status, value) {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  const bytes = Buffer.from(canonicalDocumentWorkerJson(value), "utf8");
  res.writeHead(status, jsonHeaders(bytes.byteLength));
  res.end(bytes);
}

function writeError(res, error, { closeConnection = false } = {}) {
  if (res.headersSent || res.destroyed || res.writableEnded) {
    if (!res.destroyed) res.destroy();
    return;
  }
  const status = documentWorkerErrorStatus(error);
  const code = publicDocumentWorkerErrorCode(error);
  const bytes = Buffer.from(canonicalDocumentWorkerJson({ error: { code } }), "utf8");
  const headers = jsonHeaders(bytes.byteLength);
  if (closeConnection) headers.connection = "close";
  if (status === 416 && Number.isSafeInteger(error?.totalBytes) && error.totalBytes > 0) {
    headers["content-range"] = `bytes */${error.totalBytes}`;
  }
  res.writeHead(status, headers);
  res.end(bytes);
}

function isDocumentWorkerFailStopError(error) {
  if (!error || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "documentWorkerFailStop");
  return Boolean(descriptor && Object.hasOwn(descriptor, "value") && descriptor.value === true);
}

function failStopRecord(error) {
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_FAIL_STOP_SCHEMA_VERSION,
    code: publicDocumentWorkerErrorCode(error),
  });
}

function badRequest(code = "INVALID_REQUEST", status = 400) {
  const error = new Error("Document worker request was rejected.");
  error.code = code;
  error.publicCode = code;
  error.status = status;
  error.statusCode = status;
  return error;
}

function scanStrictJson(text) {
  let cursor = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[cursor] || "")) cursor += 1;
  };
  const string = () => {
    if (text[cursor] !== "\"") throw badRequest();
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === "\"") {
        cursor += 1;
        try {
          return JSON.parse(text.slice(start, cursor));
        } catch {
          throw badRequest();
        }
      }
      if (character === "\\") {
        cursor += 1;
        if (cursor >= text.length) throw badRequest();
        if (text[cursor] === "u") {
          if (!/^[a-fA-F0-9]{4}$/u.test(text.slice(cursor + 1, cursor + 5))) throw badRequest();
          cursor += 5;
        } else {
          if (!/["\\/bfnrt]/u.test(text[cursor])) throw badRequest();
          cursor += 1;
        }
        continue;
      }
      if (character.codePointAt(0) < 0x20) throw badRequest();
      cursor += 1;
    }
    throw badRequest();
  };
  const value = (depth) => {
    nodes += 1;
    if (depth > 64 || nodes > 200_000) throw badRequest();
    whitespace();
    if (text[cursor] === "{") {
      cursor += 1;
      whitespace();
      const keys = new Set();
      if (text[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        const key = string();
        if (keys.has(key)) throw badRequest();
        keys.add(key);
        whitespace();
        if (text[cursor] !== ":") throw badRequest();
        cursor += 1;
        value(depth + 1);
        whitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ",") throw badRequest();
        cursor += 1;
        whitespace();
      }
      throw badRequest();
    }
    if (text[cursor] === "[") {
      cursor += 1;
      whitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        value(depth + 1);
        whitespace();
        if (text[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ",") throw badRequest();
        cursor += 1;
      }
      throw badRequest();
    }
    if (text[cursor] === "\"") {
      string();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(cursor));
    if (!number) throw badRequest();
    cursor += number[0].length;
  };
  value(0);
  whitespace();
  if (cursor !== text.length) throw badRequest();
}

function declaredLength(req) {
  const count = rawHeaderCount(req, "content-length");
  if (count === 0) return null;
  if (count !== 1) throw badRequest();
  const raw = String(req.headers["content-length"] || "");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw badRequest();
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw badRequest();
  return value;
}

async function readJson(req) {
  const contentType = rawHeaderCount(req, "content-type") === 1
    ? String(req.headers["content-type"] || "")
    : "";
  if (!CONTENT_TYPE.test(contentType)) throw badRequest();
  const expected = declaredLength(req);
  if (expected !== null && expected > DOCUMENT_WORKER_LIMITS.maximumRequestBytes) {
    throw badRequest("BODY_TOO_LARGE", 413);
  }
  const chunks = [];
  let received = 0;
  for await (const chunkValue of req) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    received += chunk.byteLength;
    if (received > DOCUMENT_WORKER_LIMITS.maximumRequestBytes) {
      req.resume();
      throw badRequest("BODY_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  if (expected !== null && expected !== received) throw badRequest();
  if (received < 2) throw badRequest();
  const bytes = Buffer.concat(chunks, received);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw badRequest();
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw badRequest();
  }
  if (text.charCodeAt(0) === 0xfeff) throw badRequest();
  scanStrictJson(text);
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest();
  }
}

function prepareUnreadBodyRejection(req, res) {
  if (req.complete || req.readableEnded || req.destroyed) return false;
  res.shouldKeepAlive = false;
  req.resume();
  const socket = req.socket;
  res.once("finish", () => {
    if (socket && !socket.destroyed) socket.destroy();
  });
  return true;
}

function contentDisposition(filename) {
  const fallback = String(filename || "artifact")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 120) || "artifact";
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (character) =>
    `%${character.codePointAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function writeContent(req, res, result, signal) {
  const { metadata, stream, release } = result;
  const status = metadata.partial ? 206 : 200;
  const headers = {
    "accept-ranges": "bytes",
    "cache-control": "no-store, private",
    "content-disposition": contentDisposition(metadata.filename),
    "content-length": metadata.metadataOnly ? "0" : String(metadata.selectedBytes),
    "content-type": metadata.mime,
    etag: `"${metadata.sha256}"`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...(metadata.metadataOnly ? { "x-artifact-content-length": String(metadata.selectedBytes) } : {}),
    ...(metadata.partial
      ? { "content-range": `bytes ${metadata.start}-${metadata.end}/${metadata.totalBytes}` }
      : {}),
  };
  res.writeHead(status, headers);
  if (metadata.metadataOnly) {
    res.end();
    await release();
    return;
  }
  try {
    await pipeline(stream, res, { signal });
  } finally {
    await release();
  }
}

function configureServer(server) {
  server.requestTimeout = 125_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 48;
  server.maxRequestsPerSocket = 20;
}

function verifyAddress(server) {
  const address = server.address();
  const family = typeof address === "object" && address ? address.family : "";
  if (
    !address ||
    typeof address !== "object" ||
    address.address !== DOCUMENT_WORKER_LISTEN_HOST ||
    address.port !== DOCUMENT_WORKER_LISTEN_PORT ||
    !new Set(["IPv4", 4]).has(family)
  ) throw new Error("Document worker listener did not bind its fixed IPv4 loopback endpoint.");
  return Object.freeze({ address: address.address, port: address.port, family: "IPv4" });
}

export function createIntegrationDocumentWorkerServer(options = {}) {
  const keys = Reflect.ownKeys(options);
  const allowedKeys = new Set(["config", "service", "bearerToken", "onFailStop"]);
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
    !Object.hasOwn(options, "config") ||
    !Object.hasOwn(options, "service") ||
    !Object.hasOwn(options, "bearerToken")
  ) throw new TypeError("document worker server options are invalid");
  const config = validateIntegrationDocumentWorkerConfig(options.config);
  const service = assertIntegrationDocumentWorkerService(options.service);
  const bearerToken = String(options.bearerToken || "");
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/u.test(bearerToken)) {
    throw new TypeError("document worker server bearer token is invalid");
  }
  const onFailStop = options.onFailStop;
  if (onFailStop !== undefined && typeof onFailStop !== "function") {
    throw new TypeError("document worker fail-stop callback is invalid");
  }
  let lifecycle = "created";
  let startPromise = null;
  let closePromise = null;
  let failStopPromise = null;
  let startGeneration = 0;
  const controllers = new Set();

  function triggerFailStop(error, res) {
    if (failStopPromise) return;
    const record = failStopRecord(error);
    lifecycle = "fail-stop";
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      failStopPromise = (async () => {
        await close({ timeoutMs: 5_000 }).catch(() => {});
        if (onFailStop) await onFailStop(record);
        return record;
      })();
      failStopPromise.catch(() => {});
    };
    if (res.writableEnded || res.destroyed) {
      setImmediate(schedule);
    } else {
      res.once("finish", schedule);
      res.once("close", schedule);
    }
  }

  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort(new Error("document worker client detached"));
    req.once("aborted", abort);
    req.once("error", abort);
    res.once("close", () => {
      if (!res.writableFinished) abort();
    });
    try {
      const target = String(req.url || "");
      if (
        req.method !== "POST" ||
        !ROUTES.has(target) ||
        target.includes("?") ||
        target.includes("#") ||
        target.includes("%")
      ) throw badRequest("NOT_FOUND", 404);
      if (!authenticate(req, bearerToken)) throw badRequest("UNAUTHORIZED", 401);
      const body = await readJson(req);
      if (target === DOCUMENT_WORKER_ROUTES.readiness) {
        writeJson(res, 200, await service.readiness(body));
      } else if (target === FILE_WORKER_ROUTES.readiness) {
        writeJson(res, 200, await service.fileReadiness(body));
      } else if (target === DOCUMENT_WORKER_ROUTES.compileIssue) {
        writeJson(res, 200, await service.issueCompile(body));
      } else if (target === FILE_WORKER_ROUTES.issue) {
        writeJson(res, 200, await service.issueFiles(body));
      } else if (target === DOCUMENT_WORKER_ROUTES.compile) {
        writeJson(res, 200, await service.compile(body, { signal: controller.signal }));
      } else if (target === FILE_WORKER_ROUTES.publish) {
        writeJson(res, 200, await service.publishFiles(body));
      } else if (target === DOCUMENT_WORKER_ROUTES.commit) {
        writeJson(res, 200, await service.commit(body));
      } else if (target === FILE_WORKER_ROUTES.commit) {
        writeJson(res, 200, await service.commitFiles(body));
      } else if (target === DOCUMENT_WORKER_ROUTES.content) {
        const content = await service.content(body);
        await writeContent(req, res, content, controller.signal);
      } else if (target === FILE_WORKER_ROUTES.content) {
        const content = await service.fileContent(body);
        await writeContent(req, res, content, controller.signal);
      } else if (target === DOCUMENT_WORKER_ROUTES.delete) {
        writeJson(res, 200, await service.delete(body));
      } else if (target === FILE_WORKER_ROUTES.delete) {
        writeJson(res, 200, await service.deleteFiles(body));
      } else {
        throw badRequest("NOT_FOUND", 404);
      }
    } catch (error) {
      const closeConnection = prepareUnreadBodyRejection(req, res);
      writeError(res, error, { closeConnection });
      if (isDocumentWorkerFailStopError(error)) triggerFailStop(error, res);
    } finally {
      req.off("aborted", abort);
      req.off("error", abort);
      controllers.delete(controller);
    }
  });
  configureServer(server);

  async function start() {
    if (lifecycle === "closed" || lifecycle === "closing") throw new Error("Document worker server is closed.");
    if (server.listening) return verifyAddress(server);
    if (startPromise) return startPromise;
    const generation = startGeneration + 1;
    startGeneration = generation;
    lifecycle = "starting";
    startPromise = (async () => {
      await service.activate();
      if (lifecycle !== "starting" || generation !== startGeneration) {
        throw new Error("Document worker server is closed.");
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          server.off("error", onError);
          server.off("listening", onListening);
          if (error) reject(error);
        };
        const onError = (error) => {
          lifecycle = "created";
          finish(error);
        };
        const onListening = () => {
          try {
            if (lifecycle !== "starting" || generation !== startGeneration) {
              server.close(() => {});
              finish(new Error("Document worker server is closed."));
              return;
            }
            const address = verifyAddress(server);
            lifecycle = "listening";
            finish();
            resolve(address);
          } catch (error) {
            server.close(() => {});
            lifecycle = "created";
            finish(error);
          }
        };
        const timer = setTimeout(() => onError(new Error("Document worker listener timed out.")), 5_000);
        timer.unref?.();
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({
          host: config.listen.host,
          port: config.listen.port,
          exclusive: true,
        });
      });
    })().finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  async function close({ timeoutMs = 5_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new TypeError("document worker close timeout is invalid");
    }
    if (closePromise) return closePromise;
    startGeneration += 1;
    lifecycle = "closing";
    for (const controller of controllers) controller.abort(new Error("document worker shutting down"));
    closePromise = new Promise((resolve) => {
      if (!server.listening) {
        resolve(false);
        return;
      }
      let settled = false;
      const done = (forced) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(forced);
      };
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        done(true);
      }, timeoutMs);
      timer.unref?.();
      server.closeIdleConnections?.();
      server.close(() => done(false));
    }).then(async (forced) => {
      await service.close();
      lifecycle = "closed";
      return Object.freeze({ closed: true, forced });
    });
    return closePromise;
  }

  const wrapper = {
    schemaVersion: DOCUMENT_WORKER_SERVER_SCHEMA_VERSION,
    server,
    config,
    check: () => service.check(),
    start,
    close,
    get lifecycle() {
      return lifecycle;
    },
    get listening() {
      return server.listening;
    },
  };
  SERVER_BRAND.add(wrapper);
  return Object.freeze(wrapper);
}

export function assertIntegrationDocumentWorkerServer(value) {
  if (!value || !SERVER_BRAND.has(value)) throw new TypeError("document worker server is not AgInTi-owned");
  return value;
}
