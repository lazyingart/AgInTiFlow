// Small planner continuation metadata; paper bytes/credentials remain in their
// existing worker. The session resolves every source ID in its own scope.
import { exactDocumentWorkerObject, documentWorkerFail } from "./integration-document-worker-contract.js";
import { validatePaperSelectionRequest } from "./integration-paper-acquisition-contract.js";
import { validateIntegrationArtifactId } from "./integration-policy.js";
import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";

export const PAPER_CHECKPOINT_SCHEMA = "aginti-paper-planner-checkpoint-v1";
export const PAPER_RECOVERY_ATTEMPTS = 2;

function text(value) {
  if (value !== null && (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 16 * 1024)) {
    documentWorkerFail("ANALYSIS_PAPER_CHECKPOINT_INVALID", "Paper continuation text is invalid.", { status: 502 });
  }
  return value;
}

export function validatePaperCheckpointCandidate(value) {
  exactDocumentWorkerObject(value, ["selection", "additionalOutputs", "report"],
    ["selection", "additionalOutputs", "report"], "paper checkpoint candidate");
  if (typeof value.additionalOutputs !== "boolean") {
    documentWorkerFail("ANALYSIS_PAPER_CHECKPOINT_INVALID", "Paper continuation requirements are invalid.", { status: 502 });
  }
  return Object.freeze({ selection: validatePaperSelectionRequest(value.selection),
    additionalOutputs: value.additionalOutputs, report: text(value.report) });
}

export function validatePaperCheckpoint(value) {
  const keys = ["schemaVersion", "selection", "additionalOutputs", "report", "currentSourceId",
    "continuationStarted", "completionText", "recoveryAttempts"];
  exactDocumentWorkerObject(value, keys, keys, "paper checkpoint");
  const candidate = validatePaperCheckpointCandidate({ selection: value.selection,
    additionalOutputs: value.additionalOutputs, report: value.report });
  if (value.schemaVersion !== PAPER_CHECKPOINT_SCHEMA || typeof value.continuationStarted !== "boolean" ||
      !Number.isSafeInteger(value.recoveryAttempts) || value.recoveryAttempts < 0 || value.recoveryAttempts > PAPER_RECOVERY_ATTEMPTS) {
    documentWorkerFail("ANALYSIS_PAPER_CHECKPOINT_INVALID", "Paper continuation state is invalid.", { status: 502 });
  }
  if (value.currentSourceId !== null) validateIntegrationArtifactId(value.currentSourceId);
  return Object.freeze({ ...value, ...candidate, completionText: text(value.completionText) });
}

export function validatePaperResume(value) {
  const keys = ["selection", "additionalOutputs", "report", "sourceArtifact"];
  exactDocumentWorkerObject(value, keys, keys, "paper resume");
  const candidate = validatePaperCheckpointCandidate({ selection: value.selection,
    additionalOutputs: value.additionalOutputs, report: value.report });
  const sourceArtifact = value.sourceArtifact === null ? null : sanitizeIntegrationArtifact(value.sourceArtifact);
  if (sourceArtifact !== null && sourceArtifact.kind !== "sources") {
    documentWorkerFail("ANALYSIS_PAPER_CHECKPOINT_INVALID", "Paper resume source is invalid.", { status: 502 });
  }
  return Object.freeze({ ...candidate, sourceArtifact });
}
