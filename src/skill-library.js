import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_DIR = path.resolve(__dirname, "..", "skills");
const DEFAULT_PROMPT_CHARS = 5200;

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

function parseFrontmatter(text, filePath) {
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

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadSkillFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const { meta, body } = parseFrontmatter(text, filePath);
  for (const field of ["id", "label", "description"]) {
    if (typeof meta[field] !== "string" || !meta[field].trim()) {
      throw new Error(`${filePath}: ${field} must be a non-empty string`);
    }
  }
  return {
    id: meta.id.trim(),
    label: meta.label.trim(),
    description: meta.description.trim(),
    triggers: normalizeList(meta.triggers),
    tools: normalizeList(meta.tools),
    body,
    path: filePath,
  };
}

export function listSkills({ includeBody = false, skillsDir = DEFAULT_SKILLS_DIR } = {}) {
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
      skills.push(skill);
    } catch {
      // Invalid local skill files are skipped so one bad skill does not break the agent.
    }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function scoreSkill(skill, text, taskProfile) {
  let score = 0;
  if (skill.id === taskProfile) score += 10;
  if (skill.triggers.includes(taskProfile)) score += 6;
  for (const trigger of skill.triggers) {
    const needle = trigger.toLowerCase();
    if (needle && text.includes(needle)) score += Math.max(2, Math.min(6, Math.ceil(needle.length / 6)));
  }
  for (const token of skill.description.toLowerCase().split(/[^a-z0-9+#.-]+/).filter((item) => item.length > 3)) {
    if (text.includes(token)) score += 0.25;
  }
  return score;
}

export function selectSkillsForGoal(goal = "", { taskProfile = "auto", limit = 6, includeBody = true } = {}) {
  const text = `${goal} ${taskProfile}`.toLowerCase();
  const skills = listSkills({ includeBody });
  const scored = skills
    .map((skill) => ({ skill, score: scoreSkill(skill, text, taskProfile) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
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
        skill.tools?.length ? `Preferred tools: ${skill.tools.join(", ")}` : "",
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
