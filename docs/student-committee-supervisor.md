# Student-Committee-Supervisor Mode

Student-Committee-Supervisor mode, or SCS, is the default quality gate for AgInTiFlow tasks.

It separates planning, execution, and validation so the executor does not grade its own work. Use `--no-scs` or `/scs off` only when latency matters more than independent validation.

## Commands

```bash
aginti "fix this complicated project and verify it"
aginti --scs auto "migrate this app and run the checks"
aginti --no-scs "answer this simple question"
```

Inside interactive chat:

```text
/scs
/scs auto
/scs on
/scs off
/scs status
```

`/scs` without arguments toggles the feature: off becomes on, and on/auto becomes off. The default for new sessions is `on`.

## Role Contract

SCS uses the selected main model for every internal role.

| Role | Right | Boundary |
| --- | --- | --- |
| Committee | Draft one next-phase plan with acceptance criteria and stop conditions. | Cannot approve plans or call tools. |
| Student | Act as the independent validator: approve/veto the phase plan, review failure evidence, and approve/reject finish. | Cannot call tools, approve its own work, or override runtime safety. |
| Supervisor | Execute the approved phase with the existing browser, shell, file, canvas, and wrapper tools. | Cannot replace the strategic plan without student review. |

The runtime remains the real authority for command policy, filesystem guardrails, secret redaction, session persistence, and user interruption.

## Runtime Behavior

When SCS is active:

- `config.provider` and `config.model` switch to the main model role, except mock mode keeps the local mock route for smoke tests.
- Parallel scouts are disabled by default unless explicitly requested, avoiding duplicate advisory layers.
- The normal `createPlan()` path is replaced by a committee draft plus student approval.
- An approved supervisor instruction is injected into the execution loop.
- Failed, blocked, suspicious, or mismatched tools trigger a bounded student validator review.
- Every fourth execution step triggers a bounded progress review for long runs.
- `finish` and assistant-content completion pass through a final student gate.
- A deterministic task contract and evidence ledger are built under the student gate. The contract records required evidence categories such as file, command, artifact, browser, visual, git, or publish evidence. The ledger classifies recent tool and event evidence into those categories.
- The final gate compares the contract, approved plan, executor finish claim, and evidence ledger. A model approval cannot override missing deterministic evidence for evidence-bearing tasks unless the run is reporting a real external blocker.
- If the student validator rejects progress or finish, the runtime asks the committee for a new phase plan and sends that plan back through the student gate before the supervisor continues.
- Decisions are persisted as `scs.*` events and the phase pack is saved as a session artifact.

The current implementation is deliberately bounded:

- Committee plan retries are capped.
- Student monitor calls are capped.
- Finish rejections are capped to avoid deadlock.
- If the monitor cannot produce strict JSON, AgInTiFlow uses a conservative fallback decision and records the parser warning.

## Auto Mode

`/scs auto` and `--scs auto` are the default for users who want cheap simple turns without losing strict validation on risky work. Auto mode activates SCS for high-risk, evidence-heavy, or long-running work. Signals include:

- very high smart-routing complexity score;
- profiles such as app, Android/iOS, large-codebase, GitHub, maintenance, QA, security, supervision, pipeline, and website;
- prompts mentioning failing tests, repo-wide changes, browser uploads, releases, deployments, tmux, emulators, Docker, PDFs, or similar high-friction workflows.

Auto mode is the default. It stays off for simple turns, uses the main model for moderate complexity, and activates SCS only for high-risk or evidence-heavy turns.

## Dynamic Step Budgets

AgInTiFlow treats `maxSteps` as the initial run budget. Near the boundary, the runtime may grant a bounded extension only when recent tool/file/artifact evidence shows concrete progress and no permission blocker is being bypassed.

Normal mode uses a lightweight deterministic monitor. Default SCS runs and activated `/scs auto` runs add the SCS student budget gate, which can emit `extend_steps`, `deny_extension`, or `rethink_plan`. More steps never escalate permissions, package policy, host access, destructive actions, or secret access. Use `--dynamic-steps off` when a strict hard stop is required. The detailed design is tracked in [references/dynamic-step-budget-and-scs-auto.md](../references/dynamic-step-budget-and-scs-auto.md).

## When To Keep It On

Keep SCS on for:

- large coding tasks with ambiguous scope;
- Android/iOS/system tasks where environment checks matter;
- migrations, refactors, release work, and GitHub workflows;
- long-running tmux or simulator jobs;
- paper/LaTeX work where final artifacts need evidence;
- self-supervision or capability-training runs.

Turn SCS off only for:

- `ls`, `pwd`, short factual answers, and small one-file edits;
- tasks where latency matters more than plan quality;
- already well-scoped prompts that normal routing handles reliably.

## Event Trail

SCS emits compact event names:

- `conversation.continued`
- `surgical_context.prepared`
- `surgical_context.failed`
- `scs.plan.requested`
- `scs.enabled`
- `scs.committee.plan_drafted`
- `scs.student.approve_plan`
- `scs.student.veto_plan`
- `scs.student.rethink_plan`
- `scs.student.accept_phase`
- `scs.student.reject_phase`
- `scs.student.finish_allowed`
- `scs.student.finish_rejected`
- `scs.committee.replan_drafted`
- `scs.supervisor.phase_started`

These are saved in the normal session event log under `~/.agintiflow/sessions/<session-id>/events.jsonl`, with project pointers under `.aginti-sessions/`.

Browser and CDP helper commands are reviewed by evidence, not only by exit status. If a click or selector command reports `ok: true` but returns broad whole-page text, repeated navigation/history/sidebar text, or no scoped target evidence, SCS treats the result as suspicious and asks the supervisor to verify state or switch to a precise selector before continuing.

For upload, browser, visual, media, or external-service tasks, a successful helper command is not enough by itself. The ledger must include evidence that proves the requested state, such as the active page, visible count, screenshot, output artifact, build/test output, or committed/published state.

## Design Reference

The deeper design research lives in [references/student-committee-supervisor-mode.md](../references/student-committee-supervisor-mode.md) and [references/scs-evidence-validator-core-design.md](../references/scs-evidence-validator-core-design.md). The important design choice is that SCS is a typed event gate, not a free-form debate. Internal roles emit structured decisions, and the runtime decides what those decisions are allowed to do.
