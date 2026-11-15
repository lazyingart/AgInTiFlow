import fs from "node:fs";
import { getEventListeners } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(runtime + "/src/agent-runner.js"));
const { resolveRuntimeConfig } = await import(pathToFileURL(runtime + "/src/config.js"));
const { SessionStore } = await import(pathToFileURL(runtime + "/src/session-store.js"));
const { closeSessionIndexConnections } = await import(pathToFileURL(runtime + "/src/session-index.js"));
const [root, baseURL, scenario, phase = "start"] = process.argv.slice(2);
const [boundary, validation, completion] = scenario.split(":"), id = "precompletion-cancellation";
const controller = new AbortController(), unhandled = [], fetch0 = globalThis.fetch;
const rejection = error => unhandled.push(error?.name || "rejection");process.on("unhandledRejection", rejection);
let observation = null, inboxArmed = false;
const capture = () => {
  const state = JSON.parse(fs.readFileSync(root + "/sessions/" + id + "/state.json", "utf8"));
  const events = fs.readFileSync(root + "/sessions/" + id + "/events.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  observation = { goalStatus: state.meta.goalContract.status, finishedEvents: events.filter(e => e.type === "session.finished").length,
    leasePresent: fs.existsSync(root + "/sessions/" + id + "/.agent-run.lock"), eventCount: events.length };
};
const cancel = () => {
  if (observation || phase === "resume") return;
  capture();
  const reason = Object.assign(new Error("User cancelled this invocation"), { code: "insufficient_quota", status: 429 });
  controller.abort(Object.freeze(reason));
};
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== new URL(baseURL).origin) throw Error("OFFLINE_PRECOMPLETION_NETWORK_ESCAPE");
  return Reflect.apply(fetch0, globalThis, [input, options]);
};
const drain = Object.getOwnPropertyDescriptor(SessionStore.prototype, "drainInbox");
if (boundary === "inbox") Object.defineProperty(SessionStore.prototype, "drainInbox", { ...drain, value(...args) {
  return Reflect.apply(drain.value, this, args).then(items => {
    if (inboxArmed && this.sessionId === id) { inboxArmed = false;cancel(); }
    return items;
  });
} });
const onMessage = message => { if (message?.action === "cancel") cancel(); };
process.on("message", onMessage);
const responseRequest = 'Explain briefly why a cancelled task should stop. Return strict JSON: {"reply":"a short explanation"}.';
const goal = phase === "resume" ? "Continue the same task." : boundary === "files"
  ? 'Make result.md containing just "confirmed" and tell me when it is saved.'
  : boundary === "response-repair" || completion === "response"
    ? responseRequest + "\nAGINTI_EVIDENCE_SCOPE_JSON: " + JSON.stringify({ mode: "chat-response", request: responseRequest })
    : "Why did the previous check fail? Do not run or modify any file.";
const scs = ["review", "inbox", "reject", "files", "post", "inflight"].includes(boundary) && completion !== "response";
const model = phase === "resume" ? "deepseek-v4-pro" : "deepseek-flash";
const config = resolveRuntimeConfig({ provider: "deepseek", model, routingMode: "manual", taskProfile: "auto", executionTier: "focused",
  goal, commandCwd: root + "/workspace", maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: runtime, sessionId: id, apiKey: "synthetic-precompletion-only", baseURL,
  enableScs: scs ? "on" : "off", sandboxMode: "host", packageInstallPolicy: "block", permissionMode: "auto", allowDestructive: true,
  allowFileTools: boundary === "files", allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false,
  allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole: () => {}, onLog: () => {},
  onEvent(type) {
    if (phase === "resume") return;
    const verdict = type === "scs.student.finish_allowed" || type === "scs.student.finish_rejected";
    if (boundary === "inbox" && verdict) inboxArmed = true;
    else if (["review", "reject", "files"].includes(boundary) && verdict ||
        boundary === "assessed" && type === "completion.candidate_assessed" ||
        boundary === "model" && type === "model.responded" ||
        boundary === "response-repair" && type === "response_only.output_contract_repaired" ||
        boundary === "post" && type === "session.finished") cancel();
  },
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", abortSignal: controller.signal,
  scsValidationMode: validation, modelTimeoutMs: 4000, allowProviderHandoff: true,
  routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model,
  ...(phase === "resume" ? { resume: id, expectedRuntimeRevision: 1, runtimePatch: { model, routeModel: model, mainModel: model, spareModel: model } } : {}),
});
let outcome, error;
try { outcome = await runAgent(config); }
catch (e) { error = { name: e.name, code: e.code || "ERROR", message: e.message }; }
finally {
  await new Promise(resolve => setImmediate(resolve));closeSessionIndexConnections();
  globalThis.fetch = fetch0;Object.defineProperty(SessionStore.prototype, "drainInbox", drain);
  process.removeListener("message", onMessage);process.removeListener("unhandledRejection", rejection);
}
const finalEvents = fs.readFileSync(root + "/sessions/" + id + "/events.jsonl", "utf8").trim().split("\n").map(JSON.parse);
console.log(JSON.stringify({ outcome, error, observation, aborted: controller.signal.aborted, unhandled: unhandled.length,
  eventsAfterCancellation: observation ? finalEvents.slice(observation.eventCount).map(e => e.type) : [],
  abortListeners: getEventListeners(controller.signal, "abort").length, externalModelCalls: 0 }));
process.disconnect?.();
