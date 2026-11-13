import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { evaluateCommandPolicy } from "./command-policy.js";
import { redactSensitiveText } from "./redaction.js";
import { dataFields } from "./restricted-application-contract.js";
import { LONG_JOB_METADATA_MAX_BYTES, longJobMetadataError, openLongJobMetadata } from "./long-job-metadata.js";

const execFile = promisify(execFileCallback);
const JOB_NAME_PATTERN = /^[A-Za-z0-9_.+-]{1,80}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9_.+-]{8,140}$/;
const SECRET_PATTERN = /(api[_-]?key|auth[_-]?token|npm[_-]?token|_authToken|password|passwd|secret|bearer\s+[A-Za-z0-9._-]+)/i;
const ABSOLUTE_PATH_PATTERN = /(^|[\s"'`=(:])((?:\/[A-Za-z0-9._@%+~:-]+)+\/?)/g;
const ALWAYS_ALLOWED_ABSOLUTE_PATHS = new Set(["/dev/null"]);
const MAX_COMMAND_BYTES = 12000;
const DEFAULT_POLL_INTERVAL_SECONDS = 60;

export const LONG_JOB_TOOL_NAMES = ["start_long_job", "long_job_status"];

function safeEnv() {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    TERM: process.env.TERM || "xterm-256color",
    SHELL: process.env.SHELL || "/bin/bash",
  };
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function isInsideDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function workspaceRoot(config = {}) {
  return path.resolve(config.commandCwd || process.cwd());
}

function isTrustedWholeHost(config = {}) {
  return config.sandboxMode === "host" && Boolean(config.allowDestructive);
}

function normalizeJobName(raw = "") {
  const value = String(raw || "aginti-long-job")
    .trim()
    .replace(/[^A-Za-z0-9_.+-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return value || "aginti-long-job";
}

function makeJobId(name = "") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${normalizeJobName(name)}-${stamp}-${suffix}`;
}

function tmuxSessionName(jobId = "") {
  const base = `aginti-job-${jobId}`.replace(/[^A-Za-z0-9_.+-]+/g, "-");
  if (base.length <= 80) return base;
  const hash = crypto.createHash("sha1").update(base).digest("hex").slice(0, 10);
  return `${base.slice(0, 68)}-${hash}`;
}

const JOB_METADATA_KEYS = ["jobId", "name", "session", "createdAt", "cwd", "command", "displayCommand",
  "rawCommandSha256", "verifyCommand", "expectedOutputPath", "expectedOutputPathAbs", "expectedSizeBytes",
  "restartOnFailure", "pollIntervalSeconds", "timeoutSeconds", "statusPath", "stdoutPath", "stderrPath", "supervisorLogPath", "note"];
const STATUS_REQUIRED = ["jobId", "name", "state", "createdAt", "updatedAt", "cwd", "session", "command",
  "expectedOutputPath", "expectedSizeBytes", "restartOnFailure", "pollIntervalSeconds", "attempt", "pid",
  "exitCode", "verifyExitCode", "outputBytes", "percent", "reason", "outputExists", "startedAt"];
const STATUS_TIMES = ["heartbeatAt", "restartedAt", "completedAt", "failedAt"];
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const isoTime = value => typeof value === "string" && value.length === 24 &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function exactFields(value, required, optional = []) {
  const fields = dataFields(value, [...required, ...optional], required);
  if (required.some(key => !Object.hasOwn(fields, key))) throw longJobMetadataError();
  return fields;
}
function validJobMetadata(value, jobId, root, config) {
  const job = exactFields(value, JOB_METADATA_KEYS);
  const text = (field, max) => typeof job[field] === "string" && job[field].isWellFormed() && Buffer.byteLength(job[field]) <= max;
  if (job.jobId !== jobId || !JOB_NAME_PATTERN.test(job.name) || job.session !== tmuxSessionName(jobId) ||
      !isoTime(job.createdAt) || !text("command", MAX_COMMAND_BYTES) || !job.command.trim() ||
      !text("verifyCommand", LONG_JOB_METADATA_MAX_BYTES) || !text("note", LONG_JOB_METADATA_MAX_BYTES) ||
      job.displayCommand !== redactSensitiveText(job.command) ||
      job.rawCommandSha256 !== crypto.createHash("sha256").update(job.command).digest("hex") ||
      typeof job.cwd !== "string" || !path.isAbsolute(job.cwd) || path.resolve(job.cwd) !== job.cwd ||
      (!isTrustedWholeHost(config) && !isInsideDirectory(root, job.cwd)) ||
      typeof job.expectedOutputPath !== "string" || typeof job.expectedOutputPathAbs !== "string" ||
      !integer(job.expectedSizeBytes, 0, Number.MAX_SAFE_INTEGER) || typeof job.restartOnFailure !== "boolean" ||
      !integer(job.pollIntervalSeconds, 5, 3600) || !integer(job.timeoutSeconds, 0, 60 * 60 * 24 * 14)) throw longJobMetadataError();
  const outputAbs = job.expectedOutputPath ? path.resolve(root, job.expectedOutputPath) : "";
  if (job.expectedOutputPathAbs !== outputAbs || outputAbs && !isTrustedWholeHost(config) && !isInsideDirectory(root, outputAbs)) throw longJobMetadataError();
  for (const [key, name] of [["statusPath", "status.json"], ["stdoutPath", "stdout.log"], ["stderrPath", "stderr.log"], ["supervisorLogPath", "supervisor.log"]]) {
    if (job[key] !== path.join(".aginti", "long-jobs", jobId, name)) throw longJobMetadataError();
  }
  return job;
}
function validJobStatus(value, job) {
  const created = value?.state === "created";
  const status = created
    ? exactFields(value, [...JOB_METADATA_KEYS, "state", "outputBytes", "percent", "updatedAt"])
    : exactFields(value, STATUS_REQUIRED, STATUS_TIMES);
  const shared = created ? JOB_METADATA_KEYS : ["jobId", "name", "createdAt", "cwd", "session", "expectedOutputPath", "expectedSizeBytes", "restartOnFailure", "pollIntervalSeconds"];
  for (const key of shared) {
    const expected = key === "command" ? job.displayCommand : key === "verifyCommand" ? redactSensitiveText(job.verifyCommand) : job[key];
    if (status[key] !== expected) throw longJobMetadataError();
  }
  if (!isoTime(status.updatedAt) || status.updatedAt < job.createdAt ||
      !integer(status.outputBytes, 0, Number.MAX_SAFE_INTEGER)) throw longJobMetadataError();
  if (created) {
    if (status.outputBytes !== 0 || status.percent !== null) throw longJobMetadataError();
    return status;
  }
  if (!["starting", "running", "verifying", "restarting", "completed", "failed"].includes(status.state) ||
      status.command !== job.displayCommand || !integer(status.attempt, 0, Number.MAX_SAFE_INTEGER) ||
      !(status.pid === null || integer(status.pid, 1, Number.MAX_SAFE_INTEGER)) ||
      ![status.exitCode, status.verifyExitCode].every(code => code === null || integer(code, 0, 255)) ||
      typeof status.outputExists !== "boolean" || typeof status.reason !== "string" || Buffer.byteLength(status.reason) > 4096 ||
      !isoTime(status.startedAt) || status.startedAt < job.createdAt || status.startedAt > status.updatedAt) throw longJobMetadataError();
  const percent = job.expectedSizeBytes > 0 && status.outputExists ? Math.min(100, status.outputBytes / job.expectedSizeBytes * 100) : null;
  if (status.percent !== percent || !status.outputExists && status.outputBytes !== 0) throw longJobMetadataError();
  for (const key of STATUS_TIMES) if (Object.hasOwn(status, key) &&
      (!isoTime(status[key]) || status[key] < status.startedAt || status[key] > status.updatedAt)) throw longJobMetadataError();
  if (status.state === "completed" && (!isoTime(status.completedAt) || Object.hasOwn(status, "failedAt") ||
      status.pid !== null || status.exitCode !== 0 || job.verifyCommand && status.verifyExitCode !== 0) ||
      status.state === "failed" && (!isoTime(status.failedAt) || Object.hasOwn(status, "completedAt") || status.pid !== null) ||
      !["completed", "failed"].includes(status.state) && (Object.hasOwn(status, "completedAt") || Object.hasOwn(status, "failedAt"))) throw longJobMetadataError();
  if (status.state === "completed" && job.expectedOutputPath && (!status.outputExists ||
      (job.expectedSizeBytes > 0 ? status.outputBytes !== job.expectedSizeBytes : status.outputBytes <= 0))) throw longJobMetadataError();
  return status;
}

function unavailableJobMetadata(toolName, jobId = "") {
  return { ok: false, blocked: true, toolName, ...(jobId ? { jobId } : {}),
    code: "LONG_JOB_METADATA_UNAVAILABLE", reason: longJobMetadataError().message };
}
function observedSessionAlive(result, session) {
  if (result.ok) return true;
  const message = result.stderr.trim();
  if (result.exitCode === 1 && (message === `can't find session: ${session}` ||
      /^no server running on [^\r\n]+$/.test(message) ||
      /^error connecting to [^\r\n]+ \(No such file or directory\)$/.test(message))) return false;
  return null;
}

function uniqueAbsolutePaths(text = "") {
  const paths = new Set();
  for (const match of String(text || "").matchAll(ABSOLUTE_PATH_PATTERN)) {
    const candidate = match[2];
    if (!candidate || candidate.startsWith("//")) continue;
    paths.add(candidate.replace(/[),.;]+$/g, ""));
  }
  return [...paths].filter(Boolean);
}

