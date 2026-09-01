import assert from "node:assert/strict";

import {
  MAX_INTEGRATION_PUBLIC_ARTIFACT_BYTES,
  sanitizeIntegrationArtifact,
  validateIntegrationSourcesSpec,
} from "../src/integration-artifacts.js";
import {
  INTEGRATION_DEEP_RESEARCH_CANCEL_ENDPOINT,
  INTEGRATION_DEEP_RESEARCH_CREATE_ENDPOINT,
  INTEGRATION_DEEP_RESEARCH_STATUS_ENDPOINT,
  INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
  INTEGRATION_GROUNDED_SEARCH_LOCAL_TARGET_ENDPOINT,
  INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_DIGEST,
  INTEGRATION_GROUNDED_SEARCH_QUERY_POLICY_DIGEST,
  INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS,
  INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES,
  LOCALLLM_DEEP_RESEARCH_SCHEMA_VERSION,
  LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION,
  LOCALLLM_GROUNDED_SEARCH_RESPONSE_SCHEMA_VERSION,
  LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION,
  assertIntegrationGroundedSearchDomainSources,
  createIntegrationGroundedSearchArtifactAuthority,
  createTestOnlyIntegrationGroundedSearchClient,
  deriveIntegrationGroundedSearchDomainConstraint,
  inferIntegrationDeepResearchRequestFromPrompt,
  inferIntegrationGroundedSearchRequestFromPrompt,
  integrationGroundedSearchBoundArtifactId,
  integrationGroundedSearchConstrainedQuery,
  planIntegrationGroundedSearchQuery,
} from "../src/integration-grounded-search.js";
import { assertPublicIntegrationResponse } from "../src/integration-api.js";
import {
  AGENT_WORKER_SCHEMA_VERSION,
  INTEGRATION_RPC_PATHS,
  contractDigest,
  integrationCapabilitiesResponse,
  sanitizeIntegrationRequest,
} from "../src/integration-policy.js";

const TOKEN = `search_${"S".repeat(48)}`;
const THREAD_ID = "thr_12345678-1234-4123-8123-123456789abc";
const QUERY_PLAN_DIGEST_VECTOR = `sha256:${"1".repeat(64)}`;
const POLICY_VECTOR_DIGEST = "sha256:ccf5b13b08f247de0033a2c1d4c9bd3866ae0a8ce2b9cf411907080f39ec629c";
const RETURNED_VECTOR_DIGEST = "sha256:3ddb7b8783c4dd600be7eaeed485f1af2821624232eaab6526426a4027375dd8";
const SOURCE_IDENTITY_VECTOR_DIGEST =
  "sha256:d3ed58ed7c051d5948cfb3cb212a5b7d3ac06a4544c5e9c0b2a2f7d840db4857";
const TWO_RECORD_BINDING_VECTOR_DIGEST =
  "sha256:fc7e740594137849892f6d9cd6ac3ad82901eafe8361d43741f8a626c42774dd";

