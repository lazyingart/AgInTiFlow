import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_INTEGRATION_FILE_ARTIFACT_BYTES,
  sanitizeIntegrationArtifact,
} from "./integration-artifacts.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_TEX_COMPILER_SCHEMA_VERSION = "aginti-tex-compiler-v1";
export const INTEGRATION_TEX_COMPILE_RECEIPT_SCHEMA_VERSION = "aginti-tex-compile-receipt-v1";
export const INTEGRATION_TEX_TOOL_NAME = "compile_tex_document";
export const INTEGRATION_TEX_LIMITS = Object.freeze({
  maximumSourceBytes: 512 * 1024,
  maximumPdfBytes: MAX_INTEGRATION_FILE_ARTIFACT_BYTES,
  maximumLogBytes: 512 * 1024,
  maximumProcessOutputBytes: 256 * 1024,
  maximumWallTimeMs: 30_000,
  maximumProcesses: 32,
  maximumOpenFiles: 128,
  addressSpaceBytes: 768 * 1024 * 1024,
  cpuSeconds: 25,
  maximumFileBytes: MAX_INTEGRATION_FILE_ARTIFACT_BYTES,
  maximumWorkspaceBytes: 32 * 1024 * 1024,
});

const PRIVATE_FILE_ARTIFACTS = new WeakMap();
const ISSUED_RECEIPTS = new WeakSet();
const DIGEST = /^[a-f0-9]{64}$/u;
const TERMINATION_GRACE_MS = 1_000;
const FIXED_TOOLS = Object.freeze({
  bwrap: "/usr/bin/bwrap",
  prlimit: "/usr/bin/prlimit",
  latexmk: "/usr/bin/latexmk",
  pdflatex: "/usr/bin/pdflatex",
  qpdf: "/usr/bin/qpdf",
  sh: "/bin/sh",
  head: "/usr/bin/head",
  stat: "/usr/bin/stat",
  grep: "/usr/bin/grep",
  sha256sum: "/usr/bin/sha256sum",
  printf: "/usr/bin/printf",
  cat: "/usr/bin/cat",
});
const TEX_SANDBOX_WRAPPER = [
  "set -eu",
  'name="$1"',
  'pdf="$2"',
  'base="${name%.tex}"',
  "compiler_output=/work/compiler-output.txt",
  'if ! /usr/bin/latexmk -pdf -interaction=nonstopmode -halt-on-error -file-line-error -no-shell-escape -outdir=/work "/input/$name" >"$compiler_output" 2>&1; then',
  '  /usr/bin/head -c 65536 "$compiler_output" >&2 || true',
  "  exit 20",
  "fi",
  'log="/work/$base.log"',
  'output="/work/$pdf"',
  'test -f "$log" -a ! -L "$log" -a -f "$output" -a ! -L "$output"',
  'log_size=$(/usr/bin/stat -c %s "$log")',
  'pdf_size=$(/usr/bin/stat -c %s "$output")',
  'test "$log_size" -ge 1 -a "$log_size" -le 524288',
  'test "$pdf_size" -ge 1 -a "$pdf_size" -le 16777216',
  "/usr/bin/grep -Eq 'Output written on .+\\.pdf' \"$log\"",
  'if /usr/bin/grep -Eiq \'shell escape enabled\' "$log"; then',
  "  exit 21",
  "fi",
  'if ! /usr/bin/qpdf --check "$output" >>"$compiler_output" 2>&1; then',
  '  /usr/bin/head -c 65536 "$compiler_output" >&2 || true',
  "  exit 22",
  "fi",
  'log_sha=$(/usr/bin/sha256sum "$log")',
  'log_sha="${log_sha%% *}"',
  "/usr/bin/printf 'AGINTI_TEX_RESULT_V1:%s:%s\\n' \"$pdf_size\" \"$log_sha\"",
  '/usr/bin/cat "$output"',
].join("\n");

