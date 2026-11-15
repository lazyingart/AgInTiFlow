import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const { runAgent } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(runtime, "src/session-index.js")));
const [root, baseURL, mode] = process.argv.slice(2), fetch = globalThis.fetch;
const source = path.join(root, "workspace/notes.md"), writerPayloads = [];
let receivingWriter = false, sourceAccessesDuringWriter = 0;
const descriptors = ["open", "readFile", "stat"].map(key => [key, Object.getOwnPropertyDescriptor(fs, key)]);
for (const [key, descriptor] of descriptors) fs[key] = (...args) => {
  if (receivingWriter && args[0] === source) sourceAccessesDuringWriter++;
  return Reflect.apply(descriptor.value, fs, args);
};
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== new URL(baseURL).origin) throw Error("OFFLINE_WRITER_NETWORK_ESCAPE");
  receivingWriter = false;
  const response = await Reflect.apply(fetch, globalThis, [input, options]);
  const body = await response.clone().json();
  receivingWriter = body.choices?.[0]?.message?.tool_calls?.some(call => call.function.name === "writing_specialist") === true;
  return response;
};
const goal = "Write a short article in the reply using only notes.md. Leave the source unchanged.";
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "writing", goal, commandCwd: root + "/workspace", maxSteps: 6, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: runtime, sessionId: "writer-boundary-" + mode, apiKey: "synthetic-writer-boundary-key", baseURL,
  enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: false, allowDestructive: false,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole: () => {},
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowHostedWritingSpecialist: false, allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash",
  writingClientFactory: () => ({ chat: { completions: { async create(body) {
    writerPayloads.push(body);
    return { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ draft: "The orchard trial used eight samples, according to the supplied source." }) } }] };
  } } } }),
});
let result = null, error = null;
try { result = await runAgent(config); }
catch (value) { error = { code: value.code || "RUNTIME_ERROR", message: value.message }; }
finally {
  globalThis.fetch = fetch;
  for (const [key, descriptor] of descriptors) Object.defineProperty(fs, key, descriptor);
  closeSessionIndexConnections();
}
console.log(JSON.stringify({ result, error, writerPayloads, sourceAccessesDuringWriter }));
