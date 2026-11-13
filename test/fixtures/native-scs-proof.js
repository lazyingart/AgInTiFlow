import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const [root, baseURL] = process.argv.slice(2), nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const actual = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (actual.origin !== new URL(baseURL).origin) throw new Error("OFFLINE_SCS_NETWORK_ESCAPE_REFUSED");
  return Reflect.apply(nativeFetch, globalThis, [input, options]);
};
const goal = "Read input.csv. Use Python to check the mean. Save comparison.csv and report.md. Keep input.csv unchanged.";
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "data", goal, commandCwd: root + "/workspace", maxSteps: 10, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: runtime, sessionId: "native-scs-proof", apiKey: "synthetic-scs-proof-key", baseURL,
  enableScs: "on", scsValidationMode: "model", sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: true, allowDestructive: true,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole: () => {},
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash" });
try { console.log(JSON.stringify(await runAgent(config))); }
catch (error) { console.log(JSON.stringify({ error: error.code || "RUNTIME_ERROR", message: error.message }));process.exitCode = 1; }
finally { globalThis.fetch = nativeFetch;closeSessionIndexConnections(); }
