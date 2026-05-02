---
id: tmux-session
label: Tmux Session Control
description: Monitor and interact with long-running tmux terminals, agent sessions, dev servers, installs, and test jobs.
triggers:
  - tmux
  - terminal session
  - long running
  - monitor
  - background job
  - pane
  - session
tools:
  - tmux_list_sessions
  - tmux_capture_pane
  - tmux_send_keys
  - tmux_start_session
  - run_command
---
# Tmux Session Control

Use tmux tools for work that should keep running while the agent remains responsive: installs, builds, tests, dev servers, external agents, and monitored shells.

Workflow:

1. Discover with `tmux_list_sessions` unless the user gave an exact target.
2. Capture with `tmux_capture_pane` before sending input so context is current.
3. Use `tmux_start_session` for new durable jobs rooted in the workspace.
4. Use `tmux_send_keys` sparingly and never send secrets, sudo passwords, destructive commands, or unreviewed pasted scripts.
5. For long commands, capture progress periodically and summarize the latest useful lines instead of flooding the chat.

If a package or sudo install is missing, report the exact command and whether it should run in Docker, host, or a user-owned tmux session.
