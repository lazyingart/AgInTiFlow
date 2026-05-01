import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { evaluateCommandPolicy, normalizePackageInstallPolicy, normalizeSandboxMode } from "./command-policy.js";
import { redactSensitiveText, redactValue } from "./redaction.js";

const execFile = promisify(execFileCallback);
const DOCKER_WORKSPACE = "/workspace";
const DOCKER_HOME = "/aginti-home";
const DOCKER_CACHE = "/aginti-cache";
const DOCKER_ENV = "/aginti-env";
const READY_IMAGES = new Set();
const SANDBOX_LOG_LIMIT = 80;
const sandboxLogs = [];

function recordSandboxLog(type, data = {}) {
  sandboxLogs.push({
    at: new Date().toISOString(),
    type,
    data: redactValue(data),
  });
  while (sandboxLogs.length > SANDBOX_LOG_LIMIT) sandboxLogs.shift();
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildDockerInvocation(args) {
  return ["docker", ...args].map(shellEscape).join(" ");
}

async function execDocker(args, options = {}) {
  const execOptions = {
    timeout: options.timeout ?? 30000,
    maxBuffer: options.maxBuffer ?? 200 * 1024,
  };
  recordSandboxLog("docker.command", { args });

  try {
    const result = await execFile("docker", args, execOptions);
    return {
      stdout: redactSensitiveText(result.stdout),
      stderr: redactSensitiveText(result.stderr),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/permission denied|Got permission denied|connect: permission denied/i.test(message)) {
      throw error;
    }

    const result = await execFile("sg", ["docker", "-c", buildDockerInvocation(args)], execOptions);
    return {
      stdout: redactSensitiveText(result.stdout),
      stderr: redactSensitiveText(result.stderr),
    };
  }
}

async function dockerAvailable() {
  try {
    await execDocker(["version", "--format", "{{.Server.Version}}"], { timeout: 8000, maxBuffer: 16 * 1024 });
    return true;
  } catch (error) {
    recordSandboxLog("docker.unavailable", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function dockerImageExists(image) {
  try {
    await execDocker(["image", "inspect", image], {
      timeout: 10000,
      maxBuffer: 100 * 1024,
    });
    READY_IMAGES.add(image);
    return true;
  } catch {
    READY_IMAGES.delete(image);
    return false;
  }
}

async function pathAccess(targetPath, mode) {
  try {
    await fs.access(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

export function getSandboxLogs(limit = 30) {
  return sandboxLogs.slice(-limit);
}

function sandboxPackageDir(config) {
  return path.resolve(config.packageDir || config.baseDir || process.cwd());
}

function sandboxDockerfilePath(config) {
  return path.join(sandboxPackageDir(config), "docker", "sandbox.Dockerfile");
}

function persistentDockerDirs(config) {
  const root = path.resolve(
    config.dockerStateDir || process.env.AGINTIFLOW_DOCKER_STATE_DIR || path.join(os.homedir(), ".agintiflow", "docker")
  );
  return {
    root,
    home: path.join(root, "home"),
    cache: path.join(root, "cache"),
    env: path.join(root, "env"),
  };
}

async function ensurePersistentDockerDirs(config) {
  const dirs = persistentDockerDirs(config);
  await Promise.all([fs.mkdir(dirs.home, { recursive: true }), fs.mkdir(dirs.cache, { recursive: true }), fs.mkdir(dirs.env, { recursive: true })]);
  return dirs;
}

export async function getDockerSandboxStatus(config) {
  const image = config.dockerSandboxImage;
  const dockerfilePath = sandboxDockerfilePath(config);
  const workspace = config.commandCwd;
  if (config.useDockerSandbox) {
    await ensurePersistentDockerDirs(config).catch(() => null);
  }
  const [dockerReady, dockerfileExists, workspaceExists, workspaceReadable, workspaceWritable] = await Promise.all([
    dockerAvailable(),
    pathAccess(dockerfilePath, fsConstants.R_OK),
    pathAccess(workspace, fsConstants.F_OK),
    pathAccess(workspace, fsConstants.R_OK),
    pathAccess(workspace, fsConstants.W_OK),
  ]);

  const imageReady = dockerReady ? await dockerImageExists(image) : false;
  const persistentDirs = persistentDockerDirs(config);
  const [persistentHomeExists, persistentCacheExists, persistentEnvExists] = await Promise.all([
    pathAccess(persistentDirs.home, fsConstants.F_OK),
    pathAccess(persistentDirs.cache, fsConstants.F_OK),
    pathAccess(persistentDirs.env, fsConstants.F_OK),
  ]);
  return {
    sandboxMode: normalizeSandboxMode(config.sandboxMode),
    useDockerSandbox: Boolean(config.useDockerSandbox),
    packageInstallPolicy: normalizePackageInstallPolicy(config.packageInstallPolicy),
    image,
    dockerfilePath,
    dockerAvailable: dockerReady,
    imageReady,
    workspace,
    workspaceExists,
    workspaceReadable,
    workspaceWritable,
    dockerfileExists,
    persistentDocker: {
      home: persistentDirs.home,
      cache: persistentDirs.cache,
      env: persistentDirs.env,
      homeExists: persistentHomeExists,
      cacheExists: persistentCacheExists,
      envExists: persistentEnvExists,
      containerHome: DOCKER_HOME,
      containerCache: DOCKER_CACHE,
      containerEnv: DOCKER_ENV,
      pythonVenv: `${DOCKER_ENV}/python`,
    },
    logs: getSandboxLogs(),
  };
}

async function buildDockerSandboxImage(config, observers) {
  const image = config.dockerSandboxImage;
  const packageDir = sandboxPackageDir(config);
  const dockerfilePath = sandboxDockerfilePath(config);
  observers?.log?.("docker.building", {
    image,
    dockerfilePath,
  });
  recordSandboxLog("docker.building", { image, dockerfilePath });

  await execDocker(["build", "-t", image, "-f", dockerfilePath, packageDir], {
    timeout: 10 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  });

  READY_IMAGES.add(image);
  observers?.event?.("docker.ready", { image });
  recordSandboxLog("docker.ready", { image });
}

export async function ensureDockerSandboxReady(config, observers, options = {}) {
  const image = config.dockerSandboxImage;
  if (!config.useDockerSandbox || (READY_IMAGES.has(image) && !options.forceBuild)) return;

  const dockerfilePath = sandboxDockerfilePath(config);
  await fs.access(dockerfilePath).catch(() => {
    throw new Error(`Docker sandbox file is missing: ${dockerfilePath}`);
  });

  if (!options.forceBuild && (await dockerImageExists(image))) return;

  await buildDockerSandboxImage(config, observers);
}

function dockerCommand(command, policy) {
  const envLines = [
    `export HOME=${DOCKER_HOME}`,
    `export XDG_CACHE_HOME=${DOCKER_CACHE}`,
    `export PIP_CACHE_DIR=${DOCKER_CACHE}/pip`,
    `export UV_CACHE_DIR=${DOCKER_CACHE}/uv`,
    `export NPM_CONFIG_CACHE=${DOCKER_CACHE}/npm`,
    `export CONDA_PKGS_DIRS=${DOCKER_CACHE}/conda-pkgs`,
    `export PYTHONUSERBASE=${DOCKER_ENV}/python-user`,
    `export PATH=${DOCKER_ENV}/python/bin:${DOCKER_ENV}/python-user/bin:${DOCKER_ENV}/miniforge/bin:${DOCKER_ENV}/bin:$PATH`,
    `cd ${DOCKER_WORKSPACE}`,
  ];

  if (!policy.requiresDockerRoot) {
    envLines.push(
      `if command -v python3 >/dev/null 2>&1 && [ ! -x ${DOCKER_ENV}/python/bin/python ]; then python3 -m venv --system-site-packages ${DOCKER_ENV}/python >/dev/null 2>&1 || true; fi`,
      `if [ -f ${DOCKER_ENV}/python/bin/activate ]; then . ${DOCKER_ENV}/python/bin/activate; fi`
    );
  }

  return [...envLines, String(command)].join("\n");
}

function dockerRunArgs(command, config, policy = evaluateCommandPolicy(command, config), persistentDirs = persistentDockerDirs(config)) {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  const gid = typeof process.getgid === "function" ? String(process.getgid()) : "";
  const userArgs = uid && gid && !policy.requiresDockerRoot ? ["--user", `${uid}:${gid}`] : [];
  const sandboxMode = normalizeSandboxMode(config.sandboxMode);
  const mountMode = sandboxMode === "docker-workspace" ? "rw" : "ro";
  const networkMode = policy.needsNetwork ? "bridge" : "none";
  const toolchain = policy.category === "toolchain";
  const readOnlyArgs =
    mountMode === "ro"
      ? ["--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m"]
      : ["--tmpfs", `/tmp:rw,nosuid,nodev,size=${toolchain ? "512m" : "256m"}`];

  return [
    "run",
    "--rm",
    "--network",
    networkMode,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    toolchain ? "2g" : "768m",
    "--cpus",
    toolchain ? "2" : "1.5",
    ...readOnlyArgs,
    ...userArgs,
    "-e",
    "NPM_CONFIG_USERCONFIG=/tmp/.npmrc",
    "-e",
    "PIP_DISABLE_PIP_VERSION_CHECK=1",
    "-v",
    `${config.commandCwd}:${DOCKER_WORKSPACE}:${mountMode}`,
    "-v",
    `${persistentDirs.home}:${DOCKER_HOME}:rw`,
    "-v",
    `${persistentDirs.cache}:${DOCKER_CACHE}:rw`,
    "-v",
    `${persistentDirs.env}:${DOCKER_ENV}:rw`,
    "-w",
    DOCKER_WORKSPACE,
    config.dockerSandboxImage,
    "bash",
    "-lc",
    dockerCommand(command, policy),
  ];
}

export async function runDockerSandboxCommand(command, config, policy = evaluateCommandPolicy(command, config)) {
  const persistentDirs = await ensurePersistentDockerDirs(config);
  const result = await execDocker(dockerRunArgs(command, config, policy, persistentDirs), {
    timeout: policy.needsNetwork ? 120000 : policy.category === "toolchain" ? 90000 : 15000,
    maxBuffer: 300 * 1024,
  });

  const payload = {
    stdout: result.stdout.trim().slice(0, 12000),
    stderr: result.stderr.trim().slice(0, 6000),
  };
  recordSandboxLog("sandbox.command.completed", {
    command,
    category: policy.category,
    sandboxMode: policy.sandboxMode,
    network: policy.needsNetwork ? "bridge" : "none",
    persistentDocker: persistentDirs,
    stdout: payload.stdout.slice(0, 1200),
    stderr: payload.stderr.slice(0, 1200),
  });
  return payload;
}

async function detectWorkspaceManifests(workspace) {
  const candidates = ["package.json", "package-lock.json", "requirements.txt", "pyproject.toml", "environment.yml"];
  const manifests = [];
  for (const candidate of candidates) {
    if (await pathAccess(path.join(workspace, candidate), fsConstants.R_OK)) manifests.push(candidate);
  }
  return manifests;
}

export async function runDockerPreflight(config, options = {}) {
  const buildImage = Boolean(options.buildImage);
  const statusBefore = await getDockerSandboxStatus(config);
  const manifests = await detectWorkspaceManifests(config.commandCwd);
  let checks = [];

  if (!config.useDockerSandbox || normalizeSandboxMode(config.sandboxMode) === "host") {
    const result = {
      ok: Boolean(statusBefore.workspaceExists && statusBefore.workspaceReadable),
      status: statusBefore,
      manifests,
      checks,
      logs: getSandboxLogs(),
    };
    recordSandboxLog("sandbox.preflight.completed", {
      ok: result.ok,
      mode: "host",
      manifests,
      checks: [],
    });
    return result;
  }

  if (buildImage && statusBefore.dockerAvailable && statusBefore.dockerfileExists && !statusBefore.imageReady) {
    await ensureDockerSandboxReady(config, {
      log: (message, data) => recordSandboxLog(message, data),
      event: (type, data) => recordSandboxLog(type, data),
    });
  }

  let status = await getDockerSandboxStatus(config);
  const runChecks = async () => {
    const persistentDirs = await ensurePersistentDockerDirs(config);
    const results = [];
    for (const command of [
      "node -v",
      "npm -v",
      "python3 --version",
      "python3 -m pip --version",
      "python3 -c \"import matplotlib, numpy; print(matplotlib.__version__, numpy.__version__)\"",
      "latexmk -version",
      "pdflatex --version",
      "git --version",
      "rg --version",
    ]) {
      try {
        const result = await execDocker(dockerRunArgs(command, config, { needsNetwork: false, category: "preflight" }, persistentDirs), {
          timeout: 15000,
          maxBuffer: 100 * 1024,
        });
        results.push({ command, ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
      } catch (error) {
        results.push({
          command,
          ok: false,
          error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    return results;
  };

  if (status.imageReady) {
    checks = await runChecks();
    if (buildImage && checks.some((check) => !check.ok)) {
      recordSandboxLog("docker.rebuilding-stale-image", {
        image: config.dockerSandboxImage,
        failedChecks: checks.filter((check) => !check.ok).map((check) => check.command),
      });
      await ensureDockerSandboxReady(
        config,
        {
          log: (message, data) => recordSandboxLog(message, data),
          event: (type, data) => recordSandboxLog(type, data),
        },
        { forceBuild: true }
      );
      status = await getDockerSandboxStatus(config);
      checks = await runChecks();
    }
  }

  const result = {
    ok: Boolean(status.dockerAvailable && status.workspaceReadable && status.dockerfileExists && status.imageReady),
    status,
    manifests,
    checks,
    logs: getSandboxLogs(),
  };
  recordSandboxLog("sandbox.preflight.completed", {
    ok: result.ok,
    manifests,
    checks: checks.map((check) => ({ command: check.command, ok: check.ok })),
  });
  return result;
}
