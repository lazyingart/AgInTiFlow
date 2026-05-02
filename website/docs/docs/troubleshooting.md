# Troubleshooting

This page lists common issues and the fastest safe checks.

## Command Not Found

```bash
npm install -g @lazyingart/agintiflow@latest
which aginti
aginti --version
```

If global npm bins are not on `PATH`, check:

```bash
npm bin -g
npm prefix -g
```

## Provider Key Missing

```bash
aginti keys status
aginti auth
```

For DeepSeek, get a key from:

```text
https://platform.deepseek.com/api_keys
```

## Docker Not Ready

```bash
aginti capabilities
aginti --sandbox-status
```

If Docker is missing, install it using the repository helper for Ubuntu:

```bash
scripts/install-docker-ubuntu.sh
```

Ask before using sudo.

## Pytest Missing

If a Python test run says `No module named pytest`, use Docker workspace mode or install inside a project environment:

```bash
aginti --sandbox-mode docker-workspace --approve-package-installs "set up this project and run tests"
```

Do not claim tests passed unless the actual command output proves it.

## Web UI Not Showing CLI Sessions

Launch the web UI from the same project folder:

```bash
cd /path/to/project
aginti web --port 3210
```

CLI and web sync through the project-local `.sessions/` folder.

## Long-Running Servers

Docker `run_command` containers are short-lived. For persistent servers, use host-side tmux tools:

```text
start a tmux session named dev-server and run npm run dev
capture that tmux session and summarize the logs
```
