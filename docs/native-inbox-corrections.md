# Corrections during native runs

A queued user instruction is applied at a safe runtime checkpoint. The runner
checks after a model response, before each tool, after each tool result, and
before successful completion. If new input is present, the old response or
remaining calls are skipped and the next model turn receives the correction.
Skipped native calls receive explicit unsuccessful replies so saved tool-call
history stays valid. They produce no tool execution evidence.

Inbox input uses the same goal-contract transition as a session continuation.
The runner preserves the existing task-boundary rules, incorporates the claimed
batch before saving, and acknowledges it only after the updated state is durable.
If the step limit is reached, the corrected task remains paused for a later
resume rather than executing a stale call. Input read from a file or returned
by a tool is not promoted into this explicit session-inbox input path.

This is checkpoint ordering, not revocation of an operation already admitted.
A correction cannot undo a file write, remote request or other effect that has
already begun. Cancellation and permission policies remain separate. Concurrent
producers may enqueue immediately after a checkpoint; those instructions are
applied at the next checkpoint.

Native queue mutations have a separate short critical-section lock. A live or
unverifiable owner remains protected even if the operation takes longer than
two minutes. A timeout returns `INBOX_LOCK_TIMEOUT`; it does not authorize
deletion of the lock. Linux owners include boot and process-start identity, so
recovery can distinguish a dead process from a reused PID. Other platforms keep
an occupied PID protected when process-birth identity is unavailable.

Recovery retains the old inode and a unique hard link through canonical unlink.
A delayed remover or releaser cannot remove a successor. Corrupt records,
unknown links, unsafe ownership and shared-writable storage fail closed with
`INBOX_LOCK_UNAVAILABLE`. Inspect those conditions rather than deleting a busy
lock. The legacy lock filename is preserved; review and upgrade old binaries at
an idle boundary, because their old age-only recovery behavior is unchanged.

This coordinates cooperative native CLI/Studio processes on a local filesystem
with hard-link support. It is not distributed locking, hostile same-user
filesystem isolation, application authentication, or the separately registered
retained integration session authority. No service is restarted automatically.

`npm run test:inbox-lock` covers live/unknown owners, real process crashes,
competing removers, PID reuse, successor preservation and queue continuity
through a saved-state restart. It is also included in the full test suite and
the installed-package qualification gate.

Run `npm run test:inbox-dispatch-fence` for persisted-runtime regressions using
offline HTTP responses. Coverage includes English, Chinese and Japanese
corrections; stale writes and finishes; a two-read batch; completion-time input;
additional requirements; event-write failure and restart; step-limit resume;
and ordinary file text that resembles a user instruction.
