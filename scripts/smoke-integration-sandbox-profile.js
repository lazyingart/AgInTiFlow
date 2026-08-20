#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  PUBLIC_INTEGRATION_CONTAINER_USER,
  PUBLIC_INTEGRATION_DEFAULT_LIMITS,
  PUBLIC_INTEGRATION_FACT_MAX_TTL_MS,
  PUBLIC_INTEGRATION_INVOCATION_SCHEMA,
  PUBLIC_INTEGRATION_RUNTIME_ATTESTATION_SCHEMA,
  PUBLIC_INTEGRATION_SANDBOX_CAPABILITY_ENABLED,
  PUBLIC_INTEGRATION_SANDBOX_PROFILE_ID,
  PUBLIC_INTEGRATION_WORKSPACE_ATTESTATION_SCHEMA,
  PublicIntegrationSandboxError,
  attestPublicIntegrationSandboxInvocation,
  attestPublicIntegrationSandboxPrerequisites,
  buildPublicIntegrationSandboxInvocation,
} from "../src/integration-sandbox-profile.js";

const IMAGE = `registry.example.invalid/aginti/public-sandbox@sha256:${"a".repeat(64)}`;
const CAPTURED_AT = "2026-08-20T08:00:00.000Z";
const EXPIRES_AT = "2026-08-20T08:00:20.000Z";
const BOOT_ID = "01234567-89ab-cdef-0123-456789abcdef";

function digest(char) {
  return `sha256:${(char.charCodeAt(0) % 16).toString(16).repeat(64)}`;
}

function factIdentity(char, overrides = {}) {
  return {
    dev: 2050,
    ino: 1000 + char.charCodeAt(0),
    ctimeMs: 1787299200000 + char.charCodeAt(0),
    nlink: 1,
    uid: 0,
    gid: 0,
    mode: 0o755,
    digest: digest(char),
    ...overrides,
  };
}

function filesystemBinding(char, overrides = {}) {
  return {
    mountId: `mount-${char}`,
    fsType: "xfs",
    device: `dev-${char}`,
    root: "/srv/aginti-public",
    dev: 2050,
    ino: 9000 + char.charCodeAt(0),
    ctimeMs: 1787299300000 + char.charCodeAt(0),
    nlink: 3,
    uid: 0,
    gid: 0,
    mode: 0o755,
    digest: digest(char),
    ...overrides,
  };
}

const WORKSPACE_FILESYSTEM = filesystemBinding("f");

function runtimeFixture(overrides = {}) {
  const runtime = {
    schema: PUBLIC_INTEGRATION_RUNTIME_ATTESTATION_SCHEMA,
    attestationId: "runtime-preflight-01HX7YQX0K9M",
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
    bootId: BOOT_ID,
    subject: {
      runId: "run-01",
      threadId: "thread-01",
      leaseId: "lease-01",
    },
    engine: "podman",
    executable: "/usr/bin/podman",
    executableIdentity: factIdentity("d", { uid: 0, gid: 0, mode: 0o755 }),
    executableDigest: digest("d"),
    executableVerified: true,
    executableSymlinkFree: true,
    executableWritableByUntrusted: false,
    available: true,
    rootless: true,
    remote: false,
    effectiveUid: 1000,
    engineUid: 1000,
    controlEndpoint: {
      kind: "local-unix",
      path: "/run/user/1000/podman/podman.sock",
      identity: factIdentity("e", { uid: 1000, gid: 1000, mode: 0o600 }),
      ownerUid: 1000,
      ownerOnly: true,
      symlinkFree: true,
    },
    capabilities: {
      readOnlyRootfs: true,
      capDropAll: true,
      noNewPrivileges: true,
      seccomp: true,
      apparmor: true,
      networkNone: true,
      nonRootUser: true,
      tmpfs: true,
      memoryLimit: true,
      memorySwapLimit: true,
      cpuLimit: true,
      pidsLimit: true,
      ulimit: true,
      labels: true,
      cidfile: true,
      immutableContainerId: true,
      labelVerifiedLifecycle: true,
      pullNever: true,
      privateNamespaces: true,
      cgroupNamespacePrivate: true,
      ipcNone: true,
      bindPropagationPrivate: true,
      noImplicitHostMounts: true,
      hostDevicesDisabled: true,
      hostSocketForwardingDisabled: true,
      logDriverNone: true,
      init: true,
      stopTimeout: true,
    },
    security: {
      seccomp: {
        available: true,
        enforced: true,
        profilePath: "/etc/agintiflow/security/public-integration-seccomp.json",
        identity: factIdentity("b", { uid: 0, gid: 0, mode: 0o644 }),
        profileDigest: digest("b"),
        profileVerified: true,
        profileImmutable: true,
        symlinkFree: true,
        writableByUntrusted: false,
      },
      apparmor: {
        available: true,
        enforced: true,
        profileName: "aginti-public-integration-v1",
        profileLoaded: true,
      },
    },
    supervisor: {
      wallTimeoutEnforced: true,
      stdoutLimitEnforced: true,
      stderrLimitEnforced: true,
      outputBytesCountedBeforeDecode: true,
      workspaceQuotaEnforced: true,
      abortKillsExactContainer: true,
      reconcileByLabels: true,
      killEscalation: true,
    },
    image: {
      reference: IMAGE,
      digestVerified: true,
      approved: true,
      pullDisabled: true,
      credentialsAbsent: true,
      environmentAllowlisted: true,
      volumesAbsent: true,
    },
  };
  return Object.assign(runtime, overrides);
}

