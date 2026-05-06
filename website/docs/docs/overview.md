# Overview

AgInTiFlow is a project-aware, low-cost agent workspace for real-life problems. It combines Web, CLI, and API entry points with DeepSeek/Venice/OpenAI routing, browser control, shell execution, workspace file tools, Docker sandboxing, visible tool calls, durable sessions, scouts, SCS supervision, AAPS workflows, and artifacts into one inspectable control plane.

The project is designed for practical work across lab planning, data analysis, hardware control, production scripts, writing, coding, documents, websites, tmux sessions, and durable evidence.

## CLI And Web Together

| CLI launch | Web console run output |
| --- | --- |
| ![AgInTiFlow CLI launch screen](../assets/screenshots/cli-launch.jpg) | ![AgInTiFlow web console conversation and run output](../assets/screenshots/web-console-conversation-run-output.jpg) |

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
- CLI and web share durable project sessions.
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
| `.aginti-sessions/` | Project-local session index and compatibility metadata. |
| `~/.agintiflow/sessions/` | Central session state, events, artifacts, inbox, chat history, and web settings. |

## Next Pages

Start with [Quick Start](#/quick-start), then read [Interactive CLI](#/cli), [Web UI](#/web-ui), and [Runtime Modes](#/runtime-modes).
