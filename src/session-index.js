import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadDatabaseSync } from "./sqlite.js";

export const PROJECT_SESSIONS_DIR_NAME = ".aginti-sessions";
export const LEGACY_PROJECT_SESSIONS_DIR_NAME = ".sessions";

const SESSION_COLUMNS = `session_id AS sessionId, project_root AS projectRoot, command_cwd AS commandCwd, project_sessions_dir AS projectSessionsDir,
  session_dir AS sessionDir, provider, model, goal, title, status,
  created_at AS createdAt, updated_at AS updatedAt, ended_at AS endedAt, result, error`;
const indexDbConnections = new Map();

export function agintiflowHome() {
  return path.resolve(process.env.AGINTIFLOW_HOME || path.join(os.homedir(), ".agintiflow"));
}

export function globalSessionPaths(sessionId = "") {
  const home = agintiflowHome();
  const sessionsDir = path.join(home, "sessions");
  return {
    home,
    sessionsDir,
    indexDbPath: path.join(sessionsDir, "index.sqlite"),
    indexJsonPath: path.join(sessionsDir, "index.json"),
    sessionDir: sessionId ? path.join(sessionsDir, sessionId) : "",
  };
}

export function isSafeSessionId(sessionId) {
  const text = String(sessionId || "");
  return /^[A-Za-z0-9._:-]+$/.test(text) && !text.includes("..");
}

function ensureIndexDb() {
  const paths = globalSessionPaths();
  if (indexDbConnections.has(paths.indexDbPath)) return indexDbConnections.get(paths.indexDbPath);
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const DatabaseSync = loadDatabaseSync({ optional: true });
  if (!DatabaseSync) {
    indexDbConnections.set(paths.indexDbPath, null);
    return null;
  }
  const db = new DatabaseSync(paths.indexDbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL DEFAULT '',
        command_cwd TEXT NOT NULL DEFAULT '',
        project_sessions_dir TEXT NOT NULL DEFAULT '',
        session_dir TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        goal TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        ended_at TEXT,
        result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT ''
      );
    `);
    const existingColumns = db.prepare("PRAGMA table_info(sessions)").all();
    if (!existingColumns.some((column) => column.name === "command_cwd")) {
      try {
        db.exec("ALTER TABLE sessions ADD COLUMN command_cwd TEXT NOT NULL DEFAULT ''");
      } catch (error) {
        const migratedColumns = db.prepare("PRAGMA table_info(sessions)").all();
        if (!migratedColumns.some((column) => column.name === "command_cwd")) throw error;
      }
    }

    const connection = {
      db,
      upsert: db.prepare(
        `INSERT INTO sessions (
           session_id, project_root, command_cwd, project_sessions_dir, session_dir,
           provider, model, goal, title, status, created_at, updated_at, ended_at, result, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           project_root = CASE WHEN excluded.project_root != '' THEN excluded.project_root ELSE sessions.project_root END,
           command_cwd = CASE WHEN excluded.command_cwd != '' THEN excluded.command_cwd ELSE sessions.command_cwd END,
           project_sessions_dir = CASE WHEN excluded.project_sessions_dir != '' THEN excluded.project_sessions_dir ELSE sessions.project_sessions_dir END,
           session_dir = CASE WHEN excluded.session_dir != '' THEN excluded.session_dir ELSE sessions.session_dir END,
           provider = CASE WHEN excluded.provider != '' THEN excluded.provider ELSE sessions.provider END,
           model = CASE WHEN excluded.model != '' THEN excluded.model ELSE sessions.model END,
           goal = CASE WHEN excluded.goal != '' THEN excluded.goal ELSE sessions.goal END,
           title = CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
           status = CASE WHEN excluded.status != '' THEN excluded.status ELSE sessions.status END,
           updated_at = excluded.updated_at,
           ended_at = excluded.ended_at,
           result = CASE WHEN excluded.result != '' THEN excluded.result ELSE sessions.result END,
           error = CASE WHEN excluded.error != '' THEN excluded.error ELSE sessions.error END`
      ),
      rename: db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?"),
      remove: db.prepare("DELETE FROM sessions WHERE session_id = ?"),
      listAll: db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC LIMIT ?`),
      listByProjectRoot: db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE project_root = ? ORDER BY updated_at DESC LIMIT ?`
      ),
      listByCommandCwd: db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE command_cwd = ? ORDER BY updated_at DESC LIMIT ?`
      ),
      listByProjectAndCwd: db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE project_root = ? AND command_cwd = ? ORDER BY updated_at DESC LIMIT ?`
      ),
    };
    indexDbConnections.set(paths.indexDbPath, connection);
    return connection;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the initialization error.
    }
    throw error;
  }
}

export function sessionIndexConnectionCount() {
  return [...indexDbConnections.values()].filter(Boolean).length;
}

export function closeSessionIndexConnections() {
  for (const connection of indexDbConnections.values()) {
    try {
      connection?.db.close();
    } catch {
      // Closing is best effort during tests and process shutdown.
    }
  }
  indexDbConnections.clear();
}

function emptyIndexState() {
  return {
    sessions: {},
  };
}

function readIndexJson() {
  const paths = globalSessionPaths();
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.indexJsonPath, "utf8"));
    return {
      ...emptyIndexState(),
      ...parsed,
      sessions: parsed && typeof parsed.sessions === "object" && parsed.sessions ? parsed.sessions : {},
    };
  } catch {
    return emptyIndexState();
  }
}

function writeIndexJson(state) {
  const paths = globalSessionPaths();
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const tmpPath = `${paths.indexJsonPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmpPath, paths.indexJsonPath);
}

