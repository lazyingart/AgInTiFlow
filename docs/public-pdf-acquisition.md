# Public paper acquisition

Status: credential-free acquisition, durable storage and the authenticated
binary client/HTTP transport are implemented and tested in source. They are not
yet an enabled EchoMind download feature: durable analysis-job/profile binding,
the guarded role route and source-PDF retention still need integration.
The live analysis, execution and shared document services remain unchanged.

## Ownership and boundaries

Paper discovery, selection, acquisition, conversion and publication are separate
stages. The analysis model selects a real paper from authorized source records;
it does not generate PDF bytes or decide network/service permissions. The
application retains account ownership, explicit user intent, quotas, durable
job identities and the paper/library retention policy. Publication is a separate
explicit action with its own source-rights checks.

`src/public-pdf-download.js` is the acquisition-only primitive. It receives an
exact PDF URL and a trusted, explicitly configured set of HTTPS origins. That
configuration is not a model tool argument. It accepts no credentials, request
headers, cookies, environment-derived proxy or filesystem path. It neither
executes/parses a PDF nor writes it to public storage. The returned bounded bytes,
original/final URL, SHA-256 and acquisition time are inputs to the existing
owner-scoped artifact lifecycle, not proof of semantic content or reuse rights.

Each redirect remains on reviewed origins and gets a fresh public-address check.
The actual TLS connection is pinned to a checked DNS address and retains the
hostname's certificate validation. Mixed public/private DNS answers, IP-literal
URLs, private/reserved/translated addresses, unreviewed redirects, credentials,
HTTP downgrade, unexpected peers, compressed responses and incomplete bodies
are refused. No alternate download source, credential or repeated HTTP attempt
is inferred from an error. HTTP401/403/429 are terminal for this call; the outer
queue owns any reviewed retry/backoff policy.

One client permits one active acquisition, spaces request starts by at least
three seconds, bounds redirects to five, and includes DNS, pacing, TLS and body
streaming in a maximum90-second total deadline (default60). Cancellation closes
the request and makes the slot reusable. The20MiB ceiling is an acquisition
bound, not a change to existing file-worker publication limits. MIME, the PDF
header/EOF envelope, declared/actual length and SHA-256 are checked; structural
PDF parsing belongs in the isolated processor. There is no bulk crawling.

Use one production client per service, not one per user request:

```js
const downloader = createPublicPdfDownloader({
  allowedOrigins: ["https://arxiv.org"], // operator-selected source policy
});
assertPublicPdfDownloader(downloader);
const document = await downloader.download(selectedPdfUrl, { signal });
// Import document.bytes through the authenticated artifact/retention lifecycle.
```

The test-only factory permits offline DNS/transport fixtures. Production
consumers must call `assertPublicPdfDownloader` without `allowTestOnly`; a copied
object or fixture client cannot satisfy that check. The ordinary production
factory has no transport-injection option.

## Verification

```sh
node --test test/public-pdf-download.test.js
npm run smoke:integration-analysis-planner
# Explicit opt-in: one public PDF, no model or provider key, no persisted bytes.
npm run smoke:public-pdf-download:live
```

The78 offline cases cover byte/provenance fidelity, network boundaries,
redirect handling, declared/chunked limits, invalid/truncated envelopes,
timeouts before connection and during transfer, cancellation, reuse and
sanitized errors. One real request to the original BERT arXiv PDF returned
775,166 bytes in522ms with normal TLS and public-peer validation. SHA-256:
`5692a5514787a8c6727b4ff3b726a3385798bc68e12138d1d4af83947e2acf6e`.
The canary retained only its metadata; it did not parse, store, convert or publish
the paper. This demonstrates a real download, not an app-level delivery.

## Remaining complete path

### Durable storage checkpoint — September 11

`integration-acquired-paper-contract.js` adds distinct issue/import/receipt
schemas for one source PDF up to the common16MiB artifact bound. It carries
source identity, original/final HTTPS URLs, optional DOI/version, acquisition
time and exact byte/hash metadata. These are the acquisition caller's bound
claims, not independent proof of eligibility, semantic content or reuse rights.
The worker never resolves/fetches the URLs. The agent must bind them to the
actual selected source and the verified downloader result before issuing.

The existing durable file store exposes `issueAcquiredPaper(metadata)` and
`importAcquiredPaper(metadata, bytes, { signal })`. Issue metadata is persisted
before binary import. Import copies bounded bytes before queuing, rechecks hash
and the shared PDF envelope, and stages them under a distinct immutable paper
receipt. The same existing commit/content/two-phase-delete lifecycle applies.
`networkNone` on this receipt describes storage, not earlier acquisition.
No TeX compiler receipt is created. Generated-file issue/publish validation
remains512KiB/file and768KiB/bundle, including in mixed stores.

The17 new offline store tests cover775,166-byte and16MiB synthetic fixtures,
owner/session/thread/run isolation, metadata/source/authority binding, restart
replay, staged visibility, commit-crash recovery, ranges, queued/staging
cancellation, byte ownership, invalid bytes and restart-stable deletion. The
synthetic envelopes are not parsed scientific papers. Existing file-store,
file-client and document-service smokes pass, alongside99 acquisition/synthesis
tests, planner,295-file syntax, mock web API and coding tools. The fixed-port
document HTTP server smoke explicitly skipped because the existing service owns
18102; that result is not HTTP qualification for this new path.

Run `npm run smoke:integration-file-worker-store` for old and new lifecycles.
No binary-import route, gateway permission, analysis-session profile or public
tool is enabled by these store methods. No service restart or live-state write
occurred. Before activation, qualify the bounded binary transport and account
broker together. Older packages reject new paper receipts in a shared ledger:
plan a compatible rollback before the first live paper import; do not downgrade
a ledger containing these receipts to an old reader or delete it to recover.

