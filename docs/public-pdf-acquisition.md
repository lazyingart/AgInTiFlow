# Public paper acquisition

## Operator binding and retention checkpoint — September 11

The production analysis-server composition now constructs the branded paper
client from optional `paperAcquisition` configuration, using the same private
file worker as generated files. Enabled configuration requires native-v3 state,
enabled document access, explicit reviewed public HTTPS origins, a maximum of
16MiB and a bounded download deadline. Absent/disabled configuration preserves
ordinary chat. A missing optional document credential leaves acquisition
unavailable; it is not an implicit fallback to another service or credential.
The shared downloader validator performs no network activity at configuration.

Acquired-paper bytes expire 30 days after the worker's durable creation time.
Caller-provided source timestamps cannot extend retention. Cleanup runs at
startup, on relevant operations/content access and hourly in the existing
document HTTP process. The timer is non-overlapping and cleared at shutdown.
Expiry closes an existing source read, unlinks only its owned object, then
records content as gone. Receipts, owner scope and source metadata remain;
content/re-import returns410, and subsequent owner/account deletion still works.
An interruption between unlink and ledger persistence recovers on reopening.
Generated Markdown and other generated-file groups are outside this policy.

Offline validation passes for downloader, paper store/transfer/HTTP, recovery
and selection suites. The real fixed-port document HTTP server, service,
file store and analysis API smokes pass inside a network-isolated disposable
container, without occupying the live shared listener. New retention cases
cover the exact boundary, unchanged Markdown, active reads, interrupted cleanup,
restart, owner isolation, anti-resurrection and later two-phase deletion.
The configuration checks cover explicit disable/missing credentials, valid
production binding and malformed/unsafe configurations. Syntax:300 files.
Package dry-run:459 files; required runtime modules present, private state absent.

This is source qualification, not activation or npm publication. The shared
LocalLLM document deployment and private LazyEdge document role still need the
compatible worker package, opt-in paper routes/token scope and binary body
bound. Preserve its existing consumers and ledger. EchoMind also applies
30-day retention to newly imported Agent PDF outputs in its existing lifecycle;
durable Markdown and conversation metadata remain. PDF delivery does not claim
reading, main-text conversion, translation or permission to republish.

## Earlier checkpoints

Status: credential-free acquisition, durable storage, authenticated binary
transport, conversation artifact lifecycle, durable acquisition metadata and
opt-in planner routing and bounded process recovery are implemented and tested
in source. They are not yet an enabled EchoMind download feature: operator/server
configuration, the guarded role route and source-PDF retention still need integration.
The live analysis, execution and shared document services remain unchanged.

## Process recovery checkpoint — September 11

The planner persists its selected source, current source evidence, completed
research report and remaining-output flag before acquisition. The private
session checkpoint contains no PDF bytes or bearer token. Recovery uses the
same account, browser, thread, run, selection and issuance. It replays import
and commit through the actual worker and skips search/model selection. Source
identity and content conflicts still fail instead of silently selecting another
paper. The original start time is retained; progress distinguishes recovery
attempts from the interrupted attempt.

At most two automatic process restarts are admitted. They use the existing
two-executor, 16-queued-run limits and four-per-scope queue limit. Overflow stays
durable and is admitted when a slot becomes available. Queued cancellation is
honored. Startup reports queued/deferred work separately from recovered terminal
work and dispatches no new planner until the bounded pre-listen audit succeeds.
HTTP/provider failures are not an automatic retry loop. The existing private
state lock's dead-owner and age checks remain unchanged.

Once follow-on work begins, an interruption is reported as incomplete rather
than replaying potentially side-effecting work. A committed paper alone cannot
complete a compound request. A final success checkpoint is saved only after
the runner callback/result agree, execution succeeds, requested document output
is verified and all file receipts are acknowledged. Recovery preserves this
validated final text rather than substituting a generic file-success message.

Eleven new tests cover real child-process loss before download, after issuance,
import, commit and final callback; continuation failure; callback disagreement;
the durable restart budget; schema bounds; 20-owner queue overflow/cancellation;
and failed pre-listen dispatch. Only the dead fixture lock's age is accelerated;
run and worker state remain unchanged. The four added actual-planner replay
scenarios cover English, Japanese, prior sources and paper-plus-notes without
another source-selection call. Combined lifecycle tests: 121; actual planner/
session/HTTP scenarios: 16. Existing planner, session/context/startup/authority,
migration/prewrite/API, file-client/broker, 300-file syntax and mock web/coding
checks pass. Package dry-run: 459 files, required files present, private state
and credentials absent. No npm release or live deployment is claimed.

## Planner routing checkpoint — September 11

