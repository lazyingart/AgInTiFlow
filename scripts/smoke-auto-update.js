#!/usr/bin/env node
import {
  compareSemver,
  isGlobalNpmInstall,
  isNewerVersion,
  maybeAutoUpdate,
  shouldAutoUpdateCommand,
} from "../src/auto-update.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const scopedGlobalPath = "/usr/local/lib/node_modules/@lazyingart/agintiflow";
const windowsGlobalPath = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@lazyingart\\agintiflow";

assert(compareSemver("0.20.38", "0.20.37") === 1, "patch version compare failed");
assert(compareSemver("0.21.0", "0.20.99") === 1, "minor version compare failed");
assert(compareSemver("1.0.0", "0.99.99") === 1, "major version compare failed");
assert(compareSemver("0.20.37", "0.20.37") === 0, "equal version compare failed");
assert(compareSemver("0.20.37", "0.20.38") === -1, "older version compare failed");
assert(isNewerVersion("0.20.38", "0.20.37"), "newer version predicate failed");
assert(!isNewerVersion("0.20.37", "0.20.37"), "equal version should not update");
assert(!isNewerVersion("0.20.36", "0.20.37"), "older latest should not update");

assert(isGlobalNpmInstall(scopedGlobalPath), "Unix global npm install path not detected");
assert(isGlobalNpmInstall(windowsGlobalPath), "Windows global npm install path not detected");
assert(!isGlobalNpmInstall("/home/user/Projects/AgInTiFlow"), "source checkout should not look globally installed");

assert(shouldAutoUpdateCommand([]), "plain interactive start should check updates");
assert(shouldAutoUpdateCommand(["web"]), "web start should check updates");
assert(shouldAutoUpdateCommand(["resume", "latest"]), "resume should check updates");
assert(shouldAutoUpdateCommand(["write", "a", "test"]), "one-shot task should check updates in a TTY");
assert(!shouldAutoUpdateCommand(["doctor"]), "doctor should skip updates");
assert(!shouldAutoUpdateCommand(["models"]), "models should skip updates");
assert(!shouldAutoUpdateCommand(["--version"]), "version should skip updates");
assert(!shouldAutoUpdateCommand(["task", "--no-auto-update"]), "--no-auto-update should skip updates");

const skipped = await maybeAutoUpdate({
  argv: [],
  force: true,
  manual: false,
  packageDir: "/home/user/Projects/AgInTiFlow",
  packageName: "@lazyingart/agintiflow",
  packageVersion: "0.20.37",
  restart: false,
});
assert(skipped.skipped === "source-checkout", "source checkout update guard failed");

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-auto-update-"));
const previousHome = process.env.AGINTIFLOW_HOME;
const previousStartupInterval = process.env.AGINTIFLOW_AUTO_UPDATE_STARTUP_INTERVAL_MS;
const previousCi = process.env.CI;
process.env.AGINTIFLOW_HOME = tempHome;
process.env.AGINTIFLOW_AUTO_UPDATE_STARTUP_INTERVAL_MS = String(24 * 60 * 60 * 1000);
delete process.env.CI;
await fs.mkdir(tempHome, { recursive: true });
await fs.writeFile(
  path.join(tempHome, "update-check.json"),
  `${JSON.stringify({ checkedAt: Date.now(), latest: "0.20.99" })}\n`,
  "utf8"
);
const writes = [];
const fakeStdout = {
  isTTY: true,
  write(value) {
    writes.push(String(value));
  },
};
const skipVersion = await maybeAutoUpdate({
  argv: [],
  packageDir: scopedGlobalPath,
  packageName: "@lazyingart/agintiflow",
  packageVersion: "0.20.38",
  restart: false,
  stdout: fakeStdout,
  selectUpdateAction: async () => "skip-version",
});
assert(skipVersion.skipped === "skip-version", "skip-version selector choice was not honored");
const cacheAfterSkip = JSON.parse(await fs.readFile(path.join(tempHome, "update-check.json"), "utf8"));
assert(cacheAfterSkip.skippedVersion === "0.20.99", "skip-version did not persist skipped version");
const repeatedSkip = await maybeAutoUpdate({
  argv: [],
  packageDir: scopedGlobalPath,
  packageName: "@lazyingart/agintiflow",
  packageVersion: "0.20.38",
  restart: false,
  stdout: fakeStdout,
  selectUpdateAction: async () => {
    throw new Error("selector should not be called after skip-version");
  },
});
assert(repeatedSkip.skipped === "skipped-version", "cached skipped version was not respected");
if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME;
else process.env.AGINTIFLOW_HOME = previousHome;
if (previousStartupInterval === undefined) delete process.env.AGINTIFLOW_AUTO_UPDATE_STARTUP_INTERVAL_MS;
else process.env.AGINTIFLOW_AUTO_UPDATE_STARTUP_INTERVAL_MS = previousStartupInterval;
if (previousCi === undefined) delete process.env.CI;
else process.env.CI = previousCi;

const updateHome = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-auto-update-install-"));
const previousInstallHome = process.env.AGINTIFLOW_HOME;
process.env.AGINTIFLOW_HOME = updateHome;
await fs.writeFile(
  path.join(updateHome, "update-check.json"),
  `${JSON.stringify({ checkedAt: Date.now(), latest: "0.20.99" })}\n`,
  "utf8"
);
const hookEvents = [];
const fakeInstallWrites = [];
const fakeInstallStdout = {
  isTTY: true,
  write(value) {
    fakeInstallWrites.push(String(value));
  },
};
const fakeInstallStderr = {
  write(value) {
    fakeInstallWrites.push(String(value));
  },
};
const installed = await maybeAutoUpdate({
  argv: ["update"],
  manual: true,
  packageDir: scopedGlobalPath,
  packageName: "@lazyingart/agintiflow",
  packageVersion: "0.20.38",
  restart: false,
  stdout: fakeInstallStdout,
  stderr: fakeInstallStderr,
  installPackage: async (packageName) => {
    hookEvents.push(["install", packageName]);
    return { ok: true, code: 0 };
  },
  afterUpdate: async (context) => {
    hookEvents.push(["afterUpdate", context.latest]);
    return { ok: true, restarted: true, url: "http://127.0.0.1:3210" };
  },
});
assert(installed.updated === true, "fake install did not report update success");
assert(installed.webappRestart?.ok === true && installed.webappRestart.restarted === true, "after-update webapp restart result missing");
assert(hookEvents.some((event) => event[0] === "install"), "install hook was not called");
assert(hookEvents.some((event) => event[0] === "afterUpdate"), "after-update hook was not called");
assert(fakeInstallWrites.join("").includes("webapp restarted after update"), "after-update webapp restart was not reported");
if (previousInstallHome === undefined) delete process.env.AGINTIFLOW_HOME;
else process.env.AGINTIFLOW_HOME = previousInstallHome;
await fs.rm(updateHome, { recursive: true, force: true });

console.log("auto-update smoke ok");
