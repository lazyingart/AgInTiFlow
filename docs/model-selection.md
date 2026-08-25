# Model Selection

AgInTiFlow treats model choice as a role-based control plane. A provider supplies models; a role decides how the agent uses one.

## Default Roles

| Role | CLI command | Default | Purpose |
| --- | --- | --- | --- |
| Route | `/route` | `localllm/localllm-fast` | Local fast planner, triage, short tasks, and routing decisions. |
| Main | `/model` or `/main` | `localllm/localllm-deep` | Local complex executor for coding, debugging, writing, and long tasks. |
| Spare | `/spare` | `localllm/localllm-deep` with `medium` reasoning | Local cross-check lane; hosted spares require explicit selection. |
| Wrapper | `/wrapper` | `codex gpt-5.5 medium` | External coding assistant when wrapper tools are enabled. |
| Auxiliary | `/auxiliary` | `grsai/nano-banana-2` (tool off) | Explicitly enabled image/media tools; Venice image models are optional. |

Smart routing sends normal work to the LocalLLM route model and complex work to the LocalLLM main model. Manual hosted provider/model selection remains available for explicit one-off upgrades. A local error fails closed instead of changing providers.

The local tier policy uses the workstation's installed aliases without treating model presence as permission to load a heavy model:

| Alias | Installed role | Automatic policy |
| --- | --- | --- |
| `localllm-fast` | Qwen3 8B Q4 routing and bounded work | Default for simple work. |
| `localllm-deep` | Qwen3 30B-A3B Q4 substantive coding/agent work | Default for complex work. |
| `localllm-code` | Provider-neutral coding capability (the sibling catalog currently maps it to Qwen3-Coder 30B-A3B Q4) | Smart selection only for high-confidence implementation work and only after authenticated availability; otherwise Deep. |
| `localllm-max` | Qwen3 30B-A3B Q8 highest-fidelity local text/code | Explicit selection; automatic use additionally requires opt-in, authenticated availability, fresh resource readiness, and no shared-workstation pressure. |
| `localllm-vision-xl` | Qwen3-VL 30B-A3B Q4 image understanding | The automatic policy requires a trusted image-input signal plus confirmed capability. The shipped CLI/web currently use readiness-checked `read_image` or explicit selection; prompt keywords alone do not activate it. |

Installed aliases are not loaded during routing. A genuine coding/implementation request starts on Deep, checks the authenticated model inventory, and selects the exact `AGINTI_LOCALLLM_CODE_MODEL` value only when present. Missing or unverified capability stays on Deep; the decision and effective model are recorded so fallback sessions can re-evaluate and selected sessions resume on the same model. Explanation-only code questions and non-code writing/research/documentation/design keep their existing route. Automatic Max is off by default; set `AGINTI_LOCALLLM_ALLOW_AUTO_MAX=true` to opt in. An opted-in high-complexity non-code run starts on Deep, confirms the Max alias through authenticated `/v1/models`, and only then samples current resources. Unknown or pressured resource state stays on Deep. Explicit Max also cannot bypass the live gate: immediately before client creation, each new or resumed run rechecks at least 24 GiB available RAM, swap use at or below 75%, and 40 GiB aggregate free NVIDIA memory. A blocked explicit gate creates no model client and performs no inference.

Smart hosted routes fail over only toward the local trust boundary. If a hosted provider returns an authentication, quota, rate-limit, model-availability, capacity, or network failure, AgInTiFlow records `provider.handoff_requested`, patches the same durable session to `localllm-deep`, verifies LocalLLM readiness, records `provider.handoff_activated`, and continues without replaying the user request or prior side effects. Manual routing remains exact and never changes provider automatically. Retained integration profiles also keep their pinned provider identity. Set `AGINTI_PROVIDER_HANDOFF=false` to disable the smart hosted-to-local handoff or `AGINTI_PROVIDER_HANDOFF_MODEL` to select another verified local fallback model.

Long writing tasks use an additional tool boundary: `writing_specialist`. The main model still plans the run, manages files, formats Markdown/LaTeX/Final Draft output, compiles/checks artifacts, and finishes. The specialist gets only the writing brief, canon, style guide, prior draft, target, audience, constraints, and format intent, then returns prose plus a formatter handoff. It follows the active LocalLLM provider by default even when hosted keys exist. Cross-provider writing requires both an explicit target (`AGINTI_WRITING_PROVIDER` or a per-run provider override) and `AGINTI_ALLOW_HOSTED_WRITING_SPECIALIST=true` (or the equivalent per-run permission flag); language detection and ambient credentials never grant that permission.

## CLI Commands

```bash
aginti models
aginti --list-models
aginti --list-routes

# local-first defaults and one-shot overrides
aginti --route-model localllm-fast --main-model localllm-deep "fix this project"
aginti --provider openrouter --model openrouter/auto --routing manual "try a gateway route"
aginti --provider openrouter --model anthropic/claude-sonnet-4.6 --routing manual "draft a design review"
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
/route localllm/localllm-fast
/model localllm/localllm-deep
/route deepseek/deepseek-v4-flash
/model deepseek/deepseek-v4-pro
/spare openai/gpt-5.4 medium
/wrapper codex gpt-5.5 medium
/auxiliary model grsai/nano-banana-2
```

