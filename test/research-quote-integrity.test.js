import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deepResearch } from "../src/deep-research.js";
import { SessionStore } from "../src/session-store.js";

const query = "What temperature change does the document report? Read its exact statement.";
const original = "The measured temperature change was -10 degrees during the controlled validation.";
const altered = original.replace("-10", "+10");
const args = { query, depth: "quick", maxQueries: 1, maxSources: 1, sourcePolicy: "primary", researchId: "sign-integrity" };
// Actual installed352 checkpoint fingerprint for the unchanged args above.
const legacyFingerprint = "6f6b654bfb668e674fee50d313a3abb5897ce4609528015fcecb43476be893c6";
const completion = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });

async function fixture(t, source = original, quote = source, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-quote-integrity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(path.join(root, "sessions"), "quote-integrity");
  const calls = { model: 0, source: 0, synthesis: [] };
  const config = { provider: "deepseek", model: "scripted-research", routeModel: "scripted-research", mainModel: "scripted-research",
    apiKey: "scripted-test-only", commandCwd: root,
    jsonClientFactory: () => ({ chat: { completions: { create: async body => {
      calls.model++;
      const input = JSON.parse(body.messages[1].content);
      if (/research plan/i.test(input.task)) return completion({ objective: "Report the supplied observation.", sourcePolicy: "primary",
        subquestions: [{ id: "measurement", question: "What was measured?", query: "temperature change controlled validation" }],
        queries: ["temperature change controlled validation"], sourceTypes: ["official documentation"], exclusions: [] });
      if (/Extract only source-grounded evidence/i.test(input.task)) {
        const row = JSON.parse(input.input);
        return completion({ sourceId: row.sourceId, relevant: true, summary: "A controlled source supplies an observation.",
          relevantQuestionIds: ["measurement"], claims: [{ claim: "A controlled source supplies the quoted observation.", quote, confidence: "high" }], limitations: [] });
      }
      if (/Synthesize a source-grounded/i.test(input.task)) {
        calls.synthesis.push(input);
        return completion({ title: "Controlled Observation", executiveSummary: "The source reports a controlled observation.",
          executiveSummaryEvidenceIds: ["S1-C1"], sections: [{ heading: "Observation", paragraphs: [{ text: "The source reports a controlled observation.", evidenceIds: ["S1-C1"] }] }],
          keyFindings: [{ claim: "A controlled observation is documented.", evidenceIds: ["S1-C1"], confidence: "high" }],
          recommendations: [], contradictions: [], uncertainties: ["Controlled fixture only."], nextQuestions: [] });
      }
      throw new Error("Unexpected scripted research phase");
    } } } }),
    webSearchImpl: async () => ({ ok: true, provider: "fixture", results: [{ rank: 1, title: "Official temperature controlled validation",
      url: "https://docs.example.org/temperature", canonicalUrl: "https://docs.example.org/temperature", domain: "docs.example.org", snippet: source }] }),
    webPageReaderImpl: async ({ url }) => {
      calls.source++;
      return { ok: options.readable !== false, url, title: "Official temperature controlled validation", readable: options.readable !== false,
        contentType: "text/html", retrievedAt: "2026-11-05T00:00:00Z", sha256: "a".repeat(64), content: source, passages: [source] };
    },
  };
  const request = options.allowInsufficient ? args : { ...args, minIndependentSources: 1 };
  const result = await deepResearch(request, config, store);
  const file = path.join(store.artifactsDir, "deep-research-sign-integrity.json");
  const report = path.join(store.artifactsDir, "deep-research-sign-integrity.md");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  return { root, store, calls, config, request, result, state, file, report };
}

test("signs, comparisons, percentages and scientific notation cannot change in a verified quotation", async t => {
  for (const [source, quote] of [
    [original, altered],
    ["The measured value satisfies x < 0 during the controlled validation.", "The measured value satisfies x > 0 during the controlled validation."],
    ["The controlled measurement has p <= 0.05 under the stated analysis.", "The controlled measurement has p >= 0.05 under the stated analysis."],
    ["The bounded threshold is 1e-6 under the controlled validation conditions.", "The bounded threshold is 1e+6 under the controlled validation conditions."],
    ["The controlled trial measured a 10% relative change in the selected signal.", "The controlled trial measured a 10 relative change in the selected signal."],
    ["The measured values satisfy a != b during the controlled validation.", "The measured values satisfy a == b during the controlled validation."],
    ["The reported measurement is 3.500 units under the controlled conditions.", "The reported measurement is 3,500 units under the controlled conditions."],
  ]) {
    const run = await fixture(t, source, quote);
    assert.equal(run.state.evidence[0].claims[0].quoteVerified, false, quote);
    assert.equal(run.state.coverage.verifiedClaimCount, 0);
    assert.equal(run.result.ok, false);
    assert.equal(run.calls.synthesis.length, 0, "unverified evidence reached synthesis");
  }
});

test("case, words and semantic punctuation remain exact instead of becoming citation authority", async t => {
  for (const [source, quote] of [
    ["The measured current is 10 mA under the controlled validation conditions.", "The measured current is 10 MA under the controlled validation conditions."],
    ["The source says 'not approved' during the controlled validation.", "The source says not-approved during the controlled validation."],
    [original, original.replace("change", "changes")],
  ]) {
    const run = await fixture(t, source, quote);
    assert.equal(run.state.evidence[0].claims[0].quoteVerified, false, quote);
    assert.equal(run.result.ok, false);
  }
});

