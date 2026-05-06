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

## Evidence Rules

- Do not label a finding HIGH or CRITICAL from pattern matching alone. A high-severity claim needs either a reproduced exploit, a direct code path proof, or a clearly stated "potential/unverified" label with lower severity.
- For path traversal, SSRF, command injection, open redirect, auth bypass, and file disclosure, test a minimal negative case when a safe local command is available. If runtime policy blocks the test, report the blocker and keep severity conservative.
- Exclude generated/vendor/session/cache directories such as `node_modules/`, `.sessions/`, `.aginti-sessions/`, `.aginti-thorough-tests/`, build outputs, and coverage when broad scanning. If a scan accidentally includes them, call that out as noisy evidence and do not base severity solely on those hits.
- When a policy blocks `.env`, key, credential, or permission checks, treat that as a safety limitation. Do not retry variants to bypass the block and do not imply the file content was inspected.
- Prefer bounded commands: `rg`/`grep` with explicit `--exclude-dir`, `head`, `timeout`, and project-relative paths. Avoid unbounded recursive scans over the whole workspace.
- Reports should separate confirmed findings, potential findings, false positives, and limitations. Include verification commands and observed results for every high-severity item.
