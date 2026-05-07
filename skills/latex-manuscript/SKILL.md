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
  - writing_specialist
  - write_file
  - apply_patch
  - run_command
  - open_workspace_file
  - send_to_canvas
  - web_search
---
# LaTeX Manuscript

Use a project subfolder with `main.tex`, figures, bibliography, and generated PDFs. Compile from the correct directory with `latexmk` or `pdflatex` when available.

Use `writing_specialist` for substantial abstract/introduction/discussion/argument prose before converting the result into LaTeX. Keep TeX commands, citations, labels, package choices, figures, and compilation in the main agent.

If TeX is missing, produce an honest setup note or Docker-local setup plan instead of faking success. Send the final PDF or source to canvas when useful.
