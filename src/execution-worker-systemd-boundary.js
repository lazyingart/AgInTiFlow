import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  EXECUTION_RUNTIME_BUNDLE_MANIFEST,
  EXECUTION_RUNTIME_BUNDLE_PRODUCTION_ROOT,
  EXECUTION_RUNTIME_BUNDLE_ROOT,
  validateExecutionRuntimeBundle,
} from "./execution-runtime-bundle.js";

export const EXECUTION_WORKER_SYSTEMD_BOUNDARY_SCHEMA_VERSION =
  "aginti-execution-worker-systemd-boundary-v1";
export const EXECUTION_WORKER_SERVICE_UNIT = "aginti-execution-worker.service";
export const EXECUTION_WORKER_SOCKET_UNIT = "aginti-execution-worker.socket";
export const EXECUTION_WORKER_SOCKET_FD_NAME = "execution-worker-http";
export const EXECUTION_WORKER_CREDENTIAL_NAME = "execution-worker-token";
export const EXECUTION_WORKER_LISTEN_HOST = "127.0.0.1";
export const EXECUTION_WORKER_LISTEN_PORT = 18_130;
export const EXECUTION_WORKER_SYSTEMD_FD = 3;
export const EXECUTION_WORKER_SYSTEM_USER = "aginti-execution";
export const EXECUTION_WORKER_SYSTEM_GROUP = "aginti-execution";
export const EXECUTION_WORKER_RELEASE_ROOT = "/opt/aginti-execution-worker/releases";
export const EXECUTION_WORKER_NODE_PATH = "/usr/bin/node";
export const EXECUTION_WORKER_CREDENTIAL_SOURCE =
  "/etc/aginti-execution-worker/credentials/execution-worker-token";
export const EXECUTION_WORKER_SYSTEMD_UNIT_DIRECTORY = "/etc/systemd/system";
export const EXECUTION_WORKER_SYSTEMD_LOAD_PATHS = Object.freeze([
  "/etc/systemd/system.control",
  "/run/systemd/system.control",
  "/run/systemd/transient",
  "/run/systemd/generator.early",
  "/etc/systemd/system",
  "/etc/systemd/system.attached",
  "/run/systemd/system",
  "/run/systemd/system.attached",
  "/run/systemd/generator",
  "/usr/local/lib/systemd/system",
  "/usr/lib/systemd/system",
  "/run/systemd/generator.late",
]);
export const EXECUTION_WORKER_EXPECTED_CGROUP =
  `/system.slice/${EXECUTION_WORKER_SERVICE_UNIT}`;

export const EXECUTION_WORKER_CGROUP_LIMITS = Object.freeze({
  memoryMaxBytes: 1_536 * 1024 * 1024,
  memorySwapMaxBytes: 0,
  tasksMax: 64,
  cpuQuotaMicros: 200_000,
  cpuPeriodMicros: 100_000,
  memoryOomGroup: 1,
});

export const EXECUTION_WORKER_CGROUP_POLICY = Object.freeze({
  schemaVersion: "aginti-execution-worker-cgroup-policy-v1",
  cgroupVersion: 2,
  unit: EXECUTION_WORKER_SERVICE_UNIT,
  cgroupPath: EXECUTION_WORKER_EXPECTED_CGROUP,
  cgroupType: "domain",
  aggregateDescendants: true,
  ...EXECUTION_WORKER_CGROUP_LIMITS,
});
export const EXECUTION_WORKER_CGROUP_POLICY_DIGEST = sha256(
  JSON.stringify(EXECUTION_WORKER_CGROUP_POLICY)
);

const DIGEST = /^[a-f0-9]{64}$/u;
const RELEASE_ENTRYPOINT_RELATIVE = "bin/aginti-execution-worker.js";
const TOKEN = /^[A-Za-z0-9._~-]{32,256}$/u;
const MAX_CONTROL_FILE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_BYTES = 4 * 1024;
const REQUIRED_CONTROLLERS = Object.freeze(["cpu", "memory", "pids"]);

export class ExecutionWorkerSystemdBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionWorkerSystemdBoundaryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExecutionWorkerSystemdBoundaryError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validateDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${label} must be a lowercase sha256 digest`);
  }
  return value;
}

function deploymentPaths({ workerReleaseDigest, runtimeBundleDigest }) {
  validateDigest(workerReleaseDigest, "workerReleaseDigest");
  validateDigest(runtimeBundleDigest, "runtimeBundleDigest");
  const workerReleaseDirectory = path.posix.join(EXECUTION_WORKER_RELEASE_ROOT, workerReleaseDigest);
  const runtimeBundleDirectory = path.posix.join(
    EXECUTION_RUNTIME_BUNDLE_PRODUCTION_ROOT,
    runtimeBundleDigest
  );
  return Object.freeze({
    workerReleaseDirectory,
    workerEntrypoint: path.posix.join(workerReleaseDirectory, RELEASE_ENTRYPOINT_RELATIVE),
    runtimeBundleDirectory,
    runtimeBundleRoot: path.posix.join(runtimeBundleDirectory, EXECUTION_RUNTIME_BUNDLE_ROOT),
    runtimeBundleManifest: path.posix.join(runtimeBundleDirectory, EXECUTION_RUNTIME_BUNDLE_MANIFEST),
  });
}

function renderSocketUnit() {
  return `[Unit]
Description=AgInTi isolated execution worker socket
Before=${EXECUTION_WORKER_SERVICE_UNIT}

[Socket]
ListenStream=${EXECUTION_WORKER_LISTEN_HOST}:${EXECUTION_WORKER_LISTEN_PORT}
FileDescriptorName=${EXECUTION_WORKER_SOCKET_FD_NAME}
Service=${EXECUTION_WORKER_SERVICE_UNIT}
Accept=no
NoDelay=yes
KeepAlive=yes
FreeBind=no
ReusePort=no
Backlog=128
MaxConnections=128
MaxConnectionsPerSource=32
TriggerLimitIntervalSec=30s
TriggerLimitBurst=10
FlushPending=yes

[Install]
WantedBy=sockets.target
`;
}

function renderServiceUnit({ workerReleaseDigest, runtimeBundleDigest }) {
  const paths = deploymentPaths({ workerReleaseDigest, runtimeBundleDigest });
  const execStart = [
    EXECUTION_WORKER_NODE_PATH,
    "--disable-proto=throw",
    paths.workerEntrypoint,
  ].join(" ");
  return `[Unit]
Description=AgInTi capability-locked execution worker
Requires=${EXECUTION_WORKER_SOCKET_UNIT}
After=${EXECUTION_WORKER_SOCKET_UNIT}
StartLimitIntervalSec=30s
StartLimitBurst=3

[Service]
Type=exec
User=${EXECUTION_WORKER_SYSTEM_USER}
Group=${EXECUTION_WORKER_SYSTEM_GROUP}
SupplementaryGroups=
Slice=system.slice
Sockets=${EXECUTION_WORKER_SOCKET_UNIT}
ExecStart=${execStart}
LoadCredential=${EXECUTION_WORKER_CREDENTIAL_NAME}:${EXECUTION_WORKER_CREDENTIAL_SOURCE}
Environment=AGINTI_EXECUTION_RUNTIME_BUNDLE_DIRECTORY=${paths.runtimeBundleDirectory}
Environment=AGINTI_EXECUTION_RUNTIME_BUNDLE_DIGEST=${runtimeBundleDigest}
WorkingDirectory=/
UMask=0077
StandardInput=null
StandardOutput=journal
StandardError=journal
SyslogIdentifier=aginti-execution-worker
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
SecureBits=noroot-locked
PrivateTmp=yes
PrivateDevices=yes
PrivateNetwork=yes
PrivateIPC=yes
PrivateMounts=yes
PrivateUsers=no
ProtectSystem=strict
ProtectHome=yes
ProtectControlGroups=yes
ProtectKernelTunables=no
ProtectKernelModules=yes
ProtectKernelLogs=no
ProtectClock=yes
ProtectHostname=no
ProtectProc=default
ProcSubset=all
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RemoveIPC=yes
KeyringMode=private
DevicePolicy=closed
RestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK
InaccessiblePaths=/home /root /media /mnt
ReadOnlyPaths=${paths.workerReleaseDirectory} ${paths.runtimeBundleDirectory}
Delegate=no
CPUAccounting=yes
MemoryAccounting=yes
TasksAccounting=yes
CPUQuota=200%
CPUQuotaPeriodSec=100ms
MemoryMax=${EXECUTION_WORKER_CGROUP_LIMITS.memoryMaxBytes}
MemorySwapMax=${EXECUTION_WORKER_CGROUP_LIMITS.memorySwapMaxBytes}
TasksMax=${EXECUTION_WORKER_CGROUP_LIMITS.tasksMax}
LimitNPROC=${EXECUTION_WORKER_CGROUP_LIMITS.tasksMax}
OOMPolicy=kill
KillMode=control-group
TimeoutStartSec=10s
TimeoutStopSec=5s
Restart=on-failure
RestartSec=2s

