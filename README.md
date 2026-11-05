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

The result is `artifacts/lazyingart-agintilite-0.1.0-preview.4.tgz`.
Use the reviewed tarball and its SHA-256 digest as the deployment input, not a
mutable worktree symlink. In a disposable qualification project:

```sh
npm install --offline --ignore-scripts --no-audit --no-fund /absolute/path/to/lazyingart-agintilite-0.1.0-preview.7.tgz
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
callback. Unknown tools, duplicate call IDs and unexpected arguments reject.
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

## Providers and fallback

`createRestrictedOpenAIProvider({model,supportsImages:false,complete})` is an
optional pure wire adapter. It imports no OpenAI SDK and opens no connection.
It supplies Chat Completions arguments to the host's `complete(body,{signal})`
callback: explicit model, native tools, strict `json_schema`, `max_tokens`,
`stream:false`, `temperature:0`. It accepts only one complete native tool-call
response or final JSON document. Truncated, refused, mixed and malformed output
fails closed. Provider/model compatibility must be tested by the app.

Preview 2 backports the full SDK's strict JSON parser and native metadata
checks. Duplicate decoded keys reject at every nesting level, including escaped
aliases and native tool arguments. A malformed call rejects the whole batch
before any callback. Legacy `function_call`, non-array `tool_calls` and malformed
`refusal` metadata cannot accompany a successful final answer. Neutral null/empty
metadata and valid complete native calls remain compatible.

Parsing is bounded by UTF-8 bytes, depth and node count; malformed JSON produces
a stable protocol error without raw response text. This strengthens the optional
wire adapter. The runner still validates schemas/credentials and flattens callback
errors; using the adapter alone does not replace that runner boundary. Host
transports injecting already-decoded objects remain host-owned and must reject
ambiguous raw JSON before decoding it. No app transport is silently replaced.

Preview 3 adds an explicit non-thinking DeepSeek wire profile:

```js
import {
  createRestrictedApplicationRunner,
  createRestrictedDeepSeekProvider,
} from "@lazyingart/agintilite";

