# Model HTTP response budget

Built-in native model clients accept at most 16 MiB of decoded HTTP response bytes per
response. This includes assistant text, reasoning, native tool arguments and
provider error bodies. A request's `max_tokens` is a provider hint, not a receive
budget. Inline image request limits remain separate.

An oversized declared Content-Length is refused immediately. Otherwise the
reader counts actual decoded bytes, including decompressed gzip data. The first
over-budget chunk stops processing and cancels the body; no partial JSON or tool
call is accepted. HTTP success cannot turn truncated data into completion.
Native Response metadata and accepted bytes remain unchanged.

`MODEL_RESPONSE_TOO_LARGE` has local status413 and is not retryable. Its bounded
error contains no upstream body, URL, retry hints or diagnostics. It cannot
authorize an automatic SDK retry, text-tool repair or provider handoff. A caller
may choose a separate, explicit recovery after reviewing the failure.

Incomplete bodies return a bounded `MODEL_RESPONSE_INCOMPLETE`/502 error with
SDK retry disabled. Existing explicit core transient-recovery policy remains
available; moving reads into the guard does not introduce hidden SDK attempts.
Unsupported byte chunks fail as `MODEL_RESPONSE_INVALID`/422. Ordinary small
authentication errors and retryable HTTP failures keep their existing semantics.

Non-streaming/error bodies are bounded before the SDK parses them or considers
retries. Declared successful `text/event-stream` responses remain incremental
under the same cumulative byte budget. An oversized stream fails while reading;
no synthetic finish event is created. This does not add streaming Agent or
restricted-application semantics. Those runtimes still require complete model
responses before acting.

Cancellation closes the reader, removes its signal listener and releases the
read lock. A producer's cancellation rejection or nonsettlement cannot delay a
local refusal. The ordinary model request deadline still applies; this guard
does not prove that remote generation stopped or cancel arbitrary JavaScript in
a custom transport. Trusted transports must return Fetch-compatible byte streams.

The limit bounds decoded response bytes, not total process RSS, model tokens,
all requests in an application or an upstream engine's allocations. A network
stack can prefetch an incoming chunk before cancellation. Per-app concurrency,
account authorization, quota commits and host transport admission remain the
application owner's responsibility. AgInTiLite remains dependency-free and uses
its caller-supplied transport; this native OpenAI-compatible HTTP client is not
silently injected into Lite or any application's runtime.
Custom client factories and external SDK transports remain responsible for
equivalent receive bounds; this helper is not a sandbox for host JavaScript.

`npm run test:model-response-budget` covers gzip and unknown-length HTTP,
exact/over-limit bytes, UTF-8, bounded errors, retry/handoff policy, incremental
SSE, cancellation and cleanup. Native persisted-runtime fixtures prove both
planning and tool responses fail before any tool/finish, preserve bounded state,
release the session lease, and resume in a fresh process to create one artifact.
