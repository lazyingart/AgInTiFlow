import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { IntegrationAuthorityError, authorityFail } from "./integration-authority-error.js";
import { contractDigest } from "./integration-policy.js";

export { IntegrationAuthorityError, authorityFail };
export {
  assertIntegrationRetainedFilePrimitives as assertRetainedProtectedFilePrimitives,
  assertIntegrationRetainedRegularFileLock as assertRetainedRegularFileLock,
  retainedIntegrationRegularFileLockObjectIdentityDigest as retainedRegularFileLockObjectIdentityDigest,
  createIntegrationRetainedFilePrimitives as createRetainedProtectedFilePrimitives,
  openIntegrationRetainedRegularFileLock as openRetainedRegularFileLock,
} from "./integration-storage-authority.js";

export const INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE =
  "unkeyed-sha256-corruption-detection-only-same-uid-forgery-out-of-scope-v1";

export function nowIso(now = () => new Date()) {
  return now().toISOString();
}

export function parseIsoMs(value, label = "timestamp") {
  if (typeof value !== "string") authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${label} must be a string timestamp.`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${label} must be a canonical ISO timestamp.`);
  }
  return ms;
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

function normalizeBootId(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-f0-9-]{16,80}$/u.test(text) ? text : "";
}

function normalizeProcessStartIdentity(value) {
  const text = String(value || "").trim();
  return /^[0-9]{1,32}$/u.test(text) ? text : "";
}

async function readSystemBootId(testHooks = {}) {
  if (typeof testHooks.bootId === "function") return normalizeBootId(await testHooks.bootId());
  if (typeof testHooks.bootId === "string") return normalizeBootId(testHooks.bootId);
  return normalizeBootId(await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => ""));
}

function parseProcStatStartTime(raw = "") {
  const close = raw.lastIndexOf(")");
  if (close < 0) return "";
  const fields = raw.slice(close + 2).trim().split(/\s+/u);
  return normalizeProcessStartIdentity(fields[19]);
}

export async function processIdentityForPid(pid = process.pid, testHooks = {}) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid < 1) return null;
  if (typeof testHooks.processIdentityForPid === "function") {
    const identity = await testHooks.processIdentityForPid(numericPid);
    if (identity === null) return null;
    return normalizeProcessIdentity(identity, { optional: true });
  }
  const bootId = await readSystemBootId(testHooks);
  if (!bootId) return undefined;
  const rawStat = await fs.readFile(`/proc/${numericPid}/stat`, "utf8").catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    return undefined;
  });
  if (rawStat === null) return null;
  if (rawStat === undefined) return undefined;
  const startTimeTicks = parseProcStatStartTime(rawStat);
  if (!startTimeTicks) return undefined;
  return Object.freeze({
    schemaVersion: "aginti-process-identity-v1",
    bootId,
    startTimeTicks,
  });
}

export function normalizeProcessIdentity(value = {}, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === "")) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bootId = normalizeBootId(value.bootId);
  const startTimeTicks = normalizeProcessStartIdentity(value.startTimeTicks);
  if (value.schemaVersion !== "aginti-process-identity-v1" || !bootId || !startTimeTicks) return null;
  return Object.freeze({
    schemaVersion: "aginti-process-identity-v1",
    bootId,
    startTimeTicks,
  });
}

function sameProcessIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.schemaVersion === "aginti-process-identity-v1" &&
      right.schemaVersion === "aginti-process-identity-v1" &&
      left.bootId === right.bootId &&
      left.startTimeTicks === right.startTimeTicks
  );
}

export async function currentProcessOwner({ token = randomHex(16), now = () => new Date(), testHooks = {} } = {}) {
  const identity = await processIdentityForPid(process.pid, testHooks);
  if (!identity) authorityFail("INTEGRATION_AUTHORITY_UNAVAILABLE", "Current process identity cannot be proven.");
  return Object.freeze({
    schemaVersion: "aginti-process-owner-v1",
    pid: process.pid,
    token,
    processIdentity: identity,
    acquiredAt: now().toISOString(),
    heartbeatAt: now().toISOString(),
  });
}

export async function processOwnerLiveness(owner = {}, { testHooks = {} } = {}) {
  const pid = Number(owner?.pid);
  if (!Number.isSafeInteger(pid) || pid < 1) return "dead";
  const identity = normalizeProcessIdentity(owner?.processIdentity, { optional: true });
  const liveIdentity = await processIdentityForPid(pid, testHooks);
  if (liveIdentity === null) return "dead";
  if (!identity || liveIdentity === undefined) return "unknown";
  return sameProcessIdentity(identity, liveIdentity) ? "alive" : "dead";
}

