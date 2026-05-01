# Agent Runtime Pipe

AgInTiFlow keeps CLI and web runs equivalent by using the project folder as the source of truth.

- Project root: the folder where `aginti` or `aginti web` is launched.
- Session store: `<project>/.sessions/`.
- Web settings database: `<project>/.sessions/web-state.sqlite`.
- Runtime inbox: `<project>/.sessions/<session-id>/inbox.jsonl`.

When a run is active, the web chat and `aginti queue <session-id> "..."` append messages to the inbox instead of trying to mutate the running process directly. The runner drains the inbox at safe boundaries: before each model step and after tool execution. This mirrors the event-queue style used by mature agent UIs while keeping the backend decoupled from any specific frontend.

Default execution is Docker workspace mode with package installs approved inside the sandbox. The project is mounted at `/workspace`; persistent agent toolchain folders are mounted at `/aginti-home`, `/aginti-cache`, and `/aginti-env` from `~/.agintiflow/docker/`. Python, conda, and other language-level environments should be installed under `/aginti-env` so they survive across runs. Apt/apk package changes are ephemeral unless the Docker image is rebuilt.

The failed `f(f(x)) = f'(x)` LaTeX task exposed three issues: host-mode command policy blocked setup/path commands, a 15-step budget was too small for iterative numerical work plus TeX output, and follow-up input could not be queued while the agent was running. The current runtime defaults and inbox pipe address those without hardcoding that specific math task.
