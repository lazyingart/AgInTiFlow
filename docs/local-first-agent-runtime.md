# Local-First Agent Runtime

Status: active architecture and implementation goal

## Objective

AgInTiFlow must remain a general agent that can plan, select tools, execute guarded work, verify evidence, and finish truthfully. Its dependable baseline is the sibling LocalLLM service. DeepSeek, OpenAI, and other hosted providers remain optional upgrades, never hidden prerequisites or silent fallbacks.

The projects stay decoupled:

```text
AgInTiFlow orchestration
  -> provider/capability contract
    -> LocalLLM /v1 (baseline)
    -> DeepSeek / OpenAI / compatible gateways (explicit upgrades)
```

AgInTiFlow owns sessions, plans, permissions, tool dispatch, idempotency, context compaction, recovery, and verification. LocalLLM owns bounded stateless inference. AgInTiFlow must not depend on LocalLLM's web UI, SQLite conversations, or `/api/agent/*` management routes.

## Baseline provider contract

The canonical provider id is `localllm`. User-facing aliases `local`, `local-llm`, and `local_llm` may normalize to it, but raw engine labels such as `ollama` or `lmstudio` must not silently become LocalLLM. Saved sessions and events use the canonical id.

Default connection:

```text
base URL:        http://127.0.0.1:8008/v1
placeholder key: local-dev-key
health:          http://127.0.0.1:8008/healthz
models:          authenticated GET /v1/models
route lane:      localllm-fast
main lane:       localllm-deep
maximum lane:    localllm-max
vision:          localllm-vision-xl
embedding:       localllm-embed (sibling-service alias; not an AgInTi text-routing tier)
```

The default bearer value used by the local deployment is an interoperability placeholder, not a security boundary. Configuration must still send it as a normal bearer token and must never log it. Local endpoints remain loopback-only. A non-loopback LocalLLM base URL is rejected instead of quietly exporting prompts.

Readiness requires both `health.ok === true` and `health.ollama.ok === true`, followed by an authenticated `/v1/models` check that confirms the requested alias exists. Health alone is not sufficient.

The installed local ladder is capability- and resource-aware. `localllm-fast` handles short routing and bounded work; substantive coding and agent tasks use the 30B-A3B Q4 `localllm-deep` lane. The 30B-A3B Q8 `localllm-max` lane remains explicitly selectable, but every new or resumed Max run performs a fresh pre-inference gate after authenticated alias discovery. It requires at least 24 GiB available host RAM, swap use no higher than 75%, and 40 GiB aggregate free NVIDIA memory (Q8 weights plus working reserve). Missing GPU telemetry fails closed. Automatic Max is off by default and requires `AGINTI_LOCALLLM_ALLOW_AUTO_MAX=true`; an eligible run confirms the configured Max alias and fresh headroom before upgrading the actual model client from Deep. If the optional upgrade cannot be proven safe, it continues on Deep rather than failing. The automatic Vision policy requires both a trusted image-input signal and confirmed model capability. The shipped CLI/web currently reach vision through the local `read_image` tool or explicit `localllm-vision-xl` selection; both paths readiness-check the selected alias, and prompt keywords alone never activate Vision XL.

## Provider-neutral capabilities

Provider identity and model capability are separate. The current public provider contract normalizes `provider`, `label`, `openaiCompatible`, `local`, `requiresApiKey`, `toolProtocol`, `structuredOutput`, `supportsReasoningEffort`, and `textToolFallback`. The reusable target contract will expand that record with model- and runtime-specific fields instead of scattering provider-name checks:

```text
local
requiresApiKey
nativeTools
textToolFallback
jsonObject
strictJsonSchema
vision
embeddings
reasoningEffort
effectiveContext
maxOutput
maxConcurrency
```

Current LocalLLM request policy starts conservatively:

