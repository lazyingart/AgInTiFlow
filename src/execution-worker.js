import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  EXECUTION_RUNTIME_BUNDLE_PROFILE,
  validateExecutionRuntimeBundle,
} from "./execution-runtime-bundle.js";
import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import { contractDigest } from "./integration-policy.js";

export const EXECUTION_WORKER_SCHEMA_VERSION = "aginti-execution-worker-v1";
export const EXECUTION_JOB_SCHEMA_VERSION = "aginti-execution-job-v1";
export const EXECUTION_RESULT_SCHEMA_VERSION = "aginti-execution-result-v1";
export const EXECUTION_RUNTIME_PROFILE = "python-bwrap-netless-v1";
export const EXECUTION_PUBLIC_ACTIVATION_ENABLED = false;
export const EXECUTION_RUNTIME_PATHS = Object.freeze({
  prlimit: "/usr/bin/prlimit",
  bwrap: "/usr/bin/bwrap",
  python: "/usr/bin/python3.12",
});
export const EXECUTION_LIMITS = Object.freeze({
  maximumSourceBytes: 32 * 1024,
  maximumStdinBytes: 16 * 1024,
  maximumOutputBytes: 64 * 1024,
  maximumArtifactTransportBytes: 192 * 1024,
  maximumArtifacts: 8,
  maximumWallTimeMs: 20_000,
  maximumConcurrentJobs: 2,
  addressSpaceBytes: 512 * 1024 * 1024,
  maximumWorkspaceBytes: 16 * 1024 * 1024,
  maximumFileBytes: 1024 * 1024,
  maximumProcesses: 64,
  maximumOpenFiles: 128,
  cpuSeconds: 22,
});
export const EXECUTION_SECCOMP_POLICY = Object.freeze({
  schemaVersion: "aginti-execution-seccomp-v1",
  architecture: "AUDIT_ARCH_X86_64",
  x32AbiAction: "errno-EPERM",
  defaultAction: "allow",
  deniedAction: "errno-EPERM",
  deniedSyscalls: Object.freeze([
    Object.freeze({ name: "clone", number: 56 }),
    Object.freeze({ name: "fork", number: 57 }),
    Object.freeze({ name: "vfork", number: 58 }),
    Object.freeze({ name: "execve", number: 59 }),
    Object.freeze({ name: "ptrace", number: 101 }),
    Object.freeze({ name: "pivot_root", number: 155 }),
    Object.freeze({ name: "chroot", number: 161 }),
    Object.freeze({ name: "acct", number: 163 }),
    Object.freeze({ name: "mount", number: 165 }),
    Object.freeze({ name: "umount2", number: 166 }),
    Object.freeze({ name: "swapon", number: 167 }),
    Object.freeze({ name: "swapoff", number: 168 }),
    Object.freeze({ name: "reboot", number: 169 }),
    Object.freeze({ name: "init_module", number: 175 }),
    Object.freeze({ name: "delete_module", number: 176 }),
    Object.freeze({ name: "kexec_load", number: 246 }),
    Object.freeze({ name: "add_key", number: 248 }),
    Object.freeze({ name: "request_key", number: 249 }),
    Object.freeze({ name: "keyctl", number: 250 }),
    Object.freeze({ name: "unshare", number: 272 }),
    Object.freeze({ name: "move_pages", number: 279 }),
    Object.freeze({ name: "perf_event_open", number: 298 }),
    Object.freeze({ name: "open_by_handle_at", number: 304 }),
    Object.freeze({ name: "setns", number: 308 }),
    Object.freeze({ name: "process_vm_readv", number: 310 }),
    Object.freeze({ name: "process_vm_writev", number: 311 }),
    Object.freeze({ name: "kcmp", number: 312 }),
    Object.freeze({ name: "finit_module", number: 313 }),
    Object.freeze({ name: "seccomp", number: 317 }),
    Object.freeze({ name: "bpf", number: 321 }),
    Object.freeze({ name: "execveat", number: 322 }),
    Object.freeze({ name: "userfaultfd", number: 323 }),
    Object.freeze({ name: "io_uring_setup", number: 425 }),
    Object.freeze({ name: "io_uring_enter", number: 426 }),
    Object.freeze({ name: "io_uring_register", number: 427 }),
    Object.freeze({ name: "clone3", number: 435 }),
  ]),
});
export const EXECUTION_SECCOMP_POLICY_DIGEST = contractDigest(EXECUTION_SECCOMP_POLICY);

const JOB_ID = /^job_[A-Za-z0-9_-]{24,96}$/u;
const WORKER_ID = /^worker_[A-Za-z0-9_-]{24,96}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ARTIFACT_MARKER = "\u001eAGINTI_ARTIFACTS_V1:";
const RUNTIME_PROBE_MARKER = "AGINTI_RUNTIME_PROBE_V1:";
const MAX_TRANSPORT_BYTES =
  EXECUTION_LIMITS.maximumOutputBytes + EXECUTION_LIMITS.maximumArtifactTransportBytes + 16 * 1024;
const MAX_RUNTIME_PROBE_BYTES = 16 * 1024;
const RUNTIME_PROBE_TIMEOUT_MS = 3_000;
const RUNTIME_CAPABILITY_CACHE_MS = 1_000;
const TERMINATION_GRACE_MS = 1_000;
const EXECUTION_WORKER_SOURCE_URL = new URL(import.meta.url);
const EXECUTION_ARTIFACTS_SOURCE_URL = new URL("./integration-artifacts.js", import.meta.url);
const ALLOWED_TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "output_limited",
  "cancelled",
  "sandbox_error",
  "artifact_invalid",
  "termination_unproven",
]);

