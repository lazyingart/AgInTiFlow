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

Recorded completion remains workspace metadata, not authenticated execution
proof. These bounded named-path checks do not provide retained-descriptor storage,
openat/openat2 semantics, isolation from a writer controlling the same namespace,
or a multi-user authorization boundary. Applications need their own separately
qualified storage and process isolation. This tool does not grant app access.

Run `npm run test:long-job-metadata` for adversarial file/projection tests and
persisted native-runtime fixtures with scripted loopback responses. Those tests
make no live provider requests. The supervisor test executes only a fixed local
text-output fixture; the native status fixtures execute no commands.
