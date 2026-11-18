import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { applyContinuationContractTransition, updateGoalContract } from "../src/agent-runner.js";
import { currentTaskWindowAvailable, readCurrentTaskWindow } from "../src/current-task-window.js";
import { captureSessionRuntime } from "../src/session-runtime.js";

const hash = text => createHash("sha256").update(text).digest("hex");
const original = "Produce the original catalogue. " + "Interior catalogue text. ".repeat(100);

// Ask the production updater to initialize its previous goal. The first
// history row is the real initialGoalContract witness, including its hashes.
function initialState(goal = original) {
  const state = { goal, meta: { runtimeConfig: captureSessionRuntime({}) } };
  updateGoalContract(state, "Continue.", { preserveTaskBoundary: true });
  const contract = state.meta.goalContract;
  const initial = contract.history[0];
  Object.assign(contract, { revision: 1, currentRequest: goal.trim(), currentHash: initial.hash,
    currentPreview: initial.preview, taskRelation: "initial", history: [initial] });
  return state;
}

function compacted(goal) {
  const state = initialState(goal);
  state.meta.contextBudget = { compactions: 1, lastCompactedStep: 4 };
  return state;
}

function unavailable(state) {
  assert.equal(currentTaskWindowAvailable(state), false);
  assert.deepEqual(readCurrentTaskWindow(state, {}), { ok: false, error: "unavailable" });
}

test("native preview threshold and current-turn compaction control exposure", () => {
  unavailable(initialState("a".repeat(2000)));
  assert.equal(currentTaskWindowAvailable(initialState("a".repeat(2001))), true);
  const state = compacted("Short current task.");
  assert.equal(currentTaskWindowAvailable(state), true);
  state.meta.contextBudget.lastCompactedStep = 0;
  unavailable(state);
  state.meta.contextBudget.lastCompactedStep = "4";
  unavailable(state);
});

