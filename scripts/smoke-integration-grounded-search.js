import assert from "node:assert/strict";

import {
  MAX_INTEGRATION_PUBLIC_ARTIFACT_BYTES,
  sanitizeIntegrationArtifact,
  validateIntegrationSourcesSpec,
} from "../src/integration-artifacts.js";
import {
  INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
  INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES,
  createTestOnlyIntegrationGroundedSearchClient,
} from "../src/integration-grounded-search.js";
import { assertPublicIntegrationResponse } from "../src/integration-api.js";
import {
  AGENT_WORKER_SCHEMA_VERSION,
  INTEGRATION_RPC_PATHS,
  integrationCapabilitiesResponse,
  sanitizeIntegrationRequest,
} from "../src/integration-policy.js";

const TOKEN = `search_${"S".repeat(48)}`;
const THREAD_ID = "thr_12345678-1234-4123-8123-123456789abc";

function source(query, overrides = {}) {
  return {
    title: "Verified source",
    url: "https://example.com/report?view=public",
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

function searchPayload(query, mode = "both", overrides = {}) {
  return {
    query,
    mode,
    sources: [source(query)],
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
    ...overrides,
  };
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

function requestAwareFetch(calls, responseTransform = (value) => value) {
  return async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, init, request });
    return jsonResponse(responseTransform(searchPayload(request.query, request.mode), request));
  };
}

function testClient(fetchImpl) {
  return createTestOnlyIntegrationGroundedSearchClient({
    endpoint: INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
    apiKey: TOKEN,
    timeoutMs: 1_000,
    maximumSources: 20,
    fetchImpl,
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

const legacyCapability = integrationCapabilitiesResponse({ enabled: true, cancel: true, resume: true });
assert.equal(Object.prototype.hasOwnProperty.call(legacyCapability, "search"), false);
assert.deepEqual(legacyCapability.artifacts.kinds, ["plot", "table", "markdown"]);
const searchCapability = integrationCapabilitiesResponse({ enabled: true, cancel: true, resume: true, search: true });
assert.deepEqual(searchCapability.search, {
  enabled: true,
  modes: ["web", "papers", "both"],
  maximumSources: 20,
});
assert.deepEqual(searchCapability.artifacts.kinds, ["plot", "table", "markdown", "sources"]);
assert.deepEqual(
  assertPublicIntegrationResponse(INTEGRATION_RPC_PATHS.capabilities, searchCapability).search,
  searchCapability.search
);
for (const invalidCapability of [
  { ...searchCapability, search: { ...searchCapability.search, modes: ["web", "both", "papers"] } },
  { ...searchCapability, search: { ...searchCapability.search, maximumSources: 19 } },
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
const result = await client.search({ query: "  verified   research  ", mode: "papers", limit: 20 });
assert.equal(calls.length, 2);
assert.equal(calls[1].url, INTEGRATION_GROUNDED_SEARCH_ENDPOINT);
assert.equal(calls[1].init.method, "POST");
assert.equal(calls[1].init.headers.Authorization, `Bearer ${TOKEN}`);
assert.equal(calls[1].init.cache, "no-store");
assert.equal(calls[1].init.credentials, "omit");
assert.equal(calls[1].init.redirect, "error");
assert.equal(calls[1].init.referrerPolicy, "no-referrer");
assert.deepEqual(calls[1].request, { query: "verified research", mode: "papers", limit: 20 });
assert.equal(result.artifact.kind, "sources");
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

async function activationFailure(fetchImpl, code) {
  const candidate = testClient(fetchImpl);
  await assert.rejects(() => candidate.activate(), (error) => error.code === code);
  assert.equal(Object.prototype.hasOwnProperty.call(candidate, "activation"), false);
}

await activationFailure(async (_url, init) => {
  const request = JSON.parse(init.body);
  return new Response(JSON.stringify(searchPayload(request.query, request.mode)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}, "GROUNDED_SEARCH_ROUTE_UNGUARDED");
await activationFailure(async (_url, init) => {
  const request = JSON.parse(init.body);
  return jsonResponse(searchPayload(request.query, request.mode), { "set-cookie": "relay=state" });
}, "GROUNDED_SEARCH_ROUTE_UNGUARDED");
await activationFailure(requestAwareFetch([], (payload) => ({ ...payload, query: "different query" })), "GROUNDED_SEARCH_PROTOCOL_INVALID");
await activationFailure(requestAwareFetch([], (payload) => ({ ...payload, mode: "web" })), "GROUNDED_SEARCH_PROTOCOL_INVALID");
await activationFailure(requestAwareFetch([], (payload) => ({
  ...payload,
  sources: [source(payload.query, { url: "https://user:secret@example.com/report" })],
})), "GROUNDED_SEARCH_NO_USABLE_SOURCES");
await activationFailure(async (_url, init) => {
  const request = JSON.parse(init.body);
  return new Response(JSON.stringify(searchPayload(request.query, request.mode)), {
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
  return new Response(JSON.stringify(searchPayload(request.query, request.mode)), {
    status: 200,
    headers: { "cache-control": "no-store", "content-type": "application/jsonp" },
  });
}, "GROUNDED_SEARCH_PROTOCOL_INVALID");
await activationFailure(async () => new Response(Buffer.alloc(INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES + 1), {
  status: 200,
  headers: { "cache-control": "no-store", "content-type": "application/json" },
}), "GROUNDED_SEARCH_RESPONSE_TOO_LARGE");

let cancellationCalls = 0;
const cancellationClient = testClient(async (_url, init) => {
  cancellationCalls += 1;
  if (cancellationCalls === 1) {
    const request = JSON.parse(init.body);
    return jsonResponse(searchPayload(request.query, request.mode));
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
  if (timeoutCalls === 1) {
    const request = JSON.parse(init.body);
    return jsonResponse(searchPayload(request.query, request.mode));
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

console.log("smoke-integration-grounded-search ok");
