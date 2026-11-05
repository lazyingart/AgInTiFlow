import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { processIdentityForPid } from "./integration-durable-common.js";
import { isSafeSessionId } from "./session-index.js";

// Native CLI coordination on one host/local filesystem. This is not the
// retained-descriptor application repository or distributed semantic fencing.
// Owner records are published fully initialized; a remover retains the inode
// and takes a unique hard link before considering unlink of the canonical name.
const LOCK_NAME = ".agent-run.lock";
const OWNER_PREFIX = ".agent-run.owner-v2.";
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const OWNER_NAME = new RegExp(`^\\.agent-run\\.owner-v2\\.([1-9][0-9]{0,9})\\.(${UUID})\\.json$`, "u");
const CLAIM_NAME = new RegExp(`^\\.agent-run\\.lock\\.(reap|release)\\.([1-9][0-9]{0,9})\\.([a-f0-9-]{16,80}|u)\\.([0-9]{1,32}|u)\\.(${UUID})$`, "u");
const LEGACY_STALE_NAME = new RegExp(`^\\.agent-run\\.lock\\.stale\\.([1-9][0-9]{0,9})\\.(${UUID})$`, "u");
const MAX_OWNER_BYTES = 4096;
const MAX_RESIDUE = 64;
const RETRY_MS = 10;
const ACQUIRE_WAIT_MS = 1000;
const RELEASE_WAIT_MS = 5000;
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]);

function lockError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function unavailable(message = "Native session run lease cannot be proven safe.", cause) {
  return lockError("SESSION_RUN_LOCK_UNAVAILABLE", message, cause);
}

function sameInode(a, b) { return Boolean(a && b && a.dev === b.dev && a.ino === b.ino); }
function currentUid() { return typeof process.getuid === "function" ? BigInt(process.getuid()) : null; }
// Windows uses the storage directory's ACL, not POSIX chmod bits. Inode,
// no-replace publication, type and link-count checks still apply there.
function ownerOnlyMode(stat) { return process.platform === "win32" || (stat.mode & 0o7777n) === 0o600n; }
function trustedDirectoryMode(stat) { return process.platform === "win32" || (stat.mode & 0o022n) === 0n; }
function validPid(pid) { return Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647; }
function exactKeys(value, keys) {
  return value && !Array.isArray(value) && typeof value === "object" &&
    Object.keys(value).sort().join("\0") === keys.slice().sort().join("\0");
}

function validIdentity(value) {
  return exactKeys(value, ["schemaVersion", "bootId", "startTimeTicks"]) &&
    value.schemaVersion === "aginti-process-identity-v1" &&
    typeof value.bootId === "string" && /^[a-f0-9-]{16,80}$/u.test(value.bootId) &&
    typeof value.startTimeTicks === "string" && /^[0-9]{1,32}$/u.test(value.startTimeTicks);
}

function validOwner(owner, sessionId) {
  const keys = ["version", "sessionId", "pid", "token", "acquiredAt"];
  if (owner?.version === 2) keys.push("processIdentity");
  return exactKeys(owner, keys) && [1, 2].includes(owner.version) && owner.sessionId === sessionId &&
    validPid(owner.pid) &&
    typeof owner.token === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(owner.token) &&
    typeof owner.acquiredAt === "string" && Number.isFinite(Date.parse(owner.acquiredAt)) &&
    new Date(owner.acquiredAt).toISOString() === owner.acquiredAt &&
    (owner.version === 1 || owner.processIdentity === null || validIdentity(owner.processIdentity));
}

async function liveness(pid, identity) {
  let current;
  try { current = await processIdentityForPid(pid); } catch { return "unknown"; }
  if (current === null) return "dead";
  if (identity && current) {
    return identity.bootId === current.bootId && identity.startTimeTicks === current.startTimeTicks ? "alive" : "dead";
  }
  // Platforms without a qualified process-birth identity can prove absence,
  // but never infer death from age or from an occupied/reused PID.
  try { process.kill(pid, 0); } catch (error) { if (error?.code === "ESRCH") return "dead"; }
  return "unknown";
}

function safeFile(stat) {
  const uid = currentUid();
  return stat.isFile() && !stat.isSymbolicLink() && (uid === null || stat.uid === uid) &&
    ownerOnlyMode(stat) && stat.size > 0n && stat.size <= BigInt(MAX_OWNER_BYTES) && stat.nlink >= 1n;
}

