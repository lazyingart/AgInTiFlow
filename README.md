# AgInTiLite

AgInTiLite is a bounded, text-only application tool loop for Node 22 ESM.
It accepts an explicit provider, dispatches only declared read-only callbacks,
and returns a validated JSON proposal. It has zero runtime dependencies.

This is a local preview distribution, not a published npm release or a general
agent service. `private: true` prevents npm publication. It includes no CLI,
HTTP server, shell, filesystem tools, browser, vision provider, MCP, plugins,
skill discovery, environment loader, session store or automatic fallback.

## Consumption

Build the local package from the pinned source commit:

```sh
npm run check
npm test
mkdir -p artifacts
npm run pack:local
```

The result is `artifacts/lazyingart-agintilite-0.1.0-preview.19.tgz`.
Use the reviewed tarball and its SHA-256 digest as the deployment input, not a
mutable worktree symlink. In a disposable qualification project:

```sh
npm install --offline --ignore-scripts --no-audit --no-fund /absolute/path/to/lazyingart-agintilite-0.1.0-preview.19.tgz
```

The package root and `/restricted-application` export the same seven names:
`createRestrictedApplicationRunner`, `createRestrictedOpenAIProvider`,
`createRestrictedDeepSeekProvider`, `createRestrictedProviderFailure`, `createRestrictedToolFailure`, `RestrictedApplicationError`, and
`RESTRICTED_APPLICATION_PROTOCOL`.
The protocol remains `aginti-restricted-application-v1`, with text-only input.
`createRestrictedToolFailure` adds an explicit host-issued read-tool failure
signal. Internal modules are not package exports.

```js
import { createRestrictedApplicationRunner } from "@lazyingart/agintilite";

const string = { type: "string", minLength: 1, maxLength: 2000 };
const closed = (properties) => ({
  type: "object", properties, required: Object.keys(properties),
  additionalProperties: false,
});
const runner = createRestrictedApplicationRunner({
  // Trusted, qualified transport. No provider/model/endpoint from user input.
  provider: { supportsImages: false, complete: qualifiedTransport },
  instructions: "Read authorized sources. Return a proposal with source IDs.",
  tools: [{
    name: "source_search",
    description: "Read authorized source excerpts.",
    readOnly: true,
    inputSchema: closed({ query: string }),
    outputSchema: closed({ sourceId: string, excerpt: string }),
    // Close over server-owned scope; never accept an account selector.
    execute: (args, { signal }) => readAuthorizedSource(scope, args.query, signal),
  }],
  outputSchema: closed({ reply: string, sourceId: string }),
  limits: {
    timeoutMs: 60_000, maxSteps: 4, maxToolCalls: 3,
    maxCallsPerStep: 1, maxConcurrency: 1,
  },
});
const result = await runner.run({
  input: [{ type: "text", text: userText }],
  history: [{ role: "assistant", text: authorizedPriorReply }],
}, { signal: requestAbortSignal });
// Validate citations and permissions in the app before displaying/applying.
// "completed" means proposal generation, never a committed application write.
```

`qualifiedTransport`, `readAuthorizedSource` and `scope` are application-owned
dependencies, not exported functions. Callbacks are trusted host JavaScript,
not sandboxed code. `readOnly: true` is a required host promise, not proof that
an arbitrary callback cannot write or make network requests.

Normalized callbacks return plain JSON data or a genuine JavaScript Promise.
Synchronous result candidates stay opaque until strict validation, so Proxies,
`then` accessors and plain custom thenables cannot execute during adoption.
Await a query library's plain PromiseLike inside a trusted `async` callback
before returning data. Genuine Promise implementations and SDK subclasses
remain trusted host execution; the runner does not sandbox their code or undo
resolution performed inside the host callback.

## Exact contract

`run` accepts only `{input,history?}` and `{signal?}`. Input has 1..16 ordered
`{type:"text",text}` parts, each at most 128 KiB UTF-8. No image, URL-as-input,
file, audio or attachment part is supported. Ordinary URLs within text are
data; the runner never fetches them. `supportsImages` must be exactly `false`.

