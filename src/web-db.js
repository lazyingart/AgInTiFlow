import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getModelPresets } from "./model-routing.js";

function defaultPreferences(baseDir) {
  const presets = getModelPresets();
  return {
    routingMode: "smart",
    provider: "deepseek",
    model: presets.fast.model,
    headless: true,
    maxSteps: 15,
    startUrl: "",
    allowedDomains: "",
    commandCwd: path.resolve(baseDir, ".."),
    allowShellTool: true,
    allowFileTools: true,
    allowWrapperTools: false,
    wrapperTimeoutMs: 120000,
    sandboxMode: "docker-readonly",
    packageInstallPolicy: "prompt",
    useDockerSandbox: true,
    dockerSandboxImage: "agintiflow-sandbox:latest",
    allowPasswords: false,
    allowDestructive: false,
    language: "en",
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
  }

  getPreferences() {
    const row = this.db.prepare("SELECT value FROM preferences WHERE key = ?").get("ui");
    if (!row) return defaultPreferences(this.baseDir);

    try {
      return {
        ...defaultPreferences(this.baseDir),
        ...JSON.parse(row.value),
      };
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
          session_id, provider, model, goal, status, started_at, updated_at, ended_at, result, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          goal = excluded.goal,
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
}
