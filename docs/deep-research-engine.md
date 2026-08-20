# Deep Research Engine

AgInTiFlow has two deliberately different research paths:

- `web_search` is a fast lookup tool.
- `deep_research` is a bounded, resumable evidence workflow for questions that
  need multiple sources, disagreement analysis, or a durable report.

Simple questions should stay on the fast path. A deep-research run spends more
queries and model calls only when breadth, verification, and traceability add
real value.

## Architecture

The implementation follows the strongest production patterns without making
every query an unbounded agent swarm:

1. **Plan**: a fast routing model on the active provider decomposes the question
   into non-overlapping subquestions, search queries, preferred source types,
   and exclusions. If that structured call fails, the main model gets one
   bounded retry; the workflow never switches providers implicitly.
2. **Search**: queries run with bounded concurrency. Quick lookup uses the
   no-key DuckDuckGo-to-Bing fallback. Standard/deep research uses a bounded
   ensemble that merges DuckDuckGo and Bing indexes, plus Brave only when it is
   explicitly configured. A paper-oriented request receives one initial bounded
   scholarly discovery pass against Crossref and arXiv, attached to the most
   paper-like planned query. If the independently verified source minimum is
   still open, the single gap pass may retry that lane once with a different
   planner-derived query. This improves paper recall and metadata identity
   without multiplying every query or creating bursty arXiv traffic.
   When the request explicitly asks for official engineering or first-party
   implementation evidence, one separate bounded query targets engineering,
   documentation, system-card, and whitepaper surfaces. The selector reserves
   one relevant first-party candidate when available instead of letting a large
   paper set erase the requested source class. Search snippets can guide
   discovery, but they cannot satisfy verified first-party coverage or enter
   synthesis as cited evidence.
   Canonical duplicates found by multiple providers are promoted and retain
   per-provider rank evidence. Multi-domain corpora receive separate bounded `site:`
   queries matched to entity-specific subquestions instead of one fragile OR
   expression. If an exact `site:` query returns no candidates, the engine
   retries the same planner query once without the search-operator hint while
   retaining the domain allowlist. This recovery stays inside the original
   research run and is recorded in its checkpoint.
3. **Rank, diversify, and deduplicate**: canonical URLs remove tracking state.
   Scholarly records additionally carry DOI, arXiv ID, normalized title,
   provider, venue, author, PDF, and alternate-URL provenance. DOI publisher,
   arXiv abstract, and arXiv PDF variants of one work collapse before source
   budgeting, while the audit records how many variants were merged. A title
   match is only a fallback and never merges records with conflicting DOI or
   arXiv identities. A source
   repository is useful implementation evidence but is not automatically an
   official or scholarly paper merely because it is hosted on GitHub or has
   `paper` in its path.
   Topical overlap, independent provider rediscovery, discovery by multiple
   planned queries, and domain-constrained intent rank candidates. Official or
   scholarly status is a quality signal, not a substitute for relevance, so a
   generic university citation guide cannot crowd out a paper merely because it
   is hosted on an academic domain. Dictionary, translation, and citation-generator
   pages are excluded when stronger policy-compliant evidence exists. Under a
   strict `primary`, `official`, or `scholarly` policy, four relevant compliant
   candidates are enough to exclude generic supplementary commentary entirely.
   When at least four strongly topical compliant candidates exist, marginally
   related academic pages are excluded as well;
   a sparse set may add only enough relevant supplementary context to reach
   that small floor, but a strict policy with zero compliant candidates fails
   closed instead of accepting generic filler. Source budgets are ceilings rather than targets, and a
   bounded diversity penalty prevents one domain from crowding every selected
   source.
4. **Read exact sources**: `read_web_page` validates every redirect before the
   next request, rejects private DNS resolutions, streams bounded bytes, strips
   scripts/navigation, extracts article/main text and metadata, records hashes,
   and marks all retrieved text as untrusted evidence. Verified PDF response
   bytes are passed to a bounded local `pdftotext` process when available, so
   papers can contribute exact passages without sending the PDF to another
   provider. If one exact scholarly landing page is inaccessible, the reader
   tries only the same work's verified alternate landing/PDF URLs before giving
   up; it never substitutes a nearby paper. When the original request requires
   a paper, selected provider-supplied PDFs and arXiv, ACL Anthology,
   OpenReview, and Nature landing pages are resolved to bounded PDF candidates
   before evidence extraction. Direct PDF candidates receive the bounded 5 MiB
   document allowance rather than the generic 2 MiB HTML-page allowance; larger
   files still fail closed with the exact size error. Browser-verification,
   CAPTCHA, and access-challenge HTML is marked unreadable instead of counting
   its warning text as source evidence.
5. **Extract evidence**: isolated structured-output calls identify relevant
   subquestions, claims, exact quotations, confidence, and limitations. The
   active provider's fast routing model handles the parallel first pass. Only
   failed sources are retried, at lower concurrency and a larger output budget,
   with that provider's stronger main model. Every extracted claim receives a
   stable evidence ID such as `S2-C3`.
6. **Verify**: deterministic code checks that quoted passages occur in the
   exact retrieved source. Unverified quotations do not enter synthesis.
