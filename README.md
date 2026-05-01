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

AgInTiFlow is AgInTi's web-first agent platform for controlled website automation, persistent conversations, resumable runs, guarded local commands, and optional coding-agent wrappers.

It is designed for workflows where an AI agent should act, but every tool, log, and session state should remain inspectable.

## Product Snapshot

| Area | Direction |
| --- | --- |
| Core loop | Plan -> use tools -> log events -> finish or resume |
| Browser control | Playwright, lazy browser startup, domain allowlists |
| Model layer | Smart routing over DeepSeek fast/pro presets with manual OpenAI-compatible fallback |
| Local tools | Guarded workspace file tools, optional shell commands, Docker sandbox support, and advisory agent wrappers |
| Memory | Session state, persisted web settings, chat continuation |
| Operator UX | Multilingual web UI with provider selection, run output, and conversation history |

## Quick Start

Install the published CLI:

```bash
npm install -g @lazyingart/agintiflow
aginti --list-routes
aginti --sandbox-status --sandbox-mode docker-readonly --cwd "$PWD"
```

Launch the local web UI from an installed package:

```bash
aginti web --port 3210
# then open http://127.0.0.1:3210
```

Run the installed CLI without a live provider key by using the local mock route:

```bash
aginti --provider mock --routing manual --allow-shell --cwd "$PWD" "Report the current directory"
```

Run from a source checkout:

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

Use the dedicated CLI entrypoint:

```bash
npx aginti-cli --routing smart --allow-shell "List this folder"
npx aginti-cli --list-routes
npx aginti-cli --list-wrappers
npx aginti-cli --sandbox-status --sandbox-mode docker-readonly --cwd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npx aginti-cli --sandbox-preflight --sandbox-mode docker-readonly --cwd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
```

Start from a URL:

```bash
npm start -- --start-url https://news.ycombinator.com "Summarize this page"
```

Resume a run:

```bash
npm start -- --resume your-session-id
```

The package exposes both `aginti` and `aginti-cli`; they run the same CLI entrypoint.

## Web UI

The web app includes:

- Routing dropdown for smart, fast, complex, and manual model selection.
- Provider dropdown for DeepSeek, OpenAI, and local mock mode when manual routing is needed.
- Language dropdown with 11 persisted UI locales.
- Editable model field, with DeepSeek v4 flash as the fast default and DeepSeek v4 pro as the complex route.
- Goal, start URL, allowed domains, working directory, and max-step controls.
- Sandbox mode, Docker image/status, package-install approval state, safe setup warnings, and recent sandbox logs.
- Wrapper capability panel with an opt-in wrapper toggle and a preferred-wrapper selector defaulting to Codex.
- Workspace Files panel showing file tools, recent file changes, blocked write attempts, hashes, and compact diffs.
- Toggleable shell tool, agent wrappers, headless browser, password typing, and destructive actions.
- Persistent conversation panel above compact runtime logs, so follow-up messages stay close to the top.
- Conversation manager modal for auto-renaming, manual renaming, and deleting saved chat history.

`Start URL` is only a suggestion. The browser opens only when the model chooses a browser tool.

## Website

In the source repository, the marketing website lives in `website/`, is published at `https://flow.lazying.art`, and is separate from the app UI in `public/`.

```bash
python3 -m http.server 4310 --directory website
node scripts/capture-website-screenshots.js
```

The screenshot script captures the live app at `http://127.0.0.1:3210/` by default and writes carousel assets to `website/assets/screenshots/`.
GitHub Pages deploys the `website/` directory through `.github/workflows/pages.yml`; `website/CNAME` sets the custom domain to `flow.lazying.art`.

## Safety Model

AgInTiFlow is intentionally conservative:

- Password typing is blocked unless explicitly enabled.
- Destructive browser actions are blocked unless explicitly enabled.
- Shell commands are disabled unless the shell tool is enabled.
- Workspace file tools stay inside `commandCwd` and block `.env`, secret-like paths, `.git`, node_modules writes, absolute escapes, binary files, and huge files.
- File writes record before/after SHA-256 hashes and compact redacted diffs.
- Guarded shell mode only allows inspection, test/build checks, and approved setup commands.
- Docker read-only mode mounts the workspace read-only and disables container network access.
- Docker workspace-write mode is required for approved package or environment setup.
- Package installs default to `prompt`, so npm/pip/conda/venv setup is blocked until explicitly approved.
- NPM publishing, npm token commands, sudo, destructive git actions, curl/wget, and shell chaining are blocked.
- NPM tokens and API keys are redacted from tool logs and API responses.
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
ALLOW_FILE_TOOLS=true
SANDBOX_MODE=docker-readonly
PACKAGE_INSTALL_POLICY=prompt
USE_DOCKER_SANDBOX=true
DOCKER_SANDBOX_IMAGE=agintiflow-sandbox:latest
COMMAND_CWD=/home/lachlan/ProjectsLFS/Agent
```

Defaults:

| Route | Provider | Default model | Override |
| --- | --- | --- | --- |
| `smart` | DeepSeek | Fast for normal tasks, pro for complex tasks | `AGENT_ROUTING_MODE=smart` |
| `fast` | DeepSeek | `deepseek-v4-flash` | `DEEPSEEK_FAST_MODEL` |
| `complex` | DeepSeek | `deepseek-v4-pro` | `DEEPSEEK_PRO_MODEL` |
| `manual` | DeepSeek/OpenAI | user supplied | `AGENT_PROVIDER`, `LLM_MODEL` |

Provider credentials:

| Provider | API key | Base URL |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` |

