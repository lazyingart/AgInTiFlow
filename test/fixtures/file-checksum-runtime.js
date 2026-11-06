import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

const [root, baseURL, mode, phase = "start"] = process.argv.slice(2), sessionId = "checksum-" + mode;
const goal = mode.startsWith("cn") ? "读取 note.txt，报告它的 SHA-256。不要修改文件。"
  : mode.startsWith("jp") ? "note.txt を読み、SHA-256 を報告してください。ファイルを変更しないでください。"
  : mode.startsWith("abbreviation") ? "Read note.txt and briefly explain it. Do not create or modify any files."
  : "Read note.txt and report its full SHA-256. Keep the file unchanged.";
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  goal: phase === "resume" ? "Continue the same task." : goal, commandCwd: root + "/workspace", maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: root + "/workspace", packageDir: fileURLToPath(new URL("../../", import.meta.url)), sessionId,
  apiKey: "synthetic-checksum-key", baseURL, enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true,
  allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false,
  allowParallelScouts: false, onConsole: () => {}, onLog: (type, data) => {
    if (mode === "resume" && phase === "start" && type === "workspace.output" && data.toolName === "read_file" && data.ok) {
      throw Object.assign(new Error("Synthetic interruption after durable native read receipt"), { code: "PAUSE_AFTER_READ" });
    }
  },
});
Object.assign(config, { sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", allowProviderHandoff: false, modelTimeoutMs: 4000,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash",
  ...(phase === "resume" ? { resume: sessionId } : {}) });
try { console.log(JSON.stringify(await runAgent(config))); }
catch (error) { console.log(JSON.stringify({ errorCode: error.code || "RUNTIME_ERROR", error: error.message })); process.exitCode = 1; }
finally { closeSessionIndexConnections(); }
