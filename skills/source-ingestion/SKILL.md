---
id: source-ingestion
label: Source Ingestion And OCR
description: Inspect mixed input files and convert PDFs, EPUBs, images, scans, web/JSON sources, archives, or unknown documents into useful text, Markdown, manifests, or reviewable artifacts.
triggers:
  - source
  - sources
  - input file
  - convert to markdown
  - extract text
  - pdf
  - ocr
  - scanned
  - epub
  - image text
  - recognition
  - markdown
tools:
  - inspect_project
  - read_file
  - write_file
  - run_command
  - web_search
  - send_to_canvas
---
# Source Ingestion And OCR

Use this skill when the user gives arbitrary source files or asks to read, recognize, OCR, convert, or prepare inputs for another workflow. The task is to make the files usable without assuming they are already text.

## Operating Loop

1. Inventory inputs first. List paths, extensions, sizes, likely language, and whether each file is original media or derived output. Keep original files untouched.
2. Probe before converting:
   - `file`, `stat`, `pdfinfo`, `pdftotext`, `exiftool` when available.
   - EPUB: inspect the archive or use an existing EPUB-to-Markdown script/tool.
   - PDF: try text-layer extraction first; if empty or garbage, mark as image-only and choose OCR.
   - Images/scans: inspect dimensions/orientation and run OCR only after deciding language and page segmentation.
   - JSON/HTML/wiki manifests: read the manifest, follow local `html`, `pdf`, `iiif`, or source fields, and prefer structured extraction over OCR.
   - Archives/directories: expand or enumerate into a durable work folder only when needed.
3. Choose the simplest reliable route. Prefer existing project scripts and installed tools before adding dependencies. Install only when policy allows and record the command.
4. Write durable outputs near the project workflow, usually `books/<id>/sources/markdown/`, `ocr/`, `artifacts/`, or a user-specified path. Use descriptive names; do not overwrite reviewed outputs unless asked.
5. Produce a manifest for nontrivial ingestion. Include source path, sha256, extraction method, status (`complete`, `requires_ocr`, `failed`, `pending`), language, page/chapter counts, output path, and caveats.
6. Validate the result externally: line/character counts, heading counts, boilerplate/debris checks, sample excerpts, and a no-text-layer check for PDFs marked `requires_ocr`.

## OCR And Recognition Strategy

- Treat OCR as a pipeline, not a guess: render pages, crop/deskew if needed, choose language (`chi_sim`, `chi_tra`, `jpn`, `jpn_vert`, `eng`, or combinations), test a small page range, then scale up.
- For large scans, create resumable page-level outputs and a manifest before full OCR. Do not run a fragile all-pages command without logs and resume paths.
- For vertical Japanese or classical Chinese scans, expect tool tuning. If OCR quality is poor, save page images and report that manual/model-assisted correction is required rather than fabricating text.
- Preserve page references in OCR Markdown (`## Page N`) until the text is reviewed; only collapse into chapters after quality checks.

## Expected Outputs

When the downstream task expects Markdown, JSON, or a source bundle, create exactly that shape plus a report:

- Markdown: clean body text with stable headings and paragraphs.
- JSON: schema-valid and validated, not prose pretending to be JSON.
- Source bundle: roles, source hashes, extraction status, and activation rules.
- Report: what was converted, what was not, tools used, validation commands, and residual risks.

## Safety Rules

Do not claim a scanned PDF or image was converted if the output is empty, repeated headers, mojibake, or OCR garbage. Mark it `requires_ocr` or `failed` with evidence. Do not silently delete real content while removing boilerplate. Do not commit original large source media unless the repository already tracks that category and the user asked for it.
