# Skills And Tools

AgInTiFlow separates **skills** from **tools** so the agent can stay general while still improving on specialized work.

## Definitions

**Skill**: Markdown guidance stored at built-in `skills/<id>/SKILL.md` or project-local `.aginti/skills/<id>/SKILL.md`. A skill describes when to use a workflow, what to inspect first, which outputs matter, and which tools are usually useful. Skills are prompt context, not executable code.

**Tool**: A deterministic or bounded callable capability exposed to the model, such as `inspect_project`, `read_file`, `apply_patch`, `run_command`, `web_search`, `web_research`, `read_image`, `writing_specialist`, `research_wrapper`, `generate_image`, `preview_workspace`, `tmux_capture_pane`, or `send_to_canvas`.

**Profile**: A broad runtime mode such as `auto`, `code`, `latex`, or `maintenance`. Profiles tune routing, max steps, and general behavior. Skills can combine across profiles.

## Intentionally Empty Files

For a text placeholder, ask for an exact filename: “Create an empty draft.md”
or “Add a zero-byte marker.txt.” Completion requires a real workspace file with
exactly zero bytes. Whitespace, a BOM or a placeholder heading does not satisfy
that request. A missing file, directory, shared hardlink or outside-workspace
alias cannot count as the empty output.

This narrow content contract keeps an intentional empty Markdown file from
triggering repeated document-production attempts. Ordinary reports still need
nonempty evidence, and PDF, Word, image and SVG formats retain their existing
validation. Tool permissions and overwrite guards are unchanged: repair a
generated file through a read and exact patch when whole-file replacement is
not authorized. `npm run test:empty-file-intent` covers these boundaries and
persisted native runs with deterministic providers.

To fill an existing empty file, read it and use `apply_patch` with its exact
empty-file `baseHash`, `search: ""`, and a nonempty `replace`. This insertion
mode is rejected without that hash, if the file is no longer empty, or if more
than one replacement is requested. Publication still checks the current bytes;
the hash does not grant path or overwrite permission.

When fresh-source repair is required, explicitly requested current text inputs
remain readable before the canonical output is patched. A previous goal's read
does not satisfy that step. Protected files named only to be left unchanged
do not become mandatory data reads, and input reads never add mutation paths.

## Exact File Copies

For a bounded UTF-8 copy, read the source and call `write_file` with
`path`, `copyFromPath` and `copyFromSha256` from that read, omitting `content`.
This create-only mode revalidates the permitted source snapshot and copies its
exact bytes through the existing atomic publisher. It keeps the 220,000-byte
read/write limits, secret-content checks and ordinary write permission. It
cannot overwrite an existing target or bypass read scopes or binary guards.

Named file-copy requests retain distinct input and output roles. A copy must
exist at the requested destination and match the source bytes; changing the
original, producing a summary or writing an unrelated file cannot satisfy it.
The native completion check hashes regular files in the workspace and approved
read-only input roots, up to 64 MiB per file. It rejects aliases to the same inode,
shared output hardlinks, secret/special/outside paths and changed observations.
These path-based checks are not retained-descriptor storage or an application
sandbox. Independent report/compilation requirements remain in force.

For a small text copy, `read_file` accepts `preserveLineEndings:true` on a complete
read. Its default display still normalizes CRLF to LF for source inspection;
the option preserves newline characters without weakening redaction, path or
byte limits. It cannot be combined with `startLine`, `lineLimit` or `limit`.
Keep the BOM and trailing newline when writing the destination. A truncated or
redacted preview is not authority to reconstruct missing or private bytes.
The fidelity view reports `lineEndingCounts` (CRLF, lone LF and lone CR),
`hasUtf8Bom` and `endsWithLineEnding`; CRLF requires both CR and LF characters.
For an unambiguous native copy task, the runtime selects this presentation on
a complete read of the named source when the caller has not chosen a view.
It clears that purpose on a later non-copy goal and never changes tool arguments
or grants access to another path. Separately requested source edits require
typed native snapshot/publication evidence for the earlier copy; old-goal or
missing evidence cannot substitute for that proof.
For backup-then-edit requests, the backup stays bound to the pre-edit read:
later source mutations cannot redefine it. Explicit edit-then-copy requests
instead bind the later copy to the edited snapshot. Late publication of the
original snapshot is allowed if its native evidence and exact bytes remain valid.
Mentioning the source in a separate report, explanation or quoted edit instruction
is not permission to change it. Only a direct request to edit that named source
relaxes its copy-source protection.

For a general copy-then-edit request, verification treats the copy and edit as
ordered phases. Native mutation evidence must prove a byte-identical copy first,
then the requested destination edit through its before/after hash chain. The
current destination must match the last recorded change, while an unedited
source must still match the copied snapshot. A customized final file alone,
an old copy or a model's claim cannot supply the missing publication evidence.
Completion does not restore the template over a valid customized result. Separate
content and artifact requirements still apply; this is not a general semantic
verifier. Same-task continuation can retain the proof with existing task hashes.

An explicit single literal replacement has a bounded alternative: for an unchanged
UTF-8 source up to 220,000 bytes, completion can compute the expected full output
from one unique matching source string and the user-requested replacement. A
current-task native publication must match every expected byte, including the
unchanged status text, BOM and newlines. This permits a combined copy/customize
write without inventing an intermediate copy or regenerating a correct result.
Ambiguous replacements and additional edits retain the general phase-proof path;
arbitrary pre-existing files or model claims do not supply publication evidence.

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
