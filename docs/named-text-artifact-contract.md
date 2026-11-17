# Named text artifacts and execution intent

An explicit text-file request keeps its filename spelling, including Unicode
letters and combining marks. The completion contract checks the requested path;
an ASCII lookalike or a differently normalized filename does not satisfy it.
Input, preservation and exclusion clauses keep their separate roles. These
lexical references grant no filesystem permission.
An executable-looking word in a filename, such as `build.md`, is not itself
a command-execution predicate.

Unquoted `a.csvとb.csv` is a two-file list. Quote a single filename that
intentionally contains that list syntax: `"a.csvとb.csv"`. Conjunctions within
a basename such as `週次と月次.md` remain part of the name. Literal-list inference
is bounded to sixteen references, each at most 220 UTF-16 code units. It is a
language hint, not an application authorization boundary; use explicit validated
file scopes for access control.

For a named Markdown or text artifact, a bounded content clause such as
“a checklist covering build, tests and rollback” describes what to write. It
does not require running those workflows. The original task remains the content
authority. Independent instructions such as “then run `node --version`” keep
their command evidence requirement. Quoted explanatory examples do not become
new file actions. This is conservative intent parsing, not unrestricted natural
language understanding: unsupported or ambiguous wording retains ordinary gates.

Cached SCS output-role contracts refresh from the saved task when their role
version is old. They do not inherit output identities or waived obligations from
the model's historical plan. Saved task and event evidence remain authoritative;
the runtime may regenerate model-context and policy instructions on resume.

Planning and execution context display the effective structured-read and
structured-write roots using the same intersection calculation as file policy.
A workspace base is not blanket writable authority. Oversized scope displays
give a bounded notice rather than implying unrestricted access. Runtime checks
remain authoritative. File scopes do not enable shell tools, override secret
guards, attest operating-system isolation or qualify an application adapter.

For a named-output-only task, one denied ancestor-directory discovery probe can
receive one correction turn per explicit owner request. The read stays denied
and the rest of that batch is skipped. The correction uses the unchanged file
scopes and retains every completion requirement. A repeated probe pauses the
run. Required source reads, explicit inspection tasks, unknown output identities,
denied writes and protected paths do not receive this correction. The correction
budget is saved with the session; it grants no additional tool or filesystem
authority. Configured-scope denials explain the actual scope without advising a
shell or read-root bypass.
