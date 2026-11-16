import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, baseURL, scenario, phase] = process.argv.slice(2);
const runtime = process.env.AGINTI_TEST_TEXT_TURN_RUNTIME || new URL("../../", import.meta.url).pathname;
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SESSION_TOOL_FAMILY_FIELDS } = await import(pathToFileURL(path.join(runtime, "src/session-runtime.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const fetch = globalThis.fetch, origin = new URL(baseURL).origin, workspace = path.join(root, "workspace"), sessionId = "text-turn-" + scenario;
globalThis.fetch = (input, init) => {
  const address = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (address.origin !== origin) throw new Error("OFFLINE_TEXT_TURN_HTTP_ESCAPE");
  return Reflect.apply(fetch, globalThis, [input, init]);
};
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-v4-flash", routingMode: "manual", taskProfile: "code", commandCwd: workspace,
  goal: phase === "resume" ? "Please continue the same summary task." : "Read note.txt and save a concise summary.md. Leave note.txt unchanged." },
{ baseDir: workspace, packageDir: runtime, sessionId, baseURL, apiKey: "synthetic-text-turn-key", allowFileTools: true, allowShellTool: false,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, sandboxMode: "host", enableScs: "off" });
Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(k => [k, false])), { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  allowProviderHandoff: false, executionTier: "focused", dynamicSteps: "off", maxSteps: 8, modelTimeoutMs: 2000, onConsole() {}, onLog() {} });
if (phase === "resume") {
  const saved = JSON.parse(await fs.readFile(path.join(config.sessionsDir, sessionId, "state.json")));
  Object.assign(config, { resume: sessionId, expectedRuntimeRevision: saved.meta.runtimeConfig.revision, runtimePatch: { model: "deepseek-v4-pro" } });
}
try {
  let outcome;
  try { outcome = { result: await runAgent(config) }; }
  catch (error) { outcome = { error: { code: error.code || "RUNTIME_ERROR", message: String(error.message).slice(0, 300) } }; }
  console.log(JSON.stringify({ ...outcome, externalModelCalls: 0 }));
} finally { globalThis.fetch = fetch; closeSessionIndexConnections(); }
