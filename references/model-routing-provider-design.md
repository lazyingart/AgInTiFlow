# Model Routing And Provider Design

AgInTiFlow should expose model choice as a control plane, not a single strict model setting.

## Default Route

DeepSeek remains the default smart-route backend:

| Route | Provider | Model | Purpose |
|---|---|---|---|
| `fast` | DeepSeek | `deepseek-v4-flash` | normal browser, shell, short code edits |
| `complex` | DeepSeek | `deepseek-v4-pro` | multi-file coding, debugging, design, system setup |
| `manual` | selected provider | selected model | explicit OpenAI/Qwen/Venice/mock runs |

If the user selects OpenAI, Qwen, or Venice as the provider, AgInTiFlow treats that as the primary manual provider even when the UI still shows a smart policy. This makes provider selection predictable while preserving DeepSeek as the default.

## Role-Based Model Sections

The UI should be role-first rather than provider-first:

- **Route model (`/route`):** fast planner and triage model. Default `deepseek/deepseek-v4-flash`.
- **Main model (`/model` or `/main`):** complex executor. Default `deepseek/deepseek-v4-pro`.
- **Spare model (`/spare`):** fallback/cross-check model. Default `openai/gpt-5.4` with `medium` reasoning.
- **Wrapper (`/wrapper`):** external coding assistant. Default Codex with `gpt-5.5` medium reasoning, disabled unless wrapper tools are enabled.
- **Auxiliary (`/auxiliary`):** media/image tools. Default `grsai/nano-banana-2`; Venice image models are optional.

This keeps the mental model stable: providers are supply, roles are policy.

## Current Commands

```bash
aginti models
aginti --list-models
aginti --list-routes
aginti --route-model deepseek-v4-flash --main-model deepseek-v4-pro "fix this project"
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
/route deepseek/deepseek-v4-flash
/model deepseek/deepseek-v4-pro
/spare
/spare openai/gpt-5.4 medium
/wrapper codex gpt-5.5 medium
/auxiliary model grsai/nano-banana-2
```

`/venice` opens a route/main selector for Venice text models. The selector includes `venice/venice-uncensored-1-2` (Venice 1.2), `venice/venice-uncensored` (Venice 1.1), and `venice/gemma-4-uncensored` (Gemma 4). In non-interactive shells, `/venice` keeps script compatibility by selecting `venice/venice-uncensored-1-2` for both roles. `/venice 1.2 gemma` sets route to Venice 1.2 and main to Gemma 4; `/venice off` restores `deepseek/deepseek-v4-flash` for route and `deepseek/deepseek-v4-pro` for main.

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
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
QWEN_API_KEY=
VENICE_API_KEY=
VENICE_API_BASE=https://api.venice.ai/api/v1
VENICE_MODEL=venice-uncensored-1-2
VENICE_IMAGE_MODEL=nano-banana-2
GRSAI=
```

`aginti auth venice` and `aginti keys set venice --stdin` save only to ignored `.aginti/.env` with `0600` permissions.
