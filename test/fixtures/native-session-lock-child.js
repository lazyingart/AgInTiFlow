import fs from "node:fs/promises";
import path from "node:path";
import { acquireNativeSessionRunLock } from "../../src/session-run-lock.js";

const [root, sessionId, mode, worker = "0"] = process.argv.slice(2);
const lockPath = path.join(root, sessionId, ".agent-run.lock");
const nativeLink = fs.link, nativeUnlink = fs.unlink;
fs.link = async (from, to) => {
  if (mode === "crash-before-publish" && to === lockPath) process.exit(72);
  const result = await Reflect.apply(nativeLink, fs, [from, to]);
  if (mode === "crash-after-publish" && to === lockPath) process.exit(73);
  if (mode === "crash-reap-claim" && from === lockPath && to.startsWith(lockPath + ".reap.")) process.exit(74);
  if (mode === "crash-release-claim" && from === lockPath && to.startsWith(lockPath + ".release.")) process.exit(75);
  return result;
};
fs.unlink = async name => {
  const result = await Reflect.apply(nativeUnlink, fs, [name]);
  if (mode === "crash-after-remove" && name === lockPath) process.exit(76);
  return result;
};

function send(value) { return new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve())); }

try {
  if (mode === "stress") {
    for (let iteration = 0; iteration < 12; iteration++) {
      const started = performance.now();
      let release;
      while (!release) {
        try { release = await acquireNativeSessionRunLock({ sessionsDir: root }, sessionId); }
        catch (error) {
          if (!["SESSION_RUN_ACTIVE", "SESSION_RUN_LOCK_UNAVAILABLE"].includes(error.code) || performance.now() - started > 30000) throw error;
          await new Promise(resolve => setTimeout(resolve, 2 + Number(worker)));
        }
      }
      const marker = path.join(root, sessionId, "critical.marker");
      try {
        const handle = await fs.open(marker, "wx");
        await handle.close();
        await new Promise(resolve => setTimeout(resolve, 2));
        await fs.appendFile(path.join(root, sessionId, "commits.jsonl"), JSON.stringify({ worker, iteration }) + "\n");
        await fs.unlink(marker);
      } finally { await release(); }
    }
    await send({ type: "done" });
  } else {
    const release = await acquireNativeSessionRunLock({ sessionsDir: root }, sessionId);
    await send({ type: "claimed", pid: process.pid });
    const action = await new Promise(resolve => process.once("message", resolve));
    if (action === "crash") process.exit(71);
    if (action !== "release") throw new Error("Unexpected fixture command");
    await release();
    await send({ type: "released" });
  }
  process.disconnect();
} catch (error) {
  await send({ type: "failed", code: error.code || "FIXTURE_FAILED" }).catch(() => {});
  process.exitCode = 1;
  process.disconnect();
}
