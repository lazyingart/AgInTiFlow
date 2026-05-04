import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { deleteSessionIndex, globalSessionPaths, isSafeSessionId, upsertSessionIndex } from "./session-index.js";
import { enqueueHousekeepingEvent } from "./housekeeping.js";

export class SessionStore {
  constructor(baseDir, sessionId, options = {}) {
    this.baseDir = path.resolve(baseDir);
    this.sessionId = sessionId;
    const globalPaths = globalSessionPaths(sessionId);
    this.projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : "";
    this.commandCwd = options.commandCwd ? path.resolve(options.commandCwd) : this.projectRoot;
    this.projectSessionsDir = options.projectSessionsDir ? path.resolve(options.projectSessionsDir) : "";
    this.legacySessionDir = options.legacySessionDir ? path.resolve(options.legacySessionDir) : "";
    this.sessionDir = path.resolve(options.sessionDir || (baseDir ? path.join(this.baseDir, sessionId) : globalPaths.sessionDir));
    this.artifactsDir = path.join(this.sessionDir, "artifacts");
    this.statePath = path.join(this.sessionDir, "state.json");
    this.planPath = path.join(this.sessionDir, "plan.md");
    this.eventsPath = path.join(this.sessionDir, "events.jsonl");
    this.inboxPath = path.join(this.sessionDir, "inbox.jsonl");
    this.storageStatePath = path.join(this.sessionDir, "storage-state.json");
    this.pointerDir = this.projectSessionsDir && isSafeSessionId(sessionId) ? path.join(this.projectSessionsDir, sessionId) : "";
    this.pointerPath = this.pointerDir ? path.join(this.pointerDir, "session.json") : "";
  }

  async ensure() {
    await fs.mkdir(this.artifactsDir, { recursive: true });
    await this.writePointer().catch(() => {});
  }

  async writePointer(state = {}) {
    if (!this.pointerPath) return;
    await fs.mkdir(this.pointerDir, { recursive: true });
    const existing = await fs.readFile(this.pointerPath, "utf8").then(JSON.parse).catch(() => ({}));
    const now = new Date().toISOString();
    const payload = {
      sessionId: this.sessionId,
      projectRoot: this.projectRoot,
      commandCwd: state.commandCwd || existing.commandCwd || this.projectRoot,
      sessionDir: this.sessionDir,
      artifactsDir: this.artifactsDir,
      createdAt: state.createdAt || state.startedAt || existing.createdAt || now,
      updatedAt: state.updatedAt || existing.updatedAt || now,
      title: state.title || existing.title || "",
      goal: state.goal || existing.goal || "",
      provider: state.provider || existing.provider || "",
      model: state.model || existing.model || "",
    };
    await fs.writeFile(this.pointerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  async loadState() {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      return JSON.parse(raw);
    } catch {
      if (this.legacySessionDir) {
        try {
          const raw = await fs.readFile(path.join(this.legacySessionDir, "state.json"), "utf8");
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  async saveState(state) {
    await this.ensure();
    await fs.writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await this.writePointer(state).catch(() => {});
    try {
      upsertSessionIndex({
        ...state,
        sessionId: this.sessionId,
        projectRoot: this.projectRoot,
        projectSessionsDir: this.projectSessionsDir,
        sessionDir: this.sessionDir,
        status: state.status || "saved",
      });
    } catch {
      // Session state remains durable even if the optional global index is unavailable.
    }
  }

  async savePlan(planText) {
    await this.ensure();
    await fs.writeFile(this.planPath, `${planText.trim()}\n`, "utf8");
  }

  async saveJsonArtifact(filename, data) {
    await this.ensure();
    const safeName = path.basename(String(filename || "artifact.json"));
    const outputName = safeName.endsWith(".json") ? safeName : `${safeName}.json`;
    const filePath = path.join(this.artifactsDir, outputName);
    await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return filePath;
  }

  async appendEvent(type, data = {}) {
    await this.ensure();
    const event = {
      timestamp: new Date().toISOString(),
      type,
      data,
    };
    const line = JSON.stringify(event);
    await fs.appendFile(this.eventsPath, `${line}\n`, "utf8");
    enqueueHousekeepingEvent({
      sessionId: this.sessionId,
      projectRoot: this.projectRoot,
      commandCwd: this.commandCwd,
      event,
    });
  }

  async loadEvents() {
    try {
      const raw = await fs.readFile(this.eventsPath, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      if (this.legacySessionDir) {
        try {
          const raw = await fs.readFile(path.join(this.legacySessionDir, "events.jsonl"), "utf8");
          return raw
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        } catch {
          return [];
        }
      }
      return [];
    }
  }

  async appendInbox(content, metadata = {}) {
    await this.ensure();
    const text = String(content || "").trim();
    if (!text) return null;
    const item = {
      id: metadata.id || `inbox-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      content: text,
      priority: metadata.priority || "normal",
      ...metadata,
    };
    const line = JSON.stringify(item);
    await fs.appendFile(this.inboxPath, `${line}\n`, "utf8");
    return item;
  }

  async loadInbox() {
    await this.ensure();
    let raw = "";
    try {
      raw = await fs.readFile(this.inboxPath, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async saveInbox(items = []) {
    await this.ensure();
    const lines = items.filter(Boolean).map((item) => JSON.stringify(item));
    await fs.writeFile(this.inboxPath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  }

  async drainInbox() {
    await this.ensure();
    const items = await this.loadInbox();
    await fs.writeFile(this.inboxPath, "", "utf8");
    return items.sort((a, b) => {
      const priority = (item) => (item.priority === "asap" ? 0 : 1);
      return priority(a) - priority(b) || String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
    });
  }

  async saveSnapshot(step, snapshot) {
    await this.ensure();
    const filename = `step-${String(step).padStart(3, "0")}.snapshot.json`;
    const filePath = path.join(this.artifactsDir, filename);
    await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return filePath;
  }

  screenshotPath(step) {
    return path.join(this.artifactsDir, `step-${String(step).padStart(3, "0")}.png`);
  }

  async remove() {
    await fs.rm(this.sessionDir, { recursive: true, force: true });
    if (this.pointerDir) await fs.rm(this.pointerDir, { recursive: true, force: true }).catch(() => {});
    deleteSessionIndex(this.sessionId);
  }
}
