---
id: structured-json
label: Structured JSON Generation
description: Use isolated schema-bound JSON generation for extraction, annotation, conversion, classification, repair, or chunked data production without mixing in agent runtime context.
triggers:
  - structured json
  - json schema
  - schema-bound
  - json specialist
  - json fetcher
  - parallel json
  - repair json
  - valid json
tools:
  - json_specialist
  - json_specialist_batch
  - read_file
  - write_file
  - run_command
---

# Structured JSON

Use this skill when the user needs reliable JSON that follows an explicit schema, especially for repetitive chunk processing.

## Workflow

1. Define the smallest useful JSON Schema for the next data artifact.
2. Pass only the task, focused instructions, minimal domain context, input, and schema to `json_specialist`.
3. Use `json_specialist_batch` only when items are independent and can be processed in parallel without shared writes.
4. Keep formatting, file writes, validation scripts, compilation, and project-specific orchestration in the main agent.
5. After the tool returns, validate any project-specific invariants with local scripts before treating the data as complete.

## Provider Strategy

- Prefer provider-native structured output when available, such as JSON Schema or JSON object mode.
- Keep a fallback parser/repair path for providers that do not support strict schema responses.
- On validation failure, retry with the exact schema errors and only the smallest relevant source text.
- For batch work, write candidate JSON per chunk first; promote it only after schema and semantic validators pass.
- Keep schema versions in the artifact metadata so old reviewed outputs can be reused or selectively regenerated when prompts change.
- Keep prompt versions and validator versions in or near the artifact metadata. When quality rules change, backfix only artifacts made stale by that change instead of restarting the whole corpus.
- Before retrying the provider, classify whether the failure is semantic or mechanical. Use local canonicalization for deterministic fixes such as token splitting, punctuation restoration from source text, missing default fields, role aliases, or renderer wrappers.

## Boundaries

- Do not pass shell, browser, file policy, package-install, or agent-planning context into the JSON specialist.
- Do not make schemas book-, app-, or project-specific inside AgInTiFlow core. Project schemas belong in the target repository.
- Do not hard-code source-specific semantic rules in this skill. If JSON quality requires language-specific or corpus-specific checks, make them part of the project schema, project validator, or project-local skill and record the version.
- Do not let parallel JSON workers share one mutable output file. Use shard-local outputs, atomic renames, and a serialized merge/promote step.
