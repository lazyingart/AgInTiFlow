#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFixedIntegrationPolicy,
  contractDigest,
} from "../src/integration-policy.js";
import {
  NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
  buildFixedNativeRunAgentConfig,
  executeNativeAgintiRun,
  expectedFixedSessionRuntimeSnapshot,
} from "../src/integration-native-executor.js";
import { runWithIntegrationSessionScope } from "../src/integration-session-persistence.js";
import { SessionStore } from "../src/session-store.js";
import { runAgent } from "../src/agent-runner.js";
import { flushHousekeeping } from "../src/housekeeping.js";

let SMOKE_ROOT = "";
const ZERO_DIGEST = "0".repeat(64);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function runtimeRoots(name) {
  const unsigned = {
    schemaVersion: NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
    sessionsDir: `${SMOKE_ROOT}/${name}/state/sessions`,
    baseDir: `${SMOKE_ROOT}/${name}/workspace`,
    commandCwd: `${SMOKE_ROOT}/${name}/workspace`,
    retainedDescriptor: true,
    symlinkFree: true,
    outsideForbiddenRoots: true,
  };
  return deepFreeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function fixedConfig({ name, sessionId, mode = "start", expectedRuntimeRevision = 1, inputText = "hello" }) {
  return buildFixedNativeRunAgentConfig({
    mode,
    policy: buildFixedIntegrationPolicy(),
    nativeSessionId: sessionId,
    inputText,
    abortSignal: new AbortController().signal,
    onEvent() {},
    repositoryRoots: runtimeRoots(name),
    expectedRuntimeRevision,
  });
}

function storeFor(config) {
  return new SessionStore(config.sessionsDir, config.sessionId, {
    projectRoot: config.baseDir,
    commandCwd: config.commandCwd,
    projectSessionsDir: path.join(config.baseDir, ".aginti-sessions"),
  });
}

function stateFor(config, revision) {
  const now = new Date().toISOString();
  return {
    sessionId: config.sessionId,
    createdAt: now,
    updatedAt: now,
    provider: config.provider,
    model: config.model,
    goal: config.goal,
    baseDir: config.baseDir,
    commandCwd: config.commandCwd,
    plan: "",
    stepsCompleted: 0,
    meta: {
      runtimeConfig: expectedFixedSessionRuntimeSnapshot(config, revision),
      integrationPolicyLock: config.integrationPolicyLock,
      integrationPolicyFingerprint: config.integrationPolicyFingerprint,
      integrationRuntimeRootsDigest: config.integrationRuntimeRootsDigest,
    },
    messages: [],
    chat: [],
  };
}

async function exists(filePath) {
  return fs.stat(filePath).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

async function readOptional(filePath) {
  return fs.readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
}

async function writeState(config, state) {
  const store = new SessionStore(config.sessionsDir, config.sessionId, {
    projectRoot: config.baseDir,
    commandCwd: config.commandCwd,
  });
  await fs.mkdir(store.sessionDir, { recursive: true });
  await fs.writeFile(store.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function expectRejects(action, pattern) {
  await assert.rejects(
    async () => action(),
    (error) => pattern.test(`${String(error?.code || "")} ${String(error?.message || error)}`)
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scopedSave(config, revision) {
  return runWithIntegrationSessionScope(config, async () => {
    const store = storeFor(config);
    await store.ensure();
    const before = await store.loadState();
    if (config.resume) assert(before, "resume should load state");
    else assert.equal(before, null);
    await store.saveState(stateFor(config, revision));
    return JSON.parse(await fs.readFile(store.statePath, "utf8"));
  });
}

async function main() {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const previousHome = process.env.AGINTIFLOW_HOME;
  const previousHousekeeping = process.env.AGINTIFLOW_HOUSEKEEPING;
  SMOKE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-session-persistence-"));
  process.env.AGINTIFLOW_HOME = path.join(SMOKE_ROOT, "aginti-home");
  process.env.AGINTIFLOW_HOUSEKEEPING = "1";

  try {
    const start = fixedConfig({ name: "start", sessionId: "aginti:persist-start" });
    const saved = await scopedSave(start, 1);
    assert.equal(saved.meta.integrationPolicyLock, start.integrationPolicyLock);
    assert.equal(saved.meta.integrationPolicyFingerprint, start.integrationPolicyFingerprint);
    assert.equal(saved.meta.integrationRuntimeRootsDigest, start.integrationRuntimeRootsDigest);
    assert.equal(saved.meta.runtimeConfig.revision, 1);
    assert.equal(contractDigest(saved.meta.runtimeConfig), contractDigest(expectedFixedSessionRuntimeSnapshot(start, 1)));
    assert.equal(Object.isFrozen(saved), false);
    assert.equal(await exists(path.join(start.baseDir, ".aginti-sessions", start.sessionId, "session.json")), false);
    assert.equal(await exists(path.join(process.env.AGINTIFLOW_HOME, "sessions", "index.json")), false);
    assert.equal(await exists(path.join(process.env.AGINTIFLOW_HOME, "housekeeping", "events.jsonl")), false);

    const resume = fixedConfig({
      name: "start",
      sessionId: "aginti:persist-start",
      mode: "resume",
      expectedRuntimeRevision: 1,
      inputText: "resume",
    });
    const resumed = await scopedSave(resume, 2);
    assert.equal(resumed.meta.runtimeConfig.revision, 2);
    assert.equal(contractDigest(resumed.meta.runtimeConfig), contractDigest(expectedFixedSessionRuntimeSnapshot(resume, 2)));

    assert.throws(() => runWithIntegrationSessionScope({ ...start }, async () => {}), /registered|frozen|scope/iu);
    await expectRejects(() => runAgent(start), /registered|scope|escaped|active/iu);
    const secondConfig = fixedConfig({ name: "second-real", sessionId: "aginti:second-store-real" });
    await expectRejects(
      () =>
        runWithIntegrationSessionScope(secondConfig, async () => {
          storeFor(secondConfig);
          storeFor(secondConfig);
        }),
      /more than one SessionStore/iu
    );

    const preconstructedConfig = fixedConfig({ name: "preconstructed", sessionId: "aginti:preconstructed" });
    const preconstructedStore = storeFor(preconstructedConfig);
    await expectRejects(
      () =>
        runWithIntegrationSessionScope(preconstructedConfig, async () => {
          await preconstructedStore.saveState(stateFor(preconstructedConfig, 1));
        }),
      /unclaimed|integration scope|SessionStore/iu
    );
    assert.equal(await exists(preconstructedStore.statePath), false);

    const sameSession = fixedConfig({ name: "same-session", sessionId: "aginti:same-session" });
    let releaseSameSession;
    const holdSameSession = new Promise((resolve) => {
      releaseSameSession = resolve;
    });
    const firstSameSession = runWithIntegrationSessionScope(sameSession, async () => {
      const store = storeFor(sameSession);
      await store.ensure();
      await store.saveState(stateFor(sameSession, 1));
      await holdSameSession;
      return true;
    });
    await delay(0);
    await expectRejects(
      () => runWithIntegrationSessionScope(sameSession, async () => scopedSave(sameSession, 1)),
      /active|already/iu
    );
    releaseSameSession();
    assert.equal(await firstSameSession, true);

    const mutationConfig = fixedConfig({ name: "mutation", sessionId: "aginti:mutation-before-await" });
    const mutationSaved = await runWithIntegrationSessionScope(mutationConfig, async () => {
      const store = storeFor(mutationConfig);
      await store.ensure();
      const mutableState = JSON.parse(JSON.stringify(stateFor(mutationConfig, 1)));
      const savePromise = store.saveState(mutableState);
      mutableState.meta.runtimeConfig.provider = "deepseek";
      mutableState.meta.integrationPolicyFingerprint = ZERO_DIGEST;
      await savePromise;
      return JSON.parse(await fs.readFile(store.statePath, "utf8"));
    });
    assert.equal(mutationSaved.meta.runtimeConfig.provider, "localllm");
    assert.equal(mutationSaved.meta.integrationPolicyFingerprint, mutationConfig.integrationPolicyFingerprint);

    const detachedConfig = fixedConfig({ name: "detached", sessionId: "aginti:detached" });
    const detachedStatePath = await runWithIntegrationSessionScope(detachedConfig, async () => {
      const store = storeFor(detachedConfig);
      store.saveState(stateFor(detachedConfig, 1));
      return store.statePath;
    });
    assert.equal(JSON.parse(await fs.readFile(detachedStatePath, "utf8")).meta.runtimeConfig.revision, 1);

    const detachedFailureConfig = fixedConfig({ name: "detached-failure", sessionId: "aginti:detached-failure" });
    await expectRejects(
      () =>
        runWithIntegrationSessionScope(detachedFailureConfig, async () => {
          const store = storeFor(detachedFailureConfig);
          await fs.mkdir(store.sessionDir, { recursive: true });
          await fs.mkdir(store.statePath, { recursive: true });
          store.saveState(stateFor(detachedFailureConfig, 1));
          return true;
        }),
      /EISDIR|directory|persist|scope/iu
    );

    const failedWriteConfig = fixedConfig({ name: "failed-write", sessionId: "aginti:failed-write" });
    await expectRejects(
      () =>
        runWithIntegrationSessionScope(failedWriteConfig, async () => {
          const store = storeFor(failedWriteConfig);
          await fs.mkdir(store.sessionDir, { recursive: true });
          await fs.mkdir(store.statePath, { recursive: true });
          await store.saveState(stateFor(failedWriteConfig, 1));
        }),
      /EISDIR|directory|persist|scope/iu
    );
    await fs.rm(path.join(failedWriteConfig.sessionsDir, failedWriteConfig.sessionId, "state.json"), {
      recursive: true,
      force: true,
    });
    assert.equal((await scopedSave(failedWriteConfig, 1)).meta.runtimeConfig.revision, 1);

    const escapedConfig = fixedConfig({ name: "escaped-child", sessionId: "aginti:escaped-child" });
    let releaseEscaped;
    const escapedGate = new Promise((resolve) => {
      releaseEscaped = resolve;
    });
    let escapedOutcome;
    await runWithIntegrationSessionScope(escapedConfig, async () => {
      setImmediate(() => {
        escapedGate.then(() => {
          try {
            storeFor(escapedConfig);
            escapedOutcome = "allowed";
          } catch (error) {
            escapedOutcome = error;
          }
        });
      });
      const store = storeFor(escapedConfig);
      await store.saveState(stateFor(escapedConfig, 1));
    });
    releaseEscaped();
    await delay(10);
    assert.match(`${escapedOutcome?.code || ""} ${escapedOutcome?.message || escapedOutcome}`, /escaped|active|scope/iu);

    const latePreconstructedConfig = fixedConfig({ name: "late-preconstructed", sessionId: "aginti:late-preconstructed" });
    const latePreconstructedStore = storeFor(latePreconstructedConfig);
    let releaseLatePreconstructed;
    const latePreconstructedGate = new Promise((resolve) => {
      releaseLatePreconstructed = resolve;
    });
    let resolveLatePreconstructedOutcome;
    const latePreconstructedOutcome = new Promise((resolve) => {
      resolveLatePreconstructedOutcome = resolve;
    });
    await runWithIntegrationSessionScope(latePreconstructedConfig, async () => {
      const scoped = storeFor(latePreconstructedConfig);
      await scoped.saveState(stateFor(latePreconstructedConfig, 1));
      setImmediate(() => {
        latePreconstructedGate.then(() => {
          latePreconstructedStore
            .appendEvent("late-preconstructed", {})
            .then(
              () => resolveLatePreconstructedOutcome("allowed"),
              (error) => resolveLatePreconstructedOutcome(error)
            );
        });
      });
    });
    releaseLatePreconstructed();
    const latePreconstructedError = await latePreconstructedOutcome;
    assert.match(
      `${latePreconstructedError?.code || ""} ${latePreconstructedError?.message || latePreconstructedError}`,
      /unclaimed|closed|integration scope|SessionStore/iu
    );
    assert.equal((await readOptional(latePreconstructedStore.eventsPath)).includes("late-preconstructed"), false);

    const retainedConfig = fixedConfig({ name: "retained", sessionId: "aginti:retained" });
    let retainedStore;
    await runWithIntegrationSessionScope(retainedConfig, async () => {
      retainedStore = storeFor(retainedConfig);
      assert.equal(Object.prototype.hasOwnProperty.call(retainedStore, "integrationSessionClaim"), false);
      assert.equal("integrationSessionClaim" in retainedStore, false);
      await retainedStore.saveState(stateFor(retainedConfig, 1));
      await retainedStore.appendEvent("retained.before", {});
      await retainedStore.savePlan("before");
      await retainedStore.saveJsonArtifact("before.json", { ok: true });
      await retainedStore.appendInbox("before", { id: "retained-before" });
      const drained = await retainedStore.drainInbox();
      assert.equal(drained.length, 1);
      assert.equal(retainedStore.markInboxApplied(drained[0]), true);
      await retainedStore.saveState(stateFor(retainedConfig, 1));
      await retainedStore.saveSnapshot(1, { before: true });
    });
    const retainedFiles = [
      retainedStore.statePath,
      retainedStore.eventsPath,
      retainedStore.planPath,
      retainedStore.inboxPath,
      retainedStore.inboxClaimsPath,
      retainedStore.inboxAcknowledgementsPath,
      path.join(retainedStore.artifactsDir, "before.json"),
      path.join(retainedStore.artifactsDir, "step-001.snapshot.json"),
    ];
    const retainedBefore = new Map(await Promise.all(retainedFiles.map(async (filePath) => [filePath, await readOptional(filePath)])));
    await expectRejects(() => retainedStore.appendEvent("retained.after", {}), /closed|admission|scope/iu);
    await expectRejects(() => retainedStore.savePlan("after"), /closed|admission|scope/iu);
    await expectRejects(() => retainedStore.saveJsonArtifact("after.json", { ok: false }), /closed|admission|scope/iu);
    await expectRejects(() => retainedStore.appendInbox("after", { id: "retained-after" }), /closed|admission|scope/iu);
    await expectRejects(() => retainedStore.acquireInboxLock(), /closed|admission|scope/iu);
    await expectRejects(() => retainedStore.compactInboxUnlocked(), /closed|admission|scope/iu);
    await expectRejects(() => retainedStore.saveSnapshot(2, { after: true }), /closed|admission|scope/iu);
    await expectRejects(() => retainedStore.remove(), /closed|admission|scope/iu);
    retainedStore.appendEvent("retained.dropped", {});
    await delay(0);
    assert.equal(unhandled.length, 0);
    assert.throws(() => retainedStore.markInboxApplied("retained-before"), /closed|admission|scope/iu);
    for (const [filePath, before] of retainedBefore) assert.equal(await readOptional(filePath), before);
    assert.equal(await exists(retainedStore.statePath), true);

    const parallelA = fixedConfig({ name: "parallel-a", sessionId: "aginti:parallel-a" });
    const parallelB = fixedConfig({ name: "parallel-b", sessionId: "aginti:parallel-b" });
    const [savedA, savedB] = await Promise.all([scopedSave(parallelA, 1), scopedSave(parallelB, 1)]);
    assert.equal(savedA.sessionId, "aginti:parallel-a");
    assert.equal(savedB.sessionId, "aginti:parallel-b");

    const tamperedBase = fixedConfig({ name: "tamper", sessionId: "aginti:tamper" });
    const tamperedResume = fixedConfig({
      name: "tamper",
      sessionId: "aginti:tamper",
      mode: "resume",
      expectedRuntimeRevision: 1,
    });
    await writeState(tamperedBase, {
      ...stateFor(tamperedBase, 1),
      meta: {
        ...stateFor(tamperedBase, 1).meta,
        runtimeConfig: {
          ...expectedFixedSessionRuntimeSnapshot(tamperedBase, 1),
          provider: "deepseek",
        },
      },
    });
    await expectRejects(
      () => runWithIntegrationSessionScope(tamperedResume, async () => storeFor(tamperedResume).loadState()),
      /TAKEOVER|diverged/iu
    );
    await writeState(tamperedBase, {
      ...stateFor(tamperedBase, 1),
      sessionId: "aginti:other-session",
    });
    await expectRejects(
      () => runWithIntegrationSessionScope(tamperedResume, async () => storeFor(tamperedResume).loadState()),
      /TAKEOVER|sessionId/iu
    );
    await expectRejects(
      () =>
        runWithIntegrationSessionScope(tamperedBase, async () => {
          const store = storeFor(tamperedBase);
          const bad = { ...stateFor(tamperedBase, 1), baseDir: "." };
          await store.saveState(bad);
        }),
      /TAKEOVER|baseDir/iu
    );
    await expectRejects(
      () =>
        runWithIntegrationSessionScope(tamperedBase, async () => {
          const store = storeFor(tamperedBase);
          const bad = { ...stateFor(tamperedBase, 1), commandCwd: "." };
          await store.saveState(bad);
        }),
      /TAKEOVER|commandCwd/iu
    );
    await writeState(tamperedBase, {
      ...stateFor(tamperedBase, 1),
      baseDir: ".",
    });
    await expectRejects(
      () => runWithIntegrationSessionScope(tamperedResume, async () => storeFor(tamperedResume).loadState()),
      /TAKEOVER|baseDir/iu
    );
    await writeState(tamperedBase, {
      ...stateFor(tamperedBase, 1),
      commandCwd: ".",
    });
    await expectRejects(
      () => runWithIntegrationSessionScope(tamperedResume, async () => storeFor(tamperedResume).loadState()),
      /TAKEOVER|commandCwd/iu
    );
    await writeState(tamperedBase, {
      ...stateFor(tamperedBase, 1),
      meta: {
        ...stateFor(tamperedBase, 1).meta,
        runtimeConfig: {
          ...expectedFixedSessionRuntimeSnapshot(tamperedBase, 1),
          extraKey: true,
        },
      },
    });
    await expectRejects(
      () => runWithIntegrationSessionScope(tamperedResume, async () => storeFor(tamperedResume).loadState()),
      /TAKEOVER|diverged/iu
    );
    await writeState(tamperedBase, {
      ...stateFor(tamperedBase, 1),
      meta: {
        ...stateFor(tamperedBase, 1).meta,
        integrationRuntimeRootsDigest: ZERO_DIGEST,
      },
    });
    await expectRejects(
      () => runWithIntegrationSessionScope(tamperedResume, async () => storeFor(tamperedResume).loadState()),
      /TAKEOVER|diverged/iu
    );

    const pristineConflict = fixedConfig({ name: "pristine", sessionId: "aginti:pristine" });
    await writeState(pristineConflict, stateFor(pristineConflict, 1));
    await expectRejects(
      () => runWithIntegrationSessionScope(pristineConflict, async () => storeFor(pristineConflict).loadState()),
      /pristine|TAKEOVER/iu
    );

    const copyBase = fixedConfig({ name: "copy", sessionId: "aginti:copy" });
    await scopedSave(copyBase, 1);
    const copyResume = fixedConfig({
      name: "copy",
      sessionId: "aginti:copy",
      mode: "resume",
      expectedRuntimeRevision: 1,
    });
    const copiedConfig = { ...copyResume };
    await expectRejects(() => executeNativeAgintiRun(copiedConfig), /registered|scope|TAKEOVER/iu);
    await expectRejects(
      () => executeNativeAgintiRun({ integrationPolicyLock: copyResume.integrationPolicyLock }),
      /registered|frozen|scope/iu
    );

    const normalRoot = path.join(SMOKE_ROOT, "normal-mock");
    const normal = await runAgent({
      provider: "mock",
      model: "mock-agent",
      goal: "hello",
      sessionId: "normal-mock-session",
      sessionsDir: path.join(normalRoot, "sessions"),
      baseDir: normalRoot,
      commandCwd: normalRoot,
      allowShellTool: false,
      allowFileTools: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      allowHostedImagePerception: false,
      allowHostedWebResearch: false,
      allowHostedJsonSpecialist: false,
      allowHostedWritingSpecialist: false,
      allowAgentLinkTools: false,
      allowCoordinationTools: false,
      allowBrowserTools: false,
      allowCanvasTools: false,
      useDockerSandbox: false,
      allowedDomains: [],
      readOnlyRoots: [],
      readOnlyHostMounts: [],
      packageInstallPolicy: "block",
      sandboxMode: "host",
      maxSteps: 1,
      onConsole() {},
    });
    assert.equal(normal.sessionId, "normal-mock-session");
    await flushHousekeeping();
    assert.equal(await exists(path.join(process.env.AGINTIFLOW_HOME, "housekeeping", "events.jsonl")), true);
    assert.equal(unhandled.length, 0);

    process.stdout.write("integration session persistence smoke: ok\n");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME;
    else process.env.AGINTIFLOW_HOME = previousHome;
    if (previousHousekeeping === undefined) delete process.env.AGINTIFLOW_HOUSEKEEPING;
    else process.env.AGINTIFLOW_HOUSEKEEPING = previousHousekeeping;
    await fs.rm(SMOKE_ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`integration session persistence smoke: failed (${String(error?.code || error?.name || "ERROR")})\n`);
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
