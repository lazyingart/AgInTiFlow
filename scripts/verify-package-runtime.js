import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Distribution qualification deliberately resolves the public dependency graph
// online. Repository npm ci and an offline cache do not prove consumer installs.
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
assert.equal(manifest.name, "@lazyingart/agintiflow");
assert.ok(process.env.npm_execpath, "Invoke through npm run pack:verify-runtime.");
const npmCli = process.env.npm_execpath;
const cache = process.env.npm_config_cache || path.join(os.homedir(), ".npm");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-package-runtime-"));
const env = {
  PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  HOME: temporary, XDG_CONFIG_HOME: path.join(temporary, "config"),
  NPM_CONFIG_USERCONFIG: path.join(temporary, "npmrc"), NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
  npm_config_cache: cache, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  AGINTIFLOW_HOME: path.join(temporary, "agent-home"),
  AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", LANG: "C.UTF-8",
};
function run(command, args, cwd, timeout = 120000) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout || "Package runtime command failed.");
  return result.stdout;
}
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);
let receipt;
try {
  await fs.writeFile(env.NPM_CONFIG_USERCONFIG, "", { mode: 0o600 });
  const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", temporary], root));
  const prefix = path.join(temporary, "prefix");
  npm(["install", "--global", "--prefix", prefix, "--ignore-scripts", "--prefer-online", "--no-audit", "--no-fund",
    path.join(temporary, packed.filename)], temporary);
  const installed = path.join(prefix, ...(process.platform === "win32" ? ["node_modules"] : ["lib", "node_modules"]), manifest.name);
  const actual = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(actual.version, manifest.version);
  for (const name of ["aginti", "aginti-cli"]) {
    const version = run(process.execPath, [path.join(installed, actual.bin[name]), "--version"], temporary, 15000).trim();
    assert.equal(version, manifest.version);
  }
  const log = run(process.execPath, ["--test", "test/package-runtime-dependencies.test.js", "test/model-http-boundary.test.js", "test/remote-image-input.test.js",
    "test/dependency-security-boundaries.test.js"], installed, 30000);
  assert.match(log, /# tests 46\n/); assert.match(log, /# fail 0\n/);
  receipt = { version: manifest.version, files: packed.files.length, onlineDependencyResolution: true,
    preferOnline: true, installScriptsDisabled: true, consumerTests: 46, failures: 0, cliVersionsVerified: true };
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
await assert.rejects(fs.stat(temporary), { code: "ENOENT" });
console.log(JSON.stringify({ ...receipt, temporaryPrefixRemoved: true }));
