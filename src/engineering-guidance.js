import { defaultMaxStepsForProfile, normalizeTaskProfile } from "./task-profiles.js";

const LANGUAGE_HINTS = [
  {
    id: "javascript-typescript",
    pattern: /\b(node|npm|pnpm|yarn|bun|javascript|typescript|react|vue|svelte|next\.?js|vite|express)\b/i,
    text:
      "JS/TS: inspect package.json and lockfiles, identify package manager, use npm/pnpm/yarn scripts before inventing commands, prefer targeted node --check/tsc/test runs before broad builds.",
  },
  {
    id: "python",
    pattern: /\b(python|pytest|pip|uv|poetry|conda|venv|jupyter|fastapi|django|flask|pandas|numpy)\b/i,
    text:
      "Python: inspect pyproject/requirements, prefer project-local venv/uv/conda or Docker, run python -m pytest or focused module checks, avoid global package installs on host, and check Python caches recursively with find . -type d -name __pycache__ -o -name '*.pyc' before claiming none exist.",
  },
  {
    id: "rust",
    pattern: /\b(rust|cargo|crate|clippy|rustfmt|tokio|actix)\b/i,
    text:
      "Rust: inspect Cargo.toml/workspace crates, run cargo fmt/check/test on the narrowest crate first, preserve Cargo.lock discipline, avoid broad workspace runs until focused checks pass.",
  },
  {
    id: "go",
    pattern: /\b(golang|go test|go mod|goroutine|gin|grpc)\b/i,
    text:
      "Go: inspect go.mod, use go test ./pkg-or-target first, run gofmt on touched files, avoid changing module paths unless required.",
  },
  {
    id: "android",
    pattern: /\b(android|apk|adb|avd|emulator|gradle wrapper|gradlew|android sdk|kotlin android|jetpack|compose)\b/i,
    text:
      "Android: inspect git status, Gradle/settings/manifests, ANDROID_HOME/SDK paths, Java/Kotlin versions, adb devices, and emulator/AVD list first. Never start host sudo or host OS package installs; use the existing SDK, a project-local Gradle wrapper, user-writable caches, or return a precise setup report. Build, install with adb, launch with am, verify with logcat/screencap when possible, save screenshots under a durable workspace path, then commit.",
  },
  {
    id: "java-jvm",
    pattern: /\b(java|kotlin|gradle|maven|spring|junit|jvm)\b/i,
    text:
      "JVM: inspect pom.xml/build.gradle/settings.gradle, use focused Maven/Gradle test targets, keep generated build outputs out of source patches.",
  },
  {
    id: "c-cpp",
    pattern: /\b(c\+\+|cpp|cmake|makefile|gcc|clang|native|segfault|asan|valgrind)\b/i,
    text:
      "C/C++: inspect CMake/Make/build scripts, prefer out-of-tree builds, run compile-only or narrow tests first, use sanitizers only when available and safe.",
  },
  {
    id: "shell-system",
    pattern: /\b(shell|bash|zsh|system|systemd|docker|linux|ubuntu|debian|apt|yum|dnf|brew|service|permission denied|port|network)\b/i,
    text:
      "System/shell: diagnose first with read-only commands, capture versions/logs, make reversible scripts, use Docker for installs/toolchains, and only use host-level changes when policy explicitly allows them.",
  },
  {
    id: "git",
    pattern: /\b(git|commit|push|pull|merge|rebase|branch|remote|status|diff)\b/i,
    text:
      "Git: always run git status --short and git diff --stat before commit/push. Commit only requested changes, use a clear message, run git fetch before push when remote state matters, prefer git pull --ff-only, and stop to ask if there are conflicts, unrelated dirty files, divergent branches, or ambiguous merge choices.",
  },
  {
    id: "supervision",
    pattern: /\b(supervise|supervisor|student agent|homework|curriculum|self[- ]?supervision|train the agent|agent training|monitor tmux)\b/i,
    text:
      "Supervision: do not simply believe the student agent. Define acceptance criteria, give normal user-level prompts, monitor tmux/session logs, verify artifacts and git state externally, record evidence, and turn repeated failures into durable profile, skill, tool, policy, or test improvements.",
  },
  {
    id: "r-stats",
    pattern: /\b(rstats|r language|cmdstanr|stan|renv|tidyverse|shiny)\b/i,
    text:
      "R/Stan: inspect renv/DESCRIPTION and project notes, prefer project-local libraries or Docker, validate scripts with non-interactive Rscript commands when available.",
  },
  {
    id: "latex",
    pattern: /\b(latex|tex|pdflatex|latexmk|bibtex|biber|pdf)\b/i,
    text:
      "LaTeX: keep source/figures together, compile from the document directory, run enough passes for refs/bibliography, publish PDF/source artifacts to canvas.",
  },
];

