import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Internal to the guarded workspace text tools, not a sandbox/storage authority.
// Same-directory rename/link publishes complete data. This is not a multi-file
// transaction, kernel conditional overwrite, or retained-descriptor root proof.
const MAX_BYTES = 220_000;
const queues = new Map();
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const nofollow = constants.O_NOFOLLOW || 0;
const identityFields = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
const sameFile = (a, b) => identityFields.every(k => a[k] === b[k]);

function conflict(message) {
  return Object.assign(new Error(message), { code: "WORKSPACE_WRITE_CONFLICT" });
}

export function throwIfWorkspaceAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error("Workspace operation interrupted."), {
    name: "AbortError", code: "ABORT_ERR",
  });
}

function waitForTurn(previous, signal) {
  throwIfWorkspaceAborted(signal);
  if (!signal) return previous;
  return new Promise((resolve, reject) => {
    const clear = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clear();
      try { throwIfWorkspaceAborted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => { clear(); resolve(); }, error => { clear(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

async function serialized(key, operation, signal) {
  throwIfWorkspaceAborted(signal);
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const done = new Promise(resolve => { release = resolve; });
  queues.set(key, done);
  let entered = false;
  const finish = () => {
    release();
    if (queues.get(key) === done) queues.delete(key);
  };
  try {
    await waitForTurn(previous, signal);
    entered = true;
    throwIfWorkspaceAborted(signal);
    return await operation();
  } finally {
    // A cancelled waiter returns promptly but its placeholder cannot release
    // successors ahead of the still-running predecessor. It never runs later.
    if (entered) finish();
    else previous.then(finish, finish);
  }
}

async function boundedBytes(handle, stat) {
  if (!stat.isFile() || stat.size > BigInt(MAX_BYTES)) throw new Error("Workspace text file is not a bounded regular file.");
  const bytes = Buffer.alloc(Number(stat.size));
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) throw conflict("Workspace file changed during its read.");
    offset += bytesRead;
  }
  const tail = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
  if (tail.bytesRead || !sameFile(stat, await handle.stat({ bigint: true }))) throw conflict("Workspace file changed during its read.");
  return bytes;
}

async function snapshot(file) {
  let named;
  try { named = await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!named.isFile() || named.nlink !== 1n || (named.mode & 0o7000n) !== 0n) {
    throw new Error("Workspace replacement requires a regular, singly linked file without special permission bits.");
  }
  if (typeof process.geteuid === "function" && named.uid !== BigInt(process.geteuid())) {
    throw new Error("Workspace replacement cannot change another owner's file identity.");
  }
  const handle = await fs.open(file, constants.O_RDONLY | nofollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(named, opened)) throw conflict("Workspace file identity changed before its read.");
    const bytes = await boundedBytes(handle, opened);
    if (bytes.includes(0)) throw new Error("Binary files cannot be overwritten through this tool.");
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Existing workspace text is not valid UTF-8; use an explicit converter."); }
    return { bytes, stat: opened, hash: hash(bytes) };
  } finally { await handle.close(); }
}

async function requireAbsent(file) {
  // Creation never needs the incumbent's contents or its transient link count.
  // A winner can briefly have two links while its staging alias is removed.
  try { await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  throw Object.assign(new Error("File already exists; create-only publication refused."), { code: "EEXIST" });
}

async function parentBinding(target, signal) {
  throwIfWorkspaceAborted(signal);
  const raw = path.dirname(target.absolutePath);
  // Inspect each existing component before creating descendants: recursive mkdir
  // would otherwise create directories through an already-present symlink.
  const anchor = target.outsideWorkspace ? path.parse(raw).root : target.root;
  let directory = await fs.realpath(anchor);
  for (const segment of path.relative(anchor, raw).split(path.sep).filter(Boolean)) {
    if (segment === "..") throw new Error("Workspace parent escapes its root.");
    directory = path.join(directory, segment);
    let entry;
    try { entry = await fs.lstat(directory); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      throwIfWorkspaceAborted(signal);
      try { await fs.mkdir(directory); } catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      entry = await fs.lstat(directory);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Workspace writes cannot traverse a directory symlink.");
  }
  const canonical = await fs.realpath(raw);
  if (!target.outsideWorkspace) {
    const root = await fs.realpath(target.root);
    const expected = path.resolve(root, path.relative(target.root, raw));
    if (canonical !== expected) throw new Error("Workspace writes cannot traverse a directory symlink.");
  }
  const stat = await fs.stat(canonical, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Workspace parent is not a directory.");
  throwIfWorkspaceAborted(signal);
  return { raw, canonical, stat };
}

async function assertParent(parent) {
  const now = await fs.stat(parent.canonical, { bigint: true });
  if (await fs.realpath(parent.raw) !== parent.canonical ||
      !["dev", "ino", "uid", "gid", "mode"].every(k => now[k] === parent.stat[k])) {
    throw conflict("Workspace parent binding changed before publication.");
  }
}

async function removeStage(stage, expected) {
  try {
    const named = await fs.lstat(stage, { bigint: true });
    if (!named.isFile() || named.dev !== expected.dev || named.ino !== expected.ino) {
      throw conflict("Workspace staging identity changed; cleanup refused.");
    }
    await fs.unlink(stage);
    return null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return error;
  }
}

export async function publishWorkspaceTextFile(target, bytes, { createOnly = false, expectedBeforeHash, signal } = {}) {
  throwIfWorkspaceAborted(signal);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw new Error("Workspace write exceeds the bounded text limit.");
  const parent = await parentBinding(target, signal);
  const destination = path.join(parent.canonical, path.basename(target.absolutePath));
  return serialized(destination, async () => {
    await assertParent(parent);
    const before = createOnly ? await requireAbsent(destination) : await snapshot(destination);
    if (expectedBeforeHash !== undefined && expectedBeforeHash !== before?.hash) {
      throw conflict(`Base hash mismatch for ${target.relativePath}; read the file again before patching.`);
    }
    throwIfWorkspaceAborted(signal);
    const stage = path.join(parent.canonical, `.aginti-write-${process.pid}-${crypto.randomUUID()}.tmp`);
    let handle, staged, published = false, failure;
    try {
      handle = await fs.open(stage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600);
      // Remember the exclusive staging pathname's identity as well as fstat;
      // this also permits safe cleanup if the first handle.stat rejects.
      staged = await fs.lstat(stage, { bigint: true });
      if (!sameFile(staged, await handle.stat({ bigint: true }))) throw conflict("Workspace staging binding changed.");
      if (!staged.isFile() || staged.nlink !== 1n) throw conflict("Workspace staging file is not private regular storage.");
      await handle.writeFile(bytes);
      const written = await handle.stat({ bigint: true });
      if (!(await boundedBytes(handle, written)).equals(bytes)) throw new Error("Workspace staged bytes failed verification.");
      if (before && typeof process.geteuid === "function" && (written.uid !== before.stat.uid || written.gid !== before.stat.gid)) {
        await handle.chown(Number(before.stat.uid), Number(before.stat.gid));
      }
      await handle.chmod(before ? Number(before.stat.mode & 0o777n) : 0o666 & ~process.umask());
      await handle.sync();
      throwIfWorkspaceAborted(signal);
      const sealed = await handle.stat({ bigint: true });
      const closing = handle; handle = null;
      await closing.close();
      await assertParent(parent);
      const current = createOnly ? await requireAbsent(destination) : await snapshot(destination);
      if (before ? !current || !sameFile(before.stat, current.stat) || current.hash !== before.hash : current !== null) {
        throw conflict(`Workspace target changed before publication: ${target.relativePath}`);
      }
      if (!sameFile(sealed, await fs.lstat(stage, { bigint: true }))) throw conflict("Workspace staging file changed before publication.");
      throwIfWorkspaceAborted(signal);
      if (!before) await fs.link(stage, destination); // Kernel no-clobber, even after the last check.
      else await fs.rename(stage, destination);
      // Once admitted to the OS, publication can win a cancellation race. Do
      // not throw away a committed receipt or pretend the bytes were undone.
      published = true;
    } catch (error) { failure = error; }
    // Release a handle at most once, even if close rejects. Never retry a possibly
    // recycled descriptor. Attempt staging cleanup after every acquired resource.
    if (handle) {
      const closing = handle; handle = null;
      try { await closing.close(); } catch (error) { failure ||= error; }
    }
    const cleanup = staged ? await removeStage(stage, staged) : null;
    if (failure && !published) {
      if (cleanup) throw new AggregateError([failure, cleanup], `${failure.message}; workspace staging cleanup also failed.`);
      throw failure;
    }
    // Publication cannot be undone because an alias cleanup fails. Preserve the
    // successful receipt and explicitly report residual staging for the caller.
    return { beforeBytes: before?.bytes || Buffer.alloc(0), created: !before,
      publication: { method: before ? "rename" : "exclusive-link", fileSynced: true,
        ...(cleanup ? { stagingCleanupPending: true, stagingPath: path.join(path.dirname(target.relativePath), path.basename(stage)).replace(/\\/g, "/") } : {}) } };
  }, signal);
}
