import assert from "node:assert/strict";

import {
  EXECUTION_WORKER_CGROUP_LIMITS,
  EXECUTION_WORKER_CGROUP_POLICY_DIGEST,
  EXECUTION_WORKER_CREDENTIAL_NAME,
  EXECUTION_WORKER_CREDENTIAL_SOURCE,
  EXECUTION_WORKER_EXPECTED_CGROUP,
  EXECUTION_WORKER_LISTEN_HOST,
  EXECUTION_WORKER_LISTEN_PORT,
  EXECUTION_WORKER_NODE_PATH,
  EXECUTION_WORKER_SERVICE_UNIT,
  EXECUTION_WORKER_SOCKET_FD_NAME,
  EXECUTION_WORKER_SOCKET_UNIT,
  EXECUTION_WORKER_SYSTEMD_BOUNDARY_SCHEMA_VERSION,
  EXECUTION_WORKER_SYSTEMD_UNIT_DIRECTORY,
  ExecutionWorkerSystemdBoundaryError,
  attestExecutionWorkerActivationEnvironment,
  attestExecutionWorkerCgroup,
  attestExecutionWorkerCgroupBoundary,
  attestExecutionWorkerDeploymentInputs,
  attestInstalledExecutionWorkerUnits,
  createExecutionWorkerSystemdUnits,
  validateExecutionWorkerSystemdUnits,
} from "../src/execution-worker-systemd-boundary.js";
import {
  EXECUTION_WORKER_CREDENTIAL_NAME as SERVER_CREDENTIAL_NAME,
  EXECUTION_WORKER_SYSTEMD_UNIT as SERVER_SYSTEMD_UNIT,
} from "../src/execution-worker-server.js";

const WORKER_RELEASE_DIGEST = "a".repeat(64);
const RUNTIME_BUNDLE_DIGEST = "b".repeat(64);
const TEST_PID = 42_424;

async function expectCode(operation, code) {
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ExecutionWorkerSystemdBoundaryError, `expected ${code}`);
  assert.equal(caught.code, code);
}

class FakeFilesystem {
  constructor() {
    this.entries = new Map();
  }

  addDirectory(targetPath, { mode = 0o755, uid = 0, gid = 0, symbolicLink = false } = {}) {
    this.entries.set(targetPath, {
      type: "directory",
      mode,
      uid,
      gid,
      symbolicLink,
      content: null,
    });
    return this;
  }

  addDirectoryChain(targetPath, options = {}) {
    let current = "";
    this.addDirectory("/", options.root ?? {});
    for (const component of targetPath.split("/").filter(Boolean)) {
      current += `/${component}`;
      if (!this.entries.has(current)) this.addDirectory(current, options.directory ?? {});
    }
    return this;
  }

  addFile(targetPath, content, { mode = 0o444, uid = 0, gid = 0, symbolicLink = false } = {}) {
    const parent = targetPath.slice(0, targetPath.lastIndexOf("/")) || "/";
    this.addDirectoryChain(parent);
    this.entries.set(targetPath, {
      type: "file",
      mode,
      uid,
      gid,
      symbolicLink,
      content: Buffer.from(content),
    });
    return this;
  }

  mutate(targetPath, changes) {
    const current = this.entries.get(targetPath);
    assert.ok(current, `fake path ${targetPath} must exist`);
    this.entries.set(targetPath, { ...current, ...changes });
    return this;
  }

  async lstat(targetPath) {
    const entry = this.entries.get(targetPath);
    if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return {
      uid: entry.uid,
      gid: entry.gid,
      mode: entry.mode,
      nlink: 1,
      size: entry.content?.byteLength ?? 0,
      isDirectory: () => entry.type === "directory",
      isFile: () => entry.type === "file",
      isSymbolicLink: () => entry.symbolicLink,
    };
  }

  async readFile(targetPath, encoding) {
    const entry = this.entries.get(targetPath);
    if (!entry || entry.type !== "file") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const value = Buffer.from(entry.content);
    return encoding ? value.toString(encoding) : value;
  }

