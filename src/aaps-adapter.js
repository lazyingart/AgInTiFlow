import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  ".git",
  ".aginti",
  ".aginti-sessions",
  ".agintiflow",
  ".aaps-work",
  ".sessions",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "runtime",
  "target",
  "vendor",
  "__pycache__",
]);

const DEFAULT_TIMEOUT_MS = 45_000;
const LONG_TIMEOUT_MS = 120_000;
const JSON_ACTIONS = new Set(["parse", "validate", "compile", "compile-project", "missing", "prepare-setup", "plan", "check", "run"]);
const ACTIONS_REQUIRING_FILE = new Set(["plan", "check", "run", "dry-run"]);
const ALLOWED_ACTIONS = new Set([
  "status",
  "files",
  "init",
  "install",
  "parse",
  "validate",
  "compile",
  "compile-project",
  "missing",
  "prepare-setup",
  "plan",
  "check",
  "run",
  "dry-run",
  "studio",
  "help",
]);
const COMPILE_MODES = new Set(["check", "suggest", "apply", "interactive", "force"]);

function toProjectPath(value = "") {
  return String(value || "").split(path.sep).join("/");
}

function safeRelative(projectDir, value, label = "path", { allowEmpty = false } = {}) {
  const text = String(value || "").trim();
  if (!text) {
    if (allowEmpty) return "";
    throw new Error(`${label} is required.`);
  }
  if (text.includes("\0")) throw new Error(`${label} contains an invalid NUL byte.`);
  const normalized = path.normalize(text);
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must be project-relative: ${value}`);
  }
  const resolved = path.resolve(projectDir, normalized);
  const relative = path.relative(projectDir, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes project root: ${value}`);
  }
  return toProjectPath(relative);
}

function maybeStat(file) {
  try {
    return fsSync.statSync(file);
  } catch {
    return null;
  }
}

function isExecutableFile(file) {
  const stat = maybeStat(file);
  return Boolean(stat?.isFile());
}

