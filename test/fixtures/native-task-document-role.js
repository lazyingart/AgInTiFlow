import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SESSION_TOOL_FAMILY_FIELDS } = await import(pathToFileURL(path.join(runtime, "src/session-runtime.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const [root, baseURL, mode, phase = "start"] = process.argv.slice(2), workspace = path.join(root, "workspace");
const originalFetch = globalThis.fetch, origin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  if (new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin !== origin) throw Error("OFFLINE_TASK_DOCUMENT_HTTP_ESCAPE");
  return Reflect.apply(originalFetch, globalThis, [input, init]);
};
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "auto", commandCwd: workspace,
  goal: phase === "resume" ? "Please continue from the saved checkpoint." : "Read intake/TASK.md and briefly explain its status here. Do not run commands or change files." }, {
  baseDir: workspace, packageDir: runtime, sessionId: "task-document-" + mode, apiKey: "synthetic-task-document-key", baseURL,
  allowFileTools: true, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false,
  enableScs: mode === "off" ? "off" : "on", scsValidationMode: "deterministic", sandboxMode: "host", packageInstallPolicy: "block",
});
Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(f => [f, false])), {
  sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), workspacePathScopeRoots: ["intake"], workspaceWritePathScopeRoots: ["out"],
  allowProviderHandoff: false, dynamicSteps: "off", maxSteps: mode === "legacy" && phase === "start" ? 1 : 5, modelTimeoutMs: 3000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash",
  onConsole() {}, onLog() {},
});
if (phase === "resume") Object.assign(config, { resume: config.sessionId, expectedRuntimeRevision: 1,
  runtimePatch: { model: "deepseek-v4-pro", routeModel: "deepseek-v4-pro", mainModel: "deepseek-v4-pro", spareModel: "deepseek-v4-pro", maxSteps: 5 } });
try { console.log(JSON.stringify({ result: await runAgent(config) })); }
catch (error) { console.log(JSON.stringify({ error: { code: error.code || "RUNTIME_ERROR", message: String(error.message).slice(0, 500) } })); }
finally { globalThis.fetch = originalFetch; closeSessionIndexConnections(); }
