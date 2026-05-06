# Multimodal Research Wrapper Design

Date: 2026-05-06

This note documents a practical design for AgInTiFlow image reading and web search. The short recommendation is:

- Keep native AgInTiFlow tools authoritative for logging, policy, artifacts, and deterministic input/output.
- Add a first-class `read_image` tool for local/session images.
- Upgrade web search into a typed `web_research` path that can use the current DuckDuckGo snippet search, OpenAI hosted web search, or a wrapper.
- Use a Codex/OpenAI small model wrapper such as `gpt-5.4-mini` at `medium` reasoning as an optional perception/research helper, not as the only source of truth.

## Current AgInTiFlow State

Current relevant implementation:

- `src/web-search.js` implements `web_search` through DuckDuckGo HTML search. It returns compact `title`, `url`, and `snippet` results, supports max-result bounds, redacts sensitive query text, and respects domain allowlists.
- `src/model-client.js` exposes `web_search` to the agent when web search is enabled.
- `src/auxiliary-tools.js` implements image generation through GRS AI and Venice. It saves prompts, redacted payloads, manifests, and generated image artifacts.
- `src/tool-wrappers.js` supports external wrappers: Codex, Claude, Gemini, Copilot, and Qwen. The Codex wrapper runs `codex exec` in read-only sandbox mode.
- `src/model-routing.js` currently defaults the Codex wrapper to `gpt-5.5` medium and spare Codex model to `gpt-5.4-mini` high. Overrides already exist through `AGINTI_WRAPPER_MODEL`, `AGINTI_WRAPPER_REASONING`, `CODEX_PRIMARY_MODEL`, and `CODEX_PRIMARY_REASONING`.

The gap:

- There is no first-class image understanding tool. AgInTiFlow can generate images, preview images, and send artifacts to canvas, but it cannot yet ask a vision model to read a screenshot, UI, plot, microscopy image, photo, or scanned text with a typed result.
- Web search currently provides search-result snippets, but it does not provide a higher-level sourced research answer with citations, source lists, freshness policy, and evidence auditing.

## External Research Summary

OpenAI's current documentation supports the two required primitives directly:

