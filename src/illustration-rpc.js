import { timingSafeEqual, createHash } from "node:crypto";
import { capabilities, snapshot, exact, identifier, createRequest, ownedId, canonical, IllustrationError, reject } from "./illustration-contract.js";
import { assertIllustrationWorker } from "./illustration-worker.js";

const ACTIONS = new Set(["/capabilities", "/jobs/create", "/jobs/status", "/jobs/cancel", "/artifacts/content"]);
const hashToken = (token) => createHash("sha256").update(token).digest();
const JSON_HEADERS = Object.freeze({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });

// No listener, Express mount, Studio exposure or ambient credentials. The host
// passes original path/raw headers/raw bytes; canonical JSON is required on wire
// so duplicate keys and ambiguous encodings cannot acquire a request identity.
export function createIllustrationRpc({ worker, clients }) {
  assertIllustrationWorker(worker);
  const configured = snapshot(clients);
  if (!Array.isArray(configured) || !configured.length || configured.length > 16) reject();
  const appIds = new Set(), tokens = new Set();
  const authorized = configured.map((entry) => {
    const client = exact(entry, ["appId", "token", "trustedPrincipalProxy"]);
    identifier(client.appId);
    if (client.trustedPrincipalProxy !== true || typeof client.token !== "string" || !/^[A-Za-z0-9._~-]{32,256}(?![\s\S])/.test(client.token) || appIds.has(client.appId) || tokens.has(client.token)) reject();
    appIds.add(client.appId); tokens.add(client.token);
    return { appId: client.appId, tokenHash: hashToken(client.token) };
  });
  return async function handle({ method, originalPath, rawHeaders, body }) {
    try {
      const raw = snapshot(rawHeaders);
      if (!Array.isArray(raw) || raw.length % 2 || raw.length > 64) reject();
      const headers = Object.create(null);
      for (let i = 0; i < raw.length; i += 2) {
        if (typeof raw[i] !== "string" || !/^[A-Za-z-]+$/.test(raw[i]) || typeof raw[i + 1] !== "string" || raw[i + 1].length > 1024 || /[^\x20-\x7e]/.test(raw[i + 1])) reject();
        const name = raw[i].toLowerCase();
        if (Object.hasOwn(headers, name) || !["authorization", "x-aginti-principal-id", "idempotency-key", "content-type", "content-length", "accept", "host", "user-agent", "connection"].includes(name)) reject();
        headers[name] = raw[i + 1];
      }
      const match = /^Bearer ([A-Za-z0-9._~-]{32,256})$/.exec(headers.authorization || "");
      const client = match && authorized.find((c) => timingSafeEqual(c.tokenHash, hashToken(match[1])));
      if (!client) reject("ILLUSTRATION_UNAUTHORIZED", 401);
      const owner = { appId: client.appId, principalId: identifier(headers["x-aginti-principal-id"]) };
      if (method !== "POST" || typeof originalPath !== "string" || !originalPath.startsWith("/illustration/v1")) reject("ILLUSTRATION_NOT_FOUND", 404);
      const action = originalPath.slice("/illustration/v1".length);
      if (!ACTIONS.has(action)) reject("ILLUSTRATION_NOT_FOUND", 404);
      if (!/^application\/json(?:; charset=utf-8)?$/.test(headers["content-type"] || "") || !Buffer.isBuffer(body) || body.length > 32768 || (headers["content-length"] !== undefined && headers["content-length"] !== String(body.length))) reject();
      let request;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
        request = snapshot(JSON.parse(text));
        if (!Buffer.from(canonical(request), "utf8").equals(body)) reject();
      } catch { reject(); }
      const mutation = action === "/jobs/create" || action === "/jobs/cancel";
      if (mutation) identifier(headers["idempotency-key"]);
      else if (headers["idempotency-key"] !== undefined) reject();
      let result;
      if (action === "/capabilities") { exact(request, []); result = capabilities(); }
      if (action === "/jobs/create") {
        createRequest(request);
        // Deliberately impossible to enable through a flag/self-attestation.
        reject("ILLUSTRATION_QUALIFICATION_REQUIRED", 503);
      }
      if (action === "/jobs/status") result = worker.status(owner, ownedId(request, "jobId"));
      if (action === "/jobs/cancel") result = worker.cancel(owner, headers["idempotency-key"], ownedId(request, "jobId"));
      if (action === "/artifacts/content") {
        const content = worker.content(owner, ownedId(request, "artifactId"));
        return { status: 200, headers: { ...JSON_HEADERS, "Content-Type": "image/png", "Content-Length": String(content.bytes.length), "Content-Disposition": 'attachment; filename="illustration.png"', "X-Content-SHA256": content.artifact.sha256 }, body: content.bytes };
      }
      return { status: 200, headers: JSON_HEADERS, body: Buffer.from(canonical(result)) };
    } catch (error) {
      const safe = error instanceof IllustrationError;
      return { status: safe ? error.status : 503, headers: JSON_HEADERS, body: Buffer.from(canonical({ schemaVersion: 1, error: safe ? error.code : "ILLUSTRATION_UNAVAILABLE" })) };
    }
  };
}
