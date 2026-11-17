import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createHash } from "node:crypto";
import { nativeCommandVerificationDigest, boundedNativeCommandCheckpointResult } from "../src/scs-evidence.js";
const exec = promisify(execFile);
for (const scs of ["off", "on"]) for (const mode of ["git-ignored-write", "git-ignored-failed-write", "git-tracked-write", "git-noop", "non-git-noop", "git-legacy-after", "git-legacy-before", "git-invalid-sequence", "git-saved-evidence"]) {
  test(`native partial command observation: ${scs}/${mode}`, { timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-observation-")), workspace = path.join(root, "workspace");
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(workspace, "tools"), { recursive: true }); await fs.mkdir(path.join(workspace, "cache"));
    const target = path.join(workspace, "cache/state.json"), before = '{"value":1}\n'; await fs.writeFile(target, before);
    const writes = mode.endsWith("write");
    await fs.writeFile(path.join(workspace, "tools/refresh-cache.mjs"), (writes ? "import fs from 'node:fs';fs.writeFileSync('cache/state.json','{\"value\":2}\\n');console.log('cache refreshed');\n" : "console.log('cache observed');\n") + (mode.includes("failed") ? "process.exitCode=2;\n" : ""));
    if (mode.includes("legacy")) { await fs.mkdir(path.join(workspace, "test")); await fs.writeFile(path.join(workspace, "test/cache.test.mjs"), "import test from 'node:test';import assert from 'node:assert/strict';test('cache',()=>assert.equal(1,1));\n"); }
    const env = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0" };
    if (mode.startsWith("git-")) {
      await fs.writeFile(path.join(workspace, ".gitignore"), mode.startsWith("git-ignored") ? "cache/\n" : "");
      await exec("git", ["init", "-q"], { cwd: workspace, env });
      await exec("git", ["add", "--", ".gitignore", "tools/refresh-cache.mjs", ...(mode === "git-tracked-write" ? ["cache/state.json"] : [])], { cwd: workspace, env });
    }
    let requests = 0, turns = 0, phase = "start"; const offeredObservations = [], errors = [];
    const server = http.createServer(async (req, res) => { try {
      const chunks = []; for await (const b of req) chunks.push(b); const body = JSON.parse(Buffer.concat(chunks)); requests++; assert.ok(requests <= 14);
      let message;
      if (!body.tools) message = { content: "Run the exact requested command once and report its actual status. A verification counter is not evidence that a file was written or that the workspace is unchanged." };
      else {
        turns++; let name = "finish", args = { result: "The requested command returned exit 0. Workspace changes cannot be inferred from a verification counter." };
        if (mode.includes("failed")) args = { result: "The requested command failed with exit 2. This is an observed failure, not passing verification. Workspace changes cannot be inferred from a counter." };
        if (phase === "start" && turns === 1 || phase === "repair" && turns === 1) { name = "run_command"; args = { command: mode.includes("legacy") ? "node --test test/cache.test.mjs" : "node tools/refresh-cache.mjs" }; }
        for (const m of body.messages.filter(m => m.role === "tool")) { try { const data = JSON.parse(m.content); if (data.toolName === "run_command") offeredObservations.push(data); } catch {} }
        assert.ok(body.tools.some(t => t.function.name === name));
        message = mode === "git-saved-evidence" && phase !== "start"
          ? { content: "The saved command output reported cache observed and exit 0. File changes or an unchanged workspace are not established by that output or the verification counter. No new inspection was performed." }
          : { tool_calls: [{ id: phase + "_" + turns, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (e) { errors.push(String(e)); res.writeHead(400); res.end("{}"); } });
    await new Promise(r => server.listen(0, "127.0.0.1", r)); t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
    async function run(next) {
      phase = next; turns = 0;
      const expectedRevision = phase === "start" ? 1 : JSON.parse(await fs.readFile(path.join(root, "sessions/observation/state.json"))).meta.runtimeConfig.revision;
      const r = await exec(process.execPath, [new URL("./fixtures/native-command-observation.js", import.meta.url).pathname, root, "http://127.0.0.1:" + server.address().port + "/v1", scs, phase, mode, String(expectedRevision)], { cwd: root, env, timeout: 18000, maxBuffer: 1024 * 1024 });
      assert.deepEqual(errors, []); return JSON.parse(r.stdout.trim().split("\n").at(-1)).result;
    }
    const result = await run("start");
    // This is a mutation-capable refresh, not a read-only diagnostic. A failed
    // refresh stays paused; truthful status retrieval is a separate request.
    assert.equal(result.goalStatus, mode.includes("failed") ? "paused" : "completed", JSON.stringify(result));
    if (mode.includes("failed")) assert.equal(result.stopped, true);
    const directory = path.join(root, "sessions/observation"), prefix = await fs.readFile(path.join(directory, "events.jsonl"), "utf8");
    const events = prefix.trim().split("\n").map(JSON.parse), data = events.find(e => e.type === "tool.completed" && e.data.toolName === "run_command").data;
    if (mode.includes("invalid")) {
      const file = path.join(directory, "state.json"), state = JSON.parse(await fs.readFile(file));
      state.meta.projectVerification.commandSequence = null;
      await fs.writeFile(file, JSON.stringify(state)); const before = await fs.readFile(file), beforeRequests = requests;
      await assert.rejects(run("resume"), error => /COMMAND_VERIFICATION_SEQUENCE_INVALID/.test(error.stderr || ""));
      assert.equal(requests, beforeRequests, "corrupt state must reject before provider or tool admission");
      assert.deepEqual(await fs.readFile(file), before); assert.equal(await fs.readFile(path.join(directory, "events.jsonl"), "utf8"), prefix);
      await assert.rejects(fs.stat(path.join(directory, ".agent-run.lock")), { code: "ENOENT" }); return;
    }
    if (mode.includes("legacy")) {
      const stateFile = path.join(directory, "state.json"), state = JSON.parse(await fs.readFile(stateFile)), v = state.meta.projectVerification;
      const actual = v.commandRuns[0]; assert.equal(v.testRuns[0].passed, true);
      // Simulate only old receipt fields/order. The passing native verifier is
      // real; the opaque legacy command is a controlled fixture, not live work.
      delete v.commandSequence; delete v.latestPotentialCommandMutationSequence;
      delete actual.commandSequence; for (const testRun of v.testRuns) delete testRun.commandSequence;
      const checkpoint = actual.nativeResultCheckpoint, payload = JSON.parse(checkpoint.resultJson);
      delete payload.commandSequence; delete payload.commandMutationEvidence;
      if (payload.projectTest) delete payload.projectTest.commandSequence;
      checkpoint.resultJson = JSON.stringify(boundedNativeCommandCheckpointResult(payload));
      checkpoint.resultSha256 = createHash("sha256").update(checkpoint.resultJson).digest("hex"); checkpoint.runSha256 = nativeCommandVerificationDigest(actual);
      const opaque = { command: "node tools/refresh-cache.mjs", at: actual.at, ok: true, mutationRevision: actual.mutationRevision, privateMutationRevision: actual.privateMutationRevision };
      v.commandRuns = mode.endsWith("after") ? [actual, opaque] : [opaque, actual];
      await fs.writeFile(stateFile, JSON.stringify(state));
      const beforeResume = requests, resumed = await run("resume");
      if (mode.endsWith("after")) {
        assert.equal(resumed.reason, "verification_observation_review_required", JSON.stringify(resumed)); assert.equal(requests, beforeResume, "review must not invoke provider or tools");
        const held = JSON.parse(await fs.readFile(stateFile)); assert.equal(held.meta.runtimeConfig.revision, 2); assert.ok(held.meta.commandMutationObservationReview);
        const heldRuns = JSON.stringify(held.meta.projectVerification.commandRuns), seq = held.meta.projectVerification.commandSequence;
        assert.equal((await run("again")).reason, "verification_observation_review_required"); assert.equal(requests, beforeResume);
        const again = JSON.parse(await fs.readFile(stateFile)); assert.equal(JSON.stringify(again.meta.projectVerification.commandRuns), heldRuns); assert.equal(again.meta.projectVerification.commandSequence, seq);
        const repaired = await run("repair"); assert.equal(repaired.goalStatus, "completed", JSON.stringify(repaired));
        assert.equal(JSON.parse(await fs.readFile(stateFile)).meta.commandMutationObservationReview, undefined);
      } else { assert.equal(resumed.goalStatus, "completed", JSON.stringify(resumed)); assert.equal(requests, beforeResume, "verification after the old command remains delivery-only"); }
      const after = await fs.readFile(path.join(directory, "events.jsonl"), "utf8"); assert.ok(after.startsWith(prefix));
      const runs = after.trim().split("\n").map(JSON.parse).filter(e => e.type === "tool.completed" && e.data.toolName === "run_command");
      assert.equal(runs.length, mode.endsWith("after") ? 2 : 1); assert.ok(runs.every(e => e.data.args.command === "node --test test/cache.test.mjs"));
      await assert.rejects(fs.stat(path.join(directory, ".agent-run.lock")), { code: "ENOENT" }); return;
    }
    assert.equal(data.mutationObservationComplete, false, "partial Git evidence must not claim complete workspace coverage");
    assert.equal(data.mutationObservationScope, mode.startsWith("git-") ? "git-status" : "unavailable");
    assert.equal(data.projectMutationRevision, mode.includes("failed") ? 0 : 1, "a failed unknown command must invalidate verification without inventing source-edit progress");
    assert.equal(data.commandMutationEvidence?.workspaceUnchanged, "not-proven");
    assert.equal(data.commandMutationEvidence?.revisionMeaning, "verification-invalidation-only");
    assert.equal(data.commandMutationEvidence?.revisionBasis, mode === "git-tracked-write" ? "observed-path-delta" : mode.includes("failed") ? "unobserved-mutation-risk" : "conservative-command-capability");
    assert.equal((await fs.readFile(target, "utf8")) !== before, writes);
    assert.ok(offeredObservations.some(o => o.commandMutationEvidence?.workspaceUnchanged === "not-proven"));
    const beforeResume = requests, resumed = await run("resume"); assert.equal(resumed.goalStatus, "completed", JSON.stringify(resumed)); assert.ok(requests > beforeResume);
    const after = await fs.readFile(path.join(directory, "events.jsonl"), "utf8"); assert.ok(after.startsWith(prefix));
    if (mode === "git-saved-evidence") {
      assert.equal(requests - beforeResume, 1, "the first correct saved-only answer must not be rejected for missing current evidence");
      const tail = after.slice(prefix.length).trim().split("\n").filter(Boolean).map(JSON.parse);
      assert.equal(tail.some(e => e.type === "completion.evidence_rejected"), false);
      assert.equal(tail.some(e => e.type === "tool.started" && e.data.toolName !== "finish"), false);
      assert.match(resumed.result, /not established/);
    }
    assert.equal(after.trim().split("\n").map(JSON.parse).filter(e => e.type === "tool.completed" && e.data.toolName === "run_command").length, 1);
    const state = JSON.parse(await fs.readFile(path.join(directory, "state.json"))); assert.equal(state.meta.runtimeConfig.revision, 2);
    await assert.rejects(fs.stat(path.join(directory, ".agent-run.lock")), { code: "ENOENT" });
  });
}
