export const TASK_PROFILES = {
  auto: {
    id: "auto",
    label: "Auto",
    prompt:
      "Infer the task type from the user request. For short tasks, use the smallest safe tool sequence that completes the work. For codebase, system, debugging, migration, or multi-language tasks, switch into the engineering loop: inspect, read/search exact context, patch incrementally, run focused checks, repair failures, and summarize changed files plus residual risks.",
    tools: ["browser", "shell", "files", "canvas", "inspect_project"],
  },
  code: {
    id: "code",
    label: "Code writing",
    prompt:
      "Act like a coding agent across languages: inspect project manifests and conventions, edit workspace files with patches, run useful focused checks, iterate on failures, and report changed files and residual risks.",
    tools: ["inspect_project", "files", "shell", "sandbox"],
  },
  "large-codebase": {
    id: "large-codebase",
    label: "Large codebase engineering",
    prompt:
      "For large or complicated engineering work, behave like a senior coding agent: inspect_project first unless the repo is already known, read AGENTS/README/manifests, locate entry points and tests, make a small explicit change plan, patch in coherent batches, run the narrowest relevant checks first, escalate to broader checks when stable, and summarize files changed, checks, tradeoffs, and remaining risks.",
    tools: ["inspect_project", "search_files", "read_file", "apply_patch", "shell", "sandbox", "canvas"],
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
      "For website/app tasks, create or inspect real site files, preview with workspace preview tools, add local checks when useful, and use the configured sandbox/package policy for dependencies.",
    tools: ["files", "shell", "canvas", "sandbox"],
  },
  image: {
    id: "image",
    label: "Image generation",
    prompt:
      "For raster image, cover, poster, illustration, photo, and logo-concept tasks, write a clear visual prompt, use generate_image when the optional GRS AI key is available, save outputs under artifacts/images, and send the selected image to the canvas. If the key is missing, ask the user to run /auxilliary grsai or aginti login grsai.",
    tools: ["auxiliary:image_generation", "files", "canvas"],
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
      "For LaTeX/PDF tasks, locate or create source and figures in a subfolder, compile when a TeX toolchain is available, run enough passes for references, and send the PDF through the canvas tunnel. In Docker, use /workspace for project outputs and the persistent Python/conda/tool cache under /aginti-env when setup is needed.",
    tools: ["files", "shell", "canvas", "sandbox"],
  },
  maintenance: {
    id: "maintenance",
    label: "System maintenance",
    prompt:
      "For system maintenance and system bugs, diagnose first with read-only evidence, use Docker for broad installs/toolchains when available, generate reversible project-local scripts, follow the configured trust/package policy for host-level changes, and stop with clear next actions if stronger permission is needed.",
    tools: ["shell", "sandbox", "files", "inspect_project"],
  },
};

const PROFILE_ALIASES = {
  large: "large-codebase",
  codebase: "large-codebase",
  repo: "large-codebase",
  repository: "large-codebase",
  engineering: "large-codebase",
  engineer: "large-codebase",
};

export function listTaskProfiles() {
  return Object.values(TASK_PROFILES);
}

export function normalizeTaskProfile(value = "auto") {
  const key = String(value || "auto").trim().toLowerCase();
  if (PROFILE_ALIASES[key]) return PROFILE_ALIASES[key];
  return TASK_PROFILES[key] ? key : "auto";
}

export function getTaskProfile(value = "auto") {
  return TASK_PROFILES[normalizeTaskProfile(value)];
}

export function defaultMaxStepsForProfile(value = "auto") {
  const profile = normalizeTaskProfile(value);
  if (profile === "large-codebase") return 36;
  if (profile === "latex") return 30;
  return 24;
}
