import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { projectPaths } from "../../src/project.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

globalThis.fetch = () => Promise.reject(Error("OFFLINE_NETWORK_REFUSED"));
const root = process.argv[2], paths = projectPaths(root);
const config = resolveRuntimeConfig({ provider: "mock", model: "mock-agent", routingMode: "manual", taskProfile: "code",
  goal: "Create notes/seed.md with a short message.", commandCwd: root, maxSteps: 5, dynamicSteps: "off" }, {
  baseDir: root, packageDir: fileURLToPath(new URL("../../", import.meta.url)), sessionId: "cli-startup-input",
  enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true,
  allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowMcpTools: false,
  allowWebSearch: false, allowParallelScouts: false, onConsole() {},
});
Object.assign(config, { sessionsDir: paths.globalSessionsDir, projectSessionsDir: paths.sessionsDir,
  allowProviderHandoff: false, routeProvider: "mock", routeModel: "mock-agent", mainProvider: "mock", mainModel: "mock-agent", spareProvider: "mock", spareModel: "mock-agent" });
try {
  const result = await runAgent(config);
  if (result.stopped) throw Error("Mock seed did not complete");
  await fs.writeFile(root + "/seed.json", JSON.stringify({ sessionId: result.sessionId, dir: paths.globalSessionsDir + "/" + result.sessionId }));
} finally {
  closeSessionIndexConnections();
}
