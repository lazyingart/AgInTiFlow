import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { deleteSessionIndex, globalSessionPaths, isSafeSessionId, upsertSessionIndex } from "./session-index.js";
import { enqueueHousekeepingEvent } from "./housekeeping.js";
import {
  assertIntegrationSessionOperationAllowed,
  claimIntegrationSessionStore,
  loadIntegrationClaimedSessionState,
  markIntegrationStatePersisted,
  prepareIntegrationStateForSave,
  retainedIntegrationSessionStateEnabled,
  retainedIntegrationTextWorkspaceEnabled,
  invokeIntegrationTextWorkspace,
  runIntegrationSessionOperation,
  saveIntegrationClaimedSessionState,
  validateIntegrationLoadedState,
} from "./integration-session-persistence.js";

const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set(["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]);
const DEFAULT_INBOX_COMPACTION_RECORD_THRESHOLD = 128;
const DEFAULT_INBOX_COMPACTION_BYTE_THRESHOLD = 256 * 1024;
const DEFAULT_INBOX_LOCK_TIMEOUT_MS = 10_000;
const INBOX_LOCK_RETRY_MS = 10;
const INBOX_LOCK_HARD_STALE_MS = 120_000;
const INBOX_CLAIM_HARD_STALE_MS = 24 * 60 * 60 * 1000;

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function existingFileMode(filePath) {
  try {
    return (await fs.stat(filePath)).mode & 0o7777;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteFile(filePath, content) {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true });
  const mode = await existingFileMode(filePath);
  const tempPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", mode ?? 0o666);
    if (mode !== null) await handle.chmod(mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
    await syncDirectory(directoryPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function appendDurably(filePath, content) {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true });
  const existed = await fs.stat(filePath).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  const handle = await fs.open(filePath, "a", 0o666);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!existed) await syncDirectory(directoryPath);
}

async function loadStateFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const corruptionError = new Error(`Session state is not valid JSON: ${filePath}`);
    corruptionError.name = "SessionStateCorruptionError";
    corruptionError.code = "SESSION_STATE_CORRUPT";
    corruptionError.cause = error;
    throw corruptionError;
  }
}

function inboxItemKey(item = {}) {
  const id = String(item.id || "").trim();
  if (id) return `id:${id}`;
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex")}`;
}

function decodeJsonLines(raw, { allowIncompleteFinal = false } = {}) {
  const text = String(raw || "");
  const rawLines = text.split("\n");
  const values = [];
  let incompleteFinal = false;
  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index];
    const line = rawLine.trim();
    if (!line) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      const isIncompleteFinal = allowIncompleteFinal && index === rawLines.length - 1 && !text.endsWith("\n");
      if (!isIncompleteFinal) throw error;
      incompleteFinal = true;
    }
  }
  return { values, incompleteFinal, raw: text };
}

