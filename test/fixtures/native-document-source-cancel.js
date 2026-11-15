import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const [root, baseURL, mode] = process.argv.slice(2), controller = new AbortController();
const originalFetch = globalThis.fetch, open = sync.openSync, close = sync.closeSync;
let sourceWritten = false, sourceOpened = false, sourceClosed = false, abortDelivered = false, sourceFd;
sync.openSync = function(file, ...args) {
  const fd = Reflect.apply(open, sync, [file, ...args]);
  if (String(file) === root + "/workspace/status-note.tex") { sourceOpened = true; sourceFd = fd; }
  return fd;
};
sync.closeSync = function(fd) {
  const result = Reflect.apply(close, sync, [fd]);
  if (sourceOpened && fd === sourceFd && !sourceClosed) {
    sourceClosed = true;
    // Exact test gate: abort only after the actual source descriptor closes.
    // This observes the real native path without substituting an executor.
    queueMicrotask(() => { abortDelivered = true; controller.abort(new Error("owned post-snapshot cancellation")); });
  }
  return result;
};
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== new URL(baseURL).origin) throw Error("OFFLINE_DOCUMENT_SOURCE_NETWORK_ESCAPE");
  return Reflect.apply(originalFetch, globalThis, [input, options]);
};
const goal = "Create a short PDF status note. Leave unrelated files alone.";
const config = resolveRuntimeConfig({ goal, provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  commandCwd: root + "/workspace", maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: runtime, sessionId: "document-source-" + mode, apiKey: "synthetic-document-source-key", baseURL,
  enableScs: "on", scsValidationMode: "deterministic", sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: true,
  allowDestructive: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false,
  onConsole: () => {}, onLog: () => {}, onEvent(type, data) {
    if (type === "tool.completed" && data.toolName === "write_file" && !sourceWritten) {
      sourceWritten = true;
      if (mode === "fifo") {
        sync.unlinkSync(root + "/workspace/status-note.tex");
        if (spawnSync("mkfifo", [root + "/workspace/status-note.tex"], { timeout: 2000 }).status !== 0) throw Error("Owned FIFO setup failed");
      }
    }
  },
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", abortSignal: controller.signal,
  allowProviderHandoff: false, modelTimeoutMs: 4000, routeProvider: "deepseek", routeModel: "deepseek-flash",
  mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash" });
let result = null, error = null;
try { result = await runAgent(config); }
catch (e) { error = { code: e.code || "RUNTIME_ERROR", message: e.message }; }
finally { globalThis.fetch = originalFetch; sync.openSync = open; sync.closeSync = close; closeSessionIndexConnections(); }
console.log(JSON.stringify({ result, error, sourceWritten, sourceOpened, sourceClosed, abortDelivered }));
