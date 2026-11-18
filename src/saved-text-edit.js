import { createHash } from "node:crypto";
import { currentGoalRevisionBelongsToActiveTask } from "./goal-intent.js";
import { isSensitiveWorkspacePath } from "./workspace-read-boundary.js";

const digest = text => createHash("sha256").update(text).digest("hex");
const sha256 = /^[a-f0-9]{64}$/u;

// Both instructions must have a closed interpretation. A byte check cannot
// demonstrate that a program works, a subtitle renders, or tests have passed.
function requestsReadback(text) {
  if (typeof text !== "string" || text.length > 512) return false;
  return /^(?:continue[.,!]\s*)?(?:please\s+)?(?:verify|check|confirm|read back)\s+(?:the|that|this|my|your)\s+(?:(?:saved|last|latest|previous|text|wording)\s+)*(?:edit|change|correction)(?:\s*(?:,?\s*and|then)\s+(?:tell me|report|summarize|describe)\s+(?:what changed|the change|the result))?[.!?]?$/iu.test(text.trim()) ||
    /^(?:继续[。，、]?\s*)?(?:请)?(?:核对|检查|确认|验证)(?:一下)?(?:刚才|上次|已保存|保存|刚保存)的(?:文字)?(?:修改|改动|更正)(?:[，、]?(?:并)?(?:告诉我|说明)(?:改了什么|修改了什么|结果))?[。！]?$/u.test(text.trim()) ||
    /^(?:保存した|先ほどの|前回の)(?:文章の)?(?:修正|変更)(?:内容)?を確認して(?:ください)?(?:[、，]どこを変えたか教えてください)?[。！]?$/u.test(text.trim());
}

// Keep clauses outside the two quoted operands visible to the anchored grammar.
// The native patch can include surrounding text for a unique match.
function requestedLiteralEdit(goal, path) {
  if (typeof goal !== "string" || goal.length > 4096 || /[\x00-\x08]/u.test(goal)) return null;
  const operands = [];
  const words = goal.replace(/“([^”\n]+)”|「([^」\n]+)」|‘([^’\n]+)’|"([^"\n]+)"|`([^`\n]+)`|'([^'\n]+)'/gu,
    (match, ...groups) => {
      const value = groups.slice(0, 6).find(v => v !== undefined);
      if (value === path) return "\x03";
      operands.push(value);
      if (operands.length === 1) return "\x01";
      if (operands.length === 2) return "\x02";
      return match;
    }).split(path).join("\x03").trim();
  const edit = /^(?:please\s+)?(?:(?:change|correct|fix|replace|update)\s+\x01\s+(?:to|with)\s+\x02\s+in\s+\x03|in\s+\x03[,，]?\s+(?:change|correct|fix|replace|update)\s+\x01\s+(?:to|with)\s+\x02)(?:[.,;]\s*(?:keep|leave)\s+(?:(?:the|and|all|other|everything|else|rest|contents?|text|lines?|subtitles?|timestamps?|timings?|formatting|line breaks)\s+)+(?:otherwise\s+)?(?:unchanged|intact))?[.!]?$/iu;
  const matches = edit.test(words) ||
    /^(?:请)?(?:把|将)\s*\x03\s*(?:中|里)的\s*\x01\s*(?:改为|改成|替换为)\s*\x02(?:[，。]\s*(?:其余|其他)(?:内容)?(?:保持)?不变)?[。！]?$/u.test(words) ||
    /^\x03\s*の\s*\x01\s*を\s*\x02\s*に(?:変更|修正|置換)して(?:ください)?(?:[。、]他はそのまま(?:で)?)?[。！]?$/u.test(words);
  return matches && operands.length === 2 && operands[0] !== operands[1]
    ? { search: operands[0], replace: operands[1] } : null;
}

