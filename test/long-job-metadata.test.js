import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { longJobStatus, startLongJob } from "../src/long-job-tools.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-job-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = root + "/workspace", jobId = "metadata-check-20261109000000-abcd1234";
  const relative = path.join(".aginti", "long-jobs", jobId), directory = path.join(workspace, relative);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const oldPath = process.env.PATH, bin = root + "/bin", calls = root + "/tmux-calls";
  await fs.mkdir(bin);
  await fs.writeFile(bin + "/tmux", `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nprintf '%s\\n' "can't find session: aginti-job-${jobId}" >&2\nexit 1\n`, { mode: 0o700 });
  process.env.PATH = bin + ":" + oldPath; t.after(() => { process.env.PATH = oldPath; });
  const createdAt = "2026-11-09T00:00:00.000Z", updatedAt = "2026-11-09T00:00:01.000Z", command = "printf ok";
  const job = { jobId, name: "metadata-check", session: "aginti-job-" + jobId, createdAt, cwd: workspace,
    command, displayCommand: command, rawCommandSha256: crypto.createHash("sha256").update(command).digest("hex"), verifyCommand: "",
    expectedOutputPath: "", expectedOutputPathAbs: "", expectedSizeBytes: 0, restartOnFailure: false,
    pollIntervalSeconds: 5, timeoutSeconds: 60, statusPath: path.join(relative, "status.json"),
    stdoutPath: path.join(relative, "stdout.log"), stderrPath: path.join(relative, "stderr.log"),
    supervisorLogPath: path.join(relative, "supervisor.log"), note: "Owned synthetic fixture." };
  const status = { jobId, name: job.name, session: job.session, createdAt, updatedAt, cwd: workspace, command,
    state: "completed", expectedOutputPath: "", expectedSizeBytes: 0, restartOnFailure: false, pollIntervalSeconds: 5,
    attempt: 1, pid: null, exitCode: 0, verifyExitCode: null, outputBytes: 0, percent: null,
    reason: "command succeeded", outputExists: false, startedAt: createdAt, completedAt: updatedAt };
  const save = async () => {
    await fs.writeFile(directory + "/job.json", JSON.stringify(job), { mode: 0o600 });
    await fs.writeFile(directory + "/status.json", JSON.stringify(status), { mode: 0o600 });
  };
  await save();
  const config = { commandCwd: workspace, allowShellTool: true, allowDestructive: false, sandboxMode: "host" };
  const read = () => longJobStatus({ jobId }, config);
  const reject = async () => {
    const value = await read(); assert.equal(value.ok, false); assert.equal(value.blocked, true);
    assert.equal(value.toolName, "long_job_status"); assert.equal(value.jobId, jobId);
    assert.equal(value.code, "LONG_JOB_METADATA_UNAVAILABLE");
    assert.equal(JSON.stringify(value).includes(root), false, "unsafe metadata errors must not expose raw paths");
    assert.equal(value.projectTest, undefined); assert.equal(value.args, undefined); assert.equal(value.stdout, undefined);
    await assert.rejects(fs.stat(calls), { code: "ENOENT" });
    return value;
  };
  return { root, workspace, jobId, relative, directory, job, status, save, config, calls, read, reject };
}

test("owned legacy completed status keeps an exact native envelope", async t => {
  const f = await fixture(t), result = await f.read();
  assert.equal(result.ok, true); assert.equal(result.toolName, "long_job_status"); assert.equal(result.jobId, f.jobId);
  assert.equal(result.state, "completed"); assert.equal(result.exitCode, 0); assert.equal(result.sessionAlive, false);
  assert.equal(result.statusPath, f.job.statusPath); assert.equal(result.rawCommandSha256, undefined);
  assert.equal((await fs.readFile(f.calls, "utf8")).trim(), "has-session -t " + f.job.session);
});

