import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT,
  INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_SCHEMA_VERSION,
  IntegrationAnalysisStateMigrationError,
  migrateIntegrationAnalysisStateRoot,
} from "./integration-analysis-state-migrator.js";
import { IntegrationAnalysisSessionError } from "./integration-analysis-session-service.js";
import { INTEGRATION_ANALYSIS_STATE_STORAGE_V3 } from "./integration-analysis-state-persistence.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_ACK_SCHEMA_VERSION =
  "aginti-integration-analysis-state-migration-prewrite-ack-v1";
export const INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_MAX_TIMEOUT_MS = 600_000;

const ALLOWED_OPTION_KEYS = Object.freeze(["migrate", "stdin", "stdout"]);
const GATE_NONCE_PATTERN = /^[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const USAGE = "Usage: aginti-integration-analysis-state migrate --offline --state-root /absolute/path [--prewrite-gate-nonce 64-lowercase-hex --prewrite-gate-timeout-ms 1..600000]";

function cliFail(message) {
  throw new IntegrationAnalysisStateMigrationError("ANALYSIS_STATE_MIGRATION_CLI_INVALID", message);
}

function snapshotCliOptions(options) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    utilTypes.isProxy(options)
  ) {
    cliFail("Migration CLI options must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    cliFail("Migration CLI options must be a plain object.");
  }
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      typeof key !== "string" ||
      !ALLOWED_OPTION_KEYS.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      cliFail("Migration CLI options contain an unsupported field.");
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

export function parseIntegrationAnalysisStateMigrationCliArguments(argv = []) {
  if (!Array.isArray(argv)) cliFail("Migration CLI arguments are invalid.");
  const args = argv.map((value) => String(value));
  if (args.shift() !== "migrate") {
    cliFail(USAGE);
  }
  let offline = false;
  let prewriteGateNonceSeen = false;
  let prewriteGateNonce = "";
  let prewriteGateTimeoutSeen = false;
  let prewriteGateTimeoutMs = null;
  let stateRootSeen = false;
  let stateRoot = "";
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--offline" && !offline) {
      offline = true;
      continue;
    }
    if (flag === "--state-root" && !stateRootSeen && args.length > 0) {
      stateRootSeen = true;
      stateRoot = args.shift();
      continue;
    }
    if (flag === "--prewrite-gate-nonce" && !prewriteGateNonceSeen && args.length > 0) {
      prewriteGateNonceSeen = true;
      prewriteGateNonce = args.shift();
      continue;
    }
    if (flag === "--prewrite-gate-timeout-ms" && !prewriteGateTimeoutSeen && args.length > 0) {
      prewriteGateTimeoutSeen = true;
      const raw = args.shift();
      if (!/^[1-9][0-9]{0,5}$/u.test(raw)) cliFail(USAGE);
      prewriteGateTimeoutMs = Number(raw);
      continue;
    }
    cliFail(USAGE);
  }
  if (!offline || !stateRoot || !path.isAbsolute(stateRoot) || path.normalize(stateRoot) !== stateRoot) {
    cliFail("Migration requires --offline and one canonical absolute --state-root.");
  }
  const gateRequested = prewriteGateNonceSeen || prewriteGateTimeoutSeen;
  if (
    gateRequested &&
    (!GATE_NONCE_PATTERN.test(prewriteGateNonce) ||
      !Number.isSafeInteger(prewriteGateTimeoutMs) ||
      prewriteGateTimeoutMs < 1 ||
      prewriteGateTimeoutMs > INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_MAX_TIMEOUT_MS)
  ) {
    cliFail("The prewrite gate requires one 64-character lowercase-hex nonce and a timeout from 1 through 600000 ms.");
  }
  if (!gateRequested) return Object.freeze({ command: "migrate", offline: true, stateRoot });
  return Object.freeze({
    command: "migrate",
    offline: true,
    stateRoot,
    prewriteGate: Object.freeze({
      nonce: prewriteGateNonce,
      timeoutMs: prewriteGateTimeoutMs,
    }),
  });
}

