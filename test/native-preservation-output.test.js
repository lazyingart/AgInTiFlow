import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { deriveScsTaskContract } from "../src/scs-evidence.js";
const exec = promisify(execFile);
const before = "export const value = 1;\n", after = "export const value = 2;\n";
const checker = "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { value } from '../src/entry.mjs';\ntest('current value', () => assert.equal(value, 2));\n";

for (const mode of ["collective", "simple", "report", "restart"]) test(`persisted native output roles and genuine Node test: ${mode}`, { timeout: 40000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-preservation-native-")), workspace = path.join(root, "workspace");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "src"), { recursive: true }); await fs.mkdir(path.join(workspace, "test"));
  await fs.writeFile(path.join(workspace, "src/entry.mjs"), before);
  await fs.writeFile(path.join(workspace, "test/entry.test.mjs"), "// Initial owned test placeholder.\n");
  const readme = "# Supplied owner input\n\nKeep this original document unchanged.\n";
  const manifest = '{"private":true,"type":"module"}\n';
  await fs.writeFile(path.join(workspace, "README.md"), readme); await fs.writeFile(path.join(workspace, "package.json"), manifest);
  let turn = 0, requests = 0, checked = false; const errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      requests++; const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
      const system = body.messages.filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : "").join("\n");
      let message;
      if (!body.tools && system.includes("SCS committee planner")) message = { content: JSON.stringify({ role: "committee", phase_goal: "Update only the requested source and tests", plan: "Read the supplied files. Update source and tests. Run the requested Node test. Preserve owner inputs.", acceptance_criteria: ["Current value is 2", "Node tests pass", "Owner inputs unchanged"], allowed_tools: ["read_file", "apply_patch", "run_command", "finish"], stop_conditions: ["Finish after genuine test evidence"] }) };
      else if (!body.tools) message = { content: "Read supplied source and tests, make the requested changes and run the Node test." };
      else {
        const n = turn++, call = (name, args, index = 0) => ({ id: `preserve_${n}_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
        const offered = name => body.tools.find(t => t.function.name === name)?.function;
        const expected = { "src/entry.mjs": after, "test/entry.test.mjs": checker,
          ...(mode === "report" ? { "report.md": "# Result\n\nThe requested source exports value 2. The Node test verifies this value.\n" } : {}) };
        const pending = [];
        for (const [file, content] of Object.entries(expected)) {
          const current = await fs.readFile(path.join(workspace, file), "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
          if (current !== content && !(file === "report.md" && current === content.trimEnd())) pending.push({ file, content, current });
        }
        let calls;
        const patchTool = offered("apply_patch"), readTool = offered("read_file");
        if (pending.length && patchTool) {
          const target = pending.find(p => !patchTool.parameters.properties.path?.enum || patchTool.parameters.properties.path.enum.includes(p.file));
          assert.ok(target, "The fixture must obey the exact current patch path");
          calls = [call("apply_patch", !patchTool.parameters.required?.includes("search") ? { patch: "*** Begin Patch\n" + (target.current === null ? "*** Add File: " : "*** Update File: ") + target.file + "\n" +
            (target.current === null ? "" : "@@\n" + target.current.trimEnd().split("\n").map(line => "-" + line).join("\n") + "\n") +
            target.content.trimEnd().split("\n").map(line => "+" + line).join("\n") + "\n*** End Patch" } : { path: target.file, search: target.current, replace: target.content, expectedReplacements: 1 })];
        } else if (pending.length && readTool) {
          const target = pending.find(p => !readTool.parameters.properties.path?.enum || readTool.parameters.properties.path.enum.includes(p.file));
          assert.ok(target); calls = [call("read_file", { path: target.file })];
        } else if (!pending.length && !checked && offered("run_command")) {
          calls = [call("run_command", { command: "node --test test/entry.test.mjs" })]; checked = true;
        } else {
          assert.equal(pending.length, 0); assert.ok(checked);
          calls = [call("finish", { result: "Updated src/entry.mjs and test/entry.test.mjs. The requested Node test passed. README.md and package.json are unchanged." + (mode === "report" ? " report.md is ready." : "") })];
        }
        for (const c of calls) assert.ok(offered(c.function.name), `${c.function.name}; offered=${body.tools.map(t => t.function.name)}; turn=${n}`);
        message = { content: null, tool_calls: calls };
      }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", ...message } }] }));
    } catch (error) { errors.push(String(error)); response.writeHead(400); response.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const run = phase => exec(process.execPath, [new URL("./fixtures/native-preservation-output.js", import.meta.url).pathname, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase], {
    cwd: workspace, timeout: 18000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "home"),
      AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0",
      ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) },
  });
  let r = await run("start");
  const stateDir = path.join(root, "sessions", "preservation-" + mode);
  let prefix = "", beforeResume;
  if (mode === "restart") {
    assert.equal(JSON.parse(r.stdout.trim().split("\n").at(-1)).result.goalStatus, "paused");
    const statePath = path.join(stateDir, "state.json"), saved = JSON.parse(await fs.readFile(statePath));
    // Simulate only the stale inferred cache reproduced by the installed
    // baseline. Preserve actual task, policy, tool evidence and file bytes.
    saved.meta.scs.taskContract = Object.assign(deriveScsTaskContract({ goal: saved.goal, taskProfile: "code" }), { exactOutputPaths: ["test/README.md", "test/package.json"],
      requiredArtifactKinds: [{ id: "format:.md", extension: ".md", label: "Markdown" }] });
    delete saved.meta.scs.taskContract.outputRoleInferenceVersion;
    await fs.writeFile(statePath, JSON.stringify(saved));
    beforeResume = await fs.readFile(path.join(workspace, "test/entry.test.mjs"), "utf8");
    prefix = await fs.readFile(path.join(stateDir, "events.jsonl"), "utf8");
    r = await run("resume");
  }
  const result = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.deepEqual(errors, []);
  const savedEvents = (await fs.readFile(path.join(root, "sessions", "preservation-" + mode, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(result.result?.goalStatus, "completed", JSON.stringify({ result, rejected: savedEvents.slice(-8) }));
  assert.equal(await fs.readFile(path.join(workspace, "src/entry.mjs"), "utf8"), after);
  assert.equal(await fs.readFile(path.join(workspace, "test/entry.test.mjs"), "utf8"), checker);
  assert.equal(await fs.readFile(path.join(workspace, "README.md"), "utf8"), readme);
  assert.equal(await fs.readFile(path.join(workspace, "package.json"), "utf8"), manifest);
  await assert.rejects(fs.stat(path.join(workspace, "test/README.md")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(workspace, "test/package.json")), { code: "ENOENT" });
  const state = JSON.parse(await fs.readFile(path.join(stateDir, "state.json")));
  const eventText = await fs.readFile(path.join(stateDir, "events.jsonl"), "utf8");
  const events = eventText.trim().split("\n").map(JSON.parse);
  assert.equal(state.meta.goalContract.status, "completed");
  assert.ok(state.meta.projectVerification.testRuns.some(run => run.ok === true));
  assert.equal(events.some(e => e.type === "completion.evidence_rejected"), false);
  assert.equal(events.filter(e => e.type === "session.finished").length, 1);
  if (mode === "restart") {
    assert.ok(eventText.startsWith(prefix));
    assert.equal(beforeResume, checker);
    assert.equal(state.meta.runtimeConfig.revision, 2);
    assert.equal(state.meta.runtimeConfig.model, "fixture-pro");
    assert.equal(events.slice(prefix.trim().split("\n").length).filter(e => e.type === "file.changed").length, 0, "Do not repeat the confirmed producer on resume");
    assert.equal(state.meta.scs.taskContract.exactOutputPaths.some(p => /README|package/.test(p)), false);
    assert.equal(events.filter(e => e.type === "scs.output_role_contract_refreshed").length, 1);
  }
  assert.ok(requests <= 10, `Unexpected exploratory loop: ${requests}`);
});
