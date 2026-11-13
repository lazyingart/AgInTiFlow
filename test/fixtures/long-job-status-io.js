// Qualification-only filesystem scheduler. The generated production worker is
// unchanged; real file writes, renames and the shell child still execute.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const root = process.env.AGINTI_STATUS_TEST_ROOT, mode = process.env.AGINTI_STATUS_TEST_MODE;
if (!root || !mode) throw new Error("STATUS_TEST_CONFIGURATION_REQUIRED");
const write = fsp.writeFile.bind(fsp), rename = fsp.rename.bind(fsp), append = fsp.appendFile.bind(fsp);
const interval = globalThis.setInterval, clear = globalThis.clearInterval;
let heartbeat, heartbeatHandle, blocked = false, overlap = false, released = false, faulted = false;
let active = 0, maximum = 0, release, renamed;
const ready = new Promise(resolve => { release = resolve; });
const done = new Promise(resolve => { renamed = resolve; });
const trace = entry => fs.appendFileSync(path.join(root, "io-events.jsonl"), JSON.stringify(entry) + "\n");
const fault = () => { faulted = true; trace({ event: "injected.failure", mode }); const error = new Error("Synthetic status publication EIO"); error.code = "EIO"; throw error; };
const targetState = mode.includes("verify") ? "verifying" : "running";
const gated = !mode.includes("error");

globalThis.setInterval = (fn, ms, ...args) => {
  heartbeat = () => fn(...args); heartbeatHandle = Reflect.apply(interval, globalThis, [fn, ms, ...args]); return heartbeatHandle;
};
globalThis.clearInterval = handle => {
  if (handle === heartbeatHandle) trace({ event: "heartbeat.closed" });
  return Reflect.apply(clear, globalThis, [handle]);
};
fsp.writeFile = async (file, content, options) => {
  if (path.basename(String(file)) !== "status.json.tmp") return write(file, content, options);
  const value = JSON.parse(content); active++; maximum = Math.max(maximum, active);
  trace({ event: "write.enter", state: value.state, pid: value.pid, active });
  try {
    if (!faulted && mode === "pid-write-error" && value.pid > 0) fault();
    if (!faulted && mode === "terminal-write-error" && value.state === "completed") fault();
    if (gated && value.state === targetState && value.pid > 0 && !blocked) {
      blocked = true; trace({ event: "pid.write.held" }); await ready;
    } else if (blocked && !released) {
      overlap = true; trace({ event: "overlap", state: value.state, active });
    }
    if (mode === "heartbeats" && ["completed", "failed"].includes(value.state)) {
      for (let i = 0; i < 500; i++) heartbeat();
      trace({ event: "late.heartbeat.flood", calls: 500 });
    }
    return await write(file, content, options);
  } finally { active--; }
};
fsp.appendFile = async (file, content, options) => {
  const result = await append(file, content, options);
  if (path.basename(String(file)) === "events.jsonl" && JSON.parse(content).type === (targetState === "verifying" ? "verify.finished" : "command.finished")) {
    if (mode === "heartbeats") {
      for (let i = 0; i < 500; i++) heartbeat();
      trace({ event: "heartbeat.flood", calls: 500 });
    }
    // A completion continuation reaches its fs call before this immediate if
    // publication is not serialized. Release a serialized writer without sleeps.
    setImmediate(() => {
      if (!overlap) { released = true; trace({ event: "serialized.release" }); release(); }
    });
  }
  return result;
};
fsp.rename = async (from, to) => {
  if (path.basename(String(to)) !== "status.json") return rename(from, to);
  const value = JSON.parse(await fsp.readFile(from, "utf8"));
  if (!faulted && mode === "pid-rename-error" && value.pid > 0) fault();
  if (!faulted && mode === "terminal-rename-error" && value.state === "completed") fault();
  if (overlap && ["completed", "failed"].includes(value.state) && !released) {
    trace({ event: "terminal.rename.held" }); released = true; release(); await done;
  } else if (released && value.state === targetState && value.pid > 0) {
    const result = await rename(from, to); trace({ event: "pid.rename.finished" }); renamed(); return result;
  }
  return rename(from, to);
};
process.on("unhandledRejection", () => { trace({ event: "unhandled.rejection" }); process.exitCode = 1; });
process.on("exit", code => trace({ event: "exit", code, maximum, overlap }));