const PYTHON_WRAPPER = String.raw`
import builtins
import ctypes
import errno
import io
import json
import os
import sys

_payload = json.loads(sys.stdin.read())
_source = _payload["source"]
_stdin = _payload["stdin"]
_artifacts = []
_json_dumps = json.dumps
_stderr_write = sys.__stderr__.write
_stderr_flush = sys.__stderr__.flush
os.umask(0o077)

_seccomp_policy_digest = ${JSON.stringify(EXECUTION_SECCOMP_POLICY_DIGEST)}
_seccomp_syscalls = ${JSON.stringify(EXECUTION_SECCOMP_POLICY.deniedSyscalls.map(({ number }) => number))}

class _SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort),
        ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte),
        ("k", ctypes.c_uint32),
    ]

class _SockFprog(ctypes.Structure):
    _fields_ = [
        ("len", ctypes.c_ushort),
        ("filter", ctypes.POINTER(_SockFilter)),
    ]

def _install_execution_filter():
    _BPF_LD_W_ABS = 0x20
    _BPF_JMP_JEQ_K = 0x15
    _BPF_JMP_JSET_K = 0x45
    _BPF_RET_K = 0x06
    _AUDIT_ARCH_X86_64 = 0xC000003E
    _SECCOMP_RET_KILL_PROCESS = 0x80000000
    _SECCOMP_RET_ERRNO_EPERM = 0x00050000 | errno.EPERM
    _SECCOMP_RET_ALLOW = 0x7FFF0000
    _X32_SYSCALL_BIT = 0x40000000
    _PR_SET_NO_NEW_PRIVS = 38
    _PR_SET_SECCOMP = 22
    _SECCOMP_MODE_FILTER = 2

    _instructions = [
        (_BPF_LD_W_ABS, 0, 0, 4),
        (_BPF_JMP_JEQ_K, 1, 0, _AUDIT_ARCH_X86_64),
        (_BPF_RET_K, 0, 0, _SECCOMP_RET_KILL_PROCESS),
        (_BPF_LD_W_ABS, 0, 0, 0),
        (_BPF_JMP_JSET_K, 0, 1, _X32_SYSCALL_BIT),
        (_BPF_RET_K, 0, 0, _SECCOMP_RET_ERRNO_EPERM),
    ]
    for _syscall in _seccomp_syscalls:
        _instructions.append((_BPF_JMP_JEQ_K, 0, 1, _syscall))
        _instructions.append((_BPF_RET_K, 0, 0, _SECCOMP_RET_ERRNO_EPERM))
    _instructions.append((_BPF_RET_K, 0, 0, _SECCOMP_RET_ALLOW))
    _program_type = _SockFilter * len(_instructions)
    _program = _program_type(*(_SockFilter(*_instruction) for _instruction in _instructions))
    _filter = _SockFprog(len=len(_instructions), filter=_program)
    _libc = ctypes.CDLL(None, use_errno=True)
    if _libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS failed")
    if _libc.prctl(_PR_SET_SECCOMP, _SECCOMP_MODE_FILTER, ctypes.byref(_filter), 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_SECCOMP failed")

_install_execution_filter()

def emit_plot(title, spec):
    _artifacts.append({"title": title, "kind": "plot", "spec": spec})

def emit_table(title, spec):
    _artifacts.append({"title": title, "kind": "table", "spec": spec})

def emit_markdown(title, markdown):
    _artifacts.append({
        "title": title,
        "kind": "markdown",
        "spec": {"schemaVersion": "1", "markdown": markdown},
    })

_scope = {
    "__builtins__": builtins.__dict__,
    "__name__": "__main__",
    "_aginti_seccomp_policy_digest": _seccomp_policy_digest,
    "emit_plot": emit_plot,
    "emit_table": emit_table,
    "emit_markdown": emit_markdown,
}

try:
    sys.stdin = io.StringIO(_stdin)
    exec(compile(_source, "<user-code>", "exec"), _scope, _scope)
finally:
    _encoded = _json_dumps(
        _artifacts,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    )
    _stderr_write("\n\u001eAGINTI_ARTIFACTS_V1:" + _encoded + "\n")
    _stderr_flush()
`;

const PYTHON_RUNTIME_PROBE = String.raw`
import ctypes
import errno
import json
import os
import resource
import socket
import sys

_status = {}
for _line in open("/proc/self/status", "r", encoding="utf-8"):
    if ":" in _line:
        _key, _value = _line.split(":", 1)
        _status[_key] = _value.strip()

_libc = ctypes.CDLL(None, use_errno=True)
_libc.syscall.restype = ctypes.c_long

def _syscall_denied(_number, *_arguments):
    ctypes.set_errno(0)
    _result = _libc.syscall(ctypes.c_long(_number), *_arguments)
    return _result == -1 and ctypes.get_errno() == errno.EPERM

_execve_denied = _syscall_denied(
    59,
    ctypes.c_char_p(b"/aginti-probe-must-not-exist"),
    ctypes.c_void_p(),
    ctypes.c_void_p(),
)
_execveat_denied = _syscall_denied(
    322,
    ctypes.c_int(-100),
    ctypes.c_char_p(b"/aginti-probe-must-not-exist"),
    ctypes.c_void_p(),
    ctypes.c_void_p(),
    ctypes.c_int(0),
)
_clone_denied = _syscall_denied(
    56,
    ctypes.c_ulong(0xFFFFFFFFFFFFFFFF),
    ctypes.c_void_p(),
    ctypes.c_void_p(),
    ctypes.c_void_p(),
    ctypes.c_void_p(),
)
_clone3_denied = _syscall_denied(435, ctypes.c_void_p(), ctypes.c_size_t(0))
_unshare_denied = _syscall_denied(272, ctypes.c_int(0))
_x32_denied = _syscall_denied(0x40000000 | 59, ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p())

_workspace_was_empty = os.listdir("/work") == []
with open("/work/.aginti-runtime-probe", "w", encoding="utf-8") as _handle:
    _handle.write("ephemeral")
_workspace_round_trip = open("/work/.aginti-runtime-probe", "r", encoding="utf-8").read() == "ephemeral"
os.unlink("/work/.aginti-runtime-probe")

_network_blocked = False
_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
_socket.settimeout(0.25)
try:
    _network_blocked = _socket.connect_ex(("1.1.1.1", 53)) != 0
finally:
    _socket.close()

_network_interfaces = []
for _line in open("/proc/net/dev", "r", encoding="utf-8").read().splitlines()[2:]:
    if ":" in _line:
        _network_interfaces.append(_line.split(":", 1)[0].strip())
_ipv4_route_count = max(0, len(open("/proc/net/route", "r", encoding="utf-8").read().splitlines()) - 1)

_usr_read_only = False
try:
    with open("/usr/.aginti-runtime-probe", "w", encoding="utf-8") as _handle:
        _handle.write("forbidden")
except OSError as _error:
    _usr_read_only = _error.errno in (errno.EROFS, errno.EACCES, errno.ENOENT)

_payload = {
    "schemaVersion": "aginti-runtime-probe-v1",
    "uid": os.getuid(),
    "gid": os.getgid(),
    "cwd": os.getcwd(),
    "hostname": socket.gethostname(),
    "environment": {key: os.environ.get(key) for key in sorted(os.environ)},
    "privatePathsAbsent": all(not os.path.exists(path) for path in ("/etc", "/home", "/root", "/sys")),
    "workspaceWasEmpty": _workspace_was_empty,
    "workspaceRoundTrip": _workspace_round_trip,
    "usrReadOnly": _usr_read_only,
    "networkBlocked": _network_blocked,
    "networkNamespace": os.readlink("/proc/self/ns/net"),
    "networkInterfaces": sorted(_network_interfaces),
    "ipv4RouteCount": _ipv4_route_count,
    "effectiveCapabilities": _status.get("CapEff", ""),
    "boundingCapabilities": _status.get("CapBnd", ""),
    "noNewPrivileges": _status.get("NoNewPrivs", ""),
    "seccompMode": _status.get("Seccomp", ""),
    "seccompPolicyDigest": _aginti_seccomp_policy_digest,
    "execveDenied": _execve_denied,
    "execveatDenied": _execveat_denied,
    "cloneDenied": _clone_denied,
    "clone3Denied": _clone3_denied,
    "unshareDenied": _unshare_denied,
    "x32Denied": _x32_denied,
    "addressSpaceLimit": list(resource.getrlimit(resource.RLIMIT_AS)),
    "cpuLimit": list(resource.getrlimit(resource.RLIMIT_CPU)),
    "fileLimit": list(resource.getrlimit(resource.RLIMIT_FSIZE)),
    "openFileLimit": list(resource.getrlimit(resource.RLIMIT_NOFILE)),
    "processLimit": list(resource.getrlimit(resource.RLIMIT_NPROC)),
    "coreLimit": list(resource.getrlimit(resource.RLIMIT_CORE)),
    "isolatedImportPath": all(not path.startswith("/work") for path in sys.path),
}
print("AGINTI_RUNTIME_PROBE_V1:" + json.dumps(_payload, sort_keys=True, separators=(",", ":")))
`;