export class IntegrationTexCompilerError extends Error {
  constructor(code, message, { status = 502, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationTexCompilerError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, options) {
  throw new IntegrationTexCompilerError(code, message, options);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function safeFilename(value) {
  if (typeof value !== "string" || !value.isWellFormed()) {
    fail("ANALYSIS_TEX_SOURCE_INVALID", "The TeX filename is invalid.", { status: 400 });
  }
  const filename = value.normalize("NFC").trim();
  const stem = filename.slice(0, -4);
  if (
    !filename ||
    !stem ||
    stem === "." ||
    stem === ".." ||
    filename !== path.basename(filename) ||
    filename.includes("\\") ||
    !/\.tex$/iu.test(filename) ||
    filename.length > 240 ||
    Buffer.byteLength(filename, "utf8") > 240 ||
    /[\u0000-\u001f\u007f]/u.test(filename)
  ) {
    fail("ANALYSIS_TEX_SOURCE_INVALID", "The TeX filename is invalid.", { status: 400 });
  }
  return filename;
}

function safeSource(value) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > INTEGRATION_TEX_LIMITS.maximumSourceBytes ||
    /\u0000/u.test(value) ||
    !/\\documentclass(?:\[[^\]]*\])?\s*\{/u.test(value) ||
    !/\\begin\s*\{document\}/u.test(value) ||
    !/\\end\s*\{document\}/u.test(value)
  ) {
    fail("ANALYSIS_TEX_SOURCE_INVALID", "The TeX source is incomplete or outside its bound.", { status: 400 });
  }
  return Buffer.from(value, "utf8");
}

function normalizeCompileRequest(value) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (!value || typeof value !== "object" || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    fail("ANALYSIS_TEX_SOURCE_INVALID", "The TeX compile request is invalid.", { status: 400 });
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !new Set(["filename", "source"]).has(key))) {
    fail("ANALYSIS_TEX_SOURCE_INVALID", "The TeX compile request is invalid.", { status: 400 });
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("ANALYSIS_TEX_SOURCE_INVALID", "The TeX compile request is invalid.", { status: 400 });
    }
  }
  return value;
}

function normalizeCompileOptions(value) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (!value || typeof value !== "object" || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    fail("ANALYSIS_TEX_CONFIGURATION_INVALID", "The TeX compiler options are invalid.", { status: 500 });
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !new Set(["signal", "spawnImpl"]).has(key))) {
    fail("ANALYSIS_TEX_CONFIGURATION_INVALID", "The TeX compiler options are invalid.", { status: 500 });
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("ANALYSIS_TEX_CONFIGURATION_INVALID", "The TeX compiler options are invalid.", { status: 500 });
    }
  }
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) {
    fail("ANALYSIS_TEX_CONFIGURATION_INVALID", "The TeX compiler signal is invalid.", { status: 500 });
  }
  if (value.spawnImpl !== undefined && typeof value.spawnImpl !== "function") {
    fail("ANALYSIS_TEX_CONFIGURATION_INVALID", "The TeX compiler process authority is invalid.", { status: 500 });
  }
  return value;
}

async function trustedExecutable(filename) {
  let real;
  let stat;
  let bytes;
  try {
    [real, stat, bytes] = await Promise.all([fs.realpath(filename), fs.stat(filename), fs.readFile(filename)]);
  } catch (error) {
    fail("ANALYSIS_TEX_RUNTIME_UNAVAILABLE", "The fixed TeX runtime is unavailable.", {
      status: 503,
      cause: error,
    });
  }
  if (
    !stat.isFile() ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    (stat.mode & 0o0022) !== 0 ||
    !real.startsWith("/usr/bin/")
  ) {
    fail("ANALYSIS_TEX_RUNTIME_UNAVAILABLE", "The fixed TeX runtime identity is unsafe.", { status: 503 });
  }
  return Object.freeze({
    filename,
    real,
    size: stat.size,
    mode: stat.mode & 0o7777,
    sha256: sha256(bytes),
  });
}

async function runtimeDigest() {
  const identities = await Promise.all(Object.values(FIXED_TOOLS).map(trustedExecutable));
  const commandTemplateDigest = contractDigest(buildCommand(
    "/__aginti_tex_input__",
    "__aginti_document__.tex",
    "__aginti_document__.pdf"
  ));
  return contractDigest({
    schemaVersion: INTEGRATION_TEX_COMPILER_SCHEMA_VERSION,
    identities,
    limits: INTEGRATION_TEX_LIMITS,
    wrapperSha256: sha256(Buffer.from(TEX_SANDBOX_WRAPPER, "utf8")),
    commandTemplateDigest,
  });
}

