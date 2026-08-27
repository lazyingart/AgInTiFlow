#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../src/integration-analysis-planner.js";
import { createTestOnlyIntegrationAnalysisSessionService } from "../src/integration-analysis-session-service.js";
import {
  INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT,
  INTEGRATION_ANALYSIS_STATE_MIGRATION_STALE_LOCK_MS,
  migrateTestOnlyIntegrationAnalysisStateRoot,
} from "../src/integration-analysis-state-migrator.js";
import {
  INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
  INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
} from "../src/integration-analysis-state-persistence.js";
import {
  main as migrationCliMain,
  parseIntegrationAnalysisStateMigrationCliArguments,
  safeIntegrationAnalysisStateMigrationCliError,
} from "../src/integration-analysis-state-migration-cli.js";
import { canonicalJson, contractDigest } from "../src/integration-policy.js";

const SENSITIVE_MARKER = "STATE_CONTENT_MUST_NEVER_APPEAR_IN_MIGRATION_OUTPUT_91f27a";
const MIGRATION_TEMPORARY_FILE_NAME = ".state.json.aginti-v2-v3-migration.tmp";
const OWNER_LOCK_NAME = ".analysis-session-owner.lock";
const CRASH_CHILD_READY = "migration-lock-held-after-first-commit";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCondition(task, label, timeoutMs = 2_000) {
  const started = Date.now();
  for (;;) {
    if (await task()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}.`);
    await delay(5);
  }
}

function waitForChildOutput(child, expected, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const finish = (task) => {
      cleanup();
      task();
    };
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) finish(resolve);
    };
    const onErrorData = (chunk) => {
      errorOutput += chunk.toString("utf8");
    };
    const onExit = (code, signal) => finish(() => reject(
      new Error(`Crash-test child exited before readiness (${code ?? signal}): ${errorOutput}`)
    ));
    const onError = (error) => finish(() => reject(error));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out waiting for crash-test child: ${errorOutput}`))),
      timeoutMs
    );
    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function context(index) {
  return Object.freeze({
    principalId: `principal-migrator-${String(index).padStart(4, "0")}`,
    browserSessionId: index.toString(16).padStart(64, "0"),
  });
}

function directResult(text) {
  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
    text,
    kind: "direct",
    toolCalls: 0,
    executionStatus: null,
    artifacts: Object.freeze([]),
  });
}

function runner() {
  return Object.freeze({
    async run(scope, input, options) {
      const result = directResult(`completed ${scope.runId.slice(-8)} ${input.prompt.length}`);
      await options.onFinal(result);
      return result;
    },
  });
}

async function createNativeFixture(root, scopeCount = 3) {
  let service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner(),
    stateRoot: root,
  });
  try {
    for (let index = 1; index <= scopeCount; index += 1) {
      const scope = context(index);
      const created = await service.createThread(
        { title: `${SENSITIVE_MARKER} ${index}` },
        scope
      );
      const first = await service.startRun(
        { threadId: created.thread.id, input: { text: `first ${SENSITIVE_MARKER} ${index}` } },
        scope
      );
      await service.waitForIdle();
      assert.equal((await service.getRunStatus({ runId: first.run.id }, scope)).run.status, "completed");
      const second = await service.startRun(
        { threadId: created.thread.id, input: { text: `second ${SENSITIVE_MARKER} ${index}` } },
        scope
      );
      await service.waitForIdle();
      assert.equal((await service.getRunStatus({ runId: second.run.id }, scope)).run.status, "completed");
    }
  } finally {
    await service.close({ mode: "wait" });
  }
  return stateFiles(root);
}

async function stateFiles(root) {
  const scopesDirectory = path.join(root, "scopes");
  const names = (await fs.readdir(scopesDirectory)).sort();
  return names.map((name) => path.join(scopesDirectory, name, "state.json"));
}

