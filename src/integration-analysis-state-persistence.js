export const INTEGRATION_ANALYSIS_STATE_STORAGE_V2 = "aginti-integration-analysis-state-v2";
export const INTEGRATION_ANALYSIS_STATE_STORAGE_V3 = "aginti-integration-analysis-state-v3";

export const INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES = Object.freeze({
  r67CompatibleV2: "r67-compatible-v2",
  nativeV3: "native-v3",
});

export function integrationAnalysisStateStorageVersion(mode) {
  if (mode === INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2) {
    return INTEGRATION_ANALYSIS_STATE_STORAGE_V2;
  }
  if (mode === INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3) {
    return INTEGRATION_ANALYSIS_STATE_STORAGE_V3;
  }
  throw new TypeError("integration analysis state persistence mode is invalid");
}
