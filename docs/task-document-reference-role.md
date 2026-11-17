# Reading task documents as data

“Read intake/TASK.md and explain its status” asks for information. A command,
output list or checklist inside that file does not become an action for the
agent to perform. The same distinction applies to summaries, translations,
comparisons and explanations of imported task-shaped documents.

“Read TASK.md and carry out its requirements” delegates work. Its applicable
project requirements remain part of completion, subject to the configured
permissions and tool policy. Reading a reference beside an independently
requested command does not remove that command. Requirements retained from
another authorized source also remain required.

The native runtime applies this distinction when it records an instruction
cache, derives a completion contract and imports project acceptance metadata.
Reference-only document requirements are excluded from execution obligations.
On resume, older inferred metadata attributed to those documents is reconciled
against the saved user request. Original read evidence, document bytes and
session history remain intact. Unknown or independently attributed acceptance
requirements are retained; this is not a blanket reset of verification state.

Existing SCS copy, empty-output and preservation refresh events keep their
meaning. An input-role-only cache refresh records
`scs.input_instruction_role_contract_refreshed`; reconciliation of inappropriate
document metadata records `project.reference_document_role_reconciled`.

The role rules cover bounded explicit requests in English, Chinese and Japanese.
Ambiguous delegation across several documents may require a clearer request.
These inference rules are not an operating-system sandbox or a guarantee
against every prompt injection. Hosts must still set file scopes, tool policy,
provider access and execution isolation. Canonical project bootstrap instructions
remain a separate operator-owned mechanism.
