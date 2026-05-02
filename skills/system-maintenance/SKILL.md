---
id: system-maintenance
label: System Maintenance
description: Diagnose and repair local system, shell, package, Docker, conda, Python, R, and toolchain problems.
triggers:
  - system
  - install
  - package
  - docker
  - conda
  - environment
  - fix computer
  - error
tools:
  - run_command
  - write_file
  - web_search
  - send_to_canvas
---
# System Maintenance

Diagnose first with read-only commands. Prefer Docker/project-local scripts and `/aginti-env` for broad toolchain setup. Host-level sudo or destructive operations require explicit user approval outside normal automation.

For complicated setup, write idempotent scripts, run syntax checks, and report exact next safe command.
