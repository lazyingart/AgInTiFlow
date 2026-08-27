---
id: presentation-slides
label: Slides And Presentations
description: Create slide decks, pitch decks, posters, lecture materials, and presentation outlines.
triggers:
  - slides
  - presentation
  - powerpoint
  - pptx
  - deck
  - pitch deck
  - poster
  - lecture
tools:
  - read_file
  - write_file
  - run_command
  - send_to_canvas
  - web_search
---
# Slides And Presentations

Infer audience, goal, length, and tone from the request and available project context. Ask only when a missing fact materially changes the deck. Build a durable outline before slide text. Keep slides visually sparse: one message and usually one figure, table, or story per slide.

Use the workspace's established presentation tooling when it exists. Otherwise choose editable PPTX, HTML, Markdown, or LaTeX Beamer tooling that can be rebuilt locally. Keep essential titles, claims, labels, citations, and body text editable. Image generation may supply bounded visual assets, but never use one generated bitmap as a complete slide or slide background.

Ground claims and calculations in the supplied sources. Preserve a reproducible source or build script and speaker notes when they improve delivery. Produce only the requested artifacts, with descriptive stable filenames. If the user supplied an exact validator or acceptance command, run that exact command after the final rebuild.

Before completion:

1. Rebuild the final deck and every requested export from the current source.
2. Render every slide to a PNG or equivalent preview and inspect the actual images. Check especially wrapped titles, accent rules, clipping, collisions, overflow, unreadably small text, charts, tables, and consistent framing.
3. Verify that the PPTX or source remains editable, exported files open, slide and PDF page counts agree, calculations match the source data, and no unsupported claims were introduced.
4. In a Git repository, if the task requests a commit, stage intentional source and deliverables, narrowly ignore only transient build or perception evidence, commit the result, then run a fresh `git status --short`.

Do not call the deck complete from a successful build alone. Artifact paths, model-generated visual descriptions, or an earlier clean status are not substitutes for current rendered inspection and final external verification.
