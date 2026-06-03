# Paper Revision Skill Installation

Date: 2026-06-03

Source repository:

- `/home/lachlan/ProjectsLFS/paper-revision-skill`
- `https://github.com/lachlanchen/paper-revision-skill`

Purpose:

- Add plan-gated academic manuscript revision as a reusable skill.
- Keep manuscript-specific revision policy in the skill, not in AgInTiFlow core.
- Let Codex, AgInTiFlow, Claude, Gemini, and Copilot consume the same workflow guidance with tool-specific entry files.

AgInTiFlow integration:

- The repository's root `SKILL.md` is Codex-style and uses `name:` plus `description:`.
- AgInTiFlow SkillMesh now accepts that dialect by normalizing `name:` to native `id:` and deriving `label:` when missing.
- Install the root `SKILL.md` as a reviewed local SkillMesh skill and enable it.

Suggested install command from the AgInTiFlow repository:

```bash
node --input-type=module - <<'NODE'
import fs from "node:fs/promises";
import {
  buildSkillPackFromMarkdown,
  enableSkillMeshSkill,
  installSkillPack,
} from "./src/skillmesh.js";

const content = await fs.readFile("/home/lachlan/ProjectsLFS/paper-revision-skill/SKILL.md", "utf8");
const pack = await buildSkillPackFromMarkdown(content, { valueScore: 95 });
await installSkillPack(pack, { enabled: true });
await enableSkillMeshSkill("paper-revision-skill", true);
console.log(JSON.stringify({ ok: true, installedSkills: pack.skills.map((skill) => skill.id), packHash: pack.packHash }, null, 2));
NODE
```

Validation:

```bash
node scripts/smoke-skillmesh.js
node --input-type=module - <<'NODE'
import { selectSkillsForGoal } from "./src/skill-library.js";
const selected = selectSkillsForGoal(
  "Use the paper revision workflow to answer reviewer comments before editing LaTeX.",
  { limit: 8, includeBody: false }
);
console.log(JSON.stringify(selected.map((skill) => ({ id: skill.id, source: skill.source })), null, 2));
if (!selected.some((skill) => skill.id === "paper-revision-skill")) {
  throw new Error("paper-revision-skill was not selected");
}
NODE
```

Boundary:

- Do not move manuscript-revision details into AgInTiFlow core.
- Improve AgInTiFlow core only when the issue is general skill compatibility, skill discovery, SkillMesh validation, evidence tracking, PDF/build tooling, or tool invocation reliability.
- Keep the skill's plan-first, edit-second, PDF-verified revision workflow in the skill repository.
