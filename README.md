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

The result is `artifacts/lazyingart-agintilite-0.1.0-preview.1.tgz`.
Use the reviewed tarball and its SHA-256 digest as the deployment input, not a
mutable worktree symlink. In a disposable qualification project:

```sh
npm install --offline --ignore-scripts --no-audit --no-fund /absolute/path/to/lazyingart-agintilite-0.1.0-preview.1.tgz
```

The package root and `/restricted-application` export the same four names:
`createRestrictedApplicationRunner`, `createRestrictedOpenAIProvider`,
`RestrictedApplicationError`, and `RESTRICTED_APPLICATION_PROTOCOL`.
The protocol remains `aginti-restricted-application-v1`, with text-only input.
Internal modules are not package exports.

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

There is no qualified DeepSeek transport or Codex backend in this preview.
Use the generic provider callback with an independently qualified transport.
Do not silently downgrade schema mode or select a different model after failure.
The adapter has no streaming or provider-specific reasoning-history support.

The host controls transport response size, endpoint/redirect policy,
credentials, retries and cancellation. Disable automatic SDK retries when
using this bounded contract. Credentials belong in the transport closure only,
never instructions, history, tool results or proposals.

Callback errors become safe `PROVIDER_FAILED` or `TOOL_FAILED` without raw
messages/causes. This intentionally does not expose an auth/quota/retryable
taxonomy. `PROVIDER_FAILED` alone is not permission to fallback. A future
typed transport-error contract needs separate qualification; do not infer it
from model text. Cancellation must not automatically trigger fallback.

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

Derived from AgInTiFlow commit
`e4c16b0610c41e690d9288739561a5a7e187cc9d`, Apache-2.0.
`restricted-application-contract.js` and `redaction.js` are unchanged.
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
