# Repository Guidelines

## Project Structure & Module Organization

`run.js` is the legacy CLI entrypoint, `bin/aginti-cli.js` is the packaged CLI, and `web.js` serves the local UI. Core runtime logic lives in `src/`: `agent-runner.js` orchestrates the loop, `model-client.js` defines model/tool interactions, `model-routing.js` owns routing presets, `tool-wrappers.js` owns external agent wrapper contracts, `guardrails.js` enforces safety checks, `snapshot.js` captures browser state, and `session-store.js` persists runs under `.sessions/`. Frontend assets for the local UI live in `public/` (`index.html`, `app.js`, `styles.css`).

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npx playwright install chromium`: install the browser runtime used by Playwright.
- `npm start -- "your task"`: run the CLI agent.
- `npx aginti-cli --list-routes`: inspect routing presets.
- `npx aginti-cli --list-wrappers`: inspect installed wrapper availability.
- `npx aginti-cli --sandbox-status --sandbox-mode docker-readonly`: inspect Docker sandbox readiness.
- `npx aginti-cli --sandbox-preflight --sandbox-mode docker-readonly`: run safe Docker dependency checks.
- `npm run web`: start the local web UI on `http://127.0.0.1:3210`.
- `npx aginti-cli web --port 3210`: start the packaged web UI path.
- `npm run check`: run syntax checks for `run.js`, `web.js`, and all files in `src/`.
- `npm run smoke:web-api`: start a temporary web server and verify config, sandbox, mock run, and persisted chat APIs without live model credentials.
- `npm pack --dry-run`: inspect npm package contents before release.

Use `AGENT_PROVIDER=openai`, `AGENT_PROVIDER=deepseek`, or `AGENT_PROVIDER=mock` when running locally.

## Coding Style & Naming Conventions

Use ES modules, 2-space indentation, and semicolons, matching the existing JavaScript files. Prefer small single-purpose modules in `src/`. Use kebab-free lowercase filenames such as `session-store.js` and descriptive function names such as `resolveRuntimeConfig` or `captureSnapshot`. Keep browser and shell guardrails explicit rather than clever.

## Testing Guidelines

There is no full automated test suite yet. Treat `npm run check` plus `npm run smoke:web-api` as the minimum required gate before committing. For behavior changes, do one manual smoke test through either the CLI or the web UI. If you add tests later, place them in a dedicated `test/` directory and name them after the module under test, for example `guardrails.test.js`.

## Commit & Pull Request Guidelines

Commit messages in this repo currently follow short imperative style, for example `Make browser startup lazy and shell-first`. Keep commits focused and explain user-visible behavior changes in the body when needed. Pull requests should include:

- a short summary of what changed
- any environment or model assumptions
- screenshots for `public/` or `web.js` UI changes
- a brief manual test note, such as `npm run check` and one sample prompt

## Security & Configuration Tips

Never hard-code API keys. Use environment variables like `OPENAI_API_KEY` and `DEEPSEEK_API_KEY`. Do not expose provider defaults that include API keys through web APIs. Keep wrapper tools advisory and opt-in; do not remove read-only/planning defaults without documenting the risk. Keep npm publish and token commands blocked inside agent runs. Prefer Trusted Publishing through `.github/workflows/npm-publish.yml`; local npm tokens may only live in ignored `.env` or `.npmrc` files and must never be printed or committed. Package installs or venv/conda/npm setup must require the package policy and Docker workspace-write mode. Do not weaken guardrails in `src/guardrails.js` or `src/command-policy.js` without documenting why. Do not commit `.sessions/` artifacts.
