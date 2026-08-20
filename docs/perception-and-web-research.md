# Image Reading And Web Research

AgInTiFlow separates visual understanding, web search, and wrapper advice so each output has a clear evidence trail.

## Tools

| Tool | Purpose | Evidence |
| --- | --- | --- |
| `read_image` | Read workspace screenshots, plots, scanned text, diagrams, or allowed remote image URLs. | Saves JSON and Markdown reports under `artifacts/perception/`, records image hashes, and sends the Markdown report to the canvas when used by an agent run. |
| `web_search` | Cheap raw search snippets or a bounded multi-provider ensemble. | Returns compact titles, canonical URLs, snippets, provider attempts, and per-provider discovery evidence. |
| `read_web_page` | Read one exact public source instead of relying on a snippet. | Returns bounded article/PDF text, metadata, canonical URL, relevant passages, retrieval time, and content hash. |
| `web_research` | Sourced research unit for current or external information. | Saves `artifacts/research/*-web-research.json` with query, mode, source list, and answer. |
| `deep_research` | Plan, retrieve, verify, synthesize, and audit a genuinely multi-source question. | Saves resumable JSON state and a cited Markdown report with exact claim-evidence IDs, coverage metrics, and an optional guarded workspace `outputPath`. |
| `research_wrapper` | Read-only strict-JSON second opinion from the selected wrapper. | Saves `artifacts/wrappers/*-research-wrapper.json` with wrapper, model, reasoning, metadata, result, and raw fallback output. |

## Defaults

- In a LocalLLM session, `read_image provider=auto` sends bounded image data to the loopback LocalLLM Chat Completions endpoint with `AGINTI_LOCALLLM_VISION_MODEL` or `localllm-vision-xl`. It does not try OpenAI or a wrapper after a local failure.
- In an OpenAI session, `read_image provider=auto` uses OpenAI Responses vision. A non-OpenAI session must set `allowHostedImagePerception=true` before `provider=openai` is accepted. `OPENAI_API_KEY` by itself grants no permission.
- Codex image reading requires both `provider=codex` and explicitly enabled wrapper tools. It is not an automatic fallback.
- OpenAI image reading defaults to `AGINTI_PERCEPTION_MODEL=gpt-5.4-mini` and `AGINTI_PERCEPTION_REASONING=medium`, with fallback models remaining inside the same explicitly selected OpenAI provider.
- `web_research` defaults to lightweight snippet mode. The active LocalLLM can synthesize those returned snippets and sources during the next agent step without a second provider call.
- `web_search provider=auto` falls back from DuckDuckGo HTML to Bing RSS. `provider=multi` merges both indexes and adds Brave only when explicitly configured. Standard/deep research defaults to this ensemble; quick research stays on auto.
- Exact PDF responses are hashed first, then parsed locally with bounded `pdftotext` when available. Direct PDF candidates receive a bounded 5 MiB document allowance instead of the generic 2 MiB HTML-page allowance. An explicit original-goal PDF requirement resolves selected arXiv, ACL Anthology, OpenReview, or Nature landing pages before claim extraction; extraction failure remains visible rather than silently treating a snippet as full-paper evidence.
- `deep_research` stays on the active provider: its fast routing model plans and extracts sources in parallel, only failed extractions retry on the stronger main model, and the main model synthesizes the verified evidence. DeepSeek JSON transformations explicitly disable thinking mode and use its supported JSON-object contract; the bounded workflow, not hidden chain-of-thought, owns decomposition and verification. A failed synthesis may fall back once to the same-provider routing model. It never treats another provider's ambient credentials as permission. Visible source citations are derived from verified claim-level evidence IDs rather than trusted directly from model output.
- LocalLLM research reuses an already-selected resident main model for planning, extraction, and synthesis unless `deepResearchExtractionModel` is explicit. It limits extraction to two concurrent local calls by default, avoiding multi-model GPU thrash and four-way local inference contention.
- Candidate ranking requires topical evidence, provider/query rediscovery, or an explicit domain constraint. Academic or official hosting improves source quality but does not make an irrelevant page relevant. When a strict-policy run finds at least four strongly topical sources, marginally related academic pages cannot consume the remaining source budget.
- A domain-specific `site:` query that returns no candidates is retried once as the same plain planner query while the domain allowlist remains enforced. This bounded recovery is part of one research run, not an outer-agent manual search detour.
- Concise planner queries are searched before the raw request, and long conversational briefs are not sent verbatim to search engines. Explicit source-count, PDF, first-party, and negative-evidence requirements remain authoritative from the original goal. Paper-oriented runs add one bounded Crossref/arXiv discovery pass and may retry it once during the single gap pass when the independently verified source minimum remains open; DOI, arXiv HTML/abstract/PDF, and version URLs are merged as one scholarly work while conflicting identifiers remain separate and exact variants remain auditable fallback paths. First-party requirements close only on readable, quote-verified content. Search excerpts and access-challenge pages remain discovery diagnostics and never enter synthesis as cited evidence. Source budgets are ceilings: once a strict source policy has at least four relevant compliant candidates, blogs, social commentary, dictionaries, citation generators, and third-party paper utilities cannot pad the set; with zero compliant candidates, strict policy fails closed.
- A requested `deep_research outputPath` must be a Markdown file inside the active workspace. Path escapes, symlink escapes, `.git`, and `node_modules` are rejected, so an agent can deliver the requested report without reading private session artifacts.
- `web_research mode=openai` is accepted only for an active OpenAI session or when `allowHostedWebResearch=true`. A denied or failed hosted synthesis is returned with `ok=false`; any preserved snippets are labeled fallback evidence rather than hosted success.
- `json_specialist` stays on the active provider. A different provider requires `allowHostedJsonSpecialist=true`; ambient hosted keys and model-generated provider arguments cannot escalate a LocalLLM session.
- `research_wrapper` defaults to `AGINTI_RESEARCH_WRAPPER_MODEL=gpt-5.4-mini` and `AGINTI_RESEARCH_WRAPPER_REASONING=medium`.
- Wrapper tools and auxiliary image generation are opt-in. Installed CLIs or saved provider keys do not enable them by themselves.
- Wrapper advice is not evidence by itself. Verify file paths, sources, hashes, and artifacts before claiming completion.