function checkWorkspaceBoundText(text = "", config = {}, label = "long job command") {
  if (!config.useDockerSandbox && isTrustedWholeHost(config)) return { ok: true };
  const root = workspaceRoot(config);
  for (const candidate of uniqueAbsolutePaths(text)) {
    if (ALWAYS_ALLOWED_ABSOLUTE_PATHS.has(candidate)) continue;
    const resolved = path.resolve(candidate);
    if (!isInsideDirectory(root, resolved)) {
      return {
        ok: false,
        reason: `${label} references an absolute host path outside the configured workspace: ${candidate}. Use a workspace-relative path or trusted host mode for whole-host work.`,
      };
    }
  }
  return { ok: true };
}

function resolveCwd(config = {}, rawCwd = ".") {
  const root = workspaceRoot(config);
  const requested = String(rawCwd || ".").trim() || ".";
  const cwd = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
  if (!isTrustedWholeHost(config) && !isInsideDirectory(root, cwd)) {
    return { ok: false, reason: "Long-job cwd must stay inside the configured workspace unless trusted host mode is enabled." };
  }
  return { ok: true, cwd, root };
}

function resolveExpectedOutput(config = {}, cwd = "", rawPath = "") {
  const value = String(rawPath || "").trim();
  if (!value) return { ok: true, outputPath: "", outputPathAbs: "" };
  const root = workspaceRoot(config);
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd || root, value);
  if (!isTrustedWholeHost(config) && !isInsideDirectory(root, absolute)) {
    return {
      ok: false,
      reason: "Expected output path must stay inside the configured workspace unless trusted host mode is enabled.",
    };
  }
  return {
    ok: true,
    outputPath: isInsideDirectory(root, absolute) ? path.relative(root, absolute) || "." : absolute,
    outputPathAbs: absolute,
  };
}

