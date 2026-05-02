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
  formatWorkspaceChange,
  stripMarkdown,
} from "../src/interactive-cli.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-cli-chat-"));
const binPath = path.join(repoRoot, "bin/aginti-cli.js");

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
  const renderedMarkdown = stripMarkdown(
    [
      "**Docker status**",
      "",
      "| Check | Result |",
      "| --- | --- |",
      "| `/.dockerenv` | **Present** |",
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

  const promptLayout = buildPromptLayout(`${"x".repeat(180)}\nsecond line`, 95, 80, 24);
  const promptText = promptLayout.renderedRows
    .map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))
    .join("\n");
  if (!promptText.includes("user>")) {
    throw new Error("terminal prompt layout did not render the user> label");
  }
  if (!promptText.includes("user>   ")) {
    throw new Error("terminal prompt layout did not pad user> to the aginti> label width");
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
    !paddedRows[1].includes("user>   hello") ||
    paddedRows[2].trim() !== "" ||
    !paddedRows[3].includes("cwd     /tmp/aginti-project")
  ) {
    throw new Error("terminal prompt layout did not render visual-only input padding safely");
  }
  const committedUserText = formatCommittedUserPromptLines("list files", 90)
    .map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))
    .join("\n");
  if (!committedUserText.includes("user>   list files") || committedUserText.includes("cwd")) {
    throw new Error("committed user history should not include the live cwd footer");
  }
  const zhPromptLayout = buildPromptLayout("", 0, 90, 24, { language: "zh-Hans", commandCwd: "/tmp/aginti-project" });
  const zhPromptText = zhPromptLayout.renderedRows.map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")).join("\n");
  if (!zhPromptText.includes("输入任务")) {
    throw new Error("terminal prompt layout did not localize the empty input hint");
  }
  const jaLaunchHeader = buildLaunchHeaderLines({ width: 120, packageVersion: "0.0.0", animated: false, language: "ja" }).join("\n");
  if (!jaLaunchHeader.includes("Web ファースト")) {
    throw new Error("launch header did not localize by language option");
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
  if (!hintText.includes("user>   /mo") || !hintText.includes("hint    /models  >/model")) {
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
  if (
    canonicalSlashPromptBuffer("/ve") !== "/venice" ||
    canonicalSlashPromptBuffer("/v") !== "/venice" ||
    canonicalSlashPromptBuffer("/not-a-command") !== "/not-a-command" ||
    canonicalSlashPromptBuffer("/venice off") !== "/venice off"
  ) {
    throw new Error("slash command prompt canonicalization did not preserve final submitted command correctly");
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
  if (!helpResult.stdout.includes("/auxiliary") || helpResult.stdout.includes(misspelledAuxiliary)) {
    throw new Error("interactive help did not expose only the correctly spelled /auxiliary command");
  }
  const zhHelpResult = await runCli(["chat", "--language", "zh-Hans"], "/help\n/exit\n");
  if (!zhHelpResult.stdout.includes("命令:") || !zhHelpResult.stdout.includes("输入普通任务")) {
    throw new Error("interactive --language zh-Hans did not localize CLI help");
  }
  const skillsResult = await runChat("/skills website\n/exit\n");
  if (!skillsResult.stdout.includes("website-app") || !skillsResult.stdout.includes("Website And App Builder")) {
    throw new Error("interactive /skills did not show matching built-in skills");
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
  if (!latest.stdout.includes("user>") || !latest.stdout.includes("aginti>")) {
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
