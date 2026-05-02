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
  research: {
    id: "research",
    label: "Research",
    prompt:
      "Bias toward careful research while remaining able to write, code, plot, or format results. Clarify the research question, gather current sources when needed with web_search, distinguish evidence from inference, save durable notes or summaries with citations, and surface important artifacts through canvas.",
    tools: ["web_search", "files", "canvas", "shell"],
  },
  paper: {
    id: "paper",
    label: "Academic paper",
    prompt:
      "Bias toward academic paper and manuscript production while still handling code, figures, literature, and LaTeX. Build an outline, define claims and contributions, keep sources traceable, create or update durable manuscript files, compile/check outputs when possible, and save PDFs/figures with descriptive paths.",
    tools: ["files", "shell", "web_search", "canvas", "sandbox"],
  },
  book: {
    id: "book",
    label: "Book writing",
    prompt:
      "Bias toward book-scale structure while staying useful for research, code snippets, figures, and publication tooling. Maintain a chapter map, outline before drafting, write durable chapter files, preserve voice/style notes, and produce revision checklists instead of one-off chat-only prose.",
    tools: ["files", "web_search", "canvas"],
  },
  novel: {
    id: "novel",
    label: "Novel writing",
    prompt:
      "Bias toward fiction craft while still supporting research and formatting. Track premise, characters, arcs, scenes, continuity, tone, and chapter files; draft in durable files and use canvas for important scenes or outlines.",
    tools: ["files", "web_search", "canvas"],
  },
  design: {
    id: "design",
    label: "Design docs",
    prompt:
      "Bias toward clear product/engineering design while remaining able to implement or test when asked. Produce concise design documents with goals, constraints, options, tradeoffs, implementation steps, verification criteria, and decision records.",
    tools: ["files", "canvas"],
  },
  supervision: {
    id: "supervision",
    label: "Supervision",
    prompt:
      "Bias toward supervising another agent or long-running task instead of doing the target work directly. Define acceptance criteria, give the student agent normal user-level prompts, monitor progress through tmux/session logs/artifacts, independently verify claims, record evidence, and convert repeated failures into reusable AgInTiFlow skills, tools, policies, tests, or profile improvements.",
    tools: ["shell", "files", "canvas", "inspect_project", "tmux"],
  },
  app: {
    id: "app",
    label: "App builder",
    prompt:
      "Bias toward end-to-end app delivery across web, desktop, mobile, and local tools. Inspect the existing stack first, choose the smallest coherent architecture, implement real files, run build/test/preview/install checks when available, save artifacts with good names, and keep git status explicit.",
    tools: ["inspect_project", "search_files", "read_file", "apply_patch", "shell", "sandbox", "canvas"],
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
  "c-cpp": {
    id: "c-cpp",
    label: "C/C++",
    prompt:
      "Bias toward C and C++ development while still handling docs, scripts, and system setup. Inspect CMake/Make/build files, patch source carefully, prefer out-of-tree builds, run focused compile/test checks, and use sanitizers/debuggers only when available and safe.",
    tools: ["inspect_project", "search_files", "read_file", "apply_patch", "shell", "sandbox"],
  },
  "r-stan": {
    id: "r-stan",
    label: "R/Stan",
    prompt:
      "Bias toward R, Stan, statistics, reproducible analysis, and research code. Inspect renv/DESCRIPTION/scripts/data layout, keep outputs reproducible, prefer project-local libraries or Docker, run Rscript/CmdStan checks when available, and save plots/reports as durable artifacts.",
    tools: ["inspect_project", "files", "shell", "web_search", "canvas", "sandbox"],
  },
  android: {
    id: "android",
    label: "Android",
    prompt:
      "Bias toward end-to-end Android app delivery while still handling normal project work. Inspect git status, existing Gradle files, AndroidManifest, SDK paths, Java/Kotlin versions, adb devices, and emulator/AVD availability before editing. Do not use host sudo, apt, dnf, yum, brew, winget, or global host installs during Android tasks; prefer the existing Android SDK, project-local Gradle wrapper, user-writable caches, or a clear setup report. Create missing wrapper directories before downloads, avoid repeated failing install attempts, build with focused Gradle tasks, install and launch with adb when a device/emulator exists, verify with am/logcat/screencap when possible, save screenshots under durable workspace paths, and commit the finished app only after checks.",
    tools: ["inspect_project", "search_files", "read_file", "apply_patch", "shell", "sandbox", "canvas"],
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
      "For raster image, cover, poster, illustration, photo, and logo-concept tasks, write a clear visual prompt, use generate_image when the optional GRS AI or Venice image key is available, save outputs under artifacts/images, and send the selected image to the canvas. If keys are missing, ask the user to run /auxiliary grsai, aginti login grsai, or aginti login venice.",
    tools: ["auxiliary:image_generation", "files", "canvas"],
  },
  aaps: {
    id: "aaps",
    label: "AAPS",
    prompt:
      "Bias toward AAPS workflows while still handling normal project work. Recognize .aaps folders and @lazyingart/aaps conventions, keep work project-local, document assumptions, and avoid secrets or publishing unless explicitly requested.",
    tools: ["files", "shell", "sandbox"],
  },
  github: {
    id: "github",
    label: "GitHub maintenance",
    prompt:
      "Bias toward safe git and GitHub maintenance while still fixing code/docs when asked. Always inspect git status and remotes first, separate unrelated changes, run relevant checks before commits, use gh when available for PR/issues/releases, prefer fast-forward pulls, and stop on conflicts or ambiguous history.",
    tools: ["shell", "files", "web_search", "inspect_project"],
  },
  word: {
    id: "word",
    label: "Word documents",
    prompt:
      "Bias toward Word/docx/document workflows while still using writing, conversion, LaTeX, or scripts when useful. Preserve originals, create clear output filenames, use available local tools such as pandoc/libreoffice/python packages when present, and verify generated documents exist before reporting success.",
    tools: ["files", "shell", "canvas", "sandbox"],
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
  default: "auto",
  general: "auto",
  large: "large-codebase",
  codebase: "large-codebase",
  repo: "large-codebase",
  repository: "large-codebase",
  engineering: "large-codebase",
  engineer: "large-codebase",
  application: "app",
  apps: "app",
  mobile: "android",
  apk: "android",
  gradle: "android",
  kotlin: "android",
  java: "android",
  frontend: "website",
  web: "website",
  site: "website",
  manuscript: "paper",
  academic: "paper",
  article: "paper",
  report: "paper",
  literature: "research",
  sources: "research",
  chapter: "book",
  fiction: "novel",
  story: "novel",
  supervise: "supervision",
  supervisor: "supervision",
  student: "supervision",
  training: "supervision",
  homework: "supervision",
  curriculum: "supervision",
  selfsupervision: "supervision",
  "self-supervision": "supervision",
  cpp: "c-cpp",
  "c++": "c-cpp",
  clang: "c-cpp",
  cmake: "c-cpp",
  r: "r-stan",
  stan: "r-stan",
  statistics: "r-stan",
  git: "github",
  gh: "github",
  release: "github",
  docx: "word",
  office: "word",
  system: "maintenance",
  sysadmin: "maintenance",
  computer: "maintenance",
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
  if (profile === "app") return 40;
  if (profile === "android") return 60;
  if (profile === "latex") return 30;
  if (profile === "supervision") return 40;
  if (["paper", "research", "book", "novel", "c-cpp", "r-stan", "github", "word", "maintenance"].includes(profile)) return 30;
  return 24;
}
