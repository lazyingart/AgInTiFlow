import { TextDecoder, types as utilTypes } from "node:util";

import {
  MAX_INTEGRATION_PUBLIC_ARTIFACT_BYTES,
  sanitizeIntegrationArtifact,
  validateIntegrationSourcesSpec,
} from "./integration-artifacts.js";
import {
  AGENT_WORKER_SCHEMA_VERSION,
  INTEGRATION_MAXIMUM_SEARCH_SOURCES,
  contractDigest,
  validateIntegrationSearch,
} from "./integration-policy.js";

export const INTEGRATION_GROUNDED_SEARCH_SCHEMA_VERSION = "aginti-integration-grounded-search-v1";
export const INTEGRATION_GROUNDED_SEARCH_ACTIVATION_SCHEMA_VERSION =
  "aginti-integration-grounded-search-activation-v1";
export const INTEGRATION_GROUNDED_SEARCH_ENDPOINT = "http://127.0.0.1:18081/api/search";
export const INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS = 30_000;
export const INTEGRATION_GROUNDED_SEARCH_MAX_REQUEST_BYTES = 16 * 1024;
export const INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES = 256 * 1024;

const READINESS_QUERY = "grounded search operational readiness";
const MAX_QUERY_CHARACTERS = 800;
const MAX_PUBLIC_SNIPPET_CHARACTERS = 1_200;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CLIENT_BRAND = new WeakSet();
const CLIENT_METADATA = new WeakMap();
const ACTIVATION_METADATA = new WeakMap();
const SOURCE_KEYS = Object.freeze([
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

export class IntegrationGroundedSearchError extends Error {
  constructor(code, message, { status = 502, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationGroundedSearchError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, { status = 502, cause } = {}) {
  throw new IntegrationGroundedSearchError(code, message, { status, cause });
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
    parsed.pathname !== "/api/search" ||
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
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    fail("GROUNDED_SEARCH_CONFIGURATION_INVALID", "Grounded search credential is invalid.", { status: 500 });
  }
  return value;
}

function normalizeTimeout(value) {
  const timeoutMs = value ?? INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
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

function boundedQuery(value) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("GROUNDED_SEARCH_QUERY_INVALID", "Grounded search query is invalid.", { status: 400 });
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  const query = Array.from(normalized).slice(0, MAX_QUERY_CHARACTERS).join("");
  if (query.length < 3) {
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

function parseResponse(bytes) {
  let value;
  try {
    value = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (error) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search returned invalid JSON.", { cause: error });
  }
  const response = exactObject(
    value,
    ["query", "mode", "sources", "providers", "warnings"],
    ["query", "mode", "sources", "providers", "warnings"],
    "grounded search response",
    { code: "GROUNDED_SEARCH_PROTOCOL_INVALID", status: 502 }
  );
  if (typeof response.query !== "string" || !["web", "papers", "both"].includes(response.mode)) {
    fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search response identity is invalid.");
  }
  const sources = denseArray(response.sources, "grounded search sources", { minimum: 0, maximum: 30 });
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
      provider.kind.length < 1 ||
      provider.kind.length > 40 ||
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
  return Object.freeze({ query: response.query, mode: response.mode, sources, providers, warnings });
}

function publicSource(raw, index) {
  exactObject(raw, SOURCE_KEYS, SOURCE_KEYS, `grounded search source[${index - 1}]`, {
    code: "GROUNDED_SEARCH_PROTOCOL_INVALID",
    status: 502,
  });
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
  const providers = [...new Set([
    ...providerValues.filter((provider) => typeof provider === "string"),
    ...(typeof raw.provider === "string" ? [raw.provider] : []),
  ].map((provider) => clippedText(provider.trim(), 100)).filter(Boolean))].slice(0, 12);
  const candidate = Object.freeze({
    index: 1,
    title: clippedText(raw.title, 500),
    url: raw.url,
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
  return Object.freeze({ ...validated, index });
}

function sourceArtifact(response, limit) {
  const sources = [];
  for (const raw of response.sources.slice(0, limit)) {
    try {
      sources.push(publicSource(raw, sources.length + 1));
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
      const artifact = sanitizeIntegrationArtifact({
        title: "Grounded sources",
        kind: "sources",
        spec: { schemaVersion: AGENT_WORKER_SCHEMA_VERSION, sources },
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

function normalizeSearchRequest(value) {
  const request = exactObject(value, ["query", "mode", "limit", "signal"], ["query", "mode", "limit"], "grounded search request", {
    code: "GROUNDED_SEARCH_INVALID",
    status: 400,
  });
  const search = validateIntegrationSearch({ mode: request.mode, limit: request.limit });
  return Object.freeze({
    query: boundedQuery(request.query),
    mode: search.mode,
    limit: search.limit,
    signal: normalizeAbortSignal(request.signal),
  });
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
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const maximumSources = normalizeMaximumSources(options.maximumSources);
  const fetchImpl = testOnly ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    fail("GROUNDED_SEARCH_CONFIGURATION_INVALID", "Grounded search transport is unavailable.", { status: 500 });
  }
  let activation = null;
  let activationPromise = null;

  async function execute(value, { readiness = false } = {}) {
    const request = normalizeSearchRequest(value);
    const payload = JSON.stringify({ query: request.query, mode: request.mode, limit: request.limit });
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
      if (!response || typeof response.status !== "number" || response.status !== 200) {
        discardResponseBody(response, new Error("grounded search unavailable"));
        fail("GROUNDED_SEARCH_UNAVAILABLE", "The private grounded search route is unavailable.", { status: 503 });
      }
      const parsed = parseResponse(await readBoundedBody(response, abort.signal));
      if (parsed.mode !== request.mode || parsed.query !== request.query) {
        fail("GROUNDED_SEARCH_PROTOCOL_INVALID", "Grounded search response identity does not match its request.");
      }
      const artifact = sourceArtifact(parsed, Math.min(request.limit, maximumSources));
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
      const probe = await execute({
        query: READINESS_QUERY,
        mode: "both",
        limit: 1,
        ...(signal === undefined ? {} : { signal }),
      }, { readiness: true });
      const unsigned = Object.freeze({
        schemaVersion: INTEGRATION_GROUNDED_SEARCH_ACTIVATION_SCHEMA_VERSION,
        owner: "aginti",
        authority: "aginti",
        enabled: true,
        ready: true,
        privateLoopback: true,
        exactPostPath: "/api/search",
        credentialRequired: true,
        callerSelectableEndpoint: false,
        maximumSources,
        endpointDigest: contractDigest({ endpoint }),
        readinessArtifactDigest: contractDigest(probe.artifact),
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
    exactPostPath: "/api/search",
    endpointDigest: contractDigest({ endpoint }),
    credentialRequired: true,
    callerSelectableEndpoint: false,
    boundedRequestBytes: INTEGRATION_GROUNDED_SEARCH_MAX_REQUEST_BYTES,
    boundedResponseBytes: INTEGRATION_GROUNDED_SEARCH_MAX_RESPONSE_BYTES,
    timeoutMs,
    maximumSources,
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
  if (
    value.schemaVersion !== INTEGRATION_GROUNDED_SEARCH_ACTIVATION_SCHEMA_VERSION ||
    value.owner !== "aginti" ||
    value.authority !== "aginti" ||
    value.enabled !== true ||
    value.ready !== true ||
    value.maximumSources !== INTEGRATION_MAXIMUM_SEARCH_SOURCES ||
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
