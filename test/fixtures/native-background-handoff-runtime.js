import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const [root, baseURL, scenario, runtimeDir] = process.argv.slice(2);
const source = runtimeDir || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(source, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(source, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(source, "src/session-index.js")));
process.umask(0o077);
const unhandled = [], originalFetch = globalThis.fetch;
const onUnhandled = value => unhandled.push(String(value)); process.on("unhandledRejection", onUnhandled);
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== new URL(baseURL).origin) throw Error("OFFLINE_HTTP_ESCAPE_REFUSED");
  return Reflect.apply(originalFetch, globalThis, [input, options]);
};
const goal = scenario === "compound"
  ? "Start the supplied export in the background and then write a separate note.md with the text handoff checked."
  : "Can you put the supplied export in the background and tell me where to check it? Keep the input and script as they are.";
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code", goal, commandCwd: root + "/workspace", maxSteps: scenario === "budget" ? 1 : 3, dynamicSteps: "off" },
  { baseDir: root + "/workspace", packageDir: source, sessionId: "native-background-handoff", apiKey: "synthetic-offline-key", baseURL,
    enableScs: "off", sandboxMode: "host", allowShellTool: true, allowFileTools: true, allowDestructive: true,
    packageInstallPolicy: "block", allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false,
    allowMcpTools: false, allowParallelScouts: false, onConsole: () => {} });
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash" });
try {
  const outcome = await runAgent(config); await new Promise(resolve => setImmediate(resolve));
  console.log(JSON.stringify({ outcome, unhandled: unhandled.length }));
} finally { closeSessionIndexConnections(); globalThis.fetch = originalFetch; process.removeListener("unhandledRejection", onUnhandled); }
