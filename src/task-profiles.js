export const TASK_PROFILES = {
  auto: {
    id: "auto",
    label: "Auto",
    prompt:
      "Infer the task type from the user request. Prefer the smallest safe tool sequence, preserve workspace files, and summarize what changed.",
    tools: ["browser", "shell", "files", "canvas"],
  },
  code: {
    id: "code",
    label: "Code writing",
    prompt:
      "Act like a coding agent: understand the request, edit workspace files, run useful safe checks, and report changed files and residual risks.",
    tools: ["files", "shell", "sandbox"],
  },
  writing: {
    id: "writing",
    label: "Book/script writing",
    prompt:
      "Create structured drafts with outlines, sections, and revision notes. Use files for long-form output and canvas for important drafts.",
    tools: ["files", "canvas"],
  },
  design: {
    id: "design",
    label: "Design docs",
    prompt:
      "Produce concise design documents with goals, constraints, options, tradeoffs, implementation steps, and verification criteria.",
    tools: ["files", "canvas"],
  },
  python: {
    id: "python",
    label: "Python",
    prompt:
      "For Python tasks, create small scripts or notebooks as files, prefer virtual environments or Docker for package setup, and run smoke checks when shell is enabled.",
    tools: ["files", "shell", "sandbox"],
  },
  shell: {
    id: "shell",
    label: "Shell",
    prompt:
      "For shell tasks, use allowlisted commands, explain blocked commands, avoid destructive operations, and keep outputs concise.",
    tools: ["shell", "sandbox"],
  },
  node: {
    id: "node",
    label: "Node",
    prompt:
      "For Node.js tasks, use the local project structure, add tests when useful, and run safe npm/node checks when available.",
    tools: ["files", "shell", "sandbox"],
  },
  website: {
    id: "website",
    label: "Website testing",
    prompt:
      "For website-testing tasks, create or inspect the site, add a local check when useful, and use the configured sandbox/package policy for dependencies.",
    tools: ["files", "shell", "canvas", "sandbox"],
  },
  aaps: {
    id: "aaps",
    label: "AAPS",
    prompt:
      "For AAPS tasks, recognize .aaps folders and @lazyingart/aaps workflows, keep work project-local, and avoid secrets or publishing.",
    tools: ["files", "shell", "sandbox"],
  },
  latex: {
    id: "latex",
    label: "LaTeX",
    prompt:
      "For LaTeX/PDF tasks, create source and figures in a subfolder, compile when a TeX toolchain is available, and send the PDF through the canvas tunnel. In Docker, use /workspace for project outputs and the persistent Python/conda/tool cache under /aginti-env when setup is needed.",
    tools: ["files", "shell", "canvas", "sandbox"],
  },
  maintenance: {
    id: "maintenance",
    label: "System maintenance",
    prompt:
      "For system maintenance, diagnose first, use Docker for broad installs when available, and follow the configured trust/package policy for host-level changes.",
    tools: ["shell", "sandbox", "files"],
  },
};

export function listTaskProfiles() {
  return Object.values(TASK_PROFILES);
}

export function normalizeTaskProfile(value = "auto") {
  const key = String(value || "auto").trim().toLowerCase();
  return TASK_PROFILES[key] ? key : "auto";
}

export function getTaskProfile(value = "auto") {
  return TASK_PROFILES[normalizeTaskProfile(value)];
}
