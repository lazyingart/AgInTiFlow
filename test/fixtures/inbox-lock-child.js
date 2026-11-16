import fs from "node:fs/promises";
import path from "node:path";
import { SessionStore } from "../../src/session-store.js";
const [root, mode, rawWorker] = process.argv.slice(2), worker = Number(rawWorker);
const store = new SessionStore(path.join(root, "sessions"), "inbox-lock", { inboxLockTimeoutMs: 10_000 });
const originalOpen = fs.open, originalLink = fs.link, originalUnlink = fs.unlink;
if (mode === "crash-publication") fs.open = async (target, ...args) => {
  const handle = await Reflect.apply(originalOpen, fs, [target, ...args]);
  if (String(target).includes(".inbox-lock-owner.")) process.exit(71);
  return handle;
};
if (["crash-linked", "crash-reap", "crash-release"].includes(mode)) fs.link = async (from, to) => {
  const value = await Reflect.apply(originalLink, fs, [from, to]);
  if ((mode === "crash-linked" && to === store.inboxLockPath) ||
    (mode === "crash-reap" && to.startsWith(store.inboxLockPath + ".reap.")) ||
    (mode === "crash-release" && to.startsWith(store.inboxLockPath + ".release."))) process.exit(71);
  return value;
};
if (mode === "crash-unlink") fs.unlink = async target => {
  const value = await Reflect.apply(originalUnlink, fs, [target]); if (target === store.inboxLockPath) process.exit(71); return value;
};
if (mode === "stress") {
  for (let iteration = 0; iteration < 10; iteration++) await store.withInboxLock(async () => {
    const sentinel = path.join(store.sessionDir, "critical"); const handle = await fs.open(sentinel, "wx", 0o600);
    try { await new Promise(resolve => setImmediate(resolve)); await fs.appendFile(path.join(store.sessionDir, "commits.jsonl"), JSON.stringify({ worker, iteration }) + "\n"); }
    finally { await handle.close(); await fs.unlink(sentinel); }
  });
  process.disconnect();
} else {
  const release = await store.acquireInboxLock();
  process.send({ type: "claimed" });
  await new Promise(resolve => process.once("message", resolve));
  if (mode === "crash-owner") process.exit(71);
  await release(); process.exit(0);
}
