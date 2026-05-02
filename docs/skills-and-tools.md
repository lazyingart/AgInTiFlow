# Skills And Tools

AgInTiFlow separates **skills** from **tools** so the agent can stay general while still improving on specialized work.

## Definitions

**Skill**: Markdown guidance stored at `skills/<id>/SKILL.md`. A skill describes when to use a workflow, what to inspect first, which outputs matter, and which tools are usually useful. Skills are prompt context, not executable code.

**Tool**: A deterministic callable capability exposed to the model, such as `inspect_project`, `read_file`, `apply_patch`, `run_command`, `web_search`, `generate_image`, `preview_workspace`, or `send_to_canvas`.

**Profile**: A broad runtime mode such as `auto`, `code`, `latex`, or `maintenance`. Profiles tune routing, max steps, and general behavior. Skills can combine across profiles.

## Built-In Skills

The package ships built-in skills for code engineering, website/app building, LaTeX manuscripts, books, Microsoft Word documents, image generation, GitHub maintenance, system maintenance, Android, R/Stan, Python, C/C++, shell scripting, AAPS, and novel writing.

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
