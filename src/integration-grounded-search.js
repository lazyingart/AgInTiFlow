import { TextDecoder, types as utilTypes } from "node:util";

import { parse as parseDomainName } from "tldts";

import {
  MAX_INTEGRATION_PUBLIC_ARTIFACT_BYTES,
  sanitizeIntegrationArtifact,
  validateIntegrationSourcesSpec,
} from "./integration-artifacts.js";
import {
  AGENT_WORKER_SCHEMA_VERSION,
  INTEGRATION_MAXIMUM_SEARCH_SOURCES,
  canonicalJson,
  contractDigest,
  validateIntegrationSearch,
} from "./integration-policy.js";

export const INTEGRATION_GROUNDED_SEARCH_SCHEMA_VERSION = "aginti-integration-grounded-search-v1";
export const INTEGRATION_GROUNDED_SEARCH_ACTIVATION_SCHEMA_VERSION =
  "aginti-integration-grounded-search-activation-v1";
export const INTEGRATION_GROUNDED_SEARCH_TOOL_NAME = "grounded_search";
export const INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_SCHEMA_VERSION =
  "aginti-integration-grounded-search-domain-policy-v1";
export const INTEGRATION_GROUNDED_SEARCH_QUERY_PLAN_SCHEMA_VERSION =
  "aginti-integration-grounded-search-query-plan-v1";
export const INTEGRATION_GROUNDED_SEARCH_ARTIFACT_AUTHORITY_SCHEMA_VERSION =
  "aginti-grounded-search-artifact-authority-v1";
export const LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION = "localllm-grounded-search-request-v2";
export const LOCALLLM_GROUNDED_SEARCH_RESPONSE_SCHEMA_VERSION = "localllm-grounded-search-response-v2";
export const LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION = "localllm-grounded-search-policy-v1";
export const INTEGRATION_GROUNDED_SEARCH_ENDPOINT = "http://127.0.0.1:18081/api/search/v2";
export const INTEGRATION_GROUNDED_SEARCH_LOCAL_TARGET_ENDPOINT = "http://127.0.0.1:8008/api/search/v2";
export const INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS = 60_000;
export const INTEGRATION_GROUNDED_SEARCH_MAX_REQUEST_BYTES = 16 * 1024;
export const INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES = 256 * 1024;

const WEB_READINESS_QUERY = "grounded web search operational readiness";
const PAPERS_READINESS_QUERY = "grounded papers search operational readiness";
const MAX_QUERY_CHARACTERS = 800;
const MAX_PUBLIC_SNIPPET_CHARACTERS = 1_200;
const MAXIMUM_ALLOWED_DOMAINS = 16;
const MAXIMUM_INFERRED_ALLOWED_DOMAINS = 1;
const MAXIMUM_EXACT_IDENTIFIERS = 8;
const LOCALLLM_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const BARE_DIGEST = /^[a-f0-9]{64}$/u;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOSTNAME_CAPTURE = "([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CLIENT_BRAND = new WeakSet();
const CLIENT_METADATA = new WeakMap();
const ACTIVATION_METADATA = new WeakMap();
const SOURCE_KEYS = Object.freeze([
  "rank",
  "title",
  "url",
  "snippet",
  "provider",
  "providers",
  "kind",
  "authors",
  "year",
  "published_date",
  "doi",
  "citation_count",
  "score",
  "query",
  "provenance",
  "canonicalUrl",
  "domain",
  "identifiers",
  "identityDigest",
  "matchedAllowedDomains",
  "matchedExactIdentifiers",
]);
const PROVIDER_DIAGNOSTIC_KEYS = Object.freeze([
  "name",
  "kind",
  "ok",
  "result_count",
  "duration_ms",
  "error",
  "queries",
]);
const DOMAIN_POLICY_UNSIGNED = Object.freeze({
  schemaVersion: INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_SCHEMA_VERSION,
  owner: "aginti",
  maximumAllowedDomains: MAXIMUM_ALLOWED_DOMAINS,
  explicitPositiveSiteOperator: true,
  naturalLanguageDomainInference: false,
  hostnameBoundaryRequired: true,
  responseUrlsRevalidated: true,
});
export const INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_DIGEST = contractDigest(DOMAIN_POLICY_UNSIGNED);
const QUERY_POLICY_UNSIGNED = Object.freeze({
  schemaVersion: INTEGRATION_GROUNDED_SEARCH_QUERY_PLAN_SCHEMA_VERSION,
  owner: "aginti",
  modelPlanned: false,
  arxivIdentifiers: true,
  arxivIdentifierGrammar: "canonical-new-style-era-bound-or-legacy-pre-0704",
  doiIdentifiers: true,
  mixedExactIdentifierIntent: true,
  exactIdentifierLimit: MAXIMUM_EXACT_IDENTIFIERS,
  providerStructuredConstraints: true,
  actualQueryBoundInSourceArtifact: true,
  queryOverrunRejectedBeforePersistence: true,
});
export const INTEGRATION_GROUNDED_SEARCH_QUERY_POLICY_DIGEST = contractDigest(QUERY_POLICY_UNSIGNED);

export class IntegrationGroundedSearchError extends Error {
  constructor(
    code,
    message,
    { status = 502, cause, retryable = false, runtimeStatus = null, runtimeClassification = null, retryAfterMs = null } = {}
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationGroundedSearchError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
    this.retryable = retryable === true;
    this.runtimeStatus = runtimeStatus;
    this.runtimeClassification = runtimeClassification;
    this.retryAfterMs = retryAfterMs;
  }
}

function fail(code, message, options = {}) {
  throw new IntegrationGroundedSearchError(code, message, options);
}

function localllmDigest(value) {
  return `sha256:${contractDigest(value)}`;
}

