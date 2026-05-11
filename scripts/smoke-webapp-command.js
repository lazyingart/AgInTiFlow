#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-webapp-command-"));
const execFile = promisify(execFileCallback);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, child, label, output) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    if (child.exitCode !== null) break;
    await delay(150);
  }
  const { stdout, stderr } = output;
  throw new Error(`${label} timed out. stdout=${stdout.slice(-1000)} stderr=${stderr.slice(-1000)}`);
}

async function killPort(port) {
  try {
    const { stdout: pids } = await execFile("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"]);
    for (const pid of pids.split(/\s+/).filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // Ignore already-exited listeners.
      }
    }
  } catch {
    // lsof may be unavailable; the temporary port listener will otherwise be reusable by later tests.
  }
}

async function runCase({ port, env = {}, expectHeader, label }) {
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "chat", "--provider", "mock", "--routing", "manual", "--port", String(port)], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      AGINTIFLOW_NO_ANIMATION: "1",
      AGINTIFLOW_HOME: path.join(runtimeDir, `.ignored-cli-home-${label}`),
      AGINTIFLOW_WEB_HOME: path.join(runtimeDir, `.agintiflow-web-home-${label}`),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    output.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk.toString();
  });

  try {
    await waitFor(() => output.stdout.includes(expectHeader), child, `${label} launch header`, output);
    child.stdin.write(`/webapp ${port}\n`);
    await waitFor(() => output.stdout.includes(`webapp=http://127.0.0.1:${port}`), child, `${label} /webapp command`, output);
    child.stdin.write(`/webapp restart ${port}\n`);
    await waitFor(() => output.stdout.includes(`webapp=http://127.0.0.1:${port} restarted`), child, `${label} /webapp restart command`, output);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    if (!health.ok || health.app !== "agintiflow" || Number(health.port) !== port) {
      throw new Error(`invalid /webapp health response for ${label}: ${JSON.stringify(health)}`);
    }
    if (path.resolve(health.agintiflowHome) !== path.resolve(path.join(runtimeDir, `.agintiflow-web-home-${label}`))) {
      throw new Error(`webapp command inherited the wrong home for ${label}: ${JSON.stringify(health)}`);
    }
  } finally {
    child.kill("SIGTERM");
    await killPort(port);
  }
}

const autoPort = 45600 + Math.floor(Math.random() * 300);
const manualPort = autoPort + 301;

try {
  await runCase({
    port: autoPort,
    expectHeader: `webapp: http://127.0.0.1:${autoPort}`,
    label: "auto-start",
  });
  await runCase({
    port: manualPort,
    env: { AGINTIFLOW_NO_WEB_AUTO_START: "1" },
    expectHeader: "webapp auto-start disabled - use /webapp to start manually",
    label: "manual-disabled",
  });
  console.log(`webapp slash command smoke passed: http://127.0.0.1:${autoPort}, http://127.0.0.1:${manualPort}`);
} finally {
  await killPort(autoPort);
  await killPort(manualPort);
  await fs.rm(runtimeDir, { recursive: true, force: true });
}
