import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEventListeners } from "node:events";
const [root, baseURL, mode, phase, runtimeDir] = process.argv.slice(2);
const source = runtimeDir || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(source, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(source, "src/config.js")));
const { SessionStore } = await import(pathToFileURL(path.join(source, "src/session-store.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(source, "src/session-index.js")));
process.umask(0o077);
const append = Object.getOwnPropertyDescriptor(SessionStore.prototype, "appendEvent"), save = Object.getOwnPropertyDescriptor(SessionStore.prototype, "saveState");
let injected = false, unhandled = 0; const abort = new AbortController(), fetch_ = globalThis.fetch;
const unhandledListener = () => unhandled++; process.on("unhandledRejection", unhandledListener);
globalThis.fetch = (input, options) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (u.origin !== new URL(baseURL).origin) throw Error("OFFLINE_HTTP_ESCAPE_REFUSED");
  return Reflect.apply(fetch_, globalThis, [input, options]);
};
if (phase === "start") {
  Object.defineProperty(SessionStore.prototype, "appendEvent", { ...append, value: async function(type, data) {
    const completed = type === "tool.completed" && data.toolName === "start_long_job" && data.ok === true;
    if (!injected && (mode === "tool-event-eio" && completed || mode === "start-event-eio" && type === "long_job.started" || mode === "canvas-event-eio" && type === "canvas.item")) {
      injected = true; throw Object.assign(Error("Synthetic result-publication EIO"), { code: "EIO" });
    }
    const result = await Reflect.apply(append.value, this, [type, data]);
    if (mode === "after-tool-event-crash" && completed || mode === "after-start-event-crash" && type === "long_job.started") process.kill(process.pid, "SIGKILL");
    return result;
  } });
  Object.defineProperty(SessionStore.prototype, "saveState", { ...save, value: function(state) {
    if (["checkpoint-eio", "checkpoint-persistent-eio"].includes(mode) && (!injected || mode === "checkpoint-persistent-eio") && state.messages?.some(m => m.role === "tool" && m.tool_call_id === "start_export")) {
      injected = true; return Promise.reject(Object.assign(Error("Synthetic native-checkpoint EIO"), { code: "EIO" }));
    }
    return Reflect.apply(save.value, this, [state]);
  } });
}
const sessionId = "job-checkpoint-" + mode;
const goal = phase === "start" ? "Start the supplied export as a durable background job and tell me where to check it. Keep the input and script unchanged." : "Continue the same task. Do not start another export; report the existing job receipt and its observed status.";
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code", goal, commandCwd: root + "/workspace", maxSteps: 3, dynamicSteps: "off" },
  { baseDir: root + "/workspace", packageDir: source, sessionId, apiKey: "synthetic-offline-key", baseURL, enableScs: "off", sandboxMode: "host", allowShellTool: mode !== "not-offered", allowFileTools: true, allowDestructive: true,
    packageInstallPolicy: "block", allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole: () => {}, onEvent(type, data) {
      if (phase !== "start" || injected || type !== "tool.completed" || data.toolName !== "start_long_job") return;
      if (mode.startsWith("callback-sync")) { injected = true; throw Error("CALLBACK_PRIVATE_SENTINEL"); }
      if (mode === "callback-async") { injected = true; return Promise.reject(Error("CALLBACK_PRIVATE_SENTINEL")); }
      if (mode === "observer-abort") { injected = true; setImmediate(() => abort.abort(Error("Synthetic user interrupt"))); return new Promise(() => {}); }
    } });
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000, abortSignal: abort.signal,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash", ...(phase === "resume" ? { resume: sessionId } : {}) });
let report;
try { report = { resolved: true, outcome: await runAgent(config) }; } catch (error) { report = { resolved: false, code: error.code || "RUNTIME_ERROR" }; }
finally {
  await new Promise(resolve => setImmediate(resolve)); closeSessionIndexConnections(); globalThis.fetch = fetch_;
  Object.defineProperty(SessionStore.prototype, "appendEvent", append); Object.defineProperty(SessionStore.prototype, "saveState", save); process.removeListener("unhandledRejection", unhandledListener);
}
console.log(JSON.stringify({ ...report, injected, unhandled, abortListeners: getEventListeners(abort.signal, "abort").length }));
