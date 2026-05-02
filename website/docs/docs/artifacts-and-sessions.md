# Artifacts and Sessions

Every run writes structured state to the project-local session folder.

```text
.sessions/
  web-state.sqlite
  <session-id>/
    state.json
    events.jsonl
    artifacts/
```

## Events

The event stream records:

- session creation and resume
- plans
- model responses
- tool calls
- shell output summaries
- workspace file changes
- blocked operations
- final answers

## Artifacts

Artifacts can include:

- screenshots
- generated images
- SVG/PNG/JPG plots
- PDFs
- text files
- Markdown reports
- JSON snapshots
- canvas-selected outputs

## Canvas Tunnel

The backend can send selected artifacts to the frontend canvas. The user can also select files manually from the artifact explorer.

Useful examples:

```text
draw f(x) = x + exp(x)
write a LaTeX report and compile the PDF
generate an image concept and send it to the canvas
```

If a PDF exists, the web UI should prefer rendering it in the PDF reader. If an image exists, it can render in the image canvas. Text and Markdown can render in the editor view.

## Inbox and Queues

During a running session, extra user input can be stored in the session inbox. ASAP messages are consumed before after-finish queued messages.
