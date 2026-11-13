# Clarify first, then disclose the selected record

The restricted SDK already supports a small tool catalog per invocation. Use
that boundary when an application must identify a target before reading its
contents. A discovery runner can list authorized candidate IDs and titles;
after an authenticated user selection, a fresh runner can read only that
selected record. More tools are not always more useful.

Keep the responsibilities explicit:

1. The host authenticates the principal and records the exact ordered candidates
   it displayed, bound to that conversation. A model response cannot grant scope.
2. The user selects a candidate. The host validates that selection against the
   saved displayed list, rather than a new relevance ordering. If a free-form
   reference cannot be resolved reliably, ask again or offer explicit selection.
3. Construct a fresh runner with a selected-ID enum and a read handler closed
   over that principal and ID. Do not mutate another in-flight runner's catalog.
4. Supply only that conversation's authorized history. Read the current selected
   record; a historical revision is not fresh evidence.
5. Validate the proposal's target, expected revision and requested field changes
   in the host transaction. Persist the mutation and idempotency receipt together.
   On response-loss replay, return the receipt without running the model or
   applying the mutation again. A reused key with different content conflicts.

For example, the selected-record tool can be constructed by host code:

```js
// principal and selectedId come from host authentication/selection authority,
// not model-supplied owner arguments or an unverified candidate proposal.
const readSelected = {
  name: "read_selected_record",
  description: "Read the current user-selected record.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", enum: [selectedId], maxLength: 128 } },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: currentRecordSchema,
  async execute({ id }) {
    if (id !== selectedId) throw new Error("Selection unavailable");
    return authorizedRead(principal, selectedId);
  },
};
```

`authorizedRead`, the selection authority and the transaction are app-owned
functions, not new SDK exports. `readOnly: true` does not sandbox JavaScript.
Provider choice remains explicit; switching from Flash to Pro in the example
is host-authorized continuation, never an automatic fallback. Drain cancelled
work before starting a replacement. The SDK does not persist sessions, resolve
all natural-language references or prove that a proposal has been saved.

## Qualification

On 2026-11-13, the pinned nine-file Lite preview15 distribution passed a real
Flash/English discovery and fresh-process Pro/Chinese follow-up. The user asked
to change an intro without identifying which of two drafts, then selected the
second displayed draft and supplied an exact replacement. Between phases the
host changed that draft's body and revision, and a fresh candidate list would
reverse the original order.

With both list and detail tools exposed from the start, Flash correctly asked
for clarification but also read both full drafts. Pro subsequently selected the
original second draft despite reordered results and used its new revision. That
two-phase trial used six provider requests and five reads. A separate discovery
observation also read both drafts before returning the right question.

With staged catalogs and the same user prompts and host instructions, the
two-phase trial used four provider requests and two reads. It returned the exact
Chinese replacement, and the synthetic host preserved the concurrent body edit,
Japanese text, other record and record count when applying the proposal once.
Observed total phase times were approximately 8.15 seconds and 5.42 seconds;
these are individual observations, not a statistical latency benchmark.

There were 13 actual hosted requests across all observations, no automatic
retry/fallback, no LocalLLM generation and no real application data or service
changes. This qualifies a bounded example, not universal model accuracy or a
production authentication/transaction implementation. No runtime fix or new npm
release was required; the published engine remains `0.20.395-integration.0`.
The source branch adds the qualification fixture; that already published archive
is unchanged. Future packaging includes the fixture and its consumer checks.

`node --test test/restricted-selection-profile.test.js` adds seven offline
regressions, also included in `npm run smoke:restricted-application`: staged
catalogs, three-process continuation/replay, reordered display binding, foreign
or undisclosed reads, schema-valid guessed edits, stale or unobserved proposals,
protected fields and receipt conflict. Its providers are scripted. The fixture
store is a single-writer test host with atomic file replacement, not a public
storage export, a concurrent lock protocol or retained-descriptor authority.
Receipt replay simulates a lost caller response after commit; it is not a live
HTTP disconnect, concurrent database or arbitrary crash-boundary qualification.
