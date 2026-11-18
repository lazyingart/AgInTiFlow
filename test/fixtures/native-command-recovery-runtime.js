import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { SessionStore } from "../../src/session-store.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

const [root, baseURL, mode, phase] = process.argv.slice(2);
const sessionId = "unconfirmed-command", workspace = path.join(root, "workspace");
const mappedCommit = mode === "mapped-commit-ready-crash";
const indexedProvider = mode === "indexed-ready-crash";
const save = Object.getOwnPropertyDescriptor(SessionStore.prototype, "saveState");
const append = Object.getOwnPropertyDescriptor(SessionStore.prototype, "appendEvent");
let injected = false, unhandled = 0;
const onUnhandled = () => { unhandled++; };
process.on("unhandledRejection", onUnhandled);
Object.defineProperty(SessionStore.prototype, "saveState", { ...save, value: async function (state) {
  if (phase === "resume" && mode === "workspace-rebind" && state.meta?.nativeCommandJournal?.pending === null && state.messages?.some(m => m.role === "tool" && m.tool_call_id === "check_once")) {
    await Reflect.apply(save.value, this, [state]); process.kill(process.pid, "SIGKILL");
  }
  if (phase === "start" && state.sessionId === sessionId) {
    const pending = state.meta?.nativeCommandJournal?.pending;
    const closed = state.messages?.some(m => m.role === "tool" && m.tool_call_id === "check_once");
    if (!injected && pending?.status === "dispatching" && mode === "intent-before-error") {
      injected = true; throw Object.assign(new Error("Synthetic intent save EIO"), { code: "EIO" });
    }
    if (!injected && pending?.status === "dispatching" && mode === "intent-commit-crash") {
      await Reflect.apply(save.value, this, [state]); injected = true; process.kill(process.pid, "SIGKILL");
    }
    if (pending?.status === "result-ready" && ["effect-crash", "legacy-unknown", "legacy-corrupt", "journal-null", "journal-foreign", "workspace-unknown"].includes(mode)) process.kill(process.pid, "SIGKILL");
    if (closed && ["ready-crash", "failed-ready-crash", "bounded-ready-crash", "workspace-rebind", "recovery-event-error", "mapped-commit-ready-crash", "indexed-ready-crash"].includes(mode)) process.kill(process.pid, "SIGKILL");
    if (!injected && pending?.status === "result-ready" && mode === "ready-commit-error") {
      await Reflect.apply(save.value, this, [state]); injected = true;
      throw Object.assign(new Error("Synthetic ready save lost acknowledgement"), { code: "EIO" });
    }
    if (pending?.status === "result-ready" && mode === "ready-write-error") {
      injected = true; throw Object.assign(new Error("Synthetic persistent result save EIO"), { code: "EIO" });
    }
    if (!injected && closed && mode === "closed-save-error") {
      injected = true; throw Object.assign(new Error("Synthetic closed frame EIO"), { code: "EIO" });
    }
  }
  return Reflect.apply(save.value, this, [state]);
} });
Object.defineProperty(SessionStore.prototype, "appendEvent", { ...append, value: async function (type, data) {
  if (phase === "resume" && mode === "recovery-event-error" && type === "command.result_recovered") {
    throw Object.assign(new Error("Synthetic recovery publication EIO"), { code: "EIO" });
  }
  if (phase === "start" && ["event-error", "legacy-confirmed"].includes(mode) && type === "tool.completed" && data.toolName === "run_command") {
    injected = true; throw Object.assign(new Error("Synthetic publication EIO"), { code: "EIO" });
  }
  return Reflect.apply(append.value, this, [type, data]);
} });
const fetch0 = globalThis.fetch, origin = new URL(baseURL).origin;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== origin) throw Error("OFFLINE_RECOVERY_HTTP_ESCAPE");
  return Reflect.apply(fetch0, globalThis, [input, options]);
};
const model = phase === "start" ? "deepseek-flash" : "deepseek-v4-pro";
const config = resolveRuntimeConfig({ provider: "deepseek", model, routingMode: "manual", ...(indexedProvider ? {} : { executionTier: "focused" }), taskProfile: indexedProvider ? "auto" : "code",
  goal: phase === "start" ? mappedCommit ? "Create note.txt containing confirmed, then commit that file locally and report the result. Do not push." : "Please run `node tools/check.mjs` once and tell me what it reports. Do not rerun it." : "Continue the same task.",
  commandCwd: workspace, maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: workspace, packageDir: fileURLToPath(new URL("../../", import.meta.url)), sessionId, baseURL,
  apiKey: "synthetic-recovery-key", enableScs: indexedProvider ? "on" : "off", scsValidationMode: "deterministic", sandboxMode: "host", packageInstallPolicy: "block", allowDestructive: true,
  allowFileTools: mappedCommit, allowShellTool: true, allowWrapperTools: false, allowWebSearch: false, allowMcpTools: false,
  allowAuxiliaryTools: false, allowParallelScouts: false, onLog: () => {}, onConsole: () => {}, onEvent(type, data) {
    if (mappedCommit) return;
    if (type === "tool.started" && !(data.toolName === "run_command" && data.args?.command === "node tools/check.mjs" || data.toolName === "finish")) throw Error("FIXTURE_TOOL_SCOPE");
  },
});
Object.assign(config, { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  modelTimeoutMs: 4000, allowProviderHandoff: false, routeProvider: "deepseek", routeModel: model,
  mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model,
  ...(phase === "start" ? {} : { resume: sessionId, expectedRuntimeRevision: phase === "again" ? 2 : 1,
    runtimePatch: { model, routeModel: model, mainModel: model, spareModel: model,
      ...(mode.startsWith("workspace-") ? { commandCwd: path.join(root, "next-workspace") } : {}) } }),
});
try { console.log(JSON.stringify({ outcome: await runAgent(config), injected, unhandled })); }
catch (error) { console.log(JSON.stringify({ error: { code: error.code || "RUNTIME_ERROR", message: error.message }, injected, unhandled })); process.exitCode = 1; }
finally {
  Object.defineProperty(SessionStore.prototype, "saveState", save);
  Object.defineProperty(SessionStore.prototype, "appendEvent", append);
  globalThis.fetch = fetch0; process.off("unhandledRejection", onUnhandled); closeSessionIndexConnections();
}