async function statName(name) {
  try { return await fs.lstat(name, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function snapshot(name, sessionId) {
  let handle;
  try {
    const named = await statName(name);
    if (!named) return null;
    if (!safeFile(named)) throw unavailable("Native session lease metadata has unsafe type, owner, mode or size.");
    handle = await fs.open(name, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat({ bigint: true });
    if (!safeFile(before) || !sameInode(named, before)) throw unavailable("Native session lease identity changed.");
    const buffer = Buffer.alloc(MAX_OWNER_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await statName(name);
    if (!sameInode(current, before)) { const closing = handle; handle = null; await closing.close(); return null; }
    if (!sameInode(after, before) || !safeFile(after) ||
      after.size !== before.size || after.mtimeNs !== before.mtimeNs || BigInt(used) !== after.size) {
      throw unavailable("Native session lease metadata changed while being read.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
    const owner = JSON.parse(text);
    if (text !== JSON.stringify(owner) && text !== JSON.stringify(owner) + "\n") {
      throw unavailable("Native session lease owner encoding is noncanonical.");
    }
    if (!validOwner(owner, sessionId)) throw unavailable("Native session lease owner is malformed or unknown.");
    return { handle, owner, stat: after };
  } catch (error) {
    const closing = handle; handle = null; await closing?.close();
    if (error?.code === "ENOENT") return null;
    if (error?.code === "SESSION_RUN_LOCK_UNAVAILABLE") throw error;
    throw unavailable("Native session lease metadata cannot be read safely.", error);
  }
}

async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch (error) { if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) throw error; }
  finally { await handle?.close(); }
}

async function unlinkUnique(name, held) {
  const named = await statName(name);
  if (!named) return;
  if (!sameInode(named, held.stat) || !safeFile(named)) throw unavailable("Native session lease residue changed.");
  // Unique owner/claim names are never reused by the cooperative protocol.
  await fs.unlink(name).catch(error => { if (error?.code !== "ENOENT") throw error; });
}

async function sweepResidue(dir, sessionId) {
  const entries = (await fs.readdir(dir)).filter(name => name.startsWith(".agent-run.") && name !== LOCK_NAME);
  if (entries.length > MAX_RESIDUE) throw unavailable("Too many unresolved native session lease records.");
  for (const name of entries) {
    const candidate = OWNER_NAME.exec(name), claim = CLAIM_NAME.exec(name), legacy = LEGACY_STALE_NAME.exec(name);
    if (!candidate && !claim && !legacy) throw unavailable("Unknown native session lease residue requires inspection.");
    const target = path.join(dir, name);
    if (candidate) {
      // A live publisher may not have written any bytes yet. Its temporary
      // name is not authority and cannot be interpreted as a corrupt owner.
      // Without a live PID, a unique unlinked v2 publication can be removed
      // even if its writer died before completing JSON.
      if (!validPid(Number(candidate[1]))) throw unavailable("Invalid native publication PID.");
      if (await liveness(Number(candidate[1]), null) !== "dead") continue;
      const stat = await statName(target);
      if (!stat) continue;
      const uid = currentUid();
      if (!stat.isFile() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid) ||
        !ownerOnlyMode(stat) || stat.size > BigInt(MAX_OWNER_BYTES)) throw unavailable("Unsafe native owner publication residue.");
      if (stat.nlink === 1n) {
        await fs.unlink(target).catch(error => { if (error?.code !== "ENOENT") throw error; });
        continue;
      }
    }
    const held = await snapshot(target, sessionId);
    if (!held) continue;
    try {
      let actorPid, actorIdentity;
      if (candidate) {
        if (held.owner.version !== 2 || held.owner.pid !== Number(candidate[1]) || held.owner.token !== candidate[2]) {
          throw unavailable("Native session owner publication is not bound to its name.");
        }
        actorPid = held.owner.pid; actorIdentity = held.owner.processIdentity;
      } else if (claim) {
        actorPid = Number(claim[2]);
        if (!validPid(actorPid)) throw unavailable("Invalid native lease claim PID.");
        if ((claim[3] === "u") !== (claim[4] === "u")) throw unavailable("Native lease claim identity is invalid.");
        actorIdentity = claim[3] === "u" ? null : { schemaVersion: "aginti-process-identity-v1", bootId: claim[3], startTimeTicks: claim[4] };
      } else {
        // A legacy quarantine contains the OLD owner, but its name identifies
        // the reaper that may still be operating on it. Do not mistake the
        // original owner's death for proof that this reaper has stopped.
        actorPid = Number(legacy[1]); actorIdentity = null;
        if (!validPid(actorPid)) throw unavailable("Invalid legacy recovery PID.");
      }
      if (await liveness(actorPid, actorIdentity) === "dead") await unlinkUnique(target, held);
      else if (legacy) throw unavailable("An unresolved legacy session recovery record requires inspection.");
    } finally { await held.handle.close(); }
  }
}

async function finishDeadPublication(dir, held) {
  if (held.owner.version !== 2) return;
  const candidate = path.join(dir, `${OWNER_PREFIX}${held.owner.pid}.${held.owner.token}.json`);
  const named = await statName(candidate);
  if (named) await unlinkUnique(candidate, held);
}

async function removeCanonical(lockPath, held, kind, actorIdentity) {
  const identity = actorIdentity ? `${actorIdentity.bootId}.${actorIdentity.startTimeTicks}` : "u.u";
  const claimPath = `${lockPath}.${kind}.${process.pid}.${identity}.${crypto.randomUUID()}`;
  let linked = false;
  try {
    try { await fs.link(lockPath, claimPath); linked = true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    const claim = await statName(claimPath);
    if (!sameInode(claim, held.stat) || !safeFile(claim)) return false;
    // Exactly one removal claim plus the canonical name. Keep this link until
    // AFTER canonical unlink. A second reaper cannot pass this test while the
    // first is authorized; after unlink it cannot observe the old name again.
    const pinned = await held.handle.stat({ bigint: true });
    if (pinned.nlink !== 2n || pinned.size !== held.stat.size || pinned.mtimeNs !== held.stat.mtimeNs) return false;
    const named = await statName(lockPath);
    if (!sameInode(named, held.stat) || !safeFile(named)) return false;
    await fs.unlink(lockPath);
    await syncDirectory(path.dirname(lockPath));
    return true;
  } finally {
    if (linked) {
      const claim = await statName(claimPath);
      if (claim) await fs.unlink(claimPath);
    }
  }
}

async function prepareSessionDir(config, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "." || sessionId.length > 255 || !isSafeSessionId(sessionId) ||
    typeof config.sessionsDir !== "string" || !config.sessionsDir) {
    throw lockError("SESSION_RUN_LOCK_INVALID", "A native session lease requires an exact safe session ID and storage root.");
  }
  const root = path.resolve(config.sessionsDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await fs.realpath(root);
  const parent = await fs.stat(realRoot, { bigint: true });
  const uid = currentUid();
  if (!parent.isDirectory() || !trustedDirectoryMode(parent) || (uid !== null && parent.uid !== uid && parent.uid !== 0n)) {
    throw unavailable("Native sessions require a trusted, non-shared-writable storage root.");
  }
  const dir = path.join(realRoot, sessionId);
  if (path.dirname(dir) !== realRoot) throw lockError("SESSION_RUN_LOCK_INVALID", "Native session ID escapes its storage root.");
  await fs.mkdir(dir, { mode: 0o700 }).catch(error => { if (error?.code !== "EEXIST") throw error; });
  const stat = await fs.lstat(dir, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || !trustedDirectoryMode(stat) || (uid !== null && stat.uid !== uid)) {
    throw unavailable("Native session directory has unsafe ownership or binding.");
  }
  return dir;
}

async function publishOwner(dir, sessionId, identity) {
  const owner = { version: 2, sessionId, pid: process.pid, token: crypto.randomUUID(), processIdentity: identity || null, acquiredAt: new Date().toISOString() };
  const candidate = path.join(dir, `${OWNER_PREFIX}${owner.pid}.${owner.token}.json`);
  const lockPath = path.join(dir, LOCK_NAME);
  let handle;
  let created = false;
  try {
    handle = await fs.open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(owner) + "\n", "utf8"); await handle.sync(); await handle.close(); handle = null;
    try { await fs.link(candidate, lockPath); }
    catch (error) { if (error?.code === "EEXIST") return null; throw error; }
    await syncDirectory(dir);
  } finally {
    await handle?.close();
    if (created) await fs.unlink(candidate).catch(error => { if (error?.code !== "ENOENT") throw error; });
  }
  await syncDirectory(dir);
  const held = await snapshot(lockPath, sessionId);
  if (!held || held.owner.token !== owner.token || held.owner.pid !== process.pid) {
    await held?.handle.close();
    throw unavailable("Native session owner publication changed before entry.");
  }
  return held;
}

export async function acquireNativeSessionRunLock(config, sessionId) {
  const dir = await prepareSessionDir(config, sessionId);
  const lockPath = path.join(dir, LOCK_NAME);
  const started = performance.now();
  const identity = await processIdentityForPid(process.pid).catch(() => null);
  for (;;) {
    await sweepResidue(dir, sessionId);
    const existing = await snapshot(lockPath, sessionId);
    if (existing) {
      try {
        if (await liveness(existing.owner.pid, existing.owner.processIdentity) !== "dead") {
          const error = lockError("SESSION_RUN_ACTIVE", `Session ${sessionId} has an active or unverified run lease. Wait for completion or add a follow-up through its inbox.`);
          error.sessionId = sessionId; error.ownerPid = existing.owner.pid;
          throw error;
        }
        await finishDeadPublication(dir, existing);
        if (await removeCanonical(lockPath, existing, "reap", identity)) continue;
      } finally { await existing.handle.close(); }
    } else {
      const owned = await publishOwner(dir, sessionId, identity);
      if (owned) {
        let releasePromise;
        return () => {
          if (!releasePromise) {
            releasePromise = (async () => {
              const releaseStarted = performance.now();
              try {
                for (;;) {
                  await sweepResidue(dir, sessionId);
                  if (await removeCanonical(lockPath, owned, "release", identity)) return;
                  const named = await statName(lockPath);
                  if (!sameInode(named, owned.stat)) throw unavailable("Native session lease changed before release.");
                  if (performance.now() - releaseStarted >= RELEASE_WAIT_MS) throw unavailable("Native session lease release remains contested.");
                  await new Promise(resolve => setTimeout(resolve, RETRY_MS));
                }
              } finally { await owned.handle.close(); }
            })();
            releasePromise.catch(() => {}); // Keep the original rejection observable to the caller.
          }
          return releasePromise;
        };
      }
    }
    if (performance.now() - started >= ACQUIRE_WAIT_MS) throw unavailable("Native session lease recovery remains contested.");
    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
  }
}
