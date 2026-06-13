# Bug Report: Writing Specialist Contract Drift and Language-Aware Writer Routing

## Summary

During a LALACHAN story rewrite task, AgInTiFlow partially followed the user's request but failed several hard constraints:

1. It ignored exact requested output filenames and saved different files.
2. It accepted completion even though requested output paths were missing.
3. On a follow-up request that explicitly asked to use `writing_specialist` again, it repaired text with the main/in-session model instead.
4. The CLI was launched with `--language zh-Hans`, but the startup status still displayed `language=en (English)`.

This report also records a feature request: when both DeepSeek and OpenAI are configured, route the isolated writer by language by default:

- Chinese writing -> DeepSeek writer.
- English writing -> OpenAI writer.

Explicit environment/model overrides should still win.

## Environment

- Project: `/home/lachlan/ProjectsLFS/LALACHAN`
- AgInTiFlow command:

```bash
aginti --language zh-Hans --scs --routing smart
```

- Reported version: `v0.20.195`
- Session id shown after run: `web-agent-fb496b2e-c0ad-480f-a7c3-cbf0b6e1ff28`
- Runtime state showed:

```text
state   language=en (English)
state   roles route=deepseek/deepseek-v4-flash main=deepseek/deepseek-v4-pro spare=openai/gpt-5.4
```

## Original User Contract

The user asked AgInTiFlow to:

1. Read:

```text
references/stories/2026-06-13-biological-lab-dance.md
references/prompts/2026-06-13-biological-lab-dance-30s.md
```

2. Call `writing_specialist` for a real writing revision.
3. Save exact output paths:

```text
references/stories/2026-06-13-biological-lab-dance-aginti-writer-v2.md
references/prompts/2026-06-13-biological-lab-dance-aginti-writer-v2-30s.md
```

## Observed Behavior

The first run did correctly call `writing_specialist`. The SCS plan even noted that the hard contract required it:

```text
The user's hard contract demands calling writing_specialist for the rewrite.
```

However, it saved different output paths:

```text
references/stories/2026-06-13-biological-lab-dance-revised.md
references/prompts/2026-06-13-biological-lab-dance-30s-revised.md
```

It then reported success and "verification passed" even though the exact requested paths were absent.

The generated revision still included stiff language such as:

```text
我的手很稳，但跳舞的版本可能不太稳……
结论：实验需要冷静，也需要一点点节奏。
```

The user then explicitly asked for another pass and again said to use `writing_specialist`.

The second pass did not call `writing_specialist`. Its plan said:

```text
Using the in-session LLM, generate 2-3 casual conversational alternatives...
```

It then patched the earlier `*-revised.md` files rather than saving the exact `*-aginti-writer-v2*` paths. The main supervisor had to manually copy the revised files to the requested filenames afterward.

## Expected Behavior

For hard-contract writing tasks, AgInTiFlow should:

1. Treat exact output paths as required deliverables.
2. Validate every requested output path exists before finishing.
3. If the user explicitly asks for `writing_specialist`, call it for each requested revision pass unless it is unavailable.
4. If it cannot or chooses not to call `writing_specialist`, report that as a deviation and ask for approval rather than silently substituting the main model.
5. Keep SCS validation focused on the original user contract, including file names, tool-use requirements, and language.
6. Honor `--language zh-Hans` in runtime state and user-facing behavior, or clearly explain why another display language is active.

## Impact

- The agent's final success claim was not reliable.
- The user got files, but not at the paths requested.
- A follow-up "use writer again" instruction was weakened into a local patch operation.
- The main supervisor had to perform manual filename normalization and quality review.
- The language display mismatch makes it harder to trust language-aware routing or localized UX.

## Recommended Fixes

### 1. Exact Output Contract Validation

When the user names exact files, add them to a required-output set. Finish should be blocked until all required paths exist and are non-empty.

Suggested validation:

```bash
test -s references/stories/2026-06-13-biological-lab-dance-aginti-writer-v2.md
test -s references/prompts/2026-06-13-biological-lab-dance-aginti-writer-v2-30s.md
```

If the agent creates alternate filenames, it should either rename/copy them to the requested names or explicitly report non-compliance.

### 2. Tool-Use Contract Validation

