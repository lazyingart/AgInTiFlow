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

function occurrenceCount(value, pattern) {
  return String(value || "").split(pattern).length - 1;
}

function latestWebappEvent(value, statePattern = "started|restarted|reused|stopped") {
  const pattern = new RegExp(`webapp=(http://127\\.0\\.0\\.1:(\\d+)) (${statePattern})`, "g");
  const matches = [...String(value || "").matchAll(pattern)];
  const latest = matches.at(-1);
  return latest ? { url: latest[1], port: Number(latest[2]), state: latest[3] } : null;
}

async function waitFor(predicate, child, label, output) {
  const deadline = Date.now() + 30000;
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

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.stdin?.write("/exit\n");
  } catch {
    // The CLI may have closed stdin after the final prompt; fall back to process signals.
  }
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(2000).then(() => false),
  ]);
  if (exited || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const terminated = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(2000).then(() => false),
  ]);
  if (!terminated && child.exitCode === null) child.kill("SIGKILL");
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
    await waitFor(() => output.stdout.includes("status=idle") && output.stdout.includes("user>"), child, `${label} interactive ready`, output);
    child.stdin.write(`/webapp ${port}\n`);
    await waitFor(() => latestWebappEvent(output.stdout, "started|reused"), child, `${label} /webapp command`, output);
    let active = latestWebappEvent(output.stdout, "started|reused");
    child.stdin.write(`/webapp restart ${active.port}\n`);
    await waitFor(() => latestWebappEvent(output.stdout, "restarted"), child, `${label} /webapp restart command`, output);
    active = latestWebappEvent(output.stdout, "restarted");
    const health = await fetch(`${active.url}/health`).then((response) => response.json());
    if (!health.ok || health.app !== "agintiflow" || Number(health.port) !== active.port) {
      throw new Error(`invalid /webapp health response for ${label}: ${JSON.stringify(health)}`);
    }
    if (path.resolve(health.agintiflowHome) !== path.resolve(path.join(runtimeDir, `.agintiflow-web-home-${label}`))) {
      throw new Error(`webapp command inherited the wrong home for ${label}: ${JSON.stringify(health)}`);
    }
    child.stdin.write(`/webapp disable\n`);
    await waitFor(() => output.stdout.includes("webapp auto-start=disabled"), child, `${label} /webapp disable command`, output);
    const disabledCount = occurrenceCount(output.stdout, "webapp auto-start=disabled");
    child.stdin.write(`/webapp status\n`);
    await waitFor(() => occurrenceCount(output.stdout, "webapp auto-start=disabled") > disabledCount, child, `${label} /webapp status disabled command`, output);
    child.stdin.write(`/webapp enable\n`);
    await waitFor(() => output.stdout.includes("webapp auto-start=enabled"), child, `${label} /webapp enable command`, output);
    child.stdin.write(`/webapp stop ${active.port}\n`);
    await waitFor(() => latestWebappEvent(output.stdout, "stopped")?.port === active.port, child, `${label} /webapp stop command`, output);
    let stopped = false;
    try {
      await fetch(`${active.url}/health`);
    } catch {
      stopped = true;
    }
    if (!stopped) {
      throw new Error(`webapp still responded after /webapp stop for ${label}`);
    }
    child.stdin.write(`/webapp ${active.port}\n`);
    await waitFor(() => latestWebappEvent(output.stdout, "started|reused")?.port === active.port, child, `${label} /webapp restart after stop`, output);
  } finally {
    await stopChild(child);
    await killPort(port);
    await delay(250);
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
  await delay(250);
  await fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
