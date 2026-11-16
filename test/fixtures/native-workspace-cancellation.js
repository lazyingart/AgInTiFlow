import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [root, baseURL, mode, phase] = process.argv.slice(2);
const runtime = process.env.AGINTI_TEST_CANCEL_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SESSION_TOOL_FAMILY_FIELDS } = await import(pathToFileURL(path.join(runtime, "src/session-runtime.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const originalFetch = globalThis.fetch, origin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== origin) throw new Error("OFFLINE_CANCELLATION_HTTP_ESCAPE");
  return Reflect.apply(originalFetch, globalThis, [input, init]);
};
const workspace = path.join(root, "workspace"), controller = new AbortController(), order = [];
const stageHandles = new WeakSet(), open = Object.getOwnPropertyDescriptor(fs, "open");
Object.defineProperty(fs, "open", { ...open, value: async function (name, ...args) {
  const handle = await Reflect.apply(open.value, this, [name, ...args]);
  if (path.dirname(String(name)) === workspace && path.basename(String(name)).startsWith(".aginti-write-")) stageHandles.add(handle);
  return handle;
} });
const stop = () => { order.push("abort"); controller.abort(new Error("Synthetic user cancellation")); };
const rename = Object.getOwnPropertyDescriptor(fs, "rename");
Object.defineProperty(fs, "rename", { ...rename, value: async function (from, to) {
  const result = await Reflect.apply(rename.value, this, [from, to]);
  if (path.dirname(String(to)) === workspace && ["alpha.md", "beta.md"].includes(path.basename(String(to)))) {
    order.push("commit:" + path.basename(String(to)));
    if (phase === "start" && !controller.signal.aborted &&
        ((mode === "after-first" && path.basename(String(to)) === "alpha.md") ||
         (mode === "after-last" && path.basename(String(to)) === "beta.md"))) stop();
  }
  return result;
} });
const sentinel = await fs.open(path.join(root, "sentinel-" + phase), "wx"), prototype = Object.getPrototypeOf(sentinel);
await sentinel.close(); await fs.unlink(path.join(root, "sentinel-" + phase));
const sync = Object.getOwnPropertyDescriptor(prototype, "sync");
Object.defineProperty(prototype, "sync", { ...sync, value: async function (...args) {
  const result = await Reflect.apply(sync.value, this, args);
  if (phase === "start" && mode === "before-first" && !controller.signal.aborted) {
    if (stageHandles.has(this)) stop();
  }
  return result;
} });
const sessionId = "workspace-cancellation-" + mode;
try {
  const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-v4-flash", routingMode: "manual", taskProfile: "code",
    goal: phase === "resume" ? "Continue the same task." : "Fix the spelling in alpha.md and beta.md. Keep every other line as it is.", commandCwd: workspace }, {
    baseDir: workspace, packageDir: runtime, sessionId, apiKey: "synthetic-workspace-cancellation-key", baseURL,
    allowFileTools: true, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false,
    allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, enableScs: "off", sandboxMode: "host",
  });
  Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(field => [field, false])), {
    sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), abortSignal: controller.signal,
    allowProviderHandoff: false, modelTimeoutMs: 1000, dynamicSteps: "off", maxSteps: 6, onConsole() {}, onLog() {},
  });
  if (phase === "resume") {
    const saved = JSON.parse(await fs.readFile(path.join(config.sessionsDir, sessionId, "state.json")));
    Object.assign(config, { resume: sessionId, runtimePatch: { model: "deepseek-v4-pro" }, expectedRuntimeRevision: saved.meta.runtimeConfig.revision });
  }
  let outcome;
  try { outcome = { result: await runAgent(config) }; }
  catch (error) { outcome = { error: { name: error.name, code: error.code || "RUNTIME_ERROR", message: String(error.message).slice(0, 300) } }; }
  console.log(JSON.stringify({ ...outcome, order, aborted: controller.signal.aborted, externalModelCalls: 0 }));
} finally {
  Object.defineProperty(fs, "rename", rename); Object.defineProperty(fs, "open", open); Object.defineProperty(prototype, "sync", sync);
  globalThis.fetch = originalFetch; closeSessionIndexConnections();
}
