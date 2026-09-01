#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { machineRunPayload, runResultExitCode } from "../src/cli.js";
import { showProjectSession } from "../src/project.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-run-stdin-"));
const cliPath = path.join(root, "bin", "aginti-cli.js");
const machineOptions = [
  "--json",
  "--provider",
  "mock",
  "--routing",
  "manual",
  "--task-profile",
  "chatops",
  "--no-scs",
  "--no-shell",
  "--no-file-tools",
  "--no-mcp",
  "--no-parallel-scouts",
  "--sandbox-mode",
  "host",
];

const stoppedPayload = machineRunPayload({
  sessionId: "stopped-session",
  result: "I stopped safely instead of claiming success.",
  stopped: true,
  reason: "tool_contract_violation",
});
if (stoppedPayload.ok !== false || stoppedPayload.failed !== true || stoppedPayload.stopped !== true) {
  throw new Error(`stopped machine run was reported as success: ${JSON.stringify(stoppedPayload)}`);
}
if (runResultExitCode({ stopped: true, reason: "tool_contract_violation" }) !== 1) {
  throw new Error("a stopped non-JSON agent run still reports shell success");
}
if (runResultExitCode({ stopped: false, result: "done" }) !== 0) {
  throw new Error("a successful agent run was assigned a failing shell exit status");
}

async function runMachine(label, commandArgs, stdin = "") {
  const command = [cliPath, ...commandArgs];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command, {
      cwd: home,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        AGINTIFLOW_HOME: path.join(home, ".agintiflow"),
        AGINTIFLOW_RUNTIME_DIR: "",
        AGINTIFLOW_NO_WEB_AUTO_START: "1",
        AGINTI_LANGUAGE: "en",
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} timed out\nstdout=${stdout}\nstderr=${stderr}`));
    }, process.env.CI ? 90000 : 45000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });

  const lines = output.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (output.code !== 0) throw new Error(`${label} exited ${output.code}\n${output.stdout}\n${output.stderr}`);
  if (lines.length !== 1) throw new Error(`${label} emitted ${lines.length} stdout lines\n${output.stdout}`);
  const payload = JSON.parse(lines[0]);
  if (payload.ok !== true || !String(payload.result || "").trim()) {
    throw new Error(`${label} returned an unusable payload\n${output.stdout}`);
  }
  if (/(?:^|\n)(?:Session|Provider|Model|Routing|Workspace|Plan):/i.test(output.stdout)) {
    throw new Error(`${label} leaked interactive metadata\n${output.stdout}`);
  }
  if (output.stderr.trim()) throw new Error(`${label} leaked stderr\n${output.stderr}`);
  return payload;
}

try {
  await runMachine(
    "explicit stdin machine run",
    ["run", "--stdin", ...machineOptions],
    "Reply briefly that the explicit stdin transport smoke completed."
  );
  await runMachine(
    "positional prompt machine run",
    ["run", ...machineOptions, "Reply briefly that the positional prompt smoke completed."]
  );
  await runMachine(
    "implicit piped stdin machine run",
    ["run", ...machineOptions],
    "Reply briefly that the implicit piped stdin smoke completed."
  );
  const initial = await runMachine(
    "initial resumable machine run",
    ["run", "--stdin", ...machineOptions],
    "Remember the marker AGINTI_MACHINE_RESUME and reply briefly."
  );
  const resumed = await runMachine(
    "resumed stdin machine run",
    ["resume", initial.sessionId, "--stdin", "--json"],
    "Reply briefly that this saved session resumed successfully."
  );
  if (resumed.sessionId !== initial.sessionId) {
    throw new Error(`machine resume changed session id: ${initial.sessionId} -> ${resumed.sessionId}`);
  }
  if (initial.provider !== "mock" || resumed.provider !== "mock" || resumed.resumed !== true) {
    throw new Error(`machine payload omitted provider/resume diagnostics: ${JSON.stringify({ initial, resumed })}`);
  }
  if (
    initial.goalRevision !== 1 ||
    initial.goalStatus !== "completed" ||
    resumed.goalRevision !== 2 ||
    resumed.goalStatus !== "completed"
  ) {
    throw new Error(`machine payload omitted durable goal lifecycle: ${JSON.stringify({ initial, resumed })}`);
  }
  const stored = await showProjectSession(home, initial.sessionId);
  if (stored?.goalRevision !== 2 || stored?.goalStatus !== "completed") {
    throw new Error(`durable goal revision/lifecycle was not completed: ${stored?.goalRevision}/${stored?.goalStatus}`);
  }
  if (!stored.events.some((event) => event.type === "goal.updated" && event.data?.revision === 2)) {
    throw new Error("durable goal update event was not recorded");
  }
  const state = JSON.parse(
    await fs.readFile(path.join(home, ".agintiflow", "sessions", initial.sessionId, "state.json"), "utf8")
  );
  if (
    state.meta?.goalContract?.history?.length !== 2 ||
    state.meta?.goalContract?.lifecycle?.length !== 4 ||
    state.meta.goalContract.lifecycle.at(-1)?.status !== "completed" ||
    state.meta.goalContract.lifecycle.at(-2)?.status !== "active" ||
    state.meta.goalContract.currentPreview !== state.goal ||
    state.meta.goalContract.currentHash !== state.meta.goalContract.history.at(-1)?.hash
  ) {
    throw new Error("durable goal ledger did not retain both revisions and the authoritative current goal");
  }
  const continuation = state.messages.find(
    (message) => message.role === "user" && String(message.content || "").startsWith("Continue with this new request:")
  );
  if (!continuation || continuation.content.length >= 8_000) {
    throw new Error(`focused continuation did not use bounded context: ${continuation?.content?.length || 0}`);
  }
} finally {
  await fs.rm(home, { recursive: true, force: true });
}

console.log("run and resume input precedence smoke passed");
