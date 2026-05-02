# Project Setup

`aginti init` creates a small project control layer without changing your application source layout.

```bash
aginti init
```

## Created Files

| File | Purpose |
| --- | --- |
| `AGINTI.md` | Project-level instructions for the agent. |
| `.aginti/README.md` | Explains the local control folder. |
| `.aginti/.env.example` | Safe example of provider environment variables. |
| `notes/README.md` | Starter notes folder for agent-generated project notes. |
| `.gitignore` entries | Ensures `.aginti/.env` and `.sessions/` stay out of git. |

## AGINTI.md

Use `AGINTI.md` like durable project memory. Put conventions here:

- preferred package manager
- test commands
- coding style
- release process
- known constraints
- folders the agent should not edit

Do not put secrets in `AGINTI.md`.

## Doctor

Run:

```bash
aginti doctor
aginti doctor --capabilities
aginti capabilities
```

The report checks Node, provider keys, project root, session store, Docker, wrappers, platform tools, TeX, Python, R, conda, and shell policy.

## Sessions

Sessions are project-local:

```bash
aginti sessions list
aginti sessions show <session-id>
aginti resume latest
aginti resume <session-id> "continue"
```

Launching `aginti web` from the same folder shows the same sessions that the CLI created.
