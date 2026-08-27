import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { withDirectoryLock } from "./integration-durable-common.js";
import { validateAgintiBrowserSession, validateAgintiPrincipalId } from "./integration-auth.js";
import {
  INTEGRATION_ANALYSIS_SESSION_LIMITS,
  IntegrationAnalysisSessionError,
  atomicReplacePrivateIntegrationAnalysisStateFile,
  integrationAnalysisStateScopeDigest,
  parseIntegrationAnalysisStateMigrationSource,
  serializeIntegrationAnalysisStateForPersistence,
} from "./integration-analysis-session-service.js";
import {
  INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES,
  INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
  INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
} from "./integration-analysis-state-persistence.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_ANALYSIS_STATE_MIGRATION_SCHEMA_VERSION =
  "aginti-integration-analysis-state-migration-v1";
export const INTEGRATION_ANALYSIS_STATE_MIGRATION_STALE_LOCK_MS = 60_000;
export const INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT = Object.freeze({
  schemaVersion: INTEGRATION_ANALYSIS_STATE_MIGRATION_SCHEMA_VERSION,
  sourceStorageVersion: INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
  targetStorageVersion: INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
  scopeSelection: "all",
  direction: "forward-only",
  offlineOnly: true,
  networkAccess: "denied",
  contentOutput: "counts-and-aggregate-digests-only",
  scopeOrdering: "lowercase-hex-code-unit-ascending-v1",
  requiresAllRunsTerminal: true,
  deadOwnerRecoveryAfterMs: INTEGRATION_ANALYSIS_STATE_MIGRATION_STALE_LOCK_MS,
  liveOwnerRecovery: false,
  atomicScopeReplace: true,
  resumable: true,
});

const OWNER_LOCK_NAME = ".analysis-session-owner.lock";
const SCOPES_DIRECTORY_NAME = "scopes";
const STATE_FILE_NAME = "state.json";
const MIGRATION_TEMPORARY_FILE_NAME = ".state.json.aginti-v2-v3-migration.tmp";
const O_NOFOLLOW = Number(fsConstants.O_NOFOLLOW || 0);
const SCOPE_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/u;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TEST_MIGRATION_OPTION_KEYS = new Set(["afterScopeCommitted", "staleLockMs"]);

export class IntegrationAnalysisStateMigrationError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationAnalysisStateMigrationError";
    this.code = code;
    this.publicCode = code;
  }
}

function migrationFail(code, message, cause) {
  throw new IntegrationAnalysisStateMigrationError(code, message, { cause });
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function ownerIsCurrent(stat) {
  const uid = currentUid();
  return uid === null || stat.uid === uid;
}

function ownerIsTrustedAncestor(stat) {
  const uid = currentUid();
  return uid === null || stat.uid === uid || stat.uid === 0;
}

function mode(stat) {
  return stat.mode & 0o7777;
}

function normalizedStateRoot(value, { testOnly }) {
  const stateRoot = String(value || "");
  if (
    !stateRoot ||
    stateRoot.includes("\u0000") ||
    !path.isAbsolute(stateRoot) ||
    path.normalize(stateRoot) !== stateRoot ||
    stateRoot === path.parse(stateRoot).root
  ) {
    migrationFail("ANALYSIS_STATE_MIGRATION_INVALID", "The state root must be one canonical absolute directory.");
  }
  if (
    !testOnly &&
    (stateRoot === "/tmp" ||
      stateRoot.startsWith("/tmp/") ||
      stateRoot === "/var/tmp" ||
      stateRoot.startsWith("/var/tmp/"))
  ) {
    migrationFail("ANALYSIS_STATE_MIGRATION_INVALID", "Production migration cannot use a temporary state root.");
  }
  return stateRoot;
}

async function lstatOrFail(target, code = "ANALYSIS_STATE_MIGRATION_UNAVAILABLE") {
  try {
    return await fs.lstat(target);
  } catch (error) {
    migrationFail(code, "The analysis state layout is unavailable.", error);
  }
}

async function assertExistingDirectoryTree(stateRoot, { testOnly }) {
  const parsed = path.parse(stateRoot);
  const parts = stateRoot.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    const stat = await lstatOrFail(cursor);
    const leaf = index === parts.length - 1;
    const stickyTestAncestor = testOnly && !leaf && (mode(stat) & 0o1000) !== 0;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.nlink < 2 ||
      (leaf ? !ownerIsCurrent(stat) : !ownerIsTrustedAncestor(stat)) ||
      (leaf ? mode(stat) !== 0o700 : !stickyTestAncestor && (mode(stat) & 0o022) !== 0)
    ) {
      migrationFail("ANALYSIS_STATE_MIGRATION_UNSAFE", "The analysis state directory ownership or mode is unsafe.");
    }
  }
  let real;
  try {
    real = await fs.realpath(stateRoot);
  } catch (error) {
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "The analysis state root cannot be resolved.", error);
  }
  if (real !== stateRoot) {
    migrationFail("ANALYSIS_STATE_MIGRATION_UNSAFE", "The analysis state root is not canonical.");
  }
}

