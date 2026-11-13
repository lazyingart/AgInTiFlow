import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { createRestrictedApplicationRunner, createRestrictedToolFailure } = await import(pathToFileURL(path.join(runtime, "src/restricted-application.js")));
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = maxLength => ({ type: "string", minLength: 1, maxLength });
const id = { type: "string", enum: ["draft_alpha"], maxLength: 32 };
const revision = { type: "integer", minimum: 1, maximum: 100 };
const stateSchema = { anyOf: [
  object({ status: { type: "string", enum: ["available"], maxLength: 16 }, recordId: id, revision, text: string(1600) }),
  object({ status: { type: "string", enum: ["removed"], maxLength: 16 }, recordId: id, revision }),
] };
const proposalSchema = { anyOf: [
  object({ status: { type: "string", enum: ["ready"], maxLength: 16 }, recordId: id, revision, draft: string(1600), reply: string(300) }),
  object({ status: { type: "string", enum: ["unavailable"], maxLength: 16 }, recordId: id, revision, reply: string(300) }),
] };
const original = "The field sensor trial used 12 samples. Median response time was 90 ms. Independent review is pending.";
const rewrite = "In a 12-sample field sensor trial, the median response time was 90 ms; independent review remains pending.";
const available = () => ({ status: "available", recordId: "draft_alpha", revision: 4, text: original });
const removed = () => ({ status: "removed", recordId: "draft_alpha", revision: 5 });
const ready = (draft = rewrite, version = 4) => ({ status: "ready", recordId: "draft_alpha", revision: version, draft, reply: "Proposed edit only." });
const unavailable = () => ({ status: "unavailable", recordId: "draft_alpha", revision: 5, reply: "The selected record is unavailable." });
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scope = "authenticated-test-principal";
const history = [{ role: "user", text: "This opening feels clumsy. Make it clearer, keep the facts, and leave it as a proposed edit." }, { role: "assistant", text: JSON.stringify(ready(original)) }];

// Test host only: the SDK neither authenticates accounts nor commits records.
// A production host needs its own transaction/CAS and deletion authorization.
function hostPresentation(result, { current, observation, principal = scope }) {
  assert.equal(result.status, "completed");assert.ok(observation, "No current account-bound read");
  assert.equal(observation.principal, principal);assert.equal(observation.digest, digest(current), "State changed after the authorized read");
  const proposal = result.proposal;assert.equal(proposal.recordId, current.recordId);assert.equal(proposal.revision, current.revision);
  if (current.status === "removed") {
    assert.equal(proposal.status, "unavailable");assert.deepEqual(Object.keys(proposal).sort(), ["recordId", "reply", "revision", "status"]);
    // Render lifecycle facts from host authority, not historical/model prose.
    return { kind: "unavailable", recordId: current.recordId, revision: current.revision, message: "The selected record is unavailable." };
  }
  assert.equal(current.status, "available");assert.equal(proposal.status, "ready");
  assert.deepEqual(Object.keys(proposal).sort(), ["draft", "recordId", "reply", "revision", "status"]);
  if (proposal.draft === current.text) return { kind: "no_change", recordId: current.recordId, revision: current.revision };
  return { kind: "edit_proposal", recordId: current.recordId, revision: current.revision, draft: proposal.draft };
}
function fixture({ current = removed(), final = unavailable(), call = { recordId: "draft_alpha" }, toolError, afterRead, skipRead = false, returnedState } = {}) {
  const source = clone(current), foreign = { recordId: "draft_alpha", text: "FOREIGN_SCOPE_MUST_NOT_LEAVE" }, foreignBefore = digest(foreign);
  let calls = 0, reads = 0, observation;
  const runner = createRestrictedApplicationRunner({
    provider: { supportsImages: false, complete(request) {
      calls++;assert.ok(!JSON.stringify(request).includes(foreign.text));
      if (calls === 1 && !skipRead) return { type: "tool_calls", calls: [{ id: "read_1", name: "read_selected", arguments: call }] };
      afterRead?.(source);return { type: "final", value: final };
    } },
    tools: [{ name: "read_selected", description: "Read this account's selected current record.", readOnly: true, inputSchema: object({ recordId: id }), outputSchema: stateSchema, execute(args) {
      assert.equal(args.recordId, "draft_alpha");reads++;if (toolError) throw toolError;
      observation = { principal: scope, digest: digest(source) };return returnedState ?? clone(source);
    } }],
    instructions: "Read the current selected record. A removed result permits only unavailable, never reconstruction from history. Return a proposal, not a saved change.",
    outputSchema: proposalSchema, limits: { maxSteps: 4, maxToolCalls: 3, maxCallsPerStep: 1, maxOutputTokens: 1536, timeoutMs: 1000 },
  });
  return { run: options => runner.run({ input: [{ type: "text", text: "Make that draft sound more natural; leave everything else alone." }], history }, options), counts: () => ({ calls, reads }), present: result => hostPresentation(result, { current: source, observation }), current: source, assertForeignUnchanged: () => assert.equal(digest(foreign), foreignBefore), observation: () => observation };
}

