import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadDatabaseSync } from "./sqlite.js";
import { IllustrationError, PROFILE, PROFILE_DIGEST, canonical, digest, bytesDigest, createRequest, exact, snapshot, scope, identifier, hexDigest, reject } from "./illustration-contract.js";
import { validateIllustrationPng } from "./illustration-png.js";

const stores = new WeakSet();
const SCHEMA = "aginti-illustration-store-v1";
const STATES = ["submitting", "cancel_requested", "succeeded", "failed", "recovery_required"];
const RECORD_KEYS = ["schemaVersion", "jobId", "appId", "principalId", "actionId", "requestDigest", "profileDigest", "sourceBinding", "overlayDigest", "state", "startedAt", "deadlineAt", "cancelRequestedAt", "artifact", "error"];
function owned(row, owner) {
  if (!row || row.appId !== owner.appId || row.principalId !== owner.principalId) reject("ILLUSTRATION_NOT_FOUND", 404);
  return row;
}
function publicJob(row) {
  return snapshot({ schemaVersion: 1, jobId: row.jobId, status: row.state, profileDigest: row.profileDigest, sourceBinding: row.sourceBinding, overlayDigest: row.overlayDigest, artifact: row.artifact, error: row.error });
}
function parseRecord(row) {
  const r = exact(JSON.parse(row.record), RECORD_KEYS);
  if (canonical(r) !== row.record || digest(r) !== row.integrity || r.schemaVersion !== SCHEMA || r.jobId !== row.id || r.profileDigest !== PROFILE_DIGEST || !STATES.includes(r.state)) reject();
  for (const key of ["jobId", "appId", "principalId", "actionId"]) identifier(r[key]);
  hexDigest(r.requestDigest); hexDigest(r.overlayDigest);
  for (const value of Object.values(exact(r.sourceBinding, ["scopeDigest", "contentDigest", "policyDigest"]))) hexDigest(value);
  if (!Number.isSafeInteger(r.startedAt) || r.startedAt < 0 || r.deadlineAt !== r.startedAt + PROFILE.timeoutMs || (r.cancelRequestedAt !== null && (!Number.isSafeInteger(r.cancelRequestedAt) || r.cancelRequestedAt < r.startedAt))) reject();
  if (r.state === "succeeded") {
    const a = exact(r.artifact, ["artifactId", "mediaType", "byteLength", "sha256", "width", "height"]);
    if (a.artifactId !== `art_${r.jobId.slice(4)}` || a.mediaType !== "image/png" || r.cancelRequestedAt !== null || r.error !== null || !row.png || row.png.length !== a.byteLength || a.byteLength > PROFILE.maxImageBytes || bytesDigest(row.png) !== a.sha256 || !Number.isSafeInteger(a.width) || !Number.isSafeInteger(a.height) || a.width < 1 || a.height < 1 || a.width > PROFILE.maxDimension || a.height > PROFILE.maxDimension || a.width * a.height > PROFILE.maxPixels) reject();
  } else if (r.artifact !== null || row.png !== null) reject();
  if (r.state === "failed" ? r.error !== "ILLUSTRATION_IMAGE_REJECTED" : r.state === "recovery_required" ? r.error !== "ILLUSTRATION_RECOVERY_REQUIRED" : r.error !== null) reject();
  if ((r.state === "submitting" || r.state === "failed") && r.cancelRequestedAt !== null) reject();
  if (r.state === "cancel_requested" && r.cancelRequestedAt === null) reject();
  return r;
}

