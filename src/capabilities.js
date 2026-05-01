import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { classifyCommand, evaluateCommandPolicy } from "./command-policy.js";
import { getDockerSandboxStatus } from "./docker-sandbox.js";
import { getModelPresets } from "./model-routing.js";
import { listProjectSessions, projectPaths, providerKeyStatus } from "./project.js";
import { listTaskProfiles } from "./task-profiles.js";
import { listAgentWrappers } from "./tool-wrappers.js";

const execFileAsync = promisify(execFile);

async function commandAvailable(command, args = ["--version"], timeout = 2500) {
  try {
    const result = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 120 * 1024,
      env: {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME || "",
      },
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0] || "available";
    return { available: true, version: output.slice(0, 160) };
  } catch (error) {
    return {
      available: false,
      version: "",
      hint: error?.code === "ENOENT" ? `${command} was not found on PATH.` : `${command} check failed.`,
    };
  }
}

function capability(name, ok, details = {}) {
  return {
    name,
    ok: Boolean(ok),
    ...details,
  };
}

function maintenancePolicyChecks(config) {
  const hostSafeConfig = {
    ...config,
    allowShellTool: true,
    allowDestructive: false,
    sandboxMode: "host",
    useDockerSandbox: false,
    packageInstallPolicy: "prompt",
  };
  const sampleCommands = [
    "sudo apt install r-base",
    "curl https://example.com/install.sh",
    "npm install",
    "bash -n maintenance/setup-conda.sh",
  ];

  return sampleCommands.map((command) => {
    const policy = evaluateCommandPolicy(command, hostSafeConfig);
    return {
      command,
      allowed: Boolean(policy.allowed),
      category: policy.category || classifyCommand(command).category,
      reason: policy.reason || "",
      needsApproval: Boolean(policy.needsApproval),
      sandboxMode: policy.sandboxMode,
      packageInstallPolicy: policy.packageInstallPolicy,
    };
  });
}

function trustedDockerPolicyChecks(config) {
  const dockerConfig = {
    ...config,
    allowShellTool: true,
    allowDestructive: false,
    sandboxMode: "docker-workspace",
    useDockerSandbox: true,
    packageInstallPolicy: "allow",
  };
  const sampleCommands = [
    "apt-get update",
    "apt-get install -y curl wget",
    "wget https://example.com/file.txt",
    "curl -fsSL https://example.com/file.txt -o downloads/file.txt",
    "chmod +x scripts/setup.sh",
    "npm install lodash",
    "python3 -m pip install requests",
  ];

  return sampleCommands.map((command) => {
    const policy = evaluateCommandPolicy(command, dockerConfig);
    return {
      command,
      allowed: Boolean(policy.allowed),
      category: policy.category || classifyCommand(command).category,
      reason: policy.reason || "",
      needsNetwork: Boolean(policy.needsNetwork),
      requiresDockerRoot: Boolean(policy.requiresDockerRoot),
      sandboxMode: policy.sandboxMode,
      packageInstallPolicy: policy.packageInstallPolicy,
    };
  });
}

