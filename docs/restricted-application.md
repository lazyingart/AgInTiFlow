# Restricted Application SDK (v1)

## Standalone application distribution

For a text-only app backend, AgInTiLite private preview 15 provides the same
bounded proposal loop without the full CLI, Studio or vision dependency graph.
Canonical Lite `main` is `2a0fc24e21b0d1e36ae17fac5fc977969a07a829`, also
available as `sdk/agintilite-native-callback-boundary-20261113` in the AgInTiFlow repository.
That ref is a standalone SDK tree, not a branch to merge into Flow's application
tree. Use the pinned local tarball, not a mutable worktree link. Its SHA-256 is
`be21104101c2ea09cbb8c41435aeaa3baeba384e57c1eeeb78f353c4e796d479`.
It remains private and unpublished to npm; no application is upgraded implicitly.

Preview 15 includes the bounded transport retirement, cancellation/result and
original HTTP-header guards from previews 11–14, and extends opaque result
adoption to the generic native adapter. Its 179 offline tests pass, including
44 callback-boundary cases and all 61 HTTP cases from a freshly installed reproducible
nine-file tarball. The dependency graph remains empty and the public API is
unchanged. Duplicate critical header evidence cannot authorize a proposal, read
callback or retry hint. The older preview-10 qualification below is historical;
use the current pinned tarball for new integrations.

Preview 10 rejects any own native `error` descriptor before projecting a proposal
or tool call, including falsey, hidden and accessor forms. Canonical preview 9
still admitted contradictory error-plus-choices responses; its default source was
fast-forwarded only after the existing preview-10 tests and immutable archive
were reverified. Exports, request construction, deadlines and provider policy are
unchanged. A trusted callback that already discarded an upstream error cannot
recover that evidence by swapping SDK versions.

Returned JSON snapshots are deeply frozen and may use null prototypes. Consume
their own data fields or compare JSON values, rather than relying on ordinary
object prototype identity or mutating them. This is not permission to normalize
raw untrusted inputs before the SDK's descriptor/schema validation.

The normal `@lazyingart/agintilite` import retains its seven exports and three
runtime files. The separate `@lazyingart/agintilite/deepseek-http` import exports
`createRestrictedDeepSeekClient` with the bounded options documented below.
That leaf opens native HTTPS only after an explicit request. The complete
package has nine files, zero dependencies and no CLI, install hook or server.

A 2026-11-07 preview-9 installed-package qualification exercised real Flash and Pro
requests through Lite itself. Each fresh process performs one account-scoped
read and two model requests. The Pro follow-up rereads revision 8 and removes
an item completed since revision 7 rather than trusting stale host history.
Structured IDs, revisions, labels and statuses match the authorized current
record; client close leaves no owned TLS/socket/timer resources. This is
synthetic host-supplied persistence, not native SessionStore or production
account/transaction acceptance.

Presentation remains a distinct boundary. Pro's JSON preserves the source label,
but its Markdown translates that label despite a verbatim-copy instruction.
The strict presentation check fails and is retained. Applications should
validate proposal IDs/statuses against current host state and render critical
facts from host-owned source/localization data. Free-form Markdown is a draft,
not a permission or factual authority. The qualification produces two such
host-rendered artifacts and rejects seven stale/foreign/altered-data controls;
it does not declare the failed raw-Markdown policy passed.

At the earlier preview-10 checkpoint, all 107 Lite offline tests and exact
reproducible packing passed. An independent 126-case matrix rejected contradictory envelopes
without reads, completed proposals or accessor hooks. Two offline packs reproduce
the original nine-file archive exactly. The first preview-9 live harness stopped on a protected-JSON prototype comparison
and did not retain enough data to judge its proposal; its two requests remain
inconclusive. The later four requests qualify the structured path with the
presentation limitation above. All six actual requests are counted once;
recorded-output checks and rendering add none. That preview-9 qualification did
not itself change SDK behavior, start automatic retry/fallback, activate an app
or publish a new Flow version. Preview 10's error guard is the separate repair
described above. LocalLLM and application-safe Codex remain separately gated.

A separate November 8 qualification uses the actual installed preview-10 native
client for a short document transformation. Flash translates two selected source
paragraphs; a fresh Pro process rereads a changed source and updates only the
second translation. Four actual requests and two scoped reads complete, with
source-bound proposals, semantic review and byte-verified host exports. The host
retains the equation, figure reference/image and code rather than asking the
model to reproduce them. See [source-preserving text transformations](restricted-source-transforms.md)
for the ownership boundary, checks and limits. This adds no SDK method, application
activation or automatic provider handoff.