function serializeJsonLines(values = []) {
  const lines = values.filter(Boolean).map((value) => JSON.stringify(value));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function isInboxClaimLive(claim) {
  const pid = Number(claim?.pid);
  const claimedAt = Date.parse(String(claim?.claimedAt || ""));
  if (!String(claim?.consumerId || "").trim() || !Number.isInteger(pid) || pid <= 0) return false;
  if (Number.isFinite(claimedAt) && Date.now() - claimedAt >= INBOX_CLAIM_HARD_STALE_MS) return false;
  return isProcessAlive(pid);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class SessionStore {
  #integrationSessionClaim;

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
    this.inboxClaimsPath = path.join(this.sessionDir, "inbox-claims.jsonl");
    this.inboxAcknowledgementsPath = path.join(this.sessionDir, "inbox-acknowledgements.jsonl");
    this.inboxLockPath = path.join(this.sessionDir, ".inbox-mutation.lock");
    this.storageStatePath = path.join(this.sessionDir, "storage-state.json");
    this.pointerDir = this.projectSessionsDir && isSafeSessionId(sessionId) ? path.join(this.projectSessionsDir, sessionId) : "";
    this.pointerPath = this.pointerDir ? path.join(this.pointerDir, "session.json") : "";
    this.drainedInboxKeys = new Set();
    this.appliedInboxAcknowledgements = new Set();
    this.inboxConsumerId = String(options.inboxConsumerId || crypto.randomUUID());
    this.lastLoadedInboxKeys = null;
    this.inboxCompactionRecordThreshold = positiveInteger(
      options.inboxCompactionRecordThreshold,
      DEFAULT_INBOX_COMPACTION_RECORD_THRESHOLD
    );
    this.inboxCompactionByteThreshold = positiveInteger(
      options.inboxCompactionByteThreshold,
      DEFAULT_INBOX_COMPACTION_BYTE_THRESHOLD
    );
    this.inboxLockTimeoutMs = positiveInteger(options.inboxLockTimeoutMs, DEFAULT_INBOX_LOCK_TIMEOUT_MS);
    this.ensurePromise = null;
    this.eventAppendTail = Promise.resolve();
    this.#integrationSessionClaim = claimIntegrationSessionStore(this);
    if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
      for (const property of ["artifactsDir", "storageStatePath"]) {
        Object.defineProperty(this, property, {
          configurable: false,
          enumerable: false,
          get() {
            const error = new Error(
              `${property} is outside the retained text-workspace-v1 SessionStore profile.`
            );
            error.code = "INTEGRATION_TEXT_WORKSPACE_OPERATION_DENIED";
            throw error;
          },
        });
      }
    }
  }

  withIntegrationOperation(label, operation) {
    return runIntegrationSessionOperation(this.#integrationSessionClaim, label, operation);
  }

  assertIntegrationOperation(label) {
    assertIntegrationSessionOperationAllowed(this.#integrationSessionClaim, label);
  }

  ensure() {
    return this.withIntegrationOperation("ensure", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        await invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "ensure");
        return;
      }
      if (!this.ensurePromise) {
        this.ensurePromise = (async () => {
          await fs.mkdir(this.artifactsDir, { recursive: true });
          if (!this.#integrationSessionClaim) await this.writePointer().catch(() => {});
        })();
      }
      try {
        await this.ensurePromise;
      } catch (error) {
        this.ensurePromise = null;
        throw error;
      }
    });
  }

  writePointer(state = {}) {
    return this.withIntegrationOperation("writePointer", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        await invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "writePointer", [state]);
        return;
      }
      if (this.#integrationSessionClaim) return;
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
      await atomicWriteFile(this.pointerPath, `${JSON.stringify(payload, null, 2)}\n`);
    });
  }

  loadState() {
    return this.withIntegrationOperation("loadState", async () => {
      if (this.#integrationSessionClaim) {
        const state = await loadIntegrationClaimedSessionState(
          this.#integrationSessionClaim,
          () => loadStateFile(this.statePath)
        );
        return validateIntegrationLoadedState(this.#integrationSessionClaim, state);
      }
      const currentState = await loadStateFile(this.statePath);
      if (currentState !== null) return currentState;
      if (!this.legacySessionDir) return null;
      return loadStateFile(path.join(this.legacySessionDir, "state.json"));
    });
  }

  saveState(state) {
    return this.withIntegrationOperation("saveState", async () => {
      const durableState = prepareIntegrationStateForSave(this.#integrationSessionClaim, state);
      if (await saveIntegrationClaimedSessionState(this.#integrationSessionClaim, durableState)) {
        markIntegrationStatePersisted(this.#integrationSessionClaim, durableState);
        return;
      }
      await this.ensure();
      await atomicWriteFile(this.statePath, `${JSON.stringify(durableState, null, 2)}\n`);
      markIntegrationStatePersisted(this.#integrationSessionClaim, durableState);
      if (!this.#integrationSessionClaim) {
        await this.writePointer(durableState).catch(() => {});
        try {
          upsertSessionIndex({
            ...durableState,
            sessionId: this.sessionId,
            projectRoot: this.projectRoot,
            projectSessionsDir: this.projectSessionsDir,
            sessionDir: this.sessionDir,
            status: durableState.status || "saved",
          });
        } catch {
          // Session state remains durable even if the optional global index is unavailable.
        }
      }
      // A drained item is acknowledged only after the state containing it is durable.
      // If the process dies before this point, a new store instance will replay it.
      if (!retainedIntegrationSessionStateEnabled(this.#integrationSessionClaim)) {
        await this.acknowledgeDrainedInbox();
      }
    });
  }

  savePlan(planText) {
    return this.withIntegrationOperation("savePlan", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "savePlan", [planText]);
      }
      await this.ensure();
      await fs.writeFile(this.planPath, `${planText.trim()}\n`, "utf8");
    });
  }

  saveJsonArtifact(filename, data) {
    return this.withIntegrationOperation("saveJsonArtifact", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "saveJsonArtifact", [filename, data]);
      }
      await this.ensure();
      const safeName = path.basename(String(filename || "artifact.json"));
      const outputName = safeName.endsWith(".json") ? safeName : `${safeName}.json`;
      const filePath = path.join(this.artifactsDir, outputName);
      await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      return filePath;
    });
  }

  appendEvent(type, data = {}) {
    return this.withIntegrationOperation("appendEvent", async () => {
      const operation = this.eventAppendTail.then(async () => {
        if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
          await invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "appendEvent", [type, data]);
          return;
        }
        await this.ensure();
        const event = {
          timestamp: new Date().toISOString(),
          type,
          data,
        };
        const line = JSON.stringify(event);
        await fs.appendFile(this.eventsPath, `${line}\n`, "utf8");
        if (!this.#integrationSessionClaim) {
          enqueueHousekeepingEvent({
            sessionId: this.sessionId,
            projectRoot: this.projectRoot,
            commandCwd: this.commandCwd,
            event,
          });
        }
      });
      this.eventAppendTail = operation.catch(() => {});
      return operation;
    });
  }

  loadEvents() {
    return this.withIntegrationOperation("loadEvents", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "loadEvents");
      }
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
    });
  }

  removeStaleInboxLock() {
    return this.withIntegrationOperation("removeStaleInboxLock", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "removeStaleInboxLock");
      }
      let stat;
      let owner = null;
      try {
        stat = await fs.stat(this.inboxLockPath);
        owner = await fs.readFile(this.inboxLockPath, "utf8").then(JSON.parse).catch(() => null);
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        throw error;
      }

      const ageMs = Math.max(Date.now() - stat.mtimeMs, 0);
      const ownerDead = Number.isInteger(owner?.pid) && !isProcessAlive(owner.pid);
      if (!ownerDead && ageMs < INBOX_LOCK_HARD_STALE_MS) return false;

      const stalePath = `${this.inboxLockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
      try {
        await fs.rename(this.inboxLockPath, stalePath);
        await fs.unlink(stalePath).catch(() => {});
        await syncDirectory(this.sessionDir);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        throw error;
      }
    });
  }

  acquireInboxLock() {
    return this.withIntegrationOperation("acquireInboxLock", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "acquireInboxLock");
      }
      await fs.mkdir(this.sessionDir, { recursive: true });
      const token = crypto.randomUUID();
      const ownerPath = path.join(this.sessionDir, `.inbox-lock-owner.${process.pid}.${token}`);
      const owner = {
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      await atomicWriteFile(ownerPath, `${JSON.stringify(owner)}\n`);
      const deadline = Date.now() + this.inboxLockTimeoutMs;
      let acquired = false;

      try {
        while (!acquired) {
          try {
            await fs.link(ownerPath, this.inboxLockPath);
            await syncDirectory(this.sessionDir);
            acquired = true;
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            if (await this.removeStaleInboxLock()) continue;
            if (Date.now() >= deadline) {
              const timeoutError = new Error(`Timed out waiting for the session inbox mutation lock for ${this.sessionId}.`);
              timeoutError.code = "INBOX_LOCK_TIMEOUT";
              throw timeoutError;
            }
            await delay(INBOX_LOCK_RETRY_MS);
          }
        }
      } finally {
        await fs.unlink(ownerPath).catch(() => {});
      }

      return async () =>
        this.withIntegrationOperation("releaseInboxLock", async () => {
          const current = await fs.readFile(this.inboxLockPath, "utf8").then(JSON.parse).catch(() => null);
          if (current?.token !== token) return;
          await fs.unlink(this.inboxLockPath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
          await syncDirectory(this.sessionDir);
        });
    });
  }

  withInboxLock(operation) {
    return this.withIntegrationOperation("withInboxLock", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "withInboxLock", [operation]);
      }
      const release = await this.acquireInboxLock();
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  }

  readJsonLinesUnlocked(filePath) {
    return this.withIntegrationOperation("readJsonLinesUnlocked", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "readJsonLinesUnlocked", [filePath]);
      }
      try {
        const raw = await fs.readFile(filePath, "utf8");
        return decodeJsonLines(raw, { allowIncompleteFinal: true });
      } catch (error) {
        if (error?.code === "ENOENT") return decodeJsonLines("");
        throw error;
      }
    });
  }

  appendJsonRecordsUnlocked(filePath, records = []) {
    return this.withIntegrationOperation("appendJsonRecordsUnlocked", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "appendJsonRecordsUnlocked", [filePath, records]);
      }
      const nextRecords = records.filter(Boolean);
      if (nextRecords.length === 0) return;
      const decoded = await this.readJsonLinesUnlocked(filePath);
      if (decoded.incompleteFinal) {
        await atomicWriteFile(filePath, serializeJsonLines([...decoded.values, ...nextRecords]));
        return;
      }
      const separator = decoded.raw && !decoded.raw.endsWith("\n") ? "\n" : "";
      await appendDurably(filePath, `${separator}${serializeJsonLines(nextRecords)}`);
    });
  }

  readInboxDataUnlocked() {
    return this.withIntegrationOperation("readInboxDataUnlocked", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "readInboxDataUnlocked");
      }
      const [queue, claims, acknowledgements] = await Promise.all([
        this.readJsonLinesUnlocked(this.inboxPath),
        this.readJsonLinesUnlocked(this.inboxClaimsPath),
        this.readJsonLinesUnlocked(this.inboxAcknowledgementsPath),
      ]);
      const acknowledgedKeys = new Set(
        acknowledgements.values.map((entry) => String(entry?.key || "").trim()).filter(Boolean)
      );
      const activeItems = [];
      const activeKeys = new Set();
      for (const item of queue.values) {
        const key = inboxItemKey(item);
        if (acknowledgedKeys.has(key) || activeKeys.has(key)) continue;
        activeKeys.add(key);
        activeItems.push(item);
      }
      const allClaimRecords = new Map();
      for (const claim of claims.values) {
        const key = String(claim?.key || "").trim();
        if (!key || !activeKeys.has(key) || acknowledgedKeys.has(key)) continue;
        if (claim.released) {
          allClaimRecords.delete(key);
        } else {
          allClaimRecords.set(key, claim);
        }
      }
      const claimRecords = new Map([...allClaimRecords].filter(([, claim]) => isInboxClaimLive(claim)));
      return {
        queue,
        claims,
        acknowledgements,
        acknowledgedKeys,
        activeItems,
        activeKeys,
        allClaimRecords,
        claimRecords,
        claimedKeys: new Set(claimRecords.keys()),
        rawRecordCount: queue.values.length + claims.values.length + acknowledgements.values.length,
        rawByteCount:
          Buffer.byteLength(queue.raw, "utf8") +
          Buffer.byteLength(claims.raw, "utf8") +
          Buffer.byteLength(acknowledgements.raw, "utf8"),
      };
    });
  }

  visibleInboxItems(data) {
    if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
      const error = new Error("visibleInboxItems is outside the retained text-workspace-v1 SessionStore profile.");
      error.code = "INTEGRATION_TEXT_WORKSPACE_OPERATION_DENIED";
      throw error;
    }
    return data.activeItems.filter((item) => {
      const key = inboxItemKey(item);
      return !data.claimedKeys.has(key) && !this.drainedInboxKeys.has(key);
    });
  }

  rewriteActiveInboxUnlocked(items, claimRecords = new Map()) {
    return this.withIntegrationOperation("rewriteActiveInboxUnlocked", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "rewriteActiveInboxUnlocked", [items, claimRecords]);
      }
      const activeItems = [];
      const activeKeys = new Set();
      for (const item of items.filter(Boolean)) {
        const key = inboxItemKey(item);
        if (activeKeys.has(key)) continue;
        activeKeys.add(key);
        activeItems.push(item);
      }
      const activeClaims = [];
      for (const [key, claim] of claimRecords) {
        if (!activeKeys.has(key)) continue;
        activeClaims.push({
          key,
          consumerId: String(claim?.consumerId || "").slice(0, 128),
          pid: Number.isInteger(Number(claim?.pid)) ? Number(claim.pid) : 0,
          claimedAt: claim?.claimedAt || new Date().toISOString(),
        });
      }

      // This order is crash-safe: old acknowledgements cannot hide any item in
      // the already-filtered active queue, and readers hold the same lock.
      await atomicWriteFile(this.inboxPath, serializeJsonLines(activeItems));
      await atomicWriteFile(this.inboxClaimsPath, serializeJsonLines(activeClaims));
      await atomicWriteFile(this.inboxAcknowledgementsPath, "");
    });
  }

  shouldCompactInbox(data) {
    if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
      const error = new Error("shouldCompactInbox is outside the retained text-workspace-v1 SessionStore profile.");
      error.code = "INTEGRATION_TEXT_WORKSPACE_OPERATION_DENIED";
      throw error;
    }
    const hasObsoleteRecords =
      data.acknowledgements.values.length > 0 || data.claims.values.length > data.claimRecords.size;
    if (!hasObsoleteRecords) return false;
    return (
      data.rawRecordCount >= this.inboxCompactionRecordThreshold ||
      data.rawByteCount >= this.inboxCompactionByteThreshold
    );
  }

  compactInboxUnlocked(data = null) {
    return this.withIntegrationOperation("compactInboxUnlocked", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "compactInboxUnlocked", [data]);
      }
      const current = data || (await this.readInboxDataUnlocked());
      await this.rewriteActiveInboxUnlocked(current.activeItems, current.claimRecords);
    });
  }

  appendInbox(content, metadata = {}) {
    return this.withIntegrationOperation("appendInbox", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "appendInbox", [content, metadata]);
      }
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
      await this.withInboxLock(() => this.appendJsonRecordsUnlocked(this.inboxPath, [item]));
      return item;
    });
  }

  loadInboxAcknowledgements() {
    return this.withIntegrationOperation("loadInboxAcknowledgements", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "loadInboxAcknowledgements");
      }
      await this.ensure();
      return this.withInboxLock(async () => (await this.readInboxDataUnlocked()).acknowledgedKeys);
    });
  }

  loadInbox() {
    return this.withIntegrationOperation("loadInbox", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "loadInbox");
      }
      await this.ensure();
      const items = await this.withInboxLock(async () => {
        const data = await this.readInboxDataUnlocked();
        return this.visibleInboxItems(data);
      });
      this.lastLoadedInboxKeys = new Set(items.map(inboxItemKey));
      return items;
    });
  }

  saveInbox(items = []) {
    return this.withIntegrationOperation("saveInbox", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "saveInbox", [items]);
      }
      await this.ensure();
      const desiredItems = items.filter(Boolean);
      return this.withInboxLock(async () => {
        const data = await this.readInboxDataUnlocked();
        const baseline = this.lastLoadedInboxKeys;
        const desiredUnclaimed = desiredItems.filter((item) => {
          const key = inboxItemKey(item);
          return data.activeKeys.has(key) && !data.claimedKeys.has(key);
        });
        const desiredKeys = new Set(desiredUnclaimed.map(inboxItemKey));
        const lateItems = this.visibleInboxItems(data).filter((item) => {
          const key = inboxItemKey(item);
          return !desiredKeys.has(key) && (!baseline || !baseline.has(key));
        });
        const claimedItems = data.activeItems.filter((item) => data.claimedKeys.has(inboxItemKey(item)));
        const nextVisible = [...desiredUnclaimed, ...lateItems];
        await this.rewriteActiveInboxUnlocked([...nextVisible, ...claimedItems], data.claimRecords);
        this.lastLoadedInboxKeys = new Set(nextVisible.map(inboxItemKey));
        return nextVisible;
      });
    });
  }

  mutateInbox(mutator) {
    return this.withIntegrationOperation("mutateInbox", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "mutateInbox", [mutator]);
      }
      await this.ensure();
      if (typeof mutator !== "function") throw new TypeError("Inbox mutation requires a callback.");
      return this.withInboxLock(async () => {
        const data = await this.readInboxDataUnlocked();
        const visibleItems = this.visibleInboxItems(data).map((item) => ({ ...item }));
        const mutation = await mutator(visibleItems);
        const nextVisible = Array.isArray(mutation) ? mutation : mutation?.items;
        if (!Array.isArray(nextVisible)) throw new TypeError("Inbox mutation must return an items array.");
        const claimedItems = data.activeItems.filter((item) => data.claimedKeys.has(inboxItemKey(item)));
        await this.rewriteActiveInboxUnlocked([...nextVisible, ...claimedItems], data.claimRecords);
        this.lastLoadedInboxKeys = new Set(nextVisible.map(inboxItemKey));
        return {
          items: nextVisible,
          value: Array.isArray(mutation) ? undefined : mutation?.value,
        };
      });
    });
  }

  drainInbox() {
    return this.withIntegrationOperation("drainInbox", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "drainInbox");
      }
      await this.ensure();
      const items = await this.withInboxLock(async () => {
        const data = await this.readInboxDataUnlocked();
        const drainable = data.activeItems.filter((item) => {
          const key = inboxItemKey(item);
          if (this.drainedInboxKeys.has(key)) return false;
          const claim = data.allClaimRecords.get(key);
          if (!claim) return true;
          if (claim.consumerId === this.inboxConsumerId) return true;
          return !isInboxClaimLive(claim);
        });
        const claimedAt = new Date().toISOString();
        const newClaims = drainable
          .map(inboxItemKey)
          .filter((key) => {
            const claim = data.allClaimRecords.get(key);
            return !claim || claim.consumerId !== this.inboxConsumerId || !isInboxClaimLive(claim);
          })
          .map((key) => ({
            key,
            consumerId: this.inboxConsumerId,
            pid: process.pid,
            claimedAt,
          }));
        await this.appendJsonRecordsUnlocked(this.inboxClaimsPath, newClaims);
        for (const item of drainable) this.drainedInboxKeys.add(inboxItemKey(item));
        return drainable;
      });
      return items.sort((a, b) => {
        const priority = (item) => (item.priority === "asap" ? 0 : 1);
        return priority(a) - priority(b) || String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
      });
    });
  }

  markInboxApplied(itemOrId) {
    this.assertIntegrationOperation("markInboxApplied");
    if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) return false;
    const key =
      typeof itemOrId === "string"
        ? `id:${String(itemOrId).trim()}`
        : inboxItemKey(itemOrId);
    if (!this.drainedInboxKeys.has(key)) return false;
    this.appliedInboxAcknowledgements.add(key);
    return true;
  }

  acknowledgeDrainedInbox() {
    return this.withIntegrationOperation("acknowledgeDrainedInbox", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        await invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "acknowledgeDrainedInbox");
        return;
      }
      const drainedAtSave = new Set(this.drainedInboxKeys);
      const keys = [...this.appliedInboxAcknowledgements].filter((key) => drainedAtSave.has(key));
      if (drainedAtSave.size > 0) {
        const now = new Date().toISOString();
        await this.withInboxLock(async () => {
          const before = await this.readInboxDataUnlocked();
          const ownedKeys = [...drainedAtSave].filter(
            (key) => before.allClaimRecords.get(key)?.consumerId === this.inboxConsumerId
          );
          const ownedKeySet = new Set(ownedKeys);
          const appliedKeys = keys.filter((key) => ownedKeySet.has(key));
          const unappliedKeys = ownedKeys.filter((key) => !this.appliedInboxAcknowledgements.has(key));
          await this.appendJsonRecordsUnlocked(
            this.inboxAcknowledgementsPath,
            appliedKeys.map((key) => ({ key, acknowledgedAt: now }))
          );
          await this.appendJsonRecordsUnlocked(
            this.inboxClaimsPath,
            unappliedKeys.map((key) => ({
              key,
              consumerId: this.inboxConsumerId,
              pid: process.pid,
              released: true,
              releasedAt: now,
            }))
          );
          const data = await this.readInboxDataUnlocked();
          if (this.shouldCompactInbox(data)) await this.compactInboxUnlocked(data);
        });
        for (const key of keys) this.appliedInboxAcknowledgements.delete(key);
      }
      // Any claimed-but-unapplied item remains durable and becomes eligible for a
      // retry in this process after the state boundary, as well as after a crash.
      for (const key of drainedAtSave) this.drainedInboxKeys.delete(key);
    });
  }

  releaseInboxClaims() {
    return this.withIntegrationOperation("releaseInboxClaims", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        await invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "releaseInboxClaims");
        return;
      }
      const keys = [...this.drainedInboxKeys];
      if (keys.length === 0) return;
      const releasedAt = new Date().toISOString();
      await this.withInboxLock(async () => {
        const data = await this.readInboxDataUnlocked();
        const ownedKeys = keys.filter(
          (key) => data.allClaimRecords.get(key)?.consumerId === this.inboxConsumerId
        );
        await this.appendJsonRecordsUnlocked(
          this.inboxClaimsPath,
          ownedKeys.map((key) => ({
            key,
            consumerId: this.inboxConsumerId,
            pid: process.pid,
            released: true,
            releasedAt,
          }))
        );
        const after = await this.readInboxDataUnlocked();
        if (this.shouldCompactInbox(after)) await this.compactInboxUnlocked(after);
      });
      for (const key of keys) {
        this.drainedInboxKeys.delete(key);
        this.appliedInboxAcknowledgements.delete(key);
      }
    });
  }

  saveSnapshot(step, snapshot) {
    return this.withIntegrationOperation("saveSnapshot", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "saveSnapshot", [step, snapshot]);
      }
      await this.ensure();
      const filename = `step-${String(step).padStart(3, "0")}.snapshot.json`;
      const filePath = path.join(this.artifactsDir, filename);
      await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      return filePath;
    });
  }

  screenshotPath(step) {
    if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
      const error = new Error("screenshotPath is outside the retained text-workspace-v1 SessionStore profile.");
      error.code = "INTEGRATION_TEXT_WORKSPACE_OPERATION_DENIED";
      throw error;
    }
    return path.join(this.artifactsDir, `step-${String(step).padStart(3, "0")}.png`);
  }

  remove() {
    return this.withIntegrationOperation("remove", async () => {
      if (retainedIntegrationTextWorkspaceEnabled(this.#integrationSessionClaim)) {
        return invokeIntegrationTextWorkspace(this.#integrationSessionClaim, "remove");
      }
      await this.eventAppendTail.catch(() => {});
      await fs.rm(this.sessionDir, { recursive: true, force: true });
      if (!this.#integrationSessionClaim) {
        if (this.pointerDir) await fs.rm(this.pointerDir, { recursive: true, force: true }).catch(() => {});
        deleteSessionIndex(this.sessionId);
      }
      this.ensurePromise = null;
      this.eventAppendTail = Promise.resolve();
    });
  }

}
