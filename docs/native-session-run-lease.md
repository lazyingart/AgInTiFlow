# Native session run leases

Only one native CLI or Studio invocation may run a persistent session at a time.
A concurrent resume returns `SESSION_RUN_ACTIVE` before loading or changing its
state, invoking a tool, or requesting a model response. Follow-ups can use the
session inbox or wait until the active invocation finishes.

The owner record is fully written and synced before atomic no-replace hard-link
publication. Recovery retains the old inode and checks a unique removal link,
link count and current name before unlinking. A delayed recovery operation cannot
remove a successor's live lease. Linux owners include boot and process-start
identity; where birth identity is unavailable, an occupied PID is unverified and
remains protected. Age alone never proves an owner dead. Invalid owner JSON,
unsafe modes or links, and unknown residue fail closed without changing evidence.
New session/index directories use `0700` even under a group-writable umask. Existing
unsafe directories are rejected without automatic chmod; review their ownership
and access policy before using them. Legacy quarantine ownership comes from the
reaper PID in the filename, not the old owner's PID stored inside it.

Normal completion removes the lease. A dead process can be recovered on the next
invocation, including interrupted publication or removal. Unverifiable or corrupt
records require operator inspection rather than automatic deletion. Do not
remove a lease or stop a process merely because a request reports it busy.

Retained application integrations use their separately registered session
authority. A profile name cannot bypass either authority.

This protocol coordinates cooperative invocations on one local filesystem with
hard-link support. It does not provide distributed locking, exactly-once tool
side effects, protection against malicious same-user filesystem mutation, or
retained-descriptor application storage. Windows relies on the storage ACL
rather than POSIX modes; the release's crash and concurrency qualification runs
on Linux. Do not delete or replace a session directory while its worker is live.
Older binaries retain their old stale-recovery behavior: upgrade them at a safe
idle boundary before relying on concurrent recovery. No running service is
automatically restarted by this change.

`npm run test:native-session-run-lock` exercises deterministic reaper races,
publication/removal crashes, ownership ambiguity, PID reuse, malformed records,
release failures and four-process mutual exclusion. It is also run from the
installed archive by `npm run pack:verify-runtime`.