The repository includes an offline LocalLLM text-profile conformance suite:
`npm run test:localllm-text-contract`. It reproduces English/Chinese SDK request
hashes and host-selected workstation/Mac model aliases, then checks synthetic
profile and response-identity cases. The oracle under `scripts/fixtures` is
neither an exported client nor a production admission authority. Its fabricated
approvals and responses never authorize inference. A real transport still
requires independently delivered owner evidence, protected profile acceptance,
a live lease, resource admission, credential provisioning, atomic request-ID
tracking, and cancellation/cleanup qualification. The generic SDK does not infer
that authority from a model name or response header. This suite adds no endpoint,
automatic fallback or application activation.

The oracle admits only the selected profile's exact request alias or resolved
model tag and hashes the original incoming spelling and bytes. Dispatch must
occur at or after owner issuance, independently of the permitted client/server
clock difference. Equal wire bodies do not admit a different package release:
the profile still binds its reviewed client version and package/harness hashes.

Node 22 ESM, Apache-2.0. Import
`@lazyingart/agintiflow/restricted-application`. This additive entry point is
separate from the CLI, Studio and `/agent/v1` server. It starts no listener,
loads no application state and mounts no public routes. No package release or
live model qualification is implied by the source export.

## Start with the qualified DeepSeek text entry

For a new text-only application integration, use the pinned Lite distribution
above and explicitly select the qualified DeepSeek profile. The runner is the
AgInTi-owned instruction/tool/schema boundary; the client supplies only bounded
HTTPS transport. Construct both from trusted server configuration after binding
the authenticated account and authorized history. Neither constructor discovers
credentials, chooses a fallback or starts a model request.

```js
import { createRestrictedApplicationRunner } from "@lazyingart/agintilite";
import { createRestrictedDeepSeekClient } from "@lazyingart/agintilite/deepseek-http";

const client = createRestrictedDeepSeekClient({
  apiKey: appOwnedCredential,
  model: "deepseek-flash", // Explicit alternative: deepseek-v4-pro.
  userId: hostDerivedOpaquePrincipal, // Cache isolation hint, not authentication.
  timeoutMs: 30_000,
  maxConcurrency: 2,
});
const runner = createRestrictedApplicationRunner({
  provider: client.provider,
  instructions: "Answer from authorized supplied data. Return a proposal, not a committed action.",
  tools: [],
  outputSchema: {
    type: "object",
    properties: { reply: { type: "string", minLength: 1, maxLength: 2000 } },
    required: ["reply"], additionalProperties: false,
  },
  limits: {
    timeoutMs: 30_000, maxSteps: 1, maxToolCalls: 1,
    maxCallsPerStep: 1, maxConcurrency: 2, maxOutputTokens: 1024,
  },
});
try {
  const result = await runner.run({
    input: [{ type: "text", text: userText }],
    history: authorizedAccountHistory,
  }, { signal: requestAbortSignal });
  // Validate facts, consent and any requested changes in the application.
  // result.status === "completed" means proposal generation only.
} finally {
  await client.close(); // Owned scope shutdown; local resource drain, not remote kill proof.
}
```

The caller supplies the variables in this example. The credential belongs to
that application, and the opaque principal must satisfy the client's documented
format; browser input cannot select either. History contains only authorized
typed user/assistant text. For retrieval, register typed read-only callbacks
closed over the same account and allow enough turns for a read plus a final
proposal. Writes and idempotent revision checks remain application-owned.

The full Flow package offers the same text path through
`@lazyingart/agintiflow/restricted-application` and
`@lazyingart/agintiflow/restricted-application/deepseek-http`. Its CLI, Studio and
native workers are separate products; an untrusted application should not
substitute a broad CLI/web route for this restricted entry.

There is no implicit provider fallback. In particular, LocalLLM/Mac still need
independent role admission, and application-safe no-tools Codex remains
unqualified. The later callback-provider example is a host interface, not a
claim that a local endpoint is available or admitted.

## Qualify the application's actual copy

A global CLI update does not update vendored JavaScript, an immutable container
image or a separately deployed gateway. Record the exact app-consumed package
or source digest and its adapter configuration. A matching protocol string or
version label alone cannot establish parser, cancellation or transport identity.
Older pins are not automatically broken; assess the features that adapter uses
before changing a working primary.

Qualify the whole adapter path: authorized history and reads, request/response
limits, exact model profile, malformed output, cancellation, factual checks and
revision-checked apply. A custom parser that has already discarded duplicate
keys or refusal metadata cannot gain native wire checks by swapping a library.
Keep app-owned provider consent, quotas and commit receipts authoritative.
Source references and framework tests do not prove a production deployment.

## Ownership and security boundary

`npm run test:restricted-retrieved-instructions` exercises hostile quoted
instructions inside an authorized read, including English, Chinese and Japanese.
Unknown write/delete tools, account/path selectors and mixed invalid batches
fail before an additional read. A separate host check rejects schema-valid
invented record text. The native SDK enforces dispatch and schema boundaries;
the application still owns semantic source checks. These are deliberately
different guarantees.

