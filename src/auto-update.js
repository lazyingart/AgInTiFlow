import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PACKAGE_NAME = "@lazyingart/agintiflow";
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;
const UPDATE_CHOICES = [
  {
    id: "update",
    label: "Update now",
    description: "Install latest globally, then restart AgInTiFlow.",
  },
  {
    id: "skip-once",
    label: "Skip this time",
    description: "Continue with the current version for this run.",
  },
  {
    id: "skip-version",
    label: "Skip this version",
    description: "Do not ask again until a newer release appears.",
  },
];
const START_COMMANDS = new Set(["", "chat", "interactive", "resume", "web", "--web", "--chat", "--interactive"]);
const SKIP_COMMANDS = new Set([
  "auth",
  "capabilities",
  "doctor",
  "help",
  "init",
  "keys",
  "keys/status",
  "login",
  "model",
  "models",
  "queue",
  "sessions",
  "skill",
  "skills",
  "storage",
  "update",
  "upgrade",
  "version",
]);

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function agintiHome() {
  return path.resolve(process.env.AGINTIFLOW_HOME || path.join(os.homedir(), ".agintiflow"));
}

function updateCachePath() {
  return path.join(agintiHome(), "update-check.json");
}

function parseVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)];
}

export function compareSemver(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

export function isNewerVersion(latest, current) {
  return compareSemver(latest, current) > 0;
}

export function isGlobalNpmInstall(packageDir, packageName = DEFAULT_PACKAGE_NAME) {
  const normalized = path.resolve(packageDir || "").replaceAll("\\", "/").toLowerCase();
  const packagePath = `/node_modules/${packageName.toLowerCase()}`;
  return normalized.includes(packagePath);
}

export function shouldAutoUpdateCommand(argv = []) {
  if (argv.includes("--no-auto-update")) return false;
  if (argv.includes("--help") || argv.includes("-h") || argv.includes("--version") || argv.includes("-v")) return false;
  const command = String(argv[0] || "").trim();
  if (SKIP_COMMANDS.has(command)) return false;
  if (command.startsWith("--") && command !== "--web" && command !== "--chat" && command !== "--interactive") return true;
  if (START_COMMANDS.has(command)) return true;
  return true;
}

function envDisablesAutoUpdate() {
  const noValues = [process.env.AGINTIFLOW_NO_AUTO_UPDATE, process.env.AGINTI_NO_AUTO_UPDATE].map((value) => String(value || "").toLowerCase());
  if (noValues.some((value) => ["1", "true", "yes", "on"].includes(value))) return true;
  const explicit = process.env.AGINTIFLOW_AUTO_UPDATE;
  if (explicit === undefined) return false;
  return ["0", "false", "no", "off"].includes(String(explicit).toLowerCase());
}

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(updateCachePath(), "utf8"));
  } catch {
    return {};
  }
}

