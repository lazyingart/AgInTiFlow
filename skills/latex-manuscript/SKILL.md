---
id: latex-manuscript
label: LaTeX Manuscript
description: Write, compile, and package LaTeX papers, reports, figures, bibliographies, and PDFs.
triggers:
  - latex
  - tex
  - manuscript
  - paper
  - pdf
  - figure
  - overleaf
tools:
  - write_file
  - apply_patch
  - run_command
  - open_workspace_file
  - send_to_canvas
  - web_search
---
# LaTeX Manuscript

Use a project subfolder with `main.tex`, figures, bibliography, and generated PDFs. Compile from the correct directory with `latexmk` or `pdflatex` when available.

If TeX is missing, produce an honest setup note or Docker-local setup plan instead of faking success. Send the final PDF or source to canvas when useful.
