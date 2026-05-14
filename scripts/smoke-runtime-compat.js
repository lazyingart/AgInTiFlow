#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-runtime-compat-"));
const agintiflowHome = path.join(tempRoot, ".agintiflow-home");
process.env.AGINTIFLOW_HOME = agintiflowHome;
process.env.AGINTIFLOW_FORCE_JSON_DB = "1";

const { formatNodeSqliteRecovery, nodeSqliteStatus } = await import("../src/sqlite.js");
const { WebDatabase } = await import("../src/web-db.js");
const { deleteSessionIndex, listSessionIndex, renameSessionIndex, upsertSessionIndex } = await import("../src/session-index.js");

const sqliteStatus = nodeSqliteStatus();
assert.equal(sqliteStatus.ok, false, "forced sqlite fallback should report unavailable node:sqlite");
assert.equal(sqliteStatus.forcedJson, true, "forced sqlite fallback should be marked as forced");
const recovery = formatNodeSqliteRecovery(sqliteStatus);
assert.match(recovery, /Node\.js 22\+/);
assert.match(recovery, /npm install -g @lazyingart\/agintiflow@latest/);

const db = new WebDatabase(tempRoot);
assert.equal(db.driver, "json", "WebDatabase should use JSON fallback when node:sqlite is unavailable");

const preferences = db.getPreferences();
db.savePreferences({ ...preferences, model: "runtime-compat-model" });
assert.equal(db.getPreferences().model, "runtime-compat-model", "JSON fallback preferences should persist");

const session = {
  sessionId: "runtime-compat-session",
  projectRoot: tempRoot,
  commandCwd: tempRoot,
  provider: "mock",
  model: "mock-model",
  goal: "runtime compatibility",
  title: "Runtime Compatibility",
  status: "finished",
  startedAt: "2026-05-14T00:00:00.000Z",
  updatedAt: "2026-05-14T00:01:00.000Z",
  result: "ok",
};
db.upsertSession(session);
assert.equal(db.getSession(session.sessionId)?.title, "Runtime Compatibility", "JSON fallback session should persist");
assert.equal(db.listSessions(5).length, 1, "JSON fallback session listing should work");
assert.equal(db.renameSession(session.sessionId, "Renamed Runtime Compatibility"), true, "JSON fallback rename should work");
assert.equal(db.getSession(session.sessionId)?.title, "Renamed Runtime Compatibility", "JSON fallback rename should persist");
assert.equal(db.deleteSession(session.sessionId), true, "JSON fallback delete should work");
assert.equal(db.getSession(session.sessionId), null, "JSON fallback delete should remove the session");

assert.equal(upsertSessionIndex(session), true, "JSON fallback global index upsert should work");
assert.equal(listSessionIndex({ projectRoot: tempRoot }).length, 1, "JSON fallback global index listing should work");
assert.equal(renameSessionIndex(session.sessionId, "Indexed Runtime Compatibility"), true, "JSON fallback global index rename should work");
assert.equal(deleteSessionIndex(session.sessionId), true, "JSON fallback global index delete should work");

const port = 45200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "web", "--port", String(port), "--host", "127.0.0.1"], {
  cwd: tempRoot,
  env: {
    ...process.env,
    AGINTIFLOW_HOME: agintiflowHome,
    AGINTIFLOW_RUNTIME_DIR: tempRoot,
    AGINTIFLOW_FORCE_JSON_DB: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await response.json();
      if (health.ok) return health;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`forced JSON web health failed. stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`);
}

try {
  const health = await waitForHealth();
  assert.equal(health.storageDriver, "json", "web health should advertise JSON fallback storage");
  assert.equal(health.runtimeDir, tempRoot, "web runtime should use the requested project root");
} finally {
  if (server.exitCode === null && !server.killed) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
}

console.log("runtime compatibility smoke ok");