function workspaceFixture(overrides = {}) {
  const workspace = {
    schema: PUBLIC_INTEGRATION_WORKSPACE_ATTESTATION_SCHEMA,
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
    bootId: BOOT_ID,
    root: "/srv/aginti-public/workspaces",
    path: "/srv/aginti-public/workspaces/principal-01/thread-01",
    realRoot: "/srv/aginti-public/workspaces",
    realPath: "/srv/aginti-public/workspaces/principal-01/thread-01",
    rootIdentity: factIdentity("r", { uid: 0, gid: 0, mode: 0o755, nlink: 3 }),
    pathIdentity: factIdentity("p", { uid: 101234, gid: 101234, mode: 0o700, nlink: 2 }),
    filesystem: WORKSPACE_FILESYSTEM,
    runId: "run-01",
    threadId: "thread-01",
    leaseId: "lease-01",
    exists: true,
    directory: true,
    dedicated: true,
    exclusiveLease: true,
    noSymlinkComponents: true,
    noNestedMounts: true,
    noSpecialFiles: true,
    noCredentialFiles: true,
    mountPropagationPrivate: true,
    ownerOnly: true,
    writableByContainerUser: true,
    containerUid: PUBLIC_INTEGRATION_CONTAINER_USER.uid,
    containerGid: PUBLIC_INTEGRATION_CONTAINER_USER.gid,
    hostOwnerUid: 101234,
    hostOwnerGid: 101234,
    uidMap: {
      containerUid: PUBLIC_INTEGRATION_CONTAINER_USER.uid,
      containerGid: PUBLIC_INTEGRATION_CONTAINER_USER.gid,
      hostUid: 101234,
      hostGid: 101234,
      size: 65536,
      proven: true,
    },
    quota: {
      method: "xfs-project",
      id: "quota-thread-01",
      filesystem: WORKSPACE_FILESYSTEM,
      limitBytes: PUBLIC_INTEGRATION_DEFAULT_LIMITS.workspaceBytes,
      usedBytes: 4096,
      inodeLimit: PUBLIC_INTEGRATION_DEFAULT_LIMITS.workspaceFiles,
      usedInodes: 4,
      supportsBytes: true,
      supportsInodes: true,
      enforced: true,
      hard: true,
      noSharedPool: true,
    },
  };
  return Object.assign(workspace, overrides);
}

function requestFixture(overrides = {}) {
  const request = {
    runtime: runtimeFixture(),
    workspace: workspaceFixture(),
    image: IMAGE,
    runId: "run-01",
    threadId: "thread-01",
    leaseId: "lease-01",
    command: ["/bin/sh", "-lc", "python3 make_plot.py"],
  };
  return Object.assign(request, overrides);
}