function normalizeLocalllmDigest(value, label) {
  if (typeof value !== "string" || !LOCALLLM_DIGEST.test(value)) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label} digest is invalid.`);
  }
  return value;
}

function normalizeInternalDigest(value, label) {
  if (typeof value === "string" && BARE_DIGEST.test(value)) return value;
  if (typeof value === "string" && LOCALLLM_DIGEST.test(value)) return value.slice("sha256:".length);
  fail("GROUNDED_SEARCH_INVALID", `${label} digest is invalid.`, { status: 400 });
}

function compareCodePointText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareExactIdentifier(left, right) {
  return compareCodePointText(exactIdentifierKey(left), exactIdentifierKey(right));
}

function hasRegistrablePublicDomain(domain) {
  try {
    const parsed = parseDomainName(domain, { allowPrivateDomains: false });
    return parsed.hostname === domain && parsed.domain !== null && parsed.publicSuffix !== null;
  } catch {
    return false;
  }
}

function normalizedDomain(value) {
  if (typeof value !== "string") {
    fail("GROUNDED_SEARCH_DOMAIN_CONSTRAINT_INVALID", "Grounded search domain constraint is invalid.", {
      status: 400,
    });
  }
  const domain = value.toLowerCase();
  if (!DNS_NAME.test(domain) || domain.includes("..") || !hasRegistrablePublicDomain(domain)) {
    fail("GROUNDED_SEARCH_DOMAIN_CONSTRAINT_INVALID", "Grounded search domain constraint is invalid.", {
      status: 400,
    });
  }
  return domain;
}

export function deriveIntegrationGroundedSearchDomainConstraint(prompt) {
  if (typeof prompt !== "string" || prompt.length < 1 || prompt.length > 16_384) {
    fail("GROUNDED_SEARCH_DOMAIN_CONSTRAINT_INVALID", "Grounded search prompt framing is invalid.", {
      status: 400,
    });
  }
  const siteTokens = [...prompt.matchAll(/(?:^|\s)(-?)site:([^\s]+)/giu)];
  if ((prompt.match(/\bsite:/giu) || []).length !== siteTokens.length) {
    fail("GROUNDED_SEARCH_DOMAIN_CONSTRAINT_INVALID", "Grounded search site constraint is malformed.", {
      status: 400,
    });
  }
  const explicitDomains = [];
  for (const match of siteTokens) {
    if (match[1] === "-") {
      fail("GROUNDED_SEARCH_DOMAIN_CONSTRAINT_INVALID", "Negative site constraints are not supported.", {
        status: 400,
      });
    }
    explicitDomains.push(normalizedDomain(match[2]));
  }
  const naturalPatterns = [
    new RegExp(`\\b(?:sources?|results?)\\s+only\\s+from\\s+${HOSTNAME_CAPTURE}(?=$|[\\s.,;:)\\]])`, "giu"),
    new RegExp(`\\bonly\\s+(?:sources?|results?)\\s+from\\s+${HOSTNAME_CAPTURE}(?=$|[\\s.,;:)\\]])`, "giu"),
    new RegExp(`\\brestrict\\s+(?:the\\s+)?(?:search|results?|sources?)\\s+to\\s+${HOSTNAME_CAPTURE}(?=$|[\\s.,;:)\\]])`, "giu"),
    new RegExp(`\\b(?:search|use)\\s+${HOSTNAME_CAPTURE}\\s+only\\b`, "giu"),
  ];
  for (const pattern of naturalPatterns) {
    for (const match of prompt.matchAll(pattern)) explicitDomains.push(normalizedDomain(match[1]));
  }
  const domains = [...new Set(explicitDomains)].sort(compareCodePointText);
  if (domains.length > MAXIMUM_INFERRED_ALLOWED_DOMAINS) {
    fail(
      "GROUNDED_SEARCH_DOMAIN_CONSTRAINT_AMBIGUOUS",
      "Grounded search contains conflicting positive domain authorities.",
      { status: 400 }
    );
  }
  if (domains.length === 0 && looksLikeUnsupportedDomainRestriction(prompt)) {
    fail(
      "GROUNDED_SEARCH_DOMAIN_CONSTRAINT_AMBIGUOUS",
      "Grounded search domain restriction must name one exact dotted hostname.",
      { status: 400 }
    );
  }
  if (domains.length === 0) return null;
  const unsigned = Object.freeze({
    schemaVersion: INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_SCHEMA_VERSION,
    domains: Object.freeze(domains),
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function looksLikeUnsupportedDomainRestriction(prompt) {
  const text = prompt.replace(/\s+/gu, " ").trim();
  if (/\breturn\s+only\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|[0-9]+)\s+sources?\b/iu.test(text)) {
    return false;
  }
  if (/\buse\s+only\s+primary\s+sources?\b/iu.test(text)) return false;
  return (
    /\b(?:use|find|search|restrict|limit)\b[^.?!]{0,120}\bonly\b[^.?!]{0,120}\b(?:sources?|results?|sites?|domains?)\b/iu.test(text) ||
    /\b(?:sources?|results?|sites?|domains?)\b[^.?!]{0,120}\bonly\b[^.?!]{0,120}\bfrom\b/iu.test(text) ||
    /\brestrict\b[^.?!]{0,120}\bto\b/iu.test(text)
  );
}

export function integrationGroundedSearchConstrainedQuery(prompt, constraint) {
  if (constraint === null) return boundedQuery(prompt);
  const domain = constraint?.domains?.[0];
  if (
    constraint?.schemaVersion !== INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_SCHEMA_VERSION ||
    constraint?.digest !== contractDigest({ schemaVersion: constraint.schemaVersion, domains: constraint.domains }) ||
    normalizedDomain(domain) !== domain
  ) {
    fail("GROUNDED_SEARCH_DOMAIN_CONSTRAINT_INVALID", "Grounded search domain authority is invalid.", {
      status: 400,
    });
  }
  const normalizedPrompt = prompt.replace(/\s+/gu, " ").trim();
  const siteOperator = new RegExp(`(?:^|\\s)site:${domain.replaceAll(".", "\\.")}(?=$|\\s)`, "giu");
  const withoutOperator = normalizedPrompt.replace(siteOperator, " ").replace(/\s+/gu, " ").trim();
  const suffix = ` site:${domain}`;
  const maximumBaseCharacters = MAX_QUERY_CHARACTERS - Array.from(suffix).length;
  const boundedBase = Array.from(withoutOperator).slice(0, maximumBaseCharacters).join("").trimEnd();
  if (Array.from(boundedBase).length < 3) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search query must contain at least three characters.", {
      status: 400,
    });
  }
  return boundedQuery(`${boundedBase}${suffix}`);
}

function hostnameWithinDomain(hostname, domain) {
  const normalized = hostname.toLowerCase();
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

function arxivVersionless(identifier) {
  return String(identifier || "").toLowerCase().replace(/v[1-9][0-9]*$/u, "");
}

function validateArxivNewStyle(identifier) {
  const match = /^([0-9]{4})\.([0-9]{4,5})(v[1-9][0-9]*)?$/u.exec(identifier);
  if (!match) return false;
  const yearMonth = Number(match[1]);
  const month = yearMonth % 100;
  const sequence = Number(match[2]);
  if (month < 1 || month > 12 || sequence < 1) return false;
  if (yearMonth >= 704 && yearMonth <= 1412) return match[2].length === 4;
  if (yearMonth >= 1501) return match[2].length === 5;
  return false;
}

function validateArxivLegacyStyle(identifier) {
  const match = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\/[0-9]{7}(v[1-9][0-9]*)?$/u.exec(identifier);
  if (!match) return false;
  return Number(identifier.split("/")[1].replace(/v[1-9][0-9]*$/u, "")) > 0;
}

function normalizeArxivIdentifier(value) {
  if (typeof value !== "string") {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search arXiv identifier is invalid.", { status: 400 });
  }
  const identifier = value.trim().toLowerCase().replace(/(?:\.pdf)?[.,;:)\]]+$/u, "");
  if (!validateArxivNewStyle(identifier) && !validateArxivLegacyStyle(identifier)) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search arXiv identifier is invalid.", { status: 400 });
  }
  return identifier;
}

function normalizeDoiIdentifier(value) {
  if (typeof value !== "string") {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search DOI identifier is invalid.", { status: 400 });
  }
  let candidate = value.trim().replace(/[.,;:]+$/u, "");
  let open = (candidate.match(/\(/gu) || []).length;
  let close = (candidate.match(/\)/gu) || []).length;
  while (candidate.endsWith(")") && close > open) {
    candidate = candidate.slice(0, -1);
    close -= 1;
  }
  if (
    candidate.length < 7 ||
    candidate.length > 180 ||
    open !== close ||
    !/^10\.[0-9]{4,9}\/(?:[A-Za-z0-9]|\([A-Za-z0-9])[A-Za-z0-9._;()/:+-]*$/u.test(candidate)
  ) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search DOI identifier is invalid.", { status: 400 });
  }
  return candidate.toLowerCase();
}

function normalizeExactIdentifier(value) {
  const candidate = exactObject(
    value,
    ["kind", "value"],
    ["kind", "value"],
    "grounded search exact identifier",
    { code: "GROUNDED_SEARCH_PROTOCOL_INVALID", status: 502 }
  );
  if (candidate.kind === "arxiv") {
    return Object.freeze({ kind: "arxiv", value: normalizeArxivIdentifier(candidate.value) });
  }
  if (candidate.kind === "doi") {
    const value = normalizeDoiIdentifier(candidate.value);
    if (value.startsWith("10.48550/arxiv.")) {
      return Object.freeze({ kind: "arxiv", value: normalizeArxivIdentifier(value.slice("10.48550/arxiv.".length)) });
    }
    return Object.freeze({ kind: "doi", value });
  }
  fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search exact identifier kind is invalid.");
}

function exactIdentifierKey(identifier) {
  return `${identifier.kind}:${identifier.value}`;
}

function canonicalExactIdentifiers(arxivIdentifiers = [], doiIdentifiers = []) {
  const identifiers = [
    ...arxivIdentifiers.map((value) => Object.freeze({ kind: "arxiv", value })),
    ...doiIdentifiers.map((value) => Object.freeze({ kind: "doi", value })),
  ].map((identifier) => normalizeExactIdentifier(identifier));
  const seen = new Set();
  const unique = [];
  for (const identifier of identifiers) {
    const key = exactIdentifierKey(identifier);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(identifier);
  }
  unique.sort(compareExactIdentifier);
  return Object.freeze(unique.map((identifier) => Object.freeze({ kind: identifier.kind, value: identifier.value })));
}

function uniqueBoundedIdentifiers(identifiers, label) {
  const unique = Object.freeze([...new Set(identifiers)]);
  if (unique.length > MAXIMUM_EXACT_IDENTIFIERS) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", `${label} exceeds the exact-identifier bound.`, { status: 400 });
  }
  return unique;
}

function assertNoConflictingArxivVersions(identifiers) {
  const byRoot = new Map();
  for (const identifier of identifiers) {
    const root = arxivVersionless(identifier);
    const set = byRoot.get(root) || new Set();
    set.add(identifier);
    byRoot.set(root, set);
  }
  for (const set of byRoot.values()) {
    if (set.size > 1) {
      fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search arXiv versions must be requested exactly, not by root alias.", {
        status: 400,
      });
    }
  }
}

export function assertIntegrationGroundedSearchDomainSources(grounding, constraint) {
  if (constraint === null) return grounding;
  if (!grounding || !Array.isArray(grounding.sources) || grounding.sources.length < 1) {
    fail("GROUNDED_SEARCH_DOMAIN_CONSTRAINT_FAILED", "Grounded search returned no constrained sources.");
  }
  const domain = constraint.domains[0];
  for (const source of grounding.sources) {
    let parsed;
    try {
      parsed = new URL(source.url);
    } catch (error) {
      fail("GROUNDED_SEARCH_DOMAIN_CONSTRAINT_FAILED", "Grounded source URL is invalid.", { cause: error });
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !hostnameWithinDomain(parsed.hostname, domain)
    ) {
      fail(
        "GROUNDED_SEARCH_DOMAIN_CONSTRAINT_FAILED",
        "Grounded search returned a source outside the exact requested domain."
      );
    }
  }
  return grounding;
}

function extractGroundedSearchDoiIdentifiers(prompt) {
  const identifiers = [];
  for (const match of prompt.matchAll(/\b10\.[0-9]{4,9}\//gu)) {
    let end = match.index + match[0].length;
    while (end < prompt.length && /[A-Za-z0-9._;()/:+-]/u.test(prompt[end])) end += 1;
    let candidate = prompt.slice(match.index, end).replace(/[.,;:]+$/u, "");
    let open = (candidate.match(/\(/gu) || []).length;
    let close = (candidate.match(/\)/gu) || []).length;
    while (candidate.endsWith(")") && close > open) {
      candidate = candidate.slice(0, -1);
      close -= 1;
    }
    const normalized = normalizeDoiIdentifier(candidate);
    if (!normalized.startsWith("10.48550/arxiv.")) identifiers.push(normalized);
  }
  return uniqueBoundedIdentifiers(identifiers, "Grounded search DOI identifier set");
}

function extractGroundedSearchArxivIdentifiers(prompt) {
  const explicit = [];
  const explicitPattern =
    /(?:\barxiv\s*:\s*|https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/|\b10\.48550\/arxiv\.)([^\s,;)\]]+)/giu;
  for (const match of prompt.matchAll(explicitPattern)) {
    explicit.push(normalizeArxivIdentifier(match[1]));
  }
  const arxivMentionCount = (prompt.match(/\barxiv\s*:/giu) || []).length +
    (prompt.match(/https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//giu) || []).length +
    (prompt.match(/\b10\.48550\/arxiv\./giu) || []).length;
  if (arxivMentionCount !== explicit.length) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search arXiv identifier is malformed.", { status: 400 });
  }
  const bareArxivList = /^\s*[0-9]{4}\.[0-9]{4,5}(?:v[1-9][0-9]*)?(?:\s*(?:,|;|\s)\s*[0-9]{4}\.[0-9]{4,5}(?:v[1-9][0-9]*)?)*\s*$/u
    .test(prompt)
    ? [...prompt.matchAll(/\b([0-9]{4}\.[0-9]{4,5}(?:v[1-9][0-9]*)?)\b/gu)].map((match) =>
        normalizeArxivIdentifier(match[1])
      )
    : [];
  return uniqueBoundedIdentifiers([...explicit, ...bareArxivList], "Grounded search arXiv identifier set");
}

export function planIntegrationGroundedSearchQuery(prompt, mode, domainConstraint = null) {
  if (!new Set(["web", "papers", "both"]).has(mode)) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search mode is invalid.", { status: 400 });
  }
  const arxivIdentifiers = extractGroundedSearchArxivIdentifiers(prompt);
  const doiIdentifiers = extractGroundedSearchDoiIdentifiers(prompt);
  assertNoConflictingArxivVersions(arxivIdentifiers);
  if (arxivIdentifiers.length + doiIdentifiers.length > MAXIMUM_EXACT_IDENTIFIERS) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search exact identifier set exceeds its bound.", { status: 400 });
  }
  let strategy = "ranked";
  let query = prompt;
  if (new Set(["papers", "both"]).has(mode) && arxivIdentifiers.length + doiIdentifiers.length > 0) {
    strategy = "exact";
    query = [...arxivIdentifiers, ...doiIdentifiers].join(" ");
  }
  query = integrationGroundedSearchConstrainedQuery(query, domainConstraint);
  const allowedDomains = Object.freeze([...(domainConstraint?.domains || [])]);
  const exactIdentifiers = canonicalExactIdentifiers(arxivIdentifiers, doiIdentifiers);
  const unsigned = Object.freeze({
    schemaVersion: INTEGRATION_GROUNDED_SEARCH_QUERY_PLAN_SCHEMA_VERSION,
    strategy,
    query,
    allowedDomains,
    exactIdentifiers,
    arxivIdentifiers: Object.freeze(arxivIdentifiers),
    doiIdentifiers: Object.freeze(doiIdentifiers),
    domainConstraintDigest: domainConstraint?.digest ?? null,
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

export function createIntegrationGroundedSearchArtifactAuthority(value) {
  const candidate = exactObject(
    value,
    ["query", "mode", "queryPlanDigest", "domainConstraintDigest"],
    ["query", "mode", "queryPlanDigest", "domainConstraintDigest"],
    "grounded search artifact authority",
    { code: "GROUNDED_SEARCH_INVALID", status: 400 }
  );
  const query = boundedQuery(candidate.query);
  if (query !== candidate.query || !new Set(["web", "papers", "both"]).has(candidate.mode)) {
    fail("GROUNDED_SEARCH_INVALID", "Grounded search artifact query authority is invalid.", { status: 400 });
  }
  for (const digest of [candidate.queryPlanDigest, candidate.domainConstraintDigest]) {
    if (digest !== null && !BARE_DIGEST.test(digest)) {
      fail("GROUNDED_SEARCH_INVALID", "Grounded search artifact authority digest is invalid.", { status: 400 });
    }
  }
  if (candidate.queryPlanDigest === null) {
    fail("GROUNDED_SEARCH_INVALID", "Grounded search query-plan authority is required.", { status: 400 });
  }
  const unsigned = Object.freeze({
    schemaVersion: INTEGRATION_GROUNDED_SEARCH_ARTIFACT_AUTHORITY_SCHEMA_VERSION,
    queryDigest: contractDigest({
      schemaVersion: "aginti-grounded-search-actual-query-v1",
      query,
    }),
    mode: candidate.mode,
    queryPlanDigest: candidate.queryPlanDigest,
    queryPolicyDigest: INTEGRATION_GROUNDED_SEARCH_QUERY_POLICY_DIGEST,
    domainPolicyDigest: INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_DIGEST,
    domainConstraintDigest: candidate.domainConstraintDigest,
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

export function validateIntegrationGroundedSearchArtifactAuthority(value) {
  const candidate = exactObject(
    value,
    [
      "schemaVersion",
      "queryDigest",
      "mode",
      "queryPlanDigest",
      "queryPolicyDigest",
      "domainPolicyDigest",
      "domainConstraintDigest",
      "digest",
    ],
    [
      "schemaVersion",
      "queryDigest",
      "mode",
      "queryPlanDigest",
      "queryPolicyDigest",
      "domainPolicyDigest",
      "domainConstraintDigest",
      "digest",
    ],
    "grounded search artifact authority",
    { code: "GROUNDED_SEARCH_INVALID", status: 400 }
  );
  const { digest, ...unsigned } = candidate;
  if (
    candidate.schemaVersion !== INTEGRATION_GROUNDED_SEARCH_ARTIFACT_AUTHORITY_SCHEMA_VERSION ||
    !new Set(["web", "papers", "both"]).has(candidate.mode) ||
    [candidate.queryDigest, candidate.queryPlanDigest, candidate.queryPolicyDigest, candidate.domainPolicyDigest, digest]
      .some((item) => !BARE_DIGEST.test(item)) ||
    (candidate.domainConstraintDigest !== null && !BARE_DIGEST.test(candidate.domainConstraintDigest)) ||
    candidate.queryPolicyDigest !== INTEGRATION_GROUNDED_SEARCH_QUERY_POLICY_DIGEST ||
    candidate.domainPolicyDigest !== INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_DIGEST ||
    digest !== contractDigest(unsigned)
  ) {
    fail("GROUNDED_SEARCH_INVALID", "Grounded search artifact authority is invalid.", { status: 400 });
  }
  return Object.freeze({ ...unsigned, digest });
}

export function integrationGroundedSearchBoundArtifactId(specValue, authorityValue) {
  const spec = validateIntegrationSourcesSpec(specValue);
  const authority = validateIntegrationGroundedSearchArtifactAuthority(authorityValue);
  return `art_${contractDigest({
    schemaVersion: "aginti-grounded-search-bound-artifact-id-v1",
    spec,
    authorityDigest: authority.digest,
  })}`;
}

function plainDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowed, required, label, { code = "GROUNDED_SEARCH_INVALID", status = 500 } = {}) {
  if (!plainDataObject(value)) fail(code, `${label} must be a plain data object.`, { status });
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowedSet.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(code, `${label} contains an unsupported field.`, { status });
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(code, `${label}.${key} is required.`, { status });
    }
  }
  return value;
}

function denseArray(value, label, { minimum = 0, maximum }) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  ) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label} exceeds its entry bound.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= value.length ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label} is not a dense data array.`);
    }
  }
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label} is sparse.`);
    }
    items.push(descriptor.value);
  }
  return Object.freeze(items);
}

function normalizeEndpoint(value) {
  if (value !== INTEGRATION_GROUNDED_SEARCH_ENDPOINT) {
    fail(
      "GROUNDED_SEARCH_CONFIGURATION_INVALID",
      "Grounded search must use the fixed private loopback route.",
      { status: 500 }
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    fail("GROUNDED_SEARCH_CONFIGURATION_INVALID", "Grounded search endpoint is invalid.", {
      status: 500,
      cause: error,
    });
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/api/search/v2" ||
    parsed.search ||
    parsed.hash
  ) {
    fail("GROUNDED_SEARCH_CONFIGURATION_INVALID", "Grounded search endpoint is not the exact private route.", {
      status: 500,
    });
  }
  return parsed.href;
}

function normalizeCredential(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    fail("GROUNDED_SEARCH_CONFIGURATION_INVALID", "Grounded search credential is invalid.", { status: 500 });
  }
  return value;
}

function normalizeTimeout(value, { testOnly = false } = {}) {
  const timeoutMs = value ?? INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS;
  const minimum = testOnly ? 1_000 : INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < minimum || timeoutMs > 120_000) {
    fail("GROUNDED_SEARCH_CONFIGURATION_INVALID", "Grounded search timeout is invalid.", { status: 500 });
  }
  return timeoutMs;
}

function normalizeMaximumSources(value) {
  const maximumSources = value ?? INTEGRATION_MAXIMUM_SEARCH_SOURCES;
  if (maximumSources !== INTEGRATION_MAXIMUM_SEARCH_SOURCES) {
    fail("GROUNDED_SEARCH_CONFIGURATION_INVALID", "Grounded search source limit is fixed.", { status: 500 });
  }
  return maximumSources;
}

function normalizeAbortSignal(value, label = "grounded search signal") {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) {
    fail("GROUNDED_SEARCH_INVALID", `${label} must be an AbortSignal.`, { status: 400 });
  }
  return value;
}

const QUERY_TOKEN_WRAPPING = "\"'`()[]{}<>,;.!?*“”‘’「」『』【】（）《》«»‹›„｢｣〈〉〔〕［］_~";
const QUERY_DOI_TOKEN = /^10\.[0-9]{4,9}\/\S+$/iu;
const QUERY_SCOPED_PACKAGE_TOKEN = /^@[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu;
const QUERY_DOTTED_RUNTIME_PATH_TOKEN =
  /^(?:v?[0-9]+(?:\.[0-9]+){1,4}|[a-z][a-z0-9_-]*[0-9]*(?:\.[0-9]+)+)\/[a-z0-9_.-]+$/iu;
const QUERY_REVERSE_DOMAIN_NAMESPACE_TOKEN =
  /^(?:com|org|net|io|edu)\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\/[a-z0-9_./-]+$/iu;
const QUERY_LOCAL_PATH_TOKEN =
  /^(?:[a-z]:[\\/]|\\\\|\/(?!\/)|~(?:[a-z0-9._-]+)?[\\/]|\.{1,2}[\\/]|\$(?:HOME|PWD)[\\/]|\$\{(?:HOME|PWD)\}[\\/]|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH)%[\\/])/iu;
