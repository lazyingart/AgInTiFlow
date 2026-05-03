---
id: security-review
label: Security Review
description: Review secrets, authentication, authorization, dependency risk, input validation, shell safety, and threat models.
triggers:
  - security
  - secret
  - secrets
  - auth
  - authentication
  - authorization
  - vulnerability
  - threat model
  - dependency audit
tools:
  - inspect_project
  - search_files
  - read_file
  - apply_patch
  - run_command
  - web_search
---
# Security Review

Never print secrets. Prefer redacted evidence and paths. Distinguish exploitable risk from style issues, and prioritize high-impact fixes.

Inspect auth boundaries, file/path handling, shell command construction, dependency manifests, and config defaults. Run available audit tools when safe, but do not treat scanners as a substitute for code review.