In the interactive CLI, `/provider`, `/route`, `/model`, `/spare`, and `/auxiliary model` without arguments open selectors. Use Up/Down/Left/Right to move through choices and Enter to confirm. Esc cancels at the top level; inside multi-level selectors it goes back one level. Slash-command hints use the same arrow selection behavior: type a prefix such as `/mo`, use arrows to choose `/model` or `/models`, then press Enter or Tab.

`/route`, `/model`, and `/spare` intentionally share the same text-model selector so users do not need to learn three different catalogs. The selector is hierarchical:

1. Choose a provider family.
2. Choose the model in that family.
3. For OpenAI models, choose reasoning effort: `low`, `medium`, `high`, or `xhigh`.

Provider families:

| Family | Models |
| --- | --- |
| LocalLLM | `localllm-fast`, `localllm-deep`, `localllm-code`, `localllm-max`, `localllm-vision-xl`; Code, Max, and Vision retain the gates above |
| DeepSeek | `deepseek-v4-flash`, `deepseek-v4-pro` |
| Venice | `venice-uncensored-1-2`, `venice-uncensored`, `gemma-4-uncensored` |
| OpenAI | `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`; each has low/medium/high/xhigh reasoning |
| OpenRouter | `openrouter/auto`, `openrouter/pareto-code`, `openrouter/free` |
| OpenRouter OpenAI | `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-4o` |
| OpenRouter Anthropic | Claude routes such as `anthropic/claude-sonnet-4.6`, `anthropic/claude-opus-4.7`, `anthropic/claude-opus-4.8-fast` |
| OpenRouter Google | Gemini/Gemma routes such as `google/gemini-3.5-flash`, `google/gemini-3.1-flash-lite`, `google/gemma-4-31b-it` |
| OpenRouter DeepSeek | `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`, `deepseek/deepseek-r1-0528` |
| OpenRouter Qwen | Qwen routes such as `qwen/qwen3.7-max`, `qwen/qwen3.6-flash`, `qwen/qwen3.6-plus` |
| OpenRouter Meta/Mistral/Moonshot/xAI | `meta-llama/llama-4-maverick`, `mistralai/mistral-medium-3-5`, `moonshotai/kimi-k2.6`, `x-ai/grok-4.3` |
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

Use `/venice off` to switch back to the LocalLLM defaults:

```text
/route localllm/localllm-fast
/model localllm/localllm-deep
```

It keeps smart routing enabled. If the Venice key is missing, run `/auth venice`.

## Provider Buckets

| Bucket | Provider | Typical use |
| --- | --- | --- |
| `localllm` | LocalLLM | Default private route/main through the sibling loopback gateway. |
| `deepseek` | DeepSeek | Explicit hosted route for economical stronger-model work. |
| `openai` | OpenAI | Spare/frontier checks, Codex-family work, and explicit manual routes. |
| `openrouter` | OpenRouter | OpenAI-compatible gateway with auto/free/code routers. |
| `openrouter-openai` | OpenRouter | OpenAI-family models through OpenRouter. |
| `openrouter-anthropic` | OpenRouter | Claude-family models through OpenRouter. |
| `openrouter-google` | OpenRouter | Gemini/Gemma models through OpenRouter. |
| `openrouter-deepseek` | OpenRouter | DeepSeek models through OpenRouter. |
| `openrouter-qwen` | OpenRouter | Qwen models through OpenRouter. |
| `openrouter-meta` | OpenRouter | Meta Llama models through OpenRouter. |
| `openrouter-mistral` | OpenRouter | Mistral models through OpenRouter. |
| `openrouter-moonshot` | OpenRouter | Moonshot/Kimi models through OpenRouter. |
| `openrouter-xai` | OpenRouter | xAI Grok models through OpenRouter. |
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

The LocalLLM baseline uses `http://127.0.0.1:8008/v1` and the installation's loopback key (`local-dev-key` in the documented local setup). `AGINTI_LOCALLLM_MODEL` or `LOCALLLM_MODEL` is the shared local text override; role-specific `AGINTI_LOCALLLM_ROUTE_MODEL` and `AGINTI_LOCALLLM_MAIN_MODEL` take precedence. `AGINTI_LOCALLLM_CODE_MODEL` names the independently configurable coding capability alias; AgInTiFlow never needs the underlying engine tag. Optional `AGINTI_LOCALLLM_MAX_MODEL` and `AGINTI_LOCALLLM_VISION_MODEL` name the other gated heavyweight aliases. LocalLLM overrides must remain loopback URLs. Generic `LLM_*` values do not redefine the local provider.

Keys are saved account-wide in `~/.agintiflow/.env` by default. Use `--project` only when the current project needs an override in ignored `.aginti/.env`:

```bash
aginti auth
aginti auth openrouter
aginti auth venice
aginti keys status
printf '%s' "$OPENROUTER_API_KEY" | aginti keys set openrouter --stdin
printf '%s' "$VENICE_API_KEY" | aginti keys set venice --stdin
printf '%s' "$OPENAI_API_KEY" | aginti keys set --project openai --stdin
```

The web UI mirrors the same roles with dropdowns. Keep the left panel for daily controls: routing policy, provider/model, profile, goal, workspace, sandbox, and common tools. Use **Advanced settings** for model roles, browser start URL, wrapper/scout settings, Docker image, password/destructive toggles, and auxiliary image models. Runtime logs stay in the right column, followed by wrapper, workspace, and sandbox capability panels.
