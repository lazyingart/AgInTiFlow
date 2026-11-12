# Internal no-tools Responses protocol prerequisite

`src/restricted-responses-protocol.js` is an internal request builder and bounded
SSE decoder. It is not a package export, provider, credential loader, CLI
wrapper, application sign-in flow or backend admission. No runtime imports it.
The restricted SDK and installed provider selection remain unchanged.

The [official inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
requires the selected account's authorized token, public Responses endpoint and
a completed inference event. The [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
require streaming, disabled server storage and explicit HTTP history; they omit
`max_output_tokens` and server-side HTTP continuation. This source prerequisite
implements protocol handling only, without implying registration or consent.

## Request boundary

`buildRestrictedResponsesRequest(sdkRequest, options)` accepts the restricted
SDK's exact request shape and server-selected `model`, `reasoningEffort` and
`outputSchema`. It returns detached, frozen JSON with `tools: []`,
`tool_choice: "none"`, `store: false` and `stream: true`. Instructions and text
history are explicit. Images, tool transcripts, extra configuration fields and
alternate endpoints are refused. This is fresh text context, not native Codex
thread replay or a claim to preserve its private reasoning/phase state.

Non-object proposal roots use the existing closed `proposal` wire envelope;
the host's final value is preserved. Optional object properties unsupported by
the strict Responses schema profile are refused, not silently made required.
Model availability and accepted reasoning levels need account-specific proof.
No model alias, default, spare, credential or provider is discovered.

## Stream boundary

`createRestrictedResponsesDecoder(options)` returns frozen `push(bytes)`,
`finish()` and `cancel()` functions. It has no callback or I/O dependency.
Only `finish()` after a complete terminal event and EOF can return the frozen
`{type: "final", value}` proposal. No partial delta or reasoning is exposed.

The accepted profile binds contiguous sequence numbers, response/item IDs,
model, reasoning effort, schema and creation time. Text deltas, done text,
content completion, item completion and the terminal output must agree. Exactly
one assistant JSON message is accepted, with up to eight empty reasoning items.
Commentary phases cannot become final answers; an explicit final-answer phase
is bound through item completion. Tool, refusal, failed, incomplete, unknown or contradictory events poison the
decoder permanently. Duplicate JSON keys, invalid UTF-8, truncated frames and
reconnect instructions fail closed. LF and CRLF framing and bounded comments
are supported. Public output contains only the schema-checked proposal.

Byte views are privately copied with native intrinsics; Proxy and shared-memory
chunks are refused without reading caller metadata. Fragmented long lines use
geometric segments instead of repeatedly scanning retained prefixes.

Limits are 1 MiB total wire bytes, 256 KiB per event, 64 KiB UTF-8 output text
and 4,096 events. Model output is never truncated or repaired into success.
These local bounds do not establish a remote token/cost ceiling or prove that
cancellation stopped hosted inference. The accepted event subset is deliberately
narrow; a legitimate provider variant outside it requires separate review.

## Verification and remaining transport work

Run `node --test test/restricted-responses-protocol.test.js`. The fixture stream
contains synthetic multilingual proposals and adversarial frames, not captured
authenticated output. Tests make no HTTP request, start no listener and consume
no inference credentials.

An enabling composition still requires a pinned HTTPS transport, actual
app-authorized account/model evidence, per-principal isolation, request/body/
header bounds, deadline and cancellation, confirmed local socket cleanup,
safe error classification and no retry after ambiguous delivery. It must never
read or forward CLI login credentials. Apps retain durable attempts, consent,
session state, factual validation, commits and fallback policy. Neither this
helper nor a fixture can issue those authorities or enable the capability.
