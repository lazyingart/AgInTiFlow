import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let cachedDatabaseSync = null;
let cachedUnavailableError = null;

export const NODE_SQLITE_UNAVAILABLE_CODE = "AGINTIFLOW_NODE_SQLITE_UNAVAILABLE";

function nodeMajorVersion(version = process.versions.node) {
  return Number(String(version || "").split(".")[0]) || 0;
}

function requireNodeSqliteSilently() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filteredSqliteWarning(warning, ...args) {
    if (String(warning || "").includes("SQLite is an experimental feature")) return;
    return originalEmitWarning.call(process, warning, ...args);
  };
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

export function nodeSqliteStatus() {
  const nodeVersion = process.version;
  const nodeMajor = nodeMajorVersion();
  const forcedJson = process.env.AGINTIFLOW_FORCE_JSON_DB === "1" || process.env.AGINTIFLOW_FORCE_SQLITE_UNAVAILABLE === "1";
  if (forcedJson) {
    return {
      ok: false,
      forcedJson: true,
      nodeVersion,
      nodeMajor,
      requiredNodeMajor: 22,
      code: NODE_SQLITE_UNAVAILABLE_CODE,
      message: "AGINTIFLOW_FORCE_JSON_DB is enabled; using JSON fallback storage.",
    };
  }
  try {
    requireNodeSqliteSilently();
    return {
      ok: true,
      forcedJson: false,
      nodeVersion,
      nodeMajor,
      requiredNodeMajor: 22,
      code: "",
      message: "node:sqlite is available.",
    };
  } catch (error) {
    return {
      ok: false,
      forcedJson: false,
      nodeVersion,
      nodeMajor,
      requiredNodeMajor: 22,
      code: NODE_SQLITE_UNAVAILABLE_CODE,
      errorCode: error?.code || "",
      message: error?.message || String(error),
    };
  }
}

export function nodeSqliteRecoveryLines(status = nodeSqliteStatus()) {
  const lines = [
    `AgInTiFlow web/session SQLite storage needs Node.js 22+ with node:sqlite; current node is ${status.nodeVersion || process.version}.`,
    "AgInTiFlow will use a project-local JSON fallback when possible, but Node 22+ is still recommended for the full durable session index.",
    "Recommended fix after installing Node 22+: npm install -g @lazyingart/agintiflow@latest",
  ];

  if (process.platform === "win32") {
    lines.push("Windows: prefer WSL2 with Node 22+ and Docker Desktop WSL integration, or install Node 22+ with the official installer/nvm-windows.");
  } else {
    lines.push('nvm quick fix: export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 22; nvm alias default 22; nvm use 22');
    lines.push("If `which aginti` points to ~/.npm-global/bin/aginti after switching Node, remove the stale install or put the nvm bin directory before ~/.npm-global/bin in PATH.");
  }

  if (process.platform === "darwin") {
    lines.push("macOS alternative: brew install node@22, then reinstall AgInTiFlow globally with that node on PATH.");
  } else if (process.platform === "linux") {
    lines.push("Linux alternative: install Node 22+ from NodeSource/fnm/nvm/distro packages, then open a new shell and verify `node -v` and `which aginti`.");
  }

  return lines;
}

export function formatNodeSqliteRecovery(status = nodeSqliteStatus()) {
  return nodeSqliteRecoveryLines(status).join("\n");
}

export class AgintiSqliteUnavailableError extends Error {
  constructor(cause, status = nodeSqliteStatus()) {
    super(formatNodeSqliteRecovery(status));
    this.name = "AgintiSqliteUnavailableError";
    this.code = NODE_SQLITE_UNAVAILABLE_CODE;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function unavailableError(cause = null) {
  cachedUnavailableError = new AgintiSqliteUnavailableError(cause);
  return cachedUnavailableError;
}

export function loadDatabaseSync(options = {}) {
  if (cachedUnavailableError) {
    if (options.optional) return null;
    throw cachedUnavailableError;
  }
  if (cachedDatabaseSync) return cachedDatabaseSync;
  if (process.env.AGINTIFLOW_FORCE_JSON_DB === "1" || process.env.AGINTIFLOW_FORCE_SQLITE_UNAVAILABLE === "1") {
    const error = unavailableError(new Error("Forced JSON database fallback."));
    if (options.optional) return null;
    throw error;
  }
  try {
    cachedDatabaseSync = requireNodeSqliteSilently().DatabaseSync;
    return cachedDatabaseSync;
  } catch (error) {
    const wrapped = unavailableError(error);
    if (options.optional) return null;
    throw wrapped;
  }
}
