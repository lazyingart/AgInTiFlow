# Repository Guidelines

## Project Structure & Module Organization

`run.js` is the CLI entrypoint and `web.js` serves the local UI. Core runtime logic lives in `src/`: `agent-runner.js` orchestrates the loop, `model-client.js` defines model/tool interactions, `guardrails.js` enforces safety checks, `snapshot.js` captures browser state, and `session-store.js` persists runs under `.sessions/`. Frontend assets for the local UI live in `public/` (`index.html`, `app.js`, `styles.css`).

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npx playwright install chromium`: install the browser runtime used by Playwright.
- `npm start -- "your task"`: run the CLI agent.
- `npm run web`: start the local web UI on `http://127.0.0.1:3210`.
- `npm run check`: run syntax checks for `run.js`, `web.js`, and all files in `src/`.

Use `AGENT_PROVIDER=openai` or `AGENT_PROVIDER=deepseek` when running locally.

## Coding Style & Naming Conventions

Use ES modules, 2-space indentation, and semicolons, matching the existing JavaScript files. Prefer small single-purpose modules in `src/`. Use kebab-free lowercase filenames such as `session-store.js` and descriptive function names such as `resolveRuntimeConfig` or `captureSnapshot`. Keep browser and shell guardrails explicit rather than clever.

## Testing Guidelines

There is no full automated test suite yet. Treat `npm run check` as the minimum required gate before committing. For behavior changes, do one manual smoke test through either the CLI or the web UI. If you add tests later, place them in a dedicated `test/` directory and name them after the module under test, for example `guardrails.test.js`.

## Commit & Pull Request Guidelines

Commit messages in this repo currently follow short imperative style, for example `Make browser startup lazy and shell-first`. Keep commits focused and explain user-visible behavior changes in the body when needed. Pull requests should include:

- a short summary of what changed
- any environment or model assumptions
- screenshots for `public/` or `web.js` UI changes
- a brief manual test note, such as `npm run check` and one sample prompt

## Security & Configuration Tips

Never hard-code API keys. Use environment variables like `OPENAI_API_KEY` and `DEEPSEEK_API_KEY`. Do not weaken guardrails in `src/guardrails.js` without documenting why. Do not commit `.sessions/` artifacts.
