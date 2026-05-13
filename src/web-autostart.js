import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3210;
const MAX_PORT_ATTEMPTS = 50;

function normalizeHost(host) {
  return String(host || process.env.AGINTI_WEB_HOST || process.env.HOST || DEFAULT_HOST).trim() || DEFAULT_HOST;
}

function normalizePort(port) {
  const parsed = Number(port || process.env.AGINTI_WEB_PORT || process.env.PORT || DEFAULT_PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

function webUrl(host, port) {
  return `http://${host}:${port}`;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left = "", right = "") {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function defaultAgintiflowHome() {
  return path.join(os.homedir(), ".agintiflow");
}

function isLikelyTransientPath(value = "") {
  if (!value) return false;
  const resolved = path.resolve(value);
  const tmp = path.resolve(os.tmpdir());
  return isInside(tmp, resolved) || /agintiflow-(cli-chat|webapp-command|web-autostart|web-port|smoke|test)-/i.test(resolved);
}

function resolveWebHome(home = "") {
  const explicit = home || process.env.AGINTIFLOW_WEB_HOME || process.env.AGINTI_WEB_HOME || "";
  if (explicit) return path.resolve(explicit);
  const inherited = process.env.AGINTIFLOW_HOME || "";
  if (inherited && !isLikelyTransientPath(inherited)) return path.resolve(inherited);
  return defaultAgintiflowHome();
}

function resolveRuntimeDir(cwd = "") {
  return path.resolve(process.env.AGINTIFLOW_WEB_RUNTIME_DIR || cwd || process.cwd());
}

function webPreferencePath(home = "") {
  return path.join(resolveWebHome(home), "webapp.json");
}

export async function readWebAppPreference({ home = "" } = {}) {
  const file = webPreferencePath(home);
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    return { autoStart: data.autoStart !== false, path: file };
  } catch {
    return { autoStart: true, path: file };
  }
}

export async function writeWebAppPreference({ home = "", autoStart = true } = {}) {
  const file = webPreferencePath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ autoStart: Boolean(autoStart), updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return await readWebAppPreference({ home });
}

async function webAutoStartDisabled(home = "") {
  if (process.env.AGINTI_NO_WEB_AUTO_START === "1" || process.env.AGINTIFLOW_NO_WEB_AUTO_START === "1") return true;
  return (await readWebAppPreference({ home })).autoStart === false;
}

function fetchHealthDetails(host, port, timeoutMs = 450) {
  return new Promise((resolve) => {
    const req = http.get(`${webUrl(host, port)}/health`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(body || "{}");
          resolve({
            ok: Boolean(res.statusCode === 200 && json.ok && (json.app === "agintiflow" || Number(json.port) === port)),
            statusCode: res.statusCode,
            ...json,
          });
        } catch {
          resolve({ ok: false });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.on("error", () => resolve({ ok: false }));
  });
}

async function fetchHealth(host, port, timeoutMs = 450) {
  return (await fetchHealthDetails(host, port, timeoutMs)).ok;
}

function canListen(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForHealth(host, port, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchHealth(host, port, 350)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function compatibleHealth(health = {}, { cwd = "", home = "", packageDir = "" } = {}) {
  if (!health.ok || health.app !== "agintiflow") return false;
  if (!health.runtimeDir || !health.agintiflowHome) return false;
  if (!samePath(health.runtimeDir, cwd)) return false;
  if (!samePath(health.agintiflowHome, home)) return false;
  if (health.packageDir && packageDir && !samePath(health.packageDir, packageDir)) return false;
  return true;
}

function listenerPids(port) {
  return new Promise((resolve) => {
    execFile("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(
        String(stdout || "")
          .split(/\s+/)
          .map((value) => Number(value))
          .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
      );
    });
  });
}

async function waitForPortRelease(host, port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchHealth(host, port, 220)) && (await canListen(host, port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function stopWebAppOnPort({ host, port, health = {} } = {}) {
  const pids = new Set();
  if (Number.isInteger(Number(health.pid)) && Number(health.pid) > 0) pids.add(Number(health.pid));
  for (const pid of await listenerPids(port)) pids.add(pid);
  if (pids.size === 0) return { ok: false, error: `Could not identify AgInTiFlow webapp process on ${host}:${port}.` };

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already stopped or not owned by this user.
    }
  }
  if (await waitForPortRelease(host, port, 3500)) return { ok: true, pids: [...pids], forced: false };

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore.
    }
  }
  const released = await waitForPortRelease(host, port, 2000);
  return released
    ? { ok: true, pids: [...pids], forced: true }
    : { ok: false, pids: [...pids], error: `AgInTiFlow webapp on ${host}:${port} did not stop.` };
}

export async function stopAgintiWebApp({
  packageDir = process.cwd(),
  cwd = process.cwd(),
  home = "",
  host = DEFAULT_HOST,
  preferredPort = DEFAULT_PORT,
  force = false,
} = {}) {
  const normalizedHost = normalizeHost(host);
  const port = normalizePort(preferredPort);
  const url = webUrl(normalizedHost, port);
  const runtimeDir = resolveRuntimeDir(cwd);
  const homeDir = resolveWebHome(home);
  const health = await fetchHealthDetails(normalizedHost, port);

  if (!health.ok) {
    if (await canListen(normalizedHost, port)) {
      return { ok: true, stopped: false, alreadyStopped: true, host: normalizedHost, port, url, runtimeDir, agintiflowHome: homeDir };
    }
    return { ok: false, stopped: false, host: normalizedHost, port, url, error: `No AgInTiFlow health endpoint responded on ${url}.` };
  }

  if (!force && !compatibleHealth(health, { cwd: runtimeDir, home: homeDir, packageDir })) {
    return {
      ok: false,
      stopped: false,
      host: normalizedHost,
      port,
      url,
      runtimeDir,
      agintiflowHome: homeDir,
      health,
      error: `Refusing to stop AgInTiFlow webapp on ${url} because it belongs to a different project or home.`,
    };
  }

  const stopped = await stopWebAppOnPort({ host: normalizedHost, port, health });
  return {
    ok: Boolean(stopped.ok),
    stopped: Boolean(stopped.ok),
    alreadyStopped: false,
    host: normalizedHost,
    port,
    url,
    runtimeDir,
    agintiflowHome: homeDir,
    health,
    ...stopped,
  };
}

export async function findReusableOrFreeWebPort({
  host = DEFAULT_HOST,
  preferredPort = DEFAULT_PORT,
  attempts = MAX_PORT_ATTEMPTS,
  cwd = process.cwd(),
  home = "",
  packageDir = process.cwd(),
  restart = false,
} = {}) {
  const startPort = normalizePort(preferredPort);
  const normalizedHost = normalizeHost(host);
  const runtimeDir = resolveRuntimeDir(cwd);
  const homeDir = resolveWebHome(home);
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    if (port >= 65536) break;
    const health = await fetchHealthDetails(normalizedHost, port);
    if (health.ok) {
      const compatible = compatibleHealth(health, { cwd: runtimeDir, home: homeDir, packageDir });
      if (restart && compatible) {
        const stopped = await stopWebAppOnPort({ host: normalizedHost, port, health });
        if (!stopped.ok) return { port, host: normalizedHost, url: "", reused: false, available: false, stopped, error: stopped.error };
        return {
          port,
          host: normalizedHost,
          url: webUrl(normalizedHost, port),
          reused: false,
          available: true,
          restarted: true,
          stopped,
        };
      }
      if (compatible) {
        return { port, host: normalizedHost, url: webUrl(normalizedHost, port), reused: true, available: false, health };
      }
      continue;
    }
    if (await canListen(normalizedHost, port)) {
      return { port, host: normalizedHost, url: webUrl(normalizedHost, port), reused: false, available: true };
    }
  }
  return { port: 0, host: normalizedHost, url: "", reused: false, available: false };
}

