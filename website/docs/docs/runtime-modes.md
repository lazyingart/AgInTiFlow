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

## Full Host Access

Some system maintenance needs direct host access. The product goal is configurable privilege, not artificial weakness. The safe pattern is:

1. Diagnose first.
2. Show exact commands.
3. Ask before sudo or destructive host actions.
4. Prefer Docker for package setup when possible.
5. Stop on ambiguous conflicts.
