import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";

for (const mode of ["ordinary", "outside", "ordinary-existing", "outside-existing"]) test(`actual native failed-test recovery preserves source authority: ${mode}`, { timeout: 40000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-recovery-native-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  await fs.mkdir(root + "/workspace"); await fs.mkdir(root + "/excluded");
  const marker = "EXCLUDED_SYNTHETIC_NATIVE_RECOVERY_VIOLET";
  await fs.writeFile(root + "/excluded/private.py", `# ${marker}\n`);
  const ordinary = mode.startsWith("ordinary"), existing = mode.endsWith("-existing");
  const check = ordinary
    ? "import unittest\nfrom module import compute\nclass ComputeTest(unittest.TestCase):\n    def test_increment(self):\n        self.assertEqual(compute(1), 3)\n"
    : "import unittest\nfrom pathlib import Path\nclass ComputeTest(unittest.TestCase):\n    def test_binding(self):\n        self.assertFalse(Path('module.py').is_symlink(), 'source binding changed')\n";
  await fs.writeFile(root + "/workspace/test_compute.py", check);
  if (existing) await fs.writeFile(root + "/workspace/module.py", "def compute(value):\n    return value + 0\n");
  let stage = 0, toolTurns = 0, replaced = false, repairRead = false;
  const bodies = [], offered = [], errors = [];
  const call = (name, args) => ({ role: "assistant", content: null, tool_calls: [{ id: `recovery_${++toolTurns}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); bodies.push(body);
      const tools = (body.tools || []).map(tool => tool.function.name); offered.push(tools);
      const readPath = () => {
        const property = body.tools.find(tool => tool.function.name === "read_file")?.function.parameters?.properties?.path;
        return property?.const || property?.enum?.[0] || "test_compute.py";
      };
      let message;
      if (!body.tools) message = { role: "assistant", content: "Create the function, check it and repair the observed failure without changing unrelated files." };
      else if (stage === 0 && tools.includes("read_file") && !tools.includes("write_file") && !tools.includes("apply_patch")) message = call("read_file", { path: readPath() });
      else if (stage === 0) {
        stage++;
        message = existing
          ? call("apply_patch", { path: "module.py", search: "    return value + 0", replace: "    return value + 1" })
          : tools.includes("write_file")
          ? call("write_file", { path: "module.py", content: "def compute(value):\n    return value + 1\n" })
          : call("apply_patch", { patch: "*** Begin Patch\n*** Add File: module.py\n+def compute(value):\n+    return value + 1\n*** End Patch" });
      }
      else if (stage === 1) {
        stage++;
        if (!ordinary) { await fs.unlink(root + "/workspace/module.py"); await fs.symlink(root + "/excluded/private.py", root + "/workspace/module.py"); replaced = true; }
        message = call("run_command", { command: "python3 -m unittest -v test_compute.py" });
      } else if (!ordinary) message = call("finish", { result: "The test failed because module.py became a symlink outside the permitted workspace. Repair remains blocked; I have not fixed or verified the function." });
      else if (stage === 2 && !tools.includes("apply_patch") && tools.includes("read_file") && !repairRead) {
        repairRead = true; message = call("read_file", { path: readPath() });
      } else if (stage === 2) {
        stage++; message = call("apply_patch", { path: "module.py", search: "    return value + 1", replace: "    return value + 2" });
      } else if (stage === 3) { stage++; message = call("run_command", { command: "python3 -m unittest -v test_compute.py" }); }
      else message = call("finish", { result: "Implemented compute(value) in module.py. The unit test now passes: compute(1) returns 3. Unrelated files are unchanged." });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(error.message); response.writeHead(500); response.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_HOUSEKEEPING: "0",
    AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", AGINTI_PROVIDER_HANDOFF: "0", PYTHONDONTWRITEBYTECODE: "1",
    ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) };
  const worker = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/native-recovery-source-boundary.js", import.meta.url)), root, `http://127.0.0.1:${server.address().port}/v1`, mode], { cwd: root + "/workspace", env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  worker.stdout.on("data", b => stdout += b); worker.stderr.on("data", b => stderr += b);
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; worker.kill("SIGKILL"); }, 25000);
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.once("close", code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(timedOut, false); assert.equal(exit, 0, stderr); assert.deepEqual(errors, []);
  const report = JSON.parse(stdout), allRequests = JSON.stringify(bodies);
  assert.equal(report.error, null, JSON.stringify(report));
  assert.ok(!allRequests.includes(marker), "Automatic recovery forwarded excluded source to the provider");
  const state = JSON.parse(await fs.readFile(root + "/sessions/recovery-boundary-" + mode + "/state.json", "utf8"));
  const events = (await fs.readFile(root + "/sessions/recovery-boundary-" + mode + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  const commands = events.filter(event => event.type === "tool.completed" && event.data.toolName === "run_command");
  assert.ok(commands.some(event => event.data.exitCode !== 0), JSON.stringify({ report, offered,
    rejections: events.filter(event => /contract|reject|blocked|error/.test(event.type)).slice(-4) }));
  assert.ok(events.some(event => event.type === "verification.test_repair_requested"), JSON.stringify({ report, offered }));
  assert.ok(!JSON.stringify(state).includes(marker)); assert.equal(report.runtimeRevision, 1); assert.equal(replaced, !ordinary);
  assert.ok(!(await fs.readdir(root + "/workspace")).includes("__pycache__"), "Native commands must not write stale workspace bytecode caches");
  if (ordinary) {
    assert.equal(report.result.goalStatus, "completed", JSON.stringify({ report, offered,
      commands: commands.map(event => ({ args: event.data.args, exitCode: event.data.exitCode, stdout: event.data.stdout, stderr: event.data.stderr })),
      source: await fs.readFile(root + "/workspace/module.py", "utf8") }));
    assert.equal(commands.length, 2); assert.equal(commands[1].data.exitCode, 0);
    assert.equal(await fs.readFile(root + "/workspace/module.py", "utf8"), "def compute(value):\n    return value + 2\n");
  } else {
    assert.notEqual(report.result.goalStatus, "completed", JSON.stringify(report)); assert.equal(commands.length, 1);
  }
  assert.equal(await fs.readFile(root + "/workspace/test_compute.py", "utf8"), check);
  assert.equal(await fs.readFile(root + "/excluded/private.py", "utf8"), `# ${marker}\n`);
  await assert.rejects(fs.stat(root + "/sessions/recovery-boundary-" + mode + "/.agent-run.lock"), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ mode, realNativeRuntime: true, scriptedProvider: true, externalModelCalls: 0,
    sessionId: state.sessionId, runtimeRevision: report.runtimeRevision, goalStatus: report.result.goalStatus,
    recoveryPacketVersion: report.recoveryPacketVersion, providerRequests: report.requests,
    sourceMarkerForwarded: false, workspaceBytecodeCacheAbsent: true, sessionLeaseReleased: true,
    commands: commands.map(event => ({ command: event.data.args.command, exitCode: event.data.exitCode, stdout: event.data.stdout, stderr: event.data.stderr })),
    checkerSha256: createHash("sha256").update(check).digest("hex"),
    sourceArtifact: ordinary ? { path: "module.py", content: await fs.readFile(root + "/workspace/module.py", "utf8") } : null }));
});
