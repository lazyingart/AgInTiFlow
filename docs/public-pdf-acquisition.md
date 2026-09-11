# Public paper acquisition

Status: credential-free acquisition and durable binary storage primitives are
implemented and tested. They are not yet an enabled integration tool or an
EchoMind download feature; the authenticated transport still needs integration.
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

### Next integration steps

1. Bind an acquired paper to the selected source identity and user intent in
   the durable analysis job, then use the separate paper issue/import operation.
   Preserve DOI/version/source metadata across recovery.
2. Connect the new store operation to an authenticated, bounded binary transport
   and the committed account artifact broker. Reuse idempotency, immutable
   receipts, ownership, cancellation and verified cleanup. Keep network URLs
   out of public artifact content requests. The storage worker keeps loopback-only
   networking; acquisition stays in the existing network-capable agent role.
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