export class ExecutionWorkerError extends Error {
  constructor(code, message, { status = 503, details } = {}) {
    super(message);
    this.name = "ExecutionWorkerError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, options) {
  throw new ExecutionWorkerError(code, message, options);
}

function exactObject(input, allowed, required, label, { code = "EXECUTION_REQUEST_INVALID", status = 400 } = {}) {
  if (
    !input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    fail(code, `${label} must be a plain data object.`, { status });
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    fail(code, `${label} contains an unsupported field.`, { status });
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      fail(code, `${label} must contain only data fields.`, { status });
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      fail(code, `${label}.${key} is required.`, { status });
    }
  }
  return input;
}

function boundedUtf8(value, label, { minimum = 0, maximum } = {}) {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail("EXECUTION_REQUEST_INVALID", `${label} must be bounded UTF-8 text.`, { status: 400 });
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimum || bytes > maximum) {
    fail("EXECUTION_REQUEST_INVALID", `${label} exceeds its byte bound.`, { status: 400 });
  }
  return value;
}

function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("EXECUTION_REQUEST_INVALID", `${label} is invalid.`, { status: 400 });
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalResultDigest(value) {
  return contractDigest(value);
}

export function validateExecutionJobRequest(input = {}) {
  const request = exactObject(
    input,
    ["schemaVersion", "jobId", "attempt", "language", "source", "sourceSha256", "stdin", "timeoutMs"],
    ["schemaVersion", "jobId", "attempt", "language", "source", "sourceSha256", "timeoutMs"],
    "execution job"
  );
  if (request.schemaVersion !== EXECUTION_JOB_SCHEMA_VERSION) {
    fail("EXECUTION_REQUEST_INVALID", "execution job schemaVersion is unsupported.", { status: 400 });
  }
  if (typeof request.jobId !== "string" || !JOB_ID.test(request.jobId)) {
    fail("EXECUTION_REQUEST_INVALID", "execution jobId is invalid.", { status: 400 });
  }
  if (request.language !== "python") {
    fail("EXECUTION_REQUEST_INVALID", "execution language must be python.", { status: 400 });
  }
  const source = boundedUtf8(request.source, "execution source", {
    minimum: 1,
    maximum: EXECUTION_LIMITS.maximumSourceBytes,
  });
  const sourceSha256 = sha256(Buffer.from(source, "utf8"));
  if (typeof request.sourceSha256 !== "string" || !DIGEST.test(request.sourceSha256)
      || !crypto.timingSafeEqual(Buffer.from(sourceSha256, "hex"), Buffer.from(request.sourceSha256, "hex"))) {
    fail("EXECUTION_REQUEST_INVALID", "execution source digest does not match.", { status: 400 });
  }
  const stdin = boundedUtf8(request.stdin ?? "", "execution stdin", {
    maximum: EXECUTION_LIMITS.maximumStdinBytes,
  });
  return Object.freeze({
    schemaVersion: EXECUTION_JOB_SCHEMA_VERSION,
    jobId: request.jobId,
    attempt: positiveInteger(request.attempt, "execution attempt", 1_000_000),
    language: "python",
    source,
    sourceSha256,
    stdin,
    timeoutMs: positiveInteger(request.timeoutMs, "execution timeoutMs", EXECUTION_LIMITS.maximumWallTimeMs),
  });
}

export function executionJobRequestDigest(input) {
  return contractDigest(validateExecutionJobRequest(input));
}

function executionArtifactId({ jobId, attempt }, index, artifact) {
  return `art_${contractDigest({
    jobId,
    attempt,
    index,
    kind: artifact.kind,
    title: artifact.title,
    spec: artifact.spec,
  }).slice(0, 64)}`;
}

export function validateExecutionResult(input, expected = {}) {
  const result = exactObject(
    input,
    [
      "schemaVersion", "jobId", "attempt", "sourceSha256", "status", "exitCode", "stdout", "stderr",
      "outputTruncated", "durationMs", "artifacts", "resultDigest",
    ],
    [
      "schemaVersion", "jobId", "attempt", "sourceSha256", "status", "exitCode", "stdout", "stderr",
      "outputTruncated", "durationMs", "artifacts", "resultDigest",
    ],
    "execution result",
    { code: "EXECUTION_RESULT_INVALID", status: 502 }
  );
  if (result.schemaVersion !== EXECUTION_RESULT_SCHEMA_VERSION) {
    fail("EXECUTION_RESULT_INVALID", "execution result schemaVersion is unsupported.", { status: 502 });
  }
  if (typeof result.jobId !== "string" || !JOB_ID.test(result.jobId)) {
    fail("EXECUTION_RESULT_INVALID", "execution result jobId is invalid.", { status: 502 });
  }
  if (!Number.isSafeInteger(result.attempt) || result.attempt < 1 || result.attempt > 1_000_000) {
    fail("EXECUTION_RESULT_INVALID", "execution result attempt is invalid.", { status: 502 });
  }
  const attempt = result.attempt;
  if (typeof result.sourceSha256 !== "string" || !DIGEST.test(result.sourceSha256)) {
    fail("EXECUTION_RESULT_INVALID", "execution result source digest is invalid.", { status: 502 });
  }
  if (!ALLOWED_TERMINAL_STATUSES.has(result.status)) {
    fail("EXECUTION_RESULT_INVALID", "execution result status is invalid.", { status: 502 });
  }
  if (result.exitCode !== null && (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255)) {
    fail("EXECUTION_RESULT_INVALID", "execution result exitCode is invalid.", { status: 502 });
  }
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string"
      || Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > EXECUTION_LIMITS.maximumOutputBytes) {
    fail("EXECUTION_RESULT_INVALID", "execution result output is invalid.", { status: 502 });
  }
  if (typeof result.outputTruncated !== "boolean") {
    fail("EXECUTION_RESULT_INVALID", "execution result outputTruncated is invalid.", { status: 502 });
  }
  if (!Number.isSafeInteger(result.durationMs) || result.durationMs < 0 || result.durationMs > 60_000) {
    fail("EXECUTION_RESULT_INVALID", "execution result durationMs is invalid.", { status: 502 });
  }
  if (!Array.isArray(result.artifacts) || result.artifacts.length > EXECUTION_LIMITS.maximumArtifacts) {
    fail("EXECUTION_RESULT_INVALID", "execution result artifacts are invalid.", { status: 502 });
  }
  let artifacts;
  try {
    artifacts = result.artifacts.map((artifact, index) => {
      const sanitized = sanitizeIntegrationArtifact(artifact);
      const expectedId = executionArtifactId({ jobId: result.jobId, attempt }, index, sanitized);
      const expectedIdBytes = Buffer.from(expectedId);
      const actualIdBytes = Buffer.from(sanitized.id);
      if (expectedIdBytes.byteLength !== actualIdBytes.byteLength
          || !crypto.timingSafeEqual(expectedIdBytes, actualIdBytes)) {
        fail("EXECUTION_RESULT_INVALID", "execution result artifact ID does not match its provenance.", { status: 502 });
      }
      return sanitized;
    });
  } catch {
    fail("EXECUTION_RESULT_INVALID", "execution result contains an invalid artifact.", { status: 502 });
  }
  if (new Set(artifacts.map(({ id }) => id)).size !== artifacts.length || (result.status !== "succeeded" && artifacts.length > 0)) {
    fail("EXECUTION_RESULT_INVALID", "execution result artifact provenance is invalid.", { status: 502 });
  }
  if (expected.jobId !== undefined && result.jobId !== expected.jobId) {
    fail("EXECUTION_RESULT_INVALID", "execution result jobId does not match.", { status: 502 });
  }
  if (expected.attempt !== undefined && attempt !== expected.attempt) {
    fail("EXECUTION_RESULT_INVALID", "execution result attempt does not match.", { status: 502 });
  }
  if (expected.sourceSha256 !== undefined && result.sourceSha256 !== expected.sourceSha256) {
    fail("EXECUTION_RESULT_INVALID", "execution result source digest does not match.", { status: 502 });
  }
  if (typeof result.resultDigest !== "string" || !DIGEST.test(result.resultDigest)) {
    fail("EXECUTION_RESULT_INVALID", "execution result digest is invalid.", { status: 502 });
  }
  const unsigned = Object.freeze({
    schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
    jobId: result.jobId,
    attempt,
    sourceSha256: result.sourceSha256,
    status: result.status,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: result.outputTruncated,
    durationMs: result.durationMs,
    artifacts: Object.freeze(artifacts),
  });
  const expectedDigest = canonicalResultDigest(unsigned);
  if (!crypto.timingSafeEqual(Buffer.from(expectedDigest, "hex"), Buffer.from(result.resultDigest, "hex"))) {
    fail("EXECUTION_RESULT_INVALID", "execution result digest does not match.", { status: 502 });
  }
  return Object.freeze({ ...unsigned, resultDigest: expectedDigest });
}