function validatedTargetPlan(value) {
  const expectedKeys = Object.freeze([
    "currentStorageState",
    "direction",
    "event",
    "migrationContractDigest",
    "migrationTemporaryCount",
    "schemaVersion",
    "scopeCount",
    "sourceV2ScopeCount",
    "sourceV3ScopeCount",
    "targetAggregateDigest",
    "targetStorageVersion",
  ]);
  const fail = () => {
    throw new IntegrationAnalysisStateMigrationError(
      "ANALYSIS_STATE_MIGRATION_GATE_PROTOCOL",
      "The migration prewrite target plan is invalid."
    );
  };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    fail();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    fail();
  }
  const targetPlan = Object.create(null);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail();
    targetPlan[key] = descriptor.value;
  }
  Object.freeze(targetPlan);
  const scopeCount = targetPlan.scopeCount;
  const sourceV2ScopeCount = targetPlan.sourceV2ScopeCount;
  const sourceV3ScopeCount = targetPlan.sourceV3ScopeCount;
  const migrationTemporaryCount = targetPlan.migrationTemporaryCount;
  const countsValid = [scopeCount, sourceV2ScopeCount, sourceV3ScopeCount, migrationTemporaryCount]
    .every((count) => Number.isSafeInteger(count) && count >= 0);
  const expectedStorageState = !countsValid || sourceV2ScopeCount + sourceV3ScopeCount !== scopeCount
    ? null
    : scopeCount === 0
      ? "empty"
      : sourceV2ScopeCount === scopeCount
        ? "all-v2"
        : sourceV3ScopeCount === scopeCount
          ? "all-v3"
          : sourceV2ScopeCount > 0 && sourceV3ScopeCount > 0
            ? "mixed"
            : null;
  if (
    targetPlan.schemaVersion !== INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_SCHEMA_VERSION ||
    targetPlan.event !== "migration-prewrite-gate" ||
    targetPlan.direction !== "forward-only" ||
    targetPlan.targetStorageVersion !== INTEGRATION_ANALYSIS_STATE_STORAGE_V3 ||
    !countsValid ||
    migrationTemporaryCount > scopeCount ||
    targetPlan.currentStorageState !== expectedStorageState ||
    typeof targetPlan.targetAggregateDigest !== "string" ||
    !DIGEST_PATTERN.test(targetPlan.targetAggregateDigest) ||
    targetPlan.migrationContractDigest !== contractDigest(INTEGRATION_ANALYSIS_STATE_MIGRATION_CONTRACT)
  ) {
    fail();
  }
  return targetPlan;
}

function requiredPrewriteAck(nonce, targetPlan) {
  return [
    INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_ACK_SCHEMA_VERSION,
    nonce,
    targetPlan.targetAggregateDigest,
    targetPlan.migrationContractDigest,
  ].join(":");
}

function publicPrewriteGate(targetPlanValue, { nonce, timeoutMs }) {
  const targetPlan = validatedTargetPlan(targetPlanValue);
  const requiredAck = requiredPrewriteAck(nonce, targetPlan);
  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_GATE_SCHEMA_VERSION,
    event: "migration-prewrite-gate",
    nonce,
    timeoutMs,
    direction: "forward-only",
    targetStorageVersion: INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
    scopeCount: targetPlan.scopeCount,
    sourceV2ScopeCount: targetPlan.sourceV2ScopeCount,
    sourceV3ScopeCount: targetPlan.sourceV3ScopeCount,
    migrationTemporaryCount: targetPlan.migrationTemporaryCount,
    currentStorageState: targetPlan.currentStorageState,
    targetAggregateDigest: targetPlan.targetAggregateDigest,
    migrationContractDigest: targetPlan.migrationContractDigest,
    ackSchemaVersion: INTEGRATION_ANALYSIS_STATE_MIGRATION_PREWRITE_ACK_SCHEMA_VERSION,
    requiredAck,
  });
}

