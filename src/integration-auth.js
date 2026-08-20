import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const INTEGRATION_AUTH_FEATURE = "aginti-integration-api";
export const DEFAULT_INTEGRATION_CREDENTIAL_NAME = "aginti-integration-token";
export const DEFAULT_INTEGRATION_CLIENT_ID = "aginti-bff";
export const INTEGRATION_PRINCIPAL_HEADER = "x-aginti-principal-id";
export const INTEGRATION_BROWSER_SESSION_HEADER = "x-aginti-browser-session-id";
export const INTEGRATION_IDEMPOTENCY_HEADER = "idempotency-key";
export const RESERVED_LEGACY_INTEGRATION_HEADER_PREFIX = "x-lazyedge-";
export const MIN_INTEGRATION_TOKEN_LENGTH = 32;
export const MAX_INTEGRATION_TOKEN_LENGTH = 4096;

const INTEGRATION_BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,4096}$/u;
const TRUSTED_PRINCIPAL_PROXY = "trusted-principal-proxy";

export class IntegrationAuthError extends Error {
  constructor(code, message, { status = 401 } = {}) {
    super(message);
    this.name = "IntegrationAuthError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function firstEnvValue(env, names = []) {
  for (const name of names) {
    const value = String(env?.[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function singleHeader(headers = {}, name = "") {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : "";
  return value === undefined ? "" : String(value);
}

function rawHeaderOccurrences(req = {}, name = "") {
  const wanted = String(name || "").toLowerCase();
  if (!wanted) return 0;
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  if (raw.length > 0) {
    let count = 0;
    for (let index = 0; index < raw.length; index += 2) {
      if (String(raw[index] || "").toLowerCase() === wanted) count += 1;
    }
    return count;
  }
  const headers = req.headers || req || {};
  const value = headers[wanted] ?? headers[name];
  if (value === undefined) return 0;
  return Array.isArray(value) ? value.length : 1;
}

export function requestHasIntegrationHeader(req = {}, name = "") {
  return rawHeaderOccurrences(req, name) > 0;
}

export function requestSingleIntegrationHeader(req = {}, name = "", { code = "AMBIGUOUS_INTEGRATION_HEADER", status = 400 } = {}) {
  if (rawHeaderOccurrences(req, name) > 1) {
    throw new IntegrationAuthError(code, `${name} must appear at most once.`, { status });
  }
  return singleHeader(req.headers || req || {}, name);
}

export function assertNoReservedLegacyIntegrationHeaders(req = {}) {
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  if (raw.length > 0) {
    for (let index = 0; index < raw.length; index += 2) {
      if (String(raw[index] || "").toLowerCase().startsWith(RESERVED_LEGACY_INTEGRATION_HEADER_PREFIX)) {
        throw new IntegrationAuthError(
          "RESERVED_INTEGRATION_HEADER",
          "x-lazyedge-* headers are reserved legacy adapter headers; use AgInTi integration headers.",
          { status: 400 }
        );
      }
    }
    return;
  }
  for (const name of Object.keys(req.headers || req || {})) {
    if (String(name || "").toLowerCase().startsWith(RESERVED_LEGACY_INTEGRATION_HEADER_PREFIX)) {
      throw new IntegrationAuthError(
        "RESERVED_INTEGRATION_HEADER",
        "x-lazyedge-* headers are reserved legacy adapter headers; use AgInTi integration headers.",
        { status: 400 }
      );
    }
  }
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

export function writeIntegrationErrorJson(res, status, code) {
  if (res.headersSent || res.writableEnded) return;
  res.status(status);
  res.set({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.json({ error: { code } });
}

export function validateIntegrationBearerToken(token, { field = "bearerToken" } = {}) {
  const text = String(token ?? "").trim();
  if (!text) {
    throw new IntegrationAuthError("AUTH_UNCONFIGURED", `${field} is required.`, { status: 503 });
  }
  if (text.length < MIN_INTEGRATION_TOKEN_LENGTH || text.length > MAX_INTEGRATION_TOKEN_LENGTH) {
    throw new IntegrationAuthError(
      "AUTH_UNCONFIGURED",
      `${field} must contain ${MIN_INTEGRATION_TOKEN_LENGTH}-${MAX_INTEGRATION_TOKEN_LENGTH} characters.`,
      { status: 503 }
    );
  }
  if (!INTEGRATION_BEARER_TOKEN_PATTERN.test(text)) {
    throw new IntegrationAuthError("AUTH_UNCONFIGURED", `${field} must match the AgInTi transport credential grammar.`, {
      status: 503,
    });
  }
  return text;
}

export function validateIntegrationClientId(value = DEFAULT_INTEGRATION_CLIENT_ID) {
  const text = String(value || DEFAULT_INTEGRATION_CLIENT_ID).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}[A-Za-z0-9]$|^[A-Za-z0-9]$/u.test(text)) {
    throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration client id is invalid.", { status: 503 });
  }
  return text;
}

function validatePrincipalAuthority(entry = {}) {
  const authority = String(entry.principalAuthority || "").trim();
  if (entry.trustedProxy === true || authority === TRUSTED_PRINCIPAL_PROXY) return TRUSTED_PRINCIPAL_PROXY;
  throw new IntegrationAuthError(
    "AUTH_UNCONFIGURED",
    "Integration client must explicitly attest trusted principal proxy authority.",
    { status: 503 }
  );
}

export function validateAgintiPrincipalId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/u.test(value)) {
    throw new IntegrationAuthError(
      "INVALID_PRINCIPAL",
      "x-aginti-principal-id must be an opaque 16-128 character identifier.",
      { status: 401 }
    );
  }
  return value;
}

export function validateAgintiBrowserSession(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new IntegrationAuthError(
      "INVALID_BROWSER_SESSION",
      "x-aginti-browser-session-id must be a 64-character lowercase hex value.",
      { status: 400 }
    );
  }
  return value;
}

export function normalizeIntegrationClientScopes(scopes = ["*"]) {
  const values = Array.isArray(scopes) ? scopes : String(scopes || "").split(",");
  const normalized = values
    .map((scope) => String(scope || "").trim())
    .filter(Boolean);
  if (!normalized.length) return ["*"];
  for (const scope of normalized) {
    if (scope !== "*" && !/^\/agent\/v1\/(?:capabilities|threads\/(?:list|create|get|update|delete)|runs\/(?:start|status|events|cancel|resume)|artifacts\/(?:list|get))$/u.test(scope)) {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", `Integration scope is invalid: ${scope}`, {
        status: 503,
      });
    }
  }
  return [...new Set(normalized)];
}

export function createIntegrationClient(entry = {}) {
  if (!isPlainObject(entry)) {
    throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration client entry must be an object.", {
      status: 503,
    });
  }
  const token = validateIntegrationBearerToken(entry.token ?? entry.bearerToken);
  return Object.freeze({
    id: validateIntegrationClientId(entry.clientId || entry.id || DEFAULT_INTEGRATION_CLIENT_ID),
    scopes: Object.freeze(normalizeIntegrationClientScopes(entry.scopes || ["*"])),
    principalAuthority: validatePrincipalAuthority(entry),
    token,
    tokenHash: tokenHash(token),
    label: String(entry.label || "").trim().slice(0, 80),
  });
}

