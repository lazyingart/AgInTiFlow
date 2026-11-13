import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { longJobStatus, startLongJob } from "../src/long-job-tools.js";

const scheduler = fileURLToPath(new URL("./fixtures/long-job-status-io.js", import.meta.url));
const cases = [
  ["command-success", false, 0, 0],
  ["verify-success", true, 0, 0],
  ["command-failed", false, 7, 0],
  ["verify-failed", true, 0, 9],
  ["heartbeats", false, 0, 0],
  ["pid-write-error", false, 0, 0],
  ["pid-rename-error", false, 0, 0],
  ["terminal-write-error", false, 0, 0],
  ["terminal-rename-error", false, 0, 0],
];

for (const [mode, verify, commandExit, verifyExit] of cases) {
  test(`generated long-job status publication: ${mode}`, { timeout: 15_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-status-publication-"));
    const oldPath = process.env.PATH, bin = path.join(root, "bin");
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise(resolve => child.once("close", resolve)); child.kill("SIGKILL"); await closed;
      }
      process.env.PATH = oldPath; await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(bin);
    // Admission generates the real worker but does not dispatch a tmux server.
    // This test launches that exact file as a bounded owned child instead.
    await fs.writeFile(path.join(bin, "tmux"), "#!/bin/sh\nif [ \"$1\" = new-session ]; then exit 0; fi\nprintf \"can't find session: %s\\n\" \"$3\" >&2\nexit 1\n", { mode: 0o700 });
    process.env.PATH = bin + path.delimiter + oldPath;
    const command = `printf 'run\\n' >> launches.txt; printf abc123 > product.bin${commandExit ? "; exit " + commandExit : ""}`;
    const config = { commandCwd: root, allowShellTool: true, allowDestructive: true, sandboxMode: "host", useDockerSandbox: false };
    const receipt = await startLongJob({ name: "status-publication", command, expectedOutputPath: "product.bin", expectedSizeBytes: 6,
      verifyCommand: verify ? "test -s product.bin" + (verifyExit ? "; exit " + verifyExit : "") : "", timeoutSeconds: 10, pollIntervalSeconds: 5 }, config);
    assert.equal(receipt.ok, true);
    const directory = path.join(root, ".aginti", "long-jobs", receipt.jobId);
    let stderr = "";
    child = spawn(process.execPath, ["--import", scheduler, path.join(directory, "supervisor.mjs")], {
      cwd: root, env: { PATH: oldPath, HOME: root, SHELL: "/bin/bash", LANG: "C.UTF-8", AGINTI_STATUS_TEST_ROOT: root, AGINTI_STATUS_TEST_MODE: mode }, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", bytes => { stderr += bytes; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const io = (await fs.readFile(path.join(root, "io-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const events = (await fs.readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const status = JSON.parse(await fs.readFile(path.join(directory, "status.json"), "utf8"));
    assert.equal(await fs.readFile(path.join(root, "product.bin"), "utf8"), "abc123");
    assert.equal(await fs.readFile(path.join(root, "launches.txt"), "utf8"), "run\n");
    assert.equal(io.filter(e => e.event === "unhandled.rejection").length, 0);
    assert.equal(io.at(-1).maximum, 1, "status writes must not overlap even when a PID write is held");
    if (mode.includes("error")) {
      assert.equal(code, 1); assert.match(stderr, /Synthetic status publication EIO/);
      assert.notEqual(status.state, "completed");
      assert.equal(events.some(e => e.type === "job.completed"), false);
      const fault = io.findIndex(e => e.event === "injected.failure"); assert.ok(fault >= 0);
      assert.equal(io.slice(fault + 1).some(e => e.event === "write.enter"), false, "failed publication must not be silently recovered by a later write");
    } else {
      const expected = commandExit || verifyExit ? "failed" : "completed";
      assert.equal(code, expected === "completed" ? 0 : 1, stderr);
      assert.equal(status.state, expected); assert.equal(status.exitCode, commandExit);
      assert.equal(status.verifyExitCode, verify ? verifyExit : null); assert.equal(status.pid, null);
      assert.equal(status.outputExists, true); assert.equal(status.outputBytes, 6);
      assert.equal(events.filter(e => e.type === "job." + expected).length, 1);
      assert.equal(io.filter(e => e.event === "heartbeat.closed").length, 1);
      const lastWrite = io.filter(e => e.event === "write.enter").at(-1); assert.equal(lastWrite.state, expected);
      await assert.rejects(fs.stat(path.join(directory, "status.json.tmp")), { code: "ENOENT" });
      if (mode === "heartbeats") {
        assert.equal(io.find(e => e.event === "heartbeat.flood").calls, 500);
        assert.equal(io.find(e => e.event === "late.heartbeat.flood").calls, 500);
        assert.equal(io.filter(e => e.event === "write.enter").length, 6, "only one heartbeat may queue; terminal admission blocks all later ones");
      }
    }
    const publicStatus = await longJobStatus({ jobId: receipt.jobId }, config);
    assert.equal(publicStatus.ok, true); assert.equal(publicStatus.state, status.state); assert.equal(publicStatus.sessionAlive, false);
    t.diagnostic(JSON.stringify({ mode, maxConcurrentStatusWrites: io.at(-1).maximum, state: status.state, outputBytes: 6, launches: 1, hostedOrLocalModelCalls: 0 }));
  });
}
