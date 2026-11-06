import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { SessionStore } from "../../src/session-store.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

const [root, baseURL, mode, phase] = process.argv.slice(2), sessionId = "tool-checkpoint-" + mode;
const save = Object.getOwnPropertyDescriptor(SessionStore.prototype, "saveState");
let failed = false;
if (mode === "save-error" && phase === "start") Object.defineProperty(SessionStore.prototype, "saveState", { ...save, value: function (state) {
  if (!failed && state.messages?.some(m => m.role === "tool" && m.tool_call_id === "checkpoint_write")) {
    failed = true;
    const error = new Error("Synthetic completed-batch checkpoint EIO"); error.code = "EIO";
    return Promise.reject(error);
  }
  return Reflect.apply(save.value, this, [state]);
} });
const workspace = root + "/workspace";
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  goal: phase === "resume" ? "Continue the same task." : mode === "read-batch" ? "Read note.txt and other.txt and explain both without changing files." : "Read note.txt and save a concise summary.md. Keep note.txt unchanged.",
  commandCwd: workspace, maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: workspace, packageDir: fileURLToPath(new URL("../../", import.meta.url)), sessionId, apiKey: "synthetic-checkpoint-key", baseURL,
  enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: false,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false,
  onConsole: () => {}, onLog: (type, data) => {
    if (phase !== "start" || type !== "workspace.output" || !data.ok) return;
    const target = mode === "read-batch" ? data.toolName === "read_file" && data.args?.path === "other.txt" : ["write_file", "apply_patch"].includes(data.toolName);
    if (!target) return;
    fs.writeFileSync(root + "/post-result-callback.json", JSON.stringify({ toolName: data.toolName, ok: data.ok }));
    if (["crash", "read-batch"].includes(mode)) process.kill(process.pid, "SIGKILL");
    if (mode === "callback-error") throw new Error("Synthetic post-result callback failure");
  },
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash",
  ...(phase === "resume" ? { resume: sessionId } : {}),
});
try { console.log(JSON.stringify(await runAgent(config))); }
catch (error) { console.log(JSON.stringify({ error: { code: error.code || "RUNTIME_ERROR", message: error.message } })); process.exitCode = 1; }
finally { Object.defineProperty(SessionStore.prototype, "saveState", save); closeSessionIndexConnections(); }