[Install]
WantedBy=multi-user.target
`;
}

export function createExecutionWorkerSystemdUnits({
  workerReleaseDigest,
  runtimeBundleDigest,
} = {}) {
  const paths = deploymentPaths({ workerReleaseDigest, runtimeBundleDigest });
  const socketUnit = renderSocketUnit();
  const serviceUnit = renderServiceUnit({ workerReleaseDigest, runtimeBundleDigest });
  return Object.freeze({
    schemaVersion: EXECUTION_WORKER_SYSTEMD_BOUNDARY_SCHEMA_VERSION,
    serviceUnitName: EXECUTION_WORKER_SERVICE_UNIT,
    socketUnitName: EXECUTION_WORKER_SOCKET_UNIT,
    socketUnit,
    serviceUnit,
    socketUnitSha256: sha256(socketUnit),
    serviceUnitSha256: sha256(serviceUnit),
    listener: Object.freeze({
      host: EXECUTION_WORKER_LISTEN_HOST,
      port: EXECUTION_WORKER_LISTEN_PORT,
      fd: EXECUTION_WORKER_SYSTEMD_FD,
      fdName: EXECUTION_WORKER_SOCKET_FD_NAME,
    }),
    credential: Object.freeze({
      name: EXECUTION_WORKER_CREDENTIAL_NAME,
      sourcePath: EXECUTION_WORKER_CREDENTIAL_SOURCE,
      delivery: "systemd-LoadCredential",
    }),
    cgroup: Object.freeze({
      unit: EXECUTION_WORKER_SERVICE_UNIT,
      path: EXECUTION_WORKER_EXPECTED_CGROUP,
      policyDigest: EXECUTION_WORKER_CGROUP_POLICY_DIGEST,
      ...EXECUTION_WORKER_CGROUP_LIMITS,
    }),
    deployment: paths,
  });
}

function validateUnitBytes(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_CONTROL_FILE_BYTES
      || !value.endsWith("\n") || value.includes("\r") || value.includes("\0")) {
    fail("EXECUTION_SYSTEMD_UNIT_INVALID", `${label} is not canonical systemd unit text.`);
  }
}

export function validateExecutionWorkerSystemdUnits({
  workerReleaseDigest,
  runtimeBundleDigest,
  socketUnit,
  serviceUnit,
} = {}) {
  validateUnitBytes(socketUnit, "socketUnit");
  validateUnitBytes(serviceUnit, "serviceUnit");
  const expected = createExecutionWorkerSystemdUnits({ workerReleaseDigest, runtimeBundleDigest });
  if (socketUnit !== expected.socketUnit || serviceUnit !== expected.serviceUnit) {
    fail(
      "EXECUTION_SYSTEMD_UNIT_POLICY_MISMATCH",
      "execution worker units do not exactly match the hardened deterministic policy."
    );
  }
  return Object.freeze({
    schemaVersion: EXECUTION_WORKER_SYSTEMD_BOUNDARY_SCHEMA_VERSION,
    valid: true,
    socketUnitSha256: expected.socketUnitSha256,
    serviceUnitSha256: expected.serviceUnitSha256,
    listener: expected.listener,
    credential: expected.credential,
    cgroup: expected.cgroup,
    deployment: expected.deployment,
  });
}

async function readBounded(filesystem, filePath, maximumBytes = MAX_CONTROL_FILE_BYTES) {
  let content;
  try {
    content = await filesystem.readFile(filePath);
  } catch {
    fail("EXECUTION_BOUNDARY_READ_FAILED", "a required execution boundary file could not be read.");
  }
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  if (buffer.byteLength < 1 || buffer.byteLength > maximumBytes || buffer.includes(0)) {
    fail("EXECUTION_BOUNDARY_FILE_INVALID", "an execution boundary file has invalid size or content.");
  }
  return buffer;
}

function splitCanonicalLines(buffer, label) {
  const value = buffer.toString("utf8");
  if (value.includes("\ufffd") || value.includes("\r") || !value.endsWith("\n")) {
    fail("EXECUTION_BOUNDARY_FILE_INVALID", `${label} is not canonical text.`);
  }
  return value.slice(0, -1).split("\n");
}

function exactScalar(buffer, expected, label) {
  const lines = splitCanonicalLines(buffer, label);
  if (lines.length !== 1 || lines[0] !== String(expected)) {
    fail("EXECUTION_CGROUP_POLICY_MISMATCH", `${label} does not match execution policy.`);
  }
  return lines[0];
}

function parseBoundedCounter(buffer, label, maximum) {
  const lines = splitCanonicalLines(buffer, label);
  if (lines.length !== 1 || !/^(?:0|[1-9][0-9]*)$/u.test(lines[0])) {
    fail("EXECUTION_CGROUP_POLICY_MISMATCH", `${label} is not a canonical counter.`);
  }
  const value = Number(lines[0]);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail("EXECUTION_CGROUP_POLICY_MISMATCH", `${label} exceeds execution policy.`);
  }
  return value;
}

function parseControllers(buffer) {
  const lines = splitCanonicalLines(buffer, "cgroup.controllers");
  if (lines.length !== 1) {
    fail("EXECUTION_CGROUP_V2_REQUIRED", "cgroup v2 controller metadata is malformed.");
  }
  const controllers = lines[0] ? lines[0].split(" ") : [];
  if (controllers.some((value) => !/^[a-z][a-z0-9_]*$/u.test(value))
      || new Set(controllers).size !== controllers.length
      || REQUIRED_CONTROLLERS.some((value) => !controllers.includes(value))) {
    fail("EXECUTION_CGROUP_V2_REQUIRED", "required cgroup v2 controllers are unavailable.");
  }
  return Object.freeze([...controllers].sort());
}

function parsePidList(buffer, expectedPid) {
  const lines = splitCanonicalLines(buffer, "cgroup.procs");
  if (lines.length < 1 || lines.some((value) => !/^[1-9][0-9]*$/u.test(value))) {
    fail("EXECUTION_CGROUP_IDENTITY_MISMATCH", "execution cgroup process membership is malformed.");
  }
  const pids = lines.map(Number);
  if (!pids.every(Number.isSafeInteger) || !pids.includes(expectedPid)) {
    fail("EXECUTION_CGROUP_IDENTITY_MISMATCH", "the current worker is not in the expected service cgroup.");
  }
  return Object.freeze(pids);
}

export async function attestExecutionWorkerCgroup({
  filesystem = fs,
  procRoot = "/proc",
  cgroupRoot = "/sys/fs/cgroup",
  pid = process.pid,
} = {}) {
  if (!filesystem || typeof filesystem.readFile !== "function") {
    throw new TypeError("filesystem must provide readFile");
  }
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError("pid must be a positive integer");
  if (procRoot !== "/proc" || cgroupRoot !== "/sys/fs/cgroup") {
    throw new TypeError("execution cgroup attestation paths are fixed");
  }
  const membership = await readBounded(filesystem, path.posix.join(procRoot, "self/cgroup"));
  exactScalar(membership, `0::${EXECUTION_WORKER_EXPECTED_CGROUP}`, "proc cgroup identity");
  const cgroupDirectory = path.posix.join(cgroupRoot, EXECUTION_WORKER_EXPECTED_CGROUP.slice(1));
  const [
    controllersRaw,
    typeRaw,
    memoryMaxRaw,
    memorySwapMaxRaw,
    tasksMaxRaw,
    cpuMaxRaw,
    oomGroupRaw,
    memoryCurrentRaw,
    memorySwapCurrentRaw,
    tasksCurrentRaw,
    processesRaw,
  ] = await Promise.all([
    readBounded(filesystem, path.posix.join(cgroupRoot, "cgroup.controllers")),
    readBounded(filesystem, path.posix.join(cgroupDirectory, "cgroup.type")),
    readBounded(filesystem, path.posix.join(cgroupDirectory, "memory.max")),
    readBounded(filesystem, path.posix.join(cgroupDirectory, "memory.swap.max")),
    readBounded(filesystem, path.posix.join(cgroupDirectory, "pids.max")),
    readBounded(filesystem, path.posix.join(cgroupDirectory, "cpu.max")),
    readBounded(filesystem, path.posix.join(cgroupDirectory, "memory.oom.group")),
    readBounded(filesystem, path.posix.join(cgroupDirectory, "memory.current")),
    readBounded(filesystem, path.posix.join(cgroupDirectory, "memory.swap.current")),
    readBounded(filesystem, path.posix.join(cgroupDirectory, "pids.current")),
    readBounded(filesystem, path.posix.join(cgroupDirectory, "cgroup.procs")),
  ]);
  const controllers = parseControllers(controllersRaw);
  exactScalar(typeRaw, "domain", "cgroup.type");
  exactScalar(memoryMaxRaw, EXECUTION_WORKER_CGROUP_LIMITS.memoryMaxBytes, "memory.max");
  exactScalar(memorySwapMaxRaw, EXECUTION_WORKER_CGROUP_LIMITS.memorySwapMaxBytes, "memory.swap.max");
  exactScalar(tasksMaxRaw, EXECUTION_WORKER_CGROUP_LIMITS.tasksMax, "pids.max");
  exactScalar(
    cpuMaxRaw,
    `${EXECUTION_WORKER_CGROUP_LIMITS.cpuQuotaMicros} ${EXECUTION_WORKER_CGROUP_LIMITS.cpuPeriodMicros}`,
    "cpu.max"
  );
  exactScalar(oomGroupRaw, EXECUTION_WORKER_CGROUP_LIMITS.memoryOomGroup, "memory.oom.group");
  const memoryCurrentBytes = parseBoundedCounter(
    memoryCurrentRaw,
    "memory.current",
    EXECUTION_WORKER_CGROUP_LIMITS.memoryMaxBytes
  );
  const memorySwapCurrentBytes = parseBoundedCounter(
    memorySwapCurrentRaw,
    "memory.swap.current",
    EXECUTION_WORKER_CGROUP_LIMITS.memorySwapMaxBytes
  );
  const tasksCurrent = parseBoundedCounter(
    tasksCurrentRaw,
    "pids.current",
    EXECUTION_WORKER_CGROUP_LIMITS.tasksMax
  );
  const memberPids = parsePidList(processesRaw, pid);
  const evidence = Object.freeze({
    schemaVersion: EXECUTION_WORKER_SYSTEMD_BOUNDARY_SCHEMA_VERSION,
    unit: EXECUTION_WORKER_SERVICE_UNIT,
    cgroupPath: EXECUTION_WORKER_EXPECTED_CGROUP,
    cgroupType: "domain",
    aggregateDescendantContainment: true,
    controllers,
    limits: EXECUTION_WORKER_CGROUP_LIMITS,
    usage: Object.freeze({ memoryCurrentBytes, memorySwapCurrentBytes, tasksCurrent }),
    currentPid: pid,
    memberPids,
    cgroupPolicyDigest: EXECUTION_WORKER_CGROUP_POLICY_DIGEST,
    containment: Object.freeze({
      aggregateCgroupVerified: true,
      cgroupPolicyDigest: EXECUTION_WORKER_CGROUP_POLICY_DIGEST,
      exactUnitIdentityVerified: true,
      currentProcessMembershipVerified: true,
      hierarchicalDescendantLimitsVerified: true,
    }),
  });
  return Object.freeze({ ...evidence, evidenceSha256: sha256(JSON.stringify(evidence)) });
}

export const attestExecutionWorkerCgroupBoundary = attestExecutionWorkerCgroup;

export function attestExecutionWorkerActivationEnvironment({ env = process.env, pid = process.pid } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError("pid must be a positive integer");
  const expectedCredentialDirectory = `/run/credentials/${EXECUTION_WORKER_SERVICE_UNIT}`;
  if (!env || env.LISTEN_PID !== String(pid) || env.LISTEN_FDS !== "1"
      || env.LISTEN_FDNAMES !== EXECUTION_WORKER_SOCKET_FD_NAME
      || env.CREDENTIALS_DIRECTORY !== expectedCredentialDirectory) {
    fail(
      "EXECUTION_SYSTEMD_ACTIVATION_MISMATCH",
      "worker activation does not match its one fixed systemd socket and credential directory."
    );
  }
  return Object.freeze({
    systemdActivated: true,
    fd: EXECUTION_WORKER_SYSTEMD_FD,
    fdName: EXECUTION_WORKER_SOCKET_FD_NAME,
    credentialPath: path.posix.join(expectedCredentialDirectory, EXECUTION_WORKER_CREDENTIAL_NAME),
  });
}

function pathComponents(absolutePath) {
  if (typeof absolutePath !== "string" || !path.posix.isAbsolute(absolutePath)
      || path.posix.normalize(absolutePath) !== absolutePath || absolutePath.includes("\0")) {
    throw new TypeError("trusted deployment path must be canonical and absolute");
  }
  const parts = absolutePath.split("/").filter(Boolean);
  const result = ["/"];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    result.push(current);
  }
  return result;
}

async function attestRootControlledPath(filesystem, targetPath, expectedType, { exactMode } = {}) {
  const components = pathComponents(targetPath);
  let targetStat;
  for (let index = 0; index < components.length; index += 1) {
    let stat;
    try {
      stat = await filesystem.lstat(components[index]);
    } catch {
      fail("EXECUTION_DEPLOYMENT_INPUT_UNTRUSTED", "a deployment path component is unavailable.");
    }
    const isTarget = index === components.length - 1;
    if (stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022) !== 0
        || (!isTarget && !stat.isDirectory())) {
      fail("EXECUTION_DEPLOYMENT_INPUT_UNTRUSTED", "a deployment path is not root-controlled.");
    }
    if (isTarget) targetStat = stat;
  }
  if ((expectedType === "file" && !targetStat.isFile())
      || (expectedType === "directory" && !targetStat.isDirectory())
      || (exactMode !== undefined && (targetStat.mode & 0o7777) !== exactMode)) {
    fail("EXECUTION_DEPLOYMENT_INPUT_UNTRUSTED", "a deployment input has unexpected metadata.");
  }
  return targetStat;
}

export async function attestExecutionWorkerDeploymentInputs({
  workerReleaseDigest,
  runtimeBundleDigest,
  filesystem = fs,
  runtimeBundleValidator = validateExecutionRuntimeBundle,
} = {}) {
  if (!filesystem || typeof filesystem.lstat !== "function" || typeof filesystem.readFile !== "function") {
    throw new TypeError("filesystem must provide lstat and readFile");
  }
  if (typeof runtimeBundleValidator !== "function") {
    throw new TypeError("runtimeBundleValidator must be a function");
  }
  const paths = deploymentPaths({ workerReleaseDigest, runtimeBundleDigest });
  await Promise.all([
    attestRootControlledPath(filesystem, EXECUTION_WORKER_NODE_PATH, "file"),
    attestRootControlledPath(filesystem, paths.workerReleaseDirectory, "directory", { exactMode: 0o755 }),
    attestRootControlledPath(filesystem, paths.workerEntrypoint, "file"),
    attestRootControlledPath(filesystem, paths.runtimeBundleDirectory, "directory"),
    attestRootControlledPath(filesystem, paths.runtimeBundleRoot, "directory", { exactMode: 0o555 }),
    attestRootControlledPath(filesystem, paths.runtimeBundleManifest, "file", { exactMode: 0o444 }),
    attestRootControlledPath(filesystem, EXECUTION_WORKER_CREDENTIAL_SOURCE, "file", { exactMode: 0o400 }),
  ]);
  const [nodeStat, entrypointStat] = await Promise.all([
    filesystem.lstat(EXECUTION_WORKER_NODE_PATH),
    filesystem.lstat(paths.workerEntrypoint),
  ]);
  if ((nodeStat.mode & 0o005) !== 0o005 || (entrypointStat.mode & 0o005) !== 0o005) {
    fail(
      "EXECUTION_DEPLOYMENT_INPUT_UNTRUSTED",
      "worker launch files must be readable and executable by the dedicated service user."
    );
  }
  const credential = await readBounded(
    filesystem,
    EXECUTION_WORKER_CREDENTIAL_SOURCE,
    MAX_CREDENTIAL_BYTES
  );
  const credentialRaw = credential.toString("utf8");
  const credentialText = credentialRaw.endsWith("\n") ? credentialRaw.slice(0, -1) : credentialRaw;
  if (!TOKEN.test(credentialText) || credentialText.includes("\n")) {
    fail("EXECUTION_DEPLOYMENT_CREDENTIAL_INVALID", "execution worker credential is not a canonical opaque token.");
  }
  let runtime;
  try {
    runtime = await runtimeBundleValidator({
      bundleDirectory: paths.runtimeBundleDirectory,
      filesystem,
      expectedRootDigest: runtimeBundleDigest,
    });
  } catch {
    fail("EXECUTION_RUNTIME_BUNDLE_ATTESTATION_FAILED", "runtime bundle validation failed.");
  }
  if (!runtime || runtime.bundleDirectory !== paths.runtimeBundleDirectory
      || runtime.rootPath !== paths.runtimeBundleRoot || runtime.rootDigest !== runtimeBundleDigest) {
    fail("EXECUTION_RUNTIME_BUNDLE_ATTESTATION_FAILED", "runtime bundle identity does not match deployment policy.");
  }
  return Object.freeze({
    schemaVersion: EXECUTION_WORKER_SYSTEMD_BOUNDARY_SCHEMA_VERSION,
    rootControlled: true,
    workerReleaseDigest,
    runtimeBundleDigest,
    deployment: paths,
    runtime: Object.freeze({
      bundleDirectory: runtime.bundleDirectory,
      rootPath: runtime.rootPath,
      rootDigest: runtime.rootDigest,
      profile: runtime.profile,
    }),
    credential: Object.freeze({
      name: EXECUTION_WORKER_CREDENTIAL_NAME,
      sourcePath: EXECUTION_WORKER_CREDENTIAL_SOURCE,
      deliveredBy: "systemd-LoadCredential",
      valueDisclosed: false,
    }),
  });
}

export async function attestInstalledExecutionWorkerUnits({
  workerReleaseDigest,
  runtimeBundleDigest,
  filesystem = fs,
} = {}) {
  if (!filesystem || typeof filesystem.lstat !== "function" || typeof filesystem.readFile !== "function"
      || typeof filesystem.readdir !== "function") {
    throw new TypeError("filesystem must provide lstat, readFile, and readdir");
  }
  const expected = createExecutionWorkerSystemdUnits({ workerReleaseDigest, runtimeBundleDigest });
  const socketPath = path.posix.join(EXECUTION_WORKER_SYSTEMD_UNIT_DIRECTORY, EXECUTION_WORKER_SOCKET_UNIT);
  const servicePath = path.posix.join(EXECUTION_WORKER_SYSTEMD_UNIT_DIRECTORY, EXECUTION_WORKER_SERVICE_UNIT);
  await Promise.all([
    attestRootControlledPath(filesystem, socketPath, "file", { exactMode: 0o644 }),
    attestRootControlledPath(filesystem, servicePath, "file", { exactMode: 0o644 }),
  ]);
  for (const loadPath of EXECUTION_WORKER_SYSTEMD_LOAD_PATHS) {
    for (const unitName of [EXECUTION_WORKER_SOCKET_UNIT, EXECUTION_WORKER_SERVICE_UNIT]) {
      const unitPath = path.posix.join(loadPath, unitName);
      if (loadPath !== EXECUTION_WORKER_SYSTEMD_UNIT_DIRECTORY) {
        try {
          await filesystem.lstat(unitPath);
          fail(
            "EXECUTION_SYSTEMD_OVERRIDE_PRESENT",
            "an alternate execution worker unit exists in the system manager load path."
          );
        } catch (error) {
          if (error instanceof ExecutionWorkerSystemdBoundaryError) throw error;
          if (error?.code !== "ENOENT") {
            fail("EXECUTION_BOUNDARY_READ_FAILED", "the systemd unit load path could not be inspected.");
          }
        }
      }
      const dropInPath = `${unitPath}.d`;
      let entries;
      try {
        entries = await filesystem.readdir(dropInPath);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        fail("EXECUTION_BOUNDARY_READ_FAILED", "the systemd unit drop-in path could not be inspected.");
      }
      if (!Array.isArray(entries) || entries.length !== 0) {
        fail(
          "EXECUTION_SYSTEMD_OVERRIDE_PRESENT",
          "execution worker unit drop-ins are forbidden by the exact unit policy."
        );
      }
    }
  }
  const [socketBytes, serviceBytes] = await Promise.all([
    readBounded(filesystem, socketPath),
    readBounded(filesystem, servicePath),
  ]);
  const validated = validateExecutionWorkerSystemdUnits({
    workerReleaseDigest,
    runtimeBundleDigest,
    socketUnit: socketBytes.toString("utf8"),
    serviceUnit: serviceBytes.toString("utf8"),
  });
  return Object.freeze({
    ...validated,
    installed: true,
    socketPath,
    servicePath,
  });
}