export function normalizeIntegrationClients(options = {}) {
  let clients;
  if (Array.isArray(options.tokenEntries) && options.tokenEntries.length > 0) {
    clients = options.tokenEntries.map((entry) => createIntegrationClient(entry));
  } else if (Array.isArray(options.clients) && options.clients.length > 0) {
    clients = options.clients.map((entry) => createIntegrationClient(entry));
  } else {
    const token = options.bearerToken || options.token || "";
    if (!token) return Object.freeze([]);
    clients = [
      createIntegrationClient({
        token,
        clientId: options.clientId || DEFAULT_INTEGRATION_CLIENT_ID,
        scopes: options.scopes || ["*"],
        label: options.label || "",
        principalAuthority: options.principalAuthority,
        trustedProxy: options.trustedProxy,
      }),
    ];
  }
  const ids = new Set();
  const tokenHashes = new Set();
  for (const client of clients) {
    if (ids.has(client.id)) {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration client ids must be unique.", { status: 503 });
    }
    if (tokenHashes.has(client.tokenHash)) {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration bearer tokens must be unique.", { status: 503 });
    }
    ids.add(client.id);
    tokenHashes.add(client.tokenHash);
  }
  return Object.freeze(clients);
}

export function safeTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""), "utf8");
  const expectedBuffer = Buffer.from(String(expected || ""), "utf8");
  if (!actualBuffer.length || actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function extractBearerTokenFromHeaders(headers = {}) {
  const authorization = singleHeader(headers, "authorization");
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/u);
  return match ? match[1] : "";
}

export function findAuthorizedIntegrationClient(headers = {}, clients = []) {
  const token = extractBearerTokenFromHeaders(headers);
  if (!token) return null;
  for (const client of clients) {
    if (safeTokenEqual(token, client.token)) return client;
  }
  return null;
}

export function integrationClientCanUsePath(client = {}, pathname = "") {
  const scopes = new Set(client.scopes || []);
  return scopes.has("*") || scopes.has(String(pathname || ""));
}

export function publicIntegrationClient(client = {}) {
  return Object.freeze({
    id: String(client.id || ""),
    scopes: Object.freeze([...(client.scopes || [])]),
    label: String(client.label || ""),
  });
}