When the user explicitly names a tool such as `writing_specialist`, SCS should record it as a required tool call and verify it occurred during the current turn or requested pass.

For multi-turn follow-up requests, the validator should not rely on tool use from a previous turn. The second pass requested `writing_specialist` again, so the second pass should have included another `writing_specialist` event or an explicit blocker.

### 3. Stronger Finish Gate

Before `finish`, the student/validator should check:

- requested files exist;
- requested tool calls occurred;
- forbidden substitutions did not happen;
- explicit language settings were honored;
- final answer names the exact files created.

### 4. Language Flag Consistency

Investigate why:

```bash
aginti --language zh-Hans --scs --routing smart
```

still displayed:

```text
language=en (English)
```

The startup state should reflect `zh-Hans` if the flag is accepted. If another setting overrides it, the UI should show the source of the override.

## Feature Request: Language-Aware Writing Provider Routing

Add default language-aware routing for the isolated `writing_specialist`.

When both DeepSeek and OpenAI credentials/config are available and no explicit writer provider/model override is supplied:

- Use DeepSeek for Chinese writing (`zh`, `zh-Hans`, `zh-Hant`, or CJK-heavy prompt/canon).
- Use OpenAI for English writing (`en` or English-heavy prompt/canon).

Rationale:

- DeepSeek has been useful for low-cost Chinese drafting and Chinese story continuity.
- OpenAI is preferred for smooth English prose, metadata, and international-facing copy.
- The writer route should be independent from the main executor route, because writing quality should not be polluted by shell/browser/task context.

### Proposed Configuration

Explicit overrides should win:

```bash
AGINTI_WRITING_PROVIDER=...
AGINTI_WRITING_MODEL=...
```

Optional language-specific overrides:

```bash
AGINTI_WRITING_PROVIDER_ZH=deepseek
AGINTI_WRITING_MODEL_ZH=deepseek-v4-pro
AGINTI_WRITING_PROVIDER_EN=openai
AGINTI_WRITING_MODEL_EN=gpt-5.4
```

If language-specific env vars are absent, use built-in defaults only when the provider is authenticated/available.

### Routing Rules

1. If request explicitly includes `provider` or `model`, use that.
2. Else if `AGINTI_WRITING_PROVIDER` or `AGINTI_WRITING_MODEL` is set, use it.
3. Else detect language from:
   - request language;
   - CLI/session language;
   - CJK character ratio in `writingBrief`, `canon`, `priorDraft`;
   - user prompt language.
4. If Chinese, choose DeepSeek if available.
5. If English, choose OpenAI if available.
6. If chosen provider is unavailable, fall back to current provider and record the fallback reason in the `writing_specialist` result.

## Suggested Regression Tests

### Exact Filename Test

Prompt:

```text
Read input.md, call writing_specialist, and save exactly to out/a.md and out/b.md.
```

Expected:

- `writing_specialist` event exists.
- `out/a.md` and `out/b.md` exist and are non-empty.
- Agent does not finish with `out/a-revised.md` or similar alternate names only.

### Follow-Up Writer Test

Prompt 1:

```text
Use writing_specialist to draft a Chinese scene and save scene.md.
```

Prompt 2:

```text
Use writing_specialist again to make the dialogue more natural and save scene-v2.md.
```

Expected:

- Two separate `writing_specialist` calls across the two turns.
- `scene-v2.md` exists.
- Finish does not rely on the first turn's tool call.

### Language Flag Test

Command:

```bash
aginti --language zh-Hans --scs --routing smart
```

Expected:

```text
state language=zh-Hans
```

or a clear override explanation.

### Writer Routing Test

With both DeepSeek and OpenAI available:

```text
请用中文写一个短故事。
```

Expected:

- `writing_specialist` provider is DeepSeek by default.

```text
Write an English product story.
```

Expected:

- `writing_specialist` provider is OpenAI by default.

## Manual Workaround Applied

The supervisor manually copied the useful revised files to the requested stable paths:

```text
references/stories/2026-06-13-biological-lab-dance-aginti-writer-v2.md
references/prompts/2026-06-13-biological-lab-dance-aginti-writer-v2-30s.md
```

The LALACHAN repo also had to record the corrected files and update the story database separately.
