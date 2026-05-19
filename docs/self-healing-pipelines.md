# Self-Healing Pipelines

AgInTiFlow treats long-running writers, reviewers, monitors, queues, ETL jobs, and batch generators as resumable pipelines rather than one-shot commands.

Use the `pipeline` task profile or rely on automatic skill selection when a prompt mentions a stalled writer, monitor, reviewer, queue worker, failed chunks, retry passes, stale claims, or tmux supervision.

## Operating Model

The agent should first read status files, manifests, logs, and tmux panes. It should compare progress across observations before calling a job stalled unless a hard error is visible. Healthy provider waits, rate limits, and long compile steps should usually be left alone.

When repair is justified, the agent should patch project-owned scripts or prompts in small reversible changes. Preferred repairs include failed-only retry modes, bounded retry passes, atomic writes, stale claim cleanup, idempotent compile commands, clear status JSON, and durable logs.

## Boundaries

AgInTiFlow should not embed project-specific schemas in its core. A book writer, data pipeline, or build system owns its own validators and artifact layout. AgInTiFlow provides the reusable behavior: diagnose, preserve valid work, patch the local workflow, verify, restart only affected sessions, and report exact resume commands.

## Verification

After a repair, the agent should run syntax checks for changed scripts, perform a dry-run or bounded batch when safe, inspect counters and first-missing IDs, and keep unrelated tmux sessions running. If the same symptom repeats, the agent should improve the project workflow or a reusable AgInTiFlow skill instead of repeatedly sending manual nudges.
