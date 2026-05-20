# Bilingual Book Supervision Lessons

This note records lessons from supervising AgInTiFlow on the ZhJpBook bilingual
interlinear book pipeline. The goal is not to make AgInTiFlow a book-specific
tool. The goal is to identify which failures were project workflow issues and
which reusable capabilities AgInTiFlow needs in order to complete large artifact
projects from raw inputs to final outputs with less external guidance.

## Research Inputs

Observed AgInTiFlow primitives:

- `skills/bilingual-interlinear-book/SKILL.md`
- `skills/structured-json/SKILL.md`
- `src/json-specialist.js`
- `src/writing-specialist.js`
- `src/task-profiles.js`
- `docs/autonomous-artifact-pipelines.md`
- `docs/self-healing-pipelines.md`
- `docs/auxiliary-image-generation.md`

Observed ZhJpBook workflow pieces:

- `scripts/interlinear/aginti_write_chunks.py`
- `scripts/interlinear/aginti_dynamic_review_chunks.py`
- `scripts/interlinear/start_aginti_parallel_json_writers.sh`
- `scripts/interlinear/watch_aginti_compile.py`
- `scripts/interlinear/compile_prepared_book_both_previews.sh`

Observed Sishu run evidence:

- The book reached `2480/2480` manifest chunks valid with no missing chunks.
- The final compile produced four PDFs: ZH-main and JP-main, color and
  blackwhite.
- Page counts were `2387` for ZH-main and `2065` for JP-main.
- A stale compile-watch status still reported older failed counts after the
  canonical progress report was clean, showing that multiple status snapshots
  can diverge unless one source of truth is enforced.
- AgInTi image generation was useful for cover backgrounds, but exact title,
  author, furigana, and curation text still needed deterministic composition.

## Main Finding

AgInTiFlow can already support this class of work when the surrounding project
has strong scripts, validators, and manifests. It is not yet enough for a normal
user to say "make this bilingual book from these raw sources" and expect
AgInTiFlow alone to reliably create the entire pipeline, run it, repair it,
compile outputs, inspect artifacts, and commit the result.

The missing capability is not a larger prompt. The missing capability is an
artifact-pipeline lifecycle that AgInTi can instantiate and supervise:

1. Inspect raw inputs.
2. Build source manifests and clean intermediate inputs.
3. Split work into stable tasks.
4. Run schema-bound workers with resumable artifacts.
5. Promote only validated outputs.
6. Review old outputs asynchronously.
7. Repair failures without restarting valid work.
8. Compile checkpoint and final artifacts.
9. Verify artifacts from outside the worker.
10. Commit and report exact evidence.

## Project-Level Responsibilities

These belong in the target repository or generated project scripts, not in
AgInTiFlow core:

- Book-specific source schemas and bilingual chunk schemas.
- Chinese/Japanese rendering decisions, TeX macros, page size, grammar colors,
  ruby placement, table of contents, and cover typography.
- Exact validators for source preservation, Hanzi tokenization, furigana/pinyin
  policy, grammar roles, and line-based interlinear layout.
- Book plans, source bundles, source-specific OCR cleanup rules, and known
  editions/translations.
- The concrete writer prompt for one literary/classical task.
- The exact compile commands and final output naming.

AgInTi should be able to generate or improve these files in the target project,
but they should remain project artifacts.

## AgInTiFlow Core Responsibilities

These should be reusable AgInTiFlow capabilities:

- Raw input handling: identify PDFs, scanned PDFs, EPUBs, images, JSON/wiki
  dumps, Markdown, and mixed source folders; choose extraction/OCR tools; record
  hashes, methods, caveats, and confidence.
- Structured job engine: run schema-bound JSON tasks with provider-native
  structured output when available, fallback JSON repair when not available,
  retries from validator errors, batch concurrency, shard-local outputs, atomic
  promotion, and progress status.
- Pipeline initializer: create a local pipeline contract for source manifest,
  derived inputs, task manifest, schema, validator, writer, reviewer, repairer,
  monitor, merge, compile/export, and final report.
- Supervisor/repairer loop: detect stalls, distinguish healthy waiting from
  failure, restart only affected workers, and patch the project workflow when
  repeated symptoms show a reusable gap.
- Dynamic reviewer loop: deterministically detect mechanical issues, pass only
  concrete issue lists to a reviewer model when needed, validate the fix, and
  loop until resolved or quarantined.
- Artifact registry: maintain one canonical state view with derived status
  snapshots, not several independent status files that can contradict each
  other.
