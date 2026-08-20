import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agintiflowHome } from "./session-index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_DIR = path.resolve(__dirname, "..", "skills");
const DEFAULT_PROMPT_CHARS = 5200;
const PROJECT_SKILLS_RELATIVE_DIR = path.join(".aginti", "skills");
const EXTERNAL_SKILL_PACKS_ENV = "AGINTIFLOW_SKILL_PACKS";
const SCIENTIFIC_SKILL_PACK_ENV = "AGINTIFLOW_SCIENTIFIC_SKILLS_ROOT";
const AGENT_SKILL_PACKS_ENV = "AGINTIFLOW_AGENT_SKILL_PACKS";
const DISCOVER_AGENT_SKILLS_ENV = "AGINTIFLOW_DISCOVER_AGENT_SKILLS";

function parseScalar(value = "") {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFrontmatter(text, filePath) {
  const match = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`${filePath}: missing YAML frontmatter`);
  const meta = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!scalar) throw new Error(`${filePath}: invalid YAML line: ${line}`);
    const key = scalar[1];
    const value = scalar[2];
    if (value.trim()) {
      meta[key] = parseScalar(value);
      continue;
    }
    const items = [];
    while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
      index += 1;
      items.push(parseScalar(lines[index].replace(/^\s+-\s+/, "")));
    }
    meta[key] = items;
  }
  return {
    meta,
    body: String(text || "").slice(match[0].length).trim(),
  };
}

function parseLooseFrontmatter(text, filePath) {
  const match = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`${filePath}: missing YAML frontmatter`);
  const meta = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\s/.test(line)) continue;
    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!scalar) continue;
    const key = scalar[1];
    const value = scalar[2];
    if (value.trim()) {
      meta[key] = parseScalar(value);
      continue;
    }
    const items = [];
    while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
      index += 1;
      items.push(parseScalar(lines[index].replace(/^\s+-\s+/, "")));
    }
    meta[key] = items;
  }
  return {
    meta,
    body: String(text || "").slice(match[0].length).trim(),
  };
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeExternalTools(value) {
  return normalizeList(value)
    .flatMap((item) => String(item || "").split(/\s+/))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadSkillFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const { meta, body } = parseFrontmatter(text, filePath);
  const id = String(meta.id || meta.name || "").trim();
  if (!id) {
    throw new Error(`${filePath}: id or name must be a non-empty string`);
  }
  const label = String(meta.label || titleCaseSkillId(id)).trim();
  const description = String(meta.description || "").trim();
  if (!description) {
    throw new Error(`${filePath}: description must be a non-empty string`);
  }
  return {
    id,
    label,
    description,
    triggers: normalizeList(meta.triggers),
    tools: normalizeList(meta.tools),
    body,
    path: filePath,
  };
}

