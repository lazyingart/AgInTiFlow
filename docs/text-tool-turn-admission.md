# Complete textual tool turns

Textual tool protocols are compatibility transports for the native tool loop.
A recognized turn must parse completely before any reported call is admitted.
One malformed member, truncated suffix, duplicate JSON key, conflicting name
alias or unparsed tail rejects the entire turn. The runtime never executes a
valid subset or turns a malformed action's prose prefix into a final answer.

Supported legacy forms remain Requested tool(s), bracket/ARGS, TOOL_CALLS JSON
blocks, line-delimited toolName/args, XML tool_calls and function/parameter.
Valid explanatory prefixes remain supported where that dialect allows them.
DSML retains its exact outer envelope requirement and smaller byte limits.
Native OpenAI function-call envelopes retain their existing separate admission
and argument contracts; this change does not rewrite accepted native bytes.

Original JSON containers are checked with the same bounded strict JSON parser
as native arguments before reserialization. That includes nested data, not
JSON-looking source text inside a string. Protocol markers inside JSON string
arguments stay data. A triple-backtick example is not a call and cannot shadow
a later actual call. A malformed recognized protocol never falls through to
a different syntax. DSML still requires its exact standalone outer envelope.

Legacy turns are limited to 16 MiB of UTF8 text and 16 reported calls. Existing
native dispatch limits still apply afterward: syntactic acceptance does not
authorize a larger batch, a tool not offered in that turn, or a schema change.
Identical ID-less standalone lines retain their established single-call
presentation semantics, but every original line is validated and counted
against the report limit. Supplied call IDs must be bounded and unique.

Malformed turns use the existing bounded syntax-repair budget. Exhaustion
pauses truthfully; it does not expand tools, permission, runtime revision or
provider policy. A fresh explicit model continuation can finish the retained
task with valid calls. No malformed raw payload is added to durable diagnostics.
Internal no-call assistant frames omit an empty tool_calls array on outbound
requests, as required by compatible provider APIs. This projection does not
edit saved history, nonempty native calls or DeepSeek reasoning content.

This is protocol integrity, not provider authentication, application account
isolation, exactly-once side effects, a sandbox or general model-quality proof.
App adapters must still preserve original provider evidence at their own
qualified boundary; parsing a lossy normalized proposal is insufficient.