export function assertDigest(value, label = "digest") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${label} is invalid.`);
  }
  return value;
}

export function assertSafeSegment(value, label = "path segment") {
  const text = String(value || "");
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(text) || text === "." || text === "..") {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${label} is invalid.`);
  }
  return text;
}

export function relativePointer(...segments) {
  return segments.map((segment) => assertSafeSegment(segment)).join("/");
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function ownerOk(stat, ownerUid = currentUid()) {
  return ownerUid === null || stat.uid === ownerUid || stat.uid === 0;
}

export async function ensureOwnerOnlyDirectory(dirPath, { create = true, ownerUid = currentUid(), label = "directory" } = {}) {
  const resolved = path.resolve(String(dirPath || ""));
  if (create) await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const link = await fs.lstat(resolved).catch((error) => {
    if (error?.code === "ENOENT") authorityFail("INTEGRATION_AUTHORITY_UNAVAILABLE", `${label} does not exist.`);
    throw error;
  });
  if (link.isSymbolicLink()) authorityFail("INTEGRATION_AUTHORITY_UNAVAILABLE", `${label} must not be a symlink.`);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) authorityFail("INTEGRATION_AUTHORITY_UNAVAILABLE", `${label} must be a directory.`);
  if (!ownerOk(stat, ownerUid)) authorityFail("INTEGRATION_AUTHORITY_UNAVAILABLE", `${label} owner is invalid.`);
  if ((stat.mode & 0o077) !== 0) authorityFail("INTEGRATION_AUTHORITY_UNAVAILABLE", `${label} must be owner-only.`);
  return resolved;
}

export async function ensureStoreLayout(rootDir, names = []) {
  const root = await ensureOwnerOnlyDirectory(rootDir, { label: "integration authority root" });
  const dirs = { root };
  for (const name of names) {
    dirs[name] = await ensureOwnerOnlyDirectory(path.join(root, assertSafeSegment(name)), {
      label: `integration authority ${name} directory`,
    });
  }
  return dirs;
}

export async function fsyncDirectory(dirPath) {
  let handle;
  try {
    handle = await fs.open(dirPath, fsConstants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertProtectedFileStat(stat, filePath, { ownerUid = currentUid(), maxBytes = 1024 * 1024 } = {}) {
  if (!stat.isFile()) authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} must be a regular file.`);
  if (!ownerOk(stat, ownerUid)) authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} owner is invalid.`);
  if (stat.nlink !== 1) authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} must not have hard links.`);
  if ((stat.mode & 0o077) !== 0) authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} must be owner-only.`);
  if (stat.size < 0 || stat.size > maxBytes) authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} size is invalid.`);
}

export async function readProtectedUtf8File(filePath, { optional = false, maxBytes = 1024 * 1024 } = {}) {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    assertProtectedFileStat(stat, filePath, { maxBytes });
    return await handle.readFile("utf8");
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} must not be a symlink.`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readProtectedJsonFile(filePath, options = {}) {
  const raw = await readProtectedUtf8File(filePath, options);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} contains corrupt JSON.`);
  }
}

export async function atomicWriteProtectedJson(filePath, value) {
  const dir = path.dirname(filePath);
  await ensureOwnerOnlyDirectory(dir, { label: "integration authority data directory" });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomHex(8)}.tmp`);
  const bytes = `${JSON.stringify(value)}\n`;
  let handle;
  try {
    handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  await fs.rename(tmp, filePath);
  await fsyncDirectory(dir);
}

export async function appendProtectedJsonLine(filePath, value) {
  const dir = path.dirname(filePath);
  await ensureOwnerOnlyDirectory(dir, { label: "integration authority data directory" });
  let existed = true;
  await fs.lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") existed = false;
    else throw error;
  });
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
      0o600
    );
    const stat = await handle.stat();
    assertProtectedFileStat(stat, filePath, { maxBytes: 16 * 1024 * 1024 });
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  if (!existed) await fsyncDirectory(dir);
}

export function sealedObjectIntegrityDigest(value, domain) {
  const { integrityDigest: _integrityDigest, mac: _legacyMac, ...payload } = value || {};
  return contractDigest({ domain, securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE, payload });
}

