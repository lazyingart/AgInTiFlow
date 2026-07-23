#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-run-stdin-"));
const command = [
  path.join(root, "bin", "aginti-cli.js"),
  "run",
  "--stdin",
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
    reject(new Error(`machine run timed out\nstdout=${stdout}\nstderr=${stderr}`));
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
  child.stdin.end("Reply briefly that the machine transport smoke completed.");
});

const lines = output.stdout.trim().split(/\r?\n/).filter(Boolean);
if (output.code !== 0) throw new Error(`machine run exited ${output.code}\n${output.stdout}\n${output.stderr}`);
if (lines.length !== 1) throw new Error(`machine run emitted ${lines.length} stdout lines\n${output.stdout}`);
const payload = JSON.parse(lines[0]);
if (payload.ok !== true || !String(payload.result || "").trim()) {
  throw new Error(`machine run returned an unusable payload\n${output.stdout}`);
}
if (/(?:^|\n)(?:Session|Provider|Model|Routing|Workspace|Plan):/i.test(output.stdout)) {
  throw new Error(`machine run leaked interactive metadata\n${output.stdout}`);
}
if (output.stderr.trim()) throw new Error(`machine run leaked stderr\n${output.stderr}`);

console.log("run stdin smoke passed");