function localllmDigest(value) {
  return `sha256:${contractDigest(value)}`;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function source(query, overrides = {}) {
  return {
    title: "Verified source",
    url: "https://example.com/report",
    snippet: "Bounded public evidence.",
    provider: "crossref",
    providers: ["crossref", "semantic_scholar"],
    kind: "paper",
    authors: ["Ada Lovelace"],
    year: 2024,
    published_date: "2024-01-02",
    doi: "10.1000/example",
    citation_count: 9,
    score: 4.2,
    query,
    provenance: [{ provider: "crossref", query }],
    ...overrides,
  };
}

function arxivVersionParts(identifier) {
  const match = /^(.+?)(v[1-9][0-9]*)$/u.exec(identifier);
  return { root: match ? match[1] : identifier, version: match ? match[2] : null };
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

function matchedExactIdentifiers(requestedIdentifiers, returnedIdentifiers) {
  const matches = [];
  for (const requested of requestedIdentifiers) {
    for (const returned of returnedIdentifiers) {
      const matchType = identifierMatchType(requested, returned);
      if (matchType === null) continue;
      matches.push({
        requested: { kind: requested.kind, value: requested.value },
        returned: { kind: returned.kind, value: returned.value },
        matchType,
      });
    }
  }
  return matches;
}

function matchingAllowedDomains(domain, allowedDomains) {
  return allowedDomains.filter((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function sourceIdentities(rawSource) {
  const identifiers = [];
  const arxiv = new Set();
  const doi = new Set();
  try {
    const parsed = new URL(rawSource.url);
    if (parsed.protocol === "https:" && parsed.hostname === "arxiv.org") {
      const match = /^\/(?:abs|pdf)\/([^/?#]+?)(?:\.pdf)?$/u.exec(parsed.pathname);
      if (match) arxiv.add(match[1].toLowerCase());
    }
    if (parsed.protocol === "https:" && parsed.hostname === "doi.org") {
      const value = decodeURIComponent(parsed.pathname.slice(1)).toLowerCase();
      if (value.startsWith("10.48550/arxiv.")) arxiv.add(value.slice("10.48550/arxiv.".length));
      else doi.add(value);
    }
  } catch {
    // The production parser owns URL validation; this fixture only mirrors identity binding.
  }
  if (typeof rawSource.doi === "string") {
    const value = rawSource.doi.toLowerCase();
    if (value.startsWith("10.48550/arxiv.")) arxiv.add(value.slice("10.48550/arxiv.".length));
    else doi.add(value);
  }
  for (const value of arxiv) identifiers.push({ kind: "arxiv", value });
  for (const value of doi) identifiers.push({ kind: "doi", value });
  identifiers.sort((left, right) => compareText(`${left.kind}:${left.value}`, `${right.kind}:${right.value}`));
  return identifiers;
}

function enrichSources(request, rawSources) {
  return rawSources.map((rawSource, index) => {
    const canonicalUrl = rawSource.canonicalUrl || rawSource.url;
    const domain = new URL(canonicalUrl).hostname.toLowerCase();
    const identifiers = sourceIdentities({ ...rawSource, url: canonicalUrl });
    const matchedAllowedDomains = matchingAllowedDomains(domain, request.constraints.allowedDomains || []);
    const matchedExact = matchedExactIdentifiers(request.constraints.exactIdentifiers || [], identifiers);
    const doi = identifiers.find((identifier) => identifier.kind === "doi")?.value ?? null;
    return {
      ...rawSource,
      rank: index + 1,
      url: canonicalUrl,
      canonicalUrl,
      domain,
      identifiers,
      identityDigest: localllmDigest({ canonicalUrl, domain, identifiers }),
      matchedAllowedDomains,
      matchedExactIdentifiers: matchedExact,
      doi,
    };
  });
}

function returnedIdentityBinding(request, sources) {
  return localllmDigest({
    queryPlanDigest: request.constraints.queryPlanDigest,
    policyDigest: request.constraints.policyDigest,
    returnedIdentities: sources.map((source) => ({
      rank: source.rank,
      identityDigest: source.identityDigest,
      matchedAllowedDomains: source.matchedAllowedDomains,
      matchedExactIdentifiers: source.matchedExactIdentifiers,
    })),
  });
}

function identifierMatches(requested, source) {
  return source.identifiers.some((identifier) => identifierMatchType(requested, identifier) !== null);
}

function withSources(payload, rawSources) {
  const sources = enrichSources(payload.request, rawSources);
  return {
    ...payload,
    sources,
    resolvedIdentifiers: (payload.request.constraints.exactIdentifiers || []).filter((identifier) =>
      sources.some((source) => identifierMatches(identifier, source))
    ),
    unresolvedIdentifiers: (payload.request.constraints.exactIdentifiers || []).filter((identifier) =>
      !sources.some((source) => identifierMatches(identifier, source))
    ),
    returnedIdentityBinding: returnedIdentityBinding(payload.request, sources),
  };
}

function searchPayload(request, overrides = {}) {
  const { sources: overrideSources, ...responseOverrides } = overrides;
  const query = request.query;
  const mode = request.mode || "both";
  const allowedDomain = request.constraints?.allowedDomains?.[0];
  const lane = mode === "web"
    ? {
        provider: "wikipedia",
        providers: ["wikipedia"],
        kind: "web",
        authors: [],
        year: null,
        published_date: null,
        doi: null,
        citation_count: null,
      }
    : {};
  const domainLane = allowedDomain ? {
    url: `https://${allowedDomain}/report`,
    provider: allowedDomain,
    providers: [allowedDomain],
    doi: mode === "web" ? null : "10.1000/example",
  } : {};
  const sources = overrideSources ?? [source(query, { ...lane, ...domainLane })];
  const exactIdentifiers = request.constraints?.exactIdentifiers || [];
  const base = {
    schemaVersion: LOCALLLM_GROUNDED_SEARCH_RESPONSE_SCHEMA_VERSION,
    policyCompliant: true,
    request,
    sources: enrichSources(request, sources),
    providers: [{
      name: "crossref",
      kind: "paper",
      ok: true,
      result_count: 1,
      duration_ms: 25,
      error: null,
      queries: [query],
    }],
    warnings: [],
    resolvedIdentifiers: request.constraints?.strategy === "exact" ? exactIdentifiers : [],
    unresolvedIdentifiers: [],
    returnedIdentityBinding: "",
  };
  base.returnedIdentityBinding = returnedIdentityBinding(request, base.sources);
  return { ...base, ...responseOverrides };
}

function jsonResponse(value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function privateJsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function requestAwareFetch(calls, responseTransform = (value) => value) {
  return async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, init, request });
    return jsonResponse(responseTransform(searchPayload(request), request));
  };
}

function testClient(fetchImpl) {
  return createTestOnlyIntegrationGroundedSearchClient({
    endpoint: INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
    apiKey: TOKEN,
    timeoutMs: 1_000,
    maximumSources: 20,
    fetchImpl: async (url, init) => {
      if (
        url === INTEGRATION_DEEP_RESEARCH_STATUS_ENDPOINT ||
        url === INTEGRATION_DEEP_RESEARCH_CANCEL_ENDPOINT
      ) {
        return new Response(JSON.stringify({ detail: "Research task not found" }), {
          status: 404,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
          },
        });
      }
      return fetchImpl(url, init);
    },
  });
}

function publicSource(overrides = {}) {
  return {
    index: 1,
    title: "Verified source",
    url: "https://example.com/report",
    snippet: "Evidence",
    providers: ["crossref"],
    kind: "paper",
    publishedDate: "2024-01-02",
    doi: "10.1000/example",
    ...overrides,
  };
}

assert.equal(
  localllmDigest({
    schemaVersion: LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION,
    query: "量子 evidence",
    mode: "papers",
    limit: 2,
    constraints: {
      schemaVersion: LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION,
      strategy: "exact",
      allowedDomains: ["arxiv.org", "example.com"],
      exactIdentifiers: [
        { kind: "arxiv", value: "2005.11401v1" },
        { kind: "doi", value: "10.1000/example" },
      ],
    },
  }),
  POLICY_VECTOR_DIGEST
);
assert.equal(
  localllmDigest({
    canonicalUrl: "https://example.com/paper",
    domain: "example.com",
    identifiers: [
      { kind: "arxiv", value: "2005.11401v1" },
      { kind: "doi", value: "10.1000/example" },
    ],
  }),
  SOURCE_IDENTITY_VECTOR_DIGEST
);
const returnedVectorRecords = [{
  rank: 1,
  identityDigest: `sha256:${"2".repeat(64)}`,
  matchedAllowedDomains: ["arxiv.org"],
  matchedExactIdentifiers: [{
    requested: { kind: "arxiv", value: "2005.11401v1" },
    returned: { kind: "arxiv", value: "2005.11401v1" },
    matchType: "exact",
  }],
}];
assert.equal(
  localllmDigest({
    queryPlanDigest: QUERY_PLAN_DIGEST_VECTOR,
    policyDigest: POLICY_VECTOR_DIGEST,
    returnedIdentities: returnedVectorRecords,
  }),
  RETURNED_VECTOR_DIGEST
);
assert.equal(
  localllmDigest({
    queryPlanDigest: QUERY_PLAN_DIGEST_VECTOR,
    policyDigest: POLICY_VECTOR_DIGEST,
    returnedIdentities: [
      ...returnedVectorRecords,
      {
        rank: 2,
        identityDigest: `sha256:${"3".repeat(64)}`,
        matchedAllowedDomains: ["example.com"],
        matchedExactIdentifiers: [{
          requested: { kind: "doi", value: "10.1000/example" },
          returned: { kind: "doi", value: "10.1000/example" },
          matchType: "exact",
        }],
      },
    ],
  }),
  TWO_RECORD_BINDING_VECTOR_DIGEST
);

const legacyCapability = integrationCapabilitiesResponse({ enabled: true, cancel: true, resume: true });
assert.equal(Object.prototype.hasOwnProperty.call(legacyCapability, "search"), false);
assert.deepEqual(legacyCapability.artifacts.kinds, ["plot", "table", "markdown"]);
const filesCapability = integrationCapabilitiesResponse({
  enabled: true,
  cancel: true,
  resume: true,
  files: true,
});
assert.deepEqual(filesCapability.artifacts.kinds, ["plot", "table", "markdown", "file"]);
const searchCapability = integrationCapabilitiesResponse({ enabled: true, cancel: true, resume: true, search: true });
assert.deepEqual(searchCapability.search, {
  enabled: true,
  modes: ["web", "papers", "both"],
  maximumSources: 20,
});
assert.deepEqual(searchCapability.artifacts.kinds, ["plot", "table", "markdown", "sources"]);
const researchCapability = integrationCapabilitiesResponse({
  enabled: true,
  cancel: true,
  resume: true,
  search: true,
  research: true,
});
assert.deepEqual(researchCapability.search.research, {
  enabled: true,
  depths: ["quick", "standard", "deep"],
  taskProtocol: LOCALLLM_DEEP_RESEARCH_SCHEMA_VERSION,
  activation: "explicit-prompt",
});
assert.deepEqual(
  assertPublicIntegrationResponse(INTEGRATION_RPC_PATHS.capabilities, researchCapability),
  researchCapability
);
const searchFilesCapability = integrationCapabilitiesResponse({
  enabled: true,
  cancel: true,
  resume: true,
  search: true,
  files: true,
});
assert.deepEqual(searchFilesCapability.artifacts.kinds, ["plot", "table", "markdown", "sources", "file"]);
assert.deepEqual(
  assertPublicIntegrationResponse(INTEGRATION_RPC_PATHS.capabilities, searchCapability).search,
  searchCapability.search
);
for (const invalidCapability of [
  { ...searchCapability, search: { ...searchCapability.search, modes: ["web", "both", "papers"] } },
  { ...searchCapability, search: { ...searchCapability.search, maximumSources: 19 } },
  { ...researchCapability, search: { ...researchCapability.search, research: { ...researchCapability.search.research, depths: ["deep"] } } },
  { ...searchCapability, artifacts: { ...searchCapability.artifacts, kinds: ["plot", "table", "markdown"] } },
]) {
  assert.throws(
    () => assertPublicIntegrationResponse(INTEGRATION_RPC_PATHS.capabilities, invalidCapability),
    (error) => error.code === "INVALID_REQUEST"
  );
}
const accessorModes = ["web", "papers", "both"];
Object.defineProperty(accessorModes, "1", { enumerable: true, get() { throw new Error("must not execute"); } });
assert.throws(
  () => assertPublicIntegrationResponse(INTEGRATION_RPC_PATHS.capabilities, {
    ...searchCapability,
    search: { ...searchCapability.search, modes: accessorModes },
  })
);
const sparseModes = ["web", "papers", "both"];
delete sparseModes[1];
assert.throws(
  () => assertPublicIntegrationResponse(INTEGRATION_RPC_PATHS.capabilities, {
    ...searchCapability,
    search: { ...searchCapability.search, modes: sparseModes },
  })
);
assert.deepEqual(
  sanitizeIntegrationRequest(INTEGRATION_RPC_PATHS.runsStart, {
    threadId: THREAD_ID,
    input: { text: "Find current evidence", search: { mode: "papers", limit: 7 } },
  }).input.search,
  { mode: "papers", limit: 7 }
);
assert.throws(
  () => sanitizeIntegrationRequest(INTEGRATION_RPC_PATHS.runsStart, {
    threadId: THREAD_ID,
    input: { text: "Find current evidence", search: { mode: "all", limit: 7 } },
  }),
  (error) => error.code === "INVALID_REQUEST"
);

const validSpec = validateIntegrationSourcesSpec({
  schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
  sources: [publicSource()],
});
assert.equal(validSpec.sources[0].url, "https://example.com/report");
for (const url of [
  "http://example.com/report",
  "https://user:password@example.com/report",
  "https://example.com:444/report",
  "https://example.com/report#fragment",
  "https://example.com/report?access_token=secret",
  "https://example.com/report?X-Amz-Credential=secret",
  "https://example.com/report?AWSAccessKeyId=secret",
  "https://example.com/report?GoogleAccessId=secret",
  "https://example.com/report?sig=secret",
]) {
  assert.throws(
    () => validateIntegrationSourcesSpec({
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
      sources: [publicSource({ url })],
    }),
    (error) => error.code === "INVALID_REQUEST" || error.code === "UNSAFE_PRESENTATION"
  );
}
const sparseSources = [];
sparseSources.length = 1;
assert.throws(
  () => validateIntegrationSourcesSpec({ schemaVersion: AGENT_WORKER_SCHEMA_VERSION, sources: sparseSources }),
  (error) => error.code === "INVALID_REQUEST"
);
const accessorProviders = ["crossref"];
Object.defineProperty(accessorProviders, "0", { enumerable: true, get() { throw new Error("must not execute"); } });
assert.throws(
  () => validateIntegrationSourcesSpec({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    sources: [publicSource({ providers: accessorProviders })],
  }),
  (error) => error.code === "INVALID_REQUEST"
);
const proxiedProviders = new Proxy(["crossref"], {});
assert.throws(
  () => validateIntegrationSourcesSpec({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    sources: [publicSource({ providers: proxiedProviders })],
  }),
  (error) => error.code === "INVALID_REQUEST"
);
assert.throws(
  () => validateIntegrationSourcesSpec({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    sources: new Proxy([publicSource()], {}),
  }),
  (error) => error.code === "INVALID_REQUEST"
);
assert.throws(
  () => validateIntegrationSourcesSpec({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    sources: Array.from({ length: 21 }, (_, index) => publicSource({ index: index + 1 })),
  }),
  (error) => error.code === "INVALID_REQUEST"
);
assert.throws(
  () => sanitizeIntegrationArtifact({
    kind: "sources",
    title: "Grounded sources",
    spec: {
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
      sources: Array.from({ length: 20 }, (_, index) => publicSource({
        index: index + 1,
        title: `Source ${index + 1}`,
        snippet: "e".repeat(4_000),
        url: `https://example.com/report/${index + 1}`,
      })),
    },
  }),
  (error) => error.code === "ARTIFACT_TOO_LARGE"
);

const calls = [];
const client = testClient(requestAwareFetch(calls));
await assert.rejects(
  () => client.search({ query: "not activated", mode: "both", limit: 1 }),
  (error) => error.code === "GROUNDED_SEARCH_NOT_READY"
);
const activation = await client.activate();
assert.equal(activation.ready, true);
assert.match(activation.webReadinessArtifactDigest, /^[a-f0-9]{64}$/u);
assert.match(activation.papersReadinessArtifactDigest, /^[a-f0-9]{64}$/u);
assert.notEqual(activation.webReadinessArtifactDigest, activation.papersReadinessArtifactDigest);
assert.equal(client.attestation.domainPolicyDigest, INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_DIGEST);
assert.equal(client.attestation.queryPolicyDigest, INTEGRATION_GROUNDED_SEARCH_QUERY_POLICY_DIGEST);
assert.equal(client.attestation.requestSchemaVersion, LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION);
assert.equal(client.attestation.responseSchemaVersion, LOCALLLM_GROUNDED_SEARCH_RESPONSE_SCHEMA_VERSION);
assert.equal(client.attestation.constraintsSchemaVersion, LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION);
assert.equal(client.attestation.relayEndpoint, INTEGRATION_GROUNDED_SEARCH_ENDPOINT);
assert.equal(client.attestation.localTargetEndpoint, INTEGRATION_GROUNDED_SEARCH_LOCAL_TARGET_ENDPOINT);
assert.equal(client.attestation.credentialEncoding, "visible-ascii-16-512-no-whitespace");
assert.equal(client.attestation.minimumTimeoutMs, INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS);
assert.equal(client.attestation.maximumAllowedDomains, 16);
assert.equal(client.attestation.maximumExactIdentifiers, 8);
assert.equal(client.attestation.maximumQueryCodePoints, 800);
assert.equal(activation.relayEndpoint, INTEGRATION_GROUNDED_SEARCH_ENDPOINT);
assert.equal(activation.localTargetEndpoint, INTEGRATION_GROUNDED_SEARCH_LOCAL_TARGET_ENDPOINT);
assert.equal(activation.timeoutMs, 1_000);
assert.equal(activation.minimumTimeoutMs, INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS);
const result = await client.search({ query: "  verified   research  ", mode: "papers", limit: 20 });
assert.equal(calls.length, 3);
assert.deepEqual(calls.slice(0, 2).map((call) => call.request.mode), ["web", "papers"]);
assert.deepEqual(calls.slice(0, 2).map((call) => call.request.query), ["SQLite", "SQLite"]);
assert.equal(calls[2].url, INTEGRATION_GROUNDED_SEARCH_ENDPOINT);
assert.equal(calls[2].init.method, "POST");
assert.equal(calls[2].init.headers.Authorization, `Bearer ${TOKEN}`);
assert.equal(calls[2].init.cache, "no-store");
assert.equal(calls[2].init.credentials, "omit");
assert.equal(calls[2].init.redirect, "error");
assert.equal(calls[2].init.referrerPolicy, "no-referrer");
assert.equal(calls[2].request.schemaVersion, LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION);
assert.equal(calls[2].request.query, "verified research");
assert.equal(calls[2].request.mode, "papers");
assert.equal(calls[2].request.limit, 20);
assert.equal(calls[2].request.constraints.schemaVersion, LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION);
assert.equal(calls[2].request.constraints.strategy, "ranked");
assert.deepEqual(calls[2].request.constraints.allowedDomains, []);
assert.deepEqual(calls[2].request.constraints.exactIdentifiers, []);
assert.match(calls[2].request.constraints.queryPlanDigest, /^sha256:[a-f0-9]{64}$/u);
assert.equal(
  calls[2].request.constraints.policyDigest,
  localllmDigest({
    schemaVersion: LOCALLLM_GROUNDED_SEARCH_REQUEST_SCHEMA_VERSION,
    query: "verified research",
    mode: "papers",
    limit: 20,
    constraints: {
      schemaVersion: LOCALLLM_GROUNDED_SEARCH_CONSTRAINTS_SCHEMA_VERSION,
      strategy: "ranked",
      allowedDomains: [],
      exactIdentifiers: [],
    },
  })
);
assert.equal(Object.prototype.hasOwnProperty.call(calls[2].request.constraints, "digest"), false);
assert.deepEqual(Object.keys(calls[2].request.constraints).sort(), [
  "allowedDomains",
  "exactIdentifiers",
  "policyDigest",
  "queryPlanDigest",
  "schemaVersion",
  "strategy",
]);
assert.equal(result.artifact.kind, "sources");
const directAuthority = createIntegrationGroundedSearchArtifactAuthority({
  query: "verified research",
  mode: "papers",
  queryPlanDigest: contractDigest({
    schemaVersion: "aginti-grounded-search-direct-query-plan-v1",
    query: "verified research",
    mode: "papers",
  }),
  domainConstraintDigest: null,
});
assert.equal(
  directAuthority.queryDigest,
  contractDigest({ schemaVersion: "aginti-grounded-search-actual-query-v1", query: "verified research" })
);
assert.equal(directAuthority.queryPolicyDigest, INTEGRATION_GROUNDED_SEARCH_QUERY_POLICY_DIGEST);
assert.equal(directAuthority.domainPolicyDigest, INTEGRATION_GROUNDED_SEARCH_DOMAIN_POLICY_DIGEST);
assert.deepEqual(Object.keys(result.artifact.spec).sort(), ["schemaVersion", "sources"]);
assert.equal(result.artifact.id, integrationGroundedSearchBoundArtifactId(result.artifact.spec, directAuthority));
assert.throws(
  () => integrationGroundedSearchBoundArtifactId(result.artifact.spec, {
    ...directAuthority,
    queryPlanDigest: "0".repeat(64),
  }),
  (error) => error?.code === "GROUNDED_SEARCH_INVALID"
);
assert.ok(Buffer.byteLength(JSON.stringify(result.artifact), "utf8") <= MAX_INTEGRATION_PUBLIC_ARTIFACT_BYTES);
assert.doesNotMatch(JSON.stringify({ activation, attestation: client.attestation, result }), new RegExp(TOKEN, "u"));

assert.throws(
  () => createTestOnlyIntegrationGroundedSearchClient({
    endpoint: "http://127.0.0.1:8008/api/search",
    apiKey: TOKEN,
    fetchImpl: async () => jsonResponse({}),
  }),
  (error) => error.code === "GROUNDED_SEARCH_CONFIGURATION_INVALID"
);
assert.equal(
  createTestOnlyIntegrationGroundedSearchClient({
    endpoint: INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
    apiKey: TOKEN,
    fetchImpl: async () => jsonResponse({}),
  }).attestation.timeoutMs,
  INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS
);
for (const badApiKey of [
  "short",
  `has space ${"S".repeat(32)}`,
  `unicode-é-${"S".repeat(32)}`,
  `${"S".repeat(513)}`,
]) {
  assert.throws(
    () => createTestOnlyIntegrationGroundedSearchClient({
      endpoint: INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
      apiKey: badApiKey,
      fetchImpl: async () => jsonResponse({}),
    }),
    (error) => error.code === "GROUNDED_SEARCH_CONFIGURATION_INVALID"
  );
}

async function activationFailure(fetchImpl, code) {
  const candidate = testClient(fetchImpl);
  await assert.rejects(() => candidate.activate(), (error) => error.code === code);
  assert.equal(Object.prototype.hasOwnProperty.call(candidate, "activation"), false);
}

await activationFailure(async (_url, init) => {
  const request = JSON.parse(init.body);
  return new Response(JSON.stringify(searchPayload(request)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}, "GROUNDED_SEARCH_ROUTE_UNGUARDED");
await activationFailure(async (_url, init) => {
  const request = JSON.parse(init.body);
  return jsonResponse(searchPayload(request), { "set-cookie": "relay=state" });
}, "GROUNDED_SEARCH_ROUTE_UNGUARDED");
await activationFailure(
  requestAwareFetch([], (payload) => ({ ...payload, request: { ...payload.request, query: "different query" } })),
  "GROUNDED_SEARCH_PROTOCOL_INVALID"
);
await activationFailure(
  requestAwareFetch([], (payload) => ({ ...payload, request: { ...payload.request, mode: "web" } })),
  "GROUNDED_SEARCH_PROTOCOL_INVALID"
);
await activationFailure(requestAwareFetch([], (payload, request) => withSources(payload, [source(payload.request.query, {
    kind: request.mode === "papers" ? "web" : "web",
    provider: "wikipedia",
    providers: ["wikipedia"],
    authors: [], year: null, published_date: null, doi: null, citation_count: null,
  })])), "GROUNDED_SEARCH_NO_USABLE_SOURCES");
await activationFailure(
  requestAwareFetch([], (payload) => withSources(payload, [source(payload.request.query, {
    url: "https://user:secret@example.com/report",
  })])),
  "GROUNDED_SEARCH_PROTOCOL_INVALID"
);
await activationFailure(async (_url, init) => {
  const request = JSON.parse(init.body);
  return new Response(JSON.stringify(searchPayload(request)), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "content-length": String(INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES + 1),
    },
  });
}, "GROUNDED_SEARCH_RESPONSE_TOO_LARGE");
await activationFailure(async () => new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), {
  status: 200,
  headers: { "cache-control": "no-store", "content-type": "application/json" },
}), "GROUNDED_SEARCH_PROTOCOL_INVALID");
await activationFailure(async (_url, init) => {
  const request = JSON.parse(init.body);
  return new Response(JSON.stringify(searchPayload(request)), {
    status: 200,
    headers: { "cache-control": "no-store", "content-type": "application/jsonp" },
  });
}, "GROUNDED_SEARCH_PROTOCOL_INVALID");
await activationFailure(async () => new Response(Buffer.alloc(INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES + 1), {
  status: 200,
  headers: { "cache-control": "no-store", "content-type": "application/json" },
}), "GROUNDED_SEARCH_RESPONSE_TOO_LARGE");

async function searchStatusFailure(status, code, expectedStatus, options = {}) {
  const { headers = {}, check = null } = options;
  let count = 0;
  const statusClient = testClient(async (_url, init) => {
    count += 1;
    const request = JSON.parse(init.body);
    if (count <= 2) return jsonResponse(searchPayload(request));
    return new Response(JSON.stringify({ detail: "status fixture" }), {
      status,
      headers: { "cache-control": "no-store", "content-type": "application/json", ...headers },
    });
  });
  await statusClient.activate();
  await assert.rejects(
    () => statusClient.search({ query: "status mapping evidence", mode: "web", limit: 1 }),
    (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, expectedStatus);
      if (check) check(error);
      return true;
    }
  );
}
for (const [status, code, expectedStatus] of [
  [400, "GROUNDED_SEARCH_PROTOCOL_INVALID", 502],
  [422, "GROUNDED_SEARCH_PROTOCOL_INVALID", 502],
  [409, "GROUNDED_SEARCH_IDENTIFIER_CONSTRAINT_FAILED", 409],
  [413, "GROUNDED_SEARCH_REQUEST_TOO_LARGE", 413],
  [499, "GROUNDED_SEARCH_PROTOCOL_INVALID", 502],
  [500, "GROUNDED_SEARCH_UNAVAILABLE", 503],
  [503, "GROUNDED_SEARCH_UNAVAILABLE", 503],
  [504, "GROUNDED_SEARCH_TIMEOUT", 504],
  [505, "GROUNDED_SEARCH_PROTOCOL_INVALID", 502],
]) {
  await searchStatusFailure(status, code, expectedStatus);
}
await searchStatusFailure(429, "GROUNDED_SEARCH_BUSY", 429, {
  headers: { "retry-after": "2" },
  check(error) {
    assert.equal(error.retryable, true);
    assert.equal(error.runtimeStatus, 429);
    assert.equal(error.runtimeClassification, "capacity_busy");
    assert.equal(error.retryAfterMs, 2000);
  },
});

let cancellationCalls = 0;
const cancellationClient = testClient(async (_url, init) => {
  cancellationCalls += 1;
  if (cancellationCalls <= 2) {
    const request = JSON.parse(init.body);
    return jsonResponse(searchPayload(request));
  }
  return new Promise(() => {});
});
await cancellationClient.activate();
const cancellation = new AbortController();
const cancelled = cancellationClient.search({
  query: "cancel this search",
  mode: "web",
  limit: 1,
  signal: cancellation.signal,
});
cancellation.abort(new Error("caller cancelled"));
await assert.rejects(() => cancelled, (error) => error.code === "GROUNDED_SEARCH_CANCELLED");

let timeoutCalls = 0;
const timeoutClient = testClient(async (_url, init) => {
  timeoutCalls += 1;
  if (timeoutCalls <= 2) {
    const request = JSON.parse(init.body);
    return jsonResponse(searchPayload(request));
  }
  return new Promise(() => {});
});
await timeoutClient.activate();
const timeoutKeepAlive = setInterval(() => {}, 100);
try {
  await assert.rejects(
    () => timeoutClient.search({ query: "bound this stalled search", mode: "web", limit: 1 }),
    (error) => error.code === "GROUNDED_SEARCH_TIMEOUT"
  );
} finally {
  clearInterval(timeoutKeepAlive);
}

assert.equal(deriveIntegrationGroundedSearchDomainConstraint("Return only two sources about release cadence."), null);
const exactSiteConstraint = deriveIntegrationGroundedSearchDomainConstraint(
  "Find release evidence site:example.org and return only two sources."
);
const exactSitePlan = planIntegrationGroundedSearchQuery(
  "Find release evidence site:example.org and return only two sources.",
  "web",
  exactSiteConstraint
);
assert.equal(exactSitePlan.strategy, "ranked");
assert.equal(exactSitePlan.query, "Find release evidence and return only two sources. site:example.org");
assert.deepEqual(exactSitePlan.allowedDomains, ["example.org"]);
const exactPapersPlan = planIntegrationGroundedSearchQuery(
  "Find the original RAG paper arXiv:2005.11401 and evaluation arXiv:2309.01431. Give two bullets.",
  "papers"
);
assert.equal(exactPapersPlan.strategy, "exact");
assert.equal(exactPapersPlan.query, "2005.11401 2309.01431");
assert.deepEqual(exactPapersPlan.arxivIdentifiers, ["2005.11401", "2309.01431"]);
for (const incidentalDecimalPrompt of [
  "A decimal 2005.11401 appears in an ordinary sentence",
  "Find papers about a measurement value of 2005.11401 in this dataset",
]) {
  const plan = planIntegrationGroundedSearchQuery(incidentalDecimalPrompt, "papers");
  assert.equal(plan.strategy, "ranked");
  assert.equal(plan.query, incidentalDecimalPrompt);
  assert.deepEqual(plan.arxivIdentifiers, []);
}
for (const [prompt, identifiers] of [
  ["arXiv:2005.11401 arXiv:2309.01431", ["2005.11401", "2309.01431"]],
  ["https://arxiv.org/abs/2005.11401v4", ["2005.11401v4"]],
  ["10.48550/arXiv.2309.01431", ["2309.01431"]],
  ["2005.11401 2309.01431", ["2005.11401", "2309.01431"]],
]) {
  assert.deepEqual(planIntegrationGroundedSearchQuery(prompt, "papers").arxivIdentifiers, identifiers);
}
assert.deepEqual(
  planIntegrationGroundedSearchQuery("Find arXiv:2005.11401v1", "papers").arxivIdentifiers,
  ["2005.11401v1"]
);
assert.deepEqual(
  planIntegrationGroundedSearchQuery("Find arXiv:hep-th/9901001v2", "papers").arxivIdentifiers,
  ["hep-th/9901001v2"]
);
assert.equal(
  planIntegrationGroundedSearchQuery("Find paper (DOI: 10.1234/example.1).", "papers").query,
  "10.1234/example.1"
);
assert.equal(
  planIntegrationGroundedSearchQuery("Find DOI 10.1000/(abc)", "papers").query,
  "10.1000/(abc)"
);
const mixedIdentifierPlan = planIntegrationGroundedSearchQuery(
  "Compare arXiv:2005.11401 with DOI 10.1234/example.1 and preserve both exact IDs.",
  "both"
);
assert.equal(mixedIdentifierPlan.strategy, "exact");
assert.equal(mixedIdentifierPlan.query, "2005.11401 10.1234/example.1");
assert.deepEqual(mixedIdentifierPlan.arxivIdentifiers, ["2005.11401"]);
assert.deepEqual(mixedIdentifierPlan.doiIdentifiers, ["10.1234/example.1"]);
assert.deepEqual(mixedIdentifierPlan.exactIdentifiers, [
  { kind: "arxiv", value: "2005.11401" },
  { kind: "doi", value: "10.1234/example.1" },
]);
assert.deepEqual(exactSiteConstraint.domains, ["example.org"]);
assert.equal(deriveIntegrationGroundedSearchDomainConstraint("Return only two sources about release cadence."), null);
assert.equal(deriveIntegrationGroundedSearchDomainConstraint("Use only primary sources for the summary."), null);
assert.throws(
  () => deriveIntegrationGroundedSearchDomainConstraint("Use only official framework sources"),
  (error) => error.code === "GROUNDED_SEARCH_DOMAIN_CONSTRAINT_AMBIGUOUS"
);
assert.deepEqual(
  deriveIntegrationGroundedSearchDomainConstraint("Use only sources from example.org").domains,
  ["example.org"]
);
assert.deepEqual(
  deriveIntegrationGroundedSearchDomainConstraint("Use sources only from docs.rust-lang.org").domains,
  ["docs.rust-lang.org"]
);
assert.deepEqual(
  deriveIntegrationGroundedSearchDomainConstraint("Restrict results to example.org").domains,
  ["example.org"]
);
assert.deepEqual(
  deriveIntegrationGroundedSearchDomainConstraint("Search example.org only").domains,
  ["example.org"]
);
for (const suffixPrompt of [
  "Use only sources from co.uk",
  "Use only sources from test.ck",
  "Use only sources from foo.kawasaki.jp",
]) {
  assert.throws(
    () => deriveIntegrationGroundedSearchDomainConstraint(suffixPrompt),
    (error) => error.code === "GROUNDED_SEARCH_DOMAIN_CONSTRAINT_INVALID"
  );
}
assert.deepEqual(
  deriveIntegrationGroundedSearchDomainConstraint("Use only sources from www.test.ck").domains,
  ["www.test.ck"]
);
assert.deepEqual(
  deriveIntegrationGroundedSearchDomainConstraint("Use only sources from city.kawasaki.jp").domains,
  ["city.kawasaki.jp"]
);
assert.doesNotThrow(() => assertIntegrationGroundedSearchDomainSources(
  Object.freeze({ sources: Object.freeze([Object.freeze({ url: "https://docs.example.co.uk/manual" })]) }),
  deriveIntegrationGroundedSearchDomainConstraint("Use only sources from example.co.uk")
));
assert.equal(
  integrationGroundedSearchConstrainedQuery(
    "Find the protocol release page site:example.org",
    exactSiteConstraint
  ),
  "Find the protocol release page site:example.org"
);
assert.throws(
  () => integrationGroundedSearchConstrainedQuery(
    "🙂🙂 site:example.org",
    deriveIntegrationGroundedSearchDomainConstraint("🙂🙂 site:example.org")
  ),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);
assert.equal(
  integrationGroundedSearchConstrainedQuery(
    "🙂🙂a site:example.org",
    deriveIntegrationGroundedSearchDomainConstraint("🙂🙂a site:example.org")
  ),
  "🙂🙂a site:example.org"
);
for (const length of [799, 800, 16_000]) {
  const prompt = `site:example.org ${"x".repeat(length)}`;
  const constrained = integrationGroundedSearchConstrainedQuery(
    prompt,
    deriveIntegrationGroundedSearchDomainConstraint(prompt)
  );
  assert.equal(Array.from(constrained).length, 800);
  assert.match(constrained, / site:example\.org$/u);
  assert.equal((constrained.match(/site:example\.org/gu) || []).length, 1);
  await client.search({ query: constrained, mode: "web", limit: 1 });
  assert.equal(calls.at(-1).request.query, constrained, "the dispatched query must retain its exact site authority");
}
assert.throws(
  () => planIntegrationGroundedSearchQuery("x".repeat(801), "web"),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);
assert.throws(
  () => planIntegrationGroundedSearchQuery("🙂🙂", "web"),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);
assert.equal(planIntegrationGroundedSearchQuery("🙂🙂a", "web").query, "🙂🙂a");
assert.equal(planIntegrationGroundedSearchQuery("Cafe\u0301   evidence", "web").query, "Café evidence");
assert.equal(
  planIntegrationGroundedSearchQuery("Search https://example.com/private?token=secret", "web").query,
  "Search example.com"
);
assert.equal(planIntegrationGroundedSearchQuery("Search ssh://example.org/private", "web").query, "Search network resource");
assert.equal(planIntegrationGroundedSearchQuery("Search file:///home/alice/private.txt", "web").query, "Search local path");
assert.equal(planIntegrationGroundedSearchQuery("Search /scratch/alice/private.txt", "web").query, "Search local path");
assert.equal(planIntegrationGroundedSearchQuery("Search C:\\Users\\Alice\\private.txt", "web").query, "Search local path");
assert.equal(planIntegrationGroundedSearchQuery("Search //server/share/private.txt", "web").query, "Search network resource");
assert.equal(planIntegrationGroundedSearchQuery("Find DOI 10.1234/example.1", "papers").query, "10.1234/example.1");
const constrainedGrounding = Object.freeze({
  sources: Object.freeze([
    Object.freeze({ url: "https://example.org/releases/1" }),
    Object.freeze({ url: "https://docs.example.org/reference" }),
  ]),
});
assert.equal(
  assertIntegrationGroundedSearchDomainSources(constrainedGrounding, exactSiteConstraint),
  constrainedGrounding
);
for (const prompt of [
  "Use official sources site:user@example.org",
  "Use official sources -site:example.org",
  "site:example.org site:iana.org",
]) {
  assert.throws(
    () => deriveIntegrationGroundedSearchDomainConstraint(prompt),
    (error) => new Set([
      "GROUNDED_SEARCH_DOMAIN_CONSTRAINT_INVALID",
      "GROUNDED_SEARCH_DOMAIN_CONSTRAINT_AMBIGUOUS",
    ]).has(error?.code)
  );
}
assert.throws(
  () => assertIntegrationGroundedSearchDomainSources(
    Object.freeze({ sources: Object.freeze([
      Object.freeze({ url: "https://example.org.evil/higher-ranked" }),
      Object.freeze({ url: "https://www.example.org/official" }),
    ]) }),
    exactSiteConstraint
  ),
  (error) => error?.code === "GROUNDED_SEARCH_DOMAIN_CONSTRAINT_FAILED"
);

assert.throws(
  () => planIntegrationGroundedSearchQuery("Find arXiv:2313.01431", "papers"),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);
assert.throws(
  () => planIntegrationGroundedSearchQuery("Find arXiv:0703.0001", "papers"),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);
assert.throws(
  () => planIntegrationGroundedSearchQuery("Find arXiv:2005.00000", "papers"),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);
assert.throws(
  () => planIntegrationGroundedSearchQuery("Find arXiv:1412.12345", "papers"),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);
assert.throws(
  () => planIntegrationGroundedSearchQuery("Find arXiv:1501.1234", "papers"),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);
assert.throws(
  () => planIntegrationGroundedSearchQuery("Compare arXiv:2005.11401v1 and arXiv:2005.11401v2", "papers"),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);
assert.throws(
  () => planIntegrationGroundedSearchQuery(
    Array.from({ length: 9 }, (_, index) => `arXiv:2005.${String(index + 1).padStart(5, "0")}`).join(" "),
    "papers"
  ),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);

const exactIdentifierCalls = [];
const exactIdentifierClient = testClient(requestAwareFetch(exactIdentifierCalls, (payload) =>
  payload.request.query === mixedIdentifierPlan.query
    ? withSources(payload, [
        source(payload.request.query, {
          url: "https://arxiv.org/abs/2005.11401",
          doi: "10.48550/arxiv.2005.11401",
        }),
        source(payload.request.query, {
          url: "https://doi.org/10.1234/example.1",
          doi: "10.1234/example.1",
        }),
      ])
    : payload
));
await exactIdentifierClient.activate();
await exactIdentifierClient.search({
  query: mixedIdentifierPlan.query,
  mode: "both",
  limit: 2,
  queryPlanDigest: mixedIdentifierPlan.digest,
  domainConstraintDigest: null,
  arxivIdentifiers: mixedIdentifierPlan.arxivIdentifiers,
  doiIdentifiers: mixedIdentifierPlan.doiIdentifiers,
});
assert.deepEqual(exactIdentifierCalls.at(-1).request.constraints.exactIdentifiers, [
  { kind: "arxiv", value: "2005.11401" },
  { kind: "doi", value: "10.1234/example.1" },
]);
const arxivRootPlan = planIntegrationGroundedSearchQuery("Find arXiv:2005.11401", "papers");
const arxivRootClient = testClient(requestAwareFetch([], (payload) =>
  payload.request.query === arxivRootPlan.query
    ? withSources(payload, [source(payload.request.query, {
        url: "https://arxiv.org/abs/2005.11401v1",
        doi: "10.1000/example",
      })])
    : payload
));
await arxivRootClient.activate();
const arxivRootResult = await arxivRootClient.search({
  query: arxivRootPlan.query,
  mode: "papers",
  limit: 1,
  queryPlanDigest: arxivRootPlan.digest,
  domainConstraintDigest: null,
  arxivIdentifiers: ["2005.11401"],
  doiIdentifiers: [],
});
assert.equal(arxivRootResult.sources[0].url, "https://arxiv.org/abs/2005.11401v1");
assert.equal(arxivRootResult.sources[0].doi, "10.1000/example");
await assert.rejects(
  () => exactIdentifierClient.search({
    query: mixedIdentifierPlan.query,
    mode: "both",
    limit: 1,
    queryPlanDigest: mixedIdentifierPlan.digest,
    domainConstraintDigest: null,
    arxivIdentifiers: mixedIdentifierPlan.arxivIdentifiers,
    doiIdentifiers: mixedIdentifierPlan.doiIdentifiers,
  }),
  (error) => error.code === "GROUNDED_SEARCH_INVALID"
);
await assert.rejects(
  () => exactIdentifierClient.search({
    query: "2005.11401",
    mode: "web",
    limit: 1,
    arxivIdentifiers: ["2005.11401"],
    doiIdentifiers: [],
  }),
  (error) => error.code === "GROUNDED_SEARCH_INVALID"
);
await assert.rejects(
  () => exactIdentifierClient.search({
    query: "x".repeat(801),
    mode: "web",
    limit: 1,
  }),
  (error) => error.code === "GROUNDED_SEARCH_QUERY_INVALID"
);
const mismatchedIdentifierClient = testClient(requestAwareFetch([], (payload) =>
  payload.request.query === "2005.11401"
    ? withSources(payload, [source(payload.request.query, {
        url: "https://arxiv.org/abs/2401.00001",
        doi: "10.48550/arxiv.2401.00001",
      })])
    : payload
));
await mismatchedIdentifierClient.activate();
await assert.rejects(
  () => mismatchedIdentifierClient.search({
    query: "2005.11401",
    mode: "papers",
    limit: 1,
    queryPlanDigest: exactPapersPlan.digest,
    domainConstraintDigest: null,
    arxivIdentifiers: ["2005.11401"],
    doiIdentifiers: [],
  }),
  (error) => error.code === "GROUNDED_SEARCH_PROTOCOL_INVALID"
);
const missingIdentifierClient = testClient(requestAwareFetch([], (payload) =>
  payload.request.query === exactPapersPlan.query
    ? withSources(payload, [source(payload.request.query, {
        url: "https://arxiv.org/abs/2005.11401",
        doi: "10.48550/arxiv.2005.11401",
      })])
    : payload
));
await missingIdentifierClient.activate();
await assert.rejects(
  () => missingIdentifierClient.search({
    query: exactPapersPlan.query,
    mode: "papers",
    limit: 2,
    queryPlanDigest: exactPapersPlan.digest,
    domainConstraintDigest: null,
    arxivIdentifiers: exactPapersPlan.arxivIdentifiers,
    doiIdentifiers: [],
  }),
  (error) => error.code === "GROUNDED_SEARCH_IDENTIFIER_CONSTRAINT_FAILED"
);

const researchQuestion = "Perform deep research on durable local agent task recovery.";
const researchQuery = "durable local agent task recovery";
const researchPlanDigest = contractDigest({
  schemaVersion: "deep-research-smoke-query-v1",
  query: researchQuery,
});
const researchTask = (status, updatedAt) => ({
  schema: LOCALLLM_DEEP_RESEARCH_SCHEMA_VERSION,
  task: {
    id: "a1b2c3d4e5f6",
    question: researchQuestion,
    model: "qwen3:30b-a3b-instruct-2507-q4_K_M",
    status,
    stage: status === "complete" ? "Research complete" : "Preparing research plan",
    progress: status === "complete" ? 100 : 0,
    mode: "both",
    depth: "deep",
    max_sources: 20,
    queries: status === "complete" ? [researchQuery] : [],
    sources: status === "complete" ? [source(researchQuery)] : [],
    providers: status === "complete" ? [{
      name: "crossref",
      kind: "paper",
      ok: true,
      result_count: 1,
      duration_ms: 25,
      error: null,
      queries: [researchQuery],
    }] : [],
    provider_errors: [],
    report: status === "complete"
      ? "# Research Report\n\n## Findings\n\nDurable task recovery needs explicit terminal state [1].\n\n## Sources\n\n[1] [Verified source](https://example.com/report)"
      : "",
    error: null,
    created_at: 1,
    updated_at: updatedAt,
  },
});
const researchCalls = [];
const researchProgress = [];
const researchClient = createTestOnlyIntegrationGroundedSearchClient({
  endpoint: INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
  apiKey: TOKEN,
  timeoutMs: 1_000,
  maximumSources: 20,
  fetchImpl: async (url, init) => {
    const request = JSON.parse(init.body);
    researchCalls.push({ url, request, init });
    if (url === INTEGRATION_GROUNDED_SEARCH_ENDPOINT) {
      return jsonResponse(searchPayload(request));
    }
    if (
      (url === INTEGRATION_DEEP_RESEARCH_STATUS_ENDPOINT ||
        url === INTEGRATION_DEEP_RESEARCH_CANCEL_ENDPOINT) &&
      request.task_id === "deadbeefcafe"
    ) {
      return privateJsonResponse({ detail: "Research task not found" }, 404);
    }
    if (url === INTEGRATION_DEEP_RESEARCH_CREATE_ENDPOINT) {
      assert.deepEqual(request, {
        question: researchQuestion,
        model: "localllm-deep",
        mode: "both",
        depth: "deep",
      });
      return privateJsonResponse(researchTask("queued", 1), 202);
    }
    if (url === INTEGRATION_DEEP_RESEARCH_STATUS_ENDPOINT) {
      assert.deepEqual(request, { task_id: "a1b2c3d4e5f6" });
      return privateJsonResponse(researchTask("complete", 2));
    }
    throw new Error(`unexpected research smoke route: ${url}`);
  },
});
await assert.rejects(
  () => researchClient.research({
    question: researchQuestion,
    query: researchQuery,
    mode: "both",
    depth: "deep",
    queryPlanDigest: researchPlanDigest,
    domainConstraintDigest: null,
  }),
  (error) => error.code === "GROUNDED_SEARCH_NOT_READY"
);
const researchActivation = await researchClient.activate();
assert.equal(researchActivation.researchReady, true);
assert.equal(researchActivation.researchTaskSchemaVersion, LOCALLLM_DEEP_RESEARCH_SCHEMA_VERSION);
assert.deepEqual(researchActivation.exactResearchPostPaths, [
  "/api/research/v2/create",
  "/api/research/v2/status",
  "/api/research/v2/cancel",
]);
const researchResult = await researchClient.research({
  question: researchQuestion,
  query: researchQuery,
  mode: "both",
  depth: "deep",
  queryPlanDigest: researchPlanDigest,
  domainConstraintDigest: null,
  onProgress: async (progress) => researchProgress.push(progress),
});
assert.deepEqual(researchProgress.map(({ status, progress }) => ({ status, progress })), [
  { status: "queued", progress: 0 },
  { status: "complete", progress: 100 },
]);
assert.equal(researchResult.schemaVersion, LOCALLLM_DEEP_RESEARCH_SCHEMA_VERSION);
assert.equal(researchResult.taskId, "a1b2c3d4e5f6");
assert.equal(researchResult.artifact.kind, "sources");
assert.equal(researchResult.artifact.spec.sources.length, 1);
assert.match(researchResult.report, /Durable task recovery/u);
const researchAuthority = createIntegrationGroundedSearchArtifactAuthority({
  query: researchQuery,
  mode: "both",
  queryPlanDigest: researchPlanDigest,
  domainConstraintDigest: null,
});
assert.equal(
  researchResult.artifact.id,
  integrationGroundedSearchBoundArtifactId(researchResult.artifact.spec, researchAuthority)
);
assert.equal(researchCalls.filter(({ url }) => url === INTEGRATION_DEEP_RESEARCH_CREATE_ENDPOINT).length, 1);
assert.equal(researchCalls.filter(({ url }) => url === INTEGRATION_DEEP_RESEARCH_STATUS_ENDPOINT).length, 2);
assert.doesNotMatch(JSON.stringify({ researchActivation, researchResult }), new RegExp(TOKEN, "u"));

assert.deepEqual(
  inferIntegrationDeepResearchRequestFromPrompt("Perform deep web and paper research before answering."),
  { mode: "both", depth: "deep" }
);
assert.deepEqual(
  inferIntegrationDeepResearchRequestFromPrompt("Do a quick comprehensive web research review."),
  { mode: "web", depth: "quick" }
);
assert.deepEqual(
  inferIntegrationDeepResearchRequestFromPrompt(
    "Run quick deep research on the official SQLite documentation about WAL versus rollback journaling."
  ),
  { mode: "web", depth: "quick" }
);
assert.deepEqual(
  inferIntegrationDeepResearchRequestFromPrompt("请全面研究这个主题并给出证据。"),
  { mode: "both", depth: "deep" }
);
assert.equal(
  inferIntegrationDeepResearchRequestFromPrompt("Do not perform deep research; answer locally."),
  null
);
assert.equal(inferIntegrationDeepResearchRequestFromPrompt("Summarize this research note."), null);

assert.deepEqual(
  inferIntegrationGroundedSearchRequestFromPrompt(
    "Use grounded web and paper search plus real Python execution to compare the evidence."
  ),
  { mode: "both", limit: 8 }
);
assert.deepEqual(
  inferIntegrationGroundedSearchRequestFromPrompt("Please use grounded web search before answering."),
  { mode: "web", limit: 8 }
);
assert.deepEqual(
  inferIntegrationGroundedSearchRequestFromPrompt("Find the relevant arXiv and paper evidence first."),
  { mode: "papers", limit: 8 }
);
assert.equal(
  inferIntegrationGroundedSearchRequestFromPrompt("Use only primary sources and answer from the supplied text."),
  null
);
assert.equal(
  inferIntegrationGroundedSearchRequestFromPrompt("Answer locally without search or retrieval."),
  null
);

console.log("smoke-integration-grounded-search ok");