Both planner factories accept one optional, branded `paperAcquisitionClient`
bound to the exact same `fileWorkerClient`. Startup probes its paper-creation
state separately; a disabled paper worker leaves ordinary chat operational.
The deployed server does not construct this client yet. No new environment
credential, service, public route or permission is introduced by this option.

The planner uses one bounded JSON selection step over current/immediately prior
recorded search rows. It distinguishes retrieving an original paper from
generating a new document, and treats source metadata/history as untrusted data.
The response can select only an eligible recorded artifact/index, never supply
a URL or PDF bytes. Invalid/unfinished responses and unavailable selections
stop before acquisition. The step has no tools, a 512-token output ceiling and
a 15-second model deadline; ordinary chats without source or file context skip
it. The session still independently resolves the selected row in its own scope.

One source PDF counts against the existing four-operation budget. Acquisition
uses the durable callbacks before DNS/issue/import, then captures, authorizes
and commits the real worker artifacts. The planner can continue a separate
generated-file request or Python task; original-paper bytes never enter a
generation tool. Completed deep-research reports remain intact, including when
the decision is simply no download. Retrieval does not imply reading the PDF,
conversion, permission to republish or scientific correctness.

Final file acknowledgements now group by receipt rather than assuming every
file in a run is one bundle. Each group must match its complete commit intent
and real worker acknowledgement. This permits a source PDF and separate
generated files without mixing their provenance. The durable session exposes
distinct Paper download progress, and selection/download errors retain their
actual category instead of looking like a model outage.

Verification: 14 selection-contract cases and 12 actual planner/session/HTTP
scenarios cover ordinary chat, disabled-paper chat, current/prior selection,
English/Japanese input preservation, separate generated files, subsequent
Python, no-download decisions, wrong indices, unavailable sources, disabled
creation and invalid PDF bytes. The complete existing deep-research regression
is also run with paper acquisition configured. Model decisions are deterministic
fixtures using the explicit DeepSeek payload binding; this is not a live-model
selection-quality evaluation. All 110 combined store/frame/HTTP/session/
acquisition/selection/cancellation cases pass, including the real 60-second
upload deadline. Existing planner, file-client, document broker, session,
startup/prewrite/API, 99 downloader/synthesis, syntax and mock web/coding checks
also pass. Isolated test data/listeners are cleaned by their fixtures.

Activation still requires the operator/server binding, guarded gateway,
account adapter and 30-day source-PDF
retention together. Do not advertise the source checkpoint as a live download,
PDF converter or npm release. Preserve compatible rollback before writing new
paper state to shared production ledgers.

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

### Conversation lifecycle and cancellation checkpoint — September 11

The analysis session broker now explicitly recognizes `acquired-paper-v1`
alongside generated file bundles. One shared profile predicate selects file
commit recovery, prior-turn context, authenticated content and two-phase
deletion. The compiled TeX/source-pair path retains its existing behavior.
Paper content carries the explicit PDF-only 16 MiB client profile; generated
files keep their smaller limits, and a paper receipt remains a single-file
operation.

The private persisted artifact carries the complete immutable paper receipt,
including source identity, DOI/version and acquisition time. Validation binds
its receipt digest, all scope digests and artifact bytes/hash/ref to the stored
record and commit intent. Public file descriptors and follow-up model context
do not expose the private receipt, source transport metadata or worker refs.
Neither the PDF body nor the import authority token is stored in conversation
JSON. A receipt is source provenance, not proof that the paper was parsed or
that publication rights were granted.

The new cancellation tests found a pre-existing shared file-store defect:
deletion accepted a staged bundle, but its ledger validator only accepted
committed artifacts during deletion, and cleanup targeted only committed-byte
storage. Cancellation before commit therefore failed instead of removing the
stage. The lifecycle now preserves whether a file was ever committed, validates
that origin during deletion, removes bytes from the corresponding private
directory and recovers both before and after unlink. Expired uncommitted files
retain a null commit timestamp. This applies to generated bundles as well as
papers; cancellation never publishes a file merely to delete it.

All 72 store/frame/HTTP/session/cancellation tests pass together. The 11 new
session cases cover a real 16 MiB HTTP import into durable conversation state,
restart/content/ranges, account and browser-session denial, private provenance,
prior-turn descriptors, commit recovery, cancellation through outage/restart,
wrong-owner capture and persisted-record tampering. Eight new lifecycle cases
cover paper and two-file generated-bundle cancellation across prepare, pre-unlink
and post-unlink crashes, plus expiry. The original real 60-second upload-deadline
test passed again. Tests use isolated local stores and deterministic runners,
not live models, selected internet papers or the production gateway.