export async function inspectIntegrationTexCompilerRuntime() {
  const expectedRuntimeDigest = await runtimeDigest();
  let probe;
  try {
    probe = await compileIntegrationTexDocument({
      filename: "aginti-runtime-probe.tex",
      source: [
        "\\documentclass{article}",
        "\\begin{document}",
        "AgInTi TeX runtime probe.",
        "\\end{document}",
        "",
      ].join("\n"),
    });
    const receipt = validateIntegrationTexCompileReceipt(probe.receipt);
    if (
      receipt.compilerDigest !== expectedRuntimeDigest ||
      !Array.isArray(probe.artifacts) ||
      probe.artifacts.length !== 2 ||
      !probe.artifacts.every((artifact) => inspectPrivateIntegrationFileArtifact(artifact))
    ) {
      fail("ANALYSIS_TEX_RUNTIME_UNAVAILABLE", "The fixed TeX runtime probe failed.", { status: 503 });
    }
    return Object.freeze({
      schemaVersion: INTEGRATION_TEX_COMPILER_SCHEMA_VERSION,
      ready: true,
      networkNone: true,
      shellEscape: false,
      limits: INTEGRATION_TEX_LIMITS,
      runtimeDigest: expectedRuntimeDigest,
      activationProbeDigest: receipt.digest,
    });
  } finally {
    for (const artifact of probe?.artifacts || []) {
      inspectPrivateIntegrationFileArtifact(artifact)?.bytes?.fill(0);
    }
  }
}

function buildCommand(inputDirectory, filename, pdfFilename) {
  const mounts = ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib"];
  if (pathExistsSyncHint("/lib64")) mounts.push("--ro-bind", "/lib64", "/lib64");
  if (pathExistsSyncHint("/bin")) mounts.push("--ro-bind", "/bin", "/bin");
  if (pathExistsSyncHint("/etc/texmf")) mounts.push("--ro-bind", "/etc/texmf", "/etc/texmf");
  if (pathExistsSyncHint("/var/lib/texmf")) mounts.push("--ro-bind", "/var/lib/texmf", "/var/lib/texmf");
  return Object.freeze({
    command: FIXED_TOOLS.bwrap,
    args: Object.freeze([
      "--unshare-all",
      "--unshare-user",
      "--disable-userns",
      "--assert-userns-disabled",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--cap-drop", "ALL",
      ...mounts,
      "--proc", "/proc",
      "--dev", "/dev",
      "--ro-bind", inputDirectory, "/input",
      "--size", String(INTEGRATION_TEX_LIMITS.maximumWorkspaceBytes),
      "--tmpfs", "/work",
      "--chmod", "0700", "/work",
      "--chdir", "/work",
      "--setenv", "HOME", "/work",
      "--setenv", "TMPDIR", "/work",
      "--setenv", "TEXMFVAR", "/work/.texlive-var",
      "--setenv", "TEXMFCONFIG", "/work/.texlive-config",
      "--setenv", "PATH", "/usr/bin:/bin",
      "--setenv", "LANG", "C.UTF-8",
      "--hostname", "aginti-tex",
      "--uid", "65532",
      "--gid", "65532",
      FIXED_TOOLS.prlimit,
      `--as=${INTEGRATION_TEX_LIMITS.addressSpaceBytes}`,
      `--cpu=${INTEGRATION_TEX_LIMITS.cpuSeconds}`,
      `--fsize=${INTEGRATION_TEX_LIMITS.maximumFileBytes}`,
      `--nofile=${INTEGRATION_TEX_LIMITS.maximumOpenFiles}`,
      `--nproc=${INTEGRATION_TEX_LIMITS.maximumProcesses}`,
      "--core=0",
      "--",
      "/bin/sh",
      "-c",
      TEX_SANDBOX_WRAPPER,
      "aginti-tex-wrapper",
      filename,
      pdfFilename,
    ]),
  });
}

