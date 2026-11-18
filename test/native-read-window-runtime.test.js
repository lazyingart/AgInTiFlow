import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildContextBudgetCompactionMessages, successfulReadFileEvidencePaths } from "../src/agent-runner.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/aginti-cli.js", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/native-read-window-provider.js", import.meta.url));
const source = "Old: red folder.\r\nClosed: old schedule.\r\nEnd of archive.\r\nOpen: proofread legend.\r\nOpen: confirm units.";

for (const mode of ["suffix", "past-eof"]) test(`native CLI preserves the requested read window across restart: ${mode}`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-read-window-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work");
  await fs.mkdir(work);
  const file = path.join(work, "handoff.txt");
  await fs.writeFile(file, source);
  const before = await fs.stat(file, { bigint: true });
  const session = "read-window", trace = path.join(root, "trace.jsonl"), agentHome = path.join(root, "agent");
  const env = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", XDG_CONFIG_HOME: path.join(root, "config"),
    AGINTIFLOW_HOME: agentHome, AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTO_UPDATE: "1",
    AGINTIFLOW_HOUSEKEEPING: "0", AGINTI_PROVIDER_HANDOFF: "0", DEEPSEEK_API_KEY: "synthetic-offline-fixture",
    READ_WINDOW_TRACE: trace, READ_WINDOW_MODE: mode };
  const run = async args => {
    const { stdout } = await exec(process.execPath, ["--import", provider, cli, ...args], { cwd: work, env, timeout: 12000 })
      .catch(async error => { throw Error((error.stdout || error.message) + "\n" + await fs.readFile(trace, "utf8").catch(() => ""), { cause: error }); });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true, stdout);
    assert.equal(result.sessionId, session);
    return result;
  };
  const start = mode === "suffix" ? 4 : 6;
  const initial = await run(["run", "--json", "--session-id", session, "--provider", "deepseek", "--model", "deepseek-flash",
    "--routing", "manual", "--profile", "code", "--no-scs", "--max-steps", "3", "--dynamic-steps", "off",
    "--sandbox-mode", "host", "--allow-file-tools", "--no-shell", "--no-web-search", "--no-mcp", "--no-wrappers",
    "--no-auxiliary-tools", "--no-parallel-scouts", `Read handoff.txt from line ${start} to the end and tell me what is there. Leave it unchanged.`]);
  const resumed = await run(["resume", session, "--json", "--model", "deepseek-v4-pro", "What did the saved excerpt say? Use the existing result."]);
  const expected = mode === "suffix" ? "Open: proofread legend.\nOpen: confirm units." : "";
  for (const r of [initial, resumed]) {
    assert.ok(r.result.includes(expected || "EOF"));
    assert.ok(!r.result.includes("red folder"));
  }
  const requests = (await fs.readFile(trace, "utf8")).trim().split("\n").map(JSON.parse).filter(r => r.offered.length);
  assert.deepEqual(requests.map(r => [r.model, r.reads.length]), [["deepseek-flash", 0], ["deepseek-flash", 1], ["deepseek-v4-pro", 1]]);
  const state = JSON.parse(await fs.readFile(path.join(agentHome, "sessions", session, "state.json")));
  const stored = state.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content)).filter(r => r.toolName === "read_file");
  assert.equal(stored.length, 1);
  for (const r of [stored[0], requests[1].reads[0], requests[2].reads[0]]) {
    assert.equal(r.content, expected);
    assert.equal(r.startLine, start);
    assert.equal(r.contentTruncatedByLines, true);
    assert.equal(r.sha256, createHash("sha256").update(source).digest("hex"));
  }
  assert.deepEqual(successfulReadFileEvidencePaths(state.messages), [{ path: "handoff.txt", complete: false }]);
  const after = await fs.stat(file, { bigint: true });
  assert.deepEqual([after.ino, after.ctimeNs, after.mtimeNs], [before.ino, before.ctimeNs, before.mtimeNs]);
});

test("legacy suffix metadata cannot turn a partial read into whole-file evidence", () => {
  for (const context of ["tool", "retained"]) {
    const args = { path: "handoff.txt", startLine: 4, lineLimit: 20 };
    const payload = { ok: true, toolName: "read_file", path: args.path, content: "only the end",
      startLine: 4, lineCount: 5, lineLimit: 20, contentTruncatedByLines: false, contentTruncated: false };
    const messages = context === "tool" ? [
      { role: "assistant", tool_calls: [{ id: "one", function: { name: "read_file", arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: "one", content: JSON.stringify(payload) },
    ] : [{ role: "user", content: `Retained runtime tool evidence.\nTool: read_file\nArguments: ${JSON.stringify(args)}\nVerified result: ${JSON.stringify(payload)}` }];
    assert.deepEqual(successfulReadFileEvidencePaths(messages), [{ path: args.path, complete: false }]);
  }
});

test("compacting a read preserves its coverage through repeated provider handoff", () => {
  const cases = [
    ["short", { content: "all" }, true],
    ["empty", { content: "", contentPreview: "obsolete" }, true],
    ["preview", { contentPreview: "only the beginning" }, false],
    ["long", { content: "x".repeat(3100) }, false],
    ["suffix", { startLine: 4, lineCount: 5, content: "a\nb", contentTruncatedByLines: false }, false],
  ];
  const state = { goal: "Use the saved file evidence.", messages: cases.flatMap(([name, fields]) => {
    const args = { path: name, startLine: fields.startLine || 1 };
    return [
      { role: "assistant", tool_calls: [{ id: name, type: "function", function: { name: "read_file", arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: name, content: JSON.stringify({ ok: true, toolName: "read_file", path: name, ...fields }) },
    ];
  }) };
  for (const provider of ["deepseek", "localllm"]) {
    state.messages = buildContextBudgetCompactionMessages(state, { provider }, {}, 1);
    const coverage = new Map(successfulReadFileEvidencePaths(state.messages).map(row => [row.path, row.complete]));
    for (const [name, , complete] of cases) assert.equal(coverage.get(name), complete, provider + " " + name);
    assert.ok(!JSON.stringify(state.messages).includes("obsolete"));
  }
});
