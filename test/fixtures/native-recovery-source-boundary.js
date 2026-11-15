import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const [root, baseURL, mode] = process.argv.slice(2), originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== new URL(baseURL).origin) throw Error("OFFLINE_RECOVERY_NETWORK_ESCAPE");
  requests++; return Reflect.apply(originalFetch, globalThis, [input, options]);
};
const goal = mode.endsWith("-existing")
  ? "Fix module.py so its test passes. Run `python3 -m unittest -v test_compute.py` and leave unrelated files unchanged."
  : "Create module.py with a simple increment function, run `python3 -m unittest -v test_compute.py` and fix any failure. Leave unrelated files alone.";
const config = resolveRuntimeConfig({ goal, provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  commandCwd: root + "/workspace", maxSteps: 10, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: runtime, sessionId: "recovery-boundary-" + mode,
  apiKey: "synthetic-recovery-boundary-key", baseURL, enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block",
  allowFileTools: true, allowShellTool: true, allowDestructive: false, allowWrapperTools: false, allowAuxiliaryTools: false,
  allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole: () => {}, onLog: () => {}, onEvent: () => {},
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash" });
let result = null, error = null;
try { result = await runAgent(config); }
catch (value) { error = { code: value.code || "RUNTIME_ERROR", message: value.message }; }
finally { globalThis.fetch = originalFetch; closeSessionIndexConnections(); }
const state = JSON.parse(await fs.readFile(root + "/sessions/recovery-boundary-" + mode + "/state.json", "utf8"));
console.log(JSON.stringify({ result, error, requests, runtimeRevision: state.meta.runtimeConfig.revision,
  recoveryPacketVersion: state.meta.failedTestRecoveryPacket?.packetVersion || null }));
