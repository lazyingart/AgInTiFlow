#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLaunchHeaderLines,
  formatCommittedUserPromptLines,
  buildPromptLayout,
  buildPromptRenderSequence,
  canonicalSlashPromptBuffer,
  classifyEscapeAction,
  formatElapsedDuration,
  formatWorkspaceChange,
  stripMarkdown,
} from "../src/interactive-cli.js";
import { parseArgs, parseResumeCommandArgs, splitResumeCommandArgv } from "../src/cli.js";
import { dockerPolicyTimeoutMs, dockerUserCommand } from "../src/docker-sandbox.js";
import { formatBehaviorContractForPrompt } from "../src/behavior-contract.js";
import { SUPPORTED_LANGUAGES, t } from "../src/i18n.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-cli-chat-"));
const agintiflowHome = path.join(tempRoot, ".agintiflow-home");
const binPath = path.join(repoRoot, "bin/aginti-cli.js");

function charCellWidth(char = "") {
  const code = char.codePointAt(0);
  if (!code) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

function cellWidth(value = "") {
  return [...String(value || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")].reduce((sum, char) => sum + charCellWidth(char), 0);
}

function runChat(inputText) {
  return runCli(["chat", "--provider", "mock", "--routing", "manual", "--profile", "code"], inputText);
}

function runCli(args, inputText) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: tempRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        AGINTIFLOW_RUNTIME_DIR: "",
        AGINTIFLOW_HOME: agintiflowHome,
        AGINTIFLOW_PREVIEW_TTL_MS: "1000",
        AGINTI_LANGUAGE: "en",
      },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("interactive chat smoke timed out"));
    }, 25000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`interactive chat exited ${code}\n${stdout}\n${stderr}`));
    });

    child.stdin.end(inputText);
  });
}

