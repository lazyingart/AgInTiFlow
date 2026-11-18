import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const helper = fileURLToPath(new URL("../scripts/pack-local.mjs", import.meta.url));

test("concurrent private builds with the same release name preserve the winning archive", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agintilite-release-name-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const destination = path.join(temp, "releases");
  const env = { PATH: process.env.PATH, HOME: temp, NPM_CONFIG_CACHE: path.join(temp, "cache"), NPM_CONFIG_OFFLINE: "true" };
  const builds = await Promise.all(["first", "other"].map(async label => {
    const cwd = path.join(temp, label);
    await fs.mkdir(path.join(cwd, "scripts"), { recursive: true });
    await fs.copyFile(helper, path.join(cwd, "scripts/pack-local.mjs"));
    await fs.copyFile(path.join(path.dirname(helper), "retain-archive.mjs"), path.join(cwd, "scripts/retain-archive.mjs"));
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
      name: "release-name-fixture", version: "0.1.0-preview.1", private: true,
      files: ["README.md"], scripts: { "pack:local": "node scripts/pack-local.mjs" },
    }));
    await fs.writeFile(path.join(cwd, "README.md"), label);
    return () => run("npm", ["run", "--silent", "pack:local", "--", destination], { cwd, env, timeout: 20000 });
  }));
  const race = await Promise.allSettled(builds.map(build => build()));
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
  const winner = race.findIndex(r => r.status === "fulfilled");
  const name = "release-name-fixture-0.1.0-preview.1.tgz";
  const bytes = await fs.readFile(path.join(destination, name));
  await builds[winner]();
  await assert.rejects(builds[1 - winner](), /Release archive differs/);
  assert.deepEqual(await fs.readFile(path.join(destination, name)), bytes);
  assert.deepEqual(await fs.readdir(destination), [name]);
});
