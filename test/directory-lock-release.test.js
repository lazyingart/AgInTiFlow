import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { withDirectoryLock } from "../src/integration-durable-common.js";

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function observe(promise) {
  return promise.then(value => ({ value }), error => ({ error }));
}

async function cleanupRace(t, scanner) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-release-"));
  const lock = path.join(root, "transaction.lock");
  const renamed = gate();
  const releaseFirst = gate();
  const recoveryRemoving = gate();
  const releaseRecovery = gate();
  const ownerRemoved = gate();
  const finishRemoval = gate();
  const successorEntered = gate();
  const finishSuccessor = gate();
  const nativeRead = fs.readdir.bind(fs);
  const nativeRemove = fs.rm.bind(fs);
  let quarantine;
  let armed = false;
  let snapshots = 0;
  let interceptedRemoval = false;
  let first;
  let successor;
  let firstCalls = 0;
  let successorCalls = 0;
  t.mock.method(fs, "rm", async (target, options) => {
    if (target === quarantine && !interceptedRemoval) {
      interceptedRemoval = true;
      await fs.unlink(path.join(quarantine, "owner.json"));
      ownerRemoved.resolve();
      await bounded(finishRemoval.promise, "finish partial removal");
    }
    return nativeRemove(target, options);
  });
  t.mock.method(fs, "readdir", async (target, ...args) => {
    if (armed && target === quarantine && ++snapshots === 2) {
      armed = false;
      if (scanner === "releaser") releaseRecovery.resolve();
      else releaseFirst.resolve();
      await bounded(ownerRemoved.promise, "owner removed between inventory snapshots");
      const partial = await nativeRead(target, ...args);
      assert.deepEqual(partial, []);
      finishRemoval.resolve();
      if (scanner === "releaser") await bounded(successorEntered.promise, "successor enters");
      else assert.equal((await bounded(first, "first releaser finishes")).error, undefined);
      return partial;
    }
    return nativeRead(target, ...args);
  });
  try {
    first = observe(withDirectoryLock(lock, async () => {
      firstCalls += 1;
      return "first committed result";
    }, { testHooks: {
      async afterReleaseQuarantineRename(info) {
        quarantine = info.quarantine;
        renamed.resolve();
        await bounded(releaseFirst.promise, "release first scanner");
      },
    } }));
    await bounded(renamed.promise, "first quarantine renamed");
    armed = scanner === "successor";
    successor = observe(withDirectoryLock(lock, async () => {
      successorCalls += 1;
      successorEntered.resolve();
      await bounded(finishSuccessor.promise, "finish successor");
      return "successor committed result";
    }, { testHooks: {
      async beforeAbandonedQuarantineRemove({ quarantinePath }) {
        if (scanner !== "releaser" || quarantinePath !== quarantine) return;
        recoveryRemoving.resolve();
        await bounded(releaseRecovery.promise, "release recovery remover");
      },
    } }));
    if (scanner === "releaser") {
      await bounded(recoveryRemoving.promise, "recovery has validated retired quarantine");
      armed = true;
      releaseFirst.resolve();
    }
    await bounded(Promise.race([successorEntered.promise, successor.then(result => {
      if (result.error) throw result.error;
    })]), "successor entered after cleanup race");
    const ownerBefore = await fs.readFile(path.join(lock, "owner.json"), "utf8");
    assert.deepEqual(await bounded(first, "first result"), { value: "first committed result" });
    assert.equal(await fs.readFile(path.join(lock, "owner.json"), "utf8"), ownerBefore,
      "retired cleanup must not touch the successor's owner");
    finishSuccessor.resolve();
    assert.deepEqual(await bounded(successor, "successor result"), { value: "successor committed result" });
    assert.equal(interceptedRemoval, true);
    assert.equal(firstCalls, 1);
    assert.equal(successorCalls, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    releaseFirst.resolve();
    releaseRecovery.resolve();
    finishRemoval.resolve();
    finishSuccessor.resolve();
    await Promise.all([first, successor].filter(Boolean));
    await nativeRemove(root, { recursive: true, force: true });
  }
}

test("a releaser survives successor removal between quarantine snapshots", { timeout: 10_000 }, t => cleanupRace(t, "releaser"));
test("a successor survives releaser removal between quarantine snapshots", { timeout: 10_000 }, t => cleanupRace(t, "successor"));

