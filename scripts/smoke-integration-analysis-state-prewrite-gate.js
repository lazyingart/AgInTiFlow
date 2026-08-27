#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../src/integration-analysis-planner.js";
import {
  createTestOnlyIntegrationAnalysisSessionService,
} from "../src/integration-analysis-session-service.js";
import {
  INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT,
  INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_SCHEMA_VERSION,
  migrateIntegrationAnalysisStateRoot,
  migrateTestOnlyIntegrationAnalysisStateRoot,
} from "../src/integration-analysis-state-migrator.js";
import {
  INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_ACK_SCHEMA_VERSION,
  INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_MAX_TIMEOUT_MS,
  main as migrationCliMain,
  parseIntegrationAnalysisStateMigrationCliArguments,
  safeIntegrationAnalysisStateMigrationCliError,
} from "../src/integration-analysis-state-migration-cli.js";
import {
  INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
  INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
} from "../src/integration-analysis-state-persistence.js";
import { canonicalJson, contractDigest } from "../src/integration-policy.js";

const OWNER_LOCK_NAME = ".analysis-session-owner.lock";
const MIGRATION_TEMPORARY_FILE_NAME = ".state.json.aginti-v2-v3-migration.tmp";
const NONCE = "9b4ea29d597380f223433a48c4d90c39b48ddf439b6160704b92757f4f1643bf";
const SENSITIVE_MARKER = "PREWRITE_GATE_MUST_NOT_LEAK_3e9c80423f";
const CANONICAL_ROOT = "/var/lib/agintiflow-integration/analysis";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_BIN = path.join(REPOSITORY_ROOT, "bin", "aginti-integration-analysis-state.js");

