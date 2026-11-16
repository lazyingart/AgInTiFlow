import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, baseURL, mode, phase] = process.argv.slice(2);
const runtime = process.env.AGINTI_TEST_MOVE_RUNTIME || new URL("../../", import.meta.url).pathname;
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SESSION_TOOL_FAMILY_FIELDS } = await import(pathToFileURL(path.join(runtime, "src/session-runtime.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const fetch = globalThis.fetch, origin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  if (new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin !== origin) throw new Error("OFFLINE_MOVE_HTTP_ESCAPE");
  return Reflect.apply(fetch, globalThis, [input, init]);
};
const workspace = path.join(root, "workspace"), sessionId = "move-metadata-" + mode, controller = new AbortController();
const unlink = Object.getOwnPropertyDescriptor(fs, "unlink");
Object.defineProperty(fs, "unlink", { ...unlink, value: async function (file, ...args) {
  const result = await Reflect.apply(unlink.value, this, [file, ...args]);
  if (phase === "start" && mode === "partial" && file === path.join(workspace, "alpha.md")) controller.abort();
  return result;
} });
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-v4-flash", routingMode: "manual", taskProfile: "code",
  goal: phase === "resume" ? "Continue the same task." : "Please put alpha.md and beta.md under archive/. Keep their content and permissions; leave other files alone.", commandCwd: workspace },
{ baseDir: workspace, packageDir: runtime, sessionId, baseURL, apiKey: "synthetic-move-metadata-key", allowFileTools: true, allowShellTool: false,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, enableScs: "off", sandboxMode: "host" });
Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(key => [key, false])), {
  sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), abortSignal: controller.signal,
  allowProviderHandoff: false, executionTier: "focused", dynamicSteps: "off", maxSteps: 7, modelTimeoutMs: 2000, onConsole() {}, onLog() {},
  onEvent(type, data) {
    if (phase === "start" && mode === "restart" && type === "tool.completed" && data.toolName === "apply_patch") controller.abort();
  },
});
if (phase === "resume") {
  const saved = JSON.parse(await fs.readFile(path.join(config.sessionsDir, sessionId, "state.json")));
  Object.assign(config, { resume: sessionId, expectedRuntimeRevision: saved.meta.runtimeConfig.revision, runtimePatch: { model: "deepseek-v4-pro" } });
}
const mask = process.umask(0o022);
try {
  let outcome; try { outcome = { result: await runAgent(config) }; }
  catch (error) { outcome = { error: { code: error.code || "RUNTIME_ERROR", message: String(error.message).slice(0, 300) } }; }
  console.log(JSON.stringify({ ...outcome, aborted: controller.signal.aborted, externalModelCalls: 0 }));
} finally { process.umask(mask); Object.defineProperty(fs, "unlink", unlink); globalThis.fetch = fetch; closeSessionIndexConnections(); }
