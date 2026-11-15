import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(runtime + "/src/agent-runner.js"));
const { resolveRuntimeConfig } = await import(pathToFileURL(runtime + "/src/config.js"));
const { closeSessionIndexConnections } = await import(pathToFileURL(runtime + "/src/session-index.js"));
const [root, baseURL, phase] = process.argv.slice(2), sessionId = "acceptance-native", model = phase === "resume" ? "deepseek-v4-pro" : "deepseek-flash";
const fetch0 = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (u.origin !== new URL(baseURL).origin) throw Error("OFFLINE_ACCEPTANCE_NETWORK_ESCAPE");
  return Reflect.apply(fetch0, globalThis, [input, options]);
};
const config = resolveRuntimeConfig({ provider: "deepseek", model, routingMode: "manual", taskProfile: "code",
  goal: phase === "start" ? "Read TASK.md and complete the project it describes. Leave unrelated files alone." : phase === "resume" ? "Continue the same task. Save notes.md with the observed status and finish." : "Please continue from where you stopped.",
  commandCwd: root + "/workspace", maxSteps: 8, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: runtime, sessionId, apiKey: "synthetic-acceptance-key", baseURL, enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block",
  // The final fixture explicitly opts into trusted host mode in its own temp
  // workspace for an immutable checker. Production permissions are unchanged.
  allowFileTools: true, allowShellTool: true, allowDestructive: phase === "finish", allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole: () => {}, onLog: () => {},
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 4000,
  routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model,
  ...(phase !== "start" ? { resume: sessionId, expectedRuntimeRevision: phase === "resume" ? 1 : 2, runtimePatch: { model, routeModel: model, mainModel: model, spareModel: model, ...(phase === "finish" ? { allowDestructive: true } : {}) } } : {}) });
try { console.log(JSON.stringify({ resolved: true, result: await runAgent(config) })); }
catch (e) { console.log(JSON.stringify({ resolved: false, code: e.code || "RUNTIME_ERROR", status: e.status || 0, message: e.message })); }
finally { globalThis.fetch = fetch0; closeSessionIndexConnections(); }
