# Session And Artifact Storage

## Current Logic

AgInTiFlow now uses global canonical session storage plus a project-local pointer/index folder.

Canonical global storage:

```text
~/.agintiflow/
  sessions/
    index.sqlite
    <session-id>/
      events.jsonl
      state.json
      plan.md
      inbox.jsonl
      storage-state.json
      artifacts/
        step-XXX.snapshot.json
        step-XXX.png
        canvas/
```

Project-local storage:

```text
<project>/
  .aginti/
    .env
    codebase-map.json
  .aginti-sessions/
    web-state.sqlite
    <session-id>/
      session.json
```

Legacy responsibilities:

- `~/.agintiflow/sessions/<session-id>/` is the canonical source of truth for state, chat, events, inbox, browser state, and artifacts.
- `~/.agintiflow/sessions/index.sqlite` stores global session metadata: session id, project root, session dir, timestamps, provider/model, goal, title, and status.
- `<project>/.aginti-sessions/` stores project-local session pointers so `aginti resume` can discover sessions from the working folder.
- `<project>/.aginti-sessions/web-state.sqlite` stores web UI session metadata, preferences, and friendly titles for the project.
- Legacy `<project>/.sessions/` folders are copied into the global store by `aginti storage migrate` and remain readable as a fallback.

## Legacy Logic Before Migration

Older AgInTiFlow releases used project-local storage as the primary source of truth for chat sessions and frontend artifacts.

Project root:

```text
<project>/
  .aginti/
    .env
    codebase-map.json
  .sessions/
    web-state.sqlite
    <session-id>/
      events.jsonl
      state.json
      plan.md
      inbox.jsonl
      artifacts/
        step-XXX.snapshot.json
        step-XXX.png
        canvas/
```

Current responsibilities:

- `.sessions/` stores CLI and web session history for the current project.
- `.sessions/web-state.sqlite` stores web UI session metadata and project-local web preferences.
- `.sessions/<session-id>/events.jsonl` is the durable event log for model messages, tool calls, state changes, canvas selections, and finish results.
- `.sessions/<session-id>/state.json` stores the latest run/session state.
- `.sessions/<session-id>/inbox.jsonl` stores ASAP pipe messages for active sessions.
- `.sessions/<session-id>/artifacts/` stores runtime artifacts such as snapshots, screenshots, persisted canvas copies, and generated artifact metadata.
- `.aginti/.env` stores project-local provider keys and is ignored by git.
- `.aginti/codebase-map.json` stores project-local codebase map/cache data for large-codebase and scout workflows.
- `~/.agintiflow/docker/` stores persistent Docker support folders mounted as `/aginti-home`, `/aginti-cache`, and `/aginti-env`.

Legacy web rendering flow:

1. The web server is launched from a project root.
2. `web.js` uses that folder as `baseDir` and sets `sessionsDir = <project>/.sessions`.
3. Artifact APIs read from the same session folder:

```text
GET  /api/sessions/:sessionId/artifacts
GET  /api/sessions/:sessionId/artifacts/:artifactId
POST /api/sessions/:sessionId/artifacts/select
```

4. `artifact-tunnel.js` derives artifact listings from `events.jsonl`.
5. When `send_to_canvas` references a workspace file, AgInTiFlow copies a durable preview copy into:

```text
<project>/.sessions/<session-id>/artifacts/canvas/
```

6. The frontend renders artifacts through the local web API instead of exposing raw filesystem paths directly.

The legacy design was intentionally portable, but it made active project folders grow quickly.

## `~/.aginti` Versus `~/.agintiflow`

Current intended split:

- `~/.aginti`: user-facing/global AgInTi configuration home, future global preferences, and possibly global indexes.
- `~/.agintiflow`: AgInTiFlow runtime home for canonical sessions, global session index, artifacts, and Docker/toolchain/cache persistence.

Current reality:

