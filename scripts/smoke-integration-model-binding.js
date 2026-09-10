import assert from "node:assert/strict";
import {
  normalizeIntegrationModelBinding,
  integrationModelPayload,
  integrationModelPublicBinding,
  integrationModelTransport,
  createIntegrationHostedModelClient,
} from "../src/integration-model-binding.js";
import {
  INTEGRATION_ANALYSIS_HOSTED_CONFIG_SCHEMA_VERSION,
  publicIntegrationAnalysisServiceConfig,
  validateIntegrationAnalysisServiceConfig,
} from "../src/integration-analysis-config.js";
import { assertPublicIntegrationResponse } from "../src/integration-api.js";
import { integrationCapabilitiesResponse } from "../src/integration-policy.js";

const secret = "fixture-" + "x".repeat(40);
const local = { baseURL: "http://127.0.0.1:18080/v1", model: "localllm-code" };
const hosted = {
  provider: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-flash",
  apiKey: secret, thinking: "disabled", contextWindowTokens: 32_768,
  maxOutputTokens: 4_096, modelTimeoutMs: 60_000,
};
const originalProvider = process.env.AGENT_PROVIDER;
const originalKey = process.env.DEEPSEEK_API_KEY;
try {
  process.env.AGENT_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = secret;
  assert.equal(normalizeIntegrationModelBinding(local).provider, "localllm");
  assert.throws(() => normalizeIntegrationModelBinding({ ...hosted, apiKey: undefined }),
    error => error.code === "ANALYSIS_CONFIGURATION_INVALID");
} finally {
  if (originalProvider === undefined) delete process.env.AGENT_PROVIDER;
  else process.env.AGENT_PROVIDER = originalProvider;
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
}

const binding = normalizeIntegrationModelBinding(hosted);
const hostedClient = createIntegrationHostedModelClient(hosted);
assert.equal(hostedClient.maxRetries, 0);
assert.equal(hostedClient.baseURL, hosted.baseURL);
assert.equal(hostedClient._options.fetchOptions.redirect, "error");
assert.throws(() => createIntegrationHostedModelClient(local));
assert.equal(binding.provider, "deepseek");
assert.equal(binding.baseURL, hosted.baseURL);
assert.equal(integrationModelTransport(binding), "deepseek-fixed-https");
assert.equal(integrationModelTransport(normalizeIntegrationModelBinding(local)), "localllm-fixed-loopback");
assert.equal(JSON.stringify(integrationModelPublicBinding(binding)).includes(secret), false);
const payload = { model: binding.model, messages: [], reasoning_effort: "high" };
assert.deepEqual(integrationModelPayload(payload, binding), {
  model: binding.model, messages: [], thinking: { type: "disabled" },
});
assert.equal(integrationModelPayload(payload, normalizeIntegrationModelBinding(local)), payload);

for (const invalid of [
  { ...hosted, provider: "openai" },
  { ...hosted, provider: "localllm" },
  { ...hosted, baseURL: "http://api.deepseek.com/v1" },
  { ...hosted, baseURL: "https://api.deepseek.com/v1/" },
  { ...hosted, baseURL: "https://api.deepseek.com.evil.test/v1" },
  { ...hosted, baseURL: "https://key@api.deepseek.com/v1" },
  { ...hosted, baseURL: "https://api.deepseek.com/v1?key=value" },
  { ...hosted, model: "unreviewed-model" },
  { ...hosted, thinking: "enabled" },
  { ...hosted, apiKey: "short" },
  { ...hosted, apiKey: secret + "\n" },
  { ...hosted, contextWindowTokens: 1 },
  { ...hosted, maxOutputTokens: 4097 },
  { ...hosted, modelTimeoutMs: Infinity },
  { ...hosted, command: "id" },
]) {
  assert.throws(() => normalizeIntegrationModelBinding(invalid),
    error => error.code === "ANALYSIS_CONFIGURATION_INVALID");
}
let getterInvoked = false;
const getter = { ...hosted };
Object.defineProperty(getter, "apiKey", { enumerable: true, get() { getterInvoked = true; return secret; } });
assert.throws(() => normalizeIntegrationModelBinding(getter));
assert.equal(getterInvoked, false);

const config = {
  schemaVersion: INTEGRATION_ANALYSIS_HOSTED_CONFIG_SCHEMA_VERSION,
  capability: { enabled: true, mode: "analysis-execution" },
  listen: { host: "127.0.0.1", port: 18009 },
  stateRoot: "/var/lib/agintiflow-integration/analysis",
  idempotencyRoot: "/var/lib/agintiflow-integration/analysis-idempotency",
  statePersistence: { mode: "native-v3" },
  model: integrationModelPublicBinding(binding),
  trustedPrincipalProxy: { clientId: "aginti-bff", label: "Agent client", scopes: ["/agent/v1/capabilities"] },
};
const checked = validateIntegrationAnalysisServiceConfig(config);
assert.equal(checked.model.provider, "deepseek");
assert.equal(checked.localModel, undefined);
assert.deepEqual(validateIntegrationAnalysisServiceConfig(checked), checked);
const summary = publicIntegrationAnalysisServiceConfig(checked);
assert.equal(summary.modelCredentialName, "deepseek-token");
assert.equal(JSON.stringify(summary).includes(secret), false);
assert.throws(() => validateIntegrationAnalysisServiceConfig({ ...config, model: { ...config.model, apiKey: secret } }));
assert.throws(() => validateIntegrationAnalysisServiceConfig({ ...config, localModel: local }));
assert.throws(() => validateIntegrationAnalysisServiceConfig({ ...config, vision: { enabled: true } }));
assert.throws(() => validateIntegrationAnalysisServiceConfig({ ...config, schemaVersion: "aginti-integration-analysis-service-config-v2" }));

for (const modelLabel of ["LocalLLM", "AI"]) {
  const capabilities = integrationCapabilitiesResponse({ enabled: true, modelLabel });
  assert.equal(assertPublicIntegrationResponse("/agent/v1/capabilities", capabilities).model.label, modelLabel);
}
assert.throws(() => integrationCapabilitiesResponse({ modelLabel: secret }));
console.log("integration model binding smoke passed");
