# Skills And Tools

AgInTiFlow separates **skills** from **tools** so the agent can stay general while still improving on specialized work.

## Definitions

**Skill**: Markdown guidance stored at built-in `skills/<id>/SKILL.md` or project-local `.aginti/skills/<id>/SKILL.md`. A skill describes when to use a workflow, what to inspect first, which outputs matter, and which tools are usually useful. Skills are prompt context, not executable code.

**Tool**: A deterministic or bounded callable capability exposed to the model, such as `inspect_project`, `read_file`, `apply_patch`, `run_command`, `web_search`, `web_research`, `read_image`, `writing_specialist`, `research_wrapper`, `generate_image`, `preview_workspace`, `tmux_capture_pane`, or `send_to_canvas`.

**Profile**: A broad runtime mode such as `auto`, `code`, `latex`, or `maintenance`. Profiles tune routing, max steps, and general behavior. Skills can combine across profiles.

## Built-In Skills

The package ships built-in skills for code engineering, website/app building, LaTeX manuscripts, books, Microsoft Word documents, image generation, GitHub maintenance, system maintenance, source ingestion/OCR, structured JSON, autonomous artifact pipelines, tmux session control, Android, R/Stan, Python, C/C++, shell scripting, AAPS, skill creation, novel writing, and supervision/student-agent training.

## External Skill Packs

AgInTiFlow can also load whole external Agent Skills repositories as grouped
skill packs. This is for large curated collections that should remain intact,
with their own references, scripts, assets, and upstream history.

The current default scientific pack integration looks for a sibling checkout:

```bash
../scientific-agent-skills
```

When present, it appears as `source=external-pack category=scientific
pack=scientific-agent-skills`:

```bash
aginti skills rdkit
aginti skills "single cell scanpy"
```

For arbitrary pack roots, set:

```bash
AGINTIFLOW_SKILL_PACKS=/path/to/pack-a:/path/to/pack-b aginti skills
```

See [External Skill Packs](external-skill-packs.md).

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

Automatic selection requires substantive relevance. Exact IDs, focused short
requests, specific triggers, and several matching description terms score
strongly. Generic words such as `data`, `search`, `project`, or `commit` are
discounted when they occur incidentally inside a longer request, and automatic
mode omits weak matches instead of filling the skill budget. Explicit profiles
and direct topic wording remain authoritative. This keeps unrelated guidance
out of the context without hard-coding task-specific exclusions.

## Adding A Skill

For a reusable project workflow, create `.aginti/skills/<id>/SKILL.md` with valid YAML frontmatter and a short Markdown body. These skills are loaded from the current project, shown as `source=project-local`, and are preferred for task-specific knowledge that should not become core runtime policy.

Built-in package skills live at `skills/<id>/SKILL.md`. Keep descriptions strings, not YAML arrays, because loaders expect `id`, `label`, and `description` as scalar strings.

Good skills are small, actionable, and tool-aware. They should say what to inspect, what to create or verify, and what to avoid. They should not hard-code one exact task.

Use the built-in `skill-creator` skill when the user asks AgInTiFlow to learn or document a reusable method. It should create project-local skills first, then propose SkillMesh sharing only after the workflow has been validated.

For visual or current-information tasks, prefer:

- `read_image` for screenshots, plots, diagrams, microscopy images, scanned text, and UI debugging. Local sessions use LocalLLM vision; hosted perception never activates from an ambient key.
- `web_research` for sourced research artifacts with source URLs and optional domain restrictions. Snippet mode stays provider-neutral; hosted synthesis requires an explicit run permission.
- `research_wrapper` for strict-JSON second opinions from the selected read-only wrapper, usually Codex `gpt-5.4-mini` medium. Wrapper tools must be enabled explicitly.

See [Image Reading And Web Research](perception-and-web-research.md).

For substantial writing tasks, prefer:

- `writing_specialist` for isolated prose, scene, chapter, paper-section, script, book, essay, and revision drafting.
- The main agent for all non-writing work around that draft: file names, workspace edits, citations, Markdown/LaTeX/Final Draft formatting, PDF compilation, canvas publishing, and verification.

The writer receives only writing context: brief, canon, style guide, prior draft, target, audience, constraints, length, and downstream format intent. It should not receive shell/file/browser policy or agent-runtime details.

The writer stays on the active session provider by default. Cross-provider writer routing requires `allowHostedWritingSpecialist=true` (or `AGINTI_ALLOW_HOSTED_WRITING_SPECIALIST=true`) for that run. A model-supplied provider argument, language-specific writer environment override, or ambient hosted API key is not permission; denied routes fail visibly before a hosted client is created.

For schema-bound structured data, prefer:

- `json_specialist` for one isolated extraction, annotation, conversion, or validation request.
- `json_specialist_batch` for independent chunks that can be requested in parallel without shared writes.

JSON specialist calls remain on the active session provider unless the run explicitly enables cross-provider specialist routing. A model-supplied provider argument and an ambient API key are not escalation authority.

The JSON specialist receives only the task, focused instructions, minimal context, input, and JSON Schema. It tries provider-native structured output (`json_schema` or JSON object mode) when available, then falls back to prompt-and-validate parsing.

For raw-input-to-final-output work, prefer the autonomous artifact pipeline pattern. The target project should own its source manifest, chunk manifest, schemas, validators, runner scripts, reviewer/repairer logic, and compiler/exporter. AgInTiFlow should create or patch those project-local pieces, run them in observable sessions, and verify checkpoint artifacts before declaring completion.
