#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aapsStatus, discoverAaps, formatAapsResult, runAapsAction } from "../src/aaps-adapter.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-aaps-adapter-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

const init = await runAapsAction("init", ["Smoke AAPS Project"], { cwd: tempRoot, packageDir: repoRoot });
assert(init.ok, "AAPS init failed");
assert(await exists(path.join(tempRoot, "aaps.project.json")), "AAPS init did not write manifest");
assert(await exists(path.join(tempRoot, "workflows", "main.aaps")), "AAPS init did not write starter workflow");

const files = await runAapsAction("files", [], { cwd: tempRoot, packageDir: repoRoot });
assert(files.ok && files.files.includes("workflows/main.aaps"), "AAPS files did not find starter workflow");

const status = await aapsStatus({ cwd: tempRoot, packageDir: repoRoot });
assert(status.ok && status.manifest?.activeFile === "workflows/main.aaps", "AAPS status did not read manifest");
assert(formatAapsResult(status).includes("AAPS adapter:"), "AAPS status formatter failed");

const discovery = await discoverAaps({ cwd: tempRoot, packageDir: repoRoot });
if (discovery.found) {
  const validate = await runAapsAction("validate", [], { cwd: tempRoot, packageDir: repoRoot });
  assert(validate.ok && validate.json?.ok === true, `AAPS validate failed\n${formatAapsResult(validate)}`);

  const parse = await runAapsAction("parse", [], { cwd: tempRoot, packageDir: repoRoot });
  assert(parse.ok && parse.json?.pipeline?.name?.includes("Smoke AAPS Project"), `AAPS parse failed\n${formatAapsResult(parse)}`);

  const compile = await runAapsAction("compile", ["check"], { cwd: tempRoot, packageDir: repoRoot });
  assert(compile.json?.phase?.parse === "ok", `AAPS compile check did not return a structured parse-ok report\n${formatAapsResult(compile)}`);
  assert(
    compile.json?.status === "missing_components" || compile.json?.ok === true,
    `AAPS compile check returned an unexpected status\n${formatAapsResult(compile)}`
  );
} else {
  const validate = await runAapsAction("validate", [], { cwd: tempRoot, packageDir: repoRoot });
  assert(validate.ok === false && validate.error, "AAPS missing path should return a structured error");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      tempRoot,
      realAaps: discovery.found,
      source: discovery.source || "",
      checks: ["init", "files", "status", discovery.found ? "validate/parse/compile" : "missing-error"],
    },
    null,
    2
  )
);
