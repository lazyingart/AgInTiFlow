import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRestrictedApplicationRunner, createRestrictedDeepSeekProvider } from "../../src/restricted-application.js";

// Synthetic single-writer HOST fixture, never a persistence/authorization SDK.
// No credential, live provider, arbitrary endpoint or model-controlled path.
// Atomic replacement models a host transaction; it is not a cross-process lock,
// retained-descriptor store or proof against every filesystem/crash condition.
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: "string", minLength: 1, maxLength: 500 };
const candidate = object({ id: text, title: text });
const candidates = { type: "array", items: candidate, minItems: 2, maxItems: 2 };
const record = object({ id: text, title: text, revision: { type: "integer", minimum: 1 }, intro: text, body: text });
const output = { anyOf: [
  object({ action: { type: "string", enum: ["clarify"], maxLength: 10 }, candidates, question: text }),
  object({ action: { type: "string", enum: ["edit"], maxLength: 10 }, id: text, expectedRevision: { type: "integer", minimum: 1 }, intro: text, reply: text }),
] };
export const firstPrompt = "can you change the intro to say the demo uses the new API? keep the rest please";
export const secondPrompt = "第二份那个，把 intro 改成“演示使用全新接口。”，其他内容和另一份别碰，别再新建一份。";
export const replacement = "演示使用全新接口。";
export const foreignMarker = "FOREIGN_SCOPE_MUST_NOT_ENTER_REQUEST_64921";
const plain = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const load = async directory => JSON.parse(await fs.readFile(path.join(directory, "host.json"), "utf8"));
export async function save(directory, value) {
  const temporary = path.join(directory, "host.next"), filename = path.join(directory, "host.json");
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, filename);
  const parent = await fs.open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function initialize(directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  await save(directory, { principal: "fixture-owner", records: [
    { id: "draft_alpha", title: "Intro draft A", revision: 3, intro: "This demo uses the prior interface.", body: "Leave this approved paragraph unchanged." },
    { id: "draft_beta", title: "Intro draft B", revision: 8, intro: "This example uses the earlier API.", body: "この段落と式 E = mc^2 は変更しない。" },
  ], displayedCandidates: null, selection: null, history: [], receipt: null });
  await fs.writeFile(path.join(directory, "foreign.json"), JSON.stringify({ id: "draft_beta", text: foreignMarker }), { mode: 0o600 });
}

const reject = code => { throw Object.assign(new Error(code), { code }); };
export async function acceptDiscovery(directory, result, events) {
  const state = await load(directory), proposal = result.proposal;
  if (proposal.action !== "clarify") reject("CLARIFICATION_REQUIRED");
  if (!events.some(event => event.type === "list")) reject("EVIDENCE_REQUIRED");
  assert.deepEqual(proposal.candidates, state.records.map(({ id, title }) => ({ id, title })));
  state.displayedCandidates = plain(proposal.candidates);
  state.history = [{ role: "user", text: firstPrompt }, { role: "assistant", text: JSON.stringify(proposal) }];
  await save(directory, state);
}

export async function authorizeSelection(directory, selectedId) {
  const state = await load(directory);
  if (!state.displayedCandidates?.some(candidate => candidate.id === selectedId)) reject("SELECTION_INVALID");
  // The HOST must validate explicit user selection against what that principal
  // actually saw. The SDK/model does not grant scope. This test receives the
  // already validated ID, not a general natural-language ordinal parser.
  state.selection = { principal: state.principal, selectedId, displayedDigest: digest(state.displayedCandidates) };
  // Concurrent source change plus reorder: user references keep displayed order.
  const selected = state.records.find(record => record.id === selectedId);
  selected.revision++;
  selected.body += " Preserve the newly added side remark.";
  state.records.reverse();
  await save(directory, state);
}

