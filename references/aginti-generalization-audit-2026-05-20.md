# AgInTiFlow Generalization Audit

Date: 2026-05-20

## Scope

This audit checks whether the core AgInTiFlow runtime learned a general problem-solving capability, or whether it accidentally hard-coded a project-specific browser workflow.

Reviewed areas:

- SCS controller and evidence gates
- Engineering guidance and dynamic step budget
- Built-in skills and project-local skill loading
- Smoke tests that protect browser workflows, upload contracts, and SCS validation

## Findings

AgInTiFlow core should stay task-independent. It may know that browser work often needs page-state reconciliation, scoped selectors, attachment verification, model/duration verification, submit evidence, and external blocker handling. It should not know a private platform name, a private repository name, a private character set, a fixed prompt, or fixed asset filenames.

The useful general capability is:

- derive a task contract from the user's request
- preserve exact input paths and forbidden actions
- reject plans that invent unrequested uploads or skipped UI actions
- require concrete browser, visual, filesystem, or command evidence before finish
- route failed finish claims back to a validator/replan loop
- load narrow project-local skills from `.aginti/skills/<skill-id>/SKILL.md`

## Remediation

Project-specific browser/video terms were removed from core heuristics and smoke fixtures. Generic Chinese and English browser workflow terms remain because they apply across websites.

Kept in core:

- generic browser composer guidance
- generic upload/asset-library/reference-media verification
- generic model, mode, duration, and submit-state verification
- generic external blocker handling such as login, captcha, credits, permission, server error, or user confirmation
- project-local skill loading and skill-creation workflow

Moved out of core:

- private platform names
- private repository names
- private asset filenames
- private character names
- task-specific model branding examples

## Design Rule

If a future task requires special UI labels, account behavior, reference media, or platform-specific workarounds, create or update a project-local skill. Only promote a rule into AgInTiFlow core when the rule applies to a broad class of tasks such as browser form submission, book generation, LaTeX compilation, translation, testing, or deployment.

## Verification

Commands run:

```bash
npm run check
npm run smoke:model-roles
node scripts/smoke-skills.js
node scripts/smoke-dynamic-step-budget.js
node scripts/smoke-coding-tools.js
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' --glob '!dist/**' --glob '!coverage/**' 'xiaoyunque|小云雀|xyq|jianying|LALACHAN|啦啦|拉拉|阿芽|飒飒|Seedance|沉浸式短片|Trio\.png|display\.png|R1\.jpg|patchwork-leather|duanpian' .
```

Result: checks passed, and the repository search found no remaining private workflow terms in AgInTiFlow runtime code, tests, or general references after excluding this audit's own search expression.
