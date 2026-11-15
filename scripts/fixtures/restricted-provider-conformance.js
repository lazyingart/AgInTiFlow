// Offline developer test kit, not runtime admission or a sandbox. The trusted
// host supplies the EXACT production normalization with only its transport
// replaced. Never construct a credentialed/live client in this factory.
import { types } from "node:util";
import {
  createRestrictedApplicationRunner, RestrictedApplicationError,
} from "../../src/restricted-application.js";
import { dataFields } from "../../src/restricted-application-contract.js";

const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const outputSchema = object({ reply: { type: "string", minLength: 1, maxLength: 80 } });
const proposal = { reply: "The current public record is ready for review." };
const final = () => ({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal) } }] });
const call = (args = '{"recordId":"record_alpha"}', name = "read_current") => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: {
  role: "assistant", content: null, tool_calls: [{ id: "read_1", type: "function", function: { name, arguments: args } }],
} }] });
const change = (make, apply) => () => { const raw = make(); apply(raw); return raw; };
const cases = [
  { id: "valid-answer", expected: "completed", reads: 0, responses: [final] },
  { id: "valid-read-answer", expected: "completed", reads: 1, responses: [call, final] },
  ...[
    ["error-object", () => ({ ...final(), error: { message: "Synthetic provider failure" } })],
    ["error-null", () => ({ ...final(), error: null })],
    ["error-with-read", () => ({ ...call(), error: { message: "Synthetic provider failure" } })],
    ["duplicate-final-json", change(final, raw => { raw.choices[0].message.content = '{"reply":"discarded","reply":"The current public record is ready for review."}'; })],
    ["duplicate-read-json", () => call('{"recordId":"discarded","recordId":"record_alpha"}')],
    ["multiple-choices", () => ({ choices: [...final().choices, ...final().choices] })],
    ["wrong-role", change(final, raw => { raw.choices[0].message.role = "user"; })],
    ["content-filter", change(final, raw => { raw.choices[0].finish_reason = "content_filter"; })],
    ["truncated-turn", change(final, raw => { raw.choices[0].finish_reason = "length"; })],
    ["refusal", change(final, raw => { raw.choices[0].message.refusal = "Synthetic refusal"; })],
    ["false-tool-calls", change(final, raw => { raw.choices[0].message.tool_calls = false; })],
    ["invalid-json", change(final, raw => { raw.choices[0].message.content = '{"reply":"unfinished'; })],
    ["competing-text-protocol", change(call, raw => { raw.choices[0].message.content = "Requested tool: shell"; })],
    ["undeclared-tool", () => call("{}", "shell")],
    ["foreign-read-target", () => call('{"recordId":"record_beta"}')],
    ["extra-owner-argument", () => call('{"recordId":"record_alpha","owner":"another_principal"}')],
    ["mixed-batch", change(call, raw => { raw.choices[0].message.tool_calls.push({ id: "read_2", type: "function", function: { name: "shell", arguments: "{}" } }); })],
    ["duplicate-batch-id", change(call, raw => { raw.choices[0].message.tool_calls.push({ ...raw.choices[0].message.tool_calls[0] }); })],
  ].map(([id, make]) => ({ id, expected: "rejected", reads: 0, responses: [make] })),
];
const safeCodes = new Set(["PROVIDER_FAILED", "PROVIDER_PROTOCOL_INVALID", "TOOL_CALL_INVALID", "OUTPUT_INVALID", "INVALID_DATA", "INVALID_CONTRACT", "DATA_LIMIT", "STEP_LIMIT", "TIMEOUT", "BUSY", "CANCELLED"]);
const then = Promise.prototype.then;

function safeCode(error) {
  if (!error || typeof error !== "object" || types.isProxy(error) || Object.getPrototypeOf(error) !== RestrictedApplicationError.prototype) return "ADAPTER_ERROR";
  const field = Object.getOwnPropertyDescriptor(error, "code");
  return field && "value" in field && safeCodes.has(field.value) ? field.value : "ADAPTER_ERROR";
}

