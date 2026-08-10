# Model Routing And Provider Design

AgInTiFlow should expose model choice as a control plane, not a single strict model setting.

## Default Route

The sibling LocalLLM gateway is the default smart-route backend:

| Route | Provider | Model | Purpose |
|---|---|---|---|
| `fast` | LocalLLM | `localllm-fast` | normal browser, shell, short code edits |
| `complex` | LocalLLM | `localllm-deep` | multi-file coding, debugging, design, system setup |
| `manual` | selected provider | selected model | explicit DeepSeek/OpenAI/OpenRouter/Qwen/Venice/mock runs |

If the user selects a hosted provider, AgInTiFlow treats that as an explicit manual upgrade even when the UI still shows a smart policy. Local provider failure never triggers a hidden cloud fallback.

## Role-Based Model Sections

The UI should be role-first rather than provider-first:

- **Route model (`/route`):** fast planner and triage model. Default `localllm/localllm-fast`.
- **Main model (`/model` or `/main`):** complex executor. Default `localllm/localllm-deep`.
- **Spare model (`/spare`):** optional manually selected cross-check model. Local-first default `localllm/localllm-deep` with `medium` reasoning; a hosted spare must be selected explicitly and is never an automatic fallback.
- **Wrapper (`/wrapper`):** external coding assistant. Default Codex with `gpt-5.5` medium reasoning, disabled unless wrapper tools are enabled.
- **Auxiliary (`/auxiliary`):** media/image tools. Default model `grsai/nano-banana-2`, disabled unless auxiliary tools are explicitly enabled; Venice image models are optional.

Writing has a separate tool boundary rather than a separate always-on agent identity:

- **`writing_specialist`:** isolated prose/argument/scene drafting. It receives only writing brief, canon, style guide, prior draft, target, audience, constraints, length, and downstream format intent.
- **Main agent:** owns project state, files, formatting, shell/browser/tool policy, citations, LaTeX/PDF compilation, canvas artifacts, and final verification.

This protects writing quality from agent-side context overload. The writer should not be told about shell tools, file tools, routing policy, guardrails, Docker, or browser state unless the user explicitly needs those details inside the text itself.

The specialist follows the active provider/model by default. A hosted writer requires both an explicit target (`AGINTI_WRITING_PROVIDER` or a per-run provider override) and `AGINTI_ALLOW_HOSTED_WRITING_SPECIALIST=true` (or the equivalent per-run permission flag); ambient keys and language detection must not change the provider.

This keeps the mental model stable: providers are supply, roles are policy.

## Current Commands

```bash
aginti models
aginti --list-models
aginti --list-routes
aginti --route-model localllm-fast --main-model localllm-deep "fix this project"
aginti --spare-provider openai --spare-model gpt-5.4 --spare-reasoning medium "review this patch"
aginti --allow-wrappers --wrapper codex --wrapper-model gpt-5.5 "use Codex as a helper"
aginti --image --aux-provider venice --aux-model gpt-image-2 "generate an image"
```

Interactive equivalents:

```text
/models
/provider
/venice
/venice off
/route localllm/localllm-fast
/model localllm/localllm-deep
/spare
/spare openai/gpt-5.4 medium
/wrapper codex gpt-5.5 medium
/auxiliary model grsai/nano-banana-2
```

`/route`, `/model`, and `/spare` share a single text-model selector. It includes LocalLLM, DeepSeek, OpenAI, OpenRouter subfamilies, Venice text subfamilies, Qwen, and Mock so the user sees the same union of route/main/spare-capable models in every role. See the current catalog in [Model Selection](../docs/model-selection.md).

Interactive selectors are hierarchical. Enter moves forward or confirms. Esc cancels only at the first level; at model/reasoning levels it returns to the previous selector instead of dropping the whole flow.

`/venice` opens a route/main selector for Venice text models. The selector includes `venice/venice-uncensored-1-2` (Venice 1.2), `venice/venice-uncensored` (Venice 1.1), `venice/gemma-4-uncensored` (Gemma 4), and a Disable Venice option. In non-interactive shells, `/venice` keeps script compatibility by selecting `venice/venice-uncensored-1-2` for both roles. `/venice 1.2 gemma` sets route to Venice 1.2 and main to Gemma 4; `/venice off` or the Disable Venice selector option restores `localllm/localllm-fast` for route and `localllm/localllm-deep` for main.

The web UI should expose model names as dropdowns, not free-text fields. The left panel should stay focused on common daily controls, while model-role editing and less-used switches live in an Advanced settings modal. The terminal-like capability panels belong after the runtime log so the left control panel remains short.

## OpenAI Model Reference

| Model | Role | Reasoning |
|---|---|---|
| `gpt-5.5` | frontier coding/research | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4` | everyday coding | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4-mini` | fast spare | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.3-codex` | coding optimized | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.3-codex-spark` | ultra-fast coding | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.2` | long-running professional work | `low`, `medium`, `high`, `xhigh` |

Codex wrapper defaults stay separate from native OpenAI API settings: GPT-5.5 medium as primary and GPT-5.4-mini high as spare.

## Venice Model Buckets

| UI bucket | Concrete default | Notes |
|---|---|---|
| `venice-uncensored` | `venice-uncensored-1-2` | Venice-native text; `/venice` also exposes `venice-uncensored` as Venice 1.1 |
| `venice-qwen` | `qwen3-6-27b` | Qwen-family text/code |
| `venice-gpt` | `openai-gpt-55` | OpenAI-family through Venice |
| `venice-claude` | `claude-sonnet-4-6` | Claude-family through Venice |
| `venice-gemma` | `gemma-4-uncensored` | Gemma-family route |

## Credential Rules

Never commit provider keys. Accepted local variables:

```env
LOCALLLM_BASE_URL=http://127.0.0.1:8008/v1
LOCALLLM_API_KEY=local-dev-key
AGINTI_LOCALLLM_ROUTE_MODEL=localllm-fast
AGINTI_LOCALLLM_MAIN_MODEL=localllm-deep
AGINTI_WRITING_PROVIDER=
AGINTI_WRITING_MODEL=
AGINTI_ALLOW_HOSTED_WRITING_SPECIALIST=false
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
QWEN_API_KEY=
VENICE_API_KEY=
VENICE_API_BASE=https://api.venice.ai/api/v1
VENICE_MODEL=venice-uncensored-1-2
VENICE_IMAGE_MODEL=nano-banana-2
GRSAI=
```

AgInTiFlow owns plans, session state, tool validation and dispatch, evidence, retries, and compaction. LocalLLM is a stateless OpenAI-compatible inference dependency. See [the local-first runtime contract](../docs/local-first-agent-runtime.md).

`aginti auth venice` and `aginti keys set venice --stdin` save account-wide to ignored `~/.agintiflow/.env` with `0600` permissions by default. Add `--project` when the key should instead be an override in ignored `.aginti/.env`.