function changedRequest(mutator) {
  const request = structuredClone(requestFixture());
  mutator(request);
  return request;
}

function changedInvocation(invocation, mutator) {
  const copy = structuredClone(invocation);
  mutator(copy);
  return copy;
}

let adversarialCases = 0;

function expectSandboxError(fn, expectedCode, message) {
  assert.throws(
    fn,
    (error) => {
      assert(error instanceof PublicIntegrationSandboxError, `${message}: expected sandbox error`);
      assert.equal(error.code, expectedCode, `${message}: wrong failure code`);
      return true;
    },
    message
  );
  adversarialCases += 1;
}

function valuesAfterFlag(args, flag) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === flag) values.push(args[index + 1]);
  }
  return values;
}

const request = requestFixture();
const invocation = buildPublicIntegrationSandboxInvocation(request);
const secondInvocation = buildPublicIntegrationSandboxInvocation(structuredClone(request));

assert.deepEqual(secondInvocation, invocation, "profile construction must be deterministic");
assert.equal(invocation.schema, PUBLIC_INTEGRATION_INVOCATION_SCHEMA);
assert.equal(invocation.profileId, PUBLIC_INTEGRATION_SANDBOX_PROFILE_ID);
assert.equal(invocation.executable, "/usr/bin/podman");
assert.equal(invocation.args[0], "run");
assert.equal(invocation.container.image, IMAGE);
assert.equal(invocation.container.user, "65532:65532");
assert.equal(invocation.container.cidfile, "/srv/aginti-public/workspaces/principal-01/thread-01/.aginti-public/lease-01.cid");
assert.equal(invocation.container.idRef, "{{capturedContainerId}}");
assert.equal(invocation.capability.enabled, PUBLIC_INTEGRATION_SANDBOX_CAPABILITY_ENABLED);
assert.equal(invocation.attestation.rootless, true);
assert.equal(invocation.attestation.readOnlyRootfs, true);
assert.equal(invocation.attestation.network, "none");
assert.equal(invocation.attestation.capabilityEnabled, false);
assert.match(invocation.attestation.digest, /^sha256:[a-f0-9]{64}$/);
assert.equal(Object.isFrozen(invocation), true, "invocation must be immutable");
assert.equal(Object.isFrozen(invocation.args), true, "invocation argv must be immutable");
assert.equal(Object.isFrozen(invocation.container.labels), true, "lifecycle labels must be immutable");

const args = invocation.args;
assert.equal(valuesAfterFlag(args, "--cidfile")[0], invocation.container.cidfile);
assert.equal(valuesAfterFlag(args, "--name").length, 0, "run must not depend on a reusable container name");
assert.equal(valuesAfterFlag(args, "--pull")[0], "never");
assert.equal(valuesAfterFlag(args, "--log-driver")[0], "none");
assert.equal(valuesAfterFlag(args, "--network")[0], "none");
assert.equal(valuesAfterFlag(args, "--cap-drop")[0], "ALL");
assert.equal(valuesAfterFlag(args, "--user")[0], "65532:65532");
assert.equal(valuesAfterFlag(args, "--memory")[0], String(PUBLIC_INTEGRATION_DEFAULT_LIMITS.memoryBytes));
assert.equal(valuesAfterFlag(args, "--memory-swap")[0], String(PUBLIC_INTEGRATION_DEFAULT_LIMITS.memoryBytes));
assert.equal(valuesAfterFlag(args, "--pids-limit")[0], String(PUBLIC_INTEGRATION_DEFAULT_LIMITS.pids));
assert(valuesAfterFlag(args, "--ulimit").includes("nofile=256:256"), "fd limit must be present");
assert(valuesAfterFlag(args, "--ulimit").includes("core=0:0"), "core dump limit must be present");
assert(args.includes("--read-only"), "root filesystem must be read-only");
assert(args.includes("--init"), "container init must be enabled");
assert.equal(valuesAfterFlag(args, "--ipc")[0], "none");
assert.equal(valuesAfterFlag(args, "--cgroupns")[0], "private");

