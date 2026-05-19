# Autonomous Artifact Pipelines

AgInTiFlow can run a project from raw inputs to final artifacts when the work is expressed as a local, resumable pipeline. This pattern is for jobs such as source conversion, book generation, report building, dataset annotation, media preparation, or any workflow where partial outputs are valuable and failure recovery matters.

## Contract

Each pipeline should create these project-local files or equivalents:

- Source manifest: raw files, hashes, roles, languages, extraction method, and caveats.
- Derived inputs: Markdown, text, tables, images, or structured bundles created from the raw files.
- Task manifest: stable chunk IDs, source locations, dependencies, prompt/schema version, and output paths.
- Schema and validator: the exact artifact shape plus semantic checks that define a promotable output.
- Runners: writer, reviewer, repairer, monitor, merge, compile/export, and status commands.
- Completion report: counts, first missing ID, failed/quarantined items, latest previews, final artifact paths, and resume commands.

The target repository owns its schemas, prompts, chunk policy, and rendering code. AgInTiFlow owns the behavior: inspect, create missing scripts, run observable sessions, preserve valid work, validate, repair, compile, and report evidence.

## Roles

The writer creates candidate artifacts. It should never be the only quality gate.

The validator promotes candidates only after schema and project-specific checks pass.

The reviewer inspects valid-looking artifacts for missing source units, source drift, repeated filler, malformed annotations, suspicious all-one-style output, and other known quality failures. It writes candidate fixes or failed-only repair requests.

The repairer runs independently of the writer. It can wake from status files, handle failed or quarantined chunks, retry with exact validator errors, reduce chunk size, or escalate to a stronger model when the project allows it.

The monitor is gentle. It waits through healthy progress and provider limits, restarts only on hard evidence of stall or crash, and records each decision.

## Concurrency

Parallelism is optional. When used, each worker needs deterministic shard ownership, separate logs, atomic writes, and no direct compile responsibility. Merge, promotion, compilation, publishing, and commits should be serialized unless the project already has a safe coordinator.

## Completion

A run is complete only when the final artifact was built from the current manifest and the status report shows full coverage or intentional quarantine. A successful tmux pane, a page count, or a single preview file is not enough.
