# Model Selection

AgInTiFlow treats model choice as a role-based control plane. A provider supplies models; a role decides how the agent uses one.

## Default Roles

| Role | CLI command | Default | Purpose |
| --- | --- | --- | --- |
| Route | `/route` | `deepseek/deepseek-v4-flash` | Fast planner, triage, short tasks, and routing decisions. |
| Main | `/model` or `/main` | `deepseek/deepseek-v4-pro` | Complex executor for coding, debugging, writing, and long tasks. |
| Spare | `/spare` | `openai/gpt-5.4` with `medium` reasoning | Optional fallback or cross-check model. |
| Wrapper | `/wrapper` | `codex gpt-5.5 medium` | External coding assistant when wrapper tools are enabled. |
| Auxiliary | `/auxiliary` | `grsai/nano-banana-2` | Image/media tools; Venice image models are optional. |

Smart routing still works as before: normal work goes to the route model, and complex work goes to the main model. Manual provider/model selection remains available for one-off runs.

## CLI Commands

```bash
aginti models
aginti --list-models
aginti --list-routes

# one-shot overrides
aginti --route-model deepseek-v4-flash --main-model deepseek-v4-pro "fix this project"
aginti --provider venice --model venice-uncensored-1-2 --routing manual "draft a note"
aginti --spare-provider openai --spare-model gpt-5.4 --spare-reasoning medium "review this design"
aginti --allow-wrappers --wrapper codex --wrapper-model gpt-5.5 "patch this bug"
aginti --image --aux-provider venice --aux-model gpt-image-2 "generate a logo"
```

Interactive commands:

```text
/models
/provider
/venice
/venice off
/route
/model
/spare
/route deepseek/deepseek-v4-flash
/model deepseek/deepseek-v4-pro
/spare openai/gpt-5.4 medium
/wrapper codex gpt-5.5 medium
/auxiliary model grsai/nano-banana-2
```

In the interactive CLI, `/provider`, `/route`, `/model`, `/spare`, and `/auxiliary model` without arguments open selectors. Use Up/Down/Left/Right to move through choices, Enter to confirm, and Esc to cancel. Slash-command hints use the same arrow selection behavior: type a prefix such as `/mo`, use arrows to choose `/model` or `/models`, then press Enter or Tab.

`/route`, `/model`, and `/spare` intentionally share the same text-model selector so users do not need to learn three different catalogs. The selector is hierarchical:

1. Choose a provider family.
2. Choose the model in that family.
3. For OpenAI models, choose reasoning effort: `low`, `medium`, `high`, or `xhigh`.

Provider families:

| Family | Models |
| --- | --- |
| DeepSeek | `deepseek-v4-flash`, `deepseek-v4-pro` |
| Venice | `venice-uncensored-1-2`, `venice-uncensored`, `gemma-4-uncensored` |
| OpenAI | `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`; each has low/medium/high/xhigh reasoning |
| Venice GPT | GPT-family Venice routes such as `openai-gpt-55`, `openai-gpt-54`, `openai-gpt-54-mini`, `openai-gpt-53-codex`, `openai-gpt-52` |
| Venice Gemma | Gemma instruct routes such as `google-gemma-4-31b-it`, `google-gemma-4-26b-a4b-it`, `google-gemma-3-27b-it` |
| Venice Claude | Claude Sonnet/Opus routes such as `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-opus-4-6` |
| Venice Qwen | Qwen routes such as `qwen3-6-27b`, `qwen-3-6-plus`, `qwen3-coder-480b-a35b-instruct-turbo` |
| Qwen | `qwen-plus`, `qwen-turbo`, `qwen-max` |
| Mock | `mock-agent` |

`/venice` opens a two-step selector for the Venice route and main models. The current text choices are:

```text
venice/venice-uncensored-1-2
venice/venice-uncensored
venice/gemma-4-uncensored
Disable Venice
```

For scripts or non-interactive terminals, `/venice` uses Venice 1.2 for both roles. You can also set both roles directly with `/venice 1.2`, `/venice 1.1`, or `/venice gemma`. Use two values to set route and main separately, for example `/venice 1.2 gemma`.

Use `/venice off` to switch back to the DeepSeek defaults:

```text
/route deepseek/deepseek-v4-flash
/model deepseek/deepseek-v4-pro
```

It keeps smart routing enabled. If the Venice key is missing, run `/auth venice`.

## Provider Buckets

| Bucket | Provider | Typical use |
| --- | --- | --- |
| `deepseek` | DeepSeek | Default route/main because V4 Flash and V4 Pro are cheap and strong. |
| `openai` | OpenAI | Spare/frontier checks, Codex-family work, and explicit manual routes. |
| `qwen` | Qwen | Chinese and general-purpose OpenAI-compatible tasks. |
| `venice` | Venice | Venice-native text shortcuts: Venice 1.2, Venice 1.1, and Gemma 4 Uncensored. |
| `venice-gpt` | Venice | GPT-family models through Venice. |
| `venice-claude` | Venice | Claude-family models through Venice. |
| `venice-gemma` | Venice | Gemma instruct models through Venice, excluding the Gemma 4 Uncensored shortcut. |
| `venice-qwen` | Venice | Qwen-family models through Venice. |
| `venice-image` | Venice | Image generation/editing such as Nano Banana, GPT Image, Wan, Qwen Image. |
| `grsai` | GRS AI | Auxiliary image generation only. |

`/auxiliary model` uses the same two-level pattern for image tools:

| Family | Models |
| --- | --- |
| GRS AI | `nano-banana-2`, `nano-banana-2-edit`, `gpt-image-2`, `gpt-image-2-edit` when the configured GRS AI-compatible endpoint supports them |
| Venice Image | `wan-2-7-pro-edit`, `nano-banana-2`, `gpt-image-2`, `grok-imagine-image`, `qwen-image-2-pro`, `bria-bg-remover`, `recraft-v4`, `flux-2-pro`, and related image/edit routes |

## Keys

Keys are set per project and stored only in ignored `.aginti/.env`:

```bash
aginti auth
aginti auth venice
aginti keys status
printf '%s' "$VENICE_API_KEY" | aginti keys set venice --stdin
```

The web UI mirrors the same roles with dropdowns. Keep the left panel for daily controls: routing policy, provider/model, profile, goal, workspace, sandbox, and common tools. Use **Advanced settings** for model roles, browser start URL, wrapper/scout settings, Docker image, password/destructive toggles, and auxiliary image models. Runtime logs stay in the right column, followed by wrapper, workspace, and sandbox capability panels.
