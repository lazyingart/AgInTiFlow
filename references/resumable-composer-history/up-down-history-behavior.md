# Up/Down Input History Behavior Learned From Codex

This note documents the desired AgInTiFlow CLI behavior for resumed input history, based on the local Codex TUI implementation.

## Problem

When an AgInTiFlow session is resumed, the transcript is printed, but the prompt editor cannot use Up/Down to recall the previous user messages from that resumed session.

The old AgInTiFlow behavior was caused by two separate facts:

- `src/interactive-cli.js` keeps `promptHistory` as an in-memory array for the current CLI process.
- `printResumeHistory()` reads and prints saved chat entries, but does not seed `promptHistory` with the resumed session's prior user messages.

So the user sees prior prompts in the transcript, but the composer history does not know about them.

## Desired UX Contract

The prompt editor should behave like a shell or Codex-style composer:

- If the input field is empty, Up recalls previous user messages.
- While the recalled entry remains unedited, repeated Up/Down moves through history entries.
- Down past the newest history entry restores the draft that existed before browsing, usually empty.
- If the user performs any normal edit or cursor/navigation operation other than Up/Down, history browsing is no longer active.
- After such an edit or movement, Up/Down should move inside the current multiline input like a code textarea, not replace it with another history entry.
- Explicit edit/navigation operations that should exit history-browse mode include character input, Backspace, Delete, Left, Right, Ctrl+A, Ctrl+E, Home, End, Ctrl+U, Ctrl+K, paste, Tab completion acceptance, and any future textarea mutation.
- Up/Down should still be normal vertical movement inside multiline text when the cursor is not at a history-recall boundary.

This is important for recalled code blocks. A recalled multiline prompt should not be destroyed by pressing Up while the user is trying to move within the code.

## What Codex Does

The relevant local Codex files are:

- `/home/lachlan/ProjectsLFS/Agent/codex/codex-rs/tui/src/bottom_pane/chat_composer_history.rs`
- `/home/lachlan/ProjectsLFS/Agent/codex/codex-rs/tui/src/bottom_pane/chat_composer.rs`
- `/home/lachlan/ProjectsLFS/Agent/codex/codex-rs/tui/src/bottom_pane/textarea.rs`
- `/home/lachlan/ProjectsLFS/Agent/codex/codex-rs/core/src/message_history.rs`
- `/home/lachlan/ProjectsLFS/Agent/codex/codex-rs/tui/src/app/thread_routing.rs`

Codex separates three concepts:

- Transcript history: rendered conversation and events.
- Persistent message history: append-only prompt recall store.
- Composer draft state: current editable input buffer, cursor, attachments, pastes, and history navigation cursor.

The important behavior lives in `ChatComposerHistory::should_handle_navigation()`.

Codex only treats Up/Down as history navigation when:

- there is history available;
- the current input is empty, or the current input exactly equals the last recalled history entry;
- and the cursor is at the allowed boundary, not in the middle of editable text.

If those checks fail, Codex routes Up/Down to the textarea's normal cursor movement.

Codex also tracks:

- `history_cursor`: which history offset is currently selected, or `None` when not browsing.
- `last_history_text`: exact text last inserted by history recall.
- `local_history`: prompts submitted during the current UI process, with rich draft metadata.
- persistent history metadata and lazy lookup for cross-session entries.
- a `draft` equivalent at the composer layer so Down past newest can restore what the user was typing before browsing.

The design principle is simple: history recall is a mode, not just a keybinding.

## Previous AgInTiFlow Behavior

Previous AgInTiFlow code path:

- `promptHistory` is declared in `src/interactive-cli.js`.
- `readTtyPrompt()` owns `buffer`, `cursor`, `preferredColumn`, `historyIndex`, and `draft`.
- `moveVertical(-1)` recalls history only when the cursor tries to move above the top rendered row.
- `moveVertical(1)` moves down through history or restores `draft` when moving below the bottom rendered row.
- On submit, non-empty prompts are appended to `promptHistory`.

This is good enough for one live CLI process, but it has two gaps:

- Resume history is not loaded into `promptHistory`.
- History browsing is not explicitly invalidated by all non-Up/Down edits and cursor movement, so the code relies mostly on rendered row boundaries rather than an explicit `lastHistoryText` gate.

## Implemented AgInTiFlow Design

AgInTiFlow now uses a small composer-history state machine instead of spreading the logic across `readTtyPrompt()`.

Implemented shape:

