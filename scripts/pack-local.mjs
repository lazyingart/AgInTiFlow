import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [destination = "artifacts", ...extra] = process.argv.slice(2);
if (extra.length || !process.env.npm_execpath) throw new Error("Run npm run pack:local -- [directory].");
const directory = path.resolve(destination);
await fs.mkdir(directory, { recursive: true });
const stage = await fs.mkdtemp(path.join(directory, ".pack-"));
try {
  const [packed] = JSON.parse(execFileSync(process.execPath, [
    process.env.npm_execpath, "pack", "--json", "--offline", "--ignore-scripts", "--pack-destination", stage,
  ], { cwd: root, encoding: "utf8" }));
  const filename = packed.filename;
  if (path.basename(filename) !== filename || !filename.endsWith(".tgz")) throw new Error("Unexpected archive name.");
  const source = path.join(stage, filename);
  const target = path.join(directory, filename);
  try {
    // Same filesystem. Concurrent builds cannot replace an existing release.
    await fs.link(source, target);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await existing.stat();
      if (!stat.isFile() || stat.size !== packed.size || !(await existing.readFile()).equals(await fs.readFile(source))) {
        throw new Error(`Release archive differs at ${target}. Choose a new package version.`);
      }
    } finally {
      await existing.close();
    }
  }
  console.log(target);
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
