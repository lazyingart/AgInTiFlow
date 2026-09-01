import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../src/integration-analysis-planner.js";
import {
  DEFAULT_INTEGRATION_ANALYSIS_IDEMPOTENCY_ROOT,
  DEFAULT_INTEGRATION_ANALYSIS_SERVICE_STATE_ROOT,
  INTEGRATION_ANALYSIS_LISTEN_HOST,
  INTEGRATION_ANALYSIS_LISTEN_PORT,
  INTEGRATION_ANALYSIS_LOCALLLM_BASE_URL,
  INTEGRATION_ANALYSIS_LOCALLLM_CONTEXT_TOKENS,
  INTEGRATION_ANALYSIS_LOCALLLM_MODEL,
  INTEGRATION_ANALYSIS_LOCALLLM_OUTPUT_TOKENS,
  INTEGRATION_ANALYSIS_LOCALLLM_TIMEOUT_MS,
  INTEGRATION_ANALYSIS_SERVICE_CONFIG_SCHEMA_VERSION,
  INTEGRATION_ANALYSIS_TRUSTED_CLIENT_ID,
} from "../src/integration-analysis-config.js";
import { createTestOnlyIntegrationAnalysisPrelistenComposition } from "../src/integration-analysis-server.js";
import {
  INTEGRATION_ANALYSIS_STARTUP_RECOVERY_SCHEMA_VERSION,
  createTestOnlyIntegrationAnalysisSessionService,
} from "../src/integration-analysis-session-service.js";
import { INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES } from "../src/integration-analysis-state-persistence.js";
import { INTEGRATION_RPC_PATH_LIST, contractDigest } from "../src/integration-policy.js";

function scope(index) {
  return Object.freeze({
    principalId: `principal-recovery-${String(index).padStart(2, "0")}`,
    browserSessionId: crypto.createHash("sha256").update(`recovery-browser-${index}`).digest("hex"),
  });
}

function completedResult(text = "Recovered startup accepted new traffic.") {
  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
    text,
    kind: "direct",
    toolCalls: 0,
    executionStatus: null,
    artifacts: Object.freeze([]),
  });
}

