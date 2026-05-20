# Codex Session Cross-References

Date: 2026-05-20

Purpose: keep a durable, redacted index of Codex sessions that jointly explain
recent AgInTiFlow design and implementation decisions. This file is for future
supervisors who need to understand why the current SCS evidence gate exists and
which session produced which part of the work.

## Sessions

### LALACHAN Browser And AgInTi Supervision Source Session

- Session: `019dc795-e538-75b2-8a03-bc103b32985d`
- Status context shown by Codex: `~/ProjectsLFS/LALACHAN`
- Primary repo involved: `/home/lachlan/ProjectsLFS/LALACHAN`
- Related AgInTiFlow repo: `/home/lachlan/ProjectsLFS/Agent/AgInTiFlow`
- Role: failure-source and product-requirement session.

This session started from LALACHAN/Xiaoyunque browser video workflows and exposed
a general AgInTiFlow weakness: the executor could claim progress or completion
without enough evidence that the requested browser state, upload state, selected
mode, selected model, prompt, reference media, or generated artifact actually
existed.

Important lesson from this session:

- Do not hard-code Xiaoyunque-specific rules into AgInTiFlow core.
- Keep domain details in project-local skills such as `.aginti/skills/<id>/SKILL.md`.
- Improve the core agent harness instead: task contract, monitor, evidence ledger,
  validator gate, replan loop, and real blocker reporting.

Project-local skill produced from this direction:

- `/home/lachlan/ProjectsLFS/LALACHAN/.aginti/skills/xiaoyunque-video-browser/SKILL.md`

### ZhJpBook And AgInTiFlow Implementation Session

- Session: `019e1f99-289e-7711-986a-d41047f5ed21`
- Status context shown by Codex: `~/ProjectsLFS/ZhJpBook`
- Primary task repo involved: `/home/lachlan/ProjectsLFS/ZhJpBook`
- AgInTiFlow implementation repo: `/home/lachlan/ProjectsLFS/Agent/AgInTiFlow`
- Role: implementation and validation session.

This session used a long bilingual book pipeline to stress AgInTiFlow's ability
to run durable, evidence-based work: source conversion, chunking, DeepSeek JSON
writing, validation, monitoring, PDF compilation, artifact handling, and recovery.
The same core principle from the LALACHAN session was then implemented in
AgInTiFlow.

Relevant AgInTiFlow commits:

- `e37ce98` - Make SCS validation default
- `0a88653` - Keep browser skill generic
- `c0611c2` - Document SCS evidence validator design
- `777b57c` - Add SCS evidence contract gate

Current verified implementation point:

- `777b57c` is `HEAD` and `origin/main` as of 2026-05-20.
- Package version in repo: `0.20.160`.
- NPM publish status from the supervising session: not published in that pass.

## Cross-Session Design Thread

The two sessions should be read together:

- LALACHAN supplies the concrete failure mode: browser automation and media tasks
  can look successful while the visible external state is wrong or unverified.
- ZhJpBook supplies the long-running pipeline pressure: the agent must keep
  moving through scripts, monitors, validators, and artifacts without accepting
  unsupported finish claims.
- AgInTiFlow core response is the SCS evidence gate: derive a task contract,
  collect structured evidence, compare evidence against required categories,
  allow proven blockers, and reject unsupported completion.

## Implementation Anchors

- `src/scs-evidence.js`: task contracts, evidence categories, evidence ledger,
  blocker detection, deterministic finish blocker.
- `src/scs-controller.js`: SCS final gate integration, deterministic override,
  real blocker allowance, evidence-pack construction.
- `src/skill-library.js`: project-local skill loading.
- `skills/skill-creator/SKILL.md`: built-in workflow for creating reusable local
  skills instead of overfitting core runtime.
- `docs/student-committee-supervisor.md`: user-facing SCS behavior.
- `references/scs-evidence-validator-core-design.md`: deeper design note.

## Verification Commands

Use these after any related patch:

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm run check
npm run smoke:model-roles
npm run smoke:web-api
npm run smoke:coding-tools
npm run smoke:cli-chat
npm test
```

## Residual Risks To Test

- Run a live AgInTiFlow browser task where a helper reports `ok=true` but the
  visible page is not updated; confirm SCS rejects finish.
- Run a live long writing or book pipeline with partial artifacts; confirm SCS
  distinguishes real progress, missing evidence, and real external blockers.
- Verify project-local skill loading from a real project root and confirm the
  generic browser skill does not absorb site-specific behavior.
