import { createHash } from "node:crypto";
import { types } from "node:util";
import { redactSensitiveText } from "./redaction.js";
import { isResponseOnlyEvidenceScope } from "./scs-evidence.js";

const DEFAULT_LIMIT = 1200;
const MAX_LIMIT = 2000;
const MAX_QUERY_BYTES = 256;
const HISTORY_LIMIT = 24; // GOAL_HISTORY_LIMIT in agent-runner.
const PREVIEW_LIMIT = 2000; // goalPreview truncates at this many UTF-16 units.
const argumentNames = ["query", "offset", "limit"];
const integrationMarkers = ["integrationPolicyLock", "integrationPolicyFingerprint",
  "integrationRuntimeRootsDigest", "expectedIntegrationRuntimeRevision", "integrationSessionProfile", "integrationAllowedToolNames"];

function requireData(condition) {
  if (!condition) throw new TypeError("Invalid native task window data");
}

function record(value) {
  requireData(value !== null && typeof value === "object" && !types.isProxy(value));
  const prototype = Object.getPrototypeOf(value);
  requireData(prototype === null || prototype === Object.prototype);
  return value;
}

// Call only on a checked record or native array. Never read through a prototype.
function own(object, key) {
  const field = Object.getOwnPropertyDescriptor(object, key);
  if (!field) return undefined;
  requireData(field.enumerable && Object.hasOwn(field, "value"));
  return field.value;
}

function parseArguments(value) {
  record(value);
  const args = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    requireData(argumentNames.includes(key));
    args[key] = own(value, key);
  }
  if (Object.hasOwn(args, "query")) {
    const query = args.query;
    requireData(typeof query === "string" && query.length > 0 && query.length <= MAX_QUERY_BYTES &&
      query.isWellFormed() && Buffer.byteLength(query, "utf8") <= MAX_QUERY_BYTES);
  }
  if (!Object.hasOwn(args, "offset")) args.offset = 0;
  if (!Object.hasOwn(args, "limit")) args.limit = DEFAULT_LIMIT;
  requireData(Number.isSafeInteger(args.offset) && args.offset >= 0 &&
    Number.isSafeInteger(args.limit) && args.limit > 0 && args.limit <= MAX_LIMIT);
  return args;
}

const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
const positive = value => Number.isSafeInteger(value) && value > 0;

// Cache only functions of immutable strings. Scope, mode, status, revisions
// and the live history witnesses are checked again, even on a warm read.
const textCache = new WeakMap();

function checkedTexts(contract, task, active, request) {
  const saved = textCache.get(contract);
  if (saved && saved.task === task && saved.active === active && saved.request === request) return saved;
  const digests = new Map();
  for (const text of [task, active, request]) {
    if (digests.has(text)) continue;
    requireData(text.isWellFormed() && (!text.includes("AGINTI_EVIDENCE_SCOPE_JSON:") || !isResponseOnlyEvidenceScope(text)));
    digests.set(text, hash(text));
  }
  const checked = { task, active, request, taskHash: digests.get(task), activeHash: digests.get(active),
    currentHash: digests.get(request), view: null };
  textCache.set(contract, checked);
  return checked;
}