async function writeCache(nextCache) {
  const filePath = updateCachePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(nextCache, null, 2)}\n`, "utf8");
}

async function npmLatestVersion(packageName, timeoutMs) {
  const { stdout } = await execFileAsync(npmCommand(), ["view", packageName, "version", "--json"], {
    timeout: timeoutMs,
    maxBuffer: 100 * 1024,
    env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
  });
  return JSON.parse(stdout.trim());
}

function nowMs() {
  return Date.now();
}

function checkIntervalMs() {
  const raw = process.env.AGINTIFLOW_AUTO_UPDATE_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_CHECK_INTERVAL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CHECK_INTERVAL_MS;
}

function failureRetryMs() {
  const raw = process.env.AGINTIFLOW_AUTO_UPDATE_FAILURE_RETRY_MS;
  if (raw === undefined || raw === "") return DEFAULT_FAILURE_RETRY_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_FAILURE_RETRY_MS;
}

async function installLatest(packageName) {
  return await new Promise((resolve) => {
    const child = spawn(npmCommand(), ["install", "-g", `${packageName}@latest`, "--no-audit", "--no-fund"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("exit", (code, signal) => {
      resolve({
        ok: code === 0,
        code,
        error: code === 0 ? "" : `npm install exited with ${signal || code}`,
      });
    });
  });
}

async function restartCurrentProcess() {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, AGINTIFLOW_AUTO_UPDATE_RESTARTED: "1" },
    });
    child.on("error", (error) => resolve({ ok: false, exitCode: 1, error: error.message }));
    child.on("exit", (code) => resolve({ ok: true, exitCode: code ?? 0 }));
  });
}

function shouldSkipFailedInstall(cache, currentMs, force) {
  if (force) return false;
  const failedAt = Number(cache.lastInstallFailedAt || 0);
  return failedAt > 0 && currentMs - failedAt < failureRetryMs();
}

function renderUpdateSelector(output, { current, latest, packageName, selectedIndex, renderedLines }) {
  const rows = [
    `AgInTiFlow update available: ${current} -> ${latest}`,
    `Package: ${packageName}`,
    "Use Up/Down to choose, Enter to confirm, Esc to skip.",
    "",
    ...UPDATE_CHOICES.map((choice, index) => {
      const cursor = index === selectedIndex ? ">" : " ";
      return `${cursor} ${choice.label.padEnd(17)} ${choice.description}`;
    }),
  ];
  if (renderedLines > 0) output.write(`\x1b[${renderedLines}A\x1b[J`);
  output.write(`${rows.join("\n")}\n`);
  return rows.length;
}

export async function promptUpdateChoice({
  current = "",
  latest = "",
  packageName = DEFAULT_PACKAGE_NAME,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return "skip-once";

  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  let renderedLines = 0;
  let selectedIndex = 0;
  let resolved = false;

  return await new Promise((resolve) => {
    function finish(choice) {
      if (resolved) return;
      resolved = true;
      input.off("keypress", onKeypress);
      input.setRawMode(Boolean(wasRaw));
      if (!wasRaw) input.pause();
      output.write("\n");
      resolve(choice);
    }

    function render() {
      renderedLines = renderUpdateSelector(output, {
        current,
        latest,
        packageName,
        selectedIndex,
        renderedLines,
      });
    }

    function onKeypress(_chunk, key = {}) {
      if (key.ctrl && key.name === "c") {
        input.setRawMode(Boolean(wasRaw));
        if (!wasRaw) input.pause();
        output.write("\n");
        process.exit(130);
      }
      if (key.name === "up" || key.name === "left") {
        selectedIndex = (selectedIndex - 1 + UPDATE_CHOICES.length) % UPDATE_CHOICES.length;
        render();
        return;
      }
      if (key.name === "down" || key.name === "right" || key.name === "tab") {
        selectedIndex = (selectedIndex + 1) % UPDATE_CHOICES.length;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(UPDATE_CHOICES[selectedIndex].id);
        return;
      }
      if (key.name === "escape") {
        finish("skip-once");
      }
    }

    input.setRawMode(true);
    input.resume();
    render();
    input.on("keypress", onKeypress);
  });
}

export async function maybeAutoUpdate({
  argv = [],
  force = false,
  manual = false,
  packageDir = "",
  packageName = DEFAULT_PACKAGE_NAME,
  packageVersion = "",
  restart = false,
  selectUpdateAction = promptUpdateChoice,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!manual && !force && !shouldAutoUpdateCommand(argv)) return { checked: false, skipped: "command" };
  if (!manual && !force && envDisablesAutoUpdate()) return { checked: false, skipped: "disabled" };
  if (!manual && !force && process.env.CI) return { checked: false, skipped: "ci" };
  if (!manual && !force && !stdout.isTTY) return { checked: false, skipped: "non-tty" };
  if (!manual && !force && process.env.AGINTIFLOW_AUTO_UPDATE_RESTARTED === "1") return { checked: false, skipped: "restarted" };

  if (!isGlobalNpmInstall(packageDir, packageName)) {
    if (manual) {
      stdout.write("Auto-update skipped: this looks like a source checkout, not a global npm install.\n");
      stdout.write(`To update a published install, run: npm install -g ${packageName}@latest\n`);
    }
    return { checked: false, skipped: "source-checkout" };
  }

  const currentMs = nowMs();
  const cache = await readCache();
  let latest = String(cache.latest || "");
  const checkedAt = Number(cache.checkedAt || 0);
  const stale = force || currentMs - checkedAt >= checkIntervalMs();

  if (stale || !latest) {
    try {
      latest = String(await npmLatestVersion(packageName, Number(process.env.AGINTIFLOW_AUTO_UPDATE_TIMEOUT_MS || 5000)) || "");
      await writeCache({
        ...cache,
        checkedAt: currentMs,
        latest,
        latestCheckedBy: "npm-view",
        packageName,
      });
    } catch (error) {
      if (manual) stderr.write(`Could not check npm latest version: ${error instanceof Error ? error.message : String(error)}\n`);
      return { checked: false, skipped: "latest-check-failed", error };
    }
  }

  if (!isNewerVersion(latest, packageVersion)) {
    if (manual) stdout.write(`AgInTiFlow is up to date (${packageVersion}).\n`);
    return { checked: true, latest, current: packageVersion, updated: false };
  }

  if (shouldSkipFailedInstall(cache, currentMs, force)) {
    return { checked: true, latest, current: packageVersion, updated: false, skipped: "recent-install-failure" };
  }

  if (!manual && !force) {
    if (cache.skippedVersion === latest) {
      return { checked: true, latest, current: packageVersion, updated: false, skipped: "skipped-version" };
    }
    const choice = await selectUpdateAction({
      current: packageVersion,
      latest,
      packageName,
      input: process.stdin,
      output: stdout,
    });
    if (choice === "skip-version") {
      await writeCache({
        ...cache,
        checkedAt: currentMs,
        latest,
        skippedVersion: latest,
        skippedAt: currentMs,
        packageName,
      });
      stdout.write(`Skipped AgInTiFlow ${latest}. Run \`aginti update\` to install it later.\n`);
      return { checked: true, latest, current: packageVersion, updated: false, skipped: "skip-version" };
    }
    if (choice !== "update") {
      stdout.write(`Skipped update for this run. Run \`aginti update\` to install ${latest} later.\n`);
      return { checked: true, latest, current: packageVersion, updated: false, skipped: "skip-once" };
    }
  }

  stdout.write(`AgInTiFlow update available: ${packageVersion} -> ${latest}\n`);
  stdout.write(`Running: npm install -g ${packageName}@latest\n`);
  const install = await installLatest(packageName);
  if (!install.ok) {
    await writeCache({
      ...cache,
      checkedAt: currentMs,
      latest,
      lastInstallFailedAt: currentMs,
      lastInstallError: install.error,
      packageName,
    });
    stderr.write(`AgInTiFlow auto-update failed: ${install.error}\n`);
    stderr.write(`You can update manually with: npm install -g ${packageName}@latest\n`);
    return { checked: true, latest, current: packageVersion, updated: false, error: install.error };
  }

  await writeCache({
    ...cache,
    checkedAt: currentMs,
    latest,
    lastInstallSucceededAt: currentMs,
    lastInstallFailedAt: 0,
    lastInstallError: "",
    packageName,
  });
  stdout.write(`AgInTiFlow updated to ${latest}.\n`);

  if (restart) {
    stdout.write("Restarting AgInTiFlow with the updated package...\n");
    const restarted = await restartCurrentProcess();
    return { checked: true, latest, current: packageVersion, updated: true, restarted: true, exitCode: restarted.exitCode, error: restarted.error };
  }

  return { checked: true, latest, current: packageVersion, updated: true };
}
