# Interactive CLI

Run:

```bash
aginti
```

The CLI opens a project-aware chat interface with colored role bands, Markdown rendering, multiline input, live status, queues, and resumable sessions.

## CLI And Web Together

| CLI launch | Web console run output |
| --- | --- |
| ![AgInTiFlow CLI launch screen](../assets/screenshots/cli-launch.jpg) | ![AgInTiFlow web console conversation and run output](../assets/screenshots/web-console-conversation-run-output.jpg) |

## Chat Controls

| Key | Behavior |
| --- | --- |
| Enter | Send a message. During a run, pipe it into the active session as ASAP input. |
| Tab | During a run, queue the message for after the current run finishes. |
| Ctrl+J | Insert a newline. |
| Ctrl+A / Ctrl+E | Move to current line start or end. |
| Up / Down / Left / Right | Move through multiline input. |
| Esc | Idle: no-op. Running: stop if there is no pending ASAP message. |
| Ctrl+C | Stop and print a resume command. |

## Slash Commands

```text
/help
/status
/auth
/login
/instructions
/skills
/sessions
/resume latest
/profile code
/routing smart
/docker on
/latex on
/web-search on
/scouts 5
/exit
```

Typing a partial slash command shows suggestions. Pressing Enter on a close prefix auto-selects the best match.

## Live Patch Display

When the agent edits files through `apply_patch`, the CLI prints a live patch block:

```diff
--- a/test_cli.py
+++ b/test_cli.py
@@ line 18 @@
-old line
+new line
```

In an interactive terminal, deletion lines are red and addition lines are green.

## Resume

If you interrupt a run, AgInTiFlow prints:

```bash
aginti resume <session-id>
aginti resume <session-id> "continue"
```

The session history is reloaded before the prompt.
