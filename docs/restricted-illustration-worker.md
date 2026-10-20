# Restricted Illustration Worker (Pre-Enable)

This additive Node 22/Linux SDK implements a durable illustration job boundary.
It does not mount an HTTP server, expose Studio, or change AgInTiLite. Its public
capability is **disabled**; the RPC create action returns
`ILLUSTRATION_QUALIFICATION_REQUIRED`. There is no enable flag or self-attestation
that bypasses this gate. No provider call has been qualified live for this slice.

## Ownership and Imports

Available source/package subpaths:

- `illustration-worker`: `createIllustrationWorker({store, transport})`.
- `illustration-worker/store`: `openIllustrationStore(canonicalPrivateRoot)`.
- `illustration-worker/transport`: `createVeniceIllustrationTransport({apiKey})`.
- `illustration-worker/rpc`: `createIllustrationRpc({worker, clients})`.
- `illustration-worker/contract`: canonicalization, profile and request validators.

The frozen worker surface is `capabilities()`, `create(owner, key, request)`,
`status(owner, jobId)`, `cancel(owner, key, jobId)`, `content(owner, artifactId)`,
`settleLocalWork()` and `close()`. `owner` is exactly `{appId, principalId}`.
Create/status/cancel synchronously return the public job envelope; content returns
`{artifact, bytes: Buffer}`. `settleLocalWork()` and idempotent `close()` return
promises. The RPC requires a branded real worker, not a caller-shaped substitute.
The transport's frozen `submit(request, signal)` returns a promise of image bytes;
only the worker validates and commits them. This source is not an npm release.

The worker SDK is an internal host interface for qualification, not a security
boundary against hostile JavaScript in the same process. Its `create(owner, key,
request)` method can submit real work when supplied a real transport. Do not call
it with production credentials during offline qualification. `fetchImpl` is a
trusted host dependency used by offline tests; it is never a request field.

The app owns consent, account authentication, authorized public passages,
citations, spoiler limits, factual overlays, quota and billing settlement. An
opaque source digest alone cannot prove that a passage is public. Generated
pixels are decorative illustration, not geographic or factual evidence.

The worker owns job identity, irreversible dispatch claims, PNG verification,
private storage, ownership checks and bounded transport. It never reads ambient
provider keys, config, skills or model routes. No shell, browser, Agent loop,
reference URLs/uploads, or automatic fallback is involved.

## Fixed Profile

The immutable profile is fingerprinted in every job and in the database header:

- Venice `https://api.venice.ai/api/v1/image/generate`, `nano-banana-2`.
- One inline base64 PNG, requested 1024x1024, safe mode on. No image downloads.
- Input prompt <=8192 UTF-8 bytes; no client provider/model/endpoint/path fields.
- Output <=8 MiB, <=2048 pixels per side and <=4,194,304 pixels.
- PNG subset: 8-bit RGB/RGBA, non-interlaced. All chunks have verified CRCs;
  every scanline is decoded and re-encoded. Only IHDR/IDAT/IEND survive. APNG,
  palette/interlaced images, tRNS transparency, bad filters, truncated or trailing
  data fail closed; transparency must be represented as explicit RGBA pixels.
- 300-second total local wait; single active/uncertain job per worker store.
- 64 jobs, 512 idempotency receipts, 64 MiB retained PNG bytes. No queue or
  automatic pruning/deletion. Full stores refuse new work, not replay.

This deliberately supports only the existing inline Venice response shape.
It does not wrap the legacy GRS helper, which retries paid submissions and
downloads provider URLs. GRS requires a separate qualified no-retry/poll transport.
Changing provider/profile requires a reviewed new store/profile, not an API flag.

## Exact Transport Contract

`createIllustrationRpc` returns an async function accepting
`{method, originalPath, rawHeaders, body}` and returning `{status, headers, body}`.
`body` is a bounded Buffer. No socket is opened. A future host must preserve the
original path and raw duplicate headers, cap bytes before buffering, impose read
deadlines, and use authenticated private transport. Do not pass Express-decoded
paths/headers or a public Studio router.

Exact POST paths under `/illustration/v1`:

| Action | Exact body |
| --- | --- |
| `/capabilities` | `{}` |
| `/jobs/create` | `{actionId,sourceBinding:{scopeDigest,contentDigest,policyDigest},overlayDigest,prompt,styleId}` |
| `/jobs/status` | `{jobId}` |
| `/jobs/cancel` | `{jobId}` |
| `/artifacts/content` | `{artifactId}` |

All body bytes must be the contract's `canonical(value)` UTF-8 representation:
sorted keys, no whitespace, duplicate keys, non-JSON values or alternate encodings.
Comparison is against the actual bytes, so a UTF-8 BOM is not silently stripped.
Digests are lowercase unprefixed SHA-256 hex. IDs/keys match
`[A-Za-z0-9._~-]{16,128}`. `styleId` is exactly `illustration`. The profile digest
is SHA-256 of canonical profile JSON. Body limit is 32768 bytes.

