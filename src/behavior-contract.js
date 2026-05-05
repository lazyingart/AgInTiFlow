export const INSTRUCTION_TEMPLATE_IDS = [
  "minimal",
  "disciplined",
  "coding",
  "research",
  "writing",
  "design",
  "aaps",
  "supervision",
];

const TEMPLATE_DESCRIPTIONS = {
  minimal: "Short project memory for tiny or experimental folders.",
  disciplined: "Default robust agent contract for normal project work.",
  coding: "Coding-focused contract with commands, tests, style, and architecture notes.",
  research: "Research-focused contract with sources, reproducibility, and citation notes.",
  writing: "Writing-focused contract with audience, style, outline, and publication notes.",
  design: "Design-focused contract with visual system, assets, QA, and artifact notes.",
  aaps: "AAPS workflow contract with phase criteria, tools, checks, and artifacts.",
  supervision: "Supervisor/student contract for monitored agent work and evidence gates.",
};

const TEMPLATE_ALIASES = {
  default: "disciplined",
  standard: "disciplined",
  full: "disciplined",
  careful: "disciplined",
  karpathy: "disciplined",
  code: "coding",
  dev: "coding",
  software: "coding",
  paper: "research",
  docs: "writing",
  doc: "writing",
  article: "writing",
  visual: "design",
  ui: "design",
  workflow: "aaps",
  student: "supervision",
  supervise: "supervision",
};

export function normalizeInstructionTemplate(value = "disciplined", fallback = "disciplined") {
  const raw = String(value || "").trim().toLowerCase();
  const normalized = TEMPLATE_ALIASES[raw] || raw;
  if (INSTRUCTION_TEMPLATE_IDS.includes(normalized)) return normalized;
  return INSTRUCTION_TEMPLATE_IDS.includes(fallback) ? fallback : "disciplined";
}

export function listInstructionTemplates() {
  return INSTRUCTION_TEMPLATE_IDS.map((id) => ({
    id,
    description: TEMPLATE_DESCRIPTIONS[id] || "",
  }));
}

export function formatInstructionTemplateList() {
  return listInstructionTemplates()
    .map((item) => `${item.id.padEnd(12)} ${item.description}`)
    .join("\n");
}

export function formatBehaviorContractForPrompt({ mode = "runtime" } = {}) {
  const prefix = mode === "plan" ? "Planning discipline contract:" : "AgInTiFlow discipline contract:";
  return [
    prefix,
    "Surface ambiguity instead of silently guessing when interpretations change scope, safety, or implementation.",
    "Prefer the smallest coherent change that satisfies the request; do not add speculative features or abstractions.",
    "Make surgical edits: no drive-by refactors, unrelated formatting churn, or deletion of code you did not need to touch.",
    "Define or infer concrete success criteria for non-trivial work, then run focused checks or state why checks are unavailable.",
    "Respect the permission contract: if a tool is blocked or returns permissionAdvice, stop and present the exact suggestedCommand/approval path instead of retrying variants or inventing CLI flags.",
    "When destructive cleanup is blocked, lead with inspect-only or dry-run evidence (`git status`, `git clean -nd`, targeted file lists). Do not call delete/reset/clean commands safe unless they are clearly labeled as requiring explicit user approval.",
    "Reports after destructive blocks must not place executable destructive commands (`rm -rf`, `git reset --hard`, `git clean -fd`, `find ... -delete`, broad `git checkout -- .`) inside safe or non-destructive cleanup sections. Omit exact destructive commands or put them only in a separate explicit-approval section.",
    "Protect secrets aggressively: never repeat token/key/password/secret values from prompts, files, tool output, plans, final answers, reports, diffs, or artifacts. Redact the value as [REDACTED] and use dedicated key storage such as `aginti keys set` when credentials are needed.",
    "Keep artifacts durable and discoverable with descriptive non-conflicting names; never overwrite unless the user clearly asked.",
    "When reporting shell, language, runtime, build, or test results, name the actual environment used (host vs Docker, relevant interpreter/tool path/version when it matters). Do not claim compatibility across untested runtimes, hosts, containers, or language versions; state the caveat or run an explicit check.",
    "Do not self-invoke AgInTiFlow with npx/npm exec or nested aginti commands from inside the agent shell; it can resolve stale project packages or create recursive sessions. Use current runtime evidence, project/session files, or ask for a host-side diagnostic instead.",
  ].join(" ");
}

