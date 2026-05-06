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

For local workflow practice or repository setup, prefer a disposable subdirectory if the user did not clearly target the current repository. Configure only local git identity (`git config user.name`, `git config user.email`) inside that repo; never change global git config. Use policy-friendly local commands: `git switch <branch>` or `git checkout <branch>` for existing branches, `git switch -c <branch>` or `git checkout -b <branch>` for new branches, `git merge --ff-only <branch>` for fast-forward evidence, and `git merge --no-ff --no-edit <branch>` for explicit merge-commit evidence. Avoid plain `git merge <branch>` because it can hang on an editor or make an ambiguous merge. Use accurate git scenarios: a fast-forward merge means the target branch has not diverged; a non-fast-forward merge intentionally creates a merge commit after both branches diverge; a rebase rewrites local branch commits and should be used only in an explicitly disposable/local branch or after user approval.

Use `gh` for PR/release/status workflows when authenticated. Fold long command output but preserve key errors, URLs, branch names, and commit hashes.