const QUERY_URL_SCHEME = /^(?:(?:[a-z][a-z0-9+.-]*):\/{2}|(?:file|data):)/iu;
const QUERY_OPAQUE_URI = /^(?:bitcoin|did|ethereum|geo|lightning|magnet|mailto|monero|news|otpauth|sip|sips|sms|tel|urn|webcal|xmpp):\S+$/iu;
const QUERY_VISIBLE_PUBLIC_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/iu;

function stripQueryWrapping(value) {
  let start = 0;
  let end = value.length;
  while (start < end && QUERY_TOKEN_WRAPPING.includes(value[start])) start += 1;
  while (end > start && QUERY_TOKEN_WRAPPING.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function queryTokenLooksLikePublicHost(hostname) {
  const domain = String(hostname || "").toLowerCase().replace(/\.$/u, "");
  return DNS_NAME.test(domain) && hasRegistrablePublicDomain(domain);
}

function queryTokenPrivacyReplacement(token) {
  const cleaned = stripQueryWrapping(String(token || ""));
  if (!cleaned || QUERY_DOI_TOKEN.test(cleaned) || QUERY_SCOPED_PACKAGE_TOKEN.test(cleaned)) return null;
  const decoded = decodeURIComponentSafe(cleaned);
  if (/^file:/iu.test(cleaned) || /^file:/iu.test(decoded)) return "local path";
  if (QUERY_LOCAL_PATH_TOKEN.test(cleaned) || QUERY_LOCAL_PATH_TOKEN.test(decoded)) return "local path";
  if (QUERY_DOTTED_RUNTIME_PATH_TOKEN.test(cleaned) || QUERY_REVERSE_DOMAIN_NAMESPACE_TOKEN.test(cleaned)) return null;
  if (QUERY_OPAQUE_URI.test(cleaned)) return "network resource";
  const normalized = decodeURIComponentSafe(cleaned).replace(/\\/gu, "/");
  if (QUERY_LOCAL_PATH_TOKEN.test(normalized)) return "local path";
  if (QUERY_URL_SCHEME.test(cleaned) || cleaned.startsWith("//")) {
    const scheme = /^([a-z][a-z0-9+.-]*):\/{2}/iu.exec(cleaned)?.[1]?.toLowerCase();
    if (scheme !== undefined && scheme !== "http" && scheme !== "https") return "network resource";
    try {
      const parsed = new URL(cleaned.startsWith("//") ? `https:${normalized}` : normalized);
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
      return queryTokenLooksLikePublicHost(hostname) ? hostname : "network resource";
    } catch {
      return "network resource";
    }
  }
  if (!/[\\/?#@]/u.test(cleaned)) return null;
  const authority = normalized
    .replace(/^\/\//u, "")
    .split("/", 1)[0]
    .split("?", 1)[0]
    .split("#", 1)[0]
    .split("@")
    .at(-1)
    .split(":", 1)[0]
    .toLowerCase();
  if (queryTokenLooksLikePublicHost(authority) || QUERY_VISIBLE_PUBLIC_HOST.test(authority)) return authority;
  return null;
}

function decodeURIComponentSafe(value) {
  let decoded = String(value || "");
  for (let index = 0; index < 3; index += 1) {
    try {
      const updated = decodeURIComponent(decoded);
      if (updated === decoded) break;
      decoded = updated;
    } catch {
      break;
    }
  }
  return decoded;
}

function providerSafeQuery(value) {
  const text = String(value || "");
  const tokens = text.split(/\s+/u).map((token) => queryTokenPrivacyReplacement(token) ?? token);
  const normalized = tokens.join(" ").replace(
    /(?:^|[^\w/\\])(?:[a-z]:[\\/]|\\\\|\/(?!\/)|~(?:[a-z0-9._-]+)?[\\/]|\.{1,2}[\\/])\S*/giu,
    (match) => `${match[0]?.match(/[\w/\\]/u) ? "" : match[0]}local path`
  );
  return normalized.replace(/\s+/gu, " ").trim();
}

function boundedQuery(value) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search query is invalid.", { status: 400 });
  }
  const normalized = providerSafeQuery(value.normalize("NFC").replace(/\s+/gu, " ").trim());
  const codePointLength = Array.from(normalized).length;
  if (codePointLength > MAX_QUERY_CHARACTERS) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search query exceeds its bounded contract.", {
      status: 400,
    });
  }
  const query = normalized;
  if (codePointLength < 3) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search query must contain at least three characters.", {
      status: 400,
    });
  }
  return query;
}

