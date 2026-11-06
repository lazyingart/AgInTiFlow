import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile), child = new URL("./fixtures/file-checksum-runtime.js", import.meta.url).pathname;
const note = "Latency improved from 120 ms to 90 ms.\n", sha = createHash("sha256").update(note).digest("hex");
const wrong = "0".repeat(64);
for (const mode of ["correct", "repair", "fail-closed", "abbreviation-repair", "content-repair", "cn-repair", "jp-repair", "resume"]) {
  test(`native persisted checksum completion: ${mode}`, { timeout: 25000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-checksum-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(root + "/workspace"); await fs.writeFile(root + "/workspace/note.txt", note);
    let step = 0, phase = "start", total = 0; const errors = [];
    const candidate = correct => mode.startsWith("cn") ? `note.txt 的 SHA-256 为 ${correct ? sha : wrong}。`
      : mode.startsWith("jp") ? `note.txt の SHA-256 は ${correct ? sha : wrong}。`
      : mode.startsWith("abbreviation") ? `The note reports latency improving from 120 ms to 90 ms.\n- \`note.txt\` (unchanged): sha256 \`${correct ? "714bde9f…cf162d" : "714bde9f…b162d"}\`, 39 bytes.`
      : `The SHA-256 of note.txt is ${correct ? sha : wrong}.`;
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks)); total++;
        const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
        let message;
        if (!body.tools) message = { content: "Read the file, then report the observed answer without changing it." };
        else if (++step === 1 && phase === "start") message = { tool_calls: [call("read_file", { path: "note.txt" }, "checksum_read")] };
        else {
          const correct = mode === "correct" || mode === "resume" && phase === "start" || mode !== "fail-closed" && step >= (phase === "start" ? 3 : 2);
          if (!correct && step > (phase === "start" ? 2 : 1)) assert.ok(body.messages.some(m => m.role === "user" && m.content?.includes("native read_file SHA-256 receipt")));
          message = mode === "content-repair" ? { content: candidate(correct) } : { tool_calls: [call("finish", { result: candidate(correct) }, `checksum_finish_${phase}_${step}`)] };
        }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
      } catch (error) { errors.push(error.message); res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"Offline checksum fixture rejected request"}}'); }
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
    const invoke = async () => {
      const result = await run(process.execPath, [child, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase], {
        timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" },
      }).catch(error => { if (mode === "resume" && phase === "start" && error.code === 1) return error; throw error; });
      return JSON.parse(result.stdout.trim().split("\n").at(-1));
    };
    let result = await invoke();
    if (mode === "resume") { assert.equal(result.errorCode, "OBSERVER_DELIVERY_FAILED"); phase = "resume"; step = 0; result = await invoke(); }
    assert.deepEqual(errors, []);
    const dir = root + "/sessions/checksum-" + mode;
    const state = JSON.parse(await fs.readFile(dir + "/state.json"));
    const events = (await fs.readFile(dir + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(await fs.readFile(root + "/workspace/note.txt", "utf8"), note);
    assert.equal(events.filter(e => e.type === "tool.completed" && e.data.toolName === "read_file").length, 1);
    assert.equal(events.some(e => e.type === "tool.started" && ["write_file", "apply_patch", "run_command"].includes(e.data.toolName)), false);
    assert.equal(events.filter(e => e.type === "completion.file_checksum_rejected").length, mode === "correct" ? 0 : mode === "fail-closed" ? 2 : 1);
    if (mode === "fail-closed") {
      assert.equal(result.stopped, true); assert.equal(result.reason, "file_checksum_mismatch");
      assert.equal(state.meta.goalContract.status, "paused"); assert.equal(events.some(e => e.type === "session.finished"), false);
      assert.equal(total, 4);
    } else { assert.notEqual(result.stopped, true); assert.equal(state.meta.goalContract.status, "completed"); assert.ok(!result.result.includes(wrong)); }
    await assert.rejects(fs.stat(dir + "/.agent-run.lock"), { code: "ENOENT" });
  });
}