export function sealObject(value, domain) {
  return Object.freeze({ ...value, integrityDigest: sealedObjectIntegrityDigest(value, domain) });
}

export function assertSealedObject(value, domain, label = "sealed object") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${label} must be an object.`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "mac")) {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${label} uses a legacy MAC field.`);
  }
  if (value.integrityDigest !== sealedObjectIntegrityDigest(value, domain)) {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${label} integrity digest is invalid.`);
  }
  return value;
}

async function readLockOwner(lockDir) {
  return readProtectedJsonFile(path.join(lockDir, "owner.json"), { optional: true, maxBytes: 4096 }).catch(() => null);
}

function lockOwnerToken(owner) {
  return typeof owner?.token === "string" && /^[a-f0-9]{32,128}$/u.test(owner.token) ? owner.token : "";
}

async function lockDirectoryIdentity(lockDir) {
  const stat = await fs.lstat(lockDir).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Integration authority lock path is unsafe.");
  }
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    ctimeMs: stat.ctimeMs,
  });
}

function lockIdentityFromStat(stat) {
  if (!stat.isDirectory()) {
    authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Integration authority lock handle is not a directory.");
  }
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    ctimeMs: stat.ctimeMs,
  });
}

async function lockIsBreakable(lockDir, staleMs, nowMs, testHooks = {}) {
  const link = await lockDirectoryIdentity(lockDir);
  if (!link) return true;
  const owner = await readLockOwner(lockDir);
  const acquiredMs = owner?.acquiredAt ? Date.parse(owner.acquiredAt) : Number(link.ctimeMs || 0);
  const expired = Number.isFinite(acquiredMs) && nowMs - acquiredMs > staleMs;
  if (!expired) return false;
  const liveness = await processOwnerLiveness(owner, { testHooks });
  return liveness === "dead";
}

function sameLockIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino
  );
}

async function atomicWriteLockOwnerInDirectoryHandle(dirHandle, owner) {
  const dirPath = `/proc/self/fd/${dirHandle.fd}`;
  const tmpPath = path.join(dirPath, `.owner.json.${process.pid}.${randomHex(8)}.tmp`);
  const ownerPath = path.join(dirPath, "owner.json");
  const bytes = `${JSON.stringify(owner)}\n`;
  let handle;
  try {
    handle = await fs.open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  await fs.rename(tmpPath, ownerPath);
  await dirHandle.sync();
}

async function removeDirectoryLockIfSameIdentity(lockDir, identity) {
  const current = await lockDirectoryIdentity(lockDir);
  if (!sameLockIdentity(identity, current)) return;
  await fs.rm(lockDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }).catch(() => {});
  await fsyncDirectory(path.dirname(lockDir)).catch(() => {});
}

async function releaseDirectoryLock(lockDir, token) {
  const owner = await readLockOwner(lockDir);
  if (!owner || lockOwnerToken(owner) !== token) return;
  await fs.rm(lockDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 }).catch(() => {});
}

async function breakStaleDirectoryLock(lockDir, staleMs, nowMs, testHooks = {}) {
  const before = await lockDirectoryIdentity(lockDir);
  if (!before) return true;
  const owner = await readLockOwner(lockDir);
  const token = lockOwnerToken(owner);
  const acquiredMs = owner?.acquiredAt ? Date.parse(owner.acquiredAt) : Number(before.ctimeMs || 0);
  if (!token) {
    if (Number.isFinite(acquiredMs) && nowMs - acquiredMs <= staleMs) return false;
    return breakOwnerlessStaleDirectoryLock(lockDir, before, staleMs, nowMs);
  }
  if (!(await lockIsBreakable(lockDir, staleMs, nowMs, testHooks))) return false;

  const quarantine = `${lockDir}.stale-${process.pid}-${randomHex(8)}`;
  try {
    await fs.rename(lockDir, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (error?.code === "EEXIST") return false;
    throw error;
  }

  const quarantined = await lockDirectoryIdentity(quarantine);
  const quarantinedOwner = await readLockOwner(quarantine);
  if (!sameLockIdentity(before, quarantined) || lockOwnerToken(quarantinedOwner) !== token) {
    await fs.rename(quarantine, lockDir).catch(() => {});
    authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Integration authority stale lock changed during recovery.");
  }
  const quarantinedAcquiredMs = quarantinedOwner?.acquiredAt ? Date.parse(quarantinedOwner.acquiredAt) : Number(quarantined?.ctimeMs || 0);
  const stillExpired = Number.isFinite(quarantinedAcquiredMs) && nowMs - quarantinedAcquiredMs > staleMs;
  const liveness = await processOwnerLiveness(quarantinedOwner, { testHooks });
  if (!stillExpired || liveness !== "dead") {
    await fs.rename(quarantine, lockDir).catch(() => {});
    return false;
  }
  await fs.rm(quarantine, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  await fsyncDirectory(path.dirname(lockDir)).catch(() => {});
  return true;
}

async function breakOwnerlessStaleDirectoryLock(lockDir, before, staleMs, nowMs) {
  const quarantine = `${lockDir}.ownerless-${process.pid}-${randomHex(8)}`;
  try {
    await fs.rename(lockDir, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (error?.code === "EEXIST") return false;
    throw error;
  }

  const quarantined = await lockDirectoryIdentity(quarantine);
  if (!sameLockIdentity(before, quarantined)) {
    await fs.rename(quarantine, lockDir).catch(() => {});
    authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Integration authority ownerless lock changed during recovery.");
  }
  const quarantinedOwner = await readLockOwner(quarantine);
  if (lockOwnerToken(quarantinedOwner)) {
    await fs.rename(quarantine, lockDir).catch(() => {});
    return false;
  }
  const acquiredMs = Number(before?.ctimeMs || quarantined?.ctimeMs || 0);
  if (!Number.isFinite(acquiredMs) || nowMs - acquiredMs <= staleMs) {
    await fs.rename(quarantine, lockDir).catch(() => {});
    return false;
  }
  await fs.rm(quarantine, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  await fsyncDirectory(path.dirname(lockDir)).catch(() => {});
  return true;
}

export async function withDirectoryLock(lockDir, operation, options = {}) {
  const waitMs = Number(options.waitMs ?? 5000);
  const staleMs = Number(options.staleMs ?? 60_000);
  const testHooks = options.testHooks && typeof options.testHooks === "object" ? options.testHooks : {};
  const started = Date.now();
  for (;;) {
    const token = randomHex(16);
    let acquired = false;
    let createdIdentity = null;
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      acquired = true;
      createdIdentity = await lockDirectoryIdentity(lockDir);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (acquired) {
      let dirHandle;
      try {
        dirHandle = await fs.open(lockDir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        const openedIdentity = lockIdentityFromStat(await dirHandle.stat());
        if (!sameLockIdentity(createdIdentity, openedIdentity)) {
          await dirHandle.close().catch(() => {});
          continue;
        }
        if (typeof testHooks.afterMkdir === "function") await testHooks.afterMkdir({ lockDir, token });
        const beforeOwnerIdentity = await lockDirectoryIdentity(lockDir);
        if (!sameLockIdentity(createdIdentity, beforeOwnerIdentity)) {
          await dirHandle.close().catch(() => {});
          dirHandle = null;
          continue;
        }
        const processOwner = await currentProcessOwner({ token, testHooks });
        const owner = {
          schemaVersion: "aginti-directory-lock-v1",
          pid: processOwner.pid,
          token,
          processIdentity: processOwner.processIdentity,
          acquiredAt: processOwner.acquiredAt,
        };
        await atomicWriteLockOwnerInDirectoryHandle(dirHandle, owner);
        await dirHandle.close().catch(() => {});
        dirHandle = null;
        const currentIdentity = await lockDirectoryIdentity(lockDir);
        if (!sameLockIdentity(createdIdentity, currentIdentity)) continue;
        const currentOwner = await readLockOwner(lockDir);
        if (lockOwnerToken(currentOwner) !== token) continue;
      } catch (error) {
        await dirHandle?.close().catch(() => {});
        if (error?.code === "ENOENT") continue;
        await removeDirectoryLockIfSameIdentity(lockDir, createdIdentity);
        throw error;
      }
      try {
        return await operation();
      } finally {
        await releaseDirectoryLock(lockDir, token);
      }
    }
    if (await breakStaleDirectoryLock(lockDir, staleMs, Date.now(), testHooks)) {
      continue;
    }
    if (Date.now() - started > waitMs) {
      authorityFail("INTEGRATION_AUTHORITY_BUSY", "Integration authority transaction is busy.", { status: 503 });
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export async function listFilesRecursive(rootDir, { suffix = "" } = {}) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && (!suffix || entry.name.endsWith(suffix))) out.push(full);
    }
  }
  await walk(rootDir);
  return out.sort();
}
