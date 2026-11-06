import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

const [root, baseURL, mode, phase] = process.argv.slice(2);
const sessionId = "file-publication-" + mode;
const nextText = "# Project Handoff\nOwner: Demo Team\nState: draft\n";
const sentinel = await fs.open(root + "/handle-sentinel", "wx");
const prototype = Object.getPrototypeOf(sentinel); await sentinel.close(); await fs.unlink(root + "/handle-sentinel");
const descriptor = Object.getOwnPropertyDescriptor(prototype, "writeFile");
let injected = false;
Object.defineProperty(prototype, "writeFile", { ...descriptor, value: async function (data, ...args) {
  if (phase === "start" && mode !== "normal" && !injected && Buffer.isBuffer(data) && data.equals(Buffer.from(nextText))) {
    injected = true; await Reflect.apply(descriptor.value, this, [data.subarray(0, 12), ...args]);
    throw Object.assign(new Error("Synthetic partial staged write"), { code: mode });
  }
  return Reflect.apply(descriptor.value, this, [data, ...args]);
} });
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  goal: phase === "resume" ? "Continue the same task." : "Fix the spelling mistake in note.txt. Keep the other lines unchanged.",
  commandCwd: root + "/workspace", maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: fileURLToPath(new URL("../../", import.meta.url)), sessionId,
  apiKey: "synthetic-publication-key", baseURL, enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block",
  allowFileTools: true, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false,
  allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole: () => {},
  onLog: (type, data) => {
    if (injected && type === "workspace.output" && data.toolName === "apply_patch" && data.ok === false) {
      throw Object.assign(new Error("Inspect failed native write before retry"), { code: "PAUSE_AFTER_FAILED_WRITE" });
    }
  },
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 5000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash",
  ...(phase === "resume" ? { resume: sessionId } : {}),
});
try { console.log(JSON.stringify({ injected, result: await runAgent(config) })); }
catch (error) { console.log(JSON.stringify({ injected, error: { code: error.code || "RUNTIME_ERROR", message: error.message } })); process.exitCode = 1; }
finally { Object.defineProperty(prototype, "writeFile", descriptor); closeSessionIndexConnections(); }
