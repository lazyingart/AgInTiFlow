import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { SessionStore } = await import(pathToFileURL(path.join(runtime, "src/session-store.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const [root, baseURL, mode, phase = "initial"] = process.argv.slice(2), originalFetch = globalThis.fetch;
const sessionId = "artifact-context-" + mode; let requests = 0, validationStarted = false;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== new URL(baseURL).origin) throw Error("OFFLINE_ARTIFACT_CONTEXT_NETWORK_ESCAPE");
  requests++; return Reflect.apply(originalFetch, globalThis, [input, options]);
};
const goal = phase === "resume" ? "Please confirm report.md is present, without editing any files."
  : mode === "long" ? "Create report.md with a detailed project status note. Leave unrelated files alone."
  : "Create report.md with a short project status note. Leave unrelated files alone.";
const model = phase === "resume" ? "deepseek-pro" : "deepseek-flash";
const config = resolveRuntimeConfig({ goal, provider: "deepseek", model, routingMode: "manual", taskProfile: "code",
  commandCwd: root + "/workspace", maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: runtime, sessionId, apiKey: "synthetic-artifact-context-key", baseURL,
  enableScs: "on", scsValidationMode: "deterministic", sandboxMode: "host", packageInstallPolicy: "block",
  allowFileTools: true, allowShellTool: false, allowDestructive: false, allowWrapperTools: false, allowAuxiliaryTools: false,
  allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole: () => {}, onLog: () => {},
  onEvent(type) {
    if (type === "artifact.validation_phase_started" && !validationStarted) {
      validationStarted = true;
      if (mode === "outside") { sync.unlinkSync(root + "/workspace/report.md"); sync.symlinkSync(root + "/excluded/data.txt", root + "/workspace/report.md"); }
    }
  },
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model,
  ...(phase === "resume" ? { resume: sessionId, expectedRuntimeRevision: 1, runtimePatch: {
    provider: "deepseek", model, routingMode: "manual", routeProvider: "deepseek", routeModel: model,
    mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model,
  } } : {}) });
let result = null, error = null, legacySeeded = false;
try {
  result = await runAgent(config);
  if (mode === "legacy-resume" && phase === "initial") {
    // Compatibility fixture: seed exactly the old automatic packet after a
    // real successful run, without pretending the current engine authored it.
    const store = new SessionStore(root + "/sessions", sessionId, { projectRoot: root + "/workspace", commandCwd: root + "/workspace", projectSessionsDir: root + "/pointers" });
    const state = await store.loadState();
    state.messages.push({ role: "user", content: "The exact output content is embedded below.\nEXCLUDED_SYNTHETIC_ARTIFACT_CANARY_TEAL" });
    Object.assign(state.meta.artifactProgress, { outputEmbedded: true, embeddedOutputPaths: ["report.md"] });
    delete state.meta.artifactProgress.contextVersion; delete state.meta.artifactProgress.contextDigest;
    await store.saveState(state); legacySeeded = true;
  }
} catch (value) { error = { code: value.code || "RUNTIME_ERROR", message: value.message }; }
finally { globalThis.fetch = originalFetch; closeSessionIndexConnections(); }
const state = JSON.parse(await fs.readFile(root + "/sessions/" + sessionId + "/state.json", "utf8"));
console.log(JSON.stringify({ result, error, validationStarted, requests, runtimeRevision: state.meta.runtimeConfig.revision, legacySeeded }));