export function buildExecutionWorkerCommand({ runtimeRoot = null } = {}) {
  if (runtimeRoot !== null && (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)
      || path.normalize(runtimeRoot) !== runtimeRoot || runtimeRoot === "/")) {
    throw new TypeError("runtimeRoot must be null or a dedicated canonical absolute path");
  }
  const paths = EXECUTION_RUNTIME_PATHS;
  const runtimeMounts = runtimeRoot
    ? ["--ro-bind", runtimeRoot, "/"]
    : ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64"];
  return Object.freeze({
    command: paths.bwrap,
    args: Object.freeze([
      "--unshare-all",
      "--unshare-user",
      "--disable-userns",
      "--assert-userns-disabled",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--cap-drop", "ALL",
      ...runtimeMounts,
      "--proc", "/proc",
      "--dev", "/dev",
      "--size", String(EXECUTION_LIMITS.maximumWorkspaceBytes),
      "--tmpfs", "/work",
      "--chmod", "0700", "/work",
      "--chdir", "/work",
      "--setenv", "HOME", "/work",
      "--setenv", "TMPDIR", "/work",
      "--setenv", "PATH", "/usr/bin",
      "--setenv", "LANG", "C.UTF-8",
      "--hostname", "aginti-executor",
      "--uid", "65532",
      "--gid", "65532",
      paths.prlimit,
      `--as=${EXECUTION_LIMITS.addressSpaceBytes}`,
      `--cpu=${EXECUTION_LIMITS.cpuSeconds}`,
      `--fsize=${EXECUTION_LIMITS.maximumFileBytes}`,
      `--nofile=${EXECUTION_LIMITS.maximumOpenFiles}`,
      `--nproc=${EXECUTION_LIMITS.maximumProcesses}`,
      "--core=0",
      "--",
      paths.python,
      "-I",
      "-S",
      "-B",
      "-u",
      "-c",
      PYTHON_WRAPPER,
    ]),
  });
}

function safeExecutableStat(value, pathname) {
  if (!value?.isFile?.() || value.uid !== 0 || value.gid !== 0 || (value.mode & 0o6022) !== 0) {
    fail("EXECUTION_RUNTIME_UNAVAILABLE", `fixed runtime executable ${pathname} is not trusted.`);
  }
  return Object.freeze({
    path: pathname,
    device: String(value.dev),
    inode: String(value.ino),
    mode: value.mode & 0o7777,
    size: value.size,
  });
}

async function executableIdentity(pathname, filesystem = fs) {
  let realPath;
  let stat;
  let content;
  try {
    realPath = await filesystem.realpath(pathname);
    stat = await filesystem.stat(pathname);
    content = await filesystem.readFile(pathname);
  } catch {
    fail("EXECUTION_RUNTIME_UNAVAILABLE", `fixed runtime executable ${pathname} is unavailable.`);
  }
  const expectedRealPath = pathname === EXECUTION_RUNTIME_PATHS.python ? pathname : pathname;
  if (realPath !== expectedRealPath) {
    fail("EXECUTION_RUNTIME_UNAVAILABLE", `fixed runtime executable ${pathname} resolved unexpectedly.`);
  }
  return Object.freeze({ ...safeExecutableStat(stat, pathname), sha256: sha256(content) });
}

