import { parseNativeToolArguments as parseModelJson } from "./native-tool-arguments.js";
import { canonicalJson } from "./integration-policy.js";

// Preserve one interpretation from the original model text through its public
// projection. Redaction can merge two keys, and truncation can break the JSON.
function parseInferenceObject(source) {
  const value = parseModelJson(source);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Inference requires a JSON object.");
  }
  return value;
}

export function publicInferenceJson(raw, projectText) {
  const text = projectText(canonicalJson(parseInferenceObject(raw)));
  parseInferenceObject(text);
  return text;
}
