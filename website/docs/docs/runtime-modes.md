# Runtime Modes

AgInTiFlow supports multiple runtime modes because no single sandbox is right for every task.

## Modes

| Mode | Best For | Notes |
| --- | --- | --- |
| Host | Quick trusted local commands. | Conservative by default. |
| Docker read-only | Inspection and tests without writes. | Safer for unknown projects. |
| Docker workspace | Coding, package installs, plotting, LaTeX. | Workspace is mounted read/write. |
| Tmux host tools | Long-running servers and monitors. | Persistent host process control. |

## Docker Workspace

Docker workspace mode mounts:

```text
host project -> /workspace
~/.agintiflow/docker/home -> /aginti-home
~/.agintiflow/docker/cache -> /aginti-cache
~/.agintiflow/docker/env -> /aginti-env
```

This lets tools persist between commands without installing globally on the host.

## Package Installs

Package install policy can be:

| Policy | Behavior |
| --- | --- |
| `block` | Setup commands are blocked. |
| `prompt` | Agent must stop for approval. |
| `allow` | Installs can run when the selected runtime permits them. |

Docker mode can allow practical setup commands such as `pip install`, `npm install`, `apt`, `curl`, and `wget` inside the container. Host mode remains more conservative.

Use `aginti docker status` to inspect Docker readiness and `aginti docker setup` to build or verify the companion sandbox image. The setup command checks Node, npm, Python, matplotlib/numpy, `latexmk`, `pdflatex`, git, and ripgrep inside Docker. If host Docker is missing, AgInTiFlow prints OS-specific guidance. Host Docker installation is explicit only, for example `aginti docker install-host --yes` on supported Ubuntu hosts; npm postinstall does not silently change host services.

## Permission Recipes

Use the shortcut layer first. The long flags still exist for automation, but these three modes are the normal user interface.

| Goal | Command | Contract |
| --- | --- | --- |
| Safe | `aginti -s safe "inspect this project without edits"` | Read-first posture. Writes and setup stop for approval. |
| Normal | `aginti -s normal "build and test this project"` | Current-project writes and Docker setup are allowed. Outside-project and host-system changes stop. |
| Danger | `aginti -s danger "perform the trusted host maintenance task"` | Trusted host/full-access mode with destructive shell, host installs, password typing, and outside-workspace file paths enabled. |

For a resumed session, keep the same shape and add the session id:

```bash
aginti --resume <session-id> \
  -s danger \
  "continue with trusted host access"
```

Inside interactive chat, `/safe`, `/normal`, and `/danger` switch the current session. When a blocked action needs a decision, the CLI and web app use the same selector: `No`, `Yes this time`, or `Yes and always for this session`.

## Full Host Access

Some system maintenance needs direct host access. The product goal is configurable privilege, not artificial weakness. The safe pattern is:

1. Diagnose first.
2. Show exact commands.
3. Ask before sudo or destructive host actions.
4. Prefer Docker for package setup when possible.
5. Stop on ambiguous conflicts.
