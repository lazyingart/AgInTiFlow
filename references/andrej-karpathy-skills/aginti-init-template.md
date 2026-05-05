# Proposed High-Quality `AGINTI.md` Template

This is a proposed future default for `aginti init`. It is inspired by the discipline of `andrej-karpathy-skills`, but adapted to AgInTiFlow’s project-aware runtime, file tools, sessions, artifacts, SCS, AAPS, and sandbox policy.

```markdown
# AGINTI.md

Project instructions for AgInTiFlow agents.

This file is durable project memory. Keep useful project-specific operating rules here. Do not store secrets; put local keys in `.aginti/.env`.

## Project Identity

- Project name:
- What this project does:
- Primary users:
- Main workflows to preserve:
- Explicit non-goals:

## Current Priorities

- 

## Agent Operating Contract

- Inspect before editing: read this file, relevant README/docs, manifests, entry points, tests, and exact files related to the request.
- State assumptions when the request is ambiguous. If multiple interpretations would lead to different implementations, ask or present options before editing.
- Prefer the smallest coherent change that solves the user’s actual request.
- Do not add speculative features, abstractions, configurability, rewrites, or broad refactors unless requested.
- Do not change adjacent formatting, comments, naming, or style just because it looks improvable.
- Every changed line should trace to the task or to cleanup caused by the task.
- Match existing project style even if another style is personally preferable.
- If you notice unrelated issues, report them separately rather than editing them.

## Verification Contract

For non-trivial work, define success criteria before implementation:

- Target behavior:
- Files or surfaces likely affected:
- Verification command(s):
- Manual checks, if needed:

Preferred loop:

1. Reproduce or inspect the issue.
2. Make the smallest coherent change.
3. Run focused checks.
4. Repair failures caused by the change.
5. Summarize changed files, checks run, and residual risks.

Do not claim success without a concrete check, unless no check exists and that limitation is stated.

## Permission And Safety Contract

- Current project folder writes are allowed when file tools are enabled.
- Do not write outside this project unless the user explicitly asks and the runtime permits it.
- Never print or store secrets in logs, docs, commits, screenshots, or artifacts.
- Do not edit `.git`, `.env`, dependency caches, generated vendor folders, or large binary files unless explicitly requested.
- Destructive actions, host maintenance, sudo, publishing, deployment, and broad cleanup require explicit user intent and the appropriate runtime mode.
- If blocked by policy, stop and suggest the safest rerun command instead of trying command variants.

## File And Artifact Policy

- Use descriptive, non-conflicting filenames for generated docs, stories, images, reports, screenshots, and artifacts.
- Avoid generic names such as `output.txt`, `story.txt`, or `result.png` unless the user asked for that exact path.
- Do not overwrite existing files unless the user asked to update, replace, patch, or overwrite them.
- Keep durable outputs in project folders where the user can find them.

## Commands

Fill these in as the project becomes known.

- Install:
- Build:
- Test:
- Lint:
- Typecheck:
- Format:
- Preview/run:
- Deploy/publish:

## Architecture Notes

- Main entry points:
- Important directories:
- Generated directories:
- Files agents should avoid:
- External services:

## Style And Conventions

- Language/runtime:
- Package manager:
- Formatting style:
- Test framework:
- Error handling style:
- Naming conventions:

## Task-Specific Notes

- 

## Definition Of Done

A task is done when:

- The requested behavior is implemented or the blocker is clearly reported.
- Relevant checks were run, or missing checks are stated.
- The diff is scoped to the request.
- Generated artifacts are named clearly.
- Git status and residual risks are summarized when relevant.
```

## Why This Template Is Better

The current default `AGINTI.md` is short and easy to read, but it does not force the agent to encode the most important operational habits. This template gives the agent a project-local checklist that maps directly to common failure modes:

- wrong assumptions
- overengineering
- unrelated edits
- missing verification
- accidental overwrite
- permission confusion
- hidden secrets

## How To Keep It Practical

The template should not become a burden. `aginti init` can present it as a useful starting point, and users can delete irrelevant sections. For tiny projects, a `minimal` template can still exist. For serious coding projects, this disciplined version should be the default.

