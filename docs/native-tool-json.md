# Native tool argument integrity

Native function-call arguments must have one JSON interpretation before schema
recovery or execution. Duplicate decoded object keys are rejected at every depth,
including escaped spellings such as `path` and `p\u0061th`. Selecting the last
value is not a repair. A malformed member prevents every call in that native
batch from dispatching, including an otherwise valid mutating prefix.

For complete-but-ambiguous JSON, the native agent loop requests a corrected native call through its
existing bounded syntax-repair lane. It does not switch protocols or providers,
invent an intended value, or repeat completed work. The historical event name
`model.text_tool_retry_requested` is retained for compatibility; its reason is
`ambiguous-native-tool-arguments`. Repeated invalid replies exhaust the existing
two consecutive repair attempts and stop without false completion. A later
explicit same-session resume can continue from the saved evidence.
Ordinary JSON syntax/truncation failures retain their existing native contract
repair budget and events; they are not reclassified into that two-retry lane.

The shared parser also protects authenticated tool-contract validation and its
benign schema-repair helpers. Accepted raw argument strings remain unchanged.
JSON-looking source or document text inside a string is ordinary data, not a
second JSON document. Ordinary distinct objects may reuse the same field names.
Bounds are 16 MiB UTF-8, 50,000 values and depth 32. Lone Unicode surrogates and
nonfinite numeric overflow are rejected before they can become different bytes
or values in a tool. Failures contain a fixed message, not argument contents.

This is a native argument boundary, not a semantic truth checker, transaction
over tool side effects, remote cancellation proof or sandbox. It cannot recover
duplicate keys already discarded by a custom host transport or a prior text
protocol decoder. Restricted application providers and Lite retain their
separate strict JSON/authority contracts. No application routing, credential,
LocalLLM admission or optional Codex activation is changed.

`npm run test:native-tool-json` covers decoded key collisions, nested/escaped
keys, valid source strings, malformed data, finite bounds and whole-batch
refusal. Actual-core child-process tests prove bounded repair, no prefix write,
no ambiguous values in saved messages/events, stop on repeated ambiguity, and
fresh-process same-session recovery with one verified artifact. Those tests use
scripted loopback HTTP responses, not live model inference.

## Publication status is an observation

Reporting whether a release was deployed, or whether it needs deployment, does
not itself require publication. The completion contract removes only local
Chinese/English observational predicates from publication-action inference.
Direct publication requests, conditional instructions to execute, status-page
deployment, and mixed requests to check then deploy still require publish
evidence. Other evidence categories and permission policies are unchanged.

A real Chinese same-session follow-up exposed the old overmatch: `请...是否部署`
forced publication evidence after the requested summary had been read. The
same request succeeds after the core correction without editing the artifact.
Seventeen contract controls cover status/action boundaries across three task
profiles; an actual-core fresh-process fixture verifies the read-only follow-up.
Original failed live and full-suite receipts remain separate from final gates.
