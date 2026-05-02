# Venice Model Reference

Captured from the user-provided Venice/GRS model catalog on 2026-05-02. This file intentionally stores model names and public pricing notes only. It must never contain API keys or local `.env` values.

## Runtime Environment

AgInTiFlow treats Venice as an OpenAI-compatible provider for text/chat work:

```env
VENICE_API_BASE=https://api.venice.ai/api/v1
VENICE_CHAT_ENDPOINT=/chat/completions
VENICE_MODEL=venice-uncensored-1-2
VENICE_IMAGE_MODEL=nano-banana-2
```

Store `VENICE_API_KEY` only in ignored local files such as `.aginti/.env` or a shell environment.

## Recommended Text Buckets

| Bucket | Primary model | Other useful models | Use |
|---|---|---|---|
| `venice-uncensored` | `venice-uncensored-1-2` | `e2ee-venice-uncensored-24b-p`, `venice-uncensored-role-play`, `venice-uncensored` legacy | Private/uncensored Venice-native text route |
| `venice-gemma` | `gemma-4-uncensored` | `google-gemma-4-31b-it`, `google-gemma-4-26b-a4b-it` | Low-cost open-model writing and experimentation |
| `venice-qwen` | `qwen3-6-27b` | `qwen-3-6-plus`, `qwen3-coder-480b-a35b-instruct-turbo`, `qwen3-vl-235b-a22b` | Chinese/open coding and general tasks |
| `venice-gpt` | `openai-gpt-55` | `openai-gpt-54`, `openai-gpt-54-mini`, `openai-gpt-53-codex`, `openai-gpt-53-codex-spark` | OpenAI-family routes through Venice |
| `venice-claude` | `claude-sonnet-4-6` | `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5` | Claude-family routes through Venice |

## Selected Text Models

| Model | Context | Notes |
|---|---:|---|
| `qwen3-6-27b` | 256K | Qwen 3.6 27B |
| `deepseek-v4-pro` | 1.0M | DeepSeek V4 Pro |
| `deepseek-v4-flash` | 1.0M | DeepSeek V4 Flash |
| `openai-gpt-55-pro` | 1.0M | GPT-5.5 Pro |
| `e2ee-glm-5-1` | 200K | GLM 5.1 E2EE |
| `openai-gpt-55` | 1.0M | GPT-5.5 |
| `kimi-k2-6` | 256K | Kimi K2.6 |
| `grok-4-3` | 1.0M | Grok 4.3 |
| `claude-opus-4-7` | 1.0M | Claude Opus 4.7 |
| `gemma-4-uncensored` | 256K | Gemma 4 Uncensored |
| `qwen-3-6-plus` | 1.0M | Qwen 3.6 Plus Uncensored |
| `google-gemma-4-31b-it` | 256K | Google Gemma 4 31B Instruct |
| `google-gemma-4-26b-a4b-it` | 256K | Google Gemma 4 26B A4B Instruct |
| `venice-uncensored-1-2` | 128K | Venice Uncensored 1.2 |
| `openai-gpt-54-mini` | 400K | GPT-5.4 Mini |
| `e2ee-venice-uncensored-24b-p` | 32K | Venice Uncensored 1.1 E2EE |
| `venice-uncensored-role-play` | 128K | Venice Role Play Uncensored |
| `gemini-3-1-pro-preview` | 1.0M | Gemini 3.1 Pro Preview |
| `claude-sonnet-4-6` | 1.0M | Claude Sonnet 4.6 |
| `openai-gpt-53-codex` | 400K | GPT-5.3 Codex |
| `openai-gpt-52` | 256K | GPT-5.2 |
| `venice-uncensored` | 32K | Venice Uncensored legacy / deprecated |

AgInTiFlow exposes the primary Venice text choices through `/venice`: Venice 1.2 (`venice-uncensored-1-2`), Venice 1.1 (`e2ee-venice-uncensored-24b-p`), and Gemma 4 (`gemma-4-uncensored`). The command can select route and main independently, so a fast Venice route can be paired with a larger Gemma main model when useful. The older `venice-uncensored` ID is retained only as a legacy alias.

## Image And Edit Models

| Model | Type | Price note |
|---|---|---|
| `wan-2-7-pro-edit` | inpaint | $0.09/edit |
| `gpt-image-2` | image | $0.27/image |
| `gpt-image-2-edit` | inpaint | $0.36/edit |
| `grok-imagine-image` | image | $0.03/image |
| `grok-imagine-image-pro` | image | $0.09/image |
| `wan-2-7-text-to-image` | image | $0.04/image |
| `wan-2-7-pro-text-to-image` | image | $0.09/image |
| `lustify-v8` | image | $0.01/image |
| `firered-image-edit` | inpaint | $0.04/edit |
| `qwen-image-2` | image | $0.05/image |
| `qwen-image-2-pro` | image | $0.10/image |
| `qwen-image-2-edit` | inpaint | $0.05/edit |
| `qwen-image-2-pro-edit` | inpaint | $0.10/edit |
| `hunyuan-image-v3` | image | $0.09/image |
| `nano-banana-2` | image | $0.10/image |
| `bria-bg-remover` | image | $0.03/image |
| `nano-banana-2-edit` | inpaint | $0.10/edit |
| `seedream-v5-lite` | image | $0.05/image |
| `seedream-v5-lite-edit` | inpaint | $0.05/edit |
| `recraft-v4` | image | $0.05/image |
| `recraft-v4-pro` | image | $0.29/image |
| `chroma` | image | $0.01/image |
| `grok-imagine-edit` | inpaint | $0.03/edit |
| `imagineart-1.5-pro` | image | $0.06/image |
| `flux-2-max-edit` | inpaint | $0.19/edit |
| `gpt-image-1-5-edit` | inpaint | $0.36/edit |
| `seedream-v4-edit` | inpaint | $0.05/edit |
| `gpt-image-1-5` | image | $0.26/image |
| `nano-banana-pro-edit` | inpaint | $0.18/edit |
| `z-image-turbo` | image | $0.01/image |
| `flux-2-pro` | image | $0.04/image |
| `flux-2-max` | image | $0.09/image |
| `nano-banana-pro` | image | $0.18/image |
| `seedream-v4` | image | $0.05/image |
| `qwen-edit` | inpaint | $0.04/edit |
| `hidream` | image | $0.01/image |
| `upscaler` | upscale | $0.02 2x, $0.08 4x |
| `venice-sd35` | image | $0.01/image |
| `lustify-sdxl` | image | $0.01/image |
| `lustify-v7` | image | $0.01/image |
| `qwen-image` | image | $0.01/image |
| `wai-Illustrious` | image | $0.01/image |

## AgInTiFlow Usage

Use Venice as the primary manual model:

```bash
aginti --provider venice --routing manual --model venice-uncensored-1-2 "write a project note"
```

Use Venice image models through the auxiliary image tool:

```bash
aginti --image --allow-auxiliary-tools "generate a bright clean logo concept using Venice image models"
```

For smart coding, keep the default DeepSeek route unless the user explicitly selects Venice:

```bash
aginti --routing smart "fix this repository and run tests"
```