- Image understanding: OpenAI's image/vision docs describe passing image URLs, Base64 data URLs, or file IDs as model input, using multiple images in one request, and controlling detail with `low`, `high`, or `auto`. Source: [OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision).
- Hosted web search: OpenAI's web search docs describe the `web_search` tool in the Responses API, sourced citations, domain filtering, complete source lists, user location, and live-access control. Source: [OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search).
- `gpt-5.4-mini`: OpenAI's model page lists image input support and Responses API web search support for `gpt-5.4-mini`, making it a good low-cost perception/research candidate when the user's OpenAI account has access. Source: [OpenAI GPT-5.4 mini model](https://developers.openai.com/api/docs/models/gpt-5.4-mini).
- Codex CLI can be used locally and supports image inputs, web search, model/reasoning controls, and scripting through exec mode. Source: [OpenAI Codex CLI](https://developers.openai.com/codex/cli).

This points to a layered design: direct API calls for strict typed tools, wrapper calls for advisory cross-checks or when the user explicitly wants Codex-style reasoning.

## Design Principle

Do not make "Codex wrapper saw it" the final truth.

For AgInTiFlow, the runtime must own:

- What file/image/url was read.
- Which model/provider was called.
- What exact prompt and policy were used.
- What result schema was returned.
- What artifacts were saved.
- What citations or source URLs were consulted.
- What uncertainty remains.
- Whether the result was verified or only advisory.

The wrapper can help, but AgInTiFlow should normalize wrapper output into the same typed evidence model.

## Proposed Tool Layers

### Layer 1: Native `read_image`

Purpose: deterministic visual understanding over local files, session artifacts, canvas images, screenshots, plots, scanned pages, and URLs.

Default provider:

- `openai/gpt-5.4-mini` with `medium` reasoning for ordinary screenshots, OCR, UI, chart, and document-image work.
- Allow user override with `AGINTI_PERCEPTION_PROVIDER`, `AGINTI_PERCEPTION_MODEL`, and `AGINTI_PERCEPTION_REASONING`.
- If unavailable, fall back to configured wrapper or ask the user to add a key.

Input schema:

```json
{
  "images": [
    {
      "path": "artifacts/screenshots/app-home.png",
      "artifactId": "optional-session-artifact-id",
      "url": "optional-https-url"
    }
  ],
  "question": "What UI problems are visible?",
  "mode": "describe|ocr|ui|chart|scientific|screenshot|qa",
  "detail": "low|high|auto",
  "maxOutputChars": 6000
}
```

Output schema:

```json
{
  "ok": true,
  "toolName": "read_image",
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "reasoning": "medium",
  "mode": "ui",
  "summary": "The app home screen is visible with three cards and a bottom tab bar.",
  "observations": [
    {
      "label": "Header",
      "detail": "The top title is clipped on the right edge.",
      "confidence": "high"
    }
  ],
  "ocrText": [
    {
      "text": "TipSplit",
      "location": "top-left",
      "confidence": "medium"
    }
  ],
  "uncertainties": [
    "Small gray text near the footer is too blurred to read reliably."
  ],
  "sourceImages": [
    {
      "path": "artifacts/screenshots/app-home.png",
      "mime": "image/png",
      "sizeBytes": 821533,
      "sha256": "..."
    }
  ]
}
```

Important behavior:

- Only allow workspace files, session artifacts, HTTPS URLs, or explicit user-provided paths that pass policy.
- Record file size, MIME type, and SHA-256 before upload.
- Cap image count and size.
- Consider stripping EXIF metadata before sending external API requests.
- Never send protected files or secret screenshots without explicit approval.
- Save the normalized JSON response under the session artifacts directory.

### Layer 2: Native `web_research`

Purpose: convert "search the web" from raw snippets into a sourced, auditable research unit.

Implementation paths:

1. Fast native search: current `web_search` DuckDuckGo HTML search for cheap discovery.
2. Hosted OpenAI search: Responses API with `web_search` for citations, domain filters, source lists, and live-access control.
3. Wrapper research: Codex/Gemini/Claude wrapper only when the task needs a second opinion, longer synthesis, or a provider-specific capability.

Input schema:

```json
{
  "query": "latest Android Gradle plugin version official docs",
  "task": "docs|news|package|paper|general",
  "freshness": "current|stable",
  "allowedDomains": ["developer.android.com"],
  "blockedDomains": [],
  "maxResults": 8,
  "needCitations": true,
  "needSourceList": true,
  "liveAccess": true
}
```

Output schema:

```json
{
  "ok": true,
  "toolName": "web_research",
  "provider": "openai-responses-web_search",
  "model": "gpt-5.4-mini",
  "query": "latest Android Gradle plugin version official docs",
  "answer": "The official docs currently recommend ...",
  "citations": [
    {
      "title": "Android Gradle plugin release notes",
      "url": "https://developer.android.com/build/releases/gradle-plugin",
      "supports": "recommended version"
    }
  ],
  "sources": [
    {
      "title": "Android Gradle plugin release notes",
      "url": "https://developer.android.com/build/releases/gradle-plugin",
      "sourceType": "official-docs"
    }
  ],
  "confidence": "medium",
  "uncertainties": [],
  "fetchedAt": "2026-05-06T00:00:00.000Z"
}
```

Important behavior:

- Prefer official sources for SDKs, APIs, standards, medicine, law, finance, and package documentation.
- Preserve visible source URLs in CLI/web UI.
- Save source lists in session artifacts even if final answer is concise.
- For high-stakes or unstable information, require citations.
- For current docs, prefer direct official documentation over search-engine snippets.

### Layer 3: `multimodal_wrapper`

Purpose: use Codex or another external agent as a typed, read-only helper for image reading, web research, or combined tasks.

Recommended default:

```bash
AGINTI_WRAPPER_MODEL=gpt-5.4-mini
AGINTI_WRAPPER_REASONING=medium
aginti --allow-wrapper-tools ...
```

This is useful because the existing Codex wrapper is already sandboxed read-only and can be configured through environment variables. However, the current generic `delegate_agent` contract is too loose for image and web tasks. A dedicated wrapper contract is better.

Input schema:

```json
{
  "task": "image_read|web_research|combined",
  "question": "Does this screenshot show the expected Android app screen?",
  "images": [
    {
      "path": "artifacts/screenshots/tipsplit-home.png",
      "sha256": "..."
    }
  ],
  "searchQueries": [
    {
      "query": "official Android emulator screenshot adb screencap documentation",
      "allowedDomains": ["developer.android.com"]
    }
  ],
  "requiredOutputSchema": "aginti.multimodal_wrapper.v1"
}
```

Output schema:

```json
{
  "ok": true,
  "toolName": "multimodal_wrapper",
  "wrapper": "codex",
  "model": "gpt-5.4-mini",
  "reasoning": "medium",
  "task": "combined",
  "result": {
    "summary": "...",
    "observations": [],
    "citations": [],
    "uncertainties": []
  },
  "rawTranscriptPath": "~/.agintiflow/sessions/<session-id>/artifacts/wrappers/codex-....txt",
  "warnings": [
    "Advisory wrapper result. AgInTiFlow must verify file paths and citations before marking task complete."
  ]
}
```

Wrapper restrictions:

- Read-only sandbox.
- No file writes.
- No installs.
- No shell mutations.
- No secret access.
- Must return JSON or a clearly parseable block.
- AgInTiFlow must validate paths/citations independently before using the wrapper result as evidence.

## Why Not Only Use Codex Wrapper?

Using Codex `gpt-5.4-mini medium` as a wrapper is useful, but it should not be the primary only path.

Pros:

- Fast to add because AgInTiFlow already has wrapper plumbing.
- Codex can combine image reading, web search, and code reasoning in one helper.
- Useful as a second opinion for screenshots, UI reviews, docs lookup, and generated artifact checks.
- Keeps DeepSeek route/main cheap while using OpenAI only for perception/research.

Cons:

- Shelling out to another agent is slower and less deterministic than one API tool call.
- Output is harder to validate unless forced into a schema.
- Wrapper availability depends on the local `codex` CLI and user account.
- If the wrapper does its own web search, AgInTiFlow may not automatically know all consulted sources unless the wrapper reports them.
- Image paths and attachments need explicit implementation. Passing only text paths to Codex is not enough unless the wrapper command attaches or embeds the image.

Conclusion: add native `read_image` and `web_research`; keep Codex wrapper as optional `multimodal_wrapper`.

## Proposed User Commands

Interactive commands:

```text
/image-read artifacts/screenshots/app.png
/image-read artifacts/screenshots/app.png What looks broken?
/web-research latest Android Gradle plugin official docs
/research-wrapper codex/gpt-5.4-mini medium
/research-wrapper off
```

Non-interactive examples:

```bash
aginti --allow-file-tools --allow-web-search \
  "Read artifacts/screenshots/app.png, identify UI issues, then search official Android docs if needed."

AGINTI_PERCEPTION_MODEL=gpt-5.4-mini \
AGINTI_PERCEPTION_REASONING=medium \
aginti --allow-file-tools "Read this screenshot and write reports/screenshot-review.md."

AGINTI_WRAPPER_MODEL=gpt-5.4-mini \
AGINTI_WRAPPER_REASONING=medium \
aginti --allow-wrapper-tools "Use the wrapper only as a second opinion for this screenshot review."
```

## Routing Policy

Default behavior:

- Cheap DeepSeek route model decides whether visual or web evidence is needed.
- Main model plans and executes ordinary project work.
- `read_image` is called when a local image/screenshot/figure/artifact needs understanding.
- `web_research` is called when current or externally sourced information matters.
- `multimodal_wrapper` is called only when native evidence is insufficient, a second opinion is requested, or a policy/profile asks for wrapper cross-check.

Suggested profile behavior:

| Profile | Image behavior | Web behavior | Wrapper behavior |
| --- | --- | --- | --- |
| `auto` | Use `read_image` when image paths/artifacts are in task | Use `web_research` for unstable/current info | Wrapper only when complex or uncertain |
| `code` | Screenshots, UI diffs, error images | Official docs and package errors | Cross-check hard bug diagnosis |
| `research` | Figures, plots, scanned tables | Citations required | Optional second opinion |
| `image` | Describe/edit/generate loop | Search references if requested | Optional creative critique |
| `aaps` | Validate visual artifacts from workflow | Source workflow/tool docs | Cross-check missing-output diagnosis |
| `supervision` | Verify student-created screenshots | Verify claimed external facts | Use wrapper to audit false completion |

## Storage And Evidence

Every call should write a durable artifact:

```text
~/.agintiflow/sessions/<session-id>/artifacts/perception/<timestamp>-read-image.json
~/.agintiflow/sessions/<session-id>/artifacts/research/<timestamp>-web-research.json
~/.agintiflow/sessions/<session-id>/artifacts/wrappers/<timestamp>-codex-multimodal.json
```

Project-local files can link to these artifacts when useful, but canonical evidence should remain under the session.

Minimum event fields:

```json
{
  "type": "tool_result",
  "toolName": "read_image",
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "inputImages": [{"path": "...", "sha256": "..."}],
  "artifactPath": "artifacts/perception/...",
  "ok": true
}
```

## Security And Privacy

Image reading and web search can leak sensitive context if implemented loosely.

Guardrails:

- Block `.env`, key stores, token files, private documents, and secret screenshots unless explicitly approved.
- Redact token-like text from prompts, logs, and outputs.
- Avoid uploading raw files outside the workspace unless the user selected a more permissive mode.
- Hash images before upload and record the hash.
- Cap image dimensions and file size.
- Strip EXIF metadata where possible.
- Store source URLs and citations, but avoid saving full copyrighted pages unless necessary and allowed.
- For web search, support domain allowlists and "official sources only" mode.

## Implementation Roadmap

### Current Implementation Status

Implemented in the first production slice:

- `src/perception-tools.js` with `read_image`, `web_research`, and `research_wrapper`.
- `read_image` validates workspace/remote image inputs, caps size/count, records MIME/size/sha256, calls OpenAI Responses vision when `OPENAI_API_KEY` is configured, and persists central session artifacts under `artifacts/perception/`.
- `web_research` wraps the existing lightweight DuckDuckGo snippet search and can use hosted OpenAI web search with `mode=openai`; artifacts are persisted under `artifacts/research/`.
- `research_wrapper` calls the selected read-only wrapper with a strict JSON contract and defaults to `gpt-5.4-mini` with `medium` reasoning via `AGINTI_RESEARCH_WRAPPER_MODEL` / `AGINTI_RESEARCH_WRAPPER_REASONING`; artifacts are persisted under `artifacts/wrappers/`.
- Agent tool schemas, guardrails, session events, interactive commands, README/docs, and a smoke test are wired.

Still planned:

- Web UI "Ask about this image" action on artifact previews.
- Real OCR/screenshot/microscopy regression fixtures when provider keys are available in CI or a local TDV campaign.
- More structured OpenAI web-search citation extraction if upstream response schemas change.

### Phase 1: Documentation And Contracts

- Add this design note.
- Add schema examples to `docs/skills-and-tools.md`.
- Add a short README note that image reading is planned separately from image generation.

### Phase 2: Native `read_image`

- Add `src/perception-tools.js`.
- Add `readImage(args, config)` with local path validation, MIME/size checks, base64/data URL conversion, OpenAI Responses or Chat Completions call, JSON schema prompt, and artifact persistence.
- Expose tool schema in `src/model-client.js`.
- Handle results in `src/agent-runner.js`.
- Add `/image-read` command in `src/interactive-cli.js`.
- Add web UI action: "Ask about this image" on artifact previews.

### Phase 3: Native `web_research`

- Keep existing `web_search` for raw search snippets.
- Add `web_research` as the sourced answer layer.
- Implement provider modes:
  - `duckduckgo-snippets`
  - `openai-responses-web_search`
  - `wrapper`
- Persist citations and source lists.
- Add domain-filter controls.

### Phase 4: Dedicated `multimodal_wrapper`

- Do not overload generic `delegate_agent`.
- Add a specific wrapper mode with strict JSON output and evidence warnings.
- Support `codex/gpt-5.4-mini medium` as a configurable default for this wrapper, separate from coding-wrapper defaults.
- Preserve raw transcript and normalized JSON artifact.

### Phase 5: Tests

Test cases:

- OCR screenshot: read text from a CLI screenshot and verify expected strings.
- UI screenshot: identify visible layout issues and preserve uncertainty.
- Plot/figure: summarize axes, trend, and caveats.
- Scientific image: describe visible morphology without overclaiming diagnosis.
- Web docs: answer from official docs with visible URLs.
- Domain filter: only search allowed domains.
- Wrapper unavailable: return useful setup instruction, not crash.
- Secret image/path: block or ask permission.
- False completion: if image file or source URL is missing, do not mark success.

## Final Recommendation

Use Codex/OpenAI `gpt-5.4-mini medium` as a perception/research wrapper, but implement native `read_image` and `web_research` as first-class AgInTiFlow tools.

The most robust design is:

```text
DeepSeek route/main -> decide and work cheaply
read_image -> direct typed visual evidence
web_research -> direct typed sourced evidence
multimodal_wrapper -> optional Codex/OpenAI second opinion
AgInTiFlow runtime -> final evidence, storage, policy, and UI
```

This keeps AgInTiFlow low-cost and provider-flexible while making image reading and web search inspectable, durable, and safe enough for real project work.
