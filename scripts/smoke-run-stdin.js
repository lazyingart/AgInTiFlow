#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function runMachine(label, runArgs, stdin = "") {
  const command = [cliPath, "run", ...runArgs];
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
}

try {
  await runMachine(
    "explicit stdin machine run",
    ["--stdin", ...machineOptions],
    "Reply briefly that the explicit stdin transport smoke completed."
  );
  await runMachine(
    "positional prompt machine run",
    [...machineOptions, "Reply briefly that the positional prompt smoke completed."]
  );
  await runMachine(
    "implicit piped stdin machine run",
    machineOptions,
    "Reply briefly that the implicit piped stdin smoke completed."
  );
} finally {
  await fs.rm(home, { recursive: true, force: true });
}

console.log("run input precedence smoke passed");
