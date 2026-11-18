import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const files = ["src", "test", "scripts"].flatMap(directory =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:js|mjs)$/.test(entry.name))
    .map(entry => path.join(entry.parentPath, entry.name))
).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${files.length} files.`);
