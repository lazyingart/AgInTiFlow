---
id: bilingual-interlinear-book
label: Bilingual Interlinear Book Pipeline
description: Build Chinese/Japanese or other paired-language pocket books with Markdown extraction, chunk manifests, ruby/pinyin JSON, grammar roles, monitoring, and LaTeX PDF outputs.
triggers:
  - interlinear
  - bilingual book
  - paired language
  - furigana
  - pinyin
  - ruby
  - xelatex
  - pocket book
  - grammar roles
tools:
  - read_file
  - write_file
  - run_command
  - tmux_start_session
  - tmux_capture_pane
---
# Bilingual Interlinear Book Pipeline

Use this skill when the task asks for a paired-language book, ruby/furigana/pinyin, Chinese/Japanese interlinear layout, grammar-role color, or pocket-size LaTeX output.

## Required Workflow

1. Inspect repository instructions, existing scripts, book plans, and ignored paths before editing.
2. Keep original PDFs/EPUBs in source folders and do not commit large source media unless the repository explicitly tracks them.
3. Convert source books to durable Markdown first. Keep raw and cleaned Markdown separate when OCR or EPUB extraction is noisy.
4. Split cleaned Markdown into stable paragraph- or chapter-scoped chunks with `manifest.json` and `chunks.jsonl`. Use source paragraph IDs that survive reruns. If a paragraph is too large for reliable provider output, split it into ordered subchunks at sentence or clause boundaries while preserving the original source order and recording `split_from_chunk_id`, `split_part`, and `split_part_count`.
5. Write resumable per-chunk JSON artifacts. Never overwrite a valid reviewed chunk unless a validator or prompt version requires regeneration; move stale chunks out of the compile path.
6. Generate or repair annotations with a provider worker loop, not a monolithic prompt. Each chunk should validate independently before promotion.
7. Compile preview PDFs periodically and at the end. For paired-language books, compile both directions when renderers exist, plus color and blackwhite variants when color is supported.
8. Run the writer and monitor in observable tmux sessions with status files, logs, retry/backoff for provider limits, and clear resume commands.

## JSON Quality Gates

Every promoted chunk must preserve source text exactly. Chinese Hanzi tokens are one character each with pinyin. Japanese kanji tokens are one character each with furigana. Nontrivial Japanese lines must use normal mixed kanji/kana, not kana-only placeholders.

For classical Chinese texts, bracketed notes such as `〈 ... 〉`, inline commentary, variant readings, and punctuation are source text. They must be included in the Chinese token stream and must not be silently skipped as "comments".

For grammar coloring, assign `g` using only: `subject`, `predicate`, `object`, `attributive`, `adverbial`, `complement`, `topic`, `function`. Color PDFs depend on these fields: every Chinese Hanzi token and every Japanese kanji token should carry `g`. Blackwhite builds should force all grammar colors to black through the renderer, not by deleting `g`.

## Completion Evidence

Report chunk totals, valid/reviewed count, failed or stale count, first missing chunk, latest PDF paths, and the exact resume command. Verify PDFs exist on disk and that generated TeX contains grammar color macros for color builds. Commit tracked scripts, templates, plans, and stable JSON checkpoints after meaningful edits.
