import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const [root, baseURL, phase] = process.argv.slice(2);
const source = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(source, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(source, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(source, "src/session-index.js")));
const workspace = path.join(root, "workspace"), sessionId = "native-patch-line-endings";
const model = phase === "initial" ? "deepseek-flash" : "deepseek-v4-pro";
const goal = phase === "initial" ? "Please fix the two typos in handoff.md; leave the rest alone."
  : "Review is now ready. Set the status block to Status: ready and Review: requested; keep everything else.";
const config = resolveRuntimeConfig({ provider: "deepseek", model, routingMode: "manual", enableScs: "off", goal,
  maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: workspace, commandCwd: workspace, packageDir: source, provider: "deepseek", model, baseURL,
  apiKey: "synthetic-loopback-key", sessionId, sandboxMode: "host", allowFileTools: true, allowShellTool: false,
  allowWebSearch: false, allowWrapperTools: false, allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false,
});
Object.assign(config, { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  ...(phase === "resume" ? { resume: sessionId } : {}), allowProviderHandoff: false, modelTimeoutMs: 5000,
  scsActive: false, quiet: true, routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model,
  spareProvider: "deepseek", spareModel: model, executionPolicy: { tier: "focused", requiresPlan: false, reason: "Bounded two-line file edit" },
});
if (phase === "resume") {
  const state = JSON.parse(await fs.readFile(path.join(root, "sessions", sessionId, "state.json"), "utf8"));
  config.expectedRuntimeRevision = state.meta.runtimeConfig.revision;
  config.runtimePatch = { provider: "deepseek", model, routeProvider: "deepseek", routeModel: model,
    mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model };
}
try { console.log(JSON.stringify({ sessionId, model, result: await runAgent(config) })); }
finally { closeSessionIndexConnections(); }