export function createIntegrationAuthMiddleware(options = {}) {
  let clients = [];
  let configurationError = null;
  try {
    clients = normalizeIntegrationClients(options);
    if (!clients.length) {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration API bearer token is not configured.", {
        status: 503,
      });
    }
  } catch (error) {
    configurationError = error;
  }

  return (req, res, next) => {
    if (configurationError) {
      writeIntegrationErrorJson(res, Number(configurationError.status) || 503, "AUTH_UNCONFIGURED");
      return;
    }

    try {
      requestSingleIntegrationHeader(req, "authorization", { code: "UNAUTHORIZED", status: 401 });
      const client = findAuthorizedIntegrationClient(req.headers || {}, clients);
      if (!client) {
        throw new IntegrationAuthError("UNAUTHORIZED", "Integration bearer token is invalid.", { status: 401 });
      }
      if (client.principalAuthority !== TRUSTED_PRINCIPAL_PROXY) {
        throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration client cannot proxy principals.", { status: 503 });
      }
      assertNoReservedLegacyIntegrationHeaders(req);
      req.integrationClient = publicIntegrationClient(client);
      req.integrationPrincipal = Object.freeze({
        id: validateAgintiPrincipalId(
          requestSingleIntegrationHeader(req, INTEGRATION_PRINCIPAL_HEADER, {
            code: "INVALID_PRINCIPAL",
            status: 401,
          })
        ),
      });
      req.integrationBrowserSession = Object.freeze({
        id: validateAgintiBrowserSession(
          requestSingleIntegrationHeader(req, INTEGRATION_BROWSER_SESSION_HEADER, {
            code: "INVALID_BROWSER_SESSION",
            status: 400,
          })
        ),
      });
      next();
    } catch (error) {
      const status = Number(error?.status) || 400;
      writeIntegrationErrorJson(res, status, error?.code || "INVALID_REQUEST");
    }
  };
}

export async function readProtectedIntegrationTokenFile(filePath, options = {}) {
  const resolved = path.resolve(String(filePath || ""));
  let handle;
  try {
    handle = await fs.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration token path must be a regular file.", {
        status: 503,
      });
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    const ownerUid = Number(options.ownerUid ?? currentUid);
    const allowRootOwner = options.allowRootOwner !== false;
    const ownerOk = stat.uid === ownerUid || (allowRootOwner && stat.uid === 0);
    if (!ownerOk) {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration token file owner is invalid.", {
        status: 503,
      });
    }
    if (stat.nlink !== 1) {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration token file must not have hard links.", {
        status: 503,
      });
    }
    if (stat.size < MIN_INTEGRATION_TOKEN_LENGTH || stat.size > MAX_INTEGRATION_TOKEN_LENGTH + 1) {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration token file size is invalid.", {
        status: 503,
      });
    }
    const mode = stat.mode & 0o777;
    const allowGroupReadable = options.allowGroupReadable === true;
    const forbiddenModeBits = allowGroupReadable ? 0o037 : 0o077;
    if ((mode & forbiddenModeBits) !== 0) {
      throw new IntegrationAuthError(
        "AUTH_UNCONFIGURED",
        "Integration token file must be protected from group/world access.",
        { status: 503 }
      );
    }
    const raw = await handle.readFile("utf8");
    if (raw.includes("\u0000") || raw.includes("\r")) {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration token file contains forbidden controls.", {
        status: 503,
      });
    }
    const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (normalized.includes("\n") || !normalized) {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration token file must contain exactly one line.", {
        status: 503,
      });
    }
    return validateIntegrationBearerToken(normalized, { field: "integration token file" });
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration token file must not be a symlink.", {
        status: 503,
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readIntegrationBearerToken(options = {}) {
  const env = options.env || process.env;
  const direct = String(
    options.bearerToken ??
      firstEnvValue(env, ["AGINTI_INTEGRATION_BEARER_TOKEN", "AGINTI_INTEGRATION_TOKEN"])
  ).trim();
  if (direct) return validateIntegrationBearerToken(direct);

  const tokenFile = String(
    options.tokenFile ??
      firstEnvValue(env, ["AGINTI_INTEGRATION_BEARER_TOKEN_FILE", "AGINTI_INTEGRATION_TOKEN_FILE"])
  ).trim();
  if (tokenFile) return readProtectedIntegrationTokenFile(tokenFile, options);

  const credentialsDirectory = String(options.credentialsDirectory ?? env.CREDENTIALS_DIRECTORY ?? "").trim();
  if (credentialsDirectory) {
    const credentialName = String(options.credentialName || DEFAULT_INTEGRATION_CREDENTIAL_NAME);
    return readProtectedIntegrationTokenFile(path.join(credentialsDirectory, credentialName), options);
  }

  throw new IntegrationAuthError("AUTH_UNCONFIGURED", "Integration bearer token was not configured.", {
    status: 503,
  });
}
