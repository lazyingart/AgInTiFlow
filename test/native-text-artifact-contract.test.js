import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile), child = new URL("./fixtures/native-text-artifact-contract.js", import.meta.url).pathname;
const content = "# Release review\n\n- [ ] Build the project.\n- [ ] Run the tests.\n- [ ] Confirm rollback steps.\n";
async function fixture(t, scs, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-text-artifact-")), workspace = path.join(root, "workspace");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "out"), { recursive: true });
  await fs.writeFile(path.join(workspace, "owner.txt"), "Unrelated owner material stays unchanged.\n");
  if (mode === "preserve") for (const name of ["a.csv", "b.csv"]) await fs.writeFile(path.join(workspace, "out", name), "original," + name + "\n");
  const requested = mode === "ascii" ? "out/review.md" : mode === "keyword" ? "out/build.md" : mode === "nfd" ? "out/cafe\u0301.md" : "out/café.md";
  const actual = mode === "lookalike" ? "out/cafe.md" : mode === "normalization" ? "out/cafe\u0301.md" : requested;
  const directory = path.join(root, "sessions/text-artifact"), stateFile = path.join(directory, "state.json");
  const requests = [], errors = []; let phase, turns;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); assert.ok(requests.length < 16); requests.push({ phase, body });
      let message = { role: "assistant", content: "Create only the exact named Markdown checklist. Build, tests and rollback are checklist topics, not instructions to run commands." };
      if (body.tools) {
        const n = ++turns, blocked = mode === "legacy" && phase === "start";
        const name = blocked ? "list_files" : n === 1 ? "write_file" : "finish";
        const args = blocked ? { path: ".", maxDepth: 2, limit: 10 } : name === "write_file" ? { path: actual, content, mode: "create" }
          : { result: `Created ${actual}. The checklist covers build, tests and rollback. No commands were executed.` };
        assert.ok(body.tools.some(tool => tool.function.name === name));
        message = { role: "assistant", content: null, tool_calls: [{ id: phase + "_" + n, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
        if (mode.startsWith("scope-")) {
          const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
          let calls;
          if (n === 1) {
            // Mixed read/write batches are already serialized before dispatch.
            // Use a valid read-only batch to exercise the actual denial fence.
            calls = mode === "scope-write" ? [call(phase + "_denied", "write_file", { path: "wrong.md", content: "forbidden", mode: "create" })]
              : mode === "scope-required" ? [call(phase + "_denied", "read_file", { path: "owner.txt" })]
              : mode === "scope-explicit" || mode === "scope-lateral" ? [call(phase + "_denied", "list_files", { path: mode === "scope-lateral" ? "private" : "." })]
              : [call(phase + "_allowed", "list_files", { path: "out" }),
                  call(phase + "_denied", "list_files", { path: "." }),
                  call(phase + "_skip", "list_files", { path: "out", maxDepth: 2 })];
          }
          else if (mode === "scope-repeat") calls = [call(phase + "_repeat_" + n, "list_files", { path: "." })];
          else if (n === 2) calls = [call(phase + "_write", "write_file", { path: actual, content, mode: "create" })];
          else calls = [call(phase + "_finish", "finish", { result: `Created ${actual} with the requested checklist. The root inspection was denied and was not executed.` })];
          message = { role: "assistant", content: null, tool_calls: calls };
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(String(error)); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function run(next) {
    phase = next; turns = 0;
    const output = await exec(process.execPath, [child, root, "http://127.0.0.1:" + server.address().port + "/v1", scs, mode, phase], {
      cwd: workspace, timeout: 22000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", XDG_CONFIG_HOME: path.join(root, "config"), AGINTIFLOW_HOME: path.join(root, "home"),
        AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0" },
    });
    assert.deepEqual(errors, []);
    return JSON.parse(output.stdout.trim().split("\n").at(-1));
  }
  const state = async () => JSON.parse(await fs.readFile(stateFile));
  const events = async () => (await fs.readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  return { root, workspace, directory, stateFile, requested, actual, requests, run, state, events };
}

for (const scs of ["off", "on"]) for (const mode of ["ascii", "unicode", "nfd", "keyword", "preserve", "lookalike", "normalization", "command"]) {
  test(`native text artifact honors filename/content/command boundary: ${scs}/${mode}`, { timeout: 30000 }, async t => {
    const f = await fixture(t, scs, mode), answer = await f.run("start"), state = await f.state(), events = await f.events();
    assert.equal(await fs.readFile(path.join(f.workspace, f.actual), "utf8"), content);
    assert.equal(await fs.readFile(path.join(f.workspace, "owner.txt"), "utf8"), "Unrelated owner material stays unchanged.\n");
    assert.deepEqual((await fs.readdir(path.join(f.workspace, "out"))).sort(), [...(mode === "preserve" ? ["a.csv", "b.csv"] : []), path.basename(f.actual)].sort());
    if (mode === "preserve") for (const name of ["a.csv", "b.csv"]) assert.equal(await fs.readFile(path.join(f.workspace, "out", name), "utf8"), "original," + name + "\n");
    const shouldComplete = ["ascii", "unicode", "nfd", "keyword", "preserve"].includes(mode);
    assert.equal(answer.result.goalStatus, shouldComplete ? "completed" : "paused", JSON.stringify(answer.result));
    if (!shouldComplete) assert.equal(answer.result.stopped, true);
    const rejected = events.filter(event => event.type === "completion.evidence_rejected");
    if (mode === "lookalike" || mode === "normalization") {
      await assert.rejects(fs.stat(path.join(f.workspace, f.requested)), { code: "ENOENT" });
      assert.ok(rejected.some(event => JSON.stringify(event.data).includes(f.requested)));
    } else if (mode === "command") {
      if (scs === "off") assert.ok(rejected.some(event => /command|node --version/.test(JSON.stringify(event.data))));
      else {
        assert.ok(events.some(event => event.type === "artifact.validation_preflight" && event.data.needsCommand === true && event.data.missingProjectCommands.includes("node --version")));
        assert.ok(state.meta.scs.taskContract.requiredProjectCommands.includes("node --version"));
      }
    }
    else { assert.equal(rejected.length, 0); assert.equal(state.meta.goalContract.status, "completed"); }
    assert.equal(events.some(event => event.type === "tool.started" && event.data.toolName === "run_command"), false);
    assert.equal(events.filter(event => event.type === "tool.completed" && event.data.toolName === "write_file").length, 1);
    for (const { body } of f.requests) {
      const text = body.messages.map(message => message.content || "").join("\n");
      assert.match(text, /Workspace structured-read roots: \["out"\]/);
      assert.match(text, /Workspace structured-write roots: \["out"\]/);
      assert.doesNotMatch(text, /Writable workspace:/);
      assert.match(text, /Disabled families:.*shell/);
      if (body.tools) {
        assert.equal(body.tools.some(tool => ["run_command", "web_search", "mcp_list_servers"].includes(tool.function.name)), false);
        assert.ok(body.messages.some(message => message.role === "user" && message.content.includes(f.requested)));
      }
    }
    if (scs === "on") {
      assert.ok(f.requests.some(({ body }) => !body.tools), "the actual planning request must carry the scope");
      assert.equal(state.meta.scs.taskContract.outputRoleInferenceVersion, 2);
      assert.deepEqual(state.meta.scs.taskContract.exactOutputPaths, [f.requested]);
      if (mode === "preserve") assert.deepEqual(state.meta.scs.taskContract.preservedInputPaths, ["out/a.csv", "out/b.csv"]);
    }
    await assert.rejects(fs.stat(path.join(f.directory, ".agent-run.lock")), { code: "ENOENT" });
  });
}

test("legacy cached output roles refresh on a real paused-session Pro resume without widening scope", { timeout: 50000 }, async t => {
  const f = await fixture(t, "on", "legacy"), first = await f.run("start");
  assert.equal(first.result.reason, "permission_required");
  assert.deepEqual(await fs.readdir(path.join(f.workspace, "out")), []);
  const state = await f.state();
  // Synthetic old cache only: not a claim that these bytes came from a prior
  // release. The permission-paused runtime/session and history are genuine.
  state.meta.scs.taskContract.outputRoleInferenceVersion = 1;
  state.meta.scs.taskContract.exactOutputPaths = [];
  state.meta.scs.taskContract.requiredEvidence.push({ id: "command", category: "command", description: "stale topic inference" });
  await fs.writeFile(f.stateFile, JSON.stringify(state));
  const prefix = await fs.readFile(path.join(f.directory, "events.jsonl"), "utf8"), answer = await f.run("resume"), after = await f.state();
  assert.equal(answer.result.goalStatus, "completed", JSON.stringify(answer));
  assert.equal(after.sessionId, state.sessionId); assert.equal(after.meta.runtimeConfig.revision, 2);
  assert.deepEqual(after.meta.runtimeConfig.workspacePathScopeRoots, ["out"]);
  assert.deepEqual(after.meta.runtimeConfig.workspaceWritePathScopeRoots, ["out"]);
  assert.equal(after.meta.runtimeConfig.allowShellTool, false); assert.equal(after.meta.runtimeConfig.allowWebSearch, false); assert.equal(after.meta.runtimeConfig.allowMcpTools, false);
  // The existing runtime rebases model context on resume; the authoritative
  // task and append-only event prefix below must retain the original evidence.
  assert.equal(after.goal, state.goal); assert.ok(after.messages.some(message => message.role === "user" && message.content.includes(state.goal)));
  assert.equal(after.meta.scs.taskContract.outputRoleInferenceVersion, 2);
  assert.deepEqual(after.meta.scs.taskContract.exactOutputPaths, [f.requested]);
  assert.equal(after.meta.scs.taskContract.requiredEvidence.some(item => item.category === "command"), false);
  const replay = await fs.readFile(path.join(f.directory, "events.jsonl"), "utf8"); assert.ok(replay.startsWith(prefix));
  const appended = replay.slice(prefix.length).trim().split("\n").map(JSON.parse);
  assert.equal(appended.filter(event => event.type === "scs.output_role_contract_refreshed").length, 1);
  assert.equal(appended.some(event => event.type === "tool.started" && event.data.toolName === "run_command"), false);
  assert.equal(await fs.readFile(path.join(f.workspace, f.requested), "utf8"), content);
  assert.ok(f.requests.filter(row => row.phase === "resume").every(row => row.body.model === "deepseek-v4-pro"));
});

for (const scs of ["off", "on"]) test(`native scoped discovery gets one correction and fences the complete batch: ${scs}`, { timeout: 30000 }, async t => {
  const f = await fixture(t, scs, "scope-recover"), answer = await f.run("start"), events = await f.events(), state = await f.state();
  assert.equal(answer.result.goalStatus, "completed", JSON.stringify(answer));
  assert.equal(await fs.readFile(path.join(f.workspace, f.requested), "utf8"), content);
  assert.equal(await fs.readFile(path.join(f.workspace, "owner.txt"), "utf8"), "Unrelated owner material stays unchanged.\n");
  await assert.rejects(fs.stat(path.join(f.workspace, "out/unrequested.md")), { code: "ENOENT" });
  const denied = events.filter(e => e.type === "tool.blocked"); assert.equal(denied.length, 1);
  assert.equal(denied[0].data.args.path, "."); assert.equal(denied[0].data.permissionAdvice.autoRecover, true);
  assert.equal(denied[0].data.code, "WORKSPACE_PATH_SCOPE_DENIED");
  assert.equal(events.filter(e => e.type === "workspace.discovery_correction").length, 1);
  assert.equal(events.filter(e => e.type === "tool.skipped" && e.data.args.path === "out").length, 1);
  assert.equal(events.filter(e => e.type === "tool.completed" && e.data.toolName === "list_files").length, 1);
  assert.equal(events.filter(e => e.type === "tool.completed" && e.data.toolName === "write_file").length, 1);
  assert.equal(state.meta.nativeScopedDiscoveryCorrection.attempts, 1); assert.equal(state.meta.nativeScopedDiscoveryCorrection.goalRevision, 1);
  const next = f.requests.filter(row => row.body.tools)[1].body;
  const frame = next.messages.find(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === "start_denied"));
  assert.ok(frame); for (const call of frame.tool_calls) assert.ok(next.messages.some(message => message.role === "tool" && message.tool_call_id === call.id));
  assert.ok(next.messages.some(message => message.role === "tool" && message.tool_call_id === "start_skip" && JSON.parse(message.content).skipped === true));
  assert.equal(f.requests.some(row => JSON.stringify(row.body.messages).includes("Unrelated owner material stays unchanged.")), false);
});

for (const scs of ["off", "on"]) for (const mode of ["scope-required", "scope-explicit", "scope-write", "scope-lateral"]) test(`native scope denial stays terminal for required/unknown access: ${scs}/${mode}`, { timeout: 30000 }, async t => {
  const f = await fixture(t, scs, mode), answer = await f.run("start"), events = await f.events(), state = await f.state();
  assert.equal(answer.result.reason, "permission_required", JSON.stringify(answer.result)); assert.equal(answer.result.goalStatus, "paused");
  assert.equal(state.meta.nativeScopedDiscoveryCorrection, undefined);
  assert.equal(events.some(e => e.type === "workspace.discovery_correction"), false);
  assert.equal(events.some(e => e.type === "tool.completed" && e.data.toolName === "write_file"), false);
  assert.deepEqual(await fs.readdir(path.join(f.workspace, "out")), []);
  assert.equal(await fs.readFile(path.join(f.workspace, "owner.txt"), "utf8"), "Unrelated owner material stays unchanged.\n");
  assert.equal(f.requests.filter(row => row.body.tools).length, 1);
});

for (const scs of ["off", "on"]) test(`native correction budget is bounded, checkpointed and scoped to an explicit owner request: ${scs}`, { timeout: 50000 }, async t => {
  const f = await fixture(t, scs, "scope-repeat");
  assert.equal((await f.run("start")).result.reason, "permission_required");
  const before = await f.state(), prefix = await fs.readFile(path.join(f.directory, "events.jsonl"), "utf8");
  assert.equal(before.meta.nativeScopedDiscoveryCorrection.goalRevision, 1);
  assert.equal(f.requests.filter(row => row.phase === "start" && row.body.tools).length, 2);
  assert.equal((await f.run("resume")).result.reason, "permission_required");
  const after = await f.state(), replay = await fs.readFile(path.join(f.directory, "events.jsonl"), "utf8");
  assert.ok(replay.startsWith(prefix)); assert.equal(after.goal, before.goal);
  assert.equal(after.meta.runtimeConfig.revision, 2); assert.deepEqual(after.meta.runtimeConfig.workspacePathScopeRoots, ["out"]);
  assert.equal(after.meta.nativeScopedDiscoveryCorrection.goalRevision, 2);
  assert.equal(after.meta.goalContract.history.at(-1).kind, "same-task-continuation");
  assert.equal(after.meta.goalContract.history.at(-1).taskHash, before.meta.goalContract.history[0].taskHash);
  assert.equal(f.requests.filter(row => row.phase === "resume" && row.body.tools).length, 2);
  assert.deepEqual(await fs.readdir(path.join(f.workspace, "out")), []);
  assert.equal((await f.events()).filter(e => e.type === "workspace.discovery_correction").length, 2);
});
