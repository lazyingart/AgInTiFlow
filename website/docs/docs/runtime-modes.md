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

## Permission Recipes

Use explicit runtime flags when the task needs a clear privilege contract.

| Goal | Command | Contract |
| --- | --- | --- |
| Strict inspection | `aginti --sandbox-mode docker-readonly --package-install-policy block --allow-shell --no-file-tools --no-web-search "inspect this project without edits"` | Enforced read-only project inspection through shell commands. No file-tool writes, web calls, workspace writes, or installs. |
| Full write in current folder | `aginti --sandbox-mode docker-workspace --package-install-policy allow --approve-package-installs --allow-shell --allow-file-tools "build and test this project"` | Read/write inside the current project folder, with package setup inside Docker. |
| Full host computer access | `aginti --sandbox-mode host --package-install-policy allow --approve-package-installs --allow-shell --allow-file-tools --allow-destructive "perform the trusted host maintenance task"` | Direct host shell and destructive actions. Use only for trusted work. |

For a resumed session, keep the same shape and add the session id:

```bash
aginti --resume <session-id> \
  --sandbox-mode host \
  --package-install-policy allow \
  --approve-package-installs \
  --allow-shell \
  --allow-file-tools \
  --allow-destructive \
  "continue with trusted host access"
```

## Full Host Access

Some system maintenance needs direct host access. The product goal is configurable privilege, not artificial weakness. The safe pattern is:

1. Diagnose first.
2. Show exact commands.
3. Ask before sudo or destructive host actions.
4. Prefer Docker for package setup when possible.
5. Stop on ambiguous conflicts.
