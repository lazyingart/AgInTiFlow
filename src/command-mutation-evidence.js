import { types } from "node:util";

export const COMMAND_MUTATION_EVIDENCE_GUIDANCE = "Mutation revisions and command sequences are verification-invalidation counters, not evidence that a file was written. Git status and declared-output observations are partial: ignored, transient and outside-workspace changes can be missed. Do not infer either a write or an unchanged workspace from a counter or missing path delta, including legacy mutationObservationComplete fields. Report observed command outcomes separately from any unverified file-change hypothesis.";

// Presentation and verification coverage, never filesystem authority, write
// permission, or a whole-workspace snapshot. Node/Git cannot provide that here.
const SCOPES = new Set(["git-status", "declared-outputs", "git-status-and-declared-outputs", "unavailable", "not-requested", "legacy-unspecified"]);
const KEYS = ["schemaVersion", "scope", "coverage", "revisionMeaning", "revisionAdvanced", "revisionBasis", "observedPathCount", "workspaceUnchanged"];
const BASIS = new Set(["observed-path-delta", "conservative-command-capability", "unobserved-mutation-risk", "not-advanced", "legacy-unspecified"]);
const descriptors = Object.getOwnPropertyDescriptors, prototype = Object.getPrototypeOf, ownKeys = Reflect.ownKeys;
function field(value, name, fallback) {
  const d = Object.getOwnPropertyDescriptor(value, name);
  return !d ? fallback : d.enumerable && "value" in d && d.value !== undefined ? d.value : NaN;
}
function data(value, keys) {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(prototype(value))) return null;
  const fields = descriptors(value), names = ownKeys(fields);
  if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k) || !fields[k].enumerable || !("value" in fields[k]))) return null;
  return Object.fromEntries(keys.map(k => [k, fields[k].value]));
}
function coverage(scope) {
  return scope === "legacy-unspecified" ? "unknown" : scope === "unavailable" ? "unavailable" : scope === "not-requested" ? "not-requested" : "partial";
}
const legacy = () => Object.freeze({ schemaVersion: 1, scope: "legacy-unspecified", coverage: "unknown", revisionMeaning: "verification-invalidation-only",
  revisionAdvanced: null, revisionBasis: "legacy-unspecified", observedPathCount: null, workspaceUnchanged: "not-proven" });

export function createCommandMutationEvidence(input) {
  const d = data(input, ["scope", "revisionAdvanced", "observedPathCount", "verificationInvalidated"]);
  if (!d || !SCOPES.has(d.scope) || d.scope === "legacy-unspecified" || typeof d.revisionAdvanced !== "boolean" || typeof d.verificationInvalidated !== "boolean" ||
      !Number.isSafeInteger(d.observedPathCount) || d.observedPathCount < 0 || d.observedPathCount > 64) {
    throw Object.assign(new TypeError("Invalid command mutation coverage."), { code: "COMMAND_MUTATION_EVIDENCE_INVALID" });
  }
  const revisionBasis = d.observedPathCount > 0 ? "observed-path-delta" : d.revisionAdvanced ? "conservative-command-capability" : d.verificationInvalidated ? "unobserved-mutation-risk" : "not-advanced";
  return Object.freeze({ schemaVersion: 1, scope: d.scope, coverage: coverage(d.scope), revisionMeaning: "verification-invalidation-only",
    revisionAdvanced: d.revisionAdvanced, revisionBasis, observedPathCount: d.observedPathCount, workspaceUnchanged: "not-proven" });
}

export function readCommandMutationEvidence(value) {
  const d = data(value, KEYS);
  if (!d || d.schemaVersion !== 1 || !SCOPES.has(d.scope) || d.coverage !== coverage(d.scope) || d.revisionMeaning !== "verification-invalidation-only" ||
      d.workspaceUnchanged !== "not-proven" || !BASIS.has(d.revisionBasis)) return null;
  if (d.scope === "legacy-unspecified") return d.revisionAdvanced === null && d.observedPathCount === null && d.revisionBasis === "legacy-unspecified" ? legacy() : null;
  if (typeof d.revisionAdvanced !== "boolean" || !Number.isSafeInteger(d.observedPathCount) || d.observedPathCount < 0 || d.observedPathCount > 64) return null;
  if (d.revisionBasis !== (d.observedPathCount > 0 ? "observed-path-delta" : d.revisionAdvanced ? "conservative-command-capability" :
      d.revisionBasis === "unobserved-mutation-risk" ? "unobserved-mutation-risk" : "not-advanced")) return null;
  return Object.freeze({ ...d });
}

export function commandMutationEvidenceForPresentation(value) {
  return readCommandMutationEvidence(value) || legacy();
}

export function testCommandSequenceIsCurrent(run = {}, verification = {}) {
  for (const value of [run, verification]) if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(prototype(value))) return false;
  const latest = field(verification, "latestPotentialCommandMutationSequence", 0);
  const current = field(verification, "commandSequence", 0);
  const sequence = field(run, "commandSequence", undefined);
  if (!Number.isSafeInteger(latest) || latest < 0 || !Number.isSafeInteger(current) || current < latest) return false;
  if (sequence === undefined) return latest === 0;
  return Number.isSafeInteger(sequence) && sequence >= latest && sequence <= current;
}

export function commandVerificationSequenceState(value) {
  const fail = () => { throw Object.assign(new Error("Command verification sequence is invalid."), { code: "COMMAND_VERIFICATION_SEQUENCE_INVALID" }); };
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(prototype(value))) return fail();
  const current = field(value, "commandSequence", 0), latest = field(value, "latestPotentialCommandMutationSequence", 0);
  if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(latest) || latest < 0 || latest > current) return fail();
  for (const name of ["commandRuns", "testRuns"]) {
    const records = field(value, name, []);
    if (types.isProxy(records) || !Array.isArray(records) || prototype(records) !== Array.prototype || records.length > 256 || ownKeys(records).length !== records.length + 1) return fail();
    for (let index = 0; index < records.length; index++) {
      const d = Object.getOwnPropertyDescriptor(records, String(index));
      if (!d?.enumerable || !("value" in d)) return fail();
      const run = d.value;
      if (!run || typeof run !== "object" || types.isProxy(run) || ![Object.prototype, null].includes(prototype(run))) return fail();
      const sequence = field(run, "commandSequence", undefined);
      if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > current)) return fail();
    }
  }
  return Object.freeze({ current, latest });
}
