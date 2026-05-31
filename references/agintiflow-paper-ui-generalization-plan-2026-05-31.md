# AgInTiFlow Paper UI Generalization Plan

Date: 2026-05-31

Purpose: preserve the research findings from the collaborator `robbie194/AgInTi-OverTree` paper-writing UI and define how to generalize its useful workspace design into the main AgInTiFlow web UI without making AgInTiFlow paper-only.

## Source Repositories

- Main AgInTiFlow repo: `/home/lachlan/ProjectsLFS/Agent/AgInTiFlow`
- Collaborator repo: `/home/lachlan/ProjectsLFS/Agent/AgInTi-OverTree`
- Collaborator remote: `https://github.com/robbie194/AgInTi-OverTree.git`
- Main installed webapp checked: `http://127.0.0.1:3210/`
- Collaborator paper UI route expected by request: `http://127.0.0.1:3210/paper-ui/`

## Research Snapshot

The collaborator repo contains a dedicated `paper-ui/` frontend:

- `paper-ui/index.html`
- `paper-ui/app.js`
- `paper-ui/styles.css`

The current installed/main AgInTiFlow webapp on port `3210` is healthy, but `/paper-ui/` returns `404`. Therefore the paper UI is not currently present in the installed main app. Integration requires both frontend structure and backend route/API work.

The collaborator paper UI is a one-page workspace shell:

- Left rail: AI engine summary, workspace path selector, workspace session selector, persistent file explorer.
- Center workbench: `Preview` and `Session` tabs.
- Preview area: paper modules, mapped files, embedded editor, media preview, diff/history surfaces.
- Session area: chat thread and chat composer.
- Modals: workspace picker and AI engine settings.

Useful implementation areas:

- Static route: `web.js` serves `/paper-ui`.
- Workspace APIs: `GET /api/path-children`, `POST /api/workspace/snapshot`, `GET /api/workspace/raw`, `POST /api/workspace/write`, `POST /api/workspace/delete`, `POST /api/workspace/rename`.
- File classifier: maps files into paper modules from path, extension, and filename heuristics.
- Drag/drop mapping: files can be dragged from explorer into modules.
- Media preview: images and PDFs use backend raw-file URLs.
- Workspace persistence: browser localStorage preserves open files, module overrides, selected file, chat, and session state.

## What To Preserve

Preserve these patterns because they improve general usability:

- A visible file explorer as a first-class workspace surface, not hidden inside an artifact modal.
- A persistent workspace path and session selector so users understand which project and run they are editing.
- Drag/drop file organization with explicit visual feedback.
- Automatic file grouping as a recommendation, not a destructive operation.
- Embedded file editor with save/revert, dirty-state indicator, and read-only/binary handling.
- Image/PDF/table/code previews in the main work surface.
- Diff/history visibility near the edited file.
- Chat can reference selected file/module/workspace context.
- Settings have simple top-level controls plus advanced controls.

## What Not To Copy Directly

Do not copy these paper-specific assumptions into core AgInTiFlow:

- Fixed paper modules: `Idea`, `Figures`, `Tables`, `Draft LaTeX`, `References`, `Raw Data`.
- Paper-specific placeholder text and manuscript assumptions.
- LocalStorage-only workspace truth for real projects.
- File classification that treats every task as manuscript production.
- Backend APIs that bypass the existing AgInTiFlow workspace policy layer.

AgInTiFlow must remain a general agent workspace for coding, writing, research, data analysis, AAPS, system tasks, long jobs, images, PDFs, and paper writing.

## Recommended Main UI Architecture

Use a three-region application shell.

Left: Workspace Explorer

- Project/workspace path selector.
- Session selector.
- Persistent file tree.
- Artifact roots.
- Search/filter.
- File badges: changed, binary, generated, artifact, ignored/internal.
- Safe server-side directory picker.

Center: Conversation And Run Surface

- Chat timeline.
- Current run status.
- Plan/tool/patch/output cards.
- Stop/queue/pipe controls.
- Selected scope indicator.
- Main execution evidence.

Right: Dynamic Tab Workbench

- Closable tabs for settings, artifacts, files, previews, diffs, history, run output, MCP, AAPS, long jobs, and inspector views.
- Opening Settings creates or focuses a `Settings` tab.
- Opening an artifact creates or focuses an artifact preview tab.
- Opening a file creates or focuses a file editor/preview tab.
- Tabs persist per browser session and selected AgInTiFlow session.

## Generalized Workspace Lanes

Replace paper modules with configurable workspace lanes.

Default general lanes:

- Source
- Docs / Drafts
- Data / Tables
- Figures / Images
- References
- Scripts / Tools
- Logs / Review
- Artifacts
- Internal / Hidden

Domain profile overlays:

- Paper profile: Idea, Figures, Tables, Draft, References, Raw Data.
- Coding profile: Source, Tests, Docs, Config, Build, Logs.
- Data profile: Raw Data, Cleaned Data, Scripts, Figures, Reports.
- AAPS profile: Projects, Workflows, Programs, Blocks, Scripts, Data, Outputs.
- Writing profile: Outline, Characters/Canon, Drafts, Research, Revisions, Exports.

The automap operation should:

- Recompute recommended lanes from paths/extensions.
- Preserve manual overrides unless the user explicitly resets them.
- Explain why a file was mapped.
- Exclude internal/generated/vendor/cache paths by default.

