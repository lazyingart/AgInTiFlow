import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { processIdentityForPid } from "./integration-durable-common.js";

// Cooperative native CLI/Studio coordination, not application authentication,
// retained-descriptor storage or protection against a hostile same-UID writer.
// Keep the legacy canonical filename so old live owners still exclude entry.
const LOCK = ".inbox-mutation.lock";
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const PUBLICATION = new RegExp(`^\\.inbox-lock-owner\\.([1-9][0-9]{0,9})\\.(${UUID})$`, "u");
const CLAIM = new RegExp(`^\\.inbox-mutation\\.lock\\.(reap|release)\\.([1-9][0-9]{0,9})\\.([a-f0-9-]{16,80}|u)\\.([0-9]{1,32}|u)\\.(${UUID})$`, "u");
const LEGACY_STALE = new RegExp(`^\\.inbox-mutation\\.lock\\.stale\\.([1-9][0-9]{0,9})\\.(${UUID})$`, "u");
const SCHEMA = "aginti-inbox-mutation-lock-v2";
const MAX_BYTES = 4096;
const SYNC_UNSUPPORTED = new Set(["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]);
const sleep = () => new Promise(resolve => setTimeout(resolve, 10));
const sameInode = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
const validPid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;
const uid = () => typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === keys.slice().sort().join("\0");
function unavailable(message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code: "INBOX_LOCK_UNAVAILABLE" });
}
function validIdentity(value) {
  return exact(value, ["schemaVersion", "bootId", "startTimeTicks"]) && value.schemaVersion === "aginti-process-identity-v1" &&
    typeof value.bootId === "string" && /^[a-f0-9-]{16,80}$/u.test(value.bootId) &&
    typeof value.startTimeTicks === "string" && /^[0-9]{1,32}$/u.test(value.startTimeTicks);
}
function validOwner(value) {
  const legacy = exact(value, ["token", "pid", "createdAt"]);
  return (legacy || (exact(value, ["schemaVersion", "token", "pid", "createdAt", "processIdentity"]) &&
    value.schemaVersion === SCHEMA && (value.processIdentity === null || validIdentity(value.processIdentity)))) &&
    validPid(value.pid) && typeof value.token === "string" && new RegExp(`^${UUID}$`, "u").test(value.token) &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) &&
    new Date(value.createdAt).toISOString() === value.createdAt;
}
function safeFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && (uid() === null || stat.uid === uid()) &&
    (process.platform === "win32" || (stat.mode & 0o022n) === 0n) && stat.size > 0n && stat.size <= BigInt(MAX_BYTES) && stat.nlink >= 1n;
}
async function named(target) {
  try { return await fs.lstat(target, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
async function syncDir(dir) {
  let handle;
  try { handle = await fs.open(dir, "r"); await handle.sync(); }
  catch (error) { if (!SYNC_UNSUPPORTED.has(error?.code)) throw error; }
  finally { await handle?.close(); }
}
async function snapshot(target) {
  let handle;
  try {
    const beforeName = await named(target);
    if (!beforeName) return null;
    if (!safeFile(beforeName)) throw unavailable("Inbox lock metadata has an unsafe type, owner, mode or size.");
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat({ bigint: true });
    if (!sameInode(beforeName, before) || !safeFile(before)) throw unavailable("Inbox lock identity changed during open.");
    const bytes = Buffer.alloc(MAX_BYTES + 1); let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), current = await named(target);
    if (!sameInode(current, before)) { const closing = handle; handle = null; await closing.close(); return null; }
    if (!safeFile(after) || !sameInode(after, before) || after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs || BigInt(used) !== after.size) throw unavailable("Inbox lock metadata changed while read.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)), owner = JSON.parse(text);
    if ((text !== JSON.stringify(owner) && text !== JSON.stringify(owner) + "\n") || !validOwner(owner)) {
      throw unavailable("Inbox lock owner is corrupt or unknown; age is not proof of owner death.");
    }
    return { handle, owner, stat: after };
  } catch (error) {
    const closing = handle; handle = null; await closing?.close();
    if (error?.code === "ENOENT") return null;
    if (error?.code === "INBOX_LOCK_UNAVAILABLE") throw error;
    throw unavailable("Inbox lock cannot be read safely.", error);
  }
}
async function liveness(pid, identity) {
  let current;
  try { current = await processIdentityForPid(pid); } catch { return "unknown"; }
  if (current === null) return "dead";
  if (identity && current) return identity.bootId === current.bootId && identity.startTimeTicks === current.startTimeTicks ? "alive" : "dead";
  // No qualified process-birth observation: preserve an occupied/unknown PID.
  try { process.kill(pid, 0); return "unknown"; }
  catch (error) { return error?.code === "ESRCH" ? "dead" : "unknown"; }
}
async function unlinkUnique(target, stat) {
  const current = await named(target);
  if (!current) return;
  if (!sameInode(current, stat) || !safeFile(current)) throw unavailable("Inbox lock residue changed before cleanup.");
  await fs.unlink(target).catch(error => { if (error?.code !== "ENOENT") throw error; });
}
async function sweep(dir) {
  const entries = (await fs.readdir(dir)).filter(name => name.startsWith(".inbox-lock-owner.") || name.startsWith(LOCK + "."));
  if (entries.length > 64) throw unavailable("Too many unresolved inbox lock records.");
  for (const name of entries) {
    const publication = PUBLICATION.exec(name), claim = CLAIM.exec(name), legacy = LEGACY_STALE.exec(name);
    if (!publication && !claim && !legacy) throw unavailable("Unknown inbox lock residue requires inspection.");
    const actorPid = Number((publication || legacy)?.[1] || claim[2]);
    const actorIdentity = claim && claim[3] !== "u"
      ? { schemaVersion: "aginti-process-identity-v1", bootId: claim[3], startTimeTicks: claim[4] } : null;
    if (!validPid(actorPid) || (claim && ((claim[3] === "u") !== (claim[4] === "u")))) throw unavailable("Inbox lock residue identity is invalid.");
    if (await liveness(actorPid, actorIdentity) !== "dead") continue;
    const target = path.join(dir, name), stat = await named(target);
    if (!stat) continue;
    // A unique publisher may have died before completing JSON; only its own
    // unlinked, bounded file may be cleaned without an owner record.
    if (publication && stat.nlink === 1n) {
      if (!stat.isFile() || stat.isSymbolicLink() || (uid() !== null && stat.uid !== uid()) ||
        (stat.mode & 0o022n) !== 0n || stat.size > BigInt(MAX_BYTES)) throw unavailable("Unsafe inbox publication residue.");
      await fs.unlink(target).catch(error => { if (error?.code !== "ENOENT") throw error; }); continue;
    }
    const held = await snapshot(target);
    if (!held) continue;
    try {
      if (publication && (held.owner.pid !== actorPid || held.owner.token !== publication[2])) throw unavailable("Inbox publisher does not match its name.");
      await unlinkUnique(target, held.stat);
    } finally { await held.handle.close(); }
  }
}
async function removeExact(dir, held, kind, identity) {
  const target = path.join(dir, LOCK);
  const actor = identity ? `${identity.bootId}.${identity.startTimeTicks}` : "u.u";
  const claim = `${target}.${kind}.${process.pid}.${actor}.${crypto.randomUUID()}`;
  let linked = false;
  try {
    try { await fs.link(target, claim); linked = true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    const pinnedName = await named(claim);
    if (!sameInode(pinnedName, held.stat) || !safeFile(pinnedName)) return false;
    // Retain our unique link until canonical unlink completes. Competing
    // removers cannot authorize a successor or pass the exact two-link test.
    const pinned = await held.handle.stat({ bigint: true });
    if (pinned.nlink !== 2n || pinned.size !== held.stat.size || pinned.mtimeNs !== held.stat.mtimeNs) return false;
    const current = await named(target);
    if (!sameInode(current, held.stat) || !safeFile(current)) return false;
    await fs.unlink(target); await syncDir(dir); return true;
  } finally {
    if (linked) {
      const current = await named(claim);
      if (current) await fs.unlink(claim);
    }
  }
}
async function prepare(dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw unavailable("An exact native session directory is required.");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid() !== null && stat.uid !== uid()) ||
    (process.platform !== "win32" && (stat.mode & 0o022n) !== 0n)) throw unavailable("Inbox session directory is not trusted.");
}
async function removeDead(dir, identity) {
  const held = await snapshot(path.join(dir, LOCK));
  if (!held) return true;
  try {
    if (await liveness(held.owner.pid, held.owner.processIdentity) !== "dead") return false;
    // Finish a dead publisher's link cleanup before the two-link removal CAS.
    await unlinkUnique(path.join(dir, `.inbox-lock-owner.${held.owner.pid}.${held.owner.token}`), held.stat);
    return await removeExact(dir, held, "reap", identity);
  } finally { await held.handle.close(); }
}
export async function removeDeadNativeInboxMutationLock(dir) {
  await prepare(dir); await sweep(dir);
  return removeDead(dir, await processIdentityForPid(process.pid).catch(() => null));
}
export async function acquireNativeInboxMutationLock(dir, timeoutMs = 10_000) {
  await prepare(dir);
  const identity = await processIdentityForPid(process.pid).catch(() => null), started = performance.now();
  for (;;) {
    await sweep(dir);
    if (await named(path.join(dir, LOCK))) {
      if (await removeDead(dir, identity)) continue;
    } else {
      const owner = { schemaVersion: SCHEMA, token: crypto.randomUUID(), pid: process.pid, processIdentity: identity || null, createdAt: new Date().toISOString() };
      const publication = path.join(dir, `.inbox-lock-owner.${owner.pid}.${owner.token}`);
      let handle, created = false, published = false;
      try {
        handle = await fs.open(publication, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); created = true;
        await handle.chmod(0o600); await handle.writeFile(JSON.stringify(owner) + "\n", "utf8"); await handle.sync();
        await handle.close(); handle = null;
        try { await fs.link(publication, path.join(dir, LOCK)); published = true; }
        catch (error) { if (error?.code !== "EEXIST") throw error; }
        if (published) await syncDir(dir);
      } finally {
        await handle?.close();
        if (created) await fs.unlink(publication).catch(error => { if (error?.code !== "ENOENT") throw error; });
      }
      if (published) {
        const held = await snapshot(path.join(dir, LOCK));
        if (!held || held.owner.token !== owner.token || held.owner.pid !== process.pid) {
          await held?.handle.close(); throw unavailable("Inbox lock changed before entry.");
        }
        let releasing;
        return () => {
          if (!releasing) {
            releasing = (async () => {
              const releaseAt = performance.now();
              try {
                for (;;) {
                  await sweep(dir);
                  if (await removeExact(dir, held, "release", identity)) return;
                  if (!sameInode(await named(path.join(dir, LOCK)), held.stat)) throw unavailable("Inbox lock changed before release.");
                  if (performance.now() - releaseAt >= 5000) throw unavailable("Inbox lock release remains contested.");
                  await sleep();
                }
              } finally { await held.handle.close(); }
            })();
            releasing.catch(() => {});
          }
          return releasing;
        };
      }
    }
    if (performance.now() - started >= timeoutMs) throw Object.assign(new Error("Timed out waiting for the session inbox mutation lock."), { code: "INBOX_LOCK_TIMEOUT" });
    await sleep();
  }
}
