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

1. **Plan**: the active provider decomposes the question into non-overlapping
   subquestions, search queries, preferred source types, and exclusions.
2. **Search**: queries run with bounded concurrency. The no-key default falls
   back from DuckDuckGo HTML to Bing RSS. An explicitly configured Brave Search
   route is optional. Multi-domain corpora receive separate bounded `site:`
   queries matched to entity-specific subquestions instead of one fragile OR
   expression.
3. **Rank, diversify, and deduplicate**: canonical URLs remove tracking state;
   primary, official, scholarly, and high-relevance results rank ahead of
   summaries, while a bounded diversity penalty prevents one domain from
   crowding every selected source.
4. **Read exact sources**: `read_web_page` validates every redirect before the
   next request, rejects private DNS resolutions, streams bounded bytes, strips
   scripts/navigation, extracts article/main text and metadata, records hashes,
   and marks all retrieved text as untrusted evidence.
5. **Extract evidence**: isolated structured-output calls identify relevant
   subquestions, claims, exact quotations, confidence, and limitations.
6. **Verify**: deterministic code checks that quoted passages occur in the
   exact retrieved source. Unverified quotations do not enter synthesis.
7. **Fill gaps**: standard/deep runs may issue one bounded follow-up pass for
   uncovered subquestions when query and source budgets remain.
8. **Synthesize**: the active provider receives verified evidence rather than
   arbitrary page text. Every substantive paragraph and finding carries source
   IDs.
9. **Audit**: deterministic code removes invented source IDs and unsupported
   synthesis statements whose cited sources produced no verified evidence,
   then reports claim, quotation, citation, question, domain, and
   primary-source coverage.
10. **Persist**: every stage checkpoints one JSON state file. The final cited
    Markdown report is saved beside it and sent to the canvas.

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
  "domains": ["docs.example.org", "arxiv.org"]
}
```

To resume a partial or completed same-query run, pass the returned
`researchId`. A completed same-day run is returned from its checkpoint unless
`refresh=true` is explicit. A transient run that retrieved zero allowed sources
is marked failed, preserves its attempts, and retries retrieval on resume
instead of caching an empty report as success. Checkpoint schema changes
invalidate old cached runs automatically.

## Artifacts

Each session stores:

```text
artifacts/deep-research-RESEARCH_ID.json
artifacts/deep-research-RESEARCH_ID.md
```

The JSON includes:

- objective, plan, query/source budgets, and source policy;
- every search attempt and provider failure/fallback;
- canonical source URLs, metadata, retrieval timestamps, and SHA-256 hashes;
- readable source text and ranked passages;
- extracted claims, exact quotations, limitations, and question mappings;
- missing questions, source diversity, and quote-verification rates;
- final synthesis and citation audit;
- stage/status fields used for crash-safe resume.

## Search Providers

The default `auto` policy uses public no-key providers:

```text
DuckDuckGo HTML -> Bing RSS
```

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
- Page bytes are bounded while streaming; extracted characters are bounded too.
- HTML scripts, forms, navigation, footers, and similar noise are removed.
- Retrieved text is always labeled untrusted and never treated as tool or agent
  instructions.
- PDFs are hash-verified but not misrepresented as parsed by the dependency-free
  page reader. A document/PDF tool remains responsible for full PDF extraction.
- Synthesis sees only verified evidence records. Unknown citation IDs and
  citations to sources without verified evidence are removed and reported.
- Provider selection remains explicit. Deep research uses the active provider;
  it does not silently escape LocalLLM or DeepSeek because another API key is
  present.

## Quality Signals

The report audit exposes evidence quality rather than hiding it behind fluent
prose:

- question coverage;
- readable source count;
- primary/scholarly source count;
- independent-domain count;
- exact-quote verification rate;
- statement-level citation coverage;
- unknown/invented citation IDs;
- unsupported synthesis statements removed before report rendering;
- contradictions, uncertainties, and unresolved questions.

These metrics are diagnostic gates, not a guarantee that a source is correct.
High-stakes work still requires domain review and, where appropriate, direct
inspection of the underlying paper, standard, dataset, or official record.
