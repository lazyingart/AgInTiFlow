# Quick Start

Install AgInTiFlow globally:

```bash
npm install -g @lazyingart/agintiflow
```

Initialize a project folder:

```bash
mkdir my-agent-project
cd my-agent-project
aginti init
aginti doctor
```

Start interactive chat:

```bash
aginti
```

Start the web UI:

```bash
aginti web --port 3210
```

Open `http://127.0.0.1:3210`.

## Auto-update (optional)

Interactive `aginti`/`aginti web` startup can check for newer package versions.
If you choose not to update, the feature is fully opt-in: you can skip a run, skip a release, or disable auto-update with `--no-auto-update` or `AGINTIFLOW_NO_AUTO_UPDATE=1`, and AgInTiFlow continues in normal mode.

```bash
aginti update
AGINTIFLOW_NO_AUTO_UPDATE=1 aginti
```

## First Useful Prompts

```text
list this project and explain what is inside
write a small Python CLI app with tests
create a beautiful static website and preview it
write a LaTeX report with a figure and compile it
inspect git status and prepare a safe commit summary
```

## Provider Keys

On first use, AgInTiFlow asks for a main provider key. DeepSeek is the normal default, with Venice and OpenAI available as alternatives. For image tools, enable GRS AI or Venice image models.

```bash
aginti auth
aginti auth deepseek
aginti keys status
```

Keys are saved to `.aginti/.env` with local file permissions. The CLI and web API report only boolean availability and masked previews.

## Mock Mode

Use mock mode for deterministic tests or demos without model credits:

```bash
aginti --provider mock --routing manual --allow-file-tools "Create notes/hello.md with a smoke note"
```

Mock mode exercises the same run/session/tool path without calling DeepSeek or OpenAI.

## Default Runtime

The interactive CLI defaults to Docker workspace mode with package installs allowed inside the container. This is useful for Python, Node, plotting, and LaTeX tasks while keeping host installs separate.

Switch host mode only when you intend to operate directly on the host:

```text
/docker off
```