function clippedText(value, maximumCharacters) {
  if (typeof value !== "string") return "";
  return Array.from(value).slice(0, maximumCharacters).join("");
}

async function waitWithAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason || new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      promise.catch(() => {});
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function requestAbort(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason || new Error("cancelled"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("grounded search timeout"));
  }, timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  });
}

function discardResponseBody(response, reason) {
  try {
    Promise.resolve(response?.body?.cancel?.(reason)).catch(() => {});
  } catch {
    // The response is already detached or an untrusted transport object.
  }
}

function boundedRetryAfterMs(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (raw === null || raw === undefined || raw === "") return null;
  const value = String(raw).trim();
  if (/^(?:0|[1-9][0-9]{0,5})$/u.test(value)) {
    return Math.min(Number(value) * 1000, 3_600_000);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(parsed - Date.now(), 3_600_000));
}

async function readBoundedBody(response, signal) {
  const cacheControl = String(response.headers?.get?.("cache-control") || "");
  if (!cacheControl.split(",").some((directive) => directive.trim().toLowerCase() === "no-store")) {
    discardResponseBody(response, new Error("unguarded grounded search response"));
    fail(
      "GROUNDED_SEARCH_ROUTE_UNGUARDED",
      "Grounded search response did not prove the guarded no-store relay boundary.",
      { status: 503 }
    );
  }
  const hasSetCookie = typeof response.headers?.has === "function"
    ? response.headers.has("set-cookie")
    : response.headers?.get?.("set-cookie") !== null && response.headers?.get?.("set-cookie") !== undefined;
  if (hasSetCookie) {
    discardResponseBody(response, new Error("stateful grounded search response"));
    fail(
      "GROUNDED_SEARCH_ROUTE_UNGUARDED",
      "Grounded search response attempted to establish browser or relay state.",
      { status: 503 }
    );
  }
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && declared !== "") {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES) {
      discardResponseBody(response, new Error("oversized grounded search response"));
      fail("GROUNDED_SEARCH_RESPONSE_TOO_LARGE", "Grounded search response exceeded its byte bound.", {
        status: 502,
      });
    }
  }
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    discardResponseBody(response, new Error("invalid grounded search content type"));
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search did not return JSON.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search response body is not a bounded stream.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await waitWithAbort(reader.read(), signal);
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search response stream yielded an invalid chunk.");
      }
      const chunk = value;
      total += chunk.byteLength;
      if (total > INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES) {
        Promise.resolve(reader.cancel()).catch(() => {});
        fail("GROUNDED_SEARCH_RESPONSE_TOO_LARGE", "Grounded search response exceeded its byte bound.");
      }
      chunks.push(chunk);
    }
  } finally {
    if (!completed) Promise.resolve(reader.cancel(signal.reason)).catch(() => {});
    try {
      reader.releaseLock?.();
    } catch {
      // Fetch cancellation may already have detached the reader.
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function normalizeExactIdentifierList(value, label, { maximum = MAXIMUM_EXACT_IDENTIFIERS } = {}) {
  const identifiers = denseArray(value, label, { minimum: 0, maximum }).map((item) => normalizeExactIdentifier(item));
  const keys = identifiers.map(exactIdentifierKey);
  const sorted = [...keys].sort(compareCodePointText);
  if (keys.length !== new Set(keys).size || keys.some((key, index) => key !== sorted[index])) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label} are not canonical.`);
  }
  return Object.freeze(identifiers.map((identifier) => Object.freeze({ kind: identifier.kind, value: identifier.value })));
}

function sameExactIdentifierList(left, right) {
  if (left.length !== right.length) return false;
  return left.every((identifier, index) =>
    identifier.kind === right[index]?.kind && identifier.value === right[index]?.value
  );
}

function normalizeLocalllmExactIdentifier(value, label) {
  const candidate = exactObject(
    value,
    ["kind", "value"],
    ["kind", "value"],
    label,
    { code: "GROUNDED_SEARCH_PROTOCOL_INVALID", status: 502 }
  );
  if (candidate.kind === "arxiv") {
    const normalized = normalizeArxivIdentifier(candidate.value);
    if (normalized !== candidate.value) {
      fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label} is not canonical.`);
    }
    return Object.freeze({ kind: "arxiv", value: normalized });
  }
  if (candidate.kind === "doi") {
    const normalized = normalizeDoiIdentifier(candidate.value);
    if (normalized !== candidate.value || normalized.startsWith("10.48550/arxiv.")) {
      fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label} is not canonical.`);
    }
    return Object.freeze({ kind: "doi", value: normalized });
  }
  fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label} kind is invalid.`);
}

