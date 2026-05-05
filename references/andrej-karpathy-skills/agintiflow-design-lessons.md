# AgInTiFlow Design Lessons From `andrej-karpathy-skills`

## Core Lesson

The upstream repo is powerful because it is small, repeated, and portable. It does not try to solve runtime orchestration. It defines a behavior contract and packages it for multiple agent surfaces.

AgInTiFlow should do the same, but at platform level:

- The project instruction file is the durable contract.
- Skills are reusable behavior/domain modules.
- Profiles choose which modules matter for a task.
- SCS can enforce the contract for complex work.
- The web UI makes the contract visible and editable.

## Mapping To AgInTiFlow Components

| Upstream pattern | AgInTiFlow equivalent | Future improvement |
| --- | --- | --- |
| `CLAUDE.md` | `AGINTI.md` | Generate a stronger default project contract with behavior, safety, checks, and commands. |
| `SKILL.md` | `skills/*/SKILL.md` | Add a shared discipline skill that domain skills can reference instead of duplicating text. |
| Cursor always-apply rule | AgInTiFlow system/runtime prompt | Add behavior-contract blocks as compact, reusable prompt modules. |
| Plugin metadata | Skill Mesh package metadata | Share reviewed behavior contracts and skills as signed packs. |
| Examples of failure modes | AgInTiFlow smoke tests and eval tasks | Add eval prompts that punish overengineering, unrelated edits, and missing verification. |

## Behavior Contract As Runtime Policy

The behavior contract should not be only prose. AgInTiFlow can turn it into typed runtime checks:

- Plan gate: does the plan state assumptions and verification?
- Diff gate: does the changed-file set match the task scope?
- Artifact gate: did generated content use durable, non-conflicting names?
- Verification gate: were checks run or was the lack of checks disclosed?
- Permission gate: if blocked, did the agent stop and suggest a rerun instead of retrying variants?

These checks do not need to be perfect. Even lightweight heuristics can reduce common failures.

## SCS Integration

SCS should use the project contract explicitly:

- Committee drafts the smallest verifiable phase plan.
- Student checks assumptions, scope, simplicity, and verification.
- Supervisor executes only the approved phase.
- Student reviews phase evidence before the next phase.

This makes SCS less like a debate and more like a typed gate around the same disciplined behavior contract.

## Scout Integration

Scouts should be measured against the same contract:

- Architecture scout: find only relevant entry points and integration risks.
- Test scout: identify focused checks, not every possible test.
- Risk scout: look for concrete failure modes and permission risks.
- Context scout: summarize high-signal files, not the whole tree.

This keeps scouts cheap and useful instead of creating more noise.

## AAPS Integration

AAPS can benefit from the same approach. A `.aaps` workflow should include:

- success criteria per phase
- allowed write scope
- verification commands
- artifact destinations
- rollback or stop conditions

AgInTiFlow can then compile top-down workflows into disciplined execution phases.

## Web UI Implications

The web app should make project instructions a first-class object:

- Show `AGINTI.md` status in the project panel.
- Provide “open/edit project instructions” from settings.
- Show extracted contract fields: commands, safety rules, artifact policy, definition of done.
- Warn when a task has no known verification command.
- Let users choose an init template from a clean selector.

## CLI Implications

The CLI should make the contract easy to inspect and update:

- `/instructions` should show the important sections compactly.
- `/instructions edit` can open or patch `AGINTI.md`.
- `/init` can offer templates.
- `/review` should use the verification and surgical-change contract.
- When blocked, the CLI should print the exact rerun recipe matching the task risk.

## Suggested Init Templates

AgInTiFlow should eventually support:

- `minimal`: short project memory for tiny repos.
- `disciplined`: default coding-agent contract.
- `coding`: code-specific commands, tests, style, architecture sections.
- `research`: sources, citations, datasets, reproducibility, paper notes.
- `writing`: audience, style, outline, references, publication targets.
- `design`: visual system, assets, screenshots, QA checklist.
- `aaps`: phase success criteria, explicit tools, artifacts, and workflow checks.
- `supervision`: student/supervisor monitoring, evidence, and escalation rules.

## Evaluation Ideas

AgInTiFlow can add small eval tasks derived from the observed failure modes:

- Ambiguous export request: agent must ask about scope/fields/privacy before implementation.
- Simple discount function: agent must not create a strategy framework.
- Bug fix with existing style: agent must not reformat unrelated code.
- Duplicate-score sorting bug: agent must write or identify a focused repro check.
- Existing file generation: agent must choose a non-conflicting filename or ask before overwriting.
- Permission denial: agent must stop and suggest a safe rerun command.

These evals are more useful than broad “can it code?” demos because they target agent behavior quality.

## Implementation Guidance

Recommended future slices:

1. Upgrade the `AGINTI.md` default template.
2. Add init template selection.
3. Add a compact built-in discipline skill.
4. Make SCS evaluate plans against the contract.
5. Add smoke/eval prompts for overengineering, scope drift, and missing verification.
6. Add web UI affordances for editing and summarizing project instructions.

Keep each slice small and testable. The lesson from the cloned repo applies to AgInTiFlow itself: avoid building a large policy framework when a compact behavior contract plus a few typed gates will do.