async function commandExists(command) {
  try {
    await execFileAsync("command", ["-v", command], {
      shell: true,
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function devSiblingAapsScript(packageDir = "") {
  const candidates = [
    path.resolve(packageDir || process.cwd(), "..", "..", "AAPS", "scripts", "aaps.js"),
    path.resolve(process.cwd(), "..", "AAPS", "scripts", "aaps.js"),
    "/home/lachlan/ProjectsLFS/AAPS/scripts/aaps.js",
  ];
  return candidates.find((candidate) => isExecutableFile(candidate)) || "";
}

function envAapsCandidate() {
  const value = String(process.env.AAPS_BIN || process.env.AGINTI_AAPS_BIN || "").trim();
  if (!value) return null;
  if (value.includes("/") || value.includes(path.sep)) {
    const resolved = path.resolve(value);
    if (!isExecutableFile(resolved)) {
      return {
        ok: false,
        error: `Configured AAPS_BIN does not exist or is not a file: ${resolved}`,
      };
    }
    if (path.basename(resolved) === "aaps.js") {
      return {
        ok: true,
        candidate: {
          source: "env",
          label: resolved,
          command: process.execPath,
          prefixArgs: [resolved],
        },
      };
    }
    return {
      ok: true,
      candidate: {
        source: "env",
        label: resolved,
        command: resolved,
        prefixArgs: [],
      },
    };
  }
  return {
    ok: true,
    candidate: {
      source: "env",
      label: value,
      command: value,
      prefixArgs: [],
    },
  };
}

export async function discoverAaps({ cwd = process.cwd(), packageDir = "", allowNpx = false } = {}) {
  const projectDir = path.resolve(cwd || process.cwd());
  const envCandidate = envAapsCandidate();
  if (envCandidate?.ok === false) {
    return {
      found: false,
      projectDir,
      source: "env",
      error: envCandidate.error,
      checked: [envCandidate.error],
    };
  }
  if (envCandidate?.candidate) {
    return { found: true, projectDir, ...envCandidate.candidate, checked: ["AAPS_BIN"] };
  }

  const checked = [];
  const localBin = path.join(projectDir, "node_modules", ".bin", process.platform === "win32" ? "aaps.cmd" : "aaps");
  checked.push(localBin);
  if (isExecutableFile(localBin)) {
    return {
      found: true,
      projectDir,
      source: "project",
      label: localBin,
      command: localBin,
      prefixArgs: [],
      checked,
    };
  }

  if (await commandExists("aaps")) {
    checked.push("PATH:aaps");
    return {
      found: true,
      projectDir,
      source: "path",
      label: "aaps",
      command: "aaps",
      prefixArgs: [],
      checked,
    };
  }
  checked.push("PATH:aaps");

  const devScript = process.env.AGINTIFLOW_DEV_AAPS === "0" ? "" : devSiblingAapsScript(packageDir);
  if (devScript) {
    checked.push(devScript);
    return {
      found: true,
      projectDir,
      source: "dev-sibling",
      label: devScript,
      command: process.execPath,
      prefixArgs: [devScript],
      checked,
    };
  }

  if (allowNpx) {
    checked.push("npx -y @lazyingart/aaps");
    return {
      found: true,
      projectDir,
      source: "npx",
      label: "npx -y @lazyingart/aaps",
      command: "npx",
      prefixArgs: ["-y", "@lazyingart/aaps"],
      checked,
    };
  }

  return {
    found: false,
    projectDir,
    source: "",
    label: "",
    command: "",
    prefixArgs: [],
    checked,
    error: "AAPS was not found. Run `aginti aaps install`, `npm install -g @lazyingart/aaps`, or set AAPS_BIN.",
  };
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function walkAapsFiles(dir, root, files, { limit = 200, depth = 0 } = {}) {
  if (files.length >= limit || depth > 12) return;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= limit) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walkAapsFiles(full, root, files, { limit, depth: depth + 1 });
    } else if (entry.isFile() && entry.name.endsWith(".aaps")) {
      files.push(toProjectPath(path.relative(root, full)));
    }
  }
}

export async function listAapsFiles({ cwd = process.cwd(), limit = 200 } = {}) {
  const projectDir = path.resolve(cwd || process.cwd());
  const files = [];
  await walkAapsFiles(projectDir, projectDir, files, { limit });
  return files.sort();
}

export async function readAapsManifest({ cwd = process.cwd() } = {}) {
  const projectDir = path.resolve(cwd || process.cwd());
  const manifestPath = path.join(projectDir, "aaps.project.json");
  const manifest = await readJsonIfExists(manifestPath);
  if (!manifest) return null;
  return {
    ...manifest,
    path: "aaps.project.json",
    activeFile: typeof manifest.activeFile === "string" ? manifest.activeFile : "",
    defaultMain: typeof manifest.defaultMain === "string" ? manifest.defaultMain : "",
  };
}

export async function resolveAapsEntry({ cwd = process.cwd(), file = "" } = {}) {
  const projectDir = path.resolve(cwd || process.cwd());
  const manifest = await readAapsManifest({ cwd: projectDir });
  const candidate = String(file || manifest?.activeFile || manifest?.defaultMain || "").trim();
  if (!candidate) return "";
  return safeRelative(projectDir, candidate, "AAPS file");
}

async function inferAapsPackage(discovery) {
  if (!discovery?.found) return null;
  const script = discovery.prefixArgs?.[0] || "";
  if (!script || path.basename(script) !== "aaps.js") return null;
  const pkg = await readJsonIfExists(path.resolve(path.dirname(script), "..", "package.json"));
  if (!pkg) return null;
  return {
    name: pkg.name || "@lazyingart/aaps",
    version: pkg.version || "",
    path: path.resolve(path.dirname(script), "..", "package.json"),
  };
}

export async function aapsStatus({ cwd = process.cwd(), packageDir = "" } = {}) {
  const projectDir = path.resolve(cwd || process.cwd());
  const [discovery, files, manifest] = await Promise.all([
    discoverAaps({ cwd: projectDir, packageDir }),
    listAapsFiles({ cwd: projectDir }),
    readAapsManifest({ cwd: projectDir }),
  ]);
  const pkg = await inferAapsPackage(discovery);
  const entry = await resolveAapsEntry({ cwd: projectDir }).catch(() => "");
  return {
    ok: true,
    projectDir,
    found: discovery.found,
    source: discovery.source || "",
    command: discovery.label || "",
    error: discovery.error || "",
    checked: discovery.checked || [],
    package: pkg,
    manifest: manifest
      ? {
          name: manifest.name || path.basename(projectDir),
          path: manifest.path,
          activeFile: manifest.activeFile || "",
          defaultMain: manifest.defaultMain || "",
        }
      : null,
    entry,
    files,
  };
}

function splitCommandLine(value = "") {
  return String(value || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAction(action = "") {
  const value = String(action || "status").trim().toLowerCase();
  if (value === "on" || value === "auto") return value;
  if (value === "ls" || value === "list") return "files";
  if (value === "dryrun") return "dry-run";
  if (value === "compile-project") return "compile-project";
  return value || "status";
}

function extractMode(args = []) {
  let mode = "";
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--mode") {
      mode = String(args[index + 1] || "");
      index += 1;
      continue;
    }
    if (String(item || "").startsWith("--mode=")) {
      mode = String(item).slice("--mode=".length);
      continue;
    }
    if (!mode && COMPILE_MODES.has(String(item || "").toLowerCase())) {
      mode = String(item).toLowerCase();
      continue;
    }
    rest.push(item);
  }
  return { mode: mode || "check", rest };
}

function buildAapsArgs(action, args = [], { cwd = process.cwd() } = {}) {
  const projectDir = path.resolve(cwd || process.cwd());
  const normalized = normalizeAction(action);
  if (!ALLOWED_ACTIONS.has(normalized)) {
    throw new Error(`Unknown AAPS action: ${action}. Use status, files, init, parse, validate, compile, check, run, dry-run, or studio.`);
  }
  if (normalized === "help") return { action: normalized, cliArgs: ["help"], timeoutMs: DEFAULT_TIMEOUT_MS };
  if (normalized === "status" || normalized === "files" || normalized === "init" || normalized === "install") {
    return { action: normalized, cliArgs: [], timeoutMs: DEFAULT_TIMEOUT_MS };
  }
  if (normalized === "studio") {
    const allowed = [];
    for (let index = 0; index < args.length; index += 1) {
      const item = args[index];
      if (["--host", "--port"].includes(item)) {
        allowed.push(item, String(args[index + 1] || ""));
        index += 1;
      } else if (item === "--mock-codex") {
        allowed.push(item);
      } else if (/^\d+$/.test(String(item || ""))) {
        allowed.push("--port", String(item));
      } else {
        throw new Error(`Unsupported AAPS studio argument: ${item}`);
      }
    }
    return { action: normalized, cliArgs: ["studio", ...allowed], timeoutMs: LONG_TIMEOUT_MS };
  }

  const { mode, rest } = normalized === "compile" || normalized === "compile-project" ? extractMode(args) : { mode: "", rest: args };
  if (mode && !COMPILE_MODES.has(mode)) throw new Error(`Invalid AAPS compile mode: ${mode}`);
  const fileArg = rest.find((item) => !String(item || "").startsWith("--")) || "";
  const file = fileArg ? safeRelative(projectDir, fileArg, "AAPS file") : "";
  const cliArgs = [];
  if (normalized === "dry-run") cliArgs.push("run");
  else cliArgs.push(normalized);
  if (file) cliArgs.push(file);
  if (ACTIONS_REQUIRING_FILE.has(normalized) && !file) {
    throw new Error(`AAPS ${normalized} needs a .aaps file or activeFile/defaultMain in aaps.project.json.`);
  }
  cliArgs.push("--project", ".");
  if (normalized === "compile") cliArgs.push("--mode", mode || "check");
  if (normalized === "compile-project") cliArgs.push("--mode", mode || "check");
  if (normalized === "dry-run") cliArgs.push("--dry-run");
  if (JSON_ACTIONS.has(normalized === "dry-run" ? "run" : normalized)) cliArgs.push("--json");
  return { action: normalized, cliArgs, timeoutMs: normalized === "run" || normalized === "dry-run" ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS };
}

function parseJsonMaybe(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function compactOutput(value = "", limit = 12_000) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n... [truncated ${text.length - limit} chars]`;
}

async function runDiscoveredAaps(discovery, cliArgs, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const fullArgs = [...(discovery.prefixArgs || []), ...cliArgs];
  try {
    const result = await execFileAsync(discovery.command, fullArgs, {
      cwd: discovery.projectDir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        AAPS_PROJECT_ROOT: discovery.projectDir,
      },
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: compactOutput(result.stdout || ""),
      stderr: compactOutput(result.stderr || ""),
      json: parseJsonMaybe(result.stdout || ""),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: compactOutput(error?.stdout || ""),
      stderr: compactOutput(error?.stderr || error?.message || String(error)),
      json: parseJsonMaybe(error?.stdout || ""),
    };
  }
}

function relativeIfInside(root, value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const resolved = path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return toProjectPath(relative);
}

async function annotateAapsRunResult(result, { action = "", projectDir = "" } = {}) {
  if (!["run", "dry-run"].includes(action) || !result?.json || typeof result.json !== "object") return result;
  const json = result.json;
  const warnings = [];
  const plan = json.plan || {};
  const promptOnlySteps = Number(plan.promptOnlySteps || 0);
  const executableSteps = Number(plan.executableSteps || 0);
  if (promptOnlySteps > 0) {
    warnings.push(
      `workflow has ${promptOnlySteps} prompt-only step(s); AAPS recorded a handoff but did not execute an LLM/backend agent for those steps`
    );
  }
  if (promptOnlySteps > 0 && executableSteps === 0) {
    warnings.push("workflow has no executable steps; use AgInTiFlow to act on the prompt-only handoff or add executable AAPS actions");
  }

  const missingDeclaredOutputs = [];
  if (action === "run" && !json.dryRun) {
    const outputEntries = Array.isArray(json.outputs)
      ? json.outputs
      : Array.isArray(json.executionPlan?.outputs)
        ? json.executionPlan.outputs
        : [];
    const runDir = String(json.runDir || "").trim();
    const executionPlanPath = runDir ? path.join(runDir, "execution_plan.json") : "";
    let executionPlan = null;
    if (executionPlanPath && relativeIfInside(projectDir, executionPlanPath)) {
      executionPlan = await readJsonIfExists(executionPlanPath);
    }
    const outputs = outputEntries.length ? outputEntries : Array.isArray(executionPlan?.outputs) ? executionPlan.outputs : [];
    for (const output of outputs) {
      const rawPath = typeof output === "string" ? output : output?.value || output?.path || "";
      const rel = relativeIfInside(projectDir, rawPath);
      if (!rel) continue;
      if (!fsSync.existsSync(path.join(projectDir, rel))) missingDeclaredOutputs.push(rel);
    }
    if (missingDeclaredOutputs.length > 0) {
      warnings.push(`declared output(s) not present after run: ${missingDeclaredOutputs.join(", ")}`);
    }
  }

  return {
    ...result,
    warnings,
    promptOnlySteps,
    executableSteps,
    missingDeclaredOutputs,
  };
}

async function createAapsStarterProject({ cwd = process.cwd(), name = "" } = {}) {
  const projectDir = path.resolve(cwd || process.cwd());
  const projectName = String(name || path.basename(projectDir) || "AgInTiFlow AAPS Project").trim();
  const workflowDir = path.join(projectDir, "workflows");
  const agentsDir = path.join(projectDir, "agents");
  const reportsDir = path.join(projectDir, "reports");
  const runsDir = path.join(projectDir, "runs");
  const artifactsDir = path.join(projectDir, "artifacts");
  await Promise.all([
    fs.mkdir(workflowDir, { recursive: true }),
    fs.mkdir(agentsDir, { recursive: true }),
    fs.mkdir(reportsDir, { recursive: true }),
    fs.mkdir(runsDir, { recursive: true }),
    fs.mkdir(artifactsDir, { recursive: true }),
  ]);

  const manifestPath = path.join(projectDir, "aaps.project.json");
  const workflowPath = path.join(workflowDir, "main.aaps");
  const agentRegistryPath = path.join(agentsDir, "agent_registry.json");
  const created = [];
  if (!fsSync.existsSync(manifestPath)) {
    const now = new Date().toISOString();
    const manifest = {
      schema: "aaps_project/0.1",
      name: projectName,
      path: ".",
      description: "Project-local AAPS workflows for large agentic tasks.",
      domain: "agentic-workflows",
      tags: ["agintiflow", "aaps"],
      defaultMain: "workflows/main.aaps",
      activeFile: "workflows/main.aaps",
      created: now,
      updated: now,
      paths: {
        workflows: "workflows",
        agents: "agents",
        blocks: "blocks",
        skills: "skills",
        modules: "modules",
        subworkflows: "workflows",
        data: "data",
        artifacts: "artifacts",
        runs: "runs",
        reports: "reports",
        notes: "notes",
      },
      artifactRoot: "artifacts",
      runDatabase: "runs/aaps-runs.jsonl",
      tools: ["node", "python3", "git", "aginti"],
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      agents: ["planner"],
      files: {
        workflows: ["workflows/main.aaps"],
        blocks: [],
        skills: [],
        modules: [],
        subworkflows: [],
        drafts: [],
        archives: [],
        references: [],
      },
      notes: ["Keep all AAPS paths project-relative.", "Use `aginti aaps validate` before running long workflows."],
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    created.push("aaps.project.json");
  }
  if (!fsSync.existsSync(agentRegistryPath)) {
    const registry = {
      agents: [
        {
          name: "planner",
          purpose: "Plan large project work in small, verifiable phases for the starter AAPS workflow.",
          invocation: "prompt",
          supportedTasks: ["planning", "workflow_planning", "compile_prompt"],
          safety: ["project-local edits only", "ask before risky shell commands", "no secrets in logs"],
          fallback: "prepare prompt-only handoff",
        },
      ],
    };
    await fs.writeFile(agentRegistryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    created.push("agents/agent_registry.json");
  }
  if (!fsSync.existsSync(workflowPath)) {
    const source = `pipeline "${projectName} Starter" {
  subtitle "A project-local AAPS workflow for AgInTiFlow"
  version "0.2"
  domain "agentic-workflows"
  tags "agintiflow, aaps, starter"
  artifact_dir "artifacts"
  database "runs/aaps-runs.jsonl"
  goal "Turn a high-level request into planned, checked, durable project work."
  output plan: markdown = "reports/aaps-plan.md"

  agent planner {
    role "Plan project work in small, verifiable phases."
    model "deepseek-v4-pro"
    tools "filesystem, shell, git, aginti"
  }

  task draft_plan {
    uses planner
    prompt """
Inspect this project and produce a concise phased plan with acceptance checks.
Keep paths project-relative and avoid secrets.
"""
    output plan: markdown = "reports/aaps-plan.md"
    verify "The plan names concrete files, commands, risks, and acceptance checks."
  }
}
`;
    await fs.writeFile(workflowPath, source, "utf8");
    created.push("workflows/main.aaps");
  }
  return {
    ok: true,
    projectDir,
    created,
    manifest: "aaps.project.json",
    entry: "workflows/main.aaps",
  };
}

async function installAaps({ cwd = process.cwd(), scope = "" } = {}) {
  const projectDir = path.resolve(cwd || process.cwd());
  const normalizedScope = String(scope || "").trim().toLowerCase();
  const hasPackageJson = fsSync.existsSync(path.join(projectDir, "package.json"));
  if (!hasPackageJson && normalizedScope !== "global") {
    return {
      ok: false,
      command: "",
      stdout: "",
      stderr:
        "No package.json found for a project-local install. Run `npm init -y` first, or explicitly use `aginti aaps install global` / `npm install -g @lazyingart/aaps`.",
    };
  }
  const args =
    normalizedScope === "global"
      ? ["install", "-g", "@lazyingart/aaps"]
      : ["install", "--save-dev", "@lazyingart/aaps"];
  try {
    const result = await execFileAsync("npm", args, {
      cwd: projectDir,
      timeout: LONG_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: true,
      command: `npm ${args.join(" ")}`,
      stdout: compactOutput(result.stdout || "", 8000),
      stderr: compactOutput(result.stderr || "", 8000),
    };
  } catch (error) {
    return {
      ok: false,
      command: `npm ${args.join(" ")}`,
      stdout: compactOutput(error?.stdout || "", 8000),
      stderr: compactOutput(error?.stderr || error?.message || String(error), 8000),
    };
  }
}

export async function runAapsAction(action = "status", rawArgs = [], { cwd = process.cwd(), packageDir = "" } = {}) {
  const projectDir = path.resolve(cwd || process.cwd());
  const args = Array.isArray(rawArgs) ? rawArgs.map(String).filter(Boolean) : splitCommandLine(rawArgs);
  const normalized = normalizeAction(action);

  if (normalized === "status") return await aapsStatus({ cwd: projectDir, packageDir });
  if (normalized === "files") {
    const files = await listAapsFiles({ cwd: projectDir });
    const manifest = await readAapsManifest({ cwd: projectDir });
    return { ok: true, action: "files", projectDir, manifest, files };
  }
  if (normalized === "init") return await createAapsStarterProject({ cwd: projectDir, name: args.join(" ") });
  if (normalized === "install") return await installAaps({ cwd: projectDir, scope: args[0] || "" });

  const discovery = await discoverAaps({ cwd: projectDir, packageDir });
  if (!discovery.found) {
    return {
      ok: false,
      action: normalized,
      projectDir,
      error: discovery.error,
      checked: discovery.checked || [],
    };
  }

  let commandArgs = args;
  if (["compile", "plan", "check", "run", "dry-run"].includes(normalized)) {
    const rest = normalized === "compile" ? extractMode(args).rest : args;
    const hasExplicitFile = rest.some((item) => !String(item || "").startsWith("--"));
    if (!hasExplicitFile) {
      const entry = await resolveAapsEntry({ cwd: projectDir });
      if (entry) commandArgs = [...args, entry];
    }
  }

  const built = buildAapsArgs(normalized, commandArgs, { cwd: projectDir });
  const result = await runDiscoveredAaps(discovery, built.cliArgs, { timeoutMs: built.timeoutMs });
  const annotated = await annotateAapsRunResult(result, { action: built.action, projectDir });
  return {
    ...annotated,
    action: built.action,
    projectDir,
    source: discovery.source,
    command: [discovery.label, ...built.cliArgs].join(" "),
    cliArgs: built.cliArgs,
  };
}

function summarizeJson(action, json) {
  if (!json || typeof json !== "object") return "";
  if (action === "parse") {
    const pipeline = json.pipeline || {};
    return `pipeline=${pipeline.name || "(unnamed)"} tasks=${pipeline.tasks?.length || 0} agents=${pipeline.agents?.length || 0} diagnostics=${json.diagnostics?.length || 0}`;
  }
  if (action === "validate") {
    return `ok=${Boolean(json.ok)} files=${json.files ?? ""} diagnostics=${json.diagnostics?.length || 0}`;
  }
  if (action === "compile" || action === "compile-project" || action === "missing" || action === "prepare-setup") {
    return `mode=${json.mode || ""} missing=${json.missingComponents?.length || 0} generated=${json.generatedFiles?.length || 0} compileDir=${json.compileDir || ""}`;
  }
  if (action === "check" || action === "plan" || action === "run" || action === "dry-run") {
    const ok = json.ok ?? json.ready ?? "";
    const steps = typeof json.plan?.steps === "number" ? json.plan.steps : (json.plan?.steps?.length ?? json.steps?.length ?? "");
    const executable = json.plan?.executableSteps ?? "";
    const promptOnly = json.plan?.promptOnlySteps ?? "";
    const runDir = json.runDir || json.runRoot || "";
    return [
      `ok=${ok}`,
      steps !== "" ? `steps=${steps}` : "",
      executable !== "" ? `executable=${executable}` : "",
      promptOnly !== "" ? `promptOnly=${promptOnly}` : "",
      runDir ? `runDir=${runDir}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

export function formatAapsResult(result = {}) {
  if (!result || typeof result !== "object") return "AAPS returned no result.";
  if (result.action === "files") {
    const lines = [
      `AAPS files in ${result.projectDir}: ${result.files?.length || 0}`,
      result.manifest ? `manifest=${result.manifest.path || "aaps.project.json"} active=${result.manifest.activeFile || result.manifest.defaultMain || ""}` : "manifest=missing",
      ...(result.files || []).slice(0, 40).map((file) => `- ${file}`),
    ];
    if ((result.files || []).length > 40) lines.push(`... ${(result.files || []).length - 40} more`);
    return lines.join("\n");
  }
  if (result.found !== undefined) {
    return [
      `AAPS adapter: ${result.found ? "available" : "missing"}`,
      `project=${result.projectDir || ""}`,
      result.found ? `source=${result.source} command=${result.command}` : `error=${result.error}`,
      result.package ? `package=${result.package.name}@${result.package.version}` : "",
      result.manifest ? `manifest=${result.manifest.path} active=${result.manifest.activeFile || result.manifest.defaultMain || ""}` : "manifest=missing",
      `files=${result.files?.length || 0}${result.entry ? ` entry=${result.entry}` : ""}`,
      !result.found && result.checked?.length ? `checked=${result.checked.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (result.manifest && result.entry && Array.isArray(result.created)) {
    return [
      `AAPS project initialized in ${result.projectDir}`,
      result.created.length ? `created=${result.created.join(", ")}` : "created=none; existing files preserved",
      `entry=${result.entry}`,
      "Next: /aaps validate or aginti aaps validate",
    ].join("\n");
  }
  if (result.command?.startsWith("npm ")) {
    return [
      `AAPS install ${result.ok ? "completed" : "failed"}`,
      `command=${result.command}`,
      result.stdout ? `stdout\n${result.stdout.trim()}` : "",
      result.stderr ? `stderr\n${result.stderr.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const summary = summarizeJson(result.action, result.json);
  return [
    `AAPS ${result.action || "command"} ${result.ok ? "ok" : "failed"}`,
    result.command ? `command=${result.command}` : "",
    summary ? `summary=${summary}` : "",
    result.warnings?.length ? `warnings\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
    result.stdout ? `stdout\n${result.stdout.trim()}` : "",
    result.stderr ? `stderr\n${result.stderr.trim()}` : "",
    result.error ? `error=${result.error}` : "",
    result.checked?.length ? `checked=${result.checked.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function handleAapsCliCommand(argv = [], { cwd = process.cwd(), packageDir = "" } = {}) {
  const [action = "status", ...args] = argv;
  const result = await runAapsAction(action, args, { cwd, packageDir });
  console.log(formatAapsResult(result));
  if (result.ok === false) process.exitCode = 1;
  return result;
}
