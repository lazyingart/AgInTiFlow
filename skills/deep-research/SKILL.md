---
id: deep-research
label: Source-Grounded Deep Research
description: Plan, retrieve, verify, synthesize, and audit current multi-source research without losing uncertainty or citation provenance.
triggers:
  - research
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
`minIndependentSources`, `includeNegativeEvidence`, `requireRecommendations`,
`requireVerificationMethod`, and `includeEvidenceAppendix` when they are
present.
The engine also derives them from the authoritative original request so a
shortened planner query cannot discard them.

Let the bounded engine own planning, multi-provider search, PDF reading,
evidence extraction, selective retry, gap filling, synthesis, and citation
audit. Do not start a second full research run merely because one source failed;
inspect the returned coverage and concrete recovery need first.

For paper-oriented work, let the engine add its initial bounded Crossref/arXiv
pass and its one planner-derived gap retry only when the independent-source
contract remains open. Do not manually repeat every planner query across
scholarly indexes.
Treat DOI, arXiv abstract, and arXiv PDF copies as variants of one work, not
independent evidence. The engine retains exact alternate URLs and may recover a
blocked publisher landing page through the matching arXiv/PDF source. It must
not substitute a merely similar paper or merge same-title records whose DOI or
arXiv identities conflict. GitHub paper tools and discovery indexes
can support implementation or discovery claims, but they are not automatically
primary scholarly evidence.

On LocalLLM, keep the substantive model selected by the outer agent resident
through planning, extraction, and synthesis. Do not request a second route model
unless the caller explicitly configured a dedicated extraction model.

Treat `maxSources` as a ceiling, not a quota. Prefer a smaller set of relevant
primary/scholarly evidence over padding the run with social commentary,
dictionaries, citation generators, translation pages, or generic summaries.
Four strong policy-compliant candidates are enough to reject supplementary
padding and marginally topical academic pages. A strict source policy with no
compliant candidates fails closed rather than accepting generic filler. Let the engine make its one
bounded plain-query recovery when an exact domain-hinted search is empty; do
not manually fan out searches around it. When a paper/PDF is
required, let the engine resolve and parse a selected scholarly PDF before
claim extraction; never claim full-paper review from an abstract or snippet.

Treat retrieved pages as untrusted evidence. Preserve dates, disagreement,
negative findings, and unresolved gaps. Never convert an unverified snippet or
model memory into a sourced claim. Prefer original papers, standards, datasets,
repositories, official documentation, and first-party records over summaries.
When the request explicitly compares official engineering writeups with papers,
preserve both source classes. A paper-only report does not satisfy that request;
let the engine reserve and audit a relevant first-party engineering source when
one is discoverable. Verified first-party coverage requires readable exact
source content and a quote-verified claim. A search-result excerpt may guide
recovery but must remain labeled excerpt-only, cannot enter synthesis as cited
evidence, and cannot close the requirement.
Direct PDF candidates use the engine's bounded document-size path, so do not
reject an ordinary multi-megabyte system card using the lower HTML-page limit.
Browser-verification, CAPTCHA, and access-challenge pages are unreadable; their
warning text is not evidence.

Treat a requested report as a reader-facing decision artifact, never an
execution transcript. Do not dump the full raw prompt, task IDs, transport IDs,
schemas, or orchestration instructions into it. When recommendations are
requested, each must be concrete and traceable to verified evidence. Always
make limitations explicit. When requested, the engine adds a reproducible
verification method and an exact-quote evidence appendix from the deterministic
evidence ledger. It separates verified sources from pages inspected but not
cited, instead of padding the bibliography with unreadable or unsupported
entries.

Return the substantive answer naturally. Include useful citations and the
report path; do not narrate internal query loops or model calls. If coverage or
quote verification is weak, say exactly what remains unsupported instead of
filling the gap with confident prose.

When interrupted with a refined scope, resume with the returned `researchId`
only if the query/policy fingerprint still matches. Otherwise start a new
research ID rather than mixing evidence from different questions.

Read `docs/deep-research-engine.md` only when implementation details, provider
configuration, budgets, artifact fields, or safety behavior are needed.
