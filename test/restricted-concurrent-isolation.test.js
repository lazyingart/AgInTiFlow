import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runConcurrentScopeScenario } from "./fixtures/restricted-concurrent-scope.js";

// One shared scripted native transport, separate caller-bound SDK runners.
// Both use the same record ID and tool-call ID. No network, models or real data.
for (const lateFailure of [false, true]) {
  test(`concurrent scopes retain isolation and cancellation capacity through late read ${lateFailure ? "failure" : "success"}`, { timeout: 15000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-concurrent-scope-"));
    const unhandled = [];
    const listener = error => unhandled.push(error);
    process.on("unhandledRejection", listener);
    const calls = [];
    const complete = async body => {
      const text = JSON.stringify(body);
      const owner = text.includes("ALPHA_HISTORY") ? "alpha" : "beta";
      assert.ok(!text.includes(owner === "alpha" ? "BETA_HISTORY" : "ALPHA_HISTORY"));
      assert.ok(!text.includes(owner === "alpha" ? "Nora" : "Kira"));
      calls.push({ owner, model: body.model });
      const tool = body.messages.findLast(message => message.role === "tool");
      if (!tool) return { choices: [{ index: 0, finish_reason: "tool_calls", message: {
        role: "assistant", content: "", tool_calls: [{ index: 0, id: "same_read", type: "function",
          function: { name: "read_record", arguments: '{"recordId":1}' } }],
      } }] };
      const row = JSON.parse(tool.content);
      return { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant",
        content: JSON.stringify({ recordId: row.recordId, revision: row.revision, reply: row.text }),
      } }] };
    };
    try {
      const result = await runConcurrentScopeScenario(complete, root, lateFailure);
      assert.equal(result.cancelledCode, "CANCELLED");
      assert.equal(result.beta.proposal.reply, "Nora needs the green sample box before Monday.");
      assert.match(result.alpha.proposal.reply, /Kira.*周四.*蓝色.*附注/);
      assert.deepEqual(result.reads.slice(0, 2).toSorted((a, b) => a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0), [{ owner: "alpha", revision: 5 }, { owner: "beta", revision: 31 }]);
      assert.deepEqual(result.reads[2], { owner: "alpha", revision: 6 });
      assert.deepEqual(calls.filter(call => call.owner === "alpha").map(call => call.model), ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-pro"]);
      assert.equal(calls.length, 5);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.removeListener("unhandledRejection", listener);
      await fs.rm(root, { recursive: true, force: true });
    }
    await assert.rejects(fs.stat(root), { code: "ENOENT" });
  });
}
