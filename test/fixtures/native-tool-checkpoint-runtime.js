import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { SessionStore } from "../../src/session-store.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";
import { getEventListeners } from "node:events";

const [root, baseURL, rawMode, phase] = process.argv.slice(2), sessionId = "tool-checkpoint-" + rawMode;
const commandRun = rawMode.startsWith("command-"), commandFailed = rawMode.startsWith("command-failed-");
const mode = commandRun ? rawMode.slice(commandFailed ? "command-failed-".length : "command-".length).replace(/^(?:no-match|inner-failure|test)-/, "").replace(/-(?:pre-read|no-reasoning|long-argv)/g, "") : rawMode;
const readBatch = mode.startsWith("read-batch");
const append = Object.getOwnPropertyDescriptor(SessionStore.prototype, "appendEvent");
if (["event-checkpoint-crash", "change-checkpoint-crash", "result-event-save-error", "read-batch-event-checkpoint-crash"].includes(mode) && phase === "start") Object.defineProperty(SessionStore.prototype, "appendEvent", { ...append, value: async function (type, data) {
  const completed = type === "tool.completed" && data.ok === !commandFailed && (commandRun ? data.toolName === "run_command" : readBatch ? data.toolName === "read_file" && data.args?.path === "other.txt" : ["write_file", "apply_patch"].includes(data.toolName));
  if (mode === "result-event-save-error" && completed) {
    const error = new Error("Synthetic result-event append EIO"); error.code = "EIO"; throw error;
  }
  const result = await Reflect.apply(append.value, this, [type, data]);
  if ((completed && mode !== "change-checkpoint-crash") || (mode === "change-checkpoint-crash" && type === "file.changed")) process.kill(process.pid, "SIGKILL");
  return result;
} });
const originalFetch = globalThis.fetch, offlineOrigin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  const actual = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (actual.origin !== offlineOrigin) throw new Error("OFFLINE_HTTP_ESCAPE_REFUSED");
  return Reflect.apply(originalFetch, globalThis, [input, init]);
};
const save = Object.getOwnPropertyDescriptor(SessionStore.prototype, "saveState");
let failed = false;
if (mode === "save-error" && phase === "start") Object.defineProperty(SessionStore.prototype, "saveState", { ...save, value: function (state) {
  if (!failed && state.messages?.some(m => m.role === "tool" && m.tool_call_id === (commandRun ? "checkpoint_command" : "checkpoint_write"))) {
    failed = true;
    const error = new Error("Synthetic completed-batch checkpoint EIO"); error.code = "EIO";
    return Promise.reject(error);
  }
  return Reflect.apply(save.value, this, [state]);
} });
const workspace = root + "/workspace";
let observerFailed = false, observerTrapReads = 0;
const observerAbort = mode === "observer-abort" ? new AbortController() : null;
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  goal: phase === "resume" ? "Continue the same task." : rawMode.startsWith("command-no-match-") ? "Check whether this agent has a child process named acp_nomatch and report what you observe. Do not change files." : commandRun ? "Run the supplied check.mjs once and tell me its observed result. Do not rerun it." : readBatch ? "Read note.txt and other.txt and explain both without changing files." : "Read note.txt and save a concise summary.md. Keep note.txt unchanged.",
  commandCwd: workspace, maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: workspace, packageDir: fileURLToPath(new URL("../../", import.meta.url)), sessionId, apiKey: "synthetic-checkpoint-key", baseURL,
  // Only the fixed test-owned checker is run in this explicitly trusted host
  // fixture. Ordinary file tests retain their original shell/permission limits.
  enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: commandRun, allowDestructive: commandRun,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false,
  onConsole: () => {}, onEvent: (type, data) => {
    if (phase !== "start" || observerFailed || !(commandRun ? data.toolName === "run_command" : readBatch ? data.toolName === "read_file" : ["write_file", "apply_patch"].includes(data.toolName))) return;
    if (type === "tool.started" && mode.startsWith("start-")) {
      observerFailed = true;
      if (mode === "start-async-error") return Promise.reject(new Error("Synthetic pre-dispatch observer failure"));
      throw new Error("Synthetic pre-dispatch observer failure");
    }
    const target = mode === "change-error" ? type === "file.changed" : type === "tool.completed";
    if (!target || !["event-error", "event-async-error", "change-error", "event-hostile-error", "read-batch-event-error", "read-batch-async-error", "observer-abort"].includes(mode)) return;
    observerFailed = true;
    if (mode === "observer-abort") {
      setImmediate(() => observerAbort.abort(new Error("Synthetic user interrupt")));
      return new Promise(() => {});
    }
    if (mode === "event-hostile-error") throw Object.create(null, { message: { get() { observerTrapReads++; throw Error("CALLBACK_PRIVATE_SENTINEL"); } } });
    if (["event-async-error", "read-batch-async-error"].includes(mode)) return Promise.reject(new Error("CALLBACK_PRIVATE_SENTINEL"));
    throw new Error("CALLBACK_PRIVATE_SENTINEL");
  }, onLog: (type, data) => {
    if (phase !== "start" || type !== (commandRun ? "command.output" : "workspace.output") || (!commandRun && !data.ok)) return;
    const target = commandRun || (readBatch ? data.toolName === "read_file" && data.args?.path === "other.txt" : ["write_file", "apply_patch"].includes(data.toolName));
    if (!target) return;
    fs.writeFileSync(root + "/post-result-callback.json", JSON.stringify({ toolName: data.toolName, ok: data.ok }));
    if (["crash", "read-batch"].includes(mode)) process.kill(process.pid, "SIGKILL");
    if (mode === "callback-error") throw new Error("Synthetic post-result callback failure");
    if (mode === "log-async-error") return Promise.reject(new Error("CALLBACK_PRIVATE_SENTINEL"));
  },
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash",
  ...(phase === "resume" ? { resume: sessionId } : {}),
  ...(observerAbort ? { abortSignal: observerAbort.signal } : {}),
});
try { console.log(JSON.stringify({ ...await runAgent(config), observerAbortListeners: observerAbort ? getEventListeners(observerAbort.signal, "abort").length : 0 })); }
catch (error) { console.log(JSON.stringify({ error: { code: error.code || "RUNTIME_ERROR", message: error.message }, observerTrapReads })); process.exitCode = 1; }
finally { globalThis.fetch = originalFetch; Object.defineProperty(SessionStore.prototype, "saveState", save); Object.defineProperty(SessionStore.prototype, "appendEvent", append); closeSessionIndexConnections(); }
