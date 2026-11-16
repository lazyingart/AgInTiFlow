import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile), child = new URL("./fixtures/native-text-tool-turn.js", import.meta.url).pathname;
const note = "The check is complete. Rollout still needs owner review.\n", summary = "# Summary\n\nThe check is complete; rollout awaits owner review.\n";
const sentinel = "PRIVATE_TURN_SENTINEL", args = JSON.stringify({ path: "summary.md", content: summary, mode: "create" });
const invalid = {
  requested: `Requested tools: write_file(${args}); read_file({"path":"${sentinel}`,
  bracket: `[TOOL_CALLS]write_file[ARGS]${args}[TOOL_CALLS]read_file[ARGS]{"path":"${sentinel}`,
  block: `TOOL_CALLS: \`\`\`json [{"name":"read_file","name":"write_file","arguments":${args}}] \`\`\``,
  standalone: `{"toolName":"read_file","toolName":"write_file","args":${args}}`,
  xml: `<tool_calls><tool_call name="write_file">${args}</tool_call><tool_call name="read_file">{"path":"${sentinel}`,
  quoted: `<function="write_file"><parameter="path">summary.md</parameter><parameter="content">${summary}</parameter></function><function="read_file"><parameter="path">${sentinel}`,
};
for (const scenario of [...Object.keys(invalid), "repair", "native", "fenced"]) test(`real persisted whole text turn: ${scenario}`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-text-turn-")), workspace = path.join(root, "workspace");
  t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.mkdir(workspace, { mode: 0o700 }); await fs.writeFile(path.join(workspace, "note.txt"), note);
  let phase = "start", step = 0, acceptedWrites = 0; const requests = [], errors = [];
  const native = (name, arguments_) => ({ role: "assistant", content: null, tool_calls: [{ id: "text_turn_" + requests.length, type: "function", function: { name, arguments: JSON.stringify(arguments_) } }] });
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const bytes of req) chunks.push(bytes); const body = JSON.parse(Buffer.concat(chunks));
      requests.push({ phase, model: body.model, tools: (body.tools || []).map(t => t.function.name) }); assert.ok(requests.length <= 16);
      // The real provider rejects even an empty array in assistant history.
      // Exercise that wire contract on every retry and fresh-process resume.
      for (const message of body.messages) {
        if (message.role === "assistant" && Object.hasOwn(message, "tool_calls")) {
          assert.ok(Array.isArray(message.tool_calls) && message.tool_calls.length > 0, "provider history tool_calls must be a nonempty array when present");
        }
      }
      let message;
      if (!body.tools) message = { role: "assistant", content: "Read the note, save the concise summary and verify it before finishing." };
      else if (++step === 1) message = native("read_file", { path: "note.txt" });
      else if (phase === "start" && (Object.hasOwn(invalid, scenario) || scenario === "repair" && step === 2)) {
        message = { role: "assistant", content: invalid[scenario] || invalid.requested };
      } else if (await fs.stat(path.join(workspace, "summary.md")).then(() => false, e => { if (e.code === "ENOENT") return true; throw e; })) {
        if (body.tools.some(t => t.function.name === "write_file")) message = native("write_file", { path: "summary.md", content: summary, mode: "create" });
        else {
          assert.ok(body.tools.some(t => t.function.name === "apply_patch"));
          message = native("apply_patch", { patch: "*** Begin Patch\n*** Add File: summary.md\n" + summary.trimEnd().split("\n").map(line => "+" + line).join("\n") + "\n*** End Patch" });
        }
        acceptedWrites++;
        if (scenario === "fenced") {
          const call = message.tool_calls[0];
          message = { role: "assistant", content: 'Example only:\n```json\n{"toolName":"write_file","args":{"path":"never-create.md","content":"example only"}}\n```\nRequested tool: '+call.function.name+'('+call.function.arguments+')' };
        }
      } else message = native("finish", { result: "Created summary.md from note.txt; the original note is unchanged." });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(String(error.stack)); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const dir = path.join(root, "sessions/text-turn-" + scenario);
  async function run(next) {
    phase = next; step = 0;
    const r = await exec(process.execPath, [child, root, "http://127.0.0.1:" + server.address().port + "/v1", scenario, next], { cwd: workspace, timeout: 15000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0",
        ...(process.env.AGINTI_TEST_TEXT_TURN_RUNTIME ? { AGINTI_TEST_TEXT_TURN_RUNTIME: process.env.AGINTI_TEST_TEXT_TURN_RUNTIME } : {}) } });
    const outcome = JSON.parse(r.stdout.trim().split("\n").at(-1)); assert.equal(outcome.error, undefined, JSON.stringify({ outcome, errors })); assert.deepEqual(errors, []); return outcome;
  }
  let outcome = await run("start");
  if (Object.hasOwn(invalid, scenario)) {
    assert.equal(outcome.result.goalStatus, "paused"); assert.equal(outcome.result.reason, "malformed_tool_arguments"); assert.equal(acceptedWrites, 0);
    await assert.rejects(fs.stat(path.join(workspace, "summary.md")), { code: "ENOENT" });
    const text = await fs.readFile(path.join(dir, "events.jsonl"), "utf8"), state = await fs.readFile(path.join(dir, "state.json"), "utf8");
    assert.equal(text.includes(sentinel), false); assert.equal(state.includes(sentinel), false);
    const first = text.trim().split("\n").map(JSON.parse);
    assert.equal(first.filter(e => e.type === "model.text_tool_retry_requested").length, 3);
    assert.equal(first.filter(e => e.type === "tool.started").length, 1, "Only the prior source read may execute");
    assert.equal(first.some(e => e.type === "session.finished"), false);
    assert.equal(JSON.parse(state).meta.runtimeConfig.revision, 1);
    await assert.rejects(fs.stat(path.join(dir, ".agent-run.lock")), { code: "ENOENT" });
    outcome = await run("resume");
  }
  assert.equal(outcome.result.goalStatus, "completed", JSON.stringify({ outcome, requests }));
  assert.equal(acceptedWrites, 1); assert.equal(await fs.readFile(path.join(workspace, "note.txt"), "utf8"), note); assert.equal(await fs.readFile(path.join(workspace, "summary.md"), "utf8"), summary);
  const events = (await fs.readFile(path.join(dir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse), saved = JSON.parse(await fs.readFile(path.join(dir, "state.json")));
  assert.equal(events.filter(e => e.type === "session.finished").length, 1);
  assert.equal(events.filter(e => e.type === "tool.completed" && ["write_file", "apply_patch"].includes(e.data.toolName)).length, 1);
  assert.equal(saved.meta.runtimeConfig.revision, Object.hasOwn(invalid, scenario) ? 2 : 1);
  assert.equal(saved.meta.runtimeConfig.model, Object.hasOwn(invalid, scenario) ? "deepseek-v4-pro" : "deepseek-v4-flash");
  if (scenario === "repair") assert.equal(events.filter(e => e.type === "model.text_tool_retry_requested").length, 1);
  assert.equal(outcome.externalModelCalls, 0);
  if (scenario === "fenced") {
    await assert.rejects(fs.stat(path.join(workspace, "never-create.md")), { code: "ENOENT" });
    assert.equal(events.filter(e => e.type === "model.text_tool_retry_requested").length, 0);
  }
  await assert.rejects(fs.stat(path.join(dir, ".agent-run.lock")), { code: "ENOENT" });
});
