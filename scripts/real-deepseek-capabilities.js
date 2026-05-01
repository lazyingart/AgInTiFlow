#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { buildCapabilityReport } from "../src/capabilities.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { initProject, listProjectSessions, providerKeyStatus, showProjectSession } from "../src/project.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const projectRoot = path.resolve(process.env.AGINTIFLOW_REAL_WORKSPACE || "/home/lachlan/ProjectsLFS/aginti-test");
const webBaseUrl = String(process.env.AGINTIFLOW_REAL_WEB_BASE_URL || "").replace(/\/$/, "");
const enabled = process.env.AGINTIFLOW_REAL_DEEPSEEK === "1";
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
function isJavaScriptTest(file) {
  const base = path.basename(file);
  return /^(test|.+\.(test|spec))\.[mc]?js$/.test(base) || (file.includes("/test/") && /\.[mc]?js$/.test(base));
}

function selectedCases() {
  const raw = process.env.AGINTIFLOW_REAL_CASES || "flash,pro,latex,website,maintenance,aaps";
  return new Set(raw.split(",").map((item) => item.trim()).filter(Boolean));
}

function baseConfig(goal, overrides = {}) {
  return resolveRuntimeConfig(
    {
      provider: "deepseek",
      routingMode: overrides.routingMode || "smart",
      model: overrides.model || "",
      goal,
      commandCwd: projectRoot,
      maxSteps: overrides.maxSteps || 12,
      sandboxMode: overrides.sandboxMode || "host",
      packageInstallPolicy: overrides.packageInstallPolicy || "block",
      allowShellTool: overrides.allowShellTool ?? true,
      allowFileTools: true,
      taskProfile: overrides.taskProfile || "auto",
      resume: overrides.resume || "",
      sessionId: overrides.sessionId || "",
    },
    {
      baseDir: projectRoot,
      packageDir: repoRoot,
      provider: "deepseek",
      routingMode: overrides.routingMode || "smart",
      model: overrides.model || "",
      commandCwd: projectRoot,
      maxSteps: overrides.maxSteps || 12,
      sandboxMode: overrides.sandboxMode || "host",
      packageInstallPolicy: overrides.packageInstallPolicy || "block",
      allowShellTool: overrides.allowShellTool ?? true,
      allowFileTools: true,
      taskProfile: overrides.taskProfile || "auto",
      resume: overrides.resume || "",
      sessionId: overrides.resume ? "" : overrides.sessionId,
    }
  );
}

async function runCliCase(name, goal, overrides = {}) {
  const config = baseConfig(goal, {
    ...overrides,
    sessionId: overrides.sessionId || `round9-${name}-${stamp}`,
  });
  const startedAt = new Date().toISOString();
  const result = await runAgent(config);
  const sessionId = result.sessionId || config.sessionId || config.resume;
  const session = await showProjectSession(projectRoot, sessionId).catch(() => null);
  return {
    name,
    channel: "cli",
    sessionId,
    provider: config.provider,
    model: config.model,
    routingMode: config.routingMode,
    taskProfile: config.taskProfile,
    startedAt,
    result: result.result || "",
    stopped: Boolean(result.stopped),
    events: session?.events?.length || 0,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} failed ${response.status}: ${data.error || response.statusText}`);
  return data;
}

async function waitForWebRun(sessionId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const run = await fetchJson(`${webBaseUrl}/api/runs/${encodeURIComponent(sessionId)}`);
    if (run.status === "finished" || run.status === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Web run timed out: ${sessionId}`);
}