async function runTmux(args, options = {}) {
  try {
    const result = await execFile("tmux", args, {
      timeout: options.timeout ?? 12000,
      maxBuffer: options.maxBuffer ?? 128 * 1024,
      env: safeEnv(),
      signal: options.signal,
    });
    return {
      ok: true,
      stdout: redactSensitiveText(result.stdout || ""),
      stderr: redactSensitiveText(result.stderr || ""),
    };
  } catch (error) {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      stdout: redactSensitiveText(String(error?.stdout || "")),
      stderr: redactSensitiveText(String(error?.stderr || message)),
      error: message,
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
    };
  }
}

function shellQuote(value = "") {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function supervisorSource() {
  return String.raw`import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const jobDir = path.dirname(fileURLToPath(import.meta.url));
const jobPath = path.join(jobDir, "job.json");
const statusPath = path.join(jobDir, "status.json");
const eventsPath = path.join(jobDir, "events.jsonl");
const stdoutPath = path.join(jobDir, "stdout.log");
const stderrPath = path.join(jobDir, "stderr.log");
const verifyStdoutPath = path.join(jobDir, "verify_stdout.log");
const verifyStderrPath = path.join(jobDir, "verify_stderr.log");
const supervisorLogPath = path.join(jobDir, "supervisor.log");
const job = JSON.parse(await fsp.readFile(jobPath, "utf8"));
let statusTail = Promise.resolve();
let statusSealed = false;
let heartbeatPending = false;
let heartbeatTimer;
let status = {
  jobId: job.jobId,
  name: job.name,
  state: "starting",
  createdAt: job.createdAt,
  updatedAt: new Date().toISOString(),
  cwd: job.cwd,
  session: job.session,
  command: job.displayCommand || job.command,
  expectedOutputPath: job.expectedOutputPath || "",
  expectedSizeBytes: job.expectedSizeBytes || 0,
  restartOnFailure: Boolean(job.restartOnFailure),
  pollIntervalSeconds: job.pollIntervalSeconds,
  attempt: 0,
  pid: null,
  exitCode: null,
  verifyExitCode: null,
  outputBytes: 0,
  percent: null,
  reason: "",
};

function now() {
  return new Date().toISOString();
}

async function appendLog(message) {
  await fsp.appendFile(supervisorLogPath, now() + " " + message + "\n", { mode: 0o600 });
}

async function appendEvent(type, data = {}) {
  await fsp.appendFile(eventsPath, JSON.stringify({ type, at: now(), ...data }) + "\n", { mode: 0o600 });
}

function outputStats() {
  if (!job.expectedOutputPathAbs) return { exists: false, bytes: 0, percent: null };
  try {
    const stat = fs.statSync(job.expectedOutputPathAbs);
    const bytes = stat.size;
    const expected = Number(job.expectedSizeBytes || 0);
    return {
      exists: true,
      bytes,
      percent: expected > 0 ? Math.min(100, (bytes / expected) * 100) : null,
    };
  } catch {
    return { exists: false, bytes: 0, percent: null };
  }
}

function writeStatus(patch = {}) {
  if (statusSealed) return statusTail;
  if (patch.state === "completed" || patch.state === "failed") {
    statusSealed = true;
    clearInterval(heartbeatTimer);
  }
  const operation = statusTail.then(async () => {
    const stats = outputStats();
    const next = {
      ...status,
      ...patch,
      outputExists: stats.exists,
      outputBytes: stats.bytes,
      percent: stats.percent,
      updatedAt: now(),
    };
    const tmp = statusPath + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, statusPath);
    status = next;
  });
  // Observe detached PID/heartbeat writes without repairing a rejected tail.
  // Later mandatory/terminal writes must fail if any earlier publication failed.
  statusTail = operation;
  operation.catch(() => {});
  return operation;
}

function outputComplete() {
  if (!job.expectedOutputPathAbs) return true;
  const stats = outputStats();
  if (!stats.exists) return false;
  const expected = Number(job.expectedSizeBytes || 0);
  return expected > 0 ? stats.bytes === expected : stats.bytes > 0;
}

function deadlineExceeded() {
  return Number(job.timeoutSeconds || 0) > 0 && Date.now() >= job.startedEpochMs + Number(job.timeoutSeconds) * 1000;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runShell(command, { stdout, stderr, label }) {
  await appendEvent(label + ".started", { command });
  const shell = process.env.SHELL || "/bin/bash";
  return await new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(shell, ["-lc", command], {
      cwd: job.cwd,
      env: { ...process.env, AGINTI_LONG_JOB_ID: job.jobId, AGINTI_LONG_JOB_DIR: jobDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeStatus({ state: label === "verify" ? "verifying" : "running", pid: child.pid || null }).catch(() => {});
    const out = fs.createWriteStream(stdout, { flags: "a", mode: 0o600 });
    const err = fs.createWriteStream(stderr, { flags: "a", mode: 0o600 });
    child.stdout.on("data", (chunk) => out.write(chunk));
    child.stderr.on("data", (chunk) => err.write(chunk));
    const timeoutMs = Number(job.timeoutSeconds || 0) > 0 ? Math.max(1, job.startedEpochMs + Number(job.timeoutSeconds) * 1000 - Date.now()) : 0;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {}
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 5000).unref?.();
        }, timeoutMs)
      : null;
    child.on("close", async (code, signal) => {
      if (timer) clearTimeout(timer);
      out.end();
      err.end();
      await appendEvent(label + ".finished", { exitCode: code, signal: signal || "", timedOut });
      resolve({ exitCode: Number.isInteger(code) ? code : 1, signal: signal || "", timedOut });
    });
    child.on("error", async (error) => {
      if (timer) clearTimeout(timer);
      out.end();
      err.end();
      await appendEvent(label + ".failed", { error: error.message || String(error) });
      resolve({ exitCode: 1, signal: "", timedOut, error: error.message || String(error) });
    });
  });
}

await fsp.mkdir(jobDir, { recursive: true });
await appendLog("long job supervisor starting: " + job.jobId);
await appendEvent("job.started", { jobId: job.jobId, session: job.session });
job.startedEpochMs = Date.now();
await writeStatus({ state: "starting", startedAt: now() });

heartbeatTimer = setInterval(() => {
  if (!statusSealed && !heartbeatPending && ["running", "verifying", "restarting"].includes(status.state)) {
    heartbeatPending = true;
    writeStatus({ heartbeatAt: now() }).then(
      () => { heartbeatPending = false; },
      () => { heartbeatPending = false; }
    );
  }
}, Math.max(1, Number(job.pollIntervalSeconds || 60)) * 1000);
heartbeatTimer.unref?.();

let attempt = 0;
while (true) {
  attempt += 1;
  await writeStatus({ state: "running", attempt, pid: null, exitCode: null, reason: "" });
  await appendLog("attempt " + attempt + " started");
  const result = await runShell(job.command, { stdout: stdoutPath, stderr: stderrPath, label: "command" });
  await writeStatus({ exitCode: result.exitCode, pid: null });

  const complete = result.exitCode === 0 && outputComplete();
  if (complete) {
    if (job.verifyCommand) {
      const verify = await runShell(job.verifyCommand, { stdout: verifyStdoutPath, stderr: verifyStderrPath, label: "verify" });
      await writeStatus({ verifyExitCode: verify.exitCode, pid: null });
      if (verify.exitCode === 0) {
        await writeStatus({ state: "completed", completedAt: now(), reason: "command and verification succeeded" });
        await appendEvent("job.completed", { verifyExitCode: verify.exitCode });
        await appendLog("job completed");
        process.exit(0);
      }
      await writeStatus({ state: "failed", failedAt: now(), reason: "verify command exited " + verify.exitCode });
      await appendEvent("job.failed", { reason: "verify command exited " + verify.exitCode });
      await appendLog("job failed: verify exit " + verify.exitCode);
      process.exit(1);
    }
    await writeStatus({ state: "completed", completedAt: now(), reason: "command succeeded" });
    await appendEvent("job.completed", { exitCode: result.exitCode });
    await appendLog("job completed");
    process.exit(0);
  }

  const reason = result.exitCode !== 0 ? "command exited " + result.exitCode : "expected output is missing or incomplete";
  if (job.restartOnFailure && !deadlineExceeded()) {
    await writeStatus({ state: "restarting", reason, restartedAt: now() });
    await appendEvent("job.restarting", { attempt, reason });
    await appendLog("restarting after attempt " + attempt + ": " + reason);
    await delay(Math.max(1, Number(job.pollIntervalSeconds || 60)) * 1000);
    continue;
  }

  await writeStatus({ state: "failed", failedAt: now(), reason });
  await appendEvent("job.failed", { attempt, reason });
  await appendLog("job failed: " + reason);
  process.exit(1);
}`;
}

function buildStatusMarkdown(job = {}) {
  return [
    `# Long Job: ${job.name}`,
    "",
    `- Job ID: \`${job.jobId}\``,
    `- State file: \`${job.statusPath}\``,
    `- Session: \`${job.session}\``,
    `- CWD: \`${job.cwd}\``,
    job.expectedOutputPath ? `- Expected output: \`${job.expectedOutputPath}\`` : "",
    job.expectedSizeBytes ? `- Expected size: ${job.expectedSizeBytes} bytes` : "",
    `- Stdout log: \`${job.stdoutPath}\``,
    `- Stderr log: \`${job.stderrPath}\``,
    `- Supervisor log: \`${job.supervisorLogPath}\``,
    "",
    "This is a durable background job. The model loop should not poll it. Use `long_job_status` or read the status JSON later.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function checkLongJobToolUse(toolName, args = {}, config = {}) {
  if (!config.allowShellTool) {
    return { allowed: false, reason: "Long jobs require the shell tool to be enabled.", category: "long-job" };
  }
  if (toolName === "long_job_status") {
    const jobId = String(args.jobId || "").trim();
    if (!jobId) return { allowed: false, reason: "long_job_status requires jobId.", category: "long-job" };
    if (!JOB_ID_PATTERN.test(jobId)) return { allowed: false, reason: "Invalid long job id.", category: "long-job" };
    return { allowed: true, category: "long-job" };
  }
  if (toolName !== "start_long_job") return { allowed: true, category: "long-job" };

  const name = normalizeJobName(args.name || "aginti-long-job");
  if (!JOB_NAME_PATTERN.test(name)) {
    return { allowed: false, reason: "Long job name must use letters, numbers, dot, underscore, plus, or dash.", category: "long-job" };
  }
  const command = String(args.command || "").trim();
  if (!command) return { allowed: false, reason: "start_long_job requires command.", category: "long-job" };
  if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
    return { allowed: false, reason: "Long job command is too large.", category: "long-job" };
  }
  if (SECRET_PATTERN.test(command)) {
    return { allowed: false, reason: "Long job command appears to contain a secret.", category: "long-job" };
  }
  const cwd = resolveCwd(config, args.cwd || ".");
  if (!cwd.ok) return { allowed: false, reason: cwd.reason, category: "long-job" };
  const workspaceBound = checkWorkspaceBoundText(command, config, "Long job command");
  if (!workspaceBound.ok) return { allowed: false, reason: workspaceBound.reason, category: "long-job" };
  const policy = evaluateCommandPolicy(command, config);
  if (!policy.allowed) {
    return {
      allowed: false,
      reason: `Long job command is blocked by shell policy: ${policy.reason}`,
      category: policy.category || "long-job",
      needsApproval: policy.needsApproval,
    };
  }
  const verifyCommand = String(args.verifyCommand || "").trim();
  if (verifyCommand) {
    if (SECRET_PATTERN.test(verifyCommand)) {
      return { allowed: false, reason: "Long job verify command appears to contain a secret.", category: "long-job" };
    }
    const verifyWorkspaceBound = checkWorkspaceBoundText(verifyCommand, config, "Long job verify command");
    if (!verifyWorkspaceBound.ok) return { allowed: false, reason: verifyWorkspaceBound.reason, category: "long-job" };
    const verifyPolicy = evaluateCommandPolicy(verifyCommand, config);
    if (!verifyPolicy.allowed) {
      return {
        allowed: false,
        reason: `Long job verify command is blocked by shell policy: ${verifyPolicy.reason}`,
        category: verifyPolicy.category || "long-job",
        needsApproval: verifyPolicy.needsApproval,
      };
    }
  }
  const output = resolveExpectedOutput(config, cwd.cwd, args.expectedOutputPath || "");
  if (!output.ok) return { allowed: false, reason: output.reason, category: "long-job" };
  return { allowed: true, category: "long-job" };
}

export async function startLongJob(args = {}, config = {}) {
  const guard = checkLongJobToolUse("start_long_job", args, config);
  if (!guard.allowed) {
    return {
      ok: false,
      blocked: true,
      toolName: "start_long_job",
      reason: guard.reason,
      category: guard.category,
      needsApproval: guard.needsApproval,
    };
  }

  const name = normalizeJobName(args.name || "aginti-long-job");
  const command = String(args.command || "").trim();
  const verifyCommand = String(args.verifyCommand || "").trim();
  const cwd = resolveCwd(config, args.cwd || ".");
  const output = resolveExpectedOutput(config, cwd.cwd, args.expectedOutputPath || "");
  const root = cwd.root;
  const jobId = makeJobId(name);
  const session = tmuxSessionName(jobId);
  const jobDir = path.join(root, ".aginti", "long-jobs", jobId);
  const relativeJobDir = path.relative(root, jobDir) || ".";
  const statusPath = path.join(relativeJobDir, "status.json");
  const statusMarkdownPath = path.join(relativeJobDir, "status.md");
  const supervisorPath = path.join(jobDir, "supervisor.mjs");
  const stdoutPath = path.join(relativeJobDir, "stdout.log");
  const stderrPath = path.join(relativeJobDir, "stderr.log");
  const supervisorLogPath = path.join(relativeJobDir, "supervisor.log");
  const expectedSizeBytes = clampInteger(args.expectedSizeBytes, 0, 0, Number.MAX_SAFE_INTEGER);
  const pollIntervalSeconds = clampInteger(
    args.pollIntervalSeconds,
    DEFAULT_POLL_INTERVAL_SECONDS,
    5,
    3600
  );
  const timeoutSeconds = clampInteger(args.timeoutSeconds, 0, 0, 60 * 60 * 24 * 14);

  const metadata = {
    jobId,
    name,
    session,
    createdAt: new Date().toISOString(),
    cwd: cwd.cwd,
    command: redactSensitiveText(command),
    displayCommand: redactSensitiveText(command),
    rawCommandSha256: crypto.createHash("sha256").update(command).digest("hex"),
    verifyCommand: verifyCommand ? redactSensitiveText(verifyCommand) : "",
    expectedOutputPath: output.outputPath,
    expectedOutputPathAbs: output.outputPathAbs,
    expectedSizeBytes,
    restartOnFailure: Boolean(args.restartOnFailure),
    pollIntervalSeconds,
    timeoutSeconds,
    statusPath,
    stdoutPath,
    stderrPath,
    supervisorLogPath,
    note: redactSensitiveText(String(args.note || "")),
  };
  // Finish pure preparation before creating a control directory or dispatching.
  const jobMetadata = { ...metadata, command, verifyCommand };
  const initialStatus = { ...metadata, state: "created", outputBytes: 0, percent: null, updatedAt: new Date().toISOString() };
  const files = [["job.json", JSON.stringify(jobMetadata, null, 2)], ["supervisor.mjs", supervisorSource()],
    ["command.txt", `${command}\n`], ...(verifyCommand ? [["verify.txt", `${verifyCommand}\n`]] : []),
    ["status.md", buildStatusMarkdown(metadata)], ["events.jsonl", ""], ["status.json", JSON.stringify(initialStatus, null, 2)]];
  let storage;
  try {
    validJobMetadata(jobMetadata, jobId, root, config); validJobStatus(initialStatus, jobMetadata);
    if (files.some(([name, text]) => Buffer.byteLength(text) > (name === "supervisor.mjs" ? 256 * 1024 : LONG_JOB_METADATA_MAX_BYTES))) throw longJobMetadataError();
    if (!isTrustedWholeHost(config) && !isInsideDirectory(await fsp.realpath(root), await fsp.realpath(cwd.cwd))) throw longJobMetadataError();
    storage = await openLongJobMetadata(root, jobId, { create: true });
    for (const [name, text] of files) await storage.writeNew(name, text);
    await storage.verify();
  } catch {
    return unavailableJobMetadata("start_long_job", jobId);
  }

  const tmux = await runTmux(
    ["new-session", "-d", "-s", session, "-c", cwd.cwd, `${shellQuote(process.execPath)} ${shellQuote(supervisorPath)}`],
    { timeout: 12000, signal: config.abortSignal }
  );
  if (!tmux.ok) {
    return {
      ok: false,
      toolName: "start_long_job",
      error: tmux.stderr || tmux.error,
      reason: "Failed to start durable tmux long job. Ensure tmux is installed or use a shorter blocking command.",
      jobId,
      statusPath,
    };
  }

  return {
    ok: true,
    toolName: "start_long_job",
    jobId,
    name,
    session,
    target: `${session}:0.0`,
    cwd: cwd.cwd,
    statusPath,
    statusMarkdownPath,
    eventsPath: path.join(relativeJobDir, "events.jsonl"),
    stdoutPath,
    stderrPath,
    supervisorLogPath,
    expectedOutputPath: output.outputPath,
    expectedSizeBytes,
    restartOnFailure: Boolean(args.restartOnFailure),
    pollIntervalSeconds,
    timeoutSeconds,
    background: true,
    deferredVerification: true,
    result: `Started durable background job ${jobId}. Status: ${statusPath}. Logs: ${stdoutPath}, ${stderrPath}.`,
    instruction:
      "Long job is running in tmux. Do not keep the model loop alive to poll it; report the job id and status path, then finish unless the user explicitly asked for an interactive status check.",
  };
}

export async function longJobStatus(args = {}, config = {}) {
  let jobId = "";
  try {
    const fields = dataFields(args, ["jobId"]);
    if (typeof fields.jobId === "string") jobId = fields.jobId.trim();
  } catch { return unavailableJobMetadata("long_job_status"); }
  if (!JOB_ID_PATTERN.test(jobId)) {
    return { ok: false, blocked: true, toolName: "long_job_status", reason: "Invalid or missing long job id." };
  }
  const guard = checkLongJobToolUse("long_job_status", { jobId }, config);
  if (!guard.allowed) return { ok: false, blocked: true, toolName: "long_job_status", jobId, reason: guard.reason };
  const root = workspaceRoot(config);
  try {
    const storage = await openLongJobMetadata(root, jobId);
    const snapshot = await storage.read("job.json");
    const job = validJobMetadata(snapshot.data, jobId, root, config);
    let status;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { status = validJobStatus((await storage.read("status.json")).data, job); break; }
      catch (error) { if (error.code !== "LONG_JOB_METADATA_CHANGED" || attempt === 2) throw error; }
    }
    await storage.verifySnapshot(snapshot);
    // Only a fully validated deterministic session name reaches the probe.
    const alive = await runTmux(["has-session", "-t", job.session], { timeout: 4000, signal: config.abortSignal });
    await storage.verifySnapshot(snapshot);
    const result = {
      ok: true, toolName: "long_job_status", jobId, statusPath: job.statusPath, sessionAlive: observedSessionAlive(alive, job.session),
      name: job.name, state: status.state, createdAt: job.createdAt, updatedAt: status.updatedAt,
      cwd: job.cwd, session: job.session, command: job.displayCommand,
      expectedOutputPath: job.expectedOutputPath, expectedSizeBytes: job.expectedSizeBytes,
      restartOnFailure: job.restartOnFailure, pollIntervalSeconds: job.pollIntervalSeconds,
      timeoutSeconds: job.timeoutSeconds, stdoutPath: job.stdoutPath, stderrPath: job.stderrPath,
      supervisorLogPath: job.supervisorLogPath, attempt: status.attempt ?? 0, pid: status.pid ?? null,
      exitCode: status.exitCode ?? null, verifyExitCode: status.verifyExitCode ?? null,
      outputBytes: status.outputBytes, percent: status.percent, outputExists: status.outputExists ?? false,
      reason: redactSensitiveText(status.reason || ""),
    };
    for (const key of ["startedAt", ...STATUS_TIMES]) if (Object.hasOwn(status, key)) result[key] = status[key];
    return result;
  } catch {
    return unavailableJobMetadata("long_job_status", jobId);
  }
}