test("only the redacted task defines pagination, limit and length in Unicode code points", () => {
  const task = "📖𐀀e\u0301\r\n測".repeat(311);
  const state = initialState(task);
  const points = Array.from(task);
  assert.deepEqual(readCurrentTaskWindow(state, {}), { ok: true, source: "original_user_task", goalRevision: 1,
    taskBoundaryRevision: 1, activeGoalRevision: 1, excerpt: points.slice(0, 1200).join(""),
    start: 0, nextOffset: 1200, totalLength: points.length });
  const pages = [];
  let offset = 0;
  do {
    const page = readCurrentTaskWindow(state, { offset, limit: 31 });
    assert.equal(page.start, offset);
    assert.equal(page.excerpt.isWellFormed(), true);
    pages.push(page.excerpt);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(pages.join(""), task);
  assert.equal(Array.from(readCurrentTaskWindow(state, { limit: 2000 }).excerpt).length, 2000);
  const eof = readCurrentTaskWindow(state, { offset: points.length });
  assert.deepEqual([eof.start, eof.excerpt, eof.nextOffset], [points.length, "", null]);
  assert.deepEqual(readCurrentTaskWindow(state, { offset: points.length + 1 }), { ok: false, error: "offset_out_of_range" });
});

test("search is literal, case-sensitive and forward from the supplied code-point offset", () => {
  const literal = "[x].*?/";
  const state = compacted("📕" + literal + "🌳" + literal + "\n e\u0301 end");
  for (const [offset, start] of [[0, 1], [1, 1], [2, 9], [9, 9]]) {
    const page = readCurrentTaskWindow(state, { query: literal, offset, limit: 3 });
    assert.deepEqual([page.start, page.nextOffset, page.excerpt], [start, start + 3, "[x]"]);
  }
  for (const args of [{ query: literal, offset: 10 }, { query: "[X]" }, { query: "é" }, { query: "missing" }]) {
    assert.deepEqual(readCurrentTaskWindow(state, args), { ok: false, error: "not_found" });
  }
  assert.equal(readCurrentTaskWindow(state, { query: "\n ", limit: 2 }).excerpt, "\n ");
});

test("full-task credential masking precedes search, offsets, total length and slicing", () => {
  const secret = "DEMO_ONLY_PRIVATE_VALUE";
  const tasks = [
    ['password="' + secret, 'password="[REDACTED]'],
    ["token='" + secret + "\\", "token='[REDACTED]"],
    ['{"pass\\u0077ord":"' + secret + '"}', '{"pass\\u0077ord":"[REDACTED]"}'],
    ["password=" + secret, "password=[REDACTED]"],
    ["Authorization: Bearer\n" + secret, "Authorization: Bearer\n[REDACTED]"],
    [JSON.stringify({ note: JSON.stringify({ token: secret }) }), JSON.stringify({ note: JSON.stringify({ token: "[REDACTED]" }) })],
    ['{"data":"{\\"password\\":\\"' + secret,
      '{"data":"{\\"password\\":\\"[REDACTED]'],
    ['{"data":"{\\"token\\":\\"' + secret + "\\", '{"data":"{\\"token\\":\\"[REDACTED]'],
    ["sk-" + secret + " end", "[REDACTED] end"],
  ];
  for (const [raw, safe] of tasks) {
    const prefix = "/home/owner/project/input.md\r\nC:\\project\\\n📘 ";
    const state = compacted(prefix + raw);
    const expected = Array.from(prefix + safe);
    for (let offset = 0; offset <= expected.length; offset++) {
      const page = readCurrentTaskWindow(state, { offset, limit: 5 });
      assert.equal(page.excerpt, expected.slice(offset, offset + 5).join(""));
      assert.equal(page.totalLength, expected.length);
    }
    for (const query of [secret, "PRIVATE_VALUE"]) {
      assert.deepEqual(readCurrentTaskWindow(state, { query }), { ok: false, error: "not_found" });
    }
  }
});

test("query bounds are UTF-8 bytes and reject invalid Unicode before conversion", () => {
  const state = compacted("📚".repeat(64) + "a".repeat(256));
  for (const query of ["a".repeat(256), "📚".repeat(64)]) assert.equal(readCurrentTaskWindow(state, { query }).ok, true);
  for (const query of ["", "📚".repeat(64) + "a", "a".repeat(257), "\ud800", "\udc00", "a".repeat(1_000_000)]) {
    assert.deepEqual(readCurrentTaskWindow(state, { query }), { ok: false, error: "invalid_arguments" });
  }
});

test("all supplied fields must be own enumerable data of their declared types", () => {
  const state = initialState();
  let calls = 0;
  const trap = () => { calls++; throw new Error("caller hook"); };
  const hooks = { toString: trap, valueOf: trap, [Symbol.toPrimitive]: trap, toJSON: trap };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const invalid = [undefined, null, 0, "", [], new Date(), revoked.proxy, /x/u,
    new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, get: trap, getOwnPropertyDescriptor: trap }),
    Object.create({ get query() { return trap(); } }), Object.create({ path: "elsewhere" }),
    { get query() { return trap(); } }, { get limit() { return trap(); } }, { get path() { return trap(); } },
    Object.defineProperty({}, "offset", { value: 0 }), { [Symbol()]: "" },
    JSON.parse('{"__proto__":{}}'), { constructor: null }, { path: "private.txt" }, { sessionId: "other" }, { regex: true },
    { offset: "1" }, { offset: -1 }, { offset: undefined }, { offset: null }, { offset: Infinity }, { offset: 2 ** 53 },
    { offset: 1.5 }, { offset: hooks }, { offset: 1n }, { limit: -1 }, { limit: 0 }, { limit: 2001 },
    { limit: NaN }, { limit: undefined }, { limit: "1" }, { query: null }, { query: /x/u }, { query: undefined }, { query: hooks }];
  for (const args of invalid) assert.deepEqual(readCurrentTaskWindow(state, args), { ok: false, error: "invalid_arguments" });
  assert.equal(calls, 0);
  assert.equal(readCurrentTaskWindow(state, Object.assign(Object.create(null), { limit: 1 })).ok, true);
});

