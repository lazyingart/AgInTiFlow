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

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function requireDeadPrivateTemporaryCreator(pid, testHooks = {}, label = "temporary authority") {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid < 1) {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${label} creator PID is invalid.`);
  }
  const identity = await processIdentityForPid(numericPid, testHooks);
  if (identity !== null) {
    authorityFail(
      identity === undefined ? "INTEGRATION_AUTHORITY_UNAVAILABLE" : "INTEGRATION_AUTHORITY_BUSY",
      `${label} creator is not proven dead.`,
      { status: 503 }
    );
  }
}

export async function reconcileProtectedJsonTemporaryFile(
  filePath,
  temporaryPath,
  { maxBytes = 1024 * 1024, testHooks = {}, exclusiveAuthority = false } = {}
) {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const pattern = new RegExp(
    `^\\.${escapeRegularExpression(basename)}\\.([1-9][0-9]{0,11})\\.([a-f0-9]{16})\\.tmp$`,
    "u"
  );
  if (path.dirname(temporaryPath) !== dir) {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} temporary authority path is invalid.`);
  }
  const name = path.basename(temporaryPath);
  const match = pattern.exec(name);
  if (!match) {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} temporary authority name is invalid.`);
  }
  if (!exclusiveAuthority) {
    await requireDeadPrivateTemporaryCreator(match[1], testHooks, `${filePath} temporary authority`);
  }
  let handle;
  try {
    handle = await fs.open(temporaryPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    assertProtectedFileStat(opened, temporaryPath, { maxBytes });
    const named = await fs.lstat(temporaryPath);
    if (named.dev !== opened.dev || named.ino !== opened.ino || named.size !== opened.size) {
      authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} temporary authority changed during recovery.`);
    }
    if (typeof testHooks.beforeTemporaryUnlink === "function") {
      await testHooks.beforeTemporaryUnlink({ filePath, temporaryPath, stat: opened });
    }
    await fs.unlink(temporaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  await fsyncDirectory(dir);
  return true;
}

