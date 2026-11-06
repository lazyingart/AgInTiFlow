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

Run `npm run test:inbox-dispatch-fence` for persisted-runtime regressions using
offline HTTP responses. Coverage includes English, Chinese and Japanese
corrections; stale writes and finishes; a two-read batch; completion-time input;
additional requirements; event-write failure and restart; step-limit resume;
and ordinary file text that resembles a user instruction.