test("native continuation, active correction and replacement use only their witnessed task boundary", () => {
  const state = initialState();
  applyContinuationContractTransition(state, "Continue from the last checkpoint.");
  assert.equal(readCurrentTaskWindow(state, { limit: 7 }).excerpt, "Produce");
  const correction = "Continue the same task. Replace the original catalogue with a summary.";
  applyContinuationContractTransition(state, correction);
  assert.equal(state.goal, correction);
  applyContinuationContractTransition(state, "Continue.");
  const page = readCurrentTaskWindow(state, { query: "original catalogue", limit: 18 });
  assert.deepEqual([page.source, page.excerpt, page.taskBoundaryRevision, page.activeGoalRevision, page.goalRevision],
    ["original_user_task", "original catalogue", 1, 3, 4]);
  const other = "A separate user request. " + "New material. ".repeat(200);
  applyContinuationContractTransition(state, other);
  assert.deepEqual(readCurrentTaskWindow(state, { query: "original catalogue" }), { ok: false, error: "not_found" });
  const next = readCurrentTaskWindow(state, { limit: 1 });
  assert.deepEqual([next.excerpt, next.taskBoundaryRevision, next.activeGoalRevision, next.goalRevision], ["A", 5, 5, 5]);
});

test("native history rollover still proves the current task", () => {
  const state = initialState();
  for (let i = 0; i < 27; i++) updateGoalContract(state, "Continue.", { preserveTaskBoundary: true });
  assert.equal(state.meta.goalContract.history.length, 24);
  assert.equal(readCurrentTaskWindow(state, { limit: 1 }).goalRevision, 28);
  const other = structuredClone(state);
  other.meta.goalContract.taskGoal += "swapped";
  for (const row of other.meta.goalContract.history) row.taskHash = hash(other.meta.goalContract.taskGoal);
  unavailable(other);
  state.meta.goalContract.history[1].kind = "continuation";
  unavailable(state);
});

test("legacy continuations need an independently verifiable retained boundary", () => {
  const state = initialState();
  const initial = state.meta.goalContract.history[0];
  delete initial.taskHash;
  delete initial.activeHash;
  delete state.meta.goalContract.taskBoundaryRevision;
  applyContinuationContractTransition(state, "Continue.");
  assert.equal(state.meta.goalContract.taskBoundaryRevision, 0);
  assert.equal(readCurrentTaskWindow(state, { limit: 1 }).taskBoundaryRevision, 1);
  initial.hash = hash("different goal");
  unavailable(state);
  state.meta.goalContract.history.shift();
  unavailable(state);
});

test("a valid first new-request revision is accepted when the previous state had no goal", () => {
  const state = { goal: "", meta: {} };
  applyContinuationContractTransition(state, original);
  assert.equal(state.meta.goalContract.taskRelation, "new-request");
  assert.equal(readCurrentTaskWindow(state, { limit: 1 }).goalRevision, 1);
});

test("the helper never reads messages, chat, other sessions, entries or historical preview bodies", () => {
  const state = initialState("  " + original + "  ");
  const trap = () => { throw new Error("out-of-scope read"); };
  for (const key of ["messages", "chat", "sessions", "entries", "plan"]) Object.defineProperty(state, key, { get: trap });
  const contract = state.meta.goalContract;
  Object.defineProperty(contract, "currentPreview", { get: trap });
  Object.defineProperty(contract.history[0], "preview", { get: trap });
  assert.equal(readCurrentTaskWindow(state, { limit: 7 }).excerpt, "Produce");
  delete contract.taskGoal;
  unavailable(state);
});

test("cached content cannot authorize a stale, inconsistent or unverified goal revision", () => {
  const mutations = [
    (s, c) => { c.taskGoal = "unrelated".repeat(300); }, (s, c) => { c.currentHash = hash("other"); },
    (s, c) => { c.currentRequest = "assistant output"; }, (s, c) => { c.activeGoal = "Continue."; },
    s => { s.goal = "a different session goal"; }, (s, c) => { c.status = "completed"; },
    (s, c) => { c.activeGoalRevision = c.revision + 1; }, (s, c) => { c.taskBoundaryRevision = c.revision; },
    (s, c) => { c.taskRelation = "new-request"; }, (s, c) => { c.revision++; },
    (s, c) => { c.history.at(-1).activeHash = hash("other"); }, (s, c) => { c.history.at(-1).taskHash = hash("other"); },
    (s, c) => { c.history.at(-1).hash = hash("other"); }, (s, c) => { c.history.at(-1).revision--; },
    (s, c) => { c.history.shift(); }, (s, c) => { c.history.reverse(); }, (s, c) => { c.history = []; },
    (s, c) => { c.taskGoal = "\ud800" + c.taskGoal; }, (s, c) => { c.version = 2; },
  ];
  for (const mutate of mutations) {
    const state = initialState();
    applyContinuationContractTransition(state, "Continue.");
    assert.equal(readCurrentTaskWindow(state, { limit: 1 }).ok, true);
    mutate(state, state.meta.goalContract);
    unavailable(state);
  }
});

