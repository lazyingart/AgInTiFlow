import assert from "node:assert/strict";
import test from "node:test";
import { validateIntegrationAnalysisServiceConfig, publicIntegrationAnalysisServiceConfig,
  loadIntegrationAnalysisVisionCredential } from "../src/integration-analysis-config.js";
import { resolveIntegrationAnalysisVisionClientOptions, composeProductionIntegrationAnalysisServer,
  assertDistinctIntegrationAnalysisCredentials } from "../src/integration-analysis-server.js";
import { main as cli } from "../src/integration-analysis-cli.js";

function hostedConfig() {
  return {
    schemaVersion: "aginti-integration-analysis-service-config-v3",
    capability: { enabled: true, mode: "analysis-execution" },
    listen: { host: "127.0.0.1", port: 18009 },
    stateRoot: "/var/lib/agintiflow-integration/analysis",
    idempotencyRoot: "/var/lib/agintiflow-integration/analysis-idempotency",
    statePersistence: { mode: "native-v3" },
    model: { provider: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-flash",
      thinking: "disabled", contextWindowTokens: 32768, maxOutputTokens: 4096, modelTimeoutMs: 60000 },
    vision: { enabled: true, localModel: { baseURL: "http://127.0.0.1:18080/v1", modelTimeoutMs: 180000 } },
    trustedPrincipalProxy: { clientId: "aginti-bff", label: "Agent", scopes: ["/agent/v1/capabilities"] },
  };
}

test("hosted text can explicitly bind independent local vision", () => {
  const input = hostedConfig();
  const config = validateIntegrationAnalysisServiceConfig(input);
  assert.deepEqual(config.vision, input.vision);
  assert.deepEqual(validateIntegrationAnalysisServiceConfig(config), config);
  assert.equal(publicIntegrationAnalysisServiceConfig(config).visionCredentialName, "localllm-vision-token");
});

test("existing hosted text-only configs remain unchanged", () => {
  const config = hostedConfig();
  delete config.vision;
  assert.equal(validateIntegrationAnalysisServiceConfig(config).vision, undefined);
  config.vision = { enabled: false };
  assert.deepEqual(validateIntegrationAnalysisServiceConfig(config).vision, { enabled: false });
  assert.equal(publicIntegrationAnalysisServiceConfig(config).visionCredentialName, undefined);
});

for (const [name, modify] of [
  ["implicit hosted credential reuse", c => { delete c.vision.localModel; }],
  ["disabled role with binding", c => { c.vision.enabled = false; }],
  ["remote vision origin", c => { c.vision.localModel.baseURL = "https://api.deepseek.com/v1"; }],
  ["arbitrary local service", c => { c.vision.localModel.baseURL = "http://127.0.0.1:8008/v1"; }],
  ["credential in configuration", c => { c.vision.localModel.apiKey = "private-value"; }],
  ["unbounded timeout", c => { c.vision.localModel.modelTimeoutMs = Infinity; }],
  ["missing timeout", c => { delete c.vision.localModel.modelTimeoutMs; }],
  ["unreviewed model", c => { c.vision.localModel.model = "other"; }],
  ["unavailable state persistence", c => { c.statePersistence.mode = "r67-compatible-v2"; }],
]) test(`rejects ${name}`, () => {
  const config = hostedConfig();
  modify(config);
  assert.throws(() => validateIntegrationAnalysisServiceConfig(config));
});

const textToken = "text-provider-" + "x".repeat(40);
const visionToken = "vision-provider-" + "y".repeat(40);

test("vision binding selects only the independent local endpoint and key", () => {
  const config = hostedConfig();
  const options = resolveIntegrationAnalysisVisionClientOptions(config,
    { localModelApiKey: textToken, visionApiKey: visionToken });
  assert.deepEqual(options, { ...config.vision.localModel, apiKey: visionToken });
  assert.equal(JSON.stringify(options).includes(textToken), false);
  const published = JSON.stringify(publicIntegrationAnalysisServiceConfig(config));
  assert.equal(published.includes(textToken) || published.includes(visionToken), false);
});

test("missing independent credential leaves vision unavailable, not hosted fallback", () => {
  assert.equal(resolveIntegrationAnalysisVisionClientOptions(hostedConfig(), { localModelApiKey: textToken }), undefined);
});

