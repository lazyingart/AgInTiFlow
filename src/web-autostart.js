import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
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

function fetchHealth(host, port, timeoutMs = 450) {
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
          resolve(Boolean(res.statusCode === 200 && json.ok && (json.app === "agintiflow" || Number(json.port) === port)));
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
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

export async function findReusableOrFreeWebPort({ host = DEFAULT_HOST, preferredPort = DEFAULT_PORT, attempts = MAX_PORT_ATTEMPTS } = {}) {
  const startPort = normalizePort(preferredPort);
  const normalizedHost = normalizeHost(host);
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    if (port >= 65536) break;
    if (await fetchHealth(normalizedHost, port)) {
      return { port, host: normalizedHost, url: webUrl(normalizedHost, port), reused: true, available: false };
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
  host = DEFAULT_HOST,
  preferredPort = DEFAULT_PORT,
  language = "",
  respectAutoStartDisable = true,
} = {}) {
  if (respectAutoStartDisable && (process.env.AGINTI_NO_WEB_AUTO_START === "1" || process.env.AGINTIFLOW_NO_WEB_AUTO_START === "1")) {
    return { ok: false, disabled: true, url: "" };
  }

  const candidate = await findReusableOrFreeWebPort({ host, preferredPort });
  if (!candidate.port) {
    return { ok: false, error: `No available AgInTiFlow web port from ${normalizePort(preferredPort)}.`, url: "" };
  }
  if (candidate.reused) {
    return { ok: true, reused: true, started: false, ...candidate };
  }

  const child = spawn(process.execPath, [path.join(packageDir, "web.js")], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HOST: candidate.host,
      PORT: String(candidate.port),
      AGINTIFLOW_RUNTIME_DIR: cwd,
      AGINTIFLOW_PACKAGE_DIR: packageDir,
      ...(language ? { AGINTI_LANGUAGE: language } : {}),
    },
  });
  child.unref();

  const healthy = await waitForHealth(candidate.host, candidate.port);
  return healthy
    ? { ok: true, reused: false, started: true, pid: child.pid, ...candidate }
    : { ok: false, error: `Started web process ${child.pid}, but ${candidate.url}/health did not become ready.`, url: "" };
}