try {
  const translatedHelpKeys = [
    "helpHelp",
    "helpStatus",
    "helpLogin",
    "helpInstructions",
    "helpModels",
    "helpVenice",
    "helpRoute",
    "helpModel",
    "helpSpare",
    "helpWrapper",
    "helpAuxiliary",
    "helpAaps",
    "helpNew",
    "helpResume",
    "helpReview",
    "helpRename",
    "helpSessions",
    "helpSkills",
    "helpSkillMesh",
    "helpProfile",
    "helpWebSearch",
    "helpEnableScs",
    "helpScouts",
    "helpRouting",
    "helpProvider",
    "helpDockerOn",
    "helpDockerOff",
    "helpLatex",
    "helpInstalls",
    "helpCwd",
    "helpLanguage",
    "helpExit",
    "helpNormalRequest",
    "helpAutocomplete",
    "helpQueue",
    "helpEditQueue",
    "helpEsc",
  ];
  for (const language of SUPPORTED_LANGUAGES.filter((item) => item !== "en")) {
    for (const key of translatedHelpKeys) {
      if (t(key, language) === t(key, "en")) {
        throw new Error(`missing localized help string ${language}.${key}`);
      }
    }
  }

  const renderedMarkdown = stripMarkdown(
    [
      "**Docker status**",
      "",
      "| Check | Result |",
      "| --- | --- |",
      "| `/.dockerenv` | **Present** |",
      "| `data_helper_report.md` | **Found** |",
      "| Hostname | `abc123` |",
    ].join("\n")
  );
  if (renderedMarkdown.includes("**") || renderedMarkdown.includes("| --- |")) {
    throw new Error("terminal markdown renderer left raw markdown syntax");
  }
  if (!renderedMarkdown.includes("Check") || !renderedMarkdown.includes("Present")) {
    throw new Error("terminal markdown renderer dropped table content");
  }
  if ((renderedMarkdown.match(/Present/g) || []).length !== 1) {
    throw new Error("terminal markdown renderer duplicated table rows");
  }
  if (!renderedMarkdown.includes("data_helper_report.md")) {
    throw new Error("terminal markdown renderer corrupted underscores in table cell literals");
  }
  const renderedMarkdownFence = stripMarkdown(
    [
      "```markdown",
      "# Saved Story",
      "",
      "| File | Status |",
      "| --- | --- |",
      "| `story-ja.md` | **saved** |",
      "```",
    ].join("\n")
  );
  if (
    renderedMarkdownFence.includes("code markdown") ||
    renderedMarkdownFence.includes("| --- |") ||
    !renderedMarkdownFence.includes("Saved Story") ||
    !renderedMarkdownFence.includes("story-ja.md")
  ) {
    throw new Error("terminal markdown renderer did not unwrap full markdown fences");
  }
  const renderedDiff = stripMarkdown(
    [
      "Diff:",
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ line 1 @@",
      "-old",
      "+new",
    ].join("\n")
  );
  if (!renderedDiff.includes("-old") || !renderedDiff.includes("+new")) {
    throw new Error("terminal markdown renderer dropped patch diff lines");
  }
  const renderedPatchEvent = formatWorkspaceChange({
    toolName: "apply_patch",
    path: "test_cli.py",
    beforeHash: "aaaaaaaa11111111",
    afterHash: "bbbbbbbb22222222",
    diff: ["--- a/test_cli.py", "+++ b/test_cli.py", "@@ line 10 @@", "-old line", "+new line"].join("\n"),
  });
  if (
    renderedPatchEvent.label !== "patch" ||
    !renderedPatchEvent.summary.includes("test_cli.py") ||
    !renderedPatchEvent.lines.join("\n").includes("-old line") ||
    !renderedPatchEvent.lines.join("\n").includes("+new line")
  ) {
    throw new Error("workspace patch event formatter did not preserve red/green diff content");
  }
  const launchHeader = buildLaunchHeaderLines({ width: 120, packageVersion: "0.0.0", animated: false }).join("\n");
  if (!launchHeader.includes("█████") || !launchHeader.includes("v0.0.0") || launchHeader.split("\n").length < 9) {
    throw new Error("large launch header did not render a centered multi-line title");
  }
  if (
    formatElapsedDuration(0) !== "00:00" ||
    formatElapsedDuration(65_000) !== "01:05" ||
    formatElapsedDuration(3_665_000) !== "1:01:05"
  ) {
    throw new Error("elapsed duration formatter returned an unexpected value");
  }
  const behaviorContract = formatBehaviorContractForPrompt();
  if (
    !behaviorContract.includes("name the actual environment used") ||
    !behaviorContract.includes("Do not claim compatibility across untested runtimes") ||
    !behaviorContract.includes("Do not self-invoke AgInTiFlow")
  ) {
    throw new Error("behavior contract must guard against host/Docker, runtime-version, and recursive self-invocation overclaims");
  }
  const wrappedDockerCommand = dockerUserCommand("node --test 2>&1 | tail -30", {
    category: "general-shell",
    needsNetwork: false,
  });
  if (
    dockerPolicyTimeoutMs({ needsNetwork: true }) !== 120000 ||
    !wrappedDockerCommand.includes("timeout -k 5s 15s bash -lc") ||
    !wrappedDockerCommand.includes("'node --test 2>&1 | tail -30'")
  ) {
    throw new Error("docker sandbox command wrapper did not add a bounded inner timeout");
  }

  const promptLayout = buildPromptLayout(`${"x".repeat(180)}\nsecond line`, 95, 80, 24);
  const promptText = promptLayout.renderedRows
    .map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))
    .join("\n");
  if (!promptText.includes("user>")) {
    throw new Error("terminal prompt layout did not render the user> label");
  }
  if (!promptText.includes("  user> ") || promptText.includes("user>   ")) {
    throw new Error("terminal prompt layout did not right-align user> to the aginti> label width");
  }
  const visibleLengths = promptLayout.renderedRows.map((line) =>
    line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").length
  );
  if (promptLayout.rows.length < 4 || Math.max(...visibleLengths) > 79) {
    throw new Error("terminal prompt layout did not wrap long multiline input safely");
  }
  if (promptLayout.cursorRow < 0 || promptLayout.cursorColumn < 0) {
    throw new Error("terminal prompt layout returned an invalid cursor location");
  }
  const promptCursorMoveBefore = buildPromptLayout("smooth typing", 13, 90, 24, { commandCwd: "/tmp/aginti-project" });
  const promptCursorMoveAfter = buildPromptLayout("smooth typing", 4, 90, 24, { commandCwd: "/tmp/aginti-project" });
  const cursorOnlySequence = buildPromptRenderSequence(promptCursorMoveAfter, {
    lineCount: promptCursorMoveBefore.renderedRows.length,
    cursorRow: promptCursorMoveBefore.cursorRow,
    renderedRows: promptCursorMoveBefore.renderedRows,
  });
  if (cursorOnlySequence.includes("\x1b[2K") || cursorOnlySequence.includes("\x1b[?25l")) {
    throw new Error("cursor-only prompt moves should not clear/redraw the input panel");
  }
  const paddedPromptLayout = buildPromptLayout("hello", 5, 80, 24, { commandCwd: "/tmp/aginti-project" });
  const paddedRows = paddedPromptLayout.renderedRows.map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
  if (
    paddedPromptLayout.cursorRow !== 1 ||
    paddedRows[0].trim() !== "" ||
    !paddedRows[1].includes("  user> hello") ||
    paddedRows[2].trim() !== "" ||
    !paddedRows[3].includes("cwd     /tmp/aginti-project")
  ) {
    throw new Error("terminal prompt layout did not render visual-only input padding safely");
  }
  const committedUserText = formatCommittedUserPromptLines("list files", 90)
    .map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))
    .join("\n");
  if (!committedUserText.includes("  user> list files") || committedUserText.includes("cwd")) {
    throw new Error("committed user history should not include the live cwd footer");
  }
  const zhPromptLayout = buildPromptLayout("", 0, 90, 24, { language: "zh-Hans", commandCwd: "/tmp/aginti-project" });
  const zhPromptText = zhPromptLayout.renderedRows.map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")).join("\n");
  if (!zhPromptText.includes("输入任务")) {
    throw new Error("terminal prompt layout did not localize the empty input hint");
  }
  const jaLaunchHeader = buildLaunchHeaderLines({ width: 120, packageVersion: "0.0.0", animated: false, language: "ja" }).join("\n");
  if (!jaLaunchHeader.includes("低コストでプロジェクトを理解するエージェント")) {
    throw new Error("launch header did not localize by language option");
  }
  const zhLaunchHeader = buildLaunchHeaderLines({ width: 80, packageVersion: "0.0.0", animated: false, language: "zh-Hans" });
  if (zhLaunchHeader.some((line) => cellWidth(line) > 80)) {
    throw new Error("launch header did not account for CJK terminal cell width");
  }
  const jaNarrowHeader = buildLaunchHeaderLines({ width: 80, packageVersion: "0.0.0", animated: false, language: "ja" });
  if (jaNarrowHeader.some((line) => cellWidth(line) > 80)) {
    throw new Error("Japanese launch header overflowed narrow terminal width");
  }
  const hugePromptLayout = buildPromptLayout(Array.from({ length: 30 }, (_unused, index) => `line ${index + 1}`).join("\n"), 120, 80, 20);
  if (hugePromptLayout.renderedRows.length > 12 || !hugePromptLayout.renderedRows.some((line) => line.includes("earlier input row"))) {
    throw new Error("terminal prompt layout did not bound redraw size for large prompts");
  }
  const queuedPromptLayout = buildPromptLayout("follow up", 9, 90, 24, {
    commandCwd: "/tmp/aginti-project",
    statusLine: "running · tool: apply_patch with a very long request that should be compacted in the panel",
    pendingAsap: [{ content: "apply this to the running task" }],
    pendingQueued: [{ content: "run this after the current task" }],
  });
  const queuedText = queuedPromptLayout.renderedRows
    .map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))
    .join("\n");
  if (
    !queuedText.includes("run     running · tool: apply_patch") ||
    !queuedText.includes("→ apply this") ||
    !queuedText.includes("↳ run this") ||
    !queuedText.includes("cwd     /tmp/aginti-project")
  ) {
    throw new Error("terminal prompt layout did not render live input queue and cwd footer");
  }
  const hintPromptLayout = buildPromptLayout("/mo", 3, 90, 24, { suggestions: ["/models", "/model"], suggestionIndex: 1 });
  const hintText = hintPromptLayout.renderedRows
    .map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))
    .join("\n");
  if (!hintText.includes("  user> /mo") || !hintText.includes("hint    /models  >/model")) {
    throw new Error("terminal prompt layout did not align user and hint text columns");
  }
  const exactHintLayout = buildPromptLayout("/model", 6, 90, 24);
  const exactHintText = exactHintLayout.renderedRows
    .map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))
    .join("\n");
  if (!exactHintText.includes("hint    >/model") || exactHintText.includes("/models")) {
    throw new Error("exact slash commands should not show broader prefix matches");
  }
  if (classifyEscapeAction({ active: false }) !== "noop") {
    throw new Error("idle Esc should not redraw or clear the prompt");
  }
  if (classifyEscapeAction({ active: true, pendingAsap: [{ content: "apply now" }] }) !== "wait-for-asap") {
    throw new Error("active Esc should wait when ASAP pipe messages are pending");
  }
  if (classifyEscapeAction({ active: true, pendingAsap: [] }) !== "abort") {
    throw new Error("active Esc should abort when no ASAP pipe messages are pending");
  }
  await runChat("/exit\n");
  const idleSessionEntries = await fs.readdir(path.join(agintiflowHome, "sessions"), { withFileTypes: true }).catch(() => []);
  if (idleSessionEntries.some((entry) => entry.isDirectory())) {
    throw new Error("idle interactive chat created a session before any user task");
  }
  if (
    canonicalSlashPromptBuffer("/ve") !== "/venice" ||
    canonicalSlashPromptBuffer("/v") !== "/venice" ||
    canonicalSlashPromptBuffer("/sc") !== "/scs" ||
    canonicalSlashPromptBuffer("/not-a-command") !== "/not-a-command" ||
    canonicalSlashPromptBuffer("/venice off") !== "/venice off"
  ) {
    throw new Error("slash command prompt canonicalization did not preserve final submitted command correctly");
  }
  const scsBooleanArgs = parseArgs(["--scs", "fix this project"]);
  if (scsBooleanArgs.enableScs !== "on" || scsBooleanArgs.goal !== "fix this project") {
    throw new Error("--scs should behave as a boolean flag when followed by a task");
  }
  const scsAutoArgs = parseArgs(["--scs", "auto", "fix this project"]);
  if (scsAutoArgs.enableScs !== "auto" || scsAutoArgs.goal !== "fix this project") {
    throw new Error("--scs auto should consume auto and preserve the task");
  }
  const unknownOptionArgs = parseArgs(["--provider", "mock", "--allow-web-search", "research this"]);
  if (unknownOptionArgs.unknownOptions[0] !== "--allow-web-search" || unknownOptionArgs.goal !== "research this") {
    throw new Error("unknown option-like arguments before the prompt should be reported, not silently folded into the goal");
  }
  const dashedPromptArgs = parseArgs(["--provider", "mock", "--", "--allow-web-search should be prompt text"]);
  if (dashedPromptArgs.unknownOptions.length || dashedPromptArgs.goal !== "--allow-web-search should be prompt text") {
    throw new Error("explicit -- delimiter should allow prompt text that starts with a dash");
  }
  const resumeAfterOptions = parseResumeCommandArgs([
    "web-agent-smoke",
    "--provider",
    "deepseek",
    "--routing",
    "smart",
    "--sandbox-mode",
    "host",
    "--scout-count",
    "3",
  ]);
  const resumeAfterParsed = parseArgs(resumeAfterOptions.optionArgv);
  if (
    resumeAfterOptions.sessionId !== "web-agent-smoke" ||
    resumeAfterOptions.prompt ||
    resumeAfterParsed.provider !== "deepseek" ||
    resumeAfterParsed.routingMode !== "smart" ||
    resumeAfterParsed.sandboxMode !== "host" ||
    resumeAfterParsed.parallelScoutCount !== 3
  ) {
    throw new Error("resume subcommand options after the session id should remain options, not prompt text");
  }
  const resumePromptAfterDash = parseResumeCommandArgs(["web-agent-smoke", "--provider", "mock", "--", "--provider should be prompt"]);
  if (
    resumePromptAfterDash.sessionId !== "web-agent-smoke" ||
    resumePromptAfterDash.prompt !== "--provider should be prompt" ||
    parseArgs(resumePromptAfterDash.optionArgv).provider !== "mock"
  ) {
    throw new Error("resume subcommand should preserve explicit prompt text after --");
  }
  const resumeUnknownOption = parseResumeCommandArgs(["web-agent-smoke", "--allow-web-search", "continue research"]);
  if (resumeUnknownOption.unknownOptions[0] !== "--allow-web-search" || resumeUnknownOption.prompt !== "continue research") {
    throw new Error("resume subcommand should report unknown option-like arguments before prompt text");
  }
  const leadingResume = splitResumeCommandArgv(["--provider", "mock", "--routing", "manual", "resume", "latest"]);
  if (
    !leadingResume ||
    leadingResume.resumeArgv.join(" ") !== "latest" ||
    parseArgs(leadingResume.leadingOptionArgv).provider !== "mock" ||
    parseArgs(leadingResume.leadingOptionArgv).routingMode !== "manual"
  ) {
    throw new Error("leading global options before resume should still invoke the resume subcommand");
  }
  if (splitResumeCommandArgv(["--provider", "mock", "resume", "a normal task"]) !== null) {
    throw new Error("leading global options should not turn an ordinary resume-themed prompt into the resume subcommand");
  }

  await runCli(["init"], "");
  const instructions = await fs.readFile(path.join(tempRoot, "AGINTI.md"), "utf8");
  if (!instructions.includes("Project instructions for AgInTiFlow agents.")) {
    throw new Error("init did not create AGINTI.md");
  }
  const instructionsResult = await runChat("/instructions\n/exit\n");
  if (!instructionsResult.stdout.includes("AGINTI.md") || !instructionsResult.stdout.includes("Project instructions")) {
    throw new Error("interactive /instructions did not show AGINTI.md");
  }
  const helpResult = await runChat("/help\n/exit\n");
  const misspelledAuxiliary = "/auxil" + "liary";
  if (
    !helpResult.stdout.includes("/auxiliary") ||
    !helpResult.stdout.includes("/review") ||
    !helpResult.stdout.includes("/scs") ||
    helpResult.stdout.includes("helpReview") ||
    helpResult.stdout.includes("helpRename") ||
    helpResult.stdout.includes("/enable" + "ss") ||
    helpResult.stdout.includes(misspelledAuxiliary)
  ) {
    throw new Error("interactive help did not expose the expected slash commands");
  }
  const zhHelpResult = await runCli(["chat", "--language", "zh-Hans"], "/help\n/exit\n");
  if (!zhHelpResult.stdout.includes("命令:") || !zhHelpResult.stdout.includes("输入普通任务")) {
    throw new Error("interactive --language zh-Hans did not localize CLI help");
  }
  const skillsResult = await runChat("/skills website\n/exit\n");
  if (!skillsResult.stdout.includes("website-app") || !skillsResult.stdout.includes("Website And App Builder")) {
    throw new Error("interactive /skills did not show matching built-in skills");
  }
  const reviewResult = await runChat("/review changed files only\n/exit\n");
  if (!reviewResult.stdout.includes("Review focus: changed files only") || !reviewResult.stdout.includes("Mock run complete")) {
    throw new Error("interactive /review did not launch the bounded review workflow");
  }
  const scsOnResult = await runChat("/scs\n");
  if (!scsOnResult.stdout.includes("scs=on")) {
    throw new Error("interactive /scs did not toggle SCS on");
  }
  const legacyScsAlias = "/enable" + "ss";
  const oldScsAliasResult = await runChat(`${legacyScsAlias}\n/exit\n`);
  if (!oldScsAliasResult.stdout.includes(`Unknown command: ${legacyScsAlias}`) || oldScsAliasResult.stdout.includes("scs=on")) {
    throw new Error(`legacy ${legacyScsAlias} alias should be removed and must not toggle SCS`);
  }
  const scsOffResult = await runCli(["chat", "--provider", "mock", "--routing", "manual", "--profile", "code", "--scs"], "/scs\n");
  if (!scsOffResult.stdout.includes("scs=off")) {
    throw new Error("interactive /scs did not toggle SCS off");
  }
  const scsStatusResult = await runChat("/scs status\n");
  if (!scsStatusResult.stdout.includes("SCS mode: off")) {
    throw new Error("interactive /scs status did not show current mode");
  }
  const scsAutoResult = await runChat("/scs auto\n");
  if (!scsAutoResult.stdout.includes("scs=auto")) {
    throw new Error("interactive /scs auto did not enable auto mode");
  }
  const abbreviatedSkillsResult = await runChat("/sk website\n/ex\n");
  if (abbreviatedSkillsResult.stdout.includes("Unknown command") || !abbreviatedSkillsResult.stdout.includes("website-app")) {
    throw new Error("interactive slash command prefix did not auto-select the first matching command");
  }
  const abbreviatedVeniceResult = await runChat("/ve\n");
  const veniceOffResult = await runChat("/venice off\n");
  if (
    !abbreviatedVeniceResult.stdout.includes("venice=on") ||
    !abbreviatedVeniceResult.stdout.includes("route=venice/venice-uncensored-1-2") ||
    !veniceOffResult.stdout.includes("venice=off") ||
    !veniceOffResult.stdout.includes("route=deepseek/deepseek-v4-flash")
  ) {
    throw new Error("interactive /ve prefix did not toggle Venice roles and restore DeepSeek defaults");
  }
  await runChat("remember that this project prefers pytest smoke tests in AGINTI.md\n/exit\n");
  const updatedInstructions = await fs.readFile(path.join(tempRoot, "AGINTI.md"), "utf8");
  if (!updatedInstructions.includes("pytest smoke tests")) {
    throw new Error("chat did not update AGINTI.md project instructions in mock mode");
  }

  const result = await runChat("Create notes/interactive.md with a short CLI chat smoke message\n/exit\n");
  const written = await fs.readFile(path.join(tempRoot, "notes/interactive.md"), "utf8");
  if (!written.includes("Created by AgInTiFlow mock mode.")) {
    throw new Error("interactive chat did not create the expected file");
  }
  if (!result.stdout.includes("Interactive agent chat")) {
    throw new Error("interactive chat did not print its banner");
  }
  if (!result.stdout.includes("status=idle session=")) {
    throw new Error("interactive chat did not print final run status");
  }
  if (!/aginti>\s*\r?\n\s*\|\s+Mock run complete\./.test(result.stdout)) {
    throw new Error("assistant response did not render with a fresh-line response gutter");
  }

  const latest = await runCli(["resume"], "/exit\n");
  if (!latest.stdout.includes("session=") || !latest.stdout.includes("Interactive agent chat")) {
    throw new Error("bare aginti resume did not open the latest session interactively");
  }
  if (!latest.stdout.includes("resume history") || !latest.stdout.includes("chat=") || !latest.stdout.includes("Mock run complete")) {
    throw new Error("bare aginti resume did not preview saved chat history");
  }
  if (!latest.stdout.includes("  user>") || !latest.stdout.includes("aginti>") || latest.stdout.includes("user>   ")) {
    throw new Error("resume history should use prompt-style user>/aginti> labels");
  }
  if (!latest.stdout.includes("resume note=showing chat transcript only")) {
    throw new Error("bare aginti resume did not clarify that tool/run events are separate from chat history");
  }
  if (latest.stdout.includes("showing=") || latest.stdout.includes("…")) {
    throw new Error("resume history should render full saved messages instead of compact previews");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectRoot: tempRoot,
        checks: [
          "markdown-render",
          "markdown-fence-render",
          "markdown-table-no-duplicate",
          "patch-diff-render",
          "workspace-patch-event-render",
          "large-launch-header",
          "prompt-layout",
          "prompt-redraw-fast-path",
          "committed-user-no-cwd-footer",
          "cli-i18n",
          "user-prompt-label",
          "escape-policy",
          "live-input-status-layout",
          "agent-response-gutter",
          "aginti-md",
          "instructions-command",
          "auxiliary-command-spelling",
          "skills-command",
          "review-command",
          "scs-command-toggle",
          "resume-command-options",
          "slash-prefix-autoselect",
          "slash-prefix-canonical-history",
          "instructions-chat-edit",
          "interactive-chat",
          "mock-file-write",
          "run-status",
          "resume-latest",
          "resume-history-metadata",
          "resume-history-prompt-labels",
          "resume-history-full",
        ],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
