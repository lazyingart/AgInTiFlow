# File-checksum consistency at completion

The native tool loop checks explicit SHA-256 file metadata in final answers
against successful native `read_file` receipts from the active task. Both full
hashes and prefix/suffix abbreviations must match. A contradicted claim gets one
repair opportunity per goal revision; a second contradiction pauses the task
with `file_checksum_mismatch`, without a successful completion event.

The repair uses the recorded full hash and asks for the requested answer in its
original language. It grants no new tool permission and does not recreate files.
The same check runs for native `finish` and plain assistant completions, with
regressions for English, Chinese and Japanese metadata and fresh-process
continuation after a saved read.

Evidence comes from runtime events, never from user text or model-authored
receipts. New task boundaries remove earlier evidence. Execution or an unknown
side effect invalidates retained read snapshots; another successful read can
restore them. A later failed read invalidates that file's earlier snapshot.

This is a bounded contradiction check, not complete natural-language or current
filesystem verification. It recognizes adjacent labeled file metadata such as
`note.txt SHA256: ...` and `SHA-256 of note.txt is ...`. It does not validate
arbitrary prose, other algorithms, unlabeled hex, quoted examples, explicitly
historical or expected values, code blocks,
or files without a scoped native receipt. It does not guarantee that another
process has not changed a file since the read, and it does not certify all
provider output. Exact tool metadata and independently verified bytes remain
authoritative.

The assessment bounds text to 131,072 JavaScript string code units, 256 labels,
1,024 file mentions and eight possible values per label. Excessive checksum
metadata receives one shortening opportunity, then pauses with
`file_checksum_unverified`. Unrelated checksum prose without a matching file
mention does not enter the file-receipt assessment.

Run `npm run test:file-checksum` for pure controls and persisted native-runtime
tests. The runtime tests use a loopback scripted provider, real file reads and
fresh child processes, with no paid model, shell, external network or app data.
