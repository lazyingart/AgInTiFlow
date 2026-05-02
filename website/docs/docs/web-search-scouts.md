# Web Search and Scouts

AgInTiFlow can use additional model calls to improve context before the main executor acts.

## Web Search

The `web_search` tool is for current documentation, package errors, and source discovery. It should return compact search results instead of putting the browser into a search-engine loop.

Disable it when needed:

```bash
aginti --no-web-search "work only from local files"
```

## Parallel Scouts

Scouts are advisory model calls. They do not write files. They produce focused notes for the executor.

Common scout roles:

- architecture
- implementation path
- test strategy
- review risks
- context map
- dependency risks
- git workflow

Use:

```bash
aginti --scout-count 5 "refactor this module safely"
aginti --no-parallel-scouts "make a small direct edit"
```

## Blackboard

Scout results are merged into a Swarm Board and saved in the session artifacts. The executor receives the board as context but still must inspect exact files before editing.

## Why It Helps

DeepSeek is inexpensive enough to spend a few extra calls on parallel perspective. The goal is not more chatter. The goal is better context, fewer blind edits, and stronger verification.