export function scsContractCriteria() {
  return [
    "Assumptions and ambiguities are explicit enough for the phase.",
    "The phase is the smallest coherent step toward the user goal.",
    "The plan avoids speculative features, broad rewrites, and unrelated cleanup.",
    "The phase has concrete success criteria and an evidence/check path.",
    "Permission, secret, destructive-action, and artifact-overwrite risks are called out.",
  ];
}

function lines(...items) {
  return items.join("\n");
}

function baseSections() {
  return lines(
    "# AGINTI.md",
    "",
    "Project instructions for AgInTiFlow agents.",
    "",
    "This file is durable project memory. Edit it directly or ask AgInTiFlow to update it during chat. Keep secrets in `.aginti/.env`, not here.",
    "",
    "## Project Identity",
    "",
    "- Project name:",
    "- What this project does:",
    "- Primary users:",
    "- Main workflows to preserve:",
    "- Explicit non-goals:",
    "",
    "## Current Priorities",
    "",
    "-",
    "",
    "## Agent Operating Contract",
    "",
    "- Inspect before editing: read this file, relevant README/docs, manifests, entry points, tests, and exact files related to the request.",
    "- State assumptions when the request is ambiguous. If multiple interpretations would lead to different implementations, ask or present options before editing.",
    "- Prefer the smallest coherent change that solves the user's actual request.",
    "- Do not add speculative features, abstractions, configurability, rewrites, or broad refactors unless requested.",
    "- Do not change adjacent formatting, comments, naming, or style just because it looks improvable.",
    "- Every changed line should trace to the task or to cleanup caused by the task.",
    "- Match existing project style even if another style is personally preferable.",
    "- If you notice unrelated issues, report them separately rather than editing them.",
    "- When reporting shell, language, runtime, build, or test results, name the actual environment used (host vs Docker, relevant interpreter/tool path/version when it matters). Do not claim compatibility across untested runtimes, hosts, containers, or language versions; state the caveat or run an explicit check.",
    "",
    "## Verification Contract",
    "",
    "For non-trivial work, define success criteria before implementation:",
    "",
    "- Target behavior:",
    "- Files or surfaces likely affected:",
    "- Verification command(s):",
    "- Manual checks, if needed:",
    "",
    "Preferred loop:",
    "",
    "1. Reproduce or inspect the issue.",
    "2. Make the smallest coherent change.",
    "3. Run focused checks.",
    "4. Repair failures caused by the change.",
    "5. Summarize changed files, checks run, and residual risks.",
    "",
    "Do not claim success without a concrete check, unless no check exists and that limitation is stated.",
    "",
    "## Permission And Safety Contract",
    "",
    "- Current project folder writes are allowed when file tools are enabled.",
    "- Do not write outside this project unless the user explicitly asks and the runtime permits it.",
    "- Never print or store secrets in logs, docs, commits, screenshots, or artifacts.",
    "- Do not edit `.git`, `.env`, dependency caches, generated vendor folders, or large binary files unless explicitly requested.",
    "- Destructive actions, host maintenance, sudo, publishing, deployment, and broad cleanup require explicit user intent and the appropriate runtime mode.",
    "- If blocked by policy, stop and suggest the safest rerun command instead of trying command variants.",
    "",
    "## File And Artifact Policy",
    "",
    "- Use descriptive, non-conflicting filenames for generated docs, stories, images, reports, screenshots, and artifacts.",
    "- Avoid generic names such as `output.txt`, `story.txt`, or `result.png` unless the user asked for that exact path.",
    "- Do not overwrite existing files unless the user asked to update, replace, patch, or overwrite them.",
    "- Keep durable outputs in project folders where the user can find them.",
    "",
    "## Commands",
    "",
    "- Install:",
    "- Build:",
    "- Test:",
    "- Lint:",
    "- Typecheck:",
    "- Format:",
    "- Preview/run:",
    "- Deploy/publish:",
    "",
    "## Architecture Notes",
    "",
    "- Main entry points:",
    "- Important directories:",
    "- Generated directories:",
    "- Files agents should avoid:",
    "- External services:",
    "",
    "## Style And Conventions",
    "",
    "- Language/runtime:",
    "- Package manager:",
    "- Formatting style:",
    "- Test framework:",
    "- Error handling style:",
    "- Naming conventions:",
    "",
    "## Definition Of Done",
    "",
    "A task is done when:",
    "",
    "- The requested behavior is implemented or the blocker is clearly reported.",
    "- Relevant checks were run, or missing checks are stated.",
    "- The diff is scoped to the request.",
    "- Generated artifacts are named clearly.",
    "- Git status and residual risks are summarized when relevant."
  );
}

