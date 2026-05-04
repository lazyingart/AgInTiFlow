---
id: aaps
label: AAPS Workflows
description: Work with ../AAPS, .aaps files, @lazyingart/aaps, automation plans, and related project conventions.
triggers:
  - aaps
  - .aaps
  - @lazyingart/aaps
  - automation plan
  - pipeline script
  - large workflow
tools:
  - inspect_project
  - read_file
  - write_file
  - run_command
  - web_search
---
# AAPS Workflows

Use AAPS when the user wants a large workflow, autonomous pipeline script, `.aaps` file, or `@lazyingart/aaps` project.

## Operating Loop

1. Inspect `aaps.project.json`, `workflows/*.aaps`, and nearby project notes before generating workflows.
2. Prefer the AgInTiFlow adapter commands before raw shell guesses:
   - `/aaps status` or `aginti aaps status`
   - `/aaps init` or `aginti aaps init`
   - `/aaps files`
   - `/aaps validate [file]`
   - `/aaps parse [file]`
   - `/aaps compile [file] check`
   - `/aaps check [file]` or `/aaps dry-run [file]`
3. Keep all paths project-relative. Do not reference absolute local paths inside reusable `.aaps` files.
4. Use AAPS for top-down workflow contracts, agent/tool manifests, validation/recovery/review steps, and durable artifacts. Use normal AgInTiFlow file/shell tools for local implementation work under those contracts.
5. Validate or compile-check every new or edited `.aaps` workflow before reporting it is ready.

## Safety

Do not publish, upload, run destructive commands, or expose credentials unless explicitly requested and safe.

If AAPS is missing, suggest `/aaps install`, `aginti aaps install`, `npm install -g @lazyingart/aaps`, or setting `AAPS_BIN`.
