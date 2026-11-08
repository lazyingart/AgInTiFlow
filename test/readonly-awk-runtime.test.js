import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const scs of [false, true]) {
  test(`native AWK inspection, completed replay and unsafe follow-up (SCS ${scs})`, { timeout: 25000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-awk-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const source = "value\n2\n4\n9\n";
    await fs.writeFile(path.join(workspace, "values.csv"), source);
    const before = await fs.stat(path.join(workspace, "values.csv"), { bigint: true });
    const { runAgent } = await import("../src/agent-runner.js");
    const { resolveRuntimeConfig } = await import("../src/config.js");
    const { closeSessionIndexConnections } = await import("../src/session-index.js");
    const previousHome = process.env.AGINTIFLOW_HOME, originalFetch = globalThis.fetch;
    process.env.AGINTIFLOW_HOME = path.join(root, "home");
    let requests = 0, phase = "start", read = false, command = false;
    const inspection = "awk 'NR>1{n++;s+=$1} END{printf \"count=%d mean=%.2f\\n\",n,s/n}' values.csv";
    globalThis.fetch = async (url, init) => {
      assert.notEqual(phase, "completed", "Completed replay must not redispatch");
      assert.equal(new URL(url).href, "https://offline.invalid/v1/chat/completions");
      requests++;
      const body = JSON.parse(init.body);
      const call = (name, args) => ({ role: "assistant", content: null, tool_calls: [{
        id: `awk_${requests}`, type: "function", function: { name, arguments: JSON.stringify(args) },
      }] });
      let message;
      if (!body.tools) message = { role: "assistant", content: "Inspect the supplied values and report the verified count and mean." };
      else if (!body.tools.some(tool => tool.function.name === "read_file") && body.tools.some(tool => tool.function.name === "inspect_project")) message = call("inspect_project", {});
      else if (!read) { read = true; message = call("read_file", { path: "values.csv" }); }
      else if (!command) {
        command = true;
        message = call("run_command", { command: phase === "unsafe" ? "awk -f external.awk values.csv" : inspection });
      } else message = call("finish", { result: "Verified count: 3; mean: 5.00. values.csv is unchanged." });
      return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    try {
      const config = resolveRuntimeConfig({ goal: "Check the count and mean in values.csv using awk. Leave the source unchanged.", provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code", commandCwd: workspace, maxSteps: 6, dynamicSteps: "off" }, {
        baseDir: workspace, packageDir: path.resolve(import.meta.dirname, ".."), sessionId: "readonly-awk", apiKey: "synthetic-offline-key", baseURL: "https://offline.invalid/v1",
        sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: true, allowWrapperTools: false, allowAuxiliaryTools: false,
        allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, onConsole() {}, onLog() {}, onEvent() {},
      });
      Object.assign(config, {
        sessionsDir: root + "/sessions", projectSessionsDir: root + "/pointers", enableScs: scs ? "on" : "off", scsActive: scs, scsValidationMode: "deterministic",
        allowProviderHandoff: false, modelTimeoutMs: 5000, routeProvider: "deepseek", routeModel: "deepseek-flash", mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash",
      });
      const first = await runAgent(config);
      assert.equal(first.goalStatus, "completed");
      const eventPath = root + "/sessions/readonly-awk/events.jsonl";
      const loadEvents = async () => (await fs.readFile(eventPath, "utf8")).trim().split("\n").map(JSON.parse);
      const events = await loadEvents();
      const observed = events.filter(e => e.type === "tool.completed" && e.data.toolName === "run_command");
      assert.equal(observed.length, 1);
      assert.equal(observed[0].data.args.command, inspection);
      assert.equal(observed[0].data.exitCode, 0);
      assert.match(observed[0].data.stdout, /count=3 mean=5\.00/);
      assert.equal(observed[0].data.commandPolicy.category, "read-only");
      assert.equal(observed[0].data.commandPolicy.writesWorkspace, false);
      assert.equal(events.some(e => e.type === "file.changed"), false);
      phase = "completed";
      const beforeRequests = requests;
      const completed = await runAgent({ ...config, resume: "readonly-awk", expectedRuntimeRevision: 1, goal: "Continue the same task." });
      assert.equal(completed.goalStatus, "completed");
      assert.equal(requests, beforeRequests);
      phase = "unsafe"; read = false; command = false;
      const denied = await runAgent({ ...config, resume: "readonly-awk", expectedRuntimeRevision: 1, goal: "Now run the external awk program external.awk on values.csv. Do not grant extra permissions." });
      assert.equal(denied.goalStatus, "paused"); assert.equal(denied.reason, "permission_required");
      const finalEvents = await loadEvents();
      assert.equal(finalEvents.filter(e => e.type === "tool.completed" && e.data.toolName === "run_command").length, 1);
      assert.ok(finalEvents.some(e => e.type === "tool.blocked" && e.data.args.command === "awk -f external.awk values.csv"));
      const state = JSON.parse(await fs.readFile(root + "/sessions/readonly-awk/state.json"));
      assert.equal(state.meta.runtimeConfig.revision, 1);
      assert.equal(state.meta.runtimeConfig.allowDestructive, false);
      assert.equal(state.meta.runtimeConfig.packageInstallPolicy, "block");
      assert.equal(await fs.readFile(path.join(workspace, "values.csv"), "utf8"), source);
      const after = await fs.stat(path.join(workspace, "values.csv"), { bigint: true });
      for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) assert.equal(after[key], before[key]);
      // Native bookkeeping may create .aginti; no task output may be created.
      assert.deepEqual((await fs.readdir(workspace)).filter(name => name !== ".aginti"), ["values.csv"]);
      assert.equal(finalEvents.some(e => e.type === "file.changed"), false);
      await assert.rejects(fs.stat(root + "/sessions/readonly-awk/.agent-run.lock"), { code: "ENOENT" });
    } finally {
      globalThis.fetch = originalFetch; closeSessionIndexConnections();
      if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