async function assertPrivateDirectory(target) {
  const stat = await lstatOrFail(target);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.nlink < 2 ||
    !ownerIsCurrent(stat) ||
    mode(stat) !== 0o700
  ) {
    migrationFail("ANALYSIS_STATE_MIGRATION_UNSAFE", "An analysis state directory is unsafe.");
  }
  let real;
  try {
    real = await fs.realpath(target);
  } catch (error) {
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "An analysis state directory cannot be resolved.", error);
  }
  if (real !== target) {
    migrationFail("ANALYSIS_STATE_MIGRATION_UNSAFE", "An analysis state directory is not canonical.");
  }
  return stat;
}

function assertPrivateFileStat(stat) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink?.() ||
    !ownerIsCurrent(stat) ||
    mode(stat) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size < 0 ||
    stat.size > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumStateBytes
  ) {
    migrationFail("ANALYSIS_STATE_MIGRATION_UNSAFE", "An analysis state file is unsafe.");
  }
}

async function readPrivateStateFile(target) {
  const named = await lstatOrFail(target, "ANALYSIS_STATE_MIGRATION_CORRUPT");
  assertPrivateFileStat(named);
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | O_NOFOLLOW);
    const opened = await handle.stat();
    assertPrivateFileStat(opened);
    if (opened.dev !== named.dev || opened.ino !== named.ino) {
      migrationFail("ANALYSIS_STATE_MIGRATION_UNSAFE", "An analysis state file changed during inspection.");
    }
    const bytes = await handle.readFile();
    try {
      return FATAL_UTF8_DECODER.decode(bytes);
    } catch (error) {
      migrationFail("ANALYSIS_STATE_MIGRATION_CORRUPT", "An analysis state file is not canonical UTF-8.", error);
    }
  } catch (error) {
    if (error instanceof IntegrationAnalysisStateMigrationError) throw error;
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "An analysis state file cannot be read safely.", error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function syncDirectory(target) {
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | O_NOFOLLOW);
    await handle.sync();
  } catch (error) {
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "An analysis state directory cannot be synchronized.", error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeStaleMigrationTemporary(scopeDirectory) {
  const temporaryPath = path.join(scopeDirectory, MIGRATION_TEMPORARY_FILE_NAME);
  let stat;
  try {
    stat = await fs.lstat(temporaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "Migration recovery cannot inspect its temporary file.", error);
  }
  assertPrivateFileStat(stat);
  try {
    await fs.unlink(temporaryPath);
    await syncDirectory(scopeDirectory);
  } catch (error) {
    if (error instanceof IntegrationAnalysisStateMigrationError) throw error;
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "Migration recovery cannot remove its temporary file.", error);
  }
}

async function inspectOptionalMigrationTemporary(scopeDirectory) {
  const temporaryPath = path.join(scopeDirectory, MIGRATION_TEMPORARY_FILE_NAME);
  let named;
  try {
    named = await fs.lstat(temporaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "Migration preflight cannot inspect its temporary file.", error);
  }
  assertPrivateFileStat(named);
  let handle;
  try {
    handle = await fs.open(temporaryPath, fsConstants.O_RDONLY | O_NOFOLLOW);
    const opened = await handle.stat();
    assertPrivateFileStat(opened);
    if (opened.dev !== named.dev || opened.ino !== named.ino) {
      migrationFail("ANALYSIS_STATE_MIGRATION_UNSAFE", "A migration temporary file changed during preflight.");
    }
    return true;
  } catch (error) {
    if (error instanceof IntegrationAnalysisStateMigrationError) throw error;
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "Migration preflight cannot inspect its temporary file safely.", error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function exactDirectoryEntries(target, expectedNames) {
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "The analysis state layout cannot be enumerated.", error);
  }
  const actual = entries.map((entry) => entry.name).sort();
  const expected = [...expectedNames].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    migrationFail("ANALYSIS_STATE_MIGRATION_UNSAFE", "The analysis state layout contains unexpected entries.");
  }
  return entries;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function aggregateDigest(entries, field) {
  return contractDigest({
    schemaVersion: "aginti-integration-analysis-state-migration-aggregate-v1",
    entries: entries.map((entry) => Object.freeze({
      scopeDigest: entry.scopeDigest,
      stateDigest: entry[field],
    })),
  });
}

