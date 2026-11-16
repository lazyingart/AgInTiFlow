import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const [root, baseURL, mode, phase] = process.argv.slice(2);
const runtime = process.env.AGINTI_TEST_STALE_RUNTIME || new URL("../../", import.meta.url).pathname;
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SESSION_TOOL_FAMILY_FIELDS } = await import(pathToFileURL(path.join(runtime, "src/session-runtime.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const fetch = globalThis.fetch, origin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  assert.equal(new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin, origin);
  return Reflect.apply(fetch, globalThis, [input, init]);
};
let changes = 0;
const workspace = path.join(root, "workspace");
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-v4-flash", routingMode: "manual", taskProfile: "writing",
  goal: phase === "resume" ? "Continue the same task." : "Read draft.md, then rewrite its opening heading as Release checklist. Keep every other line exactly as it is.", commandCwd: workspace },
{ baseDir: workspace, packageDir: runtime, sessionId: "stale-source", apiKey: "synthetic-stale-source-key", baseURL,
  allowFileTools: true, allowShellTool: false, allowWebSearch: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowMcpTools: false, allowParallelScouts: false,
  enableScs: "off", sandboxMode: "host" });
Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(k => [k, false])), {
  sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), executionTier: "focused", allowProviderHandoff: false,
  dynamicSteps: "off", maxSteps: mode.startsWith("paused") && phase === "start" ? 2 : 9, modelTimeoutMs: 1500, onConsole() {}, onLog() {},
  onEvent(type, data) {
    if (phase === "start" && mode !== "unchanged" && type === "tool.completed" && data.toolName === "read_file" && data.path === "draft.md" && changes < (mode === "twice" ? 2 : 1)) {
      changes++; fs.appendFileSync(path.join(workspace, "draft.md"), "\nOwner note " + changes + " must remain.\n");
    }
  },
});
if (phase === "resume") Object.assign(config, { resume: config.sessionId, expectedRuntimeRevision: 1, runtimePatch: { model: "deepseek-v4-pro", maxSteps: 9 } });
try {
  let outcome; try { outcome = { result: await runAgent(config) }; }
  catch (error) { outcome = { error: { code: error.code || "RUNTIME_ERROR", message: String(error.message).slice(0, 300) } }; }
  console.log(JSON.stringify({ ...outcome, changes, externalModelCalls: 0 }));
} finally { globalThis.fetch = fetch; closeSessionIndexConnections(); }
