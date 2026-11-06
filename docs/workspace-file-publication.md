# Workspace text-file publication

Native `write_file` and `apply_patch` stage bounded UTF-8 text in a unique
sibling file, verify the staged bytes, preserve basic permissions, and fsync the
file before publishing it. Replacement uses a same-directory rename. New files
use an exclusive hard-link publication so a concurrent creator wins safely
instead of being overwritten by a create-only tool call.

Pre-publication write, verification, metadata, sync, close and rename failures
leave the original target untouched. A patch binds the hash of the input it
actually read; an observed concurrent change requires a new read and patch.
In-process publication is serialized per canonical target. Tool receipts retain
the original and new hashes, byte counts and diff, and add a `publication`
record with the method and `fileSynced:true`.

Existing targets must be bounded regular UTF-8 files owned by the running user,
with one link, no NUL bytes and no special permission bits. Interior directory
symlinks are refused before creating descendants. Existing workspace path,
secret-content, permission and artifact-validation guards still apply.

If publication succeeds but removing its staging alias fails, the successful
receipt reports `stagingCleanupPending:true` and the staging path. The tool does
not undo published content or report the write as uncommitted. Review that
residual alias before retrying edits; it can still share the new file's inode.

This is per-file publication, not a transaction across a patch's files, deletes
or moves. It does not provide kernel conditional replacement, protection from
an adversary replacing directories during operations, retained-descriptor
sandbox authority, ACL/xattr preservation, or directory-entry durability after
power loss. A process crash before its tool receipt is saved still requires
reconciliation. These limits do not enable any integration capability or tool
permission.

Run `npm run test:workspace-file-publication`. Offline regressions exercise
partial EIO/ENOSPC writes, staging/rename failures, stale patches, competing
processes, no-clobber creation, unsafe targets and cleanup. Persisted native
runtime tests use the normal prompt “Fix the spelling mistake in note.txt.
Keep the other lines unchanged.” A new process resumes with “Continue the same
task.” and completes with one successful patch and a verified native hash.
