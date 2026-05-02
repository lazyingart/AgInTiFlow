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

For plots and artifacts, save files with clear names and send useful outputs to canvas.
