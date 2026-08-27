import path from "node:path";

import {
  IntegrationAnalysisStateMigrationError,
  migrateIntegrationAnalysisStateRoot,
} from "./integration-analysis-state-migrator.js";
import { IntegrationAnalysisSessionError } from "./integration-analysis-session-service.js";

const ALLOWED_OPTION_KEYS = Object.freeze(["migrate", "stdout"]);

function cliFail(message) {
  throw new IntegrationAnalysisStateMigrationError("ANALYSIS_STATE_MIGRATION_CLI_INVALID", message);
}

function assertPlainOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    cliFail("Migration CLI options must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    cliFail("Migration CLI options must be a plain object.");
  }
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
  }
}

export function parseIntegrationAnalysisStateMigrationCliArguments(argv = []) {
  if (!Array.isArray(argv)) cliFail("Migration CLI arguments are invalid.");
  const args = argv.map((value) => String(value));
  if (args.shift() !== "migrate") {
    cliFail("Usage: aginti-integration-analysis-state migrate --offline --state-root /absolute/path");
  }
  let offline = false;
  let stateRoot = "";
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--offline" && !offline) {
      offline = true;
      continue;
    }
    if (flag === "--state-root" && !stateRoot && args.length > 0) {
      stateRoot = args.shift();
      continue;
    }
    cliFail("Usage: aginti-integration-analysis-state migrate --offline --state-root /absolute/path");
  }
  if (!offline || !stateRoot || !path.isAbsolute(stateRoot) || path.normalize(stateRoot) !== stateRoot) {
    cliFail("Migration requires --offline and one canonical absolute --state-root.");
  }
  return Object.freeze({ command: "migrate", offline: true, stateRoot });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  assertPlainOptions(options);
  const parsed = parseIntegrationAnalysisStateMigrationCliArguments(argv);
  const migrate = options.migrate || migrateIntegrationAnalysisStateRoot;
  if (typeof migrate !== "function") cliFail("Migration implementation is invalid.");
  const stdout = options.stdout || process.stdout;
  if (!stdout || typeof stdout.write !== "function") cliFail("Migration output stream is invalid.");
  const result = await migrate(parsed.stateRoot);
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
