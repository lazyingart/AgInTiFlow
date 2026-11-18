import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { after } from "node:test";
import { createHash } from "node:crypto";

export const source = fileURLToPath(new URL("../", import.meta.url));
export const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-pipe-test-"));
after(async () => { await fs.rm(root, { recursive: true, force: true }); });
await fs.writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}\n');
for (const file of ["user.npmrc", "global.npmrc"]) await fs.writeFile(path.join(root, file), "", { mode: 0o600 });
export const env = { PATH: process.env.PATH, HOME: root, LANG: "C", CI: "true", NPM_CONFIG_USERCONFIG: path.join(root, "user.npmrc"),
  NPM_CONFIG_GLOBALCONFIG: path.join(root, "global.npmrc"), NPM_CONFIG_CACHE: path.join(root, "cache"), NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" };
export function command(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${executable}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const peerDigests = {
  "0.1.0-preview.21": "e9a74ab0aedf9716b50c4bb11d1fe568f3a5765cf5eb38ae1cff00193bd28f7d",
  "0.1.0-preview.22": "ad545149afda407ae025b5fb517fc6f1786d7d36ae603b17f334b06c4d2a0196",
};
let inputArchive = process.env.AGINTILITE_TEST_PEER_ARCHIVE;
if (inputArchive === undefined) {
  const [peer] = JSON.parse(command("npm", ["pack", "--json", "--offline", "--ignore-scripts", "--pack-destination", root], path.resolve(source, "../..")));
  inputArchive = path.join(root, peer.filename);
}
assert.ok(path.isAbsolute(inputArchive), "Supply an absolute SDK archive path");
const bytes = await fs.readFile(inputArchive);
const digest = createHash("sha256").update(bytes).digest("hex");
export const peerVersion = Object.keys(peerDigests).find(version => peerDigests[version] === digest);
assert.ok(peerVersion, "Unqualified SDK archive");
// Install the bytes just verified, even if the supplied path is replaced.
const peerArchive = path.join(root, "verified-sdk.tgz");
await fs.writeFile(peerArchive, bytes, { flag: "wx", mode: 0o600 });
export const built = JSON.parse(command(process.execPath, [path.join(source, "scripts/build-package.js"), root]));
command("npm", ["install", "--strict-peer-deps", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", peerArchive, built.archive]);
export const installed = path.join(root, "node_modules/@lazyingart/agintilite-pipe");
export const peerInstalled = path.join(root, "node_modules/@lazyingart/agintilite");
assert.equal(JSON.parse(await fs.readFile(path.join(peerInstalled, "package.json"), "utf8")).version, peerVersion);
export const pipe = await import(pathToFileURL(path.join(installed, "src/channel.js")));
export const streams = await import(pathToFileURL(path.join(installed, "src/streams.js")));
export const sdk = await import(pathToFileURL(path.join(peerInstalled, "src/restricted-application.js")));
export const str = { type: "string", minLength: 1, maxLength: 2000 };
export const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const outputSchema = object({ reply: str });
export const input = { input: [{ type: "text", text: "Fix the wording in my draft, please. Don't save yet." }] };
export const final = (reply = "Proposed, not saved.") => ({ type: "final", value: { reply } });
export const call = (id = "model_call_1") => ({ type: "tool_calls", calls: [{ id, name: "draft_read", arguments: { query: "draft" } }] });
export const tool = { name: "draft_read", description: "Read the authenticated account's draft.", inputSchema: object({ query: str }), outputSchema: object({ text: str, revision: { type: "integer", minimum: 1 } }) };
export const base = (complete = async () => final(), extra = {}) => ({ scopeId: "account_alpha_0001", provider: { supportsImages: false, complete }, instructions: "Return a proposal only; never claim a save.", outputSchema, ...extra });
export const frame = (channel, type, requestId = "request_alpha_0001", extra = {}) => {
  const { schemaVersion, protocol, nonce, scopeId } = channel.ready;
  return { schemaVersion, protocol, nonce, scopeId, type, requestId, ...extra };
};
export const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });promise.catch(() => {});return { promise, resolve, reject }; };
export async function until(predicate) {
  const end = Date.now() + 1500;
  while (!predicate()) { if (Date.now() > end) throw new Error("Bounded observation failed"); await new Promise(setImmediate); }
}
export async function bounded(promise, ms = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Test gate timed out")), ms); })]); }
  finally { clearTimeout(timer); }
}