function compareScopeDirectoryEntries(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function expectedScopeFromText(text) {
  let value;
  try {
    value = JSON.parse(text);
    return Object.freeze({
      principalId: validateAgintiPrincipalId(value?.state?.scope?.principalId),
      browserSessionId: validateAgintiBrowserSession(value?.state?.scope?.browserSessionId),
    });
  } catch (error) {
    throw new IntegrationAnalysisSessionError(
      "ANALYSIS_STATE_CORRUPT",
      "Durable analysis state failed integrity validation.",
      { status: 503, cause: error }
    );
  }
}

function inspectMigrationSource(text, scopeDirectoryName) {
  const expectedScope = expectedScopeFromText(text);
  const parsed = parseIntegrationAnalysisStateMigrationSource(text, expectedScope);
  if (integrationAnalysisStateScopeDigest(expectedScope) !== scopeDirectoryName) {
    migrationFail("ANALYSIS_STATE_MIGRATION_CORRUPT", "An analysis state file is bound to the wrong scope directory.");
  }
  if (parsed.state.runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))) {
    migrationFail(
      "ANALYSIS_STATE_MIGRATION_NONTERMINAL",
      "Analysis state contains a nonterminal run and cannot cross the storage floor."
    );
  }
  const output = serializeIntegrationAnalysisStateForPersistence(
    parsed.state,
    expectedScope,
    INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3
  );
  if (
    parsed.sourceStorageVersion === INTEGRATION_ANALYSIS_STATE_STORAGE_V3 &&
    output !== text
  ) {
    migrationFail("ANALYSIS_STATE_MIGRATION_CORRUPT", "A native-v3 analysis state file is not stable under canonical encoding.");
  }
  return Object.freeze({
    sourceStorageVersion: parsed.sourceStorageVersion,
    inputDigest: sha256(text),
    outputDigest: sha256(output),
    output,
  });
}

async function discoverScopes(stateRoot) {
  await exactDirectoryEntries(stateRoot, [OWNER_LOCK_NAME, SCOPES_DIRECTORY_NAME]);
  const scopesDirectory = path.join(stateRoot, SCOPES_DIRECTORY_NAME);
  await assertPrivateDirectory(scopesDirectory);
  let entries;
  try {
    entries = await fs.readdir(scopesDirectory, { withFileTypes: true });
  } catch (error) {
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "Analysis scopes cannot be enumerated.", error);
  }
  if (entries.length > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumScopes) {
    migrationFail("ANALYSIS_STATE_MIGRATION_CORRUPT", "The analysis state root exceeds its scope limit.");
  }
  entries.sort(compareScopeDirectoryEntries);
  const scopes = [];
  for (const entry of entries) {
    if (!SCOPE_DIRECTORY_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      migrationFail("ANALYSIS_STATE_MIGRATION_UNSAFE", "An analysis scope directory is unsafe.");
    }
    const scopeDirectory = path.join(scopesDirectory, entry.name);
    await assertPrivateDirectory(scopeDirectory);
    const temporaryPresent = await inspectOptionalMigrationTemporary(scopeDirectory);
    await exactDirectoryEntries(
      scopeDirectory,
      temporaryPresent ? [STATE_FILE_NAME, MIGRATION_TEMPORARY_FILE_NAME] : [STATE_FILE_NAME]
    );
    scopes.push(Object.freeze({
      scopeDigest: entry.name,
      scopeDirectory,
      stateFile: path.join(scopeDirectory, STATE_FILE_NAME),
      temporaryFile: path.join(scopeDirectory, MIGRATION_TEMPORARY_FILE_NAME),
      temporaryPresent,
    }));
  }
  return Object.freeze(scopes);
}

function migrationResult(plan, finalEntries) {
  const convertedScopeCount = plan.filter(
    (entry) => entry.sourceStorageVersion === INTEGRATION_ANALYSIS_STATE_STORAGE_V2
  ).length;
  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_STATE_MIGRATION_SCHEMA_VERSION,
    completed: true,
    direction: "forward-only",
    networkAccess: "denied",
    scopeCount: plan.length,
    convertedScopeCount,
    unchangedScopeCount: plan.length - convertedScopeCount,
    inputAggregateDigest: aggregateDigest(plan, "inputDigest"),
    outputAggregateDigest: aggregateDigest(finalEntries, "outputDigest"),
    contractDigest: contractDigest(INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT),
  });
}

