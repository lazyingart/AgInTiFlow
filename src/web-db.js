import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getModelPresets } from "./model-routing.js";

const PREFERENCES_SCHEMA_VERSION = 6;

function defaultPreferences(baseDir) {
  const presets = getModelPresets();
  return {
    preferencesSchemaVersion: PREFERENCES_SCHEMA_VERSION,
    routingMode: "smart",
    provider: "deepseek",
    model: presets.fast.model,
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
    language: "en",
    taskProfile: "auto",
  };
}

export class WebDatabase {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.dbDir = path.join(baseDir, ".sessions");
    this.dbPath = path.join(this.dbDir, "web-state.sqlite");
    fs.mkdirSync(this.dbDir, { recursive: true });
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
    this.db
      .prepare(
        `INSERT INTO sessions (
          session_id, provider, model, goal, title, status, started_at, updated_at, ended_at, result, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
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
  }

  getSession(sessionId) {
    return (
      this.db
        .prepare(
          `SELECT
             session_id AS sessionId,
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
    return result.changes > 0;
  }

  deleteSession(sessionId) {
    const result = this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    return result.changes > 0;
  }
}