- native OpenAI-compatible function calls are tried first and locally validated;
- parallel tool calls are disabled;
- `json_object` plus strict post-validation is preferred over recursive `oneOf`/`$defs` schemas;
- a bounded text-tool protocol is a fallback path, not the default;
- remote images are fetched only when web access is enabled and any configured domain allowlist permits them; the provider receives bounded data URLs rather than the original remote URL;
- cancellation closes the active HTTP request; it does not imply provider-side rollback;
- the main agent loop is sequential, but the general runtime does not yet enforce a provider-wide semaphore across sessions; explicitly enabled scouts and specialist batches use their own bounded concurrency.

DeepSeek and OpenAI use the same normalized interface. A stronger model may receive a larger context, broader tool set, or higher step budget, but it does not get weaker permissions or a different truthfulness contract.

## Local-model execution ladder

The runtime should choose the least expensive lane that can satisfy the request:

1. **Direct answer** — ordinary conversation or a bounded knowledge question, with no tool schemas.
2. **Focused agent** — one task-shaped tool bundle, a small step budget, and no separate planning call unless needed.
3. **Thorough agent** — explicit plan, broader task-shaped tools, evidence checks, and context compaction.
4. **Supervised/SCS** — high-risk or long work with separate review and truthful blocker handling.

This is progressive capability disclosure, not capability removal. A focused coding request initially needs workspace inspection, search/read, patch/write, a guarded command, and finish. It does not need browser, MCP, writing, image, AgentLink, tmux, and research schemas in the same first call. A later turn may add a capability only when task routing or observed evidence justifies it.

Suggested compact bundles:

| Bundle | Initial tools |
| --- | --- |
| Workspace/code | `inspect_project`, `list_files`, `search_files`, `read_file`, `apply_patch`, `write_file`, `run_command`, `finish` |
| Browser | `open_url`, `click`, `type`, `scroll`, `press`, `back`, `wait`, `finish` |
| Research | `web_search`, `web_research`, `finish` |
| Long job | `start_long_job`, `long_job_status`, `finish` |
| Coordination | selected AgentLink or tmux tools plus `finish` |

Disabled tools stay impossible to dispatch even if a model names them in text or JSON.

## Tool-call recovery

Every model-selected action passes the same server-side registry and argument validator. Model output is never executable authority.

For one agent step:

1. Try a simple native function call.
2. Reject unknown, disabled, duplicate, malformed, or over-budget calls locally.
3. If the provider/model is known to need repair, request one plain JSON or text-protocol repair with only the relevant tools.
4. Revalidate the repair from scratch.
5. If repair fails, return a deterministic safe blocker or use an explicitly configured stronger lane.

Never replay a mutating tool merely because a model request timed out. The persisted tool ledger must prove a call has not already completed before retrying it.

Plain assistant content with no tool call is a valid finish only when the execution policy permits a direct answer or the evidence ledger shows the requested work is already complete. Otherwise the runtime asks once for the missing action/evidence, then stops truthfully instead of pretending completion.

## Context and output budgets

Character-only history accounting is not enough because tool schemas and UTF-8 density also consume context. The request budget includes:

```text
system instructions
+ selected tool schemas
+ conversation and compacted evidence
+ current task/snapshot
+ output reserve
```

Conservative LocalLLM defaults:

- configured request envelope: 32K total context, including messages, selected tool schemas, and output allowance;
- planning response: at most 2K output inside that same configured request envelope;
- normal agent step: an 8K output allowance and 4K tool-schema reserve leave a 20K compaction input ceiling under the default 32K envelope;
- final answer: at most 8K output unless the task explicitly requires more;
- compaction target: preserve goal, permissions, plan, unresolved blockers, file/tool evidence, and recent turns;
- concurrency is controlled by each execution path: the main loop is sequential, while explicitly enabled batch/helper paths may issue bounded parallel requests.

If a model returns empty visible content and no valid tool call, retry once with a compacted prompt and adequate output headroom. Repeated emptiness becomes a visible model limitation, not an infinite loop.

## Durable session runtime