History has at most 24 `{role:"user"|"assistant",text}` messages, each 32 KiB.
Every invocation has a fresh transcript. No history, pending tool calls, quota
receipts or user data are persisted by this package.

Provider shape: `{supportsImages:false,complete(request,{signal})}`.
Request keys are exactly:
`schemaVersion,messages,tools,outputSchema,maxOutputTokens`.
Messages contain system text, user/assistant typed text, assistant `calls`,
or tool `{role:"tool",callId,name,value}` records.
The callback returns one exact object:

```text
{type:"tool_calls",calls:[{id,name,arguments:<JSON>}]}
{type:"final",value:<JSON>}
```

Tool shape:
`{name,description,readOnly:true,inputSchema,outputSchema,execute}`.
Dispatch is sequential. The entire call batch is validated before the first
callback. Unknown tools, duplicate normalized call IDs and unexpected arguments reject.

Native provider response IDs are not application operation identities. The
OpenAI and DeepSeek native adapters preserve ordinary IDs, but assign a fresh
invocation-local ID when a later response reuses an earlier one. Assistant
calls, tool results and callback metadata use that same checked local ID. A
duplicate inside one batch, malformed ID or invalid call is never repaired into
new work. Custom normalized providers retain the invocation-wide uniqueness
rule. Step/read budgets, cancellation, no-retry and host scope remain unchanged.
Call IDs are neither account authorization nor durable idempotency keys.

An app callback that already projected a raw native response into
`{type:"final",value}` or `{type:"tool_calls",calls}` owns that projection's
validation. A vendor upgrade cannot recover error/finish/metadata evidence it
discarded. Use the native factories with the original transport response when
possible; qualify any app-specific parser before using its normalized result.
Tool arguments, schemas and provider requests are detached frozen snapshots.

The detached, deeply frozen success object is:

```text
{schemaVersion:"aginti-restricted-application-v1",status:"completed",
 proposal:<schema-validated JSON>,usage:{steps,toolCalls}}
```

The app owns authentication, book/account scope, provider consent/routing,
retrieval, citation/edition/locator checks, durable history, quotas and
revision-checked idempotent writes. Schema validity is not grounding,
instruction-following or semantic correctness. A model can return a
schema-valid invented citation; the app must reject it. Retrieved text is
untrusted, not permission to acquire more tools or change providers.

### Optional host proposal review

Pass `proposalReview: {readOnly:true, evaluate}` to validate schema-valid
proposals before completion. `evaluate(proposal, {signal, reads})` receives
frozen data and current invocation reads only; each read has exactly
`callId,name,arguments,value`. Authentication, source scope and application
semantics stay host-owned. Never use a shared mutable last-read variable to
bind concurrent calls.

Return exactly `{decision:"accept"}` or
`{decision:"revise",feedback:"bounded host feedback"}`. Feedback is nonblank,
well-formed, credential-free text, at most 2048 UTF-8 bytes. One refinement is
permitted within the original provider, deadline, steps, reads, context and
output-token budgets. Remaining provider turns incur their normal charges.
The rejected proposal remains uncommitted assistant
data. Host feedback grants no additional authority. Each final candidate must
pass review; repeated rejection or no remaining step yields `PROPOSAL_REJECTED`
without returning a partial proposal.

For a rewrite, a host reviewer can reject an unchanged draft. For a citation,
it can check the returned ID/locator against current authorized reads. Those
checks are application policy, not facts inferred by Lite. Review never
commits data or replaces current-state CAS and idempotency on apply.

Omitting review skips the callback/refinement and retains two-field usage.
Opted-in usage adds `proposalReviews` and `proposalRevisions` (zero or one).
Callback errors yield `PROPOSAL_REVIEW_FAILED`; malformed data yields
`PROPOSAL_REVIEW_INVALID`, with no raw cause or provider-fallback metadata.
Review uses the same cooperative cancellation and physical pending capacity.
Host callbacks remain trusted JavaScript, not sandboxed code. There is no
automatic transport retry, provider switch, storage, shell or service.

