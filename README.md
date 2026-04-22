[English](README.md) · [العربية](i18n/README.ar.md) · [Español](i18n/README.es.md) · [Français](i18n/README.fr.md) · [日本語](i18n/README.ja.md) · [한국어](i18n/README.ko.md) · [Tiếng Việt](i18n/README.vi.md) · [中文 (简体)](i18n/README.zh-Hans.md) · [中文（繁體）](i18n/README.zh-Hant.md) · [Deutsch](i18n/README.de.md) · [Русский](i18n/README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="./logos/banner-opaque.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![Playwright](https://img.shields.io/badge/Browser-Playwright-2EAD33?logo=playwright&logoColor=white)
![Express](https://img.shields.io/badge/Web-Express-111827)
![Models](https://img.shields.io/badge/Models-OpenAI%20%2B%20DeepSeek-0ea5e9)
![Sandbox](https://img.shields.io/badge/Shell-Docker%20Sandbox-f97316)
![Status](https://img.shields.io/badge/Status-Prototype-7c3aed)

AgInTiFlow is AgInTi's browser and tool-use agent for controlled website automation, persistent conversations, resumable runs, and guarded local commands.

It is designed for workflows where an AI agent should act, but every tool, log, and session state should remain inspectable.

## Product Snapshot

| Area | Direction |
| --- | --- |
| Core loop | Plan -> use tools -> log events -> finish or resume |
| Browser control | Playwright, lazy browser startup, domain allowlists |
| Model layer | OpenAI-compatible tool calling with OpenAI and DeepSeek presets |
| Local tools | Optional guarded shell commands with Docker sandbox support |
| Memory | Session state, persisted web settings, chat continuation |
| Operator UX | Multilingual web UI with provider selection, run output, and conversation history |

## Quick Start

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

Open `http://127.0.0.1:3210`.

Run a CLI task:

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder and summarize what each project is for"
```

Start from a URL:

```bash
npm start -- --start-url https://news.ycombinator.com "Summarize this page"
```

Resume a run:

```bash
npm start -- --resume your-session-id
```

## Web UI

The web app includes:

- Provider dropdown for OpenAI and DeepSeek.
- Language dropdown with 11 persisted UI locales.
- Editable model field, with DeepSeek as a convenient default.
- Goal, start URL, allowed domains, working directory, and max-step controls.
- Toggleable shell tool, Docker sandbox, headless browser, password typing, and destructive actions.
- Live run logs above a persistent conversation panel.

`Start URL` is only a suggestion. The browser opens only when the model chooses a browser tool.

## Safety Model

AgInTiFlow is intentionally conservative:

- Password typing is blocked unless explicitly enabled.
- Destructive browser actions are blocked unless explicitly enabled.
- Shell commands are disabled unless the shell tool is enabled.
- Guarded shell mode only allows a small set of common inspection commands.
- Docker sandbox mode runs shell commands in a local container with no network.
- Every tool request and result is written to structured logs.

## Configuration

```bash
AGENT_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
OPENAI_API_KEY=...
DEEPSEEK_API_KEY=...
MAX_STEPS=15
HEADLESS=true
ALLOWED_DOMAINS=news.ycombinator.com,github.com
ALLOW_SHELL_TOOL=false
USE_DOCKER_SANDBOX=false
DOCKER_SANDBOX_IMAGE=agintiflow-sandbox:latest
COMMAND_CWD=/home/lachlan/ProjectsLFS/Agent
```

Defaults:

| Provider | API key | Base URL | Default model |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-5.4-mini` |
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | `deepseek-chat` |

## Docker Bootstrap

Ubuntu helper:

```bash
./scripts/install-docker-ubuntu.sh
```

If running as `root` and configuring Docker for a regular user:

```bash
DOCKER_TARGET_USER=lachlan ./scripts/install-docker-ubuntu.sh
```

Open a new login shell, or run `newgrp docker`, before testing non-root Docker access.

## Runtime Artifacts

Each run stores state under `.sessions/<session-id>/`:

| File | Purpose |
| --- | --- |
| `state.json` | Resumable model and tool state |
| `plan.md` | Execution plan |
| `events.jsonl` | Structured event log |
| `storage-state.json` | Browser session persistence |
| `artifacts/step-XXX.png` | Screenshots |
| `artifacts/step-XXX.snapshot.json` | DOM snapshots |

## Project Structure

```text
AgInTiFlow/
├── public/                 # Web UI
├── src/                    # Agent runtime, tools, guardrails, storage
├── docker/                 # Shell sandbox image
├── scripts/                # Docker bootstrap helper
├── logos/                  # Brand assets and crop notes
├── references/             # Design philosophy and research notes
├── tools/                  # Reusable project documentation helpers
├── run.js                  # CLI entrypoint
└── web.js                  # Express web server
```

## Development

```bash
npm run check
```

The check validates JavaScript syntax for the CLI, web server, and runtime modules.

## Prompt Tools

This repo includes small prompt helpers for repeatable documentation and i18n work:

```bash
node tools/readme_prompt_tool.js agintiflow
node tools/readme_prompt_tool.js aginti-landing
node tools/webapp_i18n_prompt_tool.js
```

The README helper captures the documentation style used here: concise overview, full language links, product signals, quick start, safety notes, and localized README targets. The webapp i18n helper captures the full UI translation key contract for future language backfills.
