import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = new URL("../bin/aginti-worker-directory.js", import.meta.url);

const help = await execute(process.execPath, [cli.pathname, "--help"]);
assert.match(help.stdout, /^Usage: aginti-worker-directory/mu);
assert.match(help.stdout, /never accepts an endpoint, host, port, URL, token, or credential name/u);
for (const command of ["enroll", "renew", "switch", "rollback", "finalize", "retire", "remove"]) {
  assert.match(help.stdout, new RegExp(`^  ${command}\\b`, "mu"));
}

async function rejects(args, code, message) {
  let error = null;
  try {
    await execute(process.execPath, [cli.pathname, ...args]);
  } catch (caught) {
    error = caught;
  }
  assert(error, `expected ${args.join(" ")} to fail`);
  const result = JSON.parse(error.stderr);
  assert.equal(result.error.code, code);
  assert.match(result.error.message, message);
}

await rejects(["unknown"], "WORKER_DIRECTORY_CLI_USAGE", /Unknown command/u);
await rejects(["status", "--endpoint", "http://attacker.invalid"], "WORKER_DIRECTORY_CLI_USAGE", /Unsupported option/u);
await rejects(["resolve"], "WORKER_DIRECTORY_CLI_USAGE", /Missing option/u);
await rejects(
  ["switch", "--role", "execution", "--node-id", "node_workstation_0001", "--expected-generation", "not-a-number"],
  "WORKER_DIRECTORY_CLI_USAGE",
  /non-negative integer/u
);

console.log("integration worker directory CLI smoke: ok");
