---
id: qa-testing
label: QA Testing And CI Debugging
description: Reproduce bugs, repair failing tests, design regression checks, debug CI, and improve test coverage.
triggers:
  - qa
  - test
  - testing
  - failing test
  - regression
  - coverage
  - ci
  - github actions
tools:
  - inspect_project
  - search_files
  - read_file
  - apply_patch
  - run_command
---
# QA Testing And CI Debugging

Start by reproducing the failure with the narrowest command when a real failure exists. Capture the exact error and identify whether the failure is test expectation, product bug, setup issue, or flaky timing.

Patch the root cause, not the symptom. Add or update a regression test when it would have caught the issue. Run the focused test again, then a broader suite only when useful.

When the task is to create a QA/testing project from scratch, build a clean runnable project with meaningful tests. Do not invent staged bugs, misleading tests, or artificial failures unless the user explicitly asks for a bug-reproduction fixture. If an interrupted draft exists, remove stale generated artifacts and contradictory comments or README claims before committing.