test("an opened owner unlinked before fstat is a cleanup race, not a new owner", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-unlinked-owner-"));
  const nativeOpen = fs.open.bind(fs);
  let quarantine;
  let unlinked = false;
  let calls = 0;
  t.mock.method(fs, "open", async (target, ...args) => {
    const handle = await nativeOpen(target, ...args);
    if (quarantine && target === path.join(quarantine, "owner.json") && !unlinked) {
      unlinked = true;
      try { await fs.unlink(target); } catch (error) { await handle.close(); throw error; }
    }
    return handle;
  });
  try {
    assert.equal(await withDirectoryLock(path.join(root, "transaction.lock"), async () => {
      calls += 1;
      return "committed";
    }, { testHooks: { afterReleaseQuarantineRename(info) { quarantine = info.quarantine; } } }), "committed");
    assert.equal(unlinked, true);
    assert.equal(calls, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("successor accepts exact quarantine absence at its final binding recheck", { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-final-check-"));
  const lock = path.join(root, "transaction.lock");
  const renamed = gate();
  const resume = gate();
  const nativeStat = fs.lstat.bind(fs);
  let quarantine;
  let checks = 0;
  let raced = false;
  let first;
  let successorCalls = 0;
  t.mock.method(fs, "lstat", async (target, ...args) => {
    if (target === quarantine && !raced && ++checks === 4) {
      raced = true;
      resume.resolve();
      assert.equal((await bounded(first, "first cleanup before successor final check")).error, undefined);
    }
    return nativeStat(target, ...args);
  });
  try {
    first = observe(withDirectoryLock(lock, async () => "first", { testHooks: {
      async afterReleaseQuarantineRename(info) {
        quarantine = info.quarantine;
        renamed.resolve();
        await bounded(resume.promise, "resume first cleanup");
      },
    } }));
    await bounded(renamed.promise, "first rename");
    assert.equal(await withDirectoryLock(lock, async () => { successorCalls += 1; return "successor"; }), "successor");
    assert.equal(raced, true);
    assert.equal(successorCalls, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    resume.resolve();
    if (first) await first;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a replaced quarantine inode fails closed without removing its replacement", { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-replace-"));
  const lock = path.join(root, "transaction.lock");
  const nativeRead = fs.readdir.bind(fs);
  let quarantine;
  let reads = 0;
  let replacementBytes;
  let calls = 0;
  t.mock.method(fs, "readdir", async (target, ...args) => {
    if (target === quarantine && ++reads === 2) {
      await fs.rename(quarantine, `${quarantine}.test-old`);
      await fs.mkdir(quarantine, { mode: 0o700 });
      replacementBytes = await fs.readFile(path.join(`${quarantine}.test-old`, "owner.json"));
      await fs.writeFile(path.join(quarantine, "owner.json"), replacementBytes, { mode: 0o600 });
    }
    return nativeRead(target, ...args);
  });
  try {
    await assert.rejects(withDirectoryLock(lock, async () => { calls += 1; }, { testHooks: {
      afterReleaseQuarantineRename(info) { quarantine = info.quarantine; },
    } }), { code: "INTEGRATION_AUTHORITY_LOCK_CORRUPT" });
    assert.equal(calls, 1);
    assert.deepEqual(await fs.readFile(path.join(quarantine, "owner.json")), replacementBytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("quarantine I/O failure is not hidden or retried as a semantic operation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-io-"));
  const nativeRead = fs.readdir.bind(fs);
  let quarantine;
  let calls = 0;
  const failure = Object.assign(new Error("synthetic quarantine read EIO"), { code: "EIO" });
  t.mock.method(fs, "readdir", async (target, ...args) => {
    if (target === quarantine) throw failure;
    return nativeRead(target, ...args);
  });
  try {
    await assert.rejects(withDirectoryLock(path.join(root, "transaction.lock"), async () => { calls += 1; }, {
      testHooks: { afterReleaseQuarantineRename(info) { quarantine = info.quarantine; } },
    }), error => error === failure);
    assert.equal(calls, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("continuously unstable metadata remains a bounded busy failure", { timeout: 5_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-busy-"));
  const nativeRead = fs.readdir.bind(fs);
  let quarantine;
  let reads = 0;
  let calls = 0;
  t.mock.method(fs, "readdir", async (target, ...args) => {
    const names = await nativeRead(target, ...args);
    return target === quarantine && ++reads % 2 === 0 ? [] : names;
  });
  try {
    await assert.rejects(withDirectoryLock(path.join(root, "transaction.lock"), async () => { calls += 1; }, {
      testHooks: { afterReleaseQuarantineRename(info) { quarantine = info.quarantine; } },
    }), { code: "INTEGRATION_AUTHORITY_BUSY" });
    assert.equal(calls, 1);
    assert.ok(reads >= 2 && reads <= 64, "unstable observation must have a finite inspection bound");
    assert.ok((await fs.readdir(root)).length > 0, "unstable quarantine must remain available for recovery");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a changed retired owner token is corruption, not benign cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-token-"));
  let quarantine;
  let calls = 0;
  try {
    await assert.rejects(withDirectoryLock(path.join(root, "transaction.lock"), async () => { calls += 1; }, {
      testHooks: { async afterReleaseQuarantineRename(info) {
        quarantine = info.quarantine;
        const ownerPath = path.join(quarantine, "owner.json");
        const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
        owner.token = "0".repeat(32);
        await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`);
      } },
    }), { code: "INTEGRATION_AUTHORITY_LOCK_CORRUPT" });
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(quarantine, "owner.json"), "utf8")).token, "0".repeat(32));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("non-object owner JSON is never treated as an absent owner", async () => {
  for (const owner of [null, false, 0, "", "owner", []]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-owner-shape-"));
    let quarantine;
    try {
      await assert.rejects(withDirectoryLock(path.join(root, "transaction.lock"), async () => {}, {
        testHooks: { async afterReleaseQuarantineRename(info) {
          quarantine = info.quarantine;
          await fs.writeFile(path.join(quarantine, "owner.json"), `${JSON.stringify(owner)}\n`);
        } },
      }), { code: "INTEGRATION_AUTHORITY_LOCK_CORRUPT" }, JSON.stringify(owner));
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(quarantine, "owner.json"), "utf8")), owner);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("a retired quarantine symlink is rejected and left untouched", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-symlink-"));
  let quarantine;
  try {
    await assert.rejects(withDirectoryLock(path.join(root, "transaction.lock"), async () => {}, {
      testHooks: { async afterReleaseQuarantineRename(info) {
        quarantine = info.quarantine;
        await fs.rename(quarantine, `${quarantine}.test-original`);
        await fs.symlink(`${quarantine}.test-original`, quarantine);
      } },
    }), { code: "INTEGRATION_AUTHORITY_LOCK_CORRUPT" });
    assert.equal((await fs.lstat(quarantine)).isSymbolicLink(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent callers preserve exact results, exclusion and cleanup", { timeout: 15_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-contention-"));
  let active = 0;
  let maximum = 0;
  let calls = 0;
  try {
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => withDirectoryLock(
      path.join(root, "transaction.lock"), async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        calls += 1;
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        return index;
      }, { waitMs: 10_000 }
    )));
    assert.deepEqual(results, Array.from({ length: 24 }, (_, index) => index));
    assert.equal(calls, 24);
    assert.equal(maximum, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("canonical absence is not proof that a successor's lock may be reaped", { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-lock-absent-observation-"));
  const lock = path.join(root, "transaction.lock"), actor = new AsyncLocalStorage();
  const entered = gate(), releaseFirst = gate(), absent = gate(), successorEntered = gate();
  const finishSuccessor = gate(), observerSawSuccessor = gate();
  const nativeStat = fs.lstat.bind(fs);
  let first, successor, observer, observations = 0, observerCalls = 0;
  t.mock.method(fs, "lstat", async (target, ...args) => {
    if (target === lock && actor.getStore() === "observer") {
      observations++;
      if (observations === 4) {
        // The contender captured the first owner's identity, lost its claim,
        // then entered the stale check. Retire that live owner, capture true
        // ENOENT, and delay delivery until a distinct live successor exists.
        releaseFirst.resolve();
        assert.deepEqual(await bounded(first, "first owner retires"), { value: "first" });
        let missing;
        try { await nativeStat(target, ...args); }
        catch (error) { missing = error; }
        assert.equal(missing?.code, "ENOENT"); absent.resolve();
        await bounded(successorEntered.promise, "successor publishes live owner");
        throw missing;
      }
      const stat = await nativeStat(target, ...args);
      if (observations >= 5) observerSawSuccessor.resolve();
      return stat;
    }
    return nativeStat(target, ...args);
  });
  try {
    first = observe(withDirectoryLock(lock, async () => {
      entered.resolve(); await bounded(releaseFirst.promise, "release original owner"); return "first";
    }));
    await bounded(entered.promise, "original owner enters");
    observer = observe(actor.run("observer", () => withDirectoryLock(lock, async () => {
      observerCalls++; return "observer";
    }, { waitMs: 3000 })));
    await bounded(absent.promise, "contender captured canonical absence");
    successor = observe(withDirectoryLock(lock, async () => {
      successorEntered.resolve(); await bounded(finishSuccessor.promise, "finish live successor"); return "successor";
    }));
    await bounded(successorEntered.promise, "successor enters");
    const ownerBefore = await fs.readFile(path.join(lock, "owner.json"));
    const observed = await bounded(Promise.race([
      observerSawSuccessor.promise.then(() => true),
      observer.then(result => { if (result.error) throw result.error; return false; }),
    ]), "contender retries without moving live successor");
    assert.equal(observed, true); assert.equal(observerCalls, 0);
    assert.deepEqual(await fs.readFile(path.join(lock, "owner.json")), ownerBefore);
    assert.deepEqual(await fs.readdir(root), ["transaction.lock"]);
    finishSuccessor.resolve();
    assert.deepEqual(await bounded(successor, "successor result"), { value: "successor" });
    assert.deepEqual(await bounded(observer, "observer eventually acquires"), { value: "observer" });
    assert.equal(observerCalls, 1); assert.ok(observations >= 5);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    releaseFirst.resolve(); finishSuccessor.resolve();
    await Promise.allSettled([first, successor, observer].filter(Boolean));
    await fs.rm(root, { recursive: true, force: true });
  }
});
