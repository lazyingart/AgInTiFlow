# Integrated deep research

The durable analysis API promotes only explicit deep-research instructions such as “perform deep research” or “全面研究”. Ordinary questions and ordinary Search requests stay on their existing fast paths.

An eligible run uses the private LazyEdge-bound LocalLLM task protocol at the exact `create`, `status`, and `cancel` routes. AgInTi fixes the model alias, limits the depth to `quick`, `standard`, or `deep`, polls one stable task identity, cancels incomplete work on abort, and accepts only bounded no-cache responses. Exact domain, DOI, arXiv, and image-grounded requests retain the stricter one-shot Search path instead of weakening their constraints.

The completed report is accepted only with at least one safe source and valid one-based citations. Every source is preserved in one authority-bound `sources` artifact. A pure research request returns that validated report directly; a combined document, file, or execution request carries it forward as untrusted evidence for the remaining agent work.

Search/research intent, task activity, artifacts, failures, and terminal state use the same durable session ledger as other Agent work. The next message in the thread does not inherit stale research authority or completed activity. Public capabilities advertise the optional `localllm/research-task/v2` protocol while retaining the original Search contract for older Web clients.

## Explicit application search policy

Applications that send private conversation history can set
`input.searchInference: false` on `runs/start` or an input-bearing `runs/resume`.
This prevents text (including quoted historical requests) from implicitly
enabling grounded search or deep research. Omission or `true` retains the
existing natural-language inference behavior. Only boolean values are accepted.

An explicit `input.search: {mode: "web" | "papers" | "both", limit: 1..20}`
still selects bounded search when inference is off. The application should
provide its separately authorized public query in that phase, rather than
forwarding private history to a search tool.

The disabled-inference choice is persisted and bound to the run's authority
snapshot. An input-less resume preserves it across restart/retry. A new input
selects its own policy, so a subsequent normal request is not accidentally
restricted by an older private phase. This is tool-routing policy; the hosted
model still receives the input submitted to it, and worker sandbox/network
controls remain separate.

## Text-only application inference

For a private routing decision or title, pass
`input.inference: {responseFormat: "json_object"}` (or `"text"`). This is a
separate, explicit capability: the planner makes one model completion with no
tools, before task classification, search, document revision or execution.
Structured tool-call responses are rejected; quoted tool instructions and code
examples remain text. JSON output must be a complete object. Applications still
validate their own response schema.

Inference cannot be combined with search, attachments or enabled search
inference. It has no retained artifact/image inputs or document lineage, and
session callbacks cannot issue or commit files. The immutable choice survives
restart and input-less retry; a new input selects its own policy. Normal runs
without this field keep their existing tool capabilities. The chosen hosted
model receives the inference input, so this is tool isolation, not an on-device
privacy promise.
