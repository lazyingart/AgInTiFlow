import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile), child = new URL("./fixtures/native-project-instructions.js", import.meta.url).pathname;
const excluded = "SYNTHETIC_UNADMITTED_INSTRUCTION_ROW", approved = "APPROVED_PROJECT_GUIDANCE_ROW";

async function fixture(t, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-instruction-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), foreign = path.join(root, "not-admitted");
  await fs.mkdir(workspace); await fs.mkdir(foreign);
  const target = path.join(workspace, "AGINTI.md"), source = path.join(foreign, "instructions.md");
  await fs.writeFile(source, excluded + "\n"); await fs.writeFile(path.join(workspace, "owner.txt"), "Leave this unrelated input alone.\n");
  const requests = [], errors = []; let phase;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push({ phase, body }); assert.ok(requests.length < 12);
      const message = body.tools ? { role: "assistant", content: null, tool_calls: [{ id: "instruction_" + phase, type: "function",
        function: { name: "finish", arguments: '{"result":"READY"}' } }] }
        : { role: "assistant", content: "Reply READY without project changes." };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(String(error)); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function install(next) {
    await fs.rm(target, { force: true });
    if (mode === "ordinary" || (mode === "resume-outside" && next === "start")) await fs.writeFile(target, "# " + approved + "\n");
    else if (mode === "invalid-text") await fs.writeFile(target, Buffer.from([0x23, 0x20, 0xff]));
    else if (mode === "sensitive") {
      const sensitive = path.join(workspace, ".env"); await fs.writeFile(sensitive, excluded + "\n"); await fs.symlink(sensitive, target);
    } else await fs.symlink(source, target);
  }
  const dir = path.join(root, "sessions/native-project-instructions");
  async function run(next) {
    phase = next; await install(next);
    const value = await exec(process.execPath, [child, root, "http://127.0.0.1:" + server.address().port + "/v1", next], {
      cwd: workspace, timeout: 15000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "home"),
        AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0",
        ...(process.env.AGINTI_TEST_INSTRUCTION_RUNTIME ? { AGINTI_TEST_INSTRUCTION_RUNTIME: process.env.AGINTI_TEST_INSTRUCTION_RUNTIME } : {}) },
    });
    assert.deepEqual(errors, []); return JSON.parse(value.stdout.trim().split("\n").at(-1));
  }
  return { root, workspace, source, requests, run, state: () => fs.readFile(path.join(dir, "state.json"), "utf8"),
    events: () => fs.readFile(path.join(dir, "events.jsonl"), "utf8") };
}

for (const mode of ["outside", "resume-outside", "sensitive", "invalid-text", "ordinary"]) {
  test("native start and fresh-process provider continuation protect implicit instructions: " + mode, { timeout: 35000 }, async t => {
    const f = await fixture(t, mode);
    for (const phase of ["start", "resume"]) {
      const result = await f.run(phase); assert.equal(result.result.goalStatus, "completed", JSON.stringify(result));
      const stateText = await f.state(), state = JSON.parse(stateText), events = await f.events();
      const current = f.requests.filter(row => row.phase === phase); assert.ok(current.length > 0);
      assert.equal(JSON.stringify(current).includes(excluded), false); assert.equal(stateText.includes(excluded), false);
      assert.equal(events.includes(excluded), false); assert.equal(stateText.includes("\ufffd"), false);
      const readable = mode === "ordinary" || mode === "resume-outside" && phase === "start";
      assert.equal(state.meta.projectInstructions.exists, readable);
      if (readable) assert.ok(JSON.stringify(current).includes(approved));
      assert.equal(state.meta.runtimeConfig.revision, phase === "start" ? 1 : 2);
      assert.ok(current.every(row => row.body.model === (phase === "start" ? "deepseek-v4-flash" : "deepseek-v4-pro")));
      assert.equal(await fs.readFile(f.source, "utf8"), excluded + "\n");
      assert.equal(await fs.readFile(path.join(f.workspace, "owner.txt"), "utf8"), "Leave this unrelated input alone.\n");
    }
  });
}
