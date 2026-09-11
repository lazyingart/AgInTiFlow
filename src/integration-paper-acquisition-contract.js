// Durable metadata only. The session broker resolves the selected source in
// its account/conversation state; this contract grants no network authority.
import crypto from "node:crypto";
import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import { normalizeArxivIdentifier } from "./integration-grounded-search.js";
import { canonicalJson, contractDigest, validateIntegrationArtifactId } from "./integration-policy.js";
import { exactDocumentWorkerObject, documentWorkerFail } from "./integration-document-worker-contract.js";
import { createFileWorkerIssuanceId, FILE_WORKER_PATTERNS } from "./integration-file-worker-contract.js";
import {
  ACQUIRED_PAPER_SCHEMA_VERSIONS as PAPER,
  validateAcquiredPaperSource, validateAcquiredPaperCandidate,
  validateAcquiredPaperIssueRequest, validateAcquiredPaperImportRequest,
  digestAcquiredPaperImportMetadata,
} from "./integration-acquired-paper-contract.js";

export const PAPER_ACQUISITION_SCHEMA = Object.freeze({
  select: "aginti-paper-selection-request-v1",
  acquired: "aginti-paper-acquired-candidate-v1",
  issued: "aginti-paper-issued-candidate-v1",
  intent: "aginti-paper-acquisition-intent-v1",
});
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);
const exact = (value, keys) => exactDocumentWorkerObject(value, keys, keys, "paper acquisition");
const tokenDigest = token => crypto.createHash("sha256").update(token, "utf8").digest("hex");
function invalid() {
  documentWorkerFail("ANALYSIS_PAPER_AUTHORITY_INVALID", "Paper acquisition conflicts with its recorded source or operation.", { status: 409 });
}
function time(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

export function validatePaperSelectionRequest(value) {
  exact(value, ["schemaVersion", "sourceArtifactId", "sourceIndex"]);
  if (value.schemaVersion !== PAPER_ACQUISITION_SCHEMA.select || !Number.isSafeInteger(value.sourceIndex) || value.sourceIndex < 1) invalid();
  validateIntegrationArtifactId(value.sourceArtifactId);
  return Object.freeze({ ...value });
}

export function paperSelectionFromArtifact(value, sourceIndex) {
  const artifact = sanitizeIntegrationArtifact(value);
  const source = artifact.kind === "sources" && artifact.spec.sources.find(item => item.index === sourceIndex);
  if (!source) invalid();
  const url = new URL(source.url);
  let pdfUrl = source.url;
  let version = null;
  // A narrow adapter for a recorded arXiv citation; never probe arbitrary
  // landing pages or let the model invent a replacement download URL.
  if (url.origin === "https://arxiv.org" && !url.search && !url.hash) {
    const matched = /^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/u.exec(url.pathname);
    if (!matched) invalid();
    const identifier = normalizeArxivIdentifier(matched[1]);
    if (identifier !== matched[1].toLowerCase()) invalid();
    pdfUrl = `https://arxiv.org/pdf/${matched[1]}`;
    version = /v[1-9][0-9]*$/u.exec(identifier)?.[0] ?? null;
  } else if (!/\.pdf$/iu.test(url.pathname) || url.search || url.hash) invalid();
  const sourceId = `grounded:${artifact.id}:${sourceIndex}`;
  // Reuse the import contract's URL/DOI constraints before any network work.
  validateAcquiredPaperSource({ sourceId, sourceUrl: pdfUrl, finalUrl: pdfUrl,
    doi: source.doi, version, acquiredAt: "2026-01-01T00:00:00.000Z" });
  return Object.freeze({
    sourceArtifactId: artifact.id, sourceIndex, sourceDigest: contractDigest(source),
    sourceId, pdfUrl, doi: source.doi, version, filename: `paper-${sourceIndex}.pdf`,
  });
}

export function validatePaperAcquisitionIntent(value, selection, scope) {
  exact(value, ["schemaVersion", "selection", "createdAt", "issue", "issued"]);
  if (value.schemaVersion !== PAPER_ACQUISITION_SCHEMA.intent || !equal(value.selection, selection)) invalid();
  time(value.createdAt);
  let issue = null;
  let issued = null;
  if (value.issue !== null) {
    issue = validateAcquiredPaperIssueRequest(value.issue);
    if (!equal(issue.scope, scope) || issue.files[0].filename !== selection.filename ||
        issue.source.sourceId !== selection.sourceId || issue.source.sourceUrl !== selection.pdfUrl ||
        issue.source.doi !== selection.doi || issue.source.version !== selection.version) invalid();
  }
  if (value.issued !== null) {
    issued = exact(value.issued, ["requestId", "authorityTokenDigest", "operationDigest"]);
    if (!issue || !FILE_WORKER_PATTERNS.requestId.test(issued.requestId) ||
        !FILE_WORKER_PATTERNS.digest.test(issued.authorityTokenDigest) ||
        !FILE_WORKER_PATTERNS.digest.test(issued.operationDigest)) invalid();
    issued = Object.freeze({ ...issued });
  }
  return Object.freeze({ schemaVersion: value.schemaVersion, selection, createdAt: value.createdAt, issue, issued });
}

export function createPaperAcquisitionIntent(selection, createdAt) {
  return Object.freeze({ schemaVersion: PAPER_ACQUISITION_SCHEMA.intent, selection, createdAt: time(createdAt), issue: null, issued: null });
}

// Called inside the session's durable mutation, before issue/import dispatch.
// A retry may reacquire identical bytes at a later time; the first accepted
// acquisition time/issuance remain canonical. A changed file is a new decision.
export function advancePaperAcquisitionIntent(intentValue, proposed, selection, scope) {
  const intent = validatePaperAcquisitionIntent(intentValue, selection, scope);
  if (proposed?.schemaVersion === PAPER_ACQUISITION_SCHEMA.acquired) {
    exact(proposed, ["schemaVersion", "selection", "authorityEpoch", "file", "source"]);
    if (!equal(proposed.selection, selection)) invalid();
    const file = validateAcquiredPaperCandidate(proposed.file);
    const source = validateAcquiredPaperSource(proposed.source);
    if (!Number.isSafeInteger(proposed.authorityEpoch) || proposed.authorityEpoch < 1) invalid();
    const issue = validateAcquiredPaperIssueRequest({
      schemaVersion: PAPER.issueRequest,
      issuanceId: intent.issue?.issuanceId ?? createFileWorkerIssuanceId(proposed.authorityEpoch),
      authorityEpoch: proposed.authorityEpoch, scope, files: [file], source,
    });
    const next = validatePaperAcquisitionIntent({ ...intent, issue }, selection, scope);
    if (intent.issue !== null) {
      if (!equal({ ...issue, source: { ...source, acquiredAt: intent.issue.source.acquiredAt } }, intent.issue)) invalid();
      return Object.freeze({ intent, result: intent.issue });
    }
    return Object.freeze({ intent: next, result: issue });
  }
  exact(proposed, ["schemaVersion", "request"]);
  if (proposed.schemaVersion !== PAPER_ACQUISITION_SCHEMA.issued || intent.issue === null) invalid();
  const request = validateAcquiredPaperImportRequest(proposed.request);
  const { requestId, authorityToken, ...body } = request;
  if (!equal({ ...body, schemaVersion: PAPER.issueRequest }, intent.issue)) invalid();
  const issued = Object.freeze({ requestId, authorityTokenDigest: tokenDigest(authorityToken), operationDigest: digestAcquiredPaperImportMetadata(request) });
  if (intent.issued !== null && !equal(intent.issued, issued)) invalid();
  return Object.freeze({
    intent: validatePaperAcquisitionIntent({ ...intent, issued }, selection, scope), result: request,
  });
}

export function paperReceiptMatchesIntent(receipt, intent) {
  return Boolean(intent?.issue && intent.issued && receipt.requestId === intent.issued.requestId &&
    receipt.requestDigest === intent.issued.operationDigest && equal(receipt.source, intent.issue.source));
}
