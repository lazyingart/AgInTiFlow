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

## Provider Sections

The web UI should show three ideas clearly:

- **Route:** smart, fast, complex, or manual.
- **Primary:** the provider/model currently used for the next run.
- **Secondary:** the fallback/escalation route, usually DeepSeek V4 Pro or a wrapper such as Codex.

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
| `venice-uncensored` | `venice-uncensored-1-2` | Venice-native text |
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
