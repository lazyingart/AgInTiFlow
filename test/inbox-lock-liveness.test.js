import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import test from "node:test";
import { SessionStore } from "../src/session-store.js";
import { processIdentityForPid } from "../src/integration-durable-common.js";

const observed = promise => promise.then(value => ({ value }), error => ({ error }));
function gate() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Inbox fixture timeout: ${label}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-inbox-lock-")), children = [];
  const store = new SessionStore(path.join(root, "sessions"), "inbox-lock", { inboxLockTimeoutMs: 120 });
  await fs.mkdir(store.sessionDir, { recursive: true, mode: 0o700 });
  t.after(async () => {
    for (const actor of children) if (actor.instance.exitCode === null && actor.instance.signalCode === null) actor.instance.kill("SIGKILL");
    await Promise.all(children.map(actor => bounded(actor.closed, "child cleanup")));
    await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" });
  });
  return { root, store, children, lock: store.inboxLockPath };
}
async function legacy(f, pid = 2147483647) {
  if (pid === 2147483647) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const owner = { token: crypto.randomUUID(), pid, createdAt: "2001-01-01T00:00:00.000Z" };
  await fs.writeFile(f.lock, JSON.stringify(owner) + "\n", { mode: 0o600 }); return owner;
}
async function actor(f, mode, worker = 0) {
  const instance = fork(new URL("./fixtures/inbox-lock-child.js", import.meta.url), [f.root, mode, String(worker)], {
    execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: process.env.PATH, HOME: f.root, LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(f.root, "home"), AGINTIFLOW_HOUSEKEEPING: "0" },
  });
  let diagnostics = "";instance.stderr.on("data", b => diagnostics += b);instance.stdout.resume();
  const messages = [], updates = [];
  instance.on("message", message => { messages.push(message); for (const done of updates.splice(0)) done(); });
  const closed = new Promise(resolve => instance.once("close", (code, signal) => { for (const done of updates.splice(0)) done(); resolve({ code, signal }); }));
  const result = { instance, closed, async message(type) {
    while (!messages.some(m => m.type === type)) {
      if (instance.exitCode !== null || instance.signalCode !== null) throw Error(`Child ended before ${type}: ${diagnostics}`);
      await bounded(new Promise(done => updates.push(done)), type);
    }
    return messages.find(m => m.type === type);
  } }; f.children.push(result); return result;
}

for (const legacyOwner of [false, true]) test(`age cannot reap a ${legacyOwner ? "legacy" : "current"} live inbox owner`, async t => {
  const f = await fixture(t); let release;
  if (legacyOwner) await legacy(f, process.pid); else release = await f.store.acquireInboxLock();
  const bytes = await fs.readFile(f.lock), before = await fs.stat(f.lock, { bigint: true });
  await fs.utimes(f.lock, new Date(0), new Date(0));
  assert.equal(await f.store.removeStaleInboxLock(), false);
  let entered = false;
  const other = new SessionStore(path.join(f.root, "sessions"), "inbox-lock", { inboxLockTimeoutMs: 60 });
  await assert.rejects(other.withInboxLock(() => { entered = true; }), { code: "INBOX_LOCK_TIMEOUT" });
  assert.equal(entered, false); assert.deepEqual(await fs.readFile(f.lock), bytes);
  assert.equal((await fs.stat(f.lock, { bigint: true })).ino, before.ino);
  // Restore only the mtime changed by this fixture before the original release
  // validates its retained snapshot. An external metadata edit is not authority.
  if (release) {
    await assert.rejects(release(), { code: "INBOX_LOCK_UNAVAILABLE" });
    await fs.unlink(f.lock);
  } else await fs.unlink(f.lock);
  const fresh = await other.acquireInboxLock(); await fresh();
});

test("a live owner held past the old age boundary keeps its retained release identity", async t => {
  const f = await fixture(t), nativeNow = Date.now;
  const release = await f.store.acquireInboxLock();
  try {
    Date.now = () => nativeNow() + 180_000;
    assert.equal(await f.store.removeStaleInboxLock(), false);
    await assert.rejects(f.store.acquireInboxLock(), { code: "INBOX_LOCK_TIMEOUT" });
  } finally { Date.now = nativeNow; await release(); }
  assert.deepEqual(await fs.readdir(f.store.sessionDir), []);
});

test("unavailable birth evidence preserves a live PID without touching its bytes", async t => {
  const f = await fixture(t); await legacy(f, process.pid); const bytes = await fs.readFile(f.lock);
  const nativeRead = fs.readFile;
  t.mock.method(fs, "readFile", (target, ...args) => target === "/proc/sys/kernel/random/boot_id"
    ? Promise.reject(Object.assign(Error("Identity unavailable"), { code: "EACCES" })) : Reflect.apply(nativeRead, fs, [target, ...args]));
  assert.equal(await f.store.removeStaleInboxLock(), false);
  await assert.rejects(f.store.acquireInboxLock(), { code: "INBOX_LOCK_TIMEOUT" });
  assert.deepEqual(await nativeRead(f.lock), bytes);
});

