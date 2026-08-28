import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";

const integrationApiUrl = new URL("../src/integration-api.js", import.meta.url).href;
const testExport = "__testAssertAnalysisSessionAuthority";
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== integrationApiUrl) return loaded;
    if (loaded.format !== "module" || loaded.source === null || loaded.source === undefined) {
      throw new Error("integration API source was unavailable to the contract smoke");
    }
    const source = typeof loaded.source === "string"
      ? loaded.source
      : Buffer.from(loaded.source).toString("utf8");
    return {
      ...loaded,
      source: `${source}\nexport { assertAnalysisSessionAuthority as ${testExport} };\n`,
    };
  },
});

let api;
try {
  api = await import(integrationApiUrl);
} finally {
  hooks.deregister();
}

const [{ createTestOnlyIntegrationAnalysisSessionService }, contract, policy] = await Promise.all([
  import("../src/integration-analysis-session-service.js"),
  import("../src/integration-analysis-session-contract.js"),
  import("../src/integration-policy.js"),
]);

const assertAnalysisSessionAuthority = api[testExport];
const {
  INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_KEYS,
  INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_POLICY,
} = contract;
const { contractDigest } = policy;

const POLICY_KEYS = Object.freeze([
  "priorArtifactContextSameThreadOnly",
  "priorArtifactContextImmediatelyPrecedingCompletedRunOnly",
  "priorArtifactsAuthorizeExecution",
  "priorArtifactsCountAsCurrentEvidence",
]);

function freezeDigest(unsigned) {
  const frozen = Object.freeze(unsigned);
  return Object.freeze({ ...frozen, digest: contractDigest(frozen) });
}

function startupProof() {
  return freezeDigest({
    schemaVersion: "aginti-integration-analysis-coordinator-v1",
    ready: true,
    publicActivationReady: true,
    workerCapabilityDigest: contractDigest("worker-capability"),
    workerHealthDigest: contractDigest("worker-health"),
    coordinatorProtocolDigest: contractDigest("coordinator-protocol"),
    coordinatorHealthDigest: contractDigest("coordinator-health"),
    runtimeProfile: "python-analysis-v1",
    runtimeBundleRootDigest: contractDigest("runtime-bundle"),
    seccompPolicyDigest: contractDigest("seccomp-policy"),
    cgroupPolicyDigest: contractDigest("cgroup-policy"),
  });
}

function productionAuthority(testAuthority, activationProof) {
  const { digest: _digest, ...producerFields } = testAuthority;
  return freezeDigest({
    ...producerFields,
    ready: true,
    testOnly: false,
    runnerAuthority: "aginti-analysis-planner",
    fixedCoordinatorDigest: contractDigest("fixed-coordinator"),
    plannerActivationSchemaVersion: "aginti-integration-analysis-planner-activation-v1",
    plannerActivationDigest: contractDigest("planner-activation"),
    plannerActivationBrandRequired: true,
    plannerCoordinatorDigestBound: true,
    activationProofRequired: true,
    activationProofDigest: activationProof.digest,
    activationProof,
    activationProofPinnedAtStartup: true,
    activationProofMatchesBoundCoordinator: true,
    activationReadinessProbedAtStartup: true,
  });
}

function changedProof(proof, change) {
  const { digest: _digest, ...unsigned } = proof;
  change(unsigned);
  return freezeDigest(unsigned);
}

function assertUnavailable(callback, label) {
  assert.throws(
    callback,
    (error) =>
      error?.code === "AGENT_UNAVAILABLE" &&
      error?.status === 503 &&
      /analysis session authority/iu.test(error.message),
    label
  );
}

assert.equal(typeof assertAnalysisSessionAuthority, "function");
assert.deepEqual(INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_KEYS, POLICY_KEYS);
assert.deepEqual(INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_POLICY, {
  priorArtifactContextSameThreadOnly: true,
  priorArtifactContextImmediatelyPrecedingCompletedRunOnly: true,
  priorArtifactsAuthorizeExecution: false,
  priorArtifactsCountAsCurrentEvidence: false,
});

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-session-authority-contract-"));
let service;
try {
  const activationProof = startupProof();
  const runner = Object.freeze({
    attestation: freezeDigest({ testOnlyRunner: true }),
    async run() {
      throw new Error("the authority contract smoke must not execute a run");
    },
  });
  service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot: path.join(temporaryRoot, "state"),
  });
  const capabilities = await service.getIntegrationCapabilities();
  const producerAuthority = capabilities.analysisSessionAuthority;
  assert.deepEqual(
    Object.fromEntries(POLICY_KEYS.map((key) => [key, producerAuthority[key]])),
    INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_POLICY,
    "the session-service producer drifted from the shared continuation policy"
  );

  const accepted = productionAuthority(producerAuthority, activationProof);
  assert.strictEqual(
    assertAnalysisSessionAuthority(
      accepted,
      activationProof,
      capabilities.mutationRecoveryAuthority
    ),
    accepted,
    "the actual API consumer rejected the session-service authority key set"
  );

  for (const key of POLICY_KEYS) {
    assertUnavailable(
      () => assertAnalysisSessionAuthority(
        changedProof(accepted, (unsigned) => { delete unsigned[key]; }),
        activationProof,
        capabilities.mutationRecoveryAuthority
      ),
      `the actual API consumer accepted an authority missing ${key}`
    );
    assertUnavailable(
      () => assertAnalysisSessionAuthority(
        changedProof(accepted, (unsigned) => {
          unsigned[key] = !INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_POLICY[key];
        }),
        activationProof,
        capabilities.mutationRecoveryAuthority
      ),
      `the actual API consumer accepted the wrong ${key} boolean`
    );
  }

  assertUnavailable(
    () => assertAnalysisSessionAuthority(
      changedProof(accepted, (unsigned) => {
        unsigned.unexpectedPriorArtifactAuthority = true;
      }),
      activationProof,
      capabilities.mutationRecoveryAuthority
    ),
    "the actual API consumer accepted an extra authority key"
  );
} finally {
  await service?.close({ mode: "abort" }).catch(() => {});
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("smoke-integration-analysis-session-authority-contract ok");
