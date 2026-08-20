# LabCanvas ChatOps Fallback

AgInTiFlow is a reasoning and tool-supervision fallback for LabCanvas. LabCanvas remains the owner of chat transport, schedules, exact-source media resolution, durable task state, routine selection, artifact validation, and delivery.

## Contract

LabCanvas should pass one bounded task packet containing:

- exact current request and source-chat identity;
- latest same-chat interruptions and a small amount of attributed context;
- one selected routine and its contract paths;
- current deterministic preflight and stage state;
- exact artifact directory and irreversible-action gates.

AgInTi should read `AGENTS.md` and the selected routine contract, then call established commands. It should not invent a second scheduler, publication pipeline, media downloader, CAD generator, or delivery mechanism.

The default provider chain is `deepseek,localllm`. Switching providers is safe only when the first provider failed before inference or tool execution. Never replay an unknown task failure or timeout on another provider because the first attempt may already have caused a side effect.

## Evidence Scope

ChatOps prompts may include a trusted single-line marker:

```text
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"chat-response","request":"Produce only the requested chat response."}
```

or:

```text
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"host-managed-response","request":"Return the report body; LabCanvas compiles and delivers it."}
```

or:

```text
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"task","request":"Create the requested PDF from the supplied evidence."}
```

For `chat-response`, ordinary conversation and routing do not require file or command evidence. `host-managed-response` is for content-only subtasks such as a LaTeX body, translation, completion audit, or scheduled lesson where LabCanvas owns persistence, compilation, validation, and delivery. For `task`, evidence requirements are inferred only from the exact request, not from surrounding wrapper prose. Artifact requests still require real artifacts.

## Provider Tool-Batch Recovery

AgInTi requests one effectful tool call at a time, but some OpenAI-compatible
providers may still emit a small batch. A bounded batch of otherwise valid
calls is handled sequentially: AgInTi dispatches only the first call, records
`tool.batch_deferred`, and asks the model to continue from the resulting state.
Deferred calls are never executed automatically. Per-tool schema, permission,
secret, path, and irreversible-action checks remain authoritative.

Malformed calls, duplicate IDs, unavailable tools, hidden arguments, or an
oversized batch still stop with `tool_contract_violation`. A host may resume
the same saved session with another provider after that categorized stop; it
must not replay the original request or duplicate earlier side effects.

## Local Context Recovery

LocalLLM planning compacts oversized goals to a bounded head-and-tail representation. Runtime compaction retains the first request and latest interruptions. A `LocalContextBudgetError` triggers one compact-and-retry cycle at the same step and records private recovery events. It does not authorize replaying task side effects.

Validate with:

```bash
npm run check
npm run smoke:context-budget-recovery
npm run smoke:truthful-completion
```
