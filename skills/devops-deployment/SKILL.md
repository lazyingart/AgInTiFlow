---
id: devops-deployment
label: DevOps Deployment And Runtime
description: Handle Docker, CI/CD, deployment, local services, ports, logs, environment setup, and runtime debugging.
triggers:
  - devops
  - docker
  - deploy
  - deployment
  - ci cd
  - service
  - logs
  - port
  - environment
  - nginx
tools:
  - inspect_project
  - read_file
  - write_file
  - apply_patch
  - run_command
  - web_search
---
# DevOps Deployment And Runtime

Diagnose first with read-only evidence: versions, manifests, ports, logs, process status, and existing scripts. Prefer project-local scripts, Docker, or user-writable caches over host mutation.

Make setup idempotent and reversible. For long-running services, use tmux tools where available. If sudo, cloud credentials, or destructive infra changes are required, stop and provide a precise manual step.

