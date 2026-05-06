# Image Reading And Web Research

AgInTiFlow separates visual understanding, web search, and wrapper advice so each output has a clear evidence trail.

## Tools

| Tool | Purpose | Evidence |
| --- | --- | --- |
| `read_image` | Read workspace screenshots, plots, scanned text, diagrams, or allowed remote image URLs. | Saves `artifacts/perception/*-read-image.json` in the central session store with image hashes, MIME type, size, model, prompt, and typed result. |
| `web_search` | Cheap raw search snippets. | Returns compact titles, URLs, snippets, and fallback search URL. |
| `web_research` | Sourced research unit for current or external information. | Saves `artifacts/research/*-web-research.json` with query, mode, source list, and answer. |
| `research_wrapper` | Read-only strict-JSON second opinion from the selected wrapper. | Saves `artifacts/wrappers/*-research-wrapper.json` with wrapper, model, reasoning, metadata, result, and raw fallback output. |

## Defaults

- `read_image` uses OpenAI Responses vision when `OPENAI_API_KEY` is configured.
- `read_image` defaults to `AGINTI_PERCEPTION_MODEL=gpt-5.4-mini` and `AGINTI_PERCEPTION_REASONING=medium`, then falls back through `AGINTI_PERCEPTION_FALLBACK_MODELS` or `gpt-4o-mini` if the account lacks access to the preferred model.
- `web_research` defaults to lightweight snippet mode; use `mode=openai` only when hosted OpenAI web search is needed and configured.
- `web_research mode=openai` defaults to `AGINTI_WEB_RESEARCH_MODEL=gpt-5.4-mini` / `medium`, then falls back through `AGINTI_WEB_RESEARCH_FALLBACK_MODELS` or `gpt-4o-mini`.
- `research_wrapper` defaults to `AGINTI_RESEARCH_WRAPPER_MODEL=gpt-5.4-mini` and `AGINTI_RESEARCH_WRAPPER_REASONING=medium`.
- Wrapper advice is not evidence by itself. Verify file paths, sources, hashes, and artifacts before claiming completion.

## Interactive Commands

```text
/image-read artifacts/screenshots/app.png what looks wrong?
/web-research latest Android Gradle plugin official docs
/research-wrapper gpt-5.4-mini medium
/research-wrapper off
```

## Agent Usage

Use `read_image` when pixels matter. Do not guess from filenames or surrounding text if the user asks about a screenshot, chart, microscopy image, or scanned page.

Use `web_research` when freshness, sources, package docs, standards, or current external information matter. Use `domains` to restrict research to official or primary sources.

Use `research_wrapper` when a second model should cross-check image/web/research conclusions. The wrapper receives a strict JSON contract and should preserve uncertainty when it cannot directly inspect a source.

## Safety

- Local image paths must stay inside the workspace unless the run is explicitly trusted host mode.
- `.env`, credential files, private keys, and secret-looking paths are blocked.
- Remote images require web access and respect domain allowlists.
- Images are capped at 10 MB and four inputs per call.
- Artifacts preserve hashes and metadata but never store API keys.

See the design note in [references/multimodal-research-wrapper-design.md](../references/multimodal-research-wrapper-design.md).
