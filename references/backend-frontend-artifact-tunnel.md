# Backend-Frontend Artifact Tunnel

This document records the AgInTiFlow canvas/artifacts tunnel design. The tunnel is the communication path that lets backend agent execution publish useful visual or textual outputs, while the frontend presents them as a canvas, explorer, and notification surface.

## Purpose

The chat stream is good for conversation, but it is not enough for agent work that creates screenshots, code diffs, markdown reports, images, or generated files. The artifact tunnel provides a separate visualization layer:

- Backend agents can optionally call `send_to_canvas` for important outputs.
- Runtime events automatically expose screenshots, snapshots, file changes, and final answers.
- The frontend can show unread artifact counts, lists, previews, and manual selection.
- Users can open selected image/text artifacts without digging through `~/.agintiflow/sessions/`.

The tunnel is optional. Agents can still answer normally with `finish`; they should use `send_to_canvas` only when an output benefits from visual focus or file-style inspection.

## Source Of Truth

Session events are the durable backend contract. The tunnel is derived from `~/.agintiflow/sessions/<session-id>/events.jsonl` rather than a separate artifact database.

Relevant events:

- `canvas.item`: explicit agent-published artifact from `send_to_canvas`.
- `canvas.selected`: selected artifact, emitted by the agent or UI.
- `snapshot.captured`: browser/runtime snapshot metadata and screenshot paths.
- `file.changed`: workspace edit provenance, hashes, and compact diff.
- `session.finished`: final answer exposed as a markdown artifact.

Implementation files:

- `src/artifact-tunnel.js`: artifact derivation, serialization, safe content reads.
- `src/agent-runner.js`: executes `send_to_canvas`, emits `canvas.item` and `canvas.selected`.
- `src/model-client.js`: exposes `send_to_canvas` to DeepSeek/OpenAI-compatible tool calling and mock mode.
- `web.js`: REST API for listing, selecting, and reading artifacts.
- `public/app.js`, `public/index.html`, `public/styles.css`: Canvas/Explorer/Notifications modal.

## Artifact Shape

Public artifact metadata is intentionally small and safe:

```json
{
  "id": "stable-or-canvas-id",
  "sessionId": "web-agent-...",
  "kind": "image|markdown|text|json|diff|file",
  "title": "Change: README.md",
  "path": "README.md",
  "preview": "Short redacted summary",
  "source": "agent-canvas|snapshot|file-change|workspace-file|session",
  "tab": "canvas|explorer|notifications",
  "createdAt": "2026-05-01T...",
  "selected": true,
  "mime": "text/markdown; charset=utf-8"
}
```

Content is not included in the list response. The UI requests content only after the user opens/selects an item.

## Agent Tool Contract

`send_to_canvas` arguments:

```json
{
  "title": "Summary chart",
  "kind": "markdown",
  "content": "## Result\n...",
  "path": "optional/workspace-relative-file.png",
  "note": "Short notification text",
  "selected": true
}
```

Rules:

- `title` and `kind` are required.
- Inline `content` is capped at 120 KB.
- `path` must be workspace-relative and pass the same guarded read policy as `read_file`.
- If `selected` is not `false`, the backend emits `canvas.selected` so the frontend can prioritize it.
- Tool logs hash/redact inline content instead of printing it.

Use this tool for screenshots, generated images, markdown reports, diffs, and important output files. Do not use it for every ordinary text answer.

Visual-output requests are the main proactive trigger. If the user asks to draw, plot, graph, chart, diagram, create a figure, or visualize something, the agent should infer that the canvas is useful even when the user does not mention canvas. When file tools are enabled, prefer creating a small SVG/markdown artifact and then call `send_to_canvas` with `selected: true`.

## REST API

List artifacts:

```bash
GET /api/sessions/:sessionId/artifacts?seenAfter=<iso-time>
```

Returns:

```json
{
  "ok": true,
  "items": [],
  "selectedItemId": "artifact-id",
  "unreadCount": 2
}
```

Read artifact content:

```bash
GET /api/sessions/:sessionId/artifacts/:artifactId
```

Returns text content:

```json
{
  "ok": true,
  "kind": "markdown",
  "title": "Final answer",
  "text": "..."
}
```

Or image content:

```json
{
  "ok": true,
  "kind": "image",
  "mime": "image/png",
  "dataUrl": "data:image/png;base64,..."
}
```

Select an artifact:

```bash
POST /api/sessions/:sessionId/artifacts/select
Content-Type: application/json

{"artifactId":"..."}
```

The selection endpoint appends `canvas.selected` with `source: "user"`.

## Frontend Behavior

The chat header has a `Canvas` button with a red unread badge. The modal has three tabs:

- Canvas: agent-selected visual focus items and screenshots.
- Explorer: snapshots and workspace files.
- Notifications: file diffs and final answers.

Selection flow:

1. UI loads artifact metadata for the current session.
2. UI displays unread count based on `seenAfter` stored in browser `localStorage`.
3. User opens the modal and selects an artifact row.
4. UI calls the selection API, then loads content by artifact id.
5. Images render in a preview frame; text/markdown/json/diff render in a readonly editor.

Unread state is currently local to the browser. This is deliberate: it avoids extra persistence while keeping the server event model simple.

## Safety Model

The tunnel must never become a secret/file exfiltration path.

Current safeguards:

- Artifact list response exposes display paths, not absolute filesystem paths.
- Session files must stay inside the owning `~/.agintiflow/sessions/<session-id>/` directory.
- Workspace file reads reuse `checkWorkspaceToolUse("read_file", ...)`.
- `.env`, `.npmrc`, keys, secret-like paths, `.git`, huge files, and binary text reads are blocked.
- Text content is redacted through `redactSensitiveText`.
- Inline canvas content is size-limited.
- Image previews are capped at 4 MB; text previews are capped at 520 KB.
- Agent tool args are sanitized before event/tool logs.

## Derived Artifact Mapping

| Event | Source | Default Tab | Render |
| --- | --- | --- | --- |
| `canvas.item` | `agent-canvas` | `canvas` | inline text or guarded workspace file |
| `snapshot.captured` screenshot | `snapshot` | `canvas` | image |
| `snapshot.captured` JSON | `snapshot` | `explorer` | JSON text |
| `file.changed` diff | `file-change` | `notifications` | diff text |
| `file.changed` path | `workspace-file` | `explorer` | guarded file/image read |
| `session.finished` | `session` | `notifications` | markdown text |

## Development Notes

Smoke coverage lives in `scripts/smoke-web-api.js`. It starts a temporary web server, runs mock tasks, checks artifact list/content/select endpoints, and deletes sessions afterwards.

Useful checks:

```bash
npm run check
npm run smoke:web-api
npm test
```

Manual UI smoke:

1. Start the app with `npm run web`.
2. Run a mock/manual task whose goal includes `canvas artifact preview`.
3. Open `http://127.0.0.1:3210/`.
4. Click `Canvas`.
5. Confirm the badge, tabs, artifact rows, selection, and text/image preview work.

## Future Extensions

- Server-side notification read state for multi-browser consistency.
- Artifact search/filter by kind, path, source, and session.
- Streaming canvas updates over SSE/WebSocket instead of polling through run refresh.
- Editable artifact notes or user annotations.
- Larger binary artifact handling through signed local URLs instead of base64 JSON.
- Agent-facing artifact memory summary so follow-up tasks can refer to prior canvas selections.
