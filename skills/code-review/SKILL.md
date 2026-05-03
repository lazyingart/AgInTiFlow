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

If no findings are found, say that clearly and name residual risk or missing test coverage. Do not rewrite code during a review unless the user asks for fixes.

