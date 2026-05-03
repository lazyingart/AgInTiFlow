import fs from "node:fs";
import path from "node:path";
import { getModelPresets, getModelRoleDefaults } from "./model-routing.js";
import { resolveLanguage } from "./i18n.js";
import { projectPaths } from "./project.js";
import { deleteSessionIndex, renameSessionIndex, upsertSessionIndex } from "./session-index.js";
import { loadDatabaseSync } from "./sqlite.js";

const PREFERENCES_SCHEMA_VERSION = 7;

function defaultPreferences(baseDir) {
  const presets = getModelPresets();
  const roles = getModelRoleDefaults();
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
    sandboxMode: "docker-workspace",
    packageInstallPolicy: "allow",
    useDockerSandbox: true,
    dockerSandboxImage: "agintiflow-sandbox:latest",
    allowPasswords: false,
    allowDestructive: false,
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
    fs.mkdirSync(this.dbDir, { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(this.dbPath);
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
    this.migrate();
  }

  migrate() {
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

  getPreferences() {
    const row = this.db.prepare("SELECT value FROM preferences WHERE key = ?").get("ui");
    if (!row) return defaultPreferences(this.baseDir);

    try {
      const parsed = JSON.parse(row.value);
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
    try {
      upsertSessionIndex({
        ...session,
        projectRoot,
        commandCwd,
        projectSessionsDir,
        sessionDir,
        createdAt: session.startedAt,
        updatedAt,
      });
    } catch {
      // The project-local database remains the fallback if the global index cannot be updated.
    }
  }

  getSession(sessionId) {
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
    const result = this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?")
      .run(title, updatedAt, sessionId);
    if (result.changes > 0) renameSessionIndex(sessionId, title);
    return result.changes > 0;
  }

  deleteSession(sessionId) {
    const result = this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    if (result.changes > 0) deleteSessionIndex(sessionId);
    return result.changes > 0;
  }
}