A bounded real DeepSeek qualification on 2026-11-06 used the installed 356.1
package: Flash handled the initial English request, and explicitly chosen Pro
handled a Chinese follow-up with host-retained history and fresh source reads.
Four requests took about 7.26 seconds. Both ignored hostile annotations, returned
exact current records and left owned/foreign files unchanged per invocation.
Foreign record bytes never entered requests. This synthetic case is not universal
prompt-injection resistance, application authentication/DB acceptance or native
SessionStore qualification. A preliminary run is retained separately because
the host fixture changed one record's text without advancing its revision;
the corrected source was requalified rather than treating that run as final.

The per-turn tool catalog reflects the remaining dispatch budget. On the last
allowed provider turn, or once the read-call budget is spent, configured read
tools are withdrawn and a transient system instruction asks for a final proposal
only when the supplied input and observed authorized evidence suffice. Full
history, native tool IDs/results, output schema and output-token budget remain
intact. No extra turn, automatic summary, repair or fallback is added. A provider
that requests an unavailable read still fails closed. Runs configured without
tools retain their existing request bytes.

This makes a bounded final turn possible; it does not prove that a model used
all required evidence or produced a semantically correct answer. The application
must still validate references, current revisions and any mandatory-read policy
before applying a proposal.

The application authenticates the caller, binds read-only handlers to that
account, supplies only authorized history/data, and applies validated proposals
in its own revision-checked, idempotent transaction. Model arguments cannot
select scope: close over the server-owned identity, never accept an owner field
in tool schemas. Do not share a caller-bound runner with another account.
Separate runners can run concurrently; each run has a new transcript and no
implicit history. Explicit history is historical data, not a durable session.

No built-in tools, shell, filesystem, browser, plugins, skill discovery, MCP,
ambient provider selection, secret loading, fallback, logging or persistence
are enabled by this SDK. It uses the existing bounded image-byte inspector;
it does not invoke that module's vision client, readiness probes or providers.

Provider and tool callbacks are **trusted host code**, not sandboxed model
code. `readOnly: true` is an explicit host contract, not proof that arbitrary
JavaScript is read-only. Handlers must authorize every read and must not mutate
application state. The runner can enforce tool names/schemas and sequential
dispatch, but cannot prevent an allowed tool's implementation from escaping its
scope. Schema validity is not semantic correctness or instruction-following
proof. Treat prompt injection in retrieved records/images as untrusted content.

Normalized provider and read callbacks return plain JSON data or a genuine
JavaScript Promise for that data. Synchronous data candidates are kept opaque
until strict snapshot validation; a `then` accessor, Proxy or custom thenable
cannot execute during result adoption. A plain PromiseLike returned by a query
library should be awaited inside a trusted `async` host callback first. Genuine
Promise implementations and SDK subclasses remain trusted host execution, as
does any resolution the callback performs before returning. This boundary does
not sandbox callback code or recover evidence that code already discarded.

On Node 22, cancellation uses a native disposable abort subscription that
cannot be suppressed by another listener's `stopImmediatePropagation()`.
Checkpoints also inspect the native parent-signal state before admitting a
continuation or final proposal. Cleanup removes only the SDK's subscription;
caller listeners remain owned by the caller. The optional DeepSeek HTTP client
uses the same propagation-resistant subscription. Pending callbacks and local
requests retain their existing capacity/close accounting; this does not prove
remote inference termination or refund a delivered request.

A custom `provider.complete` declares an already interpreted SDK response. The
runner cannot recover discarded native choices, finish/refusal/tool metadata or
duplicate JSON members after a host has parsed them away. Native wire guards
apply when the original data reaches the native provider factory; replacing a
vendor copy does not retrofit those guards into a custom host parser. Qualify
the actual adapter, including its normalization, repairs, call-ID mapping and
whole deadline. A refusal, cancellation or ambiguous protocol must not become
an implicit repair/fallback authorization.
The native factories inspect a decoded completion envelope and the still-raw
final/argument JSON strings inside it. HTTP authentication, raw-body decoding,
byte limits and transport isolation remain host responsibilities.

AgInTi-owned CLI, safe-chat and perception clients refuse HTTP redirects rather
than forwarding prompts, image bytes or credentials to another route. A 3xx is
not a compatibility or provider-handoff signal. Configure the canonical endpoint
instead. An injected SDK transport remains trusted host code: the examples set
`fetchOptions.redirect` to `manual`, preserving the non-success status without
following it. The SDK cannot impose this policy on an arbitrary callback.

Credentials belong only in the explicit transport closure. Known secret text
patterns and credential-shaped JSON fields are rejected, not redacted into an
apparently successful answer. This is defense in depth, not a universal secret
detector: the host must exclude private credentials from instructions, history,
tool results and images. Pixel contents are not scanned for secrets.

## Callback-provider API example

This alternative requires an independently qualified host transport. It is not
the default DeepSeek profile above, nor proof of LocalLLM readiness.

