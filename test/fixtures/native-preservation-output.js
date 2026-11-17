import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SESSION_TOOL_FAMILY_FIELDS } = await import(pathToFileURL(path.join(runtime, "src/session-runtime.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const [root, baseURL, mode, phase = "start"] = process.argv.slice(2), workspace = path.join(root, "workspace");
const realFetch = globalThis.fetch, origin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  if (new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin !== origin) throw Error("OFFLINE_PRESERVATION_NETWORK_ESCAPE");
  return Reflect.apply(realFetch, globalThis, [input, init]);
};
const preserve = mode === "simple" ? "Keep README.md unchanged." : "Keep README.md, package.json and other files unchanged.";
const goal = phase === "resume" ? "Continue the same task." : `Update src/entry.mjs to export value 2. Write tests in test/entry.test.mjs. ${mode === "report" ? "Create report.md with the observed result. " : ""}${preserve} Run \`node --test test/entry.test.mjs\`. Do not install anything or commit.`;
const config = resolveRuntimeConfig({ provider: "deepseek", model: "fixture-flash", routingMode: "manual", taskProfile: "code", commandCwd: workspace, goal }, {
  baseDir: workspace, packageDir: runtime, sessionId: "preservation-" + mode,
  apiKey: "synthetic-preservation-fixture", baseURL, enableScs: "on", scsValidationMode: "deterministic", sandboxMode: "host", packageInstallPolicy: "block",
  allowShellTool: true, allowFileTools: true, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false,
});
Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(field => [field, false])), {
  sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), dynamicSteps: "off", maxSteps: mode === "restart" && phase === "start" ? 4 : 10, modelTimeoutMs: 4000, allowProviderHandoff: false,
  routeProvider: "deepseek", routeModel: "fixture-flash", mainProvider: "deepseek", mainModel: "fixture-flash", spareProvider: "deepseek", spareModel: "fixture-flash",
  onConsole() {}, onLog() {},
});
if (phase === "resume") Object.assign(config, { resume: config.sessionId, expectedRuntimeRevision: 1,
  runtimePatch: { model: "fixture-pro", routeModel: "fixture-pro", mainModel: "fixture-pro", spareModel: "fixture-pro", maxSteps: 10 } });
try { console.log(JSON.stringify({ result: await runAgent(config) })); }
catch (error) { console.log(JSON.stringify({ error: { code: error.code || "RUNTIME_ERROR", message: error.message } })); }
finally { globalThis.fetch = realFetch; closeSessionIndexConnections(); }
