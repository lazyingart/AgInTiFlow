import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

const [root, baseURL, sessionId, resume] = process.argv.slice(2);
const repo = fileURLToPath(new URL("../../", import.meta.url));
process.env.AGINTIFLOW_HOME = path.join(root, "home");
process.env.AGINTIFLOW_NO_AUTO_UPDATE = "1";
process.env.AGINTIFLOW_NO_WEB_AUTO_START = "1";
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  goal: resume ? "Please continue the same summary task; keep the input intact." : "Read note.txt and save a concise summary.md. Keep note.txt unchanged.",
  commandCwd: workspace, maxSteps: 8, dynamicSteps: "off" }, {
  baseDir: workspace, packageDir: repo, provider: "deepseek", model: "deepseek-flash", baseURL, apiKey: "synthetic-response-runtime-key",
  sessionId, enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block", allowShellTool: false, allowFileTools: true,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false,
  onConsole: () => {}, onLog: () => {},
});
Object.assign(config, { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  ...(resume ? { resume: sessionId } : {}), allowProviderHandoff: false, modelTimeoutMs: 5000, scsActive: false,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash" });
try {
  const result = await runAgent(config);
  console.log(JSON.stringify({ ok: !result.stopped, sessionId: result.sessionId, result: result.result, reason: result.reason || null }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, status: error.status }));
} finally { closeSessionIndexConnections(); }