function normalizeLocalllmExactIdentifierList(value, label, { maximum = MAXIMUM_EXACT_IDENTIFIERS } = {}) {
  const identifiers = denseArray(value, label, { minimum: 0, maximum })
    .map((item, index) => normalizeLocalllmExactIdentifier(item, `${label}[${index}]`));
  const keys = identifiers.map(exactIdentifierKey);
  const sorted = [...keys].sort(compareCodePointText);
  if (keys.length !== new Set(keys).size || keys.some((key, index) => key !== sorted[index])) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label} are not canonical.`);
  }
  return Object.freeze(identifiers.map((identifier) => Object.freeze({ kind: identifier.kind, value: identifier.value })));
}

function normalizeLocalllmAllowedDomain(value, label) {
  const normalized = normalizedDomain(value);
  if (normalized !== value) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label} is not canonical.`);
  }
  return normalized;
}

function arxivVersionParts(identifier) {
  const match = /^(.+?)(v[1-9][0-9]*)$/u.exec(identifier);
  return Object.freeze({
    root: match ? match[1] : identifier,
    version: match ? match[2] : null,
  });
}

function identifierMatchType(requested, returned) {
  if (requested.kind === "doi") {
    return requested.kind === returned.kind && requested.value === returned.value ? "exact" : null;
  }
  if (returned.kind !== "arxiv") return null;
  const requestedParts = arxivVersionParts(requested.value);
  const returnedParts = arxivVersionParts(returned.value);
  if (requestedParts.root !== returnedParts.root) return null;
  if (requestedParts.version !== null) return requestedParts.version === returnedParts.version ? "exact" : null;
  return returnedParts.version === null ? "exact" : "arxiv-root";
}

function identifierMatches(requested, returnedIdentifiers) {
  return returnedIdentifiers.some((identifier) => identifierMatchType(requested, identifier) !== null);
}

function matchedExactIdentifiers(requestedIdentifiers, returnedIdentifiers) {
  const matches = [];
  for (const requested of requestedIdentifiers) {
    for (const returned of returnedIdentifiers) {
      const matchType = identifierMatchType(requested, returned);
      if (matchType === null) continue;
      matches.push(Object.freeze({
        requested: Object.freeze({ kind: requested.kind, value: requested.value }),
        returned: Object.freeze({ kind: returned.kind, value: returned.value }),
        matchType,
      }));
    }
  }
  return Object.freeze(matches);
}

function normalizeMatchedExactIdentifiers(value, label) {
  return Object.freeze(denseArray(value, label, { minimum: 0, maximum: MAXIMUM_EXACT_IDENTIFIERS * 2 }).map((item, index) => {
    const match = exactObject(
      item,
      ["requested", "returned", "matchType"],
      ["requested", "returned", "matchType"],
      `${label}[${index}]`,
      { code: "GROUNDED_SEARCH_PROTOCOL_INVALID", status: 502 }
    );
    if (match.matchType !== "exact" && match.matchType !== "arxiv-root") {
      fail("GROUNDED_SEARCH_PROTOCOL_INVALID", `${label}[${index}].matchType is invalid.`);
    }
    return Object.freeze({
      requested: normalizeLocalllmExactIdentifier(match.requested, `${label}[${index}].requested`),
      returned: normalizeLocalllmExactIdentifier(match.returned, `${label}[${index}].returned`),
      matchType: match.matchType,
    });
  }));
}

function matchingAllowedDomains(domain, allowedDomains) {
  return Object.freeze(allowedDomains.filter((allowed) => domain === allowed || domain.endsWith(`.${allowed}`)));
}

function sameCanonicalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function parseResponse(bytes, request, wireRequest) {
  let value;
  try {
    value = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (error) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search returned invalid JSON.", { cause: error });
  }
  const response = exactObject(
    value,
    [
      "schemaVersion",
      "policyCompliant",
      "request",
      "sources",
      "providers",
      "warnings",
      "resolvedIdentifiers",
      "unresolvedIdentifiers",
      "returnedIdentityBinding",
    ],
    [
      "schemaVersion",
      "policyCompliant",
      "request",
      "sources",
      "providers",
      "warnings",
      "resolvedIdentifiers",
      "unresolvedIdentifiers",
      "returnedIdentityBinding",
    ],
    "grounded search response",
    { code: "GROUNDED_SEARCH_PROTOCOL_INVALID", status: 502 }
  );
  if (
    response.schemaVersion !== LOCALLLM_GROUNDED_SEARCH_RESPONSE_SCHEMA_VERSION ||
    response.policyCompliant !== true ||
    !sameCanonicalJson(response.request, wireRequest)
  ) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search response identity is invalid.");
  }
  const sourceRecords = denseArray(response.sources, "grounded search sources", {
    minimum: 0,
    maximum: request.limit,
  }).map((source, index) => publicSource(source, index + 1, wireRequest));
  const sources = Object.freeze(sourceRecords.map((record) => record.source));
  const returnedIdentities = Object.freeze(sourceRecords.map((record) => record.identity));
  const returnedIdentityBinding = normalizeLocalllmDigest(
    response.returnedIdentityBinding,
    "grounded search returned identity binding"
  );
  const expectedReturnedIdentityBinding = localllmDigest({
    queryPlanDigest: wireRequest.constraints.queryPlanDigest,
    policyDigest: wireRequest.constraints.policyDigest,
    returnedIdentities,
  });
  if (returnedIdentityBinding !== expectedReturnedIdentityBinding) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search returned identity binding digest is invalid.");
  }
  const resolvedExactIdentifiers = normalizeLocalllmExactIdentifierList(
    response.resolvedIdentifiers,
    "grounded search resolved exact identifiers"
  );
  const unresolvedExactIdentifiers = normalizeLocalllmExactIdentifierList(
    response.unresolvedIdentifiers,
    "grounded search unresolved exact identifiers"
  );
  const expectedResolved = Object.freeze(wireRequest.constraints.exactIdentifiers.filter((identifier) =>
    sourceRecords.some((record) => identifierMatches(identifier, record.identifiers))
  ));
  const expectedUnresolved = Object.freeze(wireRequest.constraints.exactIdentifiers.filter((identifier) =>
    !sourceRecords.some((record) => identifierMatches(identifier, record.identifiers))
  ));
  if (
    !sameExactIdentifierList(resolvedExactIdentifiers, expectedResolved) ||
    !sameExactIdentifierList(unresolvedExactIdentifiers, expectedUnresolved)
  ) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search exact identifier coverage is not bound to sources.");
  }
  if (request.structuredConstraints.strategy === "exact" && unresolvedExactIdentifiers.length > 0) {
    fail("GROUNDED_SEARCH_IDENTIFIER_CONSTRAINT_FAILED", "Grounded search exact identifier coverage is incomplete.");
  }
  if (request.structuredConstraints.strategy === "ranked" &&
    (resolvedExactIdentifiers.length > 0 || unresolvedExactIdentifiers.length > 0)) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Ranked grounded search returned exact identifier coverage.");
  }
  const providers = denseArray(response.providers, "grounded search providers", { minimum: 0, maximum: 64 });
  const warnings = denseArray(response.warnings, "grounded search warnings", { minimum: 0, maximum: 64 });
  for (let index = 0; index < providers.length; index += 1) {
    const provider = exactObject(
      providers[index],
      PROVIDER_DIAGNOSTIC_KEYS,
      PROVIDER_DIAGNOSTIC_KEYS,
      `grounded search providers[${index}]`,
      { code: "GROUNDED_SEARCH_PROTOCOL_INVALID", status: 502 }
    );
    const queries = denseArray(provider.queries, `grounded search providers[${index}].queries`, {
      minimum: 0,
      maximum: 30,
    });
    if (
      typeof provider.name !== "string" ||
      provider.name.length < 1 ||
      provider.name.length > 100 ||
      typeof provider.kind !== "string" ||
      !new Set(["web", "paper"]).has(provider.kind) ||
      typeof provider.ok !== "boolean" ||
      !Number.isSafeInteger(provider.result_count) ||
      provider.result_count < 0 ||
      !Number.isSafeInteger(provider.duration_ms) ||
      provider.duration_ms < 0 ||
      (provider.error !== null && (typeof provider.error !== "string" || provider.error.length > 2_000)) ||
      queries.some((query) => typeof query !== "string" || query.length > MAX_QUERY_CHARACTERS)
    ) {
      fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search provider diagnostics are invalid.");
    }
  }
  for (const warning of warnings) {
    if (typeof warning !== "string" || warning.length > 2_000) {
      fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search warnings are invalid.");
    }
  }
  return Object.freeze({
    schemaVersion: response.schemaVersion,
    policyCompliant: response.policyCompliant,
    request: wireRequest,
    query: wireRequest.query,
    mode: wireRequest.mode,
    limit: wireRequest.limit,
    sources,
    providers,
    warnings,
    resolvedIdentifiers: resolvedExactIdentifiers,
    unresolvedIdentifiers: unresolvedExactIdentifiers,
    returnedIdentityBinding,
  });
}

