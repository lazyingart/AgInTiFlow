import { types } from "node:util";

export class NativeTurnError extends Error {
  constructor(code = "MODEL_TURN_INVALID") {
    super(code === "MODEL_TURN_INCOMPLETE"
      ? "The model response ended before its assistant turn was complete."
      : "The model response was not an admissible assistant turn.");
    this.name = "NativeTurnError";
    this.code = code;
    this.status = 422;
  }
}

const fail = code => { throw new NativeTurnError(code); };
function object(value) {
  if (!value || typeof value !== "object" || types.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  return value;
}
function field(value, name, required = false) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) {
    if (required) fail();
    return { present: false, value: undefined };
  }
  if (!descriptor.enumerable || !("value" in descriptor)) fail();
  return { present: true, value: descriptor.value };
}
function array(value) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let i = 0; i < value.length; i++) field(value, String(i), true);
  return value;
}

// Validate the ORIGINAL provider envelope before textual protocol conversion.
// Legacy replies may omit role/finish metadata; absence is compatibility, never
// proof of a freshly admitted provider profile. Explicit contradiction is not
// repairable syntax and must never authorize tools, a plan or a final answer.
export function assertNativeTurnAdmission(response, lane) {
  if (!["plan", "direct", "step"].includes(lane)) throw new TypeError("Unknown native model lane.");
  const choices = array(field(object(response), "choices", true).value);
  if (choices.length !== 1) fail();
  const choice = object(field(choices, "0", true).value);
  const index = field(choice, "index");
  if (index.present && index.value !== 0) fail();
  const message = object(field(choice, "message", true).value);
  const role = field(message, "role");
  if (role.present && role.value !== "assistant") fail();
  for (const name of ["refusal", "function_call"]) {
    const entry = field(message, name);
    if (entry.present && entry.value !== null) fail(name === "refusal" ? "MODEL_TURN_REFUSED" : undefined);
  }
  const content = field(message, "content");
  if (content.present && content.value !== null
      && (typeof content.value !== "string" || !content.value.isWellFormed())) fail();
  const native = field(message, "tool_calls");
  const calls = !native.present || native.value === null ? [] : array(native.value);
  if (lane !== "step" && calls.length) fail();
  const reasoning = ["reasoning_content", "reasoningContent"].map(name => field(message, name));
  for (const entry of reasoning) {
    if (entry.present && entry.value !== null
        && (typeof entry.value !== "string" || !entry.value.isWellFormed())) fail();
  }
  const emptyContinuation = lane !== "plan" && calls.length === 0 && !content.value?.trim();
  const finish = field(choice, "finish_reason");
  if (finish.present) {
    if (finish.value === "length") {
      // Established empty/reasoning-only continuation cannot execute or publish
      // anything. Preserve bounded repair/verified fallback; never apply this
      // exception to calls or nonempty partial content, even valid tool syntax.
      if (!emptyContinuation) fail("MODEL_TURN_INCOMPLETE");
    } else if (finish.value !== (calls.length ? "tool_calls" : "stop")) fail();
  }
  return response; // Preserve SDK metadata and accepted bytes without spreading.
}