### Binary client and HTTP checkpoint — September 11

The existing document/file worker now has an explicit optional root-owned
configuration field, `paperImport: {"enabled": true}`. Omission and false both
keep paper creation disabled. It also requires the existing creation master
switch; no model argument can enable it or change limits, origins or paths.
No live configuration or service was changed for this source checkpoint.

All routes use the existing private bearer authentication and exact POST paths:

| Route | Payload | Purpose |
| --- | --- | --- |
| `/artifact/v1/papers/readiness` | Small JSON | Versioned capability and creation state |
| `/artifact/v1/papers/issue` | Small JSON | Persist caller-owned issuance identity and content/source binding |
| `/artifact/v1/papers/import` | Bounded binary frame | Stage the exact previously issued PDF |
| `/artifact/v1/files/commit`, `/content`, `/delete` | Existing JSON | Reuse receipt-bound lifecycle and streamed content |

The binary frame has eight magic bytes `AGIPDF1\n`, a 4-byte unsigned big-endian
metadata length, canonical UTF-8 import metadata (at most 16 KiB), then exactly
the declared PDF bytes (at most 16 MiB). The distinct content type is
`application/vnd.aginti.acquired-paper`. No base64 or multipart parser is used.
The reader validates the bounded prefix/metadata before allocating the PDF,
rejects duplicate/ambiguous JSON, invalid UTF-8/BOM, compression, inconsistent
lengths and trailing/truncated bytes, and wipes partial private buffers.
Storage rechecks the SHA-256 and complete-envelope predicate before staging.

One binary import is admitted at a time, with a fixed 60-second total deadline.
An occupied slot returns 503 before consuming another large body. Disconnect,
cancellation, shutdown and the deadline abort the read and release the slot.
Existing generated-file requests retain the 1 MiB JSON transport limit and their
smaller file/bundle limits. Storage continues to have loopback-only networking.

The fixed-endpoint file-worker client adds `paperReadiness`, `issuePaper` and
`importPaper`. The durable caller supplies/persists the issuance identity and
then the issued request metadata; the client does not create a new operation
after an uncertain response. It streams owned binary chunks, validates all
scope/source/content receipt bindings, and attaches internal profile
`acquired-paper-v1` to the normal small public file artifact. Commit and deletion
use the existing client functions. Content requests must explicitly select that
PDF-only profile for the 16 MiB bound; the default remains the 512 KiB generated-file
profile. JSON responses are now stream-bounded to 128 KiB even without a length
header. No public artifact exposes source URLs, worker refs or bearer material.

Actual loopback HTTP/client tests cover 775,166-byte and 16 MiB synthetic fixtures,
creation-off/auth/account checks, staging/commit/content/range/delete, malformed
and oversized frames, cancellation/admission, lost-response reconciliation,
tampered scope receipts and response-stream bounds. The tests use the real
handler on temporary loopback sockets with isolated state and test credentials;
production `start()` retains its fixed 18102 address verification. The shared
live listener and guarded role are untouched. No scientific-paper semantics,
production gateway, app-level delivery or source-PDF retention is implied.

Verification: all 53 store/frame/HTTP/client cases pass in the combined command,
including a real 60-second deadline (60,052 ms) that verifies disconnection and
successful slot reuse. Existing file-store/client, document-service,
document-session-broker, 99 acquisition/synthesis cases and planner smokes pass,
as do 296-file syntax, mock web API and coding-tool checks.
The 445-file package dry-run includes the new protocol tests/fixture and excludes
private state/keys. No compiler/model call, live paper GET, service restart,
gateway/config mutation or npm registry publication occurred.

### Next integration steps

1. Bind an acquired paper to the selected source identity and user intent in
   the durable analysis job, then use the separate paper issue/import operation.
   Preserve DOI/version/source metadata across recovery.
2. Connect the tested binary client/HTTP operation through the guarded role
   route and committed account artifact broker. Add explicit acquired-paper
   intent/profile recovery, content dispatch and deletion dispatch. The current
   analysis service recognizes `file-bundle-v1` only, so do not let a paper
   receipt fall through to its compiled-document path. Reuse idempotency,
   immutable receipts, ownership, cancellation and verified cleanup. Keep
   network URLs out of public artifact content requests. Storage keeps
   loopback-only networking; acquisition stays in the network-capable agent role.
3. Carry realistic PDF sizes through that dedicated path. The existing generated
   file publisher has a512KiB per-file limit,768KiB bundle limit and1MiB JSON
   transport limit; the real775,166-byte paper already exceeds the per-file cap.
   Do not truncate it, expose a public bypass, silently raise every generated-file
   limit, or claim that a small sample proves general paper delivery. The common
   integration artifact descriptor also has a16MiB limit; bind the acquisition
   caller to that existing bound unless a larger end-to-end profile is separately
   qualified. Prefer bounded streamed acquisition/content, with unchanged small
   model-file input. The old standalone document-blob-store helper is not wired
   into the live service: file visibility/content requires committed worker
   receipts. Reusing that helper alone would bypass the actual lifecycle.
4. Import into EchoMind's authenticated attachment/library flow with30-day PDF
   retention, DOI/hash reuse and durable readable editions. Qualify real selected
   paper delivery, cancellation/retry, unauthorized access and exact test cleanup.
5. Promote only the independently qualified implementation. The current live
   worker package, existing owner scope and store submissions stay intact until
   then. Broader sources and sharing retain their own policy/rights checks.

References: [Node HTTPS request controls](https://nodejs.org/api/https.html),
[arXiv API](https://info.arxiv.org/help/api/basics.html),
[arXiv automated-access guidance](https://info.arxiv.org/help/robots.html),
[arXiv permissions and reuse](https://info.arxiv.org/help/license/index.html).
