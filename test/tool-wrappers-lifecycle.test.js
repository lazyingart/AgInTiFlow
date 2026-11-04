import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { spawn as nativeSpawn } from "node:child_process";
import { mock, test } from "node:test";

// No agent CLI is launched, no credentials are loaded and no signal is sent.
const children = [];
let useRealFixture = false;
mock.module("node:child_process", {
  namedExports: {
    execFileSync() {},
    spawn(command, args, options) {
      if (useRealFixture) {
        // Exercise real process-group cleanup using our own Node fixture only.
        const child = nativeSpawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("READY"); setInterval(() => {}, 1000);'], { ...options, env: {} });
        children.push(child);
        return child;
      }
      const child = new EventEmitter();
      Object.assign(child, {
        pid: 910000 + children.length, command, args, options, killed: false,
        stdout: new PassThrough(), stderr: new PassThrough(),
        kill(signal) { child.killed = true; child.signals.push(signal); return true; },
        signals: [],
      });
      children.push(child);
      return child;
    },
  },
});
const { runAgentWrapper, runCodexImageWrapper } = await import("../src/tool-wrappers.js");
const task = { wrapper: "codex", prompt: "Review the supplied code and report a concise second opinion." };

function setup(t) {
  children.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => { signals.push({ pid, signal }); return true; });
  const abort = new AbortController();
  return { signals, abort, config: { commandCwd: process.cwd(), wrapperTimeoutMs: 20, abortSignal: abort.signal } };
}

async function turn() { await new Promise(resolve => setImmediate(resolve)); }

test("already-cancelled delegation never spawns a child", async (t) => {
  const { abort, config } = setup(t);
  abort.abort(Object.freeze(new DOMException("Stop", "AbortError")));
  await assert.rejects(runAgentWrapper(task, config), { name: "AbortError" });
  assert.equal(children.length, 0);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("cancellation waits for close and escalates even after a kill was sent", async (t) => {
  const { abort, config, signals } = setup(t);
  let settled = false;
  const observed = runAgentWrapper(task, config).then(
    value => { settled = true; return { value }; },
    error => { settled = true; return { error }; }
  );
  const child = children[0];
  abort.abort("Stop");
  await turn();
  assert.equal(settled, false, "delegation returned while its child was still open");
  child.killed = true; // `killed` means a signal was sent, not confirmed exit.
  t.mock.timers.tick(1200);
  assert.ok(signals.some(({ signal }) => signal === "SIGKILL"));
  child.emit("close", null, "SIGKILL");
  assert.equal((await observed).error?.name, "AbortError");
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  const count = signals.length;
  t.mock.timers.tick(10000);
  assert.equal(signals.length, count, "a cleanup timer outlived confirmed close");
  assert.equal(children.length, 1);
});

test("a timed-out Codex call never starts a spare-model call", async (t) => {
  const { config, abort } = setup(t);
  const pending = runAgentWrapper(task, config);
  t.mock.timers.tick(20);
  children[0].emit("close", null, "SIGTERM");
  await turn();
  assert.equal(children.length, 1, "timeout automatically spent another Codex request");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/i);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("signal termination is never reported as successful advisory output", async (t) => {
  const { config } = setup(t);
  const pending = runAgentWrapper({ ...task, wrapper: "claude" }, config);
  children[0].emit("close", null, "SIGTERM");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /SIGTERM/);
});

test("confirmed successful advice preserves output and cleans its listener and timers", async (t) => {
  const { config, abort, signals } = setup(t);
  const pending = runAgentWrapper(task, config);
  children[0].stdout.write("A bounded second opinion.\n");
  children[0].emit("close", 0, null);
  assert.deepEqual(await pending, { ok: true, wrapper: "codex", stdout: "A bounded second opinion.", stderr: "" });
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  t.mock.timers.tick(10000);
  assert.equal(signals.length, 0);
});

test("an ordinary nonzero exit retains the existing explicit-wrapper spare model", async (t) => {
  const { config, abort } = setup(t);
  const pending = runAgentWrapper(task, config);
  children[0].emit("close", 1, null);
  await turn();
  assert.equal(children.length, 2);
  assert.notDeepEqual(children[1].args, children[0].args);
  children[1].stdout.write("Second opinion from the configured spare.");
  children[1].emit("close", 0, null);
  assert.equal((await pending).fallback, true);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("unconfirmed termination is bounded and cannot launch a spare", async (t) => {
  const { config, abort, signals } = setup(t);
  const pending = runAgentWrapper(task, config);
  t.mock.timers.tick(20);
  t.mock.timers.tick(1200);
  t.mock.timers.tick(3000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /termination could not be confirmed/);
  assert.equal(children.length, 1);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  const count = signals.length;
  children[0].emit("close", null, "SIGKILL");
  t.mock.timers.tick(10000);
  assert.equal(signals.length, count);
});

test("abort during timeout cleanup preserves cancellation and never retries", async (t) => {
  const { config, abort } = setup(t);
  const observed = runAgentWrapper(task, config).then(value => ({ value }), error => ({ error }));
  t.mock.timers.tick(20);
  abort.abort(Object.freeze(new DOMException("Stop", "AbortError")));
  t.mock.timers.tick(1200);
  t.mock.timers.tick(3000);
  const { error } = await observed;
  assert.equal(error?.name, "AbortError");
  assert.equal(error.code, "WRAPPER_TERMINATION_UNPROVEN");
  assert.equal(children.length, 1);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("already-cancelled image assistance never starts a child", async (t) => {
  const { config, abort } = setup(t);
  abort.abort();
  await assert.rejects(runCodexImageWrapper({ prompt: "Describe the supplied image.", imagePaths: ["fixture.png"] }, config), { name: "AbortError" });
  assert.equal(children.length, 0);
});

test("a missing executable rejects without waiting for the request timeout", async (t) => {
  const { config, abort } = setup(t);
  const pending = runAgentWrapper({ ...task, wrapper: "claude" }, config);
  children[0].pid = undefined;
  children[0].emit("error", Object.assign(new Error("Executable unavailable"), { code: "ENOENT" }));
  assert.equal((await pending).ok, false);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("a live child's error cannot authorize retry before confirmed close", async (t) => {
  const { config } = setup(t);
  let settled = false;
  const pending = runAgentWrapper(task, config).then(value => { settled = true; return value; });
  children[0].emit("error", new Error("Signal delivery failed"));
  await turn();
  assert.equal(settled, false);
  children[0].emit("close", 0, null);
  assert.equal((await pending).ok, false);
  assert.equal(children.length, 1);
});

test("real test-owned SIGTERM-resistant child is closed before abort returns", { skip: process.platform === "win32", timeout: 8000 }, async (t) => {
  children.length = 0;
  useRealFixture = true;
  const abort = new AbortController();
  let child;
  t.after(() => {
    useRealFixture = false;
    if (child?.exitCode === null && child?.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  });
  const observed = runAgentWrapper(task, { commandCwd: process.cwd(), wrapperTimeoutMs: 5000, abortSignal: abort.signal })
    .then(value => ({ value }), error => ({ error }));
  child = children[0];
  const ready = new Promise((resolve, reject) => {
    child.stdout.once("data", chunk => { assert.equal(chunk.toString(), "READY"); resolve(); });
    child.once("error", reject);
    child.once("close", () => reject(new Error("Fixture closed before ready")));
  });
  await ready;
  abort.abort();
  const { error } = await observed;
  assert.equal(error?.name, "AbortError");
  assert.equal(child.signalCode, "SIGKILL");
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  assert.equal(children.length, 1);
});
