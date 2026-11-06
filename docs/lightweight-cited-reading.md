# Lightweight cited-reading qualification

AgInTiLite preview 8 completed a bounded reading workflow with actual DeepSeek
Flash and Pro on 2026-11-06. The test used a synthetic three-passage story, not
private application data or a real published book. It qualifies this example
and transport profile; it does not establish every application's readiness.

The standalone SDK source is `72a94cf8570ee22469f3e2def6cdb6fe311f05c9`, available
as the independent `sdk/agintilite-root-proposal-20261105` Git branch. This tree
is not a Flow/main merge. Its private seven-file, zero-dependency package is
`0.1.0-preview.8`; archive SHA-256:
`b62c9b1a76c09d6664f465c0983e48c7ed259b5091e028bc46280bff1e19ffe2`.
No package publication or application upgrade is implied.

## Normal requests and observed results

The initial request asked for a short timeline of where two characters went,
their relationship, and passage citations, while distinguishing plans from
events that actually happened. A caller-bound `read_passage` tool exposed only
three approved passage IDs. It accepted no account, book, path or network selector.

The host then corrected a passage, incremented its source revision, retained the
original user request and JSON response, and started a new OS process using Pro.
The Chinese follow-up asked to reread the changed passage and return only the
corrected timeline, without repeating the relationship or adding a map.

| Phase | Explicit model | Provider requests | Authorized reads | Observed result |
| --- | --- | ---: | ---: | --- |
| Initial | `deepseek-flash` | 2 | 3 | Three dated events and one cited sibling relationship |
| Fresh-process follow-up | `deepseek-v4-pro` | 2 | 3 | Corrected date and revision; timeline only |
| Host response replay | None | 0 | 0 | Exact previously committed proposal; no redispatch |

The planned journey was excluded from occurred events in both responses. Every
event and relationship had an exact supporting sentence and current passage
revision. The host checked these bindings before committing either view.
Foreign-account source text never appeared in provider requests, and its rows
were unchanged. The only source edit was the host's explicit correction.

The complete live process took 6.636 seconds for this small example, excluding
setup and offline tests. The 12.7-second actual terminal replay preserves that
timing and adds a readability hold. This is not a latency benchmark.

## Ownership and integration boundary

The example used `createRestrictedApplicationRunner` and
`createRestrictedDeepSeekProvider` from the installed Lite tarball. The host
supplied the authenticated, bounded HTTPS transport with manual redirects,
no retries, an explicit model and a shared deadline. Lite orchestrated the native
read loop and validated the proposal schema. It supplied no ambient tools,
filesystem access, provider fallback or session database.

The fixture host owned SQLite history, source revisions, citation checks, view
CAS and exact response replay. Those operations are not new SDK capabilities
or proof of production authentication/database isolation. In particular, replay
after a known committed host receipt does not prove recovery from an ambiguous
provider result before that commit. The application must implement its own
idempotency, semantic validation, authorization and quota policy.

## Verification and limits

All 64 existing Lite tests and syntax checks passed. The offline package install
matched the seven committed files. Four negative semantic controls rejected
invented dates, wrong revisions, fabricated quotations and false relationships
in the host validator. A mixed tool batch containing a foreign scope selector
was rejected by the SDK before either callback. The first fixture assertion
incorrectly compared ordinary object prototypes with the SDK's deliberate
null-prototype JSON snapshots; it was corrected before inference.

All four recorded live requests/responses/results were replayed against the
globally installed Flow `0.20.362-integration.0` restricted SDK with exact wire
and result equality. This replay used no additional model requests. It is not
an independent live Flow run or qualification of another host transport.

No runtime change was required, so no new npm version was published. The latest
Flow runtime retains its separately verified full-suite/package qualification.
Application vendors, services, credentials, GPU models and tunnels were unchanged.
Workstation LocalLLM functional readiness remained `not_configured`; the known
Mac endpoint was unavailable. Neither constitutes an admitted inference role.
LocalLLM and app-safe Codex qualification remain separate requirements.
