import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const [root, baseURL, phase, mode = "reply"] = process.argv.slice(2);
const runtime = process.env.AGINTI_TEST_INSTRUCTION_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SESSION_TOOL_FAMILY_FIELDS } = await import(pathToFileURL(path.join(runtime, "src/session-runtime.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const fetch = globalThis.fetch, origin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  const actual = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (actual.origin !== origin) throw Error("OFFLINE_INSTRUCTION_HTTP_ESCAPE");
  return Reflect.apply(fetch, globalThis, [input, init]);
};
const workspace = path.join(root, "workspace"), sessionId = "native-project-instructions";
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-v4-flash", routingMode: "manual",
  goal: mode === "edit" ? phase === "start" ? "Please read brief.md and turn it into a short checklist.md. Keep every requested action, leave the input and other files alone, and do not run commands."
    : "Continue the same task: make the checklist bilingual, English and Chinese on each item. Keep all three actions and do not change the source or other files."
    : "Reply exactly READY. Do not change any project file.", commandCwd: workspace, taskProfile: "auto" }, {
  baseDir: workspace, packageDir: runtime, sessionId, apiKey: "synthetic-instruction-test-key", baseURL,
  allowFileTools: mode === "edit", allowShellTool: false, allowWebSearch: false, allowMcpTools: false,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowParallelScouts: false,
  enableScs: "off", sandboxMode: "host", useDockerSandbox: false,
});
Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(name => [name, false])), {
  sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  enableScs: "off", scsActive: false, allowProviderHandoff: false, dynamicSteps: "off", maxSteps: mode === "edit" ? 6 : 3,
  modelTimeoutMs: 2000, onConsole() {}, onLog() {}, routeProvider: "deepseek", routeModel: "deepseek-v4-flash",
  mainProvider: "deepseek", mainModel: "deepseek-v4-flash", spareProvider: "deepseek", spareModel: "deepseek-v4-flash",
});
if (phase === "resume") {
  const state = JSON.parse(await fs.readFile(path.join(config.sessionsDir, sessionId, "state.json")));
  Object.assign(config, { resume: sessionId, expectedRuntimeRevision: state.meta.runtimeConfig.revision,
    runtimePatch: { model: "deepseek-v4-pro", routeModel: "deepseek-v4-pro", mainModel: "deepseek-v4-pro", spareModel: "deepseek-v4-pro" } });
}
try { console.log(JSON.stringify({ result: await runAgent(config) })); }
finally { globalThis.fetch = fetch; closeSessionIndexConnections(); }
