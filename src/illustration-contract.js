import { createHash } from "node:crypto";
import { types } from "node:util";

export class IllustrationError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function reject(code = "ILLUSTRATION_INVALID", status = 400) {
  throw new IllustrationError(code, status);
}

// Descriptor-only JSON snapshots: no getters, JSON hooks, sparse arrays or proxies.
export function snapshot(input, depth = 0, seen = new Set()) {
  if (depth > 16) reject();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input) > 32768 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) reject();
    return input;
  }
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (!input || typeof input !== "object" || types.isProxy(input) || seen.has(input)) reject();
  const array = Array.isArray(input);
  const proto = Object.getPrototypeOf(input);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) reject();
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string")) reject();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const length = array ? descriptors.length.value : 0;
  if (keys.length > 256 || (array && (length > 128 || keys.length !== length + 1))) reject();
  seen.add(input);
  const output = array ? [] : Object.create(null);
  for (const key of array ? Array.from({ length }, (_, i) => String(i)) : keys.sort()) {
    const d = descriptors[key];
    if (!d || !d.enumerable || !("value" in d) || ["__proto__", "constructor", "prototype", "toJSON", "then"].includes(key)) reject();
    output[key] = snapshot(d.value, depth + 1, seen);
  }
  seen.delete(input);
  return Object.freeze(output);
}
export const canonical = (value) => JSON.stringify(snapshot(value));
export const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
export const bytesDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function exact(value, keys) {
  const data = snapshot(value);
  if (!data || Array.isArray(data) || typeof data !== "object") reject();
  const actual = Object.keys(data).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) reject();
  return data;
}
export function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,128}(?![\s\S])/.test(value)) reject();
  return value;
}
export function hexDigest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(value)) reject();
  return value;
}
export function scope(input) {
  const result = exact(input, ["appId", "principalId"]);
  identifier(result.appId);
  identifier(result.principalId);
  return result;
}
export const PROFILE = snapshot({
  schemaVersion: "aginti-illustration-profile-v1",
  provider: "venice",
  endpoint: "https://api.venice.ai/api/v1/image/generate",
  model: "nano-banana-2",
  format: "png", variants: 1, safeMode: true,
  width: 1024, height: 1024, maxDimension: 2048, maxPixels: 4194304,
  maxImageBytes: 8388608, maxPromptBytes: 8192, timeoutMs: 300000,
  concurrency: 1, maxJobs: 64, maxStoredImageBytes: 67108864,
  styles: ["illustration"],
});
export const PROFILE_DIGEST = digest(PROFILE);
export function createRequest(input) {
  const r = exact(input, ["actionId", "sourceBinding", "overlayDigest", "prompt", "styleId"]);
  identifier(r.actionId);
  const binding = exact(r.sourceBinding, ["scopeDigest", "contentDigest", "policyDigest"]);
  for (const value of Object.values(binding)) hexDigest(value);
  hexDigest(r.overlayDigest);
  if (typeof r.prompt !== "string" || !r.prompt.trim() || Buffer.byteLength(r.prompt) > PROFILE.maxPromptBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(r.prompt)) reject();
  if (!PROFILE.styles.includes(r.styleId)) reject();
  return r;
}
export function ownedId(input, field) {
  const r = exact(input, [field]);
  identifier(r[field]);
  return r[field];
}
export function capabilities() {
  return snapshot({ schemaVersion: 1, enabled: false, reason: "ILLUSTRATION_QUALIFICATION_REQUIRED", profile: PROFILE, profileDigest: PROFILE_DIGEST, remoteCancellation: false });
}
