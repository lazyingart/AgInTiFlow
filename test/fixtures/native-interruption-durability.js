import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { getEventListeners } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const [root, baseURL, specification, phase = "start"] = process.argv.slice(2);
const { stage, fault, errno = "EIO", artifact = false, late = false } = JSON.parse(specification);
const sessionId = "interruption-durability", statePath = path.join(root, "sessions", sessionId, "state.json"), eventsPath = path.join(root, "sessions", sessionId, "events.jsonl");
const controller = new AbortController(), ioError = Object.freeze(Object.assign(new Error("Synthetic owner-local storage failure"), { code: errno }));
const interruption = Object.freeze(Object.assign(new Error("Caller cancelled this invocation"), { code: "TEST_CALLER_CANCELLED" }));
const providerError = Object.freeze(Object.assign(new Error("Synthetic provider prerequisite unavailable"), { code: "PROVIDER_PREREQUISITE_MISSING" }));
const renameDescriptor = Object.getOwnPropertyDescriptor(fs, "rename"), appendDescriptor = Object.getOwnPropertyDescriptor(fs, "appendFile"), fetch0 = globalThis.fetch;
const delivered = [], consoleClaims = [], unhandled = [];let failures = 0, observation = null, outcome, error;
const expectedStatus = stage === "timeout" || stage === "preflight-failure" ? "failed" : "paused";
const capture = () => {
  if (observation) return;
  const state = JSON.parse(syncFs.readFileSync(statePath, "utf8"));
  observation = { durableStatus: state.meta.goalContract.status, leaseHeld: syncFs.existsSync(path.join(path.dirname(statePath), ".agent-run.lock")) };
};
const cancel = () => { capture();controller.abort(interruption); };
const onUnhandled = value => unhandled.push(value?.name || "rejection");process.on("unhandledRejection", onUnhandled);
Object.defineProperty(fs, "rename", { ...renameDescriptor, async value(from, to) {
  if (phase === "start" && to === statePath && fault.startsWith("state")) {
    const state = JSON.parse(await fs.readFile(from, "utf8"));
    if (state.meta?.goalContract?.status === expectedStatus) {
      capture();failures++;
      if (fault === "state-after-rename") await Reflect.apply(renameDescriptor.value, fs, [from, to]);
      throw ioError;
    }
  }
  return Reflect.apply(renameDescriptor.value, fs, [from, to]);
} });
Object.defineProperty(fs, "appendFile", { ...appendDescriptor, async value(file, bytes, ...args) {
  if (phase === "start" && fault === "event" && file === eventsPath && ["session.stopped", "session.failed"].includes(JSON.parse(String(bytes)).type)) { capture();failures++;throw ioError; }
  return Reflect.apply(appendDescriptor.value, fs, [file, bytes, ...args]);
} });
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== new URL(baseURL).origin) throw Error("OFFLINE_INTERRUPTION_NETWORK_ESCAPE");
  return Reflect.apply(fetch0, globalThis, [input, options]);
};
const model = phase === "resume" ? "deepseek-v4-pro" : "deepseek-flash";
const config = resolveRuntimeConfig({ provider: "deepseek", model, routingMode: "manual", taskProfile: "auto", executionTier: "focused",
  goal: phase === "resume" ? "Continue the same task." : artifact ? 'Make result.md containing just "confirmed" and tell me when it is saved.' : "Why did the earlier check fail? Please do not change any file.",
  commandCwd: path.join(root, "workspace"), maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: path.join(root, "workspace"), packageDir: runtime, sessionId, baseURL, apiKey: "synthetic-interruption-only", enableScs: "off",
  sandboxMode: "host", packageInstallPolicy: "block", permissionMode: "auto", allowDestructive: true,
  allowFileTools: artifact, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false,
  allowMcpTools: false, allowParallelScouts: false, onLog: () => {}, onConsole(value) {
    const text = typeof value === "string" ? value : "";
    if (/Session saved|I saved this request/.test(text)) consoleClaims.push(text);
  }, onEvent(type) {
    if (["session.stopped", "session.failed", "session.finished"].includes(type)) delivered.push({ type, durableStatus: JSON.parse(syncFs.readFileSync(statePath, "utf8")).meta.goalContract.status });
    if (phase === "start" && stage === "runtime" && type === (late ? "session.finished" : "completion.candidate_assessed")) cancel();
  },
});
Object.assign(config, { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), abortSignal: controller.signal,
  modelTimeoutMs: stage === "timeout" ? 300 : 4000, allowProviderHandoff: false,
  routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model,
  ...(phase === "resume" ? { resume: sessionId, expectedRuntimeRevision: 1, runtimePatch: { model, routeModel: model, mainModel: model, spareModel: model } } : {}),
  ...(phase === "start" && stage.startsWith("preflight") ? { clientFactory() { if (stage === "preflight") { cancel();throw interruption; } throw providerError; } } : {}),
});
try { outcome = await runAgent(config); }
catch (value) { error = { code: value.code || "", name: value.name, message: value.message, exactIoError: value === ioError }; }
finally {
  await new Promise(resolve => setImmediate(resolve));closeSessionIndexConnections();
  Object.defineProperty(fs, "rename", renameDescriptor);Object.defineProperty(fs, "appendFile", appendDescriptor);globalThis.fetch = fetch0;
  process.removeListener("unhandledRejection", onUnhandled);
}
console.log(JSON.stringify({ outcome, error, failures, observation, delivered, consoleClaims, unhandled: unhandled.length,
  abortListeners: getEventListeners(controller.signal, "abort").length, aborted: controller.signal.aborted, liveProviderCalls: 0 }));
