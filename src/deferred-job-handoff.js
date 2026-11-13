import { dataFields, jsonSnapshot } from "./restricted-application-contract.js";

// A deliberately closed fast path, not a general intent classifier. Unknown or
// compound wording keeps the normal tool loop and all completion checks.
export function isLaunchOnlyHandoffGoal(goal) {
  if (typeof goal !== "string" || goal.length > 1000) return false;
  const clauses = goal.trim().split(/[.!?](?:\s+|$)/u).filter(Boolean);
  const first = (clauses.shift() || "").trim()
    .replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, "");
  const launch = /^(?:start|run|launch|put|kick off) (.{1,160}?) (?:in (?:the )?background|as (?:a )?(?:durable )?background job)(?:\s+(?:and|then)\s+(.+))?$/i.exec(first);
  if (!launch || !/^(?:(?:the|this|that|my|our|supplied|provided|existing|long-running|data) ){0,4}(?:export|download|build|test|tests|script|command|job|pipeline|backup|render|analysis|conversion|task)$/i.test(launch[1])) return false;
  if (launch[2] && !/^(?:tell me|show me|give me|return|report)(?: (?:its|the|a|my|saved|durable|job|launch|receipt|id|identifier|status|path|paths|log|logs|where|to|check|it|progress|and|location|can|i|later)){1,24}$/i.test(launch[2])) return false;
  return clauses.every(clause => /^(?:keep (?:the |supplied |existing )?(?:(?:input|inputs|script|scripts|source|sources|file|files|data)(?: and (?:the )?)?)+ (?:as they are|as it is|unchanged)|do not (?:modify|change|edit|touch|restart) (?:the |supplied |existing )?(?:input|inputs|script|scripts|source|sources|file|files|data|job|it)(?: or (?:the )?(?:input|inputs|script|scripts|source|sources|file|files|data|job|it))*)$/i.test(clause.trim()));
}

const fields = ["version", "goalRevision", "goalHash", "mutationRevision", "jobId", "statusPath", "statusMarkdownPath", "stdoutPath", "stderrPath"];
const files = { statusPath: "status.json", statusMarkdownPath: "status.md", stdoutPath: "stdout.log", stderrPath: "stderr.log" };

function validatedReceipt(value) {
  try {
    const r = dataFields(value, fields, fields);
    if (r.version !== 1 || !Number.isSafeInteger(r.goalRevision) || r.goalRevision < 1 ||
        typeof r.goalHash !== "string" || !/^[a-f0-9]{64}$/.test(r.goalHash) ||
        !Number.isSafeInteger(r.mutationRevision) || r.mutationRevision < 0 ||
        typeof r.jobId !== "string" || !/^[A-Za-z0-9_.+-]{8,140}$/.test(r.jobId)) return null;
    for (const [key, file] of Object.entries(files)) if (r[key] !== `.aginti/long-jobs/${r.jobId}/${file}`) return null;
    return Object.freeze({ ...r });
  } catch { return null; }
}

// Called only by the native dispatcher after an acknowledged start_long_job.
// Never recover receipts from arbitrary project files, model text or old events.
export function recordDeferredJobReceipt(state, result) {
  if (result?.ok !== true || result.toolName !== "start_long_job" || result.background !== true || result.deferredVerification !== true) return;
  const goal = state.meta?.goalContract || {};
  const r = validatedReceipt({ version: 1, goalRevision: goal.revision, goalHash: goal.currentHash,
    mutationRevision: state.meta?.projectVerification?.mutationRevision ?? 0, jobId: result.jobId,
    ...Object.fromEntries(Object.keys(files).map(key => [key, result[key]])) });
  if (!r) return;
  const prior = currentDeferredJobReceipts(state);
  // More than one launch never enters the one-job completion fast path.
  state.meta.deferredJobReceipts = [...prior.filter(item => item.jobId !== r.jobId), r].slice(-8);
}

export function currentDeferredJobReceipts(state = {}) {
  const goal = state.meta?.goalContract || {};
  let records;
  try { records = jsonSnapshot(state.meta?.deferredJobReceipts, { maxBytes: 16 * 1024, maxNodes: 128 }); }
  catch { return []; }
  if (!Array.isArray(records) || records.length > 8) return [];
  const validated = records.map(validatedReceipt);
  if (validated.some(r => !r) || new Set(validated.map(r => r.jobId)).size !== validated.length) return [];
  return validated.filter(r => r.goalRevision === goal.revision && r.goalHash === goal.currentHash);
}

export function deferredJobLaunchSummary(receipt) {
  const r = validatedReceipt(receipt);
  return r ? `Background launch confirmed: ${r.jobId}. Status: ${r.statusPath}. Logs: ${r.stdoutPath}, ${r.stderrPath}. Current job state has not been checked; use the status path to see whether it is still running or has finished.` : "";
}

export function launchOnlyHandoffReceipt(state = {}) {
  const records = currentDeferredJobReceipts(state);
  if (records.length !== 1 || !isLaunchOnlyHandoffGoal(state.meta?.goalContract?.activeGoal)) return null;
  return records[0].mutationRevision === (state.meta?.projectVerification?.mutationRevision ?? 0) ? records[0] : null;
}

export function budgetStopWithDeferredReceipts(state = {}) {
  const receipts = currentDeferredJobReceipts(state);
  return receipts.length ? ["Stopped at the step limit before confirming the entire request.", ...receipts.map(deferredJobLaunchSummary), "Resume this session to continue any remaining work; do not launch these jobs again."].join("\n") : "";
}
