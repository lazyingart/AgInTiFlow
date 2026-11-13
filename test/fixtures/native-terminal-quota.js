import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const [root, baseURL, phase] = process.argv.slice(2), sessionId = "terminal-quota", model = phase === "start" ? "deepseek-v4-pro" : "deepseek-flash";
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const actual = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (actual.origin !== new URL(baseURL).origin) throw new Error("OFFLINE_NETWORK_ESCAPE_REFUSED");
  return Reflect.apply(originalFetch, globalThis, [input, options]);
};
const config = resolveRuntimeConfig({ provider: "deepseek", model, routingMode: "manual", taskProfile: "code", goal: phase === "start" ? "Can you turn measurement.txt into a short brief.md and a checklist.md of what is still to do? Leave the source as it is." : "Please continue from where you stopped.", commandCwd: root + "/workspace", maxSteps: 8, dynamicSteps: "off" },
  { baseDir: root + "/workspace", packageDir: runtime, sessionId, apiKey: "synthetic-terminal-quota-key", baseURL, enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: false, allowDestructive: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole: () => {} });
Object.assign(config, { sessionsDir: root + "/home/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model,
  ...(phase === "resume" ? { resume: sessionId, expectedRuntimeRevision: 1, runtimePatch: { model, routeModel: model, mainModel: model, spareModel: model } } : {}) });
try { console.log(JSON.stringify({ resolved: true, result: await runAgent(config) })); }
catch (error) { console.log(JSON.stringify({ resolved: false, code: error.code || "RUNTIME_ERROR", status: error.status || 0 })); }
finally { globalThis.fetch = originalFetch; closeSessionIndexConnections(); }
