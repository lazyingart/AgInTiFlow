#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { formatSkillsForPrompt, listExternalSkillPacks, listSkills, selectSkillsForGoal } from "../src/skill-library.js";

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
  "autonomous-artifact-pipeline",
  "browser-automation",
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
  "self-healing-pipeline",
  "skill-creator",
  "source-ingestion",
  "structured-json",
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
assert(
  selectedIds("control an existing Chrome CDP browser composer, upload images, choose model duration, and submit").includes(
    "browser-automation"
  ),
  "browser automation prompt did not select browser-automation"
);
assert(selectedIds("网页表单 上传 五张图 从素材库选择视频 提交").includes("browser-automation"), "Chinese browser prompt did not select browser-automation");
assert(selectedIds("write a LaTeX paper and compile a PDF").includes("latex-manuscript"), "latex prompt did not select latex-manuscript");
assert(selectedIds("edit a Microsoft Word docx and preserve the original").includes("word-documents"), "docx prompt did not select word-documents");
assert(selectedIds("generate a logo image with grsai nanobanana").includes("image-generation"), "image prompt did not select image-generation");
assert(selectedIds("git status commit push with gh").includes("github-maintenance"), "git prompt did not select github-maintenance");
assert(selectedIds("monitor a long running tmux session").includes("tmux-session"), "tmux prompt did not select tmux-session");
assert(selectedIds("repair a stuck writer monitor pipeline and retry failed chunks").includes("self-healing-pipeline"), "stuck pipeline prompt did not select self-healing-pipeline");
assert(
  selectedIds("from raw pdf epub sources create markdown chunks json and compile final pdf in tmux with monitor and auto repair").includes(
    "autonomous-artifact-pipeline"
  ),
  "raw-source artifact pipeline prompt did not select autonomous-artifact-pipeline"
);
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
assert(selectedIds("convert scanned PDF EPUB and image sources to markdown with OCR").includes("source-ingestion"), "source ingestion prompt did not select source-ingestion");
assert(selectedIds("use json schema to fetch valid structured json for each chunk in parallel").includes("structured-json"), "structured JSON prompt did not select structured-json");
assert(selectedIds("write README API docs and a tutorial").includes("docs-knowledge"), "docs prompt did not select docs-knowledge");
assert(selectedIds("create a custom skill for a reusable browser upload workflow").includes("skill-creator"), "custom skill prompt did not select skill-creator");
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
assert(
  selectedIds(
    "Create acceptance.txt containing exactly AGINTI_STANDALONE_OK followed by one newline, then read it back."
  ).length === 0,
  "generic file work selected unrelated domain skills"
);

const prompt = formatSkillsForPrompt(selectSkillsForGoal("write latex manuscript with figures", { taskProfile: "latex", limit: 3 }));
assert(prompt.includes("A skill is Markdown guidance"), "skill prompt does not explain skill semantics");
assert(prompt.includes("latex-manuscript"), "skill prompt omitted selected skill");
assert(prompt.length < 5400, "skill prompt is too large for normal runs");

const localProject = fs.mkdtempSync(path.join(os.tmpdir(), "agintiflow-local-skill-"));
fs.mkdirSync(path.join(localProject, ".aginti", "skills", "local-browser-submit"), { recursive: true });
fs.writeFileSync(
  path.join(localProject, ".aginti", "skills", "local-browser-submit", "SKILL.md"),
  `---
id: local-browser-submit
label: Local Browser Submit
description: Project-local guidance for selecting assets, checking model controls, and submitting a browser composer.
triggers:
  - local browser submit
  - asset picker
tools:
  - run_command
  - read_image
---
# Local Browser Submit

Inspect the composer, attach required assets, verify visible state, then submit only when the requested controls are correct.
`,
  "utf8"
);
const localSkills = listSkills({ includeBody: false, projectRoot: localProject });
assert(localSkills.some((skill) => skill.id === "local-browser-submit" && skill.source === "project-local"), "project-local skill did not load");
assert(
  selectSkillsForGoal("use local browser submit with the asset picker", { includeBody: false, projectRoot: localProject }).some(
    (skill) => skill.id === "local-browser-submit"
  ),
  "project-local skill was not selected by goal"
);
const localCli = await execFileAsync(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "skills", "asset picker"], {
  cwd: localProject,
  timeout: 10000,
  maxBuffer: 512 * 1024,
  env: {
    ...process.env,
    AGINTIFLOW_RUNTIME_DIR: "",
  },
});
assert(
  localCli.stdout.includes("local-browser-submit") && localCli.stdout.includes("source=project-local"),
  "aginti skills did not print project-local skill from cwd"
);
fs.rmSync(localProject, { recursive: true, force: true });

const externalPackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agintiflow-scientific-pack-"));
fs.mkdirSync(path.join(externalPackRoot, "scientific-skills", "temp-omics-review"), { recursive: true });
fs.writeFileSync(
  path.join(externalPackRoot, "scientific-skills", "temp-omics-review", "SKILL.md"),
  `---
name: temp-omics-review
description: Review single-cell and multi-omics analysis plans with scientific rigor, typed outputs, and validation expectations.
allowed-tools: Read Write Edit Bash
metadata:
  skill-author: Test Pack
---
# Temp Omics Review

Inspect the dataset, define QC gates, select an analysis plan, and verify outputs before claiming scientific conclusions.
`,
  "utf8"
);
const previousExternalPacks = process.env.AGINTIFLOW_SKILL_PACKS;
process.env.AGINTIFLOW_SKILL_PACKS = externalPackRoot;
const externalPacks = listExternalSkillPacks();
assert(externalPacks.some((pack) => pack.root === externalPackRoot && pack.category === "scientific"), "external scientific pack did not register");
const externalSkills = listSkills({ includeBody: false }).filter((skill) => skill.id === "temp-omics-review");
assert(externalSkills.length === 1, "external pack skill did not load exactly once");
assert(externalSkills[0].source === "external-pack", "external pack skill did not keep source metadata");
assert(externalSkills[0].category === "scientific", "external pack skill did not keep category metadata");
assert(externalSkills[0].pack.id === path.basename(externalPackRoot), "external pack skill did not keep pack metadata");
assert(
  selectSkillsForGoal("review a multi-omics single-cell analysis plan", { includeBody: false, limit: 12 }).some(
    (skill) => skill.id === "temp-omics-review" && skill.source === "external-pack"
  ),
  "external scientific pack skill was not selected by goal"
);
const externalPrompt = formatSkillsForPrompt(selectSkillsForGoal("temp omics review", { includeBody: true, limit: 3 }));
assert(externalPrompt.includes("Source pack:"), "external skill prompt did not preserve source pack metadata");
if (previousExternalPacks === undefined) delete process.env.AGINTIFLOW_SKILL_PACKS;
else process.env.AGINTIFLOW_SKILL_PACKS = previousExternalPacks;
fs.rmSync(externalPackRoot, { recursive: true, force: true });

const agentPackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agintiflow-agent-skills-"));
for (const [id, description, marker] of [
  [
    "parametric-cad-design",
    "Design, revise, validate, render, and export parametric CAD holders and printable mechanical parts.",
    "CAD_ROUTINE_MARKER",
  ],
  [
    "musia-music-production",
    "Generate, review, correct, and hand off original songs and music through the mature Musia workflow.",
    "MUSIA_ROUTINE_MARKER",
  ],
  [
    "lalachan-xyq-browser-video",
    "Generate and monitor LALACHAN Xiaoyunque videos through the established browser workflow.",
    "LALACHAN_ROUTINE_MARKER",
  ],
  [
    "lazyedit-publish-workflow",
    "Process and explicitly publish verified videos through the mature LazyEdit and AutoPublish workflow.",
    "LAZYEDIT_ROUTINE_MARKER",
  ],
]) {
  fs.mkdirSync(path.join(agentPackRoot, id), { recursive: true });
  fs.writeFileSync(
    path.join(agentPackRoot, id, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n# ${id}\n\n## Core Rule\n\n${marker}: use the established project routine and verify its artifact.\n\n## Recovery\n\nResume the same task without replaying completed side effects.\n`,
    "utf8"
  );
}
const previousAgentPacks = process.env.AGINTIFLOW_AGENT_SKILL_PACKS;
const previousAgentDiscovery = process.env.AGINTIFLOW_DISCOVER_AGENT_SKILLS;
process.env.AGINTIFLOW_AGENT_SKILL_PACKS = agentPackRoot;
process.env.AGINTIFLOW_DISCOVER_AGENT_SKILLS = "1";
const agentPacks = listExternalSkillPacks();
assert(
  agentPacks.some((pack) => pack.root === agentPackRoot),
  "standard local Agent Skills pack did not register"
);
assert(
  selectSkillsForGoal("Design a CAD holder and render it", { includeBody: false, limit: 8 }).some(
    (skill) => skill.id === "parametric-cad-design"
  ),
  "standard Agent Skills CAD routine was not selected"
);
const mediaSkills = selectSkillsForGoal(
  "Generate music in Musia, make a LALACHAN video, then prepare it in LazyEdit without publishing",
  { includeBody: true, limit: 8 }
);
assert(mediaSkills.some((skill) => skill.id === "musia-music-production"), "Musia routine was not selected");
assert(mediaSkills.some((skill) => skill.id === "lalachan-xyq-browser-video"), "LALACHAN routine was not selected");
assert(mediaSkills.some((skill) => skill.id === "lazyedit-publish-workflow"), "LazyEdit routine was not selected");
const agentPrompt = formatSkillsForPrompt(mediaSkills);
assert(agentPrompt.includes("Full guidance:"), "selected Agent Skill omitted its full source path");
assert(agentPrompt.includes("Sections:"), "selected Agent Skill omitted its section index");
assert(agentPrompt.includes("MUSIA_ROUTINE_MARKER"), "selected Agent Skill omitted its operational excerpt");
process.env.AGINTIFLOW_DISCOVER_AGENT_SKILLS = "0";
assert(
  !listExternalSkillPacks().some((pack) => pack.root === agentPackRoot),
  "standard Agent Skills discovery could not be disabled"
);
if (previousAgentPacks === undefined) delete process.env.AGINTIFLOW_AGENT_SKILL_PACKS;
else process.env.AGINTIFLOW_AGENT_SKILL_PACKS = previousAgentPacks;
if (previousAgentDiscovery === undefined) delete process.env.AGINTIFLOW_DISCOVER_AGENT_SKILLS;
else process.env.AGINTIFLOW_DISCOVER_AGENT_SKILLS = previousAgentDiscovery;
fs.rmSync(agentPackRoot, { recursive: true, force: true });

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