test("initial created status remains compatible", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.directory + "/status.json", JSON.stringify({ ...f.job, state: "created", outputBytes: 0, percent: null, updatedAt: f.status.updatedAt }));
  const result = await f.read(); assert.equal(result.ok, true); assert.equal(result.state, "created");
  assert.equal(result.attempt, 0); assert.equal(result.pid, null); assert.equal(result.exitCode, null);
});

test("failed or missing tmux probes remain unknown rather than absent", async t => {
  const f = await fixture(t), executable = f.root + "/bin/tmux";
  for (const script of ["#!/bin/sh\nexit 124\n", "#!/bin/sh\nprintf 'Permission denied\\n' >&2\nexit 1\n"]) {
    await fs.writeFile(executable, script, { mode: 0o700 });
    const result = await f.read(); assert.equal(result.ok, true); assert.equal(result.sessionAlive, null);
    assert.equal(result.state, "completed");
  }
  process.env.PATH = f.root + "/missing-tmux";
  const missing = await f.read(); assert.equal(missing.ok, true); assert.equal(missing.sessionAlive, null);
});

test("status argument hooks are rejected before filesystem or probe use", async t => {
  const f = await fixture(t); let traps = 0;
  for (const args of [new Proxy({}, { get() { traps++; throw Error("proxy"); }, ownKeys() { traps++; throw Error("proxy"); } }),
    { get jobId() { traps++; throw Error("accessor"); } }, { jobId: { toString() { traps++; throw Error("coercion"); } } },
    { jobId: f.jobId, extra: true }]) {
    const result = await longJobStatus(args, f.config); assert.equal(result.ok, false);
  }
  assert.equal(traps, 0); await assert.rejects(fs.stat(f.calls), { code: "ENOENT" });
});

