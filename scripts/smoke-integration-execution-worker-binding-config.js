import assert from "node:assert/strict";

import {
  INTEGRATION_EXECUTION_WORKER_BINDING_CONFIG_PATH,
  INTEGRATION_EXECUTION_WORKER_BINDING_CONFIG_SCHEMA_VERSION,
  INTEGRATION_EXECUTION_WORKER_BINDING_SCHEMA_VERSION,
  assertIntegrationExecutionWorkerBinding,
  loadIntegrationExecutionWorkerBindingConfig,
  validateIntegrationExecutionWorkerBindingConfig,
} from "../src/integration-execution-worker-binding-config.js";
import { createSystemdRoutedIntegrationAnalysisCoordinator } from "../src/integration-analysis-coordinator.js";
import { createSystemdBoundExecutionWorkerClient } from "../src/execution-worker-client.js";
import { createSystemdExecutionWorkerBindingAuthority } from "../src/integration-execution-worker-router.js";

const local = Object.freeze({
  schemaVersion: INTEGRATION_EXECUTION_WORKER_BINDING_SCHEMA_VERSION,
  bindingId: "binding_local_workstation_01",
  transport: "local-loopback-http-v1",
  host: "127.0.0.1",
  port: 18_130,
  credentialName: "execution-worker-token",
});
const edge = Object.freeze({
  schemaVersion: INTEGRATION_EXECUTION_WORKER_BINDING_SCHEMA_VERSION,
  bindingId: "binding_lazyedge_jetson_01",
  transport: "lazyedge-private-http-v1",
  host: "127.0.0.1",
  port: 18_131,
  credentialName: "execution-worker-binding-jetson-01",
});

function config(bindings = [edge, local]) {
  return {
    schemaVersion: INTEGRATION_EXECUTION_WORKER_BINDING_CONFIG_SCHEMA_VERSION,
    bindings,
  };
}

function reject(mutator) {
  const candidate = structuredClone(config());
  mutator(candidate);
  assert.throws(
    () => validateIntegrationExecutionWorkerBindingConfig(candidate),
    (error) => error?.code === "EXECUTION_BINDING_CONFIG_INVALID"
  );
}

const validated = validateIntegrationExecutionWorkerBindingConfig(config());
assert.deepEqual(validated.bindings.map(({ bindingId }) => bindingId), [edge.bindingId, local.bindingId]);
assert.match(validated.digest, /^[a-f0-9]{64}$/u);
assert.equal(Object.isFrozen(validated), true);
assert.equal(Object.isFrozen(validated.bindings), true);
assert.equal(
  INTEGRATION_EXECUTION_WORKER_BINDING_CONFIG_PATH,
  "/etc/agintiflow-integration/execution-worker-bindings.json"
);

reject((candidate) => { candidate.endpoint = "http://attacker.invalid"; });
reject((candidate) => { candidate.bindings[0].url = "http://attacker.invalid"; });
reject((candidate) => { candidate.bindings[0].token = "caller-secret"; });
reject((candidate) => { candidate.bindings[0].host = "10.0.0.8"; });
reject((candidate) => { candidate.bindings[0].port = 44_443; });
reject((candidate) => { candidate.bindings[0].credentialName = "execution-worker-token"; });
reject((candidate) => { candidate.bindings[1].port = 18_140; });
reject((candidate) => { candidate.bindings[1].credentialName = "execution-worker-binding-local"; });
reject((candidate) => { candidate.bindings[1].bindingId = candidate.bindings[0].bindingId; });
reject((candidate) => { candidate.bindings[1].credentialName = candidate.bindings[0].credentialName; });

assert.throws(
  () => assertIntegrationExecutionWorkerBinding(validated.bindings[0]),
  /not loaded from the fixed AgInTi manifest/u
);
await assert.rejects(
  () => createSystemdBoundExecutionWorkerClient(validated.bindings[0]),
  /not loaded from the fixed AgInTi manifest/u
);
await assert.rejects(
  () => loadIntegrationExecutionWorkerBindingConfig("/tmp/attacker.json"),
  (error) => error?.code === "EXECUTION_BINDING_CONFIG_SOURCE_FORBIDDEN"
);
await assert.rejects(
  () => createSystemdExecutionWorkerBindingAuthority({ bindings: [] }),
  (error) => error?.code === "EXECUTION_BINDING_CONFIG_SOURCE_FORBIDDEN"
);
await assert.rejects(
  () => createSystemdRoutedIntegrationAnalysisCoordinator({ endpoint: "http://attacker.invalid" }),
  (error) => error?.code === "EXECUTION_BINDING_CONFIG_SOURCE_FORBIDDEN"
);

console.log(JSON.stringify({
  ok: true,
  manifestPath: INTEGRATION_EXECUTION_WORKER_BINDING_CONFIG_PATH,
  bindings: validated.bindings.map(({ bindingId, transport, host, port, credentialName }) => ({
    bindingId,
    transport,
    host,
    port,
    credentialName,
  })),
  callerTransportFieldsRejected: true,
  unbrandedBindingsRejected: true,
}, null, 2));
