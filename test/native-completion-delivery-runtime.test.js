import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";

const childPath = new URL("./fixtures/native-completion-delivery-runtime.js", import.meta.url).pathname;
const note = "The offline route remains blocked. The accessibility check is complete.\n";
const summary = "# Summary\n\nAccessibility is complete; the offline route remains blocked.\n";
const final = "Saved summary.md. Accessibility is complete; the offline route remains blocked. The source note is unchanged.";
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

for (const scenario of [
  "finish:normal", "finish:event-sync", "finish:event-async", "finish:event-hostile", "finish:event-hang", "finish:event-late-reject",
  "finish:console-sync", "finish:console-async", "finish:console-hostile", "finish:console-hang", "finish:both", "finish:abort",
  "finish:diagnostic-write-error", "finish:state-write-error", "finish:event-write-error",
  "assistant:event-sync", "direct:event-sync", "direct:intent-sync", "response:event-sync", "response:model-async", "noop:event-sync",
]) test(`durable completion versus observer delivery: ${scenario}`, { timeout: 30000 }, async t => {
  const [kind, mode] = scenario.split(":"), root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-completion-delivery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(root + "/workspace"); await fs.writeFile(root + "/workspace/note.txt", note);
  let requests = 0, steps = 0; const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests++;
      let message;
      if (kind === "response") { assert.equal(body.tools, undefined); message = { content: "Blocked work still needs its blocker resolved, so it should stay blocked rather than be marked done." }; }
      else if (!body.tools) message = { content: "Read the supplied source, write the summary and finish." };
      else if (++steps === 1) message = { tool_calls: [call("read_file", { path: "note.txt" }, "read_source")] };
      else if (steps === 2) message = { tool_calls: [body.tools.some(tool => tool.function.name === "write_file")
        ? call("write_file", { path: "summary.md", content: summary, mode: "create" }, "write_summary")
        : call("apply_patch", { patch: "*** Begin Patch\n*** Add File: summary.md\n" + summary.trimEnd().split("\n").map(line => "+" + line).join("\n") + "\n*** End Patch" }, "write_summary")] };
      else message = kind === "assistant" ? { content: final } : { tool_calls: [call("finish", { result: final }, "finish_summary")] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (error) { errors.push(error.message); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const run = (phase) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, root, `http://127.0.0.1:${server.address().port}/v1`, scenario, phase], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", expired = false;
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 12000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve({ code, expired, stdout, stderr }); });
  });
  const child = await run("start");
  assert.equal(child.code, 0, JSON.stringify(child)); assert.equal(child.expired, false); assert.deepEqual(errors, []);
  assert.doesNotMatch(child.stderr, /CALLBACK_PRIVATE_SENTINEL|unhandled/i);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1));
  assert.equal(report.unhandled, 0); assert.equal(report.trapReads, 0); assert.equal(report.abortListeners, 0);
  const session = root + "/sessions/completion-delivery";
  const load = async () => ({ state: JSON.parse(await fs.readFile(session + "/state.json")), events: (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse) });
  const { state, events } = await load();
  assert.doesNotMatch(JSON.stringify({ state, events }), /CALLBACK_PRIVATE_SENTINEL/);
  assert.equal(await fs.readFile(root + "/workspace/note.txt", "utf8"), note);
  if (!["direct", "response"].includes(kind)) assert.equal(await fs.readFile(root + "/workspace/summary.md", "utf8"), summary);
  if (["state-write-error", "event-write-error"].includes(mode)) {
    assert.equal(report.resolved, false); assert.equal(report.errorCode, "EIO");
    assert.equal(state.meta.goalContract.status, "failed");
    assert.equal(events.some(event => event.type === "session.finished"), false);
    assert.deepEqual(report.seen, []);
    return;
  }
  assert.equal(report.resolved, true); assert.equal(report.outcome.goalStatus, "completed");
  assert.equal(state.meta.goalContract.status, "completed"); assert.ok(report.durable.every(Boolean));
  assert.equal(events.filter(event => event.type === "session.finished").length, 1);
  assert.equal(events.some(event => event.type === "session.failed" || event.type === "provider.handoff_requested"), false);
  assert.ok(report.seen.includes("session.finished") && report.seen.includes("console"), "one failing observer must not skip remaining delivery");
  const expectWarning = kind !== "noop" && !["normal", "abort"].includes(mode);
  if (expectWarning) {
    const initialWarning = report.outcome.observerDelivery;
    assert.ok(initialWarning, "delivery failure must be visible to the caller");
    assert.equal(initialWarning.status, "incomplete"); assert.equal(initialWarning.diagnosticPersisted, mode !== "diagnostic-write-error");
    if (mode.includes("hang") || mode === "event-late-reject") assert.ok(initialWarning.timedOut.length);
    else assert.ok(initialWarning.failed.length);
    assert.equal(events.filter(event => event.type === "session.observer_delivery_failed").length, mode === "diagnostic-write-error" ? 0 : 1);
  } else assert.equal(report.outcome.observerDelivery, undefined);
  if (!["direct", "response"].includes(kind)) {
    const before = requests, mutations = events.filter(event => event.type === "file.changed").length;
    const resumed = await run("resume"); assert.equal(resumed.code, 0, JSON.stringify(resumed)); assert.equal(resumed.expired, false);
    const again = JSON.parse(resumed.stdout.trim().split("\n").at(-1));
    assert.equal(again.resolved, true); assert.equal(again.outcome.goalStatus, "completed");
    assert.match(again.outcome.result, /saved task is already complete/i);
    assert.equal(again.unhandled, 0); assert.equal(requests, before, "completed task resume must not redispatch a provider or tool");
    assert.equal(Boolean(again.outcome.observerDelivery), kind === "noop");
    const after = await load(); assert.equal(after.events.filter(event => event.type === "file.changed").length, mutations);
    assert.equal(after.state.meta.goalContract.status, "completed");
    assert.equal(await fs.readFile(root + "/workspace/summary.md", "utf8"), summary);
  }
  await assert.rejects(fs.stat(session + "/.agent-run.lock"), { code: "ENOENT" });
});