- Project keys are mainly stored in `<project>/.aginti/.env`, not global home.
- Project sessions and artifacts are stored in `~/.agintiflow/sessions/<session-id>/`.
- Project folders keep `.aginti-sessions/` pointers and the web UI database.
- Docker home/cache/env are stored under `~/.agintiflow/docker/`.

Future cleanup should either consolidate names or document a stable migration policy.

## Problems Solved By The Current Migration

- New runs no longer grow `.sessions/` inside active workspaces.
- Copying binary artifacts into every session can duplicate data.
- Sensitive projects may not want chat logs or screenshots beside source code.
- Git tooling ignores `.aginti-sessions/`, legacy `.sessions/`, and `.aginti/.env`.
- Deleting a project no longer deletes canonical session history immediately.
- A global index can show where a session came from even when the web server is launched elsewhere.

## Future Option: Deduplicated Blob Store

A possible future design is to deduplicate large artifacts as content-addressed blobs while keeping the current global session folders and project-local pointers.

Proposed layout:

```text
~/.agintiflow/
  sessions/
    index.sqlite
    <session-id>/
      events.jsonl
      state.json
      artifacts/
        manifest.json
        blobs/
          sha256/

<project>/
  .aginti/
    project.json
    .env
  .aginti-sessions/
    <session-id>/
      session.json
```

Two viable variants:

- Pointer metadata: keep `~/.agintiflow/sessions/<session-id>/artifacts/manifest.json` with blob references.
- Symlink bridge: keep selected artifact folders as symlinks into `~/.agintiflow/sessions/<session-id>/artifacts/blobs/...`.

The pointer metadata variant is more portable across Windows, WSL, Docker, and remote filesystems. The symlink variant is simpler on Linux/macOS but needs fallback behavior when symlinks are blocked.

## Recommended Future Direction

Use a hybrid model:

- Keep canonical chat/session metadata in `~/.agintiflow/sessions/<session-id>/`.
- Add optional content-addressed blobs for large files.
- Keep small text artifacts and critical session state directly in the session folder.
- Store large binary canvas artifacts in `~/.agintiflow/sessions/<session-id>/artifacts/blobs/sha256/...`.
- Store project-local manifests that point to those blobs.
- Allow `aginti doctor` to validate broken pointers and missing blobs.
- Add `aginti sessions export` to create a portable archive with dereferenced artifacts.
- Add `aginti sessions prune` to clean old global blobs safely.

This gives the project-local UX users already understand while avoiding uncontrolled growth from images, PDFs, screenshots, and generated media.

## Implementation To-Do

1. Define `AGINTI_HOME`, defaulting to `~/.aginti`.
2. Keep backward-compatible support for `~/.agintiflow/docker`.
3. Add a storage policy setting:

```text
storage.sessions = "project"
storage.artifacts = "project" | "global-blobs" | "symlink"
```

4. Add a `ProjectId` derived from canonical project path plus a stable `.aginti/project.json` id.
5. Extend `SessionStore` with an artifact backend interface:

```text
putArtifact(buffer, metadata) -> artifactRef
readArtifact(artifactRef) -> stream/buffer
listArtifacts(sessionId) -> metadata[]
deleteArtifact(artifactRef) -> result
```

6. Update `artifact-tunnel.js` to persist canvas files through that backend.
7. Update `web.js` artifact APIs to resolve either project-local paths or global blob refs.
8. Add migration:

```text
aginti storage migrate --artifacts global-blobs
aginti storage migrate --artifacts project-local
```

9. Add smoke tests for:

- project-local artifacts still render
- global blob artifacts render
- missing blob produces a clear UI/API error
- symlink fallback works when symlinks are not available
- CLI and web still share the same session history

## Compatibility Notes

- Windows may require pointer metadata rather than symlinks.
- Docker workspace mode must map any global artifact directory read-only or through the host-side API, not assume it exists inside `/workspace`.
- Project export/import must include global artifacts if the user asks for a self-contained archive.
- Secrets should not be stored in artifact manifests or copied canvas payloads.
- Web APIs should continue serving artifacts through authenticated/local routes, never by leaking arbitrary absolute paths.