test("a proven-dead legacy owner recovers without waiting for an age threshold", async t => {
  const f = await fixture(t); await legacy(f);
  const release = await f.store.acquireInboxLock();
  const owner = JSON.parse(await fs.readFile(f.lock)); assert.equal(owner.pid, process.pid); assert.equal(owner.schemaVersion, "aginti-inbox-mutation-lock-v2");
  if (process.platform !== "win32") assert.equal((await fs.stat(f.lock)).mode & 0o7777, 0o600);
  await release(); assert.deepEqual(await fs.readdir(f.store.sessionDir), []);
});

test("proven PID reuse recovers a previous birth, including its unfinished publication link", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t), identity = await processIdentityForPid();
  const owner = { schemaVersion: "aginti-inbox-mutation-lock-v2", token: crypto.randomUUID(), pid: process.pid,
    processIdentity: { ...identity, startTimeTicks: identity.startTimeTicks + "0" }, createdAt: new Date().toISOString() };
  const publication = path.join(f.store.sessionDir, `.inbox-lock-owner.${owner.pid}.${owner.token}`);
  await fs.writeFile(publication, JSON.stringify(owner) + "\n", { mode: 0o600 }); await fs.link(publication, f.lock);
  const release = await f.store.acquireInboxLock(); assert.notEqual(JSON.parse(await fs.readFile(f.lock)).token, owner.token);
  await assert.rejects(fs.stat(publication), { code: "ENOENT" }); await release();
});

for (const damage of ["empty", "invalid", "extra", "duplicate", "pid-string", "future"]) test(`corrupt aged owner ${damage} is never treated as dead`, async t => {
  const f = await fixture(t), owner = await legacy(f);
  const bytes = damage === "empty" ? "" : damage === "invalid" ? "{"
    : damage === "duplicate" ? JSON.stringify(owner).replace('"pid":2147483647', '"pid":2147483647,"pid":2147483647')
    : JSON.stringify({ ...owner, ...(damage === "extra" ? { extra: true } : damage === "pid-string" ? { pid: "2147483647" } : { schemaVersion: "future" }) });
  await fs.writeFile(f.lock, bytes); await fs.utimes(f.lock, new Date(0), new Date(0));
  await assert.rejects(f.store.removeStaleInboxLock(), { code: "INBOX_LOCK_UNAVAILABLE" });
  assert.equal(await fs.readFile(f.lock, "utf8"), bytes);
});

test("symlinks, group-writable locks, unknown hardlinks and unsafe session directories fail closed", async t => {
  const f = await fixture(t), foreign = path.join(f.root, "foreign"); await fs.writeFile(foreign, "foreign\n");
  await fs.symlink(foreign, f.lock); await assert.rejects(f.store.acquireInboxLock(), { code: "INBOX_LOCK_UNAVAILABLE" });
  assert.equal(await fs.readFile(foreign, "utf8"), "foreign\n"); await fs.unlink(f.lock); await legacy(f);
  if (process.platform !== "win32") {
    await fs.chmod(f.lock, 0o660); await assert.rejects(f.store.acquireInboxLock(), { code: "INBOX_LOCK_UNAVAILABLE" }); await fs.chmod(f.lock, 0o600);
  }
  await fs.link(f.lock, path.join(f.root, "unknown-link"));
  const bytes = await fs.readFile(f.lock); await assert.rejects(f.store.acquireInboxLock(), { code: "INBOX_LOCK_TIMEOUT" }); assert.deepEqual(await fs.readFile(f.lock), bytes);
  if (process.platform !== "win32") {
    await fs.chmod(f.store.sessionDir, 0o770); await assert.rejects(f.store.acquireInboxLock(), { code: "INBOX_LOCK_UNAVAILABLE" });
  }
});

test("delayed dead-owner removal cannot unlink a published live successor", async t => {
  const f = await fixture(t); await legacy(f); const nativeLink = fs.link; let armed = true, successor, successorBytes;
  t.mock.method(fs, "link", async (from, to) => {
    if (from === f.lock && to.startsWith(f.lock + ".reap.") && armed) {
      armed = false; await fs.rename(f.lock, path.join(f.root, "retired-owner"));
      successor = await f.store.acquireInboxLock(); successorBytes = await fs.readFile(f.lock);
    }
    return Reflect.apply(nativeLink, fs, [from, to]);
  });
  try { assert.equal(await f.store.removeStaleInboxLock(), false); assert.deepEqual(await fs.readFile(f.lock), successorBytes); }
  finally { await successor?.(); }
});

