---
id: self-healing-pipeline
label: Self-Healing Pipeline
description: Diagnose stalled long-running writer, reviewer, monitor, queue, ETL, build, and generation pipelines; patch project-owned scripts; verify; and resume without discarding valid work.
triggers:
  - self healing
  - autorepair
  - auto repair
  - stuck pipeline
  - stalled pipeline
  - writer monitor
  - reviewer monitor
  - queue worker
  - long running pipeline
  - retry failed
  - resume failed
tools:
  - inspect_project
  - read_file
  - search_files
  - apply_patch
  - run_command
  - tmux_list_sessions
  - tmux_capture_pane
  - tmux_send_keys
  - tmux_start_session
---
# Self-Healing Pipeline

Use this skill when a project has a durable worker, writer, reviewer, monitor, queue, batch generator, ETL, build loop, or tmux job that must keep moving after malformed output, provider limits, crashes, bad chunks, stale locks, or compile failures.

## Diagnose Before Repair

1. Read project instructions, runner scripts, status files, manifests, logs, and current tmux panes.
2. Classify the symptom as one of: healthy wait, provider/rate-limit wait, validation failure, deterministic data/schema failure, script crash, stale lock/claim, compile/render failure, missing dependency, or monitor failure.
3. Compare progress counters across two observations before declaring a stall unless the logs show a hard error.
4. Preserve valid outputs. Never delete reviewed artifacts, manifests, checkpoints, or source inputs unless validation proves they are stale and the project has a quarantine path.

## Repair Pattern

- Patch project-owned scripts, prompts, validators, or monitors only after the logs identify a repeatable failure.
- Patch at the right layer. If a failure is caused by task-specific source semantics, schema, prompt, validator, or output conventions, fix the project script or project-local skill. If it is caused by a reusable pipeline capability gap, improve a built-in skill or task profile. If it is caused by runtime/tool/session/SCS behavior, improve AgInTiFlow core.
- Avoid hard-coded one-case repairs. Prefer data-driven project configuration, language/source profiles, schema versions, prompt versions, validator versions, and manifest evidence so the same pipeline can be reused and backfixed cleanly.
- Prefer small resumability upgrades: `--failed-only`, bounded retry passes, stale-claim cleanup, atomic writes, checkpoint status, idempotent compile commands, and clear resume commands.
- Keep writer/reviewer/monitor responsibilities separate. The writer should produce and validate; the reviewer should repair quality; the monitor should observe, compile, restart, or queue the next bounded run.
- Make monitors gentle: wait on healthy progress, restart only after explicit stop/stall/error evidence, and write a durable decision log.
- If parallel workers exist, require disjoint output paths or claim files, atomic promotion, and merge-stage validation before compiling.
- A reviewer is not just a promoter. It should inspect valid-looking outputs for source drift, missing units, repeated filler, malformed annotations, and known quality failures, then write candidate fixes or failed-only repair requests.
- A companion repairer should be independent from the main writer process. It can stay dormant, wake from status files or monitor decisions, run bounded repair passes, and exit without blocking healthy writer progress.
- If the same failure repeats after a local nudge, improve the runner, validator, prompt, or status model rather than relying on manual chat intervention.

## Parallel And Async Options

Parallel and async designs are optional implementation patterns, not a default preference. Use them when the user asks for concurrency, the existing project already has a parallel pipeline, or the evidence shows a sequential bottleneck that can be partitioned safely.

- Sequential processing is often the safest default for small jobs, fragile prompts, scarce quota, or unclear ownership boundaries.
- If using sharded writer/fetcher workers for independent JSON/data chunks, give each worker a deterministic shard, separate log file, and no compile responsibility.
- An async reviewer/promoter loop can validate and promote completed candidate files while writers continue, but it must use atomic writes, locks, or merge directories so it cannot race with active writers.
- Keep compilation, publishing, and git commits out of parallel workers unless the project already has a safe, serialized mechanism for those steps.
- If a worker stalls on one bad chunk, it should mark the chunk failed and continue its shard. Failed-only repair passes should be bounded and observable.
- When increasing concurrency, check provider quota/rate-limit behavior. If rate limits appear, reduce worker count or add backoff rather than letting every worker retry aggressively.

## Interactive Supervisor Pattern

When AgInTiFlow is the project orchestrator, it should run as an interactive tmux session that writes and updates the project runner scripts, then starts separate non-interactive tmux jobs for writers, reviewers, monitors, compilers, and repair passes. The interactive session remains responsible for reading logs, changing project code, restarting affected jobs, and committing progress. Background workers should not edit orchestrator code unless explicitly designed as a companion repairer with clear write scope and logs.

## Verification And Resume

After a repair:

1. Run syntax checks for changed scripts.
2. Run a dry-run or small bounded batch when safe.
3. Verify status counters, first missing item, failed IDs, and output timestamps.
4. Restart only the affected tmux session, not unrelated jobs.
5. Compile or export a checkpoint artifact when the pipeline has a renderer or build command.
6. Record the exact resume command, current status, logs inspected, remaining failed items, and any quarantined artifacts.
7. Commit reusable script/profile/prompt fixes when the project expects git tracking.

The goal is not to hide failures. The goal is to keep the pipeline observable, resumable, and able to recover from known classes of failure without overwriting good work.
