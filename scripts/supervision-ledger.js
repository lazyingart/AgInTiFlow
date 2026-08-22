#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadDatabaseSync } from "../src/sqlite.js";

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2).replace(/-/g, "_");
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function required(options, key) {
  const value = String(options[key] || "").trim();
  if (!value) throw new Error(`Missing required option --${key.replace(/_/g, "-")}`);
  return value;
}

function jsonValue(value, fallback = []) {
  if (value === undefined || value === null || value === "") return JSON.stringify(fallback);
  return JSON.stringify(JSON.parse(String(value)));
}

function assertCampaignReference(db, table, id, campaignId, label) {
  if (!id) return;
  const row = db.prepare(`SELECT id FROM ${table} WHERE id=? AND campaign_id=?`).get(id, campaignId);
  if (!row) throw new Error(`Unknown ${label} for campaign ${campaignId}: ${id}`);
}

function runTransaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function openLedger(dbPath) {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, aginti_version TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS capabilities (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      domain TEXT NOT NULL, subdomain TEXT NOT NULL DEFAULT '', description TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 50, status TEXT NOT NULL DEFAULT 'untested',
      last_test_id TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      domain TEXT NOT NULL, subdomain TEXT NOT NULL DEFAULT '', profile TEXT NOT NULL DEFAULT 'auto',
      prompt_quality TEXT NOT NULL DEFAULT 'normal', user_prompt TEXT NOT NULL,
      expected_outputs_json TEXT NOT NULL DEFAULT '[]', validation_plan TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS test_items (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      capability_id TEXT NOT NULL DEFAULT '', scenario_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
      profile TEXT NOT NULL DEFAULT 'auto', prompt_quality TEXT NOT NULL DEFAULT 'normal',
      prompt_path TEXT NOT NULL DEFAULT '', expected_outputs_json TEXT NOT NULL DEFAULT '[]',
      validation_plan TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      aginti_version TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
      tmux_session TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '', result_summary TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, test_id TEXT NOT NULL REFERENCES test_items(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, evidence_path TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS fixes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, test_id TEXT NOT NULL REFERENCES test_items(id) ON DELETE CASCADE,
      repo TEXT NOT NULL, commit_hash TEXT NOT NULL DEFAULT '', release_version TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL, files_json TEXT NOT NULL DEFAULT '[]', validation_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'implemented', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capabilities_campaign_status ON capabilities(campaign_id, status, priority);
    CREATE INDEX IF NOT EXISTS idx_scenarios_campaign_status ON scenarios(campaign_id, status);
    CREATE INDEX IF NOT EXISTS idx_tests_campaign_status ON test_items(campaign_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_events_test_time ON events(test_id, occurred_at);
  `);
  return { db, resolved };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const dbPath = String(options.db || process.env.AGINTI_SUPERVISION_LEDGER || "supervision/campaign.sqlite");
  const campaignId = String(options.campaign || process.env.AGINTI_SUPERVISION_CAMPAIGN || "general-capability");
  const { db, resolved } = openLedger(dbPath);
  const timestamp = new Date().toISOString();
  let result;

  if (command === "init") {
    db.prepare(`INSERT INTO campaigns (id, objective, status, started_at, updated_at, aginti_version)
      VALUES (?, ?, 'active', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      objective=excluded.objective, status='active', updated_at=excluded.updated_at,
      aginti_version=excluded.aginti_version`).run(
      campaignId, required(options, "objective"), timestamp, timestamp, String(options.aginti_version || "")
    );
    result = { campaign: campaignId, status: "active" };
  } else if (command === "capability") {
    const id = required(options, "id");
    db.prepare(`INSERT INTO capabilities
      (id, campaign_id, domain, subdomain, description, priority, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      domain=excluded.domain, subdomain=excluded.subdomain, description=excluded.description,
      priority=excluded.priority, status=excluded.status, updated_at=excluded.updated_at`).run(
      id, campaignId, required(options, "domain"), String(options.subdomain || ""),
      required(options, "description"), Number(options.priority || 50),
      String(options.status || "untested"), timestamp
    );
    result = { capability: id };
  } else if (command === "scenario") {
    const id = required(options, "id");
    db.prepare(`INSERT INTO scenarios
      (id, campaign_id, domain, subdomain, profile, prompt_quality, user_prompt,
       expected_outputs_json, validation_plan, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      domain=excluded.domain, subdomain=excluded.subdomain, profile=excluded.profile,
      prompt_quality=excluded.prompt_quality, user_prompt=excluded.user_prompt,
      expected_outputs_json=excluded.expected_outputs_json, validation_plan=excluded.validation_plan,
      status=excluded.status, updated_at=excluded.updated_at`).run(
      id, campaignId, required(options, "domain"), String(options.subdomain || ""),
      String(options.profile || "auto"), String(options.prompt_quality || "normal"),
      required(options, "prompt"), jsonValue(options.expected_outputs), required(options, "validation"),
      String(options.status || "backlog"), timestamp
    );
    result = { scenario: id };
  } else if (command === "test") {
    const id = required(options, "id");
    const capabilityId = String(options.capability || "");
    const scenarioId = String(options.scenario || "");
    assertCampaignReference(db, "capabilities", capabilityId, campaignId, "capability");
    assertCampaignReference(db, "scenarios", scenarioId, campaignId, "scenario");
    db.prepare(`INSERT INTO test_items
      (id, campaign_id, capability_id, scenario_id, title, profile, prompt_quality,
       prompt_path, expected_outputs_json, validation_plan, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      capability_id=excluded.capability_id, scenario_id=excluded.scenario_id,
      title=excluded.title, profile=excluded.profile, prompt_quality=excluded.prompt_quality,
      prompt_path=excluded.prompt_path, expected_outputs_json=excluded.expected_outputs_json,
      validation_plan=excluded.validation_plan, updated_at=excluded.updated_at`).run(
      id, campaignId, capabilityId, scenarioId,
      required(options, "title"), String(options.profile || "auto"),
      String(options.prompt_quality || "normal"), String(options.prompt_path || ""),
      jsonValue(options.expected_outputs), String(options.validation || ""),
      String(options.status || "pending"), timestamp
    );
    result = { test: id };
  } else if (command === "start") {
    const id = required(options, "id");
    const changed = db.prepare(`UPDATE test_items SET status='running', aginti_version=?, session_id=?,
      tmux_session=?, started_at=CASE WHEN started_at='' THEN ? ELSE started_at END, updated_at=?
      WHERE id=? AND campaign_id=?`).run(
      String(options.aginti_version || ""), String(options.session || ""), String(options.tmux || ""),
      timestamp, timestamp, id, campaignId
    );
    if (Number(changed.changes || 0) !== 1) throw new Error(`Unknown test item: ${id}`);
    result = { test: id, status: "running" };
  } else if (command === "event") {
    const id = required(options, "id");
    db.prepare(`INSERT INTO events (test_id, occurred_at, kind, detail, evidence_path)
      VALUES (?, ?, ?, ?, ?)`).run(
      id, timestamp, required(options, "kind"), required(options, "detail"), String(options.evidence || "")
    );
    result = { test: id, event: String(options.kind) };
  } else if (command === "finish") {
    const id = required(options, "id");
    const status = required(options, "status");
    const summary = required(options, "summary");
    const evidence = jsonValue(options.evidence);
    const item = db.prepare(
      "SELECT capability_id, scenario_id FROM test_items WHERE id=? AND campaign_id=?"
    ).get(id, campaignId);
    if (!item) throw new Error(`Unknown test item: ${id}`);
    assertCampaignReference(db, "capabilities", item.capability_id, campaignId, "capability");
    assertCampaignReference(db, "scenarios", item.scenario_id, campaignId, "scenario");
    runTransaction(db, () => {
      db.prepare(`UPDATE test_items SET status=?, result_summary=?, evidence_json=?,
        finished_at=?, updated_at=? WHERE id=? AND campaign_id=?`).run(
        status, summary, evidence, timestamp, timestamp, id, campaignId
      );
      if (item.capability_id) {
        db.prepare(`UPDATE capabilities SET status=?, last_test_id=?, updated_at=?
          WHERE id=? AND campaign_id=?`).run(status, id, timestamp, item.capability_id, campaignId);
      }
      if (item.scenario_id) {
        db.prepare("UPDATE scenarios SET status=?, updated_at=? WHERE id=? AND campaign_id=?")
          .run(status, timestamp, item.scenario_id, campaignId);
      }
    });
    result = { test: id, status };
  } else if (command === "fix") {
    const id = required(options, "id");
    db.prepare(`INSERT INTO fixes
      (test_id, repo, commit_hash, release_version, summary, files_json, validation_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, required(options, "repo"), String(options.commit || ""), String(options.release || ""),
      required(options, "summary"), jsonValue(options.files), jsonValue(options.validation),
      String(options.status || "implemented"), timestamp
    );
    result = { test: id, fix: "recorded" };
  } else if (command === "status") {
    const countRows = (table) => db.prepare(
      `SELECT status, COUNT(*) AS count FROM ${table} WHERE campaign_id=? GROUP BY status ORDER BY status`
    ).all(campaignId).map((row) => ({ ...row }));
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id=?").get(campaignId);
    result = {
      campaign: campaign ? { ...campaign } : null,
      capability_counts: countRows("capabilities"),
      scenario_counts: countRows("scenarios"),
      test_counts: countRows("test_items"),
      recent_tests: db.prepare(`SELECT id, title, status, aginti_version, session_id, tmux_session, updated_at
        FROM test_items WHERE campaign_id=? ORDER BY updated_at DESC LIMIT 20`)
        .all(campaignId).map((row) => ({ ...row })),
    };
  } else {
    throw new Error("Usage: supervision-ledger.js init|capability|scenario|test|start|event|finish|fix|status --db PATH --campaign ID ...");
  }

  db.close();
  process.stdout.write(`${JSON.stringify({ ok: true, db: resolved, ...result }, null, options.json ? 0 : 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
