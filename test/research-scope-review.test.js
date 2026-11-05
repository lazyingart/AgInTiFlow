import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deepResearch } from "../src/deep-research.js";
import { SessionStore } from "../src/session-store.js";
import { buildResearchScopeReviewPlan, validateResearchScopeReview } from "../src/research-scope-review.js";
import { researchScopeApproval } from "./fixtures/research-scope-review.js";
import { runAgent, rememberCompletedDeepResearch, completedDeepResearchReuse, retainedReadOnlyResearchAnswer, nextStepRuntimeConfig } from "../src/agent-runner.js";
import { RESEARCH_VERSION } from "../src/deep-research.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { flushHousekeeping } from "../src/housekeeping.js";

const question = "What's the retry rule for read requests? Read the document and keep its limits.";
const source = "Archived projects\n\nFor archived projects only, read requests never require retries.\n\nActive projects\n\nFor active projects, callers must retry a read when it overlaps an update.";
const quote = "read requests never require retries.";
const incorrect = "Read requests never require retries in any project.";
const correct = "For archived projects only, read requests never require retries.";
// Actual installed354 native fingerprint captured before this policy existed.
const legacyFingerprint = "9cbc386287f8eabe91a272559ea1b8ca23cfba7271557f7dfcc7cd6bcf179ed0";
const completion = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const homes = new WeakMap();

function report(claim, paragraphs = 1) {
  return { title: "Read request rules", executiveSummary: claim, executiveSummaryEvidenceIds: ["S1-C1"],
    sections: [{ heading: "Finding", paragraphs: Array.from({ length: paragraphs }, () => ({ text: claim, evidenceIds: ["S1-C1"] })) }],
    keyFindings: [{ claim, evidenceIds: ["S1-C1"], confidence: "high" }],
    recommendations: [], contradictions: [], uncertainties: [], nextQuestions: [] };
}

