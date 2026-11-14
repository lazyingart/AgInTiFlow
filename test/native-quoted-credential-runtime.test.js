import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const exec = promisify(execFile), fixture = new URL("./fixtures/native-quoted-credential-runtime.js", import.meta.url);
const marker = "DEMO_ONLY_NOT_A_REAL_CREDENTIAL";
const source = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { repairModelMessageHistory } = await import(pathToFileURL(path.join(source, "src/agent-runner.js")));

test("legacy textual history repair is copy-on-change and leaves image bytes and call IDs intact", () => {
  const image = Object.freeze({ type: "image_url", image_url: Object.freeze({ url: "data:image/png;base64,AAAA" }) });
  const parts = Object.freeze([Object.freeze({ type: "text", text: JSON.stringify({ password: marker }) }), image]);
  const prior = [Object.freeze({ role: "user", content: parts }), {
    role: "assistant", content: "Observed metadata.", reasoning_content: JSON.stringify({ password: marker }),
    tool_calls: [{ id: "legacy_call", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `notes/${JSON.stringify({ password: marker })}.txt` }) } }],
  }, { role: "tool", tool_call_id: "legacy_call", content: JSON.stringify({ content: `password="${marker}"` }) }];
  const state = { messages: prior }, result = repairModelMessageHistory(state, { provider: "openai" });
  assert.equal(result.changed, true);assert.equal(JSON.stringify(state.messages).includes(marker), false);
  assert.equal(prior[0].content, parts);assert.ok(parts[0].text.includes(marker));
  assert.equal(state.messages[0].content[1], image);
  assert.equal(state.messages[1].tool_calls[0].id, "legacy_call");assert.equal(state.messages[2].tool_call_id, "legacy_call");
  assert.equal(repairModelMessageHistory(state, { provider: "openai" }).changed, false);
});

for (const scenario of ["read", "argument", "legacy"]) test(`native ${scenario} redacts JSON credentials before provider, durable events and explicit Pro restart`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-quoted-credential-"));
  const workspace = path.join(root, "workspace");await fs.mkdir(path.join(workspace, "notes"), { recursive: true });
  const original = JSON.stringify({ status: "pending independent review", password: marker });
  await fs.writeFile(path.join(workspace, "notes/current.json"), original);
  await fs.writeFile(path.join(workspace, "keep.txt"), "Leave this unrelated file unchanged.\n");
  const observations = [];let phase = "initial", turns = 0;
  const server = http.createServer((req, res) => {
    let body = "";req.on("data", bytes => body += bytes);
    req.on("end", () => {
      const request = JSON.parse(body);
      observations.push({ phase, model: request.model, markerPresent: body.includes(marker), masked: body.includes("[REDACTED]") });
      let message;
      if (!request.tools) message = { role: "assistant", content: "Read the selected note and report its observed status without changing files." };
      else {
        turns++;
        const adversarialArgument = scenario === "argument" && phase === "initial" && turns === 1;
        const first = turns === 1 || (scenario === "argument" && phase === "initial" && turns === 2);
        message = { role: "assistant", content: null, tool_calls: [{ id: phase + "_" + turns, type: "function", function: {
          name: first ? "read_file" : "finish",
          arguments: JSON.stringify(first ? { path: adversarialArgument ? `notes/${JSON.stringify({ password: marker })}.txt` : "notes/current.json" }
            : { result: "The selected note reports pending independent review. No files were changed." }),
        } }] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    });
  });
  server.listen(0, "127.0.0.1");await once(server, "listening");
  try {
    for (const next of ["initial", "resume"]) {
      phase = next;turns = 0;
      const { stdout } = await exec(process.execPath, [fixture.pathname, root, `http://127.0.0.1:${server.address().port}/v1`, phase], {
        env: { PATH: process.env.PATH, HOME: root, AGINTIFLOW_HOME: path.join(root, "home"),
          AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1",
          ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) },
        timeout: 12000, maxBuffer: 1024 * 1024,
      });
      const result = JSON.parse(stdout.trim().split("\n").at(-1));assert.equal(result.stopped, false);
      assert.equal(result.model, phase === "initial" ? "deepseek-flash" : "deepseek-v4-pro");
      assert.equal(observations.some(value => value.markerPresent), false, "A synthetic credential must never reach a model request");
      const directory = path.join(root, "sessions/native-quoted-credential");
      for (const file of ["state.json", "events.jsonl"]) {
        const text = await fs.readFile(path.join(directory, file), "utf8");assert.equal(text.includes(marker), false, file);assert.ok(text.includes("[REDACTED]"), file);
      }
      if (scenario === "legacy" && phase === "initial") {
        // A test-owned legacy state frame, not a new tool result or instruction.
        // Immutable old events are not rewritten as a privacy migration.
        const file = path.join(directory, "state.json"), state = JSON.parse(await fs.readFile(file, "utf8"));
        state.messages.push({ role: "user", content: "Earlier source metadata: " + JSON.stringify({ password: marker }) });
        await fs.writeFile(file, JSON.stringify(state));
      }
    }
    assert.ok(observations.some(value => value.phase === "resume" && value.masked));
    assert.equal(await fs.readFile(path.join(workspace, "notes/current.json"), "utf8"), original);
    assert.equal(await fs.readFile(path.join(workspace, "keep.txt"), "utf8"), "Leave this unrelated file unchanged.\n");
  } finally {
    const done = once(server, "close");server.close();server.closeAllConnections();await done;
    await fs.rm(root, { recursive: true, force: true });
  }
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
});
