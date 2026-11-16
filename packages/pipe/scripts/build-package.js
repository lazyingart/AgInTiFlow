import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const sdk = path.resolve(root, "../..");
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error("Supply an absolute package destination");
const stage = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-pipe-pack-"));
try {
  for (const file of ["package.json", "README.md", "NOTICE", "src/channel.js", "src/streams.js"]) {
    await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(stage, file));
  }
  await fs.copyFile(path.join(sdk, "LICENSE"), path.join(stage, "LICENSE"));
  await fs.mkdir(path.join(stage, "src/internal"));
  // Validation helpers only, copied verbatim. The engine remains the exact peer.
  for (const file of ["restricted-application-contract.js", "redaction.js"]) {
    await fs.copyFile(path.join(sdk, "src", file), path.join(stage, "src/internal", file));
  }
  await fs.mkdir(destination, { recursive: true });
  for (const file of ["user.npmrc", "global.npmrc"]) await fs.writeFile(path.join(stage, file), "", { mode: 0o600 });
  const result = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", destination], {
    cwd: stage, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: stage, LANG: "C", CI: "true", NPM_CONFIG_USERCONFIG: path.join(stage, "user.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: path.join(stage, "global.npmrc"), NPM_CONFIG_CACHE: path.join(stage, "cache"), NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" },
  });
  if (result.error || result.status !== 0) throw new Error("Offline package build failed", { cause: result.error });
  const [manifest] = JSON.parse(result.stdout);
  const expected = ["LICENSE", "NOTICE", "README.md", "package.json", "src/channel.js", "src/streams.js", "src/internal/redaction.js", "src/internal/restricted-application-contract.js"].sort();
  if (JSON.stringify(manifest.files.map(file => file.path).sort()) !== JSON.stringify(expected) || manifest.unpackedSize > 64 * 1024 || manifest.bundled.length) throw new Error("Package surface exceeds its closed bound");
  const archive = path.join(destination, manifest.filename);
  const sha256 = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  console.log(JSON.stringify({ archive, sha256, unpackedSize: manifest.unpackedSize, files: expected }, null, 2));
} finally { await fs.rm(stage, { recursive: true, force: true }); }
