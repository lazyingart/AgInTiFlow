---
id: autonomous-artifact-pipeline
label: Autonomous Artifact Pipeline
description: Turn raw inputs into validated final artifacts through a resumable, observable pipeline with ingestion, chunking, writers, reviewers, repairers, monitors, and checkpoint builds.
triggers:
  - raw source to final output
  - autonomous pipeline
  - artifact pipeline
  - final artifact
  - prepare chunks
  - meta tasks
  - writer reviewer repairer
  - tmux monitor
  - resumable batch
  - compile output
  - auto repair
tools:
  - inspect_project
  - read_file
  - write_file
  - apply_patch
  - run_command
  - tmux_start_session
  - tmux_capture_pane
  - tmux_send_keys
  - send_to_canvas
---
# Autonomous Artifact Pipeline

Use this skill when the user wants AgInTiFlow to start from raw materials and keep working until durable final artifacts exist, such as books, reports, datasets, PDFs, apps, slides, media bundles, or generated JSON corpora.

## Pipeline Contract

Before launching long work, create or identify a project-local contract:

1. Source manifest: raw paths, hashes, source roles, language/type, extraction method, and caveats.
2. Derived inputs: Markdown, text, images, tables, or structured bundles produced from the raw sources.
3. Task manifest: stable chunk IDs, source location, dependency order, prompt/schema version, and output paths.
4. Artifact schema: JSON Schema or other validator-owned shape for each generated unit.
5. Runners: resumable writer, reviewer, repairer, monitor, merge, compile/export, and status commands.
6. Freshness evidence: runner IDs, heartbeats, log timestamps, status file mtimes, and tmux markers that separate current output from old scrollback.
7. Completion evidence: counters, first missing item, failed IDs, current previews, final artifact paths, and resume commands.

Project-specific schemas, prompts, layouts, and compilers belong in the target repository. AgInTiFlow provides the orchestration pattern and should generate or patch local scripts when they are missing.

## Execution Pattern

- Inspect the repository and instructions first. Preserve raw inputs and do not overwrite reviewed outputs.
- Convert raw files into durable intermediate inputs before asking a model to generate downstream artifacts.
- Split work into deterministic chunks that survive reruns. If chunk policy changes, map old outputs by stable source IDs instead of restarting from zero.
- Use isolated structured-data calls for repetitive JSON units. Keep prompts focused on the chunk, schema, source references, and validation errors.
- Add deterministic canonicalizers before model retry when failures are representational, such as punctuation normalization, stable token splitting, missing metadata backfill, schema version migration, or renderer-specific wrapping. Do not spend provider calls on repairs a local script can prove.
- Run writers in tmux or another observable background process. Each worker must have disjoint claims, atomic output writes, and shard-local logs.
- When restarting a tmux worker, print a unique run marker and write the same marker to its log or status file. A pane capture that only shows old scrollback is not proof of current progress.
- Keep review and repair asynchronous but safe. Reviewers may produce candidate fixes while writers continue; only validators or merge scripts promote candidates.
- Compile or export checkpoint previews after successful merge batches and always at final completion.
- Commit reusable scripts, manifests, validators, templates, and stable checkpoints when the project expects git tracking.

## Autorepair Behavior

A robust pipeline has an independent repair path that is not blocked by the main writer:

- Heartbeats record active worker, current chunk, last success, last failure, and provider wait state.
- Provider/rate-limit failures wait with backoff and retry at long intervals.
- Schema/parse failures are repaired with the exact validator error and the smallest useful input.
- Mechanical validation failures are repaired locally first when the canonical form is derivable from source text or schema rules.
- Semantic/source-drift failures are retried with smaller chunks or stronger source references.
- Repeated failures are quarantined with reasons, then handled by a bounded failed-only repair pass.
- Monitor intervention is gentle: observe healthy progress, restart only on hard error, stale claim, repeated no-progress window, or missing child process.

## Done Criteria

Do not call the task complete until the final artifact was built from the current manifest and the status report shows complete or intentionally quarantined coverage. A partial PDF, stale page count, old tmux scrollback, or successful worker log is not enough.
