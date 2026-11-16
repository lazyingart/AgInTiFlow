# Moving bounded native text files

After reading a source, use an `apply_patch` document with `*** Update File:`
followed by `*** Move to:`. A move may also contain ordinary text hunks. The
destination must be absent. An exact source-derived `write_file` copy uses
`copyFromPath` and its observed `copyFromSha256`, with no retranscribed content.

Moves preserve the owned source's POSIX permission bits, uid and gid on the
staged destination. Source-derived copies remain caller-owned and narrow the
source permission bits by the caller's umask; they never bypass a restrictive
creation mask. The source snapshot must match its expected hash and
remain unchanged through staging. Metadata application and the staged result
are checked before exclusive publication; failure leaves the source in place.
The model cannot supply mode or ownership overrides. Ordinary newly authored
files continue to follow the caller's umask.

Successful multi-file patches report each destination separately. Completion
uses those native receipts, not an obsolete read of a removed source or a model
summary. It verifies current destination bytes and available mode/ownership
metadata. Missing, modified, aliased, incomplete or malformed receipts do not
qualify. A deletion is not an artifact. A move destination marked pending is
only a copy: source removal and completion are not confirmed.

This is bounded UTF-8 text handling, not a general replacement for filesystem
`mv` or `cp`. Move sources must be owned, singly linked regular files without
special mode bits. Copies may read explicitly permitted source aliases or
linked/readable regular files; they never inherit special mode bits or the
source's ownership. ACLs, extended attributes, timestamps, inode identity and
existing hardlink relationships are not preserved or qualified. Use an independently
qualified filesystem worker when those properties matter; do not claim their
preservation from this tool. Older moves without source metadata receipts
cannot be retrospectively certified as preserving permissions.

Publication remains per file, with exclusive creation and existing path and
secret guards. It is not a multi-file transaction, a kernel conditional delete,
retained-descriptor authority, sandbox isolation or same-UID mutation fencing.
Cancellation after publication can leave a truthful partial receipt. Reinspect
that state and finish only the remaining authorized work; do not overwrite a
competing destination or roll back unrelated changes.
