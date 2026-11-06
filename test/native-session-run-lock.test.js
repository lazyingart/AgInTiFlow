import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import test from "node:test";
import { acquireSessionRunLock, runAgent } from "../src/agent-runner.js";
import { processIdentityForPid } from "../src/integration-durable-common.js";
import { SessionStore } from "../src/session-store.js";
import { closeSessionIndexConnections, globalSessionPaths, listSessionIndex } from "../src/session-index.js";
import { ensureProjectSessionStorage } from "../src/project.js";
import { INTEGRATION_TEXT_WORKSPACE_PROFILE_ID } from "../src/integration-retained-text-workspace.js";
import { INTEGRATION_VISION_WORKSPACE_PROFILE_ID } from "../src/integration-retained-vision-workspace.js";

function gate() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: (...args) => resolve(...args) };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

const observe = promise => promise.then(value => ({ value }), error => ({ error }));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-session-lock-"));
  const children = [];
  t.after(async () => {
    for (const { instance } of children) if (instance.exitCode === null && instance.signalCode === null) instance.kill("SIGKILL");
    await Promise.all(children.map(({ exited }) => bounded(exited, "owned child cleanup")));
    await fs.rm(root, { recursive: true, force: true });
  });
  const sessionId = "native-lease-fixture";
  const sessionDir = path.join(root, sessionId);
  await fs.mkdir(sessionDir, { mode: 0o700 });
  return { root, sessionId, sessionDir, children, lockPath: path.join(sessionDir, ".agent-run.lock"), config: { sessionsDir: root } };
}

async function deadOwner(f) {
  assert.throws(() => process.kill(2147483647, 0), { code: "ESRCH" });
  const owner = { version: 1, sessionId: f.sessionId, pid: 2147483647, token: crypto.randomUUID(), acquiredAt: new Date(Date.now() - 10000).toISOString() };
  await fs.writeFile(f.lockPath, JSON.stringify(owner), { mode: 0o600 });
  return owner;
}

test("one native session excludes another run, releases once and can be reacquired", async t => {
  const f = await fixture(t);
  const release = await acquireSessionRunLock(f.config, f.sessionId);
  try {
    await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), error => error.code === "SESSION_RUN_ACTIVE" && error.ownerPid === process.pid);
  } finally { await release(); }
  await release();
  const next = await acquireSessionRunLock(f.config, f.sessionId);
  await next();
  await assert.rejects(fs.stat(f.lockPath), { code: "ENOENT" });
});

test("a delayed stale reaper cannot delete or replace a successor's live lease", async t => {
  const f = await fixture(t); await deadOwner(f);
  const paused = gate(), proceed = gate();
  const nativeRename = fs.rename, nativeLink = fs.link;
  let armed = true, first, releaseB, releaseA;
  const stop = async () => { if (armed) { armed = false; paused.resolve(); await bounded(proceed.promise, "resume stale contender"); } };
  t.mock.method(fs, "rename", async (from, to) => {
    if (from === f.lockPath) await stop();
    return Reflect.apply(nativeRename, fs, [from, to]);
  });
  t.mock.method(fs, "link", async (from, to) => {
    if (from === f.lockPath && to.startsWith(f.lockPath + ".reap.")) await stop();
    return Reflect.apply(nativeLink, fs, [from, to]);
  });
  try {
    first = observe(acquireSessionRunLock(f.config, f.sessionId));
    await bounded(paused.promise, "first stale snapshot");
    releaseB = await bounded(acquireSessionRunLock(f.config, f.sessionId), "successor claim");
    const before = await fs.readFile(f.lockPath, "utf8");
    proceed.resolve();
    const a = await bounded(first, "stale contender result"); releaseA = a.value;
    assert.equal(a.error?.code, "SESSION_RUN_ACTIVE");
    assert.equal(await fs.readFile(f.lockPath, "utf8"), before);
  } finally {
    proceed.resolve();
    if (first) { const a = await bounded(first, "settle contender"); releaseA ||= a.value; }
    await releaseA?.(); await releaseB?.();
  }
});

test("an old malformed owner cannot be treated as proof of a dead process", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.lockPath, "not-json", { mode: 0o600 });
  const old = new Date(Date.now() - 60000); await fs.utimes(f.lockPath, old, old);
  let release;
  try {
    await assert.rejects(async () => { release = await acquireSessionRunLock(f.config, f.sessionId); }, error => error.code === "SESSION_RUN_LOCK_UNAVAILABLE");
    assert.equal(await fs.readFile(f.lockPath, "utf8"), "not-json");
  } finally { await release?.(); }
});

