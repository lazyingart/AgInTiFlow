import crypto from "node:crypto";
import { redactSensitiveText } from "./redaction.js";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function comparableJson(value) {
  return JSON.stringify(stableValue(value));
}

function parseJsonOutput(output = "") {
  const text = String(output || "").trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Try the next bounded candidate.
    }
  }
  return { ok: false, value: null };
}

export function validateAttributedOutput(output = "", contract = {}) {
  const text = String(output || "").trim();
  const mode = String(contract.mode || "nonempty").trim().toLowerCase();
  if (!text) return { pass: false, reason: "empty_output" };
  if (mode === "nonempty") return { pass: true, reason: "nonempty" };
  if (mode === "exact-text") {
    const pass = text === String(contract.expected || "").trim();
    return { pass, reason: pass ? "exact_text_match" : "exact_text_mismatch" };
  }
  if (mode === "exact-json") {
    const actual = parseJsonOutput(text);
    const expected = typeof contract.expected === "string"
      ? parseJsonOutput(contract.expected)
      : { ok: true, value: contract.expected };
    if (!actual.ok) return { pass: false, reason: "invalid_json" };
    if (!expected.ok) return { pass: false, reason: "invalid_expected_json" };
    const pass = comparableJson(actual.value) === comparableJson(expected.value);
    return { pass, reason: pass ? "exact_json_match" : "exact_json_mismatch", parsed: actual.value };
  }
  if (mode === "required-terms") {
    const missing = (Array.isArray(contract.requiredTerms) ? contract.requiredTerms : [])
      .map((term) => String(term || "").trim())
      .filter(Boolean)
      .filter((term) => !text.includes(term));
    return { pass: missing.length === 0, reason: missing.length ? "missing_required_terms" : "required_terms_present", missing };
  }
  return { pass: false, reason: `unknown_validation_mode:${mode}` };
}

export function classifyProviderAttribution({ rawPass = false, agentPass = false } = {}) {
  if (rawPass && agentPass) return "both_pass";
  if (rawPass && !agentPass) return "orchestration_loss";
  if (!rawPass && agentPass) return "orchestration_help";
  return "provider_limit";
}

function outputDigest(output = "") {
  return crypto.createHash("sha256").update(String(output || "")).digest("hex").slice(0, 16);
}

function safePreview(output = "", limit = 500) {
  return redactSensitiveText(String(output || "")).replace(/\s+/g, " ").trim().slice(0, limit);
}

export function buildProviderAttributionReport({ provider = "", model = "", raw = {}, agent = {}, contract = {}, showOutput = false } = {}) {
  const rawValidation = validateAttributedOutput(raw.output, contract);
  const agentValidation = validateAttributedOutput(agent.output, contract);
  const rawPass = raw.ok !== false && rawValidation.pass;
  const agentPass = agent.ok !== false && agentValidation.pass;
  const summarize = (run, validation) => ({
    ok: run.ok !== false,
    pass: validation.pass,
    reason: validation.reason,
    latencyMs: Number(run.latencyMs || 0),
    outputLength: String(run.output || "").length,
    outputDigest: outputDigest(run.output),
    ...(run.error ? { error: safePreview(run.error, 300) } : {}),
    ...(showOutput ? { outputPreview: safePreview(run.output) } : {}),
  });
  return {
    version: 1,
    provider,
    model,
    classification: classifyProviderAttribution({ rawPass, agentPass }),
    contract: {
      mode: String(contract.mode || "nonempty"),
      expectedDigest: outputDigest(typeof contract.expected === "string" ? contract.expected : JSON.stringify(contract.expected ?? "")),
    },
    raw: summarize(raw, rawValidation),
    agent: summarize(agent, agentValidation),
  };
}
