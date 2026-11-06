# Native tool-result checkpoints

The native runner durably saves a completed dispatch batch before invoking
post-result callbacks, reviews or another model request. It saves the accepted
tool-call frame, confirmed results, current task evidence and consumed step.
A callback failure or a process death after this checkpoint therefore cannot
erase that confirmed progress from the saved model history.

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

Run `npm run test:native-tool-checkpoint` for offline regressions. They kill only
test-owned child processes, verify closed saved/request history and exact output
bytes, resume from a fresh process, inject checkpoint/callback failures, and
cover bounded legacy-reasoning repair and its negative controls.