test("unexpected independent credential fails before any runtime is composed", async () => {
  const config = hostedConfig();
  config.vision = { enabled: false };
  await assert.rejects(composeProductionIntegrationAnalysisServer({ config,
    localModelApiKey: textToken, visionApiKey: visionToken,
    executionWorkerCredential: "worker-" + "e".repeat(40),
    trustedPrincipalProxyClient: { token: "proxy-" + "p".repeat(40) },
  }), { code: "ANALYSIS_CREDENTIAL_INVALID" });
});

test("independent vision credential cannot equal any other role", async () => {
  const credentials = { model: textToken, trustedBff: "proxy-" + "p".repeat(40),
    groundedSearch: "search-" + "s".repeat(40), documentEdge: "document-" + "d".repeat(40),
    executionWorker: "worker-" + "e".repeat(40) };
  for (const value of Object.values(credentials)) {
    assert.throws(() => assertDistinctIntegrationAnalysisCredentials({ ...credentials, vision: value }),
      { code: "ANALYSIS_CREDENTIAL_INVALID" });
    const config = { ...hostedConfig(), groundedSearch: { enabled: true, endpoint: "http://127.0.0.1:18081/api/search/v2",
      timeoutMs: 60000, maximumSources: 20 }, documentWorker: { enabled: true, endpoint: "http://127.0.0.1:18121", timeoutMs: 120000 } };
    await assert.rejects(composeProductionIntegrationAnalysisServer({ config,
      localModelApiKey: credentials.model, visionApiKey: value,
      groundedSearchApiKey: credentials.groundedSearch, documentWorkerCredential: credentials.documentEdge,
      executionWorkerCredential: credentials.executionWorker,
      trustedPrincipalProxyClient: { token: credentials.trustedBff },
    }), { code: "ANALYSIS_CREDENTIAL_INVALID" });
  }
});

test("malformed independent credentials fail before composing any runtime", async () => {
  for (const value of [undefined, null, "", "short", "x".repeat(4097), `${visionToken}\n`]) {
    await assert.rejects(composeProductionIntegrationAnalysisServer({
      config: hostedConfig(),
      localModelApiKey: textToken,
      visionApiKey: value,
      executionWorkerCredential: "worker-" + "e".repeat(40),
      trustedPrincipalProxyClient: { token: "proxy-" + "p".repeat(40) },
    }), { code: "ANALYSIS_CREDENTIAL_INVALID" });
  }
});

test("v2 local vision retains its existing implicit local binding", () => {
  const config = hostedConfig();
  config.schemaVersion = "aginti-integration-analysis-service-config-v2";
  delete config.model;
  config.localModel = { baseURL: "http://127.0.0.1:18080/v1", model: "localllm-code",
    contextWindowTokens: 32768, maxOutputTokens: 4096, modelTimeoutMs: 180000 };
  config.vision = { enabled: true };
  const result = resolveIntegrationAnalysisVisionClientOptions(config, { localModelApiKey: textToken });
  assert.deepEqual(result, { baseURL: config.localModel.baseURL, modelTimeoutMs: 180000, apiKey: textToken });
  assert.equal(publicIntegrationAnalysisServiceConfig(config).visionCredentialName, undefined);
  config.vision.localModel = { baseURL: config.localModel.baseURL, modelTimeoutMs: 120000 };
  assert.equal(resolveIntegrationAnalysisVisionClientOptions(config, { localModelApiKey: textToken }), undefined);
  assert.equal(resolveIntegrationAnalysisVisionClientOptions(config,
    { localModelApiKey: textToken, visionApiKey: visionToken }).apiKey, visionToken);
});

test("credential loader refuses caller-selected sources", async () => {
  await assert.rejects(loadIntegrationAnalysisVisionCredential("/tmp/vision-key"), { code: "ANALYSIS_CREDENTIAL_SOURCE_FORBIDDEN" });
});

test("CLI refuses ambient vision keys before reading configuration", async () => {
  for (const name of ["AGINTI_LOCALLLM_VISION_API_KEY", "AGINTI_LOCALLLM_VISION_API_KEY_FILE",
    "AGINTI_LOCALLLM_VISION_TOKEN", "AGINTI_LOCALLLM_VISION_TOKEN_FILE",
    "LOCALLLM_VISION_API_KEY", "LOCALLLM_VISION_API_KEY_FILE", "LOCALLLM_VISION_TOKEN", "LOCALLLM_VISION_TOKEN_FILE"]) {
    await assert.rejects(cli(["check", "--config", "/unread/config.json"], { env: { [name]: visionToken } }),
      { code: "ANALYSIS_CREDENTIAL_SOURCE_FORBIDDEN" });
  }
});
