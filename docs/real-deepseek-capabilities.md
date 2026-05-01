# Real DeepSeek Capability Suite

AgInTiFlow keeps deterministic mock smoke tests for CI, but Round 9 added an opt-in live suite for validating DeepSeek v4 flash/pro behavior against a real project folder.

## Prerequisites

- Node.js 22+
- A project folder initialized with `aginti init`
- `DEEPSEEK_API_KEY` in the environment or project-local `.aginti/.env`
- Optional web UI running from the same project folder

Never print or commit API keys. The suite reports only provider availability.

## Static Capability Report

```bash
aginti capabilities
aginti capabilities --json
aginti doctor --capabilities
```

The report checks project root, command cwd, shared `.sessions/`, provider-key presence, DeepSeek routes, file/shell tools, Docker status, wrappers, task profiles, TeX, Node/npm, Python, R, conda, and maintenance command guardrails.

## Live DeepSeek Suite

Run from the source repository:

```bash
AGINTIFLOW_REAL_DEEPSEEK=1 \
AGINTIFLOW_REAL_WORKSPACE=/home/lachlan/ProjectsLFS/aginti-test \
AGINTIFLOW_REAL_WEB_BASE_URL=http://127.0.0.1:3220 \
npm run real:deepseek
```

Optional case filter:

```bash
AGINTIFLOW_REAL_DEEPSEEK=1 AGINTIFLOW_REAL_CASES=flash,pro npm run real:deepseek
```

## What It Validates

- `flash`: DeepSeek v4 flash creates a dependency-free Node/HTML app with `node:test` tests and runs `npm --prefix <app> test` when safe.
- `pro`: DeepSeek v4 pro resumes/improves the app and expands tests.
- `latex`: creates `.tex` source and compiles only if a TeX toolchain is available; otherwise writes an honest setup artifact.
- `website`: creates a website test sample and runs checks with the configured shell/package policy.
- `maintenance`: verifies the agent can prepare project-local maintenance work and use Docker/package policy for broader setup commands without exposing secrets.
- `aaps`: creates a project-local `.aaps` sample and notes for `@lazyingart/aaps` workflows without publishing.
- `web`: when `AGINTIFLOW_REAL_WEB_BASE_URL` is set, starts a web run and verifies CLI/web session sharing.

The suite writes a JSON summary with session IDs, generated files, routes, and failures. It is intentionally opt-in because it spends live model credits.
