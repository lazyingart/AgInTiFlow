# Skills And Tools

AgInTiFlow separates **skills** from **tools** so the agent can stay general while still improving on specialized work.

## Definitions

**Skill**: Markdown guidance stored at `skills/<id>/SKILL.md`. A skill describes when to use a workflow, what to inspect first, which outputs matter, and which tools are usually useful. Skills are prompt context, not executable code.

**Tool**: A deterministic or bounded callable capability exposed to the model, such as `inspect_project`, `read_file`, `apply_patch`, `run_command`, `web_search`, `web_research`, `read_image`, `writing_specialist`, `research_wrapper`, `generate_image`, `preview_workspace`, `tmux_capture_pane`, or `send_to_canvas`.

**Profile**: A broad runtime mode such as `auto`, `code`, `latex`, or `maintenance`. Profiles tune routing, max steps, and general behavior. Skills can combine across profiles.

## Built-In Skills

The package ships built-in skills for code engineering, website/app building, LaTeX manuscripts, books, Microsoft Word documents, image generation, GitHub maintenance, system maintenance, tmux session control, Android, R/Stan, Python, C/C++, shell scripting, AAPS, novel writing, and supervision/student-agent training.

List them from a project:

```bash
aginti skills
aginti skills website
aginti --list-skills latex
```

Inside interactive chat:

```text
/skills
/skills github commit
```

## Selection Flow

For every run, AgInTiFlow scores the user goal and active profile against skill frontmatter:

```yaml
---
id: latex-manuscript
label: LaTeX Manuscript
description: Write, compile, and package LaTeX papers, reports, figures, bibliographies, and PDFs.
triggers:
  - latex
  - tex
  - manuscript
tools:
  - write_file
  - apply_patch
  - run_command
---
```

Selected skills are injected into the plan and execution prompts. The LLM still decides what to do; skills only provide domain playbooks and guardrails.

## Adding A Skill

Create `skills/<id>/SKILL.md` with valid YAML frontmatter and a short Markdown body. Keep descriptions strings, not YAML arrays, because loaders expect `id`, `label`, and `description` as scalar strings.

Good skills are small, actionable, and tool-aware. They should say what to inspect, what to create or verify, and what to avoid. They should not hard-code one exact task.

For visual or current-information tasks, prefer:

- `read_image` for screenshots, plots, diagrams, microscopy images, scanned text, and UI debugging.
- `web_research` for sourced research artifacts with source URLs and optional domain restrictions.
- `research_wrapper` for strict-JSON second opinions from the selected read-only wrapper, usually Codex `gpt-5.4-mini` medium.

See [Image Reading And Web Research](perception-and-web-research.md).

For substantial writing tasks, prefer:

- `writing_specialist` for isolated prose, scene, chapter, paper-section, script, book, essay, and revision drafting.
- The main agent for all non-writing work around that draft: file names, workspace edits, citations, Markdown/LaTeX/Final Draft formatting, PDF compilation, canvas publishing, and verification.

The writer receives only writing context: brief, canon, style guide, prior draft, target, audience, constraints, length, and downstream format intent. It should not receive shell/file/browser policy or agent-runtime details.
