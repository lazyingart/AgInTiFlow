# Lessons From `andrej-karpathy-skills`

Source inspected:

- Upstream: https://github.com/forrestchang/andrej-karpathy-skills
- Local clone: `/home/lachlan/ProjectsLFS/Agent/andrej-karpathy-skills`
- Inspected commit: `2c60614`
- License: MIT

This reference is a design study for AgInTiFlow. It is not a code integration and does not vendor the upstream text as-is.

## What The Repo Is

The repository is intentionally small:

- `CLAUDE.md`: a per-project instruction file.
- `skills/karpathy-guidelines/SKILL.md`: the same behavior contract as a reusable Claude skill.
- `.cursor/rules/karpathy-guidelines.mdc`: the same contract as a Cursor always-apply rule.
- `.claude-plugin/`: plugin and marketplace metadata.
- `EXAMPLES.md`: concrete examples of bad agent behavior and corrected behavior.

The main design strength is that the project turns vague “be careful” advice into a compact operating contract:

- Think before coding.
- Prefer simplicity.
- Make surgical changes.
- Define success criteria and verify them.

## What AgInTiFlow Should Learn

AgInTiFlow already has stronger runtime machinery than this repo: project sessions, tool calls, Docker policy, file tools, scouts, SCS, AAPS, Skill Mesh, and web/CLI surfaces. The missing piece is a sharper default behavioral contract for initialized projects.

The best lesson is not to add a new heavyweight subsystem. The best lesson is to make the first `AGINTI.md` more useful and make the runtime repeatedly reinforce it.

## Recommended AGINTI.md Direction

The current initializer creates a helpful but generic file:

- project goals
- agent preferences
- useful commands
- notes

The future initializer should create a stronger, project-local contract:

- Project identity and non-goals.
- Ambiguity protocol: when to ask, when to proceed, when to present interpretations.
- Change budget: prefer smallest coherent edits; no drive-by refactors.
- Verification contract: every non-trivial task needs success criteria and a check.
- Safety and permission contract: current-folder writes, outside-folder blockers, secrets, destructive actions.
- Artifact policy: durable names, no accidental overwrites.
- Style and conventions: existing style wins unless the user asks otherwise.
- Known commands: test/lint/build/preview/deploy.
- “Definition of done” for this project.

See [aginti-init-template.md](aginti-init-template.md) for a proposed template.

## Recommended AgInTiFlow Product Direction

The upstream repo shows a useful packaging pattern:

- One behavior contract.
- Multiple surfaces.
- Same content adapted for root instructions, reusable skills, and editor rules.

AgInTiFlow can generalize this:

- `aginti init` should generate a high-quality `AGINTI.md` with selectable templates.
- The web app should surface and edit `AGINTI.md` as first-class project memory.
- The CLI should summarize the active behavior contract during `/instructions`.
- Built-in skills should include a small “discipline contract” that can be merged with domain skills.
- SCS should use the contract as explicit gate criteria: assumptions, minimality, scope, verification.
- Skill Mesh should share refined behavior contracts as reviewed skill packs, not raw session logs.

See [agintiflow-design-lessons.md](agintiflow-design-lessons.md) for concrete design implications.

## What Not To Copy Blindly

- Do not force full ceremony for trivial one-line tasks.
- Do not make the agent ask clarifying questions when a safe default is obvious.
- Do not make “simplicity” mean weak engineering. Simplicity means no speculative complexity, not no tests or no error handling.
- Do not make the instructions static. AgInTiFlow should keep them project-local, editable, and visible.
- Do not duplicate the same text across every skill manually. Generate or compose shared behavior blocks where possible.

## Practical Next Steps

No runtime code was changed in this study. Future implementation can be split into small slices:

1. Upgrade `defaultAgintiInstructions()` in `src/project.js`.
2. Add `/init template` or `aginti init --template disciplined|coding|research|writing|minimal`.
3. Make `/instructions` support edit/open/preview from CLI and web.
4. Add a built-in behavior skill that domain profiles can reference.
5. Teach SCS to score plans against the project contract.
6. Add a smoke test that validates `AGINTI.md` generation contains behavior, commands, safety, and verification sections.