const securityOptions = valuesAfterFlag(args, "--security-opt");
assert(securityOptions.includes("no-new-privileges=true"));
assert(securityOptions.includes("seccomp=/etc/agintiflow/security/public-integration-seccomp.json"));
assert(securityOptions.includes("apparmor=aginti-public-integration-v1"));

const mounts = valuesAfterFlag(args, "--mount");
assert.deepEqual(mounts, [
  "type=bind,src=/srv/aginti-public/workspaces/principal-01/thread-01,dst=/workspace,rw,bind-propagation=rprivate",
]);
assert(!args.includes("-v") && !args.includes("--volume"), "no additional host volume syntax may be present");
assert(!args.includes("--device"), "host device mounts must be absent");
assert(!args.includes("--privileged"), "privileged mode must be absent");
assert(!args.includes("--env-file"), "host environment files must be absent");
assert(!JSON.stringify(mounts).includes("docker.sock"), "Docker socket must not be mounted");
assert(!JSON.stringify(mounts).includes("ssh"), "SSH agent sockets must not be mounted");
assert(!JSON.stringify(mounts).includes("/home/"), "host home must not be mounted");

const tmpfs = valuesAfterFlag(args, "--tmpfs");
assert.equal(tmpfs.length, 3, "tmp, run, and container home must each be private tmpfs mounts");
assert(tmpfs.every((entry) => entry.includes("nosuid") && entry.includes("nodev") && entry.includes("noexec")));
const environment = valuesAfterFlag(args, "--env");
assert(environment.includes("HOME=/home/agent"));
assert(environment.includes("XDG_CACHE_HOME=/tmp/cache"));
assert(environment.includes("SSH_AUTH_SOCK="));
assert(environment.includes("DOCKER_HOST="));
assert(environment.includes("DOCKER_CONTEXT="));
assert(environment.includes("CONTAINER_HOST="));
assert(environment.includes("PODMAN_SYSTEM_CONNECTION="));
assert(environment.includes("CONTAINERS_CONF="));
assert(environment.includes("CONTAINERS_STORAGE_CONF="));
assert(environment.includes("REGISTRY_AUTH_FILE="));
assert(!environment.some((entry) => /^SSH_AUTH_SOCK=.+/.test(entry)));
assert(!environment.some((entry) => /^DOCKER_HOST=.+/.test(entry)));

assert.equal(invocation.spawn.clearInheritedEnv, true);
assert.equal(invocation.spawn.endpoint.uri, "unix:///run/user/1000/podman/podman.sock");
assert(invocation.spawn.env.includes("CONTAINER_HOST=unix:///run/user/1000/podman/podman.sock"));
assert(invocation.spawn.env.includes("DOCKER_HOST="));
assert(invocation.spawn.env.includes("DOCKER_CONTEXT="));
assert(invocation.spawn.env.includes("PODMAN_SYSTEM_CONNECTION="));
assert(invocation.spawn.env.includes("CONTAINERS_CONF="));
assert(invocation.spawn.env.includes("CONTAINERS_STORAGE_CONF="));
assert(invocation.spawn.env.includes("REGISTRY_AUTH_FILE="));
assert(invocation.spawn.env.includes("NO_PROXY=*"));