function publicSource(raw, index, wireRequest) {
  exactObject(raw, SOURCE_KEYS, SOURCE_KEYS, `grounded search source[${index - 1}]`, {
    code: "GROUNDED_SEARCH_PROTOCOL_INVALID",
    status: 502,
  });
  if (!Number.isSafeInteger(raw.rank) || raw.rank !== index) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source ranks are not contiguous.");
  }
  if (typeof raw.url !== "string" || raw.url !== raw.canonicalUrl) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source canonical URL is invalid.");
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(raw.canonicalUrl);
  } catch (error) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source canonical URL is invalid.", {
      cause: error,
    });
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.hostname.toLowerCase().replace(/\.$/u, "") !== raw.domain
  ) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source domain proof is invalid.");
  }
  normalizedDomain(raw.domain);
  const identifiers = normalizeLocalllmExactIdentifierList(
    raw.identifiers,
    `grounded search source[${index - 1}].identifiers`
  );
  const expectedDoi = identifiers.find((identifier) => identifier.kind === "doi")?.value ?? null;
  if (raw.doi !== expectedDoi) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source DOI does not match its identifiers.");
  }
  const identityDigest = normalizeLocalllmDigest(
    raw.identityDigest,
    `grounded search source[${index - 1}].identity`
  );
  if (
    identityDigest !== localllmDigest({
      canonicalUrl: raw.canonicalUrl,
      domain: raw.domain,
      identifiers,
    })
  ) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source identity digest is invalid.");
  }
  const matchedAllowedDomains = Object.freeze(denseArray(
    raw.matchedAllowedDomains,
    `grounded search source[${index - 1}].matchedAllowedDomains`,
    { minimum: 0, maximum: MAXIMUM_ALLOWED_DOMAINS }
  ).map((domain, offset) => normalizeLocalllmAllowedDomain(
      domain,
      `grounded search source[${index - 1}].matchedAllowedDomains[${offset}]`
    )));
  const expectedAllowedDomains = matchingAllowedDomains(raw.domain, wireRequest.constraints.allowedDomains);
  if (
    matchedAllowedDomains.length !== expectedAllowedDomains.length ||
    matchedAllowedDomains.some((domain, offset) => domain !== expectedAllowedDomains[offset])
  ) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source allowed-domain proof is invalid.");
  }
  if (wireRequest.constraints.allowedDomains.length > 0 && matchedAllowedDomains.length === 0) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source is outside the requested domains.");
  }
  const matchedIdentifiers = normalizeMatchedExactIdentifiers(
    raw.matchedExactIdentifiers,
    `grounded search source[${index - 1}].matchedExactIdentifiers`
  );
  const expectedMatchedIdentifiers = matchedExactIdentifiers(wireRequest.constraints.exactIdentifiers, identifiers);
  if (!sameCanonicalJson(matchedIdentifiers, expectedMatchedIdentifiers)) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source exact-identifier proof is invalid.");
  }
  if (wireRequest.constraints.strategy === "exact" && matchedIdentifiers.length === 0) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Exact grounded search source has no requested identity match.");
  }
  const providerValues = denseArray(raw.providers, `grounded search source[${index - 1}].providers`, {
    minimum: 0,
    maximum: 20,
  });
  denseArray(raw.authors, `grounded search source[${index - 1}].authors`, {
    minimum: 0,
    maximum: 100,
  });
  denseArray(raw.provenance, `grounded search source[${index - 1}].provenance`, {
    minimum: 0,
    maximum: 64,
  });
  if (
    typeof raw.title !== "string" ||
    typeof raw.snippet !== "string" ||
    typeof raw.provider !== "string" ||
    typeof raw.kind !== "string" ||
    raw.title.length < 1 ||
    raw.provider.length < 1 ||
    !new Set(["web", "paper"]).has(raw.kind) ||
    raw.query !== wireRequest.query ||
    (raw.published_date !== null && typeof raw.published_date !== "string") ||
    (raw.year !== null && (!Number.isSafeInteger(raw.year) || raw.year < 0)) ||
    (raw.citation_count !== null && (!Number.isSafeInteger(raw.citation_count) || raw.citation_count < 0)) ||
    typeof raw.score !== "number" ||
    !Number.isFinite(raw.score)
  ) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source presentation fields are invalid.");
  }
  if (providerValues.some((provider) => typeof provider !== "string" || provider.length < 1 || provider.length > 100)) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search source providers are invalid.");
  }
  const providers = [...new Set([
    ...providerValues.filter((provider) => typeof provider === "string"),
    ...(typeof raw.provider === "string" ? [raw.provider] : []),
  ].map((provider) => clippedText(provider.trim(), 100)).filter(Boolean))].slice(0, 12);
  const candidate = Object.freeze({
    index: 1,
    title: clippedText(raw.title, 500),
    url: raw.canonicalUrl,
    snippet: clippedText(raw.snippet, MAX_PUBLIC_SNIPPET_CHARACTERS),
    providers: Object.freeze(providers),
    kind: raw.kind === "paper" ? "paper" : raw.kind === "web" ? "web" : "",
    publishedDate: raw.published_date === null ? null : raw.published_date,
    doi: raw.doi === null ? null : raw.doi,
  });
  const validated = validateIntegrationSourcesSpec({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    sources: [candidate],
  }).sources[0];
  return Object.freeze({
    source: Object.freeze({ ...validated, index }),
    identifiers,
    identity: Object.freeze({
      rank: index,
      identityDigest,
      matchedAllowedDomains,
      matchedExactIdentifiers: matchedIdentifiers,
    }),
  });
}

function sourceArtifact(response, limit, request) {
  const sources = [];
  for (const raw of response.sources.slice(0, limit)) {
    try {
      sources.push(Object.freeze({ ...raw, index: sources.length + 1 }));
    } catch {
      // Individual provider records are untrusted. Omit invalid presentation data.
    }
  }
  if (sources.length === 0) {
    fail("GROUNDED_SEARCH_NO_USABLE_SOURCES", "Search providers returned no safe evidence sources.", {
      status: 502,
    });
  }
  while (sources.length > 0) {
    try {
      const spec = Object.freeze({
        schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
        sources: Object.freeze([...sources]),
      });
      const authority = createIntegrationGroundedSearchArtifactAuthority({
        query: response.query,
        mode: response.mode,
        queryPlanDigest: request.queryPlanDigest,
        domainConstraintDigest: request.domainConstraintDigest,
      });
      const artifact = sanitizeIntegrationArtifact({
        id: integrationGroundedSearchBoundArtifactId(spec, authority),
        title: "Grounded sources",
        kind: "sources",
        spec,
      });
      if (Buffer.byteLength(JSON.stringify(artifact), "utf8") > MAX_INTEGRATION_PUBLIC_ARTIFACT_BYTES) {
        throw new Error("artifact too large");
      }
      return artifact;
    } catch {
      sources.pop();
      for (let index = 0; index < sources.length; index += 1) {
        sources[index] = Object.freeze({ ...sources[index], index: index + 1 });
      }
    }
  }
  fail("GROUNDED_SEARCH_NO_USABLE_SOURCES", "Search providers returned no bounded evidence sources.");
}

function normalizeSearchRequestIdentifiers(value, label, normalizer) {
  if (value === undefined) return Object.freeze([]);
  const identifiers = denseArray(value, label, { minimum: 0, maximum: MAXIMUM_EXACT_IDENTIFIERS })
    .map((item) => normalizer(item));
  return uniqueBoundedIdentifiers(identifiers, label);
}

function normalizeAllowedDomains(value) {
  if (value === undefined) return Object.freeze([]);
  const domains = denseArray(value, "grounded search allowed domains", {
    minimum: 0,
    maximum: MAXIMUM_ALLOWED_DOMAINS,
  }).map((domain) => normalizedDomain(domain));
  const canonical = [...new Set(domains)].sort(compareCodePointText);
  if (canonical.length !== domains.length || canonical.some((domain, index) => domain !== domains[index])) {
    fail("GROUNDED_SEARCH_INVALID", "Grounded search allowed domains are not canonical.", { status: 400 });
  }
  return Object.freeze(canonical);
}

function domainConstraintDigestForDomains(allowedDomains) {
  if (allowedDomains.length === 0) return null;
  return contractDigest({
    schemaVersion: INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_SCHEMA_VERSION,
    domains: allowedDomains,
  });
}

function groundedSearchRequestPolicyDigest(request, strategy, exactIdentifiers) {
  return localllmDigest({
    schemaVersion: LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION,
    query: request.query,
    mode: request.mode,
    limit: request.limit,
    constraints: {
      schemaVersion: LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION,
      strategy,
      allowedDomains: request.allowedDomains,
      exactIdentifiers,
    },
  });
}

