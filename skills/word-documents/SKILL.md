---
id: word-documents
label: Microsoft Word Documents
description: Edit, convert, inspect, or generate Word-style documents using available local tools.
triggers:
  - word
  - docx
  - microsoft word
  - office
  - pandoc
  - libreoffice
tools:
  - read_file
  - write_file
  - run_command
  - send_to_canvas
---
# Microsoft Word Documents

Prefer safe conversions through available tools such as `pandoc`, `libreoffice`, or Python libraries when installed. Preserve originals; write converted or edited outputs to a new file unless overwrite is explicit.

If binary `.docx` content cannot be inspected directly, explain the needed converter and create a project-local script or setup note.

For a repository handoff or generated document project:

- synthesize the authoritative current state instead of narrating superseded values unless history was requested;
- keep editable source plus the requested reader format, normally DOCX and a phone-readable PDF;
- provide and document a conventional project-local `build.sh` entry point, even when it delegates to a Python or TeX implementation;
- make a clean-checkout build provision or clearly verify its dependencies rather than relying silently on the current shell;
- preserve source inputs byte-for-byte and keep session data, visual-inspection renders, LaTeX intermediates, caches, and other transient evidence ignored; prefer ignore rules over deleting evidence, and never couple cleanup commands to the build or validation command;
- validate extracted DOCX/PDF text for current facts, stale or private values, encoding damage, and missing action/evidence content;
- render every PDF page and inspect it for clipping, overlap, orphaned headings, sparse spill pages, readable margins, and phone-scale readability;
- when the task is in a git repository and requests a finished handoff, commit only intentional project files and finish with a clean worktree unless the user says not to commit.

Visual polish does not establish content quality. Cross-check names, dates, totals, counts, statuses, decisions, actions, risks, evidence, and limitations against the source material before completion.