// All paths checked here are fixed administrator paths, never caller input.
function pathExistsSyncHint(filename) {
  try {
    return Boolean(process.getBuiltinModule("node:fs").statSync(filename));
  } catch {
    return false;
  }
}

function runBounded(command, { signal, spawnImpl = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command.command, command.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: Object.freeze({ PATH: "/usr/bin:/bin" }),
      });
    } catch (error) {
      reject(new IntegrationTexCompilerError("ANALYSIS_TEX_RUNTIME_UNAVAILABLE", "The TeX sandbox could not start.", {
        status: 503,
        cause: error,
      }));
      return;
    }
    const stdout = [];
    const stderr = [];
    const streamBytes = { stdout: 0, stderr: 0 };
    let outputLimited = false;
    let timedOut = false;
    let ioFailed = false;
    let childError = null;
    let settled = false;
    let wallTimer = null;
    let terminationTimer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abandon = () => {
      child.stdin?.destroy?.();
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      child.unref?.();
    };
    const terminate = () => {
      try { child.kill("SIGKILL"); } catch {}
      terminationTimer ||= setTimeout(() => {
        abandon();
        finish(new IntegrationTexCompilerError(
          "ANALYSIS_TEX_TERMINATION_UNPROVEN",
          "The TeX sandbox termination could not be proven.",
          { status: 503 }
        ));
      }, TERMINATION_GRACE_MS);
    };
    const collect = (name, target, chunk, maximumBytes) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maximumBytes - streamBytes[name];
      if (remaining > 0) target.push(buffer.subarray(0, remaining));
      streamBytes[name] += buffer.byteLength;
      if (streamBytes[name] > maximumBytes) {
        outputLimited = true;
        terminate();
      }
    };
    const abort = () => terminate();
    child.stdout?.on("data", (chunk) => collect(
      "stdout",
      stdout,
      chunk,
      INTEGRATION_TEX_LIMITS.maximumPdfBytes + 256
    ));
    child.stderr?.on("data", (chunk) => collect(
      "stderr",
      stderr,
      chunk,
      INTEGRATION_TEX_LIMITS.maximumProcessOutputBytes
    ));
    const streamError = () => {
      ioFailed = true;
      terminate();
    };
    child.stdout?.on?.("error", streamError);
    child.stderr?.on?.("error", streamError);
    child.once("error", (error) => {
      childError = error;
      terminate();
    });
    child.once("close", (code, exitSignal) => finish(null, Object.freeze({
      code,
      signal: exitSignal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString("utf8"),
      outputLimited,
      timedOut,
      ioFailed,
      childError,
      aborted: signal?.aborted === true,
    })));
    wallTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, INTEGRATION_TEX_LIMITS.maximumWallTimeMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}

function parseCompilerOutput(value) {
  const newline = value.indexOf(0x0a);
  if (newline < 1 || newline > 160) {
    fail("ANALYSIS_TEX_OUTPUT_INVALID", "The TeX compiler result envelope is invalid.");
  }
  const header = value.subarray(0, newline).toString("ascii");
  const match = /^AGINTI_TEX_RESULT_V1:([1-9][0-9]{0,8}):([a-f0-9]{64})$/u.exec(header);
  const bytes = Number(match?.[1]);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes > INTEGRATION_TEX_LIMITS.maximumPdfBytes ||
    value.byteLength !== newline + 1 + bytes
  ) {
    fail("ANALYSIS_TEX_OUTPUT_INVALID", "The TeX compiler result length is invalid.");
  }
  return Object.freeze({ pdfBytes: Buffer.from(value.subarray(newline + 1)), logSha256: match[2] });
}

function compileReceipt(sourceBytes, pdfBytes, logSha256, compilerDigest, issuedAt) {
  const unsigned = Object.freeze({
    schemaVersion: INTEGRATION_TEX_COMPILE_RECEIPT_SCHEMA_VERSION,
    receiptId: crypto.randomBytes(24).toString("base64url"),
    sourceSha256: sha256(sourceBytes),
    sourceBytes: sourceBytes.byteLength,
    pdfSha256: sha256(pdfBytes),
    pdfBytes: pdfBytes.byteLength,
    compilerDigest,
    compileLogSha256: logSha256,
    networkNone: true,
    shellEscape: false,
    issuedAt,
  });
  const receipt = Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
  ISSUED_RECEIPTS.add(receipt);
  return receipt;
}