## Workspace Backend Design

Main AgInTiFlow should add or adapt backend workspace APIs, but route them through existing guardrails and workspace policy.

Required API concepts:

- `GET /api/path-suggestions`: already exists in main app.
- `GET /api/path-children`: browse server-side directories with policy filtering.
- `POST /api/workspace/snapshot`: return bounded file tree and previews for selected cwd.
- `GET /api/workspace/raw`: stream a workspace file for image/PDF/table/code preview.
- `POST /api/workspace/write`: guarded text write.
- `POST /api/workspace/delete`: guarded delete.
- `POST /api/workspace/rename`: guarded rename.
- `GET /api/workspace/map`: load saved lane overrides.
- `POST /api/workspace/map`: save lane overrides.

Safety requirements:

- The browser never gets direct local filesystem authority.
- Frontend paths are always logical workspace paths.
- Backend resolves all paths and blocks traversal.
- Hidden/internal paths remain hidden unless the user enables advanced visibility.
- Symlinks must be shown with target metadata and policy warnings.
- Writes through symlinks should stay blocked by default unless the resolved target is inside the workspace and policy allows it.

## Artifact Storage Design

Keep session artifacts centralized, but expose them clearly in project context.

Canonical session artifact root:

- `~/.agintiflow/sessions/<session-id>/artifacts`

Project-visible links:

- `.aginti/artifacts/<session-id>` as a symlink or pointer to the canonical session artifact root.
- `.aginti/artifacts/current` as an optional convenience pointer.

Rules:

- The canonical artifact store remains session-owned and durable.
- Project-visible links help users find outputs from their project folder.
- The UI must distinguish session artifacts from project outputs.
- Large binary previews should stream from backend endpoints, not inline into JSON.
- Broken symlinks should be detected and offered a repair action.
- If symlink creation is unavailable on Windows or restricted systems, fall back to pointer JSON files.

## Settings Design

Move current modal settings into a right-side tab.

Settings tab layout:

- Left vertical subnav.
- Right settings content.
- Close button in tab strip.
- Dirty-state indicator when settings changed.
- Save/reset controls.

Subtabs:

- Models and routing.
- SCS and validation.
- Permissions and sandbox.
- Workspace and files.
- Artifacts and canvas.
- MCP.
- AAPS integration.
- Wrappers.
- Auxiliary image/video providers.
- Advanced import/paste config.

The top-level chat area should keep only common run toggles. Advanced controls belong in the Settings tab.

## Chat And Selected Scope

The chat composer should show what it is acting on:

- Whole workspace.
- Selected file.
- Selected artifact.
- Selected lane.
- Selected AAPS workflow/program/block.
- Selected MCP/resource context.

Dropping a file or artifact into chat should insert a structured mention, not raw content:

```text
@file path/to/file.md
@artifact session-id/artifact-id
@lane Figures
```

The backend should receive selected-scope metadata with the user message.

## Implementation Phases

Phase 1: Backend Workspace API

- Add safe workspace snapshot/raw/write/delete/rename APIs to main AgInTiFlow.
- Add API tests for traversal blocking, internal-path filtering, binary preview metadata, and bounded snapshots.

Phase 2: Persistent Explorer

- Move workspace file visibility from a small capability card into a left explorer.
- Keep existing chat/run UI working.
- Add file click to open preview/editor in a right workbench tab.

Phase 3: Dynamic Right Tabs

- Add a generic tab manager.
- Convert Settings modal into a `Settings` tab with vertical subtabs.
- Convert Artifact modal into closable artifact tabs.

Phase 4: Generalized Automap

- Add workspace lane classifier.
- Add auto map, reset map, and manual drag/drop overrides.
- Persist overrides in project storage such as `.aginti/workspace-map.json` or the project session database.

Phase 5: Artifact Links

- Add project-visible artifact pointers/symlinks.
- Show artifact roots in explorer.
- Add repair/report UI for broken links.

Phase 6: Domain Profiles

- Add lane overlays for paper, coding, data, AAPS, and writing.
- Keep the paper UI behavior as a profile, not a separate product path.

Phase 7: TDV

- Playwright: explorer renders, path browsing works, file opens in tab, settings opens as tab, artifact opens as tab, drag/drop persists.
- API: snapshot, raw, write, delete, rename, symlink safety, large file streaming.
- Regression: existing web UI, web API, canvas, settings, CLI/web parity, SCS/routing, MCP.

## Acceptance Criteria

The integration is not done until:

- A normal user can open AgInTiFlow and immediately see the active workspace files.
- Clicking a file opens the correct preview/editor.
- Images and PDFs render without cropping or artifact-path confusion.
- Chat clearly shows whether it targets the whole workspace, selected file, selected lane, or selected artifact.
- Settings no longer require a large modal for routine work.
- Artifact previews are available as persistent tabs.
- Automap is reversible and never hides user files silently.
- Project/session artifact storage is understandable from both web UI and filesystem.
- Existing main AgInTiFlow workflows still work.

## Immediate Next Step

Implement the backend workspace API slice first, then add the left explorer behind the existing web UI. Do not start by copying the whole `paper-ui` folder into main AgInTiFlow because that would preserve paper-specific assumptions and create duplicate UI state.