- Output verifier: verify PDFs, images, archives, reports, and build products
  from outside the writer. Page count alone is insufficient; verify existence,
  metadata, representative screenshots or visual inspection, current-manifest
  coverage, and expected variants.
- Queue manager: run multiple prepared projects without losing order, pausing
  on quota/provider limits, or letting one stalled job block unrelated jobs.
- Secret/key onboarding: if a provider key exists in the environment, copy it
  into project-local `.aginti/.env` with safe permissions and ignored git status
  when the user requests AgInTi-owned execution.

## Specific Failure Patterns

### 1. Page Counts Were Misleading

The user repeatedly noticed PDFs with too few pages or pages that were visually
wrong. A PDF can compile and still be wrong if chunks are missing, stale, or
malformed. AgInTi should always connect compile success to manifest coverage and
visual/layout checks.

Recommended core behavior:

- A final artifact report must show manifest total, valid count, stale count,
  missing count, first missing ID, compile command, output path, page count, and
  representative visual checks.
- If a compile watcher status disagrees with the canonical chunk report, mark
  the watcher status stale instead of reporting a mixed status.

### 2. Restarting From Zero Destroyed Efficiency

Large book work is valuable even when partial. The most expensive artifacts were
translation/alignment/ruby/grammar chunks. Retuning chunk size or prompt
instructions should not discard reviewed chunks.

Recommended core behavior:

- Every generated artifact needs `source_hash`, `schema_version`,
  `prompt_version`, `model/provider`, `created_at`, and validation state.
- Workers should skip valid artifacts unless the source hash or required schema
  version changes.
- Chunk-size changes should rebuild the manifest while mapping reusable old
  artifacts by source span when possible.
- Failed chunks should be quarantined, not overwritten.

### 3. Parallelism Helped Only With Clear Ownership

Ten JSON workers improved throughput only because each worker had shard-local
logs and independent chunk ownership. Merge, promotion, compilation, and commits
remained serialized.

Recommended core behavior:

- `json_specialist_batch` is useful but should grow into a durable batch job
  abstraction with per-item artifacts, heartbeats, retries, cancellation,
  resume, and status files.
- Concurrent workers must never write one shared output file directly.
- The default safe pattern is: candidates -> validators -> promoted outputs ->
  serialized merge/compile.

### 4. Reviewer Needed Both Deterministic and Semantic Modes

The deterministic reviewer fixed schema/render issues. The user also wanted
review that notices OCR corruption, missing text, bad line alignment, all-one
color grammar pages, kana-only Japanese, source drift, and repeated filler.

Recommended core behavior:

- Deterministic checks should run first because they are cheap and reliable.
- Model review should receive concrete issue evidence, not a broad instruction
  to "make it better."
- Fixes should be validated by the same check that found the issue.
- If the reviewer cannot prove a fix, it should quarantine the chunk with a
  reason and let the writer continue elsewhere.

### 5. OCR and Source Ingestion Were Underestimated

For scanned Chinese books, bad OCR flowed into later high-cost annotation. The
right place to catch this is before bilingual generation.

Recommended core behavior:

- Add or strengthen a general file-ingestion skill/tool that can convert EPUB,
  text PDF, scanned PDF, image folders, and JSON/wiki sources to Markdown with a
  quality report.
- The quality report should include extraction method, language guess,
  character coverage, repeated garbage patterns, suspicious blank pages, OCR
  confidence when available, and sample questionable spans.
- AgInTi should not treat OCR text as clean source unless the report passes
  threshold or the user explicitly accepts noisy input.

### 6. Generated Image Text Was Not Reliable

AgInTi image generation produced a useful cover background, but text inside the
image was unreliable. The robust pattern was to generate a no-text background
and compose exact text deterministically.

Recommended core behavior:

- Cover/poster workflows should default to "image model creates background;
  deterministic renderer adds exact text" when exact titles, author names, URLs,
  ruby, or branding are required.
- The image-generation tool should save raw prompt/result metadata, but project
  scripts should own final typography.

### 7. AgInTi Itself Should Not Become Project-Specific

The bilingual book skill is appropriate as a workflow guide, but core AgInTiFlow
should stay general. The right split is:

- Core: pipeline lifecycle, file ingestion, structured jobs, monitoring,
  artifact verification, status, safe auth, and repair loops.
- Skill: when to apply those primitives for bilingual books.
- Target project: exact schemas, prompts, validators, TeX, assets, and book
  metadata.