const labels = valuesAfterFlag(args, "--label");
assert(labels.includes("art.lazying.aginti.public.managed=true"));
assert(labels.includes("art.lazying.aginti.public.run=run-01"));
assert(labels.includes("art.lazying.aginti.public.thread=thread-01"));
assert(labels.includes("art.lazying.aginti.public.lease=lease-01"));
assert.equal(invocation.lifecycle.stop.args.at(-1), "{{capturedContainerId}}");
assert.equal(invocation.lifecycle.kill.args.at(-1), "{{capturedContainerId}}");
assert.equal(invocation.lifecycle.remove.args.at(-1), "{{capturedContainerId}}");
assert.equal(invocation.lifecycle.inspect.args.at(-1), "{{capturedContainerId}}");
assert.equal(invocation.lifecycle.stop.requiresPriorLabelVerification, true);
assert.equal(invocation.lifecycle.kill.requiresPriorLabelVerification, true);
assert.equal(invocation.lifecycle.remove.requiresPriorLabelVerification, true);
assert.equal(invocation.lifecycle.stop.containerIdSource.cidfile, invocation.container.cidfile);
assert.equal(invocation.lifecycle.stop.containerIdSource.immutable, true);
assert.equal(invocation.lifecycle.inspect.requireAllLabels.length, 6);
assert.equal(invocation.lifecycle.stop.requireAllLabels.length, 6);
assert.equal(invocation.lifecycle.reconcile.requireAllLabels.length, 6);
assert(invocation.lifecycle.reconcile.args.filter((entry) => entry === "--filter").length === 6);
assert.equal(invocation.executorPreflight.mustRestatBeforeSpawn, true);
assert.equal(invocation.executorPreflight.mustRedigestBeforeSpawn, true);
assert.equal(invocation.executorPreflight.maxRestatAgeMs, 1000);
assert.equal(invocation.executorPreflight.bootId, BOOT_ID);
assert.equal(invocation.executorPreflight.identityChecks.executable.digest, digest("d"));
assert.equal(invocation.executorPreflight.identityChecks.controlEndpoint.digest, digest("e"));
assert.equal(invocation.executorPreflight.identityChecks.seccomp.digest, digest("b"));
assert.equal(invocation.executorPreflight.identityChecks.workspacePath.digest, digest("p"));
assert.equal(invocation.executorPreflight.identityChecks.quotaFilesystem.digest, WORKSPACE_FILESYSTEM.digest);

const prerequisiteAttestation = attestPublicIntegrationSandboxPrerequisites(request);
assert.equal(prerequisiteAttestation.ok, false);
assert.equal(prerequisiteAttestation.valid, true);
assert.equal(prerequisiteAttestation.enabled, false);
assert.equal(prerequisiteAttestation.capability.enabled, false);
assert.equal(prerequisiteAttestation.facts.maxTtlMs, PUBLIC_INTEGRATION_FACT_MAX_TTL_MS);
assert.equal(prerequisiteAttestation.assertions.immutableImage, true);
assert.equal(prerequisiteAttestation.assertions.boundedResources, true);
const invocationAttestation = attestPublicIntegrationSandboxInvocation(invocation, request);
assert.equal(invocationAttestation.ok, true);
assert.equal(invocationAttestation.digest, invocation.attestation.digest);
assert.equal(invocationAttestation.capabilityEnabled, false);
assert.equal(invocationAttestation.cidfile, invocation.container.cidfile);

const dockerRequest = changedRequest((candidate) => {
  candidate.runtime.engine = "docker";
  candidate.runtime.executable = "/usr/bin/docker";
  candidate.runtime.executableIdentity.digest = digest("9");
  candidate.runtime.executableDigest = digest("9");
  candidate.runtime.controlEndpoint = {
    kind: "local-unix",
    path: "/run/user/1000/docker.sock",
    identity: factIdentity("8", { uid: 1000, gid: 1000, mode: 0o600 }),
    ownerUid: 1000,
    ownerOnly: true,
    symlinkFree: true,
  };
});
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(dockerRequest),
  "sandbox_runtime_unavailable",
  "portable Docker UID mapping is not supported in v1"
);

const reducedLimits = {
  ...PUBLIC_INTEGRATION_DEFAULT_LIMITS,
  cpuMillis: 500,
  memoryBytes: 1024 * 1024 * 1024,
  pids: 64,
  fileDescriptors: 128,
  wallTimeMs: 30 * 1000,
  stdoutBytes: 128 * 1024,
  stderrBytes: 64 * 1024,
  workspaceBytes: 128 * 1024 * 1024,
};
const reducedRequest = changedRequest((candidate) => {
  candidate.limits = reducedLimits;
  candidate.workspace.quota.limitBytes = reducedLimits.workspaceBytes;
  candidate.workspace.quota.inodeLimit = reducedLimits.workspaceFiles;
});
const reducedInvocation = buildPublicIntegrationSandboxInvocation(reducedRequest);
assert.equal(valuesAfterFlag(reducedInvocation.args, "--cpus")[0], "0.5");
assert.equal(reducedInvocation.supervisor.wallTimeMs, 30 * 1000);
assert.equal(reducedInvocation.supervisor.workspaceBytes, 128 * 1024 * 1024);

