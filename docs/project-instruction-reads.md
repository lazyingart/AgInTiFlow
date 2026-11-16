# Project instructions and concrete follow-ups

AgInTi loads `AGINTI.md` from the selected project at native start and on a
concrete continuation. The interactive instruction preview and capability
checks use the same reader. These instructions are optional project context;
they do not grant additional tool permissions.

The reader resolves the selected project root, then requires the instruction
target to remain within that canonical root and outside sensitive paths.
Selecting a project through a directory alias remains supported, as does a
link to ordinary instruction data within that project. A link to another
project, an environment file or a credential path is unavailable. External
shared guidance should be supplied through an explicitly configured skill or
trusted host instruction, rather than an escaping `AGINTI.md` link.

One regular-file handle supplies a bounded snapshot. File and root bindings
are rechecked before its content is returned. Replacement, concurrent changes,
invalid UTF-8, NUL bytes, nonregular files and close failures withhold the
optional content. A FIFO open does not wait for a writer.

Runtime context retains a maximum 24,000-byte prefix by default; smaller
previews retain their own bounds. A truncated prefix contains only complete
UTF-8 code points and is identified as truncated. Invalid observed bytes are
rejected instead of replaced. Bytes beyond the prefix are not validated.
Ordinary authoritative workspace reads still require a complete snapshot and
reject files exceeding their size limit.

This is canonical path and live-handle validation, not retained-descriptor
storage, `openat2`, hard-link isolation, an I/O deadline or protection against
an adversarial process with the same operating-system identity. It does not
retroactively remove instruction text from older saved conversations. Hosted
multi-user applications still need their own qualified isolation and explicit
input, history and tool authority.

A concrete follow-up remains new work even when it begins with “continue the
same task.” Short edit directives must not reuse an already-completed result.
English, Chinese and Japanese imperative clauses are recognized separately
from bare continuation, passive status and prohibited actions.

For an otherwise unresolved text-file edit, native task mutation receipts can
bind a reference to a previously produced file. The task lineage, original
request and target must agree. Ambiguous names, unrelated tasks, missing
provenance, outside paths, response-only requests and binary outputs do not
gain this binding. Unambiguous explicit file requests retain their ordinary
contract. The binding narrows existing host scopes to the selected targets;
it never enables a disabled tool or overrides a blocked write.

Completion requires a fresh task-owned change to each bound target. An old
artifact, a change to another file or a byte-identical rewrite cannot satisfy
the edit. A bare restart retains the pending requirement and its mutation
baseline. An already-completed bare continuation still avoids repeating tools
when its retained verification remains valid. These are bounded native intent
and evidence rules, not universal language understanding or application
authentication.
