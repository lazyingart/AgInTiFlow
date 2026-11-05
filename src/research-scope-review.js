import crypto from "node:crypto";
import { types } from "node:util";
import { redactSensitiveText, redactValue } from "./redaction.js";

export const RESEARCH_SCOPE_REVIEW_POLICY = "retained-source-context-review-v1";
export const RESEARCH_SCOPE_REVIEW_LIMITS = Object.freeze({
  statements: 128,
  statementChars: 6000,
  batchStatements: 32,
  batchBytes: 96 * 1024,
  batches: 16,
  totalBytes: 1024 * 1024,
});

function fail(message) {
  const error = new Error(message);
  error.code = "DEEP_RESEARCH_SCOPE_REVIEW_INVALID";
  throw error;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalized(value) {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) fail("Scope-review data must be a plain object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("Scope-review data has an invalid prototype.");
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key))) fail("Scope-review data has unexpected fields.");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("Scope-review data must contain enumerable data fields.");
  }
}

function denseArray(value, maximum) {
  if (!value || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail("Scope-review data requires a plain array.");
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length > maximum || Reflect.ownKeys(value).length !== length + 1) fail("Scope-review array is oversized or extended.");
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("Scope-review array must be dense data.");
  }
  return value;
}

function text(value, maximum, { empty = false } = {}) {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim())) fail("Scope-review text is missing or oversized.");
  if (redactSensitiveText(value) !== value) fail("Scope-review text cannot retain sensitive material.");
  return value;
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

