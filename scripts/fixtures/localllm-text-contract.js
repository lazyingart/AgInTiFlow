// Offline conformance oracle for the proposed LocalLLM-owned qualification
// contract. This is NOT an admission authority, transport, or production API.
// All approvals in its tests are synthetic; nothing here issues a live grant.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { dataFields, jsonSnapshot, parseRestrictedJson } from "../../src/restricted-application-contract.js";

const hashPattern = /^sha256:[0-9a-f]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const byteLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength").get;
export const replySchema = jsonSnapshot({ type: "object", properties: { reply: { type: "string", minLength: 1, maxLength: 120 } }, required: ["reply"], additionalProperties: false });
export const requestPolicy = jsonSnapshot({ contract: "aginti-json-proposal-nonstream-v1", routes: [{ method: "GET", path: "/v1/models" }, { method: "POST", path: "/v1/chat/completions" }],
  maxRequestBytes: 16384, maxMessages: 8, maxTextPartsPerMessage: 16, maxMessageTextBytes: 2048, maxOutputTokens: 128, maxResponseBytes: 262144,
  maxConcurrent: 1, maxAppGenerationDispatches: 5, maxModelListReads: 10, connectTimeoutMs: 5000, idleTimeoutMs: 30000, totalTimeoutMs: 60000, retries: 0, stream: false, tools: false });
const reject = () => { const error = new Error("LocalLLM qualification contract rejected"); error.code = "LOCALLLM_QUALIFICATION_REJECTED"; throw error; };
const requireTrue = (condition) => { if (!condition) reject(); };
const exact = (value, fields) => { dataFields(value, fields); return value; };
const matching = (value, pattern) => requireTrue(typeof value === "string" && pattern.test(value) && !/[\r\n]/.test(value));
const hash = (value) => { matching(value, hashPattern); return value; };
const id = (value) => matching(value, idPattern);
const safeInteger = (value, min, max) => requireTrue(Number.isSafeInteger(value) && value >= min && value <= max);
const same = (a, b) => requireTrue(canonical(a) === canonical(b));

export function timestamp(value) {
  requireTrue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value));
  const ms = Date.parse(value);
  requireTrue(Number.isFinite(ms) && new Date(ms).toISOString().replace(".000Z", "Z") === value);
  return ms;
}

