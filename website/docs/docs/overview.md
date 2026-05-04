# Overview

AgInTiFlow is a web-first agent platform and CLI for controlled automation. It combines model routing, browser control, shell execution, workspace file tools, Docker sandboxing, artifacts, and resumable sessions into one inspectable control plane.

The project is designed for practical engineering work: write code, patch files, run checks, compile documents, inspect websites, manage tmux sessions, and keep a durable record of what happened.

## Product Shape

| Layer | Purpose |
| --- | --- |
| CLI | Codex-style interactive chat from any project folder. |
| Web UI | Visual control panel for runs, logs, settings, artifacts, and session history. |
| Agent runner | Plans, calls tools, records events, and resumes sessions. |
| Workspace tools | `inspect_project`, `read_file`, `search_files`, `write_file`, and `apply_patch`. |
| Runtime modes | Host, Docker read-only, Docker workspace, and tmux for persistent host processes. |
| Model routing | Text routing via DeepSeek and Venice, with OpenAI fallback; image routing via GRS AI and Venice, plus mock mode for tests. |

## Core Principles

- The project folder is the unit of work.
- CLI and web share the same `.sessions/` store.
- File edits are deterministic, guarded, and diffed.
- Shell commands are visible in logs and policy checked.
- Docker can be practical without pretending it is the only runtime.
- Cheap model calls can be spent on scouts and context maps, but the executor still verifies exact files.

## Common Workflows

- Start a project with `aginti init`.
- Chat in the terminal with `aginti`.
- Launch the web UI with `aginti web --port 3210`.
- Ask for code changes, tests, plots, LaTeX PDFs, website previews, or system diagnosis.
- Resume any session from CLI or web.

## Where State Lives

| Path | Meaning |
| --- | --- |
| `AGINTI.md` | Editable project instructions and durable preferences. |
| `.aginti/.env` | Ignored local provider keys, mode preferences, and safe local config. |
| `.aginti/codebase-map.json` | Cached project overview for large-codebase tasks. |
| `.sessions/` | Session state, events, artifacts, inbox, chat history, and web settings. |

## Next Pages

Start with [Quick Start](#/quick-start), then read [Interactive CLI](#/cli), [Web UI](#/web-ui), and [Runtime Modes](#/runtime-modes).