export function validateIntegrationTexCompileReceipt(value) {
  const keys = [
    "schemaVersion",
    "receiptId",
    "sourceSha256",
    "sourceBytes",
    "pdfSha256",
    "pdfBytes",
    "compilerDigest",
    "compileLogSha256",
    "networkNone",
    "shellEscape",
    "issuedAt",
    "digest",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    value.schemaVersion !== INTEGRATION_TEX_COMPILE_RECEIPT_SCHEMA_VERSION ||
    typeof value.receiptId !== "string" ||
    !/^[A-Za-z0-9_-]{32,96}$/u.test(value.receiptId) ||
    !DIGEST.test(value.sourceSha256) ||
    !DIGEST.test(value.pdfSha256) ||
    !DIGEST.test(value.compilerDigest) ||
    !DIGEST.test(value.compileLogSha256) ||
    !DIGEST.test(value.digest) ||
    !Number.isSafeInteger(value.sourceBytes) ||
    value.sourceBytes < 1 ||
    value.sourceBytes > INTEGRATION_TEX_LIMITS.maximumSourceBytes ||
    !Number.isSafeInteger(value.pdfBytes) ||
    value.pdfBytes < 1 ||
    value.pdfBytes > INTEGRATION_TEX_LIMITS.maximumPdfBytes ||
    value.networkNone !== true ||
    value.shellEscape !== false ||
    typeof value.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(value.issuedAt)) ||
    new Date(value.issuedAt).toISOString() !== value.issuedAt
  ) {
    fail("ANALYSIS_TEX_RECEIPT_INVALID", "The TeX compile receipt is invalid.");
  }
  const { digest, ...unsigned } = value;
  if (digest !== contractDigest(unsigned)) {
    fail("ANALYSIS_TEX_RECEIPT_INVALID", "The TeX compile receipt digest is invalid.");
  }
  if (!ISSUED_RECEIPTS.has(value)) {
    fail("ANALYSIS_TEX_RECEIPT_INVALID", "The TeX compile receipt was not issued by this compiler.");
  }
  return value;
}

function createPrivateIntegrationFileArtifact({ title, filename, mime, bytes, receipt, role }) {
  const content = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes || []);
  const sha = sha256(content);
  validateIntegrationTexCompileReceipt(receipt);
  if (!new Set(["source", "pdf"]).has(role)) {
    fail("ANALYSIS_TEX_RECEIPT_INVALID", "The TeX compile receipt is invalid.");
  }
  const expectedSha = role === "source" ? receipt.sourceSha256 : receipt.pdfSha256;
  const expectedBytes = role === "source" ? receipt.sourceBytes : receipt.pdfBytes;
  if (sha !== expectedSha || content.byteLength !== expectedBytes) {
    fail("ANALYSIS_TEX_RECEIPT_INVALID", "The file does not match its TeX compile receipt.");
  }
  const artifact = sanitizeIntegrationArtifact({
    id: `art_${contractDigest({ receiptDigest: receipt.digest, role, sha }).slice(0, 64)}`,
    title,
    kind: "file",
    spec: Object.freeze({
      schemaVersion: "1",
      filename,
      mime,
      bytes: content.byteLength,
      sha256: sha,
    }),
  });
  PRIVATE_FILE_ARTIFACTS.set(artifact, Object.freeze({ bytes: content, receipt, role }));
  return artifact;
}

export function inspectPrivateIntegrationFileArtifact(value) {
  return PRIVATE_FILE_ARTIFACTS.get(value) || null;
}