// Restricted LocalLLM canonical JSON: ASCII keys, safe integers, no Unicode
// normalization, array order preserved. Hash raw entity bytes separately.
export function canonical(value) {
  const snapshot = jsonSnapshot(value);
  function encode(item) {
    if (typeof item === "number") requireTrue(Number.isSafeInteger(item));
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    const keys = Object.keys(item).sort();
    requireTrue(keys.every((key) => /^[\x20-\x7e]+$/.test(key)));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(",")}}`;
  }
  return encode(snapshot);
}

export const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const canonicalHash = (value) => sha256(canonical(value));

function copiedBytes(value, limit) {
  requireTrue(value !== null && typeof value === "object" && !types.isProxy(value) && types.isUint8Array(value));
  requireTrue([Buffer.prototype, Uint8Array.prototype].includes(Object.getPrototypeOf(value)));
  const length = Reflect.apply(byteLengthGetter, value, []);
  requireTrue(length > 0 && length <= limit);
  // copyBytesFrom reads typed-array storage, not iterators/toString/JSON hooks.
  const bytes = Buffer.copyBytesFrom(value);
  requireTrue(bytes.length > 0 && bytes.length <= limit);
  return bytes;
}

export function strictEntity(value, limit = 262144) {
  const bytes = copiedBytes(value, limit);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { reject(); }
  return Object.freeze({ bytes, value: parseRestrictedJson(text) });
}

export function validateRequest(entity, model) {
  const { bytes, value } = strictEntity(entity, 16384);
  exact(value, ["model", "messages", "response_format", "max_tokens", "stream", "temperature"]);
  requireTrue(value.model === model && value.stream === false && value.temperature === 0);
  matching(value.model, modelPattern);
  safeInteger(value.max_tokens, 1, 128);
  same(value.response_format, { type: "json_schema", json_schema: { name: "application_proposal", strict: true, schema: replySchema } });
  requireTrue(Array.isArray(value.messages));
  safeInteger(value.messages.length, 2, 8);
  requireTrue(value.messages.length % 2 === 0);
  let textBytes = 0;
  for (let i = 0; i < value.messages.length; i++) {
    const message = exact(value.messages[i], ["role", "content"]);
    requireTrue(message.role === (i === 0 ? "system" : i % 2 ? "user" : "assistant"));
    const parts = i === 0 ? [{ type: "text", text: message.content }] : message.content;
    requireTrue(Array.isArray(parts));
    safeInteger(parts.length, 1, 16);
    for (const part of parts) {
      exact(part, ["type", "text"]);
      requireTrue(part.type === "text" && typeof part.text === "string" && part.text.length > 0);
      textBytes += Buffer.byteLength(part.text);
    }
  }
  requireTrue(textBytes <= 2048);
  return Object.freeze({ value, wireSha256: sha256(bytes), canonicalSha256: canonicalHash(value),
    upstreamCanonicalSha256: canonicalHash({ ...value, reasoning_effort: "none" }), encodedBytes: bytes.length, messageTextBytes: textBytes });
}

export function validateProfile(profileInput, acceptanceInput, now) {
  const p = jsonSnapshot(profileInput), a = jsonSnapshot(acceptanceInput);
  exact(a, ["profileSha256", "approvalId", "generation", "hostId", "client", "transport", "ownerReceiptAt", "workDeadline", "tokenExpiresAt"]);
  hash(a.profileSha256);
  requireTrue(p.state === "qualification");
  exact(p, ["schemaVersion", "state", "issuer", "profileId", "generation", "approvalId", "hostId", "issuedAt", "expiresAt", "client", "transport", "model", "release", "canary", "requestPolicy", "replySchemaSha256", "serverDefaults", "credentialRef"]);
  requireTrue(p.schemaVersion === "localllm-aginti-text-profile-v1" && p.issuer === "localllm");
  for (const field of ["profileId", "approvalId", "credentialRef"]) id(p[field]);
  safeInteger(p.generation, 1, Number.MAX_SAFE_INTEGER);
  requireTrue(["workstation", "mac"].includes(p.hostId));
  requireTrue(canonicalHash(p) === a.profileSha256 && p.approvalId === a.approvalId && p.generation === a.generation && p.hostId === a.hostId);
  exact(p.client, ["clientId", "variant", "version", "packageSha256", "harnessSha256"]);
  id(p.client.clientId); hash(p.client.packageSha256); hash(p.client.harnessSha256);
  requireTrue((p.client.variant === "full" && p.client.version === "0.20.344-integration.1") || (p.client.variant === "lite" && p.client.version === "0.1.0-preview.2"));
  same(p.client, a.client);
  exact(p.transport, ["kind", "clientHostId", "namespaceHostId", "endpointOrigin", "apiPrefix", "bindingId", "bindingSha256"]);
  id(p.transport.bindingId); hash(p.transport.bindingSha256); same(p.transport, a.transport);
  requireTrue(p.transport.endpointOrigin === "http://127.0.0.1:18126" && p.transport.apiPrefix === "/v1" && p.transport.namespaceHostId === p.hostId);
  requireTrue(p.transport.kind === "loopback-http" ? p.transport.clientHostId === p.hostId :
    p.transport.kind === "ssh-stdio-http-relay" && p.hostId === "mac" && p.transport.clientHostId === "workstation");
  exact(p.model, ["requestAlias", "resolvedId", "manifestSha256", "runtimeContextTokens"]); hash(p.model.manifestSha256);
  same(p.model, p.hostId === "workstation" ? { requestAlias: "localllm-fast", resolvedId: "qwen3:8b-q4_K_M", manifestSha256: p.model.manifestSha256, runtimeContextTokens: 65536 } :
    { requestAlias: "localllm-qwen36", resolvedId: "qwen3.6:35b-a3b", manifestSha256: p.model.manifestSha256, runtimeContextTokens: 8192 });
  exact(p.release, ["apiReleaseId", "apiArtifactSha256", "runtimeArtifactSha256", "adapterArtifactSha256"]);
  matching(p.release.apiReleaseId, /^[0-9a-f]{8}-[0-9a-f]{8}$/);
  for (const key of ["apiArtifactSha256", "runtimeArtifactSha256", "adapterArtifactSha256"]) hash(p.release[key]);
  exact(p.canary, ["role", "verdict", "receiptSha256", "passedAt", "maxAgeSeconds"]);
  hash(p.canary.receiptSha256);
  requireTrue(p.canary.role === "text" && p.canary.verdict === "passed" && p.canary.maxAgeSeconds === 300);
  same(p.requestPolicy, requestPolicy); same(p.serverDefaults, { reasoning_effort: "none" });
  requireTrue(p.replySchemaSha256 === canonicalHash(replySchema));
  const issued = timestamp(p.issuedAt), expiry = timestamp(p.expiresAt), canary = timestamp(p.canary.passedAt);
  requireTrue(timestamp(a.ownerReceiptAt) <= issued && canary <= issued && issued < expiry && Number.isSafeInteger(now) && issued <= now && now < expiry);
  requireTrue(expiry <= Math.min(timestamp(a.workDeadline), timestamp(a.tokenExpiresAt), canary + 300000));
  return p;
}

const identityKeys = ["schemaVersion", "outcome", "requestId", "profileId", "profileGeneration", "profileSha256", "hostId", "apiReleaseId", "model", "modelManifestSha256", "canaryReceiptSha256", "clientWireSha256", "clientCanonicalSha256", "upstreamCanonicalSha256", "responseWireSha256", "dispatchedAt", "completedAt", "finishReason"];

function decodeIdentity(rawHeaders) {
  const pairs = jsonSnapshot(rawHeaders, { maxBytes: 16384 });
  requireTrue(Array.isArray(pairs) && pairs.length <= 32);
  let encoded;
  for (const pair of pairs) {
    requireTrue(Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string" && !/[\r\n]/.test(part)));
    if (pair[0].toLowerCase() === "content-encoding") reject();
    if (pair[0].toLowerCase() === "x-localllm-response-identity") {
      requireTrue(encoded === undefined); encoded = pair[1];
    }
  }
  requireTrue(typeof encoded === "string" && encoded.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(encoded));
  const decoded = Buffer.from(encoded, "base64url");
  requireTrue(decoded.length <= 3072 && decoded.toString("base64url") === encoded);
  const identity = exact(strictEntity(decoded, 3072).value, identityKeys);
  requireTrue(decoded.equals(Buffer.from(canonical(identity))));
  return identity;
}

export function validateResponse(input) {
  const { profile, acceptance, requestBytes, responseBytes, rawHeaders, requestId, startedAt, arrivedAt, elapsedMs } =
    dataFields(input, ["profile", "acceptance", "requestBytes", "responseBytes", "rawHeaders", "requestId", "startedAt", "arrivedAt", "elapsedMs"]);
  matching(requestId, requestIdPattern);
  const start = timestamp(startedAt), arrival = timestamp(arrivedAt);
  requireTrue(arrival >= start);
  const p = validateProfile(profile, acceptance, start);
  validateProfile(p, acceptance, arrival);
  requireTrue(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 && elapsedMs < Math.min(60000, timestamp(p.expiresAt) - start));
  const request = validateRequest(requestBytes, p.model.requestAlias);
  const response = strictEntity(responseBytes);
  const identity = decodeIdentity(rawHeaders);
  const dispatched = timestamp(identity.dispatchedAt), completed = timestamp(identity.completedAt);
  requireTrue(dispatched >= start - 5000 && dispatched <= completed && completed < timestamp(p.expiresAt) && completed <= arrival + 5000);
  same(identity, { schemaVersion: "localllm-aginti-response-identity-v1", outcome: "complete", requestId, profileId: p.profileId, profileGeneration: p.generation,
    profileSha256: acceptance.profileSha256, hostId: p.hostId, apiReleaseId: p.release.apiReleaseId, model: p.model.resolvedId, modelManifestSha256: p.model.manifestSha256,
    canaryReceiptSha256: p.canary.receiptSha256, clientWireSha256: request.wireSha256, clientCanonicalSha256: request.canonicalSha256,
    upstreamCanonicalSha256: request.upstreamCanonicalSha256, responseWireSha256: sha256(response.bytes), dispatchedAt: identity.dispatchedAt, completedAt: identity.completedAt, finishReason: "stop" });
  const raw = response.value;
  requireTrue(raw.model === p.model.resolvedId && Array.isArray(raw.choices) && raw.choices.length === 1);
  const choice = raw.choices[0];
  requireTrue(choice.index === 0 && choice.finish_reason === "stop");
  const message = choice.message;
  requireTrue(message?.role === "assistant" && typeof message.content === "string" && message.content.trim().length > 0);
  for (const key of ["refusal", "tool_calls", "function_call"]) requireTrue(!Object.hasOwn(message, key) || message[key] === null);
  const proposal = exact(parseRestrictedJson(message.content), ["reply"]);
  requireTrue(typeof proposal.reply === "string" && proposal.reply.trim().length > 0 && Array.from(proposal.reply).length <= 120);
  return proposal;
}
