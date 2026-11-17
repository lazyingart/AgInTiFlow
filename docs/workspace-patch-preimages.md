# Workspace patch deletion preimages

Multi-file patches plan their operations before publishing changes. Every
deletion retains the SHA-256 of its bounded text snapshot from that plan.
Immediately before deletion, the tool reads the current target through the
existing workspace boundary and requires the same content hash. An empty file
has an exact preimage too.

A change made between planning and a later deletion is a
`WORKSPACE_WRITE_CONFLICT`. The current file stays present. If earlier patch
operations have already published, the result remains a partial failure with
their confirmed receipts; it does not claim that the deletion succeeded or
attempt subsequent operations. A conflict before any publication throws without
claiming partial effects.

Read the current target before proposing a new patch. Do not replay already
published operations or roll back unrelated edits. A new explicitly requested
patch may plan against the current content. Unrelated file changes do not
invalidate an unchanged deletion target.

Native state and events retain the actual partial result. A fresh provider
continuation can inspect that result and the current files without repeating
the earlier mutation. A new read-only request keeps the conversation evidence
but receives its own goal-scoped mutation counter.

This is a cooperative stale-preimage guard. Node pathname unlink is not an
atomic compare-and-delete or retained-descriptor filesystem boundary. It does
not promise protection from an adversarial same-UID writer replacing a path
after the final observation. Application authentication and filesystem isolation
remain separate requirements.
