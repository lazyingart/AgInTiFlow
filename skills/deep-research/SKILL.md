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
- Multiple subquestions, contested evidence, literature review, or durable report: `deep_research`.

For `deep_research`, default to `depth=standard` and `sourcePolicy=primary`.
Use `deep` only when breadth or disagreement warrants the extra budget. Restrict
domains for official documentation or a defined corpus.

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