// This is a native research assessment, not an authorization or formal
// entailment proof. The caller must enforce the result before rendering or
// returning candidate prose. Hashes bind retained input; they are not MACs.
export function buildResearchScopeReviewPlan({ query, synthesis, sources, evidence, coverage = {} }) {
  const sourceMap = new Map();
  for (const source of sources) {
    if (sourceMap.has(source.id)) fail("Scope-review source IDs must be unique.");
    const retainedText = redactSensitiveText(String(source.content || source.passages?.join("\n\n") || ""));
    sourceMap.set(source.id, {
      sourceId: source.id,
      title: redactSensitiveText(String(source.title || "")),
      url: redactSensitiveText(String(source.url || "")),
      rawDigest: String(source.sha256 || ""),
      retrievedAt: String(source.retrievedAt || ""),
      retainedText,
      textDigest: digest(retainedText),
      retainedTextOnly: true,
      readerTruncated: typeof source.readTruncated === "boolean" ? source.readTruncated : null,
    });
  }
  const evidenceMap = new Map();
  for (const item of evidence) {
    const source = sourceMap.get(item.sourceId);
    for (const claim of item.claims || []) {
      if (!claim.quoteVerified) continue;
      if (!source || evidenceMap.has(claim.evidenceId)) fail("Scope-review evidence mapping is invalid.");
      const quote = text(claim.quote, 1200);
      if (normalized(quote).length < 24 || !normalized(source.retainedText).includes(normalized(quote))) fail("Scope-review quotation no longer matches its retained source.");
      evidenceMap.set(claim.evidenceId, { evidenceId: claim.evidenceId, sourceId: item.sourceId, quote });
    }
  }
  const statements = [];
  const add = (kind, value, ids = []) => {
    if (value === "") return;
    const valueText = text(value, RESEARCH_SCOPE_REVIEW_LIMITS.statementChars);
    const evidenceIds = [...new Set(ids)];
    if (evidenceIds.some(id => !evidenceMap.has(id))) fail("Scope-review statement references unknown evidence.");
    const sourceIds = [...new Set(evidenceIds.map(id => evidenceMap.get(id).sourceId))];
    statements.push({ statementId: `R${statements.length + 1}`, kind, text: valueText, evidenceIds, sourceIds,
      allowedVerdicts: evidenceIds.length ? ["supported", "unsupported", "uncertain"] : ["not_factual", "unsupported", "uncertain"] });
    if (statements.length > RESEARCH_SCOPE_REVIEW_LIMITS.statements) fail("Research report exceeds the scope-review statement budget.");
  };
  add("title", synthesis.title || "");
  add("summary", synthesis.executiveSummary || "", synthesis.executiveSummaryEvidenceIds || []);
  for (const section of synthesis.sections || []) {
    add("heading", section.heading || "");
    for (const paragraph of section.paragraphs || []) add("paragraph", paragraph.text, paragraph.evidenceIds || []);
  }
  for (const finding of synthesis.keyFindings || []) add("finding", finding.claim, finding.evidenceIds || []);
  for (const recommendation of synthesis.recommendations || []) add("recommendation", recommendation.text, recommendation.evidenceIds || []);
  for (const kind of ["contradictions", "uncertainties", "nextQuestions"]) {
    for (const note of synthesis[kind] || []) {
      // A factual note can cite existing evidence explicitly. Uncited notes,
      // titles and headings may pass only as non-factual metadata/questions.
      const ids = [...evidenceMap.keys()].filter(id => typeof note === "string" && note.includes(`[${id}]`));
      add("note", note, ids);
    }
  }
  if (!statements.some(statement => statement.evidenceIds.length)) fail("Research has no quotation-backed statement to assess.");
  const base = {
    policy: RESEARCH_SCOPE_REVIEW_POLICY,
    question: text(query, 4000),
    coverage: {
      readableSources: Number(coverage.readableSourceCount || 0),
      verifiedQuotations: Number(coverage.verifiedEvidenceCount || 0),
      missingQuestions: (coverage.missingQuestions || []).map(question => String(question.question || "")).slice(0, 12),
    },
  };
  const payloadFor = rows => {
    const sourceIds = [...new Set(rows.flatMap(row => row.sourceIds))];
    const evidenceIds = [...new Set(rows.flatMap(row => row.evidenceIds))];
    return { ...base, statements: rows, sources: sourceIds.map(id => sourceMap.get(id)), evidence: evidenceIds.map(id => evidenceMap.get(id)) };
  };
  const batches = [];
  let pending = [];
  let totalBytes = 0;
  const append = rows => {
    const payload = payloadFor(rows);
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    totalBytes += bytes;
    if (bytes > RESEARCH_SCOPE_REVIEW_LIMITS.batchBytes || totalBytes > RESEARCH_SCOPE_REVIEW_LIMITS.totalBytes || batches.length >= RESEARCH_SCOPE_REVIEW_LIMITS.batches) fail("Retained source context exceeds the scope-review budget; request a smaller report.");
    batches.push({ payload, requestDigest: digest(payload) });
  };
  for (const statement of statements) {
    const next = [...pending, statement];
    if (pending.length && (next.length > RESEARCH_SCOPE_REVIEW_LIMITS.batchStatements || Buffer.byteLength(JSON.stringify(payloadFor(next)), "utf8") > RESEARCH_SCOPE_REVIEW_LIMITS.batchBytes)) {
      append(pending);
      pending = [];
    }
    pending.push(statement);
  }
  if (pending.length) append(pending);
  return freeze({ policy: RESEARCH_SCOPE_REVIEW_POLICY, bindingDigest: digest({
    batchDigests: batches.map(batch => batch.requestDigest),
    documentDigest: digest(redactValue(synthesis)),
    sourceDigest: digest(redactValue(sources)),
    evidenceDigest: digest(redactValue(evidence)),
    coverageDigest: digest(redactValue(coverage)),
  }), batches });
}

