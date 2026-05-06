# Surgical Editing And Context Philosophy For Large Projects

This note answers a practical question: how can an agent make precise edits in a large project without reading the entire repository into the model context, losing local details, or becoming overconfident about bugs it has not actually proven?

The short answer is:

- A mature coding agent does not "know" the whole project at once.
- It keeps a cheap overview map outside the prompt.
- It pulls exact local evidence into context only when needed.
- It edits the smallest coherent surface.
- It verifies with commands, logs, tests, diffs, and durable artifacts.
- It compacts the result into stable memory and forgets stale local details.

This is the shared philosophy behind Codex-style patching, Claude Code style project memory, Gemini and Qwen project context files, Copilot repository instructions, Cursor rules, Karpathy-style skills, and AgInTiFlow's own scout and large-codebase design.

## The Real Problem

Large codebases create four conflicting needs:

- The agent needs global orientation: architecture, package manager, entry points, generated folders, tests, commands, conventions, and ownership boundaries.
- The agent needs local exactness: the function signature, import style, adjacent tests, line-level invariants, error message, and current diff.
- The model context is finite: every file pasted into the prompt pushes out other useful facts.
- The repository changes while the agent works: summaries become stale after edits, dependency installation, generated files, or user changes.

The wrong design is to stuff the full repo into context. It wastes tokens, mixes stale and fresh data, and makes bugs look like text-completion problems. The better design is evidence-driven retrieval with a small active working set.

## What Other Agents Teach

### Codex-style agents

Codex-style workflows emphasize explicit repo instructions, deterministic patching, local command execution, status/diff discipline, and verification. The local Codex repo's `AGENTS.md` is highly specific: it encodes commands, file ownership, code conventions, narrow tests, broad checks, and stop conditions. The important lesson is that instructions should be executable engineering policy, not vague preferences.

Useful pattern:

- Read instructions and manifests first.
- Avoid broad rewrites.
- Patch deterministically.
- Run the narrowest relevant check.
- Review the diff before finalizing.

### Claude Code style agents

Claude Code documents project memory through `CLAUDE.md`, with local memories, parent directory memories, user memories, and imported files. The philosophy is that long-lived repo knowledge belongs in memory files and settings, not repeatedly rediscovered inside every chat turn.

Useful pattern:

- Store durable project conventions in explicit memory files.
- Keep permissions and tool access visible.
- Use scoped commands and slash commands for repeatable workflows.
- Use hooks or policy surfaces for safety-critical behavior.

### Gemini CLI and Qwen Code style agents

Gemini and Qwen use project context files such as `GEMINI.md` and `AGENTS.md` to encode repository shape, commands, test rules, and gotchas. Their local repos also show monorepo-oriented guidance: workspace-specific tests, package boundaries, generated assets, and expensive checks that should only run at the end.

Useful pattern:

- Treat project context as a first-class input.
- Prefer workspace-specific tests before full-suite tests.
- Record gotchas that are not obvious from code search.
- Avoid rediscovering known build and test rules.

### GitHub Copilot style agents

Copilot coding-agent and custom-instruction docs emphasize repository instructions, issue/task context, GitHub workflow integration, and PR-oriented verification. The local Copilot SDK repo also uses a `.github/copilot-instructions.md` file with architecture, important files, commands, and E2E harness notes.

Useful pattern:

- Combine issue intent, repo instructions, and changed files.
- Keep reviewable diffs as the unit of work.
- Preserve E2E evidence when the bug is integration-level.
- Make generated or schema-driven files explicit.

### Cursor and rules-based agents

Cursor's rule system is a good example of a compact behavioral layer. Rules are not the codebase; they are persistent priors about how to behave in that codebase. This is useful because it prevents repetitive context dumps and reduces style drift.

Useful pattern:

- Keep rules short and triggerable.
- Use rules to constrain behavior, not to replace inspection.
- Prefer path-scoped rules for large repos.

