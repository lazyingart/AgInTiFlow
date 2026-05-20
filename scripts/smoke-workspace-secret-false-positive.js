#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeWorkspaceTool } from "../src/workspace-tools.js";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-secret-fp-"));
const config = { commandCwd: workspace, allowFileTools: true };

const source = [
  "import os",
  "def load_key():",
  "    if line.startswith(\"DEEPSEEK_API_KEY=\"):",
  "        return line.split(\"=\", 1)[1].strip()",
  "headers = {",
  "    \"Authorization\": \"Bearer \" + k,",
  "}",
  "",
].join("\n");

const writeResult = await executeWorkspaceTool(
  "write_file",
  { path: "scripts/deepseek_client.py", content: source, mode: "create" },
  config
);
assert(writeResult.ok, "safe credential-loading source code should not be blocked as a secret");

const patchResult = await executeWorkspaceTool(
  "apply_patch",
  {
    path: "scripts/deepseek_client.py",
    search: "headers = {",
    replace: "headers = {",
  },
  config
);
assert(patchResult.ok, "legacy apply_patch replace content with safe credential-loading code context should not be blocked");

const secretResult = await executeWorkspaceTool(
  "write_file",
  { path: "notes/leak-report.txt", content: "DEMO_SECRET_TOKEN=aginti_fake_do_not_use\n", mode: "create" },
  config
);
assert(secretResult.blocked && secretResult.category === "workspace-content", "real secret-like values must still be blocked");

console.log(JSON.stringify({ ok: true, workspace }, null, 2));
