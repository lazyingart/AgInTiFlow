import { createHash } from "node:crypto";
import { types } from "node:util";
import { WRAPPER_NAMES } from "./tool-wrappers.js";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const HEX = /^[a-f0-9]{64}$/;
const WRAPPERS = WRAPPER_NAMES.join("|");

function ownerInstructionText(source) {
  const chunks = [];
  const quotes = { '"': '"', "'": "'", "“": "”", "‘": "’", "`": "`" };
  for (let index = 0; index < source.length;) {
    const quote = source[index];
    if (!Object.hasOwn(quotes, quote) || quote === "'" && index > 0 && /[\p{L}\p{N}]/u.test(source[index - 1])) {
      chunks.push(quote); index++; continue;
    }
    const fence = quote === "`" && source.startsWith("```", index);
    const opening = fence ? "```" : quote, closing = fence ? "```" : quotes[quote];
    let end = index + opening.length, found = false;
    while (end < source.length) {
      if (source[end] === "\\") { end += 2; continue; }
      if (source.startsWith(closing, end)) { found = true; break; }
      end++;
    }
    const value = source.slice(index + opening.length, end);
    chunks.push(found && !fence && WRAPPER_NAMES.includes(value.toLowerCase()) ? value : " ");
    index = found ? end + closing.length : source.length;
  }
  return chunks.join("");
}

// A deliberately narrow owner-instruction grammar. This does not select or
// enable a provider. Unbounded/iterative requests retain their existing policy.
export function deriveAdvisoryInvocationContract(goal = "") {
  if (typeof goal !== "string") return null;
  const source = ownerInstructionText(goal)
    .replace(/\s+/g, " ").replace(/\b(?:do not|don't|never)\s+(?:ask|call|consult|invoke|use)\b[^;!?\n。！？；]*/gi, "")
    .replace(/(?:不要|禁止|请勿|請勿)[^;!?\n。！？；]*(?:咨询|諮詢|询问|詢問|调用|調用)[^;!?\n。！？；]*/g, "");
  const action = new RegExp(`\\b(?:ask|consult|call|invoke|use)\\s+(?:the\\s+)?(${WRAPPERS})\\b([^;!?\\n。！？；]{0,360})`, "i").exec(source)
    || new RegExp(`(?:咨询|諮詢|询问|詢問|请教|請教|调用|調用|请|請)\\s*(${WRAPPERS})\\b([^;!?\\n。！？；]{0,360})`, "i").exec(source);
  if (!action) return null;
  const tail = action[2].split(/[.!?]\s+/)[0];
  if (/\b(?:twice|thrice|(?:two|three|[2-9])\s+(?:times?|calls?|reviews?|attempts?))\b|[两兩二三四五六七八九]次/i.test(tail)) return null;
  const once = /^\s*(?:(?:cli|agent|assistant)\s+)?(?:again\s+)?(?:(?:only|just|at most)\s+)?once\b|^\s*(?:only|just|at most)\s+(?:one|1)\s+(?:time|call|attempt|request|question|review|opinion)\b|^\s*for\s+(?:one|1)\s+(?:(?:independent|read-only|quick|bounded)\s+){0,4}(?:second\s+opinion|review|assessment)\b|^\s*(?:仅|僅|只)?(?:再次|重新)?(?:调用|調用|咨询|諮詢|询问|詢問|做|进行|進行)?\s*一次/i.test(tail);
  if (!once) return null;
  const prefix = source.slice(Math.max(0, action.index - 70), action.index);
  // Explanations of a workflow are not an instruction to execute it.
  if (/\b(?:explain|describe|why|documentation|example)\b[^.!?;\n]*$/i.test(prefix)) return null;
  const optional = /\b(?:optionally|(?:if|when) (?:useful|needed|available|possible)|if it (?:helps|can)|(?:you|it) (?:may|can)|as needed)\b|(?:可选|可選|有需要|如有必要|如果需要)/i.test(prefix + tail) ||
    /\bif\s+(?:it|the adviser)\s+(?:fails|is unavailable)\b[^.!?;]{0,70}\b(?:continue|proceed|carry on)\b/i.test(source.slice(action.index, action.index + 550));
  const beforeMutation = /\bbefore\s+(?:(?:any|further|making)\s+)*(?:edit(?:ing|s)?|patch(?:ing|es)?|modif(?:ying|ications)|chang(?:ing|es))\b|(?:修改|编辑|編輯|改动|改動|更改)(?:前|之前)|先[^。！？；\n]{0,80}(?:再|然后|然後)(?:修改|编辑|編輯)/i.test(prefix + tail);
  return Object.freeze({ version: 1, wrapper: action[1].toLowerCase(), maximumAttempts: 1, required: !optional, beforeMutation: beforeMutation && !optional });
}

export function createAdvisoryInvocationCheckpoint() {
  return { version: 1, scope: null, attempt: null };
}

function ownData(value, keys) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key))) return null;
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function validScope(value) {
  const scope = ownData(value, ["id", "revision", "goalHash", "wrapper"]);
  return scope && typeof scope.id === "string" && HEX.test(scope.id) && typeof scope.goalHash === "string" && HEX.test(scope.goalHash) && Number.isSafeInteger(scope.revision) && scope.revision > 0 && WRAPPER_NAMES.includes(scope.wrapper) ? scope : null;
}

