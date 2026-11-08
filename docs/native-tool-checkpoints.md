# Native tool-result checkpoints

The native runner durably saves a completed dispatch batch before invoking
post-result callbacks, reviews or another model request. It saves the accepted
tool-call frame, confirmed results, current task evidence and consumed step.
A callback failure or a process death after this checkpoint therefore cannot
erase that confirmed progress from the saved model history.

Workspace file tools and completed `run_command` calls checkpoint a closed
accepted batch before appending result, repository-repair or file-change events.
A process death immediately
after that result event cannot leave the session behind its published outcome.
If checkpointing or subsequent event publication fails, the runtime stops;
it does not manufacture a contradictory failed tool result. Resume uses the
confirmed saved frame, verifies the output and does not repeat its producer.

Completed commands also retain a bounded, redacted result projection in the
existing native command-verification record. Its version 2 receipt separately
binds that result and the exact verification record, so long command arguments
are hashed rather than duplicated. Tool success and verification success remain
distinct: a zero-match query or an outer status probe does not prove a passing
test. Status probes retain the native final exit status rather than reparsing
truncated output. Successful-test fallback additionally requires the exact
stored passing test record. This supplies command
or successful-test evidence if event publication failed or a provider-history
repair changed the model-facing representation. It is bound to the actual
command, mutation revision and uninterrupted same-task lineage. A new task,
missing lineage/hash, failed or blocked result cannot reuse it. Mirrored results
are deduplicated; this fallback never reconstructs ordered Git or publish proof.
The digest checks stored integrity, not protection from a same-UID attacker
rewriting native state. No application authentication or engine fence is added.

Every prompt style now labels a same-task continuation consistently with the
durable task boundary. A generic resume therefore retains its scoped evidence;
an actual new request still starts a new evidence boundary.

The existing dispatch contract serializes mixed or mutating batches. A model
may propose several calls, but unexecuted suffixes are deferred. Bounded
read-only batches are checkpointed only after all accepted calls return, keeping
native request/reply history valid. No result is invented for an unfinished call.

On DeepSeek resume, a native assistant frame without reasoning metadata may be
incompatible with the provider. Complete, unambiguous results for the existing
bounded retained-tool set are preserved in the established textual evidence
format. Reasoning is never invented. Incomplete, duplicate, foreign, failed,
blocked or skipped outcomes do not become successful evidence. Compatible
DeepSeek and ordinary native OpenAI frames retain their existing representation.

This is a completed-batch durability boundary, not exactly-once execution of an
external effect. A crash during a tool or before its checkpoint can still leave
an uncertain outcome. Partial read-only work may need repeating. Existing
permission, create-only, task-provenance and completion gates remain necessary;
a successful tool checkpoint does not mark the whole user task complete.

Tool-result observer delivery has a separate failure boundary. Synchronous
exceptions and rejected promises from result events and post-result logs cannot
change a successful tool into a failed tool. Native events and the closed saved
tool frame retain the actual outcome. Once that checkpoint is saved, a delivery
failure stops the run with `OBSERVER_DELIVERY_FAILED`, before another model
request or a completion claim. Restore the observer before resuming the same
session; confirmed work remains available to the existing continuation guards.
Callback exception text is not copied into model history or native error events.

Pre-dispatch `tool.started` delivery must succeed before the tool runs. Accepted
read-only batches finish their bounded reads before surfacing result-delivery
failure; mutations remain serialized. Cancellation interrupts a pending observer
wait and removes its abort listener, without discarding confirmed outcomes.
Callbacks remain responsible for stopping their own asynchronous external work.
This does not make external delivery transactional, repair a failed native-store
write, or qualify an application-owned event ledger or integration mount.

Run `npm run test:native-tool-checkpoint` for offline regressions. They kill only
test-owned child processes, verify closed saved/request history and exact output
bytes, resume from a fresh process, inject checkpoint/callback failures, and
cover bounded legacy-reasoning repair and its negative controls.
They also kill a worker immediately after its file-tool result or change event,
fail result-event append, and verify a fresh process retains the exact confirmed
result and performs no second write. Command regressions also retain the exact
exit code and bounded stdout/stderr, stop on publication/delivery failure,
preserve nonzero outcomes without claiming success, and resume without a second
checker invocation. The fixed test-owned command runs under explicit trusted
host permission; this is not a sandbox or permission qualification.
Read-only batches retain the same closed
frame boundary; no result is invented for an unfinished member.
