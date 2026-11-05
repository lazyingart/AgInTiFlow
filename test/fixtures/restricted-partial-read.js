import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRestrictedApplicationRunner, createRestrictedDeepSeekProvider, createRestrictedToolFailure } from "../../src/restricted-application.js";

const closed = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: "string", minLength: 1, maxLength: 1000 };
const recordSchema = closed({ id: text, revision: { type: "integer", minimum: 1 }, text });
const outputSchema = closed({ records: { type: "array", items: recordSchema, minItems: 2, maxItems: 2 }, reply: text });
export const originalPrompt = "帮我把这两条当前的内容对一下，别猜，也别保存修改。";

const save = (directory, name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
export async function initializePartialReadHost(directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  await save(directory, "records.json", [
    { id: "source-a", revision: 7, text: "现场演示改到周五，带蓝色资料夹。" },
    { id: "source-b", revision: 12, text: "转接头放在侧袋，留好防尘帽。" },
  ]);
  await save(directory, "history.json", [{ role: "user", text: originalPrompt }]);
  await save(directory, "authorization.json", { phase: "primary", model: "deepseek-flash" });
}

// An explicit synthetic HOST operation between two exited worker processes.
// This is not SDK persistence, a retry policy or production app authorization.
export async function authorizeFreshProContinuation(directory) {
  const failed = JSON.parse(await fs.readFile(path.join(directory, "primary-result.json"), "utf8"));
  assert.equal(failed.status, "failed"); assert.equal(failed.code, "TOOL_FAILED");
  assert.equal(failed.toolFailure.category, "unavailable"); assert.equal(failed.reads, 2);
  assert(!Object.hasOwn(failed, "proposal"));
  const records = JSON.parse(await fs.readFile(path.join(directory, "records.json"), "utf8"));
  records[0] = { id: "source-a", revision: 8, text: "现场演示改到周一，带青色资料夹；保留封面夹页。" };
  await save(directory, "records.json", records);
  const history = JSON.parse(await fs.readFile(path.join(directory, "history.json"), "utf8"));
  history.push({ role: "assistant", text: "Host receipt: evidence temporarily unavailable; no proposal accepted and no record changed. This is not authoritative absence." });
  await save(directory, "history.json", history);
  await save(directory, "authorization.json", { phase: "recovery", model: "deepseek-v4-pro" });
}

export async function runPartialReadPhase({ phase, directory, complete, onEvent = () => {} }) {
  assert(["primary", "recovery"].includes(phase));
  const authorization = JSON.parse(await fs.readFile(path.join(directory, "authorization.json"), "utf8"));
  const model = phase === "primary" ? "deepseek-flash" : "deepseek-v4-pro";
  assert.deepEqual(authorization, { phase, model });
  const history = JSON.parse(await fs.readFile(path.join(directory, "history.json"), "utf8"));
  assert.equal(history[0].text, originalPrompt);
  const before = await fs.readFile(path.join(directory, "records.json"));
  let reads = 0, turns = 0;
  const runner = createRestrictedApplicationRunner({
    provider: createRestrictedDeepSeekProvider({ model, complete: async (body, options) => { turns++; onEvent({ event: "provider", phase, model, turn: turns }); return complete(body, options); } }),
    tools: [{ name: "read_next_source", description: "Read the next of two caller-authorized current records in source order. Each invocation reads one record; remaining says how many are left.",
      inputSchema: closed({}), outputSchema: closed({ record: recordSchema, remaining: { type: "integer", minimum: 0, maximum: 1 } }), readOnly: true,
      execute: async () => {
        const index = reads++; assert(index < 2);
        if (phase === "primary" && index === 1) {
          onEvent({ event: "injected-unavailable", phase, read: reads });
          throw createRestrictedToolFailure({ category: "unavailable", retryAfterMs: 1000 });
        }
        const records = JSON.parse(await fs.readFile(path.join(directory, "records.json"), "utf8"));
        const record = records[index]; onEvent({ event: "read", phase, id: record.id, revision: record.revision, read: reads });
        return { record, remaining: 1 - index };
      } }],
    instructions: "Read both currently authorized records before a proposal. Copy exact IDs, revisions and text in source order; reply in the user's language. Prior history may be stale. Return an uncommitted proposal only; never claim a save or infer absence from unavailability.",
    outputSchema, limits: { maxSteps: 3, maxToolCalls: 2, maxCallsPerStep: 2, maxOutputTokens: 2048, timeoutMs: 60_000 },
  });
  const prompt = phase === "primary" ? originalPrompt : "再看看现在两条内容，上一轮没完成，别保存。";
  let result;
  try {
    const completed = await runner.run({ input: [{ type: "text", text: prompt }], history });
    assert.equal(phase, "recovery", "a temporary failed read must not yield a partial proposal");
    assert.equal(reads, 2); assert.match(completed.proposal.reply, /\p{Script=Han}/u);
    assert.deepEqual(JSON.parse(JSON.stringify(completed.proposal.records)), JSON.parse(before));
    result = { phase, status: "completed", pid: process.pid, model, turns, reads, proposal: completed.proposal };
  } catch (error) {
    assert.equal(phase, "primary"); assert.equal(error.code, "TOOL_FAILED");
    assert.deepEqual(JSON.parse(JSON.stringify(error.toolFailure)), { schemaVersion: "aginti-tool-failure-v1", category: "unavailable", retryAfterMs: 1000 });
    assert.equal(reads, 2); assert(turns <= 2);
    result = { phase, status: "failed", pid: process.pid, model, turns, reads, code: error.code, toolFailure: error.toolFailure };
  }
  assert.deepEqual(await fs.readFile(path.join(directory, "records.json")), before);
  await save(directory, phase + "-result.json", result);
  onEvent({ event: "phase-result", phase, status: result.status, pid: process.pid, turns, reads });
  return result;
}

// Test-only entry. There is no live provider, credential or endpoint option.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv[2], "--offline");
  const [phase, directory, mode] = process.argv.slice(3);
  assert(["batch", "serial"].includes(mode));
  let sequence = 0;
  const result = await runPartialReadPhase({ phase, directory, complete: async body => {
    const observed = body.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content));
    if (observed.length < 2) return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: Array.from({ length: mode === "batch" ? 2 : 1 }, () => ({ id: "read_" + ++sequence, type: "function", function: { name: "read_next_source", arguments: "{}" } })) } }] };
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ records: observed.map(v => v.record), reply: "两条当前内容已核对；这只是提案，没有保存修改。" }) } }] };
  } });
  console.log(JSON.stringify({ status: result.status, phase, pid: result.pid }));
}