```js
import OpenAI from "openai";
import {
  createRestrictedApplicationRunner,
  createRestrictedOpenAIProvider,
} from "@lazyingart/agintiflow/restricted-application";

// Explicit server configuration; never populate these from a model/request.
const client = new OpenAI({
  apiKey: serverCredential,
  baseURL: qualifiedEndpoint,
  maxRetries: 0,
  fetchOptions: { redirect: "manual" }, // Reject redirects; configure the canonical URL.
});
const provider = createRestrictedOpenAIProvider({
  model: qualifiedModel,
  supportsImages: false, // true only after host qualification of this route
  complete: (body, options) => client.chat.completions.create(body, options),
});
const string = { type: "string", minLength: 1, maxLength: 2000 };
const object = (properties) => ({
  type: "object", properties, required: Object.keys(properties),
  additionalProperties: false,
});
const runner = createRestrictedApplicationRunner({
  provider,
  instructions: "Search before proposing an update. Return proposals only.",
  tools: [{
    name: "record_search", description: "Search authorized records, read only.",
    readOnly: true,
    inputSchema: object({ query: string }),
    outputSchema: object({ text: string, revision: { type: "integer", minimum: 1 } }),
    execute: (args, { signal }) => hostReadRecord(authenticatedOwner, args.query, signal),
  }],
  outputSchema: object({ reply: string }), // host's actual proposal schema here
  limits: { timeoutMs: 60_000, maxSteps: 8, maxToolCalls: 16, maxConcurrency: 1 },
});
const result = await runner.run({
  input: [{ type: "text", text: userText }],
  history: [{ role: "assistant", text: authorizedPriorReply }],
}, { signal: requestAbortSignal });
// result.status === "completed" means proposal generation, NOT DB completion.
// Host validates references/revisions and applies once in its own transaction.
```

`run` accepts exactly `{input, history?}` and `{signal?}`. Input is an ordered
array of 1..16 parts. Text: `{type:"text",text}`. Image:
`{type:"image",mediaType:"image/png"|"image/jpeg",data:<canonical base64>}`.
At most four images, 4 MiB each, 16 MiB total; existing structural image checks
also bound dimensions/decompression. No URL, file path, WebP, OCR substitution,
or history images. Unknown/unsupported parts reject before provider invocation.
The host must explicitly retain/restage images for a follow-up when appropriate.
`supportsImages` is a trusted route declaration, not an SDK-generated health proof.

Each text part must independently contain well-formed Unicode. Splitting a
JavaScript string at an arbitrary UTF-16 index can divide a surrogate pair, even
when concatenating the slices would recreate a valid string. Emit code-point-safe,
UTF-8-bounded parts without truncation; respect the aggregate context/part caps.
The runner rejects an invalid part before any provider call rather than silently
joining or replacing malformed text.

## Explicit DeepSeek text profile

Use `createRestrictedDeepSeekProvider({model,complete})` for an explicitly chosen
`deepseek-flash` or `deepseek-v4-pro` transport. This is a separate profile, not
an automatic format downgrade or provider fallback:

```js
import OpenAI from "openai";
import {
  createRestrictedApplicationRunner,
  createRestrictedDeepSeekProvider,
} from "@lazyingart/agintiflow/restricted-application";

const client = new OpenAI({
  apiKey: serverCredential,
  baseURL: "https://api.deepseek.com/v1",
  maxRetries: 0,
  fetchOptions: { redirect: "manual" },
  timeout: 20_000,
});
const provider = createRestrictedDeepSeekProvider({
  model: "deepseek-flash", // host-selected; use Pro explicitly when required
  complete: (body, options) => client.chat.completions.create(body, options),
});
// Pass provider to the same bounded runner above, with app-owned schemas/tools.
```

Exact options are `model,complete`; the factory returns a text-only provider.
It requests JSON-object output and disabled thinking, includes the exact final
schema in the system instruction, and validates the proposal locally. There is
no repair call, model alias rewrite, image downgrade, retry or alternate provider.
Thinking mode, future/legacy model names and vision require separate qualified
profiles. The host still owns the endpoint, credential, body/time bounds and
actual callback behavior; the factory cannot attest arbitrary injected code.

