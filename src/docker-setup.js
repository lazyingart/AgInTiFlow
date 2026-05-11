import os from "node:os";
import path from "node:path";
import { platformInfo, platformLabel, platformSetupHints } from "./platform.js";

function latexStatusFromChecks(checks = []) {
  const latexChecks = checks.filter((check) => /latexmk|pdflatex/i.test(check.command || ""));
  if (!latexChecks.length) return "unchecked";
  return latexChecks.every((check) => check.ok) ? "ready" : "missing";
}

export function dockerHostInstallPlan(packageDir = process.cwd(), info = platformInfo()) {
  const hints = platformSetupHints(info);
  const script = path.join(packageDir, "scripts", "install-docker-ubuntu.sh");
  if (info.isMac) {
    return {
      supported: false,
      platform: platformLabel(info),
      command: "Install Docker Desktop or Colima, then run: aginti docker setup",
      hints,
    };
  }
  if (info.isWindows && !info.isWsl) {
    return {
      supported: false,
      platform: platformLabel(info),
      command: "Use WSL2 with Docker Desktop WSL integration, then run: aginti docker setup inside WSL",
      hints,
    };
  }
  if (info.isLinux && info.linuxFamily === "debian" && /ubuntu/i.test(`${info.linuxId} ${info.distro}`)) {
    return {
      supported: true,
      platform: platformLabel(info),
      command: script,
      hints,
    };
  }
  return {
    supported: false,
    platform: platformLabel(info),
    command: "Install a Docker-compatible engine with your OS package manager, then run: aginti docker setup",
    hints,
  };
}

export function summarizeDockerSetup({ status, preflight = null, packageDir = process.cwd() } = {}) {
  const info = platformInfo();
  const install = dockerHostInstallPlan(packageDir, info);
  const checks = preflight?.checks || [];
  const failedChecks = checks.filter((check) => !check.ok);
  const latex = latexStatusFromChecks(checks);
  return {
    platform: platformLabel(info),
    sandboxMode: status?.sandboxMode || "unknown",
    packageInstallPolicy: status?.packageInstallPolicy || "unknown",
    dockerAvailable: Boolean(status?.dockerAvailable),
    image: status?.image || "agintiflow-sandbox:latest",
    imageReady: Boolean(status?.imageReady),
    dockerfileExists: Boolean(status?.dockerfileExists),
    workspace: status?.workspace || process.cwd(),
    persistentDocker: status?.persistentDocker || {},
    latex,
    preflightOk: preflight ? Boolean(preflight.ok && failedChecks.length === 0) : undefined,
    failedChecks: failedChecks.map((check) => check.command || check.error || "unknown"),
    install,
  };
}

export function formatDockerSetupText(summary = {}) {
  const lines = [
    "AgInTiFlow Docker setup",
    `platform=${summary.platform || `${os.type()} (${process.arch})`}`,
    `sandbox=${summary.sandboxMode || "unknown"} installs=${summary.packageInstallPolicy || "unknown"}`,
    `docker=${summary.dockerAvailable ? "available" : "missing"} image=${summary.image || "agintiflow-sandbox:latest"} ${
      summary.imageReady ? "ready" : "not-ready"
    }`,
    `dockerfile=${summary.dockerfileExists ? "present" : "missing"}`,
    `workspace=${summary.workspace || process.cwd()}`,
  ];

  if (summary.persistentDocker?.root || summary.persistentDocker?.env) {
    lines.push(`persistent=${summary.persistentDocker.root || path.dirname(summary.persistentDocker.env)}`);
  }
  if (summary.latex && summary.latex !== "unchecked") lines.push(`latex=${summary.latex}`);
  if (summary.preflightOk !== undefined) lines.push(`preflight=${summary.preflightOk ? "passed" : "failed"}`);
  if (summary.failedChecks?.length) {
    lines.push(`failedChecks=${summary.failedChecks.join(", ")}`);
  }

  lines.push("");
  if (!summary.dockerAvailable) {
    lines.push("Docker is not available.");
    lines.push(`Install path: ${summary.install?.command || "Install Docker, then run: aginti docker setup"}`);
  } else if (!summary.imageReady || summary.preflightOk === false) {
    lines.push("Next: aginti docker setup");
  } else {
    lines.push("Docker sandbox is ready for normal-mode package setup and LaTeX/PDF work.");
  }

  if (summary.install?.hints?.length) {
    lines.push("");
    lines.push("Platform notes:");
    for (const hint of summary.install.hints) lines.push(`- ${hint}`);
  }

  return lines.join("\n");
}