async function migrateLocked(stateRoot, hooks) {
  const scopes = await discoverScopes(stateRoot);
  const plan = [];
  for (const scope of scopes) {
    const source = inspectMigrationSource(await readPrivateStateFile(scope.stateFile), scope.scopeDigest);
    const { output: _output, ...metadata } = source;
    plan.push(Object.freeze({ ...scope, ...metadata }));
  }

  for (const entry of plan) {
    if (entry.temporaryPresent) await removeStaleMigrationTemporary(entry.scopeDirectory);
  }

  let committedCount = 0;
  for (const entry of plan) {
    if (entry.sourceStorageVersion !== INTEGRATION_ANALYSIS_STATE_STORAGE_V2) continue;
    const currentText = await readPrivateStateFile(entry.stateFile);
    if (sha256(currentText) !== entry.inputDigest) {
      migrationFail("ANALYSIS_STATE_MIGRATION_CONFLICT", "Analysis state changed after migration preflight.");
    }
    const current = inspectMigrationSource(currentText, entry.scopeDigest);
    if (current.outputDigest !== entry.outputDigest) {
      migrationFail("ANALYSIS_STATE_MIGRATION_CONFLICT", "Analysis state changed after migration preflight.");
    }
    await atomicReplacePrivateIntegrationAnalysisStateFile(entry.stateFile, current.output, {
      temporaryPath: entry.temporaryFile,
    });
    committedCount += 1;
    if (typeof hooks.afterScopeCommitted === "function") {
      await hooks.afterScopeCommitted(Object.freeze({ committedCount, scopeCount: plan.length }));
    }
  }

  const finalEntries = [];
  for (const entry of plan) {
    const finalText = await readPrivateStateFile(entry.stateFile);
    const finalState = inspectMigrationSource(finalText, entry.scopeDigest);
    if (
      finalState.sourceStorageVersion !== INTEGRATION_ANALYSIS_STATE_STORAGE_V3 ||
      finalState.outputDigest !== entry.outputDigest
    ) {
      migrationFail("ANALYSIS_STATE_MIGRATION_CORRUPT", "Post-migration state verification failed.");
    }
    finalEntries.push(Object.freeze({
      scopeDigest: entry.scopeDigest,
      outputDigest: finalState.outputDigest,
    }));
  }
  await exactDirectoryEntries(stateRoot, [OWNER_LOCK_NAME, SCOPES_DIRECTORY_NAME]);
  return migrationResult(plan, finalEntries);
}

async function migrateStateRoot(stateRootValue, { testOnly, hooks, staleLockMs }) {
  const stateRoot = normalizedStateRoot(stateRootValue, { testOnly });
  await assertExistingDirectoryTree(stateRoot, { testOnly });
  const lockPath = path.join(stateRoot, OWNER_LOCK_NAME);
  try {
    const result = await withDirectoryLock(
      lockPath,
      () => migrateLocked(stateRoot, hooks),
      {
        waitMs: 0,
        staleMs: staleLockMs,
        requireValidatedOwnerForRecovery: true,
      }
    );
    await syncDirectory(stateRoot);
    return result;
  } catch (error) {
    if (
      error instanceof IntegrationAnalysisStateMigrationError ||
      error instanceof IntegrationAnalysisSessionError
    ) {
      throw error;
    }
    if (error?.code === "INTEGRATION_AUTHORITY_BUSY") {
      migrationFail("ANALYSIS_STATE_MIGRATION_BUSY", "The analysis state root is currently owned.", error);
    }
    migrationFail("ANALYSIS_STATE_MIGRATION_UNAVAILABLE", "The analysis state migration could not run safely.", error);
  }
}

export async function migrateIntegrationAnalysisStateRoot(stateRoot) {
  return migrateStateRoot(stateRoot, {
    testOnly: false,
    hooks: Object.freeze({}),
    staleLockMs: INTEGRATION_ANALYSIS_STATE_MIGRATION_STALE_LOCK_MS,
  });
}

export async function migrateTestOnlyIntegrationAnalysisStateRoot(stateRoot, options = {}) {
  const keys = Object.keys(options);
  if (keys.some((key) => !TEST_MIGRATION_OPTION_KEYS.has(key))) {
    throw new TypeError("test migration options contain an unsupported field");
  }
  if (options.afterScopeCommitted !== undefined && typeof options.afterScopeCommitted !== "function") {
    throw new TypeError("afterScopeCommitted must be a function");
  }
  const staleLockMs = options.staleLockMs ?? INTEGRATION_ANALYSIS_STATE_MIGRATION_STALE_LOCK_MS;
  if (!Number.isSafeInteger(staleLockMs) || staleLockMs < 1 || staleLockMs > 60_000) {
    throw new TypeError("staleLockMs must be an integer from 1 through 60000");
  }
  return migrateStateRoot(stateRoot, {
    testOnly: true,
    hooks: Object.freeze({ afterScopeCommitted: options.afterScopeCommitted }),
    staleLockMs,
  });
}