Every call requires exact `Authorization: Bearer <token>` and
`x-aginti-principal-id`. Client configuration is exactly
`{appId,token,trustedPrincipalProxy:true}`; the service credential binds the app
and explicitly delegates per-request principal authentication to its BFF. Never
give it to a browser or device. Tokens are 32..256 characters from
`[A-Za-z0-9._~-]`. Duplicate app IDs/tokens and ambiguous headers reject. Mutations
alone require standard `Idempotency-Key`. No legacy application header aliases.
Content-Type is `application/json`, optionally `; charset=utf-8`; encoding and
query/trailing/double/encoded-path aliases reject. Missing/foreign resources are
indistinguishable 404s, including content and cancellation.

Status has exactly `{schemaVersion:1,jobId,status,profileDigest,sourceBinding,
overlayDigest,artifact,error}`. Artifact is null or exactly
`{artifactId,mediaType:"image/png",byteLength,sha256,width,height}`. Errors are
stable codes, never provider messages. Content is the exact verified immutable
PNG bytes with content length/hash, attachment disposition, `private, no-store`
and `nosniff`. Paths, prompts, provider task IDs/URLs and credentials are absent.

## Durable Submission, Replay and Cancellation

SQLite `BEGIN IMMEDIATE` and `synchronous=FULL` atomically commit ownership,
action/request/profile hashes and `submitting` before releasing transport work.
The transaction never spans a provider await. Exactly one claimant can submit.
Both an app/principal/key and an app/principal/action ID deduplicate. Changed
requests conflict; new keys cannot resubmit the same action. Replay returns the
original job with its **current** status, not a stale byte-for-byte HTTP response.

There is one submission attempt, including HTTP errors. No retries, alternate
providers or URL fetches. A crash before send is intentionally indistinguishable
from a lost acknowledgement: never redispatch. On restart a submitting job remains
pending until its persisted deadline; status then records `recovery_required`.
An uncertain job keeps the capacity slot. Do not erase the database to retry it.
No automatic recovery/removal mechanism is included yet.

All transport exits abort their local request controller and cancel unread bodies,
including errors rejected before acquiring a reader. Cleanup does not await an
uncooperative injected stream indefinitely. This is local resource cleanup, not
proof of remote cancellation.

Successful canonical PNG bytes and the terminal receipt commit in one SQLite
transaction. A lost public response replays the same job and bytes after restart.
Invalid PNG yields `failed`/`ILLUSTRATION_IMAGE_REJECTED`. Other submission/local
uncertainty yields `recovery_required`/`ILLUSTRATION_RECOVERY_REQUIRED`.

Cancellation first durably changes `submitting` to `cancel_requested`, then
aborts a controller in this worker instance. A different process's cancellation
still prevents publication; it cannot instantly signal that process's transport.
Late bytes never overwrite cancellation. Local abort becomes recovery-required:
it does **not** prove provider cancellation, refund, or absence of charges. An
already successful job stays successful. A provider ignoring abort can continue
remotely; its durable uncertainty slot remains pinned. `close()` closes admission,
aborts local waits and waits for local bookkeeping, not remote proof of shutdown.
The caller closes the store only after `await worker.close()`.

## Storage and Activation Gates

The host supplies an existing canonical owner-only 0700 root. Database mode is
0600, same UID/GID, one link; symlinks, wrong modes, replacement and future/schema
or integrity corruption fail closed. Live named/retained file identity is checked
at every transaction. Integrity hashes detect corruption; they are **not MACs**.
No prompt, key, provider response or raw source text is persisted; metadata,
request hashes and verified pixels are local worker state.

This uses SQLite's named-path VFS, not an openat/retained-directory VFS. Hostile
same-UID mutation, filesystem rollback, root access and network filesystems are
outside the guarantee. Use a dedicated UID, local filesystem and private parent
directory. Deleting/restoring an old database can defeat at-most-once history;
never use rollback of job state as deployment rollback. Corrupt/poisoned stores
must stop admission and require operator recovery. No systemd/fail-stop process
wrapper or migration tool is supplied in this slice.

Before activation: independent review, app-scoped credential provisioning,
dedicated host/process and egress policy, server body/concurrency/time bounds,
backups/retention/recovery adjudication, paid provider/PNG-format qualification,
and app consent/quota/cancel acceptance. None is inferred from a credential or
from passing fake-transport tests. Public capability and create remain disabled.

## Offline Gates

Run `npm run smoke:illustration-worker` and `npm run check`. The smoke uses only
temporary local roots, SQLite, synthetic PNGs, fake fetch and short child
processes. It exercises cross-process claims; before/after-submit and post-result
crashes; identity isolation; cancel/late result; canonical PNG filters, CRC and
bounds; fixed payload/no retry; corrupt stores; capacity; auth/header/path/body
rejection; and disabled capability. It makes no network/model/container calls.