export async function runPhase(directory, phase, complete) {
  assert.ok(["discover", "followup"].includes(phase));
  const state = await load(directory), before = await fs.readFile(path.join(directory, "host.json"));
  const foreign = await fs.readFile(path.join(directory, "foreign.json"));
  const events = [], model = phase === "discover" ? "deepseek-flash" : "deepseek-v4-pro";
  if (phase === "followup") {
    assert.equal(state.selection.principal, state.principal);
    assert.equal(state.selection.displayedDigest, digest(state.displayedCandidates));
    assert(state.displayedCandidates.some(candidate => candidate.id === state.selection.selectedId));
  }
  const provider = createRestrictedDeepSeekProvider({ model, complete(body, options) {
    assert(!JSON.stringify(body).includes(foreignMarker));
    events.push({ type: "provider", model }); return complete(body, options);
  } });
  const tools = phase === "discover" ? [{ name: "list_drafts", description: "List this caller's authorized candidate IDs and titles in display order.",
    readOnly: true, inputSchema: object({}), outputSchema: candidates,
    async execute() { events.push({ type: "list" }); return (await load(directory)).records.map(({ id, title }) => ({ id, title })); } }]
    : [{ name: "read_draft", description: "Read the exact current caller-authorized, user-selected draft by ID.", readOnly: true,
      inputSchema: object({ id: { ...text, enum: [state.selection.selectedId] } }), outputSchema: record,
      async execute({ id }) {
        assert.equal(id, state.selection.selectedId);
        const value = (await load(directory)).records.find(record => record.id === id);
        events.push({ type: "read", id, revision: value.revision }); return value;
      } }];
  const app = createRestrictedApplicationRunner({ provider, tools, outputSchema: output,
    instructions: "Help edit only the intro of one caller-authorized draft. History records what the user saw and may resolve follow-up references; retrieved ordering may change. If the target is ambiguous, ask a short clarification question and return candidates in displayed order. Do not guess a target. Read the selected current draft before proposing an edit and use its exact current revision. Retain the user's language. Never claim a save: the host owns state and this is only a proposal.",
    limits: { maxSteps: 3, maxToolCalls: 2, maxCallsPerStep: 2, maxOutputTokens: 1200, timeoutMs: 1000 } });
  const result = await app.run({ input: [{ type: "text", text: phase === "discover" ? firstPrompt : secondPrompt }], history: state.history });
  assert.deepEqual(await fs.readFile(path.join(directory, "host.json")), before);
  assert.deepEqual(await fs.readFile(path.join(directory, "foreign.json")), foreign);
  return { result: plain(result), events, pid: process.pid };
}

export async function commit(directory, key, proposal, events) {
  const state = await load(directory), requestDigest = digest({ principal: state.principal, selectedId: state.selection.selectedId, user: secondPrompt, proposal });
  if (state.receipt?.key === key) {
    if (state.receipt.requestDigest !== requestDigest) reject("IDEMPOTENCY_CONFLICT");
    return { replayed: true, result: state.receipt.result };
  }
  if (state.receipt) reject("FIXTURE_SINGLE_OPERATION_ONLY");
  if (proposal.action !== "edit" || proposal.id !== state.selection.selectedId || proposal.intro !== replacement) reject("PROPOSAL_MISMATCH");
  const record = state.records.find(record => record.id === proposal.id);
  if (record.revision !== proposal.expectedRevision) reject("REVISION_CONFLICT");
  if (!events.some(event => event.type === "read" && event.id === record.id && event.revision === record.revision)) reject("EVIDENCE_REQUIRED");
  record.intro = proposal.intro; record.revision++;
  state.receipt = { key, requestDigest, proposal, result: { applied: true, id: record.id, revision: record.revision } };
  // Record mutation and receipt publish together; the caller may lose response.
  await save(directory, state);
  return { replayed: false, result: state.receipt.result };
}

export const nativeFinal = proposal => ({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ proposal }) } }] });
export const nativeCall = (name, args) => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
  tool_calls: [{ id: "scoped_read_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
export function scripted(phase) {
  return body => {
    const observed = body.messages.filter(message => message.role === "tool");
    if (!observed.length) return phase === "discover" ? nativeCall("list_drafts", {}) : nativeCall("read_draft", { id: body.tools[0].function.parameters.properties.id.enum[0] });
    const value = JSON.parse(observed[0].content);
    return nativeFinal(phase === "discover" ? { action: "clarify", candidates: value, question: "Which draft do you mean?" }
      : { action: "edit", id: value.id, expectedRevision: value.revision, intro: replacement, reply: "这是简介修改提案，尚未保存。" });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv[2], "--offline");
  const [phase, directory] = process.argv.slice(3);
  if (phase === "replay") {
    const state = await load(directory), before = await fs.readFile(path.join(directory, "host.json"));
    const answer = await commit(directory, state.receipt.key, state.receipt.proposal, []);
    assert.deepEqual(await fs.readFile(path.join(directory, "host.json")), before);
    console.log(JSON.stringify({ ...answer, pid: process.pid, providerRequests: 0 }));
  } else {
    const outcome = await runPhase(directory, phase, scripted(phase));
    if (phase === "discover") await acceptDiscovery(directory, outcome.result, outcome.events);
    else await commit(directory, "accepted-intro-edit", outcome.result.proposal, outcome.events);
    console.log(JSON.stringify(outcome));
  }
}
