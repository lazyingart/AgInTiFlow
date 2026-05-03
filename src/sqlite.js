import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let cachedDatabaseSync = null;

export function loadDatabaseSync() {
  if (cachedDatabaseSync) return cachedDatabaseSync;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filteredSqliteWarning(warning, ...args) {
    if (String(warning || "").includes("SQLite is an experimental feature")) return;
    return originalEmitWarning.call(process, warning, ...args);
  };
  try {
    cachedDatabaseSync = require("node:sqlite").DatabaseSync;
    return cachedDatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}
