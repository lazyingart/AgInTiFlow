# Integrated deep research

The durable analysis API promotes only explicit deep-research instructions such as “perform deep research” or “全面研究”. Ordinary questions and ordinary Search requests stay on their existing fast paths.

An eligible run uses the private LazyEdge-bound LocalLLM task protocol at the exact `create`, `status`, and `cancel` routes. AgInTi fixes the model alias, limits the depth to `quick`, `standard`, or `deep`, polls one stable task identity, cancels incomplete work on abort, and accepts only bounded no-cache responses. Exact domain, DOI, arXiv, and image-grounded requests retain the stricter one-shot Search path instead of weakening their constraints.

The completed report is accepted only with at least one safe source and valid one-based citations. Every source is preserved in one authority-bound `sources` artifact. A pure research request returns that validated report directly; a combined document, file, or execution request carries it forward as untrusted evidence for the remaining agent work.

Search/research intent, task activity, artifacts, failures, and terminal state use the same durable session ledger as other Agent work. The next message in the thread does not inherit stale research authority or completed activity. Public capabilities advertise the optional `localllm/research-task/v2` protocol while retaining the original Search contract for older Web clients.