test("legacy quarantine protects the live reaper named on it, not the dead original owner", async t => {
  const f = await fixture(t); await deadOwner(f);
  const legacy = `${f.lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
  await fs.rename(f.lockPath, legacy); const bytes = await fs.readFile(legacy);
  await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), { code: "SESSION_RUN_LOCK_UNAVAILABLE" });
  assert.deepEqual(await fs.readFile(legacy), bytes);
  await assert.rejects(fs.stat(f.lockPath), { code: "ENOENT" });
});

test("legacy quarantine is cleaned only after its named reaper is proven dead", async t => {
  const f = await fixture(t); await deadOwner(f);
  const legacy = `${f.lockPath}.stale.2147483647.${crypto.randomUUID()}`;
  await fs.rename(f.lockPath, legacy);
  const release = await acquireSessionRunLock(f.config, f.sessionId);
  try { await assert.rejects(fs.stat(legacy), { code: "ENOENT" }); }
  finally { await release(); }
});

test("session index and store create private directories under a group-writable umask", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), previousHome = process.env.AGINTIFLOW_HOME, previousMask = process.umask();
  const home = path.join(f.root, "new-home");
  try {
    process.env.AGINTIFLOW_HOME = home; process.umask(0o002);
    listSessionIndex();
    const { sessionsDir } = globalSessionPaths();
    const store = new SessionStore(sessionsDir, "web-created-session"); await store.ensure();
    assert.equal((await fs.stat(sessionsDir)).mode & 0o7777, 0o700);
    assert.equal((await fs.stat(store.sessionDir)).mode & 0o7777, 0o700);
    const release = await acquireSessionRunLock({ sessionsDir }, "web-created-session"); await release();
    await fs.chmod(store.sessionDir, 0o770);
    await assert.rejects(acquireSessionRunLock({ sessionsDir }, "web-created-session"), { code: "SESSION_RUN_LOCK_UNAVAILABLE" });
    assert.equal((await fs.stat(store.sessionDir)).mode & 0o7777, 0o770, "Existing unsafe permissions must not be changed automatically");
    process.env.AGINTIFLOW_HOME = path.join(f.root, "project-created-home");
    const paths = await ensureProjectSessionStorage(path.join(f.root, "project"));
    assert.equal((await fs.stat(paths.globalSessionsDir)).mode & 0o7777, 0o700);
  } finally {
    closeSessionIndexConnections(); process.umask(previousMask);
    if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = previousHome;
  }
});

test("unregistered integration invocation rejects before creating the native lease directory", async t => {
  const f = await fixture(t);
  const sessionsDir = path.join(f.root, "never-created");
  await assert.rejects(runAgent({ sessionsDir, sessionId: "unregistered-integration", integrationPolicyLock: "unregistered" }), error => error.code === "INTEGRATION_SESSION_SCOPE_INVALID");
  await assert.rejects(fs.stat(sessionsDir), { code: "ENOENT" });
});

test("invalid or aliased session IDs reject before any storage creation", async t => {
  const f = await fixture(t);
  const sessionsDir = path.join(f.root, "never-created");
  for (const sessionId of [".", "..", "../escape", "a/b", "a\\b", "a..b", "", null, 9, "x".repeat(256)]) {
    await assert.rejects(acquireSessionRunLock({ sessionsDir }, sessionId), error => error.code === "SESSION_RUN_LOCK_INVALID");
  }
  await assert.rejects(fs.stat(sessionsDir), { code: "ENOENT" });
});

test("self-claimed retained profiles cannot bypass the registered session authority", async t => {
  const f = await fixture(t);
  const sessionsDir = path.join(f.root, "never-created");
  for (const integrationSessionProfile of [INTEGRATION_TEXT_WORKSPACE_PROFILE_ID, INTEGRATION_VISION_WORKSPACE_PROFILE_ID]) {
    const config = Object.freeze({ sessionsDir, sessionId: "profile-only", integrationSessionProfile });
    await assert.rejects(acquireSessionRunLock(config, config.sessionId), { code: "INTEGRATION_SESSION_SCOPE_INVALID" });
    await assert.rejects(runAgent(config), { code: "INTEGRATION_SESSION_SCOPE_INVALID" });
  }
  await assert.rejects(fs.stat(sessionsDir), { code: "ENOENT" });
});

test("a live native lease is preserved regardless of age", async t => {
  const f = await fixture(t);
  const owner = { version: 2, sessionId: f.sessionId, pid: process.pid, token: crypto.randomUUID(), processIdentity: await processIdentityForPid(), acquiredAt: "2001-01-01T00:00:00.000Z" };
  const bytes = JSON.stringify(owner); await fs.writeFile(f.lockPath, bytes, { mode: 0o600 });
  await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), error => error.code === "SESSION_RUN_ACTIVE");
  assert.equal(await fs.readFile(f.lockPath, "utf8"), bytes);
});

test("unavailable process-birth evidence preserves an occupied PID and its bytes", async t => {
  const f = await fixture(t);
  const owner = { version: 2, sessionId: f.sessionId, pid: process.pid, token: crypto.randomUUID(), processIdentity: await processIdentityForPid(), acquiredAt: new Date().toISOString() };
  const bytes = JSON.stringify(owner); await fs.writeFile(f.lockPath, bytes, { mode: 0o600 });
  const nativeRead = fs.readFile;
  t.mock.method(fs, "readFile", (name, ...args) => {
    if (name === "/proc/sys/kernel/random/boot_id") return Promise.reject(Object.assign(new Error("Fixture denies identity"), { code: "EACCES" }));
    return Reflect.apply(nativeRead, fs, [name, ...args]);
  });
  await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), error => error.code === "SESSION_RUN_ACTIVE");
  assert.equal(await nativeRead(f.lockPath, "utf8"), bytes);
});

test("a reused PID with a different proven birth can recover the old published lease", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t);
  const identity = await processIdentityForPid();
  const owner = { version: 2, sessionId: f.sessionId, pid: process.pid, token: crypto.randomUUID(), processIdentity: { ...identity, startTimeTicks: identity.startTimeTicks + "0" }, acquiredAt: new Date().toISOString() };
  const candidate = path.join(f.sessionDir, `.agent-run.owner-v2.${owner.pid}.${owner.token}.json`);
  await fs.writeFile(candidate, JSON.stringify(owner), { mode: 0o600 }); await fs.link(candidate, f.lockPath);
  const release = await acquireSessionRunLock(f.config, f.sessionId);
  try {
    const current = JSON.parse(await fs.readFile(f.lockPath, "utf8"));
    assert.notEqual(current.token, owner.token); assert.deepEqual(current.processIdentity, identity);
    await assert.rejects(fs.stat(candidate), { code: "ENOENT" });
  } finally { await release(); }
});

test("incomplete legacy metadata and future/ambiguous owner encodings fail closed", async t => {
  const f = await fixture(t);
  const owner = await deadOwner(f);
  for (const bytes of ["", JSON.stringify({ ...owner, version: 99 }), JSON.stringify({ ...owner, extra: true }), JSON.stringify({ ...owner, pid: "2147483647" }), JSON.stringify(owner).replace('"version":1', '"version":1,"version":1')]) {
    await fs.writeFile(f.lockPath, bytes);
    await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), error => error.code === "SESSION_RUN_LOCK_UNAVAILABLE");
    assert.equal(await fs.readFile(f.lockPath, "utf8"), bytes);
  }
});

test("symlink and wrong-mode lock files are not followed or repaired", async t => {
  const f = await fixture(t);
  const foreign = path.join(f.root, "foreign.json"); await fs.writeFile(foreign, "foreign bytes", { mode: 0o600 });
  await fs.symlink(foreign, f.lockPath);
  await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), error => error.code === "SESSION_RUN_LOCK_UNAVAILABLE");
  assert.equal(await fs.readFile(foreign, "utf8"), "foreign bytes");
  await fs.unlink(f.lockPath); await deadOwner(f); await fs.chmod(f.lockPath, 0o644);
  await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), error => error.code === "SESSION_RUN_LOCK_UNAVAILABLE");
  assert.equal((await fs.stat(f.lockPath)).mode & 0o777, 0o644);
});

test("an unknown hard link cannot authorize stale removal", async t => {
  const f = await fixture(t); await deadOwner(f);
  const bytes = await fs.readFile(f.lockPath, "utf8");
  const foreign = path.join(f.root, "retained-link"); await fs.link(f.lockPath, foreign);
  await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), error => error.code === "SESSION_RUN_LOCK_UNAVAILABLE");
  assert.equal(await fs.readFile(f.lockPath, "utf8"), bytes);
  assert.equal(await fs.readFile(foreign, "utf8"), bytes);
  assert.deepEqual(await fs.readdir(f.sessionDir), [".agent-run.lock"]);
});

test("storage-root aliases share a lease while a symlinked session directory rejects", async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, "alias"); await fs.symlink(f.root, alias);
  const release = await acquireSessionRunLock(f.config, f.sessionId);
  try { await assert.rejects(acquireSessionRunLock({ sessionsDir: alias }, f.sessionId), error => error.code === "SESSION_RUN_ACTIVE"); }
  finally { await release(); }
  const foreign = path.join(f.root, "foreign"); await fs.mkdir(foreign);
  await fs.symlink(foreign, path.join(f.root, "linked-session"));
  await assert.rejects(acquireSessionRunLock(f.config, "linked-session"), error => error.code === "SESSION_RUN_LOCK_UNAVAILABLE");
  assert.deepEqual(await fs.readdir(foreign), []);
});

test("release returns one promise and never touches a replacement after failure", async t => {
  const f = await fixture(t);
  const release = await acquireSessionRunLock(f.config, f.sessionId);
  await fs.rename(f.lockPath, path.join(f.sessionDir, "retired-owner.json"));
  const owner = { version: 1, sessionId: f.sessionId, pid: process.pid, token: crypto.randomUUID(), acquiredAt: new Date().toISOString() };
  const bytes = JSON.stringify(owner); await fs.writeFile(f.lockPath, bytes, { mode: 0o600 });
  const first = release(), second = release(); assert.equal(first, second);
  await assert.rejects(first, error => error.code === "SESSION_RUN_LOCK_UNAVAILABLE");
  assert.equal(release(), first);
  assert.equal(await fs.readFile(f.lockPath, "utf8"), bytes);
});

test("a publisher paused before its first write cannot overwrite a later complete claim", async t => {
  const f = await fixture(t);
  const entered = gate(), proceed = gate();
  const nativeOpen = fs.open;
  let armed = true, first, releaseA, releaseB;
  t.mock.method(fs, "open", async (name, ...args) => {
    const handle = await Reflect.apply(nativeOpen, fs, [name, ...args]);
    if (String(name).includes(".agent-run.owner-v2.") && armed) {
      armed = false; entered.resolve(); await bounded(proceed.promise, "finish first publisher");
    }
    return handle;
  });
  try {
    first = observe(acquireSessionRunLock(f.config, f.sessionId));
    await bounded(entered.promise, "first empty publication");
    releaseB = await bounded(acquireSessionRunLock(f.config, f.sessionId), "second publication");
    const bytes = await fs.readFile(f.lockPath, "utf8"); proceed.resolve();
    const result = await bounded(first, "first publisher loses"); releaseA = result.value;
    assert.equal(result.error?.code, "SESSION_RUN_ACTIVE");
    assert.equal(await fs.readFile(f.lockPath, "utf8"), bytes);
  } finally {
    proceed.resolve();
    if (first) releaseA ||= (await bounded(first, "settle publisher")).value;
    await releaseA?.(); await releaseB?.();
  }
});

async function child(t, f, mode, worker) {
  const instance = fork(new URL("./fixtures/native-session-lock-child.js", import.meta.url), [f.root, f.sessionId, mode, String(worker || 0)], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = [], waiters = [];
  let diagnostics = "";
  instance.stderr.on("data", bytes => { diagnostics += bytes.toString(); });
  instance.stdout.resume();
  instance.on("message", message => { messages.push(message); for (const done of waiters.splice(0)) done(); });
  const exited = new Promise(resolve => instance.once("close", (code, signal) => { for (const done of waiters.splice(0)) done(); resolve({ code, signal }); }));
  f.children.push({ instance, exited });
  return {
    instance, exited,
    async message(type) {
      while (!messages.some(m => m.type === type)) {
        if (instance.exitCode !== null || instance.signalCode !== null) throw new Error(`Fixture exited before ${type}: ${diagnostics}`);
        await bounded(new Promise(resolve => waiters.push(resolve)), `child ${type}`);
      }
      return messages.find(m => m.type === type);
    },
  };
}

for (const [mode, exitCode] of [["crash", 71], ["crash-before-publish", 72], ["crash-after-publish", 73], ["crash-reap-claim", 74], ["crash-release-claim", 75], ["crash-after-remove", 76]]) {
  test(`process restart recovers the ${mode} boundary`, { timeout: 10000 }, async t => {
    const f = await fixture(t);
    if (mode === "crash-reap-claim") await deadOwner(f);
    const actor = await child(t, f, mode);
    if (["crash", "crash-release-claim", "crash-after-remove"].includes(mode)) {
      await actor.message("claimed"); actor.instance.send(mode === "crash" ? "crash" : "release");
    }
    assert.equal((await bounded(actor.exited, "crash boundary exits")).code, exitCode);
    const release = await acquireSessionRunLock(f.config, f.sessionId); await release();
    assert.deepEqual(await fs.readdir(f.sessionDir), []);
  });
}

test("four independent processes serialize forty-eight critical sections", { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const actors = await Promise.all([0, 1, 2, 3].map(worker => child(t, f, "stress", worker)));
  const results = await Promise.all(actors.map(actor => actor.exited));
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
  const commits = (await fs.readFile(path.join(f.sessionDir, "commits.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(commits.length, 48);
  assert.equal(new Set(commits.map(row => `${row.worker}:${row.iteration}`)).size, 48);
  assert.deepEqual(await fs.readdir(f.sessionDir), ["commits.jsonl"]);
});

test("native run rejects an occupied child-owned session before state or tool activity", async t => {
  const f = await fixture(t), actor = await child(t, f, "hold");
  const owner = await actor.message("claimed");
  await assert.rejects(runAgent({ ...f.config, sessionId: f.sessionId, provider: "mock", goal: "Read the note and write a short summary." }), error => error.code === "SESSION_RUN_ACTIVE" && error.ownerPid === owner.pid);
  assert.deepEqual(await fs.readdir(f.sessionDir), [".agent-run.lock"]);
  actor.instance.send("release"); assert.equal((await bounded(actor.exited, "finish child")).code, 0);
});

test("two completed removal links cannot both authorize canonical unlink", async t => {
  const f = await fixture(t); await deadOwner(f);
  const stale = await fs.stat(f.lockPath);
  const aLinked = gate(), bLinked = gate(), finishA = gate(), finishB = gate(), aRemoved = gate(), canonicalVacant = gate(), aPublished = gate();
  const actor = new AsyncLocalStorage();
  const nativeLink = fs.link, nativeUnlink = fs.unlink;
  let attempts = 0, canonicalRemovals = 0, aPath, first, second, releaseA, releaseB;
  t.mock.method(fs, "link", async (from, to) => {
    let n;
    if (from === f.lockPath && to.startsWith(f.lockPath + ".reap.")) {
      n = ++attempts;
      if (n >= 3) await bounded(canonicalVacant.promise, "old canonical removal before later claims");
    }
    const result = await Reflect.apply(nativeLink, fs, [from, to]);
    if (n === 1) { aPath = to; aLinked.resolve(); await bounded(finishA.promise, "inspect A claim"); }
    if (n === 2) { bLinked.resolve(); await bounded(finishB.promise, "inspect B claim"); }
    if (to === f.lockPath && actor.getStore() === "A") aPublished.resolve();
    return result;
  });
  t.mock.method(fs, "unlink", async name => {
    const result = await Reflect.apply(nativeUnlink, fs, [name]);
    if (name === aPath) aRemoved.resolve();
    if (name === f.lockPath && actor.getStore() === "B") {
      canonicalRemovals++; canonicalVacant.resolve();
      // Removing a dead canonical name is not a reservation for its remover.
      // Force the other contender to publish before B resumes acquisition.
      await bounded(aPublished.promise, "A publishes while B is after unlink");
    }
    return result;
  });
  try {
    first = observe(actor.run("A", () => acquireSessionRunLock(f.config, f.sessionId)));
    await bounded(aLinked.promise, "A removal link");
    second = observe(actor.run("B", () => acquireSessionRunLock(f.config, f.sessionId)));
    await bounded(bLinked.promise, "B removal link");
    assert.equal((await fs.stat(f.lockPath)).nlink, 3);
    finishA.resolve(); await bounded(aRemoved.promise, "A drops nonexclusive claim");
    finishB.resolve();
    const [a, b] = await bounded(Promise.all([first, second]), "one contender wins and the other observes it");
    releaseA = a.value; releaseB = b.value;
    assert.equal([a, b].filter(result => typeof result.value === "function").length, 1);
    assert.deepEqual([a, b].filter(result => result.error).map(result => result.error.code), ["SESSION_RUN_ACTIVE"]);
    assert.equal(typeof releaseA, "function", "the forced after-unlink schedule lets A publish first");
    assert.equal(canonicalRemovals, 1, "two removal links authorize only one old canonical unlink");
    const current = await fs.stat(f.lockPath), bytes = await fs.readFile(f.lockPath, "utf8");
    assert.notEqual(current.ino, stale.ino); assert.equal(current.nlink, 1);
    await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), { code: "SESSION_RUN_ACTIVE" });
    assert.equal(await fs.readFile(f.lockPath, "utf8"), bytes, "the winning lease stays unchanged");
  } finally {
    finishA.resolve(); finishB.resolve(); canonicalVacant.resolve(); aPublished.resolve();
    if (first) releaseA ||= (await bounded(first, "settle A")).value;
    if (second) releaseB ||= (await bounded(second, "settle B")).value;
    await releaseA?.(); await releaseB?.();
  }
});

test("an owner changed in place after the stale snapshot is preserved", async t => {
  const f = await fixture(t); await deadOwner(f);
  const nativeLink = fs.link;
  const owner = { version: 1, sessionId: f.sessionId, pid: process.pid, token: crypto.randomUUID(), acquiredAt: new Date().toISOString() };
  const bytes = JSON.stringify(owner);
  let armed = true;
  t.mock.method(fs, "link", async (from, to) => {
    if (from === f.lockPath && to.startsWith(f.lockPath + ".reap.") && armed) {
      armed = false; await fs.writeFile(f.lockPath, bytes);
      const changed = new Date(Date.now() + 2000); await fs.utimes(f.lockPath, changed, changed);
    }
    return Reflect.apply(nativeLink, fs, [from, to]);
  });
  await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), error => error.code === "SESSION_RUN_ACTIVE");
  assert.equal(await fs.readFile(f.lockPath, "utf8"), bytes);
});

test("failing first publication open cannot remove an existing candidate", async t => {
  const f = await fixture(t);
  const nativeOpen = fs.open;
  let collided;
  t.mock.method(fs, "open", async (name, ...args) => {
    if (String(name).includes(".agent-run.owner-v2.") && !collided) {
      collided = name;
      const handle = await Reflect.apply(nativeOpen, fs, [name, ...args]);
      await handle.writeFile("existing publication"); await handle.close();
      throw Object.assign(new Error("Fixture open collision"), { code: "EEXIST" });
    }
    return Reflect.apply(nativeOpen, fs, [name, ...args]);
  });
  await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), { code: "EEXIST" });
  assert.equal(await fs.readFile(collided, "utf8"), "existing publication");
  await assert.rejects(fs.stat(f.lockPath), { code: "ENOENT" });
});

test("publication fsync failure leaves no admitted lease or candidate", async t => {
  const f = await fixture(t);
  const nativeOpen = fs.open;
  t.mock.method(fs, "open", async (name, ...args) => {
    const handle = await Reflect.apply(nativeOpen, fs, [name, ...args]);
    if (String(name).includes(".agent-run.owner-v2.")) {
      t.mock.method(handle, "sync", async () => { throw Object.assign(new Error("Fixture fsync failure"), { code: "EIO" }); });
    }
    return handle;
  });
  await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), { code: "EIO" });
  assert.deepEqual(await fs.readdir(f.sessionDir), []);
});

test("retained lease descriptors close after repeated successful release", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t);
  const count = async () => (await fs.readdir("/proc/self/fd")).length;
  const before = await count();
  for (let i = 0; i < 16; i++) {
    const release = await acquireSessionRunLock(f.config, f.sessionId);
    assert.equal(await count(), before + 1);
    const first = release(); assert.equal(release(), first); await first;
    assert.equal(release(), first);
  }
  assert.equal(await count(), before);
  assert.deepEqual(await fs.readdir(f.sessionDir), []);
});

test("unrelated sessions stay independent while one lease is held", async t => {
  const f = await fixture(t);
  const first = await acquireSessionRunLock(f.config, f.sessionId);
  try {
    const second = await acquireSessionRunLock(f.config, "independent-session");
    await second();
    await assert.rejects(acquireSessionRunLock(f.config, f.sessionId), error => error.code === "SESSION_RUN_ACTIVE");
  } finally { await first(); }
});
