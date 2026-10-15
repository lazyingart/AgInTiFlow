# Restricted Application SDK (v1)

Node 22 ESM, Apache-2.0. Import
`@lazyingart/agintiflow/restricted-application`. This additive entry point is
separate from the CLI, Studio and `/agent/v1` server. It starts no listener,
loads no application state and mounts no public routes. No package release or
live model qualification is implied by the source export.

## Ownership and security boundary

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

Credentials belong only in the explicit transport closure. Known secret text
patterns and credential-shaped JSON fields are rejected, not redacted into an
apparently successful answer. This is defense in depth, not a universal secret
detector: the host must exclude private credentials from instructions, history,
tool results and images. Pixel contents are not scanned for secrets.

## API example

```js
import OpenAI from "openai";
import {
  createRestrictedApplicationRunner,
  createRestrictedOpenAIProvider,
} from "@lazyingart/agintiflow/restricted-application";

// Explicit server configuration; never populate these from a model/request.
const client = new OpenAI({
  apiKey: serverCredential,
  baseURL: "http://127.0.0.1:8008/v1",
  maxRetries: 0,
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

## Schema and limits

Closed supported JSON Schema subset: `type` (`object,array,string,integer,number,
boolean,null`), `description`, `enum`; objects require `properties,required,
additionalProperties:false`; arrays require `items,maxItems` (optional
`minItems`); strings require `maxLength` (optional `minLength`); numbers may use
`minimum,maximum`. A standalone `anyOf` can express bounded alternatives/null.
Unknown keywords, `$ref`, regex/format schemas and coercion are rejected.
Flatten app schema references explicitly and retain app-side domain validation.
String lengths use Unicode code points; transport/context caps use UTF-8 bytes.
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

## Qualification

`npm run smoke:restricted-application` uses synthetic accounts and offline
provider callbacks, plus the real OpenAI SDK with an in-memory fetch response.
It does not invoke models, a database, containers or services. App-owned acceptance
must still prove authentication/transport isolation, actual LocalLLM JSON/tool
and vision behavior, revision rebinding, apply-once under response loss, durable
history, cancellation and qualified Codex fallback before production routing.