for (const field of ["network", "mounts", "environment", "extraArgs", "privileged", "devices"]) {
  expectSandboxError(
    () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate[field] = true))),
    "sandbox_profile_unknown_field",
    `top-level ${field} override must fail closed`
  );
}

expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.runtime.available = false))),
  "sandbox_attestation_missing",
  "unavailable runtime"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => delete candidate.runtime.available)),
  "sandbox_attestation_missing",
  "missing runtime availability"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.runtime.rootless = false))),
  "sandbox_attestation_missing",
  "rootful runtime"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.runtime.remote = true))),
  "sandbox_attestation_missing",
  "remote runtime"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.runtime.effectiveUid = 0;
        candidate.runtime.engineUid = 0;
        candidate.runtime.controlEndpoint.ownerUid = 0;
      })
    ),
  "sandbox_profile_invalid",
  "root effective uid"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.runtime.engineUid = 1001))),
  "sandbox_runtime_not_rootless",
  "engine uid mismatch"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.runtime.subject.runId = "run-other"))),
  "sandbox_attestation_subject_mismatch",
  "runtime attestation from another run"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.runtime.engine = "docker";
        candidate.runtime.executable = "/usr/bin/docker";
        candidate.runtime.controlEndpoint.kind = "local-unix";
        candidate.runtime.controlEndpoint.path = "/var/run/docker.sock";
      })
    ),
  "sandbox_runtime_unavailable",
  "rootful Docker socket"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.runtime.executable = "/usr/bin/docker"))),
  "sandbox_runtime_unavailable",
  "runtime executable mismatch"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.runtime.executableVerified = false))),
  "sandbox_attestation_missing",
  "unverified runtime executable"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => (candidate.runtime.executableWritableByUntrusted = true))
    ),
  "sandbox_attestation_missing",
  "untrusted-writable runtime executable"
);

for (const capability of [
  "readOnlyRootfs",
  "capDropAll",
  "noNewPrivileges",
  "seccomp",
  "apparmor",
  "networkNone",
  "memoryLimit",
  "memorySwapLimit",
  "cpuLimit",
  "pidsLimit",
  "ulimit",
  "privateNamespaces",
  "cgroupNamespacePrivate",
  "ipcNone",
  "noImplicitHostMounts",
  "hostDevicesDisabled",
  "hostSocketForwardingDisabled",
  "logDriverNone",
]) {
  expectSandboxError(
    () =>
      buildPublicIntegrationSandboxInvocation(
        changedRequest((candidate) => (candidate.runtime.capabilities[capability] = false))
      ),
    "sandbox_attestation_missing",
    `missing runtime capability ${capability}`
  );
}

for (const assertion of [
  "wallTimeoutEnforced",
  "stdoutLimitEnforced",
  "stderrLimitEnforced",
  "workspaceQuotaEnforced",
  "abortKillsExactContainer",
  "reconcileByLabels",
  "killEscalation",
]) {
  expectSandboxError(
    () =>
      buildPublicIntegrationSandboxInvocation(
        changedRequest((candidate) => (candidate.runtime.supervisor[assertion] = false))
      ),
    "sandbox_attestation_missing",
    `missing supervisor assertion ${assertion}`
  );
}

expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => (candidate.runtime.security.seccomp.profilePath = "/tmp/seccomp.json"))
    ),
  "sandbox_security_profile_untrusted",
  "mutable seccomp path"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => (candidate.runtime.security.seccomp.writableByUntrusted = true))
    ),
  "sandbox_attestation_missing",
  "untrusted-writable seccomp profile"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => (candidate.runtime.security.seccomp.profileImmutable = false))
    ),
  "sandbox_attestation_missing",
  "mutable seccomp profile"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => (candidate.runtime.security.apparmor.profileLoaded = false))
    ),
  "sandbox_attestation_missing",
  "unloaded AppArmor profile"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.image = "aginti/public:latest"))),
  "sandbox_image_not_immutable",
  "mutable image tag"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => (candidate.runtime.image.reference = `registry.invalid/other@sha256:${"c".repeat(64)}`))
    ),
  "sandbox_image_not_immutable",
  "image attestation mismatch"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.runtime.image.approved = false))),
  "sandbox_attestation_missing",
  "unapproved image"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.runtime.image.volumesAbsent = false))),
  "sandbox_attestation_missing",
  "image-declared mutable volume"
);

expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.workspace.root = "/home/lachlan/workspaces";
        candidate.workspace.realRoot = candidate.workspace.root;
        candidate.workspace.path = "/home/lachlan/workspaces/thread-01";
        candidate.workspace.realPath = candidate.workspace.path;
      })
    ),
  "sandbox_workspace_forbidden",
  "host home workspace"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.workspace.root = "/var/lib";
        candidate.workspace.realRoot = candidate.workspace.root;
        candidate.workspace.path = "/var/lib/thread-01";
        candidate.workspace.realPath = candidate.workspace.path;
      })
    ),
  "sandbox_workspace_forbidden",
  "broad host data root"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.workspace.path = "/srv/other/thread-01";
        candidate.workspace.realPath = candidate.workspace.path;
      })
    ),
  "sandbox_workspace_forbidden",
  "workspace outside attested root"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.realPath = "/srv/other"))),
  "sandbox_workspace_forbidden",
  "workspace symlink mismatch"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.noSpecialFiles = false))),
  "sandbox_attestation_missing",
  "workspace special files"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.exclusiveLease = false))),
  "sandbox_attestation_missing",
  "shared workspace lease"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.runId = "run-other"))),
  "sandbox_workspace_forbidden",
  "workspace lease from another run"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.containerUid = 0))),
  "sandbox_workspace_forbidden",
  "root workspace user"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.quota.method = "directory-scan"))),
  "sandbox_quota_unproven",
  "non-enforcing workspace quota"
);
for (const unsupportedQuotaMethod of ["btrfs-qgroup", "zfs-dataset"]) {
  expectSandboxError(
    () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.quota.method = unsupportedQuotaMethod))),
    "sandbox_quota_unproven",
    `${unsupportedQuotaMethod} must not be accepted without inode enforcement proof`
  );
}
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.quota.enforced = false))),
  "sandbox_attestation_missing",
  "disabled workspace quota"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.quota.supportsInodes = false))),
  "sandbox_attestation_missing",
  "quota without inode support"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.workspace.quota.filesystem = { ...candidate.workspace.quota.filesystem, digest: digest("0") };
      })
    ),
  "sandbox_quota_unproven",
  "quota filesystem binding mismatch"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.quota.limitBytes -= 1))),
  "sandbox_quota_unproven",
  "quota/profile mismatch"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.workspace.quota.inodeLimit -= 1))),
  "sandbox_quota_unproven",
  "inode quota/profile mismatch"
);

expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.limits = { cpuMillis: 4001 };
      })
    ),
  "sandbox_profile_invalid",
  "CPU ceiling override"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.limits = { madeUpLimit: 1 };
      })
    ),
  "sandbox_profile_unknown_field",
  "unknown limit override"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.limits = { memoryBytes: 256 * 1024 * 1024, tmpfsBytes: 128 * 1024 * 1024 };
      })
    ),
  "sandbox_profile_invalid",
  "tmpfs aggregate above memory ratio"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.command = ["sh", "-lc", "true"]))),
  "sandbox_profile_invalid",
  "PATH-resolved entrypoint"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.command = ["/bin/sh\0evil"]))),
  "sandbox_profile_invalid",
  "NUL command"
);
expectSandboxError(
  () => buildPublicIntegrationSandboxInvocation(changedRequest((candidate) => (candidate.command = ["/bin/sh\nevil"]))),
  "sandbox_profile_invalid",
  "newline entrypoint"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.command = [];
        candidate.command[1] = "-lc";
      })
    ),
  "sandbox_profile_invalid",
  "sparse command array"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.command = ["/bin/sh"];
        Object.defineProperty(candidate.command, Symbol.iterator, {
          enumerable: true,
          value: function* hostileIterator() {
            yield "/bin/sh";
            yield "unchecked\0argv";
          },
        });
      })
    ),
  "sandbox_profile_unknown_field",
  "custom command iterator"
);

expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      (() => {
        const candidate = requestFixture();
        Object.defineProperty(candidate, "network", { enumerable: false, value: "host" });
        return candidate;
      })()
    ),
  "sandbox_profile_unknown_field",
  "non-enumerable request fields"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      (() => {
        const candidate = requestFixture();
        Object.defineProperty(candidate.runtime, "executable", {
          enumerable: true,
          get() {
            return "/usr/bin/podman";
          },
        });
        return candidate;
      })()
    ),
  "sandbox_profile_invalid",
  "accessor executable field"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.runtime.expiresAt = "2026-08-20T08:01:00.000Z";
      })
    ),
  "sandbox_fact_stale",
  "stale runtime facts"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.workspace.bootId = "fedcba98-7654-3210-fedc-ba9876543210";
      })
    ),
  "sandbox_fact_identity_mismatch",
  "workspace boot mismatch"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.runtime.executableIdentity.digest = digest("0");
      })
    ),
  "sandbox_fact_identity_mismatch",
  "runtime executable digest mismatch"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.runtime.controlEndpoint.identity.uid = 1001;
      })
    ),
  "sandbox_fact_identity_mismatch",
  "control endpoint owner mismatch"
);
expectSandboxError(
  () =>
    buildPublicIntegrationSandboxInvocation(
      changedRequest((candidate) => {
        candidate.workspace.uidMap.proven = false;
      })
    ),
  "sandbox_attestation_missing",
  "unproven uid map"
);

for (const [label, mutator] of [
  [
    "network host",
    (candidate) => {
      candidate.args[candidate.args.indexOf("--network") + 1] = "host";
    },
  ],
  [
    "engine logging enabled",
    (candidate) => {
      candidate.args[candidate.args.indexOf("--log-driver") + 1] = "json-file";
    },
  ],
  [
    "root user",
    (candidate) => {
      candidate.args[candidate.args.indexOf("--user") + 1] = "0:0";
    },
  ],
  [
    "missing read-only rootfs",
    (candidate) => {
      candidate.args.splice(candidate.args.indexOf("--read-only"), 1);
    },
  ],
  [
    "Docker socket mount",
    (candidate) => {
      candidate.args.splice(
        candidate.args.indexOf(candidate.container.image),
        0,
        "--mount",
        "type=bind,src=/run/user/1000/docker.sock,dst=/var/run/docker.sock,rw"
      );
    },
  ],
  [
    "host device",
    (candidate) => {
      candidate.args.splice(candidate.args.indexOf(candidate.container.image), 0, "--device", "/dev/dri:/dev/dri");
    },
  ],
  [
    "extra environment",
    (candidate) => {
      candidate.args.splice(candidate.args.indexOf(candidate.container.image), 0, "--env", "AWS_SECRET_ACCESS_KEY=secret");
    },
  ],
]) {
  expectSandboxError(
    () => attestPublicIntegrationSandboxInvocation(changedInvocation(invocation, mutator), request),
    "sandbox_invocation_tampered",
    `tampered invocation: ${label}`
  );
}

expectSandboxError(
  () =>
    attestPublicIntegrationSandboxInvocation(
      changedInvocation(invocation, (candidate) => (candidate.rawCommand = "podman run --privileged")),
      request
    ),
  "sandbox_profile_unknown_field",
  "unknown invocation representation"
);
expectSandboxError(
  () =>
    attestPublicIntegrationSandboxInvocation(
      changedInvocation(invocation, (candidate) => {
        candidate.args[candidate.args.indexOf("--network") + 1] = "host";
        Object.defineProperty(candidate, "toJSON", {
          enumerable: false,
          value() {
            return invocation;
          },
        });
      }),
      request
    ),
  "sandbox_profile_unknown_field",
  "non-enumerable toJSON must not hide tampered invocation"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      profileId: invocation.profileId,
      invocationDigest: invocation.attestation.digest,
      deterministic: true,
      enginesCovered: ["podman-rootless"],
      adversarialCases,
      dockerInvoked: false,
    },
    null,
    2
  )
);