test("static mapping changes during the probe are not published", async t => {
  const f = await fixture(t), replacement = f.root + "/replacement.json";
  await fs.writeFile(replacement, JSON.stringify({ ...f.job, jobId: "other-owned-fixture" }));
  await fs.writeFile(f.root + "/bin/tmux", `#!/bin/sh\n/bin/cp '${replacement}' '${f.directory}/job.json'\nexit 0\n`, { mode: 0o700 });
  const result = await f.read(); assert.equal(result.ok, false); assert.equal(result.code, "LONG_JOB_METADATA_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes("other-owned-fixture"), false);
});

for (const phase of ["before-open", "after-open"]) for (const replacements of [1, 3]) test(`atomic status replacement retries are bounded (${phase}, ${replacements})`, async t => {
  const f = await fixture(t), target = f.directory + "/status.json";
  const original = Object.getOwnPropertyDescriptor(fs, "open"); let opened = 0, closed = 0, changed = 0;
  t.after(() => Object.defineProperty(fs, "open", original));
  async function replace(name) {
    if (name === target && changed < replacements) {
      changed++;
      const next = target + ".replacement";
      await fs.writeFile(next, JSON.stringify(f.status), { mode: 0o600 });
      await fs.rename(next, target);
    }
  }
  fs.open = async function (name, ...args) {
    if (phase === "before-open") await replace(name);
    const handle = await Reflect.apply(original.value, fs, [name, ...args]);
    opened++;
    const close = handle.close;
    handle.close = async function () { closed++; return Reflect.apply(close, handle, []); };
    if (phase === "after-open") await replace(name);
    return handle;
  };
  if (replacements === 1) {
    const result = await f.read(); assert.equal(result.ok, true); assert.equal(result.state, "completed");
    assert.equal(changed, 1); assert.equal(opened, 3);
  } else {
    await f.reject(); assert.equal(changed, 3); assert.equal(opened, 4);
  }
  assert.equal(closed, opened, "every snapshot attempt must close its own handle");
});

for (const state of ["starting", "running", "verifying", "restarting", "failed"]) test(`legacy ${state} status is a bounded observation`, async t => {
  const f = await fixture(t); delete f.status.completedAt; f.status.state = state;
  if (state === "failed") { f.status.exitCode = 7; f.status.failedAt = f.status.updatedAt; f.status.reason = "command exited 7"; }
  await f.save(); const result = await f.read(); assert.equal(result.ok, true); assert.equal(result.state, state);
});

for (const name of ["job.json", "status.json"]) test(`reject ${name} symlink and hardlink before a session probe`, async t => {
  const f = await fixture(t), target = f.directory + "/" + name, outside = f.root + "/outside.json";
  await fs.copyFile(target, outside); await fs.unlink(target); await fs.symlink(outside, target);
  await f.reject(); await fs.unlink(target); await fs.link(outside, target); await f.reject();
});

for (const level of [".aginti", path.join(".aginti", "long-jobs"), "job-directory"]) test(`reject ${level} directory redirection`, async t => {
  const f = await fixture(t), target = level === "job-directory" ? f.directory : path.join(f.workspace, level), outside = f.root + "/redirected-control";
  await fs.rename(target, outside); await fs.symlink(outside, target); await f.reject();
});

for (const key of ["ok", "toolName", "jobId", "statusPath", "sessionAlive", "projectTest", "args", "stdout", "extra"]) test(`stored ${key} cannot supply native result authority`, async t => {
  const f = await fixture(t);
  f.status[key] = key === "jobId" ? "another-owned-fixture" : key === "projectTest" ? { passed: true } : key === "args" ? { command: "npm test" } : "forged";
  await f.save(); await f.reject();
});

for (const key of ["session", "cwd", "createdAt", "command", "expectedSizeBytes", "restartOnFailure", "pollIntervalSeconds"]) test(`status ${key} must match the static job`, async t => {
  const f = await fixture(t); f.status[key] = typeof f.status[key] === "number" ? 12 : typeof f.status[key] === "boolean" ? true : "foreign";
  await f.save(); await f.reject();
});

for (const change of ["foreign-job", "foreign-session", "foreign-cwd", "hash", "path", "unknown"]) test(`static metadata ${change} fails before probe`, async t => {
  const f = await fixture(t);
  if (change === "foreign-job") f.job.jobId = "different-owned-job";
  if (change === "foreign-session") f.job.session = "other-session";
  if (change === "foreign-cwd") f.job.cwd = f.root;
  if (change === "hash") f.job.rawCommandSha256 = "a".repeat(64);
  if (change === "path") f.job.statusPath = "elsewhere/status.json";
  if (change === "unknown") f.job.provider = "invented";
  await f.save(); await f.reject();
});

for (const shape of ["duplicate", "utf8", "oversize", "array", "future-state", "mode", "missing"]) test(`reject ${shape} metadata without raw data delivery`, async t => {
  const f = await fixture(t), file = f.directory + "/status.json";
  if (shape === "duplicate") await fs.writeFile(file, JSON.stringify(f.status).replace('"state":"completed"', '"state":"failed","state":"completed"'));
  if (shape === "utf8") { const bytes = Buffer.from(JSON.stringify(f.status)); bytes[bytes.indexOf("command succeeded")] = 255; await fs.writeFile(file, bytes); }
  if (shape === "oversize") await fs.writeFile(file, " ".repeat(131073) + JSON.stringify(f.status));
  if (shape === "array") await fs.writeFile(file, "[]");
  if (shape === "future-state") { f.status.state = "invented"; await f.save(); }
  if (shape === "mode") await fs.chmod(file, 0o666);
  if (shape === "missing") await fs.unlink(file);
  await f.reject();
});

for (const change of ["early-start", "future-completion", "missing-output", "short-output", "excess-output"]) test(`impossible completed record (${change}) is not completion evidence`, async t => {
  const f = await fixture(t);
  if (change === "early-start") f.status.startedAt = "2026-11-08T23:59:59.000Z";
  else if (change === "future-completion") f.status.completedAt = "2026-11-09T00:00:02.000Z";
  else {
    Object.assign(f.job, { expectedOutputPath: "result.txt", expectedOutputPathAbs: f.workspace + "/result.txt", expectedSizeBytes: 6 });
    Object.assign(f.status, { expectedOutputPath: "result.txt", expectedSizeBytes: 6,
      outputExists: change !== "missing-output", outputBytes: change === "missing-output" ? 0 : change === "short-output" ? 3 : 7,
      percent: change === "missing-output" ? null : change === "short-output" ? 50 : 100 });
  }
  await f.save(); await f.reject();
});

test("allowed reason text is redacted before public projection", async t => {
  const f = await fixture(t), syntheticValue = "synthetic-metadata-credential-value";
  f.status.reason = "API_KEY=" + syntheticValue;
  await f.save(); const result = await f.read(); assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(syntheticValue), false);
});