  async readdir(targetPath) {
    const entry = this.entries.get(targetPath);
    if (!entry || entry.type !== "directory") {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    const prefix = targetPath === "/" ? "/" : `${targetPath}/`;
    const children = new Set();
    for (const candidate of this.entries.keys()) {
      if (!candidate.startsWith(prefix) || candidate === targetPath) continue;
      const child = candidate.slice(prefix.length).split("/")[0];
      if (child) children.add(child);
    }
    return [...children].sort();
  }
}

function cgroupFixture(overrides = {}) {
  const cgroupDirectory = `/sys/fs/cgroup${EXECUTION_WORKER_EXPECTED_CGROUP}`;
  const values = new Map([
    ["/proc/self/cgroup", `0::${EXECUTION_WORKER_EXPECTED_CGROUP}\n`],
    ["/sys/fs/cgroup/cgroup.controllers", "cpuset cpu io memory hugetlb pids rdma misc\n"],
    [`${cgroupDirectory}/cgroup.type`, "domain\n"],
    [`${cgroupDirectory}/memory.max`, `${EXECUTION_WORKER_CGROUP_LIMITS.memoryMaxBytes}\n`],
    [`${cgroupDirectory}/memory.swap.max`, "0\n"],
    [`${cgroupDirectory}/pids.max`, `${EXECUTION_WORKER_CGROUP_LIMITS.tasksMax}\n`],
    [
      `${cgroupDirectory}/cpu.max`,
      `${EXECUTION_WORKER_CGROUP_LIMITS.cpuQuotaMicros} ${EXECUTION_WORKER_CGROUP_LIMITS.cpuPeriodMicros}\n`,
    ],
    [`${cgroupDirectory}/memory.oom.group`, "1\n"],
    [`${cgroupDirectory}/memory.current`, `${128 * 1024 * 1024}\n`],
    [`${cgroupDirectory}/memory.swap.current`, "0\n"],
    [`${cgroupDirectory}/pids.current`, "7\n"],
    [`${cgroupDirectory}/cgroup.procs`, `101\n${TEST_PID}\n`],
  ]);
  for (const [targetPath, value] of Object.entries(overrides)) values.set(targetPath, value);
  return {
    cgroupDirectory,
    filesystem: {
      async readFile(targetPath) {
        if (!values.has(targetPath)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return Buffer.from(values.get(targetPath));
      },
    },
  };
}

function deploymentFixture(units) {
  const filesystem = new FakeFilesystem();
  const { deployment } = units;
  filesystem
    .addFile(EXECUTION_WORKER_NODE_PATH, "node", { mode: 0o555 })
    .addFile(deployment.workerEntrypoint, "worker", { mode: 0o555 })
    .addDirectoryChain(deployment.runtimeBundleDirectory)
    .mutate(deployment.runtimeBundleDirectory, { mode: 0o555 })
    .addDirectory(deployment.runtimeBundleRoot, { mode: 0o555 })
    .addFile(
      deployment.runtimeBundleManifest,
      `${JSON.stringify({ rootDigest: RUNTIME_BUNDLE_DIGEST })}\n`,
      { mode: 0o444 }
    )
    .addFile(EXECUTION_WORKER_CREDENTIAL_SOURCE, "T".repeat(48), { mode: 0o400 })
    .addFile(
      `${EXECUTION_WORKER_SYSTEMD_UNIT_DIRECTORY}/${EXECUTION_WORKER_SOCKET_UNIT}`,
      units.socketUnit,
      { mode: 0o644 }
    )
    .addFile(
      `${EXECUTION_WORKER_SYSTEMD_UNIT_DIRECTORY}/${EXECUTION_WORKER_SERVICE_UNIT}`,
      units.serviceUnit,
      { mode: 0o644 }
    );
  return filesystem;
}

const units = createExecutionWorkerSystemdUnits({
  workerReleaseDigest: WORKER_RELEASE_DIGEST,
  runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
});
assert.equal(EXECUTION_WORKER_SERVICE_UNIT, SERVER_SYSTEMD_UNIT);
assert.equal(EXECUTION_WORKER_CREDENTIAL_NAME, SERVER_CREDENTIAL_NAME);
const repeatedUnits = createExecutionWorkerSystemdUnits({
  workerReleaseDigest: WORKER_RELEASE_DIGEST,
  runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
});
assert.deepEqual(repeatedUnits, units);
assert.equal(units.schemaVersion, EXECUTION_WORKER_SYSTEMD_BOUNDARY_SCHEMA_VERSION);
assert.equal(units.listener.host, EXECUTION_WORKER_LISTEN_HOST);
assert.equal(units.listener.port, EXECUTION_WORKER_LISTEN_PORT);
assert.equal(units.listener.fd, 3);
assert.match(units.socketUnit, /^ListenStream=127\.0\.0\.1:18130$/mu);
assert.match(units.socketUnit, /^FileDescriptorName=execution-worker-http$/mu);
assert.match(units.socketUnit, /^Accept=no$/mu);
assert.match(units.serviceUnit, /^LoadCredential=execution-worker-token:\/etc\/aginti-execution-worker\/credentials\/execution-worker-token$/mu);
assert.match(
  units.serviceUnit,
  new RegExp(`^Environment=AGINTI_EXECUTION_RUNTIME_BUNDLE_DIRECTORY=${units.deployment.runtimeBundleDirectory}$`, "mu")
);
assert.match(
  units.serviceUnit,
  new RegExp(`^Environment=AGINTI_EXECUTION_RUNTIME_BUNDLE_DIGEST=${RUNTIME_BUNDLE_DIGEST}$`, "mu")
);
assert.match(units.serviceUnit, /\/bin\/aginti-execution-worker\.js$/mu);
assert.match(units.serviceUnit, /^PrivateNetwork=yes$/mu);
assert.match(units.serviceUnit, /^ProtectControlGroups=yes$/mu);
assert.match(units.serviceUnit, /^ProtectProc=invisible$/mu);
assert.match(units.serviceUnit, /^ProcSubset=all$/mu);
assert.match(units.serviceUnit, /^Delegate=no$/mu);
assert.match(units.serviceUnit, /^MemoryMax=1610612736$/mu);
assert.match(units.serviceUnit, /^MemorySwapMax=0$/mu);
assert.match(units.serviceUnit, /^TasksMax=64$/mu);
assert.match(units.serviceUnit, /^CPUQuota=200%$/mu);
assert.match(units.serviceUnit, /^CPUQuotaPeriodSec=100ms$/mu);
assert.match(units.serviceUnit, /^OOMPolicy=kill$/mu);
assert.doesNotMatch(units.serviceUnit, /EnvironmentFile|SetCredential|(?:BEARER|TOKEN|SECRET|PASSWORD)=/u);
assert.equal(units.credential.name, EXECUTION_WORKER_CREDENTIAL_NAME);
assert.equal(units.credential.delivery, "systemd-LoadCredential");

const validatedUnits = validateExecutionWorkerSystemdUnits({
  workerReleaseDigest: WORKER_RELEASE_DIGEST,
  runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
  socketUnit: units.socketUnit,
  serviceUnit: units.serviceUnit,
});
assert.equal(validatedUnits.valid, true);
assert.equal(validatedUnits.socketUnitSha256, units.socketUnitSha256);
assert.equal(validatedUnits.serviceUnitSha256, units.serviceUnitSha256);
await expectCode(
  () => validateExecutionWorkerSystemdUnits({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    socketUnit: units.socketUnit.replace("127.0.0.1:18130", "0.0.0.0:18130"),
    serviceUnit: units.serviceUnit,
  }),
  "EXECUTION_SYSTEMD_UNIT_POLICY_MISMATCH"
);
await expectCode(
  () => validateExecutionWorkerSystemdUnits({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    socketUnit: units.socketUnit,
    serviceUnit: `${units.serviceUnit}[Service]\nMemoryMax=infinity\n`,
  }),
  "EXECUTION_SYSTEMD_UNIT_POLICY_MISMATCH"
);
await expectCode(
  () => validateExecutionWorkerSystemdUnits({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    socketUnit: units.socketUnit,
    serviceUnit: units.serviceUnit.replace(
      `LoadCredential=${EXECUTION_WORKER_CREDENTIAL_NAME}:${EXECUTION_WORKER_CREDENTIAL_SOURCE}`,
      "Environment=EXECUTION_WORKER_TOKEN=secret"
    ),
  }),
  "EXECUTION_SYSTEMD_UNIT_POLICY_MISMATCH"
);

const exactCgroup = cgroupFixture();
const cgroupAttestation = await attestExecutionWorkerCgroup({
  filesystem: exactCgroup.filesystem,
  pid: TEST_PID,
});
assert.equal(cgroupAttestation.unit, EXECUTION_WORKER_SERVICE_UNIT);
assert.equal(cgroupAttestation.cgroupPath, EXECUTION_WORKER_EXPECTED_CGROUP);
assert.equal(cgroupAttestation.aggregateDescendantContainment, true);
assert.deepEqual(cgroupAttestation.limits, EXECUTION_WORKER_CGROUP_LIMITS);
assert.equal(cgroupAttestation.cgroupPolicyDigest, EXECUTION_WORKER_CGROUP_POLICY_DIGEST);
assert.equal(cgroupAttestation.containment.aggregateCgroupVerified, true);
assert.equal(
  cgroupAttestation.containment.cgroupPolicyDigest,
  EXECUTION_WORKER_CGROUP_POLICY_DIGEST
);
assert.equal(cgroupAttestation.containment.exactUnitIdentityVerified, true);
assert.equal(attestExecutionWorkerCgroupBoundary, attestExecutionWorkerCgroup);
assert.equal(cgroupAttestation.usage.memorySwapCurrentBytes, 0);
assert.ok(cgroupAttestation.memberPids.includes(TEST_PID));
assert.match(cgroupAttestation.evidenceSha256, /^[a-f0-9]{64}$/u);

for (const [relativePath, wrongValue] of [
  ["memory.max", `${EXECUTION_WORKER_CGROUP_LIMITS.memoryMaxBytes + 1}\n`],
  ["memory.swap.max", "max\n"],
  ["pids.max", "65\n"],
  ["cpu.max", "max 100000\n"],
  ["memory.oom.group", "0\n"],
]) {
  const fixture = cgroupFixture({
    [`${exactCgroup.cgroupDirectory}/${relativePath}`]: wrongValue,
  });
  await expectCode(
    () => attestExecutionWorkerCgroup({ filesystem: fixture.filesystem, pid: TEST_PID }),
    "EXECUTION_CGROUP_POLICY_MISMATCH"
  );
}
await expectCode(
  () => attestExecutionWorkerCgroup({
    filesystem: cgroupFixture({
      "/proc/self/cgroup": "0::/system.slice/not-the-worker.service\n",
    }).filesystem,
    pid: TEST_PID,
  }),
  "EXECUTION_CGROUP_POLICY_MISMATCH"
);
await expectCode(
  () => attestExecutionWorkerCgroup({
    filesystem: cgroupFixture({
      [`${exactCgroup.cgroupDirectory}/cgroup.procs`]: "101\n102\n",
    }).filesystem,
    pid: TEST_PID,
  }),
  "EXECUTION_CGROUP_IDENTITY_MISMATCH"
);
await expectCode(
  () => attestExecutionWorkerCgroup({
    filesystem: cgroupFixture({
      "/sys/fs/cgroup/cgroup.controllers": "cpu memory\n",
    }).filesystem,
    pid: TEST_PID,
  }),
  "EXECUTION_CGROUP_V2_REQUIRED"
);

const activation = attestExecutionWorkerActivationEnvironment({
  pid: TEST_PID,
  env: {
    LISTEN_PID: String(TEST_PID),
    LISTEN_FDS: "1",
    LISTEN_FDNAMES: EXECUTION_WORKER_SOCKET_FD_NAME,
    CREDENTIALS_DIRECTORY: `/run/credentials/${EXECUTION_WORKER_SERVICE_UNIT}`,
  },
});
assert.equal(activation.fd, 3);
assert.equal(
  activation.credentialPath,
  `/run/credentials/${EXECUTION_WORKER_SERVICE_UNIT}/${EXECUTION_WORKER_CREDENTIAL_NAME}`
);
await expectCode(
  () => attestExecutionWorkerActivationEnvironment({
    pid: TEST_PID,
    env: {
      LISTEN_PID: String(TEST_PID),
      LISTEN_FDS: "2",
      LISTEN_FDNAMES: EXECUTION_WORKER_SOCKET_FD_NAME,
      CREDENTIALS_DIRECTORY: `/run/credentials/${EXECUTION_WORKER_SERVICE_UNIT}`,
    },
  }),
  "EXECUTION_SYSTEMD_ACTIVATION_MISMATCH"
);

let filesystem = deploymentFixture(units);
let validatorArguments;
const runtimeBundleValidator = async (input) => {
  validatorArguments = input;
  return Object.freeze({
    profile: "python312-curated-root-v1",
    bundleDirectory: units.deployment.runtimeBundleDirectory,
    rootPath: units.deployment.runtimeBundleRoot,
    rootDigest: RUNTIME_BUNDLE_DIGEST,
  });
};
const deploymentAttestation = await attestExecutionWorkerDeploymentInputs({
  workerReleaseDigest: WORKER_RELEASE_DIGEST,
  runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
  filesystem,
  runtimeBundleValidator,
});
assert.equal(deploymentAttestation.rootControlled, true);
assert.equal(deploymentAttestation.runtime.rootDigest, RUNTIME_BUNDLE_DIGEST);
assert.equal(deploymentAttestation.credential.valueDisclosed, false);
assert.equal(validatorArguments.bundleDirectory, units.deployment.runtimeBundleDirectory);
assert.equal(validatorArguments.expectedRootDigest, RUNTIME_BUNDLE_DIGEST);
assert.equal(validatorArguments.filesystem, filesystem);

const installedUnits = await attestInstalledExecutionWorkerUnits({
  workerReleaseDigest: WORKER_RELEASE_DIGEST,
  runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
  filesystem,
});
assert.equal(installedUnits.installed, true);
assert.equal(installedUnits.socketUnitSha256, units.socketUnitSha256);

filesystem = deploymentFixture(units);
filesystem.mutate(units.deployment.workerReleaseDirectory, { uid: 1000 });
await expectCode(
  () => attestExecutionWorkerDeploymentInputs({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    filesystem,
    runtimeBundleValidator,
  }),
  "EXECUTION_DEPLOYMENT_INPUT_UNTRUSTED"
);

filesystem = deploymentFixture(units);
filesystem.mutate(units.deployment.workerReleaseDirectory, { mode: 0o700 });
await expectCode(
  () => attestExecutionWorkerDeploymentInputs({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    filesystem,
    runtimeBundleValidator,
  }),
  "EXECUTION_DEPLOYMENT_INPUT_UNTRUSTED"
);

filesystem = deploymentFixture(units);
filesystem.mutate(units.deployment.workerEntrypoint, { mode: 0o700 });
await expectCode(
  () => attestExecutionWorkerDeploymentInputs({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    filesystem,
    runtimeBundleValidator,
  }),
  "EXECUTION_DEPLOYMENT_INPUT_UNTRUSTED"
);

filesystem = deploymentFixture(units);
filesystem.mutate(units.deployment.runtimeBundleRoot, { symbolicLink: true });
await expectCode(
  () => attestExecutionWorkerDeploymentInputs({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    filesystem,
    runtimeBundleValidator,
  }),
  "EXECUTION_DEPLOYMENT_INPUT_UNTRUSTED"
);

filesystem = deploymentFixture(units);
filesystem.mutate(EXECUTION_WORKER_CREDENTIAL_SOURCE, {
  content: Buffer.from(`${"T".repeat(48)}\n`),
});
assert.equal((await attestExecutionWorkerDeploymentInputs({
  workerReleaseDigest: WORKER_RELEASE_DIGEST,
  runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
  filesystem,
  runtimeBundleValidator,
})).rootControlled, true);

filesystem = deploymentFixture(units);
filesystem.mutate(EXECUTION_WORKER_CREDENTIAL_SOURCE, {
  content: Buffer.from(`${"T".repeat(48)}\nextra`),
});
await expectCode(
  () => attestExecutionWorkerDeploymentInputs({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    filesystem,
    runtimeBundleValidator,
  }),
  "EXECUTION_DEPLOYMENT_CREDENTIAL_INVALID"
);

filesystem = deploymentFixture(units);
await expectCode(
  () => attestExecutionWorkerDeploymentInputs({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    filesystem,
    runtimeBundleValidator: async () => ({
      bundleDirectory: units.deployment.runtimeBundleDirectory,
      rootPath: units.deployment.runtimeBundleRoot,
      rootDigest: "c".repeat(64),
    }),
  }),
  "EXECUTION_RUNTIME_BUNDLE_ATTESTATION_FAILED"
);

filesystem = deploymentFixture(units);
filesystem.mutate(
  `${EXECUTION_WORKER_SYSTEMD_UNIT_DIRECTORY}/${EXECUTION_WORKER_SERVICE_UNIT}`,
  { content: Buffer.from(units.serviceUnit.replace("MemoryMax=1610612736", "MemoryMax=infinity")) }
);
await expectCode(
  () => attestInstalledExecutionWorkerUnits({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    filesystem,
  }),
  "EXECUTION_SYSTEMD_UNIT_POLICY_MISMATCH"
);

filesystem = deploymentFixture(units);
filesystem.addFile(
  `/run/systemd/system.control/${EXECUTION_WORKER_SERVICE_UNIT}`,
  units.serviceUnit,
  { mode: 0o644 }
);
await expectCode(
  () => attestInstalledExecutionWorkerUnits({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    filesystem,
  }),
  "EXECUTION_SYSTEMD_OVERRIDE_PRESENT"
);

filesystem = deploymentFixture(units);
filesystem.addFile(
  `/usr/lib/systemd/system/${EXECUTION_WORKER_SOCKET_UNIT}.d/override.conf`,
  "[Socket]\nListenStream=0.0.0.0:18130\n",
  { mode: 0o644 }
);
await expectCode(
  () => attestInstalledExecutionWorkerUnits({
    workerReleaseDigest: WORKER_RELEASE_DIGEST,
    runtimeBundleDigest: RUNTIME_BUNDLE_DIGEST,
    filesystem,
  }),
  "EXECUTION_SYSTEMD_OVERRIDE_PRESENT"
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  schemaVersion: EXECUTION_WORKER_SYSTEMD_BOUNDARY_SCHEMA_VERSION,
  fixedListener: `${EXECUTION_WORKER_LISTEN_HOST}:${EXECUTION_WORKER_LISTEN_PORT}`,
  cgroupPath: EXECUTION_WORKER_EXPECTED_CGROUP,
  aggregateLimits: EXECUTION_WORKER_CGROUP_LIMITS,
  cgroupPolicyDigest: EXECUTION_WORKER_CGROUP_POLICY_DIGEST,
  socketUnitSha256: units.socketUnitSha256,
  serviceUnitSha256: units.serviceUnitSha256,
  fakeFilesystem: true,
})}\n`);
