import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// The build stage and trusted release directory must share a filesystem.
export async function retainArchive(stage, destination, { filename, size }) {
  if (path.basename(filename) !== filename || !filename.endsWith(".tgz")) throw new Error("Unexpected archive name.");
  const source = path.join(stage, filename);
  const target = path.join(destination, filename);
  try {
    await fs.link(source, target);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await existing.stat();
      if (!stat.isFile() || stat.size !== size || !(await existing.readFile()).equals(await fs.readFile(source))) {
        throw new Error(`Release archive differs at ${target}. Choose a new package version.`);
      }
    } finally {
      await existing.close();
    }
  }
  return target;
}
