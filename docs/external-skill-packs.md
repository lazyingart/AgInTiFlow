# External Skill Packs

AgInTiFlow can load reviewed external Agent Skills repositories as grouped skill
packs. This keeps large third-party collections intact instead of flattening
them into AgInTiFlow's built-in `skills/` directory.

## Scientific Agent Skills

When a sibling `../scientific-agent-skills` checkout exists,
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

## Standard Local Agent Skills

AgInTiFlow also discovers user-owned Agent Skills from these standard local
locations when they exist:

- `~/.agents/skills`
- `~/.codex/skills`
- `~/.claude/skills`

This is read-only interoperability. AgInTiFlow loads only `SKILL.md`, treats its
contents as guidance rather than executable authority, and still applies the
normal tool, command, permission, and irreversible-action policies. Built-in,
project-local, and reviewed SkillMesh skills continue to win on ID collisions.

Override the standard roots with a path-delimited list:

```bash
AGINTIFLOW_AGENT_SKILL_PACKS=/path/to/agent-skills:/path/to/more-skills aginti skills
```

Disable ambient discovery for a hardened or fully isolated runtime:

```bash
AGINTIFLOW_DISCOVER_AGENT_SKILLS=false aginti skills
```

Selected skill context includes a bounded excerpt, section index, and the
read-only `SKILL.md` source path. This lets a tool-capable agent inspect the full
routine before a multi-stage task without bloating every ordinary chat turn.

## Design Rules

- External packs are optional. Missing packs do not block startup.
- Built-in and project-local skills win on ID collisions.
- External pack skills are selected only when their name, triggers, or
  description match the task.
- Skills are prompt guidance, not trusted executable tools. Scripts inside a
  pack still run only through AgInTiFlow's normal command policy.
- Pack metadata is retained in CLI, web config, capability reports, and prompt
  context so users can see where a skill came from.
