#!/usr/bin/env node
// Opt-in live acceptance. Synthetic workspaces only; never reuse a user's repo.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveRuntimeConfig } from "../src/config.js";

const exec = promisify(execFile);
if (process.env.AGINTIFLOW_REAL_DEEPSEEK !== "1") {
  console.log("Skipped. Set AGINTIFLOW_REAL_DEEPSEEK=1 to spend DeepSeek API credits on synthetic CLI tasks.");
  process.exit(0);
}
const credentials = resolveRuntimeConfig({ provider: "deepseek" });
assert(credentials.apiKey, "Configure DeepSeek with aginti auth deepseek first.");
const parent = path.resolve(process.env.AGINTIFLOW_EVAL_ROOT || os.tmpdir());
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, "aginti-deepseek-cli-"));
await fs.chmod(root, 0o700);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.env.AGINTIFLOW_EVAL_CLI || path.join(repo, "bin/aginti-cli.js");
const account = path.join(root, "account");
const workspace = path.join(root, "workspace");
const sandboxMode = process.env.AGINTIFLOW_EVAL_SANDBOX || "docker-workspace";
assert(["host", "docker-workspace"].includes(sandboxMode), "Evaluation supports Normal mode only.");
await fs.mkdir(workspace);
const report = { ok: false, workspace, cli, sandboxMode, cases: [] };
const env = {
  ...process.env, AGINTIFLOW_HOME: account, AGINTIFLOW_RUNTIME_DIR: "",
  DEEPSEEK_API_KEY: credentials.apiKey, DEEPSEEK_BASE_URL: credentials.baseURL,
  AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1",
  AGENT_PROVIDER: "deepseek", AGINTI_ROUTE_PROVIDER: "deepseek",
  AGINTI_MAIN_PROVIDER: "deepseek", AGINTI_SPARE_PROVIDER: "deepseek",
  AGINTI_ROUTE_MODEL: "deepseek-v4-flash", AGINTI_MAIN_MODEL: "deepseek-v4-pro",
  AGINTI_SPARE_MODEL: "deepseek-v4-pro", LLM_MODEL: "",
  // Deliberately hostile ambient preference: CLI opt-out must override it.
  ALLOW_WRAPPER_TOOLS: "true",
};
const flags = ["--json", "--provider", "deepseek", "--routing", "fast", "-s", "normal", "--sandbox-mode", sandboxMode,
  "--package-install-policy", sandboxMode === "host" ? "block" : "allow", "--no-wrappers", "--no-auxiliary-tools",
  "--no-mcp", "--no-web-search", "--no-parallel-scouts", "--max-steps", "20"];
const notes = "The invoice utility returns currency units although callers need integer cents. Preserve product names such as 緑茶.\n";
const risks = "Round each unit before multiplying. Halfway rounds up. Original customer data must stay unchanged.\n";
const files = {
  "notes.txt": notes, "risks.txt": risks,
  ".gitignore": ".aginti/\n.aginti-sessions/\n.sessions/\n",
  "README.md": "# Invoice utility\n\n`totalCents(items)` returns integer cents. Each item has a nonnegative ordinary decimal price (number or numeric string, no exponent notation) and a positive integer quantity. Round each unit price to cents before multiplying; halfway rounds up. Run `npm test`.\n",
  "package.json": JSON.stringify({ name: "invoice-acceptance", private: true, type: "module", scripts: { test: "node --test" } }),
  "invoice.js": "export function totalCents(items) { return items.reduce((sum, x) => sum + x.price * x.quantity, 0); }\n",
  "invoice.test.js": `import test from 'node:test';
import assert from 'node:assert/strict';
import { totalCents } from './invoice.js';
test('empty', () => assert.equal(totalCents([]), 0));
test('decimal strings', () => assert.equal(totalCents([{price:'19.99',quantity:2},{price:'0.10',quantity:3}]), 4028));
test('per-unit half-up', () => assert.equal(totalCents([{price:'1.005',quantity:2}]), 202));
test('halfway at larger magnitude', () => assert.equal(totalCents([{price:'10.075',quantity:2}]), 2016));
`,
};
for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(workspace, name), content);
await exec("git", ["init", "-q"], { cwd: workspace });
await exec("git", ["add", "."], { cwd: workspace });
await exec("git", ["-c", "user.name=AgInTi acceptance", "-c", "user.email=acceptance@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Seed synthetic workspace"], { cwd: workspace });

async function inputCheck() {
  assert.equal(await fs.readFile(path.join(workspace, "notes.txt"), "utf8"), notes);
  assert.equal(await fs.readFile(path.join(workspace, "risks.txt"), "utf8"), risks);
}