## Interactive Commands

```text
/image-read artifacts/screenshots/app.png what looks wrong?
/image-read --codex artifacts/screenshots/app.png what looks wrong?
/web-research latest Android Gradle plugin official docs
/deep-research standard compare current citation-verification methods using primary sources
/research-wrapper gpt-5.4-mini medium
/research-wrapper off
```

## Agent Usage

Use `read_image` when pixels matter. Do not guess from filenames or surrounding text if the user asks about a screenshot, chart, microscopy image, or scanned page.

Use `web_research` when freshness, sources, package docs, standards, or current external information matter. Use `domains` to restrict research to official or primary sources.

Use `deep_research` when one lookup is insufficient: literature reviews, disputed claims, broad comparisons, technical decisions, or reports that require explicit coverage and citation auditing. See [Deep Research Engine](deep-research-engine.md).

Use `research_wrapper` when a second model should cross-check image/web/research conclusions. The wrapper receives a strict JSON contract and should preserve uncertainty when it cannot directly inspect a source.

## Safety

- Local image paths must stay inside the workspace unless the run is explicitly trusted host mode.
- `.env`, credential files, private keys, and secret-looking paths are blocked.
- Remote images require web access and respect domain allowlists.
- Web page reads reject private/local network targets and private redirect destinations.
- Images are capped at 10 MB and four inputs per call.
- Artifacts preserve hashes and metadata but never store API keys.
- Provider selection is credential-neutral: an ambient key authenticates only a backend that the run already selected and permitted.

See the design note in [references/multimodal-research-wrapper-design.md](../references/multimodal-research-wrapper-design.md).