function heldRunner() {
  const held = new Map();
  const runner = Object.freeze({
    held,
    async run(runScope, _input, options = {}) {
      return new Promise((resolve, reject) => {
        const abort = () => {
          held.delete(runScope.runId);
          const error = new Error("synthetic crash source aborted");
          error.code = "ANALYSIS_CANCELLED";
          error.publicCode = error.code;
          error.status = 499;
          reject(error);
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        held.set(runScope.runId, Object.freeze({
          release() {
            options.signal?.removeEventListener("abort", abort);
            held.delete(runScope.runId);
            resolve(completedResult());
          },
        }));
      });
    },
  });
  return runner;
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(label);
}

async function stateFile(root) {
  const scopes = await fs.readdir(path.join(root, "scopes"));
  assert.equal(scopes.length, 1);
  return path.join(root, "scopes", scopes[0], "state.json");
}

async function scopeStateSnapshots(root) {
  const directory = path.join(root, "scopes");
  const names = (await fs.readdir(directory)).sort();
  return Promise.all(names.map(async (name) => {
    const target = path.join(directory, name, "state.json");
    const bytes = await fs.readFile(target);
    return Object.freeze({ name, target, bytes, envelope: JSON.parse(bytes.toString("utf8")) });
  }));
}

async function writePrivateFile(target, bytes) {
  await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  await fs.chmod(target, 0o600);
}

async function createStaleOwnerLockQuarantine(root, breakerPid = 999_999_999) {
  const quarantine = path.join(
    root,
    `.analysis-session-owner.lock.stale-${breakerPid}-${"a".repeat(16)}`
  );
  await fs.mkdir(quarantine, { mode: 0o700 });
  await writePrivateFile(
    path.join(quarantine, "owner.json"),
    `${JSON.stringify({
      schemaVersion: "aginti-directory-lock-v1",
      pid: 999_999_998,
      token: "b".repeat(32),
      acquiredAt: "2020-01-01T00:00:00.000Z",
    })}\n`
  );
  return quarantine;
}

async function createLinkedDeadOwnerLock(root) {
  const lockRoot = path.join(root, ".analysis-session-owner.lock");
  await fs.mkdir(lockRoot, { mode: 0o700 });
  const owner = {
    schemaVersion: "aginti-directory-lock-v1",
    pid: 999_999_991,
    token: "f".repeat(32),
    processIdentity: {
      schemaVersion: "aginti-process-identity-v1",
      bootId: "deadbeef-dead-beef-dead-beefdeadbeef",
      startTimeTicks: "12345",
    },
    acquiredAt: "2020-01-01T00:00:00.000Z",
  };
  const linked = path.join(lockRoot, `.owner.json.${owner.pid}.${"e".repeat(16)}.tmp`);
  await writePrivateFile(linked, `${JSON.stringify(owner)}\n`);
  await fs.link(linked, path.join(lockRoot, "owner.json"));
  await writePrivateFile(
    path.join(lockRoot, `.owner.json.999999990.${"1".repeat(16)}.tmp`),
    ""
  );
  await writePrivateFile(
    path.join(lockRoot, `.owner.json.999999989.${"2".repeat(16)}.tmp`),
    "loser"
  );
  return lockRoot;
}

function serviceConfig() {
  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_SERVICE_CONFIG_SCHEMA_VERSION,
    capability: Object.freeze({ enabled: true, mode: "analysis-execution" }),
    listen: Object.freeze({ host: INTEGRATION_ANALYSIS_LISTEN_HOST, port: INTEGRATION_ANALYSIS_LISTEN_PORT }),
    stateRoot: DEFAULT_INTEGRATION_ANALYSIS_SERVICE_STATE_ROOT,
    idempotencyRoot: DEFAULT_INTEGRATION_ANALYSIS_IDEMPOTENCY_ROOT,
    statePersistence: Object.freeze({ mode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3 }),
    localModel: Object.freeze({
      baseURL: INTEGRATION_ANALYSIS_LOCALLLM_BASE_URL,
      model: INTEGRATION_ANALYSIS_LOCALLLM_MODEL,
      contextWindowTokens: INTEGRATION_ANALYSIS_LOCALLLM_CONTEXT_TOKENS,
      maxOutputTokens: INTEGRATION_ANALYSIS_LOCALLLM_OUTPUT_TOKENS,
      modelTimeoutMs: INTEGRATION_ANALYSIS_LOCALLLM_TIMEOUT_MS,
    }),
    trustedPrincipalProxy: Object.freeze({
      clientId: INTEGRATION_ANALYSIS_TRUSTED_CLIENT_ID,
      label: "LazyingAgentWeb BFF",
      scopes: Object.freeze([...INTEGRATION_RPC_PATH_LIST]),
    }),
  });
}

