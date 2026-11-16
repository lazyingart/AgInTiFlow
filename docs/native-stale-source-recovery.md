# Recovering from a changed workspace snapshot

Native text patches keep their supplied `baseHash` check. If the workspace
changes after a read, a mismatched hash or publication conflict refuses the
patch with `WORKSPACE_WRITE_CONFLICT`. The runtime then offers a bounded read
of that exact file before another mutation. It does not retry the rejected
snapshot, remove its hash, enable whole-file overwrite, or bypass file policy.

The fresh read supplies the existing revision-bound patch anchor. Preserve
concurrent content outside the requested change and use that current anchor
for the next edit. A repeated external change can require another refresh;
the ordinary step budget remains a bound on recovery. Do not interpret a
conflict as completed work or ask for broader file permission to bypass it.

The pending refresh survives a same-task session continuation and an explicit
provider/model change. Cross-revision evidence requires an exact task digest
and a complete, ordered same-task history. Native initial entries now carry
`taskHash` explicitly. An older initial entry's `hash` is accepted only when it
matches that exact task identity and every intervening continuation carries
the same nonempty digest without refreshing the execution contract. Missing,
conflicting, branched, duplicate, gapped or future lineage is not continuity.
A present malformed `taskHash` is rejected; it is not a legacy absence.

This is cooperative recovery in the native file-tool workflow. It is not a
kernel compare-and-swap, multi-file transaction, application-account isolation,
retained-descriptor storage proof, or protection against arbitrary same-UID
mutation. Already admitted operating-system changes still need truthful native
receipts; file scopes, secret guards and dispatch restrictions remain in force.
