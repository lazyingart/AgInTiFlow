import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

const [root, baseURL, jobId, mode] = process.argv.slice(2), originalFetch = globalThis.fetch;
const origin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== origin) throw new Error("OFFLINE_HTTP_ESCAPE_REFUSED");
  return Reflect.apply(originalFetch, globalThis, [input, init]);
};
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  goal: `Can you check whether background job ${jobId} finished? Just read its recorded status; do not start or stop any work.`,
  commandCwd: root + "/workspace", maxSteps: 3, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: fileURLToPath(new URL("../../", import.meta.url)),
  sessionId: "job-metadata-" + mode, apiKey: "synthetic-job-metadata-key", baseURL,
  enableScs: "off", sandboxMode: "host", allowShellTool: true, allowDestructive: false, allowFileTools: true,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false,
  allowParallelScouts: false, onConsole: () => {},
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers",
  allowProviderHandoff: false, modelTimeoutMs: 5000, routeProvider: "deepseek", routeModel: "deepseek-flash",
  mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash" });
try { console.log(JSON.stringify(await runAgent(config))); }
catch (error) { console.log(JSON.stringify({ error: { code: error.code || "RUNTIME_ERROR", message: error.message } })); process.exitCode = 1; }
finally { globalThis.fetch = originalFetch; closeSessionIndexConnections(); }
