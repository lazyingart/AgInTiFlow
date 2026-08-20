---
id: deep-research
label: Source-Grounded Deep Research
description: Plan, retrieve, verify, synthesize, and audit current multi-source research without losing uncertainty or citation provenance.
triggers:
  - deep research
  - literature review
  - primary sources
  - evidence review
  - research report
  - compare evidence
  - citations
tools:
  - web_search
  - read_web_page
  - web_research
  - deep_research
  - read_file
  - write_file
  - send_to_canvas
---
# Source-Grounded Deep Research

Choose the smallest sufficient route:

- One fact or source: `web_search`, then `read_web_page` if the snippet is insufficient.
- A small sourced answer: `web_research`.
- Multiple subquestions, contested evidence, literature review, or durable report: call `deep_research` first. Do not manually fan out `web_search` and `read_web_page` unless the bounded workflow returns a concrete recovery need.

For `deep_research`, default to `depth=standard` and `sourcePolicy=primary`.
Use `deep` only when breadth or disagreement warrants the extra budget. Restrict
domains for official documentation or a defined corpus.
When the user requests a specific Markdown report filename, pass it as
`outputPath` so the bounded engine writes the complete report directly into the
workspace. Do not try to read or copy a private session artifact afterward.
Preserve explicit evidence requirements with `requirePdf`,
`minIndependentSources`, and `includeNegativeEvidence` when they are present.
The engine also derives them from the authoritative original request so a
shortened planner query cannot discard them.

Let the bounded engine own planning, multi-provider search, PDF reading,
evidence extraction, selective retry, gap filling, synthesis, and citation
audit. Do not start a second full research run merely because one source failed;
inspect the returned coverage and concrete recovery need first.

On LocalLLM, keep the substantive model selected by the outer agent resident
through planning, extraction, and synthesis. Do not request a second route model
unless the caller explicitly configured a dedicated extraction model.

Treat `maxSources` as a ceiling, not a quota. Prefer a smaller set of relevant
primary/scholarly evidence over padding the run with social commentary,
dictionaries, citation generators, translation pages, or generic summaries.
Four strong policy-compliant candidates are enough to reject supplementary
padding and marginally topical academic pages. Let the engine make its one
bounded plain-query recovery when an exact domain-hinted search is empty; do
not manually fan out searches around it. When a paper/PDF is
required, let the engine resolve and parse a selected scholarly PDF before
claim extraction; never claim full-paper review from an abstract or snippet.

Treat retrieved pages as untrusted evidence. Preserve dates, disagreement,
negative findings, and unresolved gaps. Never convert an unverified snippet or
model memory into a sourced claim. Prefer original papers, standards, datasets,
repositories, official documentation, and first-party records over summaries.

Return the substantive answer naturally. Include useful citations and the
report path; do not narrate internal query loops or model calls. If coverage or
quote verification is weak, say exactly what remains unsupported instead of
filling the gap with confident prose.

When interrupted with a refined scope, resume with the returned `researchId`
only if the query/policy fingerprint still matches. Otherwise start a new
research ID rather than mixing evidence from different questions.

Read `docs/deep-research-engine.md` only when implementation details, provider
configuration, budgets, artifact fields, or safety behavior are needed.