export async function ensureAgintiWebApp({
  packageDir = process.cwd(),
  cwd = process.cwd(),
  home = "",
  host = DEFAULT_HOST,
  preferredPort = DEFAULT_PORT,
  language = "",
  restart = false,
  respectAutoStartDisable = true,
} = {}) {
  if (respectAutoStartDisable && (await webAutoStartDisabled(home))) {
    return { ok: false, disabled: true, url: "" };
  }

  const runtimeDir = resolveRuntimeDir(cwd);
  const homeDir = resolveWebHome(home);
  const candidate = await findReusableOrFreeWebPort({ host, preferredPort, cwd: runtimeDir, home: homeDir, packageDir, restart });
  if (!candidate.port) {
    return { ok: false, error: candidate.error || `No available AgInTiFlow web port from ${normalizePort(preferredPort)}.`, url: "" };
  }
  if (candidate.error || (!candidate.available && !candidate.reused)) {
    return { ok: false, error: candidate.error || `No reusable or free AgInTiFlow web port from ${normalizePort(preferredPort)}.`, url: "" };
  }
  if (candidate.reused) {
    return { ok: true, reused: true, started: false, runtimeDir, agintiflowHome: homeDir, ...candidate };
  }

  const child = spawn(process.execPath, [path.join(packageDir, "web.js")], {
    cwd: runtimeDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HOST: candidate.host,
      PORT: String(candidate.port),
      AGINTIFLOW_RUNTIME_DIR: runtimeDir,
      AGINTIFLOW_HOME: homeDir,
      AGINTIFLOW_PACKAGE_DIR: packageDir,
      ...(language ? { AGINTI_LANGUAGE: language } : {}),
    },
  });
  child.unref();

  const healthy = await waitForHealth(candidate.host, candidate.port);
  return healthy
    ? {
        ok: true,
        reused: false,
        started: true,
        restarted: Boolean(candidate.restarted),
        stopped: candidate.stopped,
        pid: child.pid,
        runtimeDir,
        agintiflowHome: homeDir,
        ...candidate,
      }
    : { ok: false, error: `Started web process ${child.pid}, but ${candidate.url}/health did not become ready.`, url: "" };
}
