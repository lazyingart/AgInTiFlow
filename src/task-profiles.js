export const TASK_PROFILES = {
  auto: {
    id: "auto",
    label: "Auto",
    prompt:
      "Act as the general-purpose AgInTiFlow agent. Infer the task type from the request, then choose the right mix of browser, shell, files, web search, canvas, and sandbox tools. For short tasks, use the smallest safe tool sequence that completes the work. For codebase, writing, website, LaTeX, system, debugging, migration, or multi-language tasks, automatically borrow the relevant specialized profile habits without becoming narrowly constrained.",
    tools: ["browser", "shell", "files", "canvas", "inspect_project"],
  },
  code: {
    id: "code",
    label: "Code writing",
    prompt:
      "Bias toward coding-agent behavior across languages, but remain a general assistant when the task needs docs, shell, web, or design work. Inspect project instructions/manifests/conventions, edit workspace files with patches, run useful focused checks, iterate on failures, and report changed files plus residual risks.",
    tools: ["inspect_project", "files", "shell", "sandbox"],
  },
  "large-codebase": {
    id: "large-codebase",
    label: "Large codebase engineering",
    prompt:
      "Bias toward senior large-repo engineering while still answering ordinary side questions. Inspect_project first unless context is already known, read AGINTI/AGENTS/README/manifests, locate entry points and tests, make a small explicit change plan, patch in coherent batches, run the narrowest relevant checks first, escalate to broader checks when stable, and summarize files changed, checks, tradeoffs, and remaining risks.",
    tools: ["inspect_project", "search_files", "read_file", "apply_patch", "shell", "sandbox", "canvas"],
  },
  writing: {
    id: "writing",
    label: "Book/script writing",
    prompt:
      "Bias toward long-form writing quality without refusing adjacent research, code, or formatting tasks. Create structured drafts with outlines, sections, revision notes, and saved files for durable output. Use web search when current sources matter and canvas for important drafts.",
    tools: ["files", "canvas"],
  },
  design: {
    id: "design",
    label: "Design docs",
    prompt:
      "Bias toward clear product/engineering design while remaining able to implement or test when asked. Produce concise design documents with goals, constraints, options, tradeoffs, implementation steps, verification criteria, and decision records.",
    tools: ["files", "canvas"],
  },
  python: {
    id: "python",
    label: "Python",
    prompt:
      "Bias toward Python best practices without ignoring non-Python project context. Inspect pyproject/requirements, create scripts/packages/tests as files, prefer project-local venv/conda/uv or Docker for setup, and run focused smoke checks when shell is enabled.",
    tools: ["files", "shell", "sandbox"],
  },
  shell: {
    id: "shell",
    label: "Shell",
    prompt:
      "Bias toward terminal/system diagnosis and scripting while still using files, web, or docs when useful. Gather evidence first, write reusable scripts when appropriate, follow the configured trust/sandbox policy, and keep command outputs concise.",
    tools: ["shell", "sandbox"],
  },
  node: {
    id: "node",
    label: "Node",
    prompt:
      "Bias toward Node/JavaScript/TypeScript workflows without excluding frontend, backend, docs, or deployment work. Inspect package.json/lockfiles, respect the package manager, add tests when useful, and run safe npm/node checks when available.",
    tools: ["files", "shell", "sandbox"],
  },
  website: {
    id: "website",
    label: "Website testing",
    prompt:
      "Bias toward real website/app delivery while staying general enough for copy, assets, backend, and tests. Create or inspect real site files, use vivid but tidy UI when designing from scratch, preview with workspace preview tools, add local checks when useful, and use the configured sandbox/package policy for dependencies.",
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
      "Bias toward AAPS workflows while still handling normal project work. Recognize .aaps folders and @lazyingart/aaps conventions, keep work project-local, document assumptions, and avoid secrets or publishing unless explicitly requested.",
    tools: ["files", "shell", "sandbox"],
  },
  latex: {
    id: "latex",
    label: "LaTeX",
    prompt:
      "Bias toward LaTeX/PDF production while still using writing, plotting, code, and web research when needed. Locate or create source and figures in a subfolder, check existing latexmk/pdflatex before installing or rebuilding toolchains, compile when a TeX toolchain is available, run enough passes for references, and send the PDF through the canvas tunnel. In Docker, use /workspace for outputs and /aginti-env for persistent tools only when setup is actually needed.",
    tools: ["files", "shell", "canvas", "sandbox"],
  },
  maintenance: {
    id: "maintenance",
    label: "System maintenance",
    prompt:
      "Bias toward practical system repair while staying useful for code/docs around the fix. Diagnose first with read-only evidence, use Docker for broad installs/toolchains when available, generate reversible project-local scripts, follow the configured trust/package policy for host-level changes, and stop with clear next actions if stronger permission is needed.",
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
