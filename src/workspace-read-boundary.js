import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const sensitiveExtensions = new Set([".key", ".pem", ".p12", ".pfx", ".crt", ".csr"]);
const sensitiveNames = new Set([".env", ".npmrc", ".pypirc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json"]);
const identityKeys = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
const scopeDenials = new WeakSet();
export function isWorkspaceReadScopeDenial(value) { return scopeDenials.has(value); }
export function isSensitiveWorkspacePath(value) {
  const segments = value.split(path.sep).filter(Boolean), lower = segments.map(part => part.toLowerCase());
  const name = lower.at(-1) || "";
  return segments.includes(".git") || lower.some(part => part === ".env" || part.startsWith(".env.")) ||
    sensitiveNames.has(name) || sensitiveExtensions.has(path.extname(name)) ||
    /(^|\/)(secrets?|tokens?|passwords?|private[-_]?keys?|credentials?)(\/|\.|$)/i.test(lower.join("/"));
}
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
export function workspaceReadBoundaryError(changed = false) {
  const error = Object.assign(new Error(changed
    ? "Workspace read binding changed; retry the read after the workspace is stable."
    : "Workspace read resolves outside its permitted scope or into a blocked path. Use an authorized source; stronger write permissions do not authorize this read."),
  { code: changed ? "WORKSPACE_READ_CHANGED" : "WORKSPACE_READ_SCOPE" });
  if (!changed) scopeDenials.add(error);
  return error;
}

// Internal native-file policy, not an application sandbox or storage authority.
// Canonical checks reject ordinary alias escapes; they are NOT openat2, retained
// descriptors or protection against an adversarial same-UID filesystem writer.
// Apps still require qualified process/filesystem isolation and host-owned scope.
export async function createWorkspaceReadBoundary({ root, readOnlyRoots = [], scopeRoots = [],
  writeAccess = false, allowOutside = false, blockedPath }) {
  root = path.resolve(root);
  const names = [...new Set([root, ...(!writeAccess ? readOnlyRoots : [])]
    .map(item => String(item || "").trim()).filter(Boolean).map(item => path.resolve(item)))];
  const bindings = [];
  for (const name of names) {
    try {
      const canonical = await fs.realpath(name), stat = await fs.stat(canonical, { bigint: true });
      if (name === root && !stat.isDirectory()) throw workspaceReadBoundaryError();
      bindings.push({ name, canonical, dev: stat.dev, ino: stat.ino });
    } catch (error) {
      if (name === root || !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) throw error;
    }
  }
  const primary = bindings.find(binding => binding.name === root);
  const canonicalRoot = primary.canonical;
  const usedBindings = new Set([primary]), usedScopes = new Set();
  const scopeNames = [...new Set(scopeRoots.map(name => path.resolve(name)))], scopes = [];
  for (const name of scopeNames) {
    try {
      const canonical = await fs.realpath(name);
      if (!inside(canonicalRoot, canonical)) throw workspaceReadBoundaryError();
      const stat = await fs.stat(canonical, { bigint: true });
      scopes.push({ name, canonical, dev: stat.dev, ino: stat.ino });
    } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  }
  async function resolve(file) {
    const canonical = await fs.realpath(file);
    const binding = bindings.find(binding => inside(binding.canonical, canonical));
    const scope = scopes.find(scope => inside(scope.canonical, canonical));
    if (!allowOutside && !binding) throw workspaceReadBoundaryError();
    if (scopeNames.length && !scope) throw workspaceReadBoundaryError();
    // Workspace roots are explicitly selected host identities (including opaque
    // session names). Apply descendant policy within that root; external read
    // roots retain the existing absolute-path secret policy.
    const policyPath = inside(canonicalRoot, canonical) ? path.relative(canonicalRoot, canonical) : canonical;
    if (isSensitiveWorkspacePath(policyPath) || blockedPath?.(canonical, canonicalRoot)) throw workspaceReadBoundaryError();
    if (writeAccess) {
      const expected = inside(root, file) ? path.resolve(canonicalRoot, path.relative(root, file)) : path.resolve(file);
      if (canonical !== expected) throw workspaceReadBoundaryError();
    }
    if (binding) usedBindings.add(binding);
    if (scope) usedScopes.add(scope);
    return canonical;
  }
  async function verifyRoots() {
    for (const binding of [...usedBindings, ...usedScopes]) {
      const canonical = await fs.realpath(binding.name), stat = await fs.stat(canonical, { bigint: true });
      if (canonical !== binding.canonical || stat.dev !== binding.dev || stat.ino !== binding.ino) throw workspaceReadBoundaryError(true);
    }
  }
  async function revalidate(file, canonical) {
    if (await resolve(file) !== canonical) throw workspaceReadBoundaryError(true);
    await verifyRoots();
  }
  return Object.freeze({ resolve, revalidate, verifyRoots });
}

// One bounded live-handle snapshot. No stat-then-unbounded-readFile race, lossy
// text decoding, body return after a changed binding, or repeated close attempt.
export async function readWorkspaceFileSnapshot(file, boundary, { maxBytes, text = false }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) throw new Error("Invalid bounded workspace read limit.");
  const canonical = await boundary.resolve(file);
  const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error("Workspace read requires a regular file.");
    if (stat.size > BigInt(maxBytes)) throw Object.assign(new Error("File is too large to read safely."), { code: "WORKSPACE_READ_TOO_LARGE" });
    const buffer = Buffer.alloc(Number(stat.size)); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw workspaceReadBoundaryError(true);
      offset += bytesRead;
    }
    const tail = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const same = other => identityKeys.every(key => stat[key] === other[key]);
    if (tail.bytesRead || !same(await handle.stat({ bigint: true })) ||
        !same(await fs.lstat(canonical, { bigint: true }))) throw workspaceReadBoundaryError(true);
    let content;
    if (text) {
      if (buffer.includes(0)) throw new Error("Binary files are not readable through this text tool.");
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
      catch { throw new Error("Workspace text is not valid UTF-8; use an explicit converter without overwriting the source."); }
    }
    await boundary.revalidate(file, canonical);
    return { stat: { size: buffer.length }, buffer, ...(text ? { content } : {}) };
  } finally { await handle.close(); }
}
