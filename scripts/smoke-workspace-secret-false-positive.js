#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasSensitiveText, redactSensitiveText } from "../src/redaction.js";
import { executeWorkspaceTool } from "../src/workspace-tools.js";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-secret-fp-"));
const config = { commandCwd: workspace, allowFileTools: true };

const source = [
  "import os",
  "def authenticate(provided_token: str | None) -> bool:",
  "    return bool(provided_token)",
  "def record_access(actor: str, token: str, artifact: str) -> None:",
  "    print(f'actor={actor} token={token} artifact={artifact}')",
  "def configured_token() -> str | None:",
  "    token = os.environ.get(\"LABSHARE_TOKEN\")",
  "    if not token:",
  "        return None",
  "    return token",
  "def load_key():",
  "    if line.startswith(\"DEEPSEEK_API_KEY=\"):",
  "        return line.split(\"=\", 1)[1].strip()",
  "headers = {",
  "    \"Authorization\": \"Bearer \" + k,",
  "}",
  "",
].join("\n");

assert.equal(
  redactSensitiveText(source),
  source,
  "source type annotations and f-string variable references must not be redacted as literal credentials"
);
assert.equal(hasSensitiveText(source), false, "safe credential-handling source should not be classified as a secret");

const patchArguments = JSON.stringify({
  patch: [
    "*** Begin Patch",
    "*** Update File: labshare.py",
    "@@",
    "+    token = os.environ.get(\"LABSHARE_TOKEN\")",
    "+    if not token:",
    "+        return None",
    "*** End Patch",
  ].join("\n"),
});
assert.equal(
  redactSensitiveText(patchArguments),
  patchArguments,
  "serialized source patches must preserve environment lookups and control-flow colons"
);

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
    replace: "headers: dict[str, str] = {",
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
assert.match(
  redactSensitiveText("DEMO_SECRET_TOKEN=aginti_fake_do_not_use"),
  /^DEMO_SECRET_TOKEN=\[REDACTED\]$/,
  "real unquoted token assignments must remain redacted"
);
assert.match(
  redactSensitiveText("token: actual-secret-value"),
  /^token: \[REDACTED\]$/,
  "real colon-delimited token assignments must remain redacted"
);

console.log(JSON.stringify({ ok: true, workspace }, null, 2));
