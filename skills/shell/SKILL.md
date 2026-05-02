---
id: shell
label: Shell Scripting
description: Write, audit, and run shell scripts for automation, setup, diagnostics, and maintenance.
triggers:
  - shell
  - bash
  - script
  - terminal
  - command
  - cli
tools:
  - write_file
  - run_command
  - web_search
---
# Shell Scripting

Prefer idempotent scripts with `set -euo pipefail` when appropriate, clear variables, dry-run or validation modes, and `bash -n` checks.

Separate diagnosis from mutation. Keep dangerous host operations explicit and reversible.