## Agent Wrappers

AgInTiFlow can expose external coding agents as advisory tools when `ALLOW_WRAPPER_TOOLS=true` or the web UI toggle is enabled. Wrappers are not a replacement for the core runner; they are used for second opinions, codebase analysis, or planning when they are installed and authenticated. The preferred wrapper defaults to Codex and can be changed with `PREFERRED_WRAPPER=codex`, `aginti --allow-wrappers --wrapper codex`, or the web UI dropdown.

Current wrappers:

| Wrapper | Command | Safety mode |
| --- | --- | --- |
| Codex | `codex exec` | read-only sandbox, primary `gpt-5.5` medium, spare `gpt-5.4-mini` high |
| Claude Code | `claude --print` | plan permission mode |
| Gemini CLI | `gemini` | advisory prompt |
| GitHub Copilot CLI | `gh copilot` | advisory prompt |
| Qwen Code | `qwen` | plan approval mode |

Wrapper prompts are capped and filtered for destructive intent unless destructive actions are explicitly enabled.

## npm Release Safety

AgInTiFlow is published as `@lazyingart/agintiflow`.

Preferred release path:

1. Bump `package.json` version.
2. Run `npm test` and `npm pack --dry-run`.
3. Create a GitHub Release or run `.github/workflows/npm-publish.yml` manually.
4. Let npm Trusted Publishing use GitHub Actions OIDC and `npm publish --access public --provenance`.

Trusted Publishing setup on npm:

```bash
npm install -g npm@^11.5.1
npm trust github @lazyingart/agintiflow --repo lazyingart/AgInTiFlow --file npm-publish.yml
```

The npm trust command may require the package to exist first and may require an OTP in the browser/account flow. Do not commit `.npmrc`, `.env`, npm tokens, OTPs, or npm debug logs.

Local token fallback is only for bootstrapping when Trusted Publishing cannot be used:

```bash
cp .env.example .env
# Put NPM_TOKEN or NODE_AUTH_TOKEN in .env locally only.
set -a && source .env && set +a
npm publish --access public
```

Never publish with `npm publish` from inside an agent run. The runtime command policy blocks npm publish and npm token commands by design.

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

## Sandbox Modes

| Mode | Workspace mount | Network | Intended use |
| --- | --- | --- | --- |
| `host` | local process | host network | legacy read-only inspection only |
| `docker-readonly` | read-only `/workspace` | none | default safe coding inspection and tests |
| `docker-workspace` | writable `/workspace` | none by default, enabled only for approved package installs | environment setup inside the mounted project |

Package policy values:

| Policy | Behavior |
| --- | --- |
| `block` | Always block npm/pip/conda/venv setup. |
| `prompt` | Return a clear approval-required error; the UI can switch to approved. |
| `allow` | Permit allowlisted setup commands only in `docker-workspace`. |

Safe preflight endpoints:

```bash
curl http://127.0.0.1:3210/api/sandbox/status
curl -X POST http://127.0.0.1:3210/api/sandbox/preflight \
  -H 'Content-Type: application/json' \
  -d '{"sandboxMode":"docker-readonly","buildImage":true}'
curl http://127.0.0.1:3210/api/workspace/changes
```

These endpoints report Docker/image/workspace readiness, recent sandbox logs, and recent file-change provenance without returning API keys or npm tokens.

Credential-free API smoke test:

```bash
npm run smoke:web-api
```

The smoke script starts the web server on a random localhost port, checks `/api/config`, `/api/sandbox/status`, `/api/sandbox/preflight`, runs one mock agent task, and verifies persisted chat history.

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
├── bin/                    # aginti/aginti-cli entrypoint
├── logos/                  # Brand assets and crop notes
├── references/             # Design philosophy and research notes
├── tools/                  # Reusable project documentation helpers
├── website/                # Static marketing site and screenshot carousel
├── run.js                  # CLI entrypoint
└── web.js                  # Express web server
```

## Development

```bash
npm run check
npm run smoke:web-api
npm run smoke:coding-tools
npm test
```

`npm run check` validates JavaScript syntax for the CLI, web server, and runtime modules. The smoke scripts use the local mock provider, so they do not require DeepSeek or OpenAI credentials.

## Prompt Tools

This repo includes small prompt helpers for repeatable documentation and i18n work:

```bash
node tools/readme_prompt_tool.js agintiflow
node tools/readme_prompt_tool.js aginti-landing
node tools/webapp_i18n_prompt_tool.js
```

The README helper captures the documentation style used here: concise overview, full language links, product signals, quick start, safety notes, and localized README targets. The webapp i18n helper captures the full UI translation key contract for future language backfills.