function validResult(value) {
  const result = ownData(value, ["ok", "wrapper", "stdout", "stderr", "error"]);
  if (!result || typeof result.ok !== "boolean" || !WRAPPER_NAMES.includes(result.wrapper)) return null;
  for (const [key, max] of [["stdout", 12000], ["stderr", 4000], ["error", 1200]])
    if (typeof result[key] !== "string" || result[key].length > max) return null;
  if (result.ok ? !result.stdout.trim() || result.error !== "" : !result.error.trim()) return null;
  return result;
}

function validAttempt(value, scope) {
  const attempt = ownData(value, ["id", "requestHash", "toolCallId", "startedAt", "status", "result", "resultDigest"]);
  if (!attempt || typeof attempt.requestHash !== "string" || !HEX.test(attempt.requestHash)) return null;
  if (typeof attempt.toolCallId !== "string" || !attempt.toolCallId || attempt.toolCallId.length > 256) return null;
  if (typeof attempt.startedAt !== "string" || !Number.isFinite(Date.parse(attempt.startedAt)) || new Date(attempt.startedAt).toISOString() !== attempt.startedAt) return null;
  if (attempt.id !== digest([scope.id, attempt.requestHash, attempt.toolCallId, attempt.startedAt])) return null;
  if (attempt.status === "reserved") return attempt.result === null && attempt.resultDigest === null ? attempt : null;
  if (attempt.status !== "settled") return null;
  const result = validResult(attempt.result);
  return result && result.wrapper === scope.wrapper && attempt.resultDigest === digest(result) ? { ...attempt, result } : null;
}

export function advisoryInvocationState(state = {}, goal = "") {
  const contract = deriveAdvisoryInvocationContract(goal);
  if (!contract) return { contract: null, kind: "none" };
  const goalContract = state.meta?.goalContract || {};
  let revision = goalContract.taskBoundaryRevision;
  if (typeof state.sessionId !== "string" || !state.sessionId || !Number.isSafeInteger(goalContract.revision) || goalContract.revision <= 0 ||
      revision !== undefined && revision !== 0 && (!Number.isSafeInteger(revision) || revision < 0 || revision > goalContract.revision))
    return { contract, kind: "invalid" };
  const checkpoint = ownData(state.meta?.advisoryInvocation, ["version", "scope", "attempt"]);
  const previous = checkpoint?.scope === null ? null : validScope(checkpoint?.scope);
  if (previous && (previous.revision > goalContract.revision || previous.id !== digest([state.sessionId, previous.revision, previous.goalHash, previous.wrapper])))
    return { contract, kind: "invalid" };
  const newRequest = typeof goalContract.currentRequest === "string" ? goalContract.currentRequest : "";
  const explicitGrant = deriveAdvisoryInvocationContract(newRequest)?.wrapper === contract.wrapper &&
    new RegExp(`\\b${contract.wrapper}\\b\\s+(?:again\\b|(?:(?:only|just)\\s+)?once\\s+again\\b|(?:再次|重新))`, "i").test(ownerInstructionText(newRequest));
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    if (explicitGrant && Number.isSafeInteger(goalContract.revision) && goalContract.revision > 0) revision = goalContract.revision;
    else if (previous?.goalHash === digest(goal) && previous.wrapper === contract.wrapper) revision = previous.revision;
    else return { contract, kind: "invalid" };
  }
  if (explicitGrant && Number.isSafeInteger(goalContract.revision) && goalContract.revision > revision) revision = goalContract.revision;
  else if (previous?.goalHash === digest(goal) && previous.wrapper === contract.wrapper && previous.revision > revision) revision = previous.revision;
  const scope = Object.freeze({ id: digest([state.sessionId, revision, digest(goal), contract.wrapper]), revision, goalHash: digest(goal), wrapper: contract.wrapper });
  const raw = state.meta?.advisoryInvocation;
  // A newly explicit owner request can grant a fresh scope to a legacy session.
  // A generic continuation cannot manufacture evidence that no attempt ran.
  if (raw === undefined && (state.meta?.goalContract?.taskRelation === "new-request" || explicitGrant) && state.meta.goalContract.revision === revision)
    return { contract, scope, kind: "unused" };
  if (!checkpoint || checkpoint.version !== 1) return { contract, scope, kind: "invalid" };
  if (checkpoint.scope === null) return { contract, scope, kind: checkpoint.attempt === null ? "unused" : "invalid" };
  if (!previous) return { contract, scope, kind: "invalid" };
  if (previous.id !== scope.id) return { contract, scope, kind: previous.revision < revision ? "unused" : "invalid" };
  if (previous.revision !== scope.revision || previous.goalHash !== scope.goalHash || previous.wrapper !== scope.wrapper) return { contract, scope, kind: "invalid" };
  const attempt = validAttempt(checkpoint.attempt, scope);
  if (!attempt) return { contract, scope, kind: "invalid" };
  return { contract, scope, attempt, kind: attempt.status === "reserved" ? "uncertain" : attempt.result.ok ? "succeeded" : "failed" };
}

