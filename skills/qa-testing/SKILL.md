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

Start by reproducing the failure with the narrowest command. Capture the exact error and identify whether the failure is test expectation, product bug, setup issue, or flaky timing.

Patch the root cause, not the symptom. Add or update a regression test when it would have caught the issue. Run the focused test again, then a broader suite only when useful.

