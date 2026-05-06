# Student-Committee-Supervisor Mode

This note researches the current AgInTiFlow execution pipeline and proposes a standalone `/scs` mode: Student-Committee-Supervisor, abbreviated `SCS`.

The name intentionally keeps the reversed-role joke: the "student" supervises, the "supervisor" executes, and the "committee" drafts but cannot decide.

## Current Working Pipeline

The current AgInTiFlow runner is a single-executor agent loop with optional advisory scouts.

Current flow:

1. CLI/web state chooses runtime settings: provider, routing mode, role models, task profile, shell/file/web/scout toggles, sandbox, and max steps.
2. `resolveRuntimeConfig()` selects one effective provider/model for the run using `selectModelRoute()`. The route/main/spare role settings exist, but each run still has one active `config.provider` and `config.model`.
3. `runAgent()` creates or resumes a central session store, creates an OpenAI-compatible client, loads project instructions, selected skills, profile prompts, engineering guidance, tool policy text, and the user goal into the model context.
4. If the session has no plan, `createPlan()` asks the active run model to draft a concise 3-6 step plan. This plan is saved and rendered, but it is not independently approved.
5. If the task is complex and scouts are enabled, `runParallelScouts()` builds a bounded context pack, runs several advisory scout calls, synthesizes a Swarm Board, saves `scout-blackboard.json`, and injects the summary as advisory user context.
6. The executor loop starts. Each step drains queued user input, captures a browser or synthetic runtime snapshot, appends step state to the conversation, calls `requestNextStep()`, executes any returned tool calls, records events, saves state, and repeats.
7. Tools are deterministic and policy-guarded: file tools, shell/Docker, tmux, web search, browser, wrapper delegation, image generation, canvas, and `finish`.
8. Loop guards inject warnings when the same failed/blocked tool call repeats.
9. The run ends when the model calls `finish`, returns assistant content without tools, hits max steps, or is interrupted.
10. Housekeeping flushes after the run.

Important current properties:

- Planning and execution use the same active run model.
- Smart routing decides the active model before the run. It does not currently run planning on route and execution on main as separate inner roles.
- Parallel scouts are advisory only. They cannot approve, veto, pause, or request replanning.
- `/review` is implemented as a slash-command prompt wrapper that runs the normal executor in review profile with a bounded review prompt.
- Session events are already rich enough to support a monitor: `plan.created`, `parallel_scouts.completed`, `model.requested`, `model.responded`, `tool.started`, `tool.completed`, `tool.failed`, `tool.blocked`, `loop.guard`, `file.changed`, `session.finished`, and `session.stopped`.

Relevant implementation files:

- `src/config.js`: runtime config and role-model resolution.
- `src/model-routing.js`: smart/manual route selection and model catalogs.
- `src/model-client.js`: plan call, tool schema, text tool-call fallback, next-step request.
- `src/parallel-scouts.js`: advisory scout swarm and coordinator board.
- `src/agent-runner.js`: session lifecycle, plan creation, event loop, tool execution, queued input, finish behavior.
- `src/interactive-cli.js`: slash commands such as `/review`, `/route`, `/model`, `/scouts`, `/skillmesh`.

## Proposed SCS Contract

`/scs` enables a stricter internal workflow for the current interactive session.

Roles:

| Role | Model | Rights | No-rights boundary |
| --- | --- | --- | --- |
| Student | Main model | Monitor execution, approve plan, veto plan, request rethink based on evidence, decide whether enough work was done. | Does not execute tools directly. |
| Committee | Main model | Draft candidate plans and alternatives. | Cannot approve, veto, replan after execution starts, or call tools. |
| Supervisor | Main model | Execute the approved plan with the existing tool loop. | Cannot draft its own initial plan, cannot approve its own plan, cannot declare strategic replans without student permission. |

The user asked that once `/scs` is enabled, all SCS work uses the main model. This is sensible for determinism: no route/main mismatch, no cheap planner producing a plan that a stronger executor dislikes, and no confusing cross-model responsibility. It also makes cost predictable because the feature is opt-in.