function structuredSearchConstraints(request) {
  const exactIdentifiers = canonicalExactIdentifiers(request.arxivIdentifiers, request.doiIdentifiers);
  const strategy = exactIdentifiers.length > 0 ? "exact" : "ranked";
  const unsigned = Object.freeze({
    schemaVersion: LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION,
    strategy,
    allowedDomains: request.allowedDomains,
    exactIdentifiers,
    queryPlanDigest: `sha256:${request.queryPlanDigest}`,
    policyDigest: groundedSearchRequestPolicyDigest(request, strategy, exactIdentifiers),
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function structuredSearchConstraintsForWire(constraints) {
  const candidate = exactObject(
    constraints,
    ["schemaVersion", "strategy", "allowedDomains", "exactIdentifiers", "queryPlanDigest", "policyDigest", "digest"],
    ["schemaVersion", "strategy", "allowedDomains", "exactIdentifiers", "queryPlanDigest", "policyDigest", "digest"],
    "grounded search structured constraints",
    { code: "GROUNDED_SEARCH_INVALID", status: 400 }
  );
  const { digest: _internalDigest, ...wire } = candidate;
  return Object.freeze(wire);
}

function localllmGroundedSearchRequestPayload(request) {
  return Object.freeze({
    schemaVersion: LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION,
    query: request.query,
    mode: request.mode,
    limit: request.limit,
    constraints: structuredSearchConstraintsForWire(request.structuredConstraints),
  });
}

function normalizeSearchRequest(value) {
  const request = exactObject(
    value,
    [
      "query",
      "mode",
      "limit",
      "signal",
      "queryPlanDigest",
      "domainConstraintDigest",
      "allowedDomains",
      "arxivIdentifiers",
      "doiIdentifiers",
    ],
    ["query", "mode", "limit"],
    "grounded search request",
    {
    code: "GROUNDED_SEARCH_INVALID",
    status: 400,
    }
  );
  const search = validateIntegrationSearch({ mode: request.mode, limit: request.limit });
  const query = boundedQuery(request.query);
  const queryPlanDigest = normalizeInternalDigest(request.queryPlanDigest ?? contractDigest({
    schemaVersion: "aginti-grounded-search-direct-query-plan-v1",
    query,
    mode: search.mode,
  }), "Grounded search query-plan");
  const allowedDomains = request.allowedDomains === undefined
    ? Object.freeze([...(deriveIntegrationGroundedSearchDomainConstraint(query)?.domains || [])])
    : normalizeAllowedDomains(request.allowedDomains);
  const expectedDomainConstraintDigest = domainConstraintDigestForDomains(allowedDomains);
  const domainConstraintDigest = request.domainConstraintDigest ?? expectedDomainConstraintDigest;
  if (domainConstraintDigest !== null && !BARE_DIGEST.test(domainConstraintDigest)) {
    fail("GROUNDED_SEARCH_INVALID", "Grounded search domain-constraint digest is invalid.", { status: 400 });
  }
  if (domainConstraintDigest !== expectedDomainConstraintDigest) {
    fail("GROUNDED_SEARCH_INVALID", "Grounded search domain authority does not match its allowed domains.", {
      status: 400,
    });
  }
  const arxivIdentifiers = normalizeSearchRequestIdentifiers(
    request.arxivIdentifiers,
    "grounded search arXiv identifiers",
    normalizeArxivIdentifier
  );
  assertNoConflictingArxivVersions(arxivIdentifiers);
  const doiIdentifiers = normalizeSearchRequestIdentifiers(
    request.doiIdentifiers,
    "grounded search DOI identifiers",
    normalizeDoiIdentifier
  );
  if (arxivIdentifiers.length + doiIdentifiers.length > MAXIMUM_EXACT_IDENTIFIERS) {
    fail("GROUNDED_SEARCH_INVALID", "Grounded search exact identifier set exceeds its bound.", { status: 400 });
  }
  if (arxivIdentifiers.length + doiIdentifiers.length > search.limit) {
    fail("GROUNDED_SEARCH_INVALID", "Grounded search source limit cannot cover the exact identifiers.", {
      status: 400,
    });
  }
  if (search.mode === "web" && arxivIdentifiers.length + doiIdentifiers.length > 0) {
    fail("GROUNDED_SEARCH_INVALID", "Grounded search exact identifier strategy requires papers or both mode.", {
      status: 400,
    });
  }
  const normalized = Object.freeze({
    query,
    mode: search.mode,
    limit: search.limit,
    queryPlanDigest,
    domainConstraintDigest,
    allowedDomains,
    arxivIdentifiers,
    doiIdentifiers,
    signal: normalizeAbortSignal(request.signal),
  });
  return Object.freeze({ ...normalized, structuredConstraints: structuredSearchConstraints(normalized) });
}

function doiFromUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    if (parsed.hostname.toLowerCase() !== "doi.org") return null;
    return normalizeDoiIdentifier(decodeURIComponent(parsed.pathname.slice(1)));
  } catch {
    return null;
  }
}

function arxivFromUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    if (!hostnameWithinDomain(parsed.hostname, "arxiv.org")) return null;
    const match = /^\/(?:abs|pdf)\/([^/?#]+?)(?:\.pdf)?$/u.exec(parsed.pathname);
    return match ? normalizeArxivIdentifier(match[1]) : null;
  } catch {
    return null;
  }
}

function addCanonicalDoiBinding(doiSet, arxivSet, value) {
  const normalizedDoi = normalizeDoiIdentifier(value);
  if (normalizedDoi.startsWith("10.48550/arxiv.")) {
    arxivSet.add(normalizeArxivIdentifier(normalizedDoi.slice("10.48550/arxiv.".length)));
  } else {
    doiSet.add(normalizedDoi);
  }
}

function sourceIdentifierBindings(source) {
  const arxiv = new Set();
  const doi = new Set();
  const urlArxiv = arxivFromUrl(source.url);
  if (urlArxiv) arxiv.add(urlArxiv);
  const urlDoi = doiFromUrl(source.url);
  if (urlDoi) addCanonicalDoiBinding(doi, arxiv, urlDoi);
  if (source.doi !== null) {
    addCanonicalDoiBinding(doi, arxiv, source.doi);
  }
  return Object.freeze({ arxiv: Object.freeze([...arxiv]), doi: Object.freeze([...doi]) });
}

function sourceIdentifierObjects(source) {
  const bindings = sourceIdentifierBindings(source);
  return canonicalExactIdentifiers(bindings.arxiv, bindings.doi);
}

function assertIntegrationGroundedSearchIdentifierSources(grounding, request) {
  const requested = request.structuredConstraints.exactIdentifiers;
  if (requested.length === 0) return grounding;
  const seen = new Set();
  for (const source of grounding.sources) {
    const bindings = sourceIdentifierObjects(source);
    const sourceMatches = [];
    for (const wanted of requested) {
      if (bindings.some((identifier) => identifierMatchType(wanted, identifier) !== null)) {
        sourceMatches.push(wanted);
      }
    }
    if (sourceMatches.length === 0) {
      fail("GROUNDED_SEARCH_IDENTIFIER_CONSTRAINT_FAILED", "Exact identifier search returned an unbound source.");
    }
    for (const identifier of sourceMatches) {
      seen.add(exactIdentifierKey(identifier));
    }
  }
  for (const identifier of requested) {
    if (!seen.has(exactIdentifierKey(identifier))) {
      fail("GROUNDED_SEARCH_IDENTIFIER_CONSTRAINT_FAILED", "Exact identifier search missed a requested source.");
    }
  }
  return grounding;
}

function createClient(optionsValue, { testOnly }) {
  const options = exactObject(
    optionsValue,
    testOnly ? ["endpoint", "apiKey", "timeoutMs", "maximumSources", "fetchImpl"] : ["endpoint", "apiKey", "timeoutMs", "maximumSources"],
    testOnly ? ["endpoint", "apiKey", "fetchImpl"] : ["endpoint", "apiKey"],
    "grounded search client configuration",
    { code: "GROUNDED_SEARCH_CONFIGURATION_INVALID", status: 500 }
  );
  const endpoint = normalizeEndpoint(options.endpoint);
  const apiKey = normalizeCredential(options.apiKey);
  const timeoutMs = normalizeTimeout(options.timeoutMs, { testOnly });
  const maximumSources = normalizeMaximumSources(options.maximumSources);
  const fetchImpl = testOnly ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    fail("GROUNDED_SEARCH_CONFIGURATION_INVALID", "Grounded search transport is unavailable.", { status: 500 });
  }
  let activation = null;
  let activationPromise = null;

  async function execute(value, { readiness = false } = {}) {
    const request = normalizeSearchRequest(value);
    const wireRequest = localllmGroundedSearchRequestPayload(request);
    const payload = JSON.stringify(wireRequest);
    if (Buffer.byteLength(payload, "utf8") > INTEGRATION_GROUNDED_SEARCH_MAX_REQUEST_BYTES) {
      fail("GROUNDED_SEARCH_REQUEST_TOO_LARGE", "Grounded search request exceeded its byte bound.", { status: 413 });
    }
    const abort = requestAbort(request.signal, timeoutMs);
    try {
      if (abort.signal.aborted) throw abort.signal.reason || new Error("grounded search aborted");
      const response = await waitWithAbort(
        Promise.resolve(fetchImpl(endpoint, {
          method: "POST",
          headers: Object.freeze({
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          }),
          body: payload,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: abort.signal,
        })),
        abort.signal
      );
      if (!response || typeof response.status !== "number") {
        discardResponseBody(response, new Error("grounded search unavailable"));
        fail("GROUNDED_SEARCH_UNAVAILABLE", "The private grounded search route is unavailable.", { status: 503 });
      }
      if (response.status === 401 || response.status === 403) {
        discardResponseBody(response, new Error("grounded search auth failed"));
        fail("GROUNDED_SEARCH_AUTH_FAILED", "The private grounded search credential was rejected.", {
          status: 503,
        });
      }
      if (response.status !== 200) {
        discardResponseBody(response, new Error("grounded search failed"));
        if (response.status === 400 || response.status === 422) {
          fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "The private grounded search route rejected the v2 request.", {
            status: 502,
          });
        }
        if (response.status === 409) {
          fail(
            "GROUNDED_SEARCH_IDENTIFIER_CONSTRAINT_FAILED",
            "The private grounded search route reported an exact-identifier constraint conflict.",
            { status: 409 }
          );
        }
        if (response.status === 413) {
          fail("GROUNDED_SEARCH_REQUEST_TOO_LARGE", "Grounded search request exceeded its byte bound.", {
            status: 413,
          });
        }
        if (response.status === 429) {
          fail("GROUNDED_SEARCH_BUSY", "The private grounded search route is busy; retry later.", {
            status: 429,
            retryable: true,
            runtimeStatus: 429,
            runtimeClassification: "capacity_busy",
            retryAfterMs: boundedRetryAfterMs(response),
          });
        }
        if (response.status === 504) {
          fail("GROUNDED_SEARCH_TIMEOUT", "Grounded search timed out.", { status: 504 });
        }
        if (response.status >= 500 && response.status <= 503) {
          fail("GROUNDED_SEARCH_UNAVAILABLE", "The private grounded search route is unavailable.", { status: 503 });
        }
        fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "The private grounded search route returned an unsupported status.", {
          status: 502,
        });
      }
      const parsed = parseResponse(await readBoundedBody(response, abort.signal), request, wireRequest);
      const artifact = sourceArtifact(parsed, Math.min(request.limit, maximumSources), request);
      assertIntegrationGroundedSearchIdentifierSources({ sources: artifact.spec.sources }, request);
      return Object.freeze({
        schemaVersion: INTEGRATION_GROUNDED_SEARCH_SCHEMA_VERSION,
        query: request.query,
        mode: request.mode,
        limit: request.limit,
        artifact,
        sources: artifact.spec.sources,
        readiness,
      });
    } catch (error) {
      if (error instanceof IntegrationGroundedSearchError) throw error;
      if (request.signal?.aborted) {
        fail("GROUNDED_SEARCH_CANCELLED", "Grounded search was cancelled.", {
          status: 499,
          cause: request.signal.reason || error,
        });
      }
      if (abort.timedOut()) {
        fail("GROUNDED_SEARCH_TIMEOUT", "Grounded search timed out.", { status: 504, cause: error });
      }
      fail("GROUNDED_SEARCH_UNAVAILABLE", "The private grounded search route is unavailable.", {
        status: 503,
        cause: error,
      });
    } finally {
      abort.cleanup();
    }
  }

  async function activate(optionsValue = {}) {
    const options = exactObject(optionsValue, ["signal"], [], "grounded search activation options", {
      code: "GROUNDED_SEARCH_ACTIVATION_INVALID",
      status: 500,
    });
    const signal = normalizeAbortSignal(options.signal, "grounded search activation signal");
    if (activation) return activation;
    if (activationPromise) return activationPromise;
    activationPromise = (async () => {
      const webProbe = await execute({
        query: WEB_READINESS_QUERY,
        mode: "web",
        limit: 1,
        queryPlanDigest: contractDigest({
          schemaVersion: "aginti-grounded-search-readiness-query-plan-v1",
          query: WEB_READINESS_QUERY,
          mode: "web",
        }),
        ...(signal === undefined ? {} : { signal }),
      }, { readiness: true });
      if (webProbe.sources.length !== 1 || webProbe.sources[0].kind !== "web") {
        fail("GROUNDED_SEARCH_NO_USABLE_SOURCES", "Grounded web readiness returned no web source.", {
          status: 503,
        });
      }
      const papersProbe = await execute({
        query: PAPERS_READINESS_QUERY,
        mode: "papers",
        limit: 1,
        queryPlanDigest: contractDigest({
          schemaVersion: "aginti-grounded-search-readiness-query-plan-v1",
          query: PAPERS_READINESS_QUERY,
          mode: "papers",
        }),
        ...(signal === undefined ? {} : { signal }),
      }, { readiness: true });
      if (papersProbe.sources.length !== 1 || papersProbe.sources[0].kind !== "paper") {
        fail("GROUNDED_SEARCH_NO_USABLE_SOURCES", "Grounded papers readiness returned no paper source.", {
          status: 503,
        });
      }
      const unsigned = Object.freeze({
        schemaVersion: INTEGRATION_GROUNDED_SEARCH_ACTIVATION_SCHEMA_VERSION,
        owner: "aginti",
        authority: "aginti",
        enabled: true,
        ready: true,
        privateLoopback: true,
        exactPostPath: "/api/search/v2",
        requestSchemaVersion: LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION,
        responseSchemaVersion: LOCALLLM_GROUNDED_SEARCH_RESPONSE_SCHEMA_VERSION,
        constraintsSchemaVersion: LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION,
        relayEndpoint: INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
        localTargetEndpoint: INTEGRATION_GROUNDED_SEARCH_LOCAL_TARGET_ENDPOINT,
        credentialRequired: true,
        credentialEncoding: "visible-ascii-16-512-no-whitespace",
        callerSelectableEndpoint: false,
        minimumTimeoutMs: INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS,
        timeoutMs,
        maximumQueryCodePoints: MAX_QUERY_CHARACTERS,
        maximumSources,
        maximumAllowedDomains: MAXIMUM_ALLOWED_DOMAINS,
        maximumExactIdentifiers: MAXIMUM_EXACT_IDENTIFIERS,
        boundedRequestBytes: INTEGRATION_GROUNDED_SEARCH_MAX_REQUEST_BYTES,
        boundedResponseBytes: INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES,
        endpointDigest: contractDigest({ endpoint }),
        webReadinessArtifactDigest: contractDigest(webProbe.artifact),
        papersReadinessArtifactDigest: contractDigest(papersProbe.artifact),
      });
      activation = Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
      ACTIVATION_METADATA.set(activation, Object.freeze({ client, testOnly }));
      return activation;
    })().finally(() => {
      activationPromise = null;
    });
    return activationPromise;
  }

  async function search(value) {
    if (!activation) {
      fail("GROUNDED_SEARCH_NOT_READY", "Grounded search has not passed startup readiness.", { status: 503 });
    }
    return execute(value);
  }

  const attestationUnsigned = Object.freeze({
    schemaVersion: INTEGRATION_GROUNDED_SEARCH_SCHEMA_VERSION,
    owner: "aginti",
    authority: "aginti",
    transport: testOnly ? "test-only-injected-fetch" : "private-loopback-fetch",
    testOnly,
    exactPostPath: "/api/search/v2",
    requestSchemaVersion: LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION,
    responseSchemaVersion: LOCALLLM_GROUNDED_SEARCH_RESPONSE_SCHEMA_VERSION,
    constraintsSchemaVersion: LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION,
    relayEndpoint: INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
    localTargetEndpoint: INTEGRATION_GROUNDED_SEARCH_LOCAL_TARGET_ENDPOINT,
    endpointDigest: contractDigest({ endpoint }),
    credentialRequired: true,
    credentialEncoding: "visible-ascii-16-512-no-whitespace",
    callerSelectableEndpoint: false,
    boundedRequestBytes: INTEGRATION_GROUNDED_SEARCH_MAX_REQUEST_BYTES,
    boundedResponseBytes: INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES,
    maximumQueryCodePoints: MAX_QUERY_CHARACTERS,
    maximumAllowedDomains: MAXIMUM_ALLOWED_DOMAINS,
    maximumExactIdentifiers: MAXIMUM_EXACT_IDENTIFIERS,
    minimumTimeoutMs: INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS,
    timeoutMs,
    maximumSources,
    domainPolicyDigest: INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_DIGEST,
    queryPolicyDigest: INTEGRATION_GROUNDED_SEARCH_QUERY_POLICY_DIGEST,
  });
  const attestation = Object.freeze({ ...attestationUnsigned, digest: contractDigest(attestationUnsigned) });
  const client = Object.freeze({ attestation, activate, search });
  CLIENT_BRAND.add(client);
  CLIENT_METADATA.set(client, Object.freeze({ testOnly }));
  return client;
}

