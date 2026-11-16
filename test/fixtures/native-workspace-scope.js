import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const [root, baseURL, mode, phase] = process.argv.slice(2);
const runtime = process.env.AGINTI_TEST_SCOPE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const nativeFetch = globalThis.fetch, origin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  const actual = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (actual.origin !== origin) throw Error("OFFLINE_SCOPE_HTTP_ESCAPE");
  return Reflect.apply(nativeFetch, globalThis, [input, init]);
};
const workspace = path.join(root, "workspace"), sessionId = "native-scope-" + mode;
const writing = mode.startsWith("write"), unrestricted = mode === "unrestricted";
const goal = writing ? "Create a short Markdown file in the workspace. Do not run shell commands."
  : "Read allowed/note.md and answer here only. No file changes.";
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-v4-flash", routingMode: "manual",
  goal, commandCwd: workspace, taskProfile: "auto" }, {
  baseDir: workspace, packageDir: runtime, sessionId, apiKey: "synthetic-scope-key", baseURL,
  allowFileTools: true, allowShellTool: false, allowWebSearch: false, allowMcpTools: false,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowParallelScouts: false,
  enableScs: "off", sandboxMode: "host", useDockerSandbox: false,
});
Object.assign(config, { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  workspacePathScopeRoots: unrestricted ? [] : ["allowed"], workspaceWritePathScopeRoots: writing ? ["allowed/out"] : [],
  allowBrowserTools: false, allowCanvasTools: false, allowAgentLinkTools: false, allowCoordinationTools: false,
  allowSpecialistTools: false, allowJsonTools: false, allowJsonSpecialist: false, allowWritingTools: false, allowWritingSpecialist: false,
  allowLongJobTools: false, allowBackgroundJobs: false, allowTmuxTools: false, allowImageTools: false, allowVisionTools: false,
  allowImagePerception: false, allowImageGeneration: false, enableScs: "off", scsActive: false, allowProviderHandoff: false,
  dynamicSteps: "off", maxSteps: 5, modelTimeoutMs: 1000, onConsole() {}, onLog() {},
  routeProvider: "deepseek", routeModel: "deepseek-v4-flash", mainProvider: "deepseek", mainModel: "deepseek-v4-flash",
  spareProvider: "deepseek", spareModel: "deepseek-v4-flash",
});
if (phase !== "start") {
  const state = JSON.parse(await fs.readFile(path.join(config.sessionsDir, sessionId, "state.json")));
  Object.assign(config, { resume: sessionId, expectedRuntimeRevision: state.meta.runtimeConfig.revision });
  if (phase !== "recover") config.runtimePatch = {
    model: "deepseek-v4-pro", routeModel: "deepseek-v4-pro", mainModel: "deepseek-v4-pro", spareModel: "deepseek-v4-pro",
    ...(phase === "migrate" ? { workspacePathScopeRoots: ["allowed"], workspaceWritePathScopeRoots: [] } : {}),
    ...(phase === "widen" ? { workspacePathScopeRoots: [], workspaceWritePathScopeRoots: [] } : {}),
  };
}
try {
  const result = await runAgent(config);
  console.log(JSON.stringify({ resolved: true, result }));
} catch (error) {
  console.log(JSON.stringify({ resolved: false, code: typeof error?.code === "string" ? error.code : "RUNTIME_ERROR", message: String(error?.message || "").slice(0, 500) }));
} finally { globalThis.fetch = nativeFetch; closeSessionIndexConnections(); }
