import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SESSION_TOOL_FAMILY_FIELDS } = await import(pathToFileURL(path.join(runtime, "src/session-runtime.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const [root, baseURL, scs, mode, phase, expectedRevision = "1"] = process.argv.slice(2), workspace = path.join(root, "workspace");
const goal = phase === "repair" ? "Run `python3 --version` once and report its actual output. Do not create or modify files."
  : phase === "resume" ? "Please continue from the saved checkpoint."
  : mode === "paused-epoch" ? "Run `node tools/first-check.mjs` once. Separately run `node tools/second-check.mjs` once, and report both observed results. Do not repair or change files."
  : mode.includes("optional") ? "Run `node --version` once. If needed, separately run `python3 --version` once. Tell me the first observed result. Do not create or modify files."
  : "Run `node --version` once. Separately run `python3 --version` once, and tell me both outputs. Do not create or modify files.";
const fetch0 = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin !== new URL(baseURL).origin) throw Error("COMMAND_PREAMBLE_OFFLINE_ESCAPE");
  return Reflect.apply(fetch0, globalThis, [input, init]);
};
const model = phase === "start" ? "deepseek-flash" : "deepseek-v4-pro";
const config = resolveRuntimeConfig({ goal, commandCwd: workspace, taskProfile: "auto", provider: "deepseek", model, routingMode: "manual" }, {
  baseDir: workspace, packageDir: runtime, sessionId: "command-preamble", baseURL, apiKey: "synthetic-command-only",
  sandboxMode: "host", packageInstallPolicy: "block", enableScs: scs, scsValidationMode: "deterministic",
  allowShellTool: true, allowFileTools: false, allowWrapperTools: false, allowWebSearch: false, allowAuxiliaryTools: false, allowMcpTools: false, allowParallelScouts: false,
});
Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(f => [f, false])), {
  allowShellTool: true, sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), allowProviderHandoff: false,
  maxSteps: phase === "start" && mode.startsWith("paused") ? 1 : 4, dynamicSteps: "off", modelTimeoutMs: 3000,
  routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model,
  onConsole() {}, onLog() {},
});
if (phase !== "start") Object.assign(config, { resume: config.sessionId, expectedRuntimeRevision: Number(expectedRevision),
  runtimePatch: { model, routeModel: model, mainModel: model, spareModel: model, maxSteps: 5, ...(mode === "paused-epoch" ? { allowDestructive: true } : {}) } });
try { console.log(JSON.stringify({ result: await runAgent(config) })); }
catch (error) { console.log(JSON.stringify({ error: { code: error.code || "RUNTIME_ERROR", message: String(error.message).slice(0, 500) } })); }
finally { globalThis.fetch = fetch0; closeSessionIndexConnections(); }