## Pros

SCS improves AgInTiFlow in several ways.

- It separates plan quality from tool execution. The current executor can draft a plan then immediately execute it; SCS inserts a real gate.
- It makes the monitor role explicit. Existing scouts advise before execution, but they do not watch tool results or catch false completion.
- It turns repeated failure into controlled replanning. Current loop guards warn the executor; SCS lets a separate monitor decide that the current plan is bad.
- It improves long-running task discipline. A student monitor can check whether acceptance criteria are still aligned after each milestone.
- It creates a good path for self-supervision. The student role can later become a reusable quality gate across coding, Android, LaTeX, writing, GitHub, system maintenance, and design profiles.
- It maps well to existing event logs. The runner already records enough state for a monitor to summarize and judge without re-reading the whole transcript.
- It preserves the existing tool surface. The supervisor can be the same `requestNextStep()` executor with extra constraints.
- It fits mature agent patterns: Codex-style streaming events and review modes, Qwen-style permission callbacks and plan mode, Claude-style multi-agent review, and Gemini-style behavioral eval feedback.

## Cons And Failure Modes

SCS also has real risks.

- It may slow simple tasks. Three internal roles are wasteful for `ls`, `pwd`, or a short answer.
- It can create circular authority. If the supervisor cannot propose replans but discovers new facts through tools, the student must translate those facts into a rethink request.
- It can overfit to plan approval. Many coding tasks need opportunistic discovery; the initial plan should be a phase plan, not a rigid contract.
- It can produce committee noise. A committee that only drafts plans can still waste tokens if asked too often or without a tight schema.
- It can reduce model diversity. Using only the main model avoids cross-model confusion but loses cheap scouts and independent failure modes.
- It can deadlock on veto. A bad student veto could block progress unless there is a bounded retry policy.
- It can hide accountability if events are not explicit. Every SCS decision must be logged as a typed event with evidence and role.
- It can degrade UX if the CLI prints every internal debate. Users should see compact state: `SCS plan approved`, `SCS rethink requested`, `SCS vetoed: reason`.

## Recommended Mature Design

The strongest version is not a permanent three-agent debate. It is a gated phase controller with three role prompts and strict event contracts.

Use this model:

1. Committee drafts candidate phase plans.
2. Student selects, edits, approves, or vetoes one plan.
3. Supervisor executes only the approved next phase.
4. Student evaluates evidence after each phase or after a failure trigger.
5. If accepted, continue to the next phase or finish.
6. If rejected, student requests committee rethink with evidence.

The key change is "phase", not "whole task". The committee should draft the next 1-3 milestones, not a giant plan for the whole project. This matches the existing rolling autonomy roadmap and avoids brittle long lists.

Decision schema:

```json
{
  "role": "student",
  "decision": "approve_plan | veto_plan | rethink_plan | accept_phase | reject_phase | finish_allowed",
  "confidence": 0.0,
  "evidence": ["event ids, file paths, command summaries, tool failures"],
  "reason": "short concrete reason",
  "next_required_action": "committee_rethink | supervisor_execute | supervisor_continue | finish"
}
```

Committee schema:

```json
{
  "role": "committee",
  "phase_goal": "one concrete milestone",
  "plan": ["3-6 concrete steps"],
  "acceptance_criteria": ["observable evidence"],
  "allowed_tools": ["inspect_project", "search_files", "read_file", "apply_patch", "run_command"],
  "stop_conditions": ["blocked dependency", "dirty unrelated files", "same failure twice"]
}
```

Supervisor constraint:

```text
Execute only the approved phase plan. You may choose exact tools and paths, but you may not invent a new strategic plan. If tool results invalidate the plan, report the evidence and stop for student review.
```

## Standalone Feature Architecture

Implement SCS as an optional orchestration layer around the existing runner, not as a rewrite of tools.

New config/state:

- `AGINTI_SCS_MODE=true`
- CLI flag: `--enable-scs`
- interactive command: `/scs`, `/scs on`, `/scs auto`, `/scs off`, `/scs status`
- state fields:
  - `state.enableScs`
  - `state.scs.phase`
  - `state.scs.plan`
  - `state.scs.studentDecision`
  - `state.scs.history`

New module:

- `src/scs-controller.js`

Responsibilities:

- Build compact evidence packs from session state and recent events.
- Ask committee for a phase plan using the main model.
- Ask student to approve/veto/rethink using the main model.
- Inject the approved phase plan as a system/user constraint before supervisor execution.
- Decide when to pause execution and trigger student review.
- Persist typed SCS events.

Suggested events:

- `scs.enabled`
- `scs.committee.plan_drafted`
- `scs.student.plan_approved`
- `scs.student.plan_vetoed`
- `scs.student.rethink_requested`
- `scs.supervisor.phase_started`
- `scs.supervisor.phase_blocked`
- `scs.student.phase_accepted`
- `scs.student.phase_rejected`
- `scs.finished_allowed`

Execution hooks:

1. Before `createPlan()`: if SCS is enabled, call committee planner instead of normal `createPlan()`.
2. After committee plan: call student approval. If vetoed, retry committee with veto reason up to a small bound such as 2.
3. Before each executor request: inject approved phase plan and supervisor constraints.
4. After each tool failure/block, repeated loop guard, file change batch, or N steps: call student monitor.
5. Before `finish`: require student `finish_allowed` unless the run is stopped by user/max steps.

This preserves current tool execution while adding a decision layer.

## Trigger Policy

Do not run SCS on every task unless the user explicitly enables it.

Recommended modes:

| Mode | Behavior |
| --- | --- |
| `off` | Current behavior. |
| `on` | SCS gates all non-trivial work in the session. |
| `auto` | SCS only activates for complex tasks, write actions, multi-step shell work, GitHub, system maintenance, Android/iOS, LaTeX/PDF, and long-running tasks. |

`/scs` should toggle SCS on/off in interactive CLI. `/scs auto` keeps the mature complex-task gate for users who want quality control without paying the SCS cost on simple turns.

## Dynamic Step Budget Extension

SCS should eventually become the strict monitor for step-budget extension. The current runner uses a fixed `maxSteps` loop. A stronger design treats `maxSteps` as the initial budget and allows a bounded extension only when the monitor sees concrete progress, a specific next phase, and no permission blocker.

For `/scs on`, the student emits a typed decision such as `extend_steps`, `deny_extension`, or `rethink_plan`. For `/scs auto`, router policy first decides whether SCS is active for the turn; if active, the SCS student owns the extension decision, otherwise normal mode uses a lighter conservative budget gate. More detail lives in [dynamic-step-budget-and-scs-auto.md](./dynamic-step-budget-and-scs-auto.md).

## Model Policy

When SCS is enabled:

- Use `mainProvider/mainModel` for committee, student, and supervisor.
- Set `config.provider/model` to the main role for the run.
- Keep the spare model disabled unless the user explicitly asks for external critique.
- Keep parallel scouts disabled by default inside SCS to avoid duplicated advisory layers.

Reasoning:

- The committee and student need enough ability to evaluate plans and evidence.
- Route model savings are less important because SCS is opt-in for quality.
- One model family avoids conflicts from tool-call quirks across providers.

Possible future improvement:

- `SCS auto` may use cheap route model for committee drafts, main model for student approval, and main model for supervisor execution. That should be added only after the one-main-model version is reliable.

## UI And CLI

CLI:

```text
/scs
/scs on
/scs off
/scs auto
/scs status
```

Status output:

```text
scs=on model=deepseek/deepseek-v4-pro phase=2 decision=phase_accepted
```

During a run, keep output compact:

```text
scs committee drafted phase plan
scs student approved plan confidence=0.82
scs student requested rethink: repeated blocked write_file
```

