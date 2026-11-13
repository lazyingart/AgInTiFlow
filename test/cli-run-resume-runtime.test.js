import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/cli-run-resume-provider.js", import.meta.url));
const sid = "cli-run-resume-contract", note = "Remember the note: the release window is Wednesday. Reply in one sentence.";
const followup = "Continue this conversation and explain what the saved note says. Do not create or modify files.";
const seedOptions = ["--provider", "deepseek", "--model", "deepseek-flash", "--routing", "manual", "--profile", "chatops", "--scs", "off", "--max-steps", "3", "--dynamic-steps", "off", "--sandbox-mode", "host", "--no-shell", "--no-file-tools", "--no-web-search", "--no-mcp", "--no-wrappers", "--no-auxiliary-tools", "--no-parallel-scouts"];

async function setup(t, seedExtra = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-cli-run-resume-")), children = new Set();
  t.after(async () => { for (const entry of children) { entry.child.kill("SIGKILL"); await entry.closed; } await fs.rm(root, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, XDG_CONFIG_HOME: root + "/config", AGINTIFLOW_HOME: root + "/home", AGINTI_PROVIDER_HANDOFF: "0", AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", DEEPSEEK_API_KEY: "synthetic-offline-provider-key", OPENAI_API_KEY: "synthetic-offline-openai-key", NODE_OPTIONS: "--import=" + fixture, AGINTI_TEST_RUNTIME: source, AGINTI_TEST_RESUME_TRACE: root + "/requests.jsonl" };
  const statePath = root + "/home/sessions/" + sid + "/state.json", eventsPath = root + "/home/sessions/" + sid + "/events.jsonl";
  const state = async () => JSON.parse(await fs.readFile(statePath));
  const events = async () => (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const requests = async () => { try { return (await fs.readFile(env.AGINTI_TEST_RESUME_TRACE, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === "ENOENT") return []; throw e; } };
  async function run(args, prompt = followup, extraEnv = {}) {
    const child = spawn(process.execPath, [path.join(source, "bin/aginti-cli.js"), ...args, "--json", "--no-auto-update"], { cwd: root, env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", expired = false; const entry = { child, closed: null }; children.add(entry);
    child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c); child.stdin.on("error", () => {});
    entry.closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 16000);
      child.once("error", e => { clearTimeout(timer); children.delete(entry); reject(e); });
      child.once("close", code => { clearTimeout(timer); children.delete(entry); resolve({ code, stdout, stderr, expired }); });
    });
    entry.closed.catch(() => {}); child.stdin.end(prompt);
    const result = await entry.closed; assert.equal(expired, false, JSON.stringify(result));
    assert.equal(stdout.trim().split("\n").length, 1, JSON.stringify(result));
    return { ...result, machine: JSON.parse(stdout) };
  }
  const seeded = await run(["run", "--stdin", "--session-id", sid, ...seedOptions, ...seedExtra], note); assert.equal(seeded.code, 0, JSON.stringify(seeded)); assert.equal(seeded.machine.ok, true);
  const before = await state(), beforeRequests = (await requests()).length;
  return { root, statePath, state, events, requests, run, before, beforeRequests, initial: seeded.machine };
}

const cases = [
  ["fresh", []],
  ["model-only", ["--model", "deepseek-v4-pro"]],
  ["provider-only", ["--provider", "mock"]],
  ["provider-and-model", ["--provider", "openai", "--model", "offline-openai-contract"]],
  ["explicit-roles", ["--model", "deepseek-v4-pro", "--route-model", "deepseek-v4-pro", "--main-model", "deepseek-v4-pro", "--spare-model", "deepseek-v4-pro"]],
  ["ambient", []],
  ["no-shell", ["--no-shell"]],
  ["no-file-tools", ["--no-file-tools"]],
  ["stdin-options-are-data", []],
  ["positional", []],
  ["explicit-resume-control", ["--model", "deepseek-v4-pro"]],
  ["stale-cas-patch", ["--model", "deepseek-v4-pro"]],
  ["stale-cas-no-patch", []],
  ["missing", []],
  ["invalid-patch", ["--max-steps", "0"]],
  ["provider-reject", ["--model", "deepseek-v4-pro"]],
];
for (const [mode, options] of cases) test(`native run --resume authority: ${mode}`, { timeout: 40000 }, async t => {
  const s = await setup(t, mode === "no-shell" ? ["--allow-shell"] : mode === "no-file-tools" ? ["--allow-file-tools"] : []);
  assert.equal(s.initial.resumed, false); assert.equal(s.initial.model, "deepseek-flash");
  if (mode === "fresh") { assert.equal(s.before.meta.runtimeConfig.revision, 1); return; }
  const extra = mode.startsWith("stale-cas") ? { AGINTI_TEST_RESUME_MODE: "stale-cas" } : mode === "provider-reject" ? { AGINTI_TEST_RESUME_MODE: "provider-reject" } : mode === "ambient" ? { AGENT_PROVIDER: "openai", OPENAI_MODEL: "ambient-model-not-authority", AGINTI_MAIN_MODEL: "ambient-model-not-authority", SANDBOX_MODE: "docker-workspace" } : {};
  const prompt = mode === "stdin-options-are-data" ? 'Continue and explain the note, including the literal text "--provider openai --model ambient-model-not-authority" as data only.' : followup;
  const args = mode === "explicit-resume-control" ? ["resume", sid, "--stdin", ...options] : ["run", "--resume", mode === "missing" ? "missing-session-contract" : sid, ...options, ...(mode === "positional" ? [prompt] : ["--stdin"])];
  const result = await s.run(args, prompt, extra), after = await s.state(), fresh = (await s.requests()).slice(s.beforeRequests);
  assert.equal(JSON.stringify(after).includes("synthetic-offline-provider-key"), false); assert.equal(JSON.stringify(after).includes("synthetic-offline-openai-key"), false);
  await assert.rejects(fs.stat(path.dirname(s.statePath) + "/.agent-run.lock"), { code: "ENOENT" });
  if (["missing", "invalid-patch"].includes(mode) || mode.startsWith("stale-cas")) {
    assert.equal(result.code, 1, JSON.stringify(result)); assert.equal(result.machine.ok, false); assert.equal(fresh.length, 0, JSON.stringify(fresh));
    if (mode.startsWith("stale-cas")) {
      assert.match(result.machine.reason, /Session runtime revision conflict/); assert.equal(await fs.readFile(s.root + "/requests.jsonl.cas", "utf8"), "concurrent runtime revision advanced\n");
      const expected = structuredClone(s.before); expected.meta.runtimeConfig.revision++;
      assert.deepEqual(after, expected, "stale request must not overwrite concurrent runtime or mutate goal/history");
    } else { assert.deepEqual(after, s.before); assert.match(result.machine.reason, mode === "missing" ? /No saved session/ : /maxSteps/); }
    return;
  }
  const changed = options.length > 0, expectedModel = mode === "provider-only" ? "mock-agent" : mode === "provider-and-model" ? "offline-openai-contract" : changed && !["no-shell", "no-file-tools"].includes(mode) ? "deepseek-v4-pro" : "deepseek-flash";
  assert.equal(after.meta.runtimeConfig.model, expectedModel); assert.equal(after.meta.runtimeConfig.revision, 1 + Number(changed));
  assert.equal(result.machine.model, expectedModel); assert.equal(result.machine.resumed, true); assert.equal(result.machine.sessionId, sid);
  assert.equal(result.machine.provider, mode === "provider-only" ? "mock" : mode === "provider-and-model" ? "openai" : "deepseek");
  if (mode === "provider-only") assert.equal(fresh.length, 0); else { assert.ok(fresh.length > 0); assert.ok(fresh.every(r => r.origin === (mode === "provider-and-model" ? "https://api.openai.com" : "https://api.deepseek.com") && r.model === expectedModel && r.providerCredentialMatched === true), JSON.stringify(fresh)); }
  if (mode === "provider-reject") { assert.equal(result.code, 1); assert.equal(result.machine.ok, false); assert.match(result.machine.reason, /Synthetic offline provider rejection/); return; }
  assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.machine.ok, true); assert.equal(result.machine.goalRevision, 2);
  assert.ok(after.chat.some(m => m.role === "user" && m.content.includes("release window is Wednesday")));
  const events = await s.events(); assert.equal(events.filter(e => e.type === "session.resumed").length, 1); assert.equal(events.filter(e => e.type === "session.finished").length, 2);
  assert.equal(after.meta.runtimeConfig.allowShellTool, false); assert.equal(after.meta.runtimeConfig.allowFileTools, false); assert.equal(after.meta.runtimeConfig.sandboxMode, "host");
  if (mode !== "stdin-options-are-data") assert.equal(JSON.stringify(after).includes("ambient-model-not-authority"), false);
});
