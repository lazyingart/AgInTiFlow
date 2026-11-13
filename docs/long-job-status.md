# Recorded background-job status

`start_long_job` creates a native background job in the selected workspace.
Save its returned job ID and use `long_job_status` to inspect it later. A status
request reads the recorded result; it does not start or restart the command.
Shell permission remains required for both tools.

The status reader binds `job.json` and `status.json` to that workspace and job.
It accepts only the known native metadata fields, checks their mapping and
completion consistency, and builds its own result envelope. File content cannot
replace the tool name, job ID or status path, or supply test evidence, tool
arguments or arbitrary output fields. Commands and reason text are redacted
before projection.

Each JSON file is limited to 128 KiB and must be valid UTF-8 with no duplicate
keys. Control directories and files must belong to the current user, have no
group/other write or special permission bits, and have no symlink redirection.
Files must be regular, singly linked files. Existing owner-held 0755 directories
and 0644 metadata remain readable. New control directories use 0700; new control
files and supervisor logs use 0600, including under a group-writable umask.

A regular atomic status replacement is retried up to three total snapshots.
Unsafe, malformed or continuously changing metadata returns
`LONG_JOB_METADATA_UNAVAILABLE` without forwarding file content or probing a
file-supplied session name. Increasing command permissions does not repair it.
The reader probes only the deterministic job session after validation.
`sessionAlive: null` means the probe was inconclusive, including a missing tmux
executable, timeout or permission failure. It does not mean the session is absent.

The native supervisor serializes status publication, including detached PID
updates, heartbeats and terminal status. Only one heartbeat may be pending.
Terminal admission stops the heartbeat timer and drains earlier publications
before replacing status; a late callback cannot overwrite completion. Published
in-memory status advances only after its atomic rename succeeds. A failed write
or rename rejects later publication instead of silently declaring completion or
restarting the command. The output may still exist after a status-storage error;
inspect its evidence before deciding what recovery is safe.
New jobs receive this supervisor when they are created. Updating the CLI does
not rewrite an existing job's supervisor or restart its work.

For an unambiguous launch-only request, an acknowledged native job receipt can
move the next turn to the existing finish-only phase. The receipt is bound to
the current goal revision/hash and mutation revision. Existing evidence,
artifact, test and completion checks still apply. Compound work, multiple
launches, later source changes and unknown wording keep the normal tool loop.
The initial recognition grammar covers short English launch/receipt requests;
it is intentionally conservative rather than a general multilingual classifier.
The public launch answer uses the typed receipt after the ordinary completion
checks, rather than allowing a model paraphrase to claim a fresh running or
completed state. Completion of the launch request does not claim completion of
its deferred job.
If a step limit is reached, current-goal receipts are returned and saved as an
explicit partial result; the goal remains paused. Neither path starts another
producer, polls the job with model steps, or increases the step budget.

Recorded completion remains workspace metadata, not authenticated execution
proof. These bounded named-path checks do not provide retained-descriptor storage,
openat/openat2 semantics, isolation from a writer controlling the same namespace,
or a multi-user authorization boundary. Applications need their own separately
qualified storage and process isolation. This tool does not grant app access.

Run `npm run test:long-job-metadata` for adversarial file/projection tests and
persisted native-runtime fixtures with scripted loopback responses. Those tests
make no live provider requests. `npm run test:long-job-status-publication` runs
the real generated supervisor and a fixed shell child under controlled filesystem
scheduling. It covers delayed PID writes, command/verification failure, heartbeat
floods, terminal admission and write/rename errors. No hosted model, container or
GPU is used. This does not add power-loss durability or strengthen the named-path
and multi-user limitations above. The native status fixtures execute no commands.
`npm run test:background-handoff` covers the receipt scope and the persisted
native loop with scripted loopback responses and fake tmux admission, without
running a background producer or calling a model.