Native admission failures retain safe `providerFailure.category:"protocol"` on
`PROVIDER_FAILED`. The same-module brand follows transport return; arbitrary
callback throws/model text cannot forge it. Classification authorizes no retry.

## Native final proposal encoding

Preview 19 encodes strict JSON assistant history matching the application schema
in DeepSeek's required `{proposal: value}` envelope for non-object roots. Host
history stays unchanged; ordinary prose remains literal. OpenAI and object-root
wire forms are unchanged. Unwrapped incoming replies still fail closed.

Preview 18 uses a private native function named `__aginti_return_proposal` only
when the DeepSeek read catalog has closed after at least one observed read.
Its arguments encode the original final schema; no host function executes.
The name cannot be registered as an application tool. Only this exact forced
choice is admitted by the fixed HTTPS profile; it cannot select another tool.
Read permissions, host callback counts, steps, output-token cap and deadline do
not expand. No extra model call or retry is added. Initial no-read DeepSeek and
generic OpenAI requests retain their existing wire form.

Exactly one complete native call, valid ID, strict JSON and the original output
schema are required. Truncated/mixed/foreign calls, blank output and invalid data
still fail closed. Valid ordinary JSON replies remain compatible. A generated
proposal is never an application commit; the host still validates current facts.

## Providers and fallback

`createRestrictedOpenAIProvider({model,supportsImages:false,complete})` is an
optional pure wire adapter. It imports no OpenAI SDK and opens no connection.
It supplies Chat Completions arguments to the host's `complete(body,{signal})`
callback: explicit model, native tools, strict `json_schema`, `max_tokens`,
`stream:false`, `temperature:0`. It accepts only one complete native tool-call
response or final JSON document. Truncated, refused, mixed and malformed output
fails closed. Provider/model compatibility must be tested by the app.

Native error fields, duplicate decoded JSON keys, malformed metadata and mixed
protocols reject before any callback. Neutral metadata and valid native calls
remain compatible. Byte/depth/node bounds apply. Already-decoded host data must
also have ambiguous raw JSON rejected by the host transport.

`createRestrictedDeepSeekProvider({model,complete})` is the explicit
non-thinking DeepSeek wire profile. Supply it to the same bounded runner.

Exact factory options are `model,complete`. It accepts only `deepseek-flash`
or `deepseek-v4-pro`, returns `supportsImages:false`, requests `json_object`
with `thinking:{type:"disabled"}`, and includes the exact final schema in the
system instruction. Local runner/schema validation remains mandatory. This is
an explicit profile, not an automatic downgrade from the JSON-schema adapter.
It imports no provider SDK and starts no HTTP request. `hostTransport` is the
application's authenticated, fixed-endpoint, no-redirect, no-retry transport.
Its authentication, response byte limits and actual abort behavior require
the application's own qualification.

Native calls may carry English/Chinese/Japanese commentary. Competing DSML,
XML, requested-tool or JSON/YAML tool markers reject before reads. Malformed
types, thinking/indices/unknown fields, duplicate arguments, partial/refused
output and unsupported tools fail closed. Protocol labels inside final JSON
remain data. Vision/thinking/streaming are not qualified. The core opens no
HTTP; the optional client below is explicit. Codex application transport is
unqualified. Do not switch provider or output mode automatically.

Keep credentials in the transport closure, never in runner data. Disable
automatic transport/SDK retries; qualify response bounds and real cancellation.

Callback exceptions yield safe `PROVIDER_FAILED` or `TOOL_FAILED` without raw
messages/stacks/causes. Trusted same-module transports can throw
`createRestrictedProviderFailure({category,retryAfterMs?})`. Frozen metadata is
`{schemaVersion:"aginti-provider-failure-v1",category,retryAfterMs}`.
Categories: authentication, permission, quota, rate_limit, unavailable, timeout,
protocol. Omitted cooldown is null; integers0..86400000ms are allowed only for
rate_limit/unavailable. Nothing schedules a retry, wait or provider switch.