async function compositionOrderingSmoke() {
  const events = [];
  let listenerCreated = false;
  let listenerStarted = false;
  let recoveryComplete = false;
  let mutations = 0;
  let releaseStateRecovery;
  let stateRecoveryEnteredResolve;
  const stateRecoveryEntered = new Promise((resolve) => {
    stateRecoveryEnteredResolve = resolve;
  });
  const stateRecoveryGate = new Promise((resolve) => {
    releaseStateRecovery = resolve;
  });
  const stateProof = Object.freeze({ digest: contractDigest("state-startup-recovery") });
  const idempotencyProof = Object.freeze({ digest: contractDigest("idempotency-startup-recovery") });
  const sessionService = Object.freeze({
    async recoverBeforeListen() {
      events.push("state-recovery-start");
      stateRecoveryEnteredResolve();
      await stateRecoveryGate;
      recoveryComplete = true;
      events.push("state-recovery-complete");
      return stateProof;
    },
    async getIntegrationCapabilities() {
      assert.equal(recoveryComplete, true);
      events.push("capabilities");
      return Object.freeze({ mutationRecoveryAuthority: Object.freeze({ atomicWithMutation: true }) });
    },
    async close() {
      events.push("session-close");
    },
  });
  const idempotencyStore = Object.freeze({
    async recoverBeforeListen() {
      assert.equal(recoveryComplete, true);
      assert.equal(listenerCreated, false);
      events.push("idempotency-recovery");
      return idempotencyProof;
    },
  });
  const coordinator = Object.freeze({
    async close() {
      events.push("coordinator-close");
    },
  });
  const serverFactory = () => {
    assert.equal(recoveryComplete, true);
    assert(events.includes("idempotency-recovery"));
    listenerCreated = true;
    events.push("server-created");
    return Object.freeze({
      app: Object.freeze({}),
      server: Object.freeze({}),
      config: Object.freeze({ listen: Object.freeze({ host: "127.0.0.1", port: 18009 }) }),
      async start() {
        listenerStarted = true;
        events.push("listener-started");
        return Object.freeze({ address: "127.0.0.1", port: 18009, family: "IPv4" });
      },
      async close() {
        listenerStarted = false;
        events.push("listener-close");
        return Object.freeze({ closed: true, forced: false });
      },
      get listening() {
        return listenerStarted;
      },
      get lifecycle() {
        return listenerStarted ? "listening" : "created";
      },
    });
  };
  const composition = createTestOnlyIntegrationAnalysisPrelistenComposition({
    config: serviceConfig(),
    trustedPrincipalProxyClient: Object.freeze({}),
    sessionService,
    idempotencyStore,
    coordinator,
    startupProof: Object.freeze({ digest: contractDigest("planner-startup") }),
    activationFactory: async ({ startupRecoveryProof }) => {
      assert.equal(listenerCreated, false);
      assert.equal(startupRecoveryProof.stateRecovery, stateProof);
      assert.equal(startupRecoveryProof.idempotencyRecovery, idempotencyProof);
      events.push("activation");
      return Object.freeze({ digest: contractDigest("activation") });
    },
    serverFactory,
  });
  await stateRecoveryEntered;
  const mutate = () => {
    if (!listenerStarted) return Object.freeze({ accepted: false, status: 503 });
    mutations += 1;
    return Object.freeze({ accepted: true, status: 200 });
  };
  assert.deepEqual(mutate(), { accepted: false, status: 503 });
  assert.equal(listenerCreated, false, "no HTTP application may exist while state recovery is pending");
  releaseStateRecovery();
  const managed = await composition;
  const immutableDigest = managed.startupRecoveryProof.digest;
  assert.deepEqual(events.slice(0, 5), [
    "state-recovery-start",
    "state-recovery-complete",
    "idempotency-recovery",
    "capabilities",
    "activation",
  ]);
  assert.equal(events[5], "server-created");
  await managed.start();
  assert.deepEqual(mutate(), { accepted: true, status: 200 });
  assert.equal(mutations, 1);
  assert.equal(managed.startupRecoveryProof.digest, immutableDigest);
  await managed.close({ timeoutMs: 1_000 });

  const fractionalTimeouts = [];
  const fractionalTicks = [10.25, 10.75, 11.5];
  const fractionalManaged = await createTestOnlyIntegrationAnalysisPrelistenComposition({
    config: serviceConfig(),
    trustedPrincipalProxyClient: Object.freeze({}),
    sessionService: Object.freeze({
      async recoverBeforeListen({ timeoutMs }) {
        assert.equal(Number.isSafeInteger(timeoutMs), true);
        fractionalTimeouts.push(timeoutMs);
        return stateProof;
      },
      async getIntegrationCapabilities() {
        return Object.freeze({ mutationRecoveryAuthority: Object.freeze({ atomicWithMutation: true }) });
      },
      async close() {},
    }),
    idempotencyStore: Object.freeze({
      async recoverBeforeListen({ timeoutMs }) {
        assert.equal(Number.isSafeInteger(timeoutMs), true);
        fractionalTimeouts.push(timeoutMs);
        return idempotencyProof;
      },
    }),
    coordinator: Object.freeze({ async close() {} }),
    startupProof: Object.freeze({ digest: contractDigest("fractional-startup") }),
    recoveryTimeoutMs: 1_000,
    monotonicNow: () => fractionalTicks.shift() ?? 11.5,
    activationFactory: async () => Object.freeze({ digest: contractDigest("fractional-activation") }),
    serverFactory: () => Object.freeze({
      app: Object.freeze({}),
      server: Object.freeze({}),
      config: Object.freeze({ listen: Object.freeze({ host: "127.0.0.1", port: 18009 }) }),
      async close() {
        return Object.freeze({ closed: true, forced: false });
      },
      get listening() {
        return false;
      },
      get lifecycle() {
        return "created";
      },
    }),
  });
  assert.deepEqual(fractionalTimeouts, [999, 998]);
  await fractionalManaged.close({ timeoutMs: 1_000 });

  for (const failure of [
    Object.assign(new Error("synthetic corrupt state"), { code: "ANALYSIS_STATE_CORRUPT" }),
    Object.assign(new Error("synthetic recovery timeout"), { code: "ANALYSIS_STARTUP_RECOVERY_TIMEOUT" }),
  ]) {
    const failedEvents = [];
    let failedServerCreated = false;
    await assert.rejects(
      () => createTestOnlyIntegrationAnalysisPrelistenComposition({
        config: serviceConfig(),
        trustedPrincipalProxyClient: Object.freeze({}),
        sessionService: Object.freeze({
          async recoverBeforeListen() {
            throw failure;
          },
          async getIntegrationCapabilities() {
            assert.fail("capabilities must not run after failed state recovery");
          },
          async close() {
            failedEvents.push("session-close");
          },
        }),
        idempotencyStore: Object.freeze({
          async recoverBeforeListen() {
            assert.fail("idempotency recovery must not run after failed state recovery");
          },
        }),
        coordinator: Object.freeze({
          async close() {
            failedEvents.push("coordinator-close");
          },
        }),
        startupProof: Object.freeze({ digest: contractDigest("failed-startup") }),
        activationFactory: async () => assert.fail("activation must not be minted after failed recovery"),
        serverFactory: () => {
          failedServerCreated = true;
          assert.fail("server must not be created after failed recovery");
        },
      }),
      (error) => error === failure
    );
    assert.equal(failedServerCreated, false);
    assert.deepEqual(failedEvents, ["session-close", "coordinator-close"]);
  }

  const deadlineEvents = [];
  await assert.rejects(
    () => createTestOnlyIntegrationAnalysisPrelistenComposition({
      config: serviceConfig(),
      trustedPrincipalProxyClient: Object.freeze({}),
      sessionService: Object.freeze({
        async recoverBeforeListen() {
          await new Promise((resolve) => setTimeout(resolve, 125));
          return stateProof;
        },
        async getIntegrationCapabilities() {
          assert.fail("capabilities must not run after the shared deadline");
        },
        async close() {
          deadlineEvents.push("session-close");
        },
      }),
      idempotencyStore: Object.freeze({
        async recoverBeforeListen() {
          assert.fail("idempotency recovery must not start after the shared deadline");
        },
      }),
      coordinator: Object.freeze({
        async close() {
          deadlineEvents.push("coordinator-close");
        },
      }),
      startupProof: Object.freeze({ digest: contractDigest("deadline-startup") }),
      recoveryTimeoutMs: 100,
      activationFactory: async () => assert.fail("activation must not be minted after the shared deadline"),
      serverFactory: () => assert.fail("server must not be created after the shared deadline"),
    }),
    (error) => error.code === "ANALYSIS_STARTUP_RECOVERY_TIMEOUT"
  );
  assert.deepEqual(deadlineEvents, ["session-close", "coordinator-close"]);

  const monotonicEvents = [];
  const monotonicTicks = [0, 1, 1_001];
  await assert.rejects(
    () => createTestOnlyIntegrationAnalysisPrelistenComposition({
      config: serviceConfig(),
      trustedPrincipalProxyClient: Object.freeze({}),
      sessionService: Object.freeze({
        async recoverBeforeListen() {
          monotonicEvents.push("state-recovery");
          return stateProof;
        },
        async getIntegrationCapabilities() {
          assert.fail("capabilities must not run after monotonic deadline exhaustion");
        },
        async close() {
          monotonicEvents.push("session-close");
        },
      }),
      idempotencyStore: Object.freeze({
        async recoverBeforeListen() {
          assert.fail("idempotency recovery must not start after monotonic deadline exhaustion");
        },
      }),
      coordinator: Object.freeze({
        async close() {
          monotonicEvents.push("coordinator-close");
        },
      }),
      startupProof: Object.freeze({ digest: contractDigest("monotonic-deadline-startup") }),
      recoveryTimeoutMs: 1_000,
      monotonicNow: () => monotonicTicks.shift() ?? 1_001,
      activationFactory: async () => assert.fail("activation must not outlive monotonic deadline"),
      serverFactory: () => assert.fail("server must not outlive monotonic deadline"),
    }),
    (error) => error.code === "ANALYSIS_STARTUP_RECOVERY_TIMEOUT"
  );
  assert.deepEqual(monotonicEvents, ["state-recovery", "session-close", "coordinator-close"]);
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-startup-recovery-"));
let sourceService = null;
let recoveryService = null;
let timeoutService = null;
let corruptService = null;
let compatibleSource = null;
let compatibleRecovery = null;
let partialService = null;
let partialRetryService = null;
let residueService = null;
let missingStateService = null;
let stagedMismatchService = null;
let liveStateLossService = null;
try {
  await compositionOrderingSmoke();
  const sourceRoot = path.join(temporaryRoot, "source");
  const crashedRoot = path.join(temporaryRoot, "crashed");
  const sourceRunner = heldRunner();
  sourceService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: sourceRunner,
    stateRoot: sourceRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
  });
  const runs = [];
  for (let index = 0; index < 18; index += 1) {
    const runScope = scope(index);
    const thread = await sourceService.createThread({ title: `Recovery scope ${index}` }, runScope);
    const started = await sourceService.startRun({
      threadId: thread.thread.id,
      input: { text: `Hold recovery run ${index}.` },
    }, runScope);
    runs.push(Object.freeze({ scope: runScope, runId: started.run.id }));
  }
  await waitFor(
    () => sourceRunner.held.size === 2,
    "the 2-running + 16-queued crash fixture did not reach its bounded scheduling floor"
  );
  await fs.cp(sourceRoot, crashedRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".analysis-session-owner.lock",
  });
  await sourceService.close({ mode: "abort", timeoutMs: 30_000 });
  sourceService = null;

  const recoveryRunner = Object.freeze({
    async run(_scope, _input, options = {}) {
      const result = completedResult();
      await options.onFinal?.(result);
      return result;
    },
  });
  const residueRoot = path.join(temporaryRoot, "crash-residue-recovery");
  await fs.cp(crashedRoot, residueRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".analysis-session-owner.lock",
  });
  const residueScopeRoot = path.join(residueRoot, "scopes");
  const residueScopeNames = (await fs.readdir(residueScopeRoot)).sort();
  const residuePayloads = [
    Buffer.alloc(0),
    Buffer.from("{", "utf8"),
    (await fs.readFile(path.join(residueScopeRoot, residueScopeNames[2], "state.json"))).subarray(0, 127),
    await fs.readFile(path.join(residueScopeRoot, residueScopeNames[3], "state.json")),
  ];
  for (let index = 0; index < residuePayloads.length; index += 1) {
    await writePrivateFile(
      path.join(
        residueScopeRoot,
        residueScopeNames[index],
        `.state.99999999${index}.${String(index + 1).repeat(24)}.tmp`
      ),
      residuePayloads[index]
    );
  }
  const emptyScopeDigest = crypto.createHash("sha256").update("empty-scope-crash-residue").digest("hex");
  const temporaryOnlyScopeDigest = crypto.createHash("sha256").update("temporary-only-scope-crash-residue").digest("hex");
  const emptyScope = `.scope.${emptyScopeDigest}.999999996.${"c".repeat(24)}.tmp`;
  const temporaryOnlyScope = `.scope.${temporaryOnlyScopeDigest}.999999997.${"d".repeat(24)}.tmp`;
  await fs.mkdir(path.join(residueScopeRoot, emptyScope), { mode: 0o700 });
  await fs.mkdir(path.join(residueScopeRoot, temporaryOnlyScope), { mode: 0o700 });
  await writePrivateFile(
    path.join(residueScopeRoot, temporaryOnlyScope, `.state.999999997.${"e".repeat(24)}.tmp`),
    Buffer.from("partial-state", "utf8")
  );
  const stateLockQuarantine = await createStaleOwnerLockQuarantine(residueRoot);
  const linkedStateOwnerLock = await createLinkedDeadOwnerLock(residueRoot);
  residueService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: residueRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
  });
  const residueProof = await residueService.recoverBeforeListen({ timeoutMs: 30_000 });
  assert.equal(residueProof.scopeCount, 18);
  assert.equal(residueProof.nonterminalRunsRecovered, 18);
  assert.equal(residueProof.deferredOptionalDocumentRuns, 0);
  for (let index = 0; index < residuePayloads.length; index += 1) {
    const names = await fs.readdir(path.join(residueScopeRoot, residueScopeNames[index]));
    assert.equal(names.some((name) => name.startsWith(".state.")), false);
  }
  for (const removed of [emptyScope, temporaryOnlyScope]) {
    await fs.access(path.join(residueScopeRoot, removed)).then(
      () => assert.fail("uncommitted empty scope residue must be removed before listener activation"),
      (error) => assert.equal(error.code, "ENOENT")
    );
  }
  await fs.access(stateLockQuarantine).then(
    () => assert.fail("stale state-owner lock quarantine must be removed before listener activation"),
    (error) => assert.equal(error.code, "ENOENT")
  );
  assert.deepEqual(
    await fs.readdir(linkedStateOwnerLock),
    ["owner.json"],
    "linked state-owner publication and loser temporaries must be canonicalized before listener activation"
  );
  assert.equal((await fs.lstat(path.join(linkedStateOwnerLock, "owner.json"))).nlink, 1);
  await residueService.close({ mode: "wait" });
  residueService = null;
  await fs.access(linkedStateOwnerLock).then(
    () => assert.fail("recovered state-owner lock must release after service close"),
    (error) => assert.equal(error.code, "ENOENT")
  );

  const missingStateRoot = path.join(temporaryRoot, "missing-canonical-state-refusal");
  await fs.cp(residueRoot, missingStateRoot, { recursive: true });
  const missingStateScope = crypto.createHash("sha256").update("missing-canonical-state").digest("hex");
  await fs.mkdir(path.join(missingStateRoot, "scopes", missingStateScope), { mode: 0o700 });
  missingStateService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: missingStateRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
  });
  await assert.rejects(
    () => missingStateService.recoverBeforeListen({ timeoutMs: 1_000 }),
    (error) => error.code === "ANALYSIS_STATE_CORRUPT"
  );
  await missingStateService.close({ mode: "abort" }).catch(() => {});
  missingStateService = null;

  const stagedMismatchRoot = path.join(temporaryRoot, "staged-scope-pid-mismatch-refusal");
  await fs.cp(residueRoot, stagedMismatchRoot, { recursive: true });
  const mismatchedStaged = path.join(
    stagedMismatchRoot,
    "scopes",
    `.scope.${"1".repeat(64)}.999999991.${"2".repeat(24)}.tmp`
  );
  await fs.mkdir(mismatchedStaged, { mode: 0o700 });
  await writePrivateFile(
    path.join(mismatchedStaged, `.state.999999990.${"3".repeat(24)}.tmp`),
    Buffer.from("mismatched creator", "utf8")
  );
  stagedMismatchService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: stagedMismatchRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
  });
  await assert.rejects(
    () => stagedMismatchService.recoverBeforeListen({ timeoutMs: 1_000 }),
    (error) => error.code === "ANALYSIS_STATE_CORRUPT"
  );
  await stagedMismatchService.close({ mode: "abort" }).catch(() => {});
  stagedMismatchService = null;

  const liveStateLossRoot = path.join(temporaryRoot, "live-state-loss-refusal");
  const liveStateLossScope = scope(301);
  liveStateLossService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: liveStateLossRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
  });
  await liveStateLossService.createThread({ title: "State loss authority" }, liveStateLossScope);
  const liveStatePath = await stateFile(liveStateLossRoot);
  await fs.unlink(liveStatePath);
  await assert.rejects(
    () => liveStateLossService.createThread({ title: "Must not reset lost state" }, liveStateLossScope),
    (error) => error.code === "ANALYSIS_STATE_CORRUPT"
  );
  assert.deepEqual(await fs.readdir(path.dirname(liveStatePath)), []);
  await liveStateLossService.close({ mode: "abort" }).catch(() => {});
  liveStateLossService = null;

  const partialRoot = path.join(temporaryRoot, "partial-recovery");
  await fs.cp(crashedRoot, partialRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".analysis-session-owner.lock",
  });
  partialService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: partialRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
    async beforeStartupRecoveryScope({ index }) {
      if (index === 5) await new Promise((resolve) => setTimeout(resolve, 2_000));
    },
  });
  await assert.rejects(
    () => partialService.recoverBeforeListen({ timeoutMs: 1_000 }),
    (error) => error.code === "ANALYSIS_STARTUP_RECOVERY_TIMEOUT"
  );
  await partialService.close({ mode: "abort" });
  partialService = null;
  const partialSnapshots = await scopeStateSnapshots(partialRoot);
  const alreadyRecovered = partialSnapshots.filter(({ envelope }) =>
    envelope.state.runs.every((run) => run.status === "failed")
  );
  assert.equal(alreadyRecovered.length, 5, "startup interruption did not persist the exact completed prefix");
  assert.equal(
    partialSnapshots.filter(({ envelope }) =>
      envelope.state.runs.some((run) => !new Set(["completed", "failed", "cancelled"]).has(run.status))
    ).length,
    13
  );
  for (const { envelope } of alreadyRecovered) {
    assert.equal(envelope.state.runs[0].events.filter(({ type }) => type === "run.failed").length, 1);
    assert.equal(envelope.state.mutationReceipts.length, 0);
  }
  const stableRecoveredPrefix = new Map(alreadyRecovered.map(({ name, bytes }) => [name, bytes]));
  partialRetryService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: partialRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
  });
  const partialRetryProof = await partialRetryService.recoverBeforeListen({ timeoutMs: 30_000 });
  assert.equal(partialRetryProof.scopeCount, 18);
  assert.equal(partialRetryProof.nonterminalRunsObserved, 13);
  assert.equal(partialRetryProof.nonterminalRunsRecovered, 13);
  assert.equal(partialRetryProof.nonterminalRunsRemaining, 0);
  assert.equal(partialRetryProof.deferredOptionalDocumentRuns, 0);
  const retriedSnapshots = await scopeStateSnapshots(partialRoot);
  for (const snapshot of retriedSnapshots) {
    assert(snapshot.envelope.state.runs.every((run) => run.status === "failed"));
    assert.equal(snapshot.envelope.state.runs[0].events.filter(({ type }) => type === "run.failed").length, 1);
    assert.equal(snapshot.envelope.state.mutationReceipts.length, 0);
    const stable = stableRecoveredPrefix.get(snapshot.name);
    if (stable) {
      assert.deepEqual(
        snapshot.bytes,
        stable,
        "retry changed an already recovered scope or duplicated terminal evidence"
      );
    }
  }
  const partialLiveScope = scope(98);
  const partialLiveThread = await partialRetryService.createThread({ title: "Traffic after resumed recovery" }, partialLiveScope);
  const partialLiveRun = await partialRetryService.startRun({
    threadId: partialLiveThread.thread.id,
    input: { text: "Complete after resumed startup recovery." },
  }, partialLiveScope);
  await partialRetryService.waitForIdle();
  assert.equal(
    (await partialRetryService.getRunStatus({ runId: partialLiveRun.run.id }, partialLiveScope)).run.status,
    "completed"
  );
  await partialRetryService.close({ mode: "wait" });
  partialRetryService = null;

  recoveryService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: crashedRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
  });
  const proof = await recoveryService.recoverBeforeListen({ timeoutMs: 30_000 });
  assert.equal(proof.schemaVersion, INTEGRATION_ANALYSIS_STARTUP_RECOVERY_SCHEMA_VERSION);
  assert.equal(proof.beforeListen, true);
  assert.equal(proof.performed, true);
  assert.equal(proof.scopeCount, 18);
  assert.equal(proof.nonterminalRunsObserved, 18);
  assert.equal(proof.nonterminalRunsRecovered, 18);
  assert.equal(proof.nonterminalRunsRemaining, 0);
  assert.equal(proof.deferredOptionalDocumentRuns, 0);
  assert.equal(proof.recoveryScopeDigests.length, 18);
  assert.equal(new Set(proof.recoveryScopeDigests).size, 18);
  assert.equal(recoveryService.getStartupRecoveryProof(), proof);
  for (const run of runs) {
    const recovered = (await recoveryService.getRunStatus({ runId: run.runId }, run.scope)).run;
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error.code, "RUN_INTERRUPTED");
  }

  const liveScope = scope(99);
  const liveThread = await recoveryService.createThread({ title: "Post-listen traffic" }, liveScope);
  const liveRun = await recoveryService.startRun({
    threadId: liveThread.thread.id,
    input: { text: "Complete after startup recovery." },
  }, liveScope);
  await recoveryService.waitForIdle();
  assert.equal((await recoveryService.getRunStatus({ runId: liveRun.run.id }, liveScope)).run.status, "completed");
  assert.equal(
    recoveryService.getStartupRecoveryProof().digest,
    proof.digest,
    "ordinary post-recovery traffic must not invalidate the immutable pre-listen proof"
  );
  await recoveryService.close({ mode: "wait" });
  recoveryService = null;

  const timeoutRoot = path.join(temporaryRoot, "timeout");
  await fs.cp(crashedRoot, timeoutRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".analysis-session-owner.lock",
  });
  timeoutService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: timeoutRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
    async beforeStartupRecoveryScope() {
      await new Promise((resolve) => setTimeout(resolve, 125));
    },
  });
  await assert.rejects(
    () => timeoutService.recoverBeforeListen({ timeoutMs: 100 }),
    (error) => error.code === "ANALYSIS_STARTUP_RECOVERY_TIMEOUT"
  );
  await timeoutService.close({ mode: "abort" });
  timeoutService = null;

  const corruptRoot = path.join(temporaryRoot, "corrupt");
  await fs.cp(crashedRoot, corruptRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".analysis-session-owner.lock",
  });
  const corruptScopes = path.join(corruptRoot, "scopes");
  const firstScope = (await fs.readdir(corruptScopes)).sort()[0];
  const firstScopePath = path.join(corruptScopes, firstScope);
  await fs.rm(firstScopePath, { recursive: true });
  await fs.symlink(path.join(crashedRoot, "scopes", firstScope), firstScopePath);
  corruptService = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: corruptRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
  });
  await assert.rejects(
    () => corruptService.recoverBeforeListen({ timeoutMs: 1_000 }),
    (error) => error.code === "ANALYSIS_STATE_CORRUPT"
  );
  await corruptService.close({ mode: "abort" }).catch(() => {});
  corruptService = null;

  const compatibleRoot = path.join(temporaryRoot, "compatible-v2");
  compatibleSource = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: compatibleRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2,
  });
  await compatibleSource.createThread({ title: "Compatibility floor" }, scope(200));
  await compatibleSource.close({ mode: "wait" });
  compatibleSource = null;
  const compatibleState = await stateFile(compatibleRoot);
  const compatibleBefore = await fs.readFile(compatibleState);
  const compatibleScopeDirectory = path.dirname(compatibleState);
  const compatibleStateTemporary = path.join(
    compatibleScopeDirectory,
    `.state.999999993.${"8".repeat(24)}.tmp`
  );
  await writePrivateFile(compatibleStateTemporary, compatibleBefore.subarray(0, 53));
  const compatibleStagedDirectory = path.join(
    compatibleRoot,
    "scopes",
    `.scope.${"9".repeat(64)}.999999992.${"7".repeat(24)}.tmp`
  );
  await fs.mkdir(compatibleStagedDirectory, { mode: 0o700 });
  compatibleRecovery = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: recoveryRunner,
    stateRoot: compatibleRoot,
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2,
  });
  const compatibleProof = await compatibleRecovery.recoverBeforeListen({ timeoutMs: 1_000 });
  assert.equal(compatibleProof.performed, false);
  assert.equal(compatibleProof.scopeCount, null);
  assert.equal(compatibleProof.deferredOptionalDocumentRuns, null);
  assert.deepEqual(await fs.readFile(compatibleState), compatibleBefore);
  for (const residue of [compatibleStateTemporary, compatibleStagedDirectory]) {
    await fs.access(residue).then(
      () => assert.fail("compatible-v2 startup residue must be reclaimed before listener activation"),
      (error) => assert.equal(error.code, "ENOENT")
    );
  }
  await compatibleRecovery.close({ mode: "wait" });
  compatibleRecovery = null;
} finally {
  await sourceService?.close({ mode: "abort" }).catch(() => {});
  await recoveryService?.close({ mode: "abort" }).catch(() => {});
  await timeoutService?.close({ mode: "abort" }).catch(() => {});
  await corruptService?.close({ mode: "abort" }).catch(() => {});
  await compatibleSource?.close({ mode: "abort" }).catch(() => {});
  await compatibleRecovery?.close({ mode: "abort" }).catch(() => {});
  await partialService?.close({ mode: "abort" }).catch(() => {});
  await partialRetryService?.close({ mode: "abort" }).catch(() => {});
  await residueService?.close({ mode: "abort" }).catch(() => {});
  await missingStateService?.close({ mode: "abort" }).catch(() => {});
  await stagedMismatchService?.close({ mode: "abort" }).catch(() => {});
  await liveStateLossService?.close({ mode: "abort" }).catch(() => {});
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("smoke-integration-analysis-startup-recovery ok");