export async function compileIntegrationTexDocument(value = {}, options = {}) {
  const request = normalizeCompileRequest(value);
  const normalizedOptions = normalizeCompileOptions(options);
  if (normalizedOptions.signal?.aborted === true) {
    fail("ANALYSIS_CANCELLED", "TeX compilation was cancelled.", { status: 499 });
  }
  const filename = safeFilename(request.filename === undefined ? "document.tex" : request.filename);
  const sourceBytes = safeSource(request.source);
  const pdfFilename = `${filename.slice(0, -4)}.pdf`;
  let temporaryRoot = "";
  try {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-tex-"));
    await fs.chmod(temporaryRoot, 0o700);
    const inputDirectory = path.join(temporaryRoot, "input");
    await fs.mkdir(inputDirectory, { mode: 0o755 });
    await fs.writeFile(path.join(inputDirectory, filename), sourceBytes, { flag: "wx", mode: 0o444 });
    const compilerDigest = await runtimeDigest();
    if (normalizedOptions.signal?.aborted === true) {
      fail("ANALYSIS_CANCELLED", "TeX compilation was cancelled.", { status: 499 });
    }
    const execution = await runBounded(buildCommand(inputDirectory, filename, pdfFilename), normalizedOptions);
    if (execution.aborted) fail("ANALYSIS_CANCELLED", "TeX compilation was cancelled.", { status: 499 });
    if (execution.outputLimited) fail("ANALYSIS_TEX_OUTPUT_LIMIT", "TeX compiler output exceeded its bound.");
    if (execution.timedOut) fail("ANALYSIS_TEX_TIMED_OUT", "TeX compilation exceeded its wall-time bound.");
    if (execution.ioFailed || execution.childError) {
      fail("ANALYSIS_TEX_RUNTIME_UNAVAILABLE", "The TeX sandbox failed during execution.", { status: 503 });
    }
    if (execution.code !== 0 || execution.signal) {
      fail("ANALYSIS_TEX_COMPILE_FAILED", "The bounded TeX compiler rejected the source.", {
        cause: new Error(execution.stderr.slice(0, 8_192)),
      });
    }
    const { pdfBytes, logSha256 } = parseCompilerOutput(execution.stdout);
    const receipt = compileReceipt(
      sourceBytes,
      pdfBytes,
      logSha256,
      compilerDigest,
      new Date().toISOString()
    );
    return Object.freeze({
      schemaVersion: INTEGRATION_TEX_COMPILER_SCHEMA_VERSION,
      receipt,
      artifacts: Object.freeze([
        createPrivateIntegrationFileArtifact({
          title: "TeX source",
          filename,
          mime: "application/x-tex",
          bytes: sourceBytes,
          receipt,
          role: "source",
        }),
        createPrivateIntegrationFileArtifact({
          title: "Compiled PDF",
          filename: pdfFilename,
          mime: "application/pdf",
          bytes: pdfBytes,
          receipt,
          role: "pdf",
        }),
      ]),
    });
  } finally {
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// This workstation-only adapter exposes the freshly compiled bytes to the
// durable document-worker store without turning the process-local artifact
// brand into an authorization mechanism. The worker receipt ledger becomes
// the sole restart-stable authority before any opaque ref is committed.
export async function compileIntegrationTexWorkerPayload(value = {}, options = {}) {
  const compiled = await compileIntegrationTexDocument(value, options);
  const [sourceArtifact, pdfArtifact] = compiled.artifacts;
  const sourcePrivate = inspectPrivateIntegrationFileArtifact(sourceArtifact);
  const pdfPrivate = inspectPrivateIntegrationFileArtifact(pdfArtifact);
  if (
    !sourcePrivate ||
    !pdfPrivate ||
    sourcePrivate.role !== "source" ||
    pdfPrivate.role !== "pdf" ||
    sourcePrivate.receipt !== pdfPrivate.receipt
  ) {
    fail("ANALYSIS_TEX_RECEIPT_INVALID", "The TeX compiler did not retain a coherent private result.");
  }
  return Object.freeze({
    schemaVersion: INTEGRATION_TEX_COMPILER_SCHEMA_VERSION,
    compilerReceipt: sourcePrivate.receipt,
    source: Object.freeze({
      filename: sourceArtifact.spec.filename,
      mime: sourceArtifact.spec.mime,
      bytes: Buffer.from(sourcePrivate.bytes),
      sha256: sourceArtifact.spec.sha256,
    }),
    pdf: Object.freeze({
      filename: pdfArtifact.spec.filename,
      mime: pdfArtifact.spec.mime,
      bytes: Buffer.from(pdfPrivate.bytes),
      sha256: pdfArtifact.spec.sha256,
    }),
  });
}
