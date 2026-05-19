---
name: structured-json
description: Use isolated schema-bound JSON generation for extraction, annotation, conversion, classification, or chunked data production without mixing in agent runtime context.
---

# Structured JSON

Use this skill when the user needs reliable JSON that follows an explicit schema, especially for repetitive chunk processing.

## Workflow

1. Define the smallest useful JSON Schema for the next data artifact.
2. Pass only the task, focused instructions, minimal domain context, input, and schema to `json_specialist`.
3. Use `json_specialist_batch` only when items are independent and can be processed in parallel without shared writes.
4. Keep formatting, file writes, validation scripts, compilation, and project-specific orchestration in the main agent.
5. After the tool returns, validate any project-specific invariants with local scripts before treating the data as complete.

## Boundaries

- Do not pass shell, browser, file policy, package-install, or agent-planning context into the JSON specialist.
- Do not make schemas book-, app-, or project-specific inside AgInTiFlow core. Project schemas belong in the target repository.
- Prefer provider-native structured output when available, but keep fallback parsing enabled unless the user explicitly wants hard failure on unsupported response formats.
