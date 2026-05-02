---
id: github-maintenance
label: GitHub And Release Maintenance
description: Use git and gh safely for status, commits, pull requests, releases, and repository maintenance.
triggers:
  - git
  - github
  - gh
  - commit
  - push
  - pull request
  - release
tools:
  - run_command
  - read_file
  - apply_patch
  - web_search
---
# GitHub And Release Maintenance

Always inspect `git status --short` and relevant diffs before committing or pushing. Keep commits scoped and stop on conflicts, divergence, or unrelated dirty work.

Use `gh` for PR/release/status workflows when authenticated. Fold long command output but preserve key errors, URLs, branch names, and commit hashes.
