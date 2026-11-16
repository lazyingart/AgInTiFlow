import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME;
const { SessionStore } = await import(runtime ? pathToFileURL(path.join(runtime, "src/session-store.js")) : new URL("../src/session-store.js", import.meta.url));
const { closeSessionIndexConnections } = await import(runtime ? pathToFileURL(path.join(runtime, "src/session-index.js")) : new URL("../src/session-index.js", import.meta.url));
function gate() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Queue continuity timeout: ${label}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
test("a slow live queue edit preserves a concurrent ordinary user correction", { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-inbox-continuity-"));
  const previousHome = process.env.AGINTIFLOW_HOME;
  process.env.AGINTIFLOW_HOME = path.join(root, "home");
  const store = new SessionStore(path.join(root, "sessions"), "queue-continuity");
  const producer = new SessionStore(path.join(root, "sessions"), "queue-continuity");
  const correction = "Actually keep the note read-only; just explain the result here.";
  const entered = gate(), proceed = gate(), attempted = gate(), nativeNow = Date.now, nativeStat = fs.lstat;
  let editing, sending, observeContender = false;
  t.mock.method(fs, "lstat", async (target, ...args) => {
    const result = await Reflect.apply(nativeStat, fs, [target, ...args]);
    if (target === store.inboxLockPath && observeContender) attempted.resolve();
    return result;
  });
  try {
    await store.appendInbox("Read note.txt and save a short summary.", { id: "original", source: "user" });
    editing = store.mutateInbox(async items => { entered.resolve(); await bounded(proceed.promise, "finish admitted edit"); return items; }); editing.catch(() => {});
    await bounded(entered.promise, "editor owns queue snapshot");
    // Advance the observation clock, not lock bytes or a production timeout.
    Date.now = () => nativeNow() + 180_000;
    assert.equal(await producer.removeStaleInboxLock(), false, "the slow live editor still owns the exact queue snapshot");
    observeContender = true;
    sending = producer.appendInbox(correction, { id: "correction", source: "user", priority: "asap" }); sending.catch(() => {});
    await bounded(attempted.promise, "concurrent writer sees occupied queue");
    proceed.resolve(); await bounded(editing, "editor checkpoint"); await bounded(sending, "queued correction");
    const fresh = new SessionStore(path.join(root, "sessions"), "queue-continuity"), queued = await fresh.loadInbox();
    assert.deepEqual(queued.map(item => item.id).sort(), ["correction", "original"]);
    assert.equal(queued.find(item => item.id === "correction").content, correction);
    const claimed = await fresh.drainInbox(); claimed.forEach(item => fresh.markInboxApplied(item));
    await fresh.saveState({ sessionId: "queue-continuity", chat: claimed.map(item => ({ role: "user", content: item.content })) });
    const restarted = new SessionStore(path.join(root, "sessions"), "queue-continuity");
    const persisted = await restarted.loadState();
    assert.equal(persisted.chat.some(item => item.content === correction), true);
    assert.deepEqual(await restarted.loadInbox(), []);
    if (process.env.AGINTI_TEST_EVIDENCE_DIR) {
      const evidence = path.join(process.env.AGINTI_TEST_EVIDENCE_DIR, "queue-continuity");
      await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
      for (const name of ["state.json", "inbox.jsonl", "inbox-claims.jsonl", "inbox-acknowledgements.jsonl"]) {
        await fs.writeFile(path.join(evidence, name), await fs.readFile(path.join(store.sessionDir, name)), { flag: "wx", mode: 0o600 });
      }
      await fs.writeFile(path.join(evidence, "observed.json"), JSON.stringify({ queued, claimed, models: 0, writesOutsideFixture: 0,
        freshStoreChat: persisted.chat, freshStoreVisibleInbox: await restarted.loadInbox() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
  } finally {
    Date.now = nativeNow; proceed.resolve();
    await Promise.allSettled([editing, sending].filter(Boolean)); closeSessionIndexConnections();
    if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
    await assert.rejects(fs.stat(root), { code: "ENOENT" });
  }
});
