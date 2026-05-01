#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-cli-chat-"));
const binPath = path.join(repoRoot, "bin/aginti-cli.js");

function runChat(inputText) {
  return runCli(["chat", "--provider", "mock", "--routing", "manual", "--profile", "code"], inputText);
}

function runCli(args, inputText) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: tempRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        AGINTIFLOW_RUNTIME_DIR: "",
      },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("interactive chat smoke timed out"));
    }, 25000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`interactive chat exited ${code}\n${stdout}\n${stderr}`));
    });

    child.stdin.end(inputText);
  });
}

try {
  const result = await runChat("Create notes/interactive.md with a short CLI chat smoke message\n/exit\n");
  const written = await fs.readFile(path.join(tempRoot, "notes/interactive.md"), "utf8");
  if (!written.includes("Created by AgInTiFlow mock mode.")) {
    throw new Error("interactive chat did not create the expected file");
  }
  if (!result.stdout.includes("Interactive agent chat")) {
    throw new Error("interactive chat did not print its banner");
  }
  if (!result.stdout.includes("status=running workingOn=") || !result.stdout.includes("status=idle session=")) {
    throw new Error("interactive chat did not print simple run status updates");
  }

  const latest = await runCli(["resume"], "/exit\n");
  if (!latest.stdout.includes("session=") || !latest.stdout.includes("Interactive agent chat")) {
    throw new Error("bare aginti resume did not open the latest session interactively");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectRoot: tempRoot,
        checks: ["interactive-chat", "mock-file-write", "run-status", "resume-latest"],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