async function run(name, args) {
  const started = Date.now();
  const record = { name, ok: false };
  report.cases.push(record);
  let stdout = "", stderr = "";
  try {
    ({ stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      cwd: workspace, env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
    }));
    const result = JSON.parse(stdout.trim());
    assert.equal(result.ok, true);
    assert.equal(result.failed, false);
    assert.equal(result.stopped, false);
    assert.equal(result.provider, "deepseek");
    assert.equal(result.model, "deepseek-v4-flash");
    const history = await fs.readFile(path.join(account, "sessions", result.sessionId, "events.jsonl"), "utf8");
    const events = history.trim().split("\n").map(line => JSON.parse(line));
    const requests = events.filter(e => e.type === "model.requested");
    assert(requests.length > 0, "No live model evidence");
    assert(requests.every(e => e.data.provider === "deepseek"), "Unexpected executor provider");
    assert(!events.some(e => e.type === "tool.started" && e.data.toolName === "run_agent_tool"), "An external wrapper was used");
    await inputCheck();
    Object.assign(record, {
      sessionId: result.sessionId, resumed: result.resumed, goalRevision: result.goalRevision,
      model: result.model, modelTurnsCumulative: requests.length,
      toolCallsCumulative: events.filter(e => e.type === "tool.started").length,
    });
    return { record, result, events };
  } catch (error) {
    stdout ||= error.stdout || "";
    stderr ||= error.stderr || "";
    // Never serialize child errors: they contain spawnargs/environment details.
    record.failure = error.code || error.name || "acceptance_failed";
    throw error;
  } finally {
    record.durationSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
    await fs.writeFile(path.join(root, `${name}.json`), stdout, { mode: 0o600 });
    await fs.writeFile(path.join(root, `${name}.stderr`), stderr, { mode: 0o600 });
  }
}

async function checkCode() {
  const checked = await exec(process.execPath, ["--test"], { cwd: workspace, timeout: 30_000 });
  await fs.writeFile(path.join(root, "independent-tests.log"), checked.stdout);
  // Separate oracle, outside the model's workspace and supplied test file.
  const oracle = `import assert from 'node:assert/strict'; import { totalCents } from './invoice.js';
for (const [price,cents] of [['0',0],['19.99',1999],['0.10',10],['1.005',101],['10.075',1008],['9.995',1000],['2.675',268]]) {
  for (const quantity of [1,2,7]) assert.equal(totalCents([{price,quantity}]),cents*quantity);
} assert.equal(totalCents([{price:19.99,quantity:2}]),3998);`;
  await exec(process.execPath, ["--input-type=module", "-e", oracle], { cwd: workspace, timeout: 30_000 });
}

try {
  const docs = await run("summary", ["run", ...flags,
    "Read notes.txt and risks.txt. Write summary.md with the main issue from each. Leave the input files alone."]);
  const summary = await fs.readFile(path.join(workspace, "summary.md"), "utf8");
  assert(summary.includes("notes.txt") && summary.includes("risks.txt") && summary.length > 100);
  assert(!docs.events.some(e => e.type === "tool.started" && ["apply_patch", "write_file"].includes(e.data.toolName)
    && ["notes.txt", "risks.txt"].includes(e.data.args?.path)), "Input was temporarily edited");
  docs.record.ok = true;

  const code = await run("fix-code", ["run", ...flags,
    "The invoice totals are wrong. Please fix the bug, add any useful regression test, run the tests, and explain what changed."]);
  await checkCode();
  code.record.ok = true;
  const implementation = await fs.readFile(path.join(workspace, "invoice.js"), "utf8");
  const tests = await fs.readFile(path.join(workspace, "invoice.test.js"), "utf8");

  const followup = await run("resume-chinese-docs", ["resume", code.result.sessionId, ...flags,
    "请在 README.md 添加一小段简体中文使用说明，示例是单价 19.99、数量 2 的緑茶。保留实现和测试文件不变，再运行一次测试确认。"]);
  assert.equal(followup.result.sessionId, code.result.sessionId);
  assert(followup.result.goalRevision > code.result.goalRevision);
  assert.equal(await fs.readFile(path.join(workspace, "invoice.js"), "utf8"), implementation);
  assert.equal(await fs.readFile(path.join(workspace, "invoice.test.js"), "utf8"), tests);
  const readme = await fs.readFile(path.join(workspace, "README.md"), "utf8");
  assert(readme.includes("緑茶") && /使用|示例|数量|单价/.test(readme));
  await checkCode();
  followup.record.ok = true;
  report.ok = true;
} catch (error) {
  report.failure = error.code || error.name || "acceptance_failed";
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.log(`Private evidence: ${root}`);
}
