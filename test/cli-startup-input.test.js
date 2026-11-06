import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const fixture = name => fileURLToPath(new URL("./fixtures/" + name, import.meta.url));

for (const mode of ["stale-cas", "queued-prompts", "empty-eof"]) test(`non-TTY input during delayed saved history: ${mode}`, { timeout: 40000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-cli-startup-"));
  const children = new Set();
  t.after(async () => {
    for (const entry of children) {
      entry.child.kill("SIGKILL");
      await entry.closed;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, AGINTIFLOW_HOME: root + "/home",
    AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", AGINTI_LANGUAGE: "en" };
  function start(args, extra = {}) {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", expired = false, gateResolve;
    const gate = new Promise(resolve => gateResolve = resolve);
    const entry = { child, closed: null }; children.add(entry);
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("TEST_HISTORY_INPUT_GATE")) gateResolve(); });
    child.stderr.on("data", chunk => stderr += chunk);
    entry.closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 18000);
      child.once("error", error => { clearTimeout(timer); children.delete(entry); reject(error); });
      child.once("close", code => { clearTimeout(timer); children.delete(entry); resolve({ code, expired, stdout, stderr }); });
    });
    entry.closed.catch(() => {});
    const awaitingGate = Promise.race([gate, entry.closed.then(result => { throw Error("CLI closed before history gate: " + JSON.stringify(result)); })]);
    awaitingGate.catch(() => {});
    return { child, closed: entry.closed, gate: awaitingGate };
  }
  const seed = start([fixture("cli-startup-seed.js"), root]);
  seed.child.stdin.end();
  const seeded = await seed.closed; assert.equal(seeded.code, 0, JSON.stringify(seeded)); assert.equal(seeded.expired, false);
  const info = JSON.parse(await fs.readFile(root + "/seed.json"));
  const statePath = info.dir + "/state.json", before = JSON.parse(await fs.readFile(statePath));
  const initialBytes = await fs.readFile(root + "/notes/seed.md");
  const secret = "synthetic-ambient-key-must-not-persist";
  const cli = start(["--import", fixture("cli-startup-history-gate.js"), rootPath + "bin/aginti-cli.js", "resume", info.sessionId], {
    AGINTI_TEST_HISTORY_EVENTS: info.dir + "/events.jsonl", AGENT_PROVIDER: "openai", OPENAI_API_KEY: secret, LLM_API_KEY: secret,
  });
  await cli.gate;
  const prompt = "This stale runtime prompt must not reach inference.";
  if (mode === "stale-cas") {
    const concurrent = JSON.parse(await fs.readFile(statePath)); concurrent.meta.runtimeConfig.revision++;
    await fs.writeFile(statePath, JSON.stringify(concurrent, null, 2) + "\n");
    cli.child.stdin.end(prompt + "\n/exit\n");
  } else if (mode === "queued-prompts") {
    cli.child.stdin.end("Create notes/queued-one.md with a short message.\nCreate notes/queued-two.md with a short message.\n/exit\n");
  } else cli.child.stdin.end();
  const result = await cli.closed; assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.expired, false);
  const after = JSON.parse(await fs.readFile(statePath));
  assert.equal(JSON.stringify(after).includes(secret), false);
  assert.equal(after.meta.runtimeConfig.provider, "mock");
  assert.equal(after.meta.runtimeConfig.model, "mock-agent");
  assert.deepEqual(await fs.readFile(root + "/notes/seed.md"), initialBytes);
  if (mode === "stale-cas") {
    assert.match(result.stdout + result.stderr, /Session runtime revision conflict/);
    assert.deepEqual(after.chat, before.chat);
    assert.equal(JSON.stringify(after).includes(prompt), false);
    assert.equal(after.meta.runtimeConfig.revision, before.meta.runtimeConfig.revision + 1);
  } else if (mode === "queued-prompts") {
    for (const name of ["queued-one", "queued-two"]) {
      assert.match(await fs.readFile(root + "/notes/" + name + ".md", "utf8"), /Created by AgInTiFlow mock mode/);
      assert.ok(after.chat.some(message => message.role === "user" && message.content.includes(name)));
    }
    const events = (await fs.readFile(info.dir + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(event => event.type === "file.changed").length, 3);
    assert.equal(after.meta.goalContract.status, "completed");
  } else assert.deepEqual(after.chat, before.chat);
  await assert.rejects(fs.stat(info.dir + "/.agent-run.lock"), { code: "ENOENT" });
});
