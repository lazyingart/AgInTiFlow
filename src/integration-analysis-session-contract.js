export const INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION = "aginti-integration-analysis-session-v1";

export const INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_POLICY = Object.freeze({
  priorArtifactContextSameThreadOnly: true,
  priorArtifactContextImmediatelyPrecedingCompletedRunOnly: true,
  priorArtifactsAuthorizeExecution: false,
  priorArtifactsCountAsCurrentEvidence: false,
});

export const INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_KEYS = Object.freeze(
  Object.keys(INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_POLICY)
);

export function integrationAnalysisPriorArtifactAuthorityMatches(value) {
  return Object.entries(INTEGRATION_ANALYSIS_PRIOR_ARTIFACT_AUTHORITY_POLICY).every(
    ([key, expected]) => value?.[key] === expected
  );
}
