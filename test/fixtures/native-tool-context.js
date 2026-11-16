import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [root, baseURL, tier, mode, phase] = process.argv.slice(2);
const runtime = process.env.AGINTI_TEST_CONTEXT_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SESSION_TOOL_FAMILY_FIELDS } = await import(pathToFileURL(path.join(runtime, "src/session-runtime.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const original = globalThis.fetch, origin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  assert.equal(new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin, origin, "OFFLINE_CONTEXT_HTTP_ESCAPE");
  return Reflect.apply(original, globalThis, [input, init]);
};
try {
  const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-v4-flash", routingMode: "manual", taskProfile: mode === "writer" || mode === "eligible" ? "writing" : "auto",
    goal: phase === "start" ? "Give me a short three-item checklist for reviewing a draft here. Do not create or modify any file."
      : "Continue this exact conversation and give the same checklist in one short sentence here. No files or external tools.", commandCwd: path.join(root, "workspace") }, {
    baseDir: path.join(root, "workspace"), packageDir: runtime, apiKey: "synthetic-tool-context-key", baseURL,
    sessionId: "tool-context-" + mode + "-" + tier, enableScs: "off", sandboxMode: "host", allowFileTools: mode === "files" || mode.startsWith("image-"),
    allowShellTool: mode === "jobs" || mode === "tmux", allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false,
  });
  Object.assign(config, Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(k => [k, mode === "eligible" || mode === "narrow"])), {
    sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), executionTier: tier, scsActive: false,
    allowProviderHandoff: false, modelTimeoutMs: 1000, maxSteps: 3, dynamicSteps: "off", onConsole() {}, onLog() {},
  });
  if (mode === "jobs") Object.assign(config, { allowLongJobTools: true, allowBackgroundJobs: true });
  if (mode === "tmux") Object.assign(config, { allowTmuxTools: true, allowCoordinationTools: true });
  if (mode.startsWith("image-")) Object.assign(config, { allowImageTools: true, allowVisionTools: true,
    // Defaults cannot widen a saved false; an explicit CAS true must also win
    // over incoming false. Neither case executes perception.
    allowImagePerception: phase === "resume" && mode === "image-deny" });
  if (phase === "resume") Object.assign(config, { resume: config.sessionId, expectedRuntimeRevision: 1,
    runtimePatch: { model: "deepseek-v4-pro", ...(mode === "narrow" ? Object.fromEntries(SESSION_TOOL_FAMILY_FIELDS.map(k => [k, false])) : {}),
      ...(mode === "image-allow" ? { allowImagePerception: true } : {}) } });
  let outcome;
  try { outcome = { result: await runAgent(config) }; }
  catch (error) { outcome = { error: { code: error.code || "RUNTIME_ERROR", message: String(error.message).slice(0, 300) } }; }
  console.log(JSON.stringify(outcome));
} finally { globalThis.fetch = original; closeSessionIndexConnections(); }