export function advisoryInvocationRequestHash(args, config = {}) {
  const request = ownData(args, ["wrapper", "prompt"]);
  if (!request || !WRAPPER_NAMES.includes(request.wrapper) || typeof request.prompt !== "string" || !request.prompt.trim()) return null;
  return digest([request.wrapper, request.prompt, config.commandCwd || "", config.wrapperModel || "", config.wrapperReasoning || ""]);
}

export function reserveAdvisoryInvocation(state, info, requestHash, toolCallId, at = new Date().toISOString()) {
  if (info.kind !== "unused" || typeof requestHash !== "string" || !HEX.test(requestHash) || typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 256 || typeof at !== "string" || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) throw new Error("Advisory invocation cannot be reserved.");
  const attempt = { id: digest([info.scope.id, requestHash, toolCallId, at]), requestHash, toolCallId, startedAt: at, status: "reserved", result: null, resultDigest: null };
  state.meta.advisoryInvocation = { version: 1, scope: { ...info.scope }, attempt };
  return attempt.id;
}

export function settleAdvisoryInvocation(state, goal, result) {
  const current = advisoryInvocationState(state, goal);
  if (current.kind !== "uncertain") throw new Error("Advisory invocation has no matching reservation.");
  const stdout = typeof result.stdout === "string" ? result.stdout.slice(0, 12000) : "";
  const ok = result.ok === true && result.wrapper === current.contract.wrapper && stdout.trim().length > 0 && result.fallback !== true;
  const snapshot = { ok, wrapper: current.contract.wrapper, stdout, stderr: typeof result.stderr === "string" ? result.stderr.slice(0, 4000) : "",
    error: ok ? "" : typeof result.error === "string" && result.error.trim() ? result.error.slice(0, 1200) : "The adviser returned no usable result." };
  state.meta.advisoryInvocation.attempt = { ...state.meta.advisoryInvocation.attempt, status: "settled", result: snapshot, resultDigest: digest(snapshot) };
  return snapshot;
}

// Repair only this receipt's original transport pair after an interrupted
// reservation. Never execute a tool or guess an unknown business outcome.
export function reconcileAdvisoryToolReplies(state) {
  if (typeof state.sessionId !== "string" || !Number.isSafeInteger(state.meta?.goalContract?.revision)) return 0;
  const checkpoint = ownData(state.meta?.advisoryInvocation, ["version", "scope", "attempt"]);
  if (!checkpoint || checkpoint.version !== 1 || checkpoint.attempt === null || !Array.isArray(state.messages)) return 0;
  const scope = validScope(checkpoint.scope), attempt = scope && validAttempt(checkpoint.attempt, scope);
  if (!attempt || scope.id !== digest([state.sessionId, scope.revision, scope.goalHash, scope.wrapper]) || scope.revision > state.meta?.goalContract?.revision) return 0;
  const index = state.messages.findLastIndex(message => message?.role === "assistant" && message.tool_calls?.some(call => call?.id === attempt.toolCallId && call.function?.name === "delegate_agent"));
  if (index < 0) return 0;
  if (state.messages[index].tool_calls.length !== 1) throw new Error("Saved advisory tool-call history is ambiguous.");
  if (state.messages[index + 1]?.role === "tool" && state.messages[index + 1].tool_call_id === attempt.toolCallId) return 0;
  const result = attempt.status === "settled" ? { ...attempt.result, toolName: "delegate_agent", advisoryInvocationId: attempt.id, recovered: true }
    : { ok: false, outcome: "unavailable", replayed: false,
      error: "The previous advisory reply was not durably recorded. No external call is being repeated by this recovery." };
  state.messages.splice(index + 1, 0, { role: "tool", tool_call_id: attempt.toolCallId, content: JSON.stringify(result) });
  return 1;
}
