# External Skill Packs

AgInTiFlow can load reviewed external Agent Skills repositories as grouped skill
packs. This keeps large third-party collections intact instead of flattening
them into AgInTiFlow's built-in `skills/` directory.

## Scientific Agent Skills

When `/home/lachlan/ProjectsLFS/Agent/scientific-agent-skills` exists,
AgInTiFlow automatically discovers it as:

- pack: `scientific-agent-skills`
- label: `Scientific Agent Skills`
- category: `scientific`
- skills directory: `scientific-skills/`

The skills are shown as `source=external-pack category=scientific
pack=scientific-agent-skills` in `aginti skills`.

Example:

```bash
aginti skills rdkit
aginti skills "single cell scanpy"
```

The original repository remains a separate checkout. AgInTiFlow only reads
`*/SKILL.md` files and preserves each skill's local references, scripts, and
assets in that checkout.

## Generic Pack Loading

Set `AGINTIFLOW_SKILL_PACKS` to one or more pack roots separated by the platform
path delimiter or commas:

```bash
AGINTIFLOW_SKILL_PACKS=/path/to/pack-a:/path/to/pack-b aginti skills
```

Each pack may contain one of these layouts:

- `scientific-skills/<skill-id>/SKILL.md`
- `skills/<skill-id>/SKILL.md`
- `<skill-id>/SKILL.md`

AgInTiFlow supports both its native frontmatter (`id`, `label`, `description`,
`triggers`, `tools`) and the broader Agent Skills dialect used by K-Dense
(`name`, `description`, `allowed-tools`, nested `metadata`).

## Design Rules

- External packs are optional. Missing packs do not block startup.
- Built-in and project-local skills win on ID collisions.
- External pack skills are selected only when their name, triggers, or
  description match the task.
- Skills are prompt guidance, not trusted executable tools. Scripts inside a
  pack still run only through AgInTiFlow's normal command policy.
- Pack metadata is retained in CLI, web config, capability reports, and prompt
  context so users can see where a skill came from.
