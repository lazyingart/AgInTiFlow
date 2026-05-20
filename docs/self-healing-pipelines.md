# Self-Healing Pipelines

AgInTiFlow treats long-running writers, reviewers, repairers, monitors, queues, ETL jobs, and batch generators as resumable pipelines rather than one-shot commands.

Use the `pipeline` task profile or rely on automatic skill selection when a prompt mentions a stalled writer, monitor, reviewer, queue worker, failed chunks, retry passes, stale claims, or tmux supervision.

## Operating Model

The agent should first read status files, manifests, logs, and tmux panes. It should compare progress across observations before calling a job stalled unless a hard error is visible. Healthy provider waits, rate limits, and long compile steps should usually be left alone.

When repair is justified, the agent should patch project-owned scripts or prompts in small reversible changes. Preferred repairs include failed-only retry modes, bounded retry passes, atomic writes, stale claim cleanup, idempotent compile commands, clear status JSON, heartbeat files, and durable logs.

Concurrency is a tool, not a product stance. AgInTiFlow should choose sequential, parallel, async, or review-gated operation from the user's request and the local project evidence. It should not force a sharded design into projects that do not need it.

Review and repair are separate from writing. A reviewer should detect missing source units, repeated filler, malformed structured data, source drift, and known quality failures, then produce candidate repairs or failed-only requests. A repairer should be able to run independently of the writer, wake from status files, run bounded passes, and exit without blocking healthy progress.

Tmux evidence must be fresh. Tmux panes preserve old scrollback, so after a restart the agent should emit a unique run marker into the pane and durable log/status file, then verify output after that marker. If no marker exists, it must compare log mtimes, process PID/elapsed time, and status timestamps before claiming the current run is healthy. Old failures in scrollback are useful history, not proof that the restarted worker is still failing.

## Boundaries

AgInTiFlow should not embed project-specific schemas in its core. A book writer, data pipeline, or build system owns its own validators and artifact layout. AgInTiFlow provides the reusable behavior: diagnose, preserve valid work, patch the local workflow, verify, build checkpoint artifacts, restart only affected sessions, and report exact resume commands.

## Verification

After a repair, the agent should run syntax checks for changed scripts, perform a dry-run or bounded batch when safe, inspect counters, first-missing IDs, fresh run markers, and timestamps, and keep unrelated tmux sessions running. If the same symptom repeats, the agent should improve the project workflow or a reusable AgInTiFlow skill instead of repeatedly sending manual nudges.
