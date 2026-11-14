import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [root, baseURL, phase] = process.argv.slice(2);
const source = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(source, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(source, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(source, "src/session-index.js")));
const workspace = path.join(root, "workspace"), model = phase === "initial" ? "deepseek-flash" : "deepseek-v4-pro";
const sessionId = "native-quoted-credential";
const config = resolveRuntimeConfig({ provider: "deepseek", model, routingMode: "manual", enableScs: "off",
  goal: "Please read notes/current.json and tell me the current status, leaving files alone.", maxSteps: 4, dynamicSteps: "off" }, {
  baseDir: workspace, commandCwd: workspace, packageDir: source, provider: "deepseek", model, baseURL,
  apiKey: "synthetic-loopback-model-key", sessionId, sandboxMode: "host", allowFileTools: true, allowShellTool: false,
  allowWebSearch: false, allowWrapperTools: false, allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false,
});
Object.assign(config, { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  ...(phase === "resume" ? { resume: sessionId } : {}), allowProviderHandoff: false, modelTimeoutMs: 5000,
  scsActive: false, quiet: true, routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model,
  spareProvider: "deepseek", spareModel: model, executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline credential boundary" },
});
if (phase === "resume") {
  const prior = JSON.parse(await fs.readFile(path.join(root, "sessions", sessionId, "state.json"), "utf8"));
  config.expectedRuntimeRevision = prior.meta.runtimeConfig.revision;
  config.runtimePatch = { provider: "deepseek", model, routeProvider: "deepseek", routeModel: model,
    mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model };
}
try {
  const result = await runAgent(config);
  assert.equal(result.sessionId, sessionId);
  console.log(JSON.stringify({ sessionId, stopped: Boolean(result.stopped), result: result.result || null, model }));
} finally { closeSessionIndexConnections(); }