const COMPLEX_ENGINEERING_PATTERN =
  /\b(large|complex|complicated|monorepo|codebase|repository|repo-wide|multi[- ]file|cross[- ]file|architecture|refactor|migration|regression|root cause|failing tests?|fix build|system bug|debug|performance|security)\b/i;

export function engineeringGuidanceForTask(goal = "", taskProfile = "auto") {
  const normalizedProfile = normalizeTaskProfile(taskProfile);
  const text = String(goal || "");
  const matched = LANGUAGE_HINTS.filter((hint) => hint.pattern.test(text));
  const wantsComplex =
    normalizedProfile === "large-codebase" ||
    normalizedProfile === "maintenance" ||
    COMPLEX_ENGINEERING_PATTERN.test(text) ||
    text.length > 500;

  if (!wantsComplex && matched.length === 0) return "";

  const lines = [
    "Engineering operating mode:",
    "Use the proven coding-agent loop: inspect_project, read instructions/manifests, search exact symbols/errors, patch small coherent batches, run focused checks, repair failures, then summarize changed files and residual risks.",
    "Keep CLI and web behavior equivalent: use the same workspace, sessions, profiles, file tools, shell policy, Docker mounts, and canvas artifacts.",
    "For large repositories, preserve context by reading fewer but more relevant files; prefer deterministic tools and diffs over long model memory.",
    "Build a compact context pack before major edits: project instructions, manifests/scripts, git status/diff, relevant symbols/search hits, target files, and the narrowest checks. Do not paste whole trees or huge files into model context.",
    "For system repair, act like a doctor: gather evidence first, avoid silent destructive host changes, prefer Docker or project-local scripts for installs, and make every stronger action explicit in logs.",
    "Never send sudo passwords or wait at interactive password prompts. If host-level permission is truly required, stop that path, explain the blocker, and provide a manual command instead of hanging.",
    "Shell commands already start in the configured workspace. Prefer workspace-relative commands such as python3 scripts/check.py or cd subdir && make; do not prefix commands with absolute host cd paths unless the tool explicitly requires it.",
    "When you create or fix scripts, reports, tables, generated files, or analysis outputs, inspect the actual output. If it contains obvious duplicates, noisy rows, stale names, broken markdown, or contradictions, patch the source/output and rerun the check rather than merely explaining the defect in the report.",
    "Before claiming a coding task is finished, run git status --short when git is available. Leave the worktree clean, or explicitly report and justify each remaining untracked/unstaged artifact.",
    "Do not claim there are no transient artifacts unless you checked recursively for the relevant stack, such as find . -type d -name __pycache__ -o -name '*.pyc' for Python. A clean git status means tracked work is clean; ignored caches such as __pycache__ may still exist and should be removed or described accurately if relevant.",
    "For generated screenshots, images, PDFs, reports, archives, and app packages, choose a descriptive non-conflicting workspace path when the user did not specify one. Verify the file still exists after cleanup before claiming it was saved.",
  ];

  if (matched.length > 0) {
    lines.push("Stack-specific checks:");
    for (const hint of matched.slice(0, 5)) lines.push(`- ${hint.text}`);
  }

  return lines.join("\n");
}

export function recommendedMaxStepsForTask({ goal = "", taskProfile = "auto", complexityScore = 0 } = {}) {
  const normalizedProfile = normalizeTaskProfile(taskProfile);
  const profileDefault = defaultMaxStepsForProfile(normalizedProfile);
  const text = String(goal || "");
  if (normalizedProfile === "large-codebase" || complexityScore >= 3 || COMPLEX_ENGINEERING_PATTERN.test(text)) {
    return Math.max(profileDefault, 36);
  }
  if (/\b(latex|tex|pdflatex|latexmk|pdf|website|app|docker|system|install|setup|debug)\b/i.test(text)) {
    return Math.max(profileDefault, 30);
  }
  return profileDefault;
}
