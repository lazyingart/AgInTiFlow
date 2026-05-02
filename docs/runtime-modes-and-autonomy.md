# Runtime Modes And Long-Running Autonomy

AgInTiFlow should feel like a normal coding agent, but with an explicit execution contract. The core decision is not "safe versus useful"; it is which execution mode matches the task.

## Evaluation Of The Tmux-In-Docker Case

The failed task was expected under the current Docker design, but the agent should have chosen a better path.

- `run_command` in Docker mode uses short-lived `docker run --rm` containers.
- A tmux server started inside that container dies when the command exits.
- Persistent folders such as `/aginti-env` and `/aginti-cache` preserve files and language environments, not running processes.
- For durable terminal sessions, the correct tool is host-side `tmux_start_session`, followed by `tmux_capture_pane` and `tmux_send_keys`.

The fix is guidance plus guardrails: raw `tmux` shell commands are blocked inside Docker `run_command`, and the model is told to use host tmux tools for durable sessions.

## Execution Modes

| Mode | Similar Codex idea | Best use | What persists | Risk |
| --- | --- | --- | --- | --- |
| `docker-readonly` | `-s read-only` | Inspect code, run read-only checks | Session logs only | Lowest |
| `docker-workspace` | `-s workspace-write` | Normal coding, plotting, LaTeX, package setup | Workspace files, `/aginti-env`, `/aginti-cache` | Low to medium |
| `host` conservative | Workspace access with approval | Git, host tools, local previews | Host filesystem changes in project | Medium |
| `host` trusted | `-s danger-full-access -a never` style | Autonomous computer maintenance, host services, privileged workflows | Host state | High |
| Future persistent container | Externally sandboxed full-auto | Long-running services and durable container processes | Workspace, env, running processes | Medium |

Codex exposes these concerns as `--sandbox read-only|workspace-write|danger-full-access` and `--ask-for-approval untrusted|on-failure|on-request|never`. AgInTiFlow maps the same philosophy into:

- `--sandbox-mode host|docker-readonly|docker-workspace`
- `--package-install-policy block|prompt|allow`
- `--allow-shell|--no-shell`
- `--allow-destructive`

## Docker Package Installs

Docker package installs are safe when they match the sandbox contract.

- `npm`, `pip`, `conda`, `curl`, `wget`, and `chmod` are practical inside `docker-workspace` when package policy is `allow`.
- Python and conda-style environments should live under `/aginti-env` so they survive future runs.
- Download caches should live under `/aginti-cache`.
- OS package installs such as `apt-get install htop` affect only the current short-lived command container unless the Docker image is rebuilt.
- To make OS packages portable, add them to `docker/sandbox.Dockerfile` and rebuild with `scripts/setup-agent-toolchain-docker.sh`.

This is why a task can safely install Python packages in Docker, but cannot keep an interactive tmux server alive inside a one-shot Docker command.

## Recommended Defaults

Default daily coding:

```bash
aginti
```

This starts interactive chat with Docker workspace mode, file tools, shell tools, web search, and package installs allowed inside Docker.

Direct trusted host mode:

```bash
aginti --sandbox-mode host --allow-shell --allow-destructive "fix this local service"
```

Use this only when the task truly needs host access. The agent should inspect first, show risky commands, stop on ambiguity, and avoid secrets.

Durable tmux task:

```bash
aginti "start a tmux session named demo, run ls in it, keep it open, and tell me how to attach"
```

The agent should use `tmux_start_session`, `tmux_send_keys`, and `tmux_capture_pane`, not Docker `run_command`.

## Future Persistent Container Mode

A useful next runtime mode is a service container:

- Start one named container per project, for example `agintiflow-<project-hash>`.
- Mount the workspace, `/aginti-home`, `/aginti-cache`, and `/aginti-env`.
- Keep the container alive with a shell, supervisor, or tmux server.
- Execute later commands with `docker exec` instead of `docker run --rm`.
- Provide explicit lifecycle commands: start, status, capture, stop, reset, rebuild.

This would support durable tmux, dev servers, long installs, notebooks, and language servers inside a portable container while still isolating the host.

## Long-Running Autonomy

Large tasks should not stop because an early high-level plan ran out. AgInTiFlow should use rolling plans:

1. Orient: inspect project instructions, git status, manifests, and current files.
2. Plan the next phase only: choose a concrete milestone with a check.
3. Execute: edit files, run commands, and capture artifacts.
4. Gate quality: run the narrowest useful test, lint, compile, preview, or smoke check.
5. Checkpoint: persist a session event, artifact, diff, or note.
6. Replan: if the goal is not done, generate the next phase from the current state.
7. Stop only when the requested outcome is complete, blocked by a real dependency, or the user interrupts.

This keeps the agent sober. It avoids giant low-quality plans while still allowing long autonomous work.

## Documentation Maintenance

The documentation should be maintained as product code:

- Keep reference docs in `docs/`.
- Link important docs from `README.md` and the marketing website.
- Add smoke tests when a workflow becomes behavior, not just guidance.
- Update `AGINTI.md` for project-specific operating memory.
- Treat docs changes as part of the release checklist before publishing npm.

