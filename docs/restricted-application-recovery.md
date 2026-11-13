# Restricted proposals across edits and restarts

The restricted SDK generates proposals. An application must authenticate the
caller, bind its read callbacks, retain authorized history and commit with its
own revision checks and idempotency transaction. `status: "completed"` confirms
proposal generation; it never authorizes a stale overwrite or proves a save.

A typical correction flow is:

1. Read current account-owned data through the supplied read-only tool.
2. Return a proposal bound to the observed record ID/revision.
3. In the host transaction, compare that revision with current state.
4. Reject a stale proposal without changing the record or displaying its reply
   as a successful save. Preserve the newer edit.
5. On a separately authorized continuation, supply the prior conversation and
   conflict result to a fresh runner. Read current data again.
6. Commit the accepted new proposal once, with a scope-bound request digest and
   durable receipt. Response-loss replay returns that receipt without applying
   another mutation. A reused key with different content must conflict.

The application owns these steps outside the read-only SDK. Do not implement a
write inside a tool marked `readOnly`, infer consent from model text, retry a
stale proposal unchanged or silently switch provider after a failure.
Model/provider choices stay explicit. This is a stateless application SDK,
not the CLI's native SessionStore or the full native integration runtime.

## Qualification

On 2026-11-05, the registry-installed `0.20.344-integration.1` passed a live
Chinese correction workflow against synthetic host-owned records:

- Flash read revision 7 and proposed the requested weekday change. A separate
  fixture-owned edit advanced the record to 8 before apply. The stale proposal
  was rejected without a record write.
- A new Pro runner received explicit authorized history/conflict feedback, read
  revision 8 and retained the newly added pending remark. The host applied
  revision 9 once; duplicate apply replay left bytes unchanged.
- After that Node process exited, a separate process loaded serialized host
  history/state. Pro read revision 9 and handled a normal follow-up correction,
  preserving the person, original remarks and concurrent pending remark. The
  host applied revision 10 and retained the previous receipt.

Each phase used two real transport requests and one authorized read: six
requests and three reads total. The alternate account had the same record ID
and stayed unchanged. No automatic retries/fallbacks or LocalLLM invocation
occurred. Credentials were absent from persisted fixture evidence. No app
source, records, configuration or service was touched.

The host was a synthetic file-backed fixture, not a production database,
authenticated application deployment, retained-descriptor store or cross-process
transaction-lock qualification. The concurrent edit was deliberately injected
before apply. Only the third phase crossed a real OS-process boundary; the
second used a fresh SDK runner in the original process. These results do not
establish universal model accuracy, latency, instruction fidelity or app readiness.

`npm run smoke:restricted-application-recovery` adds three deterministic offline
regressions for stale rejection, latest-read continuation, receipt replay and
conflict, account preservation, and a separate-process history reload. Its
providers are scripted and perform no network/model requests; the fixture
transaction is test code, never a production persistence export. A negative
control deliberately returns a schema-valid stale proposal to ensure the host
still rejects it despite SDK `completed` status.

## Removed sources and unchanged edits

Historical text does not grant permission to restore or edit a removed record.
Read the currently selected account-owned record before proposing a follow-up.
When the host has authoritative removal evidence, its read schema can return a
closed `removed` variant containing the selected ID and current revision but no
content. The proposal schema should then permit `unavailable` without a draft.
Keep principal/selection binding in the callback closure, not model arguments.

The host must still compare the proposal with the exact authenticated read and
current state in its own transaction. Reject stale revisions and recreation at
a removed ID. A generic 404, timeout or authentication error is not removal
authority; the SDK reports a tool failure rather than inventing a tombstone or
silently retrying with another provider. Render lifecycle facts from host-owned
status/localization rather than free-form model text. Do not pass revoked data
in history when policy forbids even historical access: a prompt is not deletion
or data-loss-prevention enforcement.

Likewise, a schema-valid proposal identical to the current text is not evidence
that a rewrite happened. The host can classify it as `no_change`, avoid a write
or revision increment, and show that result honestly. Do not mistake SDK
`completed` for editorial quality, an application commit, or a successful edit.

A 2026-11-14 synthetic qualification used immutable Lite preview18 with explicit
Flash, then a fresh Pro process with host-retained history. After the host
removed the selected source at revision5, Pro reread it once and returned
`unavailable` in Chinese without reconstructing a draft. Two actual HTTP
requests per phase, no automatic retry/fallback or application mutation.
Flash's initial two-request proposal repeated the original wording and
incorrectly called three sentences a single sentence; that editorial shortfall
is retained, not counted as a successful rewrite. No runtime change is inferred
from this example, and it is not production account/storage qualification.

`npm run test:restricted-source-revocation` checks this host contract using
scripted providers: current/removed reads, stale and recreated proposals,
scope/revision changes, no-change edits, safe presentation, typed versus generic
failures and cancellation. The in-memory host comparator is test code, not a
new authentication, persistence, transaction or deletion API.