Each session stores a versioned, revisioned runtime snapshot containing only safe provider, model-role, tool-policy, sandbox, context-budget, wrapper, auxiliary, and network-scope choices. It never stores API keys, bearer values, base URLs, environment maps, clients, callbacks, or abort signals.

On resume, the saved snapshot is authoritative. Current shell variables and current web preferences cannot silently replace its provider or role models. Credentials are freshly resolved for the saved provider after the snapshot is loaded. An explicit runtime change must carry the current revision; stale changes and continuations fail with a conflict before readiness checks or model-client creation. Web preferences seed new sessions only. The same contract applies to CLI, interactive, and web continuations.

Legacy sessions without a snapshot are migrated conservatively: route, main, and spare roles all inherit their saved top-level provider/model so migration cannot introduce a hosted lane. The web execution gate serializes same-process continuations; independent processes should not concurrently mutate one session.

## Hosted upgrades and privacy

Cloud escalation is opt-in and visible. A local failure must not silently send the workspace, prompt, images, tool results, or compacted history to DeepSeek/OpenAI.

An escalation policy records:

```text
allowed providers
reason for escalation
maximum context exported
whether artifacts/images may leave the host
whether the user approved this run or configured a durable policy
```

Provider failure before any tool executes may retry or switch according to that policy. After a tool executes, failover reuses the persisted result and never repeats the action without an idempotency proof.

## Evaluation gates

Offline deterministic tests run on every change:

- LocalLLM defaults, aliases, loopback enforcement, and no-key onboarding;
- smart route/main selection for `localllm-fast` and `localllm-deep`;
- compact tool bundle size and disabled-tool rejection;
- valid native tool call and complete tool-result round trip;
- malformed arguments, unknown tool, duplicate call id, and one bounded repair;
- no-tool direct answer versus incomplete-work retry/blocker;
- timeout before output, cancellation, and no post-cancel dispatch;
- context calculation includes tool schemas and output reserve;
- no silent hosted fallback;
- session resume preserves provider, model, capability profile, and executed-tool ledger.

Live compatibility tests are opt-in because they load local models:

| Lane | Minimum cases |
| --- | --- |
| `localllm-pocket` / 4B (direct sibling-service compatibility alias, not an automatic AgInTi tier) | direct answer, one-tool selection, malformed-output recovery, truthful blocker |
| `localllm-fast` / 8B | focused code inspection/edit/test loop, cancellation, resumed turn |
| `localllm-deep` / 30B-A3B Q4 | multi-step plan, repair after failed tool evidence, long-context compaction |
| `localllm-max` / 30B-A3B Q8 | explicit opt-in, resource preflight, highest-fidelity local code task |
| `localllm-vision-xl` / 30B-A3B Q4 | attached-image understanding with no keyword-only activation |
| DeepSeek/OpenAI | same fixtures, plus explicit escalation and stronger-model quality comparison |

Record pass/fail, latency, prompt size, tool accuracy, repair count, repeated-call count, completion truthfulness, and peak context. Quality promotion requires deterministic safety gates first; a fluent answer is not evidence that work completed.

## Delivery sequence

1. Add the provider contract and make LocalLLM the credential-free local-first default.
2. Remove DeepSeek-only assumptions from routing, auth, specialists, CLI, web settings, and saved preferences.
3. Add provider-aware request budgets and progressive tool disclosure.
4. Add bounded native-tool repair and incomplete-work detection.
5. Add offline conformance fixtures, then opt-in live LocalLLM evaluations.
6. Add explicit cloud escalation policy and comparative quality routing.
7. Expose the provider-neutral agent runtime as a reusable library/API so LocalLLM may later mount AgInTi capabilities without importing AgInTiFlow UI or storage internals.

The final integration direction is dependency inversion: LocalLLM can call a packaged AgInTi runtime adapter later, and AgInTiFlow can call any conforming inference provider today. Neither repository becomes the other's internal implementation detail.