export async function reconcileProtectedJsonTemporaryFiles(
  filePath,
  { maxBytes = 1024 * 1024, maximumFiles = 16, testHooks = {}, exclusiveAuthority = false } = {}
) {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const pattern = new RegExp(
    `^\\.${escapeRegularExpression(basename)}\\.([1-9][0-9]{0,11})\\.([a-f0-9]{16})\\.tmp$`,
    "u"
  );
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const candidates = entries
    .map((entry) => Object.freeze({ entry, match: pattern.exec(entry.name) }))
    .filter(({ match }) => match !== null)
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name));
  if (candidates.length > maximumFiles) {
    authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} has too many abandoned temporary files.`);
  }
  let removed = 0;
  for (const { entry, match } of candidates) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      authorityFail("INTEGRATION_AUTHORITY_CORRUPT", `${filePath} temporary authority type is invalid.`);
    }
    const temporaryPath = path.join(dir, entry.name);
    if (await reconcileProtectedJsonTemporaryFile(filePath, temporaryPath, {
      maxBytes,
      testHooks,
      exclusiveAuthority,
    })) removed += 1;
  }
  return removed;
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

function validatedLockRecoveryOwnerToken(owner) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return "";
  const keys = Object.keys(owner).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== "acquiredAt" ||
    keys[1] !== "pid" ||
    keys[2] !== "processIdentity" ||
    keys[3] !== "schemaVersion" ||
    keys[4] !== "token" ||
    owner.schemaVersion !== "aginti-directory-lock-v1" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    !normalizeProcessIdentity(owner.processIdentity, { optional: true })
  ) {
    return "";
  }
  const acquiredMs = Date.parse(owner.acquiredAt);
  if (!Number.isFinite(acquiredMs) || new Date(acquiredMs).toISOString() !== owner.acquiredAt) return "";
  return lockOwnerToken(owner);
}

function lockRecoveryOwnerToken(owner, requireValidatedOwnerForRecovery) {
  return requireValidatedOwnerForRecovery
    ? validatedLockRecoveryOwnerToken(owner)
    : lockOwnerToken(owner);
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

async function lockIsBreakable(
  lockDir,
  staleMs,
  nowMs,
  testHooks = {},
  { requireValidatedOwnerForRecovery = false } = {}
) {
  const link = await lockDirectoryIdentity(lockDir);
  if (!link) return true;
  const owner = await readLockOwner(lockDir);
  if (!lockRecoveryOwnerToken(owner, requireValidatedOwnerForRecovery)) return false;
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

async function inspectLockOwnerPublication(dirHandle) {
  const dirPath = `/proc/self/fd/${dirHandle.fd}`;
  const ownerPath = path.join(dirPath, "owner.json");
  const temporaryPattern = /^\.owner\.json\.([1-9][0-9]{0,11})\.([a-f0-9]{16})\.tmp$/u;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    if (entries.length > 65) {
      authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Too many lock-owner publication files exist.");
    }
    const temporary = [];
    let ownerEntry = null;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock-owner publication entry type is unsafe.");
      }
      if (entry.name === "owner.json") {
        if (ownerEntry) authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Duplicate lock owner exists.");
        ownerEntry = entry;
      } else if (temporaryPattern.test(entry.name)) {
        temporary.push(entry.name);
      } else {
        authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Unknown lock-owner publication residue exists.");
      }
    }

    let ownerStat = null;
    if (ownerEntry) {
      ownerStat = await fs.lstat(ownerPath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (!ownerStat) continue;
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || !ownerOk(ownerStat) || (ownerStat.mode & 0o077) !== 0 || ownerStat.size > 4096) {
        authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock-owner metadata is unsafe.");
      }
      if (ownerStat.nlink === 1) return readProtectedJsonFile(ownerPath, { maxBytes: 4096 });
      if (ownerStat.nlink !== 2) {
        authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock-owner publication link count is invalid.");
      }
    }

    let retry = false;
    const linked = [];
    for (const name of temporary.sort()) {
      const temporaryPath = path.join(dirPath, name);
      const stat = await fs.lstat(temporaryPath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) {
        retry = true;
        break;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || !ownerOk(stat) || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
        authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock-owner temporary metadata is unsafe.");
      }
      if (ownerStat && stat.dev === ownerStat.dev && stat.ino === ownerStat.ino) linked.push({ path: temporaryPath, stat });
      else if (stat.nlink !== 1) retry = true;
    }
    if (retry) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      continue;
    }
    if (!ownerStat) return null;
    if (linked.length !== 1 || linked[0].stat.nlink !== 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      continue;
    }
    await fs.unlink(linked[0].path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await dirHandle.sync();
  }
  authorityFail("INTEGRATION_AUTHORITY_BUSY", "Lock-owner publication is changing.", { status: 503 });
}

async function atomicClaimLockOwnerInDirectoryHandle(dirHandle, owner, testHooks = {}) {
  const existing = await inspectLockOwnerPublication(dirHandle);
  if (existing) return false;
  const dirPath = `/proc/self/fd/${dirHandle.fd}`;
  const tmpPath = path.join(dirPath, `.owner.json.${process.pid}.${randomHex(8)}.tmp`);
  const ownerPath = path.join(dirPath, "owner.json");
  const bytes = `${JSON.stringify(owner)}\n`;
  let handle;
  let linked = false;
  try {
    handle = await fs.open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  if (typeof testHooks.afterOwnerTemporarySync === "function") {
    await testHooks.afterOwnerTemporarySync({ ownerPath, temporaryPath: tmpPath, token: owner.token });
  }
  try {
    await fs.link(tmpPath, ownerPath);
    linked = true;
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
  }
  if (!linked) {
    await fs.unlink(tmpPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await dirHandle.sync();
    await inspectLockOwnerPublication(dirHandle);
    return false;
  }
  await dirHandle.sync();
  if (typeof testHooks.afterOwnerLink === "function") {
    await testHooks.afterOwnerLink({ ownerPath, temporaryPath: tmpPath, token: owner.token });
  }
  await fs.unlink(tmpPath).catch((error) => {
    // A competing reader may already have resolved the exact two-name,
    // same-inode publication after the link became authoritative.
    if (error?.code !== "ENOENT") throw error;
  });
  await dirHandle.sync();
  const published = await inspectLockOwnerPublication(dirHandle);
  if (lockOwnerToken(published) !== owner.token) {
    authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Published lock owner token changed.");
  }
  if (typeof testHooks.afterOwnerPublished === "function") {
    await testHooks.afterOwnerPublished({ ownerPath, token: owner.token });
  }
  return true;
}

async function releaseDirectoryLock(lockDir, token, testHooks = {}) {
  const parent = path.dirname(lockDir);
  const before = await lockDirectoryIdentity(lockDir);
  if (!before) return;

  let dirHandle;
  try {
    dirHandle = await fs.open(lockDir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const opened = lockIdentityFromStat(await dirHandle.stat());
    if (!sameLockIdentity(before, opened)) return;
    const owner = await inspectLockOwnerPublication(dirHandle);
    if (!owner || lockOwnerToken(owner) !== token) return;
    const named = await lockDirectoryIdentity(lockDir);
    if (!sameLockIdentity(opened, named)) return;

    const quarantine = `${lockDir}.release-${process.pid}-${token}`;
    const preexisting = await fs.lstat(quarantine).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (preexisting) {
      authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock release quarantine already exists.");
    }
    if (typeof testHooks.beforeReleaseQuarantineRename === "function") {
      await testHooks.beforeReleaseQuarantineRename({ lockDir, quarantine, token });
    }
    await fs.rename(lockDir, quarantine);
    await fsyncDirectory(parent);
    if (typeof testHooks.afterReleaseQuarantineRename === "function") {
      await testHooks.afterReleaseQuarantineRename({ lockDir, quarantine, token });
    }

    const quarantined = await lockDirectoryIdentity(quarantine);
    const canonical = await lockDirectoryIdentity(lockDir);
    if (!quarantined) {
      // A successor may already hold the new canonical lock and, while doing
      // so, finish removal of this exact release quarantine.  Absence is the
      // durable response-loss resolution; the old inode must never have been
      // restored at the canonical name.
      if (sameLockIdentity(opened, canonical)) {
        authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Released lock inode was restored unexpectedly.");
      }
      return;
    }
    if (!sameLockIdentity(opened, quarantined) || sameLockIdentity(opened, canonical)) {
      authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock release quarantine identity changed.");
    }
    const quarantinedPublication = await inspectLockQuarantinePublication(quarantine);
    if (lockOwnerToken(quarantinedPublication.owner) !== token) {
      authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock release owner changed after quarantine rename.");
    }
    if (typeof testHooks.beforeReleaseQuarantineRemove === "function") {
      await testHooks.beforeReleaseQuarantineRemove({ lockDir, quarantine, token });
    }
    await fs.rm(quarantine, { recursive: true, force: false, maxRetries: 5, retryDelay: 10 });
    await fsyncDirectory(parent);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    await dirHandle?.close().catch(() => {});
  }
}

async function requirePrivateLockQuarantineDirectory(quarantinePath) {
  const stat = await fs.lstat(quarantinePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !ownerOk(stat) ||
    (stat.mode & 0o077) !== 0
  ) {
    authorityFail(
      "INTEGRATION_AUTHORITY_LOCK_CORRUPT",
      "Integration authority lock quarantine metadata is unsafe."
    );
  }
  return Object.freeze({ dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs });
}

async function inspectLockQuarantinePublication(quarantinePath) {
  const temporaryPattern = /^\.owner\.json\.([1-9][0-9]{0,11})\.([a-f0-9]{16})\.tmp$/u;
  const names = (await fs.readdir(quarantinePath)).sort();
  if (names.length > 65 || names.some((name) => name !== "owner.json" && !temporaryPattern.test(name))) {
    authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock quarantine publication inventory is invalid.");
  }
  const ownerPath = path.join(quarantinePath, "owner.json");
  const hasOwner = names.includes("owner.json");
  let ownerStat = null;
  if (hasOwner) {
    ownerStat = await fs.lstat(ownerPath);
    if (
      !ownerStat.isFile() || ownerStat.isSymbolicLink() || !ownerOk(ownerStat)
      || (ownerStat.mode & 0o077) !== 0 || ![1, 2].includes(ownerStat.nlink)
      || ownerStat.size < 1 || ownerStat.size > 4096
    ) {
      authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock quarantine owner metadata is unsafe.");
    }
  }

  const temporaryStats = new Map();
  const linked = [];
  for (const name of names.filter((value) => value !== "owner.json")) {
    const target = path.join(quarantinePath, name);
    const stat = await fs.lstat(target);
    if (
      !stat.isFile() || stat.isSymbolicLink() || !ownerOk(stat)
      || (stat.mode & 0o077) !== 0 || ![1, 2].includes(stat.nlink)
      || stat.size < 0 || stat.size > 4096
    ) {
      authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock quarantine owner temporary metadata is unsafe.");
    }
    if (ownerStat && stat.dev === ownerStat.dev && stat.ino === ownerStat.ino) linked.push(name);
    else if (stat.nlink !== 1) {
      authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock quarantine contains a foreign hard link.");
    }
    temporaryStats.set(name, stat);
  }
  if (
    (!ownerStat && linked.length !== 0)
    || (ownerStat?.nlink === 1 && linked.length !== 0)
    || (ownerStat?.nlink === 2 && linked.length !== 1)
  ) {
    authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock quarantine owner publication is incomplete.");
  }

  let owner = null;
  if (ownerStat) {
    let handle;
    try {
      handle = await fs.open(ownerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (
        opened.dev !== ownerStat.dev || opened.ino !== ownerStat.ino
        || opened.nlink !== ownerStat.nlink || opened.size !== ownerStat.size
      ) authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock quarantine owner changed while opening.");
      const raw = await handle.readFile("utf8");
      if (Buffer.byteLength(raw, "utf8") !== ownerStat.size) {
        authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock quarantine owner changed while reading.");
      }
      try {
        owner = JSON.parse(raw);
      } catch {
        authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock quarantine owner JSON is corrupt.");
      }
    } finally {
      await handle?.close().catch(() => {});
    }
    if (linked.length === 1 && temporaryPattern.exec(linked[0])?.[1] !== String(owner?.pid)) {
      authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock quarantine linked owner PID is invalid.");
    }
  }

  if (JSON.stringify((await fs.readdir(quarantinePath)).sort()) !== JSON.stringify(names)) {
    authorityFail("INTEGRATION_AUTHORITY_BUSY", "Lock quarantine publication is changing.", { status: 503 });
  }
  if (ownerStat) {
    const current = await fs.lstat(ownerPath);
    if (
      current.dev !== ownerStat.dev || current.ino !== ownerStat.ino
      || current.nlink !== ownerStat.nlink || current.size !== ownerStat.size
    ) authorityFail("INTEGRATION_AUTHORITY_BUSY", "Lock quarantine owner is changing.", { status: 503 });
  }
  for (const [name, before] of temporaryStats) {
    const current = await fs.lstat(path.join(quarantinePath, name));
    if (
      current.dev !== before.dev || current.ino !== before.ino
      || current.nlink !== before.nlink || current.size !== before.size
    ) authorityFail("INTEGRATION_AUTHORITY_BUSY", "Lock quarantine temporary is changing.", { status: 503 });
  }
  return Object.freeze({ names, owner });
}

async function reconcileAbandonedDirectoryLockQuarantines(
  lockDir,
  staleMs,
  testHooks = {},
  { requireValidatedOwnerForRecovery = false } = {}
) {
  const parent = path.dirname(lockDir);
  const basename = path.basename(lockDir);
  const pattern = new RegExp(
    `^${escapeRegularExpression(basename)}\\.(stale|ownerless)-([1-9][0-9]{0,11})-([a-f0-9]{16})$`,
    "u"
  );
  const releasePattern = new RegExp(
    `^${escapeRegularExpression(basename)}\\.release-([1-9][0-9]{0,11})-([a-f0-9]{32})$`,
    "u"
  );
  const entries = await fs.readdir(parent, { withFileTypes: true });
  const quarantines = entries
    .map((entry) => {
      const match = pattern.exec(entry.name);
      const releaseMatch = releasePattern.exec(entry.name);
      return Object.freeze({
        entry,
        kind: match?.[1] ?? (releaseMatch ? "release" : null),
        pid: match?.[2] ?? releaseMatch?.[1] ?? null,
        suffix: match?.[3] ?? releaseMatch?.[2] ?? null,
      });
    })
    .filter(({ kind }) => kind !== null)
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name));
  if (quarantines.length > 64) {
    authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Too many abandoned lock quarantines exist.");
  }
  for (const { entry, kind, pid, suffix } of quarantines) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Integration authority lock quarantine type is unsafe.");
    }
    const quarantinePath = path.join(parent, entry.name);
    const before = await requirePrivateLockQuarantineDirectory(quarantinePath);
    if (!before) continue;
    const publication = await inspectLockQuarantinePublication(quarantinePath);
    const children = publication.names;
    if (kind === "release") {
      if (publication.owner) {
        const owner = publication.owner;
        if (
          !validatedLockRecoveryOwnerToken(owner) ||
          lockOwnerToken(owner) !== suffix ||
          String(owner.pid) !== pid
        ) {
          authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Release lock quarantine owner is invalid.");
        }
      }
    } else if (kind === "stale") {
      if (publication.owner) {
        const owner = publication.owner;
        const token = lockRecoveryOwnerToken(owner, requireValidatedOwnerForRecovery);
        const acquiredMs = owner?.acquiredAt ? Date.parse(owner.acquiredAt) : Number(before.ctimeMs || 0);
        const liveness = await processOwnerLiveness(owner, { testHooks });
        if (!token || !Number.isFinite(acquiredMs) || Date.now() - acquiredMs <= staleMs || liveness !== "dead") {
          authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Stale lock quarantine is not reclaimable.");
        }
      }
    } else {
      const lateOwner = publication.owner !== null;
      if (lateOwner) {
        const owner = publication.owner;
        if (!validatedLockRecoveryOwnerToken(owner)) {
          authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Late ownerless-quarantine owner is invalid.");
        }
        const canonical = await lockDirectoryIdentity(lockDir);
        if (!canonical || sameLockIdentity(before, canonical)) {
          authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Late ownerless quarantine lacks a distinct canonical winner.");
        }
      } else {
        if (Date.now() - Number(before.ctimeMs || 0) <= staleMs) {
          authorityFail("INTEGRATION_AUTHORITY_BUSY", "Ownerless lock quarantine is not yet stale.", { status: 503 });
        }
      }
    }
    const stable = await requirePrivateLockQuarantineDirectory(quarantinePath);
    if (!sameLockIdentity(before, stable)) {
      authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Lock quarantine changed during recovery.");
    }
    if (typeof testHooks.beforeAbandonedQuarantineRemove === "function") {
      await testHooks.beforeAbandonedQuarantineRemove({ lockDir, quarantinePath, kind });
    }
    await fs.rm(quarantinePath, { recursive: true, force: false, maxRetries: 5, retryDelay: 10 });
    await fsyncDirectory(parent);
  }
}

async function breakStaleDirectoryLock(
  lockDir,
  staleMs,
  nowMs,
  testHooks = {},
  { requireValidatedOwnerForRecovery = false } = {}
) {
  const before = await lockDirectoryIdentity(lockDir);
  if (!before) return true;
  const owner = await readLockOwner(lockDir);
  const token = lockRecoveryOwnerToken(owner, requireValidatedOwnerForRecovery);
  const acquiredMs = owner?.acquiredAt ? Date.parse(owner.acquiredAt) : Number(before.ctimeMs || 0);
  if (!token) {
    // Ownerless canonical directories are not reaped.  Every contender may
    // atomically claim owner.json through the hard-link publication protocol,
    // so a paused creator simply loses that claim without any rename race.
    return false;
  }
  if (!(
    await lockIsBreakable(
      lockDir,
      staleMs,
      nowMs,
      testHooks,
      { requireValidatedOwnerForRecovery }
    )
  )) return false;

  const quarantine = `${lockDir}.stale-${process.pid}-${randomHex(8)}`;
  try {
    await fs.rename(lockDir, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  await fsyncDirectory(path.dirname(lockDir));
  if (typeof testHooks.afterStaleQuarantineRename === "function") {
    await testHooks.afterStaleQuarantineRename({ lockDir, quarantine });
  }

  const quarantined = await lockDirectoryIdentity(quarantine);
  const quarantinedPublication = await inspectLockQuarantinePublication(quarantine);
  const quarantinedOwner = quarantinedPublication.owner;
  if (
    !sameLockIdentity(before, quarantined) ||
    lockRecoveryOwnerToken(quarantinedOwner, requireValidatedOwnerForRecovery) !== token
  ) {
    await fs.rename(quarantine, lockDir).catch(() => {});
    await fsyncDirectory(path.dirname(lockDir)).catch(() => {});
    authorityFail("INTEGRATION_AUTHORITY_LOCK_CORRUPT", "Integration authority stale lock changed during recovery.");
  }
  const quarantinedAcquiredMs = quarantinedOwner?.acquiredAt ? Date.parse(quarantinedOwner.acquiredAt) : Number(quarantined?.ctimeMs || 0);
  const stillExpired = Number.isFinite(quarantinedAcquiredMs) && nowMs - quarantinedAcquiredMs > staleMs;
  const liveness = await processOwnerLiveness(quarantinedOwner, { testHooks });
  if (!stillExpired || liveness !== "dead") {
    await fs.rename(quarantine, lockDir).catch(() => {});
    await fsyncDirectory(path.dirname(lockDir)).catch(() => {});
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
  const requireValidatedOwnerForRecovery = options.requireValidatedOwnerForRecovery === true;
  const started = Date.now();
  for (;;) {
    const token = randomHex(16);
    let created = false;
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const candidateIdentity = await lockDirectoryIdentity(lockDir);
    if (candidateIdentity) {
      let dirHandle;
      let claimed = false;
      try {
        dirHandle = await fs.open(lockDir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        const openedIdentity = lockIdentityFromStat(await dirHandle.stat());
        if (!sameLockIdentity(candidateIdentity, openedIdentity)) {
          await dirHandle.close().catch(() => {});
          continue;
        }
        if (created && typeof testHooks.afterMkdir === "function") await testHooks.afterMkdir({ lockDir, token });
        const beforeOwnerIdentity = await lockDirectoryIdentity(lockDir);
        if (!sameLockIdentity(candidateIdentity, beforeOwnerIdentity)) {
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
        claimed = await atomicClaimLockOwnerInDirectoryHandle(dirHandle, owner, testHooks);
        await dirHandle.close().catch(() => {});
        dirHandle = null;
        if (!claimed) {
          // Another contender won owner.json's no-replace link.  Its exact
          // owner is resolved below by the ordinary stale/live-owner path.
        } else {
          const currentIdentity = await lockDirectoryIdentity(lockDir);
          if (!sameLockIdentity(candidateIdentity, currentIdentity)) continue;
          const currentOwner = await readLockOwner(lockDir);
          if (lockOwnerToken(currentOwner) !== token) continue;
        }
      } catch (error) {
        await dirHandle?.close().catch(() => {});
        if (error?.code === "ENOENT") continue;
        if (claimed) await releaseDirectoryLock(lockDir, token, testHooks);
        throw error;
      }
      if (claimed) {
        try {
          await reconcileAbandonedDirectoryLockQuarantines(
            lockDir,
            staleMs,
            testHooks,
            { requireValidatedOwnerForRecovery }
          );
          return await operation();
        } finally {
          await releaseDirectoryLock(lockDir, token, testHooks);
        }
      }
    }
    if (await breakStaleDirectoryLock(
      lockDir,
      staleMs,
      Date.now(),
      testHooks,
      { requireValidatedOwnerForRecovery }
    )) {
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
