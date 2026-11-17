# Command observation and verification freshness

Git status is a partial observer. It can identify status and fingerprint changes
for visible Git paths, but omits ignored files and transient or external effects.
Declared-output checks cover only those declared paths. Neither observer proves
that the entire workspace stayed unchanged.

Native command results report `mutationObservationScope` as `git-status`,
`declared-outputs`, `git-status-and-declared-outputs`, `unavailable`, or
`not-requested`. Native partial observations set `mutationObservationComplete`
to `false`. Positive path evidence remains available in the existing fields.
When a successful command can mutate the project, missing path deltas do not
suppress conservative verification invalidation.

`projectMutationRevision` is a verification-invalidation counter. An advance
does not prove that a file was written. A failed or interrupted command can also
leave changes behind: a durable `commandSequence` and
`latestPotentialCommandMutationSequence` fence older passing verification
without inventing source-edit progress. Fresh native verification can restore
freshness. The command's own observed nonzero outcome remains a failure; it
never becomes a passing test. Blocked and skipped commands do not advance this
sequence. Sequence ordering survives restart and equal wall-clock timestamps.

Results also carry closed `commandMutationEvidence` metadata:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `scope` | Observer scope, or `legacy-unspecified` for unqualified older data |
| `coverage` | `partial`, `unavailable`, `not-requested`, or legacy `unknown` |
| `revisionMeaning` | `verification-invalidation-only` |
| `revisionAdvanced` | Whether this command advanced the counter; legacy unknown is `null` |
| `revisionBasis` | Observed path delta, conservative command capability, unobserved mutation risk, no advance, or legacy unknown |
| `observedPathCount` | Bounded count of observed path deltas; legacy unknown is `null` |
| `workspaceUnchanged` | Always `not-proven` |

This metadata describes coverage; it grants no filesystem permission, sandbox
authority, whole-workspace snapshot, or proof of a file write. Model-facing
results, retained history and bounded native command checkpoints preserve that
distinction. Current tool context explains it even when older history contains
an unqualified complete-observation flag. Passing test evidence uses the same
sequence freshness rule in runtime completion and SCS replay; historical command
outcomes remain observations, distinct from current verification.

A bounded question explicitly based on saved or recorded results can be answered
from that history without collecting fresh evidence. This includes asking what
the output verifies and what it does not establish about file changes. Such an
answer must keep past observations distinct from current state; missing history
means the answer is unknown. The classification creates no evidence and grants
no tool permission. Mixed requests for new tests, reads, research or artifacts
retain the ordinary execution and evidence contract. Unknown phrasing falls
back to those ordinary gates.

Older native checkpoint digests remain readable. If an older passing check is
followed by a mutation-capable command without qualified ordering/coverage, a
generic continuation pauses with `verification_observation_review_required`
before any provider or tool call. Missing ordering history also requires review.
The runtime retains old receipts and adds only an invalidation fence; it does
not assign execution identities to historical commands or replay them. Repeated
generic continuations stay blocked. An explicit verification request may
authorize a fresh check. Verification recorded after the older command retains
its delivery-only behavior when its other evidence is valid.

Corrupt, null, overflowing or inconsistent sequence state fails closed before
provider and tool admission. The observer is still partial: this is not OS-level
read-only enforcement, same-user isolation, exhaustive test quality, universal
model factual accuracy, or qualification of a production application adapter.
