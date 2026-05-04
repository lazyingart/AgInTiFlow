---
id: code-review
label: Code Review And Architecture Review
description: Review diffs or codebases for bugs, regressions, design risks, maintainability, missing tests, and architecture issues.
triggers:
  - review
  - code review
  - architecture review
  - pr review
  - audit code
  - inspect changes
tools:
  - inspect_project
  - search_files
  - read_file
  - run_command
  - web_search
---
# Code Review And Architecture Review

Prioritize findings over summary. Inspect changed files, neighboring code, tests, and runtime assumptions. Report concrete risks with file paths, reproduction evidence, and suggested fixes.

Use a bounded review loop:

1. Start with git status/diff and project instructions or manifests.
2. Read high-signal files first: changed files, entry points, tests, package/build configs, and nearby code needed to prove a risk.
3. Avoid full-tree reads and generated/vendor/cache/binary folders such as `.git`, `node_modules`, `dist`, `build`, `target`, `coverage`, `.venv`, `__pycache__`, `.aginti-sessions`, `.sessions`, and artifacts.
4. Cap discovery at two passes unless a concrete finding needs one more neighboring file.
5. Run focused non-destructive checks when useful; do not install dependencies or run long broad suites for a review unless clearly justified.

If no findings are found, say that clearly and name residual risk or missing test coverage. Do not rewrite code during a review unless the user asks for fixes.
