# Project Setup

`aginti init` creates a small project control layer without changing your application source layout.

```bash
aginti init
```

The default template is `disciplined`. It creates a practical behavior contract, not only a placeholder file: project identity, ambiguity handling, surgical-change policy, verification contract, permission policy, artifact naming, project commands, style, and definition of done.

Use a different template when the project has a clearer shape:

```bash
aginti init --list-templates
aginti init --template minimal
aginti init --template coding
aginti init --template research
aginti init --template writing
aginti init --template design
aginti init --template aaps
aginti init --template supervision
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

Use `AGINTI.md` like durable project memory. Put conventions and operating rules here:

- project identity and non-goals
- ambiguity and clarification preferences
- surgical-change and verification expectations
- permission and artifact naming rules
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
