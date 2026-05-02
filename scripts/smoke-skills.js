#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { formatSkillsForPrompt, listSkills, selectSkillsForGoal } from "../src/skill-library.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function selectedIds(goal, taskProfile = "auto") {
  return selectSkillsForGoal(goal, { taskProfile, limit: 8 }).map((skill) => skill.id);
}

const skills = listSkills({ includeBody: true });
const ids = new Set(skills.map((skill) => skill.id));
assert(skills.length >= 14, "expected built-in skills to load");
for (const required of [
  "aaps",
  "code",
  "github-maintenance",
  "image-generation",
  "latex-manuscript",
  "system-maintenance",
  "tmux-session",
  "website-app",
  "word-documents",
]) {
  assert(ids.has(required), `missing required skill ${required}`);
}

assert(selectedIds("write a beautiful React website and preview it").includes("website-app"), "website prompt did not select website-app");
assert(selectedIds("write a LaTeX paper and compile a PDF").includes("latex-manuscript"), "latex prompt did not select latex-manuscript");
assert(selectedIds("edit a Microsoft Word docx and preserve the original").includes("word-documents"), "docx prompt did not select word-documents");
assert(selectedIds("generate a logo image with grsai nanobanana").includes("image-generation"), "image prompt did not select image-generation");
assert(selectedIds("git status commit push with gh").includes("github-maintenance"), "git prompt did not select github-maintenance");
assert(selectedIds("monitor a long running tmux session").includes("tmux-session"), "tmux prompt did not select tmux-session");
assert(selectedIds("create an .aaps example for @lazyingart/aaps").includes("aaps"), "AAPS prompt did not select aaps");
assert(selectedIds("debug a C++ CMake build").includes("c-cpp"), "C++ prompt did not select c-cpp");
assert(selectedIds("set up Stan and CmdStanR reproducibly").includes("r-stan"), "Stan prompt did not select r-stan");

const prompt = formatSkillsForPrompt(selectSkillsForGoal("write latex manuscript with figures", { taskProfile: "latex", limit: 3 }));
assert(prompt.includes("A skill is Markdown guidance"), "skill prompt does not explain skill semantics");
assert(prompt.includes("latex-manuscript"), "skill prompt omitted selected skill");
assert(prompt.length < 5400, "skill prompt is too large for normal runs");

const cli = await execFileAsync(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "skills", "website"], {
  cwd: repoRoot,
  timeout: 10000,
  maxBuffer: 512 * 1024,
  env: {
    ...process.env,
    AGINTIFLOW_RUNTIME_DIR: "",
  },
});
assert(cli.stdout.includes("website-app"), "aginti skills website did not print website-app");

console.log(
  JSON.stringify(
    {
      ok: true,
      skills: skills.length,
      checks: ["load-built-ins", "select-by-goal", "prompt-format", "cli-skills"],
    },
    null,
    2
  )
);