function waitForExactPrewriteAck(stdin, requiredAck, timeoutMs) {
  if (
    !stdin ||
    typeof stdin.on !== "function" ||
    typeof stdin.off !== "function" ||
    typeof stdin.resume !== "function"
  ) {
    cliFail("Migration input stream is invalid.");
  }
  const expected = Buffer.from(`${requiredAck}\n`, "utf8");
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      try {
        stdin.pause?.();
      } catch {
        // Listener removal is sufficient for a broken injected stream.
      }
      if (error) reject(error);
      else resolve();
    };
    const rejectWith = (code, message, cause) => finish(
      new IntegrationAnalysisStateMigrationError(code, message, { cause })
    );
    const onData = (chunk) => {
      let bytes;
      try {
        bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      } catch (error) {
        rejectWith(
          "ANALYSIS_STATE_MIGRATION_GATE_UNAVAILABLE",
          "Migration input failed before the exact prewrite acknowledgement.",
          error
        );
        return;
      }
      if (bytes.length > expected.length - received.length) {
        rejectWith("ANALYSIS_STATE_MIGRATION_GATE_REJECTED", "The migration prewrite acknowledgement was rejected.");
        return;
      }
      received = Buffer.concat([received, bytes], received.length + bytes.length);
      if (
        !expected.subarray(0, received.length).equals(received)
      ) {
        rejectWith("ANALYSIS_STATE_MIGRATION_GATE_REJECTED", "The migration prewrite acknowledgement was rejected.");
        return;
      }
    };
    const onEnd = () => {
      if (received.length === expected.length && received.equals(expected)) {
        finish();
        return;
      }
      rejectWith(
        "ANALYSIS_STATE_MIGRATION_GATE_EOF",
        "Migration input ended before the exact prewrite acknowledgement."
      );
    };
    const onError = (error) => rejectWith(
      "ANALYSIS_STATE_MIGRATION_GATE_UNAVAILABLE",
      "Migration input failed before the exact prewrite acknowledgement.",
      error
    );
    const timer = setTimeout(
      () => rejectWith(
        "ANALYSIS_STATE_MIGRATION_GATE_TIMEOUT",
        "The migration prewrite acknowledgement timed out."
      ),
      timeoutMs
    );
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
    if (stdin.readableEnded === true) onEnd();
  });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const cliOptions = snapshotCliOptions(options);
  const parsed = parseIntegrationAnalysisStateMigrationCliArguments(argv);
  const migrate = cliOptions.migrate === undefined
    ? migrateIntegrationAnalysisStateRoot
    : cliOptions.migrate;
  if (typeof migrate !== "function") cliFail("Migration implementation is invalid.");
  const stdout = cliOptions.stdout === undefined ? process.stdout : cliOptions.stdout;
  if (!stdout || typeof stdout.write !== "function") cliFail("Migration output stream is invalid.");
  if (!parsed.prewriteGate) {
    const result = await migrate(parsed.stateRoot);
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const stdin = cliOptions.stdin === undefined ? process.stdin : cliOptions.stdin;
  let gateCompleted = false;
  let gateObserved = false;
  const result = await migrate(parsed.stateRoot, {
    beforeMutation: async (targetPlan) => {
      if (gateObserved) {
        throw new IntegrationAnalysisStateMigrationError(
          "ANALYSIS_STATE_MIGRATION_GATE_PROTOCOL",
          "The migration prewrite gate was emitted more than once."
        );
      }
      gateObserved = true;
      const gate = publicPrewriteGate(targetPlan, parsed.prewriteGate);
      stdout.write(`${JSON.stringify(gate)}\n`);
      await waitForExactPrewriteAck(stdin, gate.requiredAck, parsed.prewriteGate.timeoutMs);
      gateCompleted = true;
    },
  });
  if (!gateCompleted) {
    throw new IntegrationAnalysisStateMigrationError(
      "ANALYSIS_STATE_MIGRATION_GATE_PROTOCOL",
      "The migration implementation did not complete the required prewrite gate."
    );
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

export function safeIntegrationAnalysisStateMigrationCliError(error) {
  const code = /^[A-Z][A-Z0-9_]{1,95}$/u.test(String(error?.code || ""))
    ? String(error.code)
    : "ANALYSIS_STATE_MIGRATION_FAILED";
  if (error instanceof IntegrationAnalysisStateMigrationError) {
    return `${code}: ${error.message}`;
  }
  if (error instanceof IntegrationAnalysisSessionError) {
    return `${code}: Durable analysis state failed validation.`;
  }
  return `${code}: The offline analysis state migration could not complete safely.`;
}
