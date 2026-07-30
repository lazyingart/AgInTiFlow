# Agent Execution Policy and Context Budget Review

Date: 2026-07-30

## Goal

Make AgInTiFlow fast for simple work and durable for complex work without turning isolated task examples into hard-coded behavior.

## Sibling Evidence

- Claw Code separates optional planning and effort controls from ordinary execution. Its runtime performs threshold-based automatic compaction and records removed-message metadata in `rust/crates/runtime/src/compact.rs`, `conversation.rs`, and `session.rs`.
- Gemini CLI runs `ChatCompressionService` before long histories become unstable and exposes a configurable compression threshold in `packages/core/src/context/chatCompressionService.ts`, `core/client.ts`, and `config/config.ts`. It also keeps loop detection separate from compression.
- Codex has model-context-window-aware automatic compaction, explicit token-budget guidance, and regression tests for repeated compaction and post-compaction growth in `codex-rs/core/tests/suite/compact.rs` and `token_budget.rs`.
- AgInTi-OverTree added a useful external-agent boundary in `src/codex-agent.js`: process-group cancellation, structured event ingestion, resumable thread identity, and terminal-state persistence. Its `src/workspace-backend.js` also rejects path escape and symlink traversal. These mechanisms are reusable; paper-specific naming and UI modules are not.
- Copilot SDK keeps session lifecycle, event transport, tool execution, and cancellation behind typed session APIs. The reusable lesson is lifecycle separation, not provider-specific session types.

## AgInTiFlow Findings

### System-level gaps

1. Every non-greeting run made a separate planning model request, even when smart routing had already assigned a low complexity score.
2. The default initial step budget remained 24 or more for simple focused tasks.
3. History compaction only happened after a provider timeout. Long successful runs could carry repeated snapshots and tool results until latency or provider failure forced recovery.
4. Execution decisions were distributed across model routing, SCS activation, parallel scouts, surgical context, and step budgets without one persisted execution-policy record.
5. Task profiles declare tool groups, but the runtime still sends the full tool schema. Profile-aware tool-surface reduction remains a future system improvement.

### Core-skill gaps

- Long/background jobs already have a deterministic handoff tool and do not need another prompt-only workaround.
- Writing, JSON, image/perception, MCP, AgentLink, and research specialists exist. Their main remaining issue is routing them through a smaller initial capability surface when the task is narrow.

## Implemented Policy

AgInTiFlow now selects one of two execution tiers:

- `focused`: low-complexity work starts directly in the agent loop, skips a separate planning request, and defaults to at most 12 initial steps. Explicit user step limits are preserved.
- `thorough`: complex routing, complexity score 3 or higher, SCS, and high-risk task profiles retain planning, scouts where applicable, dynamic budgets, and evidence validation.

The runtime records `execution.policy_selected` and either `plan.created` or `plan.skipped`. This makes the decision visible in saved sessions, CLI output, and the web timeline.

## Context Budget

The runtime now estimates persisted message size before each model step.

- Default mode: `auto`
- Default threshold: 180,000 message characters
- Default compact target: up to 60,000 characters
- Environment controls:
  - `AGINTI_CONTEXT_BUDGET_MODE=off|auto|on`
  - `AGINTI_CONTEXT_BUDGET_CHARS=<positive integer>`
  - `AGINTI_CONTEXT_TARGET_CHARS=<positive integer>`

Compaction keeps:

- system instructions;
- the authoritative current goal;
- original user requests;
- current plan;
- recent tool/model evidence;
- current sandbox, task-profile, step, and browser state.

It removes native tool-call/result history only after converting it into a compact evidence ledger. The runtime records before/after sizes in `history.compacted_for_context_budget`.

## Next General Improvements

1. Add profile-aware progressive tool disclosure. Begin with a small universal tool set and expose specialist/browser/MCP/tmux tools only when task routing or the model requests that capability.
2. Replace character-only budgeting with provider usage tokens when usage metadata is available, retaining character estimation as a cross-provider fallback.
3. Add loop/stall detection independent of step count: repeated identical tool calls, repeated equivalent failures, and no-evidence cycles should trigger strategy repair or a truthful blocker.

These belong in AgInTiFlow core. Paper-specific editors, Xiaoyunque defaults, scientific protocols, and project output conventions remain custom skills or application adapters.