function minimalSections() {
  return lines(
    "# AGINTI.md",
    "",
    "Project instructions for AgInTiFlow agents.",
    "",
    "Keep secrets in `.aginti/.env`, not here.",
    "",
    "## Project",
    "",
    "- Purpose:",
    "- Important commands:",
    "- Files or directories to avoid:",
    "",
    "## Agent Contract",
    "",
    "- Inspect relevant files before editing.",
    "- Prefer small, surgical changes.",
    "- Avoid speculative features and broad refactors.",
    "- Run focused checks when available.",
    "- Use descriptive non-conflicting filenames for generated outputs."
  );
}

function templateAppendix(template) {
  if (template === "coding") {
    return lines(
      "",
      "## Coding Profile Notes",
      "",
      "- Prefer tests or focused repro commands before and after fixes.",
      "- Keep public APIs stable unless the task explicitly changes them.",
      "- Check callers before changing shared functions.",
      "- Record package-manager and test commands as they become known."
    );
  }
  if (template === "research") {
    return lines(
      "",
      "## Research Profile Notes",
      "",
      "- Track sources, dates accessed, datasets, assumptions, and limitations.",
      "- Prefer primary sources and reproducible scripts/notebooks when possible.",
      "- Separate evidence, interpretation, and speculation."
    );
  }
  if (template === "writing") {
    return lines(
      "",
      "## Writing Profile Notes",
      "",
      "- Track audience, tone, outline, publication target, and reference style.",
      "- Preserve the user's voice; do not over-polish into generic AI prose.",
      "- Keep drafts, revisions, and final exports clearly named."
    );
  }
  if (template === "design") {
    return lines(
      "",
      "## Design Profile Notes",
      "",
      "- Define visual direction, audience, assets, constraints, and acceptance screenshots.",
      "- Prefer intentional typography, spacing, color, and motion over generic layouts.",
      "- Save source assets and exported previews with durable names."
    );
  }
  if (template === "aaps") {
    return lines(
      "",
      "## AAPS Profile Notes",
      "",
      "- Treat `.aaps` files as top-down workflow specifications.",
      "- Each phase should list goal, allowed tools, write scope, checks, artifacts, and stop conditions.",
      "- Validate or compile workflows before reporting success."
    );
  }
  if (template === "supervision") {
    return lines(
      "",
      "## Supervision Profile Notes",
      "",
      "- The supervised agent does the actual project work; the supervisor monitors evidence and capability gaps.",
      "- Verify artifacts directly instead of trusting self-reports.",
      "- If the student fails due to missing skill/tool/policy, improve AgInTiFlow and resume the same session."
    );
  }
  return "";
}

export function buildAgintiInstructions(template = "disciplined") {
  const normalized = normalizeInstructionTemplate(template);
  const body = normalized === "minimal" ? minimalSections() : `${baseSections()}${templateAppendix(normalized)}`;
  return `${body}\n`;
}