function titleCaseSkillId(id = "") {
  return String(id || "")
    .split(/[-_\s/]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function loadExternalAgentSkillFile(filePath, { pack, includeBody = false } = {}) {
  const text = fs.readFileSync(filePath, "utf8");
  const { meta, body } = parseLooseFrontmatter(text, filePath);
  const fallbackId = path.basename(path.dirname(filePath));
  const id = String(meta.id || meta.name || fallbackId).trim();
  const description = String(meta.description || "").trim();
  if (!id || !description) {
    throw new Error(`${filePath}: external skill must define name/id and description`);
  }
  const tools = normalizeExternalTools(meta.tools || meta["allowed-tools"]);
  const triggers = normalizeList(meta.triggers);
  if (!triggers.includes(id)) triggers.push(id);
  const skill = {
    id,
    label: String(meta.label || titleCaseSkillId(id)).trim(),
    description,
    triggers,
    tools,
    path: filePath,
    source: "external-pack",
    category: pack.category,
    pack: {
      id: pack.id,
      label: pack.label,
      root: pack.root,
      skillsDir: pack.skillsDir,
    },
  };
  if (includeBody) skill.body = body;
  return skill;
}

function loadSkillsFromDir({ includeBody = false, skillsDir = DEFAULT_SKILLS_DIR, source = "built-in" } = {}) {
  let dirEntries = [];
  try {
    dirEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    try {
      const skill = loadSkillFile(skillPath);
      if (!includeBody) delete skill.body;
      skill.source = source;
      skills.push(skill);
    } catch {
      // Invalid local skill files are skipped so one bad skill does not break the agent.
    }
  }
  return skills;
}

function splitExternalPackPaths(value = "") {
  return String(value || "")
    .split(new RegExp(`[${escapeRegExp(path.delimiter)},]`))
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandHome(value = "") {
  const text = String(value || "");
  if (text === "~") return process.env.HOME || text;
  if (text.startsWith("~/")) return path.join(process.env.HOME || "", text.slice(2));
  return text;
}

function inferExternalPackCategory(root) {
  const name = path.basename(root).toLowerCase();
  if (name.includes("scientific") || name.includes("science")) return "scientific";
  if (name.includes("bio") || name.includes("lab")) return "scientific";
  return "external";
}

function inferExternalPackLabel(root) {
  return titleCaseSkillId(path.basename(root).replace(/-skills?$/i, ""));
}

function inferExternalSkillsDir(root) {
  const candidates = [
    path.join(root, "scientific-skills"),
    path.join(root, "skills"),
    root,
  ];
  for (const candidate of candidates) {
    try {
      const entries = fs.readdirSync(candidate, { withFileTypes: true });
      if (entries.some((entry) => entry.isDirectory() && fs.existsSync(path.join(candidate, entry.name, "SKILL.md")))) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return "";
}

function defaultScientificSkillPackRoots() {
  return [
    process.env[SCIENTIFIC_SKILL_PACK_ENV],
    path.resolve(__dirname, "..", "..", "scientific-agent-skills"),
    path.join(agintiflowHome(), "skillpacks", "scientific-agent-skills"),
  ].filter(Boolean);
}

function envFlag(value, fallback = true) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

function defaultAgentSkillPackRoots() {
  if (!envFlag(process.env[DISCOVER_AGENT_SKILLS_ENV], true)) return [];
  const configured = splitExternalPackPaths(process.env[AGENT_SKILL_PACKS_ENV]);
  if (configured.length > 0) return configured;
  const home = os.homedir();
  return [
    path.join(home, ".agents", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".claude", "skills"),
  ];
}

function inferExternalPackId(root) {
  const basename = path.basename(root);
  const parent = path.basename(path.dirname(root)).replace(/^\./, "");
  if (basename.toLowerCase() === "skills" && parent) return `${parent}-skills`;
  return basename;
}

export function listExternalSkillPacks() {
  const roots = [
    ...splitExternalPackPaths(process.env[EXTERNAL_SKILL_PACKS_ENV]),
    ...defaultScientificSkillPackRoots(),
    ...defaultAgentSkillPackRoots(),
  ];
  const seen = new Set();
  const packs = [];
  for (const rawRoot of roots) {
    const root = path.resolve(expandHome(rawRoot));
    if (seen.has(root)) continue;
    seen.add(root);
    const skillsDir = inferExternalSkillsDir(root);
    if (!skillsDir) continue;
    const category = inferExternalPackCategory(root);
    const basename = inferExternalPackId(root);
    packs.push({
      id: basename,
      label:
        basename === "scientific-agent-skills"
          ? "Scientific Agent Skills"
          : basename.endsWith("-skills")
            ? titleCaseSkillId(basename)
            : inferExternalPackLabel(root),
      category,
      root,
      skillsDir,
    });
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id));
}

function loadExternalSkillPackSkills({ includeBody = false } = {}) {
  const skills = [];
  for (const pack of listExternalSkillPacks()) {
    let dirEntries = [];
    try {
      dirEntries = fs.readdirSync(pack.skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(pack.skillsDir, entry.name, "SKILL.md");
      try {
        skills.push(loadExternalAgentSkillFile(skillPath, { pack, includeBody }));
      } catch {
        // External packs are optional and may contain skills using a different dialect.
      }
    }
  }
  return skills;
}

function skillMeshSkillsDir() {
  return path.join(agintiflowHome(), "skillmesh", "skills");
}

function projectLocalSkillsDir(projectRoot = process.cwd()) {
  return path.join(path.resolve(projectRoot || process.cwd()), PROJECT_SKILLS_RELATIVE_DIR);
}

function skillMeshEnabled() {
  try {
    const configPath = path.join(agintiflowHome(), "skillmesh", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return String(config.mode || "share") !== "off";
  } catch {
    return true;
  }
}

function loadEnabledSkillMeshSkills({ includeBody = false } = {}) {
  if (!skillMeshEnabled()) return [];
  const skillsDir = skillMeshSkillsDir();
  let dirEntries = [];
  try {
    dirEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(skillsDir, entry.name);
    const metadataPath = path.join(skillDir, "skillmesh.json");
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (!metadata.enabled) continue;
      const skill = loadSkillFile(path.join(skillDir, "SKILL.md"));
      if (!includeBody) delete skill.body;
      skill.source = "skillmesh";
      skill.skillmesh = {
        trustLevel: metadata.trustLevel || "community-reviewed",
        packHash: metadata.packHash || "",
        sourceFeed: metadata.sourceFeed || "",
      };
      skills.push(skill);
    } catch {
      // Invalid or unreviewed imported skills stay inert.
    }
  }
  return skills;
}

function appendUniqueSkills(skills, incoming) {
  const existing = new Set(skills.map((skill) => skill.id));
  for (const skill of incoming) {
    if (existing.has(skill.id)) continue;
    existing.add(skill.id);
    skills.push(skill);
  }
}

export function listSkills({
  includeBody = false,
  skillsDir = DEFAULT_SKILLS_DIR,
  includeSkillMesh = true,
  includeProjectLocal = true,
  includeExternalSkillPacks = true,
  projectRoot = process.cwd(),
} = {}) {
  const defaultDir = path.resolve(skillsDir) === DEFAULT_SKILLS_DIR;
  const skills = loadSkillsFromDir({ includeBody, skillsDir, source: defaultDir ? "built-in" : "local" });
  if (includeProjectLocal && defaultDir) {
    appendUniqueSkills(
      skills,
      loadSkillsFromDir({
        includeBody,
        skillsDir: projectLocalSkillsDir(projectRoot),
        source: "project-local",
      })
    );
  }
  if (includeSkillMesh && defaultDir) {
    const existing = new Set(skills.map((skill) => skill.id));
    for (const skill of loadEnabledSkillMeshSkills({ includeBody })) {
      if (!existing.has(skill.id)) {
        existing.add(skill.id);
        skills.push(skill);
      }
    }
  }
  if (includeExternalSkillPacks && defaultDir) {
    appendUniqueSkills(skills, loadExternalSkillPackSkills({ includeBody }));
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

const DESCRIPTION_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "before",
  "content",
  "create",
  "exact",
  "file",
  "files",
  "from",
  "general",
  "into",
  "output",
  "path",
  "paths",
  "project",
  "read",
  "report",
  "request",
  "task",
  "that",
  "their",
  "this",
  "tool",
  "tools",
  "user",
  "when",
  "with",
  "work",
  "write",
]);

const SKILL_ID_STOP_WORDS = new Set([
  "agent",
  "aginti",
  "development",
  "production",
  "skill",
  "system",
  "tool",
  "tools",
  "workflow",
]);

function descriptionTerms(value = "") {
  return [
    ...new Set(
      String(value)
        .toLowerCase()
        .split(/[^a-z0-9+#.-]+/)
        .filter((item) => item.length > 3 && !DESCRIPTION_STOP_WORDS.has(item))
    ),
  ];
}

function scoreSkill(skill, text, taskProfile) {
  let score = 0;
  if (skill.id === taskProfile) score += 10;
  if (skill.triggers.includes(taskProfile)) score += 6;
  const idTerms = String(skill.id || "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((term) => term.length >= 3 && !SKILL_ID_STOP_WORDS.has(term));
  for (const term of idTerms) {
    if (textHasTrigger(text, term)) score += 2;
  }
  for (const trigger of skill.triggers) {
    const needle = trigger.toLowerCase();
    if (!needle) continue;
    if (textHasTrigger(text, needle)) {
      score += Math.max(2, Math.min(6, Math.ceil(needle.length / 6)));
      continue;
    }
    const triggerTerms = descriptionTerms(needle);
    if (triggerTerms.length >= 2 && triggerTerms.every((term) => textHasTrigger(text, term))) {
      score += Math.max(2, Math.min(4, triggerTerms.length));
    }
  }
  const descriptionMatches = descriptionTerms(skill.description).filter((token) => textHasTrigger(text, token));
  if (descriptionMatches.length >= 3) {
    score += Math.min(3, descriptionMatches.length * 0.35);
  }
  return score;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textHasTrigger(text, needle) {
  if (!needle) return false;
  if (/^[a-z0-9]+(?:[\s_-]+[a-z0-9]+)*$/.test(needle)) {
    const parts = needle.split(/[\s_-]+/).filter(Boolean).map(escapeRegExp);
    if (parts.length === 0) return false;
    return new RegExp(`(^|[^a-z0-9])${parts.join("[^a-z0-9]+")}([^a-z0-9]|$)`).test(text);
  }
  return text.includes(needle);
}

export function selectSkillsForGoal(goal = "", { taskProfile = "auto", limit = 6, includeBody = true, projectRoot = process.cwd() } = {}) {
  const text = `${goal} ${taskProfile}`.toLowerCase();
  const skills = listSkills({ includeBody, projectRoot });
  const ranked = skills
    .map((skill) => ({ skill, score: scoreSkill(skill, text, taskProfile) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  const explicitProfile = Boolean(taskProfile && taskProfile !== "auto");
  const bestScore = ranked[0]?.score || 0;
  const relevanceFloor = explicitProfile && bestScore >= 6 ? Math.max(2, bestScore * 0.5) : 0;
  const scored = ranked
    .filter((item) => item.score >= relevanceFloor)
    .map((item) => item.skill);
  return scored.slice(0, Math.max(1, limit));
}

function compactBody(body = "", limit = 620) {
  const text = String(body || "")
    .replace(/^# .+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 20).trim()}\n...`;
}

function bodyHeadings(body = "", limit = 10) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,4}\s+(.+?)\s*$/)?.[1]?.trim() || "")
    .filter(Boolean)
    .slice(0, limit);
}

function skillSourceHint(skill) {
  if (!skill?.path) return "";
  return `Full guidance: ${skill.path} (read-only; inspect this file before executing a multi-stage or irreversible routine).`;
}

export function formatSkillsForPrompt(skills = [], { maxChars = DEFAULT_PROMPT_CHARS } = {}) {
  if (!Array.isArray(skills) || skills.length === 0) return "";
  const chunks = [
    "Selected AgInTiFlow skills. A skill is Markdown guidance for when and how to use tools; it is not itself a tool. Follow relevant skill guidance without becoming constrained by it.",
  ];
  for (const skill of skills) {
    chunks.push(
      [
        `## ${skill.id}: ${skill.label}`,
        `Description: ${skill.description}`,
        skill.pack ? `Source pack: ${skill.pack.label} (${skill.category || "external"})` : "",
        skill.tools?.length ? `Preferred tools: ${skill.tools.join(", ")}` : "",
        skillSourceHint(skill),
        bodyHeadings(skill.body).length ? `Sections: ${bodyHeadings(skill.body).join("; ")}` : "",
        skill.body ? compactBody(skill.body) : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  const output = chunks.join("\n\n");
  if (output.length <= maxChars) return output;
  return `${output.slice(0, Math.max(maxChars - 80, 1)).trim()}\n... [skills truncated]`;
}