Web:

- Add SCS toggle under Advanced settings first.
- Show a compact SCS timeline near runtime logs.
- Do not show raw committee/student transcripts by default; expose them in events/artifacts for inspection.

## Safety And Performance

Bounds:

- Committee plan retries: max 2.
- Student monitor calls: after plan, before finish, and on triggers; not after every successful tool by default.
- Evidence pack: last 20 events plus current plan, changed files, tool failures, and acceptance criteria.
- Transcript budget: summarize old SCS decisions; never append all committee text forever.
- Failure fallback: if SCS monitor errors, either fail closed for write/system tasks or fail open for read-only tasks with a warning event.

Security:

- Redact tool args with existing redaction helpers.
- Do not expose secrets in evidence packs.
- Do not let committee/student call tools.
- Do not let student approve command-policy violations. Existing guardrails remain authoritative.

## How This Improves AgInTiFlow Beyond The Original Idea

The original idea defines role rights. The more mature design defines event rights.

Better principle:

> No internal role should have abstract authority. It should have permission to emit a small set of typed decisions, and the runtime decides what those decisions can do.

This keeps the system inspectable, testable, and easier to debug.

Recommended mature shape:

- `committee`: proposes structured phase plans.
- `student`: emits typed gates based on evidence.
- `supervisor`: executes existing tools under an approved phase.
- `runtime`: remains the real authority for guardrails, filesystem safety, command policy, session persistence, and user interruption.

This is stronger than a pure multi-agent conversation because it turns role behavior into product behavior.

## Implementation Plan

Implemented first slice:

- `src/scs-controller.js` provides mode normalization, auto activation, committee/student JSON calls, evidence packs, supervisor instructions, tool-failure monitoring, periodic progress review, and final finish gates.
- `src/config.js` adds `enableScs`/`scsActive` and switches active execution to the main model role when SCS is active.
- `src/interactive-cli.js` adds `/scs`, `/scs auto`, `/scs on`, `/scs off`, and `/scs status`. Legacy SCS slash aliases have been removed so there is only one interactive command.
- `src/cli.js` adds `--scs`, `--scs auto`, and `--no-scs`. Older SCS flags have been removed so scripts use the same public SCS vocabulary.
- `src/agent-runner.js` persists typed `scs.*` events, saves `scs-phase-001.json`, injects the approved supervisor phase, reviews failed tools, and gates finish.

Remaining roadmap:

Phase 1: documentation and config

- Status: implemented for CLI and config.

Phase 2: plan gate

- Status: implemented for the initial phase gate.

Phase 3: execution monitor

- Status: implemented for failed/blocked tools, every-four-steps progress review, and finish gate.

Phase 4: web and tests

- Add web toggle and SCS timeline.
- Add mock-mode smoke tests for approve, veto, rethink, and finish gate.
- Add a regression case where the executor tries to finish after a failed tool and student rejects it.

Phase 5: auto mode

- Enable SCS automatically for complex risky profiles after behavior is stable.
- Keep simple tasks on the current fast pipeline.

## Open Questions

- Should SCS approval be required before any write tool, or only before the first phase starts?
- Should the student be allowed to require specific checks, or only accept/reject evidence?
- Should committee be one call or multiple candidate calls synthesized into one plan?
- Should any future legacy SCS aliases be rejected with a migration hint, or stay as plain unknown commands?
- Should SCS decisions be shared through Skill Mesh as learned supervision skills?

## Recommendation

Implement `/scs` as the serious opt-in quality mode.

Start with one-main-model SCS and only gate the initial plan plus final finish. Then add failure-triggered student monitoring. Avoid per-tool approval in the first version; existing command and file guardrails already protect the dangerous paths, and too many monitor calls will make the product feel slow.

The most valuable first success criterion is this:

> In a complex coding task, AgInTiFlow should not execute a weak initial plan, should not keep repeating a failed action, and should not claim completion until a separate monitor has seen evidence.
