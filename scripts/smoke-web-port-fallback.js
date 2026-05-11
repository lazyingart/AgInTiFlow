#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-web-port-fallback-"));
const host = "127.0.0.1";
const occupiedPort = 43100 + Math.floor(Math.random() * 1200);

function listenOccupier(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPrintedPort(child, stdout, stderr) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const match = stdout().match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return Number(match[1]);
    await delay(100);
  }
  throw new Error(`web fallback URL was not printed. stdout=${stdout()} stderr=${stderr()}`);
}

async function waitForHealth(port, child, stdout, stderr) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://${host}:${port}/health`);
      const body = await response.json();
      if (response.ok && body.ok && Number(body.port) === port) return body;
    } catch {
      await delay(200);
    }
  }
  throw new Error(`web fallback health failed. stdout=${stdout()} stderr=${stderr()}`);
}

const occupier = await listenOccupier(occupiedPort);
let stdout = "";
let stderr = "";
const child = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "web", "--port", String(occupiedPort), "--host", host], {
  cwd: runtimeDir,
  env: {
    ...process.env,
    AGINTIFLOW_RUNTIME_DIR: runtimeDir,
    AGINTIFLOW_HOME: path.join(runtimeDir, ".agintiflow-home"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  const actualPort = await waitForPrintedPort(child, () => stdout.slice(-500), () => stderr.slice(-500));
  if (actualPort <= occupiedPort) {
    throw new Error(`web command did not move past occupied port ${occupiedPort}; got ${actualPort}`);
  }
  await waitForHealth(actualPort, child, () => stdout.slice(-500), () => stderr.slice(-500));
  console.log(`web port fallback smoke passed: ${occupiedPort} -> ${actualPort}`);
} finally {
  child.kill("SIGTERM");
  occupier.close();
  await fs.rm(runtimeDir, { recursive: true, force: true });
}
