# Partial workspace patch results

A multi-file `apply_patch` is not a filesystem transaction. When an operation
fails after earlier file changes completed, the tool returns `ok:false` and
`partial:true`, with the actual confirmed `changes` and a versioned
`partialPatch` progress record. It does not erase completed receipts or roll
other files back automatically. Failures during preflight or before any known
effect retain the ordinary failure behavior.

Progress includes `schemaVersion:1`, total operations, completed operations,
the failed operation index and its type/path, and the unattempted operation
count. A move whose destination was published but whose source could not be
removed records `apply_patch_move_destination`, `sourcePath` and
`movePending:true`. It does not claim a completed source removal.

The native runtime records a failed tool event, confirmed file-change events
and the mutation revision. Its closed tool-call checkpoint retains the partial
outcome before post-result callbacks. Same-session continuation and provider
history repair keep the failed status and bounded confirmed receipts, retire
older reads of changed files, and ask for inspection of remaining work rather
than replay of the whole patch. Arguments and raw patch/diff bodies are omitted
from the compacted partial receipt. At most 24 change receipts are retained in
that view; `confirmedChangeCount` and `changesTruncated` distinguish a bounded
view from the full private event/state record.
Read retirement uses the complete native result before truncation. When only
a truncated historical view remains, older cached reads are retired
conservatively because the omitted paths cannot be proven unchanged.
The fixed recovery instruction survives compaction: confirmed receipts refer
to whole-file publication, not a stub that should be restyled merely because
a later operation failed. Legitimate repairs remain allowed when fresh evidence
shows an original requirement is unmet, or the user requests a revision.

This does not provide exactly-once effects after process death before receipt
persistence, transactional moves/deletes, or protection from adversarial
external namespace changes. A remembered receipt is historical evidence, not
proof that another process has left the file unchanged. Inspect current files
before completing remaining work.
Store or observer failures before the native checkpoint remain reconciliation
cases; the partial-result contract does not make those paths exactly-once.

Run `npm run test:partial-patch-recovery`. Its persisted-runtime tests use
isolated scripted HTTP fixtures and real native tools, including an offline
DeepSeek-to-LocalLLM same-session handoff. They neither contact a real LocalLLM
service nor qualify a production provider role. Shell, wrappers, model fallback
and external network access are disabled in those fixtures.
