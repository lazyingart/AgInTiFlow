import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const [label, failure, expected] of [["success", "0", 0], ["failure", "23", 23], ["signal", "SIGTERM", 1]]) {
  test(`private npm helper cleans config after ${label} and preserves outcome`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-npm-helper-test-"));
    let temporaryConfig;
    try {
      await fs.mkdir(path.join(root, "scripts")); await fs.mkdir(path.join(root, "bin"));
      await fs.copyFile(new URL("../scripts/npm-publish-from-env.js", import.meta.url), path.join(root, "scripts/npm-publish-from-env.mjs"));
      await fs.copyFile(new URL("./fixtures/npm-env-helper-command.js", import.meta.url), path.join(root, "bin/npm"));
      await fs.chmod(path.join(root, "bin/npm"), 0o700);
      await fs.writeFile(path.join(root, ".env"), "NPM_TOKEN=synthetic-not-a-real-npm-token\n", { mode: 0o600 });
      const result = spawnSync(process.execPath, [path.join(root, "scripts/npm-publish-from-env.mjs"), "whoami"], {
        timeout: 5000, encoding: "utf8",
        env: { PATH: path.join(root, "bin") + path.delimiter + path.dirname(process.execPath),
          AGINTI_TEST_NPM_EXIT: failure, ...(failure === "SIGTERM" ? { AGINTI_TEST_NPM_SIGNAL: failure } : {}) },
      });
      temporaryConfig = JSON.parse(result.stdout).temporaryConfig;
      assert.equal(result.status, expected, result.stderr);
      assert.equal(result.stdout.includes("synthetic-not-a-real-npm-token"), false);
      assert.equal(result.stderr.includes("synthetic-not-a-real-npm-token"), false);
      await assert.rejects(fs.stat(path.dirname(temporaryConfig)), { code: "ENOENT" });
    } finally {
      if (temporaryConfig) await fs.rm(path.dirname(temporaryConfig), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