## Proposed Capability Roadmap

### Priority 1: Artifact Pipeline Contract

Add a first-class `pipeline` initializer concept to AgInTiFlow. It should create
or check a project-local contract with these files or equivalents:

- `sources/manifest.json`
- `work/derived/`
- `work/tasks/manifest.json`
- `schemas/*.json`
- `scripts/validate_*`
- `scripts/run_writer`
- `scripts/run_reviewer`
- `scripts/run_repairer`
- `scripts/run_monitor`
- `scripts/compile_or_export`
- `reports/status.json`
- `reports/final.md`

This does not need to be book-specific. It should work for reports, datasets,
media processing, OCR, book generation, and large annotation tasks.

### Priority 2: Durable Structured Batch Jobs

Extend the structured JSON specialist from a single-call/batch helper into a
durable job runner:

- stable item IDs
- schema and prompt versioning
- provider/model routing per item
- concurrency and rate-limit backoff
- per-item candidate files
- validator callbacks
- atomic promotion
- failed/quarantined directories
- resume commands
- progress snapshots

For book tasks, this would replace ad hoc "10 worker" scripts. For other tasks,
it becomes a general extraction/classification/annotation engine.

### Priority 3: Dynamic Reviewer Primitive

Create a generic reviewer loop:

1. Run deterministic detectors.
2. Convert detector output to issue objects.
3. Send issue objects plus minimal source context to the reviewer model.
4. Apply candidate repair to a temporary artifact.
5. Re-run detectors and project validators.
6. Promote, retry with exact remaining issues, or quarantine.

This should remain schema-agnostic. Each project registers detectors and
validators.

### Priority 4: Input Ingestion Skill and Tooling

AgInTi should be able to inspect a folder of raw sources and propose or execute
conversion:

- EPUB: `pandoc`, `ebook-convert`, or Python EPUB extraction.
- Text PDF: `pdftotext`, `mutool`, or `python` PDF extraction.
- Scanned PDF/images: OCR tool discovery and quality reporting.
- JSON/wiki: structured conversion to Markdown with source IDs.
- Mixed editions/languages: source bundle with roles such as main text,
  translation, reference, commentary, glossary, or edition witness.

The output is not just Markdown; it is Markdown plus provenance.

### Priority 5: Unified Progress and Evidence

AgInTi should prefer one canonical status plus derived views. A monitor should
not maintain independent truth that can become stale.

Recommended status fields:

- `manifest_total`
- `valid`
- `reviewed`
- `failed`
- `quarantined`
- `stale`
- `pending`
- `first_missing`
- `last_success_at`
- `last_worker_heartbeat`
- `last_compile_at`
- `last_compile_ok`
- `latest_outputs`
- `resume_commands`

Derived watchers may cache these fields, but final reports should recompute from
the manifest and filesystem.

### Priority 6: Self-Repair Companion

A long-running pipeline should be able to start a dormant companion that is not
blocked by the writer process. The companion should wake on status changes,
heartbeats, failed locks, or explicit user prompts. It should be conservative:
observe first, repair only with evidence, and keep patches small.

The companion should be a general AgInTi pipeline supervisor, not a book-specific
daemon.

## What AgInTi Could Do Alone After These Changes

With the above primitives, a user could give AgInTi a folder of raw sources and
ask for a bilingual book. AgInTi should then be able to:

1. Inspect inputs and initialize the repo if needed.
2. Convert raw files to Markdown with a quality/provenance report.
3. Create a source bundle and book plan.
4. Split stable chunks.
5. Create project schemas, validators, and renderers if missing.
6. Start durable structured writer jobs with appropriate provider/model.
7. Run deterministic promotion and asynchronous review.
8. Backfill or repair failed chunks without restarting valid chunks.
9. Compile checkpoint PDFs periodically.
10. Generate a cover background with image tools and exact typography with local
    rendering.
11. Compile final variants.
12. Copy final outputs to a durable user folder when requested.
13. Commit scripts, schemas, stable data, and final outputs while avoiding raw
    copyrighted sources and secrets.

That is the product target. The current implementation is close in pieces, but
still requires too much manual supervision to connect the pieces under pressure.

## Design Principle

Do not solve large tasks by giving AgInTi a larger monolithic prompt. Solve them
by making AgInTi generate, inspect, and repair durable local systems. The agent
should spend model calls on semantic uncertainty and use deterministic scripts
for state, validation, promotion, compilation, and evidence.
