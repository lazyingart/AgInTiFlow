# Student-Committee-Supervisor Mode

Student-Committee-Supervisor mode, or SCS, is an optional quality gate for complicated AgInTiFlow tasks.

It is intentionally separate from the normal fast pipeline. Small requests should stay cheap and direct. SCS is for work where a weak plan, repeated failed action, or premature finish would be expensive.

## Commands

```bash
aginti --scs "fix this complicated project and verify it"
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

`/scs` without arguments toggles the feature: off becomes on, and on/auto becomes off.

## Role Contract

SCS uses the selected main model for every internal role.

| Role | Right | Boundary |
| --- | --- | --- |
| Committee | Draft one next-phase plan with acceptance criteria and stop conditions. | Cannot approve plans or call tools. |
| Student | Approve/veto the phase plan, review failure evidence, and approve/reject finish. | Cannot call tools or override runtime safety. |
| Supervisor | Execute the approved phase with the existing browser, shell, file, canvas, and wrapper tools. | Cannot replace the strategic plan without student review. |

The runtime remains the real authority for command policy, filesystem guardrails, secret redaction, session persistence, and user interruption.

## Runtime Behavior

When SCS is active:

- `config.provider` and `config.model` switch to the main model role, except mock mode keeps the local mock route for smoke tests.
- Parallel scouts are disabled by default unless explicitly requested, avoiding duplicate advisory layers.
- The normal `createPlan()` path is replaced by a committee draft plus student approval.
- An approved supervisor instruction is injected into the execution loop.
- Failed or blocked tools trigger a bounded student monitor review.
- Every fourth execution step triggers a bounded progress review for long runs.
- `finish` and assistant-content completion pass through a final student gate.
- Decisions are persisted as `scs.*` events and the phase pack is saved as a session artifact.

The current implementation is deliberately bounded:

- Committee plan retries are capped.
- Student monitor calls are capped.
- Finish rejections are capped to avoid deadlock.
- If the monitor cannot produce strict JSON, AgInTiFlow uses a conservative fallback decision and records the parser warning.

## Auto Mode

`/scs auto` and `--scs auto` activate SCS for complex, risky, or long-running work. Signals include:

- high smart-routing complexity score;
- profiles such as code, app, Android/iOS, large-codebase, GitHub, maintenance, security, LaTeX, research, and supervision;
- prompts mentioning multi-file work, regressions, builds, deployments, tmux, emulators, Docker, PDFs, or similar high-friction workflows.

Auto mode stays off for simple turns.

## When To Use It

Use SCS for:

- large coding tasks with ambiguous scope;
- Android/iOS/system tasks where environment checks matter;
- migrations, refactors, release work, and GitHub workflows;
- long-running tmux or simulator jobs;
- paper/LaTeX work where final artifacts need evidence;
- self-supervision or capability-training runs.

Avoid SCS for:

- `ls`, `pwd`, short factual answers, and small one-file edits;
- tasks where latency matters more than plan quality;
- already well-scoped prompts that normal routing handles reliably.

## Event Trail

SCS emits compact event names:

- `scs.enabled`
- `scs.committee.plan_drafted`
- `scs.student.approve_plan`
- `scs.student.veto_plan`
- `scs.student.rethink_plan`
- `scs.student.accept_phase`
- `scs.student.reject_phase`
- `scs.student.finish_allowed`
- `scs.student.finish_rejected`
- `scs.supervisor.phase_started`

These are saved in the normal session event log under `~/.agintiflow/sessions/<session-id>/events.jsonl`, with project pointers under `.aginti-sessions/`.

## Design Reference

The deeper design research lives in [references/student-committee-supervisor-mode.md](../references/student-committee-supervisor-mode.md). The important design choice is that SCS is a typed event gate, not a free-form debate. Internal roles emit structured decisions, and the runtime decides what those decisions are allowed to do.
