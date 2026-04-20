# AgInTiFlow

AgInTiFlow is AgInTi's website-control agent for browser automation, persistent chat, resumable runs, and guarded local tools.

What it keeps:

- a small, explicit browser tool surface
- a planning pass before execution
- resumable local sessions
- structured JSONL event logs
- pre-tool guardrails
- provider abstraction for OpenAI and DeepSeek
- optional guarded shell commands for simple terminal inspection
- lazy browser startup so browser work begins only when the model chooses a browser tool

## Install

```bash
cd /home/lachlan/ProjectsLFS/Agent/website-control-agent
npm install
npx playwright install chromium
```

## Run

CLI, OpenAI:

```bash
AGENT_PROVIDER=openai npm start -- "Open Hacker News and tell me the top 3 titles"
```

CLI, DeepSeek:

```bash
AGENT_PROVIDER=deepseek npm start -- "Open GitHub and summarize the landing page"
```

Web UI:

```bash
npm run web
```

Start from a URL:

```bash
npm start -- --start-url https://news.ycombinator.com "Summarize this page"
```

Resume an earlier run:

```bash
npm start -- --resume your-session-id
```

## Useful Environment Variables

```bash
AGENT_PROVIDER=openai
LLM_MODEL=gpt-5.4-mini
MAX_STEPS=15
HEADLESS=false
ALLOWED_DOMAINS=news.ycombinator.com,github.com
ALLOW_PASSWORDS=false
ALLOW_DESTRUCTIVE=false
ALLOW_SHELL_TOOL=false
COMMAND_CWD=/home/lachlan/ProjectsLFS/Agent
```

Defaults:

- OpenAI: `OPENAI_API_KEY`, `https://api.openai.com/v1`, `gpt-5.4-mini`
- DeepSeek: `DEEPSEEK_API_KEY`, `https://api.deepseek.com/v1`, `deepseek-chat`

## Web UI

The web UI runs at `http://127.0.0.1:3210` by default. It gives you:

- provider dropdown: OpenAI or DeepSeek
- editable model field
- goal, start URL, allowed domains, and working directory inputs
- toggles for shell tool, headless mode, passwords, and destructive actions
- live run logs via polling

Behavior note:

- `Start URL` is a suggestion, not an automatic navigation
- if the shell tool can satisfy the prompt, the agent can stay browser-free for the whole run
- headless mode defaults to `true` in the web UI

## Session Artifacts

Each run stores state in `.sessions/<session-id>/`:

- `state.json` for resumable conversation state
- `plan.md` for the execution plan
- `events.jsonl` for structured logs
- `storage-state.json` for browser session persistence
- `artifacts/step-XXX.png` screenshots
- `artifacts/step-XXX.snapshot.json` DOM snapshots

## Safety Model

This agent is intentionally conservative:

- optional domain allowlist
- blocks password typing unless explicitly enabled
- blocks destructive click targets unless explicitly enabled
- blocks shell commands outside a small read-only allowlist
- records every tool request and result

That makes it suitable for internal tools, dashboards, research, and browsing workflows before you move to full computer-use agents.