function verifyLineage(contract, texts) {
  const revision = own(contract, "revision");
  const activeRevision = own(contract, "activeGoalRevision");
  const history = own(contract, "history");
  requireData(positive(revision) && positive(activeRevision) && activeRevision <= revision &&
    !types.isProxy(history) && Array.isArray(history) && Object.getPrototypeOf(history) === Array.prototype &&
    history.length <= HISTORY_LIMIT && history.length <= revision);

  let boundary = own(contract, "taskBoundaryRevision");
  if (boundary === 0) {
    // The v3 updater records zero when migrating a missing boundary. Recover
    // a revision only if its actual opening row still survives validation below.
    for (let i = history.length - 1; i >= 0; i--) {
      const row = record(own(history, i));
      if (own(row, "kind") !== "same-task-continuation") {
        boundary = own(row, "revision");
        break;
      }
    }
  }
  requireData(positive(boundary) && boundary <= activeRevision);
  const relation = own(contract, "taskRelation");
  requireData(revision > boundary ? relation === "same-task" :
    relation === "new-request" || (boundary === 1 && relation === "initial"));
  const count = Math.min(revision - boundary + 1, HISTORY_LIMIT);
  requireData(history.length >= count);

  const { taskHash, activeHash, currentHash } = texts;
  requireData(own(contract, "currentHash") === currentHash);
  if (activeRevision === boundary) requireData(activeHash === taskHash);
  let previousActiveHash;
  // Only the current task's retained suffix can attest its source. Long-lived
  // tasks legitimately roll the boundary entry out of this native 24-row ring.
  for (let i = history.length - count; i < history.length; i++) {
    const row = record(own(history, i));
    const number = revision - (history.length - 1 - i);
    const rowHash = own(row, "hash");
    const initial = number === 1 && own(row, "kind") === "initial";
    // Older initial records carry just hash; that hash bound all three texts.
    const initialHash = initial ? rowHash : undefined;
    const rowActive = Object.hasOwn(row, "activeHash") ? own(row, "activeHash") : initialHash;
    const rowTask = Object.hasOwn(row, "taskHash") ? own(row, "taskHash") : initialHash;
    requireData(own(row, "revision") === number && rowTask === taskHash);
    if (number === boundary) {
      requireData((initial || own(row, "kind") === "continuation") &&
        own(row, "relation") === (initial ? undefined : "new-request") &&
        (number !== revision || relation === (initial ? "initial" : "new-request")) &&
        rowHash === taskHash && rowActive === taskHash);
    } else {
      requireData(own(row, "kind") === "same-task-continuation" && own(row, "relation") === "same-task");
      const refresh = own(row, "refreshExecutionContract");
      requireData(typeof refresh === "boolean" && (!refresh || (number <= activeRevision && rowActive === rowHash)));
      if (previousActiveHash !== undefined) {
        requireData(own(row, "previousHash") === previousActiveHash);
        // A bare checkpoint may restore the task itself as active at this revision.
        const restored = rowActive !== previousActiveHash && rowActive === taskHash;
        requireData(refresh || rowActive === previousActiveHash || (number <= activeRevision && restored));
        if (number === activeRevision) requireData(refresh || restored);
      }
    }
    if (number >= activeRevision) requireData(rowActive === activeHash);
    if (number === revision) requireData(rowHash === currentHash);
    previousActiveHash = rowActive;
  }
  return { goalRevision: revision, taskBoundaryRevision: boundary, activeGoalRevision: activeRevision };
}

function restrictedScope(scope) {
  const namespace = own(scope, "toolNamespace");
  return integrationMarkers.some(key => Object.hasOwn(scope, key)) ||
    own(scope, "schemaVersion") === "aginti-restricted-application-v1" ||
    (namespace !== undefined && namespace !== "native") ||
    own(scope, "restrictedApplication") === true || own(scope, "hostManagedResponseOnly") === true ||
    own(scope, "responseOnly") === true || own(scope, "savedResultAnswerOnly") === true;
}

