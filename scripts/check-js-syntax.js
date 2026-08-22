#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["run.js", "web.js", "bin", "src", "public", "scripts"];
const extensions = new Set([".cjs", ".js", ".mjs"]);

async function collect(entryPath, files) {
  const stat = await fs.lstat(entryPath);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const entries = await fs.readdir(entryPath, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      await collect(path.join(entryPath, entry.name), files);
    }
    return;
  }
  if (stat.isFile() && extensions.has(path.extname(entryPath).toLowerCase())) files.push(entryPath);
}

const files = [];
for (const root of roots) await collect(path.join(projectRoot, root), files);

for (const filePath of files) {
  const checked = spawnSync(process.execPath, ["--check", filePath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (checked.status !== 0) {
    process.stderr.write(checked.stderr || checked.stdout || `Syntax check failed: ${filePath}\n`);
    process.exit(checked.status || 1);
  }
}

console.log(`JavaScript syntax check passed (${files.length} files).`);
