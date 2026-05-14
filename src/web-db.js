import fs from "node:fs";
import path from "node:path";
import { getModelPresets, getModelRoleDefaults } from "./model-routing.js";
import { resolveLanguage } from "./i18n.js";
import { projectPaths } from "./project.js";
import { deleteSessionIndex, renameSessionIndex, upsertSessionIndex } from "./session-index.js";
import { loadDatabaseSync } from "./sqlite.js";
import { permissionModeDefaults } from "./permission-modes.js";

const PREFERENCES_SCHEMA_VERSION = 8;

function jsonStatePath(dbPath) {
  return dbPath.replace(/\.sqlite$/i, ".json");
}

function emptyJsonState() {
  return {
    preferences: {},
    sessions: {},
  };
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      ...emptyJsonState(),
      ...parsed,
      preferences: parsed && typeof parsed.preferences === "object" && parsed.preferences ? parsed.preferences : {},
      sessions: parsed && typeof parsed.sessions === "object" && parsed.sessions ? parsed.sessions : {},
    };
  } catch {
    return emptyJsonState();
  }
}

function writeJsonFile(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function defaultPreferences(baseDir) {
  const presets = getModelPresets();
  const roles = getModelRoleDefaults();
  const permissions = permissionModeDefaults("normal");
  return {
    preferencesSchemaVersion: PREFERENCES_SCHEMA_VERSION,
    routingMode: "smart",
    provider: "deepseek",
    model: presets.fast.model,
    routeProvider: roles.route.provider,
    routeModel: roles.route.model,
    mainProvider: roles.main.provider,
    mainModel: roles.main.model,
    spareProvider: roles.spare.provider,
    spareModel: roles.spare.model,
    spareReasoning: roles.spare.reasoning,
    wrapperModel: roles.wrapper.model,
    wrapperReasoning: roles.wrapper.reasoning,
    auxiliaryProvider: roles.auxiliary.provider,
    auxiliaryModel: roles.auxiliary.model,
    headless: true,
    maxSteps: 24,
    startUrl: "",
    allowedDomains: "",
    commandCwd: path.resolve(baseDir),
    allowShellTool: true,
    allowFileTools: true,
    allowAuxiliaryTools: true,
    allowWebSearch: true,
    allowParallelScouts: true,
    parallelScoutCount: 3,
    allowWrapperTools: false,
    preferredWrapper: "codex",
    wrapperTimeoutMs: 120000,
    permissionMode: permissions.permissionMode,
    sandboxMode: permissions.sandboxMode,
    packageInstallPolicy: permissions.packageInstallPolicy,
    workspaceWritePolicy: permissions.workspaceWritePolicy,
    useDockerSandbox: permissions.useDockerSandbox,
    dockerSandboxImage: "agintiflow-sandbox:latest",
    allowPasswords: permissions.allowPasswords,
    allowDestructive: permissions.allowDestructive,
    allowOutsideWorkspaceFileTools: permissions.allowOutsideWorkspaceFileTools,
    language: resolveLanguage(process.env.AGINTI_LANGUAGE || ""),
    taskProfile: "auto",
  };
}

export class WebDatabase {
  constructor(baseDir) {
    this.baseDir = path.resolve(baseDir);
    this.paths = projectPaths(this.baseDir);
    this.dbDir = this.paths.sessionsDir;
    this.dbPath = this.paths.sessionDbPath;
    this.jsonPath = jsonStatePath(this.dbPath);
    fs.mkdirSync(this.dbDir, { recursive: true });
    const DatabaseSync = loadDatabaseSync({ optional: true });
    this.driver = DatabaseSync ? "sqlite" : "json";
    this.db = DatabaseSync ? new DatabaseSync(this.dbPath) : null;
    if (this.db) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS preferences (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          ended_at TEXT,
          result TEXT,
          error TEXT
        );
      `);
    } else if (!fs.existsSync(this.jsonPath)) {
      writeJsonFile(this.jsonPath, emptyJsonState());
    }
    this.migrate();
  }

  migrate() {
    if (!this.db) return;
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all();
    if (!sessionColumns.some((column) => column.name === "title")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    }
    if (!sessionColumns.some((column) => column.name === "project_root")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN project_root TEXT NOT NULL DEFAULT ''");
    }
    if (!sessionColumns.some((column) => column.name === "command_cwd")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN command_cwd TEXT NOT NULL DEFAULT ''");
    }
    if (!sessionColumns.some((column) => column.name === "project_sessions_dir")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN project_sessions_dir TEXT NOT NULL DEFAULT ''");
    }
    if (!sessionColumns.some((column) => column.name === "session_dir")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN session_dir TEXT NOT NULL DEFAULT ''");
    }
  }

  readJsonState() {
    return readJsonFile(this.jsonPath);
  }

  writeJsonState(state) {
    writeJsonFile(this.jsonPath, state);
  }

  getPreferences() {
    if (!this.db) {
      const raw = this.readJsonState().preferences.ui;
      if (!raw) return defaultPreferences(this.baseDir);
      return this.normalizePreferences(raw);
    }
    const row = this.db.prepare("SELECT value FROM preferences WHERE key = ?").get("ui");
    if (!row) return defaultPreferences(this.baseDir);

    return this.normalizePreferences(row.value);
  }

  normalizePreferences(value) {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      const preferences = {
        ...defaultPreferences(this.baseDir),
        ...parsed,
      };
      if ((parsed.preferencesSchemaVersion || 1) < PREFERENCES_SCHEMA_VERSION) {
        preferences.preferencesSchemaVersion = PREFERENCES_SCHEMA_VERSION;
        if (!parsed.commandCwd || parsed.commandCwd === path.resolve(this.baseDir, "..")) {
          preferences.commandCwd = path.resolve(this.baseDir);
        }
        if (["host", "docker-readonly"].includes(parsed.sandboxMode || "")) {
          preferences.sandboxMode = "docker-workspace";
          preferences.useDockerSandbox = true;
        }
        if ((parsed.packageInstallPolicy || "") !== "allow") {
          preferences.packageInstallPolicy = "allow";
        }
        if (!Number.isFinite(Number(parsed.maxSteps)) || Number(parsed.maxSteps) < 24) {
          preferences.maxSteps = 24;
        }
        if ((parsed.preferencesSchemaVersion || 1) < 5) {
          preferences.taskProfile = "auto";
        }
        if ((parsed.preferencesSchemaVersion || 1) < 6) {
          preferences.allowWebSearch = true;
          preferences.allowParallelScouts = true;
          preferences.parallelScoutCount = 3;
        }
        if ((parsed.preferencesSchemaVersion || 1) < 7) {
          const roles = getModelRoleDefaults();
          preferences.routeProvider = preferences.routeProvider || roles.route.provider;
          preferences.routeModel = preferences.routeModel || roles.route.model;
          preferences.mainProvider = preferences.mainProvider || roles.main.provider;
          preferences.mainModel = preferences.mainModel || roles.main.model;
          preferences.spareProvider = preferences.spareProvider || roles.spare.provider;
          preferences.spareModel = preferences.spareModel || roles.spare.model;
          preferences.spareReasoning = preferences.spareReasoning || roles.spare.reasoning;
          preferences.wrapperModel = preferences.wrapperModel || roles.wrapper.model;
          preferences.wrapperReasoning = preferences.wrapperReasoning || roles.wrapper.reasoning;
          preferences.auxiliaryProvider = preferences.auxiliaryProvider || roles.auxiliary.provider;
          preferences.auxiliaryModel = preferences.auxiliaryModel || roles.auxiliary.model;
        }
        if ((parsed.preferencesSchemaVersion || 1) < 8) {
          const permissions = permissionModeDefaults(preferences.permissionMode || "normal");
          preferences.permissionMode = permissions.permissionMode;
          preferences.sandboxMode = permissions.sandboxMode;
          preferences.packageInstallPolicy = permissions.packageInstallPolicy;
          preferences.workspaceWritePolicy = permissions.workspaceWritePolicy;
          preferences.useDockerSandbox = permissions.useDockerSandbox;
          preferences.allowPasswords = permissions.allowPasswords;
          preferences.allowDestructive = permissions.allowDestructive;
          preferences.allowOutsideWorkspaceFileTools = permissions.allowOutsideWorkspaceFileTools;
        }
        this.savePreferences(preferences);
      }
      return preferences;
    } catch {
      return defaultPreferences(this.baseDir);
    }
  }

  savePreferences(preferences) {
    const value = JSON.stringify(preferences);
    const updatedAt = new Date().toISOString();
    if (!this.db) {
      const state = this.readJsonState();
      state.preferences.ui = value;
      state.preferences.uiUpdatedAt = updatedAt;
      this.writeJsonState(state);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO preferences (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run("ui", value, updatedAt);
  }

  upsertSession(session) {
    const updatedAt = session.updatedAt || new Date().toISOString();
    const projectRoot = session.projectRoot || this.baseDir;
    const commandCwd = session.commandCwd || projectRoot;
    const projectSessionsDir = session.projectSessionsDir || this.paths.sessionsDir;
    const sessionDir = session.sessionDir || path.join(this.paths.globalSessionsDir, session.sessionId);
    const record = {
      sessionId: session.sessionId,
      projectRoot,
      commandCwd,
      projectSessionsDir,
      sessionDir,
      provider: session.provider,
      model: session.model,
      goal: session.goal,
      title: session.title || "",
      status: session.status,
      startedAt: session.startedAt,
      updatedAt,
      endedAt: session.endedAt || null,
      result: session.result || "",
      error: session.error || "",
    };
    if (!this.db) {
      const state = this.readJsonState();
      const previous = state.sessions[session.sessionId] || {};
      state.sessions[session.sessionId] = {
        ...previous,
        ...record,
        title: record.title || previous.title || "",
      };
      this.writeJsonState(state);
      this.syncSessionIndex(record);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO sessions (
          session_id, project_root, command_cwd, project_sessions_dir, session_dir,
          provider, model, goal, title, status, started_at, updated_at, ended_at, result, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          project_root = excluded.project_root,
          command_cwd = excluded.command_cwd,
          project_sessions_dir = excluded.project_sessions_dir,
          session_dir = excluded.session_dir,
          provider = excluded.provider,
          model = excluded.model,
          goal = excluded.goal,
          title = CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
          status = excluded.status,
          updated_at = excluded.updated_at,
          ended_at = excluded.ended_at,
          result = excluded.result,
          error = excluded.error`
      )
      .run(
        session.sessionId,
        projectRoot,
        commandCwd,
        projectSessionsDir,
        sessionDir,
        session.provider,
        session.model,
        session.goal,
        session.title || "",
        session.status,
        session.startedAt,
        updatedAt,
        session.endedAt || null,
        session.result || "",
        session.error || ""
      );
    this.syncSessionIndex(record);
  }

  syncSessionIndex(record) {
    try {
      upsertSessionIndex({
        ...record,
        createdAt: record.startedAt,
      });
    } catch {
      // The project-local database remains the fallback if the global index cannot be updated.
    }
  }

  getSession(sessionId) {
    if (!this.db) {
      return this.readJsonState().sessions[sessionId] || null;
    }
    return (
      this.db
        .prepare(
          `SELECT
             session_id AS sessionId,
             project_root AS projectRoot,
             command_cwd AS commandCwd,
             project_sessions_dir AS projectSessionsDir,
             session_dir AS sessionDir,
             provider,
             model,
             goal,
             title,
             status,
             started_at AS startedAt,
             updated_at AS updatedAt,
             ended_at AS endedAt,
             result,
             error
           FROM sessions
           WHERE session_id = ?`
        )
        .get(sessionId) || null
    );
  }

  listSessions(limit = 20) {
    if (!this.db) {
      const maxRows = Math.min(Math.max(Number(limit) || 20, 1), 1000);
      return Object.values(this.readJsonState().sessions)
        .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
        .slice(0, maxRows);
    }
    return this.db
      .prepare(
        `SELECT
           session_id AS sessionId,
           project_root AS projectRoot,
           command_cwd AS commandCwd,
           project_sessions_dir AS projectSessionsDir,
           session_dir AS sessionDir,
           provider,
           model,
           goal,
           title,
           status,
           started_at AS startedAt,
           updated_at AS updatedAt,
           ended_at AS endedAt,
           result,
           error
         FROM sessions
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(limit);
  }

  renameSession(sessionId, title) {
    const updatedAt = new Date().toISOString();
    if (!this.db) {
      const state = this.readJsonState();
      if (!state.sessions[sessionId]) return false;
      state.sessions[sessionId].title = title;
      state.sessions[sessionId].updatedAt = updatedAt;
      this.writeJsonState(state);
      try {
        renameSessionIndex(sessionId, title);
      } catch {
        // Keep the project-local JSON store as the source of truth.
      }
      return true;
    }
    const result = this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?")
      .run(title, updatedAt, sessionId);
    if (result.changes > 0) renameSessionIndex(sessionId, title);
    return result.changes > 0;
  }

  deleteSession(sessionId) {
    if (!this.db) {
      const state = this.readJsonState();
      if (!state.sessions[sessionId]) return false;
      delete state.sessions[sessionId];
      this.writeJsonState(state);
      try {
        deleteSessionIndex(sessionId);
      } catch {
        // Keep the project-local JSON store as the source of truth.
      }
      return true;
    }
    const result = this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    if (result.changes > 0) deleteSessionIndex(sessionId);
    return result.changes > 0;
  }
}
