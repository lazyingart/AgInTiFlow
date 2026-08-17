#!/usr/bin/env node
import fs from "node:fs";

const argv = process.argv.slice(2);

function fail(error) {
  console.error(error);
  process.exit(1);
}

try {
  if (["--version", "version", "-v"].includes(argv[0])) {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(packageJson.version);
  } else {
    import("../src/cli.js")
      .then(({ main }) => main(argv))
      .catch(fail);
  }
} catch (error) {
  fail(error);
}
