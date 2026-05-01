import fs from "node:fs/promises";
import path from "node:path";

export class SessionStore {
  constructor(baseDir, sessionId) {
    this.baseDir = baseDir;
    this.sessionId = sessionId;
    this.sessionDir = path.join(baseDir, sessionId);
    this.artifactsDir = path.join(this.sessionDir, "artifacts");
    this.statePath = path.join(this.sessionDir, "state.json");
    this.planPath = path.join(this.sessionDir, "plan.md");
    this.eventsPath = path.join(this.sessionDir, "events.jsonl");
    this.storageStatePath = path.join(this.sessionDir, "storage-state.json");
  }

  async ensure() {
    await fs.mkdir(this.artifactsDir, { recursive: true });
  }

  async loadState() {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async saveState(state) {
    await this.ensure();
    await fs.writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async savePlan(planText) {
    await this.ensure();
    await fs.writeFile(this.planPath, `${planText.trim()}\n`, "utf8");
  }

  async appendEvent(type, data = {}) {
    await this.ensure();
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      type,
      data,
    });
    await fs.appendFile(this.eventsPath, `${line}\n`, "utf8");
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
      return [];
    }
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
  }
}
