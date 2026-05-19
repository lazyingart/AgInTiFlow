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
- Prefer small resumability upgrades: `--failed-only`, bounded retry passes, stale-claim cleanup, atomic writes, checkpoint status, idempotent compile commands, and clear resume commands.
- Keep writer/reviewer/monitor responsibilities separate. The writer should produce and validate; the reviewer should repair quality; the monitor should observe, compile, restart, or queue the next bounded run.
- Make monitors gentle: wait on healthy progress, restart only after explicit stop/stall/error evidence, and write a durable decision log.
- If parallel workers exist, require disjoint output paths or claim files, atomic promotion, and merge-stage validation before compiling.

## Verification And Resume

After a repair:

1. Run syntax checks for changed scripts.
2. Run a dry-run or small bounded batch when safe.
3. Verify status counters, first missing item, failed IDs, and output timestamps.
4. Restart only the affected tmux session, not unrelated jobs.
5. Record the exact resume command, current status, logs inspected, and remaining failed items.
6. Commit reusable script/profile/prompt fixes when the project expects git tracking.

The goal is not to hide failures. The goal is to keep the pipeline observable, resumable, and able to recover from known classes of failure without overwriting good work.