function verifiedTask(state) {
  try {
    const meta = record(own(record(state), "meta"));
    const contract = record(own(meta, "goalContract"));
    const task = own(contract, "taskGoal");
    if (typeof task !== "string" || !task.length || own(contract, "version") !== 3 ||
      own(contract, "status") !== "active") return null;
    if (task.length <= PREVIEW_LIMIT) {
      const budget = own(meta, "contextBudget");
      // Reset to zero on each continuation. Session-wide compaction counts
      // would incorrectly expose ordinary short requests from a later turn.
      if (!budget || !positive(own(record(budget), "lastCompactedStep"))) return null;
    }
    const runtime = own(meta, "runtimeConfig");
    if (restrictedScope(state) || restrictedScope(meta) || (runtime !== undefined && restrictedScope(record(runtime)))) return null;

    const active = own(contract, "activeGoal");
    const request = own(contract, "currentRequest");
    const goal = own(state, "goal");
    requireData(typeof active === "string" && active.length > 0 && typeof request === "string" && request.length > 0 &&
      typeof goal === "string" && (goal === active || goal.trim() === active));
    const texts = checkedTexts(contract, task, active, request);
    return { texts, lineage: verifyLineage(contract, texts) };
  } catch {
    return null;
  }
}

// The native caller also enforces its live profile, policy and offered tool
// set. A saved state cannot grant request-local execution authority.
export function currentTaskWindowAvailable(state) {
  return verifiedTask(state) !== null;
}

function redactDanglingEscapes(text) {
  // Complete a dangling quoted escape for the shared redactor. Only a
  // surviving line ending in a backslash needs this second pass.
  if (!/\\(?=[\r\n]|$)/u.test(text)) return text;
  return text.replace(/^[^\r\n]*\\(?=[\r\n]|$)/gmu, line => {
    const repaired = redactSensitiveText(line + " ");
    return repaired.endsWith(" ") ? repaired.slice(0, -1) : repaired;
  });
}

function redactTask(task, depth = 0) {
  const text = redactDanglingEscapes(redactSensitiveText(task));
  if (!text.includes('\\"')) return text;
  // A truncated outer JSON string cannot be decoded by the normal recursive
  // redactor. Inspect only incomplete literals containing a serialized field.
  return text.replace(/"(?:\\[^\r\n]|[^"\\\r\n])*(?:(")|\\?(?=[\r\n]|$))/gu, (literal, closed) => {
    if (closed || !/\\"\s*:/u.test(literal)) return literal;
    if (depth >= 32) return '"[REDACTED]';
    let decoded;
    try {
      let slashes = 0;
      while (literal[literal.length - slashes - 1] === "\\") slashes++;
      decoded = JSON.parse(literal + (slashes % 2 ? '\\' : '') + '"');
    } catch {
      return '"[REDACTED]';
    }
    const safe = redactTask(decoded, depth + 1);
    return safe === decoded ? literal : JSON.stringify(safe).slice(0, -1);
  });
}

function advance(text, index, points) {
  while (points > 0 && index < text.length) {
    index += text.codePointAt(index) > 0xffff ? 2 : 1;
    points--;
  }
  return index;
}

function pointCount(text, from, to) {
  let count = 0;
  while (from < to) {
    from += text.codePointAt(from) > 0xffff ? 2 : 1;
    count++;
  }
  return count;
}

// Offset and limit address Unicode code points in the complete redacted task.
// A supplied query anchors the page at its first literal match at/after offset.
export function readCurrentTaskWindow(state, value) {
  let args;
  try { args = parseArguments(value); } catch { return { ok: false, error: "invalid_arguments" }; }
  const source = verifiedTask(state);
  if (!source) return { ok: false, error: "unavailable" };
  if (!source.texts.view) {
    try {
      const text = redactTask(source.texts.task);
      source.texts.view = { text, totalLength: pointCount(text, 0, text.length) };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  }
  const { text, totalLength } = source.texts.view;
  if (args.offset > totalLength) return { ok: false, error: "offset_out_of_range" };
  const from = advance(text, 0, args.offset);
  const match = args.query === undefined ? from : text.indexOf(args.query, from);
  if (match < 0) return { ok: false, error: "not_found" };
  const start = args.offset + pointCount(text, from, match);
  const end = advance(text, match, args.limit);
  return {
    ok: true, source: "original_user_task", ...source.lineage,
    excerpt: text.slice(match, end), start,
    nextOffset: end === text.length ? null : start + args.limit,
    totalLength,
  };
}
