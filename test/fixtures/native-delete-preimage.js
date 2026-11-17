import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_DELETE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SESSION_TOOL_FAMILY_FIELDS } = await import(pathToFileURL(path.join(runtime, "src/session-runtime.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));

const [root, baseURL, mode, phase] = process.argv.slice(2), workspace = path.join(root, "workspace");
const sessionId = "native-delete-preimage-" + mode, origin = new URL(baseURL).origin;
const fetch = globalThis.fetch, descriptor = Object.getOwnPropertyDescriptor(fs, "rename"); let injected = false;
globalThis.fetch = (input, init) => {
  const actual = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (actual.origin !== origin) throw new Error("OFFLINE_DELETE_PREFLIGHT_HTTP_ESCAPE");
  return Reflect.apply(fetch, globalThis, [input, init]);
};
Object.defineProperty(fs, "rename", { ...descriptor, value: async function (...args) {
  const result = await Reflect.apply(descriptor.value, this, args);
  if (phase === "start" && mode !== "normal" && !injected && args[1] === path.join(workspace, "status.md")) {
    injected = true; const target = path.join(workspace, "obsolete.md"), content = "# Owner correction: keep this current note.\n";
    if (mode === "atomic") { const temporary = path.join(workspace, "owner-correction.tmp"); await fs.writeFile(temporary, content); await fs.rename(temporary, target); }
    else await fs.writeFile(target, content);
  }
  return result;
} });
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-v4-flash", routingMode: "manual", taskProfile: "code", commandCwd: workspace,
  goal: phase === "start" ? "Read status.md and obsolete.md. Update status.md so it says Reviewed. Remove obsolete.md; keep everything else alone. Do not run commands."
    : "Read status.md and obsolete.md and report what is present now. Do not change any file." }, {
  baseDir: workspace, packageDir: runtime, sessionId,
  apiKey: "synthetic-delete-preimage-key", baseURL, allowFileTools: true, enableScs: "off", sandboxMode: "host",
  allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false,
});
Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(name => [name, false])), {
  sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  enableScs: "off", scsActive: false, dynamicSteps: "off", maxSteps: 6, modelTimeoutMs: 3000, allowProviderHandoff: false,
  routeProvider: "deepseek", routeModel: "deepseek-v4-flash", mainProvider: "deepseek", mainModel: "deepseek-v4-flash", spareProvider: "deepseek", spareModel: "deepseek-v4-flash",
  onConsole() {}, onLog(type, data) {
    if (phase === "start" && injected && type === "workspace.output" && data.toolName === "apply_patch" && data.ok === false) {
      throw Object.assign(new Error("Inspect the exact durable delete-conflict receipt"), { code: "PAUSE_AFTER_DELETE_CONFLICT" });
    }
  },
});
if (phase === "resume") {
  const state = JSON.parse(await fs.readFile(path.join(config.sessionsDir, sessionId, "state.json")));
  Object.assign(config, { resume: sessionId, expectedRuntimeRevision: state.meta.runtimeConfig.revision,
    runtimePatch: { model: "deepseek-v4-pro", routeModel: "deepseek-v4-pro", mainModel: "deepseek-v4-pro", spareModel: "deepseek-v4-pro" } });
}
try { const result = await runAgent(config); console.log(JSON.stringify({ injected, result })); }
catch (error) { console.log(JSON.stringify({ injected, error: { code: error.code || "RUNTIME_ERROR", message: error.message } })); }
finally { globalThis.fetch = fetch; Object.defineProperty(fs, "rename", descriptor); closeSessionIndexConnections(); }
