# Agent Runtime Pipe

AgInTiFlow keeps CLI and web runs equivalent by using the project folder as the source of truth.

- Project root: the folder where `aginti` or `aginti web` is launched.
- Session store: `<project>/.sessions/`.
- Web settings database: `<project>/.sessions/web-state.sqlite`.
- Runtime inbox: `<project>/.sessions/<session-id>/inbox.jsonl`.

When a run is active, the web chat and `aginti queue <session-id> "..."` append messages to the inbox instead of trying to mutate the running process directly. The web API exposes `GET /api/sessions/:id/inbox`, `POST /api/sessions/:id/inbox`, `PATCH /api/sessions/:id/inbox/:itemId`, and `DELETE /api/sessions/:id/inbox/:itemId` so browser users can inspect, edit, or remove pending pipe messages before the runner consumes them. The runner drains the inbox at safe boundaries: before each model step and after tool execution. This mirrors the event-queue style used by mature agent UIs while keeping the backend decoupled from any specific frontend.

The interactive CLI keeps the input panel visible while a run is working. Enter sends the current draft as an ASAP pipe message and displays it as `→`; the runner drains those messages before normal inbox items and before after-finish queued prompts. Tab stores the draft as an after-finish queue item and displays it as `↳`; those prompts run only after the current run completes. Alt+Up moves the last pending `→` message back into the editor, and Shift+Left moves the last pending `↳` message back into the editor. Idle Esc is ignored so it does not redraw the prompt into the transcript. During a run, Esc waits when `→` pipe messages are still pending and stops the run only when no ASAP pipe message is pending; Ctrl+C always stops. The current command cwd is rendered below the input panel in both idle and running states.

The web UI uses a related but browser-appropriate pattern. Enter sends and Shift+Enter adds a newline. `Pipe to run` writes an ASAP inbox item shared with CLI. `Queue after finish` keeps a browser-local next prompt and starts it after the current web-owned run finishes. Both lanes render in a pending panel with Edit and Remove buttons instead of terminal-only keybindings.

Runs can be stopped without corrupting session state. The CLI listens for Ctrl+C during an active run, and Esc stops only when no ASAP pipe message is waiting to be applied. The web UI exposes a Stop button plus Esc. Stop paths send an abort signal, persist `session.stopped`, and leave the session resumable through `aginti resume <session-id>`.

Default execution is Docker workspace mode with package installs approved inside the sandbox. The project is mounted at `/workspace`; persistent agent toolchain folders are mounted at `/aginti-home`, `/aginti-cache`, and `/aginti-env` from `~/.agintiflow/docker/`. Python, conda, and other language-level environments should be installed under `/aginti-env` so they survive across runs. Apt/apk package changes are ephemeral unless the Docker image is rebuilt.

Docker shell commands are process-ephemeral: each `run_command` call starts a new short-lived container. Durable terminals, dev servers, and external agents should use host tmux tools, or a future persistent service-container mode. See [runtime-modes-and-autonomy.md](runtime-modes-and-autonomy.md).

Generated local websites should use `preview_workspace` or `open_workspace_file`. The preview tool serves the host workspace on an automatically selected `127.0.0.1` port and opens it in the browser. AgInTiFlow blocks common transient Docker preview commands such as `python -m http.server` because each shell tool call runs in a short-lived container with no published host port.

The failed `f(f(x)) = f'(x)` LaTeX task exposed three issues: host-mode command policy blocked setup/path commands, a 15-step budget was too small for iterative numerical work plus TeX output, and follow-up input could not be queued while the agent was running. The current runtime defaults and inbox pipe address those without hardcoding that specific math task.