test("current state accessors, proxies and prototype-held fields never supply text or invoke hooks", () => {
  let calls = 0;
  const trap = () => { calls++; throw Error("state hook"); };
  for (const corrupt of [
    s => Object.defineProperty(s, "goal", { get: trap }),
    s => Object.defineProperty(s.meta, "goalContract", { get: trap }),
    s => Object.defineProperty(s.meta.goalContract, "taskGoal", { get: trap }),
    s => { s.meta.goalContract.taskGoal = { toString: trap }; },
    s => { s.meta.goalContract.history = new Proxy([], { get: trap, getPrototypeOf: trap }); },
    s => Object.defineProperty(s.meta.goalContract.history, "0", { get: trap }),
    s => { s.meta.goalContract = Object.create(s.meta.goalContract); },
  ]) {
    const state = initialState();
    corrupt(state);
    unavailable(state);
  }
  assert.equal(calls, 0);
});

test("native snapshots omit integration markers, explicit partial markers deny even a previously read task", () => {
  const keys = ["integrationSessionProfile", "integrationAllowedToolNames", "integrationPolicyLock",
    "integrationPolicyFingerprint", "integrationRuntimeRootsDigest", "expectedIntegrationRuntimeRevision"];
  const runtime = captureSessionRuntime(Object.fromEntries(keys.map(key => [key, null])));
  assert.equal(keys.some(key => Object.hasOwn(runtime, key)), false);
  for (const key of keys) {
    for (const location of ["meta", "runtimeConfig"]) {
      const state = initialState();
      assert.equal(readCurrentTaskWindow(state, { limit: 1 }).ok, true);
      (location === "meta" ? state.meta : state.meta.runtimeConfig)[key] = null;
      unavailable(state);
    }
  }
  for (const fields of [{ schemaVersion: "aginti-restricted-application-v1" }, { toolNamespace: "app" },
    { restrictedApplication: true }, { hostManagedResponseOnly: true }]) {
    const state = initialState();
    assert.equal(currentTaskWindowAvailable(state), true);
    Object.assign(state, fields);
    unavailable(state);
  }
  for (const key of ["responseOnly", "savedResultAnswerOnly"]) {
    const state = initialState();
    state.meta.runtimeConfig[key] = true;
    unavailable(state);
  }
});

test("host response-only scopes in a task or a later active correction deny recall", () => {
  for (const mode of ["chat-response", "host-managed-response", "plan-response", "read-only-answer"]) {
    const scope = '\nAGINTI_EVIDENCE_SCOPE_JSON: ' + JSON.stringify({ mode });
    unavailable(initialState(original + scope));
    const state = initialState();
    assert.equal(readCurrentTaskWindow(state, {}).ok, true);
    applyContinuationContractTransition(state, "Continue the same task. Write a reply." + scope);
    unavailable(state);
  }
});

test("in-place contract replacement and independent sessions never reuse a cached excerpt", () => {
  const state = initialState();
  const first = readCurrentTaskWindow(state, { limit: 7 });
  const other = initialState("Another native task. " + "A".repeat(2200));
  const second = readCurrentTaskWindow(other, { limit: 7 });
  assert.notEqual(first.excerpt, second.excerpt);
  Object.assign(state.meta.goalContract, other.meta.goalContract);
  unavailable(state);
  state.goal = other.goal;
  assert.deepEqual(readCurrentTaskWindow(state, { limit: 7 }), second);
  const before = structuredClone(state);
  readCurrentTaskWindow(state, {});
  assert.deepEqual(state, before);
});