function v2EnvelopeFromV3(envelope) {
  const state = {
    schemaVersion: INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
    scope: envelope.state.scope,
    revision: envelope.state.revision,
    threads: envelope.state.threads,
    runs: envelope.state.runs.map(({ lineagePreviousRunId: _lineagePreviousRunId, search: _search, ...run }) => run),
    artifacts: envelope.state.artifacts,
    mutationReceipts: envelope.state.mutationReceipts,
  };
  const unsigned = { schemaVersion: INTEGRATION_ANALYSIS_STATE_STORAGE_V2, state };
  return { ...unsigned, digest: contractDigest(unsigned) };
}

async function convertFileToV2(file) {
  const nativeBytes = await fs.readFile(file, "utf8");
  const envelope = v2EnvelopeFromV3(JSON.parse(nativeBytes));
  await fs.writeFile(file, `${canonicalJson(envelope)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return nativeBytes;
}

async function convertAllToV2(root) {
  const nativeByScope = new Map();
  for (const file of await stateFiles(root)) {
    nativeByScope.set(path.basename(path.dirname(file)), await convertFileToV2(file));
  }
  return nativeByScope;
}

async function cloneRoot(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(target), 0o700);
  await fs.cp(source, target, { recursive: true, preserveTimestamps: true });
  await fs.chmod(target, 0o700);
  await fs.chmod(path.join(target, "scopes"), 0o700);
  for (const file of await stateFiles(target)) {
    await fs.chmod(path.dirname(file), 0o700);
    await fs.chmod(file, 0o600);
  }
}

async function snapshotBytes(root) {
  const snapshot = new Map();
  for (const file of await stateFiles(root)) {
    snapshot.set(path.basename(path.dirname(file)), await fs.readFile(file, "utf8"));
  }
  return snapshot;
}

async function assertSnapshot(root, expected) {
  assert.deepEqual(await snapshotBytes(root), expected);
}

function reseal(envelope) {
  const unsigned = { schemaVersion: envelope.schemaVersion, state: envelope.state };
  return { ...unsigned, digest: contractDigest(unsigned) };
}

async function rewriteEnvelope(file, transform, { canonical = true } = {}) {
  const envelope = JSON.parse(await fs.readFile(file, "utf8"));
  const transformed = transform(envelope);
  const bytes = canonical
    ? `${canonicalJson(transformed)}\n`
    : `${JSON.stringify(transformed, null, 2)}\n`;
  await fs.writeFile(file, bytes, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function expectRejected(promise, codes) {
  await assert.rejects(
    promise,
    (error) => new Set(codes).has(error?.code),
    `expected one of ${codes.join(", ")}`
  );
}

function assertContentBlind(result, expectedCounts) {
  assert.deepEqual(Object.keys(result).sort(), [
    "completed",
    "contractDigest",
    "convertedScopeCount",
    "direction",
    "inputAggregateDigest",
    "networkAccess",
    "outputAggregateDigest",
    "schemaVersion",
    "scopeCount",
    "unchangedScopeCount",
  ].sort());
  assert.equal(result.completed, true);
  assert.equal(result.direction, "forward-only");
  assert.equal(result.networkAccess, "denied");
  assert.equal(result.scopeCount, expectedCounts.scopeCount);
  assert.equal(result.convertedScopeCount, expectedCounts.convertedScopeCount);
  assert.equal(result.unchangedScopeCount, expectedCounts.unchangedScopeCount);
  assert.match(result.inputAggregateDigest, /^[a-f0-9]{64}$/u);
  assert.match(result.outputAggregateDigest, /^[a-f0-9]{64}$/u);
  assert.equal(result.contractDigest, contractDigest(INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SENSITIVE_MARKER, "u"));
  assert.doesNotMatch(JSON.stringify(result), /principal-migrator|browserSessionId|threadId|runId/u);
}

async function allScopeMixedAndIdempotent(root) {
  const files = await createNativeFixture(root, 3);
  const nativeBytes = new Map();
  nativeBytes.set(path.basename(path.dirname(files[0])), await convertFileToV2(files[0]));
  nativeBytes.set(path.basename(path.dirname(files[1])), await fs.readFile(files[1], "utf8"));
  nativeBytes.set(path.basename(path.dirname(files[2])), await convertFileToV2(files[2]));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network access is denied during the migration smoke");
  };
  let result;
  try {
    result = await migrateTestOnlyIntegrationAnalysisStateRoot(root);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertContentBlind(result, { scopeCount: 3, convertedScopeCount: 2, unchangedScopeCount: 1 });
  for (const file of files) {
    const bytes = await fs.readFile(file, "utf8");
    const envelope = JSON.parse(bytes);
    assert.equal(envelope.schemaVersion, INTEGRATION_ANALYSIS_STATE_STORAGE_V3);
    assert.equal(envelope.state.schemaVersion, INTEGRATION_ANALYSIS_STATE_STORAGE_V3);
    assert.deepEqual(envelope.state.documentCommitIntents, []);
    assert.deepEqual(envelope.state.documentDeletionIntents, []);
    assert.equal(envelope.state.runs.length, 2);
    assert.equal(envelope.state.runs[0].lineagePreviousRunId, null);
    assert.equal(envelope.state.runs[1].lineagePreviousRunId, envelope.state.runs[0].id);
    assert.equal(envelope.digest, contractDigest({ schemaVersion: envelope.schemaVersion, state: envelope.state }));
    assert.equal(bytes, nativeBytes.get(path.basename(path.dirname(file))));
  }

  const before = await Promise.all(files.map(async (file) => ({
    file,
    bytes: await fs.readFile(file, "utf8"),
    stat: await fs.stat(file),
  })));
  const second = await migrateTestOnlyIntegrationAnalysisStateRoot(root);
  assertContentBlind(second, { scopeCount: 3, convertedScopeCount: 0, unchangedScopeCount: 3 });
  for (const item of before) {
    const after = await fs.stat(item.file);
    assert.equal(await fs.readFile(item.file, "utf8"), item.bytes);
    assert.equal(after.ino, item.stat.ino, "idempotent migration replaced a valid v3 file");
    assert.equal(after.mtimeMs, item.stat.mtimeMs, "idempotent migration changed a valid v3 mtime");
  }
}

async function interruptionAndResume(root) {
  await createNativeFixture(root, 3);
  await convertAllToV2(root);
  let interrupted = false;
  await assert.rejects(
    migrateTestOnlyIntegrationAnalysisStateRoot(root, {
      afterScopeCommitted({ committedCount }) {
        if (committedCount === 1) {
          interrupted = true;
          throw new Error("simulated process interruption");
        }
      },
    }),
    (error) =>
      error?.code === "ANALYSIS_STATE_MIGRATION_UNAVAILABLE" &&
      error?.cause?.message === "simulated process interruption"
  );
  assert.equal(interrupted, true);
  const versions = [];
  for (const file of await stateFiles(root)) {
    versions.push(JSON.parse(await fs.readFile(file, "utf8")).schemaVersion);
    await assert.rejects(fs.lstat(path.join(path.dirname(file), MIGRATION_TEMPORARY_FILE_NAME)), { code: "ENOENT" });
  }
  assert.deepEqual(versions.sort(), [
    INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
    INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
    INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
  ].sort());
  const resumed = await migrateTestOnlyIntegrationAnalysisStateRoot(root);
  assertContentBlind(resumed, { scopeCount: 3, convertedScopeCount: 2, unchangedScopeCount: 1 });
}

async function crashLockHolderChild(root) {
  await migrateTestOnlyIntegrationAnalysisStateRoot(root, {
    staleLockMs: 10,
    async afterScopeCommitted({ committedCount }) {
      if (committedCount !== 1) return;
      process.stdout.write(`${CRASH_CHILD_READY}\n`);
      await new Promise(() => {
        setInterval(() => {}, 1_000);
      });
    },
  });
}

async function sigkillCrashAndBoundedResume(root) {
  await createNativeFixture(root, 3);
  await convertAllToV2(root);
  const child = spawn(process.execPath, [SCRIPT_PATH, "--crash-lock-holder", root], {
    cwd: path.dirname(SCRIPT_PATH),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false;
  try {
    await waitForChildOutput(child, CRASH_CHILD_READY);
    ready = true;
  } finally {
    if (!ready) child.kill("SIGKILL");
  }
  assert.equal(child.kill("SIGKILL"), true);
  const [exitCode, signal] = await once(child, "exit");
  assert.equal(exitCode, null);
  assert.equal(signal, "SIGKILL");

  const ownerLock = path.join(root, OWNER_LOCK_NAME);
  const owner = JSON.parse(await fs.readFile(path.join(ownerLock, "owner.json"), "utf8"));
  assert.equal(owner.pid, child.pid);
  assert.equal(owner.schemaVersion, "aginti-directory-lock-v1");
  assert.match(owner.token, /^[a-f0-9]{32}$/u);
  assert.equal(owner.processIdentity.schemaVersion, "aginti-process-identity-v1");

  const versions = [];
  for (const file of await stateFiles(root)) {
    versions.push(JSON.parse(await fs.readFile(file, "utf8")).schemaVersion);
  }
  assert.deepEqual(versions.sort(), [
    INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
    INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
    INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
  ].sort());

  await expectRejected(
    migrateTestOnlyIntegrationAnalysisStateRoot(root, { staleLockMs: 60_000 }),
    ["ANALYSIS_STATE_MIGRATION_BUSY"]
  );
  await delay(25);
  const resumed = await migrateTestOnlyIntegrationAnalysisStateRoot(root, { staleLockMs: 10 });
  assertContentBlind(resumed, { scopeCount: 3, convertedScopeCount: 2, unchangedScopeCount: 1 });
  await assert.rejects(fs.lstat(ownerLock), { code: "ENOENT" });
}

async function staleTemporaryRecovery(root) {
  await createNativeFixture(root, 1);
  await convertAllToV2(root);
  const file = (await stateFiles(root))[0];
  const temporary = path.join(path.dirname(file), MIGRATION_TEMPORARY_FILE_NAME);
  await fs.writeFile(temporary, "partial", { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  const result = await migrateTestOnlyIntegrationAnalysisStateRoot(root);
  assertContentBlind(result, { scopeCount: 1, convertedScopeCount: 1, unchangedScopeCount: 0 });
  await assert.rejects(fs.lstat(temporary), { code: "ENOENT" });
}

async function ownershipExclusion(root) {
  const service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner(),
    stateRoot: root,
  });
  try {
    await service.createThread({ title: SENSITIVE_MARKER }, context(9));
    await delay(10);
    await expectRejected(
      migrateTestOnlyIntegrationAnalysisStateRoot(root, { staleLockMs: 1 }),
      ["ANALYSIS_STATE_MIGRATION_BUSY"]
    );
  } finally {
    await service.close({ mode: "wait" });
  }
}

async function invalidDeadOwnerIsNeverReclaimed(root) {
  await createNativeFixture(root, 1);
  await convertAllToV2(root);
  const before = await snapshotBytes(root);
  const ownerLock = path.join(root, OWNER_LOCK_NAME);
  await fs.mkdir(ownerLock, { mode: 0o700 });
  await fs.writeFile(path.join(ownerLock, "owner.json"), `${JSON.stringify({
    schemaVersion: "invalid-lock-owner",
    pid: 999_999_999,
    token: "a".repeat(32),
    processIdentity: {
      schemaVersion: "aginti-process-identity-v1",
      bootId: "b".repeat(32),
      startTimeTicks: "1",
    },
    acquiredAt: "2000-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  await fs.chmod(path.join(ownerLock, "owner.json"), 0o600);
  await expectRejected(
    migrateTestOnlyIntegrationAnalysisStateRoot(root, { staleLockMs: 1 }),
    ["ANALYSIS_STATE_MIGRATION_BUSY"]
  );
  await assertSnapshot(root, before);
  assert.equal((await fs.lstat(ownerLock)).isDirectory(), true);
}

async function deterministicBytes(sourceRoot, firstRoot, secondRoot) {
  await createNativeFixture(sourceRoot, 2);
  const expected = await convertAllToV2(sourceRoot);
  await cloneRoot(sourceRoot, firstRoot);
  await cloneRoot(sourceRoot, secondRoot);
  const firstResult = await migrateTestOnlyIntegrationAnalysisStateRoot(firstRoot);
  const originalLocaleCompare = String.prototype.localeCompare;
  let secondResult;
  try {
    String.prototype.localeCompare = function reversedLocaleCompare(value) {
      return originalLocaleCompare.call(String(value), String(this));
    };
    secondResult = await migrateTestOnlyIntegrationAnalysisStateRoot(secondRoot);
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
  assert.deepEqual(await snapshotBytes(firstRoot), await snapshotBytes(secondRoot));
  assert.deepEqual(await snapshotBytes(firstRoot), expected);
  assert.equal(firstResult.inputAggregateDigest, secondResult.inputAggregateDigest);
  assert.equal(firstResult.outputAggregateDigest, secondResult.outputAggregateDigest);
}

function holdingRunner() {
  return Object.freeze({
    async run(_scope, _input, options) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(
          new Error("held run aborted"),
          { code: "ANALYSIS_CANCELLED", publicCode: "ANALYSIS_CANCELLED" }
        )), { once: true });
      });
    },
  });
}