// Used on both sides of the continuation transition. Resolve what "the
// saved correction" refers to before resetting any per-goal evidence.
function retainedLiteralEdit(state, request) {
  if (!requestsReadback(request)) return null;
  const goal = state.meta?.goalContract, verification = state.meta?.projectVerification;
  const mutation = verification?.lastMutation, patch = mutation?.patch;
  if (!goal || !patch || mutation.toolName !== "apply_patch" || mutation.revision !== verification.mutationRevision ||
      !Number.isSafeInteger(mutation.revision) || mutation.revision < 1 ||
      !Array.isArray(mutation.paths) || mutation.paths.length !== 1 || mutation.paths[0] !== patch.path ||
      typeof patch.path !== "string" || !/\.(?:txt|md|markdown|rst|adoc|srt|vtt|lrc)$/iu.test(patch.path) ||
      /[\\:\x00-\x1f]/u.test(patch.path) || patch.path.split("/").some(segment => !segment || segment === "." || segment === "..") ||
      isSensitiveWorkspacePath(patch.path)) return null;
  if (![patch.searchHash, patch.replaceHash, patch.beforeContentSha256, patch.afterContentSha256].every(
    h => typeof h === "string" && sha256.test(h)) || patch.searchHash === patch.replaceHash ||
      patch.beforeContentSha256 === patch.afterContentSha256 || !requestedLiteralEdit(goal.taskGoal, patch.path)) return null;
  if (mutation.taskHash !== digest(goal.taskGoal) || mutation.goalRevision !== goal.taskBoundaryRevision ||
      !Array.isArray(goal.history) || !currentGoalRevisionBelongsToActiveTask(state, mutation)) return null;
  const mutations = verification.mutationHistory;
  if (!Array.isArray(mutations) || !mutations.every(m => Number.isSafeInteger(m?.goalRevision)) ||
      mutations.filter(m => m.goalRevision >= mutation.goalRevision).length !== 1) return null;
  const recorded = mutations.at(-1);
  if (recorded?.revision !== mutation.revision || recorded.taskHash !== mutation.taskHash ||
      recorded.goalRevision !== mutation.goalRevision || recorded.patch?.afterContentSha256 !== patch.afterContentSha256 ||
      (mutation.revision > 1 && mutations.at(-2)?.revision !== mutation.revision - 1)) return null;
  return mutation;
}

export function refersToSavedTextEdit(state, request) {
  return Boolean(retainedLiteralEdit(state, request));
}

export function savedTextEditReadback(state, request) {
  const mutation = retainedLiteralEdit(state, request);
  if (!mutation) return null;
  const goal = state.meta.goalContract, patch = mutation.patch;
  if (!Number.isSafeInteger(goal.revision) || goal.activeGoalRevision !== goal.revision ||
      goal.taskRelation !== "same-task" || goal.activeGoal !== request || goal.currentRequest !== request ||
      mutation.goalRevision >= goal.revision) return null;
  // An earlier follow-up can add a real build/test requirement. Never infer
  // that requirement away from a truncated or missing historical preview.
  const history = goal.history.filter(e => e?.revision > mutation.goalRevision && e.revision <= goal.revision);
  if (history.length !== goal.revision - mutation.goalRevision || !history.every((e, index) =>
    e.revision === mutation.goalRevision + index + 1 && e.taskHash === mutation.taskHash &&
    typeof e.preview === "string" && digest(e.preview) === e.hash && requestsReadback(e.preview))) return null;
  return { path: patch.path, taskHash: mutation.taskHash, searchHash: patch.searchHash, replaceHash: patch.replaceHash,
    before: patch.beforeContentSha256, after: patch.afterContentSha256,
    patchRevision: mutation.revision, patchGoal: mutation.goalRevision, readGoal: goal.revision };
}

function matchesRequestedReplacement(args, edit) {
  if (digest(edit.search) === args.searchHash && digest(edit.replace) === args.replaceHash) return true;
  const { search, replace } = args;
  if (typeof search !== "string" || typeof replace !== "string" || search.length > 220000 || replace.length > 220000 ||
      digest(search) !== args.searchHash || digest(replace) !== args.replaceHash) return false;
  const index = search.indexOf(edit.search);
  return index >= 0 && search.indexOf(edit.search, index + 1) === -1 &&
    replace === search.slice(0, index) + edit.replace + search.slice(index + edit.search.length);
}

export function hasSavedEditReadbackEvents(proof, events, state) {
  const taskGoal = state?.meta?.goalContract?.taskGoal;
  if (typeof taskGoal !== "string" || digest(taskGoal) !== proof.taskHash) return false;
  const edit = requestedLiteralEdit(taskGoal, proof.path);
  if (!edit) return false;
  let published = false, confirmed = false;
  for (const event of events) {
    if (event?.type !== "tool.completed") continue;
    const d = event.data;
    if (d?.path !== proof.path) continue;
    if (d.toolName === "apply_patch" || d.toolName === "write_file") {
      published = d.ok === true && d.toolName === "apply_patch" && d.goalRevision === proof.patchGoal &&
        d.projectMutationRevision === proof.patchRevision && d.change?.beforeHash === proof.before &&
        d.change?.afterHash === proof.after && d.change?.replacements === 1 && d.change?.created === false &&
        d.change?.ok === true && d.change.path === proof.path && d.args?.path === proof.path &&
        d.args.searchHash === proof.searchHash && d.args.replaceHash === proof.replaceHash &&
        matchesRequestedReplacement(d.args, edit);
      confirmed = false;
    } else if (d.toolName === "read_file" && d.goalRevision === proof.readGoal) {
      confirmed = published && d.ok === true && !d.blocked && !d.skipped && d.sha256 === proof.after &&
        d.args?.path === proof.path && d.startLine === 1 && (d.args.startLine ?? 1) === 1 &&
        d.contentTruncatedByLines === false && d.contentTruncated === false && typeof d.content === "string";
    }
  }
  return confirmed;
}
