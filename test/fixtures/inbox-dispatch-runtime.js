import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";
import { SessionStore } from "../../src/session-store.js";

const [root, baseURL, sessionId, resume] = process.argv.slice(2);
const workspace = path.join(root, "workspace"), repo = fileURLToPath(new URL("../../", import.meta.url));
const fixture = JSON.parse(await fs.readFile(path.join(root, "fixture.json"), "utf8"));
const controller = new AbortController(), queuedIds = [];
const descriptor = Object.getOwnPropertyDescriptor(SessionStore.prototype, "appendEvent");
let hooked = false;
if (fixture.hook) Object.defineProperty(SessionStore.prototype, "appendEvent", { ...descriptor, value: async function (type, data) {
  const result = await Reflect.apply(descriptor.value, this, [type, data]);
  if (fixture.hook === "persist-error" && !resume && !hooked && type === "conversation.queued_input_applied") {
    hooked = true;
    throw new Error("Synthetic event acknowledgement failure");
  }
  if (!resume && !hooked && ((fixture.hook === "response" && type === "model.responded" && data.step === 2) ||
      (fixture.hook === "completion" && type === "completion.candidate_assessed") ||
      (fixture.hook === "read" && type === "tool.completed" && data.toolName === "read_file"))) {
    hooked = true;
    const inbox = new SessionStore(path.join(root, "sessions"), sessionId);
    queuedIds.push((await inbox.appendInbox(fixture.correction, { source: "offline-user", priority: "asap" })).id);
  }
  return result;
} });
const config = resolveRuntimeConfig({ provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code",
  goal: resume ? "Continue the same task." : fixture.goal || "Read note.txt and save a concise summary.md. Keep note.txt unchanged.",
  commandCwd: workspace, maxSteps: resume ? 5 : fixture.maxSteps || 7, dynamicSteps: "off" }, {
  baseDir: workspace, packageDir: repo, provider: "deepseek", model: "deepseek-flash", baseURL, apiKey: "synthetic-inbox-key", sessionId,
  enableScs: "off", sandboxMode: "host", packageInstallPolicy: "block", allowShellTool: false, allowFileTools: true,
  allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false,
  onConsole: () => {}, onLog: () => {},
});
Object.assign(config, { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  ...(resume ? { resume: sessionId } : {}), abortSignal: controller.signal,
  allowProviderHandoff: false, modelTimeoutMs: 5000, scsActive: false,
  routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash" });
try {
  const result = await runAgent(config);
  console.log(JSON.stringify({ ok: !result.stopped, ...result, queuedIds }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code || null, message: error.message }));
} finally { Object.defineProperty(SessionStore.prototype, "appendEvent", descriptor); closeSessionIndexConnections(); }
