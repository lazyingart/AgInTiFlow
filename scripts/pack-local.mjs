import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retainArchive } from "./retain-archive.mjs";

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
  console.log(await retainArchive(stage, directory, packed));
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
