import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

const [root, baseURL, mode, phase] = process.argv.slice(2), sessionId = "partial-patch-" + mode;
const fetchImpl = globalThis.fetch, offlineOrigin = new URL(baseURL).origin;
globalThis.fetch = (input, init) => {
  const actual = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (actual.origin !== offlineOrigin) throw new Error("OFFLINE_HTTP_ESCAPE_REFUSED");
  return Reflect.apply(fetchImpl, globalThis, [input, init]);
};
const handle = await fs.open(root + "/sentinel", "wx"), prototype = Object.getPrototypeOf(handle);
await handle.close(); await fs.unlink(root + "/sentinel");
const descriptor = Object.getOwnPropertyDescriptor(prototype, "writeFile"); let injected = false;
Object.defineProperty(prototype, "writeFile", { ...descriptor, value: async function (data, ...args) {
  if (phase === "start" && mode !== "normal" && !injected && Buffer.isBuffer(data) && data.equals(Buffer.from("# Review\n- Check the changes\n- Verify the result\n"))) {
    injected = true; await Reflect.apply(descriptor.value, this, [data.subarray(0, 12), ...args]);
    throw Object.assign(new Error("Synthetic partial-patch later-file write"), { code: mode === "local-handoff" ? "EIO" : mode });
  }
  return Reflect.apply(descriptor.value, this, [data, ...args]);
} });
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  goal: phase === "resume" ? "Continue the same task." : "Read README.md and add short planning.md and review.md checklists. Keep existing files as they are.",
  commandCwd: root + "/workspace", maxSteps: 6, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: fileURLToPath(new URL("../../", import.meta.url)), sessionId,
  apiKey: "synthetic-partial-patch-key", baseURL, enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block",
  allowFileTools: true, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false,
  allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole: () => {},
  onLog: (type, data) => {
    if (phase === "start" && injected && type === "workspace.output" && data.toolName === "apply_patch" && data.ok === false) {
      throw Object.assign(new Error("Inspect saved partial patch"), { code: "PAUSE_AFTER_PARTIAL_PATCH" });
    }
  },
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash",
  ...(phase === "resume" ? { resume: sessionId } : {}),
});
if (mode === "local-handoff" && phase === "resume") {
  const state = JSON.parse(await fs.readFile(root + "/sessions/" + sessionId + "/state.json"));
  Object.assign(config, { provider: "localllm", model: "localllm-fast",
    expectedRuntimeRevision: state.meta.runtimeConfig.revision,
    runtimePatch: { provider: "localllm", model: "localllm-fast", baseURL, routingMode: "manual",
      routeProvider: "localllm", routeModel: "localllm-fast", mainProvider: "localllm", mainModel: "localllm-fast", spareProvider: "localllm", spareModel: "localllm-fast" },
  });
}
try { const result = await runAgent(config); console.log(JSON.stringify({ injected, result })); }
catch (error) { console.log(JSON.stringify({ injected, error: { code: error.code || "RUNTIME_ERROR", message: error.message } })); process.exitCode = 1; }
finally { globalThis.fetch = fetchImpl; Object.defineProperty(prototype, "writeFile", descriptor); closeSessionIndexConnections(); }