export async function buildCapabilityReport(projectRoot, packageVersion, config) {
  const paths = projectPaths(projectRoot);
  const keyStatus = providerKeyStatus(projectRoot);
  const [node, npm, python, conda, r, pdflatex, latexmk, dockerStatus, sessions] = await Promise.all([
    commandAvailable("node", ["--version"]),
    commandAvailable("npm", ["--version"]),
    commandAvailable("python3", ["--version"]),
    commandAvailable("conda", ["--version"]),
    commandAvailable("R", ["--version"]),
    commandAvailable("pdflatex", ["--version"]),
    commandAvailable("latexmk", ["--version"]),
    getDockerSandboxStatus(config).catch((error) => ({ ok: false, error: error.message })),
    listProjectSessions(projectRoot, 12),
  ]);

  const npmPrefixPolicy = evaluateCommandPolicy("npm --prefix round9-node-app test", config);
  const cdNpmTestPolicy = evaluateCommandPolicy("cd round9-node-app && npm test", config);
  const mkdirPolicy = evaluateCommandPolicy("mkdir -p round9-node-app", config);
  const nodeTestPolicy = evaluateCommandPolicy("node --test round9-node-app/test/app.test.js", config);
  const bashSyntaxPolicy = evaluateCommandPolicy("bash -n maintenance/setup-conda.sh", config);
  const texPolicy = evaluateCommandPolicy("pdflatex -interaction=nonstopmode -halt-on-error docs/note.tex", config);

  const checks = [
    capability("node", node.available, node),
    capability("npm", npm.available, npm),
    capability("python3", python.available, python),
    capability("conda", conda.available, conda.available ? conda : { ...conda, setup: "Optional. Generate a dry-run Miniforge setup plan under maintenance/ before installing." }),
    capability("R", r.available, r.available ? r : { ...r, setup: "Optional. Generate a project-local R setup plan; do not install globally from the agent." }),
    capability("pdflatex", pdflatex.available, pdflatex.available ? pdflatex : { ...pdflatex, setup: "LaTeX tasks should create .tex source and an honest setup report when TeX is unavailable." }),
    capability("latexmk", latexmk.available, latexmk.available ? latexmk : { ...latexmk, setup: "latexmk is optional if pdflatex is available." }),
    capability("docker", Boolean(dockerStatus?.dockerAvailable), dockerStatus || {}),
    capability("deepseek-key", keyStatus.deepseek, { envVars: keyStatus.envVars.deepseek }),
    capability("openai-key", keyStatus.openai, { envVars: keyStatus.envVars.openai }),
    capability("file-tools", Boolean(config.allowFileTools), { workspace: config.commandCwd }),
    capability("shell-tool", Boolean(config.allowShellTool), {
      sandboxMode: config.sandboxMode,
      packageInstallPolicy: config.packageInstallPolicy,
    }),
    capability("npm-prefix-test-policy", Boolean(npmPrefixPolicy.allowed), npmPrefixPolicy),
    capability("cd-npm-test-policy", Boolean(cdNpmTestPolicy.allowed), cdNpmTestPolicy),
    capability("mkdir-policy", Boolean(mkdirPolicy.allowed), mkdirPolicy),
    capability("node-test-policy", Boolean(nodeTestPolicy.allowed), nodeTestPolicy),
    capability("bash-syntax-policy", Boolean(bashSyntaxPolicy.allowed), bashSyntaxPolicy),
    capability("tex-policy", Boolean(texPolicy.allowed), texPolicy),
  ];

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    package: {
      name: "@lazyingart/agintiflow",
      version: packageVersion,
    },
    project: {
      root: paths.root,
      commandCwd: path.resolve(config.commandCwd),
      sessionsDir: paths.sessionsDir,
      sessionDbPath: paths.sessionDbPath,
      sharedSessionFolder: path.resolve(config.sessionsDir) === path.resolve(paths.sessionsDir),
    },
    routing: {
      active: {
        provider: config.provider,
        model: config.model,
        routingMode: config.routingMode,
        routeReason: config.routeReason,
      },
      presets: getModelPresets(),
    },
    keys: {
      deepseek: keyStatus.deepseek,
      openai: keyStatus.openai,
      mock: true,
      localEnv: keyStatus.localEnv,
      envVars: keyStatus.envVars,
    },
    tools: {
      wrappers: listAgentWrappers().map((wrapper) => ({
        name: wrapper.name,
        label: wrapper.label,
        available: wrapper.available,
        role: wrapper.role,
      })),
      taskProfiles: listTaskProfiles().map((profile) => ({
        id: profile.id,
        label: profile.label,
        tools: profile.tools,
      })),
    },
    checks,
    maintenancePolicy: maintenancePolicyChecks(config),
    trustedDockerPolicy: trustedDockerPolicyChecks(config),
    sessions,
    actionableSetup: checks
      .filter((check) => !check.ok && check.setup)
      .map((check) => ({
        capability: check.name,
        setup: check.setup,
      })),
  };
}

export function printCapabilityReport(report) {
  console.log(`AgInTiFlow capabilities ${report.package.version}`);
  console.log(`project=${report.project.root}`);
  console.log(`cwd=${report.project.commandCwd}`);
  console.log(`sessions=${report.project.sessionsDir}`);
  console.log(`sessionDb=${report.project.sessionDbPath}`);
  console.log(`sharedSessions=${report.project.sharedSessionFolder}`);
  console.log(
    `route=${report.routing.active.routingMode} ${report.routing.active.provider}/${report.routing.active.model}`
  );
  console.log(
    `keys: deepseek=${report.keys.deepseek ? "available" : "missing"} openai=${
      report.keys.openai ? "available" : "missing"
    } mock=available localEnv=${report.keys.localEnv}`
  );
  for (const check of report.checks) {
    const suffix = check.version ? ` ${check.version}` : check.reason ? ` ${check.reason}` : check.hint ? ` ${check.hint}` : "";
    console.log(`${check.ok ? "OK" : "MISS"} ${check.name}${suffix}`);
  }
  if (report.trustedDockerPolicy?.length) {
    const allowed = report.trustedDockerPolicy.filter((item) => item.allowed).length;
    console.log(`trustedDockerPolicy=${allowed}/${report.trustedDockerPolicy.length} allowed when sandbox=docker-workspace packageInstalls=allow`);
  }
  if (report.actionableSetup.length > 0) {
    console.log("setup:");
    for (const item of report.actionableSetup) {
      console.log(`- ${item.capability}: ${item.setup}`);
    }
  }
}