```js
class ComposerHistory {
  constructor(entries = []) {
    this.entries = dedupeAdjacent(entries.filter(Boolean));
    this.cursor = null;
    this.draft = "";
    this.lastRecalledText = null;
  }

  seed(entries) {}
  recordSubmission(text) {}
  resetBrowsing() {}
  shouldNavigate(buffer, direction) {}
  navigateUp(buffer) {}
  navigateDown() {}
}
```

### Seed On Resume

When a session is resumed, load prior user messages from canonical session state:

```js
const chat = Array.isArray(saved?.chat) ? saved.chat : [];
const resumedUserPrompts = chat
  .filter((entry) => entry?.role === "user" && entry?.content)
  .map((entry) => String(entry.content));
```

Then seed the prompt-history state before the first prompt is rendered.

Important details:

- Preserve chronological order.
- Ignore empty prompts.
- Collapse adjacent duplicates.
- Track the seeded session id/count so repeated resume-history rendering does not duplicate the same old prompts.
- Do not add assistant messages.
- Do not add tool output or system state rows.
- Keep this per-session unless a future global history is deliberately added.

### Navigation Gate

The implemented gate follows the user-facing behavior requested for AgInTiFlow:

```js
function shouldNavigateHistory({ buffer, direction }) {
  if (history.entries.length === 0) return false;
  if (buffer.length === 0) return direction < 0;
  return history.cursor !== null && buffer === history.lastRecalledText;
}
```

This means:

- Empty input + Up recalls the latest prior user prompt.
- Repeated Up/Down keeps browsing as long as the recalled entry is still exactly unedited.
- Any edit or intentional cursor/navigation key exits browsing mode.
- After browsing is exited, Up/Down behave like textarea vertical movement and do not replace the buffer.

### Invalidate On Non-History Input

Any key handler that mutates or intentionally navigates the editor should call:

```js
history.resetBrowsing();
```

This includes:

- Backspace.
- Delete.
- Left.
- Right.
- Ctrl+A.
- Ctrl+E.
- Home.
- End.
- Ctrl+U.
- Ctrl+K.
- Tab completion acceptance.
- Printable character insertion.
- Paste.
- Any future command that modifies `buffer`, `cursor`, suggestions, attachments, or input mode.

Do not reset on repeated Up/Down while history navigation is accepted.

### Down Past Newest Restores Draft

When browsing starts from an existing draft:

```js
if (history.cursor === null) history.draft = buffer;
```

Then Down past the newest entry should return `draft`, not always empty.

This matches shell behavior and prevents losing typed text.

### Submission Recording

On submit:

- canonicalize slash command first;
- record the submitted buffer after canonicalization;
- ignore empty or whitespace-only entries;
- collapse adjacent duplicate entries;
- reset `cursor`, `draft`, and `lastRecalledText`.

## Edge Cases To Test

Use smoke tests around `readTtyPrompt()` helper logic or a new `ComposerHistory` unit module.

Required cases:

- Resume seeds prompt history from prior user messages.
- Empty prompt + Up recalls latest resumed user prompt.
- Repeated Up moves older through resumed prompts.
- Repeated Down moves newer.
- Down past newest restores the original draft.
- Up after recalling, without edits, continues history navigation.
- Up after typing one character moves within textarea or no-ops; it must not replace with older history.
- Up after Backspace exits browsing.
- Up after Delete exits browsing.
- Up after Left/Right exits browsing.
- Up after Ctrl+A/Ctrl+E exits browsing.
- Multiline recalled prompt: Up/Down should move cursor inside text after any edit/navigation.
- Adjacent duplicate user prompts are not duplicated in history.
- Assistant/tool/system transcript entries are not included.
- New submission after resume becomes the latest history entry.

## Implementation Notes For AgInTiFlow

Implemented integration points:

- `src/interactive-cli.js`: raw `promptHistory` operations are replaced with a `ComposerHistory` helper.
- `printResumeHistory()`: seeds prompt recall from resumed session user chat entries.
- `readTtyPrompt()`: resets browsing on each prompt, records submissions, and invalidates browsing on non-Up/Down edits/navigation.
- `scripts/smoke-cli-chat.js`: covers recall, repeated Up/Down, resume seeding, edited-history invalidation, and duplicate filtering.

Avoid coupling history recall to transcript rendering. Transcript printing and input recall should read from the same session data, but they are different UI surfaces.

## Recommended Future Behavior

AgInTiFlow should eventually support two history scopes:

- Session history: default for `aginti resume`; recalls prompts from that session first.
- Global project history: optional fallback after session history is exhausted.

If both exist, the order should be:

1. Current process local prompts.
2. Resumed session user prompts.
3. Optional project/global prompt history.

For now, session history is enough to fix the resumed-message issue.
