import crypto from "node:crypto";
import path from "node:path";
import { types } from "node:util";
import { dataFields, jsonSnapshot } from "./restricted-application-contract.js";
import { parseNativeToolArguments } from "./native-tool-arguments.js";
import { boundedNativeCommandCheckpointResult, nativeCommandVerificationDigest } from "./scs-evidence.js";
import { canonicalizeShellCommand } from "./shell-syntax.js";

// Native SessionStore integrity, not a MAC, sandbox or application authority.
// The existing native session lease excludes concurrent invocations. Same-UID
// state forgery and unreturned external effects are not exactly-once guarantees.
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const HEADER = ["schemaVersion", "sessionId", "cwdDigest", "pending", "digest"];
const ENTRY = ["status", "dispatchId", "toolCallId", "callDigest", "commandDigest", "taskHash", "goalRevision", "runtimeRevision", "step", "startedAt", "checkpoint"];
const CHECKPOINT = ["schemaVersion", "toolCallId", "taskHash", "runSha256", "resultSha256", "resultJson"];
export const nativeCommandDigest = text => crypto.createHash("sha256").update(text).digest("hex");

function invalid() {
  const error = new Error("Native command recovery state is invalid; no command was replayed.");
  error.code = "NATIVE_COMMAND_JOURNAL_INVALID";
  throw error;
}
function check(condition) { if (!condition) invalid(); }
function fields(...args) { try { return dataFields(...args); } catch { invalid(); } }
function snapshot(value, maximum = 512 * 1024) { try { return jsonSnapshot(value, { maxBytes: maximum }); } catch { invalid(); } }
function own(value, key) {
  check(value && typeof value === "object" && !types.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const d = Object.getOwnPropertyDescriptor(value, key);
  check(d?.enumerable && Object.hasOwn(d, "value")); return d.value;
}
function optionalOwn(value, key) {
  check(value && typeof value === "object" && !types.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d) return undefined;
  check(d.enumerable && Object.hasOwn(d, "value")); return d.value;
}
function dense(value) {
  check(Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  check(Number.isSafeInteger(length) && length >= 0 && length <= 1_000_000 && Reflect.ownKeys(value).length === length + 1);
  const result = [];
  for (let index = 0; index < length; index++) {
    const d = Object.getOwnPropertyDescriptor(value, String(index));
    check(d?.enumerable && Object.hasOwn(d, "value")); result.push(d.value);
  }
  return result;
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function seal(value) {
  const copy = snapshot(value);
  return snapshot({ ...copy, digest: nativeCommandDigest(canonical(copy)) });
}
function context(value) {
  const c = fields(value, ["sessionId", "commandCwd", "goalRevision", "runtimeRevision"]);
  // Match the existing native SessionStore/run-lock identity contract.
  check(typeof c.sessionId === "string" && c.sessionId.length > 0 && c.sessionId.length <= 255 && /^[A-Za-z0-9._:-]+$/u.test(c.sessionId) && c.sessionId !== "." && !c.sessionId.includes(".."));
  check(typeof c.commandCwd === "string" && path.isAbsolute(c.commandCwd) && path.resolve(c.commandCwd) === c.commandCwd);
  check(Number.isSafeInteger(c.goalRevision) && c.goalRevision >= 0 && positive(c.runtimeRevision));
  return c;
}
function callFacts(value) {
  const c = fields(value, ["id", "type", "function", "index"], ["id", "type", "function"]), f = fields(c.function, ["name", "arguments"]);
  check(!Object.hasOwn(c, "index") || Number.isSafeInteger(c.index) && c.index >= 0);
  check(typeof c.id === "string" && c.id.length > 0 && c.id.length <= 1024 && c.id.isWellFormed());
  check(c.type === "function" && ["run_command", "commit_project_changes"].includes(f.name) && typeof f.arguments === "string" && Buffer.byteLength(f.arguments) <= 16 * 1024 * 1024);
  let parsed; try { parsed = parseNativeToolArguments(f.arguments); } catch { invalid(); }
  let command = null;
  if (f.name === "run_command") {
    const args = fields(parsed, ["command"]);
    check(typeof args.command === "string" && args.command.length > 0 && args.command.isWellFormed()); command = args.command;
  } else {
    // The existing runner, not the model, builds the effective Git command
    // from its owned path selection. Bind that command and this original
    // native call; this grants neither a new tool nor arbitrary tool aliases.
    const args = fields(parsed, ["message", "paths"], ["message"]);
    check(typeof args.message === "string" && args.message.isWellFormed() && args.message.trim().length >= 3 && args.message.trim().length <= 120 && !/[\r\n\0]/u.test(args.message));
    if (args.paths !== undefined) check(dense(args.paths).every(p => typeof p === "string" && p.length > 0 && p.isWellFormed()));
  }
  return { id: c.id, command, digest: nativeCommandDigest(JSON.stringify([c.id, c.type, f.name, f.arguments, c.index ?? null])) };
}

export function emptyNativeCommandJournal(expected) {
  const c = context(expected);
  return seal({ schemaVersion: 1, sessionId: c.sessionId, cwdDigest: nativeCommandDigest(c.commandCwd), pending: null });
}

export function readNativeCommandJournal(value, expected) {
  try {
    const c = context(expected), h = dataFields(jsonSnapshot(value, { maxBytes: 512 * 1024 }), HEADER);
    check(h.schemaVersion === 1 && h.sessionId === c.sessionId && h.cwdDigest === nativeCommandDigest(c.commandCwd));
    const unsigned = { schemaVersion: h.schemaVersion, sessionId: h.sessionId, cwdDigest: h.cwdDigest, pending: h.pending };
    check(typeof h.digest === "string" && HASH.test(h.digest) && seal(unsigned).digest === h.digest);
    if (h.pending !== null) {
      const e = dataFields(h.pending, ENTRY);
      check(["dispatching", "result-ready"].includes(e.status) && typeof e.dispatchId === "string" && UUID.test(e.dispatchId));
      check(typeof e.toolCallId === "string" && e.toolCallId.length > 0 && e.toolCallId.length <= 1024);
      check([e.callDigest, e.commandDigest, e.taskHash].every(value => typeof value === "string" && HASH.test(value)));
      check(positive(e.goalRevision) && e.goalRevision <= c.goalRevision && positive(e.runtimeRevision) && e.runtimeRevision <= c.runtimeRevision && positive(e.step));
      check(typeof e.startedAt === "string" && Number.isFinite(Date.parse(e.startedAt)) && new Date(e.startedAt).toISOString() === e.startedAt);
      if (e.status === "dispatching") check(e.checkpoint === null);
      else {
        const p = dataFields(e.checkpoint, CHECKPOINT);
        check(p.schemaVersion === 2 && p.toolCallId === e.toolCallId && p.taskHash === e.taskHash);
        check(typeof p.runSha256 === "string" && HASH.test(p.runSha256) && typeof p.resultSha256 === "string" && HASH.test(p.resultSha256) && typeof p.resultJson === "string" && Buffer.byteLength(p.resultJson) <= 131072 && p.resultSha256 === nativeCommandDigest(p.resultJson));
        const result = parseNativeToolArguments(p.resultJson);
        check(result.goalRevision === e.goalRevision && result.toolName === "run_command");
        check(JSON.stringify(boundedNativeCommandCheckpointResult({ ...result, commandPolicy: { noMatchExitIsSuccess: result.noMatchExitIsSuccess } })) === p.resultJson);
      }
    }
    return jsonSnapshot(h, { maxBytes: 512 * 1024 });
  } catch { invalid(); }
}

export function beginNativeCommand(journal, expected, options) {
  const o = fields(options, ["call", "command", "step", "taskHash", "startedAt"], ["call", "command", "step", "taskHash"]);
  const { call, command, step, taskHash } = o, startedAt = o.startedAt ?? new Date().toISOString();
  const h = readNativeCommandJournal(journal, expected), c = context(expected), f = callFacts(call);
  check(h.pending === null && positive(c.goalRevision) && typeof command === "string" && command.length > 0 && command.isWellFormed() &&
    (f.command === null || f.command === command) && positive(step) && typeof taskHash === "string" && HASH.test(taskHash));
  const pending = { status: "dispatching", dispatchId: crypto.randomUUID(), toolCallId: f.id,
    callDigest: f.digest, commandDigest: nativeCommandDigest(canonicalizeShellCommand(command)), taskHash,
    goalRevision: c.goalRevision, runtimeRevision: c.runtimeRevision, step, startedAt, checkpoint: null };
  const result = seal({ schemaVersion: 1, sessionId: h.sessionId, cwdDigest: h.cwdDigest, pending });
  return readNativeCommandJournal(result, expected);
}

function boundCall(state, entry) {
  const messages = dense(own(state, "messages"));
  let frame = null;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const role = own(message, "role");
    if (role === "assistant") {
      const d = Object.getOwnPropertyDescriptor(message, "tool_calls");
      if (!d) continue;
      check(d.enumerable && Object.hasOwn(d, "value"));
      if (d.value === null || d.value === undefined) continue;
      const calls = dense(d.value);
      if (calls.some(call => own(call, "id") === entry.toolCallId)) {
        check(frame === null); frame = { calls, index };
      }
    } else if (role === "tool" && own(message, "tool_call_id") === entry.toolCallId) {
      check(frame !== null); frame = null;
    }
  }
  check(frame !== null && frame.calls.length === 1);
  const f = callFacts(frame.calls[0]);
  check(f.digest === entry.callDigest && (f.command === null || nativeCommandDigest(canonicalizeShellCommand(f.command)) === entry.commandDigest));
  const history = dense(own(own(own(state, "meta"), "goalContract"), "history"));
  const owner = history.filter(value => own(value, "revision") === entry.goalRevision);
  check(owner.length === 1 && own(owner[0], "taskHash") === entry.taskHash);
  return { ...f, frameIndex: frame.index };
}

export function validateNativeCommandDispatch(journal, expected, state) {
  const h = readNativeCommandJournal(journal, expected);
  check(h.pending?.status === "dispatching");
  boundCall(state, h.pending);
  const steps = own(state, "stepsCompleted");
  check(Number.isSafeInteger(steps) && steps >= 0 && h.pending.step === steps + 1);
  return h;
}

function verifiedCheckpoint(runValue, checkpoint, state, taskHash, goalRevision, commandDigest = null) {
  const run = snapshot(runValue, 32 * 1024 * 1024), p = fields(snapshot(checkpoint), CHECKPOINT);
  check(p.schemaVersion === 2 && p.taskHash === taskHash && p.runSha256 === nativeCommandVerificationDigest(run));
  check(typeof p.toolCallId === "string" && p.toolCallId.length > 0 && typeof p.resultJson === "string" &&
    p.resultJson.isWellFormed() && Buffer.byteLength(p.resultJson) <= 131072 && p.resultSha256 === nativeCommandDigest(p.resultJson));
  let result; try { result = parseNativeToolArguments(p.resultJson); } catch { invalid(); }
  const explicitExitStatus = optionalOwn(run, "explicitExitStatus");
  check(explicitExitStatus === undefined || Number.isSafeInteger(explicitExitStatus) && explicitExitStatus >= 0 && explicitExitStatus <= 255);
  // Verification intentionally distinguishes a successful shell wrapper from
  // its reported inner failure, and a no-match query from a passing test.
  const verifiedSuccess = result.ok === true && result.exitCode === 0 && (explicitExitStatus === undefined || explicitExitStatus === 0);
  check(result.toolName === "run_command" && result.goalRevision === goalRevision &&
    typeof run.ok === "boolean" && verifiedSuccess === run.ok && result.projectMutationRevision === run.mutationRevision &&
    result.commandSequence === run.commandSequence && typeof run.command === "string" && run.command.length > 0);
  check(JSON.stringify(boundedNativeCommandCheckpointResult({ ...result, commandPolicy: { noMatchExitIsSuccess: result.noMatchExitIsSuccess } })) === p.resultJson);
  if (commandDigest !== null) check(nativeCommandDigest(run.command) === commandDigest);
  if (result.projectTest?.passed === true) {
    check(run.ok === true && Number.isSafeInteger(run.privateMutationRevision) && run.privateMutationRevision >= 0);
    const project = own(own(state, "meta"), "projectVerification"), raw = optionalOwn(project, "testRuns");
    const tests = raw === undefined ? [] : dense(raw);
    check(tests.some(test => optionalOwn(test, "command") === run.command && optionalOwn(test, "at") === run.at &&
      optionalOwn(test, "passed") === true && optionalOwn(test, "ok") === true &&
      optionalOwn(test, "mutationRevision") === run.mutationRevision && optionalOwn(test, "privateMutationRevision") === run.privateMutationRevision &&
      optionalOwn(test, "commandSequence") === result.projectTest.commandSequence));
  }
  return result;
}

export function prepareNativeCommandResult(journal, expected, state, checkpoint) {
  const h = readNativeCommandJournal(journal, expected), e = h.pending;
  check(e?.status === "dispatching"); boundCall(state, e);
  const p = fields(snapshot(checkpoint), CHECKPOINT);
  const runs = dense(own(own(own(state, "meta"), "projectVerification"), "commandRuns"));
  const run = runs.at(-1);
  check(run); verifiedCheckpoint(run, p, state, e.taskHash, e.goalRevision, e.commandDigest);
  const ready = seal({ schemaVersion: 1, sessionId: h.sessionId, cwdDigest: h.cwdDigest, pending: { ...e, status: "result-ready", checkpoint: p } });
  return readNativeCommandJournal(ready, expected);
}

export function retireNativeCommand(journal, expected) {
  const h = readNativeCommandJournal(journal, expected);
  return seal({ schemaVersion: 1, sessionId: h.sessionId, cwdDigest: h.cwdDigest, pending: null });
}

export function restoreNativeCommandFrame(journal, expected, state) {
  const h = readNativeCommandJournal(journal, expected), e = h.pending;
  check(e?.status === "result-ready"); const f = boundCall(state, e);
  const runs = dense(own(own(own(state, "meta"), "projectVerification"), "commandRuns"));
  const matches = runs.filter(run => nativeCommandVerificationDigest(run) === e.checkpoint.runSha256);
  check(matches.length === 1 && canonical(snapshot(own(matches[0], "nativeResultCheckpoint"))) === canonical(e.checkpoint));
  verifiedCheckpoint(matches[0], e.checkpoint, state, e.taskHash, e.goalRevision, e.commandDigest);
  const steps = own(state, "stepsCompleted"); check(Number.isSafeInteger(steps) && steps >= 0);
  Array.prototype.splice.call(own(state, "messages"), f.frameIndex + 1, 0, { role: "tool", tool_call_id: e.toolCallId, content: e.checkpoint.resultJson });
  state.stepsCompleted = Math.max(steps, e.step);
  return { journal: retireNativeCommand(h, expected), dispatchId: e.dispatchId, toolCallId: e.toolCallId };
}

// A legacy hold records an observed absence of exact outcome authority. It is
// deliberately separate from a native dispatch authorization or a result.
export function legacyNativeCommandHold(unknown, expected) {
  const c = context(expected), values = dense(unknown);
  check(values.length > 0);
  const hash = crypto.createHash("sha256");
  for (const value of values) {
    const h = own(value, "commandDigest"), index = own(value, "eventIndex");
    check(typeof h === "string" && HASH.test(h) && Number.isSafeInteger(index) && index >= 0);
    hash.update(JSON.stringify([h, index, optionalOwn(value, "toolCallId") ?? null]) + "\n");
  }
  return seal({ schemaVersion: 1, sessionId: c.sessionId, cwdDigest: nativeCommandDigest(c.commandCwd), unknownCount: values.length, evidenceDigest: hash.digest("hex") });
}

export function readLegacyNativeCommandHold(value, expected) {
  const c = context(expected), h = fields(snapshot(value), ["schemaVersion", "sessionId", "cwdDigest", "unknownCount", "evidenceDigest", "digest"]);
  check(h.schemaVersion === 1 && h.sessionId === c.sessionId && h.cwdDigest === nativeCommandDigest(c.commandCwd) && positive(h.unknownCount) && typeof h.evidenceDigest === "string" && HASH.test(h.evidenceDigest));
  const candidate = seal({ schemaVersion: h.schemaVersion, sessionId: h.sessionId, cwdDigest: h.cwdDigest, unknownCount: h.unknownCount, evidenceDigest: h.evidenceDigest });
  check(candidate.digest === h.digest); return candidate;
}

// Enrollment is once per legacy session. An unmatched start is not proof that a
// command ran, nor proof that it did not. Later completion/interrupt closes only
// its matching latest attempt, never every earlier occurrence of that command.
export function legacyUnconfirmedCommands(events, state = null) {
  events = dense(events);
  const pending = [];
  const completedIds = new Set();
  let boundary = -1, activeCommand = null, offers = [];
  for (let index = 0; index < events.length; index++) {
    const event = fields(events[index], ["timestamp", "type", "data"]);
    check(typeof event.type === "string");
    if (["session.created", "session.resumed"].includes(event.type)) { boundary = index; activeCommand = null; offers = []; continue; }
    if (event.type === "model.responded") {
      const data = snapshot(event.data, 32 * 1024 * 1024);
      offers = [];
      if (data.toolCalls !== undefined) for (const call of dense(data.toolCalls)) {
        if (own(call, "name") !== "run_command") continue;
        try {
          const args = fields(parseNativeToolArguments(own(call, "arguments")), ["command"]), id = own(call, "id");
          if (typeof id === "string" && id && typeof args.command === "string") offers.push({ id, command: args.command });
        } catch { /* A malformed disclosure is never authority to reconcile a receipt. */ }
      }
      continue;
    }
    if (event.type === "session.stopped" && snapshot(event.data).reason === "user_interrupt") {
      if (activeCommand !== null && activeCommand > boundary) {
        const p = pending.findIndex(value => value.eventIndex === activeCommand); if (p >= 0) pending.splice(p, 1);
      }
      activeCommand = null; continue;
    }
    if (!["tool.started", "tool.completed", "tool.failed"].includes(event.type)) continue;
    const data = snapshot(event.data, 32 * 1024 * 1024);
    check(typeof data.toolName === "string");
    if (data.toolName !== "run_command") { if (event.type === "tool.started") activeCommand = null; continue; }
    check(typeof data.args?.command === "string");
    if (event.type === "tool.started") {
      const matches = offers.filter(value => value.command === data.args.command);
      const id = matches.length === 1 ? matches[0].id : null;
      pending.push({ command: data.args.command, startedAt: event.timestamp, commandDigest: nativeCommandDigest(data.args.command), eventIndex: index, toolCallId: id });
      offers = []; activeCommand = index;
    }
    else {
      // Historical generic exceptions could be published as tool.failed after
      // a command had already changed the world. That event is not an exit
      // receipt; an exact persisted checkpoint below may still resolve it.
      if (event.type === "tool.failed") { activeCommand = null; continue; }
      const hash = nativeCommandDigest(data.args.command);
      for (let p = pending.length - 1; p >= 0; p--) if (pending[p].commandDigest === hash) {
        if (pending[p].toolCallId !== null) completedIds.add(pending[p].toolCallId);
        pending.splice(p, 1); break;
      }
      activeCommand = null;
    }
  }
  if (state !== null && pending.length) {
    const meta = own(state, "meta"), project = optionalOwn(meta, "projectVerification");
    const runs = project ? optionalOwn(project, "commandRuns") : undefined;
    const history = dense(own(own(meta, "goalContract"), "history"));
    if (runs !== undefined) for (const run of dense(runs)) {
      // State without exact call-ID provenance cannot retire a legacy unknown.
      try {
        const p = optionalOwn(run, "nativeResultCheckpoint"); if (p === undefined) continue;
        const cp = fields(snapshot(p), CHECKPOINT);
        if (completedIds.has(cp.toolCallId)) continue;
        const candidates = pending.filter(value => value.toolCallId === cp.toolCallId);
        if (candidates.length !== 1) continue;
        const payload = parseNativeToolArguments(cp.resultJson);
        const owners = history.filter(value => optionalOwn(value, "revision") === payload.goalRevision);
        check(owners.length === 1 && optionalOwn(owners[0], "taskHash") === cp.taskHash);
        verifiedCheckpoint(run, cp, state, cp.taskHash, payload.goalRevision, nativeCommandDigest(canonicalizeShellCommand(candidates[0].command)));
        pending.splice(pending.indexOf(candidates[0]), 1); completedIds.add(cp.toolCallId);
      } catch { /* Invalid or lossy old proof leaves the dispatch unknown. */ }
    }
  }
  return pending;
}
