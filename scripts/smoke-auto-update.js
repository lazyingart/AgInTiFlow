#!/usr/bin/env node
import {
  compareSemver,
  isGlobalNpmInstall,
  isNewerVersion,
  maybeAutoUpdate,
  shouldAutoUpdateCommand,
} from "../src/auto-update.js";

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

console.log("auto-update smoke ok");