`createRestrictedToolFailure` issues the separate same-module tool channel:
`toolFailure` schema aginti-tool-failure-v1, same categories plus not_found/conflict,
same cooldown bounds. Provider/tool callbacks cannot impersonate each other.
Unknown errors/properties/Proxies/JSON clones/other SDK instances cannot forge
either brand. Cancellation/deadline wins even for synchronous throws after
expiry. Only the host classifies observed responses; unavailable is not absence.
A failed read stops before later reads/model turns. Hosts own pending intent,
ambiguity, consent, quotas, factual/citation checks, revision CAS, idempotency
and writes. Proposal completion or transport status does not authorize a save.

## Bounds and cancellation

| Limit | Default | Maximum |
| --- | ---: | ---: |
| Cooperative deadline | 60 s | 180 s |
| Provider turns | 8 | 16 |
| Total read calls | 16 | 32 |
| Sequential calls per turn | 3 | 4 |
| Context bytes, including schemas | 256 KiB | 1 MiB |
| Callback result bytes | 64 KiB | 256 KiB |
| Requested output tokens | 4096 | 8192 |
| Concurrent runs per runner | 4 | 32 |

Instructions are bounded to 16 KiB, tools to 16, and initial JSON to 4 MiB.
Structural node/depth limits can reject before byte limits. No truncation or
silent compaction occurs. String schema lengths count Unicode code points;
context/result caps count UTF-8 bytes.

The supported closed JSON Schema subset includes bounded object/array/string,
integer/number/boolean/null, enum, description and standalone `anyOf`.
Objects require `properties,required,additionalProperties:false`; arrays require
`items,maxItems`; strings require `maxLength`. Unknown keywords, `$ref`,
format, regex, coercion and arbitrary prototypes reject. Sparse arrays,
accessors, proxies, hidden/symbol keys, JSON hooks, cycles and nonfinite numbers
are rejected before using their content.

The deadline covers preparation, provider/tool waits and final validation.
Cancellation signals pending callbacks and prevents subsequent dispatch or
late success. Callbacks ignoring abort remain charged against runner capacity
until settlement; late rejection is observed. Synchronous JavaScript and remote
requests cannot be forcibly interrupted here. Use process isolation for hard
termination. Fresh runner instances do not share a global admission limit.

Node 22 native disposable abort subscriptions prevent another listener's
`stopImmediatePropagation()` from suppressing cancellation. Checkpoints also
inspect the native parent-signal state before continuing or returning a final
proposal. Only the SDK's own subscription is disposed; caller listeners remain
untouched. The optional DeepSeek HTTP client uses the same resistant mechanism.
Local request close accounting and remote-termination limitations are unchanged.

Stable error codes include `CANCELLED`, `TIMEOUT`, `BUSY`, `STEP_LIMIT`,
`CONTEXT_LIMIT`, `DATA_LIMIT`, `SENSITIVE_DATA`, `INVALID_CONTRACT`,
`INVALID_INPUT`, `INVALID_DATA`, `VISION_UNAVAILABLE`, `OUTPUT_INVALID`,
`TOOL_CALL_INVALID`, `TOOL_RESULT_INVALID`, `TOOL_FAILED`, `PROVIDER_FAILED`.
No partial proposal is returned on failure. Secret-pattern checks are defense
in depth, not a guarantee that arbitrary sensitive content will be detected.

## Optional bounded DeepSeek HTTPS client

Applications can opt into a native Node HTTPS client instead of implementing
the `complete` callback. The normal SDK import does not load this client or
start network activity.

```js
import { createRestrictedDeepSeekClient } from "@lazyingart/agintilite/deepseek-http";
import { createRestrictedApplicationRunner } from "@lazyingart/agintilite";

const client = createRestrictedDeepSeekClient({
  apiKey: appOwnedCredential,
  model: "deepseek-flash", // alternatively, explicitly "deepseek-v4-pro"
  userId: opaqueAppPrincipalToken,
  timeoutMs: 30000,
  maxConcurrency: 4,
});
try {
  const runner = createRestrictedApplicationRunner({
    provider: client.provider,
    instructions: "Use only the supplied record. Return a proposal; do not save it.",
    tools: [],
    outputSchema: {
      type: "object", properties: { reply: { type: "string", maxLength: 2000 } },
      required: ["reply"], additionalProperties: false,
    },
  });
  const result = await runner.run({ input: [{ type: "text", text: suppliedRecord }] });
  // Authenticate, validate facts/revision/consent, then apply in the host.
} finally {
  await client.close();
}
```