export async function inspectExecutionWorkerRuntime({
  filesystem = fs,
  runtimeBundleDirectory = null,
  expectedRuntimeBundleRootDigest,
  testOnlyAllowUntrustedRuntimeBundle = false,
} = {}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("EXECUTION_RUNTIME_UNAVAILABLE", "execution runtime requires Linux x86_64 for its verified syscall policy.");
  }
  if (runtimeBundleDirectory !== null && (typeof runtimeBundleDirectory !== "string"
      || !path.isAbsolute(runtimeBundleDirectory) || path.normalize(runtimeBundleDirectory) !== runtimeBundleDirectory)) {
    throw new TypeError("runtimeBundleDirectory must be null or a canonical absolute path");
  }
  if (typeof testOnlyAllowUntrustedRuntimeBundle !== "boolean") {
    throw new TypeError("testOnlyAllowUntrustedRuntimeBundle must be a boolean");
  }
  if (expectedRuntimeBundleRootDigest !== undefined
      && (typeof expectedRuntimeBundleRootDigest !== "string" || !DIGEST.test(expectedRuntimeBundleRootDigest))) {
    throw new TypeError("expectedRuntimeBundleRootDigest must be a contract digest");
  }
  const bundle = runtimeBundleDirectory
    ? await validateExecutionRuntimeBundle({
      bundleDirectory: runtimeBundleDirectory,
      filesystem,
      expectedRootDigest: expectedRuntimeBundleRootDigest,
      testOnlyAllowUntrustedOwnership: testOnlyAllowUntrustedRuntimeBundle,
    })
    : null;
  const executables = [];
  const inspectedPaths = bundle ? [EXECUTION_RUNTIME_PATHS.bwrap] : Object.values(EXECUTION_RUNTIME_PATHS);
  for (const pathname of inspectedPaths) {
    executables.push(await executableIdentity(pathname, filesystem));
  }
  const policy = Object.freeze({
    profile: bundle ? `${EXECUTION_RUNTIME_PROFILE}+${EXECUTION_RUNTIME_BUNDLE_PROFILE}` : EXECUTION_RUNTIME_PROFILE,
    rootFilesystem: bundle ? "sealed-curated-runtime-root" : "empty-with-fixed-read-only-runtime-binds",
    network: "unshared-none",
    runtimeReadOnlyMounts: Object.freeze(bundle ? ["sealed-runtime-root:/"] : ["/usr", "/lib", "/lib64"]),
    hostDataMounts: false,
    homeMount: false,
    runtimeCredentials: false,
    uid: 65532,
    gid: 65532,
    capabilities: "drop-all",
    noNewPrivileges: "kernel-verified-by-live-probe",
    nestedUserNamespaces: false,
    seccomp: "wrapper-installed-x86_64-cbpf-deny-process-creation-and-kernel-attack-surface",
    workspace: "ephemeral-bounded-tmpfs",
    runtimeTree: bundle ? "manifest-verified-curated-runtime-root" : "broad-read-only-host-runtime-bind",
    childProcessExecution: bundle
      ? "seccomp-denied-after-python-start-with-python-prlimit-runtime-allowlist"
      : "seccomp-denied-after-python-start-but-broad-host-runtime-remains-readable",
    sourceTransport: "stdin",
    environment: Object.freeze(["HOME=/work", "TMPDIR=/work", "PATH=/usr/bin", "LANG=C.UTF-8", "PWD=/work"]),
    limits: EXECUTION_LIMITS,
  });
  let workerSource;
  let artifactSource;
  try {
    [workerSource, artifactSource] = await Promise.all([
      filesystem.readFile(EXECUTION_WORKER_SOURCE_URL),
      filesystem.readFile(EXECUTION_ARTIFACTS_SOURCE_URL),
    ]);
  } catch {
    fail("EXECUTION_RUNTIME_UNAVAILABLE", "execution worker policy source is unavailable.");
  }
  const implementation = Object.freeze({
    workerSourceSha256: sha256(workerSource),
    artifactPolicySourceSha256: sha256(artifactSource),
    pythonWrapperSha256: sha256(PYTHON_WRAPPER),
    runtimeProbeSha256: sha256(PYTHON_RUNTIME_PROBE),
    seccompPolicyDigest: EXECUTION_SECCOMP_POLICY_DIGEST,
    commandDigest: contractDigest(buildExecutionWorkerCommand({ runtimeRoot: bundle?.rootPath ?? null })),
  });
  const identity = Object.freeze({
    executables: Object.freeze(executables),
    runtimeBundleRootDigest: bundle?.rootDigest ?? null,
    policyDigest: contractDigest(policy),
    implementation,
  });
  return Object.freeze({
    profile: policy.profile,
    policy,
    policyDigest: identity.policyDigest,
    implementation,
    minimalRuntimeRoot: bundle !== null,
    runtimeBundleDigestPinned: bundle !== null && expectedRuntimeBundleRootDigest === bundle.rootDigest,
    runtimeBundle: bundle,
    runtimeDigest: contractDigest(identity),
  });
}

function killChild(child) {
  try {
    return child?.kill?.("SIGKILL") === true;
  } catch {
    return false;
  }
}

function createTerminationSupervisor(child) {
  let graceTimer = null;
  let forceResolve;
  const forced = new Promise((resolve) => { forceResolve = resolve; });
  const terminate = () => {
    const killed = killChild(child);
    graceTimer ||= setTimeout(() => {
      forceResolve(Object.freeze({ terminationUnproven: true, code: null, signal: null }));
    }, TERMINATION_GRACE_MS);
    return killed;
  };
  const clear = () => {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;
  };
  return Object.freeze({ forced, terminate, clear });
}

function abandonChildStreams(child) {
  child.stdin?.destroy?.();
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  child.unref?.();
}

function collectBounded(chunks, state, chunk, maximumBytes, terminate) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, maximumBytes - state.bytes);
  if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
  state.bytes += bytes.byteLength;
  if (state.bytes > maximumBytes) {
    state.exceeded = true;
    terminate();
  }
}

function exactLimit(actual, expected) {
  return Array.isArray(actual) && actual.length === 2 && actual[0] === expected && actual[1] === expected;
}

function validateRuntimeProbe(input, { hostNetworkNamespace }) {
  const probe = exactObject(
    input,
    [
      "schemaVersion", "uid", "gid", "cwd", "hostname", "environment", "privatePathsAbsent",
      "workspaceWasEmpty", "workspaceRoundTrip", "usrReadOnly", "networkBlocked",
      "effectiveCapabilities", "boundingCapabilities", "noNewPrivileges", "seccompMode",
      "seccompPolicyDigest", "execveDenied", "execveatDenied", "cloneDenied", "clone3Denied",
      "unshareDenied", "x32Denied",
      "addressSpaceLimit", "cpuLimit", "fileLimit", "openFileLimit", "processLimit", "coreLimit",
      "isolatedImportPath", "networkNamespace", "networkInterfaces", "ipv4RouteCount",
    ],
    [
      "schemaVersion", "uid", "gid", "cwd", "hostname", "environment", "privatePathsAbsent",
      "workspaceWasEmpty", "workspaceRoundTrip", "usrReadOnly", "networkBlocked",
      "effectiveCapabilities", "boundingCapabilities", "noNewPrivileges", "seccompMode",
      "seccompPolicyDigest", "execveDenied", "execveatDenied", "cloneDenied", "clone3Denied",
      "unshareDenied", "x32Denied",
      "addressSpaceLimit", "cpuLimit", "fileLimit", "openFileLimit", "processLimit", "coreLimit",
      "isolatedImportPath", "networkNamespace", "networkInterfaces", "ipv4RouteCount",
    ],
    "execution runtime probe"
  );
  const environment = exactObject(
    probe.environment,
    ["HOME", "LANG", "PATH", "PWD", "TMPDIR"],
    ["HOME", "LANG", "PATH", "PWD", "TMPDIR"],
    "execution runtime environment"
  );
  const valid =
    probe.schemaVersion === "aginti-runtime-probe-v1" &&
    probe.uid === 65532 && probe.gid === 65532 && probe.cwd === "/work" &&
    probe.hostname === "aginti-executor" &&
    environment.HOME === "/work" && environment.TMPDIR === "/work" && environment.PWD === "/work" &&
    environment.PATH === "/usr/bin" && environment.LANG === "C.UTF-8" &&
    probe.privatePathsAbsent === true && probe.workspaceWasEmpty === true &&
    probe.workspaceRoundTrip === true && probe.usrReadOnly === true && probe.networkBlocked === true &&
    probe.effectiveCapabilities === "0000000000000000" &&
    probe.boundingCapabilities === "0000000000000000" &&
    probe.noNewPrivileges === "1" &&
    probe.seccompMode === "2" && probe.seccompPolicyDigest === EXECUTION_SECCOMP_POLICY_DIGEST &&
    probe.execveDenied === true && probe.execveatDenied === true && probe.cloneDenied === true
    && probe.clone3Denied === true && probe.unshareDenied === true && probe.x32Denied === true &&
    exactLimit(probe.addressSpaceLimit, EXECUTION_LIMITS.addressSpaceBytes) &&
    exactLimit(probe.cpuLimit, EXECUTION_LIMITS.cpuSeconds) &&
    exactLimit(probe.fileLimit, EXECUTION_LIMITS.maximumFileBytes) &&
    exactLimit(probe.openFileLimit, EXECUTION_LIMITS.maximumOpenFiles) &&
    exactLimit(probe.processLimit, EXECUTION_LIMITS.maximumProcesses) &&
    exactLimit(probe.coreLimit, 0) && probe.isolatedImportPath === true &&
    typeof probe.networkNamespace === "string" && probe.networkNamespace !== hostNetworkNamespace &&
    Array.isArray(probe.networkInterfaces) && probe.networkInterfaces.length === 1 &&
    probe.networkInterfaces[0] === "lo" && probe.ipv4RouteCount === 0;
  if (!valid) fail("EXECUTION_RUNTIME_UNAVAILABLE", "isolated execution runtime proof did not match policy.");
  const attestation = Object.freeze({
    schemaVersion: probe.schemaVersion,
    nonRoot: true,
    capabilitiesDropped: true,
    noNewPrivileges: true,
    nestedUserNamespacesDisabled: true,
    networkNone: true,
    privatePathsAbsent: true,
    readOnlyRuntime: true,
    ephemeralWorkspace: true,
    isolatedImportPath: true,
    seccomp: true,
    seccompPolicyVerified: true,
    seccompPolicyDigest: EXECUTION_SECCOMP_POLICY_DIGEST,
    deniedSyscallsProven: Object.freeze(["execve", "execveat", "clone", "clone3", "unshare", "x32-execve"]),
  });
  return Object.freeze({ ...attestation, proofDigest: contractDigest(attestation) });
}

