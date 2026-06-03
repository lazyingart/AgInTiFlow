# LazyEdit Publish Skill Installation

Date: 2026-06-03

## Installed Skill

Skill id:

- `lazyedit-publish-workflow`

Source skill:

- `/home/lachlan/.codex/skills/lazyedit-publish-workflow/SKILL.md`

AgInTiFlow project-local copy:

- `/home/lachlan/ProjectsLFS/Agent/AgInTiFlow/.aginti/skills/lazyedit-publish-workflow/SKILL.md`

Global AgInTiFlow custom copy:

- Skill Mesh storage under `/home/lachlan/.agintiflow/skillmesh/skills/lazyedit-publish-workflow/`
- Installed as a local-reviewed enabled Skill Mesh skill.

## Why Both Copies Exist

The project-local `.aginti/skills/` copy documents the skill in the AgInTiFlow repository and lets local development sessions load it as `source=project-local`.

The Skill Mesh copy makes the same skill available from other working directories such as LALACHAN, RARACHAN, LazyEdit, or Agent without requiring the user to start AgInTiFlow from the AgInTiFlow repo.

## Verification

Project-local loader:

```bash
node -e "import { listSkills, selectSkillsForGoal } from './src/skill-library.js'; const skill=listSkills({projectRoot:process.cwd(), includeBody:true}).find(s=>s.id==='lazyedit-publish-workflow'); if(!skill) throw new Error('missing'); console.log(skill.source);"
```

Expected result:

```text
project-local
```

Global Skill Mesh install:

```bash
node bin/aginti-cli.js skillmesh export lazyedit-publish-workflow --out /tmp/lazyedit-publish-workflow.skillpack.json
node bin/aginti-cli.js skillmesh import /tmp/lazyedit-publish-workflow.skillpack.json --enable
node bin/aginti-cli.js skillmesh status
```

Expected result includes:

```text
enabled  lazyedit-publish-workflow: LazyEdit Publish Workflow
```

Cross-directory discovery:

```bash
cd /home/lachlan/ProjectsLFS/Agent
aginti skills lazyedit

cd /home/lachlan/ProjectsLFS/LALACHAN
node /home/lachlan/ProjectsLFS/Agent/AgInTiFlow/bin/aginti-cli.js skills lazyedit
```

Expected result:

```text
lazyedit-publish-workflow ... source=skillmesh
```

Selection check:

```bash
node -e "import { selectSkillsForGoal } from '/home/lachlan/ProjectsLFS/Agent/AgInTiFlow/src/skill-library.js'; const selected=selectSkillsForGoal('publish latest LALACHAN generated video through LazyEdit to Shipinhao YouTube Instagram with corrected subtitles', {projectRoot:'/home/lachlan/ProjectsLFS/LALACHAN', includeBody:true}).map(s=>s.id); console.log(selected); if(!selected.includes('lazyedit-publish-workflow')) throw new Error('not selected');"
```

Expected result:

- `lazyedit-publish-workflow` appears in the selected skill list.

## Operational Notes

The skill is prompt guidance, not a privileged tool. LazyEdit publishing still runs through normal AgInTiFlow permission policy and shell/tmux safeguards.

The subtitle correction rule is preserved: generated video scripts/stories are reference context for correcting ASR recognition errors, not verbatim targets. The agent should compare ASR output against the script, infer intended wording, preserve timing/line structure, and avoid blindly copying script text when the audio differs.
