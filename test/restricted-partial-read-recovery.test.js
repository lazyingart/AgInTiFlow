import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initializePartialReadHost, authorizeFreshProContinuation } from "./fixtures/restricted-partial-read.js";

const worker = fileURLToPath(new URL("./fixtures/restricted-partial-read.js", import.meta.url));
function phase(name, directory, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, "--offline", name, directory, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
    const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
    child.on("error", reject); child.on("close", code => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(Error(output)); });
  });
}

for (const mode of ["batch", "serial"]) test(`${mode}: partial read failure returns no proposal; explicit new-process Pro rereads current host state`, { timeout: 25_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-partial-read-"));
  try {
    const directory = path.join(root, "host"); await initializePartialReadHost(directory);
    const initial = await fs.readFile(path.join(directory, "records.json"));
    await phase("primary", directory, mode);
    const first = JSON.parse(await fs.readFile(path.join(directory, "primary-result.json"), "utf8"));
    assert.equal(first.code, "TOOL_FAILED"); assert.equal(first.toolFailure.category, "unavailable");
    assert(!Object.hasOwn(first, "proposal")); assert.deepEqual(await fs.readFile(path.join(directory, "records.json")), initial);
    assert.equal(first.turns, mode === "batch" ? 1 : 2);
    await authorizeFreshProContinuation(directory);
    const current = await fs.readFile(path.join(directory, "records.json"));
    await phase("recovery", directory, mode);
    const second = JSON.parse(await fs.readFile(path.join(directory, "recovery-result.json"), "utf8"));
    assert.notEqual(first.pid, second.pid); assert.equal(second.model, "deepseek-v4-pro");
    assert.equal(second.status, "completed"); assert.equal(second.turns, mode === "batch" ? 2 : 3);
    assert.deepEqual(second.proposal.records, JSON.parse(current)); assert.equal(second.proposal.records[0].revision, 8);
    assert.deepEqual(await fs.readFile(path.join(directory, "records.json")), current);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