7. **Fill gaps**: standard/deep runs may issue one bounded follow-up pass for
   uncovered subquestions, insufficient independent readable primary evidence,
   or a requested first-party class that has not produced readable,
   quote-verified evidence, when query and source budgets remain.
8. **Synthesize**: the active provider's main model receives verified evidence
   rather than arbitrary page text. Every substantive paragraph and finding
   cites exact evidence IDs instead of merely naming a source. A failed main
   synthesis gets one same-provider fast-model fallback.
9. **Audit**: deterministic code removes unknown or unverified evidence IDs,
   derives visible source citations from accepted evidence records, removes
   unsupported synthesis statements, then reports claim, quotation, citation,
   question, domain, PDF, and independent primary-source coverage. A second
   audit checks the cleaned synthesis; rejected provider IDs remain diagnostic
   warnings but do not make the delivered report's final audit look dirty.
10. **Persist**: every stage checkpoints one JSON state file. The final cited
    Markdown report is saved beside it by default, or written directly to a
    guarded workspace-relative `outputPath` when the caller requests a durable
    filename, then sent to the canvas.

This combines the orchestrator/worker and separate citation-pass lessons
described by [Anthropic's production research
system](https://www.anthropic.com/engineering/multi-agent-research-system)
with the iterative plan/search/read/gap/synthesize and background-resume model
documented for [Gemini Deep
Research](https://ai.google.dev/gemini-api/docs/deep-research). AgInTiFlow keeps
the fan-out explicitly bounded and stays on the active DeepSeek, LocalLLM, or
other selected provider.

## Research Budgets

| Depth | Queries | Sources | Gap passes | Intended use |
| --- | ---: | ---: | ---: | --- |
| `quick` | 3 | 6 | 0 | Small comparison or source check |
| `standard` | 6 | 12 | 1 | Normal multi-source research |
| `deep` | 10 | 20 | 1 | Broad review, contested topic, or decision report |

The caller may reduce these budgets, but hard caps remain 12 queries and 24
sources. Search/page concurrency is bounded to six and defaults to three or
four.

Explicit evidence requirements are derived from both the tool arguments and
the authoritative original user goal. A planner may shorten the research
question, but cannot silently drop requirements such as “compare at least three
independent primary sources,” “read a paper/PDF when available,” or “include
negative evidence.” These requirements are fingerprinted and checkpointed.

Planning and evidence extraction deliberately use the configured routing model
when it belongs to a hosted active provider. Synthesis uses the configured main
model. For LocalLLM, when the outer agent has already selected and loaded its
main model, every research stage reuses that resident model unless a dedicated
extraction model was explicitly configured. This avoids a costly GPU residency
swap; local evidence extraction is bounded to two concurrent calls by default.
Failed evidence calls are retried selectively rather than repeating every
successful source.

The same residency rule applies to the outer SCS committee plan for a LocalLLM
research task. It reuses the selected executor model instead of waiting on a
second local route-model queue before the bounded research workflow can start.

Planner-produced concise queries take precedence over the original user brief.
The raw brief is retained as a search query only when it is already concise;
long conversational instructions are research context, not a literal search
engine query. For DeepSeek, bounded JSON transformations explicitly use
non-thinking mode. The multi-stage workflow supplies the reasoning structure,
while disabling hidden reasoning prevents a small extraction object from
spending its entire output budget before emitting JSON.

## Usage

Interactive:

```text
/deep-research standard Compare current primary-source approaches to citation verification in research agents
/deep-research deep Review recent optical biosensing methods, emphasizing original papers and unresolved limitations
```

An agent can call:

```json
{
  "query": "What evidence supports the current design choices?",
  "depth": "standard",
  "sourcePolicy": "primary",
  "requirePdf": true,
  "minIndependentSources": 3,
  "includeNegativeEvidence": true,
  "domains": ["docs.example.org", "arxiv.org"],
  "outputPath": "reports/design-evidence.md"
}
```

To resume a partial or completed same-query run, pass the returned
`researchId`. A completed same-day run is returned from its checkpoint unless
`refresh=true` is explicit. A transient run that retrieved zero allowed sources
is marked failed, preserves its attempts, and retries retrieval on resume
instead of caching an empty report as success. Checkpoint schema changes
invalidate old cached runs automatically.

`outputPath` is optional and must name a Markdown file inside the active
workspace. Repository internals such as `.git`, dependency trees such as
`node_modules`, path escapes, and symlink escapes are rejected. This lets the
bounded engine satisfy an exact report filename without granting the outer
agent access to private session artifacts.

## Artifacts

Each session stores:

```text
artifacts/deep-research-RESEARCH_ID.json
artifacts/deep-research-RESEARCH_ID.md
```

When `outputPath` is supplied, the JSON checkpoint remains private to the
session while the report is also written to that exact guarded workspace path.

The JSON includes:

- objective, plan, query/source budgets, and source policy;
- every search attempt and provider failure/fallback;
- canonical source URLs, metadata, retrieval timestamps, and SHA-256 hashes;
- readable source text and ranked passages;
- extracted claims, exact quotations, limitations, and question mappings;
- missing questions, source diversity, and quote-verification rates;
- explicit evidence requirements, parsed-PDF attempts, and independent verified
  primary/scholarly source counts;
- DOI/arXiv work identities, alternate read attempts, and merged-variant counts;
- requested and verified first-party engineering source coverage;
- evidence that came only from search excerpts, kept distinct from readable
  source verification;
- final synthesis and citation audit;
- stage/status fields used for crash-safe resume.

## Search Providers

The default `auto` policy uses public no-key providers:

```text
DuckDuckGo HTML -> Bing RSS
```

The `multi` policy used by standard/deep research queries all available
no-key indexes and merges their canonical results:

```text
DuckDuckGo HTML + Bing RSS (+ Brave when explicitly configured)
```

Paper-oriented `deep_research` requests keep that broad lane and add one
bounded scholarly lane initially; an unresolved independent-source contract
may trigger one additional scholarly call in the single gap pass:

```text
Crossref metadata + arXiv metadata/preprint links
```

For direct `web_search` use, `provider=scholarly` selects only Crossref and
arXiv, while `provider=research` combines the general and scholarly lanes.
`provider=crossref` and `provider=arxiv` remain available for a deliberately
index-specific lookup. These public endpoints require no API key; provider
failures remain visible in `providersTried` rather than being hidden.

An explicit request for official engineering writeups adds one source-class
query such as an engineering architecture or system-card lookup. This is not a
hardcoded vendor list: the planner names relevant first-party organizations
when it knows them, while deterministic routing preserves the requested source
class and records whether a readable first-party source actually supported a
quote-verified claim. A result-page excerpt alone is reported separately and
does not close that requirement.

For an explicitly configured Brave Search account:

```bash
export AGINTI_WEB_SEARCH_PROVIDER=brave
export BRAVE_SEARCH_API_KEY=...
```

An ambient key does not select Brave. The provider must be selected explicitly
through configuration or a tool argument.

## Safety And Evidence Rules

- Only public HTTP/HTTPS URLs are accepted. Embedded credentials, single-label
  internal hosts, loopback, RFC1918, link-local, multicast, `.local`, private
  DNS resolutions, and redirected private targets are rejected before fetch.
- Domain allowlists and blocklists apply to search results, direct reads, and
  redirect targets.
- Tracking parameters and fragments are removed before deduplication.
- arXiv abstract, HTML, versioned, and PDF URLs for the same paper collapse to
  one canonical paper identity before source budgeting.
- DOI and arXiv variants are merged at the work level when identifiers or a
  sufficiently specific normalized scholarly title agree. Conflicting DOI or
  arXiv identities always remain separate even when titles match. Distinct
  variant URLs remain in the audit and exact-source fallback ledger.
- Strict source policies do not fill unused capacity with blogs or social posts
  once at least four relevant policy-compliant sources are available. This is a
  quality floor, not a requirement to consume the configured source ceiling.
- When a PDF is explicitly required, evidence extraction does not begin until a
  discovered PDF has yielded readable text. A hard requirement fails closed;
  “when available” is allowed to proceed only when no bounded PDF candidate was
  discoverable.
- Page bytes are bounded while streaming; extracted characters are bounded too.
- Direct PDF candidates use a bounded 5 MiB read allowance; ordinary pages keep
  the lower 2 MiB allowance.
- HTML scripts, forms, navigation, footers, and similar noise are removed.
- Access-challenge pages are explicitly rejected as unreadable evidence.
- Retrieved text is always labeled untrusted and never treated as tool or agent
  instructions.
- PDFs are always hash-verified. When local `pdftotext` is available, bounded
  text and relevant passages are extracted from those exact bytes; otherwise
  the result stays explicitly unreadable and preserves the extraction error.
- Synthesis sees only verified evidence records. Unknown citation IDs and
  citations to sources without verified evidence are removed and reported.
- Provider selection remains explicit. Deep research uses the active provider;
  it does not silently escape LocalLLM or DeepSeek because another API key is
  present.
- Structured-output mode follows the active provider contract. DeepSeek and
  LocalLLM use JSON-object output with a prompt fallback; providers that truly
  support JSON Schema may use it. Unsupported response formats are not probed
  on every research call.

## Quality Signals

The report audit exposes evidence quality rather than hiding it behind fluent
prose:

- question coverage;
- readable source count;
- primary/scholarly source count;
- independent verified primary/scholarly source count;
- duplicate scholarly variants merged before source budgeting;
- verified first-party engineering/official source count when requested;
- search-excerpt-only source-match count, which is diagnostic and never enters
  synthesis or satisfies readable first-party or independent-primary verification;
- parsed-PDF count and PDF requirement status;
- independent-domain count;
- exact-quote verification rate;
- statement-level citation coverage;
- unknown/invented citation IDs;
- unsupported synthesis statements removed before report rendering;
- contradictions, uncertainties, and unresolved questions.

These metrics are diagnostic gates, not a guarantee that a source is correct.
High-stakes work still requires domain review and, where appropriate, direct
inspection of the underlying paper, standard, dataset, or official record.
