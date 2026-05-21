---
id: bilingual-interlinear-book
label: Multilingual Annotated Book Pipeline
description: Build paired-language, interlinear, or annotated books from source documents using ingestion, stable task chunks, schema-bound annotations, review loops, and compiled outputs.
triggers:
  - interlinear
  - bilingual book
  - multilingual book
  - paired language
  - annotated book
  - parallel text
  - aligned annotations
  - glossed text
  - reading annotations
  - translation notes
  - source commentary
tools:
  - read_file
  - write_file
  - run_command
  - tmux_start_session
  - tmux_capture_pane
---
# Multilingual Annotated Book Pipeline

Use this skill when the user asks AgInTi to create a book-like artifact that combines a main text with translations, glosses, commentary, readings, grammar labels, or other aligned annotations.

This is a general workflow skill. It must not hard-code a specific book, language pair, schema, layout, filename, page size, or house style. If the target repository contains a project-local skill under `.aginti/skills/<id>/SKILL.md`, prefer that skill for domain-specific rules.

## Workflow

1. Inspect repository instructions, existing scripts, source folders, build folders, ignored paths, and project-local skills before editing.
2. Inventory sources and create or update a source manifest with path, hash, declared language, observed language/script, role, extraction method, and caveats. Keep original source media untouched unless the user explicitly asks otherwise.
3. Convert inputs into durable intermediate text first. Use the source-ingestion workflow for PDF, EPUB, image, scan, archive, JSON/wiki, or mixed input folders.
4. Audit every reference source before using it as translation evidence. A file name, website title, or declared language is not enough. Sample actual text and classify whether it is real target-language prose, source-language text hosted on a target-language site, machine/OCR noise, commentary, glossary, or metadata. Prompts must state this reliability classification.
5. Split cleaned text into stable paragraph-, section-, page-, or chapter-scoped tasks with persistent IDs. Record source spans so chunks can be regenerated, reused, reviewed, or mapped after later split changes.
6. Define the project schema in the target repository. Use the structured JSON workflow for repetitive annotation or alignment output, with focused prompts and provider-native JSON/schema modes when available.
7. Keep writer, validator, reviewer, repairer, monitor, merge, compile/export, and final-report roles separate. Writers produce candidates; validators promote; reviewers request fixes; monitors observe progress and restart only affected work.
8. Make all workers resumable. Use shard-local outputs, atomic promotion, status files, logs, retry/backoff for provider limits, and exact resume commands.
9. Never overwrite a valid reviewed artifact unless the source hash, schema version, prompt version, or validator version proves it is stale. Quarantine invalid outputs instead of deleting useful work.
10. Compile or export previews periodically and final variants at the end. Variant names and directions belong to the project schema or local skill, not this built-in skill.
11. Verify final artifacts externally: manifest coverage, valid/reviewed counts, missing/stale/failed items, output paths, metadata, and representative visual checks for PDFs or images.

## Annotation Rules

Keep annotation policies project-defined:

- Token shape, reading placement, grammar tags, and alignment granularity must come from the project schema.
- For scripts that need per-token or per-character readings, validators should enforce that locally instead of relying on a prompt.
- Placeholder translations, empty commentary, duplicated readings, copied modern paraphrases, or source drift should be detected by validators or reviewers.
- Translation/reference quality gates must be derived from the project schema, language profile, and source audit. Do not bake one book's vocabulary, source names, or forbidden-token list into this built-in skill or AgInTiFlow core.
- If a reference is unreliable for the requested target language, do not feed it to the writer as trusted translation. Either omit it, label it clearly as alignment/source-only context, or ask the project to supply a reliable reference.
- Color, typography, page size, table of contents, cover design, and exact PDF variants belong in project renderers.

## Orchestration Pattern

For long books, the interactive AgInTiFlow session should own the project orchestration:

- write or update the project scripts, schemas, prompts, validators, reviewers, monitors, and compilers
- start writer/reviewer/monitor tmux sessions itself
- use non-interactive model/API workers only inside those project scripts
- observe progress, patch the scripts when logs show repeatable failure, and resume from stable chunk IDs
- commit meaningful project changes when the repository expects git tracking

The chat agent should not manually become the chunk writer. If supervised by another agent, provide evidence and ask the interactive session to repair the project.

## Completion Evidence

Report the current manifest total, valid/promoted count, reviewed count, failed or quarantined count, first missing ID, latest artifact paths, compile/export commands, and the exact command to resume generation. Do not claim completion from a model summary alone; check the files and outputs directly.
