# LabCanvas Scoped Artifact Completion 098

Date: 2026-09-02

## Scenario

LabCanvas asked AgInTi/DeepSeek for a read-only, source-grounded report about
official WeCom support for receive/reply automation in external customer groups.
The agent completed the research, wrote a 10,680-byte Markdown report and a
valid `agent-result.json`, and LabCanvas registered the artifact. AgInTi then
falsely stopped with `model_did_not_execute` because completion evidence did not
discover the report inside a deeply nested task artifact directory.

## Root Cause

The semantic artifact validator bounded its broad workspace scan at 3,000
candidates and 6,000 directory visits. It ignored the trusted
`AGINTI_EVIDENCE_SCOPE_JSON.artifact_root` while building candidates, so files
near the repository root exhausted the scan before the task-owned report was
visited.

## Runtime Repair

- Resolve and scan the host-declared task artifact root before the broad
  workspace fallback.
- Exhaust the scoped subtree first, including nested report directories.
- Deduplicate scoped and broad candidates without weakening existing symlink,
  depth, ignored-directory, freshness, or semantic-format checks.
- Add a regression with 3,005 unrelated workspace files and a report nested two
  levels below the task artifact root.

Source commits:

- `1fa0d01` - prioritize scoped task artifacts in completion evidence
- `57cf46d` - Release v0.20.321
- `6de9d68` - publish npm releases from version tags

## Acceptance

The original persistent session was resumed without repeating research or
touching WeChat/WeCom transports. DeepSeek first returned two invalid tool
batches; AgInTi rejected both without dispatch and preserved the session. The
normal same-session fallback to `localllm-deep` then:

1. recovered from one incorrect guessed filename without writing anything;
2. read the exact 10,680-byte report and 2,108-byte result manifest;
3. retained their original hashes (`fcc8d3d...` and `f13a9927...`);
4. completed goal revision 4 with no project mutation and no completion-evidence
   rejection.

The retained session ended with `goalStatus=completed` and a terminal
`session.finished` event. This distinguishes provider quality from runtime
correctness: DeepSeek's malformed calls were a provider-level failure; scoped
artifact invisibility was an AgInTi runtime defect and is fixed.

## Verification

- Full local `npm test`: passed.
- Focused nested scoped-artifact regression: passed.
- Trusted-publish CI run `33561958499`: passed.
- npm package: `@lazyingart/agintiflow@0.20.321`.
- Installed CLI: `aginti --version` reports `0.20.321`.
- No report rewrite, source refetch, account login, message send, queue mutation,
  or transport restart occurred during acceptance.

