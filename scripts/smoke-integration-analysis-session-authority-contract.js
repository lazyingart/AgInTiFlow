import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const [api, { createTestOnlyIntegrationAnalysisSessionService }, contract, policy, vision] = await Promise.all([
  import("../src/integration-api.js"),
  import("../src/integration-analysis-session-service.js"),
  import("../src/integration-analysis-session-contract.js"),
  import("../src/integration-policy.js"),
  import("../src/integration-analysis-vision.js"),
]);

const { assertIntegrationAnalysisSessionAuthority } = api;
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

assert.equal(typeof assertIntegrationAnalysisSessionAuthority, "function");
assert.deepEqual(INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_KEYS, POLICY_KEYS);
assert.deepEqual(INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_POLICY, {
  priorArtifactContextSameThreadOnly: true,
  priorArtifactContextImmediatelyPrecedingCompletedRunOnly: true,
  priorArtifactsAuthorizeExecution: false,
  priorArtifactsCountAsCurrentEvidence: false,
});

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-session-authority-contract-"));
let service;
let visionService;
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
    assertIntegrationAnalysisSessionAuthority(
      accepted,
      activationProof,
      capabilities.mutationRecoveryAuthority
    ),
    accepted,
    "the actual API consumer rejected the session-service authority key set"
  );

  for (const key of POLICY_KEYS) {
    assertUnavailable(
      () => assertIntegrationAnalysisSessionAuthority(
        changedProof(accepted, (unsigned) => { delete unsigned[key]; }),
        activationProof,
        capabilities.mutationRecoveryAuthority
      ),
      `the actual API consumer accepted an authority missing ${key}`
    );
    assertUnavailable(
      () => assertIntegrationAnalysisSessionAuthority(
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
    () => assertIntegrationAnalysisSessionAuthority(
      changedProof(accepted, (unsigned) => {
        unsigned.unexpectedPriorArtifactAuthority = true;
      }),
      activationProof,
      capabilities.mutationRecoveryAuthority
    ),
    "the actual API consumer accepted an extra authority key"
  );

  const visionClient = vision.createTestOnlyIntegrationAnalysisVisionClient({
    async describe() {
      throw new Error("the authority contract smoke must not invoke vision");
    },
  });
  const visionActivation = await visionClient.activate();
  visionService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot: path.join(temporaryRoot, "vision-state"),
    visionClient,
    visionActivation,
  });
  const visionCapabilities = await visionService.getIntegrationCapabilities();
  const acceptedVision = productionAuthority(
    visionCapabilities.analysisSessionAuthority,
    activationProof
  );
  assert.strictEqual(
    assertIntegrationAnalysisSessionAuthority(
      acceptedVision,
      activationProof,
      visionCapabilities.mutationRecoveryAuthority,
      { attachmentsExpected: true }
    ),
    acceptedVision,
    "the API consumer rejected the exact image-enabled session authority"
  );
  assertUnavailable(
    () => assertIntegrationAnalysisSessionAuthority(
      changedProof(acceptedVision, (unsigned) => { delete unsigned.attachmentAuthorityDigest; }),
      activationProof,
      visionCapabilities.mutationRecoveryAuthority,
      { attachmentsExpected: true }
    ),
    "the API consumer accepted an image authority without its attachment digest"
  );
  assertUnavailable(
    () => assertIntegrationAnalysisSessionAuthority(
      changedProof(acceptedVision, (unsigned) => {
        unsigned.attachmentBlobsRevalidatedBeforeInference = false;
      }),
      activationProof,
      visionCapabilities.mutationRecoveryAuthority,
      { attachmentsExpected: true }
    ),
    "the API consumer accepted image bytes that are not revalidated before inference"
  );
  assertUnavailable(
    () => assertIntegrationAnalysisSessionAuthority(
      acceptedVision,
      activationProof,
      visionCapabilities.mutationRecoveryAuthority
    ),
    "the API consumer accepted undeclared image authority fields"
  );
} finally {
  await service?.close({ mode: "abort" }).catch(() => {});
  await visionService?.close({ mode: "abort" }).catch(() => {});
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("smoke-integration-analysis-session-authority-contract ok");