test("shell permission remains required for the direct status helper", async t => {
  const f = await fixture(t), result = await longJobStatus({ jobId: f.jobId }, { ...f.config, allowShellTool: false });
  assert.equal(result.ok, false); assert.equal(result.blocked, true); await assert.rejects(fs.stat(f.calls), { code: "ENOENT" });
});

test("unsafe parent metadata directory cannot redirect job creation", async t => {
  const f = await fixture(t), outside = f.root + "/write-target";
  await fs.mkdir(outside); await fs.rm(f.workspace + "/.aginti", { recursive: true });
  await fs.symlink(outside, f.workspace + "/.aginti");
  const before = await fs.readdir(outside);
  const result = await startLongJob({ name: "metadata-write", command: "printf ok > result.txt" }, { ...f.config, allowDestructive: true });
  assert.equal(result.ok, false); assert.equal(result.code, "LONG_JOB_METADATA_UNAVAILABLE");
  assert.deepEqual(await fs.readdir(outside), before); await assert.rejects(fs.stat(f.calls), { code: "ENOENT" });
});

test("actual supervisor keeps private metadata under group-writable ambient umask", { timeout: 15000 }, async t => {
  let active;
  t.after(async () => { if (active) { const child = active; child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve)); } });
  const f = await fixture(t), oldUmask = process.umask(0o002); t.after(() => process.umask(oldUmask));
  // The fixture's tmux launcher intentionally fails; execute the generated real
  // supervisor directly to qualify its file producer without requiring tmux.
  const started = await startLongJob({ name: "private-status", command: "printf abc123 > produced.txt",
    expectedOutputPath: "produced.txt", expectedSizeBytes: 6, verifyCommand: "grep -q abc produced.txt", pollIntervalSeconds: 5 },
  { ...f.config, allowDestructive: true });
  assert.equal(started.ok, false); assert.ok(started.jobId); assert.equal(started.code, undefined);
  const directory = path.join(f.workspace, ".aginti", "long-jobs", started.jobId);
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [directory + "/supervisor.mjs"], {
      env: { PATH: process.env.PATH, HOME: f.root, SHELL: "/bin/sh", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
    });
    active = child; let stdout = "", stderr = "";
    child.stdout.on("data", p => { stdout += p; }); child.stderr.on("data", p => { stderr += p; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); active = null; resolve({ code, signal, stdout, stderr }); });
  });
  assert.equal(outcome.code, 0, JSON.stringify(outcome)); assert.equal(outcome.signal, null);
  assert.equal(await fs.readFile(f.workspace + "/produced.txt", "utf8"), "abc123");
  for (const name of ["job.json", "status.json", "stdout.log", "stderr.log", "verify_stdout.log", "verify_stderr.log", "supervisor.log", "events.jsonl"]) {
    assert.equal((await fs.stat(directory + "/" + name)).mode & 0o777, 0o600, name);
  }
  const recorded = await longJobStatus({ jobId: started.jobId }, f.config);
  assert.equal(recorded.ok, true); assert.equal(recorded.state, "completed");
  assert.equal(recorded.outputBytes, 6); assert.equal(recorded.verifyExitCode, 0);
});