function normalizeIndexRecord(record = {}, sessionId = "") {
  const now = new Date().toISOString();
  const paths = globalSessionPaths(sessionId);
  const createdAt = record.createdAt || record.startedAt || record.created_at || now;
  const updatedAt = record.updatedAt || record.updated_at || createdAt || now;
  return {
    sessionId,
    projectRoot: String(record.projectRoot || record.project_root || ""),
    commandCwd: String(record.commandCwd || record.command_cwd || record.projectRoot || record.project_root || ""),
    projectSessionsDir: String(record.projectSessionsDir || record.project_sessions_dir || ""),
    sessionDir: String(record.sessionDir || record.session_dir || paths.sessionDir),
    provider: String(record.provider || ""),
    model: String(record.model || ""),
    goal: String(record.goal || ""),
    title: String(record.title || ""),
    status: String(record.status || ""),
    createdAt,
    updatedAt,
    endedAt: record.endedAt || record.ended_at || null,
    result: String(record.result || ""),
    error: String(record.error || ""),
  };
}

export function upsertSessionIndex(record = {}) {
  const sessionId = String(record.sessionId || record.session_id || "").trim();
  if (!isSafeSessionId(sessionId)) return false;
  const index = ensureIndexDb();
  const normalized = normalizeIndexRecord(record, sessionId);
  if (!index) {
    const state = readIndexJson();
    const previous = state.sessions[sessionId] || {};
    state.sessions[sessionId] = {
      ...previous,
      ...normalized,
      projectRoot: normalized.projectRoot || previous.projectRoot || "",
      commandCwd: normalized.commandCwd || previous.commandCwd || "",
      projectSessionsDir: normalized.projectSessionsDir || previous.projectSessionsDir || "",
      sessionDir: normalized.sessionDir || previous.sessionDir || globalSessionPaths(sessionId).sessionDir,
      provider: normalized.provider || previous.provider || "",
      model: normalized.model || previous.model || "",
      goal: normalized.goal || previous.goal || "",
      title: normalized.title || previous.title || "",
      status: normalized.status || previous.status || "",
      result: normalized.result || previous.result || "",
      error: normalized.error || previous.error || "",
    };
    writeIndexJson(state);
    return true;
  }
  const paths = globalSessionPaths(sessionId);
  index.upsert.run(
    sessionId,
    normalized.projectRoot,
    normalized.commandCwd,
    normalized.projectSessionsDir,
    normalized.sessionDir || paths.sessionDir,
    normalized.provider,
    normalized.model,
    normalized.goal,
    normalized.title,
    normalized.status,
    normalized.createdAt,
    normalized.updatedAt,
    normalized.endedAt,
    normalized.result,
    normalized.error
  );
  return true;
}

export function renameSessionIndex(sessionId, title) {
  if (!isSafeSessionId(sessionId)) return false;
  const index = ensureIndexDb();
  if (!index) {
    const state = readIndexJson();
    if (!state.sessions[sessionId]) return false;
    state.sessions[sessionId].title = String(title || "").trim();
    state.sessions[sessionId].updatedAt = new Date().toISOString();
    writeIndexJson(state);
    return true;
  }
  const result = index.rename.run(String(title || "").trim(), new Date().toISOString(), sessionId);
  return result.changes > 0;
}

export function deleteSessionIndex(sessionId) {
  if (!isSafeSessionId(sessionId)) return false;
  const index = ensureIndexDb();
  if (!index) {
    const state = readIndexJson();
    if (!state.sessions[sessionId]) return false;
    delete state.sessions[sessionId];
    writeIndexJson(state);
    return true;
  }
  const result = index.remove.run(sessionId);
  return result.changes > 0;
}

export function listSessionIndex({ projectRoot = "", commandCwd = "", limit = 100 } = {}) {
  const index = ensureIndexDb();
  const maxRows = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  if (!index) {
    const resolvedProjectRoot = projectRoot ? path.resolve(projectRoot) : "";
    const resolvedCommandCwd = commandCwd ? path.resolve(commandCwd) : "";
    return Object.values(readIndexJson().sessions)
      .filter((session) => {
        if (resolvedProjectRoot && session.projectRoot !== resolvedProjectRoot) return false;
        if (resolvedCommandCwd && session.commandCwd !== resolvedCommandCwd) return false;
        return true;
      })
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
      .slice(0, maxRows);
  }
  const resolvedProjectRoot = projectRoot ? path.resolve(projectRoot) : "";
  const resolvedCommandCwd = commandCwd ? path.resolve(commandCwd) : "";
  if (resolvedProjectRoot && resolvedCommandCwd) {
    return index.listByProjectAndCwd.all(resolvedProjectRoot, resolvedCommandCwd, maxRows);
  }
  if (resolvedProjectRoot) return index.listByProjectRoot.all(resolvedProjectRoot, maxRows);
  if (resolvedCommandCwd) return index.listByCommandCwd.all(resolvedCommandCwd, maxRows);
  return index.listAll.all(maxRows);
}