Existing file client, compiled-document broker, analysis sessions, context
compaction, startup recovery, session authority, state migration/prewrite and
analysis API smokes pass. The 296-file syntax check and mock web API/coding-tool
checks pass. The 448-file package dry-run includes the shared HTTP fixture and
new tests, without private state or credentials. No archive/install, registry
publication or live service/config change occurred.

Compatibility: older readers reject paper session records and the truthful
null-timestamp uncommitted deletion/expiry states. Qualify a compatible rollback
for both the session and worker ledgers before deploying this checkpoint;
preserve all existing state. Production paper creation remains disabled.

### Source-bound acquisition checkpoint — September 11

`integration-paper-acquisition.js` joins the branded credential-free downloader
to the existing authenticated file client. Its only selection argument is a
recorded source-artifact ID and row index. The real analysis session broker
resolves that row within the account, browser session and conversation, from
the current search or its immediately preceding completed result. Current-run
raw search IDs are resolved to the canonical owned artifact ID. Other users,
threads, old hidden context, invented rows and extra URL arguments are rejected.

The broker persists `paperAcquisitionIntent` before DNS/download, including
the selected row digest, source identity, DOI/version and fixed PDF candidate.
After acquisition it persists exact file/source metadata and one issuance ID
before contacting the issue route. It records the issued request identity,
operation digest and token hash before binary import. Raw tokens and PDF bytes
remain outside conversation JSON and public descriptors. The coordinator wipes
its acquired byte buffer on success or failure and checks the creation switch
before downloading. Its trusted downloader must fit the existing 16 MiB bound.

A retry with identical bytes reuses the original acquisition timestamp,
issuance and import request. Changed file hashes, redirect destinations,
DOI/version, owner scope or authority epochs are not silently rebound. The
outer scheduler decides retries; this client makes one acquisition attempt.
Actual HTTP tests simulate responses lost after successful issuance/import
and verify exactly one stored group, then committed content and normal deletion.

The narrow source adapter accepts recorded direct HTTPS PDF paths and arXiv
abstract/PDF citations. It preserves explicit versions and legacy identifier
case. An unversioned citation remains unversioned (latest at acquisition), with
exact bytes fixed by hash; no version is invented. See the official
[arXiv identifier definition](https://info.arxiv.org/help/arxiv_identifier.html).
The operator's origin allowlist and downloader DNS/TLS checks still determine
network access. No page scraping, alternate-source probing or rights claim is
added by converting a recorded citation into a candidate PDF path.

Paper artifact capture/readback now requires its matching persisted operation
and selected source. Completion/recovery/cancellation races share a check that
the selected paper was actually committed: an unrelated generated file or a
textual claim cannot satisfy paper delivery. Existing generated files and TeX
pairs retain their own contracts. The source-only pre-selection paper fixtures
were updated to exercise this authority rather than introducing a test bypass.

All 96 combined store/frame/HTTP/acquisition/session/cancellation cases pass,
including 21 coordinator/source cases and three additional intent-tampering
cases. Existing file client, compiled-document broker, session/context/startup,
authority/migration/prewrite/API, grounded search and planner checks pass,
alongside the 99 acquisition/synthesis cases, 298-file syntax, mock web API and
coding tools. The 60-second real deadline was exercised again. Tests use
synthetic offline source responses and actual private HTTP handlers, not a live
paper/model request or production account record.
The 452-file npm dry-run includes the coordinator/contract and their fixtures,
with no private state/keys or generated archive. Repository profile checks still
report pre-existing README/citation/translation differences; those unrelated
branding files were preserved. This is a source-branch checkpoint, not a registry
release or an update to the public default branch.

Durability here means persisted selection/issuance, explicit same-run replay,
and the existing post-capture commit recovery. Pre-import process termination
still follows the existing interrupted-run policy; automatic durable job
rescheduling and planner tool selection are the next integration step. An
import accepted just before a lost response remains private until the same
operation is reconciled or the worker's existing staged expiry removes it.
No live service/configuration, npm registry or public app change occurred.

### Next integration steps

1. Connect planner paper-selection routing to the source-bound coordinator and
   persist/recover its scheduling phase before import. Reuse the implemented
   selection/issuance metadata and callbacks; keep original run ownership,
   DOI/version/hash and bounded retry/cancellation policy through process restart.
2. Connect the tested binary client/HTTP operation through the guarded role
   route and existing EchoMind account artifact adapter. The session broker's
   paper profile, committed content and deletion dispatch are now implemented;
   connect the implemented pre-acquisition/issuance intent and job scheduler to
   that lifecycle. Reuse idempotency,
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
