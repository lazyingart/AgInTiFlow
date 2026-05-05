---
id: python
label: Python Development
description: Build Python packages, CLIs, scripts, tests, notebooks, plotting, and data workflows.
triggers:
  - python
  - pytest
  - pyproject
  - pip
  - uv
  - matplotlib
  - pandas
tools:
  - inspect_project
  - search_files
  - apply_patch
  - run_command
  - send_to_canvas
---
# Python Development

Inspect `pyproject.toml`, requirements, package layout, and tests. Prefer stdlib tests when dependency installs are unnecessary; otherwise use project-local venv/conda/uv or Docker.

When reporting syntax, lint, test, or runtime results, always include the actual interpreter path/version and whether commands ran on the host or in Docker/venv. `py_compile` only proves the active interpreter accepted the files.

For compatibility claims, avoid grep-only feature scans. Treat these as version-sensitive unless the target interpreter is tested: f-strings require Python 3.6+, `:=` requires 3.8+, builtin generic hints such as `list[int]` require 3.9+ unless postponed annotations are used, `match/case` and `X | Y` type unions require 3.10+, `except*`/`ExceptionGroup` require 3.11+, and PEP 701 relaxed f-strings (backslashes, comments, or previously invalid quoting/nesting inside f-string expressions) require 3.12+. If host compatibility matters and only Docker was tested, state that limitation instead of saying the code is safe on the host.

For plots and artifacts, save files with clear names and send useful outputs to canvas.