test("Chinese and Japanese quotations preserve numerical direction and comparison symbols", async t => {
  for (const [source, quote] of [
    ["在受控验证期间，测得的温度变化为−10度，测量结果仅适用于这个实验。", "在受控验证期间，测得的温度变化为+10度，测量结果仅适用于这个实验。"],
    ["制御された検証では測定値が x < 0 を満たし、この結果は実験条件に限定される。", "制御された検証では測定値が x > 0 を満たし、この結果は実験条件に限定される。"],
  ]) {
    assert.equal((await fixture(t, source, quote)).state.evidence[0].claims[0].quoteVerified, false);
    assert.equal((await fixture(t, source)).state.evidence[0].claims[0].quoteVerified, true);
  }
});

test("exact contiguous quotations allow only whitespace layout and canonical Unicode equivalence", async t => {
  for (const [source, quote] of [
    [original, original],
    [original.replace("temperature change", "temperature\n\tchange"), original],
    [original.replace("-10 degrees", "-10\u00a0degrees"), original],
    ["The cafe\u0301 observation records -10 degrees during the controlled validation.", "The café observation records -10 degrees during the controlled validation."],
  ]) {
    const run = await fixture(t, source, quote);
    assert.equal(run.result.ok, true, run.result.error);
    assert.equal(run.state.evidence[0].claims[0].quoteVerified, true);
    assert.equal(run.state.evidence[0].claims[0].quote, quote);
    assert.equal(run.state.coverage.verifiedClaimCount, 1);
    assert.equal(run.calls.synthesis.length, 1);
  }
});

test("unreadable snippets are never page-verified and altered snippets do not gain excerpt proof", async t => {
  const exact = await fixture(t, original, original, { readable: false, allowInsufficient: true });
  assert.equal(exact.state.evidence[0].claims[0].quoteVerified, false);
  assert.equal(exact.state.evidence[0].claims[0].searchExcerptMatched, true);
  const changed = await fixture(t, original, altered, { readable: false, allowInsufficient: true });
  assert.equal(changed.state.evidence[0].claims[0].quoteVerified, false);
  assert.equal(changed.state.evidence[0].claims[0].searchExcerptMatched, false);
  assert.equal(changed.state.coverage.verifiedClaimCount, 0);
});

test("failed exact evidence persists as failed without laundering the altered quote into a report", async t => {
  const run = await fixture(t, original, altered);
  assert.equal(run.result.ok, false);
  assert.equal(run.state.status, "failed");
  assert.equal(run.state.evidence[0].claims[0].quote, altered);
  assert.equal(run.state.evidence[0].claims[0].quoteVerified, false);
  await assert.rejects(fs.readFile(run.report), { code: "ENOENT" });
  assert.match(run.result.error, /independent verified/);
});

test("truncating an oversized quotation cannot retain proof for the original longer text", async t => {
  const source = "The controlled source includes " + "a bounded methodological observation. ".repeat(48);
  const run = await fixture(t, source);
  const claim = run.state.evidence[0].claims[0];
  assert.ok(claim.quote.length <= 1200);
  assert.equal(claim.quoteVerified, false);
  assert.equal(run.result.ok, false);
  assert.equal(run.calls.synthesis.length, 0);
});

test("current exact evidence survives a fresh SessionStore without source/model redispatch", async t => {
  const run = await fixture(t);
  const stateBytes = await fs.readFile(run.file), reportBytes = await fs.readFile(run.report);
  const counts = { source: run.calls.source, model: run.calls.model };
  const fresh = new SessionStore(path.join(run.root, "sessions"), "quote-integrity");
  const resumed = await deepResearch(run.request, run.config, fresh);
  assert.equal(resumed.ok, true); assert.equal(resumed.cached, true);
  assert.equal(resumed.answer, run.result.answer);
  assert.deepEqual(await fs.readFile(run.file), stateBytes);
  assert.deepEqual(await fs.readFile(run.report), reportBytes);
  assert.deepEqual({ source: run.calls.source, model: run.calls.model }, counts);
});

test("legacy punctuation-erasing proof cannot be served after restart or overwrite retained artifacts", async t => {
  const run = await fixture(t, original, original, { allowInsufficient: true });
  run.state.fingerprint = legacyFingerprint;
  run.state.evidence[0].claims[0].quote = altered;
  run.state.evidence[0].claims[0].quoteVerified = true;
  await fs.writeFile(run.file, JSON.stringify(run.state));
  await fs.writeFile(run.report, "Legacy report retained for inspection.\n");
  const stateBytes = await fs.readFile(run.file), reportBytes = await fs.readFile(run.report);
  const counts = { source: run.calls.source, model: run.calls.model };
  const fresh = new SessionStore(path.join(run.root, "sessions"), "quote-integrity");
  const result = await deepResearch(run.request, run.config, fresh);
  assert.equal(result.ok, false); assert.match(result.error, /different query or research policy/);
  assert.deepEqual(await fs.readFile(run.file), stateBytes);
  assert.deepEqual(await fs.readFile(run.report), reportBytes);
  assert.deepEqual({ source: run.calls.source, model: run.calls.model }, counts);
});