// Private local SQLite with FULL commits and bounded records. This is NOT an
// openat/retained-descriptor VFS or protection against a hostile same-UID writer.
// No automatic pruning: expired/ambiguous receipts can never become new submits.
export function openIllustrationStore(root) {
  if (process.platform !== "linux" || typeof root !== "string" || path.resolve(root) !== root || root === "/") reject("ILLUSTRATION_STORE_UNAVAILABLE", 503);
  let db, fd, closed = false, poisoned = false;
  const filename = path.join(root, "illustrations.sqlite");
  const uid = process.getuid(), gid = process.getgid();
  function valid(stat, directory) {
    return (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) && stat.uid === uid && stat.gid === gid && (stat.mode & 0o7777) === (directory ? 0o700 : 0o600);
  }
  let rootStat, fileStat;
  function check() {
    if (closed) reject("ILLUSTRATION_STORE_CLOSED", 503);
    if (poisoned) reject("ILLUSTRATION_STORE_POISONED", 503);
    try {
      const r = fs.lstatSync(root), f = fs.lstatSync(filename), retained = fs.fstatSync(fd);
      if (fs.realpathSync(root) !== root || !valid(r, true) || !valid(f, false) || !valid(retained, false) || r.dev !== rootStat.dev || r.ino !== rootStat.ino || f.dev !== fileStat.dev || f.ino !== fileStat.ino || retained.dev !== f.dev || retained.ino !== f.ino) throw new Error();
      if (f.size > PROFILE.maxStoredImageBytes + 8388608) throw new Error();
      for (const suffix of ["-journal", "-wal", "-shm"]) {
        try { if (!valid(fs.lstatSync(filename + suffix), false)) throw new Error(); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    } catch { poisoned = true; reject("ILLUSTRATION_STORE_POISONED", 503); }
  }
  function rows() {
    const loaded = db.prepare("SELECT * FROM jobs ORDER BY id").all();
    if (loaded.length > PROFILE.maxJobs) reject();
    return loaded.map((row) => ({ record: parseRecord(row), png: row.png }));
  }
  function validateReceipts(all) {
    const receipts = db.prepare("SELECT * FROM receipts").all();
    if (receipts.length > 512) reject();
    for (const r of receipts) {
      identifier(r.app); identifier(r.principal); identifier(r.key); hexDigest(r.request);
      if (!all.some(({ record: j }) => j.jobId === r.job && j.appId === r.app && j.principalId === r.principal)) reject();
    }
  }
  try {
    rootStat = fs.lstatSync(root);
    if (!valid(rootStat, true) || fs.realpathSync(root) !== root) reject();
    let created = false;
    try { fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600); created = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW); }
    fileStat = fs.fstatSync(fd);
    check();
    const DatabaseSync = loadDatabaseSync();
    db = new DatabaseSync(filename);
    db.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
    if (created) {
      db.exec("BEGIN IMMEDIATE; CREATE TABLE meta (value TEXT NOT NULL); CREATE TABLE jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL, integrity TEXT NOT NULL, png BLOB); CREATE TABLE receipts (app TEXT, principal TEXT, key TEXT, request TEXT NOT NULL, job TEXT NOT NULL, PRIMARY KEY(app,principal,key));");
      db.prepare("INSERT INTO meta VALUES (?)").run(canonical({ schema: SCHEMA, profileDigest: PROFILE_DIGEST }));
      db.exec("COMMIT");
      const dir = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") reject();
    const metadata = db.prepare("SELECT value FROM meta").all();
    if (metadata.length !== 1 || metadata[0].value !== canonical({ schema: SCHEMA, profileDigest: PROFILE_DIGEST })) reject();
    const tables = db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (canonical(tables.map((r) => ({ type: r.type, name: r.name }))) !== canonical(["jobs", "meta", "receipts"].map((name) => ({ type: "table", name })))) reject();
    validateReceipts(rows()); check();
  } catch {
    try { db?.close(); } finally { if (fd !== undefined) fs.closeSync(fd); }
    reject("ILLUSTRATION_STORE_UNAVAILABLE", 503);
  }
  function transaction(fn) {
    check();
    try { db.exec("BEGIN IMMEDIATE"); }
    catch { reject("ILLUSTRATION_STORE_BUSY", 503); }
    try {
      let all;
      try { all = rows(); validateReceipts(all); }
      catch { poisoned = true; reject("ILLUSTRATION_STORE_POISONED", 503); }
      const result = fn(all);
      check(); db.exec("COMMIT"); check();
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { poisoned = true; }
      if (error instanceof IllustrationError && error.status < 500) throw error;
      poisoned = true;
      reject("ILLUSTRATION_STORE_POISONED", 503);
    }
  }
  function write(r, png = null) {
    db.prepare("INSERT OR REPLACE INTO jobs VALUES (?,?,?,?)").run(r.jobId, canonical(r), digest(r), png);
  }
  function expired(r) {
    if (["submitting", "cancel_requested"].includes(r.state) && Date.now() >= r.deadlineAt) {
      r = snapshot({ ...r, state: "recovery_required", error: "ILLUSTRATION_RECOVERY_REQUIRED" });
      write(r);
    }
    return r;
  }
  function receipt(owner, key, request, job = null) {
    const old = db.prepare("SELECT * FROM receipts WHERE app=? AND principal=? AND key=?").get(owner.appId, owner.principalId, key);
    if (old) {
      if (old.request !== request) reject("ILLUSTRATION_IDEMPOTENCY_CONFLICT", 409);
      return old.job;
    }
    if (job) {
      if (db.prepare("SELECT count(*) AS n FROM receipts").get().n >= 512) reject("ILLUSTRATION_CAPACITY", 429);
      db.prepare("INSERT INTO receipts VALUES (?,?,?,?,?)").run(owner.appId, owner.principalId, key, request, job);
    }
    return null;
  }
  const store = Object.freeze({
    claim(ownerInput, key, request) {
      const owner = scope(ownerInput); identifier(key);
      request = createRequest(request);
      const hash = digest({ action: "create", profileDigest: PROFILE_DIGEST, request });
      return transaction((all) => {
        const replay = receipt(owner, key, hash);
        const prior = all.find(({ record: r }) => r.appId === owner.appId && r.principalId === owner.principalId && (r.jobId === replay || r.actionId === request.actionId))?.record;
        if (prior) {
          if (prior.requestDigest !== hash) reject("ILLUSTRATION_IDEMPOTENCY_CONFLICT", 409);
          receipt(owner, key, hash, prior.jobId);
          return { fresh: false, job: publicJob(expired(prior)) };
        }
        if (all.length >= PROFILE.maxJobs) reject("ILLUSTRATION_CAPACITY", 429);
        if (all.some(({ record: r }) => ["submitting", "cancel_requested", "recovery_required"].includes(r.state))) reject("ILLUSTRATION_CAPACITY", 429);
        const now = Date.now();
        const r = snapshot({ schemaVersion: SCHEMA, jobId: `job_${randomUUID()}`, appId: owner.appId, principalId: owner.principalId, actionId: request.actionId, requestDigest: hash, profileDigest: PROFILE_DIGEST, sourceBinding: request.sourceBinding, overlayDigest: request.overlayDigest, state: "submitting", startedAt: now, deadlineAt: now + PROFILE.timeoutMs, cancelRequestedAt: null, artifact: null, error: null });
        write(r); receipt(owner, key, hash, r.jobId);
        return { fresh: true, job: publicJob(r) };
      });
    },
    status(ownerInput, jobId) {
      const owner = scope(ownerInput); identifier(jobId);
      return transaction((all) => publicJob(expired(owned(all.find(({ record: r }) => r.jobId === jobId)?.record, owner))));
    },
    cancel(ownerInput, key, jobId) {
      const owner = scope(ownerInput); identifier(key); identifier(jobId);
      return transaction((all) => {
        let r = expired(owned(all.find(({ record: j }) => j.jobId === jobId)?.record, owner));
        const hash = digest({ action: "cancel", jobId });
        receipt(owner, key, hash, jobId);
        if (r.state === "submitting") {
          r = snapshot({ ...r, state: "cancel_requested", cancelRequestedAt: Date.now() }); write(r);
        }
        return publicJob(r);
      });
    },
    settle(ownerInput, jobId, image = null, rejectedImage = false) {
      const owner = scope(ownerInput);
      if (image !== null) image = validateIllustrationPng(image.bytes);
      return transaction((all) => {
        const r = expired(owned(all.find(({ record: j }) => j.jobId === jobId)?.record, owner));
        if (!["submitting", "cancel_requested"].includes(r.state)) return publicJob(r);
        const allowed = r.state === "submitting" && image !== null;
        if (allowed && all.reduce((sum, item) => sum + (item.png?.length || 0), 0) + image.byteLength > PROFILE.maxStoredImageBytes) reject("ILLUSTRATION_CAPACITY", 429);
        const artifact = allowed ? { artifactId: `art_${jobId.slice(4)}`, mediaType: "image/png", byteLength: image.byteLength, sha256: image.sha256, width: image.width, height: image.height } : null;
        const state = allowed ? "succeeded" : rejectedImage && r.state === "submitting" ? "failed" : "recovery_required";
        const next = snapshot({ ...r, state, artifact, error: allowed ? null : state === "failed" ? "ILLUSTRATION_IMAGE_REJECTED" : "ILLUSTRATION_RECOVERY_REQUIRED" });
        write(next, allowed ? image.bytes : null);
        return publicJob(next);
      });
    },
    content(ownerInput, artifactId) {
      const owner = scope(ownerInput); identifier(artifactId);
      return transaction((all) => {
        const found = all.find(({ record: r }) => r.artifact?.artifactId === artifactId);
        const r = owned(found?.record, owner);
        const verified = validateIllustrationPng(Buffer.from(found.png));
        if (verified.sha256 !== r.artifact.sha256 || verified.width !== r.artifact.width || verified.height !== r.artifact.height) reject("ILLUSTRATION_STORE_POISONED", 503);
        return { artifact: r.artifact, bytes: Buffer.from(found.png) };
      });
    },
    close() {
      if (closed) return;
      closed = true;
      try { db.close(); } finally { fs.closeSync(fd); }
    },
  });
  stores.add(store);
  return store;
}
export function assertIllustrationStore(store) {
  if (!stores.has(store)) reject("ILLUSTRATION_STORE_UNAVAILABLE", 503);
  return store;
}
