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
assert(skills.length >= 27, "expected built-in skills to load");
for (const required of [
  "aaps",
  "code",
  "code-review",
  "data-analysis",
  "database",
  "dotnet-csharp",
  "devops-deployment",
  "docs-knowledge",
  "education-tutorial",
  "go",
  "github-maintenance",
  "image-generation",
  "ios-swift",
  "java-jvm",
  "latex-manuscript",
  "presentation-slides",
  "qa-testing",
  "ruby",
  "rust",
  "php",
  "security-review",
  "system-maintenance",
  "supervision-student",
  "tmux-session",
  "website-app",
  "word-documents",
  "writing-editing",
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
assert(selectedIds("fix this Java Spring Maven JUnit project").includes("java-jvm"), "Java prompt did not select java-jvm");
assert(selectedIds("build an iOS SwiftUI app and test it in simulator").includes("ios-swift"), "iOS prompt did not select ios-swift");
assert(selectedIds("repair this Go module and run go test").includes("go"), "Go prompt did not select go");
assert(selectedIds("fix a Rust cargo workspace and run cargo test").includes("rust"), "Rust prompt did not select rust");
assert(selectedIds("debug a C# dotnet web API").includes("dotnet-csharp"), ".NET prompt did not select dotnet-csharp");
assert(selectedIds("fix a PHP Laravel composer project").includes("php"), "PHP prompt did not select php");
assert(selectedIds("repair a Ruby Rails app with RSpec").includes("ruby"), "Ruby prompt did not select ruby");
assert(selectedIds("clean a CSV dataset and make plots").includes("data-analysis"), "data prompt did not select data-analysis");
assert(selectedIds("write README API docs and a tutorial").includes("docs-knowledge"), "docs prompt did not select docs-knowledge");
assert(selectedIds("fix failing tests and add regression coverage").includes("qa-testing"), "QA prompt did not select qa-testing");
const qaSkill = skills.find((skill) => skill.id === "qa-testing");
assert(qaSkill?.body.includes("Do not invent staged bugs"), "QA skill does not guard against fake staged failures");
const pythonSkill = skills.find((skill) => skill.id === "python");
assert(pythonSkill?.body.includes("PEP 701 relaxed f-strings"), "Python skill must mention 3.12 f-string compatibility traps");
assert(pythonSkill?.body.includes("only proves the active interpreter"), "Python skill must guard syntax-check overclaims");
assert(selectedIds("write SQL migrations for sqlite schema").includes("database"), "database prompt did not select database");
assert(selectedIds("debug Docker deployment logs and port config").includes("devops-deployment"), "devops prompt did not select devops-deployment");
assert(selectedIds("review auth security and secrets handling").includes("security-review"), "security prompt did not select security-review");
assert(selectedIds("make a PowerPoint pitch deck").includes("presentation-slides"), "slides prompt did not select presentation-slides");
assert(selectedIds("edit a markdown screenplay final draft").includes("writing-editing"), "writing prompt did not select writing-editing");
assert(selectedIds("create a lesson with exercises and quiz").includes("education-tutorial"), "education prompt did not select education-tutorial");
assert(selectedIds("review this PR architecture without editing").includes("code-review"), "review prompt did not select code-review");
assert(selectedIds("supervise a student agent in tmux and verify its artifacts", "supervision").includes("supervision-student"), "supervision prompt did not select supervision-student");
assert(selectedIds("supervision").includes("supervision-student"), "single-word supervision prompt did not select supervision-student");
assert(!selectedIds("supervision").includes("r-stan"), "single-word supervision prompt incorrectly selected r-stan");

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

const supervisionCli = await execFileAsync(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "skills", "supervision"], {
  cwd: repoRoot,
  timeout: 10000,
  maxBuffer: 512 * 1024,
  env: {
    ...process.env,
    AGINTIFLOW_RUNTIME_DIR: "",
  },
});
assert(supervisionCli.stdout.includes("supervision-student"), "aginti skills supervision did not print supervision-student");
assert(!supervisionCli.stdout.includes("r-stan:"), "aginti skills supervision incorrectly printed r-stan");

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