async function nonterminalRunRefusesWholePreflight(root) {
  await createNativeFixture(root, 3);
  await convertAllToV2(root);
  const files = await stateFiles(root);
  const file = files.at(-1);
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  const scope = Object.freeze({
    principalId: persisted.state.scope.principalId,
    browserSessionId: persisted.state.scope.browserSessionId,
  });
  const threadId = persisted.state.threads[0].id;
  const service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: holdingRunner(),
    stateRoot: root,
  });
  let runningBytes;
  try {
    const started = await service.startRun(
      { threadId, input: { text: `hold ${SENSITIVE_MARKER}` } },
      scope
    );
    await waitForCondition(async () =>
      (await service.getRunStatus({ runId: started.run.id }, scope)).run.status === "running",
    "persisted running analysis state");
    runningBytes = await fs.readFile(file, "utf8");
  } finally {
    await service.close({ mode: "abort" });
  }
  const runningV2 = v2EnvelopeFromV3(JSON.parse(runningBytes));
  await fs.writeFile(file, `${canonicalJson(runningV2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  const staleTemporary = path.join(path.dirname(files[0]), MIGRATION_TEMPORARY_FILE_NAME);
  const staleBytes = Buffer.from("stale temporary must survive rejected whole-root preflight", "utf8");
  await fs.writeFile(staleTemporary, staleBytes, { mode: 0o600 });
  await fs.chmod(staleTemporary, 0o600);
  const before = await snapshotBytes(root);
  await expectRejected(
    migrateTestOnlyIntegrationAnalysisStateRoot(root),
    ["ANALYSIS_STATE_MIGRATION_NONTERMINAL"]
  );
  await assertSnapshot(root, before);
  assert.deepEqual(await fs.readFile(staleTemporary), staleBytes);
  assert.equal((await fs.readdir(path.dirname(staleTemporary))).includes(MIGRATION_TEMPORARY_FILE_NAME), true);
}

async function corruptionCases(pristineRoot, casesRoot) {
  await createNativeFixture(pristineRoot, 3);
  await convertAllToV2(pristineRoot);
  let caseNumber = 0;
  async function fresh(label) {
    caseNumber += 1;
    const root = path.join(casesRoot, `${String(caseNumber).padStart(2, "0")}-${label}`);
    await cloneRoot(pristineRoot, root);
    return root;
  }

  {
    const root = await fresh("bad-digest");
    const files = await stateFiles(root);
    const before = await snapshotBytes(root);
    await rewriteEnvelope(files.at(-1), (envelope) => ({ ...envelope, digest: "0".repeat(64) }));
    const poisoned = await snapshotBytes(root);
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_CORRUPT"]);
    await assertSnapshot(root, poisoned);
    assert.equal((await snapshotBytes(root)).get(path.basename(path.dirname(files[0]))), before.get(path.basename(path.dirname(files[0]))));
  }

  {
    const root = await fresh("extra-schema");
    const file = (await stateFiles(root)).at(-1);
    await rewriteEnvelope(file, (envelope) => {
      envelope.state.unexpectedStateField = true;
      return reseal(envelope);
    });
    const poisoned = await snapshotBytes(root);
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_CORRUPT"]);
    await assertSnapshot(root, poisoned);
  }

  {
    const root = await fresh("partial-record");
    const file = (await stateFiles(root)).at(-1);
    await rewriteEnvelope(file, (envelope) => {
      delete envelope.state.mutationReceipts;
      return reseal(envelope);
    });
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_CORRUPT"]);
  }

  {
    const root = await fresh("partial-v3-lineage");
    const file = (await stateFiles(root)).at(-1);
    await rewriteEnvelope(file, (envelope) => {
      envelope = {
        schemaVersion: INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
        state: {
          ...envelope.state,
          schemaVersion: INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
          documentCommitIntents: [],
          documentDeletionIntents: [],
          runs: envelope.state.runs.map((run, index) => index === 0 ? run : { ...run, lineagePreviousRunId: null }),
        },
        digest: "",
      };
      return reseal(envelope);
    });
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_CORRUPT"]);
  }

  {
    const root = await fresh("noncanonical-bytes");
    const file = (await stateFiles(root)).at(-1);
    await rewriteEnvelope(file, (envelope) => envelope, { canonical: false });
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_CORRUPT"]);
  }

  {
    const root = await fresh("invalid-utf8");
    const file = (await stateFiles(root)).at(-1);
    const bytes = await fs.readFile(file);
    const marker = bytes.indexOf(Buffer.from(SENSITIVE_MARKER, "utf8"));
    assert.ok(marker >= 0);
    bytes[marker] = 0xff;
    await fs.writeFile(file, bytes, { mode: 0o600 });
    await fs.chmod(file, 0o600);
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_MIGRATION_CORRUPT"]);
  }

  {
    const root = await fresh("unsafe-file-mode");
    const file = (await stateFiles(root)).at(-1);
    await fs.chmod(file, 0o644);
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_MIGRATION_UNSAFE"]);
  }

  {
    const root = await fresh("hard-linked-state");
    const file = (await stateFiles(root)).at(-1);
    const outside = path.join(casesRoot, "hard-link-witness.json");
    await fs.link(file, outside);
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_MIGRATION_UNSAFE"]);
    await fs.unlink(outside);
  }

  {
    const root = await fresh("symlinked-state");
    const file = (await stateFiles(root)).at(-1);
    const outside = path.join(casesRoot, "symlink-state-witness.json");
    await fs.rename(file, outside);
    await fs.symlink(outside, file);
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_MIGRATION_UNSAFE"]);
  }

  {
    const root = await fresh("symlinked-scope");
    const file = (await stateFiles(root)).at(-1);
    const scope = path.dirname(file);
    const outside = path.join(casesRoot, "symlink-scope-witness");
    await fs.rename(scope, outside);
    await fs.symlink(outside, scope);
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_MIGRATION_UNSAFE"]);
  }

  {
    const root = await fresh("unsafe-root-mode");
    await fs.chmod(root, 0o755);
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_MIGRATION_UNSAFE"]);
  }

  {
    const root = await fresh("unsafe-scope-mode");
    const scope = path.dirname((await stateFiles(root)).at(-1));
    await fs.chmod(scope, 0o750);
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_MIGRATION_UNSAFE"]);
  }

  {
    const root = await fresh("unexpected-entry");
    const scope = path.dirname((await stateFiles(root)).at(-1));
    await fs.writeFile(path.join(scope, "unexpected.json"), "{}\n", { mode: 0o600 });
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_MIGRATION_UNSAFE"]);
  }

  {
    const root = await fresh("wrong-scope-binding");
    const file = (await stateFiles(root)).at(-1);
    const scope = path.dirname(file);
    const original = path.basename(scope);
    const replacement = `${original.slice(0, -1)}${original.endsWith("0") ? "1" : "0"}`;
    await fs.rename(scope, path.join(path.dirname(scope), replacement));
    await expectRejected(migrateTestOnlyIntegrationAnalysisStateRoot(root), ["ANALYSIS_STATE_MIGRATION_CORRUPT"]);
  }
}

async function cliContract() {
  assert.equal(
    INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT.scopeOrdering,
    "lowercase-hex-code-unit-ascending-v1"
  );
  assert.equal(INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT.requiresAllRunsTerminal, true);
  assert.equal(INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT.liveOwnerRecovery, false);
  assert.equal(
    INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT.deadOwnerRecoveryAfterMs,
    INTEGRATION_ANALYSIS_STATE_MIGRATION_STALE_LOCK_MS
  );
  assert.equal(INTEGRATION_ANALYSIS_STATE_MIGRATION_STALE_LOCK_MS, 60_000);
  assert.deepEqual(
    parseIntegrationAnalysisStateMigrationCliArguments([
      "migrate",
      "--offline",
      "--state-root",
      "/var/lib/agintiflow-integration/analysis",
    ]),
    {
      command: "migrate",
      offline: true,
      stateRoot: "/var/lib/agintiflow-integration/analysis",
    }
  );
  for (const argv of [
    [],
    ["migrate", "--state-root", "/var/lib/agintiflow-integration/analysis"],
    ["migrate", "--offline", "--state-root", "relative"],
    ["migrate", "--offline", "--state-root", "/safe", "--scope", "one"],
  ]) {
    assert.throws(
      () => parseIntegrationAnalysisStateMigrationCliArguments(argv),
      (error) => error?.code === "ANALYSIS_STATE_MIGRATION_CLI_INVALID"
    );
  }
  let output = "";
  const result = Object.freeze({
    schemaVersion: "test",
    completed: true,
    scopeCount: 0,
    convertedScopeCount: 0,
    unchangedScopeCount: 0,
    inputAggregateDigest: "0".repeat(64),
    outputAggregateDigest: "0".repeat(64),
  });
  await migrationCliMain(
    ["migrate", "--offline", "--state-root", "/var/lib/agintiflow-integration/analysis"],
    {
      migrate: async () => result,
      stdout: { write(value) { output += value; } },
    }
  );
  assert.equal(output, `${JSON.stringify(result)}\n`);
  const safe = safeIntegrationAnalysisStateMigrationCliError(
    Object.assign(new Error(SENSITIVE_MARKER), { code: "UNKNOWN_FAILURE" })
  );
  assert.doesNotMatch(safe, new RegExp(SENSITIVE_MARKER, "u"));
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-analysis-state-migrator-"));
  await fs.chmod(temporaryRoot, 0o700);
  try {
    await allScopeMixedAndIdempotent(path.join(temporaryRoot, "mixed"));
    await interruptionAndResume(path.join(temporaryRoot, "interruption"));
    await sigkillCrashAndBoundedResume(path.join(temporaryRoot, "sigkill-resume"));
    await staleTemporaryRecovery(path.join(temporaryRoot, "stale-temporary"));
    await ownershipExclusion(path.join(temporaryRoot, "ownership-exclusion"));
    await invalidDeadOwnerIsNeverReclaimed(path.join(temporaryRoot, "invalid-dead-owner"));
    await nonterminalRunRefusesWholePreflight(path.join(temporaryRoot, "nonterminal-refusal"));
    await deterministicBytes(
      path.join(temporaryRoot, "deterministic-source"),
      path.join(temporaryRoot, "deterministic-first"),
      path.join(temporaryRoot, "deterministic-second")
    );
    await corruptionCases(
      path.join(temporaryRoot, "corruption-pristine"),
      path.join(temporaryRoot, "corruption-cases")
    );
    await cliContract();
    console.log("integration analysis state migrator smoke passed");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--crash-lock-holder") {
  await crashLockHolderChild(process.argv[3]);
} else {
  await main();
}