### Karpathy-style skills

The local `andrej-karpathy-skills` repository is mostly behavior policy. The strongest principles are: think before coding, simplicity first, surgical changes, and goal-driven verification. This is exactly the antidote to large-project agent failure.

Useful pattern:

- Every changed line should trace to the user request.
- No speculative abstractions.
- Reproduce or define success before patching.
- Verify instead of narrating success.

## The Core Algorithm

For a large project, the agent should run this loop:

1. Build a repo map.
2. Read durable project instructions.
3. Identify the smallest credible hypothesis for the task.
4. Search for names, errors, tests, routes, commands, schemas, and owners.
5. Read only the boundary files needed for the next decision.
6. Patch one coherent invariant.
7. Run the narrowest relevant check.
8. Expand the radius only when evidence requires it.
9. Record what changed and what remains unknown.
10. Compact the result into durable memory or a ledger.

In AgInTiFlow terms, this is:

```text
inspect_project
  -> read AGINTI.md / AGENTS.md / README / manifests
  -> search exact symbols and errors
  -> read active evidence files
  -> apply_patch
  -> focused check
  -> broader check if justified
  -> event log + artifact + diff summary
```

## How The Agent Keeps Overview And Details

The key is to separate memory lanes. They have different lifetimes and different freshness rules.

### Stable project memory

Stable memory is slow-moving:

- `AGINTI.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or repo instructions.
- README and architecture notes.
- Package manifests and scripts.
- Test conventions.
- Security and permission policy.
- Known generated files and codegen commands.

Stable memory can be summarized and reused, but it must still be refreshed when the underlying files change.

### Project map

The project map is a cheap index:

- Top-level directories.
- Source and test roots.
- Language counts.
- Manifests and lockfiles.
- Package scripts.
- Likely entry points.
- Recommended first reads.
- Git status hints.

AgInTiFlow already has this idea in `inspect_project` and `.aginti/codebase-map.json`.

The project map tells the agent where to look. It does not prove a bug.

### Active evidence

Active evidence is small and exact:

- Search hits around the target symbol.
- Failing command output.
- Stack traces.
- The function or component being patched.
- Adjacent tests.
- Relevant config.
- Current git diff.

This is the only layer that should dominate the model's immediate prompt.

### Patch context

Patch context is the local edit surface:

- File path.
- Symbol name.
- Nearby code.
- Before hash or diff.
- Intended invariant.
- Test that should prove it.

Patch context should be small enough that `apply_patch` can act deterministically.

### Verification state

Verification state is not a summary of the model's opinion. It is external evidence:

- Command.
- Exit code.
- stdout/stderr.
- Files created.
- Artifact hashes.
- Test names.
- Event logs.
- Screenshots or reports when relevant.

If this layer is missing, the agent does not know the bug is fixed.

## How To Keep Detail Without Context Explosion

The practical trick is to put handles in context, not whole objects.

Use this shape:

```json
{
  "path": "src/session-store.js",
  "symbol": "appendSessionEvent",
  "lines": "120-178",
  "hash": "sha256:...",
  "claim": "writes tool_result events after tool_call events",
  "freshness": "valid for commit abc123 before current patch",
  "why_relevant": "provider 400 showed unmatched tool_call history"
}
```

This handle is cheap. The agent can re-read the exact file when it needs the real text. If the file changes, the handle becomes stale.

Good context management uses:

- Path and symbol references instead of pasted files.
- Line windows instead of whole modules.
- File hashes to detect stale summaries.
- Search queries as recoverable evidence trails.
- Diff summaries for changed files.
- Artifact paths instead of pasted artifacts.
- A test ledger instead of repeated narrative.

The model should not try to remember every detail. It should remember how to recover every detail.

## How The Agent Finds Bugs In A Big Project

The agent does not "know" the bug by intuition. It forms hypotheses from evidence.

Strong bug signals:

- Failing test with a minimal reproduction.
- Stack trace pointing to a symbol or data shape.
- Type error or lint error after a specific change.
- Runtime log with request id, event id, tool id, path, or status.
- Git diff showing the most recent behavior change.
- Invariant mismatch: declared output missing, event missing, permission policy contradicted.
- User-visible reproduction steps.
- Integration boundary mismatch: CLI says success but filesystem or web API disagrees.

The debugging loop should be:

1. Reproduce or capture the symptom.
2. Classify the failure: logic, state, API contract, serialization, concurrency, path, permissions, dependency, generated file, UX, or test harness.
3. Trace from symptom to owner boundary.
4. Inspect the contract at that boundary.
5. Patch the smallest invariant.
6. Add or update a regression check when possible.
7. Re-run the failing check.
8. Run the nearest broader check.

If the agent cannot reproduce the bug, it should say so and create a better diagnostic path. Guessing a patch without reproduction is acceptable only for tiny obvious fixes, and the uncertainty must be recorded.

## Surgical Edit Discipline

Surgical editing is not just "small diff." It is "small diff with the correct boundary."

Rules:

- Do not rewrite a module to fix one branch.
- Do not format unrelated code.
- Do not rename symbols unless the bug requires it.
- Do not add abstractions for a one-off fix.
- Do not change tests only to match broken behavior.
- Do not edit generated files without running the generator when the repo expects generation.
- Do not touch unrelated dirty files.
- Stop if user changes conflict with the active patch.

Good surgical edit record:

```text
Symptom:
  Provider rejects request because tool_call events are not followed by matching tool_result events.