Construction requires an explicit visible-ASCII credential of 16–512 characters,
one of the two fixed model names, and an opaque `userId` matching
`[A-Za-z0-9_-]{16,128}`. Derive the latter in the authenticated host; it is a
provider cache-isolation hint, not authentication. Do not use personal data.
No environment, config file, URL, proxy, model fallback or credential discovery
is performed by the client. Never construct options from model or browser input.

The endpoint is fixed to `https://api.deepseek.com:443/v1/chat/completions`.
Requests use the existing non-thinking JSON-object profile and read-tool loop.
This leaf is text-only even in the full SDK. Only declared host read callbacks
can run; the transport adds no tools, sessions, writes or agent semantics.

| HTTP boundary | Limit |
| --- | --- |
| Per-request timeout | 100–60000 ms; default 30000 |
| Concurrent requests per client | 1–32; default 4; no queue |
| Request UTF-8 bytes | 2 MiB, including the opaque user ID |
| Response bytes | 256 KiB, including keep-alive whitespace |
| Response headers | 16 KiB; at most 128 fields |
| Unconfirmed local cleanup grace | 3000 ms; fixed, no caller override |
| Requested output tokens | 1–8192, further bounded by the runner |

Original response headers are checked before body/status hints. Duplicate
Content-Type, Content-Encoding, Content-Length, Transfer-Encoding or Retry-After
(equal/case variants too) fails. Success permits absent or chunked transfer
coding only; unrelated repeated headers remain valid.

The runner's total deadline remains independent. Full local capacity refuses
new requests through the typed `unavailable` provider-failure channel. HTTP
401/403/402/429 map to authentication/permission/quota/rate-limit respectively;
408 and 504 map to timeout, 500–503 to unavailable, and other non-200 statuses
to protocol failure. Numeric Retry-After values from 0–86400 seconds are
reported in milliseconds only for rate-limit/unavailable; they schedule nothing.
Redirects, retries, fallback, streaming, compression, non-JSON content, duplicate
JSON keys, malformed UTF-8, truncated/over-limit responses and incomplete model
answers fail closed. Blank keep-alive lines count toward the byte/time limits.

Cancellation destroys the owned request; its slot stays charged until request
and response actually close. Client close blocks admission, aborts requests,
destroys sockets and waits for local closure, including pooled sockets.
Repeated close returns the same promise. Timeout/cancel/failure retirement is
bounded to3000ms: unconfirmed retirement permanently poisons admission and
reports unavailable; exact physical records/slots remain until real close.
Shutdown also bounds waiting to3000ms and caches failure rather than inventing
success. Confirmed requests retain reuse; confirmed cancellation preserves its
original error and admits fresh work after retirement. Separate public/physical
signals prevent rejected-promise busy loops. Remote termination/billing,
response-loss idempotency and cross-process exactly-once are not promised;
never automatically retry ambiguous work.

The client depends on the trusted Node TLS/DNS/runtime boundary. It offers no
OS sandbox or protection from a compromised same-process dependency. Credentials
are retained only in the client closure and authorization header, with literal
reflection checks on request/response data; this is not memory zeroization or
a universal privacy filter. Apps retain authentication, account-scoped history,
read authorization, factual/citation checks, revision CAS, writes, quotas and
provider consent. Existing callback providers and app routes remain unchanged.

The optional HTTPS import adds two runtime files. Seven core exports and the
three-file core graph stay unchanged; the nine-file package remains private,
dependency-free and without install hooks. Loopback HTTP fixtures prove neither
live TLS nor application deployment readiness.

See NOTICE for Apache-2.0 provenance. Package tests enforce the closed import
graph, private distribution, zero dependencies and exact exports. Offline tests
do not qualify live quality, transactions, TLS, deployment or provider admission.
Existing application copies remain pinned until their owner qualifies an upgrade.