export async function probeExecutionWorkerRuntime({
  spawnImpl = nodeSpawn,
  filesystem = fs,
  timeoutMs = RUNTIME_PROBE_TIMEOUT_MS,
  runtimeBundleDirectory = null,
  expectedRuntimeBundleRootDigest,
  testOnlyAllowUntrustedRuntimeBundle = false,
} = {}) {
  if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl must be a function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new TypeError("runtime probe timeoutMs is invalid");
  }
  let hostNetworkNamespace;
  try {
    hostNetworkNamespace = await filesystem.readlink("/proc/self/ns/net");
  } catch {
    fail("EXECUTION_RUNTIME_UNAVAILABLE", "host network namespace identity is unavailable.");
  }
  const bundle = runtimeBundleDirectory
    ? await validateExecutionRuntimeBundle({
      bundleDirectory: runtimeBundleDirectory,
      filesystem,
      expectedRootDigest: expectedRuntimeBundleRootDigest,
      testOnlyAllowUntrustedOwnership: testOnlyAllowUntrustedRuntimeBundle,
    })
    : null;
  const command = buildExecutionWorkerCommand({ runtimeRoot: bundle?.rootPath ?? null });
  let child;
  try {
    child = spawnImpl(command.command, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: Object.freeze({ PATH: "/usr/bin" }),
    });
  } catch {
    fail("EXECUTION_RUNTIME_UNAVAILABLE", "isolated execution runtime could not start.");
  }
  const stdout = [];
  const stderr = [];
  const state = { bytes: 0, exceeded: false };
  let ioFailed = false;
  let childError = null;
  const termination = createTerminationSupervisor(child);
  const onIoError = () => {
    ioFailed = true;
    termination.terminate();
  };
  child.stdout?.on("data", (chunk) => collectBounded(stdout, state, chunk, MAX_RUNTIME_PROBE_BYTES, termination.terminate));
  child.stderr?.on("data", (chunk) => collectBounded(stderr, state, chunk, MAX_RUNTIME_PROBE_BYTES, termination.terminate));
  child.stdin?.on?.("error", onIoError);
  child.stdout?.on?.("error", onIoError);
  child.stderr?.on?.("error", onIoError);
  const completion = new Promise((resolve) => {
    child.once?.("error", (error) => {
      childError = error;
      termination.terminate();
    });
    child.once?.("close", (code, signal) => resolve({ error: childError, code, signal }));
  });
  const timer = setTimeout(() => termination.terminate(), timeoutMs);
  try {
    child.stdin?.end(JSON.stringify({ source: PYTHON_RUNTIME_PROBE, stdin: "" }), "utf8");
  } catch {
    termination.terminate();
  }
  try {
    const completed = await Promise.race([completion, termination.forced]);
    if (completed.terminationUnproven) {
      abandonChildStreams(child);
      fail("EXECUTION_TERMINATION_UNPROVEN", "isolated execution runtime probe termination could not be proven.");
    }
    termination.clear();
    if (state.exceeded || ioFailed || completed.error || completed.code !== 0) {
      fail("EXECUTION_RUNTIME_UNAVAILABLE", "isolated execution runtime probe failed.");
    }
    let visibleStderr;
    try {
      const envelope = artifactEnvelope(Buffer.concat(stderr).toString("utf8"));
      visibleStderr = envelope.stderr;
      if (!envelope.present || envelope.artifacts.length !== 0) throw new Error("unexpected probe artifacts");
    } catch {
      fail("EXECUTION_RUNTIME_UNAVAILABLE", "isolated execution runtime probe envelope was invalid.");
    }
    const visibleStdout = Buffer.concat(stdout).toString("utf8").trim();
    if (visibleStderr.trim() || !visibleStdout.startsWith(RUNTIME_PROBE_MARKER)) {
      fail("EXECUTION_RUNTIME_UNAVAILABLE", "isolated execution runtime probe output was invalid.");
    }
    let parsed;
    try {
      parsed = JSON.parse(visibleStdout.slice(RUNTIME_PROBE_MARKER.length));
    } catch {
      fail("EXECUTION_RUNTIME_UNAVAILABLE", "isolated execution runtime proof was invalid.");
    }
    try {
      return validateRuntimeProbe(parsed, { hostNetworkNamespace });
    } catch {
      fail("EXECUTION_RUNTIME_UNAVAILABLE", "isolated execution runtime proof did not match policy.");
    }
  } finally {
    clearTimeout(timer);
    termination.clear();
  }
}

function artifactEnvelope(stderr, { request } = {}) {
  const markerIndex = stderr.lastIndexOf(ARTIFACT_MARKER);
  if (markerIndex === -1) return Object.freeze({ stderr, artifacts: Object.freeze([]), present: false });
  const payloadStart = markerIndex + ARTIFACT_MARKER.length;
  const lineEnd = stderr.indexOf("\n", payloadStart);
  const payloadEnd = lineEnd === -1 ? stderr.length : lineEnd;
  const encoded = stderr.slice(payloadStart, payloadEnd);
  const beforeMarker = stderr.slice(0, markerIndex);
  const visibleBeforeMarker = beforeMarker.endsWith("\n") ? beforeMarker.slice(0, -1) : beforeMarker;
  const visible = `${visibleBeforeMarker}${lineEnd === -1 ? "" : stderr.slice(lineEnd + 1)}`;
  if (Buffer.byteLength(encoded, "utf8") > EXECUTION_LIMITS.maximumArtifactTransportBytes) {
    fail("EXECUTION_ARTIFACT_INVALID", "execution artifact envelope exceeds its transport bound.", { status: 502 });
  }
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    fail("EXECUTION_ARTIFACT_INVALID", "execution artifact envelope is invalid.", { status: 502 });
  }
  if (!Array.isArray(parsed) || parsed.length > EXECUTION_LIMITS.maximumArtifacts) {
    fail("EXECUTION_ARTIFACT_INVALID", "execution artifact count is invalid.", { status: 502 });
  }
  let artifacts;
  try {
    artifacts = parsed.map((item, index) => {
      const candidate = exactObject(item, ["title", "kind", "spec"], ["title", "kind", "spec"], `execution artifact[${index}]`);
      const sanitized = sanitizeIntegrationArtifact(candidate);
      if (!request) fail("EXECUTION_ARTIFACT_INVALID", "execution artifact provenance is unavailable.", { status: 502 });
      const id = executionArtifactId(request, index, sanitized);
      return sanitizeIntegrationArtifact({
        id,
        title: sanitized.title,
        kind: sanitized.kind,
        spec: sanitized.spec,
      });
    });
  } catch {
    fail("EXECUTION_ARTIFACT_INVALID", "execution artifact envelope contains an invalid artifact.", { status: 502 });
  }
  return Object.freeze({ stderr: visible, artifacts: Object.freeze(artifacts), present: true });
}