test("two retained removal claims permit one old unlink and preserve the next owner", async t => {
  const f = await fixture(t); await legacy(f);
  const linkedA = gate(), linkedB = gate(), allowA = gate(), allowB = gate(), vacant = gate(), allowReturn = gate();
  const nativeLink = fs.link, nativeUnlink = fs.unlink; let count = 0, removals = 0, a, b, successor;
  t.mock.method(fs, "link", async (from, to) => {
    const result = await Reflect.apply(nativeLink, fs, [from, to]);
    if (from === f.lock && to.startsWith(f.lock + ".reap.")) {
      if (++count === 1) { linkedA.resolve(); await bounded(allowA.promise, "inspect first removal claim"); }
      else if (count === 2) { linkedB.resolve(); await bounded(allowB.promise, "inspect second removal claim"); }
    }
    return result;
  });
  t.mock.method(fs, "unlink", async target => {
    const result = await Reflect.apply(nativeUnlink, fs, [target]);
    if (target === f.lock && removals++ === 0) { vacant.resolve(); await bounded(allowReturn.promise, "successor publishes before remover returns"); }
    return result;
  });
  try {
    a = observed(f.store.removeStaleInboxLock()); await bounded(linkedA.promise, "first reaper linked");
    b = observed(f.store.removeStaleInboxLock()); await bounded(linkedB.promise, "second reaper linked");
    assert.equal((await fs.stat(f.lock)).nlink, 3);
    allowA.resolve(); assert.equal((await bounded(a, "first reaper retires")).value, false);
    allowB.resolve(); await bounded(vacant.promise, "one old canonical unlink");
    successor = await f.store.acquireInboxLock(); const bytes = await fs.readFile(f.lock); allowReturn.resolve();
    assert.equal((await bounded(b, "second reaper returns")).value, true);
    assert.equal(removals, 1); assert.deepEqual(await fs.readFile(f.lock), bytes);
    assert.equal(await f.store.removeStaleInboxLock(), false);
  } finally {
    allowA.resolve(); allowB.resolve(); allowReturn.resolve();
    if (a) await bounded(a, "settle reaper A"); if (b) await bounded(b, "settle reaper B"); await successor?.();
  }
});

test("old releaser cannot remove a successor and retains its original failed release promise", async t => {
  const f = await fixture(t), release = await f.store.acquireInboxLock();
  await fs.rename(f.lock, path.join(f.root, "retired-owner")); const next = await f.store.acquireInboxLock(), bytes = await fs.readFile(f.lock);
  try { await assert.rejects(release(), { code: "INBOX_LOCK_UNAVAILABLE" }); await assert.rejects(release(), { code: "INBOX_LOCK_UNAVAILABLE" }); assert.deepEqual(await fs.readFile(f.lock), bytes); }
  finally { await next(); }
});

test("protected EEXIST propagates once and releases exclusion", async t => {
  const f = await fixture(t), failure = Object.assign(Error("Protected operation failed"), { code: "EEXIST" });let calls = 0;
  await assert.rejects(f.store.withInboxLock(() => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 1); const release = await f.store.acquireInboxLock(); await release();
});

test("a publisher delayed before writing cannot overwrite an initialized successor", async t => {
  const f = await fixture(t), entered = gate(), proceed = gate(), nativeOpen = fs.open;let armed = true, first, winner;
  t.mock.method(fs, "open", async (target, ...args) => {
    const handle = await Reflect.apply(nativeOpen, fs, [target, ...args]);
    if (String(target).includes(".inbox-lock-owner.") && armed) { armed = false; entered.resolve(); await bounded(proceed.promise, "resume publisher"); }
    return handle;
  });
  try {
    first = observed(f.store.acquireInboxLock()); await bounded(entered.promise, "first publication open");
    winner = await f.store.acquireInboxLock(); const bytes = await fs.readFile(f.lock); proceed.resolve();
    assert.equal((await bounded(first, "first contender timeout")).error?.code, "INBOX_LOCK_TIMEOUT"); assert.deepEqual(await fs.readFile(f.lock), bytes);
  } finally { proceed.resolve(); if (first) await (await bounded(first, "publisher cleanup")).value?.(); await winner?.(); }
});

for (const mode of ["crash-owner", "crash-publication", "crash-linked", "crash-reap", "crash-release", "crash-unlink"]) {
  test(`fresh process recovers ${mode} with no lock residue`, { timeout: 15000 }, async t => {
    const f = await fixture(t); if (mode === "crash-reap") await legacy(f);
    const child = await actor(f, mode);
    if (["crash-owner", "crash-release", "crash-unlink"].includes(mode)) { await child.message("claimed"); child.instance.send("proceed"); }
    const ended = await bounded(child.closed, mode); assert.equal(ended.code, 71); assert.equal(ended.signal, null);
    const release = await f.store.acquireInboxLock(); await release(); assert.deepEqual(await fs.readdir(f.store.sessionDir), []);
  });
}

test("four real processes serialize forty queue writes and exact critical sections", { timeout: 30000 }, async t => {
  const f = await fixture(t), actors = await Promise.all([0, 1, 2, 3].map(worker => actor(f, "stress", worker)));
  const ended = await bounded(Promise.all(actors.map(a => a.closed)), "stress actors"); assert.ok(ended.every(x => x.code === 0), JSON.stringify(ended));
  const lines = (await fs.readFile(path.join(f.store.sessionDir, "commits.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 40); assert.equal(new Set(lines.map(x => `${x.worker}:${x.iteration}`)).size, 40);
  assert.deepEqual(await fs.readdir(f.store.sessionDir), ["commits.jsonl"]);
});
