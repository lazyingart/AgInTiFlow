# AgInTiLite private application pipe

Optional Node 22 ESM transport for a Python or other application host using a
private child-process channel. The installed AgInTiLite runner owns the
bounded model/read/schema loop. This package starts no process or network service
and loads no credentials, configuration, tools or provider implicitly.

Install the exact local archives of both private packages. Build this companion
with `node packages/pipe/scripts/build-package.js /absolute/output/directory`.
Pipe preview.3 requires AgInTiLite `0.1.0-preview.23`. This pair supports
explicit DeepSeek Flash and Pro profiles and preserves the GPT-5 completion
budget when the host selects OpenAI. Existing pipe preview.2 installations
can keep using their originally qualified SDK archives.
Install your selected SDK archive and the pipe archive together with
`npm install --offline --strict-peer-deps --ignore-scripts`.
The pipe has eight packaged files and a 64 KiB unpacked cap. A shared build
destination accepts byte-identical repeats and refuses conflicting archives.

From this source tree, run `npm --prefix packages/pipe test` with the bundled
source version of the SDK. To verify a separately delivered archive, set
`AGINTILITE_TEST_PEER_ARCHIVE` to the absolute path of the qualified SDK tarball
and run the same command. The tests verify the archive digest before installing.

## Bootstrap

The application supplies a trusted Node bootstrap. Import
`serveRestrictedApplicationPipe` from `@lazyingart/agintilite-pipe/streams` and call
it with `{input, output, scopeId, provider, instructions, outputSchema, tools?,
limits?, closeGraceMs?}`. Supply raw byte streams, normally the child's stdin and
stdout. Keep stdout exclusive to this protocol. No bootstrap or CLI is inferred.
Use a qualified SDK provider or the explicit SDK `/deepseek-http` leaf. Close that
HTTP client separately in the bootstrap's `finally`. The host owns process and
Docker isolation, credentials, network permissions and child termination.

`tools` is a fixed array of `{name,description,inputSchema,outputSchema}`. All are
read-only application RPCs. There are no shell, filesystem, web, render or publish
tools. The host authenticates accounts, scopes read I/O and validates citations,
semantics, quotas and atomic commits. Tools and provider callbacks are trusted
host code, not a JavaScript sandbox. Instructions and JSON schemas do not prove
factual correctness. Do not forward a browser-supplied scope, history or schema.

The lower-level `createRestrictedApplicationChannel({...config,emit})` accepts
strict JSON frames and calls `emit(frame)`. `emit` returns undefined or a genuine
Promise which settles only after delivery to the local channel. `accept(frame)`
is a handled Promise. Both surfaces expose `close()` and safe counters through
`inspect()`. Close is idempotent, blocks new admission and drains local callbacks
within 20–3000 ms; an uncooperative callback yields `CLOSE_UNPROVEN`. A local drain
never proves that a remote service or host read was terminated.

## JSONL v1

One UTF-8 JSON object per LF line, at most 262144 bytes excluding LF. Duplicate
keys, CRLF, blank lines, invalid UTF-8, truncated frames and non-JSON data reject.
Every frame has exactly the common fields `schemaVersion:1`,
`protocol:"aginti-restricted-application-pipe-v1"`, `nonce`, `scopeId`, `type`,
plus the action fields below. Only `ready` omits `requestId`.

`scopeId` is an opaque server-selected account binding, 16–128 ASCII letters,
digits, `_` or `-`. The random 64-hex boot nonce binds one worker incarnation.
They are correlation and private-channel checks, not network authentication.
Use one channel per authenticated account. Different scopes cannot cancel or
reply to another scope's work. Request IDs use 16–80 letters/digits/`_`/`-`.

Inbound frames:

| type | Additional fields |
| --- | --- |
| `run` | `request:{input:[{type:"text",text}],history?}`; SDK history format |
| `cancel` | none; exact active request only |
| `read_result` | `readId,value` |
| `read_error` | `readId,failure?`; `{category,retryAfterMs?}` from the SDK tool-failure dialect |

No provider/model/base URL/path/runtime/policy selectors are allowed. Histories
and read values are untrusted model input; the parent selects and authorizes them.

Outbound frames:

| type | Additional fields |
| --- | --- |
| `ready` | `engineProtocol,providerAvailability:"not-probed",readTools,maxFrameBytes,maxRequests:64,maxConcurrency:1` |
| `accepted` | none; successfully flushed before any provider dispatch |
| `read` | opaque `readId,name,arguments`; never a raw model call ID |
| `read_cancel` | `readId`; advisory request to stop a parent-owned read |
| `cancel_requested` | none; acknowledgment of the signal, not proof of remote termination |
| `result` | `result:{schemaVersion,status:"completed",proposal,usage}` from the actual SDK |
| `error` | closed `code`, optionally SDK-issued `providerFailure` or `toolFailure` metadata |

One run is admitted at a time. Late provider/read work stays charged after
cancellation until it settles. A pending parent read needs an exact reply or
channel close; cancellation alone does not free it. Replies cannot cross request
IDs or be reused. At most 64 request IDs are admitted in one worker. Used IDs
cannot be resurrected; a genuinely unissued `BUSY` request can be tried later.
The application replaces an exhausted worker. No automatic retry or fallback.

`result` is a proposal, never a receipt for an application save. This transport
does not persist sessions, prompts or replies. The parent persists authorized
context and commit/idempotency receipts. After response loss, EOF or broken
output, dispatch may be ambiguous: detach, probe the application's durable state
and require an explicit recovery decision. Never blindly replay a `run` or treat
disconnect as a terminal failure. No synthetic terminal event is emitted on EOF.
Write backpressure is bounded; the stream adapter closes failed channels and
rejects `done`. It does not call `process.exit` or claim remote cancellation.

## Qualification

Offline tests use the real installed SDK loop with scripted providers and a
Python standard-library pipe host. They qualify framing, isolation, deadlines,
cancellation, backpressure and package boundaries. They do not qualify a live
provider, application rollout, model quality, retained storage or native
`/agent/v1`. Existing app routes and provider defaults remain app-owned.