test("current available source permits a changed proposal without a host write", async () => {
  const f = fixture({ current: available(), final: ready() }), before = digest(f.current), result = await f.run();
  assert.equal(f.present(result).kind, "edit_proposal");assert.deepEqual(f.counts(), { calls: 2, reads: 1 });assert.equal(digest(f.current), before);f.assertForeignUnchanged();
});
test("current tombstone outranks retained draft history", async () => {
  const f = fixture(), before = digest(f.current), result = await f.run();
  assert.deepEqual(f.present(result), { kind: "unavailable", recordId: "draft_alpha", revision: 5, message: "The selected record is unavailable." });
  assert.equal(digest(f.current), before);assert.ok(!JSON.stringify(result.proposal).includes(original));f.assertForeignUnchanged();
});
test("a schema-valid unchanged draft is no-change, not a successful rewrite or save", async () => {
  const f = fixture({ current: available(), final: ready(original) }), before = digest(f.current), result = await f.run();
  assert.equal(result.status, "completed");assert.equal(f.present(result).kind, "no_change");assert.equal(digest(f.current), before);assert.equal(f.current.revision, 4);
});
for (const [name, final] of [["stale historical revision", ready(original)], ["recreated draft at current removed revision", ready(rewrite, 5)]]) test(`host refuses ${name} despite SDK proposal completion`, async () => {
  const f = fixture({ final }), before = digest(f.current), result = await f.run();assert.equal(result.status, "completed");assert.throws(() => f.present(result));assert.equal(digest(f.current), before);
});
test("free-form unavailable reply cannot leak historical facts through host rendering", async () => {
  const f = fixture({ final: { ...unavailable(), reply: original } }), presentation = f.present(await f.run());
  assert.ok(!JSON.stringify(presentation).includes(original));assert.equal(presentation.message, "The selected record is unavailable.");
});
test("a guessed unavailable result without a current read is not authority", async () => {
  const f = fixture({ skipRead: true }), result = await f.run();assert.equal(result.status, "completed");assert.throws(() => f.present(result), /No current account-bound read/);assert.deepEqual(f.counts(), { calls: 1, reads: 0 });
});
for (const call of [{ recordId: "draft_beta" }, { recordId: "draft_alpha", principalId: "foreign" }]) test(`undeclared read target/scope rejects before callback: ${JSON.stringify(call)}`, async () => {
  const f = fixture({ call });await assert.rejects(f.run(), { code: "TOOL_CALL_INVALID" });assert.deepEqual(f.counts(), { calls: 1, reads: 0 });f.assertForeignUnchanged();
});
test("generic 404 text is tool failure, never an authenticated tombstone", async () => {
  const f = fixture({ toolError: new Error("404 missing; raw internal source detail") });
  await assert.rejects(f.run(), error => error.code === "TOOL_FAILED" && !Object.hasOwn(error, "toolFailure") && !error.message.includes("raw internal"));assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
});
for (const category of ["not_found", "authentication", "unavailable"]) test(`typed ${category} read failure cannot authorize deleted status or another model turn`, async () => {
  const f = fixture({ toolError: createRestrictedToolFailure({ category }) });await assert.rejects(f.run(), error => error.code === "TOOL_FAILED" && error.toolFailure.category === category);assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
});
for (const value of [{ status: "removed", recordId: "draft_alpha" }, { status: false, recordId: "draft_alpha", revision: 5 }, { status: "removed", recordId: "draft_alpha", revision: 5, text: original }]) test(`malformed removed state stops before proposal: ${JSON.stringify(value)}`, async () => {
  const f = fixture({ returnedState: value });await assert.rejects(f.run(), { code: "TOOL_RESULT_INVALID" });assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
});
test("a later host revision invalidates a previously observed tombstone", async () => {
  const f = fixture({ afterRead: source => { source.revision = 6; } }), result = await f.run();assert.throws(() => f.present(result), /State changed after the authorized read/);assert.equal(f.current.revision, 6);
});
test("same record ID never substitutes for authenticated read scope", async () => {
  const f = fixture(), result = await f.run();assert.throws(() => hostPresentation(result, { current: f.current, observation: f.observation(), principal: "different-account" }));f.assertForeignUnchanged();
});
test("pre-cancellation invokes neither model nor read", async () => {
  const f = fixture(), controller = new AbortController();controller.abort();await assert.rejects(f.run({ signal: controller.signal }), { code: "CANCELLED" });assert.deepEqual(f.counts(), { calls: 0, reads: 0 });
});
