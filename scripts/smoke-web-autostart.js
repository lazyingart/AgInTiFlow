#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAgintiWebApp } from "../src/web-autostart.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-web-autostart-"));
const homeDir = path.join(runtimeDir, "stable-web-home");
const inheritedHome = path.join(runtimeDir, "leaked-cli-home");
const preferredPort = 44500 + Math.floor(Math.random() * 1000);
let childPid = 0;
const originalHome = process.env.AGINTIFLOW_HOME;

try {
  process.env.AGINTIFLOW_HOME = inheritedHome;
  const first = await ensureAgintiWebApp({
    packageDir: repoRoot,
    cwd: runtimeDir,
    home: homeDir,
    preferredPort,
    host: "127.0.0.1",
  });
  if (!first.ok || !first.started || !first.url.includes(`:${preferredPort}`)) {
    throw new Error(`expected auto-start on preferred port, got ${JSON.stringify(first)}`);
  }
  childPid = Number(first.pid) || 0;
  const health = await fetch(`${first.url}/health`).then((response) => response.json());
  if (!health.ok || Number(health.port) !== preferredPort) {
    throw new Error(`auto-started web health was invalid: ${JSON.stringify(health)}`);
  }
  if (path.resolve(health.agintiflowHome) !== path.resolve(homeDir) || path.resolve(health.runtimeDir) !== path.resolve(runtimeDir)) {
    throw new Error(`auto-started webapp inherited the wrong context: ${JSON.stringify(health)}`);
  }
  const second = await ensureAgintiWebApp({
    packageDir: repoRoot,
    cwd: runtimeDir,
    home: homeDir,
    preferredPort,
    host: "127.0.0.1",
  });
  if (!second.ok || !second.reused || second.url !== first.url) {
    throw new Error(`expected second auto-start call to reuse existing webapp, got ${JSON.stringify(second)}`);
  }
  const restarted = await ensureAgintiWebApp({
    packageDir: repoRoot,
    cwd: runtimeDir,
    home: homeDir,
    preferredPort,
    host: "127.0.0.1",
    restart: true,
  });
  if (!restarted.ok || !restarted.restarted || restarted.url !== first.url || Number(restarted.pid) === childPid) {
    throw new Error(`expected restart on same URL with a new pid, got ${JSON.stringify(restarted)}`);
  }
  childPid = Number(restarted.pid) || childPid;
  console.log(`web auto-start smoke passed: ${first.url}`);
} finally {
  if (originalHome === undefined) delete process.env.AGINTIFLOW_HOME;
  else process.env.AGINTIFLOW_HOME = originalHome;
  if (childPid) {
    try {
      process.kill(childPid, "SIGTERM");
    } catch {
      // The child may have already exited during a failed smoke test.
    }
  }
  await fs.rm(runtimeDir, { recursive: true, force: true });
}
