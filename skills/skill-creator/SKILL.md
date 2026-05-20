---
id: skill-creator
label: Skill Creator
description: Create, refine, validate, and document reusable AgInTiFlow skills as project-local Markdown playbooks or reviewed SkillMesh candidates.
triggers:
  - create skill
  - custom skill
  - skill creator
  - reusable workflow
  - record method
  - document workflow
  - learn skill
  - project skill
  - skillmesh
  - 创建技能
  - 自定义技能
  - 记录方法
tools:
  - inspect_project
  - list_files
  - read_file
  - write_file
  - apply_patch
  - run_command
  - search_files
---
# Skill Creator

Use this when the user wants AgInTiFlow to learn a reusable method without hard-coding it into core runtime behavior.

Default to project-local skills under `.aginti/skills/<skill-id>/SKILL.md`. Built-in skills should stay general; domain-specific workflows belong in project-local skills first and can later be reviewed for SkillMesh sharing.

Workflow:

1. Identify the repeated task family, not one exact task instance.
2. Choose a short lowercase skill id such as `browser-asset-upload` or `video-subtitle-cleanup`.
3. Create `.aginti/skills/<skill-id>/SKILL.md` with YAML frontmatter containing `id`, `label`, `description`, `triggers`, and `tools`.
4. Keep the body concise and operational: what to inspect, which controls or files matter, how to verify success, what blockers stop the task, and what evidence to save.
5. Avoid secrets, API keys, account tokens, passwords, private cookies, or unredacted credentials. Reference local `.env` keys by variable name only.
6. Do not override built-in skills. If a built-in skill already applies, create a narrower project skill with a distinct id.
7. Validate discovery with `aginti skills <query>` from the project root and confirm the new skill appears as `source=project-local`.

Good skills make future runs faster without making the core agent brittle. If a pattern is broadly useful across projects, propose exporting it through SkillMesh after it has worked in at least one real project.