function freezeReport(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freezeReport(child);
  return Object.freeze(value);
}

/** Test a trusted OpenAI-compatible native->restricted provider factory.
 * factory({complete,model}) must synchronously return the normalized provider.
 * complete is a synthetic native transport, not a normalized SDK callback.
 * This runs trusted host JavaScript; it cannot isolate a malicious factory or
 * stop a synchronous infinite loop. No deployment capability is issued.
 */
export async function qualifyRestrictedProviderFactory(factory, options = { profile: "read-only" }) {
  if (typeof factory !== "function" || types.isProxy(factory)) throw new TypeError("A trusted synchronous adapter factory is required");
  const { profile } = dataFields(options, ["profile"]);
  if (!["no-tools", "read-only"].includes(profile)) throw new TypeError("Select exactly no-tools or read-only");
  const scenarios = cases.filter(scenario => profile === "read-only" || scenario.id !== "valid-read-answer");
  const results = [];
  for (const scenario of scenarios) {
    let responses = 0, reads = 0, overflow = false, outcome = "rejected", code = null, exactProposal = false;
    const complete = () => {
      const make = scenario.responses[responses++];
      if (!make) { overflow = true; throw Error("Synthetic response budget exhausted"); }
      // Always a fresh original envelope. Never pre-parse content/arguments.
      return make();
    };
    try {
      const provider = factory(Object.freeze({ complete, model: "deepseek-flash" }));
      if (types.isPromise(provider)) {
        // Sink a mistaken trusted async factory, without adopting an arbitrary
        // PromiseLike. The actual provider construction contract is synchronous.
        Reflect.apply(then, provider, [() => {}, () => {}]);
        throw Error("Asynchronous provider factory is not supported");
      }
      const runner = createRestrictedApplicationRunner({
        provider, instructions: "Use only the supplied current public record. Return a proposal, not a saved change.", outputSchema, limits: {
          maxSteps: 3, maxToolCalls: 2, maxCallsPerStep: 2, maxConcurrency: 1, maxOutputTokens: 256, timeoutMs: 250,
        }, tools: profile === "no-tools" ? [] : [{ name: "read_current", description: "Read the caller-selected current public record.", readOnly: true,
          inputSchema: object({ recordId: { type: "string", enum: ["record_alpha"], maxLength: 32 } }),
          outputSchema: object({ text: { type: "string", maxLength: 80 } }),
          execute() { reads++; return { text: "The current public record is ready for review." }; },
        }],
      });
      const result = await runner.run({ input: [{ type: "text", text: "Check the supplied current record and give a short answer. Do not save changes." }] });
      outcome = "completed";
      exactProposal = JSON.stringify(result.proposal) === JSON.stringify(proposal);
    } catch (error) { code = safeCode(error); }
    const reasons = [];
    if (outcome !== scenario.expected) reasons.push("OUTCOME_MISMATCH");
    if (reads !== scenario.reads) reasons.push("READ_COUNT_MISMATCH");
    if (responses !== scenario.responses.length || overflow) reasons.push("TRANSPORT_COUNT_MISMATCH");
    if (scenario.expected === "completed" && !exactProposal) reasons.push("PROPOSAL_MISMATCH");
    if (["TIMEOUT", "BUSY", "CANCELLED"].includes(code)) reasons.push("ADMISSION_NOT_ESTABLISHED");
    results.push({ id: scenario.id, passed: reasons.length === 0, expected: scenario.expected, observed: outcome,
      syntheticResponses: responses, readCallbacks: reads, rejectionCode: code, reasons });
  }
  const passedCases = results.filter(result => result.passed).length;
  return freezeReport({ schemaVersion: "aginti-restricted-provider-conformance-v1", scope: "offline-original-envelope-only",
    profile, passed: passedCases === scenarios.length, totalCases: scenarios.length, passedCases, failedCases: scenarios.length - passedCases,
    productionReady: false, results });
}