export function assertIntegrationGroundedSearchClient(value, { allowTestOnly = false } = {}) {
  if (!value || !CLIENT_BRAND.has(value)) throw new TypeError("grounded search client is not AgInTi-owned");
  if (!allowTestOnly && CLIENT_METADATA.get(value)?.testOnly === true) {
    throw new TypeError("test-only grounded search client is not production-capable");
  }
  return value;
}

export function assertIntegrationGroundedSearchActivation(value, { client, allowTestOnly = false } = {}) {
  const metadata = value && ACTIVATION_METADATA.get(value);
  if (!metadata || !Object.isFrozen(value)) throw new TypeError("grounded search activation is not AgInTi-owned");
  if (!allowTestOnly && metadata.testOnly) throw new TypeError("grounded search activation is test-only");
  if (client !== undefined && metadata.client !== assertIntegrationGroundedSearchClient(client, { allowTestOnly })) {
    throw new TypeError("grounded search activation belongs to a different client");
  }
  const { digest, ...unsigned } = value;
  const minimumObservedTimeoutMs = metadata.testOnly ? 1_000 : INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS;
  if (
    value.schemaVersion !== INTEGRATION_GROUNDED_SEARCH_ACTIVATION_SCHEMA_VERSION ||
    value.owner !== "aginti" ||
    value.authority !== "aginti" ||
    value.enabled !== true ||
    value.ready !== true ||
    value.privateLoopback !== true ||
    value.exactPostPath !== "/api/search/v2" ||
    value.requestSchemaVersion !== LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION ||
    value.responseSchemaVersion !== LOCALLLM_GROUNDED_SEARCH_RESPONSE_SCHEMA_VERSION ||
    value.constraintsSchemaVersion !== LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION ||
    value.relayEndpoint !== INTEGRATION_GROUNDED_SEARCH_ENDPOINT ||
    value.localTargetEndpoint !== INTEGRATION_GROUNDED_SEARCH_LOCAL_TARGET_ENDPOINT ||
    value.credentialRequired !== true ||
    value.credentialEncoding !== "visible-ascii-16-512-no-whitespace" ||
    value.callerSelectableEndpoint !== false ||
    value.minimumTimeoutMs !== INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < minimumObservedTimeoutMs ||
    value.maximumQueryCodePoints !== MAX_QUERY_CHARACTERS ||
    value.maximumSources !== INTEGRATION_MAXIMUM_SEARCH_SOURCES ||
    value.maximumAllowedDomains !== MAXIMUM_ALLOWED_DOMAINS ||
    value.maximumExactIdentifiers !== MAXIMUM_EXACT_IDENTIFIERS ||
    value.boundedRequestBytes !== INTEGRATION_GROUNDED_SEARCH_MAX_REQUEST_BYTES ||
    value.boundedResponseBytes !== INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES ||
    !/^[a-f0-9]{64}$/u.test(value.webReadinessArtifactDigest) ||
    !/^[a-f0-9]{64}$/u.test(value.papersReadinessArtifactDigest) ||
    value.webReadinessArtifactDigest === value.papersReadinessArtifactDigest ||
    digest !== contractDigest(unsigned)
  ) {
    throw new TypeError("grounded search activation identity is invalid");
  }
  return value;
}

export function createIntegrationGroundedSearchClient(value = {}) {
  return createClient(value, { testOnly: false });
}

export function createTestOnlyIntegrationGroundedSearchClient(value = {}) {
  return createClient(value, { testOnly: true });
}