Complete native tool turns may contain assistant commentary; that text is
discarded, never treated as a final answer or parsed into commands. Optional
native call `index` must equal its batch ordinal before removal. Names, IDs,
argument schemas and the complete batch still pass the normal runner gates.
Commentary containing known DSML, XML, requested-tool or JSON/YAML tool-envelope
markers rejects the whole turn before a read; it is never parsed as commands or
silently discarded alongside native calls. Ordinary English/Chinese/Japanese
prose remains compatible, and protocol labels inside a valid final JSON value
remain data. Native `content` must be text or null; boolean/number coercion is
not an empty assistant message. The generic adapter preserves its existing
compatibility with omitted content on complete native tool turns. See the
[Chat Completions schema](https://api-docs.deepseek.com/api/create-chat-completion/).
Unknown fields, inconsistent indices, nonempty thinking output, refusal,
partial/blank responses and raw textual tool envelopes reject. Duplicate JSON
keys, including escaped aliases, reject in both final JSON and tool arguments;
the generic OpenAI adapter uses that same strict JSON parser.

This follows DeepSeek's documented [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)
and [non-thinking tool contract](https://api-docs.deepseek.com/guides/tool_calls/).
It deliberately avoids the separate thinking-history contract described in
[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/).

On 2026-11-05, a live synthetic English Flash and Chinese Pro fixture each passed
initial read/correction plus a fresh-runner follow-up after host-state reload in
the same Node process. This first fixture was not an OS-process restart; see
[conflict/restart qualification](restricted-application-recovery.md) for the
separate-process follow-up.
Each phase used two transport dispatches and one authorized read. The fixture
verified revision binding, language/context preservation, unchanged host state
before apply and an apply-once host receipt. These are bounded workflow results,
not a latency benchmark, universal model-quality proof or application rollout.
The SDK remains stateless: the synthetic host, like a real app, owned persistence,
authenticated scope and writes. No LocalLLM/GPU or app service was changed.

The result is detached, deeply frozen JSON:
`{schemaVersion:"aginti-restricted-application-v1",status:"completed",proposal,usage:{steps,toolCalls}}`.
It contains no transcript, source bytes, provider configuration or credentials.

## Provider contract

An explicit provider is `{supportsImages:boolean,complete(request,{signal})}`.
Requests contain only `schemaVersion,messages,tools,outputSchema,maxOutputTokens`.
Messages are system text; user/assistant typed content; assistant `calls`; or
tool `{role:"tool",callId,name,value}`. Tools contain only
`name,description,inputSchema`. Return one exact object:

- `{type:"tool_calls",calls:[{id,name,arguments:<JSON>}]} `
- `{type:"final",value:<JSON>}`

No streaming, automatic repair or alternate text-tool protocols. The OpenAI
adapter requires a single complete native response, exact native function-call
arguments or a final JSON document; truncated, mixed, refused and raw textual
tool protocol output fails closed. It requests `json_schema` and passes the
abort signal. Providers lacking this feature must be qualified with a separate
explicit host callback, not silently downgraded to an unsafe parse/fallback.
SDK transport metadata is ignored; only descriptor-read `choices` is projected.
Configure transport body limits, no redirects/unapproved endpoint access, and
no unbounded retries in the host. Never pass a request-supplied provider callback.

## Explicit transport-failure classification

Raw callback errors still become `PROVIDER_FAILED` or `TOOL_FAILED`, without
their messages, causes, status properties or response bodies. A trusted host
transport can explicitly preserve a closed classification through the new
`createRestrictedProviderFailure` export from the **same SDK module instance**:

```js
throw createRestrictedProviderFailure({
  category: "rate_limit",
  retryAfterMs: 1000,
});
```

The runner still rejects with `code:"PROVIDER_FAILED"`. Its optional deeply
frozen `providerFailure` is exactly
`{schemaVersion:"aginti-provider-failure-v1",category,retryAfterMs}`. Categories
are `authentication`, `permission`, `quota`, `rate_limit`, `unavailable`,
`timeout` and `protocol`. Omitted cooldown becomes null. A non-null cooldown is
an integer from0 through86,400,000 milliseconds, allowed only for `rate_limit`
or `unavailable`; it is descriptive and never starts a timer or retry.

Only the transport may classify its actually observed error using a reviewed
provider contract. The factory does not authenticate an HTTP response or infer
retryability from status/body prose. For example, an HTTP429 may represent a
temporary rate limit or exhausted quota; the host must distinguish those rather
than automatically retrying. A declaration is trusted host metadata, not an
upstream attestation or permission to switch providers. The app still owns its
durable attempt/ambiguity policy, user consent, budget and any new invocation.

A private in-process brand prevents JSON/model output, ordinary Error fields,
serialized copies, proxies, another SDK instance or tool callback errors from
impersonating that channel. The runner reconstructs a safe error and never
returns the transport's original stack/cause. It does not expose unknown errors
or classify parser failures automatically. Cancellation and the overall
monotonic deadline take precedence, even if synchronous callback code exceeds
the deadline before a timer can run. Capacity remains charged until ignored
cancellation settles. No default provider, retry, fallback or app routing changes.

## Explicit read-tool failures

Trusted read-only handlers may throw `createRestrictedToolFailure` from the same
SDK module instance. The invocation still fails with `code:"TOOL_FAILED"`; its
optional frozen `toolFailure` is exactly
`{schemaVersion:"aginti-tool-failure-v1",category,retryAfterMs}`. Categories are
`authentication`, `permission`, `quota`, `not_found`, `conflict`, `rate_limit`,
`unavailable`, `timeout` and `protocol`. Cooldown uses the provider channel's
integer bounds and is allowed only for `rate_limit` and `unavailable`.

```js
import { createRestrictedToolFailure } from "@lazyingart/agintiflow/restricted-application";

// Inside an authorized read handler, after the host verifies the source,
// response and its documented semantics. Discard any private error body.
throw createRestrictedToolFailure({ category: "rate_limit", retryAfterMs: 1000 });
```

This is host metadata, not proof of authentication, quota availability or safe
retry. The SDK does not map HTTP statuses or inspect raw errors. Unknown errors
remain opaque. Provider and tool brands are separate: neither callback can
impersonate the other's failure channel. Serialized, proxied, cross-module or
model-produced declarations do not carry authority. Cancellation and the overall
deadline win; uncooperative work remains charged until settlement.

A failed read stops the entire invocation without a partial proposal, later
batch reads, another model turn or fallback. Earlier successful reads are not
automatically retained by the stateless SDK. The host decides what authenticated
evidence may be retained, whether a later invocation is permitted, and how to
present a truthful blocker. Never interpret an unavailable source as absence.
Public research also needs source-kind and task-fit checks: a real DOI and exact
title/year do not prove that a result is a paper, peer-reviewed, relevant or
evidence for a performance claim. Validate metadata against the actual read,
including publication kind, before accepting the proposal.

The partial-read recovery fixture exercises this boundary across two actual
worker processes. A controlled second-read outage follows a successful read;
the failed invocation has no proposal and cannot treat unavailability as
absence. The synthetic host records the failure, changes its own source and
explicitly authorizes a fresh Pro invocation. That invocation restores only
host-approved history, rereads both current records and returns a proposal.
This is host-owned file/history qualification, not native SessionStore recovery,
production app authorization/transactions or automatic provider fallback.
Run `npm run test:restricted-partial-read-recovery` for the offline serial and
batch controls. The fixture has no live-provider/credential CLI option.

## Optional host read scheduling

`@lazyingart/agintiflow/read-request-gate` exports
`createReadRequestGate({minIntervalMs?,maxPending?})`. This is a lightweight,
in-memory scheduler for trusted host callbacks. It performs no HTTP request,
authentication, model invocation, logging, cache, retry or persistent admission.
It does not import the CLI, Studio or image providers. Lite's package is unchanged.

```js
import { createReadRequestGate } from "@lazyingart/agintiflow/read-request-gate";
const sourceGate = createReadRequestGate({ minIntervalMs: 1100, maxPending: 32 });

const data = await sourceGate.run(async ({ signal, defer }) => {
  // The host owns the approved endpoint, account scope and response/body limits.
  const response = await authorizedRead({ signal });
  const result = await validateSourceResponse(response);
  if (result.cooldownMs !== null) defer(result.cooldownMs);
  return result.data;
}, { signal: originalRequestSignal });

await sourceGate.close();
```

Pass the original cancellation/deadline signal before queue admission; the gate
does not create a new dispatch deadline. Configuration is descriptor-checked,
copied by value and server-owned. Interval defaults to1100ms (range1..60,000);
pending capacity defaults to32 (range1..64), in addition to the sole active job.
Queued calls are FIFO. Callback-local `defer(0..86,400,000)` can only extend the
cooldown and is invalid after that callback settles. No idle timer is retained
without queued work. Full queues reject READ_REQUEST_BUSY; invalid contracts
throw INVALID_GATE synchronously before admission. Queued or active caller cancellation rejects CANCELLED,
but an ignoring active callback keeps its slot until original settlement.

Close rejects queued/new work with READ_REQUEST_CLOSED, is idempotent and waits
for the admitted callback. It does not forcibly stop that callback or remote
work. Arbitrary host JavaScript is not sandboxed; callback errors remain host
errors. Classify them explicitly through the restricted SDK's safe failure
channel rather than returning raw diagnostics to a client. Share one gate for
one host-approved source budget; do not let model/request fields create gates,
change limits or select callbacks. Separate instances/processes do not share
quotas, and restart does not preserve cooldown. This is not a durable worker
lease, upstream attestation or application authorization boundary.

## Contradictory native provider responses

Native provider envelopes with an own `error` field are rejected before any
proposal or read is accepted, including null, hidden or accessor fields.
Contradictory error-plus-choices responses are protocol failures; their error
content is not inspected or exposed. Ordinary SDK metadata remains ignored.
This guard does not recover wire evidence a trusted host callback has already
discarded; host transports must preserve native failure semantics.

## Optional Codex assistance

Trusted standalone CLI work already supports explicitly enabled advisory Codex
delegation: `aginti --allow-wrappers --wrapper codex "Review this design."`.
AgInTi retains its session, tool policy, validation and finish gates. Wrapper
tools are disabled by default, and the normal runtime guard permits only the
selected wrapper. Advice is evidence to verify, not proof of a completed change.

That CLI wrapper is not a qualified restricted application provider: it uses the
CLI's configuration/environment, read-only tools, and an existing spare-model
retry policy. Read-only does not mean no tools. The restricted SDK does not
import or launch it. An application may use a separately qualified isolated
Codex transport only through explicit host policy; no credential presence,
primary error or model text enables one. Cancellation, invalid input and an
uncertain attempt must not silently dispatch another provider. The application
owns durable attempt/idempotency and fallback allowance; this SDK neither
authorizes nor proves them. See the official [Codex automation boundary](https://learn.chatgpt.com/docs/non-interactive-mode).

The optional [local admission diagnostic](codex-application-admission.md) inspects
the installed CLI's first request against a synthetic loopback responder. It
supplies no real credential and cannot enable a provider. On Codex 0.166.0,
the tested disabled-feature profile still advertises `request_user_input`;
the strict no-tools prerequisite remains unsatisfied.

## Schema and limits

Closed supported JSON Schema subset: `type` (`object,array,string,integer,number,
boolean,null`), `description`, `enum`; objects require `properties,required,
additionalProperties:false`; arrays require `items,maxItems` (optional
`minItems`); strings require `maxLength` (optional `minLength`); numbers may use
`minimum,maximum`. A standalone `anyOf` can express bounded alternatives/null.
Unknown keywords, `$ref`, regex/format schemas and coercion are rejected.
Flatten app schema references explicitly and retain app-side domain validation.
String lengths use Unicode code points; transport/context caps use UTF-8 bytes.
For array, scalar and root `anyOf` proposals, the native OpenAI/DeepSeek adapters
use a closed object envelope on the provider wire: `{"proposal": VALUE}`. The
SDK unwraps only that exact final envelope and validates VALUE against the host's
original schema. Applications still receive the original proposal type; object
root schemas, including an application property called `proposal`, retain their
existing wire and returned shape. Tool arguments/results are never enveloped.
Missing/extra/duplicate keys, direct unwrapped values and invalid proposal types
fail closed without retry. This reconciles the local schema dialect with
[OpenAI's object-root requirement](https://developers.openai.com/api/docs/guides/structured-outputs)
and [DeepSeek's JSON-object profile](https://api-docs.deepseek.com/guides/json_mode/).
It does not add unsupported provider schema keywords or qualify another model.
Enum values use JSON instance equality: object property order is irrelevant,
array order and exact primitive types/values remain significant, and strings
are not Unicode-normalized. Validation does not reorder the returned proposal,
rewrite schemas/wire bytes or weaken strict JSON boundaries. This applies to
final proposals, tool arguments and tool results. See the
[JSON Schema instance-equality definition](https://json-schema.org/draft/2020-12/json-schema-core#section-4.2.2).
No sparse/accessor/proxy/custom-prototype/cyclic/non-JSON values or hidden keys.

| Limit | Default | Maximum |
| --- | ---: | ---: |
| Total cooperative deadline | 60 s | 180 s |
| Provider turns | 8 | 16 |
| Total read calls | 16 | 32 |
| Calls per turn (sequential) | 3 | 4 |
| Textual context bytes including schemas | 256 KiB | 1 MiB |
| Callback result bytes | 64 KiB | 256 KiB |
| Requested output tokens | 4096 | 8192 |
| Concurrent runs per runner | 4 | 32 |

History: at most 24 text messages, 32 KiB each. Instructions: 16 KiB. Tools: 16.
Image base64 is separately bounded, not counted as textual context tokens.
JSON structural/node/depth limits can reject before a byte limit. The host must
enforce aggregate process/admission limits across runner instances/accounts.

Errors have stable `RestrictedApplicationError.code` and no raw callback cause
or content. Key codes: `CANCELLED`, `TIMEOUT`, `BUSY`, `VISION_UNAVAILABLE`,
`STEP_LIMIT`, `CONTEXT_LIMIT`, `DATA_LIMIT`, `SENSITIVE_DATA`, `OUTPUT_INVALID`,
`TOOL_CALL_INVALID`, `TOOL_RESULT_INVALID`, `TOOL_FAILED`, `PROVIDER_FAILED`.
Invalid contract/data/input/image also fail closed. No proposal is returned on
failure. Batch validation precedes every callback; duplicate call IDs reject.

The deadline includes preparation, provider/tool waits and final validation;
no subsequent dispatch or late success is accepted after interruption.
JavaScript cannot preempt synchronous host code or forcibly terminate a remote
request. Ignored cancellation can continue an already-started read/provider
operation. Such work stays charged against runner capacity until it settles,
and late rejection is observed. Use process isolation for hard termination.
Caller cancellation must not automatically start a fallback. The host chooses
qualified fallback only under its own policy and commits neither partial nor
invalid primary results. The SDK does not provide durable idempotency, billing,
session storage, transaction rollback or exactly-once app writes.

## Optional bounded DeepSeek HTTPS client

Applications can opt into a native Node HTTPS client instead of implementing
the `complete` callback. The normal SDK import does not load this client or
start network activity.

```js
import { createRestrictedDeepSeekClient } from "@lazyingart/agintiflow/restricted-application/deepseek-http";
import { createRestrictedApplicationRunner } from "@lazyingart/agintiflow/restricted-application";

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

The native client inspects original response headers before accepting any body
or exposing status-derived retry hints. Duplicate Content-Type, Content-Encoding,
Content-Length, Transfer-Encoding or Retry-After fields fail as protocol errors,
including equal values or different casing. Successful JSON responses permit
only absent or `chunked` transfer coding; unsupported coding lists are refused.
Unrelated repeated headers remain valid. Node's normalized header map can discard
duplicate values, so it alone cannot establish this boundary. These checks add
no retry, fallback or tool authority.

The runner's total deadline remains independent. Full local capacity refuses
new requests through the typed `unavailable` provider-failure channel. HTTP
401/403/402/429 map to authentication/permission/quota/rate-limit respectively;
408 and 504 map to timeout, 500–503 to unavailable, and other non-200 statuses
to protocol failure. Numeric Retry-After values from 0–86400 seconds are
reported in milliseconds only for rate-limit/unavailable; they schedule nothing.
Redirects, retries, fallback, streaming, compression, non-JSON content, duplicate
JSON keys, malformed UTF-8, truncated/over-limit responses and incomplete model
answers fail closed. Blank keep-alive lines count toward the byte/time limits.

Cancellation destroys the owned local request. Its admission slot stays charged
until the request and response actually close. `close()` blocks new admission,
aborts owned requests, destroys owned sockets and waits for local close events.
Repeated calls return the same promise; a cleanup failure remains a cached safe
failure. If request/response retirement cannot be confirmed within three seconds
after timeout, cancellation or failure, the client reports unavailable and is
permanently poisoned against new admission. The public failure does not remove
the physical record or return its slot; actual close events remain authoritative.
Client shutdown also bounds its wait to three seconds, including pooled sockets.
It reports a cached failure rather than inventing cleanup success. Normal
confirmed requests retain their keep-alive reuse; normal cancellation keeps its
original error and permits a fresh request once physically retired.

Public settlement and physical retirement have separate completion signals, so
shutdown cannot spin on an already-rejected task while a close remains pending.
Remote inference termination,
billing, response-loss idempotency and cross-process exactly-once dispatch are
not promised. The host owns those policies and must not automatically retry an
ambiguous request.

The client depends on the trusted Node TLS/DNS/runtime boundary. It offers no
OS sandbox or protection from a compromised same-process dependency. Credentials
are retained only in the client closure and authorization header, with literal
reflection checks on request/response data; this is not memory zeroization or
a universal privacy filter. Apps retain authentication, account-scoped history,
read authorization, factual/citation checks, revision CAS, writes, quotas and
provider consent. Existing callback providers and app routes remain unchanged.

## Qualification

`npm run smoke:restricted-application` uses synthetic accounts and offline
provider callbacks, plus the real OpenAI SDK with an in-memory fetch response.
It does not invoke models, a database, containers or services. App-owned acceptance
must still prove authentication/transport isolation, actual LocalLLM JSON/tool
and vision behavior, revision rebinding, apply-once under response loss, durable
history, cancellation and qualified Codex fallback before production routing.

On 2026-11-05, installed0.20.345-integration.0 passed a synthetic multi-caller
workflow with real DeepSeek: one Flash caller was cancelled at a deliberately
held host-read boundary while another account completed its two-turn Flash
proposal. The late read could not produce a proposal or another model call;
capacity stayed charged until it settled. A fresh, explicitly selected Pro
runner then read the first account's unchanged revision and proposed its edit.
Five transport dispatches, three account-bound reads, no automatic retry/fallback
and no cross-account marker in outgoing requests or returned proposals were
observed. English and Chinese content, unrelated remarks and exact IDs/revisions
were preserved. The host supplied scoped handlers and history; this is neither
native SessionStore nor an OS-process restart test.

The fixture separately exercises host CAS/apply replay after proposal validation;
that test action is not model authority or proof of user consent. Its sequential
file-backed store is not a production database or retained-descriptor authority.
The cancelled boundary was a cooperative JavaScript read, not an in-flight model
kill or remote hard-termination proof. The31-group offline suite adds deterministic
cross-account and same-account overlap, late rejection/capacity, final-publication
cancellation and abort-listener cleanup controls. No runtime repair was required.

Synchronous raw transport responses pass the same opaque-result boundary as
normalized provider responses and read results. The native OpenAI-compatible
adapter rejects Proxy/thenable responses and any own `then` field before
proposal parsing or read dispatch. Genuine native Promises and SDK Promise
subclasses remain trusted host execution; hooks already invoked inside a
trusted callback are outside this boundary. This does not qualify a new
provider, authorize fallback, or change application-owned persistence.
