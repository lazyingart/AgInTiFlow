import fs from "node:fs/promises";
import sync, { constants } from "node:fs";
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
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
export function workspaceReadBoundaryError(changed = false) {
  const error = Object.assign(new Error(changed
    ? "Workspace read binding changed; retry the read after the workspace is stable."
    : "Workspace read resolves outside its permitted scope or into a blocked path. Use an authorized source; stronger write permissions do not authorize this read."),
  { code: changed ? "WORKSPACE_READ_CHANGED" : "WORKSPACE_READ_SCOPE" });
  if (!changed) scopeDenials.add(error);
  return error;
}

function boundaryPlan({ root, readOnlyRoots = [], scopeRoots = [],
  writeAccess = false, allowOutside = false, blockedPath }) {
  root = path.resolve(root);
  const names = [...new Set([root, ...(!writeAccess ? readOnlyRoots : [])]
    .map(item => String(item || "").trim()).filter(Boolean).map(item => path.resolve(item)))];
  return { root, names, scopeNames: [...new Set(scopeRoots.map(name => path.resolve(name)))], writeAccess, allowOutside, blockedPath };
}

// The async and synchronous adapters share canonical policy decisions. Only the
// filesystem observation differs; neither adapter is retained storage authority.
function canonicalPolicy({ root, scopeNames, writeAccess, allowOutside, blockedPath }, bindings, scopes) {
  const primary = bindings.find(binding => binding.name === root), canonicalRoot = primary.canonical;
  const usedBindings = new Set([primary]), usedScopes = new Set();
  return {
    resolve(file, canonical) {
      const binding = bindings.find(binding => inside(binding.canonical, canonical));
      const scope = scopes.find(scope => inside(scope.canonical, canonical));
      if (!allowOutside && !binding) throw workspaceReadBoundaryError();
      if (scopeNames.length && !scope) throw workspaceReadBoundaryError();
      const policyPath = inside(canonicalRoot, canonical) ? path.relative(canonicalRoot, canonical) : canonical;
      if (isSensitiveWorkspacePath(policyPath) || blockedPath?.(canonical, canonicalRoot)) throw workspaceReadBoundaryError();
      if (writeAccess) {
        const expected = inside(root, file) ? path.resolve(canonicalRoot, path.relative(root, file)) : path.resolve(file);
        if (canonical !== expected) throw workspaceReadBoundaryError();
      }
      if (binding) usedBindings.add(binding);
      if (scope) usedScopes.add(scope);
      return canonical;
    },
    usedRoots: () => [...usedBindings, ...usedScopes],
  };
}

function observedBinding(root, name, canonical, stat, scope = false) {
  if (scope ? !inside(root, canonical) : name === root && !stat.isDirectory()) throw workspaceReadBoundaryError();
  return { name, canonical, dev: stat.dev, ino: stat.ino };
}
function verifyBinding(binding, canonical, stat) {
  if (canonical !== binding.canonical || stat.dev !== binding.dev || stat.ino !== binding.ino) throw workspaceReadBoundaryError(true);
}

// Internal native-file policy, not an application sandbox or storage authority.
// Canonical checks reject ordinary alias escapes; they are NOT openat2, retained
// descriptors or protection against an adversarial same-UID filesystem writer.
// Apps still require qualified process/filesystem isolation and host-owned scope.
export async function createWorkspaceReadBoundary(options) {
  const plan = boundaryPlan(options), { root, names, scopeNames } = plan;
  const bindings = [];
  for (const name of names) {
    try {
      const canonical = await fs.realpath(name), stat = await fs.stat(canonical, { bigint: true });
      bindings.push(observedBinding(root, name, canonical, stat));
    } catch (error) {
      if (name === root || !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) throw error;
    }
  }
  const canonicalRoot = bindings.find(binding => binding.name === root).canonical, scopes = [];
  for (const name of scopeNames) {
    try {
      const canonical = await fs.realpath(name);
      if (!inside(canonicalRoot, canonical)) throw workspaceReadBoundaryError();
      const stat = await fs.stat(canonical, { bigint: true });
      scopes.push(observedBinding(canonicalRoot, name, canonical, stat, true));
    } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  }
  const policy = canonicalPolicy(plan, bindings, scopes);
  async function resolve(file) { return policy.resolve(file, await fs.realpath(file)); }
  async function verifyRoots() {
    for (const binding of policy.usedRoots()) {
      const canonical = await fs.realpath(binding.name), stat = await fs.stat(canonical, { bigint: true });
      verifyBinding(binding, canonical, stat);
    }
  }
  async function revalidate(file, canonical) {
    if (await resolve(file) !== canonical) throw workspaceReadBoundaryError(true);
    await verifyRoots();
  }
  return Object.freeze({ resolve, revalidate, verifyRoots });
}

