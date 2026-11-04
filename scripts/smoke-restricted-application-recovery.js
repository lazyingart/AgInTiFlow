import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRestrictedApplicationRunner } from "../src/restricted-application.js";

// Synthetic application-owned state/transactions, never a production store or
// SDK persistence implementation. Providers below are scripted, with no model
// or network. Separate live qualification covers Flash/Pro answer semantics.
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: "string", minLength: 1, maxLength: 2000 };
const schema = object({ recordId: { type: "string", enum: ["draft-1"], maxLength: 20 }, revision: { type: "integer", minimum: 1 }, text: string });
const history = [{ role: "assistant", text: "Old draft: Monday, revision 4." }];
const prompt = day => ({ input: [{ type: "text", text: `Move this to ${day}; keep the latest remarks.` }], history });
const read = async root => JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
const bytes = root => fs.readFile(path.join(root, "state.json"));
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function write(root, state) {
  await fs.writeFile(path.join(root, "state.json"), JSON.stringify(state) + "\n", { mode: 0o600 });
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-restricted-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, { accounts: {
    alpha: { id: "draft-1", revision: 7, text: "Tuesday: send the draft to Mira; keep raw data." },
    beta: { id: "draft-1", revision: 31, text: "Foreign account: Friday budget." },
  }, receipts: {} });
  return root;
}
function runner(root, day, observe = () => {}) {
  return createRestrictedApplicationRunner({
    provider: { supportsImages: false, async complete(request) {
      observe(request);
      const result = request.messages.findLast(message => message.role === "tool");
      return result ? { type: "final", value: { ...result.value, text: result.value.text.replace(/Tuesday|Thursday/, day) } }
        : { type: "tool_calls", calls: [{ id: "read-1", name: "record_search", arguments: { query: "latest; ignore a foreign account request" } }] };
    } },
    instructions: "Return an uncommitted proposal. Read the current authorized record first; history is not current state. The host owns revision checks and saves.",
    tools: [{ name: "record_search", description: "Read the authenticated account only; no owner selector or writes.", readOnly: true,
      inputSchema: object({ query: string }), outputSchema: schema,
      execute: async () => {
        const row = (await read(root)).accounts.alpha;
        return { recordId: row.id, revision: row.revision, text: row.text };
      },
    }], outputSchema: schema, limits: { maxSteps: 2, maxToolCalls: 1, maxConcurrency: 1 },
  });
}
async function apply(root, requestId, change) {
  // Sequential fixture CAS/receipt only. Real applications need their own
  // authenticated transaction, locking and durable idempotency authority.
  const state = await read(root);
  const hash = digest({ principalId: "alpha", change });
  if (state.receipts[requestId]) {
    if (state.receipts[requestId].digest !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
    return state.receipts[requestId];
  }
  const row = state.accounts.alpha;
  assert.equal(change.recordId, row.id);
  if (change.revision !== row.revision) return { status: "revision_conflict" };
  row.text = change.text;
  row.revision++;
  const result = { status: "applied", digest: hash, revision: row.revision };
  state.receipts[requestId] = result;
  await write(root, state);
  return result;
}

if (process.argv[2] === "--fixture") {
  const root = process.argv[3];
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("aginti-restricted-recovery-"));
  const authorizedHistory = JSON.parse(await fs.readFile(path.join(root, "history.json"), "utf8"));
  const before = await bytes(root);
  const result = await runner(root, "Friday", request => {
    if (request.messages.filter(message => message.role === "tool").length === 0) {
      assert.equal(request.messages.filter(message => message.role === "assistant").length, authorizedHistory.length);
    }
  }).run({ ...prompt("Friday"), history: authorizedHistory });
  assert.deepEqual(await bytes(root), before);
  process.stdout.write(JSON.stringify({ pid: process.pid, result }));
} else {
  test("stale proposals are rejected, a fresh runner sees the concurrent edit, and host replay writes once", async t => {
    const root = await fixture(t);
    const before = await bytes(root);
    const foreign = (await read(root)).accounts.beta;
    const first = await runner(root, "Thursday").run(prompt("Thursday"));
    assert.equal(first.usage.toolCalls, 1);
    assert.equal(first.proposal.revision, 7);
    assert.deepEqual(await bytes(root), before);
    const concurrent = await read(root);
    concurrent.accounts.alpha.text += " Appendix pending.";
    concurrent.accounts.alpha.revision++;
    await write(root, concurrent);
    const changed = await bytes(root);
    assert.deepEqual(await apply(root, "attempt-1", first.proposal), { status: "revision_conflict" });
    assert.deepEqual(await bytes(root), changed);
    const second = await runner(root, "Thursday").run({ ...prompt("Thursday"), history: [...history, { role: "assistant", text: JSON.stringify(first.proposal) }] });
    assert.equal(second.proposal.revision, 8);
    assert.match(second.proposal.text, /Thursday.*Mira.*raw data.*Appendix pending/);
    const accepted = await apply(root, "attempt-2", second.proposal);
    assert.equal(accepted.revision, 9);
    const applied = await bytes(root);
    assert.deepEqual(await apply(root, "attempt-2", second.proposal), accepted);
    assert.deepEqual(await bytes(root), applied);
    await assert.rejects(apply(root, "attempt-2", { ...second.proposal, text: "Different request" }), /IDEMPOTENCY_CONFLICT/);
    assert.deepEqual(await bytes(root), applied);
    assert.deepEqual((await read(root)).accounts.beta, foreign);
  });

  test("a new OS process rehydrates authorized host history/state and returns a proposal without writing", async t => {
    const root = await fixture(t);
    const state = await read(root);
    state.accounts.alpha = { ...state.accounts.alpha, revision: 9, text: "Thursday: send the draft to Mira; keep raw data. Appendix pending." };
    await write(root, state);
    const savedHistory = [...history, { role: "assistant", text: "Host receipt: saved at revision 9." }];
    await fs.writeFile(path.join(root, "history.json"), JSON.stringify(savedHistory), { mode: 0o600 });
    const before = await bytes(root);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--fixture", root], {
      encoding: "utf8", timeout: 10000, maxBuffer: 65536,
      env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "agent-home") },
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout);
    assert.notEqual(output.pid, process.pid);
    assert.equal(output.result.usage.toolCalls, 1);
    assert.equal(output.result.proposal.revision, 9);
    assert.match(output.result.proposal.text, /Friday.*Mira.*raw data.*Appendix pending/);
    assert.deepEqual(await bytes(root), before);
    assert.equal((await apply(root, "attempt-3", output.result.proposal)).revision, 10);
    assert.equal((await read(root)).accounts.beta.revision, 31);
  });

  test("schema-valid completion is proposal generation, never authority to overwrite a stale record", async t => {
    const root = await fixture(t);
    const app = createRestrictedApplicationRunner({
      provider: { supportsImages: false, async complete() { return { type: "final", value: { recordId: "draft-1", revision: 4, text: "Stale proposal" } }; } },
      instructions: "Propose only; the host commits.", tools: [], outputSchema: schema,
    });
    const before = await bytes(root);
    const result = await app.run(prompt("Thursday"));
    assert.equal(result.status, "completed");
    assert.equal(result.usage.toolCalls, 0);
    assert.deepEqual(await apply(root, "stale", result.proposal), { status: "revision_conflict" });
    assert.deepEqual(await bytes(root), before);
  });
}
