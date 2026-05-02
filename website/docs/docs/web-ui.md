# Web UI

Start the web UI from the project folder:

```bash
aginti web --port 3210
```

The web UI uses the launch folder as project root. CLI and web share `.sessions/`, project preferences, key status, and run history.

## Main Panels

| Panel | What It Shows |
| --- | --- |
| Routing policy | Provider, model, smart route, profile, wrapper preference. |
| Task controls | Goal, URL, domains, command cwd, max steps. |
| Runtime controls | Sandbox mode, package install policy, shell/file toggles. |
| Workspace files | Enabled file tools, recent changes, blocked writes, compact diffs. |
| Sandbox status | Docker image, readiness, recent sandbox logs. |
| Conversation | User/agent messages and continuation input. |
| Run output | Structured events, tool calls, command output, failures. |
| Canvas and Artifacts | Agent-selected renders, images, PDFs, screenshots, files, and logs. |

## Session Sync

The UI can continue sessions created by the CLI. The CLI can resume sessions created by the UI.

This works because both use:

```text
<project>/.sessions/
<project>/.sessions/web-state.sqlite
<project>/.sessions/<session-id>/
```

## Web vs CLI

The web UI does not need terminal keybindings like Ctrl+J or arrow-key history. It should still offer the same agent capability: shared sessions, run controls, queue/resume, artifacts, and file change visibility.

## Local Launch

The web UI is local by default. It is intended for development and project work, not as a public multi-tenant server.