export function researchScopeReviewSchema(batch) {
  return {
    type: "object",
    properties: {
      schemaVersion: { type: "string", const: "aginti-research-scope-review-v1" },
      requestDigest: { type: "string", const: batch.requestDigest },
      decisions: { type: "array", minItems: batch.payload.statements.length, maxItems: batch.payload.statements.length, items: {
        type: "object",
        properties: {
          statementId: { type: "string", enum: batch.payload.statements.map(row => row.statementId) },
          verdict: { type: "string", enum: ["supported", "not_factual", "unsupported", "uncertain"] },
          reason: { type: "string", enum: ["supported_in_source", "not_factual", "dropped_scope", "contradicted", "not_in_source", "insufficient_context"] },
          supportingQuotes: { type: "array", maxItems: 3, items: { type: "object", properties: {
            sourceId: { type: "string" }, quote: { type: "string" },
          }, required: ["sourceId", "quote"], additionalProperties: false } },
        },
        required: ["statementId", "verdict", "reason", "supportingQuotes"],
        additionalProperties: false,
      } },
    },
    required: ["schemaVersion", "requestDigest", "decisions"],
    additionalProperties: false,
  };
}

export function validateResearchScopeReview(batch, result) {
  exactObject(result, ["schemaVersion", "requestDigest", "decisions"]);
  if (result.schemaVersion !== "aginti-research-scope-review-v1" || result.requestDigest !== batch.requestDigest) fail("Scope-review response binding is invalid.");
  const rows = denseArray(result.decisions, RESEARCH_SCOPE_REVIEW_LIMITS.batchStatements);
  if (rows.length !== batch.payload.statements.length) fail("Scope-review response must assess every statement.");
  const expected = new Map(batch.payload.statements.map(row => [row.statementId, row]));
  const seen = new Set();
  const decisions = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    exactObject(row, ["statementId", "verdict", "reason", "supportingQuotes"]);
    if (typeof row.statementId !== "string" || typeof row.verdict !== "string" || typeof row.reason !== "string") fail("Scope-review decision fields must be strings.");
    const statement = expected.get(row.statementId);
    if (!statement || seen.has(row.statementId)) fail("Scope-review statement inventory is invalid.");
    seen.add(row.statementId);
    if (![
      "supported:supported_in_source", "not_factual:not_factual", "unsupported:dropped_scope",
      "unsupported:contradicted", "unsupported:not_in_source", "uncertain:insufficient_context",
    ].includes(`${row.verdict}:${row.reason}`)) fail("Scope-review verdict is invalid.");
    const quotes = denseArray(row.supportingQuotes, 3);
    if (row.verdict === "supported" && (!statement.evidenceIds.length || !quotes.length)) fail("Supported statements require source-bound quotations.");
    if (row.verdict === "not_factual" && (statement.evidenceIds.length || !["title", "heading", "note"].includes(statement.kind) || quotes.length)) fail("A factual statement cannot bypass review as metadata.");
    if (row.reason === "dropped_scope" && !quotes.length) fail("Dropped-scope feedback requires a source quotation.");
    const supportingQuotes = [];
    for (let quoteIndex = 0; quoteIndex < quotes.length; quoteIndex += 1) {
      const quote = quotes[quoteIndex];
      exactObject(quote, ["sourceId", "quote"]);
      if (typeof quote.sourceId !== "string") fail("Scope-review source ID must be a string.");
      const source = batch.payload.sources.find(source => source.sourceId === quote.sourceId);
      const value = text(quote.quote, 1200);
      if (!source || !statement.sourceIds.includes(quote.sourceId) || normalized(value).length < 2 || !normalized(source.retainedText).includes(normalized(value))) fail("Scope-review supporting quotation is outside its exact retained source.");
      supportingQuotes.push({ sourceId: quote.sourceId, quote: value });
    }
    if (row.verdict === "supported" && !supportingQuotes.some(quote => normalized(quote.quote).length >= 24)) fail("Supported statements require a substantive source quotation.");
    decisions.push({ statementId: row.statementId, verdict: row.verdict, reason: row.reason, supportingQuotes });
  }
  decisions.sort((left, right) => batch.payload.statements.findIndex(row => row.statementId === left.statementId) - batch.payload.statements.findIndex(row => row.statementId === right.statementId));
  return freeze({ schemaVersion: result.schemaVersion, requestDigest: result.requestDigest, decisions });
}