Boundary:
  Session event replay into model request construction.

Patch:
  Normalize replay so orphan tool_call events are either paired, omitted, or converted before requestNextStep.

Check:
  Unit test for replayed session with interrupted tool call.
  Live /review smoke after reinstall.
```

Bad surgical edit record:

```text
Updated model client and session code.
Seems fixed.
```

## How AgInTiFlow Implements This

AgInTiFlow already has the right starting pieces:

- `inspect_project` for a cheap deterministic map.
- `large-codebase` profile for behavior bias.
- Parallel scouts for advisory role separation.
- `scout-blackboard.json` for a compact shared board.
- Session events and artifacts for durable evidence.
- AAPS for explicit workflows and declared outputs.

The current implementation adds a lightweight surgical context pack for complex engineering tasks when parallel scouts are disabled or unavailable. The runtime refreshes `.aginti/codebase-map.json`, saves `surgical-context-pack.json` as a session artifact, injects a bounded overview message into model history, and carries the context handle in step snapshots. The injected contract tells the executor to use the map as orientation, then re-read exact files before editing.

The next mature design is a fuller evidence-card system.

### Evidence cards

Each important observation should become a small structured card:

```json
{
  "id": "E-20260506-001",
  "kind": "failing-test",
  "path": "tests/session-replay.test.js",
  "symbol": "replays interrupted tool calls",
  "command": "npm test -- tests/session-replay.test.js",
  "observed": "400 invalid_request_error: insufficient tool messages",
  "fresh_at_commit": "abc123",
  "owner": "model-client/session replay",
  "status": "active"
}
```

Cards should be short, source-backed, and invalidated when the relevant files or commits change.

### Context governor

AgInTiFlow should budget context by lanes:

- Goal and user constraints: always present.
- Safety and permission policy: always present.
- Project map: compact summary only.
- Active evidence: high priority, small.
- Patch plan: current step only.
- Verification: latest command and result.
- Historical notes: handles only unless rehydrated.

Eviction should prefer:

- Drop old scout transcripts after synthesis.
- Drop full command logs after saving path and summary.
- Drop stale file summaries after edits.
- Drop low-relevance docs after the active boundary is known.

### Scout roles

For hard tasks, use scouts as bounded lenses, not as uncontrolled agents:

- Cartographer: map files and entry points.
- Symbol tracer: identify names, routes, schemas, and callers.
- Bug reproducer: find or create the smallest failing check.
- Surgeon: propose patch boundary only.
- Tester: choose narrow and broader checks.
- Reviewer: find missing cases, safety risks, and false completion.
- Integrator: resolve cross-file ordering and ownership.

The main executor must still inspect exact files and run checks.

### Bug cards

When a bug is found, store:

- Symptom.
- Reproduction command.
- Expected behavior.
- Observed behavior.
- Owner boundary.
- Files inspected.
- Patch files.
- Regression check.
- Retest evidence.
- Remaining risk.

This prevents the agent from rediscovering the same bug and makes future sessions smarter without bloating prompt context.

### AAPS connection

For very large tasks, AgInTiFlow should convert the task into an AAPS-style workflow:

- Declare stages.
- Declare inputs and outputs.
- Declare validation gates.
- Declare recovery steps.
- Persist artifacts.
- Let AgInTiFlow execute or supervise each bounded stage.

This turns "fix the big project" into a sequence of verifiable units.

## Practical Checklist For Any Large-Project Agent

Before editing:

- Check `git status --short`.
- Read project instructions.
- Inspect manifests and scripts.
- Identify source and test roots.
- Capture the failing symptom or user goal.
- Search exact symbols or error strings.
- Read only the files needed for the first patch.

During editing:

- Patch one coherent boundary.
- Keep style local.
- Avoid unrelated cleanup.
- Track generated files separately.
- Preserve user changes.
- Record why each touched file is necessary.

After editing:

- Run the narrowest relevant check.
- Run a broader check if the touched boundary justifies it.
- Inspect the diff.
- Verify declared files and artifacts exist.
- Record remaining unknowns.
- Commit only intended files when asked.

## Direct Answers

### How can it know local details and keep the overview in mind?

By not mixing them. The overview is a compact map plus repo instructions. Local details are exact file windows retrieved on demand. The model carries the map and the current evidence window, not the entire project.

### How can it keep many details without context exploding?

It stores details outside the prompt as handles, cards, logs, diffs, hashes, and artifacts. The prompt contains only the current goal, constraints, map summary, active evidence, and patch plan. Everything else is rehydrated by path, symbol, command, or test id.

### How does it know the bug in a big project?

It does not know by reading broadly. It triangulates from symptoms, tests, logs, stack traces, diffs, and invariants. A bug becomes "known" when the agent can state the failing boundary and verify that a patch changes the external evidence.

### What should AgInTiFlow learn from other agents?

Use persistent instruction files like Claude, Gemini, Qwen, Copilot, and Codex. Use deterministic patching and verification like Codex. Use rules and skills like Cursor and Karpathy-style systems. Use scouts only as bounded advisors. Store evidence in durable session artifacts. Use AAPS when work needs declared outputs and multi-stage verification.

## Sources And Local References

Primary docs:

- OpenAI Codex AGENTS.md guide: https://developers.openai.com/codex/guides/agents-md
- Anthropic Claude Code memory: https://docs.anthropic.com/en/docs/claude-code/memory
- Anthropic Claude Code overview: https://docs.anthropic.com/en/docs/claude-code/overview
- Gemini CLI GEMINI.md docs: https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html
- GitHub Copilot custom instructions: https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot
- GitHub Copilot coding agent: https://docs.github.com/en/copilot/concepts/coding-agent/coding-agent
- Cursor rules: https://docs.cursor.com/context/rules

Local references:

- `docs/large-codebase-engineering.md`
- `src/parallel-scouts.js`
- `references/raw/codex/`
- `references/raw/claude-code/`
- `references/raw/gemini-cli/`
- `references/raw/qwen-code/`
- `references/raw/copilot/`
- `/home/lachlan/ProjectsLFS/Agent/andrej-karpathy-skills/skills/karpathy-guidelines/SKILL.md`