const provider = createRestrictedDeepSeekProvider({
  model: "deepseek-flash", // trusted host choice; Pro is deepseek-v4-pro
  complete: (body, { signal }) => hostTransport(body, { signal }),
});
// Supply provider to the same bounded runner, host schemas and scoped tools.
```

Exact factory options are `model,complete`. It accepts only `deepseek-flash`
or `deepseek-v4-pro`, returns `supportsImages:false`, requests `json_object`
with `thinking:{type:"disabled"}`, and includes the exact final schema in the
system instruction. Local runner/schema validation remains mandatory. This is
an explicit profile, not an automatic downgrade from the JSON-schema adapter.
It imports no provider SDK and starts no HTTP request. `hostTransport` is the
application's authenticated, fixed-endpoint, no-redirect, no-retry transport.
Its authentication, response byte limits and actual abort behavior require
the application's own qualification.

Complete native calls may carry ordinary English/Chinese/Japanese commentary.
Known competing DSML, XML, requested-tool and JSON/YAML tool-envelope markers
reject the whole turn before a read; they are never parsed into commands.
Native `content` cannot be boolean/number data masquerading as an empty string.
Neutral null/empty content stays compatible. Nonempty thinking, inconsistent
indices, unknown model fields, duplicate arguments, partial/refused responses
and unsupported tool names fail closed. A protocol label inside a valid final
JSON value remains data. Thinking/history/vision/streaming profiles require
separate support. See DeepSeek's [tool calls](https://api-docs.deepseek.com/guides/tool_calls/),
[JSON output](https://api-docs.deepseek.com/guides/json_mode/) and
[native message schema](https://api-docs.deepseek.com/api/create-chat-completion/).

The package still supplies no credentialed HTTP client or qualified Codex
backend. Do not silently retry, downgrade output mode or select a different
model after failure. Existing host adapters are not replaced automatically.

The host controls transport response size, endpoint/redirect policy,
credentials, retries and cancellation. Disable automatic SDK retries when
using this bounded contract. Credentials belong in the transport closure only,
never instructions, history, tool results or proposals.

Callback errors become safe `PROVIDER_FAILED` or `TOOL_FAILED` without raw
messages/causes. Preview4 adds explicit trusted-transport classification:

```js
throw createRestrictedProviderFailure({ category: "rate_limit", retryAfterMs: 1000 });
```

Import that factory from the same SDK module instance as the runner. Only a
trusted transport may call it for its actually observed failure. Runner errors
retain `code:"PROVIDER_FAILED"` and an optional deeply frozen `providerFailure`:
`{schemaVersion:"aginti-provider-failure-v1",category,retryAfterMs}`. Exact
categories: `authentication`, `permission`, `quota`, `rate_limit`, `unavailable`,
`timeout`, `protocol`. Omitted cooldown becomes null; a non-null integer from0
through86,400,000 milliseconds is allowed only for `rate_limit` or `unavailable`.
No wait, repair, retry or provider switch is performed. The host still owns
durable attempt/ambiguity policy, consent, quotas and new invocations.

This is a private in-process brand, not an HTTP attestation. The host must map
its reviewed provider contract; status429 alone cannot distinguish temporary
limits from exhausted quota. Raw Error properties, model text, proxies, JSON
clones, another SDK instance and tool callback failures cannot forge the
channel. Unknown failures stay opaque; the original callback stack/cause is
never propagated. Cancellation/deadline wins, including a synchronous callback
that throws after the monotonic budget expires before the timer runs.

Preview7 adds `createRestrictedToolFailure({category,retryAfterMs?})` for trusted
read-only handlers. A failed invocation retains `code:"TOOL_FAILED"` and an
optional frozen `toolFailure` exactly
`{schemaVersion:"aginti-tool-failure-v1",category,retryAfterMs}`. Categories are
the provider set plus `not_found` and `conflict`; cooldown uses the same bounds
and eligible categories. The same-module private brand is separate from the
provider channel. Unknown errors, proxies, serialized copies and another SDK
instance remain opaque. Neither callback may impersonate the other channel.

Only the host may classify its observed source response. A missing or failed
read stops the invocation before later batch reads or another provider turn;
no partial proposal, automatic retry or fallback occurs. The host owns any
retained evidence, presentation and later attempt policy. Unavailability is
not authoritative absence. Cancellation/deadline/capacity rules stay intact.
For public research, verify publication kind and all selected metadata against
the actual read. A real DOI does not prove task fit, peer review or findings.

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

Stable error codes include `CANCELLED`, `TIMEOUT`, `BUSY`, `STEP_LIMIT`,
`CONTEXT_LIMIT`, `DATA_LIMIT`, `SENSITIVE_DATA`, `INVALID_CONTRACT`,
`INVALID_INPUT`, `INVALID_DATA`, `VISION_UNAVAILABLE`, `OUTPUT_INVALID`,
`TOOL_CALL_INVALID`, `TOOL_RESULT_INVALID`, `TOOL_FAILED`, `PROVIDER_FAILED`.
No partial proposal is returned on failure. Secret-pattern checks are defense
in depth, not a guarantee that arbitrary sensitive content will be detected.

## Extraction and qualification

Preview 6 fixes object-valued enum equality throughout final proposals and tool
arguments/results. JSON object key order is irrelevant; array order, exact
values/types, keys and Unicode spelling remain significant. The validated
proposal and wire schema are not reordered. Four additional groups cover
recursive equality, invalid bindings, native transports and strict JSON guards.
There is no dependency, public export, retry or provider-policy change.

Preview 5 withdraws read tools on the last provider turn and after the read
budget is spent. A transient system instruction requests final JSON only when
existing authorized evidence suffices. History/results, schemas and output
budget are preserved. No extra call, summary, formatter or fallback is added;
ignored limits and invalid answers still reject. No-tools request bytes remain
unchanged. The host still owns mandatory reads, factual/reference validation,
revision checks and writes. Five additional offline groups cover these gates.

Derived from AgInTiFlow commit
`e4c16b0610c41e690d9288739561a5a7e187cc9d`, Apache-2.0.
`redaction.js` is unchanged. Preview 2's contract module is byte-identical to
the hardened full SDK at `8dc44e691e61c2c23c8cc21d6aed26939d59c33e`;
only the duplicate-aware parser was added to the original contract module.
The runner's loop, deadlines, cancellation, admission accounting, schema checks,
batch checks and result/error envelopes are retained. The extraction:

- Removes the image inspector and all transitive vision/provider imports.
- Rejects image-capable declarations and all non-text parts.
- Counts the complete text context directly; reduces initial JSON cap from
  24 MiB to 4 MiB because no image payload is accepted.
- Keeps the explicit native JSON wire adapter without any SDK dependency.

Offline tests cover account isolation, context reuse only when explicitly
supplied, unknown tools, atomic batch rejection, mutable aliases, schema/secret
boundaries, deadlines, abort propagation, late rejection/capacity, native JSON
responses and text-only refusal. Package tests pack twice, compare archive
hashes, verify an exact seven-file surface, install offline into a disposable
consumer and enforce the closed runtime import graph. No model is invoked.

These checks do not qualify live model quality, transport authentication,
latency, citation correctness, app transactions or production isolation.

The preview-2 offline review reproduced seven failing wire-integrity regressions
on unchanged preview 1 before the backport. Positive controls preserve valid
Unicode/escapes, neutral metadata and the already-closed newline identifier
boundary. No model request, application edit, provider activation, deployment or
npm publication is part of this preview. Existing vendored copies stay pinned
until their application owner independently reviews and qualifies an upgrade.