async function withDeadline(promise, message, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message())), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function delay(timeoutMs) {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function context(index) {
  return Object.freeze({
    principalId: `principal-prewrite-${String(index).padStart(4, "0")}`,
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
  const service = createTestOnlyIntegrationAnalysisSessionService({
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
      await service.startRun(
        { threadId: created.thread.id, input: { text: `run ${SENSITIVE_MARKER} ${index}` } },
        scope
      );
      await service.waitForIdle();
    }
  } finally {
    await service.close({ mode: "wait" });
  }
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
    runs: envelope.state.runs.map(({
      lineagePreviousRunId: _lineagePreviousRunId,
      search: _search,
      ...run
    }) => run),
    artifacts: envelope.state.artifacts,
    mutationReceipts: envelope.state.mutationReceipts,
  };
  const unsigned = { schemaVersion: INTEGRATION_ANALYSIS_STATE_STORAGE_V2, state };
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

async function convertFileToV2(file) {
  const envelope = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, `${canonicalJson(v2EnvelopeFromV3(envelope))}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function convertSelectedToV2(root, indexes) {
  const files = await stateFiles(root);
  for (const index of indexes) await convertFileToV2(files[index]);
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
    await fs.chmod(path.join(path.dirname(file), MIGRATION_TEMPORARY_FILE_NAME), 0o600).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function durableSnapshot(root) {
  const snapshot = {};
  for (const file of await stateFiles(root)) {
    const name = path.basename(path.dirname(file));
    const stateStat = await fs.stat(file);
    const temporary = path.join(path.dirname(file), MIGRATION_TEMPORARY_FILE_NAME);
    let temporarySnapshot = null;
    try {
      const temporaryStat = await fs.stat(temporary);
      temporarySnapshot = {
        bytes: (await fs.readFile(temporary)).toString("base64"),
        ino: temporaryStat.ino,
        mode: temporaryStat.mode & 0o7777,
        mtimeMs: temporaryStat.mtimeMs,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    snapshot[name] = {
      state: {
        bytes: (await fs.readFile(file)).toString("base64"),
        ino: stateStat.ino,
        mode: stateStat.mode & 0o7777,
        mtimeMs: stateStat.mtimeMs,
      },
      temporary: temporarySnapshot,
    };
  }
  return snapshot;
}

async function durableContents(root) {
  const snapshot = await durableSnapshot(root);
  return Object.fromEntries(Object.entries(snapshot).map(([scope, value]) => [scope, {
    state: { bytes: value.state.bytes, mode: value.state.mode },
    temporary: value.temporary === null
      ? null
      : { bytes: value.temporary.bytes, mode: value.temporary.mode },
  }]));
}

async function stateVersions(root) {
  return Promise.all((await stateFiles(root)).map(async (file) =>
    JSON.parse(await fs.readFile(file, "utf8")).schemaVersion
  ));
}

function expectedCurrentStorageState(scopeCount, sourceV2ScopeCount, sourceV3ScopeCount) {
  if (scopeCount === 0) return "empty";
  if (sourceV2ScopeCount === scopeCount) return "all-v2";
  if (sourceV3ScopeCount === scopeCount) return "all-v3";
  return "mixed";
}

function assertGateMatrix(gate, expected = {}) {
  for (const field of [
    "scopeCount",
    "sourceV2ScopeCount",
    "sourceV3ScopeCount",
    "migrationTemporaryCount",
  ]) {
    assert.equal(Number.isSafeInteger(gate[field]) && gate[field] >= 0, true, `${field} is invalid`);
  }
  assert.equal(gate.sourceV2ScopeCount + gate.sourceV3ScopeCount, gate.scopeCount);
  assert.equal(gate.migrationTemporaryCount <= gate.scopeCount, true);
  assert.equal(
    gate.currentStorageState,
    expectedCurrentStorageState(
      gate.scopeCount,
      gate.sourceV2ScopeCount,
      gate.sourceV3ScopeCount
    )
  );
  for (const [field, value] of Object.entries(expected)) assert.equal(gate[field], value, field);
}

function withoutCurrentStateMetadata(gate) {
  const {
    currentStorageState: _currentStorageState,
    migrationTemporaryCount: _migrationTemporaryCount,
    sourceV2ScopeCount: _sourceV2ScopeCount,
    sourceV3ScopeCount: _sourceV3ScopeCount,
    ...stable
  } = gate;
  return stable;
}

function assertContentBlindGate(gate, root = "") {
  assert.deepEqual(Object.keys(gate), [
    "schemaVersion",
    "event",
    "direction",
    "targetStorageVersion",
    "scopeCount",
    "sourceV2ScopeCount",
    "sourceV3ScopeCount",
    "migrationTemporaryCount",
    "currentStorageState",
    "targetAggregateDigest",
    "migrationContractDigest",
  ]);
  assert.equal(gate.schemaVersion, INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_SCHEMA_VERSION);
  assert.equal(gate.event, "migration-prewrite-gate");
  assert.equal(gate.direction, "forward-only");
  assert.equal(gate.targetStorageVersion, INTEGRATION_ANALYSIS_STATE_STORAGE_V3);
  assertGateMatrix(gate);
  assert.match(gate.targetAggregateDigest, /^[a-f0-9]{64}$/u);
  assert.equal(gate.migrationContractDigest, contractDigest(INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT));
  const serialized = JSON.stringify(gate);
  assert.doesNotMatch(serialized, new RegExp(SENSITIVE_MARKER, "u"));
  assert.doesNotMatch(serialized, /principal-prewrite|browserSessionId|threadId|runId/u);
  if (root) assert.equal(serialized.includes(root), false);
}

async function lockHeldAndNoMutationBeforeApproval(root) {
  await createNativeFixture(root, 2);
  await convertSelectedToV2(root, [0, 1]);
  const firstFile = (await stateFiles(root))[0];
  const temporary = path.join(path.dirname(firstFile), MIGRATION_TEMPORARY_FILE_NAME);
  await fs.writeFile(temporary, "pre-existing crash temporary", { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  const before = await durableSnapshot(root);
  let gateCount = 0;
  const result = await migrateTestOnlyIntegrationAnalysisStateRoot(root, {
    async beforeMutation(gate) {
      gateCount += 1;
      assertContentBlindGate(gate, root);
      assertGateMatrix(gate, {
        scopeCount: 2,
        sourceV2ScopeCount: 2,
        sourceV3ScopeCount: 0,
        migrationTemporaryCount: 1,
        currentStorageState: "all-v2",
      });
      assert.equal((await fs.lstat(path.join(root, OWNER_LOCK_NAME))).isDirectory(), true);
      const owner = JSON.parse(
        await fs.readFile(path.join(root, OWNER_LOCK_NAME, "owner.json"), "utf8")
      );
      assert.equal(owner.schemaVersion, "aginti-directory-lock-v1");
      assert.equal(owner.pid, process.pid);
      assert.deepEqual(await durableSnapshot(root), before);
    },
  });
  assert.equal(gateCount, 1);
  assert.equal(result.convertedScopeCount, 2);
  assert.equal(result.outputAggregateDigest.length, 64);
  await assert.rejects(fs.lstat(temporary), { code: "ENOENT" });
}

async function gateOnlyAfterWholeRootPreflight(root) {
  await createNativeFixture(root, 2);
  await convertSelectedToV2(root, [0, 1]);
  const file = (await stateFiles(root)).at(-1);
  const envelope = JSON.parse(await fs.readFile(file, "utf8"));
  envelope.digest = "0".repeat(64);
  await fs.writeFile(file, `${canonicalJson(envelope)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  const before = await durableSnapshot(root);
  let gateCount = 0;
  await assert.rejects(
    migrateTestOnlyIntegrationAnalysisStateRoot(root, {
      beforeMutation() {
        gateCount += 1;
      },
    }),
    (error) => error?.code === "ANALYSIS_STATE_CORRUPT"
  );
  assert.equal(gateCount, 0);
  assert.deepEqual(await durableSnapshot(root), before);
}

async function targetDigestStableAcrossResumeStates(root) {
  const source = path.join(root, "source-v3");
  const allV2 = path.join(root, "all-v2");
  const mixed = path.join(root, "mixed");
  const allV3 = path.join(root, "all-v3");
  await createNativeFixture(source, 3);
  await cloneRoot(source, allV2);
  await cloneRoot(source, mixed);
  await cloneRoot(source, allV3);
  await convertSelectedToV2(allV2, [0, 1, 2]);
  await convertSelectedToV2(mixed, [0, 2]);
  const allV3Before = await durableSnapshot(allV3);

  const expectedMatrices = [
    {
      scopeCount: 3,
      sourceV2ScopeCount: 3,
      sourceV3ScopeCount: 0,
      migrationTemporaryCount: 0,
      currentStorageState: "all-v2",
    },
    {
      scopeCount: 3,
      sourceV2ScopeCount: 2,
      sourceV3ScopeCount: 1,
      migrationTemporaryCount: 0,
      currentStorageState: "mixed",
    },
    {
      scopeCount: 3,
      sourceV2ScopeCount: 0,
      sourceV3ScopeCount: 3,
      migrationTemporaryCount: 0,
      currentStorageState: "all-v3",
    },
  ];
  const gates = [];
  const results = [];
  for (const [index, candidate] of [allV2, mixed, allV3].entries()) {
    results.push(await migrateTestOnlyIntegrationAnalysisStateRoot(candidate, {
      beforeMutation(gate) {
        assertContentBlindGate(gate, candidate);
        assertGateMatrix(gate, expectedMatrices[index]);
        gates.push(gate);
      },
    }));
  }
  assert.deepEqual(withoutCurrentStateMetadata(gates[0]), withoutCurrentStateMetadata(gates[1]));
  assert.deepEqual(withoutCurrentStateMetadata(gates[1]), withoutCurrentStateMetadata(gates[2]));
  assert.equal(gates[0].targetAggregateDigest, gates[1].targetAggregateDigest);
  assert.equal(gates[1].targetAggregateDigest, gates[2].targetAggregateDigest);
  assert.equal(results[0].convertedScopeCount, 3);
  assert.equal(results[1].convertedScopeCount, 2);
  assert.equal(results[2].convertedScopeCount, 0);
  for (const result of results) {
    assert.equal(result.outputAggregateDigest, gates[0].targetAggregateDigest);
  }
  assert.deepEqual(await durableSnapshot(allV3), allV3Before);
  assert.deepEqual(await durableContents(allV2), await durableContents(allV3));
  assert.deepEqual(await durableContents(mixed), await durableContents(allV3));
}

async function emptyRootHasExplicitStorageState(root) {
  await fs.mkdir(path.join(root, "scopes"), { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await fs.chmod(path.join(root, "scopes"), 0o700);
  let observedGate;
  const result = await migrateTestOnlyIntegrationAnalysisStateRoot(root, {
    beforeMutation(gate) {
      observedGate = gate;
      assertContentBlindGate(gate, root);
      assertGateMatrix(gate, {
        scopeCount: 0,
        sourceV2ScopeCount: 0,
        sourceV3ScopeCount: 0,
        migrationTemporaryCount: 0,
        currentStorageState: "empty",
      });
    },
  });
  assert.equal(observedGate.currentStorageState, "empty");
  assert.equal(result.scopeCount, 0);
  assert.equal(result.convertedScopeCount, 0);
  assert.equal(result.unchangedScopeCount, 0);
  assert.equal(result.outputAggregateDigest, observedGate.targetAggregateDigest);
  assert.deepEqual(await durableSnapshot(root), {});
}

async function crashResumeKeepsTargetDigest(root) {
  await createNativeFixture(root, 3);
  await convertSelectedToV2(root, [0, 1, 2]);
  let firstGate;
  await assert.rejects(
    migrateTestOnlyIntegrationAnalysisStateRoot(root, {
      beforeMutation(gate) {
        firstGate = gate;
      },
      afterScopeCommitted({ committedCount }) {
        if (committedCount === 1) throw new Error("simulated crash after first scope");
      },
    }),
    (error) => error?.code === "ANALYSIS_STATE_MIGRATION_UNAVAILABLE"
  );
  assert.deepEqual((await stateVersions(root)).sort(), [
    INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
    INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
    INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
  ].sort());
  assertGateMatrix(firstGate, {
    scopeCount: 3,
    sourceV2ScopeCount: 3,
    sourceV3ScopeCount: 0,
    migrationTemporaryCount: 0,
    currentStorageState: "all-v2",
  });
  let resumedGate;
  const resumed = await migrateTestOnlyIntegrationAnalysisStateRoot(root, {
    beforeMutation(gate) {
      resumedGate = gate;
    },
  });
  assertGateMatrix(resumedGate, {
    scopeCount: 3,
    sourceV2ScopeCount: 2,
    sourceV3ScopeCount: 1,
    migrationTemporaryCount: 0,
    currentStorageState: "mixed",
  });
  assert.deepEqual(
    withoutCurrentStateMetadata(resumedGate),
    withoutCurrentStateMetadata(firstGate)
  );
  assert.equal(resumed.outputAggregateDigest, firstGate.targetAggregateDigest);
  assert.equal(resumed.convertedScopeCount, 2);
}

function gatedArguments(root, timeoutMs = 100) {
  return [
    "migrate",
    "--offline",
    "--state-root",
    root,
    "--prewrite-gate-nonce",
    NONCE,
    "--prewrite-gate-timeout-ms",
    String(timeoutMs),
  ];
}

async function startGatedCli(root, timeoutMs = 100) {
  const stdin = new PassThrough();
  let output = "";
  let resolveGate;
  let rejectGate;
  const gateReady = new Promise((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  const stdout = {
    write(value) {
      output += String(value);
      const newline = output.indexOf("\n");
      if (newline >= 0 && resolveGate) {
        try {
          resolveGate(JSON.parse(output.slice(0, newline)));
        } catch (error) {
          rejectGate(error);
        }
        resolveGate = null;
        rejectGate = null;
      }
      return true;
    },
  };
  const completion = migrationCliMain(gatedArguments(root, timeoutMs), {
    migrate: (stateRoot, options) => migrateTestOnlyIntegrationAnalysisStateRoot(stateRoot, options),
    stdin,
    stdout,
  });
  const gate = await withDeadline(gateReady, () => "gate output timed out");
  return Object.freeze({
    completion,
    gate,
    input: stdin,
    output: () => output,
  });
}

function assertPublicGate(gate, root) {
  assert.deepEqual(Object.keys(gate), [
    "schemaVersion",
    "event",
    "nonce",
    "timeoutMs",
    "direction",
    "targetStorageVersion",
    "scopeCount",
    "sourceV2ScopeCount",
    "sourceV3ScopeCount",
    "migrationTemporaryCount",
    "currentStorageState",
    "targetAggregateDigest",
    "migrationContractDigest",
    "ackSchemaVersion",
    "requiredAck",
  ]);
  assert.equal(gate.schemaVersion, INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_SCHEMA_VERSION);
  assert.equal(gate.event, "migration-prewrite-gate");
  assert.equal(gate.nonce, NONCE);
  assert.equal(gate.targetStorageVersion, INTEGRATION_ANALYSIS_STATE_STORAGE_V3);
  assertGateMatrix(gate);
  assert.equal(gate.ackSchemaVersion, INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_ACK_SCHEMA_VERSION);
  assert.match(gate.targetAggregateDigest, /^[a-f0-9]{64}$/u);
  assert.equal(
    gate.requiredAck,
    [
      INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_ACK_SCHEMA_VERSION,
      NONCE,
      gate.targetAggregateDigest,
      gate.migrationContractDigest,
    ].join(":")
  );
  const serialized = JSON.stringify(gate);
  assert.equal(serialized.includes(root), false);
  assert.doesNotMatch(serialized, new RegExp(SENSITIVE_MARKER, "u"));
  assert.doesNotMatch(serialized, /principal-prewrite|browserSessionId|threadId|runId/u);
}

async function cliAckAndFailureProtocol(root) {
  const base = path.join(root, "base");
  await createNativeFixture(base, 2);
  await convertSelectedToV2(base, [0, 1]);
  const firstFile = (await stateFiles(base))[0];
  const temporary = path.join(path.dirname(firstFile), MIGRATION_TEMPORARY_FILE_NAME);
  await fs.writeFile(temporary, "stale temporary remains until acknowledgement", { mode: 0o600 });
  await fs.chmod(temporary, 0o600);

  let referenceGate;
  for (const testCase of [
    { name: "eof", code: "ANALYSIS_STATE_MIGRATION_GATE_EOF", reply: (input) => input.end() },
    {
      name: "bad-ack",
      code: "ANALYSIS_STATE_MIGRATION_GATE_REJECTED",
      reply: (input) => input.end(`${SENSITIVE_MARKER}\n`),
    },
    {
      name: "trailing-chunk",
      code: "ANALYSIS_STATE_MIGRATION_GATE_REJECTED",
      reply(input, gate) {
        input.write(`${gate.requiredAck}\n`);
        input.end("x");
      },
    },
    { name: "timeout", code: "ANALYSIS_STATE_MIGRATION_GATE_TIMEOUT", timeoutMs: 20 },
    {
      name: "ack-without-eof-timeout",
      code: "ANALYSIS_STATE_MIGRATION_GATE_TIMEOUT",
      timeoutMs: 30,
      reply: (input, gate) => input.write(`${gate.requiredAck}\n`),
    },
  ]) {
    const candidate = path.join(root, testCase.name);
    await cloneRoot(base, candidate);
    const before = await durableSnapshot(candidate);
    const running = await startGatedCli(candidate, testCase.timeoutMs || 100);
    assertPublicGate(running.gate, candidate);
    assertGateMatrix(running.gate, {
      scopeCount: 2,
      sourceV2ScopeCount: 2,
      sourceV3ScopeCount: 0,
      migrationTemporaryCount: 1,
      currentStorageState: "all-v2",
    });
    if (testCase.timeoutMs === undefined) {
      if (referenceGate === undefined) referenceGate = running.gate;
      else assert.deepEqual(running.gate, referenceGate);
    }
    assert.equal((await fs.lstat(path.join(candidate, OWNER_LOCK_NAME))).isDirectory(), true);
    assert.deepEqual(await durableSnapshot(candidate), before);
    testCase.reply?.(running.input, running.gate);
    let rejected;
    await assert.rejects(
      running.completion,
      (error) => {
        rejected = error;
        return error?.code === testCase.code;
      }
    );
    running.input.end();
    assert.deepEqual(await durableSnapshot(candidate), before);
    await assert.rejects(fs.lstat(path.join(candidate, OWNER_LOCK_NAME)), { code: "ENOENT" });
    const safe = safeIntegrationAnalysisStateMigrationCliError(rejected);
    assert.equal(safe.includes(SENSITIVE_MARKER), false);
    assert.equal(safe.includes(candidate), false);
    assert.equal(running.output().trim().split("\n").length, 1);
  }

  const approved = path.join(root, "approved");
  await cloneRoot(base, approved);
  const before = await durableSnapshot(approved);
  const running = await startGatedCli(approved, 500);
  assertPublicGate(running.gate, approved);
  assertGateMatrix(running.gate, {
    scopeCount: 2,
    sourceV2ScopeCount: 2,
    sourceV3ScopeCount: 0,
    migrationTemporaryCount: 1,
    currentStorageState: "all-v2",
  });
  assert.equal(running.gate.requiredAck, referenceGate.requiredAck);
  assert.deepEqual(await durableSnapshot(approved), before);
  const acknowledgement = `${running.gate.requiredAck}\n`;
  const splitPoints = [1, 7, 19, 43, 89, 151, acknowledgement.length];
  let offset = 0;
  for (const splitPoint of splitPoints) {
    const end = Math.min(splitPoint, acknowledgement.length);
    if (end > offset) running.input.write(acknowledgement.slice(offset, end));
    offset = end;
  }
  let completionSettled = false;
  running.completion.then(
    () => { completionSettled = true; },
    () => { completionSettled = true; }
  );
  await delay(15);
  assert.equal(completionSettled, false);
  assert.equal((await fs.lstat(path.join(approved, OWNER_LOCK_NAME))).isDirectory(), true);
  assert.deepEqual(await durableSnapshot(approved), before);
  running.input.end();
  const result = await running.completion;
  assert.equal(result.convertedScopeCount, 2);
  assert.equal(result.outputAggregateDigest, running.gate.targetAggregateDigest);
  assert.deepEqual(await stateVersions(approved), [
    INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
    INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
  ]);
  assert.equal(running.output().trim().split("\n").length, 2);
}

async function cliParsingAndLegacyBehavior() {
  assert.deepEqual(
    parseIntegrationAnalysisStateMigrationCliArguments([
      "migrate",
      "--offline",
      "--state-root",
      CANONICAL_ROOT,
    ]),
    { command: "migrate", offline: true, stateRoot: CANONICAL_ROOT }
  );
  assert.deepEqual(
    parseIntegrationAnalysisStateMigrationCliArguments(gatedArguments(CANONICAL_ROOT, 120_000)),
    {
      command: "migrate",
      offline: true,
      stateRoot: CANONICAL_ROOT,
      prewriteGate: { nonce: NONCE, timeoutMs: 120_000 },
    }
  );
  for (const argv of [
    ["migrate", "--offline", "--state-root", CANONICAL_ROOT, "--prewrite-gate-nonce", NONCE],
    ["migrate", "--offline", "--state-root", CANONICAL_ROOT, "--prewrite-gate-timeout-ms", "100"],
    gatedArguments(CANONICAL_ROOT, INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_MAX_TIMEOUT_MS + 1),
    gatedArguments(CANONICAL_ROOT, 0),
    gatedArguments(CANONICAL_ROOT, 100).map((value) => value === NONCE ? NONCE.toUpperCase() : value),
    [...gatedArguments(CANONICAL_ROOT, 100), "--prewrite-gate-nonce", NONCE],
    [...gatedArguments(CANONICAL_ROOT, 100), "--prewrite-gate-timeout-ms", "100"],
  ]) {
    assert.throws(
      () => parseIntegrationAnalysisStateMigrationCliArguments(argv),
      (error) => error?.code === "ANALYSIS_STATE_MIGRATION_CLI_INVALID"
    );
  }

  const legacyResult = Object.freeze({ schemaVersion: "legacy-test", completed: true });
  let output = "";
  await migrationCliMain(
    ["migrate", "--offline", "--state-root", CANONICAL_ROOT],
    {
      migrate: async (...args) => {
        assert.deepEqual(args, [CANONICAL_ROOT]);
        return legacyResult;
      },
      stdout: { write(value) { output += value; } },
    }
  );
  assert.equal(output, `${JSON.stringify(legacyResult)}\n`);
}

function validTargetPlan() {
  return {
    schemaVersion: INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_SCHEMA_VERSION,
    event: "migration-prewrite-gate",
    direction: "forward-only",
    targetStorageVersion: INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
    scopeCount: 2,
    sourceV2ScopeCount: 2,
    sourceV3ScopeCount: 0,
    migrationTemporaryCount: 1,
    currentStorageState: "all-v2",
    targetAggregateDigest: "1".repeat(64),
    migrationContractDigest: contractDigest(INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT),
  };
}

async function withObjectPrototypeProperty(key, descriptor, operation) {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    enumerable: true,
    ...descriptor,
  });
  try {
    return await operation();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, key, previous);
    else delete Object.prototype[key];
  }
}

async function strictOptionSnapshots(root) {
  const inheritedRoot = path.join(root, "inherited-before-mutation");
  await createNativeFixture(inheritedRoot, 1);
  await convertSelectedToV2(inheritedRoot, [0]);
  let inheritedBeforeMutationCalls = 0;
  await withObjectPrototypeProperty("beforeMutation", {
    writable: true,
    value() {
      inheritedBeforeMutationCalls += 1;
      throw new Error("inherited beforeMutation executed");
    },
  }, async () => {
    const result = await migrateTestOnlyIntegrationAnalysisStateRoot(inheritedRoot, {});
    assert.equal(result.convertedScopeCount, 1);
  });
  assert.equal(inheritedBeforeMutationCalls, 0);

  let migrationGetterCalls = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "beforeMutation", {
    configurable: true,
    enumerable: true,
    get() {
      migrationGetterCalls += 1;
      return () => {};
    },
  });
  await assert.rejects(
    migrateIntegrationAnalysisStateRoot("/tmp/rejected-before-state-root", accessorOptions),
    TypeError
  );
  assert.equal(migrationGetterCalls, 0);
  const hiddenMigrationOptions = {};
  Object.defineProperty(hiddenMigrationOptions, "beforeMutation", {
    configurable: true,
    enumerable: false,
    value() {},
    writable: true,
  });
  await assert.rejects(
    migrateIntegrationAnalysisStateRoot("/tmp/rejected-before-state-root", hiddenMigrationOptions),
    TypeError
  );

  let migrationProxyTrapCalls = 0;
  const proxyOptions = new Proxy({}, {
    get() { migrationProxyTrapCalls += 1; },
    getOwnPropertyDescriptor() { migrationProxyTrapCalls += 1; },
    getPrototypeOf() { migrationProxyTrapCalls += 1; },
    ownKeys() { migrationProxyTrapCalls += 1; },
  });
  await assert.rejects(
    migrateIntegrationAnalysisStateRoot("/tmp/rejected-before-state-root", proxyOptions),
    TypeError
  );
  assert.equal(migrationProxyTrapCalls, 0);

  let inheritedMigrateReads = 0;
  await withObjectPrototypeProperty("migrate", {
    get() {
      inheritedMigrateReads += 1;
      return async () => ({ inherited: true });
    },
  }, async () => {
    await assert.rejects(
      migrationCliMain(
        ["migrate", "--offline", "--state-root", "/tmp/rejected-production-root"],
        { stdout: { write() { return true; } } }
      ),
      (error) => error?.code === "ANALYSIS_STATE_MIGRATION_INVALID"
    );
  });
  assert.equal(inheritedMigrateReads, 0);

  let inheritedStdoutReads = 0;
  let processOutput = "";
  const originalProcessStdoutWrite = process.stdout.write;
  process.stdout.write = function captureProcessStdout(value) {
    processOutput += String(value);
    return true;
  };
  try {
    await withObjectPrototypeProperty("stdout", {
      get() {
        inheritedStdoutReads += 1;
        return { write() { throw new Error("inherited stdout executed"); } };
      },
    }, async () => {
      await migrationCliMain(
        ["migrate", "--offline", "--state-root", CANONICAL_ROOT],
        { migrate: async () => ({ ownMigration: true }) }
      );
    });
  } finally {
    process.stdout.write = originalProcessStdoutWrite;
  }
  assert.equal(inheritedStdoutReads, 0);
  assert.equal(processOutput, `${JSON.stringify({ ownMigration: true })}\n`);

  const processStdin = process.stdin;
  let inheritedStdinReads = 0;
  await withObjectPrototypeProperty("stdin", {
    get() {
      inheritedStdinReads += 1;
      return new PassThrough();
    },
  }, async () => {
    let output = "";
    await assert.rejects(
      migrationCliMain(gatedArguments(CANONICAL_ROOT, 10), {
        migrate: async (_stateRoot, options) => {
          await options.beforeMutation(validTargetPlan());
          return { unexpectedlyCompleted: true };
        },
        stdout: { write(value) { output += String(value); } },
      }),
      (error) => [
        "ANALYSIS_STATE_MIGRATION_GATE_EOF",
        "ANALYSIS_STATE_MIGRATION_GATE_TIMEOUT",
      ].includes(error?.code)
    );
    assert.equal(output.trim().split("\n").length, 1);
  });
  assert.equal(inheritedStdinReads, 0);
  assert.equal(process.stdin, processStdin);

  let cliGetterCalls = 0;
  const cliAccessorOptions = {};
  Object.defineProperty(cliAccessorOptions, "migrate", {
    configurable: true,
    enumerable: true,
    get() {
      cliGetterCalls += 1;
      return async () => ({});
    },
  });
  await assert.rejects(
    migrationCliMain(
      ["migrate", "--offline", "--state-root", CANONICAL_ROOT],
      cliAccessorOptions
    ),
    (error) => error?.code === "ANALYSIS_STATE_MIGRATION_CLI_INVALID"
  );
  assert.equal(cliGetterCalls, 0);
  const hiddenCliOptions = {};
  Object.defineProperty(hiddenCliOptions, "migrate", {
    configurable: true,
    enumerable: false,
    value: async () => ({}),
    writable: true,
  });
  await assert.rejects(
    migrationCliMain(
      ["migrate", "--offline", "--state-root", CANONICAL_ROOT],
      hiddenCliOptions
    ),
    (error) => error?.code === "ANALYSIS_STATE_MIGRATION_CLI_INVALID"
  );

  let cliProxyTrapCalls = 0;
  const cliProxyOptions = new Proxy({}, {
    get() { cliProxyTrapCalls += 1; },
    getOwnPropertyDescriptor() { cliProxyTrapCalls += 1; },
    getPrototypeOf() { cliProxyTrapCalls += 1; },
    ownKeys() { cliProxyTrapCalls += 1; },
  });
  await assert.rejects(
    migrationCliMain(
      ["migrate", "--offline", "--state-root", CANONICAL_ROOT],
      cliProxyOptions
    ),
    (error) => error?.code === "ANALYSIS_STATE_MIGRATION_CLI_INVALID"
  );
  assert.equal(cliProxyTrapCalls, 0);
}

async function strictTargetPlanMatrixValidation() {
  const valid = validTargetPlan();
  const hiddenField = { ...valid };
  Object.defineProperty(hiddenField, "scopeCount", {
    configurable: true,
    enumerable: false,
    value: 2,
    writable: true,
  });
  const symbolField = { ...valid, [Symbol("unsupported")]: true };
  let inheritedTargetRead = 0;
  const inheritedField = { ...valid };
  delete inheritedField.scopeCount;
  Object.setPrototypeOf(inheritedField, {
    get scopeCount() {
      inheritedTargetRead += 1;
      return 2;
    },
  });
  const invalidPlans = [
    { ...valid, sourceV2ScopeCount: 1 },
    { ...valid, currentStorageState: "mixed" },
    { ...valid, migrationTemporaryCount: 3 },
    {
      ...valid,
      scopeCount: 0,
      sourceV2ScopeCount: 0,
      sourceV3ScopeCount: 0,
      migrationTemporaryCount: 0,
      currentStorageState: "all-v3",
    },
    { ...valid, currentStorageState: SENSITIVE_MARKER },
    { ...valid, sourceV3ScopeCount: -1 },
    { ...valid, sourceV2ScopeCount: 1.5, sourceV3ScopeCount: 0 },
    { ...valid, unsupportedMatrixField: true },
    hiddenField,
    symbolField,
    inheritedField,
  ];
  async function assertRejectedTargetPlan(targetPlan) {
    const stdin = new PassThrough();
    let output = "";
    let rejected;
    await assert.rejects(
      migrationCliMain(gatedArguments(CANONICAL_ROOT, 100), {
        migrate: async (_stateRoot, options) => {
          await options.beforeMutation(targetPlan);
          throw new Error("invalid target plan unexpectedly passed validation");
        },
        stdin,
        stdout: { write(value) { output += value; } },
      }),
      (error) => {
        rejected = error;
        return error?.code === "ANALYSIS_STATE_MIGRATION_GATE_PROTOCOL";
      }
    );
    stdin.end();
    assert.equal(output, "");
    const safe = safeIntegrationAnalysisStateMigrationCliError(rejected);
    assert.equal(safe.includes(SENSITIVE_MARKER), false);
    assert.equal(safe.includes(CANONICAL_ROOT), false);
  }
  for (const targetPlan of invalidPlans) await assertRejectedTargetPlan(targetPlan);
  assert.equal(inheritedTargetRead, 0);

  let changingGetterCalls = 0;
  const changingAccessorPlan = { ...valid };
  Object.defineProperty(changingAccessorPlan, "scopeCount", {
    configurable: true,
    enumerable: true,
    get() {
      changingGetterCalls += 1;
      return changingGetterCalls === 1 ? 2 : 3;
    },
  });
  await assertRejectedTargetPlan(changingAccessorPlan);
  assert.equal(changingGetterCalls, 0);

  let targetProxyTrapCalls = 0;
  const targetProxy = new Proxy({ ...valid }, {
    get() { targetProxyTrapCalls += 1; },
    getOwnPropertyDescriptor() { targetProxyTrapCalls += 1; },
    getPrototypeOf() { targetProxyTrapCalls += 1; },
    ownKeys() { targetProxyTrapCalls += 1; },
  });
  await assertRejectedTargetPlan(targetProxy);
  assert.equal(targetProxyTrapCalls, 0);
}

async function productionBinHandshake() {
  const runtimeParent = path.join("/run", "user", String(process.getuid?.() ?? ""));
  const parentStat = await fs.stat(runtimeParent);
  assert.equal(parentStat.isDirectory(), true);
  const container = await fs.mkdtemp(path.join(runtimeParent, "aginti-prewrite-production-smoke-"));
  await fs.chmod(container, 0o700);
  try {
    const source = path.join(container, "source-v3");
    const allV2 = path.join(container, "all-v2");
    const mixed = path.join(container, "mixed");
    const allV3 = path.join(container, "all-v3");
    const empty = path.join(container, "empty");
    await createNativeFixture(source, 2);
    await cloneRoot(source, allV2);
    await cloneRoot(source, mixed);
    await cloneRoot(source, allV3);
    await convertSelectedToV2(allV2, [0, 1]);
    await convertSelectedToV2(mixed, [0]);
    const allV2FirstFile = (await stateFiles(allV2))[0];
    const allV2Temporary = path.join(path.dirname(allV2FirstFile), MIGRATION_TEMPORARY_FILE_NAME);
    await fs.writeFile(allV2Temporary, "production CLI crash temporary", { mode: 0o600 });
    await fs.chmod(allV2Temporary, 0o600);
    await fs.mkdir(path.join(empty, "scopes"), { recursive: true, mode: 0o700 });
    await fs.chmod(empty, 0o700);
    await fs.chmod(path.join(empty, "scopes"), 0o700);

    async function runCandidate(root, expectedMatrix, convertedScopeCount, unchangedDurable) {
      const before = await durableSnapshot(root);
      const child = spawn(process.execPath, [MIGRATION_BIN, ...gatedArguments(root, 2_000)], {
        cwd: REPOSITORY_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      let completed = false;
      let stdout = "";
      let stderr = "";
      let resolveGate;
      let rejectGate;
      const gateReady = new Promise((resolve, reject) => {
        resolveGate = resolve;
        rejectGate = reject;
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        const newline = stdout.indexOf("\n");
        if (newline >= 0 && resolveGate) {
          try {
            resolveGate(JSON.parse(stdout.slice(0, newline)));
          } catch (error) {
            rejectGate(error);
          }
          resolveGate = null;
          rejectGate = null;
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => rejectGate?.(error));
      try {
        const gate = await withDeadline(
          gateReady,
          () => `production CLI gate timed out: ${stderr}`
        );
        assertPublicGate(gate, root);
        assertGateMatrix(gate, expectedMatrix);
        assert.equal((await fs.lstat(path.join(root, OWNER_LOCK_NAME))).isDirectory(), true);
        const owner = JSON.parse(
          await fs.readFile(path.join(root, OWNER_LOCK_NAME, "owner.json"), "utf8")
        );
        assert.equal(owner.pid, child.pid);
        assert.deepEqual(await durableSnapshot(root), before);
        child.stdin.end(`${gate.requiredAck}\n`);
        const [exitCode, signal] = await exited;
        assert.equal(exitCode, 0, stderr);
        assert.equal(signal, null);
        const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(lines.length, 2);
        assert.deepEqual(lines[0], gate);
        assert.equal(lines[1].completed, true);
        assert.equal(lines[1].convertedScopeCount, convertedScopeCount);
        assert.equal(lines[1].outputAggregateDigest, gate.targetAggregateDigest);
        assert.equal(stderr, "");
        assert.equal(stdout.includes(root), false);
        assert.doesNotMatch(stdout, new RegExp(SENSITIVE_MARKER, "u"));
        if (unchangedDurable) assert.deepEqual(await durableSnapshot(root), before);
        completed = true;
        return Object.freeze({ gate, result: lines[1] });
      } finally {
        if (!completed && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (!completed) await exited.catch(() => {});
      }
    }

    const runs = [];
    runs.push(await runCandidate(allV2, {
      scopeCount: 2,
      sourceV2ScopeCount: 2,
      sourceV3ScopeCount: 0,
      migrationTemporaryCount: 1,
      currentStorageState: "all-v2",
    }, 2, false));
    runs.push(await runCandidate(mixed, {
      scopeCount: 2,
      sourceV2ScopeCount: 1,
      sourceV3ScopeCount: 1,
      migrationTemporaryCount: 0,
      currentStorageState: "mixed",
    }, 1, false));
    runs.push(await runCandidate(allV3, {
      scopeCount: 2,
      sourceV2ScopeCount: 0,
      sourceV3ScopeCount: 2,
      migrationTemporaryCount: 0,
      currentStorageState: "all-v3",
    }, 0, true));
    const emptyRun = await runCandidate(empty, {
      scopeCount: 0,
      sourceV2ScopeCount: 0,
      sourceV3ScopeCount: 0,
      migrationTemporaryCount: 0,
      currentStorageState: "empty",
    }, 0, true);
    assert.deepEqual(withoutCurrentStateMetadata(runs[0].gate), withoutCurrentStateMetadata(runs[1].gate));
    assert.deepEqual(withoutCurrentStateMetadata(runs[1].gate), withoutCurrentStateMetadata(runs[2].gate));
    assert.equal(runs[0].gate.targetAggregateDigest, runs[1].gate.targetAggregateDigest);
    assert.equal(runs[1].gate.targetAggregateDigest, runs[2].gate.targetAggregateDigest);
    assert.notEqual(emptyRun.gate.targetAggregateDigest, runs[0].gate.targetAggregateDigest);
  } finally {
    await fs.rm(container, { recursive: true, force: true });
  }
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-analysis-prewrite-gate-"));
  await fs.chmod(temporaryRoot, 0o700);
  try {
    await lockHeldAndNoMutationBeforeApproval(path.join(temporaryRoot, "lock-and-boundary"));
    await gateOnlyAfterWholeRootPreflight(path.join(temporaryRoot, "whole-root-preflight"));
    await targetDigestStableAcrossResumeStates(path.join(temporaryRoot, "target-stability"));
    await emptyRootHasExplicitStorageState(path.join(temporaryRoot, "empty-state"));
    await crashResumeKeepsTargetDigest(path.join(temporaryRoot, "crash-resume"));
    await cliAckAndFailureProtocol(path.join(temporaryRoot, "cli-protocol"));
    await cliParsingAndLegacyBehavior();
    await strictOptionSnapshots(path.join(temporaryRoot, "strict-options"));
    await strictTargetPlanMatrixValidation();
    await productionBinHandshake();
    console.log("integration analysis state prewrite gate smoke passed");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
