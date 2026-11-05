import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataFields, jsonSnapshot, parseRestrictedJson } from "../src/restricted-application-contract.js";

// A qualification diagnostic, NEVER an application provider or launch profile.
// An empty observed catalog alone cannot establish a no-tools security boundary.
export function assessCodexToolCatalog(raw) {
  const request = jsonSnapshot(raw);
  if (!request || Array.isArray(request) || typeof request !== "object") throw new Error("INVALID_PROBE_REQUEST");
  const tools = request.tools;
  if (!Array.isArray(tools) || tools.length > 128) throw new Error("INVALID_PROBE_REQUEST");
  const names = tools.map((tool) => {
    if (!tool || Array.isArray(tool) || typeof tool !== "object" || typeof tool.type !== "string") throw new Error("INVALID_PROBE_REQUEST");
    const name = tool.name ?? tool.type;
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name)) throw new Error("INVALID_PROBE_REQUEST");
    return name;
  });
  return jsonSnapshot({
    schemaVersion: "aginti-codex-tool-observation-v1",
    advertisedTools: names,
    noToolsObserved: names.length === 0,
    enabled: false,
    productionQualified: false,
    reason: names.length ? "TOOLS_STILL_ADVERTISED" : "ISOLATION_AUTH_AND_LIFECYCLE_NOT_QUALIFIED",
  });
}

const profile = Object.freeze({
  model_provider: "qualification",
  "model_providers.qualification.name": "Local admission fixture",
  "model_providers.qualification.wire_api": "responses",
  "model_providers.qualification.requires_openai_auth": false,
  "model_providers.qualification.request_max_retries": 0,
  "model_providers.qualification.stream_max_retries": 0,
  "features.shell_tool": false, "features.view_image": false,
  "features.multi_agent": false, "agents.enabled": false,
  "features.apps": false, "apps._default.enabled": false,
  "features.remote_plugin": false, "features.plugins": false,
  "features.hooks": false, "features.goals": false, "features.memories": false,
  "features.shell_snapshot": false, "features.skill_mcp_dependency_install": false,
  "features.default_mode_request_user_input": false,
  "skills.bundled.enabled": false, "skills.include_instructions": false,
  mcp_servers: Object.freeze({}), web_search: "disabled", project_doc_max_bytes: 0,
  "history.persistence": "none", "shell_environment_policy.inherit": "none",
});

// Both exec and version are local diagnostics using no real auth/home/config.
// Settle only after launcher close; timeout cleanup targets its process group.
// This diagnostic is not a production child/descendant containment mechanism.
function diagnosticChild(executable, args, options, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure = null, killTimer;
    const signal = (value) => {
      try { process.kill(-child.pid, value); } catch (error) { if (error.code !== "ESRCH") failure ??= error; }
    };
    const stop = (code) => {
      if (failure) return;
      failure = new Error(code);
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), 500);
    };
    const timer = setTimeout(() => stop("PROBE_TIMEOUT"), 15_000);
    child.stdout.on("data", (part) => {
      if (Buffer.byteLength(stdout) + part.length > 128 * 1024) stop("PROBE_OUTPUT_LIMIT");
      else stdout += part;
    });
    child.stderr.on("data", (part) => {
      if (Buffer.byteLength(stderr) + part.length > 128 * 1024) stop("PROBE_OUTPUT_LIMIT");
      else stderr += part;
    });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stop("PROBE_INPUT_FAILED"); });
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code, terminatedBy) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (failure) reject(failure);
      else resolve({ code, terminatedBy, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export async function probeRestrictedCodex(options) {
  const fields = dataFields(options, ["executable"]);
  if (process.platform !== "linux" || typeof fields.executable !== "string" || !path.isAbsolute(fields.executable)) throw new Error("INVALID_PROBE_OPTIONS");
  const executable = await fs.realpath(fields.executable);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-codex-admission-"));
  const requests = [];
  let requestError = null;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 256 * 1024) throw new Error("PROBE_REQUEST_LIMIT");
        chunks.push(chunk);
      }
      if (request.method !== "POST" || request.url !== "/v1/responses" || request.headers["content-encoding"]) throw new Error("UNEXPECTED_PROBE_REQUEST");
      if (requests.length) throw new Error("UNEXPECTED_PROBE_RETRY");
      const body = Buffer.concat(chunks);
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const value = parseRestrictedJson(decoded);
      if (value.model !== "gpt-5.4") throw new Error("UNEXPECTED_PROBE_MODEL");
      requests.push({ bodyDigest: createHash("sha256").update(body).digest("hex"), observation: assessCodexToolCatalog(value) });
    } catch (error) { requestError ??= error; }
    // No result or tool-call response is ever supplied. Intentionally stop at
    // the first observed request; this is not a model-quality/paid acceptance.
    response.writeHead(400, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ error: { type: "invalid_request_error", code: "qualification_stop", message: "Synthetic admission probe; no inference" } }));
  });
  try {
    for (const child of ["home", "codex", "work"]) await fs.mkdir(path.join(temp, child), { mode: 0o700 });
    const schema = path.join(temp, "answer.schema.json");
    await fs.writeFile(schema, JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }), { mode: 0o600 });
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(temp, "home"), CODEX_HOME: path.join(temp, "codex"), TMPDIR: temp, LANG: "C.UTF-8" };
    const childOptions = { cwd: path.join(temp, "work"), env };
    const version = await diagnosticChild(executable, ["--version"], childOptions);
    if (version.code !== 0 || !/^codex-cli \d+\.\d+\.\d+\s*$/.test(version.stdout)) throw new Error("INVALID_PROBE_VERSION");
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const config = { ...profile, "model_providers.qualification.base_url": `http://127.0.0.1:${server.address().port}/v1` };
    const args = ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config", "--skip-git-repo-check", "--json", "--color", "never", "-s", "read-only", "-C", childOptions.cwd, "-m", "gpt-5.4", "--output-schema", schema];
    for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${JSON.stringify(value)}`);
    args.push("-");
    const result = await diagnosticChild(executable, args, childOptions, "Return exactly one JSON object with ok true. No tools.");
    if (requestError) throw requestError;
    if (requests.length !== 1 || result.code === 0 || result.terminatedBy !== null) throw new Error("INVALID_PROBE_OUTCOME");
    return jsonSnapshot({
      schemaVersion: "aginti-codex-admission-probe-v1", codexVersion: version.stdout.trim(),
      syntheticRequests: 1, hostedModelCalls: 0, realCredentialsSupplied: false,
      userConfigurationLoaded: false, enabled: false, productionQualified: false,
      model: "gpt-5.4", observation: requests[0].observation,
      requestDigest: requests[0].bodyDigest, intentionalProviderErrorExit: result.code,
      limits: "Installed CLI observation only; not credential, model-quality, OS isolation or lifecycle qualification.",
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--codex") {
    console.error("Usage: node scripts/probe-restricted-codex.js --codex /absolute/trusted/codex");
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await probeRestrictedCodex({ executable: process.argv[3] }), null, 2)); }
    catch { console.error("Codex admission probe failed; no application capability enabled."); process.exitCode = 1; }
  }
}
