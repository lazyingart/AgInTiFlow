export function browserStateReconciliationGuidance() {
  return [
    "Browser state reconciliation: when the user asks you to control an existing web UI, work toward the requested final state instead of stopping at the first unknown value. Inspect the current page, identify missing or uncertain controls, set them through the smallest scoped UI action, wait, and verify the resulting state before moving on.",
    "For browser/CDP/Chrome helper scripts, prefer existing project helpers and precise selectors scoped to the active composer, toolbar, dialog, or asset picker. Avoid broad text clicks across the whole document; if output contains whole-page text, history, navigation, or unrelated cards, treat the action as wrong and switch to scoped JS, coordinates from a screenshot, or a more specific selector.",
    "Unknown is not a blocker by itself. Stop only after you have tried a bounded state-setting path or when the user explicitly requested inspection-only. If the user asked for a target mode/model/duration/upload/submission, missing evidence should lead to setting that control, then verifying it.",
    "Before externally visible actions such as submit, publish, purchase, or account changes, verify the required state from UI evidence: visible labels, selected tags, enabled submit button, attached asset chips/previews, dialog confirmation text, or a screenshot/perception artifact. Do not rely on ad banners as selected-model evidence.",
    "Do not open new tabs or switch to history/sidebar/home pages unless the current composer cannot be reached and the user allowed navigation. Reuse logged-in tabs and preserve user-controlled browser state when possible.",
  ].join(" ");
}