async function runWebCase(name, goal, overrides = {}) {
  if (!webBaseUrl) return null;
  const started = await fetchJson(`${webBaseUrl}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "deepseek",
      routingMode: overrides.routingMode || "smart",
      model: overrides.model || "",
      goal,
      commandCwd: projectRoot,
      sandboxMode: overrides.sandboxMode || "host",
      packageInstallPolicy: overrides.packageInstallPolicy || "block",
      allowShellTool: overrides.allowShellTool ?? true,
      allowFileTools: true,
      maxSteps: overrides.maxSteps || 12,
      taskProfile: overrides.taskProfile || "auto",
      headless: true,
    }),
  });
  const run = await waitForWebRun(started.sessionId);
  return {
    name,
    channel: "web",
    sessionId: started.sessionId,
    provider: run.provider,
    model: run.model,
    status: run.status,
    result: run.result || "",
    error: run.error || "",
  };
}

async function assertFile(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  const stat = await fs.stat(absolutePath).catch(() => null);
  return {
    path: relativePath,
    exists: Boolean(stat),
    size: stat?.size || 0,
  };
}

async function listFilesRecursive(relativeDir) {
  const root = path.join(projectRoot, relativeDir);
  const entries = [];
  async function visit(currentAbs, currentRel) {
    const children = await fs.readdir(currentAbs, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const childAbs = path.join(currentAbs, child.name);
      const childRel = path.posix.join(currentRel.split(path.sep).join(path.posix.sep), child.name);
      if (child.isDirectory()) await visit(childAbs, childRel);
      else if (child.isFile()) entries.push(childRel);
    }
  }
  await visit(root, relativeDir);
  return entries;
}

async function runLocalCheck(command, args, cwdRel = ".") {
  try {
    const result = await execFileAsync(command, args, {
      cwd: path.join(projectRoot, cwdRel),
      timeout: 90000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_loglevel: "warn",
      },
    });
    return {
      ok: true,
      command: [command, ...args].join(" "),
      stdout: String(result.stdout || "").slice(0, 1600),
      stderr: String(result.stderr || "").slice(0, 1600),
    };
  } catch (error) {
    return {
      ok: false,
      command: [command, ...args].join(" "),
      stdout: String(error.stdout || "").slice(0, 1600),
      stderr: String(error.stderr || error.message || "").slice(0, 1600),
    };
  }
}

function addCheck(report, name, ok, details = {}) {
  report.checks.push({ name, ok: Boolean(ok), ...details });
  if (!ok) report.ok = false;
}

function addStoppedWarning(report, run) {
  if (run?.stopped) {
    report.warnings.push(`${run.name} reached max steps before finish(); artifacts were validated separately.`);
  }
}

if (!enabled) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        skipped: true,
        reason: "Set AGINTIFLOW_REAL_DEEPSEEK=1 to run live DeepSeek capability checks.",
      },
      null,
      2
    )
  );
  process.exit(0);
}

await initProject(projectRoot);
const keyStatus = providerKeyStatus(projectRoot);
if (!keyStatus.deepseek) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        skipped: true,
        reason: "DeepSeek key is not available by env or project-local .aginti/.env.",
      },
      null,
      2
    )
  );
  process.exit(0);
}

const cases = selectedCases();
const appDir = `round9/deepseek-app-${stamp}`;
const report = {
  ok: true,
  projectRoot,
  webBaseUrl: webBaseUrl || "",
  stamp,
  capabilities: await buildCapabilityReport(
    projectRoot,
    packageJson.version,
    baseConfig("capability report", { allowShellTool: true, allowFileTools: true })
  ),
  runs: [],
  files: [],
  checks: [],
  warnings: [],
};

if (cases.has("flash")) {
  const run = await runCliCase(
    "flash-node-app",
    `Create a small dependency-free Node and HTML app with tests under ${appDir}. Run safe checks if you can.`,
    { routingMode: "fast", taskProfile: "node", maxSteps: 24 }
  );
  report.runs.push(run);
  addStoppedWarning(report, run);
  const files = await listFilesRecursive(appDir);
  const testFile = files.find(isJavaScriptTest);
  const appHasCode = files.some((file) => /\.(js|mjs)$/.test(file));
  const appHasHtml = files.some((file) => /\.html$/.test(file));
  const testResult = testFile ? await runLocalCheck("node", ["--test", testFile]) : { ok: false, command: "node --test <missing>" };
  report.files.push(await assertFile(testFile || `${appDir}/test/app.test.js`));
  addCheck(report, "flash-node-app-files", appHasCode && appHasHtml && Boolean(testFile), { files });
  addCheck(report, "flash-node-app-tests", testResult.ok, testResult);
}

if (cases.has("pro")) {
  const previous = report.runs.find((run) => run.name === "flash-node-app");
  const run = await runCliCase(
    "pro-improve-app",
    `Improve the app in ${appDir} with a useful new feature and matching tests. Run safe checks if you can.`,
    {
      routingMode: "complex",
      taskProfile: "code",
      maxSteps: 24,
      resume: previous?.sessionId || "",
      sessionId: previous ? "" : `round9-pro-improve-${stamp}`,
    }
  );
  report.runs.push(run);
  addStoppedWarning(report, run);
  const files = await listFilesRecursive(appDir);
  const testFile = files.find(isJavaScriptTest);
  const testResult = testFile ? await runLocalCheck("node", ["--test", testFile]) : { ok: false, command: "node --test <missing>" };
  addCheck(report, "pro-improve-app-tests", testResult.ok, testResult);
}

if (cases.has("latex")) {
  const texDir = `round9/latex-${stamp}`;
  const run = await runCliCase(
    "latex-report",
    `Write a small LaTeX note under ${texDir} about AgInTiFlow capability testing. Compile it if TeX is available; otherwise create an honest setup note.`,
    { routingMode: "complex", taskProfile: "latex", maxSteps: 16 }
  );
  report.runs.push(run);
  addStoppedWarning(report, run);
  const files = await listFilesRecursive(texDir);
  report.files.push(await assertFile(files.find((file) => file.endsWith(".tex")) || `${texDir}/note.tex`));
  addCheck(report, "latex-source", files.some((file) => file.endsWith(".tex")), { files });
  addCheck(report, "latex-pdf-or-setup", files.some((file) => file.endsWith(".pdf") || /setup|readme/i.test(file)), { files });
}

if (cases.has("website")) {
  const websiteDir = `round9/website-test-${stamp}`;
  const run = await runCliCase(
    "website-test",
    `Create a small website under ${websiteDir} with a simple local test or check file. Run safe checks if you can without installing packages.`,
    { routingMode: "fast", taskProfile: "website", maxSteps: 24 }
  );
  report.runs.push(run);
  addStoppedWarning(report, run);
  const files = await listFilesRecursive(websiteDir);
  const nodeTest = files.find(isJavaScriptTest);
  const pythonTest = files.find((file) => /(^|\/)(test_.*|.*_test)\.py$/.test(path.basename(file)));
  const shellTest = files.find((file) => /^test[-_\w]*\.sh$/.test(path.basename(file)));
  const testResult = nodeTest
    ? await runLocalCheck("node", ["--test", nodeTest])
    : pythonTest
      ? await runLocalCheck("python3", [pythonTest])
      : shellTest
        ? await runLocalCheck("bash", ["-n", shellTest])
        : { ok: false, command: "<missing website test>" };
  report.files.push(await assertFile(nodeTest || pythonTest || shellTest || `${websiteDir}/test/website.test.js`));
  addCheck(report, "website-test-files", files.some((file) => file.endsWith(".html")) && Boolean(nodeTest || pythonTest || shellTest), { files });
  addCheck(report, "website-test-runs", testResult.ok, testResult);
}

if (cases.has("maintenance")) {
  const maintenanceDir = `maintenance/round9-${stamp}`;
  const run = await runCliCase(
    "maintenance-plan",
    `Create project-local dry-run maintenance plans and scripts under ${maintenanceDir} for Miniforge/conda, R, Python tooling, CmdStan/CmdStanR, and PyStan. Validate scripts safely if you can.`,
    {
      routingMode: "complex",
      taskProfile: "maintenance",
      sandboxMode: "docker-workspace",
      packageInstallPolicy: "block",
      maxSteps: 24,
    }
  );
  report.runs.push(run);
  addStoppedWarning(report, run);
  const files = await listFilesRecursive(maintenanceDir);
  const shellScripts = files.filter((file) => file.endsWith(".sh"));
  const syntaxResults = [];
  for (const script of shellScripts) syntaxResults.push(await runLocalCheck("bash", ["-n", script]));
  report.files.push(await assertFile(files.find((file) => /\.md$/i.test(file)) || `${maintenanceDir}/README.md`));
  addCheck(report, "maintenance-plan-files", files.some((file) => /\.md$/i.test(file)) && shellScripts.length > 0, { files });
  addCheck(report, "maintenance-shell-syntax", syntaxResults.every((item) => item.ok), { syntaxResults });
}

if (cases.has("aaps")) {
  const run = await runCliCase(
    "aaps-sample",
    "Create a small project-local AAPS sample and notes for @lazyingart/aaps workflows.",
    { routingMode: "fast", taskProfile: "aaps", maxSteps: 14 }
  );
  report.runs.push(run);
  addStoppedWarning(report, run);
  const files = [
    ...(await listFilesRecursive(".aaps")),
    ...(await listFilesRecursive("aaps-sample")),
  ];
  const aapsFile = files.find((file) => file.includes(".aaps/") || file.endsWith(".aaps") || file.endsWith(".json"));
  report.files.push(await assertFile(aapsFile || ".aaps/round9-sample.json"));
  addCheck(report, "aaps-sample-files", Boolean(aapsFile), { files });
}

if (webBaseUrl) {
  const run = await runWebCase(
    "web-sync-real",
    `Create notes/web-real-${stamp}.md with a short note that this web run shares the project session folder.`,
    { routingMode: "fast", taskProfile: "code", maxSteps: 10 }
  );
  report.runs.push(run);
  report.files.push(await assertFile(`notes/web-real-${stamp}.md`));
  addCheck(report, "web-sync-file", (await assertFile(`notes/web-real-${stamp}.md`)).exists, {
    sessionId: run?.sessionId,
    status: run?.status,
  });
}

report.sessions = await listProjectSessions(projectRoot, 20);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