export function createWorkspaceReadBoundarySync(options) {
  const plan = boundaryPlan(options), { root, names, scopeNames } = plan, bindings = [];
  for (const name of names) {
    try {
      const canonical = sync.realpathSync(name), stat = sync.statSync(canonical, { bigint: true });
      bindings.push(observedBinding(root, name, canonical, stat));
    } catch (error) {
      if (name === root || !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) throw error;
    }
  }
  const canonicalRoot = bindings.find(binding => binding.name === root).canonical, scopes = [];
  for (const name of scopeNames) {
    try {
      const canonical = sync.realpathSync(name);
      if (!inside(canonicalRoot, canonical)) throw workspaceReadBoundaryError();
      scopes.push(observedBinding(canonicalRoot, name, canonical, sync.statSync(canonical, { bigint: true }), true));
    } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  }
  const policy = canonicalPolicy(plan, bindings, scopes);
  function resolve(file) { return policy.resolve(file, sync.realpathSync(file)); }
  function verifyRoots() {
    for (const binding of policy.usedRoots()) {
      const canonical = sync.realpathSync(binding.name);
      verifyBinding(binding, canonical, sync.statSync(canonical, { bigint: true }));
    }
  }
  function revalidate(file, canonical) {
    if (resolve(file) !== canonical) throw workspaceReadBoundaryError(true);
    verifyRoots();
  }
  return Object.freeze({ resolve, revalidate, verifyRoots });
}

function validateReadLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) throw new Error("Invalid bounded workspace read limit.");
}
function validateRegularSnapshot(stat, maxBytes, prefix = false) {
  if (!stat.isFile()) throw new Error("Workspace read requires a regular file.");
  if (!prefix && stat.size > BigInt(maxBytes)) throw Object.assign(new Error("File is too large to read safely."), { code: "WORKSPACE_READ_TOO_LARGE" });
}
function snapshotResult(buffer, text, truncated = false) {
  let content;
  if (text) {
    if (buffer.includes(0)) throw new Error("Binary files are not readable through this text tool.");
    // A bounded prefix may end within a valid UTF-8 code point. Keep only its
    // complete code points, never a replacement character. Invalid bytes in
    // the observed prefix still reject; bytes beyond it are not inspected.
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer, { stream: truncated }); }
    catch { throw new Error("Workspace text is not valid UTF-8; use an explicit converter without overwriting the source."); }
  }
  return { stat: { size: buffer.length }, buffer, ...(text ? { content } : {}) };
}

// One bounded live-handle snapshot. No stat-then-unbounded-readFile race, lossy
// text decoding, body return after a changed binding, or repeated close attempt.
async function readWorkspaceSnapshot(file, boundary, { maxBytes, text = false }, prefix) {
  validateReadLimit(maxBytes);
  const canonical = await boundary.resolve(file);
  // Reject FIFOs/devices by fstat without first blocking in open waiting for a
  // writer. Regular files ignore O_NONBLOCK; this is not a general I/O deadline.
  const handle = await fs.open(canonical, readFlags);
  try {
    const stat = await handle.stat({ bigint: true });
    validateRegularSnapshot(stat, maxBytes, prefix);
    const truncated = prefix && stat.size > BigInt(maxBytes);
    const buffer = Buffer.alloc(truncated ? maxBytes : Number(stat.size)); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw workspaceReadBoundaryError(true);
      offset += bytesRead;
    }
    const tail = truncated ? { bytesRead: 0 } : await handle.read(Buffer.alloc(1), 0, 1, offset);
    const same = other => identityKeys.every(key => stat[key] === other[key]);
    if (tail.bytesRead || !same(await handle.stat({ bigint: true })) ||
        !same(await fs.lstat(canonical, { bigint: true }))) throw workspaceReadBoundaryError(true);
    const result = snapshotResult(buffer, text, truncated);
    await boundary.revalidate(file, canonical);
    return prefix ? { ...result, truncated } : result;
  } finally { await handle.close(); }
}

export function readWorkspaceFileSnapshot(file, boundary, options) {
  return readWorkspaceSnapshot(file, boundary, options, false);
}

// Optional project/context previews need a prefix, unlike authoritative file
// reads which must retain their existing complete-snapshot size requirement.
// This uses the same live-handle, canonical-scope and change checks. It is not
// retained-descriptor storage, an I/O deadline or a same-UID mutation sandbox.
export function readWorkspaceFilePrefixSnapshot(file, boundary, options) {
  return readWorkspaceSnapshot(file, boundary, options, true);
}

// For existing synchronous decision APIs only. O_NONBLOCK prevents FIFO writer
// wait; a bounded regular-file read is still not a general filesystem deadline.
export function readWorkspaceFileSnapshotSync(file, boundary, { maxBytes, text = false }) {
  validateReadLimit(maxBytes);
  const canonical = boundary.resolve(file), fd = sync.openSync(canonical, readFlags);
  try {
    const stat = sync.fstatSync(fd, { bigint: true });
    validateRegularSnapshot(stat, maxBytes);
    const buffer = Buffer.alloc(Number(stat.size)); let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = sync.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw workspaceReadBoundaryError(true);
      offset += bytesRead;
    }
    const tail = sync.readSync(fd, Buffer.alloc(1), 0, 1, offset);
    const same = other => identityKeys.every(key => stat[key] === other[key]);
    if (tail || !same(sync.fstatSync(fd, { bigint: true })) || !same(sync.lstatSync(canonical, { bigint: true }))) throw workspaceReadBoundaryError(true);
    const result = snapshotResult(buffer, text);
    boundary.revalidate(file, canonical);
    return result;
  } finally { sync.closeSync(fd); }
}
