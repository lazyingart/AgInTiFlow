import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DOCKER_WORKSPACE = "/workspace";
const READY_IMAGES = new Set();

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildDockerInvocation(args) {
  return ["docker", ...args].map(shellEscape).join(" ");
}

async function execDocker(args, options = {}) {
  return execFile("sg", ["docker", "-c", buildDockerInvocation(args)], {
    timeout: options.timeout ?? 30000,
    maxBuffer: options.maxBuffer ?? 200 * 1024,
  });
}

export async function ensureDockerSandboxReady(config, observers) {
  const image = config.dockerSandboxImage;
  if (!config.useDockerSandbox || READY_IMAGES.has(image)) return;

  const dockerfilePath = path.join(config.baseDir, "docker", "sandbox.Dockerfile");
  await fs.access(dockerfilePath).catch(() => {
    throw new Error(`Docker sandbox file is missing: ${dockerfilePath}`);
  });

  try {
    await execDocker(["image", "inspect", image], {
      timeout: 10000,
      maxBuffer: 100 * 1024,
    });
    READY_IMAGES.add(image);
    return;
  } catch {
    observers?.log?.("docker.building", {
      image,
      dockerfilePath,
    });
  }

  await execDocker(["build", "-t", image, "-f", dockerfilePath, config.baseDir], {
    timeout: 10 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  });

  READY_IMAGES.add(image);
  observers?.event?.("docker.ready", { image });
}

export async function runDockerSandboxCommand(command, config) {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  const gid = typeof process.getgid === "function" ? String(process.getgid()) : "";
  const userArgs = uid && gid ? ["--user", `${uid}:${gid}`] : [];
  const result = await execDocker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "512m",
      "--cpus",
      "1.0",
      ...userArgs,
      "-v",
      `${config.commandCwd}:${DOCKER_WORKSPACE}`,
      "-w",
      DOCKER_WORKSPACE,
      config.dockerSandboxImage,
      "bash",
      "-lc",
      String(command),
    ],
    {
      timeout: 10000,
      maxBuffer: 200 * 1024,
    }
  );

  return {
    stdout: result.stdout.trim().slice(0, 8000),
    stderr: result.stderr.trim().slice(0, 4000),
  };
}
