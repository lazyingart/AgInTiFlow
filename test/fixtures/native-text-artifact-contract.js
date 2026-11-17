import path from "node:path";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { SESSION_TOOL_FAMILY_FIELDS } from "../../src/session-runtime.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

const [root, baseURL, scs, mode, phase = "start"] = process.argv.slice(2), workspace = path.join(root, "workspace");
const requested = mode === "ascii" ? "out/review.md" : mode === "keyword" ? "out/build.md" : mode === "nfd" ? "out/cafe\u0301.md" : "out/café.md";
const goal = phase === "start" ? `${mode === "preserve" ? "out/a.csvとout/b.csvは変更しないでください。" : mode === "scope-required" ? "Read owner.txt first. " : mode === "scope-explicit" ? "List the workspace root first. " : ""}Please create ${requested} with a short release-review checklist covering build, tests, and rollback. Only create that file.${mode === "command" ? " Then run `node --version`." : ""}` : "Please continue from the saved checkpoint.";
const model = phase === "start" ? "deepseek-flash" : "deepseek-v4-pro";
const config = resolveRuntimeConfig({ goal, provider: "deepseek", model, taskProfile: "auto", routingMode: "manual", commandCwd: workspace }, {
  baseDir: workspace, commandCwd: workspace, sessionId: "text-artifact", packageDir: path.resolve(import.meta.dirname, "../.."), baseURL, apiKey: "synthetic-offline-text-artifact",
  enableScs: scs, scsValidationMode: "deterministic", sandboxMode: "host", packageInstallPolicy: "block", allowDestructive: true,
});
Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(field => [field, false])), {
  allowFileTools: true, allowShellTool: false, allowWebSearch: false, allowMcpTools: false, allowWrapperTools: false, allowAuxiliaryTools: false,
  sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), workspacePathScopeRoots: ["out"], workspaceWritePathScopeRoots: ["out"],
  routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model,
  allowProviderHandoff: false, dynamicSteps: "off", maxSteps: 4, modelTimeoutMs: 3000, onConsole() {}, onLog() {},
});
if (phase !== "start") Object.assign(config, { resume: "text-artifact", expectedRuntimeRevision: 1,
  runtimePatch: { model, routeModel: model, mainModel: model, spareModel: model, allowWebSearch: false, allowMcpTools: false, allowWrapperTools: false, allowAuxiliaryTools: false } });
const fetch0 = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin !== new URL(baseURL).origin) throw Error("TEXT_ARTIFACT_TEST_NETWORK_ESCAPE");
  return Reflect.apply(fetch0, globalThis, [input, init]);
};
try { console.log(JSON.stringify({ goal, requested, result: await runAgent(config) })); }
finally { globalThis.fetch = fetch0; closeSessionIndexConnections(); }