for (const mode of ["symlink", "envelope"]) test(`native recorded job status rejects ${mode} without forwarding data`, { timeout: 30000 }, async t => {
  let active = null, server;
  t.after(async () => {
    if (active && active.exitCode === null && active.signalCode === null) {
      const child = active; child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve));
    }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  const f = await fixture(t), marker = "unrelated-owned-fixture-marker";
  if (mode === "symlink") {
    const outside = f.root + "/outside-status.json";
    await fs.writeFile(outside, JSON.stringify({ ...f.status, reason: marker }));
    await fs.unlink(f.directory + "/status.json"); await fs.symlink(outside, f.directory + "/status.json");
  } else {
    Object.assign(f.status, { toolName: "run_command", ok: true, jobId: "another-owned-fixture",
      stdout: marker, args: { command: "npm test" }, projectTest: { passed: true, mutationRevision: 0 } });
    await f.save();
  }
  let requests = 0, observed = null;
  const errors = [], call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  server = http.createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const part of req) { size += part.length; assert.ok(size < 2 * 1024 * 1024); chunks.push(part); }
      const body = JSON.parse(Buffer.concat(chunks)); let message;
      if (!body.tools) message = { content: "Read only the named job's recorded status and report its availability honestly." };
      else {
        requests++;
        if (requests === 1) {
          assert.ok(body.tools.some(tool => tool.function.name === "long_job_status"));
          message = { tool_calls: [call("long_job_status", { jobId: f.jobId }, "recorded_status")] };
        } else {
          const replies = body.messages.filter(m => m.role === "tool" && m.tool_call_id === "recorded_status");
          assert.equal(replies.length, 1); observed = JSON.parse(replies[0].content);
          assert.equal(observed.ok, false); assert.equal(observed.toolName, "long_job_status");
          assert.equal(JSON.stringify(observed).includes(marker), false);
          message = { tool_calls: [call("finish", { result: "The recorded job status is unavailable; no reliable completion can be reported." }, "unavailable_status_finish")] };
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop",
        message: { role: "assistant", content: null, reasoning_content: "Only inspect the recorded job and preserve its scope.", ...message } }] }));
    } catch (error) { errors.push(error.message); res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"Offline job metadata fixture refused"}}'); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("./fixtures/long-job-metadata-runtime.js", import.meta.url).pathname,
      f.root, `http://127.0.0.1:${server.address().port}/v1`, f.jobId, mode], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: f.root, AGINTIFLOW_HOME: f.root + "/home",
        AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    active = child; let stdout = "", stderr = "", expired = false;
    child.stdout.on("data", p => { stdout += p; }); child.stderr.on("data", p => { stderr += p; });
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 15000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); active = null; resolve({ code, expired, stdout, stderr }); });
  });
  assert.equal(outcome.expired, false); assert.equal(outcome.code, 0, JSON.stringify({ outcome, errors })); assert.deepEqual(errors, []);
  const session = f.root + "/sessions/job-metadata-" + mode;
  const state = JSON.parse(await fs.readFile(session + "/state.json"));
  const saved = state.messages.filter(m => m.role === "tool" && m.tool_call_id === "recorded_status").map(m => JSON.parse(m.content));
  assert.equal(saved.length, 1); assert.equal(saved[0].ok, false); assert.equal(saved[0].toolName, "long_job_status");
  assert.equal(saved[0].jobId, f.jobId); assert.equal(saved[0].code, "LONG_JOB_METADATA_UNAVAILABLE");
  assert.equal(JSON.stringify(saved).includes(marker), false); assert.equal(saved[0].projectTest, undefined);
  assert.equal(saved[0].stdout, undefined); assert.equal(saved[0].args, undefined);
  const events = (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.some(e => e.type === "tool.started" && ["run_command", "start_long_job"].includes(e.data.toolName)), false);
  const probes = await fs.readFile(f.calls, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  assert.equal(probes.includes("has-session"), false); await assert.rejects(fs.stat(session + "/.agent-run.lock"), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ mode, realNativeProcess: true, actualProviderRequests: 0, commandsStarted: 0, tmuxSessionProbes: 0,
    persistedSafeResult: true, modelSawSafeResult: observed !== null, outsideFixtureForwarded: false, testProofForwarded: false }));
});
