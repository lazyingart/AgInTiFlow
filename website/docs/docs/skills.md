# Skills and Tools

AgInTiFlow separates skills from tools.

## Skills

Skills are Markdown playbooks. They tell the model how to approach a domain.

Examples:

- code
- website-app
- latex-manuscript
- image-generation
- github-maintenance
- system-maintenance
- book-writing
- word-documents
- Android
- R and Stan
- Python
- C/C++
- AAPS
- tmux-session

List skills:

```bash
aginti skills
aginti skills website
aginti --list-skills latex
```

## Tools

Tools are deterministic actions the runner can execute.

Examples:

- `run_command`
- `apply_patch`
- `read_file`
- `web_search`
- `send_to_canvas`
- `generate_image`
- `tmux_capture_pane`
- `open_workspace_file`

## Choosing a Profile

Auto is the default and should remain general. Specific profiles add stronger bias without blocking general work.

```bash
aginti --profile code "add a feature and tests"
aginti --profile latex "write and compile a paper"
aginti --profile maintenance "diagnose this system issue"
```

In the web UI, choose the profile from the task controls.