function terminalResult({ request, status, exitCode, stdout, stderr, artifacts, durationMs, outputTruncated }) {
  if (!ALLOWED_TERMINAL_STATUSES.has(status)) {
    fail("EXECUTION_RESULT_INVALID", "execution result status is invalid.");
  }
  const unsigned = Object.freeze({
    schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
    jobId: request.jobId,
    attempt: request.attempt,
    sourceSha256: request.sourceSha256,
    status,
    exitCode,
    stdout,
    stderr,
    outputTruncated,
    durationMs,
    artifacts,
  });
  return Object.freeze({ ...unsigned, resultDigest: canonicalResultDigest(unsigned) });
}

function spawnFailure(request, started, clock) {
  return terminalResult({
    request,
    status: "sandbox_error",
    exitCode: null,
    stdout: "",
    stderr: "The isolated execution runtime could not start.",
    artifacts: Object.freeze([]),
    durationMs: Math.max(0, Math.round(clock() - started)),
    outputTruncated: false,
  });
}

function truncateUtf8Text(value, maximumBytes) {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const characters = [];
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maximumBytes) break;
    characters.push(character);
    bytes += width;
  }
  return characters.join("");
}

export function createPythonExecutionWorker({
  workerId,
  spawnImpl = nodeSpawn,
  filesystem = fs,
  clock = () => performance.now(),
  runtimeProbeImpl = probeExecutionWorkerRuntime,
  testOnlyAllowMissingSeccomp = false,
  runtimeBundleDirectory = null,
  expectedRuntimeBundleRootDigest,
  testOnlyAllowUntrustedRuntimeBundle = false,
} = {}) {
  if (typeof workerId !== "string" || !WORKER_ID.test(workerId)) {
    throw new TypeError("workerId must be an opaque worker_* identifier");
  }
  if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl must be a function");
  if (!filesystem || typeof filesystem.realpath !== "function" || typeof filesystem.stat !== "function"
      || typeof filesystem.readFile !== "function") {
    throw new TypeError("filesystem must provide realpath, stat, and readFile");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (typeof runtimeProbeImpl !== "function") throw new TypeError("runtimeProbeImpl must be a function");
  if (typeof testOnlyAllowMissingSeccomp !== "boolean") throw new TypeError("testOnlyAllowMissingSeccomp must be a boolean");
  if (runtimeBundleDirectory !== null && (typeof runtimeBundleDirectory !== "string"
      || !path.isAbsolute(runtimeBundleDirectory) || path.normalize(runtimeBundleDirectory) !== runtimeBundleDirectory)) {
    throw new TypeError("runtimeBundleDirectory must be null or a canonical absolute path");
  }
  if (typeof testOnlyAllowUntrustedRuntimeBundle !== "boolean") {
    throw new TypeError("testOnlyAllowUntrustedRuntimeBundle must be a boolean");
  }
  if (expectedRuntimeBundleRootDigest !== undefined
      && (typeof expectedRuntimeBundleRootDigest !== "string" || !DIGEST.test(expectedRuntimeBundleRootDigest))) {
    throw new TypeError("expectedRuntimeBundleRootDigest must be a contract digest");
  }
  let activeJobs = 0;
  let degraded = false;
  let runtimeInFlight = null;
  let lastRuntime = null;
  let lastRuntimeAt = Number.NEGATIVE_INFINITY;

  async function runtime({ allowRecent = false } = {}) {
    const runtimeAge = clock() - lastRuntimeAt;
    if (allowRecent && lastRuntime && (activeJobs > 0 || (runtimeAge >= 0 && runtimeAge <= RUNTIME_CAPABILITY_CACHE_MS))) {
      return lastRuntime;
    }
    runtimeInFlight ||= Promise.all([
      inspectExecutionWorkerRuntime({
        filesystem,
        runtimeBundleDirectory,
        expectedRuntimeBundleRootDigest,
        testOnlyAllowUntrustedRuntimeBundle,
      }),
      runtimeProbeImpl({
        spawnImpl,
        filesystem,
        runtimeBundleDirectory,
        expectedRuntimeBundleRootDigest,
        testOnlyAllowUntrustedRuntimeBundle,
      }),
    ]).then(([identity, proof]) => Object.freeze({
      ...identity,
      proof,
      runtimeDigest: contractDigest({ identityDigest: identity.runtimeDigest, proofDigest: proof.proofDigest }),
    })).then((inspected) => {
      lastRuntime = inspected;
      lastRuntimeAt = clock();
      return inspected;
    }).catch((error) => {
      if (error instanceof ExecutionWorkerError && error.code === "EXECUTION_TERMINATION_UNPROVEN") {
        degraded = true;
      }
      throw error;
    }).finally(() => {
      runtimeInFlight = null;
    });
    return runtimeInFlight;
  }

  async function capabilities() {
    const inspected = await runtime({ allowRecent: true });
    const activationReady = EXECUTION_PUBLIC_ACTIVATION_ENABLED
      && inspected.minimalRuntimeRoot
      && inspected.runtimeBundleDigestPinned
      && inspected.proof.seccompPolicyVerified === true
      && !degraded;
    const admission = Object.freeze({
      state: !activationReady
        ? "blocked"
        : activeJobs < EXECUTION_LIMITS.maximumConcurrentJobs ? "ready" : "busy",
      activeJobs,
      maximumConcurrentJobs: EXECUTION_LIMITS.maximumConcurrentJobs,
    });
    const capability = Object.freeze({
      schemaVersion: EXECUTION_WORKER_SCHEMA_VERSION,
      workerId,
      implementation: "aginti-execution-worker",
      implementationVersion: "1",
      runtime: Object.freeze({
        profile: inspected.profile,
        policyDigest: inspected.policyDigest,
        runtimeDigest: inspected.runtimeDigest,
        proofDigest: inspected.proof.proofDigest,
        seccomp: inspected.proof.seccomp,
        seccompPolicyVerified: inspected.proof.seccompPolicyVerified,
        seccompPolicyDigest: inspected.proof.seccompPolicyDigest,
        deniedSyscallsProven: inspected.proof.deniedSyscallsProven,
        minimalRuntimeRoot: inspected.minimalRuntimeRoot,
        runtimeBundleDigestPinned: inspected.runtimeBundleDigestPinned,
        runtimeBundleRootDigest: inspected.runtimeBundle?.rootDigest ?? null,
      }),
      languages: Object.freeze(["python"]),
      artifacts: Object.freeze({ schemaVersion: "1", kinds: Object.freeze(["plot", "table", "markdown"]) }),
      limits: EXECUTION_LIMITS,
      executionGate: Object.freeze({
        requiresVerifiedSeccompPolicy: true,
        testOnlyBypassConfigured: testOnlyAllowMissingSeccomp,
      }),
    });
    const capabilityDigest = contractDigest(capability);
    const activation = Object.freeze({
      publicReady: activationReady,
      blockers: Object.freeze(activationReady ? [] : [
        ...(!inspected.proof.seccompPolicyVerified ? ["execution-seccomp-policy-unproven"] : []),
        ...(!inspected.minimalRuntimeRoot ? ["minimal-runtime-root-unproven"] : []),
        ...(inspected.minimalRuntimeRoot && !inspected.runtimeBundleDigestPinned
          ? ["runtime-bundle-digest-unpinned"] : []),
        "aggregate-cgroup-containment-unproven",
        ...(degraded ? ["worker-termination-degraded"] : []),
        "public-activation-locked",
      ]),
    });
    const health = Object.freeze({ ready: admission.state === "ready", admission, activation });
    return Object.freeze({
      ...capability,
      ...health,
      capabilityDigest,
      healthDigest: contractDigest({ capabilityDigest, ...health }),
    });
  }

  async function execute(input, { signal } = {}) {
    const request = validateExecutionJobRequest(input);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
    if (signal?.aborted) {
      return terminalResult({
        request,
        status: "cancelled",
        exitCode: null,
        stdout: "",
        stderr: "",
        artifacts: Object.freeze([]),
        durationMs: 0,
        outputTruncated: false,
      });
    }
    if (degraded) {
      fail("EXECUTION_UNAVAILABLE", "execution worker requires restart after an unproven termination.", { status: 503 });
    }
    if (activeJobs >= EXECUTION_LIMITS.maximumConcurrentJobs) {
      fail("EXECUTION_BUSY", "execution worker has no available slot.", { status: 429 });
    }
    activeJobs += 1;
    let inspected;
    try {
      inspected = await runtime();
    } catch (error) {
      activeJobs -= 1;
      throw error;
    }
    if ((!EXECUTION_PUBLIC_ACTIVATION_ENABLED || !inspected.minimalRuntimeRoot
        || !inspected.runtimeBundleDigestPinned
        || !inspected.proof.seccompPolicyVerified) && !testOnlyAllowMissingSeccomp) {
      activeJobs -= 1;
      fail("EXECUTION_UNAVAILABLE", "execution requires the hardened service boundary.", { status: 503 });
    }
    if (signal?.aborted) {
      activeJobs -= 1;
      return terminalResult({
        request,
        status: "cancelled",
        exitCode: null,
        stdout: "",
        stderr: "",
        artifacts: Object.freeze([]),
        durationMs: 0,
        outputTruncated: false,
      });
    }
    const started = clock();
    const command = buildExecutionWorkerCommand({ runtimeRoot: inspected.runtimeBundle?.rootPath ?? null });
    let child;
    try {
      child = spawnImpl(command.command, command.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: Object.freeze({ PATH: "/usr/bin" }),
      });
    } catch (error) {
      activeJobs -= 1;
      return spawnFailure(request, started, clock);
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    const transport = { bytes: 0, exceeded: false };
    let timedOut = false;
    let cancelled = false;
    let ioFailed = false;
    let settled = false;
    let childError = null;
    const termination = createTerminationSupervisor(child);
    const kill = () => {
      if (!settled) termination.terminate();
    };
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, request.timeoutMs);

    child.stdout?.on("data", (chunk) => collectBounded(stdoutChunks, transport, chunk, MAX_TRANSPORT_BYTES, kill));
    child.stderr?.on("data", (chunk) => collectBounded(stderrChunks, transport, chunk, MAX_TRANSPORT_BYTES, kill));
    const onIoError = () => {
      ioFailed = true;
      kill();
    };
    child.stdin?.on?.("error", onIoError);
    child.stdout?.on?.("error", onIoError);
    child.stderr?.on?.("error", onIoError);

    const completion = new Promise((resolve) => {
      child.once?.("error", (error) => {
        childError = error;
        kill();
      });
      child.once?.("close", (code, childSignal) => resolve({ error: childError, code, signal: childSignal }));
    });
    try {
      const payload = JSON.stringify({ source: request.source, stdin: request.stdin });
      child.stdin?.end(payload, "utf8");
    } catch {
      kill();
    }

    try {
      const completed = await Promise.race([completion, termination.forced]);
      settled = true;
      const durationMs = Math.max(0, Math.round(clock() - started));
      if (completed.terminationUnproven) {
        degraded = true;
        abandonChildStreams(child);
        return terminalResult({
          request,
          status: "termination_unproven",
          exitCode: null,
          stdout: "",
          stderr: "The isolated execution process could not be proven stopped.",
          artifacts: Object.freeze([]),
          durationMs,
          outputTruncated: transport.exceeded,
        });
      }
      termination.clear();
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      let decodedStdout = stdout.toString("utf8");
      let decodedStderr = stderr.toString("utf8");
      let artifacts = Object.freeze([]);
      let artifactInvalid = false;
      try {
        const envelope = artifactEnvelope(decodedStderr, { request });
        decodedStderr = envelope.stderr;
        artifacts = envelope.artifacts;
      } catch (error) {
        if (!(error instanceof ExecutionWorkerError) || error.code !== "EXECUTION_ARTIFACT_INVALID") throw error;
        artifactInvalid = true;
        decodedStderr = "The execution returned an invalid artifact envelope.";
      }
      const outputBytes = Buffer.byteLength(decodedStdout, "utf8") + Buffer.byteLength(decodedStderr, "utf8");
      const outputTruncated = transport.exceeded || outputBytes > EXECUTION_LIMITS.maximumOutputBytes;
      if (outputBytes > EXECUTION_LIMITS.maximumOutputBytes) {
        const remaining = Math.max(0, EXECUTION_LIMITS.maximumOutputBytes - Buffer.byteLength(decodedStdout, "utf8"));
        if (Buffer.byteLength(decodedStdout, "utf8") > EXECUTION_LIMITS.maximumOutputBytes) {
          decodedStdout = truncateUtf8Text(decodedStdout, EXECUTION_LIMITS.maximumOutputBytes);
          decodedStderr = "";
        } else {
          decodedStderr = truncateUtf8Text(decodedStderr, remaining);
        }
      }
      let status;
      if (cancelled || signal?.aborted) status = "cancelled";
      else if (timedOut) status = "timed_out";
      else if (transport.exceeded || outputTruncated) status = "output_limited";
      else if (artifactInvalid) status = "artifact_invalid";
      else if (ioFailed || completed.error) status = "sandbox_error";
      else status = completed.code === 0 ? "succeeded" : "failed";
      return terminalResult({
        request,
        status,
        exitCode: Number.isInteger(completed.code) ? completed.code : null,
        stdout: decodedStdout,
        stderr: decodedStderr,
        artifacts: status === "succeeded" ? artifacts : Object.freeze([]),
        durationMs,
        outputTruncated,
      });
    } finally {
      settled = true;
      clearTimeout(timer);
      termination.clear();
      signal?.removeEventListener("abort", onAbort);
      activeJobs -= 1;
    }
  }

  return Object.freeze({
    kind: testOnlyAllowMissingSeccomp ? "aginti-execution-worker-test-only" : "aginti-execution-worker",
    workerId,
    testOnlyBypassActive: testOnlyAllowMissingSeccomp,
    capabilities,
    execute,
  });
}
