import fs from "node:fs";
import { getEventListeners } from "node:events";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { SessionStore } from "../../src/session-store.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

const [root, baseURL, scenario, phase] = process.argv.slice(2);
const [kind, mode] = scenario.split(":"), sessionId = "completion-delivery";
const originalFetch = globalThis.fetch, offlineOrigin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== offlineOrigin) throw Error("OFFLINE_HTTP_ESCAPE_REFUSED");
  return Reflect.apply(originalFetch, globalThis, [input, init]);
};
const unhandled = [], seen = [], durable = [];
let trapReads = 0, lateSettlement = null;
const unhandledListener = () => unhandled.push("unhandled");
process.on("unhandledRejection", unhandledListener);
const abort = new AbortController();
const save = Object.getOwnPropertyDescriptor(SessionStore.prototype, "saveState");
const append = Object.getOwnPropertyDescriptor(SessionStore.prototype, "appendEvent");
if (mode === "state-write-error") Object.defineProperty(SessionStore.prototype, "saveState", { ...save, value(state) {
  if (state.meta?.goalContract?.status === "completed") return Promise.reject(Object.assign(Error("Synthetic state EIO"), { code: "EIO" }));
  return Reflect.apply(save.value, this, [state]);
} });
if (["event-write-error", "diagnostic-write-error"].includes(mode)) Object.defineProperty(SessionStore.prototype, "appendEvent", { ...append, value(type, data) {
  if (type === (mode === "event-write-error" ? "session.finished" : "session.observer_delivery_failed")) return Promise.reject(Object.assign(Error("Synthetic event EIO"), { code: "EIO" }));
  return Reflect.apply(append.value, this, [type, data]);
} });
const terminal = (label) => {
  seen.push(label);
  const state = JSON.parse(fs.readFileSync(root + "/sessions/" + sessionId + "/state.json", "utf8"));
  const events = fs.readFileSync(root + "/sessions/" + sessionId + "/events.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  durable.push(state.meta.goalContract.status === "completed" && events.some(e => e.type === "session.finished"));
  if ((kind === "noop") !== (phase === "resume")) return;
  if (mode === "normal") return Promise.resolve();
  if (mode === "abort") { abort.abort(Error("Synthetic delivery-time cancellation")); return; }
  if (mode.endsWith("-hang")) return new Promise(() => {});
  if (mode === "event-late-reject") {
    let settled;
    lateSettlement = new Promise(resolve => { settled = resolve; });
    return new Promise((_, reject) => setTimeout(() => { reject(Error("CALLBACK_PRIVATE_SENTINEL")); settled(); }, 1150));
  }
  if (mode.endsWith("-hostile")) throw Object.create(null, {
    message: { get() { trapReads++; throw Error("CALLBACK_PRIVATE_SENTINEL"); } },
    name: { get() { trapReads++; throw Error("CALLBACK_PRIVATE_SENTINEL"); } },
  });
  if (mode.endsWith("-async")) return Promise.reject(Error("CALLBACK_PRIVATE_SENTINEL"));
  throw Error("CALLBACK_PRIVATE_SENTINEL");
};
const responseRequest = "Explain briefly why blocked work should not be marked done.";
const goal = phase === "resume" ? "Continue the same task." : kind === "direct" ? "Hello!"
  : kind === "response" ? responseRequest + "\nAGINTI_EVIDENCE_SCOPE_JSON: " + JSON.stringify({ mode: "chat-response", request: responseRequest })
    : "Read note.txt and leave it unchanged. Make a short summary.md of what's still blocked and what's already done.";
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  goal, commandCwd: root + "/workspace", maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: fileURLToPath(new URL("../../", import.meta.url)), sessionId,
  apiKey: "synthetic-offline-key", baseURL, enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block",
  allowFileTools: true, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false,
  allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false,
  onConsole(_text, options) {
    if (options.kind === "assistant") return terminal("console");
  },
  onEvent(type, data) {
    if (type === "session.finished" || (mode === "intent-sync" && type === "intent.classified") || (mode === "model-async" && type === "model.responded" && data.mode === "response-only")) {
      if (mode.startsWith("console-") && type === "session.finished") {
        // Still prove the event is attempted before the failing console callback.
        seen.push(type); return;
      }
      return terminal(type);
    }
  },
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash",
  abortSignal: abort.signal, ...(phase === "resume" ? { resume: sessionId } : {}),
});
// Console failures are independent of event failures, except the explicit both case.
const consoleCallback = config.onConsole;
config.onConsole = (_text, options) => {
  if (options.kind !== "assistant") return;
  if (mode.startsWith("console-") || mode === "both" || mode === "normal") return consoleCallback(_text, options);
  seen.push("console");
};
let report;
try { report = { resolved: true, outcome: await runAgent(config) }; }
catch (error) { report = { resolved: false, errorCode: error.code || "RUNTIME_ERROR" }; }
finally {
  if (lateSettlement) await lateSettlement;
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  closeSessionIndexConnections();
  globalThis.fetch = originalFetch;
  Object.defineProperty(SessionStore.prototype, "saveState", save);
  Object.defineProperty(SessionStore.prototype, "appendEvent", append);
  process.removeListener("unhandledRejection", unhandledListener);
}
console.log(JSON.stringify({ ...report, seen, durable, trapReads, unhandled: unhandled.length, abortListeners: getEventListeners(abort.signal, "abort").length }));
