# Native command recovery

Native sessions save command intent before `run_command` starts an executor.
Once the executor returns, the runner saves a separate bounded, redacted result
receipt before closing the model's tool-call frame. These records use the
existing atomic, fsynced SessionStore state and native session lock.

On restart, an exact saved receipt restores its unanswered tool frame without
executing the command again. It binds the session, workspace, original task and
goal/runtime revisions, call arguments, command verification record, and result.
An ID reused by a provider in an earlier closed frame does not identify the
current operation. Ambiguous unanswered frames are rejected.

If intent exists without a confirmed result, the run pauses with
`NATIVE_COMMAND_OUTCOME_UNKNOWN` and `requiresReconciliation: true` before any
provider request or new command. The command might have run, including partially.
Ordinary continuation and a provider change cannot resolve that uncertainty.
Preserve the session and independently inspect the affected system; do not erase
the journal or blindly repeat the command. This release provides no automatic
reconciliation or reset that authorizes another execution.

Legacy enrollment inspects available session events and exact native result
checkpoints. A generic historical `tool.failed` exception cannot establish an
exit outcome. An unmatched attempt becomes a persisted hold. Corrupt available
event history is rejected rather than silently enrolled as an empty history.
Legacy event history is not itself a new durability guarantee.

An explicit workspace change may rebind an empty journal or atomically restore
a confirmed result and rebind it. It cannot move an unresolved attempt to a new
workspace. Old-workspace verification still does not prove that the new
workspace passes its checks.

## Limits

- The recovered result is a bounded, redacted snapshot, not a complete stdout or
  stderr transcript. Missing presentation text does not justify repeating a
  once-only command.
- These are integrity digests, not keyed authentication. Same-UID state forgery
  and storage replacement are outside this mechanism's authority.
- This is not transactional or exactly-once execution of external effects. A
  process can die after an effect and before any result can be saved. That case
  remains uncertain and blocked.
- Controlled POSIX native cancellation retires intent only after the existing
  owned-process teardown contract settles. It does not undo partial effects or
  manufacture an exit result. Unproven Docker/Windows cancellation remains
  conservative.
- Other tools, detached jobs and remote application operations retain their own
  authority and recovery contracts. This journal does not grant app isolation,
  shell permission, a provider fallback, or a production integration capability.

`npm run test:native-command-recovery` exercises contract tampering, real
disposable child-process crashes, storage/publication failures, restart,
legacy enrollment and workspace rebinding without external model requests.
