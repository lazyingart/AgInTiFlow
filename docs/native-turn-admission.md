# Native assistant turn admission

An explicitly incomplete provider turn cannot authorize a native tool, a plan,
or a final answer. The original response is checked before textual tool syntax
is converted. Exactly one assistant choice is accepted; supplied role, index,
refusal, content and finish metadata must be consistent with the lane and calls.
Partial nonempty content, truncated native calls, multiple choices and explicit
refusals fail with a fixed `MODEL_TURN_*` error and status 422. The error contains
no upstream content and does not trigger a provider or text-protocol fallback.

An own top-level `error` field also contradicts a successful chat-completion
envelope. Its presence is rejected before choices can authorize any action,
including when the value is null, false, empty, hidden or an accessor. The
boundary never reads that value or includes raw upstream diagnostics in its
error. This rule applies to planning, tool turns and direct final answers;
valid native calls, textual tool syntax and SDK metadata remain supported.

Empty or reasoning-only nonacting replies retain the established bounded
continuation/verified-fallback path. Reasoning does not excuse a native call or
nonempty partial answer. Legacy transports may omit role/finish metadata for
compatibility; omission is not a provider admission attestation. The boundary
preserves accepted response bytes and SDK metadata. It does not validate semantic
truth, roll back previous side effects, or replace application authorization.

Fresh-process runtime controls reject bad planning, tool and completion turns.
They verify no rejected content reaches saved messages/events, no truncated call
executes, the session lease releases, and resume can finish without repeating an
already successful producer. Scripted loopback replies are used for malformed
provider cases; real model quality is a separate qualification.
Error-plus-choices controls also verify that a failed finalization retains prior
verified work and a fresh-process resume does not repeat its producer. Refusal
does not roll back already completed actions or authorize automatic redispatch.

## Preserved input paths

An instruction such as “read note.txt, save summary.md, keep note.txt unchanged”
declares an input and a separate output. Only the preservation-clause occurrence
is masked during output inference. An explicit create/save/deliver instruction
elsewhere still declares an output, even when the resulting file must then stay
unchanged. Quoted paths, wrapped lists, Chinese preservation clauses and filenames
containing action words have regression coverage. This is bounded intent parsing,
not general language understanding or permission to mutate a source file.

Run `npm run test:native-turn` for the original-envelope, persisted restart and
input/output intent controls. These tests also run in the full suite and from a
freshly installed package.
