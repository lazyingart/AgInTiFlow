import fs from "node:fs";
import os from "node:os";

function parseOsRelease() {
  if (process.platform !== "linux") return {};
  try {
    const content = fs.readFileSync("/etc/os-release", "utf8");
    const data = {};
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      data[match[1].toLowerCase()] = match[2].replace(/^"|"$/g, "");
    }
    return data;
  } catch {
    return {};
  }
}

export function platformInfo() {
  const osRelease = parseOsRelease();
  const release = os.release();
  const isWsl = Boolean(process.env.WSL_DISTRO_NAME) || /microsoft|wsl/i.test(release);
  const linuxId = osRelease.id || "";
  const linuxLike = osRelease.id_like || "";
  const linuxFamily = /ubuntu|debian/i.test(`${linuxId} ${linuxLike}`)
    ? "debian"
    : /rhel|fedora|centos|rocky|almalinux|redhat/i.test(`${linuxId} ${linuxLike}`)
      ? "redhat"
      : process.platform === "linux"
        ? "linux"
        : "";

  return {
    platform: process.platform,
    arch: process.arch,
    release,
    type: os.type(),
    distro: osRelease.pretty_name || osRelease.name || "",
    linuxId,
    linuxFamily,
    isMac: process.platform === "darwin",
    isLinux: process.platform === "linux",
    isWindows: process.platform === "win32",
    isWsl,
  };
}

export function platformLabel(info = platformInfo()) {
  if (info.isWsl) return `WSL ${info.distro || info.linuxId || "Linux"} (${info.arch})`;
  if (info.isMac) return `macOS (${info.arch})`;
  if (info.isWindows) return `Windows (${info.arch})`;
  if (info.isLinux) return `${info.distro || "Linux"} (${info.arch})`;
  return `${info.platform} (${info.arch})`;
}

export function platformSetupHints(info = platformInfo()) {
  if (info.isWsl) {
    return [
      "Use the Linux/WSL shell as the primary AgInTiFlow environment; keep projects under the WSL filesystem for best file and Docker performance.",
      "Use Node.js 22+ from nvm/fnm/NodeSource; if an old ~/.npm-global/bin/aginti is earlier on PATH, reinstall AgInTiFlow after switching Node.",
      "Use Docker Desktop with WSL integration or Docker Engine inside WSL for docker-workspace mode.",
      "For LaTeX, reuse WSL latexmk/pdflatex when installed, or use the companion Docker sandbox image.",
    ];
  }
  if (info.isMac) {
    return [
      "Use Node.js 22+ from Homebrew, nvm, fnm, or the official installer.",
      "After changing Node versions, verify `node -v`, `which aginti`, and reinstall with `npm install -g @lazyingart/agintiflow@latest` so the CLI uses the same Node that installed it.",
      "Use Docker Desktop or Colima for docker-workspace mode; the Ubuntu Docker installer is intentionally not used on macOS.",
      "For LaTeX, reuse MacTeX/BasicTeX when latexmk and pdflatex are on PATH; otherwise use the companion Docker sandbox image.",
      "Use Homebrew for optional host tools such as ripgrep, git, python, and latexmk when you choose host mode.",
    ];
  }
  if (info.isWindows) {
    return [
      "Best supported Windows path: run AgInTiFlow inside WSL2 with Node.js 22+ and Docker Desktop WSL integration.",
      "Native Windows host shell is best effort; prefer docker-workspace or WSL for bash-like coding, LaTeX, and package-manager tasks.",
      "For LaTeX, use Docker/WSL, or install MiKTeX/TeX Live and ensure pdflatex/latexmk are on PATH.",
    ];
  }
  if (info.linuxFamily === "debian") {
    return [
      "Use Node.js 22+ from nvm/fnm, NodeSource, or distro packages.",
      "After changing Node versions, verify `node -v`, `which aginti`, and reinstall with `npm install -g @lazyingart/agintiflow@latest` to avoid stale npm-global shims.",
      "Docker can be installed with scripts/install-docker-ubuntu.sh on Ubuntu/Debian-like hosts.",
      "For LaTeX, reuse host latexmk/pdflatex when available; otherwise use the companion Docker sandbox image.",
    ];
  }
  if (info.linuxFamily === "redhat") {
    return [
      "Use Node.js 22+ from nvm/fnm or the Red Hat/Fedora package stream.",
      "Install Docker/Podman-compatible Docker CLI with dnf/yum or vendor docs; do not use the Ubuntu Docker installer.",
      "For LaTeX, reuse host latexmk/pdflatex from texlive packages when available; otherwise use the companion Docker sandbox image.",
    ];
  }
  return [
    "Use Node.js 22+ and prefer docker-workspace for portable shell/toolchain work.",
    "For LaTeX, reuse host latexmk/pdflatex when available; otherwise use the companion Docker sandbox image.",
  ];
}

export function hostShellOption() {
  if (process.platform === "win32") return process.env.ComSpec || true;
  return process.env.SHELL || "/bin/bash";
}