async function fixture(t, options = {}) {
  let scope = homes.get(t);
  if (!scope) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-research-scope-home-"));
    const previous = process.env.AGINTIFLOW_HOME;
    process.env.AGINTIFLOW_HOME = path.join(home, "home");
    scope = { roots: [home] };
    homes.set(t, scope);
    t.after(async () => {
      try {
        await flushHousekeeping();
        for (const root of scope.roots) await fs.rm(root, { recursive: true, force: true });
      } finally {
        if (previous === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = previous;
      }
    });
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-research-scope-"));
  scope.roots.push(root);
  const store = new SessionStore(path.join(root, "sessions"), "scope-contract");
  const counts = { plan: 0, extract: 0, synthesize: 0, review: 0, source: 0 };
  const observed = [];
  const original = options.source || source;
  const selectedQuote = options.quote || quote;
  const originalClaim = options.initialClaim || incorrect;
  const fixedClaim = options.repairedClaim || correct;
  const config = { provider: "deepseek", model: "scripted-parent", routeProvider: "deepseek", routeModel: "scripted-flash", mainProvider: "deepseek", mainModel: "scripted-pro",
    apiKey: "scripted-test-only", commandCwd: root, goal: question, allowedDomains: ["docs.example.org"],
    jsonClientFactory: () => ({ chat: { completions: { create: async body => {
      assert.equal(body.tools, undefined, "source review acquired tool authority");
      const input = JSON.parse(body.messages[1].content);
      observed.push({ input, model: body.model, responseFormat: body.response_format });
      if (/research plan/i.test(input.task)) {
        counts.plan++;
        return completion({ objective: question, sourcePolicy: "primary", subquestions: [{ id: "retry", question: "What is the rule and its scope?", query: "read retry documentation" }],
          queries: ["read retry documentation"], sourceTypes: ["official documentation"], exclusions: [] });
      }
      if (/Extract only source-grounded evidence/i.test(input.task)) {
        counts.extract++;
        const row = JSON.parse(input.input);
        return completion({ sourceId: row.sourceId, relevant: true, summary: originalClaim, relevantQuestionIds: ["retry"],
          claims: [{ claim: originalClaim, quote: selectedQuote, confidence: "high" }], limitations: [] });
      }
      if (/Synthesize a source-grounded/i.test(input.task)) {
        counts.synthesize++;
        if (options.emptySpare && counts.synthesize > 1) return { choices: [{ message: { content: "" } }] };
        if (counts.synthesize > 1 && !options.allowSynthesisRetry) {
          assert.ok(input.input.scopeFeedback?.statements?.length, "repair lost exact statement mapping");
          assert.ok(input.instructions.includes("generic disclaimer"));
        }
        const output = counts.synthesize === 1 ? options.initialReport : options.repairedReport;
        return completion(output || report(counts.synthesize === 1 ? originalClaim : fixedClaim, options.paragraphs || 1));
      }
      if (input.task === "Assess research statements against retained source context.") {
        counts.review++;
        assert.equal(body.model, "scripted-pro");
        assert.equal(body.response_format, undefined, "review unexpectedly enabled format retries");
        assert.equal(input.input.sources[0]?.retainedText, original);
        assert.equal(input.input.sources[0]?.retainedTextOnly, true);
        assert.ok(input.instructions.includes("Never return supported for an uncited row"));
        for (const row of input.input.statements) assert.equal(row.allowedVerdicts.includes("supported"), row.evidenceIds.length > 0);
        let decision = researchScopeApproval(input);
        for (let index = 0; index < decision.decisions.length; index++) {
          const statement = input.input.statements[index];
          if (statement.evidenceIds.length && (options.isUnsupported ? options.isUnsupported(statement.text) : statement.text === incorrect)) decision.decisions[index] = {
            statementId: statement.statementId, verdict: "unsupported", reason: options.rejectionReason || "dropped_scope",
            supportingQuotes: [{ sourceId: "S1", quote: options.scopeQuote || correct }],
          };
        }
        if (typeof options.review === "function") decision = await options.review({ input, decision, counts });
        return completion(decision);
      }
      throw new Error("Unexpected research phase");
    } } } }),
    webSearchImpl: async () => ({ ok: true, provider: "fixture", results: [{ rank: 1, title: "Official read retry rules",
      url: "https://docs.example.org/retry", canonicalUrl: "https://docs.example.org/retry", domain: "docs.example.org", snippet: "Retry rules for archived and active projects." }] }),
    webPageReaderImpl: async ({ url }) => {
      counts.source++;
      return { ok: true, url, title: "Official read retry rules", readable: true, contentType: "text/plain", truncated: options.readerTruncated === true,
        retrievedAt: "2026-11-05T00:00:00Z", sha256: "a".repeat(64), content: original, passages: [original] };
    },
  };
  Object.assign(config, options.configOverrides || {});
  const args = { query: question, depth: "quick", maxQueries: 1, maxSources: 2, sourcePolicy: "primary", researchId: "scope-contract" };
  const execute = () => deepResearch(args, config, store);
  const file = path.join(store.artifactsDir, "deep-research-scope-contract.json");
  const markdown = path.join(store.artifactsDir, "deep-research-scope-contract.md");
  const result = options.defer ? null : await execute();
  const state = options.defer ? null : JSON.parse(await fs.readFile(file, "utf8"));
  return { root, store, counts, observed, config, args, result, state, file, markdown, execute };
}

test("conditional native research gets one bounded repair with complete retained source context", async t => {
  const run = await fixture(t);
  assert.equal(run.result.ok, true, run.result.error);
  assert.equal(run.result.answer, correct);
  assert.equal(run.result.scopeReview.status, "passed");
  assert.equal(run.result.scopeReview.repairAttempted, true);
  assert.deepEqual(run.counts, { plan: 1, extract: 1, synthesize: 2, review: 2, source: 1 });
  assert.equal(run.state.evidence[0].claims[0].interpretationStatus, "unreviewed_extraction");
  assert.equal(run.state.audit.assessmentKind, "citation_linkage_only");
  const markdown = await fs.readFile(run.markdown, "utf8");
  assert.ok(markdown.includes(correct));
  assert.ok(!markdown.includes(incorrect));
  const previous = run.observed.filter(row => /Synthesize a source-grounded/.test(row.input.task))[1].input.input.scopeFeedback.previousReport;
  assert.equal(Object.hasOwn(previous, "executiveSummarySourceIds"), false);
  assert.equal(Object.hasOwn(previous.sections[0].paragraphs[0], "sourceIds"), false);
  assert.equal(Object.hasOwn(previous.keyFindings[0], "sourceIds"), false);
});

test("an unsafe replacement cannot finish or expose candidate answer/report", async t => {
  const run = await fixture(t, { repairedClaim: incorrect });
  assert.equal(run.result.ok, false);
  assert.equal(run.result.answer, "");
  assert.equal(run.result.reportPath, "");
  assert.equal(run.result.scopeReview.status, "rejected");
  assert.equal(run.counts.synthesize, 2);
  assert.equal(run.counts.review, 1, "unchanged known rejection should not spend another assessment call");
  await assert.rejects(fs.readFile(run.markdown), { code: "ENOENT" });
  const counts = { ...run.counts };
  const repeated = await run.execute();
  assert.equal(repeated.ok, false);
  assert.equal(repeated.cached, true);
  assert.deepEqual(run.counts, counts);
});

test("supported normal research needs one review and no replacement", async t => {
  const run = await fixture(t, { initialClaim: correct });
  assert.equal(run.result.ok, true, run.result.error);
  assert.equal(run.result.scopeReview.repairAttempted, false);
  assert.deepEqual(run.counts, { plan: 1, extract: 1, synthesize: 1, review: 1, source: 1 });
});

test("structured research notes retain exact evidence IDs through audit, assessment and rendering", async t => {
  const model = report(correct);
  model.contradictions = [{ text: correct, evidenceIds: ["S1-C1"] }];
  model.uncertainties = [{ text: correct, evidenceIds: ["S1-C1"] }];
  model.nextQuestions = [{ text: "Which conditions need further research?", evidenceIds: [] }];
  const run = await fixture(t, { initialClaim: correct, initialReport: model });
  assert.equal(run.result.ok, true, run.result.error);
  for (const field of ["contradictions", "uncertainties"]) {
    assert.deepEqual(run.state.synthesis[field][0].evidenceIds, ["S1-C1"]);
    assert.deepEqual(run.state.synthesis[field][0].sourceIds, ["S1"]);
  }
  const rows = run.observed.find(row => row.input.task === "Assess research statements against retained source context.").input.input.statements;
  const notes = rows.filter(row => row.kind === "note");
  assert.deepEqual(notes.map(row => row.evidenceIds), [["S1-C1"], ["S1-C1"], []]);
  const markdown = await fs.readFile(run.markdown, "utf8");
  assert.match(markdown, /## Contradictions\n\n- For archived projects only, read requests never require retries\. \[S1\]/);
  assert.match(markdown, /## Open Questions\n\n- Which conditions need further research\?/);
  const counts = { ...run.counts }, state = await fs.readFile(run.file);
  const cached = await deepResearch(run.args, run.config, new SessionStore(path.join(run.root, "sessions"), "scope-contract"));
  assert.equal(cached.ok, true, cached.error);
  assert.equal(cached.cached, true);
  assert.deepEqual(run.counts, counts);
  assert.deepEqual(await fs.readFile(run.file), state);
  assert.equal(await fs.readFile(run.markdown, "utf8"), markdown);
});

test("requested exact quotes reach the parent answer and cache without another research pass", async t => {
  const run = await fixture(t, { initialClaim: correct, configOverrides: { goal: `${question} Include an exact quote.` } });
  assert.equal(run.result.ok, true, run.result.error);
  assert.ok(run.result.answer.startsWith(correct));
  assert.ok(run.result.answer.includes(`“${quote}” [S1]`));
  const counts = { ...run.counts }, bytes = await fs.readFile(run.file);
  const cached = await deepResearch(run.args, run.config, new SessionStore(path.join(run.root, "sessions"), "scope-contract"));
  assert.equal(cached.ok, true, cached.error);
  assert.equal(cached.answer, run.result.answer);
  assert.deepEqual(run.counts, counts);
  assert.deepEqual(await fs.readFile(run.file), bytes);
  const state = { goal: run.config.goal, meta: { goalContract: { currentHash: "quoted-answer" } } };
  rememberCompletedDeepResearch(state, run.args, run.config, run.result);
  assert.equal(completedDeepResearchReuse(state, run.args, run.config).answer, run.result.answer);
  assert.equal(retainedReadOnlyResearchAnswer(run.config, state).answer, run.result.answer);
  assert.equal(nextStepRuntimeConfig(run.config, state).nativeResearchCompletionPending, true);
});

test("canonical research completion rejects stale, altered, incomplete and compound work", async t => {
  const run = await fixture(t, { initialClaim: correct, configOverrides: { goal: `${question} Include an exact quote.` } });
  const initial = { goal: run.config.goal, meta: { goalContract: { currentHash: "canonical-research" } } };
  rememberCompletedDeepResearch(initial, run.args, run.config, run.result);
  for (const mutate of [
    state => { state.meta.completedDeepResearch[0].goalKey = "foreign"; },
    state => { state.meta.goalContract.currentHash = "new-goal"; },
    state => { state.meta.completedDeepResearch.push(structuredClone(state.meta.completedDeepResearch[0])); },
    state => { state.meta.completedDeepResearch[0].result.answer += "An unassessed assertion."; },
    state => { delete state.meta.completedDeepResearch[0].result.answerDigest; },
    state => { state.meta.completedDeepResearch[0].result.scopeReview.status = "rejected"; },
    state => { state.meta.completedDeepResearch[0].result.evidenceAppendixRequested = false; },
    state => { state.meta.completedDeepResearch[0].result.coverage.missingQuestions.push({ question: "Unresolved required scope" }); },
    state => { state.meta.completedDeepResearch[0].result.coverage.verifiedClaimCount = 0; },
    state => { state.meta.completedDeepResearch[0].result.reportPath = path.join(run.root, "absent.md"); },
    state => { state.meta.artifactProgress = {}; },
  ]) {
    const state = structuredClone(initial);mutate(state);
    assert.equal(retainedReadOnlyResearchAnswer(run.config, state), null);
  }
  for (const goal of [
    "Do deep research, then write result.md.",
    "Do deep research, then run Python to verify the data.",
    "Do deep research and return JSON only.",
    "Do deep research and return exactly two lines.",
    "Read the current notes/source.md before research.",
  ]) assert.equal(retainedReadOnlyResearchAnswer({ ...run.config, goal }, initial), null, goal);
});

test("failed or dry research cannot expose assessment quotations as an accepted answer", async t => {
  const run = await fixture(t, { repairedClaim: incorrect, configOverrides: { goal: `${question} Include an exact quote.` } });
  assert.equal(run.result.ok, false);
  assert.equal(run.result.answer, "");
  const dry = await deepResearch({ ...run.args, researchId: "dry-quotes", dryRun: true }, run.config, run.store);
  assert.equal(dry.scopeReview.status, "not_performed");
  assert.ok(!dry.answer.includes("Selected exact quotations"));
});

test("reader truncation limitations come from native state without a model claim or repair", async t => {
  for (const truncated of [false, true]) {
    const run = await fixture(t, { initialClaim: correct, readerTruncated: truncated });
    assert.equal(run.result.ok, true, run.result.error);
    assert.equal(run.state.sources[0].readTruncated, truncated);
    const markdown = await fs.readFile(run.markdown, "utf8");
    assert.equal(markdown.includes("Reader retained truncated text for S1; this report is limited to retained evidence."), truncated);
    assert.deepEqual(run.state.synthesis.uncertainties, []);
    assert.equal(run.counts.synthesize, 1);
    assert.equal(run.counts.review, 1);
  }
});

test("a true native reader flag cannot self-authorize an uncited model uncertainty", async t => {
  const model = report(correct);
  model.uncertainties = [{ text: "The reader truncated its retained input.", evidenceIds: [] }];
  const run = await fixture(t, { initialClaim: correct, readerTruncated: true, initialReport: model, repairedReport: model, allowSynthesisRetry: true });
  assert.equal(run.result.ok, false);
  assert.equal(run.result.answer, "");
  assert.equal(run.result.reportPath, "");
  assert.equal(run.counts.review, 0);
});

test("a source citation does not bless unsupported model provenance prose", async t => {
  const model = report(correct), repaired = report(correct);
  const invented = "The reader retained every possible detail without truncation.";
  model.uncertainties = [{ text: invented, evidenceIds: ["S1-C1"] }];
  const run = await fixture(t, { initialClaim: correct, readerTruncated: true, initialReport: model, repairedReport: repaired,
    review: ({ input, decision }) => {
      input.input.statements.forEach((row, index) => {
        if (row.text === invented) decision.decisions[index] = { statementId: row.statementId, verdict: "unsupported", reason: "not_in_source", supportingQuotes: [] };
      });
      return decision;
    } });
  assert.equal(run.result.ok, true, run.result.error);
  assert.equal(run.counts.review, 2);
  const markdown = await fs.readFile(run.markdown, "utf8");
  assert.ok(!markdown.includes(invented));
  assert.ok(markdown.includes("Reader retained truncated text for S1"));
});

test("a same-provider schema retry can bind a missing note citation without approving the invalid report", async t => {
  const initial = report(correct), repaired = report(correct);
  initial.uncertainties = [{ text: correct, evidenceIds: [] }];
  repaired.uncertainties = [{ text: correct, evidenceIds: ["S1-C1"] }];
  const run = await fixture(t, { initialClaim: correct, initialReport: initial, repairedReport: repaired, allowSynthesisRetry: true });
  assert.equal(run.result.ok, true, run.result.error);
  assert.equal(run.counts.synthesize, 2);
  assert.equal(run.counts.review, 1);
  assert.deepEqual(run.state.synthesis.uncertainties[0].evidenceIds, ["S1-C1"]);
  const request = run.observed.filter(row => /Synthesize a source-grounded/.test(row.input.task))[1].input;
  assert.equal(request.json_schema.properties.uncertainties.items.properties.evidenceIds.minItems, 1);
});

test("citation-looking prose cannot authorize an uncited factual research note", async t => {
  const candidate = report(correct);
  candidate.nextQuestions = [{ text: `${correct} [S1-C1]`, evidenceIds: [] }];
  const run = await fixture(t, { initialClaim: correct, initialReport: candidate, repairedReport: candidate,
    review: ({ input, decision }) => {
      input.input.statements.forEach((row, index) => {
        if (row.kind === "note") {
          assert.deepEqual(row.evidenceIds, []);
          assert.deepEqual(row.sourceIds, []);
          decision.decisions[index] = { statementId: row.statementId, verdict: "unsupported", reason: "not_in_source", supportingQuotes: [] };
        }
      });
      return decision;
    } });
  assert.equal(run.result.ok, false);
  assert.equal(run.result.answer, "");
  assert.equal(run.result.reportPath, "");
  assert.equal(run.counts.review, 1);
  assert.equal(run.counts.synthesize, 2);
});

test("unknown evidence on any structured note fails before assessment instead of disappearing", async t => {
  for (const field of ["contradictions", "uncertainties", "nextQuestions"]) {
    const model = report(correct);
    model[field] = [{ text: correct, evidenceIds: ["S1-C999"] }];
    const run = await fixture(t, { initialClaim: correct, initialReport: model });
    assert.equal(run.result.ok, false);
    assert.match(run.result.error, /note cites unknown or unverified evidence/);
    assert.equal(run.counts.review, 0);
    assert.equal(run.result.answer, "");
    assert.equal(run.result.reportPath, "");
  }
});

test("invalid string-note model reports cannot silently complete through deterministic fallback", async t => {
  const model = report(correct);
  model.uncertainties = ["An uncited source assertion must not disappear behind fallback."];
  for (const emptySpare of [false, true]) {
    const run = await fixture(t, { initialClaim: correct, initialReport: model, repairedReport: model, allowSynthesisRetry: true, emptySpare });
    assert.equal(run.result.ok, false);
    assert.match(run.result.error, /synthesis was unavailable or invalid/);
    assert.equal(run.result.answer, "");
    assert.equal(run.result.reportPath, "");
    assert.equal(run.counts.synthesize, 2);
    assert.equal(run.counts.review, 0);
  }
});

test("version15 string-note checkpoints are refused without mutation or model dispatch", async t => {
  const run = await fixture(t, { initialClaim: correct });
  run.state.version = 15;
  run.state.synthesis.uncertainties = [`${correct} [S1-C1]`];
  await fs.writeFile(run.file, JSON.stringify(run.state));
  const before = await fs.readFile(run.file), markdown = await fs.readFile(run.markdown), counts = { ...run.counts };
  const result = await run.execute();
  assert.equal(result.ok, false);
  assert.match(result.error, /older or unsupported schema/);
  assert.deepEqual(run.counts, counts);
  assert.deepEqual(await fs.readFile(run.file), before);
  assert.deepEqual(await fs.readFile(run.markdown), markdown);
});

test("structured note text, ID or source-binding tampering invalidates cached review", async t => {
  for (const mutate of [
    note => { note.text = incorrect; },
    note => { note.evidenceIds = ["S1-C999"]; },
    note => { note.sourceIds = ["S999"]; },
  ]) {
    const model = report(correct);
    model.uncertainties = [{ text: correct, evidenceIds: ["S1-C1"] }];
    const run = await fixture(t, { initialClaim: correct, initialReport: model });
    assert.equal(run.result.ok, true, run.result.error);
    mutate(run.state.synthesis.uncertainties[0]);
    await fs.writeFile(run.file, JSON.stringify(run.state));
    const before = await fs.readFile(run.file), markdown = await fs.readFile(run.markdown), counts = { ...run.counts };
    const result = await run.execute();
    assert.equal(result.ok, false);
    assert.deepEqual(run.counts, counts);
    assert.deepEqual(await fs.readFile(run.file), before);
    assert.deepEqual(await fs.readFile(run.markdown), markdown);
  }
});

test("structured note planner rejects hostile records and arrays before invoking hooks", () => {
  let hooks = 0;
  const options = { query: question, sources: [{ id: "S1", content: source }], evidence: [{ sourceId: "S1", claims: [{ evidenceId: "S1-C1", quote, quoteVerified: true }] }] };
  for (const make of [
    () => new Proxy({}, { get() { hooks++; throw new Error("trap"); } }),
    () => Object.defineProperty({ evidenceIds: [] }, "text", { enumerable: true, get() { hooks++; throw new Error("getter"); } }),
    () => ({ text: correct, evidenceIds: new Proxy([], { get() { hooks++; throw new Error("array trap"); } }) }),
    () => ({ text: correct, evidenceIds: new Array(1) }),
    () => ({ text: correct, evidenceIds: [], [Symbol("extra")]: true }),
    () => ({ text: correct, evidenceIds: [], extra: true }),
    () => ({ text: correct, evidenceIds: [], sourceIds: new Proxy([], { get() { hooks++; throw new Error("source trap"); } }) }),
    () => `${correct} [S1-C1]`,
  ]) {
    const synthesis = report(correct);synthesis.uncertainties = [make()];
    assert.throws(() => buildResearchScopeReviewPlan({ ...options, synthesis }), { code: "DEEP_RESEARCH_SCOPE_REVIEW_INVALID" });
  }
  for (const make of [
    () => new Proxy([], { get() { hooks++; throw new Error("notes trap"); } }),
    () => Object.assign([], { [Symbol.iterator]() { hooks++; throw new Error("iterator"); } }),
    () => new Array(1),
    () => Object.defineProperty([], "0", { enumerable: true, configurable: true, get() { hooks++; throw new Error("row getter"); } }),
  ]) {
    const synthesis = report(correct);synthesis.uncertainties = make();
    assert.throws(() => buildResearchScopeReviewPlan({ ...options, synthesis }), { code: "DEEP_RESEARCH_SCOPE_REVIEW_INVALID" });
  }
  assert.equal(hooks, 0);
});

test("Chinese and Japanese retained context and exact quotes reach the same bounded gate", async t => {
  for (const [original, claim] of [
    ["归档项目\n\n仅对于归档项目，读取操作在此验证条件下不需要重试。\n\n活动项目\n\n活动项目在发生并发更新时必须重新读取。", "仅对于归档项目，读取操作在此验证条件下不需要重试。"],
    ["アーカイブ済みの案件\n\nアーカイブ済みの案件に限り、検証条件内の読み取り操作は再試行を必要としません。\n\n進行中の案件では同時更新時に再試行が必要です。", "アーカイブ済みの案件に限り、検証条件内の読み取り操作は再試行を必要としません。"],
  ]) {
    const model = report(claim);
    model.uncertainties = [{ text: claim, evidenceIds: ["S1-C1"] }];
    const run = await fixture(t, { source: original, quote: claim, initialClaim: claim, initialReport: model });
    assert.equal(run.result.ok, true, run.result.error);
    assert.equal(run.result.answer, claim);
    assert.deepEqual(run.state.synthesis.uncertainties[0].sourceIds, ["S1"]);
  }
});

test("a generic unverified preface never overrides a rejected separate assertion", async t => {
  const run = await fixture(t, { repairedClaim: `Unverified hypothesis. ${incorrect}`, isUnsupported: value => value.includes(incorrect) });
  assert.equal(run.result.ok, false);
  assert.equal(run.result.answer, "");
  assert.equal(run.counts.review, 2);
  assert.equal(run.counts.synthesize, 2);
});

test("multilingual dropped conditions require repair rather than an English-only claim heuristic", async t => {
  for (const [original, quotation, bad, good] of [
    ["归档项目\n\n仅对于归档项目，读取操作在此验证条件下不需要重试。\n\n活动项目并发更新时必须重试。", "仅对于归档项目，读取操作在此验证条件下不需要重试。", "所有项目的读取都不需要重试。", "仅对于归档项目，读取操作在此验证条件下不需要重试。"],
    ["保存済み案件\n\n保存済みの案件に限り、この検証条件では読み取り操作の再試行は必要ありません。\n\n進行中の案件では同時更新時に再試行が必要です。", "保存済みの案件に限り、この検証条件では読み取り操作の再試行は必要ありません。", "すべての案件で読み取りの再試行は必要ありません。", "保存済みの案件に限り、この検証条件では読み取り操作の再試行は必要ありません。"],
  ]) {
    const run = await fixture(t, { source: original, quote: quotation, initialClaim: bad, repairedClaim: good, isUnsupported: value => value === bad, scopeQuote: good });
    assert.equal(run.result.ok, true, run.result.error);
    assert.equal(run.result.answer, good);
    assert.equal(run.counts.review, 2);
    assert.equal(run.counts.synthesize, 2);
  }
});

test("review remains mandatory despite caller-supplied disable/approval flags", async t => {
  const run = await fixture(t, { initialClaim: correct, configOverrides: { deepResearchScopeReview: false, sourceScopeAlreadyVerified: true } });
  assert.equal(run.result.ok, true, run.result.error);
  assert.equal(run.counts.review, 1);
});

test("a quantitative contradiction with an exact quote still needs a corrected report", async t => {
  const original = "The controlled measurement recorded a temperature change of -10 degrees.";
  const bad = "The controlled measurement recorded an increase of 10 degrees.";
  const run = await fixture(t, { source: original, quote: original, initialClaim: bad, repairedClaim: original,
    isUnsupported: value => value === bad, scopeQuote: original, rejectionReason: "contradicted" });
  assert.equal(run.result.ok, true, run.result.error);
  assert.equal(run.result.answer, original);
  assert.equal(run.counts.review, 2);
  assert.equal(run.counts.synthesize, 2);
});

test("cancellation during source assessment cannot return a completed answer or trigger repair", async t => {
  const controller = new AbortController();
  const run = await fixture(t, { initialClaim: correct, configOverrides: { abortSignal: controller.signal }, review: ({ decision }) => {
    controller.abort();
    return decision;
  } });
  assert.equal(run.result.ok, false);
  assert.equal(run.result.answer, "");
  assert.equal(run.result.reportPath, "");
  assert.equal(run.counts.review, 1);
  assert.equal(run.counts.synthesize, 1);
});

test("missing/foreign/duplicate verdicts, wrong digest and unsupported quote cannot grant completion", async t => {
  const attacks = [
    value => { value.decisions.pop(); },
    value => { value.decisions[0].statementId = "foreign"; },
    value => { value.decisions[1].statementId = value.decisions[0].statementId; },
    value => { value.requestDigest = "0".repeat(64); },
    value => { value.extra = true; },
    value => { value.decisions.find(row => row.verdict === "supported").supportingQuotes[0].quote = "This completely different source statement was never in the retained context."; },
    value => { value.decisions.find(row => row.verdict === "supported").supportingQuotes[0].sourceId = "S999"; },
    value => { const row = value.decisions.find(row => row.verdict === "supported"); row.verdict = "not_factual"; row.reason = "not_factual"; row.supportingQuotes = []; },
  ];
  for (const mutate of attacks) {
    const run = await fixture(t, { initialClaim: correct, review: ({ decision }) => { mutate(decision); return decision; } });
    assert.equal(run.result.ok, false);
    assert.equal(run.result.answer, "");
    assert.equal(run.counts.review, 1);
    assert.equal(run.counts.synthesize, 1, "malformed review was treated as legitimate repair advice");
    await assert.rejects(fs.readFile(run.markdown), { code: "ENOENT" });
  }
});

test("fresh SessionStore reuses a bound completed review without model/source work", async t => {
  const run = await fixture(t, { initialClaim: correct });
  const counts = { ...run.counts }, state = await fs.readFile(run.file), markdown = await fs.readFile(run.markdown);
  const result = await deepResearch(run.args, run.config, new SessionStore(path.join(run.root, "sessions"), "scope-contract"));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.cached, true);
  assert.deepEqual(run.counts, counts);
  assert.deepEqual(await fs.readFile(run.file), state);
  assert.deepEqual(await fs.readFile(run.markdown), markdown);
});

test("changed report/source/evidence/assessment cannot be replayed or silently rewritten", async t => {
  for (const mutate of [
    state => { state.synthesis.keyFindings[0].claim = incorrect; },
    state => { state.sources[0].content += "\nThe rules changed."; },
    state => { state.evidence[0].claims[0].quote = "A completely different quote is not in this source text."; },
    state => { delete state.scopeReview; },
    state => { state.scopeReview.batches[0].requestDigest = "0".repeat(64); },
    state => { state.scopeReview.reviewedStatements += 1; },
    state => { state.scopeReview.assessmentKind = "quotation-only"; },
    state => { state.synthesis.keyFindings[0].confidence = "low"; },
  ]) {
    const run = await fixture(t, { initialClaim: correct });
    mutate(run.state);
    await fs.writeFile(run.file, JSON.stringify(run.state));
    const state = await fs.readFile(run.file), markdown = await fs.readFile(run.markdown), counts = { ...run.counts };
    const result = await run.execute();
    assert.equal(result.ok, false);
    assert.match(result.error, /source-scope assessment/);
    assert.deepEqual(run.counts, counts);
    assert.deepEqual(await fs.readFile(run.file), state);
    assert.deepEqual(await fs.readFile(run.markdown), markdown);
  }
});

test("partial review resumes only its unfinished batch after an unavailable assessment", async t => {
  let unavailable = true;
  const run = await fixture(t, { initialClaim: correct, paragraphs: 40, review: ({ input, decision }) => {
    if (unavailable && input.input.statements[0].statementId !== "R1") throw new Error("Synthetic reviewer outage");
    return decision;
  } });
  assert.equal(run.result.ok, false);
  assert.equal(run.state.scopeReview.batches.length, 1);
  const counts = { ...run.counts };
  unavailable = false;
  const result = await deepResearch(run.args, run.config, new SessionStore(path.join(run.root, "sessions"), "scope-contract"));
  assert.equal(result.ok, true, result.error);
  assert.equal(run.counts.review, counts.review + 1);
  for (const key of ["plan", "extract", "synthesize", "source"]) assert.equal(run.counts[key], counts[key]);
});

test("oversized retained context fails before review without silently truncating it", async t => {
  const huge = source + " x".repeat(60_000);
  const run = await fixture(t, { source: huge, initialClaim: correct });
  assert.equal(run.result.ok, false);
  assert.match(run.result.error, /scope-review budget/);
  assert.equal(run.counts.review, 0);
  assert.equal(run.result.answer, "");
});

test("dry/mock checkpoints cannot authorize live research with the same explicit ID", async t => {
  const run = await fixture(t, { defer: true });
  const dry = await deepResearch({ ...run.args, dryRun: true }, run.config, run.store);
  assert.equal(dry.ok, true, dry.error);
  assert.equal(dry.scopeReview.status, "not_performed");
  const before = await fs.readFile(run.file), counts = { ...run.counts };
  const live = await run.execute();
  assert.equal(live.ok, false);
  assert.match(live.error, /different query or research policy/);
  assert.deepEqual(run.counts, counts);
  assert.deepEqual(await fs.readFile(run.file), before);
});

test("legacy quotation-only checkpoints refuse ordinary replay without overwriting evidence", async t => {
  const run = await fixture(t, { initialClaim: correct });
  run.state.fingerprint = legacyFingerprint;
  run.state.version = 14;
  delete run.state.scopeReview;
  run.state.synthesis.executiveSummary = incorrect;
  await fs.writeFile(run.file, JSON.stringify(run.state));
  await fs.writeFile(run.markdown, "Legacy unreviewed report retained for inspection.\n");
  const state = await fs.readFile(run.file), markdown = await fs.readFile(run.markdown), counts = { ...run.counts };
  const result = await run.execute();
  assert.equal(result.ok, false);
  assert.match(result.error, /different query or research policy/);
  assert.deepEqual(run.counts, counts);
  assert.deepEqual(await fs.readFile(run.file), state);
  assert.deepEqual(await fs.readFile(run.markdown), markdown);
});

test("outer-session reuse refuses quotation-only/dry results and preserves current assessment metadata", async t => {
  const run = await fixture(t, { initialClaim: correct });
  const state = { goal: question, meta: { goalContract: { currentHash: "scope-goal" } } };
  for (const result of [
    { ...run.result, version: 14 },
    { ...run.result, scopeReview: undefined },
    { ...run.result, scopeReview: { ...run.result.scopeReview, status: "not_performed" } },
  ]) assert.equal(rememberCompletedDeepResearch(state, run.args, run.config, result), null);
  assert.equal(state.meta.completedDeepResearch, undefined);
  const record = rememberCompletedDeepResearch(state, run.args, run.config, run.result);
  assert.ok(record);
  const reused = completedDeepResearchReuse(JSON.parse(JSON.stringify(state)), run.args, run.config);
  assert.equal(reused.version, RESEARCH_VERSION);
  assert.equal(reused.scopeReview.status, "passed");
  assert.deepEqual(reused.scopeReview, run.result.scopeReview);
  record.result.scopeReview.status = "not_performed";
  assert.equal(completedDeepResearchReuse(state, run.args, run.config), null);
  record.result.scopeReview.status = "passed";
  record.result.answer += "Corrupt cached answer.";
  assert.equal(completedDeepResearchReuse(state, run.args, run.config), null);
});

test("malformed and future checkpoints are preserved without new source/model work", async t => {
  for (const body of ["{not-json", "null", "false", "0", '"checkpoint"', "[]", JSON.stringify({ version: RESEARCH_VERSION + 1, status: "completed" })]) {
    const run = await fixture(t, { initialClaim: correct });
    await fs.writeFile(run.file, body);
    const markdown = await fs.readFile(run.markdown), counts = { ...run.counts };
    const result = await run.execute();
    assert.equal(result.ok, false);
    assert.deepEqual(run.counts, counts);
    assert.equal(await fs.readFile(run.file, "utf8"), body);
    assert.deepEqual(await fs.readFile(run.markdown), markdown);
  }
});

test("context budgets count UTF-8 bytes rather than truncating multibyte source text", () => {
  const options = { query: question, synthesis: report(correct), evidence: [{ sourceId: "S1", claims: [{ evidenceId: "S1-C1", quote, quoteVerified: true }] }] };
  assert.ok(buildResearchScopeReviewPlan({ ...options, sources: [{ id: "S1", content: source + "x".repeat(40_000) }] }).batches.length > 0);
  assert.throws(() => buildResearchScopeReviewPlan({ ...options, sources: [{ id: "S1", content: source + "文".repeat(40_000) }] }), /scope-review budget/);
});

test("persisted runAgent delegates research and finishes only after scoped replacement passes", { timeout: 15_000 }, async t => {
  const initial = report(incorrect), repaired = report(correct);
  initial.uncertainties = [{ text: incorrect, evidenceIds: ["S1-C1"] }];
  repaired.uncertainties = [{ text: correct, evidenceIds: ["S1-C1"] }];
  const run = await fixture(t, { defer: true, initialReport: initial, repairedReport: repaired });
  const workspace = path.join(run.root, "workspace"); await fs.mkdir(workspace);
  const goal = "Please research the read retry rule and keep its conditions clear. Use the approved document. Don't create or modify files.";
  let parentCalls = 0;
  const clientFactory = async () => ({ chat: { completions: { create: async request => {
    parentCalls++;
    const name = parentCalls === 1 ? "deep_research" : "finish";
    const args = parentCalls === 1 ? run.args : { result: correct };
    assert.ok(parentCalls <= 2);
    if (parentCalls === 1) assert.ok(request.tools.some(tool => tool.function.name === "deep_research"), "native research tool was not offered");
    return { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `scope_agent_${parentCalls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
  } } } });
  clientFactory.agintiDeterministicTest = true;
  const config = resolveRuntimeConfig({ goal, provider: "deepseek", model: "scripted-parent", routingMode: "manual", enableScs: "off" }, {
    baseDir: workspace, commandCwd: workspace, sessionId: "scope-agent", clientFactory, sandboxMode: "host",
    allowWebSearch: true, allowedDomains: ["docs.example.org"], allowFileTools: false, allowShellTool: false,
    allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false, allowWrapperTools: false,
  });
  Object.assign(config, run.config, { goal, baseDir: workspace, commandCwd: workspace, sessionId: "scope-agent",
    sessionsDir: path.join(run.root, "sessions"), projectSessionsDir: path.join(run.root, "pointers"),
    clientFactory, scsActive: false, quiet: true, maxSteps: 3, useDockerSandbox: false,
    executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline native source-scope regression." } });
  const result = await runAgent(config);
  assert.notEqual(result.failed, true); assert.notEqual(result.stopped, true);
  assert.equal(result.result, correct);
  assert.equal(parentCalls, 2);
  assert.equal(run.counts.review, 2);
  const session = path.join(run.root, "sessions/scope-agent");
  const state = JSON.parse(await fs.readFile(path.join(session, "artifacts/deep-research-scope-contract.json"), "utf8"));
  assert.equal(state.scopeReview.status, "passed");
  assert.equal(state.synthesis.executiveSummary, correct);
  assert.equal(state.synthesis.uncertainties[0].text, correct);
  assert.deepEqual(state.synthesis.uncertainties[0].sourceIds, ["S1"]);
  const events = (await fs.readFile(path.join(session, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(events.some(event => event.type === "tool.completed" && event.data?.toolName === "deep_research"));
  assert.deepEqual(await fs.readdir(workspace), []);
});

test("strict response validator rejects accessor/proxy/sparse/extended decision data without hooks", () => {
  const model = report(correct);
  model.sections[0].paragraphs[0].sourceIds = ["S1"];
  const plan = buildResearchScopeReviewPlan({ query: question, synthesis: model, sources: [{ id: "S1", content: source }], evidence: [{ sourceId: "S1", claims: [{ evidenceId: "S1-C1", quote, quoteVerified: true }] }] });
  const batch = plan.batches[0];
  const response = () => researchScopeApproval({ task: "Assess research statements against retained source context.", input: { requestDigest: batch.requestDigest, ...batch.payload } });
  let hooks = 0;
  for (const make of [
    () => new Proxy(response(), { get() { hooks++; throw new Error("trap"); } }),
    () => { const value = response(); Object.defineProperty(value, "decisions", { get() { hooks++; throw new Error("getter"); }, enumerable: true }); return value; },
    () => { const value = response(); delete value.decisions[0]; return value; },
    () => { const value = response(); value.decisions.extra = true; return value; },
  ]) assert.throws(() => validateResearchScopeReview(batch, make()), { code: "DEEP_RESEARCH_SCOPE_REVIEW_INVALID" });
  assert.equal(hooks, 0);
});
