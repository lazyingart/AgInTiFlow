import path from "node:path";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { SESSION_TOOL_FAMILY_FIELDS } from "../../src/session-runtime.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";
const [root, baseURL, scs, phase = "start", mode = "regular", expectedRevision = "1"] = process.argv.slice(2), workspace = path.join(root, "workspace");
const fetch0 = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin !== new URL(baseURL).origin) throw Error("OBSERVATION_TEST_NETWORK_ESCAPE");
  return Reflect.apply(fetch0, globalThis, [input, init]);
};
const model = phase === "start" ? "deepseek-flash" : "deepseek-v4-pro";
const goal = phase === "repair" ? "Run `node --test test/cache.test.mjs` once and report its actual result. Do not create or modify files."
  : mode === "git-saved-evidence" && phase !== "start" ? "From the saved results, what is verified and what is not established about file changes? Please do not rerun anything or change files."
  : mode.includes("legacy") ? phase === "start" ? "Run `node --test test/cache.test.mjs` once and report its actual result. Do not create or modify files." : "Please continue from the saved checkpoint."
  : phase === "start" ? "Please run `node tools/refresh-cache.mjs` once and tell me the observed outcome." : "What does the saved result establish? Do not rerun anything.";
const config = resolveRuntimeConfig({ goal, provider: "deepseek", model, taskProfile: "auto", routingMode: "manual", commandCwd: workspace }, {
  baseDir: workspace, commandCwd: workspace, sessionId: "observation", packageDir: path.resolve(import.meta.dirname, "../.."), baseURL, apiKey: "synthetic-offline-observation",
  enableScs: scs, scsValidationMode: "deterministic", sandboxMode: "host", packageInstallPolicy: "block", allowDestructive: true,
});
Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(f => [f, false])), { allowShellTool: true, sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model,
  allowProviderHandoff: false, dynamicSteps: "off", maxSteps: 4, modelTimeoutMs: 3000, onConsole() {}, onLog() {},
});
if (phase !== "start") Object.assign(config, { resume: "observation", expectedRuntimeRevision: Number(expectedRevision), runtimePatch: { model, routeModel: model, mainModel: model, spareModel: model } });
try { console.log(JSON.stringify({ result: await runAgent(config) })); }
finally { globalThis.fetch = fetch0; closeSessionIndexConnections(); }
